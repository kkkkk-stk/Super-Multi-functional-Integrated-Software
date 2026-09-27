import { Package, ShieldAlert } from "lucide-react";
import * as React from "react";

import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { pluginCategoryLabel, runtimeKindLabel, usePluginsSnapshot } from "@/hooks/use-plugins";
import type { PluginSummary } from "@/types/domain";

/**
 * 插件选择器。
 *
 * 三个 runner 页面（转换 / 图片 / 批量）都用它选"要跑哪个插件"。
 * 选项里带上运行时类型与状态，因为这三件事直接决定任务能不能跑：
 * 未启用的、零授权的、缺引擎的，都会在选项上标出来。
 */
export function PluginPicker({
  value,
  onChange,
  filter,
  label = "选择处理方式",
  ariaLabel = "选择插件",
  className,
}: {
  value: string | null;
  onChange: (pluginId: string) => void;
  filter?: (plugin: PluginSummary) => boolean;
  label?: string;
  ariaLabel?: string;
  className?: string;
}) {
  const snapshot = usePluginsSnapshot();

  const plugins = React.useMemo(
    () => snapshot.plugins.filter((p) => (filter ? filter(p) : true)),
    [snapshot.plugins, filter],
  );

  const selected = plugins.find((p) => p.id === value) ?? null;

  if (plugins.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border/70 p-4 text-xs text-muted-foreground">
        没有可用的插件。到「插件市场」安装一个，或在「流程编辑器」里搭一条流水线导出成插件。
      </div>
    );
  }

  return (
    <div className={className}>
      <label className="mb-1.5 block text-xs font-medium" htmlFor="plugin-picker">
        {label}
      </label>
      <Select
        id="plugin-picker"
        aria-label={ariaLabel}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        options={plugins.map((p) => ({
          value: p.id,
          label: `${p.name}（${runtimeKindLabel(p.runtimeKind)}${p.enabled ? "" : " · 未启用"}）`,
        }))}
        placeholder={value ? undefined : "请选择一个插件"}
        className="h-9"
      />

      {selected && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Badge variant="outline">{pluginCategoryLabel(selected.category)}</Badge>
          <Badge variant={selected.enabled ? "success" : "secondary"}>
            {selected.enabled ? "已启用" : "未启用"}
          </Badge>
          {selected.hasPendingPermissions && (
            <Badge variant="high">
              <ShieldAlert className="h-3 w-3" /> 有未授权项
            </Badge>
          )}
          {selected.builtin && (
            <Badge variant="outline">
              <Package className="h-3 w-3" /> 内置
            </Badge>
          )}
          <span className="text-[11px] text-muted-foreground">
            {selected.description ?? "（该插件没有写描述）"}
          </span>
        </div>
      )}
    </div>
  );
}

/** 便捷：默认选中第一个"可用"的插件（已启用且权限齐全） */
export function useDefaultPlugin(
  filter?: (plugin: PluginSummary) => boolean,
): [string | null, (id: string) => void] {
  const snapshot = usePluginsSnapshot();
  const [value, setValue] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (value && snapshot.plugins.some((p) => p.id === value)) return;
    const candidates = snapshot.plugins.filter((p) => (filter ? filter(p) : true));
    // 优先挑"已启用 + 权限齐全"的，避免用户一进来就撞到"未授权"的墙。
    // 注意这里**只是排序偏好**，不是可用性判定：部分授权的插件仍然可以选
    // （缺的能力在运行期才拦，见 `PluginStore::set_enabled` 的文档）。
    const preferred =
      candidates.find((p) => p.enabled && !p.hasPendingPermissions && p.grantedCount > 0) ??
      candidates.find((p) => p.enabled && p.grantedCount > 0) ??
      candidates.find((p) => p.enabled) ??
      candidates[0];
    setValue(preferred ? preferred.id : null);
  }, [snapshot.plugins, value, filter]);

  return [value, setValue];
}
