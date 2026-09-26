import { useReducedMotion } from "framer-motion";
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * 数字滚动。
 *
 * 用 rAF 手写（而不是引动画库）：仪表盘上可能同时有十几个数字在滚，
 * 每个都挂一个 framer-motion 组件不划算。这里只有一个 rAF 循环、一次 setState/帧，
 * 并且 `prefers-reduced-motion` 时**直接显示终值**。
 */
export interface CountUpProps {
  value: number;
  durationMs?: number;
  decimals?: number;
  suffix?: string;
  prefix?: string;
  className?: string;
  /** 千分位分隔 */
  separator?: boolean;
}

export function CountUp({
  value,
  durationMs = 700,
  decimals = 0,
  suffix = "",
  prefix = "",
  className,
  separator = false,
}: CountUpProps) {
  const reduced = useReducedMotion();
  const [display, setDisplay] = React.useState(value);
  const fromRef = React.useRef(value);
  const startRef = React.useRef(0);
  const frameRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (reduced) {
      setDisplay(value);
      return;
    }
    const from = fromRef.current;
    const delta = value - from;
    if (delta === 0) {
      setDisplay(value);
      return;
    }

    startRef.current = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - startRef.current) / durationMs);
      // easeOutCubic：收尾更自然，不会有"咔"一下停住的感觉
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + delta * eased);
      if (t < 1) {
        frameRef.current = window.requestAnimationFrame(tick);
      } else {
        fromRef.current = value;
        frameRef.current = null;
      }
    };
    frameRef.current = window.requestAnimationFrame(tick);

    return () => {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      fromRef.current = value;
    };
  }, [value, durationMs, reduced]);

  const text = React.useMemo(() => {
    const fixed = display.toFixed(decimals);
    if (!separator) return fixed;
    const [int, frac] = fixed.split(".");
    const withSep = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return frac ? `${withSep}.${frac}` : withSep;
  }, [display, decimals, separator]);

  return (
    <span className={cn("tabular", className)}>
      {prefix}
      {text}
      {suffix}
    </span>
  );
}
