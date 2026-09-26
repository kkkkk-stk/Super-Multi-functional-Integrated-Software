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
///    被替换的文件"。本仓库当前的做法：ffmpeg 取自 gyan.dev 随包发布的
///    `.sha256` 旁挂文件（那是上游自己的摘要，比自己算更可信），其余是自己流式
///    下载后计算的 SHA-256。
/// 2. **URL 必须指向版本固定直链**，不能是 `/latest` 之类的滚动别名 ——
///    上游一发新版哈希就失效，表现为"昨天还能装、今天全部失败"。
///    `ffmpeg-release-essentials.zip` 就属于这类，已换成
///    `packages/ffmpeg-8.1.2-essentials_build.zip`。
/// 3. **未核对的条目不编造哈希**，`sha256` 留 `null` 并在 `note` 里说明原因。
///    [`EngineRegistry::install`] 会对它们返回
///    [`EngineInstallOutcome::HashRequired`] 而不是放行 —— 这是刻意的安全默认值。
///
/// 验证过的可用条目（2026-09 实测）：`ffmpeg`@windows、`libvips`@windows、
/// `pandoc`@windows/linux、`python`@windows/linux。macOS 的三条都留了 `null`，
/// 因为仓库里没有 macOS 环境可以核对；macOS 用户应走 Homebrew（系统安装模式）。
///
/// 注意：该文件反序列化成 `Vec<Self>`，**不能放注释用的对象**（缺必填字段会让
/// 整个文件解析失败，而 [Self] 的加载是 `if let Ok(..)`，会静默退化成"零个来源"）。
/// 单元测试 `builtin_sources_parse` 守着这一点。
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
    /// `zip` / `tar.gz` / `tar.xz` / `7z` / `raw`
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
    pub sha256: Option<String>,
    /// 目标文件名
    pub file_name: String,
    /// 是否允许商用（来自 [`toolforge_core::engine::EngineModel`]，此处冗余一份便于独立校验）
    #[serde(default)]
    pub commercial_use: bool,
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
        Self {
            paths,
            cache: DashMap::new(),
            sources,
            models: HashMap::new(),
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
        s.message = Some(install_hint(&desc));
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
                if entry.file_type().is_file() {
                    let stem = entry
                        .path()
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or_default();
                    if stem.eq_ignore_ascii_case(name.trim_end_matches(".exe")) {
                        return Some(entry.path().to_path_buf());
                    }
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
                    .filter(|m| self.paths.model_dir(&m.id).join(format!("{}.onnx", m.id)).exists())
                    .map(|m| m.id.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    // ---------------- 安装 ----------------

    /// 按需安装引擎。
    ///
    /// `allow_unverified` 必须显式传 `true` 才会接受没有哈希的来源 ——
    /// 调用方（Tauri 命令层）会把它接到一个需要用户二次确认的 UI 上。
    pub async fn install(
        &self,
        engine_id: &str,
        job: &JobCtx,
        allow_unverified: bool,
    ) -> ToolforgeResult<EngineInstallOutcome> {
        // 已经有得用就不下载
        let st = self.probe(engine_id).await;
        if st.state.is_usable() {
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

    /// 下载一个模型权重
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

        let dir = self.paths.model_dir(&spec.engine_id);
        std::fs::create_dir_all(&dir)
            .map_err(|e| ToolforgeError::io(format!("创建模型目录失败：{e}")))?;
        let dest = dir.join(&spec.file_name);

        let actual = download(&spec.url, &dest, model_id, job, self.tx.clone()).await?;
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

// ============================================================================
// 下载实现
// ============================================================================

/// 流式下载到文件，同时计算 SHA-256，并按 500ms 节流上报进度。
pub async fn download(
    url: &str,
    dest: &Path,
    label: &str,
    job: &JobCtx,
    tx: Option<tokio::sync::broadcast::Sender<AppEvent>>,
) -> ToolforgeResult<String> {
    use sha2::{Digest, Sha256};

    let client = reqwest::Client::builder()
        .user_agent(concat!("ToolForge/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(60 * 30))
        .build()
        .map_err(|e| ToolforgeError::new(ErrorCode::Network, format!("创建 HTTP 客户端失败：{e}")))?;

    let resp = client.get(url).send().await.map_err(|e| {
        ToolforgeError::new(ErrorCode::Network, format!("下载 {label} 失败：{e}"))
            .with_detail(format!("URL：{url}"))
    })?;

    if !resp.status().is_success() {
        return Err(ToolforgeError::new(
            ErrorCode::Network,
            format!("下载 {label} 失败：HTTP {}", resp.status()),
        )
        .with_detail(format!("URL：{url}")));
    }

    let total = resp.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| ToolforgeError::io(format!("创建文件 {} 失败：{e}", dest.display())))?;

    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let started = std::time::Instant::now();
    let mut last_emit = std::time::Instant::now() - Duration::from_secs(1);
    let mut stream = resp.bytes_stream();

    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
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
    if args.is_empty() {
        return None;
    }
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

fn install_hint(desc: &EngineDescriptor) -> String {
    match desc.install_modes.as_slice() {
        [EngineInstallMode::System] => format!(
            "需要手动安装：{}（安装后回到「引擎管理」点重新探测）",
            desc.homepage
        ),
        modes if modes.contains(&EngineInstallMode::Download) => {
            "可在「引擎管理」里一键下载安装".to_string()
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

        match reg.install("libvips", &ctx, false).await.unwrap() {
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

        match reg.install("libreoffice", &ctx, false).await.unwrap() {
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
