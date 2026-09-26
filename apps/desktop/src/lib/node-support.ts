/**
 * 内置节点的**执行器支持情况**。
 *
 * ## 名单来自后端，不在前端硬编
 *
 * `pipeline_nodes` 除了返回节点目录与引擎可用性，还返回
 * `NodeCatalogResponse.unimplemented` —— 它源于
 * `toolforge_core::pipeline::UNIMPLEMENTED_NODES`（**唯一真相来源**）。
 *
 * 这份名单曾经在**四个地方**各存了一份：Rust 执行器、`docs/PLUGIN-SDK.md`、
 * 示例清单的注释、以及本文件。结果是每实现一个节点就要手工同步四处 ——
 * 而且这个项目**已经真的因此踩过坑**：示例清单里写着"逐文件扇出尚未落地"
 * 而代码早就实现了，读者会照着去绕开一个不存在的问题。
 *
 * 现在后端把它推过来，前端只做渲染。后端还有两条测试守着这份名单与
 * 真实分发表的一致性（`unimplemented_list_matches_actual_dispatch`、
 * `is_implemented_is_the_complement_of_the_list`）。
 *
 * ## 为什么用模块级缓存而不是 hook
 *
 * `isNodeImplemented()` 会在十来个组件里同步调用（节点面板、画布节点、
 * Inspector、插件详情、三个 runner 页…）。把它们全改成 hook 会牵连一大片，
 * 而收益只是"少一个模块级变量"。折中做法是：由拉过 `pipeline_nodes` 的
 * 组件把名单灌进来（`useSyncCanvasWithCatalog` 已经在那条路径上），
 * 其余组件同步读取。
 *
 * **加载完成前后行为差异**：目录还没回来时按"已实现"处理（不显示警告），
 * 而不是猜一个可能错的结论。数据到达后 React Query 会触发重渲染，
 * 警告随即出现。
 */

let unimplemented = new Set<string>();
let loaded = false;

/** 由拉过 `pipeline_nodes` 的地方调用，把后端名单装进来。 */
export function setUnimplementedNodes(names: readonly string[]): void {
  unimplemented = new Set(names);
  loaded = true;
}

/** 供测试与调试：当前是否已经拿到过后端名单 */
export function isSupportListLoaded(): boolean {
  return loaded;
}

export function isNodeImplemented(nodeName: string): boolean {
  // 尚未拿到名单 → 不显示"未实现"警告。
  // 保守方向选这一边：误报"未实现"会让用户放弃一个**能用**的功能，
  // 而漏报只是晚几百毫秒提示。
  if (!loaded) return true;
  return !unimplemented.has(nodeName);
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
