import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  loadCredentials,
  probeCredentials,
  normalizeCredentials,
  isTokenExpired,
  describeCredentials,
  encryptV10,
  decryptV10,
  defaultAppDataDir,
  AUTH_V2_FILE,
  AUTH_V1_FILE,
  LOCAL_STATE_FILE,
} from '../../lib/credentials.js';
import { ErrorCode, QwenAuthError } from '../../lib/errors.js';

const KEY = crypto.randomBytes(32);

function makeFixtureDir({ authV2 = null, authV1 = null, encryptedKeyB64, omitLocalState = false, masterKey = KEY } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwencred-'));
  if (!omitLocalState) {
    const keyB64 = encryptedKeyB64 ?? Buffer.concat([Buffer.from('DPAPI'), KEY]).toString('base64');
    fs.writeFileSync(path.join(dir, LOCAL_STATE_FILE), JSON.stringify({ os_crypt: { encrypted_key: keyB64 } }));
  }
  if (authV2) fs.writeFileSync(path.join(dir, AUTH_V2_FILE), encryptV10(JSON.stringify(authV2), masterKey));
  if (authV1) fs.writeFileSync(path.join(dir, AUTH_V1_FILE), encryptV10(JSON.stringify(authV1), masterKey));
  return dir;
}

const V2 = {
  schemaVersion: 2,
  token: 'tok-'.padEnd(60, 'a'),
  refreshToken: 'rt-'.padEnd(40, 'b'),
  expiresAt: '2099-09-18T03:29:01Z',
  refreshTokenExpiresAt: '2099-09-11T04:28:59.905Z',
  user: { id: '11111111-2222-3333-4444-555555555555', name: 'Tester', username: 'tester', email: 't@example.invalid', tier: 'Free', planId: 'subscription-cn-free' },
  identityVersion: 0,
  loginMethod: 'browser',
  refreshStrategy: 'device_token',
  loginDeviceId: 'device-uuid-0001',
  loginTimestamp: 1700000000,
};

test('defaultAppDataDir points at APPDATA/QwenWorkCN', () => {
  const d = defaultAppDataDir({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' });
  assert.equal(d, path.join('C:\\Users\\x\\AppData\\Roaming', 'QwenWorkCN'));
});

test('normalizeCredentials parses auth-v2 shape', () => {
  const c = normalizeCredentials(V2, { source: 'auth-v2' });
  assert.equal(c.schemaVersion, 2);
  assert.equal(c.loginDeviceId, 'device-uuid-0001');
  assert.equal(c.refreshStrategy, 'device_token');
  assert.equal(c.user.tier, 'Free');
  assert.equal(c.user.planId, 'subscription-cn-free');
  assert.ok(c.expiresAt instanceof Date);
  assert.equal(c.expiresAt.toISOString(), '2099-09-18T03:29:01.000Z');
  assert.ok(c.refreshTokenExpiresAt instanceof Date);
});

test('normalizeCredentials parses legacy auth-v1 shape', () => {
  const c = normalizeCredentials({ token: 'legacy', refreshToken: 'r', expiresAt: '2099-01-01T00:00:00Z', user: { id: 'u', name: 'n', tier: 'Free' } });
  assert.equal(c.schemaVersion, 1);
  assert.equal(c.loginDeviceId, null);
  assert.equal(c.refreshStrategy, null);
  assert.equal(c.refreshTokenExpiresAt, null);
});

test('normalizeCredentials without token -> SCHEMA_INVALID', () => {
  assert.throws(() => normalizeCredentials({ user: {} }), (e) => e.code === ErrorCode.SCHEMA_INVALID);
});

test('normalizeCredentials keeps masterKey in memory for write-back', () => {
  const c = normalizeCredentials(V2, { masterKey: KEY });
  assert.deepEqual(c.masterKey, KEY);
});

test('isTokenExpired applies 60s skew', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(isTokenExpired({ expiresAt: new Date(now + 10_000) }, 60_000, now), true);
  assert.equal(isTokenExpired({ expiresAt: new Date(now + 120_000) }, 60_000, now), false);
  assert.equal(isTokenExpired({ expiresAt: null }, 60_000, now), false);
});

test('describeCredentials never leaks token plaintext', () => {
  const c = normalizeCredentials(V2, { source: 'auth-v2' });
  const d = describeCredentials(c);
  const s = JSON.stringify(d);
  assert.ok(!s.includes(V2.token));
  assert.ok(!s.includes(V2.refreshToken));
  assert.equal(d.hasToken, true);
  assert.equal(d.tokenLength, V2.token.length);
});

test('loadCredentials without Local State -> CREDENTIALS_MISSING', () => {
  const dir = makeFixtureDir({ authV2: V2, omitLocalState: true });
  assert.throws(() => loadCredentials({ appDataDir: dir }), (e) => {
    assert.ok(e instanceof QwenAuthError);
    assert.equal(e.code, ErrorCode.CREDENTIALS_MISSING);
    assert.match(e.recovery, /QwenWorkCN/);
    return true;
  });
});

test('Local State without encrypted_key -> CREDENTIALS_MALFORMED', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwencred-'));
  fs.writeFileSync(path.join(dir, LOCAL_STATE_FILE), JSON.stringify({ os_crypt: {} }));
  assert.throws(() => loadCredentials({ appDataDir: dir }), (e) => e.code === ErrorCode.CREDENTIALS_MALFORMED);
});

test('Local State not JSON -> CREDENTIALS_MALFORMED', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwencred-'));
  fs.writeFileSync(path.join(dir, LOCAL_STATE_FILE), 'not json');
  assert.throws(() => loadCredentials({ appDataDir: dir }), (e) => e.code === ErrorCode.CREDENTIALS_MALFORMED);
});

test('probeCredentials returns structured error instead of throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwencred-'));
  const r = probeCredentials({ appDataDir: dir });
  assert.equal(r.ok, false);
  assert.ok(r.error.code);
  assert.equal(typeof r.error.recovery, 'string');
});

test('probeCredentials never returns token on failure', () => {
  const dir = makeFixtureDir({ authV2: V2, encryptedKeyB64: 'not-a-real-key' });
  const r = probeCredentials({ appDataDir: dir });
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r).includes(V2.token));
});

test('decryptCredentialsFile round trips a fixture end to end', () => {
  const dir = makeFixtureDir({ authV2: V2 });
  const file = path.join(dir, AUTH_V2_FILE);
  const raw = JSON.parse(decryptV10(fs.readFileSync(file), KEY));
  assert.equal(raw.token, V2.token);
  assert.equal(raw.user.name, 'Tester');
});

test('legacy auth.dat can be decrypted and normalized', () => {
  const legacy = { token: 'legacy-token', refreshToken: 'legacy-rt', expiresAt: '2099-01-01T00:00:00Z', user: { id: 'u1', name: 'Legacy', tier: 'Free' } };
  const dir = makeFixtureDir({ authV1: legacy });
  const file = path.join(dir, AUTH_V1_FILE);
  const c = normalizeCredentials(JSON.parse(decryptV10(fs.readFileSync(file), KEY)), { source: 'auth-v1' });
  assert.equal(c.schemaVersion, 1);
  assert.equal(c.token, 'legacy-token');
});
