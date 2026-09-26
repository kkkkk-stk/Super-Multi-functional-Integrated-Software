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

/// 把 `timeout_ms` 换算成 wasmtime 燃料上限。
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
    pub fn load(
        wasm_bytes: &[u8],
        def: &WasmRuntimeDef,
        plugin_id: String,
    ) -> ToolforgeResult<Self> {
        let pages = Self::pages_for_memory(def.memory_limit_mb);
        let manifest = extism::Manifest::new([extism::Wasm::data(wasm_bytes.to_vec())])
            .with_memory_max(pages);

        let builder = extism::PluginBuilder::new(manifest)
            // 关闭 WASI：这是"没有文件系统"的实现手段。
            // 打开 WASI 就等于把宿主的文件描述符暴露给插件。
            .with_wasi(false)
            .with_fuel_limit(fuel_for_timeout(def.timeout_ms));

        let compiled = builder.compile().map_err(|e| {
            ToolforgeError::runtime(format!("WASM 模块编译失败：{e}"))
                .with_subject(&plugin_id)
                .with_detail(
                    "常见原因：目标不是 wasm32-wasip1 / wasm32-unknown-unknown；\
                     或使用了 Extism 不支持的导入。",
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
        serde_json::from_slice(&out).or_else(|_| {
            // 插件直接返回了裸字符串（没包成 JSON）—— 宽容处理，
            // 因为这是新手最常见的写法，为它报错体验太差。
            String::from_utf8(out)
                .map(Value::String)
                .map_err(|e| ToolforgeError::runtime(format!("WASM 返回值既不是 JSON 也不是 UTF-8 文本：{e}")))
        })
    }

    fn map_extism_error(&self, e: extism::Error, elapsed: Duration) -> ToolforgeError {
        let text = e.to_string();
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
        ToolforgeError::runtime(format!("WASM 插件执行失败：{text}")).with_subject(&self.plugin_id)
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
        match WasmPlugin::load(b"not a wasm module", &def, "test".into()) {
            Ok(_) => panic!("非法 wasm 不应该装载成功"),
            Err(e) => {
                assert_eq!(e.code, ErrorCode::PluginRuntime);
                assert!(e.detail.unwrap().contains("wasm32"));
            }
        }
    }
}
