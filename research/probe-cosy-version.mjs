// 关键验证：Cosy-Version 到底该用什么值？
// 假设：obf 是共享 SDK，其 COSY_VERSION 与 QwenWork App 版本号不是一个域。
import { initFromFile, QoderContext, generate_runtime_auth_fields } from './qoder-wasm-glue.mjs';
import { loadCredentials } from '../lib/credentials.js';
import path from 'node:path';

const exp = initFromFile(path.join(import.meta.dirname, 'wasm', 'inline_26762.wasm'));
const cred = loadCredentials();
const user = cred.user ?? {};
const uid = user.id ?? '';

const rf = JSON.parse(generate_runtime_auth_fields(JSON.stringify({
  uid, organization_id: '', organization_tags: [], data_policy_agreed: false,
})));

function makeCtx(cosyVersion) {
  return new QoderContext(cred.loginDeviceId, cosyVersion, JSON.stringify({
    uid, encrypt_user_info: rf.encrypt_user_info, key: rf.key,
    organization_id: '', organization_tags: [], data_policy_agreed: false,
  }), JSON.stringify({ client_type: '6', business_product: 'qoder_work', business_type: 'agent', scene: 'assistant' }));
}

async function test(cosyVersion, label) {
  try {
    const ctx = makeCtx(cosyVersion);
    const body = JSON.stringify({
      request_id: crypto.randomUUID(), session_id: 'sess-' + Date.now(),
      model_config: { key: 'pro', source: 'system' },
      messages: [{ role: 'user', content: 'say ok' }],
    });
    const r = ctx.prepareInferRequest('https://gateway.qwenwork.cn', body, 'pro', 'system');
    const headers = {};
    r.headers.forEach((v, k) => { headers[k] = v; });
    const signed = { url: r.url, headers, body: r.body };
    r.free();

    const res = await fetch(signed.url, { method: 'POST', headers: signed.headers, body: signed.body });
    const text = await res.text();
    const ok = res.status === 200 && text.includes('"statusCodeValue\":200');
    console.log(`[${label}] Cosy-Version=${cosyVersion} -> HTTP ${res.status} ${ok ? '✅ 接受' : '❌ 拒绝'}`);
    if (!ok) console.log('   响应:', text.slice(0, 200));
    return res.status;
  } catch (e) {
    console.log(`[${label}] Cosy-Version=${cosyVersion} -> THREW ${e.message.slice(0, 120)}`);
    return -1;
  }
}

// 对比：App 版本域 vs SDK 的 Cosy 版本域
await test('1.0.5', 'App 安装版本');
await test('1.1.32', '阶段A-1 实测值');
