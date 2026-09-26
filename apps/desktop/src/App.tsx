import { AlertTriangle, RotateCcw } from "lucide-react";
import * as React from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";

import { AppShell } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { AiPage } from "@/features/ai/ai-page";
import { BatchPage } from "@/features/batch/batch-page";
import { ConvertPage } from "@/features/convert/convert-page";
import { DashboardPage } from "@/features/dashboard/dashboard-page";
import { ImagePage } from "@/features/image/image-page";
import { JobsPage } from "@/features/jobs/jobs-page";
import { PipelinePage } from "@/features/pipeline/pipeline-page";
import { PluginsPage } from "@/features/plugins/plugins-page";
import { SettingsPage } from "@/features/settings/settings-page";

/**
 * 路由表 + 错误边界。
 *
 * 用 `BrowserRouter` 而不是 HashRouter：桌面端的入口永远是同一个 index.html，
 * 而前端路由只在内存里切换，不会真的去请求子路径，所以不需要 hash 来规避 404。
 *
 * 错误边界是**必需的**：一个页面的渲染异常不应该让整个窗口白屏 —— 用户可能正在
 * 跑一个几十分钟的批量任务。边界只把内容区替换掉，侧边栏/顶栏/状态栏保持可用。
 */
export function App() {
  return (
    <>
      <Routes>
        <Route element={<AppShell />}>
          <Route
            index
            element={
              <PageBoundary name="仪表盘">
                <DashboardPage />
              </PageBoundary>
            }
          />
          <Route
            path="convert"
            element={
              <PageBoundary name="格式转换">
                <ConvertPage />
              </PageBoundary>
            }
          />
          <Route
            path="image"
            element={
              <PageBoundary name="图片工具">
                <ImagePage />
              </PageBoundary>
            }
          />
          <Route
            path="batch"
            element={
              <PageBoundary name="批量处理">
                <BatchPage />
              </PageBoundary>
            }
          />
          <Route
            path="pipeline"
            element={
              <PageBoundary name="流程编辑器">
                <PipelinePage />
              </PageBoundary>
            }
          />
          <Route
            path="plugins"
            element={
              <PageBoundary name="插件市场">
                <PluginsPage />
              </PageBoundary>
            }
          />
          <Route
            path="ai"
            element={
              <PageBoundary name="AI 工作室">
                <AiPage />
              </PageBoundary>
            }
          />
          <Route
            path="jobs"
            element={
              <PageBoundary name="任务中心">
                <JobsPage />
              </PageBoundary>
            }
          />
          <Route
            path="settings"
            element={
              <PageBoundary name="设置">
                <SettingsPage />
              </PageBoundary>
            }
          />
          {/* 未知路径回首页，而不是留一个空白窗口 */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <Toaster />
    </>
  );
}

interface BoundaryState {
  error: Error | null;
}

class PageBoundary extends React.Component<
  { name: string; children: React.ReactNode },
  BoundaryState
> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // 控制台留痕：桌面端没有远程上报，本地日志是唯一的线索
    // eslint-disable-next-line no-console
    console.error(`[toolforge] 「${this.props.name}」渲染失败：`, error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  override render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 rounded-lg border border-destructive/50 bg-destructive/[0.06] p-10 text-center">
        <AlertTriangle className="h-8 w-8 text-destructive" />
        <p className="text-sm font-medium">「{this.props.name}」这一页出错了</p>
        <p className="max-w-lg whitespace-pre-wrap break-all text-xs text-muted-foreground">
          {this.state.error.message}
        </p>
        <p className="max-w-lg text-xs text-muted-foreground">
          其它页面、任务队列与文件处理都不受影响。可以先重试，或者回仪表盘。
        </p>
        <div className="flex gap-2">
          <Button size="sm" className="gap-1.5" onClick={this.reset}>
            <RotateCcw className="h-3.5 w-3.5" />
            重试
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link to="/" onClick={this.reset}>
              回仪表盘
            </Link>
          </Button>
        </div>
      </div>
    );
  }
}
