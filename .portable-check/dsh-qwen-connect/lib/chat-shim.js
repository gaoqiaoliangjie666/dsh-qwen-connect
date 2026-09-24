/**
 * 环回聊天 shim：本插件唯一的「聊天数据面」。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 * pi-ai 的 `openAICompletionsApi` 只会说标准 OpenAI 协议
 * （`POST {baseUrl}/chat/completions`、`Authorization: Bearer <apiKey>`）。
 * 而 QwenWork 上游要的是：WASM 签名的 `Authorization: Bearer COSY.<...>`、
 * 被加密的 body、以及它自己那套双层信封 SSE。
 *
 * shim 夹在两者之间，把差异全部吸收掉：
 *
 *     pi-ai ──OpenAI 请求──▶ shim ──签名+加密──▶ gateway.qwenwork.cn
 *          ◀──OpenAI SSE──      ◀──双层信封 SSE──
 *
 * ── 安全边界（不可退让）─────────────────────────────────────────────
 *  1. **只接受环回请求**（Host/Origin 校验，见 ./loopback.js），挡 DNS-rebinding。
 *  2. **绝不下发凭据**：响应体里只有模型输出；上游签名头不回传。
 *  3. 监听地址固定 `127.0.0.1`，端口由系统分配（不对外暴露）。
 *  4. 日志不含 token / key；上游错误经脱敏后才回传。
 *
 * @module dsh-qwen-connect/chat-shim
 */

import http from 'node:http';
import crypto from 'node:crypto';

import { loopbackRequest } from './loopback.js';
import { safeMessage } from './web-status.js';
import {
  SseParser,
  parseQwenWorkFrame,
  parseRawUsage,
  encodeOpenAiChunk,
  SSE_DONE,
} from './sse.js';
import { buildInferBody, createSignerSession } from './signer-session.js';
import { FALLBACK_QWENWORK_MODELS } from './models.js';
import { recordSample } from './perf.js';
import { trace } from './trace.js';

/** shim 对外暴露的 OpenAI 兼容路径。 */
export const CHAT_COMPLETIONS_PATH = '/v1/chat/completions';

/** 默认的上游流空闲上限（毫秒）。 */
export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

/**
 * 「已拿到 200 但一直无正文」的放弃上限（毫秒）。
 *
 * trace 实测发现的真实故障模式（见 analyze-slow-detail 的输出）：
 *   upstream-headers 200 到得很快（2-10s），**之后**上游长时间静默——
 *   不发 reasoning、不发 content，连接挂着直到 DSH 侧放弃。
 *   典型样本：4112ms 拿到 200 → 177 秒零字节 → 结束（chars=0）。
 *
 * 这是上游「接了单但还没排到」的排队态。此时正确的做法是**尽早放弃**、
 * 让 DSH 的重试层换一个时间片再来——DSH 的指数退避（0.5/1/2/4/8s）
 * 正适合这种场景。挂在原地等 300 秒只是把失败拉长。
 *
 * 90 秒的依据：正常长思考的**首帧**（reasoning）实测都在 10 秒内到达
 * （见 probe-long-think-gap）；排队最坏也就几十秒。90 秒足够宽容，
 * 又能在「排不上的队列」里及时止损。
 */
export const FIRST_CONTENT_TIMEOUT_MS = 90_000;

/**
 * 可重试的上游状态码。
 *
 * 借鉴 Buddy2api `providers/qwenwork/constants.py` 的 `RETRYABLE_STATUS`：
 * 只重试「限流 / 网关瞬时故障」，不重试语义错误（400/401/403 重试也不会变好）。
 */
export const RETRYABLE_STATUS = Object.freeze([408, 409, 425, 429, 500, 502, 503, 504]);

/** 上游请求的最大尝试次数（含首次）。 */
export const UPSTREAM_MAX_ATTEMPTS = 3;

/** 重试的基础退避毫秒数（第 n 次重试等待 n × 该值）。 */
export const UPSTREAM_RETRY_BASE_DELAY_MS = 400;

/** 判断某状态码是否值得重试。 */
export function isRetryableStatus(status) {
  return RETRYABLE_STATUS.includes(status);
}

/**
 * 上游「响应头」到达的等待上限（毫秒）。
 *
 * 为什么需要它：`fetch()` 会等到**响应头**到达才 resolve。若上游接受了连接
 * 却一直不响应，这个 await 永不返回——此时流内看门狗（`armIdle`）根本还没
 * 启动，客户端就会**无限等待**（界面一直转圈，不是报错，最难排查）。
 *
 * 为什么是 180 秒（曾为 60 秒，引发「长思考必超时」）：
 *   长思考请求（数学证明 / 逻辑题）在**响应头阶段**就要排队等上游调度，
 *   实测平峰 2–5 秒、高峰可远超 60 秒。60 秒的阈值会在高峰期把这些
 *   「慢但能成」的请求掐死在 502，随后 DSH 以 0.5/1/2/4/8s 的退避重试
 *   5 次，每次都可能再次撞上同一堵墙——用户看到的就是「长思考必超时」，
 *   而短请求（响应头快）完全正常。放宽到 180 秒后，高峰期的长思考
 *   请求能等到真正的响应头；真正的上游宕机仍会在 3 分钟内明确失败。
 *
 * 该值只覆盖「拿到响应头之前」，不限制后续流式读取（那由 `getIdleTimeoutMs`
 * 的流内看门狗负责）。
 */
export const UPSTREAM_HEADER_TIMEOUT_MS = 180_000;

/**
 * 向签名后的上游端点发起请求，对可重试状态码做有限次重试。
 *
 * ⚠️ 调用方必须保证这发生在「向客户端写任何 SSE 之前」——一旦响应开始，
 * 重试会造成串流。本函数只负责拿到一个可用的 Response。
 *
 * @param {{ signInferRequest: Function }} session 签名会话
 * @param {string} bodyJson 已构造好的请求体
 * @param {string} modelKey 模型键
 * @param {{ warn?: Function }} log 日志器
 * @param {{ headerTimeoutMs?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<Response>}
 */
async function fetchUpstreamWithRetry(session, bodyJson, modelKey, log, opts = {}) {
  const headerTimeoutMs = opts.headerTimeoutMs ?? UPSTREAM_HEADER_TIMEOUT_MS;
  let lastError = null;
  for (let attempt = 1; attempt <= UPSTREAM_MAX_ATTEMPTS; attempt++) {
    // 每次尝试都重新签名：签名内含时间戳，重试时必须刷新，否则会被判过期。
    const signed = session.signInferRequest(bodyJson, { modelKey, modelSource: 'system' });
    let response;
    try {
      // 响应头超时：上游不响应时明确失败，而不是让客户端无限等待。
      const timeoutSignal = AbortSignal.timeout(headerTimeoutMs);
      const signal =
        opts.signal === undefined ? timeoutSignal : AbortSignal.any([opts.signal, timeoutSignal]);
      response = await fetch(signed.url, {
        method: 'POST',
        headers: signed.headers,
        body: signed.body,
        signal,
      });
    } catch (error) {
      lastError = error;
      // ⚠️ **超时类失败不得重试**（这是「长思考必超时」的另一半根因）：
      //
      // header 超时 = 180s。若重试，最坏 3×180s ≈ 9 分钟都耗在这一个请求上；
      // 且超时几乎总是「上游高峰排队」，等 0.4s 再打大概率还是超时——重试
      // 只是把同样的等待重复三遍。更糟的是 DSH 的重试层看到我们最终失败
      // 还会再来 5 轮（0.5/1/2/4/8s 退避），叠加成用户视角的"永远转圈"。
      //
      // 正确姿势：超时立即抛给上层，让 DSH 的重试层（带指数退避）统一处理；
      // 我们只对**明确可恢复**的状态码（429/503 等）做本层重试。
      const isTimeout = /timeout|aborted/i.test(safeMessage(error));
      if (attempt < UPSTREAM_MAX_ATTEMPTS && !isTimeout) {
        log.warn?.(
          `dsh-qwen-connect: upstream network error (attempt ${attempt}/${UPSTREAM_MAX_ATTEMPTS})`,
          safeMessage(error),
        );
        await delay(UPSTREAM_RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
      throw error;
    }

    if (response.ok || !isRetryableStatus(response.status)) return response;

    // 可重试状态：读掉 body 释放连接，再退避重试。
    if (attempt < UPSTREAM_MAX_ATTEMPTS) {
      await response.text().catch(() => '');
      log.warn?.(
        `dsh-qwen-connect: upstream ${response.status} (attempt ${attempt}/${UPSTREAM_MAX_ATTEMPTS}), retrying`,
      );
      await delay(UPSTREAM_RETRY_BASE_DELAY_MS * attempt);
      continue;
    }
    return response; // 最后一次仍失败：交给调用方按原状态码处理
  }
  if (lastError !== null) throw lastError;
  /* c8 ignore next */
  throw new Error('upstream retry loop exited unexpectedly');
}

/** 等待若干毫秒。 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 生成每次启动唯一、进程内有效的共享密钥。
 *
 * 用途：进程级请求鉴别。环回校验挡住的是网络层（外部主机、DNS-rebinding），
 * 而共享密钥挡住的是**本机其他进程**——它们能构造环回请求，但拿不到这个
 * 只在进程内传递的密钥。两者叠加才是完整边界。
 *
 * 密钥不落盘、不进日志、不下发浏览器；每次启动重新生成（不持久化更安全）。
 */
export function generateSharedSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * 常量时间比较共享密钥。
 *
 * `crypto.timingSafeEqual` 要求两侧长度严格相等，否则抛
 * `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`。header 侧密钥长度未知，故两侧先取
 * SHA-256（固定 32 字节）再比较——既规避长度陷阱，又保留常量时间语义。
 *
 * @param {string} received 请求头里收到的候选密钥
 * @param {string} expected 本进程生成的共享密钥
 */
export function secretMatches(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string') return false;
  const a = crypto.createHash('sha256').update(received, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * 从请求头解析 Bearer 凭据。
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {string | undefined}
 */
function extractBearer(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : undefined;
}

/**
 * 从 OpenAI 请求体里取出 QwenWork 需要的 messages。
 *
 * `content` 会被塌缩成纯文本（OpenAI 的多模态 content 数组只取 `type === 'text'`
 * 部分——**视觉输入本期不支持**，见 README 的未支持列表）。
 *
 * **工具调用历史必须保留**：`assistant.tool_calls` 与 `role: "tool"` 的返回结果
 * 是模型进行多轮工具调用的上下文。若在这里丢弃，模型会失去工具调用历史，
 * 只能凭用户消息重新编造一轮调用。
 *
 * @param {any} body
 * @returns {Array<object>}
 */
export function toQwenWorkMessages(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  /** @type {Array<object>} */
  const out = [];
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue;
    const role = typeof message.role === 'string' ? message.role : 'user';
    const content = flattenContent(message.content);

    // role: "tool" —— 工具执行结果。content 可以为空串，但仍要带 tool_call_id。
    if (role === 'tool') {
      const entry = { role, content };
      if (typeof message.tool_call_id === 'string') entry.tool_call_id = message.tool_call_id;
      if (typeof message.name === 'string') entry.name = message.name;
      out.push(entry);
      continue;
    }

    // assistant 带 tool_calls —— 工具调用请求。可能同时没有文本 content。
    if (role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const entry = { role, content };
      entry.tool_calls = message.tool_calls;
      out.push(entry);
      continue;
    }

    // 含图片的消息：**必须保留数组 content**（不能塌缩成纯文本）。
    //
    // 实测结论（见 research/probes-2026-09-14/probe-image-format.mjs 的变体对照）：
    // 上游要同时具备两个条件才会「看到」图片——
    //   ① chat_context.imageUrls 非空（标注本轮有图）
    //   ② messages[].content 是含 image_url 的**数组**
    // 任一缺失，模型都会回复「我没有看到您上传的图片」。
    const multimodal = toMultimodalContent(message.content);
    if (multimodal !== null) {
      out.push({ role, content: multimodal });
      continue;
    }

    if (content === '') continue;
    out.push({ role, content });
  }
  return out;
}

/**
 * 把含图片的 content 转成上游接受的多模态数组；无图时返回 `null`。
 *
 * 输出形态为 OpenAI 标准：`[{type:'text',text}, {type:'image_url',image_url:{url}}]`
 * （变体对照中只有这种 + imageUrls 组合能让上游识别）。
 *
 * @param {unknown} content
 * @returns {Array<object> | null}
 */
function toMultimodalContent(content) {
  if (!Array.isArray(content)) return null;
  const parts = [];
  let hasImage = false;
  for (const part of content) {
    if (part === null || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string' && part.text !== '') {
      parts.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type === 'image' || part.type === 'image_url') {
      const url = extractImageUrl(part);
      if (url === null) continue;
      hasImage = true;
      parts.push({ type: 'image_url', image_url: { url } });
    }
  }
  return hasImage ? parts : null;
}

/**
 * 把 OpenAI 的 content 归一化成纯文本。
 *
 * 文本部分照常拼接；**图片块在其位置留下占位说明**（图片数据本身由
 * `collectImageUrls` 单独提取后经 `chat_context.imageUrls` 送上游）。
 *
 * 为什么留占位而不是直接丢弃：模型需要知道「这轮有图」，否则面对
 * "这张图里有什么？"会凭空编造答案。
 *
 * @param {unknown} content
 * @returns {string}
 */
function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
      continue;
    }
    if (part === null || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push(part.text);
      continue;
    }
    if (part.type === 'image' && extractImageUrl(part) !== null) {
      parts.push('[图片]');
      continue;
    }
    if (part.type === 'image' || part.type === 'image_url') {
      parts.push('[图片：格式无法识别，已忽略]');
    }
  }
  return parts.join('');
}

/**
 * 从图片块里取出可送上游的 URL / data URL。
 *
 * 支持两种形态：
 *   ① DSH 内部形态：`{ type: 'image', data: '<base64>', mimeType: 'image/png' }`
 *      （见 dsh-llm-pi-ai 的 `userContent()`——它把持久化附件解成 base64）
 *   ② OpenAI 标准形态：`{ type: 'image_url', image_url: { url } }`
 *
 * @param {any} part
 * @returns {string | null}
 */
function extractImageUrl(part) {
  // ② OpenAI 标准
  if (part.type === 'image_url') {
    const url = part.image_url?.url ?? part.image_url;
    if (typeof url === 'string' && url !== '') return url;
    return null;
  }
  // ① DSH 内部：base64 + mimeType → data URL
  if (typeof part.data === 'string' && part.data !== '') {
    const mime = typeof part.mimeType === 'string' && part.mimeType !== '' ? part.mimeType : 'image/png';
    return `data:${mime};base64,${part.data}`;
  }
  // 有的实现直接给 url 字段
  if (typeof part.url === 'string' && part.url !== '') return part.url;
  return null;
}

/**
 * 收集整个请求里所有图片，转成上游要的 URL 列表。
 *
 * ⚠️ 只取**最后一条 user 消息**里的图片：上游的
 * `chat_context.imageUrls` 描述的是「当前这轮要处理的图」，
 * 把历史图片一并塞进去会让模型重复分析旧图。
 *
 * @param {{ messages?: Array<any> }} body
 * @returns {string[]}
 */
export function collectImageUrls(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user' || !Array.isArray(m.content)) continue;
    const urls = [];
    for (const part of m.content) {
      if (part === null || typeof part !== 'object') continue;
      if (part.type !== 'image' && part.type !== 'image_url') continue;
      const url = extractImageUrl(part);
      if (url !== null) urls.push(url);
    }
    return urls;
  }
  return [];
}

/**
 * 提取一个稳定、可复用多轮的 session id。
 *
 * 多轮对话的关键：同一会话的多次请求必须带**同一个** `session_id`，
 * 否则上游无法关联上文。优先级：
 *   1. 调用方显式传入
 *   2. OpenAI 请求体的 `user` 字段（DSH 会带上会话标识）
 *   3. 由首条消息内容派生的稳定指纹（同一对话历史 → 同一 id）
 *
 * @param {any} body
 * @param {string|undefined} explicit
 * @returns {string}
 */
export function deriveSessionId(body, explicit) {
  if (typeof explicit === 'string' && explicit !== '') return explicit;
  if (typeof body?.user === 'string' && body.user !== '') return `user-${simpleHash(body.user)}`;
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const first = messages.find((m) => m !== null && typeof m === 'object');
  const seed = first === undefined ? '' : flattenContent(first.content);
  return seed === '' ? `sess-${Date.now().toString(36)}` : `conv-${simpleHash(seed)}`;
}

/** 稳定的 32 位字符串哈希（FNV-1a），用于派生会话 id。 */
export function simpleHash(input) {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * 确定请求要用的模型 key。
 *
 * DSH/pi-ai 会把模型 id 放在 `body.model`。QwenWork 的 `model_config.key`
 * 使用同一命名（pro / flash / ...），因此直接沿用；缺省回退 `pro`。
 *
 * @param {any} body
 * @returns {string}
 */
export function resolveModelKey(body) {
  const model = body?.model;
  if (typeof model === 'string' && model !== '') return model;
  return 'pro';
}

/**
 * 取某个模型声明的能力位（供 1.2.0 的 `model_config.is_vl` / `is_reasoning` 使用）。
 *
 * 依据：SDK 1.2.0 的 `model_config`（规格 §3.6，偏移 8816066）里
 *   `is_vl: t?.isVl ?? r?.is_vl ?? false`、`is_reasoning: r?.is_reasoning ?? false`，
 * 其中 `r` 是上游 catalog 返回的**逐模型**记录。插件不动态拉 catalog，等价物是
 * models.js 的静态目录（其注释注明取自 App `rawModels` 的 `is_vl` 等实测值）：
 *   - `is_vl`        ← 目录的 `supportsImages`（App `rawModels.is_vl === true`）
 *   - `is_reasoning` ← 目录的既有声明：models.js 的 `toPiModel()` 对全部模型
 *                      置 `reasoning: true`（实测上游确实返回 `reasoning_content`）
 *
 * 目录里查不到的模型按 SDK 的兜底取 `false`——不凭空声明能力。注意
 * `is_reasoning` 还会被 SDK 按 `thinkingBudget === 0` / `reasoning_effort === "none"`
 * 降级为 false（规格 §3.6）；本插件不主动关闭思考，故不做该降级。
 *
 * ⚠️ **`is_vl` 绝不可用作「是否发送图片」的开关**（t7 实测）：
 *   - 上游**不看**该字段——实测 `is_vl:false` 时上游照样正常识图；
 *   - 它只是 SDK **本地**决定是否把图片降级为 `[Image omitted...]` 占位符的开关；
 *   - 真正的发图判据是 `toMultimodalContent()`：content 数组里存在
 *     `{type:"image_url"}` 块才发图，与模型能力声明无关。
 *   它在这里**仅**用于填写 1.2.0 契约要求的 `model_config.is_vl` 字段。
 *
 * @param {string} modelKey
 * @returns {{ isVl: boolean, isReasoning: boolean }}
 */
function resolveModelCapabilities(modelKey) {
  const info = FALLBACK_QWENWORK_MODELS.find((m) => m.id === modelKey);
  if (info === undefined) return { isVl: false, isReasoning: false };
  return { isVl: info.supportsImages === true, isReasoning: true };
}

/**
 * 创建 shim 的请求处理器。
 *
 * @param {{
 *   getCredential: () => Promise<any>,
 *   getIdleTimeoutMs?: number,
 *   endpoint?: string,
 *   identity?: { installRoot?: string, env?: NodeJS.ProcessEnv },
 *   logger?: { info?: Function, warn?: Function, error?: Function },
 *   signerFactory?: typeof createSignerSession,
 * }} deps
 */
export function createChatShimHandler(deps) {
  const idleTimeoutMs = deps.getIdleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  // 上游「响应头」等待上限。默认 60s；测试可传更小值验证不悬挂。
  const headerTimeoutMs = deps.getHeaderTimeoutMs ?? UPSTREAM_HEADER_TIMEOUT_MS;
  const log = deps.logger ?? {};
  const signerFactory = deps.signerFactory ?? createSignerSession;
  // 共享密钥：优先用调用方传入的（startChatShim 会生成并传入），
  // 否则在此处生成——保证「无密钥即拒绝」始终成立，密钥绝不缺省为空。
  const sharedSecret = deps.sharedSecret ?? generateSharedSecret();
  /** 缓存的签名会话，避免每次请求都重建 WASM 上下文。 */
  let sessionPromise = null;
  /** 会话对应的 token，用于在凭据变更时失效。 */
  let sessionToken = null;

  /** 取（或重建）签名会话。token 变化时自动重建。 */
  async function getSession() {
    const credential = await deps.getCredential();
    const token = credential?.token ?? '';
    if (sessionPromise !== null && token !== '' && token === sessionToken) return sessionPromise;
    if (sessionPromise !== null) {
      // 凭据已变更：释放旧会话
      sessionPromise.then((s) => s.dispose?.()).catch(() => {});
    }
    sessionToken = token;
    sessionPromise = signerFactory({
      credential,
      ...(deps.endpoint === undefined ? {} : { endpoint: deps.endpoint }),
      ...(deps.identity === undefined ? {} : { identity: deps.identity }),
    });
    sessionPromise.catch(() => {
      sessionPromise = null;
      sessionToken = null;
    });
    return sessionPromise;
  }

  return async function handleChatShim(req, res) {
    const reqT0 = Date.now();
    trace('request-in', { method: req.method, url: req.url });
    if (req.method !== 'POST') {
      trace('reject', { reason: 'method', status: 405 });
      jsonError(res, 405, 'method not allowed', 'invalid_request_error');
      return;
    }
    if (!loopbackRequest(req)) {
      trace('reject', { reason: 'loopback', status: 403 });
      jsonError(res, 403, 'request-not-trusted', 'permission_error');
      return;
    }
    // 进程级鉴别：环回校验挡住外部主机，这里挡住本机其他进程。
    // 无密钥 / 错误密钥一律 401——不得在未鉴别时触碰任何业务逻辑或上游。
    if (!secretMatches(extractBearer(req), sharedSecret)) {
      trace('reject', { reason: 'auth', status: 401 });
      jsonError(res, 401, 'unauthorized', 'authentication_error');
      return;
    }

    let raw;
    try {
      raw = await readBody(req);
    } catch (error) {
      jsonError(res, 413, safeMessage(error), 'invalid_request_error');
      return;
    }

    let body;
    try {
      body = JSON.parse(raw === '' ? '{}' : raw);
    } catch {
      jsonError(res, 400, 'request body is not valid JSON', 'invalid_request_error');
      return;
    }

    const messages = toQwenWorkMessages(body);
    if (messages.length === 0) {
      jsonError(res, 400, 'messages is required', 'invalid_request_error');
      return;
    }
    // 必须至少有一条 user 消息：上游以「最后一条 user 消息」作为 chat_context.text，
    // 只有 system / 只有 assistant 时该字段为空，上游会拿空输入作答（表现为答非所问）。
    // 与其让下游收到一段莫名其妙的内容，不如立刻给出明确的 400。
    if (!messages.some((m) => m.role === 'user')) {
      jsonError(res, 400, 'messages must contain at least one user message', 'invalid_request_error');
      return;
    }

    const modelKey = resolveModelKey(body);
    const sessionId = deriveSessionId(body, undefined);

    let session;
    try {
      session = await getSession();
    } catch (error) {
      log.warn?.('dsh-qwen-connect: chat shim could not build signer session', safeMessage(error));
      jsonError(res, 503, safeMessage(error), 'authentication_error');
      return;
    }

    // ---- 向上游发起签名请求 ------------------------------------------
    // 重试策略借鉴 Buddy2api 的 RETRYABLE_STATUS：仅对可重试状态码（限流/网关瞬时故障）
    // 重试，且必须发生在「向客户端写任何 SSE 之前」——否则响应已开始，重试会串流。
    //
    // ⚠️ `upstreamAbort` 必须在此**声明**（下方多处引用它）：它的声明位置曾晚于
    // 首次使用，导致 TDZ 错误 `Cannot access 'upstreamAbort' before initialization`，
    // 使**所有**请求都直接 502。
    const upstreamAbort = new AbortController();
    let upstream;
    try {
      // tools 必须一并透传：否则模型收不到工具 schema，会编造自由文本格式。
      // 1.2.0 的 model_config 需要 is_vl / is_reasoning（规格 §3.6），取值来自
      // models.js 的静态目录声明（插件侧不动态拉 catalog）。
      const capabilities = resolveModelCapabilities(modelKey);
      const bodyJson = buildInferBody({
        messages,
        modelKey,
        sessionId,
        tools: body?.tools,
        isVl: capabilities.isVl,
        isReasoning: capabilities.isReasoning,
        // 图片经 chat_context.imageUrls 送上游。
        // ⚠️ t7 实测：该字段**无实际作用**，真正生效的通道是 messages[].content[]
        // 里的 {type:"image_url",image_url:{url}}（由 toMultimodalContent 产出）。
        // 此处保留仅为「只增不减」既有行为，删除它不属本任务范围。
        imageUrls: collectImageUrls(body),
      });
      upstream = await fetchUpstreamWithRetry(session, bodyJson, modelKey, log, {
        signal: upstreamAbort.signal,
        ...(headerTimeoutMs === undefined ? {} : { headerTimeoutMs }),
      });
      trace('upstream-headers', { ms: Date.now() - reqT0, status: upstream.status, model: modelKey });
    } catch (error) {
      trace('upstream-fail', { ms: Date.now() - reqT0, error: safeMessage(error) });
      log.warn?.('dsh-qwen-connect: upstream request failed', safeMessage(error));
      jsonError(res, 502, safeMessage(error), 'api_error');
      return;
    }

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      trace('upstream-rejected', { ms: Date.now() - reqT0, status: upstream.status });
      log.warn?.('dsh-qwen-connect: upstream rejected', upstream.status);
      jsonError(res, upstream.status, safeMessage(text) || 'upstream error', 'api_error');
      return;
    }

    // ---- 解析上游 SSE 并转成 OpenAI SSE ------------------------------
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      // 明确禁止缓冲，保证真流式
      'X-Accel-Buffering': 'no',
    });

    const chunkId = `chatcmpl-${Date.now().toString(36)}`;
    const created = Math.floor(Date.now() / 1000);
    const parser = new SseParser();
    let finished = false;
    let clientGone = false;
    /** 上游在流中途报错；置位后不得再补正常收尾帧，否则会掩盖真实错误。 */
    let errored = false;
    /** 上游末帧给出的 token 统计（OpenAI 形态）；拿不到保持 null，不编造。 */
    let usage = null;
    // ---- 性能采样（供设置卡片展示上游速度）----
    const startedAt = Date.now();
    /** 首个**正文**内容到达时刻；null 表示还没有正文。 */
    let firstContentAt = null;
    /** 累加的正文长度（不含思考链）——速率只看正文，否则思考会虚高。 */
    let outputChars = 0;
    // ---- 「200 之后的静默」放弃计时器 ----
    // 上游拿到 200 后若在 FIRST_CONTENT_TIMEOUT_MS 内**任何帧都没发**
    // （reasoning 或 content 都算帧），就视为排队失败，主动放弃并报错。
    // 见 FIRST_CONTENT_TIMEOUT_MS 的文档（trace 实测的排队态卡死模式）。

    res.on('close', () => {
      clientGone = true;
      // 客户端走了就没有下游了，及时中断上游，避免连接与 token 被白白消耗。
      try {
        upstreamAbort.abort('client disconnected');
      } catch {
        /* 已中止 */
      }
    });

    /** 写一块；客户端断开后不再写。 */
    const write = (text) => {
      if (clientGone || res.writableEnded) return false;
      try {
        res.write(text);
        return true;
      } catch {
        clientGone = true;
        return false;
      }
    };

    /** 处理解析出的负载；返回 false 表示应停止读流。 */
    const handlePayload = (payload) => {
      const frame = parseQwenWorkFrame(payload);
      if (frame.kind === 'skip') return true;
      if (frame.kind === 'error') {
        // 上游在流中途报告错误：以 OpenAI 的 error 帧表达。
        //
        // ⚠️ 置 `errored`，收尾时**不得**再补 `finish_reason: "stop"` + `[DONE]`。
        // 否则下游会认为「流正常结束但内容为空」，报出 EMPTY_RESPONSE 之类
        // 的误导性错误，把真实原因（如「该模型对当前账号不可用」）掩盖掉。
        //
        // ⚠️ 必须**原样保留上游的 HTTP 状态码**。上游把错误放在 HTTP 200 的
        // SSE 流内，下游（pi-ai → DSH）从协议层拿不到任何状态码；这里若再丢掉
        // `frame.error.status`，用户就只看到 "Model catalog unavailable" 这类
        // 纯文本，无法区分「模型名写错了」与「上游 503，只能等」。
        // 实测上游会用状态码表达不同语义：
        //   403 Model is not available for this user  —— 模型不在该账号可用列表
        //   400 Unsupported FetchKeys value           —— 请求 URL 参数不合法
        //   503 Model catalog unavailable             —— 上游模型目录服务不可用
        // 状态码是这三者唯一的判据，因此按 `HTTP <code>: <message>` 透传。
        const status = frame.error.status;
        const message =
          typeof status === 'number' && status > 0
            ? `HTTP ${status}: ${frame.error.message}`
            : frame.error.message;
        write(`data: ${JSON.stringify({ error: { message, type: 'api_error' } })}\n\n`);
        errored = true;
        return false;
      }
      // 上游把 token 统计放在末帧的 raw_usage 里，且常与 finish_reason 帧分离。
      // 先记下来，收尾时随最后一个 chunk 下发（OpenAI 的用法）。
      if (frame.rawUsage !== undefined) {
        usage = parseRawUsage(frame.rawUsage);
      }
      if (frame.delta !== undefined && Object.keys(frame.delta).length > 0) {
        // 性能采样：只对**正文**计时（思考链长度会让速率虚高；纯思考
        // 而无正文的请求不应计入——那会得到"首 token 很早但速率极低"的假象）。
        if (typeof frame.delta.content === 'string' && frame.delta.content !== '') {
          if (firstContentAt === null) {
            firstContentAt = Date.now();
            trace('first-content', { ms: firstContentAt - reqT0 });
          }
          outputChars += frame.delta.content.length;
        }
        write(encodeOpenAiChunk({ model: modelKey, id: chunkId, created, delta: frame.delta }));
      }
      if (frame.finishReason !== null && frame.finishReason !== undefined) {
        write(
          encodeOpenAiChunk({
            model: modelKey,
            id: chunkId,
            created,
            finishReason: frame.finishReason,
            usage,
          }),
        );
        finished = true;
        // 已带 usage 时无需再补一帧；否则继续读，等可能的 raw_usage 帧。
        return usage === null;
      }
      return true;
    };

    const idleTimer = { current: null };
    let idleFired = false;
    const armIdle = () => {
      clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => {
        // ⚠️ 关键：必须**先给客户端一个明确结果**，再收摊。
        // 只设 clientGone 会让后续所有 write 被跳过，客户端一个字节都收不到
        // → 界面永久转圈（表现为"卡住"，比报错更难排查）。
        idleFired = true;
        trace('idle-watchdog-fired', { ms: Date.now() - reqT0, idleTimeoutMs });
        if (!res.writableEnded) {
          try {
            res.write(
              `data: ${JSON.stringify({
                error: {
                  message: `upstream produced no data for ${idleTimeoutMs}ms`,
                  type: 'api_error',
                },
              })}\n\n`,
            );
            res.write(SSE_DONE);
          } catch {
            /* 客户端已断开 */
          }
        }
        clientGone = true;
        // ⚠️ 用 AbortController 中断读取，**不要**调 `upstream.body.cancel()`：
        // 此刻 `for await (const chunk of upstream.body)` 正在读取该流，
        // ReadableStream 已被锁定，`cancel()` 会抛
        // `ERR_INVALID_STATE: ReadableStream is locked`。该异常在定时器回调里
        // 抛出，**不会被外层的 try/catch 捕获**（不在同一调用栈），
        // 会冒成 uncaughtException。
        try {
          upstreamAbort.abort('upstream idle timeout');
        } catch {
          /* 已中止 */
        }
      }, idleTimeoutMs);
    };

    try {
      armIdle();
      const decoder = new TextDecoder('utf-8');
      for await (const chunk of upstream.body) {
        if (clientGone) break;
        armIdle();
        const payloads = parser.push(decoder.decode(chunk, { stream: true }));
        let keepGoing = true;
        for (const payload of payloads) {
          if (!handlePayload(payload)) {
            keepGoing = false;
            break;
          }
        }
        if (!keepGoing) break;
      }

      if (!clientGone && !parser.done) {
        for (const payload of parser.flush()) {
          if (!handlePayload(payload)) break;
        }
      }

      // 收尾：无论上游是否给了 finish_reason，都要给下游一个明确的结束帧，
      // 否则 pi-ai 会一直等下去（"挂起"）。
      //
      // 例外一：上游已在流内报错（errored）——**不得**补正常收尾帧，否则下游
      //   会把「错误」误读成「正常结束但无内容」，真实原因被 EMPTY_RESPONSE
      //   之类的通用错误覆盖。只补一个 [DONE] 终止读取。
      // 例外二：看门狗已触发（idleFired）——它已经写过错误帧 + [DONE]，
      //   此处 `clientGone` 为 true 因而整体跳过，不会再补正常帧。
      if (!clientGone) {
        if (errored) {
          write(SSE_DONE);
        } else {
          if (!finished) {
            write(
              encodeOpenAiChunk({
                model: modelKey,
                id: chunkId,
                created,
                finishReason: 'stop',
                usage,
              }),
            );
          } else if (usage !== null) {
            // finish 帧已经发过、usage 是随后才到的：补一帧只带 usage 的分块。
            // OpenAI 的约定是 usage 出现在最后一个 chunk 上（choices 可为空）。
            write(
              `data: ${JSON.stringify({
                id: chunkId,
                object: 'chat.completion.chunk',
                created,
                model: modelKey,
                choices: [],
                usage,
              })}\n\n`,
            );
          }
          write(SSE_DONE);
        }
      }
    } catch (error) {
      // 网络中断：不让异常穿透出去炸掉插件，给下游一个错误帧即止
      log.warn?.('dsh-qwen-connect: upstream stream interrupted', safeMessage(error));
      if (!clientGone) {
        write(`data: ${JSON.stringify({ error: { message: safeMessage(error), type: 'api_error' } })}\n\n`);
        write(SSE_DONE);
      }
    } finally {
      clearTimeout(idleTimer.current);
      trace('stream-end', {
        ms: Date.now() - reqT0,
        clientGone,
        errored,
        finished,
        idleFired,
        outputChars,
      });
      // 性能采样：只在「有正文且未出错」时记录——失败请求与纯思考无正文的
      // 请求会污染速率统计（分母极小或为 0）。recordSample 内部还会再校验。
      if (firstContentAt !== null && !errored) {
        const endedAt = Date.now();
        const genMs = endedAt - firstContentAt;
        recordSample({
          ttftMs: firstContentAt - startedAt,
          charsPerSec: genMs > 0 ? (outputChars / genMs) * 1000 : 0,
          totalMs: endedAt - startedAt,
          outputChars,
        });
      }
      if (!res.writableEnded) {
        try {
          res.end();
        } catch {
          /* 已关闭 */
        }
      }
    }
  };
}

/** 读取请求体，带大小上限。 */
function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

/** 以 OpenAI 错误信封返回。 */
function jsonError(res, status, message, type) {
  if (res.writableEnded) return;
  const payload = JSON.stringify({ error: { message, type } });
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
    });
    res.end(payload);
  } catch {
    /* 连接已断 */
  }
}

/**
 * 启动 shim 服务器，监听 `127.0.0.1` 的随机端口。
 *
 * @param {Parameters<typeof createChatShimHandler>[0]} deps
 * @returns {Promise<{ baseUrl: string, port: number, close: () => Promise<void> }>}
 */
export function startChatShim(deps) {
  // 共享密钥在启动时生成一次；handler 用它做进程级鉴别，
  // 返回对象把它暴露给调用方（经 resolveApiKey 喂回 pi-ai）。
  const sharedSecret = deps.sharedSecret ?? generateSharedSecret();
  const handler = createChatShimHandler({ ...deps, sharedSecret });
  const server = http.createServer((req, res) => {
    if (!req.url || !req.url.startsWith(CHAT_COMPLETIONS_PATH)) {
      jsonError(res, 404, 'not found', 'invalid_request_error');
      return;
    }
    handler(req, res).catch(() => {
      jsonError(res, 500, 'internal error', 'api_error');
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        // baseUrl 含 CHAT_COMPLETIONS_PATH 路径：历史形态，所有直接 fetch
        // shim.baseUrl 的测试与探针都依赖它。pi-ai 的 OpenAI SDK 会在其后
        // 再拼一次 /chat/completions（trace 实测
        // `/v1/chat/completions/chat/completions`），shim 的 startsWith
        // 路由会放行——虽然不优雅，但它是**实测可工作**的形态。
        // ⚠️ 修改此形状前先跑通全部测试；曾因改成 origin 形式引发回归。
        baseUrl: `http://127.0.0.1:${port}${CHAT_COMPLETIONS_PATH}`,
        port,
        // 供 pi-ai 的 resolveApiKey 使用；只应经进程内接线传递，绝不下发。
        sharedSecret,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
