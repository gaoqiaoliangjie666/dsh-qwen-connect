// 验证 pi-ai 实际可用性（正确用 import 而非 require.resolve）
const src = 'E:/Codex开发/DHS开发/dsh-qwen-connect';
process.chdir(src);

console.log('=== 1. 直接 import pi-ai 的真实入口 ===');
try {
  const m = await import('@earendil-works/pi-ai');
  console.log('  ✅ import 成功，导出:', Object.keys(m).slice(0, 12).join(', '));
  console.log('  createProvider 类型:', typeof m.createProvider);
} catch (e) { console.log('  ❌ import 失败:', e.code, e.message.split('\n')[0]); }

console.log('\n=== 2. 子路径 api/openai-completions.lazy ===');
try {
  const m2 = await import('@earendil-works/pi-ai/api/openai-completions.lazy');
  console.log('  ✅ 成功，导出:', Object.keys(m2).join(', '));
} catch (e) { console.log('  ❌ 失败:', e.code, e.message.split('\n')[0]); }

console.log('\n=== 3. 版本一致性核查（声明 ^0.85.1 vs 实际 0.84.4）===');
const fs = await import('node:fs');
const pj = JSON.parse(fs.readFileSync(src + '/package.json', 'utf8'));
console.log('  插件声明:', pj.peerDependencies['@earendil-works/pi-ai']);
const inst = JSON.parse(fs.readFileSync('E:/software/DSH Desktop/resources/app/node_modules/@earendil-works/pi-ai/package.json', 'utf8'));
console.log('  实际安装:', inst.version);

console.log('\n=== 4. 关键：lib/index.js 能否真正加载（端到端）===');
try {
  const idx = await import('file:///' + src + '/lib/index.js');
  console.log('  ✅ lib/index.js 加载成功');
  console.log('  name =', idx.name, '| provider =', idx.QWENWORK_PROVIDER ?? '(未导出)');
  console.log('  apply 类型:', typeof idx.apply);
  console.log('  导出:', Object.keys(idx).join(', '));
} catch (e) {
  console.log('  ❌ 加载失败:', e.code, e.message.split('\n')[0]);
}
