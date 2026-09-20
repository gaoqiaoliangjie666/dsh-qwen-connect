// research/probes-2026-09-14/probe-speed-tune.mjs
// 提速对照实验：is_reasoning / 模型选择 / max_tokens 对速度的影响。
import { createSignerSession, DEFAULT_ENDPOINT } from '../../lib/signer-session.js';
import { loadCredentials } from '../../lib/credentials.js';

const cred = await loadCredentials();
const session = await createSignerSession({ credential: cred, endpoint: DEFAULT_ENDPOINT });

const PROMPT = '用一句话介绍杭州。';

async function run(label, { modelKey, isReasoning, maxTokens }) {
  const rid = crypto.randomUUID();
  const mc = { key: modelKey, source: 'system', max_input_tokens: 180000 };
  if (isReasoning !== undefined) mc.is_reasoning = isReasoning;
  const body = JSON.stringify({
    request_id: rid,
    session_id: 'sess-' + Date.now().toString(36),
    model_config: mc,
    parameters: { max_tokens: maxTokens ?? 32000 },
    chat_context: {
      text: PROMPT,
      features: [],
      extra: { context: [], modelConfig: { key: modelKey, source: 'system', ...(isReasoning === undefined ? {} : { is_reasoning: isReasoning }) }, originalContent: PROMPT },
      chatPrompt: '',
      imageUrls: null,
    },
    agent_id: 'agent_common',
    messages: [{ role: 'user', content: PROMPT }],
  });
  const signed = session.signInferRequest(body, { modelKey, modelSource: 'system' });
  const t0 = Date.now();
  let firstContentAt = null, lastAt = null, contentChars = 0, reasoningChars = 0;
  try {
    const res = await fetch(signed.url, { method: 'POST', headers: signed.headers, body: signed.body, signal: AbortSignal.timeout(90000) });
    const dec = new TextDecoder('utf-8');
    let buf = '';
    for await (const c of res.body) {
      buf += dec.decode(c, { stream: true });
      const evs = buf.split('\n\n'); buf = evs.pop() ?? '';
      for (const e of evs) {
        if (!e.startsWith('data:')) continue;
        const p = e.slice(5).trim();
        if (!p || p === '[DONE]') continue;
        try {
          const o = JSON.parse(p);
          const inner = typeof o.body === 'string' ? JSON.parse(o.body) : o;
          const d = inner.choices?.[0]?.delta;
          if (d?.content) { if (!firstContentAt) firstContentAt = Date.now(); contentChars += d.content.length; }
          if (d?.reasoning_content) reasoningChars += d.reasoning_content.length;
        } catch {}
      }
      lastAt = Date.now();
    }
  } catch (e) {
    console.log(`  ❌ ${label}: ${e.message.slice(0, 50)}`);
    return;
  }
  const total = (lastAt ?? Date.now()) - t0;
  const ttft = (firstContentAt ?? lastAt ?? Date.now()) - t0;
  const gen = (lastAt ?? Date.now()) - (firstContentAt ?? t0);
  const cps = gen > 0 ? (contentChars / gen) * 1000 : 0;
  console.log(`  ${label.padEnd(26)} 总${String(total).padStart(6)}ms | 首token${String(ttft).padStart(6)}ms | ${String(contentChars).padStart(4)}字 | ${cps.toFixed(0).padStart(4)}字/秒 | 思考${reasoningChars}字`);
}

console.log('=== 提速对照实验（同一 prompt，各 1 次）===');
await run('pro（当前：不设 is_reasoning）', { modelKey: 'pro' });
await run('pro + is_reasoning=false', { modelKey: 'pro', isReasoning: false });
await run('pro + is_reasoning=true', { modelKey: 'pro', isReasoning: true });
await run('flash（不设）', { modelKey: 'flash' });
await run('flash + is_reasoning=false', { modelKey: 'flash', isReasoning: false });
await run('max-preview（不设）', { modelKey: 'qwen3.8-max-preview' });
await run('max-preview + is_reasoning=false', { modelKey: 'qwen3.8-max-preview', isReasoning: false });
await run('pro + max_tokens=1024', { modelKey: 'pro', maxTokens: 1024 });

await session.dispose?.();
process.exit(0);
