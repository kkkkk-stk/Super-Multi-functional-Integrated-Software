/**
 * 全窗口拖拽。
 *
 * ## 两条来源
 *
 * 1. **Tauri 窗口级拖放**（`getCurrentWebview().onDragDropEvent`）：
 *    桌面端的正常路径，能拿到**真实绝对路径**，也是唯一能给后端用的东西。
 *    ⚠️ 需要在 `tauri.conf.json` 里 `dragDropEnabled: true`（本项目已开）。
 * 2. **DOM 拖放**（`dragenter/over/drop`）：只在浏览器里跑 Vite dev 时有用，
 *    拿到的是 `File` 对象（没有绝对路径），所以只用来驱动视觉反馈。
 *
 * 挂载点：`AppShell` 顶部调一次 `useGlobalDragDrop()`，覆盖层 `<DropZone/>`
 * 读 store 的 `dragging` 决定是否渲染。
 */

import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect } from "react";

import { isTauriRuntime } from "@/lib/system";
import { useDropStore } from "@/stores/drop-store";

/** 把拖入的文件路径推给 store 并唤醒订阅者 */
function acceptPaths(paths: string[]): void {
  if (paths.length === 0) return;
  useDropStore.getState().setDroppedFiles(paths);
}

/**
 * 挂载全窗口拖放监听。返回取消函数由 effect 管理。
 */
export function useGlobalDragDrop(): void {
  useEffect(() => {
    const store = useDropStore.getState();

    // ---------- 1. Tauri 窗口级拖放 ----------
    let unlisten: (() => void) | undefined;
    let disposed = false;

    if (isTauriRuntime()) {
      getCurrentWebview()
        .onDragDropEvent((event) => {
          const payload = event.payload;
          switch (payload.type) {
            case "enter":
            case "over": {
              const s = useDropStore.getState();
              if (!s.dragging) s.setDragging(true, true);
              if (payload.type === "over" && payload.position) {
                // 位置直接换算成百分比，CSS 里用 left/top 百分比即可，
                // 不需要读窗口尺寸（也就不会因为 resize 而错位）
                const { x, y } = payload.position;
                s.setPointer(
                  Math.min(1, Math.max(0, x / window.innerWidth)),
                  Math.min(1, Math.max(0, y / window.innerHeight)),
                );
              }
              break;
            }
            case "drop": {
              useDropStore.getState().setDragging(false, false);
              acceptPaths(payload.paths ?? []);
              break;
            }
            case "leave": {
              useDropStore.getState().setDragging(false, false);
              break;
            }
            default:
              break;
          }
        })
        .then((off) => {
          if (disposed) off();
          else unlisten = off;
        })
        .catch(() => {
          // 旧版 Tauri 或权限不足时静默降级到 DOM 拖放
        });
    }

    // ---------- 2. DOM 拖放（dev / 降级路径）----------
    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      const hasFiles = Array.from(e.dataTransfer.types).includes("Files");
      if (!hasFiles) return;
      e.preventDefault();
      store.setDragging(true, true);
    };
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      const s = useDropStore.getState();
      if (!s.dragging) s.setDragging(true, true);
      s.setPointer(e.clientX / window.innerWidth, e.clientY / window.innerHeight);
    };
    const onDragLeave = (e: DragEvent) => {
      // relatedTarget 为 null 才是真的离开了窗口
      if (e.relatedTarget === null) useDropStore.getState().setDragging(false, false);
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      useDropStore.getState().setDragging(false, false);
      // 浏览器里拿到的是 File，没有绝对路径 —— 提示用户走桌面端。
      // 这里不假装能处理，避免"拖进去什么都没发生"的困惑。
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);

    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);
}

/**
 * 消费最近一批拖入的文件。
 *
 * 用法：页面挂载时订阅，拿到文件就填进自己的表单并**立刻清空** store，
 * 避免第二次进入页面时又收到上一批。
 */
export function useDroppedFiles(
  onFiles: (paths: string[]) => void,
  options: { accept?: (path: string) => boolean; acceptHint?: string } = {},
): void {
  useEffect(() => {
    // 用订阅而不是 useEffect 依赖 dropSeq：拖入可能发生在页面挂载之前
    const unsubscribe = useDropStore.subscribe((state, prev) => {
      if (state.dropSeq === prev.dropSeq) return;
      const paths = state.droppedFiles;
      useDropStore.getState().clearDroppedFiles();
      const filtered = options.accept ? paths.filter(options.accept) : paths;
      if (filtered.length === 0) return;
      onFiles(filtered);
    });
    return unsubscribe;
  }, [onFiles, options.accept, options.acceptHint]);
}
