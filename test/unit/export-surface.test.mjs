// test/unit/export-surface.test.mjs
//
// 契约护栏：`signer-shim.js` 是 `chat-shim.js` 的**稳定转发层**，
// 集成方按 signer-shim 找、实现却在 chat-shim。一旦转发列表漏掉新增导出，
// 调用方拿到 undefined 却不会报错——静默失效最难查。
//
// 本测试自动比对两侧导出面，漏一个就失败。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as chatShim from '../../lib/chat-shim.js';
import * as signerShim from '../../lib/signer-shim.js';
import * as sse from '../../lib/sse.js';
import * as index from '../../lib/index.js';

test('signer-shim 必须完整转发 chat-shim 的全部导出', () => {
  const source = Object.keys(chatShim).sort();
  const forwarded = Object.keys(signerShim).sort();
  const missing = source.filter((name) => !forwarded.includes(name));
  assert.deepEqual(
    missing,
    [],
    `signer-shim 漏掉这些转发：${missing.join(', ')} —— 调用方会拿到 undefined`,
  );
});

test('signer-shim 不得凭空多出 chat-shim 没有的导出', () => {
  const source = new Set(Object.keys(chatShim));
  const extra = Object.keys(signerShim).filter((name) => !source.has(name));
  assert.deepEqual(extra, [], `signer-shim 多出的导出：${extra.join(', ')}`);
});

test('sse 层的 usage 解析导出存在（DSH 依赖它显示 token 数）', () => {
  assert.equal(typeof sse.parseRawUsage, 'function');
  assert.equal(typeof sse.parseQwenWorkFrame, 'function');
  assert.equal(typeof sse.encodeOpenAiChunk, 'function');
});

test('index 暴露的装配入口齐全（apply/name/inject）', () => {
  assert.equal(typeof index.apply, 'function');
  assert.equal(typeof index.name, 'string');
  assert.ok(Array.isArray(index.inject));
  // 排障入口：新机器接线后可用它们确认 shim 状态
  assert.equal(typeof index.ensureChatShim, 'function');
  assert.equal(typeof index.stopChatShim, 'function');
  assert.equal(typeof index.chatShimBaseUrl, 'function');
  assert.equal(typeof index.chatShimSharedSecret, 'function');
});
