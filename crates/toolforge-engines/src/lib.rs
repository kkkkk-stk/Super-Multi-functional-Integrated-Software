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
//! ## 图片处理的三层降级（**已落地，但只覆盖一部分节点**）
//!
//! ```text
//! libvips（快、省内存）  ──缺失──►  ImageMagick（格式最全）  ──缺失──►  纯 Rust image crate
//!                                                                        （零依赖，始终可用）
//! ```
//!
//! 真正走这条链路的是 `image.convert` / `image.resize` / `image.crop` /
//! `image.rotate`（见 `nodes.rs` 的 `pick_image_backend`）—— 用的是哪个后端会写进
//! 节点输出值 `backend` 与一条 debug 日志。
//!
//! **还没走这条链路的**：`image.enhance`（纯 Rust 的亮度/对比度/饱和度/锐化）与
//! `image.strip_metadata`。它们不是"忘了改"，而是各自有原因；
//! 谁要接，改之前先读那两处的注释。
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
    // Poppler 的 Windows 包把可执行文件与 DLL 放在 `Library/bin`，数据文件在
    // `Library/share/poppler` —— 而 pdftoppm 是按**自己所在目录的相对位置**
    // 去找数据文件的。所以这一层的写法与 engine-sources.json 的
    // `binSubdir` 必须一致，两者改一个就得改另一个（见那里的 note）。
    ("poppler", "Library/bin/pdftoppm"),
    ("python", "python"),
];

/// 上面那张表的**平台例外**：同一个引擎在某个平台上要挑另一个可执行文件。
///
/// # 为什么需要这个（而不是直接改 [`MANAGED_LAYOUT`]）
///
/// `MANAGED_LAYOUT` 是**跨平台**的默认值，而"该用哪个可执行文件"在 Windows 上
/// 可能是另一件事。当前只有一条：
///
/// | 引擎 | 平台 | 默认 | 这个平台上改成 | 为什么 |
/// |---|---|---|---|---|
/// | `libreoffice` | Windows | `program/soffice` | `program/soffice.com` | `.exe` 是 GUI 启动器，`--version` 会**挂住** |
///
/// LibreOffice 的 Windows 包里 `soffice.exe` 与 `soffice.com` 都有一份、大小相同，
/// 但 `soffice.exe` 属于 **GUI 子系统**：它跑 `--version` 不返回
/// （本机实测 >20 秒两次、>300 秒一次），于是引擎探测会卡满那 10 秒超时、
/// 版本永远显示「未知」。`.com` 是同一份程序的控制台入口，`--version` 立刻打印
/// `LibreOffice 26.2.6.3 8221e31b…` 并退出，转换任务两者都能跑。
/// **命令行场景本来就该用 `.com`** —— 这不是绕过，是选对了入口。
///
/// 探测顺序是：平台例外 → [`MANAGED_LAYOUT`] → 按文件名在托管目录里递归找。
pub const MANAGED_LAYOUT_PLATFORM_OVERRIDES: &[(&str, &str)] = &[
    #[cfg(windows)]
    ("libreoffice", "program/soffice.com"),
];

/// 引擎的版本探测参数（拿版本用的命令行参数）。
///
/// **空数组是有含义的取值**：它表示"不带参数跑一次"。目前只有 `7zip` 用它 ——
/// 7-Zip 不带参数就打印版本横幅并退出 0（本机实测
/// `7-Zip 26.03 (x64) : Copyright (c) 1999-2026 Igor Pavlov : 2026-09-03`），
/// 而"更明确"的 `7z i` **反而更糟**：它会打印整张格式表，
/// [`toolforge_process::exec::probe_version`] 只留尾部，版本横幅会被挤掉。
/// 调用方（`registry.rs::probe_version_of`）**不能**因为参数为空就跳过探测。
pub fn version_args(engine_id: &str) -> &'static [&'static str] {
    match engine_id {
        // FFmpeg 把版本打到 stderr
        "ffmpeg" => &["-version"],
        "libvips" => &["--version"],
        "imagemagick" => &["-version"],
        "pandoc" => &["--version"],
        "libreoffice" => &["--version"],
        // 见上方文档注释：空 = 不带参数（7-Zip 的默认动作就是打印版本横幅）
        "7zip" => &[],
        "calibre" => &["--version"],
        "tesseract" => &["--version"],
        // pdftoppm 把版本打到 **stderr**（`pdftoppm version 26.09.0`），
        // 而且 `-v` 之后就退出，不会真的去渲染。
        "poppler" => &["-v"],
        "python" => &["--version"],
        _ => &["--version"],
    }
}
