// 端到端验证：loopback shim 真实转发 + 多轮对话
import { startChatShim } from '../lib/chat-shim.js';
import { loadCredentials } from '../lib/credentials.js';

const cred = loadCredentials();
const shim = await startChatShim({
  getCredential: async () => cred,
  logger: { warn: (...a) => console.log('[shim warn]', ...a) },
});
console.log('shim listening:', shim.baseUrl);

async function chat(messages, label) {
  console.log(`\n===== ${label} =====`);
  const res = await fetch(shim.baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer dummy' },
    body: JSON.stringify({ model: 'pro', stream: true, messages }),
  });
  console.log('HTTP', res.status, res.headers.get('content-type'));
  if (!res.ok) { console.log(await res.text()); return null; }

  let text = '';
  let reasoning = '';
  let frames = 0;
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const p = line.slice(5).trim();
      if (p === '[DONE]') { console.log('  [DONE]'); continue; }
      try {
        const o = JSON.parse(p);
        if (o.error) { console.log('  error frame:', o.error.message); continue; }
        frames++;
        const d = o.choices?.[0]?.delta;
        if (d?.content) text += d.content;
        if (d?.reasoning_content) reasoning += d.reasoning_content;
      } catch { console.log('  bad frame:', p.slice(0, 80)); }
    }
  }
  console.log('frames:', frames, '| reasoning:', reasoning.slice(0, 60));
  console.log('answer:', text);
  return { text, reasoning };
}

// 第 1 轮
const r1 = await chat([{ role: 'user', content: '我叫小明。请只回答"好的"。' }], '第 1 轮');

// 第 2 轮：必须带完整历史才能引用第一轮
const r2 = await chat([
  { role: 'user', content: '我叫小明。请只回答"好的"。' },
  { role: 'assistant', content: r1?.text ?? '好的' },
  { role: 'user', content: '我叫什么名字？只回答名字。' },
], '第 2 轮（带历史）');

console.log('\n>>> 多轮结论:', r2?.text?.includes('小明') ? '第二轮成功引用第一轮内容 ✅' : `未引用（回答=${r2?.text}）❌`);

await shim.close();
