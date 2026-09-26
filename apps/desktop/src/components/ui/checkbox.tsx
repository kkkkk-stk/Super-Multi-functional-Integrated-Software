import { cn } from "@/lib/utils";

/**
 * 复选。
 *
 * 一个 `role="checkbox"` 的按钮就把语义说全了：读屏能播报选中状态、
 * 空格/回车能切换、`aria-checked` 能被测试断言。
 *
 * **权限面板逐条勾选依赖它**，所以这里刻意不做"半选/三态"等花哨状态 ——
 * 权限只有"给"和"不给"两种，行为必须一眼可懂。
 */
export function Checkbox({
  checked,
  onCheckedChange,
  disabled,
  id,
  label,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  /** 无可见文字时必须给（读屏用） */
  label?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      id={id}
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        checked
          ? "border-primary bg-primary text-primary-foreground"
          : "border-input bg-background/60 hover:border-primary/60",
        className,
      )}
    >
      {checked && (
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" aria-hidden="true">
          <path
            d="M20 6L9 17l-5-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}
