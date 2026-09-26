//! 端到端校验：仓库里 `plugins/` 下的**每一个真实示例清单**都必须能通过
//! `PluginManifest::validate()`。
//!
//! ## 为什么这个测试值得单独存在
//!
//! 本项目踩过一次非常典型的坑：`PermissionSet` 上带了 `#[serde(transparent)]`，
//! 于是 YAML 的正确形状是 `permissions: [ ... ]` 裸数组，而**全部示例清单**
//! 以及文档都写成了 `permissions: { capabilities: [ ... ] }`。
//! 结果是：清单反序列化直接失败，`validate()` 从未真正跑过示例 ——
//! 但因为没有任何测试去读真实文件，这个不一致一路藏到了运行时。
//!
//! 单元测试用的是内联的 YAML 字符串，所以它们**挡不住这类问题**：
//! 内联字符串可以随时跟着实现改，而仓库里的示例文件是给人看的、要长期稳定。
//! 这个测试的作用就是把两者钉在一起。
//!
//! 它同时守护另外两件容易漂移的事：
//!
//! * 示例里引用的 `uses` 节点名必须真实存在（否则用户装完一跑就报错）；
//! * 示例的目录名必须等于清单里的 `metadata.id`，否则 `reload()` 之后
//!   插件列表里会出现两个同 id 的条目，行为不可预测。

use std::path::{Path, PathBuf};

use toolforge_core::plugin::PluginManifest;
use toolforge_core::pipeline::builtin_nodes;

/// 仓库根目录（本 crate 在 `crates/toolforge-plugins`）
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .to_path_buf()
}

/// 收集 `plugins/**/plugin.yaml`
fn collect_manifests() -> Vec<PathBuf> {
    let root = repo_root().join("plugins");
    let mut out = Vec::new();
    if !root.is_dir() {
        return out;
    }
    for entry in walkdir::WalkDir::new(&root)
        .max_depth(4)
        .into_iter()
        .filter_entry(|e| {
            // 跳过构建产物目录，否则会扫到 wasm-example/target 里的临时文件
            let name = e.file_name().to_string_lossy();
            name != "target" && name != "node_modules" && name != ".venv"
        })
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_file() && entry.file_name() == "plugin.yaml" {
            out.push(entry.path().to_path_buf());
        }
    }
    out.sort();
    out
}

#[test]
fn every_example_manifest_parses_and_validates() {
    let manifests = collect_manifests();
    assert!(
        !manifests.is_empty(),
        "没有找到任何 plugins/**/plugin.yaml —— 要么示例被删了，要么路径算错了"
    );

    let mut failures: Vec<String> = Vec::new();
    for path in &manifests {
        let text = std::fs::read_to_string(path)
            .unwrap_or_else(|e| panic!("读取 {} 失败：{e}", path.display()));

        let manifest = match PluginManifest::from_yaml(&text) {
            Ok(m) => m,
            Err(e) => {
                failures.push(format!(
                    "{}\n  解析失败：{}\n  {}",
                    path.display(),
                    e.message,
                    e.detail.unwrap_or_default()
                ));
                continue;
            }
        };

        let report = manifest.validate();
        if !report.ok {
            let errs: Vec<String> = report
                .issues
                .iter()
                .filter(|i| i.severity == toolforge_core::plugin::Severity::Error)
                .map(|i| format!("    [{}] {}", i.code, i.message))
                .collect();
            failures.push(format!("{}\n{}", path.display(), errs.join("\n")));
        }
    }

    assert!(
        failures.is_empty(),
        "有 {} 个示例清单未通过校验（示例是用户的第一份参考，必须始终可用）：\n\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}

#[test]
fn example_manifests_reference_real_nodes_only() {
    let known: std::collections::HashSet<String> =
        builtin_nodes().into_iter().map(|n| n.name).collect();

    for path in collect_manifests() {
        let text = std::fs::read_to_string(&path).unwrap();
        let Ok(manifest) = PluginManifest::from_yaml(&text) else {
            continue; // 上面的测试已经报过解析失败
        };
        if let toolforge_core::plugin::PluginRuntime::Pipeline { pipeline } = &manifest.runtime {
            for step in &pipeline.steps {
                assert!(
                    known.contains(&step.uses),
                    "{} 的步骤 `{}` 引用了不存在的节点 `{}`",
                    path.display(),
                    step.id,
                    step.uses
                );
            }
        }
    }
}

#[test]
fn example_directory_name_equals_plugin_id() {
    for path in collect_manifests() {
        let text = std::fs::read_to_string(&path).unwrap();
        let Ok(manifest) = PluginManifest::from_yaml(&text) else {
            continue;
        };
        // 只有"一目录一插件"的布局才需要这个约束；
        // wasm-example / python-example 这类演示目录用了独立的命名，跳过它们。
        let Some(dir_name) = path
            .parent()
            .and_then(|p| p.file_name())
            .map(|s| s.to_string_lossy().to_string())
        else {
            continue;
        };
        if !dir_name.starts_with("com.") {
            continue;
        }
        assert_eq!(
            dir_name,
            manifest.metadata.id,
            "{} 的目录名与 metadata.id 不一致 —— 一目录一插件的布局下两者必须相同",
            path.display()
        );
    }
}
