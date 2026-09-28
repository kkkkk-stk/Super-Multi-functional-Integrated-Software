# ToolForge 安全模型与威胁说明

> 本文档面向三类读者：**插件作者**（要知道自己的代码受什么约束）、**审阅者**（要判断这些约束是否真的存在）、**报告漏洞的人**（要知道什么算问题）。
>
> 它的写作原则是：**只写能从代码里指出位置的事实**。凡是"设计上应该有、但代码里还没接线"的东西，一律标注为「规格说明 / 待实现 / 待定」，而不是当成已实现的安全能力来宣称。
>
> 相关的相邻文档：运行时与引擎边界见 `docs/ENGINE-MATRIX.md`，阶段目标与验收标准见 `docs/ROADMAP.md`。

---

## 0. 本文档的事实基线（请先读这一节）

### 0.1 核对方式

本文所有关于代码的结论，都来自对仓库源码的**逐文件阅读与检索**（`read` / `grep`）。引用代码位置时只写「文件路径 + 函数名/类型名」，不写行号（行号会随编辑漂移；个别必须定位的地方写「约第 N 行」并注明可能漂移）。

**本次核对没有运行 `cargo`。** 这是刻意的：本文档的产出约束是"不修改、不创建仓库内其它文件"，而编译会在 `target/` 下产生产物。由此带来一条必须坦白的限制：

> 凡是"能不能编译通过""单元测试是否全绿"这类判断，本文档一律**不作为结论**，只记录"阅读代码后发现的、看起来会失败的部位"。

### 0.2 与 `docs/ROADMAP.md` 的偏差（重要）

`docs/ROADMAP.md` 的「当前状态速览」一节**已经过期**，不能作为现状依据。本次核对确认的实际状态与它不一致的地方至少有：

| `ROADMAP.md` 的写法 | 本次核对到的事实 |
| --- | --- |
| 「Tauri 后端 `apps/desktop/src-tauri`：🚧 待实现（目录不存在）」 | 目录存在，且 `src/commands.rs`、`src/ipc.rs`、`src/state.rs`、`src/lib.rs`、`src/main.rs`、`src/bin/export_bindings.rs`、`capabilities/default.json` 均已存在 |
| 「进程层 `crates/toolforge-process`：🚧 待实现」 | 存在，含 `exec.rs` / `rpc.rs` / `supervisor.rs` |
| 「引擎层 / 插件宿主 / AI 层：🚧 待实现」 | 三个 crate 都存在源码（`toolforge-engines`、`toolforge-plugins`、`toolforge-ai`） |
| 阻塞 1：`pipeline.rs` 双引号未转义导致无法编译 | **已修复**：该处（`video.compress` 的描述，约第 751 行）已改用「」中文引号 |
| 阻塞 2：`pipeline.rs` 的 `Some(-16.0.into())` 触发 E0282 | **已修复**：现已写成 `Some((-16.0f64).into())` 并附了说明注释 |
| 阻塞 3：`PermissionSet` 的 `#[serde(transparent)]` 与 `plugin.rs` 测试夹具不匹配 | **已消解，但方向与当初判断相反**：`#[serde(transparent)]` 被**移除**，schema 改为 `permissions: { capabilities: [...] }`，各夹具本来就是映射形式，因此 5 个失败用例现在通过。**后果是原先按裸数组写的示例插件全部失效**，`plugins/` 下 6 个 `plugin.yaml` 已改正并重新通过校验（见 §3.0） |
| 阻塞 4：`paths.rs` 的 `sanitize_id` 实现与自身测试不符 | ✅ **已修复**：实现改为「替换非法字符 → **把连续的点折叠成单个点** → 去掉首尾的点 → 空串回落 `unnamed`」，结构上不可能再出现 `..`；测试也改成断言不变量（结果不含 `..` / `/` / `\`、非空）并新增 `sanitize_never_leaves_dotdot`。**下面 §4.5 的原文保留为历史。** |

结论：**判断"现在能不能跑"必须以代码和 CI 输出为准**，本文档只描述代码里存在的安全机制与缺口。下面是**当前**可复核的基线（本文档最早写作时的那份"编译失败 / 59 passed, 2 failed"记录**已完全过期**，它的两个失败项正是上面已修掉的阻塞 1–4）：

```text
cargo test --workspace                  →  290 passed / 0 failed
scripts/devtools/verify-platform.mjs    →  433 项检查全通过（【1】–【37】）
```

> ⚠️ **但"全绿"不等于"本文档列的每一条都已修好"**：上面这张 §9 的缺口清单里，第 2–5、7、13、19、22–25、27–30 项**仍然成立**（它们是设计边界或未接线，不是测试失败）。测试绿说明"代码自洽"，不说明"防护完整"。

### 0.3 强度分级用语

本文档对每一项安全能力都会给出下列标签之一，请按标签理解措辞：

| 标签 | 含义 |
| --- | --- |
| **已实现** | 有明确的代码路径在运行时真的执行这个检查 |
| **部分实现** | 检查存在，但只覆盖一部分情形，或只在某个运行时下生效 |
| **仅声明未接线** | 类型/数据结构与单元测试都有，但生产代码里没有调用点 |
| **规格说明** | 只是设计意图，代码尚未写 |
| **已知缺陷** | 代码与它自己的文档或测试不一致，或存在可指出的绕过 |

---

## 1. 威胁模型

### 1.1 核心断言

> **AI 生成的插件 = 不受信任代码。从外部导入的插件同样不受信任。**

这条断言的直接后果，是整个项目的安全模型**不敢建立"代码看起来没问题"之上**：

- 不做"源码审查通过就放行"的假设。AI 生成的结果可能被提示词注入操纵（模型输出的 YAML/Python 是**外部输入**，与用户手打的字符串没有区别）；
- 不因为插件"只是 YAML"就认为它无害（见 §1.4：L1 是数据，但它读写的仍是你磁盘上的文件）；
- 不因为插件目录是用户自己放进来的就默认信任（用户往往是从别处下载的）。

`crates/toolforge-plugins/src/lib.rs` 的模块文档把这条断言落成了流程：读清单 → 静态校验 → 权限差异检测 → 用户授权 → 哈希锁定 → 装载。**"用户授权"是唯一真正的放行门**，其余步骤都是为了让人能做出知情决定。

### 1.2 资产（要保护什么）

按重要性从高到低：

1. **用户文件** —— 输入/输出目录、以及这些目录之外的任何可读文件（文档、照片、密钥文件如 `id_rsa`、`.env`）。
2. **API Key 与凭据** —— 尤其是 AI 服务的 Key。它的落盘方式见 §1.5：**默认只在进程内存里**（`AiProviderConfig::api_key` 带 `skip_serializing`，见 `crates/toolforge-ai/src/provider.rs`，不会随 `Settings` 序列化到前端），只有用户显式打开「记住 API Key」时才**明文**写到磁盘。
3. **用户额度** —— `Capability::Ai` 的 `describe()` 原文就是「调用 AI 服务（消耗你的额度）」。被刷额度不致命但真实存在。
4. **宿主进程** —— 插件跑在宿主进程内（L2）或作为子进程（L3）。宿主进程被打崩 = 任务丢失、数据可能未落盘。
5. **机器** —— 任意代码执行、持久化驻留（开机自启）、横向移动到用户其它凭据。

### 1.3 攻击者画像

| 攻击者 | 动机 | 典型手法 | 主要被哪一层挡住 |
| --- | --- | --- | --- |
| **恶意插件作者** | 窃取文件、装后门、刷额度 | 在 L3 代码里读 `~/.ssh`、拉取远程脚本、起 `curl` | 用户授权界面（必须看到 `fsRead`/`exec` 的含义）+ 路径收敛 + 审计 |
| **被投毒的 AI 生成结果** | 同上的"副产物" | 提示词注入让模型输出"顺手多声明 `net`"或用 `eval` 隐藏逻辑 | `PluginManifest::validate()`（纯函数，写盘前就能拒）+ `review_draft()` 的可疑模式扫描 + 用户 diff 审阅 |
| **被替换的插件文件** | 在你授权**之后**把代码换掉（授权的是 A，跑的是 B） | 安装后往插件目录塞 `backdoor.py`、改 `main.py` | `content_hash` + `PluginState::installed_hash`（装载前校验，不匹配即拒绝 + 记审计 + 自动禁用） |
| **被篡改的前端** | 绕过 UI 直接下命令 | 改 renderer、伪造 `invoke` 参数，试图给插件授予清单外能力 | `PluginStore::set_granted()` 会丢弃清单未声明的能力并记审计；安装命令要求 `permissions_acknowledged` |

注意最后一行背后的设计立场：**前端永远被当作不可信输入源**。所有判据都在 Rust 侧重算一遍，前端的勾选只是"用户意图的载体"，不是权限本身。

### 1.4 信任边界：三级运行时的真实强度

三级运行时不是"同一机制的三个档位"，而是三种**根本不同的信任边界**（`crates/toolforge-plugins/src/lib.rs` 的表述是"用一套机制表达会导致要么什么都不让做、要么什么都让做"）：

| 运行时 | 载体 | 信任边界 | 强度标签 |
| --- | --- | --- | --- |
| **L1 `Pipeline`** | YAML 编排内置节点 | **是数据，不是代码**。但"数据"仍然能指定输入输出与节点参数，所以仍受路径收敛与能力裁决约束 | **已实现**（见 §2.3 的接线状态说明） |
| **L2 `Wasm`** | Extism + Wasmtime，关闭 WASI | **与内核无关的强沙箱**：没有文件系统、没有网络、没有线程、没有 SIMD，只有确定性的整数/浮点运算 | **已实现** |
| **L3 `Python`** | 独立进程 + JSON-RPC over stdio | **不是沙箱** | **部分实现**（诚实说明见下） |

#### L2：为什么它敢叫沙箱

`crates/toolforge-plugins/src/runtimes/wasm.rs` 的 `WasmPlugin::load()` 里，`PluginBuilder` 显式 `.with_wasi(false)` —— 注释写得很直白：「打开 WASI 就等于把宿主的文件描述符暴露给插件」。此外：

- **资源上界用 wasmtime 的 fuel（燃料），不用墙钟超时**。理由同样写在模块文档里：WASM 关掉 WASI 后无法阻塞（没有 I/O、没有网络、没有 `sleep`），只能烧 CPU；既然只能烧 CPU，燃料耗尽就 trap，精确且可中断。反之"丢到另一个线程再 timeout"只是**假装**超时——超时后那个线程还在烧 CPU。
- `timeout_ms` 在装载时经 `fuel_for_timeout()` 换算成燃料上限（经验值 1e8 燃料/秒，并有 1e7 的下限，避免 `timeoutMs: 1` 变成"什么都不许做"）。
- 内存上限走 `Manifest::with_memory_max()`（`pages_for_memory()` 把 MB 换算成 64 KiB 页，并 clamp 到 16 页…65536 页，即 1 MiB…4 GiB）。
- 调用入口还有一道 16 MiB 的载荷上限（沙箱之间要拷贝内存，塞大文件会 OOM）。
- **v0.1 不注入任何自定义宿主函数**。清单里的 `allowHostFunctions` 会被校验（只允许 `log` / `kv`），其中 `kv` 是 v0.2 才接的内容；日志走 Extism PDK 内置的 `extism_log_*` 导入。理由写在文件里：宿主函数是**唯一**能从沙箱里伸出手来的口子，每加一个都要单独评估。

因此 L2 的能力边界是**结构性的**，不是"检查得比较严"：清单里给 L2 插件声明 `fsRead` 是设计错误，校验器会给出 `WASM_WITH_PERMISSIONS` 警告。

#### L3：请**不要**对用户说它是沙箱

`crates/toolforge-plugins/src/runtimes.rs` 的模块文档「L3 · Python 进程的隔离程度（诚实说明）」一节，逐字要点如下（`crates/toolforge-plugins/src/runtimes/python.rs` 的 `PythonPlugin::launch()` 是它的实现）：

宿主**做了**：

- **清空继承的环境变量**（`SpawnSpec::clear_env = true`）——所以 `OPENAI_API_KEY` 之类读不到；
- **锁定工作目录**在插件的私有目录（`spec.cwd`）；
- **默认断网**：设置指向 `127.0.0.1:1` 的代理环境变量（`HTTP_PROXY` / `HTTPS_PROXY` / `http_proxy` / `https_proxy`，并把 `NO_PROXY` 清空），同时注入 `TOOLFORGE_NETWORK=denied` 让写得好的插件直接给出友好报错；
- **超时**：默认 300 秒，超时返回 `TIMEOUT` 错误码，并且**超时的进程会被强杀**（`PythonPlugin::call()` 里判到 `ErrorCode::Timeout` 就 `kill()`），因为卡在 native 代码里的进程已经不可信；
- **优雅关闭**：先 `shutdown` 再关 stdin，最后才 kill（`ChildSupervisor::shutdown()`）。

**但是**（原文语气）：

> 这不是内核级沙箱。一个蓄意的插件可以直接用 `socket` 绕过代理环境变量、可以读它进程能读的任何文件。真正的隔离需要 Windows Job Object + AppContainer、或 macOS `sandbox-exec`、或 Linux seccomp —— 这些在 v0.2 的路线图里（见 ROADMAP）。

配套的两条结论也必须一起复制过去，不要只抄前半段：

> **因此 L3 插件的安全依赖两件事**：
> 1. 用户在授权前真的看了权限清单（所以 UI 必须把高危能力标红）；
> 2. 审计日志能事后追溯。

同一个立场在外壳层有对应的用户可见文案：`apps/desktop/src-tauri/src/commands.rs` 的 `plugins_install()` 要求 L3 插件必须带 `executable_code_acknowledged`，拒绝时的 `detail` 是「L3 插件以你的身份运行。宿主的隔离措施（清空环境变量、锁定工作目录、默认禁网）只能挡住非蓄意的越权，不能挡住恶意代码。」——这句话是准确的，请保持。

#### 另外两个必须一起说的边界

- **`PATH` 是被刻意保留的**。`crates/toolforge-process/src/supervisor.rs` 的 `ChildSupervisor::spawn()` 在 `env_clear()` 之后重新注入了 `PATH`，注释理由是「至少要给 PATH，否则 Windows 上子进程自己起程序会失败」。**这意味着 L3 插件可以用 `subprocess` 起 PATH 里的任何程序**。`Capability::Exec` 目前没有运行时强制（见 §3.4 与 §9）。
- **不做原生动态库加载**。`ROADMAP.md` 的 Non-Goals 明确写了不做 `.dll` / `.so` / `.dylib` 加载，理由是"原生库一旦载入进程便拥有与应用同等的权限，无法做到逐条能力授权 + 运行时可裁决；这会直接废掉本项目安全模型的地基"。这条决定本身是一项**核心安全属性**，改动它等于换掉整个威胁模型。

---

### 1.5 凭据的落盘方式：`settings.json` 与 `ai-key.txt`

这一节必须单独写，因为这里曾经有一句**假话**：设置页写着「所有设置都会立即写入本机配置文件」，`AiSettings` 的注释也写着「Key 存在内存与 OS 钥匙串里」——而当时 `AppState.settings` **只在内存里**，钥匙串**从来没接过**。现在实现是：

**非机密设置 → `<data_dir>/settings.json`**（`apps/desktop/src-tauri/src/settings_store.rs`，路径来自 `paths.rs::AppPaths::settings_file()`）。三条纪律写在模块文档里：

1. **原子写**：先写同目录下的临时文件（文件名带进程 ID），再 `rename` 覆盖，并 `sync_all`。直接截断重写的话，写到一半断电/崩溃就留下半截 JSON，下次启动读不出来 —— 用户的**全部**设置一次性丢失；
2. **读失败绝不致命，但也绝不静默**：解析失败就把原文件改名成 `settings.broken.json`（`settings_backup_file()`）留证，然后用默认值启动。**启动路径上的"读设置"失败绝不能阻止应用启动** —— 一个坏掉的 JSON 让用户连界面都进不去，也就没有界面去修它。丢用户数据可以忍，丢"为什么会丢"的线索不行；
3. **API Key 不进这个文件**。它单独放在 `ai-key.txt`（`ai_key_file()`），而且**只有用户显式勾选「记住 API Key」（`ai.persistApiKey`）时才写**。默认不落盘 —— 密钥的默认状态必须是最保守的那一种。

缺字段的旧配置文件按**字段级默认值**补齐，所以老格式继续能用（这是"不因为新增一个设置就把用户的配置判死"的代价最小的做法）。

**关于 `ai-key.txt`，必须明确说清三件事：**

| 事项 | 事实 |
| --- | --- |
| 安全性 | **它是明文。** 没有任何加密、没有 DPAPI、没有 Keychain。能读这个文件的进程/用户就能拿到 Key。这是相对"OS 钥匙串"的**能力降级**，不是等价实现 |
| 默认值 | **`ai.persistApiKey` 默认 `false`** —— 默认只存在内存，重启后需要重填 |
| 关闭时 | **关掉开关会删除 `ai-key.txt`**（`save_api_key(paths, None)` → `remove_file`）。"清除 Key"必须真的把磁盘上那份删掉，只清内存里的那叫没清 |

OS 钥匙串（Windows DPAPI / macOS Keychain）**仍未实现**，它是 `ROADMAP.md` 上的待办（§9 第 27 项）。在它落地之前，**任何界面文案、文档、错误提示都不许声称 Key 是"加密存储"的**。
> ✅ **`engine.rs` 里那句与实现不符的文案已经改掉了**（本条原来说"`ai-provider.licenseNote` 至今还写着「API Key 只存在本机加密存储中」"）。现在的原文是：「API Key 默认只存在内存里（重启要重填）。打开「记住 API Key」后会以**明文**另存到数据目录下的 `ai-key.txt` —— 系统钥匙串尚未接入。它不会随插件或日志外泄。」—— 与实现逐句对得上，包括"明文"这两个字。

**这条措施能保证的部分**仍然是必守的：Key 不写进插件、不写进日志、不随 `Settings` 序列化给前端（`skip_serializing`），审计写入点也不含凭据（§7.4）。

#### 1.5.1 密钥**脱敏**：从"猜前缀"改成"按字面量抹掉"（本轮加固）

`crates/toolforge-ai/src/provider.rs` 早就有 `redact()`，但它只认 `sk-` / `sk_` 开头且长于 12 的 token —— 那是 OpenAI 的风格。而密钥前缀是各家自己的：**Google 是 `AIza…`、Azure 是一串无前缀十六进制、自建网关常常是任意字符串**。这些全都不会被命中。

**最现实的泄漏渠道不是"我们把 Key 拼进了错误信息"**（那种低级错误没有），而是**对方把请求回显了回来**：代理 / 网关 / 开着调试模式的后端会把 `Authorization` 头带进响应体，而那段响应体正是应用截下来放进错误的 `detail`、给用户看的东西。

所以新增 `redact_with(text, secret)`：**只要知道密钥是什么，就按字面量抹掉**，与它长得像不像 Key 无关（少于 8 个字符的不替换，免得把正文里的普通词也抹掉）；启发式仍然保留，作为"漏进来的别的密钥"的第二道拦网。四个错误路径（连接失败、非 2xx 的响应体、列模型失败）全部改用带密钥的那一版。

**真机验证（`verify-platform.mjs`【24】）**：假端点里加了一条"话多的网关"路由，**把真实请求头原样回显**在 500 响应体里；然后断言

* ⑥b 回显正文**确实进了**给用户看的错误文本（否则"里面没有密钥"可能只是因为整段响应体被丢掉了 —— 那种通过是假的）；
* ⑦ 那段文本里**看不到密钥**，⑦b 但留下了可见的 `[REDACTED]` 标记（不是静默删掉，排查时能看出这里本该有值）。

同一条检查还顺带验了 Key 的整条落盘生命周期（勾上 → 真的写盘；`settings.json` 里没有它；`settings_get` 不回传明文、只回报 `hasKey`；关掉开关 → 磁盘那份被删；清除 Key → 内存与磁盘都干净）。**重启行为另外单独验过**（这条不在套件里，因为要重启应用）：勾上开关并写入 Key 后重启 → `hasKey=true` 且文件内容一致；开关关掉但磁盘上有残留时重启 → 应用**主动把残留删掉**。

---

## 2. 三层防护

### 2.1 第一层：声明制

**机制**：插件的 `plugin.yaml` 里用 `permissions` 列出它需要的**全部**能力；运行时出现未声明的调用 = 直接拒绝 + 记安全审计，**不做静默降级**。

`crates/toolforge-core/src/permission.rs` 的模块文档把这条写成硬机制：

> 代码里出现没声明的能力调用 = 直接拒绝 + 记安全审计，不是"尽力而为"。

为什么强调"不做静默降级"：`CapabilityGuard::check()` 的文档注释给的理由是「静默降级（比如"读不到就当空文件"）会让攻击面隐形」——一次被吞掉的越权尝试不会出现在审计里，用户就永远不知道有人试过。

**诚实的接线状态**：这条规则在代码里的**具体落点**是：

- L1：`crates/toolforge-plugins/src/l1.rs` 的 `run_pipeline()`，在跑之前先判断流水线是否引用 `${src}`，若是而生效权限里没有**任意** `FsRead`，则 `record_violation()` + 返回 `ToolforgeError::violation()`。这是**已实现**的。
- 装载门：`PluginStore::runnable()`（`crates/toolforge-plugins/src/store.rs`）要求"已启用 + 校验通过 + **没有待授权项**"，否则返回 `ErrorCode::PermissionDenied`。**已实现**。
- 通用裁决器 `CapabilityGuard::check()`：**已接线**（`fsRead` / `fsWrite` 部分）。`nodes.rs::resolve_path()` 对每一次文件访问先调它；拒绝时返回 `PluginCapabilityViolation`，由 `l1.rs` 在**应用 `onError` 策略之前**写入审计。`ReadEnv` / `Spawn` / `Http` 三个分支仍无调用点，见 §9 第 2–4 项。

  > ⚠️ **这条曾经是本项目最严重的一处"文档说谎"**：`check()` 有完整逻辑和单测，
  > 但生产代码里**一个调用点都没有** —— `CapabilityGuard` 在 `l1.rs` 被构造、
  > 塞进 `NodeCtx.guard`，然后就再也没人碰过它。也就是说 README 与本文档里
  > 宣称的"运行时逐请求裁决"当时**根本不生效**，真正拦住越权的只有
  > `PathResolver`（它管路径，不管"你有没有这个能力"）。
  >
  > 它是由一次外部代码审计发现的，不是测试发现的 —— 因为当时的测试只验证了
  > `check()` **自己**的行为，没有验证它**被调用**。现在有四条回归测试
  > （`fs_write_is_rejected_without_the_capability` 等）钉住接线本身。

### 2.2 第二层：最小授权

**机制**：清单声明的能力 ≠ 已授权。用户逐条勾选，**运行时真正生效的集合 = 声明 ∩ 已授权**：

```rust
// crates/toolforge-core/src/permission.rs
pub fn effective(declared: &PermissionSet, granted: &PermissionSet) -> PermissionSet
```

判定用 `Capability::fingerprint()`（`serde_json::to_string(self)` 得到的稳定指纹）做集合运算，`effective()` 最后会 `dedup()`。

支撑这条的几个事实：

- **安装 ≠ 可用**。`PluginStore::install()` 无论走哪条路径，最后都经 `finish_install()`，它把状态写成 `enabled: false` + `granted: PermissionSet::empty()`（注释：「这是安全模型的地基」）。`installed_hash` 与 `installed_at` 在这里落盘。
- **没有"一键全部允许"**。授权面板默认**全不勾选**、也刻意**没有"全选"按钮**（`apps/desktop/src/components/plugins/permission-gate.tsx` 的注释：「有了它，用户就会闭着眼点它，逐条阅读的意义就没了」）。
  > ⚠️ **2026-09 修正**：这一条原文还写着"`PluginStore::set_enabled()` 在启用前调用 `runnable_or_grant_all()`，只要还有未授权项就拒绝"。**那道门已经去掉了**，因为它是错的：
  >
  > ```text
  > 启用要求 已授权 ⊇ 声明；而 set_granted 只接受声明里有的 ⇒ 已授权 ⊆ 声明
  > ⇒ 已授权 == 声明 ⇒ 运行期的"声明 ∩ 授权"永远等于声明本身
  > ```
  >
  > 也就是说，第二层"最小授权"在真实链路上**从来没有被走到过**：任何"给少了"的状态都不允许启用，所以 `effective()` / `allowed_hosts_from()` / `CapabilityGuard` 里那套"少一个都不给"的逻辑全是装饰。它的实际后果还更糟 —— 插件只要申请了一项你不想要的权限（最典型的是"任意主机 `net`"），你就只能整包放弃，这正是"最小授权"想避免的**习惯性全选**。
  >
  > 现在的模型是一条直线，没有中间门：**装**（校验 + 落盘）→ **启用**（你说了算）→ **用**（碰了没授权的动作就当场拒绝并记审计）。缺哪些能力由 `PluginStore::ungranted_declared()` 在运行前作为**警告**报出来。
- **前端不能越权授权**。`PluginStore::set_granted()` 会逐条比对清单，把**清单未声明**的能力丢弃，并记一条 `AuditEventKind::CapabilityViolation`（detail 是 `{ "rejected": [...] }`）。注释说明了理由：「防止前端被篡改后给插件开出清单外的权限」。
- **"存在待授权项"对外表现为一个布尔**：`PluginSummary::has_pending_permissions`，计算方式是 `effective.capabilities.len() != declared.capabilities.len()`（`crates/toolforge-core/src/plugin.rs` 的 `PluginSummary::from_manifest()`）。列表页用它排序（有待授权项的排前面）、顶部用它显示待处理数量。
- **内置插件是唯一的例外**：`PluginStore::load_state()` 对内置插件给出 `enabled: true` 且**默认授予其声明的全部能力**，理由是"这些清单是我们自己写的、随包分发的"。用户插件默认既禁用也不授权。这条例外依赖"内置插件目录不可被替换"这个前提，见 §9 第 20 项。
- **不允许运行期提权**（**已实现**）。L3 插件可以在运行中发 `host.request` 向宿主申请新能力，`crates/toolforge-plugins/src/runtimes/python.rs` 的 `handle_notification()` 对此的处理是：**一律拒绝**，只给用户一条警告——「插件在运行中请求了额外能力，已被拒绝。如确需该能力，请在插件详情页重新授权并重启插件。」代码注释把理由点明了：「能力必须在装载前由用户授权，运行期提权是"点击劫持"的经典入口」。同样的立场在 `apps/desktop/src-tauri/src/commands.rs` 的 `plugins_grant()` 里：授权变更后**立即卸载**该插件的已装载实例（因为 Python 进程的环境变量与能力标签都变了），保证"新的授权集合"与"正在跑的进程"不会不一致。

### 2.3 第三层：运行时裁决 + 路径收敛

**机制（设计）**：

```
CapabilityGuard::check(&CapabilityRequest) -> CapabilityVerdict { Allow | Deny { code, reason } }
```

- `Deny` 里的 `code` 固定是 `ErrorCode::PluginCapabilityViolation`（见 `error.rs` 中这个变体的注释：「插件使用了未声明的能力（**安全事件，会被审计记录**）」）；
- 原文要求：**返回 Deny 就一定要向上冒泡成 `PluginCapabilityViolation`**，由调用方同时写审计日志。

**路径收敛**：`PathResolver::resolve()` 是把插件逻辑路径翻译成真实路径的**唯一**入口。`permission.rs` 里对它的定性是：

> **这是防止路径穿越的唯一入口**。任何绕过它直接 `Path::new(plugin_input)` 的代码都是漏洞。

详见 §4。

**接线状态**：`CapabilityGuard::check()` 已接在 `nodes.rs::resolve_path()` 上（见 §2.1），所以"运行时逐请求裁决"对**文件访问**是生效的。当前实际生效的完整链条是：

1. `PluginStore::runnable()` 的装载门（**只卡"已安装 / 已启用 / 清单校验通过"**；权限不齐不再是阻塞项，见 §2.2 的修正）；
2. **`CapabilityGuard::check()`**（每次文件访问都过 —— 回答"有没有这类能力"）；
3. **`PathResolver`**（回答"这个具体文件能不能碰"，见 §4）；
4. L1 的 `fsRead` 预检（流水线引用 `${src}` 却没声明 fsRead 时提前拒绝并记审计）；
5. L3 的 `deny_network` 布尔开关与超时强杀；
6. **L2 的 Extism 主机白名单**（`runtimes/wasm.rs::allowed_hosts_from` 把"声明 ∩ 授权"翻译成 `allowed_hosts`，`net` 的越界请求由沙箱自己拒绝 —— 这是本项目第一个**真正按字节落到沙箱**的能力裁决）；
7. **L3 的环境变量白名单**（`runtimes/python.rs::inject_declared_env`，装载时按「声明 ∩ 授权」注入，其余一律为空）；
8. **L3 的 `exec` 装载期静态门**（`runtimes/python.rs::scan_python_sources` + `gate_exec_usage`，见 §9 第 3 项 —— **这是装载期的门，不是运行期的拦截**）。

**仍未覆盖**：`ReadEnv` / `Spawn` 两类请求没有运行时调用点 —— 前者已随第 7 条变得不必要（环境在装载时就定好了），后者在 v0.1 **结构上做不到**（见第 8 条与 §9 第 3 项）；`Http` 请求对 **L3** 也不在宿主手里（只有 L2 走 Extism 内置的 `http_request`，受白名单约束）。

**路径收敛的适用范围（必须写清楚，否则会严重误判 L3 的安全性）**：

`PathResolver` 管的是"**宿主自己**拿着插件给的（逻辑）路径去开文件"这条路——也就是 L1 内置节点（`nodes.rs::resolve_path()`）以及宿主侧的读写。它**管不到 L3 插件进程自己的 `open()`**：Python 插件是独立进程，文件读写由它自己发起，宿主既不代理也没有拦截（宿主→插件的方法只有 `initialize` / `run` / `shutdown` 三个，插件→宿主只有 `progress` / `log` / `host.request` 通知，**没有任何"宿主代插件读文件"的通道**）。

另外，`PluginRunner::resolver_for()` 上写着"让 `PathResolver` 与插件目录对齐（**供 L3 使用**）"，但全仓库**没有任何调用点**。

结论：**对 L3 而言，`fsRead{scope}` / `fsWrite{scope}` 目前是"约定"而不是"强制"**；L3 的实际边界就是 §1.4 所述的那几件事（清空环境变量、锁 cwd、代理断网、超时强杀）。凡是对外描述"插件的文件访问被限制在授权目录内"，都必须同时说明这个区别。§9 第 25 项。

因此当前的安全姿势可以概括为：**"能不能跑"几乎不卡，"跑起来之后每一次具体操作"按能力裁决**。第二层（最小授权）现在是一个**真的交集**而不是恒等式 —— 但代价是"授权不足"这件事只会在运行时暴露，所以运行前的警告（`ungranted_declared`）与运行时的拒绝理由必须写得足够清楚。§9 把还没做到的部分逐条列出。

---

## 3. 每种 Capability 的攻击面

### 3.0 清单里到底怎么写（先看这个，否则会踩坑）

`permissions` 在清单里是**带 `capabilities` 字段的映射**，不是裸数组。
`PermissionSet` 是一个普通结构体，`permission.rs` 里刻意**没有**加 `#[serde(transparent)]`：

```rust
// crates/toolforge-core/src/permission.rs
/// ⚠️ 这里**刻意不加** `#[serde(transparent)]`：加了之后 YAML 会变成
/// `permissions: [ ... ]` 这种裸数组，既不好读也没法在未来扩展字段。
/// 现在的形状是 `permissions: { capabilities: [ ... ] }`，
/// 所有示例插件与文档都按这个形状写。
#[derive(..., Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PermissionSet {
    pub capabilities: Vec<Capability>,
}
```

所以正确写法是：

```yaml
permissions:
  capabilities:
    - kind: fsRead
      scope: { kind: input }
    - kind: fsWrite
      scope: { kind: output }
```

**不能**写成裸数组 `permissions: [ ... ]` —— 那会报
`permissions: invalid type: sequence, expected struct PermissionSet`。
不申请任何能力时写 `permissions: { capabilities: [] }`。

> ⚠️ 本文档早期版本曾把这里写成"序列"，是**旧 schema**（那时 `PermissionSet` 带
> `#[serde(transparent)]`，该属性已被移除）。`plugins/` 下 6 个示例插件与
> `docs/PLUGIN-SDK.md` 均已按映射形式更正并逐一通过 `PluginManifest::validate()`。

`Capability` 的 serde 形态是 `#[serde(tag = "kind", rename_all = "camelCase")]`（见 `permission.rs`），所以标签值是 `fsRead` / `fsWrite` / `net` / `exec` / `env` / `ai` / `gpu`；`PathScope` 同样是内部标签枚举，标签值是 `input` / `output` / `pluginData` / `workspace` / `explicit`。

**注意**：随包示例插件（`plugins/`）目前只用到 `fsRead` 与 `fsWrite`，`wasm-example` 用的是空权限。下面各小节里的 `net` / `env` / `exec` / `ai` / `gpu` 写法是按上述 serde 属性推导的（结构一致），但**没有随包示例可作为"已被装载器接受"的证据**，见到实际报错时以代码为准。

`capabilities` 列表之外还有两条通用约束：

- 插件 id 必须是 3..=128 个字符，且只含小写字母、数字、`.`、`-`、`_`（`plugin.rs` 的 `is_valid_plugin_id()`，错误码 `ID_FORMAT`）；
- 声明了 `Critical` 风险的能力会得到一条 `CRITICAL_CAPABILITY` 警告（**是警告不是错误**——`ValidationReport::ok` 只看 Error，所以它会进确认页但不会阻止安装）。

### 3.1 `FsRead { scope }`

```yaml
permissions:
  - kind: fsRead
    scope: { kind: input }
```

**含义**：读取某个逻辑作用域内的文件。作用域由宿主分配。

> 早期版本这里写的是"插件拿不到真实绝对路径"。**那是错的**：`${src}` / `${output.dst}` 传的就是真实绝对路径（见 §4.1 的更正）。真正成立的说法是：**插件无法引用授权根之外的任何路径** —— 它给的路径会被规范化后与授权根做组件级比较。

`risk()`：**Low**。唯一例外是 `PathScope::Explicit(_)`，返回 **High**（但见 §3.8：这个分支目前不可达）。

**攻击面**：

- 读走输入目录里的**全部**文件——如果用户把整个文件夹拖进来，插件能看到这个文件夹里与其任务无关的文件；
- 输入根目录是通过"所有输入文件的公共父目录"算出来的（`commands.rs` 的 `build_io()` → `common_prefix()`）。拖入单个文件时，**根目录就是该文件所在的整个目录**。这是路径收敛边界的一个真实放大效应：只想转一张图，插件却获得了该目录的读权限。
- 通过符号链接逃出授权根目录（见 §4.4，**这是真实的绕过方向**）。

**缓解**：`PathResolver::resolve()` 拒绝绝对路径 + 词法规范化 + `starts_with(root)`；`Input` 作用域在设计上是只读的（`PathScope::Input` 的注释写「宿主自动加入，只读」）。建议：**拖入单个文件而不是整个目录**，把待处理文件放在专用子目录里。

> **L3 例外**：上面的收敛只对"宿主自己开文件"成立。Python 插件自己发起的 `open()` **不经** `PathResolver`（见 §2.3）。

### 3.2 `FsWrite { scope }`

```yaml
permissions:
  - kind: fsWrite
    scope: { kind: output }
```

**含义**：向某个逻辑作用域写文件。

`risk()`：**Medium**。但 `FsWrite { scope: PathScope::Explicit(_) }` 会被拉到 **Critical**（代码里 `Capability::FsWrite { .. } => RiskLevel::Medium` 这一支其实覆盖了所有 `FsWrite`；Critical 的效果来自 `PathScope::Explicit` 自身的设计意图与 `plugin.rs` 里专门为它准备的 `HOST_PATH_WRITE` 警告——注意这两处对 `Explicit` 的风险定级**并不一致**，`FsRead{Explicit}` 判 High、`FsWrite{..}` 判 Medium，而 `PathScope::Explicit` 的文档注释说"风险等级直接拉到 Critical"。这是一个代码内部不一致，已记入 §9）。

**攻击面**：

- 覆盖/删除输出目录里的既有文件（`fs.delete`、`fs.move` 节点都在内置节点表里）；
- 写一个同名文件把用户原文件顶掉——**如果输出目录被用户设成与输入目录相同**，这一步就会毁掉原文件。建议：输出目录与输入目录分开，这是唯一可靠的缓解；
- 用大文件把磁盘写满（`Bundle` 安装路径有体积上限，但**运行时写文件没有配额**）。

**缓解**：`starts_with(root)` 收敛；"输出目录"这个概念本身就是缓解手段。**没有**磁盘配额、**没有**写入白名单文件名、**没有**对已存在文件的保护策略。

> **L3 例外**：同上——插件进程自己的写入不经 `PathResolver`。所以"输出目录与输入目录分开"这条建议对 L3 是**唯一**有效的数据保护手段。

### 3.3 `Net { hosts }`

```yaml
# 只允许特定主机
permissions:
  - kind: net
    hosts: ["api.openai.com", "*.huggingface.co"]

# 任意主机（高风险写法）
permissions:
  - kind: net
    hosts: []
```

**含义**：出网。**`hosts` 为空列表表示"任意主机"**（`Capability::describe()` 会渲染成「访问网络（任意主机，无限制）」），`risk()` 返回 **High**；非空列表返回 **Medium**。

**匹配规则**（`permission.rs` 的 `host_matches()`）：

```rust
if let Some(suffix) = pattern.strip_prefix("*.") {
    host == suffix || host.ends_with(&format!(".{suffix}"))
} else {
    pattern == host
}
```

即"精确相等，或 `*.` 前缀的后缀匹配"。两个必须知道的推论：

1. **`*.huggingface.co` 会匹配裸 `huggingface.co`**（因为 `host == suffix` 这一支）。代码里 `host_allowlist_matching` 单元测试把这一点固定为**预期行为**。所以写 `*.example.com` 并不等于"仅子域"。
2. 匹配前双方都会被 `trim().to_ascii_lowercase()`，所以大小写与首尾空格不敏感；但**不做** IDN/Punycode 归一化、**不看**端口（`Http { host }` 里如果带了 `example.com:8080`，`pattern == host` 会失配）。

**攻击面**：

- `hosts: []` 等于把网络完全交出去：数据外传、拉取二阶段载荷、打内网地址（SSRF 到 `127.0.0.1`、`169.254.169.254` 这类元数据地址）、DNS 隧道；
- 白名单写得过宽（`*.example.com`、`*.github.io`、`*.s3.amazonaws.com`）等于把"用户可控内容托管平台"拉进来，攻击者可以在那里放载荷；
- **绕过代理环境变量**：`deny_network` 的实现只是设了几个 `*_PROXY` 环境变量，任何直接使用 socket 的代码（`socket`、`aiohttp` 的某些路径、原生扩展）都不受影响。

**缓解（当前真实有效的部分）**：

- **默认断网**：`PythonRuntimeDef::allow_network` 默认 `false`，`SpawnSpec::deny_network` 默认 `true`（`supervisor.rs` 的 `spawn_spec_defaults_are_safe` 单元测试锁定这条不变量）；
- **声明一致性检查**：`PluginManifest::validate()` 在 `python.allowNetwork == true` 但清单没声明 `net` 时报**错误** `PYTHON_NET_WITHOUT_PERMISSION`（零容忍，不是警告）；
- 运行期也查一次：`PluginRunner::call()` 在"生效权限要求联网、但 `python.allowNetwork == false`"时报 `PluginInvalid`，注释是"两者必须一致。若确实需要联网，请在清单里同时打开"；
- 递归缓解：`crates/toolforge-ai/src/review.rs` 的 `scan_code()` 会把 `socket` / `requests.` / `urllib` / `httpx` 标为"需要 net"的可疑模式，清单没声明就报 `UNDECLARED_*` 发现（`socket` 那条的说明文案就是"原始套接字（可绕过代理环境变量）"）。

**当前**没有**的**：`hosts` 白名单**没有运行时强制**。`CapabilityGuard::check_host()` 会做这个判定，但 `check()` 没有调用点（§9 第 2 项）。所以现在 `hosts` 唯一的作用是"声明给用户看"——它决定用户在授权界面看到「访问网络（仅限：…）」还是「访问网络（任意主机，无限制）」。

**建议**：白名单**写得越具体越好**——写完整主机名而不是 `*.` 通配；不要写平台型域名；确实需要联网时优先"宿主代取"而不是给插件开网。

### 3.4 `Exec`

```yaml
permissions:
  - kind: exec
```

**含义**：启动子进程。`describe()` 是「启动外部进程」。

`risk()`：**Critical，`RiskLevel` 里的最高档**。代码注释把理由写得没有余地：

> 能起子进程 = 基本等价于任意代码执行，这是最高危的一档

**攻击面**：**这一项本身就是攻击面，不是"可能导致攻击面"**。能起子进程基本等于拿到用户权限：起 `curl`/`pwsh` 外传文件、起 `cmd /c` 做一切、读写插件自身权限之外的东西（因为子进程不再受 `PathResolver` 约束——路径收敛只管宿主自己打开文件的那条路）、建立持久化。`ValidationReport` 会为它加一条 `CRITICAL_CAPABILITY` 警告，但那只是**警告**。

**当前的真实状态（务必如实转述）**：

- `CapabilityGuard::check()` 对 `Spawn { program }` **只判断"有没有 Exec 能力"，不校验程序名**——这一点是刻意的分层设计（具体收窄交给引擎解析），但既然 `check()` 没有调用点（§9 第 1 项），**目前 L3 插件起子进程没有任何运行时拦截**；
- `PATH` 在 `clear_env` 之后被刻意保留（§1.4），所以 `subprocess.run(["curl", ...])` 这类调用是可行的；
- `crates/toolforge-ai/src/review.rs` 在报"未声明的 `subprocess`"时，用户可见的提示文案是「（提示：插件进程只能起它自己，起外部程序会被拒绝）」。**这句话与当前实现不符**，属于必须修正的文案缺陷（§9 第 3 项）。

**缓解（现在能做的）**：`RiskLevel::Critical` 让它在确认页最显眼；`CRITICAL_CAPABILITY` 警告；AI 审阅把 `subprocess` / `os.system` / `os.popen` 当作需要 `exec` 的模式扫描。**用户侧的唯一有效缓解是：看到 `exec` 就不要装**，除非你愿意读一遍它的全部代码。

### 3.5 `Env { names }`

```yaml
permissions:
  - kind: env
    names: ["HF_HOME"]
```

**含义**：读取**按名字白名单**指定的环境变量。设计意图（`Capability` 上的注释）：白名单"避免插件顺手把 API key 读走"。

`risk()`：**Medium**。

**攻击面与诚实边界**：

- 白名单只在**宿主进程自己**做 `ReadEnv` 时有用——它防的是"插件顺手读走 `OPENAI_API_KEY`"这一类**非蓄意**行为；
- **没有任何机制阻止插件读宿主进程之外的东西**。要读进程环境有无数条路：读 `/proc/self/environ`、读别的进程、读配置文件。所以 `Env` 这个名字容易给人错误的安全感；
- **在 L3 里真正起作用的防线是 `clear_env`，不是这个白名单。** `PythonPlugin::launch()` 设 `spec.clear_env = true`，注释是「绝不继承父进程环境（可能含 API Key）」，之后只注入 `PATH` + `TOOLFORGE_PLUGIN_ID` + `TOOLFORGE_CAPABILITIES` + `PYTHONNOUSERSITE=1`（另加 `PYTHONUNBUFFERED` 等三个由 `ChildSupervisor::spawn()` 统一注入）。**清空的环境里根本没有值可读，所以"读不到 Key"是清空环境带来的，不是 `Env` 白名单带来的。**

**当前状态**：`Env { names }` **没有任何运行时实现**。`CapabilityGuard::check()` 有 `ReadEnv` 分支，但它没被调用；也没有任何地方按 `names` 把宿主环境变量挑出来注入给插件进程。所以这个能力目前**只影响 UI 文案与风险等级**（§9 第 4 项）。

### 3.6 `Ai`

```yaml
permissions:
  - kind: ai
```

**含义**：调用大模型服务。`describe()` 是「调用 AI 服务（消耗你的额度）」。

`risk()`：**Low**。

**攻击面**：

- **额度消耗**：被循环调用刷额度是最直接的损失（L3 插件的 `timeout_ms` 只限单次调用，`workers` 上限 8，但没有总调用配额）；
- **数据外传**：把用户文件内容/路径拼进 prompt 发出去。这是 `Ai` 能力**最容易被低估**的一面——`Ai` 的风险等级是 Low，但它实际上意味着"可以把数据送出本机"（发给用户自己配置的 AI 服务商，仍然算外传）。**这一条现在不再只是"可能"**：`ai.describe` 与 `doc.ocr` 的 AI 路径**默认就会把图片上传给服务商**，完整说明见 §3.9。
- **提示词注入回流**：AI 的输出在 `ai_generate` 流程里被当成"草稿数据"处理（见 §6），但如果某个插件把 AI 输出当指令执行，就构成了注入链。

**当前状态**：

- 宿主侧的 AI 调用在命令层（`commands.rs` 的 `ai_test_connection` / `ai_generate` / `ai_review_draft`），走 `toolforge-ai` 的 `AiClient`；
- **`Ai` 能力没有运行时裁决点**：`CapabilityRequest` 枚举里根本没有对应变体（只有 `ReadFile`/`WriteFile`/`Http`/`ReadEnv`/`Spawn`），也就是说连"插件请求调用 AI"这个事件类型都还不存在（§9 第 5 项）。
  > ⚠️ **但"宿主自己调 AI"这件事已经落地，而且有两个节点会把图片发出去**（`ai.describe` 与 `doc.ocr` 的 AI 路径）。它们走的是宿主侧 `AiClient`，**不经过 `CapabilityGuard`**，也不受插件 `net` 声明约束 —— 完整的隐私说明与本地/联网对照表见 §3.9，缺口清单见 §9 第 30 项。

**缓解**：UI 文案直说"消耗你的额度"；建议把 `Ai` 当成**中风险**对待（"能外传数据"），不要因为 `risk()` 返回 Low 就降低确认强度。

### 3.7 `Gpu`

```yaml
permissions:
  - kind: gpu
```

**含义**：使用 GPU。`describe()` 是「使用 GPU」。`risk()`：**Low**。

**攻击面**：主要不是机密性而是**可用性**——占满显存、让系统卡顿、影响其它任务；在共享显存/集成显卡上尤其明显。GPU 驱动栈历史上也有提权漏洞，但那是驱动的问题，不是本项目的攻击面。

**当前状态**：**没有任何运行时实现或裁决点**（与 `Ai` 同理，`CapabilityRequest` 里没有对应变体）。而且 `ROADMAP.md` 的 Non-Goals 明确写了"不做需要 GPU 常驻的推理服务"，所以这个能力在可预见的阶段里更像是一个**声明位**（§9 第 5 项）。

### 3.8 已知缺陷：`PathScope::Explicit` 无法通过 `plugin.yaml` 表达

这是本次核对中最重要的一个"设计与实现不符"，必须单独写清楚。

**问题**：`PathScope` 是 `#[serde(tag = "kind")]` 的**内部标签**枚举，而 `Explicit` 是**带 `String` 的 newtype 变体**：

```rust
// crates/toolforge-core/src/permission.rs
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PathScope {
    Input,
    Output,
    PluginData,
    Workspace,
    Explicit(String),   // ← 逃生舱口
}
```

内部标签要求"剩下的字段"能被反序列化成变体的载荷类型。对 `Explicit(String)` 来说，剩下的内容是一个**映射**，而 `String` 只能从字符串反序列化——**这两件事无法调和**。因此：

- `scope: { kind: explicit, value: "C:/x/**" }` → 解析失败（映射无法变成字符串）；
- `scope: { kind: explicit }` → 同样失败；
- 报错形如 `invalid type: map, expected a string`（委托方的实测结论；本文档作者通过阅读代码确认了它的**结构性原因**，但**未独立运行验证**，也未在 `cargo test` 下复现）。

**核实过程的限制**：仓库里的 `.tools/scratch/` 下有上一次会话留下的探针文件（`a.yaml` 用的正是 `scope: { kind: explicit, value: "C:/x/**" }`，`d.yaml` 覆盖 `net`/`env`/`exec`/`ai`/`gpu`），`.tools/probe2/src/main.rs` 是一个最小 serde 探针程序——但它只对比了 `permissions` 的**映射形式**与**序列形式**，**没有覆盖 `explicit`**。所以仓库内没有 `Explicit` 的实测记录，本次也没有生成新的记录。

**后果（这才是要写进文档的部分）**：

因为 `Explicit` 无法从清单装载进来，`plugin.rs` 里为它准备的两段逻辑在"从清单装载"这条路径上**暂时不可达**：

1. `PluginManifest::validate()` 里的 `HOST_PATH_WRITE` 警告（"插件申请直接写宿主机路径：{glob}"）；
2. `Capability::risk()` 里 `FsRead { scope: Explicit(_) } => RiskLevel::High` 这一支。

这不是"安全漏洞"（**攻击者也不能用它**），而是"一道准备好的闸门装不上"：逃生舱口实际上是**锁死**的，任何需要访问固定系统目录（如 `%APPDATA%\SomeVendor`）的合法插件目前都做不到。

**建议的两种修法**（都还没实施，属于待定）：

- **方案 A（改动小，语义清楚）**：把 `Explicit(String)` 改成 struct 变体，让标签与字段能共存：

  ```rust
  Explicit { glob: String },
  ```

  这样 `scope: { kind: explicit, glob: "C:/x/**" }` 就能解析。代价是 `PathScope::Explicit(pattern)` 的匹配点（`describe()`、`is_sandboxed()`、`root_for()`、`resolve_explicit()`、`risk()`）都要跟着改。
- **方案 B（后来实际采用的方向）**：让 `PermissionSet` 不再 `#[serde(transparent)]`，改用显式字段 `permissions: { capabilities: [...] }`。**这一步已经落地**（见 §3.0），`Capability` / `PathScope` 的表示此后可以自由调整；代价是原先按裸数组写的示例与文档需要同步更正（`plugins/` 下 6 个 `plugin.yaml` 与 `docs/PLUGIN-SDK.md` 已完成更正并重新校验通过）。

在选定方案之前，任何文档、示例、UI 都**不应该**向用户展示 `Explicit` 的写法——因为它写出来必然解析失败。

---

### 3.9 把图片送出本机：`ai.describe` 与 `doc.ocr` 的 AI 路径（这一节必须直说）

前面 §3.6 讲 `Ai` 能力时说过一句"`Ai` 风险等级是 Low，但它实际上意味着可以把数据送出本机"。**现在这句话有了两个具体的、默认就会发生的实现入口**，所以单独开一节，把话说完整：

| 节点 | 图片去哪 | 是否联网 | 是否上传用户图片 |
| --- | --- | --- | --- |
| `ai.describe` | **上传到用户自己配置的 AI 服务商** | 是（唯一联网的地方） | **是** |
| `doc.ocr`（AI 路径） | **上传到用户自己配置的 AI 服务商** | 是 | **是** |
| `doc.ocr`（tesseract 路径） | 不出本机 | 否 | 否 |
| `image.remove-background` | **不出本机** | 否（只有首次装依赖时要联网） | 否 |
| `ai.upscale` | **不出本机** | 否（同上） | 否 |

**必须让用户知道的三件事：**

1. **这是真的外传，不是"调用了一个 API"这么轻。** `ai.describe` 会把图片**缩小并转成 JPEG**（默认最长边 1024、质量 85）后以内联 data URL 发出；`doc.ocr` 的 AI 路径同理（最长边 2048）。缩小与重编码降低了**费用与流量**，**但不改变"这张图离开了你的机器"这个事实** —— 服务端仍然看到了图片内容，而且这是用户自己选的第三方服务商，它的留存、训练与合规政策与 ToolForge 无关。
2. **它是默认行为，不是可选项。** `ai.describe` 只有这一条路（没有本地模型替代）；`doc.ocr` 的 `engine` 默认是 `auto` —— **装了 tesseract 就走本地，没装就用 AI**。也就是说"没装 tesseract 的机器上跑 OCR"会**自动**把图片发出去，用户唯一的线索是任务日志里那一句「本机没有 Tesseract，改用多模态模型识别（图片会上传给 AI 服务商）」。
3. **想完全离线，就用本地那两个节点。** `image.remove-background` 与 `ai.upscale` 的推理**全在本机**（Python 子进程 + ONNX Runtime），图片不出本机。它们仍然需要联网**一次**去拉推理依赖（`onnxruntime` / `numpy` / `pillow`，见 §9 第 29 项），以及用户自己去下模型权重 —— 但**推理过程与图片内容不上传**。这条区别很重要，因为"AI 相关"这四个字很容易让人以为它们都要联网。

**诚实补一句边界**：这条外传**不经过任何权限门**。`ai.describe` / `doc.ocr` 是**内置节点**，它们在宿主进程里发起 HTTP 请求，所以：

- 插件清单里的 `net` 能力**管不到它们** —— 那是给 L2/L3 插件用的；
- `CapabilityGuard` 的 `Http` 分支**没有调用点**（§9 第 2 项），所以"宿主代插件发 HTTP"这件事目前既没有白名单强制，也没有按 `hosts` 校验；
- 唯一真正起作用的是**用户自己在「设置 → AI」里配的那个服务商地址** —— 也就是说，**地址是用户选的，ToolForge 不代理、也不转存**，但它确实不会在发送前再问一次。

> ⚠️ **别把内置插件的"不申请 net 权限"读成"这个操作不联网"**。`plugins/builtin/ai-describe/plugin.yaml` 的注释写得很准确：「插件本身**不申请** net 能力：联网发生在宿主的节点里，不在插件进程里。」它不申请 net 是**对**的（插件进程确实没联网），但这不代表图片没被发出去。

**关于测试**：验收脚本里有一条 AI 视觉链路检查（`verify-platform.mjs` 的【10】），它**不调用任何真实服务商**，而是起一个**假 OpenAI 兼容端点**（`scripts/devtools/mock-openai.mjs`）并把应用的 AI 设置**临时**指过去。这个假端点收到的是**脚本自己生成的一张合成 PNG**（240×180），跑完即被丢弃；**它永远不会看到任何真实用户图片**。这也是"不去用真模型验证"的原因之一 —— 除了要花钱、结果不可复现之外，**自动化测试本来就不该把用户的文件发到第三方**。脚本在 `finally` 里会把用户的 AI 设置**原样恢复**（否则用户的配置会被指向一个已经关掉的假端点）。

---

## 4. 路径穿越防护

### 4.1 原理

`crates/toolforge-core/src/permission.rs` 的 `PathResolver::resolve(scope, rel)` 依次做三件事：

1. ~~**拒绝绝对路径**：`Path::new(rel).is_absolute()` 为真 → `PermissionDenied`。设计前提是"插件只能用逻辑作用域，不能自己指定宿主机位置"。~~
   > ⛔ **这条规则曾是发布级 bug，已改正。** 它自相矛盾：`l1.rs` 把 `${src}` / `${output.dst}` 绑定成**真实的绝对路径**（那就是用户选中的文件），而 `resolve()` 又一律拒绝绝对路径 —— 于是**任何一次真实转换都会以 `PermissionDenied`「插件不允许使用绝对路径」失败**。
   >
   > 现在**绝对路径与相对路径走同一条检查**，唯一判据是"最终路径是否落在授权根内"（两侧都先做词法规范化）。这没有削弱安全性：挡住穿越的从来是 `starts_with`，不是"必须相对"这个代理规则。
   >
   > 它是靠**真跑一次应用、提交一个真实任务**才暴露的 —— 196 个单元测试与 6 个集成测试全都没抓到（没有一个测试走过"用户选中的绝对路径 → 流水线 → 节点"这条真实数据流）。回归测试：`absolute_path_inside_root_is_allowed`、`dotted_and_trailing_separator_roots_compare_correctly`。
2. **拼接 + 词法规范化**：`root.join(rel)` 之后走 `normalize_lexically()`，逐组件展开：`.` 丢弃；`..` **只在栈顶是一个真正的目录名（`Component::Normal`）时才回退**，否则继续累积 `..`。
3. **边界判定**：`!normalized.starts_with(root)` → 拒绝，`detail` 里同时给出"授权根目录"与"实际解析"两条路径，便于用户判断是插件写错了还是有人在试探。

`starts_with` 是**按路径组件**比较的，不是字符串前缀比较——所以授权根 `/srv/input` 不会误放行 `/srv/input-evil`。这一点值得记下来，它避免了一类经典的前缀匹配漏洞。

若该作用域的根目录尚未由宿主分配，`resolve()` 返回 `ErrorCode::Internal`，并在文案里明确「这是宿主 bug，不是插件问题」（单元测试 `unassigned_scope_is_host_bug_not_plugin_fault` 锁定这条）。

#### ⚠️ 曾经的致命实现缺陷：`pop()` 会把两个 `..` 互相抵消

第 2 步最初写的是：

```rust
// ❌ 错误实现
Component::ParentDir => { if !out.pop() { out.push("..") } }
```

当栈顶是**我们自己刚压进去的 `..`** 时，`PathBuf::pop()` 依然返回 `true`。
于是 `../../evil` 被规范化成 `evil` —— 两个 `..` 互相抵消了，**路径穿越检查被静默拆掉**。

影响面：

* `PathResolver::resolve` 对**相对路径**的检查失效；
* `toolforge-plugins::store::safe_relative_path`（AI 生成的 Bundle 落盘路径校验）**完全失效**。

它此前没有暴露，是因为 `resolve()` 是把 `rel` 拼到绝对根目录**之后**才规范化的，
根目录会先吸收掉 `..`；真正漏掉的是"比根目录层级更深的 `..`"和"纯相对路径"两条路径。

现在由两个测试锁死：`dotdot_is_never_cancelled`（语义正确性）与
`excessive_traversal_from_input_root_is_rejected`（比根更深的 `..` 必须被拒）。

**教训**：路径规范化是安全边界，**不能靠直觉写**。任何"消除 `..`"的代码
都必须回答一个问题——"如果消不掉，是保留它还是丢掉它？"
正确行为永远是**保留**（然后让边界判定去拒绝），而"抵消"是灾难。

### 4.2 为什么用词法规范化而不是 `canonicalize()`

`normalize_lexically()` 的文档注释给出了第一条理由：

> 这也是为什么不用 `canonicalize()`：输出目录里的文件在写入前根本不存在，
> `canonicalize` 会直接失败。

完整的三条理由是：

1. **对不存在的路径也有效**。输出文件在写入前不存在，`canonicalize()` 会返回错误——而这个错误又不是"越权"，只是"文件还没建"，用它做安全判定会导致正常的第一次写入被拒；
2. **不跟随符号链接**。`canonicalize()` 会解析 symlink，攻击者只要在授权根目录内放一个指向外部的链接，`canonicalize` 的结果就一定在根目录之外——真实的实现里这会变成"要么全部拒绝、要么被迫接受已解析的越界路径"；
3. **结果确定、不访问文件系统**。纯字符串/组件运算，没有 I/O、没有竞态（TOCTOU 的时间窗被压缩到后续真正的 `open` 那一步），也因此可以被单元测试穷举。

### 4.3 正例与反例

`permission.rs` 的单元测试就是最权威的用例集：

| 输入（`scope = Input`，根 = `/srv/input`） | 结果 |
| --- | --- |
| `a/b.png` | ✅ 放行 |
| `a/../b/c.png` | ✅ 放行（绕了一圈但仍在根内，属于合法写法，`nested_traversal_that_stays_inside_is_allowed`） |
| `../../../etc/passwd` | ⛔ `PermissionDenied`（`path_traversal_is_blocked`） |
| `C:\Windows\System32` | ⛔ `PermissionDenied`（绝对路径，同上测试） |

### 4.4 局限（必须诚实写出来）

词法规范化**挡不住**下面这些东西，它们都是真实的绕过方向，只是当前都还没有对应的缓解代码：

1. **符号链接**。若攻击者能在授权根目录内创建一个指向外部的 symlink（例如插件自己先写一个链接，或者用户此前留下的链接），那么 `root/evil` 在词法上是"根目录内的路径"，`starts_with` 会放行，而内核在 `open` 时会跟随链接走到外面。`normalize_lexically()` **不访问文件系统，因此永远看不到链接**；
2. **Windows 8.3 短名**。`PROGRA~1` 之类的别名可能让"看起来在根内"的路径指向别处；
3. **UNC 路径**（`\\server\share\...`）与设备路径（`\\.\PhysicalDrive0`）；
4. **TOCTOU**：校验与真正的 `open` 之间存在时间窗，链接可在其间被替换。

加固方向（**属路线图，尚未实现**）：改用 `openat` 语义（相对已打开的目录 fd 解析）、`O_NOFOLLOW`、逐级校验每一层组件、Windows 上用 `CreateFile` 的 `FILE_FLAG_OPEN_REPARSE_POINT` 并拒绝 reparse point。

**一条"间接成立"的补充结论**：`resolve()` 只显式拒绝 `is_absolute()` 的路径，没有像 `store.rs` 的 `safe_relative_path()` 那样显式检查 Windows 盘符前缀（`C:foo`）与根目录。看起来仍会被拦住——因为 `PathBuf::join`/`push` 在遇到"有前缀无根"或"有根无前缀"的路径时会**替换**整段，结果落在 `root` 之外，于是被 `starts_with` 判否。但这条推理依赖标准库的替换语义，属于**阅读推导而非实测**，建议对齐 `safe_relative_path()` 补一条显式检查，降低对库语义的依赖。**待定**。

### 4.5 `sanitize_id()`：目录名拼接的最后一道防线 ✅ 缺陷已修复（原文保留为历史）

`crates/toolforge-core/src/paths.rs` 的 `sanitize_id()` 用途是把任意 ID 清洗成安全的目录名，被 `plugin_dir()` / `engine_dir()` / `model_dir()` / `job_workspace()` 使用。它自己的注释说明了定位：

> 虽然插件 ID 在校验阶段已经限制过字符集，但**目录名拼接是最后一道防线**：任何时候把外部输入拼进路径都必须再过一次，防止 `..` 或分隔符漏网。

**现在的实现是三步**：非 `[A-Za-z0-9.\-_]` 的字符替换成 `_` → **把连续的点折叠成单个点**（`..` 结构上不再可能出现）→ 去掉首尾的点，空串回落成 `"unnamed"`。单元测试 `sanitize_blocks_traversal` 现在断言的是**不变量**（不含 `..`、不含 `/`、不含 `\`、非空），并新增 `sanitize_never_leaves_dotdot` 作为回归测试。

**曾经的缺陷（`ROADMAP.md` 阻塞 4，现已修复）**：实现**先替换、再去点**，所以 `../../etc/passwd` 返回 `_.._etc_passwd`（`/` 先变成 `_`，于是 `..` 不再位于字符串首部，`trim_matches('.')` 去不掉它），而测试期望的是 `etc_passwd`。

| 输入 | 当时返回 | 当时测试断言 | 当时结论 |
| --- | --- | --- | --- |
| `../../etc/passwd` | `_.._etc_passwd` | `etc_passwd` | ❌ 测试会失败 |
| `..` | `unnamed` | `unnamed` | ✅ |
| `""` | `unnamed` | `unnamed` | ✅ |
| `a/b\c` | `a_b_c` | `a_b_c` | ✅ |

**严重性判断（当时就不该夸大，现在也一样）**：`_.._etc_passwd` 里的 `..` 是**同一个路径组件的一部分**（它前后是 `_` 与 `e`，没有分隔符），所以它**不是**可穿越的路径。`sanitize_id` 把 `/` 与 `\` 都换成了 `_`，因此它**没有**给出目录穿越能力。所以那始终是**"实现与自己声明的意图/测试不一致"**的缺陷，而不是一个可立即利用的漏洞。同时 `paths.rs` 的 `plugin_data_stays_inside_plugin_dir` 断言了 `!dir.to_string_lossy().contains("..")`——现在实现满足它了。

**修法的落点**（`ROADMAP.md` 阻塞 4）：不是放宽测试，而是**改实现**（折叠点、去首尾点、空串回落），并**先补齐边界用例**（`..`、`....//`、`..\..\`、绝对路径、空串、纯空白）。方向选对了，因为这是路径收敛的边界 —— 边界上的断言该收紧，不该放松。

> **严重性判断（当时就不该夸大，现在也一样）**：`_.._etc_passwd` 里的 `..` 是**同一个路径组件的一部分**（它前后是 `_` 与 `e`，没有分隔符），所以它**不是**可穿越的路径。`sanitize_id` 把 `/` 与 `\` 都换成了 `_`，因此它**没有**给出目录穿越能力。所以那始终是**"实现与自己声明的意图/测试不一致"**的缺陷，而不是一个可立即利用的漏洞。同时 `paths.rs` 的 `plugin_data_stays_inside_plugin_dir` 断言 `!dir.to_string_lossy().contains("..")`，对 `../../evil` 得到的 `_.._evil` 同样会失败——那条断言比必要强度更严（**现在实现已经满足它**）。

> **修法选的是"改实现"，不是"放宽容忍度"**：折叠连续的点（`..` 结构上不可能出现）→ 去掉首尾的点 → 空串回落 `unnamed`，并**先补齐边界用例**（`..`、`....//`、`..\..\`、绝对路径、空串、纯空白）。之所以该这样选：这是路径收敛的边界，**边界上的断言该收紧，不该放松**。

### 4.6 虚拟前缀

内置节点的路径解析在 `crates/toolforge-engines/src/nodes.rs` 的 `resolve_path(ctx, scope_kind, p)`：它先把 `scope_kind` 映射成 `PathScope`（`input` → `Input`、`output` → `Output`、`data` → `PluginData`、其它一律 `Workspace`），**剥掉** `/input/`、`/output/`、`/work/`、`/data/` 这四个虚拟前缀，再把剩下的部分交给 `PathResolver::resolve()`。

对应的"逻辑视图"由 `PathResolver::logical_view()` 定义：`Input → /input`、`Output → /output`、`PluginData → /data`、`Workspace → /work`。Python/WASM 插件看到的 `paths.input` 就是这些虚拟路径，插件**永远不知道真实盘符**——但注意 `PluginRunner::ensure_loaded()` 往 `plugin_paths` 里塞的 JSON 中，`data` 一项是**真实路径**（`self.paths.plugin_data(&id).display().to_string()`），而 `input`/`output`/`work` 是虚拟路径。这是同一份契约里的不一致，属**待定**项（§9 第 21 项）。

**要点**：剥前缀只是"写法便利"，安全判定完全依赖随后的 `PathResolver`。剥完之后的字符串仍然会经过绝对路径拒绝与 `starts_with` 检查，所以 `/input/../../etc/passwd` 与直接写 `../../etc/passwd` 得到同样的结果（被拒）。

### 4.7 输入根是怎么算出来的（授权范围的大小由这里决定）

授权根不是插件决定的，是**命令层算出来**的：`commands.rs::build_io` 取**该批次**所有输入文件的公共父目录作为 `input_root`。这里有过一个**授权过宽**的问题：

- **旧行为**：输入本身就是目录时（`PortType::Directory` 的端口），根会退化成那个目录的**父级** —— 用户选 `D:\照片`，插件实际拿到的是 `D:\` 的读取授权。这不是漏洞利用，但等于**白送一整层目录**；
- **现行为**：目录输入用**目录自身**作根（`if path.is_dir() { path.clone() } else { path.parent() }`）。

配套的**目录展开**（`commands.rs::expand_dir` + `expand_batches`）也按"收紧 + 可预期"来设计：

- **只展开一层**，不递归（递归会让"拖了个文件夹"变成"翻遍整个照片库"）。展开之后 `input_root` 正好是用户选中那个目录本身；
- 只收普通文件，**跳过符号链接、设备文件与 `.` 开头的隐藏文件**（含 macOS 的 `._` 资源叉）。跳过 symlink 是顺带的收益：目录里的链接不会被当作输入文件送进流水线；
- 结果**排序**（枚举顺序在文件系统之间没有保证，不排序则 `${batch.index}` 每次不同）；
- **硬上限 `MAX_DIR_EXPANSION = 5000`，超了直接报错**（`INVALID_ARGUMENT`，detail 提示"请分批拖入，或者先按子目录拆开"）。这是**可用性护栏**：一个含几万张图的目录会瞬间造出几万个批次，把队列与界面一起拖垮。**刻意不静默截断** —— 静默截断等于让用户以为"全处理完了"，这正是本项目最不能接受的那类缺陷（对照 §9 第 24 项的思路）。

---

## 5. 前端永远拿不到裸 shell

### 5.1 设计约束

**约束本身**（这是必须成立的，无论当前实现进度如何）：

1. 前端只能通过 **IPC 命令**间接触发任务，**不允许**直接执行任意命令；
2. `tauri-plugin-shell` 的 capability 只应放行**白名单**的程序，不允许通配；
3. `Capability::Exec` 只给"宿主内部、按引擎 id 解析出来的固定可执行文件"，**不把用户/插件给的字符串当程序名**；
4. 前端不得暴露"可以传任意命令名"的 `invoke` 透传封装。

### 5.2 当前实际配置（与约束的偏差）

`apps/desktop/src-tauri/capabilities/default.json` 是当前唯一的能力配置。它**总体上收得很紧**（只放行 `core:*` 的窗口/事件最小集合 + `log` / `dialog` / `opener` / `store` / `fs`；**`shell` 零权限**），值得记下来的正面事实：

> ✅ **这份"说的"与"做的"现在有运行时对账了（本轮新增）**：`verify-platform.mjs`【26】从**页面上下文**里真的去调那些命令，并按错误文本分类 ——
> `not allowed. Permissions associated with this command` = ACL 拒绝、`forbidden path` = scope 拒绝、
> `invalid args` = 权限**在**（参数不对，所以不会真弹对话框、真写文件）。
> 断言共 7 条：① `shell|execute` 被拒 ①b `shell|open` 被拒 ② `opener|open_path` 被拒
> ③ scope 外的 `fs:read_text_file` 被拒 ④ **正向对照**：scope 内的读**真的能成**（否则"全都被拒"也会让前三条通过）
> ⑤ 界面真正在用的 5 个命令权限都在（`reveal_item_in_dir` / `open_url` / `dialog|open` / `dialog|save` / `fs|write_text_file`）
> ⑥ 静态对照：capability 文件里一条 `shell:` 都没有。
>
> ⚠️ **文档曾经错过一次**：README 里写着「`shell:allow-execute` 只放行一个用于"打开文件夹"的 `explorer`」，而配置里**根本没有 shell 权限**（真实边界比文档更紧，但文档仍然写错了）。"打开文件夹"走的是 `opener:reveal_item_in_dir`。已改正。
>
> ⚠️ **同时修掉一个"以为能用其实不能用"的 helper**：`src/lib/system.ts` 里的 `openWithDefaultApp()` 包着 `openPath`，而 `opener:allow-open-path` **没有授予**（②的运行时断言就是盯着它）。那个函数**从未被任何界面调用过**，一旦有人接上就会静默失败 —— 已删掉，并在文件头写清"将来要做这个功能，得先有意地加权限并配 scope"。

- `tauri.conf.json` 里 `app.withGlobalTauri: false`，所以页面里**没有** `window.__TAURI__` 全局对象；
- CSP 很严：`default-src 'self'`、`script-src 'self'`、`frame-src 'none'`、`object-src 'none'`、`base-uri 'self'`、`form-action 'none'`、`connect-src 'self' ipc: http://ipc.localhost`，另有 `freezePrototype: true`。这显著降低了"前端被注入脚本后去调 IPC"的风险等级；
- `assetProtocol.scope` 与 `fs:scope` 都限定在用户目录（`$APPDATA` / `$DOWNLOAD` / `$PICTURE` / … / `$TEMP`），没有通配整个盘。

**关于 shell 的三条约束，当前状态是全部满足的**：

1. ~~shell 放行的是 `explorer` + `args: true`~~ → ✅ **已移除**。`capabilities/default.json`
   里现在**没有任何 `shell:allow-execute` 条目**，连 `shell:allow-open` 都没有。
   需要"在文件管理器里显示文件"时用 `opener` 插件的 `revealItemInDir()`。
   这样做的理由很直接：`shell:allow-execute` 的 scope 项形如 `{ name, cmd, args }`，
   而 `args: true` 意味着**任意参数** —— 对一个能启动 `explorer.exe` 的入口来说，
   `explorer <某个.exe>` 就是一条完整的任意程序执行路径。前端（以及将来可能注入的
   插件 UI）拿到它，整个权限模型都成了摆设。移除比"收窄参数"更干净：
   我们根本不需要这个能力。
2. **白名单里没有 `sidecar: true` 的引擎二进制条目**（`bundle.externalBin` 目前也是空数组）
   —— 这是**当前状态的如实描述**，不是缺陷：所有引擎调用都走 Rust 命令层经
   `toolforge-process` 起进程，前端不参与。
3. `lib.rs` 里那句「只被允许执行白名单 sidecar」的注释**曾经与配置不符**（配置里是
   `explorer`），现已改写成与配置一致的说明。

2. **前端直接持有文件系统文本读写能力**：`fs:default` + `fs:allow-read-text-file` + `fs:allow-write-text-file` + `fs:allow-exists`，scope 覆盖 `$DOWNLOAD/**`、`$DESKTOP/**`、`$DOCUMENT/**`、`$TEMP/**` 等。也就是说**前端不经过 Rust 命令层也能读写这些目录里的文本文件**。这与"前端只能通过 IPC 命令间接触发任务"的表述不完全一致（§9 第 12 项）。

顺便指出：`apps/desktop/src-tauri/src/lib.rs` 的注释里写着「特别是 shell —— 它只被允许执行白名单 sidecar，前端拿不到任意命令执行」，这句**曾经与配置不符**（配置里一度是 `explorer`）。
> ✅ **现在两边都对得上了**：`lib.rs` 那段注释已经改写成「`shell` 插件被注册，但**没有授予任何 execute 权限**……但**零权限**意味着前端调不动它」，而配置里确实一条 `shell:` 都没有 —— 【26】的 ① / ⑥ 就是钉住这件事的（一个跑运行时、一个读配置文件）。

### 5.3 现状标注与落地验收条件

**现状**：与"`src/` 目录还不存在、主程序未写"的旧描述不同，外壳代码**已经存在**：`src/commands.rs`（**32** 个命令）、`src/ipc.rs`、`src/state.rs`、`src/lib.rs`、`src/main.rs`、`src/bin/export_bindings.rs`。命令层本身的设计纪律是好的——`commands.rs` 的模块文档写着「命令只做编排」「耗时操作一律异步化」「前端拿不到裸 shell」「AI 的产出永远只是草稿」，且 `COMMAND_NAMES` 与 `collect_commands!` 之间**有逐条对齐的守卫**。
> ⚠️ 这里原先写的是「`lib.rs` 用 `debug_assert_eq!(COMMAND_NAMES.len(), 28)` 做数量一致性自检」——**那条断言已经被删掉了**（当时数字还写成 28，实际早已是 32）：它比的是两处各自维护的常量，忘了同步就会让 debug 构建**在启动时 panic**。真正管这件事的是 `src/bin/export_bindings.rs` 的守卫 2——它按名字逐个核对 `COMMAND_NAMES` 里的每一条都出现在生成的绑定里、且注册数一致，随 `pnpm bindings` 执行。

因此本节的状态应标注为：**设计约束已写进代码与注释，能力配置已存在但需要收窄**；下面这些验收条件应在 v0.1/v0.2 阶段被实际检查。

**落地时必须满足的验收条件**：

1. `tauri.conf.json` 与 `capabilities/*.json` 里**不得**出现"允许任意命令"的权限配置（例如裸的 `shell:allow-execute` 无 `allow` 列表、`args: true` 用于非固定参数场景、或任何通配形式的命令名）；
2. 需要执行引擎二进制时，使用 `sidecar: true` + **显式白名单**（每个引擎一条），并在 `bundle.externalBin` 里登记；
3. 前端的 `invoke` 封装**不得**接受"命令名"作为参数透传（即不允许 `invoke(cmdName, args)` 这种形态），命令名必须是字面量；
4. `fs` 能力逐条评估：前端确实需要直接读写文件的场景应收窄到最小目录，其余一律走 Rust 命令层；
5. `AssetProtocol` 的 scope 与 `fs:scope` 保持一致且都指向用户目录，不得出现 `**` 根通配；
6. 单测/CI 里加一条"配置断言"：解析 `capabilities/*.json`，若出现 `shell:allow-execute` 且 `args !== false`（或 allow 列表为空）则失败。
   > ✅ **已落地（本轮）**：`verify-platform.mjs`【26】同时做了**两件事** ——
   > **运行时**从页面里调 `plugin:shell|execute` / `plugin:shell|open` 并断言被 ACL 拒绝（`shell.execute not allowed. Permissions associated with this command: shell:allow-execute` 这种文本就是判据），
   > **静态**读 `capabilities/default.json` 断言里面一条 `shell:` 都没有。
   > 两条一起看才严密：只做静态的话，"插件没注册"与"权限没给"区分不开；只做运行时的话，一个被重新生成过的配置文件可能悄悄多回一条权限而没人发现。

### 5.4 两条与"具体收窄"有关的注意事项

这两点是**刻意的分层设计**，不是疏漏；但它们意味着"单靠 `CapabilityGuard` 不足以兜住路径"，必须写下来：

1. **`CapabilityGuard::check()` 对 `Spawn { program }` 只判断"有没有 Exec 能力"，不校验程序名**。设计意图是把"具体能起哪个程序"交给引擎解析（宿主按引擎 id 解析出固定可执行文件）——但前提是有一条真正走引擎解析的调用路径，而不是把用户/插件给的字符串直接当程序名。
2. **`needs_fs()` 只判断"集合里存在任意一个 `FsRead` / `FsWrite`"，不比对具体 scope 值**。注释写明了后续补充：「真正落到具体路径时还要再过 `PathResolver`」。所以：

```
CapabilityGuard  ⇒  回答"有没有这类能力"
PathResolver     ⇒  回答"这个具体路径行不行"
```

**只做前者不做后者，就等于放行整个文件系统。** 任何新增的文件访问代码路径都必须同时经过 `PathResolver`。

---

## 6. AI 插件生成的安全流程

### 6.1 流水线（设计规格）

```
生成（自然语言 → 草稿）
  → 静态校验（PluginManifest::validate()，纯函数）
  → 安全审核（review_draft()：能力风险定级 + 可疑模式扫描 + 运行时选择合理性）
  → 权限差异检测（PermissionSet::is_subset_of / diff_capabilities：扩权必须重新确认）
  → 人工 diff 审阅（AiProvenance.reviewed_at）
  → 落盘（PluginSource::Bundle，路径不允许 .. 与绝对路径）
  → 哈希锁定（内容哈希；装载前校验，不匹配报 IntegrityCheckFailed）
```

逐步说明与**当前的接线状态**：

**① 生成**：`commands.rs` 的 `ai_generate()` 组装 system prompt + user prompt 调 `AiClient::complete()`，然后用 `toolforge_ai::parse_model_output()` 解析成 `Vec<DraftFile>`。返回类型是 `AiGenerateResponse`，里面的 `AiDraft` 是一个**纯内存类型**——`crates/toolforge-ai/src/review.rs` 的注释专门解释了这一点：它**没有任何写盘能力**，要落盘必须显式转成 `PluginSource`，而那个转换发生在外壳层、在用户点了"安装"之后。这条类型设计是"即使模型被提示词注入攻陷，它也只能产出用户看得见的一份草稿"的实现手段。**已实现。**

**② 静态校验**：`PluginManifest::validate()`（`crates/toolforge-core/src/plugin.rs`）是**纯函数**——文档原话：

> 这个函数是**纯的**（不碰磁盘、不联网），因此可以被 AI 生成流程在写盘之前调用 —— 这是"先校验再落盘"的关键：AI 的产出必须过这一关才有机会被用户看到。

它产出的校验码包括（`ValidationIssue::code`）：`API_VERSION_MISMATCH`、`KIND_INVALID`、`ID_EMPTY`、`ID_FORMAT`、`NAME_EMPTY`、`VERSION_INVALID`、`IO_DUPLICATE_ID`、`IO_EMPTY_ID`、`PARAM_DUPLICATE_ID`、`ENUM_WITHOUT_OPTIONS`、`PARAM_RANGE_INVERTED`、`PARAM_DEFAULT_TYPE`（警告）、`PYTHON_NET_WITHOUT_PERMISSION`（**错误**）、`CRITICAL_CAPABILITY`（警告）、`HOST_PATH_WRITE`（警告，见 §3.8）、`WASM_PATH_EMPTY`、`WASM_EXT`（警告）、`WASM_MEMORY_RANGE`、`WASM_TIMEOUT`、`WASM_HOST_FN_UNKNOWN`、`WASM_WITH_PERMISSIONS`（警告）、`PY_ENTRY_EMPTY`、`PY_ENTRY_EXT`（警告）、`PY_REQ_EMPTY`、`PY_REQ_UNSAFE`、`PY_WORKERS_RANGE`。其中 `PY_REQ_UNSAFE` 专门拦"URL / VCS / 本地路径"形式的依赖（`://`、`-` 开头、` @ `），理由是禁止从任意来源拉代码。另有流水线自身的校验码（由 `PipelineDef::validate_into()` 产出，例如 `STEP_UNKNOWN_NODE`）。**已实现。**

**③ 安全审核**：`review_draft()` 在清单之上再做一层——不执行任何代码、不写盘。产物 `SecurityReview` 会原封不动显示在"安装"确认页上。它的定位写得很清楚：**审核通过 ≠ 可以安装**，真正的门是用户逐条勾选权限。`scan_code()` 的扫描表包括 `subprocess` / `os.system` / `os.popen`（需 Exec）、`eval(` / `exec(` / `__import__` / `globals()` / `getattr(`（**需要 Code，而 Code 永远判定为"未声明"**——因为动态代码执行没有任何清单能力能覆盖）、`socket` / `requests.` / `urllib` / `httpx`（需 Net）、`open(` / `pathlib` / `shutil` / `os.remove` / `os.rmdir`（需 Fs）。判定策略是"**宁可误报**"（误报的代价是用户多点一次确认，漏报的代价是后门）。另外它还会为 L1 运行时配了代码文件报 `CODE_WITH_L1_RUNTIME`（Critical）、为 WASM 运行时声明媒体输入报 `WASM_MEDIA_INPUT`（High）。**已实现。**

**④ 权限差异检测**：`PermissionSet::is_subset_of()` 是判定核心：

```rust
pub fn is_subset_of(&self, other: &PermissionSet) -> bool
```

**判定规则**：`new.is_subset_of(&old) == false` 时（即新版本声明了旧版本没有的能力），**必须重新走授权流程**。落地形态有两处：

- `store.rs` 的 `finish_install()` 用 `diff_capabilities()` 算出 `(added, removed)`，`added` 非空就记一条 `AuditEventKind::PrivilegeEscalation`，并把它放进 `InstallReport::added_capabilities`（前端确认页展示"新增能力"）；
- 安装/升级后状态一律重置为 `enabled: false` + `granted: 空`（`finish_install()`），所以**扩权的旧插件也必须重新授权**——这比"只对新增项重新确认"更严格，也更安全。单元测试 `reinstall_detects_privilege_escalation` 锁定这条。

**已实现。**

**⑤ 人工 diff 审阅**：设计上由 `AiProvenance.reviewed_at`（ISO-8601 字符串）承载，`PluginSummary::reviewed` 由 `ai.reviewed_at.is_some()` 派生（手写插件没有 `ai` 字段时默认 `true`）。**注意**：这个字段目前**没有任何写入方**（全仓库只出现在定义与读取处），也就是说宿主还没有"记录人工审阅时间"的代码路径。当前真正发生的"人工审阅"是前端拿到草稿后由用户确认，再调 `plugins_install`（其 `detail` 里明确要求 L3 必须 `executable_code_acknowledged`）。所以这一环应标注为 **规格说明 + 部分实现（由 UI 流程承担，但未落成溯源字段）**。

**⑥ 落盘**：AI 产物走 `PluginSource::Bundle`。`store.rs` 的模块文档指出这是**唯一一个"外部数据决定磁盘写入位置"的地方**，所以检查做得最全：

1. `safe_relative_path()`：拒绝绝对路径、拒绝盘符前缀（`raw.as_bytes()[1] == b':'`）、拒绝规范化后仍含 `..`、拒绝首组件不是 `Normal`（空路径/根）、Windows 上还拒绝保留设备名（`CON`/`PRN`/`AUX`/`NUL`/`COM1..COM4`/`LPT1..LPT3`）；
2. 体积上限：单文件 1 MB（`MAX_BUNDLE_FILE_BYTES`）、整包 8 MB（`MAX_BUNDLE_TOTAL_BYTES`），超限即中止并清理已建目录；
3. 已存在的插件目录默认**不覆盖**，除非 `overwrite = true`（升级要显式确认）；
4. 覆盖安装时先 `remove_dir_all` 再重建，注释理由是「避免旧版本残留文件造成"幽灵代码"」。
5. L2/L3 必须自带入口产物（`runtime.requires_artifact()`），否则 `PluginInvalid`。

`PluginSource` 的三个变体在实现上也体现了同样的思路：`Directory { path }`、`Manifest { yaml }`、`Bundle { yaml, files }`。**已实现。**

**⑦ 哈希锁定**：这里需要更正一处容易混淆的说法。设计文档里写的是 `AiProvenance.source_hash`（`sha256:...`，"装载前校验，防止装载后被替换"），但**这个字段同样没有任何写入方**。真正生效的完整性锁是 `PluginState::installed_hash`：

- 安装时 `content_hash(dir)` 写入 `state.installed_hash`（`content_hash` 在 `crates/toolforge-plugins/src/audit.rs`）；
- 装载前 `PluginRunner::ensure_loaded()` 重新计算并比对，不一致就 `record_integrity()` 记审计并返回 `ErrorCode::IntegrityCheckFailed`（"插件 `{id}` 的内容在装载前已被改动，拒绝执行"）；
- 运行插件前的 `PluginStore::quarantine_if_changed()` 更进一步：不一致时记审计、**自动禁用**、通过 `AppEvent::security("critical", ...)` 推事件提示"如果这不是你自己改的，请卸载后重新安装"，最后返回 `IntegrityCheckFailed`。

`content_hash` 的规则值得记下：只对**代码与清单**哈希，跳过 `.data/`、`.venv/`、`__pycache__/`、`node_modules/`、`.git` 目录以及 `.pyc`/`.pyo`/`.log`/`.tmp`；**路径参与哈希**（所以"把 `a.py` 改名成 `b.py`"也会被检出）；按相对路径排序以保证与文件系统枚举顺序无关。`.toolforge-state.json` 本身也不参与哈希（否则授权一次哈希就变了）。**已实现。**

### 6.2 "宿主不会因为 `reviewedAt` 有值就自动放行"

`plugin.rs` 的 `AiProvenance` 文档注释原文（已核实）：

> 记录"这个插件是 AI 生成的"，以及人工审核的状态。
>
> 宿主**不会**因为 `reviewedAt` 有值就自动放行 —— 放行的唯一依据是用户授予的 [`PermissionSet`]。这里只是审计线索。

这条是**整个 AI 流程的安全地基**：审阅时间戳、模型名、prompt 都只是**审计线索**，不是权限。任何"审核过了就免确认"的改动都会推翻它。

### 6.3 当前落地状态总表

| 环节 | 状态 |
| --- | --- |
| 生成（`crates/toolforge-ai` 的 `provider.rs` / `lib.rs`、外壳的 `ai_generate`） | **已实现**（`crates/toolforge-ai` **已存在**，与早先"还不存在"的说法不同） |
| 静态校验 `PluginManifest::validate()` | **已实现**（纯函数，写盘前可调用） |
| 安全审核 `review_draft()` | **已实现** |
| 权限差异检测 `is_subset_of` / `diff_capabilities` | **已实现** |
| 人工审阅落成 `AiProvenance.reviewed_at` | **未实现**（字段无写入方，审阅实际由 UI 流程承担） |
| 落盘 `PluginSource::Bundle` + 路径校验 + 体积上限 | **已实现** |
| 哈希锁定 `AiProvenance.source_hash` | **未实现**；等价能力由 `PluginState.installed_hash` + `content_hash()` 承担（**已实现**） |
| 审计 `AiDraftAccepted` / `AiDraftRejected` 事件 | **未实现**（枚举里有这两个变体，但没有任何写入方；`ai_generate` 也不写审计） |

---

## 7. 审计日志

### 7.1 为什么必须有，以及写在哪

`crates/toolforge-plugins/src/audit.rs` 的模块文档把动机说得很准：

> 因为最危险的情况不是"插件被拒绝"，而是"插件**做了**某件用户没意识到的事"。

没有审计日志，用户在事后无法回答三个问题：我什么时候授权了这个插件读我的整个 D 盘？这个插件的哪个版本开始多要了 `exec` 权限？昨天有没有插件尝试越权、被拦住了吗？

**位置**：`AppPaths::audit()` → `<data_root>/audit`（`crates/toolforge-core/src/paths.rs`）。文件名是 `audit-YYYY-MM-DD.ndjson`（`AuditLog::current_file()`，日期用 UTC，由 `chrono_day()` / `civil_from_days()` 手算，不引 chrono）。`AppPaths::describe()` 会把"审计日志"这一条展示给前端，`commands.rs` 的 `plugins_list()` 也会把 `audit_dir` 一起返回。

**格式**：NDJSON（每行一个 JSON 对象）。理由：「追加写不会破坏已有内容」，且可以直接用 `Select-String` / `jq` 过滤。

**落点约定**：`error.rs` 里 `ErrorCode::PluginCapabilityViolation` 的注释是「插件使用了未声明的能力（**安全事件，会被审计记录**）」，`ToolforgeError::violation()` 的注释是「插件越权。这是**安全事件**：调用方必须同时写审计日志。」`permission.rs` 的 `CapabilityGuard::check()` 注释同样要求"返回 Deny 就一定要向上冒泡成 `PluginCapabilityViolation`，由调用方同时写审计日志"。**这条约定目前依赖调用方自觉**——因为 `check()` 没有调用点，也就没有地方在强制它（§9 第 1 项）。

### 7.2 `AuditEventKind` 全部变体与记录内容

事件结构（`AuditEvent`）：`at`（ISO-8601，由 `job::now_iso()` 产生）、`kind`、`subject`（相关插件/引擎/请求标识，可选）、`summary`（人类可读摘要）、`detail`（结构化补充信息，可选）。`.detail` / `.subject` 都是构建器方法。

| 变体 | 注释里的语义 | 是否有写入方 | 记录了哪些字段 |
| --- | --- | --- | --- |
| `Installed` | 插件被安装 | ✅ | `store.rs::finish_install`：summary 含名称/版本/文件数/哈希，detail 含 `files[]`、`hash`、`runtime`、`aiGenerated`；`runtimes.rs::ensure_loaded`：装载 L2/L3 时记 summary，L2 的 detail 含 `wasmBytes`/`memoryLimitMb`/`hostFunctions`，L3 的 detail 含 `entry`/`requirements`/`network` |
| `Uninstalled` | 插件被卸载 | ✅ | `store.rs::uninstall`：只有 subject |
| `PermissionGranted` | 用户授予了能力 | ✅ | `store.rs::set_granted`：summary 含数量，detail 为 `{ "granted": [能力中文描述] }`（只记**新增**的能力） |
| `PermissionRevoked` | 用户收回了能力 | ✅ | `store.rs::set_granted`：summary 含数量，detail 为 `{ "revoked": [...] }`。**曾经只记增加不记收回** —— 那样就回答不了"我什么时候把某个插件的网络权限关掉的" |
| `PrivilegeEscalation` | **检测到权限扩张** | ✅ | `audit.rs::record_escalation` ← `store.rs::finish_install`：summary 含"从 x 升级到 y 时新增了 N 项能力声明"，detail 为 `{ "added": [...] }` |
| `PathEscapeBlocked` | **路径逃逸被拦截** —— 插件试图访问授权根之外的路径 | ✅ | `l1.rs::run_pipeline`：summary「步骤 \`X\` 试图访问授权范围之外的路径，已拦截」，detail 为 `{ "step", "node", "message", "detail" }`（`detail` 里含**授权根**与**实际解析到的路径**，取证足够）。**这条曾经完全没被记录** —— 审计钩子只认能力裁决的 `CapabilityViolation`，而路径拦截来自 `PathResolver` 的 `PermissionDenied`。真机测试里那个读 `C:\Windows\System32\drivers\etc\hosts` 的恶意插件任务失败了，日志里却查无此事 |
| `CapabilityViolation` | **运行时越权被拦截** | ✅（三处） | `audit.rs::record_violation`：summary「插件尝试使用未声明的能力：{what}」；`l1.rs::run_pipeline`：能力裁决拦下时记「步骤 \`X\`：{message}」；`store.rs::set_granted`：「请求授予 N 项清单未声明的能力，已丢弃」，detail 为 `{ "rejected": [...] }` |
| `ValidationFailed` | 清单校验失败 | ❌ **无写入方** | 校验发生在 `PluginManifest::validate()`，它返回报告而不是写审计；调用方（`plugins_validate` / `install`）目前只把报告回给前端 |
| `IntegrityFailure` | 哈希不匹配 | ✅ | `audit.rs::record_integrity` ← `runtimes.rs::ensure_loaded` 与 `store.rs::quarantine_if_changed`：summary「内容哈希与记录不符，已拒绝装载」，detail 为 `{ "expected", "actual" }` |
| `AiDraftAccepted` | AI 生成的插件被安装 | ✅ | `store.rs::finish_install`：当 `manifest.ai.generated == true` 时记 summary 与 `{ "model", "runtime", "hash" }`。只记 `Installed` 的话，AI 生成的与手写的混在一起分不出来 |
| `AiDraftRejected` | AI 生成的插件未通过安全审核 | ✅ | `commands.rs::ai_generate`：审核不通过时记 summary 与 `{ "model", "provider", "promptChars", "findings" }`。它回答"这个模型是不是经常试图生成越权的插件" |

> **安全事件的记录位置是有讲究的**：`l1.rs::run_pipeline` 里，越权与路径逃逸的审计发生在**应用 `onError` 策略之前**。本步骤若配了 `onError: skip`，记录绝不能跟着消失 —— 那正是攻击者最希望发生的事。

注意 `AuditEventKind` 的枚举注释规定：「**只增不改**：改名会让历史日志失去可读性。」

### 7.3 建议补全项

按"最有用 → 次有用"排序（都还没实现）：

1. **越权请求的结构化字段**。现在 `record_violation()` 只记一句 `{ "request": "读取 /etc/passwd" }` 这样的描述，无法做聚合分析。建议补：原始请求路径（**规范化之前**的那份，这才看得出攻击意图）、被拒绝的主机名、`Exec` 的程序名与参数、`Env` 的变量名、请求发生的插件版本与哈希；
2. **权限撤销事件**。`PermissionRevoked` 已在枚举里，但没有任何写入方——`set_granted` 应当像记 `granted` 一样记 `revoked`；
3. **校验失败事件**（`ValidationFailed`）。目前 `plugins_validate` 返回报告但**不写审计**，导致"AI 生成被拦下"这件事在审计里看不到。应在校验失败时写入错误码清单；
4. **AI 生成请求与结果的摘要**。`AiDraftAccepted` / `AiDraftRejected` 用例应当记录：prompt 摘要、模型名、provider、`review_draft()` 的 `risk_level` 与 findings 的 code 列表、最终是否安装。**注意只记摘要，不要记完整 prompt 与文件内容**（可能含用户隐私，也会让审计文件膨胀）；
5. **AI 调用本身**（模型名、耗时、token 估算），用于解释"我的额度去哪了"；
6. **权限授予/撤销的操作上下文**：至少记插件版本与生效权限快照，便于回答"当时到底授权了什么"；
7. **宿主侧的安全决策**：`quarantine_if_changed` 已经推了 `AppEvent::security("critical", ...)`，但它只记了 `IntegrityFailure` 一条；建议把"自动禁用"这个动作也写成独立事件（谁在什么时候禁用了什么）。

### 7.4 审计日志的性质与约束

- **只追加**。`AuditLog::try_record()` 用 `OpenOptions::new().create(true).append(true)`，只 `writeln!` 一行，从不重写文件；`tail()` / `files()` 只读。`files()` 按文件名排序后 `reverse()`，给出"按日期倒序"的文件列表；
- **写入失败不能影响业务**。`record()` 吞掉错误并记一条 `tracing::error!`（注释：「磁盘满不该导致插件装不上」），并有单元测试 `audit_write_failure_does_not_panic` 锁定"指向不可创建的路径也不 panic"。**注意这个取舍的代价**：磁盘满/权限错误时审计会**静默缺失**，只有应用日志里有痕迹。如果将来要做"关键安全事件必须落盘"，需要为 `CapabilityViolation` / `IntegrityFailure` 这类事件单开一条**不允许静默失败**的路径；
- **不记录 API Key 明文**。审计事件的 `detail` 全部由调用方显式构造，本次核对过的所有写入点都不含凭据；`AiProviderConfig::api_key` 带 `skip_serializing`（永不序列化到前端），Key 默认只以内存态存在于 `AppState`（**例外**：用户显式打开 `ai.persistApiKey` 后它会明文落在 `<data>/ai-key.txt`，见 §1.5 —— 但**仍然不进审计日志**）。**这条是"当前写入点如此"，不是"结构上不可能"**——`detail` 是自由的 `serde_json::Value`，任何人塞进去就会被记下来，所以**审阅新增的审计写入点时必须专门看一眼有没有塞敏感值**；
- **可在插件详情页回放给用户看**。`commands.rs` 的 `plugins_audit(limit)` 返回 `AuditSnapshot { events, files, dir }`，`limit` 被 clamp 到 `1..=2000`；`AuditLog::tail(limit)` 读当天的文件、按行解析、`rev()` 取最后 N 条后再 `reverse()`（即按时间正序返回），解析失败的行被 `filter_map` 丢掉（所以**一行坏了不会影响其它行**）。"安全"页面应当据此按时间顺序还原"生成 → 审阅 → 授权 → 执行"全过程（`ROADMAP.md` 的 v0.5 验收标准第 10 条就是这条）；
- **审计文件是明文 NDJSON**，用户可以直接用文本编辑器打开。这意味着**审计日志本身不是机密材料**，不要往里写敏感值；它也意味着用户可以**删改**它（没有签名/防篡改链）。防篡改（哈希链、只追加文件属性、外部投递）属于**待定**事项。

---

## 8. 如何报告安全问题

### 8.1 请不要在公开 issue 里贴 PoC

公开的 PoC 会让所有还在旧版本上的用户立刻暴露。请按下面的顺序做：

1. **先通过仓库 Issues 请求一个私下渠道**。提交一条**不含任何技术细节**的 issue，说明"我发现了一个安全问题，希望私下沟通"，并留下一个你可以接收回复的方式（例如"请在我的 GitHub 主页上找我公开的联系方式"）。
   - 仓库：`https://github.com/kkkkk-stk/Super-Multi-functional-Integrated-Software`（见 `README.md`）
   - Issues：`https://github.com/kkkkk-stk/Super-Multi-functional-Integrated-Software/issues`（`README.md` 的「联系方式」一节给出的就是 GitHub 主页与 Issues）
2. **仓库目前未设立专门的安全邮箱。** `README.md` 的「联系方式」一节只有 GitHub 主页与 Issues 入口，没有安全邮箱、也没有安全政策文件。所以**不要**往一个猜测的地址发邮件；请通过 Issues 请求私下渠道，维护者会给出下一步的联系方式。

### 8.2 报告里应当包含什么

越具体越好，清单如下：

1. **版本**：应用版本（「关于」页，来自 `app_info` 命令的 `version`）与 `pluginApiVersion`（当前是 `toolforge/v1`）；如果是自己构建的，给 commit 号；
2. **平台**：操作系统与版本（Windows 10/11 具体版本、macOS 版本与芯片、Linux 发行版与内核）、应用是安装包还是开发态；
3. **插件标识**：插件 id（`metadata.id`）、插件版本、**内容哈希**（`sha256:...`）。
   - 哈希可以在**安装确认页**上看到（`InstallReport::content_hash`），也可以在审计日志里找 `Installed` 事件的 `detail.hash`；
   - 注意 `PluginDetail` 目前**不包含** `installed_hash` 字段，所以详情页上拿不到它——请从上面两处取；
4. **涉及的能力**：这个插件**已经授权**了哪些能力（这决定了问题严重程度：一个只有 `fsRead{input}` 的插件能做的事，和一个拿着 `exec` 的插件完全不同）；
5. **复现步骤**：最小可复现的材料（`plugin.yaml` 全文 + 必要的最小代码文件），以及"我期望发生什么 / 实际发生了什么"。仓库根目录下的 `README.md` 是你的参照，但**请把 PoC 的细节留在私下渠道**；
6. **影响范围**：能读/写/外传什么、是否需要用户交互（例如"必须用户点安装并授权"还是"装载即触发"）、是否需要特定引擎或 Python 环境；
7. **是否已公开**：你是否已在别处披露过、有没有时间线约束；
8. **可选但很有帮助**：审计日志里相关几行（`<data_root>/audit/audit-YYYY-MM-DD.ndjson`），以及错误码。

### 8.3 什么算"安全问题"（本项目的判定口径）

- **算**：绕过 `PathResolver` 的路径穿越；未授权却成功的文件/网络/进程操作；`content_hash` 校验被绕过；前端能执行任意命令或绕过授权给插件开权限；安装包（`Bundle`）里的路径逃出插件目录；审计里能伪造/删除越权记录；AI 生成流程能让草稿在用户确认前落盘。
- **也算**（虽然是"设计已知"）：上面 §1.4 与 §9 列出的**程度不足**——例如"L3 插件能读进程可读的任何文件""符号链接能逃出授权根目录"。这类问题我们已知，但如果你有**具体的利用链**或**更简单的复现**，请仍然报告，它会影响加固的优先级。
- **可能不算**：纯粹因为"用户自己授权了 `exec`/`net` 然后插件滥用了它"。这类需要靠 §7 的审计与用户判断兜住。但如果你认为"授权界面没有把后果说清楚"，那算**可用性/知情同意缺陷**，也请报。

---

## 9. 已知缺口清单

下表的"计划"一列对应 `docs/ROADMAP.md` 的阶段名（v0.1 / v0.2 / v0.5 / v1.0）。**该文档的阶段划分仍可作为参考，但它的「当前状态速览」已过期**（见 §0.2），所以"计划"只表示"这件事应在哪个阶段被处理"，不代表该阶段的其它描述是准确的。

| # | 问题 | 影响 | 当前缓解 | 计划 |
| --- | --- | --- | --- | --- |
| 1 | ~~`CapabilityGuard::check()` 没有生产调用点~~ | —— | ✅ **已修复**：`nodes.rs::resolve_path()` 现在对**每一次**文件访问先调 `check()`（input 走 `ReadFile`、其余走 `WriteFile`），拒绝时返回 `PluginCapabilityViolation`，并由 `l1.rs` 在**应用 `onError` 策略之前**写入审计（否则 `onError: skip` 会让越权记录凭空消失）。四条回归测试钉住：`fs_write_is_rejected_without_the_capability`、`fs_read_is_rejected_without_the_capability`、`fs_write_passes_once_the_capability_is_granted`、`path_traversal_is_still_blocked_after_the_capability_check`。**注意 `ReadEnv` / `Spawn` 两个分支仍无调用点**，见第 3、4 项。另有一条**同类但更隐蔽**的缺口已于 2026-09 关闭：装载门的 `runnable_or_grant_all()` 让"声明 ∩ 授权"退化成恒等式，也就是说第 1 项修好的这套裁决**在真实链路上根本走不到**（详见 §2.2 的修正） | 关闭（fsRead/fsWrite 部分） |
| 2 | `Net { hosts }` 白名单**对 L2 已强制，对 L3 仍未强制**（`check_host()` 仍无调用点） | **L2**：Extism 内置 `http_request` 受 `allowed_hosts` 约束，而宿主把「声明 ∩ 授权」翻译成这份名单（`runtimes/wasm.rs::allowed_hosts_from`），越界请求由沙箱自己拒绝并回传 `HTTP request to … is not allowed`。<br>**L3**：`hosts` 仍只影响 UI 文案；真正的控制只有"能否联网"的布尔开关，且可用 socket 绕过代理变量 | `deny_network` 默认开、`PYTHON_NET_WITHOUT_PERMISSION` 错误、`scan_code()` 的模式扫描、`NET_HOST_WITH_PORT` 校验（带端口的白名单必然失配）。**盘点时发现的两个真实缺陷**：① 宿主此前从不设置 `allowed_hosts`，于是 L2 的 `net` **勾了也没用**（fail-closed，方向安全但功能是坏的）；② 清单写 `api.example.com:443` 这种带端口的白名单**永远匹配不上** —— Extism 用 `url.host_str()` 比较，端口不参与 | L2 部分关闭；L3 留给 v0.2（需内核级隔离，否则"白名单"对 L3 仍是空话） |
| 3 | `Exec` **在运行期仍无强制**；但**装载期已加静态门** | v0.1 的原始状态：L3 插件可以起任意子进程，`CapabilityGuard` 的 `Spawn` 分支没有调用点。**L3 是普通进程，宿主不在它的 `CreateProcess` 路径上**，所以"运行期拦截"这件事在 v0.1 **做不到**（要 Windows Job Object + AppContainer / macOS `sandbox-exec` / Linux seccomp）。| **新增装载期静态门**：`runtimes/python.rs::scan_python_sources()` 读插件目录里的 `.py`（跳过 `.venv` / `__pycache__`），命中 `subprocess` / `os.system` / `os.popen` / `os.exec*` / `os.spawn*` / `os.fork` / `pty.spawn` / `multiprocessing` / `CreateProcess` / `shell=True` 且**生效能力里没有 `exec`** 时**拒绝装载**：没声明 → `PluginInvalid`（附上文件与 API，并给出 `kind: exec` 的写法）；声明了但没授权 → `PermissionDenied`（引导去勾选）。装载事件里同时记下扫到的用法与"当时 exec 是否已授权"。UI 上按运行时如实说明（`capability.ts::capabilityEnforcement`：L3 = "只强制了一部分"）。<br>⚠️ **它挡的是"忘了声明"，挡不住蓄意绕过**：`__import__("sub"+"process")`、把代码拼成字符串再 `exec`、走 `ctypes` 直接调 Win32 都扫不到 —— 这是**已知的能力边界**，有一条单测（`the_gate_is_not_a_sandbox_and_we_say_so`）专门把它记下来，免得以后有人把这道门当沙箱。 | 装载期部分关闭；运行期留给 v0.2（需要内核级隔离） |
| 4 | ~~`Env { names }` **无任何实现**（无注入通道；`ReadEnv` 分支未被调用）~~ → **L3 已实现，L1/L2 不适用** | **已修复（L3）**：`runtimes/python.rs::inject_declared_env()` 把「声明 ∩ 授权」里的名字逐个从宿主环境读出、注入 L3 子进程（`env_clear()` 之后，所以插件看到的环境 = 运行时必需的那几个 + 白名单）。宿主上不存在的名字记进应用日志（`missing = N`），插件读到的是空 —— 这一条很重要：不区分"没授权"和"宿主上没这个变量"，作者会一直以为是权限没生效。**`ReadEnv` 分支仍然没有调用点**，但也不再需要：L3 的环境在**装载时**就定好了，运行期不存在"读一个变量"这个动作。**L1 与 L2 不适用且如实标注**：L1 的节点跑在宿主进程里、本来就能读环境（没有可拦的位置）；L2 关掉了 WASI，模块连 `environ_get` 都调不到。UI 上按运行时分别说明（`capability.ts::capabilityEnforcement`） | ✅ 关闭（L3）；L1/L2 在 UI 上如实标注为"仅是声明" |
| 5 | `Ai` / `Gpu` **无裁决点，也无对应请求类型**（`CapabilityRequest` 只有 5 个变体） | 两项能力目前只有风险等级与文案；`Ai` 的"额度消耗 + 数据外传"没有被任何机制约束 | `Ai` 走宿主侧 `AiClient`（插件不能直接拿到 Key）；风险文案 | v0.5 |
| 6 | `PathScope::Explicit` **无法通过 `plugin.yaml` 表达**（内部标签 + `String` newtype 变体无法调和） | `HOST_PATH_WRITE` 警告与 `FsRead{Explicit}` 的 High 分支**暂不可达**；需要访问固定系统目录的合法插件也写不出来 | 无（逃生舱口实际锁死） | 待定（需先定 §3.8 的方案 A / B） |
| 7 | 词法规范化**挡不住符号链接**、Windows 8.3 短名、UNC/设备路径、TOCTOU | 若攻击者能在授权根内放置链接，可读到根目录之外 | 绝对路径拒绝 + `starts_with(root)` 组件级比较 | v0.2 起（`openat`/`O_NOFOLLOW`/逐级校验） |
| 8 | `PathResolver::resolve()` **不显式拒绝盘符前缀/根目录**（依赖 `join`/`push` 的替换语义） | 看起来仍被 `starts_with` 拦住，但结论是阅读推导、非实测，依赖标准库语义 | 同上。建议对齐 `store.rs::safe_relative_path()` 补显式检查 | 待定 |
| 9 | ~~`sanitize_id()` 实现与自身单测不符~~ | —— | ✅ **已修复**：实现改为「替换非法字符 → **折叠连续的点** → 去掉首尾的点 → 空串回落 `unnamed`」，`..` 结构上不可能再出现；测试改为断言不变量并新增 `sanitize_never_leaves_dotdot`。**注意它当时也不是可穿越漏洞**（`/`、`\` 已被替换，结果仍是单个组件），是"实现与声明不一致"。见 §4.5 | 关闭 |
| 10 | ~~`plugin.rs`、`store.rs`、`toolforge-ai/src/review.rs` 的清单夹具与 `PermissionSet` 的 serde 表示不符~~ **已消解** | 这些夹具使用的是映射形式 `permissions: { capabilities: [...] }`，而 `PermissionSet` 的 `#[serde(transparent)]` 已被**移除**、schema 统一到映射形式，因此不再有解析失败。相反，原先按裸数组写的 6 个示例 `plugin.yaml` 一度全部失效，已改正并重新校验通过 | 无 | 已关闭 |
| 11 | `crates/toolforge-process/src/supervisor.rs` 的 `ChildSupervisor::spawn()` 在返回结构体时写了 `notifications: notify_rx`，而局部变量名是 `notifications`（`notify_rx` 在文件里不存在） | 该 crate **看起来无法编译**，进而 L3 的进程隔离（`clear_env` / `deny_network` / 超时强杀）都还没被真正跑起来。**本次仅通过阅读发现，未运行 `cargo` 验证** | 无 | v0.1（属编译阻塞，性质同 `ROADMAP.md` 的阻塞 1/2） |
| 12 | ~~`capabilities/default.json` 里 `shell:allow-execute` 放行的是 `explorer` + `args: true`~~ | —— | ✅ **已修复**：`shell:allow-execute` 与 `shell:allow-open` 已**整体移除**。"在文件管理器里显示输出文件"改走 `opener` 插件的 `revealItemInDir()` —— 目的明确的 API，不是通用命令执行。shell 插件仍被注册（对齐技术选型与未来的 sidecar 分发），但**零权限**。`lib.rs` 里那句与配置不符的注释也已改正 | 关闭 |
| 13 | 前端直接持有 `fs:allow-read-text-file` / `fs:allow-write-text-file` / `fs:allow-exists` 及一组用户目录 scope | 前端可不经 Rust 命令层读写这些目录的文本文件，与"前端只通过 IPC 间接触发任务"的表述不一致 | scope 限定在用户目录（无根通配）+ 严格 CSP | v0.1/v0.2（逐条评估收窄） |
| 14 | `AiProvenance.reviewed_at` 与 `AiProvenance.source_hash` **无任何写入方** | "AI 审阅时间戳"与"AI 产物哈希锁定"两个设计承诺未落地（等价完整性由 `installed_hash` 承担） | `PluginState.installed_hash` + `content_hash()` + `quarantine_if_changed` 自动禁用 | v0.5 |
| 15 | `AuditEventKind` 中 `ValidationFailed` / `PermissionRevoked` / `AiDraftAccepted` / `AiDraftRejected` **无写入方**；`ai_generate` 本身不写审计 | 校验失败、权限撤销、AI 生成与拒绝这些事件在审计里看不到，事后无法还原完整链路 | 部分动作有应用日志（`tracing`） | v0.5（"审计日志完整"） |
| 16 | 越权事件 `detail` 只有一句人类可读描述（`{ "request": what }`），缺结构化字段 | 无法聚合分析"哪个插件在反复试探什么"，也看不到规范化之前的原始路径 | 无 | v0.5（见 §7.3） |
| 17 | 审计写入失败被**静默吞掉**（只记 `tracing::error`） | 磁盘满/权限错误时关键安全事件可能不落盘，用户无感 | 应用日志里有痕迹 | 待定（为关键事件单开不可静默失败的路径） |
| 18 | ~~`PathResolver::resolve()` 的文档注释仍写「之所以先 `canonicalize` 再比较」~~ | —— | ✅ **已修复**：注释已改为「之所以先做词法规范化再比较」，与实现一致 | 关闭 |
| 19 | L1 只预检 `fsRead`，**不预检 `fsWrite`**（`run_pipeline` 里只查了 `"src"`） | 未授权写文件要靠后续 `PathResolver` 或节点自身兜住，预检层有缺口 | `PathResolver` + 输出路径由宿主算好（`build_io`） | v0.2（随第 1 项一起补） |
| 20 | 内置插件默认 `enabled: true` 且**自动授予声明的全部能力** | 前提是"内置目录不可被替换"。打包后它来自 `resource_dir()/plugins/builtin`；开发态直接指向仓库的 `plugins/builtin`。若该目录可被写入，等同"自动全量授权" | 路径解析有多级回退（`resolve_builtin_plugins`），但无完整性校验（内置插件没有 `installed_hash`） | v1.0（"插件来源可信"）/ 待定 |
| 20a | ~~上面这行描述的"开发态指向仓库目录"**在修复前并不是事实**~~ | `resolve_builtin_plugins()` 原来**一律先看 `resource_dir()`**，而开发构建下 `resource_dir()` 就是可执行文件所在目录 —— `target/debug/plugins/builtin/` 里有一份 `tauri-build` 在构建期拷过去的 `bundle.resources` 陈旧副本（只含最早的 4 个内置插件），于是从 `target/debug/toolforge.exe` 启动只装载 4 个、而仓库里明明有 7 个。**这不是安全问题，但它说明"文档描述与运行时事实不一致"能潜伏很久**：现在改为**开发构建优先用仓库目录、只有发布构建才先看 resource**，与这一行终于对齐 | ✅ **已修复**（见 `docs/ARCHITECTURE.md` 开放项 10） | 关闭 |
| 21 | ~~传给插件的路径同时存在两套语义~~ | —— | ✅ **已修复**：`initialize` 现在只传 `pluginDir` / `dataDir`（跨任务稳定的插件私有目录），本次任务的 `input` / `output` / `work` 只在每次 `run` 的载荷里给，**全部是真实路径**。契约内不一致消除；同时把"虚拟路径"的说法从注释里删掉，因为它与 L3 是普通进程这一事实不符 | 关闭 |
| 22 | L3 **没有内核级隔离**（无 Windows Job Object + AppContainer / macOS `sandbox-exec` / Linux seccomp） | 见 §1.4：蓄意插件可绕过代理断网、可读进程可读的任何文件 | `clear_env` + 锁 cwd + 代理变量断网 + 超时强杀 + 优雅关闭；**并在 UI 上如实告知用户** | v0.2（`ROADMAP.md` 的路线图项） |
| 23 | `plugin_data` / `PluginData` 作用域的写入**没有配额**；运行时写文件也没有总量限制 | 授权 `FsWrite` 的插件可以把磁盘写满（安装路径的 1 MB / 8 MB 上限只约束 `Bundle` 安装，不约束运行期） | 无 | 待定 |
| 24 | 内置节点里的 `fs.delete` / `fs.move` 在 `FsWrite` 授权下即可用，**没有"只允许写新文件、不允许覆盖/删除既有文件"的约束** | 输出目录若与输入目录相同（或输出目录里有用户的其它文件），可能造成数据丢失 | 输出目录由用户指定；`PathResolver` 限制在目录内 | 待定（建议加"覆盖既有文件需二次确认"） |
| 25 | **L3 的文件访问完全不经宿主中介**：`PathResolver` 不在 L3 的文件读写路径上，且 `PluginRunner::resolver_for()`（自称"供 L3 使用"）没有任何调用点 | 对 L3 而言 `fsRead{scope}` / `fsWrite{scope}` 只是**约定**，不是强制；"文件访问被限制在授权目录内"这句话只对 L1/宿主侧成立 | 只有 §1.4 的三件事（清空环境变量、锁 cwd、代理断网）+ 用户在授权前的判断 | v0.2（"路径收敛落地"这一条应明确 L3 怎么办：要么加内核级隔离，要么把 L3 的权限语义如实改写） |
| 26 | ~~`nodes.rs::libreoffice_to_pdf` 在 `dst` 没有父目录时回退到 `std::env::temp_dir()`~~ | —— | ✅ **已修复**：改为**直接报错**而不是回退到宿主机临时目录。宁可让调用方看到"输出路径没有父目录"，也不要在授权范围之外偷偷写文件 | 关闭 |
| 27 | `ai.persistApiKey` 打开后，API Key **明文**写在 `<data>/ai-key.txt`；**没有加密、没有 DPAPI / Keychain** | 拿到该文件即可拿到 Key。这是相对系统钥匙串的**能力降级**，而代码里 `ai-provider` 的 `licenseNote` 仍写着「只存在本机加密存储中」，属于与实现不符的文案 | 开关**默认关闭**（`persistApiKey: false`，Key 默认只在内存）；关掉开关会**删除**该文件；Key 不进日志、不进审计、不序列化给前端 | 待定（OS 钥匙串仍是 ROADMAP 上的待办；在它落地前**不得**在任何文案里声称加密存储） |
| 28 | 模型权重的下载**依赖服务端提供正确文件**，而 `birefnet-general` / `modnet-portrait` / `realesrgan-x4plus` **没有 url/hash** | 对后三者前端只能显示「无下载源」并禁用按钮（刻意的：宁可按钮是灰的，也不放一个点了必然失败的按钮） | 已核对的三个 rembg 权重带**真实下载后算出来的** SHA-256；**哈希不匹配即删除文件**（`registry.rs::install_model` → `IntegrityCheckFailed`），不留没校验过的产物 | 待定（补齐剩余三个模型的真实哈希后再放开按钮） |
| 29 | **抠图节点首次运行会自己建 venv 并联网 `pip install`**（`onnxruntime` / `numpy` / `pillow`，约 30 MB），**这不是用户逐条点出来的动作** | 一次主机侧的、未做完整性校验的网络拉包：**没有哈希锁定、没有签名校验**，装进来的 wheel 会被推理子进程直接 import。它同样是"首次运行要联网"这个事实在产品里的第二个入口（第一个是权重下载） | 只在**首次运行 `image.remove-background` 或 `ai.upscale` 时**发生（不是安装应用时、不是启动时，也不是别的节点）；venv 独立落在 `<data>/cache/onnx-runtime/`，**不碰用户自己的 Python**，卸载就是删掉那个目录；**推理本身完全本地** —— 不联网、不上传图片；用户必须自行下载权重，所以这两个节点不可能在用户完全没动作的情况下自己开跑 | v0.2（讨论方向：把 wheel 版本固定并校验哈希，或改为随包分发 / 由 `engine-sources.json` 提供受校验的来源） |
| 30 | **`ai.describe` 与 `doc.ocr` 的 AI 路径会把图片上传给用户配置的 AI 服务商**，且**不经过任何权限门**（内置节点走宿主侧 `AiClient`，插件 `net` 声明管不到、`CapabilityGuard` 的 `Http` 分支也没有调用点） | 用户图片（缩小并转 JPEG 后）离开本机，交给第三方；服务端的留存/训练政策与 ToolForge 无关。`doc.ocr` 的 `engine` 默认 `auto`，所以**没装 tesseract 的机器上跑 OCR 会自动外传**，用户只从任务日志里那一句提示得知 | `maxSide` 会先把图缩小（`ai.describe` 默认 1024、`doc.ocr` 默认 2048）以降费用与流量，但**不改变外传这一事实**；服务商地址由用户自己在「设置 → AI」里指定；任务日志会写明"图片会上传给 AI 服务商"；**完全离线的替代品是同为内置节点的 `image.remove-background` 与 `ai.upscale`（推理全在本机）** | 待定（方向：把"这次会把图片发到 <服务商>"做成一次显式确认；`doc.ocr` 的 `auto` 在没装 tesseract 时不要默默选 AI） |

> **关于第 29 项，几条必须说清楚、不能含糊的边界：**
>
> - **什么时候发生**：**只有首次运行 `image.remove-background` 或 `ai.upscale` 时**。安装应用、启动应用、跑别的节点都不会触发。
> - **装到哪里**：`<data>/cache/onnx-runtime/` 下的**独立 venv**。
> - **会不会动用户的 Python**：**不会**。这是刻意选独立 venv 的理由 —— 用户的系统 Python 一个字节都不改，卸载也只是删目录。
> - **推理联网吗**：**不联网**。图片不上传，推理全在本机；网络只用于**一次**拉取依赖。
> - **不能声称的**：**不能说这些 pip 包被哈希锁定或经过校验** —— 它们没被锁定、也没被校验。也不要说"这两个节点完全离线可用"：**没有网络的机器在依赖就位之前用不了它们**（权重还得用户自己下）。
>
> 相关设计理由（为什么跑 Python 子进程而不是 Rust 内推理）见 `docs/ARCHITECTURE.md` 决策 9；引擎与权重侧的说明见 `docs/ENGINE-MATRIX.md` 第 3.2、3.6 节。
>
> ---
>
> **关于第 30 项（图片外传），最容易混淆的一点单独说清楚：** 这个项目里带"AI"字样的四个节点**并不都联网**。
> `ai.describe` 与 `doc.ocr`(AI 路径) **会把图片发给第三方**；`image.remove-background` 与 `ai.upscale` **不会**（本地 ONNX 推理）。
> 对外描述时**不要**笼统地说"AI 功能需要联网"或"AI 功能都是本地的" —— 两种说法都会误导用户，
> 而这一条恰好是用户最在意的隐私问题。完整的对照表与说明见 §3.9。

### 附：本次核对中**没有**发现问题的部分（也值得记下来）

为了避免只有坏消息造成误判，以下几处的实现与文档一致且质量较高：

- `PluginStore::set_granted()` 对"清单未声明能力"的**丢弃 + 审计**；
- `finish_install()` 的"安装后一律禁用 + 零授权"，以及"升级后同样重置"；
- `content_hash()` 的规则（跳过运行期目录、路径参与哈希、排序保证确定性）；
- `safe_relative_path()` 的校验完整性（绝对路径、盘符、`..`、Windows 保留名）；
- **模型权重的下载校验**：已核对的三个 rembg 权重带真实下载后算出的 SHA-256，**不匹配就删文件**；`verified_sources_are_pinned` 单测强制 `url` / `sha256` / `file_name` 三者全有或全无、哈希格式正确、文件名不重复 —— 结果就是**没有下载源的模型在前端是禁用状态**，而不是"点了报错"；
- **输入的授权范围按"就紧不就松"取**：目录输入用目录自身作 `input_root`（不是父级），目录展开只走一层并跳过 symlink 与隐藏文件（见 §4.7）；
- `WasmPlugin` 的 WASI 关闭 + fuel 上限 + 内存上限 + 载荷上限；
- `PythonRuntimeDef::allow_network` 与 `SpawnSpec::deny_network` 的**默认安全值**（有单测锁定）；
- `review.rs` 的"`eval`/`exec` 无任何能力可覆盖"这条判定（`CapabilityNeed::Code => false`）；
- `AiProvenance` 的"`reviewedAt` 有值不等于放行"这条注释；
- 外壳的 CSP、`withGlobalTauri: false`、`COMMAND_NAMES` 一致性自检。

---

## 附：本文档引用的代码位置索引

| 主题 | 位置 |
| --- | --- |
| 能力模型、裁决器、路径收敛 | `crates/toolforge-core/src/permission.rs`（`PathScope` / `Capability` / `RiskLevel` / `PermissionSet` / `CapabilityRequest` / `CapabilityVerdict` / `CapabilityGuard` / `host_matches` / `PathResolver` / `normalize_lexically`） |
| 清单 schema 与校验码 | `crates/toolforge-core/src/plugin.rs`（`PluginManifest::validate` / `validate_runtime` / `is_valid_plugin_id` / `AiProvenance` / `PluginSource` / `BundleFile` / `PluginSummary::from_manifest` / `ValidationReport`） |
| 错误码全集 | `crates/toolforge-core/src/error.rs`（`ErrorCode`：尤见 `PermissionDenied` / `PluginCapabilityViolation` / `IntegrityCheckFailed` / `AiRejected`；`ToolforgeError::violation`） |
| 目录布局与 `sanitize_id` | `crates/toolforge-core/src/paths.rs`（`AppPaths::audit` / `plugin_dir` / `plugin_data` / `sanitize_id` / `settings_file` / `ai_key_file` / `settings_backup_file`） |
| 设置的持久化与凭据落盘 | `apps/desktop/src-tauri/src/settings_store.rs`（`load` / `save` / `load_api_key` / `save_api_key` / `write_atomic` / `quarantine`）、`apps/desktop/src-tauri/src/ipc.rs`（`AiSettings::persist_api_key`，默认 `false`） |
| 输入的授权根与目录展开 | `apps/desktop/src-tauri/src/commands.rs`（`build_io` / `expand_batches` / `expand_dir` / `MAX_DIR_EXPANSION`） |
| 模型权重的下载与校验 | `crates/toolforge-engines/src/registry.rs`（`install_model` / `model_path`）、`crates/toolforge-core/src/engine.rs`（`engine_catalog()` 的模型条目、单测 `verified_sources_are_pinned`） |
| 运行时边界（L2/L3 诚实说明） | `crates/toolforge-plugins/src/runtimes.rs`（模块文档、`PluginRunner::ensure_loaded` / `call` / `resolver_for`） |
| L2 沙箱 | `crates/toolforge-plugins/src/runtimes/wasm.rs`（`WasmPlugin::load` / `pages_for_memory` / `fuel_for_timeout`） |
| L3 进程隔离 | `crates/toolforge-plugins/src/runtimes/python.rs`（`PythonPlugin::launch` / `handle_notification` / `prepare_venv`） |
| L1 执行与权限预检 | `crates/toolforge-plugins/src/l1.rs`（`run_pipeline` / `pipeline_uses_fs`） |
| 审计 | `crates/toolforge-plugins/src/audit.rs`（`AuditEventKind` / `AuditEvent` / `AuditLog` / `content_hash` / `record_violation` / `record_escalation` / `record_integrity`） |
| 图片外传（§3.9） | `crates/toolforge-core/src/ai.rs`（`VisionClient` / `VisionRequest`）、`crates/toolforge-ai/src/provider.rs`（`impl VisionClient for AiClient`）、`crates/toolforge-engines/src/nodes.rs`（`ai_describe` / `doc_ocr` / `shrink_for_vision`，本地重编码为 JPEG q85） |
| AI 视觉链路的验收（不碰真实服务商） | `scripts/devtools/mock-openai.mjs`（假 OpenAI 兼容端点）、`scripts/devtools/verify-platform.mjs` 的【10】号检查（跑完还原用户的 AI 设置） |
| 插件仓库与安装 | `crates/toolforge-plugins/src/store.rs`（`PluginStore::install` / `finish_install` / `set_granted` / `set_enabled` / `runnable` / `verify_integrity` / `quarantine_if_changed` / `safe_relative_path` / `diff_capabilities`） |
| 子进程监管 | `crates/toolforge-process/src/supervisor.rs`（`SpawnSpec` / `ChildSupervisor::spawn` / `initialize` / `call` / `shutdown` / `kill` / `decorate`）、`crates/toolforge-process/src/lib.rs`（`hide_console` / `detach_process_group` / 安全边界说明） |
| 内置节点与虚拟前缀 | `crates/toolforge-engines/src/nodes.rs`（`resolve_path`；`image_remove_background` 是第 29 项那次联网 `pip install` 的触发点） |
| 抠图的运行时准备与外发网络 | `crates/toolforge-engines/src/nodes.rs`（`image_remove_background` + `ensure_onnx_runtime`：建 venv、`pip install onnxruntime numpy pillow`）、`crates/toolforge-engines/py/rembg.py`（实际执行推理的脚本，本身不联网） |
| AI 生成与审核 | `crates/toolforge-ai/src/review.rs`（`AiDraft` / `SecurityReview` / `review_draft` / `scan_code`）、`crates/toolforge-ai/src/provider.rs`（`AiProviderConfig` 的 `api_key`） |
| 外壳与 IPC | `apps/desktop/src-tauri/src/commands.rs`（`plugins_install` / `plugins_grant` / `plugins_run` / `ai_generate` / `build_io` / `resolve_output_dir`）、`apps/desktop/src-tauri/src/lib.rs`（`COMMAND_NAMES` / `specta_builder` / 插件注册）、`apps/desktop/src-tauri/capabilities/default.json`、`apps/desktop/src-tauri/tauri.conf.json` |
| 阶段目标 | `docs/ROADMAP.md`、`docs/ENGINE-MATRIX.md` |
