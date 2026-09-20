import fs from 'node:fs';
import path from 'node:path';
const SRC = 'E:\\software\\Qwen\\QwenWorkCN\\1.0.5-26090806\\resources\\app.asar.unpacked\\node_modules\\@qoder-ai\\qoder-agent-sdk\\dist\\_worker\\qoder-worker-runtime.obf.mjs';
const src = fs.readFileSync(SRC, 'utf8');
const OUT = path.join(import.meta.dirname, 'glue');
const seg = (a, b, name) => {
  const s = src.slice(a, b);
  fs.writeFileSync(path.join(OUT, name), s, 'utf8');
  console.log(`--- ${name} (${a}..${b}, ${s.length} chars) ---`);
  console.log(s.slice(0, 6000));
  console.log('');
};
seg(21739000, 21743000, 'callsite_prepareInferRequest.js');
seg(26028000, 26034000, 'callsite_initWasm.js');
