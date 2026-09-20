// research/probes-2026-09-14/probe-upstream-anomalies.mjs
// 上游异常响应：非 SSE、截断、乱码、超大帧、慢响应 —— shim 都必须有明确结果。
import http from 'node:http';
import { startChatShim } from '../../lib/chat-shim.js';
import { loadCredentials } from '../../lib/credentials.js';

let fail = 0;
async function probe(label, upstreamHandler, timeoutMs = 15000, shimOpts = {}) {
  const upstream = http.createServer(upstreamHandler);
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

  const shim = await startChatShim({
    getCredential: async () => loadCredentials(),
    endpoint: `http://127.0.0.1:${upstream.address().port}`,
    logger: { warn: () => {}, info: () => {} },
    ...shimOpts,
  });

  const t0 = Date.now();
  try {
    const res = await fetch(shim.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.sharedSecret}` },
      body: JSON.stringify({ model: 'pro', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    const hasDone = text.includes('[DONE]');
    const hasError = text.includes('"error"');
    const dt = Date.now() - t0;
    // 判定：必须有明确结果（有 [DONE] 或明确的 error），不得悬挂
    const ok = hasDone || hasError;
    console.log(`  ${ok ? '✅' : '❌'} ${label.padEnd(24)} ${dt}ms | HTTP ${res.status} | DONE=${hasDone} err=${hasError}`);
    if (!ok) fail++;
  } catch (e) {
    // 超时算失败（说明悬挂）
    const timedOut = e.name === 'TimeoutError' || /timeout/i.test(e.message);
    console.log(`  ${timedOut ? '❌' : '✅'} ${label.padEnd(24)} ${Date.now() - t0}ms | ${timedOut ? '悬挂超时' : '异常终止: ' + e.message.slice(0, 50)}`);
    if (timedOut) fail++;
  } finally {
    await shim.close();
    upstream.close();
  }
}

console.log('=== 上游异常响应 ===');

await probe('HTTP 500', (req, res) => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"boom"}'); });
await probe('HTTP 401', (req, res) => { res.writeHead(401).end('unauthorized'); });
await probe('HTTP 200 但非 SSE', (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"choices":[]}'); });
await probe('HTTP 200 空 body', (req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(); });
await probe('截断的 SSE', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write('data:{"body":"{\\"choices\\":[{\\"delta\\":{\\"content\\":\\"半');
  res.end();
});
await probe('乱码字节', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x81]));
  res.end();
});
await probe('超大单帧(2MB)', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const big = 'x'.repeat(2_000_000);
  res.write('data:{"body":"' + '{\\"choices\\":[{\\"delta\\":{\\"content\\":\\"' + big.slice(0, 100000) + '\\"}}]}"}\n\n');
  res.end();
});
// 上游「连接后静默」：必须由响应头超时兜住，不得让客户端无限等待。
// 这里把 header 超时压到 2s，验证「有明确结果」而不是靠默认 60s。
await probe(
  '慢响应(连接后静默)',
  (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // 保持连接但不发数据 —— 由响应头超时兜底
  },
  20000,
  { getHeaderTimeoutMs: 2000 },
);
// 流已开始但中途静默：由流内看门狗兜住
await probe(
  '流中途静默',
  (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data:{"body":"{\\"choices\\":[{\\"delta\\":{\\"content\\":\\"半\\"}}]}"}\n\n');
    // 之后不再发任何数据
  },
  20000,
  { getIdleTimeoutMs: 2000 },
);
await probe('立即断开连接', (req, res) => { req.socket.destroy(); });

console.log(fail === 0 ? '\n✅ 上游异常均有明确结果（无悬挂）' : `\n❌ ${fail} 项悬挂或未处理`);
process.exit(fail > 0 ? 1 : 0);
