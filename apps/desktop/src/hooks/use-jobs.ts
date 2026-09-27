/**
 * 任务相关的 Query 封装。
 *
 * 设计要点：**缓存里只保留一份完整快照**（`["jobs"]`），过滤与排序全在前端做。
 * 理由：
 * 1. 事件（`jobUpdated` / `jobProgressHint`）要能精确补丁缓存，多个 key 意味着
 *    多处补丁、必然漏一处；
 * 2. 后端 `JobFilter` 只支持 statuses / kinds / search / limit，前端过滤能力等价；
 * 3. 任务数量级是几百到几千，前端过滤毫无压力（列表本身做了窗口化渲染）。
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { upsertJob } from "@/lib/job-cache";
import {
  jobsCancel,
  jobsClearFinished,
  jobsGet,
  jobsList,
  jobsRetry,
  jobsStats,
  toToolforgeError,
} from "@/lib/ipc";
import { queryKeys } from "@/lib/query-client";
import type { Job, JobStats, JobsSnapshot, JobStatus } from "@/types/domain";

const EMPTY_SNAPSHOT: JobsSnapshot = { jobs: [], activeCount: 0, running: [] };

/** 完整任务快照 */
export function useJobs() {
  return useQuery({
    queryKey: queryKeys.jobs,
    queryFn: () => jobsList(),
    // 任务列表变化频繁，但事件已经把增量推过来了；这里只做兜底对账
    staleTime: 5_000,
  });
}

/** 快照（带空值兜底，页面里不用到处写 `?? []`） */
export function useJobsSnapshot(): JobsSnapshot {
  const { data } = useJobs();
  return data ?? EMPTY_SNAPSHOT;
}

/** 单条任务：优先用列表缓存里的那份，缺失时才单独拉 */
export function useJob(jobId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.job(jobId ?? "none"),
    queryFn: async (): Promise<Job | null> => {
      if (!jobId) return null;
      return jobsGet(jobId);
    },
    enabled: Boolean(jobId),
    staleTime: 2_000,
  });
}

export function useJobStats() {
  return useQuery({
    queryKey: queryKeys.jobStats,
    queryFn: () => jobsStats(),
    staleTime: 5_000,
  });
}

export function useCancelJob() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => jobsCancel(jobId),
    onSuccess: (job: Job) => {
      client.setQueryData<JobsSnapshot>(queryKeys.jobs, (prev) => upsertJob(prev, job));
      client.setQueryData(queryKeys.job(job.id), job);
      void client.invalidateQueries({ queryKey: queryKeys.jobStats });
      toast.info(`已请求取消「${job.title}」`);
    },
    onError: (e) => toast.error("取消失败", { description: toToolforgeError(e).message }),
  });
}

/**
 * 重试任务。
 *
 * 后端只对**注册过重放闭包**的任务放行（插件运行可以；引擎安装与 AI 生成不行，
 * 因为会重复下载 / 重复计费）。`JobKind` 上也有 `is_retryable()` 的同口径判断，
 * UI 用 `isRetryableKind()` 决定要不要显示按钮，真正的裁决仍然在后端。
 *
 * ⚠️ **返回值是「新任务」的 id，不是传进去的那个**：重放会重新提交一次，
 * 拿到的是一个新任务。两个 id 都要失效缓存 —— 旧的在列表里要变成"已取消"，
 * 新的那张卡片要被拉进来。
 */
export function useRetryJob() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => jobsRetry(jobId).then((newId) => ({ oldId: jobId, newId })),
    onSuccess: ({ oldId, newId }: { oldId: string; newId: string }) => {
      void client.invalidateQueries({ queryKey: queryKeys.jobs });
      void client.invalidateQueries({ queryKey: queryKeys.job(oldId) });
      void client.invalidateQueries({ queryKey: queryKeys.job(newId) });
      void client.invalidateQueries({ queryKey: queryKeys.jobStats });
      toast.success("已重新入队");
    },
    onError: (e) =>
      toast.error("重试失败", {
        description: toToolforgeError(e).fullText,
      }),
  });
}

/** 与后端 `JobKind::is_retryable()` 同口径：这两类不允许重放 */
export function isRetryableKind(kind: Job["kind"]): boolean {
  return kind.kind !== "aiGenerate" && kind.kind !== "engineInstall";
}

export function useClearFinished() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => jobsClearFinished(),
    onSuccess: (count: number) => {
      void client.invalidateQueries({ queryKey: queryKeys.jobs });
      void client.invalidateQueries({ queryKey: queryKeys.jobStats });
      toast.success(count > 0 ? `已清理 ${count} 个已结束任务` : "没有可清理的任务");
    },
    onError: (e) => toast.error("清理失败", { description: toToolforgeError(e).message }),
  });
}

// ============================================================================
// 前端过滤 / 分组（纯函数，页面直接用）
// ============================================================================

export interface JobListFilter {
  statuses: JobStatus[];
  kinds: string[];
  search: string;
}

export const EMPTY_LIST_FILTER: JobListFilter = { statuses: [], kinds: [], search: "" };

export function filterJobs(jobs: Job[], filter: JobListFilter): Job[] {
  const needle = filter.search.trim().toLowerCase();
  return jobs.filter((job) => {
    if (filter.statuses.length > 0 && !filter.statuses.includes(job.status)) return false;
    if (filter.kinds.length > 0 && !filter.kinds.includes(job.kind.kind)) return false;
    if (needle) {
      const hay = `${job.title} ${job.id} ${job.kind.kind}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

export const JOB_STATUS_ORDER: JobStatus[] = [
  "running",
  "queued",
  "succeeded",
  "failed",
  "cancelled",
];

export function sortJobsForDisplay(jobs: Job[]): Job[] {
  return [...jobs].sort((a, b) => {
    const sa = JOB_STATUS_ORDER.indexOf(a.status);
    const sb = JOB_STATUS_ORDER.indexOf(b.status);
    if (sa !== sb) return sa - sb;
    // 同状态下新的在前
    return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
  });
}

/** 各状态计数（任务中心顶部的筛选徽章用） */
export function countByStatus(jobs: Job[]): Record<JobStatus, number> {
  const out: Record<JobStatus, number> = {
    queued: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const j of jobs) out[j.status] += 1;
  return out;
}

/** 任务统计（后端命令的直接包装，缺失时按列表本地算） */
export function statsFromJobs(jobs: Job[]): JobStats {
  const byStatus: Record<string, number> = {};
  let succeeded = 0;
  let failed = 0;
  for (const j of jobs) {
    byStatus[j.status] = (byStatus[j.status] ?? 0) + 1;
    if (j.status === "succeeded") succeeded += 1;
    if (j.status === "failed") failed += 1;
  }
  return { byStatus, total: jobs.length, succeeded, failed };
}
