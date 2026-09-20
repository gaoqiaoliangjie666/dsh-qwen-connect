// tools/diag-encoded.mjs
// 直接看 shim 转出来给 DSH（pi-ai）的 OpenAI 格式流是什么样。
import { startChatShim } from '../lib/chat-shim.js';
import { loadCredentials } from '../lib/credentials.js';
import { DEFAULT_ENDPOINT } from '../lib/signer-session.js';

const cred = await loadCredentials();
const shim = await startChatShim({
  getCredential: async () => loadCredentials(),
  endpoint: DEFAULT_ENDPOINT,
});

const t0 = Date.now();
const res = await fetch(shim.baseUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.sharedSecret}` },
  body: JSON.stringify({
    model: 'pro',
    stream: true,
    messages: [{ role: 'user', content: '用一句话介绍下自己' }],
  }),
});

const decoder = new TextDecoder('utf-8');
let buf = '';
let content = '';
let reasoningContent = '';
let chunkCount = 0;

for await (const chunk of res.body) {
  buf += decoder.decode(chunk, { stream: true });
  const events = buf.split('\n\n');
  buf = events.pop() ?? '';
  for (const e of events) {
    if (!e.startsWith('data:')) continue;
    const p = e.slice(5).trim();
    if (!p || p === '[DONE]') continue;
    chunkCount++;
    try {
      const obj = JSON.parse(p);
      const delta = obj.choices?.[0]?.delta ?? {};
      if (delta.content) content += delta.content;
      if (delta.reasoning_content) reasoningContent += delta.reasoning_content;
    } catch {}
  }
}
buf += decoder.decode();

console.log(`\n=== ${Date.now() - t0} ms | ${chunkCount} chunks ===`);
console.log('\n[下游 delta.content]            ' + content.length + ' 字符:');
console.log('  ' + JSON.stringify(content));
console.log('\n[下游 delta.reasoning_content]  ' + reasoningContent.length + ' 字符:');
console.log('  ' + JSON.stringify(reasoningContent.slice(0, 200)) + (reasoningContent.length > 200 ? '…' : ''));

await shim.close();
