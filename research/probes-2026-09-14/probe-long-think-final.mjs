// research/probes-2026-09-14/probe-long-think-final.mjs
// 修复验证：长思考请求（曾在响应头阶段被 60s 超时掐死）现在能否完整走完。
import { startChatShim } from '../../lib/chat-shim.js';
import { loadCredentials } from '../../lib/credentials.js';
import { DEFAULT_ENDPOINT } from '../../lib/signer-session.js';

const shim = await startChatShim({
  getCredential: async () => loadCredentials(),
  endpoint: DEFAULT_ENDPOINT,
  logger: { warn: (...a) => console.log('    [warn]', ...a.map((x) => String(x).slice(0, 100))) },
});

const HARD = [
  '有 12 个外观相同的小球，其中一个重量不同（不知偏轻还是偏重）。用天平最少称几次能找出它？给出完整策略。',
  '证明：任意 6 个人中，要么有 3 人互相认识，要么有 3 人互相不认识。',
  '一个数列 1, 11, 21, 1211, 111221, ... 下一项是什么？为什么？',
];

let fail = 0;
console.log('=== 长思考请求验证（修复后）===\n');
for (const [i, prompt] of HARD.entries()) {
  const t0 = Date.now();
  let headerAt = null, firstContentAt = null, chars = 0;
  try {
    const res = await fetch(shim.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.sharedSecret}` },
      body: JSON.stringify({ model: 'pro', stream: true, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(300000),
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
        try { const o = JSON.parse(p); const d = o.choices?.[0]?.delta; if (d?.content) { if (!firstContentAt) firstContentAt = Date.now(); chars += d.content.length; } } catch {}
      }
    }
    const total = Date.now() - t0;
    console.log(`#${i + 1} ✅ 总 ${total}ms | 响应头 ${headerAt - t0}ms | ${chars} 字`);
  } catch (e) {
    fail++;
    console.log(`#${i + 1} ❌ ${Date.now() - t0}ms | ${e.message.slice(0, 60)}`);
  }
}

await shim.close();
console.log(fail === 0 ? '\n[OK] 长思考请求全部完成' : `\n[FAIL] ${fail} 个超时/失败`);
process.exit(fail > 0 ? 1 : 0);
