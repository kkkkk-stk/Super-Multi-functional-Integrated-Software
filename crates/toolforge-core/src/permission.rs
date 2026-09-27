//! # 插件能力模型 —— 整个安全模型的根
//!
//! 这一层要解决一个非常具体的问题：**当插件是 AI 生成的、或从外部导入的时候，
//! 我们凭什么敢让它跑起来？**
//!
//! 答案不是"校验一下代码"，而是三条硬机制：
//!
//! 1. **声明制**：插件在清单里列出它需要的全部能力（[`Capability`]）。
//!    代码里出现没声明的能力调用 = 直接拒绝 + 记安全审计，不是"尽力而为"。
//! 2. **最小授权**：清单声明的能力**不等于**已授权。用户可逐条勾选，
//!    实际生效的是 `声明 ∩ 已授权`（[`PermissionSet::effective`]）。
//! 3. **运行时裁决 + 路径收敛**：所有文件访问都必须经过 [`PathResolver`]，
//!    它会把相对路径规范化后检查是否真的落在允许的根目录内 ——
//!    这一步专门用来挡 `../../../../etc/passwd` 这类穿越。
//!
//! 注意 [`PathScope`] 的设计意图：插件引用的是**逻辑作用域**（输入目录 / 输出目录 /
//! 自己的工作目录），由宿主决定它们各自对应哪个真实目录。所以"插件能碰哪些文件"
//! 完全由宿主决定。
//!
//! ⚠️ **但不要说成"插件拿不到绝对路径"** —— 那是错的，而且曾经因此写出一个发布级
//! bug（见 [`PathResolver::resolve`] 的文档）。`${src}` / `${output.dst}` 注入流水线的
//! 就是真实绝对路径。正确的表述是：**插件无法引用授权根之外的任何路径**。

use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};

use crate::error::{ErrorCode, ToolforgeError, ToolforgeResult};

// ============================================================================
// 路径作用域
// ============================================================================

/// 插件可引用的**逻辑**路径作用域。插件拿不到真实绝对路径。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PathScope {
    /// 本次任务的输入文件所在目录（宿主自动加入，只读）
    Input,
    /// 用户为本次任务指定的输出目录
    Output,
    /// 插件私有持久化目录（跨任务保留，例如模型缓存、配置）
    PluginData,
    /// 本次任务的临时目录，任务结束后由宿主清理
    Workspace,
    /// 显式声明的宿主机路径 glob。
    ///
    /// **这是逃生舱口，风险等级直接拉到 Critical**，UI 会用红色警示并要求二次确认。
    /// 只有确实需要访问固定系统目录（如 `%APPDATA%\SomeVendor`）时才应该用它。
    ///
    /// 注意这里用的是**结构体变体**而不是 `Explicit(String)`：因为整个枚举是
    /// 内部标签（`#[serde(tag = "kind")]`）表示，而 serde 与 specta 都不允许
    /// 内部标签与 newtype 变体共存（primitive 载荷无法与 tag 合并）。
    Explicit { pattern: String },
}

impl PathScope {
    /// 给用户看的中文描述。UI 直接渲染，不要在前端重复维护一份文案。
    pub fn describe(&self) -> String {
        match self {
            PathScope::Input => "读取本次任务的输入文件".into(),
            PathScope::Output => "写入本次任务的输出目录".into(),
            PathScope::PluginData => "读写插件自己的数据目录".into(),
            PathScope::Workspace => "读写本次任务的临时目录".into(),
            PathScope::Explicit { pattern } => format!("访问宿主机路径：{pattern}"),
        }
    }

    /// 该作用域是否属于"沙箱内"（即由宿主分配、不会逃逸）
    pub fn is_sandboxed(&self) -> bool {
        !matches!(self, PathScope::Explicit { .. })
    }
}

// ============================================================================
// 能力
// ============================================================================

/// 插件声明的一项能力。
///
/// serde 用 `kind` 做 tag，导出到 TS 就是可判别联合 ——
/// 前端可以直接 `switch (cap.kind)` 生成权限勾选界面，不需要额外映射表。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Capability {
    /// 读文件
    FsRead { scope: PathScope },
    /// 写文件
    FsWrite { scope: PathScope },
    /// 出网。`hosts` 为空表示"任意主机"，非空则只允许这些主机（后缀匹配）。
    Net { hosts: Vec<String> },
    /// 启动子进程
    Exec,
    /// 读取指定的环境变量（白名单，避免插件顺手把 API key 读走）
    Env { names: Vec<String> },
    /// 调用大模型服务（会计入用户额度）
    Ai,
    /// 使用 GPU
    Gpu,
}

impl Capability {
    /// 中文描述（UI 直接渲染）
    pub fn describe(&self) -> String {
        match self {
            Capability::FsRead { scope } => format!("读文件 —— {}", scope.describe()),
            Capability::FsWrite { scope } => format!("写文件 —— {}", scope.describe()),
            Capability::Net { hosts } if hosts.is_empty() => {
                "访问网络（任意主机，无限制）".to_string()
            }
            Capability::Net { hosts } => format!("访问网络（仅限：{}）", hosts.join(", ")),
            Capability::Exec => "启动外部进程".to_string(),
            Capability::Env { names } => format!("读取环境变量：{}", names.join(", ")),
            Capability::Ai => "调用 AI 服务（消耗你的额度）".to_string(),
            Capability::Gpu => "使用 GPU".to_string(),
        }
    }

    /// 风险等级 —— 决定确认弹窗的配色与文案强度。
    pub fn risk(&self) -> RiskLevel {
        match self {
            Capability::FsRead {
                scope: PathScope::Explicit { .. },
            } => RiskLevel::High,
            Capability::FsRead { .. } => RiskLevel::Low,
            Capability::FsWrite { .. } => RiskLevel::Medium,
            Capability::Net { hosts } if hosts.is_empty() => RiskLevel::High,
            Capability::Net { .. } => RiskLevel::Medium,
            // 能起子进程 = 基本等价于任意代码执行，这是最高危的一档
            Capability::Exec => RiskLevel::Critical,
            Capability::Env { .. } => RiskLevel::Medium,
            Capability::Ai => RiskLevel::Low,
            Capability::Gpu => RiskLevel::Low,
        }
    }

    /// 用于权限比较的稳定指纹（授权集合去重/求交用）
    pub fn fingerprint(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| format!("{self:?}"))
    }

    /// 传给**插件**的能力标签（camelCase，与清单里写的 `kind:` 逐字一致）。
    ///
    /// # 为什么需要它
    ///
    /// 插件载荷里的 `capabilities` 曾经是 `format!("{c:?}")` —— 也就是 Rust 的
    /// **Debug 输出**：`FsRead { scope: Input }`。而文档（`PLUGIN-SDK.md`
    /// 与两个 L2 示例的注释）写的都是 `["fsRead", "fsWrite"]`。
    ///
    /// 后果和参数那个缺陷是同一类：`plugins/python-example/main.py` 里
    /// `if "fsRead" not in caps: raise ...` 永远成立，于是这个示例插件
    /// **必然报"没有 fsRead 能力"**，而用户明明授权了。L2 的两个示例只是把标签
    /// 打进日志，所以没暴露 —— 又一次"只有真跑才会发现"。
    pub fn label(&self) -> &'static str {
        match self {
            Capability::FsRead { .. } => "fsRead",
            Capability::FsWrite { .. } => "fsWrite",
            Capability::Net { .. } => "net",
            Capability::Exec => "exec",
            Capability::Env { .. } => "env",
            Capability::Ai => "ai",
            Capability::Gpu => "gpu",
        }
    }

    /// 一条 `net.hosts` 条目里是不是带了**端口**。
    ///
    /// # 为什么这是一条错误而不是风格建议
    ///
    /// L2 沙箱把这份名单原样交给 Extism 的 `allowed_hosts`，而 Extism 的判定是
    /// （见 `extism-1.30.0/src/pdk.rs`）：
    ///
    /// ```text
    /// let host_str = url.host_str().unwrap_or_default();   // ← 只有主机名，没有端口
    /// allowed_hosts.iter().any(|p| glob::Pattern::new(p).matches(host_str))
    /// ```
    ///
    /// 于是 `api.example.com:443` 去匹配 `api.example.com` —— 永远不中。
    /// 作者以为自己写得更严格，实际得到的是一个**确定连不上网**的插件，
    /// 而且在运行时只会看到 `HTTP request to … is not allowed`，
    /// 那句报错指不到清单上那个冒号。
    ///
    /// 所以：安装前就报错，并在 `runtimes/wasm.rs::normalize_host_pattern`
    /// 里再兜一层（剥端口），保证已装好的插件不至于神秘失败。
    ///
    /// 判定刻意保守：IPv6 的 `[::1]` 不算带端口（方括号里的冒号不是分隔符），
    /// 冒号后面不是纯数字的（`a:b`）也放过 —— 不猜。
    pub fn net_host_has_port(host: &str) -> bool {
        let host = host.trim();
        if let Some(close) = host.rfind(']') {
            // IPv6 字面量：`[::1]:8080` 才算带端口
            let rest = &host[close + 1..];
            return rest
                .strip_prefix(':')
                .is_some_and(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
        }
        match host.rsplit_once(':') {
            Some((head, port)) => {
                !head.is_empty()
                    && !port.is_empty()
                    && port.chars().all(|c| c.is_ascii_digit())
            }
            None => false,
        }
    }
}

/// 风险等级
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum RiskLevel {
    Low,
    Medium,
    High,
    Critical,
}

impl RiskLevel {
    pub fn describe(self) -> &'static str {
        match self {
            RiskLevel::Low => "低风险",
            RiskLevel::Medium => "中等风险",
            RiskLevel::High => "高风险",
            RiskLevel::Critical => "极高风险",
        }
    }
}

// ============================================================================
// 权限集合
// ============================================================================

/// 一组能力声明。插件清单里的 `permissions` 和用户实际授予的集合都用它表示。
///
/// ⚠️ 这里**刻意不加** `#[serde(transparent)]`：加了之后 YAML 会变成
/// `permissions: [ ... ]` 这种裸数组，既不好读也没法在未来扩展字段。
/// 现在的形状是 `permissions: { capabilities: [ ... ] }`，
/// 所有示例插件与文档都按这个形状写。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PermissionSet {
    pub capabilities: Vec<Capability>,
}

impl PermissionSet {
    pub fn empty() -> Self {
        Self::default()
    }

    pub fn from_iter_caps(caps: impl IntoIterator<Item = Capability>) -> Self {
        let mut set = Self {
            capabilities: caps.into_iter().collect(),
        };
        set.dedup();
        set
    }

    pub fn is_empty(&self) -> bool {
        self.capabilities.is_empty()
    }

    pub fn dedup(&mut self) {
        let mut seen = std::collections::HashSet::new();
        self.capabilities
            .retain(|c| seen.insert(c.fingerprint()));
    }

    /// 全部指纹（前端用来做勾选状态）
    pub fn fingerprints(&self) -> Vec<String> {
        self.capabilities.iter().map(Capability::fingerprint).collect()
    }

    /// 本集合是否被 `other` 完全覆盖。
    /// 用于校验"AI 生成的新版本没有偷偷扩权"。
    pub fn is_subset_of(&self, other: &PermissionSet) -> bool {
        let granted: std::collections::HashSet<_> =
            other.capabilities.iter().map(Capability::fingerprint).collect();
        self.capabilities
            .iter()
            .all(|c| granted.contains(&c.fingerprint()))
    }

    /// `声明 ∩ 已授权`。**这是运行时真正生效的权限。**
    pub fn effective(declared: &PermissionSet, granted: &PermissionSet) -> PermissionSet {
        let granted_set: std::collections::HashSet<_> =
            granted.capabilities.iter().map(Capability::fingerprint).collect();
        let mut out = PermissionSet {
            capabilities: declared
                .capabilities
                .iter()
                .filter(|c| granted_set.contains(&c.fingerprint()))
                .cloned()
                .collect(),
        };
        out.dedup();
        out
    }

    /// 整体风险 = 所有能力里最高的那一档
    pub fn risk_level(&self) -> RiskLevel {
        self.capabilities
            .iter()
            .map(Capability::risk)
            .max()
            .unwrap_or(RiskLevel::Low)
    }

    pub fn wants_network(&self) -> bool {
        self.capabilities
            .iter()
            .any(|c| matches!(c, Capability::Net { .. }))
    }

    pub fn wants_exec(&self) -> bool {
        self.capabilities.iter().any(|c| matches!(c, Capability::Exec))
    }

    pub fn has_read(&self, scope: &PathScope) -> bool {
        self.capabilities
            .iter()
            .any(|c| matches!(c, Capability::FsRead { scope: s } if s == scope))
    }

    pub fn has_write(&self, scope: &PathScope) -> bool {
        self.capabilities
            .iter()
            .any(|c| matches!(c, Capability::FsWrite { scope: s } if s == scope))
    }
}

// ============================================================================
// 运行时裁决
// ============================================================================

/// 插件在运行时发起的一次能力请求。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CapabilityRequest {
    ReadFile { path: String },
    WriteFile { path: String },
    /// 请求访问某个主机
    Http { host: String },
    /// 请求读取某个环境变量
    ReadEnv { name: String },
    /// 请求启动子进程
    Spawn { program: String },
}

impl CapabilityRequest {
    pub fn describe(&self) -> String {
        match self {
            CapabilityRequest::ReadFile { path } => format!("读取 {path}"),
            CapabilityRequest::WriteFile { path } => format!("写入 {path}"),
            CapabilityRequest::Http { host } => format!("访问 {host}"),
            CapabilityRequest::ReadEnv { name } => format!("读取环境变量 {name}"),
            CapabilityRequest::Spawn { program } => format!("启动进程 {program}"),
        }
    }
}

/// 裁决结果
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "verdict", rename_all = "camelCase")]
pub enum CapabilityVerdict {
    /// 放行
    Allow,
    /// 拒绝（未声明或未授权），附带原因
    Deny { code: ErrorCode, reason: String },
}

impl CapabilityVerdict {
    pub fn is_allow(&self) -> bool {
        matches!(self, CapabilityVerdict::Allow)
    }
}

/// 能力裁决器。持有一个插件**实际生效**的权限集合，负责回答"这个操作能不能做"。
#[derive(Debug, Clone)]
pub struct CapabilityGuard {
    plugin_id: String,
    effective: PermissionSet,
}

impl CapabilityGuard {
    pub fn new(plugin_id: impl Into<String>, effective: PermissionSet) -> Self {
        Self {
            plugin_id: plugin_id.into(),
            effective,
        }
    }

    pub fn plugin_id(&self) -> &str {
        &self.plugin_id
    }

    pub fn effective(&self) -> &PermissionSet {
        &self.effective
    }

    /// 单个请求的裁决。
    ///
    /// 注意：**这里返回 Deny 就一定要向上冒泡成 `ErrorCode::PluginCapabilityViolation`**，
    /// 由调用方同时写审计日志。静默降级（比如"读不到就当空文件"）会让攻击面隐形。
    pub fn check(&self, req: &CapabilityRequest) -> CapabilityVerdict {
        let ok = match req {
            CapabilityRequest::ReadFile { .. } => self.needs_fs(Capability::FsRead {
                scope: PathScope::Workspace,
            }),
            CapabilityRequest::WriteFile { .. } => self.needs_fs(Capability::FsWrite {
                scope: PathScope::Workspace,
            }),
            CapabilityRequest::Http { host } => self.check_host(host),
            CapabilityRequest::ReadEnv { name } => self
                .effective
                .capabilities
                .iter()
                .any(|c| matches!(c, Capability::Env { names } if names.iter().any(|n| n == name))),
            CapabilityRequest::Spawn { .. } => self.effective.wants_exec(),
        };

        if ok {
            CapabilityVerdict::Allow
        } else {
            CapabilityVerdict::Deny {
                code: ErrorCode::PluginCapabilityViolation,
                reason: format!(
                    "插件 `{}` 请求了未声明的能力：{}",
                    self.plugin_id,
                    req.describe()
                ),
            }
        }
    }

    /// 判断集合里是否存在任意一个该形态的 fs 能力（不比较具体 scope 值）。
    /// 真正落到具体路径时还要再过 [`PathResolver`]。
    fn needs_fs(&self, probe: Capability) -> bool {
        match probe {
            Capability::FsRead { .. } => self
                .effective
                .capabilities
                .iter()
                .any(|c| matches!(c, Capability::FsRead { .. })),
            Capability::FsWrite { .. } => self
                .effective
                .capabilities
                .iter()
                .any(|c| matches!(c, Capability::FsWrite { .. })),
            _ => false,
        }
    }

    fn check_host(&self, host: &str) -> bool {
        self.effective.capabilities.iter().any(|c| match c {
            // hosts 为空 = 任意主机
            Capability::Net { hosts } if hosts.is_empty() => true,
            Capability::Net { hosts } => hosts.iter().any(|h| host_matches(h, host)),
            _ => false,
        })
    }
}

/// 主机名匹配：精确相等，或 `*.example.com` 后缀匹配。
fn host_matches(pattern: &str, host: &str) -> bool {
    let pattern = pattern.trim().to_ascii_lowercase();
    let host = host.trim().to_ascii_lowercase();
    if let Some(suffix) = pattern.strip_prefix("*.") {
        host == suffix || host.ends_with(&format!(".{suffix}"))
    } else {
        pattern == host
    }
}

// ============================================================================
// 路径收敛器
// ============================================================================

/// 把插件的逻辑路径翻译成真实路径，并保证不越出授权范围。
///
/// **这是防止路径穿越的唯一入口**。任何绕过它直接 `Path::new(plugin_input)` 的代码
/// 都是漏洞。
#[derive(Debug, Clone)]
pub struct PathResolver {
    input_root: Option<PathBuf>,
    output_root: Option<PathBuf>,
    plugin_data_root: Option<PathBuf>,
    workspace_root: Option<PathBuf>,
    /// 额外的**只读**根，见 [`PathResolver::with_read_root`]
    extra_read_roots: Vec<PathBuf>,
}

impl PathResolver {
    pub fn new() -> Self {
        Self {
            input_root: None,
            output_root: None,
            plugin_data_root: None,
            workspace_root: None,
            extra_read_roots: Vec::new(),
        }
    }

    pub fn with_input(mut self, p: impl Into<PathBuf>) -> Self {
        self.input_root = Some(p.into());
        self
    }
    pub fn with_output(mut self, p: impl Into<PathBuf>) -> Self {
        self.output_root = Some(p.into());
        self
    }
    pub fn with_plugin_data(mut self, p: impl Into<PathBuf>) -> Self {
        self.plugin_data_root = Some(p.into());
        self
    }
    pub fn with_workspace(mut self, p: impl Into<PathBuf>) -> Self {
        self.workspace_root = Some(p.into());
        self
    }

    /// 追加一个**只读**根：`PathScope::Input` 的解析额外允许落在这里。
    ///
    /// # 为什么多步流水线必须要有它
    ///
    /// 流水线各步骤之间传递的中间产物**落在输出目录里**（宿主为每个输出端口
    /// 分配的目标路径都在 `output_root` 下），而下游步骤是通过 `src` 端口读它的，
    /// 于是 `nodes.rs::resolve_path` 用 `Input` 作用域去解析 —— 撞上
    /// "路径逃逸被拦截"，整条流水线在第二步就断了。
    ///
    /// 内置的 `video-to-gif` 就是这么断的：`video.thumbnail` 抽帧到
    /// `${output.frame}`，紧接着 `image.probe` 想读它 → `PERMISSION_DENIED`。
    /// （它此前还卡在更早的一个缺陷上 —— `${output.frame}` 根本解析不了，
    /// 所以这个第二层问题一直没露头。两个缺陷叠在一起，只修一个还是跑不通。）
    ///
    /// 收窄之处：**只对读放开**。写仍然必须落在该作用域自己的根里 ——
    /// 否则一个只声明 `fsWrite { output }` 的插件就能往输入目录里写东西。
    pub fn with_read_root(mut self, p: impl Into<PathBuf>) -> Self {
        self.extra_read_roots.push(p.into());
        self
    }

    fn root_for(&self, scope: &PathScope) -> Option<&PathBuf> {
        match scope {
            PathScope::Input => self.input_root.as_ref(),
            PathScope::Output => self.output_root.as_ref(),
            PathScope::PluginData => self.plugin_data_root.as_ref(),
            PathScope::Workspace => self.workspace_root.as_ref(),
            PathScope::Explicit { .. } => None,
        }
    }

    /// 在 `scope` 内解析路径 `rel`，并做穿越检查。
    ///
    /// 之所以先做词法规范化再比较：`a/../../b` 这类路径必须被展开后才能判断，
    /// 单纯做字符串前缀匹配是挡不住的。
    ///
    /// # 绝对路径为什么必须被接受
    ///
    /// 这里最初是"绝对路径一律拒绝"，理由是"插件只能用逻辑作用域，不能自己指定
    /// 宿主机位置"。**那条规则自相矛盾，而且让整个应用跑不了任何文件**：
    ///
    /// * `l1.rs` 把 `${src}` / `${input.<port>}` / `${output.<port>}` 绑定成
    ///   **真实的绝对路径**（因为那就是用户选中的文件）；
    /// * 内置节点于是拿着绝对路径调 `resolve()`，撞上拒绝；
    /// * 表现是任何一次真实转换都以 `PERMISSION_DENIED`
    ///   「插件不允许使用绝对路径」失败。
    ///
    /// 这个 bug 躲过了 194 个单元测试和 5 个集成测试 —— 因为**没有任何测试走过
    /// "用户选中的绝对路径 → 流水线 → 节点"这条真实数据流**，全都是拿相对路径
    /// 直接调 `resolve()`。它是靠真跑一次应用、提交一个真实任务才暴露的。
    ///
    /// 现在改为：**绝对路径与相对路径走同一条检查**，唯一的判据是
    /// "最终路径是否落在授权根内"。这**没有削弱安全性** ——
    /// 真正挡住穿越的从来就是那个 `starts_with`，而不是"必须相对"这个代理规则：
    ///
    /// | 输入 | 旧行为 | 新行为 |
    /// |---|---|---|
    /// | 根内相对路径 `a/b.png` | 放行 | 放行 |
    /// | 根内绝对路径 `D:\in\a.png` | **拒绝（bug）** | 放行 |
    /// | 逃逸相对路径 `../../etc/passwd` | 拒绝 | 拒绝 |
    /// | 根外绝对路径 `C:\Windows\System32` | 拒绝（理由错） | 拒绝（理由对） |
    pub fn resolve(&self, scope: &PathScope, rel: &str) -> ToolforgeResult<PathBuf> {
        // Explicit 作用域走 glob 校验，不在这里解析具体文件
        if let PathScope::Explicit { pattern } = scope {
            return self.resolve_explicit(pattern, rel);
        }

        let root = self.root_for(scope).ok_or_else(|| {
            ToolforgeError::internal(format!(
                "路径作用域 `{}` 尚未由宿主分配（这是宿主 bug，不是插件问题）",
                scope.describe()
            ))
        })?;
        // 两侧都做词法规范化，否则 `starts_with` 会因为 `.` / `..` / 尾随分隔符
        // 这类纯粹写法上的差异判错
        let root_norm = normalize_lexically(root);

        let given = Path::new(rel);
        let candidate = if given.is_absolute() {
            normalize_lexically(given)
        } else {
            normalize_lexically(&root_norm.join(given))
        };

        // 读操作额外接受"只读根"（典型是输出目录：流水线的中间产物落在那里，
        // 下游步骤却要用输入端口去读它 —— 见 `with_read_root` 的文档）
        let allowed = candidate.starts_with(&root_norm)
            || (matches!(scope, PathScope::Input)
                && self
                    .extra_read_roots
                    .iter()
                    .any(|r| candidate.starts_with(normalize_lexically(r))));

        if !allowed {
            return Err(ToolforgeError::denied(format!(
                "路径逃逸被拦截：{rel} 解析后落在授权目录之外"
            ))
            .with_detail(format!(
                "授权根目录：{}\n实际解析：{}",
                root_norm.display(),
                candidate.display()
            )));
        }

        Ok(candidate)
    }

    /// Explicit 作用域：用 glob 匹配。仍然拒绝绝对路径以外的花招由 glob 本身收敛。
    fn resolve_explicit(&self, pattern: &str, rel: &str) -> ToolforgeResult<PathBuf> {
        let glob = globset::Glob::new(pattern).map_err(|e| {
            ToolforgeError::plugin_invalid(format!("宿主路径 glob 非法：{pattern}"))
                .with_detail(e.to_string())
        })?;
        let matcher = glob.compile_matcher();
        let candidate = PathBuf::from(rel);

        if !matcher.is_match(&candidate) {
            return Err(ToolforgeError::denied(format!(
                "路径不在声明的宿主机范围内：{rel}"
            ))
            .with_detail(format!("声明范围：{pattern}")));
        }
        Ok(candidate)
    }

    /// 给插件用的"逻辑视图"：把每个作用域映射到一个稳定的虚拟路径。
    /// Python/WASM 插件看到的 `paths.input` 就是它，插件永远不知道真实盘符。
    pub fn logical_view(&self) -> Vec<(PathScope, String)> {
        vec![
            (PathScope::Input, "/input".into()),
            (PathScope::Output, "/output".into()),
            (PathScope::PluginData, "/data".into()),
            (PathScope::Workspace, "/work".into()),
        ]
    }
}

impl Default for PathResolver {
    fn default() -> Self {
        Self::new()
    }
}

/// 纯词法路径规范化（不访问文件系统，因此对不存在的路径也有效）。
///
/// 这也是为什么不用 `canonicalize()`：输出目录里的文件在写入前根本不存在，
/// `canonicalize` 会直接失败。
///
/// ## ⚠️ 一个踩过的坑：不能用 `PathBuf::pop()`
///
/// 第一版实现是 `Component::ParentDir => { if !out.pop() { out.push("..") } }`。
/// 它有一个致命缺陷：当栈顶是**我们自己压进去的 `..`** 时，`pop()` 依然返回 `true`，
/// 于是两个 `..` 被互相抵消 —— `../../evil` 被规范化成 `evil`。
/// 那等于把路径穿越检查直接拆掉了（单元测试 `dotdot_is_never_cancelled` 抓到了它）。
///
/// 正确规则是：**只有当栈顶是一个真正的目录名时才能回退**；否则继续累积 `..`。
pub fn normalize_lexically(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                // 只有栈顶是 Normal 才能吃掉它；栈顶是 `..`、`/` 或空前缀时保留
                let top_is_real_dir = matches!(
                    out.components().next_back(),
                    Some(Component::Normal(_))
                );
                if top_is_real_dir {
                    out.pop();
                } else {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn guard(caps: Vec<Capability>) -> CapabilityGuard {
        CapabilityGuard::new("test.plugin", PermissionSet::from_iter_caps(caps))
    }

    #[test]
    fn path_traversal_is_blocked() {
        let r = PathResolver::new().with_input("/srv/input");
        // 正常相对路径放行
        assert!(r.resolve(&PathScope::Input, "a/b.png").is_ok());
        // 逃逸必须被拦
        let err = r.resolve(&PathScope::Input, "../../../etc/passwd").unwrap_err();
        assert_eq!(err.code, ErrorCode::PermissionDenied);
        // 根**之外**的绝对路径必须被拦
        let err = r.resolve(&PathScope::Input, "C:\\Windows\\System32").unwrap_err();
        assert_eq!(err.code, ErrorCode::PermissionDenied);
    }

    /// 多步流水线的中间产物在输出目录里，下游步骤却用 `src`（Input 作用域）读它。
    ///
    /// 这条是内置 `video-to-gif` 实测出来的：抽帧写到 `${output.frame}`，
    /// 紧接着 `image.probe` 读同一个文件 → 以前直接 `PERMISSION_DENIED`
    /// 「路径逃逸被拦截」，整条流水线在第二步断掉。
    #[test]
    fn read_root_lets_a_pipeline_read_its_own_intermediate() {
        let r = PathResolver::new()
            .with_input("/srv/input")
            .with_output("/srv/output")
            .with_read_root("/srv/output");

        // 用 Input 作用域读输出目录里的中间产物：放行
        assert_eq!(
            r.resolve(&PathScope::Input, "/srv/output/frame.png").unwrap(),
            Path::new("/srv/output/frame.png")
        );

        // 但**写**不受这条影响：输出目录之外的写仍然必须走 Output 作用域，
        // 而 Input 作用域里没有输出根（这里只是恰好同名，换成别的目录就不行了）
        let r2 = PathResolver::new()
            .with_input("/srv/input")
            .with_output("/srv/out2")
            .with_read_root("/srv/out2");
        assert!(
            r2.resolve(&PathScope::Input, "/srv/out2/a.png").is_ok(),
            "只读根对读生效"
        );
        // 只读根不会让**别的**目录变得可读
        let err = r2.resolve(&PathScope::Input, "/srv/output/a.png").unwrap_err();
        assert_eq!(err.code, ErrorCode::PermissionDenied);
    }

    /// 只读根**只**影响 Input 作用域：它不能把输出根变成"随便读"。
    #[test]
    fn read_root_does_not_widen_output_writes() {
        let r = PathResolver::new()
            .with_input("/srv/input")
            .with_output("/srv/output")
            .with_read_root("/srv/input"); // 故意把输入目录登记成可读根
        // 读输入目录本来就允许
        assert!(r.resolve(&PathScope::Input, "/srv/input/a.png").is_ok());
        // 往输入目录"写"仍然被拒（Output 作用域的根是 /srv/output）
        let err = r.resolve(&PathScope::Output, "/srv/input/a.png").unwrap_err();
        assert_eq!(err.code, ErrorCode::PermissionDenied);
    }

    #[test]
    fn absolute_path_inside_root_is_allowed() {
        // 回归测试：这条曾经是**发布级阻塞 bug**。
        //
        // `l1.rs` 把 `${src}` / `${output.dst}` 绑定成真实的绝对路径，
        // 而 `resolve()` 曾经一律拒绝绝对路径 —— 于是**任何一次真实转换都会以
        // PERMISSION_DENIED 失败**："插件不允许使用绝对路径：D:\...\a.png"。
        //
        // 194 个单测 + 5 个集成测试全都没抓到，因为没有一个测试走过
        // "用户选中的绝对路径 → 流水线 → 节点"这条真实数据流。
        // 它是靠真跑一次应用、提交一个真实任务才暴露的。
        let r = PathResolver::new()
            .with_input("/srv/input")
            .with_output("/srv/output");

        // 授权根内的绝对路径必须放行（这才是真实的调用形态）
        assert_eq!(
            r.resolve(&PathScope::Input, "/srv/input/a/b.png").unwrap(),
            Path::new("/srv/input/a/b.png")
        );
        assert!(r.resolve(&PathScope::Output, "/srv/output/x.webp").is_ok());

        // 但根**外**的绝对路径仍然必须被拒 —— 安全性没有削弱，
        // 挡住穿越的从来是 starts_with，不是"必须相对"这个代理规则
        let err = r.resolve(&PathScope::Input, "/etc/passwd").unwrap_err();
        assert_eq!(err.code, ErrorCode::PermissionDenied);
        assert!(
            err.message.contains("逃逸"),
            "根外绝对路径的拒绝理由应当是「逃逸」而不是别的：{}",
            err.message
        );

        // 绝对路径里的 `..` 也要被正确展开后再判定
        assert!(r.resolve(&PathScope::Input, "/srv/input/a/../b.png").is_ok());
        let err = r
            .resolve(&PathScope::Input, "/srv/input/../../etc/passwd")
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::PermissionDenied);
    }

    #[test]
    fn dotted_and_trailing_separator_roots_compare_correctly() {
        // 两侧都做词法规范化，否则 `starts_with` 会因为纯写法差异判错
        let r = PathResolver::new().with_input("/srv/./input/");
        assert!(r.resolve(&PathScope::Input, "a.png").is_ok());
        assert!(r.resolve(&PathScope::Input, "/srv/input/a.png").is_ok());
    }

    #[test]
    fn nested_traversal_that_stays_inside_is_allowed() {
        let r = PathResolver::new().with_input("/srv/input");
        // 绕一圈但还在根目录内，属于合法写法
        assert!(r.resolve(&PathScope::Input, "a/../b/c.png").is_ok());
    }

    #[test]
    fn dotdot_is_never_cancelled() {
        // 回归测试：第一版实现会把 `../../x` 规范化成 `x`（两个 `..` 互相抵消），
        // 那等于把穿越检查拆掉。这里断言规范化的语义正确性。
        //
        // 用 `Path` 相等而不是字符串相等：Windows 上分隔符是 `\`，
        // 而 `Path` 的 PartialEq 是按组件比较的，跨平台都成立。
        assert_eq!(
            normalize_lexically(Path::new("../../evil")),
            Path::new("../../evil")
        );
        assert_eq!(normalize_lexically(Path::new("a/../../b")), Path::new("../b"));
        assert_eq!(normalize_lexically(Path::new("a/b/../c")), Path::new("a/c"));
        // 绝对路径不能让 `..` 越过根
        assert_eq!(normalize_lexically(Path::new("/a/../../b")), Path::new("/../b"));
    }

    #[test]
    fn excessive_traversal_from_input_root_is_rejected() {
        // 比根目录层级更深的 `..` 必须被拒绝，而不是被"抵消"掉
        let r = PathResolver::new().with_input("/srv/input");
        for evil in [
            "../../../etc/passwd",
            "../../../../../../../../etc/shadow",
            "a/../../../../../../b",
        ] {
            let err = r.resolve(&PathScope::Input, evil).unwrap_err();
            assert_eq!(err.code, ErrorCode::PermissionDenied, "`{evil}` 应当被拦截");
        }
    }

    #[test]
    fn unassigned_scope_is_host_bug_not_plugin_fault() {
        let r = PathResolver::new();
        let err = r.resolve(&PathScope::Output, "x.png").unwrap_err();
        assert_eq!(err.code, ErrorCode::Internal);
    }

    #[test]
    fn effective_permissions_are_intersection() {
        let declared = PermissionSet::from_iter_caps([
            Capability::FsRead {
                scope: PathScope::Input,
            },
            Capability::Net { hosts: vec![] },
            Capability::Exec,
        ]);
        let granted = PermissionSet::from_iter_caps([Capability::FsRead {
            scope: PathScope::Input,
        }]);

        let eff = PermissionSet::effective(&declared, &granted);
        assert_eq!(eff.capabilities.len(), 1);
        // 未授权的出网/起进程必须消失
        assert!(!eff.wants_network());
        assert!(!eff.wants_exec());
    }

    #[test]
    fn escalation_detection() {
        let old = PermissionSet::from_iter_caps([Capability::Ai]);
        let new = PermissionSet::from_iter_caps([Capability::Ai, Capability::Exec]);
        // 新版本多要了 Exec —— 这不是子集，UI 必须重新走确认流程
        assert!(!new.is_subset_of(&old));
        assert!(PermissionSet::from_iter_caps([Capability::Ai]).is_subset_of(&old));
    }

    #[test]
    fn host_allowlist_matching() {
        let g = guard(vec![Capability::Net {
            hosts: vec!["api.openai.com".into(), "*.huggingface.co".into()],
        }]);
        assert!(g
            .check(&CapabilityRequest::Http {
                host: "api.openai.com".into()
            })
            .is_allow());
        assert!(g
            .check(&CapabilityRequest::Http {
                host: "cdn.huggingface.co".into()
            })
            .is_allow());
        assert!(g
            .check(&CapabilityRequest::Http {
                host: "huggingface.co".into()
            })
            .is_allow());
        // 未列入白名单的主机
        assert!(!g
            .check(&CapabilityRequest::Http {
                host: "evil.example.com".into()
            })
            .is_allow());
    }

    #[test]
    fn empty_host_list_means_any_host() {
        let g = guard(vec![Capability::Net { hosts: vec![] }]);
        assert!(g
            .check(&CapabilityRequest::Http {
                host: "anything.example".into()
            })
            .is_allow());
        // 并且风险等级应为高
        assert_eq!(g.effective().risk_level(), RiskLevel::High);
    }

    #[test]
    fn exec_is_critical_risk() {
        let g = guard(vec![Capability::Exec]);
        assert_eq!(g.effective().risk_level(), RiskLevel::Critical);
    }

    #[test]
    fn spawn_without_exec_is_denied() {
        let g = guard(vec![Capability::Ai]);
        let v = g.check(&CapabilityRequest::Spawn {
            program: "curl".into(),
        });
        assert!(!v.is_allow());
        match v {
            CapabilityVerdict::Deny { code, .. } => {
                assert_eq!(code, ErrorCode::PluginCapabilityViolation)
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn env_access_is_name_allowlisted() {
        let g = guard(vec![Capability::Env {
            names: vec!["HF_HOME".into()],
        }]);
        assert!(g
            .check(&CapabilityRequest::ReadEnv {
                name: "HF_HOME".into()
            })
            .is_allow());
        // 想顺手读 API key？拒绝
        assert!(!g
            .check(&CapabilityRequest::ReadEnv {
                name: "OPENAI_API_KEY".into()
            })
            .is_allow());
    }
}
