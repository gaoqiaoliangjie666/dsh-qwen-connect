// research/probes-2026-09-14/analyze-slow-detail.mjs
// 深挖慢请求：每个 >60s 的请求，它的事件序列是什么（卡在哪一步）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOG = path.join(os.tmpdir(), 'dsh-qwen-connect-trace.log');
const rows = fs
  .readFileSync(LOG, 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);

// 配对请求
const sessions = [];
let cur = null;
for (const r of rows) {
  if (r.event === 'request-in') {
    if (cur) sessions.push(cur);
    cur = { start: r.t, events: [] };
  } else if (cur) {
    cur.events.push(r);
    if (['stream-end', 'upstream-fail', 'reject'].includes(r.event)) {
      sessions.push(cur);
      cur = null;
    }
  }
}
if (cur) sessions.push(cur);

console.log('=== >60s 请求的完整事件序列 ===\n');
for (const s of sessions) {
  const startMs = Date.parse(s.start);
  const last = s.events[s.events.length - 1];
  const dur = Date.parse(last.t) - startMs;
  if (dur <= 60000) continue;

  console.log(`── 请求 @ ${s.start.slice(11, 19)} （总 ${dur}ms）──`);
  for (const e of s.events) {
    const rel = Date.parse(e.t) - startMs;
    const extra = e.event === 'upstream-headers' ? `status=${e.status}` : e.event === 'stream-end' ? `clientGone=${e.clientGone} errored=${e.errored} finished=${e.finished} idle=${e.idleFired} chars=${e.outputChars}` : '';
    console.log(`   +${String(rel).padStart(7)}ms  ${e.event}  ${extra}`);
  }
  console.log('');
}
