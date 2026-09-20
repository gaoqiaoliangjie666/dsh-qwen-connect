// ============================================================================
// 阶段A-1 交付物：QwenWorkCN 请求签名器（复用官方 WASM）
//
// 本模块在 Node 中实例化 App 内联的 qoder_auth_wasm，直接调用官方签名逻辑，
// 产出被服务端接受的 url / headers / body。不依赖 App 进程，不做算法复刻，
// 因此对官方版本更替的抵抗力最强（只依赖 WASM 本体与 glue ABI）。
//
// 关键逆向结论（全部经实测验证）：
//   - 签名模块 = obf 文件 offset 26762 处的 base64 内联 WASM（Rust + wasm-bindgen）
//   - QoderContext 构造签名：(machineId, cosyVersion, userInfoJson, clientMetadataJson)
//   - userInfoJson 结构：{uid:string, encrypt_user_info:string, key:string,
//                        organization_id:string, organization_tags:any[],
//                        data_policy_agreed:boolean}
//   - encrypt_user_info / key 由 wasm 的 generate_runtime_auth_fields 生成
//   - prepareInferRequest(endpoint, bodyJson, modelKey, modelSource)
//       -> 返回 {url, headers(Map, 20 项), body(加密串)}
//   - 真正的签名在 headers.Authorization: "Bearer COSY.<payload>.<sig>"
//     （绝不能再用 Bearer <token> 覆盖它，否则 403 Signature invalid）
//
// 本文件不写入、不打印任何凭据。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { QoderContext, initFromFile, generate_runtime_auth_fields } from './qoder-wasm-glue.mjs';

export const COSY_VERSION = '1.1.32';
export const DEFAULT_ENDPOINT = 'https://gateway.qwenwork.cn';
export const INFER_PATH = '/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common';

// uE() 的等价实现：QwenWork 集成模式下 client_type=6 / business_product=qoder_work
export const CLIENT_METADATA = {
  client_type: '6',
  business_product: 'qoder_work',
  business_type: 'agent',
  scene: 'assistant',
};

const WASM_BIN = path.join(import.meta.dirname, 'wasm.bin');

let initialized = false;

/** 初始化 WASM（幂等）。wasmPath 默认指向 research/wasm.bin。 */
export function initWasm(wasmPath = WASM_BIN) {
  if (initialized) return;
  initFromFile(wasmPath);
  initialized = true;
}

/**
 * 创建一个已登录的 QoderContext。
 *
 * @param {object} credential  - 解密后的凭据（auth-v2.dat 内容），至少需要：
 *                               { token, user: { id|uid, orgId?, orgTags? }, loginDeviceId? }
 * @param {object} [options]
 * @param {string} [options.machineId]   默认取 credential.loginDeviceId
 * @param {string} [options.cosyVersion] 默认 1.1.32
 * @param {string} [options.uid]         默认 credential.user.uid ?? credential.user.id
 * @param {boolean}[options.dataPolicyAgreed] 默认 false
 */
export function createContext(credential, options = {}) {
  initWasm(options.wasmPath);
  const user = credential.user || {};
  const uid = options.uid ?? user.uid ?? user.id ?? '';
  const machineId = options.machineId ?? credential.loginDeviceId;
  if (!machineId) throw new Error('createContext: 缺少 machineId（credential.loginDeviceId）');

  const orgId = user.organization_id ?? user.orgId ?? '';
  const orgTags = user.organization_tags ?? user.orgTags ?? [];

  // 复刻 AuthManager.regenerateRuntimeFields()
  const runtime = JSON.parse(generate_runtime_auth_fields(JSON.stringify({
    uid,
    organization_id: orgId,
    organization_tags: orgTags,
    data_policy_agreed: options.dataPolicyAgreed ?? false,
  })));

  // 复刻 AuthManager.createWasmContext()
  const ctx = new QoderContext(
    machineId,
    options.cosyVersion ?? COSY_VERSION,
    JSON.stringify({
      uid,
      encrypt_user_info: runtime.encrypt_user_info,
      key: runtime.key,
      organization_id: orgId,
      organization_tags: orgTags,
      data_policy_agreed: options.dataPolicyAgreed ?? false,
    }),
    JSON.stringify(CLIENT_METADATA),
  );
  return ctx;
}

/**
 * 对推理请求签名。等价于 SDK 的 ner(endpoint, bodyJson, modelKey, modelSource)。
 *
 * @returns {{url:string, headers:Record<string,string>, body:string}}
 */
export function signInferRequest(ctx, bodyJson, modelKey, modelSource, endpoint = DEFAULT_ENDPOINT) {
  const r = ctx.prepareInferRequest(endpoint, bodyJson, modelKey, modelSource);
  const headers = {};
  const h = r.headers;
  if (h && typeof h.forEach === 'function') h.forEach((v, k) => { headers[k] = v; });
  const out = { url: r.url, headers, body: r.body };
  r.free();
  return out;
}

/** 对通用请求签名。等价于 SDK 的 A_(endpoint, path, method, "auth", body, headers)。 */
export function signRequest(ctx, endpoint, reqPath, method, body, extraHeaders, endpoint_ = DEFAULT_ENDPOINT) {
  const r = ctx.prepareRequest(
    endpoint,
    reqPath,
    method,
    'auth',
    body ?? undefined,
    extraHeaders ? JSON.stringify(extraHeaders) : undefined,
  );
  const headers = {};
  const h = r.headers;
  if (h && typeof h.forEach === 'function') h.forEach((v, k) => { headers[k] = v; });
  const out = { url: r.url, headers, body: r.body };
  r.free();
  return out;
}

/**
 * 直接构造 chat 请求的 body（经实测可用的最小结构）。
 * 实测：messages 放在顶层即可，顶层 model_config 可选。
 */
export function buildChatBody({ messages, modelKey = 'pro', modelSource = 'system', sessionId, requestId } = {}) {
  return JSON.stringify({
    request_id: requestId ?? (globalThis.crypto?.randomUUID?.() ?? `req-${Date.now()}`),
    session_id: sessionId ?? `sess-${Date.now()}`,
    model_config: { key: modelKey, source: modelSource },
    messages,
  });
}

/**
 * 发起一次真实的流式对话请求，返回原始 Response（SSE）。
 * 调用方自行解析 SSE 帧。响应帧形如：
 *   data:{"headers":{...},"body":"{\"choices\":[{\"delta\":{...}}]}","statusCodeValue":200,"statusCode":"OK"}
 */
export async function chatStream(ctx, messages, opts = {}) {
  const modelKey = opts.modelKey ?? 'pro';
  const modelSource = opts.modelSource ?? 'system';
  const bodyJson = buildChatBody({ messages, modelKey, modelSource, sessionId: opts.sessionId, requestId: opts.requestId });
  const signed = signInferRequest(ctx, bodyJson, modelKey, modelSource, opts.endpoint);
  return fetch(signed.url, {
    method: 'POST',
    headers: signed.headers,
    body: signed.body,
    signal: opts.signal,
  });
}
