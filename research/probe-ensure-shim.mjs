// 验证 ensureChatShim 能真实启动并指向可用端口
import { ensureChatShim, stopChatShim, chatShimBaseUrl, SHIM_UNAVAILABLE_BASE_URL } from '../lib/index.js';

console.log('初始 baseUrl:', chatShimBaseUrl());
console.log('占位常量:', SHIM_UNAVAILABLE_BASE_URL);

const url = await ensureChatShim({ logger: { info: (...a) => console.log('[info]', ...a), warn: (...a) => console.log('[warn]', ...a) } });
console.log('ensureChatShim ->', url);
console.log('chatShimBaseUrl() ->', chatShimBaseUrl());

// 真实验证该地址可用（缺 messages 应得 400，证明 shim 在监听）
const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'pro' }),
});
console.log('探测请求 ->', res.status, (await res.text()).slice(0, 120));

await stopChatShim();
console.log('关闭后 chatShimBaseUrl() ->', chatShimBaseUrl());
