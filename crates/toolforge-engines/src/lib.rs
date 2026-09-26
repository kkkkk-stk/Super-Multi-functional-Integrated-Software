//! # toolforge-engines
//!
//! 引擎层的三个职责，按依赖顺序：
//!
//! 1. **探测**（[`registry::EngineRegistry::probe`]）：引擎装在哪、什么版本。
//!    查找顺序是「应用托管目录 → 系统 PATH → 各平台常见安装路径」，
//!    因为用户从官网下的绿色版 FFmpeg 通常不在 PATH 里。
//! 2. **获取**（[`registry::EngineRegistry::install`]）：按需下载 + SHA-256 校验 + 解压。
//!    **哈希不匹配一律删除并报错**，绝不"下载失败就凑合用"。
//! 3. **调用**（[`nodes`]）：把内置节点的语义翻译成具体的命令行或纯 Rust 调用，
//!    并把引擎缺失变成**可降级路径**而不是硬失败。
//!
//! ## 图片处理的三层降级 —— **这是目标，不是现状**
//!
//! 设计意图是图片处理唯一真正值得做三层降级的领域，因为纯 Rust 路径能兜住基础能力：
//!
//! ```text
//! libvips（快、省内存）  ──缺失──►  ImageMagick（格式最全）  ──缺失──►  纯 Rust image crate
//!                                                                        （零依赖，始终可用）
//! ```
//!
//! **但上面这两条"降级"目前只是在目录里登记了引擎，没有任何节点真的去调用它们。**
//! `nodes.rs` 里 `image.*` 一族全部走纯 Rust 的 `image` crate，只有
//! `ffmpeg` / `pandoc` / `libreoffice` / `7zip` 是被真正 `ctx.engine(..)` 起来的。
//! 直接的可见后果：WebP 只能无损编码（见 `image.convert` 里那条 warn）。
//! 谁要接这条链路，从 `image_convert` / `image_resize` 下手，别只改这段注释。
//!
//! 音视频/文档/压缩包没有纯 Rust 替代品，所以走「必需引擎缺失 → 该节点不可用」
//! 并在 UI 上直接引导安装。**不假装能跑**。

pub mod nodes;
pub mod registry;

pub use registry::{
    download, EngineInstallOutcome, EngineRegistry, ModelSpec, ENGINE_BINARIES,
};
pub use toolforge_core::{ToolforgeError, ToolforgeResult};

/// 引擎查找顺序里的第一站：应用托管目录下的相对路径。
///
/// 值是该引擎在托管目录中的**可执行文件相对路径**（Windows 会自动补 `.exe`）。
pub const MANAGED_LAYOUT: &[(&str, &str)] = &[
    ("ffmpeg", "bin/ffmpeg"),
    ("libvips", "bin/vips"),
    ("imagemagick", "magick"),
    ("pandoc", "pandoc"),
    ("libreoffice", "program/soffice"),
    ("7zip", "7z"),
    ("calibre", "ebook-convert"),
    ("tesseract", "tesseract"),
    ("python", "python"),
];

/// 引擎的版本探测参数（拿版本用的命令行参数）
pub fn version_args(engine_id: &str) -> &'static [&'static str] {
    match engine_id {
        // FFmpeg 把版本打到 stderr
        "ffmpeg" => &["-version"],
        "libvips" => &["--version"],
        "imagemagick" => &["-version"],
        "pandoc" => &["--version"],
        "libreoffice" => &["--version"],
        "7zip" => &[],
        "calibre" => &["--version"],
        "tesseract" => &["--version"],
        "python" => &["--version"],
        _ => &["--version"],
    }
}
