// 排查：reasoning 是否被错误混入 content
import { startChatShim } from '../lib/chat-shim.js';
import { loadCredentials } from '../lib/credentials.js';

const cred = loadCredentials();
const shim = await startChatShim({ getCredential: async () => cred });

const res = await fetch(shim.baseUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: '说"你好"' }] }),
});

let buf = '';
const decoder = new TextDecoder();
const seen = [];
for await (const c of res.body) {
  buf += decoder.decode(c, { stream: true });
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const p = line.slice(5).trim();
    if (p === '[DONE]') continue;
    try {
      const o = JSON.parse(p);
      const d = o.choices?.[0]?.delta;
      if (d && (d.content !== undefined || d.reasoning_content !== undefined)) {
        seen.push({ c: d.content, r: d.reasoning_content });
      }
    } catch { }
  }
}

console.log('总 delta 帧:', seen.length);
console.log('\n前 12 帧:');
for (const s of seen.slice(0, 12)) {
  console.log(`  content=${JSON.stringify(s.c)}  reasoning=${JSON.stringify(s.r)}`);
}
const withContent = seen.filter(s => s.c !== undefined);
const withReasoning = seen.filter(s => s.r !== undefined);
console.log(`\n含 content 的帧: ${withContent.length}, 含 reasoning_content 的帧: ${withReasoning.length}`);
console.log('content 拼接:', JSON.stringify(withContent.map(s => s.c).join('')));
console.log('reasoning 拼接:', JSON.stringify(withReasoning.map(s => s.r).join('').slice(0, 200)));

await shim.close();
