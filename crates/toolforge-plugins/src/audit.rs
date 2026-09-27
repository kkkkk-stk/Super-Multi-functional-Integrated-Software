//! 审计日志。
//!
//! ## 为什么插件系统必须要审计
//!
//! 因为最危险的情况不是"插件被拒绝"，而是"插件**做了**某件用户没意识到的事"。
//! 没有审计日志，用户在事后完全无法回答：
//!
//! * 我什么时候授权了这个插件读我的整个 D 盘？
//! * 这个插件的哪个版本开始多要了 `exec` 权限？
//! * 昨天有没有插件尝试越权？被拦住了吗？
//!
//! 格式用 NDJSON（每行一个 JSON 对象）而不是普通日志：**追加写不会破坏已有内容**，
//! 而且可以直接 `Select-String` / `jq` 过滤。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use specta::Type;

use toolforge_core::error::{ToolforgeError, ToolforgeResult};
use toolforge_core::paths::AppPaths;

/// 审计事件类型。**只增不改**：改名会让历史日志失去可读性。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AuditEventKind {
    /// 插件被安装
    Installed,
    /// 插件被卸载
    Uninstalled,
    /// 用户授予了能力
    PermissionGranted,
    /// 用户收回了能力
    PermissionRevoked,
    /// **检测到权限扩张**（新版本声明了旧版本没有的能力）
    PrivilegeEscalation,
    /// **运行时越权被拦截** —— 用了没声明/没授权的能力
    CapabilityViolation,
    /// **路径逃逸被拦截** —— 插件试图访问授权根之外的路径。
    ///
    /// 与 [`AuditEventKind::CapabilityViolation`] 分开记，因为它们的**排查含义不同**：
    /// 前者是"插件声明漏了/用户没授权"，后者是"有人在试探沙箱边界"。
    /// 事后取证时这两件事的严重程度不一样，混在一起就分不出来了。
    ///
    /// 这条是被一次真机测试逼出来的：我装了一个步骤里写死
    /// `C:\Windows\System32\drivers\etc\hosts` 的恶意插件并运行，任务被正确拒绝，
    /// **但审计日志里什么都没有** —— 因为拦截来自 `PathResolver`（`PermissionDenied`），
    /// 而当时的审计钩子只认能力裁决的 `PluginCapabilityViolation`。
    PathEscapeBlocked,
    /// 清单校验失败
    ValidationFailed,
    /// 哈希不匹配（装载时或下载时）
    IntegrityFailure,
    /// AI 生成的插件通过审核并落盘
    AiDraftAccepted,
    /// AI 生成的插件被拒绝
    AiDraftRejected,
    /// 用户确认了某个引擎/权重的许可证条款（合规证据链）
    LicenseAccepted,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    /// ISO-8601
    pub at: String,
    pub kind: AuditEventKind,
    /// 相关插件 / 引擎 / 请求的标识
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    /// 人类可读的摘要
    pub summary: String,
    /// 结构化补充信息，**以 JSON 文本形式存放**。
    ///
    /// 为什么不用 `serde_json::Value`：它是无界递归类型
    /// （`Value` → `Vec<Value>` → `Value`），specta 导出时会产生无限展开的 TS 类型
    /// 并直接报错。存成字符串后前端按需 `JSON.parse(e.detail)` 即可，
    /// 而写入端（[`AuditEvent::detail`]）仍然接受结构化值。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl AuditEvent {
    pub fn new(kind: AuditEventKind, summary: impl Into<String>) -> Self {
        Self {
            at: toolforge_core::job::now_iso(),
            kind,
            subject: None,
            summary: summary.into(),
            detail: None,
        }
    }

    pub fn subject(mut self, s: impl Into<String>) -> Self {
        self.subject = Some(s.into());
        self
    }

    /// 写结构化详情；内部序列化成 JSON 文本
    pub fn detail(mut self, d: serde_json::Value) -> Self {
        self.detail = Some(d.to_string());
        self
    }
}

/// 审计日志写入器。
///
/// 写入失败**不能**让业务失败（磁盘满不该导致插件装不上），所以全部吞掉错误并
/// 记一条 tracing::error —— 但要保证这件事是可见的。
#[derive(Clone)]
pub struct AuditLog {
    dir: PathBuf,
}

impl AuditLog {
    pub fn new(paths: &AppPaths) -> Self {
        Self { dir: paths.audit() }
    }

    pub fn from_dir(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// 当天的日志文件路径
    pub fn current_file(&self) -> PathBuf {
        let day = chrono_day();
        self.dir.join(format!("audit-{day}.ndjson"))
    }

    /// 追加一条事件
    pub fn record(&self, event: AuditEvent) {
        if let Err(e) = self.try_record(&event) {
            tracing::error!(error = %e, "审计日志写入失败（业务继续，但这是需要处理的问题）");
        }
    }

    fn try_record(&self, event: &AuditEvent) -> std::io::Result<()> {
        use std::io::Write;
        std::fs::create_dir_all(&self.dir)?;
        let line = serde_json::to_string(event)
            .unwrap_or_else(|_| format!("{{\"kind\":\"internal\",\"at\":\"{}\"}}", event.at));
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.current_file())?;
        writeln!(f, "{line}")?;
        Ok(())
    }

    /// 读取最近 N 条（给「安全」页展示）
    pub fn tail(&self, limit: usize) -> Vec<AuditEvent> {
        let Ok(text) = std::fs::read_to_string(self.current_file()) else {
            return vec![];
        };
        let mut out: Vec<AuditEvent> = text
            .lines()
            .rev()
            .take(limit)
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect();
        out.reverse();
        out
    }

    /// 列出所有审计文件（按日期倒序）
    pub fn files(&self) -> Vec<PathBuf> {
        let Ok(rd) = std::fs::read_dir(&self.dir) else {
            return vec![];
        };
        let mut v: Vec<PathBuf> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().map(|e| e == "ndjson").unwrap_or(false))
            .collect();
        v.sort();
        v.reverse();
        v
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }
}

/// `YYYY-MM-DD`（UTC）。不引 chrono 只为一个日期字符串不值当。
fn chrono_day() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = now / 86_400;
    // 从 1970-01-01 起算的民用历法换算
    let (y, m, d) = civil_from_days(days as i64);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Howard Hinnant 的 civil_from_days 算法
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 便捷：记录一次越权（最重要的安全事件）
pub fn record_violation(log: &AuditLog, plugin_id: &str, what: &str) {
    log.record(
        AuditEvent::new(
            AuditEventKind::CapabilityViolation,
            format!("插件尝试使用未声明的能力：{what}"),
        )
        .subject(plugin_id)
        .detail(serde_json::json!({ "request": what })),
    );
}

/// 便捷：记录一次权限扩张
pub fn record_escalation(
    log: &AuditLog,
    plugin_id: &str,
    added: &[String],
    version_from: &str,
    version_to: &str,
) {
    log.record(
        AuditEvent::new(
            AuditEventKind::PrivilegeEscalation,
            format!(
                "插件从 {version_from} 升级到 {version_to} 时新增了 {} 项能力声明",
                added.len()
            ),
        )
        .subject(plugin_id)
        .detail(serde_json::json!({ "added": added })),
    );
}

/// 便捷：记录一次完整性失败
pub fn record_integrity(log: &AuditLog, subject: &str, expected: &str, actual: &str) {
    log.record(
        AuditEvent::new(
            AuditEventKind::IntegrityFailure,
            "内容哈希与记录不符，已拒绝装载".to_string(),
        )
        .subject(subject)
        .detail(serde_json::json!({ "expected": expected, "actual": actual })),
    );
}

/// 计算插件目录的内容哈希。
///
/// 用于锁定"用户审核过的就是将要执行的那份"。规则：
/// * 只对**代码与清单**做哈希，跳过 `.data/`、`.venv/`、`__pycache__/`、`node_modules/`
///   —— 这些是运行期产物，会变化但不影响语义。
/// * 路径参与哈希，所以"把 a.py 改名成 b.py"也会被检出。
/// * 按相对路径排序，保证结果与文件系统枚举顺序无关。
pub fn content_hash(plugin_dir: &Path) -> ToolforgeResult<String> {
    use sha2::{Digest, Sha256};

    const SKIP_DIRS: &[&str] = &[".data", ".venv", "__pycache__", "node_modules", ".git"];
    const SKIP_EXT: &[&str] = &["pyc", "pyo", "log", "tmp"];
    /// 宿主自己写的状态文件必须排除。
    ///
    /// 否则会出现一个荒谬的循环：安装时算哈希 → **然后才**写状态文件 →
    /// 下次校验时哈希已经变了 → 每个插件一装好就被判定为"被篡改"并自动禁用。
    /// 单元测试 `integrity_check_detects_tampering` 抓到了这个 bug。
    const SKIP_FILES: &[&str] = &[".toolforge-state.json"];

    let mut entries: Vec<(String, PathBuf)> = Vec::new();
    for e in walkdir::WalkDir::new(plugin_dir)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            let name = e.file_name().to_string_lossy().to_string();
            !SKIP_DIRS.contains(&name.as_str())
        })
        .filter_map(|e| e.ok())
    {
        if !e.file_type().is_file() {
            continue;
        }
        let p = e.path();
        if let Some(name) = p.file_name().and_then(|s| s.to_str()) {
            if SKIP_FILES.contains(&name) {
                continue;
            }
        }
        if let Some(ext) = p.extension().and_then(|s| s.to_str()) {
            if SKIP_EXT.contains(&ext) {
                continue;
            }
        }
        let rel = p
            .strip_prefix(plugin_dir)
            .unwrap_or(p)
            .to_string_lossy()
            .replace('\\', "/");
        entries.push((rel, p.to_path_buf()));
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));

    let mut hasher = Sha256::new();
    for (rel, path) in entries {
        hasher.update(rel.as_bytes());
        hasher.update([0u8]);
        let bytes = std::fs::read(&path)
            .map_err(|e| ToolforgeError::io(format!("读取 {} 失败：{e}", path.display())))?;
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(&bytes);
    }
    Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_hash_is_stable_and_order_independent() {
        let dir = std::env::temp_dir().join("tf-hash-test-1");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("plugin.yaml"), b"apiVersion: toolforge/v1").unwrap();
        std::fs::write(dir.join("main.py"), b"print('hi')").unwrap();

        let h1 = content_hash(&dir).unwrap();
        let h2 = content_hash(&dir).unwrap();
        assert_eq!(h1, h2, "同一份内容必须得到同一个哈希");
        assert!(h1.starts_with("sha256:"));

        // 内容变了，哈希必须变
        std::fs::write(dir.join("main.py"), b"print('bye')").unwrap();
        assert_ne!(content_hash(&dir).unwrap(), h1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn content_hash_ignores_runtime_dirs() {
        let dir = std::env::temp_dir().join("tf-hash-test-2");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".venv")).unwrap();
        std::fs::create_dir_all(dir.join(".data")).unwrap();
        std::fs::write(dir.join("plugin.yaml"), b"x").unwrap();
        let base = content_hash(&dir).unwrap();

        // 运行期产生的文件不应改变哈希 —— 否则每次跑完都"哈希不匹配"
        std::fs::write(dir.join(".data").join("cache.json"), b"{}").unwrap();
        std::fs::write(dir.join(".venv").join("pyvenv.cfg"), b"home=...").unwrap();
        assert_eq!(content_hash(&dir).unwrap(), base);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn content_hash_ignores_host_written_state_file() {
        // 回归测试：宿主在算完哈希之后才写 .toolforge-state.json，
        // 如果它参与哈希，每个插件一装好就会被判定为"被篡改"。
        let dir = std::env::temp_dir().join("tf-hash-test-state");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("plugin.yaml"), b"apiVersion: toolforge/v1").unwrap();
        let base = content_hash(&dir).unwrap();

        std::fs::write(dir.join(".toolforge-state.json"), b"{\"enabled\":true}").unwrap();
        assert_eq!(
            content_hash(&dir).unwrap(),
            base,
            "宿主自己的状态文件不能参与内容哈希"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn content_hash_detects_rename() {
        let dir = std::env::temp_dir().join("tf-hash-test-3");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.py"), b"same-bytes").unwrap();
        let h1 = content_hash(&dir).unwrap();
        std::fs::rename(dir.join("a.py"), dir.join("b.py")).unwrap();
        assert_ne!(content_hash(&dir).unwrap(), h1, "改名也要被检出");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn audit_ndjson_roundtrip() {
        let dir = std::env::temp_dir().join("tf-audit-test");
        let _ = std::fs::remove_dir_all(&dir);
        let log = AuditLog::from_dir(&dir);

        log.record(
            AuditEvent::new(AuditEventKind::PermissionGranted, "授予 fsRead")
                .subject("com.example.a"),
        );
        record_violation(&log, "com.example.a", "启动进程 curl");
        record_escalation(&log, "com.example.a", &["Exec".into()], "1.0.0", "1.1.0");

        let tail = log.tail(10);
        assert_eq!(tail.len(), 3);
        // tail 按时间正序返回
        assert_eq!(tail[0].kind, AuditEventKind::PermissionGranted);
        assert_eq!(tail[2].kind, AuditEventKind::PrivilegeEscalation);
        // detail 是 JSON 文本，解析后结构完整
        let detail: serde_json::Value =
            serde_json::from_str(tail[2].detail.as_ref().unwrap()).unwrap();
        assert_eq!(detail["added"][0], "Exec");

        assert_eq!(log.files().len(), 1, "应当只有一个当天的日志文件");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn audit_write_failure_does_not_panic() {
        // 指向一个不可能创建的路径（Windows 上非法字符）
        let log = AuditLog::from_dir("Z:\\definitely\\not\\a\\real\\drive");
        log.record(AuditEvent::new(AuditEventKind::Installed, "x")); // 不应 panic
        assert!(log.tail(5).is_empty());
    }

    #[test]
    fn civil_from_days_matches_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
        assert_eq!(civil_from_days(19_814), (2024, 4, 1));
    }

    #[test]
    fn current_file_has_expected_name_shape() {
        let log = AuditLog::from_dir("/tmp/x");
        let name = log
            .current_file()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert!(name.starts_with("audit-"), "{name}");
        assert!(name.ends_with(".ndjson"), "{name}");
        // audit-YYYY-MM-DD.ndjson
        assert_eq!(name.len(), "audit-2024-01-01.ndjson".len());
    }
}
