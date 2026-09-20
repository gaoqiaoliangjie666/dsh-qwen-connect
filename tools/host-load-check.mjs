/**
 * 验证 host 侧 lib/index.js 在**没有真实 DSH 运行时**时的加载安全性：
 * 即使依赖缺失，import 该模块也不应产生副作用或抛错。
 *
 * 用法：node tools/host-load-check.mjs
 */

const say = (s) => process.stdout.write(`${s}\n`);

const url = new URL('../lib/index.js', import.meta.url);
try {
  const mod = await import(url.href);
  say('✔ lib/index.js 已被 import，未抛错');
  say(`  name   = ${mod.name}`);
  say(`  inject = ${JSON.stringify(mod.inject)}`);
  say(`  apply  = ${typeof mod.apply}`);
  say(`  provider = ${mod.QWENWORK_PROVIDER}`);
  say(`  models = ${mod.FALLBACK_QWENWORK_MODELS.map((m) => m.id).join(', ')}`);
} catch (error) {
  say(`✖ lib/index.js import 失败: ${error.message}`);
  process.exit(1);
}
