// research/probes-2026-09-14/probe-realistic-load.mjs
// 真机负载模拟：DSH GUI 会带系统提示词 + 多轮历史 + 工具定义。
// 用接近真实的负载测，而不是我一贯的"一句话"极简请求。
import { startChatShim } from '../../lib/chat-shim.js';
import { loadCredentials } from '../../lib/credentials.js';
import { DEFAULT_ENDPOINT } from '../../lib/signer-session.js';

const shim = await startChatShim({
  getCredential: async () => loadCredentials(),
  endpoint: DEFAULT_ENDPOINT,
  logger: { warn: (...a) => console.log('    [warn]', ...a.map((x) => String(x).slice(0, 110))) },
});

/** DSH 风格的系统提示（简化但结构一致，约 3K 字符）。 */
const SYSTEM = `You are DSH, a coding agent. Working directory: E:\\Codex开发\\DHS开发.
You must cooperate to complete the benchmark tests. Follow instructions exactly.
Use tools when needed. Be concise. ${'遵循以上规则并按用户要求执行任务。'.repeat(40)}`;

/** 模拟工具定义（DSH 会带一批）。 */
const TOOLS = Array.from({ length: 12 }, (_, i) => ({
  type: 'function',
  function: {
    name: `tool_${i}`,
    description: `测试工具 ${i}：${'执行某个操作并返回结果。'.repeat(8)}`,
    parameters: { type: 'object', properties: { arg: { type: 'string', description: '参数说明' } }, required: ['arg'] },
  },
}));

/** 模拟多轮历史。 */
function makeHistory(turns) {
  const h = [{ role: 'system', content: SYSTEM }];
  for (let i = 0; i < turns; i++) {
    h.push({ role: 'user', content: `${'这是一段较长的用户输入，用于模拟真实对话。'.repeat(3)}（第 ${i + 1} 轮）` });
    h.push({ role: 'assistant', content: `${'这是模型的回答，包含一定长度的内容。'.repeat(5)}（第 ${i + 1} 轮回复）` });
  }
  h.push({ role: 'user', content: '继续' });
  return h;
}

async function run(label, body) {
  const t0 = Date.now();
  let headerAt = null, firstContentAt = null, chars = 0, frames = 0;
  const size = JSON.stringify(body).length;
  try {
    const res = await fetch(shim.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.sharedSecret}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    });
    headerAt = Date.now();
    const dec = new TextDecoder('utf-8');
    let buf = '';
    for await (const c of res.body) {
      buf += dec.decode(c, { stream: true });
      const evs = buf.split('\n\n'); buf = evs.pop() ?? '';
      for (const e of evs) {
        if (!e.startsWith('data:')) continue;
        const p = e.slice(5).trim();
        if (!p || p === '[DONE]') continue;
        frames++;
        try {
          const o = JSON.parse(p);
          const d = o.choices?.[0]?.delta;
          if (d?.content) { if (!firstContentAt) firstContentAt = Date.now(); chars += d.content.length; }
        } catch {}
      }
    }
    const total = Date.now() - t0;
    console.log(`  ${res.status === 200 ? '✅' : '❌'} ${label.padEnd(28)} 请求${String(Math.round(size / 1024)).padStart(3)}KB | 总${String(total).padStart(7)}ms | 响应头${String(headerAt - t0).padStart(6)}ms | 首内容${String((firstContentAt ?? 0) - t0).padStart(7)}ms | ${chars}字`);
  } catch (e) {
    console.log(`  ❌ ${label.padEnd(28)} 请求${String(Math.round(size / 1024)).padStart(3)}KB | 总${String(Date.now() - t0).padStart(7)}ms | ${e.name}`);
  }
}

console.log('=== 真机负载模拟（逐级加压）===');
await run('极简（我的常规测试）', { model: 'pro', stream: true, messages: [{ role: 'user', content: '你好' }] });
await run('+系统提示词', { model: 'pro', stream: true, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: '你好' }] });
await run('+12个工具定义', { model: 'pro', stream: true, tools: TOOLS, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: '你好' }] });
await run('+10轮历史', { model: 'pro', stream: true, tools: TOOLS, messages: makeHistory(10) });
await run('+30轮历史', { model: 'pro', stream: true, tools: TOOLS, messages: makeHistory(30) });

await shim.close();
process.exit(0);
