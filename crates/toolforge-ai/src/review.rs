//! AI 草稿的静态校验与安全审核。
//!
//! ## 这里的定位
//!
//! [`review_draft`] **不执行任何代码**，也不写盘。它只做两件事：
//!
//! 1. 把草稿喂给 [`toolforge_core::plugin::PluginManifest::validate`]（纯函数校验）；
//! 2. 在清单之上做**安全审查**：能力风险定级、可疑模式匹配、运行时选择是否恰当。
//!
//! 产物是一份 [`SecurityReview`]，它会原封不动地显示在用户点"安装"之前的确认页上。
//! **审核通过 ≠ 可以安装**：真正的门是用户逐条勾选权限。
//!
//! ## 可疑模式都查什么
//!
//! 这一层刻意"宁可误报"：AI 生成的 L3 插件里出现 `subprocess` / `eval` /
//! `socket` 而清单里没有 `exec` / `net`，几乎一定是越权尝试（无论是有意还是
//! 模型幻觉）。误报的代价是用户多点一次确认，漏报的代价是后门。

use serde::{Deserialize, Serialize};
use specta::Type;

use toolforge_core::error::ToolforgeError;
use toolforge_core::permission::RiskLevel;
use toolforge_core::plugin::{PluginManifest, PluginRuntime, ValidationReport};

/// 草稿里的一个文件
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DraftFile {
    pub path: String,
    pub content: String,
    pub language: String,
}

/// AI 生成的**内存草稿**。
///
/// 它**没有**任何写盘能力 —— 这是刻意的类型设计：想看盘就必须显式转成
/// [`toolforge_core::plugin::PluginSource`]，而那个转换发生在外壳层、
/// 在用户点了"安装"之后。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiDraft {
    /// 产生这次草稿的原始需求（写进溯源信息）
    pub prompt: String,
    /// 使用的模型标识
    pub model: String,
    /// 解析出来的文件
    pub files: Vec<DraftFile>,
    /// 原始文本（前端"查看原始输出"用）
    pub raw: String,
}

impl AiDraft {
    /// 取出 plugin.yaml 的内容
    pub fn manifest_yaml(&self) -> Option<&str> {
        self.files
            .iter()
            .find(|f| f.path == "plugin.yaml")
            .map(|f| f.content.as_str())
    }

    /// 解析成清单（失败说明模型输出不可用）
    pub fn parse_manifest(&self) -> Result<PluginManifest, ToolforgeError> {
        let yaml = self.manifest_yaml().ok_or_else(|| {
            ToolforgeError::new(
                toolforge_core::error::ErrorCode::AiRejected,
                "草稿里没有 plugin.yaml",
            )
        })?;
        PluginManifest::from_yaml(yaml)
    }

    /// 转换成可安装的 Bundle 来源。**只有用户确认之后才应该调用它。**
    pub fn into_source(self) -> toolforge_core::plugin::PluginSource {
        use toolforge_core::plugin::{BundleFile, FileEncoding, PluginSource};
        let yaml = self
            .files
            .iter()
            .find(|f| f.path == "plugin.yaml")
            .map(|f| f.content.clone())
            .unwrap_or_default();
        let files = self
            .files
            .into_iter()
            .filter(|f| f.path != "plugin.yaml")
            .map(|f| BundleFile {
                path: f.path,
                content: f.content,
                // AI 只产出文本；二进制（WASM）走不了这条路，必须在审核里被拦下
                encoding: FileEncoding::Utf8,
            })
            .collect();
        PluginSource::Bundle { yaml, files }
    }
}

/// 审核发现
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFinding {
    pub severity: RiskLevel,
    /// 稳定标识，前端可据此做特殊展示
    pub code: String,
    pub message: String,
    /// 代码片段或字段路径
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<String>,
}

/// 审核报告
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SecurityReview {
    /// 清单能否被解析
    pub parseable: bool,
    /// 静态校验报告（错误码与 CLI 校验器一致）
    pub validation: Option<ValidationReport>,
    /// 解析失败时的原因
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parse_error: Option<String>,
    /// 整体风险等级 = 所有发现里最高的那一档
    pub risk_level: RiskLevel,
    /// 逐条发现
    pub findings: Vec<ReviewFinding>,
    /// **是否建议放行到"用户确认"环节**。注意：为 true 也不代表可以直接装。
    pub recommended: bool,
    /// 运行时摘要，展示在确认页顶部
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_summary: Option<String>,
    /// 需要用户逐条勾选的能力（中文描述）
    pub capabilities: Vec<String>,
}

/// 对一份草稿做静态校验 + 安全审核。
pub fn review_draft(draft: &AiDraft) -> SecurityReview {
    let mut findings: Vec<ReviewFinding> = Vec::new();

    // ---------- 1. 清单解析 ----------
    let manifest = match draft.parse_manifest() {
        Ok(m) => m,
        Err(e) => {
            return SecurityReview {
                parseable: false,
                validation: None,
                parse_error: Some(match &e.detail {
                    Some(d) => format!("{}\n{d}", e.message),
                    None => e.message,
                }),
                risk_level: RiskLevel::Critical,
                findings: vec![ReviewFinding {
                    severity: RiskLevel::Critical,
                    code: "PARSE_FAILED".into(),
                    message: "生成的清单无法解析，不能安装".into(),
                    evidence: None,
                }],
                recommended: false,
                runtime_summary: None,
                capabilities: vec![],
            };
        }
    };

    // ---------- 2. 静态校验 ----------
    let validation = manifest.validate();
    for issue in &validation.issues {
        findings.push(ReviewFinding {
            severity: match issue.severity {
                toolforge_core::plugin::Severity::Error => RiskLevel::High,
                toolforge_core::plugin::Severity::Warning => RiskLevel::Medium,
                toolforge_core::plugin::Severity::Info => RiskLevel::Low,
            },
            code: issue.code.clone(),
            message: issue.message.clone(),
            evidence: issue.path.clone(),
        });
    }

    // ---------- 3. 运行时选择的合理性 ----------
    let runtime_summary = match &manifest.runtime {
        PluginRuntime::Pipeline { pipeline } => {
            let req = pipeline.required_engines();
            if req.is_empty() {
                Some(format!(
                    "L1 声明式 · {} 个步骤 · 无外部引擎依赖（开箱可用）",
                    pipeline.steps.len()
                ))
            } else {
                Some(format!(
                    "L1 声明式 · {} 个步骤 · 需要引擎：{}",
                    pipeline.steps.len(),
                    req.join(", ")
                ))
            }
        }
        PluginRuntime::Wasm { wasm } => {
            findings.push(ReviewFinding {
                severity: RiskLevel::Low,
                code: "RUNTIME_WASM".into(),
                message: "L2 WASM 沙箱：无法访问文件系统与网络，是三类运行时里最安全的".into(),
                evidence: None,
            });
            // WASM 做不了文件处理，这是最常见的"AI 生成错误"
            if manifest.io.inputs.iter().any(|p| {
                p.accept
                    .iter()
                    .any(|a| a.starts_with("image/") || a.starts_with("video/") || a.starts_with("audio/"))
            }) {
                findings.push(ReviewFinding {
                    severity: RiskLevel::High,
                    code: "WASM_MEDIA_INPUT".into(),
                    message: "WASM 运行时无法处理图片/音视频：沙箱里没有文件系统、没有 SIMD，\
                              也不可能塞进解码器。这个插件装上也跑不起来。"
                        .into(),
                    evidence: Some("io.inputs".into()),
                });
            }
            Some(format!(
                "L2 WASM 沙箱 · 内存上限 {} MB · 超时 {} ms（超出即 trap）",
                wasm.memory_limit_mb, wasm.timeout_ms
            ))
        }
        PluginRuntime::Python { python } => {
            findings.push(ReviewFinding {
                severity: RiskLevel::Critical,
                code: "RUNTIME_PYTHON".into(),
                message: "这个插件包含**可执行 Python 代码**。它将以你的身份运行，\
                          请逐行阅读后再决定是否安装。"
                    .into(),
                evidence: Some(python.entry.clone()),
            });
            if !python.allow_network && manifest.permissions.wants_network() {
                findings.push(ReviewFinding {
                    severity: RiskLevel::High,
                    code: "NET_DECLARED_BUT_DISABLED".into(),
                    message: "清单声明了网络能力，但 python.allowNetwork 为 false，两者不一致".into(),
                    evidence: Some("runtime.python.allowNetwork".into()),
                });
            }
            Some(format!(
                "L3 Python 进程 · 入口 {} · 依赖 {} 个包 · {} · 超时 {} ms",
                python.entry,
                python.requirements.len(),
                if python.allow_network {
                    "允许联网"
                } else {
                    "已禁网"
                },
                python.timeout_ms
            ))
        }
    };

    // ---------- 4. 能力风险 ----------
    for cap in &manifest.permissions.capabilities {
        let risk = cap.risk();
        if risk >= RiskLevel::High {
            findings.push(ReviewFinding {
                severity: risk,
                code: "HIGH_RISK_CAPABILITY".into(),
                message: format!("申请了高危能力：{}", cap.describe()),
                evidence: None,
            });
        }
    }

    // ---------- 5. 代码层的可疑模式 ----------
    let code_files: Vec<&DraftFile> = draft
        .files
        .iter()
        .filter(|f| {
            matches!(f.language.as_str(), "python" | "py" | "javascript" | "js" | "sh" | "bash")
                || f.path.ends_with(".py")
        })
        .collect();

    if !code_files.is_empty() {
        for f in &code_files {
            scan_code(f, &manifest, &mut findings);
        }
        // L1 清单里不该出现代码文件
        if matches!(manifest.runtime, PluginRuntime::Pipeline { .. }) {
            findings.push(ReviewFinding {
                severity: RiskLevel::Critical,
                code: "CODE_WITH_L1_RUNTIME".into(),
                message: "声明的是 L1 声明式运行时，却附带了代码文件。这些文件不会被执行，\
                          但它们的存在说明生成结果自相矛盾，请勿安装。"
                    .into(),
                evidence: Some(
                    code_files
                        .iter()
                        .map(|f| f.path.as_str())
                        .collect::<Vec<_>>()
                        .join(", "),
                ),
            });
        }
    }

    // ---------- 6. 汇总 ----------
    let risk_level = findings
        .iter()
        .map(|f| f.severity)
        .max()
        .unwrap_or(RiskLevel::Low);

    // 有 Error 级别校验问题 或 Critical 发现 → 不建议继续
    let recommended = validation.ok
        && !findings
            .iter()
            .any(|f| f.severity == RiskLevel::Critical && f.code != "RUNTIME_PYTHON");

    SecurityReview {
        parseable: true,
        validation: Some(validation),
        parse_error: None,
        risk_level,
        findings,
        recommended,
        runtime_summary,
        capabilities: manifest
            .permissions
            .capabilities
            .iter()
            .map(|c| c.describe())
            .collect(),
    }
}

/// 在代码里找"清单没声明却用了"的危险 API。
fn scan_code(f: &DraftFile, manifest: &PluginManifest, out: &mut Vec<ReviewFinding>) {
    // (模式, 需要的能力, 说明)
    const PATTERNS: &[(&str, CapabilityNeed, &str)] = &[
        ("subprocess", CapabilityNeed::Exec, "启动子进程"),
        ("os.system", CapabilityNeed::Exec, "执行 shell 命令"),
        ("os.popen", CapabilityNeed::Exec, "执行 shell 命令"),
        ("eval(", CapabilityNeed::Code, "动态求值代码"),
        ("exec(", CapabilityNeed::Code, "动态执行代码"),
        ("__import__", CapabilityNeed::Code, "动态导入模块"),
        ("socket", CapabilityNeed::Net, "原始套接字（可绕过代理环境变量）"),
        ("requests.", CapabilityNeed::Net, "发起 HTTP 请求"),
        ("urllib", CapabilityNeed::Net, "发起 HTTP 请求"),
        ("httpx", CapabilityNeed::Net, "发起 HTTP 请求"),
        ("open(", CapabilityNeed::Fs, "读写文件"),
        ("pathlib", CapabilityNeed::Fs, "读写文件"),
        ("shutil", CapabilityNeed::Fs, "文件操作（含删除）"),
        ("os.remove", CapabilityNeed::Fs, "删除文件"),
        ("os.rmdir", CapabilityNeed::Fs, "删除目录"),
        ("globals()", CapabilityNeed::Code, "反射访问全局命名空间"),
        ("getattr(", CapabilityNeed::Code, "动态属性访问"),
    ];

    for (needle, need, human) in PATTERNS {
        if !f.content.contains(needle) {
            continue;
        }
        let declared = match need {
            CapabilityNeed::Exec => manifest.permissions.wants_exec(),
            CapabilityNeed::Net => manifest.permissions.wants_network(),
            CapabilityNeed::Fs => !manifest.permissions.capabilities.is_empty()
                && manifest.permissions.capabilities.iter().any(|c| {
                    matches!(
                        c,
                        toolforge_core::permission::Capability::FsRead { .. }
                            | toolforge_core::permission::Capability::FsWrite { .. }
                    )
                }),
            // 动态代码执行没有任何能力声明能覆盖它 —— 永远是危险的
            CapabilityNeed::Code => false,
        };

        if declared {
            continue;
        }

        let severity = match need {
            CapabilityNeed::Code => RiskLevel::Critical,
            CapabilityNeed::Exec => RiskLevel::Critical,
            CapabilityNeed::Net => RiskLevel::High,
            CapabilityNeed::Fs => RiskLevel::Medium,
        };

        let extra = match need {
            CapabilityNeed::Code => {
                "（动态代码执行没有任何清单能力能覆盖，这一项几乎必然意味着越权）"
            }
            CapabilityNeed::Net => "（提示：L3 默认禁网，此调用会失败）",
            CapabilityNeed::Exec => "（提示：插件进程只能起它自己，起外部程序会被拒绝）",
            CapabilityNeed::Fs => "（提示：文件访问受路径收敛限制）",
        };

        out.push(ReviewFinding {
            severity,
            code: format!("UNDECLARED_{needle}"),
            message: format!(
                "`{}` 里出现了 `{needle}`（{human}），但清单没有声明对应能力 {extra}",
                f.path
            ),
            evidence: Some(first_matching_line(&f.content, needle)),
        });
    }
}

#[derive(Debug, Clone, Copy)]
enum CapabilityNeed {
    Exec,
    Net,
    Fs,
    Code,
}

fn first_matching_line(content: &str, needle: &str) -> String {
    content
        .lines()
        .enumerate()
        .find(|(_, l)| l.contains(needle))
        .map(|(i, l)| format!("第 {} 行：{}", i + 1, l.trim()))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft_with(yaml: &str) -> AiDraft {
        AiDraft {
            prompt: "测试".into(),
            model: "test".into(),
            files: vec![DraftFile {
                path: "plugin.yaml".into(),
                content: yaml.into(),
                language: "yaml".into(),
            }],
            raw: yaml.into(),
        }
    }

    const GOOD_L1: &str = r#"
apiVersion: toolforge/v1
kind: Plugin
metadata:
  id: com.user.resize
  name: 批量缩放
  version: 1.0.0
permissions:
  capabilities:
    - kind: fsRead
      scope: { kind: input }
    - kind: fsWrite
      scope: { kind: output }
runtime:
  kind: pipeline
  pipeline:
    steps:
      - id: resize
        uses: image.resize
        with:
          src: "${src}"
          width: "1280"
          height: "0"
          dst: "${dst}"
"#;

    #[test]
    fn good_l1_draft_is_recommended() {
        let r = review_draft(&draft_with(GOOD_L1));
        assert!(r.parseable);
        assert!(r.recommended, "findings: {:?}", r.findings);
        assert_eq!(r.risk_level, RiskLevel::Low);
        assert!(r.runtime_summary.unwrap().contains("L1"));
        assert_eq!(r.capabilities.len(), 2);
    }

    #[test]
    fn unparseable_yaml_is_critical_and_not_recommended() {
        let r = review_draft(&draft_with("这不是 YAML: ["));
        assert!(!r.parseable);
        assert!(!r.recommended);
        assert_eq!(r.risk_level, RiskLevel::Critical);
        assert!(r.parse_error.is_some());
    }

    #[test]
    fn unknown_node_yields_error_finding() {
        let bad = GOOD_L1.replace("image.resize", "image.magic");
        let r = review_draft(&draft_with(&bad));
        assert!(!r.recommended);
        assert!(r
            .findings
            .iter()
            .any(|f| f.code == "STEP_UNKNOWN_NODE"));
    }

    #[test]
    fn python_runtime_is_flagged_critical() {
        let yaml = r#"
apiVersion: toolforge/v1
kind: Plugin
metadata: { id: com.user.py, name: P, version: 1.0.0 }
runtime:
  kind: python
  python:
    entry: main.py
"#;
        let mut d = draft_with(yaml);
        d.files.push(DraftFile {
            path: "main.py".into(),
            content: "def run(p):\n    return {}\n".into(),
            language: "python".into(),
        });
        let r = review_draft(&d);
        assert_eq!(r.risk_level, RiskLevel::Critical);
        assert!(r.findings.iter().any(|f| f.code == "RUNTIME_PYTHON"));
        // 即便 recommended 为 true，"可执行代码"这件事也必须被显式说出来
        assert!(r
            .findings
            .iter()
            .any(|f| f.message.contains("可执行 Python 代码")));
    }

    #[test]
    fn undeclared_subprocess_is_critical() {
        let yaml = r#"
apiVersion: toolforge/v1
kind: Plugin
metadata: { id: com.user.py, name: P, version: 1.0.0 }
runtime:
  kind: python
  python:
    entry: main.py
"#;
        let mut d = draft_with(yaml);
        d.files.push(DraftFile {
            path: "main.py".into(),
            // 清单没声明 exec，这里却想起进程
            content: "import subprocess\nsubprocess.run(['calc'])\n".into(),
            language: "python".into(),
        });
        let r = review_draft(&d);
        let f = r
            .findings
            .iter()
            .find(|f| f.code.contains("subprocess"))
            .expect("应当报出 subprocess");
        assert_eq!(f.severity, RiskLevel::Critical);
        assert!(f.evidence.as_ref().unwrap().contains("第 1 行"));
        assert!(!r.recommended, "越权尝试不应被推荐");
    }

    #[test]
    fn eval_is_always_flagged_even_with_all_capabilities() {
        // eval 没有任何清单能力能覆盖 —— 声明了 exec 也照样报
        let yaml = r#"
apiVersion: toolforge/v1
kind: Plugin
metadata: { id: com.user.py, name: P, version: 1.0.0 }
permissions:
  capabilities:
    - kind: exec
    - kind: net
      hosts: []
runtime:
  kind: python
  python:
    entry: main.py
    allowNetwork: true
"#;
        let mut d = draft_with(yaml);
        d.files.push(DraftFile {
            path: "main.py".into(),
            content: "eval(user_input)\n".into(),
            language: "python".into(),
        });
        let r = review_draft(&d);
        assert!(r.findings.iter().any(|f| f.code.contains("eval(")));
    }

    #[test]
    fn declared_capability_suppresses_the_finding() {
        let yaml = r#"
apiVersion: toolforge/v1
kind: Plugin
metadata: { id: com.user.py, name: P, version: 1.0.0 }
permissions:
  capabilities:
    - kind: net
      hosts: ["api.example.com"]
runtime:
  kind: python
  python:
    entry: main.py
    allowNetwork: true
"#;
        let mut d = draft_with(yaml);
        d.files.push(DraftFile {
            path: "main.py".into(),
            content: "import requests\nrequests.get('https://api.example.com')\n".into(),
            language: "python".into(),
        });
        let r = review_draft(&d);
        // 已经声明了 net，就不该再报"未声明的网络访问"
        assert!(!r.findings.iter().any(|f| f.code.contains("UNDECLARED")));
    }

    #[test]
    fn wasm_with_media_input_is_flagged() {
        let yaml = r#"
apiVersion: toolforge/v1
kind: Plugin
metadata: { id: com.user.w, name: W, version: 1.0.0 }
io:
  inputs:
    - id: src
      label: 图片
      type: file
      accept: ["image/*"]
      required: true
runtime:
  kind: wasm
  wasm:
    path: plugin.wasm
"#;
        let mut d = draft_with(yaml);
        d.files.push(DraftFile {
            path: "plugin.wasm".into(),
            content: "AGFzbQ==".into(),
            language: "wasm".into(),
        });
        let r = review_draft(&d);
        assert!(
            r.findings.iter().any(|f| f.code == "WASM_MEDIA_INPUT"),
            "findings: {:?}",
            r.findings
        );
    }

    #[test]
    fn code_files_with_pipeline_runtime_is_contradictory() {
        let mut d = draft_with(GOOD_L1);
        d.files.push(DraftFile {
            path: "helper.py".into(),
            content: "print('nothing')".into(),
            language: "python".into(),
        });
        let r = review_draft(&d);
        assert!(r
            .findings
            .iter()
            .any(|f| f.code == "CODE_WITH_L1_RUNTIME"));
        assert!(!r.recommended);
    }

    #[test]
    fn into_source_splits_manifest_from_files() {
        let mut d = draft_with(GOOD_L1);
        d.files.push(DraftFile {
            path: "extra.txt".into(),
            content: "hi".into(),
            language: "text".into(),
        });
        let src = d.into_source();
        match src {
            toolforge_core::plugin::PluginSource::Bundle { yaml, files } => {
                assert!(yaml.contains("apiVersion"));
                assert_eq!(files.len(), 1);
                assert_eq!(files[0].path, "extra.txt");
            }
            _ => panic!("应当是 Bundle"),
        }
    }

    #[test]
    fn high_risk_capability_is_surfaced() {
        let yaml = GOOD_L1.replace(
            "    - kind: fsWrite\n      scope: { kind: output }",
            "    - kind: exec",
        );
        let r = review_draft(&draft_with(&yaml));
        assert!(r.findings.iter().any(|f| f.code == "HIGH_RISK_CAPABILITY"));
        assert_eq!(r.risk_level, RiskLevel::Critical);
    }
}
