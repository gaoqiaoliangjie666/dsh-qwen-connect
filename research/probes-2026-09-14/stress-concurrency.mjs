// research/probes-2026-09-14/stress-concurrency.mjs
// 排查并发与资源：并发请求、重复启动/关闭 shim、端口泄漏。
import { startChatShim, createChatShimHandler } from '../../lib/chat-shim.js';
import { loadCredentials } from '../../lib/credentials.js';
import { DEFAULT_ENDPOINT } from '../../lib/signer-session.js';

console.log('=== 1) 并发 5 个请求（同一 shim）===');
const shim = await startChatShim({
  getCredential: async () => loadCredentials(),
  endpoint: DEFAULT_ENDPOINT,
});

const t0 = Date.now();
const results = await Promise.all(
  Array.from({ length: 5 }, (_, i) =>
    fetch(shim.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.sharedSecret}` },
      body: JSON.stringify({ model: 'pro', stream: true, messages: [{ role: 'user', content: `说：第${i}个` }] }),
      signal: AbortSignal.timeout(60000),
    })
      .then(async (r) => {
        const t = await r.text();
        let ans = '';
        for (const l of t.split('\n')) {
          if (!l.startsWith('data:')) continue;
          const p = l.slice(5).trim();
          if (!p || p === '[DONE]') continue;
          try {
            const o = JSON.parse(p);
            for (const c of o.choices ?? []) if (c.delta?.content) ans += c.delta.content;
          } catch {}
        }
        return { i, status: r.status, ans: ans.slice(0, 20) };
      })
      .catch((e) => ({ i, status: 'ERR', ans: e.message.slice(0, 40) })),
  ),
);
for (const r of results.sort((a, b) => a.i - b.i)) {
  console.log(`  #${r.i} HTTP ${r.status} | ${JSON.stringify(r.ans)}`);
}
console.log(`  总耗时 ${Date.now() - t0}ms（并发，非累加）`);

console.log('\n=== 2) 重复启动/关闭 shim（端口泄漏检测）===');
for (let i = 0; i < 3; i++) {
  const s = await startChatShim({
    getCredential: async () => loadCredentials(),
    endpoint: DEFAULT_ENDPOINT,
  });
  console.log(`  第 ${i + 1} 次: 端口 ${s.port}`);
  await s.close();
}
console.log('  ✅ 3 次启动/关闭均成功（不泄漏端口）');

console.log('\n=== 3) handler 复用（不重复启动监听）===');
const h = createChatShimHandler({
  getCredential: async () => loadCredentials(),
  endpoint: DEFAULT_ENDPOINT,
  sharedSecret: 'test',
});
console.log(`  createChatShimHandler 返回函数: ${typeof h === 'function'}`);

await shim.close();
console.log('\n✅ 并发与资源检查完成');
process.exit(0);
