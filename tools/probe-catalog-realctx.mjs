/**
 * 复刻 DSH `buildModelCatalog()` 的真实调用序列，并且**注入附件服务**
 * （模拟真实 DSH 里 ctx.get('attachments') 有值的那条路径），
 * 看模型目录是否真的能建起来。
 *
 * 目的：排查「Model catalog unavailable」这类目录级报错。
 *
 * 用法：node tools/probe-catalog-realctx.mjs
 */

const say = (s) => process.stdout.write(`${s}\n`);

const { apply, QWENWORK_PROVIDER } = await import('../lib/index.js');

/** 假的附件服务（存在即代表 DSH 有 durable attachment service）。 */
const fakeAttachments = {
  async read() {},
  async resolve() {},
};

function makeCtx(withAttachments) {
  const calls = { adapters: [], directories: [], routes: [], effects: [] };
  const ctx = {
    logger: {
      info(...a) { say(`  [log:info] ${a.map(String).join(' ')}`); },
      warn(...a) { say(`  [log:warn] ${a.map(String).join(' ')}`); },
      error(...a) { say(`  [log:error] ${a.map(String).join(' ')}`); },
    },
    effect(fn) { calls.effects.push(fn); return () => {}; },
    inject(deps, fn) {
      fn({
        webServer: { register(spec) { calls.routes.push(spec); return () => {}; } },
        settings: { installSection() {} },
        effect: ctx.effect,
        logger: ctx.logger,
        llm: ctx.llm,
      });
    },
    get(key) {
      if (key === 'attachments' && withAttachments) return fakeAttachments;
      if (key === 'fs') return undefined;
      return undefined;
    },
    llm: {
      registerAdapter(providers, adapter) { calls.adapters.push({ providers, adapter }); return () => {}; },
      registerConfigurableProviders(list) { calls.directories.push(list); return () => {}; },
    },
  };
  return { ctx, calls };
}

for (const withAttachments of [false, true]) {
  say(`\n=== attachments ${withAttachments ? '有' : '无'} ===`);
  const { ctx, calls } = makeCtx(withAttachments);
  try {
    apply(ctx, {});
  } catch (error) {
    say(`✖ apply 抛出：${error.message}`);
    continue;
  }
  const adapter = calls.adapters[0].adapter;

  // 等 shim（apply 里是异步启动的）
  await new Promise((r) => setTimeout(r, 1500));

  // 复刻 buildModelCatalog 的每一步，逐步捕获异常
  const providerId = QWENWORK_PROVIDER;
  try {
    const models = await adapter.listModels(providerId);
    say(`✔ listModels(${providerId}) → ${models.map((m) => `${m.id}:[${(m.inputModalities ?? []).join('+')}]`).join(', ')}`);
    for (const m of models) {
      try {
        const info = typeof adapter.resolveModelInfo === 'function'
          ? await adapter.resolveModelInfo(providerId, m.id)
          : await adapter.resolveModel(providerId, m.id);
        const r = info?.reasoning;
        say(`  ✔ resolveModelInfo(${m.id}) → reasoning=${r === undefined ? 'none' : `${r.efforts?.length ?? 0} efforts, default=${r.defaultEffort ?? 'none'}`}`);
      } catch (error) {
        say(`  ✖ resolveModelInfo(${m.id}) 抛出：${error.message}`);
      }
    }
  } catch (error) {
    say(`✖ listModels(${providerId}) 抛出 → buildModelCatalog 会记成 failure：${error.message}`);
  }
}

process.exit(0);
