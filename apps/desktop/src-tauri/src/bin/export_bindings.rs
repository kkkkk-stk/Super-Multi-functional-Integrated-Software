//! 独立二进制：导出 TypeScript 绑定，**并校验它没有丢掉关键内容**。
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
//!
//! ## 为什么校验逻辑写在这里，而不是 `#[cfg(test)]`
//!
//! 这两条断言本来写成 app crate 的单元测试，但**在这个 Windows 环境下跑不起来**：
//! `cargo test -p toolforge --lib` 的测试可执行文件加载 DLL 时报
//! `0xC0000139 STATUS_ENTRYPOINT_NOT_FOUND`（Tauri 应用的测试目标在 Windows 上
//! 有已知的链接/加载问题）。而 `cargo run --bin export-bindings` **是能跑的**
//! —— 我就一直在用它。
//!
//! 所以把守卫搬到这条已验证可用的路径上。这**比原来的写法更好**：
//! 校验发生在"绑定刚刚被生成"的那一刻，而 CI 的 bindings job 本来就在跑这条命令。

use std::path::Path;

fn main() {
    let out = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("src")
        .join("bindings.ts");

    let builder = toolforge_lib::specta_builder();
    if let Err(e) = builder.export(specta_typescript::Typescript::default(), &out) {
        eprintln!("导出失败：{e}");
        std::process::exit(1);
    }
    println!("已导出 TypeScript 绑定：{}", out.display());
    println!("命令数：{}", toolforge_lib::COMMAND_NAMES.len());

    let text = match std::fs::read_to_string(&out) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("读回导出结果失败：{e}");
            std::process::exit(1);
        }
    };

    let mut failed = 0usize;

    // ---- 守卫 1：`AppEvent` 必须被导出 ----
    //
    // 它曾经是前端**唯一手写的契约**。原因：本项目所有领域事件发在同一个通道上，
    // 载荷是一个带 `type` 判别式的枚举，这种形态不符合 `collect_events!` 的模型
    // （那要求"每个事件一个类型"），所以那个宏是空的 —— `AppEvent` 进不了绑定，
    // 前端只能手抄一份。
    //
    // 手抄的代价：后端把 `errorMessage` 改成 `error`，TypeScript **不会报错**，
    // 只会在运行时静默拿到 `undefined`。现在靠 `Builder::typ::<AppEvent>()` 导出。
    //
    // 那一行如果被误删，前端 `tsc` 会报错 —— 但那条信号只在有人跑前端构建时出现。
    // 这里让它在**生成绑定的当场**就暴露。
    if !text.contains("export type AppEvent_Serialize") {
        eprintln!(
            "❌ AppEvent 没有出现在生成的绑定里 ——\n\
             检查 apps/desktop/src-tauri/src/lib.rs 的 `specta_builder()` 是否还调用了 \
             `.typ::<AppEvent>()`。\n\
             少了它，前端就只剩这一处手写契约，事件字段改名不会变成编译错误。"
        );
        failed += 1;
    }
    if !text.contains("EVENT_CHANNEL") {
        eprintln!(
            "❌ 事件通道常量没有导出 —— 检查 `specta_builder()` 的 \
             `.constant(\"EVENT_CHANNEL\", ..)`。前端 `listen` 用的就是它。"
        );
        failed += 1;
    }

    // ---- 守卫 2：`COMMAND_NAMES` 与真实注册的命令逐条对齐 ----
    //
    // `lib.rs::run()` 里那条 `debug_assert_eq!(COMMAND_NAMES.len(), 29)` 只是比一个
    // **魔数** —— 加命令时把它从 29 改成 30 就"通过了"，而漏注册的照旧漏。
    // 这里改成逐个核对名字，不能靠改数字蒙混过去。
    for name in toolforge_lib::COMMAND_NAMES {
        if !text.contains(&format!("__TAURI_INVOKE(\"{name}\"")) {
            eprintln!(
                "❌ `COMMAND_NAMES` 里的 `{name}` 没有出现在生成的绑定里 ——\n\
                 说明它没被 `collect_commands!` 注册。前端调用时会得到「命令未找到」，\
                 而且要到运行时才发现。"
            );
            failed += 1;
        }
    }
    let registered = text.matches("__TAURI_INVOKE(\"").count();
    if registered != toolforge_lib::COMMAND_NAMES.len() {
        eprintln!(
            "❌ 生成绑定的命令数（{registered}）与 `COMMAND_NAMES`（{}）不一致 ——\n\
             多半是加了命令却没登记，或反过来。",
            toolforge_lib::COMMAND_NAMES.len()
        );
        failed += 1;
    }

    // ---- 守卫 3：节点实现状态必须来自后端（前端不再硬编） ----
    if !text.contains("unimplemented") {
        eprintln!(
            "❌ `NodeCatalogResponse.unimplemented` 不见了 ——\n\
             前端靠它显示「该能力尚未实现」，它是 `UNIMPLEMENTED_NODES` 的唯一对外出口。\n\
             （前端**不该**再硬编那份名单。）"
        );
        failed += 1;
    }

    if failed > 0 {
        eprintln!("\n绑定校验未通过：{failed} 项");
        std::process::exit(1);
    }
    println!("绑定校验通过（AppEvent / 事件通道常量 / 命令清单 / 节点实现状态）");
}
