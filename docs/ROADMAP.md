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

> 快照时间：**2026-09-26 10:07**。下表为一次性观察结果，仓库可能已被继续改动。

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
| `plugins/` 示例插件 | ✅ 7 个：`builtin/image-convert`、`builtin/batch-rename`、`builtin/video-to-gif`、`builtin/remove-bg`、`builtin/ebook-convert`、`builtin/ai-describe`、`builtin/image-upscale`（均为 L1）；另有 `wasm-example`（L2，含已编译的 `plugin.wasm`）与 `python-example`（L3，含 `main.py`） |
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
| `scripts/enginectl.mjs` | 🚧 **不存在**，但 `package.json` 的 `engines:list` / `engines:install` 已引用它（见不一致项 4） |
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

### 基线再更新（当前值）

阻塞 14、15 修复后重新取的一组数（上面那组保留为历史，**不要把两组混用**）：

```text
【静态】
cargo test --workspace                  →  217 passed / 0 failed
cargo run -p toolforge --bin export-bindings
  → 生成 32 个命令的绑定 + 4 项守卫（其中「命令清单逐条核对」已取代被删除的魔数断言）

【真机运行】
scripts/devtools/verify-platform.mjs    →  69 项检查全通过（【1】–【11】）
                                            （run.mjs 里的第 5 个脚本；【6】= 图片后端，
                                             【7】= 任意角度旋转，【8】= 抠图整条 ONNX 链路，
                                             【9】= 电子书降级与拦停，【10】= ai.describe 的
                                             请求形状（假端点 mock-openai.mjs），
                                             【11】= 超分是不是真的按倍数放大）
一键安装引擎                            →  libvips 8.18.6 真实装上：
                                            下载 ≈30 MB → SHA-256 校验 → 解压 → installed
                                            落盘 <data_dir>/engines/libvips/bin/vips.exe（≈29.67 MB）
图片三层降级                            →  image.convert / resize / crop / rotate 真的挑后端，
                                            节点输出报 backend、日志写明用的是哪个
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

**这份基线里仍然为空的**：`image.enhance` / `image.strip-metadata` 未接外部后端（仍是纯 Rust 实现，而且已不再声明引擎依赖）；**「仅 ImageMagick」这一档仍然没有实测记录**（本轮补齐了它的 Windows 下载源，但应用内的安装链路未复验，见 §3 与开放项 8）；macOS 没有环境基线；**三档输出的结果一致性没有测试**；"两个可选引擎都缺失"这类组合环境没有专门基线。

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
> - **真机验证**：`scripts/devtools/verify-platform.mjs` 的【6】号检查断言"实际后端与引擎状态一致"并且日志里写明了用的是哪个后端，【7】号检查盯着任意角度旋转的诚实报错；整个脚本 **69 项检查全通过**。
> - **收益要说准**：libvips 档位带来的是**按质量换体积的能力**（WebP/JPEG 有损编码），纯 Rust 后端的 WebP 只能无损。**但"有损一定更小"是错的**，实测 320×200 合成渐变图：无损 508 字节 vs 有损 1808 字节（所以【6】只断言"确实走了有损编码"，不断言体积）。
>
> **本条原来还剩两件事，现在都做完了**：
> 1. `image.enhance` 与 `image.strip-metadata` 仍然只有纯 Rust 实现 —— 这**不是缺陷**（它们本就该是纯 Rust），但它俩的 `optionalEngines` 与两个引擎的 `provides` 里都还声明着"装了引擎能用"，那是假的。**已撤掉声明**，并在描述里写明"只有纯 Rust 实现"。
> 2. `image.crop` 的反向问题：实现里已经在用 libvips 裁剪，但 `libvips.provides` 里没有它。**已补进声明**（顺带补了 `image.rotate`、撤了引擎侧多余的 `image.strip-metadata` / `doc.ocr`）。
>
> 这两件事是同一类漂移（`provides` ↔ 节点声明，共 5 处），所以除了逐处修，还加了一条**双向守卫测试** `provides_matches_node_declarations`，并做了反证确认它真的会红。详见 `docs/ENGINE-MATRIX.md` 第 6.2 节。
>
> 另外：**ImageMagick 档位只有代码路径、没有实测记录**（本机没有装 ImageMagick，也没有一个"只有 ImageMagick 可用"的环境基线）。本轮给它补上了 **Windows 下载源**并做了直接执行验证（见 §3），但那只是让它**可装**，不等于"测过这一档"。
>
> 以下原文保留作为历史。

- 节点目录里，`image.convert` / `image.resize` / `image.crop` / `image.strip-metadata` 声明 `optionalEngines: [libvips, imagemagick]`，`image.rotate` 声明 `[imagemagick]`，`image.enhance` 声明 `[libvips]`。
- 但 `nodes.rs` 里**真正被解析并执行的引擎只有四个**：`ctx.engine("ffmpeg")`、`ctx.engine("pandoc")`、`ctx.engine("libreoffice")`、`ctx.engine("7zip")`。
- `libvips` 与 `imagemagick` **没有任何一处被 resolve 或调用**：
  - 它们只出现在错误信息与警告里（例如 WebP 无损编码时提示「安装 libvips 可获得有损压缩」、缺 avif/jxl/heic 支持时提示「请安装 libvips 或 ImageMagick」）；
  - `image.rotate` 的任意角度分支**不是降级到 ImageMagick**，而是直接 `return Err(engine_missing("imagemagick"))`（`nodes.rs:588`）。
- 也就是说（**写这条时的结论**）：「纯 Rust 打底 → libvips 加速 → ImageMagick 兜底」这条链路**当时只有第一档存在**，后两档是声明而非实现。当时的处理意见是"这必须写进验收标准，否则会被误认为已经可用" —— 后来的做法不是写进验收标准，而是**直接把后两档实现出来**（见上面的状态更新）。

### 3. `engine-sources.json` 的下载源哈希 ✅ 已回填 7 条（Windows / Linux）

- 原状：12 条来源的 `sha256` **全部为 `null`**，而 `EngineRegistry::install` 在缺哈希时**直接拒绝下载** —— 也就是说校验机制写好了，但**任何引擎都装不上**。
- **现已回填 7 条**，且全部是**实际核对过**的（不是抄的）：

  | 引擎 | 平台 | 版本 | 大小 | 哈希来源 |
  |---|---|---|---|---|
  | `ffmpeg` | windows | 8.1.2 essentials | 104.6 MB | gyan.dev 随包发布的 `.sha256` 旁挂文件 |
  | `libvips` | windows | 8.18.6 (`build-win64-mxe`, x64-web) | 10.8 MB | 下载后自行计算 |
  | `imagemagick` | windows | 7.1.2-31 portable Q16 x64（`.7z`） | 11.7 MB | 下载后自行计算（**上游没有发布校验和**，release 里只有 SBOM 与 in-toto 证明，都不含产物摘要 —— 换版本必须重算） |
  | `pandoc` | windows | 3.11 | 39.8 MB | 下载后自行计算 |
  | `pandoc` | linux | 3.11 | 33.3 MB | 下载后自行计算 |
  | `python` | windows | 3.11.16 (python-build-standalone) | 46.0 MB | 下载后自行计算 |
  | `python` | linux | 3.11.16 (同上) | 46.6 MB | 下载后自行计算 |

- **`imagemagick@windows` 是本轮新增的**（此前 `imagemagick` 声明了 `Download` 却没有来源，界面于是显示一个点下去必然失败的「一键下载」按钮 —— 那条提示语也一并修了）。三件事是**直接执行**验证的，不是推断：官方 Windows 便携包**只有 `.7z`**；**Windows 自带的 `tar`（bsdtar / libarchive）能读 7z**（`tar -xf` 退出码 0、`magick.exe -version` 打印 `ImageMagick 7.1.2-31 Q16 x64`），所以装它**不需要先装 7-Zip**；包内**没有顶层目录**（23 个条目直接在根），所以 `stripComponents` 是 **0** 而不是习惯上的 1。Linux / macOS **故意不写来源**（走 `apt` / `brew`）。
  > ⚠️ **应用内的完整安装链路尚未复验**：`toolforge.exe` 被一个无关的第三方进程持有文件句柄，cargo 写不回链接产物（`link.exe` 1104），二进制重建不了、跑不了。上面四点才是原本的风险所在，它们已由直接执行验证。
- ⚠️ **一条环境事实，不是代码缺陷**：本次会话里**本机连不上 `www.gyan.dev`**（`curl` 直测 `Failed to connect ... after 21107 ms`），所以 **FFmpeg 的安装在本机没有完成过**，依赖它的 `video.*` / `audio.*` 节点在那台机器上不可用。`ffmpeg@windows` 这条来源的哈希取自上游**随包发布的 `.sha256` 文件**（比自己下载后计算更可信），但那只能证明"来源写对了"，**不能替代一次真实安装**。

- **同时把所有可用 URL 改成版本固定直链**。原来 `ffmpeg` 用的是 `ffmpeg-release-essentials.zip`（滚动指向最新版）—— 那类 URL 上的哈希**必然失效**，表现为"昨天能装、今天全部失败"。`libvips` 的源仓库也从 `libvips/libvips` 改为 `libvips/build-win64-mxe`（前者的 release 里没有 Windows 资产，实测 404）。
- **剩余未回填**：macOS 四条（ffmpeg / libvips / pandoc / python，无 macOS 环境核对）、`ffmpeg@linux`（上游 URL 是滚动别名）。这些条目 `sha256` 保持 `null`，`install` 会返回 `HashRequired` 而不是放行 —— 保守的默认值是刻意的。
- 新增两条纪律测试：`every_declared_hash_is_a_wellformed_sha256`（长度/大小写/字符集）、`no_source_points_at_a_rolling_latest_alias`（禁止滚动别名配哈希）。
- 另一条实测教训：回填后有个单元测试**开始真的下载 104 MB 的 FFmpeg**（它原本假设"所有哈希都是 null"所以 `install` 会立刻返回 `HashRequired`）。现已改为用临时来源文件构造缺哈希场景，与真实数据解耦 —— **测试不该有联网副作用**。

### 4. 许可证确认有数据、无强制

- `crates/toolforge-core/src/engine.rs` 里为每个引擎与模型都提供了 `license`、`license_note`、`requires_license_ack`，并且有测试在守护这些字段非空。
- 但 `crates/toolforge-engines/src/registry.rs` **对 `requires_license_ack` 零引用**——没有任何安装前确认流程。
- 结论：**许可证信息是「声明式数据」，尚未成为「流程闸门」**。v0.2 需要把它接进 `install` 路径并落盘记录确认结果。

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
| 1 | **`realesrgan-x4plus` 的固定输入尺寸支持** | 它的 ONNX 导出输入尺寸固定（64×64 或 128×128），要跑通必须先补上「补齐到固定尺寸 → 推理 → 裁回去」，否则边缘块会留下**网格状接缝**。所以它**故意没有下载源**，也不出现在 `ai.upscale` 的 `model` 枚举里 | 不是"哈希没核对"—— 另外两个没有下载源的抠图模型（`birefnet-general` / `modnet-portrait`）才是这个原因。要做的顺序：补逻辑 → 重跑接缝检查 → 真实下载后填哈希 |
| 2 | **`image.enhance` / `image.strip-metadata` 仍然只有纯 Rust 一条路** | 它们**不问引擎**、不调用 `pick_image_backend()`、不产出 `backend`，所以装了 libvips 也不会更快。两者本身是**刻意**的（内置卷积与"解码再编码"都能干这个活），有问题的只是它们曾经声明了引擎依赖 —— **那部分已经撤掉**，界面不再宣称"装了引擎会更快" | 不是降级链的问题：降级链只覆盖 `image.convert` / `image.resize` / `image.crop` / `image.rotate` 四个节点。要不要给这两个节点接外部后端，是**独立的性能议题**，不是缺陷 |
| 3 | **`doc.ocr` 的 PDF 栅格化** | PDF 输入现在被**明确拒绝**（要按页转图片，需要 pdfium / poppler）。报错文案清楚，但功能确实没有 | 不是"忘了处理"—— 拒绝是刻意的：产出一堆乱码比报错糟得多 |
| 4 | **`ebook.convert` 在两个可选引擎都没有时的 UI 提示** | 运行期会返回明确的 `EngineMissing`（detail 列出 Calibre 与 Pandoc 的覆盖范围与体积），但**节点可用性判定仍只看 `requiresEngines`**，所以这种机器上它依旧显示"可用" | 不是安全问题，是**知情时机的落差**：用户点下去才知道要装东西 |
| 5 | ~~**`doc.ocr` 的参数枚举与执行器对不上**~~ **已修** | 枚举原为 `auto` / `tesseract` / `paddleocr`，执行器认 `auto` / `tesseract` / `ai`。填 `ai` 有效但不在下拉里；填 `paddleocr` 能选中却走到"两者都不满足"的分支。**已把枚举改成 `ai` 并把 PaddleOCR 文案删掉** | 这是一类值得记的漂移：**参数名对了但取值对不上**，比参数名写错更难发现 —— 界面照常显示、执行器照常运行，只有结果不符合预期 |
| 6 | ~~**`doc.ocr` 的可用性判定严于实现**~~ **已修** | 原来 `requiresEngines` 是 `["python"]`，缺 Python 时整个节点被标灰；但 tesseract 那条路根本不碰 Python。**已改为 `requiresEngines: []` + `optionalEngines: ["tesseract", "ai-provider"]`** | 正是"能用却显示不可用"（这个项目在 `onnx-models` 上踩过反方向的坑） |
| 7 | ~~**`doc.ocr` 的 AI 路径没有声明 `ai-provider`**~~ **已修** | 现在 `doc.ocr` 的 `optionalEngines` 含 `ai-provider`，`ai-provider.provides` 也含 `doc.ocr`，两个方向都对齐 | 同第 6 条，一并由 `provides_matches_node_declarations` 这条双向测试守住 |
| 8 | **ImageMagick 档位与 macOS 没有环境基线** | "只有 ImageMagick 可用"这一档从未被单独测过（本机没装 ImageMagick）。本轮补齐了它的 **Windows 下载源**，并**直接执行**验证了原本有风险的四点（哈希、`tar` 能解 7z、`magick.exe` 可运行、包内无顶层目录 —— 见 §3），但**应用内的安装链路未复验**，所以这一档现在是"可装"，仍不是"测过"。macOS 四条下载源（ffmpeg / libvips / pandoc / python）也仍是 `null`（没有环境核对哈希） | 不是"没实现"—— 代码路径在，缺的是验证记录 |
| 9 | **验证脚本的覆盖面仍然是"我们可控的那部分"** | `ai.describe` 用假端点验证请求形状（这是对的，真模型不可复现、要花钱），但它**验不了**"模型答得好不好"；同理【11】验的是倍数与尺寸，不是超分画质 | 这是**刻意的边界**，不是疏漏。写清楚是为了避免有人把"69 项全通过"读成"AI 能力已经验收" |

> **一句话总结这一轮**：节点的账已经平了（32/32，`UNIMPLEMENTED_NODES` 为空）。上面这 9 条里，第 2、5、6、7 条都属于**"声明与实现 / UI 之间的小漂移"**，现已全部修掉（5/6/7 是同一类：`doc.ocr` 的声明；2 是 `provides` ↔ 节点声明那 5 处），并且由双向测试守着 —— 这类问题不会让构建变红，只会让用户在看到真实行为时感到意外，比"缺一个功能"更难发现，所以专门列在这里而不是埋进正文。剩下的三类是：**真的还没做**（1 的固定尺寸补边、3 的 PDF 栅格化）、**知情时机**（4）、**还没有验证记录**（8 的 ImageMagick / macOS 档位、9 的验证覆盖面边界）。

---

## v0.1 —— 骨架可运行

**主题**：把领域层修到可用，把外壳与最小可用链路打通。目标是「一个能装插件、能跑任务、能看进度、能取消的桌面程序」，而不是「功能最多」。

> 现状：五个 Rust crate 的骨架**都已写出**，但**没有任何一条端到端可运行路径**——`toolforge-core` 编译不过、前端工程不存在、`pnpm` 侧脚本全部无法解析。

### 可交付能力清单

**领域层（`toolforge-core`）**

- [ ] ⛔ 关闭「当前阻塞项」1–4，`toolforge-core` 可编译
- [ ] `cargo test -p toolforge-core` 61 个测试全绿（✅ 测试用例已写完，⛔ 当前不可用）
- [x] ✅ 11 个模块骨架完成：`error` / `ids` / `permission` / `plugin` / `pipeline` / `job` / `engine` / `queue` / `events` / `paths` + `lib.rs`
- [ ] 🚧 修正不一致 6i 的进度指引，使「未知节点」与「未实现节点」两处错误信息指向同一份文档

**进程层（`toolforge-process`）**

- [x] ✅ 骨架完成：`exec`（含 `exec_streaming`、输出上限裁剪、Windows `CREATE_NO_WINDOW`、Unix 进程组分离）与 `rpc`（JSON-RPC 2.0 按行分帧）与 `supervisor`（常驻子进程监督管理器）
- [ ] 🚧 用真实子进程打通一次端到端 RPC 往返（请求 / 响应 / 通知三态 + id 关联 + 错误对象）
- [ ] 🚧 取消路径可验证：取消令牌触发后子进程树被杀死，无孤儿
- [ ] 🚧 管道死锁回归测试：子进程往 stderr 狂写的场景下不卡死

**外壳与前端**

- [x] ✅ `apps/desktop/src-tauri` 骨架完成：配置层 + `main.rs` / `lib.rs`（`COMMAND_NAMES` + `specta_builder()`）/ `commands.rs` / `ipc.rs` / `state.rs` / `bin/export_bindings.rs`
- [ ] 🚧 `apps/desktop` 前端工程建立（`package.json` 名 `@toolforge/desktop`、Vite 5、TS 5、TailwindCSS 3.4、Zustand、TanStack Query、React 18）
- [ ] 🚧 前端壳：主窗口 / 插件列表 / 任务中心三个视图可切换（不含流程编辑器）
- [ ] 🚧 `pnpm bindings` 可用：修掉不一致 5 的包名（`-p toolforge-desktop` → `-p toolforge`），并把 `bindings.ts` 生成到前端且**入库**
- [ ] 🚧 `COMMAND_NAMES` 与 `collect_commands!` 的一致性自检在 CI 中生效
- [ ] 🚧 补 `assets/icon-source.png`，使 `pnpm icons` 全链路成功
- [x] ✅ **设置已持久化**（新模块 `apps/desktop/src-tauri/src/settings_store.rs`）：非机密设置写 `<data_dir>/settings.json`，**原子写**（同目录临时文件 + `rename` + `sync_all` —— 直接截断重写的话，写到一半断电就留下半截 JSON，用户全部设置一次性丢失）；解析失败的文件被**隔离**成 `settings.broken.json` 并回退默认值（**启动绝不因为坏设置文件而失败**，否则用户连能修它的界面都进不去）；缺字段按**字段级**默认值补齐，旧配置继续可用。API Key **不在这个文件里**（它默认只在内存，只有用户显式打开 `ai.persistApiKey`——默认 `false`——时才**明文**写到 `<data_dir>/ai-key.txt`，关掉开关即删除该文件；OS 钥匙串仍未实现。详见 `docs/SECURITY.md` 的凭据落盘一节）；`paths.rs` 新增 `settings_file()` / `ai_key_file()` / `settings_backup_file()`。
  - 这条是**补债**：设置页原本写着「所有设置都会立即写入本机配置文件」，而 `AppState.settings` **只在内存里** —— 界面上写了一句假话，关掉应用设置就没了。

**引擎与图片**

- [x] ✅ 骨架完成：`EngineRegistry` 探测（`probe` / `probe_all` / `system_binary` / `resolve`）、按需下载（`download_to` / `install`）、SHA-256 比对、模型注册（`install_model`）
- [ ] 🚧 纯 Rust 图片转换端到端可用：`image.probe` / `image.convert` / `image.resize` / `image.crop` / `image.rotate`（90° 整数倍）/ `image.enhance` / `image.strip-metadata` 至少各有一条测试
- [ ] 🚧 引擎探测结果可从前端触发并展示（`engines:list` 或 IPC 命令二选一，先能看见就行）
- [x] ✅ **处理不一致 2（已完成）**：`image.convert` / `image.resize` / `image.crop` / `image.rotate` **已经真的调用** libvips / ImageMagick（`pick_image_backend()`，输出里报 `backend`），不再是"声明了但从不使用"。
  - 声明侧的 5 处漂移也全部修好：撤掉 `libvips.provides` 里的 `image.enhance` / `image.strip-metadata`、撤掉 `imagemagick.provides` 里的 `image.strip-metadata`、补上两个引擎都缺的 `image.crop` / `image.rotate`、撤掉 `python.provides` 里不该有的 `doc.ocr`、补上 `ai-provider.provides` 该有的 `doc.ocr`。
  - 新增双向守卫测试 `provides_matches_node_declarations` 并做过反证。见 `docs/ENGINE-MATRIX.md` 第 6.2 节。

**插件（仅内置示例）**

- [x] ✅ 骨架完成：`PluginStore`（`reload` / `list` / `get` / `install` / `uninstall` / `set_enabled` / `set_granted` / `verify_integrity` / `quarantine_if_changed`）、`l1::run_pipeline`、`AuditLog`
- [x] ✅ 6 个示例插件的 `plugin.yaml` 已就位
- [x] ✅ 装载示例插件并跑通一次真实流水线 —— 7 个内置示例里的 `image-convert` / `batch-rename` / `video-to-gif` / `remove-bg` 都已在真机上跑通（`scripts/devtools/verify-platform.mjs` 的【1】、【6】、【8】），本轮又补上了 `ebook-convert` / `ai-describe` / `image-upscale`（【9】、【10】、【11】）。
- [ ] 🚧 权限声明 → 待授权列表 → 逐条授权的数据流打通（UI 可先极简）
- [x] ✅ 用未实现节点时给出**可读且可操作**的错误，而不是内部错误码裸抛
  - ✅ **已结案**：批量循环那条支路（`flow.foreach`）彻底消失了 —— 节点被删除，
    引用它的清单在校验阶段就报 `STEP_UNKNOWN_NODE`，根本走不到运行时。
    **名单（`UNIMPLEMENTED_NODES`）现在是空的**，所以这条兜底错误只剩"节点名拼错"一种成因，
    而它会把两种处境分开说（"名字不在目录里" vs "在目录里但没实现"）。错误文案依然指向本文档。

**任务中心**

- [ ] 🚧 任务创建、排队、执行、进度上报、取消（对应 `job` / `queue` / `events`）
- [ ] 🚧 进度条与取消按钮可用，事件从后端推送到前端（Tauri event；`ipc.rs` 的事件桥已写好，需接线验证）
- [ ] 🚧 任务失败时给出可读错误（模块 + 代码 + 信息），不吞异常

**工程基线**

- [x] ✅ `.gitignore` 已就绪（含前端口径：`bindings.ts` 要入库）
- [x] ✅ `scripts/env.ps1`、`scripts/gen-icon.mjs` 已存在
- [ ] 🚧 补 `scripts/enginectl.mjs`（`package.json` 已引用；在引擎哈希回填之前，先让 `list` 能只读地打印 `engine-sources.json`）
- [ ] 🚧 CI 基线：`cargo fmt --check`、`cargo clippy --workspace -- -D warnings`、`cargo test --workspace` 三条必过
- [ ] 🚧 `pnpm check:rust` / `check:web` / `check:all` 可执行
- [ ] 🚧 `README.md` 更新为 ToolForge 架构说明（当前仍是占位内容）
- [ ] 🚧 补 `docs/SECURITY.md` 与 `docs/PLUGIN-SDK.md`（已被代码与示例引用）

### 验收标准

1. `cargo test --workspace` 全绿，且 `cargo test -p toolforge-core` 恰好 **61 个测试通过、0 失败**。
   > 注：61 是**写这一条时的目标/快照值**。当前 `cargo test --workspace` 合计 **217 passed / 0 failed**；分 crate 的逐项数字本文档不再维护（维护它只会制造又一处会漂移的常量）。
2. `cargo clippy --workspace -- -D warnings` 与 `cargo fmt --check` 无输出（零告警、零格式差异）。
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
13. `pnpm icons` 全链路成功（`assets/icon-source.png` 存在）。

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
  > 进度：**libvips 已跑通**（一键安装成功 + 四个图像节点真实调用，见上面两条与「阻塞 14」）；ffmpeg / pandoc / libreoffice / 7zip 这四个"必需引擎"档位的逐个真机跑通仍未完成。ImageMagick **没有装过、也没有实测记录**（本轮只补齐了它的 Windows 下载源，并对"能不能装"做了直接执行验证，见 §3）。另外 FFmpeg 在本机因 `www.gyan.dev` 不可达而**未能完成安装** —— 那是环境问题，不是代码缺陷（见 §3）。
- [ ] 🚧 **真实接通图片加速链路（libvips 已达成，ImageMagick 与两个节点仍缺）**：`libvips` 已由 `image.convert` / `image.resize` / `image.crop` / `image.rotate` 真实调用并可在日志/节点输出里观测（`verify-platform.mjs`【6】在真机上验证）；仍缺的是 —— `image.enhance` / `image.strip-metadata` 不接外部后端（这是性能议题，声明侧已经不再谎称"装了会更快"）、**`ImageMagick` 档位没有实测记录**（下载源已补齐、安装未复验）、**三档结果一致性没有测试**（见不一致 2 的更新）。
- [ ] 🚧 `scripts/enginectl.mjs`：`list` / `install` / `verify` / `clean` 子命令
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

### 验收标准

1. `cargo test --workspace` 全绿，且 v0.1 的 61 个核心测试保持全绿（**不得回归**）。
2. **校验不可绕过**：手工篡改已下载引擎的一个字节后运行，程序拒绝执行并给出「校验失败」错误；确认后重新下载可恢复。
3. **引擎可安装**：12 条源中的每一条在 `sha256` 回填后，`install` 能成功下载、校验、落地；`sha256` 缺失时**拒绝安装**的行为有测试守护。
4. **许可证确认可验证**：在全新用户数据目录下首次安装/调用需要确认的引擎（如 ffmpeg、calibre、tesseract）前，必须出现许可证确认；拒绝确认时任务**不会**执行，且不留下部分产物；确认记录可在审计日志中查到。
5. **降级可验证**：分别测「无任何外部引擎」「仅系统安装 ImageMagick」「安装 libvips」三种环境，同一图片转换任务都能完成，输出在尺寸/通道/格式上一致（编码字节允许差异）。
   > 进度（🚧）：**「安装 libvips」一档已有真机证据**（`verify-platform.mjs`【6】断言实际后端与引擎状态一致，且该脚本 69 项全通过）；**另两档还没有专门的环境基线** —— 尤其是"仅 ImageMagick"这一档从未被单独测过。"三档输出一致"也还没有测试。
6. **加速链路真实可用** ✅ **已达成**：有 libvips 的环境下，`image.convert` / `image.resize` / `image.crop` / `image.rotate` 四个节点会真的走 libvips 而非纯 Rust，并**通过节点输出的 `backend` 与一条 debug 日志证实**（`verify-platform.mjs`【6】的核心断言就是"日志里写明了实际使用的图片后端"且"与引擎状态一致"）。对应「不一致 2」——**部分关闭**：`image.enhance` / `image.strip-metadata` 仍只有纯 Rust 路径，`ImageMagick` 档位仍无实测记录。
7. **L2 沙箱可验证**：尝试文件读取/网络访问的 WASM 插件被拒绝并返回明确错误；分配超限内存或耗尽燃料时被终止，宿主进程存活且后续调用正常。
8. **L2 宿主函数白名单可验证**：仅 `log` / `kv` 可调用；调用未白名单宿主函数返回「未定义函数」类错误；`allowHostFunctions` 里写其它名字在装载期即被拒绝。
9. **L3 常驻可验证**：连续调用同一 Python 插件 100 次，进程数保持为 1，总耗时显著低于 100 次冷启动。
10. **L3 取消可验证**：发起长耗时 Python 调用后取消，2 秒内 Python 子进程消失（进程列表可验证），且后续调用仍可正常执行（进程被正确重建）。
11. **L3 进度完整**：插件上报 `currentItem` / `speed` / `etaSeconds` 时，前端能收到并显示（对应不一致 6g 的关闭）。
12. **权限强制可验证**：仅授予 `fsRead` 的插件尝试写文件被拒绝；撤销授权后再次执行被拒绝；授予目录之外的文件访问被拒绝——三条均在前端可见具体原因，并都在审计日志中留痕。
13. `scripts/enginectl.mjs` 的 `list` / `install` / `verify` 三个子命令在 Windows 与 Linux 上退出码为 0，且 `engines:list` / `engines:install` 两个 npm 脚本可用。

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
  - 真机验收落在 `verify-platform.mjs` 的**【8】号检查**（整个脚本 **69 项检查全通过**）。**该检查在缺权重 / 缺运行时会显式记为"跳过"而不是"通过"** —— 那些前置条件要下载，不能算进通过数。
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
| 全仓健康 | `cargo test --workspace` | 全绿；**当前实测 217 passed / 0 failed** |
| 全目标检查 | `cargo check --workspace --all-targets` | 退出码 0 |
| 静态质量 | `cargo clippy --workspace -- -D warnings`、`cargo fmt --check` | 无输出 |
| 前端质量 | `pnpm typecheck`、`pnpm lint` | 退出码 0（需前端工程先落地） |
| 聚合 | `pnpm check:all` | 退出码 0 |
| 类型桥 | `pnpm bindings` 连续两次 | 第二次后 `git status` 干净（该命令同时跑 4 项守卫，含 `COMMAND_NAMES` 与注册命令的逐条核对） |
| 真机验收 | `node scripts/devtools/verify-platform.mjs` | **69 项检查全通过**（【1】–【11】：覆盖真改名、目录展开、设置落盘、模型清单、图片后端选择、任意角度旋转、**AI 抠图整条 ONNX 链路**【8】、电子书降级与拦停【9】、AI 视觉请求形状【10】、超分倍数【11】；【8】【9】【11】在缺权重 / 缺运行时会显式记为"跳过"而不是"通过"） |
| 最小闭环 | `pnpm tauri:dev` → 图片转换任务 | 任务完成、输出存在 |
| 引擎 | `pnpm engines:list` / `engines:install` | 能探测、能安装并通过 SHA-256 校验；**libvips 已实测装成功**（哈希回填的 **7 条**仍限 Windows / Linux；`imagemagick@windows` 的来源已补齐、应用内安装未复验；FFmpeg 因本机 `www.gyan.dev` 不可达而未装成，见 §3） |
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
