// research/probes-2026-09-14/check-encoding.mjs
// 编码体检：找出被 GBK 破坏（乱码）或带 BOM 的文件。
// 背景：本机 PowerShell 5 的 Get-Content/Set-Content 默认按 GBK 处理，
// 曾多次破坏 UTF-8 文件（emoji 变 鉁?、中文变 涓枃）。这是不可逆损坏，
// 只能靠这个扫描及时发现。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

/**
 * 真正的 GBK 误解码特征。
 *
 * ⚠️ 不要用「CJK 范围」做判断——那会把「静默」「问题」这类**正常中文**
 * 全部误报（第一版就是这么错的）。真正的乱码有几个确定性特征：
 *   1. 生僻字扎堆出现（正常中文不会连续用「鉁鉂」这种字）
 *   2. 特定高频乱码字：鉁 鉂 涓 枃 鏂 鑺 鈥 璺 锛 鐨 鍜 浣 涓
 *   3. 中文里混入「镓」「鉂」等罕见字
 */
const MOJIBAKE_CHARS = /[鉁鉂鈥锛鐨鍜浣鏂鑺璺涓鐢鐨勮繖]/;
/** 判据：同一行出现 ≥2 个乱码特征字（单个可能是巧合）。 */
function looksMojibake(text) {
  for (const line of text.split('\n')) {
    // 跳过本文件自身：正则字面量与注释里必然含这些特征字（会自我误报）。
    if (line.includes('MOJIBAKE_CHARS')) continue;
    const hits = line.match(new RegExp(MOJIBAKE_CHARS.source, 'g'));
    if (hits !== null && hits.length >= 2) return hits.join('');
  }
  return null;
}

let bad = 0;
let checked = 0;

function walk(dir, depth = 0) {
  if (depth > 4) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs, depth + 1);
      continue;
    }
    if (!/\.(js|mjs|json|md|yml|yaml)$/.test(entry.name)) continue;
    // 跳过本文件：它的正则字面量必然包含全部特征字（否则无法检测），
    // 任何行级豁免都挡不住整文件扫描，会自我误报。
    if (abs === fileURLToPath(import.meta.url)) continue;
    checked++;
    const buf = fs.readFileSync(abs);
    const rel = path.relative(ROOT, abs);
    // ① BOM 检查
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      console.log(`  [BOM]  ${rel}`);
      bad++;
      continue;
    }
    // ② 首字节异常（合法文本不应以高位字节开头）
    if (buf.length > 0 && buf[0] > 0x7f) {
      console.log(`  [HIGH-FIRST-BYTE] ${rel} (0x${buf[0].toString(16)})`);
      bad++;
      continue;
    }
    // ③ 乱码模式检查（只查 .js/.mjs，避免 md 里的正常引用误报）
    if (/\.(js|mjs)$/.test(entry.name)) {
      const text = buf.toString('utf8');
      const m = looksMojibake(text);
      if (m !== null) {
        console.log(`  [MOJIBAKE] ${rel} -> "${m}"`);
        bad++;
      }
    }
  }
}

console.log('=== 编码体检 ===');
walk(ROOT);
console.log(`\n  检查了 ${checked} 个文件，发现 ${bad} 个编码问题`);
process.exit(bad > 0 ? 1 : 0);
