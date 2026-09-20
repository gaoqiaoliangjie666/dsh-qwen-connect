/**
 * 用假的 ctx 驱动 `apply()`，验证 provider 注册的**行为契约**：
 *  - 是否调用 ctx.llm.registerAdapter / registerConfigurableProviders
 *  - 是否挂载 web status 路由
 *  - 注册的 provider id / displayName / settingsNs 是否正确
 *  - 注册失败时是否**不抛出**（不触发红色横幅）
 *
 * 用法：node tools/apply-check.mjs
 */

import assert from 'node:assert/strict';

const say = (s) => process.stdout.write(`${s}\n`);
const { apply, QWENWORK_PROVIDER, QWENWORK_SETTINGS_NS } = await import('../lib/index.js');

/** 造一个记录调用的假 cordis ctx。 */
function makeCtx() {
  const calls = { adapters: [], directories: [], routes: [], effects: [], settings: [] };
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn, label) {
      calls.effects.push(label ?? '(anonymous)');
      const dispose = fn();
      return dispose;
    },
    inject(deps, fn) {
      // 立即以「依赖可用」的形态回调，便于观察副作用
      const sub = {
        webServer: {
          register(spec) {
            calls.routes.push(spec);
            return () => {};
          },
        },
        settings: {
          installSection(...args) {
            calls.settings.push(args);
          },
        },
        effect: ctx.effect,
        logger: ctx.logger,
        llm: ctx.llm,
      };
      fn(sub);
    },
    get(key) {
      if (key === 'attachments') return undefined;
      return undefined;
    },
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

// ---------------------------------------------------------------- 正常路径
{
  const { ctx, calls } = makeCtx();
  let threw = false;
  try {
    apply(ctx, {});
  } catch (error) {
    threw = true;
    say(`✖ apply 抛出了异常: ${error.message}`);
  }
  assert.equal(threw, false, 'apply 不得抛出（否则 DSH 会显示红色横幅）');
  say('✔ apply() 未抛出异常');

  assert.equal(calls.adapters.length, 1, '必须注册一个 adapter');
  assert.deepEqual(calls.adapters[0].providers, [QWENWORK_PROVIDER]);
  assert.equal(QWENWORK_PROVIDER, 'qwenwork');
  say(`✔ registerAdapter: providers=[${calls.adapters[0].providers}]`);

  const adapter = calls.adapters[0].adapter;
  assert.equal(typeof adapter.listModels, 'function', 'adapter 必须是 PiAiAdapter（有 listModels）');
  assert.equal(typeof adapter.resolveModel, 'function');
  say('✔ adapter 具备 PiAiAdapter 接口（listModels / resolveModel）');

  assert.equal(calls.directories.length, 1, '必须注册 configurable provider 目录');
  const entry = calls.directories[0][0];
  assert.equal(entry.provider, 'qwenwork');
  assert.equal(entry.displayName, 'QwenWork');
  assert.equal(entry.settingsNs, QWENWORK_SETTINGS_NS);
  assert.equal(entry.declared, false, 'declared 必须为 false（本地登录态型，非 API Key 型）');
  say(`✔ registerConfigurableProviders: ${JSON.stringify(entry)}`);

  const statusRoute = calls.routes.find((r) => r.path.includes('status'));
  assert.ok(statusRoute !== undefined, '必须挂载 status 路由');
  assert.equal(statusRoute.kind, 'exact');
  assert.equal(statusRoute.path, '/plugins/dsh-qwen-connect/status');
  assert.equal(typeof statusRoute.handler, 'function');
  say(`✔ status 路由: ${statusRoute.kind} ${statusRoute.path}`);

  assert.ok(calls.effects.length > 0, '必须通过 ctx.effect 注册清理函数');
  say(`✔ ctx.effect 注册了 ${calls.effects.length} 个清理项`);

  // 模型目录必须可列出。
  //
  // 注意：`PiAiAdapter.listModels()` 返回的是**给模型选择器用的展示形状**
  // （provider / id / name / inputModalities），`api` 与 `baseUrl` 属于适配器
  // 内部构造、不对外暴露。因此这里只断言 DSH 契约里确实存在的字段。
  const models = await adapter.listModels('qwenwork');
  assert.ok(Array.isArray(models) && models.length >= 2, 'listModels 必须返回模型');
  const ids = models.map((m) => m.id);
  say(`✔ listModels: [${ids}]`);
  assert.ok(ids.includes('flash') && ids.includes('pro'));
  for (const m of models) {
    assert.equal(m.provider, 'qwenwork', '每个模型都要归属本 provider');
    assert.ok(typeof m.id === 'string' && m.id !== '', '模型必须有非空 id');
    assert.ok(typeof m.name === 'string' && m.name !== '', '模型必须有非空 name（选择器显示用）');
    assert.ok(Array.isArray(m.inputModalities), '必须声明输入模态');
  }
  say('✔ 每个模型都带 provider / id / name / inputModalities');

  // 模态声明：**由附件服务可用性决定**。
  //
  // 历史注记：此断言改过三次——最初要求含 image（模型声明视觉）→
  // 改为禁止 image（当时未接附件服务，声明了会抛 durable attachment 错）→
  // 现在插件已接入 `ctx.get('attachments')`，能力恢复。
  // 不变量：inputModalities 与「resolveAttachments 是否注册」保持一致
  // （见 createQwenWorkAdapter 的 imagesAvailable）。
  // 此处无注入服务，因此 listModels 返回的是 text-only 形态。
  assert.ok(
    models.every((m) => !m.inputModalities.includes('image')),
    '无附件服务的构造路径应退回 text 模态（imagesAvailable=false）',
  );
  say('✔ 模态声明与附件服务联动（无服务 → text）');

  // resolveModel 要能拿到上下文窗口。
  //
  // 历史注记（两次修正都在这个值上）：
  //   ① 曾断言 1_000_000 而 max_input_tokens 发 180000（照搬 Buddy2api 未实测）
  //   ② 曾改成 180_000 —— 后经 probe-context-limit*.mjs 实测推翻：
  //      ≈1.2M tokens 上游仍接受、≈1.5M 才拒 → 真实上限 1.2M~1.5M，
  //      「1M」（App 日志的保守标注）才是正确声明。
  // 不变量：contextWindow === MAX_INPUT_TOKENS === 请求里的 max_input_tokens。
  const resolved = await adapter.resolveModel('qwenwork', 'flash');
  assert.equal(resolved.id, 'flash');
  assert.equal(resolved.context?.contextWindow, 1_000_000, 'contextWindow 必须与 MAX_INPUT_TOKENS(1M) 一致');
  say(`✔ resolveModel(flash): contextWindow=${resolved.context.contextWindow}`);
}

// ---------------------------------------------------------------- 降级路径
{
  const { ctx } = makeCtx();
  ctx.llm.registerAdapter = () => {
    throw new Error('模拟 DSH 注册 API 变更');
  };
  let threw = false;
  try {
    apply(ctx, {});
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'provider 注册失败时 apply 必须吞掉异常');
  say('✔ llm 注册失败时 apply 未抛出（降级安全）');
}

// ---------------------------------------------------------------- 无 webServer
{
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) {
      fn();
      return () => {};
    },
    inject() {
      /* 依赖不可用：模拟没有 webServer 的环境 */
    },
    llm: {
      registerAdapter() {
        return () => {};
      },
      registerConfigurableProviders() {
        return () => {};
      },
    },
  };
  let threw = false;
  try {
    apply(ctx, {});
  } catch {
    threw = true;
  }
  assert.equal(threw, false, '无 webServer 时 apply 也不得抛出');
  say('✔ 无 webServer 环境下 apply 未抛出（仅 provider 注册，卡片不可见）');
}

say('\n全部检查通过。');

// 显式退出。
//
// 阶段 A 起，`apply()` 会启动本插件的环回聊天 shim（一个真实监听的 HTTP
// server）。服务器句柄天然让事件循环继续存活，所以进程不会自己退出——
// 这是**正确行为**，不是泄漏。但测试脚本必须显式退出，否则在 verify-all
// 的 spawnSync 里会一直等到超时（实测挂起 >120s）。
process.exit(0);
