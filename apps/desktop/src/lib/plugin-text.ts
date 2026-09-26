/**
 * 清单文本的轻量嗅探。
 *
 * ## 为什么需要它
 *
 * `plugins_validate` 的返回里**没有**运行时类型（只有 `capabilities` /
 * `requiredEngines` / `missingEngines`），但安装 L3 Python 插件时前端必须知道
 * "这是可执行代码"，才能把 `executableCodeAcknowledged` 这个开关交给用户勾。
 *
 * 所以这里在**文本层面**做一次极轻量的判断。它不解析 YAML（不引解析器，
 * 也不该抢后端的活），只用于决定"要不要多问用户一句"：
 *
 * - 判断不出来时**一律按需要确认处理**（fail-closed）：多问一句没坏处，
 *   少问一句可能就放过了可执行代码。
 */

import type { RuntimeKind } from "@/types/domain";

/**
 * 从清单文本里嗅探 `runtime.kind`，判断失败返回 `null`。
 *
 * 匹配形态（YAML 两种常见写法）：
 * ```yaml
 * runtime:
 *   kind: python
 * ```
 * ```yaml
 * runtime: { kind: python }
 * ```
 */
export function sniffRuntimeKind(yamlText: string): RuntimeKind | null {
  if (!yamlText) return null;

  // 块式写法：runtime: 之后、下一个顶层键之前，找 kind
  const block = /(^|\n)runtime:\s*\n([\s\S]*?)(?=\n\S|\n*$)/.exec(yamlText);
  if (block) {
    const kind = /\bkind:\s*["']?(pipeline|wasm|python)["']?/i.exec(block[2] ?? "");
    if (kind) return normalize(kind[1]);
  }

  // 行内写法：runtime: { kind: python }
  const inline = /runtime:\s*\{[^}]*\bkind:\s*["']?(pipeline|wasm|python)["']?/i.exec(yamlText);
  if (inline) return normalize(inline[1]);

  // 兜底：整份文本里唯一出现 runtime kind 的情况（模型有时会少缩进）
  const loose = /\bkind:\s*["']?(pipeline|wasm|python)["']?\s*$/im.exec(yamlText);
  if (loose) return normalize(loose[1]);

  return null;
}

function normalize(raw: string | undefined): RuntimeKind | null {
  const v = (raw ?? "").toLowerCase();
  if (v === "pipeline" || v === "wasm" || v === "python") return v;
  return null;
}

/**
 * 需要用户确认"这是可执行代码"吗？
 *
 * `runtimeKind === null`（判断不出来）时返回 `true` —— 见模块注释的 fail-closed 原则。
 */
export function requiresCodeAcknowledgement(runtimeKind: RuntimeKind | null): boolean {
  return runtimeKind !== "pipeline" && runtimeKind !== "wasm";
}

export function runtimeKindLabelOf(kind: RuntimeKind | null): string {
  switch (kind) {
    case "pipeline":
      return "L1 声明式编排（数据，不是代码）";
    case "wasm":
      return "L2 WASM 沙箱（无文件系统、无网络）";
    case "python":
      return "L3 Python 进程（可执行代码）";
    default:
      return "无法从前端判断运行时类型";
  }
}

/** 从抽取出的草稿文件里找清单文本 */
export function findManifestText(files: { path: string; content: string }[]): string | null {
  const manifest = files.find((f) => f.path === "plugin.yaml" || f.path.endsWith("/plugin.yaml"));
  return manifest?.content ?? null;
}
