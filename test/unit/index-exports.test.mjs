import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../../lib/auth-api.js';

test('contract functions are exported', () => {
  for (const name of [
    'loadCredentials', 'getValidToken', 'getAccountInfo', 'getQuota',
    'getSession', 'probeCredentials', 'describeCredentials',
    'QwenAuthError', 'isQwenAuthError',
    'fetchAccountInfo', 'fetchAccountOverview', 'requestTokenRefresh',
  ]) {
    assert.equal(typeof api[name], 'function', `missing export: ${name}`);
  }
});

test('constant objects are exported', () => {
  assert.equal(typeof api.ErrorCode, 'object');
  assert.equal(typeof api.ENDPOINTS, 'object');
  assert.equal(typeof api.REFRESH_PATH, 'string');
  assert.equal(typeof api.DEFAULT_BASE_URL, 'string');
});

test('ErrorCode covers every required category', () => {
  for (const c of [
    'CREDENTIALS_MISSING', 'DPAPI_FAILED', 'DECRYPT_FAILED',
    'TOKEN_EXPIRED_NO_REFRESH', 'SCHEMA_INVALID', 'CREDENTIALS_MALFORMED',
    'REFRESH_REJECTED', 'REFRESH_NETWORK', 'API_UNAUTHORIZED', 'API_ERROR',
    'UNSUPPORTED_PLATFORM',
  ]) {
    assert.ok(api.ErrorCode[c], `missing error code ${c}`);
  }
});

test('module imports without side effects', () => {
  assert.equal(typeof api.getSession, 'function');
});

test('probeCredentials returns structured result instead of throwing', () => {
  const r = api.probeCredentials({ appDataDir: 'C:\\definitely\\not\\here' });
  assert.equal(r.ok, false);
  assert.ok(r.error.code);
  assert.equal(typeof r.error.recovery, 'string');
});

test('QwenAuthError.toJSON exposes code and recovery', () => {
  const e = new api.QwenAuthError(api.ErrorCode.DECRYPT_FAILED, 'boom');
  const j = e.toJSON();
  assert.equal(j.code, 'DECRYPT_FAILED');
  assert.ok(j.recovery.length > 0);
  assert.equal(typeof j.retryable, 'boolean');
});
