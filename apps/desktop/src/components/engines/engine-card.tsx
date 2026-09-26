import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Download,
  ExternalLink,
  FolderOpen,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { stateLabel } from "@/hooks/use-engines";
import { formatBytes, formatMegabytes, formatSpeed } from "@/lib/format";
import { openExternal, revealInExplorer } from "@/lib/system";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui-store";
import type { EngineEntry } from "@/types/domain";

/**
 * 引擎卡片。
 *
 * 引擎不是"装了就完事"的东西 —— FFmpeg / LibreOffice / Calibre 各有自己的许可证，
 * 而且**缺失只应该让依赖它的节点不可用，不能让整个应用起不来**。所以卡片上要
 * 一次讲清四件事：状态、装在哪、许可证、装了它能解锁哪些内置节点。
 */
export function EngineCard({
  entry,
  onInstall,
  onProbe,
  probing,
}: {
  entry: EngineEntry;
  onInstall: (entry: EngineEntry) => void;
  onProbe: (engineId: string) => void;
  probing: boolean;
}) {
  const { descriptor, status, usedByNodes } = entry;
  const download = useUiStore((s) => s.engineDownloads[descriptor.id]);

  const usable = status.state === "detected" || status.state === "installed";
  const installing = status.state === "installing" || Boolean(download);
  const failed = status.state === "failed";

  const canDownload = descriptor.installModes.includes("download");
  const canSystemDetect = descriptor.installModes.includes("system");

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-lg border bg-card/50 p-4 transition-colors",
        usable ? "border-success/30" : failed ? "border-destructive/40" : "border-border/60",
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
            usable ? "bg-success/15" : "bg-muted/50",
          )}
        >
          {installing ? (
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
          ) : usable ? (
            <CheckCircle2 className="h-4 w-4 text-success" />
          ) : failed ? (
            <XCircle className="h-4 w-4 text-destructive" />
          ) : (
            <Cpu className="h-4 w-4 text-muted-foreground" />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{descriptor.name}</h3>
            <Badge variant={usable ? "success" : failed ? "destructive" : "secondary"}>
              {stateLabel(status.state)}
            </Badge>
            {descriptor.core && <Badge variant="outline">核心</Badge>}
            {descriptor.requiresLicenseAck && !usable && (
              <Badge variant="warning">需确认许可证</Badge>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{descriptor.description}</p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`重新探测 ${descriptor.name}`}
                onClick={() => onProbe(descriptor.id)}
                disabled={probing}
              >
                <RefreshCw className={cn("h-3.5 w-3.5", probing && "animate-spin")} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">重新探测（会调用一次引擎进程）</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`打开 ${descriptor.name} 官方主页`}
                onClick={() => void openExternal(descriptor.homepage)}
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">{descriptor.homepage}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* 安装 / 下载进度 */}
      {installing && (
        <div className="space-y-1">
          <Progress
            value={download && download.total > 0 ? download.downloaded / download.total : null}
            indeterminate={!download || download.total === 0}
            className="h-1.5"
          />
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>
              {download && download.total > 0
                ? `${formatBytes(download.downloaded)} / ${formatBytes(download.total)}`
                : "正在准备下载…"}
            </span>
            <span className="tabular">
              {download && download.speedBps > 0 ? formatSpeed(download.speedBps) : ""}
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground">
            进度由后端事件实时推送，装完会自动刷新状态。
          </p>
        </div>
      )}

      {/* 状态细节 */}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
        <dt className="text-muted-foreground">来源</dt>
        <dd>
          {status.source === "none"
            ? "—"
            : status.source === "system"
              ? "系统安装"
              : status.source === "managed"
                ? "应用托管"
                : status.source === "sidecar"
                  ? "随应用分发"
                  : "远程服务"}
          {status.version ? ` · 版本 ${status.version}` : ""}
        </dd>
        <dt className="text-muted-foreground">体积</dt>
        <dd>
          {formatMegabytes(descriptor.approxSizeMb)}
          {status.installedSizeMb ? `（已占用 ${status.installedSizeMb.toFixed(1)} MB）` : ""}
        </dd>
        <dt className="text-muted-foreground">许可证</dt>
        <dd>
          {descriptor.license}
          <span className="block text-muted-foreground/80">{descriptor.licenseNote}</span>
        </dd>
        {status.path && (
          <>
            <dt className="text-muted-foreground">位置</dt>
            <dd className="break-all font-mono">{status.path}</dd>
          </>
        )}
        {status.message && (
          <>
            <dt className="text-muted-foreground">说明</dt>
            <dd className={failed ? "text-destructive" : undefined}>{status.message}</dd>
          </>
        )}
      </dl>

      {/* 装了它能解锁什么 */}
      {usedByNodes.length > 0 && (
        <div>
          <p className="mb-1 text-[11px] text-muted-foreground">
            被这些内置节点使用（{usedByNodes.length} 个）
          </p>
          <div className="flex flex-wrap gap-1">
            {usedByNodes.slice(0, 12).map((node) => (
              <span
                key={node}
                className="rounded border border-border/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
              >
                {node}
              </span>
            ))}
            {usedByNodes.length > 12 && (
              <span className="text-[10px] text-muted-foreground">
                等 {usedByNodes.length} 个
              </span>
            )}
          </div>
        </div>
      )}

      {/* 模型权重（与引擎分开下载） */}
      {descriptor.models.length > 0 && (
        <div className="space-y-1.5 rounded-md border border-border/50 p-2.5">
          <p className="text-[11px] font-medium">可选模型权重（与引擎分开下载）</p>
          {descriptor.models.map((model) => (
            <div key={model.id} className="flex items-start gap-2 text-[11px]">
              <span className="w-4 shrink-0 pt-0.5">
                {status.installedModels.includes(model.id) ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                ) : (
                  <Download className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{model.name}</span>
                  <span className="text-muted-foreground">
                    {formatMegabytes(model.approxSizeMb)}
                  </span>
                  <Badge variant={model.commercialUse ? "outline" : "warning"}>
                    {model.commercialUse ? "可商用" : "不可商用"}
                  </Badge>
                </span>
                <span className="block text-muted-foreground">{model.purpose}</span>
                <span className="block text-muted-foreground/80">
                  权重许可证：{model.license}
                </span>
              </span>
            </div>
          ))}
          <p className="flex items-start gap-1 text-[10px] text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            注意：代码许可证与权重许可证是两回事，商用前请分别确认。
          </p>
        </div>
      )}

      {/* 操作区 */}
      <div className="mt-auto flex items-center gap-2 pt-1">
        {!usable && canDownload && (
          <Button
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={() => onInstall(entry)}
            disabled={installing}
          >
            <Download className="h-3.5 w-3.5" />
            {installing ? "安装中…" : `下载安装（约 ${formatMegabytes(descriptor.approxSizeMb)}）`}
          </Button>
        )}
        {!usable && !canDownload && canSystemDetect && (
          <Badge variant="warning" className="px-2 py-1">
            该引擎只支持系统安装，请先在本机安装后点右上角重新探测
          </Badge>
        )}
        {!usable && !canDownload && !canSystemDetect && (
          <Badge variant="outline" className="px-2 py-1">
            该引擎由远程服务提供，无法本地安装
          </Badge>
        )}
        {status.path && (
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 text-xs"
            onClick={() => void revealInExplorer(status.path ?? "")}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            打开位置
          </Button>
        )}
      </div>
    </div>
  );
}
