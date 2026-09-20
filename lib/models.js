/**
 * 静态内置的模型目录。
 *
 * 来源：QwenWorkCN 桌面 App 日志中的模型列表（`rawModels` 字段，实测取得）。
 * 阶段 B 不依赖 upstream 动态拉取，保证离线时 provider 不会是空的。
 *
 * 三个模型均取自 App 实际返回，未臆造：
 *   pro                  — 高级（默认模型，isDefault: true）
 *   flash                — 标准｜Qwen3.8-Flash（tags: ["is_recommend"]）
 *   qwen3.8-max-preview  — Qwen3.8-Max（isNew: true，官方描述「千问最强模型」）
 *
 * @module dsh-qwen-connect/models
 */

/** 本插件拥有的 provider 路由 id。 */
export const QWENWORK_PROVIDER = 'qwenwork';

/**
 * 上下文窗口与输出上限。
 *
 * ⚠️ **`MAX_INPUT_TOKENS` 必须与发给上游的 `model_config.max_input_tokens` 一致**
 * （见 `signer-session.js` 的 `buildInferBody`）。
 *
 * 真实上限的确定过程（教训记录）：
 *   1. App 日志表格列标注「1M」
 *   2. Buddy2api 的 `model_config.max_input_tokens` 写 180000
 *   3. 曾照搬 180000 —— **实测证明是错的**：
 *      probe-context-limit*.mjs 的对照实验显示
 *      ≈150K/200K/400K/700K/850K/1.0M/1.2M tokens 全部被上游接受，
 *      ≈1.5M 才被拒（"Error in upstream response"）。
 *      → 真实上限在 1.2M~1.5M 之间，「1M」是保守而合理的声明值。
 *
 * 声明与实现不一致是本项目反复出现的一类缺陷；这次是**照搬外部值未实测**。
 */
export const MAX_INPUT_TOKENS = 1_000_000;
/** 单次回复的输出上限（与 `parameters.max_tokens` 一致）。 */
export const MAX_OUTPUT_TOKENS = 32000;

/**
 * 静态回退目录。
 *
 * 每条都直接取自 App 日志的 `rawModels`，未臆造任何字段：
 * `priceFactor` → `billingRate`，`isVl` → `supportsImages`，
 * `defaultContextWindow` → `contextWindow`，
 * `availableContextWindows` → 原样保留（三档：200K / 400K / 1M）。
 *
 * @type {Array<{
 *   id: string,
 *   name: string,
 *   description: string,
 *   billingRate: number,
 *   supportsImages: boolean,
 *   contextWindow: number,
 *   availableContextWindows: number[],
 *   maxTokens: number,
 *   isDefault?: boolean,
 *   isRecommended?: boolean,
 *   isNew?: boolean,
 * }>}
 */
/**
 * 上游模型**具备视觉能力**（App 的 `rawModels` 里 `is_vl: true`），
 * 因此这里如实声明 `supportsImages: true`。
 *
 * 但声明只是前提之一——DSH 走图片路径还需要**两个条件同时满足**：
 *   ① 模型描述符声明 image 模态
 *   ② pi-ai 配置了 `resolveAttachments`（DSH 的持久化附件服务）
 *
 * 若只有 ① 没有 ②，DSH 会直接抛
 * `pi-ai image input requires the durable attachment service`（连文本对话都失败）；
 * 若只有 ② 没有 ①，图片会被投影成文本占位符，用户传了图却等于没传。
 *
 * 因此 `toPiModel` 接受 `{ supportsImages }` 覆盖：**由调用方按附件服务
 * 是否可用传入**，保证「声明」与「能力」始终一致（见 lib/index.js 的
 * `imageDepsFrom`）。
 */
export const FALLBACK_QWENWORK_MODELS = [
  {
    id: 'pro',
    shortName: '高级',
    billingRate: 1,
    supportsImages: true,
    contextWindow: MAX_INPUT_TOKENS,
    availableContextWindows: [MAX_INPUT_TOKENS],
    maxTokens: MAX_OUTPUT_TOKENS,
    isDefault: true,
  },
  {
    id: 'flash',
    shortName: '标准｜Qwen3.8-Flash',
    billingRate: 0.1,
    supportsImages: true,
    contextWindow: MAX_INPUT_TOKENS,
    availableContextWindows: [MAX_INPUT_TOKENS],
    maxTokens: MAX_OUTPUT_TOKENS,
    isRecommended: true,
  },
  {
    id: 'qwen3.8-max-preview',
    shortName: 'Qwen3.8-Max',
    billingRate: 1.1,
    supportsImages: true,
    contextWindow: MAX_INPUT_TOKENS,
    availableContextWindows: [MAX_INPUT_TOKENS],
    maxTokens: MAX_OUTPUT_TOKENS,
    isNew: true,
  },
];

/**
 * 把倍率格式化成选择器里显示的文本。
 *
 * 形态对齐 WorkBuddy（`Hy3 · x0.00 · 限时免费`）：
 *   - 0 倍率 → `免费`
 *   - 其它   → `x1.00` / `x0.10` / `x1.10`
 *
 * @param {number} rate
 * @returns {string}
 */
export function formatRate(rate) {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return '';
  if (rate === 0) return '免费';
  return `x${rate.toFixed(2)}`;
}

/**
 * 生成模型选择器里显示的名字：`名称 · 倍率 · 标记`。
 *
 * ⚠️ 这是**唯一的显示名来源**——DSH 的模型选择器渲染的就是 pi-ai 模型描述符
 * 的 `name` 字段（见 dsh-workbuddy-connect 的 `toPiModel`，它直接透传
 * 上游 `name`，而该值本身就形如 `Hy3 · x0.00 · 限时免费`）。
 * 倍率必须拼进 `name` 才会出现在选择器里；单独放 `billingRate` 字段
 * 只有设置卡片能看到。
 *
 * @param {typeof FALLBACK_QWENWORK_MODELS[number]} info
 * @returns {string}
 */
export function displayName(info) {
  const parts = [info.shortName ?? info.id];
  const rate = formatRate(info.billingRate);
  if (rate !== '') parts.push(rate);
  if (info.isDefault === true) parts.push('默认');
  if (info.isRecommended === true) parts.push('推荐');
  if (info.isNew === true) parts.push('新');
  return parts.join(' · ');
}

/**
 * 卡片与选择器共用的描述文案。
 *
 * @param {typeof FALLBACK_QWENWORK_MODELS[number]} info
 * @returns {string}
 */
function describeModel(info) {
  const rate = formatRate(info.billingRate);
  const ctx = info.contextWindow >= 1000000 ? '1M' : `${Math.round(info.contextWindow / 1000)}K`;
  return [`仅文本`, ctx, rate === '' ? undefined : rate === '免费' ? '免费' : rate]
    .filter(Boolean)
    .join(' · ');
}

/** 供卡片展示的精简模型行。 */
export function catalogForCard() {
  return FALLBACK_QWENWORK_MODELS.map((model) => ({
    id: model.id,
    // 卡片显示短名（倍率已单独成列），选择器则用带倍率的长名。
    name: model.shortName ?? model.id,
    description: describeModel(model),
    rate: model.billingRate,
    ...(model.isDefault === true ? { isDefault: true } : {}),
    ...(model.isRecommended === true ? { isRecommended: true } : {}),
    ...(model.isNew === true ? { isNew: true } : {}),
  }));
}

/**
 * 把静态目录条目转成 pi-ai 的模型描述符。
 *
 * `name` 是**模型选择器显示的那一行文本**——因此这里用 `displayName()`
 * 把倍率拼进去（形如 `高级 · x1.00 · 默认`），否则选择器只会显示干巴巴的
 * 名称，用户看不到谁贵谁便宜。
 *
 * @param {typeof FALLBACK_QWENWORK_MODELS[number]} info
 * @param {string} baseUrl 该 provider 的请求基址
 * @param {{ supportsImages?: boolean }} [opts]
 *        `supportsImages` 覆盖：**由调用方按附件服务是否可用传入**。
 *        不传则沿用目录里的声明。这样当宿主没有附件服务时，模态会退回
 *        `['text']`，避免 DSH 走图片路径后抛
 *        `pi-ai image input requires the durable attachment service`。
 */
export function toPiModel(info, baseUrl, opts = {}) {
  const supportsImages = opts.supportsImages ?? info.supportsImages === true;
  return {
    id: info.id,
    name: displayName(info),
    api: 'openai-completions',
    provider: QWENWORK_PROVIDER,
    baseUrl,
    input: supportsImages ? ['text', 'image'] : ['text'],
    /**
     * 上游确实返回思维链，置 true 让 pi-ai 把 `reasoning_content` 识别为
     * 独立的 thinking 块，而不是混进正文渲染。
     *
     * 实测依据：glm-5.2 在 `choices[0].delta.reasoning_content` 里给出思维链
     * （见 research/probe-reasoning-vs-content.mjs）。此前置 false 时，思维链
     * 会被当作普通 text 输出，用户会在回答里看到模型的内心独白。
     */
    reasoning: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
  };
}
