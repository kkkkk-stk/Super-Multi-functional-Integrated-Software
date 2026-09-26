/**
 * 参数（ParamSpec / ParamValue）的表单绑定工具。
 *
 * 表单的内部状态**直接就是 `ParamValue`**（可判别联合），而不是 `Record<string, any>`：
 * 这样提交给 `plugins_run` 时零转换、零 `any`，类型不匹配在编译期就能发现。
 */

import type { ParamSpec, ParamType, ParamValue } from "@/types/domain";

export function isNumericType(t: ParamType): boolean {
  return t === "int" || t === "float";
}

/** 需要宿主弹原生对话框的参数类型 */
export function isPathLikeType(t: ParamType): boolean {
  return t === "path" || t === "directory";
}

/** 该类型的"空值" */
export function emptyValue(t: ParamType): ParamValue {
  switch (t) {
    case "int":
      return { kind: "int", value: 0 };
    case "float":
      return { kind: "float", value: 0 };
    case "bool":
      return { kind: "bool", value: false };
    case "multiEnum":
      return { kind: "list", value: [] };
    default:
      return { kind: "str", value: "" };
  }
}

/** 默认值：优先用清单里声明的 `default`，否则按类型给空值 */
export function defaultValueOf(spec: ParamSpec): ParamValue {
  return spec.default ?? emptyValue(spec.type);
}

export function initialParamValues(specs: ParamSpec[]): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const spec of specs) out[spec.id] = defaultValueOf(spec);
  return out;
}

/** 文本输入框里显示的内容 */
export function paramToText(v: ParamValue | undefined): string {
  if (!v) return "";
  switch (v.kind) {
    case "str":
      return v.value;
    case "int":
      return String(v.value);
    case "float":
      // float 的 value 在生成类型里是 `number | null`
      return v.value === null ? "" : String(v.value);
    case "bool":
      return v.value ? "true" : "false";
    case "list":
      return v.value.join(", ");
    default:
      return "";
  }
}

/**
 * 把输入框里的字符串收敛回 `ParamValue`。
 *
 * 数字输入过程中允许出现空串 / 半截数字（"-"、"1."），此时退回一个占位值，
 * 由 `validateParam` 在提交时给出错误提示 —— 不要在每次按键时就报错。
 */
export function coerceTextInput(spec: ParamSpec, text: string): ParamValue {
  switch (spec.type) {
    case "int": {
      const n = Number.parseInt(text, 10);
      return { kind: "int", value: Number.isFinite(n) ? n : 0 };
    }
    case "float": {
      const n = Number.parseFloat(text);
      return { kind: "float", value: Number.isFinite(n) ? n : 0 };
    }
    case "multiEnum":
      return {
        kind: "list",
        value: text
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      };
    case "keyValue":
    case "text":
    case "textarea":
    case "enum":
    case "path":
    case "directory":
    case "color":
    default:
      return { kind: "str", value: text };
  }
}

/** 多选枚举：勾选 / 取消某个候选值 */
export function toggleListValue(current: ParamValue, option: string): ParamValue {
  const list = current.kind === "list" ? current.value : [];
  const next = list.includes(option)
    ? list.filter((v) => v !== option)
    : [...list, option];
  return { kind: "list", value: next };
}

export function listValueOf(v: ParamValue | undefined): string[] {
  return v && v.kind === "list" ? v.value : [];
}

/** 单参数校验：返回中文错误信息，`null` 表示通过 */
export function validateParam(spec: ParamSpec, value: ParamValue | undefined): string | null {
  const v = value ?? defaultValueOf(spec);

  if (isNumericType(spec.type) && v.kind !== "int" && v.kind !== "float") {
    return `${spec.label} 需要是数字`;
  }

  if (spec.required) {
    if (v.kind === "str" && v.value.trim() === "") return `请填写「${spec.label}」`;
    if (v.kind === "list" && v.value.length === 0) return `请至少选择一项「${spec.label}」`;
  }

  if (spec.type === "enum" && v.kind === "str" && v.value !== "") {
    if (spec.options.length > 0 && !spec.options.some((o) => o.value === v.value)) {
      return `「${spec.label}」的取值 ${v.value} 不在候选列表里`;
    }
  }

  if (isNumericType(spec.type) && (v.kind === "int" || v.kind === "float")) {
    // `ParamValue` 的 float 变体在生成类型里是 `number | null`（Rust 侧是 Option<f64>），
    // int 是 `number`；`spec.min` / `spec.max` 也是 `number | null | undefined`。
    // 统一收敛成 number 之后再比较。
    const numeric = v.value;
    if (numeric === null || numeric === undefined || !Number.isFinite(numeric)) {
      return `「${spec.label}」需要一个数字`;
    }
    const min = spec.min ?? undefined;
    const max = spec.max ?? undefined;
    if (min !== undefined && numeric < min) {
      return `「${spec.label}」不能小于 ${min}`;
    }
    if (max !== undefined && numeric > max) {
      return `「${spec.label}」不能大于 ${max}`;
    }
  }

  return null;
}

/** 整表校验：返回 `参数 id → 错误信息`（空对象表示全部通过） */
export function validateParams(
  specs: ParamSpec[],
  values: Record<string, ParamValue>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const spec of specs) {
    const err = validateParam(spec, values[spec.id]);
    if (err) errors[spec.id] = err;
  }
  return errors;
}

/** 供 InspectorPanel 展示的"参数来源节点"标签（同名 id 去重时的提示用） */
export function paramSignature(spec: ParamSpec): string {
  return `${spec.type}:${JSON.stringify(spec.default ?? null)}`;
}
