import fs from 'node:fs';
const SRC = 'E:\\software\\Qwen\\QwenWorkCN\\1.0.5-26090806\\resources\\app.asar.unpacked\\node_modules\\@qoder-ai\\qoder-agent-sdk\\dist\\_worker\\qoder-worker-runtime.obf.mjs';
const src = fs.readFileSync(SRC, 'utf8');

function findAll(pat, limit = 12) {
  const ps = []; let i = 0;
  while (true) { const q = src.indexOf(pat, i); if (q === -1) break; ps.push(q); i = q + 1; if (ps.length > limit) break; }
  return ps;
}

for (const name of ['kLe=', 'YVi=', 'kLe ', '$AA=', 'function getClientMetadata', 'getClientMetadata=', 'd0=', 'il=']) {
  const ps = findAll(name, 8);
  console.log(`\n### ${name} -> ${ps.join(', ')}`);
  for (const p of ps.slice(0, 3)) {
    console.log('   ...' + src.slice(Math.max(0, p - 120), p + 260).replace(/\n/g, ' ') + '...');
  }
}
