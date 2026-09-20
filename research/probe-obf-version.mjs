// 检查 obf 中 COSY_VERSION 的真实形态，校准探测正则
import fs from 'node:fs';
const SRC = 'E:\\software\\Qwen\\QwenWorkCN\\1.0.5-26090806\\resources\\app.asar.unpacked\\node_modules\\@qoder-ai\\qoder-agent-sdk\\dist\\_worker\\qoder-worker-runtime.obf.mjs';
const src = fs.readFileSync(SRC, 'utf8');

console.log('=== COSY_VERSION:()=>  形态 ===');
let i = src.indexOf('COSY_VERSION:()=>');
if (i >= 0) console.log(JSON.stringify(src.slice(i, i + 80)));

console.log('\n=== 所有 COSY_VERSION 出现（含上下文）===');
let p = 0, n = 0;
while ((p = src.indexOf('COSY_VERSION', p)) !== -1 && n < 8) {
  console.log(`  @${p}: ${JSON.stringify(src.slice(Math.max(0, p - 40), p + 80))}`);
  p += 1; n += 1;
}

console.log('\n=== $AA 赋值（用正则）===');
const re = /\$AA\s*=\s*[^;]{0,120}/g;
let m, count = 0;
while ((m = re.exec(src)) !== null && count < 5) {
  console.log('  ', JSON.stringify(m[0].slice(0, 140)));
  count += 1;
}

console.log('\n=== 我的探测正则匹配测试 ===');
const aliasMatch = /COSY_VERSION:\(\)=>([A-Za-z_$][\w$]*)/.exec(src);
console.log('alias match:', aliasMatch ? JSON.stringify(aliasMatch[1]) : 'NO MATCH');
if (aliasMatch) {
  const alias = aliasMatch[1];
  const assignRe = new RegExp(`\\b${alias.replace(/\$/g, '\\$')}\\s*=\\s*[^;]{0,120}?"(\\d+\\.\\d+\\.\\d+)"`);
  const mm = assignRe.exec(src);
  console.log('assign match:', mm ? JSON.stringify(mm[1]) : 'NO MATCH');
  // 看看别名附近有什么
  const ai = src.indexOf(alias + '=');
  if (ai >= 0) console.log('alias 赋值处:', JSON.stringify(src.slice(ai, ai + 120)));
}
