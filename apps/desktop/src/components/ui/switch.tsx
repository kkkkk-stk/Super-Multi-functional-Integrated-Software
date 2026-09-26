import { cn } from "@/lib/utils";

/**
 * 开关。
 *
 * 刻意**不引 `@radix-ui/react-switch`**：依赖清单是锁定的，而一个
 * `role="switch"` + `aria-checked` 的按钮已经把语义说全了（读屏能播报开关状态、
 * 空格/回车可切换、测试可断言）。视觉上用两段位移 + 颜色变化表达状态，
 * 与设计系统里的圆角与强调色一致。
 */
export function Switch({
  checked,
  onCheckedChange,
  disabled,
  id,
  className,
  "aria-label": ariaLabel,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  /** 没有可见文字标签时**必须**给，否则读屏只会念"开关" */
  "aria-label"?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-input",
        className,
      )}
    >
      <span
        className={cn(
          "pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform",
          checked ? "translate-x-4" : "translate-x-0",
        )}
      />
    </button>
  );
}
