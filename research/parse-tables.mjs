import fs from 'node:fs';
const b = fs.readFileSync('E:/Codex开发/DHS开发/dsh-qwen-connect/research/wasm/inline_26762.wasm');
let p = 8;
function uleb(buf, p) { let r = 0, s = 0, x; do { x = buf[p++]; r |= (x & 0x7f) << s; s += 7; } while (x & 0x80); return [r >>> 0, p]; }
function str(buf, p) { let n; [n, p] = uleb(buf, p); return [buf.subarray(p, p + n).toString('utf8'), p + n]; }
while (p < b.length) {
  const id = b[p++]; let size; [size, p] = uleb(b, p); const end = p + size;
  if (id === 4) {
    let n; [n, p] = uleb(b, p);
    console.log('TABLE segment count', n);
    for (let i = 0; i < n; i++) { const et = b[p++]; let f, mx; [f, p] = uleb(b, p); [mx, p] = uleb(b, p); console.log('  elemtype=', et, '(funcref=112 externref=111)', 'min', f, 'max', mx); }
  }
  if (id === 7) {
    let n; [n, p] = uleb(b, p);
    for (let i = 0; i < n; i++) { let nm; [nm, p] = str(b, p); const k = b[p++]; let ix; [ix, p] = uleb(b, p); if (k === 1 || k === 3) console.log('EXPORT table/global:', nm, 'kind', k, 'idx', ix); }
  }
  p = end;
}
