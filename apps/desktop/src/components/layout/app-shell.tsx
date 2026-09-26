import * as React from "react";
import { Outlet, useNavigate } from "react-router-dom";

import { DropZone } from "@/components/files/drop-zone";
import { CommandPalette } from "@/components/layout/command-palette";
import { JobsDrawer } from "@/components/layout/jobs-drawer";
import { SecurityAlertDialog } from "@/components/layout/security-alert-dialog";
import { Sidebar } from "@/components/layout/sidebar";
import { StatusBar } from "@/components/layout/status-bar";
import { TopBar } from "@/components/layout/top-bar";
import { AuroraBackground } from "@/components/fx/aurora-background";
import { GridOverlay } from "@/components/fx/grid-overlay";
import { NoiseOverlay } from "@/components/fx/noise-overlay";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useGlobalDragDrop } from "@/hooks/use-drag-drop";
import { useEventBridge } from "@/hooks/use-events";
import { useSettingsThemeSync } from "@/hooks/use-settings";
import { useUiStore } from "@/stores/ui-store";

/**
 * 应用外壳。
 *
 * 这里挂三件"全局只有一份"的东西：
 * 1. **事件桥**（`useEventBridge`）—— 订阅 `toolforge://event` 并分发到 Query 缓存；
 * 2. **全窗口拖放**（`useGlobalDragDrop`）—— 覆盖层 `<DropZone/>` 据此渲染；
 * 3. **主题单向同步**（`useSettingsThemeSync`）—— 把后端 settings 套到 `<html>`。
 *
 * 布局是"侧边栏 + 顶栏 + 内容 + 30px 状态栏"的经典桌面三段式，
 * 整页不滚动（`overflow-hidden`），滚动交给每个页面自己的内容区 ——
 * 这样顶栏与状态栏永远不会被滚走。
 */
export function AppShell() {
  useEventBridge();
  useGlobalDragDrop();
  useSettingsThemeSync();

  const togglePalette = useUiStore((s) => s.toggleCommandPalette);
  const setPaletteOpen = useUiStore((s) => s.setCommandPaletteOpen);
  const navigate = useNavigate();

  // Ctrl/Cmd + K 唤起命令面板
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        togglePalette();
      }
      // Ctrl/Cmd + , 打开设置（很多桌面软件的习惯）
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        navigate("/settings");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [togglePalette, navigate]);

  // 窗口失焦时收起命令面板，避免切回来还挂在上面
  React.useEffect(() => {
    const onBlur = () => setPaletteOpen(false);
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [setPaletteOpen]);

  return (
    <TooltipProvider delayDuration={320} skipDelayDuration={120}>
      <div className="relative flex h-screen w-screen overflow-hidden bg-background text-foreground">
        {/* 背景层（都是 pointer-events-none，不影响交互） */}
        <AuroraBackground />
        <GridOverlay />
        <NoiseOverlay />

        <Sidebar />

        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          <main className="min-h-0 flex-1 overflow-hidden p-4" id="main-content">
            <Outlet />
          </main>
          <StatusBar />
        </div>

        {/* 全局浮层 */}
        <DropZone />
        <CommandPalette />
        <JobsDrawer />
        <SecurityAlertDialog />
      </div>
    </TooltipProvider>
  );
}
