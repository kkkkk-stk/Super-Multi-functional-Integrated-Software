import { motion } from "framer-motion";
import {
  Bot,
  Boxes,
  CheckCircle2,
  CircleSlash,
  KeyRound,
  Loader2,
  Package,
  ShieldAlert,
} from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { pluginCategoryLabel, runtimeKindLabel } from "@/hooks/use-plugins";
import { RISK_LABELS } from "@/lib/capability";
import { RISK_STYLES } from "@/lib/theme";
import { cn } from "@/lib/utils";
import type { PluginSummary } from "@/types/domain";

/**
 * 插件卡片。
 *
 * 卡片上有三类信息是**必须**一眼可见的（它们决定用户敢不敢点开）：
 * 1. `riskLevel` —— 用彩色边框 + 徽章标出（critical 红、high 橙、medium 黄、low 灰）；
 * 2. 是否还有**未授权的声明能力**（`hasPendingPermissions`）—— 有就明确提示；
 * 3. 是否是 **AI 生成**的（`aiGenerated`）—— 心理防线要提前建立。
 */
export function PluginCard({
  summary,
  onOpen,
  onToggleEnabled,
  busy = false,
}: {
  summary: PluginSummary;
  onOpen: (pluginId: string) => void;
  onToggleEnabled: (pluginId: string, enabled: boolean) => void;
  busy?: boolean;
}) {
  const risk = RISK_STYLES[summary.riskLevel];
  const [toggling, setToggling] = React.useState(false);

  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.18 }}
      className={cn(
        "group flex h-full flex-col gap-3 rounded-lg border-2 bg-card/50 p-4 transition-colors",
        summary.enabled ? risk.border : "border-border/50",
        summary.riskLevel === "critical" && "bg-risk-critical/[0.04]",
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
            summary.enabled ? "bg-primary/15" : "bg-muted/40",
          )}
        >
          <Package className="h-5 w-5 text-muted-foreground" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => onOpen(summary.id)}
              className="truncate text-sm font-semibold hover:text-primary"
              aria-label={`查看插件 ${summary.name} 的详情`}
            >
              {summary.name}
            </button>
            <span className="tabular text-[11px] text-muted-foreground">v{summary.version}</span>
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {summary.description ?? "（该插件没有写描述）"}
          </p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/70">
            {summary.id}
          </p>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <Switch
            checked={summary.enabled}
            disabled={busy || toggling}
            onCheckedChange={(next) => {
              setToggling(true);
              onToggleEnabled(summary.id, next);
              window.setTimeout(() => setToggling(false), 600);
            }}
            aria-label={summary.enabled ? `停用 ${summary.name}` : `启用 ${summary.name}`}
          />
          {toggling && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline">{pluginCategoryLabel(summary.category)}</Badge>
        <Badge variant="secondary">{runtimeKindLabel(summary.runtimeKind)}</Badge>
        <Badge variant={summary.riskLevel}>{RISK_LABELS[summary.riskLevel]}</Badge>
        {summary.builtin && (
          <Badge variant="outline">
            <Boxes className="h-3 w-3" /> 内置
          </Badge>
        )}
        {summary.aiGenerated && (
          <Badge variant="warning">
            <Bot className="h-3 w-3" /> AI 生成
          </Badge>
        )}
        {summary.aiGenerated && !summary.reviewed && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="destructive">
                <ShieldAlert className="h-3 w-3" /> 未经人工审核
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="top">
              该插件的溯源信息里没有"已审核"记录，请自行阅读清单与代码。
            </TooltipContent>
          </Tooltip>
        )}
        {summary.hasPendingPermissions && (
          <Badge variant="high">
            <KeyRound className="h-3 w-3" /> 有未授权项
          </Badge>
        )}
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          {summary.enabled ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-success" />
          ) : (
            <CircleSlash className="h-3.5 w-3.5" />
          )}
          权限 <span className="tabular text-foreground">{summary.grantedCount}</span>/
          <span className="tabular">{summary.permissionCount}</span> 已授权
        </span>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => onOpen(summary.id)}>
          详情
        </Button>
      </div>

      {summary.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {summary.tags.slice(0, 5).map((tag) => (
            <span key={tag} className="rounded bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
              #{tag}
            </span>
          ))}
        </div>
      )}
    </motion.div>
  );
}
