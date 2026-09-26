import { motion } from "framer-motion";
import { AlertTriangle, CheckCircle2, Info, ShieldCheck, XCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { RISK_LABELS } from "@/lib/capability";
import { RISK_STYLES } from "@/lib/theme";
import { cn } from "@/lib/utils";
import type { RiskLevel, SecurityReview } from "@/types/domain";

/**
 * AI 审核报告面板。
 *
 * 展示规则来自 `crates/toolforge-ai/src/review.rs` 的语义：
 * - `riskLevel` 是**所有发现里最高的那一档**（不是平均值）—— 配色必须跟着它走；
 * - `critical` 的发现**置顶并高亮**（用户的注意力有限，先给最该看的）；
 * - `recommended === false` 时要有明确的"不建议安装"横幅；
 * - `parseable === false` 时根本没有清单可装，只展示 parseError。
 *
 * ⚠️ **`recommended === true` 也不代表可以直接装**：真正的门是用户逐条勾选权限
 * （PermissionGate）。这一点必须写在界面上，否则用户会以为"通过审核 = 安全"。
 */

const SEVERITY_ORDER: RiskLevel[] = ["critical", "high", "medium", "low"];

export function SecurityReviewPanel({
  review,
  className,
}: {
  review: SecurityReview;
  className?: string;
}) {
  const ordered = [...review.findings].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );

  const criticals = ordered.filter((f) => f.severity === "critical");
  const highs = ordered.filter((f) => f.severity === "high");
  const others = ordered.filter((f) => f.severity !== "critical" && f.severity !== "high");

  const style = RISK_STYLES[review.riskLevel];

  return (
    <div className={cn("space-y-3", className)}>
      {/* 总览 */}
      <div className={cn("flex flex-wrap items-center gap-3 rounded-lg border p-3", style.border, style.bg)}>
        <span className={cn("text-sm font-semibold", style.text)}>
          整体风险：{RISK_LABELS[review.riskLevel]}
        </span>
        {review.parseable ? (
          <Badge variant="outline">清单可解析</Badge>
        ) : (
          <Badge variant="critical">清单无法解析</Badge>
        )}
        {review.recommended ? (
          <Badge variant="success">
            <CheckCircle2 className="h-3 w-3" /> 建议继续到"人工确认"
          </Badge>
        ) : (
          <Badge variant="destructive">
            <XCircle className="h-3 w-3" /> 不建议安装
          </Badge>
        )}
        {review.runtimeSummary && (
          <span className="text-xs text-muted-foreground">{review.runtimeSummary}</span>
        )}
      </div>

      {!review.recommended && (
        <p className="flex items-start gap-2 rounded-md border border-risk-critical/60 bg-risk-critical/10 p-3 text-xs text-risk-critical">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            静态校验未通过，或者存在 critical 级别的发现（例如未知节点、附带了不该有的代码文件、
            未声明的越权调用）。<b>请不要安装</b>，回到需求描述改一改再生成。
          </span>
        </p>
      )}

      {/* 解析失败 */}
      {!review.parseable && review.parseError && (
        <div className="rounded-md border border-risk-critical/60 bg-risk-critical/10 p-3">
          <p className="text-xs font-medium text-risk-critical">模型输出无法解析成插件清单</p>
          <pre className="mt-1.5 whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
            {review.parseError}
          </pre>
        </div>
      )}

      {/* 静态校验进度（错误 / 警告数量） */}
      {review.validation && (
        <div className="space-y-1.5 rounded-md border border-border/60 p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium">静态校验（PluginManifest::validate）</span>
            <span className="tabular text-muted-foreground">
              {review.validation.issues.length} 项问题
            </span>
          </div>
          <Progress
            value={
              review.validation.issues.length === 0
                ? 1
                : review.validation.issues.filter((i) => i.severity === "error").length /
                  review.validation.issues.length
            }
            className="h-1"
            indicatorClassName={
              review.validation.ok ? "bg-success" : "bg-destructive"
            }
          />
          <p className="text-[11px] text-muted-foreground">
            {review.validation.ok
              ? "没有 error 级问题（warning 仍需要你判断）。"
              : `有 ${review.validation.issues.filter((i) => i.severity === "error").length} 项 error 级问题，安装会被拒绝。`}
          </p>
        </div>
      )}

      {/* 发现列表：critical 置顶 */}
      {ordered.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">
            审核发现（{ordered.length} 条，按严重程度排序）
          </p>
          <ul className="space-y-1.5" role="list">
            {[...criticals, ...highs, ...others].map((finding, idx) => {
              const s = RISK_STYLES[finding.severity];
              return (
                <motion.li
                  key={`${finding.code}-${idx}`}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(idx * 0.02, 0.2) }}
                  className={cn(
                    "rounded-md border p-2.5",
                    s.border,
                    finding.severity === "critical" ? "bg-risk-critical/[0.12]" : "bg-card/40",
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={finding.severity}>{RISK_LABELS[finding.severity]}</Badge>
                    <code className="font-mono text-[10px] text-muted-foreground">
                      {finding.code}
                    </code>
                  </div>
                  <p className={cn("mt-1 text-xs", finding.severity === "critical" && "font-medium")}>
                    {finding.message}
                  </p>
                  {finding.evidence && (
                    <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded bg-black/30 px-2 py-1 font-mono text-[10px] text-muted-foreground">
                      {finding.evidence}
                    </pre>
                  )}
                </motion.li>
              );
            })}
          </ul>
        </div>
      )}

      {/* 需要逐条勾选的能力 */}
      {review.capabilities.length > 0 && (
        <div className="rounded-md border border-border/60 p-3">
          <p className="mb-1.5 text-xs font-medium">
            清单申请的能力（安装前需要逐条确认，共 {review.capabilities.length} 项）
          </p>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {review.capabilities.map((cap, idx) => (
              <li key={idx} className="flex items-start gap-1.5">
                <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0" />
                {cap}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
        <Info className="mt-0.5 h-3 w-3 shrink-0" />
        审核通过 ≠ 可以放心安装。这里只是「静态」检查（能力清单、运行时选择、可疑 API 模式），
        真正的安全边界是下一步由你逐条勾选权限。AI 的产出永远是草稿，安装与否由你决定。
      </p>
    </div>
  );
}
