// research/probes-2026-09-14/probe-long-think-gap.mjs
// 长思考场景：上游在「首个内容帧」之前的静默期有多长？shim 在此期间有没有帧发出？
import { startChatShim } from '../../lib/chat-shim.js';
import { loadCredentials } from '../../lib/credentials.js';
import { DEFAULT_ENDPOINT } from '../../lib/signer-session.js';

const shim = await startChatShim({
  getCredential: async () => loadCredentials(),
  endpoint: DEFAULT_ENDPOINT,
  logger: { warn: () => {}, info: () => {} },
});

/** 诱发长思考的 prompt（需要推理的数学/逻辑题）。 */
const HARD = [
  '一个三位数，各位数字之和为 15，个位与百位之差为 3，且该数能被 7 整除。求所有满足条件的三位数，并说明推理过程。',
  '有 12 个外观相同的小球，其中一个重量不同（不知偏轻还是偏重）。用天平最少称几次能找出它？给出完整策略。',
  '证明：任意 6 个人中，要么有 3 人互相认识，要么有 3 人互相不认识。',
];

console.log('=== 长思考场景：测量「上游首帧间隔」与「shim 发出的帧间隔」===\n');
for (const [i, prompt] of HARD.entries()) {
  const t0 = Date.now();
  let headerAt = null;
  let firstFrameAt = null;      // shim 发出的第一个任意帧
  let firstContentAt = null;    // 首个正文帧
  let firstReasoningAt = null;  // 首个思考帧
  let lastAt = null;
  let contentChars = 0;
  let reasoningChars = 0;

  try {
    const res = await fetch(shim.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.sharedSecret}` },
      body: JSON.stringify({
        model: 'pro',
        stream: true,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(300000),
    });
    headerAt = Date.now();
    const dec = new TextDecoder('utf-8');
    let buf = '';
    for await (const c of res.body) {
      if (firstFrameAt === null) firstFrameAt = Date.now();
      buf += dec.decode(c, { stream: true });
      const evs = buf.split('\n\n');
      buf = evs.pop() ?? '';
      for (const e of evs) {
        if (!e.startsWith('data:')) continue;
        const p = e.slice(5).trim();
        if (!p || p === '[DONE]') continue;
        try {
          const o = JSON.parse(p);
          const d = o.choices?.[0]?.delta;
          if (d?.content) {
            if (firstContentAt === null) firstContentAt = Date.now();
            contentChars += d.content.length;
          }
          if (d?.reasoning_content) {
            if (firstReasoningAt === null) firstReasoningAt = Date.now();
            reasoningChars += d.reasoning_content.length;
          }
        } catch {}
      }
      lastAt = Date.now();
    }
    const total = (lastAt ?? Date.now()) - t0;
    console.log(`#${i + 1} 总 ${total}ms`);
    console.log(`   请求→响应头:  ${headerAt - t0}ms`);
    console.log(`   请求→首帧:    ${firstFrameAt - t0}ms   ← DSH watchdog 在等这个`);
    console.log(`   请求→首思考:  ${firstReasoningAt !== null ? firstReasoningAt - t0 : '无'}ms`);
    console.log(`   请求→首正文:  ${firstContentAt !== null ? firstContentAt - t0 : '无'}ms`);
    console.log(`   输出: 正文${contentChars}字 + 思考${reasoningChars}字`);
    console.log('');
  } catch (e) {
    console.log(`#${i + 1} ❌ ${Date.now() - t0}ms | ${e.message.slice(0, 60)}\n`);
  }
}

await shim.close();
process.exit(0);
