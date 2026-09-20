// research/probes-2026-09-14/probe-tool-loop.mjs
// 完整工具调用循环：user 问 → 模型调工具 → 回传结果 → 模型基于结果作答。
import { startChatShim } from '../../lib/chat-shim.js';
import { loadCredentials } from '../../lib/credentials.js';
import { DEFAULT_ENDPOINT } from '../../lib/signer-session.js';

const shim = await startChatShim({
  getCredential: async () => loadCredentials(),
  endpoint: DEFAULT_ENDPOINT,
  logger: { warn: () => {}, info: () => {} },
});

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '查询城市天气',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    },
  },
];

/** 发一轮流式请求，聚合 content / reasoning / tool_calls / finish_reason。 */
async function round(messages) {
  const res = await fetch(shim.baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.sharedSecret}` },
    body: JSON.stringify({ model: 'pro', stream: true, messages, tools: TOOLS }),
    signal: AbortSignal.timeout(90000),
  });
  const text = await res.text();
  let content = '', reasoning = '', finish = null;
  const toolCalls = [];
  // 流式 tool_calls 是**分片**（同名调用被拆成多个 delta，按 index 聚合）。
  // 之前直接 push 每个分片 → 第 2 轮回传时 id 错乱 → 模型又重复调工具。
  // 正确做法：按 index 合并，id 取首个非空，arguments 累积。
  const byIndex = new Map();
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const p = line.slice(5).trim();
    if (!p || p === '[DONE]') continue;
    try {
      const o = JSON.parse(p);
      const ch = o.choices?.[0];
      const d = ch?.delta ?? {};
      if (d.content) content += d.content;
      if (d.reasoning_content) reasoning += d.reasoning_content;
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const idx = tc.index ?? 0;
          const slot = byIndex.get(idx) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) slot.id = tc.id;
          if (tc.type) slot.type = tc.type;
          if (tc.function?.name) slot.function.name = tc.function.name;
          if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
          byIndex.set(idx, slot);
        }
      }
      if (ch?.finish_reason) finish = ch.finish_reason;
    } catch {}
  }
  for (const tc of [...byIndex.values()].sort((a, b) => a.index - b.index)) toolCalls.push(tc);
  return { status: res.status, content, reasoning, finish, hasToolCall: toolCalls.length > 0, toolCalls };
}

console.log('=== 第 1 轮：触发工具调用 ===');
const r1 = await round([{ role: 'user', content: '北京现在几度？用工具查一下。' }]);
console.log(`  HTTP ${r1.status} | finish=${r1.finish} | tool_calls=${r1.toolCalls.length}`);
if (r1.toolCalls.length > 0) {
  const name = r1.toolCalls[0].function?.name ?? '?';
  const args = r1.toolCalls.map((t) => t.function?.arguments ?? '').join('');
  console.log(`  工具名: ${name} | 参数: ${args}`);
}

console.log('\n=== 第 2 轮：回传工具结果，期望模型基于结果作答 ===');
// 构造工具结果（模拟 DSH 执行 get_weather 后把结果塞回历史）
const assistantToolCall = {
  role: 'assistant',
  content: '',
  tool_calls: r1.toolCalls.map((tc, i) => ({
    id: tc.id ?? `call_${i}`,
    type: 'function',
    function: { name: tc.function?.name, arguments: tc.function?.arguments ?? '{}' },
  })),
};
const toolResult = {
  role: 'tool',
  tool_call_id: r1.toolCalls[0]?.id ?? 'call_0',
  content: JSON.stringify({ city: '北京', temp: 28, condition: '晴' }),
};

const r2 = await round([
  { role: 'user', content: '北京现在几度？用工具查一下。' },
  assistantToolCall,
  toolResult,
]);
console.log(`  HTTP ${r2.status} | finish=${r2.finish} | 内容=${JSON.stringify(r2.content.slice(0, 80))}`);

const ok = r1.hasToolCall && r1.finish === 'tool_calls' && r2.content.length > 0;
console.log(`\n${ok ? '✅' : '❌'} 完整工具循环：调工具 → 回传 → 基于结果作答`);

await shim.close();
process.exit(ok ? 0 : 1);
