import fs from 'node:fs';
import path from 'node:path';
const SRC = 'E:\\software\\Qwen\\QwenWorkCN\\1.0.5-26090806\\resources\\app.asar.unpacked\\node_modules\\@qoder-ai\\qoder-agent-sdk\\dist\\_worker\\qoder-worker-runtime.obf.mjs';
const src = fs.readFileSync(SRC, 'utf8');

// 找 uE 的定义（形如 uE=()=>{...} 或 function uE()）
const patterns = ['uE=', 'function uE(', 'TD=', 'function TD(', 'ax=', 'function ax('];
for (const p of patterns) {
  const ps = []; let i = 0;
  while (true) { const q = src.indexOf(p, i); if (q === -1) break; ps.push(q); i = q + 1; if (ps.length > 20) break; }
  console.log(`${p}: ${ps.length} -> ${ps.join(', ')}`);
}
console.log('\n--- 附近上下文 ---');
for (const [p, name] of [['uE=', 'uE'], ['TD=', 'TD'], ['ax=', 'ax']]) {
  let pos = src.indexOf(p);
  if (pos > 0) {
    console.log(`\n[${name}] @${pos}:`);
    console.log(src.slice(Math.max(0, pos - 200), pos + 900));
  }
}
