// 提取整个 wasm-bindgen module 区块并格式化输出，便于人读
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'E:\\software\\Qwen\\QwenWorkCN\\1.0.5-26090806\\resources\\app.asar.unpacked\\node_modules\\@qoder-ai\\qoder-agent-sdk\\dist\\_worker\\qoder-worker-runtime.obf.mjs';
const src = fs.readFileSync(SRC, 'utf8');
const OUT = path.join(import.meta.dirname, 'glue');
fs.mkdirSync(OUT, { recursive: true });

// 从 QoderContext 相关定义起点（约 424000）到 RequestResult 结束（约 445000）
const START = 423500;
const END = 448000;
let s = src.slice(START, END);

// 粗略美化：在 ; { } 后换行
let pretty = '';
let depth = 0;
let inStr = null;
for (let i = 0; i < s.length; i++) {
  const c = s[i];
  if (inStr) {
    pretty += c;
    if (c === '\\') { pretty += s[++i]; continue; }
    if (c === inStr) inStr = null;
    continue;
  }
  if (c === '"' || c === "'" || c === '`') { inStr = c; pretty += c; continue; }
  if (c === '{') { depth++; pretty += '{\n' + '  '.repeat(depth); continue; }
  if (c === '}') { depth = Math.max(0, depth - 1); pretty += '\n' + '  '.repeat(depth) + '}'; continue; }
  if (c === ';') { pretty += ';\n' + '  '.repeat(depth); continue; }
  pretty += c;
}

fs.writeFileSync(path.join(OUT, 'qodercontext_pretty.js'), pretty, 'utf8');
console.log('wrote qodercontext_pretty.js, lines=', pretty.split('\n').length);

// 同时输出未美化原文，供精确复制
fs.writeFileSync(path.join(OUT, 'qodercontext_raw.js'), s, 'utf8');
console.log('raw chars:', s.length);
