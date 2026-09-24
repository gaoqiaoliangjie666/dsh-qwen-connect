/**
 * 全部验证一键跑。
 *
 * 用法：node tools/verify-all.mjs
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const STEPS = [
  // 用无参 `node --test`（队长指定的统一命令）。
  // ⚠️ 这依赖一条命名约定：`research/` 下的探针脚本一律用 `probe-*` / `diag-*` /
  // `find-*` 前缀，**不得用 `test-*`** —— 否则会被无参 --test 当测试自动执行，
  // 而这些探针会发起真实 API 调用并消耗账号积分。下方 guard 会拦住这类回退。
  { name: '全量单元测试', args: ['--test'] },
  { name: 'client.js 模块加载契约', args: ['tools/client-load-check.mjs'] },
  { name: 'host 入口可加载性', args: ['tools/host-load-check.mjs'] },
  { name: 'provider 注册行为契约', args: ['tools/apply-check.mjs'] },
  { name: '接缝失败诊断（无静默降级）', args: ['tools/seam-failure-check.mjs'] },
  { name: '阶段 A 验收骨架（契约，用桩件）', args: ['tools/phase-a-acceptance.mjs'] },
  { name: '接缝端到端实测（真实 API）', args: ['tools/seam-live-check.mjs'] },
  // 安全扫描：两条判据互补，缺一不可
  //   ① 值匹配：源文件里出现完整真实值
  //   ② 输出上下文：敏感变量未经脱敏即流向 console/logger
  //      —— 能抓到 `String(mid).slice(0,8)` 这类运行期切片，
  //         而①对它是盲的（源文件里没有那个字面量）
  { name: 'PII 扫描（完整值匹配）', args: ['research/check-leaks-all.mjs'] },
  { name: '敏感输出扫描（脱敏检查）', args: ['research/check-sensitive-output.mjs'] },
  // 编码体检：本机 PowerShell 的 Get-Content/Set-Content 默认按 GBK 处理，
  // 曾多次不可逆地破坏 UTF-8 文件（emoji 变 鉁?、中文变 娣蜂贡）。
  // 这类损坏会让文件语法报错或含义错乱，必须在提交前拦下。
  { name: '编码体检（BOM / 乱码）', args: ['research/probes-2026-09-14/check-encoding.mjs'] },
  // 便携包验证：确保 dist 自包含（可拷到别的电脑直接安装）
  { name: '便携包端到端（新机可搬运性）', args: ['research/probes-2026-09-14/check-portable-package.mjs'] },
  // DSH 多形态探测：安装器能识别 Desktop / CLI / 自定义 DSH_HOME
  { name: 'DSH 形态探测', args: ['research/probes-2026-09-14/check-detect-dsh.mjs'] },
  // 便携性因素：不得残留开发机专属路径；凭据/平台假设逐项核对
  { name: '便携性因素核对', args: ['research/probes-2026-09-14/check-portability-factors.mjs'] },
  { name: '平台假设核查', args: ['research/probes-2026-09-14/check-platform-assumptions.mjs'] },
  // 上游契约漂移检测：比对当前千问 SDK 的协议字段与插件硬编码规格是否一致。
  // 纯静态、不发网络请求；未装 App 时自动跳过（退出 0），不会阻塞本机验证。
  // 用途：App 升级后第一时间发现「协议变了」，而不是等用户发现对话不可用
  // （2026-09-24 的 1.0.6→1.2.0 故障即因缺 business 字段导致恒定 503）。
  { name: '上游契约漂移检测（静态）', args: ['tools/check-upstream-contract.mjs'] },
];

let failed = 0;

// ---- 护栏：research/ 下不得出现 test-*.mjs ----------------------------------
// 无参 `node --test` 会把它们当测试自动执行，而 research/ 下的探针会发起
// 真实 API 调用、消耗账号积分并依赖网络。这条约定一旦回退，验证会悄悄变慢、
// 变贵且不稳定，因此在这里显式拦下。
{
  const offenders = [];
  const walk = (dir) => {
    let items;
    try {
      items = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of items) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        walk(p);
      } else if (/^test-.*\.mjs$/.test(e.name) && p.includes(`${sep}research${sep}`)) {
        offenders.push(relative(root, p));
      }
    }
  };
  walk(join(root, 'research'));
  if (offenders.length > 0) {
    process.stdout.write(
      `\n✖ 命名约定违规：research/ 下不应有 test-*.mjs（会被无参 --test 当测试执行并真实消耗积分）：\n`
      + offenders.map((f) => `    ${f}`).join('\n')
      + '\n  请改用 probe-* 前缀。\n',
    );
    failed += 1;
  }
}

for (const step of STEPS) {
  process.stdout.write(`\n${'='.repeat(60)}\n▶ ${step.name}\n${'='.repeat(60)}\n`);
  const result = spawnSync(process.execPath, step.args, {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    failed += 1;
    process.stdout.write(`✖ 失败: ${step.name} (exit ${result.status})\n`);
  }
}

process.stdout.write(`\n${'='.repeat(60)}\n`);
if (failed === 0) {
  process.stdout.write('✅ 全部验证通过。\n');
} else {
  process.stdout.write(`❌ ${failed} 项验证失败。\n`);
}
process.exit(failed === 0 ? 0 : 1);
