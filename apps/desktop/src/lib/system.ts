/**
 * 系统交互封装：原生文件对话框、打开目录 / 外部链接。
 *
 * 单独一层的理由：这些调用在**浏览器里跑 Vite dev**（没有 Tauri 运行时）时会抛异常，
 * 而开发期经常需要那样调试。所有函数都做降级处理并给出 toast，
 * 不会让一个"打开目录"的失败把页面炸掉。
 *
 * ## 权限来源（以 `src-tauri/capabilities/default.json` 为准，逐条有运行时断言）
 *
 * | 用到的命令 | 权限 | 验证 |
 * |---|---|---|
 * | `revealItemInDir` | `opener:default`（含 `allow-reveal-item-in-dir`） | ✅ 允许 |
 * | `openUrl` | `opener:default`（含 `allow-open-url` + `allow-default-urls`） | ✅ 允许 |
 * | 对话框 | `dialog:default` | ✅ 允许 |
 * | `openPath` | **没有** `opener:allow-open-path` | ❌ **被拒** |
 *
 * ⚠️ 两点必须写清楚，否则很容易踩：
 *
 * 1. **前端拿不到任何 shell**。capability 里**一条 `shell:` 权限都没有**
 *    （这里此前写的是"只白名单了一个 sidecar" —— 那是过期说法）。
 *    `verify-platform.mjs`【26】从页面里真的去调 `plugin:shell|execute` 并断言被拒。
 * 2. **`openPath` 是被 ACL 拒绝的**，所以"用系统默认程序打开文件"这件事当前**做不到**。
 *    原来这里有个 `openWithDefaultApp()` 包着它 —— 它从来没有被任何界面调用过，
 *    而一旦有人接上就会**静默失败**（只弹一个 toast）。已删掉；将来真要做这个功能，
 *    得先**有意地**在 capability 里加 `opener:allow-open-path` 并配 scope，
 *    而不是让一个函数以为它能用。
 */

import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

/** 是否运行在 Tauri 运行时里 */
export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 对话框的文件类型过滤器（Tauri 的格式：名称 → 扩展名数组） */
export type DialogFilters = { name: string; extensions: string[] }[];

interface PickOptions {
  title?: string;
  multiple?: boolean;
  directory?: boolean;
  filters?: DialogFilters;
  defaultPath?: string;
}

/** 选择文件（可多选）。取消返回 `[]`。 */
export async function pickFiles(options: PickOptions = {}): Promise<string[]> {
  if (!isTauriRuntime()) {
    toast.warning("当前不在 Tauri 运行时中", { description: "文件选择需要在桌面窗口里使用。" });
    return [];
  }
  try {
    const picked = await openDialog({
      title: options.title ?? "选择文件",
      multiple: options.multiple ?? true,
      directory: options.directory ?? false,
      filters: options.filters,
      defaultPath: options.defaultPath,
    });
    if (picked === null) return [];
    return Array.isArray(picked) ? picked : [picked];
  } catch (e) {
    toast.error("打开文件对话框失败", { description: errorText(e) });
    return [];
  }
}

/** 选择目录。取消返回 `null`。 */
export async function pickDirectory(options: PickOptions = {}): Promise<string | null> {
  if (!isTauriRuntime()) {
    toast.warning("当前不在 Tauri 运行时中", { description: "目录选择需要在桌面窗口里使用。" });
    return null;
  }
  try {
    const picked = await openDialog({
      title: options.title ?? "选择目录",
      directory: true,
      multiple: false,
      defaultPath: options.defaultPath,
    });
    if (picked === null) return null;
    return Array.isArray(picked) ? (picked[0] ?? null) : picked;
  } catch (e) {
    toast.error("打开目录对话框失败", { description: errorText(e) });
    return null;
  }
}

/** 选择保存位置。取消返回 `null`。 */
export async function pickSavePath(options: PickOptions = {}): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  try {
    return await saveDialog({
      title: options.title ?? "保存到",
      filters: options.filters,
      defaultPath: options.defaultPath,
    });
  } catch (e) {
    toast.error("打开保存对话框失败", { description: errorText(e) });
    return null;
  }
}

/** 在系统文件管理器里定位到某个文件 / 目录 */
export async function revealInExplorer(path: string): Promise<void> {
  if (!path) return;
  try {
    await revealItemInDir(path);
  } catch (e) {
    // 有些平台 / 路径（例如不存在的输出目录）不支持 reveal。
    // ⚠️ 这里**不能**退回 `openPath`：capability 里没有 `opener:allow-open-path`，
    // 那样只会拿到一个 ACL 拒绝、把一个真实原因盖成另一个看不懂的错误。
    // （正文里解释过：`openPath` 现在是不可用的，见文件头。）
    toast.error("无法定位该位置", { description: `${path}\n${errorText(e)}` });
  }
}

/** 用系统浏览器打开外部链接 */
export async function openExternal(url: string): Promise<void> {
  try {
    await openUrl(url);
  } catch (e) {
    toast.error("无法打开链接", { description: errorText(e) });
  }
}

/**
 * 把文本写进剪贴板。
 *
 * 用 Web 的 Clipboard API 而不是插件：应用内复制（比如复制路径、复制 YAML）
 * 不需要任何额外能力，且 dev 环境下也能用。
 */
export async function copyText(text: string, successMessage = "已复制到剪贴板"): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(successMessage);
  } catch (e) {
    toast.error("复制失败", { description: errorText(e) });
  }
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}
