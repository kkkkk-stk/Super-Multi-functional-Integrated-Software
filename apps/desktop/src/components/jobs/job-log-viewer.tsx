import { ArrowDownToLine, Copy, PauseCircle, PlayCircle, Search } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatClock } from "@/lib/format";
import { copyText } from "@/lib/system";
import { cn } from "@/lib/utils";
import type { JobLogEntry, LogLevel } from "@/types/domain";

/**
 * 任务日志查看器。
 *
 * ## 只渲染尾部 200 行
 *
 * 后端每个任务最多保留 2000 行（`Job::LOG_TAIL_LIMIT`），但转码任务一秒能吐几十行，
 * 2000 行 × 每行一个 DOM 节点足够把渲染拖慢。所以：
 * - 默认只取**尾部 200 行**（用户关心的永远是"最后发生了什么"）；
 * - 行本身用 `content-visibility: auto`，离屏行不参与布局；
 * - 自动滚动到最新是**默认开启但可关**的（要看历史时关掉，否则一直被拽到底部）。
 */
export const LOG_TAIL_RENDER_LIMIT = 200;

const LEVEL_STYLE: Record<LogLevel, string> = {
  trace: "text-muted-foreground/60",
  debug: "text-muted-foreground",
  info: "text-foreground/90",
  warn: "text-warning",
  error: "text-destructive",
};

const LEVEL_LABEL: Record<LogLevel, string> = {
  trace: "TRACE",
  debug: "DEBUG",
  info: "INFO ",
  warn: "WARN ",
  error: "ERROR",
};

export interface JobLogViewerProps {
  logs: JobLogEntry[];
  className?: string;
  /** 固定高度（不传则自适应父容器） */
  height?: number;
}

export function JobLogViewer({ logs, className, height }: JobLogViewerProps) {
  const [autoScroll, setAutoScroll] = React.useState(true);
  const [query, setQuery] = React.useState("");
  const [levelFilter, setLevelFilter] = React.useState<LogLevel | "all">("all");
  const viewportRef = React.useRef<HTMLDivElement | null>(null);

  const tail = React.useMemo(
    () => (logs.length > LOG_TAIL_RENDER_LIMIT ? logs.slice(logs.length - LOG_TAIL_RENDER_LIMIT) : logs),
    [logs],
  );

  const visible = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    return tail.filter((l) => {
      if (levelFilter !== "all" && l.level !== levelFilter) return false;
      if (needle && !l.message.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [tail, query, levelFilter]);

  React.useEffect(() => {
    if (!autoScroll) return;
    const node = viewportRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [visible.length, autoScroll]);

  const copyAll = React.useCallback(() => {
    const text = visible
      .map((l) => `${l.at} [${l.level.toUpperCase()}] ${l.message}`)
      .join("\n");
    void copyText(text, `已复制 ${visible.length} 行日志`);
  }, [visible]);

  return (
    <div className={cn("flex min-h-0 flex-col gap-2", className)}>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="过滤日志内容"
            aria-label="过滤日志内容"
            className="h-8 pl-7 text-xs"
          />
        </div>
        <select
          value={levelFilter}
          onChange={(e) => setLevelFilter(e.target.value as LogLevel | "all")}
          aria-label="按级别过滤日志"
          className="h-8 rounded-md border border-input bg-background/50 px-2 text-xs"
        >
          <option value="all">全部级别</option>
          <option value="debug">DEBUG 及以上</option>
          <option value="info">INFO</option>
          <option value="warn">WARN</option>
          <option value="error">ERROR</option>
        </select>
        <Button
          size="icon-sm"
          variant={autoScroll ? "secondary" : "ghost"}
          aria-label={autoScroll ? "停止自动滚动" : "自动滚动到最新"}
          onClick={() => setAutoScroll((v) => !v)}
        >
          {autoScroll ? <PauseCircle className="h-3.5 w-3.5" /> : <PlayCircle className="h-3.5 w-3.5" />}
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="复制当前日志" onClick={copyAll}>
          <Copy className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div
        ref={viewportRef}
        role="log"
        aria-label="任务日志"
        style={height ? { height } : undefined}
        className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border/60 bg-black/30 p-2 font-mono text-[11px] leading-relaxed scrollbar-thin"
      >
        {visible.length === 0 ? (
          <p className="p-3 text-center text-muted-foreground">
            {logs.length === 0 ? "暂无日志" : "没有匹配的日志行"}
          </p>
        ) : (
          visible.map((entry, idx) => (
            <div
              key={`${entry.at}-${idx}`}
              className="cv-auto flex gap-2 px-1 py-0.5 hover:bg-white/5"
            >
              <span className="shrink-0 text-muted-foreground/70">{formatClock(entry.at)}</span>
              <span className={cn("shrink-0", LEVEL_STYLE[entry.level])}>
                {LEVEL_LABEL[entry.level]}
              </span>
              <span className="whitespace-pre-wrap break-all text-foreground/85">
                {entry.message}
              </span>
            </div>
          ))
        )}
        {logs.length > LOG_TAIL_RENDER_LIMIT && (
          <p className="flex items-center gap-1 p-2 text-[10px] text-muted-foreground">
            <ArrowDownToLine className="h-3 w-3" />
            仅显示最后 {LOG_TAIL_RENDER_LIMIT} 行（共 {logs.length} 行，完整日志见应用日志目录）
          </p>
        )}
      </div>
    </div>
  );
}
