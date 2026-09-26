import { AnimatePresence, motion } from "framer-motion";
import { Inbox } from "lucide-react";
import * as React from "react";

import { JobCard } from "@/components/jobs/job-card";
import { cn } from "@/lib/utils";
import type { Job } from "@/types/domain";

/**
 * 任务列表（窗口化渲染）。
 *
 * ## 为什么自己写窗口化
 *
 * 任务中心可能同时存在几千条历史任务。全量渲染的话，每条 JobCard 里有进度条、
 * 徽章、若干图标，DOM 节点数以万计，滚动会明显掉帧。
 *
 * 这里用最朴素但足够可靠的方案：**固定行高 + 只渲染可视区 ± 若干行**。
 * 之所以能固定行高，是因为行内用的是 `JobCard` 的 `dense` 模式
 * （内容被严格约束在行高内）。相比引入虚拟滚动库，这个实现零依赖、可读，
 * 而且不会因为动态测量在窗口缩放时抖动。
 *
 * 另外给每一行加了 `content-visibility: auto`（`.cv-auto`）作为兜底：
 * 即便将来行高变得不固定，浏览器也会跳过离屏行的布局。
 */

const ROW_HEIGHT = 120;
const OVERSCAN = 6;

export interface JobListProps {
  jobs: Job[];
  selectedId?: string | null;
  onSelect?: (jobId: string) => void;
  onCancel?: (jobId: string) => void;
  className?: string;
  emptyHint?: string;
}

export function JobList({
  jobs,
  selectedId,
  onSelect,
  onCancel,
  className,
  emptyHint = "还没有任务。从「格式转换」或「批量处理」发起一个试试。",
}: JobListProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = React.useState(0);
  const [viewportHeight, setViewportHeight] = React.useState(600);

  // 容器尺寸变化（窗口缩放、侧边栏折叠）时重算可视行数
  React.useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const update = () => setViewportHeight(node.clientHeight || 600);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const total = jobs.length;
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(total, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);
  const slice = React.useMemo(() => jobs.slice(first, last), [jobs, first, last]);

  if (total === 0) {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border/70 p-10 text-center",
          className,
        )}
      >
        <Inbox className="h-8 w-8 text-muted-foreground/60" />
        <p className="text-sm text-muted-foreground">{emptyHint}</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      className={cn("min-h-0 flex-1 overflow-y-auto scrollbar-thin", className)}
      // 可滚动的日志/列表区域给读屏一个角色，键盘可以聚焦后翻页
      tabIndex={0}
      role="list"
      aria-label={`任务列表，共 ${total} 项`}
    >
      <div className="relative w-full" style={{ height: total * ROW_HEIGHT }}>
        <AnimatePresence initial={false}>
          {slice.map((job, idx) => (
            <motion.div
              key={job.id}
              layout="position"
              className="cv-auto absolute left-0 right-0 px-1 py-1"
              style={{ top: (first + idx) * ROW_HEIGHT, height: ROW_HEIGHT }}
              role="listitem"
            >
              <JobCard
                job={job}
                dense
                selected={selectedId === job.id}
                onSelect={onSelect}
                onCancel={onCancel}
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
