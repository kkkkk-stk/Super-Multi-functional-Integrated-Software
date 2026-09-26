/**
 * 事件桥：订阅 `toolforge://event` 并按 `type` 分发。
 *
 * ## 分发原则（与 stores/README.md 呼应）
 *
 * 事件是**缓存更新信号**，不是数据源：
 *
 * - 任务相关 → `queryClient.setQueryData` 精确补丁 `["jobs"]` 与 `["job", id]`；
 * - 插件相关 → `invalidateQueries`（插件列表派生字段多，重拉更省心，次数也少）；
 * - 引擎状态 → 精确补丁 `["engines"]`；
 * - `securityAlert` → 红色 toast + 全局告警弹窗（`ui-store`）；
 * - `toast` → sonner；
 * - `aiDelta` / `aiDone` → `ui-store.aiStream`（流式缓冲，见 stores/README 例外 2）。
 *
 * ## 字段名兼容
 *
 * 事件载荷的字段名是 **camelCase**（后端给 `AppEvent` 加了
 * `rename_all_fields = "camelCase"`，见 `events.rs:20`）：`jobId` / `errorMessage` /
 * `engineId` / `speedBps` / `requestId` / `pluginId`。
 *
 * 这里仍然用 `read()` **同时读两种写法**：这个属性是后端后来才补上的
 * （`job.rs` 与 `events.rs` 的注释里都专门强调了它），万一被去掉，
 * 事件分发不至于整体失灵 —— 代价只是一次多余的对象取值。
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { toast } from "sonner";

import {
  appendJobLog,
  appendSingleJobLog,
  patchJobFinished,
  patchJobProgress,
  patchSingleJobProgress,
  upsertJob,
} from "@/lib/job-cache";
import { queryClient, queryKeys } from "@/lib/query-client";
import { isTauriRuntime } from "@/lib/system";
import { useUiStore } from "@/stores/ui-store";
import {
  EVENT_CHANNEL,
  type AppEvent,
  type EngineEntry,
  type Job,
  type JobLogEntry,
  type JobProgress,
  type JobStatus,
  type JobsSnapshot,
} from "@/types/domain";

type RawEvent = Record<string, unknown>;

/** 同时读 camelCase（当前）与 snake_case（历史形态）两种键名 */
function read<T>(event: AppEvent, camelKey: string, snakeKey: string): T | undefined {
  const raw = event as unknown as RawEvent;
  const value = raw[camelKey] ?? raw[snakeKey];
  return value === null ? undefined : (value as T | undefined);
}

function toastForLevel(level: string, title: string, message?: string) {
  switch (level) {
    case "error":
    case "critical":
      toast.error(title, { description: message });
      break;
    case "warn":
    case "warning":
      toast.warning(title, { description: message });
      break;
    case "success":
      toast.success(title, { description: message });
      break;
    default:
      toast.info(title, { description: message });
  }
}

/** 单条事件的处理（导出成纯函数，方便测试与复用） */
export function handleAppEvent(event: AppEvent): void {
  const ui = useUiStore.getState();

  switch (event.type) {
    // ---------------------------------------------------------------- 任务
    case "jobUpdated": {
      const job = event.job;
      queryClient.setQueryData<JobsSnapshot>(queryKeys.jobs, (prev) => upsertJob(prev, job));
      queryClient.setQueryData<Job | null>(queryKeys.job(job.id), job);
      break;
    }

    case "jobProgressHint": {
      const jobId = read<string>(event, "jobId", "job_id");
      const progress = read<JobProgress>(event, "progress", "progress");
      if (!jobId || !progress) break;
      queryClient.setQueryData<JobsSnapshot>(queryKeys.jobs, (prev) =>
        patchJobProgress(prev, jobId, progress),
      );
      queryClient.setQueryData<Job | null>(queryKeys.job(jobId), (prev) =>
        patchSingleJobProgress(prev, progress),
      );
      break;
    }

    case "jobLog": {
      const jobId = read<string>(event, "jobId", "job_id");
      const entry = read<JobLogEntry>(event, "entry", "entry");
      if (!jobId || !entry) break;
      queryClient.setQueryData<JobsSnapshot>(queryKeys.jobs, (prev) =>
        appendJobLog(prev, jobId, entry),
      );
      queryClient.setQueryData<Job | null>(queryKeys.job(jobId), (prev) =>
        appendSingleJobLog(prev, entry),
      );
      break;
    }

    case "jobFinished": {
      const jobId = read<string>(event, "jobId", "job_id");
      const status = read<JobStatus>(event, "status", "status");
      const title = read<string>(event, "title", "title") ?? "任务";
      const errorMessage = read<string>(event, "errorMessage", "error_message");
      if (!jobId || !status) break;

      queryClient.setQueryData<JobsSnapshot>(queryKeys.jobs, (prev) =>
        patchJobFinished(prev, jobId, status, errorMessage),
      );
      queryClient.setQueryData<Job | null>(queryKeys.job(jobId), (prev) =>
        prev
          ? {
              ...prev,
              status,
              finishedAt: new Date().toISOString(),
              error:
                status === "failed" && errorMessage
                  ? prev.error ?? { code: "INTERNAL", message: errorMessage }
                  : prev.error,
            }
          : prev,
      );

      // 终结事件是**对账时机**：进度事件可能因为通道拥塞被丢过，这里重拉一次
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobs });
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobStats });

      // 引擎安装 / 插件运行结束后，相关列表的派生字段必然变了
      const snapshot = queryClient.getQueryData<JobsSnapshot>(queryKeys.jobs);
      const kind = snapshot?.jobs.find((j) => j.id === jobId)?.kind;
      if (kind?.kind === "engineInstall") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.engines });
        void queryClient.invalidateQueries({ queryKey: queryKeys.nodes });
      }
      if (kind?.kind === "pluginRun") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.plugins });
      }

      switch (status) {
        case "succeeded":
          toast.success(`${title} 已完成`);
          break;
        case "failed":
          toast.error(`${title} 失败`, { description: errorMessage });
          break;
        case "cancelled":
          toast.info(`${title} 已取消`);
          break;
        default:
          break;
      }
      break;
    }

    // ---------------------------------------------------------------- 引擎
    case "engineStatusChanged": {
      const status = event.status;
      queryClient.setQueryData<EngineEntry[]>(queryKeys.engines, (prev) =>
        prev?.map((entry) => (entry.descriptor.id === status.id ? { ...entry, status } : entry)),
      );
      queryClient.setQueryData(queryKeys.engine(status.id), status);
      // 节点可用性依赖引擎，跟着刷新
      void queryClient.invalidateQueries({ queryKey: queryKeys.nodes });
      useUiStore.getState().clearEngineDownload(status.id);
      break;
    }

    case "engineDownloadProgress": {
      const engineId = read<string>(event, "engineId", "engine_id");
      if (!engineId) break;
      const downloaded = read<number>(event, "downloaded", "downloaded") ?? 0;
      const total = read<number>(event, "total", "total") ?? 0;
      const speedBps = read<number>(event, "speedBps", "speed_bps") ?? 0;
      // 下载速率只有增量事件、没有权威快照 → 放瞬时 store（README 例外 1）
      ui.setEngineDownload(engineId, {
        downloaded,
        total,
        speedBps,
        updatedAt: Date.now(),
      });
      break;
    }

    // ---------------------------------------------------------------- 插件
    case "pluginChanged": {
      const pluginId = read<string>(event, "pluginId", "plugin_id");
      void queryClient.invalidateQueries({ queryKey: queryKeys.plugins });
      if (pluginId) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.plugin(pluginId) });
      }
      break;
    }

    case "pluginLog": {
      const pluginId = read<string>(event, "pluginId", "plugin_id") ?? "";
      const level = read<string>(event, "level", "level") ?? "info";
      const message = read<string>(event, "message", "message") ?? "";
      // 插件日志量大，只有 warn/error 才弹（info/debug 已经在任务日志里了）
      if (level === "warn" || level === "error") {
        toastForLevel(level, `插件 ${pluginId}`, message);
      }
      break;
    }

    // ---------------------------------------------------------------- 安全
    case "securityAlert": {
      const severity = event.severity;
      const title = event.title;
      const detail = event.detail;
      const subject = read<string>(event, "subject", "subject");

      toast.error(title, {
        description: detail,
        duration: 12_000,
        style: {
          borderColor: "hsl(var(--risk-critical))",
          background: "hsl(var(--risk-critical) / 0.12)",
        },
      });
      // 高危的还给一个必须手动关掉的弹窗，避免用户错过
      if (severity === "critical" || severity === "high") {
        ui.pushSecurityAlert({
          severity,
          title,
          detail,
          subject,
          at: new Date().toISOString(),
        });
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.plugins });
      break;
    }

    // ---------------------------------------------------------------- AI 流
    case "aiDelta": {
      const requestId = read<string>(event, "requestId", "request_id") ?? "";
      const delta = event.delta;
      if (!requestId) break;
      const stream = useUiStore.getState().aiStream;
      if (stream.requestId !== requestId) useUiStore.getState().startAiStream(requestId);
      useUiStore.getState().appendAiDelta(requestId, delta);
      break;
    }

    case "aiDone": {
      const error = read<string>(event, "error", "error");
      useUiStore.getState().endAiStream();
      if (error) toast.error("AI 生成失败", { description: error });
      break;
    }

    // ---------------------------------------------------------------- 通用
    case "toast": {
      const message = read<string>(event, "message", "message");
      toastForLevel(event.level, event.title, message);
      break;
    }

    default: {
      // 后端若新增事件类型，先在前端静默忽略（而不是崩），
      // 但要留下痕迹，方便开发期发现契约漂移。
      const unknown = event as { type?: string };
      // eslint-disable-next-line no-console
      console.warn("[toolforge] 收到未知事件类型：", unknown.type);
    }
  }
}

/**
 * 挂载事件桥。**在 App 根组件里调用一次**（React 18 的 StrictMode 会双跑
 * effect，所以必须返回清理函数取消订阅，否则会收到两份事件）。
 */
export function useEventBridge(): void {
  useEffect(() => {
    if (!isTauriRuntime()) {
      // 浏览器 dev 模式：没有 Tauri 事件总线，静默跳过
      return;
    }

    let unlisten: UnlistenFn | undefined;
    let disposed = false;

    listen<AppEvent>(EVENT_CHANNEL, (e) => {
      try {
        handleAppEvent(e.payload);
      } catch (err) {
        // 单个事件处理失败不能打断整条订阅链
        // eslint-disable-next-line no-console
        console.error("[toolforge] 事件处理失败：", err, e.payload);
      }
    })
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error("[toolforge] 订阅事件失败：", err);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
