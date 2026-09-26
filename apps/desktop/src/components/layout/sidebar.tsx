import { AnimatePresence, motion } from "framer-motion";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { NAV_GROUPS, NAV_ITEMS } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui-store";

/**
 * 侧边栏。
 *
 * - 可折叠成"图标条"（状态记在 `ui-store`，会持久化）；
 * - 当前页用 **`layoutId` 滑动指示条**高亮：framer-motion 会在两个位置之间做
 *   共享布局动画，比给每个项加 CSS transition 更连贯；
 * - 折叠态下用 Tooltip 补回文字（无障碍：图标按钮必须有 `aria-label`）。
 */
export function Sidebar() {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggle = useUiStore((s) => s.toggleSidebar);
  const location = useLocation();

  return (
    <motion.aside
      animate={{ width: collapsed ? 68 : 236 }}
      transition={{ type: "spring", stiffness: 340, damping: 32 }}
      className="glass relative z-20 flex h-full shrink-0 flex-col border-r border-border/60"
      aria-label="主导航"
    >
      {/* 品牌区 */}
      <div className="flex h-14 items-center gap-2.5 px-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 ring-1 ring-primary/30">
          <span className="text-sm font-bold text-primary">TF</span>
        </div>
        <AnimatePresence initial={false}>
          {!collapsed && (
            <motion.div
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -6 }}
              transition={{ duration: 0.15 }}
              className="min-w-0"
            >
              <p className="truncate text-sm font-semibold leading-tight">ToolForge</p>
              <p className="truncate text-[10px] text-muted-foreground">
                插件驱动的本地工具箱
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* 导航 */}
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 scrollbar-thin">
        {NAV_GROUPS.map((group) => {
          const items = NAV_ITEMS.filter((n) => n.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group} className="mb-2">
              {!collapsed && (
                <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                  {group}
                </p>
              )}
              <ul className="space-y-0.5">
                {items.map((item) => {
                  const active =
                    location.pathname === item.path ||
                    (item.path !== "/" && location.pathname.startsWith(item.path));
                  const Icon = item.icon;
                  const link = (
                    <NavLink
                      to={item.path}
                      aria-label={item.label}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "relative flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors",
                        active
                          ? "text-foreground"
                          : "text-muted-foreground hover:bg-accent/15 hover:text-foreground",
                        collapsed && "justify-center px-0",
                      )}
                    >
                      {/* 滑动指示条：同一个 layoutId 会在不同项之间"游动" */}
                      {active && (
                        <motion.span
                          layoutId="sidebar-active"
                          className="absolute inset-0 -z-10 rounded-md bg-primary/15 ring-1 ring-primary/30"
                          transition={{ type: "spring", stiffness: 420, damping: 34 }}
                        />
                      )}
                      <Icon className="h-4 w-4 shrink-0" />
                      {!collapsed && <span className="truncate">{item.label}</span>}
                    </NavLink>
                  );

                  return (
                    <li key={item.path}>
                      {collapsed ? (
                        <Tooltip>
                          <TooltipTrigger asChild>{link}</TooltipTrigger>
                          <TooltipContent side="right">
                            <p className="font-medium">{item.label}</p>
                            <p className="text-muted-foreground">{item.description}</p>
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        link
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>

      {/* 折叠开关 */}
      <div className="border-t border-border/60 p-2">
        <Button
          variant="ghost"
          size={collapsed ? "icon" : "sm"}
          className={cn("w-full", collapsed && "w-9")}
          aria-label={collapsed ? "展开侧边栏" : "折叠侧边栏"}
          aria-expanded={!collapsed}
          onClick={toggle}
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <>
              <ChevronLeft className="h-4 w-4" />
              <span className="text-xs">折叠</span>
            </>
          )}
        </Button>
      </div>
    </motion.aside>
  );
}
