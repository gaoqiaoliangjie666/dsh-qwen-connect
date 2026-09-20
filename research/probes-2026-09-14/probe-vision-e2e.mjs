// research/probes-2026-09-14/probe-vision-e2e.mjs
// 视觉端到端：造一张真实 PNG → 经 shim 发上游 → 模型能否"看到"。
import { startChatShim, collectImageUrls } from '../../lib/chat-shim.js';
import { loadCredentials } from '../../lib/credentials.js';
import { DEFAULT_ENDPOINT } from '../../lib/signer-session.js';
import { buildInferBody } from '../../lib/signer-session.js';

let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) fail++;
};

// ---- 生成一张可辨识的 PNG（红底 + 黑字"7"，用最小 PNG 手写） ----
// 用 8x8 的纯色块更稳：直接构造 1x1 红色 PNG 的 base64 已知常量
const RED_1x1_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

console.log('=== 1) collectImageUrls：DSH 内部形态（data+mimeType）===');
const dshForm = collectImageUrls({
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: '这张图是什么颜色？' },
        { type: 'image', data: RED_1x1_PNG, mimeType: 'image/png' },
      ],
    },
  ],
});
check('提取到 1 个 URL', dshForm.length === 1, String(dshForm.length));
check('转成 data URL', dshForm[0]?.startsWith('data:image/png;base64,'), dshForm[0]?.slice(0, 40));

console.log('\n=== 2) collectImageUrls：OpenAI 标准形态（image_url）===');
const oaiForm = collectImageUrls({
  messages: [
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }] },
  ],
});
check('提取到 image_url', oaiForm.length === 1 && oaiForm[0].startsWith('data:image/jpeg'), String(oaiForm.length));

console.log('\n=== 3) collectImageUrls：只取最后一条 user 消息（不重复分析历史图）===');
const multi = collectImageUrls({
  messages: [
    { role: 'user', content: [{ type: 'image', data: 'OLD', mimeType: 'image/png' }, { type: 'text', text: '旧图' }] },
    { role: 'assistant', content: '我看到了' },
    { role: 'user', content: [{ type: 'text', text: '这张呢？' }, { type: 'image', data: 'NEW', mimeType: 'image/png' }] },
  ],
});
check('只取最后一条 user 的图', multi.length === 1 && multi[0].includes('NEW'), multi[0]?.slice(0, 30));

console.log('\n=== 4) buildInferBody：图片进入 chat_context.imageUrls ===');
const body = JSON.parse(
  buildInferBody({
    messages: [{ role: 'user', content: '看图' }],
    modelKey: 'pro',
    imageUrls: dshForm,
  }),
);
check('chat_context 存在', body.chat_context !== undefined);
check('imageUrls 已填充', Array.isArray(body.chat_context?.imageUrls) && body.chat_context.imageUrls.length === 1);
check('text 锚点正确', body.chat_context?.text === '看图', body.chat_context?.text);

const noImg = JSON.parse(buildInferBody({ messages: [{ role: 'user', content: 'x' }] }));
check('无图时 imageUrls 为 null（上游约定）', noImg.chat_context?.imageUrls === null);

// ---- 真实上游：发一张红图，问颜色 ----
console.log('\n=== 5) 真实上游视觉推理 ===');
const shim = await startChatShim({
  getCredential: async () => loadCredentials(),
  endpoint: DEFAULT_ENDPOINT,
  logger: { warn: () => {}, info: () => {} },
});
try {
  const res = await fetch(shim.baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.sharedSecret}` },
    body: JSON.stringify({
      model: 'pro',
      stream: true,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '这张图片的主要颜色是什么？只回答颜色名。' },
            { type: 'image', data: RED_1x1_PNG, mimeType: 'image/png' },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(90000),
  });
  const text = await res.text();
  let ans = '', err = null;
  for (const l of text.split('\n')) {
    if (!l.startsWith('data:')) continue;
    const p = l.slice(5).trim();
    if (!p || p === '[DONE]') continue;
    try {
      const o = JSON.parse(p);
      if (o.error) err = o.error.message;
      for (const c of o.choices ?? []) if (c.delta?.content) ans += c.delta.content;
    } catch {}
  }
  console.log(`  HTTP ${res.status} | 回答: ${JSON.stringify(ans.slice(0, 60))}${err ? ' | err=' + err.slice(0, 50) : ''}`);
  check('请求成功', res.status === 200);
  check('模型看到了图片（回答含"红"）', /红/.test(ans), ans.slice(0, 40));
} finally {
  await shim.close();
}

console.log(fail === 0 ? '\n✅ 视觉链路全部通过' : `\n❌ ${fail} 项失败`);
process.exit(fail > 0 ? 1 : 0);
