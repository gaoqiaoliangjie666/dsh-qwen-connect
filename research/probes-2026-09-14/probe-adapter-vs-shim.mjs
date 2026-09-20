// research/probes-2026-09-14/probe-adapter-vs-shim.mjs
// 关键对照：同一请求分别走「裸 shim」与「PiAiAdapter（GUI 的真实路径）」。
// 若 adapter 路径超时而 shim 正常，问题就在 adapter 层（pi-ai 的转换/CDN）。
import { startChatShim } from '../../lib/chat-shim.js';
import { createQwenWorkAdapter } from '../../lib/index.js';
import { loadCredentials } from '../../lib/credentials.js';
import { DEFAULT_ENDPOINT } from '../../lib/signer-session.js';

const shim = await startChatShim({
  getCredential: async () => loadCredentials(),
  endpoint: DEFAULT_ENDPOINT,
  logger: { warn: (...a) => console.log('    [warn]', ...a.map((x) => String(x).slice(0, 110))) },
});
const baseUrl = shim.baseUrl;
const secret = shim.sharedSecret;

const MSGS = [{ role: 'user', content: [{ type: 'text', text: '用一句话介绍杭州。' }] }];

console.log('=== A) 裸 shim（我一直在测的路径）===');
{
  const t0 = Date.now();
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ model: 'pro', stream: true, messages: MSGS }),
    signal: AbortSignal.timeout(90000),
  });
  const txt = await res.text();
  let chars = 0;
  for (const l of txt.split('\n')) {
    if (!l.startsWith('data:')) continue;
    const p = l.slice(5).trim();
    if (!p || p === '[DONE]') continue;
    try { const o = JSON.parse(p); for (const c of o.choices ?? []) if (c.delta?.content) chars += c.delta.content.length; } catch {}
  }
  console.log(`  ${res.status === 200 ? '✅' : '❌'} ${Date.now() - t0}ms | HTTP ${res.status} | ${chars} 字`);
}

console.log('\n=== B) 经 PiAiAdapter（GUI 的真实路径）===');
{
  const { adapter } = createQwenWorkAdapter(
    () => baseUrl,
    async () => secret,
    {},
  );
  for (const model of ['pro']) {
    const t0 = Date.now();
    try {
      const chunks = [];
      for await (const c of adapter.stream({
        provider: 'qwenwork',
        model,
        messages: MSGS,
        signal: AbortSignal.timeout(90000),
      })) {
        chunks.push(c);
      }
      const text = chunks.filter((c) => c?.type === 'text-delta' || c?.type === 'text_delta').map((c) => c.delta ?? c.text ?? '').join('');
      const finish = chunks.find((c) => c?.type === 'finish');
      const usage = chunks.find((c) => c?.type === 'usage');
      console.log(`  ✅ ${model}: ${Date.now() - t0}ms | ${chunks.length} chunks | ${JSON.stringify(text.slice(0, 30))}`);
      console.log(`     finish=${JSON.stringify(finish?.reason)} usage=${JSON.stringify(usage?.usage)}`);
      console.log(`     chunk 类型: ${[...new Set(chunks.map((c) => c?.type))].join(', ')}`);
    } catch (e) {
      console.log(`  ❌ ${model}: ${Date.now() - t0}ms | ${e.message.slice(0, 100)}`);
    }
  }
}

await shim.close();
process.exit(0);
