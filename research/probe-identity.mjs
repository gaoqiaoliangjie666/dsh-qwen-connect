// 快速验证 runtime-identity 探测结果
import { resolveCosyVersion, resolveMachineId, describeMachineId, resolveRuntimeIdentity } from '../lib/runtime-identity.js';
import { loadCredentials } from '../lib/credentials.js';

console.log('=== Cosy-Version 解析 ===');
console.log(JSON.stringify(resolveCosyVersion(), null, 2));

console.log('\n=== machineId 解析（带真实凭据）===');
let cred = null;
try { cred = loadCredentials(); } catch (e) { console.log('凭据加载失败:', e.code ?? e.message); }
console.log(JSON.stringify(describeMachineId({ credential: cred }), null, 2));

console.log('\n=== 无凭据时的回退 ===');
console.log(JSON.stringify(describeMachineId({ credential: null }), null, 2));

console.log('\n=== 汇总 ===');
console.log(JSON.stringify(resolveRuntimeIdentity({ credential: cred }), null, 2));
