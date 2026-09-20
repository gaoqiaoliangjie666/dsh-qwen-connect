/**
 * 签名 shim 入口（约定命名）。
 *
 * ── 为什么有这个文件 ────────────────────────────────────────────────
 * 阶段 A-2 的签名转发层在开发过程中叫 `chat-shim.js`（因为它同时承担
 * 「OpenAI ↔ QwenWork 协议转换」与「注入 WASM 签名」两件事）。而 t2 的
 * 交付约定里，这个模块的名字是 `signer-shim.js`。
 *
 * 为避免两套命名并存造成引用漂移（集成方按 `signer-shim.js` 找、
 * 实现却在 `chat-shim.js`），这里提供一个**稳定的转发入口**：
 *   - 实现仍在 `./chat-shim.js`（保持既有测试与调用点不变）
 *   - 对外统一从这里导入
 *
 * 新代码请从本模块导入，不要直接引用 `./chat-shim.js`。
 *
 * @module dsh-qwen-connect/signer-shim
 */

export {
  CHAT_COMPLETIONS_PATH,
  DEFAULT_IDLE_TIMEOUT_MS,
  FIRST_CONTENT_TIMEOUT_MS,
  RETRYABLE_STATUS,
  UPSTREAM_MAX_ATTEMPTS,
  UPSTREAM_RETRY_BASE_DELAY_MS,
  UPSTREAM_HEADER_TIMEOUT_MS,
  isRetryableStatus,
  createChatShimHandler,
  startChatShim,
  generateSharedSecret,
  secretMatches,
  toQwenWorkMessages,
  collectImageUrls,
  deriveSessionId,
  resolveModelKey,
  simpleHash,
} from './chat-shim.js';
