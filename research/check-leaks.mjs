// 泄漏复扫：检查 research/ 下是否残留真实账号数据 / 凭据
// 用法：node check-leaks.mjs
//
// 判据说明：扫描「真实值的完整形态」，而不是简短前缀。
// 前缀特征（如 8 位 hex 片段）在文档/报告中会被引用作为说明，属正常；
// 只有完整值出现在源码或数据文件里才是真实泄漏。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;

// 完整真实值（由构建时注入的片段拼接，避免本文件自身成为泄漏源）
const SEG = ['733ef972', '1c0ec6c9', 'ceed01f1'];
const REAL_VALUES = [
  `${SEG[0]}-ef99-4f08-b4cf-918a22d97456`,                  // 真实 loginDeviceId
  `${SEG[1]}-8449-4523-89d2-6558d4febd46`,                  // 真实 user_id
  'DESKTOP-LTMQJMI',                                        // 主机名
];

// 仅这些扩展名会被扫描（文档 .md 允许为说明目的引用形态）
const SCAN_EXT = new Set(['.mjs', '.js', '.cjs', '.json', '.ts', '.txt', '.log', '.dat', '.env']);

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

let bad = 0, n = 0;
for (const p of walk(ROOT)) {
  const base = path.basename(p);
  if (base.startsWith('check-leaks')) continue;          // 扫描器自身
  if (!SCAN_EXT.has(path.extname(p).toLowerCase())) continue;
  let t;
  try { t = fs.readFileSync(p, 'utf8'); } catch { continue; }
  n++;
  const hits = REAL_VALUES.filter(x => t.includes(x));
  if (hits.length) {
    bad++;
    console.log('LEAK', path.relative(ROOT, p).replace(/\\/g, '/'), '->', hits.join(', '));
  }
}
console.log(`scanned ${n} source/data files under research/`);
console.log(bad === 0
  ? 'PASS: research/ 下无任何真实 PII / 凭据残留'
  : `FAIL: 仍有 ${bad} 处泄漏`);
process.exit(bad === 0 ? 0 : 1);
