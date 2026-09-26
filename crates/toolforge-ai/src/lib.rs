//! # toolforge-ai
//!
//! "用自然语言描述需求 → 生成插件"这条链路。
//!
//! ## 这条链路最危险的地方在哪里
//!
//! 不在于"AI 会不会写出有 bug 的代码"，而在于**用户会把 AI 的产出当成可信的**。
//! 一个人工写的插件，用户至少知道是谁写的；一个 AI 生成的插件，用户的心理防线
//! 会低很多。所以要害是**流程设计**，不是模型能力：
//!
//! ```text
//! ① 生成（本模块 provider）
//! ② 静态校验（PluginManifest::validate —— 纯函数，不碰磁盘不联网）
//! ③ 安全审核（review：能力清单 + 可疑模式 + 风险定级）
//! ④ ★ 人工确认（前端展示 diff 与权限清单，逐条勾选）★  ← 真正的安全边界在这
//! ⑤ 落盘 → 哈希锁定 → 装载时再校验一次
//! ```
//!
//! **第 ④ 步不能自动化。** 本模块提供 `AiDraft`（一个**内存里的草稿**），
//! 它没有任何写盘能力。只有外壳层在用户明确点击"安装"之后，才会把草稿转成
//! [`toolforge_core::plugin::PluginSource`] 交给 `PluginStore::install`。
//! 这样即使模型被提示词注入攻陷，它也只能产出一个"用户看得见的草稿"。
//!
//! ## 输出形态的选择
//!
//! 提示词**强烈引导模型输出 L1（声明式清单）**。原因：
//!
//! * L1 的产物是**数据**，宿主逐节点执行，能力边界在编译期就固定了；
//! * L2 只能做纯计算，能覆盖的需求太少；
//! * L3 是任意代码执行，**必须**用户明确知情并逐条授权。
//!
//! 当需求确实需要 L3 时，`review` 会把风险等级直接标成 `Critical`，
//! 并在 `warnings` 里说明"这是可执行代码，请逐行阅读"。

pub mod provider;
pub mod review;

pub use provider::{AiProviderConfig, AiProviderKind, ChatMessage};
// GenerationRequest 定义在本文件里（因为它同时被 review 与外壳层使用），
// 不需要从 provider 再导出一次。
pub use review::{review_draft, AiDraft, DraftFile, SecurityReview};

use toolforge_core::error::{ErrorCode, ToolforgeError, ToolforgeResult};

/// 系统提示词。
///
/// 刻意把**节点目录**与**安全约束**都塞进去 —— 模型不知道 ToolForge 有哪些内置节点，
/// 不告诉它就只能瞎编 `uses` 字段，然后在校验阶段被拒。
/// 这也解释了为什么 [`review`] 里要专门检查"未知节点"这一类错误。
pub fn system_prompt() -> String {
    let nodes = toolforge_core::pipeline::builtin_nodes();
    let mut node_list = String::new();
    for n in &nodes {
        let engines = if n.requires_engines.is_empty() {
            "无外部依赖".to_string()
        } else {
            format!("需要引擎：{}", n.requires_engines.join(", "))
        };
        node_list.push_str(&format!(
            "- `{}`（{}）：{} 〔{}〕\n",
            n.name, n.label, n.description, engines
        ));
    }

    format!(
        r#"你是 ToolForge 的插件生成助手。ToolForge 是一个桌面工具箱，用户可以用 YAML 声明式清单（L1 插件）来编排内置节点完成文件处理任务。

# 你的输出

只输出**一个** `plugin.yaml` 文件的内容，放在 ```yaml 代码块里。不要输出解释文字。
如果需要多个文件（仅在确实必须用 Python 时），用如下格式输出多个代码块：

```yaml path=plugin.yaml
...
```
```python path=main.py
...
```

# 硬性约束

1. `apiVersion` 必须是 `toolforge/v1`，`kind` 必须是 `Plugin`。
2. `metadata.id` 只能用小写字母、数字、`.`、`-`、`_`，长度 3~128，建议用 `com.user.<功能名>`。
3. `metadata.version` 必须是合法 semver（如 `1.0.0`）。
4. `runtime.pipeline.steps[].uses` **必须**取自下面的内置节点清单，不许编造。
5. 所有 YAML 字段名用 **camelCase**（例如 `apiVersion`、`onError`、`memoryLimitMb`）。
6. `permissions.capabilities` 只能申请真正需要的，**最小化**：
   - 读输入：`{{ kind: fsRead, scope: {{ kind: input }} }}`
   - 写输出：`{{ kind: fsWrite, scope: {{ kind: output }} }}`
   - 出网：`{{ kind: net, hosts: [] }}`（极少数情况才需要）
   - 起进程：`{{ kind: exec }}`（几乎永远不该出现）
7. 变量模板用 `${{...}}`：`${{src}}` / `${{dst}}` / `${{input.<端口>}}` / `${{output.<端口>}}` / `${{params.<参数>}}` / `${{steps.<步骤id>.<键>}}` / `${{vars.<变量名>}}`。
8. **参数写在哪**（最容易搞错，请严格遵守）：
   - **路径与流程接线**（`src` / `dst` / `path` / `name` / `duration` 等）写在步骤的 `with:` 里；
   - **用户可调的选项**（格式、质量、宽度、模型名等）写在插件顶层的 `io.params:` 里，
     并在 `with` 里用 `"${{params.<id>}}"` 传进去；
   - 两种写法执行器都支持（`with` 里的显式字面量优先），但**上面这种分工才是推荐形态**：
     它让参数出现在 UI 表单里，用户能改。
   - 参数 **id 必须与内置节点读取的键名逐字一致**（例如 `image.convert` 读 `format` / `quality`）。
9. `with` 的**值必须是字符串**（写 `width: 1280` 会解析失败，要写 `width: "1280"`）。
10. **只能引用前面步骤的产出**，不允许前向引用。
11. enum 参数必须给 `options`。
12. **优先用 L1**。只有在内置节点完全无法表达计算逻辑时，才用 `runtime.kind: python`（不要用 wasm 做图像处理，WASM 里没有文件系统和 SIMD）。
13. 如果某个节点的执行器尚未实现（`image.remove-background` / `doc.ocr` / `ebook.convert` / `ai.upscale` / `ai.describe`），
    你仍然可以生成引用它们的清单，但**必须在 `metadata.description` 里明确写出"该能力尚未实现"**，不要让用户以为能跑。
14. **不要写批量循环**：多文件输入与目录输入由宿主自动逐文件扇出，每一批都能用
    `${{batch.index}}`（从 1 起）拿到序号。清单里没有任何循环节点，也不需要。

# 内置节点清单

{node_list}
# 示例

```yaml
apiVersion: toolforge/v1
kind: Plugin
metadata:
  id: com.user.webp-batch
  name: 批量转 WebP
  version: 1.0.0
  description: 把图片批量转成 WebP 并限制最大宽度
  category: image
  icon: image
permissions:
  capabilities:
    - kind: fsRead
      scope: {{ kind: input }}
    - kind: fsWrite
      scope: {{ kind: output }}
io:
  inputs:
    - id: src
      label: 源图片
      type: file
      accept: ["image/*"]
      multiple: true
      required: true
  outputs:
    - id: dst
      label: 输出图片
      type: file
  params:
    - id: maxWidth
      label: 最大宽度
      type: int
      default: {{ kind: int, value: 1920 }}
      min: 16
      max: 20000
runtime:
  kind: pipeline
  pipeline:
    steps:
      - id: resize
        uses: image.resize
        with:
          src: "${{src}}"
          width: "${{params.maxWidth}}"
          height: "0"
          dst: "${{dst}}"
      - id: convert
        uses: image.convert
        with:
          src: "${{steps.resize.path}}"
          format: "webp"
          quality: "90"
          dst: "${{dst}}"
```

注意上例中的分工：`maxWidth` 是用户可调的，所以放在 `io.params` 并由 `with` 用
`${{params.maxWidth}}` 注入；`width` / `format` / `quality` 这类节点读的键名
**在 `with` 里直接给字面量也生效**（执行器会先看 `with` 再看用户参数）。
"#
    )
}

/// 把用户的自然语言需求补全成一条完整提示。
pub fn build_user_prompt(req: &GenerationRequest) -> String {
    let mut s = String::new();
    s.push_str("需求：");
    s.push_str(&req.description);
    s.push('\n');

    if !req.available_engines.is_empty() {
        s.push_str(&format!(
            "\n用户已安装的引擎：{}\n（如果某个节点需要未安装的引擎，请在清单的 description 里提醒用户先去「引擎管理」安装。）\n",
            req.available_engines.join(", ")
        ));
    }

    if let Some(hint) = &req.category_hint {
        s.push_str(&format!("\n分类建议：{hint}\n"));
    }

    s.push_str("\n请只输出 YAML（如需 Python 则按约定加代码块）。");
    s
}

/// 生成请求
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GenerationRequest {
    /// 用户用自然语言描述的需求
    pub description: String,
    /// 当前可用的引擎 id（让模型避开缺失引擎，或在描述里提示）
    #[serde(default)]
    pub available_engines: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category_hint: Option<String>,
    /// 是否允许生成 L3 Python（默认 false —— 需要用户显式同意）
    #[serde(default)]
    pub allow_python: bool,
}

impl GenerationRequest {
    pub fn new(description: impl Into<String>) -> Self {
        Self {
            description: description.into(),
            available_engines: vec![],
            category_hint: None,
            allow_python: false,
        }
    }
}

/// 把模型返回的原始文本切成若干文件。
///
/// 支持两种形态：
/// * ```` ```yaml ```` 单块 → `plugin.yaml`
/// * ```` ```yaml path=plugin.yaml ```` / ```` ```python path=main.py ```` → 多文件
pub fn parse_model_output(raw: &str) -> ToolforgeResult<Vec<DraftFile>> {
    let mut files: Vec<DraftFile> = Vec::new();
    let mut current_lang: Option<String> = None;
    let mut current_path: Option<String> = None;
    let mut buf = String::new();

    for line in raw.lines() {
        if let Some(rest) = line.trim_start().strip_prefix("```") {
            if current_lang.is_none() {
                // 开始一个代码块
                let rest = rest.trim();
                let mut lang = rest.to_string();
                let mut path = None;
                if let Some(idx) = rest.find("path=") {
                    lang = rest[..idx].trim().to_string();
                    path = Some(rest[idx + 5..].trim().trim_matches('"').to_string());
                }
                current_lang = Some(lang);
                current_path = path;
                buf.clear();
            } else {
                // 结束代码块
                let lang = current_lang.take().unwrap_or_default();
                let path = current_path.take().unwrap_or_else(|| {
                    match lang.as_str() {
                        "yaml" | "yml" => "plugin.yaml".to_string(),
                        "python" | "py" => "main.py".to_string(),
                        other => format!("file.{other}"),
                    }
                });
                if !buf.trim().is_empty() {
                    files.push(DraftFile {
                        path,
                        content: buf.clone(),
                        language: lang,
                    });
                }
                buf.clear();
            }
            continue;
        }
        if current_lang.is_some() {
            buf.push_str(line);
            buf.push('\n');
        }
    }

    if files.is_empty() {
        // 模型没按约定包代码块？如果整段看起来就是 YAML，宽容接受
        if raw.contains("apiVersion:") {
            return Ok(vec![DraftFile {
                path: "plugin.yaml".into(),
                content: raw.trim().to_string(),
                language: "yaml".into(),
            }]);
        }
        return Err(ToolforgeError::new(
            ErrorCode::AiRejected,
            "模型输出里没有找到任何代码块",
        )
        .with_detail("期望形如 ```yaml ... ``` 的块。"));
    }

    // plugin.yaml 必须存在
    if !files.iter().any(|f| f.path == "plugin.yaml") {
        return Err(ToolforgeError::new(
            ErrorCode::AiRejected,
            "模型输出里没有 `plugin.yaml`",
        )
        .with_detail(format!(
            "实际产出的文件：{}",
            files
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )));
    }

    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_single_yaml_block() {
        let raw = "这是说明文字\n```yaml\napiVersion: toolforge/v1\nkind: Plugin\n```\n完毕";
        let files = parse_model_output(raw).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "plugin.yaml");
        assert!(files[0].content.contains("apiVersion"));
    }

    #[test]
    fn parses_multi_file_blocks_with_lang_annotation() {
        // 这是常见的"```yaml path=..."写法
        let raw = "```yaml path=plugin.yaml\napiVersion: toolforge/v1\n```\n\
                   ```python path=main.py\nprint(1)\n```";
        let files = parse_model_output(raw).unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "plugin.yaml");
        assert_eq!(files[1].path, "main.py");
        assert_eq!(files[1].language, "python");
    }

    #[test]
    fn parses_bare_language_annotated_blocks() {
        let raw = "```yaml\napiVersion: toolforge/v1\n```\n```python\nprint(1)\n```";
        let files = parse_model_output(raw).unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[1].path, "main.py");
    }

    #[test]
    fn missing_plugin_yaml_is_rejected() {
        let raw = "```python\nprint(1)\n```";
        let err = parse_model_output(raw).unwrap_err();
        assert_eq!(err.code, ErrorCode::AiRejected);
        assert!(err.detail.unwrap().contains("main.py"));
    }

    #[test]
    fn output_without_code_block_is_rejected() {
        let err = parse_model_output("我不太确定你想要什么。").unwrap_err();
        assert_eq!(err.code, ErrorCode::AiRejected);
    }

    #[test]
    fn raw_yaml_without_fences_is_tolerated() {
        // 有些模型（尤其是本地小模型）会直接吐裸 YAML
        let raw = "apiVersion: toolforge/v1\nkind: Plugin\nmetadata: {}\n";
        let files = parse_model_output(raw).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "plugin.yaml");
    }

    #[test]
    fn system_prompt_lists_real_nodes() {
        let p = system_prompt();
        // 提示词必须包含真实的节点名，否则模型只能编
        assert!(p.contains("image.convert"));
        assert!(p.contains("video.transcode"));
        assert!(p.contains("archive.unpack"));
        assert!(p.contains("toolforge/v1"));
        // 必须明确要求 camelCase
        assert!(p.contains("camelCase"));
    }

    #[test]
    fn user_prompt_includes_available_engines() {
        let mut req = GenerationRequest::new("把视频压到 10MB");
        req.available_engines = vec!["ffmpeg".into()];
        let p = build_user_prompt(&req);
        assert!(p.contains("ffmpeg"));
        assert!(p.contains("把视频压到 10MB"));
    }
}
