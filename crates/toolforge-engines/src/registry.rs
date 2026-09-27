//! 引擎注册表：探测、获取、解析路径。
//!
//! ## 探测器为什么要找三个地方
//!
//! FFmpeg 在 Windows 上的分布极其分散：winget 装的在
//! `%LOCALAPPDATA%\Microsoft\WinGet\Links`，官网下的绿色版通常在 `C:\ffmpeg\bin`，
//! 而用 scoop/choco 装的又在别处。只查 PATH 会让大量用户看到"未安装"，
//! 然后去装第二份。所以顺序是：
//!
//! ```text
//! ① 应用托管目录 <data>/engines/<id>/        ← 我们下载的，优先级最高
//! ② 系统 PATH                                ← which/where
//! ③ 各平台常见安装路径                        ← 见 platform_candidates()
//! ```
//!
//! ## 下载为什么默认拒绝无哈希的来源
//!
//! [`EngineSourceSpec::sha256`] 为 `None` 时，[`EngineRegistry::install`] 会**拒绝下载**，
//! 除非调用方显式传 `allow_unverified = true`。原因是：引擎二进制会以用户身份执行，
//! 一个被替换的 FFmpeg 就是完整的任意代码执行。宁可让维护者补哈希时麻烦一次。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use toolforge_core::engine::{
    engine_catalog, EngineDescriptor, EngineInstallMode, EngineSource, EngineState, EngineStatus,
};
use toolforge_core::error::{ErrorCode, ToolforgeError, ToolforgeResult};
use toolforge_core::events::AppEvent;
use toolforge_core::paths::AppPaths;
use toolforge_core::queue::JobCtx;

/// 各引擎的可执行文件名候选（按优先级）。
///
/// ⚠️ **Windows 上不要把 `convert` 当作 ImageMagick 的候选名。**
/// 系统自带 `C:\Windows\System32\convert.exe`（NTFS 卷转换工具），
/// 同名不同物 —— 匹配到它会让 ToolForge 认为"ImageMagick 已安装"，
/// 然后在真正调用时失败。ImageMagick 7 的可执行文件本来就叫 `magick`；
/// 只有 IM6 才叫 `convert`，而 IM6 在 Windows 上同样会被这个同名文件遮蔽。
pub const ENGINE_BINARIES: &[(&str, &[&str])] = &[
    ("ffmpeg", &["ffmpeg"]),
    ("ffprobe", &["ffprobe"]),
    ("libvips", &["vips", "vips.exe"]),
    #[cfg(windows)]
    ("imagemagick", &["magick"]),
    #[cfg(not(windows))]
    ("imagemagick", &["magick", "convert"]),
    ("pandoc", &["pandoc"]),
    ("libreoffice", &["soffice"]),
    ("7zip", &["7z", "7za", "7zz"]),
    ("calibre", &["ebook-convert"]),
    ("tesseract", &["tesseract"]),
    // PDF 栅格化（`doc.ocr` 吃 PDF 时用）。只认 pdftoppm —— 包里还有
    // pdftotext / pdfimages 等一堆工具，但"另一个 pdf*.exe 存在"不等于
    // "能把 PDF 渲染成图片"，探测错工具会让节点在真正调用时才失败。
    ("poppler", &["pdftoppm"]),
    ("python", &["python", "python3", "python3.11"]),
];

// ============================================================================
// 下载来源描述
// ============================================================================

/// 引擎的下载来源。
///
/// # 维护 `engine-sources.json` 的三条纪律
///
/// 1. **`sha256` 只能是自己算出来或从上游旁挂文件读来的**，不要抄网上的。
///    抄来的哈希无法验证；错了的后果是所有用户下载失败，更糟的是"校验通过了一份
///    被替换的文件"。本仓库当前的做法：全部是自己流式下载后计算的 SHA-256
///    （上游大多是 GitHub release，**不发布校验和**；换成 gyan.dev 时曾有旁挂
///    `.sha256`，但那个站实测只有 15~43 KB/s，下不完，见 ffmpeg 那条的 note）。
/// 2. **URL 必须指向版本固定直链**，不能是 `/latest` 之类的滚动别名 ——
///    上游一发新版哈希就失效，表现为"昨天还能装、今天全部失败"。
///    `ffmpeg-release-essentials.zip`、evermeet 的 `/getrelease/zip` 都属于这类。
/// 3. **未核对的条目不编造哈希**，`sha256` 留 `null` 并在 `note` 里说明原因。
///    [`EngineRegistry::install`] 会对它们返回
///    [`EngineInstallOutcome::HashRequired`] 而不是放行 —— 这是刻意的安全默认值。
/// 4. **不存在的来源不要留占位条目**。历史上这里放过两条"注释性"条目
///    （`libvips`@macos 的 404 地址、`pandoc`@macos 的 `.pkg`），本意是留个说明，
///    实际后果是 macOS 用户看到一个点了必然失败的按钮。现在直接删除，
///    解释留在 `docs/ENGINE-MATRIX.md`（**说明属于文档，不属于数据表**）。
///
/// 验证过的可用条目（2026-09 实测）：`ffmpeg`@windows/linux、`libvips`@windows、
/// `imagemagick`@windows、`pandoc`@windows/linux、`python`@windows/linux、
/// `poppler`@windows。`ffmpeg`@macos 与 `python`@macos 的 `sha256` 是 `null`
/// （本机取不到字节 / 没有 macOS 环境核对），macOS 用户应优先走 Homebrew。
///
/// 注意：该文件反序列化成 `Vec<Self>`，**不能放注释用的对象**（缺必填字段会让
/// 整个文件解析失败，而 [Self] 的加载是 `if let Ok(..)`，会静默退化成"零个来源"）。
/// 单元测试 `builtin_sources_parse` 守着这一点，`download_platforms_are_backed_by_real_sources`
/// 守着"没有孤儿条目、没有单边声明"。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineSourceSpec {
    pub id: String,
    /// `windows` / `macos` / `linux`
    pub platform: String,
    pub url: String,
    /// `sha256:<hex>` 或裸 hex。为 `None` 时禁止自动安装。
    #[serde(default)]
    pub sha256: Option<String>,
    /// `zip` / `tar.gz` / `tar.xz` / `7z` / `msi` / `raw`
    ///
    /// `msi` 走 Windows Installer 的**管理安装**（解包，不安装），见
    /// [`EngineRegistry::extract_msi`]。
    #[serde(default = "default_archive")]
    pub archive: String,
    #[serde(default)]
    pub strip_components: u32,
    /// 解压后需要额外加进 PATH 的相对目录（例如 `bin`）
    #[serde(default)]
    pub bin_subdir: Option<String>,
    /// 说明性文字，展示给用户
    #[serde(default)]
    pub note: Option<String>,
}

fn default_archive() -> String {
    "zip".into()
}

impl EngineSourceSpec {
    pub fn platform_key() -> &'static str {
        if cfg!(target_os = "windows") {
            "windows"
        } else if cfg!(target_os = "macos") {
            "macos"
        } else {
            "linux"
        }
    }

    /// 校验哈希格式，返回规范化后的十六进制串。
    ///
    /// 先统一转小写再剥前缀：维护者手写配置时大小写很随意
    /// （`SHA256:AB12…` 与 `sha256:ab12…` 必须等价）。
    pub fn expected_hash(&self) -> Option<String> {
        self.sha256.as_ref().map(|s| {
            let lower = s.trim().to_ascii_lowercase();
            lower
                .strip_prefix("sha256:")
                .unwrap_or(lower.as_str())
                .to_string()
        })
    }
}

/// 编译期内置的来源表。维护者补全 `engine-sources.json` 后即可生效。
const BUILTIN_SOURCES: &str = include_str!("../engine-sources.json");

// ============================================================================
// 模型描述
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSpec {
    pub id: String,
    pub engine_id: String,
    pub url: String,
    /// 备用下载地址（主地址连不上时按顺序再试）。见
    /// [`toolforge_core::engine::EngineModel::fallback_url`] 的说明。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_url: Option<String>,
    pub sha256: Option<String>,
    /// 目标文件名
    pub file_name: String,
    /// 是否允许商用（来自 [`toolforge_core::engine::EngineModel`]，此处冗余一份便于独立校验）
    #[serde(default)]
    pub commercial_use: bool,
    /// 这个权重服务于哪些内置节点（原样来自 `EngineModel.used_by`）。
    ///
    /// 可用性判定要用它：`onnx-models` 是个**虚拟引擎**，它的状态是
    /// "下过至少一个权重" —— 那不等于"下过 `ai.upscale` 能用的权重"。
    /// 只下了抠图权重的机器上，超分节点必须显示**不可用**。
    #[serde(default)]
    pub used_by: Vec<String>,
}

// ============================================================================
// 安装结果
// ============================================================================

#[derive(Debug, Clone)]
pub enum EngineInstallOutcome {
    /// 安装成功
    Installed { path: PathBuf, version: Option<String> },
    /// 已经有可用的（系统或托管）
    AlreadyAvailable { path: PathBuf, source: EngineSource },
    /// 当前平台没有配置下载源 —— 需要维护者补 `engine-sources.json`
    NotConfigured { reason: String },
    /// 来源没有哈希，且未允许未校验安装
    HashRequired { reason: String },
}

// ============================================================================
// 注册表
// ============================================================================

pub struct EngineRegistry {
    paths: AppPaths,
    /// 运行状态缓存
    cache: DashMap<String, EngineStatus>,
    /// 下载来源（按 `id` 索引，只保留当前平台的）
    sources: HashMap<String, EngineSourceSpec>,
    /// 模型来源
    models: HashMap<String, ModelSpec>,
    /// 事件出口（下载进度）
    tx: Option<tokio::sync::broadcast::Sender<AppEvent>>,
}

impl EngineRegistry {
    pub fn new(paths: AppPaths) -> Self {
        let mut sources = HashMap::new();
        if let Ok(list) = serde_json::from_str::<Vec<EngineSourceSpec>>(BUILTIN_SOURCES) {
            let platform = EngineSourceSpec::platform_key();
            for s in list {
                if s.platform == platform {
                    sources.insert(s.id.clone(), s);
                }
            }
        }

        // 模型权重表**直接从引擎目录推导**，不再单独存一份。
        //
        // 之前这里是个空 `HashMap`，只能靠 `register_model` 填 —— 而**没有任何人调用它**。
        // 结果是：界面列得出 6 个模型，但 `install_model` 对每一个都回答
        // "未在注册表里登记"。两份数据（目录 + 注册表）必然漂移，
        // 所以现在只有目录这一份。
        let mut models = HashMap::new();
        for desc in engine_catalog() {
            for m in desc.models {
                let Some(url) = m.url.clone() else { continue };
                models.insert(
                    m.id.clone(),
                    ModelSpec {
                        id: m.id.clone(),
                        engine_id: desc.id.clone(),
                        url,
                        fallback_url: m.fallback_url.clone(),
                        sha256: m.sha256.clone(),
                        file_name: m
                            .file_name
                            .clone()
                            // 兜底只在"确实有下载源"时才会走到；
                            // 没写 file_name 的模型上面已经被 continue 掉了。
                            .unwrap_or_else(|| format!("{}.onnx", m.id)),
                        commercial_use: m.commercial_use,
                        used_by: m.used_by.clone(),
                    },
                );
            }
        }

        Self {
            paths,
            cache: DashMap::new(),
            sources,
            models,
            tx: None,
        }
    }

    pub fn with_events(mut self, tx: tokio::sync::broadcast::Sender<AppEvent>) -> Self {
        self.tx = Some(tx);
        self
    }

    /// 用外部文件覆盖内置来源表（便于内网部署）
    pub fn load_sources_file(&mut self, path: &Path) -> ToolforgeResult<usize> {
        let text = std::fs::read_to_string(path)
            .map_err(|e| ToolforgeError::io(format!("读取来源文件 {} 失败：{e}", path.display())))?;
        let list: Vec<EngineSourceSpec> = serde_json::from_str(&text)
            .map_err(|e| ToolforgeError::invalid(format!("来源文件格式非法：{e}")))?;
        let platform = EngineSourceSpec::platform_key();
        let mut n = 0;
        for s in list {
            if s.platform == platform {
                self.sources.insert(s.id.clone(), s);
                n += 1;
            }
        }
        Ok(n)
    }

    pub fn register_model(&mut self, spec: ModelSpec) {
        self.models.insert(spec.id.clone(), spec);
    }

    pub fn paths(&self) -> &AppPaths {
        &self.paths
    }

    // ---------------- 探测 ----------------

    /// 探测全部引擎
    pub async fn probe_all(&self) -> Vec<EngineStatus> {
        let mut out = Vec::new();
        for desc in engine_catalog() {
            out.push(self.probe(&desc.id).await);
        }
        out
    }

    /// 探测单个引擎。
    pub async fn probe(&self, engine_id: &str) -> EngineStatus {
        let Some(desc) = engine_catalog().into_iter().find(|e| e.id == engine_id) else {
            let s = EngineStatus::unsupported(engine_id, "目录里没有这个引擎");
            self.cache.insert(engine_id.to_string(), s.clone());
            return s;
        };

        // 远程服务型引擎没有本地二进制，只要配置了就算"可用"
        if desc.install_modes == vec![EngineInstallMode::Remote] {
            let s = EngineStatus {
                id: desc.id.clone(),
                state: EngineState::Detected,
                source: EngineSource::Remote,
                path: None,
                version: None,
                message: Some("远程服务，无需本地安装".into()),
                installed_size_mb: None,
                installed_models: vec![],
                probed_at: Some(toolforge_core::job::now_iso()),
            };
            self.cache.insert(engine_id.to_string(), s.clone());
            return s;
        }

        // `onnx-models` 是个**虚拟引擎**：它没有一个叫 "onnx-models.exe" 的东西，
        // 只是一堆权重文件的宿主。按普通引擎去探测的话它永远是 Missing，
        // 于是依赖它的节点（`image.remove-background`）会**永远显示不可用** ——
        // 哪怕用户已经下好了权重。
        //
        // 它的可用性判据就是"有没有下过至少一个权重"。
        if engine_id == "onnx-models" {
            let installed = self.installed_models_for("onnx-models");
            let usable = !installed.is_empty();
            let s = EngineStatus {
                id: desc.id.clone(),
                state: if usable {
                    EngineState::Installed
                } else {
                    EngineState::Missing
                },
                source: EngineSource::Managed,
                path: None,
                version: None,
                message: Some(if usable {
                    format!("已下载 {} 个模型权重", installed.len())
                } else {
                    "还没有下载任何模型权重。到「模型权重」里下 u2netp（4.4 MB）即可开始用抠图。"
                        .into()
                }),
                installed_size_mb: None,
                installed_models: installed,
                probed_at: Some(toolforge_core::job::now_iso()),
            };
            self.cache.insert(engine_id.to_string(), s.clone());
            return s;
        }

        // ① 托管目录
        if let Some(p) = self.managed_binary(engine_id) {
            let version = probe_version_of(&p, engine_id).await;
            let s = EngineStatus {
                id: desc.id.clone(),
                state: EngineState::Installed,
                source: EngineSource::Managed,
                path: Some(p.display().to_string()),
                version,
                message: None,
                installed_size_mb: dir_size_mb(&self.paths.engine_dir(engine_id)),
                installed_models: self.installed_models_for(engine_id),
                probed_at: Some(toolforge_core::job::now_iso()),
            };
            self.cache.insert(engine_id.to_string(), s.clone());
            return s;
        }

        // ② PATH + ③ 平台常见路径
        if let Some(p) = self.system_binary(engine_id) {
            let version = probe_version_of(&p, engine_id).await;
            let s = EngineStatus {
                id: desc.id.clone(),
                state: EngineState::Detected,
                source: EngineSource::System,
                path: Some(p.display().to_string()),
                version,
                message: None,
                installed_size_mb: None,
                installed_models: self.installed_models_for(engine_id),
                probed_at: Some(toolforge_core::job::now_iso()),
            };
            self.cache.insert(engine_id.to_string(), s.clone());
            return s;
        }

        let mut s = EngineStatus::missing(&desc.id);
        s.message = Some(install_hint(&desc, self.has_download_source(&desc.id)));
        s.probed_at = Some(toolforge_core::job::now_iso());
        self.cache.insert(engine_id.to_string(), s.clone());
        s
    }

    /// 取缓存的探测结果；没有则现探。
    pub async fn status(&self, engine_id: &str) -> EngineStatus {
        if let Some(s) = self.cache.get(engine_id) {
            return s.clone();
        }
        self.probe(engine_id).await
    }

    /// 已探测过的全部状态（同步，供 UI 快速渲染）
    pub fn cached_statuses(&self) -> Vec<EngineStatus> {
        engine_catalog()
            .into_iter()
            .map(|d| {
                self.cache
                    .get(&d.id)
                    .map(|s| s.clone())
                    .unwrap_or_else(|| EngineStatus::missing(&d.id))
            })
            .collect()
    }

    // ---------------- 路径解析 ----------------

    /// 托管目录里的可执行文件
    pub fn managed_binary(&self, engine_id: &str) -> Option<PathBuf> {
        let candidates = ENGINE_BINARIES
            .iter()
            .find(|(id, _)| *id == engine_id)
            .map(|(_, names)| *names)
            .unwrap_or(&[]);

        // 优先按 MANAGED_LAYOUT 里声明的相对路径找
        if let Some((_, rel)) = crate::MANAGED_LAYOUT.iter().find(|(id, _)| *id == engine_id) {
            let p = self.paths.engine_dir(engine_id).join(rel);
            if let Some(found) = with_exe_suffix(&p) {
                return Some(found);
            }
        }
        // 再按文件名在托管目录里递归找一层
        let root = self.paths.engine_dir(engine_id);
        if !root.exists() {
            return None;
        }
        for name in candidates {
            for entry in walkdir::WalkDir::new(&root)
                .max_depth(3)
                .into_iter()
                .filter_map(|e| e.ok())
            {
                if entry.file_type().is_file() && is_named_executable(entry.path(), name) {
                    return Some(entry.path().to_path_buf());
                }
            }
        }
        None
    }

    /// 系统里的可执行文件（PATH → 常见路径）
    pub fn system_binary(&self, engine_id: &str) -> Option<PathBuf> {
        let names = ENGINE_BINARIES
            .iter()
            .find(|(id, _)| *id == engine_id)
            .map(|(_, names)| *names)?;

        for name in names {
            if let Ok(p) = which::which(name) {
                return Some(p);
            }
        }
        for cand in platform_candidates(engine_id) {
            if let Some(found) = with_exe_suffix(&cand) {
                return Some(found);
            }
        }
        None
    }

    /// 解析出可直接执行的路径。找不到就返回 [`ErrorCode::EngineMissing`]。
    pub async fn resolve(&self, engine_id: &str) -> ToolforgeResult<PathBuf> {
        let st = self.status(engine_id).await;
        if let Some(p) = st.path {
            let path = PathBuf::from(p);
            if path.exists() {
                return Ok(path);
            }
        }
        Err(ToolforgeError::engine_missing(engine_id).with_detail(
            "请在「设置 → 引擎管理」中安装，或把可执行文件加入系统 PATH 后重新探测。",
        ))
    }

    /// 该引擎当前是否可用
    pub async fn is_available(&self, engine_id: &str) -> bool {
        self.status(engine_id).await.state.is_usable()
    }

    fn installed_models_for(&self, engine_id: &str) -> Vec<String> {
        engine_catalog()
            .into_iter()
            .find(|e| e.id == engine_id)
            .map(|e| {
                e.models
                    .iter()
                    .filter(|m| self.model_path(&m.id).map(|p| p.exists()).unwrap_or(false))
                    .map(|m| m.id.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 某个模型权重应当落盘的位置。
    ///
    /// 目录用 **模型自己的 id** 而不是 `engine_id`：`onnx-models` 是个虚拟引擎，
    /// 把 6 个模型全塞进同一个目录，删一个就会连坐。
    /// 路径推导只此一处 —— 之前 `install_model` 用 `model_dir(engine_id)` +
    /// `file_name`，而 `installed_models_for` 用 `model_dir(model_id)` +
    /// `format!("{id}.onnx")`，两边**对不上**，装完了也认不出来。
    pub fn model_path(&self, model_id: &str) -> Option<PathBuf> {
        let spec = self.models.get(model_id)?;
        Some(self.paths.model_dir(&spec.id).join(&spec.file_name))
    }

    /// 已登记的模型清单（供 `models_*` 命令使用）
    pub fn models(&self) -> Vec<ModelSpec> {
        let mut out: Vec<ModelSpec> = self.models.values().cloned().collect();
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }

    /// 某个模型是否已经下载好
    pub fn is_model_installed(&self, model_id: &str) -> bool {
        self.model_path(model_id).map(|p| p.exists()).unwrap_or(false)
    }

    /// 当前平台有没有这个引擎的可下载来源。
    ///
    /// 界面靠它决定要不要显示「安装托管版本」按钮 —— 没有来源却显示按钮，
    /// 用户点一下只会拿到"当前平台没有配置下载源"。
    pub fn has_download_source(&self, engine_id: &str) -> bool {
        self.sources.contains_key(engine_id)
    }

    /// 删除一个已下载的模型，返回是否真的删掉了东西。
    pub fn remove_model(&self, model_id: &str) -> ToolforgeResult<bool> {
        let Some(path) = self.model_path(model_id) else {
            return Err(ToolforgeError::not_found(format!(
                "模型 {model_id} 未在注册表里登记"
            )));
        };
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(ToolforgeError::io(format!(
                "删除 {} 失败：{e}",
                path.display()
            ))),
        }
    }

    // ---------------- 安装 ----------------

    /// 按需安装引擎。
    ///
    /// * `allow_unverified` 必须显式传 `true` 才会接受没有哈希的来源 ——
    ///   调用方（Tauri 命令层）会把它接到一个需要用户二次确认的 UI 上。
    /// * `force` = "即使系统上已经有一个可用的，也要装应用托管的那一份"。
    ///
    /// ## 为什么需要 `force`
    ///
    /// "已经可用"并不等于"满足我的要求"。最典型的例子是 Python：
    /// 系统上装着 3.14，探测结果就是"可用"，于是安装请求被短路掉；
    /// 但**抠图需要 onnxruntime，而它没有 3.14 的 wheel** ——
    /// 用户会看到一个"Python 已可用"的绿标，然后抠图报"没有可用的 Python"。
    ///
    /// 托管版本是平台自己选的版本（Python 固定 3.11），可以保证依赖装得上。
    /// 所以 `force = true` 时跳过"已有就不下载"这条捷径。
    pub async fn install(
        &self,
        engine_id: &str,
        job: &JobCtx,
        allow_unverified: bool,
        force: bool,
    ) -> ToolforgeResult<EngineInstallOutcome> {
        // 已经有得用就不下载（除非调用方明确要求托管版本）
        let st = self.probe(engine_id).await;
        if !force && st.state.is_usable() {
            if let Some(p) = st.path {
                return Ok(EngineInstallOutcome::AlreadyAvailable {
                    path: PathBuf::from(p),
                    source: st.source,
                });
            }
        }

        let Some(desc) = engine_catalog().into_iter().find(|e| e.id == engine_id) else {
            return Err(ToolforgeError::not_found(format!("未知引擎 {engine_id}")));
        };

        if !desc.install_modes.contains(&EngineInstallMode::Download) {
            return Ok(EngineInstallOutcome::NotConfigured {
                reason: format!(
                    "`{}` 只支持系统安装，请先手动安装（{}），然后回到本页点「重新探测」",
                    desc.name, desc.homepage
                ),
            });
        }

        let Some(src) = self.sources.get(engine_id) else {
            return Ok(EngineInstallOutcome::NotConfigured {
                reason: format!(
                    "`{engine_id}` 在 {} 上没有配置下载源。\
                     维护者需要在 engine-sources.json 里补上 url 与 sha256。",
                    EngineSourceSpec::platform_key()
                ),
            });
        };

        let expected = src.expected_hash();
        if expected.is_none() && !allow_unverified {
            return Ok(EngineInstallOutcome::HashRequired {
                reason: format!(
                    "引擎 `{engine_id}` 的来源没有配置 SHA-256。\
                     引擎二进制会以你的身份执行，未校验的下载等同于允许任意代码执行。"
                ),
            });
        }

        let dest = self.paths.engine_dir(engine_id);
        std::fs::create_dir_all(&dest)
            .map_err(|e| ToolforgeError::io(format!("创建引擎目录失败：{e}")))?;

        // 下载到临时文件
        let archive_name = src
            .url
            .rsplit('/')
            .next()
            .unwrap_or("engine.archive")
            .split('?')
            .next()
            .unwrap_or("engine.archive")
            .to_string();
        let tmp = self.paths.cache().join(format!("{engine_id}-{archive_name}"));
        std::fs::create_dir_all(self.paths.cache()).ok();

        job.info(format!("开始下载 {}（约 {} MB）", desc.name, desc.approx_size_mb));
        let actual = self
            .download_to(&src.url, &tmp, engine_id, job, expected.as_deref())
            .await?;

        if let Some(exp) = &expected {
            if !actual.eq_ignore_ascii_case(exp) {
                let _ = std::fs::remove_file(&tmp);
                return Err(ToolforgeError::new(
                    ErrorCode::IntegrityCheckFailed,
                    format!("{} 的下载产物哈希不匹配，已删除", desc.name),
                )
                .with_detail(format!("期望 sha256:{exp}\n实际 sha256:{actual}")));
            }
            job.info("SHA-256 校验通过");
        } else {
            job.warn(format!(
                "未校验哈希（用户已确认）。实际 SHA-256 = {actual}，建议回填到 engine-sources.json"
            ));
        }

        // 解压
        job.info("正在解压…");
        self.extract(&tmp, &dest, &src.archive, src.strip_components, job)
            .await?;
        let _ = std::fs::remove_file(&tmp);

        // 重新探测并广播
        self.cache.remove(engine_id);
        let st = self.probe(engine_id).await;
        if let Some(tx) = &self.tx {
            let _ = tx.send(AppEvent::EngineStatusChanged { status: st.clone() });
        }

        match st.path {
            Some(p) => Ok(EngineInstallOutcome::Installed {
                path: PathBuf::from(p),
                version: st.version,
            }),
            None => Err(ToolforgeError::engine_failed(
                engine_id,
                format!(
                    "{} 解压完成但没找到可执行文件。请检查 archive 结构与 stripComponents 配置。",
                    desc.name
                ),
            )
            .with_detail(format!("目标目录：{}", dest.display()))),
        }
    }

    /// 流式下载 + 边下边算哈希。返回实际 SHA-256（hex）。
    pub async fn download_to(
        &self,
        url: &str,
        dest: &Path,
        engine_id: &str,
        job: &JobCtx,
        _expected: Option<&str>,
    ) -> ToolforgeResult<String> {
        download(url, dest, engine_id, job, self.tx.clone()).await
    }

    async fn extract(
        &self,
        archive: &Path,
        dest: &Path,
        kind: &str,
        strip: u32,
        job: &JobCtx,
    ) -> ToolforgeResult<()> {
        if kind == "raw" {
            let name = archive
                .file_name()
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("engine.bin"));
            let target = dest.join(name);
            std::fs::copy(archive, &target)
                .map_err(|e| ToolforgeError::io(format!("复制引擎文件失败：{e}")))?;
            return Ok(());
        }

        if kind == "msi" {
            return Self::extract_msi(archive, dest, job).await;
        }

        // 优先用系统 tar（Windows 10 1803+ 自带 bsdtar，能处理 zip / tar.gz）
        let mut tar_args: Vec<String> = vec!["-xf".into(), archive.display().to_string()];
        tar_args.push("-C".into());
        tar_args.push(dest.display().to_string());
        if strip > 0 {
            tar_args.push(format!("--strip-components={strip}"));
        }

        let tar_res = toolforge_process::exec(
            toolforge_process::ExecOptions::new("tar")
                .args(tar_args)
                .timeout(Duration::from_secs(600))
                .cancel(job.cancel.clone())
                .quiet(true),
        )
        .await;

        if let Ok(r) = &tar_res {
            if r.success() {
                return Ok(());
            }
        }

        // 退回到 7-Zip
        if let Ok(sevenzip) = self.resolve("7zip").await {
            let r = toolforge_process::exec(
                toolforge_process::ExecOptions::new(sevenzip)
                    .arg("x")
                    .arg(archive.display().to_string())
                    .arg(format!("-o{}", dest.display()))
                    .arg("-y")
                    .timeout(Duration::from_secs(600))
                    .cancel(job.cancel.clone())
                    .quiet(true),
            )
            .await?;
            if r.success() {
                return Ok(());
            }
        }

        let detail = tar_res
            .map(|r| r.stderr)
            .unwrap_or_else(|e| e.to_string());
        Err(ToolforgeError::internal(format!(
            "无法解压 {}（已尝试系统 tar 与 7-Zip）",
            archive.display()
        ))
        .with_detail(format!(
            "{detail}\n\n请手动解压到引擎目录后重新探测：{}",
            dest.display()
        )))
    }

    /// 用 Windows Installer 的**管理安装**（`msiexec /a`）把一个 `.msi` 解开到目录。
    ///
    /// # 为什么需要这条路径
    ///
    /// 7-Zip 官方在 Windows 上**只发安装器**（`.exe` / `.msi`）与 `-extra` 包：
    ///
    /// * `7z2603-x64.exe` 是自解压包，但要用 7-Zip 才能解 —— 先有鸡还是先有蛋；
    /// * `7z2603-extra.7z` 能解（Windows 自带的 bsdtar 读得懂 7z），**但里面是 `7za.exe`**：
    ///   它是"精简版"，格式表里**没有 RAR**，而 `archive.unpack` 的输入端口明确写着收 `.rar`；
    /// * `.msi` 反而是唯一一条"能拿到完整 7-Zip"的路。
    ///
    /// `msiexec /a`（administrative install）**不是安装**：它把包内容按目录结构原样铺到
    /// `TARGETDIR`，不写注册表、不装服务、不需要管理员权限（本机实测 `/qn` 退出码 0，
    /// 得到 `Files/7-Zip/7z.exe` + `7z.dll`，`7z.exe i` 里 Rar1/2/3/5 都在）。
    /// 这也是 `archive: "msi"` 这个取值的全部含义。
    ///
    /// 它会顺手把 `.msi` 自己复制进目标目录（Windows Installer 的"管理安装点"行为），
    /// 属于正常现象，不是解压残留 —— 所以这里**不**做清理，免得下次修复时又把它当 bug 删掉。
    async fn extract_msi(archive: &Path, dest: &Path, job: &JobCtx) -> ToolforgeResult<()> {
        let r = toolforge_process::exec(
            toolforge_process::ExecOptions::new("msiexec.exe")
                .arg("/a")
                .arg(archive.display().to_string())
                .arg("/qn")
                .arg(format!("TARGETDIR={}", dest.display()))
                .timeout(Duration::from_secs(600))
                .cancel(job.cancel.clone())
                .quiet(true),
        )
        .await?;

        if r.success() {
            return Ok(());
        }
        Err(ToolforgeError::internal(format!(
            "无法解开 {}（Windows Installer 管理安装失败）",
            archive.display()
        ))
        .with_detail(format!(
            "msiexec 退出码 {}\n{}\n\n请手动安装 7-Zip 后重新探测。",
            r.exit_code, r.stderr
        )))
    }

    /// 下载一个模型权重。
    ///
    /// ## 已经装过就不重下
    ///
    /// 本地已有那份文件时，先**把它自己哈希一遍**再决定要不要下载。
    /// 为什么不是"文件存在就当已安装"：模型权重是会被用户手工替换、
    /// 被同步工具截断、被磁盘错误写坏的东西，而"拿一个损坏的权重去跑推理"
    /// 得到的是乱码结果而不是错误 —— 那比下载失败难查得多。
    ///
    /// 为什么不是"一律重下"：`u2net` 是 168 MB。用户在界面上多点一次下载，
    /// 不该付一次完整下载的代价。
    pub async fn install_model(
        &self,
        model_id: &str,
        job: &JobCtx,
        allow_unverified: bool,
    ) -> ToolforgeResult<PathBuf> {
        let Some(spec) = self.models.get(model_id) else {
            return Err(ToolforgeError::not_found(format!(
                "模型 {model_id} 未在注册表里登记"
            )));
        };
        let expected = spec
            .sha256
            .as_ref()
            .map(|s| s.trim().strip_prefix("sha256:").unwrap_or(s.trim()).to_ascii_lowercase());
        if expected.is_none() && !allow_unverified {
            return Err(ToolforgeError::new(
                ErrorCode::IntegrityCheckFailed,
                format!("模型 {model_id} 没有配置 SHA-256，拒绝自动下载"),
            ));
        }

        let dir = self.paths.model_dir(&spec.id);
        std::fs::create_dir_all(&dir)
            .map_err(|e| ToolforgeError::io(format!("创建模型目录失败：{e}")))?;
        let dest = dir.join(&spec.file_name);

        if let Some(exp) = &expected {
            if dest.is_file() {
                match hash_file(&dest) {
                    Ok(local) if local.eq_ignore_ascii_case(exp) => {
                        job.info(format!(
                            "本地已有校验通过的 {model_id}（{}），跳过下载",
                            describe_size(&dest)
                        ));
                        return Ok(dest);
                    }
                    Ok(local) => {
                        // 留一条 warn：本地文件坏掉这件事本身值得被看见
                        job.warn(format!(
                            "本地 {model_id} 的哈希与预期不符（期望 {}…，实际 {}…），将重新下载",
                            &exp[..8.min(exp.len())],
                            &local[..8.min(local.len())]
                        ));
                    }
                    Err(e) => {
                        job.warn(format!("无法校验本地 {model_id}（{e}），将重新下载"));
                    }
                }
            }
        }

        let actual = download_with_fallback(spec, &dest, model_id, job, self.tx.clone()).await?;
        if let Some(exp) = &expected {
            if !actual.eq_ignore_ascii_case(exp) {
                let _ = std::fs::remove_file(&dest);
                return Err(ToolforgeError::new(
                    ErrorCode::IntegrityCheckFailed,
                    format!("模型 {model_id} 哈希不匹配，已删除"),
                )
                .with_detail(format!("期望 sha256:{exp}\n实际 sha256:{actual}")));
            }
        }
        Ok(dest)
    }
}

/// 按"主地址 → 备用地址"的顺序下载。
///
/// # 为什么要有这一层
///
/// 这些权重的官方源是 `huggingface.co`，它在**部分网络下整体不可达**
/// （本机实测：没开加速时连不上）。只填官方 → 那部分用户一个模型都下不了；
/// 只填镜像 → 所有用户都依赖第三方镜像、而且镜像本身会抖。
/// 两个都填、按顺序试，是唯一对两边都成立的答案。
///
/// 日志里会写明**这次是从哪儿下的** —— 用户与排查的人都需要知道
/// "兜底到底有没有被用上"。
async fn download_with_fallback(
    spec: &ModelSpec,
    dest: &Path,
    label: &str,
    job: &JobCtx,
    tx: Option<tokio::sync::broadcast::Sender<AppEvent>>,
) -> ToolforgeResult<String> {
    let primary = download(&spec.url, dest, label, job, tx.clone()).await;
    let Err(first_err) = primary else {
        return primary;
    };

    let Some(fallback) = spec.fallback_url.as_deref() else {
        return Err(first_err);
    };

    job.warn(format!(
        "主下载源（{}）失败，改用备用源重试：{}",
        url_host(&spec.url),
        first_err.message
    ));
    tracing::warn!(
        model = %spec.id,
        primary = %spec.url,
        fallback = %fallback,
        "主下载源失败，改用备用源"
    );

    // 主地址有可能留下半截文件（比如卡死之后）—— 重试前删掉，
    // 否则第二次下载会从半截的地方继续/覆盖出奇怪的结果。
    let _ = std::fs::remove_file(dest);

    match download(fallback, dest, label, job, tx).await {
        Ok(h) => {
            job.info(format!("已从备用源（{}）下载完成", url_host(fallback)));
            Ok(h)
        }
        Err(second) => Err(ToolforgeError::new(
            ErrorCode::Network,
            format!("下载 {label} 失败：主源与备用源都不通"),
        )
        .with_detail(format!(
            "主源 {}：{}\n备用源 {}：{}",
            url_host(&spec.url),
            first_err.message,
            url_host(fallback),
            second.message
        ))),
    }
}

/// 从 URL 里取主机名（只用于日志/报错，不参与任何判断）
fn url_host(url: &str) -> &str {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let end = rest.find('/').unwrap_or(rest.len());
    &rest[..end]
}

/// 对一个已存在的文件算 SHA-256（同步、分块读，避免把 170 MB 整个读进内存）。
fn hash_file(path: &Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;

    let mut f = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 256];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// 文件大小的人类可读描述（读不到元数据时返回 `?`，绝不因此报错）
fn describe_size(path: &Path) -> String {
    match std::fs::metadata(path) {
        Ok(m) => format!("{:.1} MB", m.len() as f64 / (1024.0 * 1024.0)),
        Err(_) => "? MB".to_string(),
    }
}

// ============================================================================
// 下载实现
// ============================================================================

/// 是否值得重试的状态码。
///
/// GitHub 的 release 资产是 302 跳到 `release-assets.githubusercontent.com` 的，
/// 而那条链路**真的会间歇性返回 502/503**（本机实测过：同一个 URL 用 curl 拿 200，
/// 用带 HTTP/2 的客户端拿 502，重试就好）。对"下载 170 MB 模型"这种操作来说，
/// 一次 502 就放弃、让用户重新点一遍，是明显不合理的。
fn is_retryable_status(status: reqwest::StatusCode) -> bool {
    status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS
}

/// 流式下载到文件，同时计算 SHA-256，并按 500ms 节流上报进度。
///
/// ## 重试策略（**最多两次，第二次只用 HTTP/1.1**）
///
/// 第 1 次用默认客户端（允许 HTTP/2）。失败且是 5xx / 429 / 连接层错误时，
/// 第 2 次换成 `http1_only` 的客户端重试。
///
/// ### 5xx 重试：有实测依据
///
/// 这不是"防御性编程"，是本机真实踩到的：同一个 GitHub release 资产地址，
/// 第一次下载返回 **502 Bad Gateway**，过几分钟再下就是 200（字节数与哈希都对得上）。
/// GitHub 的资产是 302 跳到 `release-assets.githubusercontent.com` 的，
/// 那一段链路确实会间歇性 5xx。对"下载 170 MB 模型"这种操作来说，
/// 一次 502 就让用户重新点一遍，是明显不合理的。
///
/// ### HTTP/1.1 兜底：依据较弱，但代价也极低
///
/// 观察到 502 的那次之后，我怀疑是中间设备（本机 github.com 被解析到
/// `127.0.0.1:443`，显然有本地代理在做 MITM）破坏了 HTTP/2，于是加了这条兜底。
/// **后来 502 没能复现，所以"是 HTTP/2 的问题"这个判断并没有被证实** ——
/// 更可能只是瞬时 5xx。留着它的理由只有一个：这条路径只在第一次真的失败之后
/// 才会走，干净网络上一行都不会多跑，而它确实能救某些把 h2 拆坏的企业代理。
/// 如果你看到这段注释时它已经在生产里跑了一段时间却从未被触发过，
/// 那就说明它没用，删掉即可 —— 别因为它"看起来保险"而留着。
pub async fn download(
    url: &str,
    dest: &Path,
    label: &str,
    job: &JobCtx,
    tx: Option<tokio::sync::broadcast::Sender<AppEvent>>,
) -> ToolforgeResult<String> {
    let client = build_download_client(false)?;
    match send_download(&client, url).await {
        Ok(resp) if resp.status().is_success() => {
            return stream_to_file(resp, dest, label, job, tx, STALL_TIMEOUT).await
        }
        Ok(resp) if is_retryable_status(resp.status()) => {
            tracing::warn!(
                url,
                status = %resp.status(),
                "下载失败，改用 HTTP/1.1 重试一次"
            );
        }
        Ok(resp) => {
            return Err(ToolforgeError::new(
                ErrorCode::Network,
                format!("下载 {label} 失败：HTTP {}", resp.status()),
            )
            .with_detail(format!("URL：{url}")));
        }
        Err(e) => {
            tracing::warn!(url, err = %e.message, "下载请求失败，改用 HTTP/1.1 重试一次");
        }
    }

    let fallback = build_download_client(true)?;
    let resp = send_download(&fallback, url).await?;
    if !resp.status().is_success() {
        return Err(ToolforgeError::new(
            ErrorCode::Network,
            format!(
                "下载 {label} 失败：HTTP {}（HTTP/1.1 重试后仍然失败）",
                resp.status()
            ),
        )
        .with_detail(format!(
            "URL：{url}\n\n\
             如果这个网络有代理 / 透明加速，请把它对本应用放行；\
             也可以手动下载该文件后放进引擎目录。"
        )));
    }
    stream_to_file(resp, dest, label, job, tx, STALL_TIMEOUT).await
}

fn build_download_client(http1_only: bool) -> ToolforgeResult<reqwest::Client> {
    let mut b = reqwest::Client::builder()
        .user_agent(concat!("ToolForge/", env!("CARGO_PKG_VERSION")))
        // 60 秒，而不是原来的 20 秒。**这是实测调出来的**：在网络降级的那段时间里，
        // 同一个 GitHub 地址用 `curl` 花 9 分钟能下完 213 MB，而应用在**连接阶段**
        // 就报 `client error (Connect) → operation timed out` —— 它连"开始下"都没做到。
        // 用户看到的是"网络错误"，而真实情况只是**这条线路慢**。
        //
        // 注意这个界只覆盖连接阶段（DNS + TCP + TLS）；一旦开始收数据，就由
        // `STALL_TIMEOUT`（60 秒没有新字节）和 `total_download_timeout()` 接管。
        // 下载失败时本来就会用 HTTP/1.1 再试一次，所以最坏情况是等 2 分钟 ——
        // 对 "105 MB 的引擎" 这种体量来说，"多等一会儿"远比"根本没开始下"好。
        .connect_timeout(Duration::from_secs(60))
        .timeout(total_download_timeout());
    if http1_only {
        b = b.http1_only();
    }
    b.build()
        .map_err(|e| ToolforgeError::new(ErrorCode::Network, format!("创建 HTTP 客户端失败：{e}")))
}

/// 把 reqwest 的错误摊开成人能看懂的原因。
///
/// ## 为什么不能只 `format!("{e}")`
///
/// reqwest 的 `Display` 对连接类错误只给出一句
/// `error sending request for url (…)` —— **不含原因**。真机实测过：
/// 同一个 URL 用 `curl` 拿 200（11.7 MB 正常下完），而应用里报的就是这句，
/// 于是完全无法判断是 DNS、连接被拒、TLS 还是超时。
/// 排查一个"我们这边失败、curl 那边成功"的问题时，这句话等于零信息。
///
/// 这里按 `reqwest::Error` 的分类给出人话，并把 `source()` 链展开 ——
/// 真正的原因（如 `tls handshake eof`、`connection refused`）在链上。
fn describe_reqwest_error(e: &reqwest::Error) -> String {
    let kind = if e.is_timeout() {
        "超时"
    } else if e.is_connect() {
        "连接失败"
    } else if e.is_decode() {
        "响应解码失败"
    } else if e.is_redirect() {
        "重定向失败"
    } else if e.is_body() {
        "读取响应体失败"
    } else {
        "请求失败"
    };

    // source 链：把每一层都串上，最后一层通常才是根因
    let mut chain: Vec<String> = Vec::new();
    let mut cur: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(e);
    while let Some(c) = cur {
        chain.push(c.to_string());
        cur = c.source();
        if chain.len() >= 5 {
            break;
        }
    }

    if chain.is_empty() {
        format!("{kind}：{e}")
    } else {
        format!("{kind}：{}", chain.join(" → "))
    }
}

async fn send_download(client: &reqwest::Client, url: &str) -> ToolforgeResult<reqwest::Response> {
    client.get(url).send().await.map_err(|e| {
        let reason = describe_reqwest_error(&e);
        ToolforgeError::new(ErrorCode::Network, format!("请求下载地址失败：{reason}")).with_detail(
            format!(
                "URL：{url}\n\n\
                 常见原因：\n\
                 * **连接被拒 / DNS 失败** —— 这个网络可能屏蔽了该站点，或本地代理没在跑\n\
                 * **TLS 握手失败** —— 中间设备（公司代理、透明加速、抓包工具）替换了证书。\
                 可以用系统自带的 curl 试同一个地址来对照：curl 能下、应用不能下，基本就是这类问题\n\
                 * 也可以手动下载该文件，放进引擎目录后回到「引擎管理」重新探测"
            ),
        )
    })
}

/// 多久**一个字节都没收到**就判定为卡死。
///
/// "连接建立了但服务端不吐数据"这种卡死会一直撑到客户端总超时 ——
/// 用户看到的是一个 **0% 不动、也没有任何解释**的进度条。
/// 真机实测过：`www.gyan.dev` 的连接会挂住，文件停在 0 字节十几分钟。
///
/// 60 秒是个宽容值：正常的慢速网络也会持续有小块到达，
/// 真正卡死是"完全静默"，两者的区别很明显。
///
/// ⚠️ 这个常量与 [`total_download_timeout`] 是**互补**的两件事，不要合并：
/// 这个管"卡死"（要快、要可读），那个只管兜住"有数据但慢到不合理"的极端情况。
const STALL_TIMEOUT: Duration = Duration::from_secs(60);

/// 一次下载的**总时长上限**。
///
/// ## 为什么是 2 小时，而不是原来的 30 分钟
///
/// 原来写的是 30 分钟，当时的理由是"大文件也该够了"。真机把这个假设打破了：
/// gyan.dev 在这台机器上只有 15~43 KB/s，105 MB 的 FFmpeg **需要 40 分钟以上**，
/// 于是出现了一种很尴尬的失败 —— **能连上、一直在下、但永远下不完**，
/// 用户看着进度条走到一半然后报错。
///
/// 现在两者的分工是明确的：卡死交给 [`STALL_TIMEOUT`]（60 秒内给出可读错误），
/// 这个总上限只兜住"每秒几个字节"这类极端情况，所以给得很宽松。
/// **把总上限调大不会让"卡住"更难发现** —— 那不是它的职责。
fn total_download_timeout() -> Duration {
    Duration::from_secs(2 * 3600)
}

/// 把响应体流式写盘，边写边算 SHA-256。
///
/// `stall` 通过参数传入而不是直接用常量，**是为了能被测试**：
/// 一条"卡住 60 秒才报错"的逻辑如果只能靠等 60 秒来验，就没人会去验它。
/// 生产路径传 [`STALL_TIMEOUT`]，测试传几百毫秒。
async fn stream_to_file(
    resp: reqwest::Response,
    dest: &Path,
    label: &str,
    job: &JobCtx,
    tx: Option<tokio::sync::broadcast::Sender<AppEvent>>,
    stall: Duration,
) -> ToolforgeResult<String> {
    use sha2::{Digest, Sha256};

    let total = resp.content_length().unwrap_or(0);
    let url_for_error = resp.url().to_string();
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| ToolforgeError::io(format!("创建文件 {} 失败：{e}", dest.display())))?;

    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let started = std::time::Instant::now();
    let mut last_emit = std::time::Instant::now() - Duration::from_secs(1);
    let mut stream = resp.bytes_stream();

    use futures_util::StreamExt;
    loop {
        // 卡死检测：把"静默"变成一条**说得清的错误**，而不是干等到总超时
        let next = tokio::time::timeout(stall, stream.next()).await;
        let chunk = match next {
            Ok(Some(c)) => c,
            Ok(None) => break, // 正常结束
            Err(_) => {
                let _ = std::fs::remove_file(dest);
                return Err(ToolforgeError::new(
                    ErrorCode::Network,
                    format!(
                        "下载 {label} 卡住了：{} 秒内没有收到任何数据",
                        stall.as_secs_f32()
                    ),
                )
                .with_detail(format!(
                    "已经收到 {}，但连接不再有数据。\nURL：{url_for_error}\n\n\
                     常见原因：对方服务器限速或不可达、代理把大文件拦了。\n\
                     可以重试一次；若反复卡在同一处，就手动下载这个文件放进引擎目录。",
                    if downloaded > 0 {
                        format!("{} KB", downloaded / 1024)
                    } else {
                        "0 字节（连接建立了但服务端没吐数据）".to_string()
                    }
                )));
            }
        };

        job.check()?;
        let chunk = chunk.map_err(|e| {
            ToolforgeError::new(ErrorCode::Network, format!("下载 {label} 中断：{e}"))
        })?;
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|e| ToolforgeError::io(format!("写入失败：{e}")))?;
        downloaded += chunk.len() as u64;

        if last_emit.elapsed() >= Duration::from_millis(500) {
            last_emit = std::time::Instant::now();
            let speed = downloaded as f64 / started.elapsed().as_secs_f64().max(0.001);
            if let Some(tx) = &tx {
                let _ = tx.send(AppEvent::EngineDownloadProgress {
                    engine_id: label.to_string(),
                    downloaded,
                    total,
                    speed_bps: speed,
                });
            }
            let mut p = if total > 0 {
                toolforge_core::job::JobProgress::ratio(
                    format!("下载 {label}"),
                    downloaded,
                    total,
                )
            } else {
                toolforge_core::job::JobProgress::indeterminate(format!("下载 {label}"))
            };
            p.speed = Some(human_speed(speed));
            if total > downloaded {
                p.eta_seconds = Some((total - downloaded) as f64 / speed.max(1.0));
            }
            job.progress(p);
        }
    }

    file.flush()
        .await
        .map_err(|e| ToolforgeError::io(format!("刷新文件失败：{e}")))?;
    drop(file);

    Ok(hex::encode(hasher.finalize()))
}

fn human_speed(bps: f64) -> String {
    const K: f64 = 1024.0;
    if bps < K {
        format!("{bps:.0} B/s")
    } else if bps < K * K {
        format!("{:.1} KB/s", bps / K)
    } else {
        format!("{:.1} MB/s", bps / (K * K))
    }
}

// ============================================================================
// 探测辅助
// ============================================================================

async fn probe_version_of(path: &Path, engine_id: &str) -> Option<String> {
    let args = crate::version_args(engine_id);
    // ⚠️ **参数为空不是"跳过"，而是"不带参数跑一次"**。
    //
    // 这里原来写的是 `if args.is_empty() { return None; }`，直接导致 `7zip` 的版本
    // 永远是「未知」（`version_args("7zip")` 就是空数组，理由见 `lib.rs`）——
    // 而 7-Zip **不带参数就会打印版本横幅并以 0 退出**（本机实测：
    // `7-Zip 26.03 (x64) : Copyright (c) 1999-2026 Igor Pavlov : 2026-09-03`）。
    //
    // 为什么不用 `7z i` 之类"更明确"的参数：`i` 会打印整张格式表，而
    // [`toolforge_process::exec::probe_version`] 用的是 `quiet`（**只留尾部**），
    // 于是真正的版本横幅会被挤掉，取回来的第一行会变成格式表中间某一行。
    // 不带参数时输出很短（横幅 + 用法），不会被截断。
    //
    // 超时是 10 秒，取不到就返回 `None`（版本显示「未知」），所以这里不会挂住探测。
    toolforge_process::exec::probe_version(path, args).await
}

/// Windows 上自动补 `.exe`
fn with_exe_suffix(p: &Path) -> Option<PathBuf> {
    if p.is_file() {
        return Some(p.to_path_buf());
    }
    if cfg!(windows) {
        let mut s = p.as_os_str().to_os_string();
        s.push(".exe");
        let q = PathBuf::from(s);
        if q.is_file() {
            return Some(q);
        }
    }
    None
}

/// 判断 `path` 是不是"名字叫 `name` 的那个可执行文件"。
///
/// # 为什么不能比较 `file_stem`
///
/// 这里原来比的是**文件主干名**（`file_stem`，即去掉最后一个扩展名）：
///
/// ```ignore
/// let stem = entry.path().file_stem()...;         // ❌ 旧写法
/// if stem.eq_ignore_ascii_case(name.trim_end_matches(".exe")) { … }
/// ```
///
/// 于是 `7z.dll` 的主干也是 `7z`，**和 `7z.exe` 一模一样** —— 而 7-Zip 的官方
/// 安装目录里这两个文件都在，`read_dir` 的顺序又把 `7z.dll` 排在前面。
/// 真机后果（本机实测，一次真实的 7-Zip 安装）：引擎被探测为
/// `安装完成：…\engines\7zip\Files\7-Zip\7z.dll（版本 未知）` ——
/// **状态是"已安装"，路径却指向一个 DLL**，之后 `archive.pack` / `archive.unpack`
/// 拿它去 exec 只会失败。这类错误最难查：探测说可用，用起来报的却是别的错。
///
/// 那条路径（`MANAGED_LAYOUT` 命中）用的是 [`with_exe_suffix`]，本来就只认
/// 真文件 / 补 `.exe`，所以问题只出在**递归回退**这一支 —— 而回退恰恰是
/// 平台布局与 `MANAGED_LAYOUT` 不一致时唯一的救生索（例如 Windows 的 7-Zip 在
/// `Files/7-Zip/7z.exe`，而 `MANAGED_LAYOUT` 写的是 `7z`）。
///
/// 所以这里要求**完整文件名**相等：Windows 上按 [`with_exe_suffix`] 的规则
/// （裸名或 `名.exe`），其它平台再要求**可执行位**（tar 会保留它；zip 里没有就
/// 不认，宁可探测不到也不要把一个数据文件当成程序去执行）。
fn is_named_executable(path: &Path, name: &str) -> bool {
    let want: Vec<String> = if cfg!(windows) {
        let bare = name.trim_end_matches(".exe").to_ascii_lowercase();
        vec![bare.clone(), format!("{bare}.exe")]
    } else {
        vec![name.trim_end_matches(".exe").to_string()]
    };
    let Some(file) = path.file_name().and_then(|s| s.to_str()) else {
        return false;
    };
    let file_lc = file.to_ascii_lowercase();
    if !want.iter().any(|w| w.to_ascii_lowercase() == file_lc) {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(md) = std::fs::metadata(path) {
            if md.permissions().mode() & 0o111 == 0 {
                return false;
            }
        }
    }
    true
}

/// 各平台常见安装位置（PATH 里找不到时的兜底）。
fn platform_candidates(engine_id: &str) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();

    if cfg!(windows) {
        let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into());
        let pf86 =
            std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| "C:\\Program Files (x86)".into());
        let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let mut push_glob = |base: &str, pattern: &str| {
            // 用简单的前缀匹配代替完整 glob：目录名带版本号，例如 ImageMagick-7.1.1-Q16
            if let Ok(rd) = std::fs::read_dir(base) {
                for e in rd.flatten() {
                    let name = e.file_name().to_string_lossy().to_string();
                    if name.starts_with(pattern) {
                        out.push(e.path());
                    }
                }
            }
        };

        match engine_id {
            "ffmpeg" => {
                out.push(PathBuf::from("C:\\ffmpeg\\bin\\ffmpeg"));
                out.push(PathBuf::from(&pf).join("ffmpeg\\bin\\ffmpeg"));
                if !local.is_empty() {
                    out.push(PathBuf::from(&local).join("Microsoft\\WinGet\\Links\\ffmpeg"));
                }
            }
            "imagemagick" => {
                push_glob(&pf, "ImageMagick");
                push_glob(&pf86, "ImageMagick");
                out.push(PathBuf::from(&pf).join("ImageMagick\\magick"));
            }
            "libreoffice" => {
                out.push(PathBuf::from(&pf).join("LibreOffice\\program\\soffice"));
            }
            "7zip" => {
                out.push(PathBuf::from(&pf).join("7-Zip\\7z"));
                out.push(PathBuf::from(&pf86).join("7-Zip\\7z"));
            }
            "pandoc" => {
                out.push(PathBuf::from(&pf).join("Pandoc\\pandoc"));
                if !local.is_empty() {
                    out.push(PathBuf::from(&local).join("Pandoc\\pandoc"));
                }
            }
            "tesseract" => {
                out.push(PathBuf::from(&pf).join("Tesseract-OCR\\tesseract"));
            }
            "libvips" => {
                push_glob("C:\\", "vips-dev");
            }
            "calibre" => {
                out.push(PathBuf::from(&pf).join("Calibre2\\ebook-convert"));
            }
            _ => {}
        }
    } else if cfg!(target_os = "macos") {
        match engine_id {
            "ffmpeg" => out.push(PathBuf::from("/opt/homebrew/bin/ffmpeg")),
            "imagemagick" => out.push(PathBuf::from("/opt/homebrew/bin/magick")),
            "libreoffice" => {
                out.push(PathBuf::from("/Applications/LibreOffice.app/Contents/MacOS/soffice"))
            }
            "pandoc" => out.push(PathBuf::from("/opt/homebrew/bin/pandoc")),
            "7zip" => out.push(PathBuf::from("/opt/homebrew/bin/7zz")),
            "libvips" => out.push(PathBuf::from("/opt/homebrew/bin/vips")),
            "tesseract" => out.push(PathBuf::from("/opt/homebrew/bin/tesseract")),
            _ => {}
        }
    } else {
        match engine_id {
            "ffmpeg" => out.push(PathBuf::from("/usr/bin/ffmpeg")),
            "imagemagick" => out.push(PathBuf::from("/usr/bin/magick")),
            "libreoffice" => out.push(PathBuf::from("/usr/bin/soffice")),
            "pandoc" => out.push(PathBuf::from("/usr/bin/pandoc")),
            "7zip" => out.push(PathBuf::from("/usr/bin/7z")),
            "libvips" => out.push(PathBuf::from("/usr/bin/vips")),
            "tesseract" => out.push(PathBuf::from("/usr/bin/tesseract")),
            _ => {}
        }
    }

    out
}

/// 给"这个引擎缺失"配一句可操作的提示。
///
/// ## 为什么它要看 `has_source`
///
/// 它原来只看 `install_modes`，于是**只要引擎声明了 `Download` 就说"可一键下载"** ——
/// 而"声明了下载模式"与"当前平台真的配了下载源"是两件事。
/// 实测踩到的：`imagemagick` 声明 `[System, Download]`，但当时
/// `engine-sources.json` 里**没有** imagemagick 的条目，界面于是显示
/// 「可在引擎管理里一键下载安装」，用户点下去得到的是"当前平台没有配置下载源"。
///
/// 提示语的唯一职责是**别把用户指错方向**，所以调用方必须把
/// "这个平台到底有没有来源"告诉它（`EngineRegistry::has_download_source`）。
fn install_hint(desc: &EngineDescriptor, has_source: bool) -> String {
    match desc.install_modes.as_slice() {
        [EngineInstallMode::System] => format!(
            "需要手动安装：{}（安装后回到「引擎管理」点重新探测）",
            desc.homepage
        ),
        modes if modes.contains(&EngineInstallMode::Download) => {
            if has_source {
                "可在「引擎管理」里一键下载安装".to_string()
            } else {
                // 声明了下载模式却没有来源 —— 说清楚是"这个平台没配"，
                // 并给出唯一可行的替代路径（手动装），而不是让用户去点一个必然失败的按钮
                format!(
                    "当前平台没有配置下载源，请手动安装：{}（安装后回到「引擎管理」点重新探测）",
                    desc.homepage
                )
            }
        }
        _ => "当前平台不支持".to_string(),
    }
}

fn dir_size_mb(dir: &Path) -> Option<f64> {
    if !dir.exists() {
        return None;
    }
    let bytes: u64 = walkdir::WalkDir::new(dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum();
    Some(bytes as f64 / (1024.0 * 1024.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_spec_normalises_hash() {
        let s = EngineSourceSpec {
            id: "x".into(),
            platform: "windows".into(),
            url: "https://e/x.zip".into(),
            sha256: Some("SHA256:ABCDEF".into()),
            archive: "zip".into(),
            strip_components: 0,
            bin_subdir: None,
            note: None,
        };
        assert_eq!(s.expected_hash().unwrap(), "abcdef");
    }

    #[test]
    fn missing_hash_yields_none() {
        let s = EngineSourceSpec {
            id: "x".into(),
            platform: "windows".into(),
            url: "https://e/x.zip".into(),
            sha256: None,
            archive: "zip".into(),
            strip_components: 0,
            bin_subdir: None,
            note: None,
        };
        assert!(s.expected_hash().is_none());
    }

    #[test]
    fn builtin_sources_parse() {
        let list: Vec<EngineSourceSpec> =
            serde_json::from_str(BUILTIN_SOURCES).expect("engine-sources.json 必须是合法 JSON");
        // 每条都必须有 url；sha256 允许为 null（但安装时会被拒绝）
        for s in &list {
            assert!(!s.id.is_empty());
            assert!(!s.url.is_empty(), "{} 缺 url", s.id);
            assert!(
                matches!(s.platform.as_str(), "windows" | "macos" | "linux"),
                "{} 的 platform `{}` 非法",
                s.id,
                s.platform
            );
        }
    }

    /// 声明了「可下载」的引擎，在**当前平台**就必须真的配上下载源。
    ///
    /// 这条不变量是被一个真实缺陷逼出来的：`imagemagick` 声明了
    /// `install_modes: [System, Download]`，而 `engine-sources.json` 里当时没有它 ——
    /// 于是界面显示「可在引擎管理里一键下载安装」，用户点下去拿到的是
    /// "当前平台没有配置下载源"。**提示语把用户指错了方向。**
    ///
    /// 虚拟引擎（`onnx-models` / `ai-provider`）没有本地可执行文件，不受这条约束。
    #[test]
    fn download_mode_engines_have_a_source_for_this_platform() {
        let paths = AppPaths::new(std::env::temp_dir().join("tf-sources-invariant"));
        let reg = EngineRegistry::new(paths);

        for desc in engine_catalog() {
            if desc.install_modes == vec![EngineInstallMode::Remote] {
                continue;
            }
            if VIRTUAL_ENGINES.contains(&desc.id.as_str()) {
                continue;
            }
            if !desc.install_modes.contains(&EngineInstallMode::Download) {
                continue;
            }
            assert!(
                reg.has_download_source(&desc.id),
                "引擎 `{}` 声明了 Download，但 engine-sources.json 在 {} 平台没有它的条目 —— \
                 界面会说「可一键下载安装」，而用户点下去必然失败。\n\
                 要么补上来源（哈希必须真实下载后算出来），要么把 Download 从 install_modes 里去掉。",
                desc.id,
                EngineSourceSpec::platform_key()
            );
        }
    }

    /// **平台无关**的双向核对：`EngineDescriptor::download_platforms` ⟺ `engine-sources.json`。
    ///
    /// ## 为什么原来那条不够
    ///
    /// 上面那条（`download_mode_engines_have_a_source_for_this_platform`）只在
    /// **跑测试的那台机器**上核对：CI 与开发机都是 Windows，于是
    /// `engine-sources.json` 里 macOS / Linux 那几条**从来没被任何测试看过一眼**。
    /// 代价是真实发生过的：
    ///
    /// * `libvips`@macos 指向 `libvips/libvips` 的 release —— 上游**只发源码包**，
    ///   实测 404。这条 URL 是**编出来的**，却因为"平台不匹配所以跳过"活了很久；
    /// * `pandoc`@macos 指向 `.pkg` —— 文件真的存在，但 `.pkg` 不是可分发的归档，
    ///   下载完必然装不上，用户白等 39.8 MB。
    ///
    /// 两条都是"只在当前平台取样"的直接后果。现在把"支持哪些平台一键下载"写成
    /// 数据（`download_platforms`），核对就不再依赖平台了。
    ///
    /// ## 断言的四件事
    ///
    /// 1. `download_platforms` 里的平台名合法、不重复、且是 `platforms` 的子集；
    /// 2. 写了的平台**必须有**来源条目；
    /// 3. 有来源条目的平台**必须写上**（否则 UI 会因为一条多余来源而给出错误承诺）；
    /// 4. `install_modes` 含 `Download` ⟺ `download_platforms` 非空 ——
    ///    两者是同一件事的两种说法，不允许漂移。
    ///
    /// 第 2、3 条合起来是双向的，所以**任何一边漏写都会失败**。
    ///
    /// ## 虚拟引擎为什么跳过第 2、3 条
    ///
    /// `onnx-models` 的可下载物是**模型权重**，写在 `EngineDescriptor::models` 里
    /// （每个模型自带 `url` + `sha256`），入口是 `install_model` 而不是 `install`，
    /// 与 `engine-sources.json`（引擎归档）无关。它的权重是 ONNX 文件，
    /// **三平台同一份字节**，所以三条平台都算数。
    /// `ai-provider` 则是远程服务，没有任何东西要下载。
    /// 第 1、4 条对它们照常生效。
    #[test]
    fn download_platforms_are_backed_by_real_sources() {
        const KNOWN: &[&str] = &["windows", "macos", "linux"];

        let all: Vec<EngineSourceSpec> = serde_json::from_str(BUILTIN_SOURCES)
            .expect("engine-sources.json 必须是合法的 EngineSourceSpec 数组");

        // (id, platform) → 出现次数。用次数而不是集合，是为了让重复条目也失败。
        let mut source_count: std::collections::HashMap<(String, String), usize> =
            std::collections::HashMap::new();
        for s in &all {
            assert!(
                KNOWN.contains(&s.platform.as_str()),
                "{} 的 platform `{}` 非法",
                s.id,
                s.platform
            );
            *source_count
                .entry((s.id.clone(), s.platform.clone()))
                .or_insert(0) += 1;
        }
        for ((id, platform), n) in &source_count {
            assert_eq!(
                *n, 1,
                "`{id}`@{platform} 在 engine-sources.json 里出现了 {n} 次 —— \
                 注册表按 id 建 HashMap，重复条目会**静默丢弃**其中一条"
            );
        }

        let mut claimed: std::collections::HashSet<(String, String)> =
            std::collections::HashSet::new();

        for desc in engine_catalog() {
            let mut seen = std::collections::HashSet::new();
            for p in &desc.download_platforms {
                assert!(
                    KNOWN.contains(&p.as_str()),
                    "`{}` 的 download_platforms 含非法平台名 `{p}`",
                    desc.id
                );
                assert!(
                    seen.insert(p.clone()),
                    "`{}` 的 download_platforms 里 `{p}` 写了两次",
                    desc.id
                );
                assert!(
                    desc.platforms.contains(p),
                    "`{}` 声明在 `{p}` 上可一键下载，但 platforms 里没有 `{p}`",
                    desc.id
                );
                if VIRTUAL_ENGINES.contains(&desc.id.as_str()) {
                    // 虚拟引擎不走 engine-sources.json（见上方文档注释）
                    continue;
                }
                assert!(
                    source_count.contains_key(&(desc.id.clone(), p.clone())),
                    "`{}` 声明 `{p}` 可一键下载，engine-sources.json 里却没有 `{}`@{p} 的条目 —— \
                     界面会给一个点了必然失败的按钮。\n\
                     要么补上真实来源（哈希必须实际下载后算出来），\
                     要么把这个平台从 download_platforms 里去掉。",
                    desc.id,
                    desc.id
                );
                claimed.insert((desc.id.clone(), p.clone()));
            }

            let has_download_mode = desc.install_modes.contains(&EngineInstallMode::Download);
            assert_eq!(
                has_download_mode,
                !desc.download_platforms.is_empty(),
                "`{}` 的 install_modes 与 download_platforms 不一致：\n\
                 install_modes={:?}，download_platforms={:?}\n\
                 含 Download ⟺ download_platforms 非空（两者是同一件事的两种说法）。",
                desc.id,
                desc.install_modes,
                desc.download_platforms
            );
        }

        // 反向：不能有"没人认领"的来源条目 —— 多见于改了引擎 id 之后留下的孤儿，
        // 或者把 `_removed: true` 这种注释对象误当成合法条目。
        for (id, platform) in source_count.keys() {
            assert!(
                claimed.contains(&(id.clone(), platform.clone())),
                "engine-sources.json 里有 `{id}`@{platform}，但引擎目录里没有哪个引擎\
                 在 download_platforms 里认领它 —— 孤儿条目（改过 id？还是删引擎时漏删？）"
            );
        }
    }

    /// **递归回退不能把 `.dll` 当成可执行文件**（真实缺陷的回归测试）。
    ///
    /// 触发场景是 7-Zip 的官方布局：`Files/7-Zip/` 下同时有 `7z.dll` 与 `7z.exe`，
    /// 而 `read_dir` 的顺序把 `7z.dll` 排在前面。旧实现比较的是**文件主干名**
    /// （`file_stem`），两者都是 `7z`，于是引擎被探测为
    /// 「安装完成：…\7z.dll（版本 未知）」—— **状态可用、路径是个 DLL**，
    /// 之后 `archive.*` 拿它去 exec 必然失败。这类"探测说可用、用起来报别的错"
    /// 的缺陷最难查，所以这里同时钉住两件事：只有 DLL 时必须**找不到**；
    /// 补上真正的可执行文件后必须**找到那一个**。
    #[test]
    fn managed_binary_never_returns_a_dll() {
        // Windows 上 7-Zip 的可执行文件叫 `7z.exe`；类 Unix 上是 `7zz`（上游命名如此）
        #[cfg(windows)]
        const REAL: &str = "7z.exe";
        #[cfg(not(windows))]
        const REAL: &str = "7zz";

        let tmp = std::env::temp_dir().join("tf-managed-binary-dll");
        let _ = std::fs::remove_dir_all(&tmp);
        let reg = EngineRegistry::new(AppPaths::new(&tmp));
        let dir = reg.paths().engine_dir("7zip");
        // 复刻真实布局：MSI 管理安装会把文件放在 Files/7-Zip/ 下，比 MANAGED_LAYOUT 深两层
        let inner = dir.join("Files").join("7-Zip");
        std::fs::create_dir_all(&inner).unwrap();

        // ① 只有同名的数据文件 → 必须找不到（旧实现会返回这个 DLL）
        std::fs::write(inner.join("7z.dll"), b"MZ not really a program").unwrap();
        // 一个"看着像"但不在候选名单里的可执行文件也不该被认领
        std::fs::write(inner.join("7zFM.exe"), b"MZ gui").unwrap();
        assert!(
            reg.managed_binary("7zip").is_none(),
            "托管目录里只有 7z.dll / 7zFM.exe 时不该认定 7-Zip 已就位 —— \
             文件名主干相同不等于它是那个程序"
        );

        // ② 放上真正的可执行文件 → 必须找到它（而不是那个 DLL）
        let real = inner.join(REAL);
        std::fs::write(&real, b"MZ real").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut p = std::fs::metadata(&real).unwrap().permissions();
            p.set_mode(0o755);
            std::fs::set_permissions(&real, p).unwrap();
        }
        let found = reg
            .managed_binary("7zip")
            .expect("存在真正的可执行文件时必须找到它");
        assert_eq!(
            found.file_name().and_then(|s| s.to_str()),
            Some(REAL),
            "找到的应当是 {REAL}，不是同名的 .dll"
        );
    }

    /// `archive` 取值必须是已知的那几种，且 `msi` 只能出现在 Windows 上。
    ///
    /// `msi` 走 `msiexec.exe`（`extract_msi`）—— 那个可执行文件**只在 Windows 上存在**。
    /// 一条 `archive: "msi"` 的 Linux/macOS 来源会通过所有其它检查，然后在用户点下
    /// 下载按钮、等了几十 MB 之后报「找不到 msiexec」：正是本项目反复要避免的那种
    /// 「按钮能点、必然失败」。
    ///
    /// 顺带钉住 URL 后缀与 `archive` 一致 ——`url` 指到 `.msi` 而 `archive` 写着 `zip`
    /// 这类复制粘贴事故，只有在这里才拦得住（下载器不看后缀，解压器看）。
    #[test]
    fn archive_kinds_are_known_and_msi_stays_on_windows() {
        struct Kind {
            name: &'static str,
            suffix: &'static str,
        }
        // `raw` 没有后缀约束：它就是把下载到的字节原样当引擎文件（例如单个可执行文件）
        const KINDS: &[Kind] = &[
            Kind { name: "zip", suffix: ".zip" },
            Kind { name: "tar.gz", suffix: ".tar.gz" },
            Kind { name: "tar.xz", suffix: ".tar.xz" },
            Kind { name: "7z", suffix: ".7z" },
            Kind { name: "msi", suffix: ".msi" },
            Kind { name: "raw", suffix: "" },
        ];

        let list: Vec<EngineSourceSpec> = serde_json::from_str(BUILTIN_SOURCES)
            .expect("engine-sources.json 必须是合法的 EngineSourceSpec 数组");
        assert!(!list.is_empty());

        for s in &list {
            let Some(kind) = KINDS.iter().find(|k| k.name == s.archive) else {
                panic!(
                    "{}@{} 的 archive `{}` 不是已知取值（已知：{}）—— \
                     新取值必须在 extract() 里有对应分支，否则解压会失败",
                    s.id,
                    s.platform,
                    s.archive,
                    KINDS.iter().map(|k| k.name).collect::<Vec<_>>().join(" / ")
                );
            };
            if !kind.suffix.is_empty() {
                let path = s.url.split('?').next().unwrap_or(&s.url);
                assert!(
                    path.ends_with(kind.suffix),
                    "{}@{} 的 archive 是 `{}`，但 URL 不是 `{}` 结尾：{}",
                    s.id,
                    s.platform,
                    s.archive,
                    kind.suffix,
                    s.url
                );
            }
            if s.archive == "msi" {
                assert_eq!(
                    s.platform, "windows",
                    "{}@{} 用了 msi 归档，但 `msiexec.exe` 只在 Windows 上存在 —— \
                     这条来源在 {} 上必然失败",
                    s.id, s.platform, s.platform
                );
            }
        }
    }

    /// 提示语不能把用户指错方向：有来源才说"可一键下载"。
    #[test]
    fn install_hint_only_promises_a_download_when_a_source_exists() {
        let paths = AppPaths::new(std::env::temp_dir().join("tf-hint-invariant"));
        let reg = EngineRegistry::new(paths);

        for desc in engine_catalog() {
            let hint = install_hint(&desc, reg.has_download_source(&desc.id));
            if desc.install_modes.contains(&EngineInstallMode::Download) {
                if reg.has_download_source(&desc.id) {
                    assert!(
                        hint.contains("一键下载"),
                        "`{}` 有下载源，提示语应当告诉用户可以一键下载：{hint}",
                        desc.id
                    );
                } else {
                    assert!(
                        !hint.contains("一键下载"),
                        "`{}` 没有下载源，提示语**不能**说可一键下载（用户会白点一次）：{hint}",
                        desc.id
                    );
                    assert!(
                        hint.contains("手动安装"),
                        "没有下载源时应当给出手动安装的出路：{hint}",
                    );
                }
            }
        }
    }

    /// 下载"连上了但一个字节都不吐"时，必须在 `stall` 之后**报错**而不是干等。
    ///
    /// ## 为什么这条测试值得写
    ///
    /// 这个功能是被一次真机事故逼出来的：装 FFmpeg 时进度条停在 **0%** 十几分钟，
    /// 因为服务端连接建立之后不再吐数据，而客户端总超时是 30 分钟。
    /// 用户看到的是一个不动的进度条和零解释。
    ///
    /// 如果只能靠"等 60 秒"来验证它，就没人会验 —— 所以 `stream_to_file` 的
    /// `stall` 是参数，生产传常量、测试传 300 ms。
    ///
    /// 用一个**裸 TCP server** 而不是 mock 库：它要做的事只有一件 ——
    /// 收下请求、回一个声明了 Content-Length 的 200 头、然后**永远沉默**。
    /// 这正是真实事故的形状，而且不加任何依赖。
    #[tokio::test]
    async fn stalled_download_fails_with_a_readable_error() {
        use tokio::io::AsyncWriteExt;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        // 服务端：回响应头 → 不发 body → 挂住（连接保持打开）
        tokio::spawn(async move {
            if let Ok((mut sock, _)) = listener.accept().await {
                let _ = sock
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n\
                          Content-Length: 1048576\r\n\r\n",
                    )
                    .await;
                let _ = sock.flush().await;
                // 故意什么都不再做 —— 保持连接直到测试结束
                tokio::time::sleep(Duration::from_secs(30)).await;
            }
        });

        let dir = std::env::temp_dir().join("tf-stall-test");
        let _ = std::fs::create_dir_all(&dir);
        let dest = dir.join("stalled.bin");
        let _ = std::fs::remove_file(&dest);

        let (tx, _rx) = tokio::sync::broadcast::channel(8);
        let queue = toolforge_core::queue::JobQueue::new(1, tx);
        let job = queue.create(toolforge_core::job::JobKind::Probe, "停滞测试", 1);

        let client = build_download_client(false).unwrap();
        let resp = send_download(&client, &format!("http://{addr}/big.bin"))
            .await
            .expect("连接应当成功（服务端会回响应头）");

        let started = std::time::Instant::now();
        let err = stream_to_file(
            resp,
            &dest,
            "测试文件",
            &job,
            None,
            Duration::from_millis(300),
        )
        .await
        .expect_err("一个字节都没收到时必须报错");

        assert_eq!(err.code, ErrorCode::Network);
        assert!(
            err.message.contains("卡住"),
            "错误信息应当说清是「卡住」而不是笼统的网络错误：{}",
            err.message
        );
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "必须在 stall 之后很快返回，实际用了 {:?}",
            started.elapsed()
        );
        // 半截文件必须被删掉：留一个 0 字节的 .zip 在那儿只会让人以为下过
        assert!(!dest.exists(), "卡死后应当删除未完成的文件");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 不产出可执行文件的"虚拟引擎"。
    ///
    /// * `onnx-models` 是一堆权重文件，没有可执行的入口；
    /// * `ai-provider` 是远程 HTTP 服务。
    ///
    /// 探测器与二进制表都应该跳过它们。
    pub const VIRTUAL_ENGINES: &'static [&'static str] = &["onnx-models", "ai-provider"];

    #[test]
    fn binary_table_covers_catalog_engines() {
        let ids: Vec<&str> = ENGINE_BINARIES.iter().map(|(id, _)| *id).collect();
        for desc in engine_catalog() {
            if VIRTUAL_ENGINES.contains(&desc.id.as_str()) {
                continue;
            }
            assert!(
                ids.contains(&desc.id.as_str()),
                "引擎 `{}` 在 ENGINE_BINARIES 里没有对应条目 —— \
                 新增引擎时必须同时补上可执行文件名，否则永远探测不到",
                desc.id
            );
        }
    }

    #[test]
    fn virtual_engines_have_no_binary_entry() {
        // 反向检查：权重包与远程服务不应该被当成可执行文件去找
        let ids: Vec<&str> = ENGINE_BINARIES.iter().map(|(id, _)| *id).collect();
        for v in VIRTUAL_ENGINES {
            assert!(
                !ids.contains(v),
                "`{v}` 是虚拟引擎，不该出现在 ENGINE_BINARIES 里"
            );
        }
    }

    #[test]
    fn managed_layout_ids_exist_in_catalog() {
        for (id, _) in crate::MANAGED_LAYOUT {
            assert!(
                engine_catalog().iter().any(|e| e.id == *id),
                "MANAGED_LAYOUT 里的 `{id}` 不在引擎目录中"
            );
        }
    }

    #[test]
    fn every_declared_hash_is_a_wellformed_sha256() {
        // 哈希写错一个字符 = 所有用户下载失败。这条测试不验证哈希"对不对"
        // （那需要联网重算），但能挡住长度错误、大写、带 `sha256:` 前缀、
        // 或者不小心粘贴了半截这类低级错误。
        let list: Vec<EngineSourceSpec> = serde_json::from_str(BUILTIN_SOURCES)
            .expect("engine-sources.json 必须是合法的 EngineSourceSpec 数组");
        let mut verified = 0;
        for s in &list {
            let Some(raw) = &s.sha256 else { continue };
            let h = s.expected_hash().expect("sha256 字段存在时应当能规范化");
            assert_eq!(h.len(), 64, "{}@{} 的 sha256 长度不是 64：{h}", s.id, s.platform);
            assert!(
                h.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
                "{}@{} 的 sha256 含非法字符或大写：{h}",
                s.id,
                s.platform
            );
            assert!(raw.is_empty() == false);
            verified += 1;
        }
        // 目前应当至少有 6 条已核对（ffmpeg/libvips Windows、pandoc 两平台、python 两平台）。
        // 这个数字下降说明有人把哈希删了，需要解释原因。
        assert!(
            verified >= 6,
            "已核对的下载源只剩 {verified} 条 —— 是不是误删了 sha256？"
        );
    }

    #[test]
    fn no_source_points_at_a_rolling_latest_alias() {
        // 指向 'latest' 的 URL 会让哈希在上游发新版后立刻失效
        let list: Vec<EngineSourceSpec> = serde_json::from_str(BUILTIN_SOURCES).unwrap();
        for s in &list {
            if s.sha256.is_none() {
                continue; // 没有哈希的条目本来就不参与安装
            }
            let u = s.url.to_ascii_lowercase();
            assert!(
                !u.contains("release-essentials.zip")
                    && !u.contains("/latest")
                    && !u.contains("getrelease")
                    && !u.contains("/releases/latest/download"),
                "{}@{} 指向了滚动别名，哈希会失效：{}",
                s.id,
                s.platform,
                s.url
            );
        }
    }

    #[test]
    fn every_download_mode_engine_has_a_source_entry_or_is_explicitly_absent() {
        // 允许缺失（会在安装时给出 NotConfigured），但不能有语法错误
        let list: Vec<EngineSourceSpec> = serde_json::from_str(BUILTIN_SOURCES).unwrap();
        for s in &list {
            assert!(
                !s.url.contains(' '),
                "{} 的 url 含空格，几乎肯定写错了",
                s.id
            );
        }
    }

    #[tokio::test]
    async fn probe_unknown_engine_is_unsupported() {
        let tmp = std::env::temp_dir().join("tf-engine-test-unknown");
        let reg = EngineRegistry::new(AppPaths::new(&tmp));
        let st = reg.probe("no-such-engine").await;
        assert_eq!(st.state, EngineState::Unsupported);
    }

    #[tokio::test]
    async fn probe_remote_engine_is_detected_without_binary() {
        let tmp = std::env::temp_dir().join("tf-engine-test-remote");
        let reg = EngineRegistry::new(AppPaths::new(&tmp));
        let st = reg.probe("ai-provider").await;
        assert_eq!(st.state, EngineState::Detected);
        assert_eq!(st.source, EngineSource::Remote);
    }

    #[tokio::test]
    async fn resolve_missing_engine_gives_engine_missing_code() {
        let tmp = std::env::temp_dir().join("tf-engine-test-missing");
        let reg = EngineRegistry::new(AppPaths::new(&tmp));
        let err = reg.resolve("ffmpeg").await.unwrap_err();
        // 开发者机器上装了 ffmpeg 的话这条会失败 —— 那是正确行为，
        // 说明探测生效了。CI 上不会装。
        assert!(
            matches!(err.code, ErrorCode::EngineMissing | ErrorCode::EngineFailed),
            "unexpected: {err}"
        );
    }

    #[tokio::test]
    async fn install_refuses_unhashed_source_without_explicit_consent() {
        // ⚠️ 这个测试**绝不能触发真实下载**。
        //
        // 它最初写成"直接对 ffmpeg 调 install，期望拿到 HashRequired" —— 那在
        // `engine-sources.json` 里所有 sha256 都是 null 时成立。后来我们回填了
        // ffmpeg 的真实哈希，于是这个测试开始**默默下载 104 MB 的 FFmpeg**。
        //
        // 现在改成用临时来源文件把 libvips 的哈希置空，与真实数据解耦：
        // 既不会联网，也不会因为数据更新而失效。
        let tmp = std::env::temp_dir().join("tf-engine-test-nohash");
        let _ = std::fs::remove_dir_all(&tmp);
        let paths = AppPaths::new(&tmp);
        paths.ensure_all().unwrap();

        let platform = EngineSourceSpec::platform_key();
        let sources_file = tmp.join("sources.json");
        std::fs::write(
            &sources_file,
            serde_json::json!([{
                "id": "libvips",
                "platform": platform,
                "url": "https://example.invalid/vips.zip",
                "sha256": serde_json::Value::Null,
                "archive": "zip",
                "stripComponents": 1
            }])
            .to_string(),
        )
        .unwrap();

        let mut reg = EngineRegistry::new(paths);
        assert_eq!(reg.load_sources_file(&sources_file).unwrap(), 1);

        let (tx, _rx) = tokio::sync::broadcast::channel(16);
        let q = toolforge_core::queue::JobQueue::new(1, tx);
        let ctx = q.create(
            toolforge_core::job::JobKind::EngineInstall {
                engine_id: "libvips".into(),
            },
            "test",
            0,
        );

        match reg.install("libvips", &ctx, false, false).await.unwrap() {
            // 本机装了 libvips 的话会走这条 —— 那也是正确行为
            EngineInstallOutcome::AlreadyAvailable { .. } => {}
            EngineInstallOutcome::HashRequired { reason } => {
                assert!(reason.contains("SHA-256"), "提示应当说清楚缺什么：{reason}");
            }
            other => panic!("缺哈希时必须拒绝安装，实际得到：{other:?}"),
        }

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn system_only_engine_reports_not_configured_instead_of_downloading() {
        // libreoffice 在目录里是 System-only：install 必须**明确拒绝**并给出
        // 手动安装指引，而不是去找一个不存在的下载源、也不是静默成功。
        let tmp = std::env::temp_dir().join("tf-engine-test-systemonly");
        let _ = std::fs::remove_dir_all(&tmp);
        let paths = AppPaths::new(&tmp);
        paths.ensure_all().unwrap();
        let reg = EngineRegistry::new(paths);

        let (tx, _rx) = tokio::sync::broadcast::channel(16);
        let q = toolforge_core::queue::JobQueue::new(1, tx);
        let ctx = q.create(
            toolforge_core::job::JobKind::EngineInstall {
                engine_id: "libreoffice".into(),
            },
            "test",
            0,
        );

        match reg.install("libreoffice", &ctx, false, false).await.unwrap() {
            EngineInstallOutcome::AlreadyAvailable { .. } => {}
            EngineInstallOutcome::NotConfigured { reason } => {
                assert!(
                    reason.contains("系统安装") || reason.contains("手动"),
                    "应当给出可操作的手动安装指引：{reason}"
                );
            }
            other => panic!("System-only 引擎不该走下载路径：{other:?}"),
        }

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
