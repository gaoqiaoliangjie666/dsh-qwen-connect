# 安装到新电脑

`dsh-qwen-connect` 插件的可移植安装包。**零配置**——复用千问办公（QwenWorkCN）桌面 App 的登录态，不需要 API Key。

## 前置条件

| 条件 | 说明 |
|---|---|
| Windows | 凭据解密依赖 Windows DPAPI |
| DSH 已安装并**至少启动过一次** | 需要 `profiles\web` 目录存在 |
| **千问办公桌面 App 已安装并登录** | 插件复用其登录态，**本身不提供账号** |
| Node.js ≥ 22.19 或 ≥ 24 | DSH 自带的 Node 即可 |

> ⚠️ **登录态无法从其他电脑拷贝**：`%APPDATA%\QwenWorkCN` 里的凭据用 Windows DPAPI 加密，
> 密钥绑定当前 Windows 用户账户。**必须在新电脑上重新登录千问办公 App。**

## 一键安装

把整个 `dsh-qwen-connect` 目录拷到新电脑任意位置，然后在该目录下执行：

```powershell
node tools/install-to-dsh.mjs
```

脚本会自动完成三件事：

1. 在 DSH profile 的 `node_modules` 下建立 Junction 指向本目录
2. 在 profile 的 `package.json` 登记三处（`dependencies` / `dsh.profile.bundles` / `pnpm.overrides`），**改动前自动备份**
3. 建立依赖桥，让插件能解析到 DSH 的 peer 依赖

**完成后完全退出并重启 DSH**（host 侧只在启动时加载插件）。

## 常用参数

```powershell
# 预览将要做的改动（不写入）
node tools/install-to-dsh.mjs --dry-run

# 指定插件源目录
node tools/install-to-dsh.mjs --source "D:\somewhere\dsh-qwen-connect"

# 指定 DSH profile（自动探测失败时）
node tools/install-to-dsh.mjs --profile "C:\Users\你\AppData\Roaming\dsh-desktop\harness\profiles\web"

# 显式指定依赖桥位置（peer 依赖解析失败时）
node tools/install-to-dsh.mjs --bridge-dir "D:\Codex开发"

# 卸载（移除接线，不动源码）
node tools/install-to-dsh.mjs --uninstall
```

## 验证是否成功

重启 DSH 后：

1. 打开 **设置 → 插件**，应看到「千问办公」卡片，显示账号 / 积分 / 套餐 / 三个模型
2. 打开**模型选择器**，应有 `QwenWork` 提供方的三个模型：
   - `pro`（高级，1.00x）
   - `flash`（标准，0.10x，最便宜）
   - `qwen3.8-max-preview`（Qwen3.8-Max，1.10x）
3. 选 `pro` 发一条消息试对话

## 安装脚本做了什么（原理）

DSH 插件需要**三个登记点**同时存在才会被加载：

```
dependencies     { "dsh-qwen-connect": "file:./node_modules/dsh-qwen-connect" }
dsh.profile.bundles  [ ..., "dsh-qwen-connect" ]
pnpm.overrides   { "dsh-qwen-connect": "link:./node_modules/dsh-qwen-connect" }
```

外加一个 Junction：

```
profiles\web\node_modules\dsh-qwen-connect
        → 本目录（真实源码位置）
```

以及**依赖桥**：插件源码在 profiles 树之外，其 `import '@deepseek-ai/...'` 需要能解析到
DSH 的 peer 依赖。Node 从模块所在目录**逐级向上**查找 `node_modules`，因此在插件目录的
某个祖先目录放一个指向 `profiles\node_modules` 的 Junction 即可。

> ⚠️ **绝不修改 profile 的 `cordis.patch.yml`**。插件自带的 `dsh.bundle.patch` 会自动应用
> 插件包内的 patch；若在 profile 层再插一条，DSH 会因 `duplicate loader entry id` 启动失败。

## 卸载 / 回滚

```powershell
node tools/install-to-dsh.mjs --uninstall
```

然后重启 DSH。脚本会自动备份 profile 的 `package.json`（文件名带时间戳），
如需手工回滚，用备份覆盖即可。

## 常见问题

**Q: 设置页有卡片，但模型选择器里没有模型？**
A: 完全退出 DSH 再重启。host 侧代码只在启动时加载一次。

**Q: 显示「未找到千问办公登录态」？**
A: 先安装并**登录**千问办公桌面 App。凭据目录应为 `%APPDATA%\QwenWorkCN`。

**Q: peer 依赖解析失败？**
A: 用 `--bridge-dir` 指定一个能向上解析到 DSH node_modules 的目录，
例如插件源码所在的开发根目录。

**Q: 对话报 `pi-ai image input requires the durable attachment service`？**
A: 不应出现。插件已如实声明模型「仅文本」。若出现，说明模型声明被改回支持图片，
而 shim 并未实现图片转发——请检查 `lib/models.js` 的 `supportsImages` 必须为 `false`。

## 已知边界

| 未支持 | 说明 |
|---|---|
| 图片输入 | shim 不转发图片，模型声明为仅文本 |
| 工具调用 | 已支持（透传 `tools`，转换 `tool_calls`） |
| 动态模型目录 | 模型列表静态内置（`/api/v2/model/list` 需签名） |

## 许可与免责

本项目复用千问办公桌面 App 的登录态访问其服务，**仅供个人学习研究**。

- 使用须遵守千问办公 / 阿里云的服务条款
- 不得用于商业用途、批量调用或任何违反服务条款的场景
- 本项目与千问办公、DeepSeek 官方均无关联
- 请勿传播包含个人登录凭据的文件
