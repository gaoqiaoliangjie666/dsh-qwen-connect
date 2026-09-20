/**
 * QwenWorkCN 网关 REST 客户端。
 *
 * 全部端点均在 2026-02-21 实测返回 HTTP 200（见 _qwen_probe/探测报告.md）：
 *   GET /api/v2/quota/usage                                                   额度
 *   GET /api/v2/user/plan                                                     套餐
 *   GET /api/v3/user/status                                                   账号状态
 *   GET /api/v1/adapter/user/account-context?include=user,plan,quota,page,data_sharing
 *   GET /api/v1/adapter/auth/identities                                       身份
 *   GET /algo/api/v1/ping                                                     连通性
 *
 * 注意：/api/v2/model/list 与 /api/v2/service/pro/sse/* 需要 WASM 签名，403，
 * 不属于本模块职责（阶段 A 的 wasm 逆向负责）。
 */

import { QwenAuthError, ErrorCode } from './errors.js';
import { DEFAULT_BASE_URL } from './auth.js';

/** 与 App 1.0.5 保持一致的客户端标识 */
export const APP_VERSION = '1.0.5';
export const APP_RELEASE_VERSION = '1.0.5-26090806';
export const APP_BUILD = '26090806';

export function buildHeaders(token, platform = process.platform, arch = process.arch) {
  return {
    authorization: `Bearer ${token}`,
    'user-agent': `qoderwork/${APP_VERSION}`,
    'x-qwenwork-version': APP_VERSION,
    'x-qwenwork-release-version': APP_RELEASE_VERSION,
    'x-qwenwork-build': APP_BUILD,
    'x-qwenwork-platform': platform,
    'x-qwenwork-arch': arch,
    'x-qwenwork-channel': 'stable',
    accept: 'application/json',
  };
}

export const ENDPOINTS = {
  ping: '/algo/api/v1/ping',
  quotaUsage: '/api/v2/quota/usage',
  userPlan: '/api/v2/user/plan',
  userStatus: '/api/v3/user/status',
  accountContext: '/api/v1/adapter/user/account-context?include=user,plan,quota,page,data_sharing',
  identities: '/api/v1/adapter/auth/identities',
};

/**
 * 低层 GET：统一错误分类。
 */
export async function apiGet(pathname, token, opts = {}) {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await doFetch(baseUrl + pathname, {
      method: 'GET',
      headers: buildHeaders(token, opts.platform, opts.arch),
      signal: ac.signal,
    });
  } catch (e) {
    throw new QwenAuthError(
      ErrorCode.API_ERROR,
      `请求 ${pathname} 失败（网络错误）：${e.message}`,
      { cause: e, retryable: true },
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text().catch(() => '');
  if (res.status === 401 || res.status === 403) {
    throw new QwenAuthError(
      ErrorCode.API_UNAUTHORIZED,
      `请求 ${pathname} 鉴权失败（HTTP ${res.status}）：${text.slice(0, 200)}`,
    );
  }
  if (!res.ok) {
    throw new QwenAuthError(
      ErrorCode.API_ERROR,
      `请求 ${pathname} 失败（HTTP ${res.status}）：${text.slice(0, 200)}`,
      { retryable: res.status >= 500 },
    );
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch (e) {
    throw new QwenAuthError(
      ErrorCode.API_ERROR,
      `请求 ${pathname} 的响应不是合法 JSON。`,
      { cause: e },
    );
  }
}

// ---------------------------------------------------------------------------
// 业务查询
// ---------------------------------------------------------------------------

/** 连通性探针 */
export async function ping(opts = {}) {
  return apiGet(ENDPOINTS.ping, opts.token ?? '', opts);
}

/**
 * 从 account-context 响应中抽取积分/额度/套餐（主数据源）。
 */
export function extractAccountContext(payload) {
  const data = payload?.data ?? payload ?? {};
  const quota = data.quota ?? {};
  const plan = data.plan ?? {};
  const user = data.user ?? {};
  const page = data.page ?? {};

  const remaining = firstNumber(quota.remaining, quota.remaining_quota, quota.left);
  const total = firstNumber(quota.total, quota.total_quota, quota.limit);
  // 服务端对 Free 套餐返回 total: null，此时 used 也多为 null（而非 0）
  const used = firstNumber(quota.used, quota.used_quota);

  return {
    user: {
      id: user.id ?? null,
      name: user.name ?? null,
      username: user.username ?? null,
      email: user.email ?? null,
      isBiz: user.is_biz ?? false,
      isVerified: user.is_verified ?? null,
      isActive: user.is_active ?? null,
    },
    plan: {
      pid: plan.pid ?? null,
      name: plan.name ?? null,
      userType: plan.user_type ?? null,
      isPersonalVersion: plan.is_personal_version ?? null,
      isSubscribed: plan.is_subscribed ?? null,
      subscriptionStatus: plan.subscription_status ?? null,
      period: plan.period || null,
      nextDueDate: normalizeDate(plan.next_due_date),
      nextDeductDate: normalizeDate(plan.next_deduct_date),
      sessions: plan.sessions ?? null,
      storage: plan.storage ?? null,
    },
    quota: {
      remaining,
      total,
      used,
      unit: quota.unit ?? 'credits',
      exceeded: quota.exceeded ?? null,
      // 百分比字段缺失时按 remaining/total 推导；Free 套餐 total 为 null 时保持 null
      usedPercentage: firstNumber(quota.used_percentage, quota.total_usage_percentage)
        ?? (total ? Math.round(((used ?? 0) / total) * 100) : null),
    },
    // page_quota 位于 account-context 的 page 段（不是 plan 段）
    page: {
      quota: page.page_quota ?? null,
      monthRequests: page.month_requests ?? null,
      monthTraffic: page.month_traffic ?? null,
      customHostname: page.custom_hostname ?? null,
      accessCode: page.access_code ?? null,
      databaseEnabled: page.page_database_enabled ?? null,
    },
    raw: payload,
  };
}

/** 额度（独立的轻量端点，字段是 snake_case） */
export function extractQuotaUsage(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return {
    userId: payload.user_id ?? null,
    userType: payload.user_type ?? null,
    totalUsagePercentage: payload.total_usage_percentage ?? null,
    isHighestTier: payload.is_highest_tier ?? null,
    isQuotaExceeded: payload.is_quota_exceeded ?? null,
    isPlanQuotaProrated: payload.is_plan_quota_prorated ?? null,
    userQuota: payload.user_quota ?? null,
    addOnQuota: payload.add_on_quota ?? null,
    orgResourcePackage: payload.org_resource_package ?? null,
  };
}

/** 套餐 */
export function extractUserPlan(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return {
    userType: payload.user_type ?? null,
    planTierName: payload.plan_tier_name ?? null,
    planTier: payload.plan_tier ?? null,
    isPersonalVersion: payload.is_personal_version ?? null,
    organization: payload.organization ?? null,
  };
}

/** 打包查询账号概览（设置卡片主数据源） */
export async function fetchAccountOverview(token, opts = {}) {
  // account-context 是主数据源；它挂掉时退到轻量端点，保证卡片仍能渲染
  let context = null;
  let contextError = null;
  try {
    const payload = await apiGet(ENDPOINTS.accountContext, token, opts);
    context = extractAccountContext(payload);
  } catch (e) {
    contextError = e;
  }

  if (!context) {
    // 降级：额度 + 套餐分开取
    const [usage, plan] = await Promise.all([
      apiGet(ENDPOINTS.quotaUsage, token, opts).catch(() => null),
      apiGet(ENDPOINTS.userPlan, token, opts).catch(() => null),
    ]);
    if (!usage && !plan) throw contextError ?? new QwenAuthError(ErrorCode.API_ERROR, '账号信息查询失败。');
    return {
      degraded: true,
      user: null,
      plan: plan
        ? { pid: plan.plan_tier ?? null, name: plan.plan_tier_name ?? null, userType: plan.user_type ?? null, isPersonalVersion: plan.is_personal_version ?? null }
        : null,
      quota: { remaining: null, total: null, used: null, usedPercentage: usage?.total_usage_percentage ?? null, unit: 'credits' },
      usage: extractQuotaUsage(usage),
      rawPlan: plan,
    };
  }

  return { ...context, degraded: false, usage: null };
}

/**
 * 账号信息（阶段 B 交付要求的最小集）。
 * @returns {Promise<{ name: string|null, tier: string|null, planId: string|null, quota: object|null }>}
 */
export async function fetchAccountInfo(token, opts = {}) {
  const overview = await fetchAccountOverview(token, opts);
  return {
    name: overview.user?.name ?? null,
    username: overview.user?.username ?? null,
    tier: overview.plan?.name ?? null,
    planId: overview.plan?.pid ?? null,
    quota: overview.quota ?? null,
  };
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function firstNumber(...vals) {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

function normalizeDate(v) {
  if (!v) return null;
  if (typeof v === 'string' && v.startsWith('0001-01-01')) return null; // Go 零值
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
