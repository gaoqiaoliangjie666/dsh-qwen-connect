# App 升级后失效的排查手册（上游契约漂移）

> 本文件由 2026-09-24 那次 **1.0.6 → 1.2.0 故障**的完整排查沉淀。
> 当时症状：插件对话恒定返回 `HTTP 503: Model catalog unavailable`，排查耗时数小时，
> 期间走了两次弯路（见 §5）。**下次 App 升级后先读本文件，别从零开始。**
>
> 配套规格（含逐字段 obf 证据）：`对话/2026-09-24-千问1.2.0适配/` 下的
> `recon-body-spec.md`、`body-fields-spec.md`、`business-field-spec.md`、`image-channel-spec.md`。

---

## 0. 最重要的一条：**503 不是签名问题**

上游把错误放在 **HTTP 200 的 SSE 流信封里**（`statusCodeValue` / `body.message`），
插件 `lib/chat-shim.js` 会把状态码原样透传成 `HTTP <code>: <message>`，
所以表层看像网关/网络问题，实际是业务校验。**判错层会白排几小时。**

| 上游响应 | 指向的层 | 应对 |
|---|---|---|
| HTTP 403，`{"code":"101","message":"Signature invalid"}` | **签名层** | WASM 签名残缺/无效。对照 `Authorization` 字符数：完整约 **1453**，残缺约 **429** |
| 流内 400，`request_id is required` / `session_id is required` | 请求体字段**存在性** | 必填键缺失 |
| 流内 400，`Invalid agent chat JSON body` | `business` **结构非法** | 传了数组/空串/假值 |
| 流内 503，`Model catalog unavailable` | **请求体缺 `business`** | ⚠️ 签名残缺时**同样**返回这个 503，故它**完全不能**用来判断签名好坏 |

---

## 1. 升级后能自动跟上、无需人工干预的部分

不要改这些——它们已经自适应：

- **`Cosy-Version`**：运行时从最新安装目录（`QwenWorkCN/<version>-<build>/`）的 obf 里读
  `COSY_VERSION` 常量。1.0.6→1.2.0 时自动从 `1.1.32` 变为 `1.1.59`，无需改代码。
- **`machineId`**：取凭据的 `loginDeviceId`。
- **凭据解密链**：`Local State` 的 `os_crypt.encrypted_key` → DPAPI → `auth-v2.dat`。
- **签名 URL**：由 WASM 硬编码产出，WASM 不变则不变。

---

## 2. 一定会坏、必须重查的部分（按复发概率排序）

### 2.1 请求体必填字段集合 ← 本次真凶

- 1.2.0 起，**缺 `business` 字段 → 恒定 503**；仅加 `{product:"qoder_work"}` 即恢复正常。
- 消融结论：`product` 是**唯一必需**子字段；`version/type/id/name/sub_task/begin_at/stage`
  逐个删除仍 PASS。
- `business` 必须是**对象**（数组/假值 → 400）。
- 取值来源 `kpe()`：
  ```
  product ∈ {"cli", "ide", "qoder_work"}
  dg() 分支（= env.QODER_WORK_INTEGRATION_MODE === "1"）**只改 product**，
  type 恒为 "agent"（不是 "qoder_work"！）
  ```
- 插件正确取值：`{product:"qoder_work", type:"agent", stage:"init"}`
- **强佐证**：`vg()` 产出的 `client_type`/`business_product`/`business_type`/`scene`
  与插件 `CLIENT_METADATA` **逐字段吻合**（`"6"`/`"qoder_work"`/`"agent"`/`"assistant"`）
  —— 即签名头 `Cosy-Business-Product` 与 body 的 `business.product` **天然同源**，填别的值会自相矛盾。
- body 构造锚点：搜索 `return{request_id:s,`（1.2.0 的 SDK 含 21 个顶层键）。

### 2.2 签名载荷字段结构

- 1.2.0 的 `regenerateRuntimeFields()` 载荷**必须含 `security_oauth_token`**
  （值就是凭据的 `token` 字段）。
- 缺它时 WASM 只产出 **172** 字符的 `encrypt_user_info`，`Authorization` 退化为 **429** 字符残缺签名。
- 该字段**只喂 WASM**，不进 `QoderContext`（`getUserInfoForAuth()` 里没有它）。

### 2.3 混淆符号名与偏移 —— 注释会集体作废

- `kpe` / `dg` / `vg` / `$Wc` / `Bwr` / 偏移 `8815338` 等都是**混淆产物，每次打包全部重排**。
- **不影响运行**（运行靠字段值），但注释里的证据坐标会失效，下次必须重新定位。
- 改进方向：注释从「偏移引用」改为「**搜索锚点 + 期望值**」，
  例如「`return{request_id:s,` 之后的 `tools:<expr>??[]`；该表达式在全 SDK 仅出现 1 次」。

### 2.4 WASM 行为

- 本次旧 1.0.6 的 `research/wasm.bin`（sha256 `B3DDD7C9…`，297238 字节）在 1.2.0 上游**仍可用**。
- 若必须换 WASM：从新 obf 用 base64 魔数 `AGFzbQ` 提取内嵌 WASM，
  配套 glue 也要一并更新，**属独立部署改动，须单独验证后替换并重跑端到端**。
- 打包脚本 `tools/package-plugin.mjs` 只收录 `research/wasm.bin` 与
  `qoder-wasm-glue.mjs`，其余 `research/` 内容排除；`dist` 不含 `test/`（设计意图）。

### 2.5 凭据 schema

- 当前 `auth-v2.dat` 是 `schemaVersion 2`（`token`/`refreshToken`/`expiresAt`/…）。
- 若 App 改成 **at-rest 加密**（参照 WorkBuddy 5.6 的 `{$wbEncrypted:1, envelope}` 方案），
  读取逻辑将整体失效。

---

## 3. 下次排查的最短路径

**第 1 步 · 先定层，再深挖**（不要一上来就读 obf）

用插件真实链路构造请求，按 §0 表格归类响应。现成脚本在
`对话/2026-09-23-WorkBuddy登录态导入/`：

| 脚本 | 用途 |
|---|---|
| `diag-qwen-upstream.mjs` | 三模型逐个探测（最常用，一跑就知道好坏） |
| `probe-real-path.mjs` | 走 `buildInferBody` 全链路，打印 body 字段清单 + 上游原文 |
| `probe-business-verify.mjs` | `business` 消融对照（验证是否缺它导致 503） |

> 记住：**签名无效的判据是 403，不是 503。**

**第 2 步 · 比对契约漂移（已自动化）**

直接跑检测脚本，它会拿当前 SDK 与插件硬编码规格逐项比对并打印差异：

```powershell
$node='E:\software\DSH Desktop\resources\app\node_modules\node\bin\node.exe'
cd <插件目录>
& $node tools/check-upstream-contract.mjs
# 退出码 0 = 无漂移；1 = 有漂移（含差异摘要）
```

它检查 8 项契约（纯静态、**不发网络请求、不消耗积分**；未装 App 时自动跳过）：
body 构造函数键集合、`business` 条件展开、`tools:o?.tools??[]`、
签名载荷是否含 `security_oauth_token`（并列出载荷键）、`kpe()` 常量组、
`COSY_VERSION` 存在性、端点路径、SDK 内是否出现 `llm_model_result`。

**该脚本也已挂进 `tools/verify-all.mjs`**（第 17 步），每次全量验证都会自动跑。

若需**人工**比对，逐项核对以下内容：
- body 顶层键集合（1.2.0 规格：21 固定键 + 4 条件展开 = 25）
- `regenerateRuntimeFields` 载荷键（应为 `uid`/`security_oauth_token`/`organization_id`/`organization_tags`/`data_policy_agreed`）
- `kpe()` 常量组（`"cli"`/`"ide"`/`"qoder_work"`/`"agent"`/`"quest"`）
- `tools:o?.tools??[]`（应全 SDK 仅 1 次）

**第 3 步 · 需要读混淆串时**

用文件顶部自带的解码器还原：base64 + 循环 XOR，1.2.0 的 key 为 `YwXnXr8xjW5k`。
本次即用此法证明 `Model catalog unavailable` / `Invalid agent chat JSON body`
两条文案在 obf 与 `app.asar` 中 **0 命中** → 确认是**服务端文案**，非 SDK 产生。

---

## 4. 环境与操作注意事项（本机 Windows + 中文路径）

- **判断源码行号不要用 `Get-Content` / `[IO.File]::ReadAllBytes`**：
  中文路径 + GBK 默认解码会**行号漂移**，PowerShell 相对路径甚至解析到 `D:\开发\...`。
  请用 `read` 工具或 node 的 `fs.readFileSync`；`git` 能正常处理中文路径。
- **C: → E: 跨盘 `rename` 报 EXDEV**，必须 copy + delete。
- Node 用 `child_process` 以 pipe 捕获子进程输出可能 **EPERM**；改由 PowerShell 重定向到文件再读。
- **App 会自升级且可能中断**：看 `E:\software\Qwen\QwenWorkCN\updater.cfg` 的
  `currentVersion` 与 `installingVersions`；版本记录在 `%APPDATA%\QwenWorkCN\versions.json`。
  **App 版本变更应作为触发契约漂移检测的信号。**
- **DSH 只在启动时装载插件**：改 `lib/` 后必须**完全重启 DSH Desktop** 才生效；
  改完还须重跑 `tools/package-plugin.mjs`，否则 `dist` 仍是旧副本（发布面缺陷）。

---

## 5. 本次的两个错误结论（避免重犯）

1. ❌ **「1.2.0 换了鉴权体系、COSY 老链路被弃用」** —— 错。
   老端点 + COSY 签名**一直在用**，真因是签名载荷与请求体**各缺一个字段**。
2. ❌ **「1.2.0 新增了 14 个字段导致 503」** —— 错。
   1.0.6 与 1.2.0 的 body 顶层键集合**完全相同**（21 键），所谓"新增字段"不存在；
   错因是把 `chat_context:S` 的偏移（8815592）误当成了 body 构造偏移。
   → **教训：版本升级 ≠ 协议新增字段；偏移必须逐字段验证，不能靠"看起来像"。**

**协作经验**：多人/多代理并行反解有实际价值（本次 t8 独立反解纠正了 t1 的
`business.type` 取值错误）；复审要盯「是否有人把断言改弱以迎合实现」，
判别力对照实验可证明「合并冗余断言是否削弱护栏」。
