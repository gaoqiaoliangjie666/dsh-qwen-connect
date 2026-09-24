/**
 * 错误分类：所有对外抛出的错误都带稳定的 `code`，
 * 调用方（DSH 集成层 / 设置卡片）据此给出可操作提示。
 */

export const ErrorCode = {
  /** 凭据文件不存在（用户从未登录过 App，或路径不对） */
  CREDENTIALS_MISSING: 'CREDENTIALS_MISSING',
  /** 凭据文件存在但不是 Chromium v10 加密格式 */
  CREDENTIALS_MALFORMED: 'CREDENTIALS_MALFORMED',
  /** 当前平台不支持（目前仅实现 Windows DPAPI） */
  UNSUPPORTED_PLATFORM: 'UNSUPPORTED_PLATFORM',
  /** DPAPI 解主密钥失败（换过 Windows 用户 / 凭据被其他用户加密 / helper 不可用） */
  DPAPI_FAILED: 'DPAPI_FAILED',
  /** AES-GCM 解密或认证标签校验失败（主密钥不匹配 / 文件损坏） */
  DECRYPT_FAILED: 'DECRYPT_FAILED',
  /** 解密成功但内容不是合法 JSON 或缺关键字段 */
  SCHEMA_INVALID: 'SCHEMA_INVALID',
  /** token 已过期且刷新失败 */
  TOKEN_EXPIRED_NO_REFRESH: 'TOKEN_EXPIRED_NO_REFRESH',
  /** 刷新请求被服务端拒绝（refresh_token 失效/被撤销） */
  REFRESH_REJECTED: 'REFRESH_REJECTED',
  /** 刷新过程中的网络/传输故障（可重试） */
  REFRESH_NETWORK: 'REFRESH_NETWORK',
  /** REST 调用被服务端拒绝（401/403） */
  API_UNAUTHORIZED: 'API_UNAUTHORIZED',
  /** REST 调用其它非 2xx */
  API_ERROR: 'API_ERROR',
};

/** 面向用户的、可操作的修复建议 */
const HINTS = {
  [ErrorCode.CREDENTIALS_MISSING]:
    '未找到千问办公（QwenWorkCN）登录凭据。请先启动 QwenWorkCN 桌面应用并完成登录。',
  [ErrorCode.CREDENTIALS_MALFORMED]:
    '凭据文件格式不是预期的 Chromium v10 加密格式，可能已损坏。请重新登录 QwenWorkCN 桌面应用。',
  [ErrorCode.UNSUPPORTED_PLATFORM]:
    '凭据解密依赖 Windows DPAPI，当前平台不受支持。',
  [ErrorCode.DPAPI_FAILED]:
    'DPAPI 解密主密钥失败。常见原因：凭据由另一个 Windows 用户加密、系统凭据库被重置。请重新登录 QwenWorkCN 桌面应用。',
  [ErrorCode.DECRYPT_FAILED]:
    '凭据 AES-GCM 解密失败（主密钥不匹配或文件损坏）。请重新登录 QwenWorkCN 桌面应用。',
  [ErrorCode.SCHEMA_INVALID]:
    '凭据内容结构不符合预期。请重新登录 QwenWorkCN 桌面应用以重建凭据。',
  [ErrorCode.TOKEN_EXPIRED_NO_REFRESH]:
    '登录已过期且自动续期失败。请重新打开 QwenWorkCN 桌面应用以刷新登录态。',
  [ErrorCode.REFRESH_REJECTED]:
    '续期请求被服务端拒绝（refresh token 可能已撤销）。请重新打开 QwenWorkCN 桌面应用完成登录。',
  [ErrorCode.REFRESH_NETWORK]:
    '续期时网络请求失败，请检查网络后重试。',
  [ErrorCode.API_UNAUTHORIZED]:
    '接口鉴权失败，登录态可能已失效。请重新打开 QwenWorkCN 桌面应用。',
  [ErrorCode.API_ERROR]:
    '接口调用失败。',
};

export class QwenAuthError extends Error {
  /**
   * @param {string} code 稳定的错误分类
   * @param {string} message 面向开发者的细节描述（不得包含任何凭据明文）
   * @param {{ cause?: unknown, recovery?: string, retryable?: boolean }} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'QwenAuthError';
    this.code = code;
    this.recovery = opts.recovery ?? HINTS[code] ?? '';
    this.retryable = opts.retryable ?? false;
  }

  /** 供 UI 展示的单行提示 */
  toUserMessage() {
    return this.recovery ? `${this.message} ${this.recovery}` : this.message;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      recovery: this.recovery,
      retryable: this.retryable,
    };
  }
}

export function isQwenAuthError(e) {
  return e instanceof QwenAuthError;
}
