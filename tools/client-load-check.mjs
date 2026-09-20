/**
 * 验证 client.js 能被 DSH 的浏览器模块加载器正确求值，并真的注册到
 * `settings.plugin.item` slot。
 *
 * 这里用一个最小的 `window.__ModuleLoader__` / `react` / `react/jsx-runtime`
 * 桩来跑 factory，不需要浏览器。
 *
 * 用法：node tools/client-load-check.mjs
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const line = (s) => process.stdout.write(`${s}\n`);
const require = createRequire(import.meta.url);

/** 建一个假的 DOM-free React 桩：只需满足 jsx runtime 的调用形态。 */
function makeReactStub() {
  const h = (type, props, key) => ({ type, props, key });
  return {
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    createElement: h,
  };
}

const jsxRuntimeStub = {
  jsx: (type, props, key) => ({ type, props, key }),
  jsxs: (type, props, key) => ({ type, props, key }),
  Fragment: Symbol('Fragment'),
};

// ---- 装载 client.js -------------------------------------------------------
const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');

/** 捕获 load() 的入参。 */
let loaded = null;
const windowStub = {
  __ModuleLoader__: {
    load(spec) {
      loaded = spec;
    },
  },
};

// client.js 是脚本（引用全局 window），用 Function 求值而非 import
const evaluate = new Function('window', `${source}\n`);
evaluate(windowStub);

assert.ok(loaded !== null, 'client.js 必须调用 window.__ModuleLoader__.load()');
line(`✔ 调用了 __ModuleLoader__.load()，id = ${loaded.id}`);
assert.equal(loaded.id, 'dsh-qwen-connect', 'id 必须与包名一致');
assert.equal(typeof loaded.factory, 'function', 'factory 必须是函数');

// ---- 执行 factory ---------------------------------------------------------
const fakeRequire = (spec) => {
  if (spec === 'react') return makeReactStub();
  if (spec === 'react/jsx-runtime') return jsxRuntimeStub;
  throw new Error(`client.js 请求了未预期的模块: ${spec}`);
};

const mod = loaded.factory(fakeRequire);
assert.equal(typeof mod.apply, 'function', '必须导出 apply 函数');
assert.ok(Array.isArray(mod.inject), 'inject 必须是数组（cordis 依赖声明）');
assert.equal(typeof mod.name, 'string', 'name 必须是字符串');

line(`✔ factory 返回 apply / inject / name = ${JSON.stringify(mod.inject)}, name=${mod.name}`);

// ---- 跑 apply，检查 slot 注册 --------------------------------------------
/** 记录注册进去的 slot 描述。 */
const registrations = [];
let localeRegistered = null;

const ctx = {
  effect(fn) {
    fn();
    return () => {};
  },
  locale: {
    register(ns, copy) {
      localeRegistered = { ns, copy };
      return () => {};
    },
    bind() {
      return (key) => key;
    },
  },
  slots: {
    inject(slotName, fn) {
      fn();
      return () => {};
    },
    register(descriptor, component) {
      registrations.push({ descriptor, component });
      return () => {};
    },
  },
};

mod.apply(ctx);

assert.equal(registrations.length, 1, '必须恰好注册一个卡片');
const { descriptor, component } = registrations[0];
line(`✔ slot 注册: name=${descriptor.name} key=${descriptor.key} priority=${descriptor.priority}`);

assert.equal(descriptor.name, 'settings.plugin.item', '必须注册到插件设置页的 slot');
assert.equal(descriptor.key, 'qwenwork', '0.1.2 用 key（而非旧版 id）');
assert.equal(typeof descriptor.priority, 'number', '0.1.2 用 priority（而非旧版 order）');
assert.equal(typeof component, 'function', '第二参数必须是组件函数');

assert.ok(localeRegistered !== null, '必须注册文案');
line(`✔ locale: ns=${localeRegistered.ns} 语言=${Object.keys(localeRegistered.copy).join('/')}`);
assert.ok('zh' in localeRegistered.copy && 'en' in localeRegistered.copy, 'zh 与 en 都要有');

// ---- 关键健壮性：slot API 坏掉时必须降级而非抛出 --------------------------
const brokenCtx = {
  effect(fn) {
    fn();
  },
  locale: {
    register() {
      return () => {};
    },
    bind() {
      return (k) => k;
    },
  },
  slots: {
    inject() {
      throw new Error('模拟 slot API 破坏性变更');
    },
  },
};

let threw = false;
const originalError = console.error;
console.error = () => {};
try {
  mod.apply(brokenCtx);
} catch {
  threw = true;
} finally {
  console.error = originalError;
}
assert.equal(threw, false, 'slot API 损坏时 apply 必须吞掉异常，否则会触发 DSH 红色横幅');
line('✔ slot API 损坏时 apply 未抛出（降级安全，不会触发红色横幅）');

line('\n全部检查通过。');

// 显式退出：`apply()` 会启动环回聊天 shim（真实监听的 HTTP server），
// 其句柄让事件循环继续存活，进程不会自己退出。测试脚本需显式结束。
process.exit(0);
