//! JSON-RPC 2.0 帧模型（按行分帧，用于 L3 Python 插件的 stdio 通道）。
//!
//! ## 为什么选 JSON-RPC over stdio 而不是 gRPC / HTTP
//!
//! * **零依赖**：Python 侧只需要 `sys.stdin.readline()` + `json.loads`，
//!   连 `pip install` 都不用。插件作者写起来门槛最低。
//! * **天然进程隔离**：插件崩了不会带崩主程序，杀掉重启即可。
//! * **可调试**：手动 `echo '{"jsonrpc":"2.0",...}' | python main.py` 就能复现问题。
//!
//! ## 分帧约定
//!
//! 一行一个 JSON 对象，UTF-8，**行内不允许出现裸换行**（`json.dumps` 默认
//! 就不会产生）。stdout 只走协议数据，任何调试输出必须走 stderr ——
//! 这条约定必须写进插件 SDK 文档，否则插件作者一个 `print()` 就会毒化协议流。
//! 宿主侧对此做了容错：解析失败的行会被当成插件日志而不是立刻报错。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 协议版本（本 crate 只认这一个）
pub const JSONRPC_VERSION: &str = "2.0";

/// 标准错误码
pub mod codes {
    pub const PARSE_ERROR: i64 = -32700;
    pub const INVALID_REQUEST: i64 = -32600;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INVALID_PARAMS: i64 = -32602;
    pub const INTERNAL_ERROR: i64 = -32603;

    // ---- 应用自定义段（-32000 ..= -32099 保留给实现） ----
    /// 插件拒绝执行（例如缺少能力授权）
    pub const PERMISSION_DENIED: i64 = -32001;
    /// 插件执行超时
    pub const TIMEOUT: i64 = -32002;
    /// 插件进程已退出
    pub const PROCESS_GONE: i64 = -32003;
    /// 插件未初始化（没有先调 initialize）
    pub const NOT_INITIALIZED: i64 = -32004;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }

    pub fn method_not_found(method: &str) -> Self {
        Self::new(codes::METHOD_NOT_FOUND, format!("未知方法：{method}"))
    }

    pub fn invalid_params(msg: impl Into<String>) -> Self {
        Self::new(codes::INVALID_PARAMS, msg)
    }

    pub fn internal(msg: impl Into<String>) -> Self {
        Self::new(codes::INTERNAL_ERROR, msg)
    }

    pub fn parse(msg: impl Into<String>) -> Self {
        Self::new(codes::PARSE_ERROR, msg)
    }
}

/// 请求 id。JSON-RPC 允许字符串或数字；我们统一用 u64，
/// 但对收到的字符串 id 也要能回显 —— 所以用 `Value` 保守承载。
pub type RpcId = Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcRequest {
    pub jsonrpc: String,
    /// `None` 表示这是通知（不需要回复）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<RpcId>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

impl RpcRequest {
    pub fn new(id: u64, method: impl Into<String>, params: Value) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.into(),
            id: Some(Value::from(id)),
            method: method.into(),
            params,
        }
    }

    pub fn is_notification(&self) -> bool {
        self.id.is_none()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcResponse {
    pub jsonrpc: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<RpcId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

impl RpcResponse {
    pub fn ok(id: RpcId, result: Value) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.into(),
            id: Some(id),
            result: Some(result),
            error: None,
        }
    }

    pub fn err(id: Option<RpcId>, error: RpcError) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.into(),
            id,
            result: None,
            error: Some(error),
        }
    }

    /// 把响应折成 `Result`
    pub fn into_result(self) -> Result<Value, RpcError> {
        match (self.result, self.error) {
            (_, Some(e)) => Err(e),
            (Some(v), None) => Ok(v),
            (None, None) => Ok(Value::Null),
        }
    }
}

/// 从对端读到的任意一条消息。
///
/// 判别顺序很重要：先看有没有 `method`（请求或通知），再看有没有 `result`/`error`
/// （响应）。只看 `id` 是分不出来的 —— 请求和响应都带 id。
#[derive(Debug, Clone)]
pub enum RpcMessage {
    Request(RpcRequest),
    /// 带 id 的响应
    Response(RpcResponse),
    /// 通知：有 method 但没有 id
    Notification { method: String, params: Value },
}

impl RpcMessage {
    /// 解析一行文本。
    ///
    /// **返回 `Err(RpcError::parse(..))` 时调用方不应该中断连接** ——
    /// 插件里一个意外的 `print()` 就会产生一行非 JSON，把它当成插件日志即可。
    pub fn parse_line(line: &str) -> Result<Self, RpcError> {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return Err(RpcError::parse("空行"));
        }
        let v: Value =
            serde_json::from_str(trimmed).map_err(|e| RpcError::parse(format!("JSON 解析失败：{e}")))?;

        let obj = v
            .as_object()
            .ok_or_else(|| RpcError::parse("顶层必须是 JSON 对象"))?;

        if let Some(version) = obj.get("jsonrpc").and_then(|x| x.as_str()) {
            if version != JSONRPC_VERSION {
                return Err(RpcError::new(
                    codes::INVALID_REQUEST,
                    format!("不支持的 jsonrpc 版本：{version}"),
                ));
            }
        } else {
            return Err(RpcError::new(
                codes::INVALID_REQUEST,
                "缺少 jsonrpc 字段（必须是 \"2.0\"）",
            ));
        }

        let has_method = obj.contains_key("method");
        let has_result = obj.contains_key("result");
        let has_error = obj.contains_key("error");
        let id = obj.get("id").cloned();

        if has_method {
            let method = obj
                .get("method")
                .and_then(|m| m.as_str())
                .ok_or_else(|| RpcError::new(codes::INVALID_REQUEST, "method 必须是字符串"))?
                .to_string();
            let params = obj.get("params").cloned().unwrap_or(Value::Null);
            return match id {
                Some(id) => Ok(RpcMessage::Request(RpcRequest {
                    jsonrpc: JSONRPC_VERSION.into(),
                    id: Some(id),
                    method,
                    params,
                })),
                None => Ok(RpcMessage::Notification { method, params }),
            };
        }

        if has_result || has_error {
            let response: RpcResponse = serde_json::from_value(v)
                .map_err(|e| RpcError::parse(format!("响应结构非法：{e}")))?;
            return Ok(RpcMessage::Response(response));
        }

        Err(RpcError::new(
            codes::INVALID_REQUEST,
            "既不是请求也不是响应（缺少 method / result / error）",
        ))
    }

    /// 序列化成一行（含结尾换行）
    pub fn to_line(&self) -> String {
        let mut s = match self {
            RpcMessage::Request(r) => serde_json::to_string(r),
            RpcMessage::Response(r) => serde_json::to_string(r),
            RpcMessage::Notification { method, params } => serde_json::to_string(&serde_json::json!({
                "jsonrpc": JSONRPC_VERSION,
                "method": method,
                "params": params,
            })),
        }
        .unwrap_or_else(|_| String::from("{}"));
        s.push('\n');
        s
    }
}

/// 构造通知
pub fn notification(method: impl Into<String>, params: Value) -> RpcMessage {
    RpcMessage::Notification {
        method: method.into(),
        params,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_request_with_numeric_id() {
        let m = RpcMessage::parse_line(r#"{"jsonrpc":"2.0","id":7,"method":"run","params":{"a":1}}"#)
            .unwrap();
        match m {
            RpcMessage::Request(r) => {
                assert_eq!(r.method, "run");
                assert_eq!(r.id, Some(json!(7)));
                assert!(!r.is_notification());
            }
            _ => panic!("应当是请求"),
        }
    }

    #[test]
    fn parses_notification_without_id() {
        let m = RpcMessage::parse_line(r#"{"jsonrpc":"2.0","method":"progress","params":{"p":0.5}}"#)
            .unwrap();
        match m {
            RpcMessage::Notification { method, params } => {
                assert_eq!(method, "progress");
                assert_eq!(params["p"], 0.5);
            }
            _ => panic!("应当是通知"),
        }
    }

    #[test]
    fn parses_success_response() {
        let m = RpcMessage::parse_line(r#"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}"#).unwrap();
        match m {
            RpcMessage::Response(r) => {
                assert!(r.error.is_none());
                assert_eq!(r.into_result().unwrap()["ok"], true);
            }
            _ => panic!("应当是响应"),
        }
    }

    #[test]
    fn parses_error_response_preserving_data() {
        let m = RpcMessage::parse_line(
            r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"denied","data":{"cap":"exec"}}}"#,
        )
        .unwrap();
        match m {
            RpcMessage::Response(r) => {
                let e = r.into_result().unwrap_err();
                assert_eq!(e.code, codes::PERMISSION_DENIED);
                assert_eq!(e.data.unwrap()["cap"], "exec");
            }
            _ => panic!("应当是响应"),
        }
    }

    #[test]
    fn non_json_line_is_parse_error_not_panic() {
        // 插件里一个意外的 print() 会产生这种行
        let e = RpcMessage::parse_line("loading model... 37%").unwrap_err();
        assert_eq!(e.code, codes::PARSE_ERROR);
    }

    #[test]
    fn rejects_wrong_protocol_version() {
        let e = RpcMessage::parse_line(r#"{"jsonrpc":"1.0","id":1,"method":"x"}"#).unwrap_err();
        assert_eq!(e.code, codes::INVALID_REQUEST);
    }

    #[test]
    fn rejects_object_without_any_discriminant() {
        let e = RpcMessage::parse_line(r#"{"jsonrpc":"2.0","id":1}"#).unwrap_err();
        assert_eq!(e.code, codes::INVALID_REQUEST);
    }

    #[test]
    fn roundtrip_request() {
        let req = RpcRequest::new(42, "run", json!({"input": "/work/a.png"}));
        let line = RpcMessage::Request(req.clone()).to_line();
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1, "必须是单行分帧");
        match RpcMessage::parse_line(&line).unwrap() {
            RpcMessage::Request(back) => {
                assert_eq!(back.id, req.id);
                assert_eq!(back.params, req.params);
            }
            _ => panic!("roundtrip 失败"),
        }
    }

    #[test]
    fn response_without_error_or_result_is_null_ok() {
        let r = RpcResponse {
            jsonrpc: JSONRPC_VERSION.into(),
            id: Some(json!(1)),
            result: None,
            error: None,
        };
        assert_eq!(r.into_result().unwrap(), Value::Null);
    }

    #[test]
    fn id_is_echoed_for_string_ids() {
        // 有些库用字符串 id，我们不该因此丢消息
        let m = RpcMessage::parse_line(r#"{"jsonrpc":"2.0","id":"abc","method":"ping"}"#).unwrap();
        match m {
            RpcMessage::Request(r) => assert_eq!(r.id, Some(json!("abc"))),
            _ => panic!(),
        }
    }
}
