//! 统一错误类型。
//!
//! 这一层刻意**不用** `thiserror` 的枚举 + `#[from]`：
//! 因为错误要跨 IPC 边界到达 TypeScript，前端需要的是一个稳定的**判别式**（`code`）
//! 加一句人话（`message`）。带 `source` 链的枚举序列化出去是不可控的。
//!
//! 所以：内部用 `ToolforgeError::new(code, msg)` 构造，`detail` 里塞技术细节
//! （stderr 尾部、引擎原始输出等），前端按 `code` 做分支、按 `detail` 展开"详情"。

use serde::{Deserialize, Serialize};
use specta::Type;

/// 错误判别式。**新增值只能往后加，不要改已有值的语义** —— 前端会匹配它。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    /// 入参不合法
    InvalidArgument,
    /// 找不到文件 / 任务 / 插件 / 引擎
    NotFound,
    /// 权限被拒绝（插件能力未授予、路径越权、沙箱拦截）
    PermissionDenied,
    /// 所需能力引擎未安装
    EngineMissing,
    /// 引擎存在但调用失败
    EngineFailed,
    /// 插件清单解析/校验失败
    PluginInvalid,
    /// 插件运行时错误（WASM 陷阱、Python 崩溃）
    PluginRuntime,
    /// 插件使用了未声明的能力（**安全事件，会被审计记录**）
    PluginCapabilityViolation,
    /// 任务被取消
    Cancelled,
    /// 超时
    Timeout,
    /// 网络/下载失败
    Network,
    /// 哈希校验失败（下载产物被篡改或不完整）
    IntegrityCheckFailed,
    /// AI 服务不可用或未配置
    AiUnavailable,
    /// AI 产出未通过静态校验或安全审核
    AiRejected,
    /// IO 错误
    Io,
    /// 序列化/反序列化错误
    Serde,
    /// 兜底
    Internal,
}

impl ErrorCode {
    /// 是否属于「用户可自行修复」—— 前端据此决定是否展示"去设置"按钮
    pub fn is_user_actionable(self) -> bool {
        matches!(
            self,
            ErrorCode::EngineMissing
                | ErrorCode::PermissionDenied
                | ErrorCode::AiUnavailable
                | ErrorCode::InvalidArgument
        )
    }
}

/// ToolForge 统一错误。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ToolforgeError {
    pub code: ErrorCode,
    pub message: String,
    /// 技术细节：stderr 尾部、引擎原始输出、校验器逐条问题等
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// 出错时正在处理哪个任务 / 插件（便于前端定位）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
}

impl ToolforgeError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            detail: None,
            subject: None,
        }
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    pub fn with_subject(mut self, subject: impl Into<String>) -> Self {
        self.subject = Some(subject.into());
        self
    }

    // ---------- 便捷构造器 ----------

    pub fn invalid(msg: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidArgument, msg)
    }
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, msg)
    }
    pub fn denied(msg: impl Into<String>) -> Self {
        Self::new(ErrorCode::PermissionDenied, msg)
    }
    pub fn engine_missing(engine: &str) -> Self {
        Self::new(
            ErrorCode::EngineMissing,
            format!("所需能力引擎 `{engine}` 尚未安装"),
        )
        .with_subject(engine)
    }
    pub fn engine_failed(engine: &str, msg: impl Into<String>) -> Self {
        Self::new(ErrorCode::EngineFailed, msg).with_subject(engine)
    }
    pub fn plugin_invalid(msg: impl Into<String>) -> Self {
        Self::new(ErrorCode::PluginInvalid, msg)
    }
    pub fn runtime(msg: impl Into<String>) -> Self {
        Self::new(ErrorCode::PluginRuntime, msg)
    }
    /// 插件越权。这是**安全事件**：调用方必须同时写审计日志。
    pub fn violation(plugin: &str, what: impl Into<String>) -> Self {
        Self::new(
            ErrorCode::PluginCapabilityViolation,
            format!("插件 `{plugin}` 尝试使用未声明的能力：{}", what.into()),
        )
        .with_subject(plugin)
    }
    pub fn internal(msg: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, msg)
    }
    pub fn io(msg: impl Into<String>) -> Self {
        Self::new(ErrorCode::Io, msg)
    }
}

impl std::fmt::Display for ToolforgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{:?}] {}", self.code, self.message)?;
        if let Some(d) = &self.detail {
            write!(f, " —— {d}")?;
        }
        Ok(())
    }
}

impl std::error::Error for ToolforgeError {}

impl From<std::io::Error> for ToolforgeError {
    fn from(e: std::io::Error) -> Self {
        Self::new(ErrorCode::Io, e.to_string())
    }
}

impl From<serde_json::Error> for ToolforgeError {
    fn from(e: serde_json::Error) -> Self {
        Self::new(ErrorCode::Serde, e.to_string())
    }
}

impl From<serde_yaml::Error> for ToolforgeError {
    fn from(e: serde_yaml::Error) -> Self {
        Self::new(ErrorCode::Serde, e.to_string())
    }
}

impl From<tokio::task::JoinError> for ToolforgeError {
    fn from(e: tokio::task::JoinError) -> Self {
        Self::new(ErrorCode::Internal, e.to_string())
    }
}

/// 领域层统一返回类型。
pub type ToolforgeResult<T> = std::result::Result<T, ToolforgeError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_serializes_with_code_discriminant() {
        let e = ToolforgeError::engine_missing("ffmpeg");
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["code"], "ENGINE_MISSING");
        assert_eq!(v["subject"], "ffmpeg");
        // detail 为 None 时不应出现在 JSON 里，避免前端收到一堆 null
        assert!(v.get("detail").is_none());
    }

    #[test]
    fn actionable_codes_are_marked() {
        assert!(ErrorCode::EngineMissing.is_user_actionable());
        assert!(!ErrorCode::IntegrityCheckFailed.is_user_actionable());
    }
}
