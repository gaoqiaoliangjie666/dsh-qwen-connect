// research/probes-2026-09-14/check-portable-package.mjs
// 便携包端到端验证：模拟「拷到新电脑」
//   1. 把 dist/dsh-qwen-connect 复制到临时目录（模拟解压到全新位置）
//   2. 从该位置执行安装器的 --dry-run（验证路径无关性）
//   3. 从该位置加载 lib/index.js（验证模块自包含，不依赖源码目录）
//
// 关键判据：便携包内的文件**不得**引用源码目录里的绝对路径。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const DIST = path.join(ROOT, 'dist', 'dsh-qwen-connect');

let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '[OK]' : '[FAIL]'} ${label}${detail ? ' - ' + detail : ''}`);
  if (!ok) fail++;
};

check('dist 目录存在', fs.existsSync(DIST), DIST);
if (!fs.existsSync(DIST)) process.exit(1);

// ---- 1) 必需文件齐全 ----
console.log('\n=== 1) 必需文件 ===');
const required = [
  'package.json',
  'cordis.patch.yml',
  'lib/index.js',
  'lib/chat-shim.js',
  'lib/signer-session.js',
  'lib/models.js',
  'lib/client.js',
  'lib/web-status.js',
  'lib/perf.js',
  'lib/trace.js',
  'lib/signer-shim.js',
  'research/wasm.bin',
  'research/qoder-wasm-glue.mjs',
  'tools/install-to-dsh.mjs',
  'tools/detect-dsh.mjs',
  '一键安装.cmd',
  '一键卸载.cmd',
  '安装说明.md',
  'README.md',
];
for (const rel of required) {
  check(rel, fs.existsSync(path.join(DIST, rel)));
}

// ---- 2) 不得残留绝对路径引用 ----
console.log('\n=== 2) 路径无关性（不得内嵌源码绝对路径）===');
const absPatterns = [/E:\\Codex/g, /E:\/Codex/g, /Codex开发\\DHS开发/g];
let absHits = 0;
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { walk(abs); continue; }
    if (!/\.(js|mjs|json|yml|cmd|md)$/.test(e.name)) continue;
    const text = fs.readFileSync(abs, 'utf8');
    for (const re of absPatterns) {
      if (re.test(text)) {
        // 文档里提到示例路径是允许的；代码/脚本里出现才是问题
        const isDoc = /\.(md)$/.test(e.name);
        if (!isDoc) {
          console.log(`      ⚠️ ${path.relative(DIST, abs)} 含 ${re}`);
          absHits++;
        }
      }
    }
  }
};
walk(DIST);
check('代码与脚本无内嵌绝对路径', absHits === 0, `${absHits} 处`);

// ---- 3) 复制到另一目录（模拟新电脑）----
//
// ⚠️ 两条环境坑（均以逐文件复制绕开）：
//   ① `os.tmpdir()` + `mkdtempSync` 在本机会静默失败（无异常、无输出）
//   ② `fs.cpSync` 对 dist 复制时让进程直接死掉（逐文件复制完全正常）
console.log('\n=== 3) 模拟拷到新电脑 ===');
const sandbox = path.join(ROOT, '.portable-check');
fs.rmSync(sandbox, { recursive: true, force: true });
const target = path.join(sandbox, 'dsh-qwen-connect');
console.log(`      沙箱目录: ${sandbox}`);
{
  const copyTree = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, e.name);
      const d = path.join(dst, e.name);
      if (e.isDirectory()) copyTree(s, d);
      else if (e.isFile()) fs.copyFileSync(s, d);
    }
  };
  copyTree(DIST, target);
}
check('复制成功', fs.existsSync(path.join(target, 'lib', 'index.js')), target);

// ---- 4) 从新位置加载模块 ----
console.log('\n=== 4) 从新位置加载（自包含性）===');
try {
  const mod = await import(`file:///${target.replaceAll('\\', '/')}/lib/index.js`);
  check('lib/index.js 可加载', typeof mod.name === 'string', `name=${mod.name}`);
  check('导出了 apply', typeof mod.apply === 'function');
  check('导出了 QWENWORK_PROVIDER', typeof mod.QWENWORK_PROVIDER === 'string');
} catch (e) {
  check('lib/index.js 可加载', false, e.message.slice(0, 100));
}

// ---- 5) 从新位置跑安装器 --dry-run ----
console.log('\n=== 5) 从新位置执行安装器（dry-run）===');
try {
  const out = execFileSync(process.execPath, [path.join(target, 'tools', 'install-to-dsh.mjs'), '--dry-run'], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env },
  });
  check('安装器可运行', true);
  check('检测到 profile', /检测到以下 DSH profile|profile:/.test(out));
  check('未写入（dry-run）', /预览完成|未写入/.test(out));
  console.log('      输出摘要:');
  for (const line of out.split('\n').filter((l) => l.trim() !== '').slice(0, 8)) {
    console.log(`        ${line.trim()}`);
  }
} catch (e) {
  const out = String(e.stdout ?? '') + String(e.stderr ?? '');
  check('安装器可运行', false, out.split('\n')[0]?.slice(0, 120) ?? e.message.slice(0, 120));
}

// ---- 6) WASM 运行依赖可加载 ----
console.log('\n=== 6) WASM 运行依赖 ===');
check('wasm.bin 有内容', fs.statSync(path.join(target, 'research', 'wasm.bin')).size > 100_000);
try {
  await import(`file:///${target.replaceAll('\\', '/')}/research/qoder-wasm-glue.mjs`);
  check('glue 模块可加载', true);
} catch (e) {
  check('glue 模块可加载', false, e.message.slice(0, 80));
}

fs.rmSync(sandbox, { recursive: true, force: true });

console.log(fail === 0 ? '\n[OK] 便携包端到端验证通过' : `\n[FAIL] ${fail} 项失败`);
process.exit(fail > 0 ? 1 : 0);
