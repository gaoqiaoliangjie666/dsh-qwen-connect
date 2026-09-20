// tools/diag-content.mjs
// 只提取 delta.content 通道（忽略 reasoning），拼成完整正文。
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
let reasoning = '';
let reasoningChunks = 0;
let contentChunks = 0;
let finish = null;

for await (const chunk of res.body) {
  buf += decoder.decode(chunk, { stream: true });
  const events = buf.split('\n\n');
  buf = events.pop() ?? '';
  for (const e of events) {
    if (!e.startsWith('data:')) continue;
    const p = e.slice(5).trim();
    if (!p || p === '[DONE]') continue;
    try {
      const obj = JSON.parse(p);
      const delta = obj.choices?.[0]?.delta ?? {};
      if (delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        reasoningChunks++;
      }
      if (delta.content) {
        content += delta.content;
        contentChunks++;
      }
      const fr = obj.choices?.[0]?.finish_reason;
      if (fr) finish = fr;
    } catch {}
  }
}
buf += decoder.decode();

console.log(`\n=== ${Date.now() - t0} ms ===`);
console.log(`\n[delta.content 通道] ${contentChunks} 个 chunk, ${content.length} 字符:`);
console.log('  ' + JSON.stringify(content));
console.log(`\n[delta.reasoning_content 通道] ${reasoningChunks} 个 chunk, ${reasoning.length} 字符`);
console.log(`\n[finish_reason] ${finish}`);

await shim.close();
