// research/probes-2026-09-14/probe-ctx-lifecycle.mjs
// 决定性诊断：ctx.get('attachments') 在 DSH 的真实生命周期里会怎样？
//
// 关键区别：
//   - 官方 provider（dsh-llm-pi-ai）在 **handler 内**调用 ctx.get('attachments')
//   - 我们的实现（imageDepsFrom）在 **apply() 时** 捕获 attachments 对象
//
// 若 DSH 的 ctx 在装配后失效（或服务引用需要每次现取），
// 我们捕获的对象就可能处于无效状态 → 图片路径行为异常。
import { createQwenWorkAdapter } from '../../lib/index.js';
import { startChatShim } from '../../lib/chat-shim.js';
import { loadCredentials } from '../../lib/credentials.js';
import { DEFAULT_ENDPOINT } from '../../lib/signer-session.js';

let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '[OK]' : '[FAIL]'} ${label}${detail ? ' - ' + detail : ''}`);
  if (!ok) fail++;
};

const shim = await startChatShim({
  getCredential: async () => loadCredentials(),
  endpoint: DEFAULT_ENDPOINT,
  logger: { warn: () => {}, info: () => {} },
});

console.log('=== 模拟 DSH 的 ctx 生命周期 ===');

// 模拟一个「装配后失效」的 ctx：apply 时可用，之后 get 抛错
let live = true;
const flakyAttachments = {
  async readImageRequest() { return { data: Buffer.from([1, 2, 3]), mediaType: 'image/png', bytes: 3 }; },
  imageHostPath() { return '/tmp/x.png'; },
};
const ctx = {
  get(name) {
    if (!live) throw new Error(`ctx is no longer active (get ${name})`);
    if (name === 'attachments') return flakyAttachments;
    if (name === 'fs') return { processPathFromHostPath: (p) => p };
    return undefined;
  },
};

// 装配阶段（live=true）
const { adapter } = createQwenWorkAdapter(
  () => shim.baseUrl,
  async () => shim.sharedSecret,
  {
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (svc, ref) => {
      const mapHostPath = (hostPath) => ctx.get('fs')?.processPathFromHostPath?.(hostPath);
      return `[image ${String(ref?.attachmentId ?? '').slice(0, 20)}]`;
    },
  },
);

console.log('\n--- 1) 装配后、ctx 仍活跃：纯文本请求应正常 ---');
{
  const t0 = Date.now();
  try {
    const chunks = [];
    for await (const c of adapter.stream({
      provider: 'qwenwork', model: 'pro',
      messages: [{ role: 'user', content: [{ type: 'text', text: '说：好' }] }],
      signal: AbortSignal.timeout(60000),
    })) chunks.push(c);
    const text = chunks.filter((c) => c?.type === 'text-delta' || c?.type === 'text_delta').map((c) => c.delta ?? c.text ?? '').join('');
    check(`纯文本请求 ${Date.now() - t0}ms`, text.length > 0, JSON.stringify(text.slice(0, 20)));
  } catch (e) {
    check('纯文本请求', false, e.message.slice(0, 80));
  }
}

console.log('\n--- 2) ctx 失效后：纯文本请求是否受影响？ ---');
live = false;
{
  const t0 = Date.now();
  try {
    const chunks = [];
    for await (const c of adapter.stream({
      provider: 'qwenwork', model: 'pro',
      messages: [{ role: 'user', content: [{ type: 'text', text: '说：好' }] }],
      signal: AbortSignal.timeout(60000),
    })) chunks.push(c);
    const text = chunks.filter((c) => c?.type === 'text-delta' || c?.type === 'text_delta').map((c) => c.delta ?? c.text ?? '').join('');
    console.log(`     纯文本请求 ${Date.now() - t0}ms | ${JSON.stringify(text.slice(0, 20))}`);
    check('ctx 失效后纯文本仍可工作（说明 resolveAttachments 未被调用）', text.length > 0);
  } catch (e) {
    check('ctx 失效后纯文本仍可工作', false, e.message.slice(0, 80));
  }
}
live = true;

console.log('\n--- 3) 含图请求：ctx 失效时会怎样 ---');
{
  const t0 = Date.now();
  let caught = null;
  try {
    const chunks = [];
    for await (const c of adapter.stream({
      provider: 'qwenwork', model: 'pro',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image', attachment: { attachmentId: 'sha256:0123456789abcdef', bytes: 3 } },
        ],
      }],
      signal: AbortSignal.timeout(60000),
    })) chunks.push(c);
    console.log(`     ${Date.now() - t0}ms | ${chunks.length} chunks`);
  } catch (e) {
    caught = e;
    console.log(`     ${Date.now() - t0}ms | 异常: ${e.message.slice(0, 100)}`);
  }
  check('含图请求有明确结果（不悬挂）', true, caught ? '抛错（可接受）' : '完成');
}

await shim.close();
console.log(fail === 0 ? '\n[OK] ctx 生命周期检查通过' : `\n[FAIL] ${fail} 项`);
process.exit(fail > 0 ? 1 : 0);
