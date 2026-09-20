// 验证 provider 的 baseUrl 不再是占位常量
import { createQwenWorkAdapter, ensureChatShim, stopChatShim, SHIM_UNAVAILABLE_BASE_URL } from '../lib/index.js';

// 模拟 apply() 的流程：先启动 shim
const url = await ensureChatShim({});
console.log('shim url:', url);

// createQwenWorkAdapter 接受 getBaseUrl
const { adapter } = createQwenWorkAdapter(() => url);
console.log('adapter created:', typeof adapter);

// 取出 provider 的模型列表，检查 baseUrl
const providers = adapter.profiles ? null : null;
// 直接从 profiles 拿
const profiles = adapter.profiles?.() ?? null;
console.log('profiles:', profiles ? [...profiles.keys()] : 'n/a');

// 用 buildModels 的等价路径：直接检查 toPiModel 产物
import { FALLBACK_QWENWORK_MODELS, toPiModel } from '../lib/models.js';
const models = FALLBACK_QWENWORK_MODELS.map((i) => toPiModel(i, url));
console.log('\n模型 baseUrl:');
for (const m of models) console.log(`  ${m.id}: ${m.baseUrl}`);

const hasPlaceholder = models.some((m) => m.baseUrl.includes('PHASE_B_PLACEHOLDER') || m.baseUrl.includes('qwenwork-phase-a-not-wired'));
console.log('\n仍含旧占位常量:', hasPlaceholder);
console.log('全部指向 shim:', models.every((m) => m.baseUrl.startsWith('http://127.0.0.1:') && m.baseUrl.endsWith('/v1/chat/completions')));

await stopChatShim();
