// research/probes-2026-09-14/probe-image-format.mjs
// 探测上游接受的图片格式：变体对照实验（每次 1 个变体，真实请求）。
import { createSignerSession, DEFAULT_ENDPOINT } from '../../lib/signer-session.js';
import { loadCredentials } from '../../lib/credentials.js';

const cred = await loadCredentials();
const session = await createSignerSession({ credential: cred, endpoint: DEFAULT_ENDPOINT });

const RED_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const DATA_URL = `data:image/png;base64,${RED_PNG}`;

async function run(label, buildBody) {
  const body = buildBody();
  const signed = session.signInferRequest(body, { modelKey: 'pro', modelSource: 'system' });
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(signed.url, { method: 'POST', headers: signed.headers, body: signed.body, signal: AbortSignal.timeout(60000) });
  } catch (e) {
    console.log(`  ❌ ${label}: ${e.message.slice(0, 50)}`);
    return;
  }
  const text = await res.text();
  let ans = '', err = null;
  for (const l of text.split('\n')) {
    if (!l.startsWith('data:')) continue;
    const p = l.slice(5).trim();
    if (!p || p === '[DONE]') continue;
    try {
      const o = JSON.parse(p);
      const inner = typeof o.body === 'string' ? JSON.parse(o.body) : o;
      if (inner.code && String(inner.code) !== '200' && inner.message) err = inner.message;
      for (const c of inner.choices ?? []) if (c.delta?.content) ans += c.delta.content;
    } catch {}
  }
  const sawRed = /红/.test(ans);
  console.log(`  ${sawRed ? '✅' : '❌'} ${label.padEnd(26)} ${Date.now() - t0}ms | ${JSON.stringify(ans.slice(0, 45))}${err ? ' | err=' + String(err).slice(0, 40) : ''}`);
}

const Q = '这张图片的主要颜色是什么？只回答颜色名。';

function base(extra) {
  const rid = crypto.randomUUID();
  return {
    request_id: rid,
    session_id: 'sess-' + Date.now().toString(36),
    model_config: { key: 'pro', source: 'system', max_input_tokens: 180000 },
    parameters: { max_tokens: 200 },
    agent_id: 'agent_common',
    messages: [{ role: 'user', content: Q }],
    ...extra,
  };
}

console.log('=== 变体对照（各 1 次真实请求）===');

// A: chat_context.imageUrls = [dataURL]
await run('A imageUrls=[dataURL]', () =>
  JSON.stringify(base({
    chat_context: { text: Q, features: [], extra: { context: [], modelConfig: { key: 'pro', source: 'system' }, originalContent: Q }, chatPrompt: '', imageUrls: [DATA_URL] },
  })),
);

// B: chat_context.imageUrls = [纯 base64]（不带 data: 前缀）
await run('B imageUrls=[base64]', () =>
  JSON.stringify(base({
    chat_context: { text: Q, features: [], extra: { context: [], modelConfig: { key: 'pro', source: 'system' }, originalContent: Q }, chatPrompt: '', imageUrls: [RED_PNG] },
  })),
);

// C: messages 里的 content 用数组（OpenAI 标准多模态）
await run('C content=[text,image_url]', () =>
  JSON.stringify(base({
    messages: [{ role: 'user', content: [{ type: 'text', text: Q }, { type: 'image_url', image_url: { url: DATA_URL } }] }],
  })),
);

// D: content 数组 + image_url 直接是字符串
await run('D content=[text,image_url:str]', () =>
  JSON.stringify(base({
    messages: [{ role: 'user', content: [{ type: 'text', text: Q }, { type: 'image_url', url: DATA_URL }] }],
  })),
);

// E: content 数组 + {type:image, data, mimeType}（DSH 内部形态直接送）
await run('E content=[text,image:data]', () =>
  JSON.stringify(base({
    messages: [{ role: 'user', content: [{ type: 'text', text: Q }, { type: 'image', data: RED_PNG, mimeType: 'image/png' }] }],
  })),
);

// F: chat_context.imageUrls + messages content 数组双管齐下
await run('F imageUrls + content 数组', () =>
  JSON.stringify(base({
    chat_context: { text: Q, features: [], extra: { context: [], modelConfig: { key: 'pro', source: 'system' }, originalContent: Q }, chatPrompt: '', imageUrls: [DATA_URL] },
    messages: [{ role: 'user', content: [{ type: 'text', text: Q }, { type: 'image_url', image_url: { url: DATA_URL } }] }],
  })),
);

await session.dispose?.();
process.exit(0);
