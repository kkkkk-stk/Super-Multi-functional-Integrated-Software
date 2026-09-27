# ToolForge 路线图（ROADMAP）

> 本文档描述 ToolForge 的**目标**与**验收标准**，而不是当前实现的镜像。
> 任何关于「现在能不能跑」的判断，**一律以代码与 CI 输出为准**；本文档只负责说明「打算做到什么程度算完成」。

## 阅读方式

- 每个阶段由两部分组成：**可交付能力清单** 与 **验收标准**。
  - 能力清单是可勾选的条目（`[x]` / `[ ]`），用标记表达状态；
  - 验收标准是**可客观检验**的条件，例如「`cargo test --workspace` 全绿」「插件目录拖入即装载」，而不是「体验流畅」这类主观描述。
- 状态标记的含义：

  | 标记 | 含义 |
  | --- | --- |
  | ✅ 已完成骨架 | 代码/目录/配置**已经存在**且结构符合设计；**不代表已通过验收、也不代表能编译** |
  | 🚧 待实现 | 代码/目录/配置**尚不存在**，或存在但功能未打通 |
  | ⛔ 阻塞 | 已核实的缺陷，导致当前无法编译或无法通过测试 |

- 阶段的先后顺序是**硬依赖**：v0.2 的引擎接入依赖 v0.1 的进程层，v0.5 的 AI 闭环依赖 v0.2 的权限模型，v1.0 的分发依赖 v0.5 的插件格式冻结。
- 目标准入原则：**不做没有验收标准的条目**。任何新增需求必须先补上可检验条件，再排入阶段。

### 关于本文档的时效性（必读）

本仓库在编写本文档期间处于**并行开发**状态：多个 crate 与文件在核对过程中被持续写入（实测同一批 `*.rs` 文件的修改时间集中在数分钟内，且部分文件在两次核对之间从「不存在」变为「已存在」，例如 `apps/desktop/src-tauri/src/` 下的文件与 `crates/toolforge-ai/src/provider.rs`）。

因此：

- 本文档的**文件级清单是快照**，时间点为 **2026-09-26 10:07**，随时可能过期；请以 `git status` 与目录实际内容复核。
- 本文档的**验收标准与阻塞条件**是稳定的，它们描述的是「要达到什么程度」，不随文件增删而变。
- 「当前阻塞项」中的每一条都在写入前**重新核对过一次**（不只是转述），核对方法与结论一并写在条目里。

---

## 当前状态速览

> ⚠️ **下面这几节是 2026-09-26 10:07 的原始快照，已经大面积过时** ——
> 它说 `Cargo.lock` 不存在、前端"完全不存在"、`toolforge-core` 无法编译、
> `bindings.rs` 缺失等等，**这些现在都不成立**。
>
> 之所以留着而不是删掉：它是"骨架刚搭完"那一刻的真实记录，
> 后面的每一条修复都能在这里找到对照。**但要判断现在的状态，请用下面这份。**
>
> **当前（本文件末尾的「基线」一节有可复核的命令与输出）：**
>
> | 项 | 现在的值 |
> | --- | --- |
> | 编译 | `cargo check --workspace --all-targets` **0 error / 0 warning** |
> | 测试 | `cargo test --workspace` **232 passed / 0 failed** |
> | 前端 | `apps/desktop/src` 下有 93 个文件；`tsc --noEmit` 0 错误、`vite build` 通过 |
> | `Cargo.lock` | **已存在并入库** |
> | IPC 命令 | **32 个**（`COMMAND_NAMES` 与生成的 `bindings.ts` 逐条对齐，由 `export_bindings` 守卫） |
> | 内置节点 | **32 个，全部有执行器**（`UNIMPLEMENTED_NODES` 为空） |
> | 内置示例插件 | **8 个**（`doc-to-pdf` 是本轮新增的，见 §3.2） |
> | 引擎下载源 | `engine-sources.json` 共 **14 条**（Windows 7 / Linux 4 / macOS 3），其中 **13 条**的 SHA-256 是真实下载后核对过的；唯一 `sha256: null` 的是 `ffmpeg@macos`（evermeet 取不到字节），`install` 会对它返回 `HashRequired` 而**不放行**。`7zip` 三平台与本轮新增的 `python@macos` / `ffmpeg@linux` / `7zip` 见 §3 |
> | 运行时测试总数 | `cargo test --workspace` **286 passed / 0 failed** |
> | 真机验收 | `scripts/devtools/verify-platform.mjs` 本机实测 **401 项全通过**（【1】–【34】） |
> | 插件运行时验收 | `scripts/devtools/verify-runtimes.mjs` 本机实测 **70 项全通过**（L2 WASM 纯计算 / L2 net 白名单对照实验 / L2 装载体检 / L3 Python 冷启动 / L3 env 白名单对照实验 / L3 exec 装载期静态门） |
> | 已装引擎（本机） | libvips 8.18.6、ImageMagick 7.1.2-31、pandoc 3.11、**FFmpeg n8.1.3-20260926（484 MB，应用内一键安装）**、**Poppler 26.09.0（120.7 MB，应用内一键安装）**、托管 Python 3.11.16；ONNX 权重 `u2netp` / `modnet-portrait` / `birefnet-lite` / `realesr-general-x4v3` / `realesrgan-x4plus` |
>
> 下面这段原始快照保留原样，**不要据此判断现状**：

### Cargo workspace

| 项 | 值 | 状态 |
| --- | --- | --- |
| `members` | `["crates/*", "apps/desktop/src-tauri"]` | ✅ |
| `version` / `edition` / `rust-version` | `0.1.0` / `2021` / `1.82` | ✅ |
| license | MIT | ✅ |
| `[workspace.dependencies]` 内部 crate | `core` / `process` / `engines` / `plugins` / `ai` 五个全部已声明 | ✅ |
| Tauri 相关依赖 | `tauri 2.11`（features 含 `specta`）、`tauri-build 2.6`、fs/dialog/shell/store/log/opener/updater 插件 | ✅ |
| 类型桥 | `specta` 与 `tauri-specta` 均锁 `=2.0.0-rc.25` 严格同版 | ✅ |
| 引擎层依赖 | `reqwest 0.12`（默认 native-tls）、`image 0.25`（`default-features = false`） | ✅ |
| 插件运行时依赖 | `extism 1.30` | ✅ |
| `Cargo.lock` | **不存在**（尚未产生锁定版本） | 🚧 |

### crates

| crate | 源文件 | 规模 | 状态 |
| --- | --- | --- | --- |
| `toolforge-core` | 11 个 `.rs`（`lib.rs` + `error` / `ids` / `permission` / `plugin` / `pipeline` / `job` / `engine` / `queue` / `events` / `paths`） | 5298 行 | ✅ 骨架完成，⛔ **无法编译**（见阻塞 1、2） |
| `toolforge-process` | 4 个：`lib.rs` / `exec.rs` / `rpc.rs` / `supervisor.rs` | 1579 行 | ✅ 骨架完成（JSON-RPC 2.0 按行分帧 + 子进程监督管理器） |
| `toolforge-engines` | 3 个：`lib.rs` / `registry.rs` / `nodes.rs`，外加 `engine-sources.json` | 2569 行 | ✅ 骨架完成（内置节点**执行器** + 引擎探测/下载/校验） |
| `toolforge-plugins` | 7 个：`lib.rs` / `audit.rs` / `store.rs` / `l1.rs` / `runtimes.rs` / `runtimes/wasm.rs` / `runtimes/python.rs` | 3092 行 | ✅ 骨架完成（L1 执行器 + L2 WASM + L3 Python + 插件仓库 + 审计） |
| `toolforge-ai` | 3 个：`lib.rs` / `provider.rs` / `review.rs` | 1466 行 | ✅ 骨架完成（生成链路 + 静态校验 + 安全审核） |

### 外壳与前端

| 项 | 状态 |
| --- | --- |
| `apps/desktop/src-tauri/` 配置层（`Cargo.toml` / `build.rs` / `tauri.conf.json`） | ✅ 骨架完成 |
| `apps/desktop/src-tauri/src/` | ✅ 骨架完成：`main.rs`（7 行，仅 `toolforge_lib::run()`）、`lib.rs`（297 行，`COMMAND_NAMES` + `specta_builder()`）、`commands.rs`（898 行）、`ipc.rs`（422 行）、`state.rs`（147 行）、`bin/export_bindings.rs`（33 行） |
| `apps/desktop/src-tauri/src/bindings.rs` | 🚧 不存在。根 `Cargo.toml` 的注释仍写着「所有导出类型都收敛在 `…/src/bindings.rs`」，但实现上 `specta_builder()` 在 `lib.rs`，导出产物是前端的 `bindings.ts`——**注释与实现不一致**（见不一致项 6a） |
| `apps/desktop/` 前端工程（React / Vite / TS） | 🚧 完全不存在：没有 `package.json`、没有 `src/`、没有 `vite.config.*`。因此 `pnpm dev` / `build` / `typecheck` / `lint` / `tauri:dev` / `tauri:build` 全部无法解析（见不一致项 4） |
| `assets/icon-source.png` | 🚧 不存在，`assets/` 目录也没有；`pnpm icons` 会在最后一步失败（见不一致项 6b） |

### 插件与文档

| 项 | 状态 |
| --- | --- |
| `plugins/` 示例插件 | ✅ 8 个内置 L1：`image-convert`、`batch-rename`、`video-to-gif`、`remove-bg`、`ebook-convert`、`ai-describe`、`image-upscale`，以及本轮新增的 **`doc-to-pdf`**（`doc.to-pdf` 这个节点此前**没有任何内置插件用它**，等于对普通用户不可达、也从未被真机跑过 —— 见 §3.2）；另有 `wasm-example`（L2，含已编译的 `plugin.wasm`）与 `python-example`（L3，含 `main.py`） |
| 示例插件的 `permissions` 写法 | ✅ 全部使用**正确的映射形式** `permissions: { capabilities: [...] }`，并逐一通过了用当前源码编译出的 `PluginManifest::validate()`（schema 曾变过一次，见阻塞 3） |
| `docs/ENGINE-MATRIX.md` | ✅ 已存在（439 行），引擎矩阵与降级规格 |
| `docs/ROADMAP.md` | ✅ 本文件 |
| `docs/ARCHITECTURE.md` / `docs/PLUGIN-SDK.md` / `docs/SECURITY.md` | 🚧 **不存在**，但已被代码/示例引用（见不一致项 6c、6d） |
| `README.md` | 🚧 仍是「Super Multi-functional Integrated Software」占位内容，尚未替换为 ToolForge 架构说明 |

### 脚本与工程基线

| 项 | 状态 |
| --- | --- |
| `scripts/env.ps1` | ✅ 已存在（把 Rust 工具链与 pnpm 指向仓库内 `.tools/`） |
| `scripts/gen-icon.mjs` | ✅ 已存在（182 行）。`package.json` 的 `icons` 脚本已能走到它 |
| `scripts/enginectl.mjs` | ✅ 已存在（`package.json` 的 `engines:list` / `engines:install` 指向它）。**历史**：这里曾写着"🚧 不存在，但 `package.json` 已引用"（见不一致项 4）—— 那个不一致已经消掉，本机实测 `list` 退出码 0 |
| `.gitignore` | ✅ 已就绪：忽略 `target/`、`/engines/`、`/models/`、`apps/desktop/src-tauri/{engines,models}/`、`plugins/**/target/`、`plugins/**/*.wasm`、`plugins/**/dist/`、`plugins/**/.venv/`、`.tools/`、`.cache/`，并且**显式说明前端的 `bindings.ts` 要入库** |
| `rust-toolchain.toml` | ✅ `channel = "stable"`、`profile = "minimal"` |
| CI 配置 | 🚧 不存在（无 `.github/` 等） |

### 已确定的技术决策（本节为约束，不再是可选项）

- 桌面框架：Tauri 2.11 + Rust，MSRV 1.82。
- 前端：React 18 + TypeScript 5 + Vite 5 + TailwindCSS 3.4 + Zustand + TanStack Query + React Flow（`@xyflow/react`）+ Framer Motion + shadcn/ui。
- 类型桥：specta 2.0.0-rc.25 + tauri-specta（严格同版），产物 `bindings.ts` 入库，日后可整体替换为 ts-rs。
- 三级插件运行时：
  - **L1 声明式**：`plugin.yaml` + 内置节点编排，零代码；
  - **L2 WASM**：Extism 沙箱，只允许纯计算（无文件系统、无网络、无 SIMD/线程）；
  - **L3 Python**：独立进程 + JSON-RPC over stdio，固定 Python 3.11。
- 引擎策略：**按需下载 + 系统探测降级**；图片链路的形态是「纯 Rust `image` crate 打底 → libvips 可选加速 → ImageMagick 兜底」——**现已落地在 4 个节点上**（`image.convert` / `image.resize` / `image.crop` / `image.rotate` 会真的挑后端、并在节点输出里报 `backend`），`image.enhance` 与 `image.strip-metadata` 仍只有纯 Rust 一路（见「不一致 2」的更新）。
- 安全模型：插件必须声明能力（Capability），用户**逐条授权**，运行时裁决 + 路径收敛。

---

## 当前阻塞项

以下条目均在**写入本文档前重新核对过一次**，核对方式写在每条里。

> **状态更新（最新一次实测，由委托方在 `crates/toolforge-core` 源码快照上跑真实 `cargo test --lib` 得到）**
>
> | 阻塞 | 状态 |
> | --- | --- |
> | 1 · `pipeline.rs` 字面量内嵌双引号 | ✅ **已修复**（已改用「」引号） |
> | 2 · `Some(-16.0.into())` 触发 E0282 | ✅ **已修复**（已写成 `Some((-16.0f64).into())` 并附注释） |
> | 3 · `PermissionSet` 与夹具不匹配 | ✅ **已消解，但方向与当初判断相反** —— 详见该条 |
> | 4 · `paths.rs` 的 `sanitize_id` | ⛔ **仍然成立**（唯一剩余的测试失败） |
>
> 当前基线：`cargo test --lib` → **编译成功，59 passed / 2 failed**，2 个失败全部来自阻塞 4。
> 本文档早先记录的「61 个测试中 54 通过 / 7 失败」**已过期**。

### 阻塞 1：`pipeline.rs` 字符串字面量内嵌 ASCII 双引号，导致 crate 无法编译 ✅ 已修复

- **位置**：`crates/toolforge-core/src/pipeline.rs`（约第 751 行）
- **当初的原文**（现已改）：

  ```rust
  description: "两遍压到目标体积附近，适合"发微信/上传附件"场景。".into(),
  ```

- **当时的编译错误**：`error: prefix 上传附件 is unknown`
- **影响**：`toolforge-core` 无法编译；由于 `process` / `engines` / `plugins` / `ai` 与 Tauri 外壳全部依赖它，整个 workspace 的 `cargo check` / `cargo test` 都拿不到结果。
- **现状**：已改为 `适合「发微信 / 上传附件」这类有体积上限的场景。`，不再破坏字面量。
- **核对方式**：读取该行原文 + 对 `toolforge-core` 源码快照跑真实 `cargo test --lib`（编译成功即为此项关闭的证据）。

### 阻塞 2：`audio.normalize` 的 `-16.0.into()` 类型推导失败 ✅ 已修复

- **位置**：`crates/toolforge-core/src/pipeline.rs`（约第 788–795 行）
- **当初的原文**：

  ```rust
  params: vec![param("lufs", "目标响度 (LUFS)", ParamType::Float, Some(-16.0.into()), false)],
  ```

- **现象**：`Some(-16.0.into())` 中一元负号让 `.into()` 的目标类型无法被推导。
- **当时的编译错误**：`error[E0282]: type annotations needed`
- **现状**：已写成 `Some((-16.0f64).into())`，并且代码里留了一行注释解释「括号与后缀是必需的」。
- **核对方式**：读取该行原文 + 对源码快照跑真实 `cargo test --lib`（编译成功即为此项关闭的证据）。

### 阻塞 3：`PermissionSet` 的 serde 表示与示例清单不一致 ✅ 已消解（方向与当初判断相反）

- **当初的事实**：`permission.rs` 的 `PermissionSet` 带 `#[serde(transparent)]`，因此 `plugin.yaml` 里的 `permissions` 必须是**裸数组**形式，而 `plugin.rs` 的夹具 `MINIMAL_L1` 用的是映射形式，于是有 5 个用例失败。
- **实际发生的事**：`#[serde(transparent)]` 被**移除**了，schema 改为映射形式。`permission.rs` 的注释现在写着：

  > ⚠️ 这里**刻意不加** `#[serde(transparent)]`：加了之后 YAML 会变成 `permissions: [ ... ]`
  > 这种裸数组，既不好读也没法在未来扩展字段。
  > 现在的形状是 `permissions: { capabilities: [ ... ] }`，**所有示例插件与文档都按这个形状写**。

  因此夹具本来就是对的，5 个用例现在**全部通过**（实测 `cargo test --lib`：59 passed / 2 failed，失败项只剩阻塞 4）。
- **⚠️ 连带后果（重要，已处理）**：schema 改向意味着**原先按裸数组写的 6 个示例 `plugin.yaml` 全部失效**，解析报
  `permissions: invalid type: sequence, expected struct PermissionSet`。
  现已全部改为 `permissions: { capabilities: [...] }` 并重新通过 `PluginManifest::validate()`；`docs/PLUGIN-SDK.md`、`docs/SECURITY.md` 中「`permissions` 是序列」的表述也已同步更正。
- **核对方式**：读取 `permission.rs` 的结构体定义与文档注释、跑真实 `cargo test --lib`、再用当前源码编译出的校验器逐文件跑 6 个 `plugin.yaml`。
- **状态**：**已关闭**。教训是：清单格式这类跨仓约定必须有校验器在 CI 里跑，否则一次 serde 改动就能静默作废全部示例。

### 阻塞 4：`paths.rs` 的 `sanitize_id` 实现与自身单元测试不符 ✅ 已修复

- **位置**：`crates/toolforge-core/src/paths.rs`
- **原实现**：先把非 `[A-Za-z0-9.\-_]` 的字符逐个替换成 `_`，**然后**才 `trim_matches('.')`。
- **原后果**：`sanitize_id("../../etc/passwd")` 返回 `_.._etc_passwd` —— `/` 先变成 `_`，于是 `..` 不再位于字符串首部，`trim_matches` 去不掉它。
- **修复方式**（按"改实现而不是改断言"）：
  1. 替换非法字符；
  2. **把连续的点折叠成单个点** —— `..` 结构上变得不可能出现；
  3. 去掉首尾的点；空串退回 `unnamed`。
- **测试也一并收紧**：`sanitize_blocks_traversal` 现在断言的是**不变量**
  （结果不含 `..`、不含 `/`、不含 `\`、非空）而不是具体字符串，
  并覆盖 `..`、`....//`、`..\..\`、绝对路径、空串、纯空白。
  新增 `sanitize_never_leaves_dotdot` 作为回归测试。

### 阻塞 5：`normalize_lexically` 会把两个 `..` 互相抵消 ✅ 已修复（本轮新发现，比阻塞 4 严重）

> 这一条是修阻塞 4 时顺出来的，**它是本仓库目前发现过的最严重的缺陷**：
> 它不报错、不崩溃，只是**静默地把路径穿越检查拆掉**。

- **位置**：`crates/toolforge-core/src/permission.rs::normalize_lexically`
- **原实现**：`Component::ParentDir => { if !out.pop() { out.push("..") } }`
- **缺陷**：当栈顶是**我们自己刚压进去的 `..`** 时，`PathBuf::pop()` 依然返回 `true`。
  于是 `../../evil` 被规范化成 `evil` —— 两个 `..` 互相抵消了。
- **影响面**：
  - `PathResolver::resolve` 对**相对路径**的穿越检查失效；
  - `toolforge-plugins::store::safe_relative_path`（AI 生成的 Bundle 落盘路径校验）完全失效。
- **为什么此前没暴露**：`PathResolver` 是把 `rel` 拼到绝对根目录**之后**再规范化的，
  根目录会先吸收掉 `..`，所以 `../../etc/passwd` 这类输入仍然被拦住了。
  真正漏掉的是"比根目录层级更深的 `..`"和"纯相对路径"两条路径。
- **修复方式**：只有当栈顶是 `Component::Normal` 时才回退，否则继续累积 `..`。
- **新增测试**：`dotdot_is_never_cancelled`（语义正确性）、
  `excessive_traversal_from_input_root_is_rejected`（比根更深的 `..` 必须被拒）。

### 阻塞 6：`content_hash` 把宿主自己写的状态文件也算进去 ✅ 已修复

- **症状**：`PluginStore::verify_integrity` **对任何刚装好的插件都返回 false**。
- **成因**：`finish_install` 的顺序是「算哈希 → 写 `.toolforge-state.json`」，
  而该文件当时不在 `content_hash` 的跳过列表里 → 下次校验时哈希必然不同
  → `quarantine_if_changed` 会把插件判定为"被篡改"并自动禁用。
- **影响**：这条如果流到用户手里，表现是"插件装完就自动禁用，日志说被篡改"，极难自查。
- **修复**：把 `.toolforge-state.json` 加入 `content_hash` 的 `SKIP_FILES`，
  并补回归测试 `content_hash_ignores_host_written_state_file`。

### 阻塞 7：被拒绝的 Bundle 安装会残留半个插件目录 ✅ 已修复

- **位置**：`crates/toolforge-plugins/src/store.rs::install`
- **原实现**：**边校验边写盘** —— 先 `create_dir_all`，再逐文件 `safe_relative_path` + 写入。
- **后果**：路径穿越在写到第 N 个文件时才被拒绝，前 N-1 个文件已经落盘，
  插件目录也留下来了（脏状态会干扰下一次安装与 `reload`）。
- **修复**：改成**先校验后写入** —— 全部文件在内存里解码 + 校验 + 累计体积，
  全部通过之后才 `create_dir_all`。
- **新增测试**：`traversal_bundle_leaves_no_partial_install`
  （第一个文件合法、第二个非法，断言磁盘上零痕迹）。

### 阻塞 8：`runnable()` 撞到第一个阻塞就返回，错误信息不可操作 ✅ 已修复

- **原实现**：校验 → 启用 → 授权，逐项 `return Err`。
- **后果**：新装的插件既不启用也未授权，用户只会看到"插件已被禁用"，
  改完启用再点运行，才发现"还有 1 项能力未授权"——修一个发现一个。
- **修复**：一次汇总全部阻塞原因，并在 `detail` 里分组列出
  「待授权的能力」与「校验问题」；`code` 按"插件坏了"（`PLUGIN_INVALID`）
  与"权限不够"（`PERMISSION_DENIED`）区分，前端才能给不同的引导。

### 阻塞 9：多文件输入只处理第一个，却报告全部成功 ✅ 已修复

- **位置**：`apps/desktop/src-tauri/src/commands.rs::plugins_run`
- **原实现**：把「12 个输入」塞进**一次** `run_pipeline`，而 L1 执行器里
  `${src}` 只绑定 `inputs.values().find_map(|v| v.first())` —— 即只取第一个路径。
  任务标题却是 `插件名 · 12`，最后**成功结束**。
- **影响**：这是最糟糕的一类 bug —— 静默地少干活，用户以为 12 张图都处理完了。
  它同时也是「`flow.foreach` 由命令层展开」这句文档谎言的根源。
- **修复**：命令层真正**扇出** —— 选文件数最多的输入端口作为主端口，
  展开成 N 个单文件批次，逐批调用执行器，用 `ctx.step` 上报「处理 3/12」，
  产出累计。单文件时退化为一次调用，行为与之前一致。
  至此 `l1.rs` 模块文档里"批量由命令层展开"才成为事实。
- **后续补强（`expand_batches` / `expand_dir`）**：**目录输入也会展开** —— 拖进一个文件夹就是逐个处理里面的文件。
  规则是**只展开一层**（不递归）、只收普通文件、跳过 `.` 开头的隐藏文件（含 macOS `._` 资源叉）、结果排序
  （不排序的话 `${batch.index}` 每次编号都不一样）、**上限 `MAX_DIR_EXPANSION = 5000` 且超限直接报错**
  （刻意不静默截断：截断会让用户以为全处理完了）。同时 `build_io` 对目录输入改用**目录自身**作授权根，
  不再用它的父级 —— 以前选 `D:\照片` 会把授权范围白送到 `D:\`。
  每个批次还能从 `${batch.index}`（1 起）/ `${batch.total}` 取到序号，`batch-rename` 这类"给每个文件编号"的需求因此可以纯声明式写出来。

### 阻塞 10：并发度设置改了但队列不理会 ✅ 已修复

- `SettingsPatch.concurrency` 原来只写进 `Settings` 结构体，`JobQueue` 的信号量纹丝不动 ——
  用户改设置等于没改。
- 修复：新增 `JobQueue::set_concurrency()` 并在 `settings_patch` 里调用。
  **降低并发是渐近生效的**（`Semaphore::forget_permits` 只能收回空闲许可），
  这一点已写进该方法的文档注释 —— 中途掐断任务会留下半个输出文件。

### 阻塞 11：任务临时目录永不清理 ✅ 已修复

- 每个任务会分配 `<data>/work/<jobId>`（插件的 `$WORKSPACE` 作用域），
  但从来没人删它 —— 跑几百个任务后缓存目录会堆到几 GB。
- 修复：在**外壳层的事件桥**里，收到 `JobFinished` 且状态为终态时删除该目录。
  刻意不放在 `JobQueue` 里：队列属于领域层，**不应该知道磁盘布局**。

### 阻塞 12：🔴 绝对路径被一律拒绝，导致**任何真实转换都失败** ✅ 已修复

> **这是整个项目发现过的最严重的功能性缺陷**，而且它躲过了当时全部的自动化检查：
> 196 个单元测试 + 6 个集成测试 + 完整的前端类型检查 + 9 个页面的渲染冒烟 **全绿**。
> 它是靠**真跑一次应用、提交一个真实任务**才暴露的。

- **现象**：在真机窗口里对一个真实 PNG 提交转换，任务立刻失败：

  ```text
  错误码    : PERMISSION_DENIED
  错误信息  : 插件不允许使用绝对路径：D:\...\gradient.png
  ```

- **成因**：`PathResolver::resolve()` 对绝对路径一律拒绝，而 `l1.rs` 把
  `${src}` / `${input.<port>}` / `${output.<port>}` 绑定成**真实的绝对路径**
  （那就是用户选中的文件）。规则自相矛盾：宿主自己注入绝对路径，又禁止绝对路径。
- **为什么测试没抓到**：所有 `PathResolver` 的测试都是拿**相对路径**直接调 `resolve()`，
  没有一个走过"用户选中的绝对路径 → 模板渲染 → 节点 → resolver"这条真实数据流。
  这正是"单元测试全绿但集成没接线"的又一形态。
- **修复**：绝对路径与相对路径**走同一条检查** —— 两侧都做词法规范化，然后
  `starts_with(授权根)`。**安全性没有削弱**：挡住穿越的从来是那个组件级比较，
  而不是"必须相对"这个代理规则。

  | 输入 | 旧行为 | 新行为 |
  |---|---|---|
  | 根内相对路径 `a/b.png` | 放行 | 放行 |
  | 根内绝对路径 `D:\in\a.png` | **拒绝（bug）** | 放行 |
  | 逃逸相对路径 `../../etc/passwd` | 拒绝 | 拒绝 |
  | 根外绝对路径 `C:\Windows\System32` | 拒绝（理由错） | 拒绝（理由对） |

- **回归测试**：`absolute_path_inside_root_is_allowed`、
  `dotted_and_trailing_separator_roots_compare_correctly`。
- **端到端验证**（`.tools/cdp-verify.mjs`，通过 CDP 驱动真实 WebView）：
  装一个**恶意清单**（步骤里写死 `C:\Windows\System32\drivers\etc\hosts`）、授权、启用、
  真跑一次 → 任务在真实链路上被拒绝（`PERMISSION_DENIED — 路径逃逸被拦截`），
  然后再把它卸掉。**12 项检查全通过。**

### 阻塞 13：`freezePrototype: true` 让整个前端白屏 ✅ 已修复

- **现象**：`pnpm tauri:dev` 能起窗口，但页面**全白** —— React 从未挂载
  （`#root` 子节点数 = 0）。
- **真因**（靠 CDP 读 WebView 的异常抓到的，`PrintWindow` 截图抓不到 WebView 内容）：

  ```text
  TypeError: Cannot assign to read only property 'constructor' of object '[object Object]'
      at define_default (@xyflow_react.js:1323)
  ```

  `tauri.conf.json` 的 `app.security.freezePrototype: true` 会冻结 `Object.prototype`，
  而 `@xyflow/react`（流程编辑器，需求里点名的技术选型）在模块初始化时就要写它 ——
  一个顶层 import 抛异常，整个应用白屏。
- **修复**：`freezePrototype: false`。取舍是明确的：`freezePrototype` 是纵深防御的一层
  （防原型污染），但它与一个**必需依赖**不兼容。主要的防护仍是严格 CSP、
  `withGlobalTauri: false`、以及能力白名单。
- **教训**：这条**只有真跑才会暴露**。任何"渲染冒烟"如果不检查 `#root` 有没有子节点、
  不读取页面异常，就只是"dev server 起来了"而已。

### 阻塞 14：裸命令名不查 PATH，"一键安装引擎"整条路必然失败 ✅ 已修复

> 与阻塞 12、13 同一类：**读代码看不出来，真跑一次才暴露**。

- **现象**：装引擎时下载成功、SHA-256 校验通过，然后卡在解压，报
  「可执行文件不存在：tar」——**错误信息把责任指错了地方**（`tar` 明明在
  `C:\Windows\System32\` 里）。
- **成因**：`exec_streaming` 执行前会检查 `opts.program.exists()`，而
  `Path::new("tar").exists()` 对**裸命令名永远是 `false`** —— `exists()` 是按当前
  工作目录解析相对路径的，**根本不看 PATH**。引擎安装解压 `.zip` / `.tar.gz` 用的
  正是 `ExecOptions::new("tar")`，所以"一键安装引擎"**从来没有成功过**。
- **修复**：新增公开函数 `toolforge_process::resolve_program()`：
  - 带路径分隔符的（`./x`、`C:\a\b.exe`、`/usr/bin/x`）**原样校验、不查 PATH**（调用方
    明确给了路径，就不该被 PATH 里同名的东西顶掉）；
  - 裸名字按 PATH 逐项找，Windows 上再按 `PATHEXT` 补后缀。
- **回归测试**：`bare_name_is_resolved_through_path`、`windows_addes_pathext_suffix`、
  `explicit_paths_never_fall_back_to_path`、`bare_name_actually_executes`。
- **验证**：修好之后通过应用真实安装了 libvips 8.18.6（见 v0.2 的引擎条目）。

### 阻塞 15：`quiet(true)` 把输出**全丢了**，于是所有引擎版本都显示「未知」✅ 已修复

- **现象**：引擎管理里每个引擎的版本号都是「未知」；引擎执行失败时 `stderr` 是空的，
  报错没有任何可操作的细节。
- **成因**：`ExecOptions.quiet` 的字段注释写的是"**是否只保留尾部输出**"，而实现写成了
  `if !opts.quiet { push_line(..) }` —— **quiet 时一行都不留**。`probe_version` 用的就是
  `.quiet(true)`，于是它什么都读不到。
- **修复**：让实现与注释一致 —— `keep_head = !opts.quiet`，即**只关掉头部 32 KB 的累积，
  尾部 96 KB 照常保留**。
- **回归测试**：`quiet_still_keeps_output`、`probe_version_returns_something`、
  `tail_buffer_without_head_still_keeps_tail`（最后一条同一次修复带出来的次生缺陷：
  quiet 下头部恒为空，早期实现照样插一句"中间输出已省略"）。
- **仍未定义的部分**：`EngineState::Outdated`（版本过旧）**没有最低版本判定标准**，
  所以"能读到版本号"成立、"低于多少算过旧"仍待定。

### 阻塞 16：三个**"只有真的重建一次才会暴露"**的缺陷 ✅ 已修复

> **这一条本身就是教训。** 它之所以晚了这么多轮才被发现，是因为 `toolforge.exe` 被一个**无关的游戏进程**持有文件句柄，cargo 写不回链接产物（`link.exe` 1104），于是**那个二进制好几轮没有重建过**。
> 期间 `cargo check` 0 error、单测全绿、文档一路在更新 —— 而这一切说的都是**源码**，不是那个跑起来的 exe。
> **"编译通过 + 单测全绿"对一个没有重新构建的二进制毫无意义。** 句柄一释放、重建一次，三个缺陷立刻同时现形。

1. **内置插件目录被 `target/` 里的陈旧副本遮蔽（最严重）**。
   - **现象**：从规范路径 `target/debug/toolforge.exe` 启动，**7 个内置插件只装载 4 个**，另外 3 个报「未安装」；**同一个二进制**从 `target/debug/deps/` 启动却是 7 个。表面上看起来像"插件坏了"，实际是**路径解析**。
   - **成因**：`resolve_builtin_plugins()` 一律"先看 `resource_dir()`"。开发构建下它就是**可执行文件所在目录**，而 `target/debug/plugins/builtin/` 里有一份 `tauri-build` 在**构建期**拷过去的 `bundle.resources` —— 它只在构建脚本认为需要时刷新，**新增一个内置插件不会触发它**，于是那份拷贝永远停在只有 4 个插件的时间点。
   - **修复**：**开发构建优先用仓库目录**（那才是开发时的真相来源），**只有发布构建才先看 `resource`**。详见 `docs/ARCHITECTURE.md` 开放项 10。
2. **下载失败的错误信息把原因吃掉了**。装 ImageMagick 时报的是 `请求下载地址失败：error sending request for url (https://github.com/...)` —— reqwest 的连接类错误 `Display` **只给这一句、不含原因**，而**同一时刻系统 `curl` 拿同一个 URL 是 200 / 11.7 MB 正常下完**。于是完全无法判断是 DNS、连接被拒、TLS 还是超时。
   - **修复**：新增 `describe_reqwest_error()` —— 按 `is_timeout` / `is_connect` / `is_decode` 分类给人话，并把 `source()` 链**逐层展开**（真正的原因如 `tls handshake eof`、`connection refused` 都在链上），detail 里补上"**用 curl 对照一下**"。详见 `docs/ARCHITECTURE.md` 3.3。
3. **卡死检测只能靠"等 60 秒"来验证 → 等于没有被验证**。stall 超时原来**硬编在 `stream_to_file` 里**，唯一的验证方式是干等 60 秒，没人会做。
   - **修复**：把它变成**参数**（生产传 `STALL_TIMEOUT`，测试传 300 ms），于是 `stalled_download_fails_with_a_readable_error` 能用一个**裸 TCP server**（收请求 → 回 `200` 头 → 永远沉默）真的测它，断言错误码 `Network`、信息里说清「卡住」、**<10 s 返回**（证明不是靠 30 分钟总超时）、**半截文件被删掉**。`toolforge-engines` 测试数 37 → 38。
   - **次生收获**：CDP 脚手架自己的报错也在骗人 —— `cdp.mjs::evaluate()` 只取 `exception?.description ?? text`，页面 reject 一个**普通对象**（Tauri 的错误就是这么走的）时两者都是 `undefined`，最终抛出一句 `Error: Object`。**真实原因被自己的错误处理吃掉了**，那几轮"脚本挂了但不知道为什么"就是这么来的。现在它把 description / text / value / preview 全摊开，于是立刻看到真凶：`插件 com.toolforge.builtin.ebook-convert 未安装`（也就是上面第 1 条）。

### 阻塞 17：**两个从未被执行过的运行时**，一共藏了 9 个缺陷 ✅ 已修复

> **这一条是"阻塞 16"的下半场，而且更彻底。** 阻塞 16 的教训是"没有重建的二进制不算数"；
> 这一条的教训是"**没有跑过的运行时不算数**"。三级插件里 L1（内置流水线）天天在跑，
> 而 **L2（Extism WASM）与 L3（Python 子进程）从写出来那天起一次都没被执行过** ——
> 它们的单元测试、清单校验、`cargo check` 全是绿的，示例插件也"在仓库里躺着看起来没问题"。
>
> 真的装一次、授权一次、跑一次之后，**9 个缺陷同时现形**，其中 4 个是"必然失败"级别。

**先装进去就失败的（L2）**

1. **示例插件的构建目标选错了，装上也跑不起来**。`plugins/wasm-example` 的构建说明写的是
   `--target wasm32-wasip1`。而 Rust 的 **wasip1 版 std 在启动时无条件读环境变量**
   （`std::rt::init` 调 `environ_get`），所以任何用 std 写出来的 wasip1 模块**必然**导入
   `wasi_snapshot_preview1`；宿主又刻意关掉了 WASI（`with_wasi(false)`，这是"插件没有文件系统"
   的实现手段），于是实例化直接失败：
   `unknown import: wasi_snapshot_preview1::environ_get has not been defined`。
   **wasip1 对这个宿主来说是错的目标，不是"配置问题"。**
   - **修复**：两个示例插件与 `docs/PLUGIN-SDK.md` 全部改成 `--target wasm32-unknown-unknown`；
     并在装载前用 `wasmparser` **读一遍导入段**（`runtimes/wasm.rs::inspect_imports`），
     遇到 WASI 导入直接给出"请改用 `wasm32-unknown-unknown` 重新构建"。
     同一处还顺手补上了"导入了宿主没提供的自定义宿主函数"的精确报错（此前只有 wasmtime 那句
     `unknown import`）。
2. **插件的参数载荷形状是错的 —— 文档对、实现错**。`PluginCallRequest::payload` 的 `params`
   曾经直接塞 `ParamValue`，而它的 serde 形状是 `{"kind":"int","value":5}`
   （那是给前端做可判别联合用的**内部**约定）。后果是**两个语言不同、互相独立的示例插件同时挂掉**：
   L2 报 `invalid type: map, expected a string`，L3 报 `无法把 {'kind': 'int', 'value': 5} 解释为整数`。
   而 `docs/PLUGIN-SDK.md` 与两个插件的注释里写的都是 `"params": { "format": "webp" }`。
   - **修复**：新增 `ParamValue::to_plain_json()` / `params_to_plain_json()`，给插件的一律是裸值；
     测试里带一条**反证**（断言 `serde_json::to_value(ParamValue::Int(5))` 与 `json!(5)` **不相等**，
     否则"转换"这回事可能根本没人验证过）。
3. **能力标签给的是 Rust 的 Debug 输出**。`capabilities` 载荷曾经是 `format!("{c:?}")`，
   于是插件收到 `["FsRead { scope: Input }"]` 而不是文档写的 `["fsRead"]`。
   `plugins/python-example/main.py` 里 `if "fsRead" not in caps: raise ...` 于是**永远成立** ——
   那个插件必然报"没有 fsRead 能力"，而用户明明授权了。L2 的两个示例只是把标签打进日志，所以没暴露。
   - **修复**：新增 `Capability::label()`（camelCase，与清单里的 `kind:` 逐字一致），载荷改用它。
4. **`${output.<第二个端口>}` 根本解析不了**。`build_io` 只为 `dst` 分配输出路径，声明了第二个
   输出端口的插件在第一步就报 `模板变量 ${output.frame} 无法解析`。内置的 `video-to-gif`
   **从写出来那天起就没跑通过**。

**跑起来但结果不对的**

5. **多步流水线在第二步就断（路径收敛与作用域冲突）**。中间产物落在**输出**目录里，
   下游步骤却用 `src` 端口（Input 作用域）去读它 → `PERMISSION_DENIED`
   「路径逃逸被拦截：… 解析后落在授权目录之外」。这个缺陷**被第 4 条挡住了**：
   模板变量先解析不了，所以没人走到这一步。修掉第 4 条之后它立刻现形。
   - **修复**：`PathResolver::with_read_root()` —— **只对读**放开"输入根 ∪ 输出根"，
     写仍然必须落在该作用域自己的根里。两条新测试钉住（含一条反向：只读根不会放宽写）。
6. **插件报错的文案永远到不了用户眼前**。Extism 1.30 只在**输出已被设置**时读取插件设置的错误
   （`plugin.rs`: `if output_res.is_ok() && self.extism_error_is_set()`），而 PDK 的
   `#[plugin_fn]` 在 `Err` 分支上只 `error_set`、不设置输出 —— 于是作者写的所有可操作提示都丢了，
   用户看到的是一句 `0x8bd7 - <unknown>!<wasm function 92>`。
   - **修复**：L2 的错误约定改为**把错误放进返回值**（`{"error": "…"}`），宿主据此失败任务；
     示例插件里的 `fail()` 直接可抄。宿主的错误映射也改用 `{e:?}`（anyhow 的 Display 只给最外层
     一句话，真正的原因在 cause 链上），并对"只有回溯没有 cause"的情况补一句"为什么 + 怎么办"。
7. **L2/L3 的产出根本没有映射回输出端口**。宿主只认 `outputs` 是**数组**的老写法，而文档写的、
   插件返回的是**对象**（`{"swatch": "…png"}`）；对象形态被静默忽略，落到 `build_io` 算出来的
   那个路径上 —— 而那个文件**从来没有人写过**。任务于是"成功"，产出列表里挂着一个不存在的文件。
   - **修复**：`interpret_plugin_response()` 逐条对照清单声明的输出端口：文件类端口必须是
     **真实存在**且**落在输出目录之内**的路径（越界判 `PERMISSION_DENIED` + 记审计，
     不存在记 warning 且不计入产出）；非文件端口当成**值**写进任务日志
     （否则"输出一段 JSON"的插件跑完，用户在界面上什么都看不到）。
8. **启用门槛把"最小授权"变成了恒等式**。`set_enabled()` 原先要求"清单声明的每一项都已授权"，
   而 `set_granted()` 又只接受声明里有的 ⇒ `已授权 == 声明` ⇒ 运行期那句
   "声明 ∩ 授权"**永远等于声明本身**。也就是说 `effective()` / `allowed_hosts_from()` /
   `CapabilityGuard` 里那套"少一个都不给"的逻辑在真实链路上**从来没被走到过**。
   实际代价还更糟：插件只要申请了一项你不想要的权限（最典型的是"任意主机 net"），
   你就只能整包放弃 —— 这正是"最小授权"想避免的**习惯性全选**。
   - **修复**：去掉那道门。现在的模型是一条直线：**装**（校验 + 落盘）→ **启用**（你说了算）→
     **用**（碰了没授权的动作就当场拒绝并记审计）。缺哪些能力由
     `PluginStore::ungranted_declared()` 在运行前作为**警告**报出来。
9. **L2 的 `net` 勾了也没用，而 `hosts` 带端口必然失配**（本轮更早的一个提交，一并记在这里）。
   宿主此前从不设置 Extism 的 `allowed_hosts`（`None` = 一切请求被拒），
   用户在授权面板上勾 `net` **没有任何效果**；而 Extism 的匹配用的是 `url.host_str()`，
   **端口不参与比较**，所以清单里写 `api.example.com:443` 永远匹配不上 —— 作者以为写得更严格，
   实际得到一个必然连不上网的插件。前者改 `allowed_hosts_from()`，后者加
   `NET_HOST_WITH_PORT` 校验错误 + 运行期防御性剥端口。

**顺带补上的两个"同一类"问题**：`WASM_WITH_PERMISSIONS` 校验警告曾把 `net` 也算作
"WASM 访问不到的能力"（那句话对网络是**错的**，会引导作者删掉一个必须声明的东西）；
授权面板上 `capabilityEnforcementNote(net)` 写着"宿主不代插件发 HTTP、没有运行时校验白名单" ——
它对 L3 仍然成立，对 L2 已经变成**假的**。两处都改成按运行时分别陈述。

**还有一个是"跑起来顺手撞见的"**：修好上面第 4、5 条之后真机跑 `video-to-gif`，
`git status` 里冒出一个 `plugins/audit/`。原因是 `l1.rs::record_dir_audit()` 按
"插件目录是 `<data>/plugins/<id>`"**反推**审计目录（`dir.parent().parent().join("audit")`）——
那个假设对用户插件成立，对**内置插件**不成立（`<仓库>/plugins/builtin/<id>`），于是：
位置不对（不在应用数据目录里）、**污染工作树**、并且让 L1 与 L2/L3 的审计落在两个地方
（后者走 `PluginRunner` 注入的 AuditLog，位置是对的）。事后取证时"同一个事件在哪个文件里"
取决于运行时，这本身就不该发生。
- **修复**：`run_pipeline()` 增加 `audit: &AuditLog` 参数，由命令层传**应用那一个**；
  旧函数留着并标注废弃，让"曾经这么错过"在代码里可查。

**这一轮的验收方式**：新增 `scripts/devtools/verify-runtimes.mjs`（**50 项**），
其中最有价值的一组是 **L2 的 net 对照实验** —— 同一个插件、同一份输入，只改授权/主机名：

| 状态 | 请求 | 期望 |
| --- | --- | --- |
| 撤销全部授权（仍启用） | `http://127.0.0.1:PORT/` | ❌ `is not allowed` |
| 授权 `net{hosts:["127.0.0.1"]}` | `http://127.0.0.1:PORT/` | ✅ 成功，标题/描述/状态码都对 |
| 同上 | `http://localhost:PORT/` | ❌ `is not allowed` |

最后一行是**反证的核心**：同一个服务、同一个端口，只有主机名不同 ——
所以"成功→失败"这个差异只可能来自白名单的逐主机匹配。没有它，"被拒绝了"无法与
"网络本来就是坏的"区分开。

### 阻塞 18：FFmpeg 装通之后，7 个音视频节点第一次被跑 ✅ 已修复

> 与阻塞 17 同一类：**"登记在目录里"和"真的跑过"是两件事**。这 7 个节点在 FFmpeg
> 装通之前一直显示"不可用"，所以**没有任何人执行过它们**；`cargo check`、单测、
> 节点面板全是正常的。FFmpeg 装好之后真跑一遍，三个缺陷现形。

1. **`video.trim` 切出来的长度是请求值的两倍**。实测（3 秒 / 15fps 的源，`-ss 00:00:01 -t 1 -c copy`）：

   | 参数 | 帧数 | 容器时长 |
   |---|---|---|
   | 源 | 45 | 3.00 s |
   | 带 `-avoid_negative_ts make_zero`（旧行为） | **30** | 2.02 s |
   | 去掉它（现在） | **15** | 1.02 s |

   原理：`-ss` 放在 `-i` 之前是**输入定位**，流复制只能从关键帧开始切，于是视频包时间戳从 0 起、音频包从 1.0 起；`make_zero` 再平移整条时间轴，容器就认为这段有 2 秒。
   **"看起来更保险的那个参数"反而把行为改坏了**，而唯一的发现方式是量一下帧数 ——
   "任务成功"与"文件时长对"是两件事。
   > 顺带记一个方法论：这一条最初只断言了"时长在 0.3~1.8 秒之间"，而 2.02 秒**刚好落在区间外**才被抓到；如果阈值再松一点就会被放过。现在断言的是**帧数**（15 帧 = 1 秒 @15fps），那是这个缺陷的指纹。
2. **`video.transcode` 的容器参数是装饰**。节点面板上的参数叫 `container`，而真正决定输出容器的是**输出文件的扩展名**，扩展名由 `build_io` 从参数表里的 **`format`** 推导。于是用户在面板上选 mkv，产出仍然是 `.mp4`。这与 `image.remove-background` 曾经那个 `alphaMatting` 是同一类缺陷（**参数是装饰**）。现在统一成 `format`（与 `image.convert` / `audio.convert` 一致）。
   同时补了一条**兼容性预检**：WebM 只接受 VP8/VP9/AV1 + Opus/Vorbis，选错了会在**调用 ffmpeg 之前**被拒并说清该怎么办 —— 否则用户看到的是 `Could not find tag for codec h264 in stream #0`。
3. **`audio.normalize` 会悄悄把 44.1 kHz 变成 48 kHz**。`loudnorm` 在 192 kHz 上内部处理、再落到编码器的默认采样率，而用户只要求"归一化响度"。现在用 ffprobe 读出源采样率并显式 `-ar` 保住它（新增 `ffprobe_audio_rate()`，与 `ffprobe_duration()` 共用 `ffprobe_binary()`）。

**验收**：`verify-platform.mjs`【17】。它造一段**带音轨**的源视频（没有音轨的话 extract-audio / audio.convert / audio.normalize 三个节点根本测不出真东西），再用一条**真有依赖关系**的五步链路跑过去（切一段 → 抽封面 → 提音轨 → 响度归一化 → 转 m4a），最后用 **ffprobe 读回真实属性**逐条断言（时长、帧数、编解码器、采样率、像素尺寸、容器格式）。"任务成功"不算证据，"产出的确是那种东西"才算。

### 阻塞 19：抠图模型补齐来源，顺带补上"按模型决定的预处理" ✅ 已修复

> 上一轮（阻塞 17/18）反复出现的教训是"**登记在目录里**和**真的跑过**是两件事"。
> 模型权重这一块同样如此：`birefnet-general` / `modnet-portrait` 长期没有下载源，
> 而**另一个隐患更隐蔽** —— 抠图脚本把输入尺寸硬编成 320×320、归一化写死 ImageNet
> 统计量。这两件事**喂错了都不会报错**，只会给出一张糊掉的蒙版。
>
> **同日补充**：这一条最初把三个 HF 上的权重都指向社区镜像 `hf-mirror.com`，
> 理由是"官方源在部分网络下不可达"。加速器打开之后重新验证，官方源其实可用，
> 于是改成 **`fallback_url`：官方优先、镜像兜底**（见第 2 条）。

1. **三个模型的来源补齐**（哈希全部来自真实下载，**并且都走通了应用内下载 + 哈希校验 + 推理**）：

   | 模型 | 体积 | 来源 | 实测 |
   |---|---|---|---|
   | `modnet-portrait` | 25 MB | 官方 `huggingface.co`（+ 镜像兜底） | 21 秒下完 |
   | `birefnet-lite` | 214 MB | 官方 `huggingface.co`（+ 镜像兜底） | 69 秒下完 |
   | `birefnet-general` | 928 MB | 官方 `huggingface.co`（+ 镜像兜底） | 约 570 秒下完（第一次主源 502 + 镜像卡死，重试成功） |

   > `birefnet-lite` 的两个来源（HF 与 rembg 的 GitHub release）**逐字节相同** ——
   > 这一点是用文件大小 + sha256 比对确认的，不是推断。
   >
   > `modnet-portrait` 是"不可商用"权重，所以下载前要求确认许可证 —— 这条门原本就有。

2. **下载源改成"官方优先、镜像兜底"**（`EngineModel::fallback_url`）。

   只填官方 → 官源不可达的网络下一个模型都下不了；只填镜像 → 所有用户都依赖第三方、
   而且镜像会抖。两个都填、按顺序试，才对两边都成立。备用地址必须与主地址指向**同一个资产**，
   有一条测试（`fallback_urls_point_at_the_same_asset`）按"去掉主机名后路径逐字相同"守着 ——
   兜底填成另一个版本时，表现会是"下载成功但哈希不符、文件被删"，而真正的原因在报错里完全看不到。

   **这条兜底路径本轮真的被触发过一次**（此前只写在代码里、从没被执行过）：

   ```text
   下载 birefnet-general 失败：主源与备用源都不通
   主源 huggingface.co：HTTP 502 Bad Gateway（HTTP/1.1 重试后仍然失败）
   备用源 hf-mirror.com：下载卡住了：60 秒内没有收到任何数据
   ```

   两个源都说了名字、都说了各自为什么失败，而且**重试一次就成功了** —— 说明那次是瞬时的。
   日志里还会写一句「已从备用源（…）下载完成」，所以"兜底到底有没有被用上"是可查的。

3. **预处理改成"按模型决定"**（这一步比补来源更重要）。`py/rembg.py` 原来硬编：
   输入 320×320、ImageNet 归一化。而
   * **BiRefNet 的输入固定 1024×1024**（喂 320 会直接形状报错）；
   * **MODNet 用 `(x/255-0.5)/0.5`（即 [-1,1]）**，喂 ImageNet 统计量**不报错**，只是蒙版糊掉。

   现在脚本**问模型自己**（读 `get_inputs()[0].shape`）：固定尺寸就照它来，动态才退回 320；
   归一化由宿主按模型显式传 `--normalize`（`nodes.rs::rembg_normalize_for`，配一条漂移守卫测试）。
   脚本还会把实际用的**尺寸与归一化**回报给宿主，宿主写进任务日志 ——
   出问题时这两项是首先要确认的东西，没有它们就只能去翻脚本源码猜。

4. **下载客户端的连接超时从 20 秒放宽到 60 秒**。这是**实测逼出来的**：
   网络降级时段里，同一个 GitHub 地址用 `curl` 花 9 分钟能下完 213 MB，
   而应用在**连接阶段**就报 `client error (Connect) → operation timed out` ——
   它连"开始下"都没做到，用户看到的是"网络错误"，而真实情况只是**这条线路慢**。
   （下载失败本来就会用 HTTP/1.1 再试一次，现在又多了备用源，所以最坏情况是几次重试。）

**验收**：`verify-platform.mjs`【8】新增一段 —— **逐个已装模型真跑一遍**，并把脚本实际用的
尺寸与归一化读回来断言：

| 模型 | 期望输入 | 期望归一化 | 实测前景占比 |
|---|---|---|---|
| `u2netp` | 320×320 | imagenet | 18.87% |
| `modnet-portrait` | 320×320 | **pm1** | 18.83% |
| `birefnet-lite` | **1024×1024** | imagenet | 18.83% |
| `birefnet-general` | **1024×1024** | imagenet | 19.24% |

四个模型在同一张"白底 + 椭圆"图上给出几乎一致的占比，这本身就是一条交叉验证 ——
而"任务成功"在这里完全不能说明问题（预处理喂错也是"成功"）。

### 基线（历史实测：阻塞 1–13 修复后）

阻塞 1–13 全部修复后的**真实**运行结果（分两层：静态检查，与**真机运行**）。注意：这是**历史值**，当前值见下面的「基线再更新」：

```text
【静态】
cargo check --workspace --all-targets   →  0 error / 0 warning
cargo test（core / process / engines / plugins / ai + plugins 集成测试）
  toolforge-ai       25 passed
  toolforge-core     72 passed
  toolforge-process  19 passed
  toolforge-plugins  38 passed
  toolforge-engines  35 passed
  example_plugins     5 passed   （6 个真实示例清单逐个跑当前校验器）
  ─────────────────────────────
  合计              194 passed; 0 failed

cargo run -p toolforge --bin export-bindings
  → apps/desktop/src/bindings.ts（29 个命令 + AppEvent）
  → 并执行 4 项守卫（AppEvent / 事件通道常量 / 命令清单逐条核对 / 节点实现状态）

【真机运行】pnpm tauri:dev + CDP 驱动真实 WebView（.tools/cdp-*.mjs）
  窗口          → 句柄非 0、标题 ToolForge
  9 个页面      → 全部渲染、0 运行时异常、0 骨架屏卡死
  IPC 往返      → system_status 真实返回「引擎 2/11、存储正常、windows、debug」
  真实任务      → 320x200 PNG → 无损 WebP（VP8L 解码确认尺寸一致）
  多文件扇出    → 3 张进、3 个**不同**文件出、磁盘上 3 个
  安全（端到端）→ 装一个路径穿越的恶意插件并运行 → 被拒绝、且已清理
  小计          → 12 项检查全通过
```

> 更新：这份基线是**当时的实测记录**，保留原样。此后引擎层新增了三条模型命令
> （`models_list` / `models_install` / `models_remove`，见 v0.5 的「模型文件管理」），
> `COMMAND_NAMES` 因此从 29 变成 **32** —— 上面的「29 个命令」是历史值，不是现状。

前端侧（`apps/desktop`）由并行开发补齐，验收命令是：

```bash
pnpm typecheck      # tsc --noEmit
pnpm build          # tsc --noEmit && vite build
```

早期记录「修掉阻塞 1、2 后为 54 通过 / 7 失败」是当时快照，保留在阻塞 3 的条目里作为历史。

### 基线再更新（**当时的值**，保留作历史）

> ⚠️ 下面这组数是**当时**取的，**不是现状**。当前值见本文档开头的「实测数据」表
> （`cargo test --workspace` **286 passed / 0 failed**、`verify-platform.mjs` **401 项**）。
> 留在这里是为了保留"那一轮到底测到了什么"。

阻塞 14、15 修复后重新取的一组数（上面那组保留为历史，**不要把两组混用**）：

```text
【静态】
cargo test --workspace                  →  218 passed / 0 failed
cargo run -p toolforge --bin export-bindings
  → 生成 32 个命令的绑定 + 4 项守卫（其中「命令清单逐条核对」已取代被删除的魔数断言）

【真机运行】
scripts/devtools/verify-platform.mjs    →  82 项检查全通过（【1】–【13】）
                                            （run.mjs 里的第 5 个脚本；【6】= 图片后端，
                                             【7】= 任意角度旋转，【8】= 抠图整条 ONNX 链路，
                                             【9】= 电子书降级与拦停，【10】= ai.describe 的
                                             请求形状（假端点 mock-openai.mjs），
                                             【11】= 超分是不是真的按倍数放大，
                                             【12】= 藏掉 libvips 目录、断言后端真的切到
                                             ImageMagick、再在 finally 里还原
                                             （只在这两个引擎都装了时才跑，否则显式跳过），
                                             【13】= 两个引擎的托管目录都藏掉、断言纯 Rust
                                             兜底档接得住（后端 = 纯 Rust、任务仍然成功、
                                             产出无损 VP8L、并如实提示「只有无损模式」），
                                             同样在 finally 里还原）
一键安装引擎                            →  libvips 8.18.6 真实装上：
                                            下载 ≈30 MB → SHA-256 校验 → 解压 → installed
                                            落盘 <data_dir>/engines/libvips/bin/vips.exe（≈29.67 MB）
                                         →  imagemagick 也真实装上（这条以前记的是"未复验"）：
                                            11.7 MB → SHA-256 校验 → 系统 tar 解开 .7z
                                            → magick.exe 落在 …/engines/imagemagick/magick.exe
                                              241.5 MB，探测版本 ImageMagick 7.1.2-31 Q16 x64
                                         ⚠️ FFmpeg 仍未装成：www.gyan.dev 在本机不可达（环境事实，不是代码缺陷）
图片三层降级                            →  image.convert / resize / crop / rotate 真的挑后端，
                                            节点输出报 backend、日志写明用的是哪个
                                         →  中间档（ImageMagick）也实测过：临时改名藏掉 engines/libvips
                                            → 后端日志 = ImageMagick（格式最全）、产出有损 VP8 WebP
                                            → 还原后 libvips = installed
AI 抠图（image.remove-background）      →  托管 Python 3.11.16（145.2 MB，tar.gz 路径）装成；
                                            独立 venv 自动装上 onnxruntime-1.30.0 /
                                            numpy-2.4.6 / pillow-12.3.0；
                                            400×300 测试图 → RGBA PNG（colorType 6）、
                                            椭圆中心 alpha 254、角落 0、前景覆盖 18.87%
                                            （与椭圆真实面积吻合）；
                                            运行时就绪后单张推理 ≈0.7 s（首次含 pip ≈32 s）
                                             权重：u2netp
AI 超分（ai.upscale）                   →  Real-ESRGAN 分块推理（256 px 分块 / 16 px 重叠 /
                                             只取中心贴回）跑通；权重 realesr-general-x4v3（4.87 MB）
电子书（ebook.convert）                 →  epub→docx 是真正的 PK magic ZIP；
                                             epub→md 中文文本完整保留；
                                             epub→mobi 且无 Calibre 时干净拒绝、磁盘零残留
AI 图像描述（ai.describe）              →  走假端点：请求形状（1 张图 / 内联 data URL /
                                             image/jpeg / 带系统提示词 / 非流式）与下游接线全对，
                                             跑完已还原用户的 AI 设置
```

**这份基线里仍然为空的**：`image.enhance` / `image.strip-metadata` 未接外部后端（仍是纯 Rust 实现，而且已不再声明引擎依赖）；macOS 没有环境基线（四条下载源的 `sha256` 全是 `null`）；**三档输出的结果一致性没有测试**；~~"两个可选引擎都缺失"这类组合环境没有专门基线~~ **已由 `verify-platform.mjs`【13】补上**（把两个引擎的托管目录都藏起来 → 后端 = 纯 Rust、任务仍然成功、产出无损 VP8L）。
> ✅ **已从这份"为空"名单里划掉一条**：原来这里写着"**「仅 ImageMagick」这一档仍然没有实测记录**（本轮补齐了它的 Windows 下载源，但应用内的安装链路未复验，见 §3 与开放项 8）"。现在应用内安装成功、中间档也实测走通了（见上面的输出与开放项 8），这空白已被 `verify-platform.mjs`【12】固化。
> ⚠️ **仍然不成立的两件事，别顺手一起"修好"**：FFmpeg 在本机**没有**装成（`www.gyan.dev` 不可达）；macOS 四条源**仍然**是 `sha256: null`。

> ⚠️ **关于【8】号检查的诚实说明**：它需要先有模型权重与 Python 运行时，而那些都要下载。**前置条件不满足时它是"跳过"，不是"通过"** —— 脚本会明确打一条 skip（`c.check(true, '前置条件不满足，已显式记为跳过（不是"通过"）')`），不会把"没测"算成"测过了"。

### 已核实：转述中不成立或已失效的说法

为避免有人按过时信息去修不存在的问题，以下三点经核对**与当前代码不符**，请勿作为待办：

1. **「`toolforge-plugins/src/runtimes.rs` 调用了 `crate::paths_for_plugin`，但该函数未定义」——不成立。**
   `paths_for_plugin` 在全仓库（`crates/` 下所有 `*.rs`）**零匹配**；`runtimes.rs` 并未引用它。它实际提供的是 `PluginRunner::resolver_for(&PluginCallRequest)`（`runtimes.rs:279`），基于 `toolforge_core::permission::PathResolver` 的 `with_input` / `with_output` / `with_plugin_data` / `with_workspace` 构造解析器。因此 `toolforge-plugins` **不存在这一个编译阻塞**。

2. **「`crates/toolforge-ai` 仍不存在」——曾成立，现已被并行开发补齐。**
   核对早期该目录只有 `Cargo.toml` + `src/lib.rs`，而 `lib.rs` 声明了 `pub mod provider; pub mod review;` 却没有对应文件（当时对 `provider.rs` / `review.rs` 的 `Test-Path` 均返回 `False`，确实会因模块缺失而无法编译）。**在本轮核对的最后阶段（10:05:27）这两个文件已被写入**，现为 `provider.rs`（416 行）与 `review.rs`（681 行），该问题随之消失。

3. **「`apps/desktop/src-tauri/` 只有 `build.rs` / `Cargo.toml` / `tauri.conf.json`，没有 `src/`」——曾成立，现已被并行开发补齐。**
   核对早期确实没有 `src/`；随后 `state.rs` / `ipc.rs` / `commands.rs` / `lib.rs` / `main.rs` / `bin/export_bindings.rs` 相继出现。**`Cargo.toml` 声明的 `[lib]` 与两个 `[[bin]]` 现在都有对应文件了**，该阻塞也随之中消。前端工程（`apps/desktop/package.json` 及 React/Vite 源码）仍然**不存在**。

> 结论：真正需要立刻处理的稳定问题是**阻塞 1–4**（都在 `toolforge-core` 内），以及下面「已知不一致与行为缺口」中的第 1–5 条。

---

## 已知不一致与行为缺口（新发现）

这些不是「待实现的功能」，而是**代码已经写了、但与它自己的声明/文档/其它模块不一致**的地方。它们比缺功能更危险，因为会让人在运行时才发现。

### 1. 节点登记 32 个，执行器**也是 32 个**（差集已清零）

> ✅ **本条已关闭（保留为历史）**：权威目录 `toolforge_core::pipeline::builtin_nodes()` 登记 **32** 个节点，
> `crates/toolforge-engines/src/nodes.rs` 的 `run()` 分发臂现在**覆盖全部 32 个**，
> `UNIMPLEMENTED_NODES` 是**空数组**。下面原文记录的差集是 4 个（更早是 5 个、6 个），
> 逐个的去向见 `docs/ENGINE-MATRIX.md` 第 6.7 节。

- 权威目录 `toolforge_core::pipeline::builtin_nodes()` 登记 **32** 个节点（已逐条列出核对）。
- `crates/toolforge-engines/src/nodes.rs` 的 `run()` 分发臂实际实现 **28** 个。
- 差集（4 个）会落到 `other => Err(not_implemented(other))`，返回 `ErrorCode::Internal` + 「内置节点 `X` 尚未在 v0.1 中实现」：

  `doc.ocr`、`ebook.convert`、`ai.upscale`、`ai.describe`

  > **本条原来的差集是 5 个，第一个是 `image.remove-background`** —— 它是产品的招牌功能，
  > 却长期停在"登记了但执行器没写"。**现在它已经实现并真机跑通**（下权重 → 独立 venv 装
  > `onnxruntime` → ONNX 推理 → 出 RGBA PNG），详见下方「AI 媒体能力」与
  > `docs/ENGINE-MATRIX.md` 第 3.2、6.7 节。
  >
  > ✅ **剩下这 4 个已在最后这一轮全部补齐**，而且**不是同一个做法**：
  > * `ebook.convert` —— Calibre 优先、Pandoc 兜底，并且**在调用 pandoc 之前**按能力表
  >   （`PANDOC_EBOOK_IN` / `PANDOC_EBOOK_OUT`）检查扩展名。原因是 pandoc 对认不出的
  >   **输出**扩展名**不报错**：它打印一句 `[WARNING] Could not deduce format from file extension`
  >   + `Defaulting to html`，写一个 HTML 出来、**保留原扩展名、退出码 0**。认不出**输入**
  >   格式时更糟（当成纯文本读，产出垃圾）。**"成功"的坏文件比失败更糟，所以退出码在这里不可信。**
  > * `ai.describe` —— 视觉模型；图片先按 `maxSide`（默认 1024）缩小再转 **JPEG q85** 内联发送。
  >   新增示例插件 `plugins/builtin/ai-describe`：描述 → `text.replace` 净化为文件名 → `name.build` → `fs.move`。
  > * `doc.ocr` —— 有 tesseract 就用它（离线免费），否则用视觉模型；**PDF 输入明确拒绝**
  >   （要先按页栅格化，那条链路没做）。
  > * `ai.upscale` —— Real-ESRGAN + 分块推理（`py/upscale.py`：256 px 分块、16 px 重叠、
  >   只取中心贴回），配了两个**动态输入尺寸**的权重。
  > 逐条的实测数据与参数见 `docs/ENGINE-MATRIX.md` 第 3.2、3.3、3.5、6.7 节。

  > **结论（`flow.foreach` 已结案）**：这条当时写的是"6 个"，第 6 个是 `flow.foreach`。
  > 后来它不是被实现，而是被**整个删除**了 —— L1 的步骤列表是平铺的，
  > 「对剩下的步骤循环 N 次」没有可定义的语义（循环体含哪些步骤？循环后面的收尾步骤怎么办？），
  > 而它旧描述里的「宿主会按并发度并行调度」是**假话**。
  > 批量语义早已由命令层承担（见阻塞 9），并且现在**连目录输入也会展开**：
  > `expand_batches` 把文件夹展开成其中的文件（**只一层**、排序、跳过隐藏文件、
  > 上限 5000 个且**超限报错而不是截断**），逐批调用流水线，清单用 `${batch.index}` 取序号。
  > 所以清单里从来不需要这个节点。`pipeline.rs` 在原名单位置留了一段注释记录原因。

- **一个必须记住的教训（本轮新增）**：`ai.upscale` 与 `image.remove-background` 都依赖
  `onnx-models`，而**"这个权重服务于哪个节点"曾经是从引擎推断出来的** —— 推断的结果是错的
  （`u2netp` 这个**分割**模型也声称服务于 `ai.upscale`）。验证脚本据此拿它去超分，把单通道
  mask 当成图片、"算出倍数 1"、缩放到目标尺寸，于是**每一条尺寸断言都通过**，绿色对勾、
  输出垃圾。修法是三件：`EngineModel.used_by` 逐条写明（不再推断）、`upscale.py` 自检
  （输入 `[N,3,H,W]`、输出必须 3 通道、倍数必须是整数且 ≥ 2，否则报错并打印真实输出形状）、
  以及 `verify-platform.mjs` 的反向断言（拿抠图权重跑超分**必须失败且不留文件**）。
  完整复盘见 `docs/ENGINE-MATRIX.md` 第 3.2 节。**它说明的不是"断言写错了"，而是"断言测的东西
  根本不是要验证的东西"。**
- **设计上这是刻意的**（`not_implemented()` 的注释明确说明「不返回假的成功」），而且现在这条
  兜底分支只剩**一种**成因：**节点名拼错了**。它会把两种处境分开说 —— 名字不在节点目录里
  →「多半是清单里写错了名字」；名字在目录里 →「执行器还没实现，见 ROADMAP」。
  以前这两者共用同一条出口，而那里还挂着一条 `debug_assert!`，于是**一个拼错的节点名会
  panic 掉 debug 构建**；那条断言已经删掉（理由与替代测试见 `docs/ARCHITECTURE.md` 决策 10）。
  - 清单式插件引用一个**不存在**的节点仍会被 `validate()` 拦下（`STEP_UNKNOWN_NODE`）；
    而 `flow.foreach` 因为**被删除**（不是"未实现"），引用它的清单同样**连 `validate()` 都过不去** ——
    删除是更彻底的诚实。
- ✅ **防回归测试**：`unimplemented_list_matches_actual_dispatch` **遍历真实分发表**，对
  `UNIMPLEMENTED_NODES` 里的每个节点断言它确实还落在 `not_implemented` 上（反方向也查）。
  名字不同但守同一件事的还有 `unimplemented_list_matches_the_dispatch_table`。
  **名单为空之后这两条测试依然有用** —— 它们是"下次加节点时"的护栏。
- ✅ **示例层面还有一条护栏**：`examples_do_not_silently_use_unimplemented_nodes` —— 示例要么别用
  未实现节点，要么必须在 `metadata.description` 里写明。现在它始终通过，**但不要删**。

### 2. 图像节点的「可选加速」只是声明，执行器从不调用 libvips / ImageMagick ✅ **已部分关闭（4 个节点走通，2 个还没走）**

> ✅ **状态更新（这是本条现在最重要的一段）**：下面原文描述的是**当时的事实** —— `libvips` 与 `imagemagick` 确实一处都没被调用。现在 `nodes.rs` 有了 `pick_image_backend()`：
>
> - `image.convert`、`image.resize`、`image.crop`、`image.rotate` **四个节点会真的按 `libvips → ImageMagick → 纯 Rust` 挑后端**，把结果报在节点输出的 **`backend`**（`"libvips"` / `"imagemagick"` / `"rust"`）与一条 debug 日志里。后端可观测是刻意的：不看日志就只能靠猜，而这个项目已经被"文档说有、实际没有"坑过好几次。
> - `image.rotate` 的任意角度不再是"直接报缺 ImageMagick"：libvips 可用时走 `vips similarity --angle N`，ImageMagick 可用时走 `-rotate N`，**只有纯 Rust 可用时才返回 `EngineMissing`** —— 仍然**不会静默取整**（取整会让用户以为转了 45°，实际拿到没转的图）。
> - **真机验证**：`scripts/devtools/verify-platform.mjs` 的【6】号检查断言"实际后端与引擎状态一致"并且日志里写明了用的是哪个后端，【7】号检查盯着任意角度旋转的诚实报错，【12】号检查把 `engines/libvips` 临时藏起来、断言后端真的切到 ImageMagick。**写下这一条时**整个脚本是 **82 项检查全通过**（【1】–【13】）；当前共 **401 项**（【1】–【34】），见本文档开头的「实测数据」表。
> - **收益要说准**：libvips 档位带来的是**按质量换体积的能力**（WebP/JPEG 有损编码），纯 Rust 后端的 WebP 只能无损。**但"有损一定更小"是错的**，实测 320×200 合成渐变图：无损 508 字节 vs 有损 1808 字节（所以【6】只断言"确实走了有损编码"，不断言体积）。
>
> **本条原来还剩两件事，现在都做完了**：
> 1. `image.enhance` 与 `image.strip-metadata` 仍然只有纯 Rust 实现 —— 这**不是缺陷**（它们本就该是纯 Rust），但它俩的 `optionalEngines` 与两个引擎的 `provides` 里都还声明着"装了引擎能用"，那是假的。**已撤掉声明**，并在描述里写明"只有纯 Rust 实现"。
> 2. `image.crop` 的反向问题：实现里已经在用 libvips 裁剪，但 `libvips.provides` 里没有它。**已补进声明**（顺带补了 `image.rotate`、撤了引擎侧多余的 `image.strip-metadata` / `doc.ocr`）。
>
> 这两件事是同一类漂移（`provides` ↔ 节点声明，共 5 处），所以除了逐处修，还加了一条**双向守卫测试** `provides_matches_node_declarations`，并做了反证确认它真的会红。详见 `docs/ENGINE-MATRIX.md` 第 6.2 节。
>
> ~~另外：**ImageMagick 档位只有代码路径、没有实测记录**（本机没有装 ImageMagick，也没有一个"只有 ImageMagick 可用"的环境基线）。本轮给它补上了 **Windows 下载源**并做了直接执行验证（见 §3），但那只是让它**可装**，不等于"测过这一档"。~~
> ✅ **上面这句已作废（保留作历史）**：本机现在装了 ImageMagick，中间档也实测走通了 —— 藏掉 `engines/libvips` 后 `image.convert` 的后端日志变成 `后端 = ImageMagick（格式最全）` 并产出有损 VP8 WebP。**"只有 ImageMagick 可用"这一档现在有环境基线了**，而且 `verify-platform.mjs`【12】会一直替你重跑它。
>
> 以下原文保留作为历史。

- 节点目录里，`image.convert` / `image.resize` / `image.crop` / `image.strip-metadata` 声明 `optionalEngines: [libvips, imagemagick]`，`image.rotate` 声明 `[imagemagick]`，`image.enhance` 声明 `[libvips]`。
- 但 `nodes.rs` 里**真正被解析并执行的引擎只有四个**：`ctx.engine("ffmpeg")`、`ctx.engine("pandoc")`、`ctx.engine("libreoffice")`、`ctx.engine("7zip")`。
- `libvips` 与 `imagemagick` **没有任何一处被 resolve 或调用**：
  - 它们只出现在错误信息与警告里（例如 WebP 无损编码时提示「安装 libvips 可获得有损压缩」、缺 avif/jxl/heic 支持时提示「请安装 libvips 或 ImageMagick」）；
  - `image.rotate` 的任意角度分支**不是降级到 ImageMagick**，而是直接 `return Err(engine_missing("imagemagick"))`（`nodes.rs:588`）。
- 也就是说（**写这条时的结论**）：「纯 Rust 打底 → libvips 加速 → ImageMagick 兜底」这条链路**当时只有第一档存在**，后两档是声明而非实现。当时的处理意见是"这必须写进验收标准，否则会被误认为已经可用" —— 后来的做法不是写进验收标准，而是**直接把后两档实现出来**（见上面的状态更新）。

### 3. `engine-sources.json` 的下载源哈希 ✅ 已回填 13 条（Windows 7 / Linux 4 / macOS 3）

- 原状：12 条来源的 `sha256` **全部为 `null`**，而 `EngineRegistry::install` 在缺哈希时**直接拒绝下载** —— 也就是说校验机制写好了，但**任何引擎都装不上**。
- **现在共 14 条，其中 13 条是实际核对过的**（不是抄的）；唯一没有哈希的是 `ffmpeg@macos`：

  | 引擎 | 平台 | 版本 | 大小 | 哈希来源 |
  |---|---|---|---|---|
  | `ffmpeg` | windows | n8.1.3（BtbN autobuild-2026-09-26-13-03, win64-gpl） | 184 MB | 下载后自行计算（BtbN **不发布**校验和） |
  | `ffmpeg` | linux | 同一个构建（linux64-gpl） | 150,325,156 B | 下载后自行计算 |
  | `ffmpeg` | macos | 9.0.2（evermeet 版本直链） | 26,198,325 B | **`null`** —— 取不到字节，见下 |
  | `libvips` | windows | 8.18.6 (`build-win64-mxe`, x64-web) | 10.8 MB | 下载后自行计算 |
  | `imagemagick` | windows | 7.1.2-31 portable Q16 x64（`.7z`） | 11.7 MB | 下载后自行计算（**上游没有发布校验和**，release 里只有 SBOM 与 in-toto 证明，都不含产物摘要 —— 换版本必须重算） |
  | `pandoc` | windows | 3.11 | 39.8 MB | 下载后自行计算 |
  | `pandoc` | linux | 3.11 | 33.3 MB | 下载后自行计算 |
  | `python` | windows | 3.11.16 (python-build-standalone) | 46.0 MB | 下载后自行计算 |
  | `python` | linux | 3.11.16 (同上) | 46.6 MB | 下载后自行计算 |
  | `python` | macos | 3.11.16 (同上, arm64) | 27,088,178 B | 下载后自行计算 + `tar -tzf` 核对清单（2036 项，确有 `python/bin/python3`） |
  | `poppler` | windows | 26.09.0-0 | 41.7 MB | 下载后自行计算 |
  | `7zip` | windows | 26.03（`.msi` + 管理安装） | 2,007,040 B | 下载后自行计算 |
  | `7zip` | linux | 26.03（`7zz`） | 1,575,072 B | 下载后自行计算 |
  | `7zip` | macos | 26.03（`7zz`） | 1,863,192 B | 下载后自行计算 |

- **`7zip` 三平台是本轮新增的，它推翻了一条长期存在的错误结论。** 历史注记写着"7zip 只能系统安装，因为官方只提供安装器、或需要先有 7-Zip 才能解压的 `.7z`（先有鸡还是先有蛋）"。**这个理由是可以被证伪的**：Windows 10 1803+ 自带的 `tar`（bsdtar）能读 7z —— 这一点在装 ImageMagick 时就已经被实测证明过（它的 Windows 便携包只有 `.7z`）。真正的原因只是那条 URL（`7z2408-extra.7z`）过期了，而上游早就发到 26.03。**一个错误的理由会让一个正确的结论永远不被复查**，所以这条留在文档里。
  - 换到 `-extra` 也不行（第二个坑）：里面是精简版 `7za.exe`，**没有 RAR**，而 `archive.unpack` 的输入端口收 `.rar`。
  - 最终：Windows 用 `.msi` 的**管理安装**（`archive: "msi"` → `msiexec /a <msi> /qn TARGETDIR=<dir>`，不写注册表、不装服务、不需要管理员权限，本机实测退出码 0），拿到**完整版** `Files/7-Zip/7z.exe` + `7z.dll`（`7z.exe i` 里 Rar1/2/3/5 都在，`7z a` 实测可用）；Linux / macOS 直接走上游的完整 `7z2603-linux-x64.tar.xz` / `7z2603-mac.tar.xz`（解压出来是 `7zz`，**不叫 `7z`**）。
  - **端到端实测过两次**（应用内点击安装）：下载 → SHA-256 校验通过 → 解压 → 探测为 `installed`，路径 `…\engines\7zip\Files\7-Zip\7z.exe`，版本 `7-Zip 26.03 (x64)`。**第一次跑就抓到一个真缺陷**：探测把可执行文件认成了 **`7z.dll`**（引擎显示"已安装"、路径是个 DLL）—— 见下面的 3.1。
  - **下载速度的一条环境记录**：本机开着加速器（steam++ / Watt Toolkit）时，`github.com` 被 hosts 指到 `127.0.0.1`（它在本地跑了一个 MITM 代理），应用侧的下载速度在 **0.02 ~ 2.4 MB/s** 之间波动、并且**失败过一次**（`client error (Connect) → operation timed out`，60 秒连接超时 ×2 次尝试）。同一个 URL 用 `Invoke-WebRequest` 只要 1 秒。**这是环境差异，不是代码缺陷**（应用用的是 reqwest + 系统证书；`curl` 因为自带 CA bundle 在这条链路上直接 TLS 失败）—— 但它意味着"下载失败"在本机是**正常会发生**的事，所以重试路径必须好使：失败信息里写清了三种常见原因与手动兜底，用户点第二次即可。

### 3.1 探测把 `7z.dll` 当成了 7-Zip 本体（本轮发现并修复）

- **症状**：引擎管理里 7-Zip 显示**已安装**，但路径是 `…\Files\7-Zip\7z.dll`，版本"未知"。也就是说 `archive.pack` / `archive.unpack` 拿到的"7-Zip"是一个 DLL —— 用起来必然失败，而**探测说它可用**。这类"探测通过、执行报别的错"的缺陷最难查。
- **根因**：`managed_binary()` 的**递归回退**分支比较的是**文件主干名**（`file_stem`）。`7z.dll` 与 `7z.exe` 的主干都是 `7z`，而 `read_dir` 的顺序把 `7z.dll` 排在了前面。`MANAGED_LAYOUT` 那条路径用的是 `with_exe_suffix`（只认真文件 / 补 `.exe`），所以问题只出在回退分支 —— 而回退恰恰是"平台布局与 `MANAGED_LAYOUT` 不一致"时唯一的救生索（MSI 布局就在 `Files/7-Zip/` 下）。
- **修法**：新增 `is_named_executable()`，要求**完整文件名**匹配（Windows 上裸名或 `名.exe`），非 Windows 平台还要求**可执行位**；主干名比较彻底删掉。
- **回归测试**：`managed_binary_never_returns_a_dll`（只有 `7z.dll` / `7zFM.exe` 时必须找不到；补上真正的可执行文件后必须找到那一个）。**做过反证**：把主干名比较加回去，这条测试立刻红。
- **顺带修掉的第二件事**：`probe_version_of()` 原来在"参数为空"时直接返回 `None`，于是 `7zip` 的版本**永远是"未知"**。而 7-Zip 的默认动作就是打印版本横幅并退出 0（`7-Zip 26.03 (x64) : …`）—— 空参数是**有含义**的取值，不是"没配"。这里刻意**不用** `7z i`：它会打印整张格式表，而 `probe_version` 只留尾部，版本横幅反而会被挤掉。
- **运行时固化**：`verify-platform.mjs` 新增 **【18】**（11 项），见下。
- **`ffmpeg@linux` 从滚动别名换成版本固定直链**：原来指向 `johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz`（永远等于"最新版"），所以哈希只能是 `null`，而 `null` 意味着安装被 `HashRequired` 拦住 —— Linux 用户实际只能走包管理器。现在与 Windows 用同一个 BtbN 构建，哈希已实测。
- **`ffmpeg@macos` 仍是 `null`，这是唯一剩下的一条**：evermeet 的 `ffmpeg-9.0.2.zip` 从这台机器取不到字节（HEAD / GET 都试过；它的 `info` 接口是通的，所以不是站点整体不可达）。**拿不到字节就不填哈希** —— 抄一个哈希比不填更糟。安装时返回 `HashRequired`，用户可以显式勾选"允许安装没有校验值的来源"（对话框里本来就有这一项，带风险说明），或者 `brew install ffmpeg`。
- **两条"占位条目"被删掉，解释挪进了文档**：`libvips@macos`（指向 `libvips/libvips` 的 release —— 上游**只发源码包**，实测 404，是**一条编出来的 URL**）与 `pandoc@macos`（`.pkg` 真的存在，但要用 `installer` 以 root 安装，不是可分发的归档；留着它的后果是 macOS 用户下完 39.8 MB 得到一句"没装上"）。**说明属于文档，不属于数据表** —— 而这条纪律现在由 `download_platforms_are_backed_by_real_sources`（双向核对 + 拒绝孤儿条目）和 `archive_kinds_are_known_and_msi_stays_on_windows` 守着。
- **`imagemagick@windows`**（此前声明了 `Download` 却没有来源，界面于是显示一个点下去必然失败的「一键下载」按钮 —— 那条提示语也一并修了）。三件事是**直接执行**验证的，不是推断：官方 Windows 便携包**只有 `.7z`**；**Windows 自带的 `tar`（bsdtar / libarchive）能读 7z**（`tar -xf` 退出码 0、`magick.exe -version` 打印 `ImageMagick 7.1.2-31 Q16 x64`），所以装它**不需要先装 7-Zip**；包内**没有顶层目录**（23 个条目直接在根），所以 `stripComponents` 是 **0** 而不是习惯上的 1。Linux / macOS **故意不写来源**（走 `apt` / `brew`）。
  > ✅ **这条 ⚠️ 已解除（保留作历史）**：原文是"应用内的完整安装链路尚未复验"——`toolforge.exe` 被一个无关的第三方进程持有文件句柄，cargo 写不回链接产物（`link.exe` 1104），二进制重建不了、跑不了。句柄释放后重建并**真的装了一遍**：11.7 MB 下载 → SHA-256 校验通过 → 系统 `tar` 解开 `.7z` → `magick.exe` 落在 `…/engines/imagemagick/magick.exe`，**241.5 MB**，探测版本 `ImageMagick 7.1.2-31 Q16 x64`。上面那四点从"直接执行验证过的前提"升级为"整条链路端到端跑通"。顺带还拿到中间档的环境基线（见开放项 8）。
- ✅ **已解除的环境事实（保留作历史）**：这一段原来写着「本机连不上 `www.gyan.dev`，所以 FFmpeg 的安装在本机没有完成过，依赖它的 `video.*` / `audio.*` 节点在那台机器上不可用」。两件事都变了：① gyan.dev 那条来源被换成 BtbN 的 GitHub 地址（gyan.dev 实测只有 15~43 KB/s，**105 MB 根本下不完**，而客户端当时的总超时是 30 分钟），哈希因此从"上游旁挂文件"变成"自己下载后计算"；② **FFmpeg 已经在本机装成功**（n8.1.3，484 MB，`force` 安装），`video.*` / `audio.*` 节点已有真机基线。

- **同时把所有可用 URL 改成版本固定直链**。原来 `ffmpeg` 用的是 `ffmpeg-release-essentials.zip`（滚动指向最新版）—— 那类 URL 上的哈希**必然失效**，表现为"昨天能装、今天全部失败"。`libvips` 的源仓库也从 `libvips/libvips` 改为 `libvips/build-win64-mxe`（前者的 release 里没有 Windows 资产，实测 404）。
- **剩余未回填：只剩 1 条**（`ffmpeg@macos`，见上）。原先列在这里的 `libvips@macos` / `pandoc@macos` 两条**不是"没核对"，而是根本不该存在**（一条是编出来的 404 地址、一条是装不上的 `.pkg`），已连同占位条目一起删除；`python@macos` 与 `ffmpeg@linux` 已实测回填。
- 新增两条纪律测试：`every_declared_hash_is_a_wellformed_sha256`（长度/大小写/字符集）、`no_source_points_at_a_rolling_latest_alias`（禁止滚动别名配哈希）；本轮再加两条平台无关的守卫：`download_platforms_are_backed_by_real_sources`（声明与来源双向核对、拒绝孤儿条目）、`archive_kinds_are_known_and_msi_stays_on_windows`（`archive` 取值白名单 + URL 后缀一致 + `msi` 只在 Windows），以及针对上面那个真缺陷的 `managed_binary_never_returns_a_dll`。
- **新增运行时验收【18】（11 项，`verify-platform.mjs`，总数 161 → 172）**：压缩包节点是否真的产出标准归档。它做的不是"再跑一次打包"，而是**独立实现交叉验证 + 反证**：
  1. 解析出来的引擎路径必须是一个**真的可执行文件**（直接盯住上面那个 `7z.dll` 缺陷）；
  2. `archive.pack` 打出来的必须是标准 zip（`PK\x03\x04`），并且**系统 tar**（libarchive）能解开它、解出来的字节与输入**逐字节相同** —— 自己打的包自己解，两边同时错还能对上；
  3. 再用 `archive.unpack` 解一遍做闭环，同样逐字节比对；
  4. **反证**：把一段普通文本当压缩包喂进去，必须**失败并给出可读原因**（实测 `7zip 执行失败（退出码 2）`），而不是"成功"地产出一个空目录。
- 另一条实测教训：回填后有个单元测试**开始真的下载 104 MB 的 FFmpeg**（它原本假设"所有哈希都是 null"所以 `install` 会立刻返回 `HashRequired`）。现已改为用临时来源文件构造缺哈希场景，与真实数据解耦 —— **测试不该有联网副作用**。
  > ⚠️ **同一个坑又踩了一次（本轮）**：那条"没有下载源的引擎必须返回 `NotConfigured`"的测试**硬编了 `libreoffice`**，而 LibreOffice 这一轮有了 Windows 下载源 —— 于是测试**真的下了一个 356 MB 的安装包**（0.3 秒 → 120 秒，还在临时目录里装了一份）。现在改成**从目录推导**"哪些引擎没有下载源"（`download_platforms.is_empty()`），将来谁加了来源，测试自动跟着走，不会再变成一次静默的大文件下载。

### 3.2 LibreOffice：最后一个没有真机基线的核心节点（本轮打通）

- **原状**：`doc.to-pdf` 这个节点从写出来那天起**一次都没有被执行过**。它依赖 `libreoffice`（约 420 MB、`install_modes: [System]`、本机从未安装），而且**没有任何内置插件用它** —— 对普通用户来说它根本不可达。单元测试、`cargo check`、界面的可用性判定都不会碰到它。这是三个"必需引擎"里最后一个没有基线的（FFmpeg 见阻塞 18，7-Zip 见上一轮）。
- **打通方式**：Windows 上官方只发安装器，但 `.msi` 可以用 **`msiexec /a` 管理安装**解开（不写注册表、不装服务、不需要管理员），于是 `.msi` 成了"其实能解包"的归档 —— 与 7-Zip 走的是同一条路（`archive: "msi"`）。
- **下载源用镜像，理由是实测的**：TDF 自己的主机（`download.documentfoundation.org`）从本机**连不上**（那个 356 MB 的文件请求 21 秒后 `Unable to connect`），而该目录里就放着 `…msi.mirrorlist` —— **TDF 的分发本来就是镜像制**。清华 TUNA 实测 **10.6 MB/s（33 秒下完 373,252,096 字节）**，中科大 USTC 报的是完全相同的 Content-Length，两条互为兜底（`fallbackUrl` 本轮新增到**引擎**来源表，此前只有模型有）。
- **真机实测（应用内一键安装）**：`engines_install` → 下载 356 MB（**10.6 MB/s**）→ SHA-256 校验通过 → 管理安装 → 探测为 `installed`，路径 `…\engines\libreoffice\program/soffice.com`，版本 `LibreOffice 26.2.6.3 8221e31b…`，**全程 76.7 秒**。
- **顺带抓到并修掉的四件事**：
  1. **`soffice.exe` 跑 `--version` 会挂住**（GUI 子系统启动器，本机实测 >20 秒两次、>300 秒一次），而探测要跑 `--version` —— 结果是引擎管理页每次卡满 10 秒超时、版本永远「未知」。修法：新增 `MANAGED_LAYOUT_PLATFORM_OVERRIDES`（Windows 上指向 `program/soffice.com`，同一份程序的控制台入口），并把它排在 `ENGINE_BINARIES` 的第一位。回归测试 `libreoffice_prefers_the_console_entrypoint_on_windows` **做过反证**（去掉覆盖表，测试立刻红）。
  2. ★ **`-env:UserInstallation` 拼的不是合法 URL —— LibreOffice 因此直接挂住**。原代码是 `format!("file:///{}", profile.display())`，在 Windows 上 `display()` 给的是**反斜杠**路径，于是拼出 `file:///C:\Users\…\toolforge-lo-1234`。这不是"参数不对会报错"，而是**沉默的挂起**：本机对照实测，同一个转换命令正斜杠 3 秒出 PDF、反斜杠 60 秒无任何输出且进程不走。因为节点给子进程设了 600 秒超时，用户看到的是"转了十分钟然后超时"，排查完全指不到参数格式上。修法：新增 `file_url()`（反斜杠→正斜杠 + 最小必要的百分号编码），并有纯字符串回归测试 `libreoffice_profile_url_has_no_backslashes`。**这个缺陷是被【19】抓出来的** —— 手工在 PowerShell 里试的时候我恰好用了正斜杠，所以它一直没暴露。
  3. **`doc.to-pdf` 的 `format` 参数是装饰品**：执行器写死 `--convert-to pdf`，从来没读过它。而且它危险 —— 真按 html 输出的话，宿主仍按输出端口的扩展名给文件命名，用户会拿到一个**叫 `.pdf` 的 HTML**（正是 `ebook.convert` 上已经打过一次的坑）。参数已删掉，节点就是"转 PDF"。
  4. **`doc-to-pdf` 内置插件**（`plugins/builtin/doc-to-pdf/`）：补上面向用户的入口，内置插件 7 → **8** 个。这也是让它**能被真机验证**的前提。
- **新增运行时验收【19】（6 项，`verify-platform.mjs`，总数 172 → 178）**：`doc.to-pdf` 是否真的转出**内容正确**的 PDF。要点：
  1. 输入用 `cdp.mjs::makeDocx` —— **纯 Node 手写的最小合法 OOXML**（ZIP + CRC32 + 三个必需条目）。理由：另一条路（用 pandoc 现造）会让"验证 LibreOffice"依赖另一个引擎，没有 pandoc 的机器上整节会被跳过；
  2. 产出必须是 `%PDF-` 且体积合理；
  3. ★ 用 **Poppler 的 `pdftotext`** 把文字读回来**逐词**断言 —— "文件非空"证明不了内容对，这一步才是；而且它是**跨引擎**的：PDF 由 LibreOffice 写、由另一个项目读。（断言逐词而不是整句：LibreOffice 输出的文字流顺序会变，实测读回来是「转 PDF 验证标记 第二段中文正文 with ASCII text. ToolForge」—— 整句匹配会因为**排版顺序**判红，那是把断言绑死在排版实现上。）
  4. 版本探测有结果且没挂住（盯着 `soffice.com` / `soffice.exe` 那个选择）；
  5. **反证被实测推翻了，于是改成了另一条**：原本想断言"假 docx 必须失败"，但 LibreOffice 是**按内容嗅探**的，宽容得超出预期 —— 普通文本改名 `.docx` 正常转换、**4 KB 随机二进制**也"成功"（产出 781 KB PDF）、**0 字节空文件**同样"成功"（6.5 KB）。所以"拒绝坏输入"不该由这个节点承担（扩展名把关在 `accept` 列表那一层），检查改成盯**我们自己的不变量**：绝不产出 0 字节的 PDF 冒充成功。

### 3.3 "一句话生成插件"这条闭环第一次被走完（本轮），顺带补上一条校验

- **原状**：`ai_generate` / `ai_review_draft` 有实现、有单元测试，但**从来没有人从"一句话"走到"装上一个能跑的插件"**。原因和 `doc.to-pdf` 是同一类：它需要一个**会按约定吐 YAML 的模型**，而真模型不可复现（同一个需求两次生成的插件不一样，还会偶发不合规）。于是产品最核心的那句话（README 第一段："你描述一下，它自己长出来"）**没有任何真机证据**。
- **做法**：让 `mock-openai.mjs` 兼任"插件生成器" —— 请求里带 `[mock:draft]` / `[mock:broken]` / `[mock:malicious]` 分别回一份合规草稿 / 引用未声明端口的草稿 / 越权草稿。真模型"答得好不好"仍然不在验证范围内（与【10】的边界一致），但**我们这一侧**从此有证据。
- **实测（【20】，18 项）**：草稿被解析成 `plugin.yaml` → 静态审核 `recommended: true, risk: low` → **按前端真正走的那条路装上去**（`PluginSource::Bundle`：`plugin.yaml` 走 `yaml` 字段、其余文件进 `files`，由**后端**落盘 —— 这条路径此前只有单元测试，没有任何运行时证据，也就是说"用户在界面上点安装"这个动作**从来没被执行过一次**）→ 授权 → 启用 → 用一张真 PNG 跑一次 → 产出是**真的 WebP**（`RIFF/WEBP` 魔数），而且 **AI 写进 YAML 的参数真的生效**：`width: "400"` → 实测 **400×300**（这条断言很关键：它证明 AI 写的参数走进了节点参数解析，而不是"插件跑通了但参数被忽略"）。
- **反证（三份坏输入都必须被拦）**：
  * **越权草稿**（`fsWrite` 用 `explicit` 作用域写系统 hosts + `exec`）：`recommended: false`、`riskLevel: critical`、点名 `HOST_PATH_WRITE` / `CRITICAL_CAPABILITY` / `HIGH_RISK_CAPABILITY`，并且**落审计**（`aiDraftRejected`）。注意前提：这份草稿是**语法完全合法的清单** —— 被拦的原因必须是"申请了高危能力"，而不是"YAML 写错了"。攻击者会写合法的 YAML。
  * **引用未声明端口的草稿**：见下，它是本轮**新加的一条校验**逼出来的。
  * **带 `../` 的 bundle**：`plugins_install` 必须拒绝，且**逃逸目标路径上什么都不该留下**、被拒的 bundle 也不该留下半个插件（单元测试里有 `bundle_path_traversal_is_rejected`，但"用户点安装会不会写坏东西"取决于的是命令层这条链路）。
- ★ **新校验：`TEMPLATE_UNKNOWN_OUTPUT_PORT`（以及 input / params 的同款）**。第一版"合规草稿"的中间步骤写了 `${output.resized}`，却没声明 `resized` 端口 —— 草稿**通过了审核、装得上**，直到真跑才报 `PLUGIN_INVALID: 模板变量 ${output.resized} 无法解析`。
  这条错误**完全可以在审核阶段看出来**：模板上下文里的 `output.*` 只包含**声明过的**端口（`toolforge-plugins/src/l1.rs` 就是这么填的）。而已有的 `validate_into` 只检查了 `${steps.*}`（存在性 + 前向引用），`${output.*}` / `${input.*}` / `${params.*}` **从来没被对过账**。
  现在 `PipelineDef::validate_template_refs()` 把这三类都对账，根名不认识（`${foo.bar}`）也报错。报成 `error` 而不是 `warning`：这类引用没有任何"也能跑"的情形，AI 生成流程正是靠 `validation.ok` 决定放不放行。
  守卫共 6 条测试，其中两条最重要：`manifest_validate_wires_in_the_template_port_check`（证明这条检查**真的被接进了 `validate()`** —— 一个没人调用的检查函数等于没有检查）与 `bundled_plugin_manifests_pass_the_new_template_check`（遍历仓库里**真实的 8 个内置插件清单**，确认没有误报 —— 误报会让合法插件装不上）。

### 3.4 任务取消第一次被验证（本轮），顺带修掉一个**返回值说谎**的 API

- **为什么值得单独验**：`jobs_cancel` 是**安全相关**的 —— 用户点"取消"，期待的是"它现在停下"，而不是"界面说取消了、后台还在写文件"。而 `docs/ROADMAP.md` 的开放项里一直挂着一条"取消路径可验证：取消令牌触发后子进程树被杀死，无孤儿"，**从来没有被验证过**。
- **【21】（21 项）做的事**：用**真实工作负载**（内置 `doc-to-pdf` 处理一份两万段的 docx，实测四千段约 8 秒，两万段留出足够长的取消窗口）：
  * `jobs_cancel` → 任务在 **0.5 秒内**收敛到 `cancelled`；被取消的任务**不报告任何产出**（不能把半截 PDF 当成结果）；
  * ★ **没有孤儿进程**：选 LibreOffice 就是因为它会派生 `soffice.bin`（最容易漏杀的那个）。实测取消前 0 个、取消后 0 个。**另外单独探了 4 次**（取消延迟 200/500/1500/3000 ms）也全部干净 —— 也就是说"Windows 上没有进程组、只杀直接子进程"这个理论缺口，在**当前这几个引擎上并没有变成实际问题**（LibreOffice 的 `.com` 包装器会带着 `.bin` 一起退）。这条要如实写成"验证过了、没发现泄漏"，而不是"我们修好了"。
  * 队列记账：`jobs_list` / `jobs_get` 两处口径一致；`jobs_stats` 计入取消；`jobs_clear_finished` 只清已结束的。
- ★ **`jobs_retry` 的返回值之前是错的（本轮修复）**。重放走的是正常提交流程（`submit_plugin_run` → `queue.create()`），会创建一个**新任务**（新 id）；而 `retry()` 返回的是**原任务的 id**。
  **这个坑是写验证脚本时踩到的，而且它让结论完全反掉**：重试之后我按旧 id 轮询，永远读到上一次的终态 `cancelled`，于是对已经结束的旧任务又调了一次取消（无效），而新任务其实在跑 —— 结果把新任务正在用的 `soffice.bin` **误判成"取消留下的孤儿进程"**。
  修法：重放闭包改成 `Fn() -> Option<JobId>`（拿到新任务 id 就返回它），`queue.retry()` 返回新 id，`jobs_retry` 也返回新 id；前端 `useRetryJob` 两个 id 的缓存都失效。**一条返回说谎的 API 能让上游的结论完全反掉** —— 这比"少一个功能"危险得多。
- **顺带补齐了此前从未被调用过的命令**：`jobs_list` / `jobs_stats` / `jobs_retry` / `jobs_clear_finished` / `models_remove` / `app_info` / `app_paths` / `system_status`（32 个 IPC 命令里最后 10 个没覆盖的，现在只剩 0 个）。`models_remove` 用**备份还原**做（全程零网络，且这一节不留副作用）。

### 3.5 流程编辑器的导出以前**必然跑不起来**（本轮真跑一遍发现，已修）

- **背景**：流程编辑器（画布）→ `plugin.yaml` → `plugins_validate` → `plugins_install` 这条路，产物完全由前端一个**纯函数** `buildPluginYaml()` 决定，后端只负责校验与执行。也就是说这条链路上有一道**典型的集成缝**：前端写的 YAML ←→ 后端的清单校验器/执行器。两边各自的单元测试都过，缝里却对不上。
- **它此前从没被真跑过**。`verify-platform.mjs`【22】第一次把前端产物交给后端跑，**一口气暴露出四处问题**（前三处让"任何多节点的画布导出"必然失败）：

  1. **多步文件接力写成了 `${steps.<上游>.<端口>}`** —— 而 `docs/PLUGIN-SDK.md` §3.4 结尾明写着"要用 `${output.frame}` / `${output.dst}` 传路径，**而不是指望 `${steps.frame.dst}`**"。原因是后端的文件类产出只进 `NodeOutput.outputs`（任务产出列表），**不进 `values`**，而 `${steps.<id>.<key>}` 只能引用后者 —— 所以那个写法**必然**报 `模板变量 ${steps.resize.dst} 无法解析`。**画布导出这一侧没有照着文档写。**
  2. **中间步骤的输出端口没有路径绑定**：原来的逻辑是"只给没被连线消费的输出绑 `${output.*}`"，听起来合理，但节点执行器是从 `with` 里取输出路径的（`nodes.rs` 的 `arg(args, "dst")?`），没绑定就报 `节点缺少必需参数 dst`。单节点画布恰好没事（唯一的端口没被消费）。
  3. **输出端口 id 会撞车**：原来直接拿节点端口 id 当插件输出端口 id，而"两个节点都叫 `dst`"是常态（所有图像节点都如此）—— 两个步骤会写到**同一个文件**上，后者静默覆盖前者。现在按出现顺序去重（`<节点id>_<端口id>`）。
  4. **末端端口必须优先拿到 `dst` 这个名字**（这条是修完前三条之后才浮现的）：`build_io` 只对端口 id 恰好是 `dst` 的输出套用 `params.format`，而"转换类"节点（vips/magick 后端）是**按输出扩展名**选编码器的。先到先得的话中间步骤会占掉 `dst`，用户在画布上选的 WebP 会被**静默降级成 PNG**（产出文件扩展名与内容都是 PNG）。现在分配顺序是"末端端口优先"。
- **【22】的 13 项断言里，几条关键的**：画布导出的 YAML 必须通过**后端**的校验（集成缝）；**每个步骤都要有自己的输出路径**；跑起来产出的必须是**真的 WebP**（`RIFF/WEBP` 魔数）且**画布上设的宽 400 真的生效**（实测 400×300）；成环画布与空画布在前端就被拦下。
- ⚠️ **一处"差一点误报成产品缺陷"的地方**：第一版测试传了空 `params`，于是产出是 PNG，看起来像"画布选的格式没生效"。实际上**前端本来就发送所有声明的默认值**（`plugin-runner.tsx` 用 `initialParamValues(manifest.io.params)` 填好整个 map），而后端的 `build_io` 用的是**运行期参数**而不是清单里的 `default`。测试改成照前端的做法填默认值之后，WebP 就正确产出了 —— **是测试的假设错了，不是产品错了**。这条顺带把"声明的默认值能到达运行期"一起验了。

### 3.6 `PLUGIN-SDK.md` 的节点表与真实目录对不上（本轮机械对账 + 修掉）

- **为什么值得一条检查**：`docs/PLUGIN-SDK.md` 是**插件作者的契约**，而"契约与实现漂移"这个项目里已经造成过真实损失 —— 【22】发现的画布缺陷正是"代码没照文档写"。反过来"文档没跟上代码"同样会发生，而且更难发现：界面照常工作，只有照着文档写插件的人会踩坑。
- **做法（【23】）**：把文档里的节点表**按表头**解析（四张小节的列语义不一样：§3.1 那列是"从 `with` 读的参数"，其余是"参数 id（从 `io.params` 读）"），再逐行与 `pipeline_nodes` 对账：必需引擎、可选引擎、参数 id 集合，以及"目录里有但文档里没有"的节点。
  > ⚠️ **第一版按固定列下标取，把 §3.1 的行全判错了**（那一列装的是 `with` 键，不是参数 id），于是报出一堆假问题。改成按表头定位之后才对。
- **第一次跑就对出四处漂移**（都已修）：
  1. `doc.to-pdf` 的参数列还写着 **`format`** —— 那个装饰性参数本轮已经删掉；
  2. `doc.ocr` 的**可选引擎漏了 `poppler`**、参数漏了 **`pdfDpi` / `pdfMaxPages`**，而且正文还写着"**PDF 输入会被明确拒绝**" —— 那句话在【15】把栅格化做出来之后就已经过期了；
  3. **`text.replace` 与 `name.build` 两个节点在文档里根本没有** —— 而 `batch-rename` / `ai-describe` 都靠它们工作，"按规则改名"这条最常用的路径因此没有文档；
  4. `video.trim` 那一格把说明塞进了参数列表（`` `duration`(从 `with`) ``），现在改成规规矩矩的参数列表。
- **反证**：临时把 `format` 加回 `doc.to-pdf` 那一格，【23】立刻判红并**点名到行号**（`L544 doc.to-pdf：文档多出参数：format`）—— 证明这条检查真的在看文档，而不是永远通过。

### 3.7 设置与密钥：落盘生命周期第一次被逐条验证；脱敏从"猜前缀"改成"按字面量抹掉"

- **原状**：文档（`docs/SECURITY.md` §1.5）把 `ai-key.txt` 的纪律写得很清楚 —— 默认不落盘、勾选后才写、关掉开关/清除 Key 时**必须真的删掉**。但这些都是**可观察的事实却没有被任何检查看过**：没有任何脚本碰过 `persistApiKey` / `ai-key.txt`。
- **【24】（15 项）逐条验**：勾上「记住 API Key」→ `ai-key.txt` 真的写盘且内容一致；`settings.json` 里**没有**密钥（连 `apiKey` 这个键都没有）；`settings_get` 不回传明文、只回报 `hasKey`；关掉开关 → **磁盘上那份被删掉**（而内存里仍可用）；清除 Key → 内存与磁盘都干净。
- ★ **脱敏：`redact()` 只认 `sk-` 前缀，那是不够的**。Google 是 `AIza…`、Azure 是一串无前缀十六进制、自建网关常常是任意字符串 —— 全都不命中。而**最现实的泄漏渠道不是"我们把 Key 拼进了错误信息"**（那种低级错误没有），是**对方把请求回显回来**：代理 / 网关 / 调试模式的后端会把 `Authorization` 头带进响应体，而那段响应体正是应用截下来放进错误 `detail`、给用户看的东西。
  - 新增 `redact_with(text, secret)`：**只要知道密钥是什么就按字面量抹掉**，与它长得像不像 Key 无关（短于 8 字符的不替换，免得抹掉正文里的普通词）；启发式保留，作为第二道拦网。四个错误路径（连接失败 / 非 2xx 响应体 / 列模型失败）全部改用它。
  - **假端点里加了一条"话多的网关"路由**：把**真实请求头**原样回显在 500 响应体里。断言分三步 —— ⑥b 回显正文**确实进了**给用户看的错误文本（否则"里面没有密钥"可能只是因为整段响应体被丢掉了，那种通过是假的）、⑦ 文本里看不到密钥、⑦b 但留下了可见的 `[REDACTED]` 标记。
  - 单元测试里**显式记下旧行为会漏**：`assert!(redact(&echoed).contains(secret))` —— 也就是说这条运行时检查不是空过的。
- **重启行为单独验过**（不在套件里，因为要重启应用）：勾上开关写入 Key → 重启后 `hasKey=true` 且文件内容一致（"记住"这个名字对得上）；开关关掉但磁盘上有残留 → 重启时应用**主动删掉残留**并且 `hasKey=false`。



### 3.8 许可证确认：闸门原来有，**记录原来没有**（本轮补上），顺带修掉一处"替用户点头"

- **原状**（就是下面 §4 里那条"仍然没做的那一半"）：引擎与模型的许可证确认只是一次**布尔参数**。门是有效的（`engines_install` / `models_install` 里不满足就拒绝），但确认**不留任何痕迹**：对合规审查拿不出证据链（谁在什么时候接受了哪份许可证），用户每次重装还得再勾一次。
- **补上记录**：新增 `license-acks.json`（`apps/desktop/src-tauri/src/license_acks.rs`），每条记 `{ subject, license, fingerprint, acceptedAt }`，同时写一条 `LicenseAccepted` 审计事件。
  * **记的是"许可证原文的指纹"（sha256 前 16 位），不是"确认过这个 id"**：用户同意的是**那一段文字**。只按 id 记的话，上游把许可证从 LGPL 收紧成 GPL 之后，旧同意会**自动延续**到一份用户从没见过的条款上 —— 那正好是确认流程要防的事。条款一变，指纹对不上，确认自动失效（有专门的单元测试）。
  * **落盘失败只记日志、不打断安装**：用户已经明确点了"我接受"，因为写不了一个辅助文件而让安装失败是本末倒置；但日志里必须留痕，否则"合规证据链"就成了空话。
  * **每次调用重新读盘，不缓存**：缓存会带来一个很难查的形态 —— 用户手工删掉/改过文件之后，应用里的状态与磁盘不一致。删掉文件立刻变回"未确认"这条行为有运行时断言（【25】⑥）。
  * 界面侧：引擎安装对话框**预先勾上**并显示确认时间（只是省一次重复点击，**不是跳过确认** —— 请求里仍必须带 `licenseAccepted: true`，硬门不因为这条记录而放松）。
- ★ **顺带发现并修掉一处"替用户点头"**：`model-panel.tsx` 原来对**不可商用**的权重写的是 `licenseAccepted: !m.commercialUse` —— 也就是**自动发 `true`**，于是后端那道门永远走不到，用户从头到尾没看见任何确认。而旁边的注释写的正是"不可商用的权重需要用户显式点头"。**注释与代码相反**，构建不会红、运行不报错，只是那份确认从来没发生过。现在：不可商用且未安装 → 必须勾选才能点「下载」；确认过就预先勾上。
- **【25】（15 项）验的是后端契约**：不带 `licenseAccepted` → `PERMISSION_DENIED` **且不留下任何记录**（被拒绝的尝试不能进证据链）；带了 → 记录落盘（含指纹/原文/时间）+ `LicenseAccepted` 审计；`engines_catalog` / `models_list` 如实报出 `licenseAcknowledged` 与时间；删掉记录文件立刻变回未确认。
  > ⚠️ **这条边界要写清楚**：前端那两个勾选框本身**没有做点击穿透验证** —— 本机所有需要确认的引擎与权重都已安装，界面上不会出现"安装/下载"按钮，点不出一条真实路径。它目前由 `tsc` + `vite` + 人工审阅覆盖；要补上得有一台装有"未安装的不可商用权重"的机器。
  > ✅ **已补上（见 §3.12）**：不用换机器 —— 把不可商用权重的文件临时挪走就能造出那个状态，引擎对话框则用页面内注入的目录数据驱动。留在这里是为了保留"当时确实没验过"这个事实。

### 3.9 能力清单（capability）第一次被运行时对账；坏配置的恢复路径也验了

- **为什么值得**：`capabilities/default.json` 是**前端的权限边界** —— 它决定一个被注入的脚本（或将来某个插件自带的 UI）能直接对系统做什么。而这条边界**从来只有文档在描述它**，文档还写错过一次：README 里写着「capability 里 `shell:allow-execute` 只放行一个用于"打开文件夹"的 `explorer`」，实际上**一条 shell 权限都没有**（真实边界比文档更紧，但文档仍然是错的）。
- **【26】（7 项）的做法**：从**页面上下文**里真的去调那些命令，按错误文本分类 ——
  `not allowed. Permissions associated with this command` = ACL 拒绝、`forbidden path` = scope 拒绝、`invalid args` = 权限**在**（用"参数不对"当探针：证明权限存在，又不弹对话框、不写文件）。
  * 被拒的：`shell|execute`、`shell|open`、`opener|open_path`、以及 scope 外的 `fs:read_text_file`；
  * **正向对照**：scope **之内**的读**真的能成** —— 少了这条，"什么都读不到"也能让上面几条全绿；
  * 界面真正在用的 5 个命令（`reveal_item_in_dir` / `open_url` / `dialog|open` / `dialog|save` / `fs|write_text_file`）权限都在 —— capability 一旦被重新生成时漏掉某条，对应功能会**静默失效**（只弹一个 toast）；
  * 静态对照：配置文件里一条 `shell:` 都没有（与运行时的 ① 互为印证）。
- **顺带修掉一个"以为能用其实不能用"的 helper**：`src/lib/system.ts` 的 `openWithDefaultApp()` 包着 `openPath`，而 `opener:allow-open-path` 没有授予（②的运行时断言就是盯着它）。它**从未被任何界面调用过**，一旦有人接上就会静默失败。已删掉，并在文件头写清"将来要做这个功能，得先有意地加权限并配 scope"。同时 `revealInExplorer` 的兜底也从"退回 `openPath`"改成直接报错 —— 那条兜底只会把一个真实原因盖成另一个看不懂的 ACL 错误。
- **顺带验了坏配置的恢复路径**（不在套件里，因为要重启应用）：`settings_store` 有单测覆盖 `load()` 的隔离逻辑，但"**应用启动路径**"这一层只有真重启才知道 —— 一个坏 JSON 让用户连界面都进不去的话，也就没有界面去修它。实机步骤：写入有辨识度的值（`accent=#123456`、`concurrency=7`）→ 重启确认真的读回 → 把 `settings.json` 写成一段坏 JSON → 重启 → 断言 **① 应用照常响应**、**② 坏文件被隔离成 `settings.broken.json` 且内容一字不差**、**③ 设置回到默认**（`accent=cyan`、`concurrency=8`）。验完还原备份并复查状态。



### 3.10 「保留源文件」这个设置在真机上**完全是惰性的**（本轮发现并补齐）

- **怎么发现的**：做【27】之前先去代码里找"**谁读 `keep_original`**"，结果**一处都没有**。它声明了（`Settings::keep_original`）、能改（`settings_patch`）、能落盘（`settings.json` 里真有这个字段，默认 `true`），但没有任何代码读它。
- **为什么这比"功能没做"更糟**：界面在**三个地方**把它当成真事 —— 设置页的开关「批量处理时保留源文件」、批量页的下拉框（保留 / 不保留）、运行面板上那句「当前设置：批量处理时不会保留源文件。」。也就是说，用户以为源文件会被删掉（或被保留），实际**一个都不会动**。`cargo check` 全绿、界面不报错、日志不告警，只有把真机跑完之后的文件列表拿出来对比才看得见 —— 与画布导出、【14】的 `video-to-gif` 属于同一类：**声明与行为不一致**。
  > 由此得出一条值得固定下来的对账方法：**对每一个设置字段，grep 一遍它的读取点**。"声明了但没人读"的字段不会让任何构建变红，只有主动去找才会现形。
- **补上的行为**（`apps/desktop/src-tauri/src/commands.rs`）：每个批次**成功之后**，按设置删除这一次真正用到的输入文件；每删一个都写进任务日志（`已按设置删除源文件：…`），删失败只记 warn（不因为删不掉一个文件把成功的批次变成失败）。
- **边界条件全抽成纯函数逐条钉单测**（`sources_to_delete()`，5 条单测）：

  | 情形 | 处理 | 为什么 |
  |---|---|---|
  | `keep_original == true` | 一个都不删 | 默认值就在安全的那一侧 |
  | 输入文件已不存在 | 跳过 | 就地改名（`fs.move`）之后旧路径本来就没有了 |
  | 输入路径**出现在产出里** | 跳过 | 产出与输入同路径时，"删源文件"等于删掉刚生成的结果 |
  | 多个输入端口 | 每个端口都要考虑 | 漏掉的那个端口的源文件会被静默留下 |
  | 其余 | 删 | 这才是用户勾掉「保留源文件」时想要的 |

  调用点还额外保证一件纯函数管不了的事：**只有批次成功之后才走到删除那一步**。失败或取消时源文件必须留着 —— 那是用户唯一还能重试的东西。
- **【27】（19 项）**：① 开关打开 → 源文件在、产出照常；② 关掉 → 源文件**真的没了**、产出完好、日志写明了删掉谁；③a/③b/③c/③d **删用户文件最容易出事的几条路**（详见下）；④ 失败的任务不删。
- ★ **顺带修掉两条"看着在验、其实没验"的检查**：
  * **③ 原来是空洞断言**：它只检查「源文件还在」，而任务**失败**时源文件当然还在 —— 失败原因完全可能是清单写错、引擎缺失、参数不合法。真正要钉住的是**拒绝的理由**：节点的写操作按 `output` 角色解析路径（`nodes.rs::resolve_path`），输入路径落在收敛边界之外，必须报 `PERMISSION_DENIED`。现在错误码一起断言。
  * 而 ③a 一旦成立，"就地编辑"这条路**根本到不了删除那一步**（插件写不回自己的输入路径）—— 于是"产出里出现的路径绝不删"这条规则反而失去了端到端覆盖。补 **③b**：一个 **L3 直通插件**（校验 PNG 头后把**输入路径本身**报成产出、一个字节都不写）真的走到 `produced == src`，断言产出还在、且日志里**没有**删除记录。
  * 但"日志里**没有**删除记录"这种**只断言"没发生"**的检查天生可疑（删除机制整体坏掉同样能过），所以再加 **③d 正向对照**：同一个插件、同一份输入、同一个设置，只把要报的产出换成输出目录里的一份副本 —— 源文件就**必须**被删。两条一起看，才能把"认出来了"与"压根没跑"分开。

### 3.11 「声明与行为不一致」的第三次普查：参数与设置的**读取点**（本轮）

§3.10 修掉 `keep_original` 之后，很自然的下一个问题不是"还有没有别的设置是惰性的"，而是**怎么才能不靠运气发现它们**。本轮把"声明了但没人读"当成一个可以**机械对账**的性质，做了两件事。

**① 设置字段普查：10 个字段全部有真实读取者。**

方法就是 §3.10 结尾记下的那条：**对每一个设置字段 grep 一遍它的读取点**（Rust 侧 snake_case、前端侧 camelCase，两边都要看）。

| 字段 | 读取者 | 结论 |
|---|---|---|
| `concurrency` | `state.rs` 建队列时用；`settings_patch` 立刻 `queue.set_concurrency()` | ✅ 而且**改动即刻生效**（不是"下次启动才生效"） |
| `default_output_dir` | `commands.rs::resolve_output_dir`（任务没显式给输出目录时） | ✅ |
| `keep_original` | 上一轮才接上（§3.10） | ✅ 原本是唯一的惰性字段 |
| `probe_engines_on_startup` | `lib.rs` 启动路径 | ✅ 语义就是"启动时" |
| `theme` / `accent` / `ambient_effects` | 前端 `theme.ts` / `ui-store.ts` / `aurora-background.tsx` | ✅ 纯前端设置，后端本来就不该读 |
| `ai.provider` / `base_url` / `model` / `temperature` | `state.rs::rebuild_ai_client` + `provider.rs` 请求体 | ✅ 改完立刻重建客户端，不是"下次启动生效" |
| `ai.persist_api_key` | `state.rs` 的 Key 落盘策略 | ✅ |

> 这张表的价值不在"全都 ✅"，而在于**它是可复算的**：将来加字段时，同一个动作就能查出"声明了没人读"。

**② 插件参数普查：把判据写进校验器，而不是靠人记得查。**

内置插件上，"参数是装饰品"这个缺陷已经撞到过**两次**：`doc.to-pdf` 的 `format`（节点早就不读它了）、`video.transcode` 的 `container`（输出扩展名其实由 `format` 决定）。两次都是**声明与行为不一致**：控件在界面上、用户调了、文件一点没变、任务照样"成功"。

现在 `PipelineDef::validate_param_reachability()`（`crates/toolforge-core/src/pipeline.rs`）会报 `PARAM_NEVER_USED`。判据是 **L1 插件的参数只有三条通道能到达执行器**：

| 通道 | 形态 | 真实例子 |
|---|---|---|
| ① 同名 `with` 键 | `with: { quality: "80" }` | 字面量直接透传 |
| ② 模板注入 | `with: { index: "${params.indexMode}" }` | **插件参数名可以与节点参数名不同** —— 内置 `batch-rename` 的 `indexMode` 就是这样 |
| ③ 节点按名读取 | `with` 里一个字都不写 | 节点 `param_str("format")` 回退到用户参数（`NodeCtx::arg_scope`）—— 内置 `image-convert` 的 `format` / `quality` 就是这样 |

★ **判据的两次收紧，都是被真实反例逼出来的，这一段值得留着**：
* 第一版只比 **`with` 的键名**。它把内置 `image-convert` 的 `format` / `quality` 判成了装饰品 —— 而那两个**正在正常工作**（【6】【22】真机验过：选 webp 出 WebP、宽 400 出 400×300）。于是补上通道 ③。
* 第二版把通道 ③ 加上，又轮到 `batch-rename` 的 `indexMode` 被误报 —— 它是 `index: "${params.indexMode}"` 注入的，**键名与参数名不同**。于是补上通道 ②。

教训写清楚：**误报比漏报更糟**。漏报只是少发现一个缺陷；误报会让一个**好插件**在安装时报出一条用户和作者都看不懂的警告，然后这条检查就会被当成噪音关掉 —— 那时才是真的什么都没守住。所以判据的**假阳性必须是零**，代价是接受一个**已知的假阴性**：

> ⚠️ 通道 ③ 用的是节点**声明的**参数表（`NodeDescriptor::params`），不是"节点源码里真的读了哪些键"。所以"节点声明了 `format` 但其实没读"这种情况查不出来。要查出它得做源码级分析或逐节点打桩 —— 代价与收益不成比例。这是**明说的边界**，不是"已经完备"。
>
> ✅ **这个假阴性不是理论上的 —— 它后来真的发生了（§3.23）**：`image.rotate` 声明了
> `autoOrient`（默认 `true`、界面上是个默认打开的开关），而 `nodes.rs` 里**一行都没读它**。
> 而且这一条**连上面那三条通道都管不到**：`validate_param_reachability` 的输入是
> **插件清单**（`PluginManifest::io`），`autoOrient` 是**内置节点自己的**参数 ——
> 也就是说"内置节点的参数有没有人读"目前**没有任何对账**，既没有校验器也没有测试。
> 已修的是那一个参数；**"加一道对内置节点参数的普查"仍是待办**（`NodeDescriptor::params`
> 与 `nodes.rs` 里 `param_*` 的调用点做交叉比对，可以做成一条单测）。

- **它是 warning，不是 error**：参数没人读不会让任务失败，它只是让一个 UI 控件变成谎言 —— 装得上、跑得动，不该拦住安装。
- **用户在哪看得见**：安装确认页（`plugin-sources.tsx` 把 `ValidationReport` 的每条 issue 都渲染出来）与 AI 工作室的审核面板（`review.rs` 把每条校验问题**逐条**映射成 finding，warning → Medium）。两条路都不需要新 UI。
- **单测 6 条 + 审核映射 1 条**：三条通道各一条（防误报）、全不沾一条（防漏报）、"没有参数时什么也不做"一条、`validate()` 真的接上它一条（**一个没被调用的检查函数等于没有检查** —— 本项目踩过）；`toolforge-ai` 那条钉住"装饰品参数进得了审核报告、等级是 Medium、而且不会把草稿挡在用户确认环节之外"。
- **反证**：给内置 `doc-to-pdf` 临时加一个 `format` 参数（正好复刻当初那个真实缺陷），`bundled_plugin_manifests_pass_the_new_template_check` 立刻变红并**点名到文件与参数**；随后原样还原。
- **对 8 个内置插件的普查结果**：32 个声明参数，**装饰品 0 个**。也就是说这次没有抓到一个现存缺陷 —— 但它把"以后不会再出现这一类"变成了构建期的事，而不再依赖某个人想起来去查。

### 3.12 许可证确认的前端那一半：**UI 点击穿透第一次被验**（本轮）

§3.8 结尾留了一条明确的自认空白：

> ⚠️ 前端那两个勾选框本身**没有做点击穿透验证** —— 本机所有需要确认的引擎与权重都已安装，界面上不会出现"安装/下载"按钮，点不出一条真实路径。
> ✅ **已补上（见 §3.12）**：模型那一侧靠"把权重文件临时挪走"造出未安装状态，引擎对话框靠页面内注入的目录数据驱动；两者都验到了真实请求体里的 `licenseAccepted`。

这一轮把它补上了。它值得补的理由很直接：**那个真实缺陷恰恰在前端**（`model-panel.tsx` 的 `licenseAccepted: !m.commercialUse`）。【25】验的是后端契约 —— 后端再严，前端替用户点头也拦不住。

- **前提是"造"出来的，两处都不隐瞒**：
  1. **模型面板**：把 `birefnet-general`（不可商用）的权重**同卷 rename** 挪走 —— 这是真实的"没装"状态，卡片于是渲染出勾选框与「下载」。收尾在 `finally` 里挪回来（失败也挪：这台机器上后面每个抠图检查都要用它）。
     > 踩到的第一个坑：**跨卷 rename 会报 `EXDEV`**（`C:` → `D:` 不是"移动"，是"复制+删除"）。暂存目录必须在同一个卷上。
  2. **引擎安装对话框**：本机 12 个引擎全装好了，所以用 `Page.addScriptToEvaluateOnNewDocument` 在**页面脚本之前**挂一层 fetch 包装，把 ffmpeg 的目录状态改写成 `missing` 再整页刷新。真实的组件 / 事件 / 请求构造，合成的只有喂进去的那份目录数据 —— 要完全不合成，得有一台没装 FFmpeg 的机器。
- **怎么验"点下去到底发了什么"**（三个技术细节，都值得记下来，将来做 UI 验证还会用到）：
  * **传输层是 `window.fetch` → `http://ipc.localhost/<命令>`**（实测确认）。挂在 fetch 上既能拿到请求体，又能**拦下 install 那一发**（回一个假 jobId），于是不必真的下载几百 MB、也不必改动真实状态。
  * **`__TAURI_INTERNALS__` 上那些函数全都替换不了**：`invoke` / `ipc` / `postMessage` / `transformCallback` 全是 `writable:false, configurable:false`。这是 Tauri 刻意的硬化（防注入脚本篡改 IPC）—— 值得记下来：**它同时也意味着"用页面内脚本伪造 IPC"这条路是走不通的**，只能从传输层下手。
  * ★ **伪造响应必须带 `Tauri-Response: ok` 头**。Tauri 的 JS 侧是这么判成功的：
    ```js
    const callbackId = response.headers.get('Tauri-Response') === 'ok' ? callback : error
    ```
    少了这个头，一次**成功**会被当成**错误**回调 —— 现象是一句「读取引擎目录失败 [undefined]」，而请求与响应本身完全正常。第一次就是这么栽的，查了半天才在 `postMessage` 的源码里看到那一行。
- **【29】（27 项）**验的东西：
  * **对照**：可商用且未安装的 `u2net` → **没有**勾选框、按钮可用（不该无端要求确认）；
  * 不可商用的 `birefnet-general` → 勾选框出现；未勾时按钮禁用且 `title` 写明原因；勾上后可用；点下去请求体是 `licenseAccepted: true`；
  * **未勾选时点不动、一个请求都发不出去**；
  * ★ **绕过 `disabled` 直接调组件自己的 `onClick`**（从 fiber 上取 `__reactProps.onClick`）→ 请求体里是 `licenseAccepted: false`。这一条是冲着历史缺陷去的：只断言"按钮禁用"拦不住 `licenseAccepted: !m.commercialUse` —— 按钮禁用了，可**处理器里那个常量还在**；
  * **引擎安装对话框**：默认未勾选 → 「开始下载安装」禁用 → 勾上 → 请求体 `{engineId, licenseAccepted: true, allowUnverified, force}`；
  * **已确认过**（`licenseAcknowledged: true`）→ 勾选框预先勾上 + 显示"已于…确认过" + 确认按钮直接可用：**省一次点击，但不是跳过确认**（后端那道硬门与请求里的 `true` 都还在，【25】盯着）。
- **收尾不留副作用**：权重还原、注入脚本摘掉、整页刷新，最后断言 `models_list` 重新报告 `installed: true`。

> 至此 §3.8 那条自认空白可以划掉了。仍然没做的是**真实的下载行为**（点下去之后那几百 MB 的下载、SHA-256 校验、失败回滚）—— 那部分由【25】的后端契约与【4】/【18】/【19】的真机安装验证覆盖，本节刻意不重复下载（用假 jobId 拦下），**这一点在检查名里写清楚了**，不冒充端到端。

### 3.13 Windows 脚本的编码：一条被实测逼出来的规则，现在有守卫（本轮）

- **症状**：`scripts/devtools/dev-with-cdp.ps1`（**文档里推荐的启动方式**）在 Windows 自带的 PowerShell 5.1 下**连解析都过不去**，报
  `Unexpected token '}'` —— 指的却是一个完全正确的行：
  ```text
  L100: Unexpected token 'exe' in expression or statement.
  L100: The hash literal was incomplete.
  L89: Missing closing '}' in statement block or type definition.
  ```
- **原因不是语法，是解码**（实测链条）：
  1. Windows PowerShell 5.1 在文件**没有 BOM** 时按 **ANSI/GBK** 解码；PowerShell 7 默认按 UTF-8 读 —— 所以这个问题**只在"用系统自带 PowerShell 跑"时出现**，而那是 Windows 用户的默认情况。
  2. 注释里的中文是多字节 UTF-8 序列，GBK 会把其中某些字节当成**后继字节**，把它后面紧邻的 ASCII 字符**吞掉**。
  3. GBK 的后继字节范围 `0x40–0x7E` **正好包含 `}`**。于是 `@{ a = 1; b = '中文' }` 里的 `}` 被吃掉，括号配对崩掉。
- **判据（可复现，也是这条结论的全部依据）**：
  ```powershell
  [System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$null, [ref]$errs)
  ```
  去掉 BOM → 立刻 1–9 个 `Unexpected token`；加回去 → 0 个。**报错数量随注释内容漂移**，所以"这次看起来能跑"完全不可靠。
- ★ **这不是一次性的坑，它会自己回来**：本轮一次普通的文本编辑之后，编辑工具**悄悄丢掉了 BOM**，脚本立刻变成 9 个解析错误 —— 而这一点在任何"我改了脚本"的自检里都不会出现（因为自检通常只跑 `node`、不跑 PowerShell）。所以修法不能只是"记得加 BOM"。
- **补上的守卫**：`scripts/check-encodings.mjs` —— 扫描全仓 `.ps1` / `.bat` / `.cmd`，两条规则：
  * 含非 ASCII 字符 → **必须**带 UTF-8 BOM；
  * 行尾必须是 CRLF（`.gitattributes` 已经这么声明了，这里顺带核对工作区是不是也这样 —— 否则一次 `git` 触碰就会把整个文件重写）。
  已接进 `pnpm check:all`（`check:encodings` → `check:rust` → `check:web`），并加进 CI 的 Web job（纯字节级检查，与操作系统无关，但守的是"在 Windows 上跑得起来"）。
- **它当场抓到了第二个同病文件**：`scripts/env.ps1`（文档里让人 `. .\scripts\env.ps1` 的那个）同样**有中文、没有 BOM**，外加 40 处裸 LF。它今天**碰巧**还能解析 —— 只是它的中文注释后面恰好没有紧跟 `}` / `{` / `"`。这种"靠运气通过"的状态最危险，已一并修好（只改编码，内容一字未动）。
- **反证**：把 `dev-with-cdp.ps1` 的 BOM 去掉 → 守卫立刻变红（`✗ 1 处问题`，退出码 1），且 PowerShell 5.1 同时报出 9 个解析错误；加回去 → 两者都归零。

### 3.14 `clippy -D warnings` 从来没在本地跑过；它攒了 13 处错误，而 CI 那一步「不卡合并」（本轮修掉）

> ⚠️ **本文档最初把这一条写成了"CI 一直是红的"，那是错的**（下一轮核对时发现并改正）。
> CI 里那一步写着 `continue-on-error: true`，注释是"v0.1 阶段 clippy 先做提示，不卡合并"——
> 所以**整轮 CI 一直是绿的**，失败的只是那一个 step。这个区别很关键：
> 它不是"红了没人管"，而是**"根本没人会看见"** —— 13 处错误就是这样攒下来的。
> 改正的做法不是把话改软，而是**把 `continue-on-error` 去掉**（见本节末尾）。

- **怎么发现的**：为了核对本文档「附 A」里那句"静态质量：`cargo clippy --workspace -- -D warnings`、`cargo fmt --check` → **无输出**"，我去跑了一遍 —— 结果第一步就卡住：
  ```text
  error: 'cargo-clippy.exe' is not installed for the toolchain 'stable-x86_64-pc-windows-msvc'
  error: 'cargo-fmt.exe' is not installed for the toolchain 'stable-x86_64-pc-windows-msvc'
  ```
  本仓库的 Rust 工具链隔离装在 `.tools/rust` 下，而当初装的时候**没有装这两个 component**。
  也就是说：**这条检查点从来没有被本机执行过**。
- **装上之后立刻见红**：`cargo clippy --workspace --all-targets -- -D warnings` 报 **13 处错误 / 5 个 crate**。
  而本地"四道检查"（`cargo test` / `cargo check --all-targets` / `tsc` / `vite build`）**没有一条会碰 clippy** ——
  这是一个纯粹的**关口错位**：本地不问、CI 又不卡。
- **修掉的 13 处**（按 crate）：

  | crate | lint | 处理 |
  |---|---|---|
  | `toolforge-core` | `vec_init_then_push`（`builtin_nodes()` 里 32 个 `n.push(...)`） | **显式 `#[allow]` + 写清理由**：那 32 个描述符各自带注释与说明，`push` 的写法让每一项能独立增删；改成一个大 `vec![…]` 字面量之后，任何增删节点都变成在上千行表达式里挪逗号。这是**风格取舍，不是没听见提示** |
  | `toolforge-core` | `map(..).flatten()` / `assert_eq!(x, true)` / `x == false` | 改成 `and_then` / `assert!` / `!x` |
  | `toolforge-process` | `useless_format!` | 直接给字符串字面量 |
  | `toolforge-engines` | 冗余 `'static` ×2、手写字符比较、按下标遍历、手写 `match Ok/Err`、`== false` | `&[&str]`、`[' ', '-', '_']`、`iter_mut().enumerate()`、`.err()`、`!` |
  | `toolforge-plugins` | `useless .into()` ×2 | 删掉（`ToolforgeError → ToolforgeError` 的空转换） |
  | `toolforge-plugins` | `large_enum_variant`（`RunningPlugin::Python` 576 B vs `Wasm` 120 B） | **装箱**：枚举按插件挂在 `HashMap` 里，不装箱就得按最大的变体付移动代价 |
  | `toolforge`（外壳） | `needless_borrow` / `field_reassign_with_default` / `redundant_closure` | 逐个改掉 |

- ★ **其中一处是我这一轮自己写出来的**（`sources_to_delete(&inputs, …)` 里那个多余的 `&`，见 §3.10 的实现）—— 说明这个盲区**不只影响老代码**：本地关口不查的东西，新写的代码同样不会被拦住。
- **过程上的修法（比修 13 处更重要）**：新增 `pnpm check:clippy`（与 CI 同一条命令）并接进 `pnpm check:all`：
  ```text
  check:all = check:encodings → check:rust → check:clippy → check:web
  ```
  这样"本地聚合检查"与"CI 硬门"至少在这三条上对齐了。**没对齐的是 fmt**，见下。
- ★ **并且把 CI 那一步变成真的会卡**：去掉 `cargo clippy` 上的 `continue-on-error: true`。
  那句"v0.1 阶段先做提示，不卡合并"在有 13 处错误的前提下**永远不会被修**——
  它把"没人看见"伪装成了"不影响合并"。现在整个 workspace 在 `-D warnings` 下干净了，
  这一步就该是硬门：**验收标准是"零告警"，那它必须能失败**。
  > 顺带把 CI 里测试那一步的注释也改了：它写着"app crate 的测试需要 WebView，这里不跑"，
  > 而 `toolforge`（外壳）那 16 条测试是 `settings_store` / `license_acks` / `sources_to_delete`
  > 的纯逻辑与文件 IO，**不需要 WebView**（本机实测：`cargo test -p toolforge` 16 通过 / 0 失败）。
  > 那句注释把一个**可以跑的覆盖**挡在了 CI 外面，现在把它加回去。
- ⚠️ **`cargo fmt --check` 当时不干净**，那一条**故意留到下一轮**：
  * 实测 **271 处 diff / 30 个文件**（`pipeline.rs` 57、`nodes.rs` 44、`commands.rs` 28……）；
  * **CI 并没有把它列为必过项**（CI 的 Rust job 只跑 check / test / clippy），所以它不是"红的"，只是本文档里"无输出"那句话是**错的**；
  * 全仓重排是一次纯机械但**覆盖面很大**的改动，所以当时先把文档里的假话改掉（附 A 与验收标准 §2 都标注了实测数字），把"要不要 `cargo fmt --all`"记为待决项。
  > ✅ **已决定并执行（见 §3.20）**：选择**采用 rustfmt** —— `cargo fmt --all` 重排了 30 个文件，
  > 并把 `cargo fmt --all --check` 加进 `pnpm check:all` 与 CI。理由：文档里写着"零格式差异"这个验收标准，
  > 要么让它成真、要么把那句话删掉；而这个项目的原则一直是**让声明成真**。
- 实测：`clippy --workspace --all-targets -- -D warnings` **退出码 0**；`cargo test --workspace` **286 passed / 0 failed**；`cargo check --workspace --all-targets` **0 error / 0 warning**；`verify-platform.mjs` **401 项全通过**。
  （`cargo fmt --all --check` 当时还不干净 —— 已由 §3.20 处理。）

### 3.16 把「文档里写的检查点」逐条真的跑一遍（本轮）

上一轮修完了 clippy，但本文档「附 A：阶段验收总检查点」里还有几条**只在文档里存在**的项。这一轮把它们逐条执行了一遍 —— 结论是**大多数成立、两条需要改口径**：

| 检查点 | 命令 | 实测 |
|---|---|---|
| 聚合 | `pnpm check:all` | ✅ 退出码 0（encodings → rust → clippy → web） |
| 全仓健康 | `cargo test --workspace` | ✅ **286 passed / 0 failed** |
| 全目标检查 | `cargo check --workspace --all-targets --locked` | ✅ 0 error / 0 warning（`--locked` 也通过，说明 `Cargo.lock` 是完整的） |
| CI 同款测试 | `cargo test -p <5 个库 crate> --locked` | ✅ 264 passed / 0 failed |
| 静态质量 | `cargo clippy --workspace --all-targets -- -D warnings` | ✅ 退出码 0 |
| 类型桥 | `pnpm bindings` **连续两次** | ✅ 第二次之后 `git status` **干净**（32 个命令 + 4 项守卫全过） |
| 脚本编码 | `pnpm check:encodings` | ✅ 退出码 0（§3.13 新增） |
| 真机验收 | `node scripts/devtools/verify-platform.mjs` | ✅ **401 项全通过**（【0】+【1】–【34】） |
| 真机验收（**全部六个脚本**） | `node scripts/devtools/run.mjs` | ✅ **六个脚本全部 exit=0**（inspect / smoke / e2e / verify / verify-platform / verify-runtimes，见 §3.18） |
| 前端质量 | `pnpm typecheck`、`pnpm lint` | ✅ 两条都是真的了：`typecheck` = `tsc --noEmit`；`lint` = **ESLint 8 + TS/React Hooks/jsx-a11y 规则集，`--max-warnings 0`**（§3.22 之前它是回退成 `tsc` 的空壳，见下） |
| 格式 | `cargo fmt --all --check`（= `pnpm check:fmt`） | ✅ **零格式差异**（§3.20 完成全仓重排并把这一步接进 CI） |

> 这一节的价值不在"跑一遍"，而在于**把"文档里写着"与"真的跑过"分开**：
> 上表里每一条都留下了命令与实测值；其中 `pnpm lint` 与 `cargo fmt --check` 这两条，
> 当时都属于"文档说它有、实际它不提供那个保障"的那一类 —— 与 §3.10 的 `keep_original`、
> §3.11 的装饰品参数是同一个毛病，只是发生在**质量基线**上。
> 后续处置：`cargo fmt` 那条已在 §3.20 变成真的（重排 + 接进 CI）；
> `pnpm lint` 那条仍是**刻意的取舍**（见上表说明），要不要启用 ESLint 依旧是个开放决定。

### 3.15 一次**自己造成的事故**：928 MB 的权重被截成 0 字节（本轮发生、定位、修复并补上防线）

这一条记的是一次**验证脚本把用户数据弄坏了**的事故。写这么细，是因为它同时暴露了**测试替身的设计问题**和**产品的一处真实缺口**。

#### 发生了什么

做【29】（许可证勾选框的 UI 点击穿透）时，为了让"不可商用的权重"在界面上呈现"未下载"状态，脚本把 `birefnet-general` 的权重文件（928 MB）**同卷 rename 挪走**，然后真的去点了「下载」，指望页面里的 fetch 记录器把那一发请求拦下。结果：

1. 记录器**记到了**请求（URL 与请求体都对），前端也确实拿到了假响应；
2. 但后端**真的开了一个下载任务**，而下载的第一步是 `File::create` —— **把权重文件截成了 0 字节**；
3. 脚本的 `finally` 又把暂存的原文件 rename 回去，于是**表面上什么都没发生**；
4. 大约半小时后【8】真机验证失败（`birefnet-general` 报「抠图脚本执行失败」），追下去才发现那个文件是 0 字节。

恢复用了 1.5 分钟重下 —— 顺带验证了备用源的价值：日志第一行是
`主下载源（huggingface.co）失败，改用备用源重试`，然后以约 10 MB/s 完成。**之前给权重补 `fallbackUrl` 的工作，这次真的救了场。**

#### 根因一：测试替身的前提**本身是破坏性的**

旧设计是"把真实文件挪走造状态 + 靠拦截防止写入"。这两件事凑在一起意味着：**拦截只要有一个缺口，代价就是用户的数据** —— 而"拦截有没有缺口"恰恰是最不该拿来赌的东西。

新设计把前提改成**只改喂给界面的数据**：`models_list` / `engines_catalog` 的响应在页面里被改写成"未安装"，**磁盘一个字节都不动**。于是即便请求漏到后端，代价也是零 —— 因为真实文件在，`install_model` 会先算哈希、发现与预期一致直接短路。这不是推测，是任务日志里的原话：

```text
job-fbeb0ac1d689  0.6 s  succeeded  本地已有校验通过的 birefnet-general（927.6 MB），跳过下载
job-bead3ba4df57  0.06 s succeeded  已经可用，跳过下载
```

**判据也跟着改了**：不再数"有没有新任务"（那会把一次无害的短路判成事故，然后去 cancel 它 —— 反而可能掐断一次正在做的哈希校验），而是断言**没有真的在下载**（任务不能停在 running，日志里要有短路证据）且**权重文件字节数一字未变**。

#### 根因二："记录了 ≠ 拦住了"

Tauri 的 IPC 有**两条通道**：

| 通道 | 命令名在哪 | 经过 `window.fetch` |
|---|---|---|
| custom protocol | URL 里（`http://ipc.localhost/<命令>`） | ✅ |
| 回退（`window.ipc.postMessage`） | **body** 里 | ❌ |

记录器按 **URL 的末段**去认命令，于是在回退通道上它只记录、**照原样转发**；而 `customProtocolIpcFailed` 一旦置位是**粘的**。结论写进【29】的注释了：**UI 验证的判据不能建立在"我拦住了"之上，只能建立在"后端状态没变"之上。**

#### 根因三（这一条是**产品**的缺口，也是本轮真正的收获）

"这个权重装好了吗"当时的判据是 `Path::is_file()` —— **0 字节的文件同样为真**。于是：

* 界面显示「已就绪」；
* `image.remove-background` 把空文件交给 onnxruntime；
* 用户看到「抠图脚本执行失败」，而真正的原因（protobuf 解析失败）埋在 Python 的 stderr 里，跟"文件是空的"隔了三层。

修法（判据只写一次，两处共用）：

* 新增 `toolforge_core::engine::model_size_looks_complete(len, approx_mb)`：**0 字节、或不足标称体积的 60% → 不完整**。判据刻意宽松 —— `approx_size_mb` 本身就写着"约"（上游会换同名资产），而**把完好文件误判成损坏比漏判更糟**：前者让用户反复重下几百 MB，后者只是让错误晚一步暴露。精确一致性仍然由下载时的 SHA-256 负责。配 4 条单测（0 字节 / 半截 / 完好且有 40% 余量 / 没有标称体积时不误判）。
* `models_list` 用它：0 字节的权重不再被报成「已就绪」。
* `image.remove-background` 与 `ai.upscale` 在**推理之前**用它：报 `INTEGRITY_CHECK_FAILED`，并写清"多半是上一次下载被中断或被截断 → 去「设置 → 引擎管理 → 模型权重」重新下载（会重新做 SHA-256 校验）"。
* **【30】（8 项）**端到端验它：拿 **4.65 MB** 的 `realesr-general-x4v3` 开刀（刻意**不用** 928 MB 那个 —— 那是"用一次两分钟的恢复换一条断言"）：截成 0 字节 → 状态接口如实报"未安装" → 节点任务失败且错误码是 `INTEGRITY_CHECK_FAILED`、信息里点明"不完整"并给出下一步 → 失败时不留半截产出 → 收尾原样还原（字节数一致）并重新认作已安装。

#### 顺带一条关于"清理测试替身"的教训

**测试替身比被测代码更难收拾。** `Page.addScriptToEvaluateOnNewDocument` 注册的脚本会作用于**之后每一个新文档**；而我只记住了"最新那一份"的 id，忘了摘最早那份 —— 于是第一份假数据（把模型说成未安装）跟着跑到了收尾检查里，让"没有副作用"这条检查**假红**了一次。现在 `patchAndBoot()` 每次先摘上一份，收尾还会轮询确认新文档里确实没有注入物。

### 3.17 `enginectl verify`：把"文件在 ≠ 文件能用"变成一条离线命令（本轮）

§3.15 记了那次事故：0 字节的权重被当成"已就绪"。修完之后应用侧有两层防线（状态接口不再谎报、节点在推理前拦一道），但它们都是**运行时的兜底**。这一轮补的是**离线、可脚本化**的那一层 —— `scripts/enginectl.mjs verify`。

- **它做什么**：不启动应用、不需要网络，逐个权重**算一遍 SHA-256** 并与 `engine.rs` 里预置的哈希比对；
  0 字节 / 不足标称体积 60% 的按"不完整"处理（判据与 Rust 侧 `model_size_looks_complete()` 同一条）；
  文件**不存在**只记"未下载"，**不算失败**（权重本来就是按需下载的）；预置哈希为 null 时只打印实际值并警告。
  `--json` 给 CI 用，`--data-dir` 可指向另一台机器的数据目录。
- **引擎侧不做哈希校验**（这一点必须说清）：`engine-sources.json` 里的 sha256 是**压缩包**的哈希，
  而本地是解压后的目录，两者不可比。所以引擎只报"托管目录在不在、版本是多少、该平台有没有固定哈希"。

**真机实测**（本机 Windows）：

```text
权重                  体积      预置哈希      实际哈希      结论
u2netp                4.4 MB    309c8469258d  309c8469258d  ✓ 与预置哈希一致
u2net                 —         8d10d2f3bb75  —             · 未下载（不算失败）
birefnet-general      927.6 MB  58f621f00f5d  58f621f00f5d  ✓ 与预置哈希一致
modnet-portrait       24.7 MB   07c308cf0fc7  07c308cf0fc7  ✓ 与预置哈希一致
birefnet-lite         213.6 MB  5600024376f5  5600024376f5  ✓ 与预置哈希一致
realesr-general-x4v3  4.6 MB    09b757accd74  09b757accd74  ✓ 与预置哈希一致
realesrgan-x4plus     63.9 MB   279da2949cfc  279da2949cfc  ✓ 与预置哈希一致
合计：9 个权重，0 个有问题。                       （退出码 0）
```

> ★ 这条输出顺带给出了一份**独立的证据**：§3.15 里被我截断又重下的那个 927 MB 权重，
> 现在的哈希与预置值**逐字节一致** —— 恢复是完整的，不只是"文件大小差不多"。

**失败路径也真机验过**（拿 18 MB 的 `realesrgan-anime6b` 开刀，验完删掉，机器状态复原）：

| 情形 | 输出 | 退出码 |
|---|---|---|
| 0 字节 | `✗ 文件是 0 字节（0 B）` + 文件路径 | **1** |
| 1 MB（明显截断） | `✗ 明显不完整（1.0 MB）` + "删掉这个文件后重新下载"的处理建议 | **1** |

#### 顺带修掉的两处"开发脚本自己漂移"

这个子命令一写出来就暴露了 `enginectl.mjs` 自己的两个问题，都属于本项目反复出现的那一类：

1. ★ **JS 里手抄的 `ENGINE_BINARIES` 与 Rust 那份漂移了**：脚本头部还写着"与 registry.rs 保持一致"，
   而 Rust 那边早已加了 `poppler`（`pdftoppm`），JS 这份没跟上 —— 于是 `probe` / `verify` 对 poppler 报的是
   **"该引擎没有登记可执行文件名"**，而机器上它明明装好了（路径就在 `Library/bin/pdftoppm.exe`）。
   现在**直接从 `registry.rs` 解析**（连同 `#[cfg(windows)]` 这类平台属性一起认），抄一份的机会就没有了。
   同样地，JS 里的 `MANAGED_LAYOUT` 也被删了：改成**按候选文件名在托管目录里浅层查找** ——
   7-Zip 的 `Files/7-Zip/7z.exe`、LibreOffice 的 `program/soffice.com`、Poppler 的 `Library/bin/`
   这三种布局都能命中，而不用再维护第三张表。
2. ★ **解析器少认一种写法就"静默输出错的清单"**：权重的字段在 `engine.rs` 里写作
   `sha256: Some("…".into())`、`url: Some(format!("{REMBG_RELEASE}/x.onnx"))`，
   而第一版正则只认裸字符串 `field: "…"` —— 结果**9 个权重的哈希全被读成 null**，
   表格照样打得漂漂亮亮，结论却全是错的。现在三种写法都认、常量（`{REMBG_RELEASE}`）会自动代回，
   并且加了一条守卫：**原文里明明写着 `Some(…)` 而脚本没抽出来 → 直接失败**，不再输出看着正常的错表。
3. 另外 `probe` 现在会同时查**仓库 `engines/`** 与**应用数据目录 `engines/`**：此前只查前者，
   于是在"应用里装好、仓库没装"的机器上（本机就是）它把所有引擎报成"未检测到" —— 又一份看着正常的错表。

**当前的 `probe` 输出**（同一条命令，改动后的真实结果）：8 个引擎认成"应用托管"并带出版本
（ffmpeg n8.1.3 / vips 8.18.6 / ImageMagick 7.1.2-31 / pandoc 3.11 / LibreOffice 26.2.6.3 /
7-Zip 26.03 / Python 3.11.16 / poppler 26.09.0），calibre 与 tesseract 如实报"未检测到"。

> 当时**没有**实现 `clean`（清理陈旧下载/残件）：它涉及**删用户文件**，而先把"发现"做扎实
> （`verify` 能指出哪个文件坏了、坏在哪）更稳 —— §3.10 那套"删源文件"的边界条件就是前车之鉴。
> ✅ **后来补上了，见 §3.21**：默认只看不删，只有"体积可疑 **且** 哈希证明不符"的才允许删。

### 3.18 坏掉的权重现在在界面上**看得出来**，而且六脚本套件第一次被完整跑过（本轮）

两件事，都补的是"验过的东西"与"声称验过的东西"之间的缝。

#### 一、`models_list` 如实报告还不够，用户看的是卡片

§3.15 之后，0 字节/半截的权重会被后端如实报成 `installed: false`。但这有个新的误导：
**卡片上只写「未下载」**，用户会以为"我从没下过这个权重"，而磁盘上其实躺着一个坏文件
（`installedSizeMb` 明明大于 0）。现在（`model-panel.tsx`）：

| 状态 | 徽标 | 按钮 | 说明 |
|---|---|---|---|
| `installed === false` 且**磁盘上没文件** | 未下载 | 下载 | 约 N MB |
| `installed === false` 但**磁盘上有文件**（不完整） | **文件不完整** | **重新下载** | "只有 x MB（标称约 y MB），多半是上一次下载被中断。点「下载」会重新校验并覆盖它 —— 不需要你自己去删文件。" |

判据只用后端**已经给出来的字节数**（`installedSizeMb > 0`），**不在前端算哈希** ——
那要读几百 MB，而列表是每次打开设置页都会刷的。真正的完整性由下载时的 SHA-256 与
§3.17 的 `enginectl verify` 负责。

**【30】新增 4 项**（现在 12 项）：把 4.6 MB 的权截成 0 字节 → 整页刷新让 React Query 重取
（truncate 之后缓存里还是旧数据，SPA 跳转不会重取）→ 断言卡片上出现「文件不完整」、
按钮文案是「重新下载」、说明里写了原因与后果；随后仍旧验"节点在推理前拦住 + 错误码是
`INTEGRITY_CHECK_FAILED` + 不留半截产出"，最后原样还原。

#### 二、六脚本套件第一次被**完整**跑过

之前几轮我只跑 `verify-platform.mjs` 一个脚本，`scripts/devtools/README.md` 里那句
"`pnpm verify:app` 串起 5+1 个脚本"却一直没被完整执行过 —— 又一处"文档说它有、实际没跑过"。
本轮在最终代码上跑了 `node scripts/devtools/run.mjs`：

```text
✅ inspect.mjs          exit=0   单页体检（挂载状态 / DOM 文本 / 运行时异常 / 截图）
✅ smoke.mjs            exit=0   路由冒烟（9 个页面逐个走）
✅ e2e.mjs              exit=0   端到端任务（真实转换 + 产出校验）
✅ verify.mjs           exit=0   验证包（解码 / 多文件扇出 / 恶意插件安全测试）
✅ verify-platform.mjs  exit=0   平台功能（401 项）
✅ verify-runtimes.mjs  exit=0   插件运行时（L2 WASM / L3 Python，70 项）
全部通过。
```

> 这同时是对 §3.14 那批 clippy 改动的**回归验证**：其中 `RunningPlugin::Python` 被装箱、
> `wasm.rs` 删掉了两处多余 `.into()` —— 都属于"看起来无行为变化"的改动，
> 而**只有 `verify-runtimes.mjs` 能证明 L2/L3 运行时确实还跑得起来**（它真的装 venv、
> 真的跑 JSON-RPC、真的做 net 白名单对照实验）。

### 3.19 `bindings.ts` 的**第二个写入者**：debug 应用一启动就会把新绑定覆盖回旧版本（本轮删掉）

- **怎么发现的**：本轮改完 `ModelEntry::installed_size_mb` 的文档注释 → 跑 `pnpm bindings`
  生成新版 → 提交 → **启动应用**（那个 exe 是改之前构建的）→ `git status` 又冒出一个
  `bindings.ts` 改动，而且内容是**旧的**。
- **机制**：`lib.rs::run()` 里有一段 `#[cfg(debug_assertions)]` 的代码，
  用 `specta_builder()` 把绑定导出到 `apps/desktop/src/bindings.ts`。而生成的输入是
  **编译进那个二进制里的类型** —— 于是跑一个**比源码旧的 debug 构建**（很常见：
  只 `cargo check` 过没重新 `cargo build`，或者一边改 Rust 一边跑着上次构建的应用）时，
  它会在启动阶段把**已经生成好的新绑定覆盖回旧版本**。
- **为什么这次必须修**：这个文件是**入库的生成物**，CI 有一道专门的 job 从源码重新生成再比对
  （`git diff --exit-code apps/desktop/src/bindings.ts`）。被旧二进制覆盖之后，那道 job 会红，
  而人看到的现象只是"我明明导出过"。更糟的一种情形是反过来的：源码**没**改、二进制**改了**
  （比如你手改了生成的类型又没同步回 Rust），前端会拿着与后端不一致的类型静默跑下去。
- **修法**：删掉那段自动导出，**只留一个写入者** —— `cargo run -p toolforge --bin export-bindings`
  （`pnpm bindings`），它从**源码**生成，并由 CI 的 drift job 守住"改了类型没重新生成"。
  代价是改了 Rust 类型之后要多敲一条命令；比"生成物被旧二进制悄悄改写"划算得多。
  文档同步改了 `docs/ARCHITECTURE.md` 里两处"两个生成入口"的说法（并在原文旁保留了这段历史）。
- **验证**：改完重新构建、再跑 `pnpm bindings` 两次（内容稳定、`git status` 只剩源码那一个改动），
  然后**启动应用** —— 这一次 `git status` 保持干净，说明启动过程**不再**碰这个文件了。

### 3.20 采用 rustfmt：把"零格式差异"这条验收标准**变成可失败的**（本轮）

**决定**：不删那句验收标准，而是让它成真。`cargo fmt --all` 一次重排 **30 个文件**
（1365 行增 / 681 行删，纯机械：结构体字面量换行、长表达式折行、参数列表展开），
然后把 `cargo fmt --all --check` 接进 `pnpm check:fmt` → `pnpm check:all` → CI 的 Rust job。

为什么不是"把文档里的假话删掉"：这个项目一路在做的就是**让声明与行为对齐**（§3.10 的 `keep_original`、
§3.11 的装饰品参数、§3.16 的 `pnpm lint`），格式这条没有理由例外 —— 它此前是"文档写着零差异、
实际 271 处差异、CI 又不检查"，三样凑在一起，等于一个**永远不会失败的验收标准**。

**改动是否安全**（逐条查过，不是"应该没事"）：

| 检查 | 结果 |
|---|---|
| 行尾没有被换成 CRLF | 抽查 `pipeline.rs`：CRLF 计数 **0**（仓库用 LF，`.gitattributes` 也是这么声明的） |
| `cargo test --workspace --locked` | **286 passed / 0 failed**（与重排前一致） |
| `cargo check --workspace --all-targets --locked` | **0 error / 0 warning** |
| `cargo clippy --workspace --all-targets --locked -- -D warnings` | **退出码 0**（含 `#[allow(clippy::vec_init_then_push)]` 那处仍是显式 allow） |
| `cargo fmt --all --check` | **退出码 0**（重排前后对比见 §3.14 的 271 处） |
| `node scripts/devtools/run.mjs` | **六个脚本全部 exit=0**（重排后重建二进制再跑） |

> 顺带说清一件事：**每次改动 Rust 源码之后都要重跑真机套件**，哪怕改动"看起来只是格式"。
> 格式重排会改变**二进制**（行号、调试信息、内联布局都可能变），而套件验的是**那个二进制**。
> 本轮就是这么做的：重排 → 重建 → 六个脚本全绿 → 才提交。

### 3.21 `enginectl clean`：删文件这件事，默认值必须在安全的那一侧（本轮）

§3.17 只做了"发现"（`verify` 指出哪个权重坏了、坏在哪），把删除留给用户。本轮补上 `clean`，
但设计上把**默认值放在安全的那一侧**：

| 用法 | 行为 |
|---|---|
| `enginectl clean`（默认） | **一个都不删**，只打印"如果加 `--apply` 会删哪些" |
| `enginectl clean --apply` | 只删**同时满足两条**的文件：① 体积可疑（0 字节 / 不足标称 60%，与 `verify`、Rust 侧同一条判据）；② **算过哈希且与预置值不符** |
| 体积可疑但**哈希一致** | **不删**，只报告（并说明"这说明标称体积不准"） |
| 体积可疑但**没有预置哈希** | **不删**，只报告（无法证明它坏了） |

另外顺带清 `<仓库>/engines/.downloads/` 里的压缩包 —— 那是 `enginectl install` 自己的
临时目录（默认下完即删，`--keep-archive` 才留），不是用户数据。

**为什么"只凭体积可疑不删"**：`approx_size_mb` 是**约数**（上游会换同名资产）。
误删一个完好权重 → 用户白等一次几百 MB 的下载；留着一个坏文件 → `verify` 与应用侧都会如实报出来。
两个错误的代价不对称，所以判据也不对称。

**真机验证**（三步，都不留副作用）：

```text
① node scripts/enginectl clean          → 列出 0 字节的 realesrgan-anime6b 与它的两条哈希，
                                          "以上一个都没删"；文件仍在（Test-Path = True）
② node scripts/enginectl clean --apply  → "已删除 …\realesrgan_anime6b.onnx；共删除 1 个"
③ node scripts/enginectl verify         → 合计：9 个权重，0 个有问题
                                          （**其余权重一个都没被误删**）
```

> 这一步把 §3.15 那次事故的最后一块拼上了：现在"发现坏文件"（`verify`）与"清掉它让下次重新下载"
> （`clean`）各有一条命令，而且**默认都不会动用户的东西**。

### 3.22 真的启用 ESLint：`pnpm lint` 从空壳变成检查（顺带修掉 21 处 a11y / 类型问题）

**背景**（§3.16 记过）：`package.json` 的 `lint` 脚本写着"未安装 ESLint（可选依赖），本次回退为
`tsc --noEmit`" —— 也就是说 `pnpm lint` **提供不了任何 `tsc` 之外的检查**，
而验收表里却写着"前端质量：typecheck + lint"。与 §3.20 的 `cargo fmt --check` 同一种病：
**一条永远不会失败的验收标准**。两条现在都变成真的了。

**做法**：按 `apps/desktop/.eslintrc.cjs` 头部原本就写好的那条命令装依赖
（eslint@8 + @typescript-eslint 7 + react-hooks 4 + react-refresh 0.4），**外加 jsx-a11y**
（见下），然后把 `lint` 改成 `eslint src --ext .ts,.tsx --max-warnings 0`，
并把 `pnpm lint` 接进 `check:web` 与 CI 的 web job。

**第一次跑出来的 21 处问题，逐条处理**（都用真机跑出来，不是"应该没有"）：

| 问题 | 数量 | 处理 | 为什么这么处理 |
|---|---|---|---|
| `no-explicit-any` | 1 | **忽略生成物**：`.eslintrc.cjs` 的 `ignorePatterns` 加 `src/bindings.ts` | 那个文件由 `pnpm bindings` 从 Rust 类型生成（文件头就写着 Do not edit），里面的 `any` 是第三方类型不兼容时的兜底 —— **手改会被下一次导出覆盖**，对生成物只能是忽略 |
| `label-has-associated-control` | 10 | **改配置**：`controlComponents` 列出自家控件组件 + `assert: "either"` + `depth: 3` | 规则默认只认原生 `input/select/textarea`，而本项目的勾选框是 Radix 的 `button[role=checkbox]`；标签文字又在第三层 `<span>` 里。修完这 10 条**全是误报**（不是代码问题），而规则本身留在 error 级继续管其它 `<label>` |
| `no-redundant-roles`（`role="list"` 写在 `<ul>` 上） | 8 | **改配置**：`{ ul: ["list"] }` 放行这一种 | 这**不是冗余**：Tailwind preflight 给 `ul, ol` 设了 `list-style: none`，而 WebKit 在这时会丢掉隐式 list 语义，读屏用户不再被告知"这是一个列表"。显式写回是标准补丁 |
| `no-noninteractive-tabindex` | 2 | **改配置**：`{ roles: ["region", "list"] }` | 可滚动区域（日志列表、代码块）里没有可聚焦子元素，不给 `tabIndex={0}` 的话**纯键盘用户根本滚不动它**（WCAG 2.1.1）。按**角色**放行而不是就地 disable —— 别处把 tabIndex 加到不可交互元素上仍会报错 |
| `no-autofocus` | 1 | **就地禁用 + 写清理由**（命令面板的搜索框） | 规则的用意是"别在页面加载时抢焦点"；而这是**用户主动按快捷键打开的面板**，焦点落在搜索框正是期望行为 |

**结果**：`pnpm lint` → **0 error / 0 warning**（`--max-warnings 0`，所以它真的能红）。

> 顺带说明两件**没有**混在一起做的事：
> * **没有**为了让它变绿而关掉规则再假装通过 —— 三处配置改动各自带了理由（生成物、控件组件、
>   Tailwind+WebKit 的 list 语义、可滚动区域的键盘可达性），只有 1 处是就地禁用；
> * **没有**顺便升级到 ESLint 9 的 flat config。那份配置是 legacy 格式，升级要重写配置并确认各插件
>   新版本兼容，是一次**独立的**改动；把它和"让 lint 真的跑起来"捆在一起，出问题就分不清是谁的锅。
>   这一条记在 `.eslintrc.cjs` 头部，留给下一次。

实测：`pnpm lint` 退出码 0；`pnpm check:web`（typecheck → lint → build）退出码 0；
`node scripts/devtools/run.mjs` 六个脚本 exit=0。

### 3.23 最后两个"从没被跑过"的图像节点 + 四条同源缺陷（本轮）

这一轮的起点是一个**反查**而不是一个缺陷报告：
32 个内置节点里，究竟还有哪几个**从来没有被真的执行过一次**？（§3.18 的教训：一个节点可以
"能拖出来、参数面板齐全、任务中心显示成功"，而实际上没人验过它。）

反查方法就是全仓库搜节点名（`crates` / `apps` / `scripts` / `plugins`）：

```powershell
Get-ChildItem -Recurse -Include *.rs,*.mjs,*.yaml -Path crates,apps,scripts,plugins |
  Select-String -Pattern "image\.crop"
```

`image.crop` 只出现在**节点声明、模块注释、和一句错误文案**里；`image.rotate` 唯一一次出现在
检查脚本里，是在【7】里的一句 `c.check(true, '能力边界已记录（详见 image.rotate 的错误文案）')`——
**那是一条永远为真的假检查**，而它所在的【7】虽然标题写着"任意角度旋转在无重采样后端时是否明确报错"，
实际跑的却是 `image-convert`，一行都没碰旋转。

于是本轮把它们补齐，并把沿途撞到的四条缺陷一起修掉。

#### (1) 新增【32】：`image.crop` / `image.rotate` 按**像素**验，16 条

一节新检查的价值全在"能证伪"。这里用**四象限纯色素材**
（`cdp.mjs::makeQuadrantPng`：左/右、上/下各一个纯色，四角互不相同），于是：

* **中心裁剪** 96×64 取 32×16，落点是手算的 `x=32,y=24` → 产出左上角必须是"左上/红"、
  右下角必须是"右下/白"。**右下角那条同时是反证**：一个"把输入原样拷过去"的空实现会让它
  等于源图的 (31,15) = 左上 = 红，必然失败。
* **自定义偏移**取同样的 32×16，但整块落在右下象限 → 四角**全白**。
  它与中心裁剪**尺寸完全相同**，所以只断言尺寸的话这两次运行毫无区别。
* **旋转 90°** 断言"96×64 → 64×96"（宽高互换）+ 四角仍是四个象限色。
  方向（顺/逆）**刻意不写死** —— 那是实现细节；改用"90° 与 270° 的产出必须不同"来证明
  角度方向真的生效（一个"永远顺时针转 90°"的实现在这里会失败）。
  180° / 水平镜像 / 垂直镜像则可以定向断言（左上角分别应该是原来的右下 / 右上 / 左下）。
* **任意角度**：读节点日志拿到实际后端，再断言"纯 Rust → 必须 `ENGINE_MISSING`；
  有 libvips/ImageMagick → 必须真的变形"。这正是【7】标题里承诺、但从来没验过的那一条。

顺带**删掉了【7】里那句假检查**。检查数因此从 **355 → 378**（【32】新增 24 条，删掉那句假检查 −1）。

#### (2) `autoOrient` 是一个**存在了很久的装饰品参数**

写【32】时读 `image_rotate` 才发现：节点声明里有 `autoOrient`（"按 EXIF 自动校正方向"，
**默认 `true`**），界面上是个默认打开的开关，而 `nodes.rs` 里**没有任何一行读它**
（全仓库 `Select-String -Pattern "autoOrient"` 只有 `pipeline.rs` 里那一处声明）。
后果很具体：手机竖拍的照片带 `Orientation=6`，`decode_image()` 走的是
`ImageReader::decode()` → `DynamicImage::from_decoder`，**它不读也不应用 EXIF 方向**，
所以用户拿到的是一张躺着的图，而开关显示"已开启"。

这是"声明了但从不使用"的第 N 次复发，**只是这次在节点参数上而不是插件参数上** ——
`validate_param_reachability` 只管插件模板里的 `${params.x}` 能不能到达 `with`，
**内置节点自己的参数没有任何对账**。

**修复**：三个后端各一条实现，语义统一（都先校方向、再旋转）：

| 后端 | 做法 | 实测依据 |
|---|---|---|
| libvips | `vips autorot` 落一个中间文件，再对它做旋转/翻转 | `vips rot` **不会**在加载时自动应用方向（`vips copy` 一张 `Orientation=6` 的 JPEG 出来仍是 96×64，不是 64×96）；`autorot` 会把标签改写成 1，所以链式调用不会重复旋转（autorot → `rot d90` = 96×64） |
| ImageMagick | 输入之后的 `-auto-orient` | 顺手把标签清掉，与 `-rotate` 不叠加 |
| 纯 Rust | `ImageReader::into_decoder()?.orientation()` 读出方向 + `DynamicImage::apply_orientation` | `orientation()` 是 `ImageDecoder` 上的方法（得把 trait 引进来），JPEG/WebP/TIFF 各自实现 |

**这里我自己先犯了一次错，值得记下来**：第一版探针手搓 EXIF APP1 时把字段偏移写错了一位
（IFD 条目是 `tag(2) type(2) count(4) value(4)`，我把 value 写进了 count 的高半字节），
产出的字节流"看着有 EXIF"、`vipsheader -a` 却一个 `exif-ifd0-*` 都读不出来 ——
于是我据此得出了"libvips 不会自动校正方向"这个**建立在坏素材上**的结论。
修好偏移后 `exif-ifd0-Orientation: 6 (Right-top)` 立刻读出来了，结论也完全反过来。
所以【32】和单测里都先钉一条**素材自检**（"方向真的被读出来了吗"），
**然后**才谈行为 —— 否则一条读不到方向的探针会让"没有校正"看起来像是产品行为。

**验证**：Rust 侧两条单测（读得出 / 不会给 PNG 编一个方向；以及"不校正就是躺着的"这条反证
+"校正后宽高互换"）；真机侧【32】⑩ 用**尺寸**验开关的两个位置 ——
96×64 的 JPEG + `Orientation=6`，`autoOrient` 开是 64×96、关是 96×64。

#### (3) 跳过的检查以前被算进"通过"里

`Checker` 只有 `pass` / `fail` 两个计数器。缺前置（没装引擎、没下权重、没配 API Key）时，
各节写的是 `c.check(true, '前置条件不满足，已显式记为跳过（不是"通过"）')` ——
打印出来是个绿的 `✅`，**也被算进"N 通过"**。于是"本机没装 X，这一节 8 条全跳过"和
"这 8 条真的都验过了"在汇总里长得一模一样，而标签上那句"不是『通过』"对汇总数字而言是假的。

现在 `Checker` 多了 `skip()`：打 `⏭`、单独计数、**不计入通过**，汇总行形如
`N 通过 / 0 失败 / M 跳过（跳过不计入通过）`。19 处"前置不满足"全部改用它。
所以本轮的通过数**比上一轮少**不是退步，是把虚报的部分扣掉了。

#### (4) `pnpm icons` 是**必失败**的（路径基准错了）

`icons` 脚本写的是：

```
node scripts/gen-icon.mjs && pnpm --filter @toolforge/desktop tauri icon ./assets/icon-source.png
```

`tauri` 子进程的工作目录是 `apps/desktop`，所以 `./assets/icon-source.png` 被解析成
`apps/desktop/assets/icon-source.png` —— **不存在**，报 `os error 3`。
验收标准第 13 条（"`pnpm icons` 全链路成功"）因此从来没有成立过，而它一直挂在那里。
改成 `../../assets/icon-source.png` 后**实测退出码 0**，连续跑两次产出**逐字节相同**。
`tauri icon` 会顺带生成 android/ios 两棵移动端图标树 —— 本项目 `bundle.targets = "all"`
指的是三套**桌面**打包，那两棵树没有任何构建会读，所以加进 `.gitignore` 并写明理由。

#### (5) 顺手修掉的另外两处

* `docs/PLUGIN-SDK.md` 第 3.5 节（"哪些节点会产出可供 `${steps.x.y}` 引用的值"）写着
  `image.rotate` 产出 `width` / `height` / `backend`，而实现里只 `with_value("backend", …)`。
  已改正，并把"给 `NodeDescriptor` 加 `values` 字段以便机械对账"列为待办 ——
  那张表现在是**唯一没有守卫的公开契约**。
* `check:rust` 补上 `--locked`（此前只有 `check:clippy` 有）：否则"本地全绿、
  CI 因为 `Cargo.lock` 过期而红"是可以发生的，而 CI 用的是 `--locked`。

#### (6) 进程层：管道死锁的回归测试（本轮补上）

`crates/toolforge-process/src/exec.rs` 此前只有一句注释声称"stderr 狂写不会死锁"，
**没有测试**。现在有一条真的：测试二进制把自己当子进程重新拉起，往 stderr 写 20 万行
（约 14 MB），断言它跑得完、尾部保留完成标记、输出被截断。
★ 关键的是**配套的反证** `naive_sequential_read_would_deadlock_on_the_same_child`：
用不经过 `exec` 的裸 tokio 顺序读同一个子进程，断言它**确实会卡住**。
少了这条反证，"没死锁"可能只是因为子进程写得太少 —— 那就成了一条永远绿的测试。

实测：`pnpm icons` 退出码 0（两次产出逐字节相同）；`cargo test --workspace --locked`
**286 passed / 0 failed**；`cargo clippy … -D warnings` 退出码 0；`cargo fmt --all --check` 退出码 0；
`node scripts/devtools/run.mjs` 六脚本 exit=0。

### 3.24 内置节点参数的**静态自省**：一条新守卫当场抓到三条「声明与行为不一致」（本轮）

§3.23 的最后留了一个问题：`autoOrient` 能在代码里躺那么久，是因为
**节点目录（`builtin_nodes()`）与执行器（`nodes.rs`）之间没有任何对账**。
`validate_param_reachability` 的输入是**插件清单**（`PluginManifest::io`），
管的是"插件声明的参数能不能到达 `with`"——它看不见**内置节点自己**声明的参数。
所以本轮把那道对账补上，而且是补在**模型层**（一条单元测试），不是补在脚本里。

#### 做法：把 `nodes.rs` 读进测试，对着源码做自省

`declared_node_params_are_actually_read_by_their_executor`
（`crates/toolforge-engines/src/nodes.rs` 的测试模块）：

1. `include_str!("nodes.rs")` 把**本文件**读进来（切掉 `mod tests` 之后的部分）；
2. 从 `nodes::run` 的 `"node.name" => handler(ctx, args)` 分发表拿到每个节点的处理函数；
3. 按**大括号配平**取出该函数的函数体，扫出它读了哪些参数键
   （只认 `param_str("…")` / `arg(args, "…")` 这类**字面量键**的调用形态）；
4. 再走**一跳**调用图，把辅助函数读的键并进来（目前只有
   `doc.ocr → rasterize_pdf(pdfDpi, pdfMaxPages)` 这一处）；
5. 与 `builtin_nodes()` 声明的参数**双向**对账。

为什么是静态而不是"把 32 个节点都真跑一遍"：跑一遍需要每个节点都凑齐真实输入与引擎，
代价极高而且装不齐引擎的机器上根本走不到；静态自省在任何机器上、`cargo test` 里就能跑。

**两处明说的边界**（宁可写清楚，也不要让人以为它完备）：

* **假阴性**：键名来自变量的读法（`arg(args, key)`）扫不到。判据刻意窄 ——
  一次误报就会让整条检查被当成噪音关掉，那时连假阴性都没有了；
* **`HOST_CONSUMED_PARAMS` 白名单**：有些参数是**宿主**读走的，节点不该读。
  目前只有 `format` 这一类（输出扩展名由 `commands.rs::build_io` 按 `params.format` 分配，
  于是"转成什么容器"是通过扩展名生效的，`ffmpeg_transcode` 里有一段注释解释为什么）。
  列成一张必须写理由的表，而不是"把判据放宽"——放宽等于悄悄放过一整类缺陷。

#### 第一次跑就报了三条，三条都是真的

| 问题 | 性质 | 处理 |
|---|---|---|
| `fs.delete.toTrash` | 声明了、**默认 `true`**、标签写着「移到回收站而非永久删除」，而 `fs_delete` 里**一行都没读它** —— 一直走的是 `remove_file` / `remove_dir_all`。**界面在替一个根本不存在的安全网做承诺**：一个以为"删错了还能捞回来"的用户，文件是真的没了 | 撤掉参数，说明改成实话（**永久删除，不进回收站**）。真正的回收站支持见下面的待办 |
| `archive.unpack.keepStructure` | 同类：默认 `true`、界面上有开关、说明里也写着，而执行器硬编码 `7z x`，关掉它毫无效果 | **真的实现**：`x`（保留结构）/ `e`（平铺），抽成纯函数 `sevenzip_extract_command` 并配单测 |
| `fs.move.overwrite` | **反向**：执行器（`fs_copy` 共用）一直在读 `overwrite`，而 `fs.move` 从来没**声明**过它 —— 用户既看不见这个开关、也没法关掉，只能吃默认的静默覆盖 | 在 `fs.move` 的 `params` 里补上（`docs/PLUGIN-SDK.md` 早就是这么写的，**是代码落后于文档**） |

> 顺带一个结论：这三处的**文档都是对的**，是代码漂了。
> 也就是说 `PLUGIN-SDK.md` 的节点表在这一轮里扮演的是"规格"，而代码没跟上 ——
> 这比"文档落后于代码"更该警惕，因为读者会按文档写插件，然后撞上一个不生效的开关。

#### 守卫本身也踩了一个坑（值得记）

第一版扫描器把 `name_build` 的**函数体找错了**，报"找不到函数体"。原因不是配平算法，
而是 `name_build` 里这一句：

```rust
let is_sep = c.is_whitespace()
    || matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|');
```

那个 **`'"'`** 是个**字符**字面量，里面包着一个双引号。不识别字符字面量的扫描器
会把它当成**字符串的开头**，于是后面所有括号的配平全乱。
所以扫描器里必须有"跳过字符字面量"这一段，而且判据要排除**生命周期**
（`&'a str` 同样是撇号开头，但后面没有闭合撇号）。

教训和 §3.23 那次一样：**自省工具的失败会长成"结论"的样子**。
所以这条测试自带两条自检 —— 扫描出的分发表条数必须等于节点数，
每个节点都必须能找到处理函数体；扫描器一旦失效，它会**大声失败**而不是一路绿。

#### 反证（做了）

临时给 `image.probe` 加一个谁都不读的参数 `反证用的假参数`，测试立刻变红并
**点名到 `image.probe.反证用的假参数`**；随后原样还原。

#### 顺带删掉一处死代码

`param_many()` 变成零调用者（它唯一的用户就是 `fs.delete` 那个参数），
删掉 —— 留着只会在 `clippy -D warnings` 里报 dead_code，或者更糟：
被下一个人当成"还有人在用"的接口。

#### 真机验证（新增【33】，14 条）

* `pipeline_nodes` 里 `fs.delete` **不再**有 `toTrash`、说明里**明说**永久删除；
  `fs.move` **有**了 `overwrite`；`archive.unpack` 的说明写清了 `x` / `e` 两种取值；
* `fs.move` + `overwrite=false`：目标不存在时成功 → 目标已存在时**必须失败**，
  且错误信息点名 `overwrite=false`（不是一句泛泛的失败）→ `overwrite=true` 时照常覆盖。
  **两个取值都能观测到**，不是"永远挡住"；
* `archive.unpack`：素材是**手搓的带两层目录的 ZIP**（`cdp.mjs::zipStore`，零依赖），
  默认解压必须出现 `nested/deep/inner.txt`，`keepStructure=false` 时必须平铺出 `inner.txt`
  且**没有** `nested/` 目录；最后一条是**反证** —— 同一个压缩包只改这一个开关，
  目录结构就必须不同（否则两条断言里必有一条是假的）。
  > 这一节第一版把两条断言写在了**错的路径**上（用"从 `job.outputs` 里挑一个不像文件的路径"
  > 去猜解压根目录，结果猜到了上一层），于是两条全红，而**行为其实是对的**。
  > 现在根目录是显式拼出来的（`<输出目录>/<输入主干>`）并且**先断言它存在**：
  > 命名规则一变就大声失败，而不是悄悄去检查一个空目录。

#### 仍然没做的那一半

`NodeDescriptor` 至今没有"我会产出哪些值"的字段，所以 `PLUGIN-SDK.md` **3.5 节**那张
「哪些节点产出可供 `${steps.x.y}` 引用的值」的表**仍然没有任何机械对账**（§3.23 修掉的那处漂移
就是这么来的）。补齐要给 `NodeDescriptor` 加 `values` 字段，会牵动 specta 绑定、
前后端类型与 UI，是一次独立的改动。

### 3.25 三个图像后端的**结果一致性**：一句写在节点说明里、却只验过一档的话（本轮）

`image.crop` 的节点说明里有一句：「裁剪矩形先算好再交给后端，所以三个后端切出来的
**位置完全一致**。」而在此之前，这句话**只有 libvips 那一档有证据**
（§3.23 的【32】里那些像素断言全是在本机有 libvips 的情况下跑的）。

这句话的重点恰恰在"三个"上：如果三档切出来的位置不同，同一份流水线在不同机器上就会
产出不同的结果 —— 而"我这儿是对的"是最难查的一类 bug。所以本轮新增【34】，
把三档**真的各跑一遍**再逐像素比：

* 第①档 libvips → 第②档把 `engines/libvips` 临时改名、只剩 ImageMagick →
  第③档把两个都改名、只剩纯 Rust（改名与还原的做法抄【12】/【13】，
  `finally` 里必定还原，**失败也还原**，并单独断言两个引擎都回到 `installed`）；
* **每档都要断言日志里的后端名**。这是本节最容易变成假检查的地方：
  改名一旦没生效，三次跑的其实都是 libvips，"三档结果一致"就会**毫无意义地通过**。
  所以"三档确实各走了一次"单列成一条断言；
* 比对器本身还要一条**反证**：拿两张确实应该不同的图（裁剪产出 vs 旋转产出）去跑同一个
  比对器，必须报不同 —— 否则"一致"可能只是因为比对器永远返回 same。

**实测结果：三档完全一致。**

| 操作 | 三档产出 | 左上角 | 右下角 | 结论 |
|---|---|---|---|---|
| 中心裁剪 32×16 | 全部 32×16 | 都是 `TL` | 都是 `BR` | 位置一致 |
| 旋转 90° | 全部 64×96 | 都是 `BL` | 都是 `TR` | 尺寸与**方向**都一致 |

顺带确认了一件之前没验过的事：`vips rot d90`、`magick -rotate 90`、`image::rotate90()`
**三个实现的方向是一致的**（都是顺时针）。这句话此前只是"看起来应该一样"。

#### 途中撞到的一个编码差异（不是缺陷，但值得记）

比对的第一次运行**四条断言全红**，报"解码失败" —— 而**像素其实是一致的**。
原因是三个后端编出来的 PNG **色彩类型各不相同**：

| 后端 | colorType | 说明 |
|---|---|---|
| libvips | **2**（RGB） | 直接真彩色 |
| 纯 Rust `image` crate | **6**（RGBA） | 总是带 alpha 通道 |
| ImageMagick | **3**（调色板，位深 2） | 它发现只有 4 种颜色，就转成了调色板 PNG |

而 `cdp.mjs::decodePng` 当时只认 colorType 2 与 6，对调色板**返回 null**
（那是刻意的：不认识的编码宁可拒绝，也不猜像素）。于是"拒绝读一个合法编码"
把"一致"误报成了"不一致"。

**修法**：给解码器补上调色板支持（位深 1/2/4/8 + `tRNS`），
并把 `compare()` 改成比**颜色三元组**而不是比字节 ——
通道数是**编码**差异，这一节要钉的是**几何**差异，两者不能混。
（顺带把看到的色彩类型打出来，免得读的人以为三者产出的字节应该一样。）

> 教训与 §3.24 那次同源：**验证工具的失败会长成"结论"的样子**。
> 四条红断言看着像"三个后端不一致"，实际是"工具读不懂其中一种合法编码"。
> 差别在于这次留下的是**误报**，而误报的代价在这个项目里被反复强调过 ——
> 它会让一条检查被当成噪音关掉。


### 4. ~~许可证确认：闸门已经有了，记录仍然没有~~ → 见 §3.8（记录已补上）

- `crates/toolforge-core/src/engine.rs` 里为每个引擎与模型都提供了 `license`、`license_note`、`requires_license_ack`，并且有测试在守护这些字段非空。
- ⚠️ **本条原文（"registry.rs 对 `requires_license_ack` 零引用——没有任何安装前确认流程"）已经过期**。闸门**已经接上了**，只是位置不在 `registry.rs`，而在**命令层**（`apps/desktop/src-tauri/src/commands.rs`）：
  * `engines_install`：`if descriptor.requires_license_ack && !license_accepted { return Err(denied) }`，注释写的是"许可证确认是硬门：不能靠前端自觉"；
  * `models_install`：模型那边更严 —— `if !spec.commercial_use && !license_accepted { … }`（不可商用的权重**必须**逐次确认，与 `requires_license_ack` 无关）。
- **为什么放在命令层而不是 `registry.rs`**：那道门的目的是"挡住一个被攻陷/越权的前端悄悄装东西"，属于**宿主边界**；`EngineRegistry::install()` 是宿主内部 API，调用它的人已经在门内了（`engines:install` 那个 CLI 也是用户自己的 shell）。
  **代价要说清楚**：这意味着"任何人只要拿到 `EngineRegistry` 就能绕过确认"——将来新增调用方时**必须自己记得传 `license_accepted`**。目前没有第二条调用路径（一条命令 + 一个 CLI），所以没有实际缺口，但这是一条靠纪律维持的不变量，不是靠类型系统。
- ~~**仍然没做的那一半**：确认结果**没有落盘**。没有审计事件、没有"我已确认过 X 的许可证"的持久记录，所以每次重装都要重新勾一次（对合规审查来说也拿不出证据链）。这一条保持不变，仍是 v0.2 的事。~~
  > ✅ **已补上（见 §3.8）**：`license-acks.json` + `LicenseAccepted` 审计事件 + 界面预先勾上。留在这里是为了保留"当时确实没有"这个事实。
- 另有一处**语义**要对齐：`requires_license_ack` 是"装之前要确认"，而 `commercial_use == false` 是"不许商用"。两者混在一个 `license_accepted` 标志上，对**不可商用**的模型来说，勾一次框并不能让它变得可商用 —— UI 文案必须说清这个区别（见 `docs/ENGINE-MATRIX.md` 的模型表）。

### 5. `package.json` 的 `bindings` 脚本指向不存在的包名 ✅ 已修复

- 原内容：`cargo run -p toolforge-desktop --bin export-bindings`
- 但 `apps/desktop/src-tauri/Cargo.toml` 的包名是 **`toolforge`**。
- 已改为 `cargo run -p toolforge --bin export-bindings`，与
  `src/bin/export_bindings.rs` 的文档注释一致（说明是 `package.json` 一侧写错了）。
- **实测**：`cargo run -p toolforge --bin export-bindings` 成功导出 29 个命令的绑定（**历史值**：加上后来的 `models_list` / `models_install` / `models_remove` 三条，现在是 32 个）。

### 6. 其它已核实的零散不一致

| 编号 | 位置 | 问题 |
| --- | --- | --- |
| 6a | 根 `Cargo.toml` 注释 | 写着「所有导出类型都收敛在 `apps/desktop/src-tauri/src/bindings.rs`」，但该文件**不存在**；实现上 `specta_builder()` 在 `src-tauri/src/lib.rs`，导出产物是前端 `bindings.ts` |
| 6b | `package.json` 的 `icons` | 末尾引用 `./assets/icon-source.png`，而 `assets/` 目录不存在 |
| 6c | `plugins/python-example/plugin.yaml:3` | 引用 `docs/PLUGIN-SDK.md`，该文档不存在 |
| 6d | `crates/toolforge-process/src/lib.rs:24` | 引用 `docs/SECURITY.md`，该文档不存在 |
| 6e | `docs/ENGINE-MATRIX.md` §1.2 | 自述为「某一时刻的快照」且**已经过期**：它称 `toolforge-plugins` 只有 `Cargo.toml`+`lib.rs`+`audit.rs`、`toolforge-ai` 未落地、`toolforge-core` 有 12 个源文件；实际分别是 7 个 `.rs`、3 个 `.rs`、11 个 `.rs` |
| 6f | `crates/toolforge-plugins/src/runtimes/wasm.rs` | 注释明确：**v0.1 不注入任何自定义宿主函数**，`allowHostFunctions`（`log`/`kv`）只做校验；`log` 靠 Extism 内置 `extism_log_*` 转到 `tracing`，**KV 推迟到 v0.2**。所以「L2 的 log/kv 白名单已落地」应理解为「校验已落地、注入未落地」 |
| 6g | `crates/toolforge-plugins/src/runtimes/python.rs:189` | `handle_notification` 的 `progress` 分支**只读 `value` 与 `stage`**，把 `currentItem` / `speed` / `etaSeconds` 一律传 `None`；插件即使上报了这三个字段也会被静默丢弃。`host.request` 通知被**明确拒绝**（只记一条 warn）——后者是刻意的安全设计（运行期提权是点击劫持的经典入口），前者是待补齐的能力 |
| 6h | `crates/toolforge-plugins/src/runtimes.rs` 模块文档 | L3 的隔离度自述为「清空继承环境变量（只留 PATH）+ 锁定 cwd + 默认断网 + 超时 + 优雅关闭」，并**主动声明这不是内核级沙箱**：蓄意插件可直接用 `socket` 绕过代理环境变量。真正的隔离（Windows Job Object / AppContainer、macOS `sandbox-exec`、Linux seccomp）留给后续阶段。UI 与文档**不得**把 L3 称为「沙箱」 |
| 6i | `crates/toolforge-core/src/pipeline.rs:149` | 未知节点的校验错误信息指向 `docs/ENGINE-MATRIX.md`（该文档存在），而 `nodes.rs` 的 `not_implemented` 指向 `docs/ROADMAP.md`（本文件）——两处进度指引指向不同文档，建议统一 |

### 7. 本轮补齐节点之后的开放项（老实列出来）

"32 个节点都有执行器"是一句真的话，但它不等于"每一件想做的事都做完了"。下面是**真正还欠着的东西**，按"用户会不会碰上"排序：

| # | 开放项 | 现状与影响 | 这不是什么 |
| --- | --- | --- | --- |
| 1 | ~~**`realesrgan-x4plus` 的固定输入尺寸支持**~~ **已做** | 原文：「它的 ONNX 导出输入尺寸固定（64×64 或 128×128），要跑通必须先补上「补齐到固定尺寸 → 推理 → 裁回去」，否则边缘块会留下**网格状接缝**。所以它**故意没有下载源**……要做的顺序：补逻辑 → 重跑接缝检查 → 真实下载后填哈希」。**三件事都做完了**：① 补齐 + 裁切逻辑在 `py/upscale.py` 里（读会话输入形状，固定尺寸时 `np.pad(mode="edge")` 补到 256×256 再裁回）；② 新增**接缝指标** `seamRatioX/Y`，并配了两条反证把它变成"可证伪的"（见下）；③ 填入真实下载的哈希（`279da294…`，66,993,533 字节，来自 AXERA-TECH/Real-ESRGAN 的 `realesrgan-x4-256.onnx`，用 onnxruntime 读过形状确认是 `[1,3,256,256] → [1,3,1024,1024]`）。**真机实测**：700×500 的图 → 2800×2000、9 块、日志写明"权重输入尺寸固定，已按边缘像素补齐再裁回"、无未覆盖像素 | 不是"哈希没核对"—— 另外两个没有下载源的抠图模型（`birefnet-general` / `modnet-portrait`）才是这个原因。**接缝指标那一段值得单说**：第一版拿"边界跳变 ÷ 全图中位数跳变"当指标，在真实图上报 3.53（看着像有接缝，其实是椭圆硬边造成的），而且故意错位之后纹丝不动；第二版改成"边界 ÷ **紧邻几行/列**"并在 `np.diff` 的下标上修了一个 off-by-one（`per_line[s]` 查的是块**内部**，边界在 `s-1`）。现在正常 3.7/2.4、错位 10.6/15.1，另有一条**独立信号**：错位会让 `uncoveredRatio` 从 0 变成 8.5% |
| 2 | **`image.enhance` / `image.strip-metadata` 仍然只有纯 Rust 一条路** | 它们**不问引擎**、不调用 `pick_image_backend()`、不产出 `backend`，所以装了 libvips 也不会更快。两者本身是**刻意**的（内置卷积与"解码再编码"都能干这个活），有问题的只是它们曾经声明了引擎依赖 —— **那部分已经撤掉**，界面不再宣称"装了引擎会更快" | 不是降级链的问题：降级链只覆盖 `image.convert` / `image.resize` / `image.crop` / `image.rotate` 四个节点。要不要给这两个节点接外部后端，是**独立的性能议题**，不是缺陷 |
| 3 | ~~**`doc.ocr` 的 PDF 栅格化**~~ **已做** | 原文：「PDF 输入现在被**明确拒绝**（要按页转图片，需要 pdfium / poppler）。报错文案清楚，但功能确实没有」。**现在补上了**：新增 `poppler` 引擎（Windows 一键下载 41.7 MB + 校验哈希；macOS/Linux 走系统包管理器），`doc.ocr` 用 `pdftoppm -png -r <dpi>` 逐页栅格化后逐页识别，多页之间用 `===== 第 N 页 =====` 分隔。没装 Poppler 时仍然明确拒绝，并给出两条出路。**真机实测**：手写的 3 页 PDF 在 100 DPI 下渲染出 584×278 像素（预期 583×278±2），假 AI 端点收到 **3 次**请求，输出里 3 个页码标记与 3 次请求序号都在 —— 见 `verify-platform.mjs`【15】 | 不是"忘了处理"—— 拒绝曾经是刻意的：产出一堆乱码比报错糟得多。现在有了栅格化器，这个取舍就不存在了 |
| 4 | ~~**`ebook.convert` 在两个可选引擎都没有时的 UI 提示**~~ **已修** | 原文：「运行期会返回明确的 `EngineMissing`，但**节点可用性判定仍只看 `requiresEngines`**，所以这种机器上它依旧显示"可用"」。**现在可用性判定会看"这一组里至少有一个"了**：新增 `NODE_AVAILABILITY_RULES`（`pipeline.rs`），`ebook.convert` 的析取组是 `calibre` 或 `pandoc`、`doc.ocr` 的是 `tesseract` 或 `ai-provider`（**poppler 刻意不在里面** —— 它只管 PDF 栅格化，写进去会让"装了 poppler 但没有识别引擎"的机器又显示成可用）。顺带修掉同一类问题的另一个版本：`ai.upscale` 依赖 `onnx-models`，而那个虚拟引擎的判据是"下过**至少一个**权重" —— 只下了抠图权重的机器上超分节点也显示可用。现在按**权重自己的 `used_by`** 算（`ModelSpec` 新增 `used_by` 字段）。**真机验收**：`verify-platform.mjs`【16】逐个核对 32 个节点的"可用"与真实引擎/权重状态是否一致 | 不是安全问题，是**知情时机的落差**：用户点下去才知道要装东西 |
| 5 | ~~**`doc.ocr` 的参数枚举与执行器对不上**~~ **已修** | 枚举原为 `auto` / `tesseract` / `paddleocr`，执行器认 `auto` / `tesseract` / `ai`。填 `ai` 有效但不在下拉里；填 `paddleocr` 能选中却走到"两者都不满足"的分支。**已把枚举改成 `ai` 并把 PaddleOCR 文案删掉** | 这是一类值得记的漂移：**参数名对了但取值对不上**，比参数名写错更难发现 —— 界面照常显示、执行器照常运行，只有结果不符合预期 |
| 6 | ~~**`doc.ocr` 的可用性判定严于实现**~~ **已修** | 原来 `requiresEngines` 是 `["python"]`，缺 Python 时整个节点被标灰；但 tesseract 那条路根本不碰 Python。**已改为 `requiresEngines: []` + `optionalEngines: ["tesseract", "ai-provider"]`** | 正是"能用却显示不可用"（这个项目在 `onnx-models` 上踩过反方向的坑） |
| 7 | ~~**`doc.ocr` 的 AI 路径没有声明 `ai-provider`**~~ **已修** | 现在 `doc.ocr` 的 `optionalEngines` 含 `ai-provider`，`ai-provider.provides` 也含 `doc.ocr`，两个方向都对齐 | 同第 6 条，一并由 `provides_matches_node_declarations` 这条双向测试守住 |
| 8 | ~~**ImageMagick 档位与 macOS 没有环境基线**~~ → **ImageMagick 档位已关闭，macOS 仍然开着** | 原文：「"只有 ImageMagick 可用"这一档从未被单独测过（本机没装 ImageMagick）。本轮补齐了它的 **Windows 下载源**，并**直接执行**验证了原本有风险的四点（哈希、`tar` 能解 7z、`magick.exe` 可运行、包内无顶层目录 —— 见 §3），但**应用内的安装链路未复验**，所以这一档现在是"可装"，仍不是"测过"」。**现在三件事都做完了**：应用内安装成功（241.5 MB 的 `magick.exe`，版本 7.1.2-31 Q16 x64）、中间档实测走通（藏掉 `engines/libvips` → 后端日志 = ImageMagick（格式最全）、产出有损 VP8 WebP）、`verify-platform.mjs`【12】把这一步固化成检查。**三档现在都有证据：libvips ✓、ImageMagick ✓、纯 Rust ✓。** ⚠️ **macOS 那半条仍然成立**：四条下载源（ffmpeg / libvips / pandoc / python）的 `sha256` 仍是 `null`（没有 macOS 环境核对哈希） | ImageMagick 部分已关闭；macOS 部分仍是"不是没实现，缺的是验证记录" |
| 9 | **验证脚本的覆盖面仍然是"我们可控的那部分"** | `ai.describe` 用假端点验证请求形状（这是对的，真模型不可复现、要花钱），但它**验不了**"模型答得好不好"；同理【11】验的是倍数与尺寸，不是超分画质 | 这是**刻意的边界**，不是疏漏。写清楚是为了避免有人把"82 项全通过"读成"AI 能力已经验收" |

> **一句话总结这一轮**：节点的账已经平了（32/32，`UNIMPLEMENTED_NODES` 为空）。上面这 9 条里，第 2、5、6、7 条都属于**"声明与实现 / UI 之间的小漂移"**，现已全部修掉（5/6/7 是同一类：`doc.ocr` 的声明；2 是 `provides` ↔ 节点声明那 5 处），并且由双向测试守着 —— 这类问题不会让构建变红，只会让用户在看到真实行为时感到意外，比"缺一个功能"更难发现，所以专门列在这里而不是埋进正文。剩下的三类是：**真的还没做**（1 的固定尺寸补边、3 的 PDF 栅格化）、**知情时机**（4）、**还没有验证记录**（8 只剩 macOS 那一半、9 的验证覆盖面边界）—— 第 8 条的 ImageMagick 半边已随本轮真机验证关闭。

---

## v0.1 —— 骨架可运行

**主题**：把领域层修到可用，把外壳与最小可用链路打通。目标是「一个能装插件、能跑任务、能看进度、能取消的桌面程序」，而不是「功能最多」。

> 现状：五个 Rust crate 的骨架**都已写出**，但**没有任何一条端到端可运行路径**——`toolforge-core` 编译不过、前端工程不存在、`pnpm` 侧脚本全部无法解析。
>
> ⚠️ **上面这段"现状"已经过期，保留作为历史**。并且本节下面的清单在很长一段时间里**严重滞后**：
> 一大批早就做完的事还挂着 🚧，读起来像是"前端工程不存在、队列没接线、权限门没打通"。
> 本轮（2026）**逐条对着代码与真机结果重新核了一遍**，做完的都改成 ✅ 并附上证据；
> 只有真的还没做的才留 🚧。判断依据是"能在本机跑出来"（测试名 / 命令 / 检查编号），不是"看起来应该有"。

### 可交付能力清单

**领域层（`toolforge-core`）**

- [x] ✅ 关闭「当前阻塞项」1–4，`toolforge-core` 可编译 —— **实测** `cargo test -p toolforge-core` = **97 passed / 0 failed**
- [x] ✅ `cargo test -p toolforge-core` 全绿（61 是当年的快照值，现在是 **97**；全仓 **282**）
- [x] ✅ 11 个模块骨架完成：`error` / `ids` / `permission` / `plugin` / `pipeline` / `job` / `engine` / `queue` / `events` / `paths` + `lib.rs`
- [x] ✅ 修正不一致 6i：把"未知节点"的指引从 `ENGINE-MATRIX.md` 改到 **`PLUGIN-SDK.md` 的节点表**（那是插件作者的契约，且有一道机械对账 —— 【23】）；"已登记但没实现"那条仍指 ROADMAP 的实现进度。两者**各指其位**，不再是一句含糊的"指向不同文档"

**进程层（`toolforge-process`）**

- [x] ✅ 骨架完成：`exec`（含 `exec_streaming`、输出上限裁剪、Windows `CREATE_NO_WINDOW`、Unix 进程组分离）与 `rpc`（JSON-RPC 2.0 按行分帧）与 `supervisor`（常驻子进程监督管理器）
- [x] ✅ 用真实子进程打通端到端 RPC 往返 —— 两条独立证据：① `rpc` 的单测覆盖请求 / 响应 / 通知三态与错误对象；② **L3 Python 运行时本身就是一条真实往返**（宿主 spawn `python -u`，按行发 JSON-RPC、收响应、处理 `progress` / `log` 通知），由 `verify-runtimes.mjs` 真的建 venv、真的跑通
- [x] ✅ 取消路径可验证 —— `exec::tests::cancel_token_kills_process`；真机层面【21】用 LibreOffice（会派生子进程的那种）验证"取消后没有孤儿 `soffice.bin`"，并单独探了 200/500/1500/3000 ms 四个取消时机
- [x] ✅ **管道死锁回归测试**（本轮补上 —— 此前只有一句注释声称"不会死锁"）：`stderr_flood_does_not_deadlock` 让**测试二进制自己**当那个往 stderr 狂写 20 万行（约 14 MB）的子进程，断言它**跑得完**、尾部保留完成标记、输出被截断。★ 另配一条**反证** `naive_sequential_read_would_deadlock_on_the_same_child`：用不经过 `exec` 的裸 tokio 顺序读同一个子进程，断言它**确实会卡住** —— 少了这条反证，"没死锁"可能只是因为子进程写得太少，那就成了一条永远绿的测试
**外壳与前端**

- [x] ✅ `apps/desktop/src-tauri` 骨架完成：配置层 + `main.rs` / `lib.rs`（`COMMAND_NAMES` + `specta_builder()`）/ `commands.rs` / `ipc.rs` / `state.rs` / `bin/export_bindings.rs`
- [x] ✅ `apps/desktop` 前端工程建立 —— **实测**（读 `apps/desktop/package.json`）：包名 `@toolforge/desktop`，react **18.3.1**、vite **5.4.21**、typescript **5.9.3**、tailwindcss **3.4.19**、zustand **5.0.15**、@tanstack/react-query **5.103.3**、@xyflow/react **12.12.0**、framer-motion **13.4.4**、lucide-react。`strict` 已在 `tsconfig.json` 打开，`pnpm typecheck` 是 `check:web` 的第一步
- [x] ✅ 前端壳：**9 个视图**（不止要求的三个）—— `dashboard` / `plugins` / `jobs` / `pipeline` / `convert` / `image` / `batch` / `ai` / `settings`，每个一个 `features/<名>/<名>-page.tsx`。**实测**：`smoke.mjs` 逐个路由走一遍并断言页面挂载（9 条），【0】还额外自检了"页面上没有上一次运行的残留注入"
- [x] ✅ `pnpm bindings` 可用 —— 生成的 `apps/desktop/src/bindings.ts`（约 86 KB）**已入库**。另外本轮**删掉了启动时那段"顺手再生成一次"的代码**：它会在每次启动时用**编译期快照**覆盖掉刚生成的新绑定（详见 `docs/ARCHITECTURE.md` 的"绑定的唯一写入者"一节）。现在唯一的写入者是 `cargo run -p toolforge --bin export-bindings`
- [x] ✅ `COMMAND_NAMES` 与 `collect_commands!` 的一致性自检在 CI 生效 —— 守卫生在 `apps/desktop/src-tauri/src/bin/export_bindings.rs` 的**守卫 2**：逐条核对每个名字是否出现在生成的绑定里，再核对数量。CI 的 `bindings` job 跑它并 `git diff --exit-code apps/desktop/src/bindings.ts`，所以"改了 Rust 类型没重新生成"和"注册了命令没登记名字"两种漂移都会变红
- [x] ✅ 补 `assets/icon-source.png`，使 `pnpm icons` 全链路成功 —— 文件 310,673 字节；**本轮实测** `pnpm icons` **退出码 0**（修复前它是**必失败**的，见 §3.23）。连续跑两次产出**逐字节相同**，所以它不会每次跑都脏工作区
- [x] ✅ **设置已持久化**（新模块 `apps/desktop/src-tauri/src/settings_store.rs`）：非机密设置写 `<data_dir>/settings.json`，**原子写**（同目录临时文件 + `rename` + `sync_all` —— 直接截断重写的话，写到一半断电就留下半截 JSON，用户全部设置一次性丢失）；解析失败的文件被**隔离**成 `settings.broken.json` 并回退默认值（**启动绝不因为坏设置文件而失败**，否则用户连能修它的界面都进不去）；缺字段按**字段级**默认值补齐，旧配置继续可用。API Key **不在这个文件里**（它默认只在内存，只有用户显式打开 `ai.persistApiKey`——默认 `false`——时才**明文**写到 `<data_dir>/ai-key.txt`，关掉开关即删除该文件；OS 钥匙串仍未实现。详见 `docs/SECURITY.md` 的凭据落盘一节）；`paths.rs` 新增 `settings_file()` / `ai_key_file()` / `settings_backup_file()`。
  - 这条是**补债**：设置页原本写着「所有设置都会立即写入本机配置文件」，而 `AppState.settings` **只在内存里** —— 界面上写了一句假话，关掉应用设置就没了。

**引擎与图片**

- [x] ✅ 骨架完成：`EngineRegistry` 探测（`probe` / `probe_all` / `system_binary` / `resolve`）、按需下载（`download_to` / `install`）、SHA-256 比对、模型注册（`install_model`）
- [x] ✅ 纯 Rust 图片转换端到端可用 —— 7 个节点**现在各有真机检查**：`image.probe` 走内置 `video-to-gif`（【14】，那是唯一用到它的真实流水线）；`image.convert` / `image.resize` 走【6】（三层降级）、【12】（中间档）、【13】（兜底档）、【22】（画布产物）；`image.enhance` / `image.strip-metadata` 由**本轮新增的【31】**按像素验证（10 条）；`image.crop` / `image.rotate` 由**本轮新增的【32】**按像素验证（16 条）。此前 `crop` 与 `rotate` 在**整个仓库里一次都没被真的执行过** —— 见到过它们的地方只有节点声明、注释、和一句"能力边界已记录"的假检查（详见 §3.23）
- [x] ✅ 引擎探测结果可从前端触发并展示 —— 引擎管理页调 `engines_catalog` / `engines_probe`；DevTools 侧在多节里真的走了这条 IPC（【6】、【7】、【12】、【16】、以及【16】的"节点可用性判定与真实引擎/权重状态是否一致"）
- [x] ✅ **处理不一致 2（已完成）**：`image.convert` / `image.resize` / `image.crop` / `image.rotate` **已经真的调用** libvips / ImageMagick（`pick_image_backend()`，输出里报 `backend`），不再是"声明了但从不使用"。
  - 声明侧的 5 处漂移也全部修好：撤掉 `libvips.provides` 里的 `image.enhance` / `image.strip-metadata`、撤掉 `imagemagick.provides` 里的 `image.strip-metadata`、补上两个引擎都缺的 `image.crop` / `image.rotate`、撤掉 `python.provides` 里不该有的 `doc.ocr`、补上 `ai-provider.provides` 该有的 `doc.ocr`。
  - 新增双向守卫测试 `provides_matches_node_declarations` 并做过反证。见 `docs/ENGINE-MATRIX.md` 第 6.2 节。

**插件（仅内置示例）**

- [x] ✅ 骨架完成：`PluginStore`（`reload` / `list` / `get` / `install` / `uninstall` / `set_enabled` / `set_granted` / `verify_integrity` / `quarantine_if_changed`）、`l1::run_pipeline`、`AuditLog`
- [x] ✅ 6 个示例插件的 `plugin.yaml` 已就位
- [x] ✅ 装载示例插件并跑通一次真实流水线 —— 7 个内置示例里的 `image-convert` / `batch-rename` / `video-to-gif` / `remove-bg` 都已在真机上跑通（`scripts/devtools/verify-platform.mjs` 的【1】、【6】、【8】），本轮又补上了 `ebook-convert` / `ai-describe` / `image-upscale`（【9】、【10】、【11】）。
- [x] ✅ 权限声明 → 待授权列表 → 逐条授权的数据流打通 —— 前端 `components/plugins/permission-gate.tsx` + `plugins_grant`；**实测**在【26】"能力清单：前端能直接调什么，被拒的又是不是真的被拒"与【29】"许可证勾选框的点击穿透"两节里走通（后者专门验证"前端不会替用户点头"）
- [x] ✅ 用未实现节点时给出**可读且可操作**的错误，而不是内部错误码裸抛
  - ✅ **已结案**：批量循环那条支路（`flow.foreach`）彻底消失了 —— 节点被删除，
    引用它的清单在校验阶段就报 `STEP_UNKNOWN_NODE`，根本走不到运行时。
    **名单（`UNIMPLEMENTED_NODES`）现在是空的**，所以这条兜底错误只剩"节点名拼错"一种成因，
    而它会把两种处境分开说（"名字不在目录里" vs "在目录里但没实现"）。错误文案依然指向本文档。

**任务中心**

- [x] ✅ 任务创建、排队、执行、进度上报、取消（对应 `job` / `queue` / `events`）—— `jobs_*` 命令 + `JobQueue::gate` 限并发；**实测**在【1】（真实改名任务）、【14】（多步模板）、【21】（取消）里跑通
- [x] ✅ 进度条与取消按钮可用，事件从后端推送到前端 —— `components/jobs/job-progress.tsx` / `job-card.tsx` / `job-log-viewer.tsx` / `jobs-status-pill.tsx`；取消那条由【21】验证到底：**子进程真的被杀掉、队列记账对得上、没有孤儿 `soffice.bin`**
- [x] ✅ 任务失败时给出可读错误（模块 + 代码 + 信息），不吞异常 —— 实测反例最多的一节是【9】"电子书转换的降级与拦截"：pandoc 写不出某个格式时会**假成功**（生成一个扩展名骗人的 HTML），所以那里专门验了"该拒的真的拒"；本轮又给 `not_implemented()` 把两种处境分开说（名字不在目录里 vs 在目录里但没实现）

**工程基线**

- [x] ✅ `.gitignore` 已就绪（含前端口径：`bindings.ts` 要入库）
- [x] ✅ `scripts/env.ps1`、`scripts/gen-icon.mjs` 已存在
- [x] ✅ 补 `scripts/enginectl.mjs`（`package.json` 已引用；`list` 只读打印引擎目录 + 来源表状态，`install` 打印实际哈希）。**本机实测**（`node scripts/enginectl.mjs list`，退出码 0）：12 个引擎的"安装方式 / 核心 / 许可证 / 需确认许可证 / 下载源"五列全部打印出来，并会**主动警告**"`engine-sources.json` 里有 N 条下载源没有 sha256"（当前 N = 1，即 `ffmpeg@macos`）—— 它不会假装全部就绪。
- [x] ✅ CI 基线：`cargo clippy --workspace --all-targets -- -D warnings` **已成为 CI 的一个 job，且本机实测全绿**（见 §3.14 —— 它此前是**红的**，而本地四道检查里没有它，所以一直没被发现）。
- [x] ✅ `cargo fmt --all --check`：**已全仓重排并接进检查链**（30 个文件、纯机械改动；`pnpm check:fmt` + CI 各一步，见 §3.20）。
- [x] ✅ `pnpm check:rust` / `check:web` / `check:all` 可执行 —— **实测** `check:all` 退出码 0（链路是 `check:encodings → check:rust → check:clippy → check:fmt → check:web`）。本轮补了两处：`check:rust` 加上 `--locked`（此前只有 `check:clippy` 有，于是"本地全绿、CI 因为 Cargo.lock 过期而红"这种事是可以发生的），以及 `check:all` 纳入新写的 `check:encodings`
- [x] ✅ `README.md` 更新为 ToolForge 架构说明 —— 37 KB，含能力边界与"验不了什么"的清单
- [x] ✅ 补 `docs/SECURITY.md` 与 `docs/PLUGIN-SDK.md` —— 122 KB / 74 KB。**PLUGIN-SDK 的节点表有机械对账**（【23】比对 `PLUGIN-SDK.md` 的节点表与 `builtin_nodes()`）；⚠️ 但它的**第 3.5 节"产出值"表没有**，本轮就发现了那里的 `image.rotate` 写着会产出 `width`/`height`（实际只产出 `backend`），已改正并把补齐对账列为待办

### 验收标准

1. `cargo test --workspace` 全绿，且 `cargo test -p toolforge-core` 恰好 **61 个测试通过、0 失败**。
   > 注：61 是**写这一条时的目标/快照值**。当前 `cargo test --workspace --locked` 合计 **286 passed / 0 failed**；分 crate 的逐项数字本文档不再维护（维护它只会制造又一处会漂移的常量）。
2. `cargo clippy --workspace --all-targets -- -D warnings` 无输出（零告警）。**当前实测：全绿**（§3.14 修掉了最后 13 处）。
   `cargo fmt --all --check` **也已经是干净的**，并已接进 `pnpm check:all` 与 CI（§3.20）—— 这条验收标准现在是**可失败的**，不再是一句空话。
3. `cargo check --workspace --all-targets` 成功（即 `pnpm check:rust` 通过），且 `Cargo.lock` 已生成并入库。
4. `pnpm check:all` 退出码为 0。
5. `pnpm bindings` 成功生成 `bindings.ts`；**连续执行两次，第二次后 `git status` 为干净**（生成结果稳定、且文件已入库）。
6. **可复现的最小闭环**：启动 `pnpm tauri:dev` 后，导入一张 PNG，执行「转 JPEG + 缩放到指定宽度」，任务出现在任务中心、进度推进到 100%、输出文件存在于目标目录。
7. **取消可验证**：对一张大图发起任务后立刻取消，任务状态在 2 秒内变为「已取消」，且目标目录**不留下**半个输出文件（临时文件被清理）。
8. **不依赖外部二进制**：在未安装 ImageMagick / libvips / ffmpeg 的干净机器上，第 6 条闭环仍然成功（纯 Rust 路径打底）。
9. **错误可读**：人为传入不存在的输入路径，前端展示的错误包含模块名与错误码，而不是 `undefined` 或裸 panic。
10. **未实现节点诚实报错** ✅ **已达成并已无对象**：`UNIMPLEMENTED_NODES` 现在是空数组，所以"内置节点尚未实现"这条错误**只剩"节点名拼错"一种成因**，而且它会明确区分"名字不在目录里（多半拼错了）"与"在目录里但还没实现"。这条验收用例因此不再需要拿某个节点当例子。
    > 注：这条原本用 `flow.foreach` 举例。那个节点**已被删除**，现在引用它的清单在校验阶段就报 `STEP_UNKNOWN_NODE`（更早、更彻底）。
    > **注意别再举 `image.remove-background` 或 `ai.upscale` / `doc.ocr` / `ai.describe` / `ebook.convert` 当反例** —— 它们全部已经实现（见「AI 媒体能力」）。
11. **L1 示例可跑**：`plugins/builtin/image-convert` 与 `plugins/builtin/video-to-gif` 在节点目录范围内能完整执行并产出文件（后者需 ffmpeg；无 ffmpeg 时给出可操作的安装提示）。**32 个节点都有执行器**，所以这条不再有"撞到未实现节点"的可能。
12. **权限门可见**：示例插件的全部能力声明能在 UI 列出，未授权能力被执行时被拒绝并给出具体原因。
13. `pnpm icons` 全链路成功（`assets/icon-source.png` 存在）。✅ **本轮才成立**：此前这条**必失败**（`tauri icon` 的工作目录是 `apps/desktop`，而脚本给的是仓库根相对路径 `./assets/…`，报 `os error 3`）。修好后实测退出码 0，且两次产出逐字节相同 —— 见 §3.23 第 (4) 条。

---

## v0.2 —— 引擎与三级运行时落地

**主题**：把「只有纯 Rust 能干活」升级为「三种插件运行时真的跑起来 + 外部引擎真的能装上」，并把权限从「能显示」升级为「能强制」。

> 现状：三个运行时的**代码骨架都已在**（`runtimes/wasm.rs` 已用 `with_wasi(false)` + `with_fuel_limit`，`runtimes/python.rs` 已有 venv / 断网 / 超时 / 优雅关闭），引擎注册表也有下载与校验实现；**缺的是数据回填（哈希）、许可证闸门、以及可选引擎的真实调用**。

### 可交付能力清单

**引擎层**

- [x] ✅ 骨架完成：`engine-sources.json`（12 条候选源）、`EngineRegistry::install` / `download_to` / `install_model`、SHA-256 比对、`system_binary` 探测
- [x] ✅ **一键安装引擎已端到端跑通（不再是"代码写完但没人试过"）**：通过应用真实安装 **libvips 8.18.6** —— 下载约 30 MB → SHA-256 校验 → 解压 → 探测为 `installed`，落在 `<data_dir>/engines/libvips/bin/vips.exe`，约 29.67 MB。**它跑通之前这条路径是坏的**（裸命令名 `tar` 不查 PATH，见阻塞 14），所以这个 ✅ 是靠真机跑出来的，不是靠读代码得出的。
- [ ] ⛔ 回填**全部 12 条**下载源的 `sha256`，否则 `install` 会按设计拒绝下载（不一致 3）
- [ ] 🚧 许可证闸门：把 `requires_license_ack` 接进 `install` 路径，未确认不得安装；确认结果落盘（不一致 4）
- [ ] 🚧 引擎接入：ffmpeg / pandoc / libreoffice / 7zip 已在 `nodes.rs` 中真实接线，需在真实环境逐个跑通
  > 进度：**libvips 已跑通**（一键安装成功 + 四个图像节点真实调用，见上面两条与「阻塞 14」）；**ImageMagick 现在也装过、也实测过了**（应用内安装成功 241.5 MB 的 `magick.exe`，版本 7.1.2-31 Q16 x64；藏掉 `engines/libvips` 后后端日志 = ImageMagick（格式最全）、产出有损 VP8 WebP，见 §3 与开放项 8）；**FFmpeg 也已装通并真跑过**（n8.1.3，484 MB；7 个音视频节点用 ffprobe 读回真实属性验证，见【17】）；**7-Zip 已装通**（26.03，`verify-platform.mjs`【18】用系统 tar 独立解回来逐字节比对）。
  > **剩下的一个**：`libreoffice`（约 420 MB，且只有系统安装模式）—— 它的 `doc.to-pdf` 至今没有真机基线。
  > **历史**（保留）：这一段原来写着"ffmpeg / pandoc / libreoffice / 7zip 四个必需引擎的逐个真机跑通仍未完成，且 FFmpeg 因 `www.gyan.dev` 不可达而未能完成安装" —— 那是环境问题不是代码缺陷，后来把来源换成 BtbN 的 GitHub 地址就解决了（见 §3）。
- [ ] 🚧 **真实接通图片加速链路（libvips 与 ImageMagick 都已达成，图像域那两个节点仍缺）**：`libvips` 已由 `image.convert` / `image.resize` / `image.crop` / `image.rotate` 真实调用并可在日志/节点输出里观测（`verify-platform.mjs`【6】在真机上验证），**中间档 ImageMagick 也已实测被挑中**（【12】）；仍缺的是 —— `image.enhance` / `image.strip-metadata` 不接外部后端（这是性能议题，声明侧已经不再谎称"装了会更快"）、**三档结果一致性没有测试**（见不一致 2 的更新）。
- [x] ✅ `scripts/enginectl.mjs`：`list` / `install` / `probe` 已有并实测；**`verify` 与 `clean` 本轮补齐并真机验证**（见 §3.17、§3.21）
- [ ] 🚧 离线 / 镜像源可配置（企业内网可用）

**L2 WASM 运行时**

- [x] ✅ 骨架完成：`WasmPlugin::load`（`with_wasi(false)`、`with_memory_max`、`with_fuel_limit`、入口函数存在性预检）、`fuel_for_timeout`（1e8 燃料/秒，下限 1e7）、清单内 `memoryLimitMb` → 64 KiB 页换算（钳制 1 MiB..4 GiB）
- [ ] 🚧 宿主函数白名单**真正注入**：当前 v0.1 只校验 `allowHostFunctions`（`log`/`kv`）而不注入任何自定义宿主函数（不一致 6f）
- [ ] 🚧 KV 宿主函数接入（需给 `Manifest` 配 KV store）
- [ ] 🚧 越权样本测试：尝试文件读取 / 网络访问的 WASM 插件被拒绝；耗尽燃料被 trap 且不影响宿主存活
- [ ] 🚧 `plugins/wasm-example` 打通端到端调用（`.wasm` 已构建）

**L3 Python 运行时**

- [x] ✅ 骨架完成：独立 venv（`<plugin>/.venv`）、JSON-RPC over stdio（复用 `toolforge_process::rpc`）、清空继承环境变量（只留 `PATH`）、工作目录锁定、默认断网（代理指向 `127.0.0.1:1`）、默认 300 秒超时、优雅关闭（先 `shutdown` 再关 stdin 最后 kill）
- [ ] 🚧 常驻进程复用验证：连续调用同一插件 100 次，进程数保持为 1
- [ ] 🚧 取消能真正终止正在执行的 Python 调用并回收子进程
- [ ] 🚧 **补齐进度字段**：`handle_notification` 目前丢弃 `currentItem` / `speed` / `etaSeconds`（不一致 6g）
- [ ] 🚧 依赖预装与缓存策略（当前只负责建 venv 并调 pip）
- [ ] 🚧 `plugins/python-example` 打通端到端调用（`main.py` 已在）

**权限**

- [x] ✅ 骨架完成：`PermissionSet`、`PluginRecord::effective()`（声明 ∩ 已授权）、`set_granted`、`AuditLog` 的 `record_violation` / `record_escalation` / `record_integrity`
- [ ] 🚧 权限授权 UI：逐条展示能力、逐条授权/撤销、展示授予范围与风险等级（高危能力标红）
- [ ] 🚧 运行时裁决：未授权能力在 L1/L2/L3 三处一致地被拒绝
- [ ] 🚧 路径收敛落地：文件访问被限制在授权目录内，越界被拒绝并记审计
- [ ] 🚧 扩权检测：插件升级引入新能力时必须重新确认后才可运行

**内核级隔离（L3 的诚实边界）**

- [ ] 🚧 Windows Job Object + AppContainer、macOS `sandbox-exec`、Linux seccomp 三选一先行试点（模块文档已明确 L3 **当前不是**内核级沙箱）
- [ ] 🚧 UI 与文档**不得**把 L3 称为「沙箱」——需在插件详情页如实标注隔离强度

**文件与数据安全**

- [ ] 🚧 **`fs.delete` 的回收站支持**：这个节点**曾经声明**过一个 `toTrash` 参数
  （`默认 true`、标签写着「移到回收站而非永久删除」），而执行器一行都没读它 ——
  实际一直是 `remove_file` / `remove_dir_all`。本轮把那个**假的安全网**撤掉了
  （参数删除、说明改成「永久删除，不进回收站」），但这只是把谎话改成实话，
  **能力本身仍然没有**（见 §3.24）。
  要做就得三平台一起做，不能只做一个平台：Windows `SHFileOperationW` / `IFileOperation`（COM）、
  macOS `NSFileManager.trashItemAtURL`、Linux 走 XDG trash spec（`~/.local/share/Trash`，
  还要处理跨挂载点）。这意味着引入一个依赖（如 `trash`）+ 一条**按平台分叉的测试**，
  所以它是一次独立改动，不塞进别的工作里。
  **在那之前，界面与文档一处都不许再提"回收站"。**

### 验收标准

1. `cargo test --workspace` 全绿，且 v0.1 的 61 个核心测试保持全绿（**不得回归**）。
2. **校验不可绕过**：手工篡改已下载引擎的一个字节后运行，程序拒绝执行并给出「校验失败」错误；确认后重新下载可恢复。
3. **引擎可安装**：12 条源中的每一条在 `sha256` 回填后，`install` 能成功下载、校验、落地；`sha256` 缺失时**拒绝安装**的行为有测试守护。
4. **许可证确认可验证**：在全新用户数据目录下首次安装/调用需要确认的引擎（如 ffmpeg、calibre、tesseract）前，必须出现许可证确认；拒绝确认时任务**不会**执行，且不留下部分产物；确认记录可在审计日志中查到。
5. **降级可验证**：分别测「无任何外部引擎」「仅系统安装 ImageMagick」「安装 libvips」三种环境，同一图片转换任务都能完成，输出在尺寸/通道/格式上一致（编码字节允许差异）。
   > 进度（🚧）：**三档现在都有环境基线了，而且是同一轮在本机测出来的** —— 「安装 libvips」档由 `verify-platform.mjs`【6】断言实际后端与引擎状态一致（后端 = `libvips（快、省内存）`，产出**有损 VP8**）；「仅 ImageMagick」档由【12】断言（临时藏掉 `engines/libvips` → 后端切成 `ImageMagick（格式最全）`，同样产出**有损 VP8** → `finally` 还原）；**「无任何外部引擎」档本轮由【13】补上**（把两个引擎的托管目录**都**藏起来 → 后端 = `纯 Rust image crate（零依赖，能力受限）`、任务**仍然成功**、产出**无损 VP8L**（这既是纯 Rust 后端的指纹，也是它的能力上限）、节点如实提示「只有无损模式」 → `finally` 还原，两个引擎随后都探回 `installed`）。整个脚本 **82 项全通过**。
   > 历史：这里曾写着"**三档里现在有两档有真机证据** ……**「无任何外部引擎」档仍然没有专门的环境基线** —— 纯 Rust 这条路径每个节点都在走，但「把两档都藏掉」跑一遍还没有做过"。那段现在已经过期（保留作为历史）。**"三档输出一致"也仍然没有测试** —— 三档各自走通，不等于三档的输出可比。
6. **加速链路真实可用** ✅ **已达成**：有 libvips 的环境下，`image.convert` / `image.resize` / `image.crop` / `image.rotate` 四个节点会真的走 libvips 而非纯 Rust，并**通过节点输出的 `backend` 与一条 debug 日志证实**（`verify-platform.mjs`【6】的核心断言就是"日志里写明了实际使用的图片后端"且"与引擎状态一致"；【12】进一步证实中间档 ImageMagick 也真的会被挑中）。对应「不一致 2」——✅ **已关闭**：那 5 处 `provides` 声明漂移全部改正（撤掉 libvips 多写的 `image.enhance` / `image.strip-metadata`、补上它缺的 `image.crop` / `image.rotate`、撤掉 imagemagick 多写的 `image.strip-metadata`、撤掉 `python` 多写的 `doc.ocr`、补上 `ai-provider` 缺的 `doc.ocr`），并新增双向守卫测试 `provides_matches_node_declarations` 并做过反证。`image.enhance` / `image.strip-metadata` **仍然只有纯 Rust 路径，但那是刻意的**（它们本就该是纯 Rust），而且已经不再声明任何引擎依赖 —— 所以「声明与实现不一致」这件事不存在了。
7. **L2 沙箱可验证**：尝试文件读取/网络访问的 WASM 插件被拒绝并返回明确错误；分配超限内存或耗尽燃料时被终止，宿主进程存活且后续调用正常。
8. **L2 宿主函数白名单可验证**：仅 `log` / `kv` 可调用；调用未白名单宿主函数返回「未定义函数」类错误；`allowHostFunctions` 里写其它名字在装载期即被拒绝。
9. **L3 常驻可验证**：连续调用同一 Python 插件 100 次，进程数保持为 1，总耗时显著低于 100 次冷启动。
10. **L3 取消可验证**：发起长耗时 Python 调用后取消，2 秒内 Python 子进程消失（进程列表可验证），且后续调用仍可正常执行（进程被正确重建）。
11. **L3 进度完整**：插件上报 `currentItem` / `speed` / `etaSeconds` 时，前端能收到并显示（对应不一致 6g 的关闭）。
12. **权限强制可验证**：仅授予 `fsRead` 的插件尝试写文件被拒绝；撤销授权后再次执行被拒绝；授予目录之外的文件访问被拒绝——三条均在前端可见具体原因，并都在审计日志中留痕。
13. `scripts/enginectl.mjs` 的 `list` / `install` / `verify` 三个子命令在 Windows 与 Linux 上退出码为 0，且 `engines:list` / `engines:install` / `engines:verify` 三个 npm 脚本可用。
    > 进度：`verify` 已实现并在 **Windows** 真机实测（§3.17，含失败路径：0 字节与截断各返回退出码 1）；
    > **Linux / macOS 仍未实测** —— 判据里那句"在 Windows 与 Linux 上"目前只兑现了一半。

---

## v0.5 —— AI 生成插件闭环

**主题**：让「用自然语言生成一个插件」成为一条**可审计、需人工确认**的受控流水线，并补齐重量级 AI 能力与可视化编排。

> 现状：`crates/toolforge-ai` 骨架已落地（`provider.rs` 生成 + `review.rs` 安全审核 + `lib.rs` 的提示词与 `parse_model_output` 输出解析）。架构上与设计一致：`AiDraft` 是**内存草稿、无写盘能力**，只有外壳层在用户点击安装后才交给 `PluginStore::install`；提示词强烈引导模型产出 L1。

### 可交付能力清单

**AI 生成流水线**

- [x] ✅ 骨架完成：`GenerationRequest` / `AiProviderConfig` / `ChatMessage`、系统提示词（把 32 个**真实**内置节点目录注入提示词，避免模型编造 `uses`）、`parse_model_output`（支持 `path=` 多文件代码块、裸 YAML 容错、缺 `plugin.yaml` 拒绝）
- [x] ✅ 骨架完成：`review_draft` / `SecurityReview`（能力清单 + 可疑模式 + 风险定级；需要 L3 时直接标 `Critical` 并提示逐行阅读）
- [ ] 🚧 接真实 provider 并端到端跑通一次生成
- [ ] 🚧 静态校验：schema 校验、API 版本校验、**节点白名单校验（`UNIMPLEMENTED_NODES` 现在是空的 —— 32 个节点全部有执行器，所以这条目前只挡"节点名不在目录里"，例如已被删除的 `flow.foreach`，由 `STEP_UNKNOWN_NODE` 直接拦掉）**、危险模式检测
- [ ] 🚧 权限差异检测：对比旧版本能力集合，**任何扩权都必须重新确认**
- [ ] 🚧 人工 diff 审阅：强制展示差异，未确认不得落盘
- [ ] 🚧 落盘 + 哈希锁定：生成物记录内容哈希，装载时再校验一次（`store.rs` 已有 `verify_integrity` / `quarantine_if_changed` 可复用）

**AI 媒体能力**

- [x] ✅ **AI 抠图（`image.remove-background`）—— 已实现，并已在真机上端到端验证**
  - 以前的写法是「🚧 AI 抠图（`image.remove-background`，当前 `not_implemented`）」。**这条已经不成立**：它是产品的招牌功能却长期没实现过，现在有了执行器 `image_remove_background`。
  - **执行方式**：推理**不在 Rust 里做**，而是交给一个 Python 子进程（`python` 引擎），脚本 `crates/toolforge-engines/py/rembg.py` 用 `include_str!` 编进二进制、运行时释放到 `<data>/cache/onnx-runtime/rembg.py`。**理由**：Rust 的 `ort` 会在**构建期**下载预编译原生库，那会让离线 / 内网构建直接失败 —— 一次构建失败的代价远大于多一个运行时依赖；而 L3 插件运行时本来就要求一个受管 Python。
  - **首次运行准备两件事**（都写进任务日志）：① 权重由用户自己在「模型权重」里下；② 应用在 `<data>/cache/onnx-runtime/` 下**另建独立 venv** 并 `pip install onnxruntime numpy pillow`（约 30 MB，一次性；独立 venv 是为了**不动用户自己的 Python**，卸载即删目录）。⚠️ **这一步要联网**，且**没有网络的机器在依赖就位前用不了这个节点**；此后推理全在本地、不联网、不上传图片。
  - **Python 版本区间 3.9 ~ 3.13**（`onnxruntime` 没有 3.14 的 wheel）；只有 3.14 时节点返回明确的 `EngineMissing`，让用户装应用托管的 3.11。
  - **实测数据（真机，非推断）**：托管 Python **3.11.16 / 145.2 MB / tar.gz 路径**（此前只跑过 zip 路径）；venv 自动装上 `onnxruntime-1.30.0`、`numpy-2.4.6`、`pillow-12.3.0`；对一张 **400×300**（白底 + 一个红椭圆）的测试图输出 **RGBA PNG（colorType 6）、400×300、椭圆中心 alpha 254、角落 alpha 0、前景覆盖 18.87%**（与椭圆真实面积吻合）；**运行时就绪后单张推理约 0.7 秒**（首次含 pip 约 32 秒）。
  - **测试方法上的一个坑**：**显著性模型不能用渐变图测** —— 在没有明显主体的渐变图上，模型正确报告约 0% 覆盖并让节点发一条警告。验收脚本因此改用**有真实主体**的图。
  - 参数现在是 `model` / `mode`（`alpha` | `color`）/ `background` / `threshold` / `feather`；**旧的 `alphaMatting` 已被删除**（它从登记起就没有实现，是个**假参数**）。默认模型从 `u2net`（168 MB）改成 **`u2netp`（4.4 MB）** —— "先让它跑起来"比"一上来就要下 168 MB"重要得多。
  - 真机验收落在 `verify-platform.mjs` 的**【8】号检查**（**写下这一条时**整个脚本是 **82 项检查全通过**；当前共 **401 项**，见本文档开头的「实测数据」表）。**该检查在缺权重 / 缺运行时会显式记为"跳过"而不是"通过"** —— 那些前置条件要下载，不能算进通过数。
  - **配套修掉的一个引擎层缺陷**：`probe()` 原来只对 `install_modes == [Remote]` 的引擎特判，而 `onnx-models` **没有可执行文件**（它只是权重文件的宿主），于是永远探测为 `Missing` —— 结果是这个节点**永远显示不可用，哪怕用户已经把权重下好了**。现在 `probe()` 对它单独判：**至少有一个权重已安装 = 可用**。另外 `EngineInstallRequest` 新增 **`force`** 标志 + 引擎卡片上的「另外安装应用托管版本」按钮：系统 Python 3.14 会被探到、显示可用，却跑不了 `onnxruntime` —— **"探测到可用"不等于"满足这个节点的要求"**。
- [x] ✅ **AI 超分（`ai.upscale`）—— 已实现，真机跑通**
  - 以前的写法是「🚧 AI 超分（`ai.upscale`，当前 `not_implemented`）」。它曾经是"最有可能接着做的一个"，因为可以照抄抠图那条"模型 + 推理"链 —— 这一轮正是这么做的。
  - **执行方式**：`python` + `onnx-models` 两个必需引擎，推理交给 `crates/toolforge-engines/py/upscale.py`（同样 `include_str!` 编进二进制、运行时释放到 `<data>/cache/onnx-runtime/`）。
  - **分块逻辑**：**256 px 分块、16 px 重叠、只取中心区域贴回**（`tile` / `overlap` 都是节点参数）。重叠让每块能看到周围上下文，"只取中心"让边缘不留接缝。脚本返回 `uncoveredRatio`（没有被任何一块覆盖到的像素比例），大于 `0.0001` 时节点会 warn —— 那属于**我们自己的分块 bug**，不该悄悄交付。
  - **`scale=2|3` 的语义**：模型原生只有 4 倍，所以先按 4 倍推理、再用 Lanczos 缩回去。缩回来的是**模型真算出来的细节**，比直接插值好得多。报告里 `modelScale` 恒为 4，`targetScale` 才是用户要的倍数。
  - **两个权重，都带真实下载后算出的 SHA-256**：`realesr-general-x4v3`（4.87 MB，**默认**，输入尺寸动态，单块约 26 ms）与 `realesrgan-anime6b`（18.35 MB，动漫/插画，输入尺寸同样动态）。
  - **`realesrgan-x4plus` 被有意排除**：找到的每一份 ONNX 导出都是**固定输入尺寸**（64×64 或 128×128），要跑通必须先补上「补齐到固定尺寸 → 推理 → 裁回去」，而补边质量直接决定边缘块的结果。与其先上一个会留下网格状接缝的版本，不如先把两个动态尺寸的模型做扎实 —— 这也是它**没有配下载源**（`url` / `sha256` / `file_name` 全为 `None`）而不是"哈希没核对"的原因。见下方开放项。
  - **它自己的形状自检**：`upscale.py` 要求输入 `[N,3,H,W]`、输出必须 3 通道、空间倍数必须是整数且 ≥ 2，否则报错并打印模型真实的输出形状。这段自检是被一次真实事故逼出来的（见「已知不一致」第 1 条）。
  - 真机验收落在 `verify-platform.mjs` 的**【11】号检查**（尺寸是不是真的乘了倍数），另有一条反向断言：**拿抠图权重去超分必须失败、且不在磁盘上留下文件**。
- [x] ✅ **AI 描述（`ai.describe`）—— 已实现**
  - **执行方式**：视觉模型。图片先按 `maxSide`（默认 **1024**）缩小，再在本地重新编码成 **JPEG q85**，然后以**内联 data URL** 发送。之所以要在本地重编码：**视觉计费随像素增长**，把原始 4K 图直接发出去是白花钱，而"看图说话"不需要原始分辨率。
  - **参数**：`instruction`（默认「用一句中文描述这张图片，并给出5个标签」）/ `maxTokens`（默认 512，本地也会按 `maxTokens × 4` 字符截断，防止某些端点无视它）/ `maxSide`（默认 1024，0 = 不缩）。
  - **错误说破**：服务端对纯文本模型只会回一句 400，用户完全看不出问题在模型选择上。节点在错误信息里补上「很可能是这个模型不支持图片输入」并指向「设置 → AI → 模型」。另外它**在解码图片之前**就检查 AI 是否配好 —— 先花几百毫秒解码再告诉用户"没配 Key"是没必要的等待，还会让错误看起来像图片的问题。
  - **配套示例插件** `plugins/builtin/ai-describe`（v0.1.0）：`ai.describe` → `text.replace`（把空白与标点归一成 `_`）→ `name.build` → `fs.move`，即"按图片内容重命名"。它顶部的注释如实写明**图片会上传给 AI 服务商**，并建议要完全离线就用 `image.remove-background`。插件本身**不申请 `net` 能力** —— 联网发生在宿主的节点里，不在插件进程里。
  - 真机验收落在 `verify-platform.mjs` 的**【10】号检查**：起一个**假 OpenAI 兼容端点**（`scripts/devtools/mock-openai.mjs`），把应用的 AI 设置临时指过去（provider 用 `ollama` —— 本地提供方，**不需要 API Key**），然后断言我们**自己可控**的那部分：恰好 1 次请求、恰好 1 张图、内联 data URL、MIME `image/jpeg`、体积合理（实测约 6.9 KB）、带系统提示词、用户提示词原样送达、`stream: false`，最后验证描述真的流到了下游文件名。**跑完会还原用户的 AI 设置。** 假端点**永远不会看到真实用户图片**（见 `docs/SECURITY.md`）。
- [x] ✅ **OCR（`doc.ocr`）与电子书转换（`ebook.convert`）—— 均已实现**
  - **`doc.ocr`**：有 tesseract 就用它（离线、免费、快，中文质量一般）；没有就用**多模态模型**（更强、要联网计费），日志里会写明切换了。**PDF 输入被明确拒绝** —— 要先按页栅格化成图片，这条链路没做。✅ **参数枚举与执行器已经逐字对齐**（现在是 `auto` / `tesseract` / `ai`），`requiresEngines` 也已清空、`optionalEngines` 改为 `["tesseract", "ai-provider"]` —— 三处漂移的修法见下方开放项 5 / 6 / 7。
  - **`ebook.convert`**：`calibre` 优先（**MOBI / AZW3 / LIT / PDF 只有它能写**），缺了退到 `pandoc`（EPUB / DOCX / FB2 / HTML / Markdown / RTF / ODT / TXT）。**关键点是"在调用前把关"**：pandoc 对认不出的输出扩展名**不报错**，只打一句 warning、写一个 HTML 出来、**保留原扩展名、退出码 0**；认不出输入格式时会把文件当纯文本读。所以执行器按两张能力表（`PANDOC_EBOOK_IN` / `PANDOC_EBOOK_OUT`）先检查，不通过就拒绝并要求装 Calibre。**"成功"的坏文件比失败更糟 —— 退出码在这里不可信。**
  - 真机实测：epub→docx 是真正的 `PK` magic ZIP；epub→md 中文文本完整保留；epub→mobi 且无 Calibre 时**干净拒绝、磁盘零残留**。验收落在 `verify-platform.mjs` 的**【9】号检查**。
  - 这两个引擎（tesseract / calibre）**只支持系统安装、没有配下载源**，所以 UI 只能引导用户去官网。
- [x] ✅ **模型文件管理（下载 / 校验 / IPC 部分已完成）**：`EngineRegistry.models` 以前是一张**永远空的 map**（只有 `register_model` 能填，而无人调用），于是 UI 列出 6 个模型、每次下载都答「未在注册表里登记」。现在 `EngineRegistry::new` 直接从 `engine_catalog()` 建表（"第二真相来源"已删除），新增 IPC `models_list` / `models_install` / `models_remove`；`EngineModel` 加 `file_name`（GitHub 资产名 ≠ 模型 id，如 `isnet-general` → `isnet-general-use.onnx`），文件落在 `<data_dir>/models/<model_id>/<file_name>`。
  - `u2net` / `u2netp` / `isnet-general` 三个 rembg 权重带**真实下载后算出来的** SHA-256 与固定 tag 直链（`.../rembg/releases/download/v0.0.0/`）；**哈希不匹配就删文件**（`registry.rs::install_model`，`IntegrityCheckFailed`）。
  - 单测 `verified_sources_are_pinned` 强制 url / sha256 / file_name **全有或全无**、哈希为 64 位小写十六进制、`file_name` 不重复。
- [ ] 🚧 补齐剩余 3 个模型的来源：`birefnet-general` / `modnet-portrait` / `realesrgan-x4plus` **刻意没有 url/hash**（尚未核对），UI 显示「无下载源」并把下载按钮**置灰**——宁可按钮是灰的，也不留一个"点了必然失败"的按钮。补齐必须先真实下载核对哈希。
- [ ] 🚧 模型下载的 UI 状态与「版本标识」：已装 / 未装 / 下载进度 / 许可证确认（`requiresLicenseAck` 走 `onnx-models` 引擎）。

**可视化流程编辑器**

- [ ] 🚧 基于 React Flow（`@xyflow/react`）的节点编辑器
- [ ] 🚧 节点 = 内置算子 / 插件节点；连线 = 数据流
- [x] ✅ **节点灰显机制：现在没有可灰显的节点，但机制要点保留下来**。前端仍从 IPC 的 `NodeCatalogResponse.unimplemented` 取名单（**不硬编**），所以"把未实现节点标灰并给出原因"这套 UI 逻辑**仍然存在**，只是 `UNIMPLEMENTED_NODES` 为空、它永远不会命中。**不要因为名单是空的就把这段逻辑或那个常量删掉** —— 它的用途是"下次加节点却忘了实现执行器"时立刻生效（`nodes::run` 的兜底分支、节点面板灰显、以及那条遍历真实分发表的测试会一起跟上）。
- [ ] 🚧 保存/加载流程定义，可导出为可复现的流水线描述
- [ ] 🚧 保存前校验：非法连线、缺失参数、缺失权限
- [x] ✅ **批量循环（`flow.foreach`）：结论是「不实现，改为删除节点 + 宿主展开」**
  - 选择删除而不是"留给编辑器当显式循环标记"，理由有两条：① L1 的步骤列表是**平铺的有序列表**，"对剩下的步骤循环 N 次"**没有可定义的语义**（循环体到底含哪几步？循环之后那些只想跑一次的收尾步骤怎么办？）；② 它旧描述里的「宿主会按并发度并行调度」是**假话** —— 宿主不在流水线内部调度。
  - 批量本来就该由宿主做，而且**已经做了**：`commands.rs::expand_batches` 在命令层把多文件输入与**目录输入**扇出成 N 个单文件批次，逐批调用流水线、用 `ctx.step` 上报「处理 3/12」、在批次边界检查取消；清单用 `${batch.index}`（从 1 起）取序号。**拖一个文件夹进去就是逐个处理里面每个文件**，不需要循环节点。
  - 目录展开的三条硬规则：**只展开一层**（不递归）、跳过隐藏文件（`.` 开头，含 macOS `._` 资源叉）、**上限 5000 个且超限直接报错**（`MAX_DIR_EXPANSION`，刻意不静默截断）。输入是目录时 `build_io` 用**目录自身**作授权根，不再用它的父级（以前选 `D:\照片` 会授权到 `D:\`）。
  - 引用这个节点的清单现在**校验阶段**就报 `STEP_UNKNOWN_NODE`，比"运行时报 `not_implemented`"更早、更彻底。

**批量与性能**

- [ ] 🚧 批量并发调度：并发度可配置，受队列与引擎占用约束
- [ ] 🚧 大批量吞吐目标：1000 张图片批量处理在目标机型上完成时间与内存上限明确化并达成
- [ ] 🚧 内存上限：大批量处理时进程常驻内存不超过既定阈值，无随任务数线性增长

**审计**

- [x] ✅ 骨架完成：`AuditEventKind`、按日切分的 `AuditLog`、`record_violation` / `record_escalation` / `record_integrity`、`content_hash`
- [ ] 🚧 审计覆盖到：插件装载、权限授予/撤销、AI 生成、审阅确认、任务执行、引擎调用
- [ ] 🚧 日志可导出，且不包含用户文件内容（只记路径与哈希）

### 验收标准

1. `cargo test --workspace` 全绿，且 v0.1 / v0.2 的验收用例全部继续通过（**无回归**）。
2. **生成闭环可复现**：给定同一段需求描述与固定模型版本，产出通过静态校验的插件草稿；在**未点击确认**时，磁盘上不存在该插件的最终文件（只有临时区内容）。
3. **生成不越权**：`AiDraft` 无法自行写盘——需有一个测试证明「仅生成、不确认」不会在插件目录产生任何文件。
4. **未实现节点被拦截** ✅ **已无对象（保留为护栏）**：`UNIMPLEMENTED_NODES` 是空数组，32 个节点都有执行器，所以"让 AI 生成一个用未实现节点的插件"这件事现在**在节点目录层面不可能**。护栏仍在两处：`STEP_UNKNOWN_NODE`（节点名不在目录里，例如已被删除的 `flow.foreach`）与 `examples_do_not_silently_use_unimplemented_nodes`（示例层面）。下次加节点而未实现执行器时，把名字加进名单即可让这条验收重新有对象。
   > 注：这条原本举 `flow.foreach`。该节点已**被删除**，引用它会报 `STEP_UNKNOWN_NODE`。
5. **扩权必须重新确认**：构造一个升级版本新增 `net` 能力的插件，安装时必然出现权限差异提示；拒绝后运行该插件被拒绝。
6. **哈希锁定有效**：手工修改已落盘插件的任一文件后，加载被拒绝并提示哈希不匹配（可复用 `verify_integrity` 的既有测试）。
7. **静态校验有效**：至少覆盖 5 类恶意/错误样本（超范围能力声明、未白名单节点、错误 API 版本、非法插件 id、参数缺失选项），全部在落盘前被拦截。
8. **编辑器可用**：在可视化编辑器中搭一条「缩放到 1920 宽 → 转 WebP → 输出到目录」的流程，保存后关闭并重开应用，流程可加载且执行结果与手写配置一致。
9. **编辑器诚实标注**：✅ **已无对象**（没有未实现节点可标）。机制仍在：编辑器从 `NodeCatalogResponse.unimplemented` 取名单、为空则全部可放置。已被删除的 `flow.foreach` 不需要标灰 —— 它根本不在节点目录里。
10. **批量吞吐可测**：1000 张 1–2 MP 图片的批量转换任务，在公布的目标机型与目标引擎组合下达成约定的总耗时；峰值常驻内存不超过约定阈值（数值随首次基准测试结果固化并写入本文档，见下方注）。
11. **批处理可中断且可恢复**：处理 1000 张的中途取消，已完成产物完整可用，未完成的**不留残留文件**；再次执行只处理未完成的部分，或明确说明从头开始。
12. **AI 能力可用** ✅ **已达成（抠图与超分）**：抠图与超分都已实现并真机验证 —— 抠图 400×300 测试图输出 RGBA PNG、椭圆中心 alpha 254 / 角落 0 / 前景覆盖 18.87%（与真实面积吻合），单张约 0.7 秒；超分走 Real-ESRGAN 分块推理，`verify-platform.mjs`【11】验证尺寸真的乘了倍数。抠图/超分的权重许可证经 `onnx-models` 引擎的 `requiresLicenseAck` 门确认。
    > 仍缺的：**"在至少 3 张样例上产出符合预期"这个抽样规模没有专门记录**（目前是单张测试图 + 脚本断言），以及真实的**照片**样本（渐变合成图测不出显著性模型的问题，见 `docs/ENGINE-MATRIX.md` 第 6.7 节）。
13. **审计可追溯**：在一次包含「AI 生成 → 审阅 → 授权 → 执行」的完整操作后，审计日志能按时间顺序还原全过程，且不含文件内容。

> 注：第 10 条的定量阈值属于**待固化项**——首次基准测试完成前不写死数字；测试完成后把机型、引擎版本、耗时与内存阈值一并补入本节，避免出现无法检验的目标。

---

## v1.0 —— 可分发的产品

**主题**：从「能跑」到「敢让普通用户装」。重点在分发、合规、跨平台一致性与可诊断性。

### 可交付能力清单

**分发与更新**

- [ ] 🚧 安装包：Windows（MSI/NSIS）、macOS（dmg/app）、Linux（AppImage/deb 至少一种）
- [ ] 🚧 自动更新：接入 `tauri-plugin-updater`（`Cargo.toml` 已把它声明为 `optional`，feature 名 `updater`，需在发布构建中打开并配签名私钥）
- [ ] 🚧 卸载清理：卸载时询问是否保留用户数据、`/models/`、`/engines/`
- [ ] 🚧 插件市场 / 分发格式：插件包规范冻结（含清单、哈希、签名、能力声明）
- [ ] 🚧 插件来源可信：安装前展示来源、哈希、能力清单与许可证

**许可证合规**

- [ ] ⛔ **更换 ffmpeg 构建源以去掉 GPL 组件**：当前 `engine-sources.json` 的 windows 条目备注已承认「该构建启用了 GPL 组件，闭源分发前请评估许可证」，与 LGPL 目标冲突（见不一致 3）
- [ ] 🚧 ffmpeg：采用 LGPL 构建，明确不启用 GPL 组件；随包附带许可证与对应源码获取方式
- [ ] 🚧 calibre（GPL-3.0）/ LibreOffice（MPL-2.0）：确定「不随包分发、仅探测复用」的降级策略并写入文档
- [ ] 🚧 7zip（LGPL-2.1+ 含 unRAR 限制条款）、ImageMagick（本体宽松但 delegate 可能引入 GPL）、tesseract（Apache-2.0，`tessdata` 另有许可）逐个评审
- [ ] 🚧 **模型权重的许可证单独一条链路**：`engine.rs` 已区分「代码许可 / 权重许可」（U2Net Apache-2.0 可商用、MODNet 权重为学术许可等），分发时必须逐个标注
- [ ] 🚧 全量依赖许可证清单生成（Rust crates + npm 包 + 引擎二进制 + 模型权重），CI 校验无新增不合规许可
- [ ] 🚧 应用本体许可证为 MIT（与 `Cargo.toml` 一致），第三方声明文件随包发布

**跨平台验证矩阵**

- [ ] 🚧 Windows 10/11 (x64)、macOS (Apple Silicon + Intel)、Ubuntu 22.04/24.04 (x64) 全矩阵通过
  - 注意：`engine-sources.json` 当前**没有** windows-arm64 / linux-arm64 条目，若要做 ARM 需先补数据源
- [ ] 🚧 矩阵覆盖：首启、引擎探测、引擎下载与校验、L1/L2/L3 插件各执行一次、批量任务、取消、AI 生成闭环、自动更新

**可用性与国际化**

- [ ] 🚧 键盘可达性：全部可交互控件可 Tab 到达、焦点可见、对话框焦点陷阱正确
- [ ] 🚧 屏幕阅读器：关键控件具备可读标签与状态描述
- [ ] 🚧 对比度满足 WCAG AA（正文与交互元素）
- [ ] 🚧 国际化：UI 文案外置，至少提供简体中文与英文
- [ ] 🚧 **L3 隔离强度如实标注**（沿用 v0.2 的约束）：插件详情页必须写明「进程隔离，非内核级沙箱」

**稳定性与诊断**

- [ ] 🚧 崩溃恢复：异常退出后重启能恢复队列与未完成任务，不漏产物、不重复产出
- [ ] 🚧 诊断包：一键导出环境信息、版本、引擎状态、审计日志摘要（脱敏，不含文件内容）
- [ ] 🚧 首次启动引导：引擎探测结果、需要下载什么、需要确认哪些许可证

### 验收标准

1. `cargo test --workspace` 全绿；v0.1 / v0.2 / v0.5 验收用例全部继续通过（**无回归**）。
2. **安装即可用**：在干净的 Windows 11、macOS (Apple Silicon)、Ubuntu 24.04 三台机器上，安装后无需命令行操作即可完成「导入图片 → 转换 → 看到输出文件」。
3. **自动更新可验证**：从上一版本安装包出发，能检测到新版本、完成签名校验并升级；篡改更新包后升级被拒绝。
4. **离线可用**：在无网络环境下，已安装引擎与已下载模型的既有功能全部可用，仅「需要新下载」的功能给出明确离线提示。
5. **卸载行为可验证**：选择不保留用户数据时，用户数据目录、`/engines/`、`/models/` 被清理干净；选择保留时再次安装可复用。
6. **合规可验证**：CI 能产出完整依赖许可证清单；**ffmpeg 构建被验证为不含 GPL 组件**（对应上面的 ⛔ 条目）；模型权重许可证逐个标注；安装包内含第三方声明文件。任何新增不合规依赖使 CI 失败。
7. **跨平台矩阵全通过**：上表矩阵中每一项都有人工或自动验证记录，任一平台任一用例失败即视为 v1.0 未达成。
8. **可访问性达标**：自动化可访问性检查无严重（serious/critical）问题；仅用键盘可完成一次完整任务。
9. **国际化达标**：切换语言后界面文案随之切换，不出现硬编码残留或中英混排错位。
10. **崩溃恢复可验证**：在批量任务执行中强制结束进程，重启后未完成任务可恢复，已完成产物不重复、不损坏。
11. **诊断包可用**：导出的诊断包不包含任何用户文件内容（以文本扫描校验），且足以让维护者判断引擎是否就绪、权限授予了哪些。
12. **隔离强度如实**：产品界面与用户文档中**没有任何**把 L3 描述为「沙箱」的表述（可用文本扫描校验）。

---

## 不在范围内（Non-Goals）

以下内容**明确不做**，并各给出理由，以避免路线图被反复拉扯：

- **不做插件原生动态库（`.dll` / `.so` / `.dylib`）加载**——原生库一旦载入进程便拥有与应用同等的权限，无法做到「逐条能力授权 + 运行时可裁决」，会直接废掉本项目安全模型的地基。需要原生性能的场景走 L2 WASM 或内置节点。
- **不做云端插件执行**——把用户的文件送出本机，与「本地工具集」的定位冲突，也引入数据合规与信任问题；AI 能力只调用用户显式配置的接口，且不上传用户文件本身。
- **不做移动端（iOS / Android）**——三级运行时（独立进程 + 文件系统收敛 + 外部引擎）都依赖桌面操作系统能力，移动端沙箱无法承载；强行支持会导致两套架构并行维护，收益远低于成本。
- **不做需要 GPU 常驻的推理服务**——常驻显存与「按需下载、按需运行」的引擎策略直接矛盾，且会让分发体积与硬件要求失控；AI 能力以按需加载的本地推理为主，不承诺常驻服务。
- **不做插件内的任意网络访问**——即使是 L2/L3，除用户逐条授权的明确目的外不开放网络；无约束的网络能力会让「能力声明」形同虚设。
- **不做自带 Python 全量发行版**——只固定 Python 3.11 的独立 venv 与受限协议，避免把庞杂的运行时纳入分发与合规范围。
- **不做「用 WASM 做图像处理」**——`runtimes.rs` 已说明原因：WASM 沙箱里没有文件系统也没有 SIMD，还要把几十 MB 图像数据在宿主与沙箱间往返拷贝，比纯 Rust 慢几十倍。这类需求走 L1 或 L3。

---

## 附 A：阶段验收总检查点

| 检查点 | 命令/动作 | 期望 |
| --- | --- | --- |
| 领域层健康 | `cargo test -p toolforge-core` | 61 通过 / 0 失败（**写本文档时的目标值**；当前全仓合计见下一行，不再逐 crate 维护） |
| 全仓健康 | `cargo test --workspace` | 全绿；**当前实测 286 passed / 0 failed** |
| 全目标检查 | `cargo check --workspace --all-targets` | 退出码 0 |
| 静态质量 | `cargo clippy --workspace --all-targets -- -D warnings`（= `pnpm check:clippy`） | **当前实测全绿**（§3.14 之前是红的） |
| 格式 | `cargo fmt --all --check`（= `pnpm check:fmt`） | ✅ **零格式差异**；已接进 `pnpm check:all` 与 CI（见 §3.20） |
| 脚本编码 | `pnpm check:encodings` | 退出码 0（`.ps1` 含非 ASCII 必须有 BOM，行尾必须 CRLF；见 §3.13） |
| 前端质量 | `pnpm typecheck`、`pnpm lint` | `pnpm typecheck` 退出码 0 ✅；⚠️ **`pnpm lint` 目前回退为 `tsc --noEmit`（本项目刻意不装 ESLint，见 `apps/desktop/.eslintrc.cjs` 头部的说明与安装命令）—— 它不提供 `tsc` 之外的任何检查**。写成"退出码 0"会让人以为有 linter，见 §3.16 |
| 聚合 | `pnpm check:all` | 退出码 0 |
| 类型桥 | `pnpm bindings` 连续两次 | 第二次后 `git status` 干净（该命令同时跑 4 项守卫，含 `COMMAND_NAMES` 与注册命令的逐条核对） |
| 真机验收 | `node scripts/devtools/verify-platform.mjs` | **当前实测 401 项检查全通过**（【1】–【34】：覆盖真改名、目录展开、设置落盘、模型清单、图片后端选择、任意角度旋转、**AI 抠图整条 ONNX 链路**【8】、电子书降级与拦停【9】、AI 视觉请求形状【10】、超分倍数【11】、**中间档 ImageMagick 后端切换**【12】、**纯 Rust 兜底档**【13】、音视频真实属性【17】、压缩包标准归档【18】、Office → PDF【19】、一句话生成插件闭环【20】、任务取消无孤儿【21】、画布导出跑通【22】、SDK 节点表对账【23】、API Key 生命周期与脱敏【24】、许可证确认与记录【25】、前端能力边界【26】、**「保留源文件」真的在删文件**【27】、**插件参数能不能到达执行器**【28】、**许可证勾选框的 UI 点击穿透**【29】、**权重被截断时不再谎报"已就绪"**【30】；【8】【9】【11】【12】【13】在缺权重 / 缺运行时（或没有可临时藏起的托管引擎）时会显式记为"跳过"而不是"通过"） |
| 最小闭环 | `pnpm tauri:dev` → 图片转换任务 | 任务完成、输出存在 |
| 引擎 | `pnpm engines:list` / `engines:install` | 能探测、能安装并通过 SHA-256 校验；**libvips 与 imagemagick 都已实测装成功**（哈希回填的 **7 条**仍限 Windows / Linux；FFmpeg 因本机 `www.gyan.dev` 不可达而未装成，见 §3） |
| 图标 | `pnpm icons` | 成功（需先补 `assets/icon-source.png`） |

## 附 B：本文件的核对方法说明

为避免把传闻当事实，本文档中所有「状态」与「阻塞」结论均来自以下直接核对，而非转述：

- **目录与文件存在性**：用 `Get-ChildItem -Recurse` 列出 `crates/` / `apps/` / `docs/` / `scripts/` / `plugins/`（排除 `target/`），并统计各 crate 的 `.rs` 文件数与行数。
- **阻塞 1、2**：读取 `crates/toolforge-core/src/pipeline.rs` 第 751、788 行原文，并读取上下文 745–755 行确认其处于 `NodeDescriptor` 字面量中。
- **阻塞 3**：读取 `crates/toolforge-core/src/permission.rs` 的 `PermissionSet` 结构体定义与文档注释、跑真实 `cargo test --lib`、再用**当前源码编译出的校验器**逐文件跑 6 个 `plugins/**/plugin.yaml`。（这一步正是发现 schema 改向、示例集体失效的手段——只读文档是发现不了的。）
- **阻塞 4**：读取 `crates/toolforge-core/src/paths.rs` 的 `sanitize_id` 实现与 `tests` 模块全文，手工推演 `../../etc/passwd` → `_.._etc_passwd`、`../../evil` → `_.._evil`。
- **不一致 1、2**：统计 `builtin_nodes()` 中 `name:` 条目（31）与 `nodes.rs::run()` 的节点分发臂（25），并 grep `ctx.engine("…")` 得到实际执行的引擎集合（ffmpeg / pandoc / libreoffice / 7zip），grep `vips|magick` 确认它们仅出现在错误信息与注释中。
  > ⚠️ **这条方法已经过时**（当时的结论也已过时）：现在 `image.*` 里确实会调用 libvips / ImageMagick，判断依据不再是"grep 得到哪些引擎名"，而是**读 `pick_image_backend()` 的四个调用点**，再跑 `verify-platform.mjs`【6】在真机上确认日志里报出的后端与引擎状态一致。`nodes.rs` 的节点分发臂数量也从 25 涨到 27。
- **不一致 3**：以 `ConvertFrom-Json` 解析 `engine-sources.json`，统计条目数 12、非空 `sha256` 数 0。
- **不一致 4**：grep `requires_license_ack` 于 `crates/toolforge-engines/src/registry.rs`，零匹配；对比 `crates/toolforge-core/src/engine.rs` 的字段定义与测试。
- **不一致 5–6**：读取 `package.json`、根 `Cargo.toml`、`apps/desktop/src-tauri/Cargo.toml`、`wasm.rs` / `python.rs` 的模块文档注释，并 grep 全仓 `docs/*.md` 引用。
- **转述核对**：对 `paths_for_plugin` 做全仓 grep（零匹配）；对 `provider.rs` / `review.rs` / `src-tauri/src/*` 做 `Test-Path`，并在发现结果与早期观察不一致时重新列目录、比对 `LastWriteTime`，据此判定哪些是「转述错误」、哪些是「并行开发已补齐」。

**未做的一件事**：没有运行 `cargo check` / `cargo test`。原因是这会生成 `target/` 目录与根 `Cargo.lock`，而本次任务被限定为「只修改 `docs/ROADMAP.md` 一个文件」。因此阻塞 1、2 的编译错误是**由源码语义与既有实测结论推得**，而非本机复现；若需要机器证据，请在允许产生构建产物的前提下执行 `cargo check -p toolforge-core`。

> 本文档的定量阈值（尤其 v0.5 的批量吞吐与内存上限）在首次基准测试完成后固化；在此之前，相关条目以「待固化」标注，不作为可宣称达成的目标。
