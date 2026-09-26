/**
 * 设置 / 系统状态 / AI 连通性。
 *
 * ## 单向同步
 *
 * Rust 的 `Settings` 是主题与强调色的**权威来源**（Query 独占），
 * `ui-store` 里那份是"已经套用到 DOM 上的瞬时光标"。同步方向永远是：
 *
 * ```text
 * ["settings"]（Query） ──► use-settings 的 effect ──► ui-store + <html>
 *                                                          ▲
 * 用户点"深色" ──► settings_patch ──► 后端返回 Settings ──────┘
 * ```
 *
 * 用户操作**不直接改 store**：先落库，再用后端返回的那份同步过来。这样即使
 * 写盘失败（比如目录只读），界面也不会显示一个并未生效的主题。
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "sonner";

import { aiTestConnection, settingsGet, settingsPatch, systemStatus, toToolforgeError } from "@/lib/ipc";
import { queryKeys } from "@/lib/query-client";
import { applyTheme, isThemeMode, watchSystemTheme } from "@/lib/theme";
import { useUiStore } from "@/stores/ui-store";
import type {
  AiTestConnectionResponse,
  Settings,
  SettingsPatch,
  SystemStatus,
} from "@/types/domain";

export function useSettings() {
  return useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => settingsGet(),
    staleTime: 30_000,
  });
}

export function useSystemStatus() {
  return useQuery({
    queryKey: queryKeys.system,
    queryFn: () => systemStatus(),
    // `system_status` 会顺手探测全部引擎，属于"有点贵"的调用：
    // 只在进入页面 / 手动刷新时拉，不做后台轮询。
    staleTime: 30_000,
  });
}

export function usePatchSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsPatch) => settingsPatch(patch),
    onSuccess: (settings: Settings) => {
      // 后端返回的就是权威值 → 直接写进缓存，顺带让同步 effect 套用主题
      client.setQueryData(queryKeys.settings, settings);
      // 输出目录 / 并发度会影响运行的默认行为，系统状态也跟着刷新一次
      if (patchViewAffectsSystem(settings)) {
        void client.invalidateQueries({ queryKey: queryKeys.system });
      }
    },
    onError: (e) => toast.error("保存设置失败", { description: toToolforgeError(e).fullText }),
  });
}

function patchViewAffectsSystem(_settings: Settings): boolean {
  // 目前 system_status 只包含引擎/插件/任务计数与目录，设置改动不影响它。
  // 留成函数是为了将来加字段时只有一个地方要改。
  return false;
}

export function useAiTestConnection() {
  return useMutation({
    mutationFn: () => aiTestConnection(),
    onSuccess: (res: AiTestConnectionResponse) => {
      if (res.ok) {
        toast.success("AI 服务连接正常", {
          description:
            res.models.length > 0
              ? `可用模型 ${res.models.length} 个，例如 ${res.models.slice(0, 3).join("、")}`
              : "服务可达，但没有列出任何模型。",
        });
      } else {
        toast.error("AI 服务不可用", { description: res.error ?? "未知原因" });
      }
    },
    onError: (e) => toast.error("测试失败", { description: toToolforgeError(e).fullText }),
  });
}

/**
 * 把 Query 里的 settings **单向**同步到 ui-store / DOM，并在"跟随系统"模式下
 * 监听系统主题变化。必须在 AppShell 里调用一次。
 */
export function useSettingsThemeSync(): void {
  const { data: settings } = useSettings();
  const theme = useUiStore((s) => s.theme);
  const syncFromSettings = useUiStore((s) => s.syncFromSettings);

  useEffect(() => {
    if (!settings) return;
    syncFromSettings({
      theme: settings.theme,
      accent: settings.accent,
      ambientEffects: settings.ambientEffects,
    });
  }, [settings, syncFromSettings]);

  useEffect(() => {
    if (theme !== "system") return;
    if (!isThemeMode(theme)) return;
    return watchSystemTheme(() => {
      applyTheme("system");
    });
  }, [theme]);
}

/** 只读派生：应用信息（仪表盘与状态栏用） */
export function useAppInfoFromSystem(): SystemStatus["info"] | undefined {
  const { data } = useSystemStatus();
  return data?.info;
}
