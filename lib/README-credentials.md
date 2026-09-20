# t1 交付说明：凭据解密 + REST 客户端（阶段 B-1）

> 状态：**已完成并通过真实链路验证**（2026-02-21）
> 负责：crypto-engineer
> 代码位置：`src/`（本目录），共 6 个模块 + 74 个单元测试

## 一、交付的文件

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/errors.js` | 86 | 稳定错误分类 `ErrorCode` / `QwenAuthError`，每类带可操作修复提示 |
| `src/dpapi.js` | 197 | Windows DPAPI 解主密钥（原生 FFI 优先、PowerShell 降级） |
| `src/credentials.js` | 311 | Chromium v10 解密 + 凭据加载/规范化 |
| `src/auth.js` | 234 | token 刷新 + **安全回写（refresh token 轮换）** |
| `src/rest.js` | 250 | REST 客户端（账号/额度/套餐/状态） |
| `src/index.js` | 114 | 统一导出面 + 高层便捷 API |
| `tools/live-check.mjs` | 80 | 真实链路端到端验证工具 |
| `test/unit/*.test.mjs` | 741 | 74 个单元测试（含真实 DPAPI 往返） |

## 二、对外接口（交付契约）

```js
import {
  loadCredentials,      // → 规范化凭据对象（含 masterKey，仅供内部回写用）
  getValidToken,        // → { token, credentials, refreshed, warning? }
  getAccountInfo,       // → { name, username, tier, planId, quota, refreshed }
  getQuota,             // → { remaining, totalUsagePercentage, isQuotaExceeded, ... }
  getSession,           // → { token, credentials, account: { name, tier, planId, quota, page, user } }
  probeCredentials,     // → { ok: true, credentials } | { ok: false, error }（不抛异常，供 UI 首屏）
  describeCredentials,  // → 脱敏摘要，可安全写日志
  QwenAuthError, ErrorCode, isQwenAuthError,
} from './src/index.js';
```

## 三、⚠️ 实测修正的重要事实（与探测报告的差异）

### 1. token 刷新端点：**已打通**（探测报告当时标注"未验证"）

```
POST https://gateway.qwenwork.cn/api/v1/deviceToken/refresh
Content-Type: application/json
Body: {"refresh_token": "<auth-v2.dat 的 refreshToken 原值>"}

→ 200 {
    "device_token": "<555 字符，可直接用于所有 REST 端点>",
    "refresh_token": "<新值>",        ← 会轮换！
    "token_type": "bearer",
    "expires_at": "2026-09-18T06:12:11Z",   (7 天)
    "expires_in": 604800,
    "created_at": "..."
  }
```

**关键修正（务必遵守）**：
- 字段名必须是 **snake_case** 的 `refresh_token`。
  camelCase 的 `refreshToken`、以及 `loginDeviceId` / `device_id` / `token` /
  `grant_type` 等字段一律被拒：
  `{"errorCode":"INVALID_REFRESH_REQUEST",...,"reason":"not_allowed"}`
  **即：刷新不需要、也不接受 loginDeviceId**（与任务描述中的假设相反）。
- **刷新不需要 Authorization 头**（带与不带均 200）。
- `/api/v1/jobToken/refresh` 返回 **404**，是无效端点，不要用。
- `GET` 该端点返回 404，必须 `POST`。

### 2. refresh_token 会轮换 → **必须回写**

响应里的 `refresh_token` 是新值。若只更新内存而不回写凭据文件，App 与插件会
各自持有不同代际的 refresh token，后续刷新互相失效。
`persistRefreshedCredentials()` 已实现：保持 v10 加密、原子替换
（写临时文件后 `renameSync`）、只改 token 相关字段、其余字段原样保留。

### 3. DPAPI 解密的真实依赖

Windows PowerShell 5.1 里 `[Security.Cryptography.ProtectedData]` **默认不可见**，
必须先 `Add-Type -AssemblyName System.Security`，否则报
`Unable to find type [Security.Cryptography.ProtectedData]`。
（`[Reflection.Assembly]::Load('System.Security')` 无效，不要用。）

### 4. account-context 的真实字段形状

```json
{"data":{
  "user":{"id","name","username","email","is_biz","is_verified","is_active"},
  "plan":{"pid","name","user_type","is_personal_version","is_subscribed",
          "subscription_status","period","next_due_date","next_deduct_date",
          "sessions","storage"},
  "quota":{"total":null,"used":null,"remaining":2100,"exceeded":false},
  "page":{"page_quota":5,"month_requests":100000,"month_traffic":"5GB",...}
}}
```
注意：Free 套餐 `quota.total` 与 `quota.used` 服务端返回 **null**（不是 0）；
`page_quota` 在 **`page` 段**，不在 `plan` 段。

## 四、验证命令与结果

```powershell
# 单元测试（自造 fixture，不接触真实凭据）
node --test "test/unit/*.test.mjs"
# → tests 74 / pass 74 / fail 0

# 真实链路（只读）
node tools/live-check.mjs
# → ✓ 解密成功 / ✓ REST 200 / name=Test User tier=Free planId=subscription-cn-free 积分=2100

# 真实链路（含刷新与回写）
node tools/live-check.mjs --refresh
# → refreshed=true, refresh token 已轮换, 无 warning（回写成功）
```

真实链路验证输出摘要：
```
已过期: false  | 剩余有效期: 7 天
refreshed: true | 新 token 长度 555 | refresh token 已轮换: true
user.name=Test User | plan.name=Free | plan.pid=subscription-cn-free | quota.remaining=2100
```

集成层接缝复验（`lib/credentials-seam.js`）：
```
isWired: true
fetchPlan:  {"tierName":"Free","tier":"subscription-cn-free","isPersonal":true}
fetchQuota: {"remaining":2100,"total":null,"used":null,...}
getValidToken: 返回 555 字符 token ✓
```

## 五、安全约束落实

1. **绝不落盘明文**：回写走 `encryptV10`，已验证文件内不含 token 明文（`v10` 前缀 + AES-GCM）。
2. **绝不写日志**：`describeCredentials()` 只输出长度/布尔/脱敏 ID（`1c0ec6c9...`）；
   所有错误信息不含 token；测试 `describeCredentials 不泄露 token 明文` 与
   `错误对象不含 token 明文` 强制保障。
3. **密钥仅在内存**：`masterKey` 只挂在凭据对象上，不序列化、不进配置。
4. **配置无密钥**：`src/` 全文扫描无硬编码 token/secret/password。
5. **测试不用真实凭据**：全部 fixture 由 `crypto.randomBytes(32)` 自造密钥生成。
6. **临时文件**：回写用 `.tmp` + 原子 rename，异常路径清理，有测试保证无残留。

## 六、已知限制

1. **仅支持 Windows**：DPAPI 是 Windows 专有；非 win32 平台抛 `UNSUPPORTED_PLATFORM`。
2. **DPAPI 依赖 PowerShell 兜底**：本机未安装 `koffi`/`ffi-napi`，走 PowerShell 子进程
   （每进程约几十毫秒）。若环境禁用了 `powershell.exe`，会抛 `DPAPI_FAILED`。
   原生 FFI 路径已实现但未在本机实测（未安装该依赖）——**若集成层需要更低延迟，
   可安装 `koffi` 后自动启用**。
3. **回写并发**：若 App 与插件同时刷新，存在理论上的竞态。当前策略是
   「谁刷新谁回写、后写覆盖」，未加文件锁。风险低（刷新仅每 7 天一次），
   但极端情况下需重开 App。
4. **`quota.total` 为 null**：Free 套餐无总量，故 `usedPercentage` 为 null。
   卡片不应显示 `0%` 或 `NaN`，需按 null 处理显示「不限/未提供」。
5. **`/api/v2/model/list` 与会话端点仍需 WASM 签名**（403），属阶段 A 范围，
   本模块不涉及。
