// research/probe-is-reasoning-quality.mjs
// 对比 is_reasoning true/false 在复杂问题上的质量与耗时差异。
import { createSignerSession, DEFAULT_ENDPOINT } from '../lib/signer-session.js';
import { loadCredentials } from '../lib/credentials.js';

const cred = await loadCredentials();
const credential = cred.credentials ?? cred;
const session = await createSignerSession({ credential, endpoint: DEFAULT_ENDPOINT });

function buildBody(text, isReasoning) {
  const requestId = globalThis.crypto.randomUUID();
  const cfg = { key: 'pro', source: 'system', is_reasoning: isReasoning };
  return JSON.stringify({
    request_id: requestId,
    session_id: `sess-${Date.now().toString(36)}`,
    model_config: { ...cfg },
    chat_context: {
      text,
      extra: { modelConfig: { ...cfg }, originalContent: text },
    },
    messages: [{ role: 'user', content: text }],
  });
}

async function run(isReasoning, text) {
  const body = buildBody(text, isReasoning);
  const signed = session.signInferRequest(body, { modelKey: 'pro', modelSource: 'system' });
  const t0 = Date.now();
  const res = await fetch(signed.url, { method: 'POST', headers: signed.headers, body: signed.body });
  if (!res.ok) return { err: `HTTP ${res.status}: ${(await res.text()).slice(0, 150)}` };

  const decoder = new TextDecoder('utf-8');
  let buf = '', content = '', reasoning = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    const evs = buf.split('\n\n'); buf = evs.pop() ?? '';
    for (const e of evs) {
      if (!e.startsWith('data:')) continue;
      const p = e.slice(5).trim();
      if (!p || p === '[DONE]') continue;
      try {
        const o = JSON.parse(p);
        const inner = typeof o.body === 'string' ? JSON.parse(o.body) : o;
        const d = inner.choices?.[0]?.delta ?? {};
        if (d.content) content += d.content;
        if (d.reasoning_content) reasoning += d.reasoning_content;
      } catch {}
    }
  }
  buf += decoder.decode();
  return { ms: Date.now() - t0, content, reasoning };
}

// 需要一个真正需要推理的问题
const TEXT = '一个水池有甲乙两个进水管。甲管单独注满需要 6 小时，乙管单独注满需要 4 小时。两管同时开 2 小时后关闭甲管，乙管继续注水直到注满。问：从开始到注满共需要多少小时？请给出计算过程。';

for (const flag of [false, true]) {
  const r = await run(flag, TEXT);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`is_reasoning: ${flag}`);
  console.log('='.repeat(60));
  if (r.err) { console.log('  错误:', r.err); continue; }
  console.log(`耗时 ${(r.ms / 1000).toFixed(1)}s | 正文 ${r.content.length} 字符 | 思考链 ${r.reasoning.length} 字符`);
  console.log('\n--- 正文 ---');
  console.log(r.content.slice(0, 500));
}

await session.dispose?.();
process.exit(0);
