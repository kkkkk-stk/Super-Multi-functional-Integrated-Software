//! AI 服务提供方（OpenAI 兼容接口）。
//!
//! ## 为什么只做 OpenAI 兼容协议
//!
//! 因为这是事实标准：OpenAI、DeepSeek、通义千问（兼容模式）、Moonshot、Ollama、
//! LM Studio、vLLM、One-API 全都提供 `/v1/chat/completions`。
//! 只实现一套协议就能覆盖"云端 + 本地"两种部署，而不是给每家写一个适配器。
//!
//! ## API Key 的处理
//!
//! Key **只存在内存里**（由外壳层从 OS 钥匙串 / 加密存储读出来后注入），
//! 本模块不落盘、不打日志。错误信息里做过一次脱敏，防止 Key 出现在
//! 报错文本里被复制进 issue。

use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;

use toolforge_core::error::{ErrorCode, ToolforgeError, ToolforgeResult};

/// 提供方类型（决定默认的 base_url 与是否需要 Key）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AiProviderKind {
    /// OpenAI 官方
    OpenAi,
    /// DeepSeek
    DeepSeek,
    /// 阿里云百炼 / 通义千问（兼容模式）
    DashScope,
    /// 月之暗面 Kimi
    Moonshot,
    /// 本地 Ollama
    Ollama,
    /// 本地 LM Studio
    LmStudio,
    /// 任意 OpenAI 兼容端点
    Custom,
}

impl AiProviderKind {
    pub fn default_base_url(self) -> &'static str {
        match self {
            AiProviderKind::OpenAi => "https://api.openai.com/v1",
            AiProviderKind::DeepSeek => "https://api.deepseek.com/v1",
            AiProviderKind::DashScope => {
                "https://dashscope.aliyuncs.com/compatible-mode/v1"
            }
            AiProviderKind::Moonshot => "https://api.moonshot.cn/v1",
            AiProviderKind::Ollama => "http://127.0.0.1:11434/v1",
            AiProviderKind::LmStudio => "http://127.0.0.1:1234/v1",
            AiProviderKind::Custom => "",
        }
    }

    pub fn default_model(self) -> &'static str {
        match self {
            AiProviderKind::OpenAi => "gpt-4o-mini",
            AiProviderKind::DeepSeek => "deepseek-chat",
            AiProviderKind::DashScope => "qwen-plus",
            AiProviderKind::Moonshot => "moonshot-v1-8k",
            AiProviderKind::Ollama => "qwen2.5:14b",
            AiProviderKind::LmStudio => "local-model",
            AiProviderKind::Custom => "",
        }
    }

    /// 本地推理不需要 Key
    pub fn is_local(self) -> bool {
        matches!(self, AiProviderKind::Ollama | AiProviderKind::LmStudio)
    }

    pub fn describe(self) -> &'static str {
        match self {
            AiProviderKind::OpenAi => "OpenAI",
            AiProviderKind::DeepSeek => "DeepSeek",
            AiProviderKind::DashScope => "通义千问（百炼）",
            AiProviderKind::Moonshot => "Kimi（月之暗面）",
            AiProviderKind::Ollama => "Ollama（本地）",
            AiProviderKind::LmStudio => "LM Studio（本地）",
            AiProviderKind::Custom => "自定义 OpenAI 兼容端点",
        }
    }
}

/// 提供方配置。
///
/// **注意 `api_key` 字段带 `skip_serializing`** —— 它永远不会被序列化到前端，
/// 前端只知道"有没有配置"（[`AiProviderConfig::has_key`]）。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderConfig {
    pub kind: AiProviderKind,
    /// 覆盖默认 base_url（Custom 必填）
    #[serde(default)]
    pub base_url: String,
    pub model: String,
    #[serde(skip_serializing, default)]
    pub api_key: String,
    #[serde(default = "default_timeout_secs")]
    pub timeout_secs: u64,
    #[serde(default = "default_temperature")]
    pub temperature: f32,
    /// 是否已经配置了 Key（只读，给前端渲染用）
    #[serde(default)]
    pub has_key: bool,
}

fn default_timeout_secs() -> u64 {
    180
}
fn default_temperature() -> f32 {
    0.2
}

impl AiProviderConfig {
    pub fn new(kind: AiProviderKind) -> Self {
        Self {
            kind,
            base_url: kind.default_base_url().to_string(),
            model: kind.default_model().to_string(),
            api_key: String::new(),
            timeout_secs: default_timeout_secs(),
            temperature: default_temperature(),
            has_key: false,
        }
    }

    fn effective_base_url(&self) -> ToolforgeResult<String> {
        let url = if self.base_url.trim().is_empty() {
            self.kind.default_base_url().to_string()
        } else {
            self.base_url.trim().to_string()
        };
        if url.is_empty() {
            return Err(ToolforgeError::invalid(
                "自定义提供方必须填写 baseUrl（例如 https://your-host/v1）",
            ));
        }
        Ok(url.trim_end_matches('/').to_string())
    }

    /// 校验配置是否可用（**不联网**）
    pub fn validate(&self) -> ToolforgeResult<()> {
        self.effective_base_url()?;
        if self.model.trim().is_empty() {
            return Err(ToolforgeError::invalid("必须指定模型名"));
        }
        if !self.kind.is_local() && self.api_key.trim().is_empty() {
            return Err(ToolforgeError::new(
                ErrorCode::AiUnavailable,
                format!("{} 需要 API Key", self.kind.describe()),
            )
            .with_detail("请在「设置 → AI」中填写。Key 只保存在本机加密存储里。"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

impl ChatMessage {
    pub fn system(c: impl Into<String>) -> Self {
        Self {
            role: "system".into(),
            content: c.into(),
        }
    }
    pub fn user(c: impl Into<String>) -> Self {
        Self {
            role: "user".into(),
            content: c.into(),
        }
    }
    pub fn assistant(c: impl Into<String>) -> Self {
        Self {
            role: "assistant".into(),
            content: c.into(),
        }
    }
}

/// 简单的 OpenAI 兼容客户端（非流式）。
///
/// **不做流式**是有意的：插件生成的产出只有几 KB，流式带来的复杂度
/// （增量解析、半截 JSON、取消语义）远大于收益。前端可以先显示"生成中"。
/// 若日后要流式，走 `stream: true` + SSE 解析，接口保持兼容。
pub struct AiClient {
    config: AiProviderConfig,
    http: reqwest::Client,
}

impl AiClient {
    pub fn new(config: AiProviderConfig) -> ToolforgeResult<Self> {
        config.validate()?;
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(config.timeout_secs))
            .connect_timeout(Duration::from_secs(20))
            .user_agent(concat!("ToolForge/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| ToolforgeError::internal(format!("创建 HTTP 客户端失败：{e}")))?;
        Ok(Self { config, http })
    }

    pub fn config(&self) -> &AiProviderConfig {
        &self.config
    }

    /// 发一次对话补全，返回助手文本。
    pub async fn complete(&self, messages: &[ChatMessage]) -> ToolforgeResult<String> {
        let base = self.config.effective_base_url()?;
        let url = format!("{base}/chat/completions");

        let body = serde_json::json!({
            "model": self.config.model,
            "messages": messages,
            "temperature": self.config.temperature,
            // 插件清单是结构化输出，低温更稳
            "stream": false,
        });

        let mut req = self.http.post(&url).json(&body);
        if !self.config.api_key.trim().is_empty() {
            req = req.bearer_auth(self.config.api_key.trim());
        }

        let resp = req.send().await.map_err(|e| {
            ToolforgeError::new(
                ErrorCode::AiUnavailable,
                format!("无法连接 {}：{}", self.config.kind.describe(), redact(&e.to_string())),
            )
            .with_detail(format!("端点：{url}"))
        })?;

        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();

        if !status.is_success() {
            // 401/403 是可操作的（去填 Key）；5xx 是对方的问题
            let code = match status.as_u16() {
                401 | 403 => ErrorCode::AiUnavailable,
                429 => ErrorCode::AiUnavailable,
                _ => ErrorCode::AiUnavailable,
            };
            let hint = match status.as_u16() {
                401 => "API Key 无效或已过期。",
                403 => "该 Key 没有访问此模型的权限。",
                404 => "端点或模型名不存在，请检查 baseUrl 与 model。",
                429 => "触发限流，请稍后重试或更换模型。",
                _ => "服务端返回错误。",
            };
            return Err(ToolforgeError::new(code, format!("AI 服务返回 HTTP {status}"))
                .with_detail(format!("{hint}\n\n{}", redact(&truncate(&text, 1200)))));
        }

        let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
            ToolforgeError::new(
                ErrorCode::AiUnavailable,
                "AI 服务的响应不是合法 JSON",
            )
            .with_detail(format!("{e}\n\n{}", truncate(&text, 600)))
        })?;

        let content = v["choices"][0]["message"]["content"]
            .as_str()
            .ok_or_else(|| {
                ToolforgeError::new(ErrorCode::AiUnavailable, "AI 响应里没有 choices[0].message.content")
                    .with_detail(truncate(&text, 600))
            })?;

        Ok(content.to_string())
    }

    /// 拉取模型列表（`GET /models`）。用于"测试连接"。
    pub async fn list_models(&self) -> ToolforgeResult<Vec<String>> {
        let base = self.config.effective_base_url()?;
        let url = format!("{base}/models");
        let mut req = self.http.get(&url);
        if !self.config.api_key.trim().is_empty() {
            req = req.bearer_auth(self.config.api_key.trim());
        }
        let resp = req.send().await.map_err(|e| {
            ToolforgeError::new(
                ErrorCode::AiUnavailable,
                format!("无法连接：{}", redact(&e.to_string())),
            )
        })?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(ToolforgeError::new(
                ErrorCode::AiUnavailable,
                format!("获取模型列表失败：HTTP {status}"),
            )
            .with_detail(redact(&truncate(&text, 600))));
        }
        let v: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
        let models = v["data"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| m["id"].as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        Ok(models)
    }
}

/// 从任意文本里抹掉疑似 API Key。
///
/// 用户会把报错原文贴到 issue 里，所以**任何可能包含 Key 的文本在返回给前端之前
/// 都要过一遍这个函数**。规则保守：把 `sk-` / `sk_` 开头的长串与 Bearer 令牌替换掉。
///
/// 注意 `Bearer` 本身**不是**密钥（它只是认证方案名），所以单独出现时保留，
/// 只抹掉它后面那一串。调用方关心的不变量是"密钥原文不会出现在输出里"。
pub fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for token in text.split_inclusive(|c: char| c.is_whitespace() || c == '"' || c == '\'') {
        let trimmed = token.trim_matches(|c: char| c.is_whitespace() || c == '"' || c == '\'');
        let looks_like_key = (trimmed.starts_with("sk-") || trimmed.starts_with("sk_"))
            && trimmed.len() > 12;
        if looks_like_key {
            out.push_str("[REDACTED]");
            // 保留原 token 结尾的分隔符，避免把相邻的词粘在一起
            if let Some(c) = token.chars().last() {
                if c.is_whitespace() || c == '"' || c == '\'' {
                    out.push(c);
                }
            }
        } else {
            out.push_str(token);
        }
    }
    out
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect::<String>() + "…（已截断）"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_providers_do_not_require_keys() {
        let cfg = AiProviderConfig::new(AiProviderKind::Ollama);
        assert!(cfg.validate().is_ok());

        let cloud = AiProviderConfig::new(AiProviderKind::OpenAi);
        let err = cloud.validate().unwrap_err();
        assert_eq!(err.code, ErrorCode::AiUnavailable);
    }

    #[test]
    fn custom_provider_requires_base_url() {
        let cfg = AiProviderConfig::new(AiProviderKind::Custom);
        let err = cfg.validate().unwrap_err();
        assert!(err.message.contains("baseUrl"), "{}", err.message);
    }

    #[test]
    fn default_endpoints_are_well_formed() {
        for k in [
            AiProviderKind::OpenAi,
            AiProviderKind::DeepSeek,
            AiProviderKind::DashScope,
            AiProviderKind::Moonshot,
            AiProviderKind::Ollama,
            AiProviderKind::LmStudio,
        ] {
            let u = k.default_base_url();
            assert!(u.starts_with("http"), "{k:?} 的默认端点不对：{u}");
            assert!(u.ends_with("/v1"), "{k:?} 的默认端点缺少 /v1：{u}");
            assert!(!k.default_model().is_empty(), "{k:?} 缺少默认模型");
        }
    }

    #[test]
    fn api_key_is_never_serialized() {
        let mut cfg = AiProviderConfig::new(AiProviderKind::OpenAi);
        cfg.api_key = "sk-supersecret-0123456789".into();
        cfg.has_key = true;
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(!json.contains("supersecret"), "API Key 绝不能出现在发给前端的 JSON 里");
        assert!(!json.contains("apiKey"));
        assert!(json.contains("hasKey"));
    }

    #[test]
    fn redact_removes_keys() {
        assert_eq!(redact("key sk-abcdefghijklmnop is bad"), "key [REDACTED] is bad");
        // Bearer 是方案名不是密钥，保留它、只抹掉后面那串
        assert_eq!(redact("Bearer sk-abcdefghijklmnop"), "Bearer [REDACTED]");
        assert!(!redact("Authorization: Bearer sk-abcdefghijklmnop").contains("abcdefghijklmnop"));
        // 短的不误伤
        assert_eq!(redact("sk-1"), "sk-1");
        // 普通文本原样保留
        assert_eq!(redact("普通 中文 文本"), "普通 中文 文本");
    }

    #[test]
    fn base_url_trailing_slash_is_normalised() {
        let mut cfg = AiProviderConfig::new(AiProviderKind::Custom);
        cfg.base_url = "https://x.example/v1/".into();
        cfg.api_key = "sk-1234567890abcdef".into();
        assert_eq!(cfg.effective_base_url().unwrap(), "https://x.example/v1");
    }
}
