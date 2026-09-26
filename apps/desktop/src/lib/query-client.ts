/**
 * TanStack Query 的全局客户端与 **query key 约定**。
 *
 * ## 铁律（与 `src/stores/README.md` 呼应）
 *
 * - **所有来自 Rust 的异步数据都归 TanStack Query**：任务、引擎、插件、节点目录、
 *   设置、系统状态、审计日志。
 * - **Zustand 只存瞬时 UI 状态**：侧边栏折叠、命令面板开合、选中项、
 *   画布节点/连线、拖拽态、已套用的主题强调色。
 *
 * 事件到达时**只更新 Query 缓存**（`setQueryData` / `invalidateQueries`），
 * 绝不往 store 里再塞一份同样的数据。
 */

import { QueryClient } from "@tanstack/react-query";

import { toToolforgeError } from "@/lib/ipc";

/**
 * Query key 约定（**照这个表用，不要就地拼数组**）。
 *
 * | key | 数据 | 更新方式 |
 * |---|---|---|
 * | `["jobs"]` | `JobsSnapshot`（完整快照，过滤在前端做） | 事件 patch + 定时对账 |
 * | `["job", id]` | 单个 `Job` | 事件 patch |
 * | `["jobStats"]` | `JobStats` | 任务终结后 invalidate |
 * | `["engines"]` | `EngineEntry[]` | 探测 / 安装事件 patch |
 * | `["engine", id]` | `EngineStatus` | `engines_probe` 单点刷新 |
 * | `["plugins"]` | `PluginsSnapshot` | pluginChanged 事件 invalidate |
 * | `["plugin", id]` | `PluginDetail` | 授权 / 启用后精确刷新 |
 * | `["nodes"]` | `NodeCatalogResponse` | 引擎状态变化后 invalidate |
 * | `["settings"]` | `Settings` | mutation 返回即写入 |
 * | `["system"]` | `SystemStatus` | 打开仪表盘 / 切换页面时刷新 |
 * | `["audit", limit]` | `AuditSnapshot` | 安全页手动刷新 |
 * | `["ai", "connection"]` | `AiTestConnectionResponse` | 手动测试 |
 */
export const queryKeys = {
  jobs: ["jobs"] as const,
  job: (id: string) => ["job", id] as const,
  jobStats: ["jobStats"] as const,
  engines: ["engines"] as const,
  engine: (id: string) => ["engine", id] as const,
  plugins: ["plugins"] as const,
  plugin: (id: string) => ["plugin", id] as const,
  nodes: ["nodes"] as const,
  settings: ["settings"] as const,
  system: ["system"] as const,
  audit: (limit: number) => ["audit", limit] as const,
  aiConnection: ["ai", "connection"] as const,
} as const;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 桌面应用没有"跨标签页共享缓存"的问题，但频繁窗口聚焦重拉会造成
      // 大量无意义 IPC（引擎探测尤其贵）。对账交给事件与手动刷新。
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      staleTime: 3_000,
      gcTime: 5 * 60_000,
      retry: (failureCount, error) => {
        const e = toToolforgeError(error);
        // 这几类是确定性失败，重试没有意义（用户得先动手修）
        if (
          e.code === "NOT_FOUND" ||
          e.code === "INVALID_ARGUMENT" ||
          e.code === "ENGINE_MISSING" ||
          e.code === "PERMISSION_DENIED" ||
          e.code === "PLUGIN_INVALID" ||
          e.code === "AI_UNAVAILABLE"
        ) {
          return false;
        }
        return failureCount < 2;
      },
    },
    mutations: {
      retry: false,
    },
  },
});
