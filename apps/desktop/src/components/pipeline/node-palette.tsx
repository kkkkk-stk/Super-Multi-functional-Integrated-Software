import { AlertTriangle, ChevronDown, Search, ShieldAlert } from "lucide-react";
import * as React from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { SkeletonRows } from "@/components/ui/skeleton";
import { categoryColor, groupNodes, useNodeCatalog } from "@/hooks/use-pipeline";
import { isNodeImplemented } from "@/lib/node-support";
import { cn } from "@/lib/utils";
import type { NodeDescriptor } from "@/types/domain";

/**
 * 左侧节点面板。
 *
 * 交互：**拖拽入画布**（HTML5 拖放，`dataTransfer` 里放节点名）+ 点击直接加到画布中心。
 * 两种都给，是因为拖拽在小屏幕上容易失手，点击是可靠的后备。
 *
 * 节点按 `NodeCategory` 分组 —— 分组顺序与颜色都和画布节点一致，
 * 用户能在面板和图之间建立稳定的视觉映射。
 */
export function NodePalette({ onAdd }: { onAdd: (descriptor: NodeDescriptor) => void }) {
  const { data, isLoading, isError, error } = useNodeCatalog();
  const [query, setQuery] = React.useState("");
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});

  const groups = React.useMemo(() => {
    const nodes = data?.nodes ?? [];
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? nodes.filter((n) =>
          `${n.name} ${n.label} ${n.description}`.toLowerCase().includes(needle),
        )
      : nodes;
    return groupNodes(filtered);
  }, [data, query]);

  const onDragStart = (e: React.DragEvent, node: NodeDescriptor) => {
    // 只传节点名：画布那边用 nodeCatalog 反查完整描述，避免在 dataTransfer 里塞 JSON
    e.dataTransfer.setData("application/toolforge-node", node.name);
    e.dataTransfer.effectAllowed = "move";
  };

  return (
    <div className="flex h-full min-h-0 w-[268px] shrink-0 flex-col border-r border-border/60">
      <div className="space-y-2 border-b border-border/60 p-3">
        <p className="text-xs font-semibold">节点面板</p>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索节点（resize / 转码 / OCR…）"
            aria-label="搜索内置节点"
            className="h-8 pl-7 text-xs"
          />
        </div>
        <p className="text-[10px] text-muted-foreground">
          拖到画布上，或单击直接添加。带
          <AlertTriangle className="mx-0.5 inline h-2.5 w-2.5 text-warning" />
          的节点在 v0.1 里还没有实现。
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2 scrollbar-thin">
        {isLoading ? (
          <SkeletonRows rows={8} />
        ) : isError ? (
          <p className="p-3 text-xs text-destructive">
            读取节点目录失败：{String((error as { message?: string })?.message ?? "")}
          </p>
        ) : groups.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">没有匹配的节点。</p>
        ) : (
          groups.map((group) => {
            const isCollapsed = collapsed[group.category] ?? false;
            const colors = categoryColor(group.category);
            return (
              <section key={group.category} className="mb-2">
                <button
                  type="button"
                  aria-expanded={!isCollapsed}
                  onClick={() =>
                    setCollapsed((prev) => ({ ...prev, [group.category]: !isCollapsed }))
                  }
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent/15"
                >
                  <ChevronDown
                    className={cn(
                      "h-3.5 w-3.5 text-muted-foreground transition-transform",
                      isCollapsed && "-rotate-90",
                    )}
                  />
                  <span className={cn("text-xs font-medium", colors.text)}>{group.label}</span>
                  <span className="ml-auto text-[10px] text-muted-foreground tabular">
                    {group.nodes.length}
                  </span>
                </button>

                {!isCollapsed && (
                  <ul className="mt-0.5 space-y-0.5">
                    {group.nodes.map((node) => {
                      const implemented = isNodeImplemented(node.name);
                      const unavailable = data?.availability[node.name] === false;
                      return (
                        <li key={node.name}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                draggable
                                onDragStart={(e) => onDragStart(e, node)}
                                onClick={() => onAdd(node)}
                                aria-label={`添加节点 ${node.label}`}
                                className="flex w-full cursor-grab items-start gap-2 rounded-md border border-transparent px-2 py-1.5 text-left transition-colors hover:border-border hover:bg-accent/10 active:cursor-grabbing"
                              >
                                <span className="min-w-0 flex-1">
                                  <span className="flex items-center gap-1.5">
                                    <span className="truncate text-xs">{node.label}</span>
                                    {!implemented && (
                                      <AlertTriangle className="h-3 w-3 shrink-0 text-warning" />
                                    )}
                                    {unavailable && (
                                      <ShieldAlert className="h-3 w-3 shrink-0 text-muted-foreground" />
                                    )}
                                  </span>
                                  <span className="block truncate font-mono text-[10px] text-muted-foreground">
                                    {node.name}
                                  </span>
                                </span>
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="right" className="max-w-xs">
                              <p className="font-medium">{node.label}</p>
                              <p className="mt-0.5 text-muted-foreground">{node.description}</p>
                              {node.requiresEngines.length > 0 && (
                                <p className="mt-1 text-warning">
                                  必需引擎：{node.requiresEngines.join("、")}
                                </p>
                              )}
                              {node.optionalEngines.length > 0 && (
                                <p className="text-muted-foreground">
                                  可选引擎：{node.optionalEngines.join("、")}
                                </p>
                              )}
                              {!implemented && (
                                <p className="mt-1 text-warning">
                                  v0.1 执行器未实现该节点，运行会失败。
                                </p>
                              )}
                            </TooltipContent>
                          </Tooltip>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}
