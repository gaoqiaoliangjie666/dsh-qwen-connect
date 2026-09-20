// 找 xSA 的定义（COSY_VERSION 的真实优先来源）
import fs from 'node:fs';
const SRC = 'E:\\software\\Qwen\\QwenWorkCN\\1.0.5-26090806\\resources\\app.asar.unpacked\\node_modules\\@qoder-ai\\qoder-agent-sdk\\dist\\_worker\\qoder-worker-runtime.obf.mjs';
const src = fs.readFileSync(SRC, 'utf8');

for (const name of ['xSA', 'Aji']) {
  const re = new RegExp(`\\b${name}\\s*=\\s*[^;]{0,200}`, 'g');
  let m, n = 0;
  console.log(`\n=== ${name} 赋值 ===`);
  while ((m = re.exec(src)) !== null && n < 6) { console.log('  ', JSON.stringify(m[0].slice(0, 220))); n += 1; }
}
// xSA 的声明处（很可能是 let/var 声明）
const di = src.indexOf('xSA');
console.log('\n首次出现 xSA @', di, ':', JSON.stringify(src.slice(Math.max(0, di - 200), di + 100)));
