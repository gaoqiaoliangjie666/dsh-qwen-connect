// t7 端到端验证：真实 shim + 共享密钥，多轮对话
const { startChatShim } = await import('../lib/chat-shim.js');
const { loadCredentials } = await import('../lib/credentials.js');
const { DEFAULT_ENDPOINT } = await import('../lib/signer-session.js');

const cred = await loadCredentials();
console.log('凭据 OK | tokenLen =', cred.credentials?.token?.length ?? cred.token?.length);

const shim = await startChatShim({
  getCredential: async () => loadCredentials(),
  endpoint: DEFAULT_ENDPOINT,
  logger: { warn: (...a) => console.log('  [warn]', ...a.map(String).map(s=>s.slice(0,120))) },
});
console.log('shim 就绪 | baseUrl =', shim.baseUrl);
console.log('共享密钥存在:', typeof shim.sharedSecret === 'string' && shim.sharedSecret.length === 43);

async function chat(label, messages) {
  const t0 = Date.now();
  const res = await fetch(shim.baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${shim.sharedSecret}`,
    },
    body: JSON.stringify({ model: 'pro', stream: false, messages }),
    signal: AbortSignal.timeout(90000),
  });
  const txt = await res.text();
  console.log(`\n--- ${label} ---`);
  console.log('HTTP', res.status, '|', Date.now() - t0, 'ms | len', txt.length);
  // 提取回答内容
  const answers = [];
  for (const line of txt.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const p = line.slice(5).trim();
    if (!p || p === '[DONE]') continue;
    try {
      const obj = JSON.parse(p);
      const inner = typeof obj.body === 'string' ? JSON.parse(obj.body) : obj;
      for (const ch of inner.choices ?? []) {
        if (ch.delta?.content) answers.push(ch.delta.content);
      }
    } catch {}
  }
  console.log('回答:', answers.join('').slice(0, 100) || txt.slice(0, 120));
  return res.status;
}

// 无密钥应 401
const noKey = await fetch(shim.baseUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: 'hi' }] }),
});
console.log('\n无密钥请求状态:', noKey.status, '(应 401)');

await chat('第1轮（带密钥）', [{ role: 'user', content: '只回复四个字：验证成功' }]);
await chat('第2轮（多轮上下文）', [
  { role: 'user', content: '只回复四个字：验证成功' },
  { role: 'assistant', content: '验证成功' },
  { role: 'user', content: '我刚才让你回复哪四个字？' },
]);

await shim.close();
console.log('\nshim 已关闭');
