import { ChevronDown } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/**
 * 下拉选择。
 *
 * **刻意用原生 `<select>`**：依赖清单里没有 `@radix-ui/react-select`，
 * 而原生控件在这台桌面 WebView 里有三个实打实的好处 ——
 * 键盘可达性、读屏语义、以及长列表（几十个插件/引擎）不会被 DOM 拖慢。
 * 样式用 `appearance-none` + 自绘箭头统一到设计系统里。
 */
export const Select = React.forwardRef<
  HTMLSelectElement,
  Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "children"> & {
    options: SelectOption[];
    placeholder?: string;
  }
>(({ className, options, placeholder, ...props }, ref) => (
  <div className="relative inline-flex w-full items-center">
    <select
      ref={ref}
      className={cn(
        "h-9 w-full appearance-none rounded-md border border-input bg-background/50 pl-3 pr-8 text-sm shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {placeholder !== undefined && (
        <option value="" disabled={props.required}>
          {placeholder}
        </option>
      )}
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
    <ChevronDown className="pointer-events-none absolute right-2 h-4 w-4 text-muted-foreground" />
  </div>
));
Select.displayName = "Select";
