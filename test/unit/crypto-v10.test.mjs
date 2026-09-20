import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { parseV10Payload, decryptV10, encryptV10 } from '../../lib/credentials.js';
import { QwenAuthError, ErrorCode } from '../../lib/errors.js';

const KEY = crypto.randomBytes(32);

test('encryptV10 -> decryptV10 round trip', () => {
  const plain = JSON.stringify({ hello: 'world', n: 42 });
  const blob = encryptV10(plain, KEY);
  assert.equal(decryptV10(blob, KEY), plain);
});

test('v10 payload layout matches Chromium', () => {
  const blob = encryptV10('{"a":1}', KEY);
  assert.equal(blob.subarray(0, 3).toString('ascii'), 'v10');
  const { nonce, ciphertext, tag } = parseV10Payload(blob);
  assert.equal(nonce.length, 12);
  assert.equal(tag.length, 16);
  assert.equal(3 + 12 + ciphertext.length + 16, blob.length);
});

test('nonce is random per call', () => {
  const a = encryptV10('same', KEY);
  const b = encryptV10('same', KEY);
  assert.notDeepEqual(a, b);
  assert.notDeepEqual(a.subarray(3, 15), b.subarray(3, 15));
});

test('wrong master key -> DECRYPT_FAILED', () => {
  const blob = encryptV10('{"secret":1}', KEY);
  const wrong = crypto.randomBytes(32);
  assert.throws(() => decryptV10(blob, wrong), (e) => {
    assert.ok(e instanceof QwenAuthError);
    assert.equal(e.code, ErrorCode.DECRYPT_FAILED);
    assert.ok(e.recovery.length > 0);
    return true;
  });
});

test('tampered ciphertext -> DECRYPT_FAILED', () => {
  const blob = encryptV10('{"tamper":1}', KEY);
  blob[20] ^= 0xff;
  assert.throws(() => decryptV10(blob, KEY), (e) => e.code === ErrorCode.DECRYPT_FAILED);
});

test('tampered auth tag -> DECRYPT_FAILED', () => {
  const blob = encryptV10('{"tag":1}', KEY);
  blob[blob.length - 1] ^= 0xff;
  assert.throws(() => decryptV10(blob, KEY), (e) => e.code === ErrorCode.DECRYPT_FAILED);
});

test('missing v10 prefix -> CREDENTIALS_MALFORMED', () => {
  const blob = encryptV10('{}', KEY);
  Buffer.from('v11').copy(blob, 0);
  assert.throws(() => decryptV10(blob, KEY), (e) => e.code === ErrorCode.CREDENTIALS_MALFORMED);
});

test('too-short payload -> CREDENTIALS_MALFORMED', () => {
  assert.throws(
    () => decryptV10(Buffer.from('v10short'), KEY),
    (e) => e.code === ErrorCode.CREDENTIALS_MALFORMED,
  );
});

test('master key must be 32 bytes', () => {
  const blob = encryptV10('{}', KEY);
  assert.throws(() => decryptV10(blob, crypto.randomBytes(16)), (e) => e.code === ErrorCode.DECRYPT_FAILED);
});

test('empty plaintext round trip', () => {
  const blob = encryptV10('', KEY);
  assert.equal(decryptV10(blob, KEY), '');
});

test('large plaintext (>1MB) round trip', () => {
  const plain = 'x'.repeat(1_200_000);
  assert.equal(decryptV10(encryptV10(plain, KEY), KEY).length, plain.length);
});

test('UTF-8 multibyte round trip', () => {
  const plain = JSON.stringify({ name: 'xiao-cao', tier: 'free' });
  assert.equal(decryptV10(encryptV10(plain, KEY), KEY), plain);
});
