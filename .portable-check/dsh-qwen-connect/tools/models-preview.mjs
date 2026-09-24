// tools/models-preview.mjs
// 预览模型在选择器与卡片中的显示文本。
import { FALLBACK_QWENWORK_MODELS, toPiModel, catalogForCard, formatRate } from '../lib/models.js';

const BASE = 'http://127.0.0.1:1/v1/chat/completions';

console.log('=== 模型选择器显示（pi-ai 描述符的 name 字段）===');
for (const info of FALLBACK_QWENWORK_MODELS) {
  const pi = toPiModel(info, BASE);
  console.log(`  ${pi.id.padEnd(22)} → ${pi.name}`);
}

console.log('\n=== 设置卡片显示 ===');
for (const card of catalogForCard()) {
  console.log(`  ${card.id.padEnd(22)} | ${card.name.padEnd(22)} | ${card.description}`);
}

console.log('\n=== formatRate 边界 ===');
for (const r of [0, 0.1, 1, 1.1, 2.5, NaN, undefined]) {
  console.log(`  ${String(r).padEnd(10)} → ${JSON.stringify(formatRate(r))}`);
}

console.log('\n=== 关键断言 ===');
const pro = toPiModel(FALLBACK_QWENWORK_MODELS[0], BASE);
const flash = toPiModel(FALLBACK_QWENWORK_MODELS[1], BASE);
let fail = 0;
const check = (label, cond) => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}`);
  if (!cond) fail++;
};
check('pro 的选择器名含倍率 x1.00', pro.name.includes('x1.00'));
check('flash 的选择器名含倍率 x0.10', flash.name.includes('x0.10'));
check('pro 的选择器名含"默认"标记', pro.name.includes('默认'));
check('name 用 · 分隔', pro.name.includes(' · '));
check('id 未被污染（仍为 pro）', pro.id === 'pro');
check('卡片名保持短名（不含倍率）', catalogForCard()[0].name === '高级');

process.exit(fail > 0 ? 1 : 0);
