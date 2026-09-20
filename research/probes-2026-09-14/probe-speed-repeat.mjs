// research/probes-2026-09-14/probe-speed-repeat.mjs
// 多次采样确认：is_reasoning=false 是否真能提速（单次数据不足以下结论）。
import { createSignerSession, DEFAULT_ENDPOINT } from '../../lib/signer-session.js';
import { loadCredentials } from '../../lib/credentials.js';

const cred = await loadCredentials();
const session = await createSignerSession({ credential: cred, endpoint: DEFAULT_ENDPOINT });
const PROMPT = '用一句话介绍杭州。';

async function once({ isReasoning }) {
  const rid = crypto.randomUUID();
  const mc = { key: 'pro', source: 'system', max_input_tokens: 180000 };
  if (isReasoning !== undefined) mc.is_reasoning = isReasoning;
  const body = JSON.stringify({
    request_id: rid,
    session_id: 'sess-' + Date.now().toString(36),
    model_config: mc,
    parameters: { max_tokens: 32000 },
    chat_context: {
      text: PROMPT, features: [],
      extra: { context: [], modelConfig: { key: 'pro', source: 'system', ...(isReasoning === undefined ? {} : { is_reasoning: isReasoning }) }, originalContent: PROMPT },
      chatPrompt: '', imageUrls: null,
    },
    agent_id: 'agent_common',
    messages: [{ role: 'user', content: PROMPT }],
  });
  const signed = session.signInferRequest(body, { modelKey: 'pro', modelSource: 'system' });
  const t0 = Date.now();
  let firstAt = null, lastAt = null, chars = 0, reasoning = 0;
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
        if (d?.content) { if (!firstAt) firstAt = Date.now(); chars += d.content.length; }
        if (d?.reasoning_content) reasoning += d.reasoning_content.length;
      } catch {}
    }
    lastAt = Date.now();
  }
  const total = (lastAt ?? Date.now()) - t0;
  const ttft = (firstAt ?? lastAt ?? Date.now()) - t0;
  const gen = (lastAt ?? Date.now()) - (firstAt ?? t0);
  return { total, ttft, chars, reasoning, cps: gen > 0 ? (chars / gen) * 1000 : 0 };
}

function stats(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const avg = arr.reduce((s, x) => s + x, 0) / arr.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  return { avg: Math.round(avg), median: Math.round(median), min: Math.round(sorted[0]), max: Math.round(sorted[sorted.length - 1]) };
}

console.log('=== 多次采样（各 4 次，取中位数）===');
for (const [label, cfg] of [
  ['pro 默认（不设）', {}],
  ['pro is_reasoning=false', { isReasoning: false }],
]) {
  const totals = [], ttfts = [], cpss = [], reasonings = [];
  for (let i = 0; i < 4; i++) {
    try {
      const r = await once(cfg);
      totals.push(r.total); ttfts.push(r.ttft); cpss.push(r.cps); reasonings.push(r.reasoning);
    } catch (e) {
      console.log(`    (第 ${i + 1} 次失败: ${e.message.slice(0, 30)})`);
    }
  }
  if (totals.length === 0) continue;
  const t = stats(totals), f = stats(ttfts), c = stats(cpss);
  console.log(`  ${label.padEnd(26)}`);
  console.log(`    总耗时  中位 ${t.median}ms  (${t.min}-${t.max})`);
  console.log(`    首token 中位 ${f.median}ms  (${f.min}-${f.max})`);
  console.log(`    速率    中位 ${c.median} 字/秒  (${c.min}-${c.max})`);
  console.log(`    思考字符 平均 ${Math.round(reasonings.reduce((s, x) => s + x, 0) / reasonings.length)}`);
}

await session.dispose?.();
process.exit(0);
