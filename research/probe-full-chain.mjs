// 完整复刻 App 推理链：ner() 的 WASM 签名 + Mo() 的 Cosy-* 头
// 目标：让服务端接受请求
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
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
let machineId = 'unknown';
try {
  machineId = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    '(Get-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Cryptography").MachineGuid'], { encoding: 'utf8' }).trim();
} catch { }
const hostname = os.hostname();

const rf = JSON.parse(generate_runtime_auth_fields(JSON.stringify({
  uid: UID, organization_id: '', organization_tags: [], data_policy_agreed: false,
})));
const ctx = new QoderContext(machineId, COSY_VERSION, JSON.stringify({
  uid: UID, encrypt_user_info: rf.encrypt_user_info, key: rf.key,
  organization_id: '', organization_tags: [], data_policy_agreed: false,
}), JSON.stringify(CLIENT_METADATA));

// ---- 构造 App 真实形态的 remoteChatAsk body ----
const requestId = crypto.randomUUID ? crypto.randomUUID() : 'unknown';
const bodyObj = {
  request_id: requestId,
  session_id: 'sess-' + Date.now(),
  model_config: { key: 'pro', source: 'system' },
  stream: true,
  messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
};
const bodyJson = JSON.stringify(bodyObj);

// ner(endpoint, bodyJson, modelKey, modelSource)
const r = ctx.prepareInferRequest(GATEWAY, bodyJson, 'pro', 'system');
const signed = { url: r.url, headers: r.headers, body: r.body };
r.free();

console.log('signed url =', signed.url);
console.log('wasm headers =', JSON.stringify(signed.headers));
console.log('encrypted body (first 120) =', signed.body.slice(0, 120));

// ---- 复刻 Mo() 注入的 Cosy-* 头 ----
const headers = {
  ...signed.headers,
  'Cosy-Version': COSY_VERSION,
  'Cosy-ClientType': CLIENT_METADATA.client_type,
  'Cosy-MachineOS': 'windows',
  'Cosy-MachineHostname': hostname,
  Authorization: `Bearer ${auth.token}`,
  'Content-Type': 'application/json',
  Accept: 'text/event-stream',
  'User-Agent': 'qoderwork/1.0.5',
};

console.log('\nfinal headers =', JSON.stringify(headers, null, 2));

console.log('\n===== 真实 POST =====');
try {
  const res = await fetch(signed.url, { method: 'POST', headers, body: signed.body });
  console.log('HTTP', res.status, res.statusText);
  console.log('content-type:', res.headers.get('content-type'));
  const text = await res.text();
  console.log('body (first 800):');
  console.log(text.slice(0, 800));
} catch (e) {
  console.log('THREW:', e.constructor.name, e.message);
}
