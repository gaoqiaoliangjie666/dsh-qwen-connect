/**
 * 把 dsh-qwen-connect 一键注入到本机 DSH。
 *
 * 完成的接线（与 DSH 插件安装规范一致）：
 *   1. 在 DSH profile 的 node_modules 下建立指向插件源码的 Junction
 *   2. 在 profile 的 package.json 登记三处：
 *        - dependencies[name]      = "file:./node_modules/<name>"
 *        - dsh.profile.bundles[]   += name
 *        - pnpm.overrides[name]    = "link:./node_modules/<name>"
 *   3. 在插件源码的父目录建立依赖桥（@deepseek-ai / @earendil-works → profiles/node_modules）
 *
 * 安全设计：
 *   - 改 profile package.json 前先备份
 *   - 幂等：重复执行不会重复写入
 *   - 不修改 profile 的 cordis.patch.yml（否则会 duplicate loader entry id）
 *   - --dry-run 只打印将要做的改动
 *
 * 用法：
 *   node install-to-dsh.mjs                          # 用脚本所在包作为源
 *   node install-to-dsh.mjs --source <插件目录>       # 指定源
 *   node install-to-dsh.mjs --profile <profile 目录> # 指定 DSH profile
 *   node install-to-dsh.mjs --dry-run                # 预览
 *   node install-to-dsh.mjs --uninstall              # 卸载（移除接线）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { detectProfiles, pickDefaultTarget, describeTarget } from './detect-dsh.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { source: null, profile: null, bridgeDir: null, dryRun: false, uninstall: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source') opts.source = argv[++i];
    else if (a === '--profile') opts.profile = argv[++i];
    else if (a === '--bridge-dir') opts.bridgeDir = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--uninstall') opts.uninstall = true;
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
      process.exit(0);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// 探测
// ---------------------------------------------------------------------------

/** 默认 profile 目录：%APPDATA%\dsh-desktop\harness\profiles\web */
function defaultProfileDir() {
  const roaming = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(roaming, 'dsh-desktop', 'harness', 'profiles', 'web');
}

/** DSH 的共享 node_modules（peer 依赖所在处）。 */
function sharedNodeModules(profileDir) {
  return path.join(profileDir, '..', 'node_modules');
}

/** 解析插件源码目录：优先 --source，其次脚本上级目录。 */
function resolveSource(given) {
  const candidate = given ? path.resolve(given) : path.resolve(HERE, '..');
  const manifestPath = path.join(candidate, 'package.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`源目录中没有 package.json：${candidate}`);
  }
  return candidate;
}

/**
 * 解析 JSON 文本，容忍 UTF-8 BOM。
 *
 * ⚠️ 为什么必须容忍：用户机器上的 profile package.json 常由各类编辑器改写，
 * 不少 Windows 工具（含 PowerShell 5 的 `Set-Content -Encoding utf8`）默认
 * 写入 BOM。`JSON.parse` 遇到 BOM 会抛
 * `Unexpected token '﻿'` —— 用户看到的是一头雾水的符号而非可操作信息。
 * Node 自身的 `require()` 一直容忍 BOM，这里对齐该行为。
 *
 * @param {string} text
 * @returns {any}
 */
function parseJsonTolerant(text) {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

/** 读取并校验插件 manifest。 */
function readManifest(sourceDir) {
  const manifest = parseJsonTolerant(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf8'));
  if (typeof manifest.name !== 'string' || manifest.name === '') throw new Error('package.json 缺少 name');
  if (manifest.dsh?.bundle?.patch === undefined) {
    throw new Error('package.json 缺少 dsh.bundle.patch —— 这不是一个 DSH 插件包');
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// Junction / symlink
// ---------------------------------------------------------------------------

function isJunction(target) {
  try {
    const st = fs.lstatSync(target);
    return st.isSymbolicLink();
  } catch {
    return false;
  }
}

/** 读取链接指向（Junction 或 symlink）。 */
function readLinkTarget(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/** 创建目录 Junction（Windows）或 symlink（其他平台）。 */
function createLink(linkPath, targetPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  if (process.platform === 'win32') {
    execFileSync('cmd', ['/c', 'mklink', '/J', linkPath, targetPath], { stdio: 'pipe' });
  } else {
    fs.symlinkSync(targetPath, linkPath, 'dir');
  }
}

/** 移除 Junction / symlink（只删链接本身，不动目标）。 */
function removeLink(linkPath) {
  if (!fs.existsSync(linkPath) && !isJunction(linkPath)) return;
  if (process.platform === 'win32') {
    // rmdir 对 Junction 只删除链接，不递归目标内容
    execFileSync('cmd', ['/c', 'rmdir', linkPath], { stdio: 'pipe' });
  } else {
    fs.unlinkSync(linkPath);
  }
}

// ---------------------------------------------------------------------------
// profile package.json 三处登记
// ---------------------------------------------------------------------------

const BACKUP_SUFFIX = (stamp) => `.backup-qwen-connect-${stamp}`;

function editProfilePackage(profileDir, pluginName, dryRun) {
  const pkgPath = path.join(profileDir, 'package.json');
  if (!fs.existsSync(pkgPath)) throw new Error(`找不到 profile package.json：${pkgPath}`);

  const raw = fs.readFileSync(pkgPath, 'utf8');
  const pkg = parseJsonTolerant(raw);
  const changes = [];

  const fileSpec = `file:./node_modules/${pluginName}`;
  const linkSpec = `link:./node_modules/${pluginName}`;

  // ① dependencies
  pkg.dependencies ??= {};
  if (pkg.dependencies[pluginName] !== fileSpec) {
    changes.push(`dependencies["${pluginName}"] = "${fileSpec}"`);
    pkg.dependencies[pluginName] = fileSpec;
  }

  // ② dsh.profile.bundles
  pkg.dsh ??= {};
  pkg.dsh.profile ??= {};
  pkg.dsh.profile.bundles ??= [];
  if (!pkg.dsh.profile.bundles.includes(pluginName)) {
    changes.push(`dsh.profile.bundles += "${pluginName}"`);
    pkg.dsh.profile.bundles.push(pluginName);
  }

  // ③ pnpm.overrides
  pkg.pnpm ??= {};
  pkg.pnpm.overrides ??= {};
  if (pkg.pnpm.overrides[pluginName] !== linkSpec) {
    changes.push(`pnpm.overrides["${pluginName}"] = "${linkSpec}"`);
    pkg.pnpm.overrides[pluginName] = linkSpec;
  }

  if (changes.length === 0) {
    console.log('  profile package.json：已是最新，无需改动');
    return { changed: false, changes: [] };
  }

  console.log('  profile package.json 需要以下改动：');
  for (const c of changes) console.log(`    · ${c}`);

  if (dryRun) return { changed: true, changes, dryRun: true };

  // 备份（带时间戳，不覆盖历史备份）
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const backupPath = pkgPath + BACKUP_SUFFIX(stamp);
  if (!fs.existsSync(backupPath)) fs.copyFileSync(pkgPath, backupPath);
  console.log(`    （已备份原文件 → ${path.basename(backupPath)}）`);

  // 保留原有缩进风格：探测 2 或 4 空格
  const indent = /^\s{4}"/m.test(raw) ? 4 : 2;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, indent)}\n`, 'utf8');
  console.log('    ✅ 已写入');
  return { changed: true, changes, backupPath };
}

function uneditProfilePackage(profileDir, pluginName, dryRun) {
  const pkgPath = path.join(profileDir, 'package.json');
  const pkg = parseJsonTolerant(fs.readFileSync(pkgPath, 'utf8'));
  const changes = [];

  if (pkg.dependencies?.[pluginName] !== undefined) {
    changes.push(`移除 dependencies["${pluginName}"]`);
    delete pkg.dependencies[pluginName];
  }
  if (Array.isArray(pkg.dsh?.profile?.bundles)) {
    const before = pkg.dsh.profile.bundles.length;
    pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((x) => x !== pluginName);
    if (pkg.dsh.profile.bundles.length !== before) changes.push('移除 dsh.profile.bundles 条目');
  }
  if (pkg.pnpm?.overrides?.[pluginName] !== undefined) {
    changes.push(`移除 pnpm.overrides["${pluginName}"]`);
    delete pkg.pnpm.overrides[pluginName];
  }

  if (changes.length === 0) {
    console.log('  profile package.json：无本插件条目，无需改动');
    return;
  }
  for (const c of changes) console.log(`    · ${c}`);
  if (dryRun) return;

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  fs.copyFileSync(pkgPath, pkgPath + BACKUP_SUFFIX(stamp));
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  console.log('    ✅ 已写入');
}

// ---------------------------------------------------------------------------
// 父目录依赖桥
// ---------------------------------------------------------------------------

/**
 * 确保插件源码能解析到 DSH 的 peer 依赖。
 *
 * 原理：Node 从被加载模块所在目录开始，**逐级向上**查找 `node_modules`。
 * 因此桥可以放在插件目录的任意祖先目录。本函数按以下优先级选位置：
 *
 *   1. `--bridge-dir` 显式指定
 *   2. 已存在的、指向正确目标的祖先 node_modules（复用，避免建多份）
 *   3. 插件目录的**父目录**（默认位置）
 *
 * 桥内为每个 scope 建一个 Junction：
 *   `<bridge>/node_modules/@deepseek-ai` → `<profiles>/node_modules/@deepseek-ai`
 *
 * @returns {{ bridgeRoot: string, results: Array<{scope: string, status: string, reason: string}> }}
 */
function ensureParentBridge(sourceDir, profileDir, dryRun, explicitBridgeDir) {
  const shared = sharedNodeModules(profileDir);
  const scopes = ['@deepseek-ai', '@earendil-works'];

  // 候选位置：显式指定 > 已存在的有效桥 > 父目录
  const candidates = [];
  if (explicitBridgeDir) candidates.push(path.resolve(explicitBridgeDir, 'node_modules'));
  // 从插件目录向上找 4 层，看有没有已经建好的桥
  for (let dir = sourceDir, depth = 0; depth < 5; depth++) {
    const probe = path.join(dir, 'node_modules');
    if (fs.existsSync(probe) && dir !== sourceDir) {
      const hasScope = scopes.some((s) => fs.existsSync(path.join(probe, s)));
      if (hasScope) {
        candidates.push(probe);
        break;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  candidates.push(path.join(path.dirname(sourceDir), 'node_modules'));

  const bridgeRoot = candidates[0];
  const results = [];

  for (const scope of scopes) {
    const linkPath = path.join(bridgeRoot, scope);
    const targetPath = path.join(shared, scope);

    // 若某个祖先已能解析到该 scope，且不是我们选定的 bridgeRoot，则跳过
    if (!fs.existsSync(targetPath)) {
      results.push({ scope, status: 'skipped', reason: `目标不存在：${targetPath}` });
      continue;
    }

    const current = readLinkTarget(linkPath);
    // ⚠️ 比较必须**双侧穿透**：linkPath 可能已是 Junction，其 realpath 是目标
    // 真身（如 C:\...\profiles\node_modules\@scope），而 targetPath 是**经桥的
    // 路径**（可能形如 <临时目录>\profiles\node_modules\@scope）。两者字符串
    // 不同却指向同一目录——只比较字符串会误判「指向他处」，进而无谓地
    // 删掉重建（在 Windows 上紧跟着的 existsSync 可能因延迟返回 false，
    // 让随后的 peer 验证误报失败）。
    const targetReal = readLinkTarget(targetPath) ?? targetPath;
    if (current !== null && path.resolve(current) === path.resolve(targetReal)) {
      results.push({ scope, status: 'ok', reason: '已就绪' });
      continue;
    }

    if (fs.existsSync(linkPath) || isJunction(linkPath)) {
      results.push({ scope, status: 'replace', reason: `已存在但指向他处：${current}` });
      if (!dryRun) {
        removeLink(linkPath);
        createLink(linkPath, targetPath);
      }
      continue;
    }

    results.push({ scope, status: 'create', reason: `→ ${targetPath}` });
    if (!dryRun) createLink(linkPath, targetPath);
  }

  return { bridgeRoot, results };
}

/**
 * 检查插件能否解析到关键 peer 依赖（不依赖桥是否由本次创建）。
 *
 * 搜索顺序与 Node 的模块解析一致：先查**桥位置**（本次可能新建/替换的），
 * 再从插件目录逐级向上找 node_modules/<spec>。
 *
 * ⚠️ 桥位置必须参与检查：当桥建在 `--bridge-dir` 指定的**非祖先目录**时，
 * 只沿父目录找会误报"未解析到"——而运行时 Node 是从被加载文件的实际位置
 * （经 Junction 的 profile/node_modules）解析的，桥恰好在那个祖先链上。
 * 因此这里把 bridgeRoot 作为**首选**解析起点。
 *
 * @param {string} sourceDir 插件源目录
 * @param {string[]} [extraDirs] 额外的解析起点（如 bridgeRoot 的父目录）
 */
async function canResolvePeerDeps(sourceDir, extraDirs = []) {
  const checks = ['@deepseek-ai/dsh-llm', '@deepseek-ai/cordis', '@earendil-works/pi-ai'];
  const results = [];
  /**
   * Windows 上 Junction 刚删建后 existsSync 可能短暂 false（文件系统延迟）。
   *
   * ⚠️ 用 `fs.existsSync` + **异步** `setTimeout` 让步，**不要**同步自旋
   * （`while (Date.now() < dead) {}`）——后者会把一个 CPU 核心 100% 占满，
   * 在多核机器上也会明显拖慢整机、并让风扇狂转。CLI 工具同样不该这样写。
   * 因此 `canResolvePeerDeps` 是 **async** 的（调用方需 await）。
   */
  const existsWithRetry = async (p) => {
    for (let i = 0; i < 3; i++) {
      if (fs.existsSync(p)) return true;
      await new Promise((r) => setTimeout(r, 120));
    }
    return fs.existsSync(p);
  };
  for (const spec of checks) {
    let found = null;
    // ① 额外起点（桥所在目录的祖先链）
    for (const start of extraDirs) {
      let dir = start;
      for (let depth = 0; depth < 8; depth++) {
        const probe = path.join(dir, 'node_modules', ...spec.split('/'));
        if (await existsWithRetry(probe)) {
          found = probe;
          break;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      if (found !== null) break;
    }
    // ② 插件目录的祖先链
    if (found === null) {
      let dir = sourceDir;
      for (let depth = 0; depth < 8; depth++) {
        const probe = path.join(dir, 'node_modules', ...spec.split('/'));
        if (await existsWithRetry(probe)) {
          found = probe;
          break;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    results.push({ spec, resolved: found !== null, path: found });
  }
  return results;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const sourceDir = resolveSource(opts.source);
  const manifest = readManifest(sourceDir);
  const pluginName = manifest.name;

  // ---- 选定 profile：显式指定 > 自动探测 -------------------------------
  //
  // 不同 DSH 版本的 profile 布局不同（Desktop / CLI / 自定义 DSH_HOME），
  // 硬编码一个路径在别的机器上会直接失败。未指定 --profile 时用探测结果，
  // 并把所有候选打印出来，便于用户用 --profile 精确指定。
  let profileDir;
  let targetLabel;
  if (opts.profile) {
    profileDir = path.resolve(opts.profile);
    targetLabel = '显式指定';
  } else {
    const all = detectProfiles();
    if (all.length > 0) {
      console.log('检测到以下 DSH profile：');
      for (const t of all) console.log(`  · ${describeTarget(t)}`);
      console.log('');
    }
    const pick = pickDefaultTarget(pluginName);
    if (pick === null) {
      profileDir = defaultProfileDir();
      targetLabel = '默认位置（未探测到）';
    } else {
      profileDir = pick.profile.dir;
      targetLabel = pick.root.label;
    }
  }

  console.log(`DSH 插件注入：${pluginName}@${manifest.version ?? '?'}`);
  console.log(`  源目录:   ${sourceDir}`);
  console.log(`  profile:  ${profileDir}`);
  console.log(`  来源:     ${targetLabel}`);
  console.log(`  模式:     ${opts.uninstall ? '卸载' : opts.dryRun ? '预览（不写入）' : '安装'}`);
  console.log('');

  if (!fs.existsSync(profileDir)) {
    console.error(`❌ profile 目录不存在：${profileDir}`);
    console.error('   请先安装并至少启动一次 DSH，或用 --profile 指定正确路径。');
    console.error('   提示：本机已探测到的 profile 见上方列表。');
    process.exit(1);
  }

  const linkPath = path.join(profileDir, 'node_modules', pluginName);

  if (opts.uninstall) {
    console.log('[1/3] 移除 profile 登记');
    uneditProfilePackage(profileDir, pluginName, opts.dryRun);
    console.log('');
    console.log('[2/3] 移除 Junction');
    if (fs.existsSync(linkPath) || isJunction(linkPath)) {
      console.log(`  ${linkPath}`);
      if (!opts.dryRun) removeLink(linkPath);
      console.log(`  ${opts.dryRun ? '（预览）' : '✅ 已移除'}`);
    } else {
      console.log('  不存在，跳过');
    }
    console.log('');
    console.log('[3/3] 依赖桥保持不动（可能被其他插件共用）');
    console.log('');
    console.log(opts.dryRun ? '预览完成。' : '✅ 卸载完成。重启 DSH 后生效。');
    return;
  }

  // ---- 安装 ----
  console.log('[1/3] 建立 Junction（profile 的 node_modules → 插件源码）');
  const currentTarget = readLinkTarget(linkPath);
  if (currentTarget !== null && path.resolve(currentTarget) === path.resolve(sourceDir)) {
    console.log(`  已就绪：${linkPath}`);
  } else {
    if (fs.existsSync(linkPath) || isJunction(linkPath)) {
      console.log(`  已存在但指向他处，将替换：${currentTarget}`);
      if (!opts.dryRun) removeLink(linkPath);
    }
    console.log(`  ${linkPath}`);
    console.log(`    → ${sourceDir}`);
    if (!opts.dryRun) {
      createLink(linkPath, sourceDir);
      console.log('  ✅ 已建立');
    } else {
      console.log('  （预览）');
    }
  }
  console.log('');

  console.log('[2/3] 登记 profile package.json（三处）');
  editProfilePackage(profileDir, pluginName, opts.dryRun);
  console.log('');

  console.log('[3/3] 依赖桥（供插件解析 DSH 的 peer 依赖）');
  const bridge = ensureParentBridge(sourceDir, profileDir, opts.dryRun, opts.bridgeDir);
  console.log(`  桥位置：${bridge.bridgeRoot}`);
  for (const r of bridge.results) {
    const icon = r.status === 'ok' ? '✅' : r.status === 'skipped' ? '⏭️' : '🔧';
    console.log(`  ${icon} ${r.scope.padEnd(20)} ${r.reason}`);
  }
  console.log('');

  if (opts.dryRun) {
    console.log('预览完成，未写入任何文件。去掉 --dry-run 以实际执行。');
    return;
  }

  // ---- 验证 ----
  console.log('验证：');
  const verifyLink = readLinkTarget(linkPath);
  console.log(`  Junction 可达:      ${verifyLink !== null ? '✅' : '❌'}`);
  console.log(`  入口文件存在:       ${fs.existsSync(path.join(linkPath, 'lib', 'index.js')) ? '✅' : '❌'}`);
  console.log(`  patch 文件存在:     ${fs.existsSync(path.join(linkPath, 'cordis.patch.yml')) ? '✅' : '❌'}`);
  console.log(`  WASM 二进制存在:    ${fs.existsSync(path.join(linkPath, 'research', 'wasm.bin')) ? '✅' : '❌'}`);
  console.log(`  glue 代码存在:      ${fs.existsSync(path.join(linkPath, 'research', 'qoder-wasm-glue.mjs')) ? '✅' : '❌'}`);
  console.log('');
  console.log('  peer 依赖解析（桥位置优先，其次插件目录祖先链）：');
  const peerResults = await canResolvePeerDeps(sourceDir, [path.dirname(bridge.bridgeRoot)]);
  let peerAllOk = true;
  for (const r of peerResults) {
    if (r.resolved) {
      console.log(`    ✅ ${r.spec}`);
    } else {
      peerAllOk = false;
      console.log(`    ❌ ${r.spec} —— 未解析到（插件会在 import 阶段失败）`);
    }
  }
  console.log('');

  // ---- 前置条件 ----
  console.log('前置条件检查：');
  const roaming = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  const credDir = path.join(roaming, 'QwenWorkCN');
  const hasCred = fs.existsSync(credDir);
  console.log(`  千问办公登录态: ${hasCred ? '✅ 已找到' : '❌ 未找到'}`);
  if (!hasCred) {
    console.log(`     请先安装并登录千问办公桌面 App（预期目录：${credDir}）。`);
    console.log('     插件复用该 App 的登录态，本身不提供账号。');
  }
  console.log('');

  if (!peerAllOk) {
    console.log('❌ 存在未解析的 peer 依赖，插件很可能加载失败。');
    console.log('   请用 --bridge-dir 显式指定一个可用的桥位置后重试。');
    process.exit(1);
  }

  console.log('✅ 注入完成。请完全退出并重启 DSH（host 侧只在启动时加载插件）。');
}

// main 现在是 async（内部用异步重试替代同步自旋），必须 await 才能捕获其拒绝。
try {
  await main();
} catch (error) {
  console.error(`\n❌ 失败：${error.message}`);
  process.exit(1);
}
