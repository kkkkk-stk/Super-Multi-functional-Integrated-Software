//! L3 · Python 独立进程运行时。
//!
//! ## 协议
//!
//! 走 [`toolforge_process::rpc`] 的 JSON-RPC 2.0 按行分帧，stdout 只跑协议，
//! stderr 是自由日志。方法只有三个：
//!
//! | 方法 | 方向 | 说明 |
//! |---|---|---|
//! | `initialize` | 宿主 → 插件 | 一次性握手，传入路径映射、已授权能力、插件 id。返回 `{}` 即可；**返回 `-32601` 表示插件不实现握手，按无状态处理** |
//! | `run` | 宿主 → 插件 | 单次处理。`params` 是 [`PluginCallRequest::payload`] |
//! | `shutdown` | 宿主 → 插件 | 释放模型、关文件。超时后强杀 |
//! | `progress` | 插件 → 宿主 | **通知**，`{ "value": 0.3, "stage": "加载模型" }` |
//! | `log` | 插件 → 宿主 | **通知**，`{ "level": "info", "message": "..." }` |
//!
//! ## venv 与依赖
//!
//! `requirements` 会在**插件私有 venv**（`<plugin>/.venv`）里安装，与系统 Python
//! 和其它插件完全隔离。安装失败的插件会被标记为不可用，而不是静默降级。
//! v0.1 只负责**创建 venv 并调用 pip**，依赖的预装与缓存策略见 ROADMAP。

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

use toolforge_core::error::{ErrorCode, ToolforgeError, ToolforgeResult};
use toolforge_core::permission::PermissionSet;
use toolforge_core::plugin::PythonRuntimeDef;
use toolforge_core::queue::JobCtx;

use toolforge_process::supervisor::{ChildSupervisor, SpawnSpec};

use crate::runtimes::PluginCallRequest;

pub struct PythonPlugin {
    supervisor: ChildSupervisor,
    plugin_id: String,
    plugin_dir: PathBuf,
    def: PythonRuntimeDef,
    /// 路径映射（握手时一次性告知插件，之后插件只用逻辑路径）
    paths: Value,
}

impl PythonPlugin {
    /// 启动插件进程并准备好 venv。
    pub async fn launch(
        plugin_dir: &Path,
        def: &PythonRuntimeDef,
        python_exe: &Path,
        paths: &Value,
        plugin_id: &str,
        granted: PermissionSet,
    ) -> ToolforgeResult<Self> {
        let entry = plugin_dir.join(&def.entry);
        if !entry.is_file() {
            return Err(ToolforgeError::plugin_invalid(format!(
                "Python 入口脚本不存在：{}",
                entry.display()
            ))
            .with_subject(plugin_id));
        }

        // venv：存在就复用，不存在才建（建一次要几秒）
        let venv = plugin_dir.join(".venv");
        let venv_python = venv_python_path(&venv);
        if !venv_python.is_file() && !def.requirements.is_empty() {
            prepare_venv(python_exe, plugin_dir, &def.requirements, plugin_id).await?;
        }

        // 用 venv 里的解释器；没有 venv（无依赖）就用宿主托管的运行时
        let interpreter = if venv_python.is_file() {
            venv_python
        } else {
            python_exe.to_path_buf()
        };

        let mut spec = SpawnSpec::new(interpreter);
        spec.args = vec![
            // -u：禁止 stdout 缓冲。少了这个，协议帧会卡在缓冲区里，
            // 表现为"插件启动了但永远不响应"，是这类集成最经典的坑。
            "-u".into(),
            entry.display().to_string(),
        ];
        spec.cwd = Some(plugin_dir.to_path_buf());
        spec.clear_env = true; // 绝不继承父进程环境（可能含 API Key）
        // 只有在清单显式开启、且用户确实授予了 net 能力时才允许联网
        spec.deny_network = !(def.allow_network && granted.wants_network());
        spec.default_timeout = Duration::from_millis(def.timeout_ms);
        spec.init_timeout = Duration::from_millis(def.timeout_ms.min(600_000));
        spec.env
            .insert("TOOLFORGE_PLUGIN_ID".into(), plugin_id.to_string());
        spec.env.insert(
            "TOOLFORGE_CAPABILITIES".into(),
            granted
                .capabilities
                .iter()
                .map(capability_tag)
                .collect::<Vec<_>>()
                .join(","),
        );
        // 不给 PYTHONPATH，避免插件意外 import 到宿主的包
        spec.env
            .insert("PYTHONNOUSERSITE".into(), "1".to_string());

        let supervisor = ChildSupervisor::spawn(plugin_id, spec).await?;

        Ok(Self {
            supervisor,
            plugin_id: plugin_id.to_string(),
            plugin_dir: plugin_dir.to_path_buf(),
            def: def.clone(),
            paths: paths.clone(),
        })
    }

    /// 握手。
    ///
    /// 传下去的是**插件私有目录的真实路径**（`pluginDir` / `dataDir`），
    /// 它们跨任务稳定。本次任务的 input / output / work 目录在每次 `run` 的载荷里给。
    ///
    /// 这里**刻意不编造 `/input` 这类虚拟路径**：L3 是普通 Python 进程，
    /// 它直接 `open()` 文件，虚拟路径对它没有意义，只会让插件作者困惑。
    pub async fn initialize(&mut self, plugin_id: &str) -> ToolforgeResult<Value> {
        let params = json!({
            "pluginId": plugin_id,
            "apiVersion": toolforge_core::PLUGIN_API_VERSION,
            "entry": self.def.entry,
            "dirs": self.paths,
            "timeoutMs": self.def.timeout_ms,
            "network": self.def.allow_network,
        });
        self.supervisor
            .initialize(params, Duration::from_millis(self.def.timeout_ms.min(600_000)))
            .await
    }

    pub async fn call(&mut self, req: &PluginCallRequest, job: &JobCtx) -> ToolforgeResult<Value> {
        job.check()?;

        let timeout = Duration::from_millis(self.def.timeout_ms);
        let plugin_id = self.plugin_id.clone();
        // 先取出通知队列句柄：这样在 `call` 持有 supervisor 可变借用时，
        // 仍然可以从 select! 的另一分支消费进度通知（借用不冲突）。
        let queue = self.supervisor.notification_queue();

        // 用 Box::pin 拿到一个**拥有所有权**的 pinned future：
        // 循环结束后 `drop(call)` 才能真正释放对 `self.supervisor` 的可变借用，
        // 之后才能再调 `self.supervisor.kill()`。
        let mut call = Box::pin(self.supervisor.call("run", req.payload.clone(), timeout));

        // 用 `loop { ... break expr }` 而不是 `Option` 累加器：
        // 后者会触发 `unused_assignments`（初始值被覆盖但从未被读到）。
        let outcome = loop {
            tokio::select! {
                result = &mut call => break result,
                _ = tokio::time::sleep(Duration::from_millis(80)) => {
                    job.check()?;
                    let pending: Vec<Value> = { let mut q = queue.lock().await; q.drain(..).collect() };
                    for n in pending {
                        handle_notification(&plugin_id, n, job);
                    }
                }
            }
        };
        drop(call);

        // 收尾：把剩余通知处理掉，避免丢掉最后一条进度
        let rest: Vec<Value> = {
            let mut q = queue.lock().await;
            q.drain(..).collect()
        };
        for n in rest {
            handle_notification(&plugin_id, n, job);
        }

        match outcome {
            Ok(v) => Ok(v),
            Err(e) => {
                // 超时的进程已经不可信（可能卡在 native 代码里），必须回收
                if e.code == ErrorCode::Timeout {
                    self.supervisor.kill().await;
                }
                Err(e.with_subject(&plugin_id))
            }
        }
    }

    pub async fn shutdown(&mut self) {
        self.supervisor.shutdown(Duration::from_secs(5)).await;
    }

    pub fn plugin_dir(&self) -> &Path {
        &self.plugin_dir
    }
}

/// 处理插件主动发来的通知。
///
/// 刻意做成自由函数而不是方法：调用点正处于 `self.supervisor` 的可变借用中，
/// 调 `&self` 方法会借用冲突。
fn handle_notification(plugin_id: &str, n: Value, job: &JobCtx) {
    let method = n.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = n.get("params").cloned().unwrap_or(Value::Null);
    match method {
        "progress" => {
            let value = params.get("value").and_then(|v| v.as_f64());
            let stage = params
                .get("stage")
                .and_then(|s| s.as_str())
                .unwrap_or("处理中")
                .to_string();
            job.progress(toolforge_core::job::JobProgress {
                value,
                stage,
                current_item: None,
                speed: None,
                eta_seconds: None,
            });
        }
        "log" => {
            let level = params
                .get("level")
                .and_then(|l| l.as_str())
                .unwrap_or("info");
            let message = params
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("")
                .to_string();
            match level {
                "error" => job.error(message),
                "warn" | "warning" => job.warn(message),
                "debug" | "trace" => job.log(toolforge_core::job::LogLevel::Debug, message),
                _ => job.info(message),
            }
        }
        "host.request" => {
            // 插件在运行中想申请新能力。**我们不会满足它** ——
            // 能力必须在装载前由用户授权，运行期提权是"点击劫持"的经典入口。
            job.warn(
                "插件在运行中请求了额外能力，已被拒绝。\
                 如确需该能力，请在插件详情页重新授权并重启插件。",
            );
        }
        _ => {
            tracing::debug!(plugin = %plugin_id, method, "未处理的插件通知");
        }
    }
}

/// 用宿主托管的 Python 创建 venv 并安装依赖。
async fn prepare_venv(
    python_exe: &Path,
    plugin_dir: &Path,
    requirements: &[String],
    plugin_id: &str,
) -> ToolforgeResult<()> {
    let venv = plugin_dir.join(".venv");

    let r = toolforge_process::exec(
        toolforge_process::ExecOptions::new(python_exe)
            .args(["-m", "venv", &venv.display().to_string()])
            .timeout(Duration::from_secs(180))
            .quiet(true),
    )
    .await?;
    if !r.success() {
        return Err(ToolforgeError::runtime(format!(
            "为插件 `{plugin_id}` 创建 venv 失败"
        ))
        .with_detail(r.stderr));
    }

    let venv_python = venv_python_path(&venv);
    if !venv_python.is_file() {
        return Err(ToolforgeError::runtime(format!(
            "venv 创建后找不到解释器：{}",
            venv_python.display()
        )));
    }

    if requirements.is_empty() {
        return Ok(());
    }

    // 依赖都经过清单校验（禁止 URL / VCS / 本地路径），所以这里的参数是安全的
    let mut args = vec![
        "-m".to_string(),
        "pip".to_string(),
        "install".to_string(),
        "--no-input".to_string(),
        "--disable-pip-version-check".to_string(),
        "--only-binary=:all:".to_string(),
    ];
    args.extend(requirements.iter().cloned());

    let r = toolforge_process::exec(
        toolforge_process::ExecOptions::new(&venv_python)
            .args(args)
            .timeout(Duration::from_secs(1800))
            .quiet(true),
    )
    .await?;
    if !r.success() {
        return Err(ToolforgeError::runtime(format!(
            "为插件 `{plugin_id}` 安装依赖失败"
        ))
        .with_detail(format!(
            "依赖列表：{}\n\n{}",
            requirements.join(", "),
            r.stderr
        )));
    }
    Ok(())
}

fn venv_python_path(venv: &Path) -> PathBuf {
    if cfg!(windows) {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python")
    }
}

/// 能力 → 给插件看的短标签
fn capability_tag(c: &toolforge_core::permission::Capability) -> String {
    use toolforge_core::permission::Capability as C;
    match c {
        C::FsRead { .. } => "fsRead".into(),
        C::FsWrite { .. } => "fsWrite".into(),
        C::Net { .. } => "net".into(),
        C::Exec => "exec".into(),
        C::Env { .. } => "env".into(),
        C::Ai => "ai".into(),
        C::Gpu => "gpu".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn venv_python_path_matches_platform() {
        let p = venv_python_path(Path::new("/x/.venv"));
        if cfg!(windows) {
            assert!(p.ends_with("Scripts\\python.exe") || p.ends_with("Scripts/python.exe"));
        } else {
            assert!(p.ends_with("bin/python"));
        }
    }

    #[test]
    fn capability_tags_are_stable_strings() {
        use toolforge_core::permission::{Capability, PathScope};
        assert_eq!(
            capability_tag(&Capability::FsRead {
                scope: PathScope::Input
            }),
            "fsRead"
        );
        assert_eq!(capability_tag(&Capability::Exec), "exec");
        assert_eq!(capability_tag(&Capability::Net { hosts: vec![] }), "net");
    }

    #[test]
    fn default_python_def_denies_network() {
        // 这条不变量非常关键：默认断网
        let yaml = r#"
apiVersion: toolforge/v1
kind: Plugin
metadata: { id: com.test.py, name: P, version: 1.0.0 }
runtime:
  kind: python
  python:
    entry: main.py
"#;
        let m = toolforge_core::plugin::PluginManifest::from_yaml(yaml).unwrap();
        match m.runtime {
            toolforge_core::plugin::PluginRuntime::Python { python } => {
                assert!(!python.allow_network, "Python 插件默认必须禁网");
                assert_eq!(python.python_version, "3.11");
                assert_eq!(python.workers, 1);
            }
            _ => panic!("应当是 python 运行时"),
        }
    }
}
