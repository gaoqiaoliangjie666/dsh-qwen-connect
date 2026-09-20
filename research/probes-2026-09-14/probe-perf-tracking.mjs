// research/probes-2026-09-14/probe-perf-tracking.mjs
// 验证性能采样：真实对话后，status 文档里是否出现 perf 指标。
import { startChatShim } from '../../lib/chat-shim.js';
import { loadCredentials } from '../../lib/credentials.js';
import { DEFAULT_ENDPOINT } from '../../lib/signer-session.js';
import { perfSummary, resetPerf } from '../../lib/perf.js';

let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) fail++;
};

resetPerf();
check('初始无样本时返回 null', perfSummary() === null);

const shim = await startChatShim({
  getCredential: async () => loadCredentials(),
  endpoint: DEFAULT_ENDPOINT,
  logger: { warn: () => {}, info: () => {} },
});

async function chat(model, prompt) {
  const res = await fetch(shim.baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.sharedSecret}` },
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(90000),
  });
  const text = await res.text();
  let chars = 0;
  for (const l of text.split('\n')) {
    if (!l.startsWith('data:')) continue;
    const p = l.slice(5).trim();
    if (!p || p === '[DONE]') continue;
    try { const o = JSON.parse(p); for (const c of o.choices ?? []) if (c.delta?.content) chars += c.delta.content.length; } catch {}
  }
  return { status: res.status, chars };
}

console.log('\n=== 跑 3 次真实对话 ===');
for (let i = 0; i < 3; i++) {
  const r = await chat('pro', `用一句话介绍第${i + 1}个城市。`);
  console.log(`  第 ${i + 1} 次: HTTP ${r.status} | ${r.chars} 字`);
}

const perf = perfSummary();
console.log('\n=== status 文档中的 perf ===');
console.log('  ' + JSON.stringify(perf));
check('采样已记录', perf !== null);
check('样本数 ≥1', (perf?.samples ?? 0) >= 1, String(perf?.samples));
check('ttft 是有限数值', Number.isFinite(perf?.ttftMs), String(perf?.ttftMs));
check('速率是有限数值', Number.isFinite(perf?.charsPerSec), String(perf?.charsPerSec));
check('速率在合理范围（1-1000）', perf.charsPerSec > 1 && perf.charsPerSec < 1000, String(perf?.charsPerSec));
check('最后样本也可读', Number.isFinite(perf?.lastTtftMs) && Number.isFinite(perf?.lastCharsPerSec));

await shim.close();
console.log(fail === 0 ? '\n✅ 性能采样链路通过' : `\n❌ ${fail} 项失败`);
process.exit(fail > 0 ? 1 : 0);
