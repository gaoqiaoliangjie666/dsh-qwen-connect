// 只验证 apply() 行为（不含大范围扫描）
const idx = await import('./lib/index.js');

function mkCtx(ov = {}) {
  const calls = { adapters: [], routes: [], effects: [], dirs: [] };
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) { try { return fn(); } catch { return () => {}; } },
    inject(deps, fn) {
      fn({
        webServer: ov.noWeb ? undefined : { register: (spec) => { calls.routes.push(spec); return () => {}; } },
        settings: ov.noSettings ? undefined : { installSection() {} },
        effect: ctx.effect, logger: ctx.logger, llm: ctx.llm,
      });
    },
    get: () => undefined,
    llm: ov.llmThrows
      ? { registerAdapter() { throw new Error('llm boom'); }, registerConfigurableProviders() { throw new Error('llm boom'); } }
      : { registerAdapter: (a) => calls.adapters.push(a), registerConfigurableProviders: (d) => calls.dirs.push(d) },
  };
  return { ctx, calls };
}

console.log('=== 9. apply() 不抛异常（5 场景）===');
const scen = [
  ['正常 ctx', {}],
  ['无 webServer', { noWeb: true }],
  ['无 settings', { noSettings: true }],
  ['llm 注册抛错', { llmThrows: true }],
  ['webServer.register 抛错', { regThrows: true }],
];
for (const [name, ov] of scen) {
  const { ctx, calls } = mkCtx(ov);
  if (ov.regThrows) {
    ctx.inject = (deps, fn) => fn({
      webServer: { register() { throw new Error('reg boom'); } },
      settings: { installSection() {} }, effect: ctx.effect, logger: ctx.logger, llm: ctx.llm,
    });
  }
  try {
    await idx.apply(ctx);
    console.log(`  ✔ ${name.padEnd(26)} 未抛异常 (adapters=${calls.adapters.length} routes=${calls.routes.length})`);
  } catch (e) {
    console.log(`  ✖ ${name.padEnd(26)} 抛出: ${e.message}`);
  }
}
