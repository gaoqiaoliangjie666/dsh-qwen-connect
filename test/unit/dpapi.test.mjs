import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stripDpapiPrefix, buildPowerShellScript, isSupportedPlatform, unprotectMasterKey } from '../../lib/dpapi.js';
import { ErrorCode } from '../../lib/errors.js';

test('stripDpapiPrefix removes the 5-byte DPAPI prefix', () => {
  const key = crypto.randomBytes(32);
  const blob = Buffer.concat([Buffer.from('DPAPI'), key]);
  assert.deepEqual(stripDpapiPrefix(blob), key);
});

test('stripDpapiPrefix keeps remaining byte length (real file is 283 bytes)', () => {
  const payload = crypto.randomBytes(278);
  const blob = Buffer.concat([Buffer.from('DPAPI'), payload]);
  assert.equal(blob.length, 283);
  assert.equal(stripDpapiPrefix(blob).length, 278);
});

test('missing DPAPI prefix -> CREDENTIALS_MALFORMED', () => {
  const blob = Buffer.concat([Buffer.from('XXXXX'), crypto.randomBytes(32)]);
  assert.throws(() => stripDpapiPrefix(blob), (e) => e.code === ErrorCode.CREDENTIALS_MALFORMED);
});

test('too-short blob -> CREDENTIALS_MALFORMED', () => {
  assert.throws(() => stripDpapiPrefix(Buffer.from('D')), (e) => e.code === ErrorCode.CREDENTIALS_MALFORMED);
  assert.throws(() => stripDpapiPrefix(null), (e) => e.code === ErrorCode.CREDENTIALS_MALFORMED);
});

test('PowerShell script includes the required Add-Type System.Security', () => {
  const s = buildPowerShellScript('AAAA');
  assert.match(s, /Add-Type -AssemblyName System\.Security/);
  assert.match(s, /ProtectedData\]::Unprotect/);
  assert.match(s, /'CurrentUser'/);
});

test('PowerShell script performs no file writes', () => {
  const s = buildPowerShellScript('AAAA');
  assert.ok(!/Out-File|Set-Content|Add-Content/.test(s));
});

test('isSupportedPlatform reflects win32', () => {
  assert.equal(isSupportedPlatform(), process.platform === 'win32');
});

test('unprotectMasterKey rejects empty/invalid encrypted_key', () => {
  assert.throws(() => unprotectMasterKey(''), (e) => e.code === ErrorCode.CREDENTIALS_MALFORMED);
  assert.throws(() => unprotectMasterKey(null), (e) => e.code === ErrorCode.CREDENTIALS_MALFORMED);
});

test('unprotectMasterKey on non-DPAPI blob -> CREDENTIALS_MALFORMED', () => {
  const bad = Buffer.from('NOTDPAPI' + 'x'.repeat(30)).toString('base64');
  assert.throws(() => unprotectMasterKey(bad), (e) => e.code === ErrorCode.CREDENTIALS_MALFORMED);
});

test('real DPAPI round trip (Windows only)', { skip: process.platform !== 'win32' ? 'Windows only' : false }, () => {
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!fs.existsSync(ps)) return;

  const key = crypto.randomBytes(32);
  const b64 = key.toString('base64');
  const p = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; ` +
    `$b=[Convert]::FromBase64String('${b64}'); ` +
    `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))`,
  ], { encoding: 'utf8' });
  if (p.status !== 0) return;

  const wrapped = Buffer.concat([Buffer.from('DPAPI'), Buffer.from(p.stdout.trim(), 'base64')]).toString('base64');
  assert.deepEqual(unprotectMasterKey(wrapped), key);
});
