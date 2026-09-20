// 排查接缝改动后 shim 请求为何挂起
import { startChatShim } from '../lib/signer-shim.js';
import { getValidCredential } from '../lib/credentials-seam.js';

console.log('取凭据…');
const t0 = Date.now();
const cred = await getValidCredential();
console.log(`凭据就绪 (${Date.now() - t0}ms) token len=${cred?.token?.length} deviceId len=${cred?.loginDeviceId?.length}`);

const shim = await startChatShim({
  getCredential: async () => getValidCredential(),
  logger: { warn: (...a) => console.log('[warn]', ...a), info: (...a) => console.log('[info]', ...a) },
});
console.log('shim:', shim.baseUrl);

console.log('\n发请求…');
const t1 = Date.now();
const res = await fetch(shim.baseUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'pro', messages: [{ role: 'user', content: 'say ok' }] }),
});
console.log(`响应头 (${Date.now() - t1}ms): HTTP ${res.status} ${res.headers.get('content-type')}`);

let n = 0;
const decoder = new TextDecoder();
for await (const c of res.body) {
  n += 1;
  if (n === 1) console.log(`首个数据块 @${Date.now() - t1}ms`);
  if (n > 5) break;
}
console.log('数据块数:', n);

await shim.close();
