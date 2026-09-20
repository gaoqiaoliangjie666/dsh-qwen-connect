// tools/usage-e2e.mjs
// 验证 shim 是否把上游的 token 统计（raw_usage）转成 OpenAI usage 下发。
import { startChatShim } from '../lib/chat-shim.js';
import { loadCredentials } from '../lib/credentials.js';
import { DEFAULT_ENDPOINT } from '../lib/signer-session.js';

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
    messages: [{ role: 'user', content: '只回复两个字：好的' }],
  }),
});

const decoder = new TextDecoder('utf-8');
let buf = '';
let usage = null;
let finish = null;
let content = '';
let frames = 0;

for await (const chunk of res.body) {
  buf += decoder.decode(chunk, { stream: true });
  const evs = buf.split('\n\n');
  buf = evs.pop() ?? '';
  for (const e of evs) {
    if (!e.startsWith('data:')) continue;
    const p = e.slice(5).trim();
    if (!p || p === '[DONE]') continue;
    frames++;
    try {
      const o = JSON.parse(p);
      const ch = o.choices?.[0];
      if (ch?.delta?.content) content += ch.delta.content;
      if (ch?.finish_reason) finish = ch.finish_reason;
      if (o.usage) usage = o.usage;
    } catch {}
  }
}
buf += decoder.decode();

console.log(`HTTP ${res.status} | ${Date.now() - t0} ms | ${frames} 帧`);
console.log(`正文: ${JSON.stringify(content.slice(0, 60))}`);
console.log(`finish_reason: ${finish}`);
console.log('');
if (usage === null) {
  console.log('❌ 未收到 usage —— DSH 界面不会有 token 统计');
  await shim.close();
  process.exit(1);
}
console.log('✅ 收到 usage:');
console.log('   prompt_tokens     =', usage.prompt_tokens);
console.log('   completion_tokens =', usage.completion_tokens);
console.log('   total_tokens      =', usage.total_tokens);
if (usage.prompt_tokens_details) {
  console.log('   cached_tokens     =', usage.prompt_tokens_details.cached_tokens);
}
await shim.close();
process.exit(0);
