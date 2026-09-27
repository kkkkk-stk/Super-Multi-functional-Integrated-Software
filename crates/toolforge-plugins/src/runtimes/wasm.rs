//! L2 · Extism WASM 沙箱运行时。
//!
//! ## 资源边界是"燃料"，不是墙钟
//!
//! [`WasmPlugin::call`] 是**同步**的。这不是偷懒，而是因为：
//!
//! * WASM 插件（关闭 WASI 后）**无法阻塞**：没有 I/O、没有网络、没有 `sleep`。
//!   它唯一能做的就是烧 CPU。
//! * 既然只能烧 CPU，那么用 wasmtime 的 **fuel 机制**做上界就是精确且可中断的：
//!   燃料耗尽会 trap，`Plugin::call` 直接返回错误。
//! * 反过来，如果为了"墙钟超时"把调用丢进另一个线程再 `timeout`，超时后那个线程
//!   还在烧 CPU，我们只是不再等它 —— 那是**假装**超时，会积压线程。
//!
//! 所以：`timeout_ms` 会在装载时换算成燃料上限（见 [`fuel_for_timeout`]），
//! 内存上限走 `Manifest::with_memory_max`（单位是 64KiB 页）。
//!
//! ## 宿主函数
//!
//! v0.1 **不注入自定义宿主函数**。清单里的 `allowHostFunctions` 会被校验
//! （只允许 `log` / `kv`），但实际上：
//!
//! * **日志**：Extism PDK 的 `log_info!` 走的是内置 `extism_log_*` 导入，
//!   不需要自定义宿主函数。我们把 `extism::set_log_callback` 接到 `tracing`，
//!   所以插件的日志会出现在应用日志里。
//! * **KV**：v0.2 再接（需要给 Manifest 配 KV store）。
//!
//! 这样做的理由是安全：宿主函数是**唯一**能从沙箱里伸出手来的口子，
//! 每加一个都要单独评估。宁可不加。

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use toolforge_core::error::{ErrorCode, ToolforgeError, ToolforgeResult};
use toolforge_core::plugin::WasmRuntimeDef;
use toolforge_core::queue::JobCtx;

use crate::runtimes::PluginCallRequest;

/// 模块的导入段摘要 —— 装载前的"体检报告"。
///
/// # 为什么需要它（这是一个真实踩过的坑）
///
/// 示例插件的构建说明原本写着 `--target wasm32-wasip1`。那份 wasm 装进沙箱时
/// 报的是：
///
/// ```text
/// 创建 WASM 实例失败：unknown import: `wasi_snapshot_preview1::environ_get` has not been defined
/// ```
///
/// 报错本身没错，但对插件作者**完全不可操作**：他既不知道这句话从哪来，也不知道
/// 该改什么。真正的原因是：**Rust 的 `wasm32-wasip1` std 在启动时无条件读取
/// 环境变量**（`std::rt::init` 调 `environ_get`），所以任何用 std 写的
/// wasip1 模块都必然导入 WASI；而本宿主刻意关掉了 WASI
/// （`with_wasi(false)`，这是"没有文件系统"的实现手段），于是它必然装载失败。
///
/// 换句话说：**wasip1 对这个宿主来说是错的目标，不是"配置问题"**。
/// 这个结论只有真装一次才会浮现 —— 编译通过、`cargo build` 成功、产物也在，
/// 一切都"看起来对"。
///
/// 所以现在装载前先读一遍导入段，把结论直接说出来。
#[derive(Debug, Default, Clone)]
pub struct WasmImports {
    /// 引用了 WASI 的导入（`模块名::字段名`）
    pub wasi: Vec<String>,
    /// 引用了 `extism:host/user` 下的**自定义宿主函数**（`函数名`）
    ///
    /// Extism 内置的那批（`extism:host/env`：输入输出、日志、HTTP…）不在这里 ——
    /// 它们一定可用，不需要授权。
    pub custom_host_functions: Vec<String>,
}

impl WasmImports {
    /// 这个模块是不是 WASI 目标构建出来的
    pub fn uses_wasi(&self) -> bool {
        !self.wasi.is_empty()
    }

    /// 清单里的 `allowHostFunctions` 没覆盖到的自定义宿主函数。
    ///
    /// v0.1 **不注入任何自定义宿主函数**（见模块文档），所以任何自定义导入
    /// 都注定失败；返回它只是为了把话说清楚：要么去掉这个导入，要么把
    /// `allowHostFunctions` 补上（补上也不会让它可用，只是让错误信息更准确）。
    pub fn disallowed_host_functions(&self, allowed: &[String]) -> Vec<String> {
        self.custom_host_functions
            .iter()
            .filter(|f| !allowed.iter().any(|a| a == *f))
            .cloned()
            .collect()
    }
}

/// 解析一段 wasm 的导入段。
///
/// 解析失败（不是合法 wasm）时返回 `Err`，调用方照旧走编译期报错 ——
/// 这里**不**负责判断"是不是合法 wasm"，只负责在合法的情况下多说一句人话。
pub fn inspect_imports(wasm_bytes: &[u8]) -> Result<WasmImports, wasmparser::BinaryReaderError> {
    use wasmparser::{Imports, Parser, Payload};

    let mut out = WasmImports::default();
    for payload in Parser::new(0).parse_all(wasm_bytes) {
        if let Payload::ImportSection(reader) = payload? {
            for group in reader {
                match group? {
                    Imports::Single(_, imp) => record_import(&mut out, imp.module, imp.name),
                    // Compact1/Compact2 属于 compact-imports 提议，正常工具链不会产出；
                    // 但枚举必须穷尽，顺手支持一下不花代价。
                    Imports::Compact1 { module, items } => {
                        for item in items {
                            record_import(&mut out, module, item?.name);
                        }
                    }
                    Imports::Compact2 { module, names, .. } => {
                        for name in names {
                            record_import(&mut out, module, name?);
                        }
                    }
                }
            }
        }
    }
    out.wasi.sort();
    out.wasi.dedup();
    out.custom_host_functions.sort();
    out.custom_host_functions.dedup();
    Ok(out)
}

fn record_import(out: &mut WasmImports, module: &str, field: &str) {
    if module == "wasi_snapshot_preview1" || module == "wasi_unstable" {
        out.wasi.push(format!("{module}::{field}"));
    } else if module == "extism:host/user" {
        out.custom_host_functions.push(field.to_string());
    }
}

/// 由**已授权**的能力算出 Extism 的 `allowed_hosts`。
///
/// ## 这是在补一个真实的窟窿，不是"顺手加个配置"
///
/// Extism PDK 的 `http_request` 是**内置宿主函数**（不需要我们注入），而它在
/// `pdk.rs` 里是这样判的：
///
/// ```text
/// let host_matches = if let Some(allowed_hosts) = allowed_hosts { …任意匹配… }
///                    else { false };
/// if !host_matches { return Err("HTTP request to … is not allowed") }
/// ```
///
/// 也就是说 **`allowed_hosts` 为 `None` 时一切请求都被拒**。我们此前从不设置它，
/// 于是 L2 插件的网络是"永远不通"——**用户在授权面板里勾了 `net` 也没有任何用**，
/// 因为宿主根本没把这份授权翻译给沙箱。这是"声明 → 授权 → 生效"链条上的断点：
/// 方向是安全的（fail-closed，不是漏洞），但功能上是坏的，而且用户看到的是一个
/// 明明授权了却报「HTTP request is not allowed」的插件。
///
/// 现在的映射：
///
/// * 没有授权 `net`（或声明为空）→ `None` → **全部拒绝**（保持 fail-closed）；
/// * `net { hosts: [] }`（任意主机）→ `["*"]` —— 授权面板把空列表显示成
///   「访问网络（任意主机，无限制）」，那就该如实放行任意主机；
/// * `net { hosts: [a, b] }` → `[a, b]` —— Extism 用 **glob** 匹配，所以
///   `*.example.com` 这类写法天然可用。
///
/// 与 `Capability::effective()` 同口径：**声明 ∩ 授权**，少一个都不给。
///
/// ## 端口会被剥掉（这是第二个真实的坑）
///
/// Extism 判定用的是 `url.host_str()`（见 `extism-1.30.0/src/pdk.rs`），
/// **端口根本不参与比较**。所以清单里写 `api.example.com:443` 的话，
/// 拿 `api.example.com:443` 去 glob 匹配 `api.example.com` —— 永远不中，
/// 插件必然报 `HTTP request to … is not allowed`，而用户看到的是自己
/// "明明授权了却连不上"。
///
/// 处理方式是**两层**：
///
/// * 校验器把带端口的 `hosts` 当成错误（`NET_HOST_WITH_PORT`），让作者在
///   安装前就知道。这是主要手段；
/// * 这里再兜一层：剥掉端口。理由是**已经装好的**插件（或手改过 plugin.yaml 的）
///   不该在运行时神秘失败 —— 那时用户拿到的报错指不到清单上那个冒号。
///
/// 剥端口在语义上是**放宽**（`a.com:443` 只允许 443，剥掉后允许任意端口）。
/// 之所以接受，是因为 Extism 压根无法表达"只允许 443"，拒绝执行反而会让一个
/// 意图正确的插件变成完全不可用。校验器已经把这个取舍摆到明面上了。
pub fn allowed_hosts_from(granted: &toolforge_core::permission::PermissionSet) -> Option<Vec<String>> {
    use toolforge_core::permission::Capability;
    let mut hosts: Vec<String> = Vec::new();
    for cap in &granted.capabilities {
        if let Capability::Net { hosts: declared } = cap {
            if declared.is_empty() {
                // 空列表 = 任意主机。Extism 的 glob `*` 匹配任何 host_str。
                return Some(vec!["*".to_string()]);
            }
            hosts.extend(declared.iter().map(|h| normalize_host_pattern(h)));
        }
    }
    if hosts.is_empty() {
        None
    } else {
        hosts.sort();
        hosts.dedup();
        Some(hosts)
    }
}

/// 把一条主机模式规整成 Extism 真正能匹配的形态：**去掉端口**。
///
/// 只做这一件事，别的原样保留（glob、大小写、IPv6 方括号都不动）：
///
/// * `example.com:443` → `example.com`
/// * `*.example.com:8080` → `*.example.com`
/// * `[::1]:8080` → `[::1]`（IPv6 的 `host_str()` 是带方括号的形态）
/// * `example.com` / `*` → 原样
///
/// 为什么要判方括号：`[::1]:8080` 里有两个冒号，按 `rfind(':')` 切会把
/// `[::1]` 切成 `[:`，那不是任何主机名。
pub fn normalize_host_pattern(host: &str) -> String {
    let host = host.trim();
    if let Some(close) = host.rfind(']') {
        // IPv6 字面量：只剥 `]` 之后那段
        return match host[close + 1..].strip_prefix(':') {
            Some(_) => host[..=close].to_string(),
            None => host.to_string(),
        };
    }
    match host.rsplit_once(':') {
        // 只在"冒号后面看起来像端口"时剥，避免误伤理论上的其他写法
        Some((head, port)) if !head.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => {
            head.to_string()
        }
        _ => host.to_string(),
    }
}
///
/// 经验值：wasmtime 大约每秒消耗 1e8~1e9 燃料（取决于 CPU 与模块复杂度）。
/// 取 **1e8/秒**作为保守估计，并设一个下限，避免 `timeoutMs: 1` 变成"什么都不许做"。
pub fn fuel_for_timeout(timeout_ms: u64) -> u64 {
    const FUEL_PER_SEC: u64 = 100_000_000;
    const MIN_FUEL: u64 = 10_000_000;
    let secs = (timeout_ms as f64 / 1000.0).max(0.05);
    ((secs * FUEL_PER_SEC as f64) as u64).max(MIN_FUEL)
}

/// 已装载的 WASM 插件。
///
/// 持有 [`extism::CompiledPlugin`]（只编译一次），每次调用创建轻量的
/// [`extism::Plugin`] 实例 —— 这既避免了重复编译（几十毫秒 × 每次调用），
/// 又保证实例之间不共享可变状态（插件跑飞了不会污染下一次调用）。
pub struct WasmPlugin {
    compiled: Arc<extism::CompiledPlugin>,
    def: WasmRuntimeDef,
    plugin_id: String,
}

impl WasmPlugin {
    /// 装载一个 L2 插件。
    ///
    /// `granted` 是**已授权的**能力集合（调用方传 `PluginRecord::effective()`）。
    /// 它在这里的用途只有一个但很关键：把它翻译成 Extism 的 `allowed_hosts`，
    /// 让用户在授权面板上勾的 `net` 真的生效（见 [`allowed_hosts_from`]）。
    pub fn load(
        wasm_bytes: &[u8],
        def: &WasmRuntimeDef,
        plugin_id: String,
        granted: &toolforge_core::permission::PermissionSet,
    ) -> ToolforgeResult<Self> {
        // ---- 先体检，再编译 ----
        //
        // 顺序很重要：wasmtime 对"导入了不存在的东西"给出的报错是
        // `unknown import: \`x::y\` has not been defined`，对插件作者不可操作。
        // 而我们**知道**这两类导入是注定失败的，也知道该怎么修。
        let imports = inspect_imports(wasm_bytes).map_err(|e| {
            ToolforgeError::runtime(format!("WASM 模块的导入段解析失败：{e}"))
                .with_subject(&plugin_id)
                .with_detail("这通常意味着文件不是合法的 WebAssembly 模块（比如被截断了）。")
        })?;

        if imports.uses_wasi() {
            let sample = imports.wasi.first().cloned().unwrap_or_default();
            let more = imports.wasi.len().saturating_sub(1);
            return Err(ToolforgeError::plugin_invalid(format!(
                "这个 WASM 模块引用了 WASI（例如 `{sample}`{}），而宿主刻意关闭了 WASI",
                if more > 0 {
                    format!("，另有 {more} 处")
                } else {
                    String::new()
                }
            ))
            .with_subject(&plugin_id)
            .with_detail(
                "最可能的原因：模块是用 `--target wasm32-wasip1` 构建的。\
                 Rust 的 wasip1 版 std 在启动时会无条件读环境变量（`environ_get`），\
                 所以任何用 std 写出来的 wasip1 模块都必然导入 WASI。\n\n\
                 请改用 `--target wasm32-unknown-unknown` 重新构建：\n\
                 \x20   cargo build --target wasm32-unknown-unknown --release\n\n\
                 关闭 WASI 不是配置口味问题：它是「插件没有文件系统」这条保证的实现手段。\
                 打开它等于把宿主的文件描述符交给插件。",
            )
            .into());
        }

        let disallowed = imports.disallowed_host_functions(&def.allow_host_functions);
        if !disallowed.is_empty() {
            return Err(ToolforgeError::plugin_invalid(format!(
                "模块导入了宿主没有提供的函数：{}",
                disallowed.join("、")
            ))
            .with_subject(&plugin_id)
            .with_detail(format!(
                "v0.1 **不注入任何自定义宿主函数**，所以 `extism:host/user` 下的东西一个都用不了。\n\
                 清单里声明的白名单是：{:?}。\n\
                 日志请用 Extism PDK 自带的 `info!` / `warn!`（走内置导入，不需要声明）；\
                 KV 存储推迟到 v0.2。",
                def.allow_host_functions
            ))
            .into());
        }

        let pages = Self::pages_for_memory(def.memory_limit_mb);
        let allowed = allowed_hosts_from(granted);
        let manifest = extism::Manifest::new([extism::Wasm::data(wasm_bytes.to_vec())])
            .with_memory_max(pages)
            // 没有授权 `net` 时给的是**空列表**：Extism 逐条 glob 匹配，
            // 空列表 = 什么都不匹配 = 一切请求被拒。与 `None` 等效，都是 fail-closed。
            .with_allowed_hosts(allowed.clone().unwrap_or_default().into_iter());

        let builder = extism::PluginBuilder::new(manifest)
            // 关闭 WASI：这是"没有文件系统"的实现手段。
            // 打开 WASI 就等于把宿主的文件描述符暴露给插件。
            .with_wasi(false)
            .with_fuel_limit(fuel_for_timeout(def.timeout_ms));

        let compiled = builder.compile().map_err(|e| {
            ToolforgeError::runtime(format!("WASM 模块编译失败：{e}"))
                .with_subject(&plugin_id)
                .with_detail(
                    "常见原因：文件不是合法 wasm，或用了 Extism 不支持的指令/特性。\
                     导入段的问题在编译前已经单独检查过（WASI 与自定义宿主函数）。",
                )
        })?;

        // 入口函数检查必须在实例上做（CompiledPlugin 不暴露导出表查询）。
        // 提前建一个实例立刻丢掉，比等到用户点"运行"才报错要好得多。
        {
            let probe = extism::Plugin::new_from_compiled(&compiled).map_err(|e| {
                ToolforgeError::runtime(format!("创建 WASM 实例失败：{e}")).with_subject(&plugin_id)
            })?;
            if !probe.function_exists(&def.entry) {
                return Err(ToolforgeError::plugin_invalid(format!(
                    "WASM 模块里没有导出函数 `{}`",
                    def.entry
                ))
                .with_subject(&plugin_id)
                .with_detail(
                    "检查清单里的 runtime.wasm.entry 是否与 #[plugin_fn] 标注的函数名一致。",
                ));
            }
        }

        Ok(Self {
            compiled: Arc::new(compiled),
            def: def.clone(),
            plugin_id,
        })
    }

    /// 插件声明的内存上限（MB）换算成 wasm 页（64 KiB）
    fn pages_for_memory(mb: u32) -> u32 {
        let bytes = (mb as u64).saturating_mul(1024 * 1024);
        let pages = bytes / 65_536;
        (pages as u32).clamp(16, 65_536) // 1 MiB .. 4 GiB
    }

    pub fn plugin_id(&self) -> &str {
        &self.plugin_id
    }

    /// 同步调用。返回值必须是 JSON（插件应当返回 JSON 字符串）。
    pub fn call(&self, req: &PluginCallRequest, job: &JobCtx) -> ToolforgeResult<Value> {
        job.check()?;

        let input = serde_json::to_vec(&req.payload)
            .map_err(|e| ToolforgeError::internal(format!("载荷序列化失败：{e}")))?;

        // 输入体积保护：沙箱之间要拷贝内存，塞 200MB 进去会直接 OOM
        const MAX_INPUT_BYTES: usize = 16 * 1024 * 1024;
        if input.len() > MAX_INPUT_BYTES {
            return Err(ToolforgeError::invalid(format!(
                "传给 WASM 插件的载荷 {} MB 超过 {} MB 上限",
                input.len() / 1024 / 1024,
                MAX_INPUT_BYTES / 1024 / 1024
            ))
            .with_detail(
                "WASM 插件适合处理小数据。大文件请走 L1 内置节点或 L3 Python 插件。",
            ));
        }

        let started = std::time::Instant::now();
        let mut plugin = extism::Plugin::new_from_compiled(&self.compiled).map_err(|e| {
            ToolforgeError::runtime(format!("创建 WASM 实例失败：{e}")).with_subject(&self.plugin_id)
        })?;

        let out: Vec<u8> = plugin
            .call(&self.def.entry, input.as_slice())
            .map_err(|e| self.map_extism_error(e, started.elapsed()))?;

        if let Some(fuel) = plugin.fuel_consumed() {
            tracing::debug!(
                plugin = %self.plugin_id,
                fuel,
                ms = started.elapsed().as_millis() as u64,
                "WASM 调用完成"
            );
        }

        if out.is_empty() {
            return Ok(Value::Null);
        }
        let value = serde_json::from_slice(&out).or_else(|_| {
            // 插件直接返回了裸字符串（没包成 JSON）—— 宽容处理，
            // 因为这是新手最常见的写法，为它报错体验太差。
            String::from_utf8(out)
                .map(Value::String)
                .map_err(|e| ToolforgeError::runtime(format!("WASM 返回值既不是 JSON 也不是 UTF-8 文本：{e}")))
        })?;

        // ---- `{"error": "…"}` 约定：插件报错的**唯一**可靠通道 ----
        //
        // 为什么不靠"插件返回 Err"：Extism 1.30 只在**输出已被设置**时才读取插件
        // 设置的错误（`plugin.rs`: `if output_res.is_ok() && self.extism_error_is_set()`），
        // 而 PDK 的 `#[plugin_fn]` 在 Err 分支上只 `error_set`、不设置输出 ——
        // 于是作者写的报错文案被丢掉，用户只看到一句 wasm 回溯。
        // 详见 `plugins/wasm-http-example/src/lib.rs` 里 `fail()` 的说明。
        //
        // 这条约定也让"插件报了错"变成一个**结构化**事实：宿主可以照常记日志、
        // 计产出，而不是靠解析错误字符串猜。
        if let Some(msg) = value.get("error").and_then(|e| e.as_str()) {
            let msg = msg.trim();
            if !msg.is_empty() {
                return Err(ToolforgeError::runtime(msg.to_string()).with_subject(&self.plugin_id));
            }
        }
        Ok(value)
    }

    fn map_extism_error(&self, e: extism::Error, elapsed: Duration) -> ToolforgeError {
        // 用 Debug 而不是 Display：anyhow 的 Display 只给最外层一句话，
        // 而插件自己设的错误消息在 **cause 链**里。两者都留着，排查时都可能有。
        let text = e.to_string();
        let chain = format!("{e:?}");
        let timed_out = text.contains("fuel") || text.contains("all fuel consumed");
        let oom = text.contains("memory") && text.contains("limit");

        if timed_out {
            return ToolforgeError::new(
                ErrorCode::Timeout,
                format!(
                    "WASM 插件在 {} ms 内耗尽了燃料配额（timeoutMs = {}）",
                    elapsed.as_millis(),
                    self.def.timeout_ms
                ),
            )
            .with_subject(&self.plugin_id)
            .with_detail("插件可能进入了死循环或复杂度过高。");
        }
        if oom {
            return ToolforgeError::new(
                ErrorCode::PluginRuntime,
                format!(
                    "WASM 插件超出内存上限（{} MB）",
                    self.def.memory_limit_mb
                ),
            )
            .with_subject(&self.plugin_id);
        }

        // 如果拿到的只是 wasm 回溯（没有 cause），多半是"插件返回了 Err，
        // 但消息没能回传" —— 见下面那段说明。这时候与其让用户对着
        // `wasm function 92` 发呆，不如直接把原因和出路写出来。
        let looks_like_bare_trap = chain.contains("wasm backtrace") && !chain.contains("Caused by");
        let hint = if looks_like_bare_trap {
            "\n\n这条报错只有 wasm 回溯，没有插件自己的消息。原因：Extism 1.30 只在\
             **输出已被设置**时才读取插件设置的错误，而 Extism PDK 的 `#[plugin_fn]`\
             在 `Err` 分支上只设置错误、不设置输出，于是消息被丢掉了。\n\
             两条出路：① 看任务日志里插件用 `info!` / `warn!` 打的内容；\
             ② 插件改为用「先设置输出、再设置错误」的方式报错（见 PLUGIN-SDK §4.4 的 `fail()` 示例）。"
        } else {
            ""
        };
        ToolforgeError::runtime(format!("WASM 插件执行失败：{chain}{hint}")).with_subject(&self.plugin_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fuel_scales_with_timeout() {
        assert!(fuel_for_timeout(1000) > fuel_for_timeout(100));
        assert!(fuel_for_timeout(5000) > fuel_for_timeout(1000));
    }

    #[test]
    fn fuel_has_a_floor_so_tiny_timeouts_still_work() {
        // timeoutMs 很小的插件不应当直接"零燃料起步"
        assert_eq!(fuel_for_timeout(0), 10_000_000);
        assert_eq!(fuel_for_timeout(1), 10_000_000);
    }

    #[test]
    fn memory_pages_are_clamped() {
        assert_eq!(WasmPlugin::pages_for_memory(64), 1024);
        // 极小的值被抬到 1 MiB，避免插件连运行时都起不来
        assert_eq!(WasmPlugin::pages_for_memory(0), 16);
        // 极大的值被压到 4 GiB
        assert_eq!(WasmPlugin::pages_for_memory(u32::MAX), 65_536);
    }

    #[test]
    fn loading_garbage_wasm_fails_cleanly() {
        let def = WasmRuntimeDef {
            path: "p.wasm".into(),
            entry: "run".into(),
            memory_limit_mb: 64,
            timeout_ms: 1000,
            allow_host_functions: vec![],
        };
        // 这不是合法 wasm，必须给出 PluginRuntime 错误而不是 panic
        let none = toolforge_core::permission::PermissionSet::empty();
        match WasmPlugin::load(b"not a wasm module", &def, "test".into(), &none) {
            Ok(_) => panic!("非法 wasm 不应该装载成功"),
            Err(e) => {
                assert_eq!(e.code, ErrorCode::PluginRuntime);
                assert!(e.detail.unwrap().contains("WebAssembly"));
            }
        }
    }

    // ========================================================================
    // 导入段体检
    // ========================================================================

    /// 一个最小的合法 wasm 模块（只有 import 段，别的都空）。
    ///
    /// 手写字节而不是引入 wat 解析器：这里要验的正是"能不能读懂导入段"，
    /// 用别的工具生成反而把被测对象藏起来了。字节含义逐段注释在下面。
    fn wasm_with_imports(imports: &[(&str, &str)]) -> Vec<u8> {
        let mut module = vec![0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00];

        let mut payload: Vec<u8> = Vec::new();
        payload.push(leb(imports.len() as u64));
        for (module_name, field_name) in imports {
            payload.push(leb(module_name.len() as u64));
            payload.extend_from_slice(module_name.as_bytes());
            payload.push(leb(field_name.len() as u64));
            payload.extend_from_slice(field_name.as_bytes());
            payload.push(0x00); // kind = func
            payload.push(0x00); // type index 0
        }

        module.push(0x02); // section id = import
        module.push(leb(payload.len() as u64));
        module.extend_from_slice(&payload);
        module
    }

    /// 无符号 LEB128
    fn leb(mut v: u64) -> u8 {
        let mut out = Vec::new();
        loop {
            let mut byte = (v & 0x7F) as u8;
            v >>= 7;
            if v != 0 {
                byte |= 0x80;
            }
            out.push(byte);
            if v == 0 {
                break;
            }
        }
        assert_eq!(out.len(), 1, "测试里只用得到单字节的 LEB128");
        out[0]
    }

    #[test]
    fn wasi_imports_are_recognised() {
        let wasm = wasm_with_imports(&[
            ("wasi_snapshot_preview1", "environ_get"),
            ("wasi_snapshot_preview1", "environ_sizes_get"),
            ("extism:host/env", "input_length"),
        ]);
        let got = inspect_imports(&wasm).expect("应当能解析");
        assert_eq!(got.wasi.len(), 2, "{:?}", got.wasi);
        assert!(got.uses_wasi());
        assert!(
            got.custom_host_functions.is_empty(),
            "Extism 内置导入不该被算成自定义宿主函数"
        );
    }

    /// **这一条是这次修复的靶心**：wasip1 目标构建出来的模块必须被认出来，
    /// 并且给出"改用 wasm32-unknown-unknown"这句可操作的话。
    ///
    /// 起因：示例插件的构建说明写的是 `--target wasm32-wasip1`，产物装进沙箱后
    /// 报 `unknown import: wasi_snapshot_preview1::environ_get has not been defined`。
    #[test]
    fn wasip1_module_is_rejected_with_actionable_advice() {
        let wasm = wasm_with_imports(&[("wasi_snapshot_preview1", "environ_get")]);
        let def = WasmRuntimeDef {
            path: "p.wasm".into(),
            entry: "run".into(),
            memory_limit_mb: 64,
            timeout_ms: 1000,
            allow_host_functions: vec!["log".into()],
        };
        let err = WasmPlugin::load(&wasm, &def, "test".into(), &toolforge_core::permission::PermissionSet::empty())
            .err()
            .expect("引用 WASI 的模块必须被拒绝");
        assert_eq!(err.code, ErrorCode::PluginInvalid);
        let detail = err.detail.unwrap_or_default();
        assert!(detail.contains("wasm32-unknown-unknown"), "{detail}");
        assert!(detail.contains("wasm32-wasip1"), "{detail}");
    }

    #[test]
    fn custom_host_functions_outside_the_allowlist_are_named() {
        let wasm = wasm_with_imports(&[
            ("extism:host/user", "my_secret_helper"),
            ("extism:host/env", "log_info"),
        ]);
        let got = inspect_imports(&wasm).expect("应当能解析");
        assert_eq!(got.custom_host_functions, vec!["my_secret_helper".to_string()]);

        let def = WasmRuntimeDef {
            path: "p.wasm".into(),
            entry: "run".into(),
            memory_limit_mb: 64,
            timeout_ms: 1000,
            // 清单里声明了 log，但模块导入的是别的
            allow_host_functions: vec!["log".into()],
        };
        let err = WasmPlugin::load(&wasm, &def, "test".into(), &toolforge_core::permission::PermissionSet::empty())
            .err()
            .expect("未声明的自定义宿主函数必须被拒绝");
        assert_eq!(err.code, ErrorCode::PluginInvalid);
        assert!(
            err.message.contains("my_secret_helper"),
            "错误里必须点名是哪个函数：{}",
            err.message
        );
    }

    #[test]
    fn a_module_without_imports_is_fine() {
        let wasm = wasm_with_imports(&[]);
        let got = inspect_imports(&wasm).expect("空导入段应当能解析");
        assert!(!got.uses_wasi());
        assert!(got.custom_host_functions.is_empty());
    }

    // ========================================================================
    // 端口剥离 —— 第二个"授权了却连不上"的坑
    // ========================================================================

    /// Extism 用 `url.host_str()` 匹配，端口不参与比较。
    /// 所以带端口的白名单必须被规整掉，否则永远匹配不上。
    #[test]
    fn host_patterns_lose_their_port() {
        assert_eq!(normalize_host_pattern("api.example.com:443"), "api.example.com");
        assert_eq!(normalize_host_pattern("*.example.com:8080"), "*.example.com");
        assert_eq!(normalize_host_pattern("[::1]:8080"), "[::1]");
        // 本来就对的写法不能被改坏
        assert_eq!(normalize_host_pattern("example.com"), "example.com");
        assert_eq!(normalize_host_pattern("*"), "*");
        assert_eq!(normalize_host_pattern("127.0.0.1"), "127.0.0.1");
        // 冒号后面不是数字时不动它（不猜）
        assert_eq!(normalize_host_pattern("[::1]"), "[::1]");
    }

    #[test]
    fn declared_hosts_are_normalized_before_handing_to_extism() {
        use toolforge_core::permission::{Capability, PermissionSet};
        let set = PermissionSet {
            capabilities: vec![Capability::Net {
                hosts: vec!["api.example.com:443".into()],
            }],
        };
        assert_eq!(
            allowed_hosts_from(&set),
            Some(vec!["api.example.com".to_string()]),
            "带端口的白名单必须被规整，否则沙箱永远匹配不上"
        );
    }

    // ========================================================================
    // 网络白名单映射 —— 这一组补的是"授权了但沙箱不知道"的断点
    // ========================================================================

    /// 没有任何 `net` 授权 → 空列表 → Extism 逐条匹配全不中 → 一切请求被拒。
    ///
    /// 这是**安全默认值**，必须钉住：一旦这里变成 `Some(["*"])`，
    /// 所有 L2 插件就都能随便联网了。
    #[test]
    fn no_net_grant_denies_every_host() {
        let none = toolforge_core::permission::PermissionSet::empty();
        assert!(
            allowed_hosts_from(&none).unwrap_or_default().is_empty(),
            "没有 net 授权时不该放行任何主机"
        );
    }

    /// 空 `hosts` 列表 = 任意主机（授权面板就是这么显示的），映射成 glob `*`。
    #[test]
    fn empty_hosts_means_any_host() {
        use toolforge_core::permission::{Capability, PermissionSet};
        let set = PermissionSet {
            capabilities: vec![Capability::Net { hosts: vec![] }],
        };
        assert_eq!(allowed_hosts_from(&set), Some(vec!["*".to_string()]));
    }

    /// 有白名单时**只**放行列出的主机，不夹带别的。
    #[test]
    fn declared_hosts_are_carried_through_exactly() {
        use toolforge_core::permission::{Capability, PermissionSet};
        let set = PermissionSet {
            capabilities: vec![Capability::Net {
                hosts: vec!["api.example.com".into(), "*.cdn.example.com".into()],
            }],
        };
        let got = allowed_hosts_from(&set).expect("应当有白名单");
        assert_eq!(got.len(), 2, "不多不少：{got:?}");
        assert!(got.contains(&"api.example.com".to_string()));
        assert!(got.contains(&"*.cdn.example.com".to_string()));
        assert!(
            !got.contains(&"*".to_string()),
            "有具体白名单时**不能**顺带放行任意主机"
        );
    }
}
