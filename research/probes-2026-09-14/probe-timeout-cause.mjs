// research/probes-2026-09-14/probe-timeout-cause.mjs
// 定位超时根因：区分「上游慢」/「我们的 header 超时」/「流空闲看门狗」。
import { startChatShim } from '../../lib/chat-shim.js';
import { loadCredentials } from '../../lib/credentials.js';
import { DEFAULT_ENDPOINT } from '../../lib/signer-session.js';

const shim = await startChatShim({
  getCredential: async () => loadCredentials(),
  endpoint: DEFAULT_ENDPOINT,
  logger: { warn: (...a) => console.log('    [warn]', ...a.map((x) => String(x).slice(0, 110))) },
});

console.log('=== 连续 8 次真实对话，记录每次的分段耗时 ===');
let okCount = 0, failCount = 0;
for (let i = 0; i < 8; i++) {
  const t0 = Date.now();
  let headerAt = null, firstContentAt = null, lastAt = null, chars = 0;
  try {
    const res = await fetch(shim.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.sharedSecret}` },
      body: JSON.stringify({ model: 'pro', stream: true, messages: [{ role: 'user', content: '用一句话介绍杭州' }] }),
      signal: AbortSignal.timeout(180000),
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
      lastAt = Date.now();
    }
    const total = (lastAt ?? Date.now()) - t0;
    okCount++;
    console.log(
      `  #${i + 1} ✅ 总 ${String(total).padStart(7)}ms | 响应头 ${String(headerAt - t0).padStart(6)}ms | 首内容 ${String((firstContentAt ?? 0) - t0).padStart(7)}ms | ${chars} 字`,
    );
  } catch (e) {
    const total = Date.now() - t0;
    failCount++;
    console.log(`  #${i + 1} ❌ 总 ${String(total).padStart(7)}ms | 响应头 ${headerAt ? (headerAt - t0) + 'ms' : '未到'} | ${e.name}: ${e.message.slice(0, 50)}`);
  }
}
console.log(`\n  统计: 成功 ${okCount} / 失败 ${failCount}`);

await shim.close();
process.exit(0);
