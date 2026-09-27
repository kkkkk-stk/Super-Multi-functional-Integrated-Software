import * as React from "react";

import { cn } from "@/lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        "flex h-9 w-full rounded-md border border-input bg-background/50 px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "flex min-h-[80px] w-full rounded-md border border-input bg-background/50 px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";

export const Label = React.forwardRef<
  HTMLLabelElement,
  React.LabelHTMLAttributes<HTMLLabelElement>
>(({ className, ...props }, ref) => (
  // 这是一个**通用**的 Label 包装（`{...props}` 原样透传），它既不知道调用方会不会给
  // `htmlFor`，也不知道旁边会不会放控件 —— "标签有没有关联控件"是**调用方**的责任，
  // 在这里判定必然是误报。所以留一条带理由的禁用（规则对其它地方的 `<label>` 照旧生效）。
  // eslint-disable-next-line jsx-a11y/label-has-associated-control -- 通用包装组件，关联关系由调用方决定
  <label
    ref={ref}
    className={cn("text-sm font-medium leading-none text-foreground", className)}
    {...props}
  />
));
Label.displayName = "Label";
