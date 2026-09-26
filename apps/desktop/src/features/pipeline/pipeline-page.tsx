import { Info, Workflow } from "lucide-react";

import { FlowCanvas } from "@/components/pipeline/flow-canvas";
import { Badge } from "@/components/ui/badge";
import { useNodeCatalog } from "@/hooks/use-pipeline";
import { useCanvasStore } from "@/stores/canvas-store";

/**
 * 流程编辑器页。
 *
 * 页面本身很薄：真正的逻辑在 `components/pipeline/*` 与 `stores/canvas-store.ts`。
 * 这里只负责给用户一个"现在处于什么状态"的上下文（节点目录条数、缺引擎提示、
 * 画布持久化说明），因为画布是唯一一个**完全在前端创作**的功能，
 * 用户很自然会问"我搭的东西存在哪、丢了怎么办"。
 */
export function PipelinePage() {
  const { data: catalog, isLoading } = useNodeCatalog();
  const nodes = useCanvasStore((s) => s.nodes);
  const meta = useCanvasStore((s) => s.meta);

  const missingEngineCount = catalog ? Object.keys(catalog.missingEngines).length : 0;
  const unavailableCount = catalog
    ? Object.values(catalog.availability).filter((v) => !v).length
    : 0;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Workflow className="h-5 w-5 text-primary" />
          流程编辑器
        </h1>
        <Badge variant="outline" className="tabular">
          {isLoading ? "读取节点目录…" : `${catalog?.nodes.length ?? 0} 个内置节点`}
        </Badge>
        {unavailableCount > 0 && (
          <Badge variant="warning">{unavailableCount} 个节点因缺引擎不可用</Badge>
        )}
        {missingEngineCount > 0 && (
          <span className="text-[11px] text-muted-foreground">
            缺失引擎：{Object.keys(catalog?.missingEngines ?? {}).join("、")}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Info className="h-3 w-3" />
          画布会自动保存在本机（localStorage）：{meta.name} · {nodes.length} 个节点
        </span>
      </header>

      <div className="min-h-0 flex-1">
        <FlowCanvas />
      </div>
    </div>
  );
}
