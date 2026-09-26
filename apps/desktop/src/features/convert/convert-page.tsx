import { ArrowRight, FileWarning, Info } from "lucide-react";
import { Link } from "react-router-dom";

import { PluginPicker, useDefaultPlugin } from "@/components/plugins/plugin-picker";
import { PluginRunner } from "@/components/plugins/plugin-runner";
import { Button } from "@/components/ui/button";
import { usePluginsSnapshot } from "@/hooks/use-plugins";

/**
 * 格式转换页。
 *
 * ⚠️ 说清楚一件事：**ToolForge 没有"内置的转换功能"** —— 所有实际处理都由
 * **插件**（L1 声明式流水线 → 内置节点 → 外部引擎）完成。所以这个页面的第一步是
 * "选一个插件"，而不是"选一种格式"。
 *
 * 这样设计的好处：用户装了什么插件，这里就有什么能力，前端不需要为每种格式
 * 各写一套表单；代价是第一次使用时需要先有一个插件（内置插件已经提供了
 * 图片转换、视频转 GIF、批量重命名等）。
 */
export function ConvertPage() {
  const [pluginId, setPluginId] = useDefaultPlugin();
  const snapshot = usePluginsSnapshot();

  const hasAnyPlugin = snapshot.plugins.length > 0;

  return (
    <div className="grid h-full min-h-0 gap-4 xl:grid-cols-[1fr_320px]">
      <div className="min-h-0 space-y-4 overflow-y-auto pr-1 scrollbar-thin">
        <header className="space-y-1">
          <h1 className="text-lg font-semibold">格式转换</h1>
          <p className="text-xs text-muted-foreground">
            选一个插件 → 拖入文件 → 开始。处理在本机完成，文件不会被上传；
            需要的引擎缺失时任务会明确报错，而不是静默跳过。
          </p>
        </header>

        {!hasAnyPlugin ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border/70 p-10 text-center">
            <FileWarning className="h-8 w-8 text-muted-foreground/60" />
            <p className="text-sm">还没有任何插件</p>
            <p className="max-w-md text-xs text-muted-foreground">
              内置插件目录为空或尚未装载。到「插件市场」点一次「重新装载」，
              或者用「流程编辑器」搭一条流水线导出成插件。
            </p>
            <div className="flex gap-2">
              <Button asChild size="sm">
                <Link to="/plugins">
                  去插件市场 <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                </Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link to="/pipeline">搭一条流水线</Link>
              </Button>
            </div>
          </div>
        ) : (
          <>
            <PluginPicker value={pluginId} onChange={setPluginId} />
            {pluginId && <PluginRunner key={pluginId} pluginId={pluginId} />}
          </>
        )}
      </div>

      {/* 右栏：说明与快捷入口 */}
      <aside className="min-h-0 space-y-4 overflow-y-auto pr-1 scrollbar-thin">
        <section className="rounded-lg border border-border/60 bg-card/40 p-4 text-xs">
          <h2 className="mb-2 flex items-center gap-1.5 font-semibold">
            <Info className="h-3.5 w-3.5" />
            关于"转换能力从哪来"
          </h2>
          <p className="text-muted-foreground">
            每次转换实际上是跑一遍插件的流水线：宿主按顺序调用内置节点
            （<span className="font-mono">image.convert</span>、
            <span className="font-mono">video.transcode</span>…），
            节点再去调用对应的外部引擎。
          </p>
          <ul className="mt-2 space-y-1 text-muted-foreground">
            <li>· 纯 Rust 能力（图片探针/缩放/格式转换）无需任何引擎。</li>
            <li>· 音视频需要 FFmpeg，Office 转 PDF 需要 LibreOffice，"抠图"需要 Python + onnx 模型。</li>
            <li>· 引擎缺失只影响依赖它的节点，不会让整个应用不可用。</li>
          </ul>
          <Button asChild size="sm" variant="outline" className="mt-3 w-full text-xs">
            <Link to="/settings?tab=engines">查看/安装引擎</Link>
          </Button>
        </section>

        <section className="rounded-lg border border-border/60 bg-card/40 p-4 text-xs">
          <h2 className="mb-2 font-semibold">内置插件一览</h2>
          {snapshot.plugins.length === 0 ? (
            <p className="text-muted-foreground">暂无。</p>
          ) : (
            <ul className="space-y-1.5">
              {snapshot.plugins.map((p) => (
                <li key={p.id} className="flex items-start gap-2">
                  <span
                    className={
                      p.enabled
                        ? "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-success"
                        : "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50"
                    }
                  />
                  <button
                    type="button"
                    onClick={() => setPluginId(p.id)}
                    className="min-w-0 flex-1 text-left hover:text-primary"
                  >
                    <span className="block truncate">
                      {p.name}
                      {p.builtin && <span className="ml-1 text-[10px] text-muted-foreground">内置</span>}
                    </span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {p.description ?? p.id}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Button asChild size="sm" variant="ghost" className="mt-2 w-full text-xs">
            <Link to="/plugins">插件市场</Link>
          </Button>
        </section>

        <section className="rounded-lg border border-border/60 bg-card/40 p-4 text-xs text-muted-foreground">
          <h2 className="mb-2 font-semibold text-foreground">小提示</h2>
          <p>
            把文件拖到窗口「任意位置」都会进当前页面的输入列表；
            批量任务可以在「批量处理」页一次丢几百个文件，宿主会按设置里的并发度排队执行。
          </p>
        </section>
      </aside>
    </div>
  );
}
