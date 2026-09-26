/**
 * 网格叠层：给"桌面工具"的科技感打底。
 *
 * 用 CSS 渐变画网格（`background-image` 两组 linear-gradient），
 * 再用 mask 让边缘淡出 —— 比 SVG pattern 省一层 DOM，也更好做响应式。
 */
export function GridOverlay({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none fixed inset-0 -z-10 ${className}`}
      style={{
        backgroundImage:
          "linear-gradient(to right, hsl(var(--grid-line) / 0.045) 1px, transparent 1px), linear-gradient(to bottom, hsl(var(--grid-line) / 0.045) 1px, transparent 1px)",
        backgroundSize: "42px 42px",
        maskImage:
          "radial-gradient(ellipse 90% 70% at 50% 0%, black 35%, transparent 100%)",
        WebkitMaskImage:
          "radial-gradient(ellipse 90% 70% at 50% 0%, black 35%, transparent 100%)",
      }}
    />
  );
}
