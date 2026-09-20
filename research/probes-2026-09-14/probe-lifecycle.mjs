// research/probes-2026-09-14/probe-lifecycle.mjs
// 插件生命周期：apply 的注册/清理、重复 apply、effect 释放、shim 状态机。
import http from 'node:http';

const indexMod = await import('../../lib/index.js');
let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) fail++;
};

/**
 * 构造与 apply() 实际期望一致的假 ctx。
 *
 * 依据 lib/index.js 的真实用法：
 *   ctx.inject(['webServer'], fn)        — 有 webServer 就调用
 *   ctx.inject(['settings'], fn)         — 有 settings 就调用
 *   ctx.effect(fn)                       — 注册副作用，返回 disposer
 *   ctx.llm.registerAdapter(...)         — 返回释放函数
 *   ctx.llm.registerConfigurableProviders(...)
 *   ctx.logger.{info,warn,error}
 */
function makeCtx() {
  const registered = { adapters: [], routes: [], directories: [] };
  const effects = [];
  const ctx = {
    registered,
    effects,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    inject(deps, fn) {
      if (deps.includes('webServer')) {
        // 真实 DSH 的 webCtx 同时具有 webServer 与 effect（路由经 effect 注册）
        fn({
          logger: ctx.logger,
          effect(fn2) {
            const d = fn2();
            effects.push(d);
            return d;
          },
          webServer: {
            register(route) {
              registered.routes.push(route);
              return () => {
                const i = registered.routes.indexOf(route);
                if (i >= 0) registered.routes.splice(i, 1);
              };
            },
          },
        });
      }
      if (deps.includes('settings')) {
        fn({
          settings: {
            // 真实 DSH 的形态：settingsCtx.settings.installSection(ctx, ns, Config, config, hooks)
            installSection(hostCtx, ns, Config, config, hooks) {
              // 记录调用参数供断言
              registered.sectionInstalled = { ns, hasConfig: Config !== undefined, hasHooks: hooks !== undefined };
              return () => {};
            },
          },
        });
      }
    },
    effect(fn) {
      const dispose = fn();
      effects.push(dispose);
      return dispose;
    },
    llm: {
      registerAdapter(providers, adapter) {
        registered.adapters.push({ providers, adapter });
        return () => {
          registered.adapters.pop();
        };
      },
      registerConfigurableProviders(entries) {
        registered.directories.push(...entries);
        return () => {
          registered.directories.pop();
        };
      },
    },
  };
  return ctx;
}

console.log('=== 1) apply：注册与副作用 ===');
const ctx = makeCtx();
try {
  indexMod.apply(ctx, {});
  check('apply 未抛异常', true);
} catch (e) {
  check('apply 未抛异常', false, e.message.slice(0, 80));
}
await new Promise((r) => setTimeout(r, 1800)); // 等 ensureChatShim 异步完成

check('注册了 adapter', ctx.registered.adapters.length === 1, String(ctx.registered.adapters.length));
check('adapter 绑定 qwenwork', ctx.registered.adapters[0]?.providers?.[0] === 'qwenwork');
check('注册了 provider 目录', ctx.registered.directories.length === 1, String(ctx.registered.directories.length));
check('注册了状态路由', ctx.registered.routes.length >= 1, String(ctx.registered.routes.length));
check(
  'settings 段已安装',
  ctx.registered.sectionInstalled !== undefined && ctx.registered.sectionInstalled.hasConfig,
  JSON.stringify(ctx.registered.sectionInstalled ?? {}),
);
check('effect 已登记', ctx.effects.length >= 1, String(ctx.effects.length));

console.log('\n=== 2) shim 状态（apply 后应就绪）===');
const baseUrl = indexMod.chatShimBaseUrl();
check('shim 已启动', baseUrl !== null, baseUrl ?? 'null');
const secret = indexMod.chatShimSharedSecret();
check('共享密钥已就绪', typeof secret === 'string' && secret.length > 0);

console.log('\n=== 3) dispose：释放 adapter/目录/路由 ===');
for (const d of ctx.effects) {
  try {
    d?.();
  } catch (e) {
    check('disposer 执行', false, e.message.slice(0, 60));
  }
}
check('路由已注销', ctx.registered.routes.length === 0, String(ctx.registered.routes.length));

console.log('\n=== 4) 重复 apply（第二次注册不得崩溃）===');
const ctx2 = makeCtx();
try {
  indexMod.apply(ctx2, {});
  check('第二次 apply 未抛异常', true);
} catch (e) {
  check('第二次 apply 未抛异常', false, e.message.slice(0, 80));
}
await new Promise((r) => setTimeout(r, 800));
check('第二次注册 adapter 成功', ctx2.registered.adapters.length === 1, String(ctx2.registered.adapters.length));
// 两个 ctx 共享同一个 shim 单例
check('两次 apply 共享同一 shim', ctx2.registered.adapters.length === 1 && indexMod.chatShimBaseUrl() !== null);

await indexMod.stopChatShim();
check('最终 stopChatShim 清理干净', indexMod.chatShimBaseUrl() === null && indexMod.chatShimSharedSecret() === null);

console.log(fail === 0 ? '\n✅ 生命周期检查通过' : `\n❌ ${fail} 项失败`);
process.exit(fail > 0 ? 1 : 0);
