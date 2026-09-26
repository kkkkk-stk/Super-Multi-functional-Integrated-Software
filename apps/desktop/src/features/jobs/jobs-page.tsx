import {
  Clock,
  FolderOpen,
  Loader2,
  RotateCcw,
  Search,
  ShieldAlert,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import * as React from "react";

import { jobKindLabel, jobStatusLabel } from "@/components/jobs/job-card";
import { JobList } from "@/components/jobs/job-list";
import { JobLogViewer } from "@/components/jobs/job-log-viewer";
import { JobProgressBar } from "@/components/jobs/job-progress";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  countByStatus,
  EMPTY_LIST_FILTER,
  filterJobs,
  isRetryableKind,
  sortJobsForDisplay,
  useCancelJob,
  useClearFinished,
  useJobsSnapshot,
  useRetryJob,
  type JobListFilter,
} from "@/hooks/use-jobs";
import { formatDateTime, formatElapsed } from "@/lib/format";
import { ERROR_HINTS } from "@/lib/ipc";
import { copyText, revealInExplorer } from "@/lib/system";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui-store";
import type { JobStatus } from "@/types/domain";

const STATUS_FILTERS: { status: JobStatus; label: string }[] = [
  { status: "running", label: "进行中" },
  { status: "queued", label: "排队中" },
  { status: "succeeded", label: "已完成" },
  { status: "failed", label: "失败" },
  { status: "cancelled", label: "已取消" },
];

const KIND_OPTIONS = [
  { value: "", label: "全部类型" },
  { value: "convert", label: "格式转换" },
  { value: "batchRename", label: "批量重命名" },
  { value: "pluginRun", label: "插件运行" },
  { value: "pipelineRun", label: "流水线执行" },
  { value: "engineInstall", label: "引擎安装" },
  { value: "modelDownload", label: "模型下载" },
  { value: "aiGenerate", label: "AI 生成" },
  { value: "probe", label: "媒体探测" },
];

/**
 * 任务中心。
 *
 * 结构：筛选条 + **窗口化列表**（左）+ 选中任务的详情（右）。
 *
 * 详情面板里的日志用 `JobLogViewer`（只渲染尾部 200 行、可按级别与关键词过滤、
 * 自动滚动可暂停），并明确提示"完整日志在应用日志目录"。
 *
 * 状态变更消息来自 `toast`，这里的详情面板只负责"事后回看"：
 * 出了什么问题、产出在哪、错误码是什么、下一步该做什么（`ERROR_HINTS`）。
 */
export function JobsPage() {
  const snapshot = useJobsSnapshot();
  const cancelJob = useCancelJob();
  const retryJob = useRetryJob();
  const clearFinished = useClearFinished();
  const selectedJobId = useUiStore((s) => s.selectedJobId);
  const selectJob = useUiStore((s) => s.selectJob);

  const [filter, setFilter] = React.useState<JobListFilter>(EMPTY_LIST_FILTER);
  const [kindFilter, setKindFilter] = React.useState("");
  const [showLogs, setShowLogs] = React.useState(true);

  const counts = React.useMemo(() => countByStatus(snapshot.jobs), [snapshot.jobs]);

  const visible = React.useMemo(() => {
    const withKind = kindFilter
      ? { ...filter, kinds: [kindFilter] }
      : filter;
    return sortJobsForDisplay(filterJobs(snapshot.jobs, withKind));
  }, [snapshot.jobs, filter, kindFilter]);

  const selected = React.useMemo(
    () => snapshot.jobs.find((j) => j.id === selectedJobId) ?? null,
    [snapshot.jobs, selectedJobId],
  );

  // 选中的任务被清理掉时把选中态一并收起
  React.useEffect(() => {
    if (selectedJobId && !snapshot.jobs.some((j) => j.id === selectedJobId)) {
      selectJob(null);
    }
  }, [snapshot.jobs, selectedJobId, selectJob]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold">任务中心</h1>
        <Badge variant="outline" className="tabular">
          共 {snapshot.jobs.length}
        </Badge>
        {snapshot.activeCount > 0 && (
          <Badge variant="default" className="tabular">
            {snapshot.activeCount} 进行中
          </Badge>
        )}
        <span className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 text-xs"
            disabled={clearFinished.isPending}
            onClick={() => clearFinished.mutate()}
          >
            {clearFinished.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            清理已结束
          </Button>
        </span>
      </header>

      {/* 筛选条 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg border border-border/60 p-0.5">
          {STATUS_FILTERS.map((item) => {
            const active = filter.statuses.includes(item.status);
            const count = counts[item.status];
            return (
              <button
                key={item.status}
                type="button"
                aria-pressed={active}
                onClick={() =>
                  setFilter((prev) => ({
                    ...prev,
                    statuses: active
                      ? prev.statuses.filter((s) => s !== item.status)
                      : [...prev.statuses, item.status],
                  }))
                }
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs transition-colors",
                  active
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {item.label}
                <span className="ml-1 tabular opacity-70">{count}</span>
              </button>
            );
          })}
        </div>

        <Select
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value)}
          aria-label="按任务类型筛选"
          className="h-8 w-36 text-xs"
          options={KIND_OPTIONS}
        />

        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter.search}
            onChange={(e) => setFilter((prev) => ({ ...prev, search: e.target.value }))}
            placeholder="按标题或任务 id 搜索"
            aria-label="搜索任务"
            className="h-8 pl-7 text-xs"
          />
        </div>

        {(filter.statuses.length > 0 || filter.search || kindFilter) && (
          <Button
            size="sm"
            variant="ghost"
            className="h-8 gap-1 text-xs"
            onClick={() => {
              setFilter(EMPTY_LIST_FILTER);
              setKindFilter("");
            }}
          >
            <X className="h-3.5 w-3.5" />
            清除筛选
          </Button>
        )}

        <span className="text-[11px] text-muted-foreground">
          {visible.length} / {snapshot.jobs.length} 条
        </span>
      </div>

      {/* 列表 + 详情 */}
      <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[1fr_1.1fr]">
        <JobList
          jobs={visible}
          selectedId={selectedJobId}
          onSelect={(id) => selectJob(id === selectedJobId ? null : id)}
          onCancel={(id) => cancelJob.mutate(id)}
          emptyHint={
            snapshot.jobs.length === 0
              ? "还没有任务。去「格式转换」或「批量处理」发起一个。"
              : "没有符合当前筛选条件的任务。"
          }
        />

        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto rounded-lg border border-border/60 bg-card/40 p-4 pr-2 scrollbar-thin">
          {!selected ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <Terminal className="h-7 w-7 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">
                从左侧选一个任务，查看它的日志、产出与错误详情
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-sm font-semibold">{selected.title}</h2>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {jobKindLabel(selected.kind)} · {jobStatusLabel(selected.status)} · 创建于{" "}
                    {formatDateTime(selected.createdAt)}
                    {selected.startedAt &&
                      ` · 耗时 ${formatElapsed(selected.startedAt, selected.finishedAt)}`}
                  </p>
                  <button
                    type="button"
                    className="mt-0.5 font-mono text-[10px] text-muted-foreground hover:text-primary"
                    onClick={() => void copyText(selected.id, "已复制任务 id")}
                  >
                    {selected.id}
                  </button>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {(selected.status === "running" || selected.status === "queued") && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => cancelJob.mutate(selected.id)}
                      disabled={cancelJob.isPending}
                    >
                      取消任务
                    </Button>
                  )}
                  {/* 重试只对"可重放"的任务开放（与后端 JobKind::is_retryable() 同口径） */}
                  {(selected.status === "failed" || selected.status === "cancelled") &&
                    isRetryableKind(selected.kind) && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1.5 text-xs"
                        onClick={() => retryJob.mutate(selected.id)}
                        disabled={retryJob.isPending}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        重试
                      </Button>
                    )}
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="收起详情"
                    onClick={() => selectJob(null)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              <JobProgressBar
                progress={selected.progress}
                status={selected.status}
                totalItems={selected.totalItems}
                completedItems={selected.completedItems}
              />

              {selected.error && (
                <div className="rounded-md border border-destructive/60 bg-destructive/[0.07] p-3">
                  <p className="flex items-center gap-1.5 text-xs font-medium text-destructive">
                    <ShieldAlert className="h-3.5 w-3.5" />
                    [{selected.error.code}] {selected.error.message}
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {ERROR_HINTS[selected.error.code] ?? ""}
                  </p>
                  {selected.error.subject && (
                    <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                      对象：{selected.error.subject}
                    </p>
                  )}
                  {selected.error.detail && (
                    <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-2 font-mono text-[10px] text-muted-foreground scrollbar-thin">
                      {selected.error.detail}
                    </pre>
                  )}
                </div>
              )}

              {selected.outputs.length > 0 && (
                <section className="space-y-1.5">
                  <h3 className="text-xs font-medium">产出（{selected.outputs.length}）</h3>
                  <ul className="space-y-1">
                    {selected.outputs.map((path) => (
                      <li key={path} className="flex items-center gap-2 text-[11px]">
                        <span className="min-w-0 flex-1 truncate font-mono" title={path}>
                          {path}
                        </span>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label="在文件管理器中显示"
                          onClick={() => void revealInExplorer(path)}
                        >
                          <FolderOpen className="h-3.5 w-3.5" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <Separator />

              <div className="flex items-center justify-between">
                <h3 className="flex items-center gap-1.5 text-xs font-medium">
                  <Clock className="h-3.5 w-3.5" />
                  日志（{selected.logs.length} 行）
                </h3>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 text-xs"
                  onClick={() => setShowLogs((v) => !v)}
                >
                  {showLogs ? "收起日志" : "展开日志"}
                </Button>
              </div>

              {showLogs && <JobLogViewer logs={selected.logs} height={320} />}

              {/* 单条编辑入口：任务卡片的完整形态（含产出与日志按钮） */}
              {selected.status === "failed" && (
                <p className="text-[11px] text-muted-foreground">
                  提示：引擎安装失败多半是网络或校验值问题；插件运行失败请先看它的日志尾部
                  （stderr 会原样带出来）。
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
