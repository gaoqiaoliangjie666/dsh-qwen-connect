// research/probes-2026-09-14/probe-context-limit2.mjs
// 第二轮：逼近与超过 1M，确定真实上限。
import { createSignerSession, DEFAULT_ENDPOINT } from '../../lib/signer-session.js';
import { loadCredentials } from '../../lib/credentials.js';

const cred = await loadCredentials();
const session = await createSignerSession({ credential: cred, endpoint: DEFAULT_ENDPOINT });

function buildMessages(approxTokens) {
  const chars = Math.floor(approxTokens * 1.4);
  const unit = '这是一段用于测试上下文窗口长度的中文内容，包含足够的语义变化以模拟真实场景。';
  const content = unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
  return [{ role: 'user', content: content + '\n\n请只回复两个字：收到' }];
}

async function run(label, approxTokens, maxInput) {
  const messages = buildMessages(approxTokens);
  const body = JSON.stringify({
    request_id: crypto.randomUUID(),
    session_id: 'sess-' + Date.now().toString(36),
    model_config: { key: 'pro', source: 'system', max_input_tokens: maxInput ?? 1000000 },
    parameters: { max_tokens: 100 },
    chat_context: {
      text: '请只回复两个字：收到', features: [],
      extra: { context: [], modelConfig: { key: 'pro', source: 'system' }, originalContent: '请只回复两个字：收到' },
      chatPrompt: '', imageUrls: null,
    },
    agent_id: 'agent_common',
    messages,
  });
  console.log(`  ${label.padEnd(16)} 请求体 ${String(Math.round(body.length / 1024)).padStart(5)}KB ...`);
  const signed = session.signInferRequest(body, { modelKey: 'pro', modelSource: 'system' });
  const t0 = Date.now();
  try {
    const res = await fetch(signed.url, { method: 'POST', headers: signed.headers, body: signed.body, signal: AbortSignal.timeout(600000) });
    const text = await res.text();
    let ans = '', err = null;
    for (const l of text.split('\n')) {
      if (!l.startsWith('data:')) continue;
      const p = l.slice(5).trim();
      if (!p || p === '[DONE]') continue;
      try {
        const o = JSON.parse(p);
        const inner = typeof o.body === 'string' ? JSON.parse(o.body) : o;
        if (inner.code && String(inner.code) !== '200' && inner.message) err = String(inner.message).slice(0, 90);
        for (const c of inner.choices ?? []) if (c.delta?.content) ans += c.delta.content;
      } catch {}
    }
    const ms = Date.now() - t0;
    if (err) {
      console.log(`    → HTTP ${res.status} ${ms}ms | ❌ 拒绝: ${err}`);
      return false;
    }
    console.log(`    → HTTP ${res.status} ${ms}ms | ✅ 接受 | 答=${JSON.stringify(ans.slice(0, 16))}`);
    return true;
  } catch (e) {
    console.log(`    → ❌ 异常: ${e.message.slice(0, 60)}`);
    return false;
  }
}

console.log('=== 第二轮：逼近 1M（max_input_tokens 同步调大）===');
await run('≈850K tokens', 850_000, 1_000_000);
await run('≈1.0M tokens', 1_000_000, 1_200_000);
const over = await run('≈1.2M tokens', 1_200_000, 1_500_000);
if (over) {
  await run('≈1.5M tokens', 1_500_000, 2_000_000);
}

console.log('\n判据：从「接受」到「拒绝」的边界即真实上限。');
await session.dispose?.();
process.exit(0);
