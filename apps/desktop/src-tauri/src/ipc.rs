//! 前端与后端之间的**契约类型**。
//!
//! ## 为什么单独一个模块
//!
//! 这些类型只存在于 IPC 边界上：它们不参与领域逻辑，但**必须**被 specta 导出成
//! TypeScript。把它们集中在一个文件里，是为了让"前端能看到什么"这件事一目了然 ——
//! 想加一个字段，改动点永远在这里，而不是散落在各个命令里。
//!
//! ## 一条约定
//!
//! 命令返回 `Result<T, ToolforgeError>`，而 `tauri-specta` 使用默认的
//! [`tauri_specta::ErrorHandlingMode::Result`]，所以前端拿到的是：
//!
//! ```ts
//! type Result<T, E> = { status: "ok"; data: T } | { status: "error"; error: E }
//! ```
//!
//! 前端 `lib/ipc.ts` 里的 `unwrap()` 负责把它折成 Promise 的 resolve/reject。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use specta::Type;

use toolforge_core::engine::{EngineDescriptor, EngineStatus};
use toolforge_core::job::{Job, JobFilter, JobStatus};
use toolforge_core::permission::{Capability, PermissionSet};
use toolforge_core::plugin::{ParamValue, PluginSource, PluginSummary, ValidationReport};
use toolforge_ai::review::SecurityReview;
use toolforge_ai::AiDraft;

// ============================================================================
// 应用 / 设置
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PathEntry {
    pub label: String,
    pub path: String,
}

/// 应用目录布局（设置页「打开目录」按钮用）
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppPathsDto {
    pub entries: Vec<PathEntry>,
}

/// 用户设置。全部字段都有默认值 —— 首次启动时不需要用户填任何东西。
///
/// `#[serde(default)]` 挂在结构体上（而不是逐字段挂）是**向后兼容的关键**：
/// 以后新增字段时，老版本写下的 `settings.json` 照样能读出来，
/// 缺的字段用默认值补，而不是让整份设置解析失败。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// 任务队列并发度
    #[serde(default = "default_concurrency")]
    pub concurrency: u32,
    /// 主题：`system` / `light` / `dark`
    #[serde(default = "default_theme")]
    pub theme: String,
    /// 强调色（CSS 变量注入）
    #[serde(default = "default_accent")]
    pub accent: String,
    /// 是否启用背景氛围动效（低配机器可关）
    #[serde(default = "default_true")]
    pub ambient_effects: bool,
    /// 默认输出目录；空表示"与源文件同目录"
    #[serde(default)]
    pub default_output_dir: String,
    /// 批量处理时是否保留源文件
    #[serde(default = "default_true")]
    pub keep_original: bool,
    /// AI 配置（不含 Key —— Key 在这个结构体之外，见 [`AiSettings::persist_api_key`]）
    #[serde(default)]
    pub ai: AiSettings,
    /// 启动时自动重新探测引擎
    #[serde(default = "default_true")]
    pub probe_engines_on_startup: bool,
}

fn default_concurrency() -> u32 {
    // 按 CPU 核数取一半，至少 2、至多 8：批量处理时"占满所有核"反而更慢
    // （磁盘 IO 与内存带宽会成为瓶颈）
    let n = std::thread::available_parallelism()
        .map(|n| n.get() as u32)
        .unwrap_or(4);
    (n / 2).clamp(2, 8)
}
fn default_theme() -> String {
    "system".into()
}
fn default_accent() -> String {
    "cyan".into()
}
fn default_true() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            concurrency: default_concurrency(),
            theme: default_theme(),
            accent: default_accent(),
            ambient_effects: true,
            default_output_dir: String::new(),
            keep_original: true,
            ai: AiSettings::default(),
            probe_engines_on_startup: true,
        }
    }
}

/// AI 设置。**API Key 不在这里** —— 它存在内存里，只有用户显式打开
/// 「记住 API Key」时才会另存到 `<数据目录>/ai-key.txt`。
/// 无论如何它都不会落到这个会序列化给前端的结构体上。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct AiSettings {
    pub provider: toolforge_ai::AiProviderKind,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    /// 只读：是否已经配置过 Key
    #[serde(default)]
    pub has_key: bool,
    #[serde(default = "default_temperature")]
    pub temperature: f32,
    /// 是否把 Key 落盘（默认**否**）。
    ///
    /// 这个字段存在的原因是：原来的实现把 Key 只放在内存里，界面上却写着
    /// 「存在本机内存与系统钥匙串里」—— 钥匙串从来没接过。与其继续骗人，
    /// 不如把选择权交给用户，并说清代价：打开 = 明文存在数据目录下。
    #[serde(default)]
    pub persist_api_key: bool,
}

fn default_temperature() -> f32 {
    0.2
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            provider: toolforge_ai::AiProviderKind::OpenAi,
            base_url: String::new(),
            model: String::new(),
            has_key: false,
            temperature: 0.2,
            persist_api_key: false,
        }
    }
}

/// 局部更新设置（`None` 表示不改这个字段）。
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub concurrency: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ambient_effects: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_output_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keep_original: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai: Option<AiSettings>,
    /// 写 `Some` 时会更新内存中的 Key；写 `Some("")` 则清除
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probe_engines_on_startup: Option<bool>,
}

// ============================================================================
// 任务
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JobsSnapshot {
    pub jobs: Vec<Job>,
    pub active_count: u32,
    pub running: Vec<String>,
}

// ============================================================================
// 引擎
// ============================================================================

/// 引擎目录项 = 静态描述 + 运行时状态。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EngineEntry {
    pub descriptor: EngineDescriptor,
    pub status: EngineStatus,
    /// 依赖这个引擎的内置节点名列表（UI 上显示"装了它能解锁什么"）
    pub used_by_nodes: Vec<String>,
    /// 当前平台是否配置了可下载的来源。
    ///
    /// 界面靠它决定要不要显示「安装托管版本」—— 对一个没有下载源的引擎
    /// （如 7-Zip、tesseract、calibre）显示这个按钮，用户点了只会得到一句
    /// "当前平台没有配置下载源"，那是白白浪费一次点击。
    pub managed_available: bool,
}

/// 引擎安装请求。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EngineInstallRequest {
    pub engine_id: String,
    /// 用户是否已经确认了许可证条款
    #[serde(default)]
    pub license_accepted: bool,
    /// 是否允许安装没有 SHA-256 的来源（需要在 UI 上做二次确认）
    #[serde(default)]
    pub allow_unverified: bool,
    /// 即使系统上已经有一个可用的，也强制安装**应用托管**的那一份。
    ///
    /// 用在"系统上那个版本不满足要求"的场景：最典型的是 Python ——
    /// 系统装着 3.14 会被判为"已可用"，但抠图需要的 onnxruntime
    /// 没有 3.14 的 wheel，而托管版本固定 3.11。
    #[serde(default)]
    pub force: bool,
}

// ============================================================================
// 模型权重
// ============================================================================

/// 一个模型权重的完整状态 = 静态描述 + 是否已下载 + 谁需要它。
///
/// 为什么不直接把 `EngineModel` 发给前端：那个结构里没有"能不能下载"
/// （`url` / `sha256` 是否齐全）这个**用户最关心**的字段 ——
/// 缺下载源的模型点"下载"必然失败，界面必须提前把按钮禁掉并说明原因。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub id: String,
    pub name: String,
    pub purpose: String,
    pub license: String,
    pub commercial_use: bool,
    /// 估算体积（MB），用于"要不要现在下"的判断
    pub approx_size_mb: u32,
    /// 是否已经下载到本机
    pub installed: bool,
    /// 已落盘的实际大小（MB）；未安装时为 `None`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed_size_mb: Option<f64>,
    /// 是否配置了可校验的下载源。`false` 时界面应禁用下载并说明原因。
    pub downloadable: bool,
    /// 依赖这个模型的节点名
    pub used_by_nodes: Vec<String>,
    /// 模型所属的引擎（通常是虚拟引擎 `onnx-models`）
    pub engine_id: String,
}

/// 模型下载请求。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ModelInstallRequest {
    pub model_id: String,
    /// 用户是否已确认该权重的许可证（部分权重不允许商用）
    #[serde(default)]
    pub license_accepted: bool,
}

// ============================================================================
// 插件
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginsSnapshot {
    pub plugins: Vec<PluginSummary>,
    /// 有未授权项的插件数（侧边栏红点）
    pub pending_permission_count: u32,
    /// 审计目录（安全页展示）
    pub audit_dir: String,
}

/// 校验一份插件来源（不落盘）。用于"导入前先看看"。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ValidatePluginRequest {
    pub source: PluginSource,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ValidatePluginResponse {
    pub validation: ValidationReport,
    /// 申请的能力（中文描述 + 风险等级）
    pub capabilities: Vec<Capability>,
    /// 声明需要的引擎
    pub required_engines: Vec<String>,
    /// 缺失的引擎
    pub missing_engines: Vec<String>,
}

/// 安装插件的请求。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct InstallPluginRequest {
    pub source: PluginSource,
    /// 是否覆盖已存在的同名插件
    #[serde(default)]
    pub overwrite: bool,
    /// 用户是否已确认权限清单（L1/L2 必填；L3 需要额外确认可执行代码）
    #[serde(default)]
    pub permissions_acknowledged: bool,
    /// 仅 L3：用户是否确认"这是可执行代码"
    #[serde(default)]
    pub executable_code_acknowledged: bool,
}

/// 插件运行请求。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RunPluginRequest {
    pub plugin_id: String,
    /// 输入端口的实际文件路径（由原生文件对话框或拖拽得到）
    pub inputs: HashMap<String, Vec<String>>,
    #[serde(default)]
    pub params: HashMap<String, ParamValue>,
    /// 输出目录；空则用设置里的默认值
    #[serde(default)]
    pub output_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RunPluginResponse {
    /// 立即返回任务 id，实际执行在队列里进行（前端订阅事件跟进度）
    pub job_id: String,
    pub plugin_name: String,
    /// 预计处理的文件总数
    pub total_items: u32,
}

/// 授权请求
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GrantPermissionsRequest {
    pub plugin_id: String,
    pub granted: PermissionSet,
}

/// 内置节点目录（流程编辑器的节点面板）
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NodeCatalogResponse {
    pub nodes: Vec<toolforge_core::pipeline::NodeDescriptor>,
    /// 当前各节点的可用性（引擎缺失时置 false）
    pub availability: HashMap<String, bool>,
    /// 缺失引擎 -> 需要它的节点
    pub missing_engines: HashMap<String, Vec<String>>,
    /// **尚未实现执行器**的节点名。
    ///
    /// ⚠️ 前端**不要**再硬编这份名单 —— 它来自
    /// `toolforge_core::pipeline::UNIMPLEMENTED_NODES`（唯一真相来源），
    /// 由 `unimplemented_list_matches_actual_dispatch` 与
    /// `is_implemented_is_the_complement_of_the_list` 两条测试守着。
    ///
    /// 这份名单曾经在四个地方各存了一份（Rust 执行器、SDK 文档、示例清单注释、
    /// 前端的 `node-support.ts`），每实现一个节点就要手工同步四处。
    /// 漏掉任何一处，用户就会看到与实际行为相反的提示。
    pub unimplemented: Vec<String>,
}

// ============================================================================
// AI
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiGenerateRequest {
    pub description: String,
    /// 是否允许生成 Python 代码插件（默认 false）
    #[serde(default)]
    pub allow_python: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category_hint: Option<String>,
}

/// 生成结果 = 草稿 + 审核报告。**不含任何"已安装"语义。**
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiGenerateResponse {
    pub draft: AiDraft,
    pub review: SecurityReview,
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiTestConnectionResponse {
    pub ok: bool,
    pub models: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ============================================================================
// 审计
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AuditSnapshot {
    pub events: Vec<toolforge_plugins::AuditEvent>,
    pub files: Vec<String>,
    pub dir: String,
}

// ============================================================================
// 系统状态
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SystemStatus {
    pub info: toolforge_core::AppInfo,
    pub paths: AppPathsDto,
    /// 已可用引擎数 / 总数
    pub engines_ready: u32,
    pub engines_total: u32,
    /// 已装载的插件数
    pub plugins_total: u32,
    pub plugins_enabled: u32,
    pub active_jobs: u32,
    /// 数据库/目录是否可写
    pub storage_writable: bool,
    /// 当前平台
    pub platform: String,
    /// 命令总数（开发信息）
    pub command_count: u32,
}

/// 任务状态统计（仪表盘用）
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JobStats {
    pub by_status: HashMap<String, u32>,
    pub total: u32,
    pub succeeded: u32,
    pub failed: u32,
}

impl JobStats {
    pub fn from_jobs(jobs: &[Job]) -> Self {
        let mut by_status: HashMap<String, u32> = HashMap::new();
        let mut succeeded = 0;
        let mut failed = 0;
        for j in jobs {
            *by_status
                .entry(
                    match j.status {
                        JobStatus::Queued => "queued",
                        JobStatus::Running => "running",
                        JobStatus::Succeeded => "succeeded",
                        JobStatus::Failed => "failed",
                        JobStatus::Cancelled => "cancelled",
                    }
                    .to_string(),
                )
                .or_insert(0) += 1;
            if j.status == JobStatus::Succeeded {
                succeeded += 1;
            }
            if j.status == JobStatus::Failed {
                failed += 1;
            }
        }
        Self {
            by_status,
            total: jobs.len() as u32,
            succeeded,
            failed,
        }
    }
}

/// 统一的 `jobs_list` 请求（specta 对 `Option<JobFilter>` 的处理不如显式结构体清晰）
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JobsListRequest {
    #[serde(default)]
    pub filter: JobFilter,
}
