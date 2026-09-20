import fs from 'node:fs';
const SRC = 'E:\\software\\Qwen\\QwenWorkCN\\1.0.5-26090806\\resources\\app.asar.unpacked\\node_modules\\@qoder-ai\\qoder-agent-sdk\\dist\\_worker\\qoder-worker-runtime.obf.mjs';
const src = fs.readFileSync(SRC, 'utf8');

// 这些常量在 bn(fZn,{...}) 导出映射里
const p = src.indexOf('BRAND_AUTH_PROVIDER_ID');
console.log('=== brand constants export block preview ===');
// 找定义它们的赋值语句：形如 NQt=xxx
for (const name of ['NQt', 'xlA', 'LQt', 'x6A', 'HQt', 'OQt', 'Yq', 'RlA', 'MlA', 'T6A', 'FQt', 'COSY_VERSION']) {
  const re = new RegExp('(?:^|[,;{\\s])' + name + '\\s*=\\s*([^,;\\n]{0,120})');
  const m = re.exec(src);
  console.log(`${name} = ${m ? m[1].slice(0, 140) : 'NOT FOUND (plain assignment)'}`);
}

// COSY_VERSION 常见导出
const cv = src.match(/COSY_VERSION[^,;]{0,120}/g);
console.log('\nCOSY_VERSION occurrences:', cv ? cv.slice(0, 10) : null);

// 找 business_type/scene 的字面值
const bt = src.match(/business_type[^,;]{0,150}/g);
console.log('\nbusiness_type:', bt ? bt.slice(0, 8) : null);
const ct = src.match(/client_type[^,;]{0,150}/g);
console.log('\nclient_type:', ct ? ct.slice(0, 8) : null);
const sc = src.match(/scene[^,;]{0,120}/g);
console.log('\nscene:', sc ? sc.slice(0, 10) : null);
