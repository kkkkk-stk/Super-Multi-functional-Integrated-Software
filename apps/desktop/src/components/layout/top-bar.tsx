import {
  Command as CommandIcon,
  Monitor,
  Moon,
  Palette,
  RefreshCw,
  Search,
  Sun,
} from "lucide-react";
import { useLocation } from "react-router-dom";

import { JobsStatusPill } from "@/components/jobs/jobs-status-pill";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useJobs } from "@/hooks/use-jobs";
import { usePatchSettings } from "@/hooks/use-settings";
import { ACCENTS, THEME_MODES } from "@/lib/theme";
import { findNavItem } from "@/lib/nav";
import { useUiStore } from "@/stores/ui-store";

/**
 * 顶栏：面包屑 + 全局操作 + 主题切换 + 任务胶囊。
 *
 * 所有主题/强调色的切换都走 `settings_patch`（后端是权威来源），
 * 不直接改 store —— 这样"写盘失败"时界面不会显示一个并未生效的主题。
 */
export function TopBar() {
  const location = useLocation();
  const current = findNavItem(location.pathname);
  const setPaletteOpen = useUiStore((s) => s.setCommandPaletteOpen);
  const theme = useUiStore((s) => s.theme);
  const accent = useUiStore((s) => s.accent);
  const patch = usePatchSettings();
  const jobsQuery = useJobs();

  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;

  return (
    <header className="glass z-10 flex h-14 shrink-0 items-center gap-3 border-b border-border/60 px-4">
      {/* 面包屑 */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>ToolForge</span>
          <span aria-hidden="true">/</span>
          <span className="text-foreground">{current?.label ?? "未知页面"}</span>
        </div>
        <p className="truncate text-[11px] text-muted-foreground/80">
          {current?.description ?? "该页面不在导航表里"}
        </p>
      </div>

      {/* 全局操作 */}
      <div className="flex shrink-0 items-center gap-1">
        <JobsStatusPill />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="立即刷新任务与系统状态"
              disabled={jobsQuery.isFetching}
              onClick={() => {
                void jobsQuery.refetch();
              }}
            >
              <RefreshCw className={jobsQuery.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">刷新任务列表（面板会实时推送事件）</TooltipContent>
        </Tooltip>

        {/* 命令面板入口 */}
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-2 px-2.5 text-xs text-muted-foreground"
          onClick={() => setPaletteOpen(true)}
          aria-label="打开命令面板"
        >
          <Search className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">搜索 / 跳转</span>
          <kbd className="hidden items-center gap-0.5 rounded border border-border/70 px-1 py-0.5 font-mono text-[10px] sm:inline-flex">
            <CommandIcon className="h-2.5 w-2.5" />K
          </kbd>
        </Button>

        {/* 主题与强调色 */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="外观设置">
              <ThemeIcon className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>主题</DropdownMenuLabel>
            {THEME_MODES.map((mode) => (
              <DropdownMenuItem
                key={mode.mode}
                onSelect={() => patch.mutate({ theme: mode.mode })}
                className={theme === mode.mode ? "bg-accent/15" : undefined}
              >
                {mode.mode === "dark" ? (
                  <Moon className="h-4 w-4" />
                ) : mode.mode === "light" ? (
                  <Sun className="h-4 w-4" />
                ) : (
                  <Monitor className="h-4 w-4" />
                )}
                <span>{mode.label}</span>
                {theme === mode.mode && (
                  <span className="ml-auto text-[10px] text-muted-foreground">当前</span>
                )}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>强调色</DropdownMenuLabel>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Palette className="h-4 w-4" />
                <span>{ACCENTS.find((a) => a.name === accent)?.label ?? "青蓝"}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {ACCENTS.map((option) => (
                  <DropdownMenuItem
                    key={option.name}
                    onSelect={() => patch.mutate({ accent: option.name })}
                  >
                    <span
                      className="h-3.5 w-3.5 rounded-full ring-1 ring-border"
                      style={{ background: option.swatch }}
                      aria-hidden="true"
                    />
                    <span>{option.label}</span>
                    {accent === option.name && (
                      <span className="ml-auto text-[10px] text-muted-foreground">当前</span>
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
