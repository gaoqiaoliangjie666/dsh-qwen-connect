// 打印 pi-ai stream 事件的真实形状，确认 text/reasoning 的字段位置
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
for (let i = 0; i < 60 && mod.chatShimBaseUrl() === null; i++) await new Promise(r => setTimeout(r, 100));

const call = await adapter.prepareCall('qwenwork', 'pro');
const stream = call.stream({
  provider: 'qwenwork', model: 'pro',
  messages: [{ role: 'user', content: [{ type: 'text', text: '1+1=? 简短回答' }] }],
});

let n = 0;
const samples = [];
for await (const e of stream) {
  n++;
  if (samples.length < 8) samples.push(e);
}
console.log('事件总数:', n);
console.log('\n前 8 个事件（截断）:');
for (const s of samples) {
  console.log(JSON.stringify(s).slice(0, 260));
}
console.log('\n事件字段集合:', [...new Set(samples.flatMap(s => Object.keys(s ?? {})))].join(', '));

await mod.stopChatShim();
