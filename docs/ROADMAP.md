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
| `plugins/` 示例插件 | ✅ 6 个：`builtin/image-convert`、`builtin/batch-rename`、`builtin/video-to-gif`、`builtin/remove-bg`（L1）；`wasm-example`（L2，含已编译的 `plugin.wasm`）；`python-example`（L3，含 `main.py`） |
| 示例插件的 `permissions` 写法 | ✅ 6 个 `plugin.yaml` 全部使用**正确的映射形式** `permissions: { capabilities: [...] }`，并逐一通过了用当前源码编译出的 `PluginManifest::validate()`（schema 曾变过一次，见阻塞 3） |
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
- 引擎策略：**按需下载 + 系统探测降级**；图片链路为「纯 Rust `image` crate 打底 → libvips 可选加速 → ImageMagick 兜底」。
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

### 基线（最新实测）

阻塞 1–11 全部修复后的**真实**运行结果：

```text
cargo check --workspace --all-targets   →  0 error / 0 warning
cargo test（core / process / engines / plugins / ai）
  toolforge-ai       25 passed
  toolforge-core     68 passed
  toolforge-process  19 passed
  toolforge-plugins  34 passed
  toolforge-engines  21 passed
  ─────────────────────────────
  合计              167 passed; 0 failed

cargo run -p toolforge --bin export-bindings
  → apps/desktop/src/bindings.ts（29 个命令）
```

前端侧（`apps/desktop`）由并行开发补齐，验收命令是：

```bash
pnpm typecheck      # tsc --noEmit
pnpm build          # tsc --noEmit && vite build
```

早期记录「修掉阻塞 1、2 后为 54 通过 / 7 失败」是当时快照，保留在阻塞 3 的条目里作为历史。

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

### 1. 节点登记 31 个，执行器只实现 25 个

- 权威目录 `toolforge_core::pipeline::builtin_nodes()` 登记 **31** 个节点（已逐条列出核对）。
- `crates/toolforge-engines/src/nodes.rs` 的 `run()` 分发臂实际实现 **25** 个。
- 差集（6 个）会落到 `other => Err(not_implemented(other))`，返回 `ErrorCode::Internal` + 「内置节点 `X` 尚未在 v0.1 中实现」：

  `image.remove-background`、`doc.ocr`、`ebook.convert`、`ai.upscale`、`ai.describe`

  > 更新（修复阻塞 9 之后）：`flow.foreach` 仍然没有执行器实现，但**批量语义已经补上了** ——
  > 命令层会把多文件输入展开成单文件批次逐批执行。也就是说清单里**不需要**写
  > `flow.foreach` 也能得到正确的批量行为；该节点的定位仍是"给流程编辑器保留的
  > 显式循环标记"，实现排在 v0.2。

- 这 6 个恰好覆盖了抠图、OCR、电子书转换、AI 超分、AI 描述与批量循环——即 `python`、`onnx-models`、`ai-provider`、`calibre` 几个引擎的实际价值所在。
- **设计上这是刻意的**（`not_implemented()` 的注释明确说明「不返回假的成功」），但**清单式插件可以合法引用它们并通过 `validate()`**，于是用户会看到「插件安装成功、运行即报错」。`plugins/builtin/batch-rename` 与 `plugins/builtin/remove-bg` 的 `plugin.yaml` 顶部注释已如实声明这一点。

### 2. 图像节点的「可选加速」只是声明，执行器从不调用 libvips / ImageMagick

- 节点目录里，`image.convert` / `image.resize` / `image.crop` / `image.strip-metadata` 声明 `optionalEngines: [libvips, imagemagick]`，`image.rotate` 声明 `[imagemagick]`，`image.enhance` 声明 `[libvips]`。
- 但 `nodes.rs` 里**真正被解析并执行的引擎只有四个**：`ctx.engine("ffmpeg")`、`ctx.engine("pandoc")`、`ctx.engine("libreoffice")`、`ctx.engine("7zip")`。
- `libvips` 与 `imagemagick` **没有任何一处被 resolve 或调用**：
  - 它们只出现在错误信息与警告里（例如 WebP 无损编码时提示「安装 libvips 可获得有损压缩」、缺 avif/jxl/heic 支持时提示「请安装 libvips 或 ImageMagick」）；
  - `image.rotate` 的任意角度分支**不是降级到 ImageMagick**，而是直接 `return Err(engine_missing("imagemagick"))`（`nodes.rs:588`）。
- 也就是说：**「纯 Rust 打底 → libvips 加速 → ImageMagick 兜底」这条链路目前只有第一档存在**，后两档是声明而非实现。这必须写进验收标准，否则会被误认为已经可用。

### 3. `engine-sources.json` 的下载源哈希 ✅ 已回填 6 条（Windows / Linux）

- 原状：12 条来源的 `sha256` **全部为 `null`**，而 `EngineRegistry::install` 在缺哈希时**直接拒绝下载** —— 也就是说校验机制写好了，但**任何引擎都装不上**。
- **现已回填 6 条**，且全部是**实际核对过**的（不是抄的）：

  | 引擎 | 平台 | 版本 | 大小 | 哈希来源 |
  |---|---|---|---|---|
  | `ffmpeg` | windows | 8.1.2 essentials | 104.6 MB | gyan.dev 随包发布的 `.sha256` 旁挂文件 |
  | `libvips` | windows | 8.18.6 (`build-win64-mxe`, x64-web) | 10.8 MB | 下载后自行计算 |
  | `pandoc` | windows | 3.11 | 39.8 MB | 下载后自行计算 |
  | `pandoc` | linux | 3.11 | 33.3 MB | 下载后自行计算 |
  | `python` | windows | 3.11.16 (python-build-standalone) | 46.0 MB | 下载后自行计算 |
  | `python` | linux | 3.11.16 (同上) | 46.6 MB | 下载后自行计算 |

- **同时把所有可用 URL 改成版本固定直链**。原来 `ffmpeg` 用的是 `ffmpeg-release-essentials.zip`（滚动指向最新版）—— 那类 URL 上的哈希**必然失效**，表现为"昨天能装、今天全部失败"。`libvips` 的源仓库也从 `libvips/libvips` 改为 `libvips/build-win64-mxe`（前者的 release 里没有 Windows 资产，实测 404）。
- **剩余未回填**：macOS 三条（无 macOS 环境核对）、`ffmpeg@linux`（上游 URL 是滚动别名）。这些条目 `sha256` 保持 `null`，`install` 会返回 `HashRequired` 而不是放行 —— 保守的默认值是刻意的。
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
- **实测**：`cargo run -p toolforge --bin export-bindings` 成功导出 29 个命令的绑定。

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

**引擎与图片**

- [x] ✅ 骨架完成：`EngineRegistry` 探测（`probe` / `probe_all` / `system_binary` / `resolve`）、按需下载（`download_to` / `install`）、SHA-256 比对、模型注册（`install_model`）
- [ ] 🚧 纯 Rust 图片转换端到端可用：`image.probe` / `image.convert` / `image.resize` / `image.crop` / `image.rotate`（90° 整数倍）/ `image.enhance` / `image.strip-metadata` 至少各有一条测试
- [ ] 🚧 引擎探测结果可从前端触发并展示（`engines:list` 或 IPC 命令二选一，先能看见就行）
- [ ] 🚧 处理不一致 2：要么让图像节点真正调用 libvips/ImageMagick，要么**先撤销 `optionalEngines` 声明**并只保留纯 Rust 路径——不允许「声明了但从不使用」长期存在

**插件（仅内置示例）**

- [x] ✅ 骨架完成：`PluginStore`（`reload` / `list` / `get` / `install` / `uninstall` / `set_enabled` / `set_granted` / `verify_integrity` / `quarantine_if_changed`）、`l1::run_pipeline`、`AuditLog`
- [x] ✅ 6 个示例插件的 `plugin.yaml` 已就位
- [ ] 🚧 装载示例插件并在「已实现的 25 个节点」范围内跑通一次真实流水线
- [ ] 🚧 权限声明 → 待授权列表 → 逐条授权的数据流打通（UI 可先极简）
- [ ] 🚧 用未实现节点（如 `flow.foreach`）时给出**可读且可操作**的错误，而不是内部错误码裸抛

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
2. `cargo clippy --workspace -- -D warnings` 与 `cargo fmt --check` 无输出（零告警、零格式差异）。
3. `cargo check --workspace --all-targets` 成功（即 `pnpm check:rust` 通过），且 `Cargo.lock` 已生成并入库。
4. `pnpm check:all` 退出码为 0。
5. `pnpm bindings` 成功生成 `bindings.ts`；**连续执行两次，第二次后 `git status` 为干净**（生成结果稳定、且文件已入库）。
6. **可复现的最小闭环**：启动 `pnpm tauri:dev` 后，导入一张 PNG，执行「转 JPEG + 缩放到指定宽度」，任务出现在任务中心、进度推进到 100%、输出文件存在于目标目录。
7. **取消可验证**：对一张大图发起任务后立刻取消，任务状态在 2 秒内变为「已取消」，且目标目录**不留下**半个输出文件（临时文件被清理）。
8. **不依赖外部二进制**：在未安装 ImageMagick / libvips / ffmpeg 的干净机器上，第 6 条闭环仍然成功（纯 Rust 路径打底）。
9. **错误可读**：人为传入不存在的输入路径，前端展示的错误包含模块名与错误码，而不是 `undefined` 或裸 panic。
10. **未实现节点诚实报错**：用 `flow.foreach` 构造一个插件并运行，前端明确显示「该内置节点尚未实现」及**指向本文档**的指引，而不是「任务成功但没产出文件」。
11. **L1 示例可跑**：`plugins/builtin/image-convert` 与 `plugins/builtin/video-to-gif` 在**已实现的 25 个节点范围内**能完整执行并产出文件（后者需 ffmpeg；无 ffmpeg 时给出可操作的安装提示）。
12. **权限门可见**：示例插件的全部能力声明能在 UI 列出，未授权能力被执行时被拒绝并给出具体原因。
13. `pnpm icons` 全链路成功（`assets/icon-source.png` 存在）。

---

## v0.2 —— 引擎与三级运行时落地

**主题**：把「只有纯 Rust 能干活」升级为「三种插件运行时真的跑起来 + 外部引擎真的能装上」，并把权限从「能显示」升级为「能强制」。

> 现状：三个运行时的**代码骨架都已在**（`runtimes/wasm.rs` 已用 `with_wasi(false)` + `with_fuel_limit`，`runtimes/python.rs` 已有 venv / 断网 / 超时 / 优雅关闭），引擎注册表也有下载与校验实现；**缺的是数据回填（哈希）、许可证闸门、以及可选引擎的真实调用**。

### 可交付能力清单

**引擎层**

- [x] ✅ 骨架完成：`engine-sources.json`（12 条候选源）、`EngineRegistry::install` / `download_to` / `install_model`、SHA-256 比对、`system_binary` 探测
- [ ] ⛔ 回填**全部 12 条**下载源的 `sha256`，否则 `install` 会按设计拒绝下载（不一致 3）
- [ ] 🚧 许可证闸门：把 `requires_license_ack` 接进 `install` 路径，未确认不得安装；确认结果落盘（不一致 4）
- [ ] 🚧 引擎接入：ffmpeg / pandoc / libreoffice / 7zip 已在 `nodes.rs` 中真实接线，需在真实环境逐个跑通
- [ ] 🚧 **真实接通图片加速链路**：libvips 与 ImageMagick 至少各有一个节点真正调用它们（当前为零，见不一致 2）；三档结果一致性有测试
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
6. **加速链路真实可用**：在有 libvips 的环境下，至少一个图像节点走 libvips 而非纯 Rust，并可通过日志/审计证实（对应不一致 2 的关闭）。
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

- [x] ✅ 骨架完成：`GenerationRequest` / `AiProviderConfig` / `ChatMessage`、系统提示词（把 31 个**真实**内置节点目录注入提示词，避免模型编造 `uses`）、`parse_model_output`（支持 `path=` 多文件代码块、裸 YAML 容错、缺 `plugin.yaml` 拒绝）
- [x] ✅ 骨架完成：`review_draft` / `SecurityReview`（能力清单 + 可疑模式 + 风险定级；需要 L3 时直接标 `Critical` 并提示逐行阅读）
- [ ] 🚧 接真实 provider 并端到端跑通一次生成
- [ ] 🚧 静态校验：schema 校验、API 版本校验、**节点白名单校验（尤其要挡住 6 个未实现节点）**、危险模式检测
- [ ] 🚧 权限差异检测：对比旧版本能力集合，**任何扩权都必须重新确认**
- [ ] 🚧 人工 diff 审阅：强制展示差异，未确认不得落盘
- [ ] 🚧 落盘 + 哈希锁定：生成物记录内容哈希，装载时再校验一次（`store.rs` 已有 `verify_integrity` / `quarantine_if_changed` 可复用）

**AI 媒体能力**

- [ ] 🚧 AI 抠图（`image.remove-background`，当前 `not_implemented`）
- [ ] 🚧 AI 超分（`ai.upscale`，当前 `not_implemented`）
- [ ] 🚧 AI 描述（`ai.describe`，当前 `not_implemented`）
- [ ] 🚧 模型文件管理：`/models/` 已忽略；`engine.rs` 已为 6 个模型声明许可证（含「权重许可 ≠ 代码许可」的说明），需补下载、校验与版本标识

**可视化流程编辑器**

- [ ] 🚧 基于 React Flow（`@xyflow/react`）的节点编辑器
- [ ] 🚧 节点 = 内置算子 / 插件节点；连线 = 数据流
- [ ] 🚧 **未实现节点必须可视化禁用**（以 `nodes.rs` 的 25 个为准，6 个 `not_implemented` 标灰并给出原因），避免「拖出来能连、运行必失败」
- [ ] 🚧 保存/加载流程定义，可导出为可复现的流水线描述
- [ ] 🚧 保存前校验：非法连线、缺失参数、缺失权限
- [ ] 🚧 批量循环（`flow.foreach`）实现并接入编辑器（当前 `not_implemented`）

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
4. **未实现节点被拦截**：让 AI 生成一个使用 `flow.foreach` / `doc.ocr` 的插件，必须在**静态校验阶段**就被拒绝（而不是运行时报 `not_implemented`）。
5. **扩权必须重新确认**：构造一个升级版本新增 `net` 能力的插件，安装时必然出现权限差异提示；拒绝后运行该插件被拒绝。
6. **哈希锁定有效**：手工修改已落盘插件的任一文件后，加载被拒绝并提示哈希不匹配（可复用 `verify_integrity` 的既有测试）。
7. **静态校验有效**：至少覆盖 5 类恶意/错误样本（超范围能力声明、未白名单节点、错误 API 版本、非法插件 id、参数缺失选项），全部在落盘前被拦截。
8. **编辑器可用**：在可视化编辑器中搭一条「缩放到 1920 宽 → 转 WebP → 输出到目录」的流程，保存后关闭并重开应用，流程可加载且执行结果与手写配置一致。
9. **编辑器诚实标注**：6 个未实现节点在编辑器中**不可放置或明确标灰**，悬停能看到「尚未实现，见 ROADMAP」。
10. **批量吞吐可测**：1000 张 1–2 MP 图片的批量转换任务，在公布的目标机型与目标引擎组合下达成约定的总耗时；峰值常驻内存不超过约定阈值（数值随首次基准测试结果固化并写入本文档，见下方注）。
11. **批处理可中断且可恢复**：处理 1000 张的中途取消，已完成产物完整可用，未完成的**不留残留文件**；再次执行只处理未完成的部分，或明确说明从头开始。
12. **AI 能力可用**：抠图与超分各在至少 3 张样例上产出符合预期（抠图边界无明显错误、超分输出尺寸与放大倍数一致）；模型许可证在首次使用前完成确认。
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
| 领域层健康 | `cargo test -p toolforge-core` | 61 通过 / 0 失败 |
| 全仓健康 | `cargo test --workspace` | 全绿 |
| 全目标检查 | `cargo check --workspace --all-targets` | 退出码 0 |
| 静态质量 | `cargo clippy --workspace -- -D warnings`、`cargo fmt --check` | 无输出 |
| 前端质量 | `pnpm typecheck`、`pnpm lint` | 退出码 0（需前端工程先落地） |
| 聚合 | `pnpm check:all` | 退出码 0 |
| 类型桥 | `pnpm bindings` 连续两次 | 第二次后 `git status` 干净 |
| 最小闭环 | `pnpm tauri:dev` → 图片转换任务 | 任务完成、输出存在 |
| 引擎 | `pnpm engines:list` / `engines:install` | 能探测、能安装并通过 SHA-256 校验（需先回填哈希） |
| 图标 | `pnpm icons` | 成功（需先补 `assets/icon-source.png`） |

## 附 B：本文件的核对方法说明

为避免把传闻当事实，本文档中所有「状态」与「阻塞」结论均来自以下直接核对，而非转述：

- **目录与文件存在性**：用 `Get-ChildItem -Recurse` 列出 `crates/` / `apps/` / `docs/` / `scripts/` / `plugins/`（排除 `target/`），并统计各 crate 的 `.rs` 文件数与行数。
- **阻塞 1、2**：读取 `crates/toolforge-core/src/pipeline.rs` 第 751、788 行原文，并读取上下文 745–755 行确认其处于 `NodeDescriptor` 字面量中。
- **阻塞 3**：读取 `crates/toolforge-core/src/permission.rs` 的 `PermissionSet` 结构体定义与文档注释、跑真实 `cargo test --lib`、再用**当前源码编译出的校验器**逐文件跑 6 个 `plugins/**/plugin.yaml`。（这一步正是发现 schema 改向、示例集体失效的手段——只读文档是发现不了的。）
- **阻塞 4**：读取 `crates/toolforge-core/src/paths.rs` 的 `sanitize_id` 实现与 `tests` 模块全文，手工推演 `../../etc/passwd` → `_.._etc_passwd`、`../../evil` → `_.._evil`。
- **不一致 1、2**：统计 `builtin_nodes()` 中 `name:` 条目（31）与 `nodes.rs::run()` 的节点分发臂（25），并 grep `ctx.engine("…")` 得到实际执行的引擎集合（ffmpeg / pandoc / libreoffice / 7zip），grep `vips|magick` 确认它们仅出现在错误信息与注释中。
- **不一致 3**：以 `ConvertFrom-Json` 解析 `engine-sources.json`，统计条目数 12、非空 `sha256` 数 0。
- **不一致 4**：grep `requires_license_ack` 于 `crates/toolforge-engines/src/registry.rs`，零匹配；对比 `crates/toolforge-core/src/engine.rs` 的字段定义与测试。
- **不一致 5–6**：读取 `package.json`、根 `Cargo.toml`、`apps/desktop/src-tauri/Cargo.toml`、`wasm.rs` / `python.rs` 的模块文档注释，并 grep 全仓 `docs/*.md` 引用。
- **转述核对**：对 `paths_for_plugin` 做全仓 grep（零匹配）；对 `provider.rs` / `review.rs` / `src-tauri/src/*` 做 `Test-Path`，并在发现结果与早期观察不一致时重新列目录、比对 `LastWriteTime`，据此判定哪些是「转述错误」、哪些是「并行开发已补齐」。

**未做的一件事**：没有运行 `cargo check` / `cargo test`。原因是这会生成 `target/` 目录与根 `Cargo.lock`，而本次任务被限定为「只修改 `docs/ROADMAP.md` 一个文件」。因此阻塞 1、2 的编译错误是**由源码语义与既有实测结论推得**，而非本机复现；若需要机器证据，请在允许产生构建产物的前提下执行 `cargo check -p toolforge-core`。

> 本文档的定量阈值（尤其 v0.5 的批量吞吐与内存上限）在首次基准测试完成后固化；在此之前，相关条目以「待固化」标注，不作为可宣称达成的目标。
