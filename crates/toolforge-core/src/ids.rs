//! 强类型 ID。
//!
//! 这三个 ID 全部以 `String` 为底层表示 —— 因为要跨 IPC 到 TypeScript，
//! `u64` 会踩 JS 的 2^53 精度坑，`Uuid` 则会让 specta 导出多一个需要额外处理的类型。
//! 强类型的意义只在于**Rust 侧编译期防混用**。

use serde::{Deserialize, Serialize};
use specta::Type;
use std::fmt;

macro_rules! string_id {
    ($name:ident, $prefix:literal, $doc:literal) => {
        #[doc = $doc]
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, Type)]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl $name {
            /// 生成一个新的随机 ID，带可读前缀（便于在日志里一眼看出类型）。
            pub fn generate() -> Self {
                Self(format!(
                    "{}-{}",
                    $prefix,
                    &uuid::Uuid::new_v4().simple().to_string()[..12]
                ))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }

            pub fn into_inner(self) -> String {
                self.0
            }
        }

        impl From<String> for $name {
            fn from(s: String) -> Self {
                Self(s)
            }
        }

        impl From<&str> for $name {
            fn from(s: &str) -> Self {
                Self(s.to_owned())
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

string_id!(JobId, "job", "任务 ID，例如 `job-9f3a12bc4d5e`");
string_id!(PluginId, "plug", "插件实例 ID（运行时唯一）");
string_id!(EngineId, "eng", "引擎安装实例 ID");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_ids_carry_readable_prefix() {
        let id = JobId::generate();
        assert!(id.as_str().starts_with("job-"), "{id}");
        assert_ne!(JobId::generate(), JobId::generate());
    }

    #[test]
    fn ids_serialize_transparently() {
        let id = PluginId::from("com.toolforge.demo");
        assert_eq!(
            serde_json::to_string(&id).unwrap(),
            "\"com.toolforge.demo\""
        );
    }
}
