// research/probes-2026-09-14/probe-large-body.mjs
// 大请求体回归：DSH agent 场景的请求体可达几十 KB 甚至更大。
// 实测不同大小的请求体，上游的响应头时间是否突变。
import { createSignerSession, DEFAULT_ENDPOINT } from '../../lib/signer-session.js';
import { loadCredentials } from '../../lib/credentials.js';

const cred = await loadCredentials();
const session = await createSignerSession({ credential: cred, endpoint: DEFAULT_ENDPOINT });

async function run(label, sizeKB) {
  // 构造指定大小的历史（用真实感的中文内容）
  const filler = '这是一段用于撑起请求体积的中文内容，模拟真实对话历史。';
  const messages = [];
  let cur = 0;
  let i = 0;
  while (cur < sizeKB * 1024 && i < 500) {
    const m = { role: i % 2 === 0 ? 'user' : 'assistant', content: filler.repeat(6) };
    messages.push(m);
    cur += JSON.stringify(m).length;
    i++;
  }
  messages.push({ role: 'user', content: '总结一下上面的内容。' });

  const body = JSON.stringify({
    request_id: crypto.randomUUID(),
    session_id: 'sess-' + Date.now().toString(36),
    model_config: { key: 'pro', source: 'system', max_input_tokens: 180000 },
    parameters: { max_tokens: 1000 },
    chat_context: {
      text: '总结一下上面的内容。',
      features: [],
      extra: { context: [], modelConfig: { key: 'pro', source: 'system' }, originalContent: '总结一下上面的内容。' },
      chatPrompt: '',
      imageUrls: null,
    },
    agent_id: 'agent_common',
    messages,
  });

  const signed = session.signInferRequest(body, { modelKey: 'pro', modelSource: 'system' });
  const t0 = Date.now();
  let headerAt = null, firstContentAt = null, chars = 0;
  try {
    const res = await fetch(signed.url, { method: 'POST', headers: signed.headers, body: signed.body, signal: AbortSignal.timeout(240000) });
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
    const total = Date.now() - t0;
    console.log(`  ${label.padEnd(14)} 请求${String(Math.round(body.length/1024)).padStart(3)}KB | 总${String(total).padStart(7)}ms | 响应头${String(headerAt - t0).padStart(6)}ms | 首内容${String((firstContentAt ?? 0) - t0).padStart(7)}ms | ${chars}字`);
  } catch (e) {
    console.log(`  ${label.padEnd(14)} 请求${String(Math.round(body.length/1024)).padStart(3)}KB | 总${String(Date.now() - t0).padStart(7)}ms | ❌ ${e.message.slice(0, 50)}`);
  }
}

console.log('=== 请求体大小回归 ===');
await run('小(1KB)', 1);
await run('中(10KB)', 10);
await run('大(30KB)', 30);
await run('很大(60KB)', 60);
await run('巨大(120KB)', 120);

await session.dispose?.();
process.exit(0);
