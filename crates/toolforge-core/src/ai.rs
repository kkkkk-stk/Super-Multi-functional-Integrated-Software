//! 多模态（视觉）能力的**抽象**。
//!
//! # 为什么这里只有一个 trait，没有实现
//!
//! 依赖方向不允许 `toolforge-engines` 直接依赖 `toolforge-ai`：
//!
//! ```text
//! toolforge-ai ──► toolforge-plugins ──► toolforge-engines
//! ```
//!
//! （`ai` 要校验它生成的插件清单，`plugins` 的 L1 执行器要调引擎。）
//! 于是引擎层再依赖 `ai` 就成环 —— 编译器的报错是
//! `cyclic package dependency`，很直白，但第一反应容易是"加个依赖而已"。
//!
//! 正确的解法不是把某个依赖挪走（那会破坏另一处的职责），而是**让引擎层
//! 依赖一个抽象**：节点需要的能力就一句话 —— "把一段提示词和一张图发给
//! 多模态模型，拿回文本"。这个 trait 就是那句话。
//!
//! 实现由 `toolforge-ai` 提供（`impl VisionClient for AiClient`），
//! 注入由外壳层完成（`NodeCtx.vision`）。这样：
//!
//! * 引擎层可以在**没有 AI** 的情况下编译、测试、运行（`vision: None`）；
//! * `toolforge-ai` 换实现（换协议、加流式）不影响任何节点代码。
//!
//! # 为什么用 `BoxFut` 而不是 `async fn`
//!
//! `async fn` 在 trait 里（Rust 1.75+ 支持）会让 trait 变成非 dyn-safe，
//! 而这里必须能放进 `Arc<dyn VisionClient>`。引 `async-trait` 只为这一处
//! 不划算（这个项目对"为几行代码加依赖"是明确反对的），所以手写装箱。

use crate::error::ToolforgeResult;

/// 装箱的 future 别名（`Send` 是必需的：节点会在 tokio 的多线程运行时上被调度）
pub type BoxFut<T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send>>;

/// 一次视觉请求。
#[derive(Debug, Clone)]
pub struct VisionRequest {
    /// 用户提示词
    pub prompt: String,
    /// 系统提示词（可空）
    pub system: Option<String>,
    /// 已编码的图片（JPEG 字节）。**由调用方负责压缩** ——
    /// 缩图逻辑在引擎层（那里才有 image crate），抽象层不该关心像素。
    pub jpeg: Vec<u8>,
}

/// 多模态模型的最小接口。
pub trait VisionClient: Send + Sync {
    /// 当前配置的模型名（写进节点输出，便于用户确认自己用的是哪个）
    fn model_name(&self) -> String;

    /// 发一次带图的补全，返回助手文本。
    fn complete_with_image(&self, req: VisionRequest) -> BoxFut<ToolforgeResult<String>>;
}
