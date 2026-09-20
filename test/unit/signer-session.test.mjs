/**
 * 签名会话测试：验证会话构造、签名产物形状、以及**不泄漏凭据**。
 *
 * 需要 wasm.bin 就位；缺失时整体跳过（不让没有产物文件的环境误报失败）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WASM_BIN = path.join(HERE, '..', '..', 'research', 'wasm.bin');
const HAS_WASM = fs.existsSync(WASM_BIN);

const { createSignerSession, buildInferBody, CLIENT_METADATA, INFER_PATH, DEFAULT_ENDPOINT, randomId } =
  await import('../../lib/signer-session.js');

/** 合成凭据（绝不使用真实值）。 */
const FAKE_CREDENTIAL = {
  token: 'fake-token-for-unit-test',
  loginDeviceId: '11111111-2222-4333-8444-555555555555',
  user: { id: '00000000-0000-4000-8000-000000000001' },
};

test('buildInferBody: messages 位于顶层，且带 model_config', () => {
  const body = JSON.parse(buildInferBody({ messages: [{ role: 'user', content: 'hi' }], modelKey: 'flash' }));
  assert.ok(Array.isArray(body.messages), 'messages 必须在顶层');
  assert.equal(body.model_config.key, 'flash');
  assert.equal(body.model_config.source, 'system');
  assert.ok(typeof body.request_id === 'string' && body.request_id !== '');
  assert.ok(typeof body.session_id === 'string' && body.session_id !== '');
});

test('buildInferBody: 显式 sessionId 被沿用（多轮关联的前提）', () => {
  const body = JSON.parse(buildInferBody({ messages: [], sessionId: 'sess-fixed' }));
  assert.equal(body.session_id, 'sess-fixed');
});

test('buildInferBody: 不带 chat 嵌套（上游会 400）', () => {
  const body = JSON.parse(buildInferBody({ messages: [{ role: 'user', content: 'hi' }] }));
  assert.equal(body.chat, undefined, '嵌套 chat.messages 会被上游拒绝');
});

test('CLIENT_METADATA: 复刻 SDK 的 uE()（QwenWork 集成模式）', () => {
  assert.equal(CLIENT_METADATA.client_type, '6');
  assert.equal(CLIENT_METADATA.business_product, 'qoder_work');
  assert.equal(CLIENT_METADATA.business_type, 'agent');
  assert.equal(CLIENT_METADATA.scene, 'assistant');
});

test('INFER_PATH 指向真实的推理端点', () => {
  assert.match(INFER_PATH, /agent_chat_generation/);
  assert.match(INFER_PATH, /AgentId=agent_common/);
});

test('randomId 产出非空且唯一', () => {
  const ids = new Set(Array.from({ length: 50 }, () => randomId()));
  assert.equal(ids.size, 50);
});

test('createSignerSession: 缺凭据对象时抛出可诊断错误', async () => {
  await assert.rejects(() => createSignerSession({ credential: null }), (error) => {
    assert.equal(typeof error.code, 'string');
    assert.ok(error.message.length > 0);
    return true;
  });
});

test('createSignerSession: 缺 machineId 时明确失败，不静默继续', async (t) => {
  if (!HAS_WASM) return t.skip('wasm.bin 未就位');
  await assert.rejects(
    () =>
      createSignerSession({
        credential: { token: 'x', user: { id: 'u' } }, // 无 loginDeviceId
        identity: { env: {} },
      }),
    (error) => {
      assert.match(error.message, /machineId/);
      assert.match(error.recovery ?? '', /QWEN_MACHINE_ID/, '必须给出补救路径');
      return true;
    },
  );
});

test('createSignerSession: 真实签名产出 URL/headers/加密 body', async (t) => {
  if (!HAS_WASM) return t.skip('wasm.bin 未就位');

  const session = await createSignerSession({
    credential: FAKE_CREDENTIAL,
    identity: { env: {} },
  });
  try {
    const signed = session.signInferRequest(
      buildInferBody({ messages: [{ role: 'user', content: 'hi' }] }),
      { modelKey: 'pro' },
    );

    // URL 由 WASM 硬编码产出（含 /algo 前缀与 Encode=1）
    assert.match(signed.url, /^https:\/\/gateway\.qwenwork\.cn\/algo\//);
    assert.match(signed.url, /agent_chat_generation/);
    assert.match(signed.url, /Encode=1/);

    // 签名头是 COSY 形态，不是裸 Bearer token
    assert.ok(signed.headers.Authorization?.startsWith('Bearer COSY.'), 'Authorization 必须是 COSY 签名');
    assert.ok(!signed.headers.Authorization.includes(FAKE_CREDENTIAL.token), '绝不能把 access token 当签名');

    // 关键签名头齐备
    for (const name of ['Cosy-Key', 'Cosy-Date', 'Cosy-MachineId', 'Cosy-User', 'Cosy-Version', 'Cosy-ClientType']) {
      assert.ok(signed.headers[name] !== undefined, `缺少签名头 ${name}`);
    }

    // body 必须是被加密的密文，而不是明文 JSON
    assert.ok(typeof signed.body === 'string' && signed.body.length > 0);
    assert.ok(!signed.body.includes('"messages"'), 'body 不应是明文 JSON');

    assert.ok(signed.headerCount >= 15, `签名头数量异常: ${signed.headerCount}`);
  } finally {
    session.dispose();
  }
});

test('createSignerSession.describe(): 不含 token / key / encrypt_user_info', async (t) => {
  if (!HAS_WASM) return t.skip('wasm.bin 未就位');
  const session = await createSignerSession({ credential: FAKE_CREDENTIAL, identity: { env: {} } });
  try {
    const d = session.describe();
    const text = JSON.stringify(d);
    for (const needle of ['fake-token-for-unit-test', 'encrypt_user_info', '"key"', '11111111-2222-4333-8444-555555555555']) {
      assert.ok(!text.includes(needle), `describe() 泄漏了 ${needle}`);
    }
    assert.equal(d.endpoint, DEFAULT_ENDPOINT);
    assert.equal(typeof d.cosyVersion.source, 'string');
    assert.equal(d.uidPresent, true);
  } finally {
    session.dispose();
  }
});

test('createSignerSession: 不同 message 产生不同 body 密文', async (t) => {
  if (!HAS_WASM) return t.skip('wasm.bin 未就位');
  const session = await createSignerSession({ credential: FAKE_CREDENTIAL, identity: { env: {} } });
  try {
    const a = session.signInferRequest(buildInferBody({ messages: [{ role: 'user', content: 'AAA' }], sessionId: 's1' }));
    const b = session.signInferRequest(buildInferBody({ messages: [{ role: 'user', content: 'BBB' }], sessionId: 's1' }));
    assert.notEqual(a.body, b.body, '不同输入必须产出不同密文');
  } finally {
    session.dispose();
  }
});
