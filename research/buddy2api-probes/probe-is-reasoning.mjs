// research/probe-is-reasoning.mjs
// 对照实验：is_reasoning 显式设置 vs 不设置，对输出（思考链/正文比例）的影响。
// 只读探针：每个变体发 1 次真实请求。
import { createSignerSession, DEFAULT_ENDPOINT } from '../lib/signer-session.js';
import { loadCredentials } from '../lib/credentials.js';

const cred = await loadCredentials();
const credential = cred.credentials ?? cred;

const session = await createSignerSession({
  credential,
  endpoint: DEFAULT_ENDPOINT,
});

/** 构造 body；variant 决定是否设置 is_reasoning */
function buildBody(text, variant) {
  const requestId = globalThis.crypto.randomUUID();
  const modelConfig = { key: 'pro', source: 'system' };
  const innerModelConfig = { key: 'pro', source: 'system' };
  if (variant !== 'none') {
    modelConfig.is_reasoning = variant === 'true';
    innerModelConfig.is_reasoning = variant === 'true';
  }
  return JSON.stringify({
    request_id: requestId,
    session_id: `sess-${Date.now().toString(36)}`,
    model_config: modelConfig,
    chat_context: {
      text,
      extra: { modelConfig: innerModelConfig, originalContent: text },
    },
    messages: [{ role: 'user', content: text }],
  });
}

async function run(variant, text) {
  const body = buildBody(text, variant);
  const signed = session.signInferRequest(body, { modelKey: 'pro', modelSource: 'system' });
  const res = await fetch(signed.url, {
    method: 'POST',
    headers: signed.headers,
    body: signed.body,
  });
  if (!res.ok) {
    return { variant, http: res.status, error: (await res.text()).slice(0, 200) };
  }

  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let content = '';
  let reasoning = '';
  let finish = null;
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    const events = buf.split('\n\n');
    buf = events.pop() ?? '';
    for (const e of events) {
      if (!e.startsWith('data:')) continue;
      const p = e.slice(5).trim();
      if (!p || p === '[DONE]') continue;
      try {
        const obj = JSON.parse(p);
        const inner = typeof obj.body === 'string' ? JSON.parse(obj.body) : obj;
        const d = inner.choices?.[0]?.delta ?? {};
        if (d.content) content += d.content;
        if (d.reasoning_content) reasoning += d.reasoning_content;
        const fr = inner.choices?.[0]?.finish_reason;
        if (fr) finish = fr;
      } catch {}
    }
  }
  buf += decoder.decode();
  return { variant, http: res.status, content, reasoning, finish };
}

const TEXT = '只回复四个字：验证成功';

for (const variant of ['none', 'false', 'true']) {
  const t0 = Date.now();
  const r = await run(variant, TEXT);
  console.log(`\n=== is_reasoning: ${variant} (${Date.now() - t0} ms) ===`);
  if (r.error) {
    console.log(`  HTTP ${r.http} 错误: ${r.error}`);
    continue;
  }
  console.log(`  HTTP ${r.http} | finish=${r.finish}`);
  console.log(`  正文  ${r.content.length} 字符: ${JSON.stringify(r.content.slice(0, 60))}`);
  console.log(`  思考链 ${r.reasoning.length} 字符: ${JSON.stringify(r.reasoning.slice(0, 60))}`);
}

await session.dispose?.();
process.exit(0);
