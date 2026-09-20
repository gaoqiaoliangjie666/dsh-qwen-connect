import fs from 'node:fs';
import path from 'node:path';
const SRC = 'E:\\software\\Qwen\\QwenWorkCN\\1.0.5-26090806\\resources\\app.asar.unpacked\\node_modules\\@qoder-ai\\qoder-agent-sdk\\dist\\_worker\\qoder-worker-runtime.obf.mjs';
const src = fs.readFileSync(SRC, 'utf8');
const OUT = path.join(import.meta.dirname, 'glue');

// 找 ner 的调用者，以及 Authorization / Cosy- / X- 等签名头的注入点
const terms = [
  'Cosy-Signature', 'Cosy-Sign', 'X-Signature', 'x-signature',
  'Cosy-RequestId', 'Cosy-Timestamp', 'Cosy-Nonce', 'Authorization',
  'injectActiveTraceHeaders', 'injectInferenceAuth', 'inferenceHeaders',
];
for (const t of terms) {
  const ps = []; let i = 0;
  while (true) { const q = src.indexOf(t, i); if (q === -1) break; ps.push(q); i = q + 1; if (ps.length > 12) break; }
  console.log(`${t}: ${ps.length} -> ${ps.join(', ')}`);
}

// ner( 的调用点
const ner = []; let i = 0;
while (true) { const q = src.indexOf('ner(', i); if (q === -1) break; ner.push(q); i = q + 1; if (ner.length > 40) break; }
console.log('\nner( hits:', ner.length, '->', ner.slice(0, 30).join(', '));
