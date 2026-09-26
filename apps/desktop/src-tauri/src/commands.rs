//! Tauri 命令层 —— IPC 契约的实现。
//!
//! ## 设计纪律
//!
//! 1. **命令只做编排**：解析参数 → 调用 crate → 返回。业务逻辑一律在
//!    `toolforge-*` 里，这样同样的能力可以被 CLI / 测试复用。
//! 2. **耗时操作一律异步化**：命令立即返回一个 `jobId`，实际执行在任务队列里，
//!    进度通过事件回流。**没有任何一个命令会阻塞到任务跑完** —— 否则
//!    WebView 会假死。
//! 3. **前端拿不到裸 shell**：`tauri-plugin-shell` 的 capability 只放行白名单
//!    sidecar，所有引擎调用都经过 [`toolforge_engines`] 与 [`toolforge_process`]。
//! 4. **AI 的产出永远只是草稿**：见 `ai_generate` 的文档。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use tauri::State;

use toolforge_core::engine::engine_catalog;
use toolforge_core::error::{ErrorCode, ToolforgeError, ToolforgeResult};
use toolforge_core::job::{Job, JobFilter, JobKind, JobStatus, LogLevel};
use toolforge_core::pipeline::{builtin_nodes, NodeDescriptor};
use toolforge_core::plugin::{ParamValue, PluginRuntime, PluginSource};
use toolforge_engines::registry::EngineInstallOutcome;
use toolforge_plugins::l1::{PipelineRunRequest, StepResult};
use toolforge_plugins::runtimes::PluginCallRequest;

use crate::ipc::*;
use crate::state::AppState;

// ============================================================================
// 应用信息
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn app_info() -> ToolforgeResult<toolforge_core::AppInfo> {
    Ok(toolforge_core::AppInfo {
        name: "ToolForge".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        tauri_version: tauri::VERSION.into(),
        rust_version: option_env!("CARGO_PKG_RUST_VERSION").unwrap_or("1.82").into(),
        plugin_api_version: toolforge_core::PLUGIN_API_VERSION.into(),
        build_profile: if cfg!(debug_assertions) {
            "debug".into()
        } else {
            "release".into()
        },
    })
}

#[tauri::command]
#[specta::specta]
pub async fn app_paths(state: State<'_, Arc<AppState>>) -> ToolforgeResult<AppPathsDto> {
    Ok(AppPathsDto {
        entries: state
            .paths
            .describe()
            .into_iter()
            .map(|(label, path)| PathEntry { label, path })
            .collect(),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn system_status(state: State<'_, Arc<AppState>>) -> ToolforgeResult<SystemStatus> {
    let info = app_info().await?;
    let paths = app_paths(state.clone()).await?;

    let statuses = state.engines.probe_all().await;
    let engines_ready = statuses.iter().filter(|s| s.state.is_usable()).count() as u32;
    let engines_total = statuses.len() as u32;

    let plugins = state.plugins.list();
    let plugins_total = plugins.len() as u32;
    let plugins_enabled = plugins.iter().filter(|p| p.enabled).count() as u32;

    // 目录可写性：直接试写一个文件，比检查权限位可靠
    let probe = state.paths.cache().join(".write-probe");
    let storage_writable = std::fs::write(&probe, b"ok").is_ok();
    let _ = std::fs::remove_file(&probe);

    Ok(SystemStatus {
        info,
        paths,
        engines_ready,
        engines_total,
        plugins_total,
        plugins_enabled,
        active_jobs: state.queue.active_count() as u32,
        storage_writable,
        platform: AppState::platform().to_string(),
        command_count: crate::COMMAND_NAMES.len() as u32,
    })
}

// ============================================================================
// 设置
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn settings_get(state: State<'_, Arc<AppState>>) -> ToolforgeResult<Settings> {
    let mut s = state.settings.read().clone();
    s.ai.has_key = !state.ai_api_key().trim().is_empty();
    Ok(s)
}

#[tauri::command]
#[specta::specta]
pub async fn settings_patch(
    state: State<'_, Arc<AppState>>,
    patch: SettingsPatch,
) -> ToolforgeResult<Settings> {
    {
        let mut s = state.settings.write();
        if let Some(v) = patch.concurrency {
            s.concurrency = v.clamp(1, 64);
        }        if let Some(v) = patch.theme {
            s.theme = v;
        }
        if let Some(v) = patch.accent {
            s.accent = v;
        }
        if let Some(v) = patch.ambient_effects {
            s.ambient_effects = v;
        }
        if let Some(v) = patch.default_output_dir {
            s.default_output_dir = v;
        }
        if let Some(v) = patch.keep_original {
            s.keep_original = v;
        }
        if let Some(v) = patch.probe_engines_on_startup {
            s.probe_engines_on_startup = v;
        }
        if let Some(ai) = patch.ai {
            s.ai = ai;
        }
    }

    // 并发度变化必须立刻作用到任务队列 —— 用户改这个设置时的直接预期就是
    // "下一个任务按新并发跑"，只改 settings 而不动队列等于设置无效。
    if let Some(v) = patch.concurrency {
        state.queue.set_concurrency(v.clamp(1, 64) as usize);
    }

    // Key 单独处理：写进 AI 客户端的内存态，不落到会序列化的结构体里
    if let Some(key) = patch.ai_api_key {
        let mut ai = state.ai.write();
        if key.trim().is_empty() {
            *ai = None;
        } else {
            let s = state.settings.read().clone();
            let mut cfg =
                toolforge_ai::AiProviderConfig::new(s.ai.provider);
            if !s.ai.base_url.trim().is_empty() {
                cfg.base_url = s.ai.base_url.clone();
            }
            if !s.ai.model.trim().is_empty() {
                cfg.model = s.ai.model.clone();
            }
            cfg.temperature = s.ai.temperature;
            cfg.api_key = key;
            cfg.has_key = true;
            match toolforge_ai::provider::AiClient::new(cfg) {
                Ok(c) => *ai = Some(Arc::new(c)),
                Err(e) => {
                    *ai = None;
                    return Err(e);
                }
            }
        }
    }

    settings_get(state).await
}

// ============================================================================
// 任务
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn jobs_list(
    state: State<'_, Arc<AppState>>,
    req: JobsListRequest,
) -> ToolforgeResult<JobsSnapshot> {
    let jobs = state.queue.snapshot(&req.filter);
    let running: Vec<String> = jobs
        .iter()
        .filter(|j| j.status == JobStatus::Running)
        .map(|j| j.id.to_string())
        .collect();
    Ok(JobsSnapshot {
        jobs,
        active_count: state.queue.active_count() as u32,
        running,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn jobs_get(state: State<'_, Arc<AppState>>, job_id: String) -> ToolforgeResult<Option<Job>> {
    Ok(state.queue.get(&job_id))
}

#[tauri::command]
#[specta::specta]
pub async fn jobs_cancel(state: State<'_, Arc<AppState>>, job_id: String) -> ToolforgeResult<Job> {
    state.queue.cancel(&job_id)
}

#[tauri::command]
#[specta::specta]
pub async fn jobs_clear_finished(state: State<'_, Arc<AppState>>) -> ToolforgeResult<u32> {
    Ok(state.queue.clear_finished() as u32)
}

#[tauri::command]
#[specta::specta]
pub async fn jobs_stats(state: State<'_, Arc<AppState>>) -> ToolforgeResult<JobStats> {
    let jobs = state.queue.snapshot(&JobFilter::default());
    Ok(JobStats::from_jobs(&jobs))
}

// ============================================================================
// 引擎
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn engines_catalog(state: State<'_, Arc<AppState>>) -> ToolforgeResult<Vec<EngineEntry>> {
    let nodes = builtin_nodes();
    let mut out = Vec::new();
    for d in engine_catalog() {
        let used_by: Vec<String> = nodes
            .iter()
            .filter(|n| {
                n.requires_engines.contains(&d.id) || n.optional_engines.contains(&d.id)
            })
            .map(|n| n.name.clone())
            .collect();
        let status = state.engines.status(&d.id).await;
        out.push(EngineEntry {
            descriptor: d,
            status,
            used_by_nodes: used_by,
        });
    }
    Ok(out)
}

#[tauri::command]
#[specta::specta]
pub async fn engines_probe_all(state: State<'_, Arc<AppState>>) -> ToolforgeResult<Vec<EngineEntry>> {
    state.engines.probe_all().await;
    engines_catalog(state).await
}

#[tauri::command]
#[specta::specta]
pub async fn engines_probe(
    state: State<'_, Arc<AppState>>,
    engine_id: String,
) -> ToolforgeResult<toolforge_core::engine::EngineStatus> {
    Ok(state.engines.probe(&engine_id).await)
}

/// 安装引擎。
///
/// **不会立刻返回成功**：它创建一个任务并立即返回 `jobId`，
/// 下载进度通过 `toolforge://event` 里的 `engineDownloadProgress` 事件回流。
#[tauri::command]
#[specta::specta]
pub async fn engines_install(
    state: State<'_, Arc<AppState>>,
    req: EngineInstallRequest,
) -> ToolforgeResult<String> {
    let EngineInstallRequest {
        engine_id,
        license_accepted,
        allow_unverified,
    } = req;

    let descriptor = engine_catalog()
        .into_iter()
        .find(|e| e.id == engine_id)
        .ok_or_else(|| ToolforgeError::not_found(format!("未知引擎 {engine_id}")))?;

    // 许可证确认是硬门：不能靠前端自觉
    if descriptor.requires_license_ack && !license_accepted {
        return Err(ToolforgeError::denied(format!(
            "安装 {} 前需要确认其许可证条款",
            descriptor.name
        ))
        .with_detail(format!("{}：{}", descriptor.license, descriptor.license_note)));
    }

    let job = state.queue.create(
        JobKind::EngineInstall {
            engine_id: engine_id.clone(),
        },
        format!("安装引擎 · {}", descriptor.name),
        1,
    );
    let job_id = job.id.to_string();
    let engines = state.engines.clone();

    state.queue.spawn(job, move |ctx| async move {
        let outcome = engines
            .install(&engine_id, &ctx, allow_unverified)
            .await?;
        match outcome {
            EngineInstallOutcome::Installed { path, version } => {
                ctx.info(format!(
                    "安装完成：{}（版本 {}）",
                    path.display(),
                    version.unwrap_or_else(|| "未知".into())
                ));
                Ok(vec![path.display().to_string()])
            }
            EngineInstallOutcome::AlreadyAvailable { path, .. } => {
                ctx.info(format!("已经可用，跳过下载：{}", path.display()));
                Ok(vec![path.display().to_string()])
            }
            EngineInstallOutcome::NotConfigured { reason } => {
                Err(ToolforgeError::engine_missing(&engine_id).with_detail(reason))
            }
            EngineInstallOutcome::HashRequired { reason } => Err(ToolforgeError::new(
                ErrorCode::IntegrityCheckFailed,
                reason,
            )),
        }
    });

    Ok(job_id)
}

// ============================================================================
// 插件
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn plugins_list(state: State<'_, Arc<AppState>>) -> ToolforgeResult<PluginsSnapshot> {
    let plugins = state.plugins.list();
    Ok(PluginsSnapshot {
        pending_permission_count: plugins
            .iter()
            .filter(|p| p.has_pending_permissions)
            .count() as u32,
        plugins,
        audit_dir: state.paths.audit().display().to_string(),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn plugins_get(
    state: State<'_, Arc<AppState>>,
    plugin_id: String,
) -> ToolforgeResult<Option<toolforge_core::plugin::PluginDetail>> {
    Ok(state.plugins.get(&plugin_id))
}

#[tauri::command]
#[specta::specta]
pub async fn plugins_reload(state: State<'_, Arc<AppState>>) -> ToolforgeResult<usize> {
    let report = state.plugins.reload()?;
    for (dir, err) in &report.failed {
        tracing::warn!(dir, err, "插件装载失败（其它插件不受影响）");
    }
    Ok(report.loaded)
}

/// 校验一份插件来源，**不落盘**。
#[tauri::command]
#[specta::specta]
pub async fn plugins_validate(
    state: State<'_, Arc<AppState>>,
    req: ValidatePluginRequest,
) -> ToolforgeResult<ValidatePluginResponse> {
    let yaml = match &req.source {
        PluginSource::Manifest { yaml } => yaml.clone(),
        PluginSource::Bundle { yaml, .. } => yaml.clone(),
        PluginSource::Directory { path } => {
            let p = PathBuf::from(path).join("plugin.yaml");
            std::fs::read_to_string(&p).map_err(|e| {
                ToolforgeError::io(format!("读取 {} 失败：{e}", p.display()))
            })?
        }
    };

    let manifest = toolforge_core::plugin::PluginManifest::from_yaml(&yaml)?;
    let validation = manifest.validate();

    let required_engines = match &manifest.runtime {
        PluginRuntime::Pipeline { pipeline } => pipeline.required_engines(),
        _ => vec![],
    };
    let mut missing_engines = Vec::new();
    for e in &required_engines {
        if !state.engines.is_available(e).await {
            missing_engines.push(e.clone());
        }
    }

    Ok(ValidatePluginResponse {
        validation,
        capabilities: manifest.permissions.capabilities.clone(),
        required_engines,
        missing_engines,
    })
}

/// 安装插件。
///
/// ## 两道硬门（在前端之上再加一层，因为前端可以被绕过）
///
/// * [`InstallPluginRequest::permissions_acknowledged`] 必须为 `true`；
/// * 若插件是 L3（Python），[`InstallPluginRequest::executable_code_acknowledged`]
///   也必须为 `true`。
///
/// 注意：**安装后插件仍然是禁用且零授权的状态**，还要再走 `plugins_grant` +
/// `plugins_set_enabled`。这不是啰嗦，而是让"看权限"和"用它"成为两个不同的动作。
#[tauri::command]
#[specta::specta]
pub async fn plugins_install(
    state: State<'_, Arc<AppState>>,
    req: InstallPluginRequest,
) -> ToolforgeResult<toolforge_plugins::InstallReport> {
    if !req.permissions_acknowledged {
        return Err(ToolforgeError::denied(
            "安装前必须确认该插件申请的权限清单",
        ));
    }

    // 先解析出清单，判断运行时类型
    let is_python = match &req.source {
        PluginSource::Manifest { yaml } | PluginSource::Bundle { yaml, .. } => {
            toolforge_core::plugin::PluginManifest::from_yaml(yaml)
                .map(|m| matches!(m.runtime, PluginRuntime::Python { .. }))
                .unwrap_or(false)
        }
        PluginSource::Directory { path } => {
            let p = PathBuf::from(path).join("plugin.yaml");
            std::fs::read_to_string(p)
                .ok()
                .and_then(|t| toolforge_core::plugin::PluginManifest::from_yaml(&t).ok())
                .map(|m| matches!(m.runtime, PluginRuntime::Python { .. }))
                .unwrap_or(false)
        }
    };

    if is_python && !req.executable_code_acknowledged {
        return Err(ToolforgeError::denied(
            "这是包含可执行 Python 代码的插件，请先确认你已阅读其代码",
        )
        .with_detail(
            "L3 插件以你的身份运行。宿主的隔离措施（清空环境变量、锁定工作目录、默认禁网）\
             只能挡住非蓄意的越权，不能挡住恶意代码。",
        ));
    }

    state.plugins.install(req.source, req.overwrite)
}

#[tauri::command]
#[specta::specta]
pub async fn plugins_grant(
    state: State<'_, Arc<AppState>>,
    req: GrantPermissionsRequest,
) -> ToolforgeResult<toolforge_core::plugin::PluginSummary> {
    let summary = state.plugins.set_granted(&req.plugin_id, req.granted)?;
    // 权限变了就必须重新装载（Python 进程的环境变量与能力标签都变了）
    state.runner.unload(&req.plugin_id).await;
    Ok(summary)
}

#[tauri::command]
#[specta::specta]
pub async fn plugins_set_enabled(
    state: State<'_, Arc<AppState>>,
    plugin_id: String,
    enabled: bool,
) -> ToolforgeResult<toolforge_core::plugin::PluginSummary> {
    let summary = state.plugins.set_enabled(&plugin_id, enabled)?;
    if !enabled {
        state.runner.unload(&plugin_id).await;
    }
    Ok(summary)
}

#[tauri::command]
#[specta::specta]
pub async fn plugins_uninstall(state: State<'_, Arc<AppState>>, plugin_id: String) -> ToolforgeResult<()> {
    state.runner.unload(&plugin_id).await;
    state.plugins.uninstall(&plugin_id)
}

#[tauri::command]
#[specta::specta]
pub async fn plugins_audit(state: State<'_, Arc<AppState>>, limit: u32) -> ToolforgeResult<AuditSnapshot> {
    let log = state.plugins.audit();
    Ok(AuditSnapshot {
        events: log.tail(limit.clamp(1, 2000) as usize),
        files: log
            .files()
            .into_iter()
            .map(|p| p.display().to_string())
            .collect(),
        dir: log.dir().display().to_string(),
    })
}

/// 运行插件。立即返回 `jobId`。
///
/// ## 多文件输入会真的逐个处理
///
/// 这是个修过的坑：第一版把「12 个输入文件」塞进一次流水线调用，
/// 而 `L1 执行器` 的 `${src}` 只绑定第一个路径 —— 结果是任务标题写着
/// `插件名 · 12`、实际只处理了 1 张、然后**成功结束**。用户看到的是"12 个全成功"，
/// 这是最糟糕的一类 bug（静默地少干活）。
///
/// 现在由**命令层扇出**：把主输入端口展开成 N 个单文件批次，逐批调用执行器，
/// 用 `ctx.step` 上报 `处理 3/12`。这也让 `l1.rs` 模块文档里
/// "批量由命令层展开" 那句话变成事实。
#[tauri::command]
#[specta::specta]
pub async fn plugins_run(
    state: State<'_, Arc<AppState>>,
    req: RunPluginRequest,
) -> ToolforgeResult<RunPluginResponse> {
    let app: Arc<AppState> = state.inner().clone();

    // 注册重放闭包：任务中心里的「重试」按钮靠它
    let retry_app = app.clone();
    let retry_req = req.clone();

    let response = submit_plugin_run(&app, req)?;

    app.queue.set_retry(
        &response.job_id,
        Arc::new(move || {
            if let Err(e) = submit_plugin_run(&retry_app, retry_req.clone()) {
                tracing::warn!("重试提交失败：{}", e.message);
            }
        }),
    );

    Ok(response)
}

/// 提交一次插件运行（命令层与重试闭包共用）。
fn submit_plugin_run(
    app: &Arc<AppState>,
    req: RunPluginRequest,
) -> ToolforgeResult<RunPluginResponse> {
    // 这一步会校验：已安装 / 已启用 / 校验通过 / 权限齐全
    let record = app.plugins.runnable(&req.plugin_id)?;
    // 哈希校验：与安装时不一致就直接拒绝并禁用
    app.plugins.quarantine_if_changed(&req.plugin_id)?;

    // 把多文件输入展开成单文件批次
    let batches = expand_batches(&req.inputs);
    let total_items = batches.len().max(1) as u32;

    let output_dir = resolve_output_dir(app, &req)?;
    std::fs::create_dir_all(&output_dir)
        .map_err(|e| ToolforgeError::io(format!("创建输出目录失败：{e}")))?;

    let name = record.manifest.metadata.name.clone();
    let kind = JobKind::PluginRun {
        plugin_id: req.plugin_id.clone(),
    };
    let job = app.queue.create(
        kind,
        format!("{name} · {total_items} 项"),
        total_items,
    );
    let job_id = job.id.to_string();

    let runner = app.runner.clone();
    let engines = app.engines.clone();
    let paths = app.paths.clone();
    let plugin_id = req.plugin_id.clone();

    app.queue.spawn(job, move |ctx| async move {
        let workspace = paths.job_workspace(ctx.id.as_str());
        std::fs::create_dir_all(&workspace).ok();

        let mut produced_all: Vec<String> = Vec::new();
        let total = batches.len().max(1);

        for (idx, inputs) in batches.iter().enumerate() {
            // 取消检查放在批次边界 —— 这是"取消秒级生效"的关键
            ctx.check()?;

            let (input_root, outputs) = build_io(inputs, &output_dir, &req.params)?;
            let label = inputs
                .values()
                .find_map(|v| v.first())
                .map(|p| {
                    std::path::Path::new(p)
                        .file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_else(|| p.clone())
                })
                .unwrap_or_else(|| plugin_id.clone());

            ctx.step(&format!("处理 {}/{} · {label}", idx + 1, total), idx as u64, total as u64);

            let call_req = PluginCallRequest {
                payload: serde_json::json!({
                    "input": inputs,
                    "params": req.params,
                    "paths": {
                        "input": input_root.display().to_string(),
                        "output": output_dir.display().to_string(),
                        "data": paths.plugin_data(&plugin_id).display().to_string(),
                        "work": workspace.display().to_string(),
                    },
                    "capabilities": record
                        .effective()
                        .capabilities
                        .iter()
                        .map(|c| format!("{c:?}"))
                        .collect::<Vec<_>>(),
                }),
                input_root: input_root.clone(),
                output_root: output_dir.clone(),
                plugin_data_root: paths.plugin_data(&plugin_id),
                workspace_root: workspace.clone(),
            };

            let produced = match &record.manifest.runtime {
                PluginRuntime::Pipeline { .. } => {
                    let pipeline_req = PipelineRunRequest {
                        inputs: inputs.clone(),
                        outputs: outputs.clone(),
                        params: req.params.clone(),
                        input_root,
                        output_root: output_dir.clone(),
                        plugin_data_root: paths.plugin_data(&plugin_id),
                        workspace_root: workspace.clone(),
                    };
                    let result =
                        toolforge_plugins::l1::run_pipeline(&record, &pipeline_req, engines.clone(), &ctx)
                            .await?;
                    report_steps(&ctx, &result.steps);
                    for w in &result.warnings {
                        ctx.warn(w.clone());
                    }
                    if result.outputs.is_empty() {
                        // 跑完但零产出 —— 几乎总是清单里没把步骤接到输出端口
                        ctx.warn(format!(
                            "`{label}` 执行成功但没有产出文件，请检查清单里步骤的输出端口绑定"
                        ));
                    }
                    result.outputs
                }
                _ => {
                    ctx.info(format!("调用插件进程处理 {label}"));
                    let value = runner.call(&record, &call_req, &ctx).await?;
                    // 插件返回值可能很大，只在 debug 级别留一份摘要，方便排查
                    ctx.log(LogLevel::Debug, format!("插件返回：{}", summarize(&value)));
                    let produced = extract_outputs(&value);
                    if produced.is_empty() {
                        outputs.values().cloned().collect()
                    } else {
                        produced
                    }
                }
            };

            produced_all.extend(produced);
        }

        ctx.progress_now(toolforge_core::job::JobProgress::ratio(
            "完成",
            total as u64,
            total as u64,
        ));
        Ok(produced_all)
    });

    Ok(RunPluginResponse {
        job_id,
        plugin_name: name,
        total_items,
    })
}

/// 把多文件输入展开成"一批一个文件"。
///
/// 选**文件数最多的那个输入端口**作为主端口来扇出：这是唯一能在插件的输入契约
/// （可能同时有 `image` 与 `mask` 两个端口）下保持行为可预测的规则。
/// 其余端口的值在每一批里原样保留。
///
/// 单文件输入时退化为一次调用，与之前行为一致。
fn expand_batches(inputs: &HashMap<String, Vec<String>>) -> Vec<HashMap<String, Vec<String>>> {
    let primary = inputs
        .iter()
        .max_by_key(|(_, v)| v.len())
        .map(|(k, _)| k.clone());

    let Some(primary) = primary else {
        return vec![inputs.clone()];
    };
    let items = inputs.get(&primary).cloned().unwrap_or_default();
    if items.len() <= 1 {
        return vec![inputs.clone()];
    }

    items
        .into_iter()
        .map(|item| {
            let mut m = inputs.clone();
            m.insert(primary.clone(), vec![item]);
            m
        })
        .collect()
}

/// 任务重试。仅对注册过重放闭包的任务有效（插件运行可以，引擎安装与 AI 生成不行）。
#[tauri::command]
#[specta::specta]
pub async fn jobs_retry(state: State<'_, Arc<AppState>>, job_id: String) -> ToolforgeResult<String> {
    state.queue.retry(&job_id)?;
    Ok(job_id)
}

// ============================================================================
// 流程编辑器
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn pipeline_nodes(state: State<'_, Arc<AppState>>) -> ToolforgeResult<NodeCatalogResponse> {
    let nodes: Vec<NodeDescriptor> = builtin_nodes();
    let mut availability: HashMap<String, bool> = HashMap::new();
    let mut missing_engines: HashMap<String, Vec<String>> = HashMap::new();

    for n in &nodes {
        let mut ok = true;
        for e in &n.requires_engines {
            if !state.engines.is_available(e).await {
                ok = false;
                missing_engines
                    .entry(e.clone())
                    .or_default()
                    .push(n.name.clone());
            }
        }
        availability.insert(n.name.clone(), ok);
    }

    Ok(NodeCatalogResponse {
        nodes,
        availability,
        missing_engines,
    })
}

// ============================================================================
// AI
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn ai_test_connection(state: State<'_, Arc<AppState>>) -> ToolforgeResult<AiTestConnectionResponse> {
    let client = state.ai.read().clone();
    let Some(client) = client else {
        return Ok(AiTestConnectionResponse {
            ok: false,
            models: vec![],
            error: Some("尚未配置 AI 服务（缺少 API Key 或端点）".into()),
        });
    };
    match client.list_models().await {
        Ok(models) => Ok(AiTestConnectionResponse {
            ok: true,
            models,
            error: None,
        }),
        Err(e) => Ok(AiTestConnectionResponse {
            ok: false,
            models: vec![],
            error: Some(format!("{}｜{}", e.message, e.detail.unwrap_or_default())),
        }),
    }
}

/// 用自然语言生成插件草稿。
///
/// ## 返回的是草稿，不是插件
///
/// 这个命令**不写盘、不装载**。它返回 [`AiGenerateResponse`]：
/// 原始草稿 + 审核报告。安装必须由用户在前端确认后另调 `plugins_install`。
/// 这样即使模型被提示词注入攻陷，它也只能产出"用户看得见的一份草稿"。
#[tauri::command]
#[specta::specta]
pub async fn ai_generate(
    state: State<'_, Arc<AppState>>,
    req: AiGenerateRequest,
) -> ToolforgeResult<AiGenerateResponse> {
    if req.description.trim().len() < 4 {
        return Err(ToolforgeError::invalid("请把需求描述得再具体一点"));
    }

    let client = {
        let guard = state.ai.read();
        guard.clone().ok_or_else(|| {
            ToolforgeError::new(
                ErrorCode::AiUnavailable,
                "尚未配置 AI 服务",
            )
            .with_detail("请到「设置 → AI」填写提供方、模型与 API Key。也可以指向本地 Ollama。")
        })?
    };

    let available: Vec<String> = state
        .engines
        .cached_statuses()
        .into_iter()
        .filter(|s| s.state.is_usable())
        .map(|s| s.id)
        .collect();

    let mut gen_req = toolforge_ai::GenerationRequest::new(req.description.clone());
    gen_req.available_engines = available;
    gen_req.category_hint = req.category_hint;
    gen_req.allow_python = req.allow_python;

    let messages = vec![
        toolforge_ai::provider::ChatMessage::system(toolforge_ai::system_prompt()),
        toolforge_ai::provider::ChatMessage::user(toolforge_ai::build_user_prompt(&gen_req)),
    ];

    let raw = client.complete(&messages).await?;
    let files = toolforge_ai::parse_model_output(&raw)?;

    let draft = toolforge_ai::review::AiDraft {
        prompt: req.description,
        model: client.config().model.clone(),
        files,
        raw: raw.clone(),
    };

    // 审核时把 allow_python 的意图也考虑进去
    let review = toolforge_ai::review::review_draft(&draft);

    Ok(AiGenerateResponse {
        draft,
        review,
        provider: client.config().kind.describe().to_string(),
        model: client.config().model.clone(),
    })
}

/// 对一段（可能被用户手改过的）插件文本重新审核。
#[tauri::command]
#[specta::specta]
pub async fn ai_review_draft(
    _state: State<'_, Arc<AppState>>,
    raw: String,
) -> ToolforgeResult<toolforge_ai::review::SecurityReview> {
    let files = toolforge_ai::parse_model_output(&raw)?;
    let draft = toolforge_ai::review::AiDraft {
        prompt: String::new(),
        model: "manual".into(),
        files,
        raw,
    };
    Ok(toolforge_ai::review::review_draft(&draft))
}

// ============================================================================
// 内部辅助
// ============================================================================

fn resolve_output_dir(state: &AppState, req: &RunPluginRequest) -> ToolforgeResult<PathBuf> {
    if !req.output_dir.trim().is_empty() {
        return Ok(PathBuf::from(&req.output_dir));
    }
    let s = state.settings.read();
    if !s.default_output_dir.trim().is_empty() {
        return Ok(PathBuf::from(&s.default_output_dir));
    }
    // 兜底：数据目录下的 output/（绝不往用户没指定的地方写文件）
    let dir = state.paths.root().join("output");
    Ok(dir)
}

/// 推导输入根目录与输出路径映射（针对**一个批次**）。
///
/// 输入根目录 = 该批次所有输入文件的公共父目录。这是 [`PathResolver`] 的收敛边界：
/// 插件只能读这个范围内（以及它自己的数据目录），读别的会被拒绝并记审计。
fn build_io(
    inputs: &HashMap<String, Vec<String>>,
    output_dir: &std::path::Path,
    params: &HashMap<String, ParamValue>,
) -> ToolforgeResult<(PathBuf, HashMap<String, String>)> {
    let mut input_root: Option<PathBuf> = None;
    for paths in inputs.values() {
        for p in paths {
            let path = PathBuf::from(p);
            let parent = path.parent().map(|x| x.to_path_buf()).unwrap_or_default();
            input_root = Some(match input_root {
                None => parent,
                Some(cur) => common_prefix(&cur, &parent),
            });
        }
    }

    // 输出名：<源文件名主干>.<params.format 或原扩展名>
    let ext = params
        .get("format")
        .and_then(|v| v.as_str())
        .map(|s| s.trim_start_matches('.').to_string());

    let mut outputs = HashMap::new();
    let first_input = inputs.values().find_map(|v| v.first());
    if let Some(src) = first_input {
        let stem = PathBuf::from(src)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "output".into());
        let original_ext = PathBuf::from(src)
            .extension()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "out".into());
        let name = format!("{stem}.{}", ext.unwrap_or(original_ext));
        outputs.insert("dst".to_string(), output_dir.join(name).display().to_string());
    }

    Ok((
        input_root.unwrap_or_else(|| output_dir.to_path_buf()),
        outputs,
    ))
}

fn common_prefix(a: &std::path::Path, b: &std::path::Path) -> PathBuf {
    let mut out = PathBuf::new();
    for (x, y) in a.components().zip(b.components()) {
        if x == y {
            out.push(x.as_os_str());
        } else {
            break;
        }
    }
    if out.as_os_str().is_empty() {
        a.to_path_buf()
    } else {
        out
    }
}

fn report_steps(ctx: &toolforge_core::queue::JobCtx, steps: &[StepResult]) {
    for s in steps {
        match s.status {
            toolforge_plugins::l1::StepStatus::Ok => {
                ctx.log(LogLevel::Debug, format!("✓ {}（{} ms）", s.label, s.duration_ms))
            }
            toolforge_plugins::l1::StepStatus::Skipped => ctx.warn(format!(
                "⊘ {} 已跳过：{}",
                s.label,
                s.error.clone().unwrap_or_else(|| "条件不成立".into())
            )),
            toolforge_plugins::l1::StepStatus::Failed => {
                ctx.error(format!("✗ {}", s.label))
            }
        }
    }
}

fn summarize(v: &serde_json::Value) -> String {
    let s = serde_json::to_string(v).unwrap_or_default();
    if s.chars().count() > 500 {
        s.chars().take(500).collect::<String>() + "…"
    } else {
        s
    }
}

/// 从插件返回值里提取产出文件。
///
/// 约定：返回值是对象且带 `outputs` 数组（也可以是 `output` 单值）。
fn extract_outputs(v: &serde_json::Value) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(arr) = v.get("outputs").and_then(|x| x.as_array()) {
        for item in arr {
            if let Some(s) = item.as_str() {
                out.push(s.to_string());
            }
        }
    }
    if let Some(s) = v.get("output").and_then(|x| x.as_str()) {
        out.push(s.to_string());
    }
    out
}

/// 让 `Arc<AppState>` 能在命令签名里使用
pub type SharedState = Arc<AppState>;
