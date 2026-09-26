import { AlertTriangle, Cpu, HardDrive, ListChecks, Monitor } from "lucide-react";
import { Link } from "react-router-dom";

import { useEngines, isEngineUsable } from "@/hooks/use-engines";
import { useJobsSnapshot } from "@/hooks/use-jobs";
import { useSystemStatus } from "@/hooks/use-settings";
import { cn } from "@/lib/utils";

/**
 * 底部状态栏（30px）。
 *
 * 固定显示三件事：**引擎可用数 / 活动任务数 / 后端版本**。
 * 这三项是"我现在能不能干活、有没有在干活、跑的是哪个后端"的最短回答。
 * 引擎或存储异常时整条会变成警示色 —— 状态栏存在的意义就是**异常时显眼**。
 */
export function StatusBar() {
  const { data: engines } = useEngines();
  const snapshot = useJobsSnapshot();
  const { data: system, isError: systemError } = useSystemStatus();

  const ready = engines?.filter((e) => isEngineUsable(e.status.state)).length ?? 0;
  const total = engines?.length ?? 0;
  const active = snapshot.activeCount;
  const failed = snapshot.jobs.filter((j) => j.status === "failed").length;

  const storageBad = system ? !system.storageWritable : false;
  const alarming = storageBad || systemError;

  return (
    <footer
      className={cn(
        "flex h-[30px] shrink-0 items-center gap-4 border-t border-border/60 px-3 text-[11px] text-muted-foreground",
        alarming ? "bg-destructive/10 text-destructive" : "glass",
      )}
      aria-label="状态栏"
    >
      <span className="flex items-center gap-1.5" title="可用引擎数 / 引擎总数">
        <Cpu className="h-3 w-3" />
        引擎 <span className="tabular text-foreground">{ready}</span>/{total}
      </span>

      <Link to="/jobs" className="flex items-center gap-1.5 hover:text-foreground">
        <ListChecks className="h-3 w-3" />
        活动任务 <span className="tabular text-foreground">{active}</span>
        {failed > 0 && (
          <span className="text-destructive">（失败 {failed}）</span>
        )}
      </Link>

      <span className="flex items-center gap-1.5" title="数据目录是否可写">
        <HardDrive className="h-3 w-3" />
        {system ? (system.storageWritable ? "存储正常" : "存储不可写") : "存储状态未知"}
      </span>

      <span className="ml-auto flex items-center gap-3">
        {alarming && (
          <span className="flex items-center gap-1 text-destructive">
            <AlertTriangle className="h-3 w-3" />
            {storageBad ? "数据目录不可写，任务可能失败" : "无法读取系统状态"}
          </span>
        )}
        <span className="flex items-center gap-1.5" title="当前平台">
          <Monitor className="h-3 w-3" />
          {system?.platform ?? "—"}
        </span>
        <span title="后端版本 / 插件协议版本 / 构建类型">
          ToolForge <span className="tabular text-foreground">{system?.info.version ?? "—"}</span>
          {system?.info.pluginApiVersion ? ` · ${system.info.pluginApiVersion}` : ""}
          {system?.info.buildProfile ? ` · ${system.info.buildProfile}` : ""}
        </span>
      </span>
    </footer>
  );
}
