// research/probes-2026-09-14/probe-version-portability.mjs
// 便携性关键验证：签名用的 Cosy 版本对可用性的影响。
//
// 场景：把插件拷到别人电脑，那台机器上：
//   a) 千问办公装在非标准目录（探测不到）→ 落到 fallback 常量
//   b) 千问办公版本与开发机不同 → 用他们的版本签名
// 两者都必须能正常工作，否则便携性不成立。
import { createSignerSession, DEFAULT_ENDPOINT } from '../../lib/signer-session.js';
import { loadCredentials } from '../../lib/credentials.js';
import { resolveCosyVersion } from '../../lib/runtime-identity.js';

const cred = await loadCredentials();
const PROMPT = '说：好';

let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '[OK]' : '[FAIL]'} ${label}${detail ? ' - ' + detail : ''}`);
  if (!ok) fail++;
};

console.log('=== 1) 本机版本探测结果 ===');
const detected = resolveCosyVersion();
console.log(`  版本: ${detected.version}`);
console.log(`  来源: ${detected.source}`);
console.log(`  说明: ${detected.detail}`);
check('探测到了版本', typeof detected.version === 'string' && detected.version.length > 0);

console.log('\n=== 2) 探测失败的回退链（模拟「装在非标准目录」）===');
// 用一个不存在的 installRoot + 干净的 env，强制走回退
const forced = resolveCosyVersion({ installRoot: 'Z:\\nonexistent\\QwenWorkCN', env: {} });
console.log(`  版本: ${forced.version}`);
console.log(`  来源: ${forced.source}`);
check('回退到常量版本', forced.source === 'fallback', forced.version);

console.log('\n=== 3) 用不同版本签名，实测是否都能用 ===');
//
// 版本只能经 identity.env 的 QWEN_COSY_VERSION 注入（resolveCosyVersion 的
// 最高优先级来源），因此这里用环境变量模拟「别的电脑上探测到的不同版本」。
const versions = [...new Set([detected.version, forced.version, '1.0.5', '1.2.0'])];
for (const ver of versions) {
  const session = await createSignerSession({
    credential: cred,
    endpoint: DEFAULT_ENDPOINT,
    identity: { env: { QWEN_COSY_VERSION: ver } },
  });
  const body = JSON.stringify({
    request_id: crypto.randomUUID(),
    session_id: 'sess-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    model_config: { key: 'flash', source: 'system', max_input_tokens: 1000000 },
    parameters: { max_tokens: 100 },
    chat_context: {
      text: PROMPT, features: [],
      extra: { context: [], modelConfig: { key: 'flash', source: 'system' }, originalContent: PROMPT },
      chatPrompt: '', imageUrls: null,
    },
    agent_id: 'agent_common',
    messages: [{ role: 'user', content: PROMPT }],
  });
  const t0 = Date.now();
  try {
    const signed = session.signInferRequest(body, { modelKey: 'flash', modelSource: 'system' });
    const res = await fetch(signed.url, { method: 'POST', headers: signed.headers, body: signed.body, signal: AbortSignal.timeout(60000) });
    const text = await res.text();
    let ans = '', err = null;
    for (const l of text.split('\n')) {
      if (!l.startsWith('data:')) continue;
      const p = l.slice(5).trim();
      if (!p || p === '[DONE]') continue;
      try {
        const o = JSON.parse(p);
        const inner = typeof o.body === 'string' ? JSON.parse(o.body) : o;
        if (inner.code && String(inner.code) !== '200' && inner.message) err = String(inner.message).slice(0, 70);
        for (const c of inner.choices ?? []) if (c.delta?.content) ans += c.delta.content;
      } catch {}
    }
    const ok = res.status === 200 && ans.length > 0 && err === null;
    console.log(`  ${ok ? '[OK]' : '[FAIL]'} 版本 ${ver.padEnd(8)} HTTP ${res.status} ${Date.now() - t0}ms ${err ? '| ' + err : '| ' + JSON.stringify(ans.slice(0, 14))}`);
    if (!ok) fail++;
  } catch (e) {
    console.log(`  [FAIL] 版本 ${ver.padEnd(8)} 异常: ${e.message.slice(0, 60)}`);
    fail++;
  } finally {
    await session.dispose?.();
  }
}

console.log(fail === 0 ? '\n[OK] 版本无关性成立：任意版本均可签名使用' : `\n[FAIL] ${fail} 项`);
process.exit(fail > 0 ? 1 : 0);
