import { AnimatePresence, motion } from "framer-motion";
import { ListChecks } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatPercent } from "@/lib/format";
import { useCancelJob, useJobsSnapshot, sortJobsForDisplay } from "@/hooks/use-jobs";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui-store";

/**
 * 顶栏常驻的任务状态胶囊。
 *
 * - 有活动任务时：环形进度 + 数量（用 SVG 画环，避免为一个圆环引图表库）；
 * - 没有活动任务时：显示"空闲"，仍然可点开抽屉看历史；
 * - 点击 → 打开任务抽屉（`ui-store.jobsDrawerOpen`）。
 */
export function JobsStatusPill({ className }: { className?: string }) {
  const snapshot = useJobsSnapshot();
  const setDrawerOpen = useUiStore((s) => s.setJobsDrawerOpen);
  const cancelJob = useCancelJob();

  const activeById = snapshot.running.length > 0 ? snapshot.running : snapshot.jobs.filter((j) => j.status === "queued").map((j) => j.id);
  const activeJobs = React.useMemo(
    () => sortJobsForDisplay(snapshot.jobs.filter((j) => j.status === "running" || j.status === "queued")),
    [snapshot.jobs],
  );

  // 环形进度 = 所有活动任务的平均进度（不确定时按 0 计，环上会出现"转圈"感）
  const ratio = React.useMemo(() => {
    if (activeJobs.length === 0) return 0;
    const sum = activeJobs.reduce((acc, j) => acc + (j.progress.value ?? 0), 0);
    return sum / activeJobs.length;
  }, [activeJobs]);

  const activeCount = snapshot.activeCount || activeJobs.length;
  const hasActive = activeCount > 0;
  const current = activeJobs[0];

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-2 px-2"
            aria-label={hasActive ? `有 ${activeCount} 个任务进行中，打开任务抽屉` : "打开任务抽屉"}
            onClick={() => setDrawerOpen(true)}
          >
            <RadialProgress value={hasActive ? ratio : 1} active={hasActive} />
            <span className="tabular text-xs">
              {hasActive ? `${activeCount} 个任务` : "空闲"}
            </span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {hasActive && current
            ? `${current.title} · ${current.progress.stage || "进行中"} · ${formatPercent(current.progress.value ?? null)}`
            : "当前没有活动任务，点击查看历史"}
        </TooltipContent>
      </Tooltip>

      <AnimatePresence>
        {hasActive && current && (
          <motion.div
            initial={{ opacity: 0, width: 0 }}
            animate={{ opacity: 1, width: "auto" }}
            exit={{ opacity: 0, width: 0 }}
            className="hidden items-center gap-1 overflow-hidden lg:flex"
          >
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`取消任务 ${current.title}`}
              onClick={() => cancelJob.mutate(current.id)}
            >
              <span className="text-xs">取消</span>
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      <Button asChild size="icon-sm" variant="ghost" aria-label="打开任务中心">
        <Link to="/jobs">
          <ListChecks className="h-4 w-4" />
        </Link>
      </Button>

      {/* 活动任务 id 列表保留在 DOM 里便于测试与调试（不可见） */}
      <span className="sr-only" data-active-jobs={activeById.join(",")} />
    </div>
  );
}

/** 环形进度：不确定时画一圈旋转的虚线弧 */
function RadialProgress({ value, active }: { value: number; active: boolean }) {
  const size = 18;
  const stroke = 2.5;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(1, value));

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      className={cn(active && "animate-spin [animation-duration:3s]")}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="hsl(var(--border))"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="hsl(var(--primary))"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - (active ? clamped : 1))}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

/** 抽屉里每个任务的一行（紧凑） */
export function JobsDrawerRow({
  title,
  stage,
  value,
  status,
  jobId,
}: {
  title: string;
  stage: string;
  value?: number;
  status: string;
  jobId: string;
}) {
  return (
    <div className="space-y-1 rounded-md border border-border/50 p-2.5">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="truncate font-medium">{title}</span>
        <span className="shrink-0 text-muted-foreground">{status}</span>
      </div>
      <Progress value={value ?? null} indeterminate={value === undefined} className="h-1" />
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="truncate">{stage}</span>
        <span className="tabular">{jobId.slice(0, 12)}</span>
      </div>
    </div>
  );
}
