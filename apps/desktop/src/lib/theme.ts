/**
 * 主题（深色 / 浅色 / 跟随系统）与强调色。
 *
 * ## 为什么主题状态在 Zustand 而不是 TanStack Query
 *
 * Rust 的 `Settings` 确实是主题与强调色的**权威来源**（Query 独占），但：
 * 1. 首屏渲染必须立刻套用主题，等 IPC 往返会闪一下白/黑；
 * 2. 切换主题时 UI 要立刻响应，不能等 mutation 往返。
 *
 * 所以 `ui-store` 里存的是**"当前已套用到 DOM 的那一份"**（瞬时光标），
 * 由 `use-settings.ts` 在拿到 Query 数据后**单向**同步过去：
 *
 * ```text
 * Rust settings ──(Query)──► use-settings ──(apply)──► ui-store + document
 *      ▲                                                    │
 *      └──────────── settings_patch（用户操作）───────────────┘
 * ```
 *
 * 反向只有一条路径（用户点切换 → mutation → 后端确认），因此不存在"两处各存一份
 * 且互相打架"的情况。
 */

import type { AccentName, ThemeMode } from "@/types/domain";

/** 与 `ui-store.ts` 的 zustand persist 键名保持一致（首屏读取要用它） */
export const UI_PERSIST_KEY = "toolforge-ui";

export interface AccentOption {
  name: AccentName;
  label: string;
  /** 只用于设置页的小色块，值是 CSS 颜色字面量 */
  swatch: string;
  description: string;
}

export const ACCENTS: AccentOption[] = [
  {
    name: "cyan",
    label: "青蓝",
    swatch: "hsl(189 94% 43%)",
    description: "默认。冷静、中性，长时间看任务列表不累。",
  },
  {
    name: "violet",
    label: "紫罗兰",
    swatch: "hsl(263 85% 63%)",
    description: "偏创意与 AI 场景。",
  },
  {
    name: "emerald",
    label: "翡翠绿",
    swatch: "hsl(160 84% 39%)",
    description: "成功感强，适合以批量任务为主的用法。",
  },
  {
    name: "amber",
    label: "琥珀橙",
    swatch: "hsl(38 92% 50%)",
    description: "温暖醒目。注意：与「警告」语义色接近，风险面板会略难分辨。",
  },
  {
    name: "rose",
    label: "玫瑰红",
    swatch: "hsl(347 77% 55%)",
    description: "强对比。同样与「危险」语义色接近。",
  },
];

export const THEME_MODES: { mode: ThemeMode; label: string }[] = [
  { mode: "system", label: "跟随系统" },
  { mode: "light", label: "浅色" },
  { mode: "dark", label: "深色" },
];

export function isAccentName(v: string): v is AccentName {
  return ACCENTS.some((a) => a.name === v);
}

export function isThemeMode(v: string): v is ThemeMode {
  return v === "system" || v === "light" || v === "dark";
}

export function normalizeAccent(v: string | undefined): AccentName {
  return v && isAccentName(v) ? v : "cyan";
}

export function normalizeTheme(v: string | undefined): ThemeMode {
  return v && isThemeMode(v) ? v : "system";
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** 系统当前是否为深色 */
export function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return true;
  return window.matchMedia(DARK_QUERY).matches;
}

/** `system` 解析成实际生效的一档 */
export function resolveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") return systemPrefersDark() ? "dark" : "light";
  return mode;
}

/**
 * 把主题套到 `<html>` 上。
 *
 * 只做一件事：`classList.toggle("dark")`。所有颜色都在 CSS 变量里，
 * 因此这里不需要碰任何具体样式。
 */
export function applyTheme(mode: ThemeMode): "light" | "dark" {
  const resolved = resolveTheme(mode);
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
  return resolved;
}

/** 切换强调色：只改 `<html data-accent>`，配合 index.css 的过渡即可平滑换色 */
export function applyAccent(accent: AccentName): void {
  document.documentElement.dataset.accent = accent;
}

/**
 * 订阅系统主题变化。
 * 返回取消订阅函数（`system` 模式下才需要，调用方自己判断）。
 */
export function watchSystemTheme(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => undefined;
  const mql = window.matchMedia(DARK_QUERY);
  const handler = () => onChange();
  mql.addEventListener("change", handler);
  return () => mql.removeEventListener("change", handler);
}

interface PersistedUiSlice {
  theme?: string;
  accent?: string;
  ambientEffects?: boolean;
}

/**
 * 在 React 挂载**之前**同步读取本地持久化的主题并套用，避免首屏闪烁。
 *
 * 读的是 zustand persist 写进 localStorage 的结构
 * （`{ state: {...}, version: n }`），解析失败就静默回退到默认值 ——
 * 这里绝不能抛异常，否则整个应用白屏。
 */
export function applyPersistedTheme(): { theme: ThemeMode; accent: AccentName } {
  let theme: ThemeMode = "system";
  let accent: AccentName = "cyan";
  try {
    const raw = localStorage.getItem(UI_PERSIST_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { state?: PersistedUiSlice };
      const s = parsed.state ?? {};
      theme = normalizeTheme(s.theme);
      accent = normalizeAccent(s.accent);
    }
  } catch {
    // 忽略：本地状态损坏不该影响启动
  }
  applyTheme(theme);
  applyAccent(accent);
  return { theme, accent };
}

/** 风险等级 → Tailwind 语义色类（插件卡片、审核报告、权限面板共用） */
export const RISK_STYLES: Record<
  "low" | "medium" | "high" | "critical",
  { text: string; border: string; bg: string; label: string }
> = {
  low: {
    text: "text-risk-low",
    border: "border-risk-low/40",
    bg: "bg-risk-low/10",
    label: "低风险",
  },
  medium: {
    text: "text-risk-medium",
    border: "border-risk-medium/50",
    bg: "bg-risk-medium/10",
    label: "中等风险",
  },
  high: {
    text: "text-risk-high",
    border: "border-risk-high/60",
    bg: "bg-risk-high/10",
    label: "高风险",
  },
  critical: {
    text: "text-risk-critical",
    border: "border-risk-critical/70",
    bg: "bg-risk-critical/15",
    label: "极高风险",
  },
};
