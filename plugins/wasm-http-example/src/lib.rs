//! ToolForge L2 示例插件：抓取网页元信息（`net` 白名单演示）
//!
//! # 这个示例要证明什么（比上一个 WASM 示例多一件事）
//!
//! `plugins/wasm-example` 证明的是"L2 能做纯计算"。这一个证明的是
//! **L2 的 `net` 能力是真的被强制执行的**：
//!
//! * 清单里**声明**了 `net`；
//! * 用户在授权面板上**勾选**了它；
//! * 沙箱拿到的主机白名单 = **声明 ∩ 授权**（`PermissionSet::effective()`），
//!   由宿主翻译成 Extism 的 `allowed_hosts`（见 `runtimes/wasm.rs::allowed_hosts_from`）；
//! * 于是**没勾就没有网**，越界的主机被沙箱自己拒绝，报
//!   `HTTP request to <url> is not allowed`。
//!
//! `http_request` 是 Extism **内置**的宿主函数（不需要 ToolForge 注入），
//! 所以它也不在 `wasm.allowHostFunctions` 里 —— 那个白名单只管 `log` 与 `kv`。
//!
//! ⚠️ **白名单只按主机名匹配，端口不参与**。Extism 用的是
//! `url.host_str()`（见 `extism-1.30.0/src/pdk.rs`），所以
//! `hosts: ["127.0.0.1:8080"]` 这种写法**永远匹配不上**，必须写 `127.0.0.1`。
//! 校验器会把这个当成错误（`NET_HOST_WITH_PORT`）而不是让它在运行时神秘失败。
//!
//! # 构建
//!
//! ```powershell
//! rustup target add wasm32-unknown-unknown
//! cd plugins\wasm-http-example
//! cargo build --target wasm32-unknown-unknown --release
//! Copy-Item .\target\wasm32-unknown-unknown\release\toolforge_plugin_http_fetch.wasm .\plugin.wasm
//! ```
//!
//! ⚠️ **不要用 `wasm32-wasip1`**（原因见 `plugins/wasm-example/src/lib.rs` 顶部：
//! wasip1 的 std 必然导入 WASI，而宿主关掉了 WASI）。
//!
//! 想在宿主机上跑下面的单元测试就直接 `cargo test` —— 入口用
//! `#[cfg(target_arch = "wasm32")]` 门起来了，逃过了 `extism:host/env` 的链接问题。
//!
//! # 输入信封
//!
//! 与 `plugins/wasm-example` 完全一致（宿主用同一份 `PluginCallRequest`）：
//! `input` 的每个端口值是**数组**，`params` 是 `id -> 值` 的扁平映射。
//!
//! 本插件用到的端口：`url`（text）。**URL 来自输入而不是清单**，这样同一个模块
//! 既能抓任意网址，也能被验证脚本拿来打本地 HTTP 服务 —— 而这正是
//! "授权放行 / 未授权拒绝"这个对照实验需要的形状。

// ⚠️ 下面这一组（PDK 导入、入口、信封结构体、`MAX_BODY_BYTES`）全部只在
// wasm32 上编译。原因见 `run` 上的注释：PDK 会引用 `extism:host/env` 的导入，
// 在宿主机三元组上链接必然失败。宿主机上真正需要编译的只有下面那些
// **纯字符串函数** —— 它们才是值得跑单元测试的部分。
#[cfg(target_arch = "wasm32")]
use extism_pdk::*;
#[cfg(target_arch = "wasm32")]
use serde::{Deserialize, Serialize};

/// 把一条错误消息**真正送出去**。
///
/// # 为什么不能直接 `Err(anyhow!(...))` —— 这是一个实测出来的坑
///
/// Extism 1.30 判定"插件报错"的顺序是（`extism-1.30.0/src/plugin.rs`）：
///
/// ```text
/// let output_res = self.get_output_after_call();     // 先读输出内存
/// if output_res.is_ok() && self.extism_error_is_set() {
///     res = Err(Error::msg(<插件设置的消息>))          // ← 只有走到这里才回传消息
/// }
/// ```
///
/// 而 Extism PDK 的 `#[plugin_fn]` 在 `Err` 分支上**只**调 `error_set`、
/// **不**设置输出内存，于是 `output_res` 是 `Err`、第一个条件不成立，
/// 插件写的那句话被丢掉。用户最终看到的是：
///
/// ```text
/// WASM 插件执行失败：error while executing at wasm backtrace:
///  0: 0x8bd7 - <unknown>!<wasm function 92>
/// ```
///
/// 一句 wasm 回溯，指不到任何东西。这不是我们代码写错了，是 PDK 与宿主之间
/// 的交互缺陷；但对使用者来说，"作者写的所有可操作提示都读不到"这个后果是真的。
///
/// # 所以 L2 的错误约定是：**把错误放在返回值里，而不是返回 `Err`**
///
/// ```json
/// { "error": "请求 … 失败：HTTP request to … is not allowed" }
/// ```
///
/// 宿主看到 `error` 字段就把它当作任务的失败原因（见
/// `runtimes/wasm.rs::call`）。这条路完全在我们的控制之内，不依赖 Extism 的
/// 内部行为，也能被测试钉住。
///
/// 注意**两条路都走**：除了返回值，还会 `warn!` 一条日志。万一将来 Extism
/// 修了这个行为、或者宿主换了运行时，任务日志里仍然留着线索。
#[cfg(target_arch = "wasm32")]
fn fail(msg: impl Into<String>) -> FnResult<Json<serde_json::Value>> {
    let msg = msg.into();
    warn!("插件报错：{msg}");
    Ok(Json(serde_json::json!({ "error": msg })))
}

/// 发一个 GET 请求。
///
/// 单独包一层是因为 `http::request` 需要显式指定 body 类型参数，
/// 在 `.map_err()` 链里写 `<()>` 不好读。
#[cfg(target_arch = "wasm32")]
fn http_request(req: &HttpRequest) -> Result<HttpResponse, extism_pdk::Error> {
    http::request(req, None::<()>)
}

/// 响应体最多读这么多字节。
///
/// 为什么要自己截断：`http_response` 会把**整个响应体**搬进沙箱内存，而
/// `wasm.memoryLimitMb` 是硬上限（本示例 64 MB）。抓一个 200 MB 的视频文件
/// 会让插件以"内存超限"的形式失败，报错信息完全指不到真正的原因。
/// 截断之后至少拿得到 `<head>`，也就拿得到标题。
#[cfg(target_arch = "wasm32")]
const MAX_BODY_BYTES: usize = 512 * 1024;

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Deserialize)]
struct RunRequest {
    #[serde(default)]
    input: std::collections::BTreeMap<String, Vec<String>>,
    #[serde(default)]
    params: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    paths: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    capabilities: Vec<String>,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Serialize)]
struct PageMeta {
    url: String,
    /// HTTP 状态码
    status: u16,
    /// `content-type` 响应头（服务端没给时是空串）
    content_type: String,
    /// 标签被剥掉之后的标题；没有 `<title>` 时是空串
    title: String,
    /// meta description（`name` 与 `property="og:description"` 都认）
    description: String,
    /// 收到的响应体字节数（**截断之后**的）
    body_bytes: usize,
    /// 响应体是否被截断
    truncated: bool,
}

/// 入口只在 wasm32 上编译。
///
/// 这不是洁癖：PDK 的 `info!` / `http::request` 会引用 `extism:host/env` 里的
/// 导入（`get_log_level` 等），在**宿主机三元组**上链接必然失败
/// （`LNK2019: 无法解析的外部符号 get_log_level`）。而下面那些纯字符串函数
/// 是值得在宿主机上跑单元测试的 —— 加一个 `cfg` 就能让
/// `cargo test`（宿主机）与 `cargo build --target wasm32-unknown-unknown`（插件）各取所需。
///
/// 返回类型是 `Json<serde_json::Value>` 而不是某个具体结构体：**成功与失败共用
/// 同一个出口** —— 失败时返回 `{"error": "…"}`（见 [`fail`]）。这样才能让
/// 作者写的报错文案真的到达用户眼前。
#[cfg(target_arch = "wasm32")]
#[plugin_fn]
pub fn run(input: Json<RunRequest>) -> FnResult<Json<serde_json::Value>> {
    let req = input.0;

    let Some(url) = req
        .input
        .get("url")
        .and_then(|v| v.first())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    else {
        return fail("缺少输入端口 `url`（端口 id 见 plugin.yaml 的 io.inputs）");
    };

    // 先自己挡一层：Extism 对非法 URL 报的是 `Invalid URL: …`，
    // 那是给写代码的人看的。用户填错网址时应该看到人话。
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return fail(format!(
            "只支持 http/https 网址，收到的是 `{url}`（是不是漏了 http:// ？）"
        ));
    }

    // 日志走 Extism 内置的 `extism_log_*`，宿主把它接到了 tracing。
    // 注意**不要把完整 URL 的查询串打出来** —— 那里面常常带着 token。
    info!(
        "http-fetch: host={}, params={:?}, caps={}, dataDir={}",
        host_of(&url),
        req.params.keys().collect::<Vec<_>>(),
        req.capabilities.join("+"),
        req.paths.get("data").map(|s| s.as_str()).unwrap_or("-")
    );

    let http_req = HttpRequest::new(url.clone());
    let res = match http_request(&http_req) {
        Ok(r) => r,
        Err(e) => {
            // 这一条最常见的原因就是"没授权 net"或"主机不在白名单里"，
            // 沙箱给的原话是 `HTTP request to <url> is not allowed`。
            // 把它原样带出去，并补一句可操作的说明。
            return fail(format!(
                "请求 `{url}` 失败：{e}。\
                 如果错误里有 `is not allowed`，说明沙箱没有放行这个主机 —— \
                 请到插件详情页确认 net 能力已授权，且 plugin.yaml 的 hosts 覆盖了它。"
            ));
        }
    };

    let status = res.status_code();
    let content_type = res.header("content-type").unwrap_or("").to_string();
    let raw = res.body();
    let truncated = raw.len() > MAX_BODY_BYTES;
    let body = &raw[..raw.len().min(MAX_BODY_BYTES)];
    let text = String::from_utf8_lossy(body);

    let meta = PageMeta {
        url: url.clone(),
        status,
        content_type,
        title: extract_title(&text),
        description: extract_description(&text),
        body_bytes: body.len(),
        truncated,
    };

    let Ok(json) = serde_json::to_string(&meta) else {
        return fail("页面信息序列化失败（这不应该发生，请把这条报错反馈给插件作者）");
    };

    let mut outputs = std::collections::BTreeMap::new();
    outputs.insert("result".to_string(), json);

    let mut values = std::collections::BTreeMap::new();
    values.insert("title".to_string(), serde_json::json!(meta.title));
    values.insert("status".to_string(), serde_json::json!(meta.status));
    values.insert("bytes".to_string(), serde_json::json!(meta.body_bytes));

    Ok(Json(serde_json::json!({
        "outputs": outputs,
        "values": values,
    })))
}

/// 取 URL 的主机名（只用于日志，不参与任何判断）
fn host_of(url: &str) -> &str {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url);
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    &rest[..end]
}

/// 抽取 `<title>` 的内容。
///
/// 刻意用**手写扫描**而不是正则：WASM 里加一个正则引擎会让体积翻好几倍，
/// 而这里只需要处理"找到开始标签、找到结束标签、剥掉标签、解码常见实体"。
/// 大小写不敏感（HTML 里 `<TITLE>` 也合法）。
fn extract_title(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let Some(start) = lower.find("<title") else {
        return String::new();
    };
    let Some(gt) = lower[start..].find('>') else {
        return String::new();
    };
    let content_start = start + gt + 1;
    let Some(end_rel) = lower[content_start..].find("</title") else {
        return String::new();
    };
    clean_text(&html[content_start..content_start + end_rel])
}

/// 抽取 `description`。
///
/// 同时认三种写法：`name="description"`、`property="og:description"`、
/// `name='description'`（单引号在真实网页里并不少见）。
fn extract_description(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let mut from = 0usize;
    while let Some(rel) = lower[from..].find("<meta") {
        let start = from + rel;
        let Some(gt) = lower[start..].find('>') else {
            break;
        };
        let tag = &html[start..start + gt + 1];
        let tag_lower = &lower[start..start + gt + 1];
        let is_description = tag_lower.contains("name=\"description\"")
            || tag_lower.contains("name='description'")
            || tag_lower.contains("property=\"og:description\"")
            || tag_lower.contains("property='og:description'");
        if is_description {
            if let Some(v) = attr_value(tag, "content") {
                return clean_text(&v);
            }
        }
        from = start + gt + 1;
    }
    String::new()
}

/// 从一段标签文本里取某个属性的值（双引号与单引号都支持）
fn attr_value(tag: &str, attr: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let key = format!("{attr}=");
    let pos = lower.find(&key)? + key.len();
    let rest = &tag[pos..];
    let quote = rest.chars().next()?;
    if quote != '"' && quote != '\'' {
        // 无引号写法：取到空白为止
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        return Some(rest[..end].to_string());
    }
    let body = &rest[quote.len_utf8()..];
    let end = body.find(quote)?;
    Some(body[..end].to_string())
}

/// 剥掉标签、解码常见实体、把连续空白折成一个空格。
///
/// 注意 `\u{3000}`（全角空格）也要算空白 —— 中文网页的标题里常出现，
/// 而 `char::is_whitespace()` 对它是 true（它是 Unicode 的 Zs 类），所以
/// `split_whitespace()` 已经能处理。这里保留 `chars()` 循环是为了顺手剥标签。
fn clean_text(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut in_tag = false;
    for ch in raw.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    let decoded = decode_entities(&out);
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 解码最常见的几个 HTML 实体。刻意不做完整实体表：
/// 覆盖不到的实体宁可原样留着，也不要猜错。
fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(pos) = rest.find('&') {
        out.push_str(&rest[..pos]);
        let tail = &rest[pos..];
        let mut matched = false;
        for (entity, ch) in [
            ("&amp;", '&'),
            ("&lt;", '<'),
            ("&gt;", '>'),
            ("&quot;", '"'),
            ("&#39;", '\''),
            ("&apos;", '\''),
            ("&nbsp;", ' '),
            ("&mdash;", '—'),
            ("&ndash;", '–'),
            ("&hellip;", '…'),
        ] {
            if tail.starts_with(entity) {
                out.push(ch);
                rest = &tail[entity.len()..];
                matched = true;
                break;
            }
        }
        if !matched {
            out.push('&');
            rest = &tail[1..];
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_is_case_insensitive_and_entity_decoded() {
        let html = "<HTML><HEAD><TITLE> A &amp; B </TITLE></HEAD></HTML>";
        assert_eq!(extract_title(html), "A & B");
    }

    #[test]
    fn title_ignores_inner_tags() {
        assert_eq!(extract_title("<title>Hello <b>World</b></title>"), "Hello World");
    }

    #[test]
    fn missing_title_is_empty_not_a_panic() {
        assert_eq!(extract_title("<html><body>hi</body></html>"), "");
        assert_eq!(extract_title("<title>unterminated"), "");
    }

    #[test]
    fn description_supports_name_property_and_single_quotes() {
        assert_eq!(
            extract_description(r#"<meta name="description" content="a b">"#),
            "a b"
        );
        assert_eq!(
            extract_description(r#"<meta property="og:description" content='c d'>"#),
            "c d"
        );
        assert_eq!(extract_description("<meta charset=\"utf-8\">"), "");
    }

    #[test]
    fn host_of_strips_scheme_path_and_query() {
        assert_eq!(host_of("https://example.com/a/b?c=1"), "example.com");
        assert_eq!(host_of("http://127.0.0.1:8080/"), "127.0.0.1:8080");
        assert_eq!(host_of("example.com"), "example.com");
    }

    #[test]
    fn whitespace_is_folded() {
        assert_eq!(clean_text("  a\n\t b  "), "a b");
    }
}
