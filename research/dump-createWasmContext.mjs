import fs from 'node:fs';
import path from 'node:path';
const SRC = 'E:\\software\\Qwen\\QwenWorkCN\\1.0.5-26090806\\resources\\app.asar.unpacked\\node_modules\\@qoder-ai\\qoder-agent-sdk\\dist\\_worker\\qoder-worker-runtime.obf.mjs';
const src = fs.readFileSync(SRC, 'utf8');
const OUT = path.join(import.meta.dirname, 'glue');

// createWasmContext 定义
const ps = []; let i = 0;
while (true) { const q = src.indexOf('createWasmContext', i); if (q === -1) break; ps.push(q); i = q + 1; if (ps.length > 20) break; }
console.log('createWasmContext hits:', ps.join(', '));
for (const p of ps) {
  const chunk = src.slice(Math.max(0, p - 1500), p + 900);
  fs.writeFileSync(path.join(OUT, `createWasmContext_${p}.js`), chunk, 'utf8');
  console.log(`\n--- @${p} (saved to glue/createWasmContext_${p}.js) ---`);
  console.log(chunk.slice(-1600));
}
