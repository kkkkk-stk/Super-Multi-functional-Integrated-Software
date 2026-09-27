# ToolForge

> 一个**插件驱动**的集成式多功能工具箱 —— 格式转换、抠图去背景、图像增强、批量重命名、可视化流水线编排，全部收在一个界面里。
> 任何新功能都能以**插件**形式接入，不改主程序一行代码。

[![Status](https://img.shields.io/badge/status-32%2F32%20节点可用-green.svg)](#-功能规划)
[![Rust](https://img.shields.io/badge/rust-1.82%2B-dea584.svg?logo=rust)](https://www.rust-lang.org/)
[![Tauri](https://img.shields.io/badge/tauri-2.11-24C8DB.svg?logo=tauri)](https://v2.tauri.app/)
[![React](https://img.shields.io/badge/react-18.3-61DAFB.svg?logo=react)](https://react.dev/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## ⚠️ 先读这一节：这份骨架刻意做的几个「反直觉」决定

需求里写着「扩展性第一优先级」，但**扩展性本身不是免费的**。以下是本项目在设计时明确拒绝掉的几种做法，以及拒绝的理由。如果你打算改架构，请先看完这一节。

### 1. 「AI 生成插件 → 自动热装载」被拆成了五步，中间卡了一道**人工确认**

原本的一句话需求是"用户用自然语言描述需求，由 AI 生成插件，经校验后热装载运行"。
问题在于：**AI 生成的插件是不受信任的代码**，而 L3（Python）插件是裸进程 —— 能删文件、能读 `.env`、能静默发网络请求。这不是"写个校验器"能解决的。

所以我们把它拆成：

```
① 生成（内存草稿，无写盘能力）
② 静态校验（纯函数，不碰磁盘不联网）
③ 安全审核（能力定级 + 可疑模式扫描）
④ ★ 人工确认（逐条勾选权限，不提供"全选"）★   ← 真正的安全边界在这一步
⑤ 落盘 → 哈希锁定 → 每次装载前再校验一次
```

第 ④ 步**不提供自动化入口**，也没有"我信任这个作者"的开关。这是设计目标，不是待办事项。

### 2. 三级插件运行时不是「重量级/轻量级」的区别，而是**能力边界**的区别

| 级别 | 载体 | 能做到什么 | 做不到什么 |
|---|---|---|---|
| **L1** | `plugin.yaml` + 内置节点 | 组合已有能力：转码、缩放、打包、批量重命名 | 无法表达任意算法 |
| **L2** | Extism WASM | 纯计算：文本变换、哈希、编码、规则计算 | ❌ 没有文件系统 ❌ 没有网络 ❌ 没有 SIMD/线程 → **做不了图像解码** |
| **L3** | Python 进程 + JSON-RPC | 任意逻辑、重依赖、模型推理 | 能力最强、**风险也最高** |

**「用 WASM 抠图」是错的**：沙箱里没有文件系统、没有 SIMD，你还得自己塞一个解码器进去，再把几十 MB 的图片数据在宿主与沙箱之间来回拷。
`toolforge-ai` 的审核器会专门拦下这种设计（错误码 `WASM_MEDIA_INPUT`）。

### 3. 不做 L4「原生动态库插件」

Rust 没有稳定 ABI，Windows 还有文件锁 —— 原生插件的热重载**必然崩**，而且一崩就是整个应用。
如果你确实需要，正确的方向是「独立进程 + IPC」，那其实就是 L3。

### 4. 图片处理的三层降级：**四个节点是真的，两个还不是**（libvips 实测装过）

```
libvips（快、省内存） ──缺失──▶ ImageMagick（格式最全） ──缺失──▶ 纯 Rust image crate
                                                                    （零依赖，永远可用）
```

> ✅ **这张图现在真的会走**：`nodes.rs::pick_image_backend()` 按上面的顺序挑后端，
> 并把用的是哪个**报出来** —— 节点输出里多一个 `backend`（`libvips` / `imagemagick` / `rust`），
> 日志里多一条 `image.convert：后端 = libvips（快、省内存）；a.png → a.webp（质量 90）`。
> `scripts/devtools/verify-platform.mjs` 的【6】号检查专门盯着"实际后端与引擎状态是否一致"。
>
> **走这条链的**：`image.convert`、`image.resize`、`image.crop`、`image.rotate`。
> **还没走的**：`image.enhance` 与 `image.strip-metadata`（仍是纯 Rust 实现，不问引擎）——
> 它们**已经不再声明引擎依赖**（两个节点的 `optionalEngines` 已清空、`libvips.provides` 里那两条也撤掉了），
> 所以界面不会再出现"装了 libvips 会更快"这种没有实现支撑的说法。详见
> [docs/ENGINE-MATRIX.md](docs/ENGINE-MATRIX.md) 第 5.1、6.2 节与
> [docs/ROADMAP.md](docs/ROADMAP.md) 的「不一致 2」。
>
> **libvips 带来的收益要说准**：是**按质量换体积的能力**（WebP/JPEG 有损编码），
> 纯 Rust 后端的 WebP 只能无损。**但"有损一定更小"是错的** ——
> 实测一张 320×200 合成渐变图，无损 508 字节反而小于有损 1808 字节；
> 这个能力对**照片**才有意义。
>
> 另外，**"一键安装引擎"是真的跑通过**：libvips 8.18.6 由应用自己下载 → 校验 SHA-256 →
> 解压 → 探测为 `installed`（落在 `<数据目录>/engines/libvips/bin/vips.exe`，约 29.67 MB）。
> 它顺带暴露了两个 `toolforge-process` 的缺陷（裸命令名 `tar` 不查 PATH 导致解压必失败、
> `quiet` 把输出丢光导致引擎版本一律显示「未知」），两者都已修复并有回归测试。

音视频 / 文档 / 压缩包没有纯 Rust 替代品，所以 FFmpeg 缺失时**直接告诉用户去装**，
而不是假装能跑。**32 个内置节点现在全部有执行器**（`UNIMPLEMENTED_NODES` 是空数组），
所以不再有"登记了但点了必失败"的节点。最后补齐的四个各自把失败说清楚：

- `ebook.convert` —— Calibre 优先、Pandoc 兜底。**关键是在调用 pandoc 之前就把关**：
  它遇到认不出的输出扩展名**不报错**，只打一句 warning、写一个 HTML 出来、
  **保留原扩展名、退出码 0**。认不出输入格式时更糟（当纯文本读，产出垃圾）。
  "成功"的坏文件比失败更糟，所以这里不信退出码。
- `doc.ocr` —— 有 tesseract 走本地（离线免费），没有就用视觉模型；**PDF 输入明确拒绝**
  （要先按页栅格化，那条链路没做）。
- `ai.describe` —— 视觉模型看图为它写描述。⚠️ **图片会上传给你配置的 AI 服务商**
  （见下方「已知风险」）。
- `ai.upscale` —— Real-ESRGAN 分块推理，**推理全在本机**。

> 🆕 **抠图是第四条路，别把它算进上面那条三层链。** `image.remove-background` 已经实现并真机跑通，
> 但它跑的是 **ONNX 推理**，不经过 `pick_image_backend()` —— 装了 libvips / ImageMagick 也不会让它快一点。
> 它要的是**另外两个引擎**（`python` + `onnx-models`），推理**不在 Rust 里做**而是交给 Python 子进程：
> Rust 的 `ort` 会在**构建期**下载预编译原生库，那会让离线 / 内网构建直接失败，而**一次构建失败的代价
> 远大于多一个运行时依赖**。首次运行有两步一次性准备 —— 用户在「模型权重」里下 `u2netp`（4.4 MB），
> 应用再在 `<数据目录>/cache/onnx-runtime/` 下建独立 venv 装 `onnxruntime`（约 30 MB，**要联网**，
> 不动用户自己的 Python）。**没有网络的机器在依赖就位前用不了这个节点**；之后推理全在本地、不传图片。
> Python 需要 **3.9 ~ 3.13**（`onnxruntime` 没有 3.14 的 wheel）。
> 详见 [docs/ENGINE-MATRIX.md](docs/ENGINE-MATRIX.md) 第 3.2 节与 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 决策 9。
>
> 🆕 **AI 超分（`ai.upscale`）与它是同一条链**：Real-ESRGAN，**256 px 分块 / 16 px 重叠 / 只取中心贴回**，
> 所以大图也跑得动；`scale=2|3` 是"先按 4 倍推理再用 Lanczos 缩回去"（细节是模型真算出来的）。
> 权重默认 `realesr-general-x4v3`（4.87 MB，输入尺寸动态）。**同样纯本地推理，不上传图片。**

### 5. `tauri-plugin-shell` 对前端**完全关闭**

前端（以及将来可能注入的插件 UI）如果能执行任意命令，前面所有的权限模型都是摆设。
所有引擎调用都走 Rust 命令层 → `toolforge-process` → 子进程。

**capability 里一条 `shell:` 权限都没有** —— 连"只放行 `explorer`"都没有。
> ⚠️ **这句话在 2026 年这一轮之前写的是「`shell:allow-execute` 只放行一个用于"打开文件夹"的 `explorer`」—— 那是过期的**：现在的 `capabilities/default.json` 里**没有任何 shell 权限**，而"打开文件夹"走的是 `opener:reveal_item_in_dir`（见 `src/lib/system.ts` 的 `revealInExplorer`）。也就是说真实边界比文档写的**更紧**，但文档写了错话 —— 这一轮同时补上了运行时验证（`verify-platform.mjs`【26】从页面里真的去调 `shell|execute` 并断言被拒），**声明与行为从此对得上**。

除了 shell，前端能直接调的东西就只剩这几样，逐条都有运行时断言：

| 能力 | 谁在用 | 运行时验证 |
| --- | --- | --- |
| `opener:reveal_item_in_dir` | 「打开所在文件夹」（任务产出、引擎目录、插件目录） | ✅ 允许 |
| `opener:open_url`（限 `http/https/mailto/tel`） | 「查看官方页面」等外链 | ✅ 允许 |
| `dialog:open` / `dialog:save` | 选择文件 / 目录 / 保存位置 | ✅ 允许 |
| `fs:read_text_file` 等（**受 scope 限制**） | 读取设置/插件清单等 | ✅ scope 内允许、**scope 外被拒** |
| `shell:*` | —— | ❌ **被拒**（`shell.execute not allowed`） |
| `opener:open_path` | —— | ❌ **被拒**（因此没有"用默认程序打开文件"这个功能） |


---

## 📖 项目简介

日常工作和学习中，我们往往同时装着一堆零散小工具：格式转换、文本处理、批量重命名、抠图……
它们界面风格各异、安装包零散、还常常夹带广告。

ToolForge 想用**一个统一入口**解决这件事，并且解决得更彻底一点：
**当你遇到一个内置功能覆盖不到的需求时，不用等作者更新 —— 你描述一下，它自己长出来。**

---

## 🏗️ 架构

```
┌──────────────────────────────────────────────────────────────────────┐
│  apps/desktop  ·  Tauri 2 外壳                                        │
│  ├─ src/                    React 18 + TS + Vite 5（UI 与交互）        │
│  └─ src-tauri/src/          IPC 命令层（只做编排，无业务逻辑）           │
│     ├─ ipc.rs               前端可见的契约类型                          │
│     ├─ commands.rs          32 个命令                                  │
│     ├─ state.rs             组装各子系统                                │
│     └─ lib.rs               事件桥 + specta 类型导出                    │
└────────────────────────────┬─────────────────────────────────────────┘
                             │  Result<T, ToolforgeError>
                             │  ── 事件回流：toolforge://event ──▶
┌────────────────────────────▼─────────────────────────────────────────┐
│  crates/                                                              │
│                                                                       │
│  toolforge-core        领域层：任务 / 引擎描述 / 插件清单 / 权限模型      │
│    ⚠️ 不依赖 tauri、extism、reqwest —— 可被测试、可被 CLI 复用           │
│                                                                       │
│  toolforge-process     子进程编排：流式读取 / 取消 / 超时 / JSON-RPC     │
│  toolforge-engines     引擎探测 / 按需下载(SHA-256) / 内置节点实现       │
│  toolforge-plugins     三级运行时 + 插件仓库 + 审计日志                  │
│  toolforge-ai          AI 生成 / 静态校验 / 安全审核                     │
└──────────────────────────────────────────────────────────────────────┘
```

### 一次「拖入文件 → 转换完成」的完整链路

```
用户拖入 12 张 PNG（拖入一个文件夹也一样：宿主把它展开成里面的文件，逐个处理）
   │
   ▼  React 拿到路径 → dropStore 收集 → 用户点「开始转换」
   ▼  ipc.pluginsRun({ pluginId, inputs: { src: [...12 个路径] }, params })
   │
   ▼  commands::plugins_run
   │    ├─ plugins.runnable(id)        已安装？已启用？权限齐？校验通过？
   │    ├─ plugins.quarantine_if_changed(id)   内容哈希是否被改过？
   │    ├─ resolve_output_dir()        输出目录（绝不往用户没指定的地方写）
   │    ├─ expand_batches()            多文件/目录输入先扇出成 N 个单文件批次
   │    │     └─ 目录只展开一层，跳过隐藏文件，上限 5000 个（超了报错，不静默截断）
   │    ├─ build_io()                  推导输入根目录 = PathResolver 的收敛边界
   │    │     └─ 目录输入时根取目录自身（不是父级，避免多授权一层）
   │    ├─ queue.create(...)           → 立即返回 jobId
   │    └─ queue.spawn(...)            → 丢进 tokio
   │
   ▼  JobQueue::spawn
   │    ├─ 信号量限流（并发度来自设置，默认 CPU 核数的一半）
   │    ├─ 状态迁移 Queued → Running（非法迁移被拒且不 panic）
   │    └─ 执行 runner
   │
   ▼  L1 流水线执行器（toolforge-plugins::l1）—— 每批调用一次，逐批上报「处理 3/12」
   │    ├─ CapabilityGuard 裁决每次能力请求
   │    ├─ PathResolver 把逻辑路径翻译成真实路径（挡 `../../`）
   │    ├─ 逐步：when 条件 → 模板渲染 → 超时/重试 → 执行节点
   │    ├─ 每步产出写入 ${steps.<id>.<key>}，只允许后向引用
   │    └─ 批次序号由宿主注入：${batch.index}（从 1 起）/ ${batch.total}
   │
   ▼  nodes::run（toolforge-engines）
   │    ├─ image.*  → 先挑后端：libvips → ImageMagick → 纯 Rust（输出里报 backend）
   │    │             （image.enhance / image.strip-metadata 目前只有纯 Rust 一条路）
   │    ├─ video.*  → 构造 ffmpeg 命令行 + 解析 -progress 输出为百分比
   │    └─ 取消令牌贯穿到子进程，UI 点"取消"秒级生效
   │
   ▼  事件回流
        jobProgressHint（100ms 节流） / jobLog / jobUpdated / jobFinished
        → broadcast → EventBridge → app.emit("toolforge://event")
        → use-events.ts → queryClient.setQueryData(["jobs"]) → 进度条动
```

**为什么进度事件和 Job 快照是两个事件？**
转码时一秒能产出几十次进度，每次都序列化整条 `Job`（含日志数组）会把 IPC 打爆。
所以进度走独立的轻量事件并做节流，前端即使漏掉中间事件，拉一次 `jobs_list` 也能对账。

---

## 🧰 技术栈（版本已在 `Cargo.toml` / `package.json` 里锁定）

| 层面 | 选型 | 备注 |
|---|---|---|
| 外壳 | **Tauri 2.11** + Rust（MSRV **1.82**） | 实测在 rustc 1.98.1 上构建通过 |
| 异步 | tokio 1（multi-thread + process） | |
| 序列化 | serde / serde_json / serde_yaml | |
| **类型桥** | **specta `2.0.0-rc.25`** + tauri-specta | ⚠️ 仍是 RC。见下方"已知风险" |
| 前端 | **React 18.3** + **TypeScript 5.9** + **Vite 5.4** | |
| 状态 | **Zustand 5**（瞬时 UI）+ **TanStack Query 5**（异步数据） | 职责严格切开，见下方铁律 |
| 样式 | **TailwindCSS 3.4** + CSS Variables 主题 | 刻意不上 Tailwind 4（CSS-first 配置，生态未稳） |
| 组件 | shadcn/ui 风格（Radix 基础）深度定制 | |
| 动画 | Framer Motion 13 | |
| 流程编辑器 | **`@xyflow/react` 12** | ⚠️ React Flow v12 起改名，不是 `reactflow` |
| 图标 | Lucide React | |
| WASM 沙箱 | **Extism 1.30**（Wasmtime 后端，WASI 关闭） | |

### 🔒 一条铁律：Zustand 与 TanStack Query 的边界

> **Query 独占所有来自 Rust 的异步数据**（任务、引擎、插件、节点目录、设置、审计）。
> **Zustand 只存瞬时 UI 状态**（面板开合、选中项、画布视口、拖拽态）。
> 同一条数据**绝不允许两处存**。

违反这条会得到"进度条不动"这类幽灵 bug —— 因为两处状态各有各的更新时机。

---

## 🚀 快速开始

### 环境要求

| 组件 | 版本 | 说明 |
|---|---|---|
| Rust | 1.82+ | 需要 MSVC 工具链（Windows） |
| Node.js | 20+ | |
| pnpm | 9.x | `npm i -g pnpm` |
| WebView2 | — | Windows 10/11 自带 |

引擎（FFmpeg / Pandoc / 7-Zip …）**不需要预装** —— 应用会按需下载，或者直接复用你系统里已有的那份。

### 安装与运行

```bash
git clone https://github.com/kkkkk-stk/Super-Multi-functional-Integrated-Software.git
cd Super-Multi-functional-Integrated-Software

pnpm install

# 生成图标（仓库里不放二进制素材，审查 diff 更清爽）
node scripts/gen-icon.mjs

# 开发模式
pnpm tauri:dev
```

### 常用脚本

```bash
pnpm typecheck        # 前端类型检查（tsc --noEmit）
pnpm build            # 前端产物（tsc + vite build）
pnpm check:rust       # cargo check --workspace --all-targets
pnpm check:all        # 两者都跑
pnpm bindings         # 重新生成 apps/desktop/src/bindings.ts（含 4 项守卫）
pnpm engines:list     # 查看引擎目录
pnpm engines:install  # 交互式安装引擎（本地开发用）
```

### 真机验证（补上自动化测试覆盖不到的那一层）

> 本项目在 `cargo check` / **218 个 Rust 测试** / `tsc` / `vite build` **全绿**的情况下，
> 真机跑一次仍然找出了 **3 个发布级缺陷**。共同点是"组件各自正确，连起来不对"。
> 同一类问题后来还出现过一次：验证脚本自己挑了一个**错误的模型**去超分，
> 尺寸断言**全部通过**而输出是垃圾（复盘见 [docs/ENGINE-MATRIX.md](docs/ENGINE-MATRIX.md) 第 3.2 节）。
> **"测过了"这句话本身要能被质疑。**
>
> 而最新一次的教训更刺人：那个二进制因为文件句柄被占**好几轮没有重建过**，
> "编译通过 + 单测全绿"对它**毫无意义** —— 一重建就冒出 3 个新缺陷
> （内置插件目录被 `target/` 里的陈旧副本遮蔽，7 个插件只装载 4 个；下载错误把真实原因吃掉；卡死检测根本没法被验证）。
> **测试绿的是源码，不是你手上那个 exe。**

两个终端：

```powershell
# 终端 1：带 WebView2 调试端口启动
pnpm dev:cdp                      # 或 .\scripts\devtools\dev-with-cdp.ps1

# 终端 2：跑全部真机检查
pnpm verify:app                   # 或 node scripts/devtools/run.mjs
```

也可以单独跑：`verify:inspect`（单页体检）、`verify:smoke`（9 个路由）、
`verify:e2e`（真实转换任务）、`verify:security`（解码 / 多文件扇出 / 恶意插件安全测试）。

详见 [`scripts/devtools/README.md`](scripts/devtools/README.md)。它**验不了**的两件事
只能靠人：**从资源管理器真实拖拽文件**（走 Tauri 原生 drag-drop 事件，不是 DOM 事件），
以及**主题切换的视觉效果**。

> ⚠️ **`cargo check --release` 之前需要前端产物**。
> `tauri::generate_context!` 会在编译期把 `frontendDist`（`apps/desktop/dist`）
> 嵌进二进制，而 `dist/` 是构建产物、不入库。
> **实测**：debug 下 `cargo check` 不受影响（走 `devUrl`），只有 **release** 会因为
> `dist/` 不存在而失败。`pnpm check:rust` 已经内置了 `scripts/ensure-dist.mjs`
> 来写一个占位页，`pnpm build` 会覆盖它。

### 在受限网络下构建

本机若走企业代理或 TLS 中间人（例如 Watt Toolkit），需要给 Node 侧指定根证书：

```powershell
$env:NODE_EXTRA_CA_CERTS = "path\to\proxy-ca.pem"
```

Cargo 走系统证书库（Windows 上是 schannel），通常无需额外配置。
`crates/toolforge-engines/engine-sources.json` 里的下载源可以整体替换为内网镜像。

---

## 📁 目录结构

```
.
├── apps/desktop/                桌面应用
│   ├── src/                     React 前端
│   │   ├── types/domain.ts      手写的领域类型（镜像 Rust）
│   │   ├── lib/ipc.ts           ★ 全应用唯一允许 invoke 的文件
│   │   ├── stores/              Zustand（瞬时 UI 状态）
│   │   ├── hooks/               TanStack Query（异步数据）+ 事件订阅
│   │   ├── components/          ui / layout / fx / jobs / plugins / pipeline
│   │   └── features/            按功能页划分
│   └── src-tauri/               Tauri 外壳
│       ├── src/ipc.rs           前端可见的契约类型
│       ├── src/commands.rs      32 个命令
│       ├── src/state.rs         子系统组装
│       ├── src/lib.rs           事件桥 + specta 导出
│       ├── capabilities/        能力白名单（最小权限）
│       └── tauri.conf.json
│
├── crates/
│   ├── toolforge-core/          领域层（不依赖 tauri/extism/reqwest）
│   ├── toolforge-process/       子进程编排 + JSON-RPC over stdio
│   ├── toolforge-engines/       引擎探测/下载 + 内置节点实现
│   ├── toolforge-plugins/       三级运行时 + 插件仓库 + 审计
│   └── toolforge-ai/            AI 生成 + 校验 + 安全审核
│
├── plugins/                     内置与示例插件
│   ├── builtin/                 L1 声明式（随应用分发）
│   ├── wasm-example/            L2 示例（Rust → wasm32-wasip1）
│   └── python-example/          L3 示例（JSON-RPC over stdio）
│
├── docs/
│   ├── ARCHITECTURE.md          架构与关键决策
│   ├── PLUGIN-SDK.md            插件开发指南
│   ├── SECURITY.md              威胁模型与防护
│   ├── ENGINE-MATRIX.md         引擎/模型许可证与降级矩阵
│   └── ROADMAP.md               路线图与验收标准
│
├── scripts/                     开发辅助脚本（非运行时依赖）
│   ├── devtools/                ★ 真机验证（CDP 驱动真实 WebView）
│   ├── enginectl.mjs            引擎目录 / 探测 / 按需下载 / 权重校验 / 清理（清理默认只看不删）
│   ├── check-encodings.mjs      Windows 脚本编码守卫（`.ps1` 必须带 UTF-8 BOM）
│   ├── gen-icon.mjs             生成图标（仓库不放二进制素材）
│   └── ensure-dist.mjs          保证 cargo check 需要的前端产物存在
└── .github/workflows/           CI
```

---

## 🔐 安全模型（摘要，完整版见 [docs/SECURITY.md](docs/SECURITY.md)）

**威胁模型**：插件（尤其是 AI 生成的）是不受信任的代码。

| 机制 | 实现位置 | 作用 |
|---|---|---|
| 声明制 | `PluginManifest.permissions` | 代码里出现未声明的能力调用 = 拒绝 + 记审计 |
| 最小授权 | `PermissionSet::effective()` | 生效权限 = **声明 ∩ 用户已授权** |
| 路径收敛 | `PathResolver::resolve()` | 词法规范化后校验前缀，挡 `../../etc/passwd` |
| 运行期裁决 | `CapabilityGuard::check()` | 每次能力请求都要过一遍 |
| 完整性锁定 | `content_hash()` | 装载前比对，被改动过就拒绝执行 |
| 扩权检测 | `diff_capabilities()` | 升级后新增能力 → 必须重新人工确认 |
| 审计日志 | `AuditLog`（NDJSON） | 授权、扩权、越权三类事件可事后追溯 |
| 进程隔离 | L3 清空环境 + 锁 cwd + 默认禁网 | ⚠️ **不是内核级沙箱**，见下 |

**必须诚实说明的一点**：L3 Python 的隔离是**尽力而为**的。
清空环境变量、锁定工作目录、把代理指向死地址，只能挡住"顺手而为"的越权，挡不住蓄意攻击。
真正的隔离需要 Windows Job Object + AppContainer / macOS `sandbox-exec` / Linux seccomp —— 在 v0.2 的路线图里。
**所以 L3 插件的安全最终依赖两件事：用户在看权限清单时真的看了；审计日志能事后追溯。**

**还有一条与"数据出不出本机"有关的，必须和上一条并列说**：

- `image.remove-background` 与 `ai.upscale`：**推理完全在本机**，图片不出本机。
- `ai.describe` 与 `doc.ocr` 的 AI 路径：**会把图片上传给你配置的 AI 服务商**（缩小并转 JPEG 后）。
  这两条都是内置节点，走宿主自己发起的 HTTP，**不经过插件的 `net` 能力声明**。
  完整的对照表、默认行为与"想离线该用哪个"见 [docs/SECURITY.md](docs/SECURITY.md) §3.9。

**别把"AI 功能"笼统地说成"都要联网"或"都是本地的"** —— 两种说法都会误导用户，而这是用户最在意的问题。

---

## 🗂️ 功能规划

- [x] 插件骨架（三级运行时 + 权限模型 + 审计）
- [x] 任务队列（限流 / 取消 / 进度 / 日志尾部裁剪）
- [x] 引擎管理（探测 / 按需下载 / SHA-256 校验 / 降级）
- [x] 图片：格式转换、缩放、裁剪、旋转、增强、清除元数据（纯 Rust 打底、开箱可用；**前四者会在装了 libvips / ImageMagick 时自动走它们，并在输出里报 `backend`**）
- [x] 音视频：转码、抽音轨、抽帧、剪辑、压缩、音量标准化（需 FFmpeg）
- [x] 文档/压缩包：Pandoc 转换、7-Zip 打包解压（含 Zip Slip 防护）
- [x] 可视化流程编辑器（React Flow）
- [x] AI 生成插件 + 安全审核门
- [x] **抠图去背景**（`image.remove-background`）—— **已实现**，走一条独立的 ONNX 推理链：先到「模型权重」下 `u2netp`（4.4 MB），首次运行会自动建一个独立 venv 装 `onnxruntime`（约 30 MB，**这一步要联网**；不动你自己的 Python），之后每张图都是**本地推理**。实测 400×300 测试图输出 RGBA PNG、前景覆盖 18.87%、单张约 0.7 秒。它不是 libvips / ImageMagick 那条降级链的一部分
- [x] **超分 / OCR / 电子书转换 / AI 描述 —— 四个节点全部实现**（`ai.upscale` / `doc.ocr` / `ebook.convert` / `ai.describe`）。
      超分是 Real-ESRGAN 分块推理（权重 `realesr-general-x4v3` 4.87 MB，**纯本地**）；
      OCR 有 tesseract 走本地、没有就用视觉模型（**PDF 输入明确拒绝**）；
      电子书转换 Calibre 优先、Pandoc 兜底，并在调用 pandoc 前拦住它"假装成功"的格式；
      AI 描述需要**视觉模型**，⚠️ **会把图片上传给你配置的 AI 服务商**（见下方「已知风险」第 7 条）。
      7 个内置示例插件里的 `plugins/builtin/{ebook-convert,ai-describe,image-upscale}` 就是它们的现成用法
- [x] 模型权重下载（`models_list` / `models_install` / `models_remove`）：**8 个权重**（抠图 5 + 超分 3）里**5 个**可下载，哈希**真实下载核对过**、**不匹配即删文件**；另外 3 个没有下载源，UI 直接禁用按钮（不让你点了才失败）
- [ ] LibreOffice 常驻 UNO listener（当前是每次冷启动）
- [ ] OS 钥匙串存储 API Key —— **仍未实现**。Key 默认只存在内存；可选开关「记住 API Key」把它**明文**写到 `<数据目录>/ai-key.txt`（默认关闭，关掉即删文件）

---

## ⚠️ 已知风险与取舍

1. **`specta 2.0.0-rc.25` 是预发布版**。`specta` 的稳定版还停在 1.x，而 Tauri 2 需要 2.x。
   所有导出类型都收敛在 `apps/desktop/src-tauri/src/{ipc.rs, commands.rs}`，
   一旦 RC 破坏兼容，换成 `ts-rs` 的改动面被刻意限制在这两个文件里。
2. **引擎下载源已回填 7 条，但只覆盖 Windows 与 Linux**。
   `engine-sources.json` 里 `ffmpeg@windows`、`libvips@windows`、`pandoc@windows/linux`、
   `python@windows/linux`，以及本轮新增的 **`imagemagick@windows`**（7.1.2-31 便携版，官方只提供 `.7z`；
   实测 **Windows 自带的 `tar` 能读 7z**，所以装它不需要先装 7-Zip）共七条已带**真实核对过的 SHA-256**
   （ffmpeg 取自 gyan.dev 随包发布的 `.sha256` 旁挂文件，其余为自己流式下载后计算），
   并且 URL 全部改成**版本固定直链** —— 滚动别名（如 `ffmpeg-release-essentials.zip`）会在上游发新版时让哈希失效。
   **macOS 的四条仍为 `null`**：没有 macOS 环境可核对，`install` 会返回 `HashRequired`
   而不是放行。macOS 用户应走 Homebrew（系统安装模式）。
   在哈希为 `null` 时，`EngineRegistry::install` **拒绝自动安装**，除非调用方显式传
   `allow_unverified = true` 且用户在 UI 上二次确认。
   > 单元测试 `no_source_points_at_a_rolling_latest_alias` 与
   > `every_declared_hash_is_a_wellformed_sha256` 守着这两条纪律；
   > `download_mode_engines_have_a_source_for_this_platform` 守着"声明了下载就必须真有来源"
   > —— `imagemagick` 违反过它，后果是界面显示一个点下去必然失败的「一键下载」按钮。
   > ⚠️ **FFmpeg 的安装在本机没有完成过**：`www.gyan.dev` 不可达（`curl` 直测也是连不上），
   > 依赖它的 `video.*` / `audio.*` 节点在那台机器上不可用。这是**环境事实，不是代码缺陷**；
   > 哈希取自上游旁挂的 `.sha256` 文件只能证明来源写对了，替代不了一次真实安装。
   > 注意这与下面那条的区别：**FFmpeg 的安装链路至今一次都没跑通过是为了环境，不是因为是坏的。**
   > ✅ **而 `imagemagick@windows` 的应用内安装链路已经复验成功**（这条以前写的是"未复验"）：
   > 文件句柄释放后重建并真的装了一遍 —— 11.7 MB 下载 → SHA-256 校验通过 → 系统 `tar` 解开 `.7z`
   > → `magick.exe` 落在 `…/engines/imagemagick/magick.exe`，**241.5 MB**，探测版本 `ImageMagick 7.1.2-31 Q16 x64`。
   > 装通之后还顺手拿到了"只有 ImageMagick 可用"这一档的环境基线（临时藏掉 `engines/libvips`，
   > `image.convert` 的后端日志变成 `后端 = ImageMagick（格式最全）` 并产出有损 VP8 WebP），
   > 这件事已经固化进 `verify-platform.mjs`【12】。
3. **模型权重不随包分发**。U²-Net 是 Apache-2.0 可商用，MODNet / BiRefNet 的**权重**许可不同，
   首次使用时会下载并单独确认许可证。
   目录里共 **8 个权重**（抠图 5 + 超分 3），其中 **5 个**带下载源：
   `u2net` / `u2netp` / `isnet-general`（rembg）与 `realesr-general-x4v3` / `realesrgan-anime6b`（Hugging Face）。
   下载文件**逐个校验 SHA-256**（哈希都是真实下载后算出来的），
   **不匹配就删除文件并报错**，不留没校验过的产物。`birefnet-general` / `modnet-portrait` /
   `realesrgan-x4plus` 没有下载源，因此 UI 显示「无下载源」并把下载按钮**置灰**。
   > ⚠️ **`realesrgan-x4plus` 的原因和另外两个不同，值得单独说**：它缺的不是哈希，而是**能用的 ONNX 导出** ——
   > 找到的每一份输入尺寸都是**固定的**（64×64 或 128×128），要跑通必须先补上「补齐到固定尺寸 → 推理 → 裁回去」，
   > 而补边质量直接决定边缘块的结果。与其先上一个会留下**网格状接缝**的版本，不如先把两个
   > **动态尺寸**的模型做扎实（它们对任意尺寸都能直接推理，不需要补边）。
   > 要做它：补上补齐 + 裁切 → 重跑接缝检查 → 真实下载后填哈希。见 [ROADMAP](docs/ROADMAP.md) 的开放项。
   > ⚠️ **权重之外还有一次联网**：抠图与超分节点**首次运行**时会自己建 venv 并 `pip install`
   > `onnxruntime` / `numpy` / `pillow`（约 30 MB）。这些包**没有哈希锁定、没有签名校验**。
   > 详见 [docs/SECURITY.md](docs/SECURITY.md) §9 第 29 项。
4. **设置会真的落盘**。非机密设置写 `<数据目录>/settings.json`（原子写：临时文件 + rename）；
   文件损坏时被隔离成 `settings.broken.json` 并用默认值启动，**不会因为一个坏 JSON 就打不开应用**。
   API Key **不在这个文件里**：默认只在内存，只有显式打开「记住 API Key」才**明文**写到
   `<数据目录>/ai-key.txt`，关掉该开关会删除这个文件（OS 钥匙串尚未实现）。
5. **解压依赖系统 `tar`**。Windows 10 1803+ 自带 bsdtar；更老的系统会退回到 7-Zip；
   都没有时给出明确的手动解压指引。
   > 这条路径**曾经整体是坏的**：`ExecOptions::new("tar")` 用的是裸命令名，而当时的
   > 存在性检查走 `Path::exists()`（**不查 PATH**），于是"一键安装引擎"必然卡在解压，
   > 还甩出一句误导人的"可执行文件不存在：tar"。现在裸名字由
   > `toolforge_process::resolve_program()` 统一按 PATH（Windows 再按 `PATHEXT`）解析，
   > **显式路径不会回退到 PATH**；libvips 8.18.6 已按这条路真实安装成功。
6. **AVIF 编码默认关闭**（rav1e 编译要几分钟）。需要时开 `toolforge-engines` 的 `avif` feature。
7. **「保留源文件」这个开关是真的会删文件的，请看清它当前的状态。**
   关掉它（设置页 / 批量页）之后，一批任务**成功**时会把这一批真正用到的**输入文件删掉**，
   每个删除都写进任务日志。安全边界刻意保守：**只有批次成功之后才删**（失败或取消时源文件留着 ——
   那是你唯一还能重试的东西）；**输出路径与输入路径相同时不删**（否则删的就是刚生成的结果）；
   文件已经不存在就跳过。要绝对安全就把它保持在默认的「保留」。
   > 这条行为**此前完全不存在**：开关声明了、能改、能落盘，界面三个地方也把它当成真事，
   > 但**没有任何代码读它** —— 也就是"以为会删，实际一个都不动"。见
   > [docs/ROADMAP.md](docs/ROADMAP.md) §3.10 与 `scripts/devtools/verify-platform.mjs` 【27】。
8. **`ai.describe` 与 `doc.ocr` 会把你的图片上传给你配置的 AI 服务商** —— 这是真实的隐私代价，必须直说。
   - `ai.describe` 只有这一条路（没有本地替代）；`doc.ocr` 的 `engine` 默认是 `auto`：
     **装了 tesseract 就走本地，没装就用视觉模型**，也就是"没装 tesseract 的机器上跑 OCR"会**自动**把图片发出去。
   - 发送前会先把图片**缩小并转成 JPEG**（`ai.describe` 最长边默认 1024、`doc.ocr` 默认 2048），
     这降低了费用与流量，**但不改变"图片离开了你的机器"这个事实**。
   - 服务商由你自己在「设置 → AI」里指定，Key 不进日志、不进插件；但 ToolForge **不代理、不转存**，
     也不在发送前再问一次。任务日志里会写明"图片会上传给 AI 服务商"。
   - **要完全离线，就用 `image.remove-background` 与 `ai.upscale`** —— 这两个的推理**全在本机**，
     图片不出本机（首次装依赖要联网一次，但那是拉包，不是传图）。
   - 自动化验收脚本**不会**把真实图片发给任何服务商：它起一个**假端点**（`scripts/devtools/mock-openai.mjs`），
     喂的是脚本自己生成的合成 PNG。详见 [docs/SECURITY.md](docs/SECURITY.md) §3.9。

---

## 🤝 参与贡献

1. **提交 Issue** —— 反馈问题或提出功能建议
2. **提交 PR** —— 修缺陷或实现新节点（新增内置节点的入口在
   `crates/toolforge-core/src/pipeline.rs` 的 `builtin_nodes()`，
   **必须先在那里登记**，否则插件清单校验会拒绝引用它）
3. **写插件** —— 见 [docs/PLUGIN-SDK.md](docs/PLUGIN-SDK.md)，不需要改主程序

提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：
`feat` / `fix` / `docs` / `refactor` / `style` / `chore`。

---

## 📄 开源协议

**MIT License**，详见 [LICENSE](LICENSE)。

> 注意：本项目的**代码**是 MIT，但你通过 ToolForge 调用的**外部引擎与模型权重**各有各的许可证
> （FFmpeg 可能是 GPL、Pandoc 是 GPL-2.0+、Calibre 是 GPL-3.0、部分抠图模型权重禁止商用）。
> 这些差异在 [docs/ENGINE-MATRIX.md](docs/ENGINE-MATRIX.md) 里逐条列出，界面上也会在下载前提示。

---

<div align="center">

**如果这个项目对你有帮助，欢迎点个 ⭐ Star 支持一下！**

</div>
