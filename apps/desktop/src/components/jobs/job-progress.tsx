import { CheckCircle2, Loader2, XCircle } from "lucide-react";

import { Progress } from "@/components/ui/progress";
import { formatEta, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { JobProgress, JobStatus } from "@/types/domain";

/**
 * 任务进度条（含阶段文字、当前项、速率、剩余时间）。
 *
 * 命名成 `JobProgressBar` 而不是 `JobProgress`：避免与领域类型
 * `JobProgress`（types/domain.ts）重名导致 import 混乱。
 */
export interface JobProgressBarProps {
  progress: JobProgress;
  status: JobStatus;
  totalItems?: number;
  completedItems?: number;
  className?: string;
  showEta?: boolean;
}

export function JobProgressBar({
  progress,
  status,
  totalItems = 0,
  completedItems = 0,
  className,
  showEta = true,
}: JobProgressBarProps) {
  const indeterminate = progress.value === undefined || progress.value === null;

  const tone =
    status === "failed"
      ? "text-destructive"
      : status === "succeeded"
        ? "text-success"
        : status === "cancelled"
          ? "text-warning"
          : "text-primary";

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="flex min-w-0 items-center gap-1.5">
          {status === "running" && <Loader2 className={cn("h-3.5 w-3.5 animate-spin", tone)} />}
          {status === "succeeded" && <CheckCircle2 className={cn("h-3.5 w-3.5", tone)} />}
          {status === "failed" && <XCircle className={cn("h-3.5 w-3.5", tone)} />}
          <span className="truncate text-muted-foreground" title={progress.stage}>
            {progress.stage || "—"}
          </span>
        </span>
        <span className="shrink-0 tabular text-muted-foreground">
          {totalItems > 1 ? `${completedItems}/${totalItems} · ` : ""}
          {formatPercent(progress.value ?? null)}
        </span>
      </div>

      <Progress
        value={progress.value ?? null}
        indeterminate={indeterminate}
        className="h-1.5"
        indicatorClassName={status === "failed" ? "bg-destructive" : undefined}
      />

      {(progress.currentItem || progress.speed || showEta) && (
        <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
          <span className="truncate" title={progress.currentItem ?? undefined}>
            {progress.currentItem ? `正在处理：${progress.currentItem}` : ""}
          </span>
          <span className="shrink-0">
            {progress.speed ? `${progress.speed}` : ""}
            {progress.speed && showEta && progress.etaSeconds ? " · " : ""}
            {showEta && progress.etaSeconds ? formatEta(progress.etaSeconds) : ""}
          </span>
        </div>
      )}
    </div>
  );
}
