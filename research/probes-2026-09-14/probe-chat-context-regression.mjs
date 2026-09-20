// research/probes-2026-09-14/probe-chat-context-regression.mjs
// 关键回归：加了 chat_context 后，上游是否变慢/卡住？
// 对照「带 chat_context」vs「不带 chat_context」——各 3 次，看耗时分布。
import { createSignerSession, DEFAULT_ENDPOINT } from '../../lib/signer-session.js';
import { loadCredentials } from '../../lib/credentials.js';

const cred = await loadCredentials();
const session = await createSignerSession({ credential: cred, endpoint: DEFAULT_ENDPOINT });
const PROMPT = '说：好';

async function run(label, withCtx) {
  const rid = crypto.randomUUID();
  const mc = { key: 'pro', source: 'system', max_input_tokens: 180000 };
  const body = {
    request_id: rid,
    session_id: 'sess-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    model_config: mc,
    parameters: { max_tokens: 32000 },
    messages: [{ role: 'user', content: PROMPT }],
  };
  if (withCtx) {
    body.chat_context = {
      text: PROMPT,
      features: [],
      extra: { context: [], modelConfig: { key: 'pro', source: 'system' }, originalContent: PROMPT },
      chatPrompt: '',
      imageUrls: null,
    };
    body.agent_id = 'agent_common';
  }
  const signed = session.signInferRequest(JSON.stringify(body), { modelKey: 'pro', modelSource: 'system' });
  const t0 = Date.now();
  let headerAt = null, firstContentAt = null, chars = 0;
  try {
    const res = await fetch(signed.url, { method: 'POST', headers: signed.headers, body: signed.body, signal: AbortSignal.timeout(90000) });
    headerAt = Date.now();
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
          if (d?.content) { if (!firstContentAt) firstContentAt = Date.now(); chars += d.content.length; }
        } catch {}
      }
    }
    return { ok: true, total: Date.now() - t0, header: headerAt - t0, first: (firstContentAt ?? 0) - t0, chars };
  } catch (e) {
    return { ok: false, total: Date.now() - t0, header: headerAt ? headerAt - t0 : null, err: e.message.slice(0, 40) };
  }
}

console.log('=== 对照实验：chat_context 是否引入回归（各 3 次）===\n');
for (const [label, withCtx] of [['不带 chat_context', false], ['带 chat_context（当前实现）', true]]) {
  console.log(`--- ${label} ---`);
  const totals = [];
  for (let i = 0; i < 3; i++) {
    const r = await run(label, withCtx);
    if (r.ok) {
      totals.push(r.total);
      console.log(`  #${i + 1} ✅ 总 ${String(r.total).padStart(6)}ms | 响应头 ${String(r.header).padStart(6)}ms | 首内容 ${String(r.first).padStart(6)}ms | ${r.chars} 字`);
    } else {
      console.log(`  #${i + 1} ❌ 总 ${String(r.total).padStart(6)}ms | ${r.err}`);
    }
  }
  if (totals.length) {
    const avg = Math.round(totals.reduce((s, x) => s + x, 0) / totals.length);
    console.log(`  → 平均 ${avg}ms（${totals.length}/${3} 成功）\n`);
  } else {
    console.log(`  → 全部失败\n`);
  }
}

await session.dispose?.();
process.exit(0);
