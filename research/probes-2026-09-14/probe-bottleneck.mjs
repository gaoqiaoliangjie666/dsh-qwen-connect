// research/probes-2026-09-14/probe-bottleneck.mjs
// 定位瓶颈：签名开销 / shim 转发开销 / 上游生成速率，三段分别计时。
import { createSignerSession, DEFAULT_ENDPOINT } from '../../lib/signer-session.js';
import { loadCredentials } from '../../lib/credentials.js';

const cred = await loadCredentials();

console.log('=== 1) 签名会话构建开销（一次性） ===');
let t0 = Date.now();
const session = await createSignerSession({ credential: cred, endpoint: DEFAULT_ENDPOINT });
console.log(`  构建会话: ${Date.now() - t0}ms（WASM 实例化 + machineId 解析）`);

console.log('\n=== 2) 单次签名开销（每请求都要做） ===');
const body = JSON.stringify({
  request_id: 'r1', session_id: 's1',
  model_config: { key: 'pro', source: 'system', max_input_tokens: 180000 },
  parameters: { max_tokens: 32000 },
  messages: [{ role: 'user', content: 'hi' }],
});
const times = [];
for (let i = 0; i < 20; i++) {
  const a = Date.now();
  session.signInferRequest(body, { modelKey: 'pro', modelSource: 'system' });
  times.push(Date.now() - a);
}
const sorted = [...times].sort((a, b) => a - b);
console.log(`  20 次签名：中位 ${sorted[10]}ms | 最快 ${sorted[0]}ms | 最慢 ${sorted[19]}ms`);

console.log('\n=== 3) 上游纯生成耗时（首个数据帧 → 结束） ===');
const PROMPT = '数到 20，用逗号分隔。';
const signed = session.signInferRequest(
  JSON.stringify({
    request_id: 'r2', session_id: 's2',
    model_config: { key: 'pro', source: 'system', max_input_tokens: 180000 },
    parameters: { max_tokens: 32000 },
    chat_context: {
      text: PROMPT, features: [],
      extra: { context: [], modelConfig: { key: 'pro', source: 'system' }, originalContent: PROMPT },
      chatPrompt: '', imageUrls: null,
    },
    agent_id: 'agent_common',
    messages: [{ role: 'user', content: PROMPT }],
  }),
  { modelKey: 'pro', modelSource: 'system' },
);
const fetchStart = Date.now();
const res = await fetch(signed.url, { method: 'POST', headers: signed.headers, body: signed.body, signal: AbortSignal.timeout(90000) });
const headerAt = Date.now();
let firstDataAt = null, lastAt = null, chars = 0, frames = 0;
const dec = new TextDecoder('utf-8');
let buf = '';
for await (const c of res.body) {
  if (firstDataAt === null) firstDataAt = Date.now();
  buf += dec.decode(c, { stream: true });
  const evs = buf.split('\n\n'); buf = evs.pop() ?? '';
  for (const e of evs) {
    if (!e.startsWith('data:')) continue;
    const p = e.slice(5).trim();
    if (!p || p === '[DONE]') continue;
    frames++;
    try {
      const o = JSON.parse(p);
      const inner = typeof o.body === 'string' ? JSON.parse(o.body) : o;
      if (inner.choices?.[0]?.delta?.content) chars += inner.choices[0].delta.content.length;
    } catch {}
  }
  lastAt = Date.now();
}
console.log(`  DNS+TLS+排队到响应头: ${headerAt - fetchStart}ms`);
console.log(`  响应头到首帧:         ${(firstDataAt ?? lastAt) - headerAt}ms`);
console.log(`  首帧到结束（纯生成）: ${(lastAt ?? 0) - (firstDataAt ?? 0)}ms`);
console.log(`  输出 ${chars} 字符 / ${frames} 帧`);
console.log('');
console.log('  → 瓶颈定位：');
const gen = (lastAt ?? 0) - (firstDataAt ?? 0);
console.log(`     签名开销约 ${sorted[10]}ms（占总量比例很小）`);
console.log(`     上游排队 ${headerAt - fetchStart}ms`);
console.log(`     上游生成 ${gen}ms（主要是服务端推理速度）`);

await session.dispose?.();
process.exit(0);
