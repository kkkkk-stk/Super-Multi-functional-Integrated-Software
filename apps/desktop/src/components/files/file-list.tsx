import { AnimatePresence, motion } from "framer-motion";
import { File as FileIcon, FolderPlus, Image as ImageIcon, Film, FileAudio, FileText, Trash2, X } from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { baseName, extensionOf, formatBytes, truncateMiddle } from "@/lib/format";
import { isTauriRuntime } from "@/lib/system";
import { cn } from "@/lib/utils";

/**
 * 已选文件列表。
 *
 * 大小是**尽力而为**的：用 `plugin-fs` 的 `stat` 逐个读，读不到（权限 / 文件已删）
 * 就显示 `—`，绝不因为一个文件 stat 失败就让整个列表报错。这也是为什么文件大小
 * 不参与任何业务判断 —— 它只是给用户看一眼的辅助信息。
 */

interface FileEntry {
  path: string;
  size?: number;
}

async function readSize(path: string): Promise<number | undefined> {
  if (!isTauriRuntime()) return undefined;
  try {
    const mod = await import("@tauri-apps/plugin-fs");
    const info = await mod.stat(path);
    // 不同版本字段略有差异，兜一下
    const size = (info as { size?: number } | null)?.size;
    return typeof size === "number" ? size : undefined;
  } catch {
    return undefined;
  }
}

function iconFor(ext: string) {
  if (["png", "jpg", "jpeg", "webp", "bmp", "tiff", "gif", "avif", "heic"].includes(ext)) {
    return ImageIcon;
  }
  if (["mp4", "mkv", "mov", "webm", "avi", "flv", "wmv"].includes(ext)) return Film;
  if (["mp3", "flac", "wav", "aac", "ogg", "opus", "m4a"].includes(ext)) return FileAudio;
  if (["md", "html", "docx", "pdf", "epub", "txt", "rst", "tex", "odt"].includes(ext)) {
    return FileText;
  }
  return FileIcon;
}

export interface FileListProps {
  paths: string[];
  onRemove?: (path: string) => void;
  onClear?: () => void;
  /** 额外的空态提示 */
  emptyHint?: string;
  className?: string;
  /** 最多渲染多少行（超出的折叠成"还有 N 个"） */
  maxVisible?: number;
}

export function FileList({
  paths,
  onRemove,
  onClear,
  emptyHint = "把文件拖到这里，或点上面的「选择文件」。",
  className,
  maxVisible = 60,
}: FileListProps) {
  const [entries, setEntries] = React.useState<FileEntry[]>(
    () => paths.map((p) => ({ path: p })),
  );

  // 路径集合变化时补齐大小信息（只为新增的读，避免重复 IO）
  React.useEffect(() => {
    let cancelled = false;
    setEntries(paths.map((p) => ({ path: p })));
    void (async () => {
      const sizes = new Map<string, number | undefined>();
      for (const p of paths) sizes.set(p, await readSize(p));
      if (cancelled) return;
      setEntries(paths.map((p) => ({ path: p, size: sizes.get(p) })));
    })();
    return () => {
      cancelled = true;
    };
  }, [paths]);

  const totalSize = React.useMemo(
    () => entries.reduce((acc, e) => acc + (e.size ?? 0), 0),
    [entries],
  );
  const knownCount = entries.filter((e) => e.size !== undefined).length;
  const visible = entries.slice(0, maxVisible);
  const hidden = entries.length - visible.length;

  if (entries.length === 0) {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border/70 p-8 text-center",
          className,
        )}
      >
        <FolderPlus className="h-6 w-6 text-muted-foreground/60" />
        <p className="text-sm text-muted-foreground">{emptyHint}</p>
      </div>
    );
  }

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          已选 <span className="tabular text-foreground">{entries.length}</span> 个文件
          {knownCount > 0 && totalSize > 0 && (
            <>
              {" · "}
              合计约 <span className="tabular text-foreground">{formatBytes(totalSize)}</span>
              {knownCount < entries.length && "（部分文件未读到大小）"}
            </>
          )}
        </span>
        {onClear && (
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onClear}>
            清空
          </Button>
        )}
      </div>

      <ul className="max-h-72 space-y-1 overflow-y-auto pr-1 scrollbar-thin" role="list">
        <AnimatePresence initial={false}>
          {visible.map((entry) => {
            const ext = extensionOf(entry.path);
            const Icon = iconFor(ext);
            return (
              <motion.li
                key={entry.path}
                layout="position"
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 8 }}
                transition={{ duration: 0.15 }}
                className="group flex items-center gap-2 rounded-md border border-border/50 bg-card/40 px-2.5 py-1.5"
              >
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1" title={entry.path}>
                  <span className="block truncate text-sm">{baseName(entry.path)}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {truncateMiddle(entry.path, 70)}
                  </span>
                </span>
                {ext && <Badge variant="outline" className="shrink-0 uppercase">{ext}</Badge>}
                <span className="shrink-0 tabular text-xs text-muted-foreground">
                  {entry.size !== undefined ? formatBytes(entry.size) : "—"}
                </span>
                {onRemove && (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`移除 ${baseName(entry.path)}`}
                    onClick={() => onRemove(entry.path)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                )}
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>

      {hidden > 0 && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Trash2 className="h-3.5 w-3.5" />
          还有 {hidden} 个文件未显示（已全部纳入本次任务）。
        </div>
      )}
    </div>
  );
}
