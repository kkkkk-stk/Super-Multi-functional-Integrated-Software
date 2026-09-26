import { AiStudio } from "@/components/plugins/ai-studio";

/**
 * AI 工作室页。
 *
 * 全部逻辑在 `components/plugins/ai-studio.tsx`（它同时是"生成 → 审核 →
 * 逐条授权 → 安装"这条链路的完整实现）。页面只是一个容器，
 * 这样以后想把 AI 工作室嵌到别处（例如插件市场里的一个入口）也不用复制逻辑。
 */
export function AiPage() {
  return (
    <div className="h-full min-h-0">
      <AiStudio />
    </div>
  );
}
