# 插件对话链路诊断报告（2026-09-11）

## 背景

`dsh-qwen-connect` 插件在 DSH 中调用 Qwen 模型做对话的链路已端到端跑通。
某次用户反馈："DSH 聊天窗里只能回复几个字，然后跟一堆这个东西"。

## 诊断方法

用三个诊断脚本（归档在 `research/diag-sse/`）抓真实 SSE 流，分离两个独立通道：

| 脚本 | 用途 |
|---|---|
| `diag-sse.mjs` | 抓 shim 转给 pi-ai 的原始 SSE 字节流 |
| `diag-content.mjs` | 分离上游 `delta.reasoning_content` 与 `delta.content` |
| `diag-encoded.mjs` | 分离 shim 转给 pi-ai 的最终 OpenAI 格式流 |

**重要**：抓流时**不要用 `chunk.toString('utf8')`**——Uint8Array 的默认 `toString()` 会逐字节转成 ASCII 数字（`100,97,116,97,58,...`）。**必须**用：
```js
const decoder = new TextDecoder('utf-8');
for await (const chunk of res.body) {
  const text = decoder.decode(chunk, { stream: true });
  // ... 处理 text
}
buf += decoder.decode(); // 末尾 flush
```

## 实测结果

用 `model: "pro"` 提问"用一句话介绍下自己"：

```
下游 delta.content           42 字符: "我是一个由Z.ai训练的大型语言模型，旨在通过回答问题、生成文本和与你交谈来帮助你。"
下游 delta.reasoning_content 2645 字符: "1.  **拆解用户请求**：\n    *   核心任务：用一句话介绍下自己\n..."
finish_reason: stop ✅
```

shim 与 pi-ai 拿到的就是这两个独立通道，完全符合 OpenAI 推理模型标准。

## 根因

**问题不在插件。** DSH 客户端代码（`profiles/web/node_modules/@deepseek-ai/dsh-client-*`）**没有对 `delta.reasoning_content` 字段做特殊处理**——它没读这个字段、或者读了但没折叠/隐藏。

`@nanmicoder/dsh-agent-teams` 里的 `reasoning` 关键词都是 plan 编排层面的 **reasoning effort**（low/medium/high/xhigh），与上游模型的 `reasoning_content` 不是一个概念。

## 用户决策

用户选 **B**：**保留思考链，靠 DSH 客户端自己处理显示/折叠**。

**本项目不做代码改动**——等 DSH 客户端侧修复。

## 复现与排查

将来遇到同类问题（"几行字 + 一堆"）按以下顺序排查：

1. 跑 `node research/diag-sse/diag-content.mjs` 看上游两个通道的实际内容
2. 跑 `node research/diag-sse/diag-encoded.mjs` 看 shim 转给 pi-ai 的内容
3. 如果两个通道都正常、问题在 DSH 客户端渲染——这与本插件无关
4. 如果某个通道缺失/损坏——回到 `lib/sse.js:228-234` 看 `parseQwenWorkFrame` 转换逻辑
