import { AnimatePresence } from "framer-motion";
import { Filter, PackagePlus, RefreshCw, Search, ShieldAlert, SortAsc } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { PluginCard } from "@/components/plugins/plugin-card";
import { PluginDetailDrawer } from "@/components/plugins/plugin-detail";
import { PluginSources } from "@/components/plugins/plugin-sources";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SkeletonCard } from "@/components/ui/skeleton";
import {
  ALL_PLUGIN_CATEGORIES,
  pluginCategoryLabel,
  usePluginsState,
  useReloadPlugins,
  useSetPluginEnabled,
  useUninstallPlugin,
} from "@/hooks/use-plugins";
import { RISK_LABELS } from "@/lib/capability";
import type { PluginCategory, PluginSummary, RiskLevel } from "@/types/domain";

type SortKey = "name" | "risk" | "category" | "version";

const RISK_ORDER: RiskLevel[] = ["critical", "high", "medium", "low"];

/**
 * 插件市场。
 *
 * 结构：工具栏（搜索 / 分类 / 排序 / 重新装载 / 导入）+ 卡片网格 + 详情抽屉。
 *
 * 排序刻意提供"按风险"：想排查安全隐患时，把 critical / high 的插件排到最前面
 * 比按名字翻要实用得多。
 *
 * 卸载走二次确认：卸载会**删掉插件目录**（包括它的私有数据与 venv），不可撤销。
 */
export function PluginsPage() {
  const { snapshot, isLoading } = usePluginsState();
  const reload = useReloadPlugins();
  const setEnabled = useSetPluginEnabled();
  const uninstall = useUninstallPlugin();

  const [query, setQuery] = React.useState("");
  const [category, setCategory] = React.useState<PluginCategory | "all">("all");
  const [sort, setSort] = React.useState<SortKey>("name");
  const [onlyPending, setOnlyPending] = React.useState(false);
  const [detailId, setDetailId] = React.useState<string | null>(null);
  const [importOpen, setImportOpen] = React.useState(false);
  const [pendingUninstall, setPendingUninstall] = React.useState<string | null>(null);

  const plugins = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = snapshot.plugins.filter((p) => {
      if (category !== "all" && p.category !== category) return false;
      if (onlyPending && !p.hasPendingPermissions) return false;
      if (needle) {
        const hay = `${p.id} ${p.name} ${p.description ?? ""} ${p.tags.join(" ")}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
    return sortPlugins(list, sort);
  }, [snapshot.plugins, query, category, sort, onlyPending]);

  const enabledCount = snapshot.plugins.filter((p) => p.enabled).length;
  const criticalCount = snapshot.plugins.filter(
    (p) => p.riskLevel === "critical" || p.riskLevel === "high",
  ).length;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold">插件市场</h1>
        <Badge variant="outline" className="tabular">
          共 {snapshot.plugins.length} 个
        </Badge>
        <Badge variant="secondary" className="tabular">
          已启用 {enabledCount}
        </Badge>
        {snapshot.pendingPermissionCount > 0 && (
          <Badge variant="high">
            <ShieldAlert className="h-3 w-3" />
            {snapshot.pendingPermissionCount} 个存在未授权项
          </Badge>
        )}
        {criticalCount > 0 && (
          <Badge variant="destructive">{criticalCount} 个含高风险能力</Badge>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 text-xs"
            disabled={reload.isPending}
            onClick={() => reload.mutate()}
          >
            <RefreshCw className={reload.isPending ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
            重新装载
          </Button>
          <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={() => setImportOpen(true)}>
            <PackagePlus className="h-3.5 w-3.5" />
            导入插件
          </Button>
        </span>
      </header>

      {/* 工具栏 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索插件名、id、标签…"
            aria-label="搜索插件"
            className="h-8 pl-7 text-xs"
          />
        </div>

        <Select
          value={category}
          onChange={(e) => setCategory(e.target.value as PluginCategory | "all")}
          aria-label="按分类筛选"
          className="h-8 w-36 text-xs"
          options={[
            { value: "all", label: "全部分类" },
            ...ALL_PLUGIN_CATEGORIES.map((c) => ({ value: c, label: pluginCategoryLabel(c) })),
          ]}
        />

        <Select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          aria-label="排序方式"
          className="h-8 w-40 text-xs"
          options={[
            { value: "name", label: "按名称" },
            { value: "risk", label: "按风险（高→低）" },
            { value: "category", label: "按分类" },
            { value: "version", label: "按版本" },
          ]}
        />

        <button
          type="button"
          aria-pressed={onlyPending}
          onClick={() => setOnlyPending((v) => !v)}
          className={
            onlyPending
              ? "flex h-8 items-center gap-1.5 rounded-md border border-primary/60 bg-primary/10 px-2.5 text-xs text-primary"
              : "flex h-8 items-center gap-1.5 rounded-md border border-border/60 px-2.5 text-xs text-muted-foreground hover:text-foreground"
          }
        >
          <Filter className="h-3.5 w-3.5" />
          只看待授权
        </button>

        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <SortAsc className="h-3 w-3" />
          {plugins.length} 个结果
        </span>
      </div>

      {/* 网格 */}
      <div className="min-h-0 flex-1 overflow-y-auto pr-1 scrollbar-thin">
        {isLoading ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <SkeletonCard key={i} lines={3} />
            ))}
          </div>
        ) : plugins.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border/70 p-12 text-center">
            <p className="text-sm text-muted-foreground">
              {snapshot.plugins.length === 0
                ? "还没有装载任何插件。点「重新装载」扫描插件目录，或「导入插件」。"
                : "没有匹配的插件。"}
            </p>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <AnimatePresence initial={false}>
              {plugins.map((plugin) => (
                <PluginCard
                  key={plugin.id}
                  summary={plugin}
                  onOpen={setDetailId}
                  onToggleEnabled={(id, enabled) => setEnabled.mutate({ pluginId: id, enabled })}
                  busy={setEnabled.isPending}
                />
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* 详情抽屉 */}
      <PluginDetailDrawer
        pluginId={detailId}
        open={Boolean(detailId)}
        onOpenChange={(open) => !open && setDetailId(null)}
        onRequestUninstall={setPendingUninstall}
      />

      {/* 导入插件 */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>导入插件</DialogTitle>
            <DialogDescription>
              三种来源：本地目录、单段清单、或 AI 生成的草稿（在 AI 工作室里）。
              无论哪种，都必须先校验、再逐条确认权限才会落盘。
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[65vh] overflow-y-auto pr-1 scrollbar-thin">
            <PluginSources />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 卸载确认 */}
      <Dialog
        open={Boolean(pendingUninstall)}
        onOpenChange={(open) => !open && setPendingUninstall(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>卸载插件</DialogTitle>
            <DialogDescription>
              将删除插件目录（含它的私有数据与 Python venv），此操作不可撤销。
              如果只是想停用它，请改用卡片上的开关。
            </DialogDescription>
          </DialogHeader>
          <p className="break-all rounded-md border border-border/60 p-3 font-mono text-xs">
            {pendingUninstall}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingUninstall(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={uninstall.isPending}
              onClick={() => {
                if (!pendingUninstall) return;
                uninstall.mutate(pendingUninstall, {
                  onSuccess: () => {
                    setDetailId(null);
                    setPendingUninstall(null);
                    toast.success("已卸载");
                  },
                });
              }}
            >
              确认卸载
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function sortPlugins(list: PluginSummary[], sort: SortKey): PluginSummary[] {
  const copy = [...list];
  switch (sort) {
    case "risk":
      return copy.sort((a, b) => {
        const ra = RISK_ORDER.indexOf(a.riskLevel);
        const rb = RISK_ORDER.indexOf(b.riskLevel);
        if (ra !== rb) return ra - rb;
        return a.name.localeCompare(b.name);
      });
    case "category":
      return copy.sort(
        (a, b) =>
          a.category.localeCompare(b.category) ||
          RISK_ORDER.indexOf(a.riskLevel) - RISK_ORDER.indexOf(b.riskLevel),
      );
    case "version":
      return copy.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
    case "name":
    default:
      return copy.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
  }
}

/** 供页面顶部展示的风险摘要文案 */
export function riskSummary(list: PluginSummary[]): string {
  const counts = new Map<RiskLevel, number>();
  for (const p of list) counts.set(p.riskLevel, (counts.get(p.riskLevel) ?? 0) + 1);
  return RISK_ORDER.filter((r) => (counts.get(r) ?? 0) > 0)
    .map((r) => `${RISK_LABELS[r]} ${counts.get(r)}`)
    .join(" · ");
}
