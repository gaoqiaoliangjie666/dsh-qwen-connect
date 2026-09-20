// 测试 1：在 Node 中实例化 WASM，验证显存/QoderContext 构造/prepareInferRequest 调用链
// 不涉及任何凭据，先用假参数探测签名与实际行为。
import path from 'node:path';
import { initFromFile, QoderContext, wasmExports } from './qoder-wasm-glue.mjs';

const WASM = path.join(import.meta.dirname, 'wasm', 'inline_26762.wasm');

console.log('=== step 1: initSync ===');
let exp;
try {
  exp = initFromFile(WASM);
  console.log('OK - instantiated');
} catch (err) {
  console.log('FAIL:', err.constructor.name, err.message);
  if (err.message.includes('import')) console.log('hint: missing import ->', err.message);
  process.exit(1);
}

console.log('exports count:', Object.keys(exp).filter(k => typeof exp[k] === 'function').length);
console.log('memory pages:', exp.memory.buffer.byteLength / 65536);
console.log('has qodercontext_new:', typeof exp.qodercontext_new);
console.log('has prepareInferRequest:', typeof exp.qodercontext_prepareInferRequest);

console.log('\n=== step 2: 调用各顶层导出（无参，观察行为）===');
const nullary = ['get_httpdns_account_id', 'get_httpdns_config', 'get_httpdns_secret_key', 'get_profile_key_fingerprint'];
for (const fn of nullary) {
  try {
    const r = exp[fn]();
    console.log(`  ${fn}() ->`, typeof r === 'object' ? JSON.stringify(r) : String(r).slice(0, 120));
  } catch (e) {
    console.log(`  ${fn}() THREW ${e.constructor.name}: ${String(e.message).slice(0, 200)}`);
  }
}

console.log('\n=== step 3: 构造 QoderContext ===');
// 参数顺序（来自 glue）：machineId, cosyVersion, userInfoJson, 第4个 JSON(来自 uE())
const variants = [
  ['machineId-v1', '1.0.5', '{}', '{}'],
  ['', '', '', ''],
];
for (const args of variants) {
  try {
    const ctx = new QoderContext(...args);
    console.log(`  QoderContext(${JSON.stringify(args).slice(0, 60)}) -> ptr=${ctx.__wbg_ptr}`);
    try {
      const r = ctx.prepareInferRequest('{}', '{}', undefined, undefined);
      console.log('    prepareInferRequest OK:');
      console.log('      url =', JSON.stringify(r.url));
      console.log('      headers =', JSON.stringify(r.headers));
      console.log('      body =', JSON.stringify(r.body));
      console.log('      headerCount =', r.headerCount);
      r.free();
    } catch (e) {
      console.log('    prepareInferRequest THREW:', e.constructor.name, String(e.message).slice(0, 400));
    }
    ctx.free();
  } catch (e) {
    console.log(`  QoderContext(${JSON.stringify(args).slice(0, 60)}) THREW ${e.constructor.name}: ${String(e.message).slice(0, 400)}`);
  }
}
