// 导出 glue 区间到文件，便于阅读
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'E:\\software\\Qwen\\QwenWorkCN\\1.0.5-26090806\\resources\\app.asar.unpacked\\node_modules\\@qoder-ai\\qoder-agent-sdk\\dist\\_worker\\qoder-worker-runtime.obf.mjs';
const src = fs.readFileSync(SRC, 'utf8');
const OUT = path.join(import.meta.dirname, 'glue');
fs.mkdirSync(OUT, { recursive: true });

const seg = (a, b, name) => {
  const s = src.slice(a, b);
  fs.writeFileSync(path.join(OUT, name), s, 'utf8');
  console.log(`${name}: chars ${a}..${b} (${s.length})`);
};

seg(424000, 428000, 'glue_a_imports.js');
seg(428000, 432000, 'glue_b_wbg.js');
seg(432000, 441000, 'glue_c_exports.js');
