//! 能力引擎的描述与状态模型。
//!
//! ## 为什么要有"引擎"这一层抽象
//!
//! 需求里点名了 FFmpeg / libvips / Pandoc / 7-Zip / ONNX 等一堆外部程序。
//! 如果让功能代码直接 `Command::new("ffmpeg")`，会立刻遇到三个问题：
//!
//! 1. **用户机器上可能没装** —— 得有探测与降级；
//! 2. **装在哪、什么版本** —— 得有统一的安装管理（系统已有 / 应用托管）；
//! 3. **每个功能各写一套调用** —— 参数拼错、转义漏了、取消不生效。
//!
//! 所以引擎层统一回答三件事：**有没有 → 在哪 → 怎么调**。
//!
//! ## 安装模式
//!
//! * [`EngineInstallMode::System`] —— 只探测系统 PATH 与常见安装位置，不下载。
//! * [`EngineInstallMode::Download`] —— 应用托管的按需下载（带 SHA-256 校验）。
//! * [`EngineInstallMode::Pip`] —— 通过插件私有 venv 安装的 Python 包。
//!
//! 任何一个引擎缺失，**只能让依赖它的节点不可用**，绝不能让整个应用起不来。

use serde::{Deserialize, Serialize};
use specta::Type;

/// 引擎的安装/获取方式
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum EngineInstallMode {
    /// 仅探测系统已安装
    System,
    /// 由应用按需下载
    Download,
    /// 通过 pip 安装到插件私有 venv
    Pip,
    /// 由外部大模型服务提供（无本地二进制）
    Remote,
}

/// 引擎运行状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum EngineState {
    /// 未安装、也未探测到
    Missing,
    /// 检测到系统安装
    Detected,
    /// 由应用托管安装完成
    Installed,
    /// 正在安装/下载
    Installing,
    /// 安装或探测失败
    Failed,
    /// 版本低于最低要求
    Outdated,
    /// 该引擎在当前平台不受支持
    Unsupported,
}

impl EngineState {
    /// 是否可用（可以真正被调用）
    pub fn is_usable(self) -> bool {
        matches!(self, EngineState::Detected | EngineState::Installed)
    }

    pub fn describe(self) -> &'static str {
        match self {
            EngineState::Missing => "未安装",
            EngineState::Detected => "已检测到系统安装",
            EngineState::Installed => "已安装（应用管理）",
            EngineState::Installing => "安装中",
            EngineState::Failed => "安装失败",
            EngineState::Outdated => "版本过旧",
            EngineState::Unsupported => "当前平台不支持",
        }
    }
}

/// 引擎来源
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum EngineSource {
    None,
    /// 系统 PATH / 注册表里找到的
    System,
    /// 下载到应用数据目录的
    Managed,
    /// 随应用一起分发的 sidecar
    Sidecar,
    Remote,
}

/// 引擎的**静态**描述（内置目录，不随运行状态变化）。
///
/// `licenses` 字段是刻意保留的：FFmpeg（LGPL/GPL，编译选项决定）、
/// LibreOffice（MPL-2.0）、Calibre（GPL-3.0）分发时各有约束，
/// UI 需要在用户点"下载"之前就把这件事讲清楚。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EngineDescriptor {
    pub id: String,
    pub name: String,
    pub description: String,
    /// 官方主页
    pub homepage: String,
    /// 许可证标识
    pub license: String,
    /// 许可证注意事项（分发/商用时的坑）
    pub license_note: String,
    /// 大致体积（MB），用于在 UI 上提前告知用户要下多少
    pub approx_size_mb: u32,
    /// 是否是核心引擎 —— 缺失时应用能跑，但一部分内置节点不可用
    pub core: bool,
    /// 该引擎提供的能力标签，与 [`crate::pipeline::NodeDescriptor::requires_engines`] 对应
    pub provides: Vec<String>,
    /// 支持的平台（`windows` / `macos` / `linux`）
    pub platforms: Vec<String>,
    pub install_modes: Vec<EngineInstallMode>,
    /// **哪些平台支持"应用内一键下载"**。
    ///
    /// # 为什么不能只看 `install_modes`
    ///
    /// 那个字段是**引擎级**的，而"能不能一键装"是**平台级**的事实：
    ///
    /// | 引擎 | Windows | Linux | macOS |
    /// |---|---|---|---|
    /// | `libvips` | ✅ 有预编译包 | ❌ 只有源码包 | ❌ **只有源码包**（上游不发布 macOS 二进制） |
    /// | `pandoc` | ✅ zip | ✅ tar.gz | ❌ 只发 `.pkg`（要 root 安装，不是可分发的归档） |
    /// | `imagemagick` | ✅ 便携版 | ❌ 无条目 | ❌ 无条目 |
    ///
    /// 把三者都写成 `Download`，macOS 用户就会看到一个**点了必然失败**的按钮；
    /// 把 `Download` 从 `install_modes` 里删掉，又会砍掉 Windows 的能力。
    /// 所以"支持的平台"必须单独写出来。
    ///
    /// 它与 `engine-sources.json` 的关系是**意图 vs 数据**，由测试做双向核对
    /// （`download_platforms_are_backed_by_real_sources`）：
    /// 这里写了某个平台却没有来源条目 → 失败；有来源却没写进来 → 也失败。
    /// 这样"声明支持某平台下载"这件事在任何操作系统上跑测试都能被查出来，
    /// 而不再像以前那样**只在当前平台上查**（macOS 的两条死源就是这么漏掉的）。
    #[serde(default)]
    pub download_platforms: Vec<String>,
    /// 是否需要在下载前让用户确认许可证
    pub requires_license_ack: bool,
    /// 可选的模型权重（例如抠图的 U2Net），与主程序分开下载
    pub models: Vec<EngineModel>,
}

/// 模型权重。**刻意与引擎本身分开** —— 权重体积大、许可证各异，
/// 而且很多是"只有用了这个功能才需要"。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EngineModel {
    pub id: String,
    pub name: String,
    /// 模型用途说明
    pub purpose: String,
    pub approx_size_mb: u32,
    /// 权重许可证（可能与代码许可证不同！）
    pub license: String,
    /// 是否允许商用
    pub commercial_use: bool,
    /// 下载地址与校验值
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// **备用下载地址**：主地址连不上时按顺序再试一个。
    ///
    /// # 为什么需要它（不是"多填一个地址保险一点"）
    ///
    /// 这些权重的官方源是 `huggingface.co`，而它在**部分网络下不可达**
    /// （本机实测：没开加速时 DNS/TCP 都不通，开了才 200）。社区镜像
    /// `hf-mirror.com` 在同一网络下能用，但它是第三方、而且**会抖**。
    ///
    /// 只填官方 → 那部分用户完全下不了；只填镜像 → 所有用户都依赖第三方。
    /// 两个都填，按"官方优先、镜像兜底"的顺序试，才是对两边都成立的答案。
    ///
    /// ⚠️ **必须与主地址是同一个文件**：每次下载都会核对 `sha256`，
    /// 不一致会被删掉并报 `INTEGRITY_CHECK_FAILED`。有一条测试
    /// （`fallback_urls_point_at_the_same_asset`）强制它与主地址指向同一个资产名。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    /// 落盘文件名。
    ///
    /// 单独一个字段是必需的：GitHub 上的资产名（`isnet-general-use.onnx`）
    /// 经常和模型 id（`isnet-general`）**对不上**。靠 `format!("{id}.onnx")`
    /// 猜文件名的话，下载成功、校验通过、然后"已安装"永远为假。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    /// 该模型是否已下载（运行时填充）
    #[serde(default)]
    pub installed: bool,
    /// 这个**权重**具体服务于哪些节点。
    ///
    /// 为什么不能靠"它所属引擎被谁用"来推：`onnx-models` 这一个引擎同时承载
    /// 抠图和超分两组权重，于是在引擎粒度上算出来的结论是
    /// "u2netp 被 `image.remove-background` 和 `ai.upscale` 共用" ——
    /// 那是**假的**。它造成的实际后果不是"界面上多显示一行"，而是：
    /// 一个验证脚本按"谁服务于 ai.upscale"去挑模型，挑中了 u2netp，
    /// 于是拿一个**分割模型**去超分，输出了垃圾 —— 而尺寸断言照样通过，
    /// 整条检查"全绿"。权重与节点的对应只能在权重这一层写清楚，推不出来。
    #[serde(default)]
    pub used_by: Vec<String>,
}

/// 引擎的**运行时**状态。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub id: String,
    pub state: EngineState,
    pub source: EngineSource,
    /// 可执行文件路径（System/Managed 时存在）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// 探测到的版本字符串
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// 状态说明 / 失败原因 / 安装指引
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// 已占用磁盘（MB）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed_size_mb: Option<f64>,
    /// 已下载的模型
    #[serde(default)]
    pub installed_models: Vec<String>,
    /// 最近一次探测时间（ISO-8601）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probed_at: Option<String>,
}

impl EngineStatus {
    pub fn missing(id: &str) -> Self {
        Self {
            id: id.to_string(),
            state: EngineState::Missing,
            source: EngineSource::None,
            path: None,
            version: None,
            message: None,
            installed_size_mb: None,
            installed_models: vec![],
            probed_at: None,
        }
    }

    pub fn detected(id: &str, path: impl Into<String>, version: Option<String>) -> Self {
        Self {
            id: id.to_string(),
            state: EngineState::Detected,
            source: EngineSource::System,
            path: Some(path.into()),
            version,
            message: None,
            installed_size_mb: None,
            installed_models: vec![],
            probed_at: Some(crate::job::now_iso()),
        }
    }

    pub fn unsupported(id: &str, reason: impl Into<String>) -> Self {
        Self {
            id: id.to_string(),
            state: EngineState::Unsupported,
            source: EngineSource::None,
            path: None,
            version: None,
            message: Some(reason.into()),
            installed_size_mb: None,
            installed_models: vec![],
            probed_at: None,
        }
    }
}

/// `onnx-models` 的权重全部来自 rembg 的这一个 release。
///
/// 这个 tag 字面上就是 `v0.0.0`（**不是占位符**）：rembg 用一个固定 tag 挂模型资产，
/// 每个资产名在模型条目里逐条写全。抽成常量是为了避免手抄时把 `v0.0.0`
/// 打成 `v0.0.1` 这类低级错误 —— 那种错误的表现是"下载 404"，
/// 而没人会想到去核对一个 tag。
const REMBG_RELEASE: &str = "https://github.com/danielgatis/rembg/releases/download/v0.0.0";

/// 内置引擎目录。
///
/// 这是**唯一**描述"ToolForge 能借助哪些外部能力"的地方。
/// 新增引擎 = 在这里加一条 + 在 `toolforge-engines` 里加一个 provider 实现。
pub fn engine_catalog() -> Vec<EngineDescriptor> {
    let all_platforms = || vec!["windows".into(), "macos".into(), "linux".into()];

    vec![
        EngineDescriptor {
            id: "ffmpeg".into(),
            name: "FFmpeg".into(),
            description: "音视频转码、剪辑、抽帧、提取音轨的万能工具。".into(),
            homepage: "https://ffmpeg.org/".into(),
            license: "LGPL-2.1+ / GPL-2.0+（取决于编译选项）".into(),
            license_note: "官方构建常启用 GPL 组件。若你的产品闭源分发，请选用 LGPL 构建或自行编译。".into(),
            approx_size_mb: 105,
            core: true,
            provides: vec![
                "video.transcode".into(),
                "video.trim".into(),
                "video.thumbnail".into(),
                "video.extract-audio".into(),
                "video.compress".into(),
                "audio.convert".into(),
                "audio.normalize".into(),
            ],
            platforms: all_platforms(),
            install_modes: vec![EngineInstallMode::System, EngineInstallMode::Download],
            // 三平台都有来源：Windows/Linux 是 BtbN 的版本固定构建，macOS 是 evermeet 的
            // 版本直链（**没有哈希**，需要用户勾选"允许未校验来源"）
            download_platforms: vec!["windows".into(), "linux".into(), "macos".into()],
            requires_license_ack: true,
            models: vec![],
        },
        EngineDescriptor {
            id: "libvips".into(),
            name: "libvips".into(),
            description: "低内存、流式的大图处理库。批量处理上千张图时比逐个解码快数倍。".into(),
            homepage: "https://www.libvips.org/".into(),
            license: "LGPL-2.1".into(),
            license_note: "以动态库方式调用即可满足 LGPL 要求，无需开源你的代码。".into(),
            approx_size_mb: 30,
            core: false,
            // ⚠️ 这张表必须与"节点自己声明的 `optional_engines`"**完全一致**，
            // 有一条测试（`provides_matches_node_declarations`）在盯它。
            //
            // 它原来写着 `image.enhance` 与 `image.strip-metadata` —— 而那两个节点
            // **只有纯 Rust 实现**，装了 libvips 不会有任何变化；同时漏了
            // `image.crop` 与 `image.rotate`，而它们**真的**会调 libvips。
            // 这属于最坏的一类不一致：界面照着 `provides` 显示"装了它解锁这些"，
            // 于是用户为了两个用不上的功能去下一个 30 MB 的库，
            // 而真正受益的两个功能反倒没被标出来。
            provides: vec![
                "image.convert".into(),
                "image.resize".into(),
                "image.crop".into(),
                "image.rotate".into(),
            ],
            platforms: all_platforms(),
            install_modes: vec![EngineInstallMode::System, EngineInstallMode::Download],
            // **只有 Windows 有预编译包**：上游 `libvips/libvips` 的 release 里只有
            // 源码包（`vips-8.18.6.tar.xz`），macOS / Linux 都没有二进制。
            // Windows 走 `libvips/build-win64-mxe`。
            download_platforms: vec!["windows".into()],
            requires_license_ack: false,
            models: vec![],
        },
        EngineDescriptor {
            id: "imagemagick".into(),
            name: "ImageMagick".into(),
            description: "格式覆盖最全的图像处理工具集，作为 libvips 的兜底。".into(),
            homepage: "https://imagemagick.org/".into(),
            license: "ImageMagick License（Apache-2.0 风格）".into(),
            license_note: "本体宽松，但若链接了 GPL 组件（如部分 delegate）会传染，分发前需确认构建配置。".into(),
            approx_size_mb: 60,
            core: false,
            provides: vec![
                "image.convert".into(),
                "image.resize".into(),
                "image.crop".into(),
                "image.rotate".into(),
            ],
            platforms: all_platforms(),
            install_modes: vec![EngineInstallMode::System, EngineInstallMode::Download],
            download_platforms: vec!["windows".into()],
            requires_license_ack: false,
            models: vec![],
        },
        EngineDescriptor {
            id: "pandoc".into(),
            name: "Pandoc".into(),
            description: "文档格式转换的瑞士军刀：Markdown / HTML / DOCX / EPUB / LaTeX 互转。".into(),
            homepage: "https://pandoc.org/".into(),
            license: "GPL-2.0+".into(),
            license_note: "以独立进程调用不构成衍生作品，可随闭源应用分发；但不得静态链接进你的二进制。".into(),
            approx_size_mb: 40,
            core: true,
            provides: vec!["doc.convert".into(), "ebook.convert".into()],
            platforms: all_platforms(),
            install_modes: vec![EngineInstallMode::System, EngineInstallMode::Download],
            // Windows 是 zip、Linux 是 tar.gz，都带真实哈希；
            // **macOS 没有**：上游只发 `.pkg`（要 root 用 installer 装到 /usr/local，
            // 不是一个能解压出来用的归档），所以那条源整个删掉了。
            download_platforms: vec!["windows".into(), "linux".into()],
            requires_license_ack: true,
            models: vec![],
        },
        EngineDescriptor {
            id: "libreoffice".into(),
            name: "LibreOffice (headless)".into(),
            description: "Office 文档转 PDF 的事实标准。冷启动 2~5 秒，ToolForge 会复用常驻进程。".into(),
            homepage: "https://www.libreoffice.org/".into(),
            license: "MPL-2.0".into(),
            license_note: "MPL 是文件级 copyleft，独立进程调用无传染风险。".into(),
            approx_size_mb: 420,
            core: false,
            provides: vec!["doc.to-pdf".into()],
            platforms: all_platforms(),
            // **Windows 现在能一键装了（本轮新增）**：`.msi` + 管理安装。
            // 历史注记写着"上游只发 `.msi`/`.dmg`/`.deb` 安装器，没有解压即用的归档，
            // 所以没有可管理的下载源" —— 前半句是事实，结论**不对**：
            // `msiexec /a` 的**管理安装不是安装**（不写注册表、不装服务、不需要管理员），
            // 它就是把包内容铺到目录里，正好是我们要的"解包"。7-Zip 走同一条路。
            //
            // 还有两条实测出来的细节，写在 engine-sources.json 的 note 里：
            // ① 解压后**没有** `Program Files\LibreOffice\` 这一层，TARGETDIR 下直接是
            //    `program/`、`share/`……（1.5 GB），所以 MANAGED_LAYOUT 那条
            //    `program/soffice` 正好对上；② `soffice.exe` 与 `soffice.com` 是
            //    **两个不同的入口**：前者跑 `--version` 会挂住不返回，后者正常 ——
            //    Windows 上托管布局因此刻意指向 `soffice.com`（见 lib.rs 的平台覆盖表）。
            //
            // macOS / Linux 仍然没有来源：上游对这两个平台也只发安装器（.dmg/.deb），
            // 而且解开 `.dmg` 需要 macOS 的 `hdiutil`，那是另一个平台的事。
            install_modes: vec![EngineInstallMode::System, EngineInstallMode::Download],
            download_platforms: vec!["windows".into()],
            requires_license_ack: true,
            models: vec![],
        },
        EngineDescriptor {
            id: "7zip".into(),
            name: "7-Zip".into(),
            description: "压缩解压，覆盖 zip / 7z / rar / tar 等格式。".into(),
            homepage: "https://www.7-zip.org/".into(),
            license: "LGPL-2.1+（含 unRAR 限制条款）".into(),
            license_note: "unRAR 代码禁止用于开发 RAR 压缩器；解压用途不受影响。".into(),
            approx_size_mb: 5,
            core: true,
            provides: vec!["archive.pack".into(), "archive.unpack".into()],
            platforms: all_platforms(),
            // **三平台都能一键装**，但这条路是绕出来的（原来这里写着"只能系统安装"）：
            //
            // 那条旧注释给的理由是"官方只提供安装器或 `7z-extra.7z`，而后者需要先有
            // 7-Zip 才能解压 —— 先有鸡还是先有蛋"。**这个理由是错的**：Windows 自带的
            // bsdtar 读得懂 7z（ImageMagick 便携版就是 `.7z`，实测装成功过）。
            // 真正的原因是那条 URL（`7z2408-extra.7z`）**404**，而版本已经落后好几个大版本。
            // 一个错的理由 + 一个过期的地址 = 一个核心引擎长期只能手动装。
            //
            // 现在：Windows 走 `.msi` 的管理安装（`archive: "msi"`，拿到的是**完整版**，
            // 含 RAR —— `-extra` 里的 `7za.exe` 是精简版、没有 RAR，而 `archive.unpack`
            // 的输入端口明确收 `.rar`，所以不能用它）；Linux / macOS 走上游发的完整
            // `7z2603-linux-x64.tar.xz` / `7z2603-mac.tar.xz`（这两个平台上游一直有完整版，
            // 反而是最简单的一条）。细节与"哪些验证过、哪些没验证"写在
            // `engine-sources.json` 的 note 里。
            install_modes: vec![EngineInstallMode::System, EngineInstallMode::Download],
            download_platforms: vec!["windows".into(), "linux".into(), "macos".into()],
            requires_license_ack: false,
            models: vec![],
        },
        EngineDescriptor {
            id: "calibre".into(),
            name: "Calibre".into(),
            description: "电子书格式转换与元数据管理（EPUB / MOBI / AZW3）。".into(),
            homepage: "https://calibre-ebook.com/".into(),
            license: "GPL-3.0".into(),
            license_note: "GPL-3.0 为强 copyleft。仅以独立进程调用；如要随包分发请先做合规评审。".into(),
            approx_size_mb: 180,
            core: false,
            provides: vec!["ebook.convert".into()],
            platforms: all_platforms(),
            install_modes: vec![EngineInstallMode::System],
            // 官方安装器 + `calibre-portable` 需要先有 Calibre 才能自解压，同 7-Zip。
            download_platforms: vec![],
            requires_license_ack: true,
            models: vec![],
        },
        EngineDescriptor {
            id: "python".into(),
            name: "Python 运行时".into(),
            description: "L3 插件的执行环境（独立 3.11 运行时，与系统 Python 隔离）。".into(),
            homepage: "https://www.python.org/".into(),
            license: "PSF-2.0".into(),
            license_note: "宽松许可；注意随包分发的第三方 wheel 各自的许可证。".into(),
            approx_size_mb: 150,
            core: false,
            provides: vec![
                "image.remove-background".into(),
                "ai.upscale".into(),
            ],
            platforms: all_platforms(),
            install_modes: vec![EngineInstallMode::Download],
            // Python 的三平台都是 `install_only` 压缩包（解压即用、不写注册表），
            // 所以三平台都能一键装。
            download_platforms: vec!["windows".into(), "linux".into(), "macos".into()],
            requires_license_ack: false,
            models: vec![],
        },
        EngineDescriptor {
            id: "onnx-models".into(),
            name: "ONNX 模型包".into(),
            description: "抠图 / 超分 / 分割用的模型权重。**不随安装包分发，首次使用时下载**。".into(),
            homepage: "https://onnxruntime.ai/".into(),
            license: "各模型不同（见下表）".into(),
            license_note: "代码许可与权重许可是两回事。U2Net 为 Apache-2.0 可商用；MODNet 权重为学术许可；BiRefNet 权重受训练集条款限制。".into(),
            approx_size_mb: 180,
            core: false,
            provides: vec!["image.remove-background".into(), "ai.upscale".into()],
            platforms: all_platforms(),
            install_modes: vec![EngineInstallMode::Download],
            // 权重是**直接下文件**，与平台无关 —— 三平台都能下（虚拟引擎，
            // 不经过 `engine-sources.json`）。
            download_platforms: vec!["windows".into(), "linux".into(), "macos".into()],
            requires_license_ack: true,
            models: vec![
                EngineModel {
                    id: "u2netp".into(),
                    name: "U²-Net (轻量)".into(),
                    purpose: "U²-Net 的轻量版，速度快约 3 倍，边缘略糊。**推荐先装这个**：只有 4.4 MB。".into(),
                    approx_size_mb: 5,
                    license: "Apache-2.0".into(),
                    commercial_use: true,
                    // 哈希是**真实下载后算出来的**，不是抄来的。见下方 `verified_sources_are_pinned`。
                    url: Some(format!("{REMBG_RELEASE}/u2netp.onnx")),
                    fallback_url: None, // GitHub 源，不需要兜底
                    sha256: Some("309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8".into()),
                    file_name: Some("u2netp.onnx".into()),
                    installed: false,
                    used_by: vec!["image.remove-background".into()],
                },
                EngineModel {
                    id: "u2net".into(),
                    name: "U²-Net".into(),
                    purpose: "通用显著性目标检测 / 抠图，效果均衡。168 MB。".into(),
                    approx_size_mb: 176,
                    license: "Apache-2.0".into(),
                    commercial_use: true,
                    url: Some(format!("{REMBG_RELEASE}/u2net.onnx")),
                    fallback_url: None, // 同上
                    sha256: Some("8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491".into()),
                    file_name: Some("u2net.onnx".into()),
                    installed: false,
                    used_by: vec!["image.remove-background".into()],
                },
                EngineModel {
                    id: "isnet-general".into(),
                    name: "IS-Net General".into(),
                    purpose: "通用抠图，对杂乱背景与复杂边缘处理更好。170 MB。".into(),
                    approx_size_mb: 176,
                    license: "Apache-2.0".into(),
                    commercial_use: true,
                    // 注意资产名是 `isnet-general-use.onnx`，与模型 id 不同
                    url: Some(format!("{REMBG_RELEASE}/isnet-general-use.onnx")),
                    fallback_url: None, // 同上
                    sha256: Some("60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a".into()),
                    file_name: Some("isnet-general-use.onnx".into()),
                    installed: false,
                    used_by: vec!["image.remove-background".into()],
                },
                EngineModel {
                    id: "birefnet-general".into(),
                    name: "BiRefNet（完整版）".into(),
                    purpose: "完整版 BiRefNet，抠图质量最好的一档，但 **927 MB**、\
                              1024×1024 输入下 CPU 单张要十几秒。除非确实需要那一点点质量差距，\
                              否则优先用 `birefnet-lite`（213 MB）。".into(),
                    approx_size_mb: 928,
                    license: "MIT（代码）/ 权重另有条款".into(),
                    commercial_use: false,
                    // 之前这一条**没有下载源**，理由是"哈希必须来自真实下载"。
                    // 现在补上了（972,666,916 字节的哈希是自己下载后算的），
                    // 并且用同一套脚本真跑过一遍 —— 见 `verify-platform.mjs`【8】。
                    // **官方优先、镜像兜底**：`huggingface.co` 在部分网络下不可达
                    // （本机实测：没开加速时连不上，开了才 200），而社区镜像
                    // `hf-mirror.com` 在同一网络下能用。两个地址指向**同一个资产**，
                    // 所以 `sha256` 对两边都成立 —— 有测试盯着这一点。
                    url: Some("https://huggingface.co/onnx-community/BiRefNet-ONNX/resolve/main/onnx/model.onnx".into()),
                    fallback_url: Some("https://hf-mirror.com/onnx-community/BiRefNet-ONNX/resolve/main/onnx/model.onnx".into()),
                    sha256: Some("58f621f00f5d756097615970a88a791584600dcf7c45b18a0a6267535a1ebd3c".into()),
                    file_name: Some("model.onnx".into()),
                    installed: false,
                    used_by: vec!["image.remove-background".into()],
                },
                EngineModel {
                    id: "modnet-portrait".into(),
                    name: "MODNet Portrait".into(),
                    purpose: "人像专用抠图（视频会议 / 证件照场景）。25 MB，CPU 上很快；\
                              它是**动态输入尺寸**的模型，脚本会把图缩到 320×320 再推理，\
                      且**用的是 [-1,1] 归一化**（与 U²-Net 那一族的 ImageNet 统计量不同）。"
                        .into(),
                    approx_size_mb: 25,
                    license: "Apache-2.0（代码）/ 学术用途权重".into(),
                    commercial_use: false,
                    // 官方优先、镜像兜底（理由见 `birefnet-general` 那条）
                    url: Some("https://huggingface.co/Xenova/modnet/resolve/main/onnx/model.onnx".into()),
                    fallback_url: Some("https://hf-mirror.com/Xenova/modnet/resolve/main/onnx/model.onnx".into()),
                    sha256: Some("07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9".into()),
                    file_name: Some("model.onnx".into()),
                    installed: false,
                    used_by: vec!["image.remove-background".into()],
                },
                EngineModel {
                    id: "birefnet-lite".into(),
                    name: "BiRefNet lite".into(),
                    purpose: "BiRefNet 的轻量版（swin_v1_tiny）：发丝级边缘，213 MB，\
                              比完整版小 4 倍多，质量差距在小图上基本看不出来 —— \
                              **大多数机器应该选它**。输入固定 1024×1024（模型自己声明的）。"
                        .into(),
                    approx_size_mb: 214,
                    license: "MIT".into(),
                    commercial_use: true,
                    // 两个来源**逐字节相同**（224,005,088 字节 / sha256 `5600024376…`）：
                    // HF 上 `onnx-community/BiRefNet_lite-ONNX` 的 `model.onnx`
                    // 与 rembg 官方 release 的 `BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx`。
                    // 官方优先、镜像兜底（理由见 `birefnet-general` 那条）。
                    url: Some("https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model.onnx".into()),
                    fallback_url: Some("https://hf-mirror.com/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model.onnx".into()),
                    sha256: Some("5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333".into()),
                    file_name: Some("model.onnx".into()),
                    installed: false,
                    used_by: vec!["image.remove-background".into()],
                },
                EngineModel {
                    id: "realesr-general-x4v3".into(),
                    name: "Real-ESRGAN general x4v3".into(),
                    purpose: "通用 4 倍超分（轻量）。**输入尺寸动态**，不需要切块补边，4.9 MB、单块约 26 ms —— 默认选它。".into(),
                    approx_size_mb: 5,
                    license: "BSD-3-Clause".into(),
                    commercial_use: true,
                    url: Some("https://huggingface.co/Heliosoph/realesrgan-onnx/resolve/main/realesr-general-x4v3.onnx".into()),
                    fallback_url: Some("https://hf-mirror.com/Heliosoph/realesrgan-onnx/resolve/main/realesr-general-x4v3.onnx".into()),
                    sha256: Some("09b757accd747d7e423c1d352b3e8f23e77cc5742d04bae958d4eb8082b76fa4".into()),
                    file_name: Some("realesr-general-x4v3.onnx".into()),
                    installed: false,
                    used_by: vec!["ai.upscale".into()],
                },
                EngineModel {
                    id: "realesrgan-anime6b".into(),
                    name: "Real-ESRGAN anime 6B".into(),
                    purpose: "动漫 / 插画 4 倍超分。6 个残差块（完整版是 23 个），约 3 倍快、体积只有 1/4。输入尺寸同样动态。".into(),
                    approx_size_mb: 18,
                    license: "BSD-3-Clause".into(),
                    commercial_use: true,
                    url: Some("https://huggingface.co/RekluzLabs/realesrgan_anime6b.onnx/resolve/main/realesrgan_anime6b.onnx".into()),
                    fallback_url: Some("https://hf-mirror.com/RekluzLabs/realesrgan_anime6b.onnx/resolve/main/realesrgan_anime6b.onnx".into()),
                    sha256: Some("45bd54934aeabe8df744c8fdacb9e8846c9b55cb4e60c499db77405d1625a667".into()),
                    // 用**下划线**（`realesrgan_anime6b`），与远端资产名逐字一致。
                    // 落盘名刻意跟远端保持一致 —— 两边拼法一旦不同，
                    // "URL 必须以文件名结尾"这条不变量就没法守，而它正是用来
                    // 抓"少拼资产名"这类错误的。
                    file_name: Some("realesrgan_anime6b.onnx".into()),
                    installed: false,
                    used_by: vec!["ai.upscale".into()],
                },
                EngineModel {
                    id: "realesrgan-x4plus".into(),
                    name: "Real-ESRGAN x4plus".into(),
                    purpose: "完整版通用超分，质量最好的一档。**输入尺寸固定 256×256** —— \
                              需要把图切成 256 的块、补齐边缘块再裁回去，所以比动态尺寸的那两个慢一些（每块约 0.4 秒）。"
                        .into(),
                    approx_size_mb: 67,
                    license: "BSD-3-Clause".into(),
                    commercial_use: true,
                    // ⚠️ 这一条**曾经故意没有配下载源**，注释写着"要做 x4plus：补上补齐 + 裁切，
                    // 重新跑一遍接缝检查，再把哈希填进来"。三件事现在都做完了：
                    //
                    // * 补齐 + 裁切：`py/upscale.py` 早就实现了（读会话的输入形状，
                    //   固定尺寸时用 `np.pad(mode="edge")` 补到 256×256 再裁掉）；
                    // * 接缝检查：脚本新增 `seamRatioX/Y` 指标（块边界上的平均跳变
                    //   相对整幅图中位数跳变的倍数），验证脚本里还有一条 `--seamProbeShift`
                    //   的**反证** —— 故意错位之后指标必须明显变差，否则那个指标没有被验证过；
                    // * 哈希：真实下载后算出来的（见下）。
                    //
                    // 这个 ONNX 导出**确实是固定输入**（`[1,3,256,256]` → `[1,3,1024,1024]`），
                    // 不是"看着像"。选购型时用 onnxruntime 读过它的输入形状才敢写进来。
                    url: Some("https://huggingface.co/AXERA-TECH/Real-ESRGAN/resolve/main/onnx/realesrgan-x4-256.onnx".into()),
                    fallback_url: Some("https://hf-mirror.com/AXERA-TECH/Real-ESRGAN/resolve/main/onnx/realesrgan-x4-256.onnx".into()),
                    sha256: Some("279da2949cfc4f4f87ca90df784e443e304ed82b8cbc27b40b995c745cbd3d5c".into()),
                    file_name: Some("realesrgan-x4-256.onnx".into()),
                    installed: false,
                    used_by: vec!["ai.upscale".into()],
                },
            ],
        },
        EngineDescriptor {
            id: "tesseract".into(),
            name: "Tesseract OCR".into(),
            description: "离线 OCR。中文识别质量一般，但完全免费且无需联网。".into(),
            homepage: "https://github.com/tesseract-ocr/tesseract".into(),
            license: "Apache-2.0".into(),
            license_note: "语言数据包（tessdata）另有许可，chi_sim 为 Apache-2.0。".into(),
            approx_size_mb: 60,
            core: false,
            provides: vec!["doc.ocr".into()],
            platforms: all_platforms(),
            install_modes: vec![EngineInstallMode::System],
            // 官方 Windows 安装器同样不是归档；Linux 发行版 / brew 里装更省事。
            download_platforms: vec![],
            requires_license_ack: false,
            models: vec![],
        },
        EngineDescriptor {
            id: "poppler".into(),
            name: "Poppler（PDF 栅格化）".into(),
            description: "把 PDF 按页渲染成图片，是「扫描件 PDF 做 OCR」的前置步骤。单独装它不会让 OCR 更好，\
                          但没有它，`doc.ocr` 就只能吃图片、吃不了 PDF。".into(),
            homepage: "https://poppler.freedesktop.org/".into(),
            license: "GPL-2.0-or-later".into(),
            license_note: "**GPL**：本应用只调用它的命令行工具（`pdftoppm`）并原样转发用户的文件，\
                           不链接它的代码、不随应用分发。介意 GPL 的话不要装它 —— 装 Tesseract + 自己把\
                           PDF 页面存成图片，走的是同一条 OCR 路径。".into(),
            approx_size_mb: 42,
            // 它不是"核心"：没有它应用照常工作，只是 doc.ocr 吃不了 PDF
            core: false,
            provides: vec!["doc.ocr".into()],
            platforms: all_platforms(),
            // Windows 有一键下载；macOS / Linux 走系统包管理（brew install poppler / apt install poppler-utils）
            install_modes: vec![EngineInstallMode::Download, EngineInstallMode::System],
            download_platforms: vec!["windows".into()],
            requires_license_ack: true,
            models: vec![],
        },
        EngineDescriptor {
            id: "ai-provider".into(),
            name: "AI 服务提供方".into(),
            description: "OpenAI 兼容接口的大模型服务，用于插件生成、图像描述等。".into(),
            homepage: "https://platform.openai.com/docs/api-reference".into(),
            license: "依服务商条款".into(),
            license_note: "API Key 默认只存在内存里（重启要重填）。打开「记住 API Key」后会以**明文**另存到数据目录下的 ai-key.txt —— 系统钥匙串尚未接入。它不会随插件或日志外泄。".into(),
            approx_size_mb: 0,
            core: false,
            // `doc.ocr` 也要算进来：没装 Tesseract 时它会用多模态模型兜底，
            // 那条路径同样要用户配好 AI 服务。
            provides: vec!["ai.describe".into(), "doc.ocr".into()],
            platforms: all_platforms(),
            install_modes: vec![EngineInstallMode::Remote],
            // `Remote` 不是"下载"：没有任何归档要落盘，装的是用户自己填的 endpoint。
            download_platforms: vec![],
            requires_license_ack: false,
            models: vec![],
        },
    ]
}

/// 按 id 查引擎描述
pub fn find_engine(id: &str) -> Option<EngineDescriptor> {
    engine_catalog().into_iter().find(|e| e.id == id)
}

/// 按 id 查一个模型权重（跨所有引擎），拿得到它的许可证、标称体积与文件名。
pub fn find_model(model_id: &str) -> Option<EngineModel> {
    engine_catalog()
        .into_iter()
        .flat_map(|d| d.models)
        .find(|m| m.id == model_id)
}

/// 权重文件"**看起来是完整的**"吗。
///
/// # 为什么需要它（一次真实事故）
///
/// 判断"这个权重装好了吗"此前用的是 `Path::is_file()` —— 而**0 字节的文件同样为真**。
/// 本轮实测撞到了这条路径的代价：一次被中断的下载把 928 MB 的 `birefnet-general`
/// 截成了 0 字节，于是
///
/// * 界面上它显示「已就绪」（`models_list` 只看文件在不在）；
/// * `image.remove-background` 拿到这个空文件，交给 onnxruntime；
/// * 用户看到的错误是「抠图脚本执行失败」—— 真正的原因（protobuf 解析失败）
///   埋在 Python 的 stderr 里，跟"文件是空的"这件事隔了三层。
///
/// 判据刻意**宽松**：只挡"明显不对"，即 0 字节、或不足标称体积的 60%。
/// 不拿 `approx_size_mb` 做精确比对，因为那个值本身就写着"约"
/// （上游偶尔会换同名资产），**误判一个完好文件为损坏比漏判更糟**：
/// 前者会让用户反复重下 900 MB，后者只是让错误晚一步暴露。
///
/// 真正的一致性判据仍然是 SHA-256（`EngineRegistry::install_model` 会核对并重下）。
/// 这个函数只负责让"明显不完整"在**进入推理之前**就被拦住，并给出一句能照做的提示。
pub fn model_size_looks_complete(actual_bytes: u64, approx_size_mb: u32) -> bool {
    if actual_bytes == 0 {
        return false;
    }
    let approx = (approx_size_mb as u64).saturating_mul(1024 * 1024);
    if approx == 0 {
        // 没有标称体积可比（不该发生，但真发生了不能因此误判）
        return true;
    }
    actual_bytes >= approx * 6 / 10
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_consistent() {
        let cat = engine_catalog();
        assert!(cat.len() >= 10);
        let mut ids = std::collections::HashSet::new();
        for e in &cat {
            assert!(ids.insert(e.id.clone()), "引擎 id 重复：{}", e.id);
            assert!(!e.name.is_empty());
            assert!(!e.license.is_empty(), "{} 缺 license", e.id);
            assert!(!e.license_note.is_empty(), "{} 缺 licenseNote", e.id);
        }
    }

    #[test]
    fn every_provided_capability_maps_to_a_real_node() {
        // 引擎声明的能力标签必须都有对应内置节点，否则是文档与实现脱节
        let cat = engine_catalog();
        for e in &cat {
            for cap in &e.provides {
                assert!(
                    crate::pipeline::find_node(cap).is_some(),
                    "引擎 `{}` 声明提供 `{cap}`，但内置节点目录里没有这个节点",
                    e.id
                );
            }
        }
    }

    #[test]
    fn every_node_engine_reference_exists_in_catalog() {
        let cat = engine_catalog();
        let known: std::collections::HashSet<&str> = cat.iter().map(|e| e.id.as_str()).collect();
        for node in crate::pipeline::builtin_nodes() {
            for e in node
                .requires_engines
                .iter()
                .chain(node.optional_engines.iter())
            {
                assert!(
                    known.contains(e.as_str()),
                    "节点 `{}` 引用了目录里不存在的引擎 `{e}`",
                    node.name
                );
            }
        }
    }

    #[test]
    fn model_licenses_are_explicit() {
        let onnx = find_engine("onnx-models").unwrap();
        assert!(onnx.requires_license_ack, "模型包必须要求确认许可证");
        assert!(!onnx.models.is_empty());
        for m in &onnx.models {
            assert!(!m.license.is_empty(), "模型 {} 缺许可证信息", m.id);
            assert!(!m.purpose.is_empty());
        }
        // 至少要有一个明确不可商用的，提醒用户
        assert!(onnx.models.iter().any(|m| !m.commercial_use));
    }

    /// 有下载源的模型必须**三件套齐全且互相自洽**。
    ///
    /// 这条测试的由来：`url` / `sha256` / `file_name` 三个字段里的任何一个缺席，
    /// 表现都不是"报错"，而是**静默失效**：
    ///
    /// * 缺 `sha256` → `install_model` 报"没有配置 SHA-256，拒绝自动下载"；
    /// * 缺 `file_name` → 下载成功、校验通过，但 `installed_models_for` 找不到它，
    ///   界面上永远显示"未安装"，用户会重复下载 170 MB；
    /// * `sha256` 不是 64 位十六进制 → 校验必然失败，且错误信息会让人以为下载坏了。
    ///
    /// 这些哈希都是**真实下载后算出来的**，不是从网页上抄的。改动它们之前请先
    /// 重新下载核对 —— 校验失败会直接删除文件，用户端表现为"下载完就没了"。
    #[test]
    fn verified_sources_are_pinned() {
        let onnx = find_engine("onnx-models").unwrap();

        for m in &onnx.models {
            match (&m.url, &m.sha256) {
                (Some(url), Some(hash)) => {
                    // 权重来自两个托管方：rembg 的 GitHub release（抠图）与
                    // Hugging Face（超分）。所以不能只认某一个域名 ——
                    // 但"必须 https"和"必须指向具体文件"是通用的底线。
                    assert!(
                        url.starts_with("https://"),
                        "模型 {} 的地址不是 https：{url}",
                        m.id
                    );
                    assert!(
                        !url.contains("raw.githubusercontent.com"),
                        "模型 {} 用了在这台机器上**被屏蔽**的域名（raw.githubusercontent.com）：{url}",
                        m.id
                    );
                    assert_eq!(hash.len(), 64, "模型 {} 的哈希长度不对", m.id);
                    assert!(
                        hash.chars().all(|c| c.is_ascii_hexdigit()),
                        "模型 {} 的哈希不是十六进制：{hash}",
                        m.id
                    );
                    assert_eq!(
                        hash,
                        &hash.to_ascii_lowercase(),
                        "模型 {} 的哈希要小写",
                        m.id
                    );
                    assert!(
                        m.file_name.is_some(),
                        "模型 {} 有下载源却没有 file_name —— 装完了也不会被认出来",
                        m.id
                    );

                    // ★ 这条断言是被一个**真机下载**逼出来的：
                    //
                    // `url` 曾经写成 `REMBG_RELEASE.to_string()`（也就是
                    // `.../download/v0.0.0`）—— 少拼了资产文件名。它看起来完全正常
                    // （是个像样的 GitHub 地址），单测也照样绿，因为没人会去"下载"。
                    // 真跑的时候得到的是 `HTTP 404`，而错误信息只说"下载 u2netp 失败"。
                    //
                    // 要求"URL 必须以落盘文件名结尾"是最便宜的自洽检查：
                    // 只要有人再漏拼一次资产名，这条会立刻红。
                    let file_name = m.file_name.as_deref().unwrap_or_default();
                    assert!(
                        url.ends_with(file_name),
                        "模型 {} 的下载地址没有以文件名 `{file_name}` 结尾：\n  {url}\n\
                         多半是漏拼了资产名（GitHub 资产地址必须以具体文件名结尾，\
                         指向 release tag 本身会 404）。",
                        m.id
                    );
                }
                // "没有下载源"是合法状态（还没核对过哈希），但必须**两个都没有**，
                // 不能出现"有 url 没 hash"这种半成品。
                (None, None) => {
                    assert!(
                        m.file_name.is_none(),
                        "模型 {} 没有下载源却写了 file_name",
                        m.id
                    );
                }
                _ => panic!(
                    "模型 {} 的 url / sha256 只配了一个 —— 要么都填，要么都留空",
                    m.id
                ),
            }
        }

        // 至少要有两个可以直接下载的：一个是轻量版（默认推荐），一个是完整版。
        let ready = onnx
            .models
            .iter()
            .filter(|m| m.url.is_some() && m.sha256.is_some())
            .count();
        assert!(ready >= 2, "可下载的抠图模型太少（{ready} 个）");

        // 每个权重都必须**自己声明**服务于哪些节点。
        //
        // 这条不是为了好看：`models_list` 直接把它发给界面，而验证脚本也靠它
        // 挑模型。以前这里的归属是"从所属引擎推"——那个推断对 `onnx-models`
        // （同时承载抠图与超分）是错的，于是抠图权重声称自己也服务于 `ai.upscale`，
        // 脚本据此拿分割模型去超分，**尺寸断言照样通过**，整条检查全绿而结果是垃圾。
        for m in &onnx.models {
            assert!(
                !m.used_by.is_empty(),
                "权重 {} 没有声明 `used_by` —— 归属推不出来，必须逐个写明",
                m.id
            );
            for node in &m.used_by {
                assert!(
                    crate::pipeline::builtin_nodes()
                        .iter()
                        .any(|n| &n.name == node),
                    "权重 {} 声称服务于不存在的节点 `{node}`",
                    m.id
                );
            }
        }

        // 落盘位置是 `<models>/<模型 id>/<file_name>` —— **每个模型一个目录**，
        // 所以不同模型用同一个 `file_name` 并不会互相覆盖。
        //
        // 历史：这条断言原来是"`file_name` 全局唯一"，那时落盘用的是
        // `model_dir(engine_id) + file_name`（同一个引擎的多个模型挤在一个目录里）——
        // 那个推导本身就是个 bug（见 `registry.rs::model_path` 的注释），改成按模型 id
        // 分目录之后，这条断言的前提就不成立了。留着它会把 **HuggingFace 上叫
        // `model.onnx` 的模型**（BiRefNet / MODNet 的导出一律叫这个名）统统挡在门外，
        // 而那个名字是我们无法选择的：URL 必须以 `file_name` 结尾这条不变量
        // （它抓到过"少拼资产名"的真实错误）把两者绑死了。
        //
        // 现在检查的是"同一个模型 id 不会被登记两次"——弱，但真实。
        let mut keys: Vec<(&str, &str)> = onnx
            .models
            .iter()
            .filter_map(|m| m.file_name.as_deref().map(|f| (m.id.as_str(), f)))
            .collect();
        keys.sort_unstable();
        let before = keys.len();
        keys.dedup();
        assert_eq!(before, keys.len(), "同一个模型 id 出现了两次：{keys:?}");

        // 备用地址必须与主地址指向**同一个资产**。
        //
        // 判据是"去掉主机名之后剩下的路径逐字相同"：`huggingface.co` 与
        // `hf-mirror.com` 的路径规则完全一致，所以同一份权重的两个地址只在
        // 主机名上不同。这条守的是**真实会发生的灾难**：兜底地址填成了另一个
        // 版本/另一个模型的导出 → 主地址失败时切过去 → 下载成功但哈希不符 →
        // 文件被删、用户看到 `INTEGRITY_CHECK_FAILED`，而真正的原因（地址填错了）
        // 在报错里完全看不到。
        for m in &onnx.models {
            let (Some(url), Some(fb)) = (m.url.as_deref(), m.fallback_url.as_deref()) else {
                continue;
            };
            let path_of = |u: &str| {
                u.split_once("://")
                    .and_then(|(_, rest)| rest.split_once('/').map(|(_, p)| p.to_string()))
                    .unwrap_or_default()
            };
            assert_eq!(
                path_of(url),
                path_of(fb),
                "模型 {} 的备用地址与主地址不是同一个资产：\n  主：{url}\n  备：{fb}",
                m.id
            );
            assert!(
                fb.ends_with(m.file_name.as_deref().unwrap_or_default()),
                "模型 {} 的备用地址没有以 file_name 结尾：{fb}",
                m.id
            );
        }
    }

    /// `EngineDescriptor::provides` 与节点自己声明的引擎依赖必须**互相吻合**。
    ///
    /// ## 为什么这条测试必须存在
    ///
    /// 界面照着 `provides` 显示「装了它解锁这些节点」。它和节点侧的
    /// `requires_engines` / `optional_engines` 是**两份数据、说的是同一件事** ——
    /// 而两份数据必然漂移。实测漂移过 5 处：
    ///
    /// * `libvips.provides` 写着 `image.enhance` / `image.strip-metadata`，
    ///   而这两个节点**只有纯 Rust 实现** → 用户为了用不上的功能去下 30 MB；
    /// * 同一张表漏了 `image.crop` / `image.rotate`，而它们**真的**会调 libvips
    ///   → 真正受益的功能反倒没被标出来；
    /// * `imagemagick.provides` 多写了 `image.strip-metadata`；
    /// * `python.provides` 把 `doc.ocr` 算作"需要 Python"，而它的 Tesseract
    ///   路径根本不需要 → 会让只装了 Tesseract 的机器被无谓地标灰；
    /// * `ai-provider.provides` 漏了 `doc.ocr`，而它的 AI 兜底正需要 AI 服务。
    ///
    /// 判据是**双向**的，两边都必须成立：
    /// * 节点把 E 列进 requires/optional ⟹ E 的 provides 里必须有这个节点；
    /// * E 的 provides 里有某个节点 ⟹ 那个节点的 requires/optional 里必须有 E。
    ///
    /// 方向都是"界面承诺"与"实际依赖"必须一致 —— 任一方向不成立，
    /// 用户看到的解锁关系就是假的。
    #[test]
    fn provides_matches_node_declarations() {
        let nodes = crate::pipeline::builtin_nodes();
        let engines = engine_catalog();

        for e in &engines {
            for node_name in &e.provides {
                let node = nodes.iter().find(|n| &n.name == node_name);
                let Some(node) = node else {
                    panic!(
                        "引擎 `{}` 的 provides 里写着不存在的节点 `{node_name}`",
                        e.id
                    );
                };
                assert!(
                    node.requires_engines.contains(&e.id) || node.optional_engines.contains(&e.id),
                    "引擎 `{}` 声称解锁节点 `{node_name}`，但那个节点的 \
                     requiresEngines / optionalEngines 里都没有它 —— \
                     界面会显示一个并不存在的解锁关系",
                    e.id
                );
            }
        }

        for node in &nodes {
            for engine_id in node
                .requires_engines
                .iter()
                .chain(node.optional_engines.iter())
            {
                let Some(e) = engines.iter().find(|e| &e.id == engine_id) else {
                    panic!(
                        "节点 `{}` 依赖了目录里不存在的引擎 `{engine_id}`",
                        node.name
                    );
                };
                assert!(
                    e.provides.contains(&node.name),
                    "节点 `{}` 声明依赖引擎 `{}`，但那个引擎的 provides 里没有它 —— \
                     界面会把「装了它解锁什么」显示漏",
                    node.name,
                    e.id
                );
            }
        }
    }

    #[test]
    fn only_download_mode_engines_have_managed_install() {
        for e in engine_catalog() {
            if e.install_modes.contains(&EngineInstallMode::Download) {
                assert!(e.approx_size_mb > 0, "{} 支持下载但没有给出体积估算", e.id);
            }
            if e.install_modes == vec![EngineInstallMode::System] {
                assert!(e.approx_size_mb > 0, "{} 应为系统安装", e.id);
            }
        }
    }

    /// 权重完整性判据：**0 字节必须被判为不完整**（这是本轮真实事故的形态）。
    #[test]
    fn empty_model_file_is_not_complete() {
        assert!(!model_size_looks_complete(0, 928));
        assert!(!model_size_looks_complete(0, 4));
    }

    #[test]
    fn obviously_truncated_model_file_is_not_complete() {
        let approx = 928 * 1024 * 1024u64;
        assert!(
            !model_size_looks_complete(approx / 2, 928),
            "半截下载应当被判为不完整"
        );
        assert!(!model_size_looks_complete(approx * 59 / 100, 928));
    }

    /// 反过来也要钉住：**完好的文件绝不能被误判**。
    ///
    /// `approx_size_mb` 是"约"，上游偶尔换同名资产；把它当精确值会让用户
    /// 反复重下几百 MB。所以 60% 以上的都放过。
    #[test]
    fn complete_model_file_is_accepted_with_slack() {
        let approx = 928 * 1024 * 1024u64;
        assert!(model_size_looks_complete(approx, 928));
        assert!(model_size_looks_complete(approx * 61 / 100, 928));
        assert!(
            model_size_looks_complete(approx * 105 / 100, 928),
            "比标称大也算完整"
        );
        // 真实实测值：birefnet-general 标称 928，磁盘上 927.61 MB
        assert!(model_size_looks_complete(972_686_045, 928 - 1));
    }

    /// 没有标称体积时不能因此误判成"损坏"。
    #[test]
    fn unknown_approx_size_never_flags_a_nonempty_file() {
        assert!(model_size_looks_complete(1, 0));
        assert!(!model_size_looks_complete(0, 0));
    }
}
