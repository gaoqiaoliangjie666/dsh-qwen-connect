/**
 * 自动探测本机所有 DSH 安装形态（Desktop / CLI / 自定义 DSH_HOME）。
 *
 * 为什么要独立成模块：安装器需要适配「同一个插件装到不同版本的 DSH」——
 * 它们的 profile 目录布局不同，硬编码一个路径会在别的机器上直接失败。
 *
 * 支持的形态（按探测优先级）：
 *   1. `--profile <dir>` 显式指定（最高优先级，跳过自动探测）
 *   2. `$DSH_HOME/profiles/<name>`
 *   3. DSH Desktop：`%APPDATA%\dsh-desktop\harness\profiles\<name>`
 *   4. DSH Desktop（备用）：`%LOCALAPPDATA%\dsh-desktop\harness\profiles\<name>`
 *   5. DSH CLI：`~/.dsh/profiles/<name>`
 *   6. DSH CLI（XDG）：`~/.config/dsh/profiles/<name>`
 *
 * ⚠️ 一个 profile 目录「存在」不等于「可用」：需要同时有 package.json
 * （登记插件用）与 cordis 运行时（peer 依赖可解析）。`probeProfile` 会把
 * 这些信息一并返回，由调用方决定装哪个、以及是否需要建依赖桥。
 *
 * @module dsh-qwen-connect/tools/detect-dsh
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 常用的 profile 名（DSH 默认是 web）。 */
export const DEFAULT_PROFILE_NAMES = ['web', 'desktop'];

/**
 * 列出所有候选 DSH 根目录（harness 目录 / DSH_HOME）。
 *
 * @returns {Array<{ label: string, root: string, profilesDir: string }>}
 */
export function candidateRoots() {
  const out = [];
  const seen = new Set();
  const push = (label, root) => {
    if (typeof root !== 'string' || root === '') return;
    const resolved = path.resolve(root);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    out.push({ label, root: resolved, profilesDir: path.join(resolved, 'profiles') });
  };

  // 1) 显式 DSH_HOME
  if (process.env.DSH_HOME) push('DSH_HOME 环境变量', process.env.DSH_HOME);

  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const home = os.homedir();

  // 2) DSH Desktop
  push('DSH Desktop', path.join(appData, 'dsh-desktop', 'harness'));
  // 3) DSH Desktop 备用位置
  push('DSH Desktop（Local）', path.join(localAppData, 'dsh-desktop', 'harness'));
  // 4) DSH CLI
  push('DSH CLI', path.join(home, '.dsh'));
  // 5) DSH CLI（XDG）
  push('DSH CLI（XDG）', path.join(home, '.config', 'dsh'));

  return out;
}

/**
 * 探测单个 profile 的可用性。
 *
 * @param {string} profileDir
 * @returns {{ dir: string, exists: boolean, hasManifest: boolean,
 *             hasCordisRuntime: boolean, sharedNodeModules: string | null,
 *             pluginCount: number } }
 */
export function probeProfile(profileDir) {
  const dir = path.resolve(profileDir);
  const manifest = path.join(dir, 'package.json');
  const shared = path.join(dir, '..', 'node_modules');
  const result = {
    dir,
    exists: fs.existsSync(dir),
    hasManifest: fs.existsSync(manifest),
    hasCordisRuntime: false,
    sharedNodeModules: null,
    pluginCount: 0,
  };

  // cordis 运行时可能来自 profile 自己的 node_modules，或上级共享目录，
  // 也可能解析自 DSH 安装自带的位置（CLI 形态常见）。这里只检查前两者，
  // 第三种的可靠性由安装器的 canResolvePeerDeps 负责。
  const cordisCandidates = [
    path.join(dir, 'node_modules', '@deepseek-ai', 'cordis'),
    path.join(dir, '..', 'node_modules', '@deepseek-ai', 'cordis'),
  ];
  result.hasCordisRuntime = cordisCandidates.some((p) => fs.existsSync(p));
  if (fs.existsSync(shared)) result.sharedNodeModules = path.resolve(shared);

  try {
    const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8').replace(/^\uFEFF/, ''));
    const deps = pkg?.dependencies ?? {};
    result.pluginCount = Object.keys(deps).length;
  } catch {
    /* package.json 缺失或损坏：pluginCount 保持 0 */
  }

  return result;
}

/**
 * 自动探测本机可用的 DSH profile 列表。
 *
 * @param {string[]} [profileNames] 候选 profile 名，默认 web / desktop
 * @returns {Array<{ root: { label: string, root: string }, profile: ReturnType<typeof probeProfile> }>}
 */
export function detectProfiles(profileNames = DEFAULT_PROFILE_NAMES) {
  const found = [];
  for (const root of candidateRoots()) {
    if (!fs.existsSync(root.profilesDir)) continue;
    for (const name of profileNames) {
      const profile = probeProfile(path.join(root.profilesDir, name));
      // 只有真的存在（有 package.json）才算候选，避免把空目录当成安装目标
      if (profile.exists && profile.hasManifest) {
        found.push({ root, profile });
      }
    }
  }
  return found;
}

/**
 * 挑选默认安装目标。
 *
 * 优先级：
 *   1. 已装过本插件的 profile（升级场景，避免把插件装到第二个 profile）
 *   2. 插件最多、且有 cordis 运行时的 profile（最可能是用户日常在用的那个）
 *
 * @param {string} pluginName
 * @param {string[]} [profileNames]
 * @returns {{ root: object, profile: object } | null}
 */
export function pickDefaultTarget(pluginName, profileNames = DEFAULT_PROFILE_NAMES) {
  const all = detectProfiles(profileNames);
  if (all.length === 0) return null;

  const already = all.find(({ profile }) => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(profile.dir, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
      return Boolean(pkg?.dependencies?.[pluginName]);
    } catch {
      return false;
    }
  });
  if (already) return already;

  const scored = [...all].sort((a, b) => {
    const ca = (a.profile.hasCordisRuntime ? 1000 : 0) + a.profile.pluginCount;
    const cb = (b.profile.hasCordisRuntime ? 1000 : 0) + b.profile.pluginCount;
    return cb - ca;
  });
  return scored[0];
}

/** 供 CLI 打印用的一行摘要。 */
export function describeTarget({ root, profile }) {
  return `${root.label} → ${profile.dir}（插件 ${profile.pluginCount} 个${profile.hasCordisRuntime ? '，cordis 就绪' : '，cordis 需桥接'}）`;
}
