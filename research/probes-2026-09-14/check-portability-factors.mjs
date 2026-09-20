// research/probes-2026-09-14/check-portability-factors.mjs
// 便携性影响因素全盘点：哪些绑定本机、哪些必须随机器变化、哪些可移植。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

const lib = (rel) => path.join(ROOT, 'lib', rel);
let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '[OK]' : '[FAIL]'} ${label}${detail ? ' - ' + detail : ''}`);
  if (!ok) fail++;
};

/**
 * 去掉行内注释后，只检查**真实代码**里的硬编码路径。
 *
 * 为什么必须剥离注释：本项目的注释习惯写「反面示例」——例如
 * 「不得写死 `E:\software\Qwen\QwenWorkCN`」，那是一句说明，不是硬编码。
 * 直接全文匹配会把这类警告当成违规（第一版就这么误报了）。
 */
function stripComments(text) {
  return text
    .split('\n')
    .map((line) => {
      const t = line.trim();
      // 整行注释
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return '';
      // 行尾注释（粗糙但足够：本项目路径不会出现在字符串里的 "//" 之前）
      const idx = line.indexOf('//');
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join('\n');
}

console.log('=== 1) 插件内是否硬编码了本机专属路径 ===');
const localPaths = [
  { pattern: /E:\\+software\\+Qwen/i, name: '开发机的千问安装目录（E:\\software\\Qwen）' },
  { pattern: /E:\\+Codex开发/i, name: '开发机的代码目录' },
  { pattern: /C:\\+Users\\+HX/i, name: '开发机的用户目录' },
];
let localHits = 0;
const scan = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { scan(abs); continue; }
    if (!/\.(js|mjs)$/.test(e.name)) continue;
    const text = stripComments(fs.readFileSync(abs, 'utf8'));
    for (const { pattern, name } of localPaths) {
      if (pattern.test(text)) {
        console.log(`      ⚠️ ${path.relative(ROOT, abs)} 含 ${name}`);
        localHits++;
      }
    }
  }
};
scan(path.join(ROOT, 'lib'));
scan(path.join(ROOT, 'tools'));
// 一键脚本与安装说明也不能含
for (const f of ['一键安装.cmd', '一键卸载.cmd']) {
  const abs = path.join(ROOT, f);
  if (!fs.existsSync(abs)) continue;
  const text = fs.readFileSync(abs, 'utf8');
  for (const { pattern, name } of localPaths) {
    if (pattern.test(text)) { console.log(`      ⚠️ ${f} 含 ${name}`); localHits++; }
  }
}
check('lib/ 与 tools/ 无本机专属路径', localHits === 0, `${localHits} 处`);

console.log('\n=== 2) 运行期依赖的外部条件 ===');
const factors = [
  {
    name: 'Node.js',
    need: '22.19+ 或 24+',
    portable: '目标机需自行安装（脚本会自动找）',
  },
  {
    name: '千问办公安装目录',
    need: '可选（只用于探测签名版本）',
    portable: '装在任意位置均可；探测不到则用内置常量',
  },
  {
    name: '千问办公登录凭据',
    need: `%APPDATA%\\QwenWorkCN\\auth-v2.dat + Local State`,
    portable: '必须在目标机登录过（DPAPI 绑定用户账户，无法拷贝）',
  },
  {
    name: 'Windows DPAPI',
    need: 'CryptUnprotectData（当前用户）',
    portable: 'Windows 专有；跨机器/跨用户不可解密',
  },
  {
    name: 'DSH',
    need: '任意版本（Desktop / CLI）',
    portable: '安装器自动探测 profile 位置',
  },
  {
    name: '网络',
    need: 'gateway.qwenwork.cn 可达',
    portable: '无地域限制（实测）',
  },
];

for (const f of factors) {
  console.log(`  · ${f.name}`);
  console.log(`      需要: ${f.need}`);
  console.log(`      便携: ${f.portable}`);
}

console.log('\n=== 3) 凭据的可移植性实测 ===');
// 凭据里哪些字段是「本机绑定」的、哪些随登录态走
const credPath = path.join(process.env.APPDATA ?? '', 'QwenWorkCN', 'auth-v2.dat');
check('本机存在凭据文件', fs.existsSync(credPath), credPath);

console.log('\n=== 4) 代码里对本机条件的假设（逐个核对）===');
const checks = [
  {
    file: 'credentials.js',
    desc: '凭据目录来自 %APPDATA%（环境变量），非硬编码',
    ok: fs.readFileSync(lib('credentials.js'), 'utf8').includes('env.APPDATA'),
  },
  {
    file: 'dpapi.js',
    desc: 'PowerShell 路径来自 %SystemRoot%（环境变量）',
    ok: fs.readFileSync(lib('dpapi.js'), 'utf8').includes("process.env.SystemRoot"),
  },
  {
    file: 'runtime-identity.js',
    desc: '安装目录探测含多个候选 + 常量回退',
    ok: (() => {
      const t = fs.readFileSync(lib('runtime-identity.js'), 'utf8');
      return t.includes('INSTALL_ROOT_CANDIDATES') && t.includes('FALLBACK_COSY_VERSION');
    })(),
  },
  {
    file: 'runtime-identity.js',
    desc: 'machineId 可从凭据或环境变量取得',
    ok: (() => {
      const t = fs.readFileSync(lib('runtime-identity.js'), 'utf8');
      return t.includes('QWEN_MACHINE_ID');
    })(),
  },
];
for (const c of checks) {
  check(`${c.file}: ${c.desc}`, c.ok);
}

console.log('\n=== 5) 环境变量覆盖点（目标机可用的逃生舱）===');
const envVars = ['QWEN_COSY_VERSION', 'QWEN_APP_VERSION', 'QWEN_MACHINE_ID', 'DSH_QWEN_CONNECT_DEBUG'];
for (const v of envVars) {
  let found = false;
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) {
    // 只读 .js 文件（readdirSync 会包含子目录，直接读会 EISDIR）
    if (!f.endsWith('.js')) continue;
    if (fs.readFileSync(lib(f), 'utf8').includes(v)) { found = true; break; }
  }
  console.log(`  ${found ? '[OK]' : '[FAIL]'} ${v}`);
  if (!found) fail++;
}

console.log(fail === 0 ? '\n[OK] 便携性因素核对通过' : `\n[FAIL] ${fail} 项需处理`);
process.exit(fail > 0 ? 1 : 0);
