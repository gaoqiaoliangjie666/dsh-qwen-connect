// 【最终验证】用官方 WASM 生成的完整签名头发起真实推理请求
import path from 'node:path';
import { initFromFile, QoderContext, generate_runtime_auth_fields } from './qoder-wasm-glue.mjs';
import { loadAuth } from './creds.mjs';

const WASM = path.join(import.meta.dirname, 'wasm', 'inline_26762.wasm');
const COSY_VERSION = '1.1.32';
const GATEWAY = 'https://gateway.qwenwork.cn';
const CLIENT_METADATA = { client_type: '6', business_product: 'qoder_work', business_type: 'agent', scene: 'assistant' };

initFromFile(WASM);
const auth = loadAuth();
const ui = auth.user || {};
const UID = ui.uid ?? ui.id ?? '';

const rf = JSON.parse(generate_runtime_auth_fields(JSON.stringify({
  uid: UID, organization_id: '', organization_tags: [], data_policy_agreed: false,
})));
const ctx = new QoderContext(auth.loginDeviceId, COSY_VERSION, JSON.stringify({
  uid: UID, encrypt_user_info: rf.encrypt_user_info, key: rf.key,
  organization_id: '', organization_tags: [], data_policy_agreed: false,
}), JSON.stringify(CLIENT_METADATA));

// App 的 ner(endpoint, bodyJson, modelKey, modelSource)
const bodyJson = JSON.stringify({
  request_id: crypto.randomUUID(),
  session_id: 'sess-' + Date.now(),
  model_config: { key: 'pro', source: 'system' },
});
const r = ctx.prepareInferRequest(GATEWAY, bodyJson, 'pro', 'system');

const headers = {};
r.headers.forEach((v, k) => { headers[k] = v; });
const signed = { url: r.url, headers, body: r.body };
r.free();

console.log('=== 签名产物 ===');
console.log('url =', signed.url);
console.log('headers count =', Object.keys(signed.headers).length);
for (const [k, v] of Object.entries(signed.headers)) {
  console.log(`  ${k}: ${String(v).length > 90 ? String(v).slice(0, 90) + '...' : v}`);
}
console.log('body len =', signed.body.length);

console.log('\n=== 真实 POST agent_chat_generation ===');
try {
  const res = await fetch(signed.url, {
    method: 'POST',
    headers: signed.headers,
    body: signed.body,
  });
  console.log('HTTP', res.status, res.statusText);
  console.log('content-type:', res.headers.get('content-type'));
  const text = await res.text();
  console.log('响应片段 (first 1200):');
  console.log(text.slice(0, 1200));
} catch (e) {
  console.log('THREW:', e.constructor.name, e.message);
}
