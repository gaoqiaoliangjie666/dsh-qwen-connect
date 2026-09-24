/**
 * 直连本插件环回 shim 发一次真实 chat 请求，把「返回给 DSH 的原始错误体」打出来。
 * 目的：确认 DSH 聊天里那句报错的**确切来源与文案**。
 *
 * 用法：node tools/probe-shim-error.mjs
 */

const say = (s) => process.stdout.write(`${s}\n`);

const mod = await import('../lib/index.js');
const { apply } = mod;

const calls = { adapters: [] };
const ctx = {
  logger: {
    info: (m) => say(`  [plugin info] ${m}`),
    warn: (m, e) => say(`  [plugin warn] ${m}${e === undefined ? '' : ` :: ${e}`}`),
    error: (m, e) => say(`  [plugin error] ${m}${e === undefined ? '' : ` :: ${e}`}`),
  },
  effect: (fn) => fn(),
  inject(_deps, fn) {
    fn({
      webServer: { register: () => () => {} },
      settings: { installSection: () => {} },
      effect: ctx.effect,
      logger: ctx.logger,
      llm: ctx.llm,
    });
  },
  get: () => undefined,
  llm: {
    registerAdapter: (p, a) => (calls.adapters.push({ p, a }), () => {}),
    registerConfigurableProviders: () => () => {},
  },
};

apply(ctx, {});
await new Promise((r) => setTimeout(r, 1500));

const baseUrl = mod.chatShimBaseUrl();
say(`shim baseUrl = ${baseUrl}`);
if (baseUrl === null) {
  say('✖ shim 未就绪');
  process.exit(1);
}
const secret = mod.chatShimSharedSecret();
say(`shim sharedSecret 长度 = ${secret === null ? 'null' : secret.length}`);

const response = await fetch(baseUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
  body: JSON.stringify({
    model: 'flash',
    messages: [{ role: 'user', content: '你好' }],
    stream: true,
  }),
});

say(`\nHTTP ${response.status} ${response.statusText}`);
say(`content-type: ${response.headers.get('content-type')}`);
const text = await response.text();
say('---- body 原文 ----');
say(text.slice(0, 2000));
say('---- end ----');

process.exit(0);
