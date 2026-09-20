// research/probes-2026-09-14/analyze-trace.mjs
// 分析 shim trace 日志：找超时/异常/慢请求，输出完整时间线统计。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOG = path.join(os.tmpdir(), 'dsh-qwen-connect-trace.log');
if (!fs.existsSync(LOG)) {
  console.log('trace 文件不存在');
  process.exit(1);
}
const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter((l) => l.trim() !== '');
const rows = [];
for (const l of lines) {
  try { rows.push(JSON.parse(l)); } catch { /* 跳过坏行 */ }
}

console.log(`=== 1) 事件统计（共 ${rows.length} 行）===`);
const byEvent = {};
for (const r of rows) byEvent[r.event] = (byEvent[r.event] ?? 0) + 1;
for (const [k, v] of Object.entries(byEvent).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(24)} ${v}`);
}

console.log('\n=== 2) 异常事件 ===');
const bad = rows.filter((r) => ['idle-watchdog-fired', 'upstream-fail', 'upstream-rejected'].includes(r.event));
if (bad.length === 0) {
  console.log('  无 idle-watchdog / upstream-fail / upstream-rejected');
} else {
  for (const r of bad) {
    console.log(`  [${r.t}] ${r.event} ms=${r.ms} ${r.error ? 'err=' + String(r.error).slice(0, 80) : 'status=' + r.status}`);
  }
}

console.log('\n=== 3) 请求时间线（按请求配对）===');
// request-in 开始，到 stream-end / upstream-fail / reject 结束
const sessions = [];
let cur = null;
for (const r of rows) {
  if (r.event === 'request-in') {
    if (cur) sessions.push({ ...cur, incomplete: true });
    cur = { start: r.t, events: [r] };
  } else if (cur) {
    cur.events.push(r);
    if (['stream-end', 'upstream-fail', 'reject'].includes(r.event)) {
      sessions.push(cur);
      cur = null;
    }
  }
}
if (cur) sessions.push({ ...cur, incomplete: true });

console.log(`  共 ${sessions.length} 个请求`);
const slow = [];
for (const s of sessions) {
  const end = s.events[s.events.length - 1];
  const startMs = Date.parse(s.start);
  const endMs = Date.parse(end.t);
  const dur = endMs - startMs;
  const flags = [];
  const byE = {};
  for (const e of s.events) byE[e.event] = e;
  if (end.event === 'reject') flags.push('rejected:' + end.reason);
  if (end.event === 'upstream-fail') flags.push('upstream-fail');
  if (byE['idle-watchdog-fired']) flags.push('IDLE-WATCHDOG');
  if (byE['stream-end']?.clientGone) flags.push('client-gone');
  if (byE['stream-end']?.errored) flags.push('errored');
  const mark = dur > 60000 || flags.length > 0 ? '⚠️' : ' ';
  const line = `  ${mark} ${s.start.slice(11, 19)} ${String(dur).padStart(7)}ms ${end.event.padEnd(20)} ${flags.join(',')}`;
  console.log(line);
  if (mark === '⚠️') slow.push(line);
}

console.log(`\n=== 4) 汇总 ===`);
console.log(`  异常/慢请求: ${slow.length} 个`);
if (slow.length > 0) {
  console.log('  → 需要重点看的行如上（⚠️）');
} else {
  console.log('  → 全部请求正常完成');
}

// 首 token 延迟分布
const fcs = rows.filter((r) => r.event === 'first-content').map((r) => r.ms);
if (fcs.length > 0) {
  const sorted = [...fcs].sort((a, b) => a - b);
  console.log(`\n=== 5) 首 token 延迟（${fcs.length} 次）===`);
  console.log(`  最小 ${sorted[0]}ms | 中位 ${sorted[Math.floor(sorted.length / 2)]}ms | 最大 ${sorted[sorted.length - 1]}ms`);
  const over30s = fcs.filter((x) => x > 30000).length;
  console.log(`  >30s 的次数: ${over30s}`);
}
