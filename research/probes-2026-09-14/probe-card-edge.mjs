// research/probes-2026-09-14/probe-card-edge.mjs
// 卡片渲染边界：异常数据、缺失字段、超长文本、XSS 风险。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const require = createRequire(import.meta.url);

function loadDep(name) {
  try { return require(name); } catch {
    const roaming = process.env.APPDATA ?? '';
    const req2 = createRequire(path.join(roaming, 'dsh-desktop', 'harness', 'profiles', 'node_modules', 'noop.js'));
    return req2(name);
  }
}

const react = loadDep('react');
const server = loadDep('react-dom/server');

let registered = null;
globalThis.window = { __ModuleLoader__: { load: (c) => { registered = c; } } };
const src = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8');
new Function('window', 'require', src)(globalThis.window, (id) => {
  if (id === 'react') return react;
  if (id === 'react/jsx-runtime') return loadDep('react/jsx-runtime');
  throw new Error('unexpected ' + id);
});
const mod = registered.factory((id) => {
  if (id === 'react') return react;
  if (id === 'react/jsx-runtime') return loadDep('react/jsx-runtime');
  throw new Error('unexpected ' + id);
});

let lastDict = null;
let Component = null;
const ctx = {
  effect: (fn) => fn(),
  locale: {
    register: (ns, dict) => { lastDict = dict; return () => {}; },
    bind: () => (key, params) => {
      let s = lastDict?.zh?.[key] ?? key;
      if (params) for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, String(v));
      return s;
    },
  },
  slots: { inject: (s, fn) => fn(), register: (meta, C) => { Component = C; return () => {}; } },
};
mod.apply(ctx);
const t = ctx.locale.bind('settings.qwenwork');

let fail = 0;
function render(label, state, mustContain = [], mustNotContain = []) {
  try {
    const html = server.renderToStaticMarkup(
      react.createElement(Component, { t, initialState: state, initialOpen: true }),
    );
    const missing = mustContain.filter((n) => !html.includes(n));
    const leaked = mustNotContain.filter((n) => html.includes(n));
    if (missing.length || leaked.length) {
      console.log(`  ❌ ${label}: 缺${JSON.stringify(missing)} 多${JSON.stringify(leaked)}`);
      fail++;
    } else {
      console.log(`  ✅ ${label} (${html.length}B)`);
    }
    return html;
  } catch (e) {
    console.log(`  ❌ ${label}: 抛异常 ${e.message.slice(0, 70)}`);
    fail++;
    return '';
  }
}

console.log('=== 1) 数据异常场景（不得崩）===');
render('signed-in 但全字段缺失', { status: 'signed-in' });
render('entitlements 为空数组', { status: 'signed-in', entitlements: [] });
render('entitlements 含 null 项', { status: 'signed-in', entitlements: [null] });
render('models 含缺字段项', { status: 'signed-in', models: [{ id: 'x' }] });
render('remaining 为字符串', { status: 'signed-in', remaining: 'abc', entitlements: [{ key: 'credits', remain: 'abc', unit: 'credits' }] });
render('size 为 0（除法保护）', { status: 'signed-in', entitlements: [{ key: 'credits', remain: 0, size: 0, unit: 'credits' }] });
render('remain > size（进度条封顶）', { status: 'signed-in', entitlements: [{ key: 'credits', remain: 200, size: 100, unit: 'credits' }] });
render('remain 为负', { status: 'signed-in', entitlements: [{ key: 'credits', remain: -5, size: 100, unit: 'credits' }] });
render('status 为未知值', { status: 'weird-status' });
render('error 缺 message', { status: 'error', error: { code: 'X' } });

console.log('\n=== 2) XSS 防护（React 默认转义，验证确实生效）===');
const xss = '<script>alert(1)</script>';
const html = render(
  '恶意昵称',
  { status: 'signed-in', nickname: xss, entitlements: [], models: [] },
  [],
  ['<script>'],
);
if (html.includes('&lt;script&gt;')) console.log('  ✅ 尖括号被转义为实体');

const html2 = render(
  '恶意模型名',
  { status: 'signed-in', models: [{ id: 'x', name: '<img src=x onerror=alert(1)>', rate: 1 }] },
  [],
  ['<img'],
);

console.log('\n=== 3) 超长文本（不得溢出/崩溃）===');
render('超长昵称', { status: 'signed-in', nickname: '很'.repeat(5000), entitlements: [], models: [] });

console.log(fail === 0 ? '\n✅ 卡片边界全部通过' : `\n❌ ${fail} 项失败`);
process.exit(fail > 0 ? 1 : 0);
