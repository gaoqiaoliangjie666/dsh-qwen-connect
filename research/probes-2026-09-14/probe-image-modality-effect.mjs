// research/probes-2026-09-14/probe-image-modality-effect.mjs
// 关键对照：模型声明 ['text','image'] 与 ['text'] 时，
// 一条**普通文本请求**在 pi-ai 内部的路径差异。
import { createQwenWorkAdapter } from '../../lib/index.js';
import { startChatShim } from '../../lib/chat-shim.js';
import { loadCredentials } from '../../lib/credentials.js';
import { DEFAULT_ENDPOINT } from '../../lib/signer-session.js';

const shim = await startChatShim({
  getCredential: async () => loadCredentials(),
  endpoint: DEFAULT_ENDPOINT,
  logger: { warn: (...a) => console.log('    [warn]', ...a.map((x) => String(x).slice(0, 100))) },
});

const TEXT_MSGS = [{ role: 'user', content: [{ type: 'text', text: '说：好' }] }];

async function tryAdapter(label, image, ms) {
  const { adapter } = createQwenWorkAdapter(() => shim.baseUrl, async () => shim.sharedSecret, image);
  const models = await adapter.listModels('qwenwork');
  console.log(`  ${label}`);
  console.log(`     inputModalities: ${JSON.stringify(models[0].inputModalities)}`);
  const t0 = Date.now();
  try {
    const chunks = [];
    for await (const c of adapter.stream({
      provider: 'qwenwork',
      model: 'pro',
      messages: TEXT_MSGS,
      signal: AbortSignal.timeout(ms),
    })) {
      chunks.push(c);
    }
    const text = chunks.filter((c) => c?.type === 'text-delta' || c?.type === 'text_delta').map((c) => c.delta ?? c.text ?? '').join('');
    console.log(`     ✅ ${Date.now() - t0}ms | ${chunks.length} chunks | ${JSON.stringify(text.slice(0, 20))}`);
  } catch (e) {
    console.log(`     ❌ ${Date.now() - t0}ms | ${e.message.slice(0, 80)}`);
  }
}

console.log('=== A) 无附件服务（声明 text）===');
await tryAdapter('不带 imageDeps', {}, 60000);

console.log('\n=== B) 带附件服务（声明 text+image）===');
// 用假附件服务模拟 DSH 的真实环境
const fakeAttachments = {
  async readImageRequest() { throw new Error('no image in this request'); },
  imageHostPath() { return null; },
};
await tryAdapter('带 imageDeps', {
  resolveAttachments: () => fakeAttachments,
  resolveImageAccess: () => '[image]',
}, 60000);

console.log('\n=== C) 带附件服务 + 一条含图请求（看是否卡住）===');
{
  const { adapter } = createQwenWorkAdapter(() => shim.baseUrl, async () => shim.sharedSecret, {
    resolveAttachments: () => fakeAttachments,
    resolveImageAccess: () => '[image]',
  });
  const t0 = Date.now();
  try {
    const chunks = [];
    for await (const c of adapter.stream({
      provider: 'qwenwork',
      model: 'pro',
      messages: [{ role: 'user', content: [
        { type: 'text', text: '看图' },
        { type: 'image', attachment: { attachmentId: 'sha256:abcdef0123456789', bytes: 100 } },
      ] }],
      signal: AbortSignal.timeout(30000),
    })) {
      chunks.push(c);
    }
    console.log(`     ✅ ${Date.now() - t0}ms | ${chunks.length} chunks`);
  } catch (e) {
    console.log(`     ❌ ${Date.now() - t0}ms | ${e.message.slice(0, 90)}`);
  }
}

await shim.close();
process.exit(0);
