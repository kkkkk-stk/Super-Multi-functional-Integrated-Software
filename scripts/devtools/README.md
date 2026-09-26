# 真机验证工具（CDP）

ToolForge 的 UI 跑在 WebView2 里。这一套脚本通过 **CDP（Chrome DevTools Protocol）**
读取 WebView 的**真实渲染状态**，用来补上自动化测试覆盖不到的那一层。

> **为什么需要它**：本项目的自动化检查（`cargo check`、194 个单元测试、
> `tsc --noEmit`、`vite build`）**全部通过**的情况下，真机跑一次仍然找出了
> **3 个发布级缺陷**。共同点是"组件各自正确，连起来不对" ——
> 单元测试验证组件，集成测试验证接口形状，而**真实数据流**只有真跑一次才会经过。

---

## 快速开始

两个终端：

```powershell
# 终端 1：带调试端口启动
.\scripts\devtools\dev-with-cdp.ps1

# 终端 2：跑全部检查
node scripts/devtools\run.mjs
```

也可以单独跑某一个（终端 1 仍需在跑）：

```powershell
node scripts/devtools/inspect.mjs   # 单页体检
node scripts/devtools/smoke.mjs     # 9 个路由逐个走
node scripts/devtools/e2e.mjs       # 一次真实转换任务
node scripts/devtools/verify.mjs    # 解码 / 多文件扇出 / 恶意插件安全测试
```

`pnpm dev:cdp` 与 `pnpm verify:app` 是上面两条命令的简写。

---

## 为什么不用窗口截图

我最初用 PowerShell + `PrintWindow` 抓窗口截图，拿到 93.5% 纯白，**差点写下
"应用白屏"**。

WebView2 的内容由**独立的合成进程**绘制，`PrintWindow` 只能抓到窗口背景。
那个"白屏"是**抓不到**，不是**没渲染**。

结论碰巧是对的（当时确实白屏，真因是 `freezePrototype` 与 `@xyflow/react`
冲突），但**理由是错的** —— 而靠巧合得出的正确结论，下次会以同样的方式给出
错误结论。所以这里一律走 CDP：它由 WebView 提供、看到的就是渲染结果，
而且能读到页面异常。

`inspect.mjs` 里的 `Page.captureScreenshot` 抓的才是真实内容。

---

## 各脚本做什么

### `inspect.mjs` —— 单页体检

首要指标是 **`#root` 的子节点数**：只有 `#root` 存在是不够的，
`<div id="root"></div>` 空着也是白屏。同时输出屏幕上的真实文字、
DOM 节点数、可交互元素、页面异常，并保存一张 CDP 截图。

> 它抓到过：`freezePrototype: true` 冻结 `Object.prototype`，而
> `@xyflow/react` 在模块初始化时要写它 → 一个顶层 import 抛异常 →
> 整个应用白屏。`cargo check` / `tsc` / `vite build` 全绿。

### `smoke.mjs` —— 路由冒烟

逐个切换 9 个路由，每页等数据到位后统计节点数 / 文本长度 / 骨架屏元素 / 新异常。

它验证的不是某个函数，而是**前端路由 + 每个页面的数据依赖
（TanStack Query → IPC → Rust）**这条整链。一个页面白屏、抛异常、
或永远停在骨架屏，都会被抓到。

### `e2e.mjs` —— 端到端任务

生成一张渐变色 PNG，走**与 UI 完全相同**的 IPC 路径提交转换任务，
轮询到终态，然后**解码产出**确认尺寸。

> 它抓到过：`PathResolver` 一律拒绝绝对路径，而 `l1.rs` 把 `${src}` 绑定成
> 真实绝对路径 —— **任何一次真实转换都失败**。当时 194 个单测 + 6 个集成测试
> 全绿，因为所有 `PathResolver` 测试都是拿相对路径直接调 `resolve()`，
> 没有一个走过"用户选中的文件 → 模板渲染 → 节点 → resolver"这条真实数据流。

### `verify.mjs` —— 验证包

1. **产出可解码** —— 只看魔数不够，解析 WebP 容器取出真实尺寸，
   截断的文件会在这里露馅；
2. **多文件扇出** —— 3 张进是否 3 个**不同**文件出、尺寸是否各自独立。
   这是对"只处理第一张却报告全部成功"那个 bug 的正面验证；
3. **恶意插件安全测试** —— 装一个步骤里写死
   `C:\Windows\System32\drivers\etc\hosts` 的**恶意清单**，授权、启用、真跑，
   确认在真实链路上被拒绝，**并确认审计日志里有 `pathEscapeBlocked` 记录**，
   最后把它卸载干净；
4. 对照组：用户显式指定的（深层、尚不存在的）输出目录应当被创建并使用 ——
   这是**预期行为**，不是漏洞。

---

## 已知限制

**这一套验不了的两件事，只能靠人：**

* **从资源管理器真实拖拽文件** —— 走的是 Tauri 的原生 drag-drop 事件
  （`dragDropEnabled`），不是 DOM 的 `dragstart`，脚本模拟不了；
* **主题切换的视觉效果**（浅色 / 深色 / 跟随系统 + 各套强调色）。

另外它需要**一个活着的窗口**，所以进不了 CI —— CI 没有显示环境。
它属于"半手动"工具：本地开发、改完 UI 后、发布前各跑一次。

---

## 落盘位置

测试素材与产物都在 `<repo>/.tools/smoke/`（已被 `.gitignore` 忽略）：

```
.tools/smoke/
├── in/                 生成的测试 PNG
├── out-e2e/            e2e 的产出
├── out-verify-*/       verify 的产出
└── inspect.png         inspect 的截图
```

测试过程会**真的安装再卸载**一个测试插件（`com.toolforge.test.evil-traversal`），
并往真实数据目录的审计日志里写记录 —— 这是刻意的：审计本身也要被验证。
