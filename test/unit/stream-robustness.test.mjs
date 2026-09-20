/**
 * 流式解析鲁棒性测试：分帧、空帧、[DONE]、非 JSON 帧、网络中断。
 *
 * 这些用例不依赖网络，纯粹验证解析层与 shim 的错误路径 —— 因此可重复、
 * 可在 CI 里跑。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

import {
  SseParser,
  parseQwenWorkFrame,
  parseRawUsage,
  encodeOpenAiChunk,
  SSE_DONE,
} from '../../lib/sse.js';
import {
  createChatShimHandler,
  toQwenWorkMessages,
  collectImageUrls,
  deriveSessionId,
  resolveModelKey,
  simpleHash,
  RETRYABLE_STATUS,
  isRetryableStatus,
} from '../../lib/chat-shim.js';
import {
  FALLBACK_QWENWORK_MODELS,
  toPiModel,
  catalogForCard,
  displayName,
  formatRate,
} from '../../lib/models.js';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 构造一个上游风格的信封帧。 */
function envelope(body, extra = {}) {
  return `data:${JSON.stringify({ ...extra, body: typeof body === 'string' ? body : JSON.stringify(body) })}`;
}

/** 构造一个模型分块帧。 */
function chunkFrame(delta, finishReason = undefined) {
  return envelope(
    JSON.stringify({
      choices: [{ delta, index: 0, ...(finishReason === undefined ? {} : { finish_reason: finishReason }) }],
      object: 'chat.completion.chunk',
    }),
    { statusCodeValue: 200, statusCode: 'OK', headers: { 'X-Model-Name': ['glm-5.2'] } },
  );
}

/** 起一个假上游，按脚本逐块推送，用于测试 shim 的端到端错误路径。 */
function startFakeUpstream(script) {
  const server = http.createServer(async (req, res) => {
    req.resume();
    await new Promise((r) => req.on('end', r));
    const outcome = await script();
    if (outcome?.httpStatus !== undefined && outcome.httpStatus !== 200) {
      res.writeHead(outcome.httpStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: '101', message: 'Signature invalid' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const piece of outcome.pieces ?? []) {
      if (piece === null) {
        res.destroy(); // 模拟网络中断
        return;
      }
      res.write(piece);
      await new Promise((r) => setTimeout(r, 1));
    }
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** 直接调用 shim handler，绕过真实上游（用 signerFactory 注入假签名器）。 */
function startShim(upstreamUrl, opts = {}) {
  // 测试专用固定密钥：让所有测试请求带正确的 Authorization，验证鉴别通过路径。
  // 另有专项用例（见文件末）验证「无密钥 / 错误密钥被 401 拒绝」。
  const sharedSecret = 'test-shared-secret';
  const handler = createChatShimHandler({
    getCredential: async () => ({ token: 'fake-token', user: { id: 'u1' }, loginDeviceId: 'dev-1' }),
    endpoint: upstreamUrl,
    sharedSecret,
    signerFactory: async () => ({
      describe: () => ({}),
      dispose: () => {},
      // 用真实 bodyJson 作为上游请求体：这样测试能真正校验「请求体是否正确构造」，
      // 而不是永远看到一个占位的 '{}'。
      signInferRequest: (bodyJson) => ({
        url: upstreamUrl,
        headers: { 'Content-Type': 'application/json' },
        body: bodyJson,
        headerCount: 1,
      }),
    }),
    ...opts,
  });

  const server = http.createServer((req, res) => {
    // 与生产实现（startChatShim）一致：只把 /v1/chat/completions 交给 handler，
    // 其余路径返回 404。
    if (!req.url || !req.url.startsWith('/v1/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found', type: 'invalid_request_error' } }));
      return;
    }
    handler(req, res).catch(() => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        base: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
        secret: sharedSecret,
        close: () => new Promise((d) => server.close(() => d())),
      });
    });
  });
}

/** 收集 OpenAI SSE 帧。 */
async function collectSse(res) {
  const frames = [];
  const decoder = new TextDecoder();
  let buf = '';
  for await (const c of res.body) {
    buf += decoder.decode(c, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const p = line.slice(5).trim();
      if (p === '') continue;
      frames.push(p);
    }
  }
  return frames;
}

/**
 * 用裸 TCP socket 发一个手写的 HTTP/1.1 请求，返回原始响应文本。
 *
 * 必要性：Node 的 `fetch` 不允许调用方设置 `Host` 头（会被忽略并替换成
 * 目标地址），因此要验证 Host 校验（DNS-rebinding 防护）只能绕开 fetch。
 *
 * 结束判定：不能依赖 socket `end` —— HTTP/1.1 默认 keep-alive，服务端
 * 不会主动关连接，等 `end` 会白等到超时。这里按响应头判定：
 *   - `Connection: close` → 等到 socket end
 *   - `Content-Length: n` → 收满 n 字节即完成
 *   - `Transfer-Encoding: chunked` → 见到 `0\r\n\r\n` 终止块即完成
 *
 * @param {number} port
 * @param {string} rawRequest
 * @param {number} [timeoutMs]
 * @returns {Promise<string>}
 */
function rawHttpRequest(port, rawRequest, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks = [];
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };

    socket.setTimeout(timeoutMs, finish);

    socket.on('connect', () => socket.write(rawRequest));
    socket.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    socket.on('end', finish);
    socket.on('data', (c) => {
      chunks.push(c);
      const text = Buffer.concat(chunks).toString('utf8');
      const headerEnd = text.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const head = text.slice(0, headerEnd);
      const rest = text.slice(headerEnd + 4);

      const lenMatch = /^content-length:\s*(\d+)/im.exec(head);
      if (lenMatch !== null) {
        if (Buffer.byteLength(rest, 'utf8') >= Number(lenMatch[1])) finish();
        return;
      }
      if (/^transfer-encoding:\s*chunked/im.test(head)) {
        if (rest.endsWith('0\r\n\r\n')) finish();
        return;
      }
      if (/^connection:\s*close/im.test(head)) return; // 等 socket end
      // 既无长度也无 chunked 且 keep-alive：无法判定，交给超时兜底
    });
  });
}

// ---------------------------------------------------------------------------
// SseParser：分帧与边界
// ---------------------------------------------------------------------------

test('SseParser: 逐字符喂入仍能正确切出完整帧', () => {
  const parser = new SseParser();
  const input = `data:{"a":1}\n\ndata:{"b":2}\n\n`;
  const out = [];
  for (const ch of input) out.push(...parser.push(ch));
  assert.deepEqual(out, ['{"a":1}', '{"b":2}']);
});

test('SseParser: CRLF 行尾被正确处理', () => {
  const parser = new SseParser();
  const out = parser.push('data:{"a":1}\r\n\r\ndata:{"b":2}\r\n\r\n');
  assert.deepEqual(out, ['{"a":1}', '{"b":2}']);
});

test('SseParser: 一个 TCP 分片里含多个帧', () => {
  const parser = new SseParser();
  const out = parser.push('data:1\ndata:2\ndata:3\n');
  assert.deepEqual(out, ['1', '2', '3']);
});

test('SseParser: 空 data 帧被跳过且计入 droppedFrames', () => {
  const parser = new SseParser();
  const out = parser.push('data:\ndata:   \ndata:{"ok":1}\n');
  assert.deepEqual(out, ['{"ok":1}']);
  assert.equal(parser.droppedFrames, 2);
});

test('SseParser: [DONE] 被识别且停止后续解析', () => {
  const parser = new SseParser();
  const out = parser.push('data:{"a":1}\ndata: [DONE]\ndata:{"never":1}\n');
  assert.deepEqual(out, ['{"a":1}']);
  assert.equal(parser.done, true);
  // done 之后继续喂入不再产出
  assert.deepEqual(parser.push('data:{"late":1}\n'), []);
});

test('SseParser: 注释行与 event/id/retry 行被忽略', () => {
  const parser = new SseParser();
  const out = parser.push(': heartbeat\nevent: message\nid: 7\nretry: 100\ndata:{"x":1}\n');
  assert.deepEqual(out, ['{"x":1}']);
});

test('SseParser: flush() 吐出没有换行结尾的尾帧', () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push('data:{"tail":true}'), []);
  assert.deepEqual(parser.flush(), ['{"tail":true}']);
});

test('SseParser: Uint8Array 输入（含跨分片的多字节 UTF-8）', () => {
  const parser = new SseParser();
  const bytes = Buffer.from('data:{"t":"中文"}\n\n', 'utf8');
  // 在多字节字符中间切开
  const out = [...parser.push(bytes.subarray(0, 12)), ...parser.push(bytes.subarray(12))];
  // 帧可能被切开成两半，但拼接后必须还原
  assert.equal(out.join(''), '{"t":"中文"}');
});

test('SseParser: 缓冲区超限时丢弃并计数，不抛异常', () => {
  const parser = new SseParser();
  const huge = 'x'.repeat(9 * 1024 * 1024);
  const out = parser.push(huge);
  assert.deepEqual(out, []);
  assert.equal(parser.droppedFrames, 1);
});

// ---------------------------------------------------------------------------
// parseQwenWorkFrame：非 JSON 与畸形帧
// ---------------------------------------------------------------------------

test('parseQwenWorkFrame: 非 JSON 负载返回 skip，不抛异常', () => {
  for (const bad of ['not json', '{', '{"a":}', 'undefined', 'null', '123', '"str"']) {
    assert.equal(parseQwenWorkFrame(bad).kind, 'skip', `payload=${bad}`);
  }
});

test('parseQwenWorkFrame: 正常分块解析出 content 与 reasoning', () => {
  const f = parseQwenWorkFrame(chunkFrame({ content: '你好' }));
  assert.equal(f.kind, 'chunk');
  assert.equal(f.delta.content, '你好');
  assert.equal(f.modelName, 'glm-5.2');

  const r = parseQwenWorkFrame(chunkFrame({ reasoning_content: '想' }));
  assert.equal(r.delta.reasoning, '想');
});

test('parseQwenWorkFrame: finish_reason 帧被识别', () => {
  const f = parseQwenWorkFrame(chunkFrame({}, 'stop'));
  assert.equal(f.kind, 'chunk');
  assert.equal(f.finishReason, 'stop');
});

test('parseQwenWorkFrame: 上游 4xx 信封被识别为 error', () => {
  const payload = JSON.stringify({
    statusCodeValue: 400,
    statusCode: 'Bad Request',
    body: JSON.stringify({ code: '400', message: 'messages is required' }),
  });
  const f = parseQwenWorkFrame(payload);
  assert.equal(f.kind, 'error');
  assert.equal(f.error.status, 400);
  assert.match(f.error.message, /messages is required/);
});

test('parseQwenWorkFrame: 无 choices 的统计帧被 skip（不是错误）', () => {
  const f = parseQwenWorkFrame('{"firstTokenDuration":3884,"serverDuration":0,"totalDuration":3930}');
  assert.equal(f.kind, 'skip');
});

test('parseQwenWorkFrame: body 已是对象时同样可解析', () => {
  const payload = JSON.stringify({ body: { choices: [{ delta: { content: 'x' } }] } });
  assert.equal(parseQwenWorkFrame(payload).delta.content, 'x');
});

test('parseQwenWorkFrame: 内层 body 非法 JSON 时 skip', () => {
  const f = parseQwenWorkFrame(JSON.stringify({ body: '{oops', statusCodeValue: 200 }));
  assert.equal(f.kind, 'skip');
});

// ---------------------------------------------------------------------------
// encodeOpenAiChunk
// ---------------------------------------------------------------------------

test('encodeOpenAiChunk: 产出合法的 OpenAI 分块', () => {
  const s = encodeOpenAiChunk({ model: 'pro', id: 'c1', created: 1, delta: { content: 'hi' } });
  assert.ok(s.startsWith('data: '));
  const parsed = JSON.parse(s.slice(6).trim());
  assert.equal(parsed.object, 'chat.completion.chunk');
  assert.equal(parsed.choices[0].delta.content, 'hi');
  assert.equal(parsed.choices[0].finish_reason, null);
});

test('encodeOpenAiChunk: reasoning 映射到 reasoning_content', () => {
  const s = encodeOpenAiChunk({ model: 'pro', id: 'c1', created: 1, delta: { reasoning: 'r' } });
  const parsed = JSON.parse(s.slice(6).trim());
  assert.equal(parsed.choices[0].delta.reasoning_content, 'r');
});

test('encodeOpenAiChunk: 空 delta 时补 role 首块', () => {
  const s = encodeOpenAiChunk({ model: 'pro', id: 'c1', created: 1, delta: {} });
  const parsed = JSON.parse(s.slice(6).trim());
  assert.equal(parsed.choices[0].delta.role, 'assistant');
});

// ---------------------------------------------------------------------------
// chat-shim 纯函数
// ---------------------------------------------------------------------------

test('toQwenWorkMessages: 纯文本消息保留', () => {
  assert.deepEqual(
    toQwenWorkMessages({ messages: [{ role: 'user', content: 'a' }] }),
    [{ role: 'user', content: 'a' }],
  );
});

test('toQwenWorkMessages: 多模态数组的文本部分与图片一并保留', () => {
  // 历史：图片曾被降级为纯文本占位符（当时未支持视觉）。
  // 现在改为**真正的多模态转发**——文本与 image_url 都保留在数组里。
  const out = toQwenWorkMessages({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '看这个' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
        ],
      },
    ],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'user');
  assert.ok(Array.isArray(out[0].content), '含图消息必须是数组 content');
  const textPart = out[0].content.find((p) => p.type === 'text');
  const imgPart = out[0].content.find((p) => p.type === 'image_url');
  assert.equal(textPart?.text, '看这个');
  assert.ok(imgPart?.image_url?.url.startsWith('data:image/png'));
});

test('toQwenWorkMessages: 纯图片消息不产生空内容', () => {
  const out = toQwenWorkMessages({
    messages: [
      { role: 'user', content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] },
    ],
  });
  assert.equal(out.length, 1, '纯图片消息不应被整条丢弃');
  assert.ok(Array.isArray(out[0].content) && out[0].content.length > 0, '必须含 image_url 部件');
});

test('toQwenWorkMessages: 畸形消息被安全过滤', () => {
  const out = toQwenWorkMessages({ messages: [null, 1, { role: 'user' }, { role: 'assistant', content: '' }] });
  assert.deepEqual(out, []);
});

test('toQwenWorkMessages: 非数组 messages 返回空数组', () => {
  assert.deepEqual(toQwenWorkMessages({ messages: 'nope' }), []);
  assert.deepEqual(toQwenWorkMessages({}), []);
});

// ---------------------------------------------------------------------------
// 视觉（图片输入）
//
// 实测结论（probe-image-format.mjs 的六变体对照）：上游要**同时**满足两点才
// 认图 —— ① chat_context.imageUrls 非空；② messages[].content 是含
// image_url 的数组。缺任一条，模型都回复「我没有看到您上传的图片」。
// ---------------------------------------------------------------------------

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('collectImageUrls：DSH 内部形态（data+mimeType）转 data URL', () => {
  const urls = collectImageUrls({
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: '看图' }, { type: 'image', data: PNG_1PX, mimeType: 'image/png' }],
      },
    ],
  });
  assert.equal(urls.length, 1);
  assert.ok(urls[0].startsWith('data:image/png;base64,'));
});

test('collectImageUrls：OpenAI 标准形态（image_url.url）', () => {
  const urls = collectImageUrls({
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/webp;base64,AA' } }] }],
  });
  assert.deepEqual(urls, ['data:image/webp;base64,AA']);
});

test('collectImageUrls：只取最后一条 user 消息的图片', () => {
  const urls = collectImageUrls({
    messages: [
      { role: 'user', content: [{ type: 'image', data: 'OLD', mimeType: 'image/png' }] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: [{ type: 'text', text: '这张呢' }, { type: 'image', data: 'NEW', mimeType: 'image/png' }] },
    ],
  });
  assert.equal(urls.length, 1, '不应把历史图片也塞进去');
  assert.ok(urls[0].includes('NEW'));
});

test('collectImageUrls：无图时返回空数组', () => {
  assert.deepEqual(collectImageUrls({ messages: [{ role: 'user', content: '纯文本' }] }), []);
  assert.deepEqual(collectImageUrls({}), []);
});

test('toQwenWorkMessages：含图消息保留数组 content（否则上游看不到图）', () => {
  const out = toQwenWorkMessages({
    messages: [
      { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', data: PNG_1PX, mimeType: 'image/png' }] },
    ],
  });
  assert.equal(out.length, 1);
  assert.ok(Array.isArray(out[0].content), '含图消息的 content 必须是数组，塌缩成文本会让上游看不到图');
  const imgPart = out[0].content.find((p) => p.type === 'image_url');
  assert.ok(imgPart !== undefined, '必须转成 image_url 形态');
  assert.ok(imgPart.image_url.url.startsWith('data:image/png;base64,'));
});

test('toQwenWorkMessages：纯文本消息仍塌缩为字符串（不无谓变数组）', () => {
  const out = toQwenWorkMessages({
    messages: [{ role: 'user', content: [{ type: 'text', text: '只有文字' }] }],
  });
  assert.equal(out[0].content, '只有文字');
  assert.equal(Array.isArray(out[0].content), false);
});

test('buildInferBody：图片进入 chat_context.imageUrls，无图时为 null', async () => {
  const { buildInferBody } = await import('../../lib/signer-session.js');
  const withImg = JSON.parse(
    buildInferBody({
      messages: [{ role: 'user', content: '看图' }],
      imageUrls: ['data:image/png;base64,AA'],
    }),
  );
  assert.deepEqual(withImg.chat_context.imageUrls, ['data:image/png;base64,AA']);

  const noImg = JSON.parse(buildInferBody({ messages: [{ role: 'user', content: 'x' }] }));
  assert.equal(noImg.chat_context.imageUrls, null, '无图时必须是 null（上游约定）');
});

test('buildInferBody：chat_context.text 锚定最后一条 user 消息', async () => {
  const { buildInferBody } = await import('../../lib/signer-session.js');
  const body = JSON.parse(
    buildInferBody({
      messages: [
        { role: 'user', content: '第一句' },
        { role: 'assistant', content: '回复' },
        { role: 'user', content: '最后一句' },
      ],
    }),
  );
  assert.equal(body.chat_context.text, '最后一句');
});

test('deriveSessionId: 同一对话历史派生同一 id（多轮可关联）', () => {
  const a = deriveSessionId({ messages: [{ role: 'user', content: '你好' }] }, undefined);
  const b = deriveSessionId({ messages: [{ role: 'user', content: '你好' }] }, undefined);
  assert.equal(a, b);
});

test('deriveSessionId: 显式 id 与 user 字段优先', () => {
  assert.equal(deriveSessionId({}, 'explicit'), 'explicit');
  assert.equal(deriveSessionId({ user: 'u-1' }, undefined), `user-${simpleHash('u-1')}`);
});

test('resolveModelKey: 取 body.model，缺省回退 pro', () => {
  assert.equal(resolveModelKey({ model: 'flash' }), 'flash');
  assert.equal(resolveModelKey({}), 'pro');
  assert.equal(resolveModelKey({ model: 123 }), 'pro');
});

// ---------------------------------------------------------------------------
// chat-shim 端到端：错误路径
// ---------------------------------------------------------------------------

test('shim: 非 POST 返回 405', async () => {
  const shim = await startShim('http://127.0.0.1:1/never');
  try {
    const res = await fetch(shim.base, { method: 'GET' });
    assert.equal(res.status, 405);
  } finally {
    await shim.close();
  }
});

test('shim: 缺少 messages 返回 400', async () => {
  const shim = await startShim('http://127.0.0.1:1/never');
  try {
    const res = await fetch(shim.base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.secret}` },
      body: JSON.stringify({ model: 'pro' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error.message, /messages is required/);
  } finally {
    await shim.close();
  }
});

test('shim: 没有 user 消息时返回 400（否则上游会拿空输入作答）', async () => {
  // 上游用「最后一条 user 消息」填 chat_context.text；只有 system / 只有 assistant
  // 时该字段为空，上游会凭空空答（实测表现为完全答非所问）。
  // 与其让用户收到莫名内容，不如立刻给出明确错误。
  const shim = await startShim('http://127.0.0.1:1/never');
  try {
    for (const messages of [
      [{ role: 'system', content: '你是助手' }],
      [{ role: 'assistant', content: '你好' }],
      [{ role: 'system', content: 'x' }, { role: 'assistant', content: 'y' }],
    ]) {
      const res = await fetch(shim.base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.secret}` },
        body: JSON.stringify({ model: 'pro', messages }),
      });
      assert.equal(res.status, 400, `应拒绝：${JSON.stringify(messages)}`);
      const body = await res.json();
      assert.match(body.error.message, /at least one user message/);
    }
  } finally {
    await shim.close();
  }
});

test('shim: 有 user 消息时正常放行（含 system 前缀的历史）', async () => {
  const upstream = await startFakeUpstream(async () => ({
    pieces: [chunkFrame({ content: 'ok' }) + '\n\n', chunkFrame({}, 'stop') + '\n\n'],
  }));
  const shim = await startShim(`http://127.0.0.1:${upstream.port}/upstream`);
  try {
    const res = await fetch(shim.base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.secret}` },
      body: JSON.stringify({
        model: 'pro',
        messages: [
          { role: 'system', content: '你是助手' },
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: '你好' },
          { role: 'user', content: '再说一次' },
        ],
      }),
      // 显式超时：若 shim 卡住，测试快速失败而不是挂 90 秒等 FIRST_CONTENT 超时
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(res.status, 200);
    await res.text();
  } finally {
    await shim.close();
    upstream.server.close();
  }
});

test('shim: 非法 JSON 返回 400 而非崩溃', async () => {
  const shim = await startShim('http://127.0.0.1:1/never');
  try {
    const res = await fetch(shim.base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.secret}` },
      body: '{not json',
    });
    assert.equal(res.status, 400);
  } finally {
    await shim.close();
  }
});

test('shim: 上游 403 被透传且不泄漏签名头', async () => {
  const upstream = await startFakeUpstream(async () => ({ httpStatus: 403 }));
  const shim = await startShim(`http://127.0.0.1:${upstream.port}/upstream`);
  try {
    const res = await fetch(shim.base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.secret}` },
      body: JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 403);
    const text = await res.text();
    // 上游 body 原样透传（脱敏后），且不含 COSY 签名
    assert.ok(!/COSY\./.test(text), 'must not leak COSY signature');
  } finally {
    await shim.close();
    upstream.server.close();
  }
});

test('shim: 正常流被转成 OpenAI SSE 并以 [DONE] 收尾', async () => {
  const upstream = await startFakeUpstream(async () => ({
    pieces: [chunkFrame({ content: '你' }) + '\n\n', chunkFrame({ content: '好' }) + '\n\n', chunkFrame({}, 'stop') + '\n\n'],
  }));
  const shim = await startShim(`http://127.0.0.1:${upstream.port}/upstream`);
  try {
    const res = await fetch(shim.base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.secret}` },
      body: JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    const frames = await collectSse(res);
    assert.equal(frames.at(-1), '[DONE]');
    const text = frames
      .filter((f) => f !== '[DONE]')
      .map((f) => JSON.parse(f).choices[0].delta.content ?? '')
      .join('');
    assert.equal(text, '你好');
    const finish = frames.filter((f) => f !== '[DONE]').map((f) => JSON.parse(f).choices[0].finish_reason).filter(Boolean);
    assert.deepEqual(finish, ['stop']);
  } finally {
    await shim.close();
    upstream.server.close();
  }
});

test('shim: 上游中途断连 —— 不挂起、发出错误帧并以 [DONE] 收尾', async () => {
  const upstream = await startFakeUpstream(async () => ({
    pieces: [chunkFrame({ content: '开头' }) + '\n\n', null],
  }));
  const shim = await startShim(`http://127.0.0.1:${upstream.port}/upstream`);
  try {
    const res = await fetch(shim.base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.secret}` },
      body: JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const frames = await collectSse(res);
    assert.ok(frames.length >= 1, 'should still receive the early frame');
    assert.equal(frames.at(-1), '[DONE]', 'must terminate with [DONE] so the client does not hang');
  } finally {
    await shim.close();
    upstream.server.close();
  }
});

test('shim: 上游不发任何帧就结束 —— 仍以 finish+[DONE] 收尾', async () => {
  const upstream = await startFakeUpstream(async () => ({ pieces: [] }));
  const shim = await startShim(`http://127.0.0.1:${upstream.port}/upstream`);
  try {
    const res = await fetch(shim.base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.secret}` },
      body: JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const frames = await collectSse(res);
    assert.equal(frames.at(-1), '[DONE]');
    const finish = frames.filter((f) => f !== '[DONE]').map((f) => JSON.parse(f).choices[0].finish_reason).filter(Boolean);
    assert.deepEqual(finish, ['stop']);
  } finally {
    await shim.close();
    upstream.server.close();
  }
});

test('shim: 流中混入非 JSON 帧与空帧不影响正常输出', async () => {
  const upstream = await startFakeUpstream(async () => ({
    pieces: [
      ': heartbeat\n\n',
      'data:\n\n',
      'not-a-frame-at-all\n\n',
      chunkFrame({ content: 'OK' }) + '\n\n',
      chunkFrame({}, 'stop') + '\n\n',
    ],
  }));
  const shim = await startShim(`http://127.0.0.1:${upstream.port}/upstream`);
  try {
    const res = await fetch(shim.base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.secret}` },
      body: JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const frames = await collectSse(res);
    const text = frames
      .filter((f) => f !== '[DONE]')
      .map((f) => JSON.parse(f).choices[0].delta.content ?? '')
      .join('');
    assert.equal(text, 'OK');
    assert.equal(frames.at(-1), '[DONE]');
  } finally {
    await shim.close();
    upstream.server.close();
  }
});

test('shim: 上游在流中报告错误 —— 以 error 帧传递并收尾', async () => {
  const upstream = await startFakeUpstream(async () => ({
    pieces: [
      `data:${JSON.stringify({ statusCodeValue: 429, statusCode: 'Too Many Requests', body: JSON.stringify({ code: '429', message: 'quota exceeded' }) })}\n\n`,
    ],
  }));
  const shim = await startShim(`http://127.0.0.1:${upstream.port}/upstream`);
  try {
    const res = await fetch(shim.base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.secret}` },
      body: JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const frames = await collectSse(res);
    const joined = frames.join('\n');
    assert.match(joined, /quota exceeded/);
    assert.equal(frames.at(-1), '[DONE]');
  } finally {
    await shim.close();
    upstream.server.close();
  }
});

test('shim: 拒绝非环回 Host（DNS-rebinding 防护）', async () => {
  const shim = await startShim('http://127.0.0.1:1/never');
  try {
    // 注意：Node 的 fetch 会丢弃/覆盖调用方设置的 Host 头，因此必须用裸
    // TCP socket 手写请求行，才能真正模拟「Host 指向外部域名」的攻击面。
    const raw = await rawHttpRequest(shim.port, [
      'POST /v1/chat/completions HTTP/1.1',
      'Host: evil.example.com',
      'Content-Type: application/json',
      'Content-Length: 41',
      'Connection: close',
      '',
      JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    ].join('\r\n'));
    assert.match(raw, /^HTTP\/1\.1 403 /, `expected 403, got: ${raw.slice(0, 60)}`);
    assert.match(raw, /request-not-trusted/);
  } finally {
    await shim.close();
  }
});

test('shim: 接受环回 Host（正常路径不被误杀）', async () => {
  const upstream = await startFakeUpstream(async () => ({
    pieces: [chunkFrame({ content: 'ok' }) + '\n\n', chunkFrame({}, 'stop') + '\n\n'],
  }));
  const shim = await startShim(`http://127.0.0.1:${upstream.port}/upstream`);
  try {
    const body = JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: 'hi' }] });
    const raw = await rawHttpRequest(shim.port, [
      'POST /v1/chat/completions HTTP/1.1',
      `Host: 127.0.0.1:${shim.port}`,
      'Content-Type: application/json',
      `Authorization: Bearer ${shim.secret}`,
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
      '',
      body,
    ].join('\r\n'));
    assert.match(raw, /^HTTP\/1\.1 200 /, `expected 200, got: ${raw.slice(0, 60)}`);
  } finally {
    await shim.close();
    upstream.server.close();
  }
});

test('shim: localhost 主机名也被视为环回', async () => {
  const upstream = await startFakeUpstream(async () => ({
    pieces: [chunkFrame({ content: 'ok' }) + '\n\n', chunkFrame({}, 'stop') + '\n\n'],
  }));
  const shim = await startShim(`http://127.0.0.1:${upstream.port}/upstream`);
  try {
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });
    const raw = await rawHttpRequest(shim.port, [
      'POST /v1/chat/completions HTTP/1.1',
      `Host: localhost:${shim.port}`,
      'Content-Type: application/json',
      `Authorization: Bearer ${shim.secret}`,
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
      '',
      body,
    ].join('\r\n'));
    assert.match(raw, /^HTTP\/1\.1 200 /);
  } finally {
    await shim.close();
    upstream.server.close();
  }
});

test('shim: 未知路径返回 404', async () => {
  const shim = await startShim('http://127.0.0.1:1/never');
  try {
    const res = await fetch(`${new URL(shim.base).origin}/nope`, { method: 'POST' });
    assert.equal(res.status, 404);
  } finally {
    await shim.close();
  }
});

test('shim: 拒绝带非环回 Origin 的请求', async () => {
  const shim = await startShim('http://127.0.0.1:1/never');
  try {
    const res = await fetch(shim.base, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://evil.example.com',
        Authorization: `Bearer ${shim.secret}`,
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 403);
  } finally {
    await shim.close();
  }
});

test('shim: 签名会话构建失败时返回 503 而非崩溃', async () => {
  const shim = await startShim('http://127.0.0.1:1/never', {
    signerFactory: async () => {
      throw new Error('machineId unavailable');
    },
  });
  try {
    const res = await fetch(shim.base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.secret}` },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 503);
  } finally {
    await shim.close();
  }
});

test('shim: 响应中不含任何凭据材料', async () => {
  const upstream = await startFakeUpstream(async () => ({
    pieces: [chunkFrame({ content: 'ok' }) + '\n\n', chunkFrame({}, 'stop') + '\n\n'],
  }));
  const shim = await startShim(`http://127.0.0.1:${upstream.port}/upstream`);
  try {
    const res = await fetch(shim.base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.secret}` },
      body: JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const text = (await collectSse(res)).join('\n');
    for (const needle of ['fake-token', 'COSY.', 'eyJ', 'encrypt_user_info']) {
      assert.ok(!text.includes(needle), `response must not contain ${needle}`);
    }
  } finally {
    await shim.close();
    upstream.server.close();
  }
});

// ---------------------------------------------------------------------------
// 进程级鉴别（t7 新增）：无密钥 / 错误密钥拒绝，正确密钥通过
// ---------------------------------------------------------------------------

test('shim: 无 Authorization 头被 401 拒绝', async () => {
  const upstream = await startFakeUpstream(async () => ({
    pieces: [chunkFrame({ content: 'ok' }) + '\n\n', chunkFrame({}, 'stop') + '\n\n'],
  }));
  const shim = await startShim(`http://127.0.0.1:${upstream.port}/upstream`);
  try {
    const res = await fetch(shim.base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.type, 'authentication_error');
  } finally {
    await shim.close();
    upstream.server.close();
  }
});

test('shim: 错误密钥被 401 拒绝', async () => {
  const upstream = await startFakeUpstream(async () => ({
    pieces: [chunkFrame({ content: 'ok' }) + '\n\n', chunkFrame({}, 'stop') + '\n\n'],
  }));
  const shim = await startShim(`http://127.0.0.1:${upstream.port}/upstream`);
  try {
    const res = await fetch(shim.base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-secret' },
      body: JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.type, 'authentication_error');
  } finally {
    await shim.close();
    upstream.server.close();
  }
});

test('shim: 正确密钥通过且到达上游', async () => {
  const upstream = await startFakeUpstream(async () => ({
    pieces: [chunkFrame({ content: 'ok' }) + '\n\n', chunkFrame({}, 'stop') + '\n\n'],
  }));
  const shim = await startShim(`http://127.0.0.1:${upstream.port}/upstream`);
  try {
    const res = await fetch(shim.base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.secret}` },
      body: JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    const frames = await collectSse(res);
    assert.equal(frames.at(-1), '[DONE]');
  } finally {
    await shim.close();
    upstream.server.close();
  }
});

// ---------------------------------------------------------------------------
// 上游重试策略（借鉴 Buddy2api 的 RETRYABLE_STATUS）
// ---------------------------------------------------------------------------

test('isRetryableStatus: 只把限流/网关瞬时故障视为可重试', () => {
  for (const status of [408, 409, 425, 429, 500, 502, 503, 504]) {
    assert.equal(isRetryableStatus(status), true, `${status} 应可重试`);
  }
  // 语义错误重试也不会变好，必须不重试
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(isRetryableStatus(status), false, `${status} 不应重试`);
  }
});

test('RETRYABLE_STATUS 与 Buddy2api 的常量集合一致', () => {
  assert.deepEqual([...RETRYABLE_STATUS], [408, 409, 425, 429, 500, 502, 503, 504]);
});

test('shim: 上游首次 503、次次成功 —— 自动重试并最终 200', async () => {
  let calls = 0;
  const upstream = await startFakeUpstream(async () => {
    calls++;
    if (calls === 1) return { httpStatus: 503 };
    return { pieces: [chunkFrame({ content: 'ok' }) + '\n\n', chunkFrame({}, 'stop') + '\n\n'] };
  });
  const shim = await startShim(`http://127.0.0.1:${upstream.port}/upstream`);
  try {
    const res = await fetch(shim.base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.secret}` },
      body: JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200, '503 后重试应成功');
    assert.equal(calls, 2, '应恰好请求上游两次');
    const frames = await collectSse(res);
    assert.equal(frames.at(-1), '[DONE]');
  } finally {
    await shim.close();
    upstream.server.close();
  }
});

test('shim: 上游持续 429 —— 重试上限后按原状态码返回，不无限重试', async () => {
  let calls = 0;
  const upstream = await startFakeUpstream(async () => {
    calls++;
    return { httpStatus: 429 };
  });
  const shim = await startShim(`http://127.0.0.1:${upstream.port}/upstream`);
  try {
    const res = await fetch(shim.base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.secret}` },
      body: JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 429, '持续失败应透传原状态码');
    assert.equal(calls, 3, '应最多尝试 3 次');
  } finally {
    await shim.close();
    upstream.server.close();
  }
});

test('shim: 上游 400 —— 不重试，立即返回', async () => {
  let calls = 0;
  const upstream = await startFakeUpstream(async () => {
    calls++;
    return { httpStatus: 400 };
  });
  const shim = await startShim(`http://127.0.0.1:${upstream.port}/upstream`);
  try {
    const res = await fetch(shim.base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.secret}` },
      body: JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 400);
    assert.equal(calls, 1, '语义错误不得重试');
  } finally {
    await shim.close();
    upstream.server.close();
  }
});

// ---------------------------------------------------------------------------
// 工具调用（tool_calls）协议转换
// ---------------------------------------------------------------------------

test('parseQwenWorkFrame: tool_calls 分片原样透传', () => {
  const payload = envelope(
    JSON.stringify({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'get_weather', arguments: '' } }],
          },
          finish_reason: null,
        },
      ],
    }),
  );
  const f = parseQwenWorkFrame(payload);
  assert.equal(f.kind, 'chunk');
  assert.equal(f.delta.tool_calls.length, 1);
  assert.equal(f.delta.tool_calls[0].id, 'call_abc');
  assert.equal(f.delta.tool_calls[0].function.name, 'get_weather');
});

test('parseQwenWorkFrame: tool_calls 参数分片可跨帧累积', () => {
  const mk = (args) =>
    envelope(
      JSON.stringify({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }],
      }),
    );
  const a = parseQwenWorkFrame(mk('{"ci'));
  const b = parseQwenWorkFrame(mk('ty":"北京"}'));
  const combined = (a.delta.tool_calls[0].function.arguments ?? '') + (b.delta.tool_calls[0].function.arguments ?? '');
  assert.equal(combined, '{"city":"北京"}');
});

test('encodeOpenAiChunk: tool_calls 被编码进 delta', () => {
  const text = encodeOpenAiChunk({
    model: 'pro',
    id: 'x',
    created: 1,
    delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
  });
  const obj = JSON.parse(text.slice(6).trim());
  assert.equal(obj.choices[0].delta.tool_calls[0].function.name, 'f');
});

test('toQwenWorkMessages: 保留 assistant.tool_calls 与 role:tool 结果', () => {
  const msgs = toQwenWorkMessages({
    messages: [
      { role: 'user', content: '查天气' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }],
      },
      { role: 'tool', content: '晴 25 度', tool_call_id: 'c1' },
    ],
  });
  assert.equal(msgs.length, 3);
  assert.equal(msgs[1].role, 'assistant');
  assert.equal(msgs[1].tool_calls[0].id, 'c1');
  assert.equal(msgs[2].role, 'tool');
  assert.equal(msgs[2].tool_call_id, 'c1');
  assert.equal(msgs[2].content, '晴 25 度');
});

test('toQwenWorkMessages: 无 tool_calls 的 assistant 空消息仍被丢弃（不引入噪声）', () => {
  const msgs = toQwenWorkMessages({
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '' },
      { role: 'user', content: '在吗' },
    ],
  });
  assert.equal(msgs.length, 2);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'user']);
});

test('buildInferBody: 有 tools 时透传，无 tools 时不出现该字段', async () => {
  const { buildInferBody } = await import('../../lib/signer-session.js');
  const withTools = JSON.parse(
    buildInferBody({ messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 'f' } }] }),
  );
  assert.equal(withTools.tools.length, 1);

  const without = JSON.parse(buildInferBody({ messages: [{ role: 'user', content: 'x' }] }));
  assert.equal('tools' in without, false, '无工具时不应凭空加 tools 字段');

  const empty = JSON.parse(buildInferBody({ messages: [], tools: [] }));
  assert.equal('tools' in empty, false, '空数组不应写入');
});

test('shim: 携带 tools 的请求会到达上游且 tools 被透传', async () => {
  let seen = null;
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    seen = JSON.parse(raw);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(chunkFrame({ content: 'ok' }) + '\n\n');
    res.write(chunkFrame({}, 'stop') + '\n\n');
    res.end();
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const shim = await startShim(`http://127.0.0.1:${upstream.address().port}/upstream`);
  try {
    const tools = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }];
    const res = await fetch(shim.base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.secret}` },
      body: JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: 'hi' }], tools }),
    });
    assert.equal(res.status, 200);
    await res.text();
    assert.ok(seen !== null, '上游应收到请求');
    assert.equal(seen.tools.length, 1, 'tools 必须透传到上游');
    assert.equal(seen.tools[0].function.name, 'get_weather');
  } finally {
    await shim.close();
    upstream.close();
  }
});

// ---------------------------------------------------------------------------
// 模型能力声明：模态必须与「附件服务是否可用」保持一致
//
// 历史：曾长期硬编码仅文本，因为当时未接 resolveAttachments——声明 image
// 会让 DSH 走图片路径后抛 "pi-ai image input requires the durable attachment
// service"（连文本对话都失败）。现在插件已接入附件服务，能力改为**动态**：
// 有服务 → 声明 image（真能发图）；无服务 → 退回 text（不假装支持）。
// ---------------------------------------------------------------------------

test('模态声明：附件服务可用时声明 image（视觉生效）', () => {
  for (const info of FALLBACK_QWENWORK_MODELS) {
    const model = toPiModel(info, 'http://127.0.0.1:1/v1/chat/completions', {
      supportsImages: true,
    });
    assert.deepEqual(model.input, ['text', 'image'], `${info.id} 在服务可用时应声明 image`);
  }
});

test('模态声明：附件服务不可用时退回 text（不假装支持）', () => {
  for (const info of FALLBACK_QWENWORK_MODELS) {
    const model = toPiModel(info, 'http://127.0.0.1:1/v1/chat/completions', {
      supportsImages: false,
    });
    assert.deepEqual(model.input, ['text'], `${info.id} 无附件服务时只能声明 text`);
    assert.equal(
      model.input.includes('image'),
      false,
      `${info.id} 不得在无 resolveAttachments 时声明 image——DSH 会抛 durable attachment 错误`,
    );
  }
});

test('模态声明：不传覆盖时沿用目录声明（上游确实具备视觉）', () => {
  for (const info of FALLBACK_QWENWORK_MODELS) {
    const model = toPiModel(info, 'http://127.0.0.1:1/v1/chat/completions');
    assert.deepEqual(model.input, ['text', 'image'], `${info.id} 目录声明 supportsImages: true`);
  }
});

test('模型描述文案与能力声明一致', () => {
  for (const card of catalogForCard()) {
    // 描述必须非空——此前 bug 是引用了已不存在的字段，导致断言在 undefined 上假通过
    assert.equal(
      typeof card.description === 'string' && card.description.length > 0,
      true,
      `${card.id} 的描述缺失`,
    );
  }
});

// ---------------------------------------------------------------------------
// 倍率映射到模型选择器（显示名）
// ---------------------------------------------------------------------------

test('选择器显示名必须带倍率（否则用户看不出贵贱）', () => {
  const base = 'http://127.0.0.1:1/v1/chat/completions';
  const byId = Object.fromEntries(
    FALLBACK_QWENWORK_MODELS.map((info) => [info.id, toPiModel(info, base)]),
  );

  // flash 最便宜，pro 次之，max-preview 最贵
  assert.match(byId.flash.name, /x0\.10/, 'flash 应显示 x0.10');
  assert.match(byId.pro.name, /x1\.00/, 'pro 应显示 x1.00');
  assert.match(byId['qwen3.8-max-preview'].name, /x1\.10/, 'qwen3.8-max-preview 应显示 x1.10');

  // 分隔符与 WorkBuddy 保持一致
  for (const model of Object.values(byId)) {
    assert.ok(model.name.includes(' · '), `显示名应使用 " · " 分隔：${model.name}`);
  }

  // 标记也要可见
  assert.match(byId.pro.name, /默认/, 'pro 应标默认');
  assert.match(byId.flash.name, /推荐/, 'flash 应标推荐');
  assert.match(byId['qwen3.8-max-preview'].name, /新/, 'max-preview 应标新');
});

test('displayName: 拼接顺序为 名称 · 倍率 · 标记', () => {
  const name = displayName({ id: 'x', shortName: '测试模型', billingRate: 0.25, isDefault: true });
  assert.equal(name, '测试模型 · x0.25 · 默认');
});

test('formatRate: 0 倍率显示"免费"，非法值返回空串', () => {
  assert.equal(formatRate(0), '免费');
  assert.equal(formatRate(0.1), 'x0.10');
  assert.equal(formatRate(1), 'x1.00');
  assert.equal(formatRate(1.15), 'x1.15');
  assert.equal(formatRate(Number.NaN), '');
  assert.equal(formatRate(undefined), '');
});

test('选择器显示名的改变不得污染模型 id', () => {
  const base = 'http://127.0.0.1:1/v1/chat/completions';
  for (const info of FALLBACK_QWENWORK_MODELS) {
    const model = toPiModel(info, base);
    assert.equal(model.id, info.id, 'id 必须保持原样——它是上游真正的模型键');
    assert.equal(/[·]/.test(model.id), false, 'id 中不得混入显示用的分隔符');
  }
});

test('卡片保留短名（倍率单独成列，避免重复显示）', () => {
  for (const card of catalogForCard()) {
    assert.equal(
      /x\d+\.\d{2}/.test(card.name),
      false,
      `卡片名不应重复带倍率（已有 rate 列）：${card.name}`,
    );
    assert.equal(typeof card.rate, 'number', '卡片必须有独立的 rate 字段');
  }
});

// ---------------------------------------------------------------------------
// token 统计（usage）：DSH 靠它显示 token 数，缺失则界面无任何数字
// ---------------------------------------------------------------------------

test('parseRawUsage：上游 raw_usage 被转成 OpenAI usage', () => {
  const usage = parseRawUsage({
    data: {
      prompt_tokens: 17,
      completion_tokens: 39,
      total_tokens: 56,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    },
  });
  assert.equal(usage.prompt_tokens, 17);
  assert.equal(usage.completion_tokens, 39);
  assert.equal(usage.total_tokens, 56);
  // cached 为 0 时不写该字段（避免无意义的 0）
  assert.equal('prompt_tokens_details' in usage, false);
});

test('parseRawUsage：cached_tokens > 0 才带上 details', () => {
  const usage = parseRawUsage({
    data: {
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      prompt_tokens_details: { cached_tokens: 64 },
    },
  });
  assert.deepEqual(usage.prompt_tokens_details, { cached_tokens: 64 });
});

test('parseRawUsage：缺失字段不得被编造成 0', () => {
  // 上游没给 data 段 → 无法得到任何可信数字 → 必须返回 null
  assert.equal(parseRawUsage(null), null);
  assert.equal(parseRawUsage(undefined), null);
  assert.equal(parseRawUsage({}), null);
  assert.equal(parseRawUsage({ data: {} }), null);
});

test('parseRawUsage：total 缺失时由 prompt+completion 推导', () => {
  const usage = parseRawUsage({ data: { prompt_tokens: 10, completion_tokens: 5 } });
  assert.equal(usage.total_tokens, 15);
});

test('encodeOpenAiChunk：usage 被编码进 chunk，无 usage 时不出现该字段', () => {
  const withUsage = JSON.parse(
    encodeOpenAiChunk({
      model: 'pro',
      id: 'x',
      created: 1,
      finishReason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    })
      .slice(6)
      .trim(),
  );
  assert.equal(withUsage.usage.total_tokens, 3);

  const without = JSON.parse(
    encodeOpenAiChunk({ model: 'pro', id: 'x', created: 1, finishReason: 'stop' }).slice(6).trim(),
  );
  assert.equal('usage' in without, false, '没有 usage 时不得凭空加字段');
});

test('parseQwenWorkFrame：末帧的 raw_usage 被透出', () => {
  const payload = envelope(
    JSON.stringify({
      choices: [{ delta: {}, index: 0 }],
      raw_usage: { data: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } },
    }),
  );
  const frame = parseQwenWorkFrame(payload);
  assert.equal(frame.kind, 'chunk');
  assert.ok(frame.rawUsage !== undefined, 'rawUsage 必须被透出，否则 shim 拿不到 token 数');
  assert.equal(frame.rawUsage.data.total_tokens, 12);
});

test('shim 端到端：上游给出 raw_usage 时下游收到 usage', async () => {
  const upstream = await startFakeUpstream(async () => ({
    pieces: [
      chunkFrame({ content: '好的' }) + '\n\n',
      envelope(
        JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
          raw_usage: { data: { prompt_tokens: 17, completion_tokens: 3, total_tokens: 20 } },
        }),
      ) + '\n\n',
    ],
  }));
  const shim = await startShim(`http://127.0.0.1:${upstream.port}/upstream`);
  try {
    const res = await fetch(shim.base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.secret}` },
      body: JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const frames = await collectSse(res);
    const parsed = frames.filter((f) => f !== '[DONE]').map((f) => JSON.parse(f));
    const withUsage = parsed.find((c) => c.usage !== undefined);
    assert.ok(withUsage !== undefined, '下游必须收到带 usage 的分块');
    assert.equal(withUsage.usage.prompt_tokens, 17);
    assert.equal(withUsage.usage.total_tokens, 20);
  } finally {
    await shim.close();
    upstream.server.close();
  }
});

// ---------------------------------------------------------------------------
// 上下文窗口：声明必须与发给上游的上限一致
// ---------------------------------------------------------------------------

test('buildInferBody：显式声明 max_input_tokens 与 max_tokens', async () => {
  const { buildInferBody, MAX_INPUT_TOKENS } = await import('../../lib/signer-session.js');
  const body = JSON.parse(
    buildInferBody({ messages: [{ role: 'user', content: 'x' }], modelKey: 'pro' }),
  );
  assert.equal(
    body.model_config.max_input_tokens,
    1_000_000,
    '必须显式声明输入上限——不设时完全依赖上游默认值',
  );
  assert.equal(body.parameters.max_tokens, 32000, '必须显式给出输出上限，否则长输入可能长时间不返回');
  assert.equal(MAX_INPUT_TOKENS, 1_000_000);
});

test('contextWindow 声明与 max_input_tokens 一致（防止溢出判断失准）', async () => {
  // 回归护栏（两次教训都在这）：
  //   ① 曾写 180_000 —— 照搬 Buddy2api 的 max_input_tokens 未实测；
  //      probe-context-limit*.mjs 实测 ≈1.2M tokens 都被上游接受、
  //      ≈1.5M 才被拒 → 真实上限远大于 180K，声明 180K 会让 DSH 过早
  //      拒绝长上下文请求。
  //   ② 也曾写 1_000_000 且 max_input_tokens 为 180000 —— 声明与请求不一致。
  // 不变量：contextWindow === MAX_INPUT_TOKENS === 请求里的 max_input_tokens。
  const { buildInferBody, MAX_INPUT_TOKENS } = await import('../../lib/signer-session.js');
  const body = JSON.parse(buildInferBody({ messages: [{ role: 'user', content: 'x' }] }));

  assert.equal(MAX_INPUT_TOKENS, 1_000_000, '实测上限 1.2M~1.5M，声明取保守的 1M');
  for (const info of FALLBACK_QWENWORK_MODELS) {
    assert.equal(
      info.contextWindow,
      MAX_INPUT_TOKENS,
      `${info.id} 的 contextWindow 必须等于发给上游的 max_input_tokens`,
    );
    const model = toPiModel(info, 'http://127.0.0.1:1/v1');
    assert.equal(model.contextWindow, MAX_INPUT_TOKENS);
    assert.equal(
      model.contextWindow,
      body.model_config.max_input_tokens,
      `${info.id} 声明值 ${model.contextWindow} 与请求中的 ${body.model_config.max_input_tokens} 不一致`,
    );
  }
});

test('maxTokens 声明与 parameters.max_tokens 一致', async () => {
  const { buildInferBody, MAX_OUTPUT_TOKENS } = await import('../../lib/signer-session.js');
  const body = JSON.parse(buildInferBody({ messages: [{ role: 'user', content: 'x' }] }));
  assert.equal(MAX_OUTPUT_TOKENS, 32000);
  assert.equal(body.parameters.max_tokens, MAX_OUTPUT_TOKENS);
  for (const info of FALLBACK_QWENWORK_MODELS) {
    assert.equal(info.maxTokens, MAX_OUTPUT_TOKENS, `${info.id} 的 maxTokens 声明不一致`);
  }
});

// ---------------------------------------------------------------------------
// 上游无响应：两种「静默」都必须有明确结果，绝不让客户端无限等待
// ---------------------------------------------------------------------------

test('shim: 上游接受连接但永不响应 —— 响应头超时兜底，给出 502', async () => {
  // 回归护栏：曾经这里会**永久悬挂**——`fetch()` 等响应头永不 resolve，
  // 而流内看门狗（armIdle）此时还没启动，客户端界面一直转圈且没有任何报错。
  const upstream = http.createServer(() => {
    /* 接受连接，永不响应 */
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const shim = await startShim(`http://127.0.0.1:${upstream.address().port}`, {
    getHeaderTimeoutMs: 500,
  });
  try {
    const started = Date.now();
    const res = await fetch(shim.base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.secret}` },
      body: JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(15000),
    });
    const elapsed = Date.now() - started;
    assert.equal(res.status, 502, '必须给出明确失败，而不是悬挂');
    assert.ok(elapsed < 10000, `必须在超时后尽快返回，实际 ${elapsed}ms`);
  } finally {
    await shim.close();
    upstream.close();
  }
});

test('shim: 流已开始但中途静默 —— 流内看门狗给出 error 帧 + [DONE]', async () => {
  // 注意：必须用一个「发一帧后保持连接不结束」的服务器。
  // startFakeUpstream 发完就 res.end()，上游正常结束，走不到看门狗那条路径。
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(chunkFrame({ content: '开头' }) + '\n\n');
    // 之后既不写也不 end —— 模拟上游卡死
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const shim = await startShim(`http://127.0.0.1:${upstream.address().port}/upstream`, {
    getIdleTimeoutMs: 500,
  });
  try {
    const res = await fetch(shim.base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.secret}` },
      body: JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(res.status, 200);
    const frames = await collectSse(res);
    assert.equal(frames.at(-1), '[DONE]', '看门狗必须收尾，否则下游会一直等');
    assert.ok(
      frames.some((f) => f.includes('upstream produced no data')),
      '必须给出可辨识的超时原因，而不是静默结束',
    );
  } finally {
    await shim.close();
    upstream.closeAllConnections?.();
    upstream.close();
  }
});
