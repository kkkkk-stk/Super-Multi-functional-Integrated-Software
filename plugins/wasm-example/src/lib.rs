//! ToolForge L2 示例插件：文本统计 / slugify
//!
//! # 这个示例要证明什么
//!
//! 1. L2 是**纯计算**沙箱：整份代码没有一行文件或网络调用，也做不到 ——
//!    WASM 里没有文件系统、没有 socket、没有 SIMD / 线程。
//! 2. 宿主函数白名单只需要 `log`（见 `plugin.yaml` 的 `allowHostFunctions`）。
//! 3. 输入输出都走 JSON（`extism_pdk::Json<T>`），这样参数增减不会破坏 ABI。
//!
//! # 构建
//!
//! ```powershell
//! rustup target add wasm32-unknown-unknown
//! cd plugins\wasm-example
//! cargo build --target wasm32-unknown-unknown --release
//! Copy-Item .\target\wasm32-unknown-unknown\release\toolforge_plugin_text_toolkit.wasm .\plugin.wasm
//! ```
//!
//! ⚠️ **不要用 `wasm32-wasip1`。** 这里曾经写的就是它，结果这个"官方示例"装上后
//! 必然失败：Rust 的 wasip1 版 std 在启动时无条件读环境变量（`environ_get`），
//! 于是模块必然导入 `wasi_snapshot_preview1`，而宿主刻意关掉了 WASI
//! （`with_wasi(false)`，这是"没有文件系统"的实现手段），wasmtime 实例化直接报
//! `unknown import: wasi_snapshot_preview1::environ_get has not been defined`。
//!
//! 现在宿主会在装载前读一遍导入段，遇到 WASI 导入直接告诉你改用哪个目标
//! （`runtimes/wasm.rs::inspect_imports`），但正确的目标一开始就不该选错。
//!
//! # 输入信封（宿主与插件之间的**真实**约定）
//!
//! 宿主把 `PluginCallRequest::payload`（`crates/toolforge-plugins/src/runtimes.rs`）
//! 序列化成 JSON 字节，作为 Extism 调用的输入：
//!
//! ```json
//! {
//!   "input":  { "text": ["Hello 世界"] },
//!   "params": { "mode": "stats" },
//!   "paths":  { "input": "/…", "output": "/…", "data": "/…", "work": "/…" },
//!   "capabilities": []
//! }
//! ```
//!
//! 注意两点：
//! * `input` 的每个端口值都是**数组**（即使只有一个）；
//! * payload 的总大小有 **16 MB 上限**（见 `runtimes/wasm.rs` 的 `MAX_INPUT_BYTES`），
//!   超了会直接报 `InvalidArgument` —— 这也是"L2 不适合处理大文件"的第二个理由。
//!
//! 返回值必须是 **JSON**。宿主认三个字段（完整契约见 `docs/PLUGIN-SDK.md` §4.4）：
//! `outputs`（端口 id -> 值；文件类端口给路径，宿主会核对它真实存在且落在输出目录内）、
//! `values`（结构化结果，会写进任务日志）、`error`（**L2 唯一可靠的报错通道**）。
//!
//! ⚠️ 下面这些与入口相关的部分只在 wasm32 上编译：PDK 会引用 `extism:host/env`
//! 的导入，在宿主机三元组上链接必然失败（`LNK2019: 无法解析的外部符号 get_log_level`）。
//! 门起来之后 `cargo test` 就能在宿主机上跑 `compute_stats` / `slugify` 的单测了。

#[cfg(target_arch = "wasm32")]
use extism_pdk::*;
#[cfg(target_arch = "wasm32")]
use serde::{Deserialize, Serialize};

/// 宿主传给插件的请求信封（字段与 `PluginCallRequest::payload` 一一对应）。
#[cfg(target_arch = "wasm32")]
#[derive(Debug, Deserialize)]
struct RunRequest {
    /// 输入端口 id -> **路径/值列表**（端口定义见 plugin.yaml 的 `io.inputs`）
    #[serde(default)]
    input: std::collections::BTreeMap<String, Vec<String>>,
    /// 参数 id -> **裸值**（参数定义见 plugin.yaml 的 `io.params`）
    ///
    /// ⚠️ 必须用 `serde_json::Value` 而不是 `String`。宿主给的是**原始 JSON 类型**
    /// （`"stats"` 是字符串、`5` 是数字、`true` 是布尔），声明成 `String` 会让
    /// 整个请求反序列化失败 —— 报错是 `invalid type: map, expected a string`，
    /// 而这句话完全指不到"参数类型声明错了"这个真正的原因。
    #[serde(default)]
    params: std::collections::BTreeMap<String, serde_json::Value>,
    /// 逻辑路径作用域 -> 真实根目录（由 `initialize`/payload 提供）
    #[serde(default)]
    paths: std::collections::BTreeMap<String, String>,
    /// 本次调用**实际生效**的能力标签，例如 `["fsRead", "fsWrite"]`
    #[serde(default)]
    capabilities: Vec<String>,
}

/// 文本统计结果。
///
/// 这个结构体**不加 cfg**：它的纯计算函数要在宿主机上跑单测。
/// `Serialize` 只在 wasm32 上派生（宿主机上没人序列化它，派生了就是死代码）。
#[cfg_attr(target_arch = "wasm32", derive(Serialize))]
#[derive(Debug)]
struct TextStats {
    /// 字符总数（按 Unicode 标量计，中文一个字算一个）
    chars: usize,
    /// 不含空白的字符数
    chars_no_whitespace: usize,
    /// 行数
    lines: usize,
    /// 空白切分后的词数
    words: usize,
    /// UTF-8 字节数
    bytes: usize,
}

/// 插件入口。`plugin.yaml` 里的 `wasm.entry` 必须与本函数名一致（这里是 `run`）。
///
/// ⚠️ 报错走 `{"error": "…"}` 而**不是** `Err(...)`：Extism 1.30 只在"输出已被设置"
/// 时才读取插件设置的错误消息，而 PDK 的 `Err` 分支不设置输出 —— 返回 `Err`
/// 的结果是用户只看到一句 wasm 回溯，你写的文案全丢。详见 `PLUGIN-SDK.md` §4.4。
#[cfg(target_arch = "wasm32")]
#[plugin_fn]
pub fn run(input: Json<RunRequest>) -> FnResult<Json<serde_json::Value>> {
    let req = input.0;

    // 取出输入端口 `text`（值是数组，取第一个）；取不到时给出可读错误，
    // 而不是悄悄返回空串（静默留空在批量处理里会变成"看起来跑通了但结果不对"的灾难）
    let Some(text) = req.input.get("text").and_then(|v| v.first()) else {
        return Ok(Json(serde_json::json!({
            "error": "缺少输入端口 `text`（端口 id 见 plugin.yaml 的 io.inputs）"
        })));
    };

    // 参数 `mode`，默认 stats。
    // 值可能是字符串也可能是数字/布尔，所以取 `as_str()` 失败时回落到默认值。
    let mode = req
        .params
        .get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("stats");

    // 通过 `log` 宿主函数写一行日志。这里用的是 Extism PDK 的 info! 宏，
    // 它走内置的 `extism_log_*` 导入（宿主把日志回调接到了 tracing），
    // 因此**不需要** ToolForge 自定义宿主函数。
    // 级别低于宿主设置（默认 Info）的日志会被丢掉。
    info!(
        "text-toolkit: mode={mode}, len={}, caps={}, inputRoot={}",
        text.chars().count(),
        req.capabilities.join("+"),
        req.paths.get("input").map(|s| s.as_str()).unwrap_or("-")
    );

    let (outputs, values) = match mode {
        "stats" => {
            let stats = compute_stats(text);
            let Ok(json) = serde_json::to_string(&stats) else {
                return Ok(Json(serde_json::json!({ "error": "统计结果序列化失败" })));
            };
            let mut outputs = std::collections::BTreeMap::new();
            outputs.insert("result".to_string(), json);
            let mut values = std::collections::BTreeMap::new();
            values.insert("chars".to_string(), serde_json::json!(stats.chars));
            values.insert("words".to_string(), serde_json::json!(stats.words));
            values.insert("lines".to_string(), serde_json::json!(stats.lines));
            (outputs, values)
        }
        "slugify" => {
            let slug = slugify(text);
            let mut outputs = std::collections::BTreeMap::new();
            outputs.insert("result".to_string(), slug.clone());
            let mut values = std::collections::BTreeMap::new();
            values.insert("slug".to_string(), serde_json::json!(slug));
            (outputs, values)
        }
        other => {
            return Ok(Json(serde_json::json!({
                "error": format!(
                    "未知的 mode `{other}`；plugin.yaml 里声明的候选值是 stats 与 slugify"
                )
            })));
        }
    };

    Ok(Json(serde_json::json!({ "outputs": outputs, "values": values })))
}

/// 文本统计。刻意只用标准库 —— WASM 里没有正则引擎这类"顺手"的依赖，
/// 想加依赖就得接受 WASM 体积变大。
fn compute_stats(text: &str) -> TextStats {
    TextStats {
        chars: text.chars().count(),
        chars_no_whitespace: text.chars().filter(|c| !c.is_whitespace()).count(),
        lines: if text.is_empty() {
            0
        } else {
            text.lines().count()
        },
        words: text.split_whitespace().count(),
        bytes: text.len(),
    }
}

/// 生成 URL slug：转小写，非 ASCII 字母数字的连续片段折叠成一个 `-`，再去掉首尾的 `-`。
///
/// 注意这是**故意简单**的算法：它不处理音译，纯中文输入会得到空串
/// （因为 CJK 字符不是 ASCII 字母数字）。真实插件应该在这里接入音译表。
fn slugify(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut pending_dash = false;

    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.push(ch.to_ascii_lowercase());
        } else {
            pending_dash = true;
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stats_counts_unicode_chars_not_bytes() {
        let s = compute_stats("你好 world");
        assert_eq!(s.chars, 8); // 2 个汉字 + 1 空格 + 5 个字母
        assert_eq!(s.chars_no_whitespace, 7); // 扣掉那一个空格
        assert_eq!(s.words, 2);
        assert_eq!(s.lines, 1);
        assert_eq!(s.bytes, 12); // 汉字 3 字节
    }

    #[test]
    fn slugify_folds_separators() {
        assert_eq!(slugify("Hello, World!!"), "hello-world");
        assert_eq!(slugify("  --a--b--  "), "a-b");
        assert_eq!(slugify("ToolForge_v0.1"), "toolforge-v0-1");
    }
}
