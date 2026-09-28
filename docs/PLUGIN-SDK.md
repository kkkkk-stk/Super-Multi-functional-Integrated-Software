# ToolForge 插件 SDK

> 面向**插件作者**。本文档的一切字段名、节点名、错误码都以代码为准：
> 清单 schema 来自 `crates/toolforge-core/src/plugin.rs`，流水线来自
> `crates/toolforge-core/src/pipeline.rs`，能力模型来自
> `crates/toolforge-core/src/permission.rs`，节点执行器来自
> `crates/toolforge-engines/src/nodes.rs`，L2/L3 宿主来自
> `crates/toolforge-plugins/src/runtimes.rs` 及其子模块。
> 代码改了这里没改就是文档的 bug，请提 issue。
>
> **仓库正在开发中**：标 ⛔ 的表示尚未落地。**节点目录已经全部实现**（32/32，
> `UNIMPLEMENTED_NODES` 是空数组），剩下的 🚧 集中在**运行时的非节点能力**上
> （例如 L2 的 `kv` 宿主函数、`PathScope::Explicit` 的 schema 缺陷）。

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

#### 批处理变量：`${batch.*}`（清单里**不需要**循环节点）

宿主在**命令层**把一次运行扇出成 N 个单文件批次（`commands.rs::expand_batches`），
每个批次单独调用一次本流水线。流水线自己不知道"我跑了几次"，所以序号由宿主注入：

| 语法 | 含义 |
|---|---|
| `${batch.index}` | 当前批次序号，**从 1 起**（`l1.rs` 保证最小为 1） |
| `${batch.zeroIndex}` | 当前批次序号，从 0 起（做"第一个之外"这类判断时比 `index - 1` 干净） |
| `${batch.total}` | 批次总数，即本次任务要处理的文件数（最小为 1） |

**两条展开规则**（都在命令层，清单里看不到）：

1. **目录 → 里面的文件**。拖进一个**文件夹**时，宿主先把它展开成其中的文件，再逐个处理 —— 所以"拖一个文件夹进去"就是"逐个处理里面每个文件"，不需要循环节点。
   - **只展开一层**（不递归：递归会让"我拖了个文件夹"变成"翻遍整个照片库"；需要递归就自己选下级目录）；
   - 只收普通文件，**跳过子目录、符号链接和 `.` 开头的隐藏文件**（含 macOS 的 `._` 资源叉）；
   - 结果**排序**（目录枚举顺序在文件系统之间没有保证，不排序的话 `${batch.index}` 每次都不同）；
   - **上限 5000 个文件，超过直接报错**（`INVALID_ARGUMENT`，提示"请分批拖入，或者先按子目录拆开"）。**刻意不静默截断** —— 截断会让你以为处理完了。
   - 授权根也跟着变严：输入是目录时，`input_root` 取**那个目录自身**，不再是它的父级。
2. **多文件 → 逐文件**。选**文件数最多**的那个输入端口作主端口来扇出，其余端口的值在每一批里原样保留。单文件输入退化为一次调用。
   - 因此**主端口在每一批里只剩一个路径**：`${src}`、`${input.<port>}` 与 `${input.<port>.first}` 在批处理下指的都是**当前批次那一个文件**（不会再出现"逗号连接的一长串"）。

> 所以 `plugins/builtin/batch-rename` 那种"批量重命名"需求，正确写法是用
> `${batch.index}` / `${src.stem}` 构造新文件名，而**不是**去找一个循环节点。
> （`${src.stem}` / `${src.ext}` / `${src.name}` 由宿主按**当前批次**的输入文件注入，
> 见 `l1.rs` 的模板上下文构造。）

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

1. **登记 = 已实现。现在没有未实现的节点了。** 下面 32 个节点都登记在节点目录里，
   而且 `toolforge-engines/src/nodes.rs` 的 `run()` **32 个分发臂全部指向真实实现**：
   `toolforge_core::pipeline::UNIMPLEMENTED_NODES` 是**空数组**。
   > ✅ **这条原来说的是「32 个登记、28 个已实现，标 🚧 的 4 个会返回"尚未实现"」**（更早是 27/5、26/6）。
   > 最后一个离队的是上一轮的 `image.remove-background`，本轮一次补齐了 `ebook.convert`、
   > `ai.describe`、`doc.ocr`、`ai.upscale` 四个。所以**表里已经没有 🚧 节点了**。
   > `UNIMPLEMENTED_NODES` 常量**仍然保留**（现在是空的），因为前端还靠
   > `NodeCatalogResponse.unimplemented` 来决定"哪些节点要标灰"——
   > **那段灰显逻辑是"休眠但保留"的**：现在永远不会命中，但下次加节点时它会立刻生效。
   > 别因为"名单是空的"就把前端那段代码或这个常量删掉。
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
| `fs.delete` | 删除文件 | — | — | `src` | 删除文件或目录。**需要 fsWrite 权限**。⚠️ **是永久删除，不进回收站** —— 这个节点曾经声明过一个 `toTrash` 参数（默认 `true`，标签写着「移到回收站而非永久删除」），而执行器一行都没读它，实际一直硬删。「回收站支持」已从声明里撤掉、列为 v0.2 待办（`docs/ROADMAP.md`）；**在那之前，界面与文档一处都不许再提"回收站"**。 |

### 3.2 图片（`image`）

| 节点名 | 中文名 | 必需引擎 | 可选引擎 | 参数 id（从 `io.params` 读） | 说明 |
|---|---|---|---|---|---|
| `image.probe` | 读取图片信息 | — | — | — | 读尺寸/格式/色彩空间。纯 Rust，无需外部引擎 |
| `image.convert` | 图片格式转换 | — | libvips、imagemagick | `format`、`quality` | PNG/JPEG/WebP/BMP/TIFF/GIF 互转。**输出 `backend`**（`libvips` / `imagemagick` / `rust`）。装了 libvips 时 WebP/JPEG 才按 `quality` 走**有损**编码；纯 Rust 后端的 WebP **只有无损** |
| `image.resize` | 图片缩放 | — | libvips、imagemagick | `width`、`height`、`filter` | Lanczos3 重采样；只给一边时另一边按比例推导（**两边都不给会报错**）。**输出 `backend`** |
| `image.crop` | 裁剪 / 缩略图 | — | libvips、imagemagick | `mode`、`width`、`height`、`x`、`y` | `mode` 取 `center`/`custom`/`smart`（`smart` 目前与 `center` 相同）。**输出 `backend`** |
| `image.rotate` | 旋转 / 翻转 | — | libvips、imagemagick | `angle`、`flipH`、`flipV`、`autoOrient` | 非 90° 倍数需要**会重采样的后端**：libvips（`similarity --angle`）或 ImageMagick（`-rotate`），libvips 优先；**两者都没有时报 `ENGINE_MISSING`**（detail 让你去装 libvips 或 ImageMagick），**不会静默把角度取整**。`autoOrient`（默认 `true`）按文件里的 EXIF 方向先把图摆正 —— 手机竖拍的照片带 Orientation=6，关掉它就会拿到一张躺着的图。三个后端语义一致（libvips `autorot` → 旋转、ImageMagick 输入后的 `-auto-orient`、纯 Rust `apply_orientation`），PNG 之类没有方向的格式是空操作。**输出 `backend`** |
| `image.enhance` | 图像增强 | — | — | `brightness`、`contrast`、`saturation`、`sharpen` | 纯 Rust 走内置卷积。**该节点不参与三层降级、没有 `backend` 输出，`optionalEngines` 也已清空** —— 此前它声明了 `libvips`，而实现里一个引擎都不调，界面因此会宣称一个并不存在的加速（已修，见 [ENGINE-MATRIX.md](ENGINE-MATRIX.md) 6.2） |
| `image.strip-metadata` | 清除元数据 | — | — | — | 重新编码即不保留 EXIF/IPTC/XMP。**纯 Rust 实现，不调用 libvips / ImageMagick，也没有 `backend` 输出**；`optionalEngines` 同样已清空（理由同上） |
| `image.remove-background` | 抠图去背景 | python、onnx-models | — | `model`、`mode`、`background`、`threshold`、`feather` | AI 抠图。**已实现**（此前是"登记了但执行器没写"）。走一条**独立的 ONNX 推理链**，不属于上面的 libvips / ImageMagick / 纯 Rust 三层降级（见下）。`model` 默认 `u2netp`（4.4 MB），可选 `u2net` / `isnet-general`；`mode` 取 `alpha`（透明背景 PNG）或 `color`（换纯色底，用 `background`）。**首次运行有两步一次性准备**：用户自己去「模型权重」下权重，应用再建一个独立 venv 装 `onnxruntime` / `numpy` / `pillow`（约 30 MB，**这一步要联网**）。之后推理全在本地，**不联网、不上传图片** |

**图像格式的真实支持情况**：纯 Rust 后端的 `parse_format` 支持
`png` / `jpeg` / `webp` / `bmp` / `tiff` / `gif` / `ico` / `pnm` / `qoi` / `tga` /
`dds` / `hdr` / `ff`。**`avif` 不在其中**（节点目录的枚举里列了它，但纯 Rust 后端
会报"不支持的图片格式 `avif`"并提示装 libvips 或 ImageMagick）。
另外纯 Rust 的 **WebP 编码只有无损模式**，会在任务日志里打一条警告
（**装了 libvips 之后这条警告不会再出现**，因为届时走的是有损编码）。

> ✅ **libvips / ImageMagick 现在真的会被调用 —— 但只对 4 个节点。**
> `nodes.rs::pick_image_backend()` 按 `libvips → ImageMagick → 纯 Rust` 挑后端，
> 并把结果报出来：节点输出里多一个 **`backend`** 值（`"libvips"` / `"imagemagick"` / `"rust"`），
> 任务日志里多一条 debug 行（形如 `image.convert：后端 = libvips（快、省内存）；a.png → a.webp（质量 90）`）。
> 走这条链的是 **`image.convert` / `image.resize` / `image.crop` / `image.rotate`**；
> **`image.enhance` 与 `image.strip-metadata` 不走**（纯 Rust 实现，没有 `backend` 输出）。
> 后端选择是**可观测**的这一设计是有意的 —— 代码注释写得很直白：不看日志就只能靠猜，
> 而这个项目已经被"文档说有、实际没有"坑过好几次。
> 详细的降级矩阵见 [ENGINE-MATRIX.md](ENGINE-MATRIX.md) 第 5.1 节；
> 声明侧 5 处 `provides` ↔ 节点声明的漂移（就是上面那两个节点的 `libvips` 声明）
> 已经全部修掉，并由一条双向测试 `provides_matches_node_declarations` 守着，见同文档 6.2 节。
>
> **别把 libvips 的收益说成"文件一定更小"**：它带来的是**按质量换体积的能力**
> （WebP/JPEG 有损编码），这对照片很重要，但在一张**合成渐变**图上，无损反而可能更小
> （实测 320×200 渐变：无损 508 字节 vs 有损 1808 字节）。

> 🆕 **抠图是第四条路，别把它算进上面那条三层链。**
> `image.remove-background` 已实现，跑的是 **ONNX 推理**（`nodes.rs::image_remove_background`
> → Python 子进程 → `onnxruntime`），**不调用 `pick_image_backend()`**，
> 所以它**没有 `backend` 输出**，装了 libvips / ImageMagick 也不会让它快一点。
> 反过来说，它需要的是**另外两个引擎**（`python` + `onnx-models`），两者都是必需项。
> 细节见 [ENGINE-MATRIX.md](ENGINE-MATRIX.md) 第 3.2、5.2 节。
>
> ⚠️ **它旧参数里的 `alphaMatting` 已被删除**，那是一个**假参数**：从登记那天起就没有
> 任何实现，用户在表单里勾上它，什么都不会发生。参数 id 与节点读取的键名对不上时
> 宿主会**静默用默认值** —— 这正是本项目反复强调"参数 id 必须逐字一致"的原因
> （见 3. 开头的第 2 条）。现在的真实参数是 `model` / `mode` / `background` /
> `threshold` / `feather`，同样**没有** `backgroundColor`（旧名字，已改为 `background`）。

### 3.3 视频（`video`）与音频（`audio`）

| 节点名 | 中文名 | 必需引擎 | 参数 id | 说明 |
|---|---|---|---|---|
| `video.transcode` | 视频转码 | ffmpeg | `format`、`vcodec`、`acodec`、`crf`、`preset`、`hwaccel` | 完整实现。**`format` 决定输出容器**（它经 `build_io` 变成输出扩展名，ffmpeg 按扩展名选 muxer）—— 这个参数以前叫 `container`，而那是**装饰性的**：选 mkv 也会产出 `.mp4` |
| `video.extract-audio` | 提取音频 | ffmpeg | `format`、`bitrate` | 完整实现 |
| `video.thumbnail` | 视频截图 | ffmpeg | `at`、`width`、`format` | 完整实现 |
| `video.trim` | 视频剪辑 | ffmpeg | `start`、`duration`、`reencode` | 完整实现。`reencode` 为 false 时走流复制（快，但切片边界会吸附到关键帧）；需要精确到帧就打开它 |
| `video.compress` | 视频压缩 | ffmpeg | `targetSizeMb`、`maxWidth` | 完整实现（两遍编码） |
| `audio.convert` | 音频格式转换 | ffmpeg | `format`、`bitrate`、`sampleRate` | 完整实现 |
| `audio.normalize` | 音量标准化 | ffmpeg | `lufs` | EBU R128 响度归一 |

### 3.4 文档 / 压缩包 / 电子书 / AI / 流程控制

| 节点名 | 中文名 | 必需引擎 | 可选引擎 | 参数 id | 说明 |
|---|---|---|---|---|---|
| `doc.convert` | 文档格式转换 | pandoc | — | `to`、`standalone`、`toc`、`extraArgs` | Markdown/HTML/DOCX/EPUB/LaTeX 互转 |
| `doc.to-pdf` | 转 PDF（Office） | libreoffice | — | — | Word/Excel/PPT/ODF → PDF。**没有可调参数**：这个节点就叫 `to-pdf`。它此前声明过一个 `format`（pdf / pdf-a / html / txt），而执行器**从来没读过它** —— 那是个装饰性参数，而且危险：真按 html 输出的话，输出文件仍由宿主按端口声明的扩展名命名，用户会拿到一个**叫 `.pdf` 的 HTML**（`ebook.convert` 上已经打过一次这个坑）。参数已删掉。**注意**：`format` 这类"名字很通用"的参数一旦从目录里删掉，文档里那一格也必须跟着改 —— 否则照着文档写插件的人会用到一个不存在的参数，而【23】这条检查就是拦这个的 |
| `doc.ocr` | OCR 文字识别 | — | tesseract、ai-provider、poppler | `engine`、`lang`、`pdfDpi`、`pdfMaxPages` | **已实现**。有 tesseract 就走它（离线、免费、快）；没有就用**多模态模型**（更强但要联网计费）。`engine` 取 `auto` / `tesseract` / `ai`（默认 `auto`）；`lang` 默认 `chi_sim+eng`；`pdfDpi`（默认 150）与 `pdfMaxPages`（默认 0 = 全部）只在**输入是 PDF** 时有意义。**✅ PDF 输入现在是支持的**：装了 `poppler` 就先用 `pdftoppm -png -r <pdfDpi>` 逐页栅格化，再逐页识别，输出里用 `===== 第 N 页 =====` 分隔（`verify-platform.mjs`【15】真机验证：3 页 PDF → 假端点收到 3 次请求、渲染尺寸符合 DPI 预期）。没有 poppler 时**明确拒绝** PDF 输入并给出两条出路。输出可引用 `text` 与 `backend`（`tesseract` 或 `ai-vision`）。**三个引擎都是可选的**：`requiresEngines` 为空，所以只装 Tesseract 的机器照样能用 |
| `archive.pack` | 打包压缩 | 7zip | — | `format`、`level`、`password` | zip / 7z / tar / tar.gz / tar.xz |
| `archive.unpack` | 解压 | 7zip | — | `password`、`keepStructure` | 内置 Zip Slip 防护 |
| `ebook.convert` | 电子书转换 | — | calibre、pandoc | `format`、`title`、`author` | **已实现**。`calibre` 优先（MOBI/AZW3/LIT/PDF 只有它能写），缺了退到 `pandoc`（EPUB/DOCX/FB2/HTML/Markdown/RTF/ODT/TXT）。**超出 pandoc 能力表的格式会在调用前被拒绝**（理由见下）。输出可引用 `backend`（`calibre` / `pandoc`） |
| `ai.upscale` | AI 超分辨率 | python、onnx-models | — | `model`、`scale`、`tile`、`overlap` | **已实现**。Real-ESRGAN 分块推理。`model` 默认 `realesr-general-x4v3`（4.9 MB，可换 `realesrgan-anime6b`）；`scale` 默认 4（可选 2/3 —— **先用 4 倍推理再 Lanczos 缩回去**）；`tile` 默认 256、`overlap` 默认 16。输出可引用 `path`、`model`、`backend`、`width`、`height`。**纯本地推理，不上传图片** |
| `ai.describe` | AI 图像描述 | ai-provider | — | `instruction`、`maxTokens`、`maxSide` | **已实现**。调视觉模型生成描述与标签。`maxSide` 默认 1024（发送前把最长边缩到这个值再转 **JPEG q85** 内联发送，因为视觉计费随像素增长）；`maxTokens` 默认 512。输出可引用 `text` 与 `model`。⚠️ **需要视觉模型**（纯文本模型会回 400），且**图片会上传给 AI 服务商**，见 `docs/SECURITY.md` |
| `flow.branch` | 条件分支 | — | — | `condition` | 见下方说明 |
| `flow.set-var` | 设置变量 | — | — | `name`、`value` | 写入流水线变量；产出 `${steps.<id>.value}` |
| `flow.log` | 写日志 | — | — | `message`、`level` | 见下方说明 |
| `text.replace` | 文本替换 | — | — | `input`、`pattern`、`replacement`、`useRegex`、`caseSensitive`、`all` | 纯计算、不碰文件。对字符串做查找替换（支持正则与大小写控制），输出可被 `${steps.<id>.text}` 引用。**`batch-rename` 的改名规则就靠它** |
| `name.build` | 拼装文件名 | — | — | `stem`、`ext`、`prefix`、`suffix`、`index`、`indexPad`、`indexSeparator`、`indexPosition`、`case`、`separator` | 纯计算：把主干 / 扩展名 / 前缀 / 后缀 / 序号拼成一个**文件名**（不含目录），接到 `fs.move` 的 `dst` 上就是"按规则改名"。`batch-rename` 与 `ai-describe` 都在用 |

> ⚠️ **`ebook.convert` 为什么必须"在调用前"把关，而不是相信子进程的退出码**：
> pandoc 对认不出的输出扩展名**不报错** —— 它打一句
> `[WARNING] Could not deduce format from file extension .mobi` + `Defaulting to html`，
> 然后**退出码 0**、文件也真的生成了，只是那是一个 HTML 文件被命名成了 `.mobi`。
> 认不出**输入**格式时更糟：它会把文件当纯文本读，产出垃圾。
> 所以执行器先按两张能力表（`PANDOC_EBOOK_IN` / `PANDOC_EBOOK_OUT`）检查扩展名，
> 不通过就直接拒绝并要求装 Calibre。**"成功"的坏文件比失败更糟** —— 这一条值得记在脑子里。
>
> **`ai.describe` / `doc.ocr` 的 AI 路径要你先把 AI 配好**：没配服务商或 API Key 时它们
> 会在**解码图片之前**就报错（先花几百毫秒解码再告诉用户"没配 Key"是没必要的等待，
> 还会让错误看起来像图片的问题）。`ai.describe` 在服务端回 400 时会额外提示
> 「很可能是这个模型不支持图片输入」，并让你去换视觉模型。
>
> ✅ **`doc.ocr` 的参数枚举与实现已经逐字对齐**：`engine` 的选项是
> `auto` / `tesseract` / `ai`，与执行器读的分支一字不差。
> （历史：这里曾写着 `paddleocr` —— 执行器**没有**那条分支，选中它只会静默走到
> `auto` 的行为；节点描述里「装了 PaddleOCR 时质量更高」也只是一句没有实现的文案。
> 二者现已一并删掉。**参数名对了但取值对不上，比参数名写错更难发现**：
> 界面照常显示、执行器照常运行，只有结果不符合预期。）
> 另外 `doc.ocr` 的 `requiresEngines` 已清空（原来是 `["python"]`）、
> `optionalEngines` 改成 `["tesseract", "ai-provider"]` —— Tesseract 那条路根本不碰 Python，
> 而没装 Tesseract 时它靠的是配好的 AI 服务；两个方向都必须声明对。

> ⚠️ 这里原来还有一行 `flow.foreach`（批量循环）。**这个节点已经被整个删除**，
> 不是"留着不实现" —— 所以清单里写 `uses: flow.foreach` 现在会直接**校验不过**
> （未知节点），而不是装完之后运行时才报 `not_implemented`。
>
> 删掉的理由：L1 的步骤列表是**平铺的有序列表**，没有嵌套结构，"对剩下的步骤循环 N 次"
> 这句话没法定义（循环体包含哪些步骤？循环之后那些"只想跑一次"的收尾步骤怎么办？）；
> 而且它旧描述里的「宿主会按并发度并行调度」是**假话**，宿主不在流水线内部调度。
> 批量已经由宿主在命令层做完了，见 1.6 节的目录展开与 `${batch.*}`。

> ✅ **流程控制节点的真实状态**（曾经三条都写着"未实现/空实现"，现已修复）：
>
> | 节点 | 状态 | 行为 |
> |---|---|---|
> | `flow.set-var` | ✅ 可用 | 写入 `vars.<名称>`，后续步骤用 `${vars.<名称>}` 引用 |
> | `flow.log` | ✅ 可用 | **真的往任务日志写一条**（`message` 为空时报 `PluginInvalid`） |
> | `flow.branch` | ✅ 可用 | 求值 `condition`，产出 `${steps.<id>.active}` = `"true"`/`"false"` |
> | `flow.foreach` | ❌ **节点已删除** | 不再存在这个节点，写了会在校验阶段报 `STEP_UNKNOWN_NODE`。**批量由宿主在命令层展开**（多文件与目录输入都扇出成单文件批次），清单里不需要它 |
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
不产出可引用的值**）。**32 个节点里 20 个产出值、12 个不产出**，下表两段分别是这两组 ——
分段是刻意的：把"没有值"的节点**点名列出**，比只写一句"其它都没有"更不容易骗人
（`image.remove-background` 当初就是被那句"其它都没有"盖住的）。

**产出值的（20 个）**

| 节点 | 可引用的 key |
|---|---|
| `image.probe` | `width`、`height`、`color`、`megapixels` |
| `image.resize` | `width`、`height`、`backend` |
| `image.crop` | `width`、`height`、`backend` |
| `image.rotate` | `backend` |
| `image.convert` | `path`、`backend` |
| `image.remove-background` | `path`、`model`（实际用的权重）、`backend`（恒为 `onnx-python`）、`inputSize`（喂给模型的尺寸，如 `320x320`）、`normalize`（`imagenet` 或 `pm1`）、`coveragePercent`（前景占比百分比） |
| `ai.upscale` | `path`、`model`、`backend`（恒为 `onnx-python`）、`width`、`height` |
| `ai.describe` | `text`（模型给的描述）、`model`（实际使用的模型名） |
| `doc.ocr` | `text`（识别出的文字）、`backend`（`tesseract` 或 `ai-vision`）、`pages`（实际识别了几页）、`rasterizer`（**只在走 PDF 栅格化那条路时才有**，值为 `poppler/pdftoppm`） |
| `ebook.convert` | `backend`（`calibre` 或 `pandoc`） |
| `video.transcode` | `path` |
| `fs.copy`、`fs.move` | `path` |
| `fs.mkdir` | `path` |
| `archive.unpack` | `path` |
| `text.replace` | `text`（替换后的全文） |
| `name.build` | `value`（拼好的文件名，**不含目录**） |
| `flow.log` | `message`（原样回显的消息） |
| `flow.set-var` | `value` |
| `flow.branch` | `active`（条件求值结果，`true` / `false`） |

**不产出任何值的（12 个）** —— 只能用 `${output.<portId>}` 传路径：

`fs.delete`、`image.enhance`、`image.strip-metadata`、`video.extract-audio`、`video.thumbnail`、
`video.trim`、`video.compress`、`audio.convert`、`audio.normalize`、`doc.convert`、
`doc.to-pdf`、`archive.pack`

> ✅ **这张表现在有机械对账了**（`verify-platform.mjs`【35】）：它把本表与
> `nodes.rs` 里真正的 `with_value(…)` / `NodeOutput::value(…)` / `values.insert(…)`
> 调用点逐行比对，**三个方向都查**（文档缺值、文档多值、文档说没有其实有）。
>
> 它此前确实是坏的，而且坏得比 §3.23 记的那一处更严重 —— 见下面这段历史：
>
> > ⚠️ **这张表此前没有任何机械对账**：【23】只核对了 3.2 的节点表
> > （名字 / 参数 / 引擎），没核对 3.5 的"产出值"表 —— 因为节点注册表里根本没有
> > "我会产出哪些值"这个字段，它只存在于 `NodeOutput::with_value(...)` 的调用点里。
> > 结果是**三类漂移同时存在**（【35】第一次跑就全报出来了）：
> > ① `image.rotate` 写着会产出 `width` / `height`，实际只产出 `backend`（用户照写会得到
> > "模板变量无法解析"）；② `doc.ocr` 的 `pages` / `rasterizer` **没写**；
> > ③ **`image.remove-background` 被归进了"没有可引用的值"那一行，而它其实产出 6 个值**
> > —— 其中 `coveragePercent`（前景占比）是**流程内可判断"模型到底找没找到东西"的唯一手段**
> > （例如 `when: ${steps.bg.coveragePercent} < 5` 走"没找到主体"的分支），
> > 而文档告诉插件作者这件事做不到。`video.transcode` 的 `path` 同样漏了。
>
> **在那之前，判断某个节点产出什么，以 `nodes.rs` 的返回值为准。**

**`backend` 是什么**：`image.convert` / `image.resize` / `image.crop` / `image.rotate` 会报出**实际使用的图像后端**，取值为 `"libvips"` / `"imagemagick"` / `"rust"`。它让"到底走没走 libvips"这件事变成流程内可判断的事实，例如后续步骤可以写 `when: ${steps.conv.backend} == rust` 来做"纯 Rust 路径下的补偿处理"。`image.enhance` 与 `image.strip-metadata` **不产出这个值**（它们不参与三层降级）；`ebook.convert` / `doc.ocr` / `ai.upscale` 也各有自己的 `backend` 值，含义见上表 —— 名字一样，但**取值域不一样**，别拿一个节点的取值去判断另一个节点。

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

### 4.3 从 Rust 编译到 `wasm32-unknown-unknown`

> ⚠️ **目标三元组必须是 `wasm32-unknown-unknown`，不能用 `wasm32-wasip1`。**
>
> 这一条曾经写错，代价是一个"编译成功、产物也在、但装进沙箱必然失败"的示例插件。
> 原因很隐蔽：**Rust 的 wasip1 版 std 在启动时会无条件读环境变量**（`std::rt::init`
> 调 `environ_get`），所以任何用 std 写出来的 wasip1 模块都会导入
> `wasi_snapshot_preview1`；而宿主刻意关掉了 WASI（`with_wasi(false)`，这是
> "插件没有文件系统"这条保证的实现手段），于是 wasmtime 实例化时报：
>
> ```text
> unknown import: `wasi_snapshot_preview1::environ_get` has not been defined
> ```
>
> 宿主现在会在**装载前**读一遍模块的导入段，遇到 WASI 导入直接给出
> "请改用 `wasm32-unknown-unknown` 重新构建"的提示（见
> `runtimes/wasm.rs::inspect_imports`），但正确做法当然是一开始就选对目标。

```powershell
# 1) 装目标（只需一次）
rustup target add wasm32-unknown-unknown

# 2) 建工程：Cargo.toml 里 crate-type 必须是 cdylib
#    [lib]
#    crate-type = ["cdylib"]
#    [dependencies]
#    extism-pdk = "1.4"
#    anyhow = "1"
#    serde = { version = "1", features = ["derive"] }
#    serde_json = "1"
#
#    [profile.release]
#    panic = "abort"     # wasm32-unknown-unknown 不支持展开

# 3) 编译
cargo build --target wasm32-unknown-unknown --release

# 4) 把产物复制成清单里 wasm.path 指定的名字
Copy-Item .\target\wasm32-unknown-unknown\release\<crate_name>.wasm .\plugin.wasm
```

> ⚠️ 如果插件工程放在仓库的 `plugins/` 下，**必须在它自己的 `Cargo.toml` 里加一行
> `[workspace]`**，否则 cargo 会去找仓库根的 workspace 并报
> "current package believes it's in a workspace when it's not"。

> 💡 想在**宿主机**上跑这个 crate 的纯函数单元测试（`cargo test`），需要把
> `#[plugin_fn]` 的入口用 `#[cfg(target_arch = "wasm32")]` 门起来：PDK 的
> `info!` / `http::request` 引用了 `extism:host/env` 的导入，在宿主机三元组上
> 链接会报 `LNK2019: 无法解析的外部符号 get_log_level`。
> 两个示例插件（`plugins/wasm-example`、`plugins/wasm-http-example`）都这么做。

完整可运行例子：
* `plugins/wasm-example/` —— 纯计算（文本统计 / slugify）；
* `plugins/wasm-http-example/` —— 联网（`net` 白名单 + Extism 的 `http_request`）。

### 4.4 Extism PDK 用法

```rust
use extism_pdk::*;
use serde::Deserialize;

#[derive(Deserialize)]
struct RunRequest {
    /// 输入端口 id -> **路径/值列表**（即使只有一个值也是数组）
    #[serde(default)]
    input: std::collections::BTreeMap<String, Vec<String>>,
    /// 参数 id -> **裸值**（`"stats"` / `5` / `true`）。
    ///
    /// ⚠️ 用 `serde_json::Value` 而不是 `String`：宿主给的是**原始 JSON 类型**，
    /// 声明成 `String` 会让整个反序列化失败（`invalid type: map, expected a string`
    /// —— 这是本项目真实踩过的坑）。
    #[serde(default)]
    params: std::collections::BTreeMap<String, serde_json::Value>,
    /// 逻辑作用域 -> 真实根目录
    #[serde(default)]
    paths: std::collections::BTreeMap<String, String>,
    /// 本次调用实际生效的能力标签（camelCase，与清单里的 `kind:` 一致）
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
  （字段见上面结构体，与 `runtimes.rs` 的文档一致）。注意 `params` 的值是
  **裸值**（`"stats"` / `5` / `true` / `["a"]`），不是 `{kind, value}` ——
  后者是宿主与前端的内部约定，插件**不会**收到那个形状。
  `capabilities` 是 camelCase 标签（`["fsRead","fsWrite","net"]`），
  与清单里 `kind:` 写的一致。
- **返回**：**必须是 JSON**。宿主先按 JSON 解析，解析不了才宽容地退化成裸字符串。

#### 返回信封（宿主真正认的三个字段）

```jsonc
{
  // ① 输出端口 id -> 值。文件类端口给**路径**（必须真实存在、且必须落在
  //    输出目录之内，否则整次调用被判 PERMISSION_DENIED 并记审计）；
  //    其它类型（text/json/number/boolean）给值，会写进任务日志。
  "outputs": { "swatch": "D:\\out\\色卡.png", "palette": "[{\"hex\":\"#1a2b3c\"}]" },

  // ② 结构化结果，会逐个写进任务日志。也是 `${steps.<步骤id>.<键>}` 引用得到的东西。
  "values": { "count": 5, "dominant": "#1a2b3c" },

  // ③ 报错。**这是 L2 唯一可靠的报错通道**，见下。
  "error": "请求 … 失败：HTTP request to … is not allowed"
}
```

> ⚠️ **L2 报错不要靠返回 `Err`。**
>
> Extism 1.30 只在**输出已被设置**时才读取插件设置的错误消息
> （`plugin.rs`: `if output_res.is_ok() && self.extism_error_is_set()`），
> 而 Extism PDK 的 `#[plugin_fn]` 在 `Err` 分支上只调 `error_set`、
> **不**设置输出内存 —— 于是 `output_res` 是 `Err`，你写的报错文案被丢掉，
> 用户看到的是一句 wasm 回溯：
>
> ```text
> WASM 插件执行失败：error while executing at wasm backtrace:
>  0: 0x8bd7 - <unknown>!<wasm function 92>
> ```
>
> 所以 L2 插件请用 `{"error": "…"}` 报错（宿主会把它变成任务的失败原因），
> 并**同时**用 `warn!` 打一条日志。`plugins/wasm-http-example` 里的 `fail()`
> 就是这么写的，可以直接抄。
>
> L3（Python）不受影响：它的 JSON-RPC 错误帧本来就能带出 `message`，
> 宿主会照实呈现（`{"jsonrpc":"2.0","id":2,"error":{"code":-32602,"message":"…"}}`）。

> ⚠️ **`outputs` 写对象，不要写数组。** 数组是宿主早期只认的形态，仍然兼容，
> 但它无法表达"哪个端口产出了哪个文件"，而且宿主不会去核对数组里的路径是否
> 真的存在。对象形态下，宿主会逐条对照 `io.outputs` 声明的端口类型处理。

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

**`progress` 的全部字段**（L2 与 L3 都支持）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `value` | number | `0.0`–`1.0`。**不给就是不确定进度条**（前端会显示成滚动条而不是瞎猜的百分比） |
| `stage` | string | 当前阶段的人类可读描述，例如"正在统计颜色"。缺省是 `处理中` |
| `currentItem` | string | **当前正在处理的那一个**（文件名 / 条目名）。前端会把它显示在进度条旁边 |
| `speed` | string |速率文本（如 `1.5 MB/s`）。**故意是字符串而不是数字**：单位由插件决定，宿主不做换算 |
| `etaSeconds` | number | 预计剩余秒数 |

`currentItem` 与 `etaSeconds` 另外**也接受 snake_case**（`current_item` / `eta_seconds`）——
Python 作者的手会自然写出后者，多认一种拼写的代价是零，而不认的代价是字段被**静默忽略**。
两种都给了时以 camelCase 为准。

> ⚠️ 这段曾经写的是「宿主只读 `value` 与 `stage`，`currentItem` / `speed` / `etaSeconds`
> 会被忽略」—— 那时它确实是真的，L3 的桥接把这三个字段写死成 `None`。
> 后果是 L3 插件永远只能报"百分之几 + 一句话"，前端只能显示不确定态的进度条，
> 而 L1 的 FFmpeg 进度早就能报"第 3/10 个文件、速度、剩余时间"。
> 现在三个字段都接通了（`verify-runtimes.mjs`【6d】在真机上验证它们在 `jobs_get`
> 的返回里真的能读到），所以**别再把重要信息只放在 `stage` 里**了。

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
| `内置节点 \`X\` 尚未在 v0.1 中实现` | **现在只剩一种成因：节点名拼错了**。名单（`UNIMPLEMENTED_NODES`）是空的，所以正常路径下不该再看到这句话；报错会把"名字不在目录里"与"确实没实现"分开说 | 先逐字核对 `uses`。若确认名字没错，说明你用的是给更新版本写的清单，请对照 3. 的全表 |
| `模板变量 \`${x}\` 无法解析` | 变量名写错，或引用了不存在的端口/参数 | 对照 1.6 的变量表；注意 `${dst}` 只在输出端口唯一时才可靠 |
| `路径逃逸被拦截` | 路径解析后落在授权目录之外（相对路径的 `..`、或根**之外**的绝对路径） | 用授权目录内的路径。`${src}` / `${output.<端口>}` 本身就是绝对路径，正常使用即可；**别自己编宿主机路径** |
| ~~`插件不允许使用绝对路径`~~ | ⛔ **这条错误已经不存在了** | 它曾是个发布级 bug：宿主自己往流水线里注入绝对路径却又拒绝绝对路径，导致任何真实转换都失败。现在绝对路径只要落在授权根内就放行 |
| 步骤失败但任务显示"跳过" | `onError` 是 `skip` / `continue` | 看 `Job.warnings` 与 `${steps.<id>.error}`；想快速失败就用 `fail` |
| `TIMEOUT` | 步骤/流水线超时，或 WASM 燃料耗尽 | 调大 `timeoutMs`；WASM 的话先检查是不是死循环 |
| `PLUGIN_CAPABILITY_VIOLATION` | 插件用了未声明或未授权的能力 | **这是安全事件**：补声明后让用户重新授权，或去掉该行为 |
| `INTEGRITY_CHECK_FAILED` | 插件目录在安装后被改动过 | 重新安装插件；不要手工改已安装的插件文件 |
| L2：`WASM 模块里没有导出函数 \`run\`` | `wasm.entry` 与 `#[plugin_fn]` 的函数名不一致 | 让两者一致 |
| L2：`WASM 模块编译失败` | 文件不是合法 wasm，或用了 Extism 不支持的指令 | 用 `--target wasm32-unknown-unknown` 重新编译 |
| L2：`这个 WASM 模块引用了 WASI（例如 \`wasi_snapshot_preview1::environ_get\`）` | 模块是用 `wasm32-wasip1` 构建的（wasip1 的 std 必然导入 WASI），而宿主关掉了 WASI | 用 `--target wasm32-unknown-unknown` 重新构建。**这是必然失败，不是环境问题** |
| L2：`模块导入了宿主没有提供的函数` | 模块导入了 `extism:host/user` 下的自定义宿主函数 | v0.1 不注入任何自定义宿主函数；日志用 `info!`（内置），KV 推迟到 v0.2 |
| L2：`HTTP request to … is not allowed` | 没授权 `net`，或请求的主机不在白名单里 | 检查两处：清单 `net.hosts` **不能带端口**（沙箱只按主机名匹配），用户也在授权面板勾了 `net` |
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
9. L2：`allowHostFunctions` 只写 `log`；`wasm32-unknown-unknown` 目标；`net` 的 `hosts` **不带端口**。fs/exec/env 对 WASM 不可达，不要声明。
10. L3：`requirements` 不带 URL/VCS/本地路径；每条帧写完都 flush；日志走 stderr。
11. 用 `PluginManifest::validate()` 自查一遍（宿主装载前也会跑它）。

---

## 8. 参考

| 想看什么 | 去哪里 |
|---|---|
| 可以直接抄的完整例子 | `plugins/builtin/image-convert/`（L1 单节点）、`plugins/builtin/video-to-gif/`（L1 多步 + `${steps.x.y}`）、`plugins/builtin/batch-rename/`（批量编号形状：`${batch.index}` + `${src.stem}`）、`plugins/builtin/remove-bg/`（**引擎依赖 + 模型选择 + 需要一次联网准备的节点**，v0.2.0：默认模型 `u2netp`，参数与节点逐字对齐，顶部如实写明首次运行要下权重与 Python 依赖）、`plugins/builtin/ebook-convert/`（**可选引擎降级 + "pandoc 会假装成功"的拦停**）、`plugins/builtin/ai-describe/`（**AI 描述 → 文本净化 → 拼名 → 改名**：`ai.describe` + `text.replace` + `name.build` + `fs.move` 四步，是"用描述当文件名"的标准形状，也演示了 `onError: continue` 与 300 秒流水线超时的取舍）、`plugins/builtin/image-upscale/`（**超分 + 纯本地 ONNX 推理**）、`plugins/wasm-example/`（L2）、`plugins/python-example/`（L3） |
| 引擎与许可证矩阵、降级路径 | `docs/ENGINE-MATRIX.md` |
| 架构与数据流 | `docs/ARCHITECTURE.md` |
| 安全模型与权限风险 | `docs/SECURITY.md` |
| 各阶段的实现进度 | `docs/ROADMAP.md` |
| 清单 schema 权威定义 | `crates/toolforge-core/src/plugin.rs` |
| 节点目录权威定义 | `crates/toolforge-core/src/pipeline.rs` 的 `builtin_nodes()` |
| 节点**实现** | `crates/toolforge-engines/src/nodes.rs` |
