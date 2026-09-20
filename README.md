# dsh-qwen-connect

把**千问办公（QwenWorkCN）桌面 App** 的登录态自动接入 DeepSeek Harness ——
零配置，不需要 API Key，不需要另外登录。

## 它做什么

| 能力 | 状态 |
|---|---|
| Provider 注册（模型出现在 DSH 模型选择器，名称含倍率） | ✅ |
| 设置卡片：账号 / 积分 / 套餐 / 模型列表（含配额进度条） | ✅ |
| 凭据解密（Chromium v10 + Windows DPAPI） | ✅ |
| 账号 / 额度 / 套餐 REST 查询 | ✅ |
| **真实对话**（WASM 签名 + SSE 聊天端点） | ✅ |
| **流式输出 + 多轮上下文** | ✅ |
| **工具调用**（`tools` 透传 + `tool_calls` 协议转换） | ✅ |
| **图片输入**（DSH 附件服务 → `chat_context.imageUrls`） | ✅ |
| **token 统计**（上游 `raw_usage` → OpenAI `usage`） | ✅ |
| **上游重试**（限流 / 网关瞬时故障，最多 3 次） | ✅ |
| **请求方鉴别**（shim 共享密钥 + 常量时间比较） | ✅ |
| 动态模型目录 | ❌ 静态内置（`/api/v2/model/list` 需签名） |

## 图片输入（视觉）

上游模型具备视觉能力，本插件已打通完整链路。DSH 侧的三个条件必须同时成立：

1. 模型描述符声明 `image` 模态（`lib/models.js`）
2. pi-ai 配置了 `resolveAttachments`（`lib/index.js` 从 `ctx.get('attachments')` 取）
3. shim 把图片转成上游认的形态

**前两条是联动的**：插件按附件服务是否可用动态决定是否声明 image
（`createQwenWorkAdapter` 的 `imagesAvailable`）——避免「声明了却用不了」
（DSH 会抛 `pi-ai image input requires the durable attachment service`）。

**上游要同时收到两样东西才认图**（六变体对照实验的结论，
见 `research/probes-2026-09-14/probe-image-format.mjs`）：

| 条件 | 位置 |
|---|---|
| ① 有图标记 | `chat_context.imageUrls`（data URL 数组，无图时为 `null`） |
| ② 多模态内容 | `messages[].content` 是含 `image_url` 的**数组** |

任一缺失，模型都会回复「我没有看到您上传的图片」。因此 `toQwenWorkMessages`
对含图消息**保留数组 content**（不再塌缩成纯文本），`collectImageUrls`
只取**最后一条 user 消息**里的图（避免重复分析历史图）。

## 架构

```
lib/index.js            host 侧入口：注册 qwenwork provider + 挂载状态路由
lib/client.js           浏览器侧入口：设置卡片（__ModuleLoader__.load 包装）
lib/web-status.js       状态路由：loopback-only + JWT 脱敏，汇总卡片数据
lib/credentials-seam.js 与凭据层的唯一接缝（不重复实现解密）
lib/signer-session.js   WASM 签名会话 + 请求体构造
lib/chat-shim.js        环回聊天 shim：OpenAI ↔ QwenWork 协议转换 + 工具调用 + token 统计
lib/signer-shim.js      chat-shim 的稳定转发层（集成方从此导入）
lib/sse.js              健壮 SSE 解析 + OpenAI 分块编码 + usage 归一化
lib/runtime-identity.js Cosy-Version / machineId 的动态解析与多级回退
lib/models.js           静态模型目录（取自 App 日志的 rawModels，未臆造）
lib/loopback.js         环回访问判定（挡 DNS-rebinding）
lib/status-paths.js     host / client 共享常量
```

凭据与 REST 实现（`lib/credentials.js`、`lib/auth.js`、`lib/rest.js`、
`lib/errors.js`、`lib/dpapi.js`、`lib/api.js`）。集成层**只通过接缝消费**，
不重复实现任何解密逻辑。

## 模型目录

三个模型均取自 App 日志的 `rawModels`，无臆造：

| id | 名称 | 倍率 | 视觉 | 上下文 |
|---|---|---|---|---|
| `pro` | 高级 | 1.00x | ✅ | 1M（默认） |
| `flash` | 标准｜Qwen3.8-Flash | 0.10x | ✅ | 1M |
| `qwen3.8-max-preview` | Qwen3.8-Max | 1.10x | ✅ | 1M |

`maxOutputTokens: 32000`；可选上下文档位 200K / 400K / 1M。

## 安全边界

1. **绝不下发凭据**：状态路由只回状态摘要，token 从不跨到浏览器。
2. **错误信息脱敏**：`eyJ...` 形态 JWT、`Bearer xxx`、`token=...` 一律替换后
   才下发（卡片是浏览器渲染面，泄漏即等于泄漏到 DOM 与 devtools）。
3. **只信任环回**：Host 必须是 `127.0.0.1` / `localhost` / `[::1]`，非空
   Origin 也必须是环回 —— 挡掉 DNS-rebinding 页面。
4. **不编造数值**：上游返回 `null` 的额度字段保持缺失，不会 `Number(null) → 0`
   显示成「已用 0」。
5. **失败降级**：凭据缺失 / 加载失败时显式抛 `QwenAuthError`，卡片显示可操作
   的修复提示；`apply()` 永不抛异常（避免 DSH 红色 "Failed to load plugins" 横幅）。

## 验证

```powershell
node tools/verify-all.mjs        # 一键跑全部 5 项
```

| 项目 | 内容 |
|---|---|
| `test/web-status.test.mjs` | 12 项：脱敏、环回 403、凭据错误降级、null 不变成 0 |
| `tools/client-load-check.mjs` | 5 项：`__ModuleLoader__` 契约、slot `key`/`priority`、slot API 损坏时降级 |
| `tools/host-load-check.mjs` | host 入口可加载性 |
| `tools/apply-check.mjs` | provider 注册行为 12 项断言（含两条降级路径） |
| `tools/seam-live-check.mjs` | 端到端真实 API 实测 + JWT 不下发断言 |

端到端实测输出（合成示例，实际值随账号与消耗变化）：
```
nickname: Test User   account: testuser01   remaining: 2100   tierName: Free
```

## 安装

插件通过 Junction 挂载进 profile（源码改动即时生效，无需重新物化）：

```powershell
$d = "E:\Codex开发\DHS开发\dsh-qwen-connect"
$w = "$env:APPDATA\dsh-desktop\harness\profiles\web"

# 1) 依赖桥：让 peer 依赖可解析（源码目录不在 profiles 树下）
foreach ($ns in @("@deepseek-ai", "@earendil-works")) {
  cmd /c mklink /J "$d\node_modules\$ns" `
         "$env:APPDATA\dsh-desktop\harness\profiles\node_modules\$ns"
}

# 2) 挂进 profile
cmd /c mklink /J "$w\node_modules\dsh-qwen-connect" "$d"

# 3) 在 profile 的 package.json 里登记
#    dependencies: "dsh-qwen-connect": "file:./node_modules/dsh-qwen-connect"
#    dsh.profile.bundles: "dsh-qwen-connect"
```

### 回滚

```powershell
$w = "$env:APPDATA\dsh-desktop\harness\profiles\web"
cmd /c rmdir "$w\node_modules\dsh-qwen-connect"
cmd /c rmdir "E:\Codex开发\DHS开发\dsh-qwen-connect\node_modules\@deepseek-ai"
cmd /c rmdir "E:\Codex开发\DHS开发\dsh-qwen-connect\node_modules\@earendil-works"
# 再用备份覆盖 profile 配置
Copy-Item "$w\_backup-qwen-connect-20260911-141226\package.json" "$w\package.json" -Force
Copy-Item "$w\_backup-qwen-connect-20260911-141226\cordis.patch.yml" "$w\cordis.patch.yml" -Force
```

## 已知限制

1. **仅 Windows**：凭据解密走 Windows DPAPI。
2. **工具调用 / 视觉输入未支持**：文本流式对话与多轮已打通；但
   `tool_calls` 未做协议转换，图片输入会被 shim 丢弃（`toQwenWorkMessages()`
   只保留 `type: 'text'` 块）。**不要依赖这两项能力。**
3. **DPAPI 依赖 PowerShell 兜底**：本机未装 `koffi`/`ffi-napi`，走 PowerShell
   子进程（每进程约几十毫秒）。
4. **模型目录是静态的**：`/api/v2/model/list` 需要 WASM 签名（403），
   目前用内置的三模型目录，不动态拉取。
5. **`quota.total` 对 Free 套餐为 null**：卡片按「未提供」处理，不显示 0%。
6. **签名依赖官方 WASM**：`research/wasm.bin` 是从 App 产物提取的签名模块，
   **不随插件发布**；换机器需重新提取（`node research/wasm-extract.mjs`）。
7. **`Cosy-Version` 动态解析**：优先读 App 产物里 SDK 的 `COSY_VERSION`
   常量（实测 `1.1.32`），失败时回退安装目录版本号，最后回退常量。
   来源会记在 `signerSession.describe().cosyVersion.source` 里。

## 聊天接入架构（阶段 A-2）

```
DSH / pi-ai ──OpenAI 协议──▶ 环回 shim ──WASM 签名+加密──▶ gateway.qwenwork.cn
            ◀──OpenAI SSE──           ◀──双层信封 SSE──
```

- shim 由 `lib/chat-shim.js` 实现，监听 `127.0.0.1` 随机端口，**仅接受环回
  请求**（Host/Origin 双校验，挡 DNS-rebinding）。
- provider 的 `baseUrl` 在 shim 就绪后指向
  `http://127.0.0.1:<port>/v1/chat/completions`。
- **签名头 `Authorization: Bearer COSY.<...>` 由官方 WASM 生成，绝不能被
  `Bearer <accessToken>` 覆盖**（覆盖即 403 Signature invalid）。
