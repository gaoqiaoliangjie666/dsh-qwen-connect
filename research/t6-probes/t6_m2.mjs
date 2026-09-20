// 核查模型字段结构（rate 为何 undefined）
const models = await import('./lib/models.js');
const list = models.FALLBACK_QWENWORK_MODELS;
console.log('=== 原始模型对象结构 ===');
for (const m of list) {
  console.log(JSON.stringify(m, null, 2));
  console.log('---');
}
console.log('=== 卡片目录（catalogForCard）===');
console.log(JSON.stringify(models.catalogForCard(), null, 2));
