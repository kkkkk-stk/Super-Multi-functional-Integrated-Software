import * as React from "react";

import { cn } from "@/lib/utils";

export const Separator = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { orientation?: "horizontal" | "vertical" }
>(({ className, orientation = "horizontal", ...props }, ref) => (
  <div
    ref={ref}
    role="separator"
    aria-orientation={orientation}
    className={cn(
      "shrink-0 bg-border",
      orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
      className,
    )}
    {...props}
  />
));
Separator.displayName = "Separator";

/**
 * 自定义滚动容器。
 *
 * 这里刻意**不引 `@radix-ui/react-scroll-area`**：依赖清单是锁定的，
 * 而且原生滚动条配上 index.css 里的 `.scrollbar-thin` 在这套深色 UI 里更协调，
 * 还能保留浏览器的键盘 PageUp/PageDown 与滚动锚定。
 */
export const ScrollArea = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { viewportClassName?: string }
>(({ className, viewportClassName, children, ...props }, ref) => (
  <div ref={ref} className={cn("relative overflow-hidden", className)} {...props}>
    <div className={cn("h-full w-full overflow-y-auto scrollbar-thin", viewportClassName)}>
      {children}
    </div>
  </div>
));
ScrollArea.displayName = "ScrollArea";
