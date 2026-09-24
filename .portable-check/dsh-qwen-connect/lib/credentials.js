/**
 * 凭据解密与加载。
 *
 * 加密格式（Chromium v10，Windows）：
 *   [0..3)    ASCII "v10"
 *   [3..15)   12 字节 AES-GCM nonce
 *   [15..n-16) 密文
 *   [n-16..n) 16 字节 GCM auth tag
 *
 * 主密钥来自 `Local State` 的 os_crypt.encrypted_key（DPAPI 保护）。
 *
 * 安全约束：解密结果只在内存中持有；任何日志/错误信息都不得包含 token 明文。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { QwenAuthError, ErrorCode } from './errors.js';
import { unprotectMasterKey } from './dpapi.js';

export const AUTH_V2_FILE = 'auth-v2.dat';
export const AUTH_V1_FILE = 'auth.dat';
export const LOCAL_STATE_FILE = 'Local State';

const V10_PREFIX = Buffer.from('v10', 'ascii');
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const MIN_PAYLOAD = NONCE_LENGTH + TAG_LENGTH; // 允许空明文：密文长度可以为 0

/** 默认凭据目录：%APPDATA%\QwenWorkCN */
export function defaultAppDataDir(env = process.env) {
  const roaming = env.APPDATA || (env.USERPROFILE ? path.join(env.USERPROFILE, 'AppData', 'Roaming') : null);
  if (!roaming) {
    throw new QwenAuthError(ErrorCode.CREDENTIALS_MISSING, '无法确定 %APPDATA% 路径。');
  }
  return path.join(roaming, 'QwenWorkCN');
}

// ---------------------------------------------------------------------------
// 纯函数：AES-256-GCM 解密
// ---------------------------------------------------------------------------

/**
 * 解析 Chromium v10 载荷结构（不涉及密钥，便于单测）。
 * @param {Buffer} raw
 * @returns {{ nonce: Buffer, ciphertext: Buffer, tag: Buffer }}
 */
export function parseV10Payload(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < V10_PREFIX.length + MIN_PAYLOAD) {
    throw new QwenAuthError(
      ErrorCode.CREDENTIALS_MALFORMED,
      `凭据文件过短（${raw?.length ?? 0} 字节），不是合法的 v10 载荷。`,
    );
  }
  const prefix = raw.subarray(0, 3);
  if (!prefix.equals(V10_PREFIX)) {
    const shown = prefix.toString('latin1').replace(/[^\x20-\x7e]/g, '.');
    throw new QwenAuthError(
      ErrorCode.CREDENTIALS_MALFORMED,
      `凭据前缀不是 "v10"（实际为 "${shown}"）。当前仅支持 Chromium v10 格式。`,
    );
  }
  return {
    nonce: raw.subarray(3, 3 + NONCE_LENGTH),
    ciphertext: raw.subarray(3 + NONCE_LENGTH, raw.length - TAG_LENGTH),
    tag: raw.subarray(raw.length - TAG_LENGTH),
  };
}

/**
 * 用 AES-256-GCM 解出明文（纯函数，便于单测）。
 * @param {Buffer} raw 含 v10 前缀的完整载荷
 * @param {Buffer} masterKey 32 字节主密钥
 * @returns {string} UTF-8 明文
 */
export function decryptV10(raw, masterKey) {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) {
    throw new QwenAuthError(
      ErrorCode.DECRYPT_FAILED,
      `主密钥长度必须为 32 字节（实际 ${masterKey?.length ?? 0}）。`,
    );
  }
  const { nonce, ciphertext, tag } = parseV10Payload(raw);
  let decipher;
  try {
    decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, nonce, { authTagLength: TAG_LENGTH });
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return out.toString('utf8');
  } catch (e) {
    throw new QwenAuthError(
      ErrorCode.DECRYPT_FAILED,
      `AES-GCM 解密失败（GCM 认证标签校验不通过或主密钥不匹配）：${e.message}`,
      { cause: e },
    );
  }
}

/**
 * 按 Chromium v10 格式加密（供测试构造 fixture 与回写使用）。
 * @param {string} plaintext
 * @param {Buffer} masterKey
 * @returns {Buffer} 含 v10 前缀的完整载荷
 */
export function encryptV10(plaintext, masterKey, nonce = crypto.randomBytes(NONCE_LENGTH)) {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) {
    throw new Error('encryptV10: masterKey 必须为 32 字节');
  }
  if (nonce.length !== NONCE_LENGTH) {
    throw new Error(`encryptV10: nonce 必须为 ${NONCE_LENGTH} 字节`);
  }
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, nonce, { authTagLength: TAG_LENGTH });
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return Buffer.concat([V10_PREFIX, nonce, body, cipher.getAuthTag()]);
}

// ---------------------------------------------------------------------------
// 文件级读取
// ---------------------------------------------------------------------------

function readLocalState(dir) {
  const p = path.join(dir, LOCAL_STATE_FILE);
  if (!fs.existsSync(p)) {
    throw new QwenAuthError(ErrorCode.CREDENTIALS_MISSING, `未找到 Local State 文件：${p}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new QwenAuthError(ErrorCode.CREDENTIALS_MALFORMED, `Local State 不是合法 JSON：${e.message}`, { cause: e });
  }
  const key = parsed?.os_crypt?.encrypted_key;
  if (!key) {
    throw new QwenAuthError(
      ErrorCode.CREDENTIALS_MALFORMED,
      'Local State 中不存在 os_crypt.encrypted_key（该环境可能未启用 Chromium 加密存储）。',
    );
  }
  return key;
}

/**
 * 读取并解密指定凭据文件。
 * @param {string} file 完整路径
 * @param {Buffer} masterKey
 * @returns {object} 解析后的 JSON
 */
export function decryptCredentialsFile(file, masterKey) {
  if (!fs.existsSync(file)) {
    throw new QwenAuthError(ErrorCode.CREDENTIALS_MISSING, `未找到凭据文件：${file}`);
  }
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch (e) {
    throw new QwenAuthError(ErrorCode.CREDENTIALS_MISSING, `无法读取凭据文件：${e.message}`, { cause: e });
  }
  const text = decryptV10(raw, masterKey);
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    // 绝不把 text 打进错误信息
    throw new QwenAuthError(
      ErrorCode.SCHEMA_INVALID,
      `凭据解密后的内容不是合法 JSON（长度 ${text.length} 字符）。`,
      { cause: e },
    );
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new QwenAuthError(ErrorCode.SCHEMA_INVALID, '凭据 JSON 顶层不是对象。');
  }
  return json;
}

// ---------------------------------------------------------------------------
// 规范化
// ---------------------------------------------------------------------------

/**
 * 把 auth-v2 / auth-v1 两种结构统一成内部凭据对象。
 * @param {object} raw 解密后的原始 JSON
 * @param {{ source: string }} meta
 */
export function normalizeCredentials(raw, meta = {}) {
  const token = typeof raw.token === 'string' && raw.token.length > 0 ? raw.token : '';
  const refreshToken = typeof raw.refreshToken === 'string' && raw.refreshToken.length > 0 ? raw.refreshToken : '';
  if (!token) {
    throw new QwenAuthError(ErrorCode.SCHEMA_INVALID, '凭据中缺少 token 字段。');
  }

  const expiresAt = parseDate(raw.expiresAt);
  const refreshTokenExpiresAt = parseDate(raw.refreshTokenExpiresAt);

  return {
    schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 1,
    token,
    refreshToken,
    expiresAt,
    refreshTokenExpiresAt,
    user: normalizeUser(raw.user),
    identityVersion: raw.identityVersion ?? 0,
    loginMethod: raw.loginMethod ?? null,
    refreshStrategy: raw.refreshStrategy ?? null,
    loginDeviceId: raw.loginDeviceId ?? null,
    loginTimestamp: raw.loginTimestamp ?? null,
    source: meta.source ?? null,
    sourceFile: meta.sourceFile ?? null,
    appDataDir: meta.appDataDir ?? null,
    // 回写加密凭据所需的 AES 主密钥；只驻留内存，绝不序列化到日志/配置
    masterKey: Buffer.isBuffer(meta.masterKey) ? meta.masterKey : null,
  };
}

function normalizeUser(u) {
  if (!u || typeof u !== 'object') return null;
  return {
    id: u.id ?? null,
    name: u.name ?? null,
    username: u.username ?? null,
    email: u.email ?? null,
    tier: u.tier ?? null,
    planName: u.planName ?? null,
    planId: u.planId ?? null,
    isBiz: u.isBiz ?? false,
  };
}

function parseDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

/**
 * 解密并加载凭据（核心同步实现）。
 *
 * 优先读 auth-v2.dat（schemaVersion 2，当前版本），失败或不存在时回退 auth.dat。
 *
 * @param {{ appDataDir?: string, env?: NodeJS.ProcessEnv, prefer?: 'v2'|'v1' }} [opts]
 * @returns {object} 规范化凭据对象
 */
/**
 * 加载凭据：同步返回规范化对象，同时该对象也是 thenable，
 * 因此 `loadCredentials()` 与 `loadCredentials().then(...)` 两种写法都成立
 * （t1 契约的 verify 命令使用后者）。
 *
 * 失败时同步抛出带 `code` 的 QwenAuthError。
 */
export function loadCredentials(opts = {}) {
  return toThenable(loadCredentialsSync(opts));
}

/**
 * 把同步返回值包成「字段可直读、同时可 .then()」的对象。
 */
export function toThenable(value) {
  return Object.assign(Object.create(null), value, {
    then: (onFulfilled, onRejected) => Promise.resolve(value).then(onFulfilled, onRejected),
    catch: (onRejected) => Promise.resolve(value).catch(onRejected),
    finally: (handler) => Promise.resolve(value).finally(handler),
  });
}

/**
 * 纯同步实现（内部使用；对外统一走 thenable 包装的 loadCredentials）。
 * @param {{ appDataDir?: string, env?: NodeJS.ProcessEnv, prefer?: 'v2'|'v1' }} [opts]
 * @returns {object} 规范化凭据对象
 */
function loadCredentialsSync(opts = {}) {
  const dir = opts.appDataDir ?? defaultAppDataDir(opts.env);
  const encryptedKey = readLocalState(dir);
  const masterKey = unprotectMasterKey(encryptedKey); // 失败直接抛带提示的错误

  const order = opts.prefer === 'v1'
    ? [AUTH_V1_FILE, AUTH_V2_FILE]
    : [AUTH_V2_FILE, AUTH_V1_FILE];

  /** @type {QwenAuthError[]} */
  const failures = [];
  for (const name of order) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) {
      failures.push(new QwenAuthError(ErrorCode.CREDENTIALS_MISSING, `未找到凭据文件：${file}`));
      continue;
    }
    try {
      const raw = decryptCredentialsFile(file, masterKey);
      return normalizeCredentials(raw, {
        source: name === AUTH_V2_FILE ? 'auth-v2' : 'auth-v1',
        sourceFile: file,
        appDataDir: dir,
        masterKey,
      });
    } catch (e) {
      failures.push(e);
    }
  }

  // 全部候选都失败：优先抛出 ScheMA/解密类错误（比"文件不存在"更有诊断价值）
  const meaningful = failures.find(
    (e) => e.code !== ErrorCode.CREDENTIALS_MISSING,
  );
  throw meaningful ?? failures[0] ?? new QwenAuthError(ErrorCode.CREDENTIALS_MISSING, `凭据目录 ${dir} 下没有可用凭据文件。`);
}

/**
 * 探测凭据是否就绪（不抛异常的版本，适合设置卡片首次渲染）。
 * @returns {{ ok: true, credentials: object } | { ok: false, error: object }}
 */
export function probeCredentials(opts = {}) {
  try {
    return { ok: true, credentials: loadCredentials(opts) };
  } catch (e) {
    if (e instanceof QwenAuthError) {
      return { ok: false, error: e.toJSON() };
    }
    return {
      ok: false,
      error: { code: 'UNKNOWN', message: String(e?.message ?? e), recovery: '', retryable: false },
    };
  }
}

/**
 * 判断 token 是否已过期（带提前量，默认 60s，避免边界请求失败）。
 */
export function isTokenExpired(creds, skewMs = 60_000, now = Date.now()) {
  if (!creds?.expiresAt) return false; // 无过期信息时不主动刷新
  return creds.expiresAt.getTime() - skewMs <= now;
}

/** 生成不含任何敏感值的摘要，供日志使用 */
export function describeCredentials(creds) {
  return {
    source: creds.source,
    sourceFile: creds.sourceFile,
    schemaVersion: creds.schemaVersion,
    hasToken: Boolean(creds.token),
    tokenLength: creds.token?.length ?? 0,
    hasRefreshToken: Boolean(creds.refreshToken),
    expiresAt: creds.expiresAt?.toISOString() ?? null,
    refreshTokenExpiresAt: creds.refreshTokenExpiresAt?.toISOString() ?? null,
    loginDeviceIdPresent: Boolean(creds.loginDeviceId),
    refreshStrategy: creds.refreshStrategy,
    user: creds.user ? { id: maskId(creds.user.id), name: creds.user.name, tier: creds.user.tier, planId: creds.user.planId } : null,
  };
}

function maskId(id) {
  if (typeof id !== 'string' || id.length <= 8) return id ?? null;
  return `${id.slice(0, 8)}...`;
}
