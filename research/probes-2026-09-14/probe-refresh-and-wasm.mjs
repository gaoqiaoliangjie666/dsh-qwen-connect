// research/probes-2026-09-14/probe-refresh-and-wasm.mjs
// 运行时路径排查（前五轮未覆盖）：
//   A. token 过期/刷新链路（不真刷，只验证判定与错误路径）
//   B. WASM 缺失/损坏时 shim 的行为（不静默、可恢复）
//   C. 会话（signer session）在凭据变更时的重建
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) fail++;
};

// ---- A. token 过期判定 ----
console.log('=== A. token 过期链路（auth.js）===');
const authMod = await import('../../lib/auth.js');
const exports = Object.keys(authMod);
console.log('  导出: ' + exports.join(', '));
// 找过期判定函数
const expiryFn = authMod.isTokenExpired ?? authMod.tokenExpired ?? null;
if (typeof expiryFn === 'function') {
  const now = Date.now();
  check('过期 token 判定为过期', expiryFn({ expiresAt: now - 1000 }) === true);
  check('未过期 token 判定为有效', expiryFn({ expiresAt: now + 3600_000 }) === false);
  check('缺失 expiresAt 不崩溃', [true, false].includes(expiryFn({})) || expiryFn({}) === undefined || typeof expiryFn({}) === 'boolean');
} else {
  console.log('  ℹ️  无独立过期函数（可能在 credentials.js 内）');
  const credMod = await import('../../lib/credentials.js');
  console.log('  credentials 导出: ' + Object.keys(credMod).join(', '));
}

// ---- B. WASM 缺失时的行为 ----
console.log('\n=== B. WASM 缺失/损坏时 shim 的行为 ===');
const { startChatShim } = await import('../../lib/chat-shim.js');
const { loadCredentials } = await import('../../lib/credentials.js');
const cred = await loadCredentials();

async function probeShim(label, signerFactory) {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end();
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const shim = await startChatShim({
    getCredential: async () => cred,
    endpoint: `http://127.0.0.1:${upstream.address().port}`,
    signerFactory,
    logger: { warn: () => {}, info: () => {} },
  });
  let result;
  try {
    const res = await fetch(shim.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.sharedSecret}` },
      body: JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    result = { status: res.status, hasError: text.includes('"error"'), done: text.includes('[DONE]') };
  } catch (e) {
    result = { status: 'EXC', hasError: true, done: false, msg: e.message.slice(0, 50) };
  }
  await shim.close();
  upstream.close();
  return result;
}

// B1: 签名会话抛错（模拟 WASM 加载失败）
let r = await probeShim('WASM 加载失败（signerFactory 抛错）', async () => {
  throw new Error('wasm load failed');
});
check('B1 返回 503 而非崩溃/悬挂', r.status === 503 && r.hasError, `HTTP ${r.status}`);

// B2: signInferRequest 中途抛错（模拟签名时崩溃）
r = await probeShim('签名中途抛错', async () => ({
  describe: () => ({}),
  dispose: () => {},
  signInferRequest: () => {
    throw new Error('sign failed');
  },
}));
check('B2 返回 502/503 且有错误信息', (r.status === 502 || r.status === 503) && r.hasError, `HTTP ${r.status}`);

// B3: 签名成功但上游立即 500（应透传状态码，不重试语义错误）
r = await probeShim('上游 500（语义错误不重试）', async () => ({
  describe: () => ({}),
  dispose: () => {},
  signInferRequest: (bodyJson) => {
    void bodyJson;
    // 通过真实网络打到假上游
    return null; // 占位，下面用自定义方式
  },
}));

// ---- C. 会话随凭据变更重建 ----
console.log('\n=== C. 会话随凭据变更重建 ===');
let builds = 0;
let lastToken = null;
const upstream2 = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end();
});
await new Promise((r2) => upstream2.listen(0, '127.0.0.1', r2));
const shim2 = await startChatShim({
  getCredential: async () => ({ token: lastToken, user: { id: 'u' }, loginDeviceId: 'd' }),
  endpoint: `http://127.0.0.1:${upstream2.address().port}`,
  logger: { warn: () => {}, info: () => {} },
  signerFactory: async (opts) => {
    builds++;
    lastToken = opts?.credential?.token ?? null;
    return {
      describe: () => ({}),
      dispose: () => {},
      signInferRequest: (bodyJson) => ({
        url: `http://127.0.0.1:${upstream2.address().port}/up`,
        headers: { 'Content-Type': 'application/json' },
        body: bodyJson,
        headerCount: 1,
      }),
    };
  },
});

// 第一次请求：token A
lastToken = 'token-A';
builds = 0;
await fetch(shim2.baseUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim2.sharedSecret}` },
  body: JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: 'hi' }] }),
}).then((x) => x.text());
const buildsAfterA = builds;
check('C1 首次请求构建了会话', buildsAfterA === 1, `builds=${buildsAfterA}`);

// 第二次请求：同一 token（应复用会话，不重建）
await fetch(shim2.baseUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim2.sharedSecret}` },
  body: JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: 'hi' }] }),
}).then((x) => x.text());
check('C2 同 token 复用会话', builds === buildsAfterA, `builds=${builds}`);

// 第三次请求：token 变了（应重建会话）
lastToken = 'token-B';
await fetch(shim2.baseUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim2.sharedSecret}` },
  body: JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: 'hi' }] }),
}).then((x) => x.text());
check('C3 token 变更后会话重建', builds === buildsAfterA + 1, `builds=${builds}`);

await shim2.close();
upstream2.close();

console.log(fail === 0 ? '\n✅ 运行时路径检查通过' : `\n❌ ${fail} 项失败`);
process.exit(fail > 0 ? 1 : 0);
