import { AlertTriangle, FolderOpen, Info, Play, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { ParamField } from "@/components/pipeline/inspector-panel";
import { FileList } from "@/components/files/file-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { SkeletonRows } from "@/components/ui/skeleton";
import { useNodeCatalog } from "@/hooks/use-pipeline";
import { useDroppedFiles } from "@/hooks/use-drag-drop";
import { usePluginDetail, useRunPlugin } from "@/hooks/use-plugins";
import { useSettings } from "@/hooks/use-settings";
import { isNodeImplemented } from "@/lib/node-support";
import { initialParamValues, validateParams } from "@/lib/params";
import { pickDirectory, pickFiles } from "@/lib/system";
import { cn } from "@/lib/utils";
import type { ParamValue } from "@/types/domain";

/**
 * 插件运行器（格式转换 / 图片工具 / 批量处理三个页面共用）。
 *
 * ## 数据来源
 *
 * 输入端口与参数**完全来自 `PluginDetail.manifest.io`**，所以后端新加一个插件，
 * 这三个页面立刻就能用它 —— 不需要在前端写任何插件专属表单。
 *
 * ## 什么时候明确说"跑不了"
 *
 * 插件可能因为三种原因跑不起来，每一种都在这里**提前**告诉用户，
 * 而不是等任务失败：
 * 1. 流水线里有**执行器未实现**的节点（`lib/node-support.ts`）；
 * 2. 节点需要的**引擎缺失**（用 `["nodes"]` 的 availability 判断）；
 * 3. 插件未启用 / 权限未授予（`PluginSummary` 的字段）。
 */
export function PluginRunner({
  pluginId,
  batchMode = false,
  className,
}: {
  pluginId: string;
  /** 批量模式：主输入端口按"多文件"呈现，并提示并发度 */
  batchMode?: boolean;
  className?: string;
}) {
  const { data: detail, isLoading } = usePluginDetail(pluginId);
  const runPlugin = useRunPlugin();
  const catalog = useNodeCatalog();
  const settings = useSettings();

  const [files, setFiles] = React.useState<Record<string, string[]>>({});
  const [outputDir, setOutputDir] = React.useState("");
  const [params, setParams] = React.useState<Record<string, ParamValue>>({});

  // 换插件时重置全部表单（不同插件的端口/参数没有可比性）
  React.useEffect(() => {
    setFiles({});
    setOutputDir("");
    setParams(detail ? initialParamValues(detail.manifest.io.params) : {});
  }, [detail, pluginId]);

  const diagnostics = React.useMemo(() => {
    const empty = { unimplemented: [] as string[], missingEngines: [] as string[] };
    if (!detail) return empty;

    const steps =
      detail.manifest.runtime.kind === "pipeline" ? detail.manifest.runtime.pipeline.steps : [];
    const usedNodes = [...new Set(steps.map((s) => s.uses))];

    // 1) 执行器未实现的节点（前端硬编名单，见 lib/node-support.ts）
    const unimplemented = usedNodes.filter((uses) => !isNodeImplemented(uses));

    // 2) 缺引擎：用节点目录的 missingEngines（引擎 → 需要它的节点）反查
    const catalogData = catalog.data;
    const missingEngines = catalogData
      ? [
          ...new Set(
            Object.entries(catalogData.missingEngines)
              .filter(([, nodes]) => nodes.some((node) => usedNodes.includes(node)))
              .map(([engine]) => engine),
          ),
        ]
      : [];

    return { unimplemented, missingEngines };
  }, [detail, catalog.data]);

  const paramErrors = React.useMemo(
    () => (detail ? validateParams(detail.manifest.io.params, params) : {}),
    [detail, params],
  );

  /**
   * 全窗口拖入的文件直接进**第一个输入端口**。
   *
   * 之所以固定进第一个端口：拖拽本身不携带"这是给哪个端口的"信息，
   * 而绝大多数插件的第一个输入端口就是"源文件"。想精确分配到别的端口，
   * 用端口上的「选择文件」按钮。
   */
  const acceptDropped = React.useCallback(
    (paths: string[]) => {
      const primary = detail?.manifest.io.inputs[0];
      if (!primary) return;
      const multiple = primary.multiple || batchMode;
      setFiles((prev) => ({
        ...prev,
        [primary.id]: multiple
          ? [...new Set([...(prev[primary.id] ?? []), ...paths])]
          : paths.slice(0, 1),
      }));
      toast.info(
        multiple ? `已加入 ${paths.length} 个文件` : "已加入 1 个文件（该端口只接受单个文件）",
      );
    },
    [detail, batchMode],
  );
  useDroppedFiles(acceptDropped);

  const requiredPortsFilled = React.useMemo(() => {
    if (!detail) return false;
    return detail.manifest.io.inputs
      .filter((p) => p.required)
      .every((p) => (files[p.id]?.length ?? 0) > 0);
  }, [detail, files]);

  if (isLoading || !detail) {
    return (
      <div className={cn("space-y-3", className)}>
        <SkeletonRows rows={4} />
      </div>
    );
  }

  const totalFiles = Object.values(files).reduce((acc, list) => acc + list.length, 0);
  const hasParamErrors = Object.keys(paramErrors).length > 0;

  const onRun = () => {
    if (!requiredPortsFilled) {
      toast.error("还有必填的输入端口没有选文件");
      return;
    }
    if (hasParamErrors) {
      toast.error("参数有错误", { description: Object.values(paramErrors)[0] });
      return;
    }
    runPlugin.mutate({
      pluginId: detail.summary.id,
      inputs: files,
      params,
      outputDir: outputDir.trim(),
    });
  };

  return (
    <div className={cn("space-y-4", className)}>
      {/* 诊断横幅：把"为什么跑不了"说在前面 */}
      {diagnostics.unimplemented.length > 0 && (
        <div className="rounded-md border border-warning/60 bg-warning/10 p-3">
          <p className="flex items-center gap-1.5 text-xs font-medium text-warning">
            <AlertTriangle className="h-3.5 w-3.5" />
            该能力尚未实现：这条流水线用到了 v0.1 执行器还没接入的节点
          </p>
          <ul className="mt-1 space-y-0.5" role="list">
            {diagnostics.unimplemented.map((uses) => (
              <li key={uses} className="font-mono text-[11px] text-warning">
                · {uses}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[11px] text-muted-foreground">
            你仍然可以提交，但任务会以「未实现」失败，不会产出文件（后端刻意不返回假的成功）。
          </p>
        </div>
      )}

      {diagnostics.missingEngines.length > 0 && (
        <div className="rounded-md border border-warning/60 bg-warning/10 p-3">
          <p className="flex items-center gap-1.5 text-xs font-medium text-warning">
            <ShieldAlert className="h-3.5 w-3.5" />
            缺少能力引擎：{diagnostics.missingEngines.join("、")}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            请到「设置 → 引擎」安装后再运行；缺引擎时任务会以 ENGINE_MISSING 失败。
          </p>
        </div>
      )}

      {!detail.summary.enabled && (
        <div className="rounded-md border border-border/60 bg-muted/20 p-3 text-xs text-muted-foreground">
          该插件当前「未启用」。请到「插件市场 → 详情」启用后再运行。
        </div>
      )}

      {detail.summary.enabled && detail.summary.grantedCount === 0 && (
        <div className="rounded-md border border-warning/60 bg-warning/10 p-3 text-xs text-warning">
          该插件声明了 {detail.summary.permissionCount} 项能力但一项都没授权，
          运行时任何文件/网络访问都会被拦截。请到插件详情逐条授权。
        </div>
      )}

      {/* 输入端口 */}
      <section className="space-y-3">
        <h3 className="text-sm font-medium">输入</h3>
        {detail.manifest.io.inputs.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            该插件没有声明输入端口 —— 它可能是一个"生成型"插件（无需输入文件）。
          </p>
        ) : (
          detail.manifest.io.inputs.map((port, index) => {
            const list = files[port.id] ?? [];
            const multiple = batchMode || port.multiple;
            return (
              <div key={port.id} className="space-y-2 rounded-lg border border-border/60 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium">
                    {port.label}
                    {port.required && <span className="ml-1 text-risk-high">*</span>}
                  </span>
                  <Badge variant="outline">{port.type}</Badge>
                  {port.accept.length > 0 && (
                    <span className="text-[10px] text-muted-foreground">
                      接受：{port.accept.join("、")}
                    </span>
                  )}
                  <span className="ml-auto flex items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1.5 text-xs"
                      onClick={async () => {
                        const picked = await pickFiles({
                          title: `选择「${port.label}」`,
                          multiple,
                          filters: port.accept.some((a) => a.startsWith("."))
                            ? [{ name: port.label, extensions: port.accept.map((a) => a.replace(/^\./, "")) }]
                            : undefined,
                        });
                        if (picked.length === 0) return;
                        setFiles((prev) => ({
                          ...prev,
                          [port.id]: multiple
                            ? [...new Set([...(prev[port.id] ?? []), ...picked])]
                            : picked.slice(0, 1),
                        }));
                      }}
                    >
                      <FolderOpen className="h-3.5 w-3.5" />
                      选择文件
                    </Button>
                    {list.length > 0 && (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`清空「${port.label}」`}
                        onClick={() => setFiles((prev) => ({ ...prev, [port.id]: [] }))}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </span>
                </div>
                {port.description && (
                  <p className="text-[11px] text-muted-foreground">{port.description}</p>
                )}
                <FileList
                  paths={list}
                  onRemove={(path) =>
                    setFiles((prev) => ({
                      ...prev,
                      [port.id]: (prev[port.id] ?? []).filter((p) => p !== path),
                    }))
                  }
                  onClear={() => setFiles((prev) => ({ ...prev, [port.id]: [] }))}
                  emptyHint={
                    index === 0
                      ? "把文件拖到窗口任意位置，或点「选择文件」。"
                      : "这个端口还没有文件。"
                  }
                  maxVisible={batchMode ? 200 : 60}
                />
                {batchMode && list.length > 1 && (
                  <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Info className="h-3 w-3" />
                    批量模式：{list.length} 个文件会按设置里的并发度
                    （当前 {settings.data?.concurrency ?? "?"}）
                    逐个执行这条流水线。
                  </p>
                )}
              </div>
            );
          })
        )}
      </section>

      {/* 参数 */}
      {detail.manifest.io.params.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-sm font-medium">参数</h3>
          <div className="grid gap-3 md:grid-cols-2">
            {detail.manifest.io.params.map((spec) => (
              <div key={spec.id} className="space-y-1">
                <ParamField
                  spec={spec}
                  value={params[spec.id] ?? spec.default ?? { kind: "str", value: "" }}
                  onChange={(value) => setParams((prev) => ({ ...prev, [spec.id]: value }))}
                />
                {paramErrors[spec.id] && (
                  <p className="text-[10px] text-destructive">{paramErrors[spec.id]}</p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 输出与提交 */}
      <section className="space-y-2">
        <Label htmlFor="runner-output-dir" className="text-xs">
          输出目录
        </Label>
        <div className="flex items-center gap-2">
          <Input
            id="runner-output-dir"
            value={outputDir}
            onChange={(e) => setOutputDir(e.target.value)}
            placeholder={
              settings.data?.defaultOutputDir?.trim()
                ? `留空则用设置里的：${settings.data.defaultOutputDir}`
                : "留空则写到应用数据目录下的 output/"
            }
            className="h-8 font-mono text-xs"
            aria-label="输出目录"
          />
          <Button
            size="sm"
            variant="outline"
            className="h-8 shrink-0 text-xs"
            onClick={async () => {
              const dir = await pickDirectory({ title: "选择输出目录" });
              if (dir) setOutputDir(dir);
            }}
          >
            选择…
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          宿主只允许插件写这个目录（沙箱边界），插件拿不到别的绝对路径。
          {settings.data && !settings.data.keepOriginal && " 当前设置：批量处理时不保留源文件。"}
        </p>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <Button className="gap-1.5" onClick={onRun} disabled={runPlugin.isPending}>
          <Play className="h-4 w-4" />
          {runPlugin.isPending
            ? "提交中…"
            : batchMode && totalFiles > 1
              ? `开始批量处理（${totalFiles} 个文件）`
              : "开始处理"}
        </Button>
        <Button
          variant="outline"
          className="gap-1.5"
          onClick={() => {
            setFiles({});
            setParams(initialParamValues(detail.manifest.io.params));
            setOutputDir("");
          }}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          重置表单
        </Button>
        <span className="text-[11px] text-muted-foreground">
          提交后会立刻返回任务 id，进度在顶栏任务胶囊与任务中心实时更新。
        </span>
      </div>
    </div>
  );
}

/** 从节点目录里找某个节点缺了哪些引擎 */
export function missingEnginesForNode(
  catalog: { missingEngines: Record<string, string[]> },
  nodeName: string,
): string[] {
  return Object.entries(catalog.missingEngines)
    .filter(([, nodes]) => nodes.includes(nodeName))
    .map(([engine]) => engine);
}
