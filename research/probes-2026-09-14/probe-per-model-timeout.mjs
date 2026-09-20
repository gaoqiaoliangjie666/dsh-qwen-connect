// research/probes-2026-09-14/probe-per-model-timeout.mjs
// 逐模型排查超时：三个模型各测 3 次，看是否有某个模型持续超时。
import { startChatShim } from '../../lib/chat-shim.js';
import { loadCredentials } from '../../lib/credentials.js';
import { DEFAULT_ENDPOINT } from '../../lib/signer-session.js';

const shim = await startChatShim({
  getCredential: async () => loadCredentials(),
  endpoint: DEFAULT_ENDPOINT,
  logger: { warn: (...a) => console.log('    [warn]', ...a.map((x) => String(x).slice(0, 100))) },
});

async function tryOnce(model, prompt, timeoutMs) {
  const t0 = Date.now();
  let headerAt = null, firstContentAt = null, chars = 0;
  try {
    const res = await fetch(shim.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.sharedSecret}` },
      body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
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
          const d = o.choices?.[0]?.delta;
          if (d?.content) { if (!firstContentAt) firstContentAt = Date.now(); chars += d.content.length; }
        } catch {}
      }
    }
    return { ok: true, total: Date.now() - t0, header: headerAt - t0, first: (firstContentAt ?? 0) - t0, chars, status: res.status };
  } catch (e) {
    return { ok: false, total: Date.now() - t0, header: headerAt ? headerAt - t0 : null, err: e.name + ': ' + e.message.slice(0, 40) };
  }
}

const PROMPT = '用一句话介绍杭州。';
console.log('=== 逐模型超时排查（各 3 次，超时上限 90s）===\n');

for (const model of ['pro', 'flash', 'qwen3.8-max-preview']) {
  console.log(`--- ${model} ---`);
  for (let i = 0; i < 3; i++) {
    const r = await tryOnce(model, PROMPT, 90000);
    if (r.ok) {
      console.log(`  #${i + 1} ✅ 总 ${String(r.total).padStart(6)}ms | 响应头 ${String(r.header).padStart(6)}ms | 首内容 ${String(r.first).padStart(6)}ms | ${r.chars} 字 | HTTP ${r.status}`);
    } else {
      console.log(`  #${i + 1} ❌ 总 ${String(r.total).padStart(6)}ms | 响应头 ${r.header === null ? '未到' : r.header + 'ms'} | ${r.err}`);
    }
  }
  console.log('');
}

await shim.close();
process.exit(0);
