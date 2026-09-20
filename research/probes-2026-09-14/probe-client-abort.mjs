// research/probes-2026-09-14/probe-client-abort.mjs
// 客户端在「请求体传输中途」断开 —— shim 是否泄漏挂起的 Promise。
import http from 'node:http';
import net from 'node:net';
import { createChatShimHandler } from '../../lib/chat-shim.js';

let settled = 0;
const handler = createChatShimHandler({
  getCredential: async () => ({ token: 't', user: { id: 'u' }, loginDeviceId: 'd' }),
  endpoint: 'http://127.0.0.1:1/never',
  sharedSecret: 'sec',
  signerFactory: async () => {
    throw new Error('should not reach signer');
  },
});

const server = http.createServer((req, res) => {
  if (!req.url?.startsWith('/v1/chat/completions')) return void res.writeHead(404).end('{}');
  handler(req, res)
    .then(() => { settled++; })
    .catch(() => { settled++; });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

console.log('=== 场景：发部分请求体后立即断开 ===');
for (let i = 0; i < 3; i++) {
  await new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => {
      // 声明 Content-Length 为 1000，但只发 10 字节就断开
      s.write(
        'POST /v1/chat/completions HTTP/1.1\r\n' +
          `Host: 127.0.0.1:${port}\r\n` +
          'Content-Type: application/json\r\n' +
          'Authorization: Bearer sec\r\n' +
          'Content-Length: 1000\r\n\r\n' +
          '{"model":',
      );
      setTimeout(() => { s.destroy(); resolve(); }, 100);
    });
    s.on('error', () => resolve());
  });
}

// 给 handler 一点时间 settle
await new Promise((r) => setTimeout(r, 3000));
console.log(`  断开 3 次后，handler settled 次数: ${settled}`);
console.log(`  ${settled >= 3 ? '✅ 每次断开都被结算（无泄漏）' : `❌ 有 ${3 - settled} 个 Promise 永久挂起（连接泄漏）`}`);

// 再测一次正常请求是否仍能工作（前一次泄漏不应影响后续）
const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sec' },
  body: JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: 'hi' }] }),
});
console.log(`  后续正常请求: HTTP ${res.status} ${res.status === 502 ? '（预期 502，因上游是假地址）' : ''}`);

server.closeAllConnections?.();
server.close();
process.exit(settled >= 3 ? 0 : 1);
