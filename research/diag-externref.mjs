// 检查 wasm 的 __wbindgen_export* 语义
import path from 'node:path';
import { initFromFile } from './qoder-wasm-glue.mjs';

const exp = initFromFile(path.join(import.meta.dirname, 'wasm', 'inline_26762.wasm'));

console.log('=== __wbindgen_export* 探测 ===');
for (const name of ['__wbindgen_export', '__wbindgen_export2', '__wbindgen_export3', '__wbindgen_export4', '__wbindgen_add_to_stack_pointer']) {
  const fn = exp[name];
  console.log(`${name}:`, typeof fn, 'arity=', fn ? fn.length : 'n/a');
}

// __wbindgen_export2(1,1) -> 应该是 alloc(len, align)
console.log('\nalloc(64,1) =', exp.__wbindgen_export2(64, 1));
console.log('alloc(64,1) =', exp.__wbindgen_export2(64, 1));

// 试探 export3 的语义
try { console.log('export3(0,0,0,0) =', exp.__wbindgen_export3(0, 0, 0, 0)); } catch (e) { console.log('export3 threw:', e.message); }

// 用一个小测试：让 wasm 返回 headers 后，尝试各种方式取回
import { QoderContext, generate_runtime_auth_fields } from './qoder-wasm-glue.mjs';
import { loadAuth } from './creds.mjs';

// machineId 一律动态获取，禁止硬编码真实值。
// 优先环境变量 QWEN_MACHINE_ID，其次从本机凭据读取，最后回退到合成值（不泄漏真实账号数据）。
function resolveMachineId() {
  if (process.env.QWEN_MACHINE_ID) return process.env.QWEN_MACHINE_ID;
  try {
    const a = loadAuth();
    if (a?.loginDeviceId) return a.loginDeviceId;
  } catch { /* 本机无凭据时回退到合成值 */ }
  return '11111111-2222-4333-8444-555555555555';
}
const mid = resolveMachineId();
const rf = JSON.parse(generate_runtime_auth_fields(JSON.stringify({ uid: 'x', organization_id: '', organization_tags: [], data_policy_agreed: false })));
const ctx = new QoderContext(mid, '1.1.32', JSON.stringify({
  uid: 'x', encrypt_user_info: rf.encrypt_user_info, key: rf.key,
  organization_id: '', organization_tags: [], data_policy_agreed: false,
}), '{}');
const r = ctx.prepareInferRequest('https://gateway.qwenwork.cn', '{"a":1}', undefined, undefined);
const idx = exp.requestresult_headers(r.__wbg_ptr);
console.log('\nheaders heap idx =', idx, '(u32:', idx >>> 0, ')');
console.log('headerCount =', r.headerCount);
// 尝试 export3 = getObjectFromWasm?
try { console.log('export3(idx) =', exp.__wbindgen_export3(idx)); } catch (e) { console.log('export3(idx) threw:', e.message); }
r.free();
