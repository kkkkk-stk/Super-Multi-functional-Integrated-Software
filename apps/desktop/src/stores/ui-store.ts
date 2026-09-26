/**
 * 瞬时 UI 状态。
 *
 * 这里**不放任何来自 Rust 的异步数据**（见 `./README.md` 的铁律）。
 * 持久化的只有"下次启动还应该保持"的几项：主题、强调色、氛围动效开关、侧边栏折叠。
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import { applyAccent, applyTheme, UI_PERSIST_KEY } from "@/lib/theme";
import type { AccentName, ThemeMode } from "@/types/domain";

/** 引擎下载的实时进度（事件流状态，见 stores/README.md 的例外说明 1） */
export interface EngineDownloadState {
  downloaded: number;
  total: number;
  speedBps: number;
  /** 最后一次事件的时间戳，用于清理长时间不再更新的条目 */
  updatedAt: number;
}

/** AI 流式输出的中间缓冲（例外说明 2） */
export interface AiStreamState {
  requestId: string | null;
  text: string;
}

/** 最近一次安全事件（用来弹出醒目的告警对话框） */
export interface SecurityAlertState {
  severity: string;
  title: string;
  detail: string;
  subject?: string;
  at: string;
}

interface UiState {
  // ---- 布局 ----
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;

  // ---- 命令面板 ----
  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (open: boolean) => void;
  toggleCommandPalette: () => void;

  // ---- 任务抽屉 ----
  jobsDrawerOpen: boolean;
  setJobsDrawerOpen: (open: boolean) => void;
  /** 当前选中的任务 id（任务中心与抽屉共用；**不是**任务数据本身） */
  selectedJobId: string | null;
  selectJob: (id: string | null) => void;

  // ---- 主题（"已套用到 DOM 的那一份"）----
  theme: ThemeMode;
  accent: AccentName;
  ambientEffects: boolean;
  setTheme: (theme: ThemeMode) => void;
  setAccent: (accent: AccentName) => void;
  setAmbientEffects: (enabled: boolean) => void;
  /**
   * 从 Query 的 Settings 同步过来（单向：后端 → 界面）。
   *
   * 参数全是可选的，因为生成类型里 `Settings` 的每个字段都可选
   * （Rust 侧带 `#[serde(default)]`）。传 `undefined` 表示"后端这次没说"，
   * 保留当前值，不做任何猜测。
   */
  syncFromSettings: (v: {
    theme?: string;
    accent?: string;
    ambientEffects?: boolean;
  }) => void;

  // ---- 引擎下载进度（例外 1）----
  engineDownloads: Record<string, EngineDownloadState>;
  setEngineDownload: (engineId: string, state: EngineDownloadState) => void;
  clearEngineDownload: (engineId: string) => void;

  // ---- AI 流式缓冲（例外 2）----
  aiStream: AiStreamState;
  startAiStream: (requestId: string) => void;
  appendAiDelta: (requestId: string, delta: string) => void;
  endAiStream: () => void;

  // ---- 安全告警 ----
  securityAlert: SecurityAlertState | null;
  pushSecurityAlert: (alert: SecurityAlertState) => void;
  dismissSecurityAlert: () => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      sidebarCollapsed: false,
      toggleSidebar: () => set({ sidebarCollapsed: !get().sidebarCollapsed }),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),

      commandPaletteOpen: false,
      setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
      toggleCommandPalette: () => set({ commandPaletteOpen: !get().commandPaletteOpen }),

      jobsDrawerOpen: false,
      setJobsDrawerOpen: (open) => set({ jobsDrawerOpen: open }),
      selectedJobId: null,
      selectJob: (id) => set({ selectedJobId: id }),

      theme: "system",
      accent: "cyan",
      ambientEffects: true,

      setTheme: (theme) => {
        applyTheme(theme);
        set({ theme });
      },
      setAccent: (accent) => {
        applyAccent(accent);
        set({ accent });
      },
      setAmbientEffects: (ambientEffects) => set({ ambientEffects }),

      syncFromSettings: ({ theme, accent, ambientEffects }) => {
        const state = get();
        const nextTheme: ThemeMode =
          theme === "light" || theme === "dark" || theme === "system" ? theme : state.theme;
        const nextAccent: AccentName =
          accent === "cyan" ||
          accent === "violet" ||
          accent === "emerald" ||
          accent === "amber" ||
          accent === "rose"
            ? accent
            : state.accent;
        // 只在真的变化时才碰 DOM，避免每次设置刷新都触发一次全局 transition
        if (nextTheme !== state.theme) applyTheme(nextTheme);
        if (nextAccent !== state.accent) applyAccent(nextAccent);
        set({
          theme: nextTheme,
          accent: nextAccent,
          ambientEffects: ambientEffects ?? state.ambientEffects,
        });
      },

      engineDownloads: {},
      setEngineDownload: (engineId, state) =>
        set((s) => ({
          engineDownloads: { ...s.engineDownloads, [engineId]: state },
        })),
      clearEngineDownload: (engineId) =>
        set((s) => {
          if (!(engineId in s.engineDownloads)) return s;
          const next = { ...s.engineDownloads };
          delete next[engineId];
          return { engineDownloads: next };
        }),

      aiStream: { requestId: null, text: "" },
      startAiStream: (requestId) => set({ aiStream: { requestId, text: "" } }),
      appendAiDelta: (requestId, delta) =>
        set((s) => {
          // 迟到的增量（前一次请求的尾巴）直接丢弃，不要污染当前缓冲
          if (s.aiStream.requestId !== requestId) return s;
          return { aiStream: { requestId, text: s.aiStream.text + delta } };
        }),
      endAiStream: () =>
        set((s) => ({ aiStream: { requestId: null, text: s.aiStream.text } })),

      securityAlert: null,
      pushSecurityAlert: (alert) => set({ securityAlert: alert }),
      dismissSecurityAlert: () => set({ securityAlert: null }),
    }),
    {
      name: UI_PERSIST_KEY,
      storage: createJSONStorage(() => localStorage),
      // 只持久化"下次启动还该保持"的项；瞬时状态（面板开合、下载进度、AI 缓冲）
      // 一律不落盘，否则会出现"上次打开的对话框又自己弹出来"这种怪事。
      partialize: (s) => ({
        sidebarCollapsed: s.sidebarCollapsed,
        theme: s.theme,
        accent: s.accent,
        ambientEffects: s.ambientEffects,
      }),
    },
  ),
);
