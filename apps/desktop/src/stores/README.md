/**
 * # stores 的职责边界（**读完再动手加状态**）
 *
 * ## 一句话铁律
 *
 * > **所有来自 Rust 的异步数据归 TanStack Query；Zustand 只存瞬时 UI 状态。**
 * > 同一条数据**绝不允许两处存**。
 *
 * ## 判断标准
 *
 * 加一个状态之前先问：**"它有没有一个来自后端的权威副本？"**
 *
 * | 有权威副本（→ Query） | 没有权威副本（→ Zustand） |
 * |---|---|
 * | 任务列表 / 单个任务 / 任务统计 | 侧边栏是否折叠 |
 * | 引擎目录与探测状态 | 命令面板是否打开 |
 * | 插件列表 / 插件详情 / 审计日志 | 当前选中的任务 / 插件 / 节点 |
 * | 内置节点目录 | 流程画布的节点与连线 |
 * | 用户设置（主题、并发、AI 配置） | 拖拽态（是否正在拖、拖了哪些文件） |
 * | 系统状态 | 引擎下载的实时速率（后端只发增量，没有快照） |
 * | AI 生成的草稿与审核报告（命令返回值） | AI 流式输出的中间缓冲 |
 *
 * 右边这一列的共性是：**刷新页面就该丢掉**，或者**只对当前 UI 有意义**。
 *
 * ## 事件到达时怎么做
 *
 * 事件（`toolforge://event`）是**缓存失效信号**，不是数据源：
 *
 * ```ts
 * // ✅ 正确：更新 Query 缓存
 * queryClient.setQueryData(queryKeys.jobs, (prev) => patchJob(prev, event.job));
 *
 * // ❌ 错误：往 store 里再存一份任务列表
 * useJobStore.setState({ jobs: [...] });
 * ```
 *
 * ## 唯一的两个例外（都在这里写明了理由）
 *
 * 1. **`ui-store.engineDownloads`** —— 引擎下载进度只以"增量事件"的形式存在
 *    （`engineDownloadProgress` 每次只给 downloaded/total/speed_bps），后端
 *    不提供任何可查询的快照。它属于"事件流状态"，不是"查询结果"。
 * 2. **`ui-store.aiStream`** —— AI 流式输出的中间缓冲同理，最终结果仍然走
 *    命令返回值（Query 的 mutation 结果）。
 *
 * ## 主题为什么也算瞬时状态
 *
 * Rust 的 `Settings.theme/accent/ambientEffects` 是权威来源，但首屏渲染必须
 * 立刻套用主题（等 IPC 会闪一下），切换时也要立刻响应。所以 store 里存的是
 * **"已经套用到 DOM 上的那一份"**，由 `use-settings.ts` 从 Query 数据单向同步，
 * 用户操作则走 `settings_patch` mutation。详见 `lib/theme.ts` 的模块注释。
 */

export {};
