/**
 * 状态路由的单元测试：重点验证**安全边界**（验收项中的 high 级要求）。
 *
 * 用 node:test 直接跑：
 *   node --test test/web-status.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';

/**
 * 用底层 http.request 发请求。
 *
 * 不能用 fetch：Host 是 fetch 的「禁止修改 header」，手工传入会被静默丢弃，
 * 于是永远测不到 Host 校验这一层。
 */
function rawRequest(port, { method = 'GET', path = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

import {
  qwenWorkStatusHandler,
  qwenWorkWebStatus,
  registerQwenWorkStatusRoute,
  safeMessage,
} from '../lib/web-status.js';
import { QWENWORK_STATUS_PATH } from '../lib/status-paths.js';
import { hostIsLoopback, originIsLoopback } from '../lib/loopback.js';

/** 路由挂载测试用的最小依赖集。 */
function makeDeps() {
  return {
    getAccountContext: async () => ({ user: {} }),
    tokenAvailable: async () => true,
    models: () => [],
    provider: 'qwenwork',
  };
}

/** 挂一个只跑该 handler 的裸 server，把 base URL 与 port 一并交给用例。 */
async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn({ base: `http://127.0.0.1:${port}`, port });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// ---------------------------------------------------------------- 脱敏

test('safeMessage 脱敏 JWT 形态', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefg';
  const out = safeMessage(new Error(`upstream rejected ${jwt}`));
  assert.ok(!out.includes(jwt), 'JWT 原文不得出现');
  assert.ok(out.includes('[redacted token]'));
});

test('safeMessage 脱敏 Bearer 与 key=value', () => {
  const out = safeMessage('Bearer sk-abc123.DEF_ghi code=xyz789&refresh_token=qwerty');
  assert.ok(!out.includes('sk-abc123.DEF_ghi'));
  assert.ok(!out.includes('xyz789'));
  assert.ok(!out.includes('qwerty'));
});

test('safeMessage 截断超长文本', () => {
  const out = safeMessage('x'.repeat(2000));
  assert.ok(out.length <= 500);
});

// ---------------------------------------------------------------- 环回判定

test('hostIsLoopback 接受环回、拒绝外部域名', () => {
  assert.equal(hostIsLoopback('127.0.0.1:63245'), true);
  assert.equal(hostIsLoopback('localhost'), true);
  assert.equal(hostIsLoopback('[::1]:1234'), true);
  assert.equal(hostIsLoopback('evil.example.com'), false, 'DNS-rebinding 必须被拒');
  assert.equal(hostIsLoopback(undefined), false);
});

test('originIsLoopback：无 Origin 放行，外部 Origin 拒绝', () => {
  assert.equal(originIsLoopback(undefined), true);
  assert.equal(originIsLoopback('http://127.0.0.1:63245'), true);
  assert.equal(originIsLoopback('https://evil.example.com'), false);
});

// ---------------------------------------------------------------- 路由

test('非环回 Host 的请求被 403 拒绝', async () => {
  const handler = qwenWorkStatusHandler({
    getAccountContext: async () => ({ user: { nickname: 'tester' }, quota: { remaining: 2100 } }),
    tokenAvailable: async () => true,
    models: () => [],
    provider: 'qwenwork',
  });
  await withServer(handler, async ({ port }) => {
    // 模拟 DNS-rebinding：连的是 127.0.0.1，但 Host 头是攻击者域名
    const res = await rawRequest(port, { headers: { host: 'evil.example.com' } });
    assert.equal(res.status, 403, '外部 Host 必须被拒');
    assert.equal(JSON.parse(res.text).error, 'request-not-trusted');

    // 对照组：环回 Host 应当放行
    const ok = await rawRequest(port, { headers: { host: '127.0.0.1' } });
    assert.equal(ok.status, 200, '环回 Host 必须放行');
  });
});

test('非环回 Origin 的浏览器请求被 403 拒绝', async () => {
  const handler = qwenWorkStatusHandler({
    getAccountContext: async () => ({ user: { nickname: 'tester' } }),
    tokenAvailable: async () => true,
    models: () => [],
    provider: 'qwenwork',
  });
  await withServer(handler, async ({ port }) => {
    const res = await rawRequest(port, {
      headers: { host: '127.0.0.1', origin: 'https://evil.example.com' },
    });
    assert.equal(res.status, 403, '外部 Origin 必须被拒');
  });
});

test('非 GET 方法被 405 拒绝', async () => {
  const handler = qwenWorkStatusHandler({
    getAccountContext: async () => ({}),
    tokenAvailable: async () => true,
    models: () => [],
    provider: 'qwenwork',
  });
  await withServer(handler, async ({ port }) => {
    const res = await rawRequest(port, { method: 'POST' });
    assert.equal(res.status, 405);
  });
});

test('正常请求返回 200 且含真实积分', async () => {
  const handler = qwenWorkStatusHandler({
    getAccountContext: async () => ({
      user: { nickname: '测试账号' },
      plan: { tierName: '个人版', tier: 'personal', isPersonal: true },
      quota: { remaining: 2100, used: 300 },
    }),
    tokenAvailable: async () => true,
    models: () => [{ id: 'flash', name: '标准｜Qwen3.8-Flash', rate: 0.1 }],
    provider: 'qwenwork',
  });
  await withServer(handler, async ({ port }) => {
    const res = await rawRequest(port, { headers: { host: '127.0.0.1' } });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.text);
    assert.equal(body.status, 'signed-in');
    assert.equal(body.remaining, 2100);
    assert.equal(body.nickname, '测试账号');
    assert.equal(body.tierName, '个人版');
    assert.equal(body.provider, 'qwenwork');
    assert.ok(Array.isArray(body.models));
  });
});

test('凭据错误降级为 signed-out 且不下发 token', async () => {
  const secretJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature';
  const handler = qwenWorkStatusHandler({
    getAccountContext: async () => {
      const err = new Error(`解密失败，token=${secretJwt}`);
      err.code = 'DECRYPT_FAILED';
      err.recovery = '请重新登录千问办公桌面应用。';
      throw err;
    },
    tokenAvailable: async () => false,
    models: () => [],
    provider: 'qwenwork',
  });
  await withServer(handler, async ({ port }) => {
    const res = await rawRequest(port, { headers: { host: '127.0.0.1' } });
    assert.equal(res.status, 200, '卡片仍应可渲染，而不是 500');
    const text = res.text;
    assert.ok(!text.includes(secretJwt), '响应体绝不得包含 JWT 原文');
    const body = JSON.parse(text);
    assert.equal(body.status, 'signed-out');
    assert.equal(body.error.code, 'DECRYPT_FAILED');
    assert.ok(body.error.recovery.includes('重新登录'));
    assert.ok(!('remaining' in body), '登录失败时不得出现任何积分字段');
    assert.ok(!('token' in body) && !('accessToken' in body));
  });
});

// ---------------------------------------------------------------- 组装

test('null 额度字段不得被 Number(null) 变成 0（防编造数值）', async () => {
  // 回归测试：t1 在字段缺失时返回 null。若直接 Number(null) 会得到 0，
  // 卡片就会显示「已用 0 / 总额 0」这种上游从未给出的数字。
  const status = await qwenWorkWebStatus({
    getAccountContext: async () => ({
      user: { name: 'Test User', username: 'testuser01' },
      plan: { name: 'Free', pid: 'subscription-cn-free', isPersonalVersion: true },
      quota: { remaining: 2100, total: null, used: null, unit: 'credits' },
    }),
    tokenAvailable: async () => true,
    models: () => [],
    provider: 'qwenwork',
  });
  assert.equal(status.status, 'signed-in');
  assert.equal(status.remaining, 2100, '真实值必须保留');
  assert.equal(status.used, undefined, 'null 必须保持缺失，不能变成 0');
  assert.equal(status.total, undefined, 'null 必须保持缺失，不能变成 0');
});

test('qwenWorkWebStatus 在 t1 未接入时抛错而非编造数值', async () => {
  // 直接验证桩行为：接缝抛错时，状态必须是 signed-out 且无 remaining
  const status = await qwenWorkWebStatus({
    getAccountContext: async () => {
      const err = new Error('尚未接入');
      err.code = 'CREDENTIALS_MISSING';
      throw err;
    },
    tokenAvailable: async () => false,
    models: () => [{ id: 'flash', name: '标准' }],
    provider: 'qwenwork',
  });
  assert.equal(status.status, 'signed-out');
  assert.equal(status.remaining, undefined);
  assert.equal(status.tierName, undefined);
  // 模型目录是静态内置的，即使登录失败也应可见
  assert.equal(status.models.length, 1);
});

// ---------------------------------------------------------------- entitlements

test('entitlements：只产出「积分」一项（套餐权益上限已移除）', async () => {
  const status = await qwenWorkWebStatus({
    getAccountContext: async () => ({
      user: { name: 'Test User', username: 'testuser01' },
      // 这些字段上游仍会返回，但**卡片不应再展示**——它们是套餐权益上限，
      // 对日常使用无参考价值，且会淹没真正关心的积分余额。
      plan: { name: 'Free', sessions: 10, storage: 1 },
      quota: { remaining: 2100, total: null, used: null, unit: 'credits' },
      page: { quota: 5, monthRequests: 100000, monthTraffic: '5GB' },
    }),
    tokenAvailable: async () => true,
    models: () => [],
    provider: 'qwenwork',
  });

  assert.deepEqual(
    status.entitlements.map((e) => e.key),
    ['credits'],
    '只应有积分一项——会话数/存储/页面额度/月度请求/月度流量都必须移除',
  );
  const credits = status.entitlements[0];
  assert.equal(credits.remain, 2100);
  assert.equal(credits.size, undefined, 'total 为 null 时不得推断总量');
});

test('entitlements：上游不给 total 时给出「参考基准」供水位条', async () => {
  const status = await qwenWorkWebStatus({
    getAccountContext: async () => ({
      user: { name: 'Test User' },
      plan: {},
      quota: { remaining: 1800, total: null },
    }),
    tokenAvailable: async () => true,
    models: () => [],
    provider: 'qwenwork',
  });
  assert.equal(
    typeof status.creditBaseline,
    'number',
    '无 total 时必须给出基准，否则卡片画不出水位条',
  );
  assert.ok(status.creditBaseline >= 1800, '基准不应小于当前余额');
});

test('entitlements：有真实 total 时不使用参考基准（避免双分母）', async () => {
  const status = await qwenWorkWebStatus({
    getAccountContext: async () => ({
      user: { name: 'Test User' },
      plan: {},
      quota: { remaining: 500, total: 1000 },
    }),
    tokenAvailable: async () => true,
    models: () => [],
    provider: 'qwenwork',
  });
  assert.equal(
    status.creditBaseline,
    undefined,
    '已有真实 total 时不该再给基准——否则两套分母并存容易混淆',
  );
});

test('entitlements：字段缺失时不产生条目（不编造）', async () => {
  const status = await qwenWorkWebStatus({
    getAccountContext: async () => ({
      user: { name: 'Test User' },
      plan: {},
      quota: { remaining: 100 },
    }),
    tokenAvailable: async () => true,
    models: () => [],
    provider: 'qwenwork',
  });
  const keys = status.entitlements.map((e) => e.key);
  assert.deepEqual(keys, ['credits'], '只有真实存在的字段才出条目');
});

test('entitlements：total 存在时积分条目带 size（可画进度条）', async () => {
  const status = await qwenWorkWebStatus({
    getAccountContext: async () => ({
      user: { name: 'Test User' },
      plan: {},
      quota: { remaining: 500, total: 1000, unit: 'credits' },
    }),
    tokenAvailable: async () => true,
    models: () => [],
    provider: 'qwenwork',
  });
  const credits = status.entitlements.find((e) => e.key === 'credits');
  assert.equal(credits.remain, 500);
  assert.equal(credits.size, 1000, '有 total 时必须带上，卡片才能画进度条');
});

test('entitlements：登录失败时不产生任何条目', async () => {
  const status = await qwenWorkWebStatus({
    getAccountContext: async () => {
      const err = new Error('no credentials');
      err.code = 'CREDENTIALS_MISSING';
      throw err;
    },
    tokenAvailable: async () => false,
    models: () => [],
    provider: 'qwenwork',
  });
  assert.equal(status.status, 'signed-out');
  assert.equal(status.entitlements, undefined);
});

// ---------------------------------------------------------------- 路由挂载的健壮性

test('registerQwenWorkStatusRoute：有 effect 时经 effect 注册（可随插件卸载）', () => {
  let effectUsed = false;
  let mounted = null;
  registerQwenWorkStatusRoute(
    {
      effect(fn) {
        effectUsed = true;
        return fn();
      },
      webServer: {
        register(route) {
          mounted = route;
          return () => {};
        },
      },
    },
    makeDeps(),
  );
  assert.equal(effectUsed, true, '应优先经 effect 注册');
  assert.equal(mounted?.path, QWENWORK_STATUS_PATH);
});

test('registerQwenWorkStatusRoute：无 effect 时降级为直接挂载（路由仍可用）', () => {
  let mounted = null;
  registerQwenWorkStatusRoute(
    {
      // 没有 effect —— 版本差异或精简环境
      webServer: {
        register(route) {
          mounted = route;
          return () => {};
        },
      },
    },
    makeDeps(),
  );
  assert.equal(mounted?.path, QWENWORK_STATUS_PATH, '降级路径也必须挂上路由——设置卡片依赖它');
});

test('registerQwenWorkStatusRoute：连 webServer 都没有时不抛异常', () => {
  assert.doesNotThrow(() => {
    registerQwenWorkStatusRoute({}, makeDeps());
  }, 'host provider 不能因卡片路由不可用而失败');
});
