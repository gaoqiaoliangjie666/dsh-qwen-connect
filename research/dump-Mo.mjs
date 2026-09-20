import fs from 'node:fs';
import path from 'node:path';
const SRC = 'E:\\software\\Qwen\\QwenWorkCN\\1.0.5-26090806\\resources\\app.asar.unpacked\\node_modules\\@qoder-ai\\qoder-agent-sdk\\dist\\_worker\\qoder-worker-runtime.obf.mjs';
const src = fs.readFileSync(SRC, 'utf8');
const OUT = path.join(import.meta.dirname, 'glue');

for (const [name, pat] of [['ZFl', 'function ZFl('], ['Mo', 'async function Mo('], ['function Mo(', 'function Mo(']]) {
  const p = src.indexOf(pat);
  console.log(`\n### ${name} @ ${p}`);
  if (p > 0) {
    const s = src.slice(p, p + 2500);
    fs.writeFileSync(path.join(OUT, `${name}.js`), s, 'utf8');
    console.log(s.slice(0, 2200));
  }
}
