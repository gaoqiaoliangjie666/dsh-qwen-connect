// 验证 reasoning:true 是否真正传递到 pi-ai 的模型解析结果
const PLUGIN = 'file:///C:/Users/HX/AppData/Roaming/dsh-desktop/harness/profiles/web/node_modules/dsh-qwen-connect/lib/index.js';
const mod = await import(PLUGIN);

const calls = { adapters: [] };
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  effect: (fn) => fn(),
  inject(d, fn) { fn({ webServer: { register: () => () => {} }, settings: { installSection() {} }, effect: ctx.effect, logger: ctx.logger, llm: ctx.llm }); },
  get: () => undefined,
  llm: {
    registerAdapter(p, a) { calls.adapters.push(a); return () => {}; },
    registerConfigurableProviders() { return () => {}; },
  },
};
mod.apply(ctx, {});
const adapter = calls.adapters[0];

const resolved = await adapter.resolveModel('qwenwork', 'pro');
console.log('resolveModel(pro):');
console.log(JSON.stringify(resolved, null, 2));

// 从模型定义层直接看
const { FALLBACK_QWENWORK_MODELS, toPiModel } = await import('file:///C:/Users/HX/AppData/Roaming/dsh-desktop/harness/profiles/web/node_modules/dsh-qwen-connect/lib/models.js');
console.log('\ntoPiModel(pro):');
console.log(JSON.stringify(toPiModel(FALLBACK_QWENWORK_MODELS[0], 'http://x'), null, 2));

await mod.stopChatShim();
