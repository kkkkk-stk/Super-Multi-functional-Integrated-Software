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
            install_modes: vec![EngineInstallMode::System],
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
            // 只支持系统安装。原因有两条，都是实测出来的：
            //   ① 官方只提供 **安装器**（.exe）或 `7z-extra.7z`，而后者需要先有 7-Zip
            //      才能解压 —— 先有鸡还是先有蛋；
            //   ② `engine-sources.json` 里那条版本固定直链（7z2408-extra.7z）
            //      **已经 404**（维护者实测），继续留着只会误导人。
            // 另外 7-Zip 本体只有 5 MB，让用户自己装一次完全可接受。
            install_modes: vec![EngineInstallMode::System],
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
                    sha256: Some("60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a".into()),
                    file_name: Some("isnet-general-use.onnx".into()),
                    installed: false,
                    used_by: vec!["image.remove-background".into()],
                },
                EngineModel {
                    id: "birefnet-general".into(),
                    name: "BiRefNet".into(),
                    purpose: "当前抠图 SOTA，发丝级边缘".into(),
                    approx_size_mb: 900,
                    license: "MIT（代码）/ 权重另有条款".into(),
                    commercial_use: false,
                    // 没配下载源：**不是遗漏，是不敢乱填**。
                    // 哈希必须来自真实下载，见 `verified_sources_are_pinned` 的说明。
                    url: None,
                    sha256: None,
                    file_name: None,
                    installed: false,
                    used_by: vec!["image.remove-background".into()],
                },
                EngineModel {
                    id: "modnet-portrait".into(),
                    name: "MODNet Portrait".into(),
                    purpose: "人像专用抠图（视频会议 / 证件照场景）".into(),
                    approx_size_mb: 25,
                    license: "Apache-2.0（代码）/ 学术用途权重".into(),
                    commercial_use: false,
                    url: None,
                    sha256: None,
                    file_name: None,
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
                    purpose: "完整版通用超分，质量最好的一档".into(),
                    approx_size_mb: 67,
                    license: "BSD-3-Clause".into(),
                    commercial_use: true,
                    // ⚠️ 这一条**故意**没有配下载源，原因和别的不同，值得写清楚：
                    //
                    // 找到的 x4plus ONNX 导出都是**固定输入尺寸**（64×64 或 128×128），
                    // 也就是说想用它必须把整张图切成小块、逐块推理再拼回去。
                    // 切块逻辑 `py/upscale.py` 里已经有了，但固定尺寸还要额外的
                    // "补齐到 64×64 再裁掉"这一步，而补边的质量直接影响边缘块的结果 ——
                    // 与其先上一个会留下网格状接缝的版本，不如先把两个**动态尺寸**
                    // 的模型（上面那两条）做扎实：它们对任意尺寸都能直接推理。
                    //
                    // 要做 x4plus：补上补齐 + 裁切，重新跑一遍接缝检查，再把哈希填进来。
                    // 哈希必须来自真实下载（见 `verified_sources_are_pinned`）。
                    url: None,
                    sha256: None,
                    file_name: None,
                    installed: false,
                    // 它**是**给超分用的，只是还没配下载源 ——
                    // 归属要照实写，"暂时下不了"和"没人用它"是两件事。
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
            requires_license_ack: false,
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
            requires_license_ack: false,
            models: vec![],
        },
    ]
}

/// 按 id 查引擎描述
pub fn find_engine(id: &str) -> Option<EngineDescriptor> {
    engine_catalog().into_iter().find(|e| e.id == id)
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
        let known: std::collections::HashSet<&str> =
            cat.iter().map(|e| e.id.as_str()).collect();
        for node in crate::pipeline::builtin_nodes() {
            for e in node.requires_engines.iter().chain(node.optional_engines.iter()) {
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
                    assert_eq!(hash, &hash.to_ascii_lowercase(), "模型 {} 的哈希要小写", m.id);
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

        // 文件名不能重复：两个模型写进同一个文件会互相覆盖
        let mut names: Vec<&str> = onnx
            .models
            .iter()
            .filter_map(|m| m.file_name.as_deref())
            .collect();
        names.sort_unstable();
        let before = names.len();
        names.dedup();
        assert_eq!(before, names.len(), "模型 file_name 有重复：{names:?}");
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
                assert!(
                    e.approx_size_mb > 0,
                    "{} 支持下载但没有给出体积估算",
                    e.id
                );
            }
            if e.install_modes == vec![EngineInstallMode::System] {
                assert_eq!(e.approx_size_mb > 0, true, "{} 应为系统安装", e.id);
            }
        }
    }
}
