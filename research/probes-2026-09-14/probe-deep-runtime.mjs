// research/probes-2026-09-14/probe-deep-runtime.mjs
// 深度运行时交叉验证：单元测试容易漏的「真实数据 + 真实时序」场景。
import { startChatShim } from '../../lib/chat-shim.js';
import { loadCredentials } from '../../lib/credentials.js';
import { DEFAULT_ENDPOINT } from '../../lib/signer-session.js';
import { getValidCredential, getAccountContext } from '../../lib/credentials-seam.js';

let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) fail++;
};

// ① 真实凭据的 token 与 refresh 一致性（跨模块不脱节）
console.log('=== 1) 凭据跨模块一致性 ===');
const seamCred = await getValidCredential();
const directCred = await loadCredentials();
check('接缝凭据与直读凭据 token 一致', seamCred?.token === (directCred.credentials ?? directCred)?.token);
check('接缝凭据 user.id 与直读一致', seamCred?.user?.id === (directCred.credentials ?? directCred)?.user?.id);
check('loginDeviceId 一致', seamCred?.loginDeviceId === (directCred.credentials ?? directCred)?.loginDeviceId);

// ② 账号上下文与 status 路由数据源一致
console.log('\n=== 2) 账号上下文与卡片数据源一致 ===');
const ctx = await getAccountContext();
check('账户上下文有 quota.remaining', typeof ctx?.quota?.remaining === 'number', String(ctx?.quota?.remaining));
check('有 user.name', typeof ctx?.user?.name === 'string' && ctx.user.name !== '');
check('有 plan.name', typeof ctx?.plan?.name === 'string');

// ③ 连续真实对话的 session 复用（同会话多轮不丢上下文）
console.log('\n=== 3) 连续多轮真实对话（上下文保持）===');
const shim = await startChatShim({ getCredential: async () => loadCredentials(), endpoint: DEFAULT_ENDPOINT });
const SESSION = 'deep-check-session';
async function ask(messages) {
  const res = await fetch(shim.baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.sharedSecret}` },
    body: JSON.stringify({ model: 'pro', stream: true, user: SESSION, messages }),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let ans = '';
  for (const l of text.split('\n')) {
    if (!l.startsWith('data:')) continue;
    const p = l.slice(5).trim();
    if (!p || p === '[DONE]') continue;
    try { const o = JSON.parse(p); for (const c of o.choices ?? []) if (c.delta?.content) ans += c.delta.content; } catch {}
  }
  return { status: res.status, ans };
}
const a1 = await ask([{ role: 'user', content: '记住：我的代号是"深蓝"，只回复"已记录"三个字。' }]);
const a2 = await ask([
  { role: 'user', content: '记住：我的代号是"深蓝"，只回复"已记录"三个字。' },
  { role: 'assistant', content: a1.ans },
  { role: 'user', content: '我的代号是什么？' },
]);
check('第1轮正常', a1.status === 200 && a1.ans.length > 0, JSON.stringify(a1.ans.slice(0, 30)));
check('第2轮引用第1轮上下文（代号"深蓝"）', a2.ans.includes('深蓝'), JSON.stringify(a2.ans.slice(0, 40)));

await shim.close();

console.log(fail === 0 ? '\n✅ 深度运行时交叉验证通过' : `\n❌ ${fail} 项失败`);
process.exit(fail > 0 ? 1 : 0);
