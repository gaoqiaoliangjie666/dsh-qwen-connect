/**
 * 健壮的 SSE 帧解析器与 OpenAI 兼容分块编码器。
 *
 * ── 上游协议（阶段 A-1 实测）────────────────────────────────────────
 * QwenWork 的 `agent_chat_generation` 返回 `text/event-stream`，每个 `data:`
 * 帧是一个**外层信封**，真正的模型分块在 `body` 字符串里：
 *
 *   data:{"headers":{...},"body":"{\"choices\":[{\"delta\":{...}}]}",
 *        "statusCodeValue":200,"statusCode":"OK"}
 *
 * 因此要解两层 JSON。下游是 pi-ai 的 `openAICompletionsApi`，需要标准
 * OpenAI `chat.completion.chunk` 分块。
 *
 * ── 本模块的设计目标：不崩溃、不挂起 ──────────────────────────────────
 * 真实流里会出现：TCP 分片把一个帧切成两半、空行、注释行（`:`）、
 * `[DONE]` 哨兵、心跳、非法 JSON、上游中途断开。解析器必须对每一种都
 * 有确定的、可测试的行为，而不是抛异常炸掉整条流。
 *
 * @module dsh-qwen-connect/sse
 */

/** SSE 事件之间允许的最大缓冲；超过即视为上游异常，避免无限增长。 */
export const MAX_SSE_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * 增量式 SSE 解析器：喂入任意切分的字节/字符串，产出完整事件的 `data` 负载。
 *
 * 用法：
 * ```js
 * const p = new SseParser();
 * for (const payload of p.push(chunk)) { ... }
 * for (const payload of p.flush()) { ... }   // 流结束时
 * ```
 */
export class SseParser {
  constructor() {
    /** @type {string} */
    this.buffer = '';
    /** 是否已看到 `[DONE]` 哨兵。 */
    this.done = false;
    /** 被丢弃的畸形帧计数（限流后供诊断）。 */
    this.droppedFrames = 0;
    /**
     * 持久的 UTF-8 解码器。
     *
     * ⚠️ 必须是**有状态、跨 push 复用**的实例：一个多字节字符（如中文）
     * 可能被 TCP 切在两个分片中间，若每次 push 都新建解码器，前半段会被
     * 解成替换字符 `�`，输出就永久损坏了。`{ stream: true }` 会让解码器
     * 把不完整序列暂存到下一次。
     */
    this.decoder = new TextDecoder('utf-8');
  }

  /**
   * 喂入一段数据，返回其中**完整的** `data:` 负载数组。
   *
   * @param {string | Uint8Array} chunk
   * @returns {string[]}
   */
  push(chunk) {
    if (this.done) return [];
    if (chunk !== undefined && chunk !== null && chunk !== '') {
      this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    }
    return this.#drain(false);
  }

  /**
   * 流结束时调用：把缓冲区里最后一个**没有换行结尾**的帧也吐出来，
   * 并冲掉解码器里可能残留的不完整字符。
   *
   * @returns {string[]}
   */
  flush() {
    const out = this.#drain(true);
    try {
      // 冲掉解码器内部的暂存字节（若确实是不完整序列，会得到替换字符，
      // 但不会影响已经完整解码的内容）
      const tail = this.decoder.decode();
      if (tail !== '') this.buffer += tail;
    } catch {
      /* 解码器已冲过，忽略 */
    }
    if (this.buffer !== '') {
      const payload = extractData(this.buffer);
      this.buffer = '';
      if (payload !== null && payload !== '' && payload !== '[DONE]') out.push(payload);
    }
    return out;
  }

  /**
   * @param {boolean} atEnd
   * @returns {string[]}
   */
  #drain(atEnd) {
    /** @type {string[]} */
    const out = [];

    // 缓冲区无界增长保护：宁可丢弃并报告，也不让内存被拖垮
    if (this.buffer.length > MAX_SSE_BUFFER_BYTES) {
      this.droppedFrames += 1;
      this.buffer = '';
      return out;
    }

    while (true) {
      const nl = this.buffer.indexOf('\n');
      if (nl === -1) break;

      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);

      const payload = extractData(line);
      if (payload !== null) {
        if (payload === '[DONE]') {
          this.done = true;
          return out;
        }
        if (payload === '') {
          this.droppedFrames += 1; // 空 data 帧：跳过，不当作错误
          continue;
        }
        out.push(payload);
      }
    }

    if (atEnd && this.buffer !== '') {
      const payload = extractData(this.buffer);
      this.buffer = '';
      if (payload !== null && payload !== '' && payload !== '[DONE]') out.push(payload);
    }

    return out;
  }
}

/**
 * 从一行 SSSE 文本里取出 `data:` 负载。
 * 非 data 行（空行、`event:`、`id:`、`retry:`、`:` 注释、`[DONE]` 前缀等）
 * 一律返回 null。`[DONE]` 会被原样返回以便调用方识别。
 *
 * @param {string} line
 * @returns {string | null}
 */
export function extractData(line) {
  if (line === '' || line.startsWith(':')) return null;
  if (!line.startsWith('data:')) return null;
  // 规范允许 "data:xxx" 与 "data: xxx"，只吃掉一个前导空格
  let payload = line.slice(5);
  if (payload.startsWith(' ')) payload = payload.slice(1);
  return payload.trim();
}

/** 用 TextDecoder 解 UTF-8；失败时不抛，返回替代字符。 */
function decodeUtf8(bytes) {
  try {
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

/**
 * 解析一帧 QwenWork 信封，提取出模型分块。
 *
 * 返回结构恒定（永不抛异常），调用方据 `kind` 分支：
 *   - `'chunk'`  正常模型分块（含 `delta`）
 *   - `'error'`  上游报告的错误（HTTP 层或信封层）
 *   - `'skip'`   可安全忽略的帧（空帧、非 JSON、无 choices）
 *
 * @param {string} payload
 * @returns {{ kind: 'chunk'|'error'|'skip', delta?: {content?: string, reasoning?: string},
 *             finishReason?: string|null, modelName?: string|null, error?: {status?: number, message: string} }}
 */
export function parseQwenWorkFrame(payload) {
  if (typeof payload !== 'string') return { kind: 'skip' };
  // 容错：调用方可能直接传入整行 SSE（含 `data:` 前缀）而非裸负载。
  // 明确接受两种形态，避免这个边界成为隐蔽的踩坑点。
  const text = payload.startsWith('data:') ? payload.slice(5).trim() : payload.trim();
  if (text === '' || text === '[DONE]') return { kind: 'skip' };

  let outer;
  try {
    outer = JSON.parse(text);
  } catch {
    return { kind: 'skip' };
  }
  if (outer === null || typeof outer !== 'object') return { kind: 'skip' };

  // 上游错误：信封级 statusCodeValue / statusCode
  const statusValue = typeof outer.statusCodeValue === 'number' ? outer.statusCodeValue : null;
  if (statusValue !== null && statusValue >= 400) {
    return {
      kind: 'error',
      error: { status: statusValue, message: extractUpstreamMessage(outer) },
    };
  }

  const modelName = pickModelName(outer);

  // body 可能是字符串（常态）或已是对象（少数路径）
  let inner = outer.body;
  if (typeof inner === 'string') {
    try {
      inner = JSON.parse(inner);
    } catch {
      return { kind: 'skip' };
    }
  }
  if (inner === null || typeof inner !== 'object') return { kind: 'skip' };

  if (typeof inner.code === 'string' && inner.message !== undefined) {
    return {
      kind: 'error',
      error: {
        status: Number(inner.code) || undefined,
        message: String(inner.message),
      },
    };
  }

  const choice = Array.isArray(inner.choices) ? inner.choices[0] : undefined;
  if (choice === undefined || choice === null) return { kind: 'skip' };

  const rawDelta = choice.delta ?? {};
  const delta = {};
  if (typeof rawDelta.content === 'string' && rawDelta.content !== '') delta.content = rawDelta.content;
  if (typeof rawDelta.reasoning_content === 'string' && rawDelta.reasoning_content !== '') {
    delta.reasoning = rawDelta.reasoning_content;
  }
  // 工具调用分片：上游以 OpenAI 标准形态逐片给出，原样透传（含 index/id/type/function）。
  if (Array.isArray(rawDelta.tool_calls) && rawDelta.tool_calls.length > 0) {
    delta.tool_calls = rawDelta.tool_calls;
  }

  return {
    kind: 'chunk',
    delta,
    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
    modelName,
    // 上游在末帧的 `raw_usage` 里给出真实 token 计数（见 parseRawUsage）。
    ...(inner.raw_usage === undefined ? {} : { rawUsage: inner.raw_usage }),
  };
}

/**
 * 把上游的 `raw_usage` 归一化成 OpenAI 的 `usage` 对象。
 *
 * 上游结构（实测）：
 * ```json
 * { "data": { "prompt_tokens": 17, "completion_tokens": 39, "total_tokens": 56,
 *             "prompt_tokens_details": { "cached_tokens": 0 } } }
 * ```
 *
 * **为什么必须转发**：DSH 依据 OpenAI `usage` 显示 token 统计；
 * 不返回 usage，界面上就没有任何 token 数字。
 *
 * @param {unknown} rawUsage
 * @returns {{prompt_tokens: number, completion_tokens: number, total_tokens: number,
 *            prompt_tokens_details?: {cached_tokens: number}} | null}
 */
export function parseRawUsage(rawUsage) {
  if (rawUsage === null || typeof rawUsage !== 'object') return null;
  const data = /** @type {any} */ (rawUsage).data ?? rawUsage;
  const prompt = toCount(data?.prompt_tokens);
  const completion = toCount(data?.completion_tokens);
  const total = toCount(data?.total_tokens);
  // 三项全缺 → 上游没给可用数据，不编造
  if (prompt === null && completion === null && total === null) return null;

  const cached = toCount(data?.prompt_tokens_details?.cached_tokens);
  /** @type {any} */
  const usage = {
    prompt_tokens: prompt ?? 0,
    completion_tokens: completion ?? 0,
    total_tokens: total ?? (prompt ?? 0) + (completion ?? 0),
  };
  if (cached !== null && cached > 0) {
    usage.prompt_tokens_details = { cached_tokens: cached };
  }
  return usage;
}

/** 取非负整数；缺失或非法返回 null（**不返回 0** —— 0 与「缺失」语义不同）。 */
function toCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

/** 从信封里尽力取出上游模型名（用于诊断，非必需）。 */
function pickModelName(outer) {
  const headers = outer.headers;
  if (headers !== null && typeof headers === 'object') {
    const name = headers['X-Model-Name'];
    if (Array.isArray(name) && typeof name[0] === 'string') return name[0];
    if (typeof name === 'string') return name;
  }
  return null;
}

/** 从一个错误信封里取出人类可读消息。 */
function extractUpstreamMessage(outer) {
  if (typeof outer.body === 'string') {
    try {
      const inner = JSON.parse(outer.body);
      if (inner !== null && typeof inner === 'object' && inner.message !== undefined) {
        return String(inner.message);
      }
    } catch {
      return outer.body.slice(0, 300);
    }
  }
  if (outer.statusCode !== undefined) return String(outer.statusCode);
  return 'unknown upstream error';
}

/**
 * 把解析出的增量编码成 OpenAI `chat.completion.chunk` 的 SSE 帧。
 *
 * @param {object} params
 * @param {string} params.model         模型 id（对外展示用，如 'pro'）
 * @param {string} params.id            分块 id
 * @param {number} params.created       创建时间（秒）
 * @param {{content?: string, reasoning?: string, tool_calls?: Array}} [params.delta]
 * @param {string|null} [params.finishReason]
 * @param {object|null} [params.usage]  OpenAI 形态的 token 统计；有则一并下发
 * @returns {string} 可直接写进响应体的 SSE 文本
 */
export function encodeOpenAiChunk(params) {
  const delta = {};
  if (params.delta?.content !== undefined) delta.content = params.delta.content;
  if (params.delta?.reasoning !== undefined) delta.reasoning_content = params.delta.reasoning;
  if (Array.isArray(params.delta?.tool_calls) && params.delta.tool_calls.length > 0) {
    delta.tool_calls = params.delta.tool_calls;
  }
  if (Object.keys(delta).length === 0 && params.finishReason === undefined) delta.role = 'assistant';

  const chunk = {
    id: params.id,
    object: 'chat.completion.chunk',
    created: params.created,
    model: params.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: params.finishReason ?? null,
      },
    ],
    // DSH 依据 usage 显示 token 统计；只在真实拿到时下发，绝不编造。
    ...(params.usage == null ? {} : { usage: params.usage }),
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/** SSE 结束哨兵。 */
export const SSE_DONE = 'data: [DONE]\n\n';
