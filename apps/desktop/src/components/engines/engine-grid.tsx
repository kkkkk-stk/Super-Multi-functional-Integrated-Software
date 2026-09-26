import * as React from "react";

import { EngineCard } from "@/components/engines/engine-card";
import { EngineInstallDialog } from "@/components/engines/engine-install-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SkeletonCard } from "@/components/ui/skeleton";
import { isEngineUsable, useEngines, useInstallEngine, useProbeAllEngines, useProbeEngine } from "@/hooks/use-engines";
import { toToolforgeError } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import type { EngineEntry } from "@/types/domain";

type Filter = "all" | "ready" | "missing";

/**
 * 引擎管理网格。
 *
 * 过滤只做三种：全部 / 可用 / 缺失。刻意不做"按类别"——引擎本身没有可靠的分类字段
 * （`EngineDescriptor` 里没有 category），硬编一份反而会与后端目录漂移。
 */
export function EngineGrid() {
  const { data: engines, isLoading, isError, error, refetch, isFetching } = useEngines();
  const probeAll = useProbeAllEngines();
  const probeOne = useProbeEngine();
  const install = useInstallEngine();

  const [filter, setFilter] = React.useState<Filter>("all");
  const [query, setQuery] = React.useState("");
  const [pending, setPending] = React.useState<EngineEntry | null>(null);

  const list = React.useMemo(() => {
    const all = engines ?? [];
    const needle = query.trim().toLowerCase();
    return all.filter((e) => {
      const usable = isEngineUsable(e.status.state);
      if (filter === "ready" && !usable) return false;
      if (filter === "missing" && usable) return false;
      if (needle) {
        const hay = `${e.descriptor.id} ${e.descriptor.name} ${e.descriptor.description}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [engines, filter, query]);

  const readyCount = engines?.filter((e) => isEngineUsable(e.status.state)).length ?? 0;
  const totalCount = engines?.length ?? 0;

  if (isError) {
    const err = toToolforgeError(error);
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-4 text-sm">
        <p className="font-medium text-destructive">读取引擎目录失败</p>
        <p className="mt-1 text-xs text-muted-foreground">{err.fullText}</p>
        <Button size="sm" variant="outline" className="mt-3" onClick={() => void refetch()}>
          重试
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg border border-border/60 p-0.5">
          {(
            [
              { key: "all", label: `全部 ${totalCount}` },
              { key: "ready", label: `可用 ${readyCount}` },
              { key: "missing", label: `缺失 ${Math.max(0, totalCount - readyCount)}` },
            ] as { key: Filter; label: string }[]
          ).map((option) => (
            <button
              key={option.key}
              type="button"
              aria-pressed={filter === option.key}
              onClick={() => setFilter(option.key)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs transition-colors",
                filter === option.key
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索引擎（ffmpeg / 文档 / 模型…）"
          aria-label="搜索引擎"
          className="h-8 max-w-xs text-xs"
        />

        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-1.5 text-xs"
          onClick={() => probeAll.mutate()}
          disabled={probeAll.isPending || isFetching}
        >
          重新探测全部
        </Button>
      </div>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonCard key={i} lines={4} />
          ))}
        </div>
      ) : list.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border/70 p-10 text-center text-sm text-muted-foreground">
          没有匹配的引擎。
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {list.map((entry) => (
            <EngineCard
              key={entry.descriptor.id}
              entry={entry}
              onInstall={setPending}
              onProbe={(id) => probeOne.mutate(id)}
              probing={probeOne.isPending && probeOne.variables === entry.descriptor.id}
            />
          ))}
        </div>
      )}

      <EngineInstallDialog
        entry={pending}
        open={Boolean(pending)}
        onOpenChange={(open) => !open && setPending(null)}
        installing={install.isPending}
        onConfirm={(req) => {
          install.mutate(req, { onSettled: () => setPending(null) });
        }}
      />
    </div>
  );
}
