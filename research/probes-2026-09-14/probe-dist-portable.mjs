// research/probes-2026-09-14/probe-dist-portable.mjs
// 发布包端到端：从 dist 拷到独立位置 → 注入假 profile → 从该位置真实对话。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = path.join(ROOT, 'dist', 'dsh-qwen-connect');
let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) fail++;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-dist-'));
const dest = path.join(TMP, '我的 插件'); // 含中文与空格，模拟真实拷贝场景

console.log('=== 1) 拷贝发布包到独立位置 ===');
// 用 robocopy 而非 fs.cpSync：Node 的 cpSync 在处理含大二进制+wasm 的目录时
// 在本机出现过原生层崩溃（STATUS_STACK_BUFFER_OVERRUN），robocopy 稳定且快。
try {
  execFileSync('robocopy', [DIST, dest, '/E', '/NFL', '/NDL', '/NJH', '/NJS'], { stdio: 'pipe' });
} catch (e) {
  // robocopy 的退出码 1 表示"有文件拷贝"，属成功；>=8 才是失败
  const code = e.status ?? 0;
  if (code >= 8) {
    console.log(`  ❌ robocopy 失败 exit=${code}`);
    process.exit(1);
  }
}
check('拷贝完成', fs.existsSync(path.join(dest, 'lib', 'index.js')));
check('WASM 随包', fs.existsSync(path.join(dest, 'research', 'wasm.bin')));
check('glue 随包', fs.existsSync(path.join(dest, 'research', 'qoder-wasm-glue.mjs')));
check('注入器随包', fs.existsSync(path.join(dest, 'tools', 'install-to-dsh.mjs')));
check('安装文档随包', fs.existsSync(path.join(dest, 'INSTALL-新电脑.md')));

console.log('\n=== 2) 从新位置注入到假 profile ===');
const profile = path.join(TMP, 'profiles', 'web');
fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true });
const shared = path.join(TMP, 'profiles', 'node_modules');
// ⚠️ shared 目录必须显式创建：上面只 mkdir 了 web/node_modules（recursive
// 到 web 为止），profiles/node_modules 并不存在——mklink 会报
// 「找不到路径」，而这个失败曾被静默吞掉，让后续断言全部失真。
fs.mkdirSync(shared, { recursive: true });
// ⚠️ 假环境必须等价于真实 DSH：真实机器的 profiles/node_modules 里有
// @deepseek-ai / @earendil-works。这里把它们桥进假 shared——
// 否则注入器会正确报告"目标不存在"，peer 验证也会正确报失败
// （那不是注入器的缺陷，而是假环境搭得不像）。
const realShared = path.join(process.env.APPDATA ?? '', 'dsh-desktop', 'harness', 'profiles', 'node_modules');
for (const scope of ['@deepseek-ai', '@earendil-works']) {
  const link = path.join(shared, scope);
  // ⚠️ 先清可能的悬空链接：上一轮运行残留的 Junction 若指向已删目录，
  // mklink 会失败——之前被「已存在」的静默 catch 吞掉，让注入器看到
  // 「目标不存在」而正确报错。看起来像注入器 bug，实则探针环境脏了。
  try {
    if (fs.lstatSync(link).isSymbolicLink()) {
      execFileSync('cmd', ['/c', 'rmdir', link], { stdio: 'pipe' });
    }
  } catch { /* 不存在，正常 */ }
  try {
    execFileSync('cmd', ['/c', 'mklink', '/J', link, path.join(realShared, scope)], { stdio: 'pipe' });
  } catch (e) {
    // mklink 失败必须暴露，否则后续断言全部失真
    console.log(`  ❌ mklink ${scope} 失败: ${String(e.stderr ?? e.message).slice(0, 120)}`);
    process.exit(1);
  }
}
// 用 Node 写（无 BOM）。PowerShell 5 的 Set-Content -Encoding utf8 会写 BOM，
// 之前正是这个 BOM 让注入器报 "Unexpected token '﻿'" —— 该问题已由注入器
// 的 parseJsonTolerant 修复，此处写干净 JSON 以测常规路径。
fs.writeFileSync(
  path.join(profile, 'package.json'),
  JSON.stringify({ name: 'profile', dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2),
  'utf8',
);
let install;
const installerArgs = [
  path.join(dest, 'tools', 'install-to-dsh.mjs'),
  '--profile', profile,
  // bridge-dir 指向 profiles（其 node_modules 里已有真实 scope 桥）——
  // 与真实机器的布局一致：插件祖先链上有个含 scope 的 node_modules。
  '--bridge-dir', path.dirname(profile),
  '--source', dest,
];
try {
  console.log(`  注入参数: ${installerArgs.join(' ')}`);
  install = execFileSync('node', installerArgs, { encoding: 'utf8' });
  check('注入退出码 0', true);
} catch (e) {
  install = String(e.stdout ?? '') + String(e.stderr ?? '');
  // 打出与 peer 相关的行帮助定位（bridge-dir、桥位置、验证结果）
  const rel = install.split('\n').filter((l) => /桥位置|@deepseek-ai|@earendil|peer/i.test(l));
  check('注入退出码 0', false, rel.join(' ⏎ ').slice(0, 220));
}
check('Junction 指向新位置', fs.realpathSync(path.join(profile, 'node_modules', 'dsh-qwen-connect')) === fs.realpathSync(dest));

console.log('\n=== 3) 从新位置发起真实对话（经 Junction 路径）===');
const entry = pathToFileURL(path.join(profile, 'node_modules', 'dsh-qwen-connect', 'lib', 'chat-shim.js')).href;
const credEntry = pathToFileURL(path.join(profile, 'node_modules', 'dsh-qwen-connect', 'lib', 'credentials.js')).href;
const sessEntry = pathToFileURL(path.join(profile, 'node_modules', 'dsh-qwen-connect', 'lib', 'signer-session.js')).href;
// 动态拼一段验证脚本在子进程跑（用真实凭据）
const script = `
const { startChatShim } = await import('${entry}');
const { loadCredentials } = await import('${credEntry}');
const { DEFAULT_ENDPOINT } = await import('${sessEntry}');
const shim = await startChatShim({ getCredential: async () => loadCredentials(), endpoint: DEFAULT_ENDPOINT });
const res = await fetch(shim.baseUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + shim.sharedSecret },
  body: JSON.stringify({ model: 'pro', stream: true, messages: [{ role: 'user', content: '只回复四个字：发布包OK' }] }),
  signal: AbortSignal.timeout(60000),
});
const text = await res.text();
let ans = '';
for (const l of text.split('\\n')) {
  if (!l.startsWith('data:')) continue;
  const p = l.slice(5).trim();
  if (!p || p === '[DONE]') continue;
  try { const o = JSON.parse(p); for (const c of o.choices ?? []) if (c.delta?.content) ans += c.delta.content; } catch {}
}
console.log('HTTP ' + res.status + ' | ' + JSON.stringify(ans.slice(0, 30)));
await shim.close();
process.exit(res.status === 200 && ans.length > 0 ? 0 : 1);
`;
const scriptPath = path.join(TMP, 'verify-dist.mjs');
fs.writeFileSync(scriptPath, script, 'utf8');
let chatOk = false;
try {
  const out = execFileSync('node', [scriptPath], { encoding: 'utf8', timeout: 90000 });
  console.log(`  ${out.trim().split('\n').join('\n  ')}`);
  chatOk = /HTTP 200/.test(out);
} catch (e) {
  console.log(`  ❌ 子进程失败: ${String(e.stdout ?? '').slice(0, 120)} ${String(e.stderr ?? '').slice(0, 120)}`);
}
check('发布包端到端对话', chatOk);

// 清理
try { execFileSync('cmd', ['/c', 'rmdir', path.join(profile, 'node_modules', 'dsh-qwen-connect')], { stdio: 'pipe' }); } catch {}
for (const scope of ['@deepseek-ai', '@earendil-works']) {
  try { execFileSync('cmd', ['/c', 'rmdir', path.join(shared, scope)], { stdio: 'pipe' }); } catch {}
}
fs.rmSync(TMP, { recursive: true, force: true });

console.log(fail === 0 ? '\n✅ 发布包端到端全部通过' : `\n❌ ${fail} 项失败`);
process.exit(fail > 0 ? 1 : 0);
