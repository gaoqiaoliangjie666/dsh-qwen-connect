// 探明 agent_chat_generation 的 body 结构，跑通一次真实对话
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

function sign(bodyJson, modelKey, modelSource) {
  const r = ctx.prepareInferRequest(GATEWAY, bodyJson, modelKey, modelSource);
  const headers = {};
  r.headers.forEach((v, k) => { headers[k] = v; });
  const out = { url: r.url, headers, body: r.body };
  r.free();
  return out;
}

async function call(label, bodyObj, modelKey = 'pro', modelSource = 'system') {
  const s = sign(JSON.stringify(bodyObj), modelKey, modelSource);
  try {
    const res = await fetch(s.url, { method: 'POST', headers: s.headers, body: s.body });
    const text = await res.text();
    console.log(`\n--- ${label} -> HTTP ${res.status} ${res.statusText} (ct=${res.headers.get('content-type')})`);
    console.log(text.slice(0, 900));
    return { status: res.status, text };
  } catch (e) {
    console.log(`\n--- ${label} THREW: ${e.message}`);
  }
}

const base = () => ({ request_id: crypto.randomUUID(), session_id: 'sess-' + Date.now() });

// 尝试多种 body 结构
await call('A: model_config + messages(顶层)', { ...base(), model_config: { key: 'pro', source: 'system' }, messages: [{ role: 'user', content: '你好' }] });
await call('B: model_config + messages(content 数组)', { ...base(), model_config: { key: 'pro', source: 'system' }, messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }] });
await call('C: model + messages', { ...base(), model: 'pro', messages: [{ role: 'user', content: '你好' }] });
await call('D: model_config + chat/messages', { ...base(), model_config: { key: 'pro', source: 'system' }, chat: { messages: [{ role: 'user', content: '你好' }] } });
