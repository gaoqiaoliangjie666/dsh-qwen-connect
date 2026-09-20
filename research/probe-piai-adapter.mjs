// 探测 PiAiAdapter 的真实调用接口（用于端到端对话验证）
const mod = await import('@deepseek-ai/dsh-llm-pi-ai');
console.log('exports:', Object.keys(mod).join(', '));

const { PiAiAdapter } = mod;
console.log('\nPiAiAdapter.prototype methods:');
for (const k of Object.getOwnPropertyNames(PiAiAdapter.prototype)) {
  console.log(' ', k, typeof PiAiAdapter.prototype[k]);
}
