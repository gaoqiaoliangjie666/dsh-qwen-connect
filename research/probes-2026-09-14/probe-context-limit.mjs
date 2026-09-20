// research/probes-2026-09-14/probe-context-limit.mjs
// 实测上游的真实上下文上限：发不同大小的输入，看从哪开始被拒。
// 判据：180K tokens ≈ 约为 180000 tokens；中文约 1 字 ≈ 0.6-1 token。
// 用「重复文本」精确控制字符数，逼近与超过两个候选上限。
import { createSignerSession, DEFAULT_ENDPOINT } from '../../lib/signer-session.js';
import { loadCredentials } from '../../lib/credentials.js';

const cred = await loadCredentials();
const session = await createSignerSession({ credential: cred, endpoint: DEFAULT_ENDPOINT });

/**
 * 构造约 N token 的输入。
 * 中文字符在 glm/qwen 分词器下大约 1 字 ≈ 0.7 token，
 * 用纯中文字符数 = N * 1.4 来近似 N tokens（保守估计）。
 */
function buildMessages(approxTokens) {
  const chars = Math.floor(approxTokens * 1.4);
  // 用可读句子重复填充（纯重复可能触发上游的异常行为，见已知边界）
  const unit = '这是一段用于测试上下文窗口长度的中文内容，包含足够的语义变化以模拟真实场景。';
  const content = unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
  return [{ role: 'user', content: content + '\n\n请只回复两个字：收到' }];
}

async function run(label, approxTokens) {
  const messages = buildMessages(approxTokens);
  const body = JSON.stringify({
    request_id: crypto.randomUUID(),
    session_id: 'sess-' + Date.now().toString(36),
    model_config: { key: 'pro', source: 'system', max_input_tokens: 180000 },
    parameters: { max_tokens: 100 },
    chat_context: {
      text: '请只回复两个字：收到',
      features: [],
      extra: { context: [], modelConfig: { key: 'pro', source: 'system' }, originalContent: '请只回复两个字：收到' },
      chatPrompt: '',
      imageUrls: null,
    },
    agent_id: 'agent_common',
    messages,
  });
  console.log(`  ${label.padEnd(16)} 请求体 ${String(Math.round(body.length / 1024)).padStart(4)}KB ...`);
  const signed = session.signInferRequest(body, { modelKey: 'pro', modelSource: 'system' });
  const t0 = Date.now();
  try {
    const res = await fetch(signed.url, { method: 'POST', headers: signed.headers, body: signed.body, signal: AbortSignal.timeout(180000) });
    const text = await res.text();
    let ans = '', err = null;
    for (const l of text.split('\n')) {
      if (!l.startsWith('data:')) continue;
      const p = l.slice(5).trim();
      if (!p || p === '[DONE]') continue;
      try {
        const o = JSON.parse(p);
        const inner = typeof o.body === 'string' ? JSON.parse(o.body) : o;
        if (inner.code && String(inner.code) !== '200' && inner.message) err = String(inner.message).slice(0, 80);
        for (const c of inner.choices ?? []) if (c.delta?.content) ans += c.delta.content;
      } catch {}
    }
    const ms = Date.now() - t0;
    if (err) {
      console.log(`    → HTTP ${res.status} ${ms}ms | ❌ 拒绝: ${err}`);
      return false;
    }
    console.log(`    → HTTP ${res.status} ${ms}ms | ✅ 接受 | 答=${JSON.stringify(ans.slice(0, 20))}`);
    return true;
  } catch (e) {
    console.log(`    → ❌ 异常: ${e.message.slice(0, 60)}`);
    return false;
  }
}

console.log('=== 上下文上限实测（pro）===');
// 150K tokens：低于 180K，应成功
const ok150 = await run('≈150K tokens', 150_000);
// 200K tokens：超过 180K（若上限真是 180K 应被拒；若是 1M 应成功）
const ok200 = await run('≈200K tokens', 200_000);
if (ok200) {
  // 400K：远超 180K
  const ok400 = await run('≈400K tokens', 400_000);
  if (ok400) {
    await run('≈700K tokens', 700_000);
  }
}
console.log('\n结论判据:');
console.log('  150K 成功 + 200K 被拒  → 上限 ≈180K（Buddy2api 值正确）');
console.log('  200K/400K 也成功       → 上限远大于 180K（"1M" 表格列可能才是对的）');

await session.dispose?.();
process.exit(0);
