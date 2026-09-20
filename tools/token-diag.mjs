/**
 * 诊断：凭据的**形态**——长度、字符集、是否 JWT、是否过期。
 *
 * ⚠️ 安全约束（不可退让）：
 *   本脚本**绝不**输出任何凭据可识别片段。具体禁止：
 *     - token / refreshToken 的前缀或后缀（前缀本身即敏感，可用于关联账号）
 *     - loginDeviceId 的前缀或完整值
 *     - expiresAt 的**具体值**（只报「是否已过期」与剩余天数档位）
 *     - masterKey 的任何内容（只报长度）
 *   允许输出的只有：长度、布尔判定、字符集分类、键名。
 *
 *   历史教训：本脚本早期版本会打印 `prefix=<前12字符>`，并被我用 PowerShell
 *   `>` 重定向落盘成 `_diag-out.txt`，导致 token/refreshToken/loginDeviceId
 *   前缀与 expiresAt 具体值落在交付物目录里，被 captain 检出。现已双重修复：
 *   脚本不再输出片段，且不再以重定向方式写文件。
 *
 * 输出一律走 stdout，不落盘。
 *
 * 用法：node tools/token-diag.mjs
 */

import * as creds from '../lib/credentials.js';
import * as auth from '../lib/auth.js';

const line = (s) => process.stdout.write(`${s}\n`);

/**
 * 只描述形态，不泄漏内容。
 *
 * @param {unknown} v
 */
const shape = (v) => {
  if (typeof v !== 'string') return `(非字符串: ${typeof v})`;
  if (v === '') return '(空字符串)';
  const isJwt = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(v);
  const charset = /^[A-Za-z0-9_-]+$/u.test(v)
    ? 'base64url-like'
    : /^[0-9a-f-]+$/iu.test(v)
      ? 'hex-with-dashes'
      : 'mixed';
  return `len=${v.length} isJwt=${isJwt} charset=${charset}`;
};

/** 只报「是否过期 / 剩余天数档位」，不报具体时间。 */
const expiryShape = (value) => {
  if (value === null || value === undefined) return '(缺失)';
  const ms = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(ms)) return '(不可解析)';
  const deltaMs = ms - Date.now();
  if (deltaMs <= 0) return '已过期';
  const days = deltaMs / 86_400_000;
  if (days < 1) return '剩余 <1 天';
  if (days < 8) return '剩余 1-7 天';
  if (days < 31) return '剩余 8-30 天';
  return '剩余 >30 天';
};

/** 键名本身是安全的；值一律走 shape()。 */
const SHAPE_KEYS = [
  'token',
  'refreshToken',
  'accessToken',
  'access_token',
  'refresh_token',
  'idToken',
  'loginDeviceId',
  'loginMethod',
  'refreshStrategy',
  'source',
];

let c;
try {
  c = creds.loadCredentials();
  line('loadCredentials: OK');
} catch (error) {
  line(`loadCredentials ERR [${error?.code ?? error?.name}]: ${error?.message}`);
  if (error?.recovery) line(`  recovery: ${error.recovery}`);
  process.exit(0);
}

line('--- 凭据形态（不含任何片段）---');
line(`顶层键: ${JSON.stringify(Object.keys(c))}`);

for (const key of SHAPE_KEYS) {
  if (c[key] !== undefined) line(`  ${key}: ${shape(c[key])}`);
}
if (c.user !== undefined && c.user !== null) {
  line(`  user.id 存在: ${c.user.id !== undefined && c.user.id !== null}`);
  line(`  user.name 存在: ${c.user.name !== undefined && c.user.name !== null}`);
}
if (c.masterKey !== undefined) {
  line(`  masterKey 长度: ${c.masterKey?.length ?? '(非可测)'}（内容不输出）`);
}
line(`  expiresAt: ${expiryShape(c.expiresAt)}`);
line(`  refreshTokenExpiresAt: ${expiryShape(c.refreshTokenExpiresAt)}`);
line(`  isTokenExpired: ${creds.isTokenExpired(c)}`);

// --- getValidToken 的返回形态 ---
try {
  const returned = await auth.getValidToken();
  line('--- getValidToken() 返回形态 ---');
  line(`  返回类型: ${typeof returned}`);
  const token = typeof returned === 'string' ? returned : returned?.token;
  line(`  取到 token: ${shape(token)}`);
  if (token !== undefined && typeof token === 'string' && /^eyJ/u.test(token)) {
    try {
      const payload = JSON.parse(
        Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
      );
      line(`  JWT payload 键: ${JSON.stringify(Object.keys(payload))}`);
      line(`  exp: ${expiryShape(payload.exp === undefined ? null : payload.exp * 1000)}`);
    } catch {
      line('  JWT payload: 无法解析（非标准三段结构）');
    }
  }
} catch (error) {
  line(`auth.getValidToken ERR [${error?.code ?? error?.name}]: ${error?.message}`);
}

line('\n（本脚本只输出形态，不输出任何凭据片段；输出仅到 stdout，不落盘。）');
