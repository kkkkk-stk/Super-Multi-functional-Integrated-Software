//! 插件仓库：装载、安装、授权、状态持久化。
//!
//! ## 状态放在哪
//!
//! 每个插件目录下一个 `.toolforge-state.json`，记录**启用状态**与**用户已授权的
//! 能力集合**。放在插件目录里（而不是全局 config）是有意的：删掉插件目录就等于
//! 彻底清理，不会在别处留下"孤儿授权"。而 `.toolforge-state.json` 本身不参与
//! [`super::audit::content_hash`]，否则授权一次哈希就变了。
//!
//! ## Bundle 落盘的安全检查
//!
//! AI 生成的插件是一个 [`PluginSource::Bundle`]，里面带一串文件路径。
//! **这是唯一一个"外部数据决定磁盘写入位置"的地方**，所以检查必须做全：
//!
//! 1. 路径必须相对，且规范化后仍在插件目录内（挡 `../../`）
//! 2. 拒绝 Windows 保留名与盘符前缀
//! 3. 单文件与总量都有上限（挡"用 200MB 的 main.py 把磁盘写满"）
//! 4. 已存在的插件目录默认**不覆盖**，除非显式要求升级

use std::path::{Path, PathBuf};
use std::sync::Arc;

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use specta::Type;

use toolforge_core::error::{ErrorCode, ToolforgeError, ToolforgeResult};
use toolforge_core::events::AppEvent;
use toolforge_core::paths::AppPaths;
use toolforge_core::permission::PermissionSet;
use toolforge_core::plugin::{
    BundleFile, FileEncoding, PluginDetail, PluginManifest, PluginSource, PluginSummary,
    ValidationReport,
};

use crate::audit::{content_hash, record_escalation, AuditEvent, AuditEventKind, AuditLog};

/// 单个 Bundle 文件的大小上限（1 MB）。插件脚本不该有这么大。
const MAX_BUNDLE_FILE_BYTES: usize = 1024 * 1024;
/// 整个 Bundle 的上限（8 MB）。
const MAX_BUNDLE_TOTAL_BYTES: usize = 8 * 1024 * 1024;

/// 持久化到 `<plugin_dir>/.toolforge-state.json` 的状态。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginState {
    #[serde(default)]
    pub enabled: bool,
    /// 用户实际授予的能力。**空集 = 插件跑不动任何东西**，这是安全的默认值。
    #[serde(default)]
    pub granted: PermissionSet,
    /// 安装时的内容哈希
    #[serde(default)]
    pub installed_hash: Option<String>,
    #[serde(default)]
    pub installed_at: Option<String>,
    /// 用户审核并通过的版本号（用于判断"升级后是否需要重新确认"）
    #[serde(default)]
    pub approved_version: Option<String>,
}

/// 内存里的插件记录。
#[derive(Debug, Clone)]
pub struct PluginRecord {
    pub manifest: PluginManifest,
    pub dir: PathBuf,
    pub builtin: bool,
    pub state: PluginState,
    pub validation: ValidationReport,
    /// 磁盘上的原始 YAML（详情页展示用）
    pub raw_yaml: String,
}

impl PluginRecord {
    pub fn id(&self) -> &str {
        &self.manifest.metadata.id
    }

    /// 生效权限 = 声明 ∩ 已授权
    pub fn effective(&self) -> PermissionSet {
        PermissionSet::effective(&self.manifest.permissions, &self.state.granted)
    }

    pub fn summary(&self) -> PluginSummary {
        let mut s = PluginSummary::from_manifest(
            &self.manifest,
            &self.state.granted,
            self.builtin,
            Some(self.dir.display().to_string()),
        );
        s.enabled = self.state.enabled;
        s
    }
}

/// 安装结果（前端用来展示"校验报告 + 权限清单 + 哈希"三重确认页）
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct InstallReport {
    pub summary: PluginSummary,
    pub validation: ValidationReport,
    /// 内容哈希（`sha256:...`），展示在确认页上
    pub content_hash: String,
    /// 与已装旧版本相比**新增**的能力声明 —— 非空意味着必须重新人工确认
    pub added_capabilities: Vec<String>,
    /// 与已装旧版本相比移除的能力
    pub removed_capabilities: Vec<String>,
    /// 落盘位置
    pub install_path: String,
}

/// 插件仓库。
pub struct PluginStore {
    paths: AppPaths,
    records: DashMap<String, PluginRecord>,
    audit: AuditLog,
    tx: tokio::sync::broadcast::Sender<AppEvent>,
    /// 内置插件目录（只读，随应用分发）
    builtin_dir: Option<PathBuf>,
}

impl PluginStore {
    pub fn new(
        paths: AppPaths,
        builtin_dir: Option<PathBuf>,
        tx: tokio::sync::broadcast::Sender<AppEvent>,
    ) -> Self {
        Self {
            audit: AuditLog::new(&paths),
            paths,
            records: DashMap::new(),
            tx,
            builtin_dir,
        }
    }

    pub fn audit(&self) -> &AuditLog {
        &self.audit
    }

    pub fn paths(&self) -> &AppPaths {
        &self.paths
    }

    /// 扫描并装载全部插件。**在应用启动时调用**。
    ///
    /// 单个插件失败不影响其它插件（收集错误继续走）—— 一个坏插件不该让整个
    /// 应用起不来。
    pub fn reload(&self) -> ToolforgeResult<ReloadReport> {
        self.records.clear();
        let mut loaded = 0usize;
        let mut failed = Vec::new();

        let mut roots: Vec<(PathBuf, bool)> = Vec::new();
        if let Some(b) = &self.builtin_dir {
            if b.is_dir() {
                roots.push((b.clone(), true));
            }
        }
        let user_dir = self.paths.plugins();
        if user_dir.is_dir() {
            roots.push((user_dir, false));
        }

        for (root, builtin) in roots {
            let Ok(rd) = std::fs::read_dir(&root) else {
                continue;
            };
            for entry in rd.flatten() {
                let dir = entry.path();
                if !dir.is_dir() {
                    continue;
                }
                match self.load_one(&dir, builtin) {
                    Ok(Some(rec)) => {
                        // 内置插件被用户覆盖时，用户目录的那份优先
                        let id = rec.id().to_string();
                        if self.records.contains_key(&id) && builtin {
                            continue;
                        }
                        self.records.insert(id, rec);
                        loaded += 1;
                    }
                    Ok(None) => {} // 目录里没有 plugin.yaml，跳过
                    Err(e) => failed.push((dir.display().to_string(), e.to_string())),
                }
            }
        }

        let _ = self.tx.send(AppEvent::PluginChanged {
            plugin_id: "*".into(),
        });

        Ok(ReloadReport { loaded, failed })
    }

    fn load_one(&self, dir: &Path, builtin: bool) -> ToolforgeResult<Option<PluginRecord>> {
        let yaml_path = dir.join("plugin.yaml");
        if !yaml_path.is_file() {
            return Ok(None);
        }
        let raw_yaml = std::fs::read_to_string(&yaml_path)
            .map_err(|e| ToolforgeError::io(format!("读取 {} 失败：{e}", yaml_path.display())))?;
        let manifest = PluginManifest::from_yaml(&raw_yaml)?;
        let validation = manifest.validate();

        let state = self.load_state(dir, builtin);

        Ok(Some(PluginRecord {
            manifest,
            dir: dir.to_path_buf(),
            builtin,
            state,
            validation,
            raw_yaml,
        }))
    }

    fn state_path(dir: &Path) -> PathBuf {
        dir.join(".toolforge-state.json")
    }

    fn load_state(&self, dir: &Path, builtin: bool) -> PluginState {
        let p = Self::state_path(dir);
        if let Ok(text) = std::fs::read_to_string(&p) {
            if let Ok(s) = serde_json::from_str::<PluginState>(&text) {
                return s;
            }
        }
        // 内置插件默认启用，且**默认授予其声明的全部能力** ——
        // 因为这些清单是我们自己写的、随包分发的。用户插件默认既禁用也不授权。
        if builtin {
            let yaml_path = dir.join("plugin.yaml");
            let granted = std::fs::read_to_string(&yaml_path)
                .ok()
                .and_then(|t| PluginManifest::from_yaml(&t).ok())
                .map(|m| m.permissions.clone())
                .unwrap_or_default();
            PluginState {
                enabled: true,
                granted,
                approved_version: None,
                installed_hash: None,
                installed_at: None,
            }
        } else {
            PluginState::default()
        }
    }

    fn save_state(&self, dir: &Path, state: &PluginState) -> ToolforgeResult<()> {
        let p = Self::state_path(dir);
        let text = serde_json::to_string_pretty(state)
            .map_err(|e| ToolforgeError::internal(format!("状态序列化失败：{e}")))?;
        std::fs::write(&p, text)
            .map_err(|e| ToolforgeError::io(format!("写入 {} 失败：{e}", p.display())))
    }

    // ---------------- 查询 ----------------

    pub fn list(&self) -> Vec<PluginSummary> {
        let mut v: Vec<PluginSummary> = self.records.iter().map(|r| r.summary()).collect();
        v.sort_by(|a, b| {
            // 有未授权项的排前面（用户需要处理），然后按分类、名称
            b.has_pending_permissions
                .cmp(&a.has_pending_permissions)
                .then_with(|| a.name.cmp(&b.name))
        });
        v
    }

    pub fn get(&self, id: &str) -> Option<PluginDetail> {
        let rec = self.records.get(id)?;
        let files = walkdir::WalkDir::new(&rec.dir)
            .max_depth(3)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .filter_map(|e| {
                e.path()
                    .strip_prefix(&rec.dir)
                    .ok()
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
            })
            .filter(|p| !p.starts_with(".venv/") && !p.starts_with(".data/"))
            .take(200)
            .collect();

        let readme = ["README.md", "readme.md", "README.txt"]
            .iter()
            .map(|n| rec.dir.join(n))
            .find(|p| p.is_file())
            .and_then(|p| std::fs::read_to_string(p).ok());

        Some(PluginDetail {
            summary: rec.summary(),
            manifest: rec.manifest.clone(),
            raw_yaml: rec.raw_yaml.clone(),
            granted: rec.state.granted.clone(),
            files,
            readme,
            runtime_status: None,
        })
    }

    /// 取记录（运行时执行需要）
    pub fn record(&self, id: &str) -> Option<PluginRecord> {
        self.records.get(id).map(|r| r.clone())
    }

    /// 清单里声明了、但用户还没授权的能力（人类可读描述）。
    ///
    /// **这是提示，不是阻塞**。见 [`PluginStore::set_enabled`] 里那段说明：
    /// 部分授权是允许的，缺的能力在**运行期**被拦下来并记审计。
    /// 这个方法只服务于"运行前先告诉用户一句"。
    pub fn ungranted_declared(&self, id: &str) -> Vec<String> {
        let Some(rec) = self.records.get(id) else {
            return Vec::new();
        };
        rec.manifest
            .permissions
            .capabilities
            .iter()
            .filter(|c| {
                !rec
                    .state
                    .granted
                    .capabilities
                    .iter()
                    .any(|g| g.fingerprint() == c.fingerprint())
            })
            .map(|c| c.describe())
            .collect()
    }

    /// 判断插件当前**能否真正执行**。
    ///
    /// 一次报出**全部**阻塞原因，而不是撞到第一个就返回 —— 用户需要一次就知道
    /// "它被禁用了，而且清单校验还没过"，而不是修一个再发现下一个。
    ///
    /// ⚠️ **"还有 N 项能力未授权"不再是阻塞**（2026-09 改）。
    /// 原来它是阻塞项，理由是"没授权就跑，运行时必然越权"。但那条推理有个漏洞：
    /// 运行期的能力裁决本来就会拒绝未授权的动作，所以真正需要的不是"提前拦住
    /// 整个插件"，而是"拦住那一个动作"。把它当阻塞项带来两个更糟的后果：
    ///
    /// 1. **授权面板上的承诺变成了空话**：面板写着"没勾的能力，插件在运行时
    ///    一旦尝试使用就会被拦截"，而实际上你根本没机会让它跑起来；
    /// 2. **逼出习惯性全选**：一个插件只要有一项你不想要的权限（比如它申请了
    ///    任意主机的 `net`，而你只想用它做本地文件处理），你就只能整包放弃。
    ///    这恰好是"最小授权"最想避免的行为。
    ///
    /// 现在缺哪些能力由 [`PluginStore::ungranted_declared`] 报给用户，
    /// 真正的拒绝发生在动作那一刻（`CapabilityGuard` / Extism 主机白名单）。
    pub fn runnable(&self, id: &str) -> ToolforgeResult<PluginRecord> {
        let rec = self
            .records
            .get(id)
            .map(|r| r.clone())
            .ok_or_else(|| ToolforgeError::not_found(format!("插件 {id} 未安装")))?;

        let mut blockers: Vec<String> = Vec::new();

        if !rec.validation.ok {
            blockers.push(format!(
                "清单校验未通过（{} 项错误）",
                rec.validation.error_count()
            ));
        }
        if !rec.state.enabled {
            blockers.push("插件已被禁用（在插件详情页点「启用」）".to_string());
        }

        if blockers.is_empty() {
            return Ok(rec);
        }

        // 校验错误是"插件本身坏了"，与权限问题分开报，前端才能给不同的引导
        let code = if !rec.validation.ok {
            ErrorCode::PluginInvalid
        } else {
            ErrorCode::PermissionDenied
        };

        let mut detail: Vec<String> = blockers.iter().map(|b| format!("· {b}")).collect();
        if !rec.validation.ok {
            detail.push(String::new());
            detail.push("校验问题：".to_string());
            detail.extend(
                rec.validation
                    .issues
                    .iter()
                    .filter(|i| i.severity == toolforge_core::plugin::Severity::Error)
                    .map(|i| format!("  - [{}] {}", i.code, i.message)),
            );
        }

        Err(ToolforgeError::new(
            code,
            format!("插件 `{id}` 当前无法运行（{} 项阻塞）", blockers.len()),
        )
        .with_subject(id)
        .with_detail(detail.join("\n")))
    }

    // ---------------- 变更 ----------------

    /// 启用 / 禁用插件。
    ///
    /// # ⚠️ 这里**曾经**要求"清单声明的每一项都已授权"（`runnable_or_grant_all`）
    ///
    /// 那条门在 2026-09 被去掉了，理由是它把安全模型里"声明 ∩ 授权"的交集
    /// 变成了一个**恒等式**：
    ///
    /// ```text
    /// 启用要求：已授权 ⊇ 声明
    /// set_granted 又只接受声明里有的（多余的丢弃）⇒ 已授权 ⊆ 声明
    /// ⇒ 已授权 == 声明 ⇒ 运行期的"交集"永远是声明本身
    /// ```
    ///
    /// 也就是说：`PermissionSet::effective()`、`allowed_hosts_from()`、
    /// `CapabilityGuard` 里那套"少一个都不给"的逻辑，在真实链路上从来没有
    /// 被走到过 —— 因为任何"给少了"的状态都不允许启用。它是**装饰**，
    /// 而装饰会让人相信一件没发生的事。
    ///
    /// 更实际的代价是逼出**习惯性全选**：插件只要申请了一项你不想要的权限
    /// （最典型的是"任意主机 net"），你就只能整包放弃它。这与"最小授权"背道而驰。
    ///
    /// 现在的模型是一条直线，没有中间门：
    ///
    /// * **装**：校验 + 内容哈希落盘；
    /// * **启用**：你说了算（一个都不授权也能启用）；
    /// * **用**：那一刻如果碰了没授权的动作 → 拒绝 + 记审计。
    ///
    /// 「不提供一键全部允许」这条设计**没有变**：面板仍然默认全不勾、仍然没有全选按钮，
    /// 变的只是"少勾几项"不再等于"这个插件永远用不了"。
    pub fn set_enabled(&self, id: &str, enabled: bool) -> ToolforgeResult<PluginSummary> {
        let (dir, mut state) = {
            let rec = self
                .records
                .get(id)
                .ok_or_else(|| ToolforgeError::not_found(format!("插件 {id} 未安装")))?;
            (rec.dir.clone(), rec.state.clone())
        };
        state.enabled = enabled;
        self.save_state(&dir, &state)?;

        if let Some(mut r) = self.records.get_mut(id) {
            r.state = state;
        }
        let _ = self.tx.send(AppEvent::PluginChanged {
            plugin_id: id.to_string(),
        });
        Ok(self.records.get(id).unwrap().summary())
    }

    /// 更新授权集合。
    ///
    /// `granted` 里出现**清单没声明**的能力会被丢弃（并记审计）——
    /// 防止前端被篡改后给插件开出清单外的权限。
    pub fn set_granted(&self, id: &str, granted: PermissionSet) -> ToolforgeResult<PluginSummary> {
        let (dir, declared, before) = {
            let rec = self
                .records
                .get(id)
                .ok_or_else(|| ToolforgeError::not_found(format!("插件 {id} 未安装")))?;
            (
                rec.dir.clone(),
                rec.manifest.permissions.clone(),
                rec.state.granted.clone(),
            )
        };

        let mut accepted: Vec<_> = Vec::new();
        let mut rejected: Vec<String> = Vec::new();
        for c in &granted.capabilities {
            if declared
                .capabilities
                .iter()
                .any(|d| d.fingerprint() == c.fingerprint())
            {
                accepted.push(c.clone());
            } else {
                rejected.push(c.describe());
            }
        }
        if !rejected.is_empty() {
            self.audit.record(
                AuditEvent::new(
                    AuditEventKind::CapabilityViolation,
                    format!("请求授予 {} 项清单未声明的能力，已丢弃", rejected.len()),
                )
                .subject(id)
                .detail(serde_json::json!({ "rejected": rejected })),
            );
        }

        let mut state = self.records.get(id).unwrap().state.clone();
        state.granted = PermissionSet::from_iter_caps(accepted);

        // 审计：新增/移除的能力
        let added: Vec<String> = state
            .granted
            .capabilities
            .iter()
            .filter(|c| {
                !before
                    .capabilities
                    .iter()
                    .any(|b| b.fingerprint() == c.fingerprint())
            })
            .map(|c| c.describe())
            .collect();
        if !added.is_empty() {
            self.audit.record(
                AuditEvent::new(
                    AuditEventKind::PermissionGranted,
                    format!("用户授予 {} 项能力", added.len()),
                )
                .subject(id)
                .detail(serde_json::json!({ "granted": added })),
            );
        }

        // 收回能力同样要记。审计日志如果只记"给了什么"，就回答不了
        // "我什么时候把某个插件的网络权限关掉的" —— 而那正是排查
        // "它为什么突然不能联网了"时第一个要问的问题。
        let removed: Vec<String> = before
            .capabilities
            .iter()
            .filter(|b| {
                !state
                    .granted
                    .capabilities
                    .iter()
                    .any(|c| c.fingerprint() == b.fingerprint())
            })
            .map(|c| c.describe())
            .collect();
        if !removed.is_empty() {
            self.audit.record(
                AuditEvent::new(
                    AuditEventKind::PermissionRevoked,
                    format!("用户收回 {} 项能力", removed.len()),
                )
                .subject(id)
                .detail(serde_json::json!({ "revoked": removed })),
            );
        }

        self.save_state(&dir, &state)?;
        if let Some(mut r) = self.records.get_mut(id) {
            r.state = state;
        }
        let _ = self.tx.send(AppEvent::PluginChanged {
            plugin_id: id.to_string(),
        });
        Ok(self.records.get(id).unwrap().summary())
    }

    /// 安装插件。
    ///
    /// **注意**：安装后插件处于 `enabled = false`、`granted = 空` 的状态。
    /// 必须由用户显式授权 + 启用，这是整个安全模型的地基。
    pub fn install(&self, source: PluginSource, overwrite: bool) -> ToolforgeResult<InstallReport> {
        let (yaml, files, from_bundle) = match source {
            PluginSource::Directory { path } => {
                let p = PathBuf::from(&path);
                if !p.is_dir() {
                    return Err(ToolforgeError::invalid(format!("目录不存在：{path}")));
                }
                let yaml_path = p.join("plugin.yaml");
                if !yaml_path.is_file() {
                    return Err(ToolforgeError::invalid(format!(
                        "{path} 下没有 plugin.yaml"
                    )));
                }
                let yaml = std::fs::read_to_string(&yaml_path)?;
                // 目录安装直接整体拷贝
                let manifest = PluginManifest::from_yaml(&yaml)?;
                let dir = self.paths.plugin_dir(&manifest.metadata.id);
                if dir.exists() && !overwrite {
                    return Err(ToolforgeError::invalid(format!(
                        "插件 `{}` 已存在。升级请显式确认覆盖。",
                        manifest.metadata.id
                    )));
                }
                copy_dir_contents(&p, &dir)?;
                return self.finish_install(&dir, &manifest, yaml, Vec::new());
            }
            PluginSource::Manifest { yaml } => (yaml, Vec::new(), false),
            PluginSource::Bundle { yaml, files } => (yaml, files, true),
        };

        let manifest = PluginManifest::from_yaml(&yaml)?;
        let validation = manifest.validate();
        validation.clone().into_result()?;

        let dir = self.paths.plugin_dir(&manifest.metadata.id);
        if dir.exists() && !overwrite {
            return Err(ToolforgeError::invalid(format!(
                "插件 `{}` 已存在。升级请显式确认覆盖。",
                manifest.metadata.id
            )));
        }

        // L2/L3 必须有产物，否则装上了也跑不动
        if manifest.runtime.requires_artifact() {
            let has_artifact = files.iter().any(|f| match &manifest.runtime {
                toolforge_core::plugin::PluginRuntime::Wasm { wasm } => f.path == wasm.path,
                toolforge_core::plugin::PluginRuntime::Python { python } => {
                    f.path == python.entry
                }
                _ => false,
            });
            if !has_artifact {
                return Err(ToolforgeError::plugin_invalid(
                    "插件声明了 WASM/Python 运行时，但安装内容里没有对应的入口文件",
                )
                .with_detail(match &manifest.runtime {
                    toolforge_core::plugin::PluginRuntime::Wasm { wasm } => {
                        format!("缺少：{}", wasm.path)
                    }
                    toolforge_core::plugin::PluginRuntime::Python { python } => {
                        format!("缺少：{}", python.entry)
                    }
                    _ => String::new(),
                }));
            }
        }

        // ---- 先把所有文件在内存里解码 + 校验完，再碰磁盘 ----
        //
        // 这是刻意的顺序："先校验后写入"。如果边校验边写，一个恶意 Bundle 就能
        // 在触发拒绝之前留下半个插件目录（单元测试
        // `install_rejects_traversal_in_bundle` 就是冲着这个来的）。
        let mut payload: Vec<(PathBuf, Vec<u8>)> = Vec::new();
        if from_bundle {
            let mut total = 0usize;
            for f in &files {
                let rel = safe_relative_path(&f.path)?;
                let bytes = decode_bundle_file(f)?;
                total += bytes.len();
                if total > MAX_BUNDLE_TOTAL_BYTES {
                    return Err(ToolforgeError::invalid(format!(
                        "插件包总体积超过 {} MB 上限，已中止（未写入任何文件）",
                        MAX_BUNDLE_TOTAL_BYTES / 1024 / 1024
                    )));
                }
                payload.push((rel, bytes));
            }
        }

        // ---- 校验全部通过，现在才动磁盘 ----
        if dir.exists() {
            std::fs::remove_dir_all(&dir)
                .map_err(|e| ToolforgeError::io(format!("清理旧版本失败：{e}")))?;
        }
        std::fs::create_dir_all(&dir)
            .map_err(|e| ToolforgeError::io(format!("创建插件目录失败：{e}")))?;

        let mut written: Vec<String> = Vec::new();
        for (rel, bytes) in &payload {
            let target = dir.join(rel);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| ToolforgeError::io(format!("创建子目录失败：{e}")))?;
            }
            std::fs::write(&target, bytes)
                .map_err(|e| ToolforgeError::io(format!("写入 {} 失败：{e}", rel.display())))?;
            written.push(rel.to_string_lossy().replace('\\', "/"));
        }

        std::fs::write(dir.join("plugin.yaml"), &yaml)
            .map_err(|e| ToolforgeError::io(format!("写入 plugin.yaml 失败：{e}")))?;
        written.push("plugin.yaml".into());

        self.finish_install(&dir, &manifest, yaml, written)
    }

    fn finish_install(
        &self,
        dir: &Path,
        manifest: &PluginManifest,
        yaml: String,
        written: Vec<String>,
    ) -> ToolforgeResult<InstallReport> {
        let id = manifest.metadata.id.clone();
        let validation = manifest.validate();
        let hash = content_hash(dir)?;

        // 权限差异检测：与已装旧版本比，新版本是否扩权了
        let previous = self
            .records
            .get(&id)
            .map(|r| (r.manifest.permissions.clone(), r.manifest.metadata.version.clone()));

        let (added, removed) = match &previous {
            Some((old_caps, _)) => diff_capabilities(old_caps, &manifest.permissions),
            None => (
                manifest
                    .permissions
                    .capabilities
                    .iter()
                    .map(|c| c.describe())
                    .collect::<Vec<_>>(),
                vec![],
            ),
        };

        if let (Some((_, from_version)), false) = (&previous, added.is_empty()) {
            record_escalation(
                &self.audit,
                &id,
                &added,
                from_version,
                &manifest.metadata.version,
            );
        }

        // 安装完成后一律禁用 + 不授权
        let state = PluginState {
            enabled: false,
            granted: PermissionSet::empty(),
            installed_hash: Some(hash.clone()),
            installed_at: Some(toolforge_core::job::now_iso()),
            approved_version: None,
        };
        self.save_state(dir, &state)?;

        let record = PluginRecord {
            manifest: manifest.clone(),
            dir: dir.to_path_buf(),
            builtin: false,
            state,
            validation: validation.clone(),
            raw_yaml: yaml,
        };
        let summary = record.summary();
        self.records.insert(id.clone(), record);

        self.audit.record(
            AuditEvent::new(
                AuditEventKind::Installed,
                format!(
                    "安装插件 {} v{}（{} 个文件，哈希 {}）",
                    manifest.metadata.name,
                    manifest.metadata.version,
                    written.len(),
                    hash
                ),
            )
            .subject(&id)
            .detail(serde_json::json!({
                "files": written,
                "hash": hash,
                "runtime": format!("{:?}", manifest.runtime.kind()),
                "aiGenerated": manifest.ai.as_ref().map(|a| a.generated).unwrap_or(false),
            })),
        );

        // AI 生成的插件被安装 = 用户明确接受了这次生成结果。
        // 记一条独立事件，这样"AI 到底产出了多少东西并被我装上了"是可查的 ——
        // 只看 `Installed` 事件的话，AI 生成的与手写的混在一起分不出来。
        let ai_generated = manifest.ai.as_ref().map(|a| a.generated).unwrap_or(false);
        if ai_generated {
            self.audit.record(
                AuditEvent::new(
                    AuditEventKind::AiDraftAccepted,
                    format!(
                        "安装 AI 生成的插件 {} v{}（用户已确认权限清单）",
                        manifest.metadata.name, manifest.metadata.version
                    ),
                )
                .subject(&id)
                .detail(serde_json::json!({
                    "model": manifest.ai.as_ref().and_then(|a| a.model.clone()),
                    "runtime": format!("{:?}", manifest.runtime.kind()),
                    "hash": hash,
                })),
            );
        }

        let _ = self.tx.send(AppEvent::PluginChanged {
            plugin_id: id.clone(),
        });

        Ok(InstallReport {
            summary,
            validation,
            content_hash: hash,
            added_capabilities: added,
            removed_capabilities: removed,
            install_path: dir.display().to_string(),
        })
    }

    pub fn uninstall(&self, id: &str) -> ToolforgeResult<()> {
        let dir = {
            let rec = self
                .records
                .get(id)
                .ok_or_else(|| ToolforgeError::not_found(format!("插件 {id} 未安装")))?;
            if rec.builtin {
                return Err(ToolforgeError::denied("内置插件不能卸载，只能禁用"));
            }
            rec.dir.clone()
        };
        std::fs::remove_dir_all(&dir)
            .map_err(|e| ToolforgeError::io(format!("删除插件目录失败：{e}")))?;
        self.records.remove(id);
        self.audit.record(
            AuditEvent::new(AuditEventKind::Uninstalled, "卸载插件").subject(id),
        );
        let _ = self.tx.send(AppEvent::PluginChanged {
            plugin_id: id.to_string(),
        });
        Ok(())
    }

    /// 校验装载时的哈希是否与安装时一致。
    ///
    /// 不一致 = 插件目录在安装之后被外部改动过。这种情况**必须报警**：
    /// 可能是用户自己改的（无害），也可能是别的程序动的手（危险）。
    pub fn verify_integrity(&self, id: &str) -> ToolforgeResult<bool> {
        let rec = self
            .records
            .get(id)
            .ok_or_else(|| ToolforgeError::not_found(format!("插件 {id} 未安装")))?;
        let Some(expected) = rec.state.installed_hash.clone() else {
            return Ok(true); // 内置插件没有记录哈希
        };
        let actual = content_hash(&rec.dir)?;
        Ok(actual == expected)
    }

    /// 哈希校验失败时的处理：报警 + 禁用
    pub fn quarantine_if_changed(&self, id: &str) -> ToolforgeResult<()> {
        if self.verify_integrity(id)? {
            return Ok(());
        }
        let rec = self.records.get(id).unwrap();
        let expected = rec.state.installed_hash.clone().unwrap_or_default();
        let dir = rec.dir.clone();
        drop(rec);

        let actual = content_hash(&dir).unwrap_or_default();
        crate::audit::record_integrity(&self.audit, id, &expected, &actual);

        let mut state = self.records.get(id).unwrap().state.clone();
        state.enabled = false;
        self.save_state(&dir, &state)?;
        if let Some(mut r) = self.records.get_mut(id) {
            r.state = state.clone();
        }

        let _ = self.tx.send(AppEvent::security(
            "critical",
            format!("插件 `{id}` 的内容哈希与安装时不一致"),
            "已自动禁用。如果这不是你自己改的，请卸载后重新安装。",
            Some(id.to_string()),
        ));

        Err(ToolforgeError::new(
            ErrorCode::IntegrityCheckFailed,
            format!("插件 `{id}` 内容已被改动，装载被拒绝"),
        )
        .with_detail(format!("期望：{expected}\n实际：{actual}")))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReloadReport {
    pub loaded: usize,
    /// (目录, 错误描述) —— 单个插件坏了不影响其它插件
    pub failed: Vec<(String, String)>,
}

// ============================================================================
// 辅助
// ============================================================================

/// 规范化并校验 Bundle 里的相对路径。
fn safe_relative_path(raw: &str) -> ToolforgeResult<PathBuf> {
    let p = Path::new(raw);
    if p.is_absolute() {
        return Err(ToolforgeError::denied(format!(
            "插件包里的路径必须是相对路径：{raw}"
        )));
    }
    // Windows 盘符前缀（`C:foo`）也是绝对的，is_absolute 在某些情况下漏掉
    if raw.len() >= 2 && raw.as_bytes()[1] == b':' {
        return Err(ToolforgeError::denied(format!(
            "插件包里的路径不能带盘符：{raw}"
        )));
    }
    let norm = toolforge_core::permission::normalize_lexically(p);
    let mut comps = norm.components();
    match comps.next() {
        Some(std::path::Component::Normal(_)) => {}
        _ => {
            return Err(ToolforgeError::denied(format!(
                "插件包里的路径非法（含 `..` 或为空）：{raw}"
            )))
        }
    }
    if norm
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(ToolforgeError::denied(format!(
            "插件包里的路径包含目录穿越：{raw}"
        )));
    }
    // Windows 保留设备名
    #[cfg(windows)]
    {
        const RESERVED: &[&str] = &[
            "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "LPT1", "LPT2", "LPT3",
        ];
        for c in norm.components() {
            if let std::path::Component::Normal(s) = c {
                let stem = s
                    .to_string_lossy()
                    .split('.')
                    .next()
                    .unwrap_or("")
                    .to_ascii_uppercase();
                if RESERVED.contains(&stem.as_str()) {
                    return Err(ToolforgeError::denied(format!(
                        "插件包使用了 Windows 保留设备名：{raw}"
                    )));
                }
            }
        }
    }
    Ok(norm)
}

fn decode_bundle_file(f: &BundleFile) -> ToolforgeResult<Vec<u8>> {
    let bytes = match f.encoding {
        FileEncoding::Utf8 => f.content.as_bytes().to_vec(),
        FileEncoding::Base64 => {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD
                .decode(f.content.trim())
                .map_err(|e| {
                    ToolforgeError::invalid(format!("`{}` 的 base64 内容解码失败：{e}", f.path))
                })?
        }
    };
    if bytes.len() > MAX_BUNDLE_FILE_BYTES {
        return Err(ToolforgeError::invalid(format!(
            "插件包里的 `{}` 超过 {} KB 上限",
            f.path,
            MAX_BUNDLE_FILE_BYTES / 1024
        )));
    }
    Ok(bytes)
}

fn copy_dir_contents(from: &Path, to: &Path) -> ToolforgeResult<()> {
    std::fs::create_dir_all(to)
        .map_err(|e| ToolforgeError::io(format!("创建目录失败：{e}")))?;
    for entry in walkdir::WalkDir::new(from)
        .max_depth(6)
        .into_iter()
        .filter_entry(|e| {
            let n = e.file_name().to_string_lossy();
            !matches!(n.as_ref(), ".venv" | ".data" | "__pycache__" | ".git")
        })
        .filter_map(|e| e.ok())
    {
        let rel = entry.path().strip_prefix(from).unwrap_or(entry.path());
        let target = to.join(rel);
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(&target).ok();
        } else if entry.file_type().is_file() {
            if let Some(p) = target.parent() {
                std::fs::create_dir_all(p).ok();
            }
            std::fs::copy(entry.path(), &target).map_err(|e| {
                ToolforgeError::io(format!("复制 {} 失败：{e}", entry.path().display()))
            })?;
        }
    }
    Ok(())
}

/// 比较两版权限，返回 (新增, 移除) 的中文描述列表。
fn diff_capabilities(old: &PermissionSet, new: &PermissionSet) -> (Vec<String>, Vec<String>) {
    let added = new
        .capabilities
        .iter()
        .filter(|c| {
            !old.capabilities
                .iter()
                .any(|o| o.fingerprint() == c.fingerprint())
        })
        .map(|c| c.describe())
        .collect();
    let removed = old
        .capabilities
        .iter()
        .filter(|c| {
            !new.capabilities
                .iter()
                .any(|n| n.fingerprint() == c.fingerprint())
        })
        .map(|c| c.describe())
        .collect();
    (added, removed)
}

/// 让 `Arc<PluginStore>` 可以跨任务共享
pub type SharedPluginStore = Arc<PluginStore>;

#[cfg(test)]
mod tests {
    use super::*;
    use toolforge_core::permission::{Capability, PathScope};

    fn store(root: &Path) -> PluginStore {
        let (tx, _rx) = tokio::sync::broadcast::channel(64);
        let paths = AppPaths::new(root);
        paths.ensure_all().unwrap();
        PluginStore::new(paths, None, tx)
    }

    const L1_YAML: &str = r#"
apiVersion: toolforge/v1
kind: Plugin
metadata:
  id: com.test.demo
  name: 测试插件
  version: 1.0.0
permissions:
  capabilities:
    - kind: fsRead
      scope: { kind: input }
runtime:
  kind: pipeline
  pipeline:
    steps:
      - id: copy
        uses: fs.copy
        with:
          src: "${src}"
          dst: "${dst}"
"#;

    #[test]
    fn bundle_path_traversal_is_rejected() {
        assert!(safe_relative_path("../../evil.exe").is_err());
        assert!(safe_relative_path("/etc/passwd").is_err());
        assert!(safe_relative_path("C:\\Windows\\x.dll").is_err());
        assert!(safe_relative_path("a/../../../b").is_err());
        assert!(safe_relative_path("").is_err());
        // 正常路径放行
        assert!(safe_relative_path("main.py").is_ok());
        assert!(safe_relative_path("src/lib.rs").is_ok());
    }

    #[test]
    fn bundle_oversized_file_is_rejected() {
        let f = BundleFile {
            path: "big.py".into(),
            content: "x".repeat(MAX_BUNDLE_FILE_BYTES + 1),
            encoding: FileEncoding::Utf8,
        };
        assert!(decode_bundle_file(&f).is_err());
    }

    #[test]
    fn install_manifest_leaves_plugin_disabled_and_ungranted() {
        let root = std::env::temp_dir().join("tf-store-test-1");
        let _ = std::fs::remove_dir_all(&root);
        let s = store(&root);

        let report = s
            .install(
                PluginSource::Manifest {
                    yaml: L1_YAML.into(),
                },
                false,
            )
            .unwrap();

        // 这是安全模型的地基：装完不等于能用
        assert!(!report.summary.enabled, "安装后必须处于禁用状态");
        assert_eq!(report.summary.granted_count, 0, "安装后不应有任何已授权能力");
        assert!(report.summary.has_pending_permissions);
        assert!(report.content_hash.starts_with("sha256:"));

        // 未授权时**能**启用（部分授权是允许的），但缺哪些能力必须一次说清 ——
        // 这是提示，不再是阻塞。真正的拒绝发生在动作那一刻。
        let missing = s.ungranted_declared("com.test.demo");
        assert_eq!(missing.len(), 1, "应当报出 1 项未授权能力：{missing:?}");
        assert!(
            missing[0].contains("读文件"),
            "未授权能力的描述必须是人类可读的：{:?}",
            missing[0]
        );
        // 启用后仍然不可运行，因为它是禁用状态（这条阻塞项与权限无关）
        let err = s.runnable("com.test.demo").unwrap_err();
        assert_eq!(err.code, ErrorCode::PermissionDenied);
        assert!(
            err.detail.as_deref().unwrap_or("").contains("禁用"),
            "必须告诉用户它还被禁用着：{:?}",
            err.detail
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 启用不再要求"全部授权"。
    ///
    /// 这条测试是**有意反转**旧行为的：原来叫 `cannot_enable_without_granting_first`，
    /// 断言"直接启用应当被拒绝"。旧行为把 `声明 ∩ 授权` 变成了恒等式
    /// （见 `set_enabled` 的文档），于是运行期那套能力裁决从来没被走到过。
    /// 现在改成"零授权也能启用，缺的能力在运行期被拦"。
    #[test]
    fn enabling_does_not_require_granting_everything() {
        let root = std::env::temp_dir().join("tf-store-test-2");
        let _ = std::fs::remove_dir_all(&root);
        let s = store(&root);
        s.install(
            PluginSource::Manifest {
                yaml: L1_YAML.into(),
            },
            false,
        )
        .unwrap();

        // 一个都没授权也能启用
        let summary = s.set_enabled("com.test.demo", true).unwrap();
        assert!(summary.enabled, "零授权也应当允许启用");
        assert_eq!(summary.granted_count, 0);
        assert!(summary.has_pending_permissions, "但仍然要如实标出未授权项");
        assert!(s.runnable("com.test.demo").is_ok(), "启用后即可运行");

        // 生效权限 = 声明 ∩ 已授权 = 空集。运行期看到的就是这个空集，
        // 于是任何一次受控动作都会被 `CapabilityGuard` 拒绝。
        let rec = s.record("com.test.demo").unwrap();
        assert!(
            rec.effective().capabilities.is_empty(),
            "零授权时生效权限必须是空集：{:?}",
            rec.effective()
        );

        // 授权之后交集才有内容 —— 这一步才是真正"给了权限"
        s.set_granted(
            "com.test.demo",
            PermissionSet::from_iter_caps([Capability::FsRead {
                scope: PathScope::Input,
            }]),
        )
        .unwrap();
        let rec = s.record("com.test.demo").unwrap();
        assert_eq!(rec.effective().capabilities.len(), 1);
        assert!(s.ungranted_declared("com.test.demo").is_empty());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 授权可以被**事后收回**，而插件仍然是启用状态 ——
    /// 这时"声明 ∩ 授权"才是一个真子集，也是运行期真正会用到交集的那种状态。
    #[test]
    fn revoking_a_grant_leaves_the_plugin_enabled_but_restricted() {
        let root = std::env::temp_dir().join("tf-store-test-revoke");
        let _ = std::fs::remove_dir_all(&root);
        let s = store(&root);
        s.install(
            PluginSource::Manifest {
                yaml: L1_YAML.into(),
            },
            false,
        )
        .unwrap();
        s.set_granted(
            "com.test.demo",
            PermissionSet::from_iter_caps([Capability::FsRead {
                scope: PathScope::Input,
            }]),
        )
        .unwrap();
        s.set_enabled("com.test.demo", true).unwrap();

        // 收回全部授权
        s.set_granted("com.test.demo", PermissionSet::empty()).unwrap();

        let rec = s.record("com.test.demo").unwrap();
        assert!(rec.state.enabled, "收回授权不该顺手把插件禁用掉");
        assert!(
            rec.effective().capabilities.is_empty(),
            "收回后生效权限必须为空"
        );
        assert_eq!(s.ungranted_declared("com.test.demo").len(), 1);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn granting_undeclared_capability_is_dropped() {
        let root = std::env::temp_dir().join("tf-store-test-3");
        let _ = std::fs::remove_dir_all(&root);
        let s = store(&root);
        s.install(
            PluginSource::Manifest {
                yaml: L1_YAML.into(),
            },
            false,
        )
        .unwrap();

        // 清单只声明了 fsRead{input}，这里额外塞 Exec
        let summary = s
            .set_granted(
                "com.test.demo",
                PermissionSet::from_iter_caps([
                    Capability::FsRead {
                        scope: PathScope::Input,
                    },
                    Capability::Exec,
                ]),
            )
            .unwrap();
        assert_eq!(summary.granted_count, 1, "未声明的 Exec 必须被丢弃");
        assert_eq!(summary.risk_level, toolforge_core::permission::RiskLevel::Low);

        // 并且记了审计
        let log = s.audit().tail(10);
        assert!(log
            .iter()
            .any(|e| e.kind == AuditEventKind::CapabilityViolation));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn install_rejects_wasm_runtime_without_artifact() {
        let root = std::env::temp_dir().join("tf-store-test-4");
        let _ = std::fs::remove_dir_all(&root);
        let s = store(&root);

        let yaml = r#"
apiVersion: toolforge/v1
kind: Plugin
metadata: { id: com.test.wasm, name: W, version: 1.0.0 }
runtime:
  kind: wasm
  wasm: { path: plugin.wasm }
"#;
        let err = s
            .install(
                PluginSource::Bundle {
                    yaml: yaml.into(),
                    files: vec![],
                },
                false,
            )
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::PluginInvalid);
        assert!(err.detail.unwrap().contains("plugin.wasm"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn install_rejects_traversal_in_bundle() {
        let root = std::env::temp_dir().join("tf-store-test-5");
        let _ = std::fs::remove_dir_all(&root);
        let s = store(&root);

        let err = s
            .install(
                PluginSource::Bundle {
                    yaml: L1_YAML.into(),
                    files: vec![BundleFile {
                        path: "../../../evil.py".into(),
                        content: "print(1)".into(),
                        encoding: FileEncoding::Utf8,
                    }],
                },
                false,
            )
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::PermissionDenied, "{err}");

        // 关键：不能留下半个插件目录
        assert!(!root.join("plugins").join("com.test.demo").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn reinstall_detects_privilege_escalation() {
        let root = std::env::temp_dir().join("tf-store-test-6");
        let _ = std::fs::remove_dir_all(&root);
        let s = store(&root);
        s.install(
            PluginSource::Manifest {
                yaml: L1_YAML.into(),
            },
            false,
        )
        .unwrap();

        // 新版本偷偷加了 Exec
        let escalated = L1_YAML.replace(
            "    - kind: fsRead\n      scope: { kind: input }",
            "    - kind: fsRead\n      scope: { kind: input }\n    - kind: exec",
        );
        let report = s
            .install(
                PluginSource::Manifest { yaml: escalated },
                true,
            )
            .unwrap();

        assert!(
            report.added_capabilities.iter().any(|c| c.contains("启动外部进程")),
            "必须报出新增的高危能力：{:?}",
            report.added_capabilities
        );
        // 升级后回到"未授权"状态，用户必须重新确认
        assert_eq!(report.summary.granted_count, 0);
        assert!(!report.summary.enabled);

        let audit = s.audit().tail(20);
        assert!(audit
            .iter()
            .any(|e| e.kind == AuditEventKind::PrivilegeEscalation));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn traversal_bundle_leaves_no_partial_install() {
        // 回归测试：第一版是"边校验边写盘"，路径穿越被拒绝时半个插件目录已经建好了。
        let root = std::env::temp_dir().join("tf-store-test-partial");
        let _ = std::fs::remove_dir_all(&root);
        let s = store(&root);

        // 第一个文件合法、第二个非法 —— 用来验证"全部校验完才写盘"
        let err = s
            .install(
                PluginSource::Bundle {
                    yaml: L1_YAML.into(),
                    files: vec![
                        BundleFile {
                            path: "helper.py".into(),
                            content: "print(1)".into(),
                            encoding: FileEncoding::Utf8,
                        },
                        BundleFile {
                            path: "../../../evil.py".into(),
                            content: "print(2)".into(),
                            encoding: FileEncoding::Utf8,
                        },
                    ],
                },
                false,
            )
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::PermissionDenied);

        // 关键：磁盘上不能留下任何痕迹
        let dir = s.paths().plugin_dir("com.test.demo");
        assert!(
            !dir.exists(),
            "被拒绝的安装不该留下目录：{}",
            dir.display()
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn integrity_check_detects_tampering() {
        let root = std::env::temp_dir().join("tf-store-test-7");
        let _ = std::fs::remove_dir_all(&root);
        let s = store(&root);
        s.install(
            PluginSource::Manifest {
                yaml: L1_YAML.into(),
            },
            false,
        )
        .unwrap();
        assert!(s.verify_integrity("com.test.demo").unwrap());

        // 模拟外部篡改
        let dir = s.paths().plugin_dir("com.test.demo");
        std::fs::write(dir.join("backdoor.py"), b"import os; os.system('calc')").unwrap();

        assert!(!s.verify_integrity("com.test.demo").unwrap());
        let err = s.quarantine_if_changed("com.test.demo").unwrap_err();
        assert_eq!(err.code, ErrorCode::IntegrityCheckFailed);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn reload_scans_installed_plugins() {
        let root = std::env::temp_dir().join("tf-store-test-8");
        let _ = std::fs::remove_dir_all(&root);
        let s = store(&root);
        s.install(
            PluginSource::Manifest {
                yaml: L1_YAML.into(),
            },
            false,
        )
        .unwrap();

        let report = s.reload().expect("reload 不应失败");
        assert_eq!(report.loaded, 1, "failed: {:?}", report.failed);
        assert!(report.failed.is_empty());
        assert_eq!(s.list().len(), 1);
        // 重载后仍是禁用 + 未授权
        assert!(!s.list()[0].enabled);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn builtin_plugins_are_enabled_and_self_granted() {
        let root = std::env::temp_dir().join("tf-store-test-9");
        let builtin = std::env::temp_dir().join("tf-store-test-9-builtin");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&builtin);

        let dir = builtin.join("demo");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("plugin.yaml"), L1_YAML).unwrap();

        let (tx, _rx) = tokio::sync::broadcast::channel(64);
        let paths = AppPaths::new(&root);
        paths.ensure_all().unwrap();
        let s = PluginStore::new(paths, Some(builtin.clone()), tx);

        let report = s.reload().expect("reload 不应失败");
        assert_eq!(report.loaded, 1);
        let summary = &s.list()[0];
        assert!(summary.builtin);
        assert!(summary.enabled, "内置插件默认启用");
        assert_eq!(summary.granted_count, 1, "内置插件默认授予声明的能力");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&builtin);
    }

    #[test]
    fn cannot_uninstall_builtin() {
        let root = std::env::temp_dir().join("tf-store-test-a");
        let builtin = std::env::temp_dir().join("tf-store-test-a-builtin");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&builtin);
        let dir = builtin.join("demo");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("plugin.yaml"), L1_YAML).unwrap();

        let (tx, _rx) = tokio::sync::broadcast::channel(64);
        let paths = AppPaths::new(&root);
        paths.ensure_all().unwrap();
        let s = PluginStore::new(paths, Some(builtin.clone()), tx);
        s.reload().expect("reload 不应失败");

        let err = s.uninstall("com.test.demo").unwrap_err();
        assert_eq!(err.code, ErrorCode::PermissionDenied);

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&builtin);
    }

    #[test]
    fn capability_diff_reports_both_directions() {
        let old = PermissionSet::from_iter_caps([
            Capability::FsRead {
                scope: PathScope::Input,
            },
            Capability::Ai,
        ]);
        let new = PermissionSet::from_iter_caps([
            Capability::FsRead {
                scope: PathScope::Input,
            },
            Capability::Exec,
        ]);
        let (added, removed) = diff_capabilities(&old, &new);
        assert_eq!(added.len(), 1);
        assert!(added[0].contains("启动外部进程"));
        assert_eq!(removed.len(), 1);
        assert!(removed[0].contains("AI"));
    }
}
