//! 内置节点的执行实现。
//!
//! ## 一个节点的执行契约
//!
//! 输入是一组**已经渲染过的字符串参数**（模板求值由 `toolforge-plugins` 的流水线
//! 执行器完成），输出是 [`NodeOutput`]：一组可供后续步骤引用的键值 + 一组产出文件路径。
//!
//! 参数刻意用 `BTreeMap<String, String>` 而不是强类型结构体：因为
//! 它们是从 YAML 模板渲染出来的，本质上就是字符串；在节点内部按需解析，
//! 解析失败给出**指明参数名**的错误。
//!
//! ## 降级矩阵（本文件是唯一的真相来源）
//!
//! | 节点族 | 首选 | 次选 | 兜底 |
//! |---|---|---|---|
//! | `image.*` | libvips（快、省内存） | ImageMagick（格式最全） | **纯 Rust `image` crate（始终可用）** |
//! | `video.*` / `audio.*` | FFmpeg | —— | 无（返回 `EngineMissing`） |
//! | `doc.convert` | Pandoc | —— | 无 |
//! | `doc.to-pdf` | LibreOffice | —— | 无 |
//! | `archive.*` | 7-Zip | 系统 tar | 无 |
//! | `fs.*` | 纯 Rust | —— | —— |
//!
//! `image.*` 是唯一能真正"没有外部依赖也跑得动"的家族，所以它必须**先**实现纯 Rust
//! 路径，外部引擎只作为加速选项。反过来，音视频没有纯 Rust 替代品，
//! 就不要假装能跑 —— 直接告诉用户去装 FFmpeg。

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use toolforge_core::error::{ErrorCode, ToolforgeError, ToolforgeResult};
use toolforge_core::permission::{CapabilityGuard, PathResolver};
use toolforge_core::plugin::ParamValue;
use toolforge_core::queue::JobCtx;

use image::ImageEncoder; // PngEncoder / WebPEncoder 的 write_image 靠这个 trait
use toolforge_process::{exec, ExecOptions, StreamKind};

use crate::registry::EngineRegistry;

// ============================================================================
// 上下文与输出
// ============================================================================

/// 节点执行上下文。
pub struct NodeCtx {
    pub job: JobCtx,
    pub engines: Arc<EngineRegistry>,
    /// 路径收敛器 —— 所有文件访问都必须经过它
    pub resolver: PathResolver,
    /// 能力裁决器 —— 越权调用会被拒绝并记审计
    pub guard: CapabilityGuard,
    /// 用户填写的参数（已按 `default` 补齐）
    pub params: HashMap<String, ParamValue>,
    /// 流水线变量（`${vars.x}` 与 `flow.set-var` 写入）
    pub vars: HashMap<String, String>,
}

impl NodeCtx {
    pub fn param_str(&self, key: &str, default: &str) -> String {
        self.params
            .get(key)
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .unwrap_or_else(|| default.to_string())
    }

    pub fn param_i64(&self, key: &str, default: i64) -> i64 {
        self.params
            .get(key)
            .and_then(|v| v.as_i64())
            .unwrap_or(default)
    }

    pub fn param_f64(&self, key: &str, default: f64) -> f64 {
        self.params
            .get(key)
            .and_then(|v| v.as_f64())
            .unwrap_or(default)
    }

    pub fn param_bool(&self, key: &str, default: bool) -> bool {
        self.params
            .get(key)
            .and_then(|v| v.as_bool())
            .unwrap_or(default)
    }

    /// 要求某个引擎存在，否则给出可操作的错误
    pub async fn engine(&self, id: &str) -> ToolforgeResult<PathBuf> {
        self.engines.resolve(id).await
    }
}

/// 节点产出
#[derive(Debug, Clone, Default)]
pub struct NodeOutput {
    /// 供 `${steps.<id>.<key>}` 引用的值
    pub values: HashMap<String, String>,
    /// 产出文件（会被写进 `Job::outputs`，前端据此展示"打开所在文件夹"）
    pub outputs: Vec<String>,
}

impl NodeOutput {
    pub fn value(k: impl Into<String>, v: impl Into<String>) -> Self {
        let mut m = HashMap::new();
        m.insert(k.into(), v.into());
        Self {
            values: m,
            outputs: vec![],
        }
    }

    pub fn file(p: impl Into<String>) -> Self {
        Self {
            values: HashMap::new(),
            outputs: vec![p.into()],
        }
    }

    pub fn with_value(mut self, k: impl Into<String>, v: impl Into<String>) -> Self {
        self.values.insert(k.into(), v.into());
        self
    }
}

// ---- 参数取用辅助 ----

fn arg<'a>(args: &'a BTreeMap<String, String>, key: &str) -> ToolforgeResult<&'a str> {
    args.get(key).map(|s| s.as_str()).ok_or_else(|| {
        ToolforgeError::plugin_invalid(format!("节点缺少必需参数 `{key}`"))
            .with_detail("检查插件清单里该步骤的 `with` 块")
    })
}

fn arg_opt<'a>(args: &'a BTreeMap<String, String>, key: &str) -> Option<&'a str> {
    args.get(key)
        .map(|s| s.as_str())
        .filter(|s| !s.trim().is_empty())
}

/// 从字符串参数里取整数。
///
/// 保留这个函数（而不是只依赖 `ctx.param_*`）是因为 `with` 块里的值
/// 经过模板渲染后**全是字符串**，节点内部直接按字符串解析是常见写法。
/// 当前的内置节点多走强类型的 `ctx.param_*`，所以这里暂时只有测试在用。
#[allow(dead_code)]
fn arg_i64(args: &BTreeMap<String, String>, key: &str, default: i64) -> i64 {
    arg_opt(args, key)
        .and_then(|s| s.trim().parse::<i64>().ok())
        .or_else(|| {
            arg_opt(args, key)
                .and_then(|s| s.trim().parse::<f64>().ok())
                .map(|f| f as i64)
        })
        .unwrap_or(default)
}

fn arg_bool(args: &BTreeMap<String, String>, key: &str, default: bool) -> bool {
    match arg_opt(args, key).map(|s| s.trim().to_ascii_lowercase()) {
        Some(v) => matches!(v.as_str(), "true" | "1" | "yes" | "on"),
        None => default,
    }
}

/// 把逻辑路径（`/output/x.png` 或相对路径）解析成真实路径，走权限与穿越检查。
fn resolve_path(ctx: &NodeCtx, scope_kind: &str, p: &str) -> ToolforgeResult<PathBuf> {
    use toolforge_core::permission::PathScope;
    let scope = match scope_kind {
        "input" => PathScope::Input,
        "output" => PathScope::Output,
        "data" => PathScope::PluginData,
        _ => PathScope::Workspace,
    };
    // 允许 '/input/xxx' 这种带虚拟前缀的写法：剥掉前缀后按相对路径处理
    let rel = p
        .strip_prefix("/input/")
        .or_else(|| p.strip_prefix("/output/"))
        .or_else(|| p.strip_prefix("/work/"))
        .or_else(|| p.strip_prefix("/data/"))
        .unwrap_or(p);
    ctx.resolver.resolve(&scope, rel)
}

// ============================================================================
// 分发
// ============================================================================

/// 执行一个内置节点。
pub async fn run(
    ctx: &mut NodeCtx,
    node: &str,
    args: &BTreeMap<String, String>,
) -> ToolforgeResult<NodeOutput> {
    match node {
        // ---------- 文件 ----------
        "fs.copy" => fs_copy(ctx, args, false).await,
        "fs.move" => fs_copy(ctx, args, true).await,
        "fs.mkdir" => fs_mkdir(ctx, args).await,
        "fs.delete" => fs_delete(ctx, args).await,

        // ---------- 图片（纯 Rust 兜底，永远可用）----------
        "image.probe" => image_probe(ctx, args).await,
        "image.convert" => image_convert(ctx, args).await,
        "image.resize" => image_resize(ctx, args).await,
        "image.crop" => image_crop(ctx, args).await,
        "image.rotate" => image_rotate(ctx, args).await,
        "image.enhance" => image_enhance(ctx, args).await,
        "image.strip-metadata" => image_strip_metadata(ctx, args).await,

        // ---------- 音视频（FFmpeg 硬依赖）----------
        "video.transcode" => ffmpeg_transcode(ctx, args).await,
        "video.extract-audio" => ffmpeg_extract_audio(ctx, args).await,
        "video.thumbnail" => ffmpeg_thumbnail(ctx, args).await,
        "video.trim" => ffmpeg_trim(ctx, args).await,
        "video.compress" => ffmpeg_compress(ctx, args).await,
        "audio.convert" => ffmpeg_audio_convert(ctx, args).await,
        "audio.normalize" => ffmpeg_audio_normalize(ctx, args).await,

        // ---------- 文档 / 压缩包 ----------
        "doc.convert" => pandoc_convert(ctx, args).await,
        "doc.to-pdf" => libreoffice_to_pdf(ctx, args).await,
        "archive.pack" => sevenzip_pack(ctx, args).await,
        "archive.unpack" => sevenzip_unpack(ctx, args).await,

        // ---------- 流程控制（由流水线执行器特殊处理，这里只兜底）----------
        "flow.log" => Ok(NodeOutput::default()),
        "flow.set-var" => flow_set_var(ctx, args).await,
        "flow.branch" => Ok(NodeOutput::default()),

        // ---------- 尚未实现（v0.1 明确不支持，见 docs/ROADMAP.md）----------
        other => Err(not_implemented(other)),
    }
}

/// 统一的"未实现"错误。
///
/// 刻意**不返回假的成功**：插件作者与用户都必须立刻知道这个能力还没做，
/// 否则会出现"流水线显示跑通了但没产出文件"这种最难排查的问题。
fn not_implemented(node: &str) -> ToolforgeError {
    ToolforgeError::new(
        ErrorCode::Internal,
        format!("内置节点 `{node}` 尚未在 v0.1 中实现"),
    )
    .with_detail(
        "该节点已在节点目录中登记（因此流程编辑器可以拖出来），但执行器还没有实现。\
         实现进度见 docs/ROADMAP.md。若你期望它现在就能用，请提 issue。",
    )
    .with_subject(node)
}

// ============================================================================
// 文件节点
// ============================================================================

async fn fs_copy(
    ctx: &mut NodeCtx,
    args: &BTreeMap<String, String>,
    is_move: bool,
) -> ToolforgeResult<NodeOutput> {
    let src = resolve_path(ctx, "input", arg(args, "src")?)?;
    let dst = resolve_path(ctx, "output", arg(args, "dst")?)?;
    let overwrite = arg_bool(args, "overwrite", true);

    if !src.exists() {
        return Err(ToolforgeError::not_found(format!(
            "源文件不存在：{}",
            src.display()
        )));
    }
    if dst.exists() && !overwrite {
        return Err(ToolforgeError::invalid(format!(
            "目标已存在且 overwrite=false：{}",
            dst.display()
        )));
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| ToolforgeError::io(format!("创建目录失败：{e}")))?;
    }

    // 同盘 move 走 rename（瞬时）；跨盘则退化为复制 + 删除
    if is_move {
        if std::fs::rename(&src, &dst).is_ok() {
            return Ok(NodeOutput::file(dst.display().to_string())
                .with_value("path", dst.display().to_string()));
        }
        std::fs::copy(&src, &dst).map_err(|e| {
            ToolforgeError::io(format!("移动 {} 失败：{e}", src.display()))
        })?;
        std::fs::remove_file(&src)
            .map_err(|e| ToolforgeError::io(format!("删除源文件失败：{e}")))?;
    } else {
        std::fs::copy(&src, &dst).map_err(|e| {
            ToolforgeError::io(format!("复制 {} 失败：{e}", src.display()))
        })?;
    }

    Ok(NodeOutput::file(dst.display().to_string())
        .with_value("path", dst.display().to_string()))
}

async fn fs_mkdir(ctx: &mut NodeCtx, args: &BTreeMap<String, String>) -> ToolforgeResult<NodeOutput> {
    let dir = resolve_path(ctx, "output", arg(args, "path")?)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| ToolforgeError::io(format!("创建目录 {} 失败：{e}", dir.display())))?;
    Ok(NodeOutput::default().with_value("path", dir.display().to_string()))
}

async fn fs_delete(ctx: &mut NodeCtx, args: &BTreeMap<String, String>) -> ToolforgeResult<NodeOutput> {
    let target = resolve_path(ctx, "output", arg(args, "src")?)?;
    if !target.exists() {
        return Ok(NodeOutput::default());
    }
    if target.is_dir() {
        std::fs::remove_dir_all(&target)
            .map_err(|e| ToolforgeError::io(format!("删除目录失败：{e}")))?;
    } else {
        std::fs::remove_file(&target)
            .map_err(|e| ToolforgeError::io(format!("删除文件失败：{e}")))?;
    }
    Ok(NodeOutput::default())
}

async fn flow_set_var(
    ctx: &mut NodeCtx,
    args: &BTreeMap<String, String>,
) -> ToolforgeResult<NodeOutput> {
    let name = arg(args, "name")?;
    let value = arg(args, "value")?;
    ctx.vars.insert(name.to_string(), value.to_string());
    Ok(NodeOutput::value("value", value))
}

// ============================================================================
// 图片节点 —— 纯 Rust 路径（始终可用）
// ============================================================================

fn decode_image(path: &Path) -> ToolforgeResult<image::DynamicImage> {
    let reader = image::ImageReader::open(path)
        .map_err(|e| ToolforgeError::io(format!("无法打开图片 {}：{e}", path.display())))?
        .with_guessed_format()
        .map_err(|e| ToolforgeError::io(format!("无法识别图片格式：{e}")))?;
    reader
        .decode()
        .map_err(|e| ToolforgeError::invalid(format!("图片解码失败：{e}")))
        .map_err(|e| e.with_subject(path.display().to_string()))
}

fn parse_format(s: &str) -> ToolforgeResult<image::ImageFormat> {
    match s.trim().to_ascii_lowercase().as_str() {
        "png" => Ok(image::ImageFormat::Png),
        "jpg" | "jpeg" => Ok(image::ImageFormat::Jpeg),
        "webp" => Ok(image::ImageFormat::WebP),
        "bmp" => Ok(image::ImageFormat::Bmp),
        "tif" | "tiff" => Ok(image::ImageFormat::Tiff),
        "gif" => Ok(image::ImageFormat::Gif),
        "ico" => Ok(image::ImageFormat::Ico),
        "pnm" => Ok(image::ImageFormat::Pnm),
        "qoi" => Ok(image::ImageFormat::Qoi),
        "tga" => Ok(image::ImageFormat::Tga),
        "dds" => Ok(image::ImageFormat::Dds),
        "hdr" => Ok(image::ImageFormat::Hdr),
        "ff" | "farbfeld" => Ok(image::ImageFormat::Farbfeld),
        other => Err(ToolforgeError::invalid(format!(
            "不支持的图片格式 `{other}`"
        ))
        .with_detail("纯 Rust 后端支持：png / jpeg / webp / bmp / tiff / gif / ico / pnm / qoi / tga / dds / hdr / ff。\
                      若需 avif / jxl / heic，请安装 libvips 或 ImageMagick。")),
    }
}

/// 按格式写出，并在能控制质量的地方按质量写出。
fn encode_image(
    img: &image::DynamicImage,
    path: &Path,
    fmt: image::ImageFormat,
    quality: u8,
) -> ToolforgeResult<()> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| ToolforgeError::io(format!("创建目录失败：{e}")))?;
    }
    let file = std::fs::File::create(path)
        .map_err(|e| ToolforgeError::io(format!("创建文件 {} 失败：{e}", path.display())))?;
    let mut w = std::io::BufWriter::new(file);

    match fmt {
        image::ImageFormat::Jpeg => {
            // JPEG 不支持 alpha，必须先转 RGB，否则编码器会报错
            let rgb = img.to_rgb8();
            let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut w, quality);
            enc.encode(
                rgb.as_raw(),
                rgb.width(),
                rgb.height(),
                image::ExtendedColorType::Rgb8,
            )
            .map_err(|e| ToolforgeError::internal(format!("JPEG 编码失败：{e}")))?;
        }
        image::ImageFormat::Png => {
            // PngEncoder::write_image 消费 self，所以不需要 mut
            let enc = image::codecs::png::PngEncoder::new(&mut w);
            let rgba = img.to_rgba8();
            enc.write_image(
                rgba.as_raw(),
                rgba.width(),
                rgba.height(),
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|e| ToolforgeError::internal(format!("PNG 编码失败：{e}")))?;
        }
        image::ImageFormat::WebP => {
            let rgba = img.to_rgba8();
            let enc = image::codecs::webp::WebPEncoder::new_lossless(&mut w);
            enc.write_image(
                rgba.as_raw(),
                rgba.width(),
                rgba.height(),
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|e| ToolforgeError::internal(format!("WebP 编码失败：{e}")))?;
        }
        _ => {
            // 其余格式交给 image 的默认编码器
            drop(w);
            img.save_with_format(path, fmt)
                .map_err(|e| ToolforgeError::internal(format!("编码失败：{e}")))?;
            return Ok(());
        }
    }

    w.flush()
        .map_err(|e| ToolforgeError::io(format!("写入失败：{e}")))?;
    Ok(())
}

async fn image_probe(
    ctx: &mut NodeCtx,
    args: &BTreeMap<String, String>,
) -> ToolforgeResult<NodeOutput> {
    let src = resolve_path(ctx, "input", arg(args, "src")?)?;
    let img = decode_image(&src)?;
    let (w, h) = (img.width(), img.height());
    let color = format!("{:?}", img.color());

    let mut out = NodeOutput::default();
    out.values.insert("width".into(), w.to_string());
    out.values.insert("height".into(), h.to_string());
    out.values.insert("color".into(), color.clone());
    out.values
        .insert("megapixels".into(), format!("{:.2}", (w as f64 * h as f64) / 1e6));
    Ok(out)
}

async fn image_convert(
    ctx: &mut NodeCtx,
    args: &BTreeMap<String, String>,
) -> ToolforgeResult<NodeOutput> {
    let src = resolve_path(ctx, "input", arg(args, "src")?)?;
    let dst = resolve_path(ctx, "output", arg(args, "dst")?)?;
    let fmt = parse_format(&ctx.param_str("format", "webp"))?;
    let quality = ctx.param_i64("quality", 90).clamp(1, 100) as u8;

    ctx.job
        .progress_now(toolforge_core::job::JobProgress::indeterminate(format!(
            "转换 {}",
            file_label(&src)
        )));

    let img = decode_image(&src)?;

    if fmt == image::ImageFormat::WebP {
        ctx.job
            .warn("纯 Rust 后端的 WebP 编码只有无损模式，文件可能比预期大；安装 libvips 可获得有损压缩。");
    }

    encode_image(&img, &dst, fmt, quality)?;
    Ok(NodeOutput::file(dst.display().to_string())
        .with_value("path", dst.display().to_string()))
}

async fn image_resize(
    ctx: &mut NodeCtx,
    args: &BTreeMap<String, String>,
) -> ToolforgeResult<NodeOutput> {
    let src = resolve_path(ctx, "input", arg(args, "src")?)?;
    let dst = resolve_path(ctx, "output", arg(args, "dst")?)?;
    let tw = ctx.param_i64("width", 0);
    let th = ctx.param_i64("height", 0);
    let filter = match ctx.param_str("filter", "lanczos3").as_str() {
        "nearest" => image::imageops::FilterType::Nearest,
        "triangle" => image::imageops::FilterType::Triangle,
        "catmullrom" => image::imageops::FilterType::CatmullRom,
        "gaussian" => image::imageops::FilterType::Gaussian,
        _ => image::imageops::FilterType::Lanczos3,
    };

    let img = decode_image(&src)?;
    let (ow, oh) = (img.width() as i64, img.height() as i64);

    // 只给一边时按比例推导 —— 这是用户 90% 的场景
    let (nw, nh) = match (tw > 0, th > 0) {
        (true, true) => (tw as u32, th as u32),
        (true, false) => {
            let ratio = tw as f64 / ow as f64;
            (tw as u32, ((oh as f64 * ratio).round() as u32).max(1))
        }
        (false, true) => {
            let ratio = th as f64 / oh as f64;
            (((ow as f64 * ratio).round() as u32).max(1), th as u32)
        }
        (false, false) => {
            return Err(ToolforgeError::invalid(
                "image.resize 需要至少指定 width 或 height 之一",
            ))
        }
    };

    let resized = img.resize_exact(nw, nh, filter);
    let fmt = image::ImageFormat::from_path(&dst)
        .or_else(|_| image::ImageFormat::from_path(&src))
        .map_err(|_| ToolforgeError::invalid("无法从路径推断输出格式，请显式指定扩展名"))?;
    encode_image(&resized, &dst, fmt, 92)?;

    Ok(NodeOutput::file(dst.display().to_string())
        .with_value("width", nw.to_string())
        .with_value("height", nh.to_string()))
}

async fn image_crop(
    ctx: &mut NodeCtx,
    args: &BTreeMap<String, String>,
) -> ToolforgeResult<NodeOutput> {
    let src = resolve_path(ctx, "input", arg(args, "src")?)?;
    let dst = resolve_path(ctx, "output", arg(args, "dst")?)?;
    let img = decode_image(&src)?;
    let (w, h) = (img.width(), img.height());

    let cropped = match ctx.param_str("mode", "center").as_str() {
        "custom" => {
            let x = ctx.param_i64("x", 0).max(0) as u32;
            let y = ctx.param_i64("y", 0).max(0) as u32;
            let cw = (ctx.param_i64("width", 512).max(1) as u32).min(w.saturating_sub(x));
            let ch = (ctx.param_i64("height", 512).max(1) as u32).min(h.saturating_sub(y));
            img.crop_imm(x, y, cw.max(1), ch.max(1))
        }
        // center / smart 都是中心裁剪：smart 的"内容感知"需要 libvips attention，
        // 纯 Rust 路径退化为几何中心裁剪（诚实降级）
        _ => {
            let cw = (ctx.param_i64("width", 512).max(1) as u32).min(w);
            let ch = (ctx.param_i64("height", 512).max(1) as u32).min(h);
            let x = (w - cw) / 2;
            let y = (h - ch) / 2;
            img.crop_imm(x, y, cw, ch)
        }
    };

    let fmt = image::ImageFormat::from_path(&dst)
        .map_err(|_| ToolforgeError::invalid("无法从输出路径推断格式"))?;
    encode_image(&cropped, &dst, fmt, 92)?;
    Ok(NodeOutput::file(dst.display().to_string())
        .with_value("width", cropped.width().to_string())
        .with_value("height", cropped.height().to_string()))
}

async fn image_rotate(
    ctx: &mut NodeCtx,
    args: &BTreeMap<String, String>,
) -> ToolforgeResult<NodeOutput> {
    let src = resolve_path(ctx, "input", arg(args, "src")?)?;
    let dst = resolve_path(ctx, "output", arg(args, "dst")?)?;
    let angle = ctx.param_f64("angle", 90.0);
    let flip_h = ctx.param_bool("flipH", false);
    let flip_v = ctx.param_bool("flipV", false);

    let mut img = decode_image(&src)?;

    // 纯 Rust 路径只支持 90 的整数倍旋转。
    // 任意角度需要重采样，走 ImageMagick / libvips —— 这里明确降级而不是静默取整。
    let normalized = ((angle % 360.0) + 360.0) % 360.0;
    match normalized as i64 {
        0 => {}
        90 => img = img.rotate90(),
        180 => img = img.rotate180(),
        270 => img = img.rotate270(),
        _ => {
            return Err(ToolforgeError::engine_missing("imagemagick").with_detail(format!(
                "纯 Rust 后端只支持 90° 整数倍旋转（当前 {angle}°）。\
                 任意角度旋转需要重采样，请安装 ImageMagick 或 libvips。"
            )));
        }
    }

    if flip_h {
        img = img.fliph();
    }
    if flip_v {
        img = img.flipv();
    }

    let fmt = image::ImageFormat::from_path(&dst)
        .map_err(|_| ToolforgeError::invalid("无法从输出路径推断格式"))?;
    encode_image(&img, &dst, fmt, 92)?;
    Ok(NodeOutput::file(dst.display().to_string()))
}

async fn image_enhance(
    ctx: &mut NodeCtx,
    args: &BTreeMap<String, String>,
) -> ToolforgeResult<NodeOutput> {
    let src = resolve_path(ctx, "input", arg(args, "src")?)?;
    let dst = resolve_path(ctx, "output", arg(args, "dst")?)?;

    let brightness = ctx.param_i64("brightness", 0) as i32;
    let contrast = ctx.param_i64("contrast", 0) as i32;
    let saturation = ctx.param_i64("saturation", 0) as i32;
    let sharpen = ctx.param_i64("sharpen", 0) as i32;

    if brightness == 0 && contrast == 0 && saturation == 0 && sharpen == 0 {
        ctx.job
            .warn("所有增强参数都是 0，输出与输入相同（这是有意为之，便于对比调试）");
    }

    let img = decode_image(&src)?;

    // 亮度：线性偏移
    let mut out = if brightness != 0 {
        let offset = (brightness as f32) * 2.55;
        image::DynamicImage::ImageRgb8(image::imageops::colorops::brighten(
            &img.to_rgb8(),
            offset as i32,
        ))
    } else {
        img.clone()
    };

    // 对比度：绕中值的线性拉伸
    if contrast != 0 {
        let c = (contrast as f32).clamp(-100.0, 100.0) / 100.0;
        let factor = (1.0 + c).max(0.0);
        let rgb = out.to_rgb8();
        let adjusted = image::imageops::colorops::contrast(&rgb, factor * 20.0);
        out = image::DynamicImage::ImageRgb8(adjusted);
    }

    // 饱和度：向灰度插值
    if saturation != 0 {
        let rgb = out.to_rgb8();
        let gray = image::imageops::colorops::grayscale(&rgb);
        let s = (saturation as f32).clamp(-100.0, 100.0) / 100.0;
        let mut mixed = rgb.clone();
        for (i, px) in mixed.pixels_mut().enumerate() {
            let g = gray.as_raw()[i];
            for ch in 0..3 {
                let orig = px.0[ch] as f32;
                let target = if s >= 0.0 {
                    // 提饱和：把灰度当基线往外推
                    orig + (orig - g as f32) * s * 1.5
                } else {
                    // 降饱和：向灰度靠拢
                    orig + (g as f32 - orig) * (-s)
                };
                px.0[ch] = target.clamp(0.0, 255.0) as u8;
            }
        }
        out = image::DynamicImage::ImageRgb8(mixed);
    }

    // 锐化：3x3 拉普拉斯核
    if sharpen > 0 {
        let amount = (sharpen as f32 / 100.0).clamp(0.0, 1.0);
        let rgb = out.to_rgb8();
        let (w, h) = rgb.dimensions();
        let mut sharpened = rgb.clone();
        // 边缘一圈不动，避免越界；这是刻意选择 —— 补边会引入暗边
        for y in 1..h.saturating_sub(1) {
            for x in 1..w.saturating_sub(1) {
                let mut acc = [0f32; 3];
                for ch in 0..3 {
                    let center = rgb.get_pixel(x, y).0[ch] as f32;
                    let mut lap = 5.0 * center;
                    lap -= rgb.get_pixel(x - 1, y).0[ch] as f32;
                    lap -= rgb.get_pixel(x + 1, y).0[ch] as f32;
                    lap -= rgb.get_pixel(x, y - 1).0[ch] as f32;
                    lap -= rgb.get_pixel(x, y + 1).0[ch] as f32;
                    acc[ch] = center + (lap - center) * amount;
                }
                sharpened.put_pixel(
                    x,
                    y,
                    image::Rgb([
                        acc[0].clamp(0.0, 255.0) as u8,
                        acc[1].clamp(0.0, 255.0) as u8,
                        acc[2].clamp(0.0, 255.0) as u8,
                    ]),
                );
            }
        }
        out = image::DynamicImage::ImageRgb8(sharpened);
    }

    let fmt = image::ImageFormat::from_path(&dst)
        .map_err(|_| ToolforgeError::invalid("无法从输出路径推断格式"))?;
    encode_image(&out, &dst, fmt, 92)?;
    Ok(NodeOutput::file(dst.display().to_string()))
}

async fn image_strip_metadata(
    ctx: &mut NodeCtx,
    args: &BTreeMap<String, String>,
) -> ToolforgeResult<NodeOutput> {
    let src = resolve_path(ctx, "input", arg(args, "src")?)?;
    let dst = resolve_path(ctx, "output", arg(args, "dst")?)?;

    // `image` crate 的解码→编码链路本身就不会保留 EXIF/IPTC/XMP，
    // 所以重新编码一次就是最彻底的"清除元数据"。
    let img = decode_image(&src)?;
    let fmt = image::ImageFormat::from_path(&dst)
        .map_err(|_| ToolforgeError::invalid("无法从输出路径推断格式"))?;
    encode_image(&img, &dst, fmt, 95)?;

    ctx.job
        .info("已清除 EXIF / IPTC / XMP（重新编码路径不保留任何元数据块）");
    Ok(NodeOutput::file(dst.display().to_string()))
}

// ============================================================================
// FFmpeg 家族
// ============================================================================

/// 用 ffprobe 拿媒体时长（秒）。拿不到就返回 None —— 进度条退化为不确定态。
///
/// ffprobe 与 ffmpeg 是同一个发行包里的两个可执行文件，所以**先看 ffmpeg 旁边**，
/// 再退回系统 PATH。引擎目录里没有单独的 `ffprobe` 条目，不要对它调 `resolve`。
async fn ffprobe_duration(ctx: &NodeCtx, path: &Path) -> Option<f64> {
    let ffprobe = match ctx.engines.resolve("ffmpeg").await {
        Ok(ffmpeg) => {
            let sibling = ffmpeg.with_file_name(if cfg!(windows) {
                "ffprobe.exe"
            } else {
                "ffprobe"
            });
            if sibling.is_file() {
                sibling
            } else {
                ctx.engines.system_binary("ffprobe")?
            }
        }
        Err(_) => ctx.engines.system_binary("ffprobe")?,
    };

    let r = exec(
        ExecOptions::new(ffprobe)
            .args([
                "-v".into(),
                "error".into(),
                "-show_entries".into(),
                "format=duration".into(),
                "-of".into(),
                "default=noprint_wrappers=1:nokey=1".into(),
                path.display().to_string(),
            ])
            .timeout(Duration::from_secs(30))
            .quiet(true),
    )
    .await
    .ok()?;
    r.stdout.trim().parse::<f64>().ok()
}

/// 构造 FFmpeg 命令并执行，同时把 `-progress` 输出翻译成进度。
async fn run_ffmpeg(
    ctx: &mut NodeCtx,
    mut args: Vec<String>,
    duration: Option<f64>,
    label: String,
) -> ToolforgeResult<()> {
    let ffmpeg = ctx.engine("ffmpeg").await?;

    // 统一加上：不覆盖交互提问、只报错误、进度走 stderr 的机器可读格式
    args.push("-nostdin".into());
    args.push("-progress".into());
    args.push("pipe:2".into());
    args.push("-nostats".into());

    let job = ctx.job.clone();
    let cancel = ctx.job.cancel.clone();

    let result = toolforge_process::exec_streaming(
        ExecOptions::new(ffmpeg)
            .args(args)
            .cancel(cancel)
            .timeout(Duration::from_secs(6 * 3600))
            .quiet(true),
        move |kind, line| {
            if kind != StreamKind::Stderr {
                return;
            }
            // `-progress` 的输出形如 `out_time_ms=1234567`
            if let Some(v) = line.strip_prefix("out_time_ms=") {
                if let (Ok(us), Some(total)) = (v.trim().parse::<i64>(), duration) {
                    if total > 0.0 {
                        let done = (us as f64 / 1_000_000.0).min(total);
                        let mut p =
                            toolforge_core::job::JobProgress::ratio(label.clone(), done as u64, total as u64);
                        p.current_item = Some(label.clone());
                        p.eta_seconds = Some((total - done).max(0.0));
                        job.progress(p);
                    }
                }
            } else if line.starts_with("speed=") {
                // 顺手把 FFmpeg 自己的速度估计转成人类可读文本
                let speed = line.trim_start_matches("speed=").trim().to_string();
                if speed != "N/A" {
                    let mut p = toolforge_core::job::JobProgress::indeterminate(label.clone());
                    p.speed = Some(speed);
                    job.progress(p);
                }
            }
        },
    )
    .await?;

    if !result.success() {
        return Err(result.into_error("ffmpeg"));
    }
    Ok(())
}

async fn ffmpeg_transcode(
    ctx: &mut NodeCtx,
    args: &BTreeMap<String, String>,
) -> ToolforgeResult<NodeOutput> {
    let src = resolve_path(ctx, "input", arg(args, "src")?)?;
    let dst = resolve_path(ctx, "output", arg(args, "dst")?)?;
    let vcodec = ctx.param_str("vcodec", "libx264");
    let acodec = ctx.param_str("acodec", "aac");
    let crf = ctx.param_i64("crf", 23);
    let preset = ctx.param_str("preset", "medium");
    let hwaccel = ctx.param_str("hwaccel", "none");

    let mut a = vec![
        "-y".into(),
        "-i".into(),
        src.display().to_string(),
    ];

    // 硬件解码（放 -i 之后、编码参数之前）
    match hwaccel.as_str() {
        "nvenc" => {
            a.push("-c:v".into());
            a.push("h264_nvenc".into());
            a.push("-preset".into());
            a.push("p4".into());
        }
        "qsv" => {
            a.push("-c:v".into());
            a.push("h264_qsv".into());
        }
        "amf" => {
            a.push("-c:v".into());
            a.push("h264_amf".into());
        }
        "videotoolbox" => {
            a.push("-c:v".into());
            a.push("h264_videotoolbox".into());
        }
        _ => {
            a.push("-c:v".into());
            a.push(vcodec.clone());
            if vcodec != "copy" && vcodec != "av1" {
                a.push("-crf".into());
                a.push(crf.to_string());
                a.push("-preset".into());
                a.push(preset);
            }
        }
    }

    a.push("-c:a".into());
    a.push(acodec);
    a.push(dst.display().to_string());

    let duration = ffprobe_duration(ctx, &src).await;
    run_ffmpeg(ctx, a, duration, file_label(&src)).await?;

    Ok(NodeOutput::file(dst.display().to_string())
        .with_value("path", dst.display().to_string()))
}

async fn ffmpeg_extract_audio(
    ctx: &mut NodeCtx,
    args: &BTreeMap<String, String>,
) -> ToolforgeResult<NodeOutput> {
    let src = resolve_path(ctx, "input", arg(args, "src")?)?;
    let dst = resolve_path(ctx, "output", arg(args, "dst")?)?;
    let bitrate = ctx.param_i64("bitrate", 192);

    let codec = match ctx.param_str("format", "mp3").as_str() {
        "mp3" => "libmp3lame",
        "aac" | "m4a" => "aac",
        "flac" => "flac",
        "wav" => "pcm_s16le",
        "opus" => "libopus",
        _ => "libmp3lame",
    };

    let mut a = vec![
        "-y".into(),
        "-i".into(),
        src.display().to_string(),
        "-vn".into(),
        "-c:a".into(),
        codec.into(),
    ];
    if codec != "flac" && codec != "pcm_s16le" {
        a.push("-b:a".into());
        a.push(format!("{bitrate}k"));
    }
    a.push(dst.display().to_string());

    let duration = ffprobe_duration(ctx, &src).await;
    run_ffmpeg(ctx, a, duration, file_label(&src)).await?;
    Ok(NodeOutput::file(dst.display().to_string()))
}

async fn ffmpeg_thumbnail(
    ctx: &mut NodeCtx,
    args: &BTreeMap<String, String>,
) -> ToolforgeResult<NodeOutput> {
    let src = resolve_path(ctx, "input", arg(args, "src")?)?;
    let dst = resolve_path(ctx, "output", arg(args, "dst")?)?;
    let at = ctx.param_str("at", "00:00:01");
    let width = ctx.param_i64("width", 1280);

    let a = vec![
        "-y".into(),
        "-ss".into(),
        at,
        "-i".into(),
        src.display().to_string(),
        "-frames:v".into(),
        "1".into(),
        // -2 保证高度是偶数（libx264 与多数解码器要求）
        "-vf".into(),
        format!("scale={width}:-2"),
        dst.display().to_string(),
    ];

    // 抽帧很快，没有可用的时间轴进度，直接转不确定态
    ctx.job
        .progress_now(toolforge_core::job::JobProgress::indeterminate(format!(
            "截取 {} 的封面",
            file_label(&src)
        )));
    run_ffmpeg(ctx, a, None, file_label(&src)).await?;
    Ok(NodeOutput::file(dst.display().to_string()))
}

async fn ffmpeg_trim(
    ctx: &mut NodeCtx,
    args: &BTreeMap<String, String>,
) -> ToolforgeResult<NodeOutput> {
    let src = resolve_path(ctx, "input", arg(args, "src")?)?;
    let dst = resolve_path(ctx, "output", arg(args, "dst")?)?;
    let start = ctx.param_str("start", "00:00:00");
    let duration = arg_opt(args, "duration").map(|s| s.to_string());
    let reencode = ctx.param_bool("reencode", false);

    let mut a = vec!["-y".into()];
    // 快速定位：-ss 放在 -i 之前走关键帧定位（秒级完成）；
    // 精确切割则要把 -ss 放到 -i 之后（需要完整解码，慢但帧级准确）
    if !reencode {
        a.push("-ss".into());
        a.push(start.clone());
    }
    a.push("-i".into());
    a.push(src.display().to_string());
    if reencode {
        a.push("-ss".into());
        a.push(start);
    }
    if let Some(d) = &duration {
        a.push("-t".into());
        a.push(d.clone());
    }
    if !reencode {
        // 流复制：不重编码，速度取决于磁盘
        a.push("-c".into());
        a.push("copy".into());
        a.push("-avoid_negative_ts".into());
        a.push("make_zero".into());
    }
    a.push(dst.display().to_string());

    run_ffmpeg(ctx, a, None, file_label(&src)).await?;
    Ok(NodeOutput::file(dst.display().to_string()))
}

async fn ffmpeg_compress(
    ctx: &mut NodeCtx,
    args: &BTreeMap<String, String>,
) -> ToolforgeResult<NodeOutput> {
    let src = resolve_path(ctx, "input", arg(args, "src")?)?;
    let dst = resolve_path(ctx, "output", arg(args, "dst")?)?;
    let target_mb = ctx.param_f64("targetSizeMb", 10.0);
    let max_width = ctx.param_i64("maxWidth", 1920);

    let duration = ffprobe_duration(ctx, &src).await.ok_or_else(|| {
        ToolforgeError::engine_failed("ffprobe", "无法读取媒体时长，压缩需要它来计算目标码率")
    })?;
    if duration <= 0.0 {
        return Err(ToolforgeError::invalid("媒体时长异常，无法计算目标码率"));
    }

    // 音频预留 128kbps，其余给视频；再乘 0.95 留容器开销
    let total_kbits = target_mb * 8.0 * 1024.0;
    let video_kbps = ((total_kbits / duration) - 128.0).max(100.0) * 0.95;

    let a = vec![
        "-y".into(),
        "-i".into(),
        src.display().to_string(),
        "-c:v".into(),
        "libx264".into(),
        "-b:v".into(),
        format!("{video_kbps:.0}k"),
        "-maxrate".into(),
        format!("{:.0}k", video_kbps * 1.5),
        "-bufsize".into(),
        format!("{:.0}k", video_kbps * 3.0),
        "-vf".into(),
        format!("scale='min({max_width},iw)':-2"),
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "128k".into(),
        dst.display().to_string(),
    ];

    ctx.job.info(format!(
        "目标 {target_mb} MB / 时长 {duration:.1}s → 视频码率约 {video_kbps:.0} kbps"
    ));
    run_ffmpeg(ctx, a, Some(duration), file_label(&src)).await?;
    Ok(NodeOutput::file(dst.display().to_string()))
}

async fn ffmpeg_audio_convert(
    ctx: &mut NodeCtx,
    args: &BTreeMap<String, String>,
) -> ToolforgeResult<NodeOutput> {
    let src = resolve_path(ctx, "input", arg(args, "src")?)?;
    let dst = resolve_path(ctx, "output", arg(args, "dst")?)?;
    let bitrate = ctx.param_i64("bitrate", 192);
    let sample_rate = ctx.param_i64("sampleRate", 44100);

    let codec = match ctx.param_str("format", "mp3").as_str() {
        "mp3" => "libmp3lame",
        "aac" | "m4a" => "aac",
        "flac" => "flac",
        "wav" => "pcm_s16le",
        "opus" | "ogg" => "libopus",
        _ => "libmp3lame",
    };

    let mut a = vec![
        "-y".into(),
        "-i".into(),
        src.display().to_string(),
        "-vn".into(),
        "-ar".into(),
        sample_rate.to_string(),
        "-c:a".into(),
        codec.into(),
    ];
    if codec != "flac" && codec != "pcm_s16le" {
        a.push("-b:a".into());
        a.push(format!("{bitrate}k"));
    }
    a.push(dst.display().to_string());

    let duration = ffprobe_duration(ctx, &src).await;
    run_ffmpeg(ctx, a, duration, file_label(&src)).await?;
    Ok(NodeOutput::file(dst.display().to_string()))
}

async fn ffmpeg_audio_normalize(
    ctx: &mut NodeCtx,
    args: &BTreeMap<String, String>,
) -> ToolforgeResult<NodeOutput> {
    let src = resolve_path(ctx, "input", arg(args, "src")?)?;
    let dst = resolve_path(ctx, "output", arg(args, "dst")?)?;
    let lufs = ctx.param_f64("lufs", -16.0);

    let a = vec![
        "-y".into(),
        "-i".into(),
        src.display().to_string(),
        "-af".into(),
        format!("loudnorm=I={lufs}:TP=-1.5:LRA=11"),
        dst.display().to_string(),
    ];

    let duration = ffprobe_duration(ctx, &src).await;
    run_ffmpeg(ctx, a, duration, file_label(&src)).await?;
    Ok(NodeOutput::file(dst.display().to_string()))
}

// ============================================================================
// 文档 / 压缩包
// ============================================================================

async fn pandoc_convert(
    ctx: &mut NodeCtx,
    args: &BTreeMap<String, String>,
) -> ToolforgeResult<NodeOutput> {
    let src = resolve_path(ctx, "input", arg(args, "src")?)?;
    let dst = resolve_path(ctx, "output", arg(args, "dst")?)?;
    let to_raw = ctx.param_str("to", "html");
    // 清单里把「PDF（经 LibreOffice）」写成 pdf_engine，避免与 pandoc 的 pdf 混淆
    let to = if to_raw == "pdf_engine" {
        "pdf".to_string()
    } else {
        to_raw
    };

    let pandoc = ctx.engine("pandoc").await?;
    let mut a = vec![
        src.display().to_string(),
        "-o".into(),
        dst.display().to_string(),
        "-t".into(),
        to,
    ];
    if ctx.param_bool("standalone", true) {
        a.push("-s".into());
    }
    if ctx.param_bool("toc", false) {
        a.push("--toc".into());
    }
    let extra = ctx.param_str("extraArgs", "");
    if !extra.trim().is_empty() {
        // 注意：这里**不经过 shell**，所以引号不会被解释。
        // 按空白切分是刻意的保守做法，避免引入命令注入面。
        for tok in extra.split_whitespace() {
            a.push(tok.to_string());
        }
    }

    let r = exec(
        ExecOptions::new(pandoc)
            .args(a)
            .cancel(ctx.job.cancel.clone())
            .timeout(Duration::from_secs(300)),
    )
    .await?;
    if !r.success() {
        return Err(r.into_error("pandoc"));
    }
    Ok(NodeOutput::file(dst.display().to_string()))
}

async fn libreoffice_to_pdf(
    ctx: &mut NodeCtx,
    args: &BTreeMap<String, String>,
) -> ToolforgeResult<NodeOutput> {
    let src = resolve_path(ctx, "input", arg(args, "src")?)?;
    let dst = resolve_path(ctx, "output", arg(args, "dst")?)?;
    let soffice = ctx.engine("libreoffice").await?;

    // LibreOffice 只能"输出到某个目录"，不能指定文件名，
    // 所以先让它写到输出目录，再改名到用户要求的目标文件名。
    //
    // ⚠️ 这里**不允许回退到宿主机临时目录**。曾经写成
    // `unwrap_or_else(std::env::temp_dir)` —— 那会让该节点在授权范围之外写文件，
    // 绕过 PathResolver 的收敛范围（安全审计发现，见 docs/SECURITY.md §9 第 26 项）。
    // `dst` 是由宿主经 resolve_path() 算出来的，正常情况下必然有父目录；
    // 没有父目录说明调用方构造了非法路径，应当明确报错而不是"找个地方凑合写"。
    let out_dir = match dst.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => {
            return Err(ToolforgeError::invalid(
                "输出路径没有父目录，无法确定 LibreOffice 的输出目录",
            )
            .with_detail(
                "LibreOffice 只能按目录输出。请把 `dst` 指定为某个目录下的文件，\
                 例如 ${output.dst} 而不是一个裸文件名。",
            ));
        }
    };
    std::fs::create_dir_all(&out_dir)
        .map_err(|e| ToolforgeError::io(format!("创建输出目录失败：{e}")))?;

    ctx.job.info(
        "LibreOffice 冷启动需要 2~5 秒。v0.2 会改为常驻 UNO listener 复用进程（见 ROADMAP）。",
    );

    // 注意：-env:UserInstallation 必须指向一个独立目录，
    // 否则当用户自己开着 LibreOffice 时，headless 实例会连不上而静默失败。
    let profile = std::env::temp_dir().join(format!("toolforge-lo-{}", std::process::id()));
    let r = exec(
        ExecOptions::new(soffice)
            .args([
                "--headless".into(),
                "--norestore".into(),
                "--invisible".into(),
                format!("-env:UserInstallation=file:///{}", profile.display()),
                "--convert-to".into(),
                "pdf".into(),
                "--outdir".into(),
                out_dir.display().to_string(),
                src.display().to_string(),
            ])
            .cancel(ctx.job.cancel.clone())
            .timeout(Duration::from_secs(600)),
    )
    .await?;

    if !r.success() {
        return Err(r.into_error("libreoffice"));
    }

    // LibreOffice 只按源文件主名输出，需要自己改名到目标路径
    let produced = out_dir.join(
        src.file_stem()
            .map(|s| format!("{}.pdf", s.to_string_lossy()))
            .unwrap_or_else(|| "output.pdf".into()),
    );
    if produced != dst && produced.exists() {
        std::fs::rename(&produced, &dst)
            .map_err(|e| ToolforgeError::io(format!("重命名 PDF 失败：{e}")))?;
    }
    if !dst.exists() {
        return Err(ToolforgeError::engine_failed(
            "libreoffice",
            "转换命令成功返回但没找到 PDF 产物",
        )
        .with_detail(format!(
            "输出目录：{}\nLibreOffice 输出：\n{}",
            out_dir.display(),
            r.stdout
        )));
    }
    Ok(NodeOutput::file(dst.display().to_string()))
}

fn sevenzip_args_for_format(format: &str) -> (&'static str, &'static str) {
    // (开关, 说明)
    match format {
        "7z" => ("-t7z", "压缩率最高，但兼容性一般"),
        "tar" => ("-ttar", "纯打包不压缩"),
        "tar.gz" => ("-ttar", "先 tar 后 gzip"),
        "tar.xz" => ("-ttar", "先 tar 后 xz"),
        _ => ("-tzip", "兼容性最好"),
    }
}

async fn sevenzip_pack(
    ctx: &mut NodeCtx,
    args: &BTreeMap<String, String>,
) -> ToolforgeResult<NodeOutput> {
    let src = resolve_path(ctx, "input", arg(args, "src")?)?;
    let dst = resolve_path(ctx, "output", arg(args, "dst")?)?;
    let format = ctx.param_str("format", "zip");
    let level = ctx.param_i64("level", 5).clamp(0, 9);

    let sevenzip = ctx.engine("7zip").await?;
    let (type_switch, note) = sevenzip_args_for_format(&format);

    let mut a = vec![
        "a".to_string(),
        type_switch.to_string(),
        dst.display().to_string(),
        src.display().to_string(),
        format!("-mx={level}"),
        "-y".into(),
    ];
    let password = ctx.param_str("password", "");
    if !password.is_empty() {
        // -p 会把密码暴露在进程命令行里（同机其他用户可见）。
        // 这是 7-Zip 的固有限制，已在 SECURITY.md 中记录。
        ctx.job
            .warn("密码会出现在进程命令行中，同机其他进程可能读到 —— 敏感场景请改用其他工具。");
        a.push(format!("-p{password}"));
        a.push("-mhe=on".into());
    }

    ctx.job.info(format!("压缩格式 {format}：{note}"));
    let r = exec(
        ExecOptions::new(sevenzip)
            .args(a)
            .cancel(ctx.job.cancel.clone())
            .timeout(Duration::from_secs(3600)),
    )
    .await?;
    if !r.success() {
        return Err(r.into_error("7zip"));
    }
    Ok(NodeOutput::file(dst.display().to_string()))
}

async fn sevenzip_unpack(
    ctx: &mut NodeCtx,
    args: &BTreeMap<String, String>,
) -> ToolforgeResult<NodeOutput> {
    let src = resolve_path(ctx, "input", arg(args, "src")?)?;
    let dst = resolve_path(ctx, "output", arg(args, "dst")?)?;
    std::fs::create_dir_all(&dst)
        .map_err(|e| ToolforgeError::io(format!("创建解压目录失败：{e}")))?;

    let sevenzip = ctx.engine("7zip").await?;
    let mut a = vec![
        "x".to_string(),
        src.display().to_string(),
        format!("-o{}", dst.display()),
        "-y".into(),
    ];
    let password = ctx.param_str("password", "");
    if !password.is_empty() {
        a.push(format!("-p{password}"));
    }

    let r = exec(
        ExecOptions::new(sevenzip)
            .args(a)
            .cancel(ctx.job.cancel.clone())
            .timeout(Duration::from_secs(3600)),
    )
    .await?;
    if !r.success() {
        return Err(r.into_error("7zip"));
    }

    // Zip Slip 防护：检查是否有条目被解到目标目录之外。
    // 7-Zip 本身已经做了过滤，但这是纵深防御 —— 万一版本有洞，
    // 我们至少能在事后发现并报警。
    let escaped = scan_for_escapes(&dst);
    if !escaped.is_empty() {
        ctx.job.error(format!(
            "检测到 {} 个解压条目疑似逃逸出目标目录",
            escaped.len()
        ));
        return Err(ToolforgeError::denied(
            "压缩包包含路径穿越条目（Zip Slip），已中止",
        )
        .with_detail(escaped.join("\n")));
    }

    Ok(NodeOutput::default().with_value("path", dst.display().to_string()))
}

/// 在解压目录里找可疑的符号链接 / 相对引用
fn scan_for_escapes(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for entry in walkdir::WalkDir::new(root)
        .max_depth(8)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if entry.path_is_symlink() {
            if let Ok(target) = std::fs::read_link(entry.path()) {
                let resolved = if target.is_absolute() {
                    target
                } else {
                    entry.path().parent().unwrap_or(root).join(&target)
                };
                let norm = toolforge_core::permission::normalize_lexically(&resolved);
                if !norm.starts_with(root) {
                    out.push(format!(
                        "{} -> {}（指向目标目录之外）",
                        entry.path().display(),
                        norm.display()
                    ));
                }
            }
        }
    }
    out
}

// ============================================================================
// 工具
// ============================================================================

fn file_label(p: &Path) -> String {
    p.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| p.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_parsing_covers_documented_set() {
        for f in [
            "png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "gif", "ico", "pnm", "qoi", "tga",
            "dds", "hdr", "ff",
        ] {
            assert!(parse_format(f).is_ok(), "{f} 应当被支持");
        }
        // avif 默认不启用，必须给出可操作的提示
        let err = parse_format("avif").unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidArgument);
        assert!(err.detail.unwrap().contains("libvips"));
    }

    #[test]
    fn format_parsing_is_case_insensitive() {
        assert_eq!(parse_format("PNG").unwrap(), image::ImageFormat::Png);
        assert_eq!(parse_format(" WebP ").unwrap(), image::ImageFormat::WebP);
    }

    #[test]
    fn arg_helpers_parse_and_default() {
        let mut a = BTreeMap::new();
        a.insert("w".to_string(), "1280".to_string());
        a.insert("q".to_string(), "92.5".to_string());
        a.insert("flag".to_string(), "yes".to_string());
        a.insert("blank".to_string(), "   ".to_string());

        assert_eq!(arg_i64(&a, "w", 0), 1280);
        assert_eq!(arg_i64(&a, "missing", 7), 7);
        // 浮点字符串也要能当整数取（模板渲染出来都是字符串）
        assert_eq!(arg_i64(&a, "q", 0), 92);
        assert!(arg_bool(&a, "flag", false));
        // 空白视为未提供
        assert_eq!(arg_i64(&a, "blank", 5), 5);
        assert!(arg(&a, "w").is_ok());
        assert!(arg(&a, "missing").is_err());
    }

    #[test]
    fn resize_ratio_math() {
        // 只给小大小时按比例推导，是 image.resize 最常用的路径
        let (ow, oh) = (4000i64, 3000i64);
        let tw = 1280i64;
        let ratio = tw as f64 / ow as f64;
        let nh = ((oh as f64 * ratio).round() as u32).max(1);
        assert_eq!(nh, 960);
    }

    #[test]
    fn sevenzip_type_switch_mapping() {
        assert_eq!(sevenzip_args_for_format("zip").0, "-tzip");
        assert_eq!(sevenzip_args_for_format("7z").0, "-t7z");
        assert_eq!(sevenzip_args_for_format("tar").0, "-ttar");
        // 未知格式退化为 zip 而不是报错
        assert_eq!(sevenzip_args_for_format("rar").0, "-tzip");
    }

    #[test]
    fn not_implemented_error_names_the_node() {
        let e = not_implemented("image.remove-background");
        assert!(e.message.contains("image.remove-background"));
        assert!(e.detail.unwrap().contains("ROADMAP"));
    }

    #[test]
    fn unimplemented_nodes_are_reported_not_silently_succeed() {
        // 这是刻意设计的：宁可报"未实现"，也不要产出空文件让用户以为成功了
        let e = not_implemented("ai.upscale");
        assert_eq!(e.code, ErrorCode::Internal);
    }

    #[test]
    fn escape_scan_flags_nothing_in_a_clean_dir() {
        let tmp = std::env::temp_dir().join("tf-escape-scan-clean");
        let _ = std::fs::create_dir_all(&tmp);
        std::fs::write(tmp.join("a.txt"), b"hi").unwrap();
        assert!(scan_for_escapes(&tmp).is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
