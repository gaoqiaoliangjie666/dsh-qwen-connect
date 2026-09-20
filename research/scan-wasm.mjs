// 快速扫描：在 obf 文件中定位所有内联 WASM 的 base64 块
// 只读分析，不修改任何东西。不输出任何凭据。
import fs from 'node:fs';

const SRC = process.argv[2] || 'E:\\software\\Qwen\\QwenWorkCN\\1.0.5-26090806\\resources\\app.asar.unpacked\\node_modules\\@qoder-ai\\qoder-agent-sdk\\dist\\_worker\\qoder-worker-runtime.obf.mjs';

const buf = fs.readFileSync(SRC);
console.log('file size:', buf.length);

// 找所有 "AGFzbQ" 出现位置（base64 的 \0asm 魔数）
const needle = Buffer.from('AGFzbQ', 'latin1');
const hits = [];
let idx = 0;
while (true) {
  const p = buf.indexOf(needle, idx);
  if (p === -1) break;
  hits.push(p);
  idx = p + 1;
}
console.log('total "AGFzbQ" hits:', hits.length);
for (const p of hits.slice(0, 40)) {
  console.log('  at offset', p, ' context:', JSON.stringify(buf.subarray(Math.max(0, p - 60), p + 40).toString('latin1')));
}

// 对每个 hit，尝试向后读取 base64 字符直到遇到非 base64 字符
const B64 = /^[A-Za-z0-9+/=]+$/;
function extractFrom(start) {
  let end = start;
  const CHUNK = 1 << 20;
  while (end < buf.length) {
    const stop = Math.min(end + CHUNK, buf.length);
    let i = end;
    while (i < stop) {
      const c = buf[i];
      const isB64 = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47 || c === 61;
      if (!isB64) break;
      i++;
    }
    end = i;
    if (i < stop) break;
  }
  return end;
}

const results = [];
for (const p of hits) {
  const end = extractFrom(p);
  const len = end - p;
  if (len < 100) continue;
  const b64 = buf.subarray(p, end).toString('latin1');
  let decoded = null;
  let err = null;
  try {
    decoded = Buffer.from(b64, 'base64');
  } catch (e) { err = e.message; }
  const okMagic = decoded && decoded.length >= 4 && decoded[0] === 0 && decoded[1] === 0x61 && decoded[2] === 0x73 && decoded[3] === 0x6d;
  results.push({ start: p, end, b64len: len, decLen: decoded ? decoded.length : -1, okMagic });
  console.log(`  -> hit@${p}: b64len=${len} decoded=${decoded ? decoded.length : 'ERR'} magic_ok=${okMagic} tail=${JSON.stringify(b64.slice(-8))}`);
}

if (results.length) {
  const best = results.sort((a, b) => b.decLen - a.decLen)[0];
  console.log('\nBEST candidate:', JSON.stringify(best));
}
