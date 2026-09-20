// research/probes-2026-09-14/diag-cp-failure.mjs
// 诊断：dist 里哪个文件让 cpSync 崩溃（逐文件复制，定位到具体条目）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const DIST = path.join(ROOT, 'dist', 'dsh-qwen-connect');
const SB = path.join(ROOT, '.portable-check');

fs.rmSync(SB, { recursive: true, force: true });
fs.mkdirSync(SB, { recursive: true });

/** 逐文件复制，任一失败立即报告。 */
function copyOne(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyOne(path.join(src, name), path.join(dst, name));
    }
    return;
  }
  // 符号链接/联接：报告出来（cpSync 对它们的处理与 copyFileSync 不同）
  if (st.isSymbolicLink?.()) {
    console.log(`  [SYMLINK] ${path.relative(DIST, src)}`);
    return;
  }
  fs.copyFileSync(src, dst);
}

console.log('=== 逐文件复制 dist ===');
let count = 0;
const walk = (src, dst) => {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) walk(path.join(src, name), path.join(dst, name));
    return;
  }
  try {
    copyOne(src, dst);
    count++;
  } catch (e) {
    console.log(`  ❌ ${path.relative(DIST, src)}: ${e.code} ${e.message.slice(0, 100)}`);
  }
};

walk(DIST, path.join(SB, 'dsh-qwen-connect'));
console.log(`\n  已复制 ${count} 个文件`);
console.log('  目标顶层:', fs.readdirSync(path.join(SB, 'dsh-qwen-connect')).join(', '));

// 逐个文件做「读取测试」——找出哪个文件读起来异常
console.log('\n=== 逐文件读取测试（找坏文件）===');
const readAll = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { readAll(abs); continue; }
    try {
      const buf = fs.readFileSync(abs);
      if (buf.length === 0) console.log(`  [EMPTY] ${path.relative(DIST, abs)}`);
    } catch (err) {
      console.log(`  ❌ 读失败 ${path.relative(DIST, abs)}: ${err.code}`);
    }
  }
};
readAll(DIST);
console.log('  （无输出即全部可读）');
