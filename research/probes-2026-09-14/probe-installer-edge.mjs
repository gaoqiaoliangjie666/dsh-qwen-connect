// research/probes-2026-09-14/probe-installer-edge.mjs
// 安装工具的边界场景：path 带空格/中文、目标已有冲突链接、--uninstall 幂等。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) fail++;
};

/** 用最小 profile 模拟一个 DSH 环境。 */
function makeFakeProfile(baseDir) {
  const profile = path.join(baseDir, 'profiles', 'web');
  fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true });
  const shared = path.join(baseDir, 'profiles', 'node_modules');
  for (const scope of ['@deepseek-ai', '@earendil-works']) {
    fs.mkdirSync(path.join(shared, scope), { recursive: true });
  }
  fs.writeFileSync(
    path.join(profile, 'package.json'),
    JSON.stringify({ name: 'profile', dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2),
    'utf8',
  );
  return { profile, shared };
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-inst-'));
const INSTALLER = path.join(ROOT, 'tools', 'install-to-dsh.mjs');
const run = (args) => {
  try {
    const out = execFileSync('node', [INSTALLER, ...args], { encoding: 'utf8', env: { ...process.env } });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
  }
};

console.log('=== 1) 常规安装到假 profile（含中文+空格路径）===');
const base1 = path.join(TMP, '测试 环境 A');
fs.mkdirSync(base1, { recursive: true });
const fake1 = makeFakeProfile(base1);
const r1 = run(['--profile', fake1.profile, '--source', ROOT, '--bridge-dir', base1]);
check('安装退出码 0', r1.code === 0, r1.code + '\n' + r1.out.split('\n').filter((l) => l.includes('❌')).join('\n'));
check('Junction 已建', fs.existsSync(path.join(fake1.profile, 'node_modules', 'dsh-qwen-connect')));
const pkg1 = JSON.parse(fs.readFileSync(path.join(fake1.profile, 'package.json'), 'utf8'));
check('dependencies 登记', pkg1.dependencies['dsh-qwen-connect'] === 'file:./node_modules/dsh-qwen-connect');
check('bundles 登记', pkg1.dsh.profile.bundles.includes('dsh-qwen-connect'));
check('overrides 登记', pkg1.pnpm.overrides['dsh-qwen-connect'] === 'link:./node_modules/dsh-qwen-connect');
check('备份已生成', fs.readdirSync(fake1.profile).some((f) => f.startsWith('package.json.backup-qwen-connect-')));
check('桥已建', fs.existsSync(path.join(base1, 'node_modules', '@deepseek-ai')));

console.log('\n=== 2) 重复安装（幂等，不得报错）===');
const r2 = run(['--profile', fake1.profile, '--source', ROOT, '--bridge-dir', base1]);
check('二次安装退出码 0', r2.code === 0);
const pkg2 = JSON.parse(fs.readFileSync(path.join(fake1.profile, 'package.json'), 'utf8'));
check('bundles 不重复', pkg2.dsh.profile.bundles.filter((x) => x === 'dsh-qwen-connect').length === 1);

console.log('\n=== 3) 卸载（登记与 Junction 移除，桥保留）===');
const r3 = run(['--uninstall', '--profile', fake1.profile, '--source', ROOT]);
check('卸载退出码 0', r3.code === 0);
const pkg3 = JSON.parse(fs.readFileSync(path.join(fake1.profile, 'package.json'), 'utf8'));
check('dependencies 已移除', pkg3.dependencies['dsh-qwen-connect'] === undefined);
check('bundles 已移除', !pkg3.dsh.profile.bundles.includes('dsh-qwen-connect'));
check('overrides 已移除', pkg3.pnpm.overrides['dsh-qwen-connect'] === undefined);
check('Junction 已移除', !fs.existsSync(path.join(fake1.profile, 'node_modules', 'dsh-qwen-connect')));
check('桥保留（可能被共用）', fs.existsSync(path.join(base1, 'node_modules', '@deepseek-ai')));

console.log('\n=== 4) 卸载后再卸载（幂等）===');
const r4 = run(['--uninstall', '--profile', fake1.profile, '--source', ROOT]);
check('重复卸载退出码 0', r4.code === 0);

console.log('\n=== 5) 源目录不是插件（应明确失败）===');
const base5 = path.join(TMP, 'not-a-plugin');
fs.mkdirSync(base5, { recursive: true });
const r5 = run(['--profile', fake1.profile, '--source', base5, '--bridge-dir', base1]);
check('退出码非 0', r5.code !== 0, '对非插件源应拒绝');
check('错误信息可读', /package\.json|dsh\.bundle/i.test(r5.out));

console.log('\n=== 6) profile package.json 带 UTF-8 BOM（Windows 编辑器常态）===');
const base6 = path.join(TMP, 'bom 环境');
fs.mkdirSync(base6, { recursive: true });
const fake6 = makeFakeProfile(base6);
// 用 Node 写入带 BOM 的 JSON —— 模拟 PowerShell 5 / 旧编辑器产物
const bomPkg = '\uFEFF' + JSON.stringify({ name: 'profile', dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2);
fs.writeFileSync(path.join(fake6.profile, 'package.json'), bomPkg, 'utf8');
const r6 = run(['--profile', fake6.profile, '--source', ROOT, '--bridge-dir', base6]);
check('BOM 文件下安装成功', r6.code === 0, r6.code + ' | ' + r6.out.split('\n').filter((l) => l.includes('❌')).join(' ').slice(0, 100));
const pkg6raw = fs.readFileSync(path.join(fake6.profile, 'package.json'), 'utf8');
const pkg6 = JSON.parse(pkg6raw.charCodeAt(0) === 0xfeff ? pkg6raw.slice(1) : pkg6raw);
check('BOM 文件的三处登记生效', pkg6.dependencies['dsh-qwen-connect'] !== undefined && pkg6.dsh.profile.bundles.includes('dsh-qwen-connect'));
check('写回为无 BOM JSON（后续工具友好）', pkg6raw.charCodeAt(0) !== 0xfeff);

// 清理：断开 Junction 后再删（避免 rmdir 递归进源码树）
try {
  execFileSync('cmd', ['/c', 'rmdir', path.join(fake6.profile, 'node_modules', 'dsh-qwen-connect')], { stdio: 'pipe' });
} catch { /* 可能未建 */ }

// 清理：断开 Junction 后再删（避免 rmdir 递归进源码树）
try {
  execFileSync('cmd', ['/c', 'rmdir', path.join(fake1.profile, 'node_modules', 'dsh-qwen-connect')], { stdio: 'pipe' });
} catch { /* 已移除 */ }
for (const scope of ['@deepseek-ai', '@earendil-works']) {
  try {
    execFileSync('cmd', ['/c', 'rmdir', path.join(base1, 'node_modules', scope)], { stdio: 'pipe' });
  } catch { /* 已移除 */ }
}
fs.rmSync(TMP, { recursive: true, force: true });

console.log(fail === 0 ? '\n✅ 安装工具边界全部通过' : `\n❌ ${fail} 项失败`);
process.exit(fail > 0 ? 1 : 0);
