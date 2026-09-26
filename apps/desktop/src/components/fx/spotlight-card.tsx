import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * 光标跟随高光卡片。
 *
 * ## 为什么用 requestAnimationFrame 节流
 *
 * 鼠标每移动 1px 就会触发一次 `mousemove`（高刷屏上每秒数百次）。如果每次都
 * `setState`，React 会在一帧里反复重渲染整棵子树 —— 这就是"炫酷效果把界面拖卡"的
 * 经典成因。
 *
 * 这里的做法：**把坐标直接写进 DOM 的 CSS 变量**（`--spot-x` / `--spot-y`），
 * 完全绕开 React 的渲染；再用 `requestAnimationFrame` 把每帧最多一次写操作合并。
 * 组件状态里**只有 hover 布尔值**，一次进出各渲染一次。
 *
 * 高光本身由 index.css 的 `.spotlight::before` 用 `radial-gradient` 画，
 * 颜色取自 `--glow`，所以换强调色时高光也跟着换。
 */
export interface SpotlightCardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 关闭高光（例如整卡可点击但不需要动效的场合） */
  disableSpotlight?: boolean;
}

export const SpotlightCard = React.forwardRef<HTMLDivElement, SpotlightCardProps>(
  ({ className, children, disableSpotlight = false, onMouseMove, onMouseEnter, onMouseLeave, ...props }, ref) => {
    const innerRef = React.useRef<HTMLDivElement | null>(null);
    const frame = React.useRef<number | null>(null);
    const pending = React.useRef<{ x: number; y: number } | null>(null);
    const [hovered, setHovered] = React.useState(false);

    // 把外部 ref 和内部 ref 合起来用（需要自己的引用来写 CSS 变量）
    const setRefs = React.useCallback(
      (node: HTMLDivElement | null) => {
        innerRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
      },
      [ref],
    );

    const flush = React.useCallback(() => {
      frame.current = null;
      const node = innerRef.current;
      const pos = pending.current;
      if (!node || !pos) return;
      node.style.setProperty("--spot-x", `${pos.x}px`);
      node.style.setProperty("--spot-y", `${pos.y}px`);
    }, []);

    const handleMove = (e: React.MouseEvent<HTMLDivElement>) => {
      onMouseMove?.(e);
      if (disableSpotlight) return;
      const rect = e.currentTarget.getBoundingClientRect();
      pending.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      // 一帧最多写一次
      if (frame.current === null) {
        frame.current = window.requestAnimationFrame(flush);
      }
    };

    React.useEffect(
      () => () => {
        if (frame.current !== null) window.cancelAnimationFrame(frame.current);
      },
      [],
    );

    return (
      <div
        ref={setRefs}
        onMouseMove={handleMove}
        onMouseEnter={(e) => {
          setHovered(true);
          onMouseEnter?.(e);
        }}
        onMouseLeave={(e) => {
          setHovered(false);
          onMouseLeave?.(e);
        }}
        data-hovered={hovered ? "true" : undefined}
        className={cn(
          "relative overflow-hidden rounded-lg border bg-card/60 transition-colors",
          !disableSpotlight && "spotlight",
          "hover:border-primary/40",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    );
  },
);
SpotlightCard.displayName = "SpotlightCard";
