/**
 * 引擎目录 / 探测 / 安装。
 *
 * 引擎状态的两条更新路径：
 * 1. **事件**（`engineStatusChanged`）—— 探测或安装完成时后端主动推，精确补丁缓存；
 * 2. **命令**（`engines_probe` / `engines_probe_all`）—— 用户手动点"重新探测"。
 *
 * 下载进度**不进缓存**（后端没有快照，只有 `engineDownloadProgress` 增量事件），
 * 统一放 `ui-store.engineDownloads`。
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  enginesCatalog,
  enginesInstall,
  enginesProbe,
  enginesProbeAll,
  modelsInstall,
  modelsList,
  modelsRemove,
  toToolforgeError,
} from "@/lib/ipc";
import { queryKeys } from "@/lib/query-client";
import { useUiStore } from "@/stores/ui-store";
import type {
  EngineEntry,
  EngineInstallRequest,
  EngineStatus,
  Job,
  ModelInstallRequest,
} from "@/types/domain";

export function useEngines() {
  return useQuery({
    queryKey: queryKeys.engines,
    queryFn: () => enginesCatalog(),
    // 引擎探测会调用外部进程，默认不做自动轮询；节点目录页有手动刷新
    staleTime: 60_000,
  });
}

/** 重新探测全部引擎（会依次调用各引擎的 --version，可能需要几秒） */
export function useProbeAllEngines() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => enginesProbeAll(),
    onSuccess: (entries: EngineEntry[]) => {
      client.setQueryData(queryKeys.engines, entries);
      void client.invalidateQueries({ queryKey: queryKeys.nodes });
      const ready = entries.filter(
        (e) => e.status.state === "detected" || e.status.state === "installed",
      ).length;
      toast.success(`探测完成：${ready}/${entries.length} 个引擎可用`);
    },
    onError: (e) => toast.error("引擎探测失败", { description: toToolforgeError(e).message }),
  });
}

/** 单点探测（引擎卡片上的刷新按钮） */
export function useProbeEngine() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (engineId: string) => enginesProbe(engineId),
    onSuccess: (status: EngineStatus) => {
      client.setQueryData(queryKeys.engine(status.id), status);
      client.setQueryData<EngineEntry[]>(queryKeys.engines, (prev) =>
        prev?.map((e) => (e.descriptor.id === status.id ? { ...e, status } : e)),
      );
      void client.invalidateQueries({ queryKey: queryKeys.nodes });
      toast.info(`${status.id}：${stateLabel(status.state)}`);
    },
    onError: (e) => toast.error("探测失败", { description: toToolforgeError(e).message }),
  });
}

/**
 * 安装引擎。
 *
 * 后端**不会**在命令里等到下载完成 —— 它创建一个任务并立刻返回 jobId，
 * 之后靠事件回流进度。所以这里 onSuccess 只做两件事：
 * 提示用户去任务中心看进度、把任务塞进缓存让状态栏立刻有反馈。
 */
export function useInstallEngine() {
  const client = useQueryClient();
  const setEngineDownload = useUiStore((s) => s.setEngineDownload);

  return useMutation({
    mutationFn: (req: EngineInstallRequest) => enginesInstall(req),
    onSuccess: (_jobId: string, req: EngineInstallRequest) => {
      // 让下载进度条立刻出现（total 未知时先画不确定进度）
      setEngineDownload(req.engineId, {
        downloaded: 0,
        total: 0,
        speedBps: 0,
        updatedAt: Date.now(),
      });
      toast.success(`${req.engineId} 已开始安装`, {
        description: "下载进度会在引擎卡片与任务中心实时显示。",
      });
      // 后端会立刻发 jobUpdated 事件，这里主动拉一次保证状态栏马上有数
      void client.invalidateQueries({ queryKey: queryKeys.jobs });
      void client.invalidateQueries({ queryKey: queryKeys.jobStats });
    },
    onError: (e) => {
      const err = toToolforgeError(e);
      toast.error("安装失败", {
        description: err.fullText,
        duration: 10_000,
      });
    },
  });
}

export function stateLabel(state: EngineStatus["state"]): string {
  switch (state) {
    case "missing":
      return "未安装";
    case "detected":
      return "已检测到系统安装";
    case "installed":
      return "已安装（应用管理）";
    case "installing":
      return "安装中";
    case "failed":
      return "安装失败";
    case "outdated":
      return "版本过旧";
    case "unsupported":
      return "当前平台不支持";
    default:
      return "未知状态";
  }
}

export function isEngineUsable(state: EngineStatus["state"]): boolean {
  return state === "detected" || state === "installed";
}

/** 任务列表里正在跑的引擎安装任务（引擎卡片上显示"安装中"并给跳转） */
export function findEngineInstallJob(jobs: Job[], engineId: string): Job | undefined {
  return jobs.find((j) => j.kind.kind === "engineInstall" && j.kind.engineId === engineId);
}

// ============================================================================
// 模型权重
// ============================================================================

export function useModels() {
  return useQuery({
    queryKey: queryKeys.models,
    queryFn: () => modelsList(),
    // 模型是"下载一次就长期在"的东西，不需要频繁刷新；
    // 下载完成后由下面的 mutation 主动 invalidate。
    staleTime: 60_000,
  });
}

/**
 * 下载模型权重。
 *
 * 与引擎安装一样是**异步任务**：命令立刻返回 jobId，进度走
 * `engineDownloadProgress` 事件（模型与引擎共用同一条下载通道）。
 * 所以这里不能等 mutation 完成再刷新列表 —— 那时候下载还在跑。
 * 真正的刷新时机是 `modelDownload` 任务结束时，由事件层 invalidate。
 */
export function useInstallModel() {
  const client = useQueryClient();
  const setEngineDownload = useUiStore((s) => s.setEngineDownload);

  return useMutation({
    mutationFn: (req: ModelInstallRequest) => modelsInstall(req),
    onSuccess: (_jobId: string, req: ModelInstallRequest) => {
      // 下载进度条按模型 id 单独显示，不与同名引擎冲突（模型 id 与引擎 id 不同名）
      setEngineDownload(req.modelId, {
        downloaded: 0,
        total: 0,
        speedBps: 0,
        updatedAt: Date.now(),
      });
      toast.success("模型已开始下载", {
        description: "进度在模型卡片与任务中心实时显示；完成后卡片会自动变成「已就绪」。",
      });
      void client.invalidateQueries({ queryKey: queryKeys.jobs });
      void client.invalidateQueries({ queryKey: queryKeys.jobStats });
    },
    onError: (e) => {
      const err = toToolforgeError(e);
      toast.error("下载失败", { description: err.fullText, duration: 10_000 });
    },
  });
}

/**
 * 删除已下载的权重。
 *
 * 后端返回 `false` 表示"文件本来就不在"——这在界面上不该被当成错误
 * （用户可能是重复点了两次），所以两种情况都提示成功并刷新。
 */
export function useRemoveModel() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (modelId: string) => modelsRemove(modelId),
    onSuccess: (removed: boolean, modelId: string) => {
      toast.success(removed ? `已删除 ${modelId}` : `${modelId} 本来就没有下载`, {
        description: removed ? "磁盘空间已释放。" : undefined,
      });
      void client.invalidateQueries({ queryKey: queryKeys.models });
      void client.invalidateQueries({ queryKey: queryKeys.engines });
    },
    onError: (e) => toast.error("删除失败", { description: toToolforgeError(e).fullText }),
  });
}
