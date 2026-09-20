import { parseQwenWorkFrame } from '../lib/sse.js';

const inner = JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: 'stop' }], object: 'chat.completion.chunk' });
const payload = JSON.stringify({ statusCodeValue: 200, statusCode: 'OK', headers: { 'X-Model-Name': ['glm-5.2'] }, body: inner });
console.log('payload:', payload);
const f = parseQwenWorkFrame(payload);
console.log('result:', JSON.stringify(f));

// 检查 inner 解析
const outer = JSON.parse(payload);
console.log('\nouter.body type:', typeof outer.body);
const parsedInner = JSON.parse(outer.body);
console.log('inner.choices:', JSON.stringify(parsedInner.choices));

// 检查 choice.delta
const c = parsedInner.choices[0];
console.log('choice:', JSON.stringify(c));
console.log('c.delta:', JSON.stringify(c.delta), 'typeof:', typeof c.delta);
console.log('rawDelta.content:', typeof c.delta.content);
console.log('rawDelta.reasoning_content:', typeof c.delta.reasoning_content);
