import {
  AlertTriangle,
  CheckCircle2,
  FileCode2,
  FolderOpen,
  Hash,
  Loader2,
  PackagePlus,
  ShieldAlert,
  Upload,
} from "lucide-react";
import * as React from "react";

import { PermissionGate } from "@/components/plugins/permission-gate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, Textarea } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { useInstallPlugin, useValidatePlugin } from "@/hooks/use-plugins";
import { requiresCodeAcknowledgement, runtimeKindLabelOf, sniffRuntimeKind } from "@/lib/plugin-text";
import { pickDirectory } from "@/lib/system";
import { cn } from "@/lib/utils";
import type { InstallReport, PluginSource, RuntimeKind, ValidatePluginResponse } from "@/types/domain";

/**
 * 插件来源面板 + 安装确认流程。
 *
 * ## 三种来源
 *
 * | 来源 | 载荷 | 典型场景 |
 * |---|---|---|
 * | 本地目录 | `{ kind: "directory", path }` | 手写插件、从别处拷来的插件目录 |
 * | 单个清单 | `{ kind: "manifest", yaml }` | 只有一段 L1 YAML，粘进来就能用 |
 * | 多文件包 | `{ kind: "bundle", yaml, files }` | **AI 生成的草稿**（见 AiStudio） |
 *
 * ## 流程（每一步都对应后端的一道真实检查）
 *
 * ```text
 * 选来源 → plugins_validate（不落盘，先看看）
 *        → 展示 ValidationReport + 逐条权限（默认全不勾）
 *        → plugins_install（permissionsAcknowledged 必须为 true）
 *        → 展示 InstallReport：校验 / 内容哈希 / 新增能力（扩权标红）
 * ```
 *
 * ⚠️ **安装 ≠ 可用**：装完插件仍是"未启用 + 零授权"，要再走 `plugins_grant`
 * 与 `plugins_set_enabled`。这是刻意的两步设计。
 */

export interface InstallOutcome {
  report: InstallReport;
}

export function PluginSources({ className }: { className?: string }) {
  const validate = useValidatePlugin();
  const install = useInstallPlugin();

  const [directoryPath, setDirectoryPath] = React.useState("");
  const [yaml, setYaml] = React.useState("");
  const [source, setSource] = React.useState<PluginSource | null>(null);
  const [report, setReport] = React.useState<InstallReport | null>(null);

  const runtimeKind: RuntimeKind | null = React.useMemo(() => {
    if (report) return report.summary.runtimeKind;
    if (!source) return null;
    if (source.kind === "manifest") return sniffRuntimeKind(source.yaml);
    if (source.kind === "bundle") return sniffRuntimeKind(source.yaml);
    // 目录来源：前端读不到 plugin.yaml（fs 能力范围有限），按"需要确认"处理
    return null;
  }, [source, report]);

  return (
    <div className={cn("space-y-4", className)}>
      <div className="grid gap-4 md:grid-cols-2">
        {/* 目录来源 */}
        <section className="space-y-2 rounded-lg border border-border/60 p-4">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <FolderOpen className="h-4 w-4 text-muted-foreground" />
            从本地目录安装
          </h3>
          <p className="text-xs text-muted-foreground">
            选择包含 <span className="font-mono">plugin.yaml</span> 的目录。
            适合手写插件、或从别人那里拷过来的整包插件。
          </p>
          <div className="flex items-center gap-2">
            <Input
              value={directoryPath}
              onChange={(e) => setDirectoryPath(e.target.value)}
              placeholder="D:\\plugins\\my-plugin"
              aria-label="插件目录路径"
              className="h-8 font-mono text-xs"
            />
            <Button
              size="sm"
              variant="outline"
              className="h-8 shrink-0 text-xs"
              onClick={async () => {
                const dir = await pickDirectory({ title: "选择插件目录" });
                if (dir) setDirectoryPath(dir);
              }}
            >
              选择…
            </Button>
          </div>
          <Button
            size="sm"
            className="h-8 gap-1.5 text-xs"
            disabled={!directoryPath.trim() || validate.isPending}
            onClick={() => {
              setReport(null);
              const src: PluginSource = { kind: "directory", path: directoryPath.trim() };
              setSource(src);
              validate.mutate({ source: src });
            }}
          >
            {validate.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            校验这个目录
          </Button>
        </section>

        {/* 粘贴清单 */}
        <section className="space-y-2 rounded-lg border border-border/60 p-4">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <FileCode2 className="h-4 w-4 text-muted-foreground" />
            粘贴插件清单（L1）
          </h3>
          <p className="text-xs text-muted-foreground">
            只要一段 <span className="font-mono">plugin.yaml</span> 就能装。
            注意形状是{" "}
            <span className="font-mono">permissions: {"{ capabilities: [ ... ] }"}</span>
            —— `PermissionSet` 是带 `capabilities` 字段的结构体，写成裸数组{" "}
            <span className="font-mono">permissions: [ ... ]</span> 会被后端拒绝。
          </p>
          <Textarea
            value={yaml}
            onChange={(e) => setYaml(e.target.value)}
            placeholder={"apiVersion: toolforge/v1\nkind: Plugin\nmetadata:\n  id: com.user.demo\n  ..."}
            aria-label="插件清单 YAML"
            className="h-28 font-mono text-[11px]"
          />
          <Button
            size="sm"
            className="h-8 gap-1.5 text-xs"
            disabled={!yaml.trim() || validate.isPending}
            onClick={() => {
              setReport(null);
              const src: PluginSource = { kind: "manifest", yaml };
              setSource(src);
              validate.mutate({ source: src });
            }}
          >
            <Upload className="h-3.5 w-3.5" />
            校验这段清单
          </Button>
        </section>
      </div>

      {/* 校验结果 + 安装确认 */}
      {source && (
        <>
          <Separator />
          <InstallConfirmPanel
            source={source}
            runtimeKind={runtimeKind}
            validation={validate.data}
            validating={validate.isPending}
            validateError={validate.error}
            installing={install.isPending}
            onInstall={(payload) => {
              install.mutate(payload, {
                onSuccess: (r) => {
                  setReport(r);
                  setSource(null);
                  setYaml("");
                  setDirectoryPath("");
                },
              });
            }}
          />
        </>
      )}

      {/* 安装报告 */}
      {report && <InstallReportView report={report} onDismiss={() => setReport(null)} />}
    </div>
  );
}

/** 校验 + 逐条权限 + 安装按钮（AiStudio 也复用它） */
export function InstallConfirmPanel({
  source,
  runtimeKind,
  validation,
  validating,
  validateError,
  installing,
  onInstall,
  codeAckOverride,
}: {
  source: PluginSource;
  runtimeKind: RuntimeKind | null;
  validation?: ValidatePluginResponse;
  validating: boolean;
  validateError: unknown;
  installing: boolean;
  onInstall: (payload: {
    source: PluginSource;
    overwrite: boolean;
    permissionsAcknowledged: boolean;
    executableCodeAcknowledged: boolean;
  }) => void;
  /** AiStudio 用它把"已读代码"的勾选状态提到外面一起管理 */
  codeAckOverride?: { value: boolean; onChange: (v: boolean) => void };
}) {
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [codeAckInternal, setCodeAckInternal] = React.useState(false);
  const [overwrite, setOverwrite] = React.useState(false);

  const codeAck = codeAckOverride?.value ?? codeAckInternal;
  const setCodeAck = codeAckOverride?.onChange ?? setCodeAckInternal;

  // 换来源就重置勾选：上一份清单的同意不能自动延续到下一份
  React.useEffect(() => {
    setSelected(new Set());
    setCodeAck(false);
    setOverwrite(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  const needsCodeAck = requiresCodeAcknowledgement(runtimeKind);
  const hasErrors =
    validation?.validation.ok === false ||
    (validation?.validation.issues.some((i) => i.severity === "error") ?? false);

  const blocked =
    validating || hasErrors || (needsCodeAck && !codeAck) || !validation || installing;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{runtimeKindLabelOf(runtimeKind)}</Badge>
        {validation && (
          <>
            {validation.validation.ok ? (
              <Badge variant="success">
                <CheckCircle2 className="h-3 w-3" /> 静态校验通过
              </Badge>
            ) : (
              <Badge variant="destructive">
                <AlertTriangle className="h-3 w-3" /> 校验未通过
              </Badge>
            )}
            {validation.missingEngines.length > 0 && (
              <Badge variant="warning">
                缺少引擎：{validation.missingEngines.join("、")}
              </Badge>
            )}
          </>
        )}
      </div>

      {validating && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          正在静态校验（不落盘）…
        </p>
      )}

      {validateError != null && (
        <p className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-xs text-destructive">
          校验请求失败：{String((validateError as { message?: string }).message ?? validateError)}
        </p>
      )}

      {validation && validation.validation.issues.length > 0 && (
        <ul className="space-y-1 rounded-md border border-border/60 p-3" role="list">
          {validation.validation.issues.map((issue, idx) => (
            <li key={`${issue.code}-${idx}`} className="flex items-start gap-2 text-xs">
              <Badge
                variant={
                  issue.severity === "error"
                    ? "destructive"
                    : issue.severity === "warning"
                      ? "warning"
                      : "outline"
                }
                className="mt-0.5 shrink-0"
              >
                {issue.severity === "error" ? "错误" : issue.severity === "warning" ? "警告" : "提示"}
              </Badge>
              <span>
                <code className="font-mono text-[10px] text-muted-foreground">{issue.code}</code>
                <span className="ml-1.5">{issue.message}</span>
                {issue.path && (
                  <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">
                    @{issue.path}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {validation && (
        <>
          <Separator />
          <p className="text-xs font-medium">
            权限清单（默认全不勾选，逐条读一遍再决定）
          </p>
          <PermissionGate
            capabilities={validation.capabilities}
            selected={selected}
            onSelectedChange={setSelected}
            runtimeKind={runtimeKind ?? undefined}
            codeReadAcknowledged={codeAck}
            onCodeReadAcknowledgedChange={setCodeAck}
            disabled={installing}
          />
        </>
      )}

      <Separator />

      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-xs">
          <Checkbox checked={overwrite} onCheckedChange={setOverwrite} label="覆盖同名插件" />
          覆盖同名插件（升级到新版本）
        </label>
        <p className="text-[11px] text-muted-foreground">
          覆盖安装时，宿主会把"新版本多申请的能力"单独标出来 —— 那意味着必须重新人工确认。
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          className="gap-1.5"
          disabled={blocked}
          onClick={() =>
            onInstall({
              source,
              overwrite,
              // 必须为 true —— 这个按钮只有在用户看过权限清单后才可点，后端还会再检查一次
              permissionsAcknowledged: true,
              executableCodeAcknowledged: needsCodeAck ? codeAck : true,
            })
          }
        >
          {installing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <PackagePlus className="h-4 w-4" />
          )}
          安装插件（已确认权限清单）
        </Button>
        {hasErrors && (
          <span className="text-xs text-destructive">
            存在 error 级校验问题，安装会被后端拒绝。请先修正清单。
          </span>
        )}
        {!hasErrors && needsCodeAck && !codeAck && (
          <span className="text-xs text-risk-critical">
            该来源可能是 L3 可执行插件，需要先勾选"我已阅读其代码"。
          </span>
        )}
      </div>
    </div>
  );
}

/** 安装报告：校验 / 内容哈希 / **新增能力（扩权）标红** */
export function InstallReportView({
  report,
  onDismiss,
}: {
  report: InstallReport;
  onDismiss?: () => void;
}) {
  const escalated = report.addedCapabilities.length > 0;

  return (
    <div
      className={cn(
        "space-y-3 rounded-lg border p-4",
        escalated ? "border-destructive/60 bg-destructive/[0.06]" : "border-success/40 bg-success/[0.05]",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={escalated ? "destructive" : "success"}>
          {escalated ? "安装完成，但权限有扩张" : "安装完成"}
        </Badge>
        <span className="text-sm font-medium">{report.summary.name}</span>
        <span className="font-mono text-[11px] text-muted-foreground">{report.summary.id}</span>
        {onDismiss && (
          <Button size="sm" variant="ghost" className="ml-auto h-7 text-xs" onClick={onDismiss}>
            收起
          </Button>
        )}
      </div>

      {/* 扩权：红色单独列出（这是最需要用户注意的部分） */}
      {escalated && (
        <div className="rounded-md border border-destructive/60 bg-destructive/10 p-3">
          <p className="flex items-center gap-1.5 text-xs font-medium text-destructive">
            <ShieldAlert className="h-3.5 w-3.5" />
            相比已装的旧版本，这一版**新增**了 {report.addedCapabilities.length} 项能力：
          </p>
          <ul className="mt-1.5 space-y-1" role="list">
            {report.addedCapabilities.map((cap, idx) => (
              <li key={idx} className="flex items-start gap-1.5 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                {cap}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            新增能力「不会」自动授权：插件仍然是未启用、零授权的状态。
            请到插件详情 → 权限，逐条确认后再启用。
          </p>
        </div>
      )}

      {report.removedCapabilities.length > 0 && (
        <p className="text-xs text-muted-foreground">
          相比旧版本移除了 {report.removedCapabilities.length} 项能力：
          {report.removedCapabilities.join("；")}
        </p>
      )}

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
        <dt className="flex items-center gap-1.5 text-muted-foreground">
          <Hash className="h-3 w-3" /> 内容哈希
        </dt>
        <dd className="break-all font-mono text-[11px]">{report.contentHash}</dd>
        <dt className="text-muted-foreground">落盘位置</dt>
        <dd className="break-all font-mono text-[11px]">{report.installPath}</dd>
        <dt className="text-muted-foreground">校验</dt>
        <dd>
          {report.validation.ok
            ? `通过（${report.validation.issues.length} 项提示）`
            : `未通过（${report.validation.issues.filter((i) => i.severity === "error").length} 个 error）`}
        </dd>
        <dt className="text-muted-foreground">当前权限</dt>
        <dd>
          已授权 {report.summary.grantedCount} / 声明 {report.summary.permissionCount} 项 ·
          {report.summary.enabled ? " 已启用" : " 未启用"}
        </dd>
      </dl>

      {report.validation.issues.length > 0 && (
        <CodeBlock
          title="校验报告（原始问题列表）"
          language="text"
          maxHeight={180}
          code={report.validation.issues
            .map((i) => `[${i.severity}] ${i.code}: ${i.message}${i.path ? ` @${i.path}` : ""}`)
            .join("\n")}
        />
      )}
    </div>
  );
}
