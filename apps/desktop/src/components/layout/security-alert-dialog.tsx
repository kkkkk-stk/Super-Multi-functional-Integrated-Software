import { ShieldAlert } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatDateTime } from "@/lib/format";
import { useUiStore } from "@/stores/ui-store";

/**
 * 安全事件弹窗。
 *
 * 后端在 `securityAlert` 事件里把 severity 标成 high / critical 时会弹出来
 * （插件越权、哈希不匹配、AI 产出未过审核）。**必须手动关闭**，
 * 不能自己消失 —— 这类事件漏看一次就可能意味着插件已经在背后做了别的事。
 *
 * 对应的审计记录在「设置 → 安全与审计」里可以回查。
 */
export function SecurityAlertDialog() {
  const alert = useUiStore((s) => s.securityAlert);
  const dismiss = useUiStore((s) => s.dismissSecurityAlert);
  const navigate = useNavigate();

  const critical = alert?.severity === "critical";

  return (
    <Dialog open={Boolean(alert)} onOpenChange={(open) => !open && dismiss()}>
      <DialogContent
        className="max-w-xl border-destructive/60"
        // 安全弹窗不做点击遮罩关闭：用户必须显式选择"知道了"或"去查看审计"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <div className="mb-1 flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-destructive/15">
              <ShieldAlert className="h-5 w-5 text-destructive" />
            </span>
            <Badge variant={critical ? "critical" : "high"}>
              {critical ? "极高风险安全事件" : "高风险安全事件"}
            </Badge>
          </div>
          <DialogTitle>{alert?.title ?? "安全事件"}</DialogTitle>
          <DialogDescription className="whitespace-pre-wrap pt-1">
            {alert?.detail}
          </DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 rounded-md border border-border/60 p-3 text-xs">
          <dt className="text-muted-foreground">发生时间</dt>
          <dd className="tabular">{formatDateTime(alert?.at)}</dd>
          <dt className="text-muted-foreground">涉及对象</dt>
          <dd className="break-all">{alert?.subject ?? "（未指明）"}</dd>
          <dt className="text-muted-foreground">处理建议</dt>
          <dd>
            到「设置 → 安全与审计」查看该插件的完整审计记录；若确认是越权尝试，
            建议立即收回其全部权限或直接卸载。
          </dd>
        </dl>

        <DialogFooter>
          <Button variant="outline" onClick={dismiss}>
            我知道了
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              dismiss();
              navigate("/settings?tab=security");
            }}
          >
            去查看审计
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
