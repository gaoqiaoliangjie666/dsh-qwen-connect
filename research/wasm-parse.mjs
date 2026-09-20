// 轻量级 WASM 解析器：列出 type/import/export/function 段摘要
// 不依赖外部工具。用于快速筛查哪个模块导出 qodercontext_*
import fs from 'node:fs';
import path from 'node:path';

const SEC = { 0: 'custom', 1: 'type', 2: 'import', 3: 'function', 4: 'table', 5: 'memory', 6: 'global', 7: 'export', 8: 'start', 9: 'element', 10: 'code', 11: 'data', 12: 'datacount' };

function uleb(buf, p) {
  let r = 0, s = 0, b;
  do { b = buf[p++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80);
  return [r >>> 0, p];
}

function sleb(buf, p) {
  let r = 0, s = 0, b;
  do { b = buf[p++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80);
  if (s < 32 && (b & 0x40)) r |= -(1 << s);
  return [r, p];
}

function str(buf, p) {
  let n; [n, p] = uleb(buf, p);
  return [buf.subarray(p, p + n).toString('utf8'), p + n];
}

function parse(buf) {
  if (buf.readUInt32LE(0) !== 0x6d736100) throw new Error('bad magic');
  let p = 8;
  const out = { types: [], imports: [], funcTypes: [], exports: [], tables: [], memories: [], globals: [], dataCount: null, custom: [] };
  while (p < buf.length) {
    const id = buf[p++];
    let size; [size, p] = uleb(buf, p);
    const end = p + size;
    const name = SEC[id] || String(id);
    if (id === 0) {
      let nm; [nm, p] = str(buf, p);
      out.custom.push(nm);
      p = end; continue;
    }
    if (id === 1) {
      let n; [n, p] = uleb(buf, p);
      for (let i = 0; i < n; i++) {
        const form = buf[p++];
        let np; [np, p] = uleb(buf, p);
        const params = [];
        for (let j = 0; j < np; j++) params.push(buf[p++]);
        let nr; [nr, p] = uleb(buf, p);
        const results = [];
        for (let j = 0; j < nr; j++) results.push(buf[p++]);
        out.types.push({ form, params, results });
      }
      p = end; continue;
    }
    if (id === 2) {
      let n; [n, p] = uleb(buf, p);
      for (let i = 0; i < n; i++) {
        const mod = buf[p++];
        let mn, nm;
        [mn, p] = str(buf, p);
        [nm, p] = str(buf, p);
        if (mod === 0) { let ti; [ti, p] = uleb(buf, p); out.imports.push({ kind: 'func', module: mn, name: nm, typeIdx: ti }); }
        else if (mod === 1) { const e = buf[p++]; let f, mx; [f, p] = uleb(buf, p); [mx, p] = uleb(buf, p); out.imports.push({ kind: 'table', module: mn, name: nm, elemType: e, min: f, max: mx }); }
        else if (mod === 2) { let f, mx; [f, p] = uleb(buf, p); [mx, p] = uleb(buf, p); out.imports.push({ kind: 'memory', module: mn, name: nm, min: f, max: mx }); }
        else if (mod === 3) { const vt = buf[p++]; const mt = buf[p++]; let f; [f, p] = uleb(buf, p); if (f & 1) { let x; [x, p] = uleb(buf, p); } out.imports.push({ kind: 'global', module: mn, name: nm, valType: vt, mut: mt }); }
      }
      p = end; continue;
    }
    if (id === 3) {
      let n; [n, p] = uleb(buf, p);
      for (let i = 0; i < n; i++) { let ti; [ti, p] = uleb(buf, p); out.funcTypes.push(ti); }
      p = end; continue;
    }
    if (id === 7) {
      let n; [n, p] = uleb(buf, p);
      for (let i = 0; i < n; i++) {
        let nm; [nm, p] = str(buf, p);
        const k = buf[p++];
        let ix; [ix, p] = uleb(buf, p);
        out.exports.push({ name: nm, kind: ['func', 'table', 'memory', 'global'][k] || k, index: ix });
      }
      p = end; continue;
    }
    if (id === 5) {
      let n; [n, p] = uleb(buf, p);
      for (let i = 0; i < n; i++) { const f = buf[p++]; let mn, mx; [mn, p] = uleb(buf, p); [mx, p] = uleb(buf, p); out.memories.push({ flags: f, min: mn, max: mx }); }
      p = end; continue;
    }
    if (id === 12) { let c; [c, p] = uleb(buf, p); out.dataCount = c; p = end; continue; }
    p = end;
  }
  return out;
}

const dir = process.argv[2] || path.join(import.meta.dirname, 'wasm');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.wasm')).sort();
const summary = [];
for (const f of files) {
  const buf = fs.readFileSync(path.join(dir, f));
  let info;
  try { info = parse(buf); } catch (e) {
    console.log(`\n=== ${f} (${buf.length} bytes) PARSE ERROR: ${e.message}`);
    continue;
  }
  const qctx = info.exports.filter(e => /qodercontext|qoder_context|prepare/i.test(e.name));
  console.log(`\n=== ${f} (${buf.length} bytes)`);
  console.log(`  types=${info.types.length} imports=${info.imports.length} funcs=${info.funcTypes.length} exports=${info.exports.length} memories=${JSON.stringify(info.memories)} dataCount=${info.dataCount}`);
  const impByMod = {};
  for (const im of info.imports) { (impByMod[im.module] ||= []).push(`${im.name}:${im.kind}`); }
  console.log(`  import modules: ${Object.keys(impByMod).join(', ') || '(none)'}`);
  for (const [m, list] of Object.entries(impByMod)) console.log(`    ${m} -> ${list.join(', ')}`);
  console.log(`  exports (all): ${info.exports.map(e => e.name).join(', ')}`);
  if (qctx.length) console.log(`  *** MATCH qodercontext: ${JSON.stringify(qctx)}`);
  summary.push({ file: f, size: buf.length, hasQodercontext: qctx.length > 0, importModules: Object.keys(impByMod), exportCount: info.exports.length });
}
console.log('\n--- SUMMARY ---');
console.log(JSON.stringify(summary, null, 2));
