/**
 * dsh-qwen-connect —— 认证与凭据层对外接口（t1 交付）。
 *
 * 交付契约（供 DSH 集成层与设置卡片消费）：
 *   loadCredentials()        → 解密并规范化凭据
 *   getValidToken()          → 返回可用 token，必要时自动续期
 *   getAccountInfo()         → 名称 / 套餐 / 积分
 *   getQuota()               → 额度明细
 *   getSession()             → token + 账号概览（集成层最常用）
 *   probeCredentials()       → 不抛异常的凭据就绪探测（供 UI 首屏）
 *   QwenAuthError / ErrorCode → 稳定错误分类
 *
 * 安全约束：凭据只在内存中持有；本模块不写任何日志文件、不含任何硬编码密钥。
 */

export {
  loadCredentials,
  probeCredentials,
  describeCredentials,
  isTokenExpired,
  normalizeCredentials,
  decryptV10,
  encryptV10,
  parseV10Payload,
  decryptCredentialsFile,
  defaultAppDataDir,
  toThenable,
  AUTH_V2_FILE,
  AUTH_V1_FILE,
  LOCAL_STATE_FILE,
} from './credentials.js';

export { unprotectMasterKey, unprotectWithPowerShell, stripDpapiPrefix, isSupportedPlatform } from './dpapi.js';

export {
  getValidToken,
  requestTokenRefresh,
  parseRefreshResponse,
  buildRefreshBody,
  persistRefreshedCredentials,
  DEFAULT_BASE_URL,
  REFRESH_PATH,
} from './auth.js';

export {
  apiGet,
  buildHeaders,
  fetchAccountInfo,
  fetchAccountOverview,
  extractAccountContext,
  extractQuotaUsage,
  extractUserPlan,
  ping,
  ENDPOINTS,
  APP_VERSION,
  APP_RELEASE_VERSION,
  APP_BUILD,
} from './rest.js';

export { QwenAuthError, ErrorCode, isQwenAuthError } from './errors.js';

import { loadCredentials } from './credentials.js';
import { getValidToken } from './auth.js';
import { apiGet, ENDPOINTS, extractQuotaUsage, fetchAccountOverview } from './rest.js';

/**
 * 高层便捷封装：一次拿到「可用 token + 账号概览」。
 *
 * @param {{ appDataDir?: string, forceRefresh?: boolean, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ token: string, credentials: object, refreshed: boolean, warning?: string,
 *   account: { name, username, tier, planId, quota, page, user, degraded } }>}
 */
export async function getSession(opts = {}) {
  const creds = opts.credentials ?? loadCredentials({ appDataDir: opts.appDataDir });
  const { token, credentials, refreshed, warning } = await getValidToken({ ...opts, credentials: creds });
  const overview = await fetchAccountOverview(token, { fetchImpl: opts.fetchImpl });
  return {
    token,
    credentials,
    refreshed,
    warning,
    account: {
      name: overview.user?.name ?? credentials.user?.name ?? null,
      username: overview.user?.username ?? credentials.user?.username ?? null,
      tier: overview.plan?.name ?? credentials.user?.tier ?? null,
      planId: overview.plan?.pid ?? credentials.user?.planId ?? null,
      quota: overview.quota ?? null,
      page: overview.page ?? null,
      user: overview.user ?? null,
      degraded: overview.degraded ?? false,
    },
  };
}

/**
 * 账号信息（阶段 B 最小交付集）：名称 / 套餐 / 积分。
 */
export async function getAccountInfo(opts = {}) {
  const { account, refreshed, warning } = await getSession(opts);
  return {
    name: account.name,
    username: account.username,
    tier: account.tier,
    planId: account.planId,
    quota: account.quota,
    refreshed,
    warning,
  };
}

/**
 * 积分/额度（独立轻量端点，字段较少但更稳定）。
 */
export async function getQuota(opts = {}) {
  const creds = opts.credentials ?? loadCredentials({ appDataDir: opts.appDataDir });
  const { token } = await getValidToken({ ...opts, credentials: creds });
  const payload = await apiGet(ENDPOINTS.quotaUsage, token, { fetchImpl: opts.fetchImpl });
  return extractQuotaUsage(payload);
}
