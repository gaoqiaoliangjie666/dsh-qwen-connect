// 队长端到端验证：按 index.js 的真实调用方式启动 shim 并发起对话
const { startChatShim } = await import('../lib/chat-shim.js');
const { loadCredentials } = await import('../lib/credentials.js');
const { DEFAULT_ENDPOINT } = await import('../lib/signer-session.js');

console.log('=== 按 index.js 的方式启动 shim ===');
const shim = await startChatShim({
  getCredential: async () => loadCredentials(),
  endpoint: DEFAULT_ENDPOINT,
  logger: { warn: (...a) => console.log('  [warn]', ...a), info: () => {}, debug: () => {} },
});
console.log('baseUrl =', shim.baseUrl);

// baseUrl 形如 http://127.0.0.1:<port>/v1/chat/completions，直接用
async function chat(label, body) {
  const t0 = Date.now();
  try {
    const res = await fetch(shim.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    });
    const txt = await res.text();
    console.log(`\n--- ${label} ---`);
    console.log('HTTP', res.status, '|', Date.now() - t0, 'ms | len', txt.length);
    console.log(txt.slice(0, 500));
    return txt;
  } catch (e) {
    console.log(`\n--- ${label} ---\n请求失败: ${e.message}`);
  }
}

// 第一轮
await chat('第1轮 · 非流式', {
  model: 'pro',
  stream: false,
  messages: [{ role: 'user', content: '请只回复四个字：队长验证' }],
});

// 第二轮（多轮上下文，验证能否引用第一轮）
await chat('第2轮 · 多轮上下文', {
  model: 'pro',
  stream: false,
  messages: [
    { role: 'user', content: '请只回复四个字：队长验证' },
    { role: 'assistant', content: '队长验证成功' },
    { role: 'user', content: '我刚才让你回复的是哪四个字？只回复那四个字。' },
  ],
});

await shim.close?.();
console.log('\nshim 已关闭');
