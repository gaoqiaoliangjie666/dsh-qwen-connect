/**
 * 设置卡片的后端：把「登录态 + 账号 + 积分 + 套餐」汇总成一份状态文档，
 * 经同源 GET 路由下发给浏览器半。
 *
 * 安全边界（不可退让）：
 *  1. 只接受环回请求（见 ./loopback.js）。
 *  2. **绝不下发 token / refresh_token / 任何凭据明文**，只下发展示用的
 *     摘要字段。
 *  3. 任何要跨越到浏览器的错误文本都先经 `safeMessage()` 脱敏——卡片是
 *     浏览器渲染面，凭据若在此泄漏即等于泄漏到 DOM 与 devtools。
 *
 * @module dsh-qwen-connect/web-status
 */

import { QWENWORK_STATUS_PATH } from './status-paths.js';
import { loopbackRequest } from './loopback.js';

/** JWT（`eyJ...`）形态。 */
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu;
/** `key=value` 形态的敏感查询参数 / 表单字段。 */
const SECRET_KV_RE = /(\b(?:code|token|refresh_token|access_token|id_token|secret|password)=)[^&\s]+/giu;
/** `Bearer xxx` 形态。 */
const BEARER_RE = /\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/giu;

/**
 * 脱敏后再交给浏览器。永不返回未脱敏的原文。
 *
 * @param {unknown} error
 * @returns {string}
 */
export function safeMessage(error) {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  return raw
    .replace(JWT_RE, '[redacted token]')
    .replace(BEARER_RE, '$1[redacted]')
    .replace(SECRET_KV_RE, '$1[redacted]')
    .slice(0, 500);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/**
 * 判断某个错误是否属于 crypto-engineer 约定的 `QwenAuthError` 形态。
 *
 * 这里做**结构化判定**而非 `instanceof`：卡片后端与凭据模块可能运行在
 * 不同的模块实例/加载路径下，`instanceof` 会因双份类而失效。
 *
 * @param {unknown} error
 * @returns {error is { code: string, message: string, recovery?: string, retryable?: boolean }}
 */
function isCodedError(error) {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (/** @type {any} */ (error).code) === 'string'
  );
}

/**
 * 把任意异常归一化成可安全下发的 `{ code, message, recovery, retryable }`。
 *
 * @param {unknown} error
 */
function toErrorPayload(error) {
  if (isCodedError(error)) {
    const e = /** @type {any} */ (error);
    return {
      code: e.code,
      message: safeMessage(e.message),
      ...(typeof e.recovery === 'string' && e.recovery !== ''
        ? { recovery: safeMessage(e.recovery) }
        : {}),
      ...(typeof e.retryable === 'boolean' ? { retryable: e.retryable } : {}),
    };
  }
  return { code: 'UNKNOWN', message: safeMessage(error) };
}

/**
 * 组装卡片状态文档。
 *
 * 依赖以函数注入，便于在 t1 未交付时传入桩实现，也便于单测。
 *
 * @param {{
 *   getAccountContext: () => Promise<any>,
 *   tokenAvailable: () => Promise<boolean>,
 *   models: () => Array<{ id: string, name: string, description?: string }>,
 *   provider: string,
 * }} deps
 */
export async function qwenWorkWebStatus(deps) {
  /** @type {Record<string, unknown>} */
  const status = {
    status: 'unknown',
    provider: deps.provider,
  };

  // ---- 登录态 / 账号 / 积分 / 套餐 -------------------------------------
  try {
    const context = await deps.getAccountContext();
    const user = context?.user;
    const plan = context?.plan;
    const quota = context?.quota;

    status.status = 'signed-in';
    if (context?.degraded === true) status.degraded = true;

    // t1 的归一化字段：user.name / user.username / user.email
    const nickname = user?.name ?? user?.nickname ?? user?.displayName;
    if (typeof nickname === 'string' && nickname !== '') status.nickname = nickname;
    const account = user?.username ?? user?.email ?? user?.phone ?? user?.mobile;
    if (typeof account === 'string' && account !== '') status.account = account;

    const remaining = normaliseRemaining(quota);
    if (remaining !== undefined) status.remaining = remaining;
    const used = normaliseUsed(quota);
    if (used !== undefined) status.used = used;
    const total = normaliseTotal(quota);
    if (total !== undefined) status.total = total;

    // t1 的归一化字段：plan.name / plan.pid / plan.isPersonalVersion
    const tierName = plan?.name ?? plan?.tierName ?? plan?.tier_name ?? plan?.displayName;
    if (typeof tierName === 'string' && tierName !== '') status.tierName = tierName;
    const tier = plan?.pid ?? plan?.tier ?? plan?.level ?? plan?.code;
    if (typeof tier === 'string' || typeof tier === 'number') status.tier = tier;
    const isPersonal = plan?.isPersonalVersion ?? plan?.isPersonal ?? plan?.is_personal_version;
    if (typeof isPersonal === 'boolean') status.isPersonal = isPersonal;

    const nextDue = plan?.nextDueDate ?? plan?.next_due_date;
    if (typeof nextDue === 'string' && nextDue !== '') status.nextDueDate = nextDue;

    // ---- 积分（卡片唯一展示的额度项）----------------------------------
    const entitlements = buildEntitlements({ quota: context?.quota, plan, page: context?.page });
    if (entitlements.length > 0) status.entitlements = entitlements;

    // 进度条参考基准：仅在上游**没给 total** 时使用（给了就用真实的 total）。
    // 这不是臆造值——它是本进程观测到的最大剩余积分，语义为
    // 「相对你见过的最好水平」，卡片文案会据此措辞。
    if (status.remaining !== undefined) {
      const credits = entitlements.find((e) => e.key === 'credits');
      if (credits?.size === undefined) {
        const baseline = creditBaseline(status.remaining);
        if (baseline !== undefined) status.creditBaseline = baseline;
      }
    }
  } catch (error) {
    status.status = 'signed-out';
    status.error = toErrorPayload(error);
  }

  // ---- 模型目录（静态内置，不依赖 upstream） ---------------------------
  try {
    const models = deps.models();
    if (Array.isArray(models) && models.length > 0) status.models = models;
  } catch {
    /* 模型目录缺失不影响卡片主要信息 */
  }

  // ---- 上游性能指标（来自 shim 的实测采样）-----------------------------
  // 无样本时**不产出该字段**，卡片据此不渲染那一行——而不是显示 0 或假值。
  try {
    const perf = deps.perf?.();
    if (perf !== null && perf !== undefined && typeof perf === 'object') {
      status.perf = perf;
    }
  } catch {
    /* 性能指标缺失不影响卡片主要信息 */
  }

  return status;
}

/**
 * 把候选值转成有限数值。
 *
 * ⚠️ 必须先排除 `null` / `undefined` / 空串，再 `Number()`：
 * `Number(null)` 是 `0`，会把「上游没给这个字段」误判成「值为 0」——
 * 卡片上就会显示「已用 0 / 总额 0」这种**编造的数字**，而验收明确禁止
 * 展示非真实来源的数值。缺失必须保持 `undefined`，由卡片决定不渲染该行。
 *
 * @param {unknown} value
 * @returns {number | undefined}
 */
function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** 从各种可能的额度结构里取「剩余积分」。 */
function normaliseRemaining(quota) {
  if (quota === undefined || quota === null) return undefined;
  return firstFinite(
    quota.remaining,
    quota.remaining_credits,
    quota.credits_remaining,
    quota.balance,
    quota.left,
  );
}

/** 从各种可能的额度结构里取「已用积分」。 */
function normaliseUsed(quota) {
  if (quota === undefined || quota === null) return undefined;
  return firstFinite(quota.used, quota.used_credits, quota.consumed, quota.total_used);
}

/** 从各种可能的额度结构里取「总额度」。 */
function normaliseTotal(quota) {
  if (quota === undefined || quota === null) return undefined;
  return firstFinite(quota.total, quota.total_credits, quota.quota, quota.limit);
}

/** 返回第一个可解析为有限数值的候选。 */
function firstFinite(...candidates) {
  for (const value of candidates) {
    const n = toFiniteNumber(value);
    if (n !== undefined) return n;
  }
  return undefined;
}

/**
 * 组装卡片上的「配额」条目。
 *
 * ⚠️ **只产出「积分」一项**。此前还带上会话数 / 存储空间 / 页面额度 /
 * 月度请求 / 月度流量——那些是套餐权益上限，与日常使用无关，反而把真正
 * 关心的积分余额淹没了（见用户要求精简的反馈）。
 *
 * ⚠️ **绝不编造数字**：上游对消费级套餐只返回 `quota.remaining`，
 * `total` / `used` 均为 `null`。此时**不推断**总量，只如实展示剩余值。
 * 这是本项目一贯的原则——缺失就保持缺失，由卡片决定不渲染该行。
 *
 * @param {{ quota?: any, plan?: any, page?: any }} ctx
 * @returns {Array<{ key: string, label: string, remain?: number, size?: number, unit?: string, detail?: string }>}
 */
function buildEntitlements(ctx) {
  const out = [];
  const quota = ctx.quota ?? {};

  // 积分：上游给了 total 就画真实进度条，没给就只展示剩余值。
  const remaining = firstFinite(quota.remaining, quota.remaining_credits, quota.left);
  const total = firstFinite(quota.total, quota.total_credits, quota.limit);
  if (remaining !== undefined) {
    out.push({
      key: 'credits',
      label: '积分',
      remain: remaining,
      ...(total !== undefined ? { size: total } : {}),
      unit: 'credits',
    });
  }

  return out;
}

/**
 * 计算积分进度条的**参考基准**（上游不给总量时的回退）。
 *
 * 背景：Free 套餐的 `quota.total` 为 `null`（实测），没有真实分母就画不出
 * 有意义的百分比。
 *
 * **语义：消耗进度**（当前余额 / 本进程观测到的最高余额）。
 *   - 刚签到 / 满额 → 100%（满格）
 *   - 用掉一些 → 条变短，直观反映「这轮消耗了多少」
 *
 * 为啥不用固定分母 2000（Free 初始额度）：
 *   积分随每日签到累积（初始 2000，每日 +100，**无上限**——上游没有任何
 *   limit/max 字段），实测账号已达 2095.3 > 2000。固定分母会让进度条
 *   长期爆表停在 100%，失去指示意义。
 *
 * 为啥不用「进程内最大值」以外的猜测值：那是编造——不同账号的用量与
 * 签到进度不同，只有**真实观测到的**余额才可作为参照。
 *
 * @param {number | undefined} remaining 当前剩余
 * @returns {number | undefined}
 */
function creditBaseline(remaining) {
  if (typeof remaining !== 'number' || !Number.isFinite(remaining) || remaining <= 0) {
    return undefined;
  }
  if (PBASELINE_SEED > maxObservedCredits) maxObservedCredits = PBASELINE_SEED;
  if (remaining > maxObservedCredits) maxObservedCredits = remaining;
  return maxObservedCredits;
}

/**
 * Free 套餐初始额度（用户提供，并经真实数据验证：
 * 实测余额 2095.3 ≈ 2000 + 100×1 - 少量消耗）。
 *
 * 作用仅是把首个快照的水位条钉在合理刻度上——之后随真实观测自动抬升。
 */
const PBASELINE_SEED = 2000;

/** 进程内观测到的最大剩余积分（作为消耗进度的分母，非臆造值）。 */
let maxObservedCredits = 0;

/**
 * 状态路由的请求处理器。抽成独立函数，便于单测直接挂到裸 server 上。
 *
 * @param {Parameters<typeof qwenWorkWebStatus>[0]} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function qwenWorkStatusHandler(deps) {
  return async (req, res) => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' });
      return;
    }
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' });
      return;
    }
    try {
      json(res, 200, await qwenWorkWebStatus(deps));
    } catch (error) {
      json(res, 500, { error: safeMessage(error) });
    }
  };
}

/**
 * 把 GET 状态路由挂到可选的 webServer 上下文上。
 *
 * 优先经 `ctx.effect` 注册（DSH 卸载插件时会自动调用 disposer）；
 * 若当前上下文没有 `effect`（版本差异），则直接挂载——路由仍可用，
 * 只是失去自动清理（对常驻插件而言与 DSH 进程同生命周期，可接受）。
 *
 * @param {{ effect?: (fn: () => () => void, label?: string) => void, webServer?: { register: Function } }} ctx
 * @param {Parameters<typeof qwenWorkWebStatus>[0]} deps
 */
export function registerQwenWorkStatusRoute(ctx, deps) {
  const mount = () => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: QWENWORK_STATUS_PATH,
      handler: qwenWorkStatusHandler(deps),
    });
    return dispose;
  };

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => mount(), 'dsh-qwen-connect: Web status route');
    return;
  }

  // 降级路径：effect 不可用时仍要挂上（设置卡片依赖这条路由），
  // 只是不能随插件卸载而注销。
  try {
    mount();
  } catch (error) {
    // webServer 也没有：当前环境确实提供不了卡片数据源，静默跳过
    // （host provider 不受影响；卡片会显示「读取状态失败」而非白屏）。
    void error;
  }
}
