import { Handle, Position, type NodeProps } from "@xyflow/react";
import { AlertTriangle, Boxes, CircleSlash, Play } from "lucide-react";
import * as React from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { categoryColor } from "@/hooks/use-pipeline";
import { isNodeImplemented, nodeSupportNote } from "@/lib/node-support";
import { cn } from "@/lib/utils";
import type { FlowNode } from "@/stores/canvas-store";
import type { IoPort } from "@/types/domain";

/**
 * 画布上的自定义节点。
 *
 * 三条视觉规则（都对应"这条流水线能不能跑"）：
 * 1. **按 `NodeCategory` 配色** —— 一眼能看出这条链是"图片链"还是"视频链"；
 * 2. **缺失必需引擎时整个节点变灰**，端口不可用，并在节点上写明缺哪个引擎 ——
 *    用户应该在拖进来之前就知道"这台机器上跑不了"，而不是等任务失败；
 * 3. **执行器未实现的节点**额外打一个黄色警告条（见 `lib/node-support.ts`）。
 *
 * 端口（Handle）的 `id` 直接用 `IoPort.id`：导出插件清单时
 * `${steps.<节点id>.<端口id>}` 的取值就是靠它对齐的。
 */

const PORT_TYPE_LABEL: Record<IoPort["type"], string> = {
  file: "文件",
  files: "多文件",
  directory: "目录",
  text: "文本",
  number: "数字",
  boolean: "布尔",
  json: "JSON",
  any: "任意",
};

function ToolForgeNodeImpl({ data, selected }: NodeProps<FlowNode>) {
  const colors = categoryColor(data.category);
  const implemented = isNodeImplemented(data.descriptorName);
  const unavailable = !data.available;

  return (
    <div
      className={cn(
        "w-[248px] rounded-lg border-2 bg-card/95 shadow-lg backdrop-blur transition-colors",
        selected ? "border-primary ring-2 ring-primary/30" : "border-border/70",
        unavailable && "opacity-70",
      )}
    >
      {/* 头部 */}
      <div className={cn("flex items-center gap-2 rounded-t-md px-3 py-2", colors.bg)}>
        <Boxes className={cn("h-3.5 w-3.5 shrink-0", colors.text)} />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold" title={data.label}>
          {data.label}
        </span>
        {unavailable && <CircleSlash className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
      </div>

      {/* 端口 */}
      <div className="space-y-1 px-3 py-2">
        <div className="flex justify-between gap-4">
          {/* 输入 */}
          <div className="min-w-0 flex-1 space-y-1">
            {data.inputs.length === 0 ? (
              <span className="block text-[10px] text-muted-foreground">无输入</span>
            ) : (
              data.inputs.map((port) => (
                <PortRow key={port.id} port={port} side="in" disabled={unavailable} />
              ))
            )}
          </div>
          {/* 输出 */}
          <div className="min-w-0 flex-1 space-y-1 text-right">
            {data.outputs.length === 0 ? (
              <span className="block text-[10px] text-muted-foreground">无输出</span>
            ) : (
              data.outputs.map((port) => (
                <PortRow key={port.id} port={port} side="out" disabled={unavailable} />
              ))
            )}
          </div>
        </div>

        <p className="line-clamp-2 border-t border-border/50 pt-1.5 text-[10px] leading-snug text-muted-foreground">
          {data.description}
        </p>

        {/* 引擎缺失 */}
        {unavailable && (
          <p className="flex items-start gap-1 text-[10px] text-warning">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            缺少引擎：{data.missingEngines.join("、") || "未知"}。请先到「设置 → 引擎」安装。
          </p>
        )}

        {/* 执行器未实现 */}
        {!implemented && (
          <p className="rounded bg-warning/15 px-1.5 py-1 text-[10px] text-warning">
            该能力尚未实现（v0.1 执行器未接入），运行会失败。
          </p>
        )}

        <p className="truncate font-mono text-[10px] text-muted-foreground/70" title={data.descriptorName}>
          {data.descriptorName}
        </p>
      </div>
    </div>
  );
}

function PortRow({
  port,
  side,
  disabled,
}: {
  port: IoPort;
  side: "in" | "out";
  disabled: boolean;
}) {
  const handleId = port.id;
  return (
    <div
      className={cn(
        "relative flex items-center gap-1 text-[10px]",
        side === "out" && "justify-end",
      )}
    >
      {side === "in" && (
        <Handle
          type="target"
          id={handleId}
          position={Position.Left}
          // 端口变灰时仍然允许连线（用户可能先搭好结构再去装引擎），
          // 但视觉上明确提示"现在跑不了"
          className={cn(
            "!h-2.5 !w-2.5 !border-2 !border-background",
            disabled ? "!bg-muted-foreground/50" : "!bg-primary",
          )}
        />
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="truncate">
            {port.label}
            <span className="ml-1 text-muted-foreground">({PORT_TYPE_LABEL[port.type]})</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side={side === "in" ? "left" : "right"}>
          <p className="font-medium">
            {port.label}（{PORT_TYPE_LABEL[port.type]}）
          </p>
          {port.description && <p className="text-muted-foreground">{port.description}</p>}
          {port.accept.length > 0 && (
            <p className="text-muted-foreground">接受：{port.accept.join("、")}</p>
          )}
          {port.required && <p className="text-warning">必填端口</p>}
        </TooltipContent>
      </Tooltip>
      {port.required && <span className="text-risk-high">*</span>}
      {side === "out" && (
        <Handle
          type="source"
          id={handleId}
          position={Position.Right}
          className={cn(
            "!h-2.5 !w-2.5 !border-2 !border-background",
            disabled ? "!bg-muted-foreground/50" : "!bg-primary",
          )}
        />
      )}
    </div>
  );
}

export const ToolForgeNode = React.memo(ToolForgeNodeImpl);

/** 画布右下角的图例 */
export function NodeLegend() {
  const items: { label: string; className: string }[] = [
    { label: "已实现", className: "bg-primary" },
    { label: "缺引擎（不可用）", className: "bg-muted-foreground/50" },
  ];
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 z-10 flex flex-col gap-1 rounded-md border border-border/60 bg-card/85 px-2.5 py-2 text-[10px] backdrop-blur">
      <p className="font-medium text-muted-foreground">图例</p>
      {items.map((item) => (
        <span key={item.label} className="flex items-center gap-1.5">
          <span className={cn("h-2 w-2 rounded-full", item.className)} />
          {item.label}
        </span>
      ))}
      <span className="flex items-center gap-1.5 text-warning">
        <AlertTriangle className="h-2.5 w-2.5" />
        黄色提示条 = 执行器未实现
      </span>
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <Play className="h-2.5 w-2.5" />
        导出为插件后才能运行
      </span>
    </div>
  );
}

/** 未实现节点的提示文案（Inspector 用） */
export function supportNote(nodeName: string): string | null {
  return nodeSupportNote(nodeName);
}

export { ToolForgeNodeImpl };
