import fs from 'node:fs';
import path from 'node:path';
const SRC = 'E:\\software\\Qwen\\QwenWorkCN\\1.0.5-26090806\\resources\\app.asar.unpacked\\node_modules\\@qoder-ai\\qoder-agent-sdk\\dist\\_worker\\qoder-worker-runtime.obf.mjs';
const src = fs.readFileSync(SRC, 'utf8');

// QoderCredentialStorage class 与 recoverMachineIdForLogin
for (const t of ['recoverMachineIdForLogin', 'class{__destroy_into_raw', 'QoderCredentialStorage']) {
  const ps = []; let i = 0;
  while (true) { const q = src.indexOf(t, i); if (q === -1) break; ps.push(q); i = q + 1; if (ps.length > 10) break; }
  console.log(`\n${t}: ${ps.join(', ')}`);
}
