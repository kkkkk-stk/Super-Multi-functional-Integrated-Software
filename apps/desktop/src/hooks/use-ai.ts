/**
 * AI 工作室的数据流。
 *
 * ## 关键约束：AI 的产出永远是草稿
 *
 * `ai_generate` **不写盘、不装载**，它只返回 `AiGenerateResponse`
 * （草稿 + 审核报告）。真正的安装必须由用户看过权限清单后另调 `plugins_install`。
 * 因此这里的 mutation 结果**不进 Query 缓存**（它是一次性命令返回值，不是"服务器
 * 状态"），而是留在页面本地 state 里；只有最后一步安装才走 `useInstallPlugin()`。
 *
 * 流式增量（`aiDelta` / `aiDone` 事件）落在 `ui-store.aiStream` —— 详见
 * `stores/README.md` 的例外说明 2。
 */

import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { aiGenerate, aiReviewDraft, toToolforgeError } from "@/lib/ipc";
import type { AiGenerateRequest, AiGenerateResponse, SecurityReview } from "@/types/domain";

export function useGeneratePlugin() {
  return useMutation({
    mutationFn: (req: AiGenerateRequest) => aiGenerate(req),
    onError: (e: unknown, req: AiGenerateRequest) => {
      const err = toToolforgeError(e);
      // AI 相关的失败几乎都要用户去改设置或改需求描述，把提示写具体
      if (err.code === "AI_UNAVAILABLE") {
        toast.error("尚未配置 AI 服务", {
          description: "请到「设置 → AI」填写提供方、模型与 API Key；也可以指向本地 Ollama。",
          duration: 12_000,
        });
        return;
      }
      if (err.code === "AI_REJECTED") {
        toast.error("模型输出不符合插件协议", {
          description: `${err.message}${err.detail ? `\n${err.detail}` : ""}`,
          duration: 12_000,
        });
        return;
      }
      toast.error(`生成失败（需求：${req.description.slice(0, 20)}…）`, {
        description: err.fullText,
        duration: 12_000,
      });
    },
  });
}

/** 对（可能被用户手改过的）清单文本重新审核 */
export function useReviewDraft() {
  return useMutation<SecurityReview, unknown, string>({
    mutationFn: (raw: string) => aiReviewDraft(raw),
    onError: (e) => toast.error("重新审核失败", { description: toToolforgeError(e).fullText }),
  });
}

export type { AiGenerateResponse };
