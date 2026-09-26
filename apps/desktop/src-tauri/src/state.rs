//! 应用全局状态。
//!
//! 这里持有的是**所有命令共享的、进程级唯一的**东西：任务队列、引擎注册表、
//! 插件仓库、运行时工厂、事件出口、设置。
//!
//! ## 一条纪律
//!
//! 状态里**不放业务逻辑**。它只是把各个 crate 组装起来，命令层负责编排。
//! 这样测试可以单独构造任意一个子系统，不需要把整个应用立起来。

use std::sync::Arc;

use parking_lot::RwLock;
use tokio::sync::broadcast;

use toolforge_ai::provider::{AiClient, AiProviderConfig, AiProviderKind};
use toolforge_core::events::AppEvent;
use toolforge_core::paths::AppPaths;
use toolforge_core::queue::JobQueue;
use toolforge_engines::EngineRegistry;
use toolforge_plugins::{AuditLog, PluginRunner, PluginStore};

use crate::ipc::{AiSettings, Settings};

pub struct AppState {
    pub paths: AppPaths,
    pub queue: Arc<JobQueue>,
    pub engines: Arc<EngineRegistry>,
    pub plugins: Arc<PluginStore>,
    pub runner: Arc<PluginRunner>,
    /// 事件出口：队列/引擎/插件都往这里发，EventBridge 转发到 WebView
    pub events: broadcast::Sender<AppEvent>,
    /// 用户设置（内存态；持久化由 store 插件负责）
    pub settings: RwLock<Settings>,
    /// AI 客户端。`None` 表示未配置。
    ///
    /// 用 `Arc` 包一层是为了让命令层能**克隆出句柄后在锁外 await** ——
    /// `AiClient` 持有一个 HTTP 连接池，长时间持读锁会让 `settings_patch` 饿死。
    pub ai: RwLock<Option<Arc<AiClient>>>,
    /// 设置是否已经加载过（避免重复盖掉用户刚改的值）
    pub settings_loaded: RwLock<bool>,
}

impl AppState {
    pub fn new(
        paths: AppPaths,
        events: broadcast::Sender<AppEvent>,
        builtin_plugins_dir: Option<std::path::PathBuf>,
    ) -> toolforge_core::ToolforgeResult<Arc<Self>> {
        paths.ensure_all().map_err(|e| {
            toolforge_core::ToolforgeError::io(format!(
                "无法创建数据目录 {}：{e}",
                paths.root().display()
            ))
        })?;

        let settings = Settings::default();
        let queue = Arc::new(JobQueue::new(settings.concurrency as usize, events.clone()));
        let engines = Arc::new(
            EngineRegistry::new(paths.clone()).with_events(events.clone()),
        );

        let audit = AuditLog::new(&paths);
        let plugins = Arc::new(PluginStore::new(
            paths.clone(),
            builtin_plugins_dir,
            events.clone(),
        ));
        let runner = Arc::new(PluginRunner::new(
            engines.clone(),
            paths.clone(),
            audit,
        ));

        Ok(Arc::new(Self {
            paths,
            queue,
            engines,
            plugins,
            runner,
            events,
            settings: RwLock::new(settings),
            ai: RwLock::new(None),
            settings_loaded: RwLock::new(false),
        }))
    }

    /// 按当前设置（重新）构造 AI 客户端。
    ///
    /// 失败时不返回错误，只把 `ai` 置为 `None` —— 因为"AI 没配好"不应该
    /// 阻止用户使用其它功能。
    pub fn rebuild_ai_client(&self) {
        let settings = self.settings.read().clone();
        let AiSettings {
            provider,
            base_url,
            model,
            temperature,
            ..
        } = settings.ai;
        let key = self.ai_api_key();

        let mut cfg = AiProviderConfig::new(provider);
        if !base_url.trim().is_empty() {
            cfg.base_url = base_url;
        }
        if !model.trim().is_empty() {
            cfg.model = model;
        }
        cfg.temperature = temperature;
        cfg.api_key = key;
        cfg.has_key = !cfg.api_key.trim().is_empty();

        match AiClient::new(cfg) {
            Ok(c) => *self.ai.write() = Some(Arc::new(c)),
            Err(e) => {
                tracing::info!("AI 客户端未就绪：{}", e.message);
                *self.ai.write() = None;
            }
        }
    }

    /// 读取 AI Key（内存侧）。
    ///
    /// v0.1 存在进程内存里，应用重启后需要重填。
    /// v0.2 会接 OS 钥匙串（Windows DPAPI / macOS Keychain）—— 见 ROADMAP。
    pub fn ai_api_key(&self) -> String {
        self.ai
            .read()
            .as_ref()
            .map(|c| c.config().api_key.clone())
            .unwrap_or_default()
    }

    /// 应用当前平台名
    pub fn platform() -> &'static str {
        if cfg!(target_os = "windows") {
            "windows"
        } else if cfg!(target_os = "macos") {
            "macos"
        } else {
            "linux"
        }
    }

    /// 默认 AI 提供方（设置里没写时的兜底）
    pub fn default_provider() -> AiProviderKind {
        AiProviderKind::OpenAi
    }
}
