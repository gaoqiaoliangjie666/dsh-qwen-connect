/**
 * 与 QwenWork 上游的**签名会话**：把 t3 的 WASM 签名能力包装成一个可复用、
 * 可测试、可诊断的会话对象。
 *
 * ── 职责 ────────────────────────────────────────────────────────────
 *  - 惰性实例化 WASM（只实例化一次，进程内共享）
 *  - 用凭据 + 动态解析出的 Cosy-Version / machineId 构造 QoderContext
 *  - 对推理请求签名（URL / headers / 加密 body 全部由官方 WASM 产生）
 *  - 把「凭据变更」表现为可重建：token 刷新后重建上下文
 *
 * ── 不可退让的事实（阶段 A-1 逆向结论）────────────────────────────────
 *  1. `Authorization: Bearer COSY.<payload>.<hex>` 由 WASM 生成，
 *     **绝不能被 `Bearer <accessToken>` 覆盖**——覆盖即 403。
 *  2. URL 由 WASM 硬编码产出（含 `/algo` 前缀 + `&Encode=1`），忽略传入 path。
 *  3. `headers` 是 `Map`，必须 `forEach` 展开成普通对象。
 *  4. body 由 WASM 加密，调用方只能原样转发。
 *
 * ── 安全边界 ────────────────────────────────────────────────────────
 * 凭据只驻留内存；导出的诊断信息不含 token / key / encrypt_user_info。
 *
 * @module dsh-qwen-connect/signer-session
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { QwenAuthError, ErrorCode } from './errors.js';
import { resolveCosyVersion, resolveMachineId } from './runtime-identity.js';
// 输入/输出上限的唯一定义处：与 models.js 声明的 contextWindow 必须一致，
// 否则 DSH 的上下文溢出判断会与实际可用窗口脱节。
import { MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS } from './models.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 签名模块（WASM）与 glue 的默认位置。 */
export const DEFAULT_WASM_BIN = path.join(HERE, '..', 'research', 'wasm.bin');
export const DEFAULT_GLUE = path.join(HERE, '..', 'research', 'qoder-wasm-glue.mjs');

/** 签名端点的基址（与阶段 A-1 一致）。 */
export const DEFAULT_ENDPOINT = 'https://gateway.qwenwork.cn';

/** 签名会产出的推理路径，仅用于展示与断言（真实 URL 由 WASM 决定）。 */
export const INFER_PATH =
  '/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common';

/** QwenWork 集成模式的客户端元数据（复刻 SDK 的 uE()）。 */
export const CLIENT_METADATA = Object.freeze({
  client_type: '6',
  business_product: 'qoder_work',
  business_type: 'agent',
  scene: 'assistant',
});

/** WASM 模块的进程内单例。 */
let wasmModulePromise = null;

/**
 * 惰性加载并实例化签名 WASM（进程内只做一次）。
 *
 * @param {{ wasmBin?: string, glueModule?: string }} [opts]
 * @returns {Promise<any>} glue 模块（含 QoderContext / generate_runtime_auth_fields）
 */
export function loadSignerModule(opts = {}) {
  if (wasmModulePromise !== null) return wasmModulePromise;

  const wasmBin = opts.wasmBin ?? DEFAULT_WASM_BIN;
  const glueSpecifier = opts.glueModule ?? DEFAULT_GLUE;

  wasmModulePromise = (async () => {
    const glue = await import(pathToFileUrl(glueSpecifier));
    glue.initFromFile(wasmBin);
    return glue;
  })();

  // 失败后允许重试（例如 wasm.bin 后来才就位）
  wasmModulePromise.catch(() => {
    wasmModulePromise = null;
  });

  return wasmModulePromise;
}

/** 把磁盘路径转成可 import 的 file URL（兼容 Windows 盘符与空格/中文）。 */
function pathToFileUrl(p) {
  return new URL(`file:///${p.replace(/\\/g, '/').replace(/^\//, '')}`).href;
}

/** 供测试重置单例。 */
export function resetSignerModule() {
  wasmModulePromise = null;
}

/**
 * 创建一次签名会话。
 *
 * @param {object} params
 * @param {any} params.credential  t1 的规范化凭据（需 token / user / loginDeviceId）
 * @param {string} [params.endpoint]
 * @param {{ installRoot?: string, env?: NodeJS.ProcessEnv }} [params.identity]
 * @param {{ wasmBin?: string, glueModule?: string }} [params.wasm]
 * @returns {Promise<object>} 会话对象
 */
export async function createSignerSession(params) {
  const credential = params.credential;
  if (credential === null || typeof credential !== 'object') {
    throw new QwenAuthError(ErrorCode.CREDENTIALS_MISSING, '签名会话缺少凭据对象。', {
      recovery: '请先登录千问办公桌面应用，或检查凭据文件是否可读。',
    });
  }

  const identityOpts = {
    credential,
    ...(params.identity?.installRoot === undefined ? {} : { installRoot: params.identity.installRoot }),
    ...(params.identity?.env === undefined ? {} : { env: params.identity.env }),
  };

  const cosy = resolveCosyVersion(identityOpts);
  const machine = resolveMachineId(identityOpts);

  if (machine === null) {
    throw new QwenAuthError(
      ErrorCode.CREDENTIALS_MISSING,
      '无法确定签名所需的 machineId，签名将不被服务端接受。',
      {
        recovery:
          '凭据缺少 loginDeviceId。请重新登录千问办公桌面应用；'
          + '或显式设置环境变量 QWEN_MACHINE_ID。',
        retryable: false,
      },
    );
  }

  const glue = await loadSignerModule(params.wasm ?? {});
  const user = credential.user ?? {};
  const uid = user.uid ?? user.id ?? '';

  // 复刻 AuthManager.regenerateRuntimeFields()：由 WASM 生成加密用户字段
  const runtimeFields = JSON.parse(
    glue.generate_runtime_auth_fields(
      JSON.stringify({
        uid,
        organization_id: user.organization_id ?? '',
        organization_tags: user.organization_tags ?? [],
        data_policy_agreed: user.data_policy_agreed ?? false,
      }),
    ),
  );

  const context = new glue.QoderContext(
    machine.machineId,
    cosy.version,
    JSON.stringify({
      uid,
      encrypt_user_info: runtimeFields.encrypt_user_info,
      key: runtimeFields.key,
      organization_id: user.organization_id ?? '',
      organization_tags: user.organization_tags ?? [],
      data_policy_agreed: user.data_policy_agreed ?? false,
    }),
    JSON.stringify(CLIENT_METADATA),
  );

  const endpoint = params.endpoint ?? DEFAULT_ENDPOINT;

  return {
    endpoint,
    cosyVersion: cosy,
    machineId: machine,

    /**
     * 对推理请求签名。
     *
     * @param {string} bodyJson 明文的 QwenWork 请求体 JSON
     * @param {{ modelKey?: string, modelSource?: string }} [opts]
     * @returns {{ url: string, headers: Record<string,string>, body: string, headerCount: number }}
     */
    signInferRequest(bodyJson, opts = {}) {
      const result = context.prepareInferRequest(
        endpoint,
        bodyJson,
        opts.modelKey ?? undefined,
        opts.modelSource ?? undefined,
      );
      return collectResult(result);
    },

    /**
     * 对通用请求签名（`prepareRequest` 路径）。
     *
     * @param {{ path: string, method: string, mode?: string, body?: string, headers?: object }} req
     */
    signRequest(req) {
      const result = context.prepareRequest(
        endpoint,
        req.path,
        req.method,
        req.mode ?? 'auth',
        req.body ?? undefined,
        req.headers === undefined ? undefined : JSON.stringify(req.headers),
      );
      return collectResult(result);
    },

    /**
     * 非敏感诊断信息，可安全落入日志。
     *
     * ⚠️ `machineId` 在这里**只输出掩码**：describe() 的典型用途是打日志，
     * 而设备标识能关联到具体账号，属于与 token 同级的敏感信息。需要完整值
     * 时请用 `describeDetailed()`（仅限本地排障，不得写日志）。
     */
    describe() {
      return {
        endpoint,
        cosyVersion: cosy,
        machineId: {
          source: machine.source,
          length: machine.machineId.length,
          masked: maskIdentifier(machine.machineId),
        },
        uidPresent: uid !== '',
      };
    },

    /** 释放 WASM 侧资源。 */
    dispose() {
      try {
        context.free();
      } catch {
        /* 重复释放无害 */
      }
    },
  };
}

/**
 * 把 WASM 的 `RequestResult` 收集成普通对象。
 *
 * 关键点：`headers` 是 `Map`，必须显式展开；`body`/`url` 是惰性 getter，
 * 必须在 `free()` **之前**读取。
 *
 * @param {any} result
 */
function collectResult(result) {
  try {
    const headers = {};
    const rawHeaders = result.headers;
    if (rawHeaders !== null && rawHeaders !== undefined && typeof rawHeaders.forEach === 'function') {
      rawHeaders.forEach((value, key) => {
        headers[String(key)] = String(value);
      });
    }
    return {
      url: result.url,
      headers,
      body: result.body,
      headerCount: result.headerCount,
    };
  } finally {
    try {
      result.free();
    } catch {
      /* free 失败不应掩盖上面的读取错误 */
    }
  }
}

/**
 * 构造 QwenWork 的推理请求体。
 *
 * ⚠️ `messages` 必须在**顶层**。阶段 A-1 实测：嵌套在 `chat.messages` 会被
 * 服务端以 `400 messages is required` 拒绝。
 *
 * @param {object} params
 * @param {Array<{ role: string, content: string }>} params.messages
 * @param {string} [params.modelKey]
 * @param {string} [params.modelSource]
 * @param {string} [params.sessionId]
 * @param {string} [params.requestId]
 * @param {Array} [params.tools]
 * @param {number} [params.maxInputTokens]  默认 180000
 * @param {number} [params.maxOutputTokens] 默认 32000
 * @returns {string}
 */
export function buildInferBody(params) {
  const modelKey = params.modelKey ?? 'pro';
  const modelSource = params.modelSource ?? 'system';
  const maxInput = params.maxInputTokens ?? MAX_INPUT_TOKENS;
  const maxOutput = params.maxOutputTokens ?? MAX_OUTPUT_TOKENS;
  // 上游用 chat_context.text 作为「当前这轮要处理什么」的锚点，
  // 并用 chat_context.imageUrls 接收图片（见 Buddy2api 的 build_body）。
  const lastUserText = lastUserContent(params.messages);
  const imageUrls = Array.isArray(params.imageUrls) ? params.imageUrls : [];
  const body = {
    request_id: params.requestId ?? randomId(),
    session_id: params.sessionId ?? `sess-${Date.now().toString(36)}`,
    // 显式声明输入上限：不设时完全依赖上游默认值，而各模型默认不一，
    // 与 models.js 声明的 contextWindow 也可能不一致（那会让 DSH 的
    // 上下文溢出判断失准）。这与已验证实现（Buddy2api）一致。
    model_config: {
      key: modelKey,
      source: modelSource,
      max_input_tokens: maxInput,
    },
    chat_context: {
      text: lastUserText,
      features: [],
      extra: {
        context: [],
        modelConfig: { key: modelKey, source: modelSource },
        originalContent: lastUserText,
      },
      chatPrompt: '',
      // 图片经此字段送达上游；无图时为 null（上游约定）。
      imageUrls: imageUrls.length > 0 ? imageUrls : null,
    },
    agent_id: 'agent_common',
    // 显式给出输出上限：不设时模型可能无限生成，长输入下会出现长时间不返回。
    parameters: { max_tokens: maxOutput },
    messages: params.messages,
  };
  // 工具定义必须透传给上游。若丢弃，模型收不到规范 schema，会自行编造
  // `<tool_call><invoke ...>` 这类自由文本格式，DSH 无法解析，最终原样显示成正文。
  if (Array.isArray(params.tools) && params.tools.length > 0) {
    body.tools = params.tools;
  }
  return JSON.stringify(body);
}

/**
 * 取最后一条 user 消息的纯文本（用作 chat_context.text）。
 *
 * @param {Array<{role?: string, content?: unknown}>} [messages]
 * @returns {string}
 */
function lastUserContent(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .filter((p) => p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .join('');
    }
  }
  return '';
}

/** 生成一个 request id（不依赖 crypto.randomUUID 的存在性）。 */
function randomId() {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  } catch {
    /* 回退下面 */
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 把标识符掩码成 `前4***后2`，长度不足时全掩。
 * 用于任何可能进日志的字段。
 *
 * @param {string} value
 * @returns {string}
 */
export function maskIdentifier(value) {
  if (typeof value !== 'string' || value === '') return '';
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}***${value.slice(-2)}`;
}

// MAX_INPUT_TOKENS / MAX_OUTPUT_TOKENS 从这里也可见：调用方校验
// 「models.js 的 contextWindow 声明」与「请求体里的 max_input_tokens」
// 是否一致时需要同时拿到两者。
export { randomId, MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS };
