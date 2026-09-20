// research/probes-2026-09-14/probe-security-boundary.mjs
// 安全边界排查：环回校验、密钥鉴别、凭据泄漏、路径穿越、错误信息脱敏。
import http from 'node:http';
import net from 'node:net';

import { startChatShim } from '../../lib/chat-shim.js';
import { loadCredentials } from '../../lib/credentials.js';
import { DEFAULT_ENDPOINT } from '../../lib/signer-session.js';
import { loopbackRequest } from '../../lib/loopback.js';

const shim = await startChatShim({
  getCredential: async () => loadCredentials(),
  endpoint: DEFAULT_ENDPOINT,
});

/** 用裸 socket 发原始请求（fetch 会丢弃 Host 头）。 */
function raw(port, lines) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    let out = '';
    sock.on('data', (d) => (out += d));
    sock.on('end', () => resolve(out));
    sock.on('error', (e) => resolve('ERR ' + e.message));
    sock.write(lines.join('\r\n'));
    setTimeout(() => { sock.destroy(); resolve(out || 'TIMEOUT'); }, 4000);
  });
}

console.log('=== 1) 环回校验（裸 socket，fetch 无法伪造 Host）===');
const body = JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: 'hi' }] });
for (const [label, host] of [['外部域名', 'evil.example.com'], ['内网地址', '192.168.1.5'], ['环回', `127.0.0.1:${shim.port}`]]) {
  const r = await raw(shim.port, [
    'POST /v1/chat/completions HTTP/1.1',
    `Host: ${host}`,
    'Content-Type: application/json',
    `Authorization: Bearer ${shim.sharedSecret}`,
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Connection: close', '', body,
  ]);
  const status = (r.match(/^HTTP\/1\.1 (\d+)/) || [])[1] ?? '?';
  const expect = label === '环回' ? '200' : '403';
  console.log(`  ${status === expect ? '✅' : '❌'} ${label.padEnd(8)} → ${status} (期望 ${expect})`);
}

console.log('\n=== 2) 密钥鉴别 ===');
for (const [label, auth] of [
  ['无密钥', null],
  ['错误密钥', 'Bearer wrong'],
  ['空 Bearer', 'Bearer '],
  ['正确密钥', `Bearer ${shim.sharedSecret}`],
]) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth !== null) headers.Authorization = auth;
  const res = await fetch(shim.baseUrl, { method: 'POST', headers, body });
  const expect = label === '正确密钥' ? 200 : 401;
  console.log(`  ${res.status === expect ? '✅' : '❌'} ${label.padEnd(8)} → ${res.status} (期望 ${expect})`);
}

console.log('\n=== 3) Origin 校验 ===');
for (const [label, origin] of [['外部 Origin', 'http://evil.example.com'], ['环回 Origin', 'http://127.0.0.1:3000']]) {
  const res = await fetch(shim.baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.sharedSecret}`, Origin: origin },
    body,
  });
  const expect = label === '环回 Origin' ? 200 : 403;
  console.log(`  ${res.status === expect ? '✅' : '❌'} ${label.padEnd(12)} → ${res.status} (期望 ${expect})`);
}

console.log('\n=== 4) 响应体不得含凭据 ===');
const res = await fetch(shim.baseUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.sharedSecret}` },
  body,
});
const text = await res.text();
for (const needle of ['COSY.', 'eyJ', 'Bearer', 'refreshToken', 'accessToken', 'password']) {
  console.log(`  ${text.includes(needle) ? '❌ 泄漏' : '✅ 无'} ${needle}`);
}
// 密钥本身绝不能出现在响应里
console.log(`  ${text.includes(shim.sharedSecret) ? '❌ 共享密钥泄漏到响应体！' : '✅ 共享密钥未出现在响应'}`);

console.log('\n=== 5) 路径穿越 / 非法路径 ===');
for (const p of ['/v1/chat/completions/../secret', '/../../../etc/passwd', '/v1/chat/completions']) {
  const r = await fetch(`http://127.0.0.1:${shim.port}${p}`, { method: 'POST' });
  console.log(`  ${r.status} ${p}`);
}

console.log('\n=== 6) 监听地址 ===');
const addr = shim.baseUrl.match(/http:\/\/([^:]+):/)?.[1];
console.log(`  ${addr === '127.0.0.1' ? '✅' : '❌'} 仅绑定环回: ${addr}`);

await shim.close();
process.exit(0);
