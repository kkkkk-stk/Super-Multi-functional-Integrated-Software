/**
 * 画布 → 插件清单（`plugin.yaml`）。
 *
 * ## 为什么是"导出成插件"而不是"直接跑"
 *
 * 后端**没有**"运行一条任意流水线"的命令 —— 唯一的执行入口是
 * `plugins_run`（跑一个已安装的插件）。所以流程编辑器的产物必须落成插件清单：
 *
 * ```text
 * 画布 → plugin.yaml → plugins_validate（先校验）→ plugins_install（走权限门）
 * ```
 *
 * 好处是这条路径上所有的安全机制（清单校验、逐条授权、内容哈希、审计）都自动适用，
 * 不需要为"编辑器"再开一条特权通道。
 *
 * ## 与内置节点执行器的约定（必须对齐，否则跑不通）
 *
 * 见 `plugins/builtin/image-convert/plugin.yaml` 的注释与
 * `crates/toolforge-engines/src/nodes.rs`：
 *
 * 1. `with` 里只放**结构性的路径绑定**：`src` / `dst` / `path` 之类；
 *    节点的可调参数由执行器从插件自己的 `io.params` 里按**同名 id** 读取，
 *    写进 `with` 反而无效 —— 所以参数统一进 `io.params`（按 id 去重）。
 * 2. `${src}` = 本次任务的第一个输入文件；`${output.<端口id>}` = 宿主分配的输出路径；
 *    `${steps.<步骤id>.<键>}` = 前序步骤产出的值。
 * 3. 步骤顺序由数组顺序决定，`dependsOn` 表示画布上的连线（DAG 校验由后端再做一遍）。
 *
 * ## 输出格式
 *
 * 字符串标量统一用 **JSON 形式的双引号**（JSON 字符串是合法的 YAML 双引号标量），
 * 这样不需要自己实现 YAML 转义 —— `${...}` 模板、中文、引号、冒号全都安全。
 */

import type { FlowEdge, FlowNode, CanvasMeta } from "@/stores/canvas-store";
import { isNodeImplemented } from "@/lib/node-support";
import type { NodeCategory, ParamSpec, ParamValue, PluginCategory } from "@/types/domain";

export interface BuildResult {
  yaml: string;
  /** 阻断性问题：存在时不应该继续去安装 */
  errors: string[];
  /** 提示性问题：可以安装，但用户应该知道 */
  warnings: string[];
}

/** 节点分类 → 插件分类（插件分类比节点分类少，这里做保守映射） */
function pluginCategoryOf(category: NodeCategory | undefined): PluginCategory {
  switch (category) {
    case "image":
      return "image";
    case "video":
      return "video";
    case "audio":
      return "audio";
    case "document":
      return "document";
    case "archive":
      return "archive";
    case "ebook":
      return "ebook";
    case "text":
      return "text";
    case "ai":
      return "ai";
    default:
      return "other";
  }
}

/** 文件类端口（需要绑定路径的） */
function isFileish(portType: string): boolean {
  return portType === "file" || portType === "files" || portType === "directory";
}

export function buildPluginYaml(
  meta: CanvasMeta,
  nodes: FlowNode[],
  edges: FlowEdge[],
): BuildResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (nodes.length === 0) {
    errors.push("画布是空的：至少放一个节点。");
    return { yaml: "", errors, warnings };
  }

  // 未实现的节点：明确告知（执行器会直接返回"未实现"错误）
  const unimplemented = [...new Set(nodes.map((n) => n.data.descriptorName))].filter(
    (name) => !isNodeImplemented(name),
  );
  if (unimplemented.length > 0) {
    warnings.push(
      `这些节点在 v0.1 的执行器里还没实现，任务会以「未实现」失败：${unimplemented.join("、")}`,
    );
  }

  // 缺引擎的节点
  const missingEngines = nodes.filter((n) => !n.data.available);
  if (missingEngines.length > 0) {
    warnings.push(
      `这些节点所需的引擎尚未安装，安装插件后仍会因缺引擎而失败：${missingEngines
        .map((n) => `${n.data.label}（缺 ${n.data.missingEngines.join("/") || "未知引擎"}）`)
        .join("、")}`,
    );
  }

  // ---------------------------------------------------------------- 参数（按 id 去重）
  const params = new Map<string, ParamSpec>();
  const conflicts: string[] = [];
  for (const node of nodes) {
    for (const spec of node.data.params ?? []) {
      const existing = params.get(spec.id);
      if (!existing) {
        params.set(spec.id, spec);
        continue;
      }
      // 同名参数：内置节点的执行器按 id 读参数，所以只能保留一份
      const sameDefault =
        JSON.stringify(existing.default ?? null) === JSON.stringify(spec.default ?? null);
      if (!sameDefault) {
        conflicts.push(
          `参数 \`${spec.id}\` 同时出现在「${existing.label}」与「${node.data.label}」且默认值不同`,
        );
      }
    }
  }
  if (conflicts.length > 0) {
    warnings.push(
      `以下参数按 id 去重（宿主只按 id 读取参数，同名只能保留一份）：${conflicts.join("；")}`,
    );
  }

  // 参数值取自画布上设置的 paramValues（按 id 找第一个设置过的节点）
  const paramValues: Record<string, ParamValue> = {};
  for (const node of nodes) {
    const values = node.data.paramValues ?? {};
    for (const [id, value] of Object.entries(values)) {
      if (params.has(id) && paramValues[id] === undefined) paramValues[id] = value;
    }
  }

  // ---------------------------------------------------------------- 步骤与端口绑定
  // 记录"哪些出口已经被连线消费"，只有**完全没被消费**的输出端口才当作流水线产出
  const consumedOutputs = new Set(edges.map((e) => `${e.source}:${e.sourceHandle ?? "out"}`));
  const terminalOutputs = new Map<string, { label: string; type: string }>();

  interface StepOut {
    id: string;
    uses: string;
    label: string;
    with: Record<string, string>;
    dependsOn: string[];
    position: { x: number; y: number };
  }

  const steps: StepOut[] = nodes.map((node) => {
    const withBindings: Record<string, string> = {};
    const dependsOn: string[] = [];

    // 基于连线推导顺序与取值
    for (const edge of edges) {
      if (edge.target !== node.id) continue;
      const source = nodes.find((n) => n.id === edge.source);
      if (!source) continue;
      if (!dependsOn.includes(source.id)) dependsOn.push(source.id);
      const sourcePort = edge.sourceHandle ?? "out";
      const targetPort = edge.targetHandle ?? node.data.inputs[0]?.id ?? "src";
      withBindings[targetPort] = `\${steps.${source.id}.${sourcePort}}`;
    }

    // 未连接的输入端口：文件类绑到 ${src}（第一个输入文件）
    for (const port of node.data.inputs) {
      if (withBindings[port.id]) continue;
      if (isFileish(port.type)) {
        withBindings[port.id] = "${src}";
      }
    }

    // 未被连线消费的输出端口：视为流水线产出，绑到 ${output.<端口id>}
    for (const port of node.data.outputs) {
      if (consumedOutputs.has(`${node.id}:${port.id}`)) continue;
      withBindings[port.id] = `\${output.${port.id}}`;
      if (!terminalOutputs.has(port.id)) {
        terminalOutputs.set(port.id, { label: port.label, type: port.type });
      }
    }

    return {
      id: node.id,
      uses: node.data.descriptorName,
      label: node.data.label,
      with: withBindings,
      dependsOn,
      position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
    };
  });

  // 环检测（后端的 validate 也会做，这里提前给出人话提示）
  if (detectCycle(nodes.map((n) => n.id), edges)) {
    errors.push("画布里存在环路：流水线必须是 DAG（步骤只能引用前面的产出）。");
  }

  if (terminalOutputs.size === 0) {
    warnings.push(
      "没有任何「末端」节点：所有输出端口都连到了下游，流水线可能不产出文件。",
    );
  }

  // ---------------------------------------------------------------- 生成 YAML
  const w = new YamlWriter();
  w.line("apiVersion: \"toolforge/v1\"");
  w.line("kind: \"Plugin\"");
  w.line("metadata:");
  w.indent(() => {
    w.line(`id: ${quote(meta.pluginId)}`);
    w.line(`name: ${quote(meta.name)}`);
    w.line(`version: "1.0.0"`);
    w.line(`description: ${quote(meta.description)}`);
    w.line(`category: ${dominantCategory(nodes)}`);
  });

  // 权限：画布只能表达"读输入 / 写输出"这两件事（内置节点都由宿主执行）。
  //
  // 形状必须是 `permissions: { capabilities: [...] }` —— `PermissionSet` 是带
  // `capabilities` 字段的结构体（`permission.rs` 刻意没有加 `serde(transparent)`）。
  // 写成裸数组 `permissions: [ ... ]` 会被后端拒绝：
  // `invalid type: sequence, expected struct PermissionSet`。
  w.line("permissions:");
  w.indent(() => {
    w.line("capabilities:");
    w.indent(() => {
      w.line("- kind: fsRead");
      w.indent(() => w.line("scope: { kind: input }"));
      w.line("- kind: fsWrite");
      w.indent(() => w.line("scope: { kind: output }"));
    });
  });

  // io
  w.line("io:");
  w.indent(() => {
    w.line("inputs:");
    w.indent(() => {
      w.line(`- id: "src"`);
      w.indent(() => {
        w.line(`label: "输入文件"`);
        w.line(`type: file`);
        w.line(`accept: []`);
        w.line(`multiple: true`);
        w.line(`required: true`);
        w.line(`description: "本次任务处理的文件；批量任务会按并发度逐个执行这条流水线。"`);
      });
    });

    w.line("outputs:");
    w.indent(() => {
      if (terminalOutputs.size === 0) {
        w.line("- id: \"dst\"");
        w.indent(() => {
          w.line(`label: "输出文件"`);
          w.line(`type: file`);
          w.line(`required: false`);
        });
      } else {
        for (const [id, info] of terminalOutputs) {
          w.line(`- id: ${quote(id)}`);
          w.indent(() => {
            w.line(`label: ${quote(info.label)}`);
            w.line(`type: ${info.type}`);
            w.line(`required: false`);
          });
        }
      }
    });

    w.line("params:");
    w.indent(() => {
      if (params.size === 0) {
        // YAML 里空序列写成 []，避免解析出 null
        w.replaceLast("params:", "params: []");
        return;
      }
      for (const spec of params.values()) {
        writeParamSpec(w, spec, paramValues[spec.id]);
      }
    });
  });

  // runtime
  w.line("runtime:");
  w.indent(() => {
    w.line("kind: pipeline");
    w.line("pipeline:");
    w.indent(() => {
      w.line(`description: ${quote(meta.description)}`);
      w.line(`onError: ${meta.onError}`);
      w.line(`timeoutMs: ${meta.timeoutMs}`);
      w.line("steps:");
      w.indent(() => {
        for (const step of steps) {
          w.line(`- id: ${quote(step.id)}`);
          w.indent(() => {
            w.line(`uses: ${quote(step.uses)}`);
            w.line(`label: ${quote(step.label)}`);
            if (Object.keys(step.with).length > 0) {
              w.line("with:");
              w.indent(() => {
                for (const [key, value] of Object.entries(step.with)) {
                  w.line(`${key}: ${quote(value)}`);
                }
              });
            } else {
              w.line("with: {}");
            }
            if (step.dependsOn.length > 0) {
              w.line(`dependsOn: [${step.dependsOn.map(quote).join(", ")}]`);
            }
            w.line(`position: { x: ${step.position.x}, y: ${step.position.y} }`);
          });
        }
      });
    });
  });

  return { yaml: w.toString(), errors, warnings };
}

// ============================================================================
// 小工具
// ============================================================================

/** JSON 字符串就是合法的 YAML 双引号标量 —— 用它省掉一整套转义逻辑 */
function quote(value: string): string {
  return JSON.stringify(value);
}

function dominantCategory(nodes: FlowNode[]): PluginCategory {
  const counts = new Map<PluginCategory, number>();
  for (const node of nodes) {
    const cat = pluginCategoryOf(node.data.category);
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  let best: PluginCategory = "other";
  let bestCount = -1;
  for (const [cat, count] of counts) {
    if (count > bestCount) {
      best = cat;
      bestCount = count;
    }
  }
  return best;
}

function detectCycle(nodeIds: string[], edges: FlowEdge[]): boolean {
  const adjacency = new Map<string, string[]>();
  for (const id of nodeIds) adjacency.set(id, []);
  for (const edge of edges) {
    adjacency.get(edge.source)?.push(edge.target);
  }
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string): boolean => {
    const s = state.get(id) ?? 0;
    if (s === 1) return true; // 回到自身 → 有环
    if (s === 2) return false;
    state.set(id, 1);
    for (const next of adjacency.get(id) ?? []) {
      if (visit(next)) return true;
    }
    state.set(id, 2);
    return false;
  };
  return nodeIds.some((id) => visit(id));
}

function writeParamSpec(w: YamlSeqWriter, spec: ParamSpec, value: ParamValue | undefined): void {
  w.line(`- id: ${quote(spec.id)}`);
  w.indent(() => {
    w.line(`label: ${quote(spec.label)}`);
    w.line(`type: ${spec.type}`);
    if (spec.description) w.line(`description: ${quote(spec.description)}`);
    const effective = value ?? spec.default;
    if (effective) w.line(`default: ${paramValueFlow(effective)}`);
    if (spec.options.length > 0) {
      w.line("options:");
      w.indent(() => {
        for (const option of spec.options) {
          w.line(`- { value: ${quote(option.value)}, label: ${quote(option.label)} }`);
        }
      });
    }
    if (spec.min !== undefined) w.line(`min: ${spec.min}`);
    if (spec.max !== undefined) w.line(`max: ${spec.max}`);
    if (spec.step !== undefined) w.line(`step: ${spec.step}`);
    w.line(`required: ${spec.required ? "true" : "false"}`);
    if (spec.placeholder) w.line(`placeholder: ${quote(spec.placeholder)}`);
    if (spec.multiline) w.line(`multiline: true`);
    if (spec.affectsOutput) w.line(`affectsOutput: true`);
  });
}

/** ParamValue → YAML 流式映射（`{ kind: str, value: "webp" }`） */
function paramValueFlow(value: ParamValue): string {
  switch (value.kind) {
    case "str":
      return `{ kind: str, value: ${quote(value.value)} }`;
    case "int":
      return `{ kind: int, value: ${Math.round(value.value)} }`;
    case "float":
      // `ParamValue` 的 float 变体在生成类型里是 `number | null`，YAML 里不能写 null
      return `{ kind: float, value: ${value.value ?? 0} }`;
    case "bool":
      return `{ kind: bool, value: ${value.value ? "true" : "false"} }`;
    case "list":
      return `{ kind: list, value: [${value.value.map(quote).join(", ")}] }`;
    default:
      return `{ kind: str, value: "" }`;
  }
}

/**
 * 极简 YAML 写入器。
 *
 * 只支持三件事：写一行、增减缩进、替换上一行。生成清单这个场景够用，
 * 而且比引一个 YAML 库更可控（不会有意外的锚点/折叠标量）。
 */
class YamlWriter {
  private lines: string[] = [];
  private depth = 0;

  line(text: string): void {
    this.lines.push(`${"  ".repeat(this.depth)}${text}`);
  }

  indent(fn: () => void): void {
    this.depth += 1;
    try {
      fn();
    } finally {
      this.depth -= 1;
    }
  }

  /** 把最后一行整体替换掉（用于 `params:` → `params: []` 这种收尾修正） */
  replaceLast(from: string, to: string): void {
    const last = this.lines[this.lines.length - 1];
    if (last && last.trim() === from) {
      this.lines[this.lines.length - 1] = `${"  ".repeat(this.depth)}${to}`;
    }
  }

  toString(): string {
    return `${this.lines.join("\n")}\n`;
  }
}

/** 参数序列的缩进上下文（`- id:` 之后的内容要多缩两格） */
interface YamlSeqWriter {
  line(text: string): void;
  indent(fn: () => void): void;
}

/** 建议的插件 id（小写 + 点号，符合后端的 `is_valid_plugin_id`） */
export function suggestPluginId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return `com.user.${slug || "pipeline"}`;
}

export function isValidPluginId(id: string): boolean {
  return /^[a-z0-9._-]{3,128}$/.test(id);
}
