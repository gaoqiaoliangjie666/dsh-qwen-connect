// research/probe-error-frame.mjs
// 验证：shim 发出的 error 帧能否被 pi-ai 识别为「流内错误」。
import http from 'node:http';

import { startChatShim } from '../lib/chat-shim.js';
import { loadCredentials } from '../lib/credentials.js';
import { DEFAULT_ENDPOINT } from '../lib/signer-session.js';

// 起一个假上游，故意返回错误信封
const upstream = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  // 模拟上游在流中途报告错误（我们的 shim 会把它转成 OpenAI error 帧）
  res.write(
    'data:' +
      JSON.stringify({
        headers: { 'Content-Type': ['application/json'] },
        body: JSON.stringify({ code: '403', message: 'Model is not available for this user' }),
        statusCodeValue: 200,
        statusCode: 'OK',
      }) +
      '\n\n',
  );
  res.end();
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

const shim = await startChatShim({
  getCredential: async () => loadCredentials(),
  endpoint: `http://127.0.0.1:${upstream.address().port}`,
  logger: { warn: () => {}, info: () => {} },
});

console.log('shim:', shim.baseUrl);
const res = await fetch(shim.baseUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.sharedSecret}` },
  body: JSON.stringify({ model: 'pro', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
});
console.log('HTTP', res.status, '| content-type:', res.headers.get('content-type'));
const text = await res.text();
console.log('原始响应:');
console.log(text);

await shim.close();
upstream.close();
process.exit(0);
