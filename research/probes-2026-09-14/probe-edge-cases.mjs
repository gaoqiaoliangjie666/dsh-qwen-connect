// research/probe-edge-cases.mjs
// 排查边界场景：超长输入、特殊字符、并发、空回复等。
import { startChatShim } from '../lib/chat-shim.js';
import { loadCredentials } from '../lib/credentials.js';
import { DEFAULT_ENDPOINT } from '../lib/signer-session.js';

const shim = await startChatShim({
  getCredential: async () => loadCredentials(),
  endpoint: DEFAULT_ENDPOINT,
  logger: { warn: (...a) => console.log('  [warn]', ...a.map((x) => String(x).slice(0, 100))) },
});

async function probe(label, body, expect = 200) {
  const t0 = Date.now();
  try {
    const res = await fetch(shim.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.sharedSecret}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const txt = await res.text();
    let ans = '';
    let err = null;
    for (const l of txt.split('\n')) {
      if (!l.startsWith('data:')) continue;
      const p = l.slice(5).trim();
      if (!p || p === '[DONE]') continue;
      try {
        const o = JSON.parse(p);
        if (o.error) err = o.error.message;
        for (const c of o.choices ?? []) if (c.delta?.content) ans += c.delta.content;
      } catch {}
    }
    const mark = res.status === expect ? '✅' : '⚠️';
    console.log(`  ${mark} ${label}: HTTP ${res.status} | ${Date.now() - t0}ms | 答=${JSON.stringify(ans.slice(0, 40))}${err ? ' | err=' + err.slice(0, 50) : ''}`);
    return { status: res.status, answer: ans, error: err };
  } catch (e) {
    console.log(`  ❌ ${label}: 异常 ${e.message.slice(0, 80)}`);
    return { error: e.message };
  }
}

console.log('=== 边界场景 ===');
// 1. 特殊字符（引号、换行、emoji、控制字符）
await probe('特殊字符', { model: 'pro', stream: true, messages: [{ role: 'user', content: '原样回复：a"b\'c\\d\ne\tf 🎉 <tag>' }] });
// 2. 超长输入
await probe('超长输入(4000字)', { model: 'pro', stream: true, messages: [{ role: 'user', content: '重复一遍：' + '测'.repeat(4000) }] });
// 3. content 为数组（多模态格式，无图片）
await probe('content数组', { model: 'pro', stream: true, messages: [{ role: 'user', content: [{ type: 'text', text: '说：好' }] }] });
// 4. 含图片块（应降级为占位符，不崩）
await probe('含图片块', { model: 'pro', stream: true, messages: [{ role: 'user', content: [{ type: 'text', text: '图里有啥？' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBOR' } }] }] });
// 5. 空 content
await probe('空content', { model: 'pro', stream: true, messages: [{ role: 'user', content: '' }] }, 400);
// 6. 仅 system
await probe('仅system', { model: 'pro', stream: true, messages: [{ role: 'system', content: '你是助手' }] }, 400);
// 7. 深历史（20 轮）
const hist = [];
for (let i = 0; i < 10; i++) { hist.push({ role: 'user', content: `第${i}轮问题` }, { role: 'assistant', content: `第${i}轮回答` }); }
hist.push({ role: 'user', content: '一共聊了几轮？' });
await probe('20轮历史', { model: 'pro', stream: true, messages: hist });
// 8. flash 模型
await probe('flash模型', { model: 'flash', stream: true, messages: [{ role: 'user', content: '说：好' }] });
// 9. qwen3.8-max-preview
await probe('max-preview', { model: 'qwen3.8-max-preview', stream: true, messages: [{ role: 'user', content: '说：好' }] });

await shim.close();
process.exit(0);
