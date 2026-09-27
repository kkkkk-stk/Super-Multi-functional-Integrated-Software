//! 应用目录布局。
//!
//! 这一层刻意**不依赖 tauri**：调用方（外壳层）把可写根目录传进来，
//! 剩下四个子目录的布局由领域层统一决定。好处是同一个布局可以被 CLI、
//! 测试、以及未来的无头模式复用，也方便写单元测试（用临时目录即可）。
//!
//! ```text
//! <data_root>/
//! ├── settings.json            用户设置（**绝不含 API Key**）
//! ├── ai-key.txt               API Key —— 仅当用户显式勾选「记住」时才存在
//! ├── plugins/                 已安装插件（每个插件一个目录）
//! │   └── com.example.foo/
//! │       ├── plugin.yaml
//! │       ├── plugin.wasm           (L2)
//! │       ├── main.py               (L3)
//! │       ├── .venv/                (L3 私有依赖)
//! │       └── .data/                插件私有持久化目录
//! ├── engines/                 按需下载的引擎二进制
//! │   ├── ffmpeg/…
//! │   └── …
//! ├── models/                  ONNX 权重（与引擎分开）
//! ├── audit/                   审计日志：谁在什么时候授权了什么、插件越权记录
//! ├── logs/                    应用日志
//! └── cache/                   可安全删除的缓存 + 任务临时工作区
//!     └── work/                每个任务的临时目录
//! ```

use std::path::{Path, PathBuf};

/// 应用目录布局。
#[derive(Debug, Clone)]
pub struct AppPaths {
    root: PathBuf,
}

impl AppPaths {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn plugins(&self) -> PathBuf {
        self.root.join("plugins")
    }

    pub fn plugin_dir(&self, plugin_id: &str) -> PathBuf {
        self.plugins().join(sanitize_id(plugin_id))
    }

    /// 插件私有持久化目录（清单里的 `$PLUGIN_DATA` 作用域指向这里）
    pub fn plugin_data(&self, plugin_id: &str) -> PathBuf {
        self.plugin_dir(plugin_id).join(".data")
    }

    /// 插件私有 venv（L3）
    pub fn plugin_venv(&self, plugin_id: &str) -> PathBuf {
        self.plugin_dir(plugin_id).join(".venv")
    }

    pub fn engines(&self) -> PathBuf {
        self.root.join("engines")
    }

    pub fn engine_dir(&self, engine_id: &str) -> PathBuf {
        self.engines().join(sanitize_id(engine_id))
    }

    pub fn models(&self) -> PathBuf {
        self.root.join("models")
    }

    pub fn model_dir(&self, model_id: &str) -> PathBuf {
        self.models().join(sanitize_id(model_id))
    }

    /// 用户设置文件。
    ///
    /// **只放非机密字段**：AI 的 API Key 单独一个文件（见 [`Self::ai_key_file`]），
    /// 因为设置文件会被原样序列化给前端（`settings_get`），
    /// 而 Key 一旦进了那个结构体就再也收不回来了。
    pub fn settings_file(&self) -> PathBuf {
        self.root.join("settings.json")
    }

    /// API Key 的落盘位置。
    ///
    /// **只有用户显式打开「记住 API Key」时这个文件才会存在**，
    /// 默认情况下它是没有的 —— 这一点很重要：默认行为必须是"不落盘"，
    /// 不能因为"方便"就把密钥悄悄写到磁盘上。
    pub fn ai_key_file(&self) -> PathBuf {
        self.root.join("ai-key.txt")
    }

    /// 设置文件损坏时的隔离位置（保留证据，不静默丢弃）
    pub fn settings_backup_file(&self) -> PathBuf {
        self.root.join("settings.broken.json")
    }

    /// 许可证确认记录（引擎与模型的"我已阅读并接受"）。
    ///
    /// 它**不是**机密：里面是公开的许可证标识、一段许可证原文的摘要，
    /// 以及确认时间。放在这里是为了合规审查时拿得出证据链 ——
    /// 见 `apps/desktop/src-tauri/src/license_acks.rs`。
    pub fn license_acks_file(&self) -> PathBuf {
        self.root.join("license-acks.json")
    }

    pub fn audit(&self) -> PathBuf {
        self.root.join("audit")
    }

    pub fn logs(&self) -> PathBuf {
        self.root.join("logs")
    }

    pub fn cache(&self) -> PathBuf {
        self.root.join("cache")
    }

    /// 任务临时工作区根目录
    pub fn work_root(&self) -> PathBuf {
        self.cache().join("work")
    }

    /// 某个任务的临时目录
    pub fn job_workspace(&self, job_id: &str) -> PathBuf {
        self.work_root().join(sanitize_id(job_id))
    }

    /// 一次性创建全部目录
    pub fn ensure_all(&self) -> std::io::Result<()> {
        for p in [
            self.plugins(),
            self.engines(),
            self.models(),
            self.audit(),
            self.logs(),
            self.cache(),
            self.work_root(),
        ] {
            std::fs::create_dir_all(&p)?;
        }
        Ok(())
    }

    /// 给前端展示的路径清单
    pub fn describe(&self) -> Vec<(String, String)> {
        vec![
            ("数据目录".into(), self.root.display().to_string()),
            ("插件目录".into(), self.plugins().display().to_string()),
            ("引擎目录".into(), self.engines().display().to_string()),
            ("模型目录".into(), self.models().display().to_string()),
            ("审计日志".into(), self.audit().display().to_string()),
            ("缓存目录".into(), self.cache().display().to_string()),
        ]
    }
}

/// 把任意 ID 清洗成安全的目录名。
///
/// ## 为什么这里必须严格
///
/// 虽然插件 ID 在校验阶段已经限制过字符集（见 `plugin::is_valid_plugin_id`），
/// 但**目录名拼接是最后一道防线**：任何时候把外部输入拼进路径都必须再过一次。
/// 第一版实现只是把非法字符替换成 `_` 再 trim 掉首尾的点 ——
/// 结果 `../../evil` 会变成 `_.._evil`，**中间那个 `..` 还在**。
/// 单元测试抓到了这个问题（见 `sanitize_never_leaves_dotdot`）。
///
/// 现在的做法是：替换非法字符 → **把连续的点折叠成单个点** → 去掉首尾的点。
/// 折叠之后结构上不可能再出现 `..`。
pub fn sanitize_id(id: &str) -> String {
    let mapped: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();

    // 折叠连续的点：`.` + `.` 只保留一个
    let mut collapsed = String::with_capacity(mapped.len());
    let mut prev_was_dot = false;
    for c in mapped.chars() {
        if c == '.' {
            if !prev_was_dot {
                collapsed.push('.');
            }
            prev_was_dot = true;
        } else {
            prev_was_dot = false;
            collapsed.push(c);
        }
    }

    let trimmed = collapsed.trim_matches('.').to_string();
    if trimmed.is_empty() {
        "unnamed".to_string()
    } else {
        trimmed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_blocks_traversal() {
        // 核心不变量：结果里绝不允许出现 `..`，也绝不允许出现路径分隔符。
        // 断言不变量而不是具体字符串，是因为具体字符串会随实现细节变化。
        for evil in [
            "../../etc/passwd",
            "..",
            "..\\..\\windows",
            "a/../../b",
            "../".repeat(20).as_str(),
            "....//....//",
            "C:\\Windows",
            "",
            "   ",
        ] {
            let out = sanitize_id(evil);
            assert!(!out.contains(".."), "`{evil}` -> `{out}` 仍含 `..`");
            assert!(!out.contains('/'), "`{evil}` -> `{out}` 仍含 `/`");
            assert!(!out.contains('\\'), "`{evil}` -> `{out}` 仍含 `\\`");
            assert!(!out.is_empty(), "`{evil}` 清洗后为空");
        }

        // 纯点名与空串退化为 unnamed
        assert_eq!(sanitize_id(".."), "unnamed");
        assert_eq!(sanitize_id("."), "unnamed");
        assert_eq!(sanitize_id(""), "unnamed");

        // 合法 ID 原样保留
        assert_eq!(
            sanitize_id("com.toolforge.builtin.image-convert"),
            "com.toolforge.builtin.image-convert"
        );
        assert_eq!(sanitize_id("a_b-c.1"), "a_b-c.1");
    }

    #[test]
    fn sanitize_never_leaves_dotdot() {
        // 回归测试：第一版实现会把 `../../evil` 变成 `_.._evil`（`..` 还在中间）
        let out = sanitize_id("../../evil");
        assert!(!out.contains(".."), "{out}");
    }

    #[test]
    fn plugin_data_stays_inside_plugin_dir() {
        let p = AppPaths::new("/data");
        let dir = p.plugin_dir("../../evil");
        assert!(dir.starts_with(p.plugins()), "{}", dir.display());
        assert!(
            !dir.to_string_lossy().contains(".."),
            "{}",
            dir.display()
        );
        // 逐级向上也不该逃出 plugins 目录
        assert!(p.plugin_dir("..").starts_with(p.plugins()));
        assert!(p.plugin_dir("").starts_with(p.plugins()));
    }

    #[test]
    fn layout_is_consistent() {
        let p = AppPaths::new("/data");
        assert!(p.plugin_data("x").starts_with(p.plugin_dir("x")));
        assert!(p.job_workspace("j").starts_with(p.work_root()));
        assert!(p.work_root().starts_with(p.cache()));
    }

    #[test]
    fn settings_and_key_are_separate_files() {
        // 不变量：密钥文件与设置文件**必须是两个文件**。
        // 合并成一个的话，`settings_get` 返回的设置结构里迟早会带上 Key。
        let p = AppPaths::new("/data");
        assert_ne!(p.settings_file(), p.ai_key_file());
        assert!(p.settings_file().starts_with(p.root()));
        assert!(p.ai_key_file().starts_with(p.root()));
        // 两个文件都不在会被打包/同步走的子目录里，就在数据根目录下
        assert_eq!(p.settings_file().parent(), Some(p.root()));
    }
}
