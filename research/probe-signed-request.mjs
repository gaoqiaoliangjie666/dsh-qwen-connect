// 端到端测试：用真实凭据 + 官方 WASM 生成签名，请求真实端点
// 绝不打印凭据本身，只打印状态码 / 响应片段 / signing 结果的非敏感部分。
import path from 'node:path';
import { initFromFile, QoderContext, generate_runtime_auth_fields } from './qoder-wasm-glue.mjs';
import { loadAuth } from './creds.mjs';

const WASM = path.join(import.meta.dirname, 'wasm', 'inline_26762.wasm');
const COSY_VERSION = '1.1.32';
const GATEWAY = 'https://gateway.qwenwork.cn';

// uE() 的等价实现（QwenWork 集成模式：client_type=6, business_product=qoder_work）
const CLIENT_METADATA = {
  client_type: '6',
  business_product: 'qoder_work',
  business_type: 'agent',
  scene: 'assistant',
};

function mask(s) { return s ? `${String(s).slice(0, 4)}...(${String(s).length})` : '(none)'; }

console.log('=== 1. initWasm ===');
const exp = initFromFile(WASM);
console.log('instantiated OK; memory', exp.memory.buffer.byteLength / 65536, 'pages');

console.log('\n=== 2. 读取真实凭据 ===');
const auth = loadAuth();
console.log('token:', mask(auth.token));
console.log('fields:', Object.keys(auth).join(', '));
const ui = auth.user || {};
console.log('user keys:', Object.keys(ui).join(', '));
console.log('uid:', mask(ui.uid));
console.log('loginDeviceId:', mask(auth.loginDeviceId));

// machineId：Windows 上取 MachineGuid
import { execFileSync } from 'node:child_process';
let machineId = 'unknown';
try {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    '(Get-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Cryptography").MachineGuid'], { encoding: 'utf8' });
  machineId = out.trim();
} catch (e) { console.log('machineId read failed:', e.message); }
console.log('machineId:', mask(machineId));

console.log('\n=== 3. generate_runtime_auth_fields ===');
// 复刻 regenerateRuntimeFields()
// 注意：auth-v2.dat 的用户主键字段是 user.id，WASM 期望的键名是 uid
const UID = ui.uid ?? ui.id ?? '';
const runtimeInput = JSON.stringify({
  uid: UID,
  organization_id: ui.organization_id ?? ui.orgId ?? '',
  organization_tags: ui.organization_tags ?? ui.orgTags ?? '',
  data_policy_agreed: '',
});
let runtimeFields;
try {
  runtimeFields = JSON.parse(generate_runtime_auth_fields(runtimeInput));
  console.log('encrypt_user_info:', mask(runtimeFields.encrypt_user_info));
  console.log('key:', mask(runtimeFields.key));
} catch (e) {
  console.log('generate_runtime_auth_fields THREW:', e.message);
  process.exit(1);
}

console.log('\n=== 4. 构造 QoderContext（完整真实配方）===');
const userInfoForAuth = {
  uid: UID,
  encrypt_user_info: runtimeFields.encrypt_user_info,
  key: runtimeFields.key,
  organization_id: '',
  organization_tags: [],
  data_policy_agreed: false,
};
const ctx = new QoderContext(machineId, COSY_VERSION, JSON.stringify(userInfoForAuth), JSON.stringify(CLIENT_METADATA));
console.log('QoderContext created, ptr =', ctx.__wbg_ptr);

console.log('\n=== 5. prepareInferRequest（签名端点 /api/v2/model/list）===');
async function signedGet(endpoint, p) {
  const r = ctx.prepareInferRequest(endpoint, p, undefined, undefined);
  const out = { url: r.url, headers: r.headers, body: r.body };
  r.free();
  return out;
}

try {
  const signed = await signedGet(GATEWAY, '/api/v2/model/list');
  console.log('url =', signed.url);
  console.log('headers =', JSON.stringify(signed.headers, null, 2));
  console.log('body =', signed.body);

  console.log('\n=== 6. 发起真实请求 ===');
  const res = await fetch(signed.url, {
    method: 'GET',
    headers: { ...signed.headers, Authorization: `Bearer ${auth.token}` },
  });
  const text = await res.text();
  console.log('HTTP', res.status, res.statusText);
  console.log('body (first 600):', text.slice(0, 600));
} catch (e) {
  console.log('prepareInferRequest/fetch THREW:', e.constructor.name, e.message);
}
