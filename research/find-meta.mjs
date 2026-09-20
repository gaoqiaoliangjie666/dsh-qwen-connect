import fs from 'node:fs';
const SRC = 'E:\\software\\Qwen\\QwenWorkCN\\1.0.5-26090806\\resources\\app.asar.unpacked\\node_modules\\@qoder-ai\\qoder-agent-sdk\\dist\\_worker\\qoder-worker-runtime.obf.mjs';
const src = fs.readFileSync(SRC, 'utf8');
for (const term of ['getClientMetadata', 'getMachineId', 'getUmidService', 'machineToken', 'encrypt_user_info']) {
  const ps = []; let i = 0;
  while (true) { const q = src.indexOf(term, i); if (q === -1) break; ps.push(q); i = q + 1; if (ps.length > 15) break; }
  console.log(`\n===== ${term}: ${ps.length} hits -> ${ps.join(', ')}`);
  for (const p of ps.slice(0, 4)) {
    console.log(`  --- @${p} ---`);
    console.log('  ' + src.slice(Math.max(0, p - 300), p + 500).replace(/\n/g, ' '));
  }
}
