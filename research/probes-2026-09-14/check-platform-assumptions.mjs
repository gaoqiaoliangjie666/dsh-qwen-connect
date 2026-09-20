// research/probes-2026-09-14/check-platform-assumptions.mjs
// 平台与运行时假设核查：哪些是 Windows 专有、跨平台会怎样。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '[OK]' : '[FAIL]'} ${label}${detail ? ' - ' + detail : ''}`);
  if (!ok) fail++;
};

console.log('=== 1) 平台专有点（跨平台会失败的地方）===');
const platformSpecific = [
  { file: 'lib/dpapi.js', what: 'Windows DPAPI + powershell.exe' },
  { file: 'lib/credentials.js', what: '%APPDATA% 目录约定' },
  { file: 'lib/machine-id.js', what: 'machineId 推导（可能用 Windows 注册表/WMI）' },
];
for (const p of platformSpecific) {
  const abs = path.join(ROOT, p.file);
  console.log(`  ${fs.existsSync(abs) ? '·' : '·'} ${p.file.padEnd(24)} ${p.what}`);
}

console.log('\n=== 2) 是否有非 Windows 平台的处理 ===');
const allLib = fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js'));
let platformGuards = 0;
for (const f of allLib) {
  const text = fs.readFileSync(path.join(ROOT, 'lib', f), 'utf8');
  if (/process\.platform/.test(text)) {
    const m = text.match(/process\.platform[^\n]*/g);
    console.log(`  ${f}: ${m.slice(0, 3).join(' | ')}`);
    platformGuards++;
  }
}
console.log(`  → ${platformGuards} 个模块做了平台判断`);

console.log('\n=== 3) Node 版本要求 ===');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
console.log(`  engines.node: ${pkg.engines?.node ?? '（未声明）'}`);
check('声明了 Node 版本要求', Boolean(pkg.engines?.node));

console.log('\n=== 4) 运行时依赖（是否需要联网安装）===');
const deps = pkg.dependencies ?? {};
const peerDeps = pkg.peerDependencies ?? {};
console.log(`  dependencies: ${Object.keys(deps).length} 个`);
console.log(`  peerDependencies: ${Object.keys(peerDeps).length} 个（由 DSH 提供）`);
check('无第三方运行时依赖（零安装）', Object.keys(deps).length === 0, `${Object.keys(deps).length} 个`);

console.log('\n=== 5) WASM 依赖是否自包含 ===');
const wasm = path.join(ROOT, 'research', 'wasm.bin');
const glue = path.join(ROOT, 'research', 'qoder-wasm-glue.mjs');
check('wasm.bin 存在', fs.existsSync(wasm), fs.existsSync(wasm) ? `${(fs.statSync(wasm).size / 1024).toFixed(0)}KB` : '');
check('glue 存在', fs.existsSync(glue));
const glueText = fs.readFileSync(glue, 'utf8');
// 剥离注释后再判断：本项目的注释常提到「QwenWorkCN 内联的 WASM」这类说明，
// 直接全文匹配会把说明文字当成路径依赖（本检查的第一版就是这么误报的）。
const glueCode = glueText
  .split('\n')
  .map((line) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return '';
    const idx = line.indexOf('//');
    return idx >= 0 ? line.slice(0, idx) : line;
  })
  .join('\n');
check('glue 代码不引用 App 安装目录', !/QwenWorkCN|Program Files/.test(glueCode));
check('glue 不引用绝对路径', !/["'][A-Za-z]:\\/.test(glueCode));

console.log('\n=== 6) machineId 来源（机器绑定程度）===');
const credSeam = fs.readFileSync(path.join(ROOT, 'lib', 'credentials-seam.js'), 'utf8');
check('machineId 优先取凭据里的 loginDeviceId', credSeam.includes('loginDeviceId') || fs.readFileSync(path.join(ROOT, 'lib', 'runtime-identity.js'), 'utf8').includes('loginDeviceId'));
check('支持 QWEN_MACHINE_ID 环境变量覆盖', fs.readFileSync(path.join(ROOT, 'lib', 'runtime-identity.js'), 'utf8').includes('QWEN_MACHINE_ID'));

console.log('\n=== 7) 结论：便携性矩阵 ===');
const matrix = [
  ['换电脑（同为 Windows）', '✅ 可用', '需在新机登录千问办公（凭据 DPAPI 绑定用户）'],
  ['换 Windows 用户账户', '⚠️ 需重新登录', 'DPAPI 按用户加密，凭据不可跨用户'],
  ['千问办公装在不同盘', '✅ 可用', '通用枚举 D-Z 盘 + 常量回退'],
  ['千问办公版本不同', '✅ 可用', '实测 1.0.5/1.1.32/1.2.0 均可签名'],
  ['千问办公完全没装', '⚠️ 部分可用', '有 fallback 版本可签名，但凭据仍需来自已登录的 App'],
  ['换 macOS / Linux', '❌ 不可用', 'DPAPI 与 %APPDATA% 是 Windows 专有'],
];
for (const [scene, result, note] of matrix) {
  console.log(`  ${scene.padEnd(22)} ${result.padEnd(14)} ${note}`);
}

console.log(fail === 0 ? '\n[OK] 平台假设核查通过' : `\n[FAIL] ${fail} 项`);
process.exit(fail > 0 ? 1 : 0);
