# ToolForge

> 一个**插件驱动**的集成式多功能工具箱 —— 格式转换、抠图去背景、图像增强、批量重命名、可视化流水线编排，全部收在一个界面里。
> 任何新功能都能以**插件**形式接入，不改主程序一行代码。

[![Status](https://img.shields.io/badge/status-骨架已就绪-orange.svg)](#-项目状态)
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

### 4. 图片处理是唯一做了三层降级的领域，其余引擎缺失就是缺失

```
libvips（快、省内存） ──缺失──▶ ImageMagick（格式最全） ──缺失──▶ 纯 Rust image crate
                                                                    （零依赖，永远可用）
```

音视频 / 文档 / 压缩包没有纯 Rust 替代品，所以 FFmpeg 缺失时**直接告诉用户去装**，
而不是假装能跑。同理，v0.1 里没实现的节点会返回明确的 `未实现` 错误，
**绝不静默产出空文件**。

### 5. `tauri-plugin-shell` 对前端几乎是关闭的

前端（以及将来可能注入的插件 UI）如果能执行任意命令，前面所有的权限模型都是摆设。
所有引擎调用都走 Rust 命令层 → `toolforge-process` → 子进程；
capability 里 `shell:allow-execute` 只放行一个用于"打开文件夹"的 `explorer`。

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
│     ├─ commands.rs          28 个命令                                  │
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
用户拖入 12 张 PNG
   │
   ▼  React 拿到路径 → dropStore 收集 → 用户点「开始转换」
   ▼  ipc.pluginsRun({ pluginId, inputs: { src: [...12 个路径] }, params })
   │
   ▼  commands::plugins_run
   │    ├─ plugins.runnable(id)        已安装？已启用？权限齐？校验通过？
   │    ├─ plugins.quarantine_if_changed(id)   内容哈希是否被改过？
   │    ├─ resolve_output_dir()        输出目录（绝不往用户没指定的地方写）
   │    ├─ build_io()                  推导输入根目录 = PathResolver 的收敛边界
   │    ├─ queue.create(...)           → 立即返回 jobId
   │    └─ queue.spawn(...)            → 丢进 tokio
   │
   ▼  JobQueue::spawn
   │    ├─ 信号量限流（并发度来自设置，默认 CPU 核数的一半）
   │    ├─ 状态迁移 Queued → Running（非法迁移被拒且不 panic）
   │    └─ 执行 runner
   │
   ▼  L1 流水线执行器（toolforge-plugins::l1）
   │    ├─ CapabilityGuard 裁决每次能力请求
   │    ├─ PathResolver 把逻辑路径翻译成真实路径（挡 `../../`）
   │    ├─ 逐步：when 条件 → 模板渲染 → 超时/重试 → 执行节点
   │    └─ 每步产出写入 ${steps.<id>.<key>}，只允许后向引用
   │
   ▼  nodes::run（toolforge-engines）
   │    ├─ image.*  → 纯 Rust image crate（libvips/ImageMagick 存在时走它们）
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
pnpm bindings         # 重新生成 apps/desktop/src/bindings.ts
pnpm engines:list     # 查看引擎目录
pnpm engines:install  # 交互式安装引擎（本地开发用）
```

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
│       ├── src/commands.rs      28 个命令
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

---

## 🗂️ 功能规划

- [x] 插件骨架（三级运行时 + 权限模型 + 审计）
- [x] 任务队列（限流 / 取消 / 进度 / 日志尾部裁剪）
- [x] 引擎管理（探测 / 按需下载 / SHA-256 校验 / 降级）
- [x] 图片：格式转换、缩放、裁剪、旋转、增强、清除元数据（纯 Rust，开箱可用）
- [x] 音视频：转码、抽音轨、抽帧、剪辑、压缩、音量标准化（需 FFmpeg）
- [x] 文档/压缩包：Pandoc 转换、7-Zip 打包解压（含 Zip Slip 防护）
- [x] 可视化流程编辑器（React Flow）
- [x] AI 生成插件 + 安全审核门
- [ ] 抠图 / 超分 / OCR —— **节点已登记，执行器待实现**（v0.2，见 [ROADMAP](docs/ROADMAP.md)）
- [ ] LibreOffice 常驻 UNO listener（当前是每次冷启动）
- [ ] OS 钥匙串存储 API Key（当前仅内存）

---

## ⚠️ 已知风险与取舍

1. **`specta 2.0.0-rc.25` 是预发布版**。`specta` 的稳定版还停在 1.x，而 Tauri 2 需要 2.x。
   所有导出类型都收敛在 `apps/desktop/src-tauri/src/{ipc.rs, commands.rs}`，
   一旦 RC 破坏兼容，换成 `ts-rs` 的改动面被刻意限制在这两个文件里。
2. **引擎下载源已回填 6 条，但只覆盖 Windows 与 Linux**。
   `engine-sources.json` 里 `ffmpeg@windows`、`libvips@windows`、`pandoc@windows/linux`、
   `python@windows/linux` 六条已带**真实核对过的 SHA-256**（ffmpeg 取自 gyan.dev 随包发布的
   `.sha256` 旁挂文件，其余为自己流式下载后计算），并且 URL 全部改成**版本固定直链**——
   滚动别名（如 `ffmpeg-release-essentials.zip`）会在上游发新版时让哈希失效。
   **macOS 的三条仍为 `null`**：没有 macOS 环境可核对，`install` 会返回 `HashRequired`
   而不是放行。macOS 用户应走 Homebrew（系统安装模式）。
   在哈希为 `null` 时，`EngineRegistry::install` **拒绝自动安装**，除非调用方显式传
   `allow_unverified = true` 且用户在 UI 上二次确认。
   > 单元测试 `no_source_points_at_a_rolling_latest_alias` 与
   > `every_declared_hash_is_a_wellformed_sha256` 守着这两条纪律。
3. **模型权重不随包分发**。U²-Net 是 Apache-2.0 可商用，MODNet / BiRefNet 的**权重**许可不同，
   首次使用时会下载并单独确认许可证。
4. **`--stripComponents` / 解压依赖系统 `tar`**。Windows 10 1803+ 自带 bsdtar；
   更老的系统会退回到 7-Zip；都没有时给出明确的手动解压指引。
5. **AVIF 编码默认关闭**（rav1e 编译要几分钟）。需要时开 `toolforge-engines` 的 `avif` feature。

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
