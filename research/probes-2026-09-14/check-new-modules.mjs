// research/probes-2026-09-14/check-new-modules.mjs
// 健康检查：新增模块行为、文案键对齐、跨模块一致性、能力联动、转发完整性。
//
// 注意：本文件必须用 write/edit 工具维护，不要用 PowerShell 的
// Get-Content/Set-Content 做字符串替换——那会按 GBK 破坏 UTF-8 emoji。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
/** Windows 上动态 import 绝对路径必须先转成 file:// URL。 */
const mod = (rel) => pathToFileURL(path.join(ROOT, rel)).href;
let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '[OK]' : '[FAIL]'} ${label}${detail ? ' - ' + detail : ''}`);
  if (!ok) fail++;
};

// ---- 1) perf.js 窗口限制 ----
console.log('=== perf.js ===');
const perf = await import(mod('lib/perf.js'));
perf.resetPerf();
check('无样本返回 null', perf.perfSummary() === null);
for (let i = 0; i < 1000; i++) {
  perf.recordSample({ ttftMs: 100 + i, charsPerSec: 50, totalMs: 1000, outputChars: 10 });
}
const s = perf.perfSummary();
check('窗口限制为 20（灌 1000 条后）', s.samples === 20, `samples=${s.samples}`);
check('保留的是最新的（last=1099）', s.lastTtftMs === 1099, `lastTtftMs=${s.lastTtftMs}`);
perf.resetPerf();

// ---- 2) client.js 文案键对齐 ----
console.log('\n=== client.js 文案键 ===');
const src = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8');
const zhMatch = src.match(/const zh = \{([\s\S]*?)\n    \};/);
const enMatch = src.match(/const en = \{([\s\S]*?)\n    \};/);
check('找到 zh 块', zhMatch !== null);
check('找到 en 块', enMatch !== null);
if (zhMatch && enMatch) {
  const keysOf = (m) => [...m[1].matchAll(/^\s{6}(\w+):/gm)].map((x) => x[1]).sort();
  const zh = keysOf(zhMatch);
  const en = keysOf(enMatch);
  const missEn = zh.filter((k) => !en.includes(k));
  const missZh = en.filter((k) => !zh.includes(k));
  check(`zh/en 键数一致（${zh.length}/${en.length}）`, zh.length === en.length);
  check('zh 有的键 en 都有', missEn.length === 0, missEn.join(',') || '无缺失');
  check('en 有的键 zh 都有', missZh.length === 0, missZh.join(',') || '无缺失');
  const used = [...new Set([...src.matchAll(/\bt\('(\w+)'/g)].map((x) => x[1]))];
  const undef = used.filter((k) => !zh.includes(k));
  check(`代码用到的 ${used.length} 个键都已定义`, undef.length === 0, undef.join(',') || '无缺失');
}

// ---- 3) 跨模块字段一致性（host 产出 vs client 读取） ----
console.log('\n=== 跨模块字段一致性 ===');
const ws = fs.readFileSync(path.join(ROOT, 'lib/web-status.js'), 'utf8');
const written = [...new Set([...ws.matchAll(/status\.(\w+)\s*=/g)].map((x) => x[1]))];
const read = [...new Set([...src.matchAll(/state\.(\w+)/g)].map((x) => x[1]))];
console.log(`  host 产出: ${written.sort().join(', ')}`);
console.log(`  client 读取: ${read.sort().join(', ')}`);
const tolerated = ['creditBaseline', 'perf', 'account', 'nextDueDate'];
const suspicious = read.filter((f) => !written.includes(f) && !tolerated.includes(f));
check('client 读取的字段都有产出源', suspicious.length === 0, suspicious.join(',') || '全部有来源');

// ---- 4) 模型模态与附件服务的联动 ----
console.log('\n=== 模型模态联动 ===');
const models = await import(mod('lib/models.js'));
const withImg = models.toPiModel(models.FALLBACK_QWENWORK_MODELS[0], 'http://x/v1', { supportsImages: true });
const noImg = models.toPiModel(models.FALLBACK_QWENWORK_MODELS[0], 'http://x/v1', { supportsImages: false });
check('支持图片时声明 image', JSON.stringify(withImg.input) === '["text","image"]');
check('不支持时退回 text', JSON.stringify(noImg.input) === '["text"]');

// ---- 5) signer-shim 转发完整性 ----
console.log('\n=== signer-shim 转发完整性 ===');
const chatShim = await import(mod('lib/chat-shim.js'));
const signerShim = await import(mod('lib/signer-shim.js'));
const missing = Object.keys(chatShim).filter((k) => !(k in signerShim));
check('转发列表无遗漏', missing.length === 0, missing.join(',') || '完整');

// ---- 6) 所有 lib 模块可加载 ----
console.log('\n=== 模块加载 ===');
const libFiles = fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js') && f !== 'client.js');
let loadFail = 0;
for (const f of libFiles) {
  try {
    await import(mod(`lib/${f}`));
  } catch (e) {
    console.log(`    [FAIL] ${f}: ${e.message.slice(0, 70)}`);
    loadFail++;
  }
}
check(`${libFiles.length} 个 lib 模块全部可加载`, loadFail === 0, loadFail ? `${loadFail} 个失败` : '');

console.log(fail === 0 ? '\n[OK] 健康检查全部通过' : `\n[FAIL] ${fail} 项失败`);
process.exit(fail > 0 ? 1 : 0);
