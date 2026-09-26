import { Gauge, Info, Layers, ListChecks } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";

import { JobCard } from "@/components/jobs/job-card";
import { PluginPicker, useDefaultPlugin } from "@/components/plugins/plugin-picker";
import { PluginRunner } from "@/components/plugins/plugin-runner";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useCancelJob, useJobsSnapshot, sortJobsForDisplay } from "@/hooks/use-jobs";
import { usePatchSettings, useSettings } from "@/hooks/use-settings";

/**
 * 批量处理页。
 *
 * 与「格式转换」共用 runner，区别在于：
 * - 输入端口按**多文件**对待（一次可以丢几百个）；
 * - 页面顶部直接暴露**并发度**设置（批量任务最影响体感的旋钮）；
 * - 右侧只显示"批量相关"的任务，方便一边丢文件一边盯进度。
 *
 * 注意：批量任务**不是**前端循环调用 —— 一次 `plugins_run` 会把整批文件交给
 * 宿主的任务队列，由它按并发度调度、逐个上报进度。这样取消/失败重试都由后端统一处理。
 */
export function BatchPage() {
  const [pluginId, setPluginId] = useDefaultPlugin();
  const settings = useSettings();
  const patchSettings = usePatchSettings();
  const jobs = useJobsSnapshot();
  const cancelJob = useCancelJob();

  const [concurrencyDraft, setConcurrencyDraft] = React.useState<string>("");

  React.useEffect(() => {
    if (settings.data) setConcurrencyDraft(String(settings.data.concurrency));
  }, [settings.data]);

  const batchJobs = React.useMemo(
    () =>
      sortJobsForDisplay(
        jobs.jobs.filter((j) => j.totalItems > 1 || j.kind.kind === "batchRename"),
      ).slice(0, 12),
    [jobs.jobs],
  );

  return (
    <div className="grid h-full min-h-0 gap-4 xl:grid-cols-[1fr_340px]">
      <div className="min-h-0 space-y-4 overflow-y-auto pr-1 scrollbar-thin">
        <header className="space-y-1">
          <h1 className="text-lg font-semibold">批量处理</h1>
          <p className="text-xs text-muted-foreground">
            一次把整批文件交给宿主的任务队列，由它按并发度调度、逐个上报进度。
            源文件默认保留（可在设置里改），产出统一写到你指定的输出目录。
          </p>
        </header>

        {/* 并发度 */}
        <section className="flex flex-wrap items-end gap-3 rounded-lg border border-border/60 bg-card/40 p-4">
          <div className="min-w-[220px] flex-1">
            <Label htmlFor="concurrency" className="text-xs">
              并发度（同时处理几个文件）
            </Label>
            <div className="mt-1 flex items-center gap-2">
              <Input
                id="concurrency"
                type="number"
                min={1}
                max={64}
                value={concurrencyDraft}
                onChange={(e) => setConcurrencyDraft(e.target.value)}
                className="h-8 w-24 text-xs"
                aria-label="任务并发度"
              />
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                disabled={
                  patchSettings.isPending ||
                  String(settings.data?.concurrency ?? "") === concurrencyDraft
                }
                onClick={() => {
                  const value = Number.parseInt(concurrencyDraft, 10);
                  if (!Number.isFinite(value) || value < 1) return;
                  patchSettings.mutate({ concurrency: value });
                }}
              >
                保存
              </Button>
              <span className="text-[11px] text-muted-foreground">
                当前生效：{settings.data?.concurrency ?? "—"}
              </span>
            </div>
          </div>
          <p className="flex max-w-sm items-start gap-1.5 text-[11px] text-muted-foreground">
            <Gauge className="mt-0.5 h-3 w-3 shrink-0" />
            经验值：等于 CPU 核数的一半左右。占满所有核反而更慢 ——
            磁盘 IO 与内存带宽才是批量图片/视频的瓶颈。
          </p>
        </section>

        <PluginPicker
          value={pluginId}
          onChange={setPluginId}
          label="选择批量处理方式"
          filter={(p) => p.category !== "system"}
        />

        {pluginId && <PluginRunner key={pluginId} pluginId={pluginId} batchMode />}

        {/* 输出目录提醒 */}
        <section className="rounded-lg border border-border/60 bg-card/40 p-4 text-xs">
          <h2 className="mb-1.5 font-semibold">输出位置</h2>
          <p className="text-muted-foreground">
            {settings.data?.defaultOutputDir?.trim()
              ? `当前默认输出目录：${settings.data.defaultOutputDir}`
              : "未设置默认输出目录 —— 留空时任务会写到应用数据目录下的 output/。"}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2">
              <Select
                value={settings.data?.keepOriginal ? "keep" : "remove"}
                onChange={(e) =>
                  patchSettings.mutate({ keepOriginal: e.target.value === "keep" })
                }
                aria-label="批量处理时源文件处理策略"
                className="h-8 w-56 text-xs"
                options={[
                  { value: "keep", label: "保留源文件（推荐）" },
                  { value: "remove", label: "处理成功后删除源文件" },
                ]}
              />
            </label>
            <span className="text-[11px] text-muted-foreground">
              删除源文件是不可逆的，仅在确认产出正确后再考虑。
            </span>
          </div>
        </section>
      </div>

      {/* 右栏：批量任务 */}
      <aside className="min-h-0 space-y-3 overflow-y-auto pr-1 scrollbar-thin">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <ListChecks className="h-4 w-4" />
            批量任务
          </h2>
          <Button asChild size="sm" variant="ghost" className="h-7 text-xs">
            <Link to="/jobs">全部</Link>
          </Button>
        </div>

        {batchJobs.length === 0 ? (
          <p className="flex items-start gap-1.5 rounded-lg border border-dashed border-border/70 p-4 text-[11px] text-muted-foreground">
            <Info className="mt-0.5 h-3 w-3 shrink-0" />
            还没有批量任务。把一批文件拖进窗口，或在上面选择"多文件"端口一次性选入。
          </p>
        ) : (
          batchJobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              onCancel={(id) => cancelJob.mutate(id)}
            />
          ))
        )}

        <section className="rounded-lg border border-border/60 bg-card/40 p-4 text-[11px] text-muted-foreground">
          <h3 className="mb-1.5 flex items-center gap-1.5 font-semibold text-foreground">
            <Layers className="h-3.5 w-3.5" />
            批量任务的几条硬规则
          </h3>
          <ul className="space-y-1">
            <li>· 单个文件失败不会中止整批（失败计数单独上报，最后列在任务卡片上）。</li>
            <li>· 取消是"整体取消"：已在处理的会等当前文件收尾，未开始的直接丢弃。</li>
            <li>· 日志只保留尾部 2000 行，避免几千个文件把内存吃光。</li>
            <li>· 任务结束后可一键清理记录（不动产出文件）。</li>
          </ul>
        </section>
      </aside>
    </div>
  );
}
