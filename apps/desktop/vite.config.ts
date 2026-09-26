import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * # Vite 配置（Tauri 2 + React 18）
 *
 * ## 三条与 Tauri 强相关的约定
 *
 * 1. **端口固定 1420 + strictPort**：`src-tauri/tauri.conf.json` 的 `devUrl`
 *    写死了 `http://localhost:1420`，让 Vite 自动换端口会导致窗口白屏。
 * 2. **HMR 用同源同端口**（不另开端口）：应用的 CSP 是
 *    `connect-src 'self' ipc: http://ipc.localhost`，而 `'self'` 只覆盖**同源**
 *    的 WebSocket。如果 HMR 挪到 1421，Tauri 窗口里的 HMR 通道会被 CSP 拦掉
 *    （浏览器里直连 dev server 却看不出问题，属于最费时间的那类故障）。
 * 3. **内联脚本要挪成外链**：`script-src 'self'` 不允许内联脚本，而
 *    `@vitejs/plugin-react` 默认把 Fast Refresh 的 preamble 内联进 index.html。
 *    所以这里加了一个 `reactRefreshPreambleShim` 插件，把它改写成
 *    `<script src="/@toolforge/react-refresh-preamble.js">` —— 同源外链，
 *    CSP 放行。**没有这层处理时，Tauri 窗口里的开发模式会直接白屏**
 *    （模块里会抛 "can't detect preamble"）。
 *
 * ## 别名
 *
 * `@` 指向 `./src`，用 Vite 的"根目录相对路径"写法（`"/src"`），
 * 避免为了 `path.resolve` 再引入 `@types/node`（依赖清单是锁定的）。
 */
export default defineConfig({
  plugins: [react(), reactRefreshPreambleShim()],
  resolve: {
    alias: {
      "@": "/src",
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    watch: {
      // src-tauri 与 Rust 产物变化不该触发前端重载
      ignored: ["**/src-tauri/**", "**/target/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "chrome110",
    minify: "esbuild",
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks: {
          // 把体积最大的两块拆出去，首屏只加载壳
          flow: ["@xyflow/react"],
          motion: ["framer-motion"],
        },
      },
    },
  },
});

/**
 * 把 Fast Refresh 的 preamble 从"内联脚本"改成"同源外链模块"。
 *
 * 为什么需要：CSP 的 `script-src 'self'` 会拦掉 index.html 里的内联脚本，
 * 而 `@vitejs/plugin-react` 默认就是内联注入的。被拦掉之后，每个被转换过的模块
 * 都会在顶部抛 `@vitejs/plugin-react can't detect preamble`，整个应用起不来。
 *
 * 实现只用了两个钩子：
 * - `configureServer`：在 dev server 上把 preamble 当成一个静态模块提供；
 * - `transformIndexHtml`（`order: "post"`，确保在 plugin-react 之后执行）：
 *   把内联的 `<script type="module">…</script>` 换成 `<script src=…>`。
 *
 * 匹配失败时（例如插件升级换了注入形态）**原样返回**，退回默认行为 ——
 * 宁可回到"控制台报错"也不要造出一个语法坏掉的 HTML。
 */
function reactRefreshPreambleShim(): Plugin {
  const url = "/@toolforge/react-refresh-preamble.js";
  return {
    name: "toolforge:react-refresh-preamble-shim",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(url, (_req, res) => {
        res.setHeader("Content-Type", "application/javascript");
        res.setHeader("Cache-Control", "no-cache");
        // `preambleCode` 里带 `__BASE__` 占位符（plugin-react 默认在
        // transformIndexHtml 阶段替换它）。这里自己提供模块，必须自己替换，
        // 否则浏览器会拿到 `"__BASE__@react-refresh"` 这种解析不了说明符。
        res.end(react.preambleCode.replace(/__BASE__/g, server.config.base));
      });
    },
    transformIndexHtml: {
      order: "post",
      handler(html: string) {
        const inlinePreamble =
          /<script type="module">\s*import \{ injectIntoGlobalHook \} from "\/@react-refresh";[\s\S]*?<\/script>/;
        if (!inlinePreamble.test(html)) return html;
        return html.replace(inlinePreamble, `<script type="module" src="${url}"></script>`);
      },
    },
  };
}
