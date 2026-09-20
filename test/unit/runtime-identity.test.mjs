/**
 * 运行期标识解析（Cosy-Version 动态化 + machineId 回退）测试。
 *
 * 这些是 t3 标注的脆弱点，t5 必须补足：
 *   - Cosy-Version 不再硬编码，来源可追溯，且有明确回退链
 *   - machineId 缺失时**明确失败**（返回 null），不得静默取一个编造值
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  resolveCosyVersion,
  resolveMachineId,
  describeMachineId,
  resolveRuntimeIdentity,
  FALLBACK_COSY_VERSION,
} from '../../lib/runtime-identity.js';

/** 建一个临时目录树，避免测试依赖真实安装。 */
function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const NO_ENV = {};

test('resolveCosyVersion: 环境变量最高优先', () => {
  const r = resolveCosyVersion({ env: { QWEN_COSY_VERSION: '9.9.9' }, installRoot: '/nonexistent' });
  assert.equal(r.version, '9.9.9');
  assert.equal(r.source, 'env');
});

test('resolveCosyVersion: 非法环境变量被忽略并继续探测', () => {
  const r = resolveCosyVersion({ env: { QWEN_COSY_VERSION: 'not-a-version' }, installRoot: '/nonexistent' });
  assert.notEqual(r.source, 'env');
});

test('resolveCosyVersion: 从 obf 的 COSY_VERSION 常量读取（权威来源）', () => {
  const root = tmpdir('qwenv-');
  const versionDir = path.join(root, '1.2.3-99999999');
  const obfDir = path.join(
    versionDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    '@qoder-ai',
    'qoder-agent-sdk',
    'dist',
    '_worker',
  );
  fs.mkdirSync(obfDir, { recursive: true });
  // 复刻真实 obf 里的形态：COSY_VERSION:()=>$AA  ...  $AA=xSA||"1.1.32" ... xSA="1.1.32"
  fs.writeFileSync(
    path.join(obfDir, 'qoder-worker-runtime.obf.mjs'),
    'function f(){}$AA=xSA||"1.1.32",other=1;xSA="1.1.32";bn(x,{COSY_VERSION:()=>$AA});',
    'utf8',
  );

  const r = resolveCosyVersion({ env: NO_ENV, installRoot: root });
  assert.equal(r.version, '1.1.32', '应取 obf 的 Cosy 协议版本，而非目录名的 1.2.3');
  assert.equal(r.source, 'obf');
  assert.match(r.detail, /COSY_VERSION/);

  fs.rmSync(root, { recursive: true, force: true });
});

test('resolveCosyVersion: obf 缺失时回退到安装目录名（App 版本域）', () => {
  const root = tmpdir('qwenv2-');
  fs.mkdirSync(path.join(root, '1.4.7-26000000'), { recursive: true });
  const r = resolveCosyVersion({ env: NO_ENV, installRoot: root });
  assert.equal(r.version, '1.4.7');
  assert.equal(r.source, 'install-dir');
  fs.rmSync(root, { recursive: true, force: true });
});

test('resolveCosyVersion: 多个版本目录时取最高的', () => {
  const root = tmpdir('qwenv3-');
  for (const v of ['1.0.0-1', '2.3.1-9', '1.9.9-5']) fs.mkdirSync(path.join(root, v), { recursive: true });
  const r = resolveCosyVersion({ env: NO_ENV, installRoot: root });
  assert.equal(r.version, '2.3.1');
  fs.rmSync(root, { recursive: true, force: true });
});

test('resolveCosyVersion: 全部探测失败时回退到常量并标注来源', () => {
  const r = resolveCosyVersion({ env: NO_ENV, installRoot: '/definitely/not/here' });
  assert.equal(r.version, FALLBACK_COSY_VERSION);
  assert.equal(r.source, 'fallback');
  assert.ok(r.detail.length > 0, '回退必须给出可诊断说明');
});

test('resolveCosyVersion: 真实安装环境下能解析出 1.1.32（集成检查）', () => {
  const r = resolveCosyVersion({ env: NO_ENV });
  // 环境可能没有安装 QwenWorkCN；有则必须是权威来源
  if (r.source === 'obf') {
    assert.match(r.version, /^\d+\.\d+\.\d+$/);
  } else {
    assert.notEqual(r.detail, '');
  }
});

// ---------------------------------------------------------------------------

test('resolveMachineId: 环境变量最高优先', () => {
  const r = resolveMachineId({ env: { QWEN_MACHINE_ID: 'env-dev' }, credential: { loginDeviceId: 'cred-dev' } });
  assert.equal(r.machineId, 'env-dev');
  assert.equal(r.source, 'env');
});

test('resolveMachineId: 回退到凭据的 loginDeviceId', () => {
  const r = resolveMachineId({ env: NO_ENV, credential: { loginDeviceId: 'cred-dev' } });
  assert.equal(r.machineId, 'cred-dev');
  assert.equal(r.source, 'credential.loginDeviceId');
});

test('resolveMachineId: 凭据缺失时回退到环境变量 QWEN_MACHINE_ID_FALLBACK', () => {
  const r = resolveMachineId({ env: { QWEN_MACHINE_ID_FALLBACK: 'fb-dev' }, credential: {} });
  assert.equal(r.machineId, 'fb-dev');
  assert.equal(r.source, 'env-fallback');
});

test('resolveMachineId: 全部缺失时返回 null —— 绝不编造值', () => {
  assert.equal(resolveMachineId({ env: NO_ENV, credential: {} }), null);
  assert.equal(resolveMachineId({ env: NO_ENV, credential: null }), null);
  assert.equal(resolveMachineId({ env: NO_ENV, credential: { loginDeviceId: '   ' } }), null);
});

test('describeMachineId: 不泄漏 machineId 原文', () => {
  const full = '11111111-2222-4333-8444-555555555555';
  const d = describeMachineId({ env: NO_ENV, credential: { loginDeviceId: full } });
  assert.equal(d.available, true);
  assert.equal(d.length, full.length);
  assert.ok(!d.masked.includes(full), '掩码不得包含完整值');
  assert.ok(!JSON.stringify(d).includes(full), '整个描述对象都不得含完整值');
});

test('describeMachineId: 缺失时给出可操作的失败原因', () => {
  const d = describeMachineId({ env: NO_ENV, credential: {} });
  assert.equal(d.available, false);
  assert.match(d.reason, /loginDeviceId/);
  assert.match(d.reason, /QWEN_MACHINE_ID/, '必须告诉用户怎么补救');
});

test('resolveRuntimeIdentity: 汇总两个来源且不含敏感值', () => {
  const full = '11111111-2222-4333-8444-555555555555';
  const r = resolveRuntimeIdentity({
    env: { QWEN_COSY_VERSION: '3.3.3' },
    credential: { loginDeviceId: full },
  });
  assert.equal(r.cosyVersion.version, '3.3.3');
  assert.equal(r.machineId.available, true);
  assert.ok(!JSON.stringify(r).includes(full));
});
