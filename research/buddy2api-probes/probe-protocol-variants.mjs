// research/probe-protocol-variants.mjs
// 对照实验：Buddy2api 的协议常量 vs 我们的实现，验证哪些字段真正影响输出。
// 只读探针，每个变体 1 次真实请求。
import { createSignerSession, DEFAULT_ENDPOINT, CLIENT_METADATA } from '../lib/signer-session.js';
import { loadCredentials } from '../lib/credentials.js';

const cred = await loadCredentials();
const credential = cred.credentials ?? cred;

async function run(label, buildFn) {
  const session = await createSignerSession({ credential, endpoint: DEFAULT_ENDPOINT });
  const { body, modelKey } = buildFn();
  const signed = session.signInferRequest(body, { modelKey, modelSource: 'system' });
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(signed.url, { method: 'POST', headers: signed.headers, body: signed.body });
  } catch (e) {
    console.log(`  ${label}: 网络异常 ${e.message.slice(0, 100)}`);
    await session.dispose?.();
    return;
  }
  if (!res.ok) {
    const t = (await res.text()).slice(0, 250);
    console.log(`  ${label}: HTTP ${res.status} — ${t}`);
    await session.dispose?.();
    return;
  }
  const decoder = new TextDecoder('utf-8');
  let buf = '', content = '', reasoning = '', err = null;
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    const evs = buf.split('\n\n'); buf = evs.pop() ?? '';
    for (const e of evs) {
      if (!e.startsWith('data:')) continue;
      const p = e.slice(5).trim();
      if (!p || p === '[DONE]') continue;
      try {
        const o = JSON.parse(p);
        const inner = typeof o.body === 'string' ? JSON.parse(o.body) : o;
        if (inner.code && String(inner.code) !== '200') err = inner.message ?? String(inner.code);
        const d = inner.choices?.[0]?.delta ?? {};
        if (d.content) content += d.content;
        if (d.reasoning_content) reasoning += d.reasoning_content;
      } catch {}
    }
  }
  buf += decoder.decode();
  const flag = content ? '✅ 成功' : '❌ 无正文';
  console.log(`  ${label}: HTTP ${res.status} ${flag} | ${((Date.now() - t0) / 1000).toFixed(1)}s | 正文${content.length} 思考${reasoning.length}`);
  if (!content && err) console.log(`     错误: ${err}`);
  if (!content && !err) console.log(`     原始前 200 字符: ${JSON.stringify(buf.slice(0, 200))}`);
  await session.dispose?.();
}

const TEXT = '只回复四个字：验证成功';
const base = (extra = {}, meta = {}) => JSON.stringify({
  request_id: globalThis.crypto.randomUUID(),
  session_id: `sess-${Date.now().toString(36)}`,
  model_config: { key: 'pro', source: 'system', ...meta },
  messages: [{ role: 'user', content: TEXT }],
  ...extra,
});

console.log('\n=== 变体对照（每个变体 1 次真实请求）===\n');

// A. 基线：我们的当前实现（无 chat_context）
await run('A 基线（无 chat_context）', () => ({ body: base(), modelKey: 'pro' }));

// B. 加 chat_context（Buddy2api 结构）
await run('B +chat_context（当前输入）', () => ({
  body: base({
    chat_context: {
      text: TEXT,
      features: [],
      extra: { context: [], modelConfig: { key: 'pro', source: 'system' }, originalContent: TEXT },
      chatPrompt: '',
      imageUrls: null,
    },
  }),
  modelKey: 'pro',
}));

// C. 加 Buddy2api 的全套协议字段
await run('C +全套协议字段', () => ({
  body: (() => {
    const rid = globalThis.crypto.randomUUID();
    return JSON.stringify({
      request_id: rid,
      request_set_id: rid,
      chat_record_id: rid,
      session_id: `sess-${Date.now().toString(36)}`,
      stream: true,
      chat_task: 'FREE_INPUT',
      chat_context: {
        text: TEXT,
        features: [],
        extra: { context: [], modelConfig: { key: 'pro', is_reasoning: false }, originalContent: TEXT },
        chatPrompt: '',
        imageUrls: null,
      },
      is_reply: true,
      is_retry: false,
      source: 1,
      version: '3',
      agent_id: 'agent_common',
      task_id: 'common',
      session_type: 'qoder_work',
      aliyun_user_type: '',
      model_config: {
        key: 'pro', display_name: 'pro', model: '', format: 'openai',
        is_vl: true, is_reasoning: false, api_key: '', url: '', source: 'system',
        max_input_tokens: 180000,
      },
      messages: [{ role: 'user', content: TEXT }],
      tools: [],
      parameters: { max_tokens: 32000 },
    });
  })(),
  modelKey: 'pro',
}));

console.log(`\n（我们当前 CLIENT_METADATA.scene = "${CLIENT_METADATA.scene}"，Buddy2api 用 "qwork"）\n`);
process.exit(0);
