// 排查：shim 响应后连接为何不关闭（5020ms = 5s 超时兜底）
import net from 'node:net';
import { startChatShim } from '../lib/chat-shim.js';

const shim = await startChatShim({
  getCredential: async () => { throw new Error('no cred'); },
});

const t0 = Date.now();
const socket = net.connect(shim.port, '127.0.0.1', () => {
  const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });
  socket.write([
    'POST /v1/chat/completions HTTP/1.1',
    `Host: 127.0.0.1:${shim.port}`,
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Connection: close',
    '',
    body,
  ].join('\r\n'));
});

const chunks = [];
socket.on('data', (c) => { chunks.push(c); console.log(`  +data @${Date.now() - t0}ms: ${c.length}B`); });
socket.on('end', () => console.log(`  END @${Date.now() - t0}ms`));
socket.on('close', () => console.log(`  CLOSE @${Date.now() - t0}ms`));

await new Promise((r) => setTimeout(r, 3000));
console.log('\n收到:', Buffer.concat(chunks).toString('utf8').slice(0, 300));
socket.destroy();
await shim.close();
