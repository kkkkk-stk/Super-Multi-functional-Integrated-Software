import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  AlertTriangle,
  CheckCircle2,
  FileCode2,
  Info,
  Network,
  ShieldAlert,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import {
  capabilityEnforcement,
  capabilityFingerprint,
  capabilityRisk,
  capabilityWarning,
  describeCapability,
  RISK_LABELS,
} from "@/lib/capability";
import { cn } from "@/lib/utils";
import type { Capability, RiskLevel, RuntimeKind } from "@/types/domain";

/**
 * # 权限确认面板（安全模型在前端的落地点）
 *
 * 这是整个应用里**唯一**能把 `permissionsAcknowledged` 置为 true 的地方。
 * 它刻意做了这些"不讨喜"的设计：
 *
 * 1. **默认全不勾选**。声明 ≠ 授权，最小授权是默认值；
 * 2. **没有"全选"按钮**。这是故意的 —— 有了它，用户就会闭着眼点它，
 *    逐条阅读的意义就没了。要全选就得自己一条条点；
 * 3. **按风险着色**：low 灰 / medium 黄 / high 橙 / **critical 红底 + 图标 + 抖动**；
 * 4. `exec` 与 `net{hosts: []}` 这类必须是**额外警示文案**（见 capabilityWarning）；
 * 5. **L3 Python 插件**必须再勾一个"我已阅读其代码"，
 *    否则确认按钮保持禁用（后端 `plugins_install` 也会再拦一次）；
 * 6. 勾选数量实时汇总，让用户对自己放开了多少心里有数。
 *
 * 组件是**受控**的：`selected` 由调用方持有，安装时把它直接交给
 * `plugins_grant` 的 `granted`（`PermissionSet` 结构体，且元素直接复用后端给过的能力对象，
 * 保证指纹与后端逐字节一致）。
 */

export interface PermissionGateProps {
  capabilities: Capability[];
  /** 已勾选的能力指纹集合 */
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
  /** 运行时类型：`python` 会要求额外确认 */
  runtimeKind?: RuntimeKind;
  /** L3 的额外确认开关 */
  codeReadAcknowledged?: boolean;
  onCodeReadAcknowledgedChange?: (value: boolean) => void;
  /** 从"声明但未授予"出发时的提示（详情页复用同一个组件） */
  granted?: Set<string>;
  disabled?: boolean;
  className?: string;
}

const RISK_ORDER: RiskLevel[] = ["critical", "high", "medium", "low"];

const RISK_BOX: Record<RiskLevel, string> = {
  low: "border-border/60 bg-muted/20",
  medium: "border-risk-medium/50 bg-risk-medium/[0.07]",
  high: "border-risk-high/60 bg-risk-high/[0.09]",
  critical: "border-risk-critical/70 bg-risk-critical/[0.12]",
};

export function PermissionGate({
  capabilities,
  selected,
  onSelectedChange,
  runtimeKind,
  codeReadAcknowledged = false,
  onCodeReadAcknowledgedChange,
  granted,
  disabled = false,
  className,
}: PermissionGateProps) {
  const reduced = useReducedMotion();

  // 高风险排前面：用户从上往下读，先看到最该警惕的
  const ordered = React.useMemo(
    () =>
      [...capabilities].sort((a, b) => {
        const ra = RISK_ORDER.indexOf(capabilityRisk(a));
        const rb = RISK_ORDER.indexOf(capabilityRisk(b));
        if (ra !== rb) return ra - rb;
        return describeCapability(a).localeCompare(describeCapability(b));
      }),
    [capabilities],
  );

  const toggle = (cap: Capability, next: boolean) => {
    const key = capabilityFingerprint(cap);
    const set = new Set(selected);
    if (next) set.add(key);
    else set.delete(key);
    onSelectedChange(set);
  };

  const selectedCount = ordered.filter((c) => selected.has(capabilityFingerprint(c))).length;
  const criticalCount = ordered.filter(
    (c) => capabilityRisk(c) === "critical" && selected.has(capabilityFingerprint(c)),
  ).length;

  const isPython = runtimeKind === "python";
  const codeAckOk = !isPython || codeReadAcknowledged;
  const manifestIsEmpty = ordered.length === 0;

  return (
    <div className={cn("space-y-3", className)}>
      {/* 汇总 */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs">
        <ShieldAlert className="h-4 w-4 text-muted-foreground" />
        <span>
          该插件声明了 <b className="tabular">{ordered.length}</b> 项能力，
          你已勾选 <b className="tabular text-primary">{selectedCount}</b> 项
        </span>
        {criticalCount > 0 && (
          <Badge variant="critical">其中 {criticalCount} 项为极高风险</Badge>
        )}
        {manifestIsEmpty && <span className="text-muted-foreground">（该插件不申请任何能力）</span>}
      </div>

      {!manifestIsEmpty && (
        <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          默认全部不勾选，这是刻意的最小授权设计。「逐条读一遍再决定」：
          没勾的能力，插件在运行时一旦尝试使用就会被拦截，并记录一条安全审计。
        </p>
      )}

      {/* 逐条能力 */}
      <ul className="space-y-2" role="list">
        <AnimatePresence initial={false}>
          {ordered.map((cap) => {
            const risk = capabilityRisk(cap);
            // 强制程度与运行时有关：同一个 `net` 在 L2（真的交给沙箱）与
            // L3（只有默认断网）下不是一回事，所以要把运行时传进去。
            const enforcement = capabilityEnforcement(cap, runtimeKind);
            const key = capabilityFingerprint(cap);
            const checked = selected.has(key);
            const wasGranted = granted?.has(key) ?? false;
            const warning = capabilityWarning(cap);
            const critical = risk === "critical";

            return (
              <motion.li
                key={key}
                layout="position"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                className={cn(
                  "rounded-lg border p-3 transition-colors",
                  RISK_BOX[risk],
                  checked && "ring-1 ring-primary/40",
                )}
              >
                <div className="flex items-start gap-3">
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(next) => toggle(cap, next)}
                    disabled={disabled}
                    label={`授权：${describeCapability(cap)}`}
                    className="mt-0.5"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <CapabilityIcon kind={cap.kind} className="h-3.5 w-3.5" />
                      <span className="text-sm font-medium">{describeCapability(cap)}</span>
                      <Badge variant={risk}>{RISK_LABELS[risk]}</Badge>
                      {critical && !reduced && (
                        <motion.span
                          animate={{ x: [0, -3, 3, -2, 2, 0] }}
                          transition={{ duration: 0.5, delay: 0.15 }}
                          className="text-risk-critical"
                          aria-label="极高风险"
                        >
                          <AlertTriangle className="h-3.5 w-3.5" />
                        </motion.span>
                      )}
                      {wasGranted && <Badge variant="outline">此前已授权</Badge>}
                    </div>

                    <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/80">
                      {key}
                    </p>

                    {/* 授权界面的义务：说清"这一项宿主到底管不管"。
                        打勾给人的暗示是"宿主会按这个勾拦住"，而 exec / env / ai / gpu
                        目前根本没有运行时调用点（详见 SECURITY.md §9）——
                        不说的话，用户会以为自己刚刚做了一次有意义的安全决策。

                        反过来，**已经强制的能力也要说**：`fsRead/fsWrite` 与
                        L2 的 `net` 是真的会拦的，只标"没强制"会让用户以为这套
                        授权全是摆设。两句话都有价值，都写。 */}
                    {enforcement.note && (
                      <p
                        className={cn(
                          "mt-1 flex items-start gap-1.5 text-[11px]",
                          enforcement.level === "enforced"
                            ? "text-muted-foreground"
                            : "text-risk-medium",
                        )}
                      >
                        {enforcement.level === "enforced" ? (
                          <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0" />
                        ) : (
                          <Info className="mt-0.5 h-3 w-3 shrink-0" />
                        )}
                        <span>
                          {enforcement.level === "enforced" && (
                            <span className="font-medium">宿主会按这一项拦。 </span>
                          )}
                          {enforcement.level === "partial" && (
                            <span className="font-medium">宿主只强制了一部分。 </span>
                          )}
                          {enforcement.level === "inert" && (
                            <span className="font-medium">宿主尚未在运行时强制这一项。 </span>
                          )}
                          {enforcement.note}
                        </span>
                      </p>
                    )}

                    {warning && (
                      <p
                        className={cn(
                          "mt-1.5 flex items-start gap-1.5 text-[11px]",
                          critical ? "text-risk-critical" : "text-risk-high",
                        )}
                      >
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                        {warning}
                      </p>
                    )}

                    {cap.kind === "net" && cap.hosts.length === 0 && (
                      <p className="mt-1 flex items-center gap-1.5 text-[11px] text-risk-high">
                        <Network className="h-3 w-3" />
                        空 host 列表 = 任意主机。如果这不是必需的，请考虑让作者改成白名单。
                      </p>
                    )}
                    {cap.kind === "exec" && (
                      <p className="mt-1 flex items-center gap-1.5 text-[11px] text-risk-critical">
                        <Terminal className="h-3 w-3" />
                        等价于任意代码执行：插件可以启动系统上的任何程序。
                      </p>
                    )}
                  </div>
                </div>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>

      {/* L3 的额外确认 */}
      {isPython && (
        <>
          <Separator />
          <label
            className={cn(
              "flex items-start gap-3 rounded-lg border p-3",
              codeReadAcknowledged
                ? "border-success/50 bg-success/[0.07]"
                : "border-risk-critical/70 bg-risk-critical/[0.1]",
            )}
          >
            <Checkbox
              checked={codeReadAcknowledged}
              onCheckedChange={(v) => onCodeReadAcknowledgedChange?.(v)}
              disabled={disabled}
              label="我已阅读该插件的 Python 代码"
              className="mt-0.5"
            />
            <span className="text-xs">
              <span className="flex items-center gap-1.5 font-medium">
                <FileCode2 className="h-3.5 w-3.5" />
                我已阅读该插件的 Python 代码（L3 可执行插件必填）
              </span>
              <span className="mt-1 block text-muted-foreground">
                L3 插件以你的身份运行独立 Python 进程。宿主的隔离（清空环境变量、锁定工作目录、
                默认禁网、逐次能力裁决）只能挡住「非蓄意的越权」，挡不住恶意代码。
                必须逐行读过 <span className="font-mono">main.py</span> 之类的入口文件之后才应勾选。
              </span>
            </span>
          </label>
        </>
      )}

      {/* 阻塞提示 */}
      {!codeAckOk && (
        <p className="flex items-center gap-1.5 text-xs text-risk-critical">
          <ShieldAlert className="h-3.5 w-3.5" />
          勾选"我已阅读其代码"后才能继续（后端也会拒绝未确认的 L3 安装）。
        </p>
      )}
      {codeAckOk && selectedCount === 0 && !manifestIsEmpty && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CheckCircle2 className="h-3.5 w-3.5" />
          一项都没勾也可以安装 —— 插件会被装载但跑不动任何操作，之后随时可以再来授权。
        </p>
      )}
    </div>
  );
}

function CapabilityIcon({ kind, className }: { kind: Capability["kind"]; className?: string }) {
  switch (kind) {
    case "net":
      return <Network className={className} />;
    case "exec":
      return <Terminal className={className} />;
    case "ai":
      return <CheckCircle2 className={className} />;
    default:
      return <ShieldAlert className={className} />;
  }
}

/** 便捷：从"已授予"的能力数组生成指纹集合 */
export function fingerprintSet(caps: Capability[]): Set<string> {
  return new Set(caps.map((c) => capabilityFingerprint(c)));
}

/** 便捷：只勾选声明的子集（用于"按已授权初始化"的场景） */
export function restrictToDeclared(
  selected: Set<string>,
  declared: Capability[],
): Set<string> {
  const allowed = new Set(declared.map((c) => capabilityFingerprint(c)));
  return new Set([...selected].filter((key) => allowed.has(key)));
}
