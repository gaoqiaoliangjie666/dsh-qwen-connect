// test/unit/adapter-apikey.test.mjs
//
// 回归护栏：resolveApiKey 绝不能返回 null。
//
// 背景（真实故障）：
//   本插件把 pi-ai 的 apiKey 用作「shim 共享密钥」。早期实现是
//   `resolveApiKey: async () => shimSharedSecret`，而 shim 是异步启动的，
//   于是 pi-ai 可能在就绪前拿到 null。
//
//   dsh-llm-pi-ai 的 profileOptions() 只对 `undefined` 省略 apiKey：
//       ...apiKey === void 0 ? {} : { apiKey }
//   `null` 会被原样传给 SDK → 请求不带 Authorization 头 → shim 返回 401
//   → DSH 逐个模型重试后报 **"All models failed"**。
//
// 本测试锁定两条不变量：
//   1. 未就绪时 resolveApiKey 必须「等待」而不是返回 null
//   2. 确实起不来时必须抛错（原因可见），而不是退化成无密钥请求
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createQwenWorkAdapter } from '../../lib/index.js';

/** 取出 adapter 内部的 resolveApiKey（构造参数被 PiAiAdapter 保存）。 */
function resolveApiKeyOf(adapter) {
  // PiAiAdapter 把配置挂在 config 上；不同版本字段名可能不同，逐一尝试。
  const cfg = adapter.config ?? adapter.options ?? adapter._config;
  assert.ok(cfg !== undefined, 'adapter 应暴露配置对象');
  assert.equal(typeof cfg.resolveApiKey, 'function', 'adapter 必须配置 resolveApiKey');
  return cfg.resolveApiKey;
}

test('resolveApiKey：shim 未就绪时必须等待，绝不返回 null', async () => {
  let released = false;
  // 模拟：一开始拿不到密钥，短暂延迟后才就绪
  const getSecret = async () => {
    if (!released) {
      await new Promise((r) => setTimeout(r, 30));
      released = true;
      return 'secret-after-wait';
    }
    return 'secret-after-wait';
  };

  const { adapter } = createQwenWorkAdapter(() => 'http://127.0.0.1:1/v1', getSecret);
  const resolveApiKey = resolveApiKeyOf(adapter);

  const key = await resolveApiKey('qwenwork', undefined);
  assert.equal(key, 'secret-after-wait');
  assert.notEqual(key, null, '绝不能返回 null —— 那会让请求丢掉鉴权头');
});

test('resolveApiKey：同步返回 null 时必须抛错，而非把 null 交给 pi-ai', async () => {
  const { adapter } = createQwenWorkAdapter(
    () => 'http://127.0.0.1:1/v1',
    () => null, // 永远拿不到
  );
  const resolveApiKey = resolveApiKeyOf(adapter);

  await assert.rejects(
    () => resolveApiKey('qwenwork', undefined),
    /shim is not ready|shared secret/i,
    '拿不到密钥时必须是明确错误，而不是静默返回 null',
  );
});

test('resolveApiKey：空串同样视为未就绪', async () => {
  const { adapter } = createQwenWorkAdapter(
    () => 'http://127.0.0.1:1/v1',
    () => '',
  );
  const resolveApiKey = resolveApiKeyOf(adapter);
  await assert.rejects(() => resolveApiKey('qwenwork', undefined), /shim is not ready/i);
});

test('resolveApiKey：已就绪时直接返回，不做多余等待', async () => {
  const { adapter } = createQwenWorkAdapter(
    () => 'http://127.0.0.1:1/v1',
    async () => 'ready-secret',
  );
  const resolveApiKey = resolveApiKeyOf(adapter);
  const started = Date.now();
  const key = await resolveApiKey('qwenwork', undefined);
  assert.equal(key, 'ready-secret');
  assert.ok(Date.now() - started < 1000, '就绪时不应有可感知延迟');
});

test('模型目录仍可用（resolveApiKey 的改动不得影响 listModels）', async () => {
  const { adapter } = createQwenWorkAdapter(
    () => 'http://127.0.0.1:1/v1',
    async () => 's',
  );
  const models = await adapter.listModels('qwenwork');
  assert.ok(Array.isArray(models));
  assert.ok(models.length >= 3, `应至少列出 3 个模型，实际 ${models.length}`);
  for (const model of models) {
    assert.deepEqual(model.inputModalities, ['text'], `${model.id} 必须只有文本模态`);
  }
});
