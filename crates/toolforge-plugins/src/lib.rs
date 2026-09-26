//! # toolforge-plugins
//!
//! 三级插件运行时与插件仓库。
//!
//! ## 为什么是三级而不是一套通用机制
//!
//! 因为这三类需求的安全边界**根本不同**，用一套机制表达会导致"要么什么都不让做、
//! 要么什么都让做"：
//!
//! | 级别 | 载体 | 能做什么 | 为什么这样切 |
//! |---|---|---|---|
//! | **L1** [`l1`] | YAML + 内置节点 | 组合已有能力（转码、缩放、打包…） | 数据不是代码，**AI 生成的最优形态**：没有任意代码执行面 |
//! | **L2** [`runtimes::wasm`] | Extism WASM | 纯计算（文本变换、哈希、编码） | 真沙箱，但**没有文件系统/网络/SIMD**，做不了图像解码 |
//! | **L3** [`runtimes::python`] | 独立进程 + JSON-RPC | 重依赖、模型推理 | 能力最强也最危险，靠 [`toolforge_core::permission`] 约束 + 进程隔离兜底 |
//!
//! 关键取舍：**L2 不是"轻量版 L3"**。把图像处理写成 L2 插件是错的，
//! 因为 WASM 里连一张 4K 图的解码都做不了（没有 SIMD、内存受限、还得自己实现解码器）。
//!
//! ## 装载流程（每个插件都必须走完）
//!
//! ```text
//! 读 plugin.yaml
//!   → PluginManifest::validate()            静态校验（纯函数，不碰磁盘）
//!   → 权限差异检测（与上一版本比是否扩权）     扩权 → 必须重新人工确认
//!   → 用户授权（声明 ∩ 已授权 = 生效权限）
//!   → 内容哈希锁定
//!   → 装载运行时
//! ```
//!
//! 审计日志写在 `<data>/audit/`，记录授权、扩权、越权三类事件。

pub mod audit;
pub mod l1;
pub mod runtimes;
pub mod store;

pub use audit::{AuditEvent, AuditLog};
pub use l1::{run_pipeline, PipelineRunRequest, PipelineRunResult};
pub use runtimes::{PluginRunner, RunningPlugin};
pub use store::{InstallReport, PluginRecord, PluginStore};
pub use toolforge_core::{ToolforgeError, ToolforgeResult};
