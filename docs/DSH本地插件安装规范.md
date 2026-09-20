# DSH 本地插件安装规范（本地未发布插件）

> 来源：2026-02-21 为 DSH 安装 `dsh-qwen-connect` 时踩坑总结。
> 当时因在 profile 层重复注册 `llm-qwenwork` 导致 **DSH 启动失败**，修正后成功。

## 背景

为 DSH 安装本地开发、未发布到 npm 的插件时：
- 官方 `dsh plugin --profile web add` 走 pnpm/registry 通道，**对本地插件不适用**
- 手工伪造 `.generations` 目录是**高危操作**（目录名 hash + `generation.json` +
  `desired.json` 三处必须一致，写错任何一处会导致 DSH 启动失败）

## ✅ 正确方式：Junction 挂载

### 三步（缺一不可，且不能多做）

**1. 建 Junction**
```powershell
$p   = "C:\Users\HX\AppData\Roaming\dsh-desktop\harness\profiles\web"
$src = "<插件源码绝对路径>"
cmd /c mklink /J "$p\node_modules\<插件名>" "$src"
```

**2. 改 `profiles\web\package.json` 三处**
```jsonc
{
  "dependencies": {
    "<插件名>": "file:./node_modules/<插件名>"        // ①
  },
  "dsh": {
    "profile": {
      "bundles": [ "<插件名>" ]                      // ②
    }
  },
  "pnpm": {
    "overrides": {
      "<插件名>": "link:./node_modules/<插件名>"      // ③
    }
  }
}
```

**3. 重启 DSH**

### ⚠️ 绝对不要改 `profiles\web\cordis.patch.yml`

**这是最容易犯、后果最严重的错误。**

插件的 `package.json` 里声明的 `dsh.bundle.patch = "./cordis.patch.yml"`
会被 DSH **自动应用**。插件自带的 patch 已经完成 provider 注册：

```yaml
# 插件目录内的 cordis.patch.yml（DSH 自动应用）
- insert:
    - id: llm-<name>
      name: <插件名>
```

若再在 **profile 层** 的 `cordis.patch.yml` 写一遍相同 insert，就会：

```
Error: dsh: plugin tree failed to load: failed to apply loader entry include
(cordis:include): duplicate loader entry id: llm-<name>
```

**DSH 直接启动失败。**

### 依赖解析要点

- DSH 的 peer 依赖（`@deepseek-ai/*`、`@earendil-works/*`）装在
  **`profiles\node_modules`**（不是 `profiles\web\node_modules`）
- Node 按**真实路径**向上查找依赖，插件源码路径的祖先链上必须能命中这些包
- 若源码在工作区外（如 `E:\...`），需桥接：
  ```powershell
  # 方式 A：在插件源码父目录建 node_modules 并桥接
  cmd /c mklink /J "<源码父目录>\node_modules\@deepseek-ai" `
       "C:\Users\HX\AppData\Roaming\dsh-desktop\harness\profiles\node_modules\@deepseek-ai"
  cmd /c mklink /J "<源码父目录>\node_modules\@earendil-works" `
       "C:\Users\HX\AppData\Roaming\dsh-desktop\harness\profiles\node_modules\@earendil-works"

  # 方式 B：在插件目录内部建 node_modules 做同样桥接
  ```

  **⚠️ 两种方式只需其一，且均可回滚。本项目实测最终采用「方式 A（父目录桥）」**
  —— 独立验证结论：**父目录桥单独就足够**（移除插件目录内的 `node_modules` 后，
  从 Junction 路径 `import` 插件仍正常）。好处是**交付物目录零污染**。

  实际落点（本项目）：
  ```
  桥位置: E:\Codex开发\DHS开发\node_modules\{@deepseek-ai, @earendil-works}
         （即插件源码的【父目录】，不是插件目录内部）
  ```

### 回滚
```powershell
cmd /c rmdir "$p\node_modules\<插件名>"
# 并用改动前的 package.json 备份覆盖回去
```

## 🔍 安装后自查清单（必跑）

```powershell
# 1) 全盘确认注册点唯一 —— 期望只有插件目录内 1 处
Get-ChildItem $p -Recurse -File -Include "*.yml","*.yaml" | ForEach-Object {
  $h = Select-String -Path $_.FullName -SimpleMatch "llm-<name>" -ErrorAction SilentlyContinue
  if ($h) { $h | ForEach-Object { "$($_.Path):$($_.LineNumber)" } }
}

# 2) cordis.patch.yml 未被改动（hash 应与安装前一致）
Get-FileHash "$p\cordis.patch.yml"

# 3) 从 junction 路径 import 插件（模拟 DSH 加载视角）
node -e "import('file:///<junction路径>/lib/index.js').then(m=>console.log(m.name, m.inject))"
```

## 🛡 DSH 自愈机制

启动失败时 DSH 会**自动移除问题插件**：
- 插件文件移到 `harness\recovery\plugin-removals\<时间戳>-<uuid>\<插件名>\`
- 还原 `package.json`（清掉 dependencies / bundles / overrides 中的条目）
- 还原 `cordis.patch.yml`

所以安装失败不会永久损坏配置，但**仍应先备份**再操作。

## 版本兼容警告

插件与 DSH 核心版本强相关，**不匹配会导致 DSH 启动失败**。
- 本机实测 DSH 核心版本：**`0.1.2-rc.1`**
- 范例插件 `dsh-workbuddy-connect@0.3.2` 的 peerDependencies 写的是 `^0.1.5-rc.1`，
  **与本机不一致**——照抄会导致启动失败
- 写插件 `package.json` 前**必须先确认本机实际核心版本**

## 附：plugin 加载相关的两条实测结论

1. **`__ModuleLoader__.load` 包装格式**：client 侧插件入口必须是
   `window.__ModuleLoader__.load({ id, factory: (require) => {...} })` 的自执行包装，
   **不是** ESM export；末尾需 `exports.apply / exports.inject / exports.name`
2. **client 侧必须整体 try/catch 包裹**：否则 slot API 变动会抛错并触发
   DSH 红色 "Failed to load plugins" 横幅，**连累 host 侧 provider 一起失效**
3. 卡片注册 API（本机 0.1.2 系）用 `key` / `priority`，**不是**旧版的 `id` / `order`

---

## ⚠️ 测试命令的坑（Node 24 + Windows）

```
node --test test/                 # ❌ Node 24 把目录当模块路径 → Cannot find module
node --test "test/**/*.test.mjs"  # ❌ Windows shell 不展开 glob
node --test                       # ✅ 自动发现，递归全部测试文件
```

### ⚠️⚠️ 但无参 `node --test` 有第二个坑：它会递归发现**测试目录之外**的文件

无参 `--test` 按**文件名模式**递归发现整个项目，不只是 `test/`。
本项目实测踩到：`research/` 下 9 个 `test-*.mjs` 探针被当作测试自动执行——
它们**会发起真实 API 调用、消耗账号积分、依赖网络**：

| | 修复前 | 修复后 |
|---|---|---|
| 测试数 | 176（含 9 个"假测试"） | **167** |
| 耗时 | **78 秒** | **1.27 秒** |
| 网络/扣费 | 有（实证积分 2096.3 → 2095.79） | 无 |

**这是交付质量缺陷，不是体验问题**——验证链路污染了被测系统（消耗真实额度），
且结果不可复现。

**对策**：
1. 探针/脚本**不要**用 `test-` 前缀命名（本项目改名为 `probe-*.mjs`）
2. 在验证总控脚本里**加护栏**：扫描非测试目录，若出现 `test-*.mjs` 直接判失败
3. 需要精确范围时，**按文件逐一列出**（见下）

### 需要限定范围时：按文件逐一列出

不要用全量递归——那会把其他任务进行中的测试、以及非测试目录的探针一并计入：

```powershell
node --test test/unit/a.test.mjs test/unit/b.test.mjs test/web-status.test.mjs
```

**必须用 `node --test`（无参数）。** 这个坑曾导致：
- 多次误判为"测试全失败/有回归"
- 验证任务连续两轮无法落库（契约命令客观失败，而验证方拒绝伪造 `passed`）

### 根因
Node 24 起，`node --test <path>` 中的 path 被当作**模块路径**解析，不再接受目录；
而 glob 展开是 shell 的职责，Windows 的 PowerShell/cmd 默认不展开 `**`。

### 任务书契约里要限定范围时
用**按文件逐一列出**，而不是全量递归——避免把其他任务进行中的测试计入本任务判定：

```powershell
node --test test/unit/a.test.mjs test/unit/b.test.mjs test/web-status.test.mjs
```

---

## ⚠️ 编码事故的判据：先看位置，不是看在不在注释里

```
乱码在【首字节】（/** 或 #!/ 之前） → 语法失效，整个文件不可执行，必须重建
乱码在【注释块内部】               → 仅可读性受损，代码逻辑完好
```

**机理**：乱码前缀（如 `E9 94 98 3F`）插在 `/**` 之前时，注释块不再从文件头开始，
紧随其后的 `import` 被当作代码解析 → **整文件报 SyntaxError**。
这解释了"为什么注释里的乱码会让 `import` 报错"这个反直觉现象。

### 根因与禁令
PowerShell 的 `Out-File` / `Set-Content` / `>` **在中文 Windows 上默认使用 GBK**，
把 UTF-8 文件读入再用 GBK 写出，中文变成**不可逆 mojibake**。

**禁用**：
```powershell
node foo.mjs > out.txt              # ❌ 产生 GBK 编码文件
Get-Content a.js | Out-File a.js    # ❌ 读入即损坏
Set-Content a.js (...)              # ❌ 同上
```
**改用**：
- 直接看 stdout（推荐，不要重定向）
- 必须落盘时：显式 `-Encoding utf8`，或写到工作区外的临时目录
- 改文件一律用 **write / edit 文件工具**

### 编码体检（判定请以字节读取为准）
```powershell
# 首字节检查：正常 .js/.mjs 应以 ASCII 起始（i=0x69、/=0x2F、#=0x23）
$b = [IO.File]::ReadAllBytes($f)
if ($b[0] -gt 0x7F) { "首字节异常（可能是乱码或 BOM）" }
```
⚠️ **不要以终端回显判定文件编码**：中文 Windows 的 GBK 控制台会把正常 UTF-8 中文
显示成"假乱码"，造成误判。请用字节读取（`buf.toString('utf8')`）作为权威判据。

---

## 🔬 观测工具本身会失真：关键判定必须用能拿到原始信号的通道

本项目在验证过程中踩到**两处同类陷阱**，都是"观测方法导致的失真"，
且都不是被测对象的问题。

### 陷阱一：控制台回显 ≠ 文件真实编码
中文 Windows 的 GBK 控制台把正常 UTF-8 中文渲染成"假乱码"。
→ 本项目累计**四次**误判（`cordis.patch.yml`、`lib/dpapi.js` ×2、`token-diag.mjs` 读到旧状态）。

**对策**：以字节读取为权威判据
```
信号1  逐字节读取   [IO.File]::ReadAllBytes / fs.readFileSync
信号2  语法检查     node --check
信号3  实际执行     node <file>
三者一致才下结论。
```

### 陷阱二：`.NET HttpWebRequest` 伪造 Host 会返回状态码 0
验证 DNS-rebinding 防护时，用不同方法伪造 `Host` 头，结果不一致：

| 观测方法 | 伪造 `Host: evil.example.com` |
|---|---|
| `.NET HttpWebRequest` | **状态 0**（`MethodInvocationException`，**失真**）❌ |
| 原生 socket | HTTP/1.1 **403 Forbidden** ✅ |
| `curl.exe --header "Host: ..."` | **403** ✅ |
| Node 原生 `http`（`setHost:false`） | **403** ✅ |

**三种真实观测方法一致 403，只有 .NET 那一种失真。**
根因：**.NET 在 Host 与连接目标不一致时，异常会掩盖真实响应状态**。

> 这条曾导致一次未深究的 `HTTP 0` 现象，当时换了方法拿到 403 却没有追根因。
> 现在根因明确，故写入规范。

**对策**：凡涉及伪造 `Host` / `Origin` 头的安全边界测试，
**必须使用原生 socket 或 `curl --header`**；不得使用 `.NET HttpWebRequest`。

### 一般化教训

> **观测工具本身可能失真。关键判定必须使用能拿到原始信号的通道，
> 并尽量多通道交叉验证。**

本项目据此实践的三处交叉验证：
1. **环回防护** —— 原生 socket + curl + Node http **三通道**一致
2. **哈希一致性** —— `realpathSync` + SHA256 逐文件比对（不止验"指向正确"）
3. **文件编码** —— 真 UTF-8 读取 + `node --check` + 实际运行 **三信号**一致
