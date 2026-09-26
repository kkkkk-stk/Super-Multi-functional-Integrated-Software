#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ToolForge L3 示例插件：图片主色调提取。

协议：**一行一个 JSON 对象**的 JSON-RPC 2.0 over stdio（UTF-8，行内不允许裸换行）。
实现依据：`crates/toolforge-process/src/rpc.rs`（帧模型）与
`crates/toolforge-plugins/src/runtimes/python.rs`（方法与通知）。

    stdin  <- 宿主发来的请求 / 通知
    stdout -> 插件的响应 / 通知（**只能放协议帧，一行一个 JSON**）
    stderr -> 自由日志（宿主会把它收进进程的 stderr 尾部，写在这里永远不污染协议）

宿主调用的方法
--------------
``initialize``
    一次性握手。params::

        {"pluginId": "com.example.x", "apiVersion": "toolforge/v1",
         "entry": "main.py", "paths": {"input": …, "output": …, "data": …, "work": …},
         "timeoutMs": 300000}

    返回任意 JSON 即可；返回 ``-32601``（METHOD_NOT_FOUND）表示"我不实现握手"，
    宿主会按无状态插件处理（见 ``ChildSupervisor::initialize``）。

``run``
    单次处理。``params`` 就是宿主构造的 ``PluginCallRequest::payload``::

        {"input":  {"src": ["/real/input/a.png"]},
         "params": {"count": "5", "ignoreNearWhite": "true"},
         "paths":  {"input": "/…", "output": "/…", "data": "/…", "work": "/…"},
         "capabilities": ["fsRead", "fsWrite"]}

    注意 ``input`` 的每个端口都是**数组**。

``shutdown``
    释放资源。宿主给 5 秒宽限，之后强杀。

插件主动发的通知（无 id，宿主不回包）
------------------------------------
``progress``（宿主只读 ``value`` 与 ``stage``，其余字段会被忽略）::

    {"jsonrpc":"2.0","method":"progress","params":{"value":0.5,"stage":"正在统计颜色"}}

``log``（宿主按 level 映射到任务日志）::

    {"jsonrpc":"2.0","method":"log","params":{"level":"info","message":"载入模型完成"}}

``host.request`` —— **不要用**：宿主明确拒绝运行期提权，只会记一条警告。

错误码（与 ``toolforge_process::rpc::codes`` 一致）
--------------------------------------------------
-32700 解析失败 / -32600 请求非法 / -32601 方法不存在 / -32602 参数非法 /
-32603 内部错误 / -32001 拒绝执行 / -32002 超时 / -32003 进程已退出 /
-32004 尚未 initialize

超时与取消
----------
宿主持有 ``python.timeoutMs`` 的墙钟超时；超时后它会**杀掉本进程**（因为超时的
Python 可能卡在原生扩展里）。所以插件不需要自己实现超时，只要在处理大图时
周期性上报进度、让用户看得见即可。下面的 ``notifications/cancel`` 是**协作式取消**
的预留实现：ToolForge 当前并不发送它（取消走的是杀进程），保留是为了让插件作者
知道"如果将来支持的话该怎么写"。
"""

from __future__ import annotations

import io
import json
import os
import queue
import re
import sys
import threading
import traceback

# ---------------------------------------------------------------------------
# 协议常量（与 toolforge_process::rpc::codes 保持一致）
# ---------------------------------------------------------------------------

PROTOCOL_VERSION = "2.0"

E_PARSE = -32700
E_INVALID_REQUEST = -32600
E_METHOD_NOT_FOUND = -32601
E_INVALID_PARAMS = -32602
E_INTERNAL = -32603
E_PERMISSION_DENIED = -32001
E_TIMEOUT = -32002
E_PROCESS_GONE = -32003
E_NOT_INITIALIZED = -32004

PLUGIN_NAME = "com.toolforge.example.palette"

# 逻辑路径作用域 -> 虚拟前缀（与 permission.rs 的 PathResolver::logical_view() 一致）
LOGICAL_ROOTS = {
    "input": "/input",
    "output": "/output",
    "data": "/data",
    "work": "/work",
}

# ---------------------------------------------------------------------------
# 全局状态：由 initialize 填充
# ---------------------------------------------------------------------------

_state_lock = threading.Lock()
_initialized = False
_real_roots: dict[str, str] = {}
_cancel_event = threading.Event()
_out_lock = threading.Lock()


# ---------------------------------------------------------------------------
# 收发
# ---------------------------------------------------------------------------

def _write_frame(obj: dict) -> None:
    """把一个 JSON 对象写成一行并立刻 flush。

    **必须 flush**：宿主是逐行读的；缓冲住不写，宿主看到的现象是
    "插件启动了但永远不响应"。这也是宿主用 `python -u` 启动本进程的原因。
    """
    line = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    with _out_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def send_result(req_id, result) -> None:
    _write_frame({"jsonrpc": PROTOCOL_VERSION, "id": req_id, "result": result})


def send_error(req_id, code: int, message: str, data=None) -> None:
    err: dict = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    _write_frame({"jsonrpc": PROTOCOL_VERSION, "id": req_id, "error": err})


def notify_progress(stage: str, value: float | None = None) -> None:
    """上报进度通知。宿主只读 `value` 与 `stage`（见 python.rs 的 handle_notification）。"""
    params: dict = {"stage": stage}
    if value is not None:
        params["value"] = max(0.0, min(1.0, float(value)))
    _write_frame({"jsonrpc": PROTOCOL_VERSION, "method": "progress", "params": params})


def notify_log(level: str, message: str) -> None:
    """上报日志通知。level 取 info / warn / error / debug（宿主按它映射到任务日志）。"""
    _write_frame({
        "jsonrpc": PROTOCOL_VERSION,
        "method": "log",
        "params": {"level": level, "message": message},
    })


def log(level: str, message: str) -> None:
    """本地调试日志，一律走 stderr。"""
    sys.stderr.write(f"[{PLUGIN_NAME}][{level}] {message}\n")
    sys.stderr.flush()


# ---------------------------------------------------------------------------
# 参数归一化
#
# 宿主可能把参数以字符串传进来（L1 流水线渲染出来的一定是字符串），
# 也可能传原生 JSON 类型。两种都接受，避免"参数类型一变就崩"。
# ---------------------------------------------------------------------------

def as_int(value, default: int) -> int:
    if value is None or value == "":
        return default
    try:
        return int(float(value))
    except (TypeError, ValueError):
        raise ValueError(f"无法把 {value!r} 解释为整数")


def as_bool(value, default: bool) -> bool:
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true", "yes", "on")


_SAFE_NAME = re.compile(r"[^0-9A-Za-z._-]+")


def safe_filename(name: str) -> str:
    """把外部输入清洗成安全的文件名（不信任宿主给的名字）。"""
    name = os.path.basename(str(name).replace("\\", "/"))
    cleaned = _SAFE_NAME.sub("_", name).lstrip(".") or "output"
    return cleaned


class _ProtocolError(Exception):
    """带 JSON-RPC 错误码的异常。"""

    def __init__(self, code: int, message: str, data=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


class _Cancelled(Exception):
    """协作式取消（见模块文档的「超时与取消」）。"""


# ---------------------------------------------------------------------------
# 路径解析
# ---------------------------------------------------------------------------

def resolve_in_scope(given: str, scope: str) -> str:
    """把宿主给的路径解析成真实路径。

    宿主传进来的通常已经是 `PathResolver` 翻译过的真实路径；这里额外兼容
    "逻辑路径"写法（`/input/a.png`），便于本地手工调试：
    只要 initialize 里给了真实根目录，就把逻辑前缀替换掉。
    """
    logical = LOGICAL_ROOTS.get(scope)
    if logical and str(given).startswith(logical + "/"):
        root = _real_roots.get(scope)
        if root:
            return os.path.join(root, str(given)[len(logical) + 1:])
    return str(given)


def output_path_for(name: str) -> str:
    """在**输出作用域**内拼一个安全的目标路径。

    插件自己也要收敛路径：即使宿主已经做过检查，这里再兜一层，
    保证永远不会写到输出根目录之外。
    """
    out_root = _real_roots.get("output")
    if not out_root:
        raise _ProtocolError(
            E_INVALID_PARAMS,
            "宿主没有在 initialize 里提供 output 路径作用域，无法确定写在哪里",
        )
    root_abs = os.path.normpath(os.path.abspath(out_root))
    target = os.path.normpath(os.path.join(root_abs, safe_filename(name)))
    if not target.startswith(root_abs + os.sep):
        raise _ProtocolError(E_PERMISSION_DENIED, f"拒绝写出输出目录之外：{target}")
    return target


def require_capability(name: str) -> None:
    """宿主把本次生效的能力通过 payload 的 `capabilities` 告知插件。

    插件**主动**检查一次的意义是：给用户一条清楚的错误信息，
    而不是等 `open()` 抛 PermissionError 后再猜原因。
    """
    if _granted and name not in _granted:
        raise _ProtocolError(
            E_PERMISSION_DENIED,
            f"本次调用没有 `{name}` 能力（已授权：{sorted(_granted)}）",
            {"capability": name},
        )


_granted: set[str] = set()


# ---------------------------------------------------------------------------
# 业务：主色调提取
# ---------------------------------------------------------------------------

def _require_pillow():
    try:
        from PIL import Image  # noqa: F401
    except ImportError as exc:  # pragma: no cover
        raise _ProtocolError(
            E_INTERNAL,
            "Pillow 未安装：宿主应当在插件私有的 .venv 里按 plugin.yaml 的 "
            "requirements 安装依赖（Pillow==10.4.0）。",
        ) from exc


def extract_palette(src_path: str, count: int, ignore_near_white: bool,
                    swatch_path: str | None) -> dict:
    """统计主色调，并可选地画一张色卡图。"""
    require_capability("fsRead")
    _require_pillow()
    from PIL import Image

    if not os.path.isfile(src_path):
        raise _ProtocolError(E_INVALID_PARAMS, f"输入图片不存在：{src_path}")

    # 1) 解码 + 缩小。缩到最长边 256 是刻意的：主色调统计不需要全分辨率，
    #    而大图全量量化会让这一步从"秒级"变成"分钟级"。
    notify_progress("正在解码图片", 0.1)
    with Image.open(src_path) as im:
        width, height = im.size
        rgba = im.convert("RGBA")
    rgba.thumbnail((256, 256), Image.LANCZOS)

    if _cancel_event.is_set():
        raise _Cancelled()

    # 2) 逐像素过滤：丢掉全透明像素，可选丢掉接近白色的像素。
    #    直接用 tobytes() 遍历，不依赖 Image.getdata()（Pillow 12 起已废弃，
    #    而它的替代品 get_flattened_data 在 Pillow 10.4 上还不存在）。
    notify_progress("正在预处理像素", 0.3)
    pixels: list[tuple[int, int, int]] = []
    raw = rgba.tobytes()  # RGBA 交错，每像素 4 字节
    for i in range(0, len(raw) - 3, 4):
        r, g, b, a = raw[i], raw[i + 1], raw[i + 2], raw[i + 3]
        if a < 8:
            continue
        if ignore_near_white and r >= 245 and g >= 245 and b >= 245:
            continue
        pixels.append((r, g, b))

    total = len(pixels)
    if total == 0:
        raise _ProtocolError(
            E_INVALID_PARAMS,
            "图片中没有可用于统计的不透明像素（可能整张都是透明或纯白）",
        )

    if _cancel_event.is_set():
        raise _Cancelled()

    # 3) 中位切分量化出 N 种颜色
    notify_progress("正在统计颜色", 0.55)
    sample = Image.new("RGB", (len(pixels), 1))
    sample.putdata(pixels)
    quantized = sample.quantize(colors=max(1, min(256, count)), method=Image.MEDIANCUT)

    palette_raw = quantized.getpalette() or []
    color_counts = quantized.getcolors() or []
    # getcolors 返回 [(count, index), ...]，按出现次数从多到少排序
    color_counts.sort(key=lambda item: item[0], reverse=True)

    colors = []
    for cnt, index in color_counts[:count]:
        base = index * 3
        if base + 2 >= len(palette_raw):
            continue
        r, g, b = palette_raw[base], palette_raw[base + 1], palette_raw[base + 2]
        colors.append({
            "hex": f"#{r:02x}{g:02x}{b:02x}",
            "rgb": [r, g, b],
            "ratio": round(cnt / total, 4),
        })

    if not colors:
        raise _ProtocolError(E_INTERNAL, "量化结果为空，无法给出主色调")

    if _cancel_event.is_set():
        raise _Cancelled()

    # 4) 竖向等分色卡图（可选输出）
    swatch_out: str | None = None
    if swatch_path:
        require_capability("fsWrite")
        notify_progress("正在生成色卡图", 0.85)
        band_h = 48
        swatch = Image.new("RGB", (320, band_h * len(colors)), (255, 255, 255))
        for i, color in enumerate(colors):
            r, g, b = color["rgb"]
            swatch.paste(Image.new("RGB", (320, band_h), (r, g, b)), (0, i * band_h))
        os.makedirs(os.path.dirname(os.path.abspath(swatch_path)) or ".", exist_ok=True)
        swatch.save(swatch_path, format="PNG")
        swatch_out = swatch_path

    notify_progress("完成", 1.0)

    return {
        "size": [width, height],
        "sampledPixels": total,
        "colors": colors,
        "swatch": swatch_out,
    }


# ---------------------------------------------------------------------------
# 方法实现
# ---------------------------------------------------------------------------

def handle_initialize(params: dict) -> dict:
    global _initialized, _granted
    paths = params.get("paths") or {}
    with _state_lock:
        _real_roots.clear()
        for scope in LOGICAL_ROOTS:
            real = paths.get(scope)
            if isinstance(real, str) and real:
                _real_roots[scope] = real
        _initialized = True

    # 能力标签由宿主通过环境变量 TOOLFORGE_CAPABILITIES 与 payload 两处告知，
    # 这里先读环境变量做一次日志（payload 里的 capabilities 以调用为准）。
    env_caps = os.environ.get("TOOLFORGE_CAPABILITIES", "")
    _granted = {c for c in env_caps.split(",") if c}

    log("info", f"initialize: pluginId={params.get('pluginId')} "
                f"apiVersion={params.get('apiVersion')} "
                f"真实根目录={_real_roots or '（宿主未提供）'} "
                f"已授权能力={sorted(_granted) or '（无）'}")

    return {
        "ok": True,
        "name": PLUGIN_NAME,
        "protocolVersion": PROTOCOL_VERSION,
        "python": sys.version.split()[0],
        "logTo": "stderr",
    }


def handle_run(params: dict) -> dict:
    global _granted
    if not _initialized:
        raise _ProtocolError(E_NOT_INITIALIZED, "尚未调用 initialize")

    _cancel_event.clear()

    # payload 里的 capabilities 是本次调用实际生效的能力，优先于环境变量
    caps = params.get("capabilities")
    if isinstance(caps, list) and caps:
        _granted = {str(c) for c in caps}

    # payload 里可能带上 paths（与 initialize 的相同），以最新的为准
    paths = params.get("paths")
    if isinstance(paths, dict):
        for scope in LOGICAL_ROOTS:
            real = paths.get(scope)
            if isinstance(real, str) and real:
                _real_roots[scope] = real

    inputs = params.get("input") or {}
    raw_params = params.get("params") or {}

    # 输入端口 `src` 的值是**数组**
    src_values = inputs.get("src")
    if isinstance(src_values, str):
        src_values = [src_values]
    if not src_values:
        raise _ProtocolError(E_INVALID_PARAMS, "缺少输入端口 `src`（见 plugin.yaml 的 io.inputs）")
    src_real = resolve_in_scope(src_values[0], "input")

    count = as_int(raw_params.get("count"), 5)
    if count < 1 or count > 16:
        raise _ProtocolError(E_INVALID_PARAMS, f"count 超出 1..=16：{count}")
    ignore_near_white = as_bool(raw_params.get("ignoreNearWhite"), True)

    # 输出由插件自己在 output 作用域内命名（宿主没有为 L3 传入"目标路径"）
    swatch_real = output_path_for(os.path.splitext(os.path.basename(src_real))[0] + "-palette.png")

    notify_log("info", f"开始处理 {os.path.basename(src_real)}（取 {count} 种颜色）")
    result = extract_palette(src_real, count, ignore_near_white, swatch_real)

    return {
        "outputs": {
            "palette": json.dumps(result["colors"], ensure_ascii=False),
            "swatch": result["swatch"],
        },
        "values": {
            "primary": result["colors"][0]["hex"],
            "count": len(result["colors"]),
            "size": result["size"],
        },
        "meta": {"sampledPixels": result["sampledPixels"]},
    }


def handle_shutdown(params: dict) -> dict:
    log("info", "shutdown: 准备退出")
    return {"ok": True}


_METHODS = {
    "initialize": handle_initialize,
    "run": handle_run,
    "shutdown": handle_shutdown,
}


# ---------------------------------------------------------------------------
# 主循环
# ---------------------------------------------------------------------------

def _reader_thread(stdin, inbox: "queue.Queue") -> None:
    """把 stdin 的每一行塞进队列。

    单独开线程是因为 `run` 可能跑很久，主线程不能一边算一边 `readline()`。
    """
    try:
        for line in stdin:
            inbox.put(line)
    except Exception as exc:  # pragma: no cover
        log("error", f"读 stdin 失败：{exc}")
    finally:
        inbox.put(None)  # 哨兵：stdin 已关闭


def _handle_notification(method: str, params: dict) -> None:
    if method == "notifications/cancel":
        # 预留的协作式取消（ToolForge 当前通过杀进程取消，不会发这个通知）
        log("warn", "收到取消通知，将在下一个检查点退出")
        _cancel_event.set()
    elif method == "notifications/initialized":
        log("info", "宿主已确认 initialize")
    else:
        log("warn", f"忽略未知通知 `{method}`")


def main() -> int:
    # 协议要求 UTF-8 且换行固定为 \n；Windows 上默认的 cp936 + \r\n 会破坏帧格式。
    stdin = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8", newline="\n")
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    sys.stderr.reconfigure(encoding="utf-8", newline="\n")

    log("info", f"启动 {PLUGIN_NAME}，Python {sys.version.split()[0]}")

    inbox: "queue.Queue" = queue.Queue()
    threading.Thread(target=_reader_thread, args=(stdin, inbox), daemon=True).start()

    while True:
        try:
            line = inbox.get(timeout=0.2)
        except queue.Empty:
            continue

        if line is None:
            log("info", "stdin 已关闭，退出主循环")
            return 0

        line = line.strip()
        if not line:
            continue

        # ---- 解析 ----
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as exc:
            # 宿主侧对无法解析的行会当作插件日志容错，但插件自己不该依赖这一点
            send_error(None, E_PARSE, "请求不是合法 JSON", str(exc))
            continue

        if not isinstance(msg, dict):
            send_error(None, E_INVALID_REQUEST, "请求必须是 JSON 对象")
            continue

        req_id = msg.get("id")
        method = msg.get("method")
        params = msg.get("params") or {}

        # ---- 通知（没有 id）：不回应 ----
        if req_id is None and isinstance(method, str):
            _handle_notification(method, params if isinstance(params, dict) else {})
            continue

        if not isinstance(method, str):
            send_error(req_id, E_INVALID_REQUEST, "缺少 method 字段")
            continue

        handler = _METHODS.get(method)
        if handler is None:
            send_error(req_id, E_METHOD_NOT_FOUND, f"不支持的方法：{method}")
            continue

        # ---- 执行 ----
        try:
            result = handler(params if isinstance(params, dict) else {})
            send_result(req_id, result)
            if method == "shutdown":
                log("info", "shutdown 完成，退出")
                return 0
        except _Cancelled:
            send_error(req_id, E_TIMEOUT, "任务已被取消")
        except _ProtocolError as exc:
            send_error(req_id, exc.code, exc.message, exc.data)
        except (FileNotFoundError, PermissionError) as exc:
            send_error(req_id, E_PERMISSION_DENIED, str(exc))
        except ValueError as exc:
            send_error(req_id, E_INVALID_PARAMS, str(exc))
        except Exception as exc:  # noqa: BLE001 - 兜底，绝不能让异常打死进程
            send_error(
                req_id,
                E_INTERNAL,
                f"插件内部错误：{exc}",
                traceback.format_exc(limit=8),
            )


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:  # pragma: no cover
        sys.exit(130)
