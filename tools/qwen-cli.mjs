// tools/qwen-cli.mjs
// 命令行直接调 QwenWork 接口（绕过 DSH GUI）。
// 用法：node tools/qwen-cli.mjs [model] [你的问题]
//   默认 model = pro
//   示例：node tools/qwen-cli.mjs flash 你叫什么名字
import http from 'node:http';

const PORT = Number(process.env.DSH_PORT ?? 58281);
const HOST = '127.0.0.1';
const model = process.argv[2] ?? 'pro';
const question = process.argv[3] ?? '只回复四个字：验证成功';

async function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: HOST, port: PORT, path, method: 'GET', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
          catch { resolve({ status: res.statusCode, body }); }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function post(path, jsonBody) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(jsonBody);
    const req = http.request(
      {
        host: HOST, port: PORT, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
          catch { resolve({ status: res.statusCode, body }); }
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// 1) 状态
const status = await get('/plugins/dsh-qwen-connect/status');
console.log(`[1] 插件状态 HTTP ${status.status}`);
console.log(`    ${status.body.nickname ?? '?'} / ${status.body.tierName ?? '?'} / 积分 ${status.body.remaining ?? '?'}`);

// 2) 找 baseUrl（shim 鉴权密钥要从 settings 路由拿到，或经 pi-ai 通道拿——
//    GUI 内会自动走通；脚本直接调用要拿到当前密钥，路径见下）
//
// 注：GUI 模式下，DSH 内部的 pi-ai adapter 会自动经 resolveApiKey 拿到密钥，
// 直接 POST 到 DSH 的 LLM API 端点。
const list = await get('/api/models');
console.log(`\2] 模型清单 HTTP ${list.status}`);

// 3) 走 DSH 内部 LLM API（推荐做法，复用 GUI 的鉴权链路）
const chat = await post('/api/chat', {
  provider: 'qwenwork',
  model,
  messages: [{ role: 'user', content: question }],
  stream: false,
});
console.log(`\n[3] 第 1 轮 HTTP ${chat.status}`);
console.log(`    回答：${chat.body?.message?.content ?? chat.body?.choices?.[0]?.message?.content ?? JSON.stringify(chat.body).slice(0, 200)}`);

// 4) 多轮（拿上轮回答当上下文）
const prevAnswer = chat.body?.message?.content ?? chat.body?.choices?.[0]?.message?.content ?? '';
if (prevAnswer) {
  const chat2 = await post('/api/chat', {
    provider: 'qwenwork',
    model,
    messages: [
      { role: 'user', content: question },
      { role: 'assistant', content: prevAnswer },
      { role: 'user', content: '我刚才让你回复哪四个字？' },
    ],
    stream: false,
  });
  console.log(`\n[4] 第 2 轮 HTTP ${chat2.status}`);
  console.log(`    回答：${chat2.body?.message?.content ?? chat2.body?.choices?.[0]?.message?.content ?? JSON.stringify(chat2.body).slice(0, 200)}`);
}