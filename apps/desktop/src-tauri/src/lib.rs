//! ToolForge 桌面应用外壳。
//!
//! ## 这个 crate 做什么、不做什么
//!
//! **做**：
//! * 组装各个 `toolforge-*` crate（见 [`state::AppState`]）
//! * 把领域事件桥接到 WebView（[`spawn_event_bridge`]）
//! * 暴露 IPC 命令（[`commands`]）
//! * 把 Rust 类型导出成 TypeScript（[`specta_builder`]）
//!
//! **不做**：
//! * 任何业务逻辑 —— 一行都不该有。逻辑在领域 crate 里，这样它能被测试、
//!   被 CLI 复用、也不会因为换了个 UI 框架而重写。
//! * 任何直接的 `Command::new(...)` —— 一律经 `toolforge-process` / `toolforge-engines`。
//!
//! ## 为什么命令集合写在一个 `collect_commands!` 宏里
//!
//! 因为 `tauri-specta` 需要它来生成 TS 绑定。**漏掉一个命令的后果是静默的**：
//! 前端会得到一个"未定义的函数"，直到运行时才发现。所以：
//! 1. [`COMMAND_NAMES`] 与宏里的列表必须一一对应，`debug_assert` 会检查；
//! 2. 新增命令时先加到这里，再加到宏里。

pub mod commands;
pub mod ipc;
pub mod license_acks;
pub mod settings_store;
pub mod state;

use std::sync::Arc;

use tauri::{Emitter, Manager};
use tokio::sync::broadcast;

use toolforge_core::events::AppEvent;
use toolforge_core::paths::AppPaths;

use crate::state::AppState;

/// 命令名清单。
///
/// 它存在的唯一目的是**防止漏注册**：`collect_commands!` 是宏，
/// 漏写一个命令不会报错，只会在前端调用时炸。这里做一次显式对照。
pub const COMMAND_NAMES: &[&str] = &[
    // 应用
    "app_info",
    "app_paths",
    "system_status",
    // 设置
    "settings_get",
    "settings_patch",
    // 任务
    "jobs_list",
    "jobs_get",
    "jobs_cancel",
    "jobs_clear_finished",
    "jobs_stats",
    "jobs_retry",
    // 引擎
    "engines_catalog",
    "engines_probe_all",
    "engines_probe",
    "engines_install",
    // 模型权重
    "models_list",
    "models_install",
    "models_remove",
    // 插件
    "plugins_list",
    "plugins_get",
    "plugins_reload",
    "plugins_validate",
    "plugins_install",
    "plugins_grant",
    "plugins_set_enabled",
    "plugins_uninstall",
    "plugins_audit",
    "plugins_run",
    // 流程
    "pipeline_nodes",
    // AI
    "ai_test_connection",
    "ai_generate",
    "ai_review_draft",
];

/// 构造 specta builder（命令与事件都在这里注册）。
///
/// 抽成函数是为了让 [`commands_export_bindings`] 那条独立二进制能复用同一份定义 ——
/// 否则生成 TS 与运行时注册的命令会漂移，那是比编译错误更难查的问题。
pub fn specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new()
        .commands(tauri_specta::collect_commands![
            commands::app_info,
            commands::app_paths,
            commands::system_status,
            commands::settings_get,
            commands::settings_patch,
            commands::jobs_list,
            commands::jobs_get,
            commands::jobs_cancel,
            commands::jobs_clear_finished,
            commands::jobs_stats,
            commands::jobs_retry,
            commands::engines_catalog,
            commands::engines_probe_all,
            commands::engines_probe,
            commands::engines_install,
            commands::models_list,
            commands::models_install,
            commands::models_remove,
            commands::plugins_list,
            commands::plugins_get,
            commands::plugins_reload,
            commands::plugins_validate,
            commands::plugins_install,
            commands::plugins_grant,
            commands::plugins_set_enabled,
            commands::plugins_uninstall,
            commands::plugins_audit,
            commands::plugins_run,
            commands::pipeline_nodes,
            commands::ai_test_connection,
            commands::ai_generate,
            commands::ai_review_draft,
        ])
        .events(tauri_specta::collect_events![])
        // `AppEvent` 不是"注册事件"而是**一个普通类型**，但它必须被导出。
        //
        // 背景：本项目所有领域事件都发在同一个通道上
        // （`toolforge://event`），载荷是带 `type` 判别式的 `AppEvent` 枚举。
        // 这种"单通道 + 判别联合"的形态不符合 `collect_events!` 的模型
        // （那要求每个事件一个实现 `Event` trait 的类型），所以
        // `collect_events![]` 是空的。
        //
        // 结果是：`AppEvent` 一度成为**前端唯一手写的契约** —— 而手写意味着
        // 后端改一个字段名（例如 `errorMessage` 改成 `error`），
        // TypeScript 侧**不会报错**，只会在运行时静默拿到 `undefined`。
        // 这正是本项目其它地方费力消灭的漂移，没理由在这里留一个。
        //
        // `typ::<T>()` 把类型加进导出集合，不改事件注册机制 —— 一行解决。
        //
        // ⚠️ 这一行如果被删掉，`pnpm bindings` 会**报错退出**（守卫在
        // `src/bin/export_bindings.rs` 里），而不是安静地少导出一个类型。
        .typ::<AppEvent>()
        // specta 默认拒绝把 u64 / i64 导出成 TS `number`，因为在 JS 里
        // 超过 2^53 的整数会静默丢精度。而这个项目导出到前端的整数只有三类：
        //   * 计数（文件数、条目数、插件数）—— 远小于 2^31
        //   * 字节数（下载进度、体积估算）—— 远小于 2^53（9 PB）
        //   * 毫秒数（步骤耗时、超时）—— 远小于 2^53（28 万年）
        // 所有 ID 一律是**字符串**（见 toolforge_core::ids），所以这里不存在
        // 精度风险。显式开启转换，代价是"以后新增导出整数字段"需要人工复核。
        .dangerously_cast_bigints_to_number()
        // 常量直接导出到 TS，前端不用手抄一遍
        .constant("PLUGIN_API_VERSION", toolforge_core::PLUGIN_API_VERSION)
        .constant("EVENT_CHANNEL", AppEvent::channel())
}

/// 把 `toolforge-core` 领域事件桥接到 WebView。
///
/// ## 为什么用 broadcast 而不是直接 `app.emit`
///
/// 因为领域层**不认识 tauri**（这是硬约束）。队列、引擎、插件都只往一个
/// `broadcast::Sender<AppEvent>` 里发；外壳层订阅它再转发。
/// 好处是领域层可以被单元测试、可以被 CLI 复用。
///
/// ## 顺带做一件家务：清理任务临时目录
///
/// 每个任务都会拿到一个 `<data>/work/<jobId>` 临时目录（插件的 `$WORKSPACE` 作用域）。
/// 任务终结时在这里统一删掉 —— 放在事件桥里而不是队列里，是因为队列属于领域层、
/// **不应该知道磁盘布局**。压到这个位置，既保持了分层，又保证不会有孤儿目录堆积。
///
/// `Lagged` 是**预期内的**：转码时进度事件量很大，慢速 WebView 跟不上是正常的。
/// 我们不追求"一条不漏"——前端会定期拉 `jobs_list` 做一次对账，进度条不会卡住。
fn spawn_event_bridge(
    app: tauri::AppHandle,
    mut rx: broadcast::Receiver<AppEvent>,
    paths: AppPaths,
) {
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    // 任务终结 → 清掉它的临时工作区
                    if let AppEvent::JobFinished { job_id, status, .. } = &event {
                        if status.is_terminal() {
                            let dir = paths.job_workspace(job_id);
                            if dir.exists() {
                                // 用 spawn_blocking：删大目录是同步 IO，别卡住事件循环
                                let jid = job_id.clone();
                                let d = dir.clone();
                                tauri::async_runtime::spawn_blocking(move || {
                                    if let Err(e) = std::fs::remove_dir_all(&d) {
                                        tracing::debug!(job = %jid, "清理临时目录失败：{e}");
                                    }
                                });
                            }
                        }
                    }
                    if let Err(e) = app.emit(AppEvent::channel(), &event) {
                        tracing::debug!("事件转发失败（窗口可能已关闭）：{e}");
                    }
                }
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    tracing::debug!(skipped, "事件通道拥塞，已丢弃部分中间事件");
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

/// 解析数据目录。
///
/// 优先用 Tauri 的 `app_data_dir()`（各平台标准位置）；
/// 拿不到时退回到 home 下的 `.toolforge`，**绝不静默失败** ——
/// 数据目录解析不出来时应用必须仍然可用，只是位置不标准。
fn resolve_data_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    match app.path().app_data_dir() {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("无法解析应用数据目录（{e}），改用用户主目录下的 .toolforge");
            dirs::home_dir()
                .unwrap_or_else(|| std::env::temp_dir())
                .join(".toolforge")
        }
    }
}

/// 解析内置插件目录。
///
/// 打包后它在 resource 目录下；开发时直接指向仓库里的 `plugins/builtin`。
///
/// ## 顺序在开发构建里**必须反过来**（这是真机踩出来的）
///
/// 原来的实现一律"先看 resource 目录"，而开发构建下
/// `resource_dir()` 就是**可执行文件所在目录**。于是：
///
/// * 从 `target/debug/toolforge.exe` 启动时，`resource_dir()` = `target/debug`，
///   而那里有一份 `tauri-build` 在**构建期**拷过去的 `bundle.resources`
///   （`plugins/builtin`）。它只在构建脚本认为需要时才刷新，
///   新增一个内置插件**不会**触发它 —— 于是那份拷贝是旧的；
/// * 结果：仓库里明明有 7 个内置插件，应用只装载了 4 个，
///   另外 3 个报"未安装"，而**从 `target/debug/deps/` 启动却又是 7 个**。
///   同一个二进制、不同的启动目录，行为不一样。
///
/// 这类"看起来像插件坏了、其实是路径解析"的问题极难排查，所以现在：
/// **开发构建优先用仓库目录**（那才是开发时的真相来源），
/// 只有打包后的发布构建才先看 resource。
fn resolve_builtin_plugins(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    // 开发态：apps/desktop/src-tauri -> 仓库根/plugins/builtin
    let repo = || {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("..")
            .join("plugins")
            .join("builtin")
    };
    let packaged = || {
        app.path()
            .resource_dir()
            .ok()
            .map(|res| res.join("plugins").join("builtin"))
            .filter(|p| p.is_dir())
    };

    // 开发构建以仓库为准；发布构建以打包资源为准
    let candidates: [&dyn Fn() -> Option<std::path::PathBuf>; 2] = if cfg!(debug_assertions) {
        [&|| repo().is_dir().then(repo), &packaged]
    } else {
        [&packaged, &|| repo().is_dir().then(repo)]
    };

    candidates.iter().find_map(|f| f())
}

/// 应用入口。
pub fn run() {
    let builder = specta_builder();

    // 开发构建里把 TS 绑定写出去，保证前端类型永远跟着 Rust 走
    #[cfg(debug_assertions)]
    {
        let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("src")
            .join("bindings.ts");
        if let Err(e) = builder.export(specta_typescript::Typescript::default(), &out) {
            tracing::warn!("导出 TypeScript 绑定失败：{e}");
        }
    }

    // 命令注册与 `COMMAND_NAMES` 的一致性**不在这里检查**。
    //
    // 这里原本有一条 `debug_assert_eq!(COMMAND_NAMES.len(), 29)`。它有两个问题，
    // 第二个是它在真机上真实发生过的：
    //
    // 1. 它比的是一个**魔数**：加了命令就把它 29 改成 30 便"通过"，而漏注册的照旧漏；
    // 2. 加命令但忘了改这个数字时，**调试构建的应用直接在启动时 panic** ——
    //    报错信息是"数量不一致"，但人看到的是一句话都没来得及说就没了的窗口。
    //    用一个和后端行为无关的常量去决定"应用能不能启动"，这个代价完全不成比例。
    //
    // 真正的守卫在 `apps/desktop/src-tauri/src/bin/export_bindings.rs`：
    // 它逐个核对 `COMMAND_NAMES` 里的每个名字是否真的出现在生成的绑定里，
    // 再比对总数 —— 既不能漏，也不能靠改数字蒙混。`pnpm bindings` 与 CI 都会跑它。

    let mut tauri_builder = tauri::Builder::default();

    // ---- 官方插件 ----
    //
    // ⚠️ **`shell` 插件被注册，但没有授予任何 execute 权限。**
    // `capabilities/default.json` 里已彻底移除 `shell:allow-execute`（以及
    // `shell:allow-open`）。理由：`shell:allow-execute` 的 scope 项是
    // `{ name, cmd, args }`，而 `args: true` 意味着**任意参数** ——
    // 对一个能启动 `explorer.exe` 的入口来说，`explorer <某个.exe>` 就是
    // 一条完整的任意程序执行路径。前端（以及将来可能注入的插件 UI）拿到它，
    // 上面所有的权限模型都成了摆设。
    //
    // "在文件管理器里显示输出文件"这个需求由 `tauri-plugin-opener` 的
    // `revealItemInDir()` 满足 —— 它是**目的明确**的 API，不是通用命令执行。
    // 保留 shell 插件的注册只是为了对齐技术选型（以及未来的 sidecar 分发），
    // 但**零权限**意味着前端调不动它。
    tauri_builder = tauri_builder
        .plugin(tauri_plugin_log::Builder::new()
            .level(if cfg!(debug_assertions) {
                tauri_plugin_log::log::LevelFilter::Debug
            } else {
                tauri_plugin_log::log::LevelFilter::Info
            })
            .build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build());

    #[cfg(feature = "updater")]
    {
        tauri_builder = tauri_builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    // ---- 应用状态与事件桥 ----
    let setup_builder = builder.clone();
    tauri_builder = tauri_builder
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            let handle = app.handle().clone();

            let data_dir = resolve_data_dir(&handle);
            let paths = AppPaths::new(&data_dir);
            let builtin = resolve_builtin_plugins(&handle);

            let (tx, rx) = broadcast::channel::<AppEvent>(2048);
            let state = AppState::new(paths.clone(), tx, builtin)
                .map_err(|e| format!("初始化应用状态失败：{e}"))?;

            // 启动时装载插件（失败的单个插件不影响其它插件）
            match state.plugins.reload() {
                Ok(r) => {
                    tracing::info!(loaded = r.loaded, failed = r.failed.len(), "插件装载完成");
                    for (dir, err) in r.failed {
                        tracing::warn!(dir, err, "插件装载失败");
                    }
                }
                Err(e) => tracing::error!("插件目录扫描失败：{e}"),
            }

            handle.manage(state);
            setup_builder.mount_events(app);
            spawn_event_bridge(handle.clone(), rx, paths);

            // 后台探测引擎：**不阻塞窗口显示**。
            // 用户看到界面比看到准确的引擎状态更重要。
            let engines = handle.state::<Arc<AppState>>().engines.clone();
            let probe_on_start = handle
                .state::<Arc<AppState>>()
                .settings
                .read()
                .probe_engines_on_startup;
            if probe_on_start {
                tauri::async_runtime::spawn(async move {
                    let statuses = engines.probe_all().await;
                    let ready = statuses.iter().filter(|s| s.state.is_usable()).count();
                    tracing::info!(ready, total = statuses.len(), "引擎探测完成");
                });
            }

            tracing::info!(data_dir = %data_dir.display(), "ToolForge 已启动");
            Ok(())
        })
        .on_window_event(|window, event| {
            // 窗口关闭时取消所有在跑的任务，避免留下孤儿进程
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<Arc<AppState>>() {
                    state.queue.cancel_all();
                }
            }
        });

    tauri_builder
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}
