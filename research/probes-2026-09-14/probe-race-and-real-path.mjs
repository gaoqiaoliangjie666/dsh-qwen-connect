// research/probes-2026-09-14/probe-race-and-real-path.mjs
// 1) shim 启动竞态：ensureChatShim 并发调用是否只起一个实例
// 2) DSH 真实调用路径：经 PiAiAdapter，而不是裸 shim
import http from 'node:http';

let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) fail++;
};

// ---- 1) 并发 ensureChatShim ----
console.log('=== 1) ensureChatShim 并发调用（只能起一个 shim）===');
const indexMod = await import('../../lib/index.js');

// 模拟 apply 之前的并发场景：同时调 5 次
const results = await Promise.all(
  Array.from({ length: 5 }, () =>
    indexMod.ensureChatShim({ logger: { info: () => {}, warn: () => {} } }).catch(() => null),
  ),
);
const ports = new Set(results.filter((u) => u !== null).map((u) => new URL(u).port));
check('并发调用只起一个 shim', ports.size <= 1, `ports=${[...ports].join(',')}`);
check('至少一次成功', results.some((r) => r !== null));
check('全部返回同一 baseUrl', new Set(results.filter(Boolean)).size <= 1);
const secret = indexMod.chatShimSharedSecret();
check('共享密钥可取（非 null）', typeof secret === 'string' && secret.length > 0);
await indexMod.stopChatShim();
check('stopChatShim 后密钥清空', indexMod.chatShimSharedSecret() === null);
check('stopChatShim 后 baseUrl 清空', indexMod.chatShimBaseUrl() === null);

// ---- 2) 经完整 adapter 路径（DSH 实际走的链路）----
console.log('\n=== 2) 经 PiAiAdapter 的完整链路（DSH 真实路径）===');
const { createQwenWorkAdapter } = indexMod;
const { loadCredentials } = await import('../../lib/credentials.js');

const shim = await indexMod.ensureChatShim({ logger: { info: () => {}, warn: () => {} } });
const { adapter } = createQwenWorkAdapter(
  () => indexMod.chatShimBaseUrl() ?? 'http://127.0.0.1:1/v1/chat/completions',
  async () => indexMod.chatShimSharedSecret(),
);

const models = await adapter.listModels('qwenwork');
check('listModels 返回 3 个模型', models.length === 3, String(models.length));

// 走 adapter.stream（与 DSH 相同的入口）
const chunks = [];
try {
  const stream = adapter.stream({
    provider: 'qwenwork',
    model: 'pro',
    messages: [{ role: 'user', content: [{ type: 'text', text: '只回复四个字：适配成功' }] }],
    signal: AbortSignal.timeout(60000),
  });
  for await (const chunk of stream) chunks.push(chunk);
  const text = chunks
    .filter((c) => c?.type === 'text-delta' || c?.type === 'text_delta')
    .map((c) => c.delta ?? c.text ?? '')
    .join('');
  const usage = chunks.find((c) => c?.type === 'usage');
  const finish = chunks.find((c) => c?.type === 'finish' || c?.type === 'block-end');
  console.log(`    收到 ${chunks.length} 个 chunk`);
  check('经 adapter 拿到文本', text.length > 0, JSON.stringify(text.slice(0, 40)));
  check('经 adapter 拿到 usage', usage !== undefined, usage ? JSON.stringify(usage.usage) : '无');
  console.log(`    chunk 类型: ${[...new Set(chunks.map((c) => c?.type))].join(', ')}`);
} catch (e) {
  check('经 adapter 流式调用', false, e.message.slice(0, 100));
}

await indexMod.stopChatShim();
process.exit(fail > 0 ? 1 : 0);
