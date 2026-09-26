/**
 * 拖拽态。
 *
 * 拖拽是**纯瞬时状态**：文件一落下就交给页面处理（放进 `droppedFiles`），
 * 页面把它转成自己的表单状态或直接走 IPC。这里不保存任何"后端权威数据"。
 *
 * 支持两种拖入来源：
 * 1. Tauri 窗口级拖放（`getCurrentWebview().onDragDropEvent`）—— 真实文件路径，
 *    这是桌面端的正常路径；
 * 2. 浏览器 DOM 拖放（`dragover` / `drop`）—— 只在 Vite dev 下可用，
 *    拿到的是 File 对象，没有绝对路径，所以只用来做视觉反馈。
 */

import { create } from "zustand";

interface DropState {
  /** 是否正在拖拽（全窗口覆盖层据此显示） */
  dragging: boolean;
  /** 本次拖拽是否含有文件（有些拖拽只是拖文本） */
  hasFiles: boolean;
  /** 鼠标位置（给覆盖层做跟随光晕用） */
  pointer: { x: number; y: number };

  /** 最近一次落下的文件路径（页面消费后自行清空） */
  droppedFiles: string[];
  /** 最新的投递序号：页面用它判断"这是新的一批文件" */
  dropSeq: number;

  setDragging: (dragging: boolean, hasFiles?: boolean) => void;
  setPointer: (x: number, y: number) => void;
  setDroppedFiles: (paths: string[]) => void;
  clearDroppedFiles: () => void;
}

export const useDropStore = create<DropState>((set) => ({
  dragging: false,
  hasFiles: false,
  pointer: { x: 0.5, y: 0.35 },
  droppedFiles: [],
  dropSeq: 0,

  setDragging: (dragging, hasFiles = false) => set({ dragging, hasFiles }),
  setPointer: (x, y) => set({ pointer: { x, y } }),
  setDroppedFiles: (paths) =>
    set((s) => ({ droppedFiles: paths, dropSeq: s.dropSeq + 1, dragging: false })),
  clearDroppedFiles: () => set({ droppedFiles: [] }),
}));
