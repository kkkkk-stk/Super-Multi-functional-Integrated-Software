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
//! rustup target add wasm32-wasip1
//! cd plugins\wasm-example
//! cargo build --target wasm32-wasip1 --release
//! Copy-Item .\target\wasm32-wasip1\release\toolforge_plugin_text_toolkit.wasm .\plugin.wasm
//! ```
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
//! 返回值必须是 **JSON**（`runtimes/wasm.rs` 会先按 JSON 解析；解析不了才退化为
//! 裸字符串）。下面 `RunResponse` 的 `outputs` / `values` 键名是**本示例的约定**，
//! 宿主目前不校验其字段 —— 真正把它们接到 L1 输出端口映射上的逻辑尚未落地。

use anyhow::anyhow;
use extism_pdk::*;
use serde::{Deserialize, Serialize};

/// 宿主传给插件的请求信封（字段与 `PluginCallRequest::payload` 一一对应）。
#[derive(Debug, Deserialize)]
struct RunRequest {
    /// 输入端口 id -> **路径/值列表**（端口定义见 plugin.yaml 的 `io.inputs`）
    #[serde(default)]
    input: std::collections::BTreeMap<String, Vec<String>>,
    /// 参数 id -> 值（参数定义见 plugin.yaml 的 `io.params`）
    #[serde(default)]
    params: std::collections::BTreeMap<String, String>,
    /// 逻辑路径作用域 -> 真实根目录（由 `initialize`/payload 提供）
    #[serde(default)]
    paths: std::collections::BTreeMap<String, String>,
    /// 本次调用**实际生效**的能力标签，例如 `["fsRead", "fsWrite"]`
    #[serde(default)]
    capabilities: Vec<String>,
}

/// 插件返回给宿主的响应信封。
#[derive(Debug, Serialize)]
struct RunResponse {
    /// 输出端口 id -> 值
    outputs: std::collections::BTreeMap<String, String>,
    /// 供 `${steps.<步骤id>.<键>}` 引用的结构化值（这里顺带把数字也暴露出去）
    values: std::collections::BTreeMap<String, serde_json::Value>,
}

/// 文本统计结果。
#[derive(Debug, Serialize)]
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
#[plugin_fn]
pub fn run(input: Json<RunRequest>) -> FnResult<Json<RunResponse>> {
    let req = input.0;

    // 取出输入端口 `text`（值是数组，取第一个）；取不到时给出可读错误，
    // 而不是悄悄返回空串（静默留空在批量处理里会变成"看起来跑通了但结果不对"的灾难）
    let text = req
        .input
        .get("text")
        .and_then(|v| v.first())
        .ok_or_else(|| anyhow!("缺少输入端口 `text`（端口 id 见 plugin.yaml 的 io.inputs）"))?;

    // 参数 `mode`，默认 stats
    let mode = req
        .params
        .get("mode")
        .map(|s| s.as_str())
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

    match mode {
        "stats" => {
            let stats = compute_stats(text);
            let json = serde_json::to_string(&stats).map_err(|e| anyhow!("序列化失败：{e}"))?;

            let mut outputs = std::collections::BTreeMap::new();
            outputs.insert("result".to_string(), json);

            let mut values = std::collections::BTreeMap::new();
            values.insert("chars".to_string(), serde_json::json!(stats.chars));
            values.insert("words".to_string(), serde_json::json!(stats.words));
            values.insert("lines".to_string(), serde_json::json!(stats.lines));

            Ok(Json(RunResponse { outputs, values }))
        }
        "slugify" => {
            let slug = slugify(text);

            let mut outputs = std::collections::BTreeMap::new();
            outputs.insert("result".to_string(), slug.clone());

            let mut values = std::collections::BTreeMap::new();
            values.insert("slug".to_string(), serde_json::json!(slug));

            Ok(Json(RunResponse { outputs, values }))
        }
        other => Err(anyhow!(
            "未知的 mode `{other}`；plugin.yaml 里声明的候选值是 stats 与 slugify"
        )
        .into()),
    }
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
