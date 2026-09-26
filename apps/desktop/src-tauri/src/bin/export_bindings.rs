//! 独立二进制：只导出 TypeScript 绑定，不启动应用。
//!
//! 用法（在仓库根目录）：
//!
//! ```bash
//! cargo run -p toolforge --bin export-bindings
//! pnpm bindings     # 等价
//! ```
//!
//! ## 为什么要有这个独立入口
//!
//! 调试构建会在 `run()` 里顺带导出一次，但那条路径要求能起窗口。
//! 在 CI（无显示环境）里校验"绑定是否与 Rust 类型同步"就必须有一个
//! **不需要 GUI** 的入口 —— 否则类型漂移只会在某人的机器上才暴露。

fn main() {
    let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("src")
        .join("bindings.ts");

    let builder = toolforge_lib::specta_builder();
    match builder.export(specta_typescript::Typescript::default(), &out) {
        Ok(()) => {
            println!("已导出 TypeScript 绑定：{}", out.display());
            println!("命令数：{}", toolforge_lib::COMMAND_NAMES.len());
        }
        Err(e) => {
            eprintln!("导出失败：{e}");
            std::process::exit(1);
        }
    }
}
