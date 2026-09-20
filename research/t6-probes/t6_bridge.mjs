// t6 验收：依赖桥解析链完整性 + 编码体检 + apply() 行为（用后删除）
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const src = 'E:/Codex开发/DHS开发/dsh-qwen-connect';
const require = createRequire('file:///' + src + '/lib/index.js');

console.log('=== 1. 依赖桥定位与解析链 ===');
const bridges = [
  ['项目根桥 @deepseek-ai', 'E:/Codex开发/DHS开发/node_modules/@deepseek-ai'],
  ['项目根桥 @earendil-works', 'E:/Codex开发/DHS开发/node_modules/@earendil-works'],
  ['插件目录 node_modules', src + '/node_modules'],
];
for (const [n, p] of bridges) console.log(`  ${n.padEnd(26)} 存在=${fs.existsSync(p)}`);

console.log('\n=== 2. 从插件目录解析 peer 依赖（模拟 DSH 解析链）===');
const peers = ['@deepseek-ai/dsh-llm-pi-ai', '@earendil-works/pi-ai', '@deepseek-ai/dsh-llm'];
for (const m of peers) {
  try {
    const pkgJson = require.resolve(m + '/package.json');
    const dir = path.dirname(pkgJson);
    const pj = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
    console.log(`  ✅ ${m.padEnd(32)} v${pj.version}  → ${dir}`);
  } catch (e) {
    console.log(`  ❌ ${m.padEnd(32)} ${e.code ?? e.message}`);
  }
}

console.log('\n=== 3. 插件声明的 peerDependencies 对照 ===');
const pj = JSON.parse(fs.readFileSync(src + '/package.json', 'utf8'));
console.log('  peerDependencies:', JSON.stringify(pj.peerDependencies ?? {}, null, 2));
console.log('  dsh 字段:', JSON.stringify(pj.dsh ?? {}, null, 2));

console.log('\n=== 4. 编码体检（t2 交付文件，Node 真 UTF-8 读取）===');
const T2_FILES = ['lib/index.js', 'lib/client.js', 'lib/web-status.js', 'lib/loopback.js',
  'lib/models.js', 'lib/status-paths.js', 'lib/credentials-seam.js', 'cordis.patch.yml', 'package.json'];
const MOJI = /[\uFFFD]/;
for (const f of T2_FILES) {
  const p = path.join(src, f);
  if (!fs.existsSync(p)) { console.log(`  ${f.padEnd(28)} MISSING`); continue; }
  const b = fs.readFileSync(p);
  const bom = b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF;
  const firstBad = b[0] > 0x7F && !bom;
  const replaced = MOJI.test(b.toString('utf8'));
  console.log(`  ${f.padEnd(28)} BOM=${bom} 首字节异常=${firstBad} 替换字符=${replaced} 首字节=0x${b[0].toString(16)}`);
}
