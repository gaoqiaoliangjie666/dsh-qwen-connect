// research/probes-2026-09-14/probe-dsh-contract.mjs
// 检查 DSH 契约面：profile 字段、provider 注册、模型描述符完整性。
import { createQwenWorkAdapter } from '../../lib/index.js';
import { FALLBACK_QWENWORK_MODELS } from '../../lib/models.js';

const { adapter } = createQwenWorkAdapter(
  () => 'http://127.0.0.1:1/v1/chat/completions',
  async () => 'test-secret',
);

console.log('=== 1) adapter 公开方法 ===');
for (const m of ['listModels', 'resolveModel', 'prepareCall', 'stream', 'providerInfo', 'providerRetryPolicy']) {
  console.log(`  ${m.padEnd(20)} ${typeof adapter[m]}`);
}

console.log('\n=== 2) listModels 返回的模型描述符 ===');
const models = await adapter.listModels('qwenwork');
for (const m of models) {
  console.log(`  ${m.id}`);
  console.log(`     name:            ${m.name}`);
  console.log(`     inputModalities: ${JSON.stringify(m.inputModalities)}`);
  console.log(`     contextWindow:   ${m.context?.contextWindow}`);
  console.log(`     reasoning:       ${m.reasoning !== undefined ? JSON.stringify(m.reasoning).slice(0, 80) : 'undefined'}`);
}

console.log('\n=== 3) resolveModel 详细信息 ===');
const info = await adapter.resolveModel('qwenwork', 'pro');
console.log('  ', JSON.stringify(info, null, 2).slice(0, 600));

console.log('\n=== 4) providerInfo ===');
console.log('  ', JSON.stringify(adapter.providerInfo('qwenwork')));

console.log('\n=== 5) 未注册 provider 的行为（应抛错而非静默）===');
try {
  await adapter.listModels('nonexistent-provider');
  console.log('  ⚠️ 未抛错（可能静默返回空）');
} catch (e) {
  console.log('  ✅ 抛错:', e.message.slice(0, 80));
}

process.exit(0);
