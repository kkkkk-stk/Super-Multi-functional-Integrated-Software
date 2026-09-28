/**
 * 插件市场 / 详情 / 授权 / 运行。
 *
 * 安全相关的三条纪律（对应 `plugins_*` 命令的硬门）：
 *
 * 1. **安装 ≠ 可用**：`plugins_install` 之后插件仍处于"未启用 + 零授权"状态，
 *    必须再走 `plugins_grant`（逐条授权）与 `plugins_set_enabled`。
 *    UI 上把这三步拆成三个不同的动作，就是为了让"看权限"和"用它"分开。
 * 2. `permissionsAcknowledged` 必须为 true，L3 Python 还要
 *    `executableCodeAcknowledged` —— 这两个开关**只有用户在权限面板里逐条看过**
 *    才能置位（`PermissionGate` 组件负责）。
 * 3. AI 生成的东西永远是**草稿**：`ai_generate` 只返回草稿+审核报告，
 *    安装必须由用户确认后另调 `plugins_install`。
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { capabilityFingerprint } from "@/lib/capability";
import {
  diagnosticsExport,
  pluginsAudit,
  pluginsGet,
  pluginsGrant,
  pluginsInstall,
  pluginsList,
  pluginsReload,
  pluginsRun,
  pluginsSetEnabled,
  pluginsUninstall,
  pluginsValidate,
  toToolforgeError,
} from "@/lib/ipc";
import { queryKeys } from "@/lib/query-client";
import type {
  AuditSnapshot,
  Capability,
  DiagnosticsBundle,
  GrantPermissionsRequest,
  InstallPluginRequest,
  InstallReport,
  PluginDetail,
  PluginSummary,
  PluginsSnapshot,
  RunPluginRequest,
  RunPluginResponse,
  ValidatePluginRequest,
} from "@/types/domain";

const EMPTY_PLUGINS: PluginsSnapshot = {
  plugins: [],
  pendingPermissionCount: 0,
  auditDir: "",
};

export function usePlugins() {
  return useQuery({
    queryKey: queryKeys.plugins,
    queryFn: () => pluginsList(),
    staleTime: 5_000,
  });
}

export function usePluginsSnapshot(): PluginsSnapshot {
  const { data } = usePlugins();
  return data ?? EMPTY_PLUGINS;
}

/**
 * 列表数据 + 查询状态（加载/错误）。
 *
 * 页面需要区分"没有插件"和"还没加载完"时必须用这个 —— 只拿快照的话，
 * 首帧会看到一个空的插件列表，那会被误读成"一个插件都没有"。
 */
export function usePluginsState() {
  const query = usePlugins();
  return {
    snapshot: query.data ?? EMPTY_PLUGINS,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
    isFetching: query.isFetching,
  };
}

/** 插件详情（详情抽屉打开时才拉） */
export function usePluginDetail(pluginId: string | null, enabled = true) {
  return useQuery({
    queryKey: queryKeys.plugin(pluginId ?? "none"),
    queryFn: async (): Promise<PluginDetail | null> => {
      if (!pluginId) return null;
      return pluginsGet(pluginId);
    },
    enabled: Boolean(pluginId) && enabled,
    staleTime: 5_000,
  });
}

export function useReloadPlugins() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => pluginsReload(),
    onSuccess: (loaded: number) => {
      void client.invalidateQueries({ queryKey: queryKeys.plugins });
      toast.success(`已重新装载 ${loaded} 个插件`);
    },
    onError: (e) => toast.error("重新装载失败", { description: toToolforgeError(e).message }),
  });
}

/** 仅校验、不落盘（导入前"先看看"） */
export function useValidatePlugin() {
  return useMutation({
    mutationFn: (req: ValidatePluginRequest) => pluginsValidate(req),
    onError: (e) => toast.error("校验失败", { description: toToolforgeError(e).fullText }),
  });
}

export function useInstallPlugin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (req: InstallPluginRequest) => pluginsInstall(req),
    onSuccess: (report: InstallReport) => {
      void client.invalidateQueries({ queryKey: queryKeys.plugins });
      void client.invalidateQueries({ queryKey: queryKeys.audit(200) });
      const escalated = report.addedCapabilities.length > 0;
      toast.success(`已安装「${report.summary.name}」`, {
        description: escalated
          ? "注意：本次安装比旧版本多申请了权限，请到插件详情逐条确认。"
          : "插件当前处于未启用、零授权状态，请在详情里逐条授权后再启用。",
        duration: escalated ? 12_000 : 6_000,
      });
    },
    onError: (e) => {
      const err = toToolforgeError(e);
      toast.error("安装失败", { description: err.fullText, duration: 10_000 });
    },
  });
}

/**
 * 授权。
 *
 * 传上去的 `granted` 是 **`PermissionSet` 结构体**（`{ capabilities: [...] }`），
 * 且应当直接复用后端给过的能力对象（指纹要逐字节一致，
 * 见 `lib/capability.ts` 的 `capabilityFingerprint`）。
 */
export function useGrantPermissions() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (req: GrantPermissionsRequest) => pluginsGrant(req),
    onSuccess: (summary: PluginSummary) => {
      client.setQueryData(queryKeys.plugin(summary.id), (prev: PluginDetail | null | undefined) =>
        prev ? { ...prev, summary, granted: prev.granted } : prev,
      );
      void client.invalidateQueries({ queryKey: queryKeys.plugins });
      void client.invalidateQueries({ queryKey: queryKeys.plugin(summary.id) });
      void client.invalidateQueries({ queryKey: queryKeys.audit(200) });
      toast.success(`已更新「${summary.name}」的权限`, {
        description: `当前生效 ${summary.grantedCount} / 声明 ${summary.permissionCount} 项。`,
      });
    },
    onError: (e) => toast.error("授权失败", { description: toToolforgeError(e).fullText }),
  });
}

export function useSetPluginEnabled() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ pluginId, enabled }: { pluginId: string; enabled: boolean }) =>
      pluginsSetEnabled(pluginId, enabled),
    onSuccess: (summary: PluginSummary) => {
      void client.invalidateQueries({ queryKey: queryKeys.plugins });
      void client.invalidateQueries({ queryKey: queryKeys.plugin(summary.id) });
      toast.success(summary.enabled ? `已启用「${summary.name}」` : `已停用「${summary.name}」`);
    },
    onError: (e) => toast.error("切换失败", { description: toToolforgeError(e).fullText }),
  });
}

export function useUninstallPlugin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (pluginId: string) => pluginsUninstall(pluginId),
    onSuccess: (_v: void, pluginId: string) => {
      client.removeQueries({ queryKey: queryKeys.plugin(pluginId) });
      void client.invalidateQueries({ queryKey: queryKeys.plugins });
      void client.invalidateQueries({ queryKey: queryKeys.audit(200) });
      toast.success(`已卸载 ${pluginId}`);
    },
    onError: (e) => toast.error("卸载失败", { description: toToolforgeError(e).fullText }),
  });
}

/** 运行插件：立即返回 jobId，进度去任务中心看 */
export function useRunPlugin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (req: RunPluginRequest) => pluginsRun(req),
    onSuccess: (res: RunPluginResponse) => {
      void client.invalidateQueries({ queryKey: queryKeys.jobs });
      void client.invalidateQueries({ queryKey: queryKeys.jobStats });
      toast.success(`已提交「${res.pluginName}」`, {
        description:
          res.totalItems > 1
            ? `共 ${res.totalItems} 个文件，进度见任务中心（${res.jobId}）。`
            : `任务 ${res.jobId} 已进入队列。`,
      });
    },
    onError: (e) => {
      const err = toToolforgeError(e);
      toast.error("运行失败", { description: err.fullText, duration: 10_000 });
    },
  });
}

/** 审计日志（安全页） */
export function useAudit(limit = 200) {
  return useQuery({
    queryKey: queryKeys.audit(limit),
    queryFn: (): Promise<AuditSnapshot> => pluginsAudit(limit),
    staleTime: 10_000,
  });
}

/**
 * 导出诊断包。
 *
 * 是 mutation 而不是 query：它会**写文件**，而写文件不该由"组件挂载 / 重渲染"触发 ——
 * 那会让刷新一次页面就多一个文件。用户点一下才导一个。
 *
 * 成功时把 `redactions` **如实报出来**：正常情况下它应该是 0（命令压根不收密钥），
 * 非 0 就说明兜底那一层真的抹掉了东西，用户有权知道数字不是 0。
 */
export function useExportDiagnostics() {
  return useMutation({
    mutationFn: (): Promise<DiagnosticsBundle> => diagnosticsExport(),
    onSuccess: (b: DiagnosticsBundle) =>
      toast.success("诊断包已导出", {
        description:
          b.redactions > 0
            ? `${b.path}（${(b.sizeBytes / 1024).toFixed(1)} KB，已脱敏 ${b.redactions} 处）`
            : `${b.path}（${(b.sizeBytes / 1024).toFixed(1)} KB）`,
      }),
    onError: (e) => toast.error("导出诊断包失败", { description: toToolforgeError(e).fullText }),
  });
}

// ============================================================================
// 派生工具
// ============================================================================

export function pluginCategoryLabel(category: PluginSummary["category"]): string {
  const map: Record<PluginSummary["category"], string> = {
    image: "图片",
    audio: "音频",
    video: "视频",
    document: "文档",
    archive: "压缩包",
    ebook: "电子书",
    text: "文本",
    dev: "开发辅助",
    ai: "AI",
    system: "系统",
    other: "其它",
  };
  return map[category] ?? "其它";
}

export function runtimeKindLabel(kind: PluginSummary["runtimeKind"]): string {
  switch (kind) {
    case "pipeline":
      return "L1 · 声明式编排";
    case "wasm":
      return "L2 · WASM 沙箱";
    case "python":
      return "L3 · Python 进程";
    default:
      return "未知运行时";
  }
}

export const ALL_PLUGIN_CATEGORIES: PluginSummary["category"][] = [
  "image",
  "audio",
  "video",
  "document",
  "archive",
  "ebook",
  "text",
  "dev",
  "ai",
  "system",
  "other",
];

/** 详情里"已授权"的能力（指纹与后端 `PermissionSet::effective` 同口径） */
export function grantedKeys(granted: Capability[]): Set<string> {
  return new Set(granted.map((c) => capabilityFingerprint(c)));
}
