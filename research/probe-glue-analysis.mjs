// 判断两个 Mo 文件哪个片段更完整，并确认 createWasmContext_* 是否冗余
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SRC = 'E:\\software\\Qwen\\QwenWorkCN\\1.0.5-26090806\\resources\\app.asar.unpacked\\node_modules\\@qoder-ai\\qoder-agent-sdk\\dist\\_worker\\qoder-worker-runtime.obf.mjs';
const src = fs.readFileSync(SRC, 'utf8');
const DIR = path.join(import.meta.dirname, 'glue');

function analyse(name) {
  const p = path.join(DIR, name);
  const text = fs.readFileSync(p, 'utf8');
  // 该片段在原始 obf 中的位置
  const at = src.indexOf(text.slice(0, 200));
  return { name, len: text.length, obfOffset: at };
}

console.log('=== Mo 两文件在 obf 中的位置 ===');
for (const n of ['Mo.js', 'function Mo(.js']) {
  const r = analyse(n);
  console.log(`  ${n.padEnd(20)} len=${r.len} obfOffset=${r.obfOffset}`);
}

// 检查两文件与 obf 的对应关系：Mo.js 是否就是 obf 中偏移处的原文
const moJs = fs.readFileSync(path.join(DIR, 'Mo.js'), 'utf8');
const moVariant = fs.readFileSync(path.join(DIR, 'function Mo(.js'), 'utf8');
const atA = src.indexOf(moJs.slice(0, 200));
const atB = src.indexOf(moVariant.slice(0, 200));
console.log('\n=== 与 obf 原文比对 ===');
console.log('Mo.js 起点对应 obf 原文:', JSON.stringify(src.slice(atA, atA + 40)));
console.log('Mo.js 自身开头        :', JSON.stringify(moJs.slice(0, 40)));
console.log('Mo.js 是否与 obf 原文一致:', src.startsWith(moJs, atA));
console.log('\nfunction Mo(.js 起点对应 obf:', JSON.stringify(src.slice(atB, atB + 40)));
console.log('function Mo(.js 是否与 obf 原文一致:', src.startsWith(moVariant, atB));

// createWasmContext_* 是否有实质差异
console.log('\n=== createWasmContext_* 去重分析 ===');
const files = fs.readdirSync(DIR).filter((f) => f.startsWith('createWasmContext_'));
const byHash = new Map();
for (const f of files) {
  const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIR, f))).digest('hex').slice(0, 12);
  if (!byHash.has(h)) byHash.set(h, []);
  byHash.get(h).push(f);
}
console.log(`共 ${files.length} 个文件，${byHash.size} 个不同内容`);
for (const [h, list] of byHash) {
  console.log(`  ${h}: ${list.length} 个 —— ${list.join(', ')}`);
}
