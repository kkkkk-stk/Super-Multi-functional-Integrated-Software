//! Tauri 命令层 —— IPC 契约的实现。
//!
//! ## 设计纪律
//!
//! 1. **命令只做编排**：解析参数 → 调用 crate → 返回。业务逻辑一律在
//!    `toolforge-*` 里，这样同样的能力可以被 CLI / 测试复用。
//! 2. **耗时操作一律异步化**：命令立即返回一个 `jobId`，实际执行在任务队列里，
//!    进度通过事件回流。**没有任何一个命令会阻塞到任务跑完** —— 否则
//!    WebView 会假死。
//! 3. **前端拿不到裸 shell**：`capabilities/default.json` 里**没有授予
//!    `shell:allow-execute`**（连 `shell:allow-open` 也没有）。"在文件管理器里
//!    显示文件"走 `opener` 插件的 `revealItemInDir()` —— 那是目的明确的 API。
//!    所有引擎调用都经过 [`toolforge_engines`] 与 [`toolforge_process`]，
//!    绝不由前端拼命令行。
//! 4. **AI 的产出永远只是草稿**：见 `ai_generate` 的文档。
//! 5. **安全事件要落审计**：`PluginCapabilityViolation` 与 AI 草稿被拒都会写
//!    审计日志（NDJSON），见 `plugins_audit` 命令。

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

/// 局部更新设置。
///
/// ## 顺序是有讲究的
///
/// 1. **改内存**（用户立刻看到效果）
/// 2. **落盘**（关掉应用还在）
/// 3. **把变化作用到运行时**（并发度 → 队列；AI 配置 → 重建客户端）
///
/// 第 3 步不能漏：`AiClient` 在构造时就把 base_url / 模型 / Key 固化进连接池了，
/// 只改 `settings` 不重建客户端，界面上显示"已改成 gpt-4o"，
/// 实际请求还打给老模型 —— 这类"设置了但没生效"的 bug 最难被发现。
#[tauri::command]
#[specta::specta]
pub async fn settings_patch(
    state: State<'_, Arc<AppState>>,
    patch: SettingsPatch,
) -> ToolforgeResult<Settings> {
    // `patch.ai` 后面还要用来判断"AI 配置变了吗"，先取出来避免部分移动
    let ai_patch = patch.ai;
    let ai_changed = ai_patch.is_some();

    {
        let mut s = state.settings.write();
        if let Some(v) = patch.concurrency {
            s.concurrency = v.clamp(1, 64);
        }
        if let Some(v) = patch.theme {
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
        if let Some(ai) = ai_patch {
            s.ai = ai;
        }
    }

    // 并发度变化必须立刻作用到任务队列 —— 用户改这个设置时的直接预期就是
    // "下一个任务按新并发跑"，只改 settings 而不动队列等于设置无效。
    if let Some(v) = patch.concurrency {
        state.queue.set_concurrency(v.clamp(1, 64) as usize);
    }

    // Key 单独处理：它不在 `Settings` 里（那个结构体会被序列化给前端）
    if let Some(key) = patch.ai_api_key {
        state.set_api_key(Some(key));
    }

    // 提供方 / base_url / 模型 / 温度变了 → 用同一个 Key 重建客户端
    if ai_changed {
        state.rebuild_ai_client();
    }

    // 最后落盘。放在运行时变更之后，是为了让"磁盘上的那份"与"正在跑的那份"
    // 尽可能一致：如果先落盘再改运行时，中间崩掉就会出现
    // "文件说改了、下次启动生效"的错位。
    state.persist_settings();

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
        let managed_available = state.engines.has_download_source(&d.id);
        out.push(EngineEntry {
            descriptor: d,
            status,
            used_by_nodes: used_by,
            managed_available,
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
        force,
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
            .install(&engine_id, &ctx, allow_unverified, force)
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
// 模型权重
// ============================================================================

/// 列出全部模型权重及其状态。
///
/// `downloadable` 是给界面用的：**没有配置下载源的模型必须提前显示为不可下载**，
/// 而不是让用户点一下、等几秒、再收到一个"没有配置 SHA-256"的错误。
#[tauri::command]
#[specta::specta]
pub async fn models_list(state: State<'_, Arc<AppState>>) -> ToolforgeResult<Vec<ModelEntry>> {
    // 不再需要节点目录：权重服务于哪些节点**由权重自己声明**（`EngineModel.used_by`），
    // 而不是从"它所属引擎被谁用"去推 —— 那个推断对 `onnx-models`
    // （同时承载抠图与超分两组权重）是错的，曾导致验证脚本挑错模型。
    let registered: HashMap<String, toolforge_engines::ModelSpec> = state
        .engines
        .models()
        .into_iter()
        .map(|m| (m.id.clone(), m))
        .collect();

    let mut out = Vec::new();
    for desc in engine_catalog() {
        for m in desc.models {
            let registered_spec = registered.get(&m.id);
            let path = state.engines.model_path(&m.id);
            let installed_size = path
                .as_ref()
                .filter(|p| p.exists())
                .and_then(|p| std::fs::metadata(p).ok())
                .map(|meta| meta.len() as f64 / (1024.0 * 1024.0));

            // 归属**只认权重自己写的 `used_by`**，不再从"所属引擎被谁用"去推。
            //
            // 那个推断只对"一个引擎一组权重"成立，而 `onnx-models` 同时承载
            // 抠图与超分两组权重 —— 推出来的结果是"抠图权重也服务于 ai.upscale"，
            // 这直接导致一个验证脚本挑错了模型、拿分割模型去超分，
            // 还因为尺寸断言恰好成立而"全绿"。权重与节点的对应推不出来，只能写。
            let used_by_nodes: Vec<String> = m.used_by.clone();

            out.push(ModelEntry {
                id: m.id.clone(),
                name: m.name.clone(),
                purpose: m.purpose.clone(),
                license: m.license.clone(),
                commercial_use: m.commercial_use,
                approx_size_mb: m.approx_size_mb,
                installed: installed_size.is_some(),
                installed_size_mb: installed_size,
                downloadable: registered_spec.is_some() && m.sha256.is_some(),
                used_by_nodes,
                engine_id: desc.id.clone(),
            });
        }
    }
    Ok(out)
}

/// 下载一个模型权重。
#[tauri::command]
#[specta::specta]
pub async fn models_install(
    state: State<'_, Arc<AppState>>,
    req: ModelInstallRequest,
) -> ToolforgeResult<String> {
    let ModelInstallRequest {
        model_id,
        license_accepted,
    } = req;

    // 找到目录里的那一条（顺便拿到许可证信息）
    let spec = engine_catalog()
        .into_iter()
        .flat_map(|d| d.models)
        .find(|m| m.id == model_id)
        .ok_or_else(|| ToolforgeError::not_found(format!("未知模型 {model_id}")))?;

    // 不可商用的权重必须显式确认 —— 与引擎安装同一套硬门
    if !spec.commercial_use && !license_accepted {
        return Err(ToolforgeError::denied(format!(
            "{} 的权重不允许商用，请先确认你了解它的许可条款",
            spec.name
        ))
        .with_detail(format!("{}：{}", spec.license, spec.purpose)));
    }

    // 没有下载源就**当场拒绝**，不要排一个注定失败的下载任务
    if spec.url.is_none() || spec.sha256.is_none() {
        return Err(ToolforgeError::not_found(format!(
            "{} 还没有配置可校验的下载源",
            spec.name
        ))
        .with_detail(
            "为了避免「下载来路不明的模型」，本项目只接受能核对 SHA-256 的来源；\
             这个模型的哈希还没被核对过（见 crates/toolforge-core/src/engine.rs 里 \
             verified_sources_are_pinned 的说明）。",
        ));
    }

    let job = state.queue.create(
        JobKind::ModelDownload {
            model_id: model_id.clone(),
        },
        format!("下载模型 · {}", spec.name),
        1,
    );
    let job_id = job.id.to_string();
    let engines = state.engines.clone();
    let name = spec.name.clone();

    state.queue.spawn(job, move |ctx| async move {
        ctx.info(format!("开始下载 {name}（约 {} MB）", spec.approx_size_mb));
        let path = engines.install_model(&model_id, &ctx, false).await?;
        ctx.info(format!("模型就绪：{}", path.display()));
        Ok(vec![path.display().to_string()])
    });

    Ok(job_id)
}

/// 删除一个已下载的模型权重，释放磁盘。
#[tauri::command]
#[specta::specta]
pub async fn models_remove(
    state: State<'_, Arc<AppState>>,
    model_id: String,
) -> ToolforgeResult<bool> {
    state.engines.remove_model(&model_id)
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
            match submit_plugin_run(&retry_app, retry_req.clone()) {
                // 返回**新任务的 id**：重放是重新提交，任务 id 一定不同
                Ok(r) => Some(toolforge_core::ids::JobId::from(r.job_id)),
                Err(e) => {
                    tracing::warn!("重试提交失败：{}", e.message);
                    None
                }
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
    // 这一步会校验：已安装 / 已启用 / 校验通过
    let record = app.plugins.runnable(&req.plugin_id)?;
    // 哈希校验：与安装时不一致就直接拒绝并禁用
    app.plugins.quarantine_if_changed(&req.plugin_id)?;

    // 声明了但没授权的能力**不阻塞运行**（部分授权是允许的），但必须提前说一句：
    // 用户点下去却撞上 PERMISSION_DENIED 时，至少日志里已经有原因。
    // 这条曾经是硬阻塞，见 `PluginStore::set_enabled` 的文档。
    let ungranted = app.plugins.ungranted_declared(&req.plugin_id);

    // 把多文件输入展开成单文件批次（目录会先展开成里面的文件）
    let batches = expand_batches(&req.inputs, &record.manifest.io.inputs)?;
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
    // 审计日志句柄：**应用那一个**（`<data>/audit`），不是从插件目录反推出来的。
    // 内置插件在 `<仓库>/plugins/builtin/` 下，反推会写到 `<仓库>/plugins/audit/`
    // —— 既污染工作树，又让 L1 与 L2/L3 的审计分家。真机跑 video-to-gif 时冒出来的
    // `plugins/audit/` 就是这么来的。
    let audit = app.plugins.audit().clone();
    // 在锁外克隆一份句柄：`AiClient` 在 `RwLock` 里，持锁跨 await 会饿死设置保存
    let vision: Option<Arc<dyn toolforge_core::ai::VisionClient>> = app
        .ai
        .read()
        .as_ref()
        .map(|c| c.clone() as Arc<dyn toolforge_core::ai::VisionClient>);

    app.queue.spawn(job, move |ctx| async move {
        let workspace = paths.job_workspace(ctx.id.as_str());
        std::fs::create_dir_all(&workspace).ok();

        if !ungranted.is_empty() {
            ctx.warn(format!(
                "该插件有 {} 项声明的能力尚未授权，用到时会被拒绝并记入安全审计：{}",
                ungranted.len(),
                ungranted.join("、")
            ));
        }

        let mut produced_all: Vec<String> = Vec::new();
        let total = batches.len().max(1);

        for (idx, inputs) in batches.iter().enumerate() {
            // 取消检查放在批次边界 —— 这是"取消秒级生效"的关键
            ctx.check()?;

            let (input_root, outputs) =
                build_io(inputs, &output_dir, &req.params, &record.manifest.io.outputs)?;
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
                    // ⚠️ `params` 必须是**裸值**，不能直接把 `ParamValue` 序列化过去。
                    // 它的 serde 形状是 `{kind, value}`（那是给前端做表单绑定用的
                    // 可判别联合），插件收到那个形状会直接解析失败 —— 两个语言不同、
                    // 互相独立的示例插件都栽在这里，详见 `ParamValue::to_plain_json`。
                    "params": toolforge_core::plugin::params_to_plain_json(&req.params),
                    "paths": {
                        "input": input_root.display().to_string(),
                        "output": output_dir.display().to_string(),
                        "data": paths.plugin_data(&plugin_id).display().to_string(),
                        "work": workspace.display().to_string(),
                    },
                    // ⚠️ 用 `label()` 而**不是** `format!("{c:?}")`。
                    // Debug 输出会把 `fsRead` 写成 `FsRead { scope: Input }`，
                    // 而插件（以及文档）认的是 camelCase 标签 —— 照 Debug 输出走，
                    // 插件里 `if "fsRead" in caps` 永远为假。
                    "capabilities": record
                        .effective()
                        .capabilities
                        .iter()
                        .map(|c| c.label())
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
                        // 批量由命令层扇出，序号也从这里注入 ——
                        // 流水线自己不知道"我跑了几次"，但 `${batch.index}`
                        // 对"给每个文件编号"这类重命名需求是必需的。
                        batch_index: (idx + 1) as u32,
                        batch_total: total as u32,
                        // 视觉能力（`ai.describe` / `doc.ocr` 要用）。
                        // 没配 AI 时是 `None` —— 那类节点会报一条可操作的错误，
                        // 其余节点完全不受影响。
                        vision: vision.clone(),
                    };
                    // 审计日志用**应用那一个**，不要从插件目录反推 ——
                    // 内置插件在 `<仓库>/plugins/builtin/` 下，反推会写到
                    // `<仓库>/plugins/audit/`（污染工作树，且与 L2/L3 的审计分家）。
                    let result = toolforge_plugins::l1::run_pipeline(
                        &record,
                        &pipeline_req,
                        engines.clone(),
                        &audit,
                        &ctx,
                    )
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
                    interpret_plugin_response(
                        &record,
                        &value,
                        &output_dir,
                        &ctx,
                        &outputs,
                    )?
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

/// 一个输入端口最多展开多少个文件。
///
/// 拖进来一个含几万张图的目录时，"立刻创建几万个批次"会把任务队列和界面一起
/// 拖垮。这里设一个上限并**明确报错**（而不是静默截断）—— 静默截断会让用户
/// 以为"处理完了"，实际只处理了前一部分。
const MAX_DIR_EXPANSION: usize = 5000;

/// 把一个目录展开成它里面的文件列表（**只展开一层**）。
///
/// ## 为什么只展开一层
///
/// 递归展开会让"我拖了一个文件夹"变成"它翻遍了我整个照片库的每一层"，
/// 这既慢又违背意图。一层是最符合"拖进一堆文件"直觉的语义；
/// 真需要递归的用户可以自己选目录里的子目录。
///
/// 结果**排序**是为了可复现：目录项的枚举顺序在文件系统之间没有保证，
/// 不排序的话 `${batch.index}` 每次跑出来的编号都不一样。
fn expand_dir(dir: &std::path::Path) -> ToolforgeResult<Vec<String>> {
    let entries = std::fs::read_dir(dir)
        .map_err(|e| ToolforgeError::io(format!("读取目录 {} 失败：{e}", dir.display())))?;

    let mut files: Vec<String> = Vec::new();
    for e in entries.flatten() {
        let path = e.path();
        // 只收普通文件：子目录（不递归）、符号链接、设备文件都跳过
        let Ok(meta) = e.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        // 跳过隐藏文件与 macOS 的 `._` 资源叉：用户不会指望它们被处理
        if name.starts_with('.') {
            continue;
        }
        files.push(path.display().to_string());
        if files.len() > MAX_DIR_EXPANSION {
            return Err(ToolforgeError::invalid(format!(
                "目录 {} 里的文件超过 {MAX_DIR_EXPANSION} 个，一次装不下",
                dir.display()
            ))
            .with_detail("请分批拖入，或者先按子目录拆开。"));
        }
    }

    files.sort();
    Ok(files)
}

/// 把多文件输入展开成"一批一个文件"。
///
/// ## 三条规则
///
/// 1. **只有"文件类"端口才做目录展开**（见下）。
/// 2. **目录 → 里面的文件**：`build_io` 会把输入根收敛成"输入文件的公共父目录"，
///    如果直接把目录当输入，那个根会退化成**目录的父级**（选了 `D:\照片` 就授权到
///    `D:\`）。先展开成文件，根就正好是那个目录本身 —— 权限更紧，行为也更符合
///    "拖进一个文件夹，逐个处理"的直觉。
/// 3. **多文件 → 逐文件**：选**文件数最多的那个文件类端口**作为主端口来扇出。
///    这是唯一能在插件的输入契约（可能同时有 `image` 与 `mask` 两个端口）下
///    保持行为可预测的规则。其余端口的值在每一批里原样保留。
///
/// 单文件输入时退化为一次调用，与之前行为一致。
///
/// ## 为什么要按端口类型区分（这一条是真机测出来的）
///
/// 原来对**所有**端口一律做 `Path::new(v).is_dir()` 判断。于是一个
/// `type: text` 的端口，只要用户填的字符串恰好是一个存在的目录
/// （比如往"网址/路径"文本框里粘了 `D:\照片`），就会被**静默展开成那个目录里的
/// 所有文件**，然后逐文件跑 5000 次。用户看到的是"我明明只想传一个字符串"。
///
/// 探针插件把它撞出来了：`env` 白名单的验证要让插件比对宿主环境变量的值，
/// 那个值是 `C:\Users\<用户>` —— 一个真实存在的目录，于是输入端口被展开，
/// 插件拿到的是目录里的第一个文件名。字符串输入和文件输入是**两种东西**，
/// 判定只能看清单声明的类型。
///
/// 没声明过的端口（清单里 `io.inputs` 为空，或端口名对不上）保持旧行为 ——
/// 那些插件本来就依赖"字符串看着像目录就展开"，改掉它们会静默破坏行为。
fn expand_batches(
    inputs: &HashMap<String, Vec<String>>,
    declared_inputs: &[toolforge_core::plugin::IoPort],
) -> ToolforgeResult<Vec<HashMap<String, Vec<String>>>> {
    use toolforge_core::plugin::PortType;

    let declared: HashMap<&str, PortType> = declared_inputs
        .iter()
        .map(|p| (p.id.as_str(), p.ty))
        .collect();
    // 这个端口是不是"文件/目录"语义（决定要不要展开、能不能当主端口）
    let is_fileish = |port: &str| match declared.get(port) {
        Some(PortType::File | PortType::Files | PortType::Directory) => true,
        Some(_) => false, // text / number / boolean / json / any 都不是路径
        None => true,     // 清单没声明 → 保持旧行为
    };

    // 第一步：目录展开（这一步会先做，因为它会改变"哪个端口最大"）
    let mut expanded: HashMap<String, Vec<String>> = HashMap::new();
    for (port, paths) in inputs {
        let mut out: Vec<String> = Vec::new();
        for p in paths {
            if is_fileish(port) && std::path::Path::new(p).is_dir() {
                out.extend(expand_dir(std::path::Path::new(p))?);
            } else {
                out.push(p.clone());
            }
        }
        expanded.insert(port.clone(), out);
    }

    let primary = expanded
        .iter()
        .filter(|(port, _)| is_fileish(port))
        .max_by_key(|(_, v)| v.len())
        .map(|(k, _)| k.clone());

    let Some(primary) = primary else {
        return Ok(vec![expanded]);
    };
    let items = expanded.get(&primary).cloned().unwrap_or_default();
    // 目录展开后一个文件都没有时，不要返回空列表 —— 那会让整个任务零产出地"成功"。
    // 这里保持原样交给下游，让"输入为空"以它本来该有的方式暴露出来。
    if items.len() <= 1 {
        return Ok(vec![expanded]);
    }

    Ok(items
        .into_iter()
        .map(|item| {
            let mut m = expanded.clone();
            m.insert(primary.clone(), vec![item]);
            m
        })
        .collect())
}

/// 任务重试。仅对注册过重放闭包的任务有效（插件运行可以，引擎安装与 AI 生成不行）。
///
/// **返回的是新任务的 id**，不是传进来的那个：重放会重新提交一次
/// （`submit_plugin_run` → `queue.create()`），拿到的是一个新任务。
/// 调用方应当用返回值去跟踪这次重试；旧 id 会永远停在它的终态上。
#[tauri::command]
#[specta::specta]
pub async fn jobs_retry(state: State<'_, Arc<AppState>>, job_id: String) -> ToolforgeResult<String> {
    Ok(state.queue.retry(&job_id)?.to_string())
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

    // 已下载的权重（按**权重自己的** `used_by` 归属，见下面的补充规则）
    let installed_models: Vec<(String, Vec<String>)> = state
        .engines
        .models()
        .into_iter()
        .filter(|m| state.engines.is_model_installed(&m.id))
        .map(|m| (m.id.clone(), m.used_by.clone()))
        .collect();

    for n in &nodes {
        let mut ok = true;
        // ① 必需引擎（合取）
        for e in &n.requires_engines {
            if !state.engines.is_available(e).await {
                ok = false;
                missing_engines
                    .entry(e.clone())
                    .or_default()
                    .push(n.name.clone());
            }
        }

        // ② 补充规则（见 `NodeAvailabilityRule`）
        //
        // 没有这两条的时候，UI 会**对用户撒谎**：`ebook.convert` 在既没有
        // Calibre 也没有 Pandoc 的机器上显示可用；`ai.upscale` 在只下了抠图
        // 权重的机器上也显示可用。用户点下去才撞到 EngineMissing。
        if let Some(rule) = toolforge_core::pipeline::availability_rule(&n.name) {
            // ②a "这一组里至少有一个"（析取）
            if !rule.at_least_one_of.is_empty() {
                let mut any = false;
                for e in rule.at_least_one_of {
                    if state.engines.is_available(e).await {
                        any = true;
                        break;
                    }
                }
                if !any {
                    ok = false;
                    for e in rule.at_least_one_of {
                        missing_engines
                            .entry((*e).to_string())
                            .or_default()
                            .push(n.name.clone());
                    }
                }
            }
            // ②b "至少有一个**属于本节点**的权重"
            if rule.requires_model_weight {
                let has = installed_models
                    .iter()
                    .any(|(_, used_by)| used_by.iter().any(|u| u == &n.name));
                if !has {
                    ok = false;
                    missing_engines
                        .entry("onnx-models".to_string())
                        .or_default()
                        .push(n.name.clone());
                }
            }
        }

        availability.insert(n.name.clone(), ok);
    }

    Ok(NodeCatalogResponse {
        nodes,
        availability,
        missing_engines,
        unimplemented: toolforge_core::pipeline::UNIMPLEMENTED_NODES
            .iter()
            .map(|s| s.to_string())
            .collect(),
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

    // AI 草稿被拒是**安全事件**，必须落审计。
    // 它回答的问题是："这个模型是不是经常试图生成越权的插件？"
    // 如果不记，用户只会看到一句"审核未通过"，而没有任何可追溯的痕迹。
    if !review.recommended {
        let codes: Vec<String> = review
            .findings
            .iter()
            .filter(|f| f.severity >= toolforge_core::permission::RiskLevel::High)
            .map(|f| f.code.clone())
            .collect();
        state.plugins.audit().record(
            toolforge_plugins::AuditEvent::new(
                toolforge_plugins::audit::AuditEventKind::AiDraftRejected,
                format!(
                    "AI 草稿未通过安全审核（{} 项高危发现）",
                    codes.len()
                ),
            )
            .detail(serde_json::json!({
                "model": client.config().model,
                "provider": client.config().kind.describe(),
                "promptChars": gen_req.description.chars().count(),
                "findings": codes,
            })),
        );
    }

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
///
/// 有个容易写错的地方：输入**本身就是目录**时（`PortType::Directory` 的端口），
/// 根必须是那个目录**自身**，而不是它的父级。用父级的话，"选了一个目录"
/// 等于把手伸到了它外面一层 —— 授权范围白送一大圈。
fn build_io(
    inputs: &HashMap<String, Vec<String>>,
    output_dir: &std::path::Path,
    params: &HashMap<String, ParamValue>,
    declared_outputs: &[toolforge_core::plugin::IoPort],
) -> ToolforgeResult<(PathBuf, HashMap<String, String>)> {
    use toolforge_core::plugin::PortType;

    let mut input_root: Option<PathBuf> = None;
    for paths in inputs.values() {
        for p in paths {
            let path = PathBuf::from(p);
            let scope = if path.is_dir() {
                path.clone()
            } else {
                path.parent().map(|x| x.to_path_buf()).unwrap_or_default()
            };
            input_root = Some(match input_root {
                None => scope,
                Some(cur) => common_prefix(&cur, &scope),
            });
        }
    }

    let mut outputs = HashMap::new();
    let Some(src) = inputs.values().find_map(|v| v.first()) else {
        return Ok((
            input_root.unwrap_or_else(|| output_dir.to_path_buf()),
            outputs,
        ));
    };

    let stem = PathBuf::from(src)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "output".into());
    let original_ext = PathBuf::from(src)
        .extension()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "out".into());
    // `params.format` 优先：这是"转换类"插件的传统写法（`image-convert` 就靠它）
    let format_ext = params
        .get("format")
        .and_then(|v| v.as_str())
        .map(|s| s.trim_start_matches('.').to_string());

    // ---- 逐条为清单里声明的输出端口分配路径 ----
    //
    // # 这里此前只分配了 `dst`
    //
    // 原来只有一行 `outputs.insert("dst", <stem>.<ext>)`。后果是**任何声明了
    // 第二个输出端口的插件都是坏的**：`${output.frame}` 之类的模板变量根本
    // 解析不了，插件在第一步就报 `模板变量 ${output.frame} 无法解析`。
    // 内置的 `video-to-gif` 就是这么坏的 —— 它从写出来那天起就没跑通过，
    // 而单元测试、`cargo check`、插件列表全都显示"正常"。
    //
    // 命名规则（`ext` 的优先级：`params.format` → 端口 `accept` 里的扩展名 → 源扩展名）：
    //
    // | 端口 | 类型 | 文件名 |
    // |---|---|---|
    // | `dst` | file | `<主干>.<ext>` —— 与历史行为一致，不动 |
    // | 其它 | file | `<主干>.<端口id>.<ext>` —— 加上端口 id，避免多端口撞名 |
    // | `dst` | directory | `<主干>`（目录不带扩展名） |
    // | 其它 | directory | `<主干>.<端口id>` |
    for port in declared_outputs {
        // text / json / number… 不是路径，宿主不为它分配文件
        if !matches!(
            port.ty,
            PortType::File | PortType::Files | PortType::Directory | PortType::Any
        ) {
            continue;
        }
        let is_dir = port.ty == PortType::Directory;
        let declared_ext = port
            .accept
            .iter()
            .find_map(|a| a.strip_prefix('.').map(|s| s.to_string()))
            .or_else(|| {
                port.accept
                    .iter()
                    .find_map(|a| a.rsplit_once('/').map(|(_, e)| e.to_string()))
            });
        let ext = format_ext
            .clone()
            .filter(|_| port.id == "dst")
            .or(declared_ext)
            .unwrap_or_else(|| original_ext.clone());

        let name = match (is_dir, port.id.as_str()) {
            (true, "dst") => stem.clone(),
            (true, other) => format!("{stem}.{other}"),
            (false, "dst") => format!("{stem}.{ext}"),
            (false, other) => format!("{stem}.{other}.{ext}"),
        };
        outputs.insert(port.id.clone(), output_dir.join(name).display().to_string());
    }

    // 清单没声明任何文件类输出端口 → 保持历史行为，给一个 `dst`。
    // （大多数内置插件的 `io.outputs` 就是空的，靠 `${dst}` 走通。）
    if outputs.is_empty() {
        let name = format!("{stem}.{}", format_ext.unwrap_or(original_ext));
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
///
/// ⚠️ 这是**旧**的数组形态，只保留给"插件直接返回一个文件路径列表"的老写法。
/// 现在的完整约定见 [`interpret_plugin_response`]。
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

/// 解读 L2/L3 插件的返回值，产出"这个插件这次真的产出了什么"。
///
/// # 这个函数补的是一条真实存在的断链
///
/// L2/L3 的返回信封在文档里是这么写的：
///
/// ```json
/// { "outputs": { "swatch": "D:/out/色卡.png" }, "values": { "count": 5 } }
/// ```
///
/// 但在它存在之前，宿主只认 `outputs` 是**数组**的写法（[`extract_outputs`]）。
/// 对象形态于是被静默忽略，落到 `build_io` 算出来的那个输出路径上 ——
/// 而那个文件**从来没有人写过**。任务于是"成功"，产出列表里挂着一个不存在的文件：
/// 用户点开是空的、点"在文件夹里显示"会失败。这是最糟的一类缺陷
/// （静默地少干活，还报告成功），而它只在 L2/L3 上发生，L1 走的是另一条路。
///
/// 现在的规则：
///
/// 1. `{"error": "…"}` → 交给上层（其实 `wasm.rs` 已经先拦了一道）；
/// 2. `outputs` 是**对象** → 逐条对照清单里声明的输出端口：
///    * 端口类型是文件/目录 → 当成一个**路径**：必须真实存在，且必须在输出根之内。
///      越界 → `PERMISSION_DENIED` + 审计（插件不能凭空"宣称"产出了系统目录里的文件）；
///      不存在 → 记一条 **warning** 并**不**计入产出（宁可少报，也不能报一个假路径）；
///    * 其它类型（text / json / number / boolean）→ 当成**值**，写进任务日志（info）。
///      不写日志的话，一个"输出一段 JSON"的插件跑完，用户什么都看不到；
/// 3. `outputs` 是数组（老写法）→ 走 [`extract_outputs`]，并给一条建议改写法。
///
/// `values` 里的键值同样写到任务日志 —— 那是 `${steps.<id>.<键>}` 引用得到的东西，
/// 用户至少该看得见。
fn interpret_plugin_response(
    record: &toolforge_plugins::PluginRecord,
    value: &serde_json::Value,
    output_root: &std::path::Path,
    ctx: &toolforge_core::queue::JobCtx,
    fallback_outputs: &HashMap<String, String>,
) -> ToolforgeResult<Vec<String>> {
    use toolforge_core::plugin::PortType;

    // 端口 id -> 类型
    let ports: HashMap<&str, PortType> =
        record.manifest.io.outputs.iter().map(|p| (p.id.as_str(), p.ty)).collect();

    let mut produced: Vec<String> = Vec::new();

    let outputs_value = value.get("outputs");
    let mut saw_object_outputs = false;

    if let Some(map) = outputs_value.and_then(|o| o.as_object()) {
        saw_object_outputs = true;
        for (port_id, raw) in map {
            let Some(text) = raw.as_str() else {
                // 非字符串（数字/布尔/对象）当成值处理，不当路径
                ctx.info(format!("输出端口 `{port_id}`：{}", summarize(raw)));
                continue;
            };
            let is_file_port = matches!(
                ports.get(port_id.as_str()),
                Some(PortType::File | PortType::Files | PortType::Directory | PortType::Any) | None
            );

            if !is_file_port {
                ctx.info(format!("输出端口 `{port_id}`：{text}"));
                continue;
            }

            let p = std::path::Path::new(text);
            // 先做词法收敛再比较：`D:\out\..\..\Windows` 这类写法必须被认出来
            let norm = toolforge_core::permission::normalize_lexically(p);
            let rooted = toolforge_core::permission::normalize_lexically(output_root);
            if !norm.starts_with(&rooted) {
                return Err(ToolforgeError::denied(format!(
                    "插件声明的产出 `{text}` 不在输出目录之内"
                ))
                .with_subject(record.id())
                .with_detail(format!(
                    "输出目录：{}\n\
                     插件返回值里的路径必须落在这个目录里。宿主不会把一个插件\
                     「宣称」的任意路径当成产出 —— 那会让输出列表变成一份可被伪造的清单。",
                    output_root.display()
                )));
            }
            if !p.exists() {
                ctx.warn(format!(
                    "插件把 `{text}` 报成输出端口 `{port_id}` 的产出，但这个文件不存在，已忽略"
                ));
                continue;
            }
            produced.push(text.to_string());
        }
    }

    // `values` / `outputs` 里的**非路径**结果必须让用户看得见。
    // 否则"输出一段文本/JSON"的插件跑完，界面上什么都不显示。
    if let Some(values) = value.get("values").and_then(|v| v.as_object()) {
        for (k, v) in values {
            ctx.info(format!("插件结果 · {k} = {}", summarize(v)));
        }
    }

    if produced.is_empty() {
        if saw_object_outputs {
            // 对象形态但一个文件都没落地：**不要**回退到宿主算出来的路径 ——
            // 那个文件没人写过，报出去就是假产出。
            let declared: Vec<&str> = record
                .manifest
                .io
                .outputs
                .iter()
                .filter(|p| matches!(p.ty, PortType::File | PortType::Files | PortType::Directory))
                .map(|p| p.id.as_str())
                .collect();
            if !declared.is_empty() {
                ctx.warn(format!(
                    "插件返回的 outputs 里没有任何真实存在的文件（声明的文件类输出端口：{}）",
                    declared.join("、")
                ));
            }
        } else if let Some(arr) = outputs_value.and_then(|o| o.as_array()) {
            let _ = arr;
            produced = extract_outputs(value);
        }
    }

    if produced.is_empty() && outputs_value.is_none() {
        // 插件根本没提 outputs —— 老写法/自由写法。
        // 这里保留旧的兜底，但**只**在宿主算出来的那个路径确实存在时才报它。
        let existing: Vec<String> = fallback_outputs
            .values()
            .filter(|p| std::path::Path::new(p.as_str()).exists())
            .cloned()
            .collect();
        if existing.is_empty() && !fallback_outputs.is_empty() {
            ctx.warn(
                "插件没有返回 outputs，宿主也没有在输出目录里看到预期文件 —— \
                 请检查插件是否把产物写到了路径 `paths.output` 下",
            );
        }
        produced = existing;
    }

    Ok(produced)
}

/// 让 `Arc<AppState>` 能在命令签名里使用
pub type SharedState = Arc<AppState>;
