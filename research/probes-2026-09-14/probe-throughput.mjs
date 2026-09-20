// research/probes-2026-09-14/probe-throughput.mjs
// 吞吐诊断：首 token 延迟 / 输出速率 / 分段耗时，定位瓶颈。
import { startChatShim } from '../../lib/chat-shim.js';
import { loadCredentials } from '../../lib/credentials.js';
import { DEFAULT_ENDPOINT } from '../../lib/signer-session.js';

const shim = await startChatShim({
  getCredential: async () => loadCredentials(),
  endpoint: DEFAULT_ENDPOINT,
  logger: { warn: () => {}, info: () => {} },
});

async function measure(label, model, prompt) {
  const t0 = Date.now();
  let firstByteAt = null;
  let firstContentAt = null;
  let lastAt = null;
  let contentChars = 0;
  let frames = 0;

  const res = await fetch(shim.baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.sharedSecret}` },
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(120000),
  });

  const decoder = new TextDecoder('utf-8');
  let buf = '';
  for await (const chunk of res.body) {
    if (firstByteAt === null) firstByteAt = Date.now();
    buf += decoder.decode(chunk, { stream: true });
    const evs = buf.split('\n\n');
    buf = evs.pop() ?? '';
    for (const e of evs) {
      if (!e.startsWith('data:')) continue;
      const p = e.slice(5).trim();
      if (!p || p === '[DONE]') continue;
      frames++;
      try {
        const o = JSON.parse(p);
        const c = o.choices?.[0]?.delta;
        if (c?.content) {
          if (firstContentAt === null) firstContentAt = Date.now();
          contentChars += c.content.length;
        }
      } catch {}
    }
    lastAt = Date.now();
  }
  const total = lastAt - t0;
  const ttft = (firstContentAt ?? lastAt) - t0;
  const genMs = lastAt - (firstContentAt ?? t0);
  const cps = genMs > 0 ? (contentChars / genMs) * 1000 : 0;
  console.log(`  ${label} (${model})`);
  console.log(`    总耗时 ${total}ms | 首 token ${ttft}ms | 生成阶段 ${genMs}ms`);
  console.log(`    输出 ${contentChars} 字符 | ${frames} 帧 | ${cps.toFixed(1)} 字符/秒`);
  console.log(`    首字节延迟（含签名+上游排队） ${(firstByteAt ?? t0) - t0}ms`);
  return { total, ttft, cps, chars: contentChars };
}

console.log('=== 吞吐诊断（stream=true）===');
await measure('短请求', 'pro', '用一句话介绍自己');
await measure('中请求', 'pro', '写一段 200 字左右的短文，介绍杭州');
await measure('对比 flash', 'flash', '写一段 200 字左右的短文，介绍杭州');
await measure('对比 max', 'qwen3.8-max-preview', '写一段 200 字左右的短文，介绍杭州');

await shim.close();
process.exit(0);
