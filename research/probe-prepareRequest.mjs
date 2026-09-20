// 对比 prepareRequest 与 prepareInferRequest 在推理端点上的差异
import path from 'node:path';
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
const machineId = execFileSync('powershell.exe', ['-NoProfile', '-Command',
  '(Get-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Cryptography").MachineGuid'], { encoding: 'utf8' }).trim();

const rf = JSON.parse(generate_runtime_auth_fields(JSON.stringify({
  uid: UID, organization_id: '', organization_tags: [], data_policy_agreed: false,
})));
const ctx = new QoderContext(machineId, COSY_VERSION, JSON.stringify({
  uid: UID, encrypt_user_info: rf.encrypt_user_info, key: rf.key,
  organization_id: '', organization_tags: [], data_policy_agreed: false,
}), JSON.stringify(CLIENT_METADATA));

const bodyJson = JSON.stringify({ request_id: 'r1', session_id: 's1', model_config: { key: 'pro', source: 'system' } });

const INFER = '/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common';
const ENDPOINTS_SIGN = '/api/v3/service/region/endpoints';

console.log('===== A) prepareRequest on /api/v3/service/region/endpoints (mode=sign) =====');
for (const mode of ['sign', 'auth', 'infer']) {
  try {
    const r = ctx.prepareRequest(GATEWAY, ENDPOINTS_SIGN, 'GET', mode, undefined, undefined);
    console.log(`\n[mode=${mode}] url=${r.url}`);
    console.log(`  headers=${JSON.stringify(r.headers, null, 2)}`);
    console.log(`  body=${r.body}`);
    r.free();
  } catch (e) { console.log(`[mode=${mode}] THREW: ${String(e.message).slice(0, 200)}`); }
}

console.log('\n\n===== B) prepareRequest on infer path =====');
for (const mode of ['sign', 'auth', 'infer', 'post']) {
  try {
    const r = ctx.prepareRequest(GATEWAY, INFER, 'POST', mode, bodyJson, JSON.stringify({ 'Content-Type': 'application/json' }));
    console.log(`\n[mode=${mode}] url=${r.url}`);
    console.log(`  headers=${JSON.stringify(r.headers, null, 2)}`);
    console.log(`  body(200)=${(r.body || '').slice(0, 200)}`);
    r.free();
  } catch (e) { console.log(`[mode=${mode}] THREW: ${String(e.message).slice(0, 200)}`); }
}

console.log('\n\n===== C) prepareInferRequest 变体 =====');
for (const extra of [
  ['"pro"', '"system"'],
  ['{"key":"pro","source":"system"}', undefined],
  [JSON.stringify({ 'Content-Type': 'application/json' }), undefined],
]) {
  try {
    const r = ctx.prepareInferRequest(GATEWAY, bodyJson, extra[0], extra[1]);
    console.log(`\n[args=${JSON.stringify(extra).slice(0, 80)}]`);
    console.log(`  url=${r.url}`);
    console.log(`  headers=${JSON.stringify(r.headers)}`);
    r.free();
  } catch (e) { console.log(`[args=${JSON.stringify(extra).slice(0, 80)}] THREW: ${String(e.message).slice(0, 200)}`); }
}
