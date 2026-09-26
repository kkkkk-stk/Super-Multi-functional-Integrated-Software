import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, ArrowUpRight, Ban, CheckCircle2, Clock, Loader2, XCircle } from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { formatElapsed, formatPercent, formatRelative } from "@/lib/format";
import { revealInExplorer } from "@/lib/system";
import { cn } from "@/lib/utils";
import type { Job, JobKind, JobStatus } from "@/types/domain";

export function jobStatusLabel(status: JobStatus): string {
  switch (status) {
    case "queued":
      return "排队中";
    case "running":
      return "进行中";
    case "succeeded":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    default:
      return "未知";
  }
}

/** 任务类别 → 人类可读标签（`JobKind` 的载荷字段是 camelCase，见 types/domain.ts） */
export function jobKindLabel(kind: JobKind): string {
  switch (kind.kind) {
    case "convert":
      return "格式转换";
    case "batchRename":
      return "批量重命名";
    case "pluginRun":
      return "插件运行";
    case "pipelineRun":
      return `流水线 · ${kind.name}`;
    case "engineInstall":
      return `引擎安装 · ${kind.engineId}`;
    case "modelDownload":
      return `模型下载 · ${kind.modelId}`;
    case "aiGenerate":
      return `AI 生成 · ${kind.provider}`;
    case "probe":
      return "媒体探测";
    case "other":
      return kind.label;
    default:
      return "任务";
  }
}

const STATUS_VARIANT: Record<JobStatus, "default" | "success" | "destructive" | "secondary" | "warning"> = {
  queued: "secondary",
  running: "default",
  succeeded: "success",
  failed: "destructive",
  cancelled: "warning",
};

/** 状态图标：进行中脉冲、完成勾选弹入、失败抖动 */
function StatusGlyph({ status }: { status: JobStatus }) {
  return (
    <span className="relative inline-flex h-5 w-5 items-center justify-center">
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={status}
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.6, opacity: 0 }}
          transition={{ type: "spring", stiffness: 420, damping: 26 }}
          className="inline-flex"
        >
          {status === "running" && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
          {status === "queued" && <Clock className="h-4 w-4 text-muted-foreground" />}
          {status === "succeeded" && <CheckCircle2 className="h-4 w-4 text-success" />}
          {status === "failed" && <XCircle className="h-4 w-4 text-destructive" />}
          {status === "cancelled" && <Ban className="h-4 w-4 text-warning" />}
        </motion.span>
      </AnimatePresence>
      {status === "running" && (
        <span className="pointer-events-none absolute inset-0 rounded-full border border-primary/60 animate-pulse-ring" />
      )}
    </span>
  );
}

export interface JobCardProps {
  job: Job;
  selected?: boolean;
  onSelect?: (jobId: string) => void;
  onCancel?: (jobId: string) => void;
  onShowLogs?: (jobId: string) => void;
  compact?: boolean;
  /**
   * 列表行模式（虚拟滚动用）：内容严格控制在固定行高内 ——
   * 错误只留一行、隐藏"查看日志"按钮。**不要在非虚拟列表里用它**，
   * 那会丢掉用户需要的信息。
   */
  dense?: boolean;
}

export const JobCard = React.forwardRef<HTMLDivElement, JobCardProps>(
  ({ job, selected, onSelect, onCancel, onShowLogs, compact = false, dense = false }, ref) => {
    const isActive = job.status === "running" || job.status === "queued";
    const isFailed = job.status === "failed";

    return (
      <motion.div
        ref={ref}
        layout="position"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        // 失败时抖一下再看清楚红边（一次性动画）
        className={cn(
          "group relative flex flex-col gap-2 rounded-lg border bg-card/60 p-3 text-left transition-colors",
          selected ? "border-primary/60 bg-primary/5" : "border-border/60 hover:border-border",
          isFailed && "animate-shake border-destructive/60 bg-destructive/5",
        )}
        onClick={() => onSelect?.(job.id)}
        data-job-id={job.id}
      >
        <div className="flex items-start gap-2.5">
          <StatusGlyph status={job.status} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium" title={job.title}>
                {job.title}
              </span>
              <Badge variant={STATUS_VARIANT[job.status]}>{jobStatusLabel(job.status)}</Badge>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              <span>{jobKindLabel(job.kind)}</span>
              <span aria-hidden="true">·</span>
              <span className="tabular">{job.id.slice(0, 14)}</span>
              <span aria-hidden="true">·</span>
              <span>{formatRelative(job.createdAt)}</span>
              {(job.status === "running" || job.status === "succeeded" || job.status === "failed") && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>耗时 {formatElapsed(job.startedAt ?? job.createdAt, job.finishedAt)}</span>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            {isActive && onCancel && (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`取消任务 ${job.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onCancel(job.id);
                }}
              >
                <Ban className="h-3.5 w-3.5" />
              </Button>
            )}
            {job.outputs.length > 0 && (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="在文件管理器中显示产出"
                onClick={(e) => {
                  e.stopPropagation();
                  void revealInExplorer(job.outputs[0] ?? "");
                }}
              >
                <ArrowUpRight className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>

        {!compact && (
          <div className="space-y-1.5">
            <Progress
              value={job.progress.value ?? null}
              indeterminate={job.progress.value === undefined || job.progress.value === null}
              className="h-1.5"
              indicatorClassName={isFailed ? "bg-destructive" : undefined}
            />
            <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
              <span className="truncate" title={job.progress.stage}>
                {job.progress.stage || "—"}
                {job.progress.currentItem ? ` · ${job.progress.currentItem}` : ""}
              </span>
              <span className="shrink-0 tabular">
                {job.totalItems > 1 && `${job.completedItems}/${job.totalItems} · `}
                {formatPercent(job.progress.value ?? null)}
                {job.progress.speed ? ` · ${job.progress.speed}` : ""}
              </span>
            </div>
            {job.failedItems > 0 && !dense && (
              <p className="flex items-center gap-1 text-xs text-destructive">
                <AlertTriangle className="h-3.5 w-3.5" />
                {job.failedItems} 个条目失败
              </p>
            )}
          </div>
        )}

        {job.error && (
          <p
            className={cn(
              "rounded bg-destructive/10 px-2 py-1 text-xs text-destructive",
              dense ? "truncate" : "line-clamp-2",
            )}
            title={job.error.message}
          >
            [{job.error.code}] {job.error.message}
          </p>
        )}

        {onShowLogs && !compact && !dense && (
          <div className="flex items-center justify-end">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={(e) => {
                e.stopPropagation();
                onShowLogs(job.id);
              }}
            >
              查看日志（{job.logs.length}）
            </Button>
          </div>
        )}
      </motion.div>
    );
  },
);
JobCard.displayName = "JobCard";
