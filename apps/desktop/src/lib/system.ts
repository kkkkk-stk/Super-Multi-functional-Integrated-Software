/**
 * 系统交互封装：原生文件对话框、打开目录 / 外部链接。
 *
 * 单独一层的理由：这些调用在**浏览器里跑 Vite dev**（没有 Tauri 运行时）时会抛异常，
 * 而开发期经常需要那样调试。所有函数都做降级处理并给出 toast，
 * 不会让一个"打开目录"的失败把页面炸掉。
 *
 * 权限来源：`src-tauri/capabilities/default.json` 里有 `dialog:default` 与
 * `opener:default`。**前端拿不到任意 shell**（caps 里只白名单了一个 sidecar）。
 */

import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
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
  } catch {
    // 有些平台 / 路径（例如不存在的输出目录）不支持 reveal，退回"直接打开"
    try {
      await openPath(path);
    } catch (e) {
      toast.error("无法打开该位置", { description: `${path}\n${errorText(e)}` });
    }
  }
}

/** 用系统默认程序打开文件或目录 */
export async function openWithDefaultApp(path: string): Promise<void> {
  if (!path) return;
  try {
    await openPath(path);
  } catch (e) {
    toast.error("无法打开", { description: `${path}\n${errorText(e)}` });
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
