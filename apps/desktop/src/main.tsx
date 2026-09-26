import { QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { App } from "@/App";
import "@/index.css";
import { queryClient } from "@/lib/query-client";
import { applyPersistedTheme } from "@/lib/theme";

/**
 * 入口。
 *
 * 顺序很关键：**先把主题套到 `<html>` 上，再渲染**。
 * 等 IPC 拿到 `Settings` 再套会有一帧白/黑闪烁；这里的值来自本地持久化
 * （zustand persist 写入 localStorage 的那份），随后由
 * `useSettingsThemeSync()` 用后端权威值校正。
 *
 * 注意 CSP 是 `script-src 'self'`，所以 index.html 里不能放内联脚本 ——
 * 防闪烁只能在 JS 入口里做。
 */
applyPersistedTheme();

const container = document.getElementById("root");
if (!container) {
  throw new Error("找不到 #root 容器：index.html 被改坏了");
}

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
