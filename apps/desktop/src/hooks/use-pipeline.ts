/**
 * 内置节点目录与画布同步。
 *
 * 节点目录（`["nodes"]`）是**后端权威数据**：节点名、端口、参数、必需引擎、
 * 可用性全部来自 `pipeline_nodes`。画布上已经放好的节点会把这份数据"复制"进
 * `canvas-store`（那是纯前端创作态），因此需要一个显式的同步动作 ——
 * 引擎装好之后，画布上那些灰掉的端口要重新亮起来。
 */

import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import { pipelineNodes } from "@/lib/ipc";
import { queryKeys } from "@/lib/query-client";
import { useCanvasStore } from "@/stores/canvas-store";
import type { NodeCategory, NodeDescriptor, NodeCatalogResponse } from "@/types/domain";

export function useNodeCatalog() {
  return useQuery({
    queryKey: queryKeys.nodes,
    queryFn: () => pipelineNodes(),
    staleTime: 30_000,
  });
}

/** 把最新的节点目录灌进画布（描述、端口、引擎可用性） */
export function useSyncCanvasWithCatalog(): NodeCatalogResponse | undefined {
  const { data } = useNodeCatalog();
  const syncWithCatalog = useCanvasStore((s) => s.syncWithCatalog);

  useEffect(() => {
    if (!data) return;
    syncWithCatalog(data.nodes, data.availability, data.missingEngines);
  }, [data, syncWithCatalog]);

  return data;
}

export interface NodeCategoryGroup {
  category: NodeCategory;
  label: string;
  nodes: NodeDescriptor[];
}

const CATEGORY_ORDER: NodeCategory[] = [
  "file",
  "image",
  "video",
  "audio",
  "document",
  "archive",
  "ebook",
  "ai",
  "flow",
];

export function nodeCategoryLabel(category: NodeCategory): string {
  const map: Record<NodeCategory, string> = {
    file: "文件操作",
    image: "图片",
    video: "视频",
    audio: "音频",
    document: "文档",
    archive: "压缩包",
    ebook: "电子书",
    ai: "AI",
    flow: "流程控制",
  };
  return map[category] ?? "其它";
}

/** 节点面板按分类分组（顺序固定，不要用 Map 的枚举顺序） */
export function groupNodes(nodes: NodeDescriptor[]): NodeCategoryGroup[] {
  return CATEGORY_ORDER.map((category) => ({
    category,
    label: nodeCategoryLabel(category),
    nodes: nodes.filter((n) => n.category === category),
  })).filter((g) => g.nodes.length > 0);
}

/** 节点分类的强调色（画布节点头部用，与图例一致） */
export const CATEGORY_COLORS: Record<NodeCategory, { ring: string; text: string; bg: string }> = {
  file: { ring: "ring-slate-400/40", text: "text-slate-300", bg: "bg-slate-500/15" },
  image: { ring: "ring-emerald-400/40", text: "text-emerald-300", bg: "bg-emerald-500/15" },
  video: { ring: "ring-violet-400/40", text: "text-violet-300", bg: "bg-violet-500/15" },
  audio: { ring: "ring-sky-400/40", text: "text-sky-300", bg: "bg-sky-500/15" },
  document: { ring: "ring-amber-400/40", text: "text-amber-300", bg: "bg-amber-500/15" },
  archive: { ring: "ring-orange-400/40", text: "text-orange-300", bg: "bg-orange-500/15" },
  ebook: { ring: "ring-teal-400/40", text: "text-teal-300", bg: "bg-teal-500/15" },
  ai: { ring: "ring-fuchsia-400/40", text: "text-fuchsia-300", bg: "bg-fuchsia-500/15" },
  flow: { ring: "ring-zinc-400/40", text: "text-zinc-300", bg: "bg-zinc-500/15" },
};

export function categoryColor(category: NodeCategory) {
  return CATEGORY_COLORS[category] ?? CATEGORY_COLORS.flow;
}
