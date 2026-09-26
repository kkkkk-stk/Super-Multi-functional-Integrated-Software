import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * shadcn/ui 的标准类名合并器。
 *
 * `twMerge` 必须用 **2.x**：3.x 是按 Tailwind 4 的类名体系写的，
 * 用在 Tailwind 3 上会漏合并（例如 `h-4 h-5` 不会被裁掉）。
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 数组去重后拼接（用于 class 里累加多个条件类） */
export function joinClasses(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** 稳定的对象键排序 JSON —— 用于把对象塞进依赖数组时避免引用变化 */
export function stableKey(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableKey(v)}`).join(",")}}`;
}

/** 生成一个足够唯一的本地 id（画布节点 / 临时 key 用） */
export function localId(prefix = "n"): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}
