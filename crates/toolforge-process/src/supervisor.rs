//! 常驻子进程管理（JSON-RPC over stdio）。
//!
//! ## 为什么需要"常驻"
//!
//! L3 Python 插件和 LibreOffice listener 有一个共同特征：**启动成本远大于单次调用成本**。
//! * 加载一个 ONNX 抠图模型要 1~3 秒；
//! * LibreOffice 冷启动要 2~5 秒。
//!
//! 如果每次调用都 `spawn` 一个新进程，批量处理 100 个文件就要多花几分钟，
//! 而且每个进程都要重新加载模型（内存峰值 × 并发数）。所以这里实现的是
//! **一个插件 id ↔ 一个常驻进程**，进程内自己维护模型缓存。
//!
//! ## 生命周期
//!
//! ```text
//!  spawn ──► initialize ──► [ run, run, run ... ]  ──► shutdown ──► 退出
//!                 │                │                      │
//!                 └── 失败则整条链路标记为不可用          └── 超时后强杀
//! ```
//!
//! 进程意外退出时，[`ChildSupervisor::call`] 会返回
//! [`rpc::codes::PROCESS_GONE`]，由上层决定是"重启一次再试"还是直接报错 ——
//! 这里不做自动重启：静默重启会把"插件反复崩溃"这件事藏起来。

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{oneshot, Mutex};

use toolforge_core::error::{ErrorCode, ToolforgeError, ToolforgeResult};

use crate::rpc::{codes, RpcError, RpcMessage, RpcResponse};

/// 插件主动发来的通知队列（`progress` / `log` / `host.request`）。
///
/// 用 `Arc<Mutex<VecDeque>>` 而不是 channel，是为了让调用方能在**持有
/// supervisor 的可变借用**（正在 `call`）的同时读取通知 —— channel 的
/// receiver 也需要 `&mut`，会造成借用冲突。
pub type NotificationQueue = Arc<Mutex<VecDeque<Value>>>;

/// 常驻进程的生命周期状态
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupervisorState {
    /// 刚创建，还没 spawn
    Created,
    /// 进程已起，正在等一下 initialize 的回复
    Initializing,
    /// 可用
    Ready,
    /// 插件自己报告不可用（依赖装不上、模型加载失败）
    Unavailable,
    /// 进程已退出
    Dead,
}

impl SupervisorState {
    pub fn is_usable(self) -> bool {
        matches!(self, SupervisorState::Ready)
    }
}

/// 进程配置
#[derive(Debug, Clone)]
pub struct SpawnSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    /// 额外环境变量
    pub env: HashMap<String, String>,
    /// 是否清空继承的环境（L3 必须为 true）
    pub clear_env: bool,
    /// 断网：设置无效代理环境变量 + 不注入任何网络凭据。
    ///
    /// **诚实说明**：这只挡住"顺手访问网络"的代码，不是内核级隔离。
    /// 真正的网络隔离要等 Job Object / sandbox-exec 接入。
    pub deny_network: bool,
    /// 单次 `call` 的默认超时
    pub default_timeout: Duration,
    /// initialize 的超时（模型加载慢，给足时间）
    pub init_timeout: Duration,
}

impl SpawnSpec {
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            cwd: None,
            env: HashMap::new(),
            clear_env: true,
            deny_network: true,
            default_timeout: Duration::from_secs(120),
            init_timeout: Duration::from_secs(300),
        }
    }
}

/// 一个常驻子进程。
pub struct ChildSupervisor {
    name: String,
    state: SupervisorState,
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    /// 收到的、尚未被取走的响应
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<RpcResponse>>>>,
    /// 插件主动发来的通知（progress / log）——统一转成事件
    notifications: NotificationQueue,
    next_id: AtomicU64,
    /// 记录最近的 stderr，进程挂掉时用来解释原因
    stderr_tail: Arc<Mutex<Vec<String>>>,
    dead: Arc<AtomicBool>,
}

impl ChildSupervisor {
    /// 启动进程。
    pub async fn spawn(name: impl Into<String>, spec: SpawnSpec) -> ToolforgeResult<Self> {
        let name = name.into();

        if !spec.program.exists() {
            return Err(ToolforgeError::new(
                ErrorCode::EngineMissing,
                format!("插件运行时不存在：{}", spec.program.display()),
            )
            .with_subject(&name));
        }

        let mut cmd = tokio::process::Command::new(&spec.program);
        cmd.args(&spec.args);
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        cmd.kill_on_drop(true);

        if spec.clear_env {
            cmd.env_clear();
        }
        // 至少要给 PATH，否则 Windows 上子进程自己起程序会失败
        if let Ok(path) = std::env::var("PATH") {
            cmd.env("PATH", path);
        }
        // 保证 Python 的 stdout 不被缓冲 —— 否则协议帧会积在缓冲区里永远读不到
        cmd.env("PYTHONUNBUFFERED", "1");
        cmd.env("PYTHONIOENCODING", "utf-8");
        cmd.env("PYTHONDONTWRITEBYTECODE", "1");

        for (k, v) in &spec.env {
            cmd.env(k, v);
        }

        if spec.deny_network {
            // 指向一个必然连不上的地址：能挡住 requests/urllib 这类"顺手"调用
            cmd.env("HTTP_PROXY", "http://127.0.0.1:1");
            cmd.env("HTTPS_PROXY", "http://127.0.0.1:1");
            cmd.env("http_proxy", "http://127.0.0.1:1");
            cmd.env("https_proxy", "http://127.0.0.1:1");
            cmd.env("NO_PROXY", "");
            // 明确告诉插件"你没有网络"，让写得好的插件直接给出友好报错
            cmd.env("TOOLFORGE_NETWORK", "denied");
        } else {
            cmd.env("TOOLFORGE_NETWORK", "allowed");
        }

        if let Some(cwd) = &spec.cwd {
            if !cwd.exists() {
                std::fs::create_dir_all(cwd).map_err(|e| {
                    ToolforgeError::io(format!("无法创建插件工作目录 {}：{e}", cwd.display()))
                })?;
            }
            cmd.current_dir(cwd);
        }

        crate::hide_console(&mut cmd);
        crate::detach_process_group(&mut cmd);

        let mut child = cmd
            .spawn()
            .map_err(|e| ToolforgeError::runtime(format!("无法启动插件进程 `{name}`：{e}")))?;

        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let pending: Arc<Mutex<HashMap<String, oneshot::Sender<RpcResponse>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let stderr_tail: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let dead = Arc::new(AtomicBool::new(false));
        let notifications: NotificationQueue = Arc::new(Mutex::new(VecDeque::new()));

        // ---- stdout 读循环：协议帧 ----
        if let Some(out) = stdout {
            let pending = pending.clone();
            let dead = dead.clone();
            let name = name.clone();
            let notifications = notifications.clone();
            tokio::spawn(async move {
                /// 通知队列上限：插件疯狂刷进度时不能把内存吃光
                const MAX_QUEUE: usize = 512;
                let mut lines = BufReader::new(out).lines();
                loop {
                    match lines.next_line().await {
                        Ok(Some(line)) => {
                            if line.trim().is_empty() {
                                continue;
                            }
                            let notification = match RpcMessage::parse_line(&line) {
                                Ok(RpcMessage::Response(resp)) => {
                                    let key =
                                        resp.id.as_ref().map(|v| v.to_string()).unwrap_or_default();
                                    let waiter = pending.lock().await.remove(&key);
                                    match waiter {
                                        Some(tx) => {
                                            let _ = tx.send(resp);
                                        }
                                        None => tracing::warn!(
                                            plugin = %name,
                                            "收到无人等待的响应 id={key}（可能已超时）"
                                        ),
                                    }
                                    None
                                }
                                Ok(RpcMessage::Notification { method, params }) => {
                                    Some(serde_json::json!({ "method": method, "params": params }))
                                }
                                Ok(RpcMessage::Request(req)) => {
                                    // 插件向宿主发请求（通常是想申请权限）。
                                    // 宿主不主动满足这类请求 —— 能力必须在装载前就授权好。
                                    Some(serde_json::json!({
                                        "method": "host.request",
                                        "params": { "method": req.method, "params": req.params },
                                    }))
                                }
                                Err(e) => {
                                    // 插件里一个意外的 print() 会走到这里。
                                    // **不能因此断开连接**，当成插件日志转发即可。
                                    tracing::debug!(plugin = %name, "非协议行：{}", e.message);
                                    Some(serde_json::json!({
                                        "method": "log",
                                        "params": { "level": "debug", "message": line }
                                    }))
                                }
                            };

                            if let Some(n) = notification {
                                let mut q = notifications.lock().await;
                                q.push_back(n);
                                while q.len() > MAX_QUEUE {
                                    q.pop_front();
                                }
                            }
                        }
                        Ok(None) => break, // EOF
                        Err(e) => {
                            tracing::warn!(plugin = %name, "读取插件 stdout 失败：{e}");
                            break;
                        }
                    }
                }
                // stdout 关闭 = 进程基本已退出
                dead.store(true, Ordering::SeqCst);
                // 唤醒所有还在等的调用者
                let mut map = pending.lock().await;
                for (_, tx) in map.drain() {
                    let _ = tx.send(RpcResponse::err(
                        None,
                        RpcError::new(codes::PROCESS_GONE, "插件进程已退出"),
                    ));
                }
            });
        }

        // ---- stderr 读循环：只保留尾部，用于解释崩溃 ----
        if let Some(err) = stderr {
            let tail = stderr_tail.clone();
            let name = name.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(err).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::debug!(plugin = %name, "[stderr] {}", line);
                    let mut t = tail.lock().await;
                    t.push(line);
                    if t.len() > 200 {
                        t.remove(0);
                    }
                }
            });
        }

        Ok(Self {
            name,
            state: SupervisorState::Created,
            child: Some(child),
            stdin,
            pending,
            notifications,
            next_id: AtomicU64::new(1),
            stderr_tail,
            dead,
        })
    }

    pub fn state(&self) -> SupervisorState {
        if self.dead.load(Ordering::SeqCst) {
            SupervisorState::Dead
        } else {
            self.state
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// 取走一条插件主动发来的通知（progress / log / host.request）
    pub async fn next_notification(&self) -> Option<Value> {
        self.notifications.lock().await.pop_front()
    }

    pub fn try_next_notification_blocking(&self) -> Option<Value> {
        self.notifications.try_lock().ok()?.pop_front()
    }

    /// 拿到通知队列的共享句柄。
    ///
    /// 调用方在**持有 supervisor 可变借用**（正在 `call`）时用它与 `tokio::select!`
    /// 配合消费进度通知 —— 直接调 `&mut self` 的方法会造成借用冲突。
    pub fn notification_queue(&self) -> NotificationQueue {
        self.notifications.clone()
    }

    /// 清空通知队列
    pub async fn drain_notifications(&self) -> Vec<Value> {
        let mut q = self.notifications.lock().await;
        q.drain(..).collect()
    }

    /// 走一遍握手。插件不实现 `initialize` 时视为无状态插件，直接标记 Ready。
    pub async fn initialize(&mut self, params: Value, timeout: Duration) -> ToolforgeResult<Value> {
        self.state = SupervisorState::Initializing;
        match self.call_raw("initialize", params, timeout).await {
            Ok(v) => {
                self.state = SupervisorState::Ready;
                Ok(v)
            }
            Err(e) if e.code == codes::METHOD_NOT_FOUND => {
                // 合法的简化实现：没有 initialize 就当无状态
                tracing::info!(plugin = %self.name, "插件未实现 initialize，按无状态插件处理");
                self.state = SupervisorState::Ready;
                Ok(Value::Null)
            }
            Err(e) => {
                self.state = SupervisorState::Unavailable;
                Err(self.decorate(e))
            }
        }
    }

    /// 调用插件方法。
    pub async fn call(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> ToolforgeResult<Value> {
        self.call_raw(method, params, timeout)
            .await
            .map_err(|e| self.decorate(e))
    }

    /// 发通知（不需要回复）
    pub async fn notify(&mut self, method: &str, params: Value) -> ToolforgeResult<()> {
        let msg = crate::rpc::notification(method, params);
        self.write_line(&msg.to_line()).await
    }

    async fn call_raw(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, RpcError> {
        if self.dead.load(Ordering::SeqCst) {
            return Err(RpcError::new(codes::PROCESS_GONE, "插件进程已退出"));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let key = Value::from(id).to_string();

        let (tx, rx) = oneshot::channel::<RpcResponse>();
        self.pending.lock().await.insert(key.clone(), tx);

        let line = RpcMessage::Request(crate::rpc::RpcRequest::new(id, method, params)).to_line();
        if let Err(e) = self.write_line(&line).await {
            self.pending.lock().await.remove(&key);
            return Err(RpcError::new(codes::PROCESS_GONE, e.message));
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(resp)) => resp.into_result(),
            Ok(Err(_)) => Err(RpcError::new(codes::PROCESS_GONE, "插件进程已退出")),
            Err(_) => {
                // 超时：把等待者摘掉，避免响应迟到时串到下一次调用上
                self.pending.lock().await.remove(&key);
                Err(RpcError::new(
                    codes::TIMEOUT,
                    format!("插件方法 `{method}` 执行超过 {} 秒", timeout.as_secs()),
                ))
            }
        }
    }

    async fn write_line(&mut self, line: &str) -> ToolforgeResult<()> {
        let Some(stdin) = self.stdin.as_mut() else {
            return Err(ToolforgeError::runtime("插件进程的 stdin 已关闭"));
        };
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| ToolforgeError::runtime(format!("写入插件进程失败：{e}")))?;
        stdin
            .flush()
            .await
            .map_err(|e| ToolforgeError::runtime(format!("刷新插件进程管道失败：{e}")))?;
        Ok(())
    }

    /// 优雅关闭：先请求 shutdown，超时后强杀。
    pub async fn shutdown(&mut self, grace: Duration) {
        if self.dead.load(Ordering::SeqCst) {
            return;
        }
        // 关掉 stdin 本身就是最强的"该退出了"信号
        let _ = self.call_raw("shutdown", Value::Null, grace).await;
        self.stdin.take(); // 关闭 stdin -> 触发插件侧 EOF

        if let Some(mut child) = self.child.take() {
            match tokio::time::timeout(grace, child.wait()).await {
                Ok(_) => tracing::debug!(plugin = %self.name, "插件进程已优雅退出"),
                Err(_) => {
                    tracing::warn!(plugin = %self.name, "插件进程未在宽限期内退出，强制结束");
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                }
            }
        }
        self.state = SupervisorState::Dead;
    }

    /// 立即强杀（应用退出时用）
    pub async fn kill(&mut self) {
        self.stdin.take();
        if let Some(mut child) = self.child.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        self.state = SupervisorState::Dead;
    }

    /// 把 RPC 错误翻译成领域错误，并附带 stderr 尾部（排查插件崩溃的关键线索）
    fn decorate(&self, e: RpcError) -> ToolforgeError {
        let code = match e.code {
            codes::PROCESS_GONE => ErrorCode::PluginRuntime,
            codes::TIMEOUT => ErrorCode::Timeout,
            codes::PERMISSION_DENIED => ErrorCode::PluginCapabilityViolation,
            codes::NOT_INITIALIZED => ErrorCode::PluginRuntime,
            _ => ErrorCode::PluginRuntime,
        };
        let mut err = ToolforgeError::new(code, format!("插件 `{}`：{}", self.name, e.message))
            .with_subject(&self.name);
        if let Some(data) = e.data {
            err = err.with_detail(format!("插件返回的 data：{data}"));
        }
        if let Ok(tail) = self.stderr_tail.try_lock() {
            if !tail.is_empty() {
                let joined = tail
                    .iter()
                    .rev()
                    .take(15)
                    .cloned()
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
                    .join("\n");
                err = err.with_detail(joined);
            }
        }
        err
    }
}

impl Drop for ChildSupervisor {
    fn drop(&mut self) {
        // 不在这里 await（Drop 不能异步）。kill_on_drop 会兜底，
        // 但正常路径应当显式调用 shutdown()。
        if let Some(child) = self.child.as_mut() {
            let _ = child.start_kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_spec_defaults_are_safe() {
        let s = SpawnSpec::new("python");
        // 安全默认值：清空环境 + 禁网
        assert!(s.clear_env, "默认必须清空继承的环境变量");
        assert!(s.deny_network, "默认必须禁网");
    }

    #[test]
    fn state_usability() {
        assert!(SupervisorState::Ready.is_usable());
        assert!(!SupervisorState::Unavailable.is_usable());
        assert!(!SupervisorState::Dead.is_usable());
    }

    #[tokio::test]
    async fn missing_program_reports_engine_missing() {
        let spec = SpawnSpec::new("/definitely/not/here/python");
        // 注意：不能用 unwrap_err()，因为 ChildSupervisor 没实现 Debug
        match ChildSupervisor::spawn("test", spec).await {
            Ok(_) => panic!("不存在的程序不应该启动成功"),
            Err(e) => assert_eq!(e.code, ErrorCode::EngineMissing),
        }
    }
}
