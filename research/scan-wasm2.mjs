// 精确提取内联 WASM
// 修正点：base64 字符集包含 '=' padding，但尾部若紧跟 "//# sourceMappingURL" 之类，
// 需要在第一个非 base64 字符处停止。这里额外处理：把解码后成功且以 wasm 结尾的切干净。
import fs from 'node:fs';
import path from 'node:path';

const SRC = process.argv[2] || 'E:\\software\\Qwen\\QwenWorkCN\\1.0.5-26090806\\resources\\app.asar.unpacked\\node_modules\\@qoder-ai\\qoder-agent-sdk\\dist\\_worker\\qoder-worker-runtime.obf.mjs';
const OUT = process.argv[3] || path.join(import.meta.dirname, 'wasm');
fs.mkdirSync(OUT, { recursive: true });

const buf = fs.readFileSync(SRC);
const needle = Buffer.from('AGFzbQ', 'latin1');
const hits = [];
let idx = 0;
while (true) {
  const p = buf.indexOf(needle, idx);
  if (p === -1) break;
  hits.push(p);
  idx = p + 1;
}

function isB64(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47 || c === 61;
}

function extractFrom(start) {
  let i = start;
  while (i < buf.length && isB64(buf[i])) i++;
  return i;
}

const report = [];
for (const p of hits) {
  const end = extractFrom(p);
  let b64 = buf.subarray(p, end).toString('latin1');
  // 规整：base64 长度必须是 4 的倍数；截到最近的合法边界再补 padding
  const tail = buf.subarray(end, end + 40).toString('latin1');
  let clean = b64;
  // 尝试逐步回退，直到解码无异常且 base64 规范
  let decoded = null;
  for (let cut = 0; cut < 8 && cut < clean.length; cut++) {
    let s = clean.slice(0, clean.length - cut);
    const rem = s.length % 4;
    if (rem !== 0) s = s.slice(0, s.length - rem);
    try {
      const d = Buffer.from(s, 'base64');
      if (d.length >= 8 && d[0] === 0 && d[1] === 0x61 && d[2] === 0x73 && d[3] === 0x6d) {
        // 校验 version 字段
        const ver = d.readUInt32LE(4);
        if (ver === 1) { decoded = d; clean = s; break; }
      }
    } catch { /* continue */ }
  }
  if (!decoded) {
    try { decoded = Buffer.from(clean, 'base64'); } catch { decoded = null; }
  }
  const name = `inline_${p}.wasm`;
  if (decoded && decoded.length > 1000) {
    fs.writeFileSync(path.join(OUT, name), decoded);
  }
  report.push({ offset: p, b64len: clean.length, size: decoded ? decoded.length : -1, tailAfter: JSON.stringify(tail), file: decoded && decoded.length > 1000 ? name : null });
}

console.log(JSON.stringify(report, null, 2));
