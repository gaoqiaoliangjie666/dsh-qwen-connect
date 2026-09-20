// test/unit/perf.test.mjs
//
// 上游性能采样的统计口径锁定。
// 背景：卡片要展示「首 token 延迟 / 输出速率」，数据由 shim 实测采集。
// 关键原则：**没有样本时不产指标**（返回 null），绝不显示 0 或假值。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { recordSample, perfSummary, resetPerf } from '../../lib/perf.js';

test('perfSummary：无样本时返回 null（不编造 0）', () => {
  resetPerf();
  assert.equal(perfSummary(), null, '没有实测数据时必须是 null，卡片据此不渲染该行');
});

test('perfSummary：单样本的平均值等于样本本身', () => {
  resetPerf();
  recordSample({ ttftMs: 800, charsPerSec: 100, totalMs: 2000, outputChars: 120 });
  const p = perfSummary();
  assert.equal(p.samples, 1);
  assert.equal(p.ttftMs, 800);
  assert.equal(p.charsPerSec, 100);
  assert.equal(p.lastTtftMs, 800);
});

test('perfSummary：多样本取均值，last* 反映最近一次', () => {
  resetPerf();
  recordSample({ ttftMs: 1000, charsPerSec: 80, totalMs: 3000, outputChars: 160 });
  recordSample({ ttftMs: 500, charsPerSec: 120, totalMs: 2000, outputChars: 180 });
  const p = perfSummary();
  assert.equal(p.samples, 2);
  assert.equal(p.ttftMs, 750, '(1000+500)/2');
  assert.equal(p.charsPerSec, 100, '(80+120)/2');
  assert.equal(p.lastTtftMs, 500, '最近一次');
  assert.equal(p.lastCharsPerSec, 120, '最近一次');
});

test('recordSample：无正文的样本被拒绝（否则速率统计失真）', () => {
  resetPerf();
  recordSample({ ttftMs: 100, charsPerSec: 50, totalMs: 1000, outputChars: 0 });
  assert.equal(perfSummary(), null, 'outputChars=0 的样本不得计入');
});

test('recordSample：非法速率被拒绝（NaN / Infinity / 负数）', () => {
  resetPerf();
  recordSample({ ttftMs: 100, charsPerSec: Number.NaN, totalMs: 1000, outputChars: 10 });
  recordSample({ ttftMs: 100, charsPerSec: Number.POSITIVE_INFINITY, totalMs: 1000, outputChars: 10 });
  recordSample({ ttftMs: 100, charsPerSec: -5, totalMs: 1000, outputChars: 10 });
  assert.equal(perfSummary(), null, '非法速率一律拒绝');
});

test('recordSample：畸形对象被安全忽略（不抛异常）', () => {
  resetPerf();
  assert.doesNotThrow(() => {
    recordSample(null);
    recordSample(undefined);
    recordSample({});
    recordSample({ ttftMs: 'x', charsPerSec: 'y', totalMs: 'z', outputChars: 'w' });
  });
  assert.equal(perfSummary(), null);
});

test('recordSample：窗口上限 20，超出后淘汰最旧样本', () => {
  resetPerf();
  for (let i = 0; i < 25; i++) {
    recordSample({ ttftMs: 100 + i, charsPerSec: 50, totalMs: 1000, outputChars: 10 });
  }
  const p = perfSummary();
  assert.equal(p.samples, 20, '最多保留 20 个样本，避免长期运行后无限增长');
  // 最早保留的应是第 6 个（i=5 → 105），最旧 5 个被淘汰
  assert.equal(p.lastTtftMs, 124, '最后一次是 i=24 → 124');
});

test('perfSummary：数值为整数或一位小数，不出现浮点尾巴', () => {
  resetPerf();
  recordSample({ ttftMs: 100.7, charsPerSec: 88.33333, totalMs: 1000, outputChars: 50 });
  const p = perfSummary();
  assert.equal(p.ttftMs, 101, 'ttft 取整');
  assert.equal(p.charsPerSec, 88.3, '速率保留一位小数');
});
