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
    /// 流水线变量（`flow.set-var` 写入，可在后续步骤用 `${vars.名称}` 引用）
    pub vars: HashMap<String, String>,
    /// **当前步骤的 `with` 块**，由 [`run`] 在每次调用前设置。
    ///
    /// 它存在的理由是一个真实踩过的坑：节点参数到底该写在 `with` 里还是
    /// `io.params` 里？插件作者（以及 LLM）的直觉是前者，而执行器原本只读后者 ——
    /// 于是 `with: { format: webp }` 被**静默忽略**，用户得到的是默认格式。
    /// 现在 `param_*` 取值时先看 `with`、再看用户参数：两种写法都对，
    /// 且 `with` 里的显式字面量优先（它更具体）。
    pub arg_scope: BTreeMap<String, String>,
    /// 本批次是批量的第几项（1-based）。非批量时为 1。
    ///
    /// 批量由命令层扇出，**节点自己不知道"我跑了几次"**。而"给每个文件编号"
    /// 是最常见的重命名需求，所以把它带进来，让 `name.build` 的
    /// `index: "batch"` 能取到它。
    pub batch_index: u32,
    /// 本批次总项数
    pub batch_total: u32,
}

impl NodeCtx {
    /// 取字符串：`with` 优先，其次用户参数，最后默认值。
    pub fn param_str(&self, key: &str, default: &str) -> String {
        if let Some(v) = self.arg_scope.get(key) {
            if !v.trim().is_empty() {
                return v.clone();
            }
        }
        self.params
            .get(key)
            .and_then(|v| param_to_string(v).into())
            .unwrap_or_else(|| default.to_string())
    }

    pub fn param_i64(&self, key: &str, default: i64) -> i64 {
        if let Some(v) = self.arg_scope.get(key) {
            if let Some(n) = parse_int(v) {
                return n;
            }
        }
        self.params
            .get(key)
            .and_then(|v| v.as_i64())
            .unwrap_or(default)
    }

    pub fn param_f64(&self, key: &str, default: f64) -> f64 {
        if let Some(v) = self.arg_scope.get(key) {
            if let Ok(n) = v.trim().parse::<f64>() {
                return n;
            }
        }
        self.params
            .get(key)
            .and_then(|v| v.as_f64())
            .unwrap_or(default)
    }

    pub fn param_bool(&self, key: &str, default: bool) -> bool {
        if let Some(v) = self.arg_scope.get(key) {
            return truthy(v);
        }
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

/// `ParamValue` → 字符串（模板上下文与 `with` 回退都用它）
pub fn param_to_string(v: &ParamValue) -> String {
    match v {
        ParamValue::Str(s) => s.clone(),
        ParamValue::Int(i) => i.to_string(),
        ParamValue::Float(f) => {
            // 整数值不要显示成 "90.0"，那会让用户困惑
            if f.fract().abs() < f64::EPSILON {
                format!("{}", *f as i64)
            } else {
                f.to_string()
            }
        }
        ParamValue::Bool(b) => b.to_string(),
        ParamValue::List(l) => l.join(","),
    }
}

fn parse_int(s: &str) -> Option<i64> {
    let t = s.trim();
    t.parse::<i64>()
        .ok()
        .or_else(|| t.parse::<f64>().ok().map(|f| f as i64))
}

fn truthy(s: &str) -> bool {
    matches!(
        s.trim().to_ascii_lowercase().as_str(),
        "true" | "1" | "yes" | "on"
    )
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

/// 把逻辑路径（`/output/x.png` 或相对路径）解析成真实路径。
///
/// ## 这是两层防护的交汇点，两层都必须过
///
/// 1. **能力裁决**（[`CapabilityGuard::check`]）：插件有没有声明并获授权做这类
///    访问（"能读文件吗"）。
/// 2. **路径收敛**（[`PathResolver::resolve`]）：这次具体访问是否落在授权目录内、
///    有没有穿越（"这个文件能碰吗"）。
///
/// ⚠️ 第 1 层曾经**从未被调用** —— `CapabilityGuard` 在 `l1.rs` 里被构造、
/// 塞进 `NodeCtx.guard`，然后就再也没人碰过它；所有 `check()` 调用点都在
/// `permission.rs` 自己的单测里。也就是说 README 与 SECURITY.md 里宣称的
/// "运行时逐请求裁决"当时是**布线完成但没接线**，真正生效的只有第 2 层。
///
/// 现在每一次文件访问都必须先过 `check()`。越权会返回
/// [`ErrorCode::PluginCapabilityViolation`]，并由 `l1.rs` 记进审计日志 ——
/// **能力模型的价值就在于"代码里出现没声明的能力调用会被抓住"，而抓住它的
/// 正是这一行**。
fn resolve_path(ctx: &NodeCtx, scope_kind: &str, p: &str) -> ToolforgeResult<PathBuf> {
    use toolforge_core::permission::{CapabilityRequest, CapabilityVerdict, PathScope};

    let scope = match scope_kind {
        "input" => PathScope::Input,
        "output" => PathScope::Output,
        "data" => PathScope::PluginData,
        _ => PathScope::Workspace,
    };

    // ---- 第 1 层：能力裁决 ----
    // 读输入端口算读、其余（输出/工作区/插件数据）算写。
    // 这个映射与节点目录里 `io` 的语义一致：input 是只读来源，
    // output/work/data 是可写目标。
    let request = if matches!(scope, PathScope::Input) {
        CapabilityRequest::ReadFile {
            path: p.to_string(),
        }
    } else {
        CapabilityRequest::WriteFile {
            path: p.to_string(),
        }
    };

    if let CapabilityVerdict::Deny { code, reason } = ctx.guard.check(&request) {
        return Err(ToolforgeError::new(code, reason).with_subject(ctx.guard.plugin_id()));
    }

    // ---- 第 2 层：路径收敛 ----
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
    // 把本步骤的 `with` 挂到上下文上：`param_*` 取值时先看它、再看用户参数。
    // 见 `NodeCtx::arg_scope` 的文档 —— 这一步让"参数写在 with 里"也能生效。
    ctx.arg_scope = args.clone();

    match node {
        // ---------- 文件 ----------
        "fs.copy" => fs_copy(ctx, args, false).await,
        "fs.move" => fs_copy(ctx, args, true).await,
        "fs.mkdir" => fs_mkdir(ctx, args).await,
        "fs.delete" => fs_delete(ctx, args).await,

        // ---------- 图片 ----------
        // 前五个按 libvips → ImageMagick → 纯 Rust 降级（见 `pick_image_backend`）；
        // 后三个（enhance / strip-metadata）目前只有纯 Rust 路径。
        "image.probe" => image_probe(ctx, args).await,
        "image.convert" => image_convert(ctx, args).await,
        "image.resize" => image_resize(ctx, args).await,
        "image.crop" => image_crop(ctx, args).await,
        "image.rotate" => image_rotate(ctx, args).await,
        "image.enhance" => image_enhance(ctx, args).await,
        "image.strip-metadata" => image_strip_metadata(ctx, args).await,
        // ONNX 推理，走独立 Python venv（见 `ensure_onnx_runtime`）
        "image.remove-background" => image_remove_background(ctx, args).await,

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

        // ---------- 文本 / 命名（纯计算）----------
        "text.replace" => text_replace(ctx).await,
        "name.build" => name_build(ctx).await,

        // ---------- 流程控制 ----------
        "flow.log" => flow_log(ctx).await,
        "flow.set-var" => flow_set_var(ctx, args).await,
        "flow.branch" => flow_branch(ctx).await,

        // ---------- 尚未实现（v0.1 明确不支持，见 docs/ROADMAP.md）----------
        other => Err(not_implemented(other)),
    }
}

/// 统一的"未实现"错误。
///
/// 刻意**不返回假的成功**：插件作者与用户都必须立刻知道这个能力还没做，
/// 否则会出现"流水线显示跑通了但没产出文件"这种最难排查的问题。
///
/// ⚠️ 判定走 [`toolforge_core::pipeline::UNIMPLEMENTED_NODES`]（唯一真相来源），
/// 而不是在这里另抄一份名单。有一条测试
/// （`unimplemented_list_matches_actual_dispatch`）会遍历节点目录，
/// 断言"名单里的节点确实走这个分支、名单外的不走"—— 所以实现完一个节点后
/// 忘了从名单里删掉它，测试会立刻红。
fn not_implemented(node: &str) -> ToolforgeError {
    debug_assert!(
        !toolforge_core::pipeline::is_implemented(node),
        "`{node}` 已从 UNIMPLEMENTED_NODES 里移除，但分发表里仍没有它的实现 —— \
         要么补上实现，要么把它加回名单"
    );
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
    // 值优先取 with 里的字面量，其次取同名用户参数 ——
    // 与其它节点一致，避免"参数写在哪"变成需要记住的隐规则
    let value = ctx.param_str("value", "");
    if value.is_empty() {
        return Err(ToolforgeError::plugin_invalid(
            "flow.set-var 需要 `value`（写在 with 里或作为用户参数）",
        ));
    }
    ctx.vars.insert(name.to_string(), value.clone());
    // 同时把值放进本步骤的产出，这样 `${steps.<id>.value}` 也能引用
    Ok(NodeOutput::value("value", value))
}

// ============================================================================
// 文本 / 命名节点（纯计算）
//
// 这一族节点补的是 L1 的一个**结构性**短板：原来没有任何节点能"算出一个值" ——
// 所有节点要么读写文件、要么调外部引擎。于是"批量重命名"这种
// "按规则算出新文件名"的需求无法用声明式表达，
// `plugins/builtin/batch-rename` 就退化成了一句 `fs.move`，
// 声明的 regex / 前缀 / 后缀 / 序号参数**全是装饰**（实际只把文件挪了个位置，
// 文件名一点没变）。
//
// 加这两个节点之后，命名规则可以被完整地声明出来。
// ============================================================================

/// `text.replace`：查找替换，支持正则与大小写控制。
///
/// **空 `pattern` 视为"不替换"，原样返回**，并写一条 warn 日志。
/// 为什么不报错：`"pattern 留空 = 不做替换"` 是清单里很自然的写法
/// （用户可能只想加个前缀），逼作者用 `when` 去判断会引入一个更脆的东西 ——
/// 模板条件表达式对含 `!=` 的模式会解析错。而"什么都不做"必须**可见**，
/// 所以留一条日志而不是静默通过。
async fn text_replace(ctx: &mut NodeCtx) -> ToolforgeResult<NodeOutput> {
    let input = ctx.param_str("input", "");
    let pattern = ctx.param_str("pattern", "");
    if pattern.is_empty() {
        ctx.job.log(
            toolforge_core::job::LogLevel::Debug,
            "text.replace：pattern 为空，未做替换（原样返回）".to_string(),
        );
        return Ok(NodeOutput::value("text", input));
    }
    let replacement = ctx.param_str("replacement", "");
    let use_regex = ctx.param_bool("useRegex", true);
    let case_sensitive = ctx.param_bool("caseSensitive", true);
    let replace_all = ctx.param_bool("all", true);

    let out = if use_regex {
        let mut builder = regex::RegexBuilder::new(&pattern);
        builder.case_insensitive(!case_sensitive);
        // 不让 `.` 匹配换行 —— 文件名里本来也没有换行，但输入可能是一整段文本
        builder.dot_matches_new_line(false);
        let re = builder.build().map_err(|e| {
            ToolforgeError::plugin_invalid(format!("text.replace 的正则非法：{pattern}"))
                .with_detail(e.to_string())
        })?;
        if replace_all {
            re.replace_all(&input, replacement.as_str()).to_string()
        } else {
            re.replace(&input, replacement.as_str()).to_string()
        }
    } else if case_sensitive {
        if replace_all {
            input.replace(&pattern, &replacement)
        } else {
            input.replacen(&pattern, &replacement, 1)
        }
    } else {
        // 字面量 + 忽略大小写：regex::escape 之后走正则路径，避免自己写一遍大小写折叠
        let mut builder = regex::RegexBuilder::new(&regex::escape(&pattern));
        builder.case_insensitive(true);
        let re = builder
            .build()
            .map_err(|e| ToolforgeError::internal(format!("正则构造失败（不该发生）：{e}")))?;
        if replace_all {
            re.replace_all(&input, replacement.as_str()).to_string()
        } else {
            re.replace(&input, replacement.as_str()).to_string()
        }
    };

    Ok(NodeOutput::value("text", out))
}

/// `name.build`：拼装文件名（不含目录）。
///
/// 输出是**相对路径**，所以接到 `fs.move` 的 `dst` 上时，
/// 宿主会把它解析到本次任务的输出目录内 —— 既能完成重命名，
/// 又不会绕过路径收敛。
async fn name_build(ctx: &mut NodeCtx) -> ToolforgeResult<NodeOutput> {
    let stem = ctx.param_str("stem", "");
    if stem.trim().is_empty() {
        return Err(ToolforgeError::plugin_invalid(
            "name.build 的 `stem` 不能为空（通常写 `${src.stem}`）",
        ));
    }
    let ext = ctx.param_str("ext", "");
    let prefix = ctx.param_str("prefix", "");
    let suffix = ctx.param_str("suffix", "");
    // `index` 可以是数字，也可以是 `batch` —— 后者取本批次的序号。
    //
    // 为什么要支持字符串：清单里表达"要不要编号"最自然的方式是给一个 enum
    // （`indexMode: none | batch`），而 enum 渲染出来是字符串。
    // 让节点认这个伪值，比逼清单去写条件表达式干净得多。
    let index_raw = ctx.param_str("index", "0");
    let index = if index_raw.trim().eq_ignore_ascii_case("batch") {
        ctx.batch_index as i64
    } else {
        parse_int(&index_raw).unwrap_or(0)
    };
    let pad = ctx.param_i64("indexPad", 3).clamp(0, 12) as usize;
    let sep = ctx.param_str("indexSeparator", "-");
    let position = ctx.param_str("indexPosition", "suffix");
    let case = ctx.param_str("case", "keep");
    let separator = ctx.param_str("separator", "");

    let mut body = stem;

    // 空格等替换成指定字符（把「我的 报告.pdf」变成「我的_报告.pdf」这类需求）
    if !separator.is_empty() {
        let mut out = String::with_capacity(body.len());
        let mut last_was_sep = false;
        for c in body.chars() {
            // 空白与一批常见的文件系统敏感字符一起归一化
            let is_sep = c.is_whitespace() || matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|');
            if is_sep {
                if !last_was_sep {
                    out.push_str(&separator);
                }
                last_was_sep = true;
            } else {
                last_was_sep = false;
                out.push(c);
            }
        }
        // 去掉首尾分隔符，避免「_报告_.pdf」
        let trimmed = out.trim_matches(|c: char| separator.contains(c)).to_string();
        body = if trimmed.is_empty() { out } else { trimmed };
    }

    if index > 0 {
        let numbered = format!("{}{:0width$}", "", index, width = pad);
        body = if position == "prefix" {
            format!("{numbered}{sep}{body}")
        } else {
            format!("{body}{sep}{numbered}")
        };
    }

    let mut name = format!("{prefix}{body}{suffix}");
    name = match case.as_str() {
        "lower" => name.to_lowercase(),
        "upper" => name.to_uppercase(),
        "title" => name
            .split_inclusive(|c: char| c == ' ' || c == '-' || c == '_')
            .map(|word| {
                let mut cs = word.chars();
                match cs.next() {
                    Some(first) => first.to_uppercase().collect::<String>() + cs.as_str(),
                    None => String::new(),
                }
            })
            .collect(),
        _ => name,
    };

    // 扩展名归一：调用方可能写成 "png"、".png" 或 ""（没有扩展名）
    let ext = ext.trim();
    let ext = if ext.is_empty() {
        String::new()
    } else if ext.starts_with('.') {
        ext.to_string()
    } else {
        format!(".{ext}")
    };

    // 文件名里不允许出现路径分隔符 —— 否则就成了"改写到别的目录"，
    // 虽然 PathResolver 仍会拦住逃逸，但在这里挡掉能给出更清楚的错误
    let final_name = format!("{name}{ext}");
    if final_name.contains('/') || final_name.contains('\\') {
        return Err(ToolforgeError::plugin_invalid(
            "name.build 的结果里出现了路径分隔符 —— 它只能生成文件名，不能生成路径",
        )
        .with_detail(format!("实际结果：{final_name}")));
    }
    if final_name.trim().is_empty() || final_name == ext {
        return Err(ToolforgeError::plugin_invalid(
            "name.build 拼出的文件名为空（检查 stem / prefix / suffix 参数）",
        ));
    }

    Ok(NodeOutput::value("value", final_name))
}

/// `flow.log`：向任务日志写一条消息。
///
/// **曾经是静默空实现**（直接返回空的 `NodeOutput`，不报错也不做事）——
/// 那种行为最难排查：用户以为日志节点在跑，任务日志里却什么都没有。
async fn flow_log(ctx: &mut NodeCtx) -> ToolforgeResult<NodeOutput> {
    let message = ctx.param_str("message", "");
    if message.trim().is_empty() {
        return Err(ToolforgeError::plugin_invalid(
            "flow.log 缺少 `message`",
        ));
    }
    let level = ctx.param_str("level", "info");
    match level.to_ascii_lowercase().as_str() {
        "debug" | "trace" => ctx.job.log(toolforge_core::job::LogLevel::Debug, message.clone()),
        "warn" | "warning" => ctx.job.warn(message.clone()),
        "error" => ctx.job.error(message.clone()),
        _ => ctx.job.info(message.clone()),
    }
    Ok(NodeOutput::value("message", message))
}

/// `flow.branch`：求值条件，把结果写进 `${steps.<id>.active}`。
///
/// **刻意不做隐式控制流**：它不会去"跳过某些步骤"，只是产出一个布尔值，
/// 由后续步骤自己用 `when: ${steps.<id>.active} == true` 消费。
/// 隐式分支是调试噩梦 —— 你无法从单个步骤的定义看出它会不会被执行。
///
/// 曾经也是静默空实现，同样已修。
async fn flow_branch(ctx: &mut NodeCtx) -> ToolforgeResult<NodeOutput> {
    let condition = ctx.param_str("condition", "");
    if condition.trim().is_empty() {
        return Err(ToolforgeError::plugin_invalid(
            "flow.branch 缺少 `condition`",
        ));
    }
    // 这里的 condition 已经在流水线执行器里渲染过模板（它来自 with 或参数），
    // 所以直接按"真值字面量"判断即可，不再二次求值。
    let active = truthy(&condition) || (!is_falsey_literal(&condition) && !condition.trim().is_empty());
    let value = if active { "true" } else { "false" };
    ctx.job
        .log(toolforge_core::job::LogLevel::Debug, format!("分支判定：{condition} → {value}"));
    Ok(NodeOutput::value("active", value))
}

fn is_falsey_literal(s: &str) -> bool {
    matches!(
        s.trim().to_ascii_lowercase().as_str(),
        "false" | "0" | "no" | "off"
    )
}

// ============================================================================
// 图片节点 —— 三层后端
// ============================================================================

/// 图片处理实际使用的后端。
///
/// ## 为什么要有这个东西
///
/// `lib.rs` 的模块文档里画着一张"libvips → ImageMagick → 纯 Rust"的三层降级图，
/// 而**在这之前那张图是假的**：`image.*` 一族全部走纯 Rust 的 `image` crate，
/// libvips 与 ImageMagick 只是安静地登记在引擎目录里，没有一行代码去调它们。
///
/// 后果很具体：WebP 只能无损编码，一张 4K 照片转出来的 `.webp` **比 `.jpg` 还大**，
/// 而 `image.convert` 只能写一句 warn 建议用户"装 libvips 会更好" ——
/// 装了也不会更好，因为没人调它。
///
/// 现在真的会调了，并且**把用的是哪个后端报出去**（节点输出里的 `backend`、
/// 以及一条 debug 日志）。理由：后端选择一旦不可观测，"到底走没走 libvips"
/// 就只能靠猜 —— 而这个项目已经被"文档说有、实际没有"坑过好几次。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageBackend {
    /// libvips：快、省内存，大图首选
    Vips,
    /// ImageMagick：格式覆盖最全
    Magick,
    /// 纯 Rust `image` crate：零依赖，永远可用，但能力最弱
    Rust,
}

impl ImageBackend {
    fn label(self) -> &'static str {
        match self {
            ImageBackend::Vips => "libvips",
            ImageBackend::Magick => "imagemagick",
            ImageBackend::Rust => "rust",
        }
    }

    fn describe(self) -> &'static str {
        match self {
            ImageBackend::Vips => "libvips（快、省内存）",
            ImageBackend::Magick => "ImageMagick（格式最全）",
            ImageBackend::Rust => "纯 Rust image crate（零依赖，能力受限）",
        }
    }

    /// 输出文件名里用的后端标识（会写进节点输出，供流程后续步骤引用）
    fn id(self) -> &'static str {
        self.label()
    }
}

/// 挑一个后端 —— **顺序就是文档里那张图**。
///
/// 每次调用都会问一遍引擎注册表；`is_available` 读的是带缓存的状态，
/// 不会每个文件都去 spawn 一个 `vips --version`。
async fn pick_image_backend(ctx: &NodeCtx) -> ImageBackend {
    if ctx.engines.is_available("libvips").await {
        return ImageBackend::Vips;
    }
    if ctx.engines.is_available("imagemagick").await {
        return ImageBackend::Magick;
    }
    ImageBackend::Rust
}

/// 跑一次 libvips 命令。失败时把 vips 自己的 stderr 原样带出来 ——
/// vips 的报错信息质量很高（会指出是哪个 saver 的哪个 option 不认），
/// 丢掉它等于让用户自己猜。
async fn run_vips(ctx: &NodeCtx, args: Vec<String>) -> ToolforgeResult<()> {
    let vips = ctx.engine("libvips").await?;
    let result = toolforge_process::exec(
        ExecOptions::new(vips)
            .args(args)
            .cancel(ctx.job.cancel.clone())
            .timeout(Duration::from_secs(3600))
            .quiet(true),
    )
    .await?;
    if !result.success() {
        return Err(result.into_error("libvips"));
    }
    Ok(())
}

/// 跑一次 ImageMagick。
///
/// `magick` 是 IM7 的统一入口；IM6 只有 `convert`，所以 `MANAGED_LAYOUT`
/// 与系统探测都找 `magick`，找不到就说明这台机器没有可用的 IM7。
async fn run_magick(ctx: &NodeCtx, args: Vec<String>) -> ToolforgeResult<()> {
    let magick = ctx.engine("imagemagick").await?;
    let result = toolforge_process::exec(
        ExecOptions::new(magick)
            .args(args)
            .cancel(ctx.job.cancel.clone())
            .timeout(Duration::from_secs(3600))
            .quiet(true),
    )
    .await?;
    if !result.success() {
        return Err(result.into_error("imagemagick"));
    }
    Ok(())
}

/// libvips 保存选项：按目标格式给不同的参数。
///
/// 这里必须**按格式分派**，不能无脑塞 `Q=`：PNG 的 saver 虽然也接受 `Q`，
/// 但它的含义与 JPEG/WebP 完全不同（PNG 的 `Q` 是量化质量，会直接损毁照片），
/// 而无损格式（bmp / tiff / gif）根本不认这个 option，传了会直接报错。
fn vips_save_option(fmt: &str, quality: u8) -> Option<String> {
    match fmt.trim().trim_start_matches('.').to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" | "webp" | "avif" | "heic" | "heif" => Some(format!("Q={quality}")),
        // PNG：用压缩级别（0-9）。9 最慢但最小，对"转换"这个动作是合理的默认。
        "png" => Some("compression=9".into()),
        _ => None,
    }
}

fn magick_quality_flag(fmt: &str) -> bool {
    matches!(
        fmt.trim().trim_start_matches('.').to_ascii_lowercase().as_str(),
        "jpg" | "jpeg" | "webp" | "avif" | "heic" | "heif" | "tif" | "tiff"
    )
}

fn file_ext(p: &Path) -> String {
    p.extension()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
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
    let format_str = ctx.param_str("format", "webp");
    let fmt = parse_format(&format_str)?;
    let quality = ctx.param_i64("quality", 90).clamp(1, 100) as u8;

    ctx.job
        .progress_now(toolforge_core::job::JobProgress::indeterminate(format!(
            "转换 {}",
            file_label(&src)
        )));

    let backend = pick_image_backend(ctx).await;
    let dst_ext = file_ext(&dst);
    ctx.job.log(
        toolforge_core::job::LogLevel::Debug,
        format!(
            "image.convert：后端 = {}；{} → {}（质量 {quality}）",
            backend.describe(),
            file_label(&src),
            file_label(&dst)
        ),
    );

    match backend {
        ImageBackend::Vips => {
            // vips 的保存选项写在**输出文件名后面的方括号里**：
            // `vips copy in.png "out.webp[Q=90]"`。这是 vips CLI 的约定，
            // 不是什么可选优化 —— 写成命令行参数会被当成输入文件。
            let target = match vips_save_option(&dst_ext, quality) {
                Some(opt) => format!("{}[{opt}]", dst.display()),
                None => dst.display().to_string(),
            };
            run_vips(
                ctx,
                vec!["copy".into(), src.display().to_string(), target],
            )
            .await?;
        }
        ImageBackend::Magick => {
            let mut a = vec![src.display().to_string()];
            if magick_quality_flag(&dst_ext) {
                a.push("-quality".into());
                a.push(quality.to_string());
            }
            a.push(dst.display().to_string());
            run_magick(ctx, a).await?;
        }
        ImageBackend::Rust => {
            if fmt == image::ImageFormat::WebP {
                // 这条 warn 现在**只在真的没有更好的后端时**才出现 ——
                // 以前无论装没装 libvips 都会出现，而装了也没用（没人调它）。
                ctx.job.warn(
                    "纯 Rust 后端的 WebP 编码只有无损模式，文件可能比预期大；\
                     安装 libvips 可获得有损压缩。",
                );
            }
            let img = decode_image(&src)?;
            encode_image(&img, &dst, fmt, quality)?;
        }
    }

    // 后端可能"成功退出但没产出文件"（例如目标目录被删了），
    // 所以这里显式确认一次 —— 报"成功但没有文件"比静默成功好得多。
    if !dst.is_file() {
        return Err(ToolforgeError::engine_failed(
            backend.label(),
            format!("转换结束但没有生成 {}", dst.display()),
        )
        .with_detail("后端进程返回成功，但目标文件不存在。请检查输出目录是否可写。"));
    }

    Ok(NodeOutput::file(dst.display().to_string())
        .with_value("path", dst.display().to_string())
        .with_value("backend", backend.id().to_string()))
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

    let backend = pick_image_backend(ctx).await;
    ctx.job.log(
        toolforge_core::job::LogLevel::Debug,
        format!(
            "image.resize：后端 = {}；{ow}x{oh} → {nw}x{nh}",
            backend.describe()
        ),
    );

    match backend {
        ImageBackend::Vips => {
            // `thumbnail_image` + `--size force` 是唯一能**精确**给出 WxH 的 vips 用法：
            // 不带 `--size force` 时 vips 默认只缩不放（`down`），
            // 于是"把小图放大到 1920"会静默返回原尺寸 —— 而 `image.resize` 的语义
            // 是"就要这个尺寸"（纯 Rust 路径用的就是 `resize_exact`）。
            run_vips(
                ctx,
                vec![
                    "thumbnail_image".into(),
                    src.display().to_string(),
                    dst.display().to_string(),
                    nw.to_string(),
                    "--height".into(),
                    nh.to_string(),
                    "--size".into(),
                    "force".into(),
                ],
            )
            .await?;
        }
        ImageBackend::Magick => {
            // `-resize WxH!` 的 `!` 表示忽略宽高比、强制拉伸 ——
            // 与纯 Rust 的 `resize_exact` 语义一致
            run_magick(
                ctx,
                vec![
                    src.display().to_string(),
                    "-resize".into(),
                    format!("{nw}x{nh}!"),
                    dst.display().to_string(),
                ],
            )
            .await?;
        }
        ImageBackend::Rust => {
            let resized = img.resize_exact(nw, nh, filter);
            let fmt = image::ImageFormat::from_path(&dst)
                .or_else(|_| image::ImageFormat::from_path(&src))
                .map_err(|_| ToolforgeError::invalid("无法从路径推断输出格式，请显式指定扩展名"))?;
            encode_image(&resized, &dst, fmt, 92)?;
        }
    }

    Ok(NodeOutput::file(dst.display().to_string())
        .with_value("width", nw.to_string())
        .with_value("height", nh.to_string())
        .with_value("backend", backend.id().to_string()))
}

async fn image_crop(
    ctx: &mut NodeCtx,
    args: &BTreeMap<String, String>,
) -> ToolforgeResult<NodeOutput> {
    let src = resolve_path(ctx, "input", arg(args, "src")?)?;
    let dst = resolve_path(ctx, "output", arg(args, "dst")?)?;
    let img = decode_image(&src)?;
    let (w, h) = (img.width(), img.height());

    // 先把裁剪矩形算出来（两种 mode 都要用），再决定交给哪个后端。
    // 这样三个后端拿到的是**同一个矩形** —— 否则"切出来的位置不一样"
    // 会变成一个取决于机器装了什么引擎的 bug。
    let (x, y, cw, ch) = match ctx.param_str("mode", "center").as_str() {
        "custom" => {
            let x = ctx.param_i64("x", 0).max(0) as u32;
            let y = ctx.param_i64("y", 0).max(0) as u32;
            let cw = (ctx.param_i64("width", 512).max(1) as u32).min(w.saturating_sub(x));
            let ch = (ctx.param_i64("height", 512).max(1) as u32).min(h.saturating_sub(y));
            (x, y, cw.max(1), ch.max(1))
        }
        // center / smart 都是中心裁剪：smart 的"内容感知"需要 libvips attention，
        // 纯 Rust 路径退化为几何中心裁剪（诚实降级）
        _ => {
            let cw = (ctx.param_i64("width", 512).max(1) as u32).min(w);
            let ch = (ctx.param_i64("height", 512).max(1) as u32).min(h);
            ((w - cw) / 2, (h - ch) / 2, cw, ch)
        }
    };

    let backend = pick_image_backend(ctx).await;
    ctx.job.log(
        toolforge_core::job::LogLevel::Debug,
        format!(
            "image.crop：后端 = {}；{w}x{h} 取 ({x},{y}) {cw}x{ch}",
            backend.describe()
        ),
    );

    match backend {
        ImageBackend::Vips => {
            run_vips(
                ctx,
                vec![
                    "crop".into(),
                    src.display().to_string(),
                    dst.display().to_string(),
                    x.to_string(),
                    y.to_string(),
                    cw.to_string(),
                    ch.to_string(),
                ],
            )
            .await?;
        }
        ImageBackend::Magick => {
            run_magick(
                ctx,
                vec![
                    src.display().to_string(),
                    "-crop".into(),
                    format!("{cw}x{ch}+{x}+{y}"),
                    "+repage".into(),
                    dst.display().to_string(),
                ],
            )
            .await?;
        }
        ImageBackend::Rust => {
            let cropped = img.crop_imm(x, y, cw, ch);
            let fmt = image::ImageFormat::from_path(&dst)
                .map_err(|_| ToolforgeError::invalid("无法从输出路径推断格式"))?;
            encode_image(&cropped, &dst, fmt, 92)?;
        }
    }

    Ok(NodeOutput::file(dst.display().to_string())
        .with_value("width", cw.to_string())
        .with_value("height", ch.to_string())
        .with_value("backend", backend.id().to_string()))
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

    let normalized = ((angle % 360.0) + 360.0) % 360.0;
    let backend = pick_image_backend(ctx).await;
    let right_angle = matches!(normalized as i64, 0 | 90 | 180 | 270);

    // 任意角度需要重采样，纯 Rust 的 `image` crate 做不了 ——
    // 这时必须**明确降级到有能力的后端**，而不是静默取整（取整会让用户
    // 以为"转了 45°"，实际拿到一张没转的图）。
    if !right_angle && backend == ImageBackend::Rust {
        return Err(ToolforgeError::engine_missing("imagemagick").with_detail(format!(
            "纯 Rust 后端只支持 90° 整数倍旋转（当前 {angle}°）。\
             任意角度旋转需要重采样，请到「设置 → 引擎管理」安装 libvips 或 ImageMagick。"
        )));
    }

    ctx.job.log(
        toolforge_core::job::LogLevel::Debug,
        format!(
            "image.rotate：后端 = {}；角度 {angle}°，翻转 H={flip_h} V={flip_v}",
            backend.describe()
        ),
    );

    match backend {
        ImageBackend::Vips => {
            // ⚠️ 这里有两个**实测踩出来的**坑，改之前先看清楚：
            //
            // 1. `vips rot` 的 `VipsAngle` 枚举**只有 d0/d90/d180/d270**，
            //    不接受任意角度。写 `d45` 会直接报
            //    `enum 'VipsAngle' has no member 'd45'`。
            //    任意角度必须用 `vips similarity --angle <度>`（它做的是
            //    旋转 + 缩放 + 平移的仿射变换，正好是"任意角度旋转"需要的）。
            // 2. **没有 `flop` 这个动作**（那是 `vips_image_flop` 的 C API 名字）。
            //    CLI 里只有 `flip`，方向作为**参数**给：
            //    `vips flip in out horizontal|vertical`。
            //
            // 我在写这段代码时两个都猜错了，是靠直接跑 vips 命令行才发现的 ——
            // 所以别凭印象改。
            let (action, extra): (&str, Vec<String>) = if right_angle {
                ("rot", vec![format!("d{}", normalized as i64)])
            } else {
                ("similarity", vec!["--angle".into(), normalized.to_string()])
            };

            // 需要翻转时先落到临时文件，再对它做 flip —— 直接写同一个目标会互相覆盖。
            let needs_flip = flip_h || flip_v;
            let stage = dst.with_extension(format!("stage.{}", file_ext(&dst)));
            let first_target = if needs_flip { stage.clone() } else { dst.clone() };

            let mut a = vec![action.into(), src.display().to_string(), first_target.display().to_string()];
            a.extend(extra);
            run_vips(ctx, a).await?;

            if needs_flip {
                // 两个方向都要时先水平再垂直 —— 两次镜像可交换，顺序无所谓
                let (dir1, dir2) = match (flip_h, flip_v) {
                    (true, true) => (Some("horizontal"), Some("vertical")),
                    (true, false) => (Some("horizontal"), None),
                    _ => (Some("vertical"), None),
                };
                let mid = dst.with_extension(format!("mid.{}", file_ext(&dst)));
                let after_first = if dir2.is_some() { mid.clone() } else { dst.clone() };
                run_vips(
                    ctx,
                    vec![
                        "flip".into(),
                        stage.display().to_string(),
                        after_first.display().to_string(),
                        dir1.unwrap().into(),
                    ],
                )
                .await?;
                let _ = std::fs::remove_file(&stage);

                if let Some(d2) = dir2 {
                    run_vips(
                        ctx,
                        vec![
                            "flip".into(),
                            mid.display().to_string(),
                            dst.display().to_string(),
                            d2.into(),
                        ],
                    )
                    .await?;
                    let _ = std::fs::remove_file(&mid);
                }
            }
        }
        ImageBackend::Magick => {
            // IM7 的 `-rotate` 接受任意角度（`-rotate 45`）。
            // 90 的整数倍也走它：IM 对整角度有专门优化，结果与 `-rotate 90` 一致。
            let mut a = vec![
                src.display().to_string(),
                "-rotate".into(),
                normalized.to_string(),
            ];
            if flip_h {
                a.push("-flop".into());
            }
            if flip_v {
                a.push("-flip".into());
            }
            a.push(dst.display().to_string());
            run_magick(ctx, a).await?;
        }
        ImageBackend::Rust => {
            let mut img = decode_image(&src)?;
            match normalized as i64 {
                0 => {}
                90 => img = img.rotate90(),
                180 => img = img.rotate180(),
                270 => img = img.rotate270(),
                // 上面已经拦掉了，这里只是不让编译器要求 catch-all
                _ => unreachable!("非 90° 整数倍在 Rust 后端已被拒绝"),
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
        }
    }

    Ok(NodeOutput::file(dst.display().to_string())
        .with_value("backend", backend.id().to_string()))
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

/// `image.remove-background`：U²-Net / ISNet 抠图。
///
/// ## 为什么是"Python 子进程"而不是 Rust
///
/// 宿主里没有 ONNX Runtime 的 Rust 绑定：`ort` 需要在**构建期**下载预编译动态库，
/// 内网/离线环境会直接构建失败 —— 而"构建失败"意味着整个项目编译不过，
/// 代价太大。Python 侧的 `onnxruntime` 是一条成熟、可校验、可隔离的路径，
/// 而且 L3 插件运行时本来就要求一个托管 Python，这条链路是**复用**的。
///
/// ## 三个前置条件，缺一个都要给出可操作的错误
///
/// 1. **模型权重**（`models/<id>/<file>.onnx`）—— 在「设置 → 模型权重」里下载；
/// 2. **能装 onnxruntime 的 Python**（3.9~3.13）—— 首选应用托管的 3.11，
///    因为系统 Python 可能是 3.14，而 onnxruntime **还没有 3.14 的 wheel**；
/// 3. **推理依赖**（onnxruntime / numpy / pillow）—— 首次运行时自动装进
///    一个独立 venv（`<数据目录>/cache/onnx-runtime`），不污染用户的 Python。
///
/// 这三件事都必须"说得清、做得到"：任何一条缺失时的报错都要**指名道姓**
/// 地告诉用户去哪儿点哪个按钮。含糊的报错会让人以为功能坏了。
async fn image_remove_background(
    ctx: &mut NodeCtx,
    args: &BTreeMap<String, String>,
) -> ToolforgeResult<NodeOutput> {
    let src = resolve_path(ctx, "input", arg(args, "src")?)?;
    let dst = resolve_path(ctx, "output", arg(args, "dst")?)?;

    let model_id = ctx.param_str("model", "u2netp");
    let mode = ctx.param_str("mode", "alpha");
    if mode != "alpha" && mode != "color" {
        return Err(ToolforgeError::invalid(format!(
            "image.remove-background 的 mode 只能是 alpha 或 color，收到 `{mode}`"
        )));
    }
    let background = ctx.param_str("background", "#FFFFFF");
    let threshold = ctx.param_i64("threshold", 0).clamp(0, 99);
    let feather = ctx.param_i64("feather", 0).clamp(0, 50);

    // ---- ① 模型 ----
    let model_path = ctx.engines.model_path(&model_id).ok_or_else(|| {
        ToolforgeError::not_found(format!("模型 {model_id} 不在引擎目录里登记"))
            .with_detail("可用的抠图模型：u2netp（最快）、u2net、isnet-general。")
    })?;
    if !model_path.is_file() {
        return Err(ToolforgeError::not_found(format!(
            "抠图模型 {model_id} 还没下载"
        ))
        .with_detail(
            "请到「设置 → 引擎管理 → 模型权重」里点「下载」。\n\
             u2netp 只有 4.4 MB，建议先装它；u2net / isnet-general 效果更好但约 170 MB。"
                .to_string(),
        ));
    }

    ctx.job.progress_now(toolforge_core::job::JobProgress::indeterminate(
        format!("抠图 {}", file_label(&src)),
    ));

    // ---- ② Python 运行时 ----
    let python = ensure_onnx_runtime(ctx).await?;

    // ---- ③ 脚本 ----
    let script = materialize_rembg_script(ctx)?;

    // ---- ④ 跑推理 ----
    let mut cmd_args = vec![
        script.display().to_string(),
        "--model".into(),
        model_path.display().to_string(),
        "--input".into(),
        src.display().to_string(),
        "--output".into(),
        dst.display().to_string(),
        "--mode".into(),
        mode.clone(),
        "--background".into(),
        background.clone(),
        "--threshold".into(),
        threshold.to_string(),
        "--feather".into(),
        feather.to_string(),
    ];
    // `--mode color` 之外时背景色没有意义，去掉免得用户以为它生效了
    if mode != "color" {
        let pos = cmd_args.iter().position(|a| a == "--background");
        if let Some(i) = pos {
            cmd_args.drain(i..i + 2);
        }
    }

    let job = ctx.job.clone();
    let result = toolforge_process::exec_streaming(
        ExecOptions::new(python.clone())
            .args(cmd_args)
            // 让 Python 不要把 .pyc 写进仓库/缓存目录（避免只读目录下报错）
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .cancel(ctx.job.cancel.clone())
            // 首次可能要下载依赖，给足时间；正常推理是秒级
            .timeout(Duration::from_secs(1800))
            .quiet(true),
        move |kind, line| {
            // Python 侧的进度不逐行刷给用户，但失败时这些行就是全部线索
            if kind == StreamKind::Stderr && !line.trim().is_empty() {
                job.log(toolforge_core::job::LogLevel::Debug, line.to_string());
            }
        },
    )
    .await
    .map_err(|e| {
        ToolforgeError::engine_failed("python", format!("启动抠图脚本失败：{}", e.message))
    })?;

    if !result.success() {
        // 脚本自己会把"为什么"写到 stderr（缺依赖 / 模型损坏 / 图片打不开），
        // 原样带给用户 —— 换成一句"抠图失败"等于把最有用的信息扔掉。
        let detail = if result.stderr.trim().is_empty() {
            result.stdout.clone()
        } else {
            result.stderr.clone()
        };
        return Err(ToolforgeError::engine_failed("python", "抠图脚本执行失败")
            .with_detail(detail.trim().to_string()));
    }

    // ---- ⑤ 解析脚本回传的 JSON ----
    let report: serde_json::Value = result
        .stdout
        .lines()
        .rev()
        .find_map(|l| serde_json::from_str::<serde_json::Value>(l.trim()).ok())
        .ok_or_else(|| {
            ToolforgeError::internal("抠图脚本没有返回可解析的结果").with_detail(format!(
                "stdout：{}\nstderr：{}",
                result.stdout.trim(),
                result.stderr.trim()
            ))
        })?;

    if !dst.is_file() {
        return Err(ToolforgeError::engine_failed(
            "python",
            format!("抠图结束但没有生成 {}", dst.display()),
        ));
    }

    let coverage = report
        .get("coveragePercent")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    // 前景占比异常时给一条提示：这几乎是"用户选错了模型或图里没有主体"的
    // 唯一可观测信号，不说的话用户只会觉得"抠得不对"。
    if coverage < 1.0 {
        ctx.job.warn(format!(
            "U²-Net 几乎没找到前景（占比 {coverage:.1}%）—— 可能是图里没有明显主体，\
             或者这张图不适合这个模型（人像试试 isnet-general）。"
        ));
    } else if coverage > 99.0 {
        ctx.job.warn(format!(
            "U²-Net 把整张图都当成了前景（占比 {coverage:.1}%）—— \
             可能是背景与主体对比度太低。"
        ));
    }

    ctx.job.log(
        toolforge_core::job::LogLevel::Debug,
        format!(
            "image.remove-background：模型 {model_id}；前景占比 {coverage:.2}%；输出 {mode}"
        ),
    );

    Ok(NodeOutput::file(dst.display().to_string())
        .with_value("path", dst.display().to_string())
        .with_value("model", model_id)
        .with_value("backend", "onnx-python")
        .with_value("coveragePercent", format!("{coverage:.2}")))
}

/// 抠图脚本的正文。
///
/// 用 `include_str!` 编进二进制，**运行时再写到磁盘**，而不是走 Tauri 的
/// resource 打包。理由：resource 路径在开发态/打包态/不同平台下是三套规则
/// （`resolve_builtin_plugins` 里已经为此写过一段兼容代码），而一个 .py 文件
/// 只有几 KB，编进去最省事，也**不可能出现"文件没被打进包"**这种故障。
const REMBG_SCRIPT: &str = include_str!("../py/rembg.py");

/// 把脚本写到缓存目录，返回路径。
///
/// 每次都重写（内容变了就自动生效），并用 `.toolforge` 之外的名字，
/// 免得被插件的文件扫描当成用户数据。
fn materialize_rembg_script(ctx: &NodeCtx) -> ToolforgeResult<PathBuf> {
    let dir = ctx.engines.paths().cache().join("onnx-runtime");
    std::fs::create_dir_all(&dir).map_err(|e| {
        ToolforgeError::io(format!("创建 {} 失败：{e}", dir.display()))
    })?;
    let path = dir.join("rembg.py");
    std::fs::write(&path, REMBG_SCRIPT)
        .map_err(|e| ToolforgeError::io(format!("写入 {} 失败：{e}", path.display())))?;
    Ok(path)
}

/// 依赖安装完成的标记文件名。
const ONNX_READY_MARKER: &str = "ready.json";

/// 确保有一个**装了 onnxruntime 的** Python，返回其解释器路径。
///
/// ## 为什么单独建 venv
///
/// 直接往用户的系统 Python 里 `pip install` 是**入侵性**的：会改别人的环境、
/// 可能撞版本、卸载时还得猜哪些包是自己装的。这里建一个独立 venv 放在
/// 应用数据目录下，删掉目录就等于卸载干净。
///
/// ## 为什么优先用托管 Python
///
/// 系统上可能是 Python 3.14，而 onnxruntime **还没有 3.14 的 wheel** ——
/// `pip install` 会直接报找不到匹配的发行版。托管 Python 固定 3.11，
/// 依赖一定能装上。所以这里的顺序是「托管优先，系统兜底」，
/// 并且兜底时会检查版本区间。
async fn ensure_onnx_runtime(ctx: &NodeCtx) -> ToolforgeResult<PathBuf> {
    let dir = ctx.engines.paths().cache().join("onnx-runtime");
    let venv_python = venv_python_path(&dir);
    let marker = dir.join(ONNX_READY_MARKER);

    // 已经装好就直接复用。标记文件是必需的：只看 venv 目录存在的话，
    // "venv 建好了但 pip 装了一半失败"会被误判成可用。
    if marker.is_file() && venv_python.is_file() {
        return Ok(venv_python);
    }

    let base = find_base_python(ctx).await?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| ToolforgeError::io(format!("创建 {} 失败：{e}", dir.display())))?;

    // ---- 建 venv ----
    ctx.job.info(format!(
        "首次使用抠图：正在准备独立 Python 环境（{}）",
        dir.display()
    ));
    let out = toolforge_process::exec(
        ExecOptions::new(base.clone())
            .args(["-m", "venv", "--clear", &dir.display().to_string()])
            .cancel(ctx.job.cancel.clone())
            .timeout(Duration::from_secs(600))
            .quiet(true),
    )
    .await?;
    if !out.success() || !venv_python.is_file() {
        return Err(ToolforgeError::engine_failed(
            "python",
            "创建抠图用的独立 Python 环境失败",
        )
        .with_detail(format!(
            "解释器：{}\nstdout：{}\nstderr：{}",
            base.display(),
            out.stdout.trim(),
            out.stderr.trim()
        )));
    }

    // ---- 装依赖 ----
    // 不指定版本：onnxruntime 的 ABI 与 Python 小版本绑定，写死版本号
    // 反而会在某些 Python 上装不上。让 pip 自己挑这个解释器能用的最新版。
    ctx.job.info("正在下载抠图依赖（onnxruntime / numpy / pillow，约 30 MB，仅首次）");
    let job = ctx.job.clone();
    let out = toolforge_process::exec_streaming(
        ExecOptions::new(venv_python.clone())
            .args([
                "-m",
                "pip",
                "install",
                "--disable-pip-version-check",
                "--no-input",
                "onnxruntime",
                "numpy",
                "pillow",
            ])
            .cancel(ctx.job.cancel.clone())
            .timeout(Duration::from_secs(1800))
            .quiet(true),
        move |_kind, line| {
            if !line.trim().is_empty() {
                job.log(toolforge_core::job::LogLevel::Debug, line.to_string());
            }
        },
    )
    .await?;

    if !out.success() {
        return Err(ToolforgeError::engine_failed(
            "python",
            "安装抠图依赖（onnxruntime / numpy / pillow）失败",
        )
        .with_detail(format!(
            "{}\n\n常见原因：网络不通、公司代理拦截 pip、或这台机器上的 Python 版本\
             太新（onnxruntime 未必有对应 wheel）。可以手动执行：\n  \
             {} -m pip install onnxruntime numpy pillow",
            out.stderr.trim(),
            venv_python.display()
        )));
    }

    std::fs::write(
        &marker,
        serde_json::json!({
            "python": venv_python.display().to_string(),
            "base": base.display().to_string(),
            "packages": ["onnxruntime", "numpy", "pillow"],
            "createdAt": toolforge_core::job::now_iso(),
        })
        .to_string(),
    )
    .map_err(|e| ToolforgeError::io(format!("写入标记文件失败：{e}")))?;

    ctx.job.info("抠图依赖已就绪");
    Ok(venv_python)
}

fn venv_python_path(venv_dir: &Path) -> PathBuf {
    if cfg!(windows) {
        venv_dir.join("Scripts").join("python.exe")
    } else {
        venv_dir.join("bin").join("python")
    }
}

/// onnxruntime 目前支持的 Python 版本区间（含）。
///
/// 写成常量而不是散在判断里：这条信息会直接出现在给用户的报错里，
/// 而"为什么我的 Python 不行"是最容易被含糊过去的问题。
const ONNX_PY_MIN: (u32, u32) = (3, 9);
const ONNX_PY_MAX: (u32, u32) = (3, 13);

/// 找一个能装 onnxruntime 的 Python。
async fn find_base_python(ctx: &NodeCtx) -> ToolforgeResult<PathBuf> {
    let managed = ctx.engines.paths().engines().join("python");
    let mut candidates: Vec<(PathBuf, &'static str)> = Vec::new();

    // 托管 Python 优先（固定 3.11，依赖一定能装上）
    for rel in ["python.exe", "python", "bin/python.exe", "bin/python"] {
        let p = managed.join(rel);
        if p.is_file() {
            candidates.push((p, "应用托管的 Python"));
        }
    }
    // 系统 Python 兜底
    if let Some(p) = ctx.engines.system_binary("python") {
        candidates.push((p, "系统 Python"));
    }
    if candidates.is_empty() {
        return Err(ToolforgeError::engine_missing("python").with_detail(
            "抠图需要 Python 3.9~3.13（用来跑 ONNX Runtime）。\n\
             请到「设置 → 引擎管理」安装「Python 运行时」（应用会装一个独立的 3.11，\
             不会动你系统上的 Python）。"
                .to_string(),
        ));
    }

    let mut rejection: Option<String> = None;
    for (path, source) in candidates {
        match python_version(ctx, &path).await {
            Some(v) if v >= ONNX_PY_MIN && v <= ONNX_PY_MAX => {
                ctx.job.log(
                    toolforge_core::job::LogLevel::Debug,
                    format!(
                        "抠图将使用{source}：{}（Python {}.{}）",
                        path.display(),
                        v.0,
                        v.1
                    ),
                );
                return Ok(path);
            }
            Some(v) => {
                rejection = Some(format!(
                    "{source} {} 是 Python {}.{}，超出了 onnxruntime 支持的区间",
                    path.display(),
                    v.0,
                    v.1
                ));
            }
            None => {
                rejection = Some(format!("{source} {} 无法执行或读不出版本", path.display()));
            }
        }
    }

    Err(ToolforgeError::engine_missing("python").with_detail(format!(
        "{}\n\n抠图需要 Python {}.{} ~ {}.{}。请到「设置 → 引擎管理」安装\
         「Python 运行时」—— 应用会装一个独立的 3.11，不会动你系统上的 Python。",
        rejection.unwrap_or_else(|| "没有找到可用的 Python".into()),
        ONNX_PY_MIN.0,
        ONNX_PY_MIN.1,
        ONNX_PY_MAX.0,
        ONNX_PY_MAX.1,
    )))
}

/// 读出 Python 的 `(major, minor)`。
async fn python_version(ctx: &NodeCtx, python: &Path) -> Option<(u32, u32)> {
    let out = toolforge_process::exec(
        ExecOptions::new(python)
            .arg("--version")
            .cancel(ctx.job.cancel.clone())
            .timeout(Duration::from_secs(20))
            .quiet(true),
    )
    .await
    .ok()?;
    let text = if out.stdout.trim().is_empty() {
        out.stderr
    } else {
        out.stdout
    };
    // `Python 3.11.16`（stdout）或 `Python 3.11.16`（老版本走 stderr）
    let ver = text.split_whitespace().find(|w| w.chars().next().is_some_and(|c| c.is_ascii_digit()))?;
    let mut it = ver.split('.');
    let major = it.next()?.parse().ok()?;
    let minor = it.next()?.parse().ok()?;
    Some((major, minor))
}

/// `image.strip-metadata`：清掉 EXIF / IPTC / XMP / ICC。
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
        // 用一个**当前确实未实现**的节点。这里原来写的是
        // `image.remove-background` —— 它现在实现了，于是测试红了。
        // 这是好事：说明"未实现名单"确实跟着代码在动。
        // 挑 `doc.ocr` 是因为它短期内都要靠系统装 tesseract，最稳。
        let e = not_implemented("doc.ocr");
        assert!(e.message.contains("doc.ocr"));
        assert!(e.detail.unwrap().contains("ROADMAP"));
    }

    /// 未实现名单里的每个节点都**必须真的没有执行器** —— 否则界面会显示
    /// "该能力尚未实现"，而实际上它已经能跑了。
    ///
    /// 反过来（实现了却忘了从名单里删）同样有害：用户会看到一个明明能用的能力
    /// 被标成灰色。这个项目已经在 `flow.foreach` 上吃过一次亏，
    /// 所以这里**走真实分发**来判定，而不是再抄一份名单。
    ///
    /// 判据是错误码：`not_implemented` 返回 `Internal`，而真实执行器即使因为
    /// 缺参数/缺引擎失败，也不会返回 `Internal` —— 它们报的是
    /// `PluginInvalid` / `EngineMissing` / `NotFound` 之类。
    #[tokio::test]
    async fn unimplemented_list_matches_the_dispatch_table() {
        for node in toolforge_core::pipeline::UNIMPLEMENTED_NODES {
            let (mut ctx, _q, _id) = test_ctx();
            // 空参数：真实执行器会抱怨缺必填参数（但不是 Internal），
            // 未实现节点则一律落到 `not_implemented`。
            let err = run(&mut ctx, node, &BTreeMap::new()).await.unwrap_err();
            assert_eq!(
                err.code,
                ErrorCode::Internal,
                "`{node}` 在未实现名单里，但 `run()` 已经有它的分支了 —— \
                 请从 UNIMPLEMENTED_NODES 里删掉它（前端与文档会自动跟上）"
            );
            assert!(
                err.message.contains("尚未") || err.message.contains(node),
                "`{node}` 的未实现错误信息不明确：{}",
                err.message
            );
        }
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

    #[tokio::test]
    async fn unimplemented_list_matches_actual_dispatch() {
        // 这条测试把「唯一真相来源」这句话变成可验证的事实。
        //
        // 它守住的失误形态：实现完某个节点后**忘了从 UNIMPLEMENTED_NODES 里删掉**
        // ——那样前端会永久显示"该能力尚未实现"，而它其实能跑；
        // 反过来，把实现删了却忘了加回名单，用户会看到"未实现"以外的怪错误。
        let (mut ctx, _q, _id) = test_ctx();

        for node in toolforge_core::pipeline::builtin_nodes() {
            // 用空参数调用：已实现的节点会因为缺参数返回 PluginInvalid/EngineMissing 等，
            // 未实现的必定返回 Internal + "尚未在 v0.1 中实现"。
            let err = match run(&mut ctx, &node.name, &BTreeMap::new()).await {
                Ok(_) => None, // 无参数也能跑通的节点（flow.log 有必填 message，不会走到这）
                Err(e) => Some(e),
            };

            let hit_not_implemented = err
                .as_ref()
                .map(|e| e.message.contains("尚未在 v0.1 中实现"))
                .unwrap_or(false);

            assert_eq!(
                hit_not_implemented,
                !toolforge_core::pipeline::is_implemented(&node.name),
                "节点 `{}` 的实际行为与 UNIMPLEMENTED_NODES 不符（实际报未实现={hit_not_implemented}，\
                 名单说已实现={}）。err={:?}",
                node.name,
                toolforge_core::pipeline::is_implemented(&node.name),
                err.map(|e| e.message)
            );
        }
    }

    // ========================================================================
    // 流程控制节点 + 参数取值优先级
    //
    // 这两块都踩过"静默失效"的坑：`flow.log` / `flow.branch` 曾经直接返回空的
    // `NodeOutput`（不报错也不做事），而 `param_*` 只读 `io.params` 导致写在
    // `with` 里的参数被无声忽略。所以必须有测试钉住。
    // ========================================================================

    fn test_ctx() -> (NodeCtx, Arc<toolforge_core::queue::JobQueue>, String) {
        test_ctx_with_caps(toolforge_core::permission::PermissionSet::empty())
    }

    fn test_ctx_with_caps(
        caps: toolforge_core::permission::PermissionSet,
    ) -> (NodeCtx, Arc<toolforge_core::queue::JobQueue>, String) {
        let (tx, _rx) = tokio::sync::broadcast::channel(64);
        let queue = Arc::new(toolforge_core::queue::JobQueue::new(1, tx));
        let job = queue.create(toolforge_core::job::JobKind::Probe, "测试", 0);
        let id = job.id.to_string();
        let dir = std::env::temp_dir().join("tf-node-ctx-test");
        let _ = std::fs::create_dir_all(&dir);
        let engines = Arc::new(EngineRegistry::new(toolforge_core::paths::AppPaths::new(&dir)));
        let ctx = NodeCtx {
            job,
            engines,
            resolver: PathResolver::new()
                .with_input(&dir)
                .with_output(&dir)
                .with_workspace(&dir),
            guard: CapabilityGuard::new("test.plugin", caps),
            params: HashMap::new(),
            vars: HashMap::new(),
            arg_scope: BTreeMap::new(),
            batch_index: 1,
            batch_total: 1,
        };
        (ctx, queue, id)
    }

    fn args_of(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    #[tokio::test]
    async fn flow_branch_produces_a_usable_value() {
        // 回归：曾经是静默空实现，下游 `when: ${steps.b.active} == true` 永远不成立
        let (mut ctx, _q, _id) = test_ctx();
        let out = run(&mut ctx, "flow.branch", &args_of(&[("condition", "true")]))
            .await
            .unwrap();
        assert_eq!(out.values.get("active").map(|s| s.as_str()), Some("true"));

        let out = run(&mut ctx, "flow.branch", &args_of(&[("condition", "false")]))
            .await
            .unwrap();
        assert_eq!(out.values.get("active").map(|s| s.as_str()), Some("false"));
    }

    #[tokio::test]
    async fn flow_branch_without_condition_is_an_error_not_a_noop() {
        let (mut ctx, _q, _id) = test_ctx();
        let err = run(&mut ctx, "flow.branch", &BTreeMap::new())
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::PluginInvalid);
    }

    #[tokio::test]
    async fn flow_log_actually_writes_to_the_job_log() {
        // 回归：曾经是静默空实现 —— 用户以为日志节点在跑，任务日志里什么都没有
        let (mut ctx, queue, id) = test_ctx();
        let out = run(
            &mut ctx,
            "flow.log",
            &args_of(&[("message", "开始处理"), ("level", "warn")]),
        )
        .await
        .unwrap();
        assert_eq!(
            out.values.get("message").map(|s| s.as_str()),
            Some("开始处理")
        );

        let job = queue.get(&id).expect("任务应当还在队列里");
        let entry = job.logs.last().expect("应当写进了一条日志");
        assert_eq!(entry.message, "开始处理");
        assert_eq!(entry.level, toolforge_core::job::LogLevel::Warn);
    }

    #[tokio::test]
    async fn flow_log_without_message_is_an_error() {
        let (mut ctx, _q, _id) = test_ctx();
        let err = run(&mut ctx, "flow.log", &BTreeMap::new()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::PluginInvalid);
    }

    #[tokio::test]
    async fn flow_set_var_is_reachable_as_vars() {
        let (mut ctx, _q, _id) = test_ctx();
        let out = run(
            &mut ctx,
            "flow.set-var",
            &args_of(&[("name", "outDir"), ("value", "/output/x")]),
        )
        .await
        .unwrap();
        assert_eq!(out.values.get("value").map(|s| s.as_str()), Some("/output/x"));
        assert_eq!(ctx.vars.get("outDir").map(|s| s.as_str()), Some("/output/x"));
    }

    #[test]
    fn with_takes_precedence_over_user_params() {
        // 插件作者（和 LLM）天然会把节点参数写在 `with` 里。
        // 执行器现在两种都认，且 `with` 里的显式字面量优先（它更具体）。
        let (mut ctx, _q, _id) = test_ctx();
        ctx.params.insert(
            "format".into(),
            toolforge_core::plugin::ParamValue::Str("png".into()),
        );

        // 没有 with → 用用户参数
        assert_eq!(ctx.param_str("format", "webp"), "png");

        // 有 with → with 赢
        ctx.arg_scope = args_of(&[("format", "webp")]);
        assert_eq!(ctx.param_str("format", "webp"), "webp");

        // 都没有 → 默认值
        assert_eq!(ctx.param_str("quality", "90"), "90");
    }

    #[test]
    fn param_numeric_readers_accept_rendered_strings() {
        // 模板渲染后 `with` 里全是字符串，数字也得能取出来
        let (mut ctx, _q, _id) = test_ctx();
        ctx.arg_scope = args_of(&[
            ("width", "1280"),
            ("scale", "2.5"),
            ("flag", "yes"),
            ("blank", "   "),
        ]);
        assert_eq!(ctx.param_i64("width", 0), 1280);
        assert_eq!(ctx.param_i64("missing", 7), 7);
        assert!((ctx.param_f64("scale", 0.0) - 2.5).abs() < f64::EPSILON);
        assert!(ctx.param_bool("flag", false));
        // 空白串视为"未提供"，回退到默认值
        assert_eq!(ctx.param_i64("blank", 5), 5);
    }

    #[test]
    fn param_to_string_trims_float_noise() {
        use toolforge_core::plugin::ParamValue as P;
        assert_eq!(param_to_string(&P::Int(90)), "90");
        assert_eq!(param_to_string(&P::Float(90.0)), "90");
        assert_eq!(param_to_string(&P::Float(92.5)), "92.5");
        assert_eq!(param_to_string(&P::Bool(true)), "true");
        assert_eq!(
            param_to_string(&P::List(vec!["a".into(), "b".into()])),
            "a,b"
        );
    }

    // ========================================================================
    // 运行时能力裁决必须真的接在文件访问路径上
    //
    // ⚠️ 回归测试。`CapabilityGuard` 曾经在 `l1.rs` 里被构造、塞进 `NodeCtx`，
    // 然后**再也没有被调用过** —— 所有 `check()` 调用点都在 `permission.rs`
    // 自己的单测里。也就是说 "运行时逐请求裁决" 当时是"布线完成但没接线"，
    // README 与 SECURITY.md 的说法是**假的**。
    // 这一组测试确保那条线接上了，并且断开会立刻失败。
    // ========================================================================

    #[tokio::test]
    async fn fs_write_is_rejected_without_the_capability() {
        // 空权限集 → 任何写操作都必须被拒
        let (mut ctx, _q, _id) = test_ctx();
        let err = run(&mut ctx, "fs.mkdir", &args_of(&[("path", "sub")]))
            .await
            .unwrap_err();
        assert_eq!(
            err.code,
            ErrorCode::PluginCapabilityViolation,
            "未授权时写入必须被能力裁决拦下：{err}"
        );
        assert_eq!(err.subject.as_deref(), Some("test.plugin"));
    }

    #[tokio::test]
    async fn fs_read_is_rejected_without_the_capability() {
        let (mut ctx, _q, _id) = test_ctx();
        // fs.copy 先读 src：未授权 fsRead 时应当在**第一步**就被拒，
        // 而不是"先读到一半再失败"
        let err = run(
            &mut ctx,
            "fs.copy",
            &args_of(&[("src", "a.txt"), ("dst", "b.txt")]),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::PluginCapabilityViolation);
    }

    #[tokio::test]
    async fn fs_write_passes_once_the_capability_is_granted() {
        use toolforge_core::permission::{Capability, PathScope, PermissionSet};
        let caps = PermissionSet::from_iter_caps([Capability::FsWrite {
            scope: PathScope::Output,
        }]);
        let (mut ctx, _q, _id) = test_ctx_with_caps(caps);

        let out = run(&mut ctx, "fs.mkdir", &args_of(&[("path", "tf-guard-test")]))
            .await
            .expect("授权后写入应当通过");
        assert!(out.values.contains_key("path"));

        // 清理
        if let Some(p) = out.values.get("path") {
            let _ = std::fs::remove_dir_all(p);
        }
    }

    #[tokio::test]
    async fn path_traversal_is_still_blocked_after_the_capability_check() {
        // 两层防护是**与**关系：通过了能力裁决，还要过路径收敛。
        // 这条测试防止有人为了"让插件跑起来"把第二层拆掉。
        use toolforge_core::permission::{Capability, PathScope, PermissionSet};
        let caps = PermissionSet::from_iter_caps([Capability::FsWrite {
            scope: PathScope::Output,
        }]);
        let (mut ctx, _q, _id) = test_ctx_with_caps(caps);

        let err = run(
            &mut ctx,
            "fs.mkdir",
            &args_of(&[("path", "../../../tf-escaped")]),
        )
        .await
        .unwrap_err();
        assert_eq!(
            err.code,
            ErrorCode::PermissionDenied,
            "有权写 ≠ 可以写到授权目录之外：{err}"
        );
    }
}
