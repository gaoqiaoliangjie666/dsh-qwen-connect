// research/probes-2026-09-14/check-detect-dsh.mjs
// 验证多形态探测：列出本机所有 DSH 形态与默认目标。
import { candidateRoots, detectProfiles, pickDefaultTarget, describeTarget } from '../../tools/detect-dsh.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

console.log('=== 候选根目录 ===');
for (const r of candidateRoots()) {
  console.log(`  ${r.label.padEnd(24)} ${r.root}`);
}

console.log('\n=== 探测到的可用 profile ===');
const all = detectProfiles();
if (all.length === 0) {
  console.log('  （无）');
} else {
  for (const t of all) console.log(`  ${describeTarget(t)}`);
}

console.log('\n=== 默认安装目标（已装插件优先）===');
const pick = pickDefaultTarget('dsh-qwen-connect');
console.log(`  ${pick ? describeTarget(pick) : '（未找到）'}`);

console.log('\n=== 探测逻辑自检 ===');
let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '[OK]' : '[FAIL]'} ${label}${detail ? ' - ' + detail : ''}`);
  if (!ok) fail++;
};
check('候选根目录非空', candidateRoots().length > 0, `${candidateRoots().length} 个`);
check('每个候选都有 label/root/profilesDir', candidateRoots().every((r) => r.label && r.root && r.profilesDir));
check('探测到至少一个 profile', all.length > 0, `${all.length} 个`);
check('默认目标已解析', pick !== null);
if (pick) {
  // 默认目标必须是「真的装了本插件」或「插件最多的那个」——前者用于升级，
  // 后者用于首装。这里验证它确实是已装插件的那一个（升级优先）。
  const manifest = JSON.parse(
    readFileSync(join(pick.profile.dir, 'package.json'), 'utf8').replace(/^\uFEFF/, ''),
  );
  const installed = Boolean(manifest?.dependencies?.['dsh-qwen-connect']);
  check('默认目标是已装本插件的 profile（升级优先）', installed);
}

console.log(fail === 0 ? '\n[OK] 探测逻辑全部通过' : `\n[FAIL] ${fail} 项失败`);
process.exit(fail > 0 ? 1 : 0);
