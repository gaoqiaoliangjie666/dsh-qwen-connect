// 更稳健的 WASM 解析：逐段用 size 边界保护，正确解析 import 段
import fs from 'node:fs';
import path from 'node:path';

function uleb(buf, p) { let r = 0, s = 0, b; do { b = buf[p++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return [r >>> 0, p]; }
function str(buf, p) { let n; [n, p] = uleb(buf, p); return [buf.subarray(p, p + n).toString('utf8'), p + n]; }

const VAL = ['i32','i64','f32','f64','v128','funcref','externref'];

function parse(buf) {
  if (buf.readUInt32LE(0) !== 0x6d736100) throw new Error('bad magic');
  const version = buf.readUInt32LE(4);
  let p = 8;
  const out = { version, sections: [], types: [], imports: [], funcTypes: [], exports: [], memories: [], globals: [], tables: [], dataCount: null, custom: [] };
  while (p < buf.length) {
    const id = buf[p++];
    let size; [size, p] = uleb(buf, p);
    const start = p, end = p + size;
    out.sections.push({ id, size });
    if (id === 0) { let nm; [nm, p] = str(buf, p); out.custom.push(nm); }
    else if (id === 1) {
      let n; [n, p] = uleb(buf, p);
      for (let i = 0; i < n; i++) {
        const form = buf[p++];
        let np; [np, p] = uleb(buf, p); const params = []; for (let j = 0; j < np; j++) params.push(buf[p++]);
        let nr; [nr, p] = uleb(buf, p); const results = []; for (let j = 0; j < nr; j++) results.push(buf[p++]);
        out.types.push({ form, params, results });
      }
    } else if (id === 2) {
      let n; [n, p] = uleb(buf, p);
      for (let i = 0; i < n; i++) {
        let mn, nm; [mn, p] = str(buf, p); [nm, p] = str(buf, p);
        const k = buf[p++];
        if (k === 0) { let ti; [ti, p] = uleb(buf, p); out.imports.push({ kind: 'func', module: mn, name: nm, typeIdx: ti }); }
        else if (k === 1) { const e = buf[p++]; let f, mx; [f, p] = uleb(buf, p); if (e & 1) f = f; [mx, p] = uleb(buf, p); out.imports.push({ kind: 'table', module: mn, name: nm }); }
        else if (k === 2) { const lim = buf[p++]; let f, mx; [f, p] = uleb(buf, p); [mx, p] = uleb(buf, p); out.imports.push({ kind: 'memory', module: mn, name: nm, flags: lim, min: f, max: mx }); }
        else if (k === 3) { const vt = buf[p++]; const mut = buf[p++]; out.imports.push({ kind: 'global', module: mn, name: nm, valType: VAL[vt] || vt, mut }); }
      }
    } else if (id === 3) { let n; [n, p] = uleb(buf, p); for (let i = 0; i < n; i++) { let ti; [ti, p] = uleb(buf, p); out.funcTypes.push(ti); } }
    else if (id === 5) { let n; [n, p] = uleb(buf, p); for (let i = 0; i < n; i++) { const f = buf[p++]; let mn, mx; [mn, p] = uleb(buf, p); [mx, p] = uleb(buf, p); out.memories.push({ flags: f, min: mn, max: mx }); } }
    else if (id === 7) { let n; [n, p] = uleb(buf, p); for (let i = 0; i < n; i++) { let nm; [nm, p] = str(buf, p); const k = buf[p++]; let ix; [ix, p] = uleb(buf, p); out.exports.push({ name: nm, kind: ['func','table','memory','global'][k] || k, index: ix }); } }
    else if (id === 12) { let c; [c, p] = uleb(buf, p); out.dataCount = c; }
    p = end;
  }
  return out;
}

const dir = import.meta.dirname + '/wasm';
const target = process.argv[2] || 'inline_26762.wasm';
const buf = fs.readFileSync(path.join(dir, target));
const info = parse(buf);

console.log(`=== ${target}  size=${buf.length}  version=${info.version}`);
console.log(`sections: ${info.sections.map(s => s.id).join(',')}`);
console.log(`memories: ${JSON.stringify(info.memories)}  dataCount=${info.dataCount}`);
console.log(`types=${info.types.length} imports=${info.imports.length} funcs=${info.funcTypes.length} exports=${info.exports.length}`);
console.log('\n--- IMPORTS ---');
for (const im of info.imports) {
  let sig = '';
  if (im.kind === 'func' && info.types[im.typeIdx]) {
    const t = info.types[im.typeIdx];
    sig = `(${t.params.map(x => VAL[x] || x).join(',')}) -> (${t.results.map(x => VAL[x] || x).join(',')})`;
  }
  console.log(`  ${im.kind.padEnd(7)} ${im.module}.${im.name} ${sig}`);
}
console.log('\n--- EXPORTS ---');
for (const ex of info.exports) {
  let sig = '';
  if (ex.kind === 'func' && ex.index >= info.imports.filter(i => i.kind === 'func').length) {
    const fi = ex.index - info.imports.filter(i => i.kind === 'func').length;
    const ti = info.funcTypes[fi];
    if (ti !== undefined && info.types[ti]) {
      const t = info.types[ti];
      sig = `(${t.params.map(x => VAL[x] || x).join(',')}) -> (${t.results.map(x => VAL[x] || x).join(',')})`;
    }
  }
  console.log(`  ${ex.kind.padEnd(7)} [${ex.index}] ${ex.name} ${sig}`);
}
