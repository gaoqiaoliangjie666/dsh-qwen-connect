// 直接读取 requestresult_headers 的原始返回值，绕过有问题的 glue 解码
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { initFromFile, QoderContext, generate_runtime_auth_fields, wasmExports } from './qoder-wasm-glue.mjs';
import { loadAuth } from './creds.mjs';

const WASM = path.join(import.meta.dirname, 'wasm', 'inline_26762.wasm');
const exp = initFromFile(WASM);
const auth = loadAuth();
const ui = auth.user || {};
const UID = ui.uid ?? ui.id ?? '';
const mid = auth.loginDeviceId;

const rf = JSON.parse(generate_runtime_auth_fields(JSON.stringify({
  uid: UID, organization_id: '', organization_tags: [], data_policy_agreed: false,
})));
const ctx = new QoderContext(mid, '1.1.32', JSON.stringify({
  uid: UID, encrypt_user_info: rf.encrypt_user_info, key: rf.key,
  organization_id: '', organization_tags: [], data_policy_agreed: false,
}), JSON.stringify({ client_type: '6', business_product: 'qoder_work', business_type: 'agent', scene: 'assistant' }));

const bodyJson = JSON.stringify({ request_id: 'r1', session_id: 's1', model_config: { key: 'pro', source: 'system' } });
const r = ctx.prepareInferRequest('https://gateway.qwenwork.cn', bodyJson, 'pro', 'system');

console.log('ptr =', r.__wbg_ptr);
console.log('headerCount =', r.headerCount);

// 直接调用 raw export
const sp = exp.__wbindgen_add_to_stack_pointer(-16);
console.log('retptr =', sp);
const h = exp.requestresult_headers(r.__wbg_ptr);
console.log('requestresult_headers raw return =', h, typeof h);

// wasm-bindgen 通常用 __wbindgen_export2 返回堆索引
const dv = new DataView(exp.memory.buffer);
console.log('heap idx decode:', h >>> 0);

// 尝试用 wasm 的 memory 找 header 字符串（20 个头，应在 string 区）
// 先直接尝试读 url/body 验证 glue 正常
console.log('\nurl  =', r.url);
console.log('body =', r.body);
console.log('headerCount again =', r.headerCount);

// 用 __wbindgen_export3 (getStringFromWasm) 之类？先看 wasm 内存里的 header 关键字
const mem = new Uint8Array(exp.memory.buffer);
const text = Buffer.from(mem).toString('latin1');
for (const key of ['Cosy-', 'Authorization', 'x-qoder', 'X-Qoder', 'content-type', 'Content-Type', 'signature', 'Signature']) {
  const idx = text.indexOf(key);
  console.log(`  mem contains "${key}":`, idx >= 0 ? `@${idx}` : 'no');
}

// 扫描内存里所有 "xxx-yyy" 形态的 header 名
const found = new Set();
const re = /[A-Za-z][A-Za-z0-9-]{4,40}:/g;
let m;
while ((m = re.exec(text)) !== null && found.size < 60) {
  const s = m[0].slice(0, -1);
  if (/^(Cosy|X-|Qoder|Content|Accept|Authorization|User-Agent)/i.test(s)) found.add(s);
}
console.log('\npossible header names in wasm memory:', [...found].join(', '));

r.free();
