// tools/diag-sse.mjs
// 诊断：完整打印真实 shim → Qwen 的 SSE 流（不做任何聚合/提取），
// 让你看到「几行字 + 一堆东西」具体是什么。
import { startChatShim } from '../lib/chat-shim.js';
import { loadCredentials } from '../lib/credentials.js';
import { DEFAULT_ENDPOINT } from '../lib/signer-session.js';

const cred = await loadCredentials();
const shim = await startChatShim({
  getCredential: async () => loadCredentials(),
  endpoint: DEFAULT_ENDPOINT,
  logger: { warn: (...a) => console.error('[warn]', ...a.map((x) => String(x).slice(0, 150))) },
});

console.log('=== 实际 shim 上行端口:', shim.port, '===\n');

const t0 = Date.now();
const res = await fetch(shim.baseUrl, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${shim.sharedSecret}`,
  },
  body: JSON.stringify({
    model: 'pro',
    stream: true,
    messages: [{ role: 'user', content: '用一句话介绍下自己' }],
  }),
});

console.log(`HTTP ${res.status} | ${Date.now() - t0} ms | content-type: ${res.headers.get('content-type')}\n`);

let i = 0;
const decoder = new TextDecoder('utf-8');
for await (const chunk of res.body) {
  const text = decoder.decode(chunk, { stream: true });
  console.log(`--- chunk #${i++} (${chunk.length} B) ---`);
  console.log(text);
  console.log('');
}
// flush
console.log(`--- flush ---`);
console.log(decoder.decode());
console.log(`=== 总计 ${i} 个 chunk, ${Date.now() - t0} ms ===`);
await shim.close();
