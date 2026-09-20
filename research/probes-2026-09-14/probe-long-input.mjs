// research/probe-long-input.mjs
// 定位超长输入超时的原因：上游慢、还是我们等待姿势不对。
import { startChatShim } from '../lib/chat-shim.js';
import { loadCredentials } from '../lib/credentials.js';
import { DEFAULT_ENDPOINT } from '../lib/signer-session.js';

const shim = await startChatShim({
  getCredential: async () => loadCredentials(),
  endpoint: DEFAULT_ENDPOINT,
  logger: { warn: (...a) => console.log('    [warn]', ...a.map((x) => String(x).slice(0, 90))) },
});

/** 直接调上游，绕开 shim，测出上游真实耗时。 */
async function directUpstream(label, content, timeoutMs) {
  const { createSignerSession, buildInferBody } = await import('../lib/signer-session.js');
  const cred = await loadCredentials();
  const session = await createSignerSession({ credential: cred, endpoint: DEFAULT_ENDPOINT });
  const body = buildInferBody({ messages: [{ role: 'user', content }], modelKey: 'pro' });
  const signed = session.signInferRequest(body, { modelKey: 'pro', modelSource: 'system' });
  const t0 = Date.now();
  try {
    const res = await fetch(signed.url, {
      method: 'POST',
      headers: signed.headers,
      body: signed.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    let bytes = 0;
    let frames = 0;
    const dec = new TextDecoder('utf-8');
    let buf = '';
    for await (const c of res.body) {
      bytes += c.length;
      buf += dec.decode(c, { stream: true });
      const evs = buf.split('\n\n');
      buf = evs.pop() ?? '';
      frames += evs.length;
    }
    console.log(`  ✅ ${label}: 上游直连 HTTP ${res.status} | ${Date.now() - t0}ms | ${bytes}B / ${frames} 帧`);
    await session.dispose?.();
    return true;
  } catch (e) {
    console.log(`  ❌ ${label}: 上游直连失败 ${e.message.slice(0, 70)} | ${Date.now() - t0}ms`);
    await session.dispose?.();
    return false;
  }
}

console.log('=== 上游直连（绕开 shim）===');
await directUpstream('短输入(10字)', '说：好', 60000);
await directUpstream('中输入(500字)', '重复一遍：' + '测'.repeat(500), 90000);
await directUpstream('长输入(2000字)', '重复一遍：' + '测'.repeat(2000), 120000);

await shim.close();
process.exit(0);
