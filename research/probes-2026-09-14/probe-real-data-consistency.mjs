// research/probes-2026-09-14/probe-real-data-consistency.mjs
// 验证「host 真实产出」与「client 渲染假设」是否一致——两端契约脱节是白屏高发区。
import { qwenWorkWebStatus } from '../../lib/web-status.js';
import { getAccountContext } from '../../lib/credentials-seam.js';
import { catalogForCard } from '../../lib/models.js';
import { isWired } from '../../lib/credentials-seam.js';

const status = await qwenWorkWebStatus({
  getAccountContext: async () => getAccountContext(),
  tokenAvailable: isWired,
  models: catalogForCard,
  provider: 'qwenwork',
});

let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) fail++;
};

console.log('=== 1) host 实际产出的字段 ===');
console.log('  ' + JSON.stringify(status, null, 2).split('\n').join('\n  '));

console.log('\n=== 2) client 渲染依赖的字段是否都存在 ===');
// client.js 会读到这些字段；缺一个就必须有 graceful 退化（不能崩）
const required = ['status', 'provider'];
const optional = ['nickname', 'account', 'tierName', 'remaining', 'entitlements', 'models', 'error'];
for (const k of required) check(`必需字段 ${k}`, status[k] !== undefined);
for (const k of optional) console.log(`  ℹ️  可选字段 ${k}: ${status[k] === undefined ? '缺失（client 需容错）' : '存在'}`);

console.log('\n=== 3) entitlements 的结构契约 ===');
if (Array.isArray(status.entitlements)) {
  for (const e of status.entitlements) {
    const okShape = e !== null && typeof e === 'object' && typeof e.key === 'string' && e.key !== '';
    check(`条目 ${e?.key ?? '(无 key)'} 结构合法`, okShape, JSON.stringify(e));
    if (e.size !== undefined) check(`  ${e.key}.size 是数字`, typeof e.size === 'number');
    if (e.remain !== undefined) check(`  ${e.key}.remain 是数字`, typeof e.remain === 'number');
  }
} else {
  console.log('  ℹ️  无 entitlements（未登录时正常）');
}

console.log('\n=== 4) models 的结构契约（client 读 id/name/rate/标记）===');
for (const m of status.models ?? []) {
  check(`${m.id} 有 name`, typeof m.name === 'string' && m.name !== '');
  check(`${m.id} 有 rate`, typeof m.rate === 'number');
  // 卡片用「短名」+ 独立 rate 列——倍率刻意不重复出现在 name 里
  // （选择器则相反：displayName() 会把倍率拼进 name，两处职责不同）
  check(`${m.id} 卡片名为短名（倍率走 rate 列）`, !/x\d+\.\d{2}/.test(m.name), m.name);
  check(`${m.id} description 含倍率`, /x\d+\.\d{2}/.test(m.description ?? ''), m.description);
}

console.log('\n=== 5) 数值合理性（防止荒谬值进入 UI）===');
if (typeof status.remaining === 'number') {
  check('remaining 非负', status.remaining >= 0, String(status.remaining));
  check('remaining 有限', Number.isFinite(status.remaining));
}
for (const e of status.entitlements ?? []) {
  if (typeof e.size === 'number') check(`${e.key}.size > 0`, e.size > 0, String(e.size));
  if (typeof e.remain === 'number' && typeof e.size === 'number') {
    check(`${e.key}.remain ≤ size`, e.remain <= e.size, `${e.remain}/${e.size}`);
  }
}

console.log('\n=== 6) 凭据不得出现在 host 产出里 ===');
const json = JSON.stringify(status);
for (const needle of ['eyJ', 'COSY', 'Bearer', 'refreshToken', 'accessToken', '1c0ec6c9', '733ef972']) {
  check(`不含 ${needle}`, !json.includes(needle));
}
// account 字段是设计上要展示的（登录标识），但不应是完整 UUID
if (typeof status.account === 'string' && /^[0-9a-f-]{36}$/.test(status.account)) {
  check('account 不是完整 UUID', false, status.account);
} else {
  check('account 非完整 UUID', true, status.account ?? '(无)');
}

console.log(fail === 0 ? '\n✅ host/client 契约一致' : `\n❌ ${fail} 项不一致`);
process.exit(fail > 0 ? 1 : 0);
