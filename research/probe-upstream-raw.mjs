// 排查：第 1 轮为什么混入无关内容？检查实际发给上游的 body vs 收到的原始帧
import { startChatShim } from '../lib/chat-shim.js';
import { loadCredentials } from '../lib/credentials.js';
import { createSignerSession, buildInferBody } from '../lib/signer-session.js';

const cred = loadCredentials();

// 直接用签名会话发请求，打印原始上游 SSE 帧（不经过 shim 转换）
const session = await createSignerSession({ credential: cred });
console.log('session:', JSON.stringify(session.describe()));

const messages = [{ role: 'user', content: '我叫小明。请只回答"好的"。' }];
const bodyJson = buildInferBody({ messages, modelKey: 'pro' });
console.log('\n发给上游的 body:', bodyJson);

const signed = session.signInferRequest(bodyJson, { modelKey: 'pro', modelSource: 'system' });
console.log('签名 headers keys:', Object.keys(signed.headers).join(', '));
console.log('签名后 body (前 100):', signed.body.slice(0, 100));

const res = await fetch(signed.url, { method: 'POST', headers: signed.headers, body: signed.body });
console.log('\nHTTP', res.status);

const text = await res.text();
const frames = text.split('\n').filter(l => l.startsWith('data:'));
console.log('上游帧数:', frames.length);
console.log('\n--- 上游原始帧（前 3 帧完整）---');
for (const f of frames.slice(0, 3)) {
  console.log(JSON.stringify(f.slice(0, 400)));
}
console.log('\n--- 最后一帧 ---');
console.log(JSON.stringify(frames[frames.length - 1]?.slice(0, 400)));

// 统计 content 总长
let content = '';
for (const f of frames) {
  try {
    const o = JSON.parse(f.slice(5).trim());
    const inner = typeof o.body === 'string' ? JSON.parse(o.body) : o.body;
    const d = inner?.choices?.[0]?.delta;
    if (d?.content) content += d.content;
  } catch { }
}
console.log('\n上游 content 总长:', content.length);
console.log('上游 content 前 200:', JSON.stringify(content.slice(0, 200)));
console.log('上游 content 后 200:', JSON.stringify(content.slice(-200)));
