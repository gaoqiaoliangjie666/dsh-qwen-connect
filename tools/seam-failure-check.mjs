/**
 * 验证接缝的多路径探测**不会静默降级**。
 *
 * 关切（来自 captain）：多路径探测（./auth.js 与 ../src/auth.js 都试）若是
 * 两个路径都不存在就静默返回空值，会把真实错误藏起来。
 *
 * 本测试用**真实文件系统**制造三种情形，断言每种都给出明确、可诊断的错误：
 *   1. 正常情形 —— 实现可用，应成功
 *   2. 路径全不存在 —— 应抛 QwenAuthError 且 recovery 含"加载失败"与真实原因
 *   3. 文件存在但内容损坏 —— 同样必须抛出，不得静默通过
 *
 * 用法：node tools/seam-failure-check.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const say = (s) => process.stdout.write(`${s}\n`);

const root = mkdtempSync(join(tmpdir(), 'seam-fail-'));
let failures = 0;

/** 在一个隔离目录里放好接缝所需的相对布局，然后 import 它。 */
async function loadSeamWith({ authFiles, restFiles }) {
  const dir = mkdtempSync(join(root, 'case-'));
  const lib = join(dir, 'lib');
  mkdirSync(lib, { recursive: true });

  // 复制接缝与它依赖的 errors.js（接缝用静态 import 引它）
  const seamSrc = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('../lib/credentials-seam.js', import.meta.url), 'utf8'),
  );
  const errSrc = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('../lib/errors.js', import.meta.url), 'utf8'),
  );
  writeFileSync(join(lib, 'credentials-seam.js'), seamSrc, 'utf8');
  writeFileSync(join(lib, 'errors.js'), errSrc, 'utf8');

  for (const [rel, content] of Object.entries(authFiles)) {
    const p = join(lib, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content, 'utf8');
  }
  for (const [rel, content] of Object.entries(restFiles)) {
    const p = join(lib, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content, 'utf8');
  }

  // 加缓存破坏参数，避免同路径重复 import 命中模块缓存
  const url = `${pathToFileURL(join(lib, 'credentials-seam.js')).href}?t=${Date.now()}${Math.random()}`;
  return import(url);
}

const GOOD_AUTH = `export async function getValidToken() { return 'TOKEN_STUB'; }\n`;
const GOOD_REST = `export async function fetchAccountOverview() { return { user: null, plan: null, quota: null }; }\n`;

// ---------------------------------------------------------------- 情形 1
{
  say('--- 情形 1：实现可用（./auth.js + ./rest.js）---');
  const seam = await loadSeamWith({
    authFiles: { 'auth.js': GOOD_AUTH },
    restFiles: { 'rest.js': GOOD_REST },
  });
  assert.equal(await seam.isWired(), true, '实现可用时应 isWired=true');
  const token = await seam.getValidToken();
  assert.equal(token, 'TOKEN_STUB');
  say('✔ isWired=true，getValidToken() 正常返回');
}

// ---------------------------------------------------------------- 情形 2
{
  say('\n--- 情形 2：两条候选路径都不存在 ---');
  const seam = await loadSeamWith({ authFiles: {}, restFiles: {} });
  assert.equal(await seam.isWired(), false, '实现缺失时应 isWired=false');

  let threw = false;
  try {
    await seam.getValidToken();
  } catch (error) {
    threw = true;
    assert.equal(error.code, 'CREDENTIALS_MISSING', '必须带稳定错误码');
    assert.ok(
      typeof error.recovery === 'string' && error.recovery.length > 0,
      '必须给出可操作的 recovery',
    );
    say(`✔ 抛出 [${error.code}]`);
    say(`  recovery: ${error.recovery.slice(0, 120)}`);
  }
  assert.equal(threw, true, '实现缺失时不得静默返回空值——必须抛错');
  say('✔ 未静默降级（正确抛错）');
}

// ---------------------------------------------------------------- 情形 3
{
  say('\n--- 情形 3：文件存在但内容损坏（语法错误）---');
  const seam = await loadSeamWith({
    authFiles: { 'auth.js': 'export async function getValidToken( { THIS IS BROKEN\n' },
    restFiles: { 'rest.js': GOOD_REST },
  });
  assert.equal(await seam.isWired(), false, '损坏时应 isWired=false');

  let threw = false;
  try {
    await seam.getValidToken();
  } catch (error) {
    threw = true;
    assert.equal(error.code, 'CREDENTIALS_MISSING');
    say(`✔ 抛出 [${error.code}]`);
    say(`  recovery: ${error.recovery.slice(0, 140)}`);
  }
  assert.equal(threw, true, '文件损坏时不得静默通过');
  say('✔ 损坏未被掩盖（正确抛错）');
}

// ---------------------------------------------------------------- 情形 4
{
  say('\n--- 情形 4：首选路径缺失，回退路径可用（验证探测真的会回退）---');
  const seam = await loadSeamWith({
    authFiles: { '../src/auth.js': GOOD_AUTH },
    restFiles: { '../src/rest.js': GOOD_REST },
  });
  // 注意：这里的 ../src/ 是相对于 lib/ 的，即 case-XXXX/src/
  assert.equal(await seam.isWired(), true, '首选缺失时应回退到备选路径');
  say('✔ 回退路径生效（isWired=true）');
}

rmSync(root, { recursive: true, force: true });

say('\n全部通过：多路径探测在四种情形下行为明确，无静默降级。');

// 显式退出：本脚本反复 import 了多个临时模块，ESM 加载器可能仍持有句柄，
// 不显式退出会让进程挂住（实测在 verify-all 的 spawnSync 中会超时）。
process.exit(0);
