//! 发往前端的事件载荷。
//!
//! 约定：事件名统一 `toolforge://<domain>`，负载统一带 `type` 判别式，
//! 这样前端只需要一个 `listen` 分发器，不需要为每类事件各写一遍订阅样板。
//!
//! ```ts
//! listen<AppEvent>('toolforge://event', e => { /* switch (e.type) */ })
//! ```

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::engine::EngineStatus;
use crate::job::{Job, JobLogEntry, JobStatus};

/// 事件通道名（前端 `listen` 用）
pub const EVENT_CHANNEL: &str = "toolforge://event";

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AppEvent {
    /// 任务整体状态变化（排队 → 运行 → 结束，或标题/产出变化）
    JobUpdated { job: Box<Job> },
    /// 任务进度变化。
    ///
    /// **单独走一个事件而不是重推整个 `Job`**：转码任务一秒能产出几十次进度，
    /// 每次都序列化整条 Job（含日志数组）会把 IPC 打爆。
    /// 队列内部已经做了 100ms 节流。
    JobProgressHint { job_id: String, progress: crate::job::JobProgress },
    /// 任务新增日志行。**单独走一个事件**，避免日志刷屏时反复推送整个 Job。
    JobLog { job_id: String, entry: JobLogEntry },
    /// 任务终结（前端据此弹通知、刷新文件列表、决定是否重试）
    JobFinished {
        job_id: String,
        status: JobStatus,
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_message: Option<String>,
    },

    /// 引擎探测/安装状态变化
    EngineStatusChanged { status: EngineStatus },
    /// 引擎下载进度（`downloaded` / `total` 单位是字节；`total` 为 0 表示未知）
    EngineDownloadProgress {
        engine_id: String,
        downloaded: u64,
        total: u64,
        speed_bps: f64,
    },

    /// 插件集合发生变化（装载/卸载/启用/授权）
    PluginChanged { plugin_id: String },
    /// 插件运行时输出（L2 的 log 宿主函数 / L3 的 stderr）
    PluginLog {
        plugin_id: String,
        level: String,
        message: String,
    },
    /// **安全事件**：插件越权、哈希不匹配、AI 产出未通过审核。
    /// 前端应当以醒目方式提示，并写入审计日志。
    SecurityAlert {
        severity: String,
        title: String,
        detail: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subject: Option<String>,
    },

    /// AI 流式输出增量（插件生成过程实时显示）
    AiDelta { request_id: String, delta: String },
    /// AI 生成结束
    AiDone {
        request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },

    /// 通用提示（前端转成 toast）
    Toast {
        level: String,
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
}

impl AppEvent {
    /// 事件名（用于 Tauri 的 `emit`）
    pub fn channel() -> &'static str {
        EVENT_CHANNEL
    }

    pub fn job_log(job_id: impl Into<String>, entry: JobLogEntry) -> Self {
        AppEvent::JobLog {
            job_id: job_id.into(),
            entry,
        }
    }

    pub fn toast(level: &str, title: impl Into<String>) -> Self {
        AppEvent::Toast {
            level: level.into(),
            title: title.into(),
            message: None,
        }
    }

    pub fn security(
        severity: &str,
        title: impl Into<String>,
        detail: impl Into<String>,
        subject: Option<String>,
    ) -> Self {
        AppEvent::SecurityAlert {
            severity: severity.into(),
            title: title.into(),
            detail: detail.into(),
            subject,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::job::{JobKind, LogLevel};

    #[test]
    fn event_serializes_with_type_tag() {
        let e = AppEvent::JobFinished {
            job_id: "job-1".into(),
            status: JobStatus::Succeeded,
            title: "转码".into(),
            error_message: None,
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["type"], "jobFinished");
        assert_eq!(v["status"], "succeeded");
        // 字段名必须是 camelCase —— 前端按 `jobId` 取值
        assert_eq!(v["jobId"], "job-1");
        assert!(v.get("job_id").is_none(), "字段名不得泄漏 snake_case");
        assert!(v.get("errorMessage").is_none(), "None 字段不应出现");
    }

    #[test]
    fn download_progress_fields_are_camel_case() {
        let e = AppEvent::EngineDownloadProgress {
            engine_id: "ffmpeg".into(),
            downloaded: 1024,
            total: 2048,
            speed_bps: 512.0,
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["engineId"], "ffmpeg");
        assert_eq!(v["speedBps"], 512.0);
        assert!(v.get("engine_id").is_none());
        assert!(v.get("speed_bps").is_none());
    }

    #[test]
    fn job_updated_roundtrips() {
        let job = Job::new(JobKind::Convert, "测试");
        let e = AppEvent::JobUpdated {
            job: Box::new(job.clone()),
        };
        let s = serde_json::to_string(&e).unwrap();
        let back: AppEvent = serde_json::from_str(&s).unwrap();
        match back {
            AppEvent::JobUpdated { job: j } => assert_eq!(j.id, job.id),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn log_event_carries_entry() {
        let e = AppEvent::job_log("job-9", JobLogEntry::new(LogLevel::Warn, "慢"));
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["type"], "jobLog");
        assert_eq!(v["entry"]["level"], "warn");
    }
}
