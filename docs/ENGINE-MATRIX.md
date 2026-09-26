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
| 内置节点目录（31 个） | `builtin_nodes()`，位于 `crates/toolforge-core/src/pipeline.rs` | 返回 `Vec<NodeDescriptor>`：每个节点的 `requiresEngines`（必需引擎）与 `optionalEngines`（可选引擎），是本文档第 5 节降级矩阵的唯一依据 |

**维护约定：改代码必须同步改本文档。**

- 在 `engine_catalog()` 里新增、删除或改名引擎 → 必须同步更新第 2 节与第 3 节。
- 修改 `EngineModel` 的 `license` 或 `commercialUse` → 必须同步更新第 4 节，尤其是「不可商用」的标注。
- 修改 `NodeDescriptor` 的 `requiresEngines` / `optionalEngines` → 必须同步更新第 5 节。
- `crates/toolforge-core/src/engine.rs` 中已有测试 `every_provided_capability_maps_to_a_real_node`（引擎声明的能力必须都有对应节点）和 `every_node_engine_reference_exists_in_catalog`（节点引用的引擎必须都在引擎目录里）在守护这两份数据的一致性。本文档就是这两个测试的说明版本。

### 1.2 实现状态（以仓库实际文件为准）

本节的落地状态是**某一时刻的快照**。原因是：编写本文档期间，`crates/toolforge-plugins`、`crates/toolforge-engines/src/nodes.rs`、`apps/desktop/src-tauri` 等文件是在核对过程中被**并发写入**仓库的（`git status` 显示它们都是未跟踪的新增内容）。下表以最后一次核对的观察结果为准，并给出依据文件，便于读者自行复核；若文件清单已变，本表即为过期。

| 组件 | 落地状态（快照） | 依据文件 |
| --- | --- | --- |
| `crates/toolforge-core` | 已落地 | 11 个源文件（`lib.rs` + 10 个模块），含 `src/engine.rs`（引擎目录）与 `src/pipeline.rs`（31 个内置节点） |
| `crates/toolforge-engines` | 已落地 | `Cargo.toml`、`src/lib.rs`、`src/registry.rs`、`src/nodes.rs`（节点执行实现）、`engine-sources.json` |
| `crates/toolforge-process` | 已落地 | `src/lib.rs`、`src/exec.rs`、`src/rpc.rs`、`src/supervisor.rs` |
| `crates/toolforge-plugins` | **已补齐** | 7 个源文件：`lib.rs`、`audit.rs`、`store.rs`、`l1.rs`、`runtimes.rs`、`runtimes/wasm.rs`、`runtimes/python.rs`（编写本文档时只有前 3 个） |
| `crates/toolforge-ai` | **已补齐** | 3 个源文件：`lib.rs`、`provider.rs`、`review.rs`（编写本文档时目录尚不存在） |
| `apps/desktop` | **已补齐后端** | `src-tauri/src/` 下有 `main.rs`、`lib.rs`、`commands.rs`、`ipc.rs`、`state.rs`、`bin/`；**但前端 `apps/desktop/src/` 仍不存在** |

有两点必须讲清楚：

1. **本文档没有运行过 `cargo build` / `cargo test`**，因此不对「当前能否构建成功」下结论。可以确认的是：根 `Cargo.toml` 的 `members = ["crates/*", "apps/desktop/src-tauri"]` 现在都有对应目录。因此**第 5 节的降级矩阵仍然是「规格」而不是「已验证行为」**：它准确描述的是 `builtin_nodes()` 声明的引擎依赖关系，而不是经测试验证的运行时行为。（相关编译阻塞与实测结论见 `docs/ROADMAP.md` 的「当前阻塞项」。）
2. 本文档因此同时承担两个角色：**引擎层规格说明**（现在就能定下来的接口契约：有哪些引擎、能力边界、许可证约束、降级规则）与**待实现清单**（第 6 节列出尚未落地的部分与已知的数据不一致）。

> 核对说明：任务简报假定「仓库目前只存在 `crates/toolforge-core`，`toolforge-engines` / `toolforge-process` / `toolforge-plugins` / `toolforge-ai` 以及 `apps/desktop` 都还没落地」。实际核对后，这些组件中的多数已经存在（其中一部分正是在核对期间被并行写入的）。本节按仓库实际文件撰写，未沿用该假定。

### 1.3 下载地址与校验哈希：全部待定

`EngineModel` 结构体（`crates/toolforge-core/src/engine.rs`）中，`url` 与 `sha256` 都是 `Option<String>`。而在 `engine_catalog()` 里，`onnx-models` 的全部 6 个模型的这两个字段**都是 `None`**，写法完全一致：

```rust
EngineModel {
    id: "u2net".into(),
    name: "U²-Net".into(),
    purpose: "通用显著性目标检测 / 抠图，效果均衡".into(),
    approx_size_mb: 176,
    license: "Apache-2.0".into(),
    commercial_use: true,
    url: None,       // ← 占位，尚未填写
    sha256: None,    // ← 占位，尚未填写
    installed: false,
},
```

**结论：所有引擎与模型的下载地址、SHA-256 校验值在本文档中一律标注为「待定」**，需要在实现 `toolforge-engines` 的下载/安装链路时补齐。原因是当前代码里根本没有这些数据，任何具体 URL 或哈希都只能来自代码之外，写进本文档就是臆造。

另外有两点必须如实说明：

- `crates/toolforge-engines/engine-sources.json` 是一个**独立于 `EngineModel` 的来源清单**（对应 `registry::EngineSourceSpec`）。
  > ✅ **已回填 6 条**（Windows / Linux 的 `ffmpeg` / `libvips` / `pandoc` / `python`），每条都带**实际核对过的 SHA-256** 与**版本固定直链**；`registry.rs` 规定 `sha256` 为 `None` 时拒绝下载，所以 macOS 三条与 `ffmpeg@linux`（上游是滚动别名）目前仍**不可自动安装**，会返回 `HashRequired`。核对方式与实测版本表见 `docs/ROADMAP.md` §3。
  > **`7zip` 的条目已移除**（原先有，现已删除）：官方只提供安装器，或需要先有 7-Zip 才能解压的 `.7z`（先有鸡还是先有蛋），且那条版本固定直链 `7z2408-extra.7z` **实测 404**。因此 `7zip` 在 `engine_catalog()` 里已改为**仅系统安装**。本文档第 2、4 节的「体积」「安装方式」全部取自 `engine_catalog()`，不与 `engine-sources.json` 混用。
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
| `ai-provider` | AI 服务提供方 | OpenAI 兼容接口的大模型服务，用于插件生成、图像描述等。 | `依服务商条款` | API Key 只存在本机加密存储中，不会随插件或日志外泄。 | 约 0 MB（无本地二进制） | 远程服务无本地二进制 | `ai.describe` | Windows / macOS / Linux | 否 |

### 2.1 总表读法

- **核心引擎共 3 个**：`ffmpeg`、`pandoc`、`7zip`。它们在名称后标注了「（核心引擎）」。缺失时应用**仍然能启动**，但依赖它们的节点不可用：`ffmpeg` 缺失 → 5 个 `video.*` 与 2 个 `audio.*` 节点不可用；`pandoc` 缺失 → `doc.convert` 不可用，并且 `ebook.convert` 失去唯一的纯文档转换后端；`7zip` 缺失 → `archive.pack` / `archive.unpack` 不可用。
- **只有 `System` 一种安装方式的引擎共 4 个**：`libreoffice`（约 420 MB）、`calibre`（约 180 MB）、`tesseract`（约 60 MB）、`7zip`（约 5 MB）。这四个都只探测系统安装、不提供应用内下载。
- **只有 `Download` 一种安装方式的引擎共 2 个**：`python`、`onnx-models`。二者不探测系统安装，避免与系统 Python / 系统模型缓存互相污染。
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
- **许可证与分发注意点**：`LGPL-2.1`。以动态库方式调用即可满足 LGPL 要求，无需开源你自己的代码——这也是它被选为图像域首选引擎的原因。`requiresLicenseAck: false`。

#### ImageMagick（`imagemagick`）

- **主页**：https://imagemagick.org/
- **提供的节点（5 个）**：`image.convert`、`image.resize`、`image.crop`、`image.rotate`、`image.strip-metadata`。其中 `image.rotate` 只有它一家声明提供。
- **缺失时会发生什么**：节点仍可用（都不是必需引擎），但 `image.rotate` 会失去唯一的外部实现，退到纯 Rust `image` crate；`image.convert` / `image.resize` / `image.strip-metadata` 失去第二层兜底（libvips 仍优先）。
- **许可证与分发注意点**：`ImageMagick License（Apache-2.0 风格）`，本体宽松；但若链接了 GPL 组件（如部分 delegate）会传染，分发前需确认构建配置。`requiresLicenseAck: false`。

#### Python 运行时 + ONNX 模型包（抠图与超分）

- 见 3.5 中的 `python` 与 `onnx-models` 条目。图像域的 `image.remove-background`（抠图去背景）**同时要求两个引擎**（`requiresEngines: ["python", "onnx-models"]`），任一缺失即不可用，且没有降级路径。

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

#### ONNX 模型包（`onnx-models`）

- **主页**：https://onnxruntime.ai/
- **提供的节点（2 个）**：`image.remove-background`、`ai.upscale`。
- **缺失时会发生什么**：这两个节点不可用（与 `python` 一样是必需引擎）。它是**唯一带模型权重清单的引擎**（6 个模型，见第 4 节），也是唯一需要单独做许可证确认的模型入口。
- **许可证与分发注意点**：许可证字段本身写的是「各模型不同（见下表）」，注意事项是「代码许可与权重许可是两回事。U2Net 为 Apache-2.0 可商用；MODNet 权重为学术许可；BiRefNet 权重受训练集条款限制。」体积标注约 180 MB（这只是 `approxSizeMb` 字段给出的引擎级估算；注意 6 个模型逐个加起来远超此值，且模型按需下载、不随安装包分发）。`requiresLicenseAck: true`。

#### AI 服务提供方（`ai-provider`）

- **主页**：https://platform.openai.com/docs/api-reference
- **提供的节点（1 个）**：`ai.describe`。
- **缺失时会发生什么**：`ai.describe` **不可用**，无降级路径（`requiresEngines: ["ai-provider"]`）。由于它是 `Remote` 模式的引擎，不存在「安装包」意义上的缺失，缺失等价于「未配置可用的服务商 / API Key」。
- **许可证与分发注意点**：`依服务商条款`——许可证不取决于 ToolForge，而取决于用户接的是哪家服务。注意事项写明「API Key 只存在本机加密存储中，不会随插件或日志外泄」，这是实现的硬约束。`requiresLicenseAck: false`。

### 3.7 无引擎依赖的功能域

以下四类节点在 `builtin_nodes()` 中 `requiresEngines` 与 `optionalEngines` 都是空数组，它们不经过引擎层，永远可用：

| 功能域 | 节点 | 说明 |
| --- | --- | --- |
| 文件操作 | `fs.copy`、`fs.move`、`fs.mkdir`、`fs.delete` | 纯 Rust 文件系统操作 |
| 图片（探测） | `image.probe` | 读取图片信息，纯 Rust 解码 |
| 流程控制 | `flow.branch`、`flow.set-var`、`flow.log`、`flow.foreach` | 流程编排原语，不涉及外部进程 |

这四个 `flow.*` 节点是保证「即使一个引擎都没装，流程编辑器仍然能用」的底线能力。

---

## 4. 模型权重表

`onnx-models` 引擎下共 6 个模型权重。模型刻意与引擎本身分开：权重体积大、许可证各异，而且很多是「只有用了这个功能才需要」。

| 模型 id | 名称 | 用途 | 体积 | 权重许可证 | 是否可商用 | 下载地址 | SHA-256 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `u2net` | U²-Net | 通用显著性目标检测 / 抠图，效果均衡 | 约 176 MB | `Apache-2.0` | 是 | 待定（当前 `EngineModel.url` / `EngineModel.sha256` 为 `None`） | 待定（当前 `EngineModel.url` / `EngineModel.sha256` 为 `None`） |
| `u2netp` | U²-Net (轻量) | U²-Net 的轻量版，速度快约 3 倍，边缘略糊 | 约 5 MB | `Apache-2.0` | 是 | 待定（当前 `EngineModel.url` / `EngineModel.sha256` 为 `None`） | 待定（当前 `EngineModel.url` / `EngineModel.sha256` 为 `None`） |
| `isnet-general` | IS-Net General | 通用抠图，对复杂边缘处理更好 | 约 176 MB | `Apache-2.0` | 是 | 待定（当前 `EngineModel.url` / `EngineModel.sha256` 为 `None`） | 待定（当前 `EngineModel.url` / `EngineModel.sha256` 为 `None`） |
| `birefnet-general` | BiRefNet | 当前抠图 SOTA，发丝级边缘 | 约 900 MB | `MIT（代码）/ 权重另有条款` | **否** | 待定（当前 `EngineModel.url` / `EngineModel.sha256` 为 `None`） | 待定（当前 `EngineModel.url` / `EngineModel.sha256` 为 `None`） |
| `modnet-portrait` | MODNet Portrait | 人像专用抠图（视频会议 / 证件照场景） | 约 25 MB | `Apache-2.0（代码）/ 学术用途权重` | **否** | 待定（当前 `EngineModel.url` / `EngineModel.sha256` 为 `None`） | 待定（当前 `EngineModel.url` / `EngineModel.sha256` 为 `None`） |
| `realesrgan-x4plus` | Real-ESRGAN x4plus | 通用图像超分辨率放大 | 约 67 MB | `BSD-3-Clause` | 是 | 待定（当前 `EngineModel.url` / `EngineModel.sha256` 为 `None`） | 待定（当前 `EngineModel.url` / `EngineModel.sha256` 为 `None`） |

> 「下载地址」与「SHA-256」两列的说明见第 1.3 节：`engine_catalog()` 中这 6 个模型的 `url` 与 `sha256` 全部为 `None`，因此这两列**只能**是待定。补齐它们属于实现 `toolforge-engines` 时的任务，不得凭推测填写。

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

### 5.1 无必需引擎：始终可用或可降级的节点（16 个）

下表节点的 `requiresEngines` 均为空数组，因此**不会因为任何引擎缺失而变成不可用**。

| 内置节点 | 所需能力 | 主引擎 | 主引擎缺失时的降级路径 | 降级后的能力损失 |
| --- | --- | --- | --- | --- |
| `fs.copy` | 无（不依赖外部引擎，纯 Rust） | 无 | 不适用——永远可用 | 无 |
| `fs.move` | 无（不依赖外部引擎，纯 Rust） | 无 | 不适用——永远可用 | 无 |
| `fs.mkdir` | 无（不依赖外部引擎，纯 Rust） | 无 | 不适用——永远可用 | 无 |
| `fs.delete` | 无（不依赖外部引擎，纯 Rust） | 无 | 不适用——永远可用 | 无 |
| `image.probe` | 无（纯 Rust 解码，读取图片信息） | 无 | 不适用——永远可用 | 无 |
| `image.convert` | 图片格式转换（可选：`libvips`、`imagemagick`） | `libvips`（可选，非必需） | `libvips` 缺失 → ImageMagick → 两者都缺失 → 纯 Rust `image` crate 打底 | 批量/大图更慢、更吃内存；失去 libvips 的流式低内存优势；退回纯 Rust 时可用格式覆盖变窄 |
| `image.resize` | 图片缩放（可选：`libvips`、`imagemagick`） | `libvips`（可选，非必需） | `libvips` 缺失 → ImageMagick → 两者都缺失 → 纯 Rust `image` crate 打底 | 同上：更慢、更吃内存，缩放算法与格式覆盖可能变少 |
| `image.crop` | 裁剪 / 缩略图（可选：`libvips`、`imagemagick`） | `libvips`（可选，非必需） | `libvips` 缺失 → ImageMagick → 两者都缺失 → 纯 Rust `image` crate 打底（另见第 6.2 节的一致性问题） | 同上：更慢、更吃内存 |
| `image.rotate` | 旋转 / 翻转（可选：`imagemagick`） | `imagemagick`（可选，非必需） | `imagemagick` 缺失 → 纯 Rust `image` crate 打底。**注意：该节点只有 imagemagick 一个可选外部引擎，没有第二个外部兜底** | 更慢、更吃内存，且失去 ImageMagick 的格式覆盖（`libvips` 的 `provides` 未声明 `image.rotate`，无法接手） |
| `image.enhance` | 图像增强（可选：`libvips`） | `libvips`（可选，非必需） | `libvips` 缺失 → 纯 Rust `image` crate 打底。**注意：该节点只有 libvips 一个可选外部引擎，没有第二个外部兜底** | 更慢、更吃内存；增强算法质量可能下降 |
| `image.strip-metadata` | 清除元数据（可选：`libvips`、`imagemagick`） | `libvips`（可选，非必需） | `libvips` 缺失 → ImageMagick → 两者都缺失 → 纯 Rust `image` crate 打底 | 更慢、更吃内存；对部分容器格式的元数据块清理可能不完整 |
| `ebook.convert` | 电子书格式转换（可选：`calibre`、`pandoc`） | `calibre`（可选，非必需） | `calibre` 缺失 → `pandoc`（**仅覆盖 EPUB / HTML**）；`pandoc` 也缺失 → 没有任何可用后端 | **MOBI / AZW3 输出能力完全丧失**；只剩 EPUB/HTML 互转。两个后端都缺失时，该节点虽不被判为不可用，但实际无法完成任何转换（见第 6.3 节） |
| `flow.branch` | 无（流程编排原语） | 无 | 不适用——永远可用 | 无 |
| `flow.set-var` | 无（流程编排原语） | 无 | 不适用——永远可用 | 无 |
| `flow.log` | 无（流程编排原语） | 无 | 不适用——永远可用 | 无 |
| `flow.foreach` | 无（流程编排原语） | 无 | 不适用——永远可用 | 无 |

**关于图像域的补充说明：** `image.convert` / `image.resize` / `image.crop` / `image.rotate` / `image.enhance` / `image.strip-metadata` 这 6 个节点是「纯 Rust `image` crate 打底」，缺失可选引擎时**仍然工作**，只是更慢、更吃内存。整个 `toolforge-engines` 的降级设计就是围绕这一点展开的（见该 crate `src/lib.rs` 的模块注释）——图像处理是唯一真正三层降级的领域，因为纯 Rust 路径能兜住基础能力：

```text
libvips（快、省内存）  ──缺失──►  ImageMagick（格式最全）  ──缺失──►  纯 Rust image crate
                                                                      （零依赖，始终可用）
```

但要注意每个节点的可选引擎清单并不相同：`image.rotate` 与 `image.enhance` **只有 imagemagick / libvips 一个可选项**，不存在第二个外部兜底，一旦该引擎缺失就直接落到纯 Rust 路径。

### 5.2 必需引擎非空：没有降级路径，缺失即不可用（15 个）

**这一节的结论必须原样落到 UI 上：这些节点不存在降级方案。** `toolforge-engines/src/lib.rs` 的模块注释写得很直接：「音视频/文档/压缩包没有纯 Rust 替代品，所以走『必需引擎缺失 → 该节点不可用』并在 UI 上直接引导安装。**不假装能跑**。」

| 内置节点 | 所需能力 | 主引擎 | 主引擎缺失时的降级路径 | 降级后的能力损失 |
| --- | --- | --- | --- | --- |
| `image.remove-background` | 抠图去背景 | `python` + `onnx-models`（**均为必需**） | **无降级路径** | 节点完全不可用。UI 显示「需要安装 Python 运行时」与「需要安装 ONNX 模型包」，并分别提供下载入口（两者都是 `Download` 模式，可应用内获取） |
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

**实现现状（快照，详见第 6.6、6.7 节）：** `crates/toolforge-engines/src/nodes.rs` 的 `run()` 分发函数已实现 25 个节点。本节涉及的节点中，`archive.pack` / `archive.unpack` 已实现且确实**硬依赖** `7zip`（实现里是 `ctx.engine("7zip").await?`，缺失即报错），与本节的「无降级路径」结论一致；`video.*` / `audio.*` / `doc.convert` / `doc.to-pdf` 同样以必需引擎为准。但 `image.remove-background`、`doc.ocr`、`ai.upscale`、`ai.describe`（以及第 5.1 节的 `ebook.convert`、`flow.foreach`）共 6 个节点仍会返回「尚未在 v0.1 中实现」的错误，因此它们的降级行为目前只能是规格，尚无可观察的运行时表现。

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
| `ai-provider`（依服务商条款）+ 用户数据出境 | `ai-provider.licenseNote`：API Key 只存在本机加密存储中，不会随插件或日志外泄 | 许可证取决于用户接的服务商，产品无法代为保证。实现上必须保证：API Key 仅本地加密存储、不写入插件、不写入日志——这一条是代码注释里的硬约束，不能因为「方便调试」而破坏 |

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

### 6.2 `image.crop` 引用了 `libvips`，但 `libvips` 未声明提供该能力

- `image.crop` 的 `optionalEngines` 是 `["libvips", "imagemagick"]`。
- 但 `libvips` 的 `provides` 只有 `image.convert`、`image.resize`、`image.enhance`、`image.strip-metadata`——**没有 `image.crop`**；`image.crop` 只在 `imagemagick` 的 `provides` 里。
- 影响：第 5.1 节中 `image.crop` 的那行按代码写作「`libvips` 缺失 → ImageMagick」，但按 `provides` 的声明，libvips 未必真的能承担 `image.crop`；如果实际实现里 libvips provider 支持裁剪，就应该把 `image.crop` 补进 `libvips.provides`。
- 处理方式：**待补齐**，需在 `toolforge-engines` 的 `nodes` 模块实现时确认并二选一对齐。
- 补充：现有测试 `every_provided_capability_maps_to_a_real_node` 只校验「`provides` 里的能力都有对应节点」这个方向，**不校验反方向**，所以这个不一致同样不会被测试拦住。

### 6.3 `ebook.convert` 在「两个可选引擎都缺失」时没有明确定义

- `ebook.convert` 的 `requiresEngines` 为空、`optionalEngines` 为 `["calibre", "pandoc"]`。
- 因此当 `calibre` 与 `pandoc` 都不在时，该节点在代码层面**不会**被标记为不可用，但实际上没有任何可用后端（`.convert` 的语义完全依赖外部转换器）。
- 处理方式：**待明确**。需要在 `toolforge-engines` 的实现里定义这种情形的行为（是运行时失败，还是把「两个可选引擎都缺失」也升级为跨节点不可用并在 UI 提示），然后按结论更新第 5.1 节。
- 本文档第 5.1 节已如实写出这一边界，未假设任何一种行为。

### 6.4 引擎最低版本要求未定义

- `EngineState` 中有 `Outdated`（「版本过旧」）状态，`EngineStatus` 中有 `version` 字段，但 `EngineDescriptor` 中**没有最低版本字段**，也没有任何地方定义「过旧」的判定标准。
- 处理方式：**待定**。本文档因此不给出任何版本号要求（见第 1.3 节）。

### 6.5 模型下载地址与 SHA-256 全部缺失

- 见第 1.3 节：`engine_catalog()` 中 6 个模型的 `url` 与 `sha256` 全部为 `None`。
- ~~另外 `engine-sources.json` 中 5 个引擎的候选 URL 虽然存在，但**每条 `sha256` 均为 `null`**，因此没有任何一个引擎具备可用的自动安装来源。~~
  > ✅ **已修正**：`engine-sources.json` 已回填 **6 条**带真实核对哈希 + 版本固定直链的来源（`ffmpeg@windows`、`libvips@windows`、`pandoc@windows/linux`、`python@windows/linux`）。因此 Windows 与 Linux 上的这 4 个引擎**现在可以自动安装**。**模型权重**（`onnx-models`）仍全部为 `null` —— 而依赖它们的节点执行器也还没实现，v0.1 不需要。详见 `docs/ROADMAP.md` §3。
- 处理方式：**待补齐**。这也是「引擎层规格说明」与「待实现清单」双重定位的核心一项。

### 6.6 `nodes.rs` 的模块文档表与实际实现不一致：`archive.*` 的「系统 tar」兜底并不存在

- `crates/toolforge-engines/src/nodes.rs` 的模块文档里有一张降级矩阵表，并在标题上声明「本文件是唯一的真相来源」。该表把 `archive.*` 一行写成：`7-Zip` → 次选「系统 tar」→ 兜底「无」。
- 但实现并非如此：`sevenzip_pack()` 与 `sevenzip_unpack()` 都直接写 `let sevenzip = ctx.engine("7zip").await?;`——`7zip` 缺失时立即返回错误，执行失败时 `r.into_error("7zip")`。代码中**没有**任何改用系统 `tar` 的分支（`tar` 只作为 `sevenzip_args_for_format()` 的一个**输出格式**出现，即 `-ttar`，不是兜底程序）。
- 影响：那张模块文档表会让读者以为 `archive.*` 在 7zip 缺失时仍能工作。本文档第 5.2 节依据 `builtin_nodes()` 的 `requiresEngines: ["7zip"]` 与上述实现，结论是「**无降级路径**」——与实现一致，与那张文档表不一致。
- 处理方式：**待对齐**。要么真的实现系统 `tar` 兜底（注意 `tar` 只能覆盖 tar 系列与部分 zip，**无法处理 7z / rar**，因此仍需保留 `requiresEngines` 的语义或在 UI 上区分），要么改掉 `nodes.rs` 的模块文档表。
- 附带问题：`nodes.rs` 的表还声称自己是降级矩阵的「唯一真相来源」，而本文档声明的依据是 `pipeline.rs` 的 `requiresEngines` / `optionalEngines`。建议统一口径为「`builtin_nodes()` 的字段是权威数据，`nodes.rs` 的表只是实现的简化摘要」，否则两份表会持续漂移：`image.rotate` 与 `image.enhance` 只有单一外部兜底、`doc.ocr` 的 `tesseract` 是可选引擎、`ebook.convert` 的 `calibre` → `pandoc` 顺序，这些都没有体现在 `nodes.rs` 的表里。

### 6.7 `nodes.rs` 中仍有 6 个内置节点未实现

- `nodes.rs` 的 `run()` 分发函数实现了 25 个节点，其余 6 个会落到 `not_implemented()`，返回 `ErrorCode::Internal` 与消息「内置节点 `xxx` 尚未在 v0.1 中实现」。
- 这 6 个节点是：`image.remove-background`、`doc.ocr`、`ebook.convert`、`ai.upscale`、`ai.describe`、`flow.foreach`。
- 这是**刻意的设计**：`not_implemented()` 的注释明确说明「刻意**不返回假的成功**」，否则会出现「流水线显示跑通了但没产出文件」这种最难排查的问题。
- 处理方式：**待实现**。这 6 个恰好覆盖了本文档第 5 章里引擎最重的节点（抠图、OCR、电子书转换、AI 超分、AI 描述），因此它们也是 `python`、`onnx-models`、`ai-provider`、`calibre` 这几个引擎落地程度的直接体现。`not_implemented()` 的错误提示把实现进度指向 `docs/ROADMAP.md`。

### 6.8 桌面端入口已补齐，但前端仍缺失

> **状态更新**：本条最初写作时 `apps/desktop/src-tauri/src/` 与 `crates/toolforge-ai` 都还不存在，随后被并行开发补齐。以下保留原判断并标注最新观察结果。

- 根 `Cargo.toml` 的 `members = ["crates/*", "apps/desktop/src-tauri"]`：两个模式现在都有对应目录。`apps/desktop/src-tauri/src/` 已存在（`main.rs` / `lib.rs` / `commands.rs` / `ipc.rs` / `state.rs` / `bin/`）。
- 但**前端 `apps/desktop/src/` 仍不存在**（没有 `package.json`、没有 `dist/`、没有生成的 `bindings.ts`），所以根 `package.json` 里指向 `@toolforge/desktop` 的脚本跑不起来。
- `crates/toolforge-ai` 也已存在（`lib.rs` / `provider.rs` / `review.rs`），不再是缺失依赖。
- 影响：本文档**没有运行过 `cargo build` / `cargo test`**，因此不对「当前能否构建」下结论；也正因为如此，第 5 章的降级矩阵与第 2、4 节的数据目前都**没有经过测试回归验证**。
- 处理方式：**待实现**（补齐前端工程）。已知的编译阻塞与实测结论见 `docs/ROADMAP.md` 的「当前阻塞项」。

---

## 7. 相关源文件索引

| 路径 | 与本文档的关系 |
| --- | --- |
| `crates/toolforge-core/src/engine.rs` | 第 2、4 节的权威来源：`engine_catalog()`、`EngineDescriptor`、`EngineModel`、`EngineState`、`EngineSource`、`EngineInstallMode` |
| `crates/toolforge-core/src/pipeline.rs` | 第 5 节的权威来源：`builtin_nodes()`（31 个节点）、`NodeDescriptor.requiresEngines` / `optionalEngines` |
| `crates/toolforge-engines/src/lib.rs` | 引擎层的职责划分与图像域三层降级设计的说明；`MANAGED_LAYOUT`、`version_args()` |
| `crates/toolforge-engines/src/registry.rs` | 引擎探测 / 下载 / 校验的实现；`EngineSourceSpec`、`ModelSpec`、`EngineRegistry`（含「`sha256` 为 `None` 时拒绝下载」的规则） |
| `crates/toolforge-engines/src/nodes.rs` | 节点执行实现（1464 行）：`run()` 分发已实现 25 个节点；模块文档自带一张降级表，但与实现存在出入，见第 6.6、6.7 节 |
| `crates/toolforge-engines/engine-sources.json` | 下载来源清单：**6 条已回填真实哈希 + 版本固定直链**（Windows/Linux 的 ffmpeg/libvips/pandoc/python），macOS 三条与 `ffmpeg@linux` 仍为 `null`（安装时返回 `HashRequired`）。见第 1.3 与 6.5 节 |
| `crates/toolforge-process/` | 外部进程调用（执行、RPC、进程监管），是引擎被真正调用的下层 |
| `docs/ROADMAP.md` | `nodes.rs` 的 `not_implemented()` 错误提示所指向的实现进度文档（本文档未引用其内容，也不与其重复记录进度） |
| `Cargo.toml`（根） | workspace 成员与依赖声明，见第 1.2 与 6.8 节 |

---

*本文档所有引擎、模型、节点数据均取自上述 Rust 源码；凡源码中不存在的数据（下载地址、SHA-256、版本号要求）一律标注为「待定」，未做任何推测性补全。*
