import { parseQwenWorkFrame } from '../lib/sse.js';

// 复刻测试里的辅助函数
function envelope(body, extra = {}) {
  return `data:${JSON.stringify({ ...extra, body: typeof body === 'string' ? body : JSON.stringify(body) })}`;
}
function chunkFrame(delta, finishReason = undefined) {
  return envelope(
    JSON.stringify({
      choices: [{ delta, index: 0, ...(finishReason === undefined ? {} : { finish_reason: finishReason }) }],
      object: 'chat.completion.chunk',
    }),
    { statusCodeValue: 200, statusCode: 'OK', headers: { 'X-Model-Name': ['glm-5.2'] } },
  );
}

const frame = chunkFrame({}, 'stop');
console.log('frame 原文:', frame);
// 去掉 data: 前缀后就是 payload
const payload = frame.slice(5);
console.log('payload:', payload);
const r = parseQwenWorkFrame(payload);
console.log('result:', JSON.stringify(r));

console.log('\n--- 对比：chunkFrame({content:"x"}) ---');
const f2 = chunkFrame({ content: 'x' }).slice(5);
console.log('result:', JSON.stringify(parseQwenWorkFrame(f2)));
