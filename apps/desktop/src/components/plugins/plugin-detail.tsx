import {
  ExternalLink,
  FileCode2,
  FolderOpen,
  Loader2,
  Package,
  Play,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import * as React from "react";

import { PermissionGate, fingerprintSet } from "@/components/plugins/permission-gate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { capabilityFingerprint, capabilityList, RISK_LABELS, toPermissionSet } from "@/lib/capability";
import { isNodeImplemented } from "@/lib/node-support";
import {
  pluginCategoryLabel,
  runtimeKindLabel,
  useGrantPermissions,
  usePluginDetail,
  useRunPlugin,
  useSetPluginEnabled,
  useUninstallPlugin,
} from "@/hooks/use-plugins";
import { toToolforgeError } from "@/lib/ipc";
import { openExternal, revealInExplorer } from "@/lib/system";
import type { Capability, PipelineStep } from "@/types/domain";

/**
 * 插件详情抽屉。
 *
 * 四个标签页对应四件不同的事：
 * - **概览**：它是什么、装在哪、用了哪些节点（含"未实现"提示）；
 * - **权限**：已授权项预勾选，改完点保存 → `plugins_grant`；
 * - **清单**：原始 YAML（带高亮），这是"看它到底干了什么"的第一手材料；
 * - **文件**：插件目录下的文件列表，方便知道该读哪个。
 */
export function PluginDetailDrawer({
  pluginId,
  open,
  onOpenChange,
  onRequestUninstall,
}: {
  pluginId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRequestUninstall?: (pluginId: string) => void;
}) {
  const { data: detail, isLoading, isError, error } = usePluginDetail(pluginId, open);
  const grant = useGrantPermissions();
  const setEnabled = useSetPluginEnabled();
  const runPlugin = useRunPlugin();
  const uninstall = useUninstallPlugin();

  // 权限编辑的本地勾选态：进入标签页时用"已授权"初始化
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const declared = React.useMemo(
    () => capabilityList(detail?.manifest.permissions),
    [detail],
  );
  const grantedFingerprints = React.useMemo(
    () => (detail ? fingerprintSet(capabilityList(detail.granted)) : new Set<string>()),
    [detail],
  );

  React.useEffect(() => {
    setSelected(grantedFingerprints);
  }, [grantedFingerprints, pluginId]);

  const dirty = React.useMemo(() => {
    if (selected.size !== grantedFingerprints.size) return true;
    for (const key of selected) if (!grantedFingerprints.has(key)) return true;
    return false;
  }, [selected, grantedFingerprints]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Package className="h-4 w-4 text-muted-foreground" />
            {detail?.summary.name ?? "插件详情"}
          </SheetTitle>
          <SheetDescription>
            {detail ? (
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-[11px]">{detail.summary.id}</span>
                <Badge variant="outline">v{detail.summary.version}</Badge>
                <Badge variant="secondary">{runtimeKindLabel(detail.summary.runtimeKind)}</Badge>
                <Badge variant={detail.summary.riskLevel}>
                  {RISK_LABELS[detail.summary.riskLevel]}
                </Badge>
              </span>
            ) : (
              "正在读取清单…"
            )}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-5 scrollbar-thin">
          {isLoading ? (
            <SkeletonRows rows={6} />
          ) : isError || !detail ? (
            <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-4 text-sm">
              <p className="font-medium text-destructive">读取插件详情失败</p>
              <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                {toToolforgeError(error).fullText}
              </p>
            </div>
          ) : (
            <Tabs defaultValue="overview">
              <TabsList>
                <TabsTrigger value="overview">概览</TabsTrigger>
                <TabsTrigger value="permissions">
                  权限（{detail.summary.grantedCount}/{detail.summary.permissionCount}）
                </TabsTrigger>
                <TabsTrigger value="manifest">清单原文</TabsTrigger>
                <TabsTrigger value="files">文件（{detail.files.length}）</TabsTrigger>
              </TabsList>

              {/* ------------------------------------------------ 概览 */}
              <TabsContent value="overview" className="space-y-4">
                {detail.readme && (
                  <section className="rounded-lg border border-border/60 p-3">
                    <h4 className="mb-1 text-xs font-semibold text-muted-foreground">说明</h4>
                    <p className="whitespace-pre-wrap text-sm">{detail.readme}</p>
                  </section>
                )}

                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-lg border border-border/60 p-4 text-xs">
                  <dt className="text-muted-foreground">分类</dt>
                  <dd>{pluginCategoryLabel(detail.summary.category)}</dd>
                  <dt className="text-muted-foreground">作者 / 许可证</dt>
                  <dd>
                    {detail.manifest.metadata.author ?? "（未注明作者）"}
                    {detail.manifest.metadata.license
                      ? ` · ${detail.manifest.metadata.license}`
                      : ""}
                  </dd>
                  <dt className="text-muted-foreground">状态</dt>
                  <dd className="flex items-center gap-2">
                    {detail.summary.enabled ? (
                      <Badge variant="success">已启用</Badge>
                    ) : (
                      <Badge variant="secondary">未启用</Badge>
                    )}
                    {detail.summary.builtin && <Badge variant="outline">随应用内置</Badge>}
                    {detail.summary.hasPendingPermissions && (
                      <Badge variant="high">有未授权项</Badge>
                    )}
                  </dd>
                  {detail.runtimeStatus && (
                    <>
                      <dt className="text-muted-foreground">运行时状态</dt>
                      <dd>{detail.runtimeStatus}</dd>
                    </>
                  )}
                  {detail.summary.installPath && (
                    <>
                      <dt className="text-muted-foreground">安装位置</dt>
                      <dd className="flex items-center gap-2">
                        <span className="break-all font-mono text-[11px]">
                          {detail.summary.installPath}
                        </span>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label="在文件管理器中打开插件目录"
                          onClick={() => void revealInExplorer(detail.summary.installPath ?? "")}
                        >
                          <FolderOpen className="h-3.5 w-3.5" />
                        </Button>
                      </dd>
                    </>
                  )}
                  {detail.manifest.ai?.generated && (
                    <>
                      <dt className="text-muted-foreground">AI 溯源</dt>
                      <dd className="space-y-1">
                        <p>由 {detail.manifest.ai.model ?? "未知模型"} 生成</p>
                        {detail.manifest.ai.prompt && (
                          <p className="text-muted-foreground">
                            原始需求：{detail.manifest.ai.prompt}
                          </p>
                        )}
                        {detail.manifest.ai.sourceHash && (
                          <p className="break-all font-mono text-[10px] text-muted-foreground">
                            {detail.manifest.ai.sourceHash}
                          </p>
                        )}
                      </dd>
                    </>
                  )}
                  {detail.manifest.metadata.homepage && (
                    <>
                      <dt className="text-muted-foreground">主页</dt>
                      <dd>
                        <Button
                          size="sm"
                          variant="link"
                          className="h-6 px-0 text-xs"
                          onClick={() =>
                            void openExternal(detail.manifest.metadata.homepage ?? "")
                          }
                        >
                          <ExternalLink className="h-3 w-3" />
                          {detail.manifest.metadata.homepage}
                        </Button>
                      </dd>
                    </>
                  )}
                </dl>

                {/* 运行时明细 */}
                <section className="rounded-lg border border-border/60 p-4">
                  <h4 className="mb-2 text-xs font-semibold text-muted-foreground">运行时</h4>
                  {detail.manifest.runtime.kind === "pipeline" ? (
                    <PipelineSteps steps={detail.manifest.runtime.pipeline.steps} />
                  ) : detail.manifest.runtime.kind === "wasm" ? (
                    <ul className="space-y-1 text-xs">
                      <li>入口：{detail.manifest.runtime.wasm.path}</li>
                      <li>函数：{detail.manifest.runtime.wasm.entry}()</li>
                      <li>
                        内存上限 {detail.manifest.runtime.wasm.memoryLimitMb} MB · 超时{" "}
                        {detail.manifest.runtime.wasm.timeoutMs} ms
                      </li>
                      <li>
                        宿主函数白名单：
                        {(detail.manifest.runtime.wasm.allowHostFunctions ?? []).length === 0
                          ? "无（完全沙箱）"
                          : (detail.manifest.runtime.wasm.allowHostFunctions ?? []).join("、")}
                      </li>
                    </ul>
                  ) : (
                    <ul className="space-y-1 text-xs">
                      <li>入口：{detail.manifest.runtime.python.entry}</li>
                      <li>Python {detail.manifest.runtime.python.pythonVersion}</li>
                      <li>
                        依赖 {(detail.manifest.runtime.python.requirements ?? []).length} 个包 ·{" "}
                        {detail.manifest.runtime.python.allowNetwork ? "允许联网" : "已禁网"}
                      </li>
                      <li className="text-risk-critical">
                        L3 可执行代码：将以你的身份运行，请自行阅读入口文件。
                      </li>
                    </ul>
                  )}
                </section>

                {/* 操作 */}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant={detail.summary.enabled ? "outline" : "default"}
                    onClick={() =>
                      setEnabled.mutate({
                        pluginId: detail.summary.id,
                        enabled: !detail.summary.enabled,
                      })
                    }
                    disabled={setEnabled.isPending}
                  >
                    {setEnabled.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    {detail.summary.enabled ? "停用插件" : "启用插件"}
                  </Button>

                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    disabled={!detail.summary.enabled || runPlugin.isPending}
                    onClick={() => {
                      const inputs: Record<string, string[]> = {};
                      for (const port of detail.manifest.io.inputs) inputs[port.id] = [];
                      runPlugin.mutate({
                        pluginId: detail.summary.id,
                        inputs,
                        params: {},
                        outputDir: "",
                      });
                    }}
                  >
                    <Play className="h-3.5 w-3.5" />
                    试运行
                  </Button>

                  {onRequestUninstall && !detail.summary.builtin && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="gap-1.5 text-destructive"
                      onClick={() => onRequestUninstall(detail.summary.id)}
                      disabled={uninstall.isPending}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      卸载
                    </Button>
                  )}
                </div>

                {!detail.summary.enabled && (
                  <p className="text-[11px] text-muted-foreground">
                    提示：「试运行」需要在启用插件后才可用；没有输入文件时它只会验证装载链路，
                    不会真的产出文件。
                  </p>
                )}
              </TabsContent>

              {/* ------------------------------------------------ 权限 */}
              <TabsContent value="permissions" className="space-y-4">
                <div className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/20 p-3 text-xs text-muted-foreground">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    这里显示的是「当前已授权」的项（已预勾选）。修改后点保存 →
                    宿主会重新计算"声明 ∩ 已授权"，并卸载重载插件进程，
                    使新权限立即生效。取消勾选随时可以收回权限。
                  </span>
                </div>

                <PermissionGate
                  capabilities={declared}
                  selected={selected}
                  onSelectedChange={setSelected}
                  runtimeKind={detail.summary.runtimeKind}
                  granted={grantedFingerprints}
                  // 精确来源已在权限清单里，这里不再要求"已读代码"（那是安装动作的门）
                  codeReadAcknowledged
                  disabled={grant.isPending}
                />

                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    className="gap-1.5"
                    disabled={!dirty || grant.isPending}
                    onClick={() => {
                      // `granted` 是 PermissionSet 结构体（不是数组），
                      // 且元素直接复用后端给过的能力对象 —— 指纹必须逐字节一致。
                      const caps = declared.filter((c) => selected.has(capabilityKey(c)));
                      grant.mutate({ pluginId: detail.summary.id, granted: toPermissionSet(caps) });
                    }}
                  >
                    {grant.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    保存授权
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!dirty}
                    onClick={() => setSelected(grantedFingerprints)}
                  >
                    放弃修改
                  </Button>
                  {!dirty && (
                    <span className="text-[11px] text-muted-foreground">
                      当前勾选与已授权一致
                    </span>
                  )}
                </div>
              </TabsContent>

              {/* ------------------------------------------------ 清单 */}
              <TabsContent value="manifest" className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  这是磁盘上的原始 <span className="font-mono">plugin.yaml</span>。
                  想知道插件到底会做什么，读它比读任何摘要都可靠。
                </p>
                <CodeBlock code={detail.rawYaml} language="yaml" title="plugin.yaml" maxHeight={560} />
              </TabsContent>

              {/* ------------------------------------------------ 文件 */}
              <TabsContent value="files" className="space-y-3">
                {detail.files.length === 0 ? (
                  <p className="text-sm text-muted-foreground">该插件目录下没有其它文件。</p>
                ) : (
                  <ul className="divide-y divide-border/50 rounded-lg border border-border/60">
                    {detail.files.map((file) => (
                      <li key={file} className="flex items-center gap-2 px-3 py-2 text-xs">
                        <FileCode2 className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="flex-1 break-all font-mono">{file}</span>
                        {file.endsWith(".py") && <Badge variant="critical">可执行</Badge>}
                        {file.endsWith(".wasm") && <Badge variant="outline">WASM</Badge>}
                      </li>
                    ))}
                  </ul>
                )}
                {detail.summary.installPath && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    onClick={() => void revealInExplorer(detail.summary.installPath ?? "")}
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    打开插件目录
                  </Button>
                )}
              </TabsContent>
            </Tabs>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** 流水线步骤：显式标出**执行器未实现**的节点 */
function PipelineSteps({ steps }: { steps: PipelineStep[] }) {
  return (
    <ol className="space-y-1.5">
      {steps.map((step, idx) => {
        const implemented = isNodeImplemented(step.uses);
        return (
          <li key={step.id} className="flex items-start gap-2 text-xs">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted/50 tabular text-[10px]">
              {idx + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium">{step.label ?? step.id}</span>
                <code className="font-mono text-[10px] text-muted-foreground">{step.uses}</code>
                {!implemented && <Badge variant="warning">该能力尚未实现</Badge>}
              </span>
              {Object.keys(step.with).length > 0 && (
                <span className="mt-0.5 block break-all font-mono text-[10px] text-muted-foreground">
                  with: {JSON.stringify(step.with)}
                </span>
              )}
              {!implemented && (
                <span className="mt-0.5 block text-[10px] text-warning">
                  v0.1 的执行器还没接入这个节点，运行时任务会以「未实现」失败。
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** 本地小工具：能力指纹（与 PermissionGate 用同一套实现，避免两处口径漂移） */
function capabilityKey(cap: Capability): string {
  return capabilityFingerprint(cap);
}
