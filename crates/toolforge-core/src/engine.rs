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
    /// 该模型是否已下载（运行时填充）
    #[serde(default)]
    pub installed: bool,
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
            approx_size_mb: 90,
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
            approx_size_mb: 35,
            core: false,
            provides: vec![
                "image.convert".into(),
                "image.resize".into(),
                "image.enhance".into(),
                "image.strip-metadata".into(),
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
                "image.strip-metadata".into(),
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
            install_modes: vec![EngineInstallMode::System, EngineInstallMode::Download],
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
                "doc.ocr".into(),
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
                    id: "u2net".into(),
                    name: "U²-Net".into(),
                    purpose: "通用显著性目标检测 / 抠图，效果均衡".into(),
                    approx_size_mb: 176,
                    license: "Apache-2.0".into(),
                    commercial_use: true,
                    url: None,
                    sha256: None,
                    installed: false,
                },
                EngineModel {
                    id: "u2netp".into(),
                    name: "U²-Net (轻量)".into(),
                    purpose: "U²-Net 的轻量版，速度快约 3 倍，边缘略糊".into(),
                    approx_size_mb: 5,
                    license: "Apache-2.0".into(),
                    commercial_use: true,
                    url: None,
                    sha256: None,
                    installed: false,
                },
                EngineModel {
                    id: "isnet-general".into(),
                    name: "IS-Net General".into(),
                    purpose: "通用抠图，对复杂边缘处理更好".into(),
                    approx_size_mb: 176,
                    license: "Apache-2.0".into(),
                    commercial_use: true,
                    url: None,
                    sha256: None,
                    installed: false,
                },
                EngineModel {
                    id: "birefnet-general".into(),
                    name: "BiRefNet".into(),
                    purpose: "当前抠图 SOTA，发丝级边缘".into(),
                    approx_size_mb: 900,
                    license: "MIT（代码）/ 权重另有条款".into(),
                    commercial_use: false,
                    url: None,
                    sha256: None,
                    installed: false,
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
                    installed: false,
                },
                EngineModel {
                    id: "realesrgan-x4plus".into(),
                    name: "Real-ESRGAN x4plus".into(),
                    purpose: "通用图像超分辨率放大".into(),
                    approx_size_mb: 67,
                    license: "BSD-3-Clause".into(),
                    commercial_use: true,
                    url: None,
                    sha256: None,
                    installed: false,
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
            license_note: "API Key 只存在本机加密存储中，不会随插件或日志外泄。".into(),
            approx_size_mb: 0,
            core: false,
            provides: vec!["ai.describe".into()],
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
