/**
 * 流程画布状态（React Flow）。
 *
 * 画布是**纯前端创作态**：后端没有"保存流水线"的命令，所以节点/连线/参数必须
 * 存在前端。持久化到 localStorage（换页/重启不丢），导出时才转成插件清单
 * （`lib/pipeline-yaml.ts`）走 `plugins_validate` / `plugins_install`。
 *
 * 节点数据里冗余存了 `IoPort` / `ParamSpec`：这样画布在**没有网络往返**的情况下
 * 也能渲染端口与参数表单（节点目录来自 `["nodes"]` 这条 Query，只在加载/刷新时同步）。
 */

import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type XYPosition,
} from "@xyflow/react";
import { toast } from "sonner";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import { localId } from "@/lib/utils";
import { isNodeImplemented } from "@/lib/node-support";
import type {
  IoPort,
  NodeCategory,
  NodeDescriptor,
  OnErrorPolicy,
  ParamSpec,
  ParamValue,
  PortType,
} from "@/types/domain";

/** 画布节点的业务数据 */
export type FlowNodeData = {
  /** 对应 `NodeDescriptor.name`，导出清单时写进 `uses` */
  descriptorName: string;
  label: string;
  description: string;
  category: NodeCategory;
  inputs: IoPort[];
  outputs: IoPort[];
  /** 参数声明（Inspector 的表单与导出清单都靠它） */
  params: ParamSpec[];
  /** 必需引擎是否齐备（来自 `NodeCatalogResponse.availability`） */
  available: boolean;
  /** 缺失的必需引擎（缺失时端口变灰） */
  missingEngines: string[];
  /**
   * 参数值。**注意**：内置节点的执行器是从"插件清单的 io.params"按同名 id 读参数的
   * （见 `plugins/builtin/image-convert/plugin.yaml` 的说明），所以这里的参数最终
   * 会被**按 id 去重**后写进插件清单，而不是写进步骤的 `with`。
   */
  paramValues: Record<string, ParamValue>;
};

export type FlowNode = Node<FlowNodeData>;
export type FlowEdge = Edge;

export interface CanvasMeta {
  /** 导出成插件时的 `metadata.id` 前缀（小写、点号分隔） */
  pluginId: string;
  name: string;
  description: string;
  onError: OnErrorPolicy;
  timeoutMs: number;
}

const DEFAULT_META: CanvasMeta = {
  pluginId: "com.user.my-pipeline",
  name: "我的流水线",
  description: "由 ToolForge 流程编辑器生成",
  onError: "fail",
  timeoutMs: 0,
};

interface CanvasState {
  meta: CanvasMeta;
  nodes: FlowNode[];
  edges: FlowEdge[];
  selectedNodeId: string | null;

  setMeta: (patch: Partial<CanvasMeta>) => void;

  onNodesChange: (changes: NodeChange<FlowNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<FlowEdge>[]) => void;
  onConnect: (connection: Connection) => void;

  addNode: (
    descriptor: NodeDescriptor,
    position: XYPosition,
    availability: { available: boolean; missingEngines: string[] },
  ) => void;
  updateNodeData: (id: string, patch: Partial<FlowNodeData>) => void;
  setParamValue: (nodeId: string, paramId: string, value: ParamValue) => void;
  removeNode: (id: string) => void;
  selectNode: (id: string | null) => void;

  /** 用最新的节点目录刷新画布上已有节点的描述/端口/引擎状态 */
  syncWithCatalog: (
    descriptors: NodeDescriptor[],
    availability: Record<string, boolean>,
    missingEngines: Record<string, string[]>,
  ) => void;

  replaceAll: (nodes: FlowNode[], edges: FlowEdge[]) => void;
  clear: () => void;
}

// ============================================================================
// 端口类型兼容性
// ============================================================================

/** 值类型（可互相连接：文本 / 数字 / 布尔 / JSON 在宿主里都以字符串传递） */
const VALUE_TYPES: PortType[] = ["text", "number", "boolean", "json"];

/**
 * 两个端口能否连线。
 *
 * 规则刻意保守（宁可不给连，也不要让用户连出一条跑不通的流水线）：
 * - `any` 与任何类型都兼容；
 * - `file` / `files` 互通（多文件端口可以接单文件输出）；
 * - `directory` 只与 `directory` / `any` 相连；
 * - 四种值类型内部互通；
 * - 其余一律拒绝。
 */
export function canConnect(source: PortType, target: PortType): boolean {
  if (source === "any" || target === "any") return true;
  if (source === target) return true;
  if ((source === "file" || source === "files") && (target === "file" || target === "files")) {
    return true;
  }
  if (VALUE_TYPES.includes(source) && VALUE_TYPES.includes(target)) return true;
  return false;
}

function portTypeOf(node: FlowNode | undefined, handleId: string | null | undefined, side: "in" | "out"): PortType | null {
  if (!node || !handleId) return null;
  const ports = side === "in" ? node.data.inputs : node.data.outputs;
  return ports.find((p) => p.id === handleId)?.type ?? null;
}

// ============================================================================
// Store
// ============================================================================

export const useCanvasStore = create<CanvasState>()(
  persist(
    (set, get) => ({
      meta: DEFAULT_META,
      nodes: [],
      edges: [],
      selectedNodeId: null,

      setMeta: (patch) => set((s) => ({ meta: { ...s.meta, ...patch } })),

      onNodesChange: (changes) =>
        set((s) => ({ nodes: applyNodeChanges(changes, s.nodes) as FlowNode[] })),

      onEdgesChange: (changes) => set((s) => ({ edges: applyEdgeChanges(changes, s.edges) })),

      onConnect: (connection) => {
        const { nodes, edges } = get();
        const sourceNode = nodes.find((n) => n.id === connection.source);
        const targetNode = nodes.find((n) => n.id === connection.target);
        const outType = portTypeOf(sourceNode, connection.sourceHandle, "out");
        const inType = portTypeOf(targetNode, connection.targetHandle, "in");

        if (outType && inType && !canConnect(outType, inType)) {
          toast.error("端口类型不兼容", {
            description: `「${sourceNode?.data.label ?? "上游"}」输出 ${outType} → 「${
              targetNode?.data.label ?? "下游"
            }」输入 ${inType}，宿主无法把这两种数据接起来。`,
          });
          return;
        }

        // 一个输入端口只接一条线：先删掉旧的，避免宿主侧出现"用哪个值"的不确定
        const cleaned = edges.filter(
          (e) =>
            !(
              e.target === connection.target &&
              (e.targetHandle ?? null) === (connection.targetHandle ?? null)
            ),
        );
        set({
          edges: addEdge(
            {
              ...connection,
              id: `e-${connection.source}:${connection.sourceHandle ?? "out"}->${
                connection.target
              }:${connection.targetHandle ?? "in"}`,
              animated: true,
              data: { portType: outType ?? "any" },
            },
            cleaned,
          ),
        });
      },

      addNode: (descriptor, position, availability) => {
        const node: FlowNode = {
          id: localId(descriptor.name.split(".").pop() || "node"),
          type: "toolforge",
          position,
          data: {
            descriptorName: descriptor.name,
            label: descriptor.label,
            description: descriptor.description,
            category: descriptor.category,
            inputs: descriptor.inputs,
            outputs: descriptor.outputs,
            params: descriptor.params,
            available: availability.available,
            missingEngines: availability.missingEngines,
            paramValues: Object.fromEntries(
              descriptor.params.map((p) => [p.id, p.default ?? { kind: "str", value: "" }]),
            ) as Record<string, ParamValue>,
          },
        };
        set((s) => ({ nodes: [...s.nodes, node], selectedNodeId: node.id }));
      },

      updateNodeData: (id, patch) =>
        set((s) => ({
          nodes: s.nodes.map((n) =>
            n.id === id ? { ...n, data: { ...n.data, ...patch } } : n,
          ),
        })),

      setParamValue: (nodeId, paramId, value) =>
        set((s) => ({
          nodes: s.nodes.map((n) =>
            n.id === nodeId
              ? { ...n, data: { ...n.data, paramValues: { ...n.data.paramValues, [paramId]: value } } }
              : n,
          ),
        })),

      removeNode: (id) =>
        set((s) => ({
          nodes: s.nodes.filter((n) => n.id !== id),
          // 连带清掉它的连线，否则会留下指向不存在节点的悬空边
          edges: s.edges.filter((e) => e.source !== id && e.target !== id),
          selectedNodeId: s.selectedNodeId === id ? null : s.selectedNodeId,
        })),

      selectNode: (id) => set({ selectedNodeId: id }),

      syncWithCatalog: (descriptors, availability, missingEngines) =>
        set((s) => {
          const byName = new Map(descriptors.map((d) => [d.name, d]));
          const nodes = s.nodes.map((n) => {
            const desc = byName.get(n.data.descriptorName);
            if (!desc) return n;
            const missing = missingEngines[desc.name] ?? [];
            return {
              ...n,
              data: {
                ...n.data,
                label: desc.label,
                description: desc.description,
                category: desc.category,
                inputs: desc.inputs,
                outputs: desc.outputs,
                params: desc.params,
                available: availability[desc.name] ?? true,
                missingEngines: missing,
                // 新增的参数补上默认值，旧的保留用户填过的
                paramValues: Object.fromEntries(
                  desc.params.map((p) => [
                    p.id,
                    n.data.paramValues[p.id] ?? p.default ?? { kind: "str", value: "" },
                  ]),
                ) as Record<string, ParamValue>,
              },
            };
          });
          return { nodes };
        }),

      replaceAll: (nodes, edges) => set({ nodes, edges, selectedNodeId: null }),

      clear: () => set({ nodes: [], edges: [], selectedNodeId: null }),
    }),
    {
      name: "toolforge-canvas",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ meta: s.meta, nodes: s.nodes, edges: s.edges }),
    },
  ),
);

/** 画布上未实现的节点（导出前提醒用户） */
export function unimplementedOnCanvas(nodes: FlowNode[]): string[] {
  const names = new Set<string>();
  for (const n of nodes) {
    if (!isNodeImplemented(n.data.descriptorName)) names.add(n.data.descriptorName);
  }
  return [...names];
}
