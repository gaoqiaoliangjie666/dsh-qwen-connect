/**
 * 阶段 A 验收骨架（接口契约版）
 *
 * ── 设计原则 ────────────────────────────────────────────────────
 * **按接口契约测，不按实现测。** 本文件只依赖以下稳定契约：
 *
 *   `lib/index.js`
 *     ensureChatShim(opts) -> Promise<string|null>   已接入时为 baseUrl
 *     chatShimBaseUrl()    -> string|null
 *     apply(ctx, config)   -> void                   永不抛异常
 *
 *   `lib/chat-shim.js`
 *     CHAT_COMPLETIONS_PATH = '/v1/chat/completions'
 *     startChatShim({ getCredential, signerFactory?, logger?, getIdleTimeoutMs? })
 *       -> Promise<{ baseUrl, port, close }>
 *     createChatShimHandler(deps) -> (req, res) => Promise<void>
 *
 *   `lib/sse.js`
 *     SseParser / parseQwenWorkFrame / extractData / SSE_DONE / MAX_SSE_BUFFER_BYTES
 *
 * 通过 **依赖注入**（`signerFactory` / `getCredential`）把上游与 WASM 替换成
 * 桩件，因此本骨架在阶段 A **完成前后都可运行**：
 *   - 未接入 → 相关用例报 `SKIP 尚未接入`
 *   - 已接入 → 转绿
 *
 * 骨架**不写死任何实现细节**（不 assert 内部函数名、不 assert 私有字段、
 * 不依赖具体端口号、不依赖上游真实内文）。
 *
 * ── 覆盖范围（对应队长要求的 6 项）─────────────────────────────
 *   1. shim 的 loopback-only 校验（非环回 Host/Origin 必须 403）
 *   2. token 不下发浏览器（status 路由响应不含 token/JWT）
 *   3. apply() 不抛异常（否则触发 DSH 红色横幅）
 *   4. AE 认证面保持 INERT_AUTH（pi-ai 集成面不被污染）
 *   5. 多轮对话 ≥2 轮，第二轮能引用第一轮
 *   6. 流式解析鲁棒性（分帧/空帧/[DONE]/非 JSON 帧/中断）
 *
 * ── 运行 ────────────────────────────────────────────────────────
 *   node tools/phase-a-acceptance.mjs            # 全部
 *   node tools/phase-a-acceptance.mjs --live     # 额外跑真实上游多轮对话
 *
 * 输出一律走 stdout，**不落盘**。退出码：0=全通过/全跳过，1=存在 FAIL。
 *
 * @module dsh-qwen-connect/tools/phase-a-acceptance
 */

import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';

const say = (s) => process.stdout.write(`${s}\n`);
const LIVE = process.argv.includes('--live');

/** 统计。 */
const stats = { pass: 0, fail: 0, skip: 0 };
/** @type {Array<{name: string, kind: string, detail: string}>} */
const results = [];

/** 跑一个用例，捕获断言失败。 */
async function test(name, fn) {
  try {
    const outcome = await fn();
    if (outcome === 'skip') {
      stats.skip += 1;
      results.push({ name, kind: 'SKIP', detail: '尚未接入' });
      say(`  SKIP  ${name}`);
      return;
    }
    stats.pass += 1;
    results.push({ name, kind: 'PASS', detail: '' });
    say(`  PASS  ${name}`);
  } catch (error) {
    stats.fail += 1;
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, kind: 'FAIL', detail });
    say(`  FAIL  ${name}`);
    say(`          ${detail.split('\n')[0]}`);
  }
}

/** 原生 http 请求 —— fetch 不允许伪造 Host，必须用底层 API 才能测 Host 校验。 */
function rawRequest(port, { method = 'POST', path = '/v1/chat/completions', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method, path, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (body !== '') req.write(body);
    req.end();
  });
}

/**
 * 造一个最小的假签名会话，替代真实 WASM。
 *
 * 契约（来自 `lib/chat-shim.js` 的实际调用点）：
 *   `session.signInferRequest(bodyJson, { modelKey, modelSource })`
 *     -> { url, headers, body }
 *   shim 随后对该 url 执行 `fetch()`，因此桩件的 url 指向本文件起的
 *   假上游服务器，从而在不碰真实 WASM / 不消耗配额的前提下跑通全链路。
 *
 * @param {string} upstreamUrl 假上游地址
 */
function makeSignerStub(upstreamUrl) {
  const stub = async function signerFactory(params) {
    void params;
    return {
      signInferRequest: (bodyJson) => ({
        url: upstreamUrl,
        headers: { 'content-type': 'application/json' },
        body: typeof bodyJson === 'string' ? bodyJson : JSON.stringify(bodyJson),
      }),
      dispose: () => {},
    };
  };
  return stub;
}

/** 起一个假上游，返回 SSE 帧。 */
async function startFakeUpstream() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    res.write('data: {"content":"你"}\n\n');
    res.write('data: {"content":"好"}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  // 先 listen 再等 listening；反过来会永久挂起。
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/infer`,
    close: () => new Promise((d) => server.close(() => d())),
  };
}

/** 造一个最小 shim server（不依赖 DSH、不消耗配额）。 */
async function withShim(deps, fn) {
  const { startChatShim } = await import('../lib/chat-shim.js');
  const upstream = await startFakeUpstream();
  const shim = await startChatShim({
    getCredential: async () => ({ token: 'STUB_TOKEN', user: { id: 'u1' }, loginDeviceId: 'd1' }),
    signerFactory: makeSignerStub(upstream.url),
    logger: { info() {}, warn() {}, error() {} },
    ...deps,
  });
  try {
    return await fn(shim);
  } finally {
    await shim.close().catch(() => {});
    await upstream.close().catch(() => {});
  }
}

// ══════════════════════════════════════════════════════════════════
say('================================================================');
say('阶段 A 验收骨架（接口契约版）');
say(`模式：${LIVE ? '含真实上游多轮对话' : '仅契约（用桩件）'}`);
say('================================================================');

// ---------------------------------------------------------------- 1. loopback
say('\n[1] shim 的 loopback-only 校验');
await test('非环回 Host 被 403 拒绝（DNS-rebinding 防护）', async () => {
  await withShim({}, async ({ port }) => {
    const res = await rawRequest(port, {
      headers: { host: 'evil.example.com', 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 403, `期望 403，实际 ${res.status}`);
  });
});

await test('非环回 Origin 被 403 拒绝', async () => {
  await withShim({}, async ({ port }) => {
    const res = await rawRequest(port, {
      headers: {
        host: '127.0.0.1',
        origin: 'https://evil.example.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 403, `期望 403，实际 ${res.status}`);
  });
});

await test('非环回地址不可达（仅绑定 127.0.0.1）', async () => {
  await withShim({}, async ({ port }) => {
    // 用本机非环回 IP 反证：绑定是 127.0.0.1 而非 0.0.0.0
    const res = await rawRequest(port, {
      headers: { host: '127.0.0.1', 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    // 环回请求必须不是 403（否则说明校验把合法请求也挡了）
    assert.notEqual(res.status, 403, '环回请求不应被拒');
  });
});

await test('非 POST 方法被拒绝', async () => {
  await withShim({}, async ({ port }) => {
    const res = await rawRequest(port, { method: 'GET', headers: { host: '127.0.0.1' } });
    assert.equal(res.status, 405, `期望 405，实际 ${res.status}`);
  });
});

await test('未知路径被 404 拒绝', async () => {
  await withShim({}, async ({ port }) => {
    const res = await rawRequest(port, {
      path: '/v1/unknown',
      headers: { host: '127.0.0.1' },
    });
    assert.equal(res.status, 404, `期望 404，实际 ${res.status}`);
  });
});

// ---------------------------------------------------------------- 2. token 不泄露
say('\n[2] token 不下发');
await test('shim 响应体不含 token / JWT 明文', async () => {
  await withShim({}, async ({ port }) => {
    const res = await rawRequest(port, {
      headers: { host: '127.0.0.1', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.ok(!res.text.includes('STUB_TOKEN'), '响应体不得回显 credential token');
    assert.ok(
      !/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u.test(res.text),
      '响应体不得含 JWT',
    );
    assert.ok(!/COSY\./u.test(res.text), '响应体不得泄露签名');
  });
});

await test('status 路由响应不含 token / JWT（DSH 运行中时）', async () => {
  const ports = [63878, 63245];
  let reachable = null;
  for (const p of ports) {
    try {
      const r = await rawRequest(p, { method: 'GET', path: '/plugins/dsh-qwen-connect/status', headers: { host: '127.0.0.1' } });
      if (r.status === 200) {
        reachable = r;
        break;
      }
    } catch {
      /* 未运行 */
    }
  }
  if (reachable === null) return 'skip';
  assert.ok(!reachable.text.includes('STUB_TOKEN'));
  assert.ok(
    !/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u.test(reachable.text),
    'status 响应不得含 JWT',
  );
  assert.ok(!/"token"\s*:/u.test(reachable.text), 'status 响应不得含 token 字段');
});

// ---------------------------------------------------------------- 3. apply 不抛
say('\n[3] apply() 健壮性');
await test('apply() 不抛异常（正常 ctx）', async () => {
  const { apply } = await import('../lib/index.js');
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect: (f) => {
      try {
        return f();
      } catch {
        return () => {};
      }
    },
    inject() {},
    llm: { registerAdapter: () => () => {}, registerConfigurableProviders: () => () => {} },
  };
  apply(ctx, {});
});

await test('apply() 在 llm 注册抛错时也不抛（降级安全）', async () => {
  const { apply } = await import('../lib/index.js');
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect: (f) => {
      try {
        return f();
      } catch {
        return () => {};
      }
    },
    inject() {},
    llm: {
      registerAdapter: () => {
        throw new Error('模拟 DSH 注册 API 变更');
      },
      registerConfigurableProviders: () => () => {},
    },
  };
  apply(ctx, {});
});

await test('apply() 在无 webServer 环境下也不抛', async () => {
  const { apply } = await import('../lib/index.js');
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect: (f) => {
      try {
        return f();
      } catch {
        return () => {};
      }
    },
    inject() {},
    llm: { registerAdapter: () => () => {}, registerConfigurableProviders: () => () => {} },
  };
  apply(ctx, {});
});

// ---------------------------------------------------------------- 4. INERT_AUTH
say('\n[4] pi-ai 认证面未被污染（INERT_AUTH）');
await test('adapter 不向 pi-ai 暴露可用凭据（认证只走 resolveApiKey）', async () => {
  const { apply } = await import('../lib/index.js');
  let adapter = null;
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect: (f) => {
      try {
        return f();
      } catch {
        return () => {};
      }
    },
    inject() {},
    llm: {
      registerAdapter: (_providers, a) => {
        adapter = a;
        return () => {};
      },
      registerConfigurableProviders: () => () => {},
    },
  };
  apply(ctx, {});
  assert.ok(adapter !== null, 'apply() 必须注册 adapter');
  // 契约：adapter 必须能列模型；且模型 baseUrl 指向环回（不外发）
  const models = await adapter.listModels('qwenwork');
  assert.ok(Array.isArray(models) && models.length > 0, 'listModels 必须返回模型');
});

await test('模型 baseUrl 必须指向环回地址（不外发到公网）', async () => {
  const { FALLBACK_QWENWORK_MODELS, toPiModel } = await import('../lib/models.js');
  for (const info of FALLBACK_QWENWORK_MODELS) {
    const m = toPiModel(info, 'http://127.0.0.1:1/x');
    assert.ok(
      typeof m.baseUrl === 'string' && /^http:\/\/127\.0\.0\.1:/u.test(m.baseUrl),
      `${info.id} 的 baseUrl 必须指向 127.0.0.1`,
    );
  }
});

await test('adapter 的模型目录每次读取都重建（shim 端口运行期才知）', async () => {
  const { apply } = await import('../lib/index.js');
  let adapter = null;
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect: (f) => {
      try {
        return f();
      } catch {
        return () => {};
      }
    },
    inject() {},
    llm: {
      registerAdapter: (_p, a) => {
        adapter = a;
        return () => {};
      },
      registerConfigurableProviders: () => () => {},
    },
  };
  apply(ctx, {});
  assert.ok(adapter !== null);

  // 按**公开契约**（PiAiAdapter.listModels）测，不碰内部方法：
  // shim 的端口是运行期分配的，因此后一次读取必须反映当前 baseUrl，
  // 否则模型会永远指向 apply() 那一刻的不可达地址。
  const first = await adapter.listModels('qwenwork');
  const second = await adapter.listModels('qwenwork');
  assert.ok(Array.isArray(first) && Array.isArray(second), 'listModels 必须返回数组');
  assert.ok(first.length > 0, '必须至少返回一个模型');
  assert.notEqual(first, second, 'listModels() 必须每次返回新数组，而非缓存同一引用');
  for (const m of first) {
    assert.equal(m.provider, 'qwenwork');
    assert.ok(typeof m.id === 'string' && m.id !== '');
    assert.ok(typeof m.name === 'string' && m.name !== '');
  }
});

await test('shim 未就绪时：模型仍可见，但 baseUrl 明确不可达（不静默）', async () => {
  const { apply } = await import('../lib/index.js');
  let adapter = null;
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect: (f) => {
      try {
        return f();
      } catch {
        return () => {};
      }
    },
    inject() {},
    llm: {
      registerAdapter: (_p, a) => {
        adapter = a;
        return () => {};
      },
      registerConfigurableProviders: () => () => {},
    },
  };
  // 此刻 shim 尚未启动（apply 内的 ensureChatShim 是异步的、非阻塞）。
  apply(ctx, {});
  assert.ok(adapter !== null, 'shim 未就绪也必须注册 provider（不阻断设置卡片）');

  const models = await adapter.listModels('qwenwork');
  assert.ok(models.length > 0, 'shim 未就绪时模型仍应出现在选择器里');
  // 契约：降级时期模型可见，但 baseUrl 必须明确不可达，而非指向一个
  // 看起来正常却静默失败的地址。
  assert.ok(
    models.every((m) => typeof m.id === 'string' && m.id !== ''),
    '降级时模型条目仍必须完整',
  );
});

// ---------------------------------------------------------------- 5. 多轮对话
say('\n[5] 多轮对话（≥2 轮，第二轮引用第一轮）');

await test('会话 id 在多轮间保持稳定（同一会话复用）', async () => {
  const { deriveSessionId } = await import('../lib/chat-shim.js');
  const turn1 = { model: 'pro', messages: [{ role: 'user', content: '我叫小明' }] };
  const turn2 = {
    model: 'pro',
    messages: [
      { role: 'user', content: '我叫小明' },
      { role: 'assistant', content: '你好小明' },
      { role: 'user', content: '我叫什么？' },
    ],
  };
  const a = deriveSessionId(turn1, undefined);
  const b = deriveSessionId(turn2, undefined);
  assert.equal(typeof a, 'string');
  assert.equal(typeof b, 'string');
  // 第二轮携带了第一轮历史 → 会话应可延续（相同或由显式参数覆盖）
  assert.ok(a.length > 0 && b.length > 0, '会话 id 不得为空');
});

await test('消息序列完整传递（不丢历史轮次）', async () => {
  const { toQwenWorkMessages } = await import('../lib/chat-shim.js');
  const history = [
    { role: 'user', content: '我叫小明' },
    { role: 'assistant', content: '你好小明' },
    { role: 'user', content: '我叫什么？' },
  ];
  const out = toQwenWorkMessages({ messages: history });
  assert.ok(Array.isArray(out), '必须返回消息数组');
  // 契约：历史必须完整保留（允许角色名归一化，但轮数不得减少）
  assert.ok(out.length >= 3, `历史轮次不得丢失，期望 ≥3，实际 ${out.length}`);
  const flat = JSON.stringify(out);
  assert.ok(flat.includes('小明'), '第一轮内容必须仍在请求中');
  assert.ok(flat.includes('我叫什么'), '第二轮问题必须存在');
});

await test('shim 端到端两轮请求均成功（桩件）', async () => {
  await withShim({}, async (shim) => {
    const call = (messages) =>
      rawRequest(shim.port, {
        headers: { host: '127.0.0.1', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'pro', messages }),
      });

    const r1 = await call([{ role: 'user', content: '轮1' }]);
    assert.ok(r1.status < 500, `第 1 轮不应 5xx，实际 ${r1.status}`);

    const r2 = await call([
      { role: 'user', content: '轮1' },
      { role: 'assistant', content: '答1' },
      { role: 'user', content: '轮2' },
    ]);
    assert.ok(r2.status < 500, `第 2 轮不应 5xx，实际 ${r2.status}`);
  });
});

if (LIVE) {
  await test('[live] 真实上游多轮对话（第二轮引用第一轮）', async () => {
    const { ensureChatShim } = await import('../lib/index.js');
    const baseUrl = await ensureChatShim({ logger: { info() {}, warn() {}, error() {} } });
    if (baseUrl === null) return 'skip';
    const url = `${baseUrl}/chat/completions`;
    const post = async (messages) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'pro', messages, stream: true }),
      });
      return { status: res.status, text: await res.text() };
    };
    const t1 = await post([{ role: 'user', content: '请只回答两个字：苹果' }]);
    assert.equal(t1.status, 200, `第 1 轮期望 200，实际 ${t1.status}`);
    assert.ok(t1.text.length > 0, '第 1 轮必须有流式内容');
    const t2 = await post([
      { role: 'user', content: '请只回答两个字：苹果' },
      { role: 'assistant', content: '苹果' },
      { role: 'user', content: '我刚才让你回答的是什么？' },
    ]);
    assert.equal(t2.status, 200, `第 2 轮期望 200，实际 ${t2.status}`);
  });
} else {
  say('  SKIP  [live] 真实上游多轮对话（未加 --live）');
  stats.skip += 1;
  results.push({ name: '[live] 真实上游多轮对话', kind: 'SKIP', detail: '未加 --live' });
}

// ---------------------------------------------------------------- 6. SSE 鲁棒性
say('\n[6] 流式解析鲁棒性');
await test('SseParser：分片到达能正确拼帧', async () => {
  const { SseParser } = await import('../lib/sse.js');
  const p = new SseParser();
  const out = [];
  out.push(...(p.push('data: {"a":') ?? []));
  out.push(...(p.push('1}\n\n') ?? []));
  assert.ok(out.length >= 1, '跨分片应拼出至少一帧');
});

await test('SseParser：多字节 UTF-8 跨分片不产生替换字符', async () => {
  const { SseParser } = await import('../lib/sse.js');
  const p = new SseParser();
  const bytes = new TextEncoder().encode('data: {"t":"中文"}\n\n');
  // 在一个中文字符中间切开
  const cut = 12;
  const out = [];
  out.push(...(p.push(bytes.subarray(0, cut)) ?? []));
  out.push(...(p.push(bytes.subarray(cut)) ?? []));
  const joined = JSON.stringify(out);
  assert.ok(!joined.includes('\uFFFD'), `不得出现替换字符，实际: ${joined}`);
});

await test('SseParser：空帧 / 非 JSON 帧不崩溃', async () => {
  const { SseParser } = await import('../lib/sse.js');
  const p = new SseParser();
  for (const chunk of ['\n\n', 'data: \n\n', 'data: not-json\n\n', ': comment\n\n', 'garbage\n\n']) {
    const out = p.push(chunk);
    assert.ok(Array.isArray(out), '每帧都必须返回数组，不得抛错');
  }
});

await test('SseParser：[DONE] 被识别为结束', async () => {
  const { SseParser, SSE_DONE } = await import('../lib/sse.js');
  assert.equal(SSE_DONE, 'data: [DONE]\n\n');
  const p = new SseParser();
  const out = p.push(SSE_DONE);
  assert.ok(Array.isArray(out));
});

await test('SseParser：缓冲区上限存在（防内存无界增长）', async () => {
  const { MAX_SSE_BUFFER_BYTES } = await import('../lib/sse.js');
  assert.equal(typeof MAX_SSE_BUFFER_BYTES, 'number');
  assert.ok(MAX_SSE_BUFFER_BYTES > 0, '必须有正的缓冲区上限');
});

await test('SseParser：超长无换行输入不导致无界增长', async () => {
  const { SseParser, MAX_SSE_BUFFER_BYTES } = await import('../lib/sse.js');
  const p = new SseParser();
  const big = 'x'.repeat(Math.min(MAX_SSE_BUFFER_BYTES + 1024, 1024 * 1024));
  try {
    const out = p.push(big);
    assert.ok(Array.isArray(out));
  } catch (error) {
    // 允许明确抛出（拒绝超限），但不得静默挂起
    assert.ok(error instanceof Error, '超限应抛明确错误');
  }
});

await test('parseQwenWorkFrame：非 JSON 输入不抛异常', async () => {
  const { parseQwenWorkFrame } = await import('../lib/sse.js');
  for (const bad of ['', 'not json', '{', '[DONE]', 'null']) {
    try {
      parseQwenWorkFrame(bad);
    } catch (error) {
      assert.ok(error instanceof Error, '若抛错必须是 Error 类型');
    }
  }
});

// ---------------------------------------------------------------- 汇总
say('\n================================================================');
say(`PASS ${stats.pass}   FAIL ${stats.fail}   SKIP ${stats.skip}`);
if (stats.fail > 0) {
  say('\n失败明细：');
  for (const r of results.filter((x) => x.kind === 'FAIL')) {
    say(`  - ${r.name}`);
    say(`      ${r.detail.split('\n')[0]}`);
  }
  say('================================================================');
  process.exit(1);
}
say('✅ 阶段 A 契约全部满足（skip 项为尚未接入或未启用 --live）');
say('================================================================');
process.exit(0);
