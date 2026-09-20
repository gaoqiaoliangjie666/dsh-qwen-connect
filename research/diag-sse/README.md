# 诊断脚本：SSE 双通道分离问题

`diag-sse.mjs` 等三个脚本用于排查「Qwen 模型回复只有几行 + 后面跟一堆东西」类问题。

## 用法

```bash
node research/diag-sse/diag-sse.mjs        # 原始 SSE 流
node research/diag-sse/diag-content.mjs    # 上游 reasoning_content 与 content 分离
node research/diag-sse/diag-encoded.mjs    # shim 转给 pi-ai 的 OpenAI 格式流
```

## 排查背景

glm-5.2 同时返回 `delta.reasoning_content`（思考链）与 `delta.content`（正文），
shim 转给 pi-ai 时分别映射为 `delta.reasoning_content` / `delta.content` 两个独立字段。
若 DSH 聊天窗把两者都当正文渲染，看到的就是「几行正文 + 一堆思考链」。

**结论**：这是 DSH 客户端渲染层的行为，不是插件缺陷。详见
`docs/SSE双通道诊断报告.md`。
