// 追踪 headers getter 的堆表交互
import path from 'node:path';
import { initFromFile, QoderContext, generate_runtime_auth_fields } from './qoder-wasm-glue.mjs';

const exp = initFromFile(path.join(import.meta.dirname, 'wasm', 'inline_26762.wasm'));
const rf = JSON.parse(generate_runtime_auth_fields(JSON.stringify({ uid: 'x', organization_id: '', organization_tags: [], data_policy_agreed: false })));
const ctx = new QoderContext('mid-test', '1.1.32', JSON.stringify({
  uid: 'x', encrypt_user_info: rf.encrypt_user_info, key: rf.key,
  organization_id: '', organization_tags: [], data_policy_agreed: false,
}), '{}');
const r = ctx.prepareInferRequest('https://gateway.qwenwork.cn', '{"a":1}', undefined, undefined);

console.log('headerCount =', r.headerCount);
const rawIdx = exp.requestresult_headers(r.__wbg_ptr);
console.log('raw heap idx =', rawIdx >>> 0);
console.log('typeof =', typeof rawIdx);

// 直接读该索引处的值 —— 但 Zq 是模块私有的，改用代理：
// 重新调用一次并观察 headers getter 是否抛异常
try {
  const h = r.headers;
  console.log('r.headers =', h, '| ctor:', h && h.constructor && h.constructor.name, '| isMap:', h instanceof Map);
  if (h instanceof Map) console.log('entries:', JSON.stringify([...h.entries()]));
  else if (h && typeof h.forEach === 'function') { const o = {}; h.forEach((v, k) => o[k] = v); console.log('forEach:', JSON.stringify(o)); }
  else if (h && typeof h === 'object') console.log('keys:', Object.keys(h), '| json:', JSON.stringify(h));
} catch (e) {
  console.log('r.headers THREW:', e.constructor.name, e.message);
}
r.free();
