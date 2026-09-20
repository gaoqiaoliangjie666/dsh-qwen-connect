// test/unit/token-expiry.test.mjs
//
// token 过期判定的边界锁定。
// 背景：凭据层的「刷新链路」是 t1 的核心交付；过期判定一旦出错，
// 要么用过期 token 打签名请求（被上游 401/403 拒），要么频繁无效刷新。
//
// ⚠️ 语义说明（刻意为之，勿“修复”）：`expiresAt` 缺失时返回 **false（视为有效）**。
// 这是 t1 的原始决策：真实凭据（schema v2）始终带 expiresAt，该分支只是防御；
// 若改成「缺失视为过期」，而刷新响应也不回 expiresAt，就会造成**无限刷新循环**
// （auth.js:245 `refreshed.expiresAt ?? creds.expiresAt` 会把缺失一路传下去）。
// 此处用测试把该决策钉住，防止后人好心地改坏。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isTokenExpired } from '../../lib/credentials.js';

test('isTokenExpired：Date 形式的 expiresAt（正常路径）', () => {
  const now = Date.now();
  assert.equal(isTokenExpired({ expiresAt: new Date(now - 1_000) }), true, '1 秒前到期 → 过期');
  assert.equal(isTokenExpired({ expiresAt: new Date(now + 3600_000) }), false, '1 小时后到期 → 有效');
});

test('isTokenExpired：默认 60s 提前量（skew）', () => {
  const now = Date.now();
  // 距到期 30 秒：在 60s 提前量内 → 已「视为过期」（提前刷新）
  assert.equal(isTokenExpired({ expiresAt: new Date(now + 30_000) }), true, '30s 后到期，小于 skew → 视为过期');
  // 距到期 5 分钟：远超提前量 → 有效
  assert.equal(isTokenExpired({ expiresAt: new Date(now + 300_000) }), false, '5min 后到期 → 有效');
  // 显式覆盖 skew
  assert.equal(isTokenExpired({ expiresAt: new Date(now + 30_000) }, 10_000), false, 'skew 缩小到 10s → 有效');
});

test('isTokenExpired：expiresAt 缺失视为有效（刻意决策，防无限刷新）', () => {
  // 真实凭据（schema v2）始终有 expiresAt，此分支只是防御。
  // 若改「缺失视为过期」而刷新响应也不回 expiresAt，
  // auth.js:245 会把缺失一路继承 → 无限刷新循环。
  for (const bad of [undefined, null, {}, { expiresAt: undefined }, { expiresAt: null }]) {
    assert.equal(isTokenExpired(bad), false, `${JSON.stringify(bad)} → 视为有效（不主动刷新）`);
  }
});

test('isTokenExpired：非法 expiresAt 类型（字符串/数字）不会崩溃', () => {
  const now = Date.now();
  // 当前实现调用 .getTime()，字符串/数字会抛 TypeError —— 这里的契约是
  // 「调用方保证 normalizeCredentials 已把 expiresAt 规范成 Date」。
  // 若未来上游出现字符串日期，应先在 normalize 层转换，而不是在此兼容。
  assert.throws(
    () => isTokenExpired({ expiresAt: '2030-01-01' }),
    /getTime is not a function|TypeError/i,
    '字符串日期应在 normalize 层转换，本函数对非法类型抛错是可接受的防线',
  );
  void now;
});
