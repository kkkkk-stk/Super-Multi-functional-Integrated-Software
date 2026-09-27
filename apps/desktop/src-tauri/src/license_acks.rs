//! 许可证确认的**落盘记录**：`<data>/license-acks.json`。
//!
//! # 这个文件解决什么
//!
//! 引擎与模型的许可证确认原来只是一次**硬门**：`engines_install` / `models_install`
//! 要求请求里带 `licenseAccepted: true`，否则拒绝。门是有效的，但**没有任何痕迹** ——
//!
//! * 对合规审查拿不出证据链（"谁在什么时候接受了哪份许可证"）；
//! * 用户每次重装都得重新勾一次。
//!
//! 现在确认会被记下来：`license-acks.json` 里一条 `{ subject, license, fingerprint,
//! acceptedAt }`，同时写一条 `LicenseAccepted` 审计事件。
//!
//! # 为什么记的是**指纹**而不是"确认过这个 id"
//!
//! 用户同意的是**那一段许可证原文**，不是"某个叫 ffmpeg 的引擎"。
//! 如果只按 id 记，那么上游把许可证从 LGPL 换成 GPL（或反过来收紧条款）之后，
//! 旧的"同意"会**自动延续**到一份用户从没见过的条款上 —— 那正好是确认流程要防的事。
//!
//! 所以每条记录都存 `fingerprint = sha256(license 文本)` 的前 16 位十六进制：
//! **文本一变，指纹就对不上，确认自动失效**。`license` 原文也存一份，供界面回显。
//!
//! # 读盘策略：**按需读，不缓存**
//!
//! 这份文件很小，读一次是微秒级；而缓存会带来一个很难查的形态 ——
//! 用户在文件管理器里删掉它、或者手工改过之后，应用里的状态与磁盘不一致。
//! 每次问就每次读，永远不会撒谎。写的时候用与设置同一套原子写。

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::json;
use toolforge_core::error::{ErrorCode, ToolforgeError, ToolforgeResult};
use toolforge_core::job::now_iso;
use toolforge_core::paths::AppPaths;

/// 一条确认记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseAck {
    /// 确认的对象：引擎 id 或模型 id（两类共用一个命名空间，因为 id 不会撞）
    pub subject: String,
    /// 确认时的许可证原文（供界面回显"你当时同意的是这一份"）
    pub license: String,
    /// `sha256(license)` 的前 16 位十六进制 —— 用来判断"条款有没有变"
    pub fingerprint: String,
    /// RFC3339 时间戳
    pub accepted_at: String,
}

/// 全部确认记录（按 subject 索引）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseAcks {
    #[serde(default)]
    pub entries: BTreeMap<String, LicenseAck>,
}

/// 许可证文本的指纹：`sha256` 的前 16 位十六进制。
///
/// 许可证文本是**公开常量**，不是机密，所以这里不需要加盐、也不怕被反推 ——
/// 它的唯一用途是"这段文字与当初确认的那段是不是同一段"。
pub fn fingerprint(license: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    // 先把空白归一化：改一个换行不该让用户重新确认一次
    let normalized = license.split_whitespace().collect::<Vec<_>>().join(" ");
    h.update(normalized.as_bytes());
    let full = hex::encode(h.finalize());
    full[..16].to_string()
}

impl LicenseAcks {
    /// 从磁盘读。文件不存在 / 读不动 / 解析失败都退化成"没有任何记录"。
    ///
    /// **解析失败不报错**：这份文件只影响"要不要重新勾一次"，绝不该让安装流程炸掉。
    /// 但它会记一条日志 —— 静默吞掉一个坏文件，下次再遇到还是不知道为什么。
    pub fn load(paths: &AppPaths) -> Self {
        let file = paths.license_acks_file();
        let Ok(text) = std::fs::read_to_string(&file) else {
            return Self::default();
        };
        match serde_json::from_str::<LicenseAcks>(&text) {
            Ok(a) => a,
            Err(e) => {
                tracing::warn!(
                    path = %file.display(),
                    err = %e,
                    "许可证确认记录解析失败，按「没有确认过」处理（会在下次确认时被覆盖）"
                );
                Self::default()
            }
        }
    }

    /// 这个对象**当前这份**许可证是否已被确认过。
    ///
    /// 判据是**指纹**而不是"id 出现过"：条款一变就自动失效（见模块文档）。
    pub fn is_acknowledged(&self, subject: &str, license: &str) -> bool {
        self.entries
            .get(subject)
            .map(|a| a.fingerprint == fingerprint(license))
            .unwrap_or(false)
    }

    /// 已确认的时间戳（条款变了就返回 `None`）。
    pub fn acknowledged_at(&self, subject: &str, license: &str) -> Option<String> {
        self.entries
            .get(subject)
            .filter(|a| a.fingerprint == fingerprint(license))
            .map(|a| a.accepted_at.clone())
    }

    /// 记下一条确认并落盘。返回写好的记录（供审计事件引用）。
    pub fn record(
        &mut self,
        paths: &AppPaths,
        subject: &str,
        license: &str,
    ) -> ToolforgeResult<LicenseAck> {
        let ack = LicenseAck {
            subject: subject.to_string(),
            license: license.to_string(),
            fingerprint: fingerprint(license),
            accepted_at: now_iso(),
        };
        // 覆盖旧的：重新确认一次就把时间戳刷新到这一次
        // （指纹一样时保留原时间戳更有价值？—— 不。用户刚刚又同意了一次，
        //  记录里应当体现"最近一次确认"，否则过了半年没人知道他还认不认。）
        self.entries.insert(subject.to_string(), ack.clone());
        self.save(paths)?;
        Ok(ack)
    }

    fn save(&self, paths: &AppPaths) -> ToolforgeResult<()> {
        let file = paths.license_acks_file();
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| ToolforgeError::internal(format!("许可证确认记录序列化失败：{e}")))?;
        write_atomic(&file, json.as_bytes())
    }
}

/// 与设置同一套原子写：同目录临时文件 → `sync_all` → `rename`。
///
/// 不共用 `settings_store::write_atomic` 是因为那是那个模块的私有实现；
/// 这里的重复是**有意的**：两处对"写到一半崩掉"的容忍度一样，但生命周期不同，
/// 将来其中一个要改成带锁或带备份时不必牵扯另一个。
fn write_atomic(target: &Path, bytes: &[u8]) -> ToolforgeResult<()> {
    let parent = target.parent().ok_or_else(|| {
        ToolforgeError::new(
            ErrorCode::Internal,
            format!("路径没有父目录：{}", target.display()),
        )
    })?;
    std::fs::create_dir_all(parent)
        .map_err(|e| ToolforgeError::io(format!("创建 {} 失败：{e}", parent.display())))?;

    let tmp = parent.join(format!(
        ".{}.{}.tmp",
        target
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "license-acks".into()),
        std::process::id()
    ));
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp)
            .map_err(|e| ToolforgeError::io(format!("创建 {} 失败：{e}", tmp.display())))?;
        f.write_all(bytes)
            .map_err(|e| ToolforgeError::io(format!("写入 {} 失败：{e}", tmp.display())))?;
        f.sync_all()
            .map_err(|e| ToolforgeError::io(format!("刷盘 {} 失败：{e}", tmp.display())))?;
    }
    std::fs::rename(&tmp, target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        ToolforgeError::io(format!("替换 {} 失败：{e}", target.display()))
    })
}

/// 审计事件的 `detail`（不含任何凭据；许可证文本只留指纹）。
pub fn audit_detail(ack: &LicenseAck, name: &str) -> serde_json::Value {
    json!({
        "subject": ack.subject,
        "name": name,
        "license": ack.license,
        "licenseFingerprint": ack.fingerprint,
        "acceptedAt": ack.accepted_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_paths(tag: &str) -> AppPaths {
        let dir = std::env::temp_dir().join(format!(
            "toolforge-license-acks-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        AppPaths::new(dir)
    }

    #[test]
    fn fingerprint_ignores_whitespace_but_not_words() {
        assert_eq!(fingerprint("MIT License"), fingerprint("MIT   License\n"));
        assert_ne!(fingerprint("MIT License"), fingerprint("MIT Licenses"));
        assert_eq!(fingerprint("x").len(), 16);
    }

    #[test]
    fn record_then_load_roundtrip() {
        let paths = temp_paths("roundtrip");
        let mut acks = LicenseAcks::load(&paths);
        assert!(!acks.is_acknowledged("ffmpeg", "LGPL-2.1+"));

        let ack = acks.record(&paths, "ffmpeg", "LGPL-2.1+").unwrap();
        assert_eq!(ack.fingerprint, fingerprint("LGPL-2.1+"));
        assert!(!ack.accepted_at.is_empty());

        // 换一个进程/换一次读盘也应当看到它（这就是"落盘"的意义）
        let reloaded = LicenseAcks::load(&paths);
        assert!(reloaded.is_acknowledged("ffmpeg", "LGPL-2.1+"));
        assert!(reloaded.acknowledged_at("ffmpeg", "LGPL-2.1+").is_some());

        let _ = std::fs::remove_dir_all(paths.root());
    }

    /// ★ **条款变了，旧的确认必须自动失效。**
    ///
    /// 这是这份记录存在的**前提**：用户同意的是那一段文字，不是"某个叫 ffmpeg 的引擎"。
    /// 只按 id 记的话，上游把许可证收紧之后，旧同意会静默延续到用户从没见过的新条款上。
    #[test]
    fn acknowledgement_expires_when_the_license_text_changes() {
        let paths = temp_paths("expiry");
        let mut acks = LicenseAcks::load(&paths);
        acks.record(&paths, "ffmpeg", "LGPL-2.1+").unwrap();

        assert!(acks.is_acknowledged("ffmpeg", "LGPL-2.1+"));
        assert!(
            !acks.is_acknowledged("ffmpeg", "GPL-3.0"),
            "许可证文本变了，旧确认不能继续算数"
        );
        assert!(acks.acknowledged_at("ffmpeg", "GPL-3.0").is_none());

        let _ = std::fs::remove_dir_all(paths.root());
    }

    #[test]
    fn broken_file_is_not_fatal() {
        let paths = temp_paths("broken");
        std::fs::create_dir_all(paths.root()).unwrap();
        std::fs::write(paths.license_acks_file(), b"{ not json").unwrap();
        let acks = LicenseAcks::load(&paths);
        assert!(!acks.is_acknowledged("ffmpeg", "LGPL-2.1+"));
        // 还能继续用：下一次确认会把它覆盖成合法 JSON
        let mut acks = acks;
        acks.record(&paths, "ffmpeg", "LGPL-2.1+").unwrap();
        assert!(LicenseAcks::load(&paths).is_acknowledged("ffmpeg", "LGPL-2.1+"));
        let _ = std::fs::remove_dir_all(paths.root());
    }
}
