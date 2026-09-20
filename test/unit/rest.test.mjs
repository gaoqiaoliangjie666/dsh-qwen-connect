import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHeaders, apiGet, extractAccountContext, extractQuotaUsage,
  extractUserPlan, fetchAccountOverview, fetchAccountInfo, ENDPOINTS,
  APP_VERSION,
} from '../../lib/rest.js';
import { ErrorCode } from '../../lib/errors.js';

function mockFetch({ status = 200, body }) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

test('request headers match App 1.0.5 measured values', () => {
  const h = buildHeaders('TOK', 'win32', 'x64');
  assert.equal(h.authorization, 'Bearer TOK');
  assert.equal(h['user-agent'], `qoderwork/${APP_VERSION}`);
  assert.equal(h['x-qwenwork-version'], '1.0.5');
  assert.equal(h['x-qwenwork-release-version'], '1.0.5-26090806');
  assert.equal(h['x-qwenwork-build'], '26090806');
  assert.equal(h['x-qwenwork-platform'], 'win32');
  assert.equal(h['x-qwenwork-arch'], 'x64');
  assert.equal(h['x-qwenwork-channel'], 'stable');
});

test('endpoint constants match the probe report', () => {
  assert.equal(ENDPOINTS.quotaUsage, '/api/v2/quota/usage');
  assert.equal(ENDPOINTS.userPlan, '/api/v2/user/plan');
  assert.equal(ENDPOINTS.userStatus, '/api/v3/user/status');
  assert.match(ENDPOINTS.accountContext, /include=user,plan,quota,page,data_sharing/);
});

test('apiGet 401 -> API_UNAUTHORIZED with actionable hint', async () => {
  await assert.rejects(
    () => apiGet(ENDPOINTS.quotaUsage, 'T', { fetchImpl: mockFetch({ status: 401, body: '{}' }) }),
    (e) => e.code === ErrorCode.API_UNAUTHORIZED && e.recovery.length > 0,
  );
});

test('apiGet 403 -> API_UNAUTHORIZED', async () => {
  await assert.rejects(
    () => apiGet('/api/v2/model/list', 'T', { fetchImpl: mockFetch({ status: 403, body: '{"code":"101","message":"Signature invalid"}' }) }),
    (e) => e.code === ErrorCode.API_UNAUTHORIZED,
  );
});

test('apiGet 500 -> API_ERROR retryable', async () => {
  await assert.rejects(
    () => apiGet('/x', 'T', { fetchImpl: mockFetch({ status: 500, body: 'oops' }) }),
    (e) => e.code === ErrorCode.API_ERROR && e.retryable === true,
  );
});

test('apiGet non-JSON -> API_ERROR', async () => {
  await assert.rejects(
    () => apiGet('/x', 'T', { fetchImpl: mockFetch({ body: 'not json' }) }),
    (e) => e.code === ErrorCode.API_ERROR,
  );
});

test('apiGet network failure -> API_ERROR retryable', async () => {
  await assert.rejects(
    () => apiGet('/x', 'T', { fetchImpl: async () => { throw new Error('ENOTFOUND'); } }),
    (e) => e.code === ErrorCode.API_ERROR && e.retryable === true,
  );
});

const REAL_CONTEXT = {
  code: 'ok',
  data: {
    user: { id: '00000000-0000-4000-8000-000000000001', name: 'Test User', username: 'testuser01', email: 'test@example.com', is_biz: false, is_verified: true, is_active: true },
    plan: { pid: 'subscription-cn-free', name: 'Free', user_type: 'personal', is_personal_version: true, is_subscribed: false, subscription_status: false, period: '', next_due_date: null, sessions: 10, storage: 1 },
    quota: { total: null, used: null, remaining: 2100, exceeded: false },
    page: { page_quota: 5, month_requests: 100000, month_traffic: '5GB' },
  },
};

test('extractAccountContext parses real account-context response', () => {
  const r = extractAccountContext(REAL_CONTEXT);
  assert.equal(r.user.name, 'Test User');
  assert.equal(r.plan.pid, 'subscription-cn-free');
  assert.equal(r.plan.name, 'Free');
  assert.equal(r.quota.remaining, 2100);
  assert.equal(r.quota.total, null);
  assert.equal(r.page.quota, 5);
  assert.equal(r.page.monthTraffic, '5GB');
});

test('usedPercentage is null when total is null (Free plan, not 0%)', () => {
  const r = extractAccountContext(REAL_CONTEXT);
  assert.equal(r.quota.usedPercentage, null);
});

test('usedPercentage derived when total present', () => {
  const r = extractAccountContext({ data: { quota: { remaining: 50, total: 100, used: 50 } } });
  assert.equal(r.quota.usedPercentage, 50);
});

test('extractQuotaUsage parses real quota/usage response', () => {
  const real = { user_id: 'u', user_type: 'personal_standard', total_usage_percentage: 0, is_highest_tier: false, is_quota_exceeded: false, is_plan_quota_prorated: false, user_quota: null, add_on_quota: null };
  const r = extractQuotaUsage(real);
  assert.equal(r.totalUsagePercentage, 0);
  assert.equal(r.isQuotaExceeded, false);
});

test('extractUserPlan parses real user/plan response', () => {
  const real = { user_type: 'personal_standard', plan_tier_name: 'Free', plan_tier: 'free', is_personal_version: true, organization: null };
  const r = extractUserPlan(real);
  assert.equal(r.planTierName, 'Free');
  assert.equal(r.planTier, 'free');
});

test('Go zero date 0001-01-01 normalizes to null', () => {
  const r = extractAccountContext({ data: { plan: { next_due_date: '0001-01-01T00:00:00Z' } } });
  assert.equal(r.plan.nextDueDate, null);
});

test('extractAccountContext tolerates a bare top-level object', () => {
  const r = extractAccountContext({ user: { name: 'A' }, plan: { pid: 'p' }, quota: { remaining: 1, total: 2 } });
  assert.equal(r.user.name, 'A');
  assert.equal(r.quota.remaining, 1);
});

test('fetchAccountInfo returns name/tier/planId/quota', async () => {
  const info = await fetchAccountInfo('T', { fetchImpl: mockFetch({ body: REAL_CONTEXT }) });
  assert.equal(info.name, 'Test User');
  assert.equal(info.tier, 'Free');
  assert.equal(info.planId, 'subscription-cn-free');
  assert.equal(info.quota.remaining, 2100);
});

test('fetchAccountOverview degrades to lightweight endpoints', async () => {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (url.includes('account-context')) return { ok: false, status: 500, text: async () => 'err' };
    if (url.includes('quota/usage')) return { ok: true, status: 200, text: async () => JSON.stringify({ total_usage_percentage: 5, is_quota_exceeded: false }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ plan_tier_name: 'Free', plan_tier: 'free' }) };
  };
  const r = await fetchAccountOverview('T', { fetchImpl: impl });
  assert.equal(r.degraded, true);
  assert.equal(r.plan.name, 'Free');
  assert.equal(r.quota.usedPercentage, 5);
  assert.ok(calls.length >= 3);
});

test('fetchAccountOverview throws original error when everything fails', async () => {
  await assert.rejects(
    () => fetchAccountOverview('T', { fetchImpl: mockFetch({ status: 500, body: 'down' }) }),
    (e) => e.code === ErrorCode.API_ERROR,
  );
});
