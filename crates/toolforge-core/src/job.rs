//! 任务模型。
//!
//! ToolForge 里**所有耗时操作都是任务**：格式转换、批量重命名、插件运行、
//! 引擎下载、AI 生成。统一成一种模型的好处是前端只需要一套进度条 / 取消按钮 /
//! 历史记录，不需要为每个功能各写一遍。
//!
//! 状态机（只允许这些迁移）：
//!
//! ```text
//!            ┌──────────── cancel ────────────┐
//!            v                                │
//!  Queued ──► Running ──► Succeeded           │
//!     │          │   └──► Failed             │
//!     │          └──────► Cancelled ◄────────┘
//!     └── cancel ──────► Cancelled
//! ```
//!
//! `Succeeded` / `Failed` / `Cancelled` 是终态，不可再迁移。

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::error::ToolforgeError;
use crate::ids::JobId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum JobStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

impl JobStatus {
    /// 终态：不再变化
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            JobStatus::Succeeded | JobStatus::Failed | JobStatus::Cancelled
        )
    }

    pub fn is_active(self) -> bool {
        matches!(self, JobStatus::Queued | JobStatus::Running)
    }

    pub fn describe(self) -> &'static str {
        match self {
            JobStatus::Queued => "排队中",
            JobStatus::Running => "进行中",
            JobStatus::Succeeded => "已完成",
            JobStatus::Failed => "失败",
            JobStatus::Cancelled => "已取消",
        }
    }

    /// 合法迁移检查。放在领域层，避免各调用点各写一套 if。
    pub fn can_transition_to(self, next: JobStatus) -> bool {
        use JobStatus::*;
        match (self, next) {
            (Queued, Running) | (Queued, Cancelled) => true,
            (Running, Succeeded) | (Running, Failed) | (Running, Cancelled) => true,
            // 幂等：允许同状态重复上报（进度更新场景）
            (a, b) if a == b => true,
            _ => false,
        }
    }
}

/// 任务类别。前端据此决定图标、详情面板内容、以及是否能重试。
///
/// ⚠️ `rename_all_fields` 不是可选项：枚举级的 `rename_all` 只改**变体名**，
/// 不改变体里的**字段名**。少了它，`PluginRun { plugin_id }` 会导出成
/// `{ kind: "pluginRun", plugin_id: string }` —— 前端按 `pluginId` 取值就拿到
/// `undefined`。生成绑定后请务必核对 `bindings.ts` 里的字段名。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum JobKind {
    /// 单文件/多文件格式转换
    Convert,
    /// 批量重命名
    BatchRename,
    /// 运行某个插件
    PluginRun { plugin_id: String },
    /// 运行一条可视化流水线
    PipelineRun { name: String },
    /// 下载安装能力引擎
    EngineInstall { engine_id: String },
    /// 下载模型权重
    ModelDownload { model_id: String },
    /// AI 生成插件
    AiGenerate { provider: String },
    /// 探测媒体信息
    Probe,
    /// 杂项（由标题说明）
    Other { label: String },
}

impl JobKind {
    pub fn label(&self) -> &'static str {
        match self {
            JobKind::Convert => "格式转换",
            JobKind::BatchRename => "批量重命名",
            JobKind::PluginRun { .. } => "插件运行",
            JobKind::PipelineRun { .. } => "流水线执行",
            JobKind::EngineInstall { .. } => "引擎安装",
            JobKind::ModelDownload { .. } => "模型下载",
            JobKind::AiGenerate { .. } => "AI 生成",
            JobKind::Probe => "媒体探测",
            JobKind::Other { .. } => "任务",
        }
    }

    /// 引擎安装与 AI 生成不允许"重试"按钮直接重放（会产生副作用/重复扣费）
    pub fn is_retryable(&self) -> bool {
        !matches!(
            self,
            JobKind::AiGenerate { .. } | JobKind::EngineInstall { .. }
        )
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    /// 0.0 ..= 1.0；未知总量时为 None（前端显示不确定进度条）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
    /// 当前阶段的人类可读描述，例如"正在转码 第 3/10 个"
    pub stage: String,
    /// 当前正在处理的文件
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_item: Option<String>,
    /// 传输速率（下载任务用）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed: Option<String>,
    /// 预计剩余秒数
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eta_seconds: Option<f64>,
}

impl JobProgress {
    pub fn indeterminate(stage: impl Into<String>) -> Self {
        Self {
            value: None,
            stage: stage.into(),
            ..Default::default()
        }
    }

    pub fn ratio(stage: impl Into<String>, done: u64, total: u64) -> Self {
        let value = if total == 0 {
            None
        } else {
            Some((done as f64 / total as f64).clamp(0.0, 1.0))
        };
        Self {
            value,
            stage: stage.into(),
            ..Default::default()
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JobLogEntry {
    /// ISO-8601
    pub at: String,
    pub level: LogLevel,
    pub message: String,
}

impl JobLogEntry {
    pub fn new(level: LogLevel, message: impl Into<String>) -> Self {
        Self {
            at: now_iso(),
            level,
            message: message.into(),
        }
    }
}

/// 一个任务。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: JobId,
    pub kind: JobKind,
    pub title: String,
    pub status: JobStatus,
    pub progress: JobProgress,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ToolforgeError>,
    /// 日志只保留尾部 N 条（见 [`Job::LOG_TAIL_LIMIT`]），避免长任务把内存吃光
    #[serde(default)]
    pub logs: Vec<JobLogEntry>,
    /// 产出文件路径
    #[serde(default)]
    pub outputs: Vec<String>,
    /// 总条目数 / 已完成 / 失败（批量任务用）
    #[serde(default)]
    pub total_items: u32,
    #[serde(default)]
    pub completed_items: u32,
    #[serde(default)]
    pub failed_items: u32,
}

impl Job {
    /// 单个任务在内存里保留的最大日志行数。批量处理 5000 个文件时，
    /// 不设上限会把几百 MB 日志堆在内存里。
    pub const LOG_TAIL_LIMIT: usize = 2_000;

    pub fn new(kind: JobKind, title: impl Into<String>) -> Self {
        Self {
            id: JobId::generate(),
            kind,
            title: title.into(),
            status: JobStatus::Queued,
            progress: JobProgress::indeterminate("排队中"),
            created_at: now_iso(),
            started_at: None,
            finished_at: None,
            error: None,
            logs: Vec::new(),
            outputs: Vec::new(),
            total_items: 0,
            completed_items: 0,
            failed_items: 0,
        }
    }

    pub fn with_total(mut self, total: u32) -> Self {
        self.total_items = total;
        self
    }

    pub fn is_terminal(&self) -> bool {
        self.status.is_terminal()
    }

    /// 推入一条日志，并裁剪到上限。
    pub fn log(&mut self, level: LogLevel, message: impl Into<String>) {
        self.logs.push(JobLogEntry::new(level, message));
        if self.logs.len() > Self::LOG_TAIL_LIMIT {
            // 从头部丢弃，保留最近的行
            let drop = self.logs.len() - Self::LOG_TAIL_LIMIT;
            self.logs.drain(0..drop);
        }
    }

    /// 推进进度。返回 `false` 表示状态迁移非法（调用方应记录警告）。
    pub fn set_progress(&mut self, progress: JobProgress) -> bool {
        if self.status.is_terminal() {
            return false;
        }
        self.progress = progress;
        true
    }

    /// 状态迁移。非法迁移会被拒绝并返回 `false`，**不会 panic** ——
    /// 长驻应用里 panic 等于用户丢工作。
    pub fn transition(&mut self, next: JobStatus) -> bool {
        if !self.status.can_transition_to(next) {
            tracing::warn!(
                job = %self.id,
                from = ?self.status,
                to = ?next,
                "拒绝非法的任务状态迁移"
            );
            return false;
        }
        if next == JobStatus::Running && self.started_at.is_none() {
            self.started_at = Some(now_iso());
        }
        if next.is_terminal() {
            self.finished_at = Some(now_iso());
            self.progress.value = Some(match next {
                JobStatus::Succeeded => 1.0,
                _ => self.progress.value.unwrap_or(0.0),
            });
        }
        self.status = next;
        true
    }

    pub fn fail(&mut self, err: ToolforgeError) -> bool {
        self.log(LogLevel::Error, err.to_string());
        self.error = Some(err);
        self.transition(JobStatus::Failed)
    }

    pub fn succeed(&mut self) -> bool {
        self.error = None;
        self.transition(JobStatus::Succeeded)
    }

    pub fn cancel(&mut self) -> bool {
        self.log(LogLevel::Warn, "任务已被用户取消");
        self.transition(JobStatus::Cancelled)
    }
}

/// 任务过滤条件（前端任务中心用）
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JobFilter {
    #[serde(default)]
    pub statuses: Vec<JobStatus>,
    #[serde(default)]
    pub kinds: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub search: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

impl JobFilter {
    pub fn matches(&self, job: &Job) -> bool {
        if !self.statuses.is_empty() && !self.statuses.contains(&job.status) {
            return false;
        }
        // 按任务类别筛选。`kinds` 里放的是 `JobKind::label()` 的返回值
        // （例如 "格式转换"、"插件运行"），前端拿它做分组过滤。
        if !self.kinds.is_empty() && !self.kinds.iter().any(|k| k == job.kind.label()) {
            return false;
        }
        if let Some(s) = &self.search {
            let s = s.to_lowercase();
            if !job.title.to_lowercase().contains(&s)
                && !job.id.as_str().to_lowercase().contains(&s)
            {
                return false;
            }
        }
        true
    }
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    #[test]
    fn happy_path_transitions() {
        let mut j = Job::new(JobKind::Convert, "转码");
        assert!(j.transition(JobStatus::Running));
        assert!(j.started_at.is_some());
        assert!(j.transition(JobStatus::Succeeded));
        assert!(j.is_terminal());
        assert_eq!(j.progress.value, Some(1.0));
        assert!(j.finished_at.is_some());
    }

    #[test]
    fn illegal_transition_is_rejected_not_panicking() {
        let mut j = Job::new(JobKind::Convert, "转码");
        // Queued -> Succeeded 非法
        assert!(!j.transition(JobStatus::Succeeded));
        assert_eq!(j.status, JobStatus::Queued);
    }

    #[test]
    fn terminal_jobs_ignore_progress_updates() {
        let mut j = Job::new(JobKind::Convert, "转码");
        j.transition(JobStatus::Running);
        j.transition(JobStatus::Succeeded);
        let changed = j.set_progress(JobProgress::ratio("还在跑", 1, 10));
        assert!(!changed);
    }

    #[test]
    fn cancel_from_queued_works() {
        let mut j = Job::new(JobKind::Convert, "转码");
        assert!(j.cancel());
        assert_eq!(j.status, JobStatus::Cancelled);
    }

    #[test]
    fn logs_are_trimmed_to_tail_limit() {
        let mut j = Job::new(JobKind::Convert, "转码");
        for i in 0..(Job::LOG_TAIL_LIMIT + 500) {
            j.log(LogLevel::Info, format!("line {i}"));
        }
        assert_eq!(j.logs.len(), Job::LOG_TAIL_LIMIT);
        // 保留的是最新的
        assert!(j.logs.last().unwrap().message.contains(&format!(
            "line {}",
            Job::LOG_TAIL_LIMIT + 499
        )));
    }

    #[test]
    fn failure_records_error_and_log() {
        let mut j = Job::new(JobKind::Convert, "转码");
        j.transition(JobStatus::Running);
        assert!(j.fail(ToolforgeError::new(ErrorCode::EngineMissing, "缺 ffmpeg")));
        assert_eq!(j.status, JobStatus::Failed);
        assert_eq!(j.logs.last().unwrap().level, LogLevel::Error);
        assert!(j.error.is_some());
    }

    #[test]
    fn indeterminate_progress_has_no_value() {
        let p = JobProgress::ratio("x", 0, 0);
        assert!(p.value.is_none());
    }

    #[test]
    fn job_kind_retryability() {
        assert!(JobKind::Convert.is_retryable());
        assert!(!JobKind::AiGenerate {
            provider: "openai".into()
        }
        .is_retryable());
    }

    #[test]
    fn filter_by_kind_label() {
        let mut q = Job::new(JobKind::Convert, "a");
        q.transition(JobStatus::Running);
        assert!(JobFilter {
            kinds: vec!["格式转换".into()],
            ..Default::default()
        }
        .matches(&q));
        assert!(!JobFilter {
            kinds: vec!["批量重命名".into()],
            ..Default::default()
        }
        .matches(&q));
        // 空列表 = 不筛选
        assert!(JobFilter::default().matches(&q));
    }

    #[test]
    fn job_kind_fields_are_camel_case_for_ipc() {
        // 枚举级 rename_all 只改变体名，字段名要靠 rename_all_fields。
        // 少了它前端拿到的是 `plugin_id`，按 `pluginId` 取就是 undefined。
        let k = JobKind::PluginRun {
            plugin_id: "com.x.y".into(),
        };
        let v = serde_json::to_value(&k).unwrap();
        assert_eq!(v["kind"], "pluginRun");
        assert_eq!(v["pluginId"], "com.x.y");
        assert!(v.get("plugin_id").is_none());
    }
}
