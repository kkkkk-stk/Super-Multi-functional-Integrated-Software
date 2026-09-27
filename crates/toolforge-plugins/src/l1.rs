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
//! 6. **批量**：**清单里不需要写循环，也没有循环节点**。多文件输入（以及目录输入）
//!    由命令层 `apps/desktop/src-tauri/src/commands.rs::expand_batches` 展开成
//!    N 个单文件批次，逐批调用一次本函数；每批通过 `${batch.index}` 拿到序号。
//!    执行器本身不做并发调度 —— 那是任务队列的职责，混进来会让取消与进度上报
//!    变得无法推理。

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
///
/// 手写 `Debug`：`vision` 是 `dyn` trait 对象，没有（也不该有）`Debug` ——
/// 它背后是 HTTP 连接池与 API Key，打印出来只会是噪音或者泄漏。
/// 这里只报"配没配"。
#[derive(Clone)]
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
    /// 本次调用是批量的第几项（**1-based**）。非批量时为 1。
    ///
    /// 批量由命令层扇出（每个文件一次调用），流水线本身看不到"我跑了几次"。
    /// 但"给每个文件编个号"是最常见的重命名需求，所以把序号显式传进来，
    /// 由 `${batch.index}` 暴露给清单。
    pub batch_index: u32,
    /// 本批次总项数，`${batch.total}`
    pub batch_total: u32,
    /// 视觉客户端，注入给 `ai.describe` / `doc.ocr` 这类需要多模态模型的节点。
    ///
    /// 为 `None` 是**正常状态**（用户没配 AI）—— 那类节点会报一条可操作的错误，
    /// 而不是 panic，也不影响其它任何节点。
    pub vision: Option<Arc<dyn toolforge_core::ai::VisionClient>>,
}

impl std::fmt::Debug for PipelineRunRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PipelineRunRequest")
            .field("inputs", &self.inputs)
            .field("outputs", &self.outputs)
            .field("params", &self.params)
            .field("input_root", &self.input_root)
            .field("output_root", &self.output_root)
            .field("batch_index", &self.batch_index)
            .field("batch_total", &self.batch_total)
            .field("vision", &self.vision.as_ref().map(|v| v.model_name()))
            .finish()
    }
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
            batch_index: 1,
            batch_total: 1,
            vision: None,
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
///
/// `audit` 必须是**应用那一个**审计日志（`PluginStore::audit()`）。
///
/// 这里曾经是从插件目录**反推**出来的：`record.dir.parent().parent().join("audit")`，
/// 注释写着"插件目录是 `<data>/plugins/<id>`，审计目录是 `<data>/audit`"。
/// 那个假设对**用户插件**成立，对**内置插件**不成立 —— 内置插件的目录是
/// `<仓库>/plugins/builtin/<id>`，于是审计被写到 `<仓库>/plugins/audit/`：
///
/// * 位置不对（不在应用数据目录里，用户与「设置 → 审计」看到的是两个地方）；
/// * **污染工作树**（`git status` 里冒出一个 `plugins/audit/`）；
/// * 审计链**裂成两半**：L2/L3 走 `PluginRunner` 注入的 AuditLog（位置正确），
///   L1 走这个反推（位置错误）。事后取证时"同一个事件在哪个文件里"取决于运行时。
///
/// 真机跑 `video-to-gif` 触发路径逃逸拦截时，`plugins/audit/` 就是这么冒出来的。
pub async fn run_pipeline(
    record: &PluginRecord,
    req: &PipelineRunRequest,
    engines: Arc<EngineRegistry>,
    audit: &crate::audit::AuditLog,
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
        .with_workspace(&req.workspace_root)
        // 中间产物落在**输出**目录里，而下游步骤是用 `src` 端口（Input 作用域）去读它的。
        // 不把输出目录登记成只读根，多步流水线就会在第二步报"路径逃逸被拦截" ——
        // 内置 `video-to-gif` 实测到的就是这个（见 `PathResolver::with_read_root`）。
        .with_read_root(&req.output_root);

    // 申请了 fs 能力才能碰对应作用域；没申请就直接拒绝，而不是跑到一半才失败
    if pipeline_uses_fs(pipeline, "src")
        && !effective
            .capabilities
            .iter()
            .any(|c| matches!(c, toolforge_core::permission::Capability::FsRead { .. }))
    {
        crate::audit::record_violation(
            audit,
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
        vision: req.vision.clone(),
        resolver,
        guard,
        params,
        vars: HashMap::new(),
        // 每次调用 `nodes::run` 前会被覆写成该步骤的 `with` 块，
        // 这里给个空的就行（见 NodeCtx::arg_scope 的文档）。
        arg_scope: BTreeMap::new(),
        batch_index: req.batch_index.max(1),
        batch_total: req.batch_total.max(1),
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

    // `${src}` / `${dst}` 是简写别名。
    //
    // ⚠️ **必须按清单里声明的端口顺序取**，不能直接 `req.outputs.values().next()` ——
    // 那是个 `HashMap`，迭代顺序不确定。多输出端口的插件会随机把文件写到
    // 某一个端口的目标路径上，表现为"偶尔输出到错误的文件名"，极难复现。
    let first_output = first_output_path(
        record.manifest.io.outputs.iter().map(|p| p.id.as_str()),
        &req.outputs,
    );
    let first_input = first_input_path(
        record.manifest.io.inputs.iter().map(|p| p.id.as_str()),
        &req.inputs,
    );
    if let Some(v) = first_input {
        tctx.insert("src", v);
    }
    if let Some(v) = first_output {
        tctx.insert("dst", v);
    }

    // ---- 批次数 ----
    // "给每个文件编个号"是最常见的重命名需求，而流水线本身看不到"我跑了几次"。
    tctx.insert("batch.index", req.batch_index.max(1).to_string());
    tctx.insert(
        "batch.zeroIndex",
        req.batch_index.saturating_sub(1).to_string(),
    );
    tctx.insert("batch.total", req.batch_total.max(1).to_string());

    // ---- 输入文件的路径信息 ----
    // `${src.stem}` / `${src.ext}` 让"基于原文件名构造新文件名"可以纯声明式地写出来 ——
    // 这正是 `batch-rename` 之前做不到的事（它只能把文件原样挪个位置）。
    if let Some(src) = tctx.get("src").map(|s| s.to_string()) {
        let p = std::path::Path::new(&src);
        let stem = p
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let ext = p
            .extension()
            .map(|s| format!(".{}", s.to_string_lossy()))
            .unwrap_or_default();
        let name = p
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let dir = p
            .parent()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        tctx.insert("src.stem", stem);
        tctx.insert("src.ext", ext);
        tctx.insert("src.name", name);
        tctx.insert("src.dir", dir);
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
            let value = render_template(v, &tctx)
                .map_err(|e| e.with_subject(format!("步骤 `{}` 的参数 `{k}`", step.id)))?;
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
                // `flow.set-var` 写的变量以 `${vars.<名称>}` 暴露给后续步骤。
                // 节点目录里 `flow.set-var` 的描述承诺了这一点，但执行器此前
                // 只桥接了 `steps.*` —— 于是那份承诺是假的（文档已修正为事实）。
                for (k, v) in &ctx.vars {
                    tctx.insert(format!("vars.{k}"), v.clone());
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

                // **安全事件必须先落审计，再决定怎么处理。**
                //
                // 两类都要记，而且它们的排查含义不同：
                //   * `PluginCapabilityViolation` —— 能力裁决拦下的（用了没声明的能力），
                //     来自 `nodes.rs::resolve_path` 的第一层；
                //   * `PermissionDenied` —— 路径收敛拦下的（试图走出授权根），
                //     来自第二层 `PathResolver`。
                //
                // ⚠️ 第二类曾经**完全没被记录**：审计钩子只认第一类，于是
                // "插件试图读 C:\Windows\System32\drivers\etc\hosts" 这种最典型的
                // 沙箱试探在日志里查无此事 —— 任务失败了，但没人知道为什么失败，
                // 也没人知道有人在试。这是真机测试暴露的。
                //
                // 放在策略判断**之前**是刻意的：本步骤若配了 `onError: skip`，
                // 越权记录绝不能跟着消失 —— 那正是攻击者最希望发生的事。
                match err.code {
                    ErrorCode::PluginCapabilityViolation => crate::audit::record_violation(
                        audit,
                        record.id(),
                        &format!("步骤 `{}`：{}", step.id, err.message),
                    ),
                    ErrorCode::PermissionDenied => {
                        audit.record(
                            crate::audit::AuditEvent::new(
                                crate::audit::AuditEventKind::PathEscapeBlocked,
                                format!("步骤 `{}` 试图访问授权范围之外的路径，已拦截", step.id),
                            )
                            .subject(record.id())
                            .detail(serde_json::json!({
                                "step": step.id,
                                "node": step.uses,
                                "message": err.message,
                                "detail": err.detail,
                            })),
                        );
                    }
                    _ => {}
                }

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
///
/// ⚠️ **已废弃，不要再调用**。它按"插件目录是 `<data>/plugins/<id>`"反推审计目录，
/// 而内置插件的目录是 `<仓库>/plugins/builtin/<id>` —— 于是审计被写到
/// `<仓库>/plugins/audit/`，污染工作树，并且让 L1 与 L2/L3 的审计落在两个地方。
/// `run_pipeline` 现在接一个 `audit: &AuditLog` 参数（应用那一个）。
/// 留着不删是为了让"曾经这么错过"这件事留在代码里可查。
#[allow(dead_code)]
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

/// 输入端口：按**清单声明的顺序**取第一个非空文件路径。
///
/// 清单没声明端口、或端口名对不上时，退化为按键排序 —— 至少结果是确定的，
/// 而不是随 `HashMap` 的随机种子变化。
fn first_input_path<'a>(
    declared_ids: impl Iterator<Item = &'a str>,
    inputs: &HashMap<String, Vec<String>>,
) -> Option<String> {
    for id in declared_ids {
        if let Some(first) = inputs.get(id).and_then(|v| v.first()) {
            return Some(first.clone());
        }
    }
    let mut keys: Vec<&String> = inputs.keys().collect();
    keys.sort();
    keys.into_iter()
        .find_map(|k| inputs.get(k).and_then(|v| v.first()).cloned())
}

/// 输出端口：同上，用于 `${dst}` 别名。
fn first_output_path<'a>(
    declared_ids: impl Iterator<Item = &'a str>,
    outputs: &HashMap<String, String>,
) -> Option<String> {
    for id in declared_ids {
        if let Some(v) = outputs.get(id) {
            return Some(v.clone());
        }
    }
    let mut keys: Vec<&String> = outputs.keys().collect();
    keys.sort();
    keys.first().and_then(|k| outputs.get(*k)).cloned()
}

/// 参数 → 字符串。复用 `toolforge-engines` 的实现，避免两处逻辑漂移
/// （曾经这里和 `nodes.rs` 各有一份，改动时很容易只改一边）。
fn param_to_string(v: &ParamValue) -> String {
    toolforge_engines::nodes::param_to_string(v)
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

    // ========================================================================
    // `${src}` / `${dst}` 别名的确定性
    //
    // 回归：原来直接用 `req.outputs.values().next()`，那是 `HashMap` ——
    // 迭代顺序不确定。多输出端口的插件会**随机**把文件写到某个端口的目标路径上。
    // ========================================================================

    #[test]
    fn output_alias_follows_manifest_port_order() {
        let mut outputs = HashMap::new();
        // 故意让 HashMap 的键序（通常按哈希）与清单声明序相反
        outputs.insert("zzz".to_string(), "/out/zzz.png".to_string());
        outputs.insert("aaa".to_string(), "/out/aaa.png".to_string());

        // 清单把 zzz 声明在前 → `${dst}` 必须取 zzz，与 HashMap 顺序无关
        let got = first_output_path(["zzz", "aaa"].into_iter(), &outputs);
        assert_eq!(got.as_deref(), Some("/out/zzz.png"));

        // 反过来声明 → 取 aaa
        let got = first_output_path(["aaa", "zzz"].into_iter(), &outputs);
        assert_eq!(got.as_deref(), Some("/out/aaa.png"));
    }

    #[test]
    fn output_alias_is_deterministic_even_without_manifest_ports() {
        let mut outputs = HashMap::new();
        outputs.insert("zzz".to_string(), "/out/zzz.png".to_string());
        outputs.insert("aaa".to_string(), "/out/aaa.png".to_string());
        // 清单没声明任何端口 → 退化为按键排序，至少每次结果一样
        for _ in 0..32 {
            assert_eq!(
                first_output_path(std::iter::empty(), &outputs).as_deref(),
                Some("/out/aaa.png")
            );
        }
    }

    #[test]
    fn input_alias_uses_declared_port_order_and_skips_empty_ports() {
        let mut inputs = HashMap::new();
        inputs.insert("mask".to_string(), vec![]); // 声明在前但为空
        inputs.insert("src".to_string(), vec!["/in/a.png".to_string()]);

        let got = first_input_path(["mask", "src"].into_iter(), &inputs);
        assert_eq!(
            got.as_deref(),
            Some("/in/a.png"),
            // 注意 `${{...}}` 的双大括号：assert_eq! 的提示文本会被当成 format! 字符串，
            // 里面单个 `{src}` 会被解析成"隐式捕获变量 src"并报 E0425。
            "空端口必须被跳过，否则 ${{src}} 会解析成空串"
        );
    }

    #[test]
    fn aliases_are_absent_when_there_are_no_ports() {
        let empty: HashMap<String, Vec<String>> = HashMap::new();
        assert!(first_input_path(std::iter::empty(), &empty).is_none());
        let empty2: HashMap<String, String> = HashMap::new();
        assert!(first_output_path(std::iter::empty(), &empty2).is_none());
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
