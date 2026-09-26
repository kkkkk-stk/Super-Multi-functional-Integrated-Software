//! # L1 声明式流水线
//!
//! L1 插件不写代码，只写"调用哪些内置节点、参数怎么传"。这是整个扩展模型里
//! **最安全、最适合 AI 生成**的一层：AI 的产出是一段数据，宿主逐节点执行，
//! 每个节点的能力边界是编译期写死的。
//!
//! ## 变量模板
//!
//! `with` 里的取值支持 `${...}` 插值，来源有三个：
//!
//! | 语法 | 含义 |
//! |---|---|
//! | `${src}` / `${input.<portId>}` | 输入端口绑定的文件路径 |
//! | `${dst}` / `${output.<portId>}` | 输出端口的目标路径（宿主已分配） |
//! | `${params.<id>}` | 用户填的参数 |
//! | `${steps.<stepId>.<key>}` | 前序步骤产出的值 |
//! | `${env.TEMP}` | **仅** 宿主显式注入的白名单变量 |
//!
//! 未解析的变量一律**报错**而不是留空 —— 静默留空会产生"看起来跑通了但结果不对"
//! 的 bug，这在批量处理里是灾难。

use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;

use crate::error::{ToolforgeError, ToolforgeResult};
use crate::plugin::{IoPort, ParamSpec, ParamType, PortType, ValidationIssue};

// ============================================================================
// 流水线定义
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PipelineDef {
    /// 可选的人类可读描述（流程编辑器里显示在节点上）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub steps: Vec<PipelineStep>,
    /// 单步失败时的整体策略
    #[serde(default)]
    pub on_error: OnErrorPolicy,
    /// 整个流水线的超时（毫秒），0 表示不限
    #[serde(default)]
    pub timeout_ms: u64,
}

impl Default for PipelineDef {
    fn default() -> Self {
        Self {
            description: None,
            steps: Vec::new(),
            on_error: OnErrorPolicy::Fail,
            timeout_ms: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PipelineStep {
    /// 步骤 ID，在流水线内唯一；`${steps.<id>.*}` 引用它
    pub id: String,
    /// 内置节点名，必须存在于 [`builtin_nodes`] 里
    pub uses: String,
    /// 参数模板
    #[serde(default)]
    pub with: BTreeMap<String, String>,
    /// 人类可读标签（流程编辑器节点标题）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// 跳过条件：`${params.mode} != "fast"` 这类简单比较
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<String>,
    /// 覆盖流水线级策略
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_error: Option<OnErrorPolicy>,
    #[serde(default)]
    pub retry: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    /// 流程编辑器里的画布坐标（由前端写回，宿主不解释）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<StepPosition>,
    /// 依赖的步骤 id（流程编辑器画连线用；为空表示按声明顺序串行）
    #[serde(default)]
    pub depends_on: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StepPosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum OnErrorPolicy {
    /// 中止整个任务（默认）
    #[default]
    Fail,
    /// 跳过该步继续
    Skip,
    /// 跳过该步，并把失败原因写入 `${steps.<id>.error}`
    Continue,
    /// 重试 N 次后仍然失败则中止
    Retry,
}

impl PipelineDef {
    /// 校验流水线（被 [`crate::plugin::PluginManifest::validate`] 调用）
    pub fn validate_into(&self, issues: &mut Vec<ValidationIssue>) {
        if self.steps.is_empty() {
            issues.push(ValidationIssue::error(
                "PIPELINE_EMPTY",
                "pipeline.steps 不能为空",
            ));
            return;
        }

        let catalog = builtin_nodes();
        let known: std::collections::HashSet<&str> =
            catalog.iter().map(|n| n.name.as_str()).collect();

        let mut ids = std::collections::HashSet::new();
        for (idx, step) in self.steps.iter().enumerate() {
            let at = format!("runtime.pipeline.steps[{idx}]");

            if step.id.trim().is_empty() {
                issues.push(
                    ValidationIssue::error("STEP_ID_EMPTY", "步骤 id 不能为空").at(at.clone()),
                );
            } else if !ids.insert(step.id.as_str()) {
                issues.push(
                    ValidationIssue::error(
                        "STEP_ID_DUPLICATE",
                        format!("步骤 id `{}` 重复", step.id),
                    )
                    .at(at.clone()),
                );
            }

            if !known.contains(step.uses.as_str()) {
                issues.push(
                    ValidationIssue::error(
                        "STEP_UNKNOWN_NODE",
                        format!(
                            "步骤 `{}` 引用了未知内置节点 `{}`；可用节点见 docs/ENGINE-MATRIX.md",
                            step.id, step.uses
                        ),
                    )
                    .at(at.clone()),
                );
            }

            // dependsOn 必须指向存在且更早的步骤（保证 DAG 无环）
            for dep in &step.depends_on {
                let dep_idx = self.steps.iter().position(|s| &s.id == dep);
                match dep_idx {
                    None => issues.push(
                        ValidationIssue::error(
                            "STEP_DEP_MISSING",
                            format!("步骤 `{}` 依赖了不存在的步骤 `{dep}`", step.id),
                        )
                        .at(at.clone()),
                    ),
                    Some(d) if d >= idx => issues.push(
                        ValidationIssue::error(
                            "STEP_DEP_CYCLE",
                            format!(
                                "步骤 `{}` 依赖了自身或后续步骤 `{dep}`，流水线必须是 DAG",
                                step.id
                            ),
                        )
                        .at(at.clone()),
                    ),
                    Some(_) => {}
                }
            }

            // 模板变量引用只能指向已声明的东西
            for (key, val) in &step.with {
                for var in extract_vars(val) {
                    if let Some(step_ref) = var.strip_prefix("steps.") {
                        let ref_id = step_ref.split('.').next().unwrap_or("");
                        let ref_idx = self.steps.iter().position(|s| s.id == ref_id);
                        match ref_idx {
                            None => issues.push(
                                ValidationIssue::error(
                                    "TEMPLATE_UNKNOWN_STEP",
                                    format!(
                                        "步骤 `{}` 的参数 `{key}` 引用了不存在的步骤 `{ref_id}`",
                                        step.id
                                    ),
                                )
                                .at(at.clone()),
                            ),
                            Some(r) if r >= idx => issues.push(
                                ValidationIssue::error(
                                    "TEMPLATE_FORWARD_REF",
                                    format!(
                                        "步骤 `{}` 的参数 `{key}` 引用了后续步骤 `{ref_id}`（不允许前向引用）",
                                        step.id
                                    ),
                                )
                                .at(at.clone()),
                            ),
                            Some(_) => {}
                        }
                    }
                }
            }

            if step.on_error == Some(OnErrorPolicy::Retry) && step.retry == 0 {
                issues.push(
                    ValidationIssue::warning(
                        "STEP_RETRY_ZERO",
                        format!("步骤 `{}` 声明了 retry 策略但 retry = 0", step.id),
                    )
                    .at(at),
                );
            }
        }

        if self.timeout_ms > 0 && self.timeout_ms < 1_000 {
            issues.push(ValidationIssue::warning(
                "PIPELINE_TIMEOUT_TOO_SHORT",
                "pipeline.timeoutMs 小于 1 秒，几乎必然误杀",
            ));
        }
    }

    /// 返回流水线所有步骤**依赖**的引擎（去重）
    pub fn required_engines(&self) -> Vec<String> {
        let catalog = builtin_nodes();
        let mut out: Vec<String> = Vec::new();
        for step in &self.steps {
            if let Some(node) = catalog.iter().find(|n| n.name == step.uses) {
                for e in &node.requires_engines {
                    if !out.contains(e) {
                        out.push(e.clone());
                    }
                }
            }
        }
        out
    }

    /// 可选（用于加速/增强）引擎
    pub fn optional_engines(&self) -> Vec<String> {
        let catalog = builtin_nodes();
        let mut out: Vec<String> = Vec::new();
        for step in &self.steps {
            if let Some(node) = catalog.iter().find(|n| n.name == step.uses) {
                for e in &node.optional_engines {
                    if !out.contains(e) {
                        out.push(e.clone());
                    }
                }
            }
        }
        out
    }
}

// ============================================================================
// 模板渲染
// ============================================================================

/// 从 `${...}` 中抽取所有变量名（不含 `${}` 与空白）
pub fn extract_vars(template: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = template.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'$' && bytes[i + 1] == b'{' {
            if let Some(end) = template[i + 2..].find('}') {
                let name = template[i + 2..i + 2 + end].trim();
                if !name.is_empty() {
                    out.push(name.to_string());
                }
                i = i + 2 + end + 1;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// 模板求值上下文
#[derive(Debug, Clone, Default)]
pub struct TemplateContext {
    /// `input.<portId>` / `output.<portId>` / `params.<id>` / `steps.<id>.<key>` / `env.<NAME>`
    pub values: BTreeMap<String, String>,
}

impl TemplateContext {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, key: impl Into<String>, value: impl Into<String>) -> &mut Self {
        self.values.insert(key.into(), value.into());
        self
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.values.get(key).map(|s| s.as_str())
    }
}

/// 渲染模板。
///
/// **未解析的变量是错误，不是空串。** 见模块文档说明。
pub fn render_template(template: &str, ctx: &TemplateContext) -> ToolforgeResult<String> {
    let mut out = String::with_capacity(template.len());
    let bytes = template.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        if i + 1 < bytes.len() && bytes[i] == b'$' && bytes[i + 1] == b'{' {
            if let Some(rel_end) = template[i + 2..].find('}') {
                let name = template[i + 2..i + 2 + rel_end].trim();
                let value = ctx.get(name).ok_or_else(|| {
                    ToolforgeError::plugin_invalid(format!(
                        "模板变量 `${{{name}}}` 无法解析"
                    ))
                    .with_detail(
                        "可用的变量：input.* / output.* / params.* / steps.* / env.*（白名单）",
                    )
                })?;
                out.push_str(value);
                i = i + 2 + rel_end + 1;
                continue;
            }
        }
        // 逐字符推进（注意 UTF-8 边界）
        let ch = template[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }

    Ok(out)
}

/// 求值 `when` 条件。只支持三种最简形式，**刻意不做通用表达式引擎** ——
/// 通用表达式意味着通用执行，那正是我们要避免的。
///
/// * `a == b` / `a != b`  （字符串比较）
/// * `a`                 （非空且不等于 `false`/`0`/`""` 为真）
pub fn eval_condition(cond: &str, ctx: &TemplateContext) -> ToolforgeResult<bool> {
    let rendered = render_template(cond, ctx)?;
    let rendered = rendered.trim();

    if let Some((lhs, rhs)) = rendered.split_once("==") {
        return Ok(lhs.trim() == rhs.trim());
    }
    if let Some((lhs, rhs)) = rendered.split_once("!=") {
        return Ok(lhs.trim() != rhs.trim());
    }
    Ok(!matches!(rendered, "" | "false" | "0" | "no" | "off"))
}

// ============================================================================
// 内置节点目录
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum NodeCategory {
    File,
    Image,
    Video,
    Audio,
    Document,
    Archive,
    Ebook,
    Text,
    Ai,
    Flow,
}

impl NodeCategory {
    pub fn describe(self) -> &'static str {
        match self {
            NodeCategory::File => "文件操作",
            NodeCategory::Image => "图片",
            NodeCategory::Video => "视频",
            NodeCategory::Audio => "音频",
            NodeCategory::Document => "文档",
            NodeCategory::Archive => "压缩包",
            NodeCategory::Ebook => "电子书",
            NodeCategory::Text => "文本与命名",
            NodeCategory::Ai => "AI",
            NodeCategory::Flow => "流程控制",
        }
    }
}

/// 一个内置节点的元描述。流程编辑器的节点面板、参数表单、引擎缺失提示全部由它驱动。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NodeDescriptor {
    /// 全名，插件清单里 `uses` 就是它
    pub name: String,
    pub label: String,
    pub description: String,
    pub category: NodeCategory,
    /// 必需引擎：缺失则该节点不可用（UI 里显示"需要安装 FFmpeg"）
    pub requires_engines: Vec<String>,
    /// 可选引擎：缺失时自动降级，功能仍在
    pub optional_engines: Vec<String>,
    pub inputs: Vec<IoPort>,
    pub outputs: Vec<IoPort>,
    pub params: Vec<ParamSpec>,
}

// ---- 构造辅助（把样板压到最低） ----

fn port(id: &str, label: &str, ty: PortType, required: bool) -> IoPort {
    IoPort {
        id: id.into(),
        label: label.into(),
        ty,
        accept: vec![],
        multiple: false,
        required,
        description: None,
    }
}

fn in_file(id: &str, label: &str, accept: &[&str]) -> IoPort {
    IoPort {
        id: id.into(),
        label: label.into(),
        ty: PortType::File,
        accept: accept.iter().map(|s| s.to_string()).collect(),
        multiple: false,
        required: true,
        description: None,
    }
}

fn out_file(id: &str, label: &str) -> IoPort {
    let mut p = port(id, label, PortType::File, true);
    p.required = false;
    p
}

#[allow(clippy::too_many_arguments)]
fn param(
    id: &str,
    label: &str,
    ty: ParamType,
    default: Option<ParamValueish>,
    required: bool,
) -> ParamSpec {
    ParamSpec {
        id: id.into(),
        label: label.into(),
        ty,
        description: None,
        default: default.map(|d| d.0),
        options: vec![],
        min: None,
        max: None,
        step: None,
        required,
        placeholder: None,
        multiline: false,
        affects_output: false,
    }
}

/// 小包装，避免在 `param()` 里写一长串 `ParamValue::Str("x".into())`
#[derive(Debug, Clone)]
pub struct ParamValueish(pub crate::plugin::ParamValue);

impl From<&str> for ParamValueish {
    fn from(s: &str) -> Self {
        ParamValueish(crate::plugin::ParamValue::Str(s.into()))
    }
}
impl From<i64> for ParamValueish {
    fn from(i: i64) -> Self {
        ParamValueish(crate::plugin::ParamValue::Int(i))
    }
}
impl From<f64> for ParamValueish {
    fn from(f: f64) -> Self {
        ParamValueish(crate::plugin::ParamValue::Float(f))
    }
}
impl From<bool> for ParamValueish {
    fn from(b: bool) -> Self {
        ParamValueish(crate::plugin::ParamValue::Bool(b))
    }
}

fn enum_param(id: &str, label: &str, default: &str, opts: &[&str]) -> ParamSpec {
    let mut p = param(id, label, ParamType::Enum, Some(default.into()), true);
    p.options = opts
        .iter()
        .map(|o| crate::plugin::ParamOption {
            value: (*o).into(),
            label: (*o).into(),
        })
        .collect();
    p
}

fn engine(name: &str) -> String {
    name.to_string()
}

/// 已登记但**尚未实现执行器**的节点。
///
/// # 这是唯一真相来源
///
/// 它同时被三处消费，**不要在别处再抄一份名单**：
///
/// * [`builtin_nodes`]（本模块）—— 前端节点面板据此显示"未实现"警告；
/// * `toolforge_engines::nodes::not_implemented`（执行器的兜底分支）；
/// * `apps/desktop` 的节点面板与画布（通过 IPC 的
///   `NodeCatalogResponse.unimplemented` 拿到，**不硬编**）。
///
/// 为什么要把这件事单独拎出来：这份名单曾在**四个地方**各存了一份
/// （Rust 执行器、SDK 文档、示例清单注释、前端的 `node-support.ts`）。
/// 每实现一个节点就要手工同步四处，漏掉任何一处都会让用户看到
/// 与实际行为相反的提示 —— 本项目已经因此踩过坑。
///
/// **新增节点时的正确顺序**：先实现执行器 → 再把它从这里删掉 →
/// 前端与文档会自动跟上。
pub const UNIMPLEMENTED_NODES: &[&str] = &[
    // Real-ESRGAN 权重连下载源都还没核对，见 engine.rs 的
    // `verified_sources_are_pinned`（它要求 url / sha256 / file_name 三件套齐全）。
    // 抠图那条链路（模型下载 + Python 推理）已经通了，超分可以照抄它。
    "ai.upscale",
    // 依赖 AI 服务提供方；`ai_test_connection` 已经能连通，但"看图说话"这一步没写
    "ai.describe",
    // 依赖 tesseract，而 tesseract 目前只支持系统安装（没有配置下载源）
    "doc.ocr",
    // 依赖 calibre，同样只支持系统安装
    "ebook.convert",
];

// `flow.foreach` 曾经在这里，现在**整个节点都删掉了**。留个记录，免得有人再把它加回来：
//
// 当初的设想是"在流水线里对文件列表循环"，但 L1 的步骤列表是**平铺的**，
// 根本没有嵌套结构 —— "对每一步剩下的步骤循环 N 次"这句话没法定义：
// 循环体到底包含哪些步骤？循环后面那些"只想跑一次"的收尾步骤怎么办？
// 而它描述里写的"宿主会按并发度并行调度"更是假的：宿主不在流水线内部调度。
//
// 真正需要批量的场景**已经由宿主解决了**：`commands.rs::expand_batches`
// 在命令层把多文件输入（以及目录输入）扇出成 N 个单文件批次，
// 逐批调用流水线、上报「处理 3/12」、在批次边界检查取消。
// 所以清单里从来不需要写循环，也不需要这个节点。


/// 某个节点的执行器是否已实现
pub fn is_implemented(node: &str) -> bool {
    !UNIMPLEMENTED_NODES.contains(&node)
}

/// 内置节点目录。**这里就是"主程序能力"的完整边界** ——
/// 想加新能力，先在这里加一个节点（或加一个引擎），而不是在每个功能页里写 if。
pub fn builtin_nodes() -> Vec<NodeDescriptor> {
    let mut n: Vec<NodeDescriptor> = Vec::new();

    // ---------------- 文件 ----------------
    n.push(NodeDescriptor {
        name: "fs.copy".into(),
        label: "复制文件".into(),
        description: "把输入文件复制到输出路径。".into(),
        category: NodeCategory::File,
        requires_engines: vec![],
        optional_engines: vec![],
        inputs: vec![in_file("src", "源文件", &[])],
        outputs: vec![out_file("dst", "目标文件")],
        params: vec![param("overwrite", "覆盖已存在文件", ParamType::Bool, Some(true.into()), false)],
    });
    n.push(NodeDescriptor {
        name: "fs.move".into(),
        label: "移动文件".into(),
        description: "跨目录移动（同盘为 rename，跨盘自动降级为复制+删除）。".into(),
        category: NodeCategory::File,
        requires_engines: vec![],
        optional_engines: vec![],
        inputs: vec![in_file("src", "源文件", &[])],
        outputs: vec![out_file("dst", "目标文件")],
        params: vec![],
    });
    n.push(NodeDescriptor {
        name: "fs.mkdir".into(),
        label: "创建目录".into(),
        description: "递归创建目录。".into(),
        category: NodeCategory::File,
        requires_engines: vec![],
        optional_engines: vec![],
        inputs: vec![],
        outputs: vec![port("dst", "目录", PortType::Directory, false)],
        params: vec![param("path", "目录路径（相对输出目录）", ParamType::Text, None, true)],
    });
    n.push(NodeDescriptor {
        name: "fs.delete".into(),
        label: "删除文件".into(),
        description: "删除文件或空目录。**需要 fsWrite 权限**。".into(),
        category: NodeCategory::File,
        requires_engines: vec![],
        optional_engines: vec![],
        inputs: vec![in_file("src", "待删除", &[])],
        outputs: vec![],
        params: param_many(&[("toTrash", "移到回收站而非永久删除", ParamType::Bool, Some(true.into()))]),
    });

    // ---------------- 图片 ----------------
    n.push(NodeDescriptor {
        name: "image.probe".into(),
        label: "读取图片信息".into(),
        description: "读取尺寸、格式、色彩空间、EXIF。纯 Rust 实现，无需外部引擎。".into(),
        category: NodeCategory::Image,
        requires_engines: vec![],
        optional_engines: vec![],
        inputs: vec![in_file("src", "图片", &["image/*"])],
        outputs: vec![port("info", "信息", PortType::Json, false)],
        params: vec![],
    });
    n.push(NodeDescriptor {
        name: "image.convert".into(),
        label: "图片格式转换".into(),
        description: "在 PNG / JPEG / WebP / BMP / TIFF / GIF 之间互转。\
                      后端按 libvips → ImageMagick → 纯 Rust 依次降级（实际用的哪个写在输出值 `backend` 里）。\
                      **纯 Rust 后端给不了有损压缩** —— 照片想按质量换体积就得有 libvips 或 ImageMagick。".into(),
        category: NodeCategory::Image,
        requires_engines: vec![],
        optional_engines: vec![engine("libvips"), engine("imagemagick")],
        inputs: vec![in_file("src", "图片", &["image/*"])],
        outputs: vec![out_file("dst", "输出图片")],
        params: vec![
            // 注意：默认构建里的纯 Rust 后端**不支持 AVIF**（需要 rav1e，编译数分钟，
            // 走 `toolforge-engines` 的 `avif` feature）。把 avif 列在枚举里会让用户
            // 选到一个必然失败的值，所以这里不列。装了 libvips 后 avif 其实是能转的
            // （`vips_save_option` 里已经给了 `Q=`），但枚举是按**最低可用后端**生成的，
            // 这里保持保守 —— 动态枚举留给 v0.2。
            enum_param("format", "目标格式", "webp", &["png", "jpeg", "webp", "bmp", "tiff", "gif"]),
            range_param("quality", "质量", ParamType::Int, 90.0, 1.0, 100.0),
        ],
    });
    n.push(NodeDescriptor {
        name: "image.resize".into(),
        label: "图片缩放".into(),
        description: "高质量重采样。可只给宽或只给高，另一边按比例推导。\
                      后端按 libvips → ImageMagick → 纯 Rust 降级（实际用的哪个写在输出值 `backend` 里）。\
                      纯 Rust 路径用 Lanczos3，`filter` 参数只在它上面生效。".into(),
        category: NodeCategory::Image,
        requires_engines: vec![],
        optional_engines: vec![engine("libvips"), engine("imagemagick")],
        inputs: vec![in_file("src", "图片", &["image/*"])],
        outputs: vec![out_file("dst", "输出图片")],
        params: vec![
            range_param("width", "宽度（px，0=自动）", ParamType::Int, 0.0, 0.0, 100_000.0),
            range_param("height", "高度（px，0=自动）", ParamType::Int, 0.0, 0.0, 100_000.0),
            enum_param("filter", "重采样算法（仅纯 Rust 后端）", "lanczos3", &["nearest", "triangle", "catmullrom", "gaussian", "lanczos3"]),
        ],
    });
    n.push(NodeDescriptor {
        name: "image.crop".into(),
        label: "裁剪 / 缩略图".into(),
        description: "按坐标裁剪，或按目标尺寸做中心裁剪（cover）。\
                      裁剪矩形先算好再交给后端，所以三个后端切出来的**位置完全一致**。".into(),
        category: NodeCategory::Image,
        requires_engines: vec![],
        optional_engines: vec![engine("libvips"), engine("imagemagick")],
        inputs: vec![in_file("src", "图片", &["image/*"])],
        outputs: vec![out_file("dst", "输出图片")],
        params: vec![
            enum_param("mode", "裁剪模式", "center", &["center", "custom", "smart"]),
            range_param("width", "宽度", ParamType::Int, 512.0, 1.0, 100_000.0),
            range_param("height", "高度", ParamType::Int, 512.0, 1.0, 100_000.0),
            range_param("x", "左上角 X（mode=custom 时生效）", ParamType::Int, 0.0, 0.0, 100_000.0),
            range_param("y", "左上角 Y（mode=custom 时生效）", ParamType::Int, 0.0, 0.0, 100_000.0),
        ],
    });
    n.push(NodeDescriptor {
        name: "image.rotate".into(),
        label: "旋转 / 翻转".into(),
        description: "任意角度旋转、水平/垂直镜像。\
                      90° 整数倍三个后端都能做；**任意角度必须有 libvips 或 ImageMagick**\
                      （纯 Rust 需要重采样，装不了就是明确的报错，不会静默取整）。".into(),
        category: NodeCategory::Image,
        requires_engines: vec![],
        optional_engines: vec![engine("libvips"), engine("imagemagick")],
        inputs: vec![in_file("src", "图片", &["image/*"])],
        outputs: vec![out_file("dst", "输出图片")],
        params: vec![
            param("angle", "角度", ParamType::Float, Some(90.0.into()), false),
            param("flipH", "水平镜像", ParamType::Bool, Some(false.into()), false),
            param("flipV", "垂直镜像", ParamType::Bool, Some(false.into()), false),
            param("autoOrient", "按 EXIF 自动校正方向", ParamType::Bool, Some(true.into()), false),
        ],
    });
    n.push(NodeDescriptor {
        name: "image.enhance".into(),
        label: "图像增强".into(),
        description: "亮度/对比度/饱和度/锐化/降噪。纯 Rust 走内置卷积；装了 libvips 时用其更快的实现。".into(),
        category: NodeCategory::Image,
        requires_engines: vec![],
        optional_engines: vec![engine("libvips")],
        inputs: vec![in_file("src", "图片", &["image/*"])],
        outputs: vec![out_file("dst", "输出图片")],
        params: vec![
            param("brightness", "亮度 (-100..100)", ParamType::Int, Some(0i64.into()), false),
            param("contrast", "对比度 (-100..100)", ParamType::Int, Some(0i64.into()), false),
            param("saturation", "饱和度 (-100..100)", ParamType::Int, Some(0i64.into()), false),
            param("sharpen", "锐化强度 (0..100)", ParamType::Int, Some(0i64.into()), false),
        ],
    });
    n.push(NodeDescriptor {
        name: "image.strip-metadata".into(),
        label: "清除元数据".into(),
        description: "去掉 EXIF / IPTC / XMP。分享图片前用来抹除 GPS 位置等隐私信息。".into(),
        category: NodeCategory::Image,
        requires_engines: vec![],
        optional_engines: vec![engine("libvips"), engine("imagemagick")],
        inputs: vec![in_file("src", "图片", &["image/*"])],
        outputs: vec![out_file("dst", "输出图片")],
        params: vec![],
    });
    n.push(NodeDescriptor {
        name: "image.remove-background".into(),
        label: "抠图去背景".into(),
        description: "AI 抠图（U²-Net / ISNet）。**权重与运行时都不随安装包分发**：\
                      先在「模型权重」里下载一个（u2netp 只要 4.4 MB），\
                      首次运行时会自动准备一个独立 Python 环境装 onnxruntime（约 30 MB）。\
                      之后每张图是本地推理，不联网、不上传图片。".into(),
        category: NodeCategory::Image,
        // onnx-models 是虚拟引擎（权重的宿主），python 是推理运行时。
        // 两个都是**必需**的：少任何一个这个节点都跑不起来，所以不能放进 optional。
        requires_engines: vec![engine("python"), engine("onnx-models")],
        optional_engines: vec![],
        inputs: vec![in_file("src", "图片", &["image/*"])],
        outputs: vec![out_file("dst", "透明背景 PNG")],
        params: vec![
            // 默认给最轻的 u2netp：4.4 MB 就能试，而 u2net 是 168 MB。
            // "先让它跑起来"比"一上来就要下 168 MB"重要得多。
            enum_param("model", "模型", "u2netp", &["u2netp", "u2net", "isnet-general"]),
            enum_param("mode", "输出方式", "alpha", &["alpha", "color"]),
            param("background", "替换背景色（mode=color 时生效，如 #FFFFFF）", ParamType::Color, Some("#FFFFFF".into()), false),
            range_param("threshold", "蒙版阈值（0 = 不卡，越大越干净但可能啃掉边缘）", ParamType::Int, 0.0, 0.0, 99.0),
            range_param("feather", "边缘羽化强度（0 = 不羽化）", ParamType::Int, 0.0, 0.0, 50.0),
        ],
    });

    // ---------------- 视频 ----------------
    n.push(NodeDescriptor {
        name: "video.transcode".into(),
        label: "视频转码".into(),
        description: "使用 FFmpeg 转码。可选硬件加速（NVENC / QSV / AMF）。".into(),
        category: NodeCategory::Video,
        requires_engines: vec![engine("ffmpeg")],
        optional_engines: vec![],
        inputs: vec![in_file("src", "视频", &["video/*"])],
        outputs: vec![out_file("dst", "输出视频")],
        params: vec![
            enum_param("container", "容器格式", "mp4", &["mp4", "mkv", "webm", "mov", "avi"]),
            enum_param("vcodec", "视频编码", "libx264", &["libx264", "libx265", "libvpx-vp9", "av1", "copy"]),
            enum_param("acodec", "音频编码", "aac", &["aac", "libopus", "libmp3lame", "copy", "none"]),
            range_param("crf", "质量 CRF（越小越好）", ParamType::Int, 23.0, 0.0, 51.0),
            enum_param("preset", "编码速度", "medium", &["ultrafast", "fast", "medium", "slow", "veryslow"]),
            enum_param("hwaccel", "硬件加速", "none", &["none", "auto", "nvenc", "qsv", "amf", "videotoolbox"]),
        ],
    });
    n.push(NodeDescriptor {
        name: "video.extract-audio".into(),
        label: "提取音频".into(),
        description: "从视频抽出音轨。codec=copy 时为无损秒抽。".into(),
        category: NodeCategory::Video,
        requires_engines: vec![engine("ffmpeg")],
        optional_engines: vec![],
        inputs: vec![in_file("src", "视频", &["video/*"])],
        outputs: vec![out_file("dst", "音频文件")],
        params: vec![
            enum_param("format", "输出格式", "mp3", &["mp3", "aac", "flac", "wav", "opus", "m4a"]),
            range_param("bitrate", "码率 kbps", ParamType::Int, 192.0, 32.0, 512.0),
        ],
    });
    n.push(NodeDescriptor {
        name: "video.thumbnail".into(),
        label: "视频截图".into(),
        description: "在指定时间点抽帧，可一次抽多张（按等间隔）。".into(),
        category: NodeCategory::Video,
        requires_engines: vec![engine("ffmpeg")],
        optional_engines: vec![],
        inputs: vec![in_file("src", "视频", &["video/*"])],
        outputs: vec![out_file("dst", "封面图")],
        params: vec![
            param("at", "时间点（如 00:00:03 / 3.5）", ParamType::Text, Some("00:00:01".into()), false),
            range_param("width", "宽度", ParamType::Int, 1280.0, 16.0, 7680.0),
            enum_param("format", "图片格式", "jpg", &["jpg", "png", "webp"]),
        ],
    });
    n.push(NodeDescriptor {
        name: "video.trim".into(),
        label: "视频剪辑".into(),
        description: "按时间裁剪片段。优先流复制（秒级），必要时重编码。".into(),
        category: NodeCategory::Video,
        requires_engines: vec![engine("ffmpeg")],
        optional_engines: vec![],
        inputs: vec![in_file("src", "视频", &["video/*"])],
        outputs: vec![out_file("dst", "输出视频")],
        params: vec![
            param("start", "起点", ParamType::Text, Some("00:00:00".into()), true),
            param("duration", "时长（留空 = 到结尾）", ParamType::Text, None, false),
            param("reencode", "强制重编码（精确切割）", ParamType::Bool, Some(false.into()), false),
        ],
    });
    n.push(NodeDescriptor {
        name: "video.compress".into(),
        label: "视频压缩".into(),
        description: "两遍压到目标体积附近，适合「发微信 / 上传附件」这类有体积上限的场景。".into(),
        category: NodeCategory::Video,
        requires_engines: vec![engine("ffmpeg")],
        optional_engines: vec![],
        inputs: vec![in_file("src", "视频", &["video/*"])],
        outputs: vec![out_file("dst", "压缩后视频")],
        params: vec![
            param("targetSizeMb", "目标体积 (MB)", ParamType::Float, Some(10.0.into()), true),
            range_param("maxWidth", "最大宽度", ParamType::Int, 1920.0, 64.0, 7680.0),
        ],
    });

    // ---------------- 音频 ----------------
    n.push(NodeDescriptor {
        name: "audio.convert".into(),
        label: "音频格式转换".into(),
        description: "FFmpeg 音频转码。".into(),
        category: NodeCategory::Audio,
        requires_engines: vec![engine("ffmpeg")],
        optional_engines: vec![],
        inputs: vec![in_file("src", "音频", &["audio/*"])],
        outputs: vec![out_file("dst", "输出音频")],
        params: vec![
            enum_param("format", "目标格式", "mp3", &["mp3", "aac", "flac", "wav", "opus", "ogg", "m4a"]),
            range_param("bitrate", "码率 kbps", ParamType::Int, 192.0, 32.0, 512.0),
            range_param("sampleRate", "采样率", ParamType::Int, 44100.0, 8000.0, 192_000.0),
        ],
    });
    n.push(NodeDescriptor {
        name: "audio.normalize".into(),
        label: "音量标准化".into(),
        description: "EBU R128 响度归一，批量处理播客/音乐时非常有用。".into(),
        category: NodeCategory::Audio,
        requires_engines: vec![engine("ffmpeg")],
        optional_engines: vec![],
        inputs: vec![in_file("src", "音频", &["audio/*"])],
        outputs: vec![out_file("dst", "输出音频")],
        // 注意 `(-16.0f64)` 的括号与后缀是必需的：写成 `-16.0.into()` 时
        // Rust 会把它解析成 `-(16.0.into())`，而 ParamValueish 没实现 Neg，
        // 于是推导失败。显式标注字面量类型最省事。
        params: vec![param(
            "lufs",
            "目标响度 (LUFS)",
            ParamType::Float,
            Some((-16.0f64).into()),
            false,
        )],
    });

    // ---------------- 文档 ----------------
    n.push(NodeDescriptor {
        name: "doc.convert".into(),
        label: "文档格式转换".into(),
        description: "Pandoc 支持的任意格式互转（Markdown / HTML / DOCX / EPUB / LaTeX / ODT ...）。".into(),
        category: NodeCategory::Document,
        requires_engines: vec![engine("pandoc")],
        optional_engines: vec![],
        inputs: vec![in_file("src", "文档", &[".md", ".html", ".docx", ".epub", ".tex", ".rst", ".odt", ".txt"])],
        outputs: vec![out_file("dst", "输出文档")],
        params: vec![
            enum_param("to", "目标格式", "pdf_engine", &["md", "html", "docx", "epub", "pdf_engine", "rst", "latex", "odt"]),
            param("standalone", "生成独立文档（带模板）", ParamType::Bool, Some(true.into()), false),
            param("toc", "生成目录", ParamType::Bool, Some(false.into()), false),
            param("extraArgs", "额外 pandoc 参数", ParamType::Text, Some("".into()), false),
        ],
    });
    n.push(NodeDescriptor {
        name: "doc.to-pdf".into(),
        label: "转 PDF（Office）".into(),
        description: "用 LibreOffice headless 把 Word / Excel / PPT 转 PDF。\
                      首次调用会启动常驻 listener（冷启动 2~5 秒），之后复用进程。".into(),
        category: NodeCategory::Document,
        requires_engines: vec![engine("libreoffice")],
        optional_engines: vec![],
        inputs: vec![in_file("src", "Office 文档", &[".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp"])],
        outputs: vec![out_file("dst", "PDF")],
        params: vec![enum_param("format", "目标格式", "pdf", &["pdf", "pdf/a", "html", "txt"])],
    });
    n.push(NodeDescriptor {
        name: "doc.ocr".into(),
        label: "OCR 文字识别".into(),
        description: "图片/扫描件转文字。默认走系统 OCR，装了 PaddleOCR 时质量更高。".into(),
        category: NodeCategory::Document,
        requires_engines: vec![engine("python")],
        optional_engines: vec![engine("tesseract")],
        inputs: vec![in_file("src", "图片或 PDF", &["image/*", ".pdf"])],
        outputs: vec![port("text", "识别文本", PortType::Text, false)],
        params: vec![
            enum_param("engine", "识别引擎", "auto", &["auto", "tesseract", "paddleocr"]),
            param("lang", "语言", ParamType::Text, Some("chi_sim+eng".into()), false),
        ],
    });

    // ---------------- 压缩包 ----------------
    n.push(NodeDescriptor {
        name: "archive.pack".into(),
        label: "打包压缩".into(),
        description: "7-Zip 打包。zip 格式兼容性最好；7z 压缩率最高。".into(),
        category: NodeCategory::Archive,
        requires_engines: vec![engine("7zip")],
        optional_engines: vec![],
        inputs: vec![port("src", "输入文件/目录", PortType::Files, true)],
        outputs: vec![out_file("dst", "压缩包")],
        params: vec![
            enum_param("format", "格式", "zip", &["zip", "7z", "tar", "tar.gz", "tar.xz"]),
            range_param("level", "压缩级别 0-9", ParamType::Int, 5.0, 0.0, 9.0),
            param("password", "密码（留空 = 不加密）", ParamType::Text, Some("".into()), false),
        ],
    });
    n.push(NodeDescriptor {
        name: "archive.unpack".into(),
        label: "解压".into(),
        description: "自动识别格式解压。**内置 Zip Slip 防护**：拒绝解出到目标目录之外的条目。".into(),
        category: NodeCategory::Archive,
        requires_engines: vec![engine("7zip")],
        optional_engines: vec![],
        inputs: vec![in_file("src", "压缩包", &[".zip", ".7z", ".rar", ".tar", ".gz", ".xz", ".bz2"])],
        outputs: vec![port("dst", "输出目录", PortType::Directory, false)],
        params: vec![
            param("password", "密码", ParamType::Text, Some("".into()), false),
            param("keepStructure", "保留目录结构", ParamType::Bool, Some(true.into()), false),
        ],
    });

    // ---------------- 电子书 ----------------
    n.push(NodeDescriptor {
        name: "ebook.convert".into(),
        label: "电子书转换".into(),
        description: "EPUB / MOBI / AZW3 / PDF 互转。优先 Calibre，缺失时降级到 Pandoc（仅 EPUB/HTML）。".into(),
        category: NodeCategory::Ebook,
        requires_engines: vec![],
        optional_engines: vec![engine("calibre"), engine("pandoc")],
        inputs: vec![in_file("src", "电子书", &[".epub", ".mobi", ".azw3", ".pdf", ".fb2", ".txt"])],
        outputs: vec![out_file("dst", "输出电子书")],
        params: vec![
            enum_param("format", "目标格式", "epub", &["epub", "mobi", "azw3", "pdf", "txt"]),
            param("title", "书名（覆盖元数据）", ParamType::Text, Some("".into()), false),
            param("author", "作者", ParamType::Text, Some("".into()), false),
        ],
    });

    // ---------------- AI ----------------
    n.push(NodeDescriptor {
        name: "ai.upscale".into(),
        label: "AI 超分辨率".into(),
        description: "Real-ESRGAN / SwinIR 放大图片，比传统插值保留更多细节。需要下载模型。".into(),
        category: NodeCategory::Ai,
        requires_engines: vec![engine("python"), engine("onnx-models")],
        optional_engines: vec![],
        inputs: vec![in_file("src", "图片", &["image/*"])],
        outputs: vec![out_file("dst", "放大后图片")],
        params: vec![
            // 枚举必须与 `engine_catalog()` 里 `onnx-models` 的模型表一致 ——
            // 列出目录里没有的模型 = 用户选到一个永远下不到的模型。
            // 更多超分模型（x2plus / SwinIR / HAT）随 v0.2 的执行器一起接入。
            enum_param("model", "模型", "realesrgan-x4plus", &["realesrgan-x4plus"]),
            range_param("scale", "放大倍数", ParamType::Int, 2.0, 2.0, 4.0),
        ],
    });
    n.push(NodeDescriptor {
        name: "ai.describe".into(),
        label: "AI 图像描述".into(),
        description: "调用多模态模型生成图片描述 / 标签，可用于自动重命名与归档。".into(),
        category: NodeCategory::Ai,
        requires_engines: vec![engine("ai-provider")],
        optional_engines: vec![],
        inputs: vec![in_file("src", "图片", &["image/*"])],
        outputs: vec![port("text", "描述", PortType::Text, false)],
        params: vec![
            param("instruction", "提示词", ParamType::Textarea, Some("用一句中文描述这张图片，并给出5个标签".into()), false),
            param("maxTokens", "最大输出长度", ParamType::Int, Some(512i64.into()), false),
        ],
    });

    // ---------------- 文本 / 命名（纯计算，供其它节点消费）----------------
    //
    // 这一族节点解决的是 L1 的一个结构性短板：**原来没有任何节点能"算出一个值"**。
    // 所有节点要么读写文件、要么调引擎，于是像"批量重命名"这种需要
    // "根据规则算出新文件名"的需求根本无法用声明式表达 ——
    // `plugins/builtin/batch-rename` 就因此退化成了一句 `fs.move`，
    // 声明的 regex / 前缀 / 后缀 / 序号参数全是装饰。
    n.push(NodeDescriptor {
        name: "text.replace".into(),
        label: "文本替换".into(),
        description: "对字符串做查找替换，支持正则与大小写控制。\
                      纯计算、不碰文件，输出可被 `${steps.<id>.text}` 引用。".into(),
        category: NodeCategory::Text,
        requires_engines: vec![],
        optional_engines: vec![],
        inputs: vec![],
        outputs: vec![port("text", "结果", PortType::Text, false)],
        params: vec![
            param("input", "输入文本（通常写 ${src.stem}）", ParamType::Text, None, true),
            param("pattern", "查找内容（正则或字面量）", ParamType::Text, None, true),
            param("replacement", "替换为", ParamType::Text, Some("".into()), false),
            param("useRegex", "按正则解释 pattern", ParamType::Bool, Some(true.into()), false),
            param("caseSensitive", "区分大小写", ParamType::Bool, Some(true.into()), false),
            param("all", "替换全部（关掉只替换第一个）", ParamType::Bool, Some(true.into()), false),
        ],
    });
    n.push(NodeDescriptor {
        name: "name.build".into(),
        label: "拼装文件名".into(),
        description: "把主干、扩展名、前缀、后缀、序号拼成一个**文件名**（不含目录）。\
                      纯计算。把它接到 `fs.move` 的 `dst` 上即可完成重命名 —— \
                      因为输出的是相对路径，宿主会把它解析到输出目录内。".into(),
        category: NodeCategory::Text,
        requires_engines: vec![],
        optional_engines: vec![],
        inputs: vec![],
        outputs: vec![port("value", "文件名", PortType::Text, false)],
        params: vec![
            param("stem", "主干（通常写 ${src.stem}）", ParamType::Text, None, true),
            param("ext", "扩展名（含点，通常写 ${src.ext}）", ParamType::Text, Some("".into()), false),
            param("prefix", "前缀", ParamType::Text, Some("".into()), false),
            param("suffix", "后缀（插在扩展名之前）", ParamType::Text, Some("".into()), false),
            param("index", "序号（0 = 不追加；可写 ${batch.index}）", ParamType::Int, Some(0i64.into()), false),
            param("indexPad", "序号补零位数", ParamType::Int, Some(3i64.into()), false),
            param("indexSeparator", "序号与主体的分隔符", ParamType::Text, Some("-".into()), false),
            enum_param("indexPosition", "序号位置", "suffix", &["suffix", "prefix"]),
            enum_param("case", "大小写", "keep", &["keep", "lower", "upper", "title"]),
            param("separator", "把空格等替换成该字符（留空 = 不动）", ParamType::Text, Some("".into()), false),
        ],
    });

    // ---------------- 流程控制 ----------------
    n.push(NodeDescriptor {
        name: "flow.branch".into(),
        label: "条件分支".into(),
        description: "按条件把数据分流到 true / false 两个出口。".into(),
        category: NodeCategory::Flow,
        requires_engines: vec![],
        optional_engines: vec![],
        inputs: vec![port("in", "输入", PortType::Any, true)],
        outputs: vec![
            port("true", "成立", PortType::Any, false),
            port("false", "不成立", PortType::Any, false),
        ],
        params: vec![param("condition", "条件表达式", ParamType::Text, None, true)],
    });
    n.push(NodeDescriptor {
        name: "flow.set-var".into(),
        label: "设置变量".into(),
        description: "把值写入流水线变量，供后续步骤通过 `${vars.名称}` 引用。".into(),
        category: NodeCategory::Flow,
        requires_engines: vec![],
        optional_engines: vec![],
        inputs: vec![],
        outputs: vec![port("out", "值", PortType::Any, false)],
        params: vec![
            param("name", "变量名", ParamType::Text, None, true),
            param("value", "值", ParamType::Text, None, true),
        ],
    });
    n.push(NodeDescriptor {
        name: "flow.log".into(),
        label: "写日志".into(),
        description: "向任务日志写入一条消息。调试流水线时最常用。".into(),
        category: NodeCategory::Flow,
        requires_engines: vec![],
        optional_engines: vec![],
        inputs: vec![],
        outputs: vec![],
        params: vec![
            param("message", "消息", ParamType::Text, None, true),
            enum_param("level", "级别", "info", &["debug", "info", "warn", "error"]),
        ],
    });

    n
}

/// 便捷：一次构造多个参数
fn param_many(items: &[(&str, &str, ParamType, Option<ParamValueish>)]) -> Vec<ParamSpec> {
    items
        .iter()
        .map(|(id, label, ty, def)| param(id, label, *ty, def.clone(), false))
        .collect()
}

fn range_param(
    id: &str,
    label: &str,
    ty: ParamType,
    default: f64,
    min: f64,
    max: f64,
) -> ParamSpec {
    let mut p = param(
        id,
        label,
        ty,
        Some(if ty == ParamType::Int {
            (default as i64).into()
        } else {
            default.into()
        }),
        false,
    );
    p.min = Some(min);
    p.max = Some(max);
    p.step = Some(1.0);
    p
}

/// 按名字查节点
pub fn find_node(name: &str) -> Option<NodeDescriptor> {
    builtin_nodes().into_iter().find(|n| n.name == name)
}

/// 节点目录里出现的全部引擎名（去重），供引擎面板展示"哪些能力被哪些节点用到"
pub fn engines_referenced() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for node in builtin_nodes() {
        for e in node.requires_engines.iter().chain(node.optional_engines.iter()) {
            if !out.contains(e) {
                out.push(e.clone());
            }
        }
    }
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_builtin_node_has_unique_name_and_nonempty_label() {
        let nodes = builtin_nodes();
        assert!(nodes.len() >= 20, "节点太少：{}", nodes.len());
        let mut seen = std::collections::HashSet::new();
        for n in &nodes {
            assert!(seen.insert(n.name.clone()), "节点名重复：{}", n.name);
            assert!(!n.label.is_empty(), "{} 缺 label", n.name);
            assert!(!n.description.is_empty(), "{} 缺 description", n.name);
            // 参数 id 唯一
            let mut pseen = std::collections::HashSet::new();
            for p in &n.params {
                assert!(pseen.insert(p.id.clone()), "{} 参数重复：{}", n.name, p.id);
            }
            // enum 参数必须有 options
            for p in &n.params {
                if p.ty == ParamType::Enum {
                    assert!(!p.options.is_empty(), "{} 的 {} 是 enum 但没 options", n.name, p.id);
                }
            }
        }
    }

    #[test]
    fn unimplemented_list_only_contains_registered_nodes() {
        // 名单里写错一个名字（比如节点被改名/删掉了）会让"未实现"提示
        // 落在空气上，同时真正没实现的节点被当成可用 —— 两种都是误导。
        let known: std::collections::HashSet<String> =
            builtin_nodes().into_iter().map(|n| n.name).collect();
        for name in UNIMPLEMENTED_NODES {
            assert!(
                known.contains(*name),
                "UNIMPLEMENTED_NODES 里的 `{name}` 不在节点目录中 —— 名字写错了或节点已删除"
            );
        }
    }

    #[test]
    fn is_implemented_is_the_complement_of_the_list() {
        for node in builtin_nodes() {
            let expected = !UNIMPLEMENTED_NODES.contains(&node.name.as_str());
            assert_eq!(
                is_implemented(&node.name),
                expected,
                "`{}` 的实现状态与名单不一致",
                node.name
            );
        }
    }

    #[test]
    fn template_extraction() {
        let vars = extract_vars("${src} -> ${params.width}px, ${steps.probe.width}");
        assert_eq!(
            vars,
            vec!["src", "params.width", "steps.probe.width"]
        );
    }

    #[test]
    fn template_rendering_substitutes() {
        let mut ctx = TemplateContext::new();
        ctx.insert("src", "/input/a.png");
        ctx.insert("params.width", "1280");
        let out = render_template("scale ${params.width} ${src}", &ctx).unwrap();
        assert_eq!(out, "scale 1280 /input/a.png");
    }

    #[test]
    fn unresolved_variable_is_error_not_empty_string() {
        let ctx = TemplateContext::new();
        let err = render_template("${nope}", &ctx).unwrap_err();
        assert!(err.message.contains("nope"));
    }

    #[test]
    fn utf8_survives_rendering() {
        let ctx = TemplateContext::new();
        let out = render_template("中文前缀 ${x} 中文后缀", &ctx);
        // 变量没解析应当报错，而不是把中文切断
        assert!(out.is_err());
        let mut ctx2 = TemplateContext::new();
        ctx2.insert("x", "值");
        assert_eq!(render_template("中文 ${x} 尾", &ctx2).unwrap(), "中文 值 尾");
    }

    #[test]
    fn condition_eval() {
        let mut ctx = TemplateContext::new();
        ctx.insert("params.mode", "fast");
        assert!(eval_condition("${params.mode} == fast", &ctx).unwrap());
        assert!(!eval_condition("${params.mode} != fast", &ctx).unwrap());
        assert!(eval_condition("${params.mode}", &ctx).unwrap());
        ctx.insert("params.empty", "");
        assert!(!eval_condition("${params.empty}", &ctx).unwrap());
    }

    #[test]
    fn pipeline_rejects_unknown_node() {
        let p = PipelineDef {
            steps: vec![PipelineStep {
                id: "s1".into(),
                uses: "does.not.exist".into(),
                with: Default::default(),
                label: None,
                when: None,
                on_error: None,
                retry: 0,
                timeout_ms: None,
                position: None,
                depends_on: vec![],
            }],
            ..Default::default()
        };
        let mut issues = Vec::new();
        p.validate_into(&mut issues);
        assert!(issues.iter().any(|i| i.code == "STEP_UNKNOWN_NODE"));
    }

    #[test]
    fn pipeline_rejects_forward_reference() {
        let mk = |id: &str, uses: &str, with: &[(&str, &str)], deps: &[&str]| PipelineStep {
            id: id.into(),
            uses: uses.into(),
            with: with
                .iter()
                .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                .collect(),
            label: None,
            when: None,
            on_error: None,
            retry: 0,
            timeout_ms: None,
            position: None,
            depends_on: deps.iter().map(|s| (*s).to_string()).collect(),
        };

        let p = PipelineDef {
            steps: vec![
                mk("a", "fs.copy", &[("x", "${steps.b.y}")], &[]),
                mk("b", "fs.copy", &[], &[]),
            ],
            ..Default::default()
        };
        let mut issues = Vec::new();
        p.validate_into(&mut issues);
        assert!(
            issues.iter().any(|i| i.code == "TEMPLATE_FORWARD_REF"),
            "issues: {issues:?}"
        );
    }

    #[test]
    fn required_engines_are_collected_from_steps() {
        let p = PipelineDef {
            steps: vec![
                PipelineStep {
                    id: "t".into(),
                    uses: "video.transcode".into(),
                    with: Default::default(),
                    label: None,
                    when: None,
                    on_error: None,
                    retry: 0,
                    timeout_ms: None,
                    position: None,
                    depends_on: vec![],
                },
                PipelineStep {
                    id: "c".into(),
                    uses: "image.convert".into(),
                    with: Default::default(),
                    label: None,
                    when: None,
                    on_error: None,
                    retry: 0,
                    timeout_ms: None,
                    position: None,
                    depends_on: vec![],
                },
            ],
            ..Default::default()
        };
        let req = p.required_engines();
        assert_eq!(req, vec!["ffmpeg".to_string()]);
        // libvips 是可选引擎，不应该出现在必需列表里
        assert!(p.optional_engines().contains(&"libvips".to_string()));
    }
}
