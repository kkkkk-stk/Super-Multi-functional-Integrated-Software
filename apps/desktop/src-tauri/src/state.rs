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

use crate::ipc::Settings;
use crate::settings_store;

pub struct AppState {
    pub paths: AppPaths,
    pub queue: Arc<JobQueue>,
    pub engines: Arc<EngineRegistry>,
    pub plugins: Arc<PluginStore>,
    pub runner: Arc<PluginRunner>,
    /// 事件出口：队列/引擎/插件都往这里发，EventBridge 转发到 WebView
    pub events: broadcast::Sender<AppEvent>,
    /// 用户设置。启动时从 `<数据目录>/settings.json` 读入，
    /// 每次 `settings_patch` 都会原子写回。
    pub settings: RwLock<Settings>,
    /// AI 客户端。`None` 表示未配置。
    ///
    /// 用 `Arc` 包一层是为了让命令层能**克隆出句柄后在锁外 await** ——
    /// `AiClient` 持有一个 HTTP 连接池，长时间持读锁会让 `settings_patch` 饿死。
    pub ai: RwLock<Option<Arc<AiClient>>>,
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

        // 先把设置读出来，再据此建队列 —— 顺序反了的话，
        // 用户设置的并发度要等到"下一次改设置"才生效。
        let loaded = settings_store::load(&paths);
        if let Some(err) = &loaded.load_error {
            tracing::warn!("{err}");
        }
        let settings = loaded.settings;
        if loaded.from_disk {
            tracing::info!(
                theme = %settings.theme,
                concurrency = settings.concurrency,
                "已加载用户设置"
            );
        } else {
            tracing::info!("没有用户设置文件，使用默认值");
        }

        let queue = Arc::new(JobQueue::new(
            settings.concurrency.clamp(1, 64) as usize,
            events.clone(),
        ));
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

        let state = Arc::new(Self {
            paths,
            queue,
            engines,
            plugins,
            runner,
            events,
            settings: RwLock::new(settings),
            ai: RwLock::new(None),
        });

        // 恢复「记住的」API Key（默认没有这个文件）
        state.restore_persisted_api_key();
        Ok(state)
    }

    /// 把设置写回磁盘。失败**不返回错误给用户操作**，只记日志 ——
    /// 磁盘满/只读不该让"切换主题"这种操作在界面上报错，
    /// 但也不能完全静默：日志里必须留下痕迹。
    pub fn persist_settings(&self) {
        let snapshot = self.settings.read().clone();
        if let Err(e) = settings_store::save(&self.paths, &snapshot) {
            tracing::error!("保存设置失败：{}", e.message);
            return;
        }

        // Key 的落盘策略跟着 `persist_api_key` 走：
        // 关掉开关时**主动删掉**已经写下的那份，而不是留着不管。
        let key = self.ai_api_key();
        let want_persist = snapshot.ai.persist_api_key;
        let to_write = if want_persist && !key.trim().is_empty() {
            Some(key.as_str())
        } else {
            None
        };
        if let Err(e) = settings_store::save_api_key(&self.paths, to_write) {
            tracing::error!("保存 API Key 失败：{}", e.message);
        }
    }

    /// 启动时恢复落盘的 API Key。没有就什么都不做。
    fn restore_persisted_api_key(&self) {
        if !self.settings.read().ai.persist_api_key {
            // 开关是关的，那就确保磁盘上没有残留的密钥
            let _ = settings_store::save_api_key(&self.paths, None);
            return;
        }
        match settings_store::load_api_key(&self.paths) {
            Some(key) => {
                tracing::info!("已恢复记住的 API Key（{} 个字符）", key.len());
                self.set_api_key(Some(key));
            }
            None => tracing::info!("「记住 API Key」已打开，但磁盘上没有找到密钥"),
        }
    }

    /// 设置/清除 AI 的 Key（`None` 或空串 = 清除）。
    ///
    /// 只动内存与 `self.ai`，**不碰磁盘** —— 落盘由 [`Self::persist_settings`]
    /// 统一按 `ai.persist_api_key` 决定。
    ///
    /// 有一条容易写错的规则：**本地提供方（Ollama / LM Studio）不需要 Key**。
    /// 所以"没有 Key"只在远程提供方那里才等于"没有客户端"，
    /// 否则本地模型永远用不了。判定集中在这一个函数里。
    pub fn set_api_key(&self, key: Option<String>) {
        let key = key.unwrap_or_default().trim().to_string();
        let s = self.settings.read().clone();

        if key.is_empty() && !s.ai.provider.is_local() {
            *self.ai.write() = None;
            return;
        }

        let mut cfg = AiProviderConfig::new(s.ai.provider);
        if !s.ai.base_url.trim().is_empty() {
            cfg.base_url = s.ai.base_url.clone();
        }
        if !s.ai.model.trim().is_empty() {
            cfg.model = s.ai.model.clone();
        }
        cfg.temperature = s.ai.temperature;
        cfg.api_key = key;
        cfg.has_key = !cfg.api_key.trim().is_empty();
        match AiClient::new(cfg) {
            Ok(c) => *self.ai.write() = Some(Arc::new(c)),
            Err(e) => {
                tracing::warn!("AI 客户端无法建立：{}", e.message);
                *self.ai.write() = None;
            }
        }
    }

    /// 按当前设置（重新）构造 AI 客户端 —— 保留已有的 Key。
    ///
    /// 改提供方 / base_url / 模型 / 温度时必须走这里：`AiClient` 在构造时就把
    /// 配置固化进连接池了，只改 `settings` 而不重建客户端，等于设置无效。
    pub fn rebuild_ai_client(&self) {
        let key = self.ai_api_key();
        self.set_api_key(if key.trim().is_empty() { None } else { Some(key) });
    }

    /// 读取 AI Key（内存侧；可能来自启动时恢复的落盘 Key）。
    ///
    /// 目前存在进程内存 + （可选的）`<数据目录>/ai-key.txt` 明文文件。
    /// OS 钥匙串（Windows DPAPI / macOS Keychain）仍未接 —— 见 ROADMAP。
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
