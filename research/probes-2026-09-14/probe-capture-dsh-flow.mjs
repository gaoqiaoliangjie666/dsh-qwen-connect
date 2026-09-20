// research/probes-2026-09-14/probe-capture-dsh-flow.mjs
// 决定性诊断：架一个「记录型 shim」在固定端口（18080），透传到真实上游，
// 同时完整记录「从 DSH 收到请求」与「从上游收到每个字节」的时刻。
//
// 用法（两步）：
//   1. 本脚本启动后监听 127.0.0.1:18080
//   2. 临时把 profiles/web/node_modules/dsh-qwen-connect/lib/index.js 的
//      baseUrl 指向 http://127.0.0.1:18080/v1/chat/completions（诊断完还原）
//   3. 在 DSH 里发一条会触发长思考的消息
//   4. 本脚本打印每帧的间隔，即可看到「上游到底卡在哪一段」
//
// ⚠️ 本脚本只是诊断工具；不改任何配置。
import http from 'node:http';
import { startChatShim } from '../../lib/chat-shim.js';
import { loadCredentials } from '../../lib/credentials.js';
import { DEFAULT_ENDPOINT } from '../../lib/signer-session.js';

const UPSTREAM_PORT = 18081;

// ---- 内层：真实 shim（带签名）监听 18081 ----
const inner = await startChatShim({
  getCredential: async () => loadCredentials(),
  endpoint: DEFAULT_ENDPOINT,
  logger: { warn: () => {}, info: () => {} },
});
console.log(`[内层] 真实 shim: ${inner.baseUrl}`);

// ---- 外层：记录型代理监听 18080，转发给 18081 ----
let reqCount = 0;
const server = http.createServer((clientReq, clientRes) => {
  const id = ++reqCount;
  const t0 = Date.now();
  const frames = [];
  let lastFrameAt = t0;
  let firstByteAt = null;

  console.log(`\n════ #${id} DSH 请求进入 ${new Date(t0).toLocaleTimeString()} ════`);
  console.log(`  ${clientReq.method} ${clientReq.url}`);

  const chunks = [];
  clientReq.on('data', (c) => chunks.push(c));
  clientReq.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    console.log(`  请求体 ${Math.round(body.length / 1024)}KB`);
    try {
      const o = JSON.parse(body);
      console.log(`  model=${o.model} | messages=${Array.isArray(o.messages) ? o.messages.length : '?'} 条 | tools=${Array.isArray(o.tools) ? o.tools.length : 0}`);
    } catch {}

    // 转发给真实 shim
    const up = http.request(
      {
        host: '127.0.0.1',
        port: inner.port,
        path: clientReq.url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${inner.sharedSecret}`, 'Content-Length': Buffer.byteLength(body) },
      },
      (upRes) => {
        console.log(`  [${Date.now() - t0}ms] 上游响应头 ${upRes.statusCode}`);
        clientRes.writeHead(upRes.statusCode, upRes.headers);
        upRes.on('data', (c) => {
          if (firstByteAt === null) firstByteAt = Date.now();
          const now = Date.now();
          const gap = now - lastFrameAt;
          if (gap > 1000) frames.push({ gap, at: now - t0 });
          lastFrameAt = now;
          clientRes.write(c);
        });
        upRes.on('end', () => {
          clientRes.end();
          console.log(`  [${Date.now() - t0}ms] 流结束`);
          frames.sort((a, b) => b.gap - a.gap);
          console.log(`  >1s 的帧间隔 ${frames.length} 个：`);
          for (const f of frames.slice(0, 8)) console.log(`     ${f.gap}ms @ 流开始后 ${f.at}ms`);
          if (frames.length === 0) console.log('     （无 >1s 间隔——流是连续的）');
        });
        upRes.on('error', (e) => {
          console.log(`  [${Date.now() - t0}ms] 上游错误: ${e.message}`);
          try { clientRes.end(); } catch {}
        });
      },
    );
    up.on('error', (e) => {
      console.log(`  [${Date.now() - t0}ms] 转发失败: ${e.message}`);
      try { clientRes.writeHead(502); clientRes.end(JSON.stringify({ error: { message: e.message } })); } catch {}
    });
    up.write(body);
    up.end();
  });
});

await new Promise((r) => server.listen(18080, '127.0.0.1', r));
console.log(`\n[外层] 记录代理已启动: http://127.0.0.1:18080/v1/chat/completions`);
console.log('请在 DSH 里发一条长思考消息；观察输出。120 秒后自动退出。');
setTimeout(() => process.exit(0), 120000);
