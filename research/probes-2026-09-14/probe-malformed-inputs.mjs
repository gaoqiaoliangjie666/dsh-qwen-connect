// research/probes-2026-09-14/probe-malformed-inputs.mjs
// 畸形输入健壮性：各种非法/边界 JSON 结构都不得让 shim 崩溃或挂起。
import { createChatShimHandler } from '../../lib/chat-shim.js';
import http from 'node:http';

// 用一个假的 handler（不发真实上游）来测「输入校验层」
const handler = createChatShimHandler({
  getCredential: async () => ({ token: 't', user: { id: 'u' }, loginDeviceId: 'd' }),
  endpoint: 'http://127.0.0.1:1/never',
  sharedSecret: 'sec',
  signerFactory: async () => {
    throw new Error('should not reach signer for invalid input');
  },
});

const server = http.createServer((req, res) => {
  if (!req.url?.startsWith('/v1/chat/completions')) {
    res.writeHead(404).end('{}');
    return;
  }
  handler(req, res).catch(() => {});
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;

let fail = 0;
async function send(label, rawBody, expect) {
  try {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sec' },
      body: rawBody,
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    const ok = expect === null || res.status === expect;
    console.log(`  ${ok ? '✅' : '❌'} ${label.padEnd(28)} → ${res.status}${ok ? '' : ` (期望 ${expect})`}`);
    if (!ok) fail++;
    return text;
  } catch (e) {
    console.log(`  ❌ ${label.padEnd(28)} → 异常 ${e.message.slice(0, 60)}`);
    fail++;
    return '';
  }
}

console.log('=== 畸形 JSON 与结构 ===');
await send('非法 JSON', 'not json at all', 400);
await send('空 body', '', 400);
await send('JSON 是数组', '[1,2,3]', 400);
await send('JSON 是字符串', '"hello"', 400);
await send('JSON 是 null', 'null', 400);
await send('messages 是字符串', JSON.stringify({ model: 'pro', messages: 'x' }), 400);
await send('messages 是对象', JSON.stringify({ model: 'pro', messages: {} }), 400);
await send('messages 含数字', JSON.stringify({ model: 'pro', messages: [1, 2] }), 400);
await send('messages 全为 null', JSON.stringify({ model: 'pro', messages: [null] }), 400);
await send('content 是数字', JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: 123 }] }), 400);
await send('content 是 null', JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: null }] }), 400);
await send('content 数组全非法', JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: [{ type: 'wat' }] }] }), 400);
await send('role 是数字', JSON.stringify({ model: 'pro', messages: [{ role: 7, content: 'hi' }] }), null); // 应容错为 user
await send('tools 是字符串', JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: 'hi' }], tools: 'x' }), null);
await send('tools 含 null', JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: 'hi' }], tools: [null] }), null);
await send('model 是数字', JSON.stringify({ model: 42, messages: [{ role: 'user', content: 'hi' }] }), null);
await send('超深嵌套 content', JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(10000) }] }] }), null);

console.log('\n=== 大 payload（不得 OOM / 挂起）===');
await send('1MB content', JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: 'x'.repeat(1_000_000) }] }), null);

server.close();
console.log(fail === 0 ? '\n✅ 畸形输入全部被安全处理' : `\n❌ ${fail} 项未按预期处理`);
process.exit(fail > 0 ? 1 : 0);
