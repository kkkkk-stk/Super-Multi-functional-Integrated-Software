//! # toolforge-core
//!
//! ToolForge 的**领域层**。这里放的是所有其它 crate 都必须共享、且必须保持稳定的东西：
//!
//! | 模块 | 职责 |
//! |---|---|
//! | [`error`] | 统一错误类型 —— 同时是 IPC 错误契约，前端按 `code` 分支处理 |
//! | [`ids`] | 强类型 ID（`JobId` / `PluginId` / `EngineId`），避免字符串混用 |
//! | [`permission`] | 插件能力模型与裁决器 —— **整个安全模型的根** |
//! | [`plugin`] | 插件清单 schema（L1 声明式 / L2 WASM / L3 Python） |
//! | [`pipeline`] | L1 流水线的步骤模型与内置节点目录 |
//! | [`job`] | 任务模型：状态机、进度、取消令牌 |
//! | [`engine`] | 外部能力引擎的描述与安装状态 |
//! | [`queue`] | 任务队列：并发限流、取消、进度广播 |
//! | [`events`] | 发往前端的事件载荷 |
//! | [`paths`] | 应用目录布局 |
//!
//! **设计约束**：本 crate 不允许依赖 `tauri`、`extism`、`reqwest`。
//! 所有跨进程/跨沙箱的东西都在上层 crate 里。这样领域模型可以被单元测试、
//! 被未来的 CLI 复用，也不会因为换掉某个引擎而跟着动。

pub mod ai;
pub mod engine;
pub mod error;
pub mod events;
pub mod ids;
pub mod job;
pub mod paths;
pub mod permission;
pub mod pipeline;
pub mod plugin;
pub mod queue;

pub use error::{ErrorCode, ToolforgeError, ToolforgeResult};
pub use ids::{EngineId, JobId, PluginId};
pub use permission::{Capability, CapabilityRequest, CapabilityVerdict, PermissionSet};
pub use plugin::{PluginManifest, PluginRuntime, PluginSummary};

/// 当前清单 schema 版本。插件里 `apiVersion` 与本值不匹配时一律拒绝装载。
pub const PLUGIN_API_VERSION: &str = "toolforge/v1";

/// 应用元信息（前端「关于」页用）
///
/// 同时派生 `Deserialize`：它会被嵌进 [`crate::AppInfo`] 所在的
/// `SystemStatus` 里，而后者需要能被反序列化（测试与未来的 CLI 都用得上）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub tauri_version: String,
    pub rust_version: String,
    pub plugin_api_version: String,
    pub build_profile: String,
}
