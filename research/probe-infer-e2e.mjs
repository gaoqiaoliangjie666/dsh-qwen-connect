// 端到端：用官方 WASM 签名，真正发起 agent_chat_generation SSE 请求
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { initFromFile, QoderContext, generate_runtime_auth_fields } from './qoder-wasm-glue.mjs';
import { loadAuth } from './creds.mjs';

const WASM = path.join(import.meta.dirname, 'wasm', 'inline_26762.wasm');
const COSY_VERSION = '1.1.32';
const GATEWAY = 'https://gateway.qwenwork.cn';
const INFER_PATH = '/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common';
const CLIENT_METADATA = { client_type: '6', business_product: 'qoder_work', business_type: 'agent', scene: 'assistant' };

initFromFile(WASM);
const auth = loadAuth();
const ui = auth.user || {};
const UID = ui.uid ?? ui.id ?? '';
let machineId = 'unknown';
try {
  machineId = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    '(Get-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Cryptography").MachineGuid'], { encoding: 'utf8' }).trim();
} catch { /* ignore */ }

const rf = JSON.parse(generate_runtime_auth_fields(JSON.stringify({
  uid: UID, organization_id: '', organization_tags: [], data_policy_agreed: false,
})));

const ctx = new QoderContext(machineId, COSY_VERSION, JSON.stringify({
  uid: UID,
  encrypt_user_info: rf.encrypt_user_info,
  key: rf.key,
  organization_id: '',
  organization_tags: [],
  data_policy_agreed: false,
}), JSON.stringify(CLIENT_METADATA));

// 探查 prepareInferRequest 的各参数语义：
// 调用方 ner(A,e,t,i,n) => prepareInferRequest(A=endpoint, e=body, t=?, i=?)
// 用不同组合观察输出
const body = JSON.stringify({
  model: 'pro',
  messages: [{ role: 'user', content: 'hi' }],
  stream: true,
});

const combos = [
  { label: 's1 (endpoint, body)', args: [GATEWAY, body, undefined, undefined] },
  { label: 's2 (endpoint, body, {})', args: [GATEWAY, body, '{}', undefined] },
  { label: 's3 (endpoint, body, {}, {})', args: [GATEWAY, body, '{}', '{}'] },
  { label: 's4 (endpoint, body, "auth", undefined)', args: [GATEWAY, body, 'auth', undefined] },
  { label: 's5 (endpoint, body, "", "")', args: [GATEWAY, body, '', ''] },
];

for (const c of combos) {
  console.log(`\n===== ${c.label} =====`);
  try {
    const r = ctx.prepareInferRequest(...c.args);
    const url = r.url, headers = r.headers, b = r.body;
    r.free();
    console.log('url    =', url);
    console.log('headers=', JSON.stringify(headers));
    console.log('body   =', typeof b === 'string' ? b.slice(0, 200) : b);
  } catch (e) {
    console.log('THREW:', e.constructor.name, String(e.message).slice(0, 300));
  }
}

// 真实 POST
console.log('\n\n===== 真实 POST agent_chat_generation =====');
const r = ctx.prepareInferRequest(GATEWAY, body, undefined, undefined);
const signed = { url: r.url, headers: r.headers, body: r.body };
r.free();
console.log('signed url:', signed.url);

for (const method of ['POST', 'GET']) {
  try {
    const res = await fetch(signed.url, {
      method,
      headers: {
        ...signed.headers,
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      ...(method === 'POST' ? { body: signed.body } : {}),
    });
    const text = await res.text();
    console.log(`\n[${method}] HTTP ${res.status} ${res.statusText}`);
    console.log('  content-type:', res.headers.get('content-type'));
    console.log('  body(0..500):', text.slice(0, 500));
  } catch (e) {
    console.log(`\n[${method}] THREW:`, e.message);
  }
}
