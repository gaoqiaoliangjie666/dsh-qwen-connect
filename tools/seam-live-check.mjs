/**
 * 接缝连通性实测：把 t1 的真实实现经 lib/credentials-seam.js 跑一遍，
 * 验证集成层能真正拿到账号 / 积分 / 套餐数据。
 *
 * ⚠️ 安全约束：本脚本**不打印账号识别信息**（昵称、用户名、邮箱、user id、
 * 设备 id 等）。只报「字段是否存在」与「数值是否为有限数」。
 * 需要看具体数值时请走 `lib/web-status.js` 的 status 路由，那条路径自带脱敏。
 * 输出一律走 stdout，不落盘。
 *
 * 用法：node tools/seam-live-check.mjs
 */

import {
  isWired,
  loadDiagnostic,
  getAccountContext,
  fetchQuota,
  fetchPlan,
} from '../lib/credentials-seam.js';

const line = (s) => process.stdout.write(`${s}\n`);

/** 字段是否存在，不报值。 */
const present = (v) => (v === null || v === undefined ? '缺失' : '存在');
/** 数值只报「是否为有限数」。 */
const numeric = (v) =>
  v === null || v === undefined ? '缺失' : Number.isFinite(Number(v)) ? '有限数' : '非数';

line(`isWired: ${await isWired()}`);
const diag = loadDiagnostic();
line(`loadDiagnostic: ${diag === '' ? '(无错误)' : diag}`);

try {
  const ctx = await getAccountContext();
  line('--- getAccountContext（只报字段存在性）---');
  line(`  user:  ${present(ctx?.user)}  (name=${present(ctx?.user?.name)}, username=${present(ctx?.user?.username)}, email=${present(ctx?.user?.email)})`);
  line(`  plan:  ${present(ctx?.plan)}  (name=${present(ctx?.plan?.name)}, pid=${present(ctx?.plan?.pid)}, isPersonalVersion=${present(ctx?.plan?.isPersonalVersion)})`);
  line(`  quota: ${present(ctx?.quota)}  (remaining=${numeric(ctx?.quota?.remaining)}, total=${numeric(ctx?.quota?.total)}, used=${numeric(ctx?.quota?.used)})`);
  line(`  degraded: ${ctx?.degraded}`);
} catch (error) {
  line(`getAccountContext ERR [${error?.code ?? error?.name}]: ${error?.message}`);
  if (error?.recovery) line(`  recovery: ${error.recovery}`);
}

try {
  line('--- fetchQuota（只报类型）---');
  const q = await fetchQuota();
  line(`  remaining=${numeric(q.remaining)} total=${numeric(q.total)} used=${numeric(q.used)} exceeded=${present(q.exceeded)}`);
} catch (error) {
  line(`fetchQuota ERR [${error?.code ?? error?.name}]: ${error?.message}`);
}

try {
  line('--- fetchPlan（只报存在性）---');
  const p = await fetchPlan();
  line(`  tierName=${present(p.tierName)} tier=${present(p.tier)} isPersonal=${present(p.isPersonal)}`);
} catch (error) {
  line(`fetchPlan ERR [${error?.code ?? error?.name}]: ${error?.message}`);
}

// 端到端：把接缝喂给卡片后端，检查最终下发文档的**形状**与**安全性**
const { qwenWorkWebStatus } = await import('../lib/web-status.js');
const { catalogForCard } = await import('../lib/models.js');
const status = await qwenWorkWebStatus({
  getAccountContext,
  tokenAvailable: isWired,
  models: catalogForCard,
  provider: 'qwenwork',
});

line('--- 卡片状态文档（形状与安全断言）---');
line(`  status=${status.status} provider=${status.provider}`);
line(`  含 nickname=${present(status.nickname)} 含 account=${present(status.account)}`);
line(`  remaining=${numeric(status.remaining)} tierName=${present(status.tierName)}`);
line(`  models 数量=${Array.isArray(status.models) ? status.models.length : 0}`);

// 安全断言 1：下发的文档里绝不允许出现 JWT 形态
const serialised = JSON.stringify(status);
const jwtLike = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u;
line(`  安全断言 JWT 未下发: ${jwtLike.test(serialised) ? 'FAIL —— 含 JWT!' : 'PASS 通过'}`);

// 安全断言 2：不得出现任何 token 字段名携带值
const tokenLeak = /"(accessToken|refreshToken|refresh_token|access_token|token)"\s*:/u.test(
  serialised,
);
line(`  安全断言 无 token 字段: ${tokenLeak ? 'FAIL —— 出现 token 字段!' : 'PASS 通过'}`);

line('\n（本脚本不输出账号识别信息；输出仅到 stdout，不落盘。）');

// 显式退出：`apply()` 会启动环回聊天 shim（真实监听的 HTTP server），
// 其句柄让事件循环继续存活，进程不会自己退出。测试脚本需显式结束。
process.exit(0);
