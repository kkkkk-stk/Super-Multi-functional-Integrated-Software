import * as ProgressPrimitive from "@radix-ui/react-progress";
import * as React from "react";

import { cn } from "@/lib/utils";

export interface ProgressProps
  extends React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> {
  value?: number | null;
  /** 总量未知时的"不确定进度"（走 shimmer 动画） */
  indeterminate?: boolean;
  indicatorClassName?: string;
}

/**
 * 进度条。
 *
 * `value === null/undefined` 或 `indeterminate` 时画不确定态 ——
 * 后端 `JobProgress.value` 为 `None` 就表示"总量未知"（见 job.rs），
 * 这时候**不能**显示 0%，那会让人以为卡住了。
 */
export const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  ProgressProps
>(({ className, value, indeterminate, indicatorClassName, ...props }, ref) => {
  const unknown = indeterminate || value === null || value === undefined;
  const pct = unknown ? 100 : Math.max(0, Math.min(100, (value ?? 0) * 100));
  return (
    <ProgressPrimitive.Root
      ref={ref}
      // Radix 的 aria 值统一用 0..100；不确定态交给 aria-valuetext 说明
      value={unknown ? null : pct}
      aria-valuetext={unknown ? "进行中（总量未知）" : `${Math.round(pct)}%`}
      className={cn(
        "relative h-2 w-full overflow-hidden rounded-full bg-secondary",
        className,
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className={cn(
          "h-full w-full flex-1 rounded-full bg-primary transition-transform duration-300",
          unknown && "shine bg-primary/40",
          indicatorClassName,
        )}
        style={{ transform: unknown ? undefined : `translateX(-${100 - pct}%)` }}
      />
    </ProgressPrimitive.Root>
  );
});
Progress.displayName = "Progress";
