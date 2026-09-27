import { ImageOff, Layers, Play, Sparkles } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";

import { PluginRunner } from "@/components/plugins/plugin-runner";
import { SpotlightCard } from "@/components/fx/spotlight-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SkeletonCard } from "@/components/ui/skeleton";
import { usePluginsState } from "@/hooks/use-plugins";
import { cn } from "@/lib/utils";
import type { PluginSummary } from "@/types/domain";

/**
 * 图片工具页。
 *
 * 与「格式转换」共用同一个 runner，但呈现方式不同：这里按**具体工具**（卡片）组织，
 * 因为图片相关的操作（缩放、裁剪、压缩、去背景）是用户能直接说出口的需求，
 * 而"选一个插件"对多数人来说太抽象。
 *
 * 每张卡片都会显示该插件是否可用、用了哪些还没实现的节点 —— 例如"抠图去背景"
 * 依赖 `image.remove-background`，那个节点在 v0.1 的执行器里**还没有实现**，
 * 卡片上必须直说，而不是让用户点进去白跑一次。
 */
export function ImagePage() {
  const { snapshot, isLoading } = usePluginsState();
  const [activeId, setActiveId] = React.useState<string | null>(null);

  const imagePlugins = React.useMemo(
    () => snapshot.plugins.filter((p) => p.category === "image" || p.tags.includes("图片")),
    [snapshot.plugins],
  );

  React.useEffect(() => {
    if (activeId && imagePlugins.some((p) => p.id === activeId)) return;
    const preferred =
      imagePlugins.find((p) => p.enabled && p.grantedCount > 0) ?? imagePlugins[0] ?? null;
    setActiveId(preferred ? preferred.id : null);
  }, [imagePlugins, activeId]);

  return (
    <div className="grid h-full min-h-0 gap-4 xl:grid-cols-[320px_1fr]">
      {/* 左侧：工具卡片 */}
      <aside className="min-h-0 space-y-3 overflow-y-auto pr-1 scrollbar-thin">
        <header className="space-y-1">
          <h1 className="text-lg font-semibold">图片工具</h1>
          <p className="text-xs text-muted-foreground">
            缩放、裁剪、格式转换、清除元数据、抠图。图片链路由纯 Rust 实现兜底，
            装了 libvips / ImageMagick 会自动提速。
          </p>
        </header>

        {isLoading ? (
          <>
            <SkeletonCard lines={3} />
            <SkeletonCard lines={3} />
          </>
        ) : imagePlugins.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border/70 p-6 text-center">
            <ImageOff className="h-6 w-6 text-muted-foreground/60" />
            <p className="text-xs text-muted-foreground">
              没有图片类插件。到「插件市场」重新装载，或用「流程编辑器」搭一条图片流水线。
            </p>
            <Button asChild size="sm" variant="outline" className="text-xs">
              <Link to="/plugins">去插件市场</Link>
            </Button>
          </div>
        ) : (
          imagePlugins.map((plugin) => (
            <ToolCard
              key={plugin.id}
              plugin={plugin}
              active={plugin.id === activeId}
              onSelect={() => setActiveId(plugin.id)}
            />
          ))
        )}

        <SpotlightCard className="p-4 text-xs">
          <h2 className="mb-1.5 flex items-center gap-1.5 font-semibold">
            <Sparkles className="h-3.5 w-3.5" />
            没有你要的功能？
          </h2>
          <p className="text-muted-foreground">
            用「流程编辑器」把内置节点连起来（缩放 → 裁剪 → 转格式 → 清元数据），
            导出成插件后就会出现在这里。也可以用 AI 工作室用一句话生成草稿。
          </p>
          <div className="mt-2 flex gap-2">
            <Button asChild size="sm" variant="outline" className="h-7 text-xs">
              <Link to="/pipeline">
                <Layers className="mr-1 h-3 w-3" />
                流程编辑器
              </Link>
            </Button>
            <Button asChild size="sm" variant="outline" className="h-7 text-xs">
              <Link to="/ai">AI 生成</Link>
            </Button>
          </div>
        </SpotlightCard>
      </aside>

      {/* 右侧：运行器 */}
      <div className="min-h-0 overflow-y-auto pr-1 scrollbar-thin">
        {activeId ? (
          <PluginRunner key={activeId} pluginId={activeId} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border/70 p-10 text-center">
            <Play className="h-7 w-7 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">从左侧选一个图片工具开始</p>
          </div>
        )}
      </div>
    </div>
  );
}

function ToolCard({
  plugin,
  active,
  onSelect,
}: {
  plugin: PluginSummary;
  active: boolean;
  onSelect: () => void;
}) {
  // "能不能跑"不再要求权限齐全：部分授权的插件照样可以跑，
  // 缺的那几项在运行期才会拦（并记审计）。见 `PluginStore::set_enabled` 的文档。
  // 但"一项都没授权"仍然算不可用 —— 那种状态下插件做什么都会被拒。
  const runnable = plugin.enabled && plugin.grantedCount > 0;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        "w-full rounded-lg border p-3 text-left transition-colors",
        active ? "border-primary/60 bg-primary/5" : "border-border/60 hover:border-border",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-medium">{plugin.name}</span>
        {plugin.builtin && <Badge variant="outline">内置</Badge>}
        <span
          className={cn(
            "ml-auto h-1.5 w-1.5 shrink-0 rounded-full",
            runnable ? "bg-success" : "bg-warning",
          )}
        />
      </div>
      <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
        {plugin.description ?? plugin.id}
      </p>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {!plugin.enabled && <Badge variant="secondary">未启用</Badge>}
        {plugin.enabled && plugin.grantedCount === 0 && <Badge variant="high">未授权</Badge>}
        {plugin.enabled && plugin.hasPendingPermissions && plugin.grantedCount > 0 && (
          <Badge variant="high">部分授权</Badge>
        )}
        {plugin.tags.slice(0, 3).map((tag) => (
          <span key={tag} className="text-[10px] text-muted-foreground">
            #{tag}
          </span>
        ))}
      </div>
    </button>
  );
}
