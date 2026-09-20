/**
 * Token 刷新（device token）。
 *
 * 实测确认的契约（2026-02-21 验证，HTTP 200）：
 *   POST https://gateway.qwenwork.cn/api/v1/deviceToken/refresh
 *   Content-Type: application/json
 *   body: { "refresh_token": "<auth-v2.dat 里的 refreshToken 原值>" }
 *   → { device_token, refresh_token, token_type, expires_at, expires_in, created_at }
 *
 * 重要事实：
 *  - 字段名必须是 snake_case（`refresh_token`）；camelCase 的 `refreshToken`
 *    与任何 `loginDeviceId` / `device_id` 字段都会被拒为
 *    {"errorCode":"INVALID_REFRESH_REQUEST",...,"reason":"not_allowed"}。
 *    即：刷新**不需要** loginDeviceId，也不接受它。
 *  - 不需要 Authorization 头（带与不带均 200）。
 *  - 响应会**轮换 refresh_token**：新值必须回写凭据文件，否则下次刷新会失败
 *    并可能破坏 App 的登录态。
 *  - /api/v1/jobToken/refresh 返回 404，非有效端点。
 */

import fs from 'node:fs';
import path from 'node:path';
import { QwenAuthError, ErrorCode } from './errors.js';
import { decryptV10, encryptV10, isTokenExpired, loadCredentials } from './credentials.js';

export const DEFAULT_BASE_URL = 'https://gateway.qwenwork.cn';
export const REFRESH_PATH = '/api/v1/deviceToken/refresh';
export const AUTH_FILE = 'auth-v2.dat';

/** 刷新请求体构造函数：只允许 refresh_token */
export function buildRefreshBody(refreshToken) {
  return { refresh_token: refreshToken };
}

/**
 * 解析刷新响应，保持字段名兼容（服务端用 snake_case，但做一次兜底）。
 * @returns {{ token: string, refreshToken: string|null, expiresAt: Date|null, expiresIn: number|null, createdAt: Date|null }}
 */
export function parseRefreshResponse(json) {
  const token = json?.device_token ?? json?.deviceToken ?? json?.token ?? null;
  if (typeof token !== 'string' || token.length === 0) {
    throw new QwenAuthError(
      ErrorCode.REFRESH_REJECTED,
      '刷新响应中未包含 device_token。',
    );
  }
  const rt = json?.refresh_token ?? json?.refreshToken ?? null;
  const expiresAtRaw = json?.expires_at ?? json?.expiresAt ?? null;
  return {
    token,
    refreshToken: typeof rt === 'string' && rt.length > 0 ? rt : null,
    expiresAt: expiresAtRaw ? toDate(expiresAtRaw) : null,
    expiresIn: typeof json?.expires_in === 'number' ? json.expires_in : null,
    createdAt: json?.created_at ? toDate(json.created_at) : null,
  };
}

function toDate(v) {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 发起刷新请求。网络层与解析层分离，便于单测注入 fetch。
 *
 * @param {string} refreshToken
 * @param {{ baseUrl?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<ReturnType<typeof parseRefreshResponse>>}
 */
export async function requestTokenRefresh(refreshToken, opts = {}) {
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    throw new QwenAuthError(
      ErrorCode.REFRESH_REJECTED,
      '凭据中没有 refresh token，无法自动续期。请重新打开 QwenWorkCN 桌面应用。',
    );
  }
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new QwenAuthError(ErrorCode.REFRESH_NETWORK, '当前运行环境没有可用的 fetch 实现。');
  }
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  let res;
  try {
    res = await doFetch(baseUrl + REFRESH_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        // 与 App 一致的客户端标识；实测不带也可以，但带上更稳妥
        'user-agent': 'qoderwork/1.0.5',
      },
      body: JSON.stringify(buildRefreshBody(refreshToken)),
      signal: ac.signal,
    });
  } catch (e) {
    throw new QwenAuthError(
      ErrorCode.REFRESH_NETWORK,
      `续期请求失败（网络错误）：${e.message}`,
      { cause: e, retryable: true },
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text().catch(() => '');
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 响应 */
  }

  if (res.status === 401 || res.status === 403) {
    throw new QwenAuthError(
      ErrorCode.REFRESH_REJECTED,
      `续期请求被拒绝（HTTP ${res.status}${json?.errorCode ? `, ${json.errorCode}` : ''}）。`,
    );
  }
  if (!res.ok) {
    const detail = json?.errorCode ?? json?.errorMessage ?? text.slice(0, 200);
    // 4xx 里的 INVALID_REFRESH_REQUEST 属于「refresh token 无效」，归为不可重试
    if (res.status >= 400 && res.status < 500) {
      throw new QwenAuthError(
        ErrorCode.REFRESH_REJECTED,
        `续期请求被拒绝（HTTP ${res.status}）：${detail}`,
      );
    }
    throw new QwenAuthError(
      ErrorCode.REFRESH_NETWORK,
      `续期请求失败（HTTP ${res.status}）：${detail}`,
      { retryable: true },
    );
  }
  if (!json) {
    throw new QwenAuthError(ErrorCode.REFRESH_REJECTED, '续期响应不是合法 JSON。');
  }
  return parseRefreshResponse(json);
}

// ---------------------------------------------------------------------------
// 回写
// ---------------------------------------------------------------------------

/**
 * 把刷新结果回写进原凭据文件（保持 v10 加密，原子替换）。
 *
 * 关键点：服务端会轮换 refresh_token，若不回写，App 与本插件会各自持有
 * 不同代际的 refresh token，导致后续刷新互相失效。
 *
 * @param {object} creds loadCredentials() 的返回值
 * @param {Buffer} masterKey 32 字节主密钥
 * @param {{ token: string, refreshToken: string|null, expiresAt: Date|null }} refreshed
 * @returns {{ written: boolean, reason?: string, file?: string }}
 */
export function persistRefreshedCredentials(creds, masterKey, refreshed, opts = {}) {
  const file = creds.sourceFile;
  if (!file) return { written: false, reason: 'no-source-file' };
  if (opts.dryRun) return { written: false, reason: 'dry-run' };
  if (!masterKey || masterKey.length !== 32) {
    return { written: false, reason: `invalid-master-key(len=${masterKey?.length ?? 0})` };
  }

  let original;
  try {
    original = JSON.parse(readDecryptedRaw(file, masterKey));
  } catch (e) {
    return { written: false, reason: `re-read-failed: ${e.message}` };
  }

  // 只改动 token 相关字段，其余（user/identityVersion/...）原样保留
  original.token = refreshed.token;
  if (refreshed.refreshToken) original.refreshToken = refreshed.refreshToken;
  if (refreshed.expiresAt) original.expiresAt = refreshed.expiresAt.toISOString();
  if (refreshed.refreshTokenExpiresAt) {
    original.refreshTokenExpiresAt = refreshed.refreshTokenExpiresAt.toISOString();
  }

  const payload = encryptV10(JSON.stringify(original), masterKey);
  const tmp = `${file}.dsh-qwen-connect.tmp`;
  try {
    fs.writeFileSync(tmp, payload, { mode: 0o600 });
    fs.renameSync(tmp, file); // 同目录原子替换
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    return { written: false, reason: `write-failed: ${e.message}` };
  }
  return { written: true, file };
}

function readDecryptedRaw(file, masterKey) {
  return decryptV10(fs.readFileSync(file), masterKey);
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

/**
 * 返回一个当前有效的 token：未过期直接返回，过期则刷新。
 *
 * @param {{ appDataDir?: string, forceRefresh?: boolean, now?: number, skewMs?: number,
 *           baseUrl?: string, fetchImpl?: typeof fetch, onRefresh?: Function,
 *           persist?: boolean }} [opts]
 * @returns {Promise<{ token: string, credentials: object, refreshed: boolean, warning?: string }>}
 */
export async function getValidToken(opts = {}) {
  const creds = opts.credentials ?? loadCredentials({ appDataDir: opts.appDataDir });
  const now = opts.now ?? Date.now();

  const expired = opts.forceRefresh === true || isTokenExpired(creds, opts.skewMs ?? 60_000, now);
  if (!expired) {
    return { token: creds.token, credentials: creds, refreshed: false };
  }

  if (!creds.refreshToken) {
    throw new QwenAuthError(
      ErrorCode.TOKEN_EXPIRED_NO_REFRESH,
      `登录已过期（expiresAt=${creds.expiresAt?.toISOString() ?? 'unknown'}）且凭据中没有 refresh token。`,
    );
  }

  const refreshed = await requestTokenRefresh(creds.refreshToken, {
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });

  let warning;
  // 回写轮换后的 refresh token（默认开启；失败只警告不阻断本次调用）
  if (opts.persist !== false && creds.sourceFile) {
    const res = persistRefreshedCredentials(creds, creds.masterKey, refreshed, { dryRun: opts.dryRun });
    if (!res.written && !opts.dryRun) {
      warning = `续期成功但未能回写凭据文件（${res.reason}）；请重新打开 QwenWorkCN 以同步登录态。`;
    }
  }

  const next = {
    ...creds,
    token: refreshed.token,
    refreshToken: refreshed.refreshToken ?? creds.refreshToken,
    expiresAt: refreshed.expiresAt ?? creds.expiresAt,
    sourceFile: creds.sourceFile,
  };

  if (typeof opts.onRefresh === 'function') {
    opts.onRefresh(next, refreshed);
  }

  return { token: next.token, credentials: next, refreshed: true, warning };
}
