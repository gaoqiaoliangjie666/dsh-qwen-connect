// 验证：多轮场景下思维链是否真的出现在 content 字段里（而非 reasoning_content）
import { createSignerSession, buildInferBody } from '../lib/signer-session.js';
import { loadCredentials } from '../lib/credentials.js';
import { SseParser, parseQwenWorkFrame } from '../lib/sse.js';

const session = await createSignerSession({ credential: loadCredentials() });

async function turn(messages, label) {
  const bodyJson = buildInferBody({ messages, modelKey: 'pro' });
  const signed = session.signInferRequest(bodyJson, { modelKey: 'pro', modelSource: 'system' });
  const res = await fetch(signed.url, { method: 'POST', headers: signed.headers, body: signed.body });

  const parser = new SseParser();
  const decoder = new TextDecoder();
  let content = '', reasoning = '';
  for await (const chunk of res.body) {
    for (const p of parser.push(decoder.decode(chunk, { stream: true }))) {
      const f = parseQwenWorkFrame(p);
      if (f.kind === 'chunk') {
        if (f.delta.content) content += f.delta.content;
        if (f.delta.reasoning) reasoning += f.delta.reasoning;
      }
    }
  }
  console.log(`\n=== ${label} ===`);
  console.log('reasoning:', JSON.stringify(reasoning.slice(0, 180)));
  console.log('content  :', JSON.stringify(content.slice(0, 180)));
  return { content, reasoning };
}

const r1 = await turn([{ role: 'user', content: '我叫小明。请只回答"好的"。' }], '第 1 轮');
const r2 = await turn([
  { role: 'user', content: '我叫小明。请只回答"好的"。' },
  { role: 'assistant', content: r1.content },
  { role: 'user', content: '我叫什么名字？只回答名字。' },
], '第 2 轮');

console.log('\n>>> 第 2 轮 content 里是否混入思维链:', /User said|Answer just|user asked/i.test(r2.content));
session.dispose();
