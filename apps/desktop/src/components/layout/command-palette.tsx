import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  Command as CommandIcon,
  CornerDownLeft,
  Cpu,
  Moon,
  Package,
  RefreshCw,
  Sparkles,
  Sun,
  Trash2,
  Zap,
} from "lucide-react";
import * as React from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { useClearFinished } from "@/hooks/use-jobs";
import { useProbeAllEngines } from "@/hooks/use-engines";
import { useReloadPlugins } from "@/hooks/use-plugins";
import { usePatchSettings, useSystemStatus } from "@/hooks/use-settings";
import { NAV_ITEMS, type NavItem } from "@/lib/nav";
import { revealInExplorer } from "@/lib/system";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui-store";

/**
 * 命令面板（Ctrl/Cmd + K）。
 *
 * - 用 Radix Dialog 当容器：**焦点陷阱、Esc 关闭、`aria-modal` 全部由它负责**，
 *   动画则交给内部一层 framer-motion（缩放 + 淡入），两件事各归各的；
 * - 模糊搜索是自己写的**子序列匹配 + 评分**（不引 fuse.js）：
 *   页面与操作加起来只有十几条，权重规则简单几行就够，且完全可预测；
 * - 键盘：↑/↓ 移动、Enter 执行、Esc 关闭、Home/End 跳首尾。
 */

interface PaletteItem {
  id: string;
  label: string;
  hint: string;
  group: "页面" | "操作";
  icon: React.ComponentType<{ className?: string }>;
  keywords: string[];
  run: () => void;
}

export function CommandPalette() {
  const open = useUiStore((s) => s.commandPaletteOpen);
  const setOpen = useUiStore((s) => s.setCommandPaletteOpen);
  const theme = useUiStore((s) => s.theme);
  const ambientEffects = useUiStore((s) => s.ambientEffects);
  const navigate = useNavigate();

  const patchSettings = usePatchSettings();
  const probeAll = useProbeAllEngines();
  const reloadPlugins = useReloadPlugins();
  const clearFinished = useClearFinished();
  const { data: system } = useSystemStatus();

  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const listRef = React.useRef<HTMLUListElement | null>(null);

  const close = React.useCallback(() => setOpen(false), [setOpen]);

  const items = React.useMemo<PaletteItem[]>(() => {
    const pageItems: PaletteItem[] = NAV_ITEMS.map((nav: NavItem) => ({
      id: `page:${nav.path}`,
      label: nav.label,
      hint: nav.description,
      group: "页面",
      icon: nav.icon,
      keywords: nav.keywords,
      run: () => {
        navigate(nav.path);
        close();
      },
    }));

    const actionItems: PaletteItem[] = [
      {
        id: "action:theme",
        label: theme === "dark" ? "切换到浅色主题" : "切换到深色主题",
        hint: "外观只影响本机显示，随时可改",
        group: "操作",
        icon: theme === "dark" ? Sun : Moon,
        keywords: ["theme", "dark", "light", "主题", "深色", "浅色", "外观"],
        run: () => {
          patchSettings.mutate({ theme: theme === "dark" ? "light" : "dark" });
          close();
        },
      },
      {
        id: "action:ambient",
        label: ambientEffects ? "关闭背景氛围动效" : "开启背景氛围动效",
        hint: "低配机器关掉可以省一点 GPU",
        group: "操作",
        icon: Zap,
        keywords: ["ambient", "aurora", "氛围", "动效", "性能"],
        run: () => {
          patchSettings.mutate({ ambientEffects: !ambientEffects });
          close();
        },
      },
      {
        id: "action:probe-engines",
        label: "重新探测全部引擎",
        hint: "会依次调用各引擎的 --version，可能需要几秒",
        group: "操作",
        icon: Cpu,
        keywords: ["engine", "probe", "引擎", "探测", "刷新"],
        run: () => {
          probeAll.mutate();
          close();
        },
      },
      {
        id: "action:reload-plugins",
        label: "重新装载插件目录",
        hint: "手改过 plugin.yaml 之后用它生效（单个失败不影响其它插件）",
        group: "操作",
        icon: Package,
        keywords: ["plugin", "reload", "插件", "重载", "重新装载"],
        run: () => {
          reloadPlugins.mutate();
          close();
        },
      },
      {
        id: "action:clear-jobs",
        label: "清理已结束的任务",
        hint: "只删内存记录，不动产出文件",
        group: "操作",
        icon: Trash2,
        keywords: ["jobs", "clear", "任务", "清理", "清空"],
        run: () => {
          clearFinished.mutate();
          close();
        },
      },
      {
        id: "action:open-data-dir",
        label: "在文件管理器中打开数据目录",
        hint: system?.paths.entries[0]?.path ?? "读取中…",
        group: "操作",
        icon: RefreshCw,
        keywords: ["path", "folder", "目录", "数据目录", "打开"],
        run: () => {
          const dir = system?.paths.entries[0]?.path;
          if (!dir) {
            toast.warning("还没有读到数据目录", { description: "请稍后再试。" });
          } else {
            void revealInExplorer(dir);
          }
          close();
        },
      },
      {
        id: "action:ai-studio",
        label: "去 AI 工作室用自然语言生成插件",
        hint: "产出只是草稿，安装前必须逐条确认权限",
        group: "操作",
        icon: Sparkles,
        keywords: ["ai", "generate", "生成", "插件", "自然语言"],
        run: () => {
          navigate("/ai");
          close();
        },
      },
      {
        id: "action:jobs",
        label: "查看任务中心",
        hint: "进度、日志、产出都在这里",
        group: "操作",
        icon: Activity,
        keywords: ["jobs", "tasks", "任务", "日志"],
        run: () => {
          navigate("/jobs");
          close();
        },
      },
    ];

    return [...pageItems, ...actionItems];
  }, [
    ambientEffects,
    clearFinished,
    close,
    navigate,
    patchSettings,
    probeAll,
    reloadPlugins,
    system,
    theme,
  ]);

  const results = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    const scored = items
      .map((item) => ({ item, score: scoreMatch(item, q) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.map((r) => r.item);
  }, [items, query]);

  // 结果变化时把高亮拉回第一个可用项
  React.useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // 打开时清空查询，并把选中的条目滚进可视区
  React.useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  React.useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, results.length]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (results.length === 0 ? 0 : (i + 1) % results.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (results.length === 0 ? 0 : (i - 1 + results.length) % results.length));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIndex(Math.max(0, results.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      results[activeIndex]?.run();
    }
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <AnimatePresence>
        {open && (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Overlay asChild forceMount>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
              />
            </DialogPrimitive.Overlay>

            <DialogPrimitive.Content
              asChild
              forceMount
              aria-label="命令面板"
              onKeyDown={onKeyDown}
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.96, y: -8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97, y: -4 }}
                transition={{ type: "spring", stiffness: 420, damping: 30 }}
                className="fixed left-1/2 top-[14%] z-50 w-full max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border border-border/70 bg-card/95 shadow-2xl backdrop-blur-2xl"
              >
                <DialogPrimitive.Title className="sr-only">命令面板</DialogPrimitive.Title>
                <DialogPrimitive.Description className="sr-only">
                  输入关键词搜索页面或操作，↑↓ 选择，Enter 执行
                </DialogPrimitive.Description>

                <div className="flex items-center gap-2 border-b border-border/60 px-4">
                  <CommandIcon className="h-4 w-4 text-muted-foreground" />
                  <input
                    // 面板打开后自动聚焦，键盘用户不需要再点一下
                    autoFocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="搜索页面、操作…（试试「引擎」「抠图」「主题」）"
                    aria-label="搜索页面或操作"
                    className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                  />
                  <kbd className="rounded border border-border/70 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    Esc
                  </kbd>
                </div>

                <ul
                  ref={listRef}
                  className="max-h-[46vh] overflow-y-auto p-2 scrollbar-thin"
                  role="listbox"
                  aria-label="命令结果"
                >
                  {results.length === 0 ? (
                    <li className="px-3 py-8 text-center text-sm text-muted-foreground">
                      没有匹配的结果
                    </li>
                  ) : (
                    results.map((item, index) => {
                      const Icon = item.icon;
                      const isActive = index === activeIndex;
                      return (
                        <li key={item.id}>
                          <button
                            type="button"
                            data-index={index}
                            role="option"
                            aria-selected={isActive}
                            onMouseEnter={() => setActiveIndex(index)}
                            onClick={() => item.run()}
                            className={cn(
                              "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors",
                              isActive ? "bg-primary/15" : "hover:bg-accent/15",
                            )}
                          >
                            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm">{item.label}</span>
                              <span className="block truncate text-[11px] text-muted-foreground">
                                {item.hint}
                              </span>
                            </span>
                            <span className="shrink-0 rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                              {item.group}
                            </span>
                            {isActive && <CornerDownLeft className="h-3.5 w-3.5 text-primary" />}
                          </button>
                        </li>
                      );
                    })
                  )}
                </ul>

                <div className="flex items-center justify-between border-t border-border/60 px-4 py-2 text-[11px] text-muted-foreground">
                  <span>↑↓ 选择 · Enter 执行 · Esc 关闭</span>
                  <span className="tabular">{results.length} 项结果</span>
                </div>
              </motion.div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </DialogPrimitive.Root>
  );
}

/**
 * 子序列匹配评分。
 *
 * 规则（简单但够用）：
 * - 命中标题开头 +100；命中标题其它位置 +60；命中关键词 +40；命中描述 +20；
 * - 匹配得越紧凑（子序列跨度越小）加分越多；
 * - 完全不匹配返回 0。
 */
function scoreMatch(item: PaletteItem, query: string): number {
  const label = item.label.toLowerCase();
  const hint = item.hint.toLowerCase();
  const keywords = item.keywords.join(" ").toLowerCase();

  if (label.startsWith(query)) return 120;
  if (label.includes(query)) return 90;
  if (keywords.includes(query)) return 60;
  if (hint.includes(query)) return 40;

  const span = subsequenceSpan(label, query);
  if (span >= 0) return Math.max(10, 50 - span);
  const kwSpan = subsequenceSpan(keywords, query);
  if (kwSpan >= 0) return Math.max(5, 30 - kwSpan);
  return 0;
}

/** 子序列匹配的跨度（越小越紧凑）；不匹配返回 -1 */
function subsequenceSpan(text: string, query: string): number {
  let from = -1;
  let to = -1;
  let cursor = 0;
  for (const ch of query) {
    const idx = text.indexOf(ch, cursor);
    if (idx < 0) return -1;
    if (from < 0) from = idx;
    to = idx;
    cursor = idx + 1;
  }
  return to - from + 1;
}
