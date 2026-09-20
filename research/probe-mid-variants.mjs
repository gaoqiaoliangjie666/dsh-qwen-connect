// 系统性排查：不同 machineId / userInfo 组合下，prepareInferRequest 是否产出签名头
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
const winGuid = execFileSync('powershell.exe', ['-NoProfile', '-Command',
  '(Get-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Cryptography").MachineGuid'], { encoding: 'utf8' }).trim();

const bodyJson = JSON.stringify({ request_id: 'r1', session_id: 's1', model_config: { key: 'pro', source: 'system' } });
const INFER = '/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common';

function build(machineId, orgId, orgTags, dpa) {
  const rf = JSON.parse(generate_runtime_auth_fields(JSON.stringify({
    uid: UID, organization_id: orgId, organization_tags: orgTags, data_policy_agreed: dpa,
  })));
  return new QoderContext(machineId, COSY_VERSION, JSON.stringify({
    uid: UID, encrypt_user_info: rf.encrypt_user_info, key: rf.key,
    organization_id: orgId, organization_tags: orgTags, data_policy_agreed: dpa,
  }), JSON.stringify(CLIENT_METADATA));
}

const cases = [
  ['winGuid + empty org', winGuid, '', [], false],
  ['loginDeviceId + empty org', auth.loginDeviceId, '', [], false],
  ['loginDeviceId + orgId', auth.loginDeviceId, ui.orgId ?? '', [], false],
];

for (const [label, mid, org, tags, dpa] of cases) {
  // 不输出 machineId 任何片段（含前缀）——只报来源与长度，避免 PII 泄漏
  console.log(`\n===== ${label} (machineId 来源=${label.split(' ')[0]} len=${String(mid).length}) =====`);
  try {
    const ctx = build(mid, org, tags, dpa);
    for (const fn of ['prepareInferRequest', 'prepareRequest']) {
      try {
        const r = fn === 'prepareInferRequest'
          ? ctx.prepareInferRequest(GATEWAY, bodyJson, 'pro', 'system')
          : ctx.prepareRequest(GATEWAY, INFER, 'POST', 'auth', bodyJson, undefined);
        console.log(`  ${fn}: url=${r.url?.slice(0, 120)}`);
        console.log(`    headers=${JSON.stringify(r.headers)} (count=${r.headerCount})`);
        if (r.body) console.log(`    body.len=${String(r.body).length}`);
        r.free();
      } catch (e) { console.log(`  ${fn} THREW: ${String(e.message).slice(0, 200)}`); }
    }
    ctx.free();
  } catch (e) {
    console.log(`  build THREW: ${String(e.message).slice(0, 200)}`);
  }
}

// 检查 wasm 其他可能与 header 相关的导出
console.log('\n=== 其他导出探测 ===');
const exp = initFromFile(WASM);
console.log(Object.keys(exp).filter(k => !k.startsWith('__')).join(', '));
console.log('\nmemory pages after:', exp.memory.buffer.byteLength / 65536);
