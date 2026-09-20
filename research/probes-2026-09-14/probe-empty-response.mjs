// research/probes-2026-09-14/probe-empty-response.mjs
// 深挖：+10 轮历史时返回 0 字——是上游空回复，还是我们的流解析丢了内容？
import { startChatShim } from '../../lib/chat-shim.js';
import { loadCredentials } from '../../lib/credentials.js';
import { DEFAULT_ENDPOINT } from '../../lib/signer-session.js';

const shim = await startChatShim({
  getCredential: async () => loadCredentials(),
  endpoint: DEFAULT_ENDPOINT,
  logger: { warn: (...a) => console.log('    [warn]', ...a.map((x) => String(x).slice(0, 110))) },
});

const TOOLS = Array.from({ length: 12 }, (_, i) => ({
  type: 'function',
  function: {
    name: `tool_${i}`,
    description: `测试工具 ${i}`,
    parameters: { type: 'object', properties: { arg: { type: 'string' } }, required: ['arg'] },
  },
}));
const SYSTEM = 'You are DSH, a coding agent. ' + '遵循规则。'.repeat(40);

function makeHistory(turns) {
  const h = [{ role: 'system', content: SYSTEM }];
  for (let i = 0; i < turns; i++) {
    h.push({ role: 'user', content: `${'这是一段较长的用户输入。'.repeat(3)}（第 ${i + 1} 轮）` });
    h.push({ role: 'assistant', content: `${'这是模型的回答。'.repeat(5)}（第 ${i + 1} 轮回复）` });
  }
  h.push({ role: 'user', content: '继续' });
  return h;
}

console.log('=== +10 轮历史：打印原始响应前 2000 字符 ===');
const res = await fetch(shim.baseUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.sharedSecret}` },
  body: JSON.stringify({ model: 'pro', stream: true, tools: TOOLS, messages: makeHistory(10) }),
  signal: AbortSignal.timeout(120000),
});
const txt = await res.text();
console.log(`  HTTP ${res.status} | 响应总长 ${txt.length} 字符`);
console.log('  前 1500 字符:');
console.log('  ' + txt.slice(0, 1500).replace(/\n/g, '\n  '));

// 统计帧类型
let contentFrames = 0, reasoningFrames = 0, otherFrames = 0, toolFrames = 0;
for (const l of txt.split('\n')) {
  if (!l.startsWith('data:')) continue;
  const p = l.slice(5).trim();
  if (!p || p === '[DONE]') continue;
  try {
    const o = JSON.parse(p);
    const d = o.choices?.[0]?.delta ?? {};
    if (d.content) contentFrames++;
    else if (d.reasoning_content) reasoningFrames++;
    else if (d.tool_calls) toolFrames++;
    else otherFrames++;
  } catch {}
}
console.log('');
console.log(`  帧统计: content=${contentFrames} reasoning=${reasoningFrames} tool_calls=${toolFrames} 其它=${otherFrames}`);

await shim.close();
process.exit(0);
