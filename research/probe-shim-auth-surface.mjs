// 为 t7（chat shim 请求方鉴别）做前置调研：确认当前暴露面与可行的鉴别手段
// 只读分析，不发真实请求。
import http from 'node:http';
import crypto from 'node:crypto';
import { startChatShim } from '../lib/signer-shim.js';

console.log('=== 1) 当前 shim 的暴露面 ===');
const shim = await startChatShim({
  getCredential: async () => { throw new Error('credentials unavailable in probe'); },
});
console.log('监听地址:', shim.baseUrl);

// 无任何凭据头时能否到达业务逻辑（应能 —— 说明 Host/Origin 是唯一门槛）
const r1 = await fetch(shim.baseUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
});
console.log('无凭据头 ->', r1.status, (await r1.text()).slice(0, 80));

// 带任意 Bearer 呢？
const r2 = await fetch(shim.baseUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer anything' },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
});
console.log('任意 Bearer ->', r2.status, (await r2.text()).slice(0, 80));

// 非环回 Origin
const r3 = await fetch(shim.baseUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example.com' },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
});
console.log('非环回 Origin ->', r3.status, '(预期 403)');

await shim.close();

console.log('\n=== 2) 常量时间比较的可行性 ===');
// 本机 Node 是否支持 timingSafeEqual（t7 需要）
const a = Buffer.from('abcdef', 'utf8');
const b = Buffer.from('abcdef', 'utf8');
const c = Buffer.from('abcdeg', 'utf8');
console.log('timingSafeEqual 可用:', typeof crypto.timingSafeEqual === 'function');
console.log('相等:', crypto.timingSafeEqual(a, b));
console.log('不等:', crypto.timingSafeEqual(a, c));
// 长度不同会抛异常 —— t7 必须先比长度或用摘要
try {
  crypto.timingSafeEqual(a, Buffer.from('abc', 'utf8'));
} catch (e) {
  console.log('长度不等时抛:', e.code ?? e.message);
}
console.log('→ 结论：比较前必须对齐长度（或用 HMAC 摘要再比），否则长度不同会抛错');

console.log('\n=== 3) 随机 token 生成 ===');
console.log('randomBytes(32).base64url 长度:', crypto.randomBytes(32).toString('base64url').length);
console.log('randomUUID 可用:', typeof crypto.randomUUID === 'function');
