/**
 * 上游契约漂移检测：千问办公 App 升级后，SDK 的聊天协议是否变了？
 *
 * 为什么需要它
 * ────────────
 * 本插件依赖对**闭源混淆 SDK**（`@qoder-ai/qoder-agent-sdk` 的
 * `qoder-worker-runtime.obf.mjs`）的逆向结果。App 每次升级，这个文件都会重新打包，
 * 协议字段可能增删（2026-09-24 的 1.0.6 → 1.2.0 就因**缺 `business`** 导致恒定
 * 503 `Model catalog unavailable`，排查数小时）。
 *
 * 本脚本把插件硬编码的契约做成**断言**，去当前 SDK 里逐项比对：
 *   - 全部命中 → 协议未漂移，插件应当仍可用
 *   - 有漂移项 → 打印差异摘要，提示需要按 docs/App升级后失效排查手册.md 处理
 *
 * 设计取舍
 * ────────
 * - **只做静态比对，不发任何网络请求**：可随时跑，不消耗账号积分。
 *   真实可用性请另跑 `tools/seam-live-check.mjs`。
 * - **用「搜索锚点 + 期望值」而非硬编码偏移**：混淆会重排偏移，
 *   锚点（如 `return{request_id:s,`）在换版后仍可定位。
 * - SDK 缺失（未装 App）时**不报失败**，而是退出码 0 + 明确提示
 *   —— 插件本身支持无 App 时的降级路径，本检测不该成为那里的阻塞。
 *
 * 用法：
 *   node tools/check-upstream-contract.mjs
 *   node tools/check-upstream-contract.mjs --sdk "<obf 路径>"   # 指定别的版本比对
 *
 * 退出码：0 = 无漂移（或 SDK 缺失）；1 = 检测到漂移（需处理）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');

// ---------------------------------------------------------------------------
// SDK 定位
// ---------------------------------------------------------------------------

/** 候选安装根目录（与 lib/runtime-identity.js 的探测顺序保持一致）。 */
function installRootCandidates() {
  const out = [];
  const env = process.env;
  if (typeof env.QWEN_INSTALL_ROOT === 'string' && env.QWEN_INSTALL_ROOT.trim() !== '') {
    out.push(env.QWEN_INSTALL_ROOT.trim());
  }
  // 通用枚举 D–Z 盘（用户可能装在任意盘的非标准目录）
  for (let c = 'D'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
    out.push(`${String.fromCharCode(c)}:\\software\\Qwen\\QwenWorkCN`);
    out.push(`${String.fromCharCode(c)}:\\Qwen\\QwenWorkCN`);
  }
  if (typeof env.LOCALAPPDATA === 'string') out.push(path.join(env.LOCALAPPDATA, 'Programs', 'QwenWorkCN'));
  return out;
}

/** obf 在版本化子目录内的相对路径。 */
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

/** 版本号形如 `1.2.3`（用于挑最新版本子目录）。 */
function asVersion(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value.trim());
  return m === null ? null : { text: m[0], key: [Number(m[1]), Number(m[2]), Number(m[3])] };
}

/** 找 root 下版本号最大的 `<version>-<build>` 子目录。 */
function newestVersionedDir(root) {
  let best = null;
  let names;
  try {
    names = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const ent of names) {
    if (!ent.isDirectory()) continue;
    const v = asVersion(ent.name.split('-')[0]);
    if (v === null) continue;
    // 注意：best 必须带上 key —— 比较分支要用它，只存 dir/version 会在这里炸
    // （本脚本首版就踩过：`best.key` 未定义 → TypeError）。
    if (best === null || v.key[0] > best.key[0]
      || (v.key[0] === best.key[0] && v.key[1] > best.key[1])
      || (v.key[0] === best.key[0] && v.key[1] === best.key[1] && v.key[2] > best.key[2])) {
      best = { dir: path.join(root, ent.name), version: v.text, key: v.key };
    }
  }
  return best;
}

/**
 * 定位当前生效的 obf（版本 + 路径）。
 * @returns {{ obfPath: string, version: string | null, root: string } | null}
 */
function resolveSdk() {
  const explicit = process.argv.indexOf('--sdk');
  if (explicit >= 0 && process.argv[explicit + 1] !== undefined) {
    const p = process.argv[explicit + 1];
    if (!fs.existsSync(p)) {
      console.error(`✖ --sdk 指定的文件不存在：${p}`);
      process.exit(2);
    }
    return { obfPath: p, version: null, root: path.dirname(p) };
  }
  for (const root of installRootCandidates()) {
    if (!fs.existsSync(root)) continue;
    const versioned = newestVersionedDir(root);
    const dirs = versioned === null ? [root] : [versioned.dir, root];
    for (const dir of dirs) {
      const obfPath = path.join(dir, OBF_RELATIVE);
      if (fs.existsSync(obfPath)) {
        return { obfPath, version: versioned === null ? null : versioned.version, root };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 契约断言：锚点 + 期望
// ---------------------------------------------------------------------------

/**
 * 每项断言的形态：
 *   id      稳定的标识（报告里引用）
 *   why     为什么这条重要（漂移时的后果）
 *   check(src) → { ok, detail }
 *
 * ⚠️ 新增断言时请用「锚点 + 期望」的写法，**不要**写死 obf 偏移 ——
 * 混淆每次打包都会重排偏移，写死会让检测在下次升级时静默失效。
 */
const CONTRACTS = [
  {
    id: 'body-ctor',
    why: '聊天请求体构造函数；它的顶层键集合就是发行契约',
    check(src) {
      const anchor = 'return{request_id:s,';
      const at = src.indexOf(anchor);
      if (at < 0) return { ok: false, detail: `未找到 body 构造锚点 ${anchor}` };
      // 取到该 return 对象结束（下一个 `}function` 之前）
      const tail = src.slice(at, at + 4000);
      const end = tail.indexOf('}function');
      const body = end < 0 ? tail : tail.slice(0, end);
      const keys = [...body.matchAll(/(?:^|[,{])([a-z_][a-z0-9_]*)\s*:/gi)].map((m) => m[1]);
      const uniq = [...new Set(keys)];
      // ⚠️ 报告口径：这里统计的是**对象字面量里的全部键**，含 4 个条件展开
      // （custom_context / source_session_id / patches / business），
      // 所以 1.2.0 下会得到 25 而非规格里的「21 个固定键」。
      // 该断言只保证「构造函数仍可定位、键集合可枚举」，**不判定具体键增删** ——
      // 键级差异请对照 对话/2026-09-24-千问1.2.0适配/recon-body-spec.md。
      const conditional = ['custom_context', 'source_session_id', 'patches', 'business']
        .filter((k) => uniq.includes(k));
      return {
        ok: true,
        detail: `键 ${uniq.length} 个（含 ${conditional.length} 个条件展开：${conditional.join(', ') || '无'}）`
          + `；1.2.0 规格为 21 固定键 + 4 条件展开。全部键：${uniq.join(', ')}`,
        keys: uniq,
      };
    },
  },
  {
    id: 'body-business',
    why: '缺 business → 恒定 503 Model catalog unavailable（2026-09-24 的真凶）',
    check(src) {
      const at = src.indexOf('return{request_id:s,');
      if (at < 0) return { ok: false, detail: '未找到 body 构造锚点，无法检查 business' };
      const body = src.slice(at, at + 4000);
      // SDK 里 business 是条件展开：...void 0!==m?{business:m}:{}
      const hasConditional = /\{business:\s*m\}/.test(body);
      return {
        ok: true,
        detail: hasConditional
          ? '存在条件展开 {business:m}（SDK 形态未变）；注意服务端要求该键必须存在且含 product'
          : '⚠️ 未见到 {business:m} 条件展开，SDK 可能已改变 business 的构造方式',
      };
    },
  },
  {
    id: 'body-tools',
    why: 'tools 必须恒为数组（不得省略键），否则偏离上游契约',
    check(src) {
      const at = src.indexOf('return{request_id:s,');
      if (at < 0) return { ok: false, detail: '未找到 body 构造锚点' };
      const body = src.slice(at, at + 4000);
      const m = /tools:\s*([^,}]+)/.exec(body);
      if (m === null) return { ok: false, detail: '⚠️ body 内未见 tools 字段' };
      const expr = m[1].trim();
      const isArrayFallback = /\?\?\s*\[\]/.test(expr);
      return {
        ok: true,
        detail: `tools: ${expr}${isArrayFallback ? '（形如 o?.tools??[]，符合预期）' : '（⚠️ 未见 ??[] 兜底，请核对是否允许省略该键）'}`,
      };
    },
  },
  {
    id: 'runtime-auth-fields',
    why: '签名载荷必须含 security_oauth_token，否则 Authorization 退化为 429 字符残缺签名',
    check(src) {
      // ⚠️ `regenerateRuntimeFields` 在 obf 里出现 19 次（多为调用点），
      // 定义体只是其中一处。**必须靠「同时含 generate_runtime_auth_fields」来锁定定义体**，
      // 否则会误取到调用点、抓不到载荷（本脚本首版就因此漏报了载荷键）。
      const DEF_ANCHOR = 'regenerateRuntimeFields(){if(!this.cachedUserInfo)return;';
      let at = src.indexOf(DEF_ANCHOR);
      let how = '定义体精确锚点';
      if (at < 0) {
        // 退路：找同时含 generate_runtime_auth_fields 的最近一处
        const call = src.indexOf('generate_runtime_auth_fields');
        at = call < 0 ? -1 : src.lastIndexOf('regenerateRuntimeFields', call);
        how = '退路（generate_runtime_auth_fields 反查）';
      }
      if (at < 0) {
        return { ok: false, detail: '未找到 regenerateRuntimeFields 定义体（SDK 结构已变，需重新逆向签名载荷）' };
      }
      const tail = src.slice(at, at + 900);
      const hasToken = tail.includes('security_oauth_token');
      // 提取载荷键（锚定 JSON.stringify({uid:
      let payloadKeys = [];
      const pm = /JSON\.stringify\(\{uid:/.exec(tail);
      if (pm !== null) {
        const obj = tail.slice(pm.index);
        const end = obj.indexOf('})');
        const seg = end < 0 ? obj : obj.slice(0, end);
        payloadKeys = [...new Set([...seg.matchAll(/(?:^|[,{(])([a-z_][a-z0-9_]*)\s*:/gi)].map((m) => m[1]))];
      }
      const detail = hasToken
        ? `载荷含 security_oauth_token（定位方式：${how}）`
          + (payloadKeys.length > 0 ? `；载荷键 ${payloadKeys.length} 个：${payloadKeys.join(', ')}` : '')
        : `⚠️ 载荷中未见 security_oauth_token（定位方式：${how}）`
          + (payloadKeys.length > 0 ? `；当前载荷键：${payloadKeys.join(', ')}` : '');
      return { ok: hasToken, detail };
    },
  },
  {
    id: 'kpe-products',
    why: 'business.product 的合法取值集合；dg() 分支只改 product、type 恒为 agent',
    check(src) {
      // kpe() 里用到三个 product 常量与两个 type 常量
      const probes = ['"cli"', '"ide"', '"qoder_work"', '"agent"', '"quest"'];
      const missing = probes.filter((p) => !src.includes(p));
      return {
        ok: missing.length === 0,
        detail: missing.length === 0
          ? `product 取值 ${probes.slice(0, 3).join(' / ')}、type 取值 ${probes.slice(3).join(' / ')} 均存在`
          : `⚠️ 以下常量未找到：${missing.join(', ')}（business 取值语义可能已变）`,
      };
    },
  },
  {
    id: 'cosy-version',
    why: 'Cosy-Version 由 SDK 的 COSY_VERSION 常量提供（插件运行时自动读取，无需改代码）',
    check(src) {
      const has = src.includes('COSY_VERSION');
      return {
        ok: has,
        detail: has ? '存在 COSY_VERSION 常量（插件会自动读取最新值）' : '⚠️ 未见 COSY_VERSION，插件将回退到内置常量',
      };
    },
  },
  {
    id: 'endpoint-path',
    why: '推理端点路径；签名 URL 由 WASM 产出，此处仅确认 SDK 侧仍在使用同一路径',
    check(src) {
      const p = '/algo/api/v2/service/pro/sse/agent_chat_generation';
      return {
        ok: src.includes(p),
        detail: src.includes(p) ? `仍引用 ${p}` : `⚠️ 未见 ${p}（端点可能已迁移）`,
      };
    },
  },
  {
    id: 'fetchkeys-absent',
    why: '1.2.0 起 SDK 不再使用 URL 参数 FetchKeys=llm_model_result（插件侧的该参数由自带 WASM 产出）',
    check(src) {
      const n = src.split('llm_model_result').length - 1;
      return {
        ok: n === 0,
        detail: n === 0
          ? 'SDK 内无 llm_model_result（与 1.2.0 已知形态一致）'
          : `⚠️ SDK 内出现 llm_model_result ${n} 次（形态变化，需复核插件自带 WASM 产出的 URL）`,
      };
    },
  },
];

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const say = (s = '') => process.stdout.write(`${s}\n`);

say('上游契约漂移检测（静态比对，不发网络请求）');
say('='.repeat(60));

const sdk = resolveSdk();
if (sdk === null) {
  say('未找到千问办公 SDK（App 可能未安装或装在非标准目录）。');
  say('这不影响插件运行（有降级路径），本次不做漂移判定。');
  say('如需检测，可用 --sdk "<qoder-worker-runtime.obf.mjs 路径>" 显式指定。');
  process.exit(0);
}

const size = fs.statSync(sdk.obfPath).size;
say(`SDK 版本 : ${sdk.version ?? '(未知/未版本化)'}`);
say(`obf 路径 : ${sdk.obfPath}`);
say(`obf 大小 : ${size} 字节`);
say(`插件版本 : ${JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8')).version}`);
say('');

const src = fs.readFileSync(sdk.obfPath, 'utf8');

let drifted = 0;
for (const c of CONTRACTS) {
  const r = c.check(src);
  const mark = r.ok ? '✅' : '❌';
  if (!r.ok) drifted++;
  say(`${mark} [${c.id}]`);
  say(`     判定：${r.detail}`);
  say(`     意义：${c.why}`);
}

say('');
say('='.repeat(60));
if (drifted === 0) {
  say('✅ 未检测到契约漂移。插件应仍可用（真实可用性请另跑 tools/seam-live-check.mjs）。');
  process.exit(0);
}

say(`❌ 检测到 ${drifted} 项契约漂移。请按以下顺序处理：`);
say('   1) 读 docs/App升级后失效排查手册.md（含判据分层表：403=签名层 /');
say('      400=字段存在性 / 503=缺 business）');
say('   2) 参考 对话/2026-09-24-千问1.2.0适配/ 下的规格文件核对字段取值');
say('   3) 改完 lib/ 后重跑 tools/package-plugin.mjs，并完全重启 DSH Desktop');
process.exit(1);
