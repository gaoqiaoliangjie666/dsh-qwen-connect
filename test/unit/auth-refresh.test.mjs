import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  buildRefreshBody,
  parseRefreshResponse,
  requestTokenRefresh,
  getValidToken,
  persistRefreshedCredentials,
  REFRESH_PATH,
} from '../../lib/auth.js';
import { encryptV10, decryptV10, normalizeCredentials, AUTH_V2_FILE, LOCAL_STATE_FILE } from '../../lib/credentials.js';
import { ErrorCode } from '../../lib/errors.js';

const KEY = crypto.randomBytes(32);

function makeDir(v2) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwenauth-'));
  fs.writeFileSync(path.join(dir, LOCAL_STATE_FILE), JSON.stringify({ os_crypt: { encrypted_key: 'x' } }));
  fs.writeFileSync(path.join(dir, AUTH_V2_FILE), encryptV10(JSON.stringify(v2), KEY));
  return dir;
}

function jwtLike(n) { return String(n).padEnd(555, 'A'); }

const V2 = {
  schemaVersion: 2,
  token: jwtLike(1),
  refreshToken: 'rt-old-'.padEnd(60, 'o'),
  expiresAt: '2000-01-01T00:00:00Z',
  user: { id: 'u1', name: 'Tester', tier: 'Free', planId: 'subscription-cn-free' },
  loginDeviceId: 'dev-1',
  refreshStrategy: 'device_token',
};

function mockFetch({ status = 200, body, capture }) {
  return async (url, init) => {
    if (capture) { capture.url = url; capture.init = init; capture.body = JSON.parse(init.body); }
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
}

const OK_BODY = {
  device_token: jwtLike(2),
  refresh_token: 'rt-new-'.padEnd(60, 'n'),
  token_type: 'bearer',
  expires_at: '2099-09-18T06:12:11Z',
  expires_in: 604800,
  created_at: '2099-09-11T06:12:11Z',
};

test('buildRefreshBody uses snake_case refresh_token only (measured contract)', () => {
  const b = buildRefreshBody('RT');
  assert.deepEqual(Object.keys(b), ['refresh_token']);
  assert.equal(b.refresh_token, 'RT');
});

test('REFRESH_PATH matches measured endpoint', () => {
  assert.equal(REFRESH_PATH, '/api/v1/deviceToken/refresh');
});

test('request body is {refresh_token} and excludes loginDeviceId/device_id', async () => {
  const cap = {};
  await requestTokenRefresh('RT-XYZ', { fetchImpl: mockFetch({ body: OK_BODY, capture: cap }) });
  assert.deepEqual(cap.body, { refresh_token: 'RT-XYZ' });
  assert.ok(!('loginDeviceId' in cap.body));
  assert.ok(!('device_id' in cap.body));
  assert.equal(cap.init.method, 'POST');
  assert.ok(cap.url.endsWith(REFRESH_PATH));
});

test('parseRefreshResponse parses snake_case response', () => {
  const r = parseRefreshResponse(OK_BODY);
  assert.equal(r.token, OK_BODY.device_token);
  assert.equal(r.refreshToken, OK_BODY.refresh_token);
  assert.equal(r.expiresAt.toISOString(), '2099-09-18T06:12:11.000Z');
  assert.equal(r.expiresIn, 604800);
});

test('parseRefreshResponse also accepts camelCase fallbacks', () => {
  const r = parseRefreshResponse({ deviceToken: 'T', refreshToken: 'R', expiresAt: '2099-01-01T00:00:00Z' });
  assert.equal(r.token, 'T');
  assert.equal(r.refreshToken, 'R');
});

test('response without device_token -> REFRESH_REJECTED', () => {
  assert.throws(() => parseRefreshResponse({ refresh_token: 'x' }), (e) => e.code === ErrorCode.REFRESH_REJECTED);
});

test('HTTP 401 -> REFRESH_REJECTED not retryable', async () => {
  await assert.rejects(
    () => requestTokenRefresh('RT', { fetchImpl: mockFetch({ status: 401, body: '{"errorCode":"X"}' }) }),
    (e) => {
      assert.equal(e.code, ErrorCode.REFRESH_REJECTED);
      assert.equal(e.retryable, false);
      return true;
    },
  );
});

test('HTTP 400 INVALID_REFRESH_REQUEST -> REFRESH_REJECTED', async () => {
  const errBody = { errorCode: 'INVALID_REFRESH_REQUEST', errorMessage: 'refresh request is invalid', details: { field: 'loginDeviceId', reason: 'not_allowed' } };
  await assert.rejects(
    () => requestTokenRefresh('RT', { fetchImpl: mockFetch({ status: 400, body: errBody }) }),
    (e) => e.code === ErrorCode.REFRESH_REJECTED && e.message.includes('INVALID_REFRESH_REQUEST'),
  );
});

test('HTTP 500 -> REFRESH_NETWORK retryable', async () => {
  await assert.rejects(
    () => requestTokenRefresh('RT', { fetchImpl: mockFetch({ status: 500, body: 'boom' }) }),
    (e) => e.code === ErrorCode.REFRESH_NETWORK && e.retryable === true,
  );
});

test('network error -> REFRESH_NETWORK retryable', async () => {
  await assert.rejects(
    () => requestTokenRefresh('RT', { fetchImpl: async () => { throw new Error('ECONNRESET'); } }),
    (e) => e.code === ErrorCode.REFRESH_NETWORK && e.retryable === true,
  );
});

test('empty refreshToken -> REFRESH_REJECTED with actionable hint', async () => {
  await assert.rejects(
    () => requestTokenRefresh('', {}),
    (e) => e.code === ErrorCode.REFRESH_REJECTED && /QwenWorkCN/.test(e.recovery),
  );
});

test('non-expired token does not trigger a refresh request', async () => {
  let called = false;
  const creds = normalizeCredentials({ ...V2, expiresAt: '2099-01-01T00:00:00Z' }, { sourceFile: null });
  const r = await getValidToken({ credentials: creds, fetchImpl: async () => { called = true; } });
  assert.equal(r.refreshed, false);
  assert.equal(r.token, V2.token);
  assert.equal(called, false);
});

test('expired token refreshes automatically', async () => {
  const creds = normalizeCredentials(V2, { sourceFile: null });
  const r = await getValidToken({ credentials: creds, fetchImpl: mockFetch({ body: OK_BODY }) });
  assert.equal(r.refreshed, true);
  assert.equal(r.token, OK_BODY.device_token);
  assert.equal(r.credentials.refreshToken, OK_BODY.refresh_token);
});

test('forceRefresh refreshes even when not expired', async () => {
  const creds = normalizeCredentials({ ...V2, expiresAt: '2099-01-01T00:00:00Z' }, { sourceFile: null });
  const r = await getValidToken({ credentials: creds, forceRefresh: true, fetchImpl: mockFetch({ body: OK_BODY }) });
  assert.equal(r.refreshed, true);
});

test('expired without refreshToken -> TOKEN_EXPIRED_NO_REFRESH', async () => {
  const creds = normalizeCredentials({ ...V2, refreshToken: undefined }, { sourceFile: null });
  await assert.rejects(
    () => getValidToken({ credentials: creds, fetchImpl: async () => { throw new Error('should not call'); } }),
    (e) => e.code === ErrorCode.TOKEN_EXPIRED_NO_REFRESH && /reopen|QwenWorkCN/i.test(e.recovery + e.message),
  );
});

test('persistRefreshedCredentials rotates refresh token and preserves other fields', () => {
  const dir = makeDir(V2);
  const file = path.join(dir, AUTH_V2_FILE);
  const creds = normalizeCredentials(V2, { sourceFile: file, source: 'auth-v2' });
  const res = persistRefreshedCredentials(creds, KEY, {
    token: jwtLike(2),
    refreshToken: 'rt-new-'.padEnd(60, 'n'),
    expiresAt: new Date('2099-09-18T06:12:11Z'),
  });
  assert.equal(res.written, true);

  const after = JSON.parse(decryptV10(fs.readFileSync(file), KEY));
  assert.equal(after.token, jwtLike(2));
  assert.equal(after.refreshToken, 'rt-new-'.padEnd(60, 'n'));
  assert.equal(after.expiresAt, '2099-09-18T06:12:11.000Z');
  assert.equal(after.user.name, 'Tester');
  assert.equal(after.loginDeviceId, 'dev-1');
  assert.equal(after.refreshStrategy, 'device_token');
  assert.equal(after.schemaVersion, 2);
});

test('write-back stays v10 encrypted (no plaintext on disk)', () => {
  const dir = makeDir(V2);
  const file = path.join(dir, AUTH_V2_FILE);
  const creds = normalizeCredentials(V2, { sourceFile: file });
  persistRefreshedCredentials(creds, KEY, { token: 'BRAND-NEW-TOKEN', refreshToken: null, expiresAt: null });
  const raw = fs.readFileSync(file);
  assert.equal(raw.subarray(0, 3).toString('ascii'), 'v10');
  assert.ok(!raw.toString('latin1').includes('BRAND-NEW-TOKEN'));
});

test('write-back leaves no temp files', () => {
  const dir = makeDir(V2);
  const file = path.join(dir, AUTH_V2_FILE);
  const creds = normalizeCredentials(V2, { sourceFile: file });
  persistRefreshedCredentials(creds, KEY, { token: 'T2', refreshToken: null, expiresAt: null });
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('tmp'));
  assert.deepEqual(leftovers, []);
});

test('dryRun does not write to disk', () => {
  const dir = makeDir(V2);
  const file = path.join(dir, AUTH_V2_FILE);
  const before = fs.readFileSync(file);
  const creds = normalizeCredentials(V2, { sourceFile: file });
  const res = persistRefreshedCredentials(creds, KEY, { token: 'T3', refreshToken: null, expiresAt: null }, { dryRun: true });
  assert.equal(res.written, false);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('invalid master key is reported explicitly instead of silently failing', () => {
  const dir = makeDir(V2);
  const file = path.join(dir, AUTH_V2_FILE);
  const creds = normalizeCredentials(V2, { sourceFile: file });
  const res = persistRefreshedCredentials(creds, Buffer.alloc(0), { token: 'T', refreshToken: null, expiresAt: null });
  assert.equal(res.written, false);
  assert.match(res.reason, /invalid-master-key/);
});

test('getValidToken without sourceFile skips write-back', async () => {
  const creds = normalizeCredentials(V2, { sourceFile: null });
  const r = await getValidToken({ credentials: creds, fetchImpl: mockFetch({ body: OK_BODY }) });
  assert.equal(r.refreshed, true);
  assert.equal(r.warning, undefined);
});

test('write-back failure yields a warning but does not block the call', async () => {
  const creds = normalizeCredentials(V2, { sourceFile: path.join(os.tmpdir(), 'definitely-missing-dir', 'auth-v2.dat') });
  const r = await getValidToken({ credentials: creds, fetchImpl: mockFetch({ body: OK_BODY }) });
  assert.equal(r.token, OK_BODY.device_token);
  assert.ok(typeof r.warning === 'string' && r.warning.length > 0);
});

test('error objects never contain token plaintext', async () => {
  const secret = jwtLike(9);
  const creds = normalizeCredentials({ ...V2, token: secret }, { sourceFile: null });
  try {
    await getValidToken({ credentials: creds, fetchImpl: mockFetch({ status: 401, body: '{"errorCode":"E"}' }) });
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(!JSON.stringify(e, Object.getOwnPropertyNames(e)).includes(secret));
  }
});
