import {
  Ban,
  Bot,
  Loader2,
  PackagePlus,
  ShieldAlert,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";

import { InstallConfirmPanel } from "@/components/plugins/plugin-sources";
import { SecurityReviewPanel } from "@/components/plugins/security-review-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { CodeBlock } from "@/components/ui/code-block";
import { Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { SkeletonCard } from "@/components/ui/skeleton";
import { useGeneratePlugin, useReviewDraft } from "@/hooks/use-ai";
import { ALL_PLUGIN_CATEGORIES, pluginCategoryLabel, useInstallPlugin } from "@/hooks/use-plugins";
import { useSettings } from "@/hooks/use-settings";
import { findManifestText, requiresCodeAcknowledgement, sniffRuntimeKind } from "@/lib/plugin-text";
import { useUiStore } from "@/stores/ui-store";
import type {
  AiGenerateResponse,
  Capability,
  InstallReport,
  PluginSource,
} from "@/types/domain";

/**
 * # AI 工作室
 *
 * 这条链路的**要害不是模型能力，而是流程设计**（见 `crates/toolforge-ai/src/lib.rs` 的模块文档）：
 *
 * ```text
 * ① 生成 → ② 静态校验 → ③ 安全审核 → ④ ★人工确认★ → ⑤ 落盘
 * ```
 *
 * 第 ④ 步**不能自动化**，所以这个页面从头到尾都在强化"这只是一份草稿"：
 * - 生成结果旁边**并排**展示审核报告与原始产物，不给"一键完成"的错觉；
 * - `recommended === false` 时，"安装"必须先勾一个风险自负确认（二次确认）；
 * - 真正的安装仍然走 `PermissionGate`：逐条勾选 + L3 额外确认代码已读；
 * - 丢弃按钮永远和安装按钮同等显眼。
 */
export function AiStudio() {
  const settings = useSettings();
  const generate = useGeneratePlugin();
  const reviewAgain = useReviewDraft();
  const install = useInstallPlugin();

  const [description, setDescription] = React.useState("");
  const [allowPython, setAllowPython] = React.useState(false);
  const [categoryHint, setCategoryHint] = React.useState("");
  const [result, setResult] = React.useState<AiGenerateResponse | null>(null);
  const [report, setReport] = React.useState<InstallReport | null>(null);
  const [showInstall, setShowInstall] = React.useState(false);
  const [riskAccepted, setRiskAccepted] = React.useState(false);
  const [codeAck, setCodeAck] = React.useState(false);
  const [editedYaml, setEditedYaml] = React.useState<string | null>(null);

  const stream = useUiStore((s) => s.aiStream);
  // `Settings.ai` 在生成类型里是可选的（Rust 每个字段都带 `#[serde(default)]`，
  // specta 就把整个结构标成可选），所以这里用可选链。
  const hasKey = settings.data?.ai?.hasKey ?? false;
  const providerLabel = settings.data?.ai?.provider ?? "";
  const modelLabel = settings.data?.ai?.model ?? "";

  const manifestText = React.useMemo(() => {
    if (editedYaml !== null) return editedYaml;
    return result ? (findManifestText(result.draft.files) ?? "") : "";
  }, [result, editedYaml]);

  const runtimeKind = React.useMemo(() => sniffRuntimeKind(manifestText), [manifestText]);
  const needsCodeAck = requiresCodeAcknowledgement(runtimeKind);

  /** 草稿 → 可安装的 Bundle 来源（`plugin.yaml` 走 yaml 字段，其余进 files） */
  const toBundleSource = React.useCallback((): PluginSource | null => {
    if (!result) return null;
    const yaml = manifestText;
    if (!yaml.trim()) return null;
    const files = result.draft.files
      .filter((f) => f.path !== "plugin.yaml")
      .map((f) => ({ path: f.path, content: f.content, encoding: "utf8" as const }));
    return { kind: "bundle", yaml, files };
  }, [result, manifestText]);

  const canGenerate = description.trim().length >= 4 && !generate.isPending;
  const bundleSource = toBundleSource();

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-4 xl:grid-cols-[380px_1fr]">
      {/* ------------------------------------------------ 左：需求输入 */}
      <section className="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1 scrollbar-thin">
        <div className="rounded-lg border border-border/60 bg-card/50 p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="h-4 w-4 text-primary" />
            用一句话描述你想要的工具
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            描述得越具体，生成的清单越可能一次通过。例如"把目录里的 PNG 批量转成 WebP，
            最大宽度 1920，质量 85"。
          </p>

          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="例：把一批图片缩放到最大宽度 1600px，然后转成 WebP，质量 85"
            aria-label="插件需求描述"
            className="mt-3 h-28 text-sm"
          />

          <div className="mt-3 space-y-2">
            <label className="flex items-start gap-2.5 rounded-md border border-border/60 p-2.5">
              <Switch
                checked={allowPython}
                onCheckedChange={setAllowPython}
                aria-label="允许生成 Python 代码插件"
                className="mt-0.5"
              />
              <span className="text-xs">
                <span className="font-medium">允许生成 Python（L3）插件</span>
                <span className="mt-0.5 block text-muted-foreground">
                  默认关闭。开启意味着模型可能产出「可执行代码」，
                  审核报告会直接标成极高风险，并需要你额外确认"已阅读代码"。
                  只有在内置节点确实表达不了计算逻辑时才该打开。
                </span>
              </span>
            </label>

            <div className="flex items-center gap-2">
              <span className="shrink-0 text-xs text-muted-foreground">分类建议</span>
              <Select
                value={categoryHint}
                onChange={(e) => setCategoryHint(e.target.value)}
                aria-label="分类建议"
                className="h-8 text-xs"
                options={[
                  { value: "", label: "（不指定，让模型自己判断）" },
                  ...ALL_PLUGIN_CATEGORIES.map((c) => ({
                    value: c,
                    label: pluginCategoryLabel(c),
                  })),
                ]}
              />
            </div>
          </div>

          <Button
            className="mt-3 w-full gap-1.5"
            disabled={!canGenerate}
            onClick={() => {
              setResult(null);
              setReport(null);
              setShowInstall(false);
              setRiskAccepted(false);
              setEditedYaml(null);
              generate.mutate(
                {
                  description: description.trim(),
                  allowPython,
                  categoryHint: categoryHint || undefined,
                },
                { onSuccess: (r) => setResult(r) },
              );
            }}
          >
            {generate.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Bot className="h-4 w-4" />
            )}
            {generate.isPending ? "生成中…" : "生成插件草稿"}
          </Button>

          {description.trim().length > 0 && description.trim().length < 4 && (
            <p className="mt-1 text-[11px] text-warning">
              需求描述太短了（后端要求至少 4 个字符）。
            </p>
          )}
        </div>

        {/* AI 配置状态 */}
        <div className="rounded-lg border border-border/60 p-4 text-xs">
          <p className="flex items-center justify-between">
            <span className="font-medium">AI 服务</span>
            {hasKey ? (
              <Badge variant="success">已配置 Key</Badge>
            ) : (
              <Badge variant="warning">未配置 Key</Badge>
            )}
          </p>
          <p className="mt-1 text-muted-foreground">
            {providerLabel ? `${providerLabel}` : "（未选择提供方）"}
            {modelLabel ? ` · ${modelLabel}` : ""}
          </p>
          <p className="mt-1.5 text-muted-foreground">
            提供方、端点、模型与 Key 都在设置页维护；Key 只存在本机内存与系统钥匙串里，
            永远不会出现在任何返回给前端的结构里。
          </p>
          <Button asChild size="sm" variant="outline" className="mt-2 h-7 text-xs">
            <Link to="/settings?tab=ai">去设置 AI 服务</Link>
          </Button>
        </div>

        {result && (
          <Button
            variant="ghost"
            className="gap-1.5 text-destructive"
            onClick={() => {
              setResult(null);
              setReport(null);
              setShowInstall(false);
              setEditedYaml(null);
            }}
          >
            <Ban className="h-4 w-4" />
            丢弃这份草稿
          </Button>
        )}
      </section>

      {/* ------------------------------------------------ 右：结果 */}
      <section className="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1 scrollbar-thin">
        {generate.isPending && (
          <div className="space-y-3">
            {stream.text && (
              <div className="rounded-lg border border-border/60 bg-card/40 p-3">
                <p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  模型正在流式输出（{stream.text.length} 字符）…
                  <span className="text-muted-foreground/70">
                    最终结果以命令返回为准，这里只是中间缓冲。
                  </span>
                </p>
                <CodeBlock code={stream.text} language="yaml" maxHeight={220} title="流式输出" />
              </div>
            )}
            <SkeletonCard lines={6} />
            <SkeletonCard lines={4} />
            <p className="text-center text-xs text-muted-foreground">
              生成中：模型在按内置节点目录编排流水线，随后会做静态校验与安全审核。
            </p>
          </div>
        )}

        {!generate.isPending && !result && (
          <div className="flex h-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border/70 p-12 text-center">
            <Sparkles className="h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              左侧写下需求，点"生成插件草稿"。
            </p>
            <p className="max-w-md text-xs text-muted-foreground/80">
              产出永远是「草稿」：不会写盘、不会被装载。你看到的审核报告与权限清单是
              决定"是否安装"的全部依据。
            </p>
          </div>
        )}

        {!generate.isPending && result && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">
                {result.provider} · {result.model}
              </Badge>
              <Badge variant="secondary">{result.draft.files.length} 个文件</Badge>
              {needsCodeAck && <Badge variant="critical">含可执行代码</Badge>}
              <span className="text-xs text-muted-foreground">
                需求：{result.draft.prompt}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-7 text-xs"
                disabled={reviewAgain.isPending}
                onClick={() => {
                  reviewAgain.mutate(manifestText, {
                    onSuccess: (review) => setResult({ ...result, review }),
                  });
                }}
              >
                {reviewAgain.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
                对手改后的清单重新审核
              </Button>
            </div>

            {/* 并排：审核报告 | 产物 */}
            <div className="grid gap-4 lg:grid-cols-2">
              <SecurityReviewPanel review={result.review} />

              <div className="space-y-3">
                {result.draft.files.map((file) => (
                  <CodeBlock
                    key={file.path}
                    code={file.content}
                    title={file.path}
                    language={
                      file.path.endsWith(".py")
                        ? "python"
                        : file.path.endsWith(".yaml") || file.path.endsWith(".yml")
                          ? "yaml"
                          : "text"
                    }
                    maxHeight={file.path === "plugin.yaml" ? 420 : 240}
                  />
                ))}

                {/* 手改清单（重新审核的前提） */}
                <details className="rounded-md border border-border/60 p-3">
                  <summary className="cursor-pointer text-xs font-medium">
                    手动修改清单后再审核（高级）
                  </summary>
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    改完点上面的"重新审核"；安装时使用的是这里的文本，
                    而「不是」模型最初的输出。
                  </p>
                  <Textarea
                    value={manifestText}
                    onChange={(e) => setEditedYaml(e.target.value)}
                    aria-label="手动编辑插件清单"
                    className="mt-2 h-56 font-mono text-[11px]"
                  />
                  {editedYaml !== null && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="mt-2 h-7 text-xs"
                      onClick={() => setEditedYaml(null)}
                    >
                      还原为模型输出
                    </Button>
                  )}
                </details>
              </div>
            </div>

            {/* 底部：安装 / 丢弃 */}
            <Separator />
            <div className="flex flex-wrap items-center gap-3">
              <Button
                className="gap-1.5"
                disabled={!bundleSource || showInstall}
                onClick={() => setShowInstall(true)}
              >
                <PackagePlus className="h-4 w-4" />
                安装（需要逐条确认权限）
              </Button>
              <Button
                variant="outline"
                className="gap-1.5"
                onClick={() => {
                  setResult(null);
                  setReport(null);
                  setShowInstall(false);
                  setEditedYaml(null);
                }}
              >
                <Ban className="h-4 w-4" />
                丢弃
              </Button>
              {!result.review.recommended && (
                <span className="flex items-center gap-1.5 text-xs text-risk-critical">
                  <TriangleAlert className="h-3.5 w-3.5" />
                  审核不建议安装：点"安装"时需要额外二次确认。
                </span>
              )}
            </div>

            {/* 二次确认（仅 recommended=false 时出现） */}
            {showInstall && !result.review.recommended && (
              <label className="flex items-start gap-2.5 rounded-lg border border-risk-critical/70 bg-risk-critical/10 p-3">
                <Checkbox
                  checked={riskAccepted}
                  onCheckedChange={setRiskAccepted}
                  label="我已知悉风险并坚持安装"
                  className="mt-0.5"
                />
                <span className="text-xs text-risk-critical">
                  <span className="font-medium">
                    我已知悉上述风险，并理解"不建议安装"的含义，坚持继续
                  </span>
                  <span className="mt-0.5 block text-muted-foreground">
                    审核报告里存在 critical 级发现（未知节点、矛盾运行时、越权调用等）。
                    装上去之后任务大概率直接失败，最坏情况下可能以你的身份访问文件或网络。
                  </span>
                </span>
              </label>
            )}

            {/* 权限确认 + 安装 */}
            {showInstall && bundleSource && (
              <div className="rounded-lg border border-border/60 p-4">
                <p className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
                  <ShieldAlert className="h-3.5 w-3.5" />
                  以下是这份草稿申请的权限，逐条确认后才会提交给后端安装。
                </p>
                <InstallConfirmPanel
                  source={bundleSource}
                  runtimeKind={runtimeKind}
                  // AI 草稿的权限清单直接来自审核报告对应的 manifest；
                  // 这里复用同一套 PermissionGate，校验结果由后端在安装时再判一次
                  validation={{
                    validation: result.review.validation ?? { ok: true, issues: [] },
                    capabilities: collectCapabilities(result),
                    requiredEngines: [],
                    missingEngines: [],
                  }}
                  validating={false}
                  validateError={null}
                  installing={install.isPending}
                  codeAckOverride={{ value: codeAck, onChange: setCodeAck }}
                  onInstall={(payload) => {
                    // recommended=false 时的二次确认是硬门（按钮在勾选前不可点）
                    if (!result.review.recommended && !riskAccepted) return;
                    install.mutate(payload, {
                      onSuccess: (r) => {
                        setReport(r);
                        setShowInstall(false);
                      },
                    });
                  }}
                />
              </div>
            )}

            {report && (
              <div className="rounded-lg border border-border/60 p-4">
                <p className="text-sm font-medium">安装完成</p>
                <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">
                  {report.installPath}
                  {"\n"}
                  {report.contentHash}
                  {report.addedCapabilities.length > 0
                    ? `\n新增能力（需重新确认）：${report.addedCapabilities.join("；")}`
                    : ""}
                </pre>
                <p className="mt-2 text-xs text-muted-foreground">
                  插件当前是未启用、零授权状态：到
                  <Link to="/plugins" className="mx-1 text-primary hover:underline">
                    插件市场
                  </Link>
                  逐条授权后再启用。
                </p>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

/**
 * 从清单文本里解析出结构化能力清单（用于权限面板逐条勾选）。
 *
 * 为什么要在前端解析：`SecurityReview.capabilities` 只有**中文描述字符串**，
 * 而 `PermissionGate` 需要可判别的能力对象才能按风险着色、按指纹勾选。
 *
 * 解析目标形状（后端 `permission.rs` 与提示词都按这个形状生成）：
 *
 * ```yaml
 * permissions:
 *   capabilities:
 *     - kind: fsRead
 *       scope: { kind: input }        # 也支持块式的 scope:\n  kind: input
 *     - kind: net
 *       hosts: ["api.example.com"]    # 空列表 = 任意主机
 * ```
 *
 * **解析失败一律返回空数组**：宁可让用户在权限面板看到"没有权限"并因此更谨慎，
 * 也不要编造出一份看起来像真的的权限清单。真正的权限判定始终在后端。
 */
function collectCapabilities(result: AiGenerateResponse): Capability[] {
  const yaml = findManifestText(result.draft.files) ?? "";
  const caps: Capability[] = [];

  const lines = yaml.replace(/\r\n/g, "\n").split("\n");
  let kind: string | null = null;
  let scope: string | null = null;
  let inScopeBlock = false;
  let hosts: string[] | null = null;
  let names: string[] | null = null;

  const flush = () => {
    if (!kind) return;
    switch (kind) {
      case "fsRead":
      case "fsWrite": {
        const s = scope ?? "input";
        if (s === "input" || s === "output" || s === "pluginData" || s === "workspace") {
          caps.push({ kind, scope: { kind: s } });
        }
        // `explicit` 只做提示，不放进可勾选列表：它是逃逸舱口，
        // 需要用户逐字核对路径 glob，前端不该给一个"一键勾选"。
        break;
      }
      case "net":
        caps.push({ kind: "net", hosts: hosts ?? [] });
        break;
      case "env":
        caps.push({ kind: "env", names: names ?? [] });
        break;
      case "exec":
        caps.push({ kind: "exec" });
        break;
      case "ai":
        caps.push({ kind: "ai" });
        break;
      case "gpu":
        caps.push({ kind: "gpu" });
        break;
      default:
        break;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    // 条目起点：`- kind: xxx`
    const item = /^\s*-\s*kind:\s*([A-Za-z]+)\s*$/.exec(line);
    if (item) {
      flush();
      kind = item[1] ?? null;
      scope = null;
      hosts = null;
      names = null;
      inScopeBlock = false;
      continue;
    }
    if (!kind) continue;

    // scope 的两种写法
    const inlineScope = /^\s+scope:\s*\{\s*kind:\s*([A-Za-z]+)\s*\}/.exec(line);
    if (inlineScope) {
      scope = inlineScope[1] ?? null;
      inScopeBlock = false;
      continue;
    }
    if (/^\s+scope:\s*$/.test(line)) {
      inScopeBlock = true;
      continue;
    }
    if (inScopeBlock) {
      const blockKind = /^\s+kind:\s*([A-Za-z]+)\s*$/.exec(line);
      if (blockKind) {
        scope = blockKind[1] ?? null;
        inScopeBlock = false;
        continue;
      }
      inScopeBlock = false;
    }

    const inlineHosts = /^\s+hosts:\s*\[(.*)\]\s*$/.exec(line);
    if (inlineHosts) {
      hosts = splitInlineList(inlineHosts[1] ?? "");
      continue;
    }
    const inlineNames = /^\s+names:\s*\[(.*)\]\s*$/.exec(line);
    if (inlineNames) {
      names = splitInlineList(inlineNames[1] ?? "");
    }
  }
  flush();

  return caps;
}

function splitInlineList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}
