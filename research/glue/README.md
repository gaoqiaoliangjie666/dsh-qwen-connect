# 逆向中间产物说明（research/glue/ 与 research/wasm/）

> 本目录存放阶段 A-1（WASM 签名逆向）的**中间产物**，不是插件运行时依赖。
> 插件运行只需要 `research/wasm.bin` 与 `research/qoder-wasm-glue.mjs`。

## 一、为什么单独归档

这些文件是从 App 的 `qoder-worker-runtime.obf.mjs`（31 MB）里**切出来的源码片段**，
用于人工审阅签名调用链。它们**全部可由脚本重新生成**，体积合计约 147 KB、
31 个文件，留在主目录会干扰交付物结构。

## 二、内容分类

### 2.1 glue 复刻参考（`glue/`）

| 文件 | 作用 |
|---|---|
| `qodercontext_raw.js` / `qodercontext_pretty.js` | wasm-bindgen glue 原文与美化版，`research/qoder-wasm-glue.mjs` 逐行对照它复刻 |
| `glue_a_imports.js` / `glue_b_wbg.js` / `glue_c_exports.js` | glue 的分段切片 |
| `KVi_initializeInferenceAuth.js` | 匿名鉴权初始化路径（给出 QoderContext 的构造配方） |
| `machineId-and-login.js` | machineId 生成与凭据存储逻辑 |
| `Mo.js` | 请求发送层 `Mo()`，揭示 `Cosy-Version` / `Cosy-ClientType` 等头的注入点 |
| `ZFl.js` | header 合并辅助 |
| `sendRemoteChatAsk.js` | 推理调用链（`ner()` → `Mo()`） |
| `callsite_prepareInferRequest.js` / `callsite_initWasm.js` | 真实调用点上下文 |
| `createWasmContext_<offset>.js` × 18 | `createWasmContext` 的 18 处命中片段，**各自内容均不相同**（已逐一 hash 比对），覆盖凭据轮换、数据策略轮询等不同调用场景 |

> 已删除：`function Mo(.js`。经逐字节比对，它是 `Mo.js` 去掉 `"async "` 前缀后的切片
> （前 2494 字节完全一致），无独立信息量，且文件名含空格与括号会干扰工具链。
> 原文件 SHA-256：`A5188C0B04C1B2BC3415D228AD96989C8C2E9584C63CA74273B9D0EF60EA1F66`。

### 2.2 提取出的 WASM（`wasm/`）

6 个内联 WASM 模块，由 `research/wasm-extract.mjs` 自动提取：

| 文件 | 大小 | 用途 |
|---|---|---|
| `inline_26762.wasm` | 297,238 | **★ 签名模块**（`qoder_auth_wasm`），等价于 `research/wasm.bin` |
| `inline_19399568.wasm` | 1,380,769 | tree-sitter 运行时 |
| `inline_19125550.wasm` | 205,488 | tree-sitter（bash grammar） |
| `inline_27631470.wasm` | 71,736 | 未识别 |
| `inline_520273.wasm` | 54,013 | llhttp |
| `inline_592416.wasm` | 54,202 | llhttp（第二份） |

## 三、如何重新生成

```bash
# 重新提取 WASM（含签名模块 wasm.bin）
node research/wasm-extract.mjs

# 重新导出 glue 片段（若需调整切分范围，改脚本里的 offset 区间）
node research/dump-glue2.mjs
node research/dump-callsites.mjs
node research/dump-createWasmContext.mjs
node research/dump-KVi.mjs
node research/dump-Mo.mjs
node research/dump-machineid.mjs
node research/dump-sendRemote.mjs
```

## 四、关于 `.wasm` 文件体积

`wasm/` 下 6 个文件合计约 2.06 MB，其中 5 个与签名无关。
**若需精简仓库，可只保留 `inline_26762.wasm`**（或直接用 `research/wasm.bin`），
其余 5 个删除即可 —— `wasm-extract.mjs` 能随时重新提取。
