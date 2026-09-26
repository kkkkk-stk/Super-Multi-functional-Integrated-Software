import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  AlertTriangle,
  Download,
  Eraser,
  Info,
  ListTree,
  Loader2,
  PackagePlus,
  ShieldCheck,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { InspectorPanel } from "@/components/pipeline/inspector-panel";
import { NodeLegend, ToolForgeNode } from "@/components/pipeline/toolforge-node";
import { NodePalette } from "@/components/pipeline/node-palette";
import { InstallConfirmPanel } from "@/components/plugins/plugin-sources";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { useSyncCanvasWithCatalog } from "@/hooks/use-pipeline";
import { useInstallPlugin, useValidatePlugin } from "@/hooks/use-plugins";
import { buildPluginYaml, isValidPluginId, suggestPluginId } from "@/lib/pipeline-yaml";
import { sniffRuntimeKind } from "@/lib/plugin-text";
import { isNodeImplemented } from "@/lib/node-support";
import { copyText } from "@/lib/system";
import { useCanvasStore, type FlowNode } from "@/stores/canvas-store";
import type { NodeDescriptor } from "@/types/domain";

const nodeTypes = { toolforge: ToolForgeNode };

/**
 * 流程编辑器画布。
 *
 * ## 关键约束：导出的产物是**插件清单**
 *
 * 后端没有"运行任意流水线"的命令，唯一的执行入口是 `plugins_run`。
 * 所以这里的路径是：搭图 → 导出 `plugin.yaml` → `plugins_validate` 校验
 * → `plugins_install`（走权限门）→ 到插件里运行。
 *
 * 好处是这条路自动继承了全部安全机制；代价是"运行"多了一步，
 * 所以工具栏上把这一步写得很清楚（不是"运行"，而是"导出并安装为插件"）。
 */
export function FlowCanvas() {
  return (
    <ReactFlowProvider>
      <FlowCanvasInner />
    </ReactFlowProvider>
  );
}

function FlowCanvasInner() {
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const onNodesChange = useCanvasStore((s) => s.onNodesChange);
  const onEdgesChange = useCanvasStore((s) => s.onEdgesChange);
  const onConnect = useCanvasStore((s) => s.onConnect);
  const addNode = useCanvasStore((s) => s.addNode);
  const removeNode = useCanvasStore((s) => s.removeNode);
  const selectNode = useCanvasStore((s) => s.selectNode);
  const selectedNodeId = useCanvasStore((s) => s.selectedNodeId);
  const clear = useCanvasStore((s) => s.clear);
  const meta = useCanvasStore((s) => s.meta);
  const setMeta = useCanvasStore((s) => s.setMeta);

  // 把后端节点目录（端口/参数/引擎可用性）同步进画布
  const catalog = useSyncCanvasWithCatalog();
  const { screenToFlowPosition } = useReactFlow();
  const [exportOpen, setExportOpen] = React.useState(false);

  // 首次进入且名称还是默认值时，按需求给个像样的 id
  React.useEffect(() => {
    if (meta.pluginId === "com.user.my-pipeline" && nodes.length > 0) {
      setMeta({ pluginId: suggestPluginId(meta.name) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.length]);

  const availabilityOf = React.useCallback(
    (descriptor: NodeDescriptor) => {
      const missing = catalog?.missingEngines[descriptor.name] ?? [];
      return {
        available: catalog?.availability[descriptor.name] ?? true,
        missingEngines: missing,
      };
    },
    [catalog],
  );

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const name = e.dataTransfer.getData("application/toolforge-node");
    if (!name) return;
    const descriptor = catalog?.nodes.find((n) => n.name === name);
    if (!descriptor) {
      toast.error("找不到这个节点", { description: "节点目录可能已刷新，请重试。" });
      return;
    }
    const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    addNode(descriptor, { x: position.x - 120, y: position.y - 40 }, availabilityOf(descriptor));
  };

  const handleNodeClick: NodeMouseHandler<FlowNode> = (_event, node) => {
    selectNode(node.id);
  };

  const unimplementedCount = nodes.filter(
    (n) => !isNodeImplemented(n.data.descriptorName),
  ).length;

  return (
    <div className="flex h-full min-h-0 overflow-hidden rounded-lg border border-border/60 bg-card/30">
      <NodePalette
        onAdd={(descriptor) => {
          // 单击添加：落在画布中心偏右下一点，避免完全重叠
          const index = nodes.length;
          addNode(
            descriptor,
            { x: 120 + (index % 4) * 60, y: 80 + index * 70 },
            availabilityOf(descriptor),
          );
        }}
      />

      <div className="relative min-w-0 flex-1">
        {/* 工具栏 */}
        <div className="absolute left-3 top-3 z-10 flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="bg-card/85 backdrop-blur">
            <ListTree className="h-3 w-3" />
            {nodes.length} 节点 · {edges.length} 连线
          </Badge>
          {unimplementedCount > 0 && (
            <Badge variant="warning" className="bg-card/85 backdrop-blur">
              <AlertTriangle className="h-3 w-3" />
              {unimplementedCount} 个节点尚未实现
            </Badge>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 bg-card/85 text-xs backdrop-blur"
            onClick={() => {
              if (nodes.length === 0) {
                toast.warning("画布是空的", { description: "先从左侧拖一个节点进来。" });
                return;
              }
              setExportOpen(true);
            }}
          >
            <PackagePlus className="h-3.5 w-3.5" />
            导出并安装为插件
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 bg-card/85 text-xs backdrop-blur"
            onClick={() => {
              clear();
              toast.info("画布已清空");
            }}
          >
            <Eraser className="h-3.5 w-3.5" />
            清空
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 bg-card/85 text-xs backdrop-blur"
            onClick={() => void copyText(JSON.stringify({ meta, nodes, edges }, null, 2), "已复制画布 JSON（可粘贴备份）")}
          >
            <Download className="h-3.5 w-3.5" />
            备份
          </Button>
        </div>

        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={handleNodeClick}
          onNodeDoubleClick={(_e, node) => removeNode(node.id)}
          onPaneClick={() => selectNode(null)}
          onDrop={handleDrop}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }}
          proOptions={{ hideAttribution: true }}
          fitView
          minZoom={0.3}
          maxZoom={1.6}
          defaultEdgeOptions={{ animated: true }}
          className="h-full w-full"
          // 无障碍：画布是可交互区域，给一个说明
          aria-label="流水线画布：从左侧拖入节点，拖动端口连线"
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="hsl(var(--border))" />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            nodeColor={(node) => {
              const data = (node as FlowNode).data;
              return data?.available ? "hsl(var(--primary))" : "hsl(var(--muted-foreground))";
            }}
            maskColor="hsl(var(--background) / 0.7)"
            className="!bg-card/80"
          />
        </ReactFlow>

        <NodeLegend />

        {nodes.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
            <ListTree className="h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              从左侧拖一个节点进来开始搭建流水线
            </p>
            <p className="max-w-md text-xs text-muted-foreground/80">
              流水线本身不能直接运行：导出成插件、逐条确认权限并安装之后，
              才能在「格式转换」或「批量处理」里用它处理文件。
            </p>
          </div>
        )}

        {selectedNodeId === null && nodes.length > 0 && (
          <p className="pointer-events-none absolute bottom-3 right-3 z-10 flex items-center gap-1.5 rounded-md border border-border/60 bg-card/85 px-2.5 py-1.5 text-[10px] text-muted-foreground backdrop-blur">
            <Info className="h-3 w-3" />
            点击节点编辑参数；双击节点删除；右侧编辑流水线元信息
          </p>
        )}
      </div>

      <InspectorPanel onClose={() => selectNode(null)} />

      <PipelineExportDialog open={exportOpen} onOpenChange={setExportOpen} />
    </div>
  );
}

/**
 * 导出对话框：生成 YAML → 校验 → 走权限门安装。
 */
function PipelineExportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const meta = useCanvasStore((s) => s.meta);
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const validate = useValidatePlugin();
  const install = useInstallPlugin();

  const built = React.useMemo(
    () => (open ? buildPluginYaml(meta, nodes, edges) : { yaml: "", errors: [], warnings: [] }),
    [open, meta, nodes, edges],
  );

  const source = React.useMemo(
    () => ({ kind: "bundle" as const, yaml: built.yaml, files: [] }),
    [built.yaml],
  );

  // 打开对话框（或画布变化）时重置校验结果，避免展示上一次的结论
  React.useEffect(() => {
    if (open) validate.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, built.yaml]);

  const idValid = isValidPluginId(meta.pluginId);
  const blocked = built.errors.length > 0 || !idValid || !built.yaml.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            导出并安装为插件
            <Badge variant="outline">{nodes.length} 个步骤</Badge>
          </DialogTitle>
          <DialogDescription>
            下面是根据画布生成的 <span className="font-mono">plugin.yaml</span>。
            它不会自动安装：先看校验结果，再逐条确认权限。
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1 scrollbar-thin">
          {built.errors.length > 0 && (
            <div className="rounded-md border border-destructive/60 bg-destructive/10 p-3">
              <p className="text-xs font-medium text-destructive">必须先解决这些问题</p>
              <ul className="mt-1 space-y-0.5" role="list">
                {built.errors.map((err, idx) => (
                  <li key={idx} className="text-xs text-destructive">
                    · {err}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {built.warnings.length > 0 && (
            <div className="rounded-md border border-warning/50 bg-warning/10 p-3">
              <p className="text-xs font-medium text-warning">需要注意</p>
              <ul className="mt-1 space-y-0.5" role="list">
                {built.warnings.map((warn, idx) => (
                  <li key={idx} className="text-xs text-warning">
                    · {warn}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!idValid && (
            <p className="text-xs text-destructive">
              插件 id <span className="font-mono">{meta.pluginId}</span> 不合法：
              只允许小写字母、数字、.、-、_，且长度 3~128。请在右侧「流水线信息」里改。
            </p>
          )}

          <CodeBlock code={built.yaml} language="yaml" title="plugin.yaml" maxHeight={320} />

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() => void copyText(built.yaml, "已复制 plugin.yaml")}
            >
              <Download className="h-3.5 w-3.5" />
              复制清单
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={blocked || validate.isPending}
              onClick={() => validate.mutate({ source })}
            >
              {validate.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ShieldCheck className="h-3.5 w-3.5" />
              )}
              让后端校验这份清单
            </Button>
          </div>

          {validate.data && (
            <>
              <Separator />
              <InstallConfirmPanel
                source={source}
                runtimeKind={sniffRuntimeKind(built.yaml)}
                validation={validate.data}
                validating={validate.isPending}
                validateError={validate.error}
                installing={install.isPending}
                onInstall={(payload) => {
                  install.mutate(payload, {
                    onSuccess: () => {
                      onOpenChange(false);
                      toast.success("流水线已安装为插件", {
                        description: "到「插件市场」逐条授权并启用后，就能用它处理文件了。",
                        duration: 10_000,
                      });
                    },
                  });
                }}
              />
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
