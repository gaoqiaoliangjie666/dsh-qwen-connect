/**
 * 与 t1（凭据解密 + REST 客户端）之间的**唯一接缝**。
 *
 * 设计意图：DSH 集成层不重复实现任何解密逻辑，只消费 t1 的产物。
 *
 * ── 与「统一契约」的偏差说明（重要）─────────────────────────────
 * 队长批准的统一签名是 `getValidToken / getAccountContext / fetchQuota /
 * fetchPlan`。t1 实际交付的导出面**并不完全同名**：
 *
 *   契约名               t1 实际实现
 *   ------------------   -------------------------------------------
 *   getValidToken()      → getValidToken()               （同名，但返回对象）
 *   getAccountContext()  → fetchAccountOverview(token)   （异名）
 *   fetchQuota()         → extractQuotaUsage(payload)    （异名且非请求函数）
 *   fetchPlan()          → extractUserPlan(payload)      （异名且非请求函数）
 *
 * 处理方式：**在本接缝内适配，不让 t1 返工**。此处的职责正是把上游的真实
 * 形状翻译成集成层期望的形状。对外仍完整提供契约里的四个函数名，因此
 * `lib/index.js` 与卡片无需感知差异。
 *
 * ── 硬性约束 ────────────────────────────────────────────────────
 * **绝不硬编码任何积分/套餐数值。** t1 未就位时这里显式抛错，让卡片显示
 * 「尚未接入」，而不是显示一个看起来真实的假数字。
 *
 * @module dsh-qwen-connect/credentials-seam
 */

import { QwenAuthError, ErrorCode } from './errors.js';

/**
 * t1 实现模块的候选位置，按优先级排列。
 *
 * ⚠️ 实测教训：t1 在开发过程中把模块从 `src/` **整体移到了 `lib/`**，
 * 使写死单一路径的接缝一度失效（`Cannot find module '../src/errors.js'`）。
 * 因此实现主体改为**多路径探测**，两种布局都能工作，t1 再挪动时也不会
 * 立刻打断集成。
 *
 * 注意 `lib/` 与集成层自己的文件同目录：`index.js` / `client.js` /
 * `web-status.js` / `models.js` / `loopback.js` / `credentials-seam.js` 属于
 * 集成层；t1 的是 `credentials.js` / `auth.js` / `rest.js` / `errors.js` /
 * `dpapi.js` / `api.js`。
 */
const AUTH_MODULE_CANDIDATES = ['./auth.js', '../src/auth.js'];
const REST_MODULE_CANDIDATES = ['./rest.js', '../src/rest.js'];
const CREDENTIALS_MODULE_CANDIDATES = ['./credentials.js', '../src/credentials.js'];

/** 缓存的实现对象；加载失败也为 null，允许后续重试。 */
let impl = null;
/** 上次加载失败的原因，用于给出可诊断的提示。 */
let loadNote = '';

/**
 * 按候选顺序尝试 import，返回第一个成功的模块。
 *
 * ⚠️ 错误诊断的关键细节：不能只保留**最后一个**失败。
 *
 * 反例（真实踩到过）：`./auth.js` 存在但**内含语法错误**，`../src/auth.js`
 * 不存在。若只记最后一个错误，用户看到的是「Cannot find module '../src/auth.js'」
 * ——一个**误导性的**结论，真正的问题（首个候选文件损坏）被回退分支掩盖了。
 *
 * 因此这里按「诊断价值」挑错误：
 *   语法/求值错误 > 解析失败（MODULE_NOT_FOUND）
 * 前者说明文件确实存在且被找到了，只是内容坏了，信息量更大。
 *
 * 无论挑中哪个，都会抛出，**绝不静默返回空值**。
 *
 * @param {string[]} candidates
 * @returns {Promise<{ module: any, url: string } | null>}
 */
async function importFirst(candidates) {
  /** @type {Array<{ specifier: string, error: Error, code: string }>} */
  const failures = [];

  for (const specifier of candidates) {
    try {
      const module = await import(specifier);
      return { module, url: specifier };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      failures.push({
        specifier,
        error: err,
        // MODULE_NOT_FOUND 表示「没找到」；其余（如 SyntaxError）表示「找到了但坏了」
        code: /** @type {any} */ (err).code ?? err.name,
      });
    }
  }

  // 优先报告「找得到但坏了」的候选：它比「找不到」更接近真实原因。
  const broken = failures.find((f) => f.code !== 'MODULE_NOT_FOUND');
  const chosen = broken ?? failures[failures.length - 1];

  loadNote =
    chosen === undefined
      ? ''
      : `候选 ${chosen.specifier} 加载失败 [${chosen.code}]：${chosen.error.message}` +
        (failures.length > 1
          ? `（另 ${failures.length - 1} 条候选也未成功）`
          : '');
  return null;
}

/**
 * 惰性加载 t1 产物。
 *
 * 采用惰性 + 容错加载而非顶层静态 import：t1 尚未交付时，`lib/index.js`
 * 仍必须能被 DSH 成功加载并注册 provider 骨架。顶层 import 失败会让整个
 * 插件（连同设置卡片）加载失败，触发 DSH 红色横幅。
 *
 * @returns {Promise<{ auth: any, rest: any } | null>}
 */
export async function loadImplementation() {
  if (impl !== null) return impl;
  const auth = await importFirst(AUTH_MODULE_CANDIDATES);
  if (auth === null) return null;
  const rest = await importFirst(REST_MODULE_CANDIDATES);
  if (rest === null) return null;
  // 凭据读取模块是可选的：只有 t1 的 getValidToken() 退化为纯字符串时才用到
  const credentials = await importFirst(CREDENTIALS_MODULE_CANDIDATES);
  impl = { auth: auth.module, rest: rest.module, credentials: credentials?.module ?? null };
  loadNote = '';
  return impl;
}

/** t1 未就绪时统一抛出的错误。该错误走正常卡片错误通道展示。 */
function notWired(what) {
  return new QwenAuthError(
    ErrorCode.CREDENTIALS_MISSING,
    `dsh-qwen-connect: ${what} 尚未接入（等待 t1 凭据/REST 模块交付）。`,
    {
      recovery:
        loadNote === ''
          ? '凭据模块尚未交付，请在 t1 完成后重试。'
          : `凭据模块加载失败：${loadNote}`,
      retryable: true,
    },
  );
}

/**
 * 从 t1 的 `getValidToken()` 返回里取出 token 字符串。
 *
 * ⚠️ 实测发现：t1 的 `getValidToken()` 返回的是
 * `{ token, credentials, refreshed }` **对象**，而契约写的是 `Promise<string>`。
 * t1 的设计更适合刷新场景（带回了刷新后的完整凭据），因此这里做兼容适配：
 * 字符串直接用，对象取 `.token`。这样两种形状都能工作，不必让 t1 返工。
 *
 * @param {unknown} value
 * @returns {string}
 */
function unwrapToken(value) {
  if (typeof value === 'string') {
    if (value === '') {
      throw new QwenAuthError(ErrorCode.CREDENTIALS_MISSING, '凭据中的 token 为空。', {
        recovery: '请重新登录千问办公桌面应用。',
      });
    }
    return value;
  }
  if (typeof value === 'object' && value !== null) {
    const token = /** @type {any} */ (value).token;
    if (typeof token === 'string' && token !== '') return token;
  }
  throw new QwenAuthError(
    ErrorCode.CREDENTIALS_MISSING,
    `凭据模块返回的 token 形态不符合预期（收到 ${typeof value}）。`,
    { recovery: '内部接口不匹配，请联系插件维护者。' },
  );
}

/**
 * 取得当前有效的 access token（含过期自动刷新），**始终返回字符串**。
 *
 * @param {object} [opts]
 * @returns {Promise<string>}
 */
export async function getValidToken(opts) {
  const loaded = await loadImplementation();
  if (loaded === null || typeof loaded.auth?.getValidToken !== 'function') {
    throw notWired('getValidToken()');
  }
  return unwrapToken(await loaded.auth.getValidToken(opts));
}

/**
 * 取得**刷新后的完整凭据对象**（签名场景专用）。
 *
 * 为什么需要它（而不是复用 `getValidToken()` 再单独读磁盘）：
 *
 * 阶段 A-2 的 WASM 签名除 token 外还要 `user.id` 与 `loginDeviceId`。
 * 早期实现直接 `loadCredentials()` 读磁盘，绕过了 t1 的刷新链路，存在
 * **两个真实缺陷**：
 *   1. token 已过期时拿到的是失效 token（签名请求会被 401/403 拒绝）；
 *   2. 与 t1 的 refresh-token 轮换回写（`persistRefreshedCredentials`）
 *      形成两套读取路径，可能双方持有不同代际的 refresh token。
 *
 * t1 的 `auth.getValidToken()` 恰好返回 `{ token, credentials, refreshed }`，
 * 其中 `credentials` 就是**刷新后已回写**的完整归一化凭据。因此这里直接
 * 把它透出去，让签名走与 REST 完全相同的凭据来源。
 *
 * 安全：返回值含 token / masterKey，**只允许在内存中传递**，
 * 不得序列化进日志、卡片响应或任何落盘文件。
 *
 * @param {object} [opts]
 * @returns {Promise<any>} 归一化凭据对象（含 token / user / loginDeviceId）
 */
export async function getValidCredential(opts) {
  const loaded = await loadImplementation();
  if (loaded === null || typeof loaded.auth?.getValidToken !== 'function') {
    throw notWired('getValidCredential()');
  }
  const raw = await loaded.auth.getValidToken(opts);

  // 兼容两种形态：t1 现返回 `{ token, credentials, refreshed }`；
  // 若未来退化为纯字符串，则退回磁盘读取（并保留 token 覆盖）。
  if (typeof raw === 'object' && raw !== null && typeof raw.credentials === 'object' && raw.credentials !== null) {
    return raw.credentials;
  }

  const token = unwrapToken(raw);
  const fallback = loaded.credentials?.loadCredentials;
  if (typeof fallback !== 'function') {
    throw notWired('loadCredentials()');
  }
  return { ...fallback(opts), token };
}

/**
 * 聚合账号上下文（user / plan / quota），形状与卡片后端约定一致。
 *
 * @param {object} [opts]
 * @returns {Promise<any>}
 */
export async function getAccountContext(opts) {
  const loaded = await loadImplementation();
  if (loaded === null) throw notWired('getAccountContext()');

  const token = await getValidToken(opts);
  if (typeof loaded.rest?.fetchAccountOverview !== 'function') {
    throw notWired('fetchAccountOverview()');
  }
  return loaded.rest.fetchAccountOverview(token, opts);
}

/**
 * 单点查询额度。
 *
 * t1 把额度归一化放在 `fetchAccountOverview` 的 `quota` 字段里；
 * `extractQuotaUsage` 是纯函数、需要一个已取的 payload，因此这里只做
 * 「取 token → 查概览 → 摘出 quota」，不额外发明第二次请求。
 *
 * @param {object} [opts]
 * @returns {Promise<{ remaining: number|null, total: number|null, used: number|null,
 *   exceeded: boolean|null, usedPercentage: number|null }>}
 */
export async function fetchQuota(opts) {
  const overview = await getAccountContext(opts);
  const quota = overview?.quota ?? {};
  return {
    remaining: quota.remaining ?? null,
    total: quota.total ?? null,
    used: quota.used ?? null,
    // account-context 不含该标志；降级路径的 usage 里有
    exceeded: overview?.usage?.isQuotaExceeded ?? null,
    usedPercentage: quota.usedPercentage ?? null,
  };
}

/**
 * 单点查询套餐。
 *
 * @param {object} [opts]
 * @returns {Promise<{ tierName: string|null, tier: string|null, isPersonal: boolean|null }>}
 */
export async function fetchPlan(opts) {
  const overview = await getAccountContext(opts);
  const plan = overview?.plan ?? {};
  return {
    tierName: plan.name ?? null,
    tier: plan.pid ?? null,
    isPersonal: plan.isPersonalVersion ?? null,
  };
}

/**
 * 该接缝当前是否已连上真实实现。供卡片显示接入状态。
 *
 * @returns {Promise<boolean>}
 */
export async function isWired() {
  const loaded = await loadImplementation();
  return loaded !== null && typeof loaded.auth?.getValidToken === 'function';
}

/** 供诊断使用：上次加载失败的原因（空串表示正常）。 */
export function loadDiagnostic() {
  return loadNote;
}
