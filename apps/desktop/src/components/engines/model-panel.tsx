import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SkeletonCard } from "@/components/ui/skeleton";
import { useInstallModel, useModels, useRemoveModel } from "@/hooks/use-engines";
import { formatBytes } from "@/lib/format";
import { toToolforgeError } from "@/lib/ipc";
import { useUiStore } from "@/stores/ui-store";
import type { ModelEntry } from "@/types/domain";

/**
 * 模型权重管理。
 *
 * ## 为什么单独一块，而不是塞进引擎卡片里
 *
 * 权重和引擎是两种东西：引擎是**可执行文件**（装了就能用），权重是**数据**
 * （同一个 `onnx-models` 引擎下可以装 0 个、1 个或多个模型）。塞进引擎卡片会让
 * "这个引擎可用吗"和"我下过哪个模型"两件事搅在一起 —— 而后者才是用户真正关心的。
 *
 * ## 一件必须做对的事：不可下载的模型要提前变灰
 *
 * 目录里有几个模型是**故意**没有配置下载源的（哈希还没被核对过，见
 * `toolforge-core::engine` 里的 `verified_sources_are_pinned`）。让用户点一下、
 * 等一会儿、再收到"没有配置 SHA-256"是最糟的顺序。所以这里按 `downloadable`
 * 直接禁用按钮并把原因写在脸上。
 */
export function ModelPanel() {
  const { data: models, isLoading, isError, error, refetch } = useModels();
  const install = useInstallModel();
  const remove = useRemoveModel();

  if (isError) {
    const err = toToolforgeError(error);
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-4 text-sm">
        <p className="font-medium text-destructive">读取模型列表失败</p>
        <p className="mt-1 text-xs text-muted-foreground">{err.fullText}</p>
        <Button size="sm" variant="outline" className="mt-3" onClick={() => void refetch()}>
          重试
        </Button>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="grid gap-3 md:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} lines={3} />
        ))}
      </div>
    );
  }

  const list = models ?? [];
  if (list.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border/70 p-8 text-center text-sm text-muted-foreground">
        引擎目录里还没有登记任何模型权重。
      </p>
    );
  }

  const installedCount = list.filter((m) => m.installed).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">模型权重</h3>
        <Badge variant={installedCount > 0 ? "success" : "outline"}>
          已就绪 {installedCount}/{list.length}
        </Badge>
        <p className="text-[11px] text-muted-foreground">
          权重不随安装包分发，用到时才下载。下载后会按 SHA-256 校验，不匹配直接删除。
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {list.map((m) => (
          <ModelCard
            key={m.id}
            model={m}
            busy={
              (install.isPending && install.variables?.modelId === m.id) ||
              (remove.isPending && remove.variables === m.id)
            }
            onInstall={() =>
              install.mutate({
                modelId: m.id,
                // 不可商用的权重需要用户显式点头；可商用的直接下，别多一步
                licenseAccepted: !m.commercialUse,
              })
            }
            onRemove={() => remove.mutate(m.id)}
          />
        ))}
      </div>
    </div>
  );
}

function ModelCard({
  model,
  busy,
  onInstall,
  onRemove,
}: {
  model: ModelEntry;
  busy: boolean;
  onInstall: () => void;
  onRemove: () => void;
}) {
  // 下载进度与引擎安装共用一条通道（后端只有一种下载事件）
  const download = useUiStore((s) => s.engineDownloads[model.id]);

  const sizeLabel = model.installed
    ? `${(model.installedSizeMb ?? 0).toFixed(1)} MB`
    : `约 ${model.approxSizeMb} MB`;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/40 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{model.name}</p>
          <p className="font-mono text-[10px] text-muted-foreground">{model.id}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {model.installed ? (
            <Badge variant="success">已就绪</Badge>
          ) : model.downloadable ? (
            <Badge variant="outline">未下载</Badge>
          ) : (
            <Badge variant="warning">无下载源</Badge>
          )}
          {!model.commercialUse && <Badge variant="warning">不可商用</Badge>}
        </div>
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">{model.purpose}</p>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        <dt className="text-muted-foreground">体积</dt>
        <dd className="text-right font-mono">{sizeLabel}</dd>
        <dt className="text-muted-foreground">许可证</dt>
        <dd className="truncate text-right" title={model.license}>
          {model.license}
        </dd>
        {model.usedByNodes.length > 0 && (
          <>
            <dt className="text-muted-foreground">用于</dt>
            <dd className="truncate text-right" title={model.usedByNodes.join("、")}>
              {model.usedByNodes.join("、")}
            </dd>
          </>
        )}
      </dl>

      {/* 下载中的进度条：只有拿到字节数才画，避免"0 / 未知"的假进度 */}
      {download && download.total > 0 && (
        <div className="space-y-1">
          <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-300"
              style={{ width: `${Math.min(100, (download.downloaded / download.total) * 100)}%` }}
            />
          </div>
          <p className="text-[10px] text-muted-foreground">
            {formatBytes(download.downloaded)} / {formatBytes(download.total)}
          </p>
        </div>
      )}

      <div className="mt-auto flex items-center gap-2 pt-1">
        {model.installed ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled={busy}
            onClick={onRemove}
          >
            删除权重
          </Button>
        ) : (
          <Button
            size="sm"
            className="h-7 text-xs"
            disabled={busy || !model.downloadable}
            title={
              model.downloadable
                ? undefined
                : "这个模型还没有配置可校验的下载源，装不了"
            }
            onClick={onInstall}
          >
            下载
          </Button>
        )}
        {!model.downloadable && !model.installed && (
          <span className="text-[10px] text-muted-foreground">
            还没核对过哈希，不提供自动下载
          </span>
        )}
      </div>
    </div>
  );
}
