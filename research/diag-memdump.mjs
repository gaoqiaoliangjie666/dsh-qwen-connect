// 直接从 WASM 内存 dump 出 requestresult 的 headers 表
// 思路：requestresult_headers 返回堆索引(1030)；该索引指向一个 JS Map/对象，
// 由 wasm 通过 exports.__wbindgen_export3(?) 注册。我们改为直接调用 wasm 内部
// requestresult_headers 后跟踪它的返回，并用 __wbindgen_export2 语义还原。
import path from 'node:path';
import { initFromFile, QoderContext, generate_runtime_auth_fields } from './qoder-wasm-glue.mjs';
import { loadAuth } from './creds.mjs';

const WASM = path.join(import.meta.dirname, 'wasm', 'inline_26762.wasm');
const exp = initFromFile(WASM);
const auth = loadAuth();
const ui = auth.user || {};
const UID = ui.uid ?? ui.id ?? '';

const rf = JSON.parse(generate_runtime_auth_fields(JSON.stringify({
  uid: UID, organization_id: '', organization_tags: [], data_policy_agreed: false,
})));
const ctx = new QoderContext(auth.loginDeviceId, '1.1.32', JSON.stringify({
  uid: UID, encrypt_user_info: rf.encrypt_user_info, key: rf.key,
  organization_id: '', organization_tags: [], data_policy_agreed: false,
}), JSON.stringify({ client_type: '6', business_product: 'qoder_work', business_type: 'agent', scene: 'assistant' }));

const r = ctx.prepareInferRequest('https://gateway.qwenwork.cn',
  JSON.stringify({ request_id: 'r1', session_id: 's1', model_config: { key: 'pro', source: 'system' } }), 'pro', 'system');

// 直接 dump wasm 内存里 headers 字符串区的上下文
const mem = new Uint8Array(exp.memory.buffer);
function readCStr(off, max = 400) {
  let end = off;
  while (end < mem.length && mem[end] !== 0 && end - off < max) end++;
  return Buffer.from(mem.subarray(off, end)).toString('utf8');
}
function readAt(off, len) { return Buffer.from(mem.subarray(off, off + len)).toString('utf8'); }

console.log('=== Cosy- 区域 context @1064725 ===');
console.log(readCStr(1064500, 900));
console.log('\n=== Signature 区域 @1064643 ===');
console.log(readCStr(1064560, 500));
console.log('\n=== Authorization 区域 @1066462 ===');
console.log(readCStr(1066400, 300));
