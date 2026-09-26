//! # 插件清单 schema（`toolforge/v1`）
//!
//! 一份清单就是一个插件的**全部契约**：它要什么权限、输入输出长什么样、
//! 用什么运行时执行。UI 表单、流程编辑器端口、AI 生成校验器全部从它派生 ——
//! 这是"扩展性第一优先级"能成立的原因：加功能 = 加一个目录，主程序零改动。
//!
//! ## 三种运行时
//!
//! | 运行时 | 载体 | 能力边界 | 典型用途 |
//! |---|---|---|---|
//! | [`PluginRuntime::Pipeline`] (L1) | YAML 编排内置节点 | 受限于内置节点 | 格式转换、批量重命名等"组合现有引擎"的需求 |
//! | [`PluginRuntime::Wasm`] (L2) | Extism WASM | **纯计算**：无文件系统、无网络、无 SIMD/线程 | 文本变换、哈希、编码解码、规则计算 |
//! | [`PluginRuntime::Python`] (L3) | 独立 Python 进程 + JSON-RPC | 受 [`crate::permission`] 约束 | AI 推理、重模型、需要生态库的场景 |
//!
//! **重要边界**：L2 做不了图像解码/缩放这类事（WASM 里没有文件系统也没有 SIMD）。
//! 如果 AI 给你生成了一个"用 WASM 抠图"的插件，那是错的 —— 校验器会直接拒掉。

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::error::{ToolforgeError, ToolforgeResult};
use crate::permission::{PathScope, PermissionSet, RiskLevel};
use crate::pipeline::PipelineDef;

/// 插件清单根结构（`plugin.yaml`）
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    /// 必须等于 [`crate::PLUGIN_API_VERSION`]
    pub api_version: String,
    /// 固定为 `Plugin`
    pub kind: String,
    pub metadata: PluginMetadata,
    /// 能力声明。**声明不等于授权**，见 `permission` 模块文档。
    #[serde(default)]
    pub permissions: PermissionSet,
    #[serde(default)]
    pub io: PluginIo,
    pub runtime: PluginRuntime,
    /// AI 生成溯源信息。人工手写的插件此字段为 `None`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai: Option<AiProvenance>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginMetadata {
    /// 全局唯一，建议反向域名，例如 `com.toolforge.builtin.image-convert`
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    /// Lucide 图标名
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default)]
    pub category: PluginCategory,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum PluginCategory {
    Image,
    Audio,
    Video,
    Document,
    Archive,
    Ebook,
    Text,
    Dev,
    Ai,
    System,
    #[default]
    Other,
}

impl PluginCategory {
    pub fn describe(self) -> &'static str {
        match self {
            PluginCategory::Image => "图片",
            PluginCategory::Audio => "音频",
            PluginCategory::Video => "视频",
            PluginCategory::Document => "文档",
            PluginCategory::Archive => "压缩包",
            PluginCategory::Ebook => "电子书",
            PluginCategory::Text => "文本",
            PluginCategory::Dev => "开发辅助",
            PluginCategory::Ai => "AI",
            PluginCategory::System => "系统",
            PluginCategory::Other => "其它",
        }
    }
}

// ============================================================================
// 输入 / 输出 / 参数
// ============================================================================

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginIo {
    /// 数据输入端口（流程编辑器里画在左侧的连接点）
    #[serde(default)]
    pub inputs: Vec<IoPort>,
    /// 数据输出端口（右侧连接点）
    #[serde(default)]
    pub outputs: Vec<IoPort>,
    /// 用户可调参数（UI 自动生成表单）
    #[serde(default)]
    pub params: Vec<ParamSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IoPort {
    pub id: String,
    pub label: String,
    #[serde(rename = "type")]
    pub ty: PortType,
    /// MIME 或扩展名通配，例如 `["image/*", ".png"]`；空表示不限
    #[serde(default)]
    pub accept: Vec<String>,
    #[serde(default)]
    pub multiple: bool,
    #[serde(default)]
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PortType {
    File,
    Files,
    Directory,
    Text,
    Number,
    Boolean,
    Json,
    /// 任意类型（流程编辑器里用虚线连接）
    Any,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ParamSpec {
    pub id: String,
    pub label: String,
    #[serde(rename = "type")]
    pub ty: ParamType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<ParamValue>,
    /// `enum` 类型的候选值
    #[serde(default)]
    pub options: Vec<ParamOption>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<f64>,
    #[serde(default)]
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    /// 文本参数是否用多行输入框
    #[serde(default)]
    pub multiline: bool,
    /// 该参数变化时是否需要重新探测输入（用于 UI 联动）
    #[serde(default)]
    pub affects_output: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ParamType {
    Text,
    Textarea,
    Int,
    Float,
    Bool,
    Enum,
    /// 多选枚举
    MultiEnum,
    /// 用户选择文件/目录（由宿主弹原生对话框，插件拿到的是逻辑路径）
    Path,
    Directory,
    Color,
    /// 逗号分隔的键值对，例如 `-vf scale=1280:-1`
    KeyValue,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ParamOption {
    pub value: String,
    pub label: String,
}

/// 参数取值。刻意不用 `serde_json::Value` —— 显式枚举能让 specta 导出成
/// TS 可判别联合，前端做表单绑定时不需要 `any`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum ParamValue {
    Str(String),
    Int(i64),
    Float(f64),
    Bool(bool),
    List(Vec<String>),
}

impl ParamValue {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            ParamValue::Str(s) => Some(s),
            _ => None,
        }
    }
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            ParamValue::Bool(b) => Some(*b),
            _ => None,
        }
    }
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            ParamValue::Int(i) => Some(*i),
            ParamValue::Float(f) => Some(*f as i64),
            _ => None,
        }
    }
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            ParamValue::Float(f) => Some(*f),
            ParamValue::Int(i) => Some(*i as f64),
            _ => None,
        }
    }
    pub fn as_list(&self) -> Option<&[String]> {
        match self {
            ParamValue::List(l) => Some(l),
            _ => None,
        }
    }
}

// ============================================================================
// 运行时定义
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PluginRuntime {
    /// L1：YAML 声明式编排，零代码
    Pipeline { pipeline: PipelineDef },
    /// L2：Extism WASM 沙箱，纯计算
    Wasm { wasm: WasmRuntimeDef },
    /// L3：Python 独立进程 + JSON-RPC over stdio
    Python { python: PythonRuntimeDef },
}

impl PluginRuntime {
    pub fn kind(&self) -> RuntimeKind {
        match self {
            PluginRuntime::Pipeline { .. } => RuntimeKind::Pipeline,
            PluginRuntime::Wasm { .. } => RuntimeKind::Wasm,
            PluginRuntime::Python { .. } => RuntimeKind::Python,
        }
    }

    /// L2/L3 是否要求插件自带可执行产物（决定"能否仅凭清单装载"）
    pub fn requires_artifact(&self) -> bool {
        !matches!(self, PluginRuntime::Pipeline { .. })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeKind {
    Pipeline,
    Wasm,
    Python,
}

impl RuntimeKind {
    pub fn describe(self) -> &'static str {
        match self {
            RuntimeKind::Pipeline => "L1 · 声明式编排",
            RuntimeKind::Wasm => "L2 · WASM 沙箱",
            RuntimeKind::Python => "L3 · Python 进程",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WasmRuntimeDef {
    /// 相对于插件目录的 wasm 文件名
    pub path: String,
    /// 导出函数名
    #[serde(default = "default_wasm_entry")]
    pub entry: String,
    /// 内存上限（MB）
    #[serde(default = "default_wasm_memory")]
    pub memory_limit_mb: u32,
    /// 单次调用超时（毫秒）。WASM 是纯计算，超时说明插件写挂了。
    #[serde(default = "default_wasm_timeout")]
    pub timeout_ms: u64,
    /// 允许调用的宿主函数白名单。**默认空 = 完全沙箱，不能碰任何宿主资源。**
    /// 可选项只有 `"log"` 和 `"kv"`（插件私有键值存储）。
    #[serde(default)]
    pub allow_host_functions: Vec<String>,
}

fn default_wasm_entry() -> String {
    "run".into()
}
fn default_wasm_memory() -> u32 {
    64
}
fn default_wasm_timeout() -> u64 {
    5_000
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PythonRuntimeDef {
    /// 入口脚本，相对于插件目录
    pub entry: String,
    /// 期望的 Python 版本（宿主用它挑选 sidecar 运行时）
    #[serde(default = "default_py_version")]
    pub python_version: String,
    /// pip 依赖，首次运行时由宿主在**插件独立的 venv** 里安装
    #[serde(default)]
    pub requirements: Vec<String>,
    #[serde(default = "default_py_timeout")]
    pub timeout_ms: u64,
    /// 进程数（模型加载很贵时 >1 才有意义；一般 1 个常驻进程即可）
    #[serde(default = "default_py_workers")]
    pub workers: u32,
    /// 是否允许该进程出网。**默认 false**，需要走 [`PermissionSet`] 里的 Net 能力显式授权。
    #[serde(default)]
    pub allow_network: bool,
}

fn default_py_version() -> String {
    "3.11".into()
}
fn default_py_timeout() -> u64 {
    300_000
}
fn default_py_workers() -> u32 {
    1
}

// ============================================================================
// AI 溯源
// ============================================================================

/// 记录"这个插件是 AI 生成的"，以及人工审核的状态。
///
/// 宿主**不会**因为 `reviewedAt` 有值就自动放行 —— 放行的唯一依据是
/// 用户授予的 [`PermissionSet`]。这里只是审计线索。
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiProvenance {
    pub generated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    /// ISO-8601
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewed_at: Option<String>,
    /// 内容哈希（`sha256:...`）。装载前校验，防止装载后被替换。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_hash: Option<String>,
}

// ============================================================================
// 清单解析与校验
// ============================================================================

impl PluginManifest {
    /// 从 YAML 解析
    pub fn from_yaml(yaml: &str) -> ToolforgeResult<Self> {
        let manifest: PluginManifest = serde_yaml::from_str(yaml).map_err(|e| {
            ToolforgeError::plugin_invalid("插件清单 YAML 解析失败").with_detail(e.to_string())
        })?;
        Ok(manifest)
    }

    pub fn to_yaml(&self) -> ToolforgeResult<String> {
        serde_yaml::to_string(self)
            .map_err(|e| ToolforgeError::internal(format!("清单序列化失败：{e}")))
    }

    /// 静态校验。
    ///
    /// 这个函数是**纯的**（不碰磁盘、不联网），因此可以被 AI 生成流程在写盘之前调用 ——
    /// 这是"先校验再落盘"的关键：AI 的产出必须过这一关才有机会被用户看到。
    pub fn validate(&self) -> ValidationReport {
        let mut issues = Vec::new();

        // --- 协议版本 ---
        if self.api_version != crate::PLUGIN_API_VERSION {
            issues.push(ValidationIssue::error(
                "API_VERSION_MISMATCH",
                format!(
                    "清单 apiVersion 为 `{}`，当前宿主只支持 `{}`",
                    self.api_version,
                    crate::PLUGIN_API_VERSION
                ),
            ));
        }
        if self.kind != "Plugin" {
            issues.push(ValidationIssue::error(
                "KIND_INVALID",
                format!("kind 必须为 `Plugin`，实际为 `{}`", self.kind),
            ));
        }

        // --- 元数据 ---
        let id = &self.metadata.id;
        if id.trim().is_empty() {
            issues.push(ValidationIssue::error("ID_EMPTY", "metadata.id 不能为空"));
        } else if !is_valid_plugin_id(id) {
            issues.push(ValidationIssue::error(
                "ID_FORMAT",
                format!("metadata.id `{id}` 非法：只允许小写字母、数字、`.`、`-`、`_`，且长度 3..=128"),
            ));
        }
        if self.metadata.name.trim().is_empty() {
            issues.push(ValidationIssue::error("NAME_EMPTY", "metadata.name 不能为空"));
        }
        if semver::Version::parse(&self.metadata.version).is_err() {
            issues.push(ValidationIssue::error(
                "VERSION_INVALID",
                format!("metadata.version `{}` 不是合法 semver", self.metadata.version),
            ));
        }

        // --- 运行时 ---
        self.validate_runtime(&mut issues);

        // --- IO 自洽性 ---
        let mut seen = std::collections::HashSet::new();
        for port in self.io.inputs.iter().chain(self.io.outputs.iter()) {
            if !seen.insert(port.id.clone()) {
                issues.push(ValidationIssue::error(
                    "IO_DUPLICATE_ID",
                    format!("输入/输出端口 id `{}` 重复", port.id),
                ));
            }
            if port.id.trim().is_empty() {
                issues.push(ValidationIssue::error("IO_EMPTY_ID", "端口 id 不能为空"));
            }
        }
        let mut pseen = std::collections::HashSet::new();
        for p in &self.io.params {
            if !pseen.insert(p.id.clone()) {
                issues.push(ValidationIssue::error(
                    "PARAM_DUPLICATE_ID",
                    format!("参数 id `{}` 重复", p.id),
                ));
            }
            if p.ty == ParamType::Enum && p.options.is_empty() {
                issues.push(ValidationIssue::error(
                    "ENUM_WITHOUT_OPTIONS",
                    format!("参数 `{}` 是 enum 但未提供 options", p.id),
                ));
            }
            if let (Some(min), Some(max)) = (p.min, p.max) {
                if min > max {
                    issues.push(ValidationIssue::error(
                        "PARAM_RANGE_INVERTED",
                        format!("参数 `{}` 的 min({min}) 大于 max({max})", p.id),
                    ));
                }
            }
            if let Some(default) = &p.default {
                if !p.accepts(default) {
                    issues.push(ValidationIssue::warning(
                        "PARAM_DEFAULT_TYPE",
                        format!("参数 `{}` 的默认值与声明类型不匹配", p.id),
                    ));
                }
            }
        }

        // --- 权限与运行时的匹配（安全相关，必须报错而非警告）---
        if let PluginRuntime::Python { python } = &self.runtime {
            if python.allow_network && !self.permissions.wants_network() {
                issues.push(ValidationIssue::error(
                    "PYTHON_NET_WITHOUT_PERMISSION",
                    "python.allowNetwork = true 但 permissions 里没有声明 net 能力",
                ));
            }
        }

        // --- 高危权限提示 ---
        for cap in &self.permissions.capabilities {
            if cap.risk() == RiskLevel::Critical {
                issues.push(ValidationIssue::warning(
                    "CRITICAL_CAPABILITY",
                    format!("插件申请了极高风险能力：{}", cap.describe()),
                ));
            }
            if let crate::permission::Capability::FsWrite {
                scope: PathScope::Explicit { pattern: glob },
            } = cap
            {
                issues.push(ValidationIssue::warning(
                    "HOST_PATH_WRITE",
                    format!("插件申请直接写宿主机路径：{glob}"),
                ));
            }
        }

        ValidationReport::from_issues(issues)
    }

    fn validate_runtime(&self, issues: &mut Vec<ValidationIssue>) {
        match &self.runtime {
            PluginRuntime::Pipeline { pipeline } => {
                pipeline.validate_into(issues);
            }
            PluginRuntime::Wasm { wasm } => {
                if wasm.path.trim().is_empty() {
                    issues.push(ValidationIssue::error("WASM_PATH_EMPTY", "wasm.path 不能为空"));
                }
                if !wasm.path.ends_with(".wasm") {
                    issues.push(ValidationIssue::warning(
                        "WASM_EXT",
                        "wasm.path 建议以 .wasm 结尾",
                    ));
                }
                if wasm.memory_limit_mb == 0 || wasm.memory_limit_mb > 4096 {
                    issues.push(ValidationIssue::error(
                        "WASM_MEMORY_RANGE",
                        "wasm.memoryLimitMb 必须在 1..=4096 之间",
                    ));
                }
                if wasm.timeout_ms == 0 {
                    issues.push(ValidationIssue::error(
                        "WASM_TIMEOUT",
                        "wasm.timeoutMs 必须大于 0（WASM 是纯计算，不允许无限运行）",
                    ));
                }
                for f in &wasm.allow_host_functions {
                    if f != "log" && f != "kv" {
                        issues.push(ValidationIssue::error(
                            "WASM_HOST_FN_UNKNOWN",
                            format!(
                                "wasm.allowHostFunctions 含未知宿主函数 `{f}`；只支持 `log` 与 `kv`"
                            ),
                        ));
                    }
                }
                // L2 的能力边界提醒：如果插件声明了 fs/net 却选了 WASM 运行时，几乎肯定是设计错了
                if !self.permissions.is_empty() {
                    issues.push(ValidationIssue::warning(
                        "WASM_WITH_PERMISSIONS",
                        "WASM 运行时无法访问文件系统与网络，声明 fs/net 权限通常是多余或设计错误",
                    ));
                }
            }
            PluginRuntime::Python { python } => {
                if python.entry.trim().is_empty() {
                    issues.push(ValidationIssue::error("PY_ENTRY_EMPTY", "python.entry 不能为空"));
                }
                if !python.entry.ends_with(".py") {
                    issues.push(ValidationIssue::warning(
                        "PY_ENTRY_EXT",
                        "python.entry 建议以 .py 结尾",
                    ));
                }
                for req in &python.requirements {
                    if req.trim().is_empty() {
                        issues.push(ValidationIssue::error(
                            "PY_REQ_EMPTY",
                            "python.requirements 含空条目",
                        ));
                    }
                    // 允许 `pkg`、`pkg==1.2`、`pkg>=1.2,<2`；拒绝带 URL / VCS / 本地路径的写法
                    if req.contains("://") || req.starts_with("-") || req.contains(" @ ") {
                        issues.push(ValidationIssue::error(
                            "PY_REQ_UNSAFE",
                            format!("python.requirements 含不安全条目 `{req}`：禁止 URL / VCS / 本地路径依赖"),
                        ));
                    }
                }
                if python.workers == 0 || python.workers > 8 {
                    issues.push(ValidationIssue::error(
                        "PY_WORKERS_RANGE",
                        "python.workers 必须在 1..=8 之间",
                    ));
                }
            }
        }
    }
}

fn is_valid_plugin_id(id: &str) -> bool {
    (3..=128).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '-' | '_'))
}

impl ParamSpec {
    /// 判断一个默认值是否符合声明的类型（宽容：Int 可以落在 Float 参数上）
    pub fn accepts(&self, v: &ParamValue) -> bool {
        match self.ty {
            ParamType::Text | ParamType::Textarea | ParamType::Path | ParamType::Directory
            | ParamType::Color | ParamType::KeyValue => v.as_str().is_some(),
            ParamType::Int => v.as_i64().is_some(),
            ParamType::Float => v.as_f64().is_some(),
            ParamType::Bool => v.as_bool().is_some(),
            ParamType::Enum => v
                .as_str()
                .map(|s| self.options.iter().any(|o| o.value == s))
                .unwrap_or(false),
            ParamType::MultiEnum => v.as_list().is_some(),
        }
    }
}

// ============================================================================
// 校验报告
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ValidationReport {
    pub ok: bool,
    pub issues: Vec<ValidationIssue>,
}

impl ValidationReport {
    pub fn from_issues(issues: Vec<ValidationIssue>) -> Self {
        let ok = !issues.iter().any(|i| i.severity == Severity::Error);
        Self { ok, issues }
    }

    pub fn ok() -> Self {
        Self {
            ok: true,
            issues: vec![],
        }
    }

    pub fn error(code: impl Into<String>, msg: impl Into<String>) -> Self {
        Self::from_issues(vec![ValidationIssue::error(code, msg)])
    }

    pub fn error_count(&self) -> usize {
        self.issues
            .iter()
            .filter(|i| i.severity == Severity::Error)
            .count()
    }

    pub fn warning_count(&self) -> usize {
        self.issues
            .iter()
            .filter(|i| i.severity == Severity::Warning)
            .count()
    }

    /// 转成错误（校验失败时用于中断流程）
    pub fn into_result(self) -> ToolforgeResult<Self> {
        if self.ok {
            Ok(self)
        } else {
            let detail = self
                .issues
                .iter()
                .filter(|i| i.severity == Severity::Error)
                .map(|i| format!("· [{}] {}", i.code, i.message))
                .collect::<Vec<_>>()
                .join("\n");
            Err(ToolforgeError::plugin_invalid(format!(
                "插件清单校验未通过（{} 项错误）",
                self.error_count()
            ))
            .with_detail(detail))
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ValidationIssue {
    pub severity: Severity,
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

impl ValidationIssue {
    pub fn error(code: impl Into<String>, msg: impl Into<String>) -> Self {
        Self {
            severity: Severity::Error,
            code: code.into(),
            message: msg.into(),
            path: None,
        }
    }
    pub fn warning(code: impl Into<String>, msg: impl Into<String>) -> Self {
        Self {
            severity: Severity::Warning,
            code: code.into(),
            message: msg.into(),
            path: None,
        }
    }
    pub fn info(code: impl Into<String>, msg: impl Into<String>) -> Self {
        Self {
            severity: Severity::Info,
            code: code.into(),
            message: msg.into(),
            path: None,
        }
    }
    pub fn at(mut self, path: impl Into<String>) -> Self {
        self.path = Some(path.into());
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    Info,
}

// ============================================================================
// 前端用的摘要 / 详情
// ============================================================================

/// 插件列表项。字段刻意冗余（把 UI 需要的都算好），避免前端为了渲染一个卡片
/// 再去拉详情。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginSummary {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub category: PluginCategory,
    pub tags: Vec<String>,
    pub runtime_kind: RuntimeKind,
    /// 是否已启用
    pub enabled: bool,
    /// 是否随应用内置
    pub builtin: bool,
    /// 是否由 AI 生成（UI 会打特殊标记）
    pub ai_generated: bool,
    /// 是否已被用户审核确认过
    pub reviewed: bool,
    pub risk_level: RiskLevel,
    pub permission_count: u32,
    pub granted_count: u32,
    /// 是否存在未授权的声明能力（UI 提示"存在待授权项"）
    pub has_pending_permissions: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_path: Option<String>,
}

impl PluginSummary {
    pub fn from_manifest(
        m: &PluginManifest,
        granted: &PermissionSet,
        builtin: bool,
        install_path: Option<String>,
    ) -> Self {
        let declared = &m.permissions;
        let effective = PermissionSet::effective(declared, granted);
        Self {
            id: m.metadata.id.clone(),
            name: m.metadata.name.clone(),
            version: m.metadata.version.clone(),
            description: m.metadata.description.clone(),
            icon: m.metadata.icon.clone(),
            category: m.metadata.category,
            tags: m.metadata.tags.clone(),
            runtime_kind: m.runtime.kind(),
            enabled: false,
            builtin,
            ai_generated: m.ai.as_ref().map(|a| a.generated).unwrap_or(false),
            reviewed: m
                .ai
                .as_ref()
                .map(|a| a.reviewed_at.is_some())
                .unwrap_or(true),
            risk_level: declared.risk_level(),
            permission_count: declared.capabilities.len() as u32,
            granted_count: effective.capabilities.len() as u32,
            has_pending_permissions: effective.capabilities.len() != declared.capabilities.len(),
            install_path,
        }
    }
}

/// 插件详情（点开卡片后加载）
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginDetail {
    pub summary: PluginSummary,
    pub manifest: PluginManifest,
    pub raw_yaml: String,
    /// 用户实际授予的能力
    pub granted: PermissionSet,
    /// 插件目录下的文件列表（相对路径）
    pub files: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub readme: Option<String>,
    /// 运行时健康状态（L2/L3 才有意义）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_status: Option<String>,
}

// ============================================================================
// 安装来源（AI 生成产物走 Bundle）
// ============================================================================

/// 插件安装来源。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PluginSource {
    /// 已存在于磁盘的插件目录
    Directory { path: String },
    /// 单个 YAML 清单（L1 插件，无需额外文件）
    Manifest { yaml: String },
    /// 多文件包 —— AI 生成的插件从这里落盘
    Bundle { yaml: String, files: Vec<BundleFile> },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BundleFile {
    /// 相对于插件根目录的路径（不允许 `..` 与绝对路径）
    pub path: String,
    pub content: String,
    #[serde(default)]
    pub encoding: FileEncoding,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum FileEncoding {
    #[default]
    Utf8,
    /// WASM 二进制走 base64，因为 JSON IPC 传不了裸字节
    Base64,
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL_L1: &str = r#"
apiVersion: toolforge/v1
kind: Plugin
metadata:
  id: com.example.resize
  name: 图片缩放
  version: 1.0.0
  category: image
permissions:
  capabilities:
    - kind: fsRead
      scope: { kind: input }
    - kind: fsWrite
      scope: { kind: output }
io:
  params:
    - id: width
      label: 宽度
      type: int
      default: { kind: int, value: 1280 }
      min: 1
      max: 20000
runtime:
  kind: pipeline
  pipeline:
    steps:
      - id: resize
        uses: image.resize
        with:
          width: "${params.width}"
          output: "${dst}"
"#;

    #[test]
    fn parses_minimal_l1_plugin() {
        let m = PluginManifest::from_yaml(MINIMAL_L1).expect("should parse");
        assert_eq!(m.metadata.id, "com.example.resize");
        assert_eq!(m.runtime.kind(), RuntimeKind::Pipeline);
        assert!(m.runtime.requires_artifact() == false);
        let report = m.validate();
        assert!(report.ok, "issues: {:?}", report.issues);
    }

    #[test]
    fn rejects_wrong_api_version() {
        let yaml = MINIMAL_L1.replace("toolforge/v1", "toolforge/v99");
        let m = PluginManifest::from_yaml(&yaml).unwrap();
        let r = m.validate();
        assert!(!r.ok);
        assert!(r.issues.iter().any(|i| i.code == "API_VERSION_MISMATCH"));
    }

    #[test]
    fn rejects_bad_plugin_id() {
        let yaml = MINIMAL_L1.replace("com.example.resize", "Bad Plugin ID!");
        let m = PluginManifest::from_yaml(&yaml).unwrap();
        let r = m.validate();
        assert!(!r.ok);
        assert!(r.issues.iter().any(|i| i.code == "ID_FORMAT"));
    }

    #[test]
    fn rejects_python_requirement_with_url() {
        let yaml = r#"
apiVersion: toolforge/v1
kind: Plugin
metadata: { id: com.example.py, name: P, version: 0.1.0 }
runtime:
  kind: python
  python:
    entry: main.py
    requirements: ["evil @ https://evil.example/x.tar.gz"]
"#;
        let m = PluginManifest::from_yaml(yaml).unwrap();
        let r = m.validate();
        assert!(!r.ok);
        assert!(r.issues.iter().any(|i| i.code == "PY_REQ_UNSAFE"));
    }

    #[test]
    fn rejects_python_network_without_permission() {
        let yaml = r#"
apiVersion: toolforge/v1
kind: Plugin
metadata: { id: com.example.py, name: P, version: 0.1.0 }
runtime:
  kind: python
  python:
    entry: main.py
    allowNetwork: true
"#;
        let m = PluginManifest::from_yaml(yaml).unwrap();
        let r = m.validate();
        assert!(!r.ok);
        assert!(r
            .issues
            .iter()
            .any(|i| i.code == "PYTHON_NET_WITHOUT_PERMISSION"));
    }

    #[test]
    fn wasm_with_unknown_host_function_is_rejected() {
        let yaml = r#"
apiVersion: toolforge/v1
kind: Plugin
metadata: { id: com.example.w, name: W, version: 0.1.0 }
runtime:
  kind: wasm
  wasm:
    path: p.wasm
    allowHostFunctions: ["exec"]
"#;
        let m = PluginManifest::from_yaml(yaml).unwrap();
        let r = m.validate();
        assert!(!r.ok);
        assert!(r.issues.iter().any(|i| i.code == "WASM_HOST_FN_UNKNOWN"));
    }

    #[test]
    fn enum_param_requires_options() {
        let yaml = MINIMAL_L1.replace("type: int", "type: enum");
        let m = PluginManifest::from_yaml(&yaml).unwrap();
        let r = m.validate();
        assert!(r.issues.iter().any(|i| i.code == "ENUM_WITHOUT_OPTIONS"));
    }

    #[test]
    fn summary_computes_pending_permissions() {
        let m = PluginManifest::from_yaml(MINIMAL_L1).unwrap();
        // 只授权一半
        let granted = PermissionSet::from_iter_caps([crate::permission::Capability::FsRead {
            scope: PathScope::Input,
        }]);
        let s = PluginSummary::from_manifest(&m, &granted, true, None);
        assert_eq!(s.permission_count, 2);
        assert_eq!(s.granted_count, 1);
        assert!(s.has_pending_permissions);
    }
}
