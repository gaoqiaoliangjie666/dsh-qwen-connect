// t6 验收 7+8：provider 与三模型 + 积分真实性与双路径一致性
import fs from 'node:fs';

console.log('=== 7. provider 注册与三模型 ===');
const [idx, models] = await Promise.all([
  import('./lib/index.js'),
  import('./lib/models.js'),
]);
console.log('  provider 常量:', idx.QWENWORK_PROVIDER, '| name:', idx.name);
console.log('  models.js 导出:', Object.keys(models).join(', '));

const list = models.FALLBACK_QWENWORK_MODELS ?? models.QWENWORK_MODELS ?? [];
console.log(`  模型数: ${list.length}`);
for (const m of list) {
  console.log(`    ${String(m.id).padEnd(22)} name=${m.name}`);
  console.log(`      rate=${m.rate} ctx=${m.maxInputTokens} out=${m.maxOutputTokens} format=${m.format}`);
}

// 与 captain 给出的 rawModels 对照
const EXPECT = {
  pro: { name: '高级', rate: 1.00 },
  flash: { name: '标准｜Qwen3.8-Flash', rate: 0.10 },
  'qwen3.8-max-preview': { name: 'Qwen3.8-Max', rate: 1.10 },
};
console.log('\n  --- 与 App rawModels 对照 ---');
for (const [id, e] of Object.entries(EXPECT)) {
  const got = list.find((m) => m.id === id);
  if (!got) { console.log(`  ✖ ${id}: 缺失`); continue; }
  const nameOk = got.name === e.name;
  const rateOk = Math.abs((got.rate ?? -1) - e.rate) < 1e-9;
  console.log(`  ${nameOk && rateOk ? '✔' : '✖'} ${id}: name=${got.name}(${nameOk ? '一致' : '期望' + e.name}) rate=${got.rate}(${rateOk ? '一致' : '期望' + e.rate})`);
}

console.log('\n=== 8. 积分真实性与双路径一致性 ===');
const H = {
  'Authorization': `Bearer ${(await import('./lib/credentials.js')).loadCredentials().token}`,
  'User-Agent': 'qoderwork/1.0.5', 'X-QwenWork-Version': '1.0.5',
  'X-QwenWork-Release-Version': '1.0.5-26090806', 'X-QwenWork-Build': '26090806',
  'X-QwenWork-Platform': 'win32', 'X-QwenWork-Arch': 'x64',
  'X-QwenWork-Channel': 'stable', 'Accept': 'application/json',
};
const B = 'https://gateway.qwenwork.cn';
const { ENDPOINTS, apiGet, extractAccountContext } = await import('./lib/rest.js');
const seam = await import('./lib/credentials-seam.js');

// 双路径 1：裸 fetch（绕开模块）
const raw1 = await (await fetch(B + '/api/v1/adapter/user/account-context?include=user,plan,quota,page,data_sharing', { headers: H })).json();
// 双路径 2：模块解析
const viaMod = extractAccountContext(await apiGet(ENDPOINTS.accountContext, H.Authorization.slice(7)));
// 双路径 3：接缝（卡片实际用）
const viaSeam = await seam.getAccountContext();
console.log('  裸 fetch    remaining =', raw1.data?.quota?.remaining);
console.log('  模块解析    remaining =', viaMod.quota.remaining);
console.log('  接缝(卡片)  remaining =', viaSeam?.quota?.remaining);
console.log('  三者一致:', raw1.data?.quota?.remaining === viaMod.quota.remaining && viaMod.quota.remaining === viaSeam?.quota?.remaining);
console.log('  total/used =', viaSeam?.quota?.total, '/', viaSeam?.quota?.used, '(须为 null，不得编造为 0)');

// 时间变化性
await new Promise((r) => setTimeout(r, 2500));
const raw2 = await (await fetch(B + '/api/v1/adapter/user/account-context?include=user,plan,quota,page,data_sharing', { headers: H })).json();
console.log('  2.5s 后再次裸取 =', raw2.data?.quota?.remaining);
console.log('  数值随时间变化(非硬编码):', raw1.data?.quota?.remaining !== raw2.data?.quota?.remaining || '相同(仅说明此刻未消耗)');
