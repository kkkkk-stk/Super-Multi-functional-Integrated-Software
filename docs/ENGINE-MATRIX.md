# ToolForge 引擎矩阵与降级规格

> 文档路径：`docs/ENGINE-MATRIX.md`
> 对应工作区版本：`Cargo.toml` 中 `[workspace.package] version = "0.1.0"`

---

## 1. 开篇说明

### 1.1 权威来源

本文档中所有引擎、模型、内置节点的数据，都来自下面两个 Rust 函数。它们是**唯一可信来源**，本文档只是它们的人读版本。

| 数据 | 权威来源 | 内容 |
| --- | --- | --- |
| 引擎目录（11 个）与模型清单（8 个） | `engine_catalog()`，位于 `crates/toolforge-core/src/engine.rs` | 返回 `Vec<EngineDescriptor>`：引擎的许可证、许可证注意事项、体积、安装方式、支持平台、`provides` 能力标签；每个 `EngineModel` 还带 `usedBy`（这个权重是给哪个节点用的，**逐条写明，不再推断**） |
| 内置节点目录（32 个） | `builtin_nodes()`，位于 `crates/toolforge-core/src/pipeline.rs` | 返回 `Vec<NodeDescriptor>`：每个节点的 `requiresEngines`（必需引擎）与 `optionalEngines`（可选引擎），是本文档第 5 节降级矩阵的唯一依据 |
| 未实现节点名单（**0 个**） | `UNIMPLEMENTED_NODES`，同样位于 `crates/toolforge-core/src/pipeline.rs` | 返回 `&[&str]`。**现在是空数组**：32 个内置节点全都有执行器。这个常量刻意**保留**，因为前端仍通过 `NodeCatalogResponse.unimplemented` 拿它来决定"节点要不要标灰" —— 删掉它会让那句"该能力尚未实现"的提示失去数据来源 |

**维护约定：改代码必须同步改本文档。**

- 在 `engine_catalog()` 里新增、删除或改名引擎 → 必须同步更新第 2 节与第 3 节。
- 修改 `EngineModel` 的 `license` 或 `commercialUse` → 必须同步更新第 4 节，尤其是「不可商用」的标注。
- 修改 `NodeDescriptor` 的 `requiresEngines` / `optionalEngines` → 必须同步更新第 5 节。
- `crates/toolforge-core/src/engine.rs` 中已有测试 `every_provided_capability_maps_to_a_real_node`（引擎声明的能力必须都有对应节点）与 `every_node_engine_reference_exists_in_catalog`（节点引用的引擎必须都在引擎目录里）在守护前两份数据的一致性。第三份（权重的 `used_by`）由 `verified_sources_are_pinned` 里新增的一段断言守护：每个权重必须写明非空的 `used_by`，且它声明的每个节点名都必须在 `builtin_nodes()` 里真实存在。本文档就是这些测试的说明版本。

### 1.2 实现状态（以仓库实际文件为准）

本节的落地状态是**某一时刻的快照**。原因是：编写本文档期间，`crates/toolforge-plugins`、`crates/toolforge-engines/src/nodes.rs`、`apps/desktop/src-tauri` 等文件是在核对过程中被**并发写入**仓库的（`git status` 显示它们都是未跟踪的新增内容）。下表以最后一次核对的观察结果为准，并给出依据文件，便于读者自行复核；若文件清单已变，本表即为过期。

| 组件 | 落地状态（快照） | 依据文件 |
| --- | --- | --- |
| `crates/toolforge-core` | 已落地 | 12 个源文件（`lib.rs` + 11 个模块），含 `src/engine.rs`（引擎目录）、`src/pipeline.rs`（32 个内置节点）与 `src/ai.rs`（`VisionClient` 抽象，见 3.6） |
| `crates/toolforge-engines` | 已落地 | `Cargo.toml`、`src/lib.rs`、`src/registry.rs`、`src/nodes.rs`（节点执行实现）、`engine-sources.json`、`py/rembg.py` 与 `py/upscale.py`（两个推理脚本，都用 `include_str!` 编进二进制） |
| `crates/toolforge-process` | 已落地 | `src/lib.rs`、`src/exec.rs`、`src/rpc.rs`、`src/supervisor.rs` |
| `crates/toolforge-plugins` | **已补齐** | 7 个源文件：`lib.rs`、`audit.rs`、`store.rs`、`l1.rs`、`runtimes.rs`、`runtimes/wasm.rs`、`runtimes/python.rs`（编写本文档时只有前 3 个） |
| `crates/toolforge-ai` | **已补齐** | 3 个源文件：`lib.rs`、`provider.rs`、`review.rs`（编写本文档时目录尚不存在） |
| `apps/desktop` | **已落地** | `src-tauri/src/` 下有 `main.rs`、`lib.rs`、`commands.rs`、`ipc.rs`、`state.rs`、`settings_store.rs`、`bin/`；前端 `apps/desktop/src/` 也已存在（`lib/ipc.ts` 是唯一 IPC 出口，`bindings.ts` 由 specta 生成并入库） |

有两点必须讲清楚：

1. **本文档最早写作时没有运行过 `cargo build` / `cargo test`**，因此当时不对「当前能否构建成功」下结论。可以确认的是：根 `Cargo.toml` 的 `members = ["crates/*", "apps/desktop/src-tauri"]` 现在都有对应目录。
   > ✅ **已更新（现在有实测数据了）**：`cargo test --workspace` 的 Rust 测试为 **258 passed / 0 failed**；`scripts/devtools/verify-platform.mjs`（`scripts/devtools/run.mjs` 里的第 5 个脚本）**193 项检查全通过**（覆盖【1】–【20】），其中【6】号检查就是盯着"图片后端到底有没有真的被调用"、【7】号检查盯着任意角度旋转会不会静默取整、【8】号检查盯着**抠图这条 ONNX 链路能不能真的出透明背景**、【9】号盯着电子书转换的降级与拦停、【10】号用假 AI 端点验证图像描述的请求形状、【11】号盯着超分是不是真的按倍数放大、【12】号把 `libvips` 目录临时藏起来、断言后端真的切到 ImageMagick 再在 `finally` 里还原（【12】只在 libvips 与 imagemagick **都装了**时才跑，否则显式记为"跳过"）、【13】号把两个引擎的**托管目录都**藏起来、断言兜底档真的接得住（后端 = 纯 Rust image crate、任务仍然成功、产出无损 VP8L、并如实提示「只有无损模式」，同样在 `finally` 里还原）、【18】号验证压缩包节点真的产出**标准 zip**（并用系统 tar 独立解回来逐字节比对，见 3.4）、【19】号验证 `doc.to-pdf` 真的转出内容正确的 PDF（见 3.3）、【20】号验证"一句话生成插件"这条闭环真的能走完（草稿 → 审核 → 安装 → 跑出东西，见 ROADMAP §3.3）。
   > 上面这句话里的"218 passed / 82 项 / 【1】–【13】"是本条最初写下时的值，**保留作为历史**；当前值是 **258 / 193 / 【1】–【20】**。
   > **节点层面已经没有"未实现"这回事了**：`builtin_nodes()` 登记 32 个，`nodes.rs::run()` 的 32 个分发臂全都指向真实实现，`UNIMPLEMENTED_NODES` 是**空数组**。第 5 节的降级矩阵里，图像域的四行、抠图、电子书、超分、OCR、图像描述都已有实测或明确的失败路径；其余各行仍然只是 `builtin_nodes()` 声明的引擎依赖关系，不是经测试验证的运行时行为。（相关实测结论见 `docs/ROADMAP.md` 的「当前阻塞项」与「基线再更新」。）
   > ✅ **中间档的环境基线已不再是空白**：以前这里写着"本机没有 ImageMagick，'仅 ImageMagick'这一档始终没有单独的环境基线"。现在它有了 —— 把 `engines/libvips` 临时改名后 `image.convert` 的后端日志变成 `后端 = ImageMagick（格式最全）`，并产出有损 VP8 WebP（见 3.2）；`verify-platform.mjs`【12】把这次验证固化进了套件。**三档现在都有证据：libvips ✓（【6】）、ImageMagick ✓（【12】）、纯 Rust ✓（【13】）。** 仍然没有基线的只有 macOS 本身（那需要一个 macOS 环境）；它的下载源**已经不再是空白** —— 13/14 条带真实哈希，只剩 `ffmpeg@macos` 是 `null`（见 1.3）。`7zip` 的三平台也补上了，压缩包节点现在有真机基线（【18】，见 3.4）。
2. 本文档因此同时承担两个角色：**引擎层规格说明**（现在就能定下来的接口契约：有哪些引擎、能力边界、许可证约束、降级规则）与**待实现清单**（第 6 节列出尚未落地的部分与已知的数据不一致）。

> 核对说明：任务简报假定「仓库目前只存在 `crates/toolforge-core`，`toolforge-engines` / `toolforge-process` / `toolforge-plugins` / `toolforge-ai` 以及 `apps/desktop` 都还没落地」。实际核对后，这些组件中的多数已经存在（其中一部分正是在核对期间被并行写入的）。本节按仓库实际文件撰写，未沿用该假定。

### 1.3 下载地址与校验哈希：八个模型，五个有、三个刻意没有

`EngineModel` 结构体（`crates/toolforge-core/src/engine.rs`）中，`url` / `sha256` / `file_name` 都是 `Option<String>`。`onnx-models` 现在的模型清单是 **8 个**（抠图 5 个 + 超分 3 个），其中 **5 个有完整来源**：

- **`u2net`、`u2netp`、`isnet-general` 三个抠图权重已有完整来源**：`url` 指向 `https://github.com/danielgatis/rembg/releases/download/v0.0.0/<资产名>`（release tag 字面就是 `v0.0.0`），`sha256` 是**真实下载后自己算出来的**，不是从网页抄的；`file_name` 单独一个字段，因为 GitHub 的资产名与模型 id **并不一致**（`isnet-general` 的资产是 `isnet-general-use.onnx`）。
- **`realesr-general-x4v3`、`realesrgan-anime6b` 两个超分权重也有完整来源**：它们从 Hugging Face 取（`resolve/main/<资产名>`），哈希同样是**真实下载后算出来的**。这两条的输入尺寸都是**动态**的，所以不需要切块补边就能对任意尺寸直接推理 —— 这也是它们被选为默认与备选的原因（见第 4 节）。
- 文件统一落在 `<data_dir>/models/<model_id>/<file_name>`。
- **`birefnet-general`、`modnet-portrait` 两个刻意没有 url/hash**（`url: None` / `sha256: None` / `file_name: None`），缺的是"还没核对过的哈希"。
  > ✅ **`realesrgan-x4plus` 曾经也在这条里，现在有源了。** 它当时缺的不是哈希，而是**能用的 ONNX 导出**（找到的都是固定输入尺寸，要先补"补齐 → 推理 → 裁回"）。三件事现在都做完了：补边逻辑（`py/upscale.py` 读会话输入形状，固定尺寸时 `np.pad(mode="edge")` 补到 256×256 再裁回）、接缝检查（新增 `seamRatioX/Y` 指标 + 两条反证）、真实下载后的哈希。详见第 4 节。
  > UI 对那两条仍然显示「无下载源」并把下载按钮**置灰**。
- 单测 `verified_sources_are_pinned` 强制 url / sha256 / file_name **三者全有或全无**，哈希必须是 64 位小写十六进制，且 `file_name` 不得重复；同一个测试里还要求 `url` **必须以 `file_name` 结尾**，并要求每条权重写明非空的 `used_by`。

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
    used_by: vec!["image.remove-background".into()],
},
```

**结论：上面五个模型能在本文档里写出具体的 URL 与 SHA-256**（第 4 节逐条列出）。剩下三个模型的这两列继续标注「待定」，因为代码里就是 `None` —— 写进本文档就是臆造。补齐它们必须先核对真实哈希（x4plus 还得先解决固定输入尺寸），再改代码，最后同步本文档（1.1 的维护约定）。

**`used_by` 这个字段值得单独说一句**：它记的是"这个权重是给哪个节点用的"，而且是**逐条手写**的。在此之前归属是**推断**出来的（"这个权重属于哪个引擎，就服务于那个引擎声明的能力"），而 `onnx-models` 同时承载抠图与超分 —— 推断于是把 `u2netp`（一个分割模型）也算成了 `ai.upscale` 的来源。`models_list` 现在直接读 `used_by`，不再做任何推断。

另外有两点必须如实说明：

- `crates/toolforge-engines/engine-sources.json` 是一个**独立于 `EngineModel` 的来源清单**（对应 `registry::EngineSourceSpec`）。
  > ✅ **现在是 14 条，其中 13 条带真实哈希**（Windows 7 / Linux 4 / macOS 3）：`ffmpeg`@windows·linux·macos、`libvips`@windows、`imagemagick`@windows、`pandoc`@windows·linux、`python`@windows·linux·macos、`poppler`@windows、**`7zip`@windows·linux·macos**。每条都带**实际核对的 SHA-256** 与**版本固定直链**；`registry.rs` 规定 `sha256` 为 `None` 时拒绝下载，所以**唯一**仍是 `null` 的是 `ffmpeg@macos`（evermeet 那条取不到字节，见 3.4）。核对方式与实测版本表见 `docs/ROADMAP.md` §3。
  > ⚠️ **关于 `ffmpeg@windows` 的一条环境事实**：这里的历史注记写着「哈希取自 gyan.dev 随包发布的 `.sha256` 旁挂文件，但本机连不上 gyan.dev，所以 FFmpeg 的安装在本机没有完成过」。**这两件事现在都变了**：① 来源换成了 BtbN 的 GitHub 版本固定直链（gyan.dev 实测只有 15~43 KB/s，105 MB **根本下不完**；GitHub 上 9.3 MB/s），哈希因此变成"自己下载后计算"；② FFmpeg **已经在本机装成功**（n8.1.3，484 MB，`force` 安装，引擎状态 `installed`），Linux 变体也实测下载并核对了哈希。
  > ✅ **`7zip` 的条目回来了 —— 而且三平台都有**（历史注记曾写着"已移除：官方只提供安装器，或需要先有 7-Zip 才能解压的 `.7z`，且那条直链实测 404，因此改为仅系统安装"）。**那句理由的前半句是错的**：Windows 10 1803+ 自带的 `tar`（bsdtar）**能读 7z** —— ImageMagick 的便携版就是 `.7z`，它的一键安装实测成功过。真正的原因只是那条 URL 过期（`7z2408-extra.7z` → 现在上游是 26.03）。于是现在：Windows 走 `.msi` 的**管理安装**（`msiexec /a`，拿到的是含 RAR 的**完整版**）、Linux / macOS 走上游发的完整 `7z2603-linux-x64.tar.xz` / `7z2603-mac.tar.xz`。**一个错误的理由 + 一个过期的地址，让一个核心引擎在 Windows 上长期只能手动装** —— 这条留在文档里，因为它不是配置问题，是推理问题。详见 3.4 与 `engine-sources.json` 里那条 note。
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
| `libvips` | libvips | 低内存、流式的大图处理库。批量处理上千张图时比逐个解码快数倍。 | `LGPL-2.1` | 以动态库方式调用即可满足 LGPL 要求，无需开源你的代码。 | 约 30 MB（8.18.6 x64-web 压缩包实测 10.8 MB） | 仅探测系统已安装；应用按需下载 | `image.convert`<br>`image.resize`<br>`image.crop`<br>`image.rotate` | Windows / macOS / Linux | 否 |
| `imagemagick` | ImageMagick | 格式覆盖最全的图像处理工具集，作为 libvips 的兜底。 | `ImageMagick License（Apache-2.0 风格）` | 本体宽松，但若链接了 GPL 组件（如部分 delegate）会传染，分发前需确认构建配置。 | 约 60 MB | 仅探测系统已安装；应用按需下载 | `image.convert`<br>`image.resize`<br>`image.crop`<br>`image.rotate` | Windows / macOS / Linux | 否 |
| `pandoc` | Pandoc（核心引擎） | 文档格式转换的瑞士军刀：Markdown / HTML / DOCX / EPUB / LaTeX 互转。 | `GPL-2.0+` | 以独立进程调用不构成衍生作品，可随闭源应用分发；但不得静态链接进你的二进制。 | 约 40 MB | 仅探测系统已安装；应用按需下载 | `doc.convert`<br>`ebook.convert` | Windows / macOS / Linux | 是 |
| `libreoffice` | LibreOffice (headless) | Office 文档转 PDF 的事实标准。冷启动 2~5 秒，ToolForge 会复用常驻进程。 | `MPL-2.0` | MPL 是文件级 copyleft，独立进程调用无传染风险。 | 约 420 MB | 仅探测系统已安装 | `doc.to-pdf` | Windows / macOS / Linux | 是 |
| `7zip` | 7-Zip（核心引擎） | 压缩解压，覆盖 zip / 7z / rar / tar 等格式。 | `LGPL-2.1+（含 unRAR 限制条款）` | unRAR 代码禁止用于开发 RAR 压缩器；解压用途不受影响。 | 约 5 MB（26.03：Windows 安装包 2.0 MB / Linux 1.6 MB / macOS 1.9 MB） | 仅探测系统已安装；**三平台都可一键下载**（Windows 走 `.msi` 管理安装，Linux/macOS 走上游 tar.xz） | `archive.pack`<br>`archive.unpack` | Windows / macOS / Linux | 否 |
| `calibre` | Calibre | 电子书格式转换与元数据管理（EPUB / MOBI / AZW3）。 | `GPL-3.0` | GPL-3.0 为强 copyleft。仅以独立进程调用；如要随包分发请先做合规评审。 | 约 180 MB | 仅探测系统已安装 | `ebook.convert` | Windows / macOS / Linux | 是 |
| `python` | Python 运行时 | L3 插件的执行环境（独立 3.11 运行时，与系统 Python 隔离）。 | `PSF-2.0` | 宽松许可；注意随包分发的第三方 wheel 各自的许可证。 | 约 150 MB | 应用按需下载 | `image.remove-background`<br>`ai.upscale` | Windows / macOS / Linux | 否 |
| `onnx-models` | ONNX 模型包 | 抠图 / 超分 / 分割用的模型权重。**不随安装包分发，首次使用时下载**。 | `各模型不同（见下表）` | 代码许可与权重许可是两回事。U2Net 为 Apache-2.0 可商用；MODNet 权重为学术许可；BiRefNet 权重受训练集条款限制。 | 约 180 MB（引擎级估算） | 应用按需下载 | `image.remove-background`<br>`ai.upscale` | Windows / macOS / Linux | 是 |
| `tesseract` | Tesseract OCR | 离线 OCR。中文识别质量一般，但完全免费且无需联网。 | `Apache-2.0` | 语言数据包（tessdata）另有许可，chi_sim 为 Apache-2.0。 | 约 60 MB | 仅探测系统已安装 | `doc.ocr` | Windows / macOS / Linux | 否 |
| `poppler` | Poppler（PDF 栅格化） | 把 PDF 按页渲染成图片，是「扫描件 PDF 做 OCR」的前置步骤。单独装它不会让 OCR 更好，但没有它 `doc.ocr` 就只能吃图片。 | `GPL-2.0-or-later` | **GPL**：应用只调用它的命令行工具（`pdftoppm`）并原样转发用户的文件，不链接它的代码、不随应用分发。介意 GPL 的话不要装 —— 装 Tesseract + 自己把 PDF 页面存成图片走的是同一条 OCR 路径。 | 约 42 MB（26.09.0 压缩包实测 41.7 MB，解压后 120.7 MB） | 仅探测系统已安装；Windows 应用按需下载（macOS/Linux 走系统包管理器） | `doc.ocr` | Windows / macOS / Linux | 是 |
| `ai-provider` | AI 服务提供方 | OpenAI 兼容接口的大模型服务，用于插件生成、图像描述等。 | `依服务商条款` | API Key 默认只存在内存里（重启要重填）。打开「记住 API Key」后会以**明文**另存到数据目录下的 `ai-key.txt` —— 系统钥匙串尚未接入。它不会随插件或日志外泄。 | 约 0 MB（无本地二进制） | 远程服务无本地二进制 | `ai.describe`<br>`doc.ocr` | Windows / macOS / Linux | 否 |

### 2.1 总表读法

- **核心引擎共 3 个**：`ffmpeg`、`pandoc`、`7zip`。它们在名称后标注了「（核心引擎）」。缺失时应用**仍然能启动**，但依赖它们的节点不可用：`ffmpeg` 缺失 → 5 个 `video.*` 与 2 个 `audio.*` 节点不可用；`pandoc` 缺失 → `doc.convert` 不可用，并且 `ebook.convert` 失去唯一的纯文档转换后端；`7zip` 缺失 → `archive.pack` / `archive.unpack` 不可用。
- **只有 `System` 一种安装方式的引擎只剩 2 个**：`calibre`（约 180 MB）、`tesseract`（约 60 MB）—— 这两个上游只发安装器，没有可解包的归档。
  > 📌 **`libreoffice` 本轮从这一组移出**：它的历史注记写着"上游只发 `.msi`/`.dmg`/`.deb` 安装器，没有解压即用的归档，所以没有可管理的下载源"。前半句是事实，**结论不对** —— `msiexec /a` 的**管理安装不是安装**（不写注册表、不装服务、不需要管理员权限），它就是把包内容铺到目录里。7-Zip 走同一条路（见 1.3、3.4 与本节的 3.3）。
  > 📌 **`7zip` 曾经在这一组，现在不在**：它是 `System` + `Download` 双模式、且**三平台都能装**（Windows 走 `.msi` 管理安装、Linux/macOS 走上游的完整 tar.xz）。历史注记给的理由（"`.7z` 需要先有 7-Zip 才能解压"）**是错的** —— Windows 自带的 bsdtar 读得懂 7z；真正的原因只是那条 URL 过期。见 1.3 与 3.4。
  > 📌 **`poppler` 也不在这一组**：它是 `Download` + `System` 双模式（Windows 有一键下载，macOS/Linux 走系统包管理器）。它的 `MANAGED_LAYOUT` 是 `Library/bin/pdftoppm` —— 那两层目录不能省，因为 pdftoppm 是按**自己所在目录的相对位置**去找 `../share/poppler` 的数据文件的（`engine-sources.json` 里把这条写进了 note）。
- **只有 `Download` 一种安装方式的引擎共 2 个**：`python`、`onnx-models`。
  > ⚠️ **这句原来接着写的是「二者不探测系统安装」—— 那是错的（本条已修正）。** `install_modes` 只决定「应用能不能替你下载」，**不决定探测范围**：`probe()` 的顺序是 ① 托管目录 → ② PATH → ③ 平台常见路径，对所有引擎一视同仁。所以系统里已有的 Python 会被探到，状态是 `Detected` / `source: System`。这恰恰是 `force` 标志与「另外安装应用托管版本」按钮存在的原因 —— **"探测到可用"不等于"满足这个节点的要求"**，系统 Python 3.14 显示可用却跑不了 `onnxruntime`（见 3.2、3.6）。`onnx-models` 是唯一的例外，它没有二进制，走下面那条虚拟引擎判据。
- **"能不能一键下载"是平台级的事实，不是引擎级的**：`EngineDescriptor::download_platforms` 就是这条事实的数据形式。它存在的原因是 `install_modes` 太粗 —— `libvips` 声明 `Download` 时只有 Windows 有预编译包，macOS 用户却会看到一个点了必然失败的按钮。它与 `engine-sources.json` 的核对是**双向的**且**平台无关**（`download_platforms_are_backed_by_real_sources`）：写了某平台却没有来源 → 失败；有来源却没写 → 也失败；`install_modes` 含 `Download` ⟺ `download_platforms` 非空。**这条测试能在任何操作系统上跑**，取代了此前"只在当前平台取样"的检查 —— macOS 那两条死源（`libvips` 的 404 地址、`pandoc` 的 `.pkg`）就是这么漏过去的。
- **只有 `Remote` 一种安装方式的引擎共 1 个**：`ai-provider`。体积记为 0 MB，因为它没有本地二进制。
- **需要用户确认许可证（`requiresLicenseAck: true`）的引擎共 6 个**：`ffmpeg`、`pandoc`、`libreoffice`、`calibre`、`onnx-models`、`poppler`。UI 必须在用户点击「下载」之前就把许可证讲清楚（这是 `engine.rs` 中 `licenses` 字段刻意保留的原因）。
- **全部 12 个引擎都声明支持三平台**：Windows / macOS / Linux。当前目录中没有平台受限的引擎。

---

## 3. 按功能域分组的引擎说明

本章逐个说明每个引擎：它提供哪些内置节点、缺失时会发生什么、许可证与分发注意点。所有「提供的节点」均取自该引擎的 `provides` 字段。

### 3.1 音视频域

#### FFmpeg（`ffmpeg`，核心引擎）

- **主页**：https://ffmpeg.org/
- **提供的节点（7 个）**：`video.transcode`、`video.trim`、`video.thumbnail`、`video.extract-audio`、`video.compress`、`audio.convert`、`audio.normalize`。
  > ✅ **这 7 个节点在 FFmpeg 装通之前一次都没被跑过**（界面上它们一直显示"不可用"）。真机跑一遍之后抓到三个缺陷，详见 `docs/ROADMAP.md` 阻塞 18 与 `verify-platform.mjs`【17】：
  > ① `video.trim` 的流复制路径带 `-avoid_negative_ts make_zero`，**切片长度会变成两倍**（要 1 秒给 2.02 秒 / 30 帧而不是 15 帧）；
  > ② `video.transcode` 的容器参数叫 `container`，而真正决定容器的是 `build_io` 从 **`format`** 推出来的扩展名 —— 那个参数是**装饰**；现统一为 `format`；
  > ③ `audio.normalize` 的 `loudnorm` 会**悄悄把 44.1 kHz 重采样成 48 kHz**（滤镜内部按 192 kHz 处理、再落到编码器默认值），现在显式 `-ar` 保住源采样率。
- **缺失时会发生什么**：上述 7 个节点**全部不可用**，没有降级路径。这是全部功能域中影响面最大的单点依赖——音视频域目前只有这一个引擎。UI 应显示「需要安装 FFmpeg」并提供下载入口。
- **许可证与分发注意点**：`LGPL-2.1+ / GPL-2.0+（取决于编译选项）`。官方构建常启用 GPL 组件，如果产品闭源分发，必须选用 LGPL 构建或自行编译。`requiresLicenseAck: true`，下载前必须让用户确认。
- **三平台的来源都有条目**（Windows / Linux 已带真实哈希；macOS 的哈希仍为 `null`，但**有地址**，见下）：
  - `ffmpeg@windows` / `ffmpeg@linux`：**BtbN 的 GitHub 版本固定直链**（`autobuild-2026-09-26-13-03`，n8.1.3）。换源的原因不是"想换个新的"：gyan.dev 实测只有 **15~43 KB/s**（105 MB 要 40 分钟以上，而客户端总超时当时是 30 分钟 —— 也就是说它**根本下不完**），GitHub 上是 9.3 MB/s。
  - 两个已知代价，写清楚：① BtbN **不发布校验和**，所以这两条的哈希是**自己下载后算的**，溯源强度低于"上游旁挂文件"；② 是 **GPL 构建**（`-gpl`，含 libx264 / libx265）—— BtbN 另有 `-lgpl` 构建，但**它不含 libx264**，`video.compress` / `video.transcode` 会直接不可用。许可证影响面由"不随应用分发、用户按需下载"限制住。
  - `ffmpeg@macos`：evermeet 的版本直链（9.0.2，26,198,325 字节），**`sha256` 仍是 `null`** —— 本机取不到字节（HEAD / GET 都试过；它的 `info` 接口是通的，所以不是站点整体不可达）。**拿不到字节就不填哈希**：抄一个哈希比不填更糟。装它需要用户显式勾选「允许安装没有校验值的来源」（对话框里本来就有这一项），或者 `brew install ffmpeg`。
  - 📌 **两条为 macOS 找过的"别的路"，都还没走到能写进数据表的程度**（记下来是因为"查过、不行"和"没查"下一个人分不出来）：
    1. **`eugeneware/ffmpeg-static`（npm 包 `ffmpeg-static` 的发布资产）**。已核实：最新 tag `b6.1.1`，每个平台发**两个独立的裸 gz 单文件** —— `ffmpeg-darwin-arm64.gz`（19,246,198 字节）与 `ffprobe-darwin-arm64.gz`（19,207,077 字节），另有 `LICENSE` / `README`。**四条拦路的问题**：① 它是 FFmpeg **6.1.1**，比现在用的 n8.1.3 老很多；② 一条来源只能带**一个**归档，而这里 `ffmpeg` 与 `ffprobe` 是**两个文件** —— `engine-sources.json` 还没有"附属二进制"这个概念（分离它们需要先有 schema）；③ 归档是**裸 `.gz`**（不是 `tar.gz`），要新增一条解包分支；④ 它是**第三方重新托管**：哈希可以自己算（完整性没问题），但"这份字节是谁构建的、从哪来的"溯源强度低于上游直链 —— 这一点在没有读通它的 README 之前不该替它下结论。
    2. **evermeet 其实提供了 `.sig` 签名文件**（它的 `info` 接口里给了 `zip.url` 与签名地址）。也就是说"没有哈希"并不等于"无法验证"—— 但要用上它就得引入一条 **GPG 校验路径**（当前的校验只有 SHA-256，`install()` 的 `HashRequired` 闸门也是按这个写的）。这是 v0.2 的设计题，不是现在能顺手加的东西。

#### 音频节点与 FFmpeg 的关系

`audio.convert` 与 `audio.normalize` 同样只依赖 `ffmpeg`（`requiresEngines` 为 `["ffmpeg"]`），没有独立的音频引擎。因此**音频域不存在独立降级空间**：FFmpeg 缺失即两个音频节点不可用。

### 3.2 图像域

#### libvips（`libvips`）

- **主页**：https://www.libvips.org/
- **提供的节点（4 个）**：`image.convert`、`image.resize`、`image.crop`、`image.rotate`。
  > ⚠️ **这张清单此前是错的，现已按实际调用改正**：它原来写着 `image.enhance` 与 `image.strip-metadata` —— 那两个节点**只有纯 Rust 实现**，装了 libvips 一点变化都没有；同时漏了 `image.crop` 与 `image.rotate`，而它们**真的**会调 libvips。这属于最坏的一类不一致：用户为两个用不上的功能去下 30 MB 的库，而真正受益的两个功能反倒没被标出来。修法与守卫见 6.2。
- **缺失时会发生什么**：这 4 个节点不会失效，因为它们的 `requiresEngines` 都是空数组，libvips 只是 `optionalEngines` 中的首选。缺失后自动降级：先退到 ImageMagick，两者都缺失时退到纯 Rust 的 `image` crate。代价是批量/大图场景更慢、更吃内存（libvips 的价值正是在于低内存、流式处理）。
  > ✅ **这条降级链现在是真的 —— 但只覆盖 4 个节点**：`nodes.rs::pick_image_backend()` 真的按 `libvips → imagemagick → 纯 Rust` 的顺序挑后端，并把用的是哪个报在节点输出的 `backend` 里（详见 5.1）。走这条链的是 **`image.convert` / `image.resize` / `image.crop` / `image.rotate`**；而 **`image.enhance` 与 `image.strip-metadata` 仍然是纯 Rust 实现、一行都不问引擎** —— 对应的 `provides` 声明已经撤掉（见 6.2），所以现在声明与实现是一致的。
- **已实测的一键安装**：libvips 8.18.6 通过应用安装成功，可执行文件落在托管布局的 `…/engines/libvips/bin/vips.exe`，磁盘占用约 29.67 MB（数据点与顺带修掉的两个 `toolforge-process` 缺陷见 1.3）。
- **Linux / macOS 为什么没有来源（查过，不是没查）**：上游 `libvips/libvips` 的 release 里**只有源码包**（`vips-8.18.6.tar.xz`），既没有 macOS 也没有 Linux 二进制；Windows 有对应的构建仓库（`libvips/build-win64-mxe`），**macOS / Linux 没有对应物**。也查过 Homebrew 的 bottle（那是能下载的 tar.gz），但 bottle 里的 dylib 依赖其它几十个 formula，单独解出来跑不起来 —— 所以这两个平台走 `brew install vips` / `apt install libvips-tools`。**这一条曾经写着一份并不存在的 macOS 资产**（详见 1.3 与 `engine-sources.json` 的教训）。
- **许可证与分发注意点**：`LGPL-2.1`。以动态库方式调用即可满足 LGPL 要求，无需开源你自己的代码——这也是它被选为图像域首选引擎的原因。`requiresLicenseAck: false`。

#### ImageMagick（`imagemagick`）

- **主页**：https://imagemagick.org/
- **提供的节点（4 个）**：`image.convert`、`image.resize`、`image.crop`、`image.rotate`。与 libvips 的清单**完全相同** —— 两者是同一层的同类后端，唯一的差别是调用先后（libvips 优先）。
- **缺失时会发生什么**：节点仍可用（都不是必需引擎），但 `image.convert` / `image.resize` / `image.crop` / `image.rotate` 会失去第二层兜底（libvips 仍优先）。`image.rotate` 的处境要看实现而不是看声明：libvips 可用时 `nodes.rs::image_rotate` 会**先用 libvips**（非 90° 倍数用 `vips similarity --angle`，ImageMagick 用 `-rotate`），**只有两个引擎都没有、只剩纯 Rust 时**才返回 `EngineMissing`（见 5.1）。
- **Windows 上现在有下载源了（本轮新增）**：`imagemagick@windows` → `ImageMagick-7.1.2-31-portable-Q16-x64.7z`（11,739,115 字节，sha256 `33d8b47b…`，`archive: "7z"`，**`stripComponents: 0`**）。三点结论是**直接执行**出来的，不是推断：① 官方 Windows 便携包**只有 `.7z`**（没有 zip）；② **Windows 自带的 `tar`（bsdtar / libarchive）能读 7z** —— 实测 `tar -xf` 退出码 0、`magick.exe -version` 打印 `ImageMagick 7.1.2-31 Q16 x64`，所以装 ImageMagick **不需要先装 7-Zip**（那正是当初把 7-Zip 自己设成 System-only 的死结）；③ 压缩包里**没有顶层目录**（23 个条目直接在根），所以 `stripComponents` 必须是 0 而不是习惯上的 1。Linux / macOS **故意不写来源**（走 `apt` / `brew`）。
  > ✅ **已复验（这条 ⚠️ 至此解除，保留作历史）**：原本写的是"应用内的完整安装链路**没有复验**"——会话期间 `toolforge.exe` 被一个无关进程持有文件句柄，cargo 写不回链接产物（`link.exe` 1104），二进制重建不了、跑不了。句柄释放后重建并**真的装了一遍**：11.7 MB 下载 → SHA-256 校验通过 → 系统 `tar` 解开 `.7z` → `magick.exe` 落在 `…/engines/imagemagick/magick.exe`，**241.5 MB**，探测到的版本是 `ImageMagick 7.1.2-31 Q16 x64`。所以上面那四点从"直接执行验证过的前提"升级成了"整条链路端到端跑通"。
  > ⚠️ **FFmpeg 是另一回事，它仍然没装成**（历史注记，保留）：当时本机 `www.gyan.dev` 不可达，所以 `ffmpeg@windows` 的应用内安装链路没有被验证过。**这件事后来解决了** —— 来源换成 BtbN 的 GitHub 版本固定直链（gyan.dev 实测只有 15~43 KB/s，105 MB 根本下不完），FFmpeg 已装通并真跑过。
- **Linux / macOS 为什么还是没有来源（查过，不是没查）**：GitHub release 里 Linux **只有 AppImage**（`ImageMagick-7.1.2-31-gcc-x86_64.AppImage`，33 MB）、macOS **完全没有便携归档**（只有 `.pkg` / `.dmg` 安装器）。AppImage 看着是个单文件、很适合 `archive: "raw"`，但**实际不行**：它要靠 FUSE 挂载（很多容器 / 服务器上不可用），拿到手还得 `chmod +x`，而托管布局按名字找的是 `magick` —— 一个叫 `ImageMagick-7.1.2-31-gcc-x86_64.AppImage` 的文件不会被认为"ImageMagick 已就位"。要支持它得为 AppImage 单独写一条解包路径，收益（`apt install imagemagick` / `brew install imagemagick` 一行命令的事）远小于代价，所以**刻意不写来源**：宁可按钮是灰的，也不放一个点了装不上的按钮。
- **实测过的后端切换（本轮新增）**：把 `engines/libvips` 临时改名成 `engines_probe_all` → 应用日志里 `image.convert` 报 `后端 = ImageMagick（格式最全）`，并且真的产出了**有损 VP8** 的 WebP；随后把目录改回来，探测状态恢复为 `libvips = installed`。这就是"只有 ImageMagick 可用"那一档的环境基线 —— 它以前一直是空的，因为本机从来没装过 ImageMagick。`verify-platform.mjs`【12】把这个动作固化成了检查（改名 → 断言 → `finally` 还原，失败也会还原）。
- **许可证与分发注意点**：`ImageMagick License（Apache-2.0 风格）`，本体宽松；但若链接了 GPL 组件（如部分 delegate）会传染，分发前需确认构建配置。`requiresLicenseAck: false`。

#### Python 运行时 + ONNX 模型包（抠图与超分）—— **ONNX 路径，不属于三层降级链**

- 见 3.6 中的 `python` 与 `onnx-models` 条目。图像域的 `image.remove-background`（抠图去背景）与 `ai.upscale`（AI 超分）**都同时要求两个引擎**（`requiresEngines: ["python", "onnx-models"]`），任一缺失即不可用，且没有降级路径。
- **它们不属于上面那张 `libvips → ImageMagick → 纯 Rust` 的表**。这一条很容易被误读，必须写清楚：**这是第四条路（ONNX 推理），三层降级一格都不覆盖它。** libvips / ImageMagick 再全，也做不了"从图里判断哪个像素是主体"或者"把细节补出来"这两件事——那是模型的工作，不是图像处理库的工作。反过来，装齐两个引擎也**不会**让推理在缺 libvips 时变慢，因为它们压根不经过 `pick_image_backend()`。
- **执行方式**：两个节点都不自己做推理，而是把推理交给一个 **Python 子进程**（`python` 引擎），并各自带一个推理脚本。
  - 抠图用 `crates/toolforge-engines/py/rembg.py`；超分用 `crates/toolforge-engines/py/upscale.py`。两者都用 `include_str!` 编进二进制，运行时释放到 `<data>/cache/onnx-runtime/`。**刻意不做成 Tauri 的 bundle resource**：资源路径在开发态 / 打包态 / 各平台之间都不一样，而这些脚本只有几 KB，一旦"从包里找不到"就是一个极难查的运行时故障——编进二进制就不会丢。
  - **为什么不写在 Rust 里**：Rust 的 ONNX 绑定 `ort` 会在**构建期**下载预编译原生库。那会让离线 / 内网构建直接失败，而"构建失败"的代价远大于"多一个运行时依赖"。Python 的 `onnxruntime` 是成熟、可验证、进程内隔离的路径，而且 L3 插件运行时本来就要求一个受管 Python——复用它不引入新的东西。
- **超分的分块逻辑（`upscale.py`）与它自己的自检**：
  - **256 px 分块、16 px 重叠、只取中心区域贴回**（`tile` / `overlap` / `scale` 都是节点参数）。重叠的意义是让每块推理时都能看到周围上下文，而"只取中心贴回"是为了让边缘不留接缝。
  - 脚本会返回一份 JSON 报告，节点读它并入日志：`modelScale`（模型真实的放大倍数）、`targetScale`（用户要的倍数）、`uncoveredRatio`（**没有任何一块覆盖到的像素比例**）。`uncoveredRatio > 0.0001` 时节点会发一条 warn —— 那种情况属于**我们自己的分块 bug**，不该悄悄交付给用户。
  - **`scale=2|3` 的语义是"先用 4 倍推理，再用 Lanczos 缩回去"**：模型原生只有 4 倍，但缩回来的是**模型真算出来的细节**，比直接插值好得多。所以报告里 `modelScale` 恒为 4，`targetScale` 才是用户要的那个。
  - **脚本会自己验模型**：输入张量必须是 `[N,3,H,W]`、输出必须是 **3 通道**、输出的空间倍数必须是**整数且 ≥ 2**；不满足就**报错退出并打印模型真实的输出形状**。这段自检是被一次真实的错误逼出来的 —— 详见 3.2 的"一个全绿但结果是垃圾的检查"。
- **首次运行要准备两件事**，两个节点共用同一套准备（都会写进任务日志）：
  1. **模型权重**：用户在「设置 → 引擎管理 → 模型权重」里自己下（见第 4 节）。节点不会替用户偷偷下载权重。
  2. **依赖**：应用会在 `<data>/cache/onnx-runtime/` 下**另建一个独立 venv**，`pip install onnxruntime numpy pillow`（约 30 MB，一次性）。用独立 venv 是为了**不动用户自己的 Python**，卸载也只是删掉这个目录。
  - ⚠️ **这一步需要联网**。第一次跑这两个节点之一时才会发生；此后推理**完全本地、不联网、不上传图片**。**没有网络的机器在依赖就位之前用不了这两个节点。**（与 `ai.describe` / `doc.ocr` 的 AI 路径相反：那两个**会把图片上传给 AI 服务商**，见 `docs/SECURITY.md`。）
- **Python 版本要求：3.9 ~ 3.13**。原因是 `onnxruntime` 没有 3.14 的 wheel。若机器上只有 3.14，节点会返回一条明确的 `EngineMissing`，告诉用户去装应用托管的 Python 3.11，而不是抛一个看不懂的 pip 报错。
- **「探测到可用」不等于「满足我的要求」**：系统里那个 3.14 会被引擎管理显示为"可用"，但它跑不了 onnxruntime。因此 `EngineInstallRequest` 增加了 **`force`** 标志：`force: true` 会跳过「已经可用，不用下载」的短路，让用户**在系统 Python 之外**再装一份应用托管的副本。引擎卡片上对应一个「另外安装应用托管版本」按钮（当 `status.source === "system"` 且 `entry.managedAvailable` 时显示），背后是 `EngineEntry.managedAvailable` 与 `EngineRegistry::has_download_source()`。

#### ⚠️ 一个全绿但结果是垃圾的检查（这一课值得单独记下来）

这是本项目迄今最有教育意义的一次失误，因为它同时毁掉了"单元测试通过"与"验证脚本通过"这两个信号：

1. **成因是"归属靠推断"**。验证脚本要挑一个超分权重来跑 `ai.upscale`，它挑模型的依据是"**这个权重服务于哪个节点**"—— 而这个归属当时是**从所属引擎推断**出来的。`onnx-models` 同时承载抠图与超分，于是推断得出：`u2netp`（一个**分割**模型）也服务于 `ai.upscale`。
2. **于是脚本拿分割模型去超分**。脚本把图片喂进去，模型吐出的是单通道的 mask；脚本把这张 mask 当成普通图片，算出"倍数 = 1"，然后缩放到了目标尺寸 —— 而**每一条尺寸断言都通过了**。绿色对勾、零失败，输出是垃圾。
3. **三处修复，缺一不可**：
   - `EngineModel.used_by: Vec<String>` —— 每个权重的节点归属**逐条手写**，`models_list` 直接用它，不再做任何推断；`verified_sources_are_pinned` 里新增断言要求每条权重的 `used_by` 非空、且声明的节点必须在节点目录里真实存在（见 1.1、1.3）。
   - `upscale.py` 的**自检**：输入必须是 `[N,3,H,W]`、输出必须是 **3 通道**、空间倍数必须是**整数且 ≥ 2**，否则**报错退出并打印模型真实的输出形状**。也就是说，喂错了模型现在会**当场失败**，而不是"算出一个倍数然后照做"。
   - `verify-platform.mjs` 的**反向断言**：拿抠图权重去跑超分**必须失败、且不在磁盘上留下文件**；并且没有任何一个权重可以同时声称服务于 `image.remove-background` 与 `ai.upscale`。
4. **结论（比修 bug 更重要）**：**"测过了"这句话本身要能被质疑**。这次失败不是断言写错了，而是**断言测的东西根本不是要验证的东西** —— 尺寸确实算对了，可是它算的是一个错误的输入。凡是"验证脚本自己挑数据"的地方，都要问一句：**这个挑选依据本身可靠吗？** 归属靠推断、名字靠猜、路径靠拼接，这三类依据在这个项目里都出过错。

### 3.3 文档域

#### Pandoc（`pandoc`，核心引擎）

- **主页**：https://pandoc.org/
- **提供的节点（2 个）**：`doc.convert`、`ebook.convert`。
- **缺失时会发生什么**：`doc.convert` **不可用**（`requiresEngines: ["pandoc"]`，无降级）。`ebook.convert` 不会因此被标记为不可用（它的 `requiresEngines` 是空数组），但会失去唯一可用的降级后端——只剩 `calibre`。若 `calibre` 也不在，`ebook.convert` 将没有任何可用后端。
- **许可证与分发注意点**：`GPL-2.0+`。以独立进程调用不构成衍生作品，可随闭源应用分发；**但不得静态链接进你的二进制**。`requiresLicenseAck: true`。
- **下载源**：Windows（zip，39.8 MB）与 Linux（tar.gz，33.3 MB）都有真实哈希；**macOS 没有来源**，而且这一条是"文件真的存在、但装了也没用"的典型：上游只发 `.pkg`，而 `.pkg` 要用 `installer` 以 root 安装到 `/usr/local`，**不是一个能解压出来用的归档**。留着它的实际后果是 macOS 用户下完 39.8 MB、解压产物里找不到 `pandoc` 可执行文件，于是引擎仍然显示未安装 —— 花了流量，得到一句"没装上"。所以那条**整个删掉**，macOS 只走 `brew install pandoc`。
  > 📌 **一条留作 v0.2 的线索（没有验证过，所以没有写进数据表）**：macOS 自带 `pkgutil --expand-full <pkg> <dir>`，理论上能把 `.pkg` 解开、取出里面的 `pandoc` 二进制。**本机没有 macOS，这条路径一行都没有验证过** —— 按本项目的纪律，"看起来可行"不足以写进 `engine-sources.json`，所以它只是一条待验的线索，不是一个方案。

#### LibreOffice (headless)（`libreoffice`）

- **主页**：https://www.libreoffice.org/
- **提供的节点（1 个）**：`doc.to-pdf`。
- **缺失时会发生什么**：`doc.to-pdf` **不可用**，无降级路径（`requiresEngines: ["libreoffice"]`）。冷启动 2~5 秒，体积 420 MB 起 —— UI 要提前说明。
- ✅ **Windows 现在能一键装了（本轮），并且有了第一条真机基线**。历史注记在这里写的是「仅探测系统已安装，**应用不提供下载**」，理由是"上游只发 `.msi`/`.dmg`/`.deb` 安装器，没有解压即用的归档" —— 前半句是事实，**结论不对**：`msiexec /a` 的**管理安装不是安装**（不写注册表、不装服务、不需要管理员权限），它就是把包内容铺到目录里，正好是我们需要的"解包"。7-Zip 用的是同一条路（见 1.3 与 3.4）。
  - **来源用镜像，理由是实测的**：TDF 自己的下载主机（`download.documentfoundation.org`）从本机**连不上**（356 MB 的 `.msi` 请求 21 秒后 `Unable to connect`），而它同目录里就放着 `…msi.mirrorlist` —— **TDF 的字节分发本来就是镜像制**。清华 TUNA 实测 **10.6 MB/s（33 秒）**，中科大 USTC 报的是完全相同的 Content-Length，两条互为兜底（`fallbackUrl` 本轮从"只有模型有"扩展到引擎来源表）。
  - **实测的完整链路**（应用内一键安装）：下载 356 MB → SHA-256 通过 → 管理安装 → 探测 `installed`，路径 `…\engines\libreoffice\program/soffice.com`，版本 `LibreOffice 26.2.6.3`，**全程 76.7 秒**。解压后**没有 `Program Files\LibreOffice\` 那一层**，所以 `MANAGED_LAYOUT` 的 `program/soffice` 正好对上（1,522 MB）。
  - ⚠️ **`soffice.exe` 与 `soffice.com` 是两个不同的入口，选错会"沉默挂起"**：两者都在 `program/` 下、大小相同（523,688 字节），但 `soffice.exe` 是 GUI 子系统启动器 —— 跑 `--version` **不返回**（实测 >20 秒两次、>300 秒一次），于是探测会卡满 10 秒超时、版本永远「未知」。Windows 上托管布局因此刻意指向 `soffice.com`（见 `lib.rs::MANAGED_LAYOUT_PLATFORM_OVERRIDES`）。
  - ⚠️ **`-env:UserInstallation` 必须是合法 URL**：原来拼的是 `file:///{}` + `profile.display()`，Windows 上得到 `file:///C:\Users\…`（反斜杠）—— LibreOffice 的反应是**挂住**，不是报错（实测正斜杠 3 秒出 PDF、反斜杠 60 秒无输出）。已修为 `file_url()`（斜杠归一 + 最小百分号编码），有纯字符串回归测试。
  - ⚠️ **LibreOffice 对坏输入极其宽容**（按内容嗅探格式）：一段普通文本改名成 `.docx` 能正常转出 PDF；**4 KB 随机二进制**也"成功"（产出 781 KB 的 PDF）；**0 字节空文件**同样"成功"（6.5 KB）。所以"拒绝坏输入"不是这个节点能承担的责任，扩展名把关在插件/节点的 `accept` 列表那一层。`verify-platform.mjs`【19】因此把反证改成盯**我们自己的**不变量：绝不产出 0 字节的 PDF 冒充成功。
- **许可证与分发注意点**：`MPL-2.0`，文件级 copyleft，独立进程调用无传染风险。`requiresLicenseAck: true`。

#### Tesseract OCR（`tesseract`）

- **主页**：https://github.com/tesseract-ocr/tesseract
- **提供的节点（1 个）**：`doc.ocr`。
- **缺失时会发生什么**：`doc.ocr` 的 `requiresEngines` 现在是**空数组**，`optionalEngines` 是 `["tesseract", "ai-provider", "poppler"]`。因此 `tesseract` 缺失**不会**让节点失效。
  > ✅ **这几处声明以前都写错过，现已改正**：`requiresEngines` 曾经是 `["python"]` —— 而 Tesseract 那条路**根本不碰 Python**（它只是 `ctx.engine("tesseract")` 起个 OCR 子进程），于是"只装了 Tesseract"的机器（恰恰是它最该能用的场景）反而被 UI 标灰；`optionalEngines` 里当时也没有 `ai-provider`，尽管 `tesseract` 缺失时它靠的正是配好的 AI 服务；后来又漏了 `poppler`（PDF 栅格化）。三处现在都对上了，由 6.2 的双向测试守着。
  > ✅ **这个节点现在真的有执行器了**（`nodes.rs::doc_ocr`），它的真实策略是**两条识别路径 + 一个前置步骤**，各自诚实：
  > - `engine` 参数为 `auto`（默认）或 `tesseract`：**装了 tesseract 就直接用它** —— 完全离线、不花钱、快，中文质量一般；
  > - 没装 tesseract（且 `engine` 为 `auto` 或 `ai`）：**改用多模态模型**，日志会明确写一句「本机没有 Tesseract，改用多模态模型识别（图片会上传给 AI 服务商）」。这条路要联网、按 token 计费，输出里 `backend` 是 `ai-vision`；
  > - 两条都不可用时报错会把**两个选项都列出来**（装 tesseract / 配 AI），而不是只说一句"OCR 引擎缺失"；
  > - **前置**：输入是 PDF 时先按页栅格化，需要 `poppler`（见 3.3.1）。
  > - ⚠️ **参数枚举与执行器已经逐字对齐**：节点目录里 `engine` 的枚举是 `auto` / `tesseract` / `ai`，与执行器读的分支一字不差。
  >   （历史：这里曾写着 `paddleocr` —— 执行器**没有**那条分支，用户选中它只会静默走到 `auto` 的行为；节点描述里「装了 PaddleOCR 时质量更高」也只是一句没有实现的文案，现已随枚举一起删掉并改写为"Tesseract 或多模态模型"。**参数名对了但取值对不上，比参数名写错更难发现**：界面照常显示、执行器照常运行，只有结果不符合预期。）
- **许可证与分发注意点**：`Apache-2.0`。语言数据包（tessdata）另有许可，`chi_sim` 为 Apache-2.0。`requiresLicenseAck: false`。仅探测系统安装，不提供应用内下载。

#### Poppler（`poppler`）—— PDF 栅格化

- **主页**：https://poppler.freedesktop.org/
- **提供的节点（1 个）**：`doc.ocr`（**只影响它能不能吃 PDF**，不影响 OCR 本身的可用性）。
- **缺失时会发生什么**：给 `doc.ocr` 喂 PDF 会被**明确拒绝**，detail 里写清"这是一份 PDF，要先按页栅格化"并给出两条出路（装 Poppler / 自己把页面存成图片）。**不会**把 PDF 直接丢给 tesseract —— 后者只会回一句用户看不懂的话；也**不会**只识别第一页然后"成功"。
  > 📌 **这一项以前是永久拒绝的**：ROADMAP §7 第 3 项写着"PDF 输入现在被明确拒绝（要按页转图片，需要 pdfium / poppler）。报错文案清楚，但功能确实没有"。现在补上了 —— 见下面那条实测。
- **实现**（`nodes.rs::rasterize_pdf`）：`pdftoppm -png -r <dpi> <pdf> <prefix>`，产物落在**本次任务的 workspace** 里（不是系统临时目录 —— 后者在授权范围之外，`libreoffice_to_pdf` 在这上面踩过）。逐页处理不是优化而是必需：一页 200 DPI 的 A4 约 1654×2339 像素、11 MB RGB 数据，100 页一次性读进内存是 GB 级。多页结果用 `===== 第 N 页 =====` 分隔后拼成一份文本 —— **没有分隔标记的话，两页的文字会首尾相接**，用户看不出边界在哪。
  > **实测**（真机，`verify-platform.mjs`【15】）：一份手写的 3 页 PDF（420×200 点）在 `pdfDpi: 100` 下渲染出 584×278 像素（预期 583×278±2），假 AI 端点收到 **3 次**请求（逐页而不是整篇），最终文本里 3 个页码分隔标记与 3 次请求的序号都在。**DPI 这个旋钮是有证据的，不是写着好看的。**
- **许可证与分发注意点**：`GPL-2.0-or-later`，强 copyleft。应用**只调用它的命令行工具**（`pdftoppm`）并原样转发用户的文件，不链接它的代码、不随应用分发。`requiresLicenseAck: true`。Windows 提供一键下载（oschwartz10612/poppler-windows 的版本固定 tag），macOS / Linux 走系统包管理器。
  > ⚠️ **解压层级不能改**：包的布局是 `poppler-26.09.0/Library/bin/*.exe|*.dll` + `Library/share/poppler/…`，而 pdftoppm 是按**自己所在目录的相对位置**去找 `../share/poppler` 的数据文件的。`stripComponents` 必须是 **1**（剥掉 `poppler-26.09.0/` 那一层），`binSubdir` 与 `MANAGED_LAYOUT` 都写 `Library/bin/pdftoppm`。剥 2 层会把数据目录挪走，表现是渲染时报"找不到数据目录"。

### 3.4 压缩包域

#### 7-Zip（`7zip`，核心引擎）

- **主页**：https://www.7-zip.org/
- **提供的节点（2 个）**：`archive.pack`、`archive.unpack`。
- **缺失时会发生什么**：两个节点**都不可用**，无降级路径（`requiresEngines: ["7zip"]`）。
- ✅ **三平台现在都能一键装（本轮把这条从未打通的路径打通了）**。历史注记在这里写的是「只支持系统安装（官方只提供安装器，或需要先有 7-Zip 才能解压的 `.7z`；原候选直链已 404），UI 应直接引导到官网」。**那句理由的第一半是错的，而且是可以被证伪的**：Windows 10 1803+ 自带的 `tar`（bsdtar）**能读 7z** —— 这一点在装 ImageMagick 时就被实测证明过（它的 Windows 便携包只有 `.7z`，`tar -xf` 退出码 0）。所以"先有鸡还是先有蛋"这个死结**不存在**；真正的原因只是那条 URL 指向的 `7z2408-extra.7z` 过期了（上游现在发 26.03）。**一个错误的理由会让正确的结论永远不被复查** —— 记在这里。
- **但换成 `-extra` 也不对**，这是第二个坑：`7z2603-extra.7z` 里是 **`7za.exe`（精简版）**，格式表里**没有 RAR**。而 `archive.unpack` 的输入端口明确收 `.rar`，用户会得到"按钮能点、装完却解不了 rar"。最终选择按平台分开：
  - **Windows**：`.msi` + **管理安装**（`archive: "msi"` → `msiexec /a <msi> /qn TARGETDIR=<dir>`）。这不是"安装"：不写注册表、不装服务、**不需要管理员权限**（本机实测退出码 0）。拿到的是**完整版** `Files/7-Zip/7z.exe` + `7z.dll`，`7z.exe i` 里 Rar1/2/3/5 都在，`7z a` 实测可用。顺带一提，这条路也顺手证明了"官方只发安装器"并不等于"拿不到可分发的东西"。
  - **Linux / macOS**：上游从 21.x 起就给这两个平台发**完整的**命令行版，直接是 `7z2603-linux-x64.tar.xz` / `7z2603-mac.tar.xz`，解压出来是 `7zz`（注意**不叫 `7z`**；`ENGINE_BINARIES` 里的 `7zz` 就是为它准备的）。这两个平台反而最简单。
  - **一句话的验证边界**：Windows 那条是**端到端实测**的；Linux/macOS 两条核对到的是「资产存在、哈希一致、清单里有 `7zz`、二进制里有 `Rar3`/`Rar5` 字样」，**没有在真实 Linux/macOS 上跑过**（本机没有那两个系统）。
- **许可证与分发注意点**：`LGPL-2.1+（含 unRAR 限制条款）`。unRAR 代码禁止用于开发 RAR 压缩器；**解压用途不受影响**。`requiresLicenseAck: false`——注意这是唯一一个 `core: true` 但不需要许可证确认的引擎。分发方式上有一条被反复复用的限制：**不随应用分发、由用户按需下载**，应用只是指向上游地址。

### 3.5 电子书域

#### Calibre（`calibre`）

- **主页**：https://calibre-ebook.com/
- **提供的节点（1 个）**：`ebook.convert`。
- **缺失时会发生什么**：`ebook.convert` 的 `requiresEngines` 为空，`optionalEngines` 为 `["calibre", "pandoc"]`，即 `calibre` 是首选、`pandoc` 是兜底。`calibre` 缺失后降级到 `pandoc`，但 `pandoc` **只覆盖 EPUB / DOCX / FB2 / HTML / Markdown / RTF / ODT / TXT**，**MOBI / AZW3 / LIT / PDF 输出将不可用**。两个引擎都缺失时，该节点在代码层面仍不会被判为不可用（因为没有必需引擎），但执行器会直接返回 `EngineMissing`（`engine_missing("calibre")`），detail 里把两个选项都写清楚 —— **不会静默产出空文件**。
  > ✅ **这条边界现在已经定义好了（`nodes.rs::ebook_convert`），而且有一处必须记下来的教训。** `calibre` 优先（格式最全），缺了就退到 `pandoc`；但**在调用 pandoc 之前**，执行器会先按两张能力表（`PANDOC_EBOOK_IN` / `PANDOC_EBOOK_OUT`）检查输入输出扩展名，不通过就直接拒绝并要求装 Calibre。
  > 理由是本项目遇到过的**最阴的一种失败模式**：pandoc 对认不出的输出扩展名**不报错** —— 它打一句 `[WARNING] Could not deduce format from file extension .mobi` + `Defaulting to html`，然后**退出码 0**，文件也真的生成了，只是那是一个 HTML 文件被命名成了 `.mobi`。要是把 `mobi` 直接交给它，用户会拿到一个"转换成功"的、扩展名骗人的坏文件。**它认不出输入格式时更糟：会把文件当纯文本读，产出垃圾。** 所以这里不能相信子进程的退出码，必须自己把关。
  > **实测**（真机）：epub → docx 产出的是真正的 `PK` magic ZIP；epub → md 中文文本完整保留；epub → mobi 且没有 Calibre 时被**干净地拒绝**，磁盘上不留任何东西。`verify-platform.mjs` 的【9】号检查盯着这条降级与拦停。
- **许可证与分发注意点**：`GPL-3.0`，强 copyleft。仅以独立进程调用；**如要随包分发请先做合规评审**。`requiresLicenseAck: true`。它也只有 `System` 一种安装方式 —— 官方只发安装器，`calibre-portable` 还得先有 Calibre 才能自解压（同 7-Zip 那个坑，见 3.4），所以 `download_platforms` 是空数组。

### 3.6 AI 域与跨域运行时

#### Python 运行时（`python`）

- **主页**：https://www.python.org/
- **提供的节点（2 个）**：`image.remove-background`、`ai.upscale`。
  > ⚠️ **这里此前多写了 `doc.ocr`，现已撤掉**：OCR 的 Tesseract 路径**不需要 Python**，把它算成"Python 提供的能力"会让只装了 Tesseract 的机器白跑一趟。修法与守卫见 6.2。
- **缺失时会发生什么**：这两个节点**不可用**，因为 `python` 在它们的 `requiresEngines` 里都是必需引擎，没有降级路径。这是影响面仅次于 FFmpeg 的单点依赖：图像抠图与 AI 超分都以它为前置。（`doc.ocr` 曾经也被算在这一列，但它的两条路都不经过 Python 引擎的推理链，见 3.3。）
- **许可证与分发注意点**：`PSF-2.0`，宽松许可；但要注意随包分发的第三方 wheel 各自的许可证。它**只有 `Download` 一种安装方式**，说明这是独立于系统 Python 的 3.11 运行时（与系统 Python 隔离）。`requiresLicenseAck: false`。
- **版本区间：3.9 ~ 3.13**。上界不是随便定的：`onnxruntime` 没有 Python 3.14 的 wheel，所以抠图节点在 3.14 上跑不起来，会返回明确的 `EngineMissing` 让用户去装应用托管的 3.11。**注意"探测为可用"与"满足某个节点的要求"是两件事** —— 系统里的 3.14 在引擎管理里显示可用，但用不了抠图；这也是 `EngineInstallRequest.force` 存在的原因（见 3.2 末段）。

#### ONNX 模型包（`onnx-models`）

- **主页**：https://onnxruntime.ai/
- **提供的节点（2 个）**：`image.remove-background`、`ai.upscale`。
- **缺失时会发生什么**：这两个节点不可用（与 `python` 一样是必需引擎）。它是**唯一带模型权重清单的引擎**（**8 个模型**，见第 4 节），也是唯一需要单独做许可证确认的模型入口。
- **每个权重都写明了自己服务于哪个节点**：`EngineModel.used_by`（`u2net*` / `isnet-general` / `birefnet-general` / `modnet-portrait` → `image.remove-background`；`realesr-general-x4v3` / `realesrgan-anime6b` / `realesrgan-x4plus` → `ai.upscale`）。这不是装饰：在这之前归属是从引擎推断的，而 `onnx-models` 同时承载抠图与超分，推断得出的结论是错的（见 1.3 末尾）。
- **它是「虚拟引擎」，探测规则与别的引擎不同**：`onnx-models` 没有可执行文件，它只是权重文件的宿主，「有没有 `onnx-models.exe`」这个问题本身就是错的。
  > ✅ **这条曾经是坏的**：`probe()` 只对 `install_modes == [Remote]` 的引擎做特判，`onnx-models` 落到普通分支，于是**永远探测为 `Missing`** —— 后果是 `image.remove-background` 在界面上**永远显示不可用，哪怕用户已经把权重下好了**。现在 `probe()` 对 `onnx-models` 单独判：**至少有一个权重已安装 = 可用**，message 里也会点名当前是"还没下权重"还是"已下载 N 个"。这条规则写在 `registry.rs::probe()` 里。
- **许可证与分发注意点**：许可证字段本身写的是「各模型不同（见下表）」，注意事项是「代码许可与权重许可是两回事。U2Net 为 Apache-2.0 可商用；MODNet 权重为学术许可；BiRefNet 权重受训练集条款限制。」体积标注约 180 MB（这只是 `approxSizeMb` 字段给出的引擎级估算；注意 **8 个**模型逐个加起来远超此值，且模型按需下载、不随安装包分发）。`requiresLicenseAck: true`。

#### AI 服务提供方（`ai-provider`）

- **主页**：https://platform.openai.com/docs/api-reference
- **提供的节点（2 个）**：`ai.describe`、`doc.ocr`。
  > ⚠️ **这里此前漏写了 `doc.ocr`，现已补上**：`doc_ocr` 在没装 tesseract 时会调 `require_ai(ctx, "doc.ocr")`，也就是说它同样依赖配好的 AI 服务商。两个方向现在都对上了（`doc.ocr` 的 `optionalEngines` 是 `["tesseract", "ai-provider"]`），并由**双向**守卫测试 `provides_matches_node_declarations` 守住（见 6.2）。
- **缺失时会发生什么**：`ai.describe` **不可用**，无降级路径（`requiresEngines: ["ai-provider"]`）；`doc.ocr` 则失去 AI 那条兜底（有 tesseract 时仍然可用）。由于它是 `Remote` 模式的引擎，不存在「安装包」意义上的缺失，缺失等价于「未配置可用的服务商 / API Key」。
- **许可证与分发注意点**：`依服务商条款`——许可证不取决于 ToolForge，而取决于用户接的是哪家服务。注意事项字段现在写的是「API Key 默认只存在内存里（重启要重填）。打开「记住 API Key」后会以**明文**另存到数据目录下的 `ai-key.txt` —— 系统钥匙串尚未接入。它不会随插件或日志外泄。」
  > ✅ **这句文案已经改对了**：它此前写的是「API Key 只存在本机加密存储中」，而仓库里**从来没有**加密存储、也没有 OS 钥匙串 —— 那是一句与实现不符的话。现在它如实描述了"默认只在内存、可选明文落盘"这个**能力降级**（细节见 `docs/SECURITY.md` 的凭据落盘一节）。`requiresLicenseAck: false`。

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

`onnx-models` 引擎下共 **8 个**模型权重（抠图 5 个 + 超分 3 个）。模型刻意与引擎本身分开：权重体积大、许可证各异，而且很多是「只有用了这个功能才需要」。

下面的 URL 与 SHA-256 全部**逐字取自 `engine_catalog()`**，没有推测补全。

| 模型 id | 名称 | 用途 | 体积 | 权重许可证 | 是否可商用 | 下载地址 | SHA-256 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `u2net` | U²-Net | 通用显著性目标检测 / 抠图，效果均衡 | 约 176 MB | `Apache-2.0` | 是 | `…/rembg/releases/download/v0.0.0/u2net.onnx` | `8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491`（175,997,641 字节） |
| `u2netp` | U²-Net (轻量) | U²-Net 的轻量版，速度快约 3 倍，边缘略糊 | 约 5 MB | `Apache-2.0` | 是 | `…/rembg/releases/download/v0.0.0/u2netp.onnx` | `309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8`（4,574,861 字节） |
| `isnet-general` | IS-Net General | 通用抠图，对复杂边缘处理更好 | 约 176 MB | `Apache-2.0` | 是 | `…/rembg/releases/download/v0.0.0/isnet-general-use.onnx` | `60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a`（178,648,008 字节） |
| `birefnet-general` | BiRefNet | 当前抠图 SOTA，发丝级边缘 | 约 900 MB | `MIT（代码）/ 权重另有条款` | **否** | **无下载源**（`url` / `sha256` / `file_name` 均为 `None`，UI 显示「无下载源」且下载按钮置灰） | 同上 |
| `modnet-portrait` | MODNet Portrait | 人像专用抠图（视频会议 / 证件照场景） | 约 25 MB | `Apache-2.0（代码）/ 学术用途权重` | **否** | **无下载源**（同上一行） | 同上 |
| `realesr-general-x4v3` | Real-ESRGAN general x4v3 | 通用 4 倍超分（轻量）。**输入尺寸动态**，不需要切块补边；**默认选它** | 约 5 MB（实测 4.87 MB） | `BSD-3-Clause` | 是 | `https://huggingface.co/Heliosoph/realesrgan-onnx/resolve/main/realesr-general-x4v3.onnx` | `09b757accd747d7e423c1d352b3e8f23e77cc5742d04bae958d4eb8082b76fa4` |
| `realesrgan-anime6b` | Real-ESRGAN anime 6B | 动漫 / 插画 4 倍超分（6 个残差块，完整版 23 个），输入尺寸同样动态 | 约 18 MB（实测 18.35 MB） | `BSD-3-Clause` | 是 | `https://huggingface.co/RekluzLabs/realesrgan_anime6b.onnx/resolve/main/realesrgan_anime6b.onnx` | `45bd54934aeabe8df744c8fdacb9e8846c9b55cb4e60c499db77405d1625a667` |
| `realesrgan-x4plus` | Real-ESRGAN x4plus | 完整版通用超分，质量最好的一档。**输入尺寸固定 256×256**，走"补齐 → 推理 → 裁回" | 约 67 MB（实测 66,993,533 字节） | `BSD-3-Clause` | 是 | ✅ **有下载源**（`279da294…`，真实下载后核对） | 同上 |
| `modnet-portrait` | MODNet Portrait | 人像专用抠图。**动态输入尺寸** + **[-1,1] 归一化**（与其它模型不同） | 约 25 MB（实测 25,888,640 字节） | `Apache-2.0`（代码）/ 学术用途权重 | **否**（需确认） | ✅ 官方 `huggingface.co/Xenova/modnet`（+ hf-mirror 兜底）；实测应用内 21 秒下完、哈希校验通过 | `07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9` |
| `birefnet-lite` | BiRefNet lite | BiRefNet 的轻量版（swin_v1_tiny）。**输入固定 1024×1024** | 约 214 MB（实测 224,005,088 字节） | `MIT` | 是 | ✅ 官方 `huggingface.co/onnx-community/BiRefNet_lite-ONNX`（+ hf-mirror 兜底）；实测应用内 69 秒下完、哈希校验通过。**两个来源逐字节相同**（rembg release 上那份同名资产也是同一份） | `5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333` |
| `birefnet-general` | BiRefNet（完整版） | 质量最好的一档，但 927 MB、CPU 单张十几秒 | 约 928 MB（实测 972,666,916 字节） | `MIT`（代码）/ 权重另有条款 | **否**（需确认） | ✅ 官方 `huggingface.co/onnx-community/BiRefNet-ONNX`（+ hf-mirror 兜底）。**推理已实测**（1024×1024 / imagenet / 前景占比 19.24%）。下载实测经过一次波折：第一次主源 **502 Bad Gateway**、兜底镜像卡死（两条都失败），**重试一次后从官方源下完（约 570 秒）**、哈希校验通过 | `58f621f00f5d756097615970a88a791584600dcf7c45b18a0a6267535a1ebd3c` |

> ✅ **`realesrgan-x4plus` 现在有下载源了（这一条保留历史，因为它的动机与另外两个完全不同）**：`birefnet-general` / `modnet-portrait` 缺的是"还没核对过的哈希"，而这一个当初缺的是**能用的 ONNX 导出** —— 找到的每一份 x4plus 导出都是**固定输入尺寸**，要先补上「补齐到固定尺寸 → 推理 → 裁回去」。三件事现在都做完了：
> 1. **补边逻辑**：`py/upscale.py` 读会话的输入形状，固定尺寸时用 `np.pad(mode="edge")`（边缘像素，比补黑边干净）补到 256×256，推理后裁回；
> 2. **接缝检查**：脚本新增 `seamRatioX/Y`。**这一段值得单独记下来，因为第一版是错的**：拿"边界跳变 ÷ **全图**中位数跳变"当指标，在真实图上报 3.53（看着像有接缝，其实是测试图里那个椭圆硬边造成的），而且故意错位之后纹丝不动（3.5331 → 3.5416）。第二版改成"边界 ÷ **紧邻几行/列**"，并修了一个 `np.diff` 的 off-by-one（`per_line[s]` 查的是块**内部**，真正的边界在 `s-1`）。现在：正常 3.7/2.4、故意错位 10.6/15.1；
> 3. **哈希**：`279da2949cfc4f4f87ca90df784e443e304ed82b8cbc27b40b995c745cbd3d5c`，来自 AXERA-TECH/Real-ESRGAN 的 `realesrgan-x4-256.onnx`。**用 onnxruntime 读过形状确认是 `[1,3,256,256] → [1,3,1024,1024]`** 才写进来的 —— "文件名里带个 256"不算证据。
>
> 真机实测（`verify-platform.mjs`【11】）：700×500 → 2800×2000、9 块、日志写明「权重输入尺寸固定，已按边缘像素补齐再裁回」、无未覆盖像素。**两条反证**守着那个指标：故意错位后指标明显变差，**而且** `uncoveredRatio` 从 0 变成 8.5% —— 两个互不相干的信号同时变化，比一个信号自己说自己灵可信得多。
>
> 「下载地址」与「SHA-256」两列的说明见第 1.3 节。上面 5 条的哈希都是**真实下载后算出来的**（不是抄网页）；下载路径是 `<data_dir>/models/<model_id>/<file_name>`，`file_name` 与模型 id 可能不同名（`isnet-general` → `isnet-general-use.onnx`；`realesrgan-anime6b` 则刻意与远端资产名逐字一致，这样"URL 必须以文件名结尾"那条不变量才守得住）。**没有下载源的 3 条在代码里就是 `None`**，不得凭推测填写；单测 `verified_sources_are_pinned` 守着"三个字段全有或全无"与"URL 以文件名结尾"这两条纪律。
>
> **抠图节点的默认模型是 `u2netp`（4.4 MB），不是 `u2net`（168 MB）。** 这条是**改过**的：原来的默认是 `u2net`，等于"想试一下抠图，先下 168 MB"。既然这个功能的瓶颈就是"第一次能不能跑起来"，默认值就该给最轻的那个。`model` 参数的枚举只有 `u2netp` / `u2net` / `isnet-general` —— 三个有下载源的，其余两个抠图模型没有来源，**不出现在选项里**。
>
> **超分节点的默认模型是 `realesr-general-x4v3`（4.9 MB）**，`model` 参数的枚举是 `realesr-general-x4v3` / `realesrgan-anime6b` / `realesrgan-x4plus` —— 与 `engine_catalog()` 里 `ai.upscale` 名下的条目逐字对齐。**三个都在目录里、都有下载源、都验证过**（x4plus 走的是固定尺寸补边那条路）。

### 4.1 商业使用结论（必须落实到 UI）

依据 `EngineModel.commercialUse` 字段：

**可以商用（`commercialUse: true`，共 6 个）**

| 模型 id | 名称 | 权重许可证 |
| --- | --- | --- |
| `u2net` | U²-Net | `Apache-2.0` |
| `u2netp` | U²-Net (轻量) | `Apache-2.0` |
| `isnet-general` | IS-Net General | `Apache-2.0` |
| `realesr-general-x4v3` | Real-ESRGAN general x4v3 | `BSD-3-Clause` |
| `realesrgan-anime6b` | Real-ESRGAN anime 6B | `BSD-3-Clause` |
| `realesrgan-x4plus` | Real-ESRGAN x4plus | `BSD-3-Clause`（**可商用**） |

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

### 5.1 无必需引擎：始终可用或可降级的节点（18 个）

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
| `image.crop` | 裁剪 / 缩略图（可选：`libvips`、`imagemagick`） | `libvips`（可选，非必需） | `libvips` 缺失 → ImageMagick → 两者都缺失 → 纯 Rust `image` crate 打底（**✅ 实测走通**，节点输出含 `backend`；`libvips.provides` 已补上这个能力） | 同上：更慢、更吃内存 |
| `image.rotate` | 旋转 / 翻转（可选：`libvips`、`imagemagick`） | `libvips`（可选，非必需） | `libvips`（`rot d90` 或 `similarity --angle`）→ `imagemagick`（`-rotate`）→ 两者都缺失 → 纯 Rust `image` crate **只支持 90° 整数倍**，非直角直接报 `EngineMissing`（**✅ 实测走通**，节点输出含 `backend`） | 更慢、更吃内存；**只剩纯 Rust 时任意角度旋转能力丧失**（不是静默取整，而是明确报错要用户装引擎） |
| `image.enhance` | 图像增强（**无引擎依赖**） | — | 🚧 **没有降级链，只有纯 Rust 一条路**：该节点的实现既不问后端、也不调用 libvips | 与"降级"无关：无论装了什么引擎，`image.enhance` 都走内置卷积 |
| `image.strip-metadata` | 清除元数据（**无引擎依赖**） | — | 🚧 **同上一行：只有纯 Rust 实现**（重新编码即不保留 EXIF/IPTC/XMP），`pick_image_backend()` 没有被它调用，`optionalEngines` 也已清空 | 与"降级"无关：装不装引擎，行为都一样；对部分容器格式的元数据块清理可能不完整 |
| `ebook.convert` | 电子书格式转换（可选：`calibre`、`pandoc`） | `calibre`（可选，非必需） | `calibre` 缺失 → `pandoc`（**只覆盖 EPUB / DOCX / FB2 / HTML / Markdown / RTF / ODT / TXT，且认不出的输入输出格式会被执行器在调用前拦下**）；`pandoc` 也缺失 → 没有任何可用后端 | **MOBI / AZW3 / LIT / PDF 输出能力完全丧失**；只剩 pandoc 覆盖的那些格式。两个后端都缺失时，节点虽不被判为不可用，但执行器会返回明确的 `EngineMissing`（detail 里列出 Calibre 与 Pandoc 各自的覆盖范围与体积），**不会静默产出空文件**（见 3.5） |
| `doc.ocr` | 图片 / **扫描件 PDF** 转文字（**无必需引擎**：`tesseract`、`ai-provider`、`poppler` 全是可选） | 识别：`tesseract`（首选：离线、免费、快）或 `ai-provider`（多模态模型，要联网计费）；PDF 输入另需 `poppler` 栅格化 | 缺 `tesseract` → 改用多模态模型（日志里写明图片会上传给 AI 服务商）；缺 `poppler` → PDF 输入被明确拒绝并给出两条出路；识别引擎都没有 → 运行期报错，detail **把两个选项都列出来** | 与"降级"无关：节点在 UI 上**始终可用**（可用性只看必需引擎），真正的失败发生在运行期。输入端口声明 `image/*` 与 `.pdf`（**PDF 已经真的能做了**，见 3.3.1）。历史：`requiresEngines` 曾是 `["python"]`，于是"只装 Tesseract"的机器被无谓标灰 —— 那个方向已修（见 3.3） |
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
> **不走这条链的是 2 个节点**：`image.enhance` 与 `image.strip-metadata` —— 它们**仍然是纯 Rust 实现**，既不调用 `pick_image_backend()`，也不产生 `backend` 输出。这两个节点的 `optionalEngines` 与两个引擎的 `provides` 里都已经**不再声明**它们，所以界面不会再说"装了引擎能解锁它们"（见 6.2）。
>
> **`image.rotate` 的任意角度（非 90° 倍数）在新实现下的行为**：libvips 可用时走 `vips similarity --angle N`；ImageMagick 可用时走 `-rotate N`；**只有纯 Rust 可用时返回明确的 `EngineMissing`**，detail 让用户去「设置 → 引擎管理」装 libvips 或 ImageMagick。它**不会**静默把角度取整 —— 取整会让用户以为"转了 45°"，实际拿到一张没转的图。`verify-platform.mjs` 的【7】号检查盯着这一点。
>
> **libvips 档位带来的真实收益要说准**：装了 libvips 后 WebP / JPEG 会按请求的画质做**有损**编码，而纯 Rust 后端的 WebP **只能无损**。准确的说法是"**按质量换体积的能力**"（这对照片很重要）。**不要写成"有损一定更小"**：实测在一张 320×200 的**合成渐变**图上，无损 508 字节反而小于有损 1808 字节 —— 合成图本来就会被无损压得极小，所以 `verify-platform.mjs`【6】只断言"确实走了有损编码"，**刻意不断言体积**。要证明"照片会更小"，得拿真实照片测。

各节点的可选引擎清单并不相同（这本身是正常的：`image.convert` 一类有两个同类后端，`doc.ocr` 一类是两个互不相同的兜底）。但要分清一致性的边界：**`optionalEngines` 与引擎侧的 `provides` 现在已逐条对齐**（5 处漂移已修、有双向测试守着，见 6.2），而**"实际会调用哪个引擎"仍必须以 `nodes.rs` 的实现为准** —— 例如 `image.rotate` 的 `optionalEngines` 是 `["libvips", "imagemagick"]`，libvips 可用时它会优先用 libvips，ImageMagick 只是第二选择。

### 5.2 必需引擎非空：没有降级路径，缺失即不可用（14 个）

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
| `doc.to-pdf` | Office 文档转 PDF | `libreoffice`（必需） | **无降级路径** | 节点完全不可用。UI 显示「需要安装 LibreOffice (headless)」（约 420 MB / 1.5 GB 解压后）；**Windows 现在可一键安装**，macOS / Linux 需自行安装。**✅ 已有真机基线**（【19】，见 3.3） |
| `archive.pack` | 打包压缩 | `7zip`（必需） | **无降级路径** | 节点完全不可用。UI 显示「需要安装 7-Zip」；**三平台都提供一键下载**（Windows 走 `.msi` 管理安装，Linux/macOS 走上游 tar.xz），系统安装仍然可用 |
| `archive.unpack` | 解压 | `7zip`（必需） | **无降级路径** | 节点完全不可用。同上提示 |
| `ai.upscale` | 图像超分辨率放大 | `python` + `onnx-models`（**均为必需**） | **无降级路径** | 节点完全不可用。UI 显示「需要安装 Python 运行时」与「需要安装 ONNX 模型包」 |
| `ai.describe` | 图像描述 / 大模型调用 | `ai-provider`（必需） | **无降级路径** | 节点完全不可用。由于该引擎是 `Remote` 模式，UI 应引导用户配置服务商与 API Key，而不是「下载」 |

**不要为这一节编造降级方案。** 例如「`video.transcode` 缺失 FFmpeg 时改用纯 Rust 解码」这类说法在当前代码与依赖里没有任何依据：workspace 的依赖清单中没有纯 Rust 的音视频转码库，`toolforge-engines` 的模块注释也明确说明音视频/文档/压缩包没有纯 Rust 替代品。此类建议如需成立，必须先改代码、再改本文档（见 1.1 的维护约定）。

**实现现状：这一节里的 14 个节点现在全都有执行器，`UNIMPLEMENTED_NODES` 是空数组。** `crates/toolforge-engines/src/nodes.rs` 的 `run()` 分发函数覆盖 `builtin_nodes()` 登记的全部 **32** 个节点，不再有 `not_implemented` 的落点。本节涉及的节点中：

- `archive.pack` / `archive.unpack` 已实现且确实**硬依赖** `7zip`（实现里是 `ctx.engine("7zip").await?`，缺失即报错）；
- `video.*` / `audio.*` / `doc.convert` / `doc.to-pdf` 同样以必需引擎为准；
- **`image.remove-background` 已在真机上跑通整条链路**（模型 + 独立 venv + ONNX 推理，见 3.2）；
- **`ai.upscale` 也已实现**（Real-ESRGAN + 分块推理，见 5.1 之后的说明与第 4 节）；
- **`ai.describe` 本轮补上**：走视觉模型（`doc.ocr` 与 `ebook.convert` 也同轮补上了执行器，但它们没有必需引擎，因此列在 5.1）。

因此本节每一行现在都有**可观察的运行时表现**，不再是"只有规格、没有实现"。不过要分清范围：**有执行器 ≠ 每一档环境都测过** —— `verify-platform.mjs`【8】覆盖抠图、【9】覆盖电子书的降级与拦停、【10】覆盖图像描述的请求形状、【11】覆盖超分的放大倍数、【12】覆盖"藏掉 libvips 后真的切到 ImageMagick"、【13】覆盖"两个引擎都藏掉后纯 Rust 兜底档真的接得住"，而 macOS 与完整的环境矩阵仍然没有基线（ImageMagick 档位已补上基线、纯 Rust 兜底档由【13】补上，见 3.2 与 5.1）。

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
| LibreOffice（MPL-2.0）+ Calibre（GPL-3.0） | `libreoffice.licenseNote`：MPL 是文件级 copyleft，独立进程调用无传染风险；`calibre.licenseNote` | 不存在额外传染风险。**注意两者现在不再同类**：LibreOffice 在 Windows 上有下载源了，但**应用不随包分发它** —— 用户按需下载，应用只是指向 TDF 指定的镜像地址（`download_platforms`），所以"由用户安装"这个前提仍然成立。`calibre` 依旧是**只有系统安装模式**，UI 里要把「请自行安装」讲清楚，避免暗示应用自带 |
| `ai-provider`（依服务商条款）+ 用户数据出境 | `ai-provider.licenseNote`：API Key 只存在本机加密存储中，不会随插件或日志外泄（⚠️ 这句原文与实现不符，见 3.6） | 许可证取决于用户接的服务商，产品无法代为保证。实现上必须保证：API Key **不写入插件、不写入日志**（`AiProviderConfig::api_key` 带 `skip_serializing`，审计写入点也不含凭据）。**注意别再把"加密存储"当成事实**：当前既没有加密存储也没有钥匙串，默认只存在内存；用户可选的 `ai.persistApiKey` 是**明文**落盘，属于能力降级 |

**通用结论：** `requiresLicenseAck: true` 的 5 个引擎（`ffmpeg`、`pandoc`、`libreoffice`、`calibre`、`onnx-models`）覆盖了本文档第 5 章几乎所有高风险项。UI 在用户点击「下载 / 安装」之前必须先展示许可证与注意事项，这是 `EngineDescriptor` 中 `licenses`、`licenseNote`、`requiresLicenseAck` 三个字段共同的设计意图。

---

## 6. 已知不一致与待补齐项

本章记录核对过程中发现的问题。这些是**代码与代码之间、代码与本文档之间**的不一致，如实列出，不做补全推测。

### 6.1 `ai.upscale` 的模型枚举与 `onnx-models` 模型清单不一致 ✅ 已消除

- **原来的问题**：`ai.upscale` 的 `model` 枚举里有 4 个值（`realesrgan-x4plus`、`realesrgan-x2plus`、`swinir-l`、`hat-l`），而 `engine_catalog()` 的 `onnx-models.models` 里**一个对应的权重条目都没有**（当时只有 `realesrgan-x4plus` 一条超分条目）。也就是说：三个模型 id 能被用户选中，却没有体积、许可证、`commercialUse`，因而无从下载与校验。
- ✅ **现在两边对齐了，而且是双向的**：枚举是 `realesr-general-x4v3`（默认）+ `realesrgan-anime6b` + `realesrgan-x4plus`，这三个在 `engine_catalog()` 里都有**完整条目**（含真实下载后算出的 SHA-256）；反过来，目录里三个超分权重**全部**出现在枚举里 —— 没有"能下到却选不到"的，也没有"能选到却下不到"的。`pipeline.rs` 里对这个枚举留了一行注释说明这条纪律：「枚举必须与 `engine_catalog()` 里 `onnx-models` 的模型表一致」。
- **仍然存在的缺口（换了个方向）**：现有测试 `every_node_engine_reference_exists_in_catalog` 只校验节点引用的**引擎 id** 是否存在，**不校验参数枚举里的模型 id 是否有对应权重条目**，所以这条纪律目前靠代码注释与人工核对维持，没有测试拦住。`ai.upscale` 的执行器会在模型未被登记时返回 `NotFound` 并把可用的超分模型列出来，属于运行期兜底。

### 6.2 `provides` 与节点声明的一致性 ✅ 已修好，并且现在有测试守着

`provides`（引擎侧："装了它解锁哪些节点"）与节点的 `requiresEngines` /
`optionalEngines`（节点侧："我需要哪些引擎"）是**两份数据、说的是同一件事**。
两份数据必然漂移，实测漂移过 **5 处**：

| 位置 | 原来错在哪 |
|---|---|
| `libvips.provides` | 多写了 `image.enhance` / `image.strip-metadata`（**纯 Rust 实现，装了不会有任何变化**）→ 用户为用不上的功能去下 30 MB |
| `libvips.provides` | 漏了 `image.crop` / `image.rotate`（**它们真的会调 libvips**）→ 真正受益的功能反倒没被标出来 |
| `imagemagick.provides` | 多写了 `image.strip-metadata` |
| `python.provides` | 多写了 `doc.ocr`（它的 Tesseract 路径**不需要 Python**）→ 只装了 Tesseract 的机器被无谓标灰 |
| `ai-provider.provides` | 漏了 `doc.ocr`（它的 AI 兜底正需要 AI 服务） |

> ✅ **全部已修**：`libvips` / `imagemagick` 的 `provides` 现在都正好是
> `image.convert` / `image.resize` / `image.crop` / `image.rotate`；
> `python.provides` 是 `image.remove-background` / `ai.upscale`；
> `ai-provider.provides` 是 `ai.describe` / `doc.ocr`。

**守住它的是一条双向测试** `provides_matches_node_declarations`
（`crates/toolforge-core/src/engine.rs`）：

* 节点把 E 列进 requires/optional ⟹ E 的 `provides` 里必须有这个节点；
* E 的 `provides` 里有某个节点 ⟹ 那个节点的 requires/optional 里必须有 E。

两个方向都是"界面承诺"与"实际依赖"必须一致 —— 任一方向不成立，
用户看到的解锁关系就是假的。原有的 `every_provided_capability_maps_to_a_real_node`
只校验"`provides` 里的名字是不是真节点"，管不到这一类漂移，所以新测试是必需的。

> **这条测试做过反证**：把 `image.enhance` 加回 `libvips.provides` 后它立刻变红，
> 报「引擎 `libvips` 声称解锁节点 `image.enhance`，但那个节点的
> requiresEngines / optionalEngines 里都没有它」。
> （反证时踩了一个小坑值得一提：第一次改文件用 `\r\n` 拼接替换，而本仓库的
> `.gitattributes` 是 `* text=auto eol=lf`，文件里是 **LF** —— 替换静默没生效，
> 测试自然"通过"。差点据此得出"守卫有效"的结论。**反证本身也要验证它真的改到了文件。**）

### 6.3 `ebook.convert` 在「两个可选引擎都缺失」时的行为 ✅ 已定义

- `ebook.convert` 的 `requiresEngines` 为空、`optionalEngines` 为 `["calibre", "pandoc"]`。
- **原来的问题**：当 `calibre` 与 `pandoc` 都不在时，该节点在代码层面**不会**被标记为不可用，而当时也没有定义运行时行为。
- ✅ **现在已经定义好了**：执行器 `nodes.rs::ebook_convert` 在两个引擎都不可用时返回 `EngineMissing`（subject 是 `calibre`），detail 逐条列出两个选择与各自的覆盖范围、体积；**不会产出空文件**。同理，`pandoc` 在但格式超出它的能力表时，也会在**调用之前**被拒绝（见 3.5）。
- **仍然存在的边界**：这条降级只体现在**运行期**。节点可用性（`pipeline_nodes` 的 `availability`）依然只看 `requiresEngines`，所以"两个可选引擎都没装"的机器上，`ebook.convert` 在 UI 上仍显示为可用，直到运行才报错。第 5.1 节已如实写出这一点。

### 6.4 引擎最低版本要求未定义

- `EngineState` 中有 `Outdated`（「版本过旧」）状态，`EngineStatus` 中有 `version` 字段，但 `EngineDescriptor` 中**没有最低版本字段**，也没有任何地方定义「过旧」的判定标准。
- 处理方式：**待定**。本文档因此不给出任何版本号要求（见第 1.3 节）。
- ✅ **补一条已经修好的相关事实**：**版本号本身现在真的读得出来了**。此前 `toolforge-process` 的 `ExecOptions::quiet(true)` 会把子进程输出整段丢弃，于是 `probe_version` 什么都拿不到 —— 界面上**每个引擎的版本都显示「未知」**，引擎失败时 stderr 也是空的。`quiet` 现已改为「只保留尾部」，`probe_version` 有回归测试（`probe_version_returns_something`）钉住。注意区别：**"能读到版本号"已经成立，"低于多少算过旧"仍然没有定义**，所以 `EngineState::Outdated` 依旧不会被触发。

### 6.5 模型下载地址与 SHA-256：五个已核对，三个刻意留空

- ~~见第 1.3 节：`engine_catalog()` 中 6 个模型的 `url` 与 `sha256` 全部为 `None`。~~
  > ✅ **已修正**：**5 个**权重现在有**真实下载后自己算出来的** SHA-256 与固定直链 —— 三个 rembg 抠图权重（`u2net` / `u2netp` / `isnet-general`，`https://github.com/danielgatis/rembg/releases/download/v0.0.0/`，tag 字面就是 `v0.0.0`）与两个 Hugging Face 超分权重（`realesr-general-x4v3` / `realesrgan-anime6b`）。它们都有独立的 `file_name` 字段（资产名与模型 id 可能不一致，如 `isnet-general` → `isnet-general-use.onnx`）。文件落在 `<data_dir>/models/<model_id>/<file_name>`。三条 IPC 也已补齐：`models_list` / `models_install` / `models_remove`。
  > **哈希不匹配即删文件**：`registry.rs::install_model` 用 `remove_file` + `IntegrityCheckFailed`，不保留没校验过的产物。
  > **模型权重现在全部有下载源，而且全部走通了「应用内下载 → 哈希校验 → 真跑一次推理」**（见上表与 `verify-platform.mjs`【8】）。单测 `verified_sources_are_pinned` 强制 url / sha256 / file_name 三者全有或全无、哈希为 64 位小写十六进制、URL 以 `file_name` 结尾。
  >
  > **每个 HF 上的权重都配了「官方优先、镜像兜底」两个地址**（`EngineModel::fallback_url`）：
  > `huggingface.co` 在**部分网络下整体不可达**（本机实测：没开加速时 DNS/TCP 都不通，开了才 200），
  > 而社区镜像 `hf-mirror.com` 在同一网络下能用、但**会抖**。只填官方 → 那部分用户一个模型都下不了；
  > 只填镜像 → 所有用户都依赖第三方。两个都填、按顺序试，才对两边都成立。
  >
  > 备用地址必须与主地址指向**同一个资产**，有一条测试（`fallback_urls_point_at_the_same_asset`）
  > 按"去掉主机名后路径逐字相同"来守 —— 兜底填成另一个版本时，表现会是"下载成功但哈希不符、
  > 文件被删"，而真正的原因（地址填错了）在报错里完全看不到。
  >
  > **兜底真的被触发过一次**（实测记录，值得留着）：主源 HF 对那个 928 MB 的文件回了
  > **502 Bad Gateway**（HTTP/1.1 重试后仍然失败），于是自动切到镜像，镜像又卡在
  > "60 秒内没有收到任何数据"，最后报：
  >
  > ```text
  > 下载 birefnet-general 失败：主源与备用源都不通
  > 主源 huggingface.co：HTTP 502 Bad Gateway（HTTP/1.1 重试后仍然失败）
  > 备用源 hf-mirror.com：下载卡住了：60 秒内没有收到任何数据
  > ```
  >
  > 这条路径此前**只写在代码里、从没被执行过** —— 而它一被执行就证明了它是对的：
  > 两个源都说了名字、都说了各自为什么失败。**重试一次之后就成功了**（主源下完 928 MB），
  > 所以那次失败确实是瞬时的，而不是配置问题。
  > **注意**：上一段关于"模型权重仍全部为 `null`"的旧结论已经不成立。
- ~~另外 `engine-sources.json` 中 5 个引擎的候选 URL 虽然存在，但**每条 `sha256` 均为 `null`**，因此没有任何一个引擎具备可用的自动安装来源。~~
  > ✅ **已修正，并且条数又涨了两轮**：`engine-sources.json` 现在是 **14 条**，其中 **13 条**带真实核对哈希 + 版本固定直链（`ffmpeg`@windows·linux·macos、`libvips`@windows、`imagemagick`@windows、`pandoc`@windows·linux、`python`@windows·linux·macos、`poppler`@windows、`7zip`@windows·linux·macos）。**唯一**没有哈希的是 `ffmpeg@macos`。平台覆盖：Windows 7 条 / Linux 4 条 / macOS 3 条。详见 `docs/ROADMAP.md` §3 与 1.3。
  > ✅ **同时补上了一条"平台无关"的守卫**：`download_platforms_are_backed_by_real_sources`（`registry.rs`）对 `EngineDescriptor::download_platforms` 与 `engine-sources.json` 做**双向**核对，因此在 Windows 上跑测试也能查出 macOS/Linux 那几条的问题 —— 此前那条检查只在**当前平台**取样，macOS 的两条死源（`libvips` 的 404 地址、`pandoc` 的 `.pkg`）正是这么漏掉的。配套的 `archive_kinds_are_known_and_msi_stays_on_windows` 则拦住"`msi` 归档写到非 Windows 平台"这类必然失败的组合。
- 处理方式：**模型权重这一项已经关闭** —— 8 个权重全部有下载源，其中 6 个的哈希来自真实下载，且**每一个都走通了「应用内下载 → 哈希校验 → 真跑一次推理」**（`verify-platform.mjs`【8】逐个模型断言）。剩下的未核对项缩到 **1 条**：`ffmpeg@macos`（evermeet 的 `ffmpeg-9.0.2.zip` 取不到字节，哈希仍为 `null`，安装时返回 `HashRequired`，可由用户在对话框里显式勾选"允许安装没有校验值的来源"）。**macOS 的运行验证仍然没有** —— 那需要一台 Mac，不是网络问题。
  > ✅ **另一件事已经不再成立**：这条原来说「依赖模型的节点执行器仍未实现，所以 v0.1 仍用不上模型」—— **抠图与超分两个执行器都已实现并真机跑通**（`image_remove_background` / `ai_upscale`：下权重 → 独立 venv 装 `onnxruntime` → ONNX 推理 → 出结果），所以模型现在**真的被用上了**。本轮新填的两个超分权重（`realesr-general-x4v3` / `realesrgan-anime6b`）就是为 `ai.upscale` 服务的。

**下载链路上后来加的几件事（都是实测逼出来的）：**

1. **失败重试一次，第二次只用 HTTP/1.1**：`registry.rs` 对 **5xx / 429 / 连接错误**重试一次，第二次换成 `http1_only()` 的客户端。触发点是观察到**同一个 GitHub release URL 一次返回 502、稍后再请求就是 200**。
   > ⚠️ **诚实说明**：**重试本身依据充分**（那是个真实发生过的 5xx），但**"换成 HTTP/1.1"这一步的依据较弱** —— 那个 502 **没有复现过**，它很可能只是一次瞬时的服务端错误，与 HTTP 版本无关。之所以还是保留，是因为代价极低（只在第一次失败后才多花一次请求），而如果它真与 HTTP/2 的某些中间设备有关，那就是白捡的。**不要把它写成"确认是 HTTP/2 的问题"。**
2. **本地已有且哈希正确的文件直接跳过下载**：`models_install` 会先对已存在的本地文件算哈希，**匹配就直接返回**（`u2net` 是 168 MB，用户在界面上多点一次下载不该付一次完整下载的代价）；**不匹配则重新下载**并留一条 warn（本地文件坏掉这件事本身值得被看见）。为什么不是"文件存在就当已安装"：模型权重会被用户手工替换、被同步工具截断、被磁盘错误写坏，而**拿一个损坏的权重去跑推理得到的是乱码结果，不是错误** —— 那比下载失败难查得多。
3. **一条"URL 必须以落盘文件名结尾"的断言**：`engine.rs` 的 `verified_sources_are_pinned` 里新增。它是被一次**真机下载**逼出来的：`url` 曾经写成 release tag 本身（`…/download/v0.0.0`，**少拼了资产名**），看起来完全正常、单测也照样绿（因为没人会去"下载"），真跑的时候得到 `HTTP 404`，而错误信息只含糊地说"下载 u2netp 失败"。要求"URL 以 `file_name` 结尾"是最便宜的自洽检查：**只要有人再漏拼一次资产名，这条会立刻红**（GitHub 资产地址必须以具体文件名结尾，指向 release tag 会 404）。
4. **卡死检测：60 秒没有收到任何字节就报错，而不是干等 30 分钟**。`registry.rs` 的客户端总超时是 30 分钟，而"连接建立了但服务端一个字节都不吐"这种卡死会一直撑到那一刻 —— 用户看到的是一个 **0% 不动、也没有任何解释**的进度条，只能怀疑软件坏了。触发点是真机上的一件事：安装 FFmpeg 时进度条停在 **0%** 十几分钟没有动静，查下来是 `www.gyan.dev` 的连接会挂住。现在 `stream_to_file()` 用 `tokio::time::timeout(STALL_TIMEOUT, stream.next())` 包住每一次读取，**60 秒内没有任何数据到达**就判定卡死：删掉半截文件，报一条说得清的错误（**已收到多少 / URL / 常见原因 / 可以怎么做**）。60 秒是刻意的宽容值 —— 正常的慢速网络也会持续有小块到达，真正卡死是"完全静默"。
   > ✅ **这条曾经"加了但没人验过"，现在既验过、也可被验证（重点是后者）**。原来的 60 秒是**硬编在函数里**的，于是唯一的验证方式是**干等 60 秒** —— 那种检查永远不会有人跑，等于没有。现在 stall 超时是 `stream_to_file` 的**参数**（生产传 `STALL_TIMEOUT`，测试传 **300 ms**），于是有了单元测试 `stalled_download_fails_with_a_readable_error`：起一个**裸 TCP server**，收下请求、回一个声明了 `Content-Length` 的 `200` 头、然后**永远沉默**（正是真实事故的形状，且不引入任何依赖）。它断言四件事 —— 错误码是 `Network`、信息里说清「卡住」、**很快返回**（<10 s，证明不是靠 30 分钟总超时兜住的）、以及**半截文件被删掉**（留一个 0 字节的 `.zip` 在地上，用户只会以为"下过了"）。`toolforge-engines` 的测试数因此从 37 变成 38。
   > ✅ **上面那句"没有经过真机运行验证"已解除（保留作历史）**：当时的原因与 ImageMagick 那条相同（`toolforge.exe` 被无关进程持有句柄、cargo 写不回链接产物），所以只跑到了 `cargo check --workspace --all-targets`（0 error / 0 warning）与单元测试。句柄释放后那个二进制重建了、真机验证也跑了 —— 而且**卡死检测现在有单元测试守着**，不必再依赖"某次真机恰好卡住"来证明它还在工作。
5. **缺引擎的提示语不再承诺一个不存在的下载**：`install_hint(desc, has_source)` 现在会看**这个平台到底配没配来源**，有来源才说「可在「引擎管理」里一键下载安装」；声明了 `Download` 却没有来源时改说「当前平台没有配置下载源，请手动安装：<官网>」。原来的写法只看 `install_modes`，于是 `imagemagick`（声明了 `Download`、当时却没有来源）会把用户指向一个**点下去必然失败**的按钮 —— 提示语的唯一职责是别把人指错方向。
   > 两条不变量测试守着它：`download_mode_engines_have_a_source_for_this_platform`（除远程/虚拟引擎外，凡声明 `Download` 的引擎在当前平台必须有来源 —— 这正是 `imagemagick` 违反过的）与 `install_hint_only_promises_a_download_when_a_source_exists`（没来源时必须给出手动安装的出路）。

### 6.6 `nodes.rs` 的模块文档表与实际实现不一致：`archive.*` 的「系统 tar」兜底并不存在

- `crates/toolforge-engines/src/nodes.rs` 的模块文档里有一张降级矩阵表，并在标题上声明「本文件是唯一的真相来源」。该表把 `archive.*` 一行写成：`7-Zip` → 次选「系统 tar」→ 兜底「无」。
- 但实现并非如此：`sevenzip_pack()` 与 `sevenzip_unpack()` 都直接写 `let sevenzip = ctx.engine("7zip").await?;`——`7zip` 缺失时立即返回错误，执行失败时 `r.into_error("7zip")`。代码中**没有**任何改用系统 `tar` 的分支（`tar` 只作为 `sevenzip_args_for_format()` 的一个**输出格式**出现，即 `-ttar`，不是兜底程序）。
- 影响：那张模块文档表会让读者以为 `archive.*` 在 7zip 缺失时仍能工作。本文档第 5.2 节依据 `builtin_nodes()` 的 `requiresEngines: ["7zip"]` 与上述实现，结论是「**无降级路径**」——与实现一致，与那张文档表不一致。
- 处理方式：**待对齐**。要么真的实现系统 `tar` 兜底（注意 `tar` 只能覆盖 tar 系列与部分 zip，**无法处理 7z / rar**，因此仍需保留 `requiresEngines` 的语义或在 UI 上区分），要么改掉 `nodes.rs` 的模块文档表。
- 附带问题：`nodes.rs` 的表还声称自己是降级矩阵的「唯一真相来源」，而本文档声明的依据是 `pipeline.rs` 的 `requiresEngines` / `optionalEngines`。建议统一口径为「`builtin_nodes()` 的字段是权威数据，`nodes.rs` 的表只是实现的简化摘要」，否则两份表会持续漂移：`doc.ocr` 的 `tesseract` 是可选引擎、`ebook.convert` 的 `calibre` → `pandoc` 顺序、`image.enhance` 与 `image.strip-metadata` 其实完全不走降级链（见 5.1、6.2），这些都没有体现在 `nodes.rs` 的表里。

### 6.7 `nodes.rs` 里已经**没有**未实现的内置节点（`UNIMPLEMENTED_NODES` 是空数组）

- **结论（本轮）**：`nodes.rs` 的 `run()` 分发函数覆盖 `builtin_nodes()` 登记的全部 **32** 个节点，`toolforge_core::pipeline::UNIMPLEMENTED_NODES` 现在是**空的 `&[&str]`**。读者不应再从本文档里找"哪些节点还没做"—— 现在一个都没有。
- **`UNIMPLEMENTED_NODES` 为什么还留着**：因为它同时是前端"标灰未实现节点"的**数据来源**（通过 IPC 的 `NodeCatalogResponse.unimplemented`）。删掉这个常量会让前端那句"该能力尚未实现"的提示失去依据；留一个空数组，语义正好是"现在没有"。`pipeline.rs` 里那段注释也写了下一步怎么做：**谁下次加了节点却忘了实现执行器，就把节点名加进这个数组** —— `nodes::run` 的兜底分支、节点面板的灰显、以及下面那条测试会一起跟上，这是刻意设计的"一处声明、多处生效"。
- **历史（这条必须保留，因为它是这个项目最有价值的一课）**：这份名单曾经有过 6 个、5 个、4 个。逐个说清楚它们的去向：
  1. **`flow.foreach`** —— **不是被实现，而是被整个删除**。它的语义在平铺的步骤列表里无法定义（循环体含哪些步骤？循环后面的收尾步骤怎么办？），而描述里的「宿主会按并发度并行调度」是**假的**；批量改由宿主在命令层做（`expand_batches`：多文件与目录输入都扇出成单文件批次，`${batch.index}` 取序号）。`pipeline.rs` 在原名单位置留了一段注释记录原因，防止有人再把它加回来。引用它的清单现在**连 `validate()` 都过不去**（`STEP_UNKNOWN_NODE`）。
  2. **`image.remove-background`** —— 产品的招牌功能，却长期"登记了但执行器没写"。现在有了 `image_remove_background`，并已在真机上跑通整条链路。
     - **实测数据**（真机、非推断）：托管 Python 由应用装成 **3.11.16 / 145.2 MB / tar.gz 路径**；venv + pip 自动装上 `onnxruntime-1.30.0`、`numpy-2.4.6`、`pillow-12.3.0`；对一张 **400×300**（白底 + 一个红椭圆）的测试图，输出是 **RGBA PNG（colorType 6）、400×300、椭圆中心 alpha 254、角落 alpha 0、前景覆盖 18.87%** —— 与椭圆的真实面积吻合。**运行时就绪后单张推理约 0.7 秒**（含 pip 的首次运行为约 32 秒）。
     - **一张渐变图测不出显著性模型**：在没有明显主体的渐变图上，模型如实报告约 0% 覆盖并让节点发一条警告说明这一点。所以验收脚本必须用**有真实主体**的图 —— 拿渐变图测显著性模型，测出来的是"模型坏了"这种假象。
     - 参数也已对齐实现：现在是 `model` / `mode`（`alpha` | `color`）/ `background` / `threshold` / `feather`。**旧的 `alphaMatting` 参数已被删除** —— 它从登记那天起就没有任何实现，是个**假参数**：用户在 UI 里勾上它，什么都不会发生。
  3. **`ebook.convert`** —— 本轮补上，Calibre 优先、Pandoc 兜底，并且**在调用 pandoc 之前**按能力表把关（pandoc 对认不出的输出扩展名会打印一句 warning、写一个 HTML 出来、**退出码仍为 0**，见 3.5）。
  4. **`ai.describe`** —— 本轮补上，走视觉模型；图片会先按 `maxSide`（默认 1024）缩小并转成 **JPEG q85** 再内联发送（视觉计费随像素增长，见 `docs/SECURITY.md`）。
  5. **`doc.ocr`** —— 本轮补上，tesseract 优先、否则用视觉模型；**PDF 输入现在也能做了**（装了 Poppler 就按页栅格化，见 3.3.1；没装则明确报错并给出两条出路）。
  6. **`ai.upscale`** —— 本轮补上，Real-ESRGAN + 分块推理（`py/upscale.py`，256 px 分块、16 px 重叠、只取中心贴回），并配了两个**动态输入尺寸**的权重。
- **防回归测试**：`unimplemented_list_matches_actual_dispatch` 会**遍历真实分发表**，对名单里的每个节点断言它**确实**还落在 `not_implemented` 上（反方向也查）。名字不同但守同一件事的还有一条 `unimplemented_list_matches_the_dispatch_table`。它们守的失误形态是"实现完了却忘了从名单里删掉"（或反方向）—— 那种错会让用户看到与真实行为相反的提示，而**这个项目已经因此踩过一次坑**。
- **`not_implemented()` 里曾经有一条 `debug_assert!`，已经删掉**：它的意图是抓"实现了却还挂在名单上"，但那件事已由上一条测试完整覆盖（跑真实分发、双向校验），而这个断言带来两个真问题：
  1. `run()` 的兜底分支对「**拼错的节点名**」与「已登记但未实现的节点」是**同一条出口** —— 断言让前者从"一句干净的报错"变成了 **debug 构建下的崩溃**；
  2. `UNIMPLEMENTED_NODES` 现在是空的，任何节点名都会撞上它。
  现在 `not_implemented()` 只负责构造一个错误，并且**会区分两种处境**：名字不在节点目录里 → 提示"多半是清单里写错了名字，或者这份清单是给更新版本写的"；名字在目录里 → 提示"执行器还没实现，实现进度见 `docs/ROADMAP.md`"。**"没实现"和"名字写错了"是两种完全不同的处境，不该混成一句话。**
- **仍然是刻意的设计**：`not_implemented()` 的注释明确写着「刻意**不返回假的成功**」，否则会出现「流水线显示跑通了但没产出文件」这种最难排查的问题。这句话在名单为空之后依然有效 —— 它现在的实际用武之地只剩"节点名拼错"这一种情况。

### 6.8 桌面端与前端均已补齐（本条整体已过期，保留为历史）

> **状态更新**：本条最初写作时 `apps/desktop/src-tauri/src/`、`crates/toolforge-ai` 与 `apps/desktop/src/` 都还不存在，随后被并行开发补齐。以下保留原判断并标注最新观察结果。
>
> ⚠️ **下面"没有运行过 `cargo test`、第 5 章未经过测试回归验证"这句已经过期**（保留作为历史）。当前有可复核的实测数据：`cargo test --workspace` **258 passed / 0 failed**、`scripts/devtools/verify-platform.mjs` **193 项检查全通过**（【1】–【20】，其中【8】抠图、【9】电子书、【10】AI 视觉、【11】超分、【12】中间档后端切换、【13】纯 Rust 兜底档、【17】音视频真实属性、【18】压缩包标准归档、【19】Office → PDF、【20】一句话生成插件闭环）、一次真实的 libvips 一键安装、一次真实的 ImageMagick 一键安装、一次真实的 FFmpeg / Poppler / **7-Zip** / **LibreOffice** 一键安装（见 3.2、3.3、3.4）、以及抠图/超分整条链路的真机验证（见 1.3、3.2、5.1）。不过要分清范围：**测试全绿 ≠ 第 5 章每一行都验证过** —— 图像域那 4 个节点的后端选择有【6】、【7】两条运行时检查，中间档有【12】，兜底档有【13】，抠图有【8】，音视频有【17】，压缩包有【18】，Office → PDF 有【19】，其余各行仍然没有专门的运行时检查（macOS 始终没有环境基线）。

- 根 `Cargo.toml` 的 `members = ["crates/*", "apps/desktop/src-tauri"]`：两个模式都有对应目录。`apps/desktop/src-tauri/src/` 已存在（`main.rs` / `lib.rs` / `commands.rs` / `ipc.rs` / `state.rs` / `settings_store.rs` / `bin/`）。
- ✅ **前端 `apps/desktop/src/` 现在存在**（React 18 + TS + Vite，含 `package.json`、生成的 `bindings.ts`），根 `package.json` 里指向 `@toolforge/desktop` 的脚本因此可以解析。本条原文说"仍不存在"是当时的快照。
- `crates/toolforge-ai` 也已存在（`lib.rs` / `provider.rs` / `review.rs`），不再是缺失依赖。
- 影响（**已过期，见上**）：本文档**没有运行过 `cargo build` / `cargo test`**，因此不对「当前能否构建」下结论；也正因为如此，第 5 章的降级矩阵与第 2、4 节的数据目前都**没有经过测试回归验证**。
- 处理方式：**已关闭**（前端工程已补齐）。已知的编译阻塞与实测结论见 `docs/ROADMAP.md` 的「当前阻塞项」与「基线再更新」。

---

## 7. 相关源文件索引

| 路径 | 与本文档的关系 |
| --- | --- |
| `crates/toolforge-core/src/engine.rs` | 第 2、4 节的权威来源：`engine_catalog()`、`EngineDescriptor`、`EngineModel`（含 `used_by` 与 `file_name`）、`EngineState`、`EngineSource`、`EngineInstallMode`；单测 `verified_sources_are_pinned` 守 URL/哈希/文件名的完整性与 `used_by` 纪律，`model_licenses_are_explicit` 守"至少有一个不可商用的模型" |
| `crates/toolforge-core/src/pipeline.rs` | 第 5 节的权威来源：`builtin_nodes()`（32 个节点）、`NodeDescriptor.requiresEngines` / `optionalEngines`、`UNIMPLEMENTED_NODES`（**空数组**，仍保留给前端做灰显数据源，见 6.7） |
| `crates/toolforge-core/src/ai.rs` | `VisionClient` / `VisionRequest` / `BoxFut` 抽象。`toolforge-engines` **不能**依赖 `toolforge-ai`（会构成 `cyclic package dependency`），所以"看图说话"这件事通过这个 trait 注入（`NodeCtx.vision`），见 3.6 与 `docs/ARCHITECTURE.md` 的决策 10 |
| `crates/toolforge-engines/src/lib.rs` | 引擎层的职责划分与图像域三层降级设计的说明；`MANAGED_LAYOUT`、`version_args()` |
| `crates/toolforge-engines/src/registry.rs` | 引擎探测 / 下载 / 校验的实现；`EngineSourceSpec`（含 `archive` 的六种取值，`msi` 走 `extract_msi`）、`ModelSpec`、`EngineRegistry`（含「`sha256` 为 `None` 时拒绝下载」的规则与 `has_download_source()`）；`probe()` 里对 `onnx-models` 这个**虚拟引擎**的特判也在这里（见 3.6）；`install_hint(desc, has_source)` 与下载的**卡死检测**（60 秒无数据即失败）同样在本文档的 6.5 节有说明；平台无关的守卫 `download_platforms_are_backed_by_real_sources` / `archive_kinds_are_known_and_msi_stays_on_windows` 也在本文件，见 2.1 |
| `crates/toolforge-engines/src/nodes.rs` | 节点执行实现：`run()` 分发**覆盖全部 32 个节点**（`not_implemented` 只剩"名字拼错"这一种落点，见 6.7）；`pick_image_backend()` / `ImageBackend` 是第 5.1 节那张三层图的**真实实现**（四个节点走它，两个不走）；`image_remove_background` 与 `ai_upscale` 是**第 3.2 节那条 ONNX 路径**（不经过三层链）；`ebook_convert` / `doc_ocr` / `ai_describe` 是本轮新增的三个执行器；模块文档自带一张降级表，但与实现存在出入，见第 6.6 节 |
| `crates/toolforge-engines/py/rembg.py` | 抠图推理脚本，用 `include_str!` 编进二进制、运行时释放到 `<data>/cache/onnx-runtime/`；见第 3.2 节 |
| `crates/toolforge-engines/py/upscale.py` | 超分推理脚本（256 px 分块、16 px 重叠、只取中心贴回），同样 `include_str!` 编进二进制；自带输入/输出形状自检，并返回 `modelScale` / `targetScale` / `uncoveredRatio` 报告；见第 3.2 节 |
| `crates/toolforge-process/src/exec.rs` | 子进程执行：`resolve_program()`（裸名字走 PATH、显式路径不回退）、`ExecOptions::quiet` 的"只留尾部"语义、`ExecResult` 的输出裁剪；见第 1.3 节 |
| `crates/toolforge-engines/engine-sources.json` | 下载来源清单：**14 条，其中 13 条**带真实核对哈希 + 版本固定直链（Windows 7 / Linux 4 / macOS 3），唯一没有哈希的是 `ffmpeg@macos`（安装时返回 `HashRequired`）。**没有占位条目**：`libvips@macos`（404 的编造地址）与 `pandoc@macos`（`.pkg` 装不上）两条已删除，解释挪进本文档 1.3 与 3.4。见第 1.3 与 6.5 节 |
| `crates/toolforge-process/` | 外部进程调用（执行、RPC、进程监管），是引擎被真正调用的下层 |
| `scripts/devtools/verify-platform.mjs` | 真机运行时验收脚本（`scripts/devtools/run.mjs` 的第 5 个），**当前 193 项检查**（【1】–【20】）。本文档引用得最多的是这几条：【6】验证"图片后端与引擎状态一致"、【7】验证任意角度旋转不静默取整、【8】验证抠图整条 ONNX 链路真的出透明背景（并逐个已装模型核对**推理脚本实际用的输入尺寸与归一化**）、【9】验证电子书转换的降级与拦停、【10】验证图像描述的请求形状、【11】验证超分真的按倍数放大、【12】藏掉 libvips 目录后验证后端真的切到 ImageMagick（`finally` 里还原）、【13】把两个引擎的托管目录都藏掉后验证纯 Rust 兜底档接得住（产出无损 VP8L + 如实提示「只有无损模式」，`finally` 里逐个还原）、【14】验证 `video-to-gif` 内置插件（`${output.<端口>}` 解析 + 路径逃逸那两处修复）、【15】验证扫描件 PDF 的逐页 OCR、【16】逐个核对 32 个节点的"可用"与真实引擎/权重状态一致、【17】用 ffprobe 读回真实媒体属性（时长/帧数/编解码器/采样率/容器）、【18】验证压缩包节点真的产出**标准归档**（见 3.4）、【19】验证 `doc.to-pdf` 真的产出内容正确的 PDF（用 Poppler 的 `pdftotext` 读回文字做跨引擎交叉验证，见 3.3）、【20】验证"一句话生成插件"闭环（见 `docs/ROADMAP.md` §3.3）。历史注记里写的"82 项（【1】–【13】）"是当时的值 |
| `scripts/devtools/mock-openai.mjs` | **假 OpenAI 兼容端点**，只服务于验收脚本：`verify-platform.mjs`【10】把应用的 AI 设置临时指向它（provider 选 `ollama` —— 本地提供方，因此不需要 API Key），跑一次 `ai.describe`，然后断言**我们自己可控的那部分**：恰好收到 1 次请求、请求里恰好 1 张图、以**内联 data URL** 发送（不是 multipart 也不是外链）、MIME 是 `image/jpeg`（说明本地确实重新编码过）、体积落在 1 KB ~ 200 KB 的合理区间（实测约 6.9 KB）、带系统提示词、用户提示词原样送达、`stream: false`，最后还验证描述真的流到了下游（净化 → 拼名 → 改名，产出 1 个文件且文件名里没有标点）。跑完会把**用户的 AI 设置恢复原状**。这个假端点**永远不会看到真实用户图片** —— 它是"不依赖 API Key 也能验证 AI 节点"的办法，见 `docs/SECURITY.md` |
| `docs/ROADMAP.md` | `nodes.rs` 的 `not_implemented()` 错误提示所指向的实现进度文档（本文档未引用其内容，也不与其重复记录进度） |
| `Cargo.toml`（根） | workspace 成员与依赖声明，见第 1.2 与 6.8 节 |

---

*本文档所有引擎、模型、节点数据均取自上述 Rust 源码；凡源码中不存在的数据（下载地址、SHA-256、版本号要求）一律标注为「待定」，未做任何推测性补全。*
