/**
 * 内置节点的**执行器支持情况**。
 *
 * ## 为什么要在前端硬编码这份名单
 *
 * `pipeline_nodes` 返回的是**节点目录**（`builtin_nodes()`），而执行器
 * （`crates/toolforge-engines/src/nodes.rs` 的 `run()` 分发表）**还没有实现全部节点**：
 * 未命中的分支走 `not_implemented()`，返回
 * `内置节点 \`xxx\` 尚未在 v0.1 中实现`。
 *
 * 也就是说：目录里有、能拖进画布，但一跑就失败。用户在拖之前就该知道这件事，
 * 而不是等任务失败了再猜。后端没有把"是否已实现"暴露到 `NodeDescriptor` 里
 * （那是后端契约的事，前端不能改），所以在 UI 层显式列出。
 *
 * **维护方式**：对照 `nodes.rs` 里 `pub async fn run()` 的 match 分支逐条核对。
 * 一旦后端实现了某个节点，把它从这里删掉即可。
 */
const UNIMPLEMENTED_NODES = new Set<string>([
  "image.remove-background", // 抠图：需要 onnx 运行时，v0.1 未接入
  "ai.upscale", // AI 超分：同上
  "ai.describe", // 多模态描述：节点存在但执行器未接
  "doc.ocr", // OCR：需要 python 运行时+Tesseract，v0.1 未接
  "ebook.convert", // 电子书：Calibre/Pandoc 链路未接
  "flow.foreach", // 批量循环：由流水线执行器统一调度并发，节点本身不实现
]);

export function isNodeImplemented(nodeName: string): boolean {
  return !UNIMPLEMENTED_NODES.has(nodeName);
}

/** UI 上"未实现"提示的文案；已实现返回 `null` */
export function nodeSupportNote(nodeName: string): string | null {
  if (isNodeImplemented(nodeName)) return null;
  return "该能力尚未实现（v0.1 执行器未接入此节点）：画布里可以放置，但任务会以「未实现」失败，请勿依赖。";
}

/** 「已实现 / 未实现」徽章用的短标签 */
export function nodeSupportBadge(nodeName: string): "ready" | "unimplemented" {
  return isNodeImplemented(nodeName) ? "ready" : "unimplemented";
}

/** 一组节点里是否存在未实现的（插件卡片 / 工具页用来打"部分能力未实现"的标记） */
export function hasUnimplementedNodes(nodeNames: string[]): boolean {
  return nodeNames.some((n) => !isNodeImplemented(n));
}

export function unimplementedNodeNames(nodeNames: string[]): string[] {
  return nodeNames.filter((n) => !isNodeImplemented(n));
}
