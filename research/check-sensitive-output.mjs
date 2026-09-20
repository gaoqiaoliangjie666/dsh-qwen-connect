// 敏感输出上下文扫描：找出敏感变量的**值**未经脱敏即流向输出的位置。
//
// 为什么需要它（队长复核中发现的结构性盲区）：
//   单纯匹配「完整真实值」无法发现下面这类泄漏——
//     console.log(`machineId=${String(mid).slice(0, 8)}`)
//   源文件里不存在那 8 个字符的字面量，它是运行期切出来的。
//   因此必须从「值的匹配」升级到「变量流向输出的路径」检查。
//
// 判据（收紧以避免误报）：
//   命中 = 输出的**参数位置**出现了敏感变量的取值表达式，且该表达式未被脱敏。
//   明确不算命中：
//     - 只取长度 / 布尔存在性：token.length、loginDeviceId ? 'yes' : 'no'、Boolean(x)
//     - 已被脱敏：maskId(x)、maskIdentifier(x)、x.masked、常量星号掩码
//     - 只出现在字符串字面量/注释里的变量名（如 log('=== token validity ===')）
//
// 用法：node research/check-sensitive-output.mjs [目录]
// 退出码：0 = 无问题，1 = 发现问题

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2] ?? path.resolve(import.meta.dirname, '..');

/** 敏感变量/属性的名字。 */
const NAMES = [
  'loginDeviceId',
  'user_id',
  'userId',
  'uid',
  'machineId',
  'token',
  'refreshToken',
  'accessToken',
  'encrypt_user_info',
  'security_oauth_token',
  'personal_access_token',
];

/** 输出汇聚点。 */
const SINK_RE = /(?:console\.(?:log|info|warn|debug|error|trace)|process\.(?:stdout|stderr)\.write|logger\.(?:log|info|warn|debug|error))\s*\(/;

/** 脱敏器（命中即视为已正确处理）。 */
const MASKER_RE = /maskId\s*\(|maskIdentifier\s*\(|\.masked\b|redact|safeMessage\s*\(|\[redacted\]|\*{3,}|\bmask\s*\(/i;

/**
 * 「只暴露元信息」的表达式：这些用法不泄漏值本身，必须排除，否则误报率高到
 * 无人会看结果。包括：
 *   x.length / x?.size        —— 只给长度
 *   x ? 'yes' : 'no'          —— 只给存在性
 *   Boolean(x) / !!x          —— 只给真值
 *   x === undefined / typeof x
 */
const META_ONLY_RE =
  /(?:\.\s*(?:length|size)\b|\?\s*['"][^'"]*['"]\s*:\s*['"]|Boolean\s*\(|!!|===?\s*(?:undefined|null)\b|typeof\s)/;

/**
 * 「比较表达式」：`a === b` / `a !== b` / `a == null` 的输出只是布尔结果，
 * 不泄漏任何一方的取值。整行若只由比较构成，应排除。
 *
 * 用保守判据：输出参数里出现敏感取值，但该取值**紧邻**比较运算符。
 */
const COMPARISON_RE = /(?:===?|!==?)\s*[\w$.\[\]?'"]|\b[\w$.\[\]?'"]\s*(?:===?|!==?)/;

/**
 * 「取值」表达式：变量名未紧跟 `.length` / `.size` / `??`-布尔判断 等
 * 只暴露元信息的用法。
 *
 * 用负向先行断言排除：
 *   x.length, x?.length, x.size, x === undefined, x ? , Boolean(x)
 */
function buildValueRe() {
  const alt = NAMES.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(
    `(?:[\\w$.\\[\\]?'"]*\\.)?(?:${alt})\\b`   // 允许 a.b.token、x?.token 等形态
    + `(?!\\s*(?:\\.\\s*(?:length|size)\\b|\\?\\.\\s*(?:length|size)\\b))`, // 不取长度
  );
}

const VALUE_RE = buildValueRe();

/**
 * 提取一行里的「字符串字面量」范围，用于排除仅出现在字面量中的名字
 * （例如 console.log('=== token validity ===') 里的 token 只是文案）。
 */
function literalRanges(line) {
  const ranges = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '"' || c === "'" || c === '`') {
      const start = i;
      i += 1;
      while (i < line.length) {
        if (line[i] === '\\') { i += 2; continue; }
        if (line[i] === c) break;
        i += 1;
      }
      ranges.push([start, i]);
    }
    i += 1;
  }
  return ranges;
}

function inAnyRange(pos, ranges) {
  return ranges.some(([a, b]) => pos >= a && pos <= b);
}

const SCAN_EXT = new Set(['.mjs', '.js', '.cjs', '.ts']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.agent-teams', 'wasm', 'glue']);

function walk(dir) {
  const out = [];
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of items) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      out.push(...walk(path.join(dir, e.name)));
    } else out.push(path.join(dir, e.name));
  }
  return out;
}

let findings = 0;
let scanned = 0;

for (const file of walk(ROOT)) {
  if (!SCAN_EXT.has(path.extname(file).toLowerCase())) continue;
  const base = path.basename(file);
  if (base.startsWith('check-leaks') || base.startsWith('check-sensitive-output')) continue;
  scanned += 1;

  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    if (!SINK_RE.test(line)) return;
    if (MASKER_RE.test(line)) return;
    if (META_ONLY_RE.test(line)) return;   // 该行只输出元信息，不落值
    // 只由比较构成的输出（`t === c.token`）结果恒为布尔，不泄漏取值
    if (COMPARISON_RE.test(line) && !/\+\s*[\w$.]*(?:token|machineId|loginDeviceId|uid)/i.test(line)) return;

    const ranges = literalRanges(line);
    const valueRe = new RegExp(VALUE_RE.source, 'g');
    let m;
    let hit = null;
    while ((m = valueRe.exec(line)) !== null) {
      // 只关心输出调用之后出现的取值
      const sinkIdx = line.search(SINK_RE);
      if (m.index < sinkIdx) continue;
      if (inAnyRange(m.index, ranges)) continue;   // 仅出现在文案里
      hit = m[0];
      break;
    }
    if (hit === null) return;

    findings += 1;
    console.log(`FINDING ${path.relative(ROOT, file).replace(/\\/g, '/')}:${i + 1}  [value: ${hit}]`);
    console.log(`        ${trimmed.slice(0, 160)}`);
  });
}

console.log(`\nscanned ${scanned} source files`);
console.log(
  findings === 0
    ? 'PASS: 未发现敏感变量未经脱敏即流向输出'
    : `FAIL: ${findings} 处敏感输出需要脱敏`,
);
process.exit(findings === 0 ? 0 : 1);
