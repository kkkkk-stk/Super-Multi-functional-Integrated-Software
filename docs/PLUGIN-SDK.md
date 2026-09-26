# ToolForge 插件 SDK

> 面向**插件作者**。本文档的一切字段名、节点名、错误码都以代码为准：
> 清单 schema 来自 `crates/toolforge-core/src/plugin.rs`，流水线来自
> `crates/toolforge-core/src/pipeline.rs`，能力模型来自
> `crates/toolforge-core/src/permission.rs`，节点执行器来自
> `crates/toolforge-engines/src/nodes.rs`，L2/L3 宿主来自
> `crates/toolforge-plugins/src/runtimes.rs` 及其子模块。
> 代码改了这里没改就是文档的 bug，请提 issue。
>
> **仓库正在开发中**：标注 🚧 的能力属于"清单能写、执行器还没实现"，标 ⛔ 的表示尚未落地。

---

## 0. 一分钟速览

| 你想做的事 | 选哪一级 | 为什么 |
|---|---|---|
| 把现成能力（转换、压缩、转码、抽帧）串起来 | **L1 声明式** | 零代码，出问题最好定位，AI 也最容易生成对 |
| 纯计算：文本变换、哈希、编码解码、规则计算 | **L2 WASM** | 强沙箱，无文件系统/网络，跑飞了也只是烧 CPU |
| 需要生态库、模型推理、大文件处理 | **L3 Python** | 完整 Python 生态，但**不是内核级沙箱**，权限要慎重 |

三级运行时的定义在 `plugin.rs` 的 `PluginRuntime` 枚举里，取值是
`pipeline` / `wasm` / `python`（见下面的 `runtime.kind`）。

**最常见的错误设计**：用 L2 的 WASM 做图像解码/缩放/抠图。WASM 沙箱里
没有文件系统、没有 SIMD、payload 还有 16 MB 上限，这条路是死的。
图片处理请用 L1（内置 `image.*` 节点）或 L3。

---

## 1. L1 插件：`plugin.yaml` 逐字段讲解

L1 插件**只有一个文件**（可以再加一个 `README.md` 给人看）。下面这份是完整的可用清单，
每一段后面都跟字段说明。

```yaml
apiVersion: toolforge/v1
kind: Plugin

metadata:
  id: com.example.image-convert
  name: 图片格式转换
  version: 0.1.0
  description: 在 PNG / JPEG / WebP 之间互转。
  author: 你的名字
  license: MIT
  icon: image
  category: image
  tags: [图片, 转换]
  homepage: https://example.com

permissions:
  - kind: fsRead
    scope: { kind: input }
  - kind: fsWrite
    scope: { kind: output }

io:
  inputs:
    - id: src
      label: 源图片
      type: file
      accept: ["image/*"]
      multiple: true
      required: true
  outputs:
    - id: dst
      label: 输出图片
      type: file
      required: false
  params:
    - id: format
      label: 目标格式
      type: enum
      default: { kind: str, value: webp }
      options:
        - { value: png, label: PNG }
        - { value: webp, label: WebP }
      required: true
      affectsOutput: true

runtime:
  kind: pipeline
  pipeline:
    description: 单节点流水线。
    onError: fail
    timeoutMs: 0
    steps:
      - id: convert
        uses: image.convert
        label: 转换格式
        with:
          src: "${src}"
          dst: "${output.dst}"
```

### 1.1 顶层字段

| YAML 字段 | Rust 字段 | 必填 | 说明 |
|---|---|---|---|
| `apiVersion` | `api_version` | ✅ | **必须等于 `toolforge/v1`**（常量 `PLUGIN_API_VERSION`）。不匹配报 `API_VERSION_MISMATCH` |
| `kind` | `kind` | ✅ | **必须等于 `Plugin`**，否则报 `KIND_INVALID` |
| `metadata` | `metadata` | ✅ | 见 1.2 |
| `permissions` | `permissions` | 可省 | 能力声明，形状是 `{ capabilities: [...] }`，见 1.5 与第 6 节 |
| `io` | `io` | 可省 | 输入/输出/参数，见 1.3 |
| `runtime` | `runtime` | ✅ | 三选一：`pipeline` / `wasm` / `python` |
| `ai` | `ai` | 可省 | AI 生成溯源。人工手写的插件**不要写这个字段** |

> ⚠️ **所有字段名都是 camelCase**。Rust 结构体里是 `snake_case`，
> 但每个结构都标了 `#[serde(rename_all = "camelCase")]`，所以 YAML 里必须写
> `apiVersion` / `onError` / `timeoutMs` / `memoryLimitMb` / `allowHostFunctions` /
> `pythonVersion` / `affectsOutput` / `dependsOn`。写错成 snake_case 会直接
> 解析失败（报"插件清单 YAML 解析失败 + missing field"）。

### 1.2 `metadata`

| 字段 | 必填 | 规则 |
|---|---|---|
| `id` | ✅ | **只允许小写字母、数字、`.`、`-`、`_`，长度 3..=128**。建议反向域名风格。违规报 `ID_FORMAT`（空则 `ID_EMPTY`） |
| `name` | ✅ | 显示名，非空（空报 `NAME_EMPTY`），可以是中文 |
| `version` | ✅ | **必须是合法 semver**（`semver::Version::parse`），例如 `0.1.0`、`1.2.3-beta.1`。违规报 `VERSION_INVALID` |
| `description` | 可省 | 一句话说明，显示在插件卡片上 |
| `author` / `license` / `homepage` | 可省 | 自由文本 |
| `icon` | 可省 | **Lucide 图标名**，例如 `image`、`scissors`、`film`、`palette`、`type` |
| `category` | 可省 | 取值：`image` / `audio` / `video` / `document` / `archive` / `ebook` / `text` / `dev` / `ai` / `system` / `other`。**默认 `other`**，写错会解析失败 |
| `tags` | 可省 | 字符串数组，用于搜索 |

### 1.3 `io`（端口与参数）

`io.inputs` / `io.outputs` 都是 `IoPort` 数组，`io.params` 是 `ParamSpec` 数组。

**端口 `IoPort`**

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 端口 id，在**输入+输出合并后必须唯一**（重复报 `IO_DUPLICATE_ID`，空报 `IO_EMPTY_ID`） |
| `label` | ✅ | 显示名 |
| `type` | ✅ | 见下表（camelCase） |
| `accept` | 可省 | MIME 或扩展名通配数组，例如 `["image/*", ".png"]`；空表示不限 |
| `multiple` | 可省 | 是否接受多个文件，默认 `false` |
| `required` | 可省 | 是否必填，默认 `false` |
| `description` | 可省 | 提示文案 |

`type` 的取值（`PortType`，camelCase）：`file`、`files`、`directory`、`text`、
`number`、`boolean`、`json`、`any`。

**参数 `ParamSpec`**

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 参数 id，**同一插件内唯一**（重复报 `PARAM_DUPLICATE_ID`）。**重要**：节点的可调参数是按 id 从 `io.params` 里读的，所以 id 必须与节点读取的键名一致（见 3.3） |
| `label` | ✅ | 显示名 |
| `type` | ✅ | 见下表（camelCase） |
| `description` | 可省 | 帮助文案 |
| `default` | 可省 | 默认值，写成 `{ kind: ..., value: ... }`，见下 |
| `options` | `enum` 必填 | 候选值数组 `[{ value, label }]`。**`enum` 类型不给 options 会报 `ENUM_WITHOUT_OPTIONS`** |
| `min` / `max` | 可省 | 数值范围；`min > max` 报 `PARAM_RANGE_INVERTED` |
| `step` | 可省 | 数值步长 |
| `required` | 可省 | 是否必填，默认 `false` |
| `placeholder` | 可省 | 输入框占位符 |
| `multiline` | 可省 | 文本参数是否用多行输入框 |
| `affectsOutput` | 可省 | 该参数变化是否需要重新探测输入（UI 联动用） |

`type` 的取值（`ParamType`，camelCase）：`text`、`textarea`、`int`、`float`、
`bool`、`enum`、`multiEnum`、`path`、`directory`、`color`、`keyValue`。

**默认值的写法**（`ParamValue`，带 `kind` 判别式）：

| 参数类型 | 默认值写法 |
|---|---|
| `text` / `textarea` / `path` / `directory` / `color` / `keyValue` | `{ kind: str, value: "webp" }` |
| `int` | `{ kind: int, value: 90 }` |
| `float` | `{ kind: float, value: 1.5 }` |
| `bool` | `{ kind: bool, value: true }` |
| `enum` | `{ kind: str, value: webp }`（**取值必须命中某个 option.value**，否则报 `PARAM_DEFAULT_TYPE` 警告） |
| `multiEnum` | `{ kind: list, value: [a, b] }` |

> 默认值与声明类型不匹配只会产生 **warning**（`PARAM_DEFAULT_TYPE`），
> 不会拒绝装载；但错的默认值会在运行时变成"看起来跑通了但结果不对"，请务必对齐。

### 1.4 `runtime`：三种运行时

`runtime.kind` 决定后面挂哪个子对象：

```yaml
runtime:
  kind: pipeline      # L1
  pipeline: { ... }

runtime:
  kind: wasm          # L2
  wasm: { ... }

runtime:
  kind: python        # L3
  python: { ... }
```

`PluginRuntime::requires_artifact()` 的含义：**L1 不需要额外产物**（只凭清单就能装载），
L2/L3 都需要插件目录里带 `wasm` 文件或 `main.py`。

| 运行时 | 子字段 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `pipeline` | `description` | 可省 | — | 人类可读描述 |
| | `steps` | ✅ | — | 步骤数组，**不能为空**（空报 `PIPELINE_EMPTY`） |
| | `onError` | 可省 | `fail` | `fail` / `skip` / `continue` / `retry` |
| | `timeoutMs` | 可省 | `0`（不限） | 整条流水线超时；**0 < 值 < 1000 会报 `PIPELINE_TIMEOUT_TOO_SHORT` 警告** |
| `wasm` | `path` | ✅ | — | 相对插件目录的 wasm 文件名（空报 `WASM_PATH_EMPTY`，不以 `.wasm` 结尾报 `WASM_EXT` 警告） |
| | `entry` | 可省 | `run` | 导出函数名，必须与 `#[plugin_fn]` 标注的函数名一致 |
| | `memoryLimitMb` | 可省 | `64` | 必须在 1..=4096（否则 `WASM_MEMORY_RANGE`） |
| | `timeoutMs` | 可省 | `5000` | 必须 > 0（否则 `WASM_TIMEOUT`）。会被换算成 wasmtime 的**燃料**上限，不是墙钟 |
| | `allowHostFunctions` | 可省 | `[]` | **只允许 `log` 与 `kv`**，其它值报 `WASM_HOST_FN_UNKNOWN` |
| `python` | `entry` | ✅ | — | 入口脚本（空报 `PY_ENTRY_EMPTY`，不以 `.py` 结尾报 `PY_ENTRY_EXT` 警告） |
| | `pythonVersion` | 可省 | `"3.11"` | 宿主用它挑 sidecar 运行时 |
| | `requirements` | 可省 | `[]` | pip 依赖，见 4.3 的禁止项 |
| | `timeoutMs` | 可省 | `300000` | 单次调用超时，超时后**杀进程** |
| | `workers` | 可省 | `1` | 必须在 1..=8（否则 `PY_WORKERS_RANGE`） |
| | `allowNetwork` | 可省 | `false` | 为 `true` 时清单里必须有 `net` 能力，否则报 `PYTHON_NET_WITHOUT_PERMISSION` |

**`PluginStep`（`pipeline.steps[i]`）**

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 步骤 id，流水线内唯一（空报 `STEP_ID_EMPTY`，重复报 `STEP_ID_DUPLICATE`） |
| `uses` | ✅ | **内置节点名**，必须存在于 `builtin_nodes()`（否则 `STEP_UNKNOWN_NODE`）。见第 3 节全表 |
| `with` | 可省 | 参数模板。**值必须是字符串**，见 1.6 |
| `label` | 可省 | 流程编辑器里的节点标题 |
| `when` | 可省 | 跳过条件，语法极简，见 1.6 |
| `onError` | 可省 | 覆盖流水线级策略 |
| `retry` | 可省 | 重试次数。声明了 `onError: retry` 但 `retry: 0` 会报 `STEP_RETRY_ZERO` 警告 |
| `timeoutMs` | 可省 | 单步超时 |
| `position` | 可省 | `{ x, y }` 画布坐标，**由前端写回，宿主不解释** |
| `dependsOn` | 可省 | 依赖的步骤 id 数组。必须指向**存在且更早**的步骤（不存在报 `STEP_DEP_MISSING`，指向自己或后续报 `STEP_DEP_CYCLE`）；为空表示按声明顺序串行 |

`onError` 的语义（`OnErrorPolicy`）：

| 值 | 行为 |
|---|---|
| `fail`（默认） | 中止整个任务 |
| `skip` | 跳过该步继续（**不写错误变量**） |
| `continue` | 跳过该步继续，并把失败原因写进 `${steps.<id>.error}` |
| `retry` | 重试 `retry` 次后仍失败则按流水线级策略处理 |

### 1.5 `permissions`（**形状写错是最常见的失败原因**）

`PermissionSet` 是一个**带字段的结构体**，形状是 `{ capabilities: [ ... ] }`。
`permission.rs` 的注释里写得很明确：

> ⚠️ 这里**刻意不加** `#[serde(transparent)]`：加了之后 YAML 会变成
> `permissions: [ ... ]` 这种裸数组，既不好读也没法在未来扩展字段。
> 现在的形状是 `permissions: { capabilities: [ ... ] }`，
> 所有示例插件与文档都按这个形状写。

```yaml
# ✅ 正确：带 capabilities 字段
permissions:
  capabilities:
    - kind: fsRead
      scope: { kind: input }
    - kind: fsWrite
      scope: { kind: output }

# ✅ 正确：不申请任何能力（L2 常用）
permissions:
  capabilities: []

# ❌ 错误：裸数组会解析失败
permissions:
  - kind: fsRead
    scope: { kind: input }
```

写错时报的是：
`permissions: invalid type: sequence, expected struct PermissionSet`。

> 📌 **历史提醒**：`PermissionSet` 曾经带过 `#[serde(transparent)]`，那时正确的写法是
> 裸数组。**该属性已被移除**，现在是上面这个映射形式。如果你看到任何一份
> 声称"`permissions` 是序列"的文档或示例，那是旧版本的写法，不要照抄。
> （`permission.rs` 的注释、`plugin.rs` / `store.rs` / `toolforge-ai` 的夹具都已统一到映射形式。）

权限声明**不等于**授权：用户还要在「插件详情 → 权限」里逐条勾选，
运行时真正生效的是 `声明 ∩ 已授权`。详见第 5 节。

### 1.6 `with` 与变量模板

**`with` 的值只能是字符串**（Rust 类型是 `BTreeMap<String, String>`）。
写 `width: 1280` 会报 `invalid type: integer '1280', expected a string`，
必须写 `width: "1280"` 或 `width: "${params.width}"`。

变量语法（来自 `pipeline.rs` 的模块文档与 `l1.rs` 的模板上下文构造）：

| 语法 | 含义 | 备注 |
|---|---|---|
| `${src}` | 本次任务的**第一个**输入文件路径 | `l1.rs` 取的是"第一个有值的输入端口里的第一个路径"，与端口叫什么无关。**单文件场景用它最省事** |
| `${dst}` | 输出端口里的第一个目标路径，**按清单声明的端口顺序**取 | ✅ 结果是确定的（不再是 `HashMap` 的迭代顺序）。多输出端口时仍建议写全 `${output.<端口>}`，读起来更清楚 |
| `${input.<portId>}` | 该输入端口的全部路径，**逗号连接** | 多文件时是 `"a.png,b.png"`，不能直接当单个路径用 |
| `${input.<portId>.first}` | 该输入端口的第一个路径 | 只在**恰好一个**文件时才被插入 |
| `${output.<portId>}` | 宿主已分配好的该输出端口目标路径 | **推荐一律用这个显式写法** |
| `${params.<id>}` | 用户填的参数值 | 统一转成字符串：`Int(90)` → `"90"`，`Float(90.0)` → `"90"`，`Bool(true)` → `"true"`，`List` → 逗号连接 |
| `${steps.<stepId>.<key>}` | 前序步骤产出的值 | **只能引用更早的步骤**；引用后续步骤报 `TEMPLATE_FORWARD_REF`，引用不存在的步骤报 `TEMPLATE_UNKNOWN_STEP`。可用的 `key` 见 3.4 |
| `${env.<NAME>}` | 宿主显式注入的白名单环境变量 | 只有宿主注入的才可用 |
| `${steps.<stepId>.error}` | 该步骤失败原因 | 仅当该步 `onError` 为 `continue` / `skip` 时被写入 |

**未解析的变量是错误，不是空串。** `render_template` 遇到未知变量会返回
`PluginInvalid` 错误（附"可用的变量：input.* / output.* / params.* / steps.* / env.*"），
因为静默留空会产生"看起来跑通了但结果不对"的 bug —— 这在批量处理里是灾难。

> ✅ **`${vars.<name>}` 已可用**：`flow.set-var` 写入的变量会在后续步骤里以
> `${vars.<名称>}` 暴露（`l1.rs` 每步结束后把 `ctx.vars` 桥接进模板上下文）。
> 同一份值也能用 `${steps.<setVarStepId>.value}` 引用，两者等价。
>
> 曾经这里写的是"`vars.*` 未实现，请改用 `steps.*`" —— 那个说法当时是对的，
> 现在已随 `l1.rs` 的修复失效。节点目录里 `flow.set-var` 的承诺现在是事实。

**`when` 条件**（`eval_condition`）刻意不做通用表达式引擎——通用表达式意味着通用执行：

| 写法 | 含义 |
|---|---|
| `${params.mode} == fast` | 字符串相等比较（先渲染再比较，两侧 trim） |
| `${params.mode} != fast` | 字符串不等比较 |
| `${params.flag}` | 真值判断：非空且不等于 `false` / `0` / `no` / `off` 即为真 |

条件里的变量解析不了 **直接报错**（当成清单写错），不会静默变成 `false`。

---

## 2. 校验：`PluginManifest::validate()`

`validate()` 是**纯函数**——不碰磁盘、不联网。所以它可以在 AI 生成流程里
**写盘之前**调用，这是"先校验再落盘"的关键。

返回 `ValidationReport { ok, issues: [{ severity, code, message, path }] }`：
只要**有一条 `error`**，`ok` 就是 `false`，插件不能装载。
`warning` / `info` 不阻止装载，但 UI 会显示出来（`severity` 取值 `error` / `warning` / `info`）。

### 2.1 全部错误码

**`plugin.rs` 里产生的**

| 码 | 级别 | 触发条件 |
|---|---|---|
| `API_VERSION_MISMATCH` | error | `apiVersion` ≠ `toolforge/v1` |
| `KIND_INVALID` | error | `kind` ≠ `Plugin` |
| `ID_EMPTY` | error | `metadata.id` 为空 |
| `ID_FORMAT` | error | `metadata.id` 含非法字符或长度不在 3..=128 |
| `NAME_EMPTY` | error | `metadata.name` 为空 |
| `VERSION_INVALID` | error | `metadata.version` 不是合法 semver |
| `IO_DUPLICATE_ID` | error | 输入/输出端口 id 重复 |
| `IO_EMPTY_ID` | error | 端口 id 为空 |
| `PARAM_DUPLICATE_ID` | error | 参数 id 重复 |
| `ENUM_WITHOUT_OPTIONS` | error | `type: enum` 但没给 `options` |
| `PARAM_RANGE_INVERTED` | error | `min > max` |
| `PARAM_DEFAULT_TYPE` | warning | 默认值与声明类型不匹配 |
| `WASM_PATH_EMPTY` | error | `wasm.path` 为空 |
| `WASM_EXT` | warning | `wasm.path` 不以 `.wasm` 结尾 |
| `WASM_MEMORY_RANGE` | error | `memoryLimitMb` 不在 1..=4096 |
| `WASM_TIMEOUT` | error | `wasm.timeoutMs` = 0 |
| `WASM_HOST_FN_UNKNOWN` | error | `allowHostFunctions` 含 `log` / `kv` 之外的值 |
| `WASM_WITH_PERMISSIONS` | warning | WASM 运行时却声明了非空权限（几乎肯定是设计错误） |
| `PY_ENTRY_EMPTY` | error | `python.entry` 为空 |
| `PY_ENTRY_EXT` | warning | `python.entry` 不以 `.py` 结尾 |
| `PY_REQ_EMPTY` | error | `requirements` 里有空条目 |
| `PY_REQ_UNSAFE` | error | `requirements` 含 URL / VCS / 本地路径依赖 |
| `PY_WORKERS_RANGE` | error | `workers` 不在 1..=8 |
| `PYTHON_NET_WITHOUT_PERMISSION` | error | `allowNetwork: true` 但没声明 `net` 能力 |
| `CRITICAL_CAPABILITY` | warning | 申请了风险等级为 Critical 的能力（目前只有 `Exec`） |
| `HOST_PATH_WRITE` | warning | 申请了写宿主机显式路径（见第 5 节的已知缺陷） |

**`pipeline.rs` 里产生的**

| 码 | 级别 | 触发条件 |
|---|---|---|
| `PIPELINE_EMPTY` | error | `steps` 为空 |
| `STEP_ID_EMPTY` | error | 步骤 id 为空 |
| `STEP_ID_DUPLICATE` | error | 步骤 id 重复 |
| `STEP_UNKNOWN_NODE` | error | `uses` 不是 `builtin_nodes()` 里的节点名 |
| `STEP_DEP_MISSING` | error | `dependsOn` 指向不存在的步骤 |
| `STEP_DEP_CYCLE` | error | `dependsOn` 指向自身或后续步骤（流水线必须是 DAG） |
| `TEMPLATE_UNKNOWN_STEP` | error | `${steps.x.y}` 里的 `x` 不存在 |
| `TEMPLATE_FORWARD_REF` | error | `${steps.x.y}` 引用了后续步骤（不允许前向引用） |
| `STEP_RETRY_ZERO` | warning | `onError: retry` 但 `retry: 0` |
| `PIPELINE_TIMEOUT_TOO_SHORT` | warning | `timeoutMs` 在 1..1000 之间 |

`ValidationIssue.path` 字段会被填成例如 `runtime.pipeline.steps[0]`，方便定位。

### 2.2 运行时错误码（IPC 层）

插件跑起来之后出的错用 `ErrorCode`（序列化成 `SCREAMING_SNAKE_CASE`，
前端按它分支）。与插件开发最相关的几个：

| 码 | 什么时候出现 |
|---|---|
| `ENGINE_MISSING` | 节点需要的引擎没装（`ToolforgeError::engine_missing`） |
| `ENGINE_FAILED` | 引擎存在但调用失败 |
| `PLUGIN_INVALID` | 清单解析/校验失败、模板变量解析失败 |
| `PLUGIN_RUNTIME` | WASM trap / Python 崩溃 / 内存超限 |
| `PLUGIN_CAPABILITY_VIOLATION` | 插件用了未声明（或未授权）的能力 —— **这是安全事件，会写审计日志** |
| `PERMISSION_DENIED` | 路径越权、绝对路径、未授权作用域 |
| `TIMEOUT` | 步骤/流水线/插件调用超时（WASM 表示"燃料耗尽"） |
| `CANCELLED` | 用户点了取消 |
| `INTEGRITY_CHECK_FAILED` | 插件目录在安装后被改动，装载前哈希校验不通过 |
| `NETWORK` / `INTEGRITY_CHECK_FAILED` | 引擎下载失败 / 下载产物哈希不匹配 |
| `IO` / `SERDE` / `INTERNAL` / `INVALID_ARGUMENT` / `NOT_FOUND` | 通用错误 |

---

## 3. 内置节点清单（**从 `builtin_nodes()` 如实摘录**）

⚠️ 两点必须先知道：

1. **登记 ≠ 已实现**。下面 31 个节点都登记在节点目录里（所以流程编辑器能拖出来、
   清单也能通过校验），但 `toolforge-engines/src/nodes.rs` 的 `run()` 目前只实现了
   **25 个**；标 🚧 的 6 个会返回
   「内置节点 `X` 尚未在 v0.1 中实现」。
2. **节点参数写在 `with` 里或 `io.params` 里都可以，`with` 优先**。
   执行器用 `ctx.param_str("format", "webp")` 这类调用取值，它会**先看当前步骤的 `with`、
   再看插件自己的 `io.params`（按同名 id）、最后回退默认值**（见 `NodeCtx::arg_scope`）。

   推荐的分工是：

   - **路径与流程接线**（`src` / `dst` / `path` / `name` / `duration`）放 `with`，用
     `"${src}"` / `"${dst}"` 这类模板注入；
   - **用户可调的选项**（格式、质量、宽度、模型名）放 `io.params`，在 `with` 里写
     `format: "${params.format}"`。这样参数才会出现在 UI 表单里，用户能改。

   参数 **id 必须与节点读取的键名逐字一致**（例如 `image.convert` 读 `format` / `quality`）。
   `with` 的值**必须是字符串**（写 `width: 1280` 会报 `invalid type: integer`，要写 `"1280"`）。

   > 这条曾经是"只能写 `io.params`，写 `with` 完全无效" —— 而几乎所有人（包括 LLM）
   > 的直觉都是写 `with`，于是参数被**静默忽略**、用户拿到默认值却不知道。
   > 现在两种写法都生效，且 `with` 里的显式字面量优先（它更具体）。

### 3.1 文件操作（`file`）

| 节点名 | 中文名 | 必需引擎 | 可选引擎 | 从 `with` 读的参数 | 说明 |
|---|---|---|---|---|---|
| `fs.copy` | 复制文件 | — | — | `src`、`dst`、`overwrite` | 把输入文件复制到输出路径 |
| `fs.move` | 移动文件 | — | — | `src`、`dst`、`overwrite` | 同盘 rename；跨盘自动降级为复制+删除 |
| `fs.mkdir` | 创建目录 | — | — | `path` | 递归创建目录 |
| `fs.delete` | 删除文件 | — | — | `src` | 删除文件或目录。**需要 fsWrite 权限** |

### 3.2 图片（`image`）

| 节点名 | 中文名 | 必需引擎 | 可选引擎 | 参数 id（从 `io.params` 读） | 说明 |
|---|---|---|---|---|---|
| `image.probe` | 读取图片信息 | — | — | — | 读尺寸/格式/色彩空间。纯 Rust，无需外部引擎 |
| `image.convert` | 图片格式转换 | — | libvips、imagemagick | `format`、`quality` | PNG/JPEG/WebP/BMP/TIFF/GIF 互转 |
| `image.resize` | 图片缩放 | — | libvips、imagemagick | `width`、`height`、`filter` | Lanczos3 重采样；只给一边时另一边按比例推导（**两边都不给会报错**） |
| `image.crop` | 裁剪 / 缩略图 | — | libvips、imagemagick | `mode`、`width`、`height`、`x`、`y` | `mode` 取 `center`/`custom`/`smart`（`smart` 目前与 `center` 相同） |
| `image.rotate` | 旋转 / 翻转 | — | imagemagick | `angle`、`flipH`、`flipV`、`autoOrient` | 非 90° 倍数的角度**需要 ImageMagick**，缺失时报 `ENGINE_MISSING` |
| `image.enhance` | 图像增强 | — | libvips | `brightness`、`contrast`、`saturation`、`sharpen` | 纯 Rust 走内置卷积 |
| `image.strip-metadata` | 清除元数据 | — | libvips、imagemagick | — | 重新编码即不保留 EXIF/IPTC/XMP |
| `image.remove-background` | 抠图去背景 🚧 | python、onnx-models | — | `model`、`alphaMatting`、`backgroundColor` | AI 抠图；**v0.1 未实现** |

**图像格式的真实支持情况**：纯 Rust 后端的 `parse_format` 支持
`png` / `jpeg` / `webp` / `bmp` / `tiff` / `gif` / `ico` / `pnm` / `qoi` / `tga` /
`dds` / `hdr` / `ff`。**`avif` 不在其中**（节点目录的枚举里列了它，但纯 Rust 后端
会报"不支持的图片格式 `avif`"并提示装 libvips 或 ImageMagick）。
另外纯 Rust 的 **WebP 编码只有无损模式**，会在任务日志里打一条警告。

> 🚧 **libvips / ImageMagick 目前只是"声明"而非"实现"**：`nodes.rs` 里除
> `image.rotate` 的非直角分支外，图像节点全部只走纯 Rust 路径。所以
> "检测到 libvips 自动提速"这句话目前还没有落地。

### 3.3 视频（`video`）与音频（`audio`）

| 节点名 | 中文名 | 必需引擎 | 参数 id | 说明 🚧=未实现 |
|---|---|---|---|---|
| `video.transcode` | 视频转码 | ffmpeg | `container`、`vcodec`、`acodec`、`crf`、`preset`、`hwaccel` | 完整实现 |
| `video.extract-audio` | 提取音频 | ffmpeg | `format`、`bitrate` | 完整实现 |
| `video.thumbnail` | 视频截图 | ffmpeg | `at`、`width`、`format` | 完整实现 |
| `video.trim` | 视频剪辑 | ffmpeg | `start`、`reencode`、`duration`(从 `with`) | 完整实现 |
| `video.compress` | 视频压缩 | ffmpeg | `targetSizeMb`、`maxWidth` | 完整实现（两遍编码） |
| `audio.convert` | 音频格式转换 | ffmpeg | `format`、`bitrate`、`sampleRate` | 完整实现 |
| `audio.normalize` | 音量标准化 | ffmpeg | `lufs` | EBU R128 响度归一 |

### 3.4 文档 / 压缩包 / 电子书 / AI / 流程控制

| 节点名 | 中文名 | 必需引擎 | 可选引擎 | 参数 id | 说明 |
|---|---|---|---|---|---|
| `doc.convert` | 文档格式转换 | pandoc | — | `to`、`standalone`、`toc`、`extraArgs` | Markdown/HTML/DOCX/EPUB/LaTeX 互转 |
| `doc.to-pdf` | 转 PDF（Office） | libreoffice | — | `format` | Word/Excel/PPT → PDF |
| `doc.ocr` | OCR 文字识别 🚧 | python | tesseract | `engine`、`lang` | **v0.1 未实现** |
| `archive.pack` | 打包压缩 | 7zip | — | `format`、`level`、`password` | zip / 7z / tar / tar.gz / tar.xz |
| `archive.unpack` | 解压 | 7zip | — | `password`、`keepStructure` | 内置 Zip Slip 防护 |
| `ebook.convert` | 电子书转换 🚧 | — | calibre、pandoc | `format`、`title`、`author` | **v0.1 未实现** |
| `ai.upscale` | AI 超分辨率 🚧 | python、onnx-models | — | `model`、`scale` | **v0.1 未实现** |
| `ai.describe` | AI 图像描述 🚧 | ai-provider | — | `instruction`、`maxTokens` | **v0.1 未实现** |
| `flow.branch` | 条件分支 | — | — | `condition` | 见下方说明 |
| `flow.set-var` | 设置变量 | — | — | `name`、`value` | 写入流水线变量；产出 `${steps.<id>.value}` |
| `flow.log` | 写日志 | — | — | `message`、`level` | 见下方说明 |
| `flow.foreach` | 批量循环 🚧 | — | — | `concurrency` | **v0.1 未实现**（见下方说明） |

> ✅ **流程控制节点的真实状态**（曾经三条都写着"未实现/空实现"，现已修复）：
>
> | 节点 | 状态 | 行为 |
> |---|---|---|
> | `flow.set-var` | ✅ 可用 | 写入 `vars.<名称>`，后续步骤用 `${vars.<名称>}` 引用 |
> | `flow.log` | ✅ 可用 | **真的往任务日志写一条**（`message` 为空时报 `PluginInvalid`） |
> | `flow.branch` | ✅ 可用 | 求值 `condition`，产出 `${steps.<id>.active}` = `"true"`/`"false"` |
> | `flow.foreach` | 🚧 未实现 | 落到 `not_implemented`。**批量由命令层展开**，清单里不需要它 |
>
> `flow.log` 与 `flow.branch` 曾经是**空实现** —— 直接返回空的 `NodeOutput`，
> 不报错也不做事。那是最难排查的一类行为：用户以为节点在跑，日志里却什么都没有、
> 分支永远不成立。现在两者都有回归测试钉住
> （`flow_log_actually_writes_to_the_job_log`、`flow_branch_produces_a_usable_value`）。
>
> `flow.branch` **刻意不做隐式控制流**：它只产出一个布尔值，
> 由后续步骤自己用 `when: ${steps.<id>.active} == true` 消费 ——
> 隐式分支会让你无法从单个步骤的定义判断它会不会被执行。

### 3.5 哪些节点会产出可供 `${steps.x.y}` 引用的值

这一步在 `nodes.rs` 里是显式写明的（很多节点用 `NodeOutput::file()`，它**只登记产出文件、
不产出可引用的值**）：

| 节点 | 可引用的 key |
|---|---|
| `image.probe` | `width`、`height`、`color`、`megapixels` |
| `image.resize` | `width`、`height` |
| `image.crop` | `width`、`height` |
| `fs.copy`、`fs.move` | `path` |
| `image.convert` | `path` |
| `fs.mkdir` | `path` |
| `archive.unpack` | `path` |
| `flow.set-var` | `value` |
| 其它（如 `video.thumbnail`、`video.transcode`） | **没有可引用的值** —— 只能通过 `${output.<portId>}` 传路径 |

**因此：想做"多步文件接力"，正确做法是给插件声明两个输出端口，用
`${output.frame}` / `${output.dst}` 传路径，而不是指望 `${steps.frame.dst}`。**
可运行的例子见 `plugins/builtin/video-to-gif/plugin.yaml`。

---

## 4. L2 WASM 插件开发指南

### 4.1 能力边界（**先读这一节**）

L2 跑在 Extism + Wasmtime 上，宿主**关闭了 WASI**。这意味着插件：

- ❌ **没有文件系统**（连 `open` 都没有）
- ❌ **没有网络**
- ❌ **没有线程**（WASM 线程需要 shared memory + COOP/COEP，Extism 未启用）
- ⚠️ **没有 SIMD**（wasmtime 默认不给 Extism 模块开 `simd`）
- ✅ 有确定性的整数/浮点运算
- ✅ 通过宿主函数白名单可以 `log`（`kv` 推迟到 v0.2）

**所以 L2 只适合"输入一串字节、输出一串字节"的纯计算**：文本处理、哈希、
编码转换、规则计算、数据校验。

**做不了图像处理**，原因有三：
1. 没有文件系统 → 图片数据必须由宿主全量拷进沙箱，一张 4K RAW 就是几百 MB；
2. 没有 SIMD → 解码/缩放/推理比原生慢几十倍；
3. **payload 上限 16 MB**（`runtimes/wasm.rs` 的 `MAX_INPUT_BYTES`），
   超过直接报 `INVALID_ARGUMENT`。

### 4.2 资源限制：燃料而不是墙钟

`wasm.timeoutMs` 在装载时被换算成 wasmtime 的**燃料上限**
（`fuel_for_timeout`：按 1e8 燃料/秒估算，并有 1e7 的下限）。
燃料耗尽会 trap，调用直接返回 `TIMEOUT` 错误。

为什么用燃料？因为关闭 WASI 后的 WASM **无法阻塞**（没有 I/O、没有 sleep），
它唯一能做的就是烧 CPU。烧 CPU 用燃料计量既精确又可中断；反过来，
如果为了"墙钟超时"把调用丢到另一个线程再 `timeout`，超时后那个线程还在烧 CPU，
那只是**假装**超时。

内存：`memoryLimitMb` 换算成 64 KiB 页并夹在 16 页（1 MiB）到 65536 页（4 GiB）之间。
超限报 `PLUGIN_RUNTIME`。

### 4.3 从 Rust 编译到 `wasm32-wasip1`

```powershell
# 1) 装目标（只需一次）
rustup target add wasm32-wasip1

# 2) 建工程：Cargo.toml 里 crate-type 必须是 cdylib
#    [lib]
#    crate-type = ["cdylib"]
#    [dependencies]
#    extism-pdk = "1.4"
#    anyhow = "1"
#    serde = { version = "1", features = ["derive"] }
#    serde_json = "1"

# 3) 编译
cargo build --target wasm32-wasip1 --release

# 4) 把产物复制成清单里 wasm.path 指定的名字
Copy-Item .\target\wasm32-wasip1\release\<crate_name>.wasm .\plugin.wasm
```

> ⚠️ 如果插件工程放在仓库的 `plugins/` 下，**必须在它自己的 `Cargo.toml` 里加一行
> `[workspace]`**，否则 cargo 会去找仓库根的 workspace 并报
> "current package believes it's in a workspace when it's not"。

完整可运行例子：`plugins/wasm-example/`（`plugin.yaml` + `Cargo.toml` + `src/lib.rs`）。

### 4.4 Extism PDK 用法

```rust
use extism_pdk::*;
use serde::Deserialize;

#[derive(Deserialize)]
struct RunRequest {
    /// 输入端口 id -> **路径/值列表**（即使只有一个值也是数组）
    #[serde(default)]
    input: std::collections::BTreeMap<String, Vec<String>>,
    /// 参数 id -> 值
    #[serde(default)]
    params: std::collections::BTreeMap<String, String>,
    /// 逻辑作用域 -> 真实根目录
    #[serde(default)]
    paths: std::collections::BTreeMap<String, String>,
    /// 本次调用实际生效的能力标签
    #[serde(default)]
    capabilities: Vec<String>,
}

// 函数名必须等于清单里的 runtime.wasm.entry（默认 run）
#[plugin_fn]
pub fn run(input: Json<RunRequest>) -> FnResult<Json<serde_json::Value>> {
    // info!/warn!/error!/debug!/trace! 都能用，走 Extism 内置的日志导入
    info!("收到 {} 个输入端口", input.0.input.len());
    Ok(Json(serde_json::json!({ "outputs": {} })))
}
```

要点：

- **输入**：宿主把 `PluginCallRequest::payload` 序列化成 JSON 字节传进来
  （字段见上面结构体，与 `runtimes.rs` 的文档一致）。
- **返回**：**必须是 JSON**。宿主先按 JSON 解析，解析不了才宽容地退化成裸字符串。
- **错误**：返回 `FnResult` 的 `Err`（`anyhow!` 的错误会带上 return code），
  宿主会把它变成 `PLUGIN_RUNTIME` 错误。
- **日志**：用 `extism_pdk` 的 `info!` 等宏；它们走 **Extism 内置的
  `extism_log_*` 导入**，宿主把日志回调接到了 `tracing`。
  所以**即使不申请 `log` 宿主函数也能打日志** —— 见下一节。

### 4.5 宿主函数白名单

`wasm.allowHostFunctions` **只接受 `log` 与 `kv`** 两个值，其它值报
`WASM_HOST_FN_UNKNOWN`，插件根本装不上。

但要如实知道 v0.1 的现状：

- 宿主**不注入任何自定义宿主函数**。`log` 之所以能用，是因为它是 Extism 的内置导入；
  清单里的 `log` 只是"声明意图"。
- **`kv` 尚未实现**（需要给 Extism Manifest 配 KV store，计划在 v0.2）。
  现在写 `kv` 能通过校验，但运行时拿不到。

宿主这样做是刻意的：宿主函数是**唯一**能从沙箱伸出手来的口子，
每加一个都要单独做安全评估，宁可不加。

### 4.6 L2 清单模板

```yaml
runtime:
  kind: wasm
  wasm:
    path: plugin.wasm
    entry: run
    memoryLimitMb: 64
    timeoutMs: 5000
    allowHostFunctions: ["log"]
```

**不要**声明任何 `fs*` / `net` 权限 —— L2 用不到，而且校验器会给出
`WASM_WITH_PERMISSIONS` 警告，说明作者大概率理解错了运行时。

---

## 5. L3 Python 插件开发指南

### 5.1 宿主提供的隔离（诚实版）

宿主启动插件进程时做了这些事（见 `runtimes/python.rs` 与 `supervisor.rs`）：

| 措施 | 说明 |
|---|---|
| 独立进程 | 插件崩了不会带崩主程序 |
| **清空继承的环境变量** | 只留 `PATH`，所以 `OPENAI_API_KEY` 之类读不到 |
| 注入的变量 | `TOOLFORGE_PLUGIN_ID`、`TOOLFORGE_CAPABILITIES`（逗号分隔的能力标签，如 `fsRead,fsWrite`）、`PYTHONNOUSERSITE=1` |
| **不给 `PYTHONPATH`** | 避免插件意外 import 到宿主的包 |
| 锁定工作目录 | cwd = 插件目录 |
| **默认断网** | 通过指向 `127.0.0.1:1` 的代理环境变量实现 |
| `python -u` 启动 | 禁止 stdout 缓冲，否则协议帧会卡在缓冲区 |
| 独立 venv | 每个插件的依赖装在 `<plugin>/.venv`，与系统 Python 和其它插件隔离 |
| 超时 | `python.timeoutMs`（默认 300000ms），**超时后直接杀掉进程** |
| 优雅关闭 | 先发 `shutdown`，5 秒宽限，然后强杀 |

> ⚠️ **这不是内核级沙箱。** 一个蓄意的插件可以直接用 `socket` 绕过代理环境变量、
> 可以读它进程能读的任何文件。真正的隔离需要 Windows Job Object + AppContainer、
> macOS `sandbox-exec`、Linux seccomp，这些在路线图里。
> **所以不要对用户宣称"L3 是沙箱"** —— 这句话来自 `runtimes.rs` 的原文意思。
> L3 的安全依赖两件事：用户真的看了权限清单 + 审计日志能事后追溯。

### 5.2 JSON-RPC 协议帧

传输格式：**一行一个 JSON 对象**，UTF-8，**行内不允许裸换行**
（`json.dumps` 默认就不会产生）。**stdout 只跑协议**，
任何调试输出必须走 **stderr** —— 一个 `print()` 就会毒化协议流。
（宿主对无法解析的行做了容错，会当成插件日志，但不要依赖它。）

帧模型定义在 `crates/toolforge-process/src/rpc.rs`。

**方法总表**

| 方法 | 方向 | 说明 |
|---|---|---|
| `initialize` | 宿主 → 插件 | 一次性握手。返回 `{}` 即可；返回 `-32601` 表示"我不实现握手"，宿主会按无状态插件处理 |
| `run` | 宿主 → 插件 | 单次处理。`params` 就是 `PluginCallRequest::payload` |
| `shutdown` | 宿主 → 插件 | 释放模型、关文件。超时后强杀 |
| `progress` | 插件 → 宿主 | **通知**：`{ "value": 0.3, "stage": "加载模型" }` |
| `log` | 插件 → 宿主 | **通知**：`{ "level": "info", "message": "..." }` |
| `host.request` | 插件 → 宿主 | **会被拒绝**：宿主明确不允许运行期提权，只记一条警告 |

**请求 / 响应 / 通知示例**

```jsonc
// 宿主 → 插件：握手
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
  "pluginId":"com.example.palette",
  "apiVersion":"toolforge/v1",
  "entry":"main.py",
  "paths":{"input":"C:\\...\\in","output":"C:\\...\\out","data":"...","work":"..."},
  "timeoutMs":300000
}}

// 插件 → 宿主：握手结果（返回任意 JSON 都行）
{"jsonrpc":"2.0","id":1,"result":{"ok":true,"protocolVersion":"2.0"}}

// 宿主 → 插件：执行
{"jsonrpc":"2.0","id":2,"method":"run","params":{
  "input":{"src":["C:\\...\\a.png"]},
  "params":{"count":"5","ignoreNearWhite":"true"},
  "paths":{"input":"...","output":"...","data":"...","work":"..."},
  "capabilities":["fsRead","fsWrite"]
}}

// 插件 → 宿主：进度通知（无 id）
{"jsonrpc":"2.0","method":"progress","params":{"value":0.5,"stage":"正在统计颜色"}}

// 插件 → 宿主：日志通知
{"jsonrpc":"2.0","method":"log","params":{"level":"info","message":"载入模型完成"}}

// 插件 → 宿主：成功响应
{"jsonrpc":"2.0","id":2,"result":{"outputs":{"swatch":"C:\\...\\out\\a-palette.png"}}}

// 插件 → 宿主：错误响应
{"jsonrpc":"2.0","id":2,"error":{"code":-32602,"message":"count 超出 1..=16：99"}}
```

**错误码**（必须用这套，宿主按它分类）：

| 码 | 常量名 | 含义 |
|---|---|---|
| `-32700` | PARSE_ERROR | 请求不是合法 JSON |
| `-32600` | INVALID_REQUEST | 请求结构非法 |
| `-32601` | METHOD_NOT_FOUND | 方法不存在（也用于"我不实现 initialize"） |
| `-32602` | INVALID_PARAMS | 参数非法 |
| `-32603` | INTERNAL_ERROR | 插件内部错误 |
| `-32001` | PERMISSION_DENIED | 插件拒绝执行（例如缺少能力授权） |
| `-32002` | TIMEOUT | 执行超时 |
| `-32003` | PROCESS_GONE | 进程已退出 |
| `-32004` | NOT_INITIALIZED | 还没调 `initialize` 就调了 `run` |

**通知的字段限制**：宿主处理 `progress` 时**只读 `value` 与 `stage`**，
`currentItem` / `speed` / `etaSeconds` 会被忽略（L1 的 `JobProgress` 有这些字段，
但 L3 的桥接目前没接）。所以**别把重要信息只放在被忽略的字段里**。

### 5.3 完整可运行骨架

```python
import io, json, sys

def main() -> int:
    # Windows 上默认 cp936 + \r\n 会破坏帧格式，必须显式指定
    stdin = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8", newline="\n")
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    sys.stderr.reconfigure(encoding="utf-8", newline="\n")

    def write(obj):
        sys.stdout.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()          # 必须 flush，否则宿主会以为插件卡死

    for line in stdin:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        method, req_id = msg.get("method"), msg.get("id")
        if req_id is None:          # 通知：不回应
            continue
        if method == "shutdown":
            write({"jsonrpc": "2.0", "id": req_id, "result": {"ok": True}})
            return 0
        write({"jsonrpc": "2.0", "id": req_id, "result": {}})

if __name__ == "__main__":
    sys.exit(main())
```

完整例子（含 `initialize` / `run` / 进度上报 / 路径收敛 / 错误分类）见
`plugins/python-example/main.py`，它已经用真实协议端到端跑通过。

### 5.4 `requirements` 的限制

宿主会为插件建独立 venv 并调用 pip 安装。**清单校验会拒绝**下面这些写法（报 `PY_REQ_UNSAFE`）：

| 拒绝的写法 | 原因 |
|---|---|
| `pkg @ https://evil.example/x.tar.gz` | URL 依赖 |
| `git+https://...` / 任何含 `://` 的条目 | VCS / URL |
| `-e .` / 任何以 `-` 开头的条目 | pip 选项注入 / 本地路径 |
| `pkg @ file:///...` | 本地路径 |

允许的写法：`pkg`、`pkg==1.2.3`、`pkg>=1.2,<2`。建议**钉死版本**（`Pillow==10.4.0`）。

另外宿主 pip 安装时带了 `--only-binary=:all:`，即**只接受 wheel**：
没有预编译 wheel 的包会安装失败，插件会被标记为不可用（而不是静默降级）。
安装失败时宿主返回的错误 `detail` 里会带上完整依赖列表与 pip 的 stderr。

### 5.5 常驻进程与模型缓存

- `workers` 默认 1。**这个插件进程是常驻的**：`initialize` 只调一次，
  之后每个任务都是一次 `run`。所以重模型（ONNX/PyTorch）应该**在
  `initialize` 或首次 `run` 时加载一次并缓存在模块级变量里**，
  不要每次 `run` 都重新加载。
- `workers > 1` 只在"模型加载很贵且要并发多任务"时才有意义，
  否则只是多份内存。上限 8。
- 插件私有的持久化目录由 `paths.data` 给出（逻辑作用域 `pluginData`），
  适合放**跨任务保留**的缓存（例如自己下载的权重、索引）。
  `paths.work` 是本次任务的临时目录，任务结束会被宿主清理。

### 5.6 超时与取消

- 超时由宿主持有（`python.timeoutMs`），**插件不需要自己实现超时**。
  超时后宿主会**杀掉进程**——因为超时的 Python 可能卡在原生扩展里，
  继续等它没有意义。
- 因此：**处理大文件时要周期性上报 `progress`**。这不只是体验问题：
  任务一旦看起来"没动静"，用户就会点取消。
- 取消的实现方式是**杀进程**（宿主在任务被取消时不再等待）。
  建议仍然在处理循环里检查一个"协作式取消"标志（见示例里的
  `notifications/cancel` 处理），这样将来宿主支持优雅取消时你不用改代码。
- 请在 `shutdown` 里释放资源（关文件、释放模型、停线程），
  宿主只给 5 秒宽限。

### 5.7 L3 清单模板

```yaml
runtime:
  kind: python
  python:
    entry: main.py
    pythonVersion: "3.11"
    requirements: ["Pillow==10.4.0"]
    timeoutMs: 300000
    workers: 1
    allowNetwork: false
```

---

## 6. 权限声明速查表

权限在清单里写成**序列**（见 1.5）。每一项是一个带 `kind` 判别式的对象。

| Capability | YAML 写法 | 中文含义 | 风险等级 |
|---|---|---|---|
| `FsRead` | `{ kind: fsRead, scope: { kind: input } }` | 读文件 —— 读取本次任务的输入文件 | **低** |
| | `{ kind: fsRead, scope: { kind: output } }` | 读文件 —— 写入本次任务的输出目录（原文如此） | 低 |
| | `{ kind: fsRead, scope: { kind: pluginData } }` | 读文件 —— 读写插件自己的数据目录 | 低 |
| | `{ kind: fsRead, scope: { kind: workspace } }` | 读文件 —— 读写本次任务的临时目录 | 低 |
| `FsWrite` | `{ kind: fsWrite, scope: { kind: input } }` | 写文件 —— 读取本次任务的输入文件 | **中** |
| | `{ kind: fsWrite, scope: { kind: output } }` | 写文件 —— 写入本次任务的输出目录 | 中 |
| | `{ kind: fsWrite, scope: { kind: pluginData } }` | 写文件 —— 读写插件自己的数据目录 | 中 |
| | `{ kind: fsWrite, scope: { kind: workspace } }` | 写文件 —— 读写本次任务的临时目录 | 中 |
| `Net` | `{ kind: net, hosts: ["api.openai.com", "*.huggingface.co"] }` | 访问网络（仅限这些主机） | **中** |
| `Net` | `{ kind: net, hosts: [] }` | 访问网络（**任意主机，无限制**） | **高** |
| `Exec` | `{ kind: exec }` | 启动外部进程 | **极高** |
| `Env` | `{ kind: env, names: ["HF_HOME"] }` | 读取指定的环境变量（按名字白名单） | 中 |
| `Ai` | `{ kind: ai }` | 调用 AI 服务（消耗你的额度） | 低 |
| `Gpu` | `{ kind: gpu }` | 使用 GPU | 低 |

关于上表的几个要点：

- 风险等级来自 `Capability::risk()`，UI 用它决定确认弹窗的配色与文案强度。
  整体风险 = 所有能力里**最高**的那一档（`PermissionSet::risk_level()`）。
- **`Exec` 等价于任意代码执行**。能起子进程就基本等于拿到用户权限，
  它是唯一被标为 `Critical` 的能力，校验器会对它发出 `CRITICAL_CAPABILITY` 警告。
- **`Net { hosts: [] }` 是"任意主机"**，不是"没有网络"。想限制就用非空列表。
  匹配规则是精确相等或 `*.example.com` 形式的后缀匹配，注意 `*.huggingface.co`
  **会**匹配裸 `huggingface.co`。
- **`Env` 是按名字白名单的**（防止插件顺手读走 API key），
  但真正的防线在 L3 的"清空继承环境变量"上。
- 路径作用域只有四种"沙箱内"的值：`input` / `output` / `pluginData` / `workspace`。
  插件**拿不到真实绝对路径**，它只能用逻辑作用域，由宿主翻译。

> 🚧 **`PathScope::Explicit` 目前无法在清单里表达（已知缺陷）**：
> `PathScope` 用了 `#[serde(tag = "kind")]`（内部标签），而 `Explicit(String)`
> 是 newtype 变体且内容是字符串 —— serde 无法用带标签的映射表达它。
> 实测结果：清单里写 `scope: { kind: explicit, value: "C:/x/**" }` 或
> `scope: { kind: explicit }` 都会解析失败，报
> `permissions: invalid type: map, expected a string`。
> 所以**不要**在清单里尝试 `explicit`；如果你真的需要访问固定系统目录，
> 目前只能等这个 schema 缺陷修掉（建议改成
> `Explicit { glob: String }` 这样的 struct 变体）。

---

## 7. 常见错误与排查

### 7.1 清单装载失败

| 现象 / 错误码 | 原因 | 修法 |
|---|---|---|
| `API_VERSION_MISMATCH` | `apiVersion` 不是 `toolforge/v1` | 照抄 `toolforge/v1`（大小写敏感） |
| `KIND_INVALID` | 少了 `kind: Plugin` 或写错 | 补上 |
| `ID_FORMAT` / `ID_EMPTY` | id 里有大写、空格、中文，或长度不在 3..=128 | 只用小写字母、数字、`.`,`-`,`_` |
| `VERSION_INVALID` | 版本不是合法 semver（比如写成了 `0.1`） | 写 `0.1.0` |
| `plugin_invalid: 插件清单 YAML 解析失败 —— missing field \`xxx\`` | 字段名写成了 snake_case | YAML 里一律 camelCase |
| `permissions: invalid type: sequence, expected struct PermissionSet` | `permissions` 写成了裸数组 | 改成 `permissions: { capabilities: [...] }`（1.5） |
| `invalid type: integer \`1280\`, expected a string` | `with` 里写了数字 | 加引号：`"1280"` 或 `"${params.width}"` |
| `未知字段` / 解析失败 | 写了 schema 里没有的字段 | 对照 1.1~1.4 的字段表；serde 默认**拒绝未知字段**（无 `deny_unknown_fields` 时会被忽略，但拼错的字段会导致必填项丢失） |
| `ENUM_WITHOUT_OPTIONS` | `type: enum` 没给 `options` | 补上候选值 |
| `STEP_UNKNOWN_NODE` | `uses` 不是内置节点名 | 对照第 3 节全表，**逐字**核对（大小写、连字符） |
| `TEMPLATE_FORWARD_REF` | `${steps.x.y}` 引用了后面的步骤 | 要么把被引用的步骤往前挪，要么改用 `${output.<portId>}` 传路径（3.5） |
| `TEMPLATE_UNKNOWN_STEP` | `steps.<id>` 里的 id 拼错 | 核对步骤 id |
| `STEP_DEP_CYCLE` | `dependsOn` 指到了自己或后续步骤 | 流水线必须是 DAG |
| `PY_REQ_UNSAFE` | 依赖里带 URL / VCS / 本地路径 | 改成 `pkg==版本` |
| `PYTHON_NET_WITHOUT_PERMISSION` | `allowNetwork: true` 但没声明 `net` | 要么关掉 `allowNetwork`，要么加 `net` 能力 |
| `WASM_HOST_FN_UNKNOWN` | `allowHostFunctions` 里写了 `log`/`kv` 之外的东西 | 只留这两个 |
| `WASM_MEMORY_RANGE` | `memoryLimitMb` 不在 1..=4096 | 常用 64 |
| `WASM_TIMEOUT` | `timeoutMs: 0` | WASM 是纯计算，不允许无限运行 |
| `PY_WORKERS_RANGE` | `workers` 不在 1..=8 | 一般就用 1 |

### 7.2 运行期失败

| 错误码 / 现象 | 原因 | 修法 |
|---|---|---|
| `ENGINE_MISSING`（`subject` 是引擎 id） | 节点需要的引擎没装。受影响的节点见第 3 节 | 在「引擎管理」里安装；或换用无引擎依赖的节点 |
| `内置节点 \`X\` 尚未在 v0.1 中实现` | 你用了 🚧 的节点 | 见 3.2~3.4 的实现状态列；当前请改用已实现的节点或写 L3 |
| `模板变量 \`${x}\` 无法解析` | 变量名写错，或引用了不存在的端口/参数 | 对照 1.6 的变量表；注意 `${dst}` 只在输出端口唯一时才可靠 |
| `路径逃逸被拦截` | 路径里带了 `..` 跑到授权目录之外 | 用相对路径或 `/input/...` 这类逻辑前缀；**不允许绝对路径** |
| `插件不允许使用绝对路径` | 同上 | 同上 |
| 步骤失败但任务显示"跳过" | `onError` 是 `skip` / `continue` | 看 `Job.warnings` 与 `${steps.<id>.error}`；想快速失败就用 `fail` |
| `TIMEOUT` | 步骤/流水线超时，或 WASM 燃料耗尽 | 调大 `timeoutMs`；WASM 的话先检查是不是死循环 |
| `PLUGIN_CAPABILITY_VIOLATION` | 插件用了未声明或未授权的能力 | **这是安全事件**：补声明后让用户重新授权，或去掉该行为 |
| `INTEGRITY_CHECK_FAILED` | 插件目录在安装后被改动过 | 重新安装插件；不要手工改已安装的插件文件 |
| L2：`WASM 模块里没有导出函数 \`run\`` | `wasm.entry` 与 `#[plugin_fn]` 的函数名不一致 | 让两者一致 |
| L2：`WASM 模块编译失败` | 目标不是 `wasm32-wasip1`，或用了 Extism 不支持的导入 | 用 `--target wasm32-wasip1` 重新编译 |
| L2：`传给 WASM 插件的载荷 N MB 超过 16 MB 上限` | 想用 WASM 处理大文件 | 换 L1 或 L3 —— 这是设计边界，不是 bug |
| L3：`插件启动了但永远不响应` | stdout 没 flush，或 `print()` 污染了协议流 | 每写一帧都 `flush()`；日志一律写 stderr |
| L3：`尚未调用 initialize`（`-32004`） | `initialize` 抛异常/超时了 | 看 stderr；`initialize` 里不要做重活 |
| L3：`为插件安装依赖失败` | 依赖没有 wheel（宿主用 `--only-binary=:all:`），或版本不存在 | 换成有 wheel 的版本；错误 `detail` 里有 pip 的原始输出 |
| L3：依赖装好了却 `ImportError` | 宿主用 venv 里的解释器，不继承系统 site-packages | 把所有依赖写进 `requirements` |
| 插件跑完但没产出文件 | 输出路径没落到 `${output.<portId>}`，或节点只产出中间文件 | 检查每个步骤的 `dst`；L3 请把产物写到 `paths.output` 下 |

### 7.3 自查清单（提交插件前）

1. `apiVersion` = `toolforge/v1`，`kind` = `Plugin`，字段名全 camelCase。
2. `metadata.id` 是小写 + 点/横线/下划线，长度 3..=128；`version` 是 semver。
3. `permissions` 写成 `{ capabilities: [...] }`（**不是**裸数组），且**只申请真正需要的**能力（多余能力会吓退用户）。
4. 每个 `uses` 都能在第 3 节表里逐字找到。
5. 每个 `enum` 参数都有 `options`，每个 `default` 的 `kind` 与 `type` 匹配。
6. 节点的可调参数 id 与节点读取的键名一致（例如 `format`、`quality`、`width`）。
7. `with` 的值全是字符串；`${steps.x.y}` 只引用更早的步骤。
8. 输出端口多于一个时，**不要**用 `${dst}`，改用 `${output.<portId>}`。
9. L2：`allowHostFunctions` 只写 `log`；不声明任何 `fs`/`net` 权限。
10. L3：`requirements` 不带 URL/VCS/本地路径；每条帧写完都 flush；日志走 stderr。
11. 用 `PluginManifest::validate()` 自查一遍（宿主装载前也会跑它）。

---

## 8. 参考

| 想看什么 | 去哪里 |
|---|---|
| 可以直接抄的完整例子 | `plugins/builtin/image-convert/`（L1 单节点）、`plugins/builtin/video-to-gif/`（L1 多步 + `${steps.x.y}`）、`plugins/builtin/batch-rename/`（批量循环形状）、`plugins/builtin/remove-bg/`（引擎依赖 + 模型选择）、`plugins/wasm-example/`（L2）、`plugins/python-example/`（L3） |
| 引擎与许可证矩阵、降级路径 | `docs/ENGINE-MATRIX.md` |
| 架构与数据流 | `docs/ARCHITECTURE.md` |
| 安全模型与权限风险 | `docs/SECURITY.md` |
| 各阶段的实现进度 | `docs/ROADMAP.md` |
| 清单 schema 权威定义 | `crates/toolforge-core/src/plugin.rs` |
| 节点目录权威定义 | `crates/toolforge-core/src/pipeline.rs` 的 `builtin_nodes()` |
| 节点**实现** | `crates/toolforge-engines/src/nodes.rs` |
