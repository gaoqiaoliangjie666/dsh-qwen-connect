/**
 * shim 诊断日志：把请求级时序写到固定文件，独立于 DSH 的日志体系。
 *
 * 为什么需要它：排查「长思考超时」时发现——DSH 的 ctx.logger 不落盘，
 * harness.log 里看不到我们 shim 的任何输出，等于**在黑暗里调试**。
 * 这份文件日志给出每次请求的完整时间线：
 *   进入 → 鉴权结果 → 响应头到达 → 首帧 → 流结束/失败（含原因）
 *
 * ⚠️ 只写一行 JSON、追加模式、上限 512KB（超过即截断重开），
 *    避免长期运行撑爆磁盘。诊断完成后可整体移除本模块。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const LOG_PATH = path.join(os.tmpdir(), 'dsh-qwen-connect-trace.log');
const MAX_BYTES = 512 * 1024;

/** 追加一行诊断日志；失败静默（诊断工具绝不能反过来弄挂对话）。 */
export function trace(event, data = {}) {
  try {
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > MAX_BYTES) {
      fs.writeFileSync(LOG_PATH, '', 'utf8');
    }
    const line =
      JSON.stringify({ t: new Date().toISOString(), event, ...data }) + '\n';
    fs.appendFileSync(LOG_PATH, line, 'utf8');
  } catch {
    /* 诊断日志绝不影响主流程 */
  }
}

export { LOG_PATH };
