// research/probes-2026-09-14/debug-idle-watchdog.mjs
// 精确复现「流中途静默」场景，看 shim 为什么返回 502。
import http from 'node:http';
import { createChatShimHandler } from '../../lib/chat-shim.js';

const upstream = http.createServer((req, res) => {
  req.resume();
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const frame = `data:${JSON.stringify({
    headers: { 'X-Model-Name': ['glm-5.2'] },
    body: JSON.stringify({ choices: [{ delta: { content: '开头' }, index: 0 }] }),
    statusCodeValue: 200,
  })}`;
  res.write(frame + '\n\n');
  // 保持连接不结束
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upUrl = `http://127.0.0.1:${upstream.address().port}/upstream`;
console.log('上游:', upUrl);

const handler = createChatShimHandler({
  getCredential: async () => ({ token: 't', user: { id: 'u' }, loginDeviceId: 'd' }),
  endpoint: upUrl,
  sharedSecret: 'sec',
  getIdleTimeoutMs: 500,
  logger: { warn: (...a) => console.log('  [warn]', ...a.map(String).map((s) => s.slice(0, 120))) },
  signerFactory: async () => ({
    describe: () => ({}),
    dispose: () => {},
    signInferRequest: (bodyJson) => ({
      url: upUrl,
      headers: { 'Content-Type': 'application/json' },
      body: bodyJson,
      headerCount: 1,
    }),
  }),
});

const server = http.createServer((req, res) => {
  if (!req.url?.startsWith('/v1/chat/completions')) return void res.writeHead(404).end('{}');
  handler(req, res).catch((e) => console.log('  handler 异常:', e.message));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const t0 = Date.now();
const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sec' },
  body: JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: 'hi' }] }),
  signal: AbortSignal.timeout(10000),
});
const text = await res.text();
console.log(`HTTP ${res.status} | ${Date.now() - t0}ms`);
console.log('响应:', JSON.stringify(text.slice(0, 300)));

server.close();
upstream.closeAllConnections?.();
upstream.close();
process.exit(0);
