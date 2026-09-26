/**
 * 导航定义（侧边栏与命令面板共用一份）。
 *
 * 之所以抽出来：命令面板里的"跳转到 X"必须与侧边栏**完全一致**，
 * 否则用户会发现"侧边栏有的页面，命令面板搜不到"这种低级不一致。
 */

import {
  Image as ImageIcon,
  Layers,
  LayoutDashboard,
  ListChecks,
  Puzzle,
  RefreshCw,
  Settings as SettingsIcon,
  Sparkles,
  Workflow,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  path: string;
  label: string;
  description: string;
  icon: LucideIcon;
  /** 命令面板的关键词（中英混排，方便用户用任意一种语言搜到） */
  keywords: string[];
  /** 侧边栏分组 */
  group: "工作台" | "扩展" | "系统";
}

export const NAV_ITEMS: NavItem[] = [
  {
    path: "/",
    label: "仪表盘",
    description: "系统概览、引擎状态、最近任务",
    icon: LayoutDashboard,
    keywords: ["dashboard", "home", "概览", "首页"],
    group: "工作台",
  },
  {
    path: "/convert",
    label: "格式转换",
    description: "图片 / 音视频 / 文档 / 压缩包互转",
    icon: RefreshCw,
    keywords: ["convert", "transcode", "转换", "转码", "格式"],
    group: "工作台",
  },
  {
    path: "/image",
    label: "图片工具",
    description: "缩放、裁剪、压缩、去背景",
    icon: ImageIcon,
    keywords: ["image", "photo", "图片", "缩放", "抠图", "压缩"],
    group: "工作台",
  },
  {
    path: "/batch",
    label: "批量处理",
    description: "对成百上千个文件跑同一条处理链",
    icon: Layers,
    keywords: ["batch", "批量", "重命名", "队列"],
    group: "工作台",
  },
  {
    path: "/pipeline",
    label: "流程编辑器",
    description: "用节点拖出一条可复用的处理流水线",
    icon: Workflow,
    keywords: ["pipeline", "flow", "节点", "流程", "编排", "编辑器"],
    group: "工作台",
  },
  {
    path: "/plugins",
    label: "插件市场",
    description: "安装、授权、管理插件与权限",
    icon: Puzzle,
    keywords: ["plugin", "插件", "扩展", "市场", "权限"],
    group: "扩展",
  },
  {
    path: "/ai",
    label: "AI 工作室",
    description: "用自然语言生成插件（产出永远是草稿）",
    icon: Sparkles,
    keywords: ["ai", "generate", "生成", "自然语言", "模型"],
    group: "扩展",
  },
  {
    path: "/jobs",
    label: "任务中心",
    description: "全部任务的进度、日志与产出",
    icon: ListChecks,
    keywords: ["jobs", "tasks", "任务", "日志", "进度"],
    group: "系统",
  },
  {
    path: "/settings",
    label: "设置",
    description: "外观、引擎管理、AI、安全与审计",
    icon: SettingsIcon,
    keywords: ["settings", "设置", "偏好", "引擎", "审计", "安全"],
    group: "系统",
  },
];

export const NAV_GROUPS: NavItem["group"][] = ["工作台", "扩展", "系统"];

export function findNavItem(pathname: string): NavItem | undefined {
  // 精确匹配优先，其次匹配前缀（用于将来加子路由）
  return (
    NAV_ITEMS.find((n) => n.path === pathname) ??
    NAV_ITEMS.find((n) => n.path !== "/" && pathname.startsWith(n.path))
  );
}
