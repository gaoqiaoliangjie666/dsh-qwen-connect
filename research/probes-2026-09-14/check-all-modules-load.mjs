// research/probes-2026-09-14/check-all-modules-load.mjs
// 逐个 import 每个 lib 模块，确认没有加载期错误（循环依赖、缺导出、副作用崩溃）。
const MODULES = [
  'api', 'auth-api', 'auth', 'chat-shim', 'client-skip', 'credentials-seam',
  'credentials', 'dpapi', 'errors', 'index', 'loopback', 'models', 'rest',
  'runtime-identity', 'signer-session', 'signer-shim', 'sse', 'status-paths', 'web-status',
];

let fail = 0;
for (const name of MODULES) {
  if (name === 'client-skip') continue; // client.js 需要 window，跳过
  const url = new URL(`../../lib/${name}.js`, import.meta.url).href;
  try {
    const m = await import(url);
    const exports = Object.keys(m);
    console.log(`  ✅ ${name.padEnd(20)} ${exports.length} 个导出`);
  } catch (e) {
    console.log(`  ❌ ${name.padEnd(20)} ${e.message.slice(0, 90)}`);
    fail++;
  }
}

// 单独验证 client.js（用假 window 加载）
try {
  globalThis.window = { __ModuleLoader__: { load: () => {} } };
  const url = new URL('../../lib/client.js', import.meta.url).href;
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../../lib/client.js', import.meta.url), 'utf8');
  new Function('window', 'require', src)(globalThis.window, (id) => {
    throw new Error('unexpected require ' + id);
  });
  console.log(`  ✅ ${'client'.padEnd(20)} (自执行包装已执行)`);
} catch (e) {
  console.log(`  ❌ client: ${e.message.slice(0, 90)}`);
  fail++;
}

console.log(fail === 0 ? '\n✅ 所有模块均可加载' : `\n❌ ${fail} 个模块加载失败`);
process.exit(fail > 0 ? 1 : 0);
