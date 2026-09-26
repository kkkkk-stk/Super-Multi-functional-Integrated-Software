//! # toolforge-process
//!
//! ToolForge 里**所有对外部程序的调用**都经过这个 crate。它存在的理由是：
//! 直接 `Command::new(...).output().await` 会立刻踩到四个坑，而且每个坑都会以
//! "偶发、难复现"的形式出现：
//!
//! 1. **管道死锁**：子进程往 stderr 写满 64KB 缓冲区而我们只读 stdout → 双方互等。
//!    FFmpeg 往 stderr 打进度时这是必然发生的。解决办法是两个流都必须有人读。
//! 2. **取消不生效**：用户点了"取消"，但 `output()` 会一直等到子进程自己结束。
//!    必须把取消令牌接进来，并在取消时主动 kill（含子进程树）。
//! 3. **控制台窗口闪现**：Windows 上从 GUI 进程起控制台程序，会弹出黑框。
//!    必须加 `CREATE_NO_WINDOW`。
//! 4. **输出无限膨胀**：一个跑歪的 FFmpeg 能往 stderr 吐几百 MB。
//!    必须对保留的输出做上限裁剪。
//!
//! 另外 [`supervisor`] 提供了**常驻子进程**的管理能力（L3 Python 插件、
//! LibreOffice UNO listener 都要用），协议是 JSON-RPC 2.0 按行分帧。
//!
//! ## 安全边界（诚实说明）
//!
//! 本 crate **不是**操作系统级沙箱。`clear_env` + 锁定 `cwd` + 断网环境变量
//! 只能挡住"顺手而为"的越权，挡不住蓄意攻击。真正的隔离要靠：
//! WASM 沙箱（L2）、以及未来接入 Windows Job Object / macOS sandbox-exec。
//! 详见 `docs/SECURITY.md`。

pub mod exec;
pub mod rpc;
pub mod supervisor;

pub use exec::{exec, exec_streaming, ExecOptions, ExecResult, StreamKind};
pub use rpc::{RpcError, RpcMessage, RpcRequest, RpcResponse};
pub use supervisor::{ChildSupervisor, SupervisorState};

/// 本 crate 统一复用 core 的错误类型，避免出现第二套错误体系。
pub use toolforge_core::{ToolforgeError, ToolforgeResult};

/// Windows 上隐藏控制台窗口的标志位。
///
/// 不加这个，用户每次转码都会看到黑框一闪 —— 这是 GUI 程序调用控制台程序时的
/// 经典问题，且只在 release 包里才明显（debug 下从终端启动看不到）。
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 把 tokio 命令配置成"不弹窗"（仅 Windows 有实际作用）
#[cfg(windows)]
pub fn hide_console(cmd: &mut tokio::process::Command) {
    use std::os::windows::process::CommandExt;
    cmd.as_std_mut().creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub fn hide_console(_cmd: &mut tokio::process::Command) {}

/// 把 tokio 命令配置成"拥有自己的进程组"。
///
/// Unix 上用 `process_group(0)`，这样取消时可以整个进程组一起杀 ——
/// 否则 FFmpeg 派生出的子进程会变成孤儿继续跑。
#[cfg(unix)]
pub fn detach_process_group(cmd: &mut tokio::process::Command) {
    use std::os::unix::process::CommandExt;
    let _ = &cmd;
    // tokio 的 Command 没有直接暴露 process_group；这里通过 as_std_mut 设置
    cmd.as_std_mut().process_group(0);
}

#[cfg(not(unix))]
pub fn detach_process_group(_cmd: &mut tokio::process::Command) {}
