/**
 * 任务缓存的补丁函数（纯函数，无 React、无 IPC）。
 *
 * 单独一层的理由：**事件到达时要更新的地方有两处** —— `["jobs"]` 快照与
 * `["job", id]` 单条。两处逻辑必须是同一份，否则会出现"抽屉里的进度条动了、
 * 列表里的没动"这种典型不一致。这里集中实现，`use-events.ts` 与 `use-jobs.ts`
 * 都复用。
 */

import type { Job, JobLogEntry, JobProgress, JobStatus, JobsSnapshot } from "@/types/domain";

/** 后端 `Job::LOG_TAIL_LIMIT`：内存里只保留尾部 2000 行 */
export const LOG_TAIL_LIMIT = 2000;

export function findJob(snapshot: JobsSnapshot | undefined, jobId: string): Job | undefined {
  return snapshot?.jobs.find((j) => j.id === jobId);
}

/** 插入或整条替换（`jobUpdated` 事件 / 取消后返回的 Job） */
export function upsertJob(
  snapshot: JobsSnapshot | undefined,
  job: Job,
): JobsSnapshot | undefined {
  if (!snapshot) return snapshot;
  const idx = snapshot.jobs.findIndex((j) => j.id === job.id);
  const jobs = idx >= 0 ? snapshot.jobs.map((j) => (j.id === job.id ? job : j)) : [job, ...snapshot.jobs];
  return recomputeCounts({ ...snapshot, jobs });
}

/** 只更新进度（`jobProgressHint`，高频事件，不重推整条 Job） */
export function patchJobProgress(
  snapshot: JobsSnapshot | undefined,
  jobId: string,
  progress: JobProgress,
): JobsSnapshot | undefined {
  if (!snapshot) return snapshot;
  if (!snapshot.jobs.some((j) => j.id === jobId)) return snapshot;
  return {
    ...snapshot,
    jobs: snapshot.jobs.map((j) => (j.id === jobId ? { ...j, progress } : j)),
  };
}

/** 追加一行日志（`jobLog`），并裁到尾部上限 */
export function appendJobLog(
  snapshot: JobsSnapshot | undefined,
  jobId: string,
  entry: JobLogEntry,
): JobsSnapshot | undefined {
  if (!snapshot) return snapshot;
  if (!snapshot.jobs.some((j) => j.id === jobId)) return snapshot;
  return {
    ...snapshot,
    jobs: snapshot.jobs.map((j) => {
      if (j.id !== jobId) return j;
      const logs = [...j.logs, entry];
      const trimmed = logs.length > LOG_TAIL_LIMIT ? logs.slice(logs.length - LOG_TAIL_LIMIT) : logs;
      return { ...j, logs: trimmed };
    }),
  };
}

/** 终结状态（`jobFinished`） */
export function patchJobFinished(
  snapshot: JobsSnapshot | undefined,
  jobId: string,
  status: JobStatus,
  errorMessage?: string,
): JobsSnapshot | undefined {
  if (!snapshot) return snapshot;
  if (!snapshot.jobs.some((j) => j.id === jobId)) return snapshot;
  const finishedAt = new Date().toISOString();
  return recomputeCounts({
    ...snapshot,
    jobs: snapshot.jobs.map((j) =>
      j.id === jobId
        ? {
            ...j,
            status,
            finishedAt,
            progress:
              status === "succeeded"
                ? { ...j.progress, value: 1 }
                : j.progress,
            error:
              status === "failed" && errorMessage
                ? j.error ?? { code: "INTERNAL", message: errorMessage }
                : j.error,
          }
        : j,
    ),
  });
}

/** 单条 Job 的进度补丁（`["job", id]` 缓存） */
export function patchSingleJobProgress(
  job: Job | null | undefined,
  progress: JobProgress,
): Job | null | undefined {
  if (!job) return job;
  return { ...job, progress };
}

export function appendSingleJobLog(
  job: Job | null | undefined,
  entry: JobLogEntry,
): Job | null | undefined {
  if (!job) return job;
  const logs = [...job.logs, entry];
  return {
    ...job,
    logs: logs.length > LOG_TAIL_LIMIT ? logs.slice(logs.length - LOG_TAIL_LIMIT) : logs,
  };
}

/** 重算派生字段（activeCount / running），保证状态栏与筛选不会读到旧值 */
function recomputeCounts(snapshot: JobsSnapshot): JobsSnapshot {
  const active = snapshot.jobs.filter((j) => j.status === "queued" || j.status === "running");
  return {
    ...snapshot,
    activeCount: active.length,
    running: snapshot.jobs.filter((j) => j.status === "running").map((j) => j.id),
  };
}
