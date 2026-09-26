import { AlertTriangle, FileSearch, FolderOpen, Info, Trash2, X } from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { coerceTextInput, listValueOf, paramToText, toggleListValue, validateParam } from "@/lib/params";
import { isNodeImplemented } from "@/lib/node-support";
import { pickDirectory, pickFiles } from "@/lib/system";
import { cn } from "@/lib/utils";
import { useCanvasStore } from "@/stores/canvas-store";
import type { ParamSpec, ParamValue } from "@/types/domain";

/**
 * 右侧 Inspector：节点的参数表单 + 流水线元信息。
 *
 * 表单**完全由 `ParamSpec` 驱动**（`ParamSpec.type` 决定控件），
 * 因此后端新增一个节点、改一个参数类型，这里不需要任何改动 —— 这是
 * "加功能 = 加一个目录，主程序零改动"在前端侧的兑现方式。
 *
 * 参数值的存储形态就是 `ParamValue`（可判别联合），提交时零转换。
 */
export function InspectorPanel({ onClose }: { onClose?: () => void }) {
  const nodes = useCanvasStore((s) => s.nodes);
  const selectedNodeId = useCanvasStore((s) => s.selectedNodeId);
  const setParamValue = useCanvasStore((s) => s.setParamValue);
  const removeNode = useCanvasStore((s) => s.removeNode);
  const meta = useCanvasStore((s) => s.meta);
  const setMeta = useCanvasStore((s) => s.setMeta);

  const node = nodes.find((n) => n.id === selectedNodeId) ?? null;

  return (
    <aside className="flex h-full min-h-0 w-[320px] shrink-0 flex-col border-l border-border/60">
      <div className="flex items-center gap-2 border-b border-border/60 p-3">
        <p className="flex-1 text-xs font-semibold">
          {node ? "节点参数" : "流水线信息"}
        </p>
        {node && (
          <>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="删除选中节点"
              onClick={() => removeNode(node.id)}
            >
              <Trash2 className="h-3.5 w-3.5 text-destructive" />
            </Button>
            {onClose && (
              <Button size="icon-sm" variant="ghost" aria-label="取消选中" onClick={onClose}>
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3 scrollbar-thin">
        {node ? (
          <div className="space-y-4">
            <div className="space-y-1">
              <p className="text-sm font-medium">{node.data.label}</p>
              <p className="font-mono text-[10px] text-muted-foreground">
                {node.data.descriptorName}
              </p>
              <p className="text-xs text-muted-foreground">{node.data.description}</p>
              <div className="flex flex-wrap gap-1.5 pt-1">
                <Badge variant="outline">{node.id}</Badge>
                {!node.data.available && (
                  <Badge variant="warning">缺引擎 {node.data.missingEngines.join("/")}</Badge>
                )}
                {!isNodeImplemented(node.data.descriptorName) && (
                  <Badge variant="destructive">执行器未实现</Badge>
                )}
              </div>
            </div>

            {!isNodeImplemented(node.data.descriptorName) && (
              <p className="flex items-start gap-1.5 rounded-md border border-warning/50 bg-warning/10 p-2.5 text-[11px] text-warning">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                该能力尚未实现：节点已在目录中登记，但 v0.1 的执行器没有接入它。
                导出的插件里会保留这个步骤，运行时会以「未实现」失败。
              </p>
            )}

            <Separator />

            {/* 参数表单 */}
            {node.data.params.length === 0 ? (
              <p className="text-xs text-muted-foreground">该节点没有可调参数。</p>
            ) : (
              <div className="space-y-3">
                <p className="text-xs font-medium">参数</p>
                {node.data.params.map((spec) => (
                  <ParamField
                    key={spec.id}
                    spec={spec}
                    value={
                      node.data.paramValues[spec.id] ??
                      spec.default ?? { kind: "str", value: "" }
                    }
                    onChange={(value) => setParamValue(node.id, spec.id, value)}
                  />
                ))}
                <p className="flex items-start gap-1.5 text-[10px] text-muted-foreground">
                  <Info className="mt-0.5 h-3 w-3 shrink-0" />
                  参数按 id 写入插件清单的 io.params（内置节点的执行器就是按同名 id 读取的），
                  不写进步骤的 with。同名参数在全画布内只会保留一份。
                </p>
              </div>
            )}
          </div>
        ) : (
          /* 没有选中节点时编辑流水线元信息 */
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              选中画布上的节点可以编辑它的参数。这里编辑的是整条流水线的元信息，
              导出插件时会写进 <span className="font-mono">metadata</span>。
            </p>
            <div className="space-y-2">
              <Label htmlFor="canvas-plugin-id">插件 id</Label>
              <Input
                id="canvas-plugin-id"
                value={meta.pluginId}
                onChange={(e) => setMeta({ pluginId: e.target.value })}
                className="h-8 font-mono text-xs"
                aria-label="插件 id"
              />
              <p className="text-[10px] text-muted-foreground">
                只允许小写字母、数字、点、短横线、下划线，长度 3~128（后端会校验）。
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="canvas-pipeline-name">名称</Label>
              <Input
                id="canvas-pipeline-name"
                value={meta.name}
                onChange={(e) => setMeta({ name: e.target.value })}
                className="h-8 text-xs"
                aria-label="流水线名称"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="canvas-description">描述</Label>
              <Textarea
                id="canvas-description"
                value={meta.description}
                onChange={(e) => setMeta({ description: e.target.value })}
                className="h-20 text-xs"
                aria-label="流水线描述"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="canvas-on-error">单步失败策略</Label>
              <Select
                id="canvas-on-error"
                value={meta.onError}
                onChange={(e) => setMeta({ onError: e.target.value as typeof meta.onError })}
                aria-label="单步失败策略"
                className="h-8 text-xs"
                options={[
                  { value: "fail", label: "中止整个任务（默认）" },
                  { value: "skip", label: "跳过该步继续" },
                  { value: "continue", label: "跳过并把失败原因写入变量" },
                  { value: "retry", label: "重试后仍失败则中止" },
                ]}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="canvas-timeout">整体超时（毫秒，0 = 不限）</Label>
              <Input
                id="canvas-timeout"
                type="number"
                min={0}
                value={meta.timeoutMs}
                onChange={(e) => setMeta({ timeoutMs: Number(e.target.value) || 0 })}
                className="h-8 text-xs"
                aria-label="整体超时毫秒"
              />
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

/** 按 `ParamSpec.type` 渲染对应控件 */
export function ParamField({
  spec,
  value,
  onChange,
}: {
  spec: ParamSpec;
  value: ParamValue;
  onChange: (value: ParamValue) => void;
}) {
  const error = validateParam(spec, value);
  const describedBy = `${spec.id}-desc`;
  const errorId = `${spec.id}-error`;

  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-1.5">
        <Label htmlFor={spec.id} className="text-xs">
          {spec.label}
        </Label>
        {spec.required && <span className="text-risk-high">*</span>}
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">{spec.id}</span>
      </div>

      {spec.description && (
        <p id={describedBy} className="text-[10px] text-muted-foreground">
          {spec.description}
        </p>
      )}

      {renderControl(spec, value, onChange, describedBy, Boolean(error))}

      {error && (
        <p id={errorId} className="text-[10px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function renderControl(
  spec: ParamSpec,
  value: ParamValue,
  onChange: (value: ParamValue) => void,
  describedBy: string,
  hasError: boolean,
): React.ReactNode {
  // 生成类型里 `placeholder` / `min` / `max` / `step` 都是 `… | null`（Rust 侧是
  // `Option` + `skip_serializing_if`），而 DOM 属性只接受 `string | number | undefined`，
  // 所以统一在入口收敛成 undefined。
  const common = {
    id: spec.id,
    "aria-describedby": describedBy,
    "aria-invalid": hasError,
    placeholder: spec.placeholder ?? undefined,
  };

  switch (spec.type) {
    case "bool":
      return (
        <label className="flex items-center gap-2 text-xs">
          <Checkbox
            checked={value.kind === "bool" ? value.value : false}
            onCheckedChange={(checked) => onChange({ kind: "bool", value: checked })}
            label={spec.label}
          />
          <span className="text-muted-foreground">{spec.placeholder ?? "启用"}</span>
        </label>
      );

    case "enum":
      return (
        <Select
          {...common}
          value={value.kind === "str" ? value.value : ""}
          onChange={(e) => onChange({ kind: "str", value: e.target.value })}
          aria-label={spec.label}
          className="h-8 text-xs"
          options={spec.options.map((o) => ({ value: o.value, label: o.label }))}
          placeholder={spec.required ? "请选择" : "（默认）"}
        />
      );

    case "multiEnum": {
      const selected = listValueOf(value);
      return (
        <div className="flex flex-wrap gap-1.5">
          {spec.options.map((option) => {
            const active = selected.includes(option.value);
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={active}
                onClick={() => onChange(toggleListValue(value, option.value))}
                className={cn(
                  "rounded-full border px-2.5 py-0.5 text-[11px] transition-colors",
                  active
                    ? "border-primary bg-primary/15 text-primary"
                    : "border-border text-muted-foreground hover:border-primary/50",
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      );
    }

    case "int":
    case "float":
      return (
        <Input
          {...common}
          type="number"
          min={spec.min ?? undefined}
          max={spec.max ?? undefined}
          step={spec.step ?? (spec.type === "int" ? 1 : 0.1)}
          value={paramToText(value)}
          onChange={(e) => onChange(coerceTextInput(spec, e.target.value))}
          aria-label={spec.label}
          className="h-8 text-xs"
        />
      );

    case "textarea":
      return (
        <Textarea
          {...common}
          value={paramToText(value)}
          onChange={(e) => onChange(coerceTextInput(spec, e.target.value))}
          aria-label={spec.label}
          className="h-24 text-xs"
        />
      );

    case "color":
      return (
        <div className="flex items-center gap-2">
          <input
            id={spec.id}
            type="color"
            value={value.kind === "str" && /^#[0-9a-fA-F]{6}$/.test(value.value) ? value.value : "#ffffff"}
            onChange={(e) => onChange({ kind: "str", value: e.target.value })}
            aria-label={`${spec.label}（颜色选择器）`}
            className="h-8 w-12 rounded border border-input bg-transparent"
          />
          <Input
            value={paramToText(value)}
            onChange={(e) => onChange(coerceTextInput(spec, e.target.value))}
            aria-label={`${spec.label}（颜色值）`}
            placeholder="留空 = 透明"
            className="h-8 flex-1 font-mono text-xs"
          />
        </div>
      );

    case "path":
    case "directory":
      return (
        <div className="flex items-center gap-2">
          <Input
            {...common}
            value={paramToText(value)}
            onChange={(e) => onChange(coerceTextInput(spec, e.target.value))}
            aria-label={spec.label}
            className="h-8 flex-1 font-mono text-[11px]"
          />
          <Button
            size="icon-sm"
            variant="outline"
            aria-label={spec.type === "directory" ? "选择目录" : "选择文件"}
            onClick={async () => {
              if (spec.type === "directory") {
                const dir = await pickDirectory({ title: spec.label });
                if (dir) onChange({ kind: "str", value: dir });
              } else {
                const files = await pickFiles({ title: spec.label, multiple: false });
                if (files[0]) onChange({ kind: "str", value: files[0] });
              }
            }}
          >
            {spec.type === "directory" ? (
              <FolderOpen className="h-3.5 w-3.5" />
            ) : (
              <FileSearch className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      );

    case "keyValue":
    case "text":
    default:
      return (
        <Input
          {...common}
          value={paramToText(value)}
          onChange={(e) => onChange(coerceTextInput(spec, e.target.value))}
          aria-label={spec.label}
          className="h-8 text-xs"
        />
      );
  }
}
