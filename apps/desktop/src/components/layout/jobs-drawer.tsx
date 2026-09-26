import { ExternalLink, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";

import { JobCard } from "@/components/jobs/job-card";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useCancelJob, useClearFinished, useJobsSnapshot, sortJobsForDisplay } from "@/hooks/use-jobs";
import { useUiStore } from "@/stores/ui-store";

/**
 * 顶栏任务胶囊点开后弹出的抽屉。
 *
 * 只显示最近的一批任务（默认 30 条）—— 完整历史在任务中心，
 * 那里有筛选、虚拟滚动与日志面板。抽屉的定位是"瞥一眼，不用离开当前页面"。
 */
export function JobsDrawer() {
  const open = useUiStore((s) => s.jobsDrawerOpen);
  const setOpen = useUiStore((s) => s.setJobsDrawerOpen);
  const selectJob = useUiStore((s) => s.selectJob);
  const snapshot = useJobsSnapshot();
  const cancelJob = useCancelJob();
  const clearFinished = useClearFinished();

  const jobs = sortJobsForDisplay(snapshot.jobs).slice(0, 30);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            任务
            <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs text-primary tabular">
              {snapshot.activeCount} 进行中
            </span>
          </SheetTitle>
          <SheetDescription>
            进度由后端事件实时推送；完成后可在这里直接打开产出文件。
          </SheetDescription>
        </SheetHeader>

        <div className="flex items-center justify-between gap-2 px-5 py-3">
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 text-xs"
            onClick={() => clearFinished.mutate()}
            disabled={clearFinished.isPending}
          >
            <Trash2 className="h-3.5 w-3.5" />
            清理已结束
          </Button>
          <Button asChild size="sm" variant="ghost" className="h-7 gap-1.5 text-xs">
            <Link to="/jobs" onClick={() => setOpen(false)}>
              <ExternalLink className="h-3.5 w-3.5" />
              打开任务中心
            </Link>
          </Button>
        </div>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-5 pb-5 scrollbar-thin">
          {jobs.length === 0 ? (
            <p className="py-16 text-center text-sm text-muted-foreground">
              当前没有任务记录。发起一次转换或安装一个引擎就会出现在这里。
            </p>
          ) : (
            jobs.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                onCancel={(id) => cancelJob.mutate(id)}
                onSelect={(id) => {
                  selectJob(id);
                  setOpen(false);
                }}
              />
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
