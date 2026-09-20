import fs from 'node:fs';
const SRC = 'E:\\software\\Qwen\\QwenWorkCN\\1.0.5-26090806\\resources\\app.asar.unpacked\\node_modules\\@qoder-ai\\qoder-agent-sdk\\dist\\_worker\\qoder-worker-runtime.obf.mjs';
const src = fs.readFileSync(SRC, 'utf8');
const terms = ['createContext', 'initWasm', 'prepareInferRequest', 'prepareWasmAuthenticatedRequest', 'machineId', 'userInfoJson', 'cosyVersion', 'getContext'];
for (const t of terms) {
  const ps = []; let i = 0;
  while (true) { const p = src.indexOf(t, i); if (p === -1) break; ps.push(p); i = p + 1; if (ps.length > 40) break; }
  console.log(`${t}: ${ps.length} -> ${ps.join(', ')}`);
}
