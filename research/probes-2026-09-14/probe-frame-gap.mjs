// research/probes-2026-09-14/probe-frame-gap.mjs
// 测量流内「最大帧间隔」——DSH watchdog 的超时判定正是基于它。
// 若思考期间存在 >30s 的帧间隔，DSH（默认 streamIdleTimeoutMs）就会掐断。
import { startChatShim } from '../../lib/chat-shim.js';
import { loadCredentials } from '../../lib/credentials.js';
import { DEFAULT_ENDPOINT } from '../../lib/signer-session.js';

const shim = await startChatShim({
  getCredential: async () => loadCredentials(),
  endpoint: DEFAULT_ENDPOINT,
  logger: { warn: () => {}, info: () => {} },
});

const HARD = [
  '有 12 个外观相同的小球，其中一个重量不同（不知偏轻还是偏重）。用天平最少称几次能找出它？给出完整策略与每一步的称法。',
  '求解：∏(k=1..n) (1 + 1/k^2 + 1/(k+1)^2) = (n+1)(n+2)/(2(n+1)) 是否成立？给出严谨证明。',
];

console.log('=== 流内帧间隔分析 ===\n');
for (const [i, prompt] of HARD.entries()) {
  const t0 = Date.now();
  const gaps = [];
  let lastFrameAt = Date.now();
  let total = 0;
  let maxGapAt = '';
  try {
    const res = await fetch(shim.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.sharedSecret}` },
      body: JSON.stringify({ model: 'pro', stream: true, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(300000),
    });
    const dec = new TextDecoder('utf-8');
    let buf = '';
    for await (const c of res.body) {
      const now = Date.now();
      const gap = now - lastFrameAt;
      if (gap > 500) gaps.push({ gap, at: now - t0 });
      if (gaps.length === 0 || gap > Math.max(...gaps.map((g) => g.gap))) maxGapAt = now - t0 + 'ms处';
      lastFrameAt = now;
      buf += dec.decode(c, { stream: true });
      const evs = buf.split('\n\n');
      buf = evs.pop() ?? '';
    }
    total = Date.now() - t0;
    gaps.sort((a, b) => b.gap - a.gap);
    console.log(`#${i + 1} 总 ${total}ms | >500ms 的间隔 ${gaps.length} 个`);
    for (const g of gaps.slice(0, 5)) {
      console.log(`     ${g.gap}ms（流开始后 ${g.at}）`);
    }
  } catch (e) {
    console.log(`#${i + 1} ❌ ${Date.now() - t0}ms | ${e.message.slice(0, 60)}`);
  }
  console.log('');
}

await shim.close();
process.exit(0);
