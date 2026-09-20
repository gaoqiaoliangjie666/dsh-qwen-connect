// ============================================================================
// 阶段A-1 交付物：从 QwenWorkCN 的 obf 运行时中定位并提取内联 WASM 签名模块
//
// 用法：node wasm-extract.mjs
// 产物：research/wasm/inline_<offset>.wasm   （6 个内联模块）
//       research/wasm.bin                    （签名模块，可独立加载）
//       research/wasm-report.json            （提取报告：offset/size/exports/imports）
//
// 全程只读源文件，不修改 App 安装目录内任何内容。
// 不输出、不落盘任何凭据。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';

const SRC = process.env.QWEN_OBF
  || 'E:\\software\\Qwen\\QwenWorkCN\\1.0.5-26090806\\resources\\app.asar.unpacked\\node_modules\\@qoder-ai\\qoder-agent-sdk\\dist\\_worker\\qoder-worker-runtime.obf.mjs';

const OUT_DIR = import.meta.dirname;
const WASM_DIR = path.join(OUT_DIR, 'wasm');

// 签名模块的判定特征：必须导出 qodercontext_prepareInferRequest
const REQUIRED_EXPORT = 'qodercontext_prepareInferRequest';

function isB64(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47 || c === 61;
}

// ---- 轻量 WASM 解析（只解析我们需要的段） ----
function uleb(buf, p) { let r = 0, s = 0, b; do { b = buf[p++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return [r >>> 0, p]; }
function str(buf, p) { let n; [n, p] = uleb(buf, p); return [buf.subarray(p, p + n).toString('utf8'), p + n]; }

function parseWasm(buf) {
  if (buf.length < 8 || buf.readUInt32LE(0) !== 0x6d736100) throw new Error('bad wasm magic');
  let p = 8;
  const out = { version: buf.readUInt32LE(4), imports: [], exports: [], memories: [], typeCount: 0, funcCount: 0, customs: [] };
  while (p < buf.length) {
    const id = buf[p++];
    let size; [size, p] = uleb(buf, p);
    const end = p + size;
    if (id === 0) { let nm; [nm, p] = str(buf, p); out.customs.push(nm); }
    else if (id === 1) { let n; [n, p] = uleb(buf, p); out.typeCount = n; }
    else if (id === 2) {
      let n; [n, p] = uleb(buf, p);
      for (let i = 0; i < n; i++) {
        let mn, nm; [mn, p] = str(buf, p); [nm, p] = str(buf, p);
        const k = buf[p++];
        const rec = { module: mn, name: nm, kind: ['func', 'table', 'memory', 'global'][k] || String(k) };
        if (k === 0) { let ti; [ti, p] = uleb(buf, p); rec.typeIdx = ti; }
        else if (k === 1) { rec.elemType = buf[p++]; let f, m; [f, p] = uleb(buf, p); [m, p] = uleb(buf, p); }
        else if (k === 2) { rec.flags = buf[p++]; let f, m; [f, p] = uleb(buf, p); [m, p] = uleb(buf, p); rec.min = f; rec.max = m; }
        else if (k === 3) { rec.valType = buf[p++]; rec.mut = buf[p++]; }
        out.imports.push(rec);
      }
    }
    else if (id === 3) { let n; [n, p] = uleb(buf, p); out.funcCount = n; }
    else if (id === 5) {
      let n; [n, p] = uleb(buf, p);
      for (let i = 0; i < n; i++) { const f = buf[p++]; let mn, mx; [mn, p] = uleb(buf, p); [mx, p] = uleb(buf, p); out.memories.push({ flags: f, min: mn, max: mx }); }
    }
    else if (id === 7) {
      let n; [n, p] = uleb(buf, p);
      for (let i = 0; i < n; i++) { let nm; [nm, p] = str(buf, p); const k = buf[p++]; let ix; [ix, p] = uleb(buf, p); out.exports.push({ name: nm, kind: ['func', 'table', 'memory', 'global'][k] || String(k), index: ix }); }
    }
    p = end;
  }
  return out;
}

// ---- 主流程 ----
function main() {
  console.log('='.repeat(70));
  console.log('QwenWorkCN 内联 WASM 签名模块提取');
  console.log('='.repeat(70));
  console.log('源文件:', SRC);
  if (!fs.existsSync(SRC)) {
    console.error('源文件不存在，无法提取。');
    console.error('可通过环境变量 QWEN_OBF 指定 qoder-worker-runtime.obf.mjs 路径。');
    process.exit(1);
  }
  const buf = fs.readFileSync(SRC);
  console.log('文件大小:', buf.length, 'bytes');

  // 1) 定位所有内联 WASM（base64 前缀 AGFzbQ = \0asm）
  const needle = Buffer.from('AGFzbQ', 'latin1');
  const offsets = [];
  let i = 0;
  while (true) { const p = buf.indexOf(needle, i); if (p === -1) break; offsets.push(p); i = p + 1; }
  console.log(`\n[1] 定位到 ${offsets.length} 处内联 WASM (特征串 "AGFzbQ"):`, offsets.join(', '));

  // 2) 逐个解码
  fs.mkdirSync(WASM_DIR, { recursive: true });
  const extracted = [];
  for (const off of offsets) {
    let e = off;
    while (e < buf.length && isB64(buf[e])) e++;
    let b64 = buf.subarray(off, e).toString('latin1');
    // 规整到合法 base64 边界
    let decoded = null;
    for (let cut = 0; cut < 8 && cut < b64.length; cut++) {
      let s = b64.slice(0, b64.length - cut);
      const rem = s.length % 4;
      if (rem) s = s.slice(0, s.length - rem);
      try {
        const d = Buffer.from(s, 'base64');
        if (d.length > 8 && d.readUInt32LE(0) === 0x6d736100 && d.readUInt32LE(4) === 1) {
          decoded = d; b64 = s; break;
        }
      } catch { /* keep trying */ }
    }
    if (!decoded || decoded.length < 1024) continue;
    const file = `inline_${off}.wasm`;
    fs.writeFileSync(path.join(WASM_DIR, file), decoded);
    let info = null, err = null;
    try { info = parseWasm(decoded); } catch (ex) { err = ex.message; }
    const hasTarget = !!(info && info.exports.some(x => x.name === REQUIRED_EXPORT));
    extracted.push({ offset: off, file, b64len: b64.length, size: decoded.length, hasTargetExport: hasTarget, info, parseError: err });
    console.log(`    @${off} -> ${file}  ${decoded.length} bytes  ${hasTarget ? '*** 含 ' + REQUIRED_EXPORT + ' ***' : ''}`);
  }

  // 3) 选出签名模块，产出 wasm.bin
  const target = extracted.find(x => x.hasTargetExport);
  if (!target) {
    console.error('\n[!] 未找到导出 ' + REQUIRED_EXPORT + ' 的模块。');
    process.exit(2);
  }
  fs.copyFileSync(path.join(WASM_DIR, target.file), path.join(OUT_DIR, 'wasm.bin'));
  console.log(`\n[2] 签名模块 = ${target.file} (offset ${target.offset}, ${target.size} bytes)`);
  console.log('    已复制到 research/wasm.bin');

  // 4) 打印 imports / exports
  const info = target.info;
  const qctxExports = info.exports.filter(x => /^qodercontext_|^requestresult_|^__wbg_qodercontext_free|^__wbg_requestresult_free/.test(x.name));
  console.log(`\n[3] 签名模块结构`);
  console.log(`    types=${info.typeCount} funcs=${info.funcCount} imports=${info.imports.length} exports=${info.exports.length}`);
  console.log(`    memories=${JSON.stringify(info.memories)}`);
  console.log(`    自定义段: ${info.customs.join(', ') || '(无)'}`);
  const mods = [...new Set(info.imports.map(x => x.module))];
  console.log(`    import 模块: ${mods.join(', ') || '(无)'}`);
  console.log(`    import 数量: func=${info.imports.filter(x => x.kind === 'func').length} memory=${info.imports.filter(x => x.kind === 'memory').length} global=${info.imports.filter(x => x.kind === 'global').length}`);

  console.log(`\n[4] QoderContext / RequestResult 相关导出（${qctxExports.length} 个）:`);
  for (const ex of qctxExports) console.log(`    [${ex.index}] ${ex.name}`);

  // 5) 报告落盘
  const report = {
    source: SRC,
    sourceSize: buf.length,
    extractedCount: extracted.length,
    target: { offset: target.offset, file: target.file, size: target.size },
    targetExports: info.exports.map(x => ({ name: x.name, kind: x.kind, index: x.index })),
    targetImports: info.imports,
    otherModules: extracted.filter(x => x !== target).map(x => ({ offset: x.offset, file: x.file, size: x.size, exportCount: x.info ? x.info.exports.length : 0 })),
  };
  fs.writeFileSync(path.join(OUT_DIR, 'wasm-report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('\n[5] 报告已写入 research/wasm-report.json');
  console.log('\n提取完成。');
}

main();
