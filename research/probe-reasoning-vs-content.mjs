// 用会触发思维链的 prompt，检查上游 reasoning_content 与 content 的分离情况
import { createSignerSession, buildInferBody } from '../lib/signer-session.js';
import { loadCredentials } from '../lib/credentials.js';
import { SseParser, parseQwenWorkFrame } from '../lib/sse.js';

const session = await createSignerSession({ credential: loadCredentials() });

for (const prompt of ['我叫小明。请只回答"好的"。', '1+1=?']) {
  const bodyJson = buildInferBody({ messages: [{ role: 'user', content: prompt }], modelKey: 'pro' });
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
  console.log(`\n=== prompt: ${prompt} ===`);
  console.log('reasoning 长度:', reasoning.length, '| content 长度:', content.length);
  console.log('reasoning:', JSON.stringify(reasoning.slice(0, 150)));
  console.log('content  :', JSON.stringify(content.slice(0, 150)));
}

session.dispose();
