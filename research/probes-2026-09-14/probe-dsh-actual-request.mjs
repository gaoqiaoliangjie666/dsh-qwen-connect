// research/probes-2026-09-14/probe-dsh-actual-request.mjs
// 决定性诊断：起一个「探针 shim」，让 DSH 把请求发给它，从而看到
// DSH 真实发出的请求长什么样（而不是我猜测的形态）。
//
// 用法：脚本会打印一个 baseUrl；把插件临时指向它即可。
// 或者更简单：直接读 DSH 当前用的 baseUrl，对比我构造的请求。
import http from 'node:http';

// 起一个记录型服务器：完整打印收到的请求，然后返回一个简单的 SSE 成功响应
const seen = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seen.push({ url: req.url, method: req.method, headers: { ...req.headers }, body });
    console.log('════════ 收到请求 ════════');
    console.log(`  ${req.method} ${req.url}`);
    console.log(`  Content-Type: ${req.headers['content-type']}`);
    console.log(`  Authorization: ${String(req.headers.authorization ?? '').slice(0, 20)}...`);
    console.log(`  Body 长度: ${body.length} 字符`);
    try {
      const o = JSON.parse(body);
      console.log(`  顶层字段: ${Object.keys(o).join(', ')}`);
      console.log(`  model: ${o.model}`);
      console.log(`  stream: ${o.stream}`);
      console.log(`  messages 条数: ${Array.isArray(o.messages) ? o.messages.length : 'N/A'}`);
      if (Array.isArray(o.messages)) {
        for (const m of o.messages.slice(0, 3)) {
          const c = typeof m.content === 'string' ? m.content.slice(0, 40) : JSON.stringify(m.content).slice(0, 80);
          console.log(`    [${m.role}] ${c}`);
        }
      }
      console.log(`  tools: ${Array.isArray(o.tools) ? o.tools.length + ' 个' : '无'}`);
    } catch (e) {
      console.log(`  Body 前 200 字符: ${body.slice(0, 200)}`);
    }
    // 返回一个最小的合法 OpenAI SSE
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'pro', choices: [{ index: 0, delta: { content: 'probe-ok' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'pro', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
console.log(`探针服务器已启动: http://127.0.0.1:${port}/v1/chat/completions`);
console.log('等待请求…（把插件 baseUrl 指向这里，或在 DSH 里发一条消息）');
console.log('提示：本脚本只是诊断工具，不会修改任何配置。按 Ctrl+C 退出。\n');

// 60 秒后自动退出，避免挂住
setTimeout(() => {
  console.log(`\n共收到 ${seen.length} 个请求。退出。`);
  process.exit(0);
}, 60000);
