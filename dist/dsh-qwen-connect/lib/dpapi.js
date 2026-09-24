/**
 * Windows DPAPI 解包：把 Chromium `Local State` 里的 os_crypt.encrypted_key
 * 还原成 32 字节 AES-256 主密钥。
 *
 * 实现策略（按稳定性排序，自动降级）：
 *   1. koffi / ffi-napi 直接调用 CryptUnprotectData（若用户环境装了原生模块）
 *   2. PowerShell 子进程（Windows 内置，已验证可用）—— 密钥只经 stdout 回传，
 *      不落盘、不写临时文件、不进命令行参数（blob 走 base64 内联脚本的 stdin 语义
 *      等价物需谨慎，故此处把密文内联进脚本而把「输出」作为唯一出口）。
 *   3. 全部失败 → 抛 DPAPI_FAILED，附带可操作提示。
 *
 * 安全约束：本模块任何路径都不得把解密结果写入日志或文件。
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { QwenAuthError, ErrorCode } from './errors.js';

const nodeRequire = createRequire(import.meta.url);

const POWERSHELL_CANDIDATES = [
  // 优先 Win10+ 内置的 Windows PowerShell 5.1（无需额外安装，且 System.Security 一定在 GAC）
  path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  'powershell.exe',
  'pwsh.exe',
];

const DPAPI_PREFIX = Buffer.from('DPAPI', 'ascii'); // 5 字节标记，必须剥离后才能交给 DPAPI

/** 平台判定：凭据解密目前只实现了 Windows DPAPI 路径 */
export function isSupportedPlatform() {
  return process.platform === 'win32';
}

/**
 * 剥离并校验 Chromium 的 `DPAPI` 前缀。
 * @param {Buffer} blob base64 解码后的 encrypted_key
 * @returns {Buffer} 交给 CryptUnprotectData 的密文
 */
export function stripDpapiPrefix(blob) {
  if (!Buffer.isBuffer(blob) || blob.length <= DPAPI_PREFIX.length) {
    throw new QwenAuthError(
      ErrorCode.CREDENTIALS_MALFORMED,
      `os_crypt.encrypted_key 长度异常（${blob?.length ?? 0} 字节）。`,
    );
  }
  if (!blob.subarray(0, DPAPI_PREFIX.length).equals(DPAPI_PREFIX)) {
    throw new QwenAuthError(
      ErrorCode.CREDENTIALS_MALFORMED,
      'os_crypt.encrypted_key 缺少 "DPAPI" 前缀，不是标准的 Windows Chromium 密文。',
    );
  }
  return blob.subarray(DPAPI_PREFIX.length);
}

// ---------------------------------------------------------------------------
// 策略 1：原生 FFI
// ---------------------------------------------------------------------------

/**
 * koffi 绑定的进程内单例。
 *
 * ⚠️ 必须**只初始化一次**：`koffi.struct(name, …)` 在重复注册同名类型时抛
 * `Duplicate type name 'DATA_BLOB'`。原实现把 struct/load/func 全放在
 * `tryNativeKoffi()` 内部，于是**第二次调用起必然抛错**，被 catch 静默吞掉
 * 并降级到 PowerShell —— 原生路径实际上从未真正连续可用过。
 *
 * 探测失败（未安装 koffi / 非 Windows ABI）后不再重试，直接走 PowerShell。
 */
let nativeBinding = null;
let nativeBindingUnavailable = false;

/**
 * 解析 koffi 原生模块；解析不到返回 null。
 *
 * 为什么需要两条路：DSH 通过 **junction**（`profiles/<p>/node_modules/dsh-qwen-connect`）
 * 加载本插件，而 Node 的 ESM 加载器默认会解析符号链接，使 `import.meta.url`
 * 变成仓库真实路径。实测本机：
 *   junction 路径 → `<DSH 安装根>\resources\app\node_modules\koffi\index.cjs`
 *   真实路径     → `MODULE_NOT_FOUND`
 * 即「只 require('koffi')」在真实加载方式下会失败，原生路径永远走不到。
 * 因此再按**宿主可执行文件/入口脚本**的位置向上找 node_modules 兜底
 * （DSH 把 koffi 与内置 Node 一起装在 `resources/app/node_modules` 下）。
 */
function loadKoffi() {
  // ① 常规解析：插件自己的依赖，或未解析符号链接时的上层 node_modules
  try {
    return nodeRequire('koffi');
  } catch {
    /* 继续尝试宿主布局 */
  }

  // ② 宿主布局兜底：createRequire 的 resolve 会自动逐级向上遍历 node_modules，
  //    因此只要 seed 落在宿主安装树内即可命中。
  const seeds = new Set();
  for (const p of [process.execPath, process.argv[1]]) {
    if (typeof p === 'string' && p !== '') seeds.add(path.dirname(p));
  }
  for (const seed of seeds) {
    try {
      const hostRequire = createRequire(path.join(seed, '__resolve_probe__.cjs'));
      return nodeRequire(hostRequire.resolve('koffi'));
    } catch {
      /* 换下一个 seed */
    }
  }
  return null;
}

function getNativeBinding() {
  if (nativeBinding !== null) return nativeBinding;
  if (nativeBindingUnavailable) return null;
  try {
    const koffi = loadKoffi();
    if (koffi === null) {
      nativeBindingUnavailable = true;
      return null;
    }
    // DATA_BLOB { DWORD cbData; BYTE *pbData; }
    koffi.struct('DATA_BLOB', { cbData: 'uint32', pbData: 'void *' });
    nativeBinding = {
      koffi,
      CryptUnprotectData: koffi
        .load('crypt32.dll')
        .func('bool CryptUnprotectData(DATA_BLOB *pDataIn, void *ppszDataDescr, DATA_BLOB *pOptionalEntropy, void *pvReserved, void *pPromptStruct, uint32 dwFlags, DATA_BLOB *pDataOut)'),
      LocalFree: koffi.load('kernel32.dll').func('void *LocalFree(void *hMem)'),
    };
    return nativeBinding;
  } catch {
    nativeBindingUnavailable = true;
    return null;
  }
}

/**
 * 尝试用 koffi 调用 CryptUnprotectData。
 *
 * OUT 参数必须是**原生内存**：koffi 的指针参数对 JS 对象是**值语义**（调用后
 * 不会回写），传 `{ cbData: 0, pbData: null }` 得到的永远是空结果；`pbData` 为
 * null 时还可能直接抛 `Cannot encode data in NULL pointer`。正确做法是用
 * `koffi.alloc` 分配结构体、调用后用 `koffi.decode` 读回，并分别释放 pbData
 * （LocalFree）与结构体本身（koffi.free）。
 *
 * @param {Buffer} cipher 已剥离 DPAPI 前缀的密文
 * @returns {Buffer|null} 主密钥；原生模块不可用或调用失败时返回 null 以便降级
 */
function tryNativeKoffi(cipher) {
  const binding = getNativeBinding();
  if (binding === null) return null;
  const { koffi, CryptUnprotectData, LocalFree } = binding;

  let outPtr = null;
  try {
    const inBuf = Buffer.from(cipher);
    const blobIn = { cbData: inBuf.length, pbData: inBuf };
    outPtr = koffi.alloc('DATA_BLOB', 1);
    const ok = CryptUnprotectData(blobIn, null, null, null, null, 0, outPtr);
    if (!ok) return null;
    const out = koffi.decode(outPtr, 'DATA_BLOB');
    if (out.pbData === null || out.cbData === 0) return null;
    try {
      return Buffer.from(koffi.decode(out.pbData, 'uint8', out.cbData));
    } finally {
      LocalFree(out.pbData);
    }
  } catch {
    return null; // 结构/绑定不兼容时静默降级到 PowerShell
  } finally {
    if (outPtr !== null) {
      try {
        koffi.free(outPtr);
      } catch {
        /* 释放失败不影响结果 */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 策略 2：PowerShell 子进程
// ---------------------------------------------------------------------------

/** PowerShell 脚本模板：只把主密钥的 base64 写到 stdout，其余一律丢弃 */
export function buildPowerShellScript(cipherB64) {
  return [
    '$ErrorActionPreference = "Stop"',
    // 5.1 默认不加载该程序集，必须显式 Add-Type，否则 [Security.Cryptography.ProtectedData] 找不到
    'Add-Type -AssemblyName System.Security',
    `$b = [Convert]::FromBase64String('${cipherB64}')`,
    "$mk = [Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser')",
    '[Convert]::ToBase64String($mk)',
  ].join('; ');
}

function resolvePowerShell() {
  for (const cand of POWERSHELL_CANDIDATES) {
    if (cand.includes(path.sep)) {
      if (fs.existsSync(cand)) return cand;
    } else {
      return cand; // 交给 PATH 解析
    }
  }
  return null;
}

/**
 * 用 PowerShell 解 DPAPI。
 * @param {Buffer} cipher 已剥离 DPAPI 前缀的密文
 * @returns {Buffer} 主密钥
 */
export function unprotectWithPowerShell(cipher) {
  const exe = resolvePowerShell();
  if (!exe) {
    throw new QwenAuthError(
      ErrorCode.DPAPI_FAILED,
      '未找到可用的 PowerShell 可执行文件，无法调用 Windows DPAPI。',
    );
  }
  const script = buildPowerShellScript(cipher.toString('base64'));
  let res;
  try {
    res = spawnSync(
      exe,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 },
    );
  } catch (e) {
    throw new QwenAuthError(ErrorCode.DPAPI_FAILED, `调用 PowerShell 解 DPAPI 失败：${e.message}`, { cause: e });
  }
  if (res.error) {
    throw new QwenAuthError(ErrorCode.DPAPI_FAILED, `PowerShell 进程启动失败：${res.error.message}`, { cause: res.error });
  }
  if (res.status !== 0) {
    // stderr 里可能含系统信息，但不含密钥；截断后作为诊断。
    //
    // ⚠️ 编码：中文 Windows 上 PowerShell 5.1 的 stderr 走 GBK（CP936），
    // 而 spawnSync 以 utf8 解码，直接把原始字节当诊断信息会得到 U+FFFD
    // 替换字符（俗称"乱码"）。因此这里不直接透出 stderr 原文，而是给
    // 出稳定的可操作提示，仅在 DEBUG 环境变量下附带原始片段供排查。
    //
    // 注：此处刻意不写出乱码样例本身，避免源码中出现疑似编码损坏的字节，
    // 干扰后续的编码体检与评审。判定文件编码请以字节读取为准，不要以
    // 终端回显为准（中文 Windows 的 GBK 控制台会把 UTF-8 中文显示成假乱码）。
    const raw = (res.stderr || '').trim().split(/\r?\n/)[0]?.slice(0, 200) ?? '';
    const hint = process.env.DSH_QWEN_CONNECT_DEBUG
      ? `（原始 stderr 可能因 GBK/UTF-8 不一致而乱码：${raw}）`
      : '';
    throw new QwenAuthError(
      ErrorCode.DPAPI_FAILED,
      `DPAPI 解包失败（PowerShell 退出码 ${res.status}）。`
        + '请确认当前 Windows 用户与保存凭据的用户一致，且凭据文件未被其他程序占用。'
        + hint,
    );
  }
  const out = (res.stdout || '').trim();
  if (!out) {
    throw new QwenAuthError(ErrorCode.DPAPI_FAILED, 'DPAPI 解包返回空结果。');
  }
  const key = Buffer.from(out, 'base64');
  if (key.length !== 32) {
    throw new QwenAuthError(
      ErrorCode.DPAPI_FAILED,
      `DPAPI 解出的主密钥长度异常（期望 32 字节，实际 ${key.length} 字节）。`,
    );
  }
  return key;
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

/**
 * 把 `Local State` 的 encrypted_key（base64 字符串）解成 AES-256 主密钥。
 * @param {string} encryptedKeyB64
 * @returns {Buffer} 32 字节主密钥
 */
export function unprotectMasterKey(encryptedKeyB64) {
  if (!isSupportedPlatform()) {
    throw new QwenAuthError(
      ErrorCode.UNSUPPORTED_PLATFORM,
      `凭据解密仅支持 Windows DPAPI，当前平台为 ${process.platform}。`,
    );
  }
  if (typeof encryptedKeyB64 !== 'string' || encryptedKeyB64.length === 0) {
    throw new QwenAuthError(
      ErrorCode.CREDENTIALS_MALFORMED,
      'Local State 中缺少 os_crypt.encrypted_key。',
    );
  }

  let decoded;
  try {
    decoded = Buffer.from(encryptedKeyB64, 'base64');
  } catch (e) {
    throw new QwenAuthError(ErrorCode.CREDENTIALS_MALFORMED, 'os_crypt.encrypted_key 不是合法 base64。', { cause: e });
  }
  if (decoded.length === 0) {
    throw new QwenAuthError(ErrorCode.CREDENTIALS_MALFORMED, 'os_crypt.encrypted_key 解码后为空。');
  }

  const cipher = stripDpapiPrefix(decoded);

  // 策略 1：原生 FFI（装了才走）
  const native = tryNativeKoffi(cipher);
  if (native && native.length === 32) return native;

  // 策略 2：PowerShell
  return unprotectWithPowerShell(cipher);
}
