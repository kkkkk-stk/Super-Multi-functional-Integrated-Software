import {
  Bug,
  CheckCircle2,
  Cpu,
  Eye,
  EyeOff,
  FolderOpen,
  Info,
  KeyRound,
  Loader2,
  Monitor,
  Moon,
  Palette,
  RefreshCw,
  ShieldCheck,
  Sun,
  Zap,
} from "lucide-react";
import * as React from "react";
import { useSearchParams } from "react-router-dom";

import { EngineGrid } from "@/components/engines/engine-grid";
import { ModelPanel } from "@/components/engines/model-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { SkeletonCard } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAudit } from "@/hooks/use-plugins";
import { useAiTestConnection, usePatchSettings, useSettings, useSystemStatus } from "@/hooks/use-settings";
import { ACCENTS, THEME_MODES } from "@/lib/theme";
import { formatDateTime } from "@/lib/format";
import { openExternal, pickDirectory, revealInExplorer } from "@/lib/system";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui-store";
import type { AiProviderKind } from "@/types/domain";

const PROVIDERS: { value: AiProviderKind; label: string; local?: boolean }[] = [
  { value: "openAi", label: "OpenAI" },
  { value: "deepSeek", label: "DeepSeek" },
  { value: "dashScope", label: "通义千问（阿里云百炼）" },
  { value: "moonshot", label: "Kimi（月之暗面）" },
  { value: "ollama", label: "Ollama（本地）", local: true },
  { value: "lmStudio", label: "LM Studio（本地）", local: true },
  { value: "custom", label: "自定义 OpenAI 兼容端点" },
];

const PROVIDER_DEFAULT_BASE_URL: Record<AiProviderKind, string> = {
  openAi: "https://api.openai.com/v1",
  deepSeek: "https://api.deepseek.com/v1",
  dashScope: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  moonshot: "https://api.moonshot.cn/v1",
  ollama: "http://127.0.0.1:11434/v1",
  lmStudio: "http://127.0.0.1:1234/v1",
  custom: "",
};

const PROVIDER_DEFAULT_MODEL: Record<AiProviderKind, string> = {
  openAi: "gpt-4o-mini",
  deepSeek: "deepseek-chat",
  dashScope: "qwen-plus",
  moonshot: "moonshot-v1-8k",
  ollama: "qwen2.5:14b",
  lmStudio: "local-model",
  custom: "",
};

type TabKey = "appearance" | "tasks" | "ai" | "engines" | "security" | "about";

const TABS: { key: TabKey; label: string }[] = [
  { key: "appearance", label: "外观" },
  { key: "tasks", label: "任务与文件" },
  { key: "ai", label: "AI 服务" },
  { key: "engines", label: "引擎管理" },
  { key: "security", label: "安全与审计" },
  { key: "about", label: "关于" },
];

/**
 * 设置页。
 *
 * 六个标签页：外观 / 任务与文件 / AI / 引擎 / 安全与审计 / 关于。
 * 当前页由 URL 的 `?tab=` 决定（`useSearchParams`），所以命令面板与别处的
 * "去设置里的某一页"链接都能直接落到正确的位置（例如安全弹窗里的 `?tab=security`）。
 *
 * 所有写入都走 `settings_patch`（局部更新，未传的字段后端保持不变），
 * 界面读的是后端返回的那份权威值 —— 不存在"前端自己先改了再说"的情况。
 */
export function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as TabKey | null) ?? "appearance";

  const setTab = (next: TabKey) => {
    const merged = new URLSearchParams(params);
    merged.set("tab", next);
    setParams(merged, { replace: true });
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold">设置</h1>
        <p className="text-xs text-muted-foreground">
          设置改动会立刻写入本机数据目录下的{" "}
          <span className="font-mono">settings.json</span>（原子写，不联网）。
          AI 的 API Key 不在那个文件里：它默认只存在内存中，只有你打开「记住 API Key」
          时才会另存到 <span className="font-mono">ai-key.txt</span>。
        </p>
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="self-start">
          {TABS.map((item) => (
            <TabsTrigger key={item.key} value={item.key}>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="min-h-0 flex-1 overflow-y-auto pr-1 scrollbar-thin">
          <TabsContent value="appearance" className="mt-2">
            <AppearanceSection />
          </TabsContent>
          <TabsContent value="tasks" className="mt-2">
            <TasksSection />
          </TabsContent>
          <TabsContent value="ai" className="mt-2">
            <AiSection />
          </TabsContent>
          <TabsContent value="engines" className="mt-2">
            <EngineGrid />
            <div className="mt-6 border-t border-border/60 pt-5">
              <ModelPanel />
            </div>
          </TabsContent>
          <TabsContent value="security" className="mt-2">
            <SecuritySection />
          </TabsContent>
          <TabsContent value="about" className="mt-2">
            <AboutSection />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

// ============================================================================
// 外观
// ============================================================================

function AppearanceSection() {
  const settings = useSettings();
  const patch = usePatchSettings();
  const theme = useUiStore((s) => s.theme);
  const accent = useUiStore((s) => s.accent);
  const ambient = useUiStore((s) => s.ambientEffects);

  return (
    <div className="max-w-2xl space-y-6">
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">主题</h2>
          <p className="text-xs text-muted-foreground">
            「跟随系统」会随操作系统的深色模式自动切换（切换是平滑的，不需要重启）。
          </p>
        </div>
        <div className="flex gap-2">
          {THEME_MODES.map((mode) => {
            const active = theme === mode.mode;
            const Icon = mode.mode === "dark" ? Moon : mode.mode === "light" ? Sun : Monitor;
            return (
              <button
                key={mode.mode}
                type="button"
                aria-pressed={active}
                onClick={() => patch.mutate({ theme: mode.mode })}
                className={cn(
                  "flex flex-1 items-center justify-center gap-2 rounded-lg border p-3 text-sm transition-colors",
                  active
                    ? "border-primary/60 bg-primary/10 text-primary"
                    : "border-border/60 hover:border-border",
                )}
              >
                <Icon className="h-4 w-4" />
                {mode.label}
              </button>
            );
          })}
        </div>
      </section>

      <Separator />

      <section className="space-y-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <Palette className="h-4 w-4" />
            强调色
          </h2>
          <p className="text-xs text-muted-foreground">
            改变按钮、高亮、焦点环与背景光晕的颜色；切换时有 0.3 秒的平滑过渡。
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {ACCENTS.map((option) => {
            const active = accent === option.name;
            return (
              <button
                key={option.name}
                type="button"
                aria-pressed={active}
                onClick={() => patch.mutate({ accent: option.name })}
                className={cn(
                  "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                  active ? "border-primary/60 bg-primary/5" : "border-border/60 hover:border-border",
                )}
              >
                <span
                  className="mt-0.5 h-5 w-5 shrink-0 rounded-full ring-1 ring-border"
                  style={{ background: option.swatch }}
                  aria-hidden="true"
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-sm">
                    {option.label}
                    {active && <CheckCircle2 className="h-3.5 w-3.5 text-primary" />}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                    {option.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <Separator />

      <section className="space-y-3">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <Zap className="h-4 w-4" />
          背景氛围动效
        </h2>
        <label className="flex items-start gap-3 rounded-lg border border-border/60 p-3">
          <Switch
            checked={ambient}
            onCheckedChange={(value) => patch.mutate({ ambientEffects: value })}
            aria-label="背景氛围动效"
            className="mt-0.5"
          />
          <span className="text-xs">
            <span className="font-medium">启用极光背景与浮动光斑</span>
            <span className="mt-0.5 block text-muted-foreground">
              关闭后会省掉一整层合成与模糊计算 —— 低配机器、外接 4K 屏或远程桌面下建议关闭。
              另外：系统的"减少动态效果"偏好始终优先，开启它时动效会自动静止。
            </span>
          </span>
        </label>
      </section>

      {settings.data && (
        <p className="text-[11px] text-muted-foreground">
          后端记录：theme={settings.data.theme} · accent={settings.data.accent} ·
          ambientEffects={String(settings.data.ambientEffects)}
          {patch.isPending && " · 保存中…"}
        </p>
      )}
    </div>
  );
}

// ============================================================================
// 任务与文件
// ============================================================================

function TasksSection() {
  const settings = useSettings();
  const patch = usePatchSettings();
  const [concurrency, setConcurrency] = React.useState("");

  React.useEffect(() => {
    if (settings.data) setConcurrency(String(settings.data.concurrency));
  }, [settings.data]);

  if (!settings.data) return <SkeletonCard lines={4} />;
  const s = settings.data;

  return (
    <div className="max-w-2xl space-y-6">
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">任务并发度</h2>
        <p className="text-xs text-muted-foreground">
          批量任务同时处理几个文件。范围 1~64，后端会再夹紧一次。
        </p>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={1}
            max={64}
            value={concurrency}
            onChange={(e) => setConcurrency(e.target.value)}
            className="h-8 w-24 text-xs"
            aria-label="任务并发度"
          />
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            disabled={patch.isPending || String(s.concurrency) === concurrency}
            onClick={() => {
              const value = Number.parseInt(concurrency, 10);
              if (!Number.isFinite(value)) return;
              patch.mutate({ concurrency: value });
            }}
          >
            保存
          </Button>
        </div>
      </section>

      <Separator />

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">默认输出目录</h2>
        <p className="text-xs text-muted-foreground">
          留空时任务会写到应用数据目录下的 <span className="font-mono">output/</span> ——
          宿主绝不往用户没指定的位置写文件。
        </p>
        <div className="flex items-center gap-2">
          <Input
            value={s.defaultOutputDir}
            onChange={(e) => patch.mutate({ defaultOutputDir: e.target.value })}
            placeholder="（留空）"
            className="h-8 flex-1 font-mono text-xs"
            aria-label="默认输出目录"
          />
          <Button
            size="sm"
            variant="outline"
            className="h-8 shrink-0 text-xs"
            onClick={async () => {
              const dir = await pickDirectory({ title: "选择默认输出目录" });
              if (dir) patch.mutate({ defaultOutputDir: dir });
            }}
          >
            选择…
          </Button>
          {s.defaultOutputDir && (
            <Button
              size="sm"
              variant="ghost"
              className="h-8 shrink-0 text-xs"
              onClick={() => patch.mutate({ defaultOutputDir: "" })}
            >
              清空
            </Button>
          )}
        </div>
      </section>

      <Separator />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">行为</h2>
        <label className="flex items-start gap-3 rounded-lg border border-border/60 p-3">
          <Checkbox
            checked={s.keepOriginal ?? true}
            onCheckedChange={(value) => patch.mutate({ keepOriginal: value })}
            label="批量处理时保留源文件"
            className="mt-0.5"
          />
          <span className="text-xs">
            <span className="font-medium">批量处理时保留源文件（推荐）</span>
            <span className="mt-0.5 block text-muted-foreground">
              关闭后，处理成功的文件会被删除。这是不可逆的 —— 只在确认产出正确后再考虑。
            </span>
          </span>
        </label>

        <label className="flex items-start gap-3 rounded-lg border border-border/60 p-3">
          <Checkbox
            checked={s.probeEnginesOnStartup ?? true}
            onCheckedChange={(value) => patch.mutate({ probeEnginesOnStartup: value })}
            label="启动时自动探测引擎"
            className="mt-0.5"
          />
          <span className="text-xs">
            <span className="font-medium">启动时自动探测引擎</span>
            <span className="mt-0.5 block text-muted-foreground">
              探测会依次调用各引擎的 <span className="font-mono">--version</span>，
              在机械硬盘或杀毒软件实时扫描下可能拖慢启动。关掉后可以随时手动探测。
            </span>
          </span>
        </label>
      </section>
    </div>
  );
}

// ============================================================================
// AI
// ============================================================================

function AiSection() {
  const settings = useSettings();
  const patch = usePatchSettings();
  const test = useAiTestConnection();
  const [apiKey, setApiKey] = React.useState("");
  const [showKey, setShowKey] = React.useState(false);

  // 生成类型里 `Settings` 与 `AiSettings` 的字段都是可选的（Rust 侧每个字段都带
  // `#[serde(default)]`，specta 因此标成可选；运行时后端一定会发出它们）。
  // 这里提前收窄一次，后面的表单就能拿到确定的类型，不需要满页面写 `??`。
  if (!settings.data?.ai) return <SkeletonCard lines={5} />;
  const ai = settings.data.ai;
  // `provider` 同样可能缺席（比如手改过的 settings.json）。后端 `Default` 给的是
  // OpenAI；前端这里用同一个兜底值，免得出现 `PROVIDER_DEFAULT_*[undefined]`。
  const provider: AiProviderKind = ai.provider ?? "openAi";

  return (
    <div className="max-w-2xl space-y-6">
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">提供方</h2>
          {ai.hasKey ? (
            <Badge variant="success">
              <KeyRound className="h-3 w-3" /> 已配置 Key
            </Badge>
          ) : (
            <Badge variant="warning">未配置 Key</Badge>
          )}
        </div>
        <Select
          value={provider}
          onChange={(e) => {
            const next = e.target.value as AiProviderKind;
            // 换提供方时把端点和模型填成该家的默认值，省得用户手抄
            patch.mutate({
              ai: {
                ...ai,
                provider: next,
                baseUrl: PROVIDER_DEFAULT_BASE_URL[next] || ai.baseUrl,
                model: PROVIDER_DEFAULT_MODEL[next] || ai.model,
              },
            });
          }}
          aria-label="AI 提供方"
          options={PROVIDERS.map((p) => ({ value: p.value, label: p.label }))}
          className="h-9"
        />
        <p className="text-[11px] text-muted-foreground">
          只支持 OpenAI 兼容协议 —— 这是事实标准，云端（OpenAI / DeepSeek / 通义 / Kimi）
          与本地（Ollama / LM Studio）都能覆盖，不需要为每家写一个适配器。
        </p>
      </section>

      <section className="space-y-3">
        <div>
          <Label htmlFor="ai-base-url">端点（base url）</Label>
          <Input
            id="ai-base-url"
            value={ai.baseUrl}
            onChange={(e) => patch.mutate({ ai: { ...ai, baseUrl: e.target.value } })}
            placeholder={PROVIDER_DEFAULT_BASE_URL[provider]}
            className="mt-1 h-8 font-mono text-xs"
            aria-label="AI 端点"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            留空则使用该提供方的默认端点。指向本地 Ollama 时填{" "}
            <span className="font-mono">http://127.0.0.1:11434/v1</span>。
          </p>
        </div>

        <div>
          <Label htmlFor="ai-model">模型</Label>
          <Input
            id="ai-model"
            value={ai.model}
            onChange={(e) => patch.mutate({ ai: { ...ai, model: e.target.value } })}
            placeholder={PROVIDER_DEFAULT_MODEL[provider]}
            className="mt-1 h-8 font-mono text-xs"
            aria-label="AI 模型"
          />
        </div>

        <div>
          {/* `temperature` 在生成类型里是 `number | null | undefined`，滑杆只接受数字 */}
          <Label htmlFor="ai-temperature">温度（{ai.temperature ?? 0.2}）</Label>
          <input
            id="ai-temperature"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={ai.temperature ?? 0.2}
            onChange={(e) =>
              patch.mutate({ ai: { ...ai, temperature: Number(e.target.value) } })
            }
            className="mt-1 w-full accent-[hsl(var(--primary))]"
            aria-label="采样温度"
          />
          <p className="text-[11px] text-muted-foreground">
            生成插件清单建议 0~0.3：清单是结构化数据，太高的温度只会带来格式错误。
          </p>
        </div>

        <div>
          <Label htmlFor="ai-key">API Key</Label>
          <div className="mt-1 flex items-center gap-2">
            <Input
              id="ai-key"
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={ai.hasKey ? "已配置（留空表示不修改）" : "sk-…"}
              className="h-8 flex-1 font-mono text-xs"
              aria-label="AI API Key"
              autoComplete="off"
            />
            <Button
              size="icon"
              variant="outline"
              aria-label={showKey ? "隐藏 Key" : "显示 Key"}
              onClick={() => setShowKey((v) => !v)}
            >
              {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </Button>
            <Button
              size="sm"
              className="h-8 text-xs"
              disabled={patch.isPending}
              onClick={() => {
                patch.mutate({ aiApiKey: apiKey }, { onSuccess: () => setApiKey("") });
              }}
            >
              保存 Key
            </Button>
            {ai.hasKey && (
              <Button
                size="sm"
                variant="ghost"
                className="h-8 text-xs text-destructive"
                onClick={() => patch.mutate({ aiApiKey: "" })}
              >
                清除
              </Button>
            )}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Key 不会出现在任何序列化给界面的结构体里，也不会写进日志或插件。
            默认只存在本次运行的内存中；是否落盘由下面的开关决定。
          </p>
        </div>

        <div className="flex items-start gap-3">
          <Switch
            id="ai-persist-key"
            className="mt-0.5"
            checked={ai.persistApiKey ?? false}
            onCheckedChange={(v) => patch.mutate({ ai: { ...ai, persistApiKey: v } })}
            aria-label="记住 API Key"
          />
          <div className="space-y-0.5">
            <Label htmlFor="ai-persist-key">记住 API Key（重启后仍然可用）</Label>
            <p className="text-[11px] text-muted-foreground">
              默认关闭：Key 只存在本次运行的内存里，重启要重填。
              打开后会被<span className="text-foreground">明文</span>写进数据目录下的{" "}
              <span className="font-mono">ai-key.txt</span>；关掉开关会立刻删掉那个文件。
              系统钥匙串（Windows DPAPI / macOS Keychain）还没接 —— 见路线图。
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={test.isPending}
            onClick={() => test.mutate()}
          >
            {test.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            测试连接
          </Button>
          {test.data && (
            <span className="text-xs text-muted-foreground">
              {test.data.ok
                ? `可用模型 ${test.data.models.length} 个${
                    test.data.models.length > 0 ? `：${test.data.models.slice(0, 4).join("、")}` : ""
                  }`
                : `不可用：${test.data.error ?? "未知原因"}`}
            </span>
          )}
        </div>
      </section>

      <section className="rounded-lg border border-border/60 bg-card/40 p-4 text-[11px] text-muted-foreground">
        <p className="flex items-start gap-1.5">
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          AI 只用来「生成插件草稿」。草稿不会自动安装：它必须通过静态校验与安全审核，
          再由你在权限面板里逐条确认后才会落盘。
        </p>
      </section>
    </div>
  );
}

// ============================================================================
// 安全与审计
// ============================================================================

function SecuritySection() {
  const audit = useAudit(300);

  return (
    <div className="max-w-4xl space-y-6">
      <section className="space-y-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <ShieldCheck className="h-4 w-4" />
          安全模型（这里做了什么、没做什么）
        </h2>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border border-success/40 bg-success/[0.06] p-3 text-xs">
            <p className="mb-1 font-medium text-success">已做到的</p>
            <ul className="space-y-1 text-muted-foreground">
              <li>· 权限声明制：代码里用没声明过的能力 → 直接拒绝并记审计。</li>
              <li>· 最小授权：声明 ≠ 授权，实际生效的是「声明 ∩ 已授权」。</li>
              <li>· 路径收敛：插件只能引用逻辑作用域，绝对路径与 <span className="font-mono">..</span> 逃逸被拦截。</li>
              <li>· 内容哈希：装载前后校验，防止插件被替换。</li>
              <li>· L2 WASM 完全沙箱（无文件系统、无网络）。</li>
            </ul>
          </div>
          <div className="rounded-lg border border-warning/50 bg-warning/[0.07] p-3 text-xs">
            <p className="mb-1 font-medium text-warning">没做到（请自行判断）</p>
            <ul className="space-y-1 text-muted-foreground">
              <li>· L3 Python 插件以你的身份运行，隔离挡不住蓄意恶意代码。</li>
              <li>· 已授权的 <span className="font-mono">exec</span> 等价于任意命令执行，勾选前请务必确认来源。</li>
              <li>· 静态审核（含 AI 审核）只能发现模式，不能证明"没有后门"。</li>
              <li>· 网络白名单是后缀匹配，不能防止通过已授权域名做数据外传。</li>
            </ul>
          </div>
        </div>
      </section>

      <Separator />

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">审计日志</h2>
          <Badge variant="outline">{audit.data?.events.length ?? 0} 条</Badge>
          {audit.data?.dir && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 text-xs"
              onClick={() => void revealInExplorer(audit.data?.dir ?? "")}
            >
              <FolderOpen className="h-3.5 w-3.5" />
              打开审计目录
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 text-xs"
            disabled={audit.isFetching}
            onClick={() => void audit.refetch()}
          >
            <RefreshCw className={audit.isFetching ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
            刷新
          </Button>
        </div>

        <p className="text-[11px] text-muted-foreground">
          审计格式是 NDJSON（每行一个 JSON），可以直接用 <span className="font-mono">Select-String</span> /{" "}
          <span className="font-mono">jq</span> 过滤。重点看这几类：
          <span className="font-mono">pathEscapeBlocked</span>（试图访问授权范围外的路径）、
          <span className="font-mono">capabilityViolation</span>（用了没声明的能力）、
          <span className="font-mono">privilegeEscalation</span>（升级后多要权限）、
          <span className="font-mono">integrityFailure</span>（哈希不符）。
        </p>

        {audit.isLoading ? (
          <SkeletonCard lines={4} />
        ) : !audit.data || audit.data.events.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border/70 p-6 text-center text-xs text-muted-foreground">
            今天还没有审计事件。安装/授权/卸载插件、越权与路径逃逸拦截都会写在这里。
          </p>
        ) : (
          <ul className="space-y-1.5">
            {[...audit.data.events].reverse().map((event, idx) => {
              // 会标红的都是**安全事件**，不是普通操作记录。
              //
              // `pathEscapeBlocked` 是这里面最值得看的一类：它意味着某个插件
              // 试图访问授权目录之外的路径（例如 `C:\Windows\System32\...`）。
              // 这条曾经完全没有被记录 —— 见 `toolforge-plugins/src/l1.rs` 的注释。
              const alarming =
                event.kind === "pathEscapeBlocked" ||
                event.kind === "capabilityViolation" ||
                event.kind === "integrityFailure" ||
                event.kind === "privilegeEscalation";
              return (
                <li
                  key={`${event.at}-${idx}`}
                  className={cn(
                    "rounded-md border p-2.5 text-xs",
                    alarming ? "border-destructive/50 bg-destructive/[0.06]" : "border-border/60",
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={alarming ? "destructive" : "outline"}>{event.kind}</Badge>
                    <span className="tabular text-[10px] text-muted-foreground">
                      {formatDateTime(event.at)}
                    </span>
                    {event.subject && (
                      <span className="truncate font-mono text-[10px] text-muted-foreground">
                        {event.subject}
                      </span>
                    )}
                  </div>
                  <p className="mt-1">{event.summary}</p>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

// ============================================================================
// 关于
// ============================================================================

function AboutSection() {
  const { data: system, isLoading, refetch, isFetching } = useSystemStatus();

  return (
    <div className="max-w-3xl space-y-6">
      <section className="space-y-3 rounded-lg border border-border/60 bg-card/40 p-4">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/15 text-sm font-bold text-primary">
            TF
          </span>
          <div>
            <h2 className="text-sm font-semibold">
              ToolForge {system ? `v${system.info.version}` : ""}
            </h2>
            <p className="text-xs text-muted-foreground">
              插件驱动的集成式多功能工具箱。核心功能完全离线可用。
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto h-8 gap-1.5 text-xs"
            disabled={isFetching}
            onClick={() => void refetch()}
          >
            <RefreshCw className={isFetching ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
            刷新
          </Button>
        </div>

        {isLoading || !system ? (
          <SkeletonCard lines={4} />
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
            <dt className="text-muted-foreground">Tauri</dt>
            <dd className="tabular">{system.info.tauriVersion}</dd>
            <dt className="text-muted-foreground">Rust</dt>
            <dd className="tabular">{system.info.rustVersion}</dd>
            <dt className="text-muted-foreground">插件协议</dt>
            <dd className="font-mono">{system.info.pluginApiVersion}</dd>
            <dt className="text-muted-foreground">构建类型</dt>
            <dd>{system.info.buildProfile}</dd>
            <dt className="text-muted-foreground">平台</dt>
            <dd>{system.platform}</dd>
            <dt className="text-muted-foreground">已注册命令</dt>
            <dd className="tabular">{system.commandCount} 个</dd>
            <dt className="text-muted-foreground">引擎 / 插件</dt>
            <dd className="tabular">
              {system.enginesReady}/{system.enginesTotal} 可用 · {system.pluginsEnabled}/
              {system.pluginsTotal} 已启用
            </dd>
            <dt className="text-muted-foreground">存储</dt>
            <dd className={system.storageWritable ? "text-success" : "text-destructive"}>
              {system.storageWritable ? "数据目录可写" : "数据目录不可写（任务会失败）"}
            </dd>
          </dl>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <FolderOpen className="h-4 w-4" />
          目录
        </h2>
        {system?.paths.entries.map((entry) => (
          <div key={entry.path} className="flex items-center gap-2 rounded-md border border-border/60 p-2.5">
            <span className="w-20 shrink-0 text-xs text-muted-foreground">{entry.label}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={entry.path}>
              {entry.path}
            </span>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`打开${entry.label}`}
              onClick={() => void revealInExplorer(entry.path)}
            >
              <FolderOpen className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </section>

      <section className="space-y-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <Bug className="h-4 w-4" />
          排查问题
        </h2>
        <ul className="space-y-1 text-xs text-muted-foreground">
          <li>· 任务失败时先看「任务中心」里那条任务的日志尾部（引擎 stderr 会原样带出来）。</li>
          <li>· 插件不工作：检查是否已启用、是否已逐条授权、是否缺引擎。</li>
          <li>· 引擎装不上：确认网络与许可证确认；没有校验值的来源需要显式允许。</li>
          <li>
            · 想看后端日志：设置里打开{" "}
            <span className="font-mono">logs</span> 目录。
          </li>
        </ul>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 text-xs"
          onClick={() => void openExternal("https://tauri.app/")}
        >
          <Cpu className="h-3.5 w-3.5" />
          关于 Tauri（应用框架）
        </Button>
      </section>
    </div>
  );
}
