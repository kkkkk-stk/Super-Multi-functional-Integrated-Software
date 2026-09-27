//! 任务队列。
//!
//! ## 它解决的三个具体问题
//!
//! 1. **并发限流**：批量处理 3000 张图时不能真的开 3000 个 FFmpeg。
//!    队列持有全局信号量，并且**引擎安装任务串行**（同时下载两个大包只会互相拖慢）。
//! 2. **取消语义**：用户在 UI 上点"取消"必须真的停下来。取消令牌会传到 runner 内部，
//!    runner 在每个条目边界检查它 —— 这样取消响应是"秒级"，不是"等这一个文件跑完"。
//! 3. **进度广播**：进度变化通过 `broadcast` 推给外壳层再转给前端，
//!    同时队列自己保留快照用于 `jobs_list`（前端重连后仍能拿到当前状态）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use dashmap::DashMap;
use tokio::sync::{broadcast, Notify, Semaphore};

use crate::error::{ErrorCode, ToolforgeError, ToolforgeResult};
use crate::events::AppEvent;
use crate::ids::JobId;
use crate::job::{Job, JobFilter, JobKind, JobProgress, JobStatus, LogLevel};

// ============================================================================
// 取消令牌
// ============================================================================

#[derive(Debug)]
struct CancelInner {
    flag: AtomicBool,
    notify: Notify,
}

/// 可克隆的取消令牌。克隆出来的句柄共享同一个标志位。
#[derive(Debug, Clone)]
pub struct CancelToken {
    inner: Arc<CancelInner>,
}

impl CancelToken {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(CancelInner {
                flag: AtomicBool::new(false),
                notify: Notify::new(),
            }),
        }
    }

    pub fn cancel(&self) {
        if !self.inner.flag.swap(true, Ordering::SeqCst) {
            self.inner.notify.notify_waiters();
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.flag.load(Ordering::SeqCst)
    }

    /// 异步等待取消。配合 `tokio::select!` 使用，可以做到"随时可中断"。
    pub async fn cancelled(&self) {
        loop {
            // 先注册等待，再检查标志位 —— 顺序反了会丢掉"注册前刚好被取消"的情况
            let notified = self.inner.notify.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
            if self.is_cancelled() {
                return;
            }
        }
    }

    /// runner 在每个条目边界调用它；已取消则返回 `Err(Cancelled)`。
    pub fn check(&self) -> ToolforgeResult<()> {
        if self.is_cancelled() {
            Err(ToolforgeError::new(ErrorCode::Cancelled, "任务已被取消"))
        } else {
            Ok(())
        }
    }
}

impl Default for CancelToken {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// 任务上下文
// ============================================================================

type EntryMap = Arc<DashMap<String, JobEntry>>;

/// 交给 runner 的句柄。runner 通过它上报进度、写日志、检查取消。
#[derive(Clone)]
pub struct JobCtx {
    pub id: JobId,
    pub cancel: CancelToken,
    tx: broadcast::Sender<AppEvent>,
    entries: EntryMap,
    /// 节流基准：上次上报进度的毫秒时间戳
    last_emit_ms: Arc<AtomicU64>,
}

impl JobCtx {
    fn new(
        id: JobId,
        cancel: CancelToken,
        tx: broadcast::Sender<AppEvent>,
        entries: EntryMap,
    ) -> Self {
        Self {
            id,
            cancel,
            tx,
            entries,
            last_emit_ms: Arc::new(AtomicU64::new(0)),
        }
    }

    /// 上报进度。
    ///
    /// 内部做 100ms 节流 —— 转码时 FFmpeg 每秒能吐出几十行进度，
    /// 全量转发会让 WebView 卡成幻灯片。队列里的快照仍然会被更新，
    /// 所以前端即使错过中间事件，拉一次 `jobs_list` 也能拿到最新值。
    pub fn progress(&self, p: JobProgress) {
        let now = now_ms();
        let last = self.last_emit_ms.load(Ordering::Relaxed);
        self.apply_progress(&p);
        if now.saturating_sub(last) < 100 {
            return;
        }
        self.last_emit_ms.store(now, Ordering::Relaxed);
        let _ = self.tx.send(AppEvent::JobProgressHint {
            job_id: self.id.to_string(),
            progress: p,
        });
    }

    /// 强制上报（不受节流限制）。用于阶段切换这种必须立刻可见的变化。
    pub fn progress_now(&self, p: JobProgress) {
        self.last_emit_ms.store(now_ms(), Ordering::Relaxed);
        self.apply_progress(&p);
        let _ = self.tx.send(AppEvent::JobProgressHint {
            job_id: self.id.to_string(),
            progress: p,
        });
    }

    fn apply_progress(&self, p: &JobProgress) {
        if let Some(mut e) = self.entries.get_mut(self.id.as_str()) {
            let mut job = e.job.clone();
            if job.set_progress(p.clone()) {
                e.job = job;
            }
        }
    }

    pub fn log(&self, level: LogLevel, message: impl Into<String>) {
        let entry = crate::job::JobLogEntry::new(level, message);
        if let Some(mut e) = self.entries.get_mut(self.id.as_str()) {
            let mut job = e.job.clone();
            job.log(entry.level, entry.message.clone());
            e.job = job;
        }
        let _ = self
            .tx
            .send(AppEvent::job_log(self.id.to_string(), entry));
    }

    pub fn info(&self, m: impl Into<String>) {
        self.log(LogLevel::Info, m);
    }
    pub fn warn(&self, m: impl Into<String>) {
        self.log(LogLevel::Warn, m);
    }
    pub fn error(&self, m: impl Into<String>) {
        self.log(LogLevel::Error, m);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }

    pub fn check(&self) -> ToolforgeResult<()> {
        self.cancel.check()
    }

    /// 给不会自己上报进度的循环用：按 done/total 自动算比例。
    pub fn step(&self, stage: &str, done: u64, total: u64) {
        self.progress(JobProgress::ratio(stage, done, total));
    }
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ============================================================================
// 队列
// ============================================================================

struct JobEntry {
    job: Job,
    cancel: CancelToken,
    /// 重放闭包。由提交方提供；引擎安装与 AI 生成不给（它们有副作用/成本）。
    retry: Option<Arc<dyn Fn() -> Option<JobId> + Send + Sync>>,
}

/// 任务队列。
pub struct JobQueue {
    entries: EntryMap,
    /// 提交顺序（用于稳定排序展示）
    order: parking_lot::Mutex<Vec<String>>,
    /// 全局并发度
    gate: Arc<Semaphore>,
    /// 引擎下载/安装专用闸门：并发 1
    engine_gate: Arc<Semaphore>,
    /// 当前配置的并发度（`Semaphore` 本身不暴露"总量"，只能自己记）
    concurrency: AtomicU64,
    tx: broadcast::Sender<AppEvent>,
    /// 内存里最多保留多少条任务记录
    retain: usize,
}

impl JobQueue {
    pub fn new(concurrency: usize, tx: broadcast::Sender<AppEvent>) -> Self {
        let concurrency = concurrency.max(1);
        Self {
            entries: Arc::new(DashMap::new()),
            order: parking_lot::Mutex::new(Vec::new()),
            gate: Arc::new(Semaphore::new(concurrency)),
            engine_gate: Arc::new(Semaphore::new(1)),
            concurrency: AtomicU64::new(concurrency as u64),
            tx,
            retain: 500,
        }
    }

    /// 调整并发度（设置页改「并发数」时调用）。
    ///
    /// **降低并发不会中断正在跑的任务**：`forget_permits` 只能收回**空闲**的许可，
    /// 已被任务持有的那些要等它们自己结束才归还。也就是说新并发度是"渐近生效"的，
    /// 而不是立刻生效 —— 这是 `Semaphore` 的固有限制，也是更安全的语义
    /// （中途掐断任务会留下半个输出文件）。
    pub fn set_concurrency(&self, n: usize) {
        let n = n.max(1);
        let old = self.concurrency.swap(n as u64, Ordering::SeqCst) as usize;
        if n > old {
            self.gate.add_permits(n - old);
            tracing::info!(from = old, to = n, "任务并发度已提高");
        } else if old > n {
            let want = old - n;
            let forgot = self.gate.forget_permits(want);
            tracing::info!(
                from = old,
                to = n,
                applied = forgot,
                pending = want - forgot,
                "任务并发度已降低（正在运行的任务结束后完全生效）"
            );
        }
    }

    pub fn concurrency(&self) -> usize {
        self.concurrency.load(Ordering::SeqCst) as usize
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AppEvent> {
        self.tx.subscribe()
    }

    /// 创建一个任务记录，返回其上下文。
    pub fn create(&self, kind: JobKind, title: impl Into<String>, total_items: u32) -> JobCtx {
        let job = Job::new(kind, title).with_total(total_items);
        let id = job.id.clone();
        let cancel = CancelToken::new();

        self.entries.insert(
            id.to_string(),
            JobEntry {
                job: job.clone(),
                cancel: cancel.clone(),
                retry: None,
            },
        );
        self.order.lock().push(id.to_string());
        self.prune();

        let _ = self.tx.send(AppEvent::JobUpdated {
            job: Box::new(job),
        });

        JobCtx::new(id, cancel, self.tx.clone(), self.entries.clone())
    }

    /// 注册重放闭包（`jobs_retry` 用）。
    ///
    /// # 闭包为什么要**返回新任务的 id**
    ///
    /// 重放走的是正常的提交流程（`submit_plugin_run` → [`Self::create`]），
    /// 也就是说它会创建一个**新任务**（新 id）。原来这里写的是 `Arc<dyn Fn()>`，
    /// `retry()` 于是只能返回**原任务的 id** —— 调用方拿它去轮询，会一直读到
    /// 上一次的终态（比如「已取消」），而真正在跑的任务在另一个 id 上。
    ///
    /// 这个坑是**写验证脚本时踩到的**：重试之后我按旧 id 轮询，一直看到 `cancelled`，
    /// 于是对已经结束的旧任务又调了一次取消（无效），而新任务还在跑 ——
    /// 结果把新任务正在用的 `soffice.bin` 当成了"取消留下的孤儿进程"。
    /// 一个 API 返回值说谎，能让上游的结论**完全反掉**。
    pub fn set_retry(&self, id: &str, f: Arc<dyn Fn() -> Option<JobId> + Send + Sync>) {
        if let Some(mut e) = self.entries.get_mut(id) {
            e.retry = Some(f);
        }
    }

    /// 在队列里跑一个 runner。
    ///
    /// `f` 返回 `Ok(outputs)` 则任务成功，`Err` 则失败 —— 状态机与事件都在这里统一处理，
    /// runner 只需要关心业务。
    pub fn spawn<F, Fut>(&self, ctx: JobCtx, f: F)
    where
        F: FnOnce(JobCtx) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = ToolforgeResult<Vec<String>>> + Send + 'static,
    {
        let id = ctx.id.to_string();

        // 引擎安装 / 模型下载走串行闸门
        let is_engine_job = self
            .entries
            .get(&id)
            .map(|e| {
                matches!(
                    e.job.kind,
                    JobKind::EngineInstall { .. } | JobKind::ModelDownload { .. }
                )
            })
            .unwrap_or(false);
        let gate = if is_engine_job {
            self.engine_gate.clone()
        } else {
            self.gate.clone()
        };

        let entries = self.entries.clone();
        let tx = self.tx.clone();

        tokio::spawn(async move {
            let permit = match gate.acquire_owned().await {
                Ok(p) => p,
                Err(_) => {
                    tracing::error!(job = %id, "任务闸门已关闭，丢弃任务");
                    return;
                }
            };

            // 排队期间被取消
            if ctx.is_cancelled() {
                finish(&entries, &tx, &id, JobStatus::Cancelled, None, vec![]);
                drop(permit);
                return;
            }

            transition(&entries, &tx, &id, JobStatus::Running);
            ctx.progress_now(JobProgress::indeterminate("执行中"));

            let result = f(ctx.clone()).await;

            match result {
                Ok(outputs) => finish(&entries, &tx, &id, JobStatus::Succeeded, None, outputs),
                Err(e) if e.code == ErrorCode::Cancelled => {
                    finish(&entries, &tx, &id, JobStatus::Cancelled, None, vec![])
                }
                Err(e) => finish(&entries, &tx, &id, JobStatus::Failed, Some(e), vec![]),
            }

            drop(permit);
        });
    }

    pub fn get(&self, id: &str) -> Option<Job> {
        self.entries.get(id).map(|e| e.job.clone())
    }

    /// 按提交顺序返回快照（最新的在前）
    pub fn snapshot(&self, filter: &JobFilter) -> Vec<Job> {
        let order = self.order.lock().clone();
        let mut out: Vec<Job> = order
            .iter()
            .rev()
            .filter_map(|id| self.entries.get(id).map(|e| e.job.clone()))
            .filter(|j| filter.matches(j))
            .collect();
        if let Some(limit) = filter.limit {
            out.truncate(limit as usize);
        }
        out
    }

    pub fn cancel(&self, id: &str) -> ToolforgeResult<Job> {
        let (terminal, was_queued) = {
            let entry = self
                .entries
                .get(id)
                .ok_or_else(|| ToolforgeError::not_found(format!("任务 {id} 不存在")))?;
            (entry.job.status.is_terminal(), entry.job.status == JobStatus::Queued)
        };

        if terminal {
            return self
                .get(id)
                .ok_or_else(|| ToolforgeError::not_found(format!("任务 {id} 不存在")));
        }

        // 先通知 runner 停手（无论它在排队还是运行中）
        if let Some(e) = self.entries.get(id) {
            e.cancel.cancel();
        }

        // 排队中的任务没有 runner 在跑，直接落终态
        if was_queued {
            finish(&self.entries, &self.tx, id, JobStatus::Cancelled, None, vec![]);
        }

        self.get(id)
            .ok_or_else(|| ToolforgeError::not_found(format!("任务 {id} 不存在")))
    }

    /// 重放一个任务，返回**新任务的 id**。
    ///
    /// 新 id 与旧 id 不同是正常且必然的（重放就是重新提交一次）。
    /// 闭包没能给出新 id 时退化为返回原 id —— 那是"提交失败了"的情形，
    /// 调用方会从任务列表/事件里看到原因。
    pub fn retry(&self, id: &str) -> ToolforgeResult<JobId> {
        let f = self
            .entries
            .get(id)
            .and_then(|e| e.retry.clone())
            .ok_or_else(|| {
                ToolforgeError::invalid(format!(
                    "任务 {id} 不支持重试（引擎安装与 AI 生成任务有副作用/成本，必须手动重发）"
                ))
            })?;
        let new_id = f();
        Ok(new_id.unwrap_or_else(|| JobId::from(id)))
    }

    /// 清理已结束的任务记录。返回清理条数。
    pub fn clear_finished(&self) -> usize {
        let order = self.order.lock().clone();
        let mut removed = 0;
        let mut keep: Vec<String> = Vec::with_capacity(order.len());
        for id in order {
            let terminal = self
                .entries
                .get(&id)
                .map(|e| e.job.status.is_terminal())
                .unwrap_or(true);
            if terminal {
                self.entries.remove(&id);
                removed += 1;
            } else {
                keep.push(id);
            }
        }
        *self.order.lock() = keep;
        removed
    }

    /// 统计：运行中 / 排队中
    pub fn active_count(&self) -> usize {
        self.entries
            .iter()
            .filter(|e| e.job.status.is_active())
            .count()
    }

    pub fn stats(&self) -> HashMap<String, usize> {
        let mut m = HashMap::new();
        for e in self.entries.iter() {
            *m.entry(format!("{:?}", e.job.status)).or_insert(0) += 1;
        }
        m
    }

    /// 超过保留上限时，从最旧的终态任务开始丢弃。
    fn prune(&self) {
        if self.order.lock().len() <= self.retain {
            return;
        }
        let mut order = self.order.lock();
        let mut idx = 0;
        while order.len() > self.retain && idx < order.len() {
            let id = order[idx].clone();
            let terminal = self
                .entries
                .get(&id)
                .map(|e| e.job.status.is_terminal())
                .unwrap_or(true);
            if terminal {
                self.entries.remove(&id);
                order.remove(idx);
            } else {
                idx += 1;
            }
        }
    }

    /// 取消所有任务（应用退出时调用）
    pub fn cancel_all(&self) {
        for e in self.entries.iter() {
            if e.job.status.is_active() {
                e.cancel.cancel();
            }
        }
    }
}

// ---- 内部辅助 ----

fn transition(entries: &EntryMap, tx: &broadcast::Sender<AppEvent>, id: &str, next: JobStatus) {
    if let Some(mut e) = entries.get_mut(id) {
        let mut job = e.job.clone();
        if job.transition(next) {
            e.job = job.clone();
            let _ = tx.send(AppEvent::JobUpdated {
                job: Box::new(job),
            });
        }
    }
}

fn finish(
    entries: &EntryMap,
    tx: &broadcast::Sender<AppEvent>,
    id: &str,
    status: JobStatus,
    error: Option<ToolforgeError>,
    outputs: Vec<String>,
) {
    let (job, title, err_msg) = {
        let Some(mut e) = entries.get_mut(id) else {
            return;
        };
        let mut job = e.job.clone();
        job.outputs = outputs;
        match status {
            JobStatus::Succeeded => {
                job.succeed();
            }
            JobStatus::Cancelled => {
                job.cancel();
            }
            JobStatus::Failed => {
                let err = error
                    .clone()
                    .unwrap_or_else(|| ToolforgeError::internal("任务失败但未提供原因"));
                job.fail(err);
            }
            _ => {}
        }
        let title = job.title.clone();
        let err_msg = job.error.as_ref().map(|e| e.message.clone());
        e.job = job.clone();
        (job, title, err_msg)
    };

    let _ = tx.send(AppEvent::JobUpdated {
        job: Box::new(job),
    });
    let _ = tx.send(AppEvent::JobFinished {
        job_id: id.to_string(),
        status,
        title,
        error_message: err_msg,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queue() -> JobQueue {
        let (tx, _rx) = broadcast::channel(256);
        JobQueue::new(2, tx)
    }

    async fn wait_terminal(q: &JobQueue, id: &str) -> Job {
        for _ in 0..200 {
            if let Some(j) = q.get(id) {
                if j.is_terminal() {
                    return j;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(15)).await;
        }
        panic!("任务 {id} 没有在预期时间内结束");
    }

    #[test]
    fn create_registers_job_in_order() {
        let q = queue();
        let a = q.create(JobKind::Convert, "A", 1);
        let b = q.create(JobKind::Convert, "B", 1);
        let snap = q.snapshot(&JobFilter::default());
        assert_eq!(snap.len(), 2);
        assert_eq!(snap[0].id, b.id);
        assert_eq!(snap[1].id, a.id);
        assert_eq!(snap[0].status, JobStatus::Queued);
    }

    #[test]
    fn cancel_queued_job_finalizes_immediately() {
        let q = queue();
        let ctx = q.create(JobKind::Convert, "A", 1);
        let job = q.cancel(ctx.id.as_str()).unwrap();
        assert_eq!(job.status, JobStatus::Cancelled);
        assert!(job.finished_at.is_some());
    }

    #[test]
    fn cancel_unknown_job_is_not_found() {
        let q = queue();
        let err = q.cancel("job-nope").unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
    }

    #[test]
    fn retry_requires_registered_closure() {
        let q = queue();
        let ctx = q.create(
            JobKind::AiGenerate {
                provider: "openai".into(),
            },
            "gen",
            0,
        );
        let err = q.retry(ctx.id.as_str()).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidArgument);
    }

    #[test]
    fn clear_finished_only_removes_terminal() {
        let q = queue();
        let a = q.create(JobKind::Convert, "A", 1);
        q.cancel(a.id.as_str()).unwrap();
        let _b = q.create(JobKind::Convert, "B", 1);
        assert_eq!(q.clear_finished(), 1);
        assert_eq!(q.snapshot(&JobFilter::default()).len(), 1);
    }

    #[test]
    fn filter_by_status_and_search() {
        let q = queue();
        let a = q.create(JobKind::Convert, "风景照转换", 1);
        q.cancel(a.id.as_str()).unwrap();
        let f = JobFilter {
            statuses: vec![JobStatus::Cancelled],
            ..Default::default()
        };
        assert_eq!(q.snapshot(&f).len(), 1);
        let f2 = JobFilter {
            search: Some("风景".into()),
            ..Default::default()
        };
        assert_eq!(q.snapshot(&f2).len(), 1);
        let f3 = JobFilter {
            search: Some("不存在".into()),
            ..Default::default()
        };
        assert_eq!(q.snapshot(&f3).len(), 0);
    }

    #[test]
    fn concurrency_can_be_raised_and_lowered() {
        let q = queue();
        assert_eq!(q.concurrency(), 2);

        q.set_concurrency(8);
        assert_eq!(q.concurrency(), 8);
        assert_eq!(q.gate.available_permits(), 8);

        q.set_concurrency(1);
        assert_eq!(q.concurrency(), 1);
        // 空闲时能立刻收回
        assert_eq!(q.gate.available_permits(), 1);

        // 非法值兜底为 1，不会把队列变成"永不执行"
        q.set_concurrency(0);
        assert_eq!(q.concurrency(), 1);
        assert_eq!(q.gate.available_permits(), 1);
    }

    #[test]
    fn cancel_token_wakes_waiter() {
        let t = CancelToken::new();
        let t2 = t.clone();
        let h = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(30));
            t2.cancel();
        });
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            tokio::time::timeout(std::time::Duration::from_secs(2), t.cancelled())
                .await
                .expect("取消应当唤醒等待者");
        });
        h.join().unwrap();
        assert!(t.check().is_err());
    }

    #[tokio::test]
    async fn spawn_runs_and_succeeds_with_outputs() {
        let q = queue();
        let ctx = q.create(JobKind::Convert, "A", 1);
        let id = ctx.id.to_string();
        q.spawn(ctx, |c| async move {
            c.info("干活");
            Ok(vec!["/out/a.png".into()])
        });
        let job = wait_terminal(&q, &id).await;
        assert_eq!(job.status, JobStatus::Succeeded);
        assert_eq!(job.outputs, vec!["/out/a.png".to_string()]);
        assert!(job.logs.iter().any(|l| l.message == "干活"));
    }

    #[tokio::test]
    async fn spawn_failure_records_error() {
        let q = queue();
        let ctx = q.create(JobKind::Convert, "A", 1);
        let id = ctx.id.to_string();
        q.spawn(ctx, |_c| async move {
            Err(ToolforgeError::engine_missing("ffmpeg"))
        });
        let job = wait_terminal(&q, &id).await;
        assert_eq!(job.status, JobStatus::Failed);
        assert_eq!(job.error.unwrap().code, ErrorCode::EngineMissing);
    }

    #[tokio::test]
    async fn progress_updates_queue_snapshot_and_emits_event() {
        let (tx, mut rx) = broadcast::channel(256);
        let q = JobQueue::new(2, tx);
        let ctx = q.create(JobKind::Convert, "A", 10);
        let id = ctx.id.to_string();

        ctx.progress_now(JobProgress::ratio("半途", 5, 10));

        // 快照被更新
        assert_eq!(q.get(&id).unwrap().progress.value, Some(0.5));

        // 事件被发出
        let mut saw = false;
        while let Ok(ev) = rx.try_recv() {
            if let AppEvent::JobProgressHint { job_id, progress } = ev {
                if job_id == id {
                    assert_eq!(progress.value, Some(0.5));
                    saw = true;
                }
            }
        }
        assert!(saw, "应当发出 JobProgressHint 事件");
    }

    #[tokio::test]
    async fn cancel_while_running_propagates_token() {
        let q = queue();
        let ctx = q.create(JobKind::Convert, "A", 1);
        let id = ctx.id.to_string();
        let inner = ctx.clone();
        q.spawn(ctx, move |_c| async move {
            // 模拟长任务：每 10ms 检查一次取消
            loop {
                inner.check()?;
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        });
        tokio::time::sleep(std::time::Duration::from_millis(60)).await;
        q.cancel(&id).unwrap();
        let job = wait_terminal(&q, &id).await;
        assert_eq!(job.status, JobStatus::Cancelled);
    }
}
