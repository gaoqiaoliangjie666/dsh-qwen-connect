# Buddy2api 借鉴调研报告（2026-09-11）

调研对象：https://github.com/wicm84266964/Buddy2api （v2.1.8，MIT）

## 一、项目定位对比

| 项 | Buddy2api | 本项目 dsh-qwen-connect |
|---|---|---|
| 形态 | Python 独立网关（`127.0.0.1:8787/v1`） | DSH 插件（host 内置 shim） |
| 通道 | 4 个：WorkBuddy / QClaw / QwenWork / TraeWork | 1 个：QwenWork |
| 签名 | RSA 公钥 PEM（从 asar 提取）加密 | **复用官方 WASM** |
| 认证 | 管理页创建 API Key（绑定通道） | **零配置**，直接复用桌面 App 登录态 |
| 服务对象 | Codex / OpenCode / Cherry / NextChat | DSH 自身 |

**关键差异**：Buddy2api 是"一人多通道网关"，我们是"DSH 内零配置单通道插件"。**定位不同，但 QwenWork 通道的协议实现可直接对照。**

## 二、协议常量对照（`providers/qwenwork/constants.py`）

| 常量 | Buddy2api | 本项目 | 结论 |
|---|---|---|---|
| `GATEWAY` | `https://gateway.qwenwork.cn` | 同 | ✅ 一致 |
| `CHAT_PATH` | `/algo/api/v2/service/pro/sse/agent_chat_generation` | `/api/v2/service/pro/sse/...` | ⚠️ 差异但**不影响**（真实 URL 由 WASM 决定） |
| `CHAT_QUERY` | `FetchKeys=llm_model_result&AgentId=agent_common` | 同 | ✅ 一致 |
| `COSY_VERSION` | `1.1.18`（硬编码，冻结） | **动态解析**（实测 `1.1.32`） | ✅ **我们更优**（不怕上游更新） |
| `CLIENT_TYPE` | `"6"` | `"6"` | ✅ 一致 |
| `BUSINESS_PRODUCT` | `qoder_work` | `qoder_work` | ✅ 一致 |
| `BUSINESS_TYPE` | `agent` | `agent` | ✅ 一致 |
| `SCENE` | **`qwork`** | `assistant` | ⚠️ 差异，实测无影响（见下） |
| `REFRESH_PATH` | `/api/v1/deviceToken/refresh` | — | 供参考 |
| `ACCOUNT_CONTEXT_PATH` | `/api/v1/adapter/user/account-context` | — | 供参考 |
| `MODELS_PATH` | `/api/v2/model/list` | — | 供参考 |
| `RETRYABLE_STATUS` | `{408,409,425,429,500,502,503,504}` | — | **可借鉴**（重试白名单） |

## 三、实测对照实验

### 实验 1：`is_reasoning` 是否是思考链开关？

`providers/qwenwork/chat.py` 中：
```python
reasoning_control = resolve_reasoning_control(payload)
is_reasoning = reasoning_control.enabled is True
# 写入 modelConfig.is_reasoning 与 model_config.is_reasoning
```

**我用简化 prompt 实测（`research/probe-is-reasoning.mjs`，3 个变体各 1 次真实请求）**：

| `is_reasoning` | 正文 | 思考链 | 耗时 |
|---|---|---|---|
| 不设置 | 4 字符 | **0 字符** | 5.5s |
| `false` | 4 字符 | **0 字符** | 3.7s |
| `true` | 4 字符 | 75 字符 | 10.6s |

→ 看起来 `false` 能关闭思考链。

**但用复杂问题复测（`research/probe-is-reasoning-quality.mjs`），结论被推翻**：

| `is_reasoning` | 正文 | 思考链 | 耗时 |
|---|---|---|---|
| `false` | 562 字符 | **145 字符**（仍存在） | 11.9s |
| `true` | 562 字符 | 165 字符 | 9.7s |

**结论**：
1. **`is_reasoning` 不是可靠的思考链开关**——简单 prompt 下像开关，复杂 prompt 下无法关闭
2. **对输出质量无影响**（两个变体正文完全一致，562 字符，数学推理都正确）
3. **耗时差异是简单 prompt + 缓存造成的假象**，复杂场景下无 3 倍差异

### 实验 2：Buddy2api 的完整协议字段是否必要？

**用 3 个变体对照（`research/probe-protocol-variants.mjs`）**：

| 变体 | 结果 | 耗时 | 正文 | 思考 |
|---|---|---|---|---|
| A 基线（本项目当前，无 `chat_context`） | ✅ 200 | 5.9s | 4 | 76 |
| B + `chat_context` | ✅ 200 | 3.5s | 4 | 83 |
| C + Buddy2api 全套字段（`chat_task`/`agent_id`/`session_type`/`parameters` 等） | ✅ 200 | 2.9s | 4 | 112 |

**结论**：
1. **三个变体全部成功，正文一致**——证明**我们的简化实现是正确的**
2. 服务端对缺失字段有合理默认值
3. Buddy2api 的完整字段更规范、可能略快（2.9s vs 5.9s），但**单次数据不足以定论**，且引入完整字段会带来回归风险

## 四、本次调研的可借鉴点（已评估）

| 点 | 价值 | 决策 |
|---|---|---|
| `RETRYABLE_STATUS` 重试白名单 | 中 | **可借鉴**——我们当前无重试策略 |
| `unwrap_sse_payload` 原样透传优先 | 中 | 参考——我们走"解析+重建"，两者结果等价，暂不改 |
| `model_config` 完整字段 | 低 | **不采纳**——实测无必要，且回归风险高 |
| `is_reasoning` 显式设置 | 低 | **不采纳**——实测不能关闭思考链，且对质量无影响 |
| `COSY_VERSION` 硬编码 | 负 | **不采纳**——我们的动态解析更优 |

## 五、方法学教训（与项目既往教训一致）

**单次实验不足以定论。** 本报告实验 1 的第一轮（简单 prompt）给出了"`is_reasoning` 是思考链开关"的错误结论，第二轮（复杂 prompt）立即推翻。

这与项目既往的三次同类错误同构：
- captain 反复重派造成 stale
- verifier 四次读旧状态误判
- captain 靠文件名/大小推断内容（被逐字节比对推翻）

**对策**：关键判定必须用能拿到原始信号的通道，并**在多种输入条件下交叉验证**。

## 六、与"聊天窗显示思考链"问题的关系

用户反馈"只能回复几个字，然后跟一堆东西"——**本次调研确认这不是 `is_reasoning` 或协议字段问题**：

- 上游始终返回 `delta.reasoning_content`（思考链）与 `delta.content`（正文）两个独立通道
- shim 正确转译为 OpenAI 标准字段（`reasoning_content` / `content`）
- DSH 客户端未对 `delta.reasoning_content` 做折叠/隐藏

详见 `docs/SSE双通道诊断报告.md`。
