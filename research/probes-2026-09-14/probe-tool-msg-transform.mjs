// research/probes-2026-09-14/probe-tool-msg-transform.mjs
// 验证 toQwenWorkMessages 对 tool 循环历史的转换是否保真。
import { toQwenWorkMessages } from '../../lib/chat-shim.js';

const history = [
  { role: 'user', content: '北京现在几度？用工具查一下。' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'call_abc123', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }],
  },
  { role: 'tool', tool_call_id: 'call_abc123', content: '{"city":"北京","temp":28,"condition":"晴"}' },
];

const out = toQwenWorkMessages({ messages: history });
console.log('转换后:');
for (const [i, m] of out.entries()) {
  console.log(`  [${i}] role=${m.role} | keys=${Object.keys(m).join(',')}`);
  if (m.tool_calls) console.log(`       tool_calls[0].id=${m.tool_calls[0]?.id}`);
  if (m.tool_call_id) console.log(`       tool_call_id=${m.tool_call_id}`);
  if (m.content !== undefined) console.log(`       content=${JSON.stringify(String(m.content).slice(0, 60))}`);
}
