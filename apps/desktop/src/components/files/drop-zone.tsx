import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { FileDown, FolderOpen, ShieldQuestion } from "lucide-react";

import { useDropStore } from "@/stores/drop-store";

/**
 * 全窗口拖拽覆盖层。
 *
 * ## 交互细节
 *
 * - 拖入时高亮**整个视口**（而不是某个小方框）：桌面应用里用户常常是从资源管理器
 *   拖着文件、眼睛还在找落点，覆盖层越大越不容易漏；
 * - 覆盖层**不吃鼠标事件**（`pointer-events-none`），否则会打断原生拖放；
 * - 光晕跟随光标（`drop-store.pointer` 已在 effect 里换算成百分比，
 *   所以窗口缩放不会错位）；
 * - `AnimatePresence` 做进出场，`prefers-reduced-motion` 时退化为纯淡入淡出；
 * - 明确写出"支持的格式"与"拖入后会怎样"，避免用户猜。
 */
export function DropZone() {
  const dragging = useDropStore((s) => s.dragging);
  const pointer = useDropStore((s) => s.pointer);
  const reduced = useReducedMotion();

  return (
    <AnimatePresence>
      {dragging && (
        <motion.div
          key="dropzone"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduced ? 0.08 : 0.18 }}
          className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center"
          aria-hidden="true"
        >
          {/* 视口高亮 + 跟随光晕 */}
          <div className="absolute inset-0 bg-background/70 backdrop-blur-sm" />
          <div
            className="absolute h-[36rem] w-[36rem] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-80 transition-transform duration-150 ease-out"
            style={{
              left: `${pointer.x * 100}%`,
              top: `${pointer.y * 100}%`,
              background:
                "radial-gradient(circle, rgb(var(--glow) / 0.28), transparent 62%)",
              filter: "blur(40px)",
            }}
          />

          <motion.div
            initial={{ scale: reduced ? 1 : 0.94, y: reduced ? 0 : 8 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: reduced ? 1 : 0.96, opacity: 0 }}
            transition={{ type: "spring", stiffness: 320, damping: 28 }}
            className="relative m-6 w-full max-w-2xl rounded-2xl border-2 border-dashed border-primary/60 bg-card/85 p-10 text-center shadow-2xl"
          >
            <motion.div
              animate={reduced ? undefined : { y: [0, -6, 0] }}
              transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
              className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/15"
            >
              <FileDown className="h-7 w-7 text-primary" />
            </motion.div>

            <p className="text-lg font-semibold">松开即可导入文件</p>
            <p className="mt-1 text-sm text-muted-foreground">
              文件路径会直接交给本地引擎处理，「不会」上传到任何服务器。
            </p>

            <div className="mt-5 grid gap-3 text-left text-xs text-muted-foreground sm:grid-cols-2">
              <div className="rounded-lg border border-border/60 p-3">
                <p className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
                  <FolderOpen className="h-3.5 w-3.5" /> 支持的格式
                </p>
                <p>
                  图片：png / jpg / webp / bmp / tiff / gif / avif（AVIF 需 libvips）
                  <br />
                  音视频：mp4 / mkv / mov / webm / mp3 / flac / wav ……（需 FFmpeg）
                  <br />
                  文档：md / html / docx / epub / pdf（需 Pandoc / LibreOffice）
                  <br />
                  压缩包：zip / 7z / tar / gz（需 7-Zip）
                </p>
              </div>
              <div className="rounded-lg border border-border/60 p-3">
                <p className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
                  <ShieldQuestion className="h-3.5 w-3.5" /> 拖入之后
                </p>
                <p>
                  文件会填进当前页面的输入列表；点"开始"才会真正执行。
                  <br />
                  批量任务按设置里的并发度调度，源文件默认保留。
                  <br />
                  引擎缺失时任务会以「缺少能力引擎」失败，而不是静默跳过。
                </p>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
