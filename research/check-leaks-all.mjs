// 全插件目录泄漏复扫（research/ + lib/ + test/ 等）
// 用法：node check-leaks-all.mjs
// 判据同 check-leaks.mjs：只认「完整真实值」，文档 .md 不扫描。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');   // dsh-qwen-connect/
const SEG = ['733ef972', '1c0ec6c9', 'ceed01f1'];
const REAL_VALUES = [
  `${SEG[0]}-ef99-4f08-b4cf-918a22d97456`,     // 真实 loginDeviceId
  `${SEG[1]}-8449-4523-89d2-6558d4febd46`,     // 真实 user_id
  'DESKTOP-LTMQJMI',                           // 主机名
];
const SCAN_EXT = new Set(['.mjs', '.js', '.cjs', '.json', '.ts', '.txt', '.log', '.dat', '.env', '.yaml', '.yml']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.agent-teams']);

function walk(dir) {
  const out = [];
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of items) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      out.push(...walk(path.join(dir, e.name)));
    } else {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

let bad = 0, n = 0;
for (const p of walk(ROOT)) {
  const base = path.basename(p);
  if (base.startsWith('check-leaks')) continue;
  if (!SCAN_EXT.has(path.extname(p).toLowerCase())) continue;
  let t;
  try { t = fs.readFileSync(p, 'utf8'); } catch { continue; }
  n++;
  const hits = REAL_VALUES.filter(x => t.includes(x));
  if (hits.length) {
    bad++;
    console.log('LEAK', path.relative(ROOT, p).replace(/\\/g, '/'), '->', hits.length + ' 个真实值');
  }
}
console.log(`scanned ${n} source/data files under dsh-qwen-connect/`);
console.log(bad === 0 ? 'PASS: 无真实 PII 残留' : `FAIL: ${bad} 处残留`);
process.exit(bad === 0 ? 0 : 1);
