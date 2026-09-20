// research/probes-2026-09-14/diag-firstframe.mjs
// 诊断：新加的 first-frame 计时器是否误杀正常路径。
import http from 'node:http';
import { createChatShimHandler } from '../../lib/chat-shim.js';

function envelope(body) {
  return `data:${JSON.stringify({ body: typeof body === 'string' ? body : JSON.stringify(body) })}`;
}
function chunkFrame(delta, finish) {
  return envelope(JSON.stringify({
    choices: [{ delta, index: 0, ...(finish ? { finish_reason: finish } : {}) }],
  }));
}

const upstream = http.createServer(async (req, res) => {
  req.resume();
  await new Promise((r) => req.on('end', r));
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(chunkFrame({ content: 'ok' }) + '\n\n');
  res.write(chunkFrame({}, 'stop') + '\n\n');
  res.end();
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

const handler = createChatShimHandler({
  getCredential: async () => ({ token: 't', user: { id: 'u' }, loginDeviceId: 'd' }),
  endpoint: `http://127.0.0.1:${upstream.address().port}/upstream`,
  sharedSecret: 's',
  getIdleTimeoutMs: 30000,
  getHeaderTimeoutMs: 30000,
});
const server = http.createServer((req, res) => {
  if (!req.url?.startsWith('/v1/chat/completions')) return void res.writeHead(404).end('{}');
  handler(req, res).catch(() => {});
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const t0 = Date.now();
const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer s' },
  body: JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: 'hi' }] }),
  signal: AbortSignal.timeout(10000),
});
const txt = await res.text();
console.log(`HTTP ${res.status} | ${Date.now() - t0}ms | 帧数=${txt.split('data:').length - 1}`);
console.log('响应前 200 字符:', JSON.stringify(txt.slice(0, 200)));

server.close();
upstream.close();
process.exit(0);
