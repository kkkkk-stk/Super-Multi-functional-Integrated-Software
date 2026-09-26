/**
 * # 唯一的 IPC 出口
 *
 * **整个前端只有这个文件允许 import `@/bindings`（以及 `@tauri-apps/api`）。**
 * 其它任何地方都要从这里导入具名函数（`jobsList()` / `pluginsInstall()` …），
 * 而它们的**签名由生成类型决定** —— 参数类型来自 `_Deserialize` 相位、
 * 返回类型来自 `_Serialize` 相位，全部跟着 Rust 编译器走。
 *
 * ## 为什么这样最安全
 *
 * `bindings.ts` 是 `pnpm bindings`（tauri-specta）从真实 Rust 类型导出的产物，
 * 是契约的唯一真相来源。这里做的事只有两件：
 *
 * 1. **折叠返回信封**：specta 的 `ErrorHandlingMode::Result` 让每个命令返回
 *    `{ status: "ok", data } | { status: "error", error }`，`unwrap()` 把它折成
 *    正常的 resolve/reject，这样 TanStack Query 能直接用；
 * 2. **规范化错误**：把后端的 `ToolforgeError` 变成带 `code` 的 `Error` 子类，
 *    并把传输层异常（命令未注册、参数反序列化失败）也归一成同一形状。
 *
 * 其它文件因此看不到 `invoke`、看不到 `status: "ok"`、也看不到任何手写的
 * 参数键名 —— 键名拼错在**编译期**就会被抓出来。
 */

import { commands } from "@/bindings";
import type { ErrorCode, ToolforgeError_Serialize as ToolforgeError } from "@/bindings";

import type {
  AiGenerateRequest,
  AiGenerateResponse,
  AiTestConnectionResponse,
  AppInfo,
  AppPathsDto,
  AuditSnapshot,
  EngineEntry,
  EngineInstallRequest,
  EngineStatus,
  GrantPermissionsRequest,
  InstallPluginRequest,
  InstallReport,
  Job,
  JobFilter,
  JobStats,
  JobsListRequest,
  JobsSnapshot,
  NodeCatalogResponse,
  PluginDetail,
  PluginSummary,
  PluginsSnapshot,
  RunPluginRequest,
  RunPluginResponse,
  SecurityReview,
  Settings,
  SettingsPatch,
  SystemStatus,
  ValidatePluginRequest,
  ValidatePluginResponse,
} from "@/types/domain";

// ============================================================================
// 结果信封
// ============================================================================

/** specta `ErrorHandlingMode::Result` 的形状（与 `bindings.ts` 的 `typedError` 一致） */
export type Result<T, E> = { status: "ok"; data: T } | { status: "error"; error: E };

/**
 * 后端错误的前端表示。
 *
 * 继承 `Error` 的理由：TanStack Query 的 `error` 字段、`instanceof Error` 判断、
 * `toast.error(e.message)` 都依赖它。
 */
export class ToolforgeErrorImpl extends Error {
  readonly code: ErrorCode;
  readonly detail?: string;
  readonly subject?: string;

  constructor(raw: ToolforgeError) {
    super(raw.message);
    this.name = "ToolforgeError";
    this.code = raw.code;
    // `detail` / `subject` 在生成类型里是 `string | null | undefined`，
    // 这里统一收敛成 `undefined`，免得 UI 到处判断 null。
    this.detail = raw.detail ?? undefined;
    this.subject = raw.subject ?? undefined;
  }

  /** 用户可自行修复（据此在 UI 上给"去安装引擎 / 去设置"的入口） */
  get actionable(): boolean {
    return (
      this.code === "ENGINE_MISSING" ||
      this.code === "PERMISSION_DENIED" ||
      this.code === "AI_UNAVAILABLE" ||
      this.code === "INVALID_ARGUMENT"
    );
  }

  /** 安全事件：越权、哈希不符 —— UI 要走最醒目的样式 */
  get isSecurityEvent(): boolean {
    return this.code === "PLUGIN_CAPABILITY_VIOLATION" || this.code === "INTEGRITY_CHECK_FAILED";
  }

  get isEngineMissing(): boolean {
    return this.code === "ENGINE_MISSING";
  }

  get isCancelled(): boolean {
    return this.code === "CANCELLED";
  }

  /** 技术细节 + subject，供"详情"折叠区展示 */
  get fullText(): string {
    const parts = [`[${this.code}] ${this.message}`];
    if (this.subject) parts.push(`对象：${this.subject}`);
    if (this.detail) parts.push(this.detail);
    return parts.join("\n");
  }
}

function isToolforgeErrorShape(v: unknown): v is ToolforgeError {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.code === "string" && typeof o.message === "string";
}

/**
 * 把任意抛出物归一成 `ToolforgeErrorImpl`。
 *
 * 三种来源：
 * - 后端业务错误（命令返回 `status: "error"`）；
 * - `bindings.ts` 的 `typedError` 会把 JS 层的 `Error` 原样重抛（传输层问题）；
 * - 极端情况下后端返回了非信封结构（版本不匹配）。
 */
export function toToolforgeError(e: unknown): ToolforgeErrorImpl {
  if (e instanceof ToolforgeErrorImpl) return e;
  if (isToolforgeErrorShape(e)) return new ToolforgeErrorImpl(e);
  if (e instanceof Error) {
    return new ToolforgeErrorImpl({ code: "INTERNAL", message: e.message });
  }
  if (typeof e === "string") {
    return new ToolforgeErrorImpl({ code: "INTERNAL", message: e });
  }
  return new ToolforgeErrorImpl({
    code: "INTERNAL",
    message: "未知错误（IPC 返回了非预期结构）",
    detail: JSON.stringify(e),
  });
}

/**
 * 折叠信封。
 *
 * - `status: "ok"` → resolve(data)
 * - `status: "error"` → reject(ToolforgeErrorImpl)
 * - 传输层抛出的异常 → 也归一成 ToolforgeErrorImpl
 */
async function unwrap<T, E>(pending: Promise<Result<T, E>>): Promise<T> {
  let r: Result<T, E>;
  try {
    r = await pending;
  } catch (e) {
    throw toToolforgeError(e);
  }
  if (r === null || typeof r !== "object" || !("status" in r)) {
    throw new ToolforgeErrorImpl({
      code: "INTERNAL",
      message: "命令返回了不符合契约的结构（前后端版本可能不一致）",
      detail: JSON.stringify(r).slice(0, 400),
    });
  }
  if (r.status === "error") throw new ToolforgeErrorImpl(r.error as ToolforgeError);
  return r.data;
}

// ============================================================================
// 错误码 → 中文提示
// ============================================================================

/** 每种错误码对应的"怎么办"。UI 上的错误块直接用它，避免每个页面各写一套文案。 */
export const ERROR_HINTS: Record<ErrorCode, string> = {
  INVALID_ARGUMENT: "请检查输入项是否填全、格式是否正确。",
  NOT_FOUND: "目标不存在，可能已被移动或删除；刷新一下再试。",
  PERMISSION_DENIED: "权限不足。请到「插件详情 → 权限」逐条授予所需能力。",
  ENGINE_MISSING: "缺少所需能力引擎，请到「设置 → 引擎」安装后再试。",
  ENGINE_FAILED: "引擎调用失败。展开详情可看到原始输出，常见原因是文件损坏或参数不支持。",
  PLUGIN_INVALID: "插件清单不符合协议，请修正后再安装。",
  PLUGIN_RUNTIME: "插件运行时出错。查看任务日志里的 stderr 尾部可以定位。",
  PLUGIN_CAPABILITY_VIOLATION:
    "插件尝试使用未声明的能力，已被拦截。这是一次安全事件，已写入审计日志。",
  CANCELLED: "任务已被取消。",
  TIMEOUT: "操作超时。批量任务可考虑降低并发度。",
  NETWORK: "网络请求失败，请检查代理或稍后重试。",
  INTEGRITY_CHECK_FAILED: "内容哈希校验失败，产物可能被篡改或不完整，已拒绝使用。",
  AI_UNAVAILABLE: "AI 服务不可用。请到「设置 → AI」填写提供方、模型与 API Key。",
  AI_REJECTED: "AI 的产出没有通过静态校验或安全审核。",
  IO: "读写文件失败，请检查磁盘空间与目录权限。",
  SERDE: "数据格式不符合协议（多半是插件清单写错了字段名或类型）。",
  INTERNAL: "内部错误。展开详情可见技术信息，欢迎提 issue。",
};

// ============================================================================
// 应用 / 系统
// ============================================================================

export const appInfo = (): Promise<AppInfo> => unwrap(commands.appInfo());

export const appPaths = (): Promise<AppPathsDto> => unwrap(commands.appPaths());

export const systemStatus = (): Promise<SystemStatus> => unwrap(commands.systemStatus());

// ============================================================================
// 设置
// ============================================================================

export const settingsGet = (): Promise<Settings> => unwrap(commands.settingsGet());

export const settingsPatch = (patch: SettingsPatch): Promise<Settings> =>
  unwrap(commands.settingsPatch(patch));

// ============================================================================
// 任务
// ============================================================================

/**
 * 默认过滤条件：不过滤。
 *
 * 任务列表总是在**前端**过滤，这样 Query 缓存里只有一份权威快照，
 * 事件补丁不会漏掉任何一条 key。
 */
export const EMPTY_JOB_FILTER: JobFilter = { statuses: [], kinds: [] };

export const jobsList = (req?: JobsListRequest): Promise<JobsSnapshot> =>
  unwrap(commands.jobsList(req ?? { filter: EMPTY_JOB_FILTER }));

export const jobsGet = (jobId: string): Promise<Job | null> => unwrap(commands.jobsGet(jobId));

export const jobsCancel = (jobId: string): Promise<Job> => unwrap(commands.jobsCancel(jobId));

/**
 * 重试一个任务。
 *
 * 只对**注册过重放闭包**的任务有效：插件运行可以重放，引擎安装与 AI 生成不行
 * （有副作用 / 会重复计费），后端会直接拒绝。UI 用 `isRetryableKind()` 决定
 * 要不要显示按钮，真正的裁决仍然在后端。
 */
export const jobsRetry = (jobId: string): Promise<string> => unwrap(commands.jobsRetry(jobId));

export const jobsClearFinished = (): Promise<number> => unwrap(commands.jobsClearFinished());

export const jobsStats = (): Promise<JobStats> => unwrap(commands.jobsStats());

// ============================================================================
// 引擎
// ============================================================================

export const enginesCatalog = (): Promise<EngineEntry[]> => unwrap(commands.enginesCatalog());

export const enginesProbeAll = (): Promise<EngineEntry[]> => unwrap(commands.enginesProbeAll());

export const enginesProbe = (engineId: string): Promise<EngineStatus> =>
  unwrap(commands.enginesProbe(engineId));

/** 返回 jobId；下载进度通过 `engineDownloadProgress` 事件回流 */
export const enginesInstall = (req: EngineInstallRequest): Promise<string> =>
  unwrap(commands.enginesInstall(req));

// ============================================================================
// 插件
// ============================================================================

export const pluginsList = (): Promise<PluginsSnapshot> => unwrap(commands.pluginsList());

export const pluginsGet = (pluginId: string): Promise<PluginDetail | null> =>
  unwrap(commands.pluginsGet(pluginId));

/** 重新扫描插件目录，返回成功装载的数量 */
export const pluginsReload = (): Promise<number> => unwrap(commands.pluginsReload());

export const pluginsValidate = (req: ValidatePluginRequest): Promise<ValidatePluginResponse> =>
  unwrap(commands.pluginsValidate(req));

export const pluginsInstall = (req: InstallPluginRequest): Promise<InstallReport> =>
  unwrap(commands.pluginsInstall(req));

/** 授权（`granted` 是 `PermissionSet` 结构体：`{ capabilities: [...] }`） */
export const pluginsGrant = (req: GrantPermissionsRequest): Promise<PluginSummary> =>
  unwrap(commands.pluginsGrant(req));

export const pluginsSetEnabled = (pluginId: string, enabled: boolean): Promise<PluginSummary> =>
  unwrap(commands.pluginsSetEnabled(pluginId, enabled));

export const pluginsUninstall = async (pluginId: string): Promise<void> => {
  // 后端返回 `null`（生成类型里就是 `typedError<null, …>`），这里收敛成 void
  await unwrap(commands.pluginsUninstall(pluginId));
};

export const pluginsAudit = (limit = 200): Promise<AuditSnapshot> =>
  unwrap(commands.pluginsAudit(limit));

/** 运行插件，立即返回 jobId（执行在任务队列里，进度看事件） */
export const pluginsRun = (req: RunPluginRequest): Promise<RunPluginResponse> =>
  unwrap(commands.pluginsRun(req));

// ============================================================================
// 流水线
// ============================================================================

export const pipelineNodes = (): Promise<NodeCatalogResponse> => unwrap(commands.pipelineNodes());

// ============================================================================
// AI
// ============================================================================

export const aiTestConnection = (): Promise<AiTestConnectionResponse> =>
  unwrap(commands.aiTestConnection());

/** 只生成**草稿 + 审核报告**，不写盘、不装载。安装要另走 `pluginsInstall`。 */
export const aiGenerate = (req: AiGenerateRequest): Promise<AiGenerateResponse> =>
  unwrap(commands.aiGenerate(req));

export const aiReviewDraft = (raw: string): Promise<SecurityReview> =>
  unwrap(commands.aiReviewDraft(raw));
