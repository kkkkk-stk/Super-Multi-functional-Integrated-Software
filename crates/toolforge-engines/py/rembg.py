"""U2Net 抠图推理脚本（ToolForge 内置节点 image.remove-background 的 Python 侧）。

## 为什么这段代码是 Python 而不是 Rust

宿主里没有 ONNX Runtime 的 Rust 绑定（`ort` 需要在构建期下载预编译动态库，
在内网/离线环境下会构建失败），而 Python 侧 `pip install onnxruntime` 是
一条成熟、可校验、可隔离的路径。L3 插件运行时本来就要求一个托管 Python，
所以这条链路是复用的，不是新开的口子。

## 调用约定

由 Rust 侧以子进程方式调用，**只通过命令行参数与文件交换数据**：

    python rembg.py --model <u2netp.onnx> --input <in.png> --output <out.png>
                    [--mode alpha|color] [--background "#RRGGBB"]
                    [--threshold 0] [--feather 0]

成功时 stdout 只打印一行 JSON（供宿主解析），失败时退出码非 0 且
stderr 是完整回溯 —— 宿主会把它原样带给用户，所以**不要**吞异常。

## 关于 U2Net 的输入输出（很容易写错的地方）

* 输入固定 **320x320**、归一化方式为 `(x / max) - mean) / std`，
  `mean=std=(0.485,0.456,0.406)`（ImageNet 统计量）。**不是** 0~1 直接送进去。
* 输出是 **7 个**同尺寸的显著性图（`d0`..`d6`），只用 `d0`（最终融合结果）。
* `d0` 的范围**不是** 0~1（也不是 0~255），必须自己做 min-max 归一化 ——
  直接 clip(0,1) 会得到一张几乎全黑或全白的蒙版。
"""

from __future__ import annotations

import argparse
import json
import sys


def fail(msg: str) -> "None":
    """把错误写到 stderr 并以非 0 退出。宿主会把 stderr 原样展示给用户。"""
    print(msg, file=sys.stderr)
    sys.exit(2)


def parse_hex_color(text: str):
    t = text.strip().lstrip("#")
    if len(t) == 3:
        t = "".join(c * 2 for c in t)
    if len(t) != 6:
        fail(f"背景色格式不对：{text}（应当形如 #RRGGBB）")
    try:
        return tuple(int(t[i : i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        fail(f"背景色里有非十六进制字符：{text}")


def main() -> None:
    p = argparse.ArgumentParser(description="U2Net 背景移除")
    p.add_argument("--model", required=True)
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--mode", default="alpha", choices=["alpha", "color"])
    p.add_argument("--background", default="#FFFFFF")
    p.add_argument("--threshold", type=int, default=0)
    p.add_argument("--feather", type=int, default=0)
    args = p.parse_args()

    # 依赖缺失要给出**可操作**的提示，而不是一句 ImportError 回溯
    try:
        import numpy as np
        import onnxruntime as ort
        from PIL import Image
    except ImportError as e:  # pragma: no cover - 由宿主保证依赖已装
        fail(
            f"缺少 Python 依赖：{e}\n"
            "请让宿主自动安装（image.remove-background 首次运行会装 onnxruntime / numpy / pillow），"
            "或手动执行：python -m pip install onnxruntime numpy pillow"
        )

    try:
        img = Image.open(args.input).convert("RGB")
    except Exception as e:
        fail(f"无法打开输入图片 {args.input}：{e}")

    orig_w, orig_h = img.size

    # ---- 预处理：320x320 + ImageNet 归一化 ----
    size = 320
    small = img.resize((size, size), Image.LANCZOS)
    arr = np.asarray(small, dtype=np.float32) / max(255.0, 1.0)
    mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
    std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
    arr = (arr - mean) / std
    # NCHW
    tensor = np.transpose(arr, (2, 0, 1))[None, ...].astype(np.float32)

    try:
        sess = ort.InferenceSession(args.model, providers=["CPUExecutionProvider"])
    except Exception as e:
        # 模型文件损坏是最常见的失败原因（下载被截断、被同步工具改写）
        fail(f"无法加载 ONNX 模型 {args.model}：{e}\n模型文件可能已损坏，请重新下载。")

    input_name = sess.get_inputs()[0].name
    try:
        outputs = sess.run(None, {input_name: tensor})
    except Exception as e:
        fail(f"推理失败：{e}")

    # 只取第一个输出（U2Net 的 d0 是最终融合结果）
    pred = np.asarray(outputs[0])
    # 去掉 batch / channel 维度：可能是 (1,1,H,W) 或 (1,H,W) 或 (H,W)
    pred = np.squeeze(pred)
    if pred.ndim != 2:
        fail(f"模型输出形状无法理解：{np.asarray(outputs[0]).shape}")

    # ---- 后处理：min-max 归一化（这是最容易漏的一步）----
    lo, hi = float(pred.min()), float(pred.max())
    if hi - lo < 1e-6:
        # 全常数输出 = 这张图里没有可分辨的前景，直接给全透明比给全黑好
        mask = np.zeros_like(pred, dtype=np.float32)
    else:
        mask = (pred - lo) / (hi - lo)

    if args.threshold > 0:
        t = args.threshold / 100.0
        mask = np.where(mask >= t, mask, 0.0)

    mask_img = Image.fromarray((mask * 255.0).clip(0, 255).astype(np.uint8), mode="L")

    # 蒙版要缩回原尺寸。用 LANCZOS 而不是 NEAREST：边缘明显更干净。
    mask_img = mask_img.resize((orig_w, orig_h), Image.LANCZOS)

    if args.feather > 0:
        # 羽毛化：对蒙版做一次轻微高斯模糊，消掉 320x320 上采样带来的锯齿
        from PIL import ImageFilter

        mask_img = mask_img.filter(ImageFilter.GaussianBlur(args.feather / 10.0))

    rgba = img.convert("RGBA")
    rgba.putalpha(mask_img)

    if args.mode == "alpha":
        out = rgba
    else:
        bg = Image.new("RGBA", rgba.size, parse_hex_color(args.background) + (255,))
        bg.alpha_composite(rgba)
        out = bg.convert("RGB")

    try:
        out.save(args.output)
    except Exception as e:
        fail(f"写入 {args.output} 失败：{e}")

    # 前景占比是有用的信息：接近 0 说明模型没找到主体，接近 100 说明蒙版几乎全白
    coverage = float((np.asarray(mask_img, dtype=np.float32) > 127).mean()) * 100.0
    print(
        json.dumps(
            {
                "ok": True,
                "width": orig_w,
                "height": orig_h,
                "mode": args.mode,
                "coveragePercent": round(coverage, 2),
                "model": args.model,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
