import { Toaster as SonnerToaster } from "sonner";

import { useUiStore } from "@/stores/ui-store";
import { resolveTheme } from "@/lib/theme";

/**
 * 全局 toast 容器。
 *
 * 主题跟随 `<html>` 上实际生效的那一档（而不是设置里的原始值），
 * 这样"跟随系统"模式下 toast 的颜色始终和界面一致。
 */
export function Toaster() {
  const theme = useUiStore((s) => s.theme);
  const resolved = resolveTheme(theme);

  return (
    <SonnerToaster
      theme={resolved}
      position="bottom-right"
      closeButton
      richColors
      expand={false}
      visibleToasts={4}
      gap={10}
      offset={16}
      toastOptions={{
        classNames: {
          toast:
            "group border border-border/70 bg-card/95 text-card-foreground backdrop-blur-xl shadow-2xl",
          title: "text-sm font-medium",
          description: "text-xs text-muted-foreground",
          actionButton: "bg-primary text-primary-foreground",
          cancelButton: "bg-muted text-muted-foreground",
          closeButton: "border-border/70 bg-card",
        },
      }}
    />
  );
}
