/**
 * 上游性能采样：记录每次对话的「首 token 延迟」与「输出速率」，
 * 供设置卡片展示（用户想直观看到当前上游的实际速度）。
 *
 * ── 为什么放在 shim 侧 ──────────────────────────────────────────────
 * 只有 shim 能精确观测到「上游首个内容帧到达」与「流结束」这两个时刻。
 * 放在 provider 或客户端都会引入额外误差。
 *
 * ── 统计口径 ────────────────────────────────────────────────────────
 *   ttftMs       首个**内容**帧到达的时间（不含签名与排队前的时间？含——见下）
 *   outputChars  本次输出的正文字符数（不含思考链）
 *   charsPerSec   outputChars / (流结束 - 首内容帧)
 *   totalMs      从请求进入到流结束
 *
 * ⚠️ 只统计**成功**且**有正文**的请求：失败请求、纯思考无正文的请求会污染
 * 速率（分母极小或分子为 0）。空样本时如实返回 null，不编造数字。
 *
 * @module dsh-qwen-connect/perf
 */

/** 采样窗口：只保留最近 N 次，避免长期运行后数组无限增长。 */
const WINDOW = 20;

/** @type {{ ttftMs: number, charsPerSec: number, totalMs: number, outputChars: number }[]} */
const samples = [];

/**
 * 记录一次成功的对话采样。
 *
 * @param {{ ttftMs: number, charsPerSec: number, totalMs: number, outputChars: number }} sample
 */
export function recordSample(sample) {
  if (
    typeof sample?.ttftMs !== 'number' ||
    typeof sample.charsPerSec !== 'number' ||
    typeof sample.totalMs !== 'number' ||
    typeof sample.outputChars !== 'number'
  ) {
    return;
  }
  // 只收有正文、速率有限的样本——否则统计无意义
  if (!Number.isFinite(sample.charsPerSec) || sample.charsPerSec <= 0) return;
  if (sample.outputChars <= 0) return;
  if (!Number.isFinite(sample.ttftMs) || sample.ttftMs < 0) return;

  samples.push({
    ttftMs: Math.round(sample.ttftMs),
    charsPerSec: Math.round(sample.charsPerSec * 10) / 10,
    totalMs: Math.round(sample.totalMs),
    outputChars: Math.round(sample.outputChars),
  });
  if (samples.length > WINDOW) samples.shift();
}

/**
 * 汇总当前采样窗口的性能指标。
 *
 * @returns {{ samples: number, ttftMs: number|null, charsPerSec: number|null,
 *             totalMs: number|null, lastTtftMs: number|null, lastCharsPerSec: number|null } | null}
 *          没有任何样本时返回 `null`（卡片据此不渲染该行，而不是显示 0）。
 */
export function perfSummary() {
  if (samples.length === 0) return null;
  const avg = (pick) => samples.reduce((s, x) => s + pick(x), 0) / samples.length;
  const last = samples[samples.length - 1];
  return {
    samples: samples.length,
    ttftMs: Math.round(avg((x) => x.ttftMs)),
    charsPerSec: Math.round(avg((x) => x.charsPerSec) * 10) / 10,
    totalMs: Math.round(avg((x) => x.totalMs)),
    lastTtftMs: last.ttftMs,
    lastCharsPerSec: last.charsPerSec,
  };
}

/** 清空采样（测试与卸载用）。 */
export function resetPerf() {
  samples.length = 0;
}
