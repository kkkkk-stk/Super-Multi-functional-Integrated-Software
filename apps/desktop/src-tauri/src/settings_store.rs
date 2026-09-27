//! 设置的持久化。
//!
//! ## 为什么单独一个模块
//!
//! 在写这个模块之前，`AppState.settings` **只在内存里**：改完主题、并发度、
//! 默认输出目录，关掉应用就全没了。而设置页上写着「所有设置都会立即写入本机
//! 配置文件」——那是一句**假话**。界面承诺了持久化，后端却没有实现，
//! 这是最容易让人失去信任的一类缺陷：用户不会怀疑"设置没保存"，
//! 只会怀疑"这个软件坏了"。
//!
//! ## 三条纪律
//!
//! 1. **写入是原子的**：先写同目录下的临时文件，再 `rename` 覆盖。
//!    直接截断重写的话，写到一半断电/崩溃就会留下一个半截 JSON，
//!    下次启动读不出来 —— 用户的全部设置一次性丢失。
//! 2. **读失败绝不致命，但也绝不静默**：解析不了就把原文件改名成
//!    `settings.broken.json` 留证，然后用默认值启动。丢掉用户数据可以忍，
//!    丢掉"为什么会丢"的线索不行。
//! 3. **API Key 不进这个文件**。它单独放在 `ai-key.txt`，
//!    而且**只有用户显式勾选「记住 API Key」时才会写**。
//!    默认不落盘 —— 密钥的默认状态必须是最保守的那一种。

use std::path::{Path, PathBuf};

use toolforge_core::paths::AppPaths;
use toolforge_core::{ToolforgeError, ToolforgeResult};

use crate::ipc::Settings;

/// 一次加载的结果。带上 `source` 是为了让日志/界面能说清"设置是从哪来的"。
#[derive(Debug, Clone)]
pub struct LoadedSettings {
    pub settings: Settings,
    /// 是否真的读到了用户文件（`false` = 首次启动，用的是默认值）
    pub from_disk: bool,
    /// 读到了文件但解析失败时的原因（此时 `settings` 是默认值）
    pub load_error: Option<String>,
}

/// 从磁盘加载设置。
///
/// **这个函数不会返回 `Err`**。启动路径上的"读设置"失败不应该阻止应用启动：
/// 一个坏掉的 JSON 让用户连界面都进不去，然后也就没有界面去修它了。
pub fn load(paths: &AppPaths) -> LoadedSettings {
    let file = paths.settings_file();

    let raw = match std::fs::read_to_string(&file) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return LoadedSettings {
                settings: Settings::default(),
                from_disk: false,
                load_error: None,
            }
        }
        Err(e) => {
            return LoadedSettings {
                settings: Settings::default(),
                from_disk: false,
                load_error: Some(format!("读取 {} 失败：{e}", file.display())),
            }
        }
    };

    // 空文件按"没写过"处理：某些编辑器和同步工具会留下 0 字节文件，
    // 为此把用户设置判成"损坏"太重了。
    if raw.trim().is_empty() {
        return LoadedSettings {
            settings: Settings::default(),
            from_disk: false,
            load_error: None,
        };
    }

    match serde_json::from_str::<Settings>(&raw) {
        Ok(s) => LoadedSettings {
            settings: s,
            from_disk: true,
            load_error: None,
        },
        Err(e) => {
            // 留证：把坏文件挪到一边，这样下次写入不会把它盖掉，
            // 用户（或者我们）还能看到"当时到底写了什么"。
            let backup = quarantine(&file, &paths.settings_backup_file());
            let mut msg = format!("设置文件解析失败：{e}");
            if let Some(b) = backup {
                msg.push_str(&format!("；已备份到 {}", b.display()));
            }
            LoadedSettings {
                settings: Settings::default(),
                from_disk: false,
                load_error: Some(msg),
            }
        }
    }
}

/// 原子写入设置。返回真正落盘的路径。
pub fn save(paths: &AppPaths, settings: &Settings) -> ToolforgeResult<PathBuf> {
    let file = paths.settings_file();
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| ToolforgeError::internal(format!("设置序列化失败：{e}")))?;
    write_atomic(&file, json.as_bytes())?;
    Ok(file)
}

/// 读取「记住的」API Key。
///
/// 返回 `None` 表示用户没有选择记住（文件不存在）。这与"记住了空字符串"
/// 是两件事，所以这里用 `Option` 而不是 `String`。
pub fn load_api_key(paths: &AppPaths) -> Option<String> {
    let raw = std::fs::read_to_string(paths.ai_key_file()).ok()?;
    let key = raw.trim().to_string();
    if key.is_empty() {
        None
    } else {
        Some(key)
    }
}

/// 写入 API Key。
///
/// `key` 为 `None` 或空白时**删除**文件 —— 「清除 Key」必须真的把磁盘上的
/// 那份删掉，只清内存里的那叫没清。
pub fn save_api_key(paths: &AppPaths, key: Option<&str>) -> ToolforgeResult<()> {
    let file = paths.ai_key_file();
    match key.map(str::trim).filter(|k| !k.is_empty()) {
        Some(k) => {
            write_atomic(&file, k.as_bytes())?;
            restrict_permissions(&file);
            Ok(())
        }
        None => match std::fs::remove_file(&file) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(ToolforgeError::io(format!(
                "删除 {} 失败：{e}",
                file.display()
            ))),
        },
    }
}

/// 同目录临时文件 + rename 的原子写。
///
/// 临时文件名带进程 ID：两个实例同时写设置时不至于互相踩掉对方的临时文件
/// （真实的并发覆盖仍然会以"后写者赢"，但至少不会产生一个拼接出来的怪文件）。
fn write_atomic(target: &Path, bytes: &[u8]) -> ToolforgeResult<()> {
    let parent = target
        .parent()
        .ok_or_else(|| ToolforgeError::internal(format!("路径没有父目录：{}", target.display())))?;
    std::fs::create_dir_all(parent)
        .map_err(|e| ToolforgeError::io(format!("创建 {} 失败：{e}", parent.display())))?;

    let tmp = parent.join(format!(
        ".{}.{}.tmp",
        target
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "settings".into()),
        std::process::id()
    ));

    // 先落盘再 rename：少了 sync_all 的话，崩溃时可能 rename 成功但内容还在
    // 页缓存里 —— 结果是"有个文件，但它是空的"。
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

/// 把损坏的文件挪到备份位置。返回备份路径（失败时返回 `None`）。
fn quarantine(from: &Path, to: &Path) -> Option<PathBuf> {
    // 已有备份就先删掉：留最新的那一份才有用
    let _ = std::fs::remove_file(to);
    match std::fs::rename(from, to) {
        Ok(()) => Some(to.to_path_buf()),
        Err(_) => {
            // 连改名都失败（权限/占用）时退一步：复制一份留证，别让启动卡住
            std::fs::copy(from, to).ok().map(|_| to.to_path_buf())
        }
    }
}

/// 收紧文件权限（Unix 下 0600）。
///
/// Windows 上这是个空操作 —— 数据目录本身就在用户自己的 profile 下，
/// 但**这一点必须写出来**，不能让读者以为"跨平台都设了权限"。
#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {
    // Windows：依赖用户 profile 的 ACL。真正的加固是 DPAPI，见 ROADMAP。
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_paths(tag: &str) -> AppPaths {
        let dir = std::env::temp_dir().join(format!(
            "toolforge-settings-test-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        AppPaths::new(dir)
    }

    #[test]
    fn missing_file_yields_defaults_without_error() {
        let paths = temp_paths("missing");
        let loaded = load(&paths);
        assert!(!loaded.from_disk);
        assert!(loaded.load_error.is_none());
        assert_eq!(loaded.settings.theme, Settings::default().theme);
        let _ = std::fs::remove_dir_all(paths.root());
    }

    #[test]
    fn round_trip_preserves_edited_fields() {
        let paths = temp_paths("roundtrip");
        let s = Settings {
            theme: "dark".into(),
            concurrency: 7,
            default_output_dir: "D:\\out".into(),
            ambient_effects: false,
            ..Settings::default()
        };
        save(&paths, &s).unwrap();

        let loaded = load(&paths);
        assert!(loaded.from_disk, "应当报告为来自磁盘");
        assert_eq!(loaded.settings.theme, "dark");
        assert_eq!(loaded.settings.concurrency, 7);
        assert_eq!(loaded.settings.default_output_dir, "D:\\out");
        assert!(!loaded.settings.ambient_effects);
        let _ = std::fs::remove_dir_all(paths.root());
    }

    #[test]
    fn partial_json_falls_back_to_defaults_per_field() {
        // 只有 theme 一个字段 —— 其余必须由 `#[serde(default)]` 补齐，
        // 而不是解析失败。这条不变量保证"以后加字段不会让老配置失效"。
        let paths = temp_paths("partial");
        std::fs::write(paths.settings_file(), r#"{"theme":"light"}"#).unwrap();
        let loaded = load(&paths);
        assert!(
            loaded.from_disk,
            "缺字段不该算损坏：{:?}",
            loaded.load_error
        );
        assert_eq!(loaded.settings.theme, "light");
        assert_eq!(loaded.settings.concurrency, Settings::default().concurrency);
        assert!(loaded.settings.keep_original);
        let _ = std::fs::remove_dir_all(paths.root());
    }

    #[test]
    fn corrupt_file_is_quarantined_and_defaults_are_used() {
        let paths = temp_paths("corrupt");
        std::fs::write(paths.settings_file(), "{ this is not json").unwrap();

        let loaded = load(&paths);
        assert!(!loaded.from_disk);
        assert!(loaded.load_error.is_some(), "损坏必须被报告出来");
        // 关键断言：坏文件被挪走了，而不是留在原地
        assert!(!paths.settings_file().exists(), "坏文件应当被隔离");
        assert!(paths.settings_backup_file().exists(), "应当留下备份");
        let _ = std::fs::remove_dir_all(paths.root());
    }

    #[test]
    fn empty_file_is_not_treated_as_corrupt() {
        let paths = temp_paths("empty");
        std::fs::write(paths.settings_file(), "   \n").unwrap();
        let loaded = load(&paths);
        assert!(loaded.load_error.is_none());
        assert!(!paths.settings_backup_file().exists());
        let _ = std::fs::remove_dir_all(paths.root());
    }

    #[test]
    fn save_leaves_no_temp_files_behind() {
        let paths = temp_paths("notmp");
        save(&paths, &Settings::default()).unwrap();
        let leftovers: Vec<_> = std::fs::read_dir(paths.root())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "残留临时文件：{leftovers:?}");
        let _ = std::fs::remove_dir_all(paths.root());
    }

    #[test]
    fn api_key_is_absent_by_default_and_removable() {
        let paths = temp_paths("key");
        // 默认：没有任何密钥文件
        assert!(!paths.ai_key_file().exists());
        assert!(load_api_key(&paths).is_none());

        save_api_key(&paths, Some("sk-secret")).unwrap();
        assert_eq!(load_api_key(&paths).as_deref(), Some("sk-secret"));

        // 设置文件里绝不能出现密钥
        save(&paths, &Settings::default()).unwrap();
        let settings_raw = std::fs::read_to_string(paths.settings_file()).unwrap();
        assert!(
            !settings_raw.contains("sk-secret"),
            "密钥泄漏进了 settings.json"
        );

        // 清除必须真的删掉磁盘上的那份
        save_api_key(&paths, None).unwrap();
        assert!(!paths.ai_key_file().exists());
        assert!(load_api_key(&paths).is_none());

        // 空字符串等同清除
        save_api_key(&paths, Some("sk-x")).unwrap();
        save_api_key(&paths, Some("   ")).unwrap();
        assert!(!paths.ai_key_file().exists());
        let _ = std::fs::remove_dir_all(paths.root());
    }
}
