# ToolForge 引擎矩阵与降级规格

> 文档路径：`docs/ENGINE-MATRIX.md`
> 对应工作区版本：`Cargo.toml` 中 `[workspace.package] version = "0.1.0"`

---

## 1. 开篇说明

### 1.1 权威来源

本文档中所有引擎、模型、内置节点的数据，都来自下面两个 Rust 函数。它们是**唯一可信来源**，本文档只是它们的人读版本。

| 数据 | 权威来源 | 内容 |
| --- | --- | --- |
| 引擎目录（11 个）与模型清单（6 个） | `engine_catalog()`，位于 `crates/toolforge-core/src/engine.rs` | 返回 `Vec<EngineDescriptor>`：引擎的许可证、许可证注意事项、体积、安装方式、支持平台、`provides` 能力标签 |
| 内置节点目录（32 个） | `builtin_nodes()`，位于 `crates/toolforge-core/src/pipeline.rs` | 返回 `Vec<NodeDescriptor>`：每个节点的 `requiresEngines`（必需引擎）与 `optionalEngines`（可选引擎），是本文档第 5 节降级矩阵的唯一依据 |

**维护约定：改代码必须同步改本文档。**

- 在 `engine_catalog()` 里新增、删除或改名引擎 → 必须同步更新第 2 节与第 3 节。
- 修改 `EngineModel` 的 `license` 或 `commercialUse` → 必须同步更新第 4 节，尤其是「不可商用」的标注。
- 修改 `NodeDescriptor` 的 `requiresEngines` / `optionalEngines` → 必须同步更新第 5 节。
- `crates/toolforge-core/src/engine.rs` 中已有测试 `every_provided_capability_maps_to_a_real_node`（引擎声明的能力必须都有对应节点）和 `every_node_engine_reference_exists_in_catalog`（节点引用的引擎必须都在引擎目录里）在守护这两份数据的一致性。本文档就是这两个测试的说明版本。

### 1.2 实现状态（以仓库实际文件为准）

本节的落地状态是**某一时刻的快照**。原因是：编写本文档期间，`crates/toolforge-plugins`、`crates/toolforge-engines/src/nodes.rs`、`apps/desktop/src-tauri` 等文件是在核对过程中被**并发写入**仓库的（`git status` 显示它们都是未跟踪的新增内容）。下表以最后一次核对的观察结果为准，并给出依据文件，便于读者自行复核；若文件清单已变，本表即为过期。

| 组件 | 落地状态（快照） | 依据文件 |
| --- | --- | --- |
| `crates/toolforge-core` | 已落地 | 11 个源文件（`lib.rs` + 10 个模块），含 `src/engine.rs`（引擎目录）与 `src/pipeline.rs`（32 个内置节点） |
| `crates/toolforge-engines` | 已落地 | `Cargo.toml`、`src/lib.rs`、`src/registry.rs`、`src/nodes.rs`（节点执行实现）、`engine-sources.json` |
| `crates/toolforge-process` | 已落地 | `src/lib.rs`、`src/exec.rs`、`src/rpc.rs`、`src/supervisor.rs` |
| `crates/toolforge-plugins` | **已补齐** | 7 个源文件：`lib.rs`、`audit.rs`、`store.rs`、`l1.rs`、`runtimes.rs`、`runtimes/wasm.rs`、`runtimes/python.rs`（编写本文档时只有前 3 个） |
| `crates/toolforge-ai` | **已补齐** | 3 个源文件：`lib.rs`、`provider.rs`、`review.rs`（编写本文档时目录尚不存在） |
| `apps/desktop` | **已补齐后端** | `src-tauri/src/` 下有 `main.rs`、`lib.rs`、`commands.rs`、`ipc.rs`、`state.rs`、`bin/`；**但前端 `apps/desktop/src/` 仍不存在** |

有两点必须讲清楚：

1. **本文档最早写作时没有运行过 `cargo build` / `cargo test`**，因此当时不对「当前能否构建成功」下结论。可以确认的是：根 `Cargo.toml` 的 `members = ["crates/*", "apps/desktop/src-tauri"]` 现在都有对应目录。
   > ✅ **已更新（现在有实测数据了）**：`cargo test --workspace` 的 Rust 测试为 **215 passed / 0 failed**；`scripts/devtools/verify-platform.mjs`（`scripts/devtools/run.mjs` 里的第 5 个脚本）**41 项检查全通过**，其中【6】号检查就是盯着"图片后端到底有没有真的被调用"，【7】号检查盯着任意角度旋转会不会静默取整，【8】号检查盯着**抠图这条 ONNX 链路能不能真的出透明背景**。
   > 所以**第 5 节的降级矩阵现在是混合状态**：图像域的 `image.convert` / `image.resize` / `image.crop` / `image.rotate` 四行已经是**实测行为**（见 5.1），`image.remove-background` 也已有端到端实测（见 3.2、5.2），其余各行仍然只是 `builtin_nodes()` 声明的引擎依赖关系，不是经测试验证的运行时行为。（相关编译阻塞与实测结论见 `docs/ROADMAP.md` 的「当前阻塞项」。）
2. 本文档因此同时承担两个角色：**引擎层规格说明**（现在就能定下来的接口契约：有哪些引擎、能力边界、许可证约束、降级规则）与**待实现清单**（第 6 节列出尚未落地的部分与已知的数据不一致）。

> 核对说明：任务简报假定「仓库目前只存在 `crates/toolforge-core`，`toolforge-engines` / `toolforge-process` / `toolforge-plugins` / `toolforge-ai` 以及 `apps/desktop` 都还没落地」。实际核对后，这些组件中的多数已经存在（其中一部分正是在核对期间被并行写入的）。本节按仓库实际文件撰写，未沿用该假定。

### 1.3 下载地址与校验哈希：三个有、三个刻意没有

`EngineModel` 结构体（`crates/toolforge-core/src/engine.rs`）中，`url` / `sha256` / `file_name` 都是 `Option<String>`。`onnx-models` 的 6 个模型**不再是"全部为 `None`"**：

- **`u2net`、`u2netp`、`isnet-general` 三个已有完整来源**：`url` 指向 `https://github.com/danielgatis/rembg/releases/download/v0.0.0/<资产名>`（release tag 字面就是 `v0.0.0`），`sha256` 是**真实下载后自己算出来的**，不是从网页抄的；`file_name` 单独一个字段，因为 GitHub 的资产名与模型 id **并不一致**（`isnet-general` 的资产是 `isnet-general-use.onnx`）。文件落在 `<data_dir>/models/<model_id>/<file_name>`。
- **`birefnet-general`、`modnet-portrait`、`realesrgan-x4plus` 三个刻意没有 url/hash**（`url: None` / `sha256: None` / `file_name: None`）。这是**有意的**：哈希还没核对过，而放一个"没核对过的哈希"等于放一个必然失败的下载按钮。UI 对它们显示「无下载源」并把下载按钮**置灰**。
- 单测 `verified_sources_are_pinned` 强制 url / sha256 / file_name **三者全有或全无**，哈希必须是 64 位小写十六进制，且 `file_name` 不得重复。

```rust
// 代码里 URL 用常量拼接：url: Some(format!("{REMBG_RELEASE}/u2net.onnx"))
EngineModel {
    id: "u2net".into(),
    name: "U²-Net".into(),
    purpose: "通用显著性目标检测 / 抠图，效果均衡。168 MB。".into(),
    approx_size_mb: 176,
    license: "Apache-2.0".into(),
    commercial_use: true,
    url: Some("https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx".into()),
    sha256: Some("8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491".into()),
    file_name: Some("u2net.onnx".into()),
    installed: false,
},
```

**结论：只有上面三个模型能在本文档里写出具体的 URL 与 SHA-256**（第 4 节逐条列出）。其余三个模型的这两列继续标注「待定」，因为代码里就是 `None` —— 写进本文档就是臆造。补齐它们必须先核对真实哈希，再改代码，最后同步本文档（1.1 的维护约定）。

另外有两点必须如实说明：

- `crates/toolforge-engines/engine-sources.json` 是一个**独立于 `EngineModel` 的来源清单**（对应 `registry::EngineSourceSpec`）。
  > ✅ **已回填 6 条**（Windows / Linux 的 `ffmpeg` / `libvips` / `pandoc` / `python`），每条都带**实际核对过的 SHA-256** 与**版本固定直链**；`registry.rs` 规定 `sha256` 为 `None` 时拒绝下载，所以 macOS 三条与 `ffmpeg@linux`（上游是滚动别名）目前仍**不可自动安装**，会返回 `HashRequired`。核对方式与实测版本表见 `docs/ROADMAP.md` §3。
  > **`7zip` 的条目已移除**（原先有，现已删除）：官方只提供安装器，或需要先有 7-Zip 才能解压的 `.7z`（先有鸡还是先有蛋），且那条版本固定直链 `7z2408-extra.7z` **实测 404**。因此 `7zip` 在 `engine_catalog()` 里已改为**仅系统安装**。本文档第 2、4 节的「体积」「安装方式」全部取自 `engine_catalog()`，不与 `engine-sources.json` 混用。
- ✅ **「一键安装」现在真的装成功过（这是新事实，不是设计意图）**：通过应用真实安装过一次 **libvips 8.18.6** —— 下载约 30 MB → SHA-256 校验通过 → 解压 → 被探测为 `installed`，可执行文件落在托管布局的 `…/engines/libvips/bin/vips.exe`，磁盘占用约 29.67 MB。**在此之前这条路径从未被跑通过**，原因不是哈希没回填，而是两个 `toolforge-process` 的缺陷（都已修复、都有回归测试）：
  1. **裸命令名不查 PATH**：`exec_streaming` 曾用 `program.exists()` 判断程序是否存在，而 `Path::new("tar").exists()` 对裸名字**永远是 false**（它按当前工作目录解析，不查 PATH）。引擎安装正是用 `ExecOptions::new("tar")` 解压 `.zip` / `.tar.gz`，于是流程是「下载成功 → SHA-256 校验通过 → 解压时报"可执行文件不存在：tar"」——错误信息还把责任指错了地方。现在由公开函数 `toolforge_process::resolve_program()` 统一解析：裸名字走 PATH（Windows 再按 `PATHEXT` 补后缀），**显式路径永不回退到 PATH**。
  2. **`quiet(true)` 曾经把所有输出都丢掉**：它的语义本该是"只保留尾部"（不累积头部），实际却把 stdout / stderr 一起扔了。后果是 `probe_version` 什么都读不到 → **每个引擎的版本都显示「未知」**，引擎失败时 stderr 也是空的（没有任何可操作的细节）。现在 `quiet` = **只留尾部**，与它自己的文档注释一致，版本能正常显示、失败原因带得住。
- 本文档不给出任何版本号要求。`EngineDescriptor` 中只有 `license`、`licenseNote`、`approxSizeMb`、`platforms`、`installModes` 等字段，**没有最低版本字段**。`EngineState::Outdated`（版本过旧）只是一个运行时枚举值，其最低版本判定标准在代码中尚未定义，属于**待定**。

### 1.4 术语与枚举翻译

| 代码枚举值 | 本文档写法 | 含义 |
| --- | --- | --- |
| `EngineInstallMode::System` | 仅探测系统已安装 | 只探测系统 PATH 与各平台常见安装位置，不下载 |
| `EngineInstallMode::Download` | 应用按需下载 | 由应用托管下载（设计上带 SHA-256 校验） |
| `EngineInstallMode::Pip` | 通过插件私有 venv 安装 | 用 pip 装进插件私有虚拟环境 |
| `EngineInstallMode::Remote` | 远程服务无本地二进制 | 由外部大模型服务提供能力 |

> 注：`Pip` 这个枚举值在 `engine.rs` 中已定义，但当前 `engine_catalog()` 的 11 个引擎**没有任何一个使用它**，所以它在总表里不会出现。这属于已定义但未使用的预留模式。

`core: true` 的含义：**核心引擎**。缺失时应用仍然能正常启动，但依赖它的那批内置节点会变成不可用。这条约束写在 `engine.rs` 的模块注释里：任何一个引擎缺失，**只能让依赖它的节点不可用，绝不能让整个应用起不来**。

---

## 2. 引擎总表

下表为 `engine_catalog()` 中全部 11 个引擎的完整清单。

| 引擎 id | 名称 | 中文说明 | 许可证 | 许可证注意事项 | 体积 | 安装方式 | 提供的节点 | 平台支持 | 需要用户确认许可证 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ffmpeg` | FFmpeg（核心引擎） | 音视频转码、剪辑、抽帧、提取音轨的万能工具。 | `LGPL-2.1+ / GPL-2.0+（取决于编译选项）` | 官方构建常启用 GPL 组件。若你的产品闭源分发，请选用 LGPL 构建或自行编译。 | 约 105 MB（8.1.2 essentials 实测 104.6 MB） | 仅探测系统已安装；应用按需下载 | `video.transcode`<br>`video.trim`<br>`video.thumbnail`<br>`video.extract-audio`<br>`video.compress`<br>`audio.convert`<br>`audio.normalize` | Windows / macOS / Linux | 是 |
| `libvips` | libvips | 低内存、流式的大图处理库。批量处理上千张图时比逐个解码快数倍。 | `LGPL-2.1` | 以动态库方式调用即可满足 LGPL 要求，无需开源你的代码。 | 约 30 MB（8.18.6 x64-web 压缩包实测 10.8 MB） | 仅探测系统已安装；应用按需下载 | `image.convert`<br>`image.resize`<br>`image.enhance`<br>`image.strip-metadata` | Windows / macOS / Linux | 否 |
| `imagemagick` | ImageMagick | 格式覆盖最全的图像处理工具集，作为 libvips 的兜底。 | `ImageMagick License（Apache-2.0 风格）` | 本体宽松，但若链接了 GPL 组件（如部分 delegate）会传染，分发前需确认构建配置。 | 约 60 MB | 仅探测系统已安装；应用按需下载 | `image.convert`<br>`image.resize`<br>`image.crop`<br>`image.rotate`<br>`image.strip-metadata` | Windows / macOS / Linux | 否 |
| `pandoc` | Pandoc（核心引擎） | 文档格式转换的瑞士军刀：Markdown / HTML / DOCX / EPUB / LaTeX 互转。 | `GPL-2.0+` | 以独立进程调用不构成衍生作品，可随闭源应用分发；但不得静态链接进你的二进制。 | 约 40 MB | 仅探测系统已安装；应用按需下载 | `doc.convert`<br>`ebook.convert` | Windows / macOS / Linux | 是 |
| `libreoffice` | LibreOffice (headless) | Office 文档转 PDF 的事实标准。冷启动 2~5 秒，ToolForge 会复用常驻进程。 | `MPL-2.0` | MPL 是文件级 copyleft，独立进程调用无传染风险。 | 约 420 MB | 仅探测系统已安装 | `doc.to-pdf` | Windows / macOS / Linux | 是 |
| `7zip` | 7-Zip（核心引擎） | 压缩解压，覆盖 zip / 7z / rar / tar 等格式。 | `LGPL-2.1+（含 unRAR 限制条款）` | unRAR 代码禁止用于开发 RAR 压缩器；解压用途不受影响。 | 约 5 MB | **仅探测系统已安装**（下载源已移除，见 1.3 节） | `archive.pack`<br>`archive.unpack` | Windows / macOS / Linux | 否 |
| `calibre` | Calibre | 电子书格式转换与元数据管理（EPUB / MOBI / AZW3）。 | `GPL-3.0` | GPL-3.0 为强 copyleft。仅以独立进程调用；如要随包分发请先做合规评审。 | 约 180 MB | 仅探测系统已安装 | `ebook.convert` | Windows / macOS / Linux | 是 |
| `python` | Python 运行时 | L3 插件的执行环境（独立 3.11 运行时，与系统 Python 隔离）。 | `PSF-2.0` | 宽松许可；注意随包分发的第三方 wheel 各自的许可证。 | 约 150 MB | 应用按需下载 | `image.remove-background`<br>`ai.upscale`<br>`doc.ocr` | Windows / macOS / Linux | 否 |
| `onnx-models` | ONNX 模型包 | 抠图 / 超分 / 分割用的模型权重。**不随安装包分发，首次使用时下载**。 | `各模型不同（见下表）` | 代码许可与权重许可是两回事。U2Net 为 Apache-2.0 可商用；MODNet 权重为学术许可；BiRefNet 权重受训练集条款限制。 | 约 180 MB | 应用按需下载 | `image.remove-background`<br>`ai.upscale` | Windows / macOS / Linux | 是 |
| `tesseract` | Tesseract OCR | 离线 OCR。中文识别质量一般，但完全免费且无需联网。 | `Apache-2.0` | 语言数据包（tessdata）另有许可，chi_sim 为 Apache-2.0。 | 约 60 MB | 仅探测系统已安装 | `doc.ocr` | Windows / macOS / Linux | 否 |
| `ai-provider` | AI 服务提供方 | OpenAI 兼容接口的大模型服务，用于插件生成、图像描述等。 | `依服务商条款` | API Key 只存在本机加密存储中，不会随插件或日志外泄。**⚠️ 这句注意事项原文已过期**（没有加密存储、没有钥匙串；见 3.6） | 约 0 MB（无本地二进制） | 远程服务无本地二进制 | `ai.describe` | Windows / macOS / Linux | 否 |

### 2.1 总表读法

- **核心引擎共 3 个**：`ffmpeg`、`pandoc`、`7zip`。它们在名称后标注了「（核心引擎）」。缺失时应用**仍然能启动**，但依赖它们的节点不可用：`ffmpeg` 缺失 → 5 个 `video.*` 与 2 个 `audio.*` 节点不可用；`pandoc` 缺失 → `doc.convert` 不可用，并且 `ebook.convert` 失去唯一的纯文档转换后端；`7zip` 缺失 → `archive.pack` / `archive.unpack` 不可用。
- **只有 `System` 一种安装方式的引擎共 4 个**：`libreoffice`（约 420 MB）、`calibre`（约 180 MB）、`tesseract`（约 60 MB）、`7zip`（约 5 MB）。这四个都只探测系统安装、不提供应用内下载。
- **只有 `Download` 一种安装方式的引擎共 2 个**：`python`、`onnx-models`。
  > ⚠️ **这句原来接着写的是「二者不探测系统安装」—— 那是错的（本条已修正）。** `install_modes` 只决定「应用能不能替你下载」，**不决定探测范围**：`probe()` 的顺序是 ① 托管目录 → ② PATH → ③ 平台常见路径，对所有引擎一视同仁。所以系统里已有的 Python 会被探到，状态是 `Detected` / `source: System`。这恰恰是 `force` 标志与「另外安装应用托管版本」按钮存在的原因 —— **"探测到可用"不等于"满足这个节点的要求"**，系统 Python 3.14 显示可用却跑不了 `onnxruntime`（见 3.2、3.6）。`onnx-models` 是唯一的例外，它没有二进制，走下面那条虚拟引擎判据。
- **只有 `Remote` 一种安装方式的引擎共 1 个**：`ai-provider`。体积记为 0 MB，因为它没有本地二进制。
- **需要用户确认许可证（`requiresLicenseAck: true`）的引擎共 5 个**：`ffmpeg`、`pandoc`、`libreoffice`、`calibre`、`onnx-models`。UI 必须在用户点击「下载」之前就把许可证讲清楚（这是 `engine.rs` 中 `licenses` 字段刻意保留的原因）。
- **全部 11 个引擎都声明支持三平台**：Windows / macOS / Linux。当前目录中没有平台受限的引擎。

---

## 3. 按功能域分组的引擎说明

本章逐个说明每个引擎：它提供哪些内置节点、缺失时会发生什么、许可证与分发注意点。所有「提供的节点」均取自该引擎的 `provides` 字段。

### 3.1 音视频域

#### FFmpeg（`ffmpeg`，核心引擎）

- **主页**：https://ffmpeg.org/
- **提供的节点（7 个）**：`video.transcode`、`video.trim`、`video.thumbnail`、`video.extract-audio`、`video.compress`、`audio.convert`、`audio.normalize`。
- **缺失时会发生什么**：上述 7 个节点**全部不可用**，没有降级路径。这是全部功能域中影响面最大的单点依赖——音视频域目前只有这一个引擎。UI 应显示「需要安装 FFmpeg」并提供下载入口。
- **许可证与分发注意点**：`LGPL-2.1+ / GPL-2.0+（取决于编译选项）`。官方构建常启用 GPL 组件，如果产品闭源分发，必须选用 LGPL 构建或自行编译。`requiresLicenseAck: true`，下载前必须让用户确认。

#### 音频节点与 FFmpeg 的关系

`audio.convert` 与 `audio.normalize` 同样只依赖 `ffmpeg`（`requiresEngines` 为 `["ffmpeg"]`），没有独立的音频引擎。因此**音频域不存在独立降级空间**：FFmpeg 缺失即两个音频节点不可用。

### 3.2 图像域

#### libvips（`libvips`）

- **主页**：https://www.libvips.org/
- **提供的节点（4 个）**：`image.convert`、`image.resize`、`image.enhance`、`image.strip-metadata`。注意其中 `image.enhance` 只由 libvips 一家声明提供。
- **缺失时会发生什么**：这 4 个节点不会失效，因为它们的 `requiresEngines` 都是空数组，libvips 只是 `optionalEngines` 中的首选。缺失后自动降级：先退到 ImageMagick，两者都缺失时退到纯 Rust 的 `image` crate。代价是批量/大图场景更慢、更吃内存（libvips 的价值正是在于低内存、流式处理）。
  > ✅ **这条降级链现在是真的 —— 但只覆盖 4 个节点**：`nodes.rs::pick_image_backend()` 真的按 `libvips → imagemagick → 纯 Rust` 的顺序挑后端，并把用的是哪个报在节点输出的 `backend` 里（详见 5.1）。走这条链的是 **`image.convert` / `image.resize` / `image.crop` / `image.rotate`**；而 **`image.enhance` 与 `image.strip-metadata` 仍然是纯 Rust 实现、一行都不问引擎** —— 所以"libvips 提供 `image.enhance` / `image.strip-metadata`"这两条 `provides` 声明目前比实现更乐观（见 6.2）。
- **已实测的一键安装**：libvips 8.18.6 通过应用安装成功，可执行文件落在托管布局的 `…/engines/libvips/bin/vips.exe`，磁盘占用约 29.67 MB（数据点与顺带修掉的两个 `toolforge-process` 缺陷见 1.3）。
- **许可证与分发注意点**：`LGPL-2.1`。以动态库方式调用即可满足 LGPL 要求，无需开源你自己的代码——这也是它被选为图像域首选引擎的原因。`requiresLicenseAck: false`。

#### ImageMagick（`imagemagick`）

- **主页**：https://imagemagick.org/
- **提供的节点（5 个）**：`image.convert`、`image.resize`、`image.crop`、`image.rotate`、`image.strip-metadata`。其中 `image.rotate` 只有它一家声明提供。
- **缺失时会发生什么**：节点仍可用（都不是必需引擎），但 `image.convert` / `image.resize` / `image.crop` 会失去第二层兜底（libvips 仍优先）。`image.rotate` 的处境要看实现而不是看声明：`imagemagick` 是它唯一声明提供该能力的引擎，但 `nodes.rs::image_rotate` 在 libvips 可用时也会走 libvips（非 90° 倍数用 `vips similarity --angle`，ImageMagick 用 `-rotate`），**只有两个都没有、只剩纯 Rust 时**才返回 `EngineMissing`（见 5.1）。
- **许可证与分发注意点**：`ImageMagick License（Apache-2.0 风格）`，本体宽松；但若链接了 GPL 组件（如部分 delegate）会传染，分发前需确认构建配置。`requiresLicenseAck: false`。

#### Python 运行时 + ONNX 模型包（抠图与超分）—— **ONNX 路径，不属于三层降级链**

- 见 3.6 中的 `python` 与 `onnx-models` 条目。图像域的 `image.remove-background`（抠图去背景）**同时要求两个引擎**（`requiresEngines: ["python", "onnx-models"]`），任一缺失即不可用，且没有降级路径。
- **它不属于上面那张 `libvips → ImageMagick → 纯 Rust` 的表**。这一条很容易被误读，必须写清楚：**抠图是第四条路（ONNX 推理），三层降级一格都不覆盖它。** libvips / ImageMagick 再全，也做不了"从图里判断哪个像素是主体"这件事——那是模型的工作，不是图像处理库的工作。反过来，装齐两个引擎也**不会**让抠图在缺 libvips 时变慢，因为它压根不经过 `pick_image_backend()`。
- **执行方式**：`nodes.rs::image_remove_background` 不自己做推理，而是把推理交给一个 **Python 子进程**（`python` 引擎）。
  - 推理脚本是 `crates/toolforge-engines/py/rembg.py`，用 `include_str!` 编进二进制，运行时释放到 `<data>/cache/onnx-runtime/rembg.py`。**刻意不做成 Tauri 的 bundle resource**：资源路径在开发态 / 打包态 / 各平台之间都不一样，而这个脚本只有几 KB，一旦"从包里找不到"就是一个极难查的运行时故障——编进二进制就不会丢。
  - **为什么不写在 Rust 里**：Rust 的 ONNX 绑定 `ort` 会在**构建期**下载预编译原生库。那会让离线 / 内网构建直接失败，而"构建失败"的代价远大于"多一个运行时依赖"。Python 的 `onnxruntime` 是成熟、可验证、进程内隔离的路径，而且 L3 插件运行时本来就要求一个受管 Python——复用它不引入新的东西。
- **首次运行要准备两件事**，都会写进任务日志：
  1. **模型权重**：用户在「设置 → 引擎管理 → 模型权重」里自己下（见第 4 节）。节点不会替用户偷偷下载权重。
  2. **依赖**：应用会在 `<data>/cache/onnx-runtime/` 下**另建一个独立 venv**，`pip install onnxruntime numpy pillow`（约 30 MB，一次性）。用独立 venv 是为了**不动用户自己的 Python**，卸载也只是删掉这个目录。
  - ⚠️ **这一步需要联网**。第一次跑抠图时才会发生，而且只有这一个节点会触发；此后推理**完全本地、不联网、不上传图片**。**没有网络的机器在依赖就位之前用不了这个节点。**
- **Python 版本要求：3.9 ~ 3.13**。原因是 `onnxruntime` 没有 3.14 的 wheel。若机器上只有 3.14，节点会返回一条明确的 `EngineMissing`，告诉用户去装应用托管的 Python 3.11，而不是抛一个看不懂的 pip 报错。
- **「探测到可用」不等于「满足我的要求」**：系统里那个 3.14 会被引擎管理显示为"可用"，但它跑不了 onnxruntime。因此 `EngineInstallRequest` 增加了 **`force`** 标志：`force: true` 会跳过「已经可用，不用下载」的短路，让用户**在系统 Python 之外**再装一份应用托管的副本。引擎卡片上对应一个「另外安装应用托管版本」按钮（当 `status.source === "system"` 且 `entry.managedAvailable` 时显示），背后是 `EngineEntry.managedAvailable` 与 `EngineRegistry::has_download_source()`。

### 3.3 文档域

#### Pandoc（`pandoc`，核心引擎）

- **主页**：https://pandoc.org/
- **提供的节点（2 个）**：`doc.convert`、`ebook.convert`。
- **缺失时会发生什么**：`doc.convert` **不可用**（`requiresEngines: ["pandoc"]`，无降级）。`ebook.convert` 不会因此被标记为不可用（它的 `requiresEngines` 是空数组），但会失去唯一可用的降级后端——只剩 `calibre`。若 `calibre` 也不在，`ebook.convert` 将没有任何可用后端。
- **许可证与分发注意点**：`GPL-2.0+`。以独立进程调用不构成衍生作品，可随闭源应用分发；**但不得静态链接进你的二进制**。`requiresLicenseAck: true`。

#### LibreOffice (headless)（`libreoffice`）

- **主页**：https://www.libreoffice.org/
- **提供的节点（1 个）**：`doc.to-pdf`。
- **缺失时会发生什么**：`doc.to-pdf` **不可用**，无降级路径（`requiresEngines: ["libreoffice"]`）。UI 应说明这是「仅探测系统已安装」的引擎，即**必须由用户自行安装 LibreOffice**，应用不提供下载。考虑到约 420 MB 的体积与冷启动 2~5 秒的开销，UI 提示里应明确这一点。
- **许可证与分发注意点**：`MPL-2.0`，文件级 copyleft，独立进程调用无传染风险。`requiresLicenseAck: true`。

#### Tesseract OCR（`tesseract`）

- **主页**：https://github.com/tesseract-ocr/tesseract
- **提供的节点（1 个）**：`doc.ocr`。
- **缺失时会发生什么**：`doc.ocr` 的 `requiresEngines` 是 `["python"]`，`tesseract` 只列在 `optionalEngines` 中。因此：`tesseract` 缺失**不会**让节点失效；但 `python` 缺失会让节点完全不可用（无降级）。该节点的描述原文是「图片/扫描件转文字。默认走系统 OCR，装了 PaddleOCR 时质量更高。」——也就是说默认路径走系统 OCR，装了更高阶的方案（PaddleOCR）时质量更好。
- **许可证与分发注意点**：`Apache-2.0`。语言数据包（tessdata）另有许可，`chi_sim` 为 Apache-2.0。`requiresLicenseAck: false`。仅探测系统安装，不提供应用内下载。

### 3.4 压缩包域

#### 7-Zip（`7zip`，核心引擎）

- **主页**：https://www.7-zip.org/
- **提供的节点（2 个）**：`archive.pack`、`archive.unpack`。
- **缺失时会发生什么**：两个节点**都不可用**，无降级路径（`requiresEngines: ["7zip"]`）。`7zip` 现在**只支持系统安装**（官方只提供安装器，或需要先有 7-Zip 才能解压的 `.7z`；原候选直链已 404），因此 UI 应直接引导到 https://www.7-zip.org/ ，而不是给一个"一键下载"按钮。
- **许可证与分发注意点**：`LGPL-2.1+（含 unRAR 限制条款）`。unRAR 代码禁止用于开发 RAR 压缩器；**解压用途不受影响**。`requiresLicenseAck: false`——注意这是唯一一个 `core: true` 但不需要许可证确认的引擎。

### 3.5 电子书域

#### Calibre（`calibre`）

- **主页**：https://calibre-ebook.com/
- **提供的节点（1 个）**：`ebook.convert`。
- **缺失时会发生什么**：`ebook.convert` 的 `requiresEngines` 为空，`optionalEngines` 为 `["calibre", "pandoc"]`，即 `calibre` 是首选、`pandoc` 是兜底。`calibre` 缺失后降级到 `pandoc`，但 `pandoc` **只覆盖 EPUB/HTML**，**MOBI / AZW3 输出将不可用**。两个引擎都缺失时，该节点在代码层面仍不会被判为不可用（因为没有必需引擎），但实际上没有任何可用后端——这一边界需要在 `toolforge-engines` 的 `nodes` 模块里明确定义并反映到 UI 上。
- **许可证与分发注意点**：`GPL-3.0`，强 copyleft。仅以独立进程调用；**如要随包分发请先做合规评审**。`requiresLicenseAck: true`。与 `libreoffice`、`tesseract` 一样，它也只有 `System` 一种安装方式。

### 3.6 AI 域与跨域运行时

#### Python 运行时（`python`）

- **主页**：https://www.python.org/
- **提供的节点（3 个）**：`image.remove-background`、`ai.upscale`、`doc.ocr`。
- **缺失时会发生什么**：这 3 个节点**全部不可用**，因为 `python` 在它们三个的 `requiresEngines` 里都是必需引擎，没有降级路径。这是影响面仅次于 FFmpeg 的单点依赖：图像抠图、AI 超分、OCR 三个能力都以它为前置。
- **许可证与分发注意点**：`PSF-2.0`，宽松许可；但要注意随包分发的第三方 wheel 各自的许可证。它**只有 `Download` 一种安装方式**，说明这是独立于系统 Python 的 3.11 运行时（与系统 Python 隔离）。`requiresLicenseAck: false`。
- **版本区间：3.9 ~ 3.13**。上界不是随便定的：`onnxruntime` 没有 Python 3.14 的 wheel，所以抠图节点在 3.14 上跑不起来，会返回明确的 `EngineMissing` 让用户去装应用托管的 3.11。**注意"探测为可用"与"满足某个节点的要求"是两件事** —— 系统里的 3.14 在引擎管理里显示可用，但用不了抠图；这也是 `EngineInstallRequest.force` 存在的原因（见 3.2 末段）。

#### ONNX 模型包（`onnx-models`）

- **主页**：https://onnxruntime.ai/
- **提供的节点（2 个）**：`image.remove-background`、`ai.upscale`。
- **缺失时会发生什么**：这两个节点不可用（与 `python` 一样是必需引擎）。它是**唯一带模型权重清单的引擎**（6 个模型，见第 4 节），也是唯一需要单独做许可证确认的模型入口。
- **它是「虚拟引擎」，探测规则与别的引擎不同**：`onnx-models` 没有可执行文件，它只是权重文件的宿主，「有没有 `onnx-models.exe`」这个问题本身就是错的。
  > ✅ **这条曾经是坏的**：`probe()` 只对 `install_modes == [Remote]` 的引擎做特判，`onnx-models` 落到普通分支，于是**永远探测为 `Missing`** —— 后果是 `image.remove-background` 在界面上**永远显示不可用，哪怕用户已经把权重下好了**。现在 `probe()` 对 `onnx-models` 单独判：**至少有一个权重已安装 = 可用**，message 里也会点名当前是"还没下权重"还是"已下载 N 个"。这条规则写在 `registry.rs::probe()` 里。
- **许可证与分发注意点**：许可证字段本身写的是「各模型不同（见下表）」，注意事项是「代码许可与权重许可是两回事。U2Net 为 Apache-2.0 可商用；MODNet 权重为学术许可；BiRefNet 权重受训练集条款限制。」体积标注约 180 MB（这只是 `approxSizeMb` 字段给出的引擎级估算；注意 6 个模型逐个加起来远超此值，且模型按需下载、不随安装包分发）。`requiresLicenseAck: true`。

#### AI 服务提供方（`ai-provider`）

- **主页**：https://platform.openai.com/docs/api-reference
- **提供的节点（1 个）**：`ai.describe`。
- **缺失时会发生什么**：`ai.describe` **不可用**，无降级路径（`requiresEngines: ["ai-provider"]`）。由于它是 `Remote` 模式的引擎，不存在「安装包」意义上的缺失，缺失等价于「未配置可用的服务商 / API Key」。
- **许可证与分发注意点**：`依服务商条款`——许可证不取决于 ToolForge，而取决于用户接的是哪家服务。注意事项原文是「API Key 只存在本机加密存储中，不会随插件或日志外泄」，**这句话本身已经过期**（见 1.3 节末尾的说明与 `docs/SECURITY.md` 的凭据落盘一节）：仓库里**没有**加密存储，也没有 OS 钥匙串，Key 默认只在内存里，只有用户显式打开「记住 API Key」时才会明文写到 `<data_dir>/ai-key.txt`。`requiresLicenseAck: false`。

### 3.7 无引擎依赖的功能域

下表这些节点在 `builtin_nodes()` 中 `requiresEngines` 与 `optionalEngines` 都是空数组，它们不经过引擎层，永远可用：

| 功能域 | 节点 | 说明 |
| --- | --- | --- |
| 文件操作 | `fs.copy`、`fs.move`、`fs.mkdir`、`fs.delete` | 纯 Rust 文件系统操作 |
| 图片（探测） | `image.probe` | 读取图片信息，纯 Rust 解码 |
| 流程控制 | `flow.branch`、`flow.set-var`、`flow.log` | 流程编排原语，不涉及外部进程 |
| 文本 | `text.replace` | 纯 Rust 字符串替换，不涉及外部进程 |
| 命名 | `name.build` | 纯 Rust 拼装文件名（可用 `${batch.index}` / `${src.stem}`） |

这三个 `flow.*` 节点是保证「即使一个引擎都没装，流程编辑器仍然能用」的底线能力。

> ⚠️ 这里曾经还有第 4 个：`flow.foreach`。它已经被**整个删除**，不是"留着不实现"。原因是它的语义在 L1 里没法定义（步骤列表是平铺的，循环体到底包含哪些步骤、循环之后的收尾步骤怎么办都没有答案），而它描述里写的「宿主会按并发度并行调度」是**假的** —— 宿主不在流水线内部调度。批量已经由宿主在**命令层**解决：`commands.rs::expand_batches` 把多文件输入与**目录输入**扇出成单文件批次，逐批调用流水线，清单里用 `${batch.index}` 取序号。所以节点目录里不需要循环节点。

---

## 4. 模型权重表

`onnx-models` 引擎下共 6 个模型权重。模型刻意与引擎本身分开：权重体积大、许可证各异，而且很多是「只有用了这个功能才需要」。

| 模型 id | 名称 | 用途 | 体积 | 权重许可证 | 是否可商用 | 下载地址 | SHA-256 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `u2net` | U²-Net | 通用显著性目标检测 / 抠图，效果均衡 | 约 176 MB | `Apache-2.0` | 是 | `…/rembg/releases/download/v0.0.0/u2net.onnx` | `8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491`（175,997,641 字节） |
| `u2netp` | U²-Net (轻量) | U²-Net 的轻量版，速度快约 3 倍，边缘略糊 | 约 5 MB | `Apache-2.0` | 是 | `…/rembg/releases/download/v0.0.0/u2netp.onnx` | `309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8`（4,574,861 字节） |
| `isnet-general` | IS-Net General | 通用抠图，对复杂边缘处理更好 | 约 176 MB | `Apache-2.0` | 是 | `…/rembg/releases/download/v0.0.0/isnet-general-use.onnx` | `60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a`（178,648,008 字节） |
| `birefnet-general` | BiRefNet | 当前抠图 SOTA，发丝级边缘 | 约 900 MB | `MIT（代码）/ 权重另有条款` | **否** | **无下载源**（`url` / `sha256` / `file_name` 均为 `None`，UI 显示「无下载源」且下载按钮置灰） | 同上 |
| `modnet-portrait` | MODNet Portrait | 人像专用抠图（视频会议 / 证件照场景） | 约 25 MB | `Apache-2.0（代码）/ 学术用途权重` | **否** | **无下载源**（同上一行） | 同上 |
| `realesrgan-x4plus` | Real-ESRGAN x4plus | 通用图像超分辨率放大 | 约 67 MB | `BSD-3-Clause` | 是 | **无下载源**（同上一行） | 同上 |

> 「下载地址」与「SHA-256」两列的说明见第 1.3 节。前三个模型的地址与哈希来自 `engine_catalog()`，且哈希是**真实下载后算出来的**（不是抄网页）；下载路径是 `<data_dir>/models/<model_id>/<file_name>`，`file_name` 与模型 id 不同名。后三个模型在代码里就是 `None`，**不得凭推测填写**；单测 `verified_sources_are_pinned` 守着"三个字段全有或全无"这条纪律。
>
> **抠图节点的默认模型是 `u2netp`（4.4 MB），不是 `u2net`（168 MB）。** 这条是**改过**的：原来的默认是 `u2net`，等于"想试一下抠图，先下 168 MB"。既然这个功能的瓶颈就是"第一次能不能跑起来"，默认值就该给最轻的那个。`model` 参数的枚举只有 `u2netp` / `u2net` / `isnet-general` —— 三个有下载源的，其余三个没有来源的模型**不出现在选项里**。

### 4.1 商业使用结论（必须落实到 UI）

依据 `EngineModel.commercialUse` 字段：

**可以商用（`commercialUse: true`，共 4 个）**

| 模型 id | 名称 | 权重许可证 |
| --- | --- | --- |
| `u2net` | U²-Net | `Apache-2.0` |
| `u2netp` | U²-Net (轻量) | `Apache-2.0` |
| `isnet-general` | IS-Net General | `Apache-2.0` |
| `realesrgan-x4plus` | Real-ESRGAN x4plus | `BSD-3-Clause` |

**不可商用（`commercialUse: false`，共 2 个）**

| 模型 id | 名称 | 权重许可证 | 不可用的原因 |
| --- | --- | --- | --- |
| `birefnet-general` | BiRefNet | `MIT（代码）/ 权重另有条款` | 代码是 MIT，但**权重另有条款**，`commercialUse` 明确为 `false` |
| `modnet-portrait` | MODNet Portrait | `Apache-2.0（代码）/ 学术用途权重` | 代码是 Apache-2.0，但**权重为学术用途许可**，`commercialUse` 明确为 `false` |

**UI 必须遵守的硬性要求：**

1. **`BiRefNet` 与 `MODNet Portrait` 不可商用**，UI 必须在模型选择处明确提示，且不得把二者列为默认选项或推荐项。
2. 这两个模型的价值恰恰很高（BiRefNet 是「当前抠图 SOTA，发丝级边缘」，MODNet 是人像场景专用），因此提示文案要写清楚「效果好但不允许商用」，而不是简单隐藏——否则用户无法理解为什么质量更好的模型不能选。
3. `EngineModel` 的注释已明确「权重许可证可能与代码许可证不同！」，因此 UI **不能**用引擎级或代码级许可证去代表权重许可证。`onnx-models` 引擎的 `requiresLicenseAck: true` 正是为此设置：**下载模型前必须让用户确认许可证**。
4. `engine.rs` 中的测试 `model_licenses_are_explicit` 断言「至少要有一个明确不可商用的模型，提醒用户」，说明这一提示是有测试保障的产品要求，不应在 UI 实现中被省略。

---

## 5. 降级矩阵

本章依据 `NodeDescriptor` 的 `requiresEngines`（必需引擎）与 `optionalEngines`（可选引擎）逐节点列出降级行为。

**核心规则（来自 `pipeline.rs` 的字段注释）：**

- **必需引擎缺失 → 该节点不可用。** UI 里显示「需要安装 XXX」。
- **可选引擎缺失 → 自动降级，功能仍在。**

### 5.1 无必需引擎：始终可用或可降级的节点（17 个）

下表节点的 `requiresEngines` 均为空数组，因此**不会因为任何引擎缺失而变成不可用**。

| 内置节点 | 所需能力 | 主引擎 | 主引擎缺失时的降级路径 | 降级后的能力损失 |
| --- | --- | --- | --- | --- |
| `fs.copy` | 无（不依赖外部引擎，纯 Rust） | 无 | 不适用——永远可用 | 无 |
| `fs.move` | 无（不依赖外部引擎，纯 Rust） | 无 | 不适用——永远可用 | 无 |
| `fs.mkdir` | 无（不依赖外部引擎，纯 Rust） | 无 | 不适用——永远可用 | 无 |
| `fs.delete` | 无（不依赖外部引擎，纯 Rust） | 无 | 不适用——永远可用 | 无 |
| `image.probe` | 无（纯 Rust 解码，读取图片信息） | 无 | 不适用——永远可用 | 无 |
| `image.convert` | 图片格式转换（可选：`libvips`、`imagemagick`） | `libvips`（可选，非必需） | `libvips` 缺失 → ImageMagick → 两者都缺失 → 纯 Rust `image` crate 打底（**✅ 实测走通**，节点输出含 `backend`） | 批量/大图更慢、更吃内存；失去 libvips 的流式低内存优势；退回纯 Rust 时可用格式覆盖变窄，**且 WebP 只能无损编码**（丢掉"按质量换体积"的能力） |
| `image.resize` | 图片缩放（可选：`libvips`、`imagemagick`） | `libvips`（可选，非必需） | `libvips` 缺失 → ImageMagick → 两者都缺失 → 纯 Rust `image` crate 打底（**✅ 实测走通**，节点输出含 `backend`） | 同上：更慢、更吃内存，缩放算法与格式覆盖可能变少 |
| `image.crop` | 裁剪 / 缩略图（可选：`libvips`、`imagemagick`） | `libvips`（可选，非必需） | `libvips` 缺失 → ImageMagick → 两者都缺失 → 纯 Rust `image` crate 打底（**✅ 实测走通**，节点输出含 `backend`；但 `libvips.provides` 没声明这个能力，见第 6.2 节） | 同上：更慢、更吃内存 |
| `image.rotate` | 旋转 / 翻转（可选：`imagemagick`） | `imagemagick`（可选，非必需） | `libvips`（实现里也能接手，见下）→ `imagemagick` → 两者都缺失 → 纯 Rust `image` crate **只支持 90° 整数倍**，非直角直接报 `EngineMissing`（**✅ 实测走通**，节点输出含 `backend`） | 更慢、更吃内存；**只剩纯 Rust 时任意角度旋转能力丧失**（不是静默取整，而是明确报错要用户装引擎） |
| `image.enhance` | 图像增强（可选：`libvips`） | `libvips`（可选，非必需） | 🚧 **没有降级链，只有纯 Rust 一条路**：该节点的实现既不问后端、也不调用 libvips（见下） | 与"降级"无关：无论装了什么引擎，`image.enhance` 都走内置卷积 |
| `image.strip-metadata` | 清除元数据（可选：`libvips`、`imagemagick`） | `libvips`（可选，非必需） | 🚧 **同上一行：只有纯 Rust 实现**（重新编码即不保留 EXIF/IPTC/XMP），`pick_image_backend()` 没有被它调用 | 与"降级"无关：装不装引擎，行为都一样；对部分容器格式的元数据块清理可能不完整 |
| `ebook.convert` | 电子书格式转换（可选：`calibre`、`pandoc`） | `calibre`（可选，非必需） | `calibre` 缺失 → `pandoc`（**仅覆盖 EPUB / HTML**）；`pandoc` 也缺失 → 没有任何可用后端 | **MOBI / AZW3 输出能力完全丧失**；只剩 EPUB/HTML 互转。两个后端都缺失时，该节点虽不被判为不可用，但实际无法完成任何转换（见第 6.3 节） |
| `flow.branch` | 无（流程编排原语） | 无 | 不适用——永远可用 | 无 |
| `flow.set-var` | 无（流程编排原语） | 无 | 不适用——永远可用 | 无 |
| `flow.log` | 无（流程编排原语） | 无 | 不适用——永远可用 | 无 |
| `text.replace` | 无（纯 Rust 文本处理） | 无 | 不适用——永远可用 | 无 |
| `name.build` | 无（纯 Rust 字符串拼装） | 无 | 不适用——永远可用 | 无 |

**关于图像域的补充说明：** `image.convert` / `image.resize` / `image.crop` / `image.rotate` / `image.enhance` / `image.strip-metadata` 这 6 个节点都是「纯 Rust `image` crate 打底」，缺失可选引擎时**仍然工作**，只是更慢、更吃内存（其中前 4 个已经真的会挑外部后端，后 2 个目前只有纯 Rust 一条路，见上）。整个 `toolforge-engines` 的降级**设计**就是围绕这一点展开的（见该 crate `src/lib.rs` 的模块注释）——图像处理是唯一设想中做三层降级的领域，因为纯 Rust 路径能兜住基础能力：

```text
libvips（快、省内存）  ──缺失──►  ImageMagick（格式最全）  ──缺失──►  纯 Rust image crate
                                                                      （零依赖，始终可用）
```

> ✅ **这条链路现在是"真的"了 —— 但要看清它覆盖了哪几个节点。** 新增的 `nodes.rs::pick_image_backend()` 会按上面的顺序真的挑一个后端（每次调用都问一遍引擎注册表；`is_available` 读的是带缓存的状态，不会每个文件都 spawn 一次 `vips --version`），并且**把用的是哪个后端报出来**：
>
> - 节点输出里多一个值 **`backend`**，取值为 `"libvips"` / `"imagemagick"` / `"rust"`，后续步骤可以用 `${steps.<id>.backend}` 引用；
> - 任务日志里多一条 debug 行，形如 `image.convert：后端 = libvips（快、省内存）；a.png → a.webp（质量 90）`。
> - 理由（代码注释原文的意思）：后端选择一旦不可观测，"到底走没走 libvips"就只能靠猜 —— 而这个项目已经被"文档说有、实际没有"坑过好几次。
>
> **走这条链的是 4 个节点**：`image.convert`、`image.resize`、`image.crop`、`image.rotate`。
> **不走这条链的是 2 个节点**：`image.enhance` 与 `image.strip-metadata` —— 它们**仍然是纯 Rust 实现**，既不调用 `pick_image_backend()`，也不产生 `backend` 输出。所以 `libvips.provides` 里的 `image.enhance` / `image.strip-metadata`、以及 `imagemagick.provides` 里的 `image.strip-metadata`，这些声明目前**仍然只是声明**（见 6.2）。
>
> **`image.rotate` 的任意角度（非 90° 倍数）在新实现下的行为**：libvips 可用时走 `vips similarity --angle N`；ImageMagick 可用时走 `-rotate N`；**只有纯 Rust 可用时返回明确的 `EngineMissing`**，detail 让用户去「设置 → 引擎管理」装 libvips 或 ImageMagick。它**不会**静默把角度取整 —— 取整会让用户以为"转了 45°"，实际拿到一张没转的图。`verify-platform.mjs` 的【7】号检查盯着这一点。
>
> **libvips 档位带来的真实收益要说准**：装了 libvips 后 WebP / JPEG 会按请求的画质做**有损**编码，而纯 Rust 后端的 WebP **只能无损**。准确的说法是"**按质量换体积的能力**"（这对照片很重要）。**不要写成"有损一定更小"**：实测在一张 320×200 的**合成渐变**图上，无损 508 字节反而小于有损 1808 字节 —— 合成图本来就会被无损压得极小，所以 `verify-platform.mjs`【6】只断言"确实走了有损编码"，**刻意不断言体积**。要证明"照片会更小"，得拿真实照片测。

但要注意每个节点的可选引擎清单并不相同，而且**清单与实现并不总是一致**：`image.enhance` 在 `optionalEngines` 里只列了 `libvips` 一个（实现里则一个都不调）；`image.rotate` 的清单只列 `imagemagick`，实现却会优先用 `libvips`。以 `builtin_nodes()` 的字段为准的只有"节点可用性"（有必需引擎时的判定），**"实际会调用哪个引擎"必须以 `nodes.rs` 的实现为准**。

### 5.2 必需引擎非空：没有降级路径，缺失即不可用（15 个）

**这一节的结论必须原样落到 UI 上：这些节点不存在降级方案。** `toolforge-engines/src/lib.rs` 的模块注释写得很直接：「音视频/文档/压缩包没有纯 Rust 替代品，所以走『必需引擎缺失 → 该节点不可用』并在 UI 上直接引导安装。**不假装能跑**。」

| 内置节点 | 所需能力 | 主引擎 | 主引擎缺失时的降级路径 | 降级后的能力损失 |
| --- | --- | --- | --- | --- |
| `image.remove-background` | 抠图去背景（ONNX 推理） | `python` + `onnx-models`（**均为必需**） | **无降级路径**（也**不参与** 5.1 的 libvips / ImageMagick / 纯 Rust 三层链 —— 这是第四条路，见 3.2） | 节点完全不可用。UI 显示「需要安装 Python 运行时」与「需要安装 ONNX 模型包」，并分别提供下载入口（两者都是 `Download` 模式，可应用内获取）。**`onnx-models` 走虚拟引擎判据**：已下过至少一个权重才算可用（见 3.6）。手动装齐两个引擎后，**首次运行仍需联网**装 `onnxruntime numpy pillow` 到 `<data>/cache/onnx-runtime/` 的独立 venv（约 30 MB，一次性） |
| `video.transcode` | 音视频转码 | `ffmpeg`（必需） | **无降级路径** | 节点完全不可用。UI 显示「需要安装 FFmpeg」并提供下载入口 |
| `video.extract-audio` | 提取音轨 | `ffmpeg`（必需） | **无降级路径** | 节点完全不可用。同上提示 |
| `video.thumbnail` | 视频抽帧 / 缩略图 | `ffmpeg`（必需） | **无降级路径** | 节点完全不可用。同上提示 |
| `video.trim` | 视频剪辑 | `ffmpeg`（必需） | **无降级路径** | 节点完全不可用。同上提示 |
| `video.compress` | 视频压缩 | `ffmpeg`（必需） | **无降级路径** | 节点完全不可用。同上提示 |
| `audio.convert` | 音频转码 | `ffmpeg`（必需） | **无降级路径** | 节点完全不可用。同上提示 |
| `audio.normalize` | 音量归一化 | `ffmpeg`（必需） | **无降级路径** | 节点完全不可用。同上提示 |
| `doc.convert` | 文档格式转换 | `pandoc`（必需） | **无降级路径** | 节点完全不可用。UI 显示「需要安装 Pandoc」并提供下载入口 |
| `doc.to-pdf` | Office 文档转 PDF | `libreoffice`（必需） | **无降级路径** | 节点完全不可用。UI 显示「需要安装 LibreOffice (headless)」，且必须说明该引擎**只有系统安装模式**，需用户自行安装（约 420 MB） |
| `doc.ocr` | 图片 / 扫描件转文字 | `python`（必需）；`tesseract` 为可选 | **`python` 缺失时无降级路径**——它是必需引擎。`tesseract` 缺失不影响节点可用性，只影响是否走系统 OCR 路径 | `python` 缺失 → 节点完全不可用，UI 显示「需要安装 Python 运行时」。节点描述原文：「图片/扫描件转文字。默认走系统 OCR，装了 PaddleOCR 时质量更高。」 |
| `archive.pack` | 打包压缩 | `7zip`（必需） | **无降级路径** | 节点完全不可用。UI 显示「需要安装 7-Zip」；建议优先引导系统安装 |
| `archive.unpack` | 解压 | `7zip`（必需） | **无降级路径** | 节点完全不可用。同上提示 |
| `ai.upscale` | 图像超分辨率放大 | `python` + `onnx-models`（**均为必需**） | **无降级路径** | 节点完全不可用。UI 显示「需要安装 Python 运行时」与「需要安装 ONNX 模型包」 |
| `ai.describe` | 图像描述 / 大模型调用 | `ai-provider`（必需） | **无降级路径** | 节点完全不可用。由于该引擎是 `Remote` 模式，UI 应引导用户配置服务商与 API Key，而不是「下载」 |

**不要为这一节编造降级方案。** 例如「`video.transcode` 缺失 FFmpeg 时改用纯 Rust 解码」这类说法在当前代码与依赖里没有任何依据：workspace 的依赖清单中没有纯 Rust 的音视频转码库，`toolforge-engines` 的模块注释也明确说明音视频/文档/压缩包没有纯 Rust 替代品。此类建议如需成立，必须先改代码、再改本文档（见 1.1 的维护约定）。

**实现现状（快照，详见第 6.6、6.7 节）：** `crates/toolforge-engines/src/nodes.rs` 的 `run()` 分发函数已实现 28 个节点。本节涉及的节点中，`archive.pack` / `archive.unpack` 已实现且确实**硬依赖** `7zip`（实现里是 `ctx.engine("7zip").await?`，缺失即报错），与本节的「无降级路径」结论一致；`video.*` / `audio.*` / `doc.convert` / `doc.to-pdf` 同样以必需引擎为准；**`image.remove-background` 也已实现并在真机上跑通整条链路**（模型 + 独立 venv + ONNX 推理，见 3.2）。但 `doc.ocr`、`ai.upscale`、`ai.describe`（以及第 5.1 节的 `ebook.convert`）共 4 个节点仍会返回「尚未在 v0.1 中实现」的错误，因此它们的降级行为目前只能是规格，尚无可观察的运行时表现。

### 5.3 引擎与许可证的组合风险

> 本节是**基于第 2 节许可证注意事项的工程推论**，不是从代码导出的数据；目的是列出分发时容易踩的组合坑。每条都注明了它的依据字段。

| 风险组合 | 依据 | 分发注意点 |
| --- | --- | --- |
| FFmpeg（GPL 构建）+ Calibre（GPL-3.0） | `ffmpeg.licenseNote`：官方构建常启用 GPL 组件；`calibre.licenseNote`：GPL-3.0 为强 copyleft，随包分发请先做合规评审 | 两者叠加是**最需要提前评估**的组合：一个可能带 GPL-2.0 组件，一个是 GPL-3.0。若产品闭源分发，FFmpeg 应换用 LGPL 构建或自行编译；Calibre 若要随包分发必须先做合规评审，否则应只走「仅探测系统已安装」路径 |
| FFmpeg（GPL 构建）+ Pandoc（GPL-2.0+） | `ffmpeg.licenseNote`；`pandoc.licenseNote`：以独立进程调用不构成衍生作品，可随闭源应用分发，但不得静态链接 | 两者的豁免前提不同：Pandoc 的豁免**依赖「独立进程调用」**，所以实现时必须真的以子进程方式调用，不能改成静态链接或进程内嵌入。FFmpeg 换成 LGPL 构建后风险才真正下降 |
| ImageMagick（可能链接 GPL delegate）+ 任何 GPL 引擎 | `imagemagick.licenseNote`：本体宽松，但若链接了 GPL 组件（如部分 delegate）会传染，分发前需确认构建配置 | ImageMagick 的许可证字段是「Apache-2.0 风格」，很容易被当成完全无风险。**分发前必须确认构建配置里到底 link 了哪些 delegate**，尤其是 PDF / 视频相关 delegate |
| 7-Zip 的 unRAR 条款 | `7zip.licenseNote`：unRAR 代码禁止用于开发 RAR 压缩器；解压用途不受影响 | 只要产品只做**解压**（`archive.unpack` 的定位），不受该条款影响；但**不得**基于它实现 RAR 压缩能力。这条限制与 GPL 无关，容易在合规检查中被漏掉 |
| ONNX 权重（学术 / 训练集条款）+ 闭源商用产品 | `onnx-models.licenseNote`：代码许可与权重许可是两回事；第 4.1 节列出 `birefnet-general` 与 `modnet-portrait` 为 `commercialUse: false` | 这是「代码许可证看起来没问题、权重许可证有问题」的典型组合。**必须按模型逐个校验**，不能因为 ONNX Runtime 或推理脚本的许可证宽松就认为权重也可商用 |
| Python 运行时（PSF-2.0）+ 第三方 wheel | `python.licenseNote`：宽松许可；注意随包分发的第三方 wheel 各自的许可证 | 运行时本身宽松，但 L3 插件依赖的 wheel 各自带许可证，其中可能含 GPL / 学术条款。随包分发前需要清点实际打进去的 wheel 清单 |
| LibreOffice（MPL-2.0）+ Calibre（GPL-3.0） | `libreoffice.licenseNote`：MPL 是文件级 copyleft，独立进程调用无传染风险；`calibre.licenseNote` | 不存在额外传染风险，但两者都**只有系统安装模式**，所以产品实际上不会分发它们，只需要在 UI 里把「请自行安装」讲清楚，并避免暗示应用自带这些组件 |
| `ai-provider`（依服务商条款）+ 用户数据出境 | `ai-provider.licenseNote`：API Key 只存在本机加密存储中，不会随插件或日志外泄（⚠️ 这句原文与实现不符，见 3.6） | 许可证取决于用户接的服务商，产品无法代为保证。实现上必须保证：API Key **不写入插件、不写入日志**（`AiProviderConfig::api_key` 带 `skip_serializing`，审计写入点也不含凭据）。**注意别再把"加密存储"当成事实**：当前既没有加密存储也没有钥匙串，默认只存在内存；用户可选的 `ai.persistApiKey` 是**明文**落盘，属于能力降级 |

**通用结论：** `requiresLicenseAck: true` 的 5 个引擎（`ffmpeg`、`pandoc`、`libreoffice`、`calibre`、`onnx-models`）覆盖了本文档第 5 章几乎所有高风险项。UI 在用户点击「下载 / 安装」之前必须先展示许可证与注意事项，这是 `EngineDescriptor` 中 `licenses`、`licenseNote`、`requiresLicenseAck` 三个字段共同的设计意图。

---

## 6. 已知不一致与待补齐项

本章记录核对过程中发现的问题。这些是**代码与代码之间、代码与本文档之间**的不一致，如实列出，不做补全推测。

### 6.1 `ai.upscale` 的模型枚举与 `onnx-models` 模型清单不一致（待补齐）

- `crates/toolforge-core/src/pipeline.rs` 中 `ai.upscale` 节点的 `model` 参数是一个枚举，可选值为 4 个：
  `realesrgan-x4plus`（默认值）、`realesrgan-x2plus`、`swinir-l`、`hat-l`。
- 但 `crates/toolforge-core/src/engine.rs` 的 `engine_catalog()` 中，`onnx-models` 的 `models` 清单**只有 `realesrgan-x4plus` 一个超分模型**，另外 5 个是抠图类模型（`u2net`、`u2netp`、`isnet-general`、`birefnet-general`、`modnet-portrait`）。
- 也就是说：**`realesrgan-x2plus`、`swinir-l`、`hat-l` 这三个模型 id 能被用户选中，但在引擎目录里没有对应的权重条目**（没有体积、许可证、是否可商用的信息，也就无从下载与校验）。
- 处理方式：**待补齐**。要么在 `engine_catalog()` 的 `onnx-models.models` 里补上这三个模型的完整条目（含体积、许可证、`commercialUse`），要么收紧 `ai.upscale` 的枚举。**本文档不为它们补写任何数据**——补数据必须走代码，然后同步本文档（第 1.1 节维护约定）。
- 补充：现有测试 `every_node_engine_reference_exists_in_catalog` 只校验节点引用的**引擎 id** 是否存在，不校验参数枚举里的**模型 id** 是否有对应权重条目，所以这个不一致目前不会被测试拦住。

### 6.2 `provides` 声明与实现之间的两处对不上（`image.crop` / `image.enhance` + `image.strip-metadata`）

- **方向一：引用方有、声明方没有。** `image.crop` 的 `optionalEngines` 是 `["libvips", "imagemagick"]`，但 `libvips` 的 `provides` 只有 `image.convert`、`image.resize`、`image.enhance`、`image.strip-metadata`——**没有 `image.crop`**；`image.crop` 只在 `imagemagick` 的 `provides` 里。
  > ✅ **实现已经查清**：`nodes.rs::image_crop` 确实调用 `pick_image_backend()`，**libvips 可用时就用 libvips 做裁剪**。也就是说"libvips 能不能承担 `image.crop`"这个问题，答案是**能，而且已经在做**（这一点也由 `verify-platform.mjs`【6】间接覆盖：它验证的是"实际后端与引擎状态一致"）。
  > 处理方式：**待补齐** —— 应该把 `image.crop` 补进 `libvips.provides`，让声明追上实现。
- **方向二：声明方有、实现里没有。** `libvips.provides` 里还有 `image.enhance` 与 `image.strip-metadata`，但这两个节点的实现**完全没有调用 `pick_image_backend()`**（也就没有 `backend` 输出），是纯 Rust 内部实现。
  > 处理方式：**待补齐** —— 要么在实现里真的接上 libvips，要么把这两个能力从 `libvips.provides` 里撤掉。**在二选一完成之前，"libvips 提供图像增强/清除元数据"这句话只是声明**，使用者不该据此以为装了 libvips 这两步会提速。
- 补充：现有测试 `every_provided_capability_maps_to_a_real_node` 只校验「`provides` 里的能力都有对应节点」这个方向，**不校验反方向，也不校验"实现里到底调没调"**，所以这两处不一致都不会被测试拦住。

### 6.3 `ebook.convert` 在「两个可选引擎都缺失」时没有明确定义

- `ebook.convert` 的 `requiresEngines` 为空、`optionalEngines` 为 `["calibre", "pandoc"]`。
- 因此当 `calibre` 与 `pandoc` 都不在时，该节点在代码层面**不会**被标记为不可用，但实际上没有任何可用后端（`.convert` 的语义完全依赖外部转换器）。
- 处理方式：**待明确**。需要在 `toolforge-engines` 的实现里定义这种情形的行为（是运行时失败，还是把「两个可选引擎都缺失」也升级为跨节点不可用并在 UI 提示），然后按结论更新第 5.1 节。
- 本文档第 5.1 节已如实写出这一边界，未假设任何一种行为。

### 6.4 引擎最低版本要求未定义

- `EngineState` 中有 `Outdated`（「版本过旧」）状态，`EngineStatus` 中有 `version` 字段，但 `EngineDescriptor` 中**没有最低版本字段**，也没有任何地方定义「过旧」的判定标准。
- 处理方式：**待定**。本文档因此不给出任何版本号要求（见第 1.3 节）。
- ✅ **补一条已经修好的相关事实**：**版本号本身现在真的读得出来了**。此前 `toolforge-process` 的 `ExecOptions::quiet(true)` 会把子进程输出整段丢弃，于是 `probe_version` 什么都拿不到 —— 界面上**每个引擎的版本都显示「未知」**，引擎失败时 stderr 也是空的。`quiet` 现已改为「只保留尾部」，`probe_version` 有回归测试（`probe_version_returns_something`）钉住。注意区别：**"能读到版本号"已经成立，"低于多少算过旧"仍然没有定义**，所以 `EngineState::Outdated` 依旧不会被触发。

### 6.5 模型下载地址与 SHA-256：三个已核对，三个刻意留空

- ~~见第 1.3 节：`engine_catalog()` 中 6 个模型的 `url` 与 `sha256` 全部为 `None`。~~
  > ✅ **已修正（部分）**：`u2net`、`u2netp`、`isnet-general` 三个 rembg 权重现在有**真实下载后自己算出来的** SHA-256、固定 release tag 直链（`https://github.com/danielgatis/rembg/releases/download/v0.0.0/`）与独立的 `file_name` 字段（资产名与模型 id 不一致，如 `isnet-general` → `isnet-general-use.onnx`）。文件落在 `<data_dir>/models/<model_id>/<file_name>`。三条 IPC 也已补齐：`models_list` / `models_install` / `models_remove`。
  > **哈希不匹配即删文件**：`registry.rs::install_model` 用 `remove_file` + `IntegrityCheckFailed`，不保留没校验过的产物。
  > **另外三个（`birefnet-general` / `modnet-portrait` / `realesrgan-x4plus`）刻意没有 url/hash**：哈希还没核对过，与其放一个"点了必然失败"的下载按钮，不如让 UI 显示「无下载源」并把按钮置灰。单测 `verified_sources_are_pinned` 强制 url / sha256 / file_name 三者全有或全无、哈希为 64 位小写十六进制、`file_name` 不重复。
  > **注意**：上一段关于"模型权重仍全部为 `null`"的旧结论已经不成立。
- ~~另外 `engine-sources.json` 中 5 个引擎的候选 URL 虽然存在，但**每条 `sha256` 均为 `null`**，因此没有任何一个引擎具备可用的自动安装来源。~~
  > ✅ **已修正**：`engine-sources.json` 已回填 **6 条**带真实核对哈希 + 版本固定直链的来源（`ffmpeg@windows`、`libvips@windows`、`pandoc@windows/linux`、`python@windows/linux`）。因此 Windows 与 Linux 上的这 4 个引擎**现在可以自动安装**；macOS 三条与 `ffmpeg@linux` 仍为 `null`。详见 `docs/ROADMAP.md` §3。
- 处理方式：**还剩三个模型待补齐**（补哈希必须先在真实环境下载核对，不能凭推测填写）。
  > ✅ **另一件事已经不再成立**：这条原来说「依赖模型的节点执行器仍未实现，所以 v0.1 仍用不上模型」—— **抠图的执行器 已经实现并真机跑通**（`image_remove_background`：下权重 → 独立 venv 装 `onnxruntime` → ONNX 推理 → 出 RGBA PNG），所以模型现在**真的被用上了**。仍然没实现的是 `ai.upscale`（`realesrgan-x4plus` 连下载源都没有）。

**下载链路上后来加的三件事（都是实测逼出来的）：**

1. **失败重试一次，第二次只用 HTTP/1.1**：`registry.rs` 对 **5xx / 429 / 连接错误**重试一次，第二次换成 `http1_only()` 的客户端。触发点是观察到**同一个 GitHub release URL 一次返回 502、稍后再请求就是 200**。
   > ⚠️ **诚实说明**：**重试本身依据充分**（那是个真实发生过的 5xx），但**"换成 HTTP/1.1"这一步的依据较弱** —— 那个 502 **没有复现过**，它很可能只是一次瞬时的服务端错误，与 HTTP 版本无关。之所以还是保留，是因为代价极低（只在第一次失败后才多花一次请求），而如果它真与 HTTP/2 的某些中间设备有关，那就是白捡的。**不要把它写成"确认是 HTTP/2 的问题"。**
2. **本地已有且哈希正确的文件直接跳过下载**：`models_install` 会先对已存在的本地文件算哈希，**匹配就直接返回**（`u2net` 是 168 MB，用户在界面上多点一次下载不该付一次完整下载的代价）；**不匹配则重新下载**并留一条 warn（本地文件坏掉这件事本身值得被看见）。为什么不是"文件存在就当已安装"：模型权重会被用户手工替换、被同步工具截断、被磁盘错误写坏，而**拿一个损坏的权重去跑推理得到的是乱码结果，不是错误** —— 那比下载失败难查得多。
3. **一条"URL 必须以落盘文件名结尾"的断言**：`engine.rs` 的 `verified_sources_are_pinned` 里新增。它是被一次**真机下载**逼出来的：`url` 曾经写成 release tag 本身（`…/download/v0.0.0`，**少拼了资产名**），看起来完全正常、单测也照样绿（因为没人会去"下载"），真跑的时候得到 `HTTP 404`，而错误信息只含糊地说"下载 u2netp 失败"。要求"URL 以 `file_name` 结尾"是最便宜的自洽检查：**只要有人再漏拼一次资产名，这条会立刻红**（GitHub 资产地址必须以具体文件名结尾，指向 release tag 会 404）。

### 6.6 `nodes.rs` 的模块文档表与实际实现不一致：`archive.*` 的「系统 tar」兜底并不存在

- `crates/toolforge-engines/src/nodes.rs` 的模块文档里有一张降级矩阵表，并在标题上声明「本文件是唯一的真相来源」。该表把 `archive.*` 一行写成：`7-Zip` → 次选「系统 tar」→ 兜底「无」。
- 但实现并非如此：`sevenzip_pack()` 与 `sevenzip_unpack()` 都直接写 `let sevenzip = ctx.engine("7zip").await?;`——`7zip` 缺失时立即返回错误，执行失败时 `r.into_error("7zip")`。代码中**没有**任何改用系统 `tar` 的分支（`tar` 只作为 `sevenzip_args_for_format()` 的一个**输出格式**出现，即 `-ttar`，不是兜底程序）。
- 影响：那张模块文档表会让读者以为 `archive.*` 在 7zip 缺失时仍能工作。本文档第 5.2 节依据 `builtin_nodes()` 的 `requiresEngines: ["7zip"]` 与上述实现，结论是「**无降级路径**」——与实现一致，与那张文档表不一致。
- 处理方式：**待对齐**。要么真的实现系统 `tar` 兜底（注意 `tar` 只能覆盖 tar 系列与部分 zip，**无法处理 7z / rar**，因此仍需保留 `requiresEngines` 的语义或在 UI 上区分），要么改掉 `nodes.rs` 的模块文档表。
- 附带问题：`nodes.rs` 的表还声称自己是降级矩阵的「唯一真相来源」，而本文档声明的依据是 `pipeline.rs` 的 `requiresEngines` / `optionalEngines`。建议统一口径为「`builtin_nodes()` 的字段是权威数据，`nodes.rs` 的表只是实现的简化摘要」，否则两份表会持续漂移：`doc.ocr` 的 `tesseract` 是可选引擎、`ebook.convert` 的 `calibre` → `pandoc` 顺序、`image.enhance` 与 `image.strip-metadata` 其实完全不走降级链（见 5.1、6.2），这些都没有体现在 `nodes.rs` 的表里。

### 6.7 `nodes.rs` 中仍有 4 个内置节点未实现（`image.remove-background` 已出列）

- `nodes.rs` 的 `run()` 分发函数实现了 28 个节点，其余 4 个会落到 `not_implemented()`，返回 `ErrorCode::Internal` 与消息「内置节点 `xxx` 尚未在 v0.1 中实现」。
- 这 4 个节点是：`doc.ocr`、`ebook.convert`、`ai.upscale`、`ai.describe`。清单的**唯一真相来源**是 `toolforge_core::pipeline::UNIMPLEMENTED_NODES`（原来它在四个地方各存一份，漏同步过一次）。
- ✅ **本条原来写的是 5 个，第一个是 `image.remove-background`** —— 它是产品的招牌功能，**此前从未真正工作过**。现在它有了执行器 `image_remove_background`，并已在真机上跑通整条链路。
  - **实测数据**（真机、非推断）：托管 Python 由应用装成 **3.11.16 / 145.2 MB / tar.gz 路径**；venv + pip 自动装上 `onnxruntime-1.30.0`、`numpy-2.4.6`、`pillow-12.3.0`；对一张 **400×300**（白底 + 一个红椭圆）的测试图，输出是 **RGBA PNG（colorType 6）、400×300、椭圆中心 alpha 254、角落 alpha 0、前景覆盖 18.87%** —— 与椭圆的真实面积吻合。**运行时就绪后单张推理约 0.7 秒**（含 pip 的首次运行为约 32 秒）。
  - **一张渐变图测不出显著性模型**：在没有明显主体的渐变图上，模型如实报告约 0% 覆盖并让节点发一条警告说明这一点。所以验收脚本必须用**有真实主体**的图 —— 拿渐变图测显著性模型，测出来的是"模型坏了"这种假象。
  - 参数也已对齐实现：现在是 `model` / `mode`（`alpha` | `color`）/ `background` / `threshold` / `feather`。**旧的 `alphaMatting` 参数已被删除** —— 它从登记那天起就没有任何实现，是个**假参数**：用户在 UI 里勾上它，什么都不会发生。
  - `python` 版本区间是 **3.9 ~ 3.13**（`onnxruntime` 没有 3.14 的 wheel），首次运行需要在 `<data>/cache/onnx-runtime/` 建独立 venv 并联网 `pip install`，详见 3.2。
- ✅ **新增了一条防回归测试**：`unimplemented_list_matches_the_dispatch_table` 会**遍历真实分发表**，对 `UNIMPLEMENTED_NODES` 里的每个节点断言它**确实**还落在 `not_implemented` 上。它守住的失误形态是"实现完了却忘了从名单里删掉"（以及反方向）—— 那种错会让用户看到与真实行为相反的提示，而**这个项目已经因此踩过一次坑**。同名的兄弟测试 `unimplemented_list_matches_actual_dispatch` 也在守同一件事。
- **曾经的 `flow.foreach` 不在这个名单里 —— 它被整个删除了**，不是"留着不实现"。它的语义在平铺的步骤列表里无法定义，描述里的「宿主会按并发度并行调度」也是假的；批量改由宿主在命令层做（`expand_batches`：多文件与目录输入都扇出成单文件批次，`${batch.index}` 取序号）。`UNIMPLEMENTED_NODES` 里只留了一行注释记录原因，防止有人再加回来。
- 这是**刻意的设计**：`not_implemented()` 的注释明确说明「刻意**不返回假的成功**」，否则会出现「流水线显示跑通了但没产出文件」这种最难排查的问题。
- 处理方式：**待实现**。剩下这 4 个覆盖的是 OCR、电子书转换、AI 超分、AI 描述，因此它们仍是 `ai-provider`、`calibre` 这几个引擎落地程度的直接体现；`ai.upscale` 是**最有可能接着做的一个**（它可以照抄抠图这条"模型 + 推理"链，缺的只是 `realesrgan-x4plus` 的下载源）。`not_implemented()` 的错误提示把实现进度指向 `docs/ROADMAP.md`。
- **别把"抠图通了"读成"AI 媒体能力都通了"**：`ai.upscale` / `ai.describe` / `doc.ocr` / `ebook.convert` 四个**仍然会返回未实现错误**，界面上也仍然按未实现标注。

### 6.8 桌面端入口已补齐，但前端仍缺失

> **状态更新**：本条最初写作时 `apps/desktop/src-tauri/src/` 与 `crates/toolforge-ai` 都还不存在，随后被并行开发补齐。以下保留原判断并标注最新观察结果。
>
> ⚠️ **另外注意**：下面"没有运行过 `cargo test`、第 5 章未经过测试回归验证"这句**已经过期**（保留作为历史）。当前有可复核的实测数据：`cargo test --workspace` **215 passed / 0 failed**、`scripts/devtools/verify-platform.mjs` **41 项检查全通过**、一次真实的 libvips 一键安装、以及抠图整条链路的真机验证（见 1.3、3.2、5.1）。不过要分清范围：**测试全绿 ≠ 第 5 章每一行都验证过** —— 图像域那 4 个节点的后端选择有【6】、【7】两条运行时检查，抠图有【8】，其余各行仍然没有专门的运行时检查。

- 根 `Cargo.toml` 的 `members = ["crates/*", "apps/desktop/src-tauri"]`：两个模式现在都有对应目录。`apps/desktop/src-tauri/src/` 已存在（`main.rs` / `lib.rs` / `commands.rs` / `ipc.rs` / `state.rs` / `bin/`）。
- 但**前端 `apps/desktop/src/` 仍不存在**（没有 `package.json`、没有 `dist/`、没有生成的 `bindings.ts`），所以根 `package.json` 里指向 `@toolforge/desktop` 的脚本跑不起来。
- `crates/toolforge-ai` 也已存在（`lib.rs` / `provider.rs` / `review.rs`），不再是缺失依赖。
- 影响（**已过期，见上**）：本文档**没有运行过 `cargo build` / `cargo test`**，因此不对「当前能否构建」下结论；也正因为如此，第 5 章的降级矩阵与第 2、4 节的数据目前都**没有经过测试回归验证**。
- 处理方式：**待实现**（补齐前端工程）。已知的编译阻塞与实测结论见 `docs/ROADMAP.md` 的「当前阻塞项」。

---

## 7. 相关源文件索引

| 路径 | 与本文档的关系 |
| --- | --- |
| `crates/toolforge-core/src/engine.rs` | 第 2、4 节的权威来源：`engine_catalog()`、`EngineDescriptor`、`EngineModel`、`EngineState`、`EngineSource`、`EngineInstallMode` |
| `crates/toolforge-core/src/pipeline.rs` | 第 5 节的权威来源：`builtin_nodes()`（32 个节点）、`NodeDescriptor.requiresEngines` / `optionalEngines`、`UNIMPLEMENTED_NODES`（4 个，唯一真相来源） |
| `crates/toolforge-engines/src/lib.rs` | 引擎层的职责划分与图像域三层降级设计的说明；`MANAGED_LAYOUT`、`version_args()` |
| `crates/toolforge-engines/src/registry.rs` | 引擎探测 / 下载 / 校验的实现；`EngineSourceSpec`、`ModelSpec`、`EngineRegistry`（含「`sha256` 为 `None` 时拒绝下载」的规则与 `has_download_source()`）；`probe()` 里对 `onnx-models` 这个**虚拟引擎**的特判也在这里（见 3.6） |
| `crates/toolforge-engines/src/nodes.rs` | 节点执行实现：`run()` 分发已实现 28 个节点；`pick_image_backend()` / `ImageBackend` 是第 5.1 节那张三层图的**真实实现**（四个节点走它，两个不走）；`image_remove_background` 是**第 3.2 节那条 ONNX 路径**（不经过三层链）；模块文档自带一张降级表，但与实现存在出入，见第 6.6、6.7 节 |
| `crates/toolforge-engines/py/rembg.py` | ONNX 推理脚本，用 `include_str!` 编进二进制、运行时释放到 `<data>/cache/onnx-runtime/rembg.py`；见第 3.2 节 |
| `crates/toolforge-process/src/exec.rs` | 子进程执行：`resolve_program()`（裸名字走 PATH、显式路径不回退）、`ExecOptions::quiet` 的"只留尾部"语义、`ExecResult` 的输出裁剪；见第 1.3 节 |
| `crates/toolforge-engines/engine-sources.json` | 下载来源清单：**6 条已回填真实哈希 + 版本固定直链**（Windows/Linux 的 ffmpeg/libvips/pandoc/python），macOS 三条与 `ffmpeg@linux` 仍为 `null`（安装时返回 `HashRequired`）。见第 1.3 与 6.5 节 |
| `crates/toolforge-process/` | 外部进程调用（执行、RPC、进程监管），是引擎被真正调用的下层 |
| `scripts/devtools/verify-platform.mjs` | 真机运行时验收脚本（`scripts/devtools/run.mjs` 的第 5 个），**41 项检查**；其中【6】验证"图片后端与引擎状态一致"、【7】验证任意角度旋转不静默取整、【8】验证抠图整条 ONNX 链路真的出透明背景。第 5.1 节的实测结论来自它，第 3.2 节的抠图实测数据来自【8】 |
| `docs/ROADMAP.md` | `nodes.rs` 的 `not_implemented()` 错误提示所指向的实现进度文档（本文档未引用其内容，也不与其重复记录进度） |
| `Cargo.toml`（根） | workspace 成员与依赖声明，见第 1.2 与 6.8 节 |

---

*本文档所有引擎、模型、节点数据均取自上述 Rust 源码；凡源码中不存在的数据（下载地址、SHA-256、版本号要求）一律标注为「待定」，未做任何推测性补全。*
