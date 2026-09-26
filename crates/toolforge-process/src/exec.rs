//! 受控的子进程执行。
//!
//! 核心是 [`exec_streaming`]：它同时读 stdout / stderr、把每一行回调给调用方、
//! 支持取消与超时、并在结束时回收进程树。FFmpeg 的进度解析、7-Zip 的输出、
//! Pandoc 的报错全都走这一条路径。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;

use toolforge_core::error::{ErrorCode, ToolforgeError, ToolforgeResult};
use toolforge_core::queue::CancelToken;

/// 输出来源
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamKind {
    Stdout,
    Stderr,
}

/// 保留的输出上限（每个流）。超出后只保留**头部与尾部**，
/// 因为排查问题时最有用的正是这两段（开头是参数回显，结尾是错误原因）。
const KEEP_HEAD: usize = 32 * 1024;
const KEEP_TAIL: usize = 96 * 1024;

#[derive(Debug, Clone)]
pub struct ExecOptions {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    /// 追加/覆盖的环境变量
    pub env: HashMap<String, String>,
    /// 是否清空继承来的环境。
    ///
    /// 起 L3 插件进程时**必须**为 true —— 否则插件能直接读到父进程的
    /// `OPENAI_API_KEY`、代理凭据等一切环境变量。
    pub clear_env: bool,
    /// 超时；`None` 表示不限
    pub timeout: Option<Duration>,
    /// 取消令牌
    pub cancel: Option<CancelToken>,
    /// 传入 stdin 的内容（例如 pandoc 从 stdin 读文档）
    pub stdin_data: Option<String>,
    /// 是否只保留尾部输出（批量处理时不要把 3000 个文件的信息都堆在内存里）
    pub quiet: bool,
}

impl ExecOptions {
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            cwd: None,
            env: HashMap::new(),
            clear_env: false,
            timeout: None,
            cancel: None,
            stdin_data: None,
            quiet: false,
        }
    }

    pub fn arg(mut self, a: impl Into<String>) -> Self {
        self.args.push(a.into());
        self
    }

    pub fn args<I, S>(mut self, it: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.args.extend(it.into_iter().map(Into::into));
        self
    }

    pub fn cwd(mut self, p: impl Into<PathBuf>) -> Self {
        self.cwd = Some(p.into());
        self
    }

    pub fn env(mut self, k: impl Into<String>, v: impl Into<String>) -> Self {
        self.env.insert(k.into(), v.into());
        self
    }

    pub fn clear_env(mut self, yes: bool) -> Self {
        self.clear_env = yes;
        self
    }

    pub fn timeout(mut self, d: Duration) -> Self {
        self.timeout = Some(d);
        self
    }

    pub fn cancel(mut self, t: CancelToken) -> Self {
        self.cancel = Some(t);
        self
    }

    pub fn quiet(mut self, yes: bool) -> Self {
        self.quiet = yes;
        self
    }

    /// 把命令行拼成可读字符串（**仅供日志/错误提示**，不要拿去执行 ——
    /// 那样会把参数注入问题重新引进来）。
    pub fn display_command(&self) -> String {
        let mut s = shell_quote(&self.program.display().to_string());
        for a in &self.args {
            s.push(' ');
            s.push_str(&shell_quote(a));
        }
        s
    }
}

/// 仅仅为了日志可读性做的引用包裹，不是 shell 转义。
fn shell_quote(s: &str) -> String {
    if s.is_empty() {
        return "\"\"".into();
    }
    if s.chars().any(|c| c.is_whitespace() || matches!(c, '"' | '\'')) {
        format!("\"{}\"", s.replace('"', "\\\""))
    } else {
        s.to_string()
    }
}

#[derive(Debug, Clone, Default)]
pub struct ExecResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    /// 进程是被我们主动杀掉的（取消 / 超时）
    pub killed: bool,
    /// 输出被截断过
    pub truncated: bool,
}

impl ExecResult {
    pub fn success(&self) -> bool {
        self.exit_code == 0 && !self.killed
    }

    /// 失败时构造一个带诊断信息的错误。诊断信息包含 stderr **尾部** ——
    /// 外部工具几乎总是把真正的错误放在最后几行。
    pub fn into_error(self, engine: &str) -> ToolforgeError {
        if self.success() {
            return ToolforgeError::internal("into_error 被用在成功的执行结果上");
        }
        let tail: String = self
            .stderr
            .lines()
            .rev()
            .take(20)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        ToolforgeError::engine_failed(
            engine,
            format!("{} 执行失败（退出码 {}）", engine, self.exit_code),
        )
        .with_detail(if tail.is_empty() {
            self.stdout.chars().take(2000).collect()
        } else {
            tail
        })
    }
}

/// 环形输出缓冲：保留头部 `KEEP_HEAD` 与尾部 `KEEP_TAIL`。
struct TailBuffer {
    head: String,
    tail: std::collections::VecDeque<String>,
    tail_bytes: usize,
    truncated: bool,
}

impl TailBuffer {
    fn new() -> Self {
        Self {
            head: String::new(),
            tail: std::collections::VecDeque::new(),
            tail_bytes: 0,
            truncated: false,
        }
    }

    fn push_line(&mut self, line: &str) {
        if self.head.len() < KEEP_HEAD {
            self.head.push_str(line);
            self.head.push('\n');
            return;
        }
        self.truncated = true;
        self.tail_bytes += line.len() + 1;
        self.tail.push_back(line.to_string());
        while self.tail_bytes > KEEP_TAIL {
            if let Some(front) = self.tail.pop_front() {
                self.tail_bytes -= front.len() + 1;
            } else {
                break;
            }
        }
    }

    fn finish(self) -> (String, bool) {
        if self.tail.is_empty() {
            return (self.head, self.truncated);
        }
        let mut s = self.head;
        s.push_str("\n…（中间输出已省略）…\n");
        for l in self.tail {
            s.push_str(&l);
            s.push('\n');
        }
        (s, self.truncated)
    }
}

/// 执行子进程并流式回调每一行输出。
///
/// `on_line` 会在**当前任务**里被调用（不是 spawn 出去的），所以它可以安全地
/// 捕获 `&mut` 状态，例如 FFmpeg 的进度累加器。
pub async fn exec_streaming<F>(opts: ExecOptions, mut on_line: F) -> ToolforgeResult<ExecResult>
where
    F: FnMut(StreamKind, &str) + Send + 'static,
{
    let started = Instant::now();
    let program_display = opts.program.display().to_string();

    if !opts.program.exists() {
        return Err(ToolforgeError::new(
            ErrorCode::EngineMissing,
            format!("可执行文件不存在：{program_display}"),
        )
        .with_detail("可能是引擎尚未安装，或路径被移动。请到「引擎管理」重新探测。"));
    }

    let mut cmd = tokio::process::Command::new(&opts.program);
    cmd.args(&opts.args);
    cmd.stdin(if opts.stdin_data.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);

    if opts.clear_env {
        cmd.env_clear();
    }
    for (k, v) in &opts.env {
        cmd.env(k, v);
    }
    if let Some(cwd) = &opts.cwd {
        if !cwd.exists() {
            std::fs::create_dir_all(cwd).map_err(|e| {
                ToolforgeError::io(format!("无法创建工作目录 {}：{e}", cwd.display()))
            })?;
        }
        cmd.current_dir(cwd);
    }

    // GUI 程序调用控制台程序时不要弹黑框
    crate::hide_console(&mut cmd);
    crate::detach_process_group(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| {
        ToolforgeError::engine_failed(
            "process",
            format!("无法启动 {program_display}：{e}"),
        )
        .with_detail(format!("完整命令：{}", opts.display_command()))
    })?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let mut stdin = child.stdin.take();

    // 写入 stdin（如果有）
    if let Some(data) = opts.stdin_data.clone() {
        if let Some(mut si) = stdin.take() {
            tokio::spawn(async move {
                use tokio::io::AsyncWriteExt;
                let _ = si.write_all(data.as_bytes()).await;
                let _ = si.shutdown().await;
            });
        }
    }

    // 两个流都交给独立任务读，**避免管道缓冲区写满导致死锁**
    let (tx, mut rx) = mpsc::unbounded_channel::<(StreamKind, String)>();
    let mut readers = Vec::new();

    if let Some(out) = stdout {
        let tx = tx.clone();
        readers.push(tokio::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if tx.send((StreamKind::Stdout, line)).is_err() {
                    break;
                }
            }
        }));
    }
    if let Some(err) = stderr {
        let tx = tx.clone();
        readers.push(tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if tx.send((StreamKind::Stderr, line)).is_err() {
                    break;
                }
            }
        }));
    }
    drop(tx); // 让 rx 在所有 reader 结束后自然关闭

    let mut out_buf = TailBuffer::new();
    let mut err_buf = TailBuffer::new();
    let mut killed = false;
    let mut kill_reason: Option<ToolforgeError> = None;

    // 等待进程结束，同时消费输出行
    let deadline = opts.timeout.map(|d| tokio::time::Instant::now() + d);
    let cancel = opts.cancel.clone();

    loop {
        tokio::select! {
            maybe = rx.recv() => {
                match maybe {
                    Some((kind, line)) => {
                        if !opts.quiet {
                            match kind {
                                StreamKind::Stdout => out_buf.push_line(&line),
                                StreamKind::Stderr => err_buf.push_line(&line),
                            }
                        }
                        on_line(kind, &line);
                    }
                    None => break, // 所有 reader 结束
                }
            }
            status = child.wait() => {
                // 进程已退出：把剩余输出读完（reader 任务会自然结束）
                let code = status.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
                while let Ok((kind, line)) = rx.try_recv() {
                    if !opts.quiet {
                        match kind {
                            StreamKind::Stdout => out_buf.push_line(&line),
                            StreamKind::Stderr => err_buf.push_line(&line),
                        }
                    }
                    on_line(kind, &line);
                }
                // 收尾：等 reader 把缓冲区里剩下的行吐完
                for r in readers.drain(..) {
                    let _ = tokio::time::timeout(Duration::from_secs(2), r).await;
                }
                while let Ok((kind, line)) = rx.try_recv() {
                    if !opts.quiet {
                        match kind {
                            StreamKind::Stdout => out_buf.push_line(&line),
                            StreamKind::Stderr => err_buf.push_line(&line),
                        }
                    }
                    on_line(kind, &line);
                }
                let (stdout_s, t1) = out_buf.finish();
                let (stderr_s, t2) = err_buf.finish();

                if let Some(e) = kill_reason {
                    let _ = &e; // 已经在下面返回
                    return Err(e);
                }

                return Ok(ExecResult {
                    exit_code: code,
                    stdout: stdout_s,
                    stderr: stderr_s,
                    duration_ms: started.elapsed().as_millis() as u64,
                    killed,
                    truncated: t1 || t2,
                });
            }
            _ = async {
                match &cancel {
                    Some(c) => c.cancelled().await,
                    None => std::future::pending::<()>().await,
                }
            } => {
                killed = true;
                kill_reason = Some(ToolforgeError::new(ErrorCode::Cancelled, "进程已被取消"));
                let _ = child.kill().await;
            }
            _ = async {
                match deadline {
                    Some(d) => tokio::time::sleep_until(d).await,
                    None => std::future::pending::<()>().await,
                }
            } => {
                killed = true;
                let secs = opts.timeout.map(|d| d.as_secs()).unwrap_or(0);
                kill_reason = Some(
                    ToolforgeError::new(ErrorCode::Timeout, format!("进程执行超过 {secs} 秒被终止"))
                        .with_subject(&program_display),
                );
                let _ = child.kill().await;
            }
        }
    }

    // 走到这里说明输出通道关闭但进程还没收尸（极少见）
    let status = child.wait().await;
    let code = status.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
    for r in readers.drain(..) {
        let _ = tokio::time::timeout(Duration::from_secs(1), r).await;
    }
    let (stdout_s, t1) = out_buf.finish();
    let (stderr_s, t2) = err_buf.finish();

    if let Some(e) = kill_reason {
        return Err(e);
    }

    Ok(ExecResult {
        exit_code: code,
        stdout: stdout_s,
        stderr: stderr_s,
        duration_ms: started.elapsed().as_millis() as u64,
        killed,
        truncated: t1 || t2,
    })
}

/// 简单执行：不关心中间输出，直接拿结果。
pub async fn exec(opts: ExecOptions) -> ToolforgeResult<ExecResult> {
    exec_streaming(opts, |_, _| {}).await
}

/// 执行并断言成功；失败时返回带 stderr 尾部的错误。
pub async fn exec_checked(opts: ExecOptions, engine: &str) -> ToolforgeResult<ExecResult> {
    let r = exec(opts).await?;
    if r.success() {
        Ok(r)
    } else {
        Err(r.into_error(engine))
    }
}

/// 让一个"只想知道版本号"的探测不再重复写样板。
pub async fn probe_version(program: &Path, args: &[&str]) -> Option<String> {
    let opts = ExecOptions::new(program)
        .args(args.iter().map(|s| s.to_string()))
        .timeout(Duration::from_secs(10))
        .quiet(true);
    let r = exec(opts).await.ok()?;
    // 大多数工具把版本打到 stderr（FFmpeg 就是），所以两边都看
    let text = if r.stdout.trim().is_empty() {
        r.stderr
    } else {
        r.stdout
    };
    let first = text.lines().find(|l| !l.trim().is_empty())?.trim().to_string();
    Some(truncate(&first, 200))
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect::<String>() + "…"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn echo_program() -> PathBuf {
        // 用一个跨平台都存在的程序：Windows 上是 cmd，类 Unix 上是 sh
        #[cfg(windows)]
        {
            PathBuf::from("C:\\Windows\\System32\\cmd.exe")
        }
        #[cfg(not(windows))]
        {
            PathBuf::from("/bin/sh")
        }
    }

    #[cfg(windows)]
    fn echo_opts(text: &str) -> ExecOptions {
        ExecOptions::new(echo_program())
            .arg("/C")
            .arg(format!("echo {text}"))
    }
    #[cfg(not(windows))]
    fn echo_opts(text: &str) -> ExecOptions {
        ExecOptions::new(echo_program())
            .arg("-c")
            .arg(format!("echo {text}"))
    }

    #[tokio::test]
    async fn captures_stdout() {
        let r = exec(echo_opts("hello-toolforge")).await.unwrap();
        assert!(r.success(), "exit={} stderr={}", r.exit_code, r.stderr);
        assert!(r.stdout.contains("hello-toolforge"));
    }

    #[tokio::test]
    async fn streaming_callback_receives_lines() {
        let lines = std::sync::Arc::new(parking_lot::Mutex::new(Vec::new()));
        let sink = lines.clone();
        let _ = exec_streaming(echo_opts("streamed"), move |_, l| {
            sink.lock().push(l.to_string());
        })
        .await
        .unwrap();
        assert!(lines.lock().iter().any(|l| l.contains("streamed")));
    }

    #[tokio::test]
    async fn missing_program_is_engine_missing() {
        let err = exec(ExecOptions::new("/definitely/not/here/xyz")).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::EngineMissing);
    }

    #[tokio::test]
    async fn timeout_kills_process() {
        #[cfg(windows)]
        let opts = ExecOptions::new(echo_program())
            .arg("/C")
            .arg("ping -n 20 127.0.0.1 > NUL");
        #[cfg(not(windows))]
        let opts = ExecOptions::new(echo_program()).arg("-c").arg("sleep 20");

        let err = exec(opts.timeout(Duration::from_millis(400)))
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Timeout, "{err}");
    }

    #[tokio::test]
    async fn cancel_token_kills_process() {
        #[cfg(windows)]
        let opts = ExecOptions::new(echo_program())
            .arg("/C")
            .arg("ping -n 20 127.0.0.1 > NUL");
        #[cfg(not(windows))]
        let opts = ExecOptions::new(echo_program()).arg("-c").arg("sleep 20");

        let token = CancelToken::new();
        let t2 = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            t2.cancel();
        });
        let err = exec(opts.cancel(token)).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Cancelled);
    }

    #[tokio::test]
    async fn nonzero_exit_becomes_engine_error_with_stderr_tail() {
        #[cfg(windows)]
        let opts = ExecOptions::new(echo_program())
            .arg("/C")
            .arg("echo boom 1>&2 & exit 3");
        #[cfg(not(windows))]
        let opts = ExecOptions::new(echo_program())
            .arg("-c")
            .arg("echo boom 1>&2; exit 3");

        let err = exec_checked(opts, "ffmpeg").await.unwrap_err();
        assert_eq!(err.code, ErrorCode::EngineFailed);
        assert!(
            err.detail.as_deref().unwrap_or("").contains("boom"),
            "错误详情应包含 stderr 尾部：{:?}",
            err.detail
        );
    }

    #[test]
    fn display_command_quotes_paths_with_spaces() {
        let o = ExecOptions::new("C:\\Program Files\\FFmpeg\\ffmpeg.exe").arg("-i").arg("a b.mp4");
        let d = o.display_command();
        assert!(d.contains("\"C:\\Program Files\\FFmpeg\\ffmpeg.exe\""));
        assert!(d.contains("\"a b.mp4\""));
    }

    #[test]
    fn tail_buffer_keeps_head_and_tail() {
        let mut b = TailBuffer::new();
        for i in 0..20_000 {
            b.push_line(&format!("line-{i}-{}", "x".repeat(20)));
        }
        let (s, truncated) = b.finish();
        assert!(truncated);
        assert!(s.contains("line-0-"));
        assert!(s.contains("line-19999-"));
        assert!(s.len() < KEEP_HEAD + KEEP_TAIL + 4096);
    }
}
