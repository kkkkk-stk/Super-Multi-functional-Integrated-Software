/**
 * 能力（Capability）的展示与风险定级。
 *
 * ## 为什么要在前端再写一份
 *
 * Rust 侧 `Capability::describe()` / `Capability::risk()` 是好东西，但它们**不在
 * IPC 契约里**：`PluginManifest.permissions` 到达前端时是原始的 `Capability[]`
 * （`permission.rs` 的结构体没有中文描述字段）。权限确认面板必须逐条列出
 * "这条能力到底是干什么的、有多危险"，所以这里镜像实现一份。
 *
 * **镜像规则必须与 `crates/toolforge-core/src/permission.rs` 一致**，
 * 改了那边就要改这里（`risk()` 与 `describe()` 一一对应）：
 *
 * | 能力 | 风险 |
 * |---|---|
 * | `fsRead{scope: 沙箱内}` | low |
 * | `fsRead{scope: explicit}` | high |
 * | `fsWrite{任意}` | medium |
 * | `net{hosts: []}`（任意主机） | **high** |
 * | `net{hosts: [...]}` | medium |
 * | `exec` | **critical** |
 * | `env` | medium |
 * | `ai` / `gpu` | low |
 */

import type {
  Capability,
  PathScope,
  PermissionSet,
  RiskLevel,
  RuntimeKind,
} from "@/types/domain";

/**
 * 取出能力数组。
 *
 * `PermissionSet` 在后端是 `{ capabilities: [...] }`（**刻意没有** `serde(transparent)`，
 * 见 `permission.rs`）。这里额外容忍"裸数组"形态：那个属性是后端后来才去掉的，
 * 万一再改回去，前端不至于整片崩掉 —— 一个 `Array.isArray` 的判断换这份保险很划算。
 */
export function capabilityList(set: PermissionSet | Capability[] | null | undefined): Capability[] {
  if (!set) return [];
  if (Array.isArray(set)) return set as Capability[];
  return set.capabilities ?? [];
}

/** 反过来：把能力数组包成 `PermissionSet`（`plugins_grant` 的载荷形状） */
export function toPermissionSet(caps: Capability[]): PermissionSet {
  return { capabilities: caps };
}


export function describePathScope(scope: PathScope): string {
  switch (scope.kind) {
    case "input":
      return "读取本次任务的输入文件";
    case "output":
      return "写入本次任务的输出目录";
    case "pluginData":
      return "读写插件自己的数据目录";
    case "workspace":
      return "读写本次任务的临时目录";
    case "explicit":
      return `访问宿主机路径：${scope.pattern}`;
    default:
      // 类型收窄后理论不可达；后端若新增作用域先落到这里而不是崩溃
      return "未知路径作用域（后端版本可能比前端新）";
  }
}

/** `PathScope` 是否属于沙箱内（由宿主分配，不会逃逸） */
export function isSandboxedScope(scope: PathScope): boolean {
  return scope.kind !== "explicit";
}

/** 「这项能力在运行时到底管不管」的结论 */
export type EnforcementLevel =
  /** 运行时真的按它拦 —— 面板上打勾是有意义的 */
  | "enforced"
  /** 只有一部分被强制（例如 L2 的 net 拦主机、L3 的 net 只有默认断网） */
  | "partial"
  /** 授权了也不生效（宿主没有调用点，或者根本没有注入通道） */
  | "inert";

export interface EnforcementInfo {
  level: EnforcementLevel;
  /** 面向用户的说明。`enforced` 时说明"强制到了什么程度" */
  note: string | null;
}

/**
 * 这项能力在**运行时**到底有没有被强制。
 *
 * ## 为什么这个函数必须存在
 *
 * 授权面板上打勾给人的暗示是"宿主会按这个勾来拦"。而实际上：
 *
 * | 能力 | 运行时状态 |
 * |---|---|
 * | `fsRead` / `fsWrite` | ✅ **强制**。每一次文件访问先过 `CapabilityGuard::check()`，拒绝时返回 `PluginCapabilityViolation` 并记审计 |
 * | `net` | ⚠️ **分层**。L2：Extism 的 `allowed_hosts` 由**声明 ∩ 授权**翻译而来，越界请求被沙箱自己拒绝（见 `runtimes/wasm.rs::allowed_hosts_from`）—— **真拦**；L3：只有"清空环境 + 代理指向 `127.0.0.1:1`"这一层默认断网，`hosts` 白名单没有运行时校验，插件可以直接用 `socket` 绕过代理 |
 * | `exec` | ❌ **未强制**。`CapabilityGuard` 有 `Spawn` 分支，但没有调用点；L3 插件可以直接 `subprocess` 起进程 |
 * | `env` | ❌ **未强制，而且授权了也不会生效**。L3 进程被 `env_clear()`，一个环境变量都读不到 —— 白名单没有注入通道 |
 * | `ai` / `gpu` | ❌ **未强制**（`CapabilityRequest` 里连对应变体都还没有） |
 *
 * 这不是"实现得还不够"的借口，而是**界面不能骗人**：用户勾了"读取环境变量"
 * 却什么都没发生、勾了"启动进程"以为被管住了，都是误导。
 * `docs/SECURITY.md` §9 逐条记录了这些缺口。
 *
 * ## 为什么要传 `runtimeKind`
 *
 * 同一个能力在 L2 与 L3 下的强制程度**不一样**，而这里曾经只有一个文案：
 *
 * > 「宿主目前不代插件发 HTTP，也没有运行时校验下面这份主机白名单」
 *
 * 这句话在 2026-09 之前对**所有**运行时都是真的，之后对 L2 变成了**假的**
 * （L2 的主机白名单已经真的交给沙箱了）。一条过期的免责声明看起来"更安全"，
 * 实际后果是相反的：它会劝作者删掉一份**必须**声明的 `net`，
 * 而删掉之后插件必然报 `HTTP request to … is not allowed`。
 *
 * 所以：**不知道运行时就不下结论**（返回 `null`，界面不显示那一行），
 * 而不是拿一句可能过期的话去蒙。
 */
export function capabilityEnforcement(
  cap: Capability,
  runtimeKind?: RuntimeKind,
): EnforcementInfo {
  switch (cap.kind) {
    case "fsRead":
    case "fsWrite":
      return { level: "enforced", note: null };

    case "net": {
      if (runtimeKind === "wasm") {
        // L2：白名单真的进了沙箱
        return {
          level: "enforced",
          note:
            cap.hosts.length > 0
              ? "这份主机白名单会被交给 WASM 沙箱（Extism 的 allowedHosts），越界的请求会被沙箱自己拒绝。只有主机名参与匹配，端口不参与。"
              : "空列表 = 任意主机，沙箱会放行所有请求。",
        };
      }
      if (runtimeKind === "python") {
        return {
          level: "partial",
          note: cap.hosts.length > 0
            ? "L3 的默认断网（代理指向 127.0.0.1:1）由进程环境承担，但下面这份主机白名单没有运行时校验 —— 插件可以直接用 socket 绕过代理。"
            : "L3 的默认断网由进程环境承担，与这次授权无关；蓄意的插件可以用 socket 绕过。",
        };
      }
      // 运行时未知（或 L1 内置流水线）：不下结论
      return { level: "partial", note: null };
    }

    case "exec":
      return {
        level: "inert",
        note: "L3 插件可以直接启动子进程。授权它等于确认你知道这件事。",
      };

    case "env": {
      if (runtimeKind === "python") {
        // L3：真的注入了，见 `runtimes/python.rs::inject_declared_env`
        return {
          level: cap.names.length > 0 ? "enforced" : "inert",
          note:
            cap.names.length > 0
              ? "只有这里列出的变量会被**逐个**从宿主环境读出并注入插件进程；插件进程的其它环境变量一律为空。宿主上不存在的名字会记进应用日志，插件读到的是空。"
              : "名单为空 —— 没有任何变量会被注入，插件进程的环境里只有运行时自己需要的几个（PATH、PYTHON*）。",
        };
      }
      if (runtimeKind === "wasm") {
        return {
          level: "inert",
          note: "WASM 沙箱关掉了 WASI，模块连 environ 都读不到 —— 这一项对 L2 插件没有任何作用。",
        };
      }
      if (runtimeKind === "pipeline") {
        return {
          level: "inert",
          note: "L1 的节点跑在宿主进程里，本身就能读环境变量，宿主没有可拦的位置 —— 这一项对 L1 只是声明。",
        };
      }
      return { level: "inert", note: null };
    }

    case "ai":
      return {
        level: "inert",
        note: "宿主尚未实现按能力裁决 AI 调用：内置节点走的是宿主自己的 AI 客户端，与这次授权无关。",
      };

    case "gpu":
      return { level: "inert", note: "宿主没有针对 GPU 的任何限制手段。" };

    default:
      return { level: "inert", note: null };
  }
}

/** 上面的兼容包装：返回"未强制"的说明，已完全强制时返回 `null`（不传运行时） */
export function capabilityEnforcementNote(cap: Capability): string | null {
  const info = capabilityEnforcement(cap);
  return info.level === "enforced" ? null : info.note;
}

/** 上面的机器可读版本：`false` 表示"声明了但运行时并不完全按它拦" */
export function isCapabilityEnforced(cap: Capability, runtimeKind?: RuntimeKind): boolean {
  return capabilityEnforcement(cap, runtimeKind).level === "enforced";
}

export function describeCapability(cap: Capability): string {
  switch (cap.kind) {
    case "fsRead":
      return `读文件 —— ${describePathScope(cap.scope)}`;
    case "fsWrite":
      return `写文件 —— ${describePathScope(cap.scope)}`;
    case "net":
      return cap.hosts.length === 0
        ? "访问网络（任意主机，无限制）"
        : `访问网络（仅限：${cap.hosts.join(", ")}）`;
    case "exec":
      return "启动外部进程";
    case "env":
      return `读取环境变量：${cap.names.join(", ")}`;
    case "ai":
      return "调用 AI 服务（消耗你的额度）";
    case "gpu":
      return "使用 GPU";
    default:
      return "未知能力（后端版本可能比前端新）";
  }
}

export function capabilityRisk(cap: Capability): RiskLevel {
  switch (cap.kind) {
    case "fsRead":
      return cap.scope.kind === "explicit" ? "high" : "low";
    case "fsWrite":
      return "medium";
    case "net":
      return cap.hosts.length === 0 ? "high" : "medium";
    case "exec":
      // 能起子进程 ≈ 任意代码执行，最高一档
      return "critical";
    case "env":
      return "medium";
    case "ai":
    case "gpu":
      return "low";
    default:
      return "medium";
  }
}

/**
 * 能力指纹 —— 与 Rust 的 `Capability::fingerprint()`（`serde_json::to_string`）
 * **逐字节一致**，这样"声明 ∩ 已授权"的交集判断在前端也能自己做。
 *
 * serde 序列化结构体按字段声明顺序输出，而每个变体都只有一个字段，
 * 因此这里手写顺序即可完全对齐。
 */
export function capabilityFingerprint(cap: Capability): string {
  switch (cap.kind) {
    case "fsRead":
    case "fsWrite":
      return JSON.stringify({ kind: cap.kind, scope: scopeToJson(cap.scope) });
    case "net":
      return JSON.stringify({ kind: "net", hosts: cap.hosts });
    case "env":
      return JSON.stringify({ kind: "env", names: cap.names });
    default:
      return JSON.stringify({ kind: cap.kind });
  }
}

function scopeToJson(scope: PathScope): Record<string, unknown> {
  // `explicit` 是结构体变体（`{ kind, pattern }`），与后端 `PathScope::Explicit { pattern }`
  // 的 serde 输出逐字节一致。
  return scope.kind === "explicit"
    ? { kind: "explicit", pattern: scope.pattern }
    : { kind: scope.kind };
}

export function sameCapability(a: Capability, b: Capability): boolean {
  return capabilityFingerprint(a) === capabilityFingerprint(b);
}

/** 需要额外警示文案的能力（PermissionGate 里会显示第二行红字） */
export function capabilityWarning(cap: Capability): string | null {
  switch (cap.kind) {
    case "exec":
      return "能启动任意外部程序 —— 等价于在该插件进程的权限下执行任意命令，这是最高危的一档。只有你完全信任其来源时才应勾选。";
    case "net":
      return cap.hosts.length === 0
        ? "允许连接任意主机，意味着插件可以把你的文件内容发送到任何地方。建议优先选择限定了 host 的版本。"
        : "允许连接上述主机。请确认这些域名确实是该插件功能所必需的。";
    case "fsWrite":
      return cap.scope.kind === "explicit"
        ? "插件可以直接写宿主机上的绝对路径（绕过了沙箱目录分配），请务必核对路径范围。"
        : null;
    case "fsRead":
      return cap.scope.kind === "explicit"
        ? "插件可以直接读取宿主机上的绝对路径。清单里的路径 glob 决定了它能看哪些文件，请逐字核对。"
        : null;
    case "env":
      return "凡是列出的环境变量都会被插件读到 —— 请确认里面没有 API Key、Token 之类的凭据。";
    case "ai":
      return "会消耗你的 AI 额度（按调用计费）。";
    default:
      return null;
  }
}

/** 权限集合的整体风险 = 最高的那一条（与 `PermissionSet::risk_level()` 一致） */
export function permissionSetRisk(set: PermissionSet | Capability[]): RiskLevel {
  const caps = capabilityList(set);
  const order: RiskLevel[] = ["low", "medium", "high", "critical"];
  let max = 0;
  for (const c of caps) {
    max = Math.max(max, order.indexOf(capabilityRisk(c)));
  }
  return order[max] ?? "low";
}

export const RISK_LABELS: Record<RiskLevel, string> = {
  low: "低风险",
  medium: "中等风险",
  high: "高风险",
  critical: "极高风险",
};
