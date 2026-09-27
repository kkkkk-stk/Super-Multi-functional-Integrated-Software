//! 插件运行时：L2（Extism WASM 沙箱）与 L3（Python 独立进程）。
//!
//! # L2 · WASM 的能力边界（必须先理解，再决定用不用）
//!
//! [`wasm::WasmPlugin`] 跑在 Extism + Wasmtime 上，关闭了 WASI。这意味着插件：
//!
//! * ❌ **没有文件系统**（连 `open` 都没有）
//! * ❌ **没有网络**
//! * ❌ **没有线程**（WASM 线程需要 shared memory + COOP/COEP，Extism 未启用）
//! * ⚠️ **没有 SIMD**（wasmtime 默认不开 `simd` 特性给 Extism 模块）
//! * ✅ 有确定性的整数/浮点运算
//! * ✅ 通过宿主函数白名单可以 `log` 与读写自己的 KV
//!
//! 所以：**L2 适合"输入一串字节，输出一串字节"的纯计算** —— 文本处理、哈希、
//! 编码转换、规则计算、数据校验。**不适合**图像解码/缩放/转码，那需要
//! 内存与 SIMD，且要把几十 MB 的图片数据在宿主与沙箱之间来回拷贝。
//!
//! 常见的错误设计是"用 WASM 抠图"：不仅要自己塞一个解码器进 wasm，
//! 还要在无 SIMD 的情况下跑 ONNX 推理 —— 慢几十倍，还得把图片全量送进沙箱。
//! 这种需求应该走 L1（内置节点）或 L3（Python）。
//!
//! # L3 · Python 进程的隔离程度（诚实说明）
//!
//! [`python::PythonPlugin`] 把插件跑在一个独立进程里，宿主做了：
//!
//! * **清空继承的环境变量**（只留 `PATH`），所以 `OPENAI_API_KEY` 之类读不到
//! * **锁定工作目录**在插件的私有目录
//! * **默认断网**：设置指向 `127.0.0.1:1` 的代理环境变量
//! * **超时**：默认 300 秒，超时返回 `TIMEOUT` 错误码
//! * **优雅关闭**：先 `shutdown` 再关 stdin，最后才 kill
//!
//! **但是**：这不是内核级沙箱。一个蓄意的插件可以直接用 `socket` 绕过代理环境变量、
//! 可以读它进程能读的任何文件。真正的隔离需要 Windows Job Object + AppContainer、
//! 或 macOS `sandbox-exec`、或 Linux seccomp —— 这些在 v0.2 的路线图里（见 ROADMAP）。
//!
//! **因此 L3 插件的安全依赖两件事**：
//! 1. 用户在授权前真的看了权限清单（所以 UI 必须把高危能力标红）；
//! 2. 审计日志能事后追溯。
//!
//! 不要对用户宣称"L3 是沙箱"。

pub mod python;
pub mod wasm;

use std::sync::Arc;

use serde_json::Value;

use toolforge_core::error::{ErrorCode, ToolforgeError, ToolforgeResult};
use toolforge_core::permission::PathResolver;
use toolforge_core::plugin::PluginRuntime;
use toolforge_core::queue::JobCtx;

use toolforge_engines::EngineRegistry;

use crate::audit::{AuditEvent, AuditEventKind, AuditLog};
use crate::store::PluginRecord;

/// 一次插件调用的输入（L2/L3 共用）
#[derive(Debug, Clone)]
pub struct PluginCallRequest {
    /// 传给插件的 JSON 载荷。
    ///
    /// 约定结构（插件 SDK 文档里有完整说明）：
    /// ```json
    /// {
    ///   "input":  { "<portId>": ["/real/path/a.png"] },
    ///   "params": { "format": "webp" },
    ///   "paths":  { "input": "/…", "output": "/…", "data": "/…", "work": "/…" },
    ///   "capabilities": ["fsRead", "fsWrite", "net"]
    /// }
    /// ```
    ///
    /// **`paths` 里全是真实绝对路径。** 这里刻意不编造 `/input` 这类虚拟路径：
    /// L3 是普通 Python 进程，它直接 `open()` 文件，虚拟路径对它没有任何意义。
    /// 代价是"路径收敛"对 L3 只是**约定**而不是强制 —— 这一点已在
    /// `docs/SECURITY.md` 中如实记录，任何文档与 UI 都不得把 L3 称为"沙箱"。
    pub payload: Value,
    pub input_root: std::path::PathBuf,
    pub output_root: std::path::PathBuf,
    pub plugin_data_root: std::path::PathBuf,
    pub workspace_root: std::path::PathBuf,
}

/// 已装载的插件实例
pub enum RunningPlugin {
    Wasm(wasm::WasmPlugin),
    /// ⚠️ **装箱不是装饰**：`PythonPlugin` 有 576 字节，而 `WasmPlugin` 只有 120 ——
    /// 不装箱的话整个枚举就是 576 字节，而它是按插件挂在 `HashMap` 里的，
    /// 每次移动/取出都要按最大的那个变体付账（clippy 的 `large_enum_variant` 说的就是这个）。
    Python(Box<python::PythonPlugin>),
}

impl RunningPlugin {
    pub fn kind(&self) -> &'static str {
        match self {
            RunningPlugin::Wasm(_) => "L2 · WASM",
            RunningPlugin::Python(_) => "L3 · Python",
        }
    }

    pub async fn call(&mut self, req: &PluginCallRequest, job: &JobCtx) -> ToolforgeResult<Value> {
        match self {
            RunningPlugin::Wasm(p) => p.call(req, job),
            RunningPlugin::Python(p) => p.call(req, job).await,
        }
    }

    pub async fn shutdown(&mut self) {
        match self {
            RunningPlugin::Wasm(_) => {}
            RunningPlugin::Python(p) => p.shutdown().await,
        }
    }

    /// 这个已装载的实例**需要重新拉起**吗（它的进程已经没了）。
    ///
    /// 见 `python::PythonPlugin::is_dead()` 的文档：取消与意外崩溃都会让
    /// Python 子进程退出，而**缓存里的实例不会自己复活**。
    pub fn needs_relaunch(&self) -> bool {
        match self {
            // L2 的 Extism 实例没有"进程退出"这回事，永远是同一个内存实例
            RunningPlugin::Wasm(_) => false,
            RunningPlugin::Python(p) => p.is_dead(),
        }
    }
}

/// 插件运行时工厂 —— 负责"按清单把插件装载起来"。
pub struct PluginRunner {
    engines: Arc<EngineRegistry>,
    paths: toolforge_core::paths::AppPaths,
    audit: AuditLog,
    /// 已装载实例的缓存（按插件 id）
    loaded: parking_lot::Mutex<std::collections::HashMap<String, RunningPlugin>>,
}

impl PluginRunner {
    pub fn new(
        engines: Arc<EngineRegistry>,
        paths: toolforge_core::paths::AppPaths,
        audit: AuditLog,
    ) -> Self {
        Self {
            engines,
            paths,
            audit,
            loaded: parking_lot::Mutex::new(std::collections::HashMap::new()),
        }
    }

    /// 卸载某个插件（插件被禁用/卸载/改动时调用）
    pub async fn unload(&self, plugin_id: &str) {
        let existing = self.loaded.lock().remove(plugin_id);
        if let Some(mut p) = existing {
            p.shutdown().await;
        }
    }

    pub async fn unload_all(&self) {
        let all: Vec<(String, RunningPlugin)> = self.loaded.lock().drain().collect();
        for (_, mut p) in all {
            p.shutdown().await;
        }
    }

    /// 装载（如果已装载则复用）。
    ///
    /// **每次装载都先校验哈希**：如果插件目录在安装后被改动过，这里会拒绝并
    /// 记审计 —— 这是挡住"装完之后再替换成恶意代码"的关键一步。
    pub async fn ensure_loaded(&self, record: &PluginRecord) -> ToolforgeResult<()> {
        let id = record.id().to_string();

        // ★ 缓存里那个实例**进程已经没了**时要换掉它，而不是一直复用它。
        //
        // 这条判断是补上一个真实缺陷：`kill()` 之后监督者停在 `Dead`，而这里
        // 原本是 `if contains_key { return Ok(()) }` —— 于是"取消一次任务"
        // 就等于**把这个插件在本会话里彻底废掉**，除非用户去禁用再启用
        // （那才会走到 `unload`）。同样的路径也盖住"子进程被 OOM / 杀软干掉"。
        //
        // 为什么是在这里、而不是在同一次调用里静默重试：`supervisor.rs` 的模块文档
        // 说得很清楚 —— **静默重启会把"插件反复崩溃"这件事藏起来**。
        // 这条改动没有违背它，两者的区别要说准：
        //   * **调用过程中**崩的 → 那次调用仍然失败（`PROCESS_GONE`，带 stderr 尾巴），
        //     用户看得见；而且反复崩的插件会**每次都失败**，不会变成"看起来正常"；
        //   * **调用之间**死的（被杀软 / OOM 干掉、上一次取消留下的）→ 下一次调用
        //     重新拉起一个干净进程，用户不必去禁用再启用插件。
        // 也就是说：自愈的是"进程没了"，不是"崩溃被吞了"。
        //
        // 顺带说明：`SupervisorState::is_usable()` 此前**只有测试在用**
        // （全仓库没有一个生产调用点）—— 这条判断本该是它的用武之地，
        // 但判据刻意更窄（只认 `Dead`，不认 `Unavailable`，理由见 `is_dead()` 的文档）。
        // 缓存状态：**先在这个不跨 await 的小作用域里取出结论**，再做决定。
        //
        // ⚠️ 不能把 `return` 写在持有 guard 的作用域里：`parking_lot` 的
        // `MutexGuard` 不是 `Send`，而这里的 async 块必须是 `Send`
        // （它要丢进 tokio 的任务里）。编译器对"提前 return 时 guard 的析构"
        // 是保守的，会把 guard 判成跨 await 存活，报
        // `*mut () cannot be sent between threads safely`。
        let (cached, stale) = {
            let guard = self.loaded.lock();
            match guard.get(&id) {
                None => (false, false),
                Some(p) => (true, p.needs_relaunch()),
            }
        };
        if cached && !stale {
            return Ok(());
        }
        if stale {
            // ⚠️ 先把取出来的实例**绑到一个变量**上，再 `if let`。
            // 写成 `if let Some(mut p) = self.loaded.lock().remove(&id) { … await … }`
            // 的话，scrutinee 里的那个 `MutexGuard` 临时值会活到**整个 `if let` 语句结束**
            // （包括里面的 `.await`），于是又变成"`!Send` 的 guard 跨 await"。
            // 上面 `unload()` 里那两行就是这个写法，抄它。
            let removed = self.loaded.lock().remove(&id);
            if let Some(mut p) = removed {
                tracing::warn!(plugin = %id, "已装载实例的进程已退出：重新拉起");
                p.shutdown().await;
            }
        }

        // 运行前完整性校验：这是挡住"装完之后再替换成恶意代码"的关键一步
        if let Some(expected) = &record.state.installed_hash {
            let actual = crate::audit::content_hash(&record.dir)?;
            if &actual != expected {
                crate::audit::record_integrity(&self.audit, &id, expected, &actual);
                return Err(ToolforgeError::new(
                    ErrorCode::IntegrityCheckFailed,
                    format!("插件 `{id}` 的内容在装载前已被改动，拒绝执行"),
                )
                .with_detail(format!("期望：{expected}\n实际：{actual}")));
            }
        }

        let instance = match &record.manifest.runtime {
            PluginRuntime::Pipeline { .. } => {
                // L1 不需要常驻实例，流水线执行器直接跑
                return Ok(());
            }
            PluginRuntime::Wasm { wasm } => {
                let path = record.dir.join(&wasm.path);
                let bytes = std::fs::read(&path).map_err(|e| {
                    ToolforgeError::runtime(format!("读取 {} 失败：{e}", path.display()))
                })?;
                // 把**已授权**的能力传进去：WASM 侧要据此设置 Extism 的
                // `allowed_hosts`，否则用户勾的 `net` 对 L2 插件完全不起作用。
                let effective = record.effective();
                let p = wasm::WasmPlugin::load(&bytes, wasm, id.clone(), &effective)?;
                self.audit.record(
                    AuditEvent::new(AuditEventKind::Installed, "装载 L2 WASM 插件")
                        .subject(&id)
                        .detail(serde_json::json!({
                            "wasmBytes": bytes.len(),
                            "memoryLimitMb": wasm.memory_limit_mb,
                            "hostFunctions": wasm.allow_host_functions,
                            // `unwrap_or_default()` 而不是原样给 `Option`：
                            // 空数组读作"什么都没放行"（fail-closed），比 `null` 清楚。
                            // 排查"插件联网被拒"时，这一条就是第一个要看的地方。
                            "allowedHosts": wasm::allowed_hosts_from(&effective).unwrap_or_default(),
                        })),
                );
                RunningPlugin::Wasm(p)
            }
            PluginRuntime::Python { python } => {
                let python_exe = self.engines.resolve("python").await.map_err(|_| {
                    ToolforgeError::engine_missing("python").with_detail(
                        "L3 插件需要独立的 Python 3.11 运行时。请在「引擎管理」中安装。",
                    )
                })?;

                // ---- `exec` 的装载期静态门 ----
                //
                // L3 是普通进程，宿主**无法在运行期**拦住它起子进程（那需要
                // Job Object + AppContainer / seccomp，见 SECURITY.md §9 第 3 项）。
                // 能做的是在装载时读一遍它的源码：用了起子进程的 API 却没声明
                // `exec` → 拒绝装载。挡的是"作者忘了 / 用户没注意"，挡不住蓄意绕过。
                let exec_usage = crate::runtimes::python::scan_python_sources(&record.dir);
                let effective = record.effective();
                crate::runtimes::python::gate_exec_usage(
                    &id,
                    &exec_usage,
                    record
                        .manifest
                        .permissions
                        .capabilities
                        .iter()
                        .any(|c| matches!(c, toolforge_core::permission::Capability::Exec)),
                    effective
                        .capabilities
                        .iter()
                        .any(|c| matches!(c, toolforge_core::permission::Capability::Exec)),
                )?;

                // 握手时只告知**插件私有目录**：它是跨任务稳定的。
                //
                // 本次任务的 input / output / work 目录是**每次 run 调用时**才在
                // 载荷的 `paths` 里给出的 —— 握手发生在装载期，那时还没有任务。
                //
                // ⚠️ 给的是**真实路径**，不是虚拟路径。这一点必须诚实：L3 是一个
                // 普通 Python 进程，它直接 open() 文件，宿主不在它的 IO 路径上。
                // 所谓"路径收敛"对 L3 只是**约定 + 工作目录约束**，不是强制。
                // 详见 docs/SECURITY.md §9 第 21、25 项。
                let data_dir = self.paths.plugin_data(&id);
                let plugin_paths = serde_json::json!({
                    "pluginDir": record.dir.display().to_string(),
                    "dataDir": data_dir.display().to_string(),
                });

                let mut p = python::PythonPlugin::launch(
                    &record.dir,
                    python,
                    &python_exe,
                    &plugin_paths,
                    &id,
                    effective.clone(),
                )
                .await?;
                p.initialize(&id).await?;

                self.audit.record(
                    AuditEvent::new(AuditEventKind::Installed, "装载 L3 Python 插件")
                        .subject(&id)
                        .detail(serde_json::json!({
                            "entry": python.entry,
                            "requirements": python.requirements,
                            "network": python.allow_network,
                            // 装载期扫到的"会起子进程"的用法。**如实记录**：
                            // 出了问题之后，"它当时是不是声明并授权了 exec"
                            // 是第一个要回答的问题。
                            "execUsage": exec_usage.iter().map(|u| format!("{}: {}", u.file, u.pattern)).collect::<Vec<_>>(),
                            "execGranted": effective
                                .capabilities
                                .iter()
                                .any(|c| matches!(c, toolforge_core::permission::Capability::Exec)),
                            // 环境变量白名单的**名字**（不含值！）—— 见 python.rs::inject_declared_env
                            "envNames": effective
                                .capabilities
                                .iter()
                                .filter_map(|c| match c {
                                    toolforge_core::permission::Capability::Env { names } => Some(names.clone()),
                                    _ => None,
                                })
                                .flatten()
                                .collect::<Vec<_>>(),
                        })),
                );
                RunningPlugin::Python(Box::new(p))
            }
        };

        self.loaded.lock().insert(id, instance);
        Ok(())
    }

    /// 调用一个 L2/L3 插件。
    pub async fn call(
        &self,
        record: &PluginRecord,
        req: &PluginCallRequest,
        job: &JobCtx,
    ) -> ToolforgeResult<Value> {
        self.ensure_loaded(record).await?;
        job.check()?;

        // 网络能力与实际运行时配置的一致性检查：
        // 清单声明了 net、但 python.allowNetwork=false，说明作者写漏了 —— 报错而不是猜
        if let PluginRuntime::Python { python } = &record.manifest.runtime {
            if record.effective().wants_network() && !python.allow_network {
                return Err(ToolforgeError::plugin_invalid(
                    "插件申请了网络能力，但 python.allowNetwork 为 false",
                )
                .with_detail("两者必须一致。若确实需要联网，请在清单里同时打开。"));
            }
        }

        // 把实例**取出来**再调用：parking_lot 的 guard 不是 Send，
        // 持着它跨 await 会让整个 future 不能 Send，从而无法被 tokio::spawn。
        let mut instance = {
            let mut guard = self.loaded.lock();
            guard.remove(record.id()).ok_or_else(|| {
                ToolforgeError::internal("插件实例在装载与调用之间消失（并发卸载？）")
            })?
        };

        let result = instance.call(req, job).await;

        // 无论成功失败都放回去（Python 进程可能还活着，复用比重启便宜）
        self.loaded.lock().insert(record.id().to_string(), instance);

        result
    }

    /// 让 `PathResolver` 与插件目录对齐（供 L3 使用）
    pub fn resolver_for(&self, req: &PluginCallRequest) -> PathResolver {
        PathResolver::new()
            .with_input(&req.input_root)
            .with_output(&req.output_root)
            .with_plugin_data(&req.plugin_data_root)
            .with_workspace(&req.workspace_root)
    }

    pub fn is_loaded(&self, plugin_id: &str) -> bool {
        self.loaded.lock().contains_key(plugin_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use toolforge_core::paths::AppPaths;

    #[tokio::test]
    async fn unload_unknown_plugin_is_noop() {
        let dir = std::env::temp_dir().join("tf-runner-tests");
        let (tx, _rx) = tokio::sync::broadcast::channel(16);
        let engines = Arc::new(EngineRegistry::new(AppPaths::new(&dir)).with_events(tx));
        let runner = PluginRunner::new(
            engines,
            AppPaths::new(&dir),
            AuditLog::from_dir(dir.join("audit")),
        );
        runner.unload("com.nope").await;
        assert!(!runner.is_loaded("com.nope"));
        runner.unload_all().await;
    }
}
