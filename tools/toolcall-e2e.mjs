// tools/toolcall-e2e.mjs
// 端到端验证：带 tools 的真实请求，模型是否返回结构化 tool_calls（而非自由文本）。
import { startChatShim } from '../lib/chat-shim.js';
import { loadCredentials } from '../lib/credentials.js';
import { DEFAULT_ENDPOINT } from '../lib/signer-session.js';

const cred = await loadCredentials();
const shim = await startChatShim({
  getCredential: async () => loadCredentials(),
  endpoint: DEFAULT_ENDPOINT,
  logger: { warn: (...a) => console.error('[warn]', ...a.map((x) => String(x).slice(0, 150))) },
});

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '查询指定城市的当前天气',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: '城市名，例如 北京' },
        },
        required: ['city'],
      },
    },
  },
];

const t0 = Date.now();
const res = await fetch(shim.baseUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.sharedSecret}` },
  body: JSON.stringify({
    model: 'pro',
    stream: true,
    messages: [{ role: 'user', content: '北京现在天气怎么样？请调用工具查询。' }],
    tools: TOOLS,
  }),
});

console.log(`HTTP ${res.status} | ${shim.baseUrl}\n`);

const decoder = new TextDecoder('utf-8');
let buf = '';
let content = '';
let reasoning = '';
const toolCalls = new Map();
let finish = null;

for await (const chunk of res.body) {
  buf += decoder.decode(chunk, { stream: true });
  const evs = buf.split('\n\n');
  buf = evs.pop() ?? '';
  for (const e of evs) {
    if (!e.startsWith('data:')) continue;
    const p = e.slice(5).trim();
    if (!p || p === '[DONE]') continue;
    try {
      const o = JSON.parse(p);
      const ch = o.choices?.[0];
      if (!ch) continue;
      const d = ch.delta ?? {};
      if (d.content) content += d.content;
      if (d.reasoning_content) reasoning += d.reasoning_content;
      for (const tc of d.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const slot = toolCalls.get(idx) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) slot.id = tc.id;
        if (tc.type) slot.type = tc.type;
        if (tc.function?.name) slot.function.name = tc.function.name;
        if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
        toolCalls.set(idx, slot);
      }
      if (ch.finish_reason) finish = ch.finish_reason;
    } catch {}
  }
}
buf += decoder.decode();

console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s | finish_reason=${finish}`);
console.log(`\n[正文 content] ${content.length} 字符:`);
console.log('  ' + JSON.stringify(content.slice(0, 300)));
console.log(`\n[思考链 reasoning] ${reasoning.length} 字符`);

console.log(`\n[工具调用 tool_calls] ${toolCalls.size} 个:`);
if (toolCalls.size === 0) {
  console.log('  ❌ 无结构化工具调用');
  if (content.includes('<tool_call>') || content.includes('<invoke')) {
    console.log('  ⚠️  检测到自由文本形式的工具调用（<tool_call>/<invoke>）——正是要修的问题');
  }
} else {
  for (const [idx, tc] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  #${idx} id=${tc.id || '(无)'} name=${tc.function.name}`);
    console.log(`      arguments=${tc.function.arguments}`);
  }
}

await shim.close();
console.log('\nshim 已关闭');
