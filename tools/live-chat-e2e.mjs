/**
 * 端到端验证：走**与 DSH 完全相同的代码路径**完成一次真实多轮对话。
 *
 * 路径：lib/index.js 的 apply() → ctx.llm.registerAdapter → PiAiAdapter
 *      → 签名 shim → gateway.qwenwork.cn
 *
 * 之所以这样验证：DSH 已在运行中（PID 18548），其 host 侧插件是标准 ESM，
 * 但它的 LLM API 需要鉴权且不允许外部触发对话。本脚本用同一个 adapter
 * 实例、同一份 provider 配置去跑，因此验证的是**同一个代码路径**，而不是
 * 另写一套近似实现。
 *
 * 用法：node tools/live-chat-e2e.mjs
 */

import assert from 'node:assert/strict';

const say = (s) => process.stdout.write(`${s}\n`);

// 从 junction 视角加载，等价于 DSH 的加载方式
const PLUGIN_URL = 'file:///C:/Users/HX/AppData/Roaming/dsh-desktop/harness/profiles/web/node_modules/dsh-qwen-connect/lib/index.js';
const mod = await import(PLUGIN_URL);
say(`插件加载: name=${mod.name} provider=${mod.QWENWORK_PROVIDER}`);

/** 造一个记录调用的假 cordis ctx（与 tools/apply-check.mjs 同构）。 */
function makeCtx() {
  const calls = { adapters: [], directories: [], routes: [], effects: [] };
  const ctx = {
    logger: { info: (m) => say(`  [plugin info] ${m}`), warn: (m) => say(`  [plugin warn] ${m}`), error() {} },
    effect(fn, label) {
      calls.effects.push(label ?? '(anonymous)');
      return fn();
    },
    inject(deps, fn) {
      fn({
        webServer: { register: (spec) => (calls.routes.push(spec), () => {}) },
        settings: { installSection: () => {} },
        effect: ctx.effect,
        logger: ctx.logger,
        llm: ctx.llm,
      });
    },
    get: () => undefined,
    llm: {
      registerAdapter(providers, adapter) {
        calls.adapters.push({ providers, adapter });
        return () => {};
      },
      registerConfigurableProviders(list) {
        calls.directories.push(list);
        return () => {};
      },
    },
  };
  return { ctx, calls };
}

const { ctx, calls } = makeCtx();
mod.apply(ctx, {});
assert.equal(calls.adapters.length, 1, 'apply 必须注册 adapter');
const adapter = calls.adapters[0].adapter;
say('✔ apply() 注册了 adapter');

// 等 shim 就绪（apply 内部异步启动）
let baseUrl = null;
for (let i = 0; i < 60; i += 1) {
  baseUrl = mod.chatShimBaseUrl();
  if (baseUrl !== null) break;
  await new Promise((r) => setTimeout(r, 100));
}
assert.ok(baseUrl !== null, 'chat shim 必须启动成功');
say(`✔ chat shim 就绪: ${baseUrl}`);

// 模型必须指向 shim（而非占位常量）
const models = await adapter.listModels('qwenwork');
say(`✔ listModels: [${models.map((m) => m.id).join(', ')}]`);
assert.ok(
  !models.some((m) => JSON.stringify(m).includes('PHASE_B_PLACEHOLDER')),
  '模型不得再含占位常量',
);

// ---- 真实对话：通过 PiAiAdapter.stream --------------------------------
say('\n=== 通过 DSH adapter 发起真实对话 ===');

/**
 * 调 adapter.stream 并收集文本。
 *
 * 接口（读自 dsh-llm-pi-ai 源码与实测事件形状）：
 *   prepareCall(provider, model) -> { model, stream(options) }
 *   stream(options) 的 options: { provider, model, messages, signal?, sessionId? }
 *
 * 事件是**带 type 标签的块流**，思维链与正文严格分离：
 *   { type: 'block-start',      blockType: 'reasoning' | 'text' }
 *   { type: 'reasoning-delta',  text }
 *   { type: 'text-delta',       text }
 *   { type: 'block-stop' | 'finish' ... }
 * 因此必须按 type 分流，绝不能把两者都当正文累加。
 */
async function runTurn(messages, label) {
  const call = await adapter.prepareCall('qwenwork', 'pro');

  // 单轮上限：上游模型偶发长输出（实测见过 106 帧），不设上限会让整条
  // 验证在 CI 里无限等待。超时按「验证失败」处理并报告，不静默吞掉。
  const timeoutMs = Number(process.env.QWEN_E2E_TURN_TIMEOUT_MS ?? 120_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let text = '';
  let reasoning = '';
  let frames = 0;
  try {
    const stream = call.stream({ provider: 'qwenwork', model: 'pro', messages, signal: controller.signal });
    for await (const event of stream) {
      frames += 1;
      const t = event?.type;
      const piece = typeof event?.text === 'string' ? event.text : '';
      if (t === 'text-delta') text += piece;
      else if (t === 'reasoning-delta') reasoning += piece;
    }
  } catch (error) {
    if (controller.signal.aborted) {
      say(`[${label}] 超过 ${timeoutMs}ms 上限，已中止（frames=${frames}）`);
    } else {
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }
  say(`[${label}] frames=${frames}`);
  if (reasoning !== '') say(`[${label}] reasoning=${JSON.stringify(reasoning.slice(0, 100))}`);
  say(`[${label}] text=${JSON.stringify(text.slice(0, 200))}`);
  return { text, reasoning, frames };
}

/** DSH 的 message.content 是**内容块数组**，不是裸字符串。 */
function userMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }] };
}
/**
 * DSH 的 assistant 历史必须带 `source`：
 * dsh-llm-pi-ai 的 toPiAssistant() 会读取 `message.source.kind`，
 * 缺失即抛 TypeError。这里用最小的合法 source（kind: 'model'，
 * 不带 replayState，走 provider-neutral 降级路径）。
 */
function assistantMessage(text) {
  return { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } };
}

let first = null;
try {
  first = await runTurn([userMessage('我叫小明。请只回答"好的"。')], '第 1 轮');
} catch (error) {
  say(`第 1 轮失败: ${error.message}`);
  say(error.stack?.split('\n').slice(0, 8).join('\n'));
  await mod.stopChatShim();
  process.exit(1);
}

const second = await runTurn(
  [
    userMessage('我叫小明。请只回答"好的"。'),
    assistantMessage(first.text || '好的'),
    userMessage('我叫什么名字？只回答名字。'),
  ],
  '第 2 轮',
);

say('\n=== 结论 ===');
say(`第 1 轮回答: ${JSON.stringify(first.text)}`);
say(`第 2 轮回答: ${JSON.stringify(second.text)}`);
const ok = second.text.includes('小明');
say(ok ? '✔ 多轮对话成功：第二轮引用了第一轮内容' : '✖ 第二轮未引用第一轮内容');

await mod.stopChatShim();
process.exit(ok ? 0 : 1);
