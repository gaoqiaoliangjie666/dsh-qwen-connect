/**
 * 运行期解析 QwenWork 客户端标识：`Cosy-Version` 与 `machineId`。
 *
 * ── 为什么需要这个模块 ──────────────────────────────────────────────
 * 阶段 A-1 的签名实现把两者写成了常量（`COSY_VERSION = '1.1.32'`、
 * machineId 取 `credential.loginDeviceId`）。提交 t3 时已标注这是脆弱点：
 *   - 版本硬编码 → App 升级后签名可能被服务端拒绝；
 *   - machineId 单一来源 → 与 App 实际持久化值不一致时**静默失败**，
 *     表现为难以定位的 403。
 *
 * 本模块把两者都改为「**多来源探测 + 明确回退 + 可诊断**」。
 *
 * ── 安全边界 ────────────────────────────────────────────────────────
 * 只读 App 安装目录，绝不写入；不记录任何凭据明文；日志只输出来源名与
 * 版本号（版本号非敏感）。
 *
 * @module dsh-qwen-connect/runtime-identity
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * 阶段 A-1 实测可用于签名的版本。作为**最后一级回退**——它已在真实链路上
 * 验证过（HTTP 200），因此比「猜一个更高版本」安全。
 */
export const FALLBACK_COSY_VERSION = '1.1.32';

/**
 * QwenWorkCN 安装根目录候选（按优先级探测）。
 *
 * ⚠️ **不得写死开发机的盘符路径**（曾写成 `E:\software\Qwen\QwenWorkCN`）：
 * 那是开发者本机的安装位置，在别人的电脑上既不会命中、又留下一处误导性的
 * 硬编码——若对方恰好有同名目录，还会读到非预期的版本来源。
 *
 * 这里只列**通用可推导**的位置：
 *   · Program Files 两个位宽（标准安装）
 *   · 用户级安装（Electron 默认的 per-user 位置）
 *   · 常见的自定义根下的 Qwen/QwenWorkCN（覆盖「装在 D/E 盘」的多数情况，
 *     因为盘符是遍历得到的而不是写死的）
 *
 * 全部未命中时由 `resolveCosyVersion` 回退到 `FALLBACK_COSY_VERSION`，
 * 该常量已实测可被服务端接受（见 probe-version-portability.mjs：1.0.5 /
 * 1.1.32 / 1.2.0 均可正常签名使用）。因此「装在哪」不影响可用性。
 */
export function installRootCandidates(env = process.env) {
  const home = env.USERPROFILE ?? os.homedir();
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const localAppData = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');

  const out = [
    path.join(programFiles, 'Qwen', 'QwenWorkCN'),
    path.join(programFilesX86, 'Qwen', 'QwenWorkCN'),
    path.join(localAppData, 'Programs', 'QwenWorkCN'),
    path.join(localAppData, 'Qwen', 'QwenWorkCN'),
  ];

  // 非 C 盘的自定义安装：遍历系统可见的固定盘符，找常见的两级布局。
  // 这是「装在 D/E 盘」场景的通用覆盖，比写死某个盘符更可靠。
  for (const drive of enumerateFixedDrives(env)) {
    out.push(path.join(drive, 'Qwen', 'QwenWorkCN'));
    out.push(path.join(drive, 'Program Files', 'Qwen', 'QwenWorkCN'));
    out.push(path.join(drive, 'software', 'Qwen', 'QwenWorkCN'));
  }

  // 去重，保持优先级顺序
  const seen = new Set();
  return out.filter((p) => {
    const key = p.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 枚举可用的固定盘符（C..Z，跳过 A/B 与不存在者）。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
function enumerateFixedDrives(env = process.env) {
  const out = [];
  const override = env.QWEN_INSTALL_DRIVES;
  if (typeof override === 'string' && override !== '') {
    // 允许显式指定（如 "D:,E:"），省去逐个探测
    for (const d of override.split(',')) {
      const t = d.trim().replace(/\\+$/, '');
      if (/^[A-Za-z]:$/.test(t)) out.push(t.toUpperCase());
    }
    return out;
  }
  for (let i = 67; i <= 90; i += 1) {
    const drive = `${String.fromCharCode(i)}:`;
    if (drive === 'C:') continue; // C 盘已在候选里显式列出
    try {
      if (fs.existsSync(`${drive}\\`)) out.push(drive);
    } catch {
      /* 无权限/无设备：跳过 */
    }
  }
  return out;
}

/** 兼容旧引用：默认候选列表（函数形式，便于随环境变化）。 */
export const DEFAULT_INSTALL_ROOT_CANDIDATES = installRootCandidates();

/** obf 运行时相对安装根目录的路径。 */
const OBF_RELATIVE = path.join(
  'resources',
  'app.asar.unpacked',
  'node_modules',
  '@qoder-ai',
  'qoder-agent-sdk',
  'dist',
  '_worker',
  'qoder-worker-runtime.obf.mjs',
);

/** App 自身 package.json 相对安装根目录的候选路径。 */
const PACKAGE_RELATIVE_CANDIDATES = [
  path.join('resources', 'app', 'package.json'),
  path.join('resources', 'app.asar.unpacked', 'package.json'),
  'package.json',
];

/**
 * 取出形如 `1.2.3` 的版本串。
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function asVersion(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  return m === null ? null : `${m[1]}.${m[2]}.${m[3]}`;
}

/**
 * 在目录下按候选枚举版本化子目录，返回版本号最大的那个（连同其路径）。
 *
 * QwenWorkCN 的安装布局是 `.../QwenWorkCN/<version>-<build>/`，因此版本从
 * 目录名即可获得——这是**最贴近 App 实际运行版本**的来源。
 *
 * @param {string} root
 * @returns {{ version: string, dir: string } | null}
 */
function newestVersionedSubdir(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  /** @type {Array<{ version: string, dir: string, key: number[] }>} */
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(entry.name);
    if (m === null) continue;
    found.push({
      version: `${m[1]}.${m[2]}.${m[3]}`,
      dir: path.join(root, entry.name),
      key: [Number(m[1]), Number(m[2]), Number(m[3])],
    });
  }
  if (found.length === 0) return null;
  found.sort((a, b) => {
    for (let i = 0; i < 3; i += 1) {
      if (a.key[i] !== b.key[i]) return b.key[i] - a.key[i];
    }
    return 0;
  });
  return { version: found[0].version, dir: found[0].dir };
}

/**
 * 从 obf 运行时里读 `COSY_VERSION` 的实际取值。
 *
 * 逆向结论（阶段 A-1 补充，2026 复核）：
 *   `COSY_VERSION:()=>$AA`  →  `$AA = xSA || "1.1.32"`  →  `xSA = "1.1.32"`
 * 即该 SDK 把 Cosy 协议版本**编译期硬编码**在模块 `xSA` 里，仅在未赋值时
 * 回退到同名默认值。两处字面量一致。
 *
 * ⚠️ 重要更正：本文件早期版本曾把「安装目录名」（如 `1.0.5-26090806`）
 * 当作 Cosy-Version。实测证明二者是**不同的版本域**：
 *   - 安装目录名 = QwenWork **App 发布版本**（1.0.5）
 *   - COSY_VERSION = qoder-agent-sdk 的 **Cosy 协议版本**（1.1.32）
 * 两者都被服务端接受（见 research/probe-cosy-version.mjs 实测：均 HTTP 200），
 * 但语义正确性上必须以 SDK 的 COSY_VERSION 为准。
 *
 * @param {string} obfPath
 * @returns {string | null}
 */
function cosyVersionFromObf(obfPath) {
  let text;
  try {
    text = fs.readFileSync(obfPath, 'utf8');
  } catch {
    return null;
  }

  // 路径 A：沿 COSY_VERSION 的 re-export 别名找其赋值实参
  const aliasMatch = /COSY_VERSION:\(\)=>([A-Za-z_$][\w$]*)/.exec(text);
  if (aliasMatch !== null) {
    const alias = aliasMatch[1];
    // 注意：别名可能以 `$` 开头（如 `$AA`），此时不能用 `\b` ——
    // `\b` 在 `$` 前后不成立，会导致正则永不匹配。这里只转义正则元字符。
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 形如：$AA=xSA||"1.1.32"  或  xSA="1.1.32"
    const direct = new RegExp(`${escaped}\\s*=\\s*[^;]{0,200}?"(\\d+\\.\\d+\\.\\d+)"`).exec(text);
    const v = asVersion(direct?.[1]);
    if (v !== null) return v;

    // 形如：$AA=<其他常量>||"1.1.32"，其中被引用的常量自身带字面量
    const refMatch = new RegExp(`${escaped}\\s*=\\s*([A-Za-z_$][\\w$]*)\\s*\\|\\|`).exec(text);
    if (refMatch !== null) {
      const inner = refMatch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const innerAssign = new RegExp(`${inner}\\s*=\\s*"(\\d+\\.\\d+\\.\\d+)"`).exec(text);
      const iv = asVersion(innerAssign?.[1]);
      if (iv !== null) return iv;
    }
  }

  // 路径 B：兜底——COSY_VERSION 附近的版本字面量
  const near = /COSY_VERSION[^\n]{0,200}?"(\d+\.\d+\.\d+)"/.exec(text);
  return asVersion(near?.[1]);
}

/**
 * 从 App 的 package.json 读版本。
 *
 * @param {string} installDir
 * @returns {string | null}
 */
function versionFromPackageJson(installDir) {
  for (const rel of PACKAGE_RELATIVE_CANDIDATES) {
    try {
      const raw = fs.readFileSync(path.join(installDir, rel), 'utf8');
      const parsed = JSON.parse(raw);
      const v = asVersion(parsed.version);
      if (v !== null) return v;
    } catch {
      /* 尝试下一个候选 */
    }
  }
  return null;
}

/**
 * 解析 `Cosy-Version`，按以下顺序探测并返回来源说明：
 *
 *   1. 环境变量 `QWEN_COSY_VERSION`（显式覆盖，测试与排障用）
 *   2. obf 运行时的 `COSY_VERSION` 常量 ← **权威**（签名用的就是它）
 *   3. 环境变量 `QWEN_APP_VERSION`（App 版本域，仅当 obf 不可读）
 *   4. 安装目录版本化子目录名（`.../<version>-<build>/`，App 版本域）
 *   5. App `package.json` 的 `version`（App 版本域）
 *   6. 常量回退 `FALLBACK_COSY_VERSION`
 *
 * ⚠️ 3–5 是 App **版本域**，与 Cosy **协议域**不同（实测 1.0.5 与 1.1.32
 * 均被服务端接受，因此可用，但语义上次一等）。之所以仍保留它们：obf 读取
 * 依赖 App 安装布局，一旦布局变化（如未 unpacked）会失败，此时宁可给一个
 * 真实存在的版本号，也不给一个编造值。
 *
 * @param {{ installRoot?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ version: string, source: string, detail: string }}
 */
export function resolveCosyVersion(opts = {}) {
  const env = opts.env ?? process.env;

  const fromEnv = asVersion(env.QWEN_COSY_VERSION);
  if (fromEnv !== null) {
    return { version: fromEnv, source: 'env', detail: '环境变量 QWEN_COSY_VERSION' };
  }

  const root = opts.installRoot ?? null;
  // 惰性计算候选列表（避免模块加载时就遍历盘符；也让 env 覆盖生效）
  const roots = root === null ? installRootCandidates(env) : [root];

  for (const candidateRoot of roots) {
    if (!fs.existsSync(candidateRoot)) continue;

    // App 的安装布局是 <root>/<version>-<build>/resources/...，因此 obf 与
    // package.json 可能位于版本子目录内，也可能直接位于 root。两者都试。
    const versioned = newestVersionedSubdir(candidateRoot);
    const installDirs = versioned === null ? [candidateRoot] : [versioned.dir, candidateRoot];

    // ① 权威来源：SDK 的 COSY_VERSION 常量
    for (const installDir of installDirs) {
      const obfPath = path.join(installDir, OBF_RELATIVE);
      if (!fs.existsSync(obfPath)) continue;
      const v = cosyVersionFromObf(obfPath);
      if (v !== null) {
        return {
          version: v,
          source: 'obf',
          detail: 'qoder-agent-sdk 的 COSY_VERSION 常量（Cosy 协议域，权威）',
        };
      }
    }

    // ② 次选：App 版本域（语义不同但实测可用）
    const fromAppEnv = asVersion(env.QWEN_APP_VERSION);
    if (fromAppEnv !== null) {
      return { version: fromAppEnv, source: 'env-app', detail: '环境变量 QWEN_APP_VERSION（App 版本域）' };
    }

    if (versioned !== null) {
      return {
        version: versioned.version,
        source: 'install-dir',
        detail: `安装目录名 ${path.basename(versioned.dir)}（App 版本域）`,
      };
    }

    const pkgVersion = versionFromPackageJson(candidateRoot);
    if (pkgVersion !== null) {
      return {
        version: pkgVersion,
        source: 'package-json',
        detail: 'App package.json 的 version（App 版本域）',
      };
    }
  }

  return {
    version: FALLBACK_COSY_VERSION,
    source: 'fallback',
    detail: '阶段 A-1 实测可用常量（未探测到 App 产物）',
  };
}

/**
 * 解析签名用的 machineId，按以下顺序探测：
 *
 *   1. 环境变量 `QWEN_MACHINE_ID`（显式覆盖）
 *   2. 凭据里的 `loginDeviceId`（App 自己写入的登录设备 id）
 *   3. 环境变量 `QWEN_MACHINE_ID_FALLBACK`
 *   4. 明确失败 —— **返回 null 而非编造值**，由调用方决定如何报告
 *
 * 与阶段 A-1 的差别：不再「取了 loginDeviceId 就当成功」，而是把**一致性
 * 校验**暴露出来（见 `describeMachineId`），使不一致可诊断而非静默 403。
 *
 * @param {{ credential?: any, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ machineId: string, source: string } | null}
 */
export function resolveMachineId(opts = {}) {
  const env = opts.env ?? process.env;

  const fromEnv = typeof env.QWEN_MACHINE_ID === 'string' ? env.QWEN_MACHINE_ID.trim() : '';
  if (fromEnv !== '') return { machineId: fromEnv, source: 'env' };

  const loginDeviceId = opts.credential?.loginDeviceId;
  if (typeof loginDeviceId === 'string' && loginDeviceId.trim() !== '') {
    return { machineId: loginDeviceId.trim(), source: 'credential.loginDeviceId' };
  }

  const fallback = typeof env.QWEN_MACHINE_ID_FALLBACK === 'string' ? env.QWEN_MACHINE_ID_FALLBACK.trim() : '';
  if (fallback !== '') return { machineId: fallback, source: 'env-fallback' };

  return null;
}

/**
 * 描述 machineId 的解析结果，供日志/卡片做**非敏感**诊断。
 *
 * 绝不回传 machineId 原文——只给来源、长度与短前缀掩码。
 *
 * @param {{ credential?: any, env?: NodeJS.ProcessEnv }} [opts]
 */
export function describeMachineId(opts = {}) {
  const resolved = resolveMachineId(opts);
  if (resolved === null) {
    return {
      available: false,
      source: null,
      reason:
        '未找到 machineId：凭据缺少 loginDeviceId，且未设置 QWEN_MACHINE_ID。'
        + '签名会失败（服务端将返回 403 Signature invalid），因此不继续。',
    };
  }
  const { machineId, source } = resolved;
  return {
    available: true,
    source,
    length: machineId.length,
    masked: machineId.length <= 8 ? '***' : `${machineId.slice(0, 4)}***${machineId.slice(-2)}`,
  };
}

/**
 * 汇总一次完整的运行期标识解析结果（版本 + 设备），供签名上下文构建与诊断。
 *
 * @param {{ credential?: any, installRoot?: string, env?: NodeJS.ProcessEnv }} [opts]
 */
export function resolveRuntimeIdentity(opts = {}) {
  const cosy = resolveCosyVersion(opts);
  const machine = describeMachineId(opts);
  return { cosyVersion: cosy, machineId: machine };
}
