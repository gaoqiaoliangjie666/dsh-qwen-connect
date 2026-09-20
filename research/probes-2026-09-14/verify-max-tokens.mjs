// research/probes-2026-09-14/verify-max-tokens.mjs
// 验证显式 max_tokens 是否改善「长输入长时间不返回」的问题。
import { startChatShim } from '../../lib/chat-shim.js';
import { loadCredentials } from '../../lib/credentials.js';
import { DEFAULT_ENDPOINT } from '../../lib/signer-session.js';

const shim = await startChatShim({
  getCredential: async () => loadCredentials(),
  endpoint: DEFAULT_ENDPOINT,
});

async function t(label, content, ms) {
  const t0 = Date.now();
  try {
    const res = await fetch(shim.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.sharedSecret}` },
      body: JSON.stringify({ model: 'pro', stream: true, messages: [{ role: 'user', content }] }),
      signal: AbortSignal.timeout(ms),
    });
    const txt = await res.text();
    let ans = '', frames = 0;
    for (const l of txt.split('\n')) {
      if (!l.startsWith('data:')) continue;
      const p = l.slice(5).trim();
      if (!p || p === '[DONE]') continue;
      frames++;
      try {
        const o = JSON.parse(p);
        for (const c of o.choices ?? []) if (c.delta?.content) ans += c.delta.content;
      } catch {}
    }
    const dt = Date.now() - t0;
    console.log(`  ✅ ${label}: ${dt}ms | ${frames}帧 | 答=${JSON.stringify(ans.slice(0, 40))}`);
    return dt;
  } catch (e) {
    console.log(`  ❌ ${label}: ${e.message.slice(0, 50)} | ${Date.now() - t0}ms`);
    return -1;
  }
}

console.log('=== 显式 max_tokens 后的表现 ===');
await t('短输入', '说：好', 60000);
await t('重复输入(500字)', '重复一遍：' + '测'.repeat(500), 90000);
await t('自然(1000字)', '人工智能正在改变世界。'.repeat(100), 90000);
await t('自然(3000字)', '人工智能正在改变世界。它的发展带来机遇和挑战。'.repeat(150), 120000);

await shim.close();
process.exit(0);
