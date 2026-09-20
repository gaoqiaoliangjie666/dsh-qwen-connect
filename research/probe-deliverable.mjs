// 最终验证：通过交付模块 qwen-signer.mjs 跑通一次真实对话
import { createContext, chatStream } from './qwen-signer.mjs';
import { loadAuth } from './creds.mjs';

const auth = loadAuth();
const ctx = createContext(auth);

console.log('=== 发起真实对话请求 ===');
const res = await chatStream(ctx, [
  { role: 'user', content: '用一句话回答：1+1 等于几？' },
]);
console.log('HTTP', res.status, res.statusText, '| content-type:', res.headers.get('content-type'));

const raw = await res.text();
const lines = raw.split('\n').filter(l => l.startsWith('data:'));

let text = '';
let reasoning = '';
let finish = '';
let firstFrame = '';

for (const line of lines) {
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') continue;
  let outer;
  try { outer = JSON.parse(payload); } catch { continue; }
  if (!firstFrame) firstFrame = payload.slice(0, 300);
  if (outer.statusCodeValue && outer.statusCodeValue !== 200) {
    console.log('非 200 帧:', payload.slice(0, 300));
    continue;
  }
  let inner;
  try { inner = typeof outer.body === 'string' ? JSON.parse(outer.body) : outer.body; } catch { continue; }
  const d = inner?.choices?.[0]?.delta;
  if (d) {
    if (d.reasoning_content) reasoning += d.reasoning_content;
    if (d.content) text += d.content;
  }
  if (inner?.choices?.[0]?.finish_reason) finish = inner.choices[0].finish_reason;
}

console.log('\n首帧原文:', firstFrame);
console.log('\n帧数:', lines.length);
console.log('reasoning:', reasoning.slice(0, 200));
console.log('回答:', text);
console.log('finish_reason:', finish || '(未显式给出)');
console.log('\n>>> 结论:', res.status === 200 && (text || reasoning) ? '真实对话已跑通 ✅' : '需进一步排查 ❌');
