//! L1 声明式流水线执行器。
//!
//! ## 执行语义（写清楚，因为插件作者要靠它推理）
//!
//! 1. **顺序执行**：`steps` 按声明顺序跑。`dependsOn` 只用于**校验**（保证 DAG 无环、
//!    不出现前向引用），不改变执行顺序 —— 这样最坏情况下的行为是"多跑一步"，
//!    而不是"因为图算错而跳过了关键步骤"。对文件处理来说前者可恢复，后者不可。
//! 2. **变量作用域**：每一步的产出写进 `steps.<id>.<key>`，**只有后续步骤**能引用。
//! 3. **失败策略**：默认 `fail`（整条流水线中止）。`skip` / `continue` 只影响当前步，
//!    但会在结果里留下 `skipped` 标记，前端会明确显示 —— 不允许静默跳过。
//! 4. **取消**：每个步骤开始前检查取消令牌；引擎调用内部也会检查（见 `toolforge-process`）。
//! 5. **`flow.branch`**：把 `steps.<id>.active` 写成 `"true"` / `"false"`，
//!    后续步骤通过 `when: ${steps.<id>.active} == true` 使用它。
//!    **刻意不做隐式控制流** —— 隐式分支是调试噩梦。
//! 6. **`flow.foreach`**：由**批量驱动层**（`apps/desktop` 的命令层）展开，
//!    执行器只把它当直通。原因是并发调度属于任务队列的职责，混进流水线执行器会让
//!    取消与进度上报变得极难推理。

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use toolforge_core::error::{ErrorCode, ToolforgeError, ToolforgeResult};
use toolforge_core::job::JobProgress;
use toolforge_core::permission::{CapabilityGuard, PathResolver, PathScope};
use toolforge_core::pipeline::{
    eval_condition, render_template, OnErrorPolicy, PipelineStep, TemplateContext,
};
use toolforge_core::plugin::{ParamValue, PluginRuntime};
use toolforge_core::queue::JobCtx;

use toolforge_engines::nodes::{self, NodeCtx};
use toolforge_engines::EngineRegistry;

use crate::store::PluginRecord;

/// 一次流水线运行的输入。
#[derive(Debug, Clone)]
pub struct PipelineRunRequest {
    /// 输入端口 id -> 真实文件路径列表
    pub inputs: HashMap<String, Vec<String>>,
    /// 输出端口 id -> 期望的目标路径（宿主已算好）
    pub outputs: HashMap<String, String>,
    pub params: HashMap<String, ParamValue>,
    /// 宿主为本次任务分配的真实目录
    pub input_root: PathBuf,
    pub output_root: PathBuf,
    pub plugin_data_root: PathBuf,
    pub workspace_root: PathBuf,
}

impl PipelineRunRequest {
    pub fn new(
        input_root: impl Into<PathBuf>,
        output_root: impl Into<PathBuf>,
        plugin_data_root: impl Into<PathBuf>,
        workspace_root: impl Into<PathBuf>,
    ) -> Self {
        Self {
            inputs: HashMap::new(),
            outputs: HashMap::new(),
            params: HashMap::new(),
            input_root: input_root.into(),
            output_root: output_root.into(),
            plugin_data_root: plugin_data_root.into(),
            workspace_root: workspace_root.into(),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StepResult {
    pub id: String,
    pub node: String,
    pub label: String,
    pub status: StepStatus,
    pub duration_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum StepStatus {
    Ok,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Default)]
pub struct PipelineRunResult {
    pub outputs: Vec<String>,
    pub values: HashMap<String, String>,
    pub steps: Vec<StepResult>,
    pub warnings: Vec<String>,
}

/// 执行一条 L1 流水线。
pub async fn run_pipeline(
    record: &PluginRecord,
    req: &PipelineRunRequest,
    engines: Arc<EngineRegistry>,
    job: &JobCtx,
) -> ToolforgeResult<PipelineRunResult> {
    let PluginRuntime::Pipeline { pipeline } = &record.manifest.runtime else {
        return Err(ToolforgeError::internal(
            "run_pipeline 被用在了非 L1 插件上（这是宿主 bug）",
        ));
    };

    // ---- 运行时权限裁决 ----
    let effective = record.effective();
    let guard = CapabilityGuard::new(record.id(), effective.clone());
    let resolver = PathResolver::new()
        .with_input(&req.input_root)
        .with_output(&req.output_root)
        .with_plugin_data(&req.plugin_data_root)
        .with_workspace(&req.workspace_root);

    // 申请了 fs 能力才能碰对应作用域；没申请就直接拒绝，而不是跑到一半才失败
    if pipeline_uses_fs(pipeline, "src")
        && !effective
            .capabilities
            .iter()
            .any(|c| matches!(c, toolforge_core::permission::Capability::FsRead { .. }))
    {
        crate::audit::record_violation(
            &record_dir_audit(record),
            record.id(),
            "流水线读取输入文件，但未声明 fsRead 能力",
        );
        return Err(ToolforgeError::violation(
            record.id(),
            "读取输入文件（fsRead 未声明）",
        ));
    }

    // ---- 参数：用清单里的默认值补齐 ----
    let mut params = req.params.clone();
    for spec in &record.manifest.io.params {
        if !params.contains_key(&spec.id) {
            if let Some(d) = &spec.default {
                params.insert(spec.id.clone(), d.clone());
            } else if spec.required {
                return Err(ToolforgeError::invalid(format!(
                    "缺少必需参数 `{}`（{}）",
                    spec.id, spec.label
                )));
            }
        }
    }

    let mut ctx = NodeCtx {
        job: job.clone(),
        engines,
        resolver,
        guard,
        params,
        vars: HashMap::new(),
    };

    // ---- 模板上下文初始值 ----
    let mut tctx = TemplateContext::new();
    for (port, paths) in &req.inputs {
        tctx.insert(format!("input.{port}"), paths.join(","));
        // 单值端口额外提供简写
        if paths.len() == 1 {
            tctx.insert(format!("input.{port}.first"), paths[0].clone());
        }
    }
    for (port, path) in &req.outputs {
        tctx.insert(format!("output.{port}"), path.clone());
    }
    for (k, v) in &ctx.params {
        tctx.insert(format!("params.{k}"), param_to_string(v));
    }
    // 最常见的两个端口给简写别名
    if let Some(first) = req.inputs.values().find_map(|v| v.first()) {
        tctx.insert("src", first.clone());
    }
    if let Some(first) = req.outputs.values().next() {
        tctx.insert("dst", first.clone());
    }

    let mut result = PipelineRunResult::default();
    let total_steps = pipeline.steps.len() as u64;

    for (idx, step) in pipeline.steps.iter().enumerate() {
        job.check()?;
        job.progress(JobProgress::ratio(
            format!("步骤 {}/{}：{}", idx + 1, total_steps, step_label(step)),
            idx as u64,
            total_steps,
        ));

        // ---- when 条件 ----
        if let Some(cond) = &step.when {
            match eval_condition(cond, &tctx) {
                Ok(false) => {
                    job.info(format!("跳过 `{}`（条件不成立）", step_label(step)));
                    result.steps.push(StepResult {
                        id: step.id.clone(),
                        node: step.uses.clone(),
                        label: step_label(step),
                        status: StepStatus::Skipped,
                        duration_ms: 0,
                        error: None,
                    });
                    continue;
                }
                Ok(true) => {}
                Err(e) => {
                    // 条件里的变量解析不了 = 清单写错了，直接报错而不是当成 false
                    return Err(ToolforgeError::plugin_invalid(format!(
                        "步骤 `{}` 的 when 条件无法求值：{}",
                        step.id, e.message
                    ))
                    .with_detail(format!("条件：{cond}")));
                }
            }
        }

        // ---- 渲染参数模板 ----
        let mut rendered: BTreeMap<String, String> = BTreeMap::new();
        for (k, v) in &step.with {
            let value = render_template(v, &tctx).map_err(|e| {
                e.with_subject(format!("步骤 `{}` 的参数 `{k}`", step.id))
            })?;
            rendered.insert(k.clone(), value);
        }

        // ---- 执行（含重试）----
        let started = std::time::Instant::now();
        let policy = step.on_error.unwrap_or(pipeline.on_error);
        let attempts = if policy == OnErrorPolicy::Retry {
            (step.retry + 1).max(1)
        } else {
            1
        };

        let mut last_err: Option<ToolforgeError> = None;
        let mut produced: Option<nodes::NodeOutput> = None;

        for attempt in 0..attempts {
            if attempt > 0 {
                job.warn(format!(
                    "重试 `{}`（第 {}/{} 次）",
                    step_label(step),
                    attempt,
                    attempts - 1
                ));
            }
            let fut = nodes::run(&mut ctx, &step.uses, &rendered);
            let outcome = match step.timeout_ms {
                Some(ms) if ms > 0 => {
                    match tokio::time::timeout(Duration::from_millis(ms), fut).await {
                        Ok(r) => r,
                        Err(_) => Err(ToolforgeError::new(
                            ErrorCode::Timeout,
                            format!("步骤 `{}` 执行超过 {ms} ms", step.id),
                        )),
                    }
                }
                _ => fut.await,
            };
            match outcome {
                Ok(o) => {
                    produced = Some(o);
                    last_err = None;
                    break;
                }
                Err(e) if e.code == ErrorCode::Cancelled => return Err(e),
                Err(e) => last_err = Some(e),
            }
        }

        let duration_ms = started.elapsed().as_millis() as u64;

        match produced {
            Some(out) => {
                // 把产出写进模板上下文
                for (k, v) in &out.values {
                    tctx.insert(format!("steps.{}.{}", step.id, k), v.clone());
                    ctx.vars.insert(format!("{}.{}", step.id, k), v.clone());
                }
                result.outputs.extend(out.outputs.clone());
                result.steps.push(StepResult {
                    id: step.id.clone(),
                    node: step.uses.clone(),
                    label: step_label(step),
                    status: StepStatus::Ok,
                    duration_ms,
                    error: None,
                });
            }
            None => {
                let err = last_err.unwrap_or_else(|| {
                    ToolforgeError::internal(format!("步骤 `{}` 未产出也未报错", step.id))
                });

                match policy {
                    OnErrorPolicy::Skip | OnErrorPolicy::Continue => {
                        // 明确记录跳过原因，绝不静默
                        result.warnings.push(format!(
                            "步骤 `{}` 失败但按策略跳过：{}",
                            step.id, err.message
                        ));
                        job.warn(format!("步骤 `{}` 失败，已按策略跳过", step.id));
                        tctx.insert(format!("steps.{}.error", step.id), err.message.clone());
                        result.steps.push(StepResult {
                            id: step.id.clone(),
                            node: step.uses.clone(),
                            label: step_label(step),
                            status: StepStatus::Skipped,
                            duration_ms,
                            error: Some(err.message),
                        });
                    }
                    _ => {
                        result.steps.push(StepResult {
                            id: step.id.clone(),
                            node: step.uses.clone(),
                            label: step_label(step),
                            status: StepStatus::Failed,
                            duration_ms,
                            error: Some(err.message.clone()),
                        });
                        return Err(err.with_subject(format!("步骤 `{}`", step.id)));
                    }
                }
            }
        }
    }

    job.progress_now(JobProgress::ratio("流水线完成", total_steps, total_steps));
    result.values = ctx.vars.clone();
    Ok(result)
}

/// 给审计日志用的轻量构造（执行器不持有 AuditLog 实例，用插件目录旁的 audit 目录）。
fn record_dir_audit(record: &PluginRecord) -> crate::audit::AuditLog {
    // 插件目录是 `<data>/plugins/<id>`，审计目录是 `<data>/audit`
    let audit_dir = record
        .dir
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.join("audit"))
        .unwrap_or_else(|| record.dir.join(".audit"));
    crate::audit::AuditLog::from_dir(audit_dir)
}

fn step_label(step: &PipelineStep) -> String {
    step.label.clone().unwrap_or_else(|| step.id.clone())
}

fn param_to_string(v: &ParamValue) -> String {
    match v {
        ParamValue::Str(s) => s.clone(),
        ParamValue::Int(i) => i.to_string(),
        ParamValue::Float(f) => {
            // 整数值不要显示成 "90.0"，那会让用户困惑
            if (f.fract()).abs() < f64::EPSILON {
                format!("{}", *f as i64)
            } else {
                f.to_string()
            }
        }
        ParamValue::Bool(b) => b.to_string(),
        ParamValue::List(l) => l.join(","),
    }
}

/// 流水线里是否出现了引用某个参数的步骤（用于粗略判断是否需要 fs 能力）
fn pipeline_uses_fs(pipeline: &toolforge_core::pipeline::PipelineDef, needle: &str) -> bool {
    pipeline.steps.iter().any(|s| {
        s.with
            .values()
            .any(|v| v.contains(&format!("${{{needle}}}")))
    })
}

/// 让 `PathScope` 在日志里可读
pub fn scope_label(scope: &PathScope) -> String {
    scope.describe()
}

#[cfg(test)]
mod tests {
    use super::*;
    use toolforge_core::permission::{Capability, PermissionSet};

    #[test]
    fn param_to_string_trims_float_noise() {
        assert_eq!(param_to_string(&ParamValue::Int(90)), "90");
        assert_eq!(param_to_string(&ParamValue::Float(90.0)), "90");
        assert_eq!(param_to_string(&ParamValue::Float(92.5)), "92.5");
        assert_eq!(param_to_string(&ParamValue::Bool(true)), "true");
        assert_eq!(
            param_to_string(&ParamValue::List(vec!["a".into(), "b".into()])),
            "a,b"
        );
    }

    #[test]
    fn pipeline_uses_fs_detects_template_reference() {
        let yaml = r#"
apiVersion: toolforge/v1
kind: Plugin
metadata: { id: com.test.fs, name: F, version: 1.0.0 }
runtime:
  kind: pipeline
  pipeline:
    steps:
      - id: s
        uses: fs.copy
        with:
          src: "${src}"
          dst: "${dst}"
"#;
        let m = toolforge_core::plugin::PluginManifest::from_yaml(yaml).unwrap();
        let PluginRuntime::Pipeline { pipeline } = &m.runtime else {
            panic!()
        };
        assert!(pipeline_uses_fs(pipeline, "src"));
        assert!(pipeline_uses_fs(pipeline, "dst"));
        assert!(!pipeline_uses_fs(pipeline, "params.width"));
    }

    #[test]
    fn step_label_falls_back_to_id() {
        let step = PipelineStep {
            id: "resize".into(),
            uses: "image.resize".into(),
            with: BTreeMap::new(),
            label: None,
            when: None,
            on_error: None,
            retry: 0,
            timeout_ms: None,
            position: None,
            depends_on: vec![],
        };
        assert_eq!(step_label(&step), "resize");
    }

    #[test]
    fn effective_permissions_gate_execution() {
        // 这个用例锁定一条关键不变量：没有 fsRead 授权就绝不能读输入
        let declared = PermissionSet::from_iter_caps([
            Capability::FsRead {
                scope: PathScope::Input,
            },
            Capability::FsWrite {
                scope: PathScope::Output,
            },
        ]);
        let granted_nothing = PermissionSet::empty();
        let eff = PermissionSet::effective(&declared, &granted_nothing);
        assert!(eff.is_empty(), "未授权时生效权限必须为空");
        assert!(!eff.has_read(&PathScope::Input));
        assert!(!eff.has_write(&PathScope::Output));
    }
}
