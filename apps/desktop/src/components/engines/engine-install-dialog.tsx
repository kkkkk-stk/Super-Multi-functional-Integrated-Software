import { AlertTriangle, Download, ShieldCheck } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatMegabytes } from "@/lib/format";
import { openExternal } from "@/lib/system";
import type { EngineEntry } from "@/types/domain";

/**
 * 引擎安装确认。
 *
 * 两道门都是**后端强制的**（`engines_install` 里会再检查一遍），
 * 这里只是把后端的要求在用户点下去之前讲清楚：
 *
 * 1. `requiresLicenseAck` 为真时必须显式勾选"已阅读许可证"——
 *    FFmpeg 的 LGPL/GPL、Calibre 的 GPL-3.0 对分发方式有实际约束；
 * 2. 来源没有 SHA-256 时必须显式勾选"允许未校验来源"，
 *    并明确告知风险（后端会返回 `HashRequired`，除非用户同意）。
 */
export function EngineInstallDialog({
  entry,
  open,
  onOpenChange,
  installing,
  onConfirm,
}: {
  entry: EngineEntry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  installing: boolean;
  onConfirm: (req: { engineId: string; licenseAccepted: boolean; allowUnverified: boolean }) => void;
}) {
  const [licenseAccepted, setLicenseAccepted] = React.useState(false);
  const [allowUnverified, setAllowUnverified] = React.useState(false);

  // 每次换引擎都重置勾选：上一次的同意不能自动延续到另一个引擎
  React.useEffect(() => {
    if (open) {
      setLicenseAccepted(false);
      setAllowUnverified(false);
    }
  }, [open, entry?.descriptor.id]);

  if (!entry) return null;
  const { descriptor } = entry;
  const requiresLicense = descriptor.requiresLicenseAck;
  const blocked = requiresLicense && !licenseAccepted;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            安装 {descriptor.name}
            <Badge variant="outline">{formatMegabytes(descriptor.approxSizeMb)}</Badge>
          </DialogTitle>
          <DialogDescription>
            下载会走应用托管目录，并尽可能做 SHA-256 校验；
            安装过程是一个「任务」，可以在任务中心看到实时进度与日志。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <section className="rounded-lg border border-border/60 p-3">
            <h4 className="mb-1 text-xs font-semibold text-muted-foreground">许可证</h4>
            <p className="text-sm">{descriptor.license}</p>
            <p className="mt-1 text-xs text-muted-foreground">{descriptor.licenseNote}</p>
            <Button
              size="sm"
              variant="link"
              className="h-6 px-0 text-xs"
              onClick={() => void openExternal(descriptor.homepage)}
            >
              查看官方页面
            </Button>
          </section>

          <section className="space-y-2">
            {requiresLicense && (
              <label className="flex items-start gap-2.5 rounded-md border border-warning/40 bg-warning/5 p-3">
                <Checkbox
                  checked={licenseAccepted}
                  onCheckedChange={setLicenseAccepted}
                  label="我已阅读并接受该引擎的许可证条款"
                  className="mt-0.5"
                />
                <span className="text-xs">
                  <span className="font-medium">我已阅读并接受该引擎的许可证条款</span>
                  <span className="mt-0.5 block text-muted-foreground">
                    该引擎要求在使用前确认许可证。若你的用途涉及闭源分发或商业销售，
                    请先按上面的说明完成合规判断。
                  </span>
                </span>
              </label>
            )}

            <label className="flex items-start gap-2.5 rounded-md border border-border/60 p-3">
              <Checkbox
                checked={allowUnverified}
                onCheckedChange={setAllowUnverified}
                label="允许安装没有校验值的来源"
                className="mt-0.5"
              />
              <span className="text-xs">
                <span className="flex items-center gap-1.5 font-medium">
                  <AlertTriangle className="h-3.5 w-3.5 text-warning" />
                  允许安装没有 SHA-256 校验值的来源
                </span>
                <span className="mt-0.5 block text-muted-foreground">
                  只有在官方下载地址确实不提供校验值时才需要勾选。
                  <span className="text-warning">
                    不校验意味着无法发现下载被篡改或传输不完整
                  </span>
                  ，请自行确认来源可信。
                </span>
              </span>
            </label>

            <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
              <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0" />
              安装完成后，依赖该引擎的内置节点会自动变为可用（流程编辑器里灰掉的端口会亮起）。
            </p>
          </section>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={installing}>
            取消
          </Button>
          <Button
            className="gap-1.5"
            disabled={blocked || installing}
            onClick={() => {
              if (blocked) {
                toast.error("请先确认许可证条款");
                return;
              }
              onConfirm({
                engineId: descriptor.id,
                licenseAccepted,
                allowUnverified,
              });
            }}
          >
            <Download className="h-4 w-4" />
            {installing ? "正在创建安装任务…" : "开始下载安装"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
