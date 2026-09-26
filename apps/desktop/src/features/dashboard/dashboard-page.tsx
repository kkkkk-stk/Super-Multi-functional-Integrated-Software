import {
  ArrowRight,
  Cpu,
  FolderOpen,
  HardDrive,
  Layers,
  ListChecks,
  Package,
  RefreshCw,
  Sparkles,
  Workflow,
  Zap,
} from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";

import { CountUp } from "@/components/fx/count-up";
import { SpotlightCard } from "@/components/fx/spotlight-card";
import { JobCard } from "@/components/jobs/job-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { SkeletonCard } from "@/components/ui/skeleton";
import { isEngineUsable, useEngines, useProbeAllEngines } from "@/hooks/use-engines";
import { sortJobsForDisplay, useJobsSnapshot } from "@/hooks/use-jobs";
import { usePluginsSnapshot } from "@/hooks/use-plugins";
import { useSystemStatus } from "@/hooks/use-settings";
import { formatMegabytes } from "@/lib/format";
import { revealInExplorer } from "@/lib/system";

/**
 * 仪表盘。
 *
 * 数据全部来自 Query（`["system"]` / `["engines"]` / `["plugins"]` / `["jobs"]`），
 * 没有一个数字来自 store —— 见 `src/stores/README.md` 的铁律。
 *
 * 排版顺序是按"用户打开应用最先想知道什么"排的：
 * 能不能干活（引擎） → 有多少东西可干（插件） → 正在干什么（任务） → 东西放哪（目录）。
 */
export function DashboardPage() {
  const { data: system, isLoading: systemLoading, refetch: refetchSystem, isFetching } = useSystemStatus();
  const { data: engines } = useEngines();
  const plugins = usePluginsSnapshot();
  const jobs = useJobsSnapshot();
  const probeAll = useProbeAllEngines();

  const readyEngines = engines?.filter((e) => isEngineUsable(e.status.state)) ?? [];
  const missingCoreEngines =
    engines?.filter((e) => e.descriptor.core && !isEngineUsable(e.status.state)) ?? [];
  const recentJobs = React.useMemo(
    () => sortJobsForDisplay(jobs.jobs).slice(0, 5),
    [jobs.jobs],
  );
  const engineRatio =
    engines && engines.length > 0 ? readyEngines.length / engines.length : 0;

  return (
    <div className="h-full space-y-4 overflow-y-auto pr-1 scrollbar-thin">
      {/* 概览卡片 */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <SpotlightCard className="p-4">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs text-muted-foreground">可用引擎</p>
              <p className="mt-1 text-2xl font-semibold">
                <CountUp value={readyEngines.length} />
                <span className="ml-1 text-sm text-muted-foreground">
                  / {engines?.length ?? 0}
                </span>
              </p>
            </div>
            <Cpu className="h-5 w-5 text-muted-foreground" />
          </div>
          <Progress value={engineRatio} className="mt-3 h-1.5" />
          <p className="mt-2 text-[11px] text-muted-foreground">
            {readyEngines.length === 0
              ? "还没有可用引擎 —— 图片转换等纯 Rust 能力仍然可用，音视频/文档需要引擎。"
              : missingCoreEngines.length > 0
                ? `核心引擎缺失：${missingCoreEngines.map((e) => e.descriptor.name).join("、")}`
                : "核心引擎齐备。"}
          </p>
        </SpotlightCard>

        <SpotlightCard className="p-4">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs text-muted-foreground">已装载插件</p>
              <p className="mt-1 text-2xl font-semibold">
                <CountUp value={plugins.plugins.length} />
              </p>
            </div>
            <Package className="h-5 w-5 text-muted-foreground" />
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            已启用 {plugins.plugins.filter((p) => p.enabled).length} 个
            {plugins.pendingPermissionCount > 0 && (
              <span className="text-warning">
                {" "}
                · {plugins.pendingPermissionCount} 个插件存在未授权项
              </span>
            )}
          </p>
          <Button asChild size="sm" variant="ghost" className="mt-1 h-6 px-0 text-xs">
            <Link to="/plugins">
              管理插件 <ArrowRight className="ml-1 h-3 w-3" />
            </Link>
          </Button>
        </SpotlightCard>

        <SpotlightCard className="p-4">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs text-muted-foreground">活动任务</p>
              <p className="mt-1 text-2xl font-semibold">
                <CountUp value={jobs.activeCount} />
              </p>
            </div>
            <Zap className="h-5 w-5 text-muted-foreground" />
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            历史共 {jobs.jobs.length} 条 · 失败{" "}
            {jobs.jobs.filter((j) => j.status === "failed").length} 条
          </p>
          <Button asChild size="sm" variant="ghost" className="mt-1 h-6 px-0 text-xs">
            <Link to="/jobs">
              任务中心 <ArrowRight className="ml-1 h-3 w-3" />
            </Link>
          </Button>
        </SpotlightCard>

        <SpotlightCard className="p-4">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs text-muted-foreground">存储</p>
              <p className="mt-1 text-lg font-semibold">
                {systemLoading ? "读取中…" : system?.storageWritable ? "可写" : "不可写"}
              </p>
            </div>
            <HardDrive className="h-5 w-5 text-muted-foreground" />
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            {system ? `平台 ${system.platform} · 后端 ${system.info.version}` : "—"}
          </p>
          <Button
            size="sm"
            variant="ghost"
            className="mt-1 h-6 gap-1 px-0 text-xs"
            disabled={isFetching}
            onClick={() => void refetchSystem()}
          >
            <RefreshCw className={isFetching ? "h-3 w-3 animate-spin" : "h-3 w-3"} />
            刷新系统状态
          </Button>
        </SpotlightCard>
      </div>

      {/* 快速开始 */}
      <section className="rounded-lg border border-border/60 bg-card/40 p-4">
        <h2 className="text-sm font-semibold">快速开始</h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {[
            {
              to: "/convert",
              icon: RefreshCw,
              title: "转换格式",
              desc: "把一个或一批文件转成另一种格式",
            },
            {
              to: "/image",
              icon: Layers,
              title: "处理图片",
              desc: "缩放 / 裁剪 / 压缩 / 去背景",
            },
            { to: "/batch", icon: Layers, title: "批量处理", desc: "对成百上千个文件跑同一条链" },
            { to: "/pipeline", icon: Workflow, title: "搭一条流水线", desc: "拖节点、连端口、导出为插件" },
            { to: "/ai", icon: Sparkles, title: "AI 生成插件", desc: "一句话描述需求，生成草稿后人工确认" },
            { to: "/settings", icon: Cpu, title: "安装引擎", desc: "FFmpeg / libvips / Pandoc / 7-Zip…" },
          ].map((item) => (
            <Link
              key={item.to + item.title}
              to={item.to}
              className="flex items-center gap-3 rounded-lg border border-border/50 p-3 transition-colors hover:border-primary/50 hover:bg-primary/5"
            >
              <item.icon className="h-4 w-4 shrink-0 text-primary" />
              <span className="min-w-0">
                <span className="block text-sm">{item.title}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {item.desc}
                </span>
              </span>
            </Link>
          ))}
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        {/* 最近任务 */}
        <section className="space-y-3 rounded-lg border border-border/60 bg-card/40 p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">最近任务</h2>
            <Button asChild size="sm" variant="ghost" className="h-7 text-xs">
              <Link to="/jobs">
                <ListChecks className="mr-1.5 h-3.5 w-3.5" />
                全部任务
              </Link>
            </Button>
          </div>
          {recentJobs.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">
              还没有任务。到「格式转换」里选一个插件、拖入文件、点开始。
            </p>
          ) : (
            <div className="space-y-2">
              {recentJobs.map((job) => (
                <JobCard key={job.id} job={job} compact />
              ))}
            </div>
          )}
        </section>

        {/* 引擎摘要 + 目录 */}
        <div className="space-y-4">
          <section className="space-y-3 rounded-lg border border-border/60 bg-card/40 p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">引擎</h2>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1.5 text-xs"
                disabled={probeAll.isPending}
                onClick={() => probeAll.mutate()}
              >
                <RefreshCw className={probeAll.isPending ? "h-3 w-3 animate-spin" : "h-3 w-3"} />
                重新探测
              </Button>
            </div>
            {!engines ? (
              <SkeletonCard lines={3} />
            ) : (
              <ul className="space-y-1.5">
                {engines.slice(0, 6).map((entry) => {
                  const usable = isEngineUsable(entry.status.state);
                  return (
                    <li key={entry.descriptor.id} className="flex items-center gap-2 text-xs">
                      <span
                        className={
                          usable
                            ? "h-1.5 w-1.5 rounded-full bg-success"
                            : "h-1.5 w-1.5 rounded-full bg-muted-foreground/50"
                        }
                      />
                      <span className="flex-1 truncate">{entry.descriptor.name}</span>
                      <span className="text-muted-foreground">
                        {entry.status.version ?? (usable ? "已就绪" : "未安装")}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            <Button asChild size="sm" variant="outline" className="w-full text-xs">
              <Link to="/settings?tab=engines">到设置里管理全部引擎</Link>
            </Button>
          </section>

          <section className="space-y-2 rounded-lg border border-border/60 bg-card/40 p-4">
            <h2 className="text-sm font-semibold">数据目录</h2>
            <p className="text-[11px] text-muted-foreground">
              插件、引擎、模型权重、审计日志都放在这里；删掉缓存目录不会影响插件。
            </p>
            {system ? (
              <ul className="space-y-1">
                {system.paths.entries.map((entry) => (
                  <li key={entry.path} className="flex items-center gap-2 text-[11px]">
                    <span className="w-16 shrink-0 text-muted-foreground">{entry.label}</span>
                    <span className="min-w-0 flex-1 truncate font-mono" title={entry.path}>
                      {entry.path}
                    </span>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`打开${entry.label}`}
                      onClick={() => void revealInExplorer(entry.path)}
                    >
                      <FolderOpen className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <SkeletonCard lines={2} />
            )}
          </section>

          <section className="rounded-lg border border-border/60 bg-card/40 p-4 text-[11px] text-muted-foreground">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">插件协议 {system?.info.pluginApiVersion ?? "—"}</Badge>
              <Badge variant="outline">Tauri {system?.info.tauriVersion ?? "—"}</Badge>
              <Badge variant="outline">Rust {system?.info.rustVersion ?? "—"}</Badge>
              <Badge variant="outline">{system?.info.buildProfile ?? "—"}</Badge>
              <Badge variant="outline">{system?.commandCount ?? 0} 个命令</Badge>
            </div>
            <p className="mt-2">
              最近安装引擎的估算体积会显示在引擎页；下载产物会尽量做 SHA-256 校验。
              模型权重与引擎分开下载 —— 只有用到对应功能时才会拉取。
            </p>
            {missingCoreEngines.length > 0 && (
              <p className="mt-2 text-warning">
                提示：核心引擎 {missingCoreEngines.map((e) => e.descriptor.name).join("、")} 未安装，
                相关节点会显示为不可用（合计约{" "}
                {formatMegabytes(
                  missingCoreEngines.reduce((acc, e) => acc + e.descriptor.approxSizeMb, 0),
                )}
                ）。
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
