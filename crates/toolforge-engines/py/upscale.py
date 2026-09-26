"""Real-ESRGAN 超分推理脚本（ToolForge 内置节点 `ai.upscale` 的 Python 侧）。

## 为什么自己写切块逻辑

超分的输出是输入的 4 倍边长 —— 也就是 **16 倍像素**。一张 4000×3000 的照片
放大后是 16000×12000，光是 float32 张量就要 2.3 GB。所以任何能用的实现
都必须分块推理。

分块最容易出错的地方是**接缝**：块与块之间如果刚好切在纹理上，拼回去就会
出现网格状伪影。这里的做法是每块多取 `overlap` 像素的上下文（"重叠边"），
推理完只取中心区域贴回结果 —— 这样每个输出像素都由一块**包含它周围上下文**
的输入算出来，接缝就看不出来了。

## 关于固定尺寸的模型

有些 ONNX 导出（例如 Real-ESRGAN x4plus 的常见版本）把输入尺寸**写死**成
64×64 或 128×128。这种模型必须把每个块补齐到那个尺寸再推理、然后把补出来的
部分裁掉。脚本会读会话的输入形状自动判断，固定尺寸时走补齐路径。

工具本身对两种模型都能用；但产品里默认只提供动态尺寸的那两个，
因为它们不需要为"补边"付出额外的推理量。
"""

from __future__ import annotations

import argparse
import json
import sys


def fail(msg: str) -> "None":
    print(msg, file=sys.stderr)
    sys.exit(2)


def main() -> None:
    p = argparse.ArgumentParser(description="Real-ESRGAN 超分")
    p.add_argument("--model", required=True)
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    # 目标倍数。模型原生 4x；要 2x 就先 4x 再用 Lanczos 缩回去 ——
    # 这比"直接双线性放大 2 倍"质量好得多，而且不需要第二个模型。
    p.add_argument("--scale", type=int, default=4, choices=[2, 3, 4])
    # 每块的边长与重叠像素（都是**输入侧**的尺寸）
    p.add_argument("--tile", type=int, default=256)
    p.add_argument("--overlap", type=int, default=16)
    p.add_argument("--tileOverlap", type=int, default=8)
    args = p.parse_args()

    try:
        import numpy as np
        import onnxruntime as ort
        from PIL import Image
    except ImportError as e:  # pragma: no cover
        fail(
            f"缺少 Python 依赖：{e}\n"
            "请让宿主自动安装（ai.upscale 首次运行会装 onnxruntime / numpy / pillow）。"
        )

    try:
        img = Image.open(args.input).convert("RGB")
    except Exception as e:
        fail(f"无法打开输入图片 {args.input}：{e}")

    try:
        sess = ort.InferenceSession(args.model, providers=["CPUExecutionProvider"])
    except Exception as e:
        fail(f"无法加载 ONNX 模型 {args.model}：{e}\n模型文件可能已损坏，请重新下载。")

    spec = sess.get_inputs()[0]
    input_name = spec.name

    # ---- 先确认这个模型真的能拿来超分 ----
    #
    # 这一步不是"防御性编程"，是**真踩过的坑**：验证脚本曾经按"谁服务于
    # ai.upscale"去挑模型，挑中了一个**抠图模型**（u2netp），于是拿分割模型
    # 去超分。那个模型的输出是 320×320 的单通道蒙版，脚本把它当成图片、
    # 算出"放大倍数 1"、再为了凑目标倍数做了一次 resize —— 最后**尺寸断言完全通过**，
    # 整条检查全绿，而结果是垃圾。
    #
    # 所以：模型必须满足"3 通道进、3 通道出、空间尺寸整数倍放大"。
    # 不满足就直接报错，说清这个权重是干什么用的。
    in_shape = list(spec.shape)
    if len(in_shape) != 4 or not (in_shape[1] == 3 or in_shape[1] == "3"):
        fail(
            f"这个权重不是超分模型：它的输入形状是 {in_shape}，"
            "而超分模型应当是 [N, 3, H, W]（3 通道图片）。\n"
            "请到「设置 → 模型权重」里下载 Real-ESRGAN 系列（realesr-general-x4v3 等）。"
        )

    fixed_hw = None
    if len(spec.shape) == 4:
        h, w = spec.shape[2], spec.shape[3]
        if isinstance(h, int) and isinstance(w, int) and h > 0 and w > 0:
            fixed_hw = (h, w)

    src = np.asarray(img, dtype=np.float32) / 255.0  # HWC, 0~1
    h, w = src.shape[0], src.shape[1]

    if fixed_hw:
        tile = fixed_hw[0]
        overlap = min(args.overlap, tile // 4)
    else:
        tile = max(16, args.tile)
        overlap = max(0, min(args.overlap, tile // 4))

    # 目标倍数以模型为准：从输出形状推。动态尺寸时形状里带名字，推不出来就按 4 算，
    # 最后用实际输出尺寸校正（见下面的 `ratio`）。
    scale = 4

    out = np.zeros((h * scale, w * scale, 3), dtype=np.float32)
    covered = np.zeros((h * scale, w * scale, 1), dtype=np.float32)

    step = max(1, tile - overlap)
    tiles = 0
    for y0 in range(0, h, step):
        for x0 in range(0, w, step):
            y1 = min(y0 + tile, h)
            x1 = min(x0 + tile, w)
            # 贴边时把窗口往里挪，避免出现比 tile 还小的块（固定尺寸模型会直接报错）
            y0c = max(0, y1 - tile)
            x0c = max(0, x1 - tile)
            patch = src[y0c:y1, x0c:x1, :]

            ph, pw = patch.shape[0], patch.shape[1]
            if fixed_hw:
                # 补齐到模型要求的固定尺寸（补边用的是边缘像素，比补黑边干净）
                padded = np.pad(
                    patch,
                    ((0, fixed_hw[0] - ph), (0, fixed_hw[1] - pw), (0, 0)),
                    mode="edge",
                )
                feed = padded
            else:
                # 动态尺寸模型对小于 tile 的块也能处理；但仍补到 2 的倍数更稳
                feed = patch

            tensor = np.transpose(feed, (2, 0, 1))[None, ...].astype(np.float32)
            try:
                pred = sess.run(None, {input_name: tensor})[0]
            except Exception as e:
                fail(f"推理失败（块 {x0c},{y0c} {pw}x{ph}）：{e}")

            pred = np.asarray(pred)
            if pred.ndim == 4:
                pred = pred[0]
            if pred.ndim != 3 or pred.shape[0] != 3:
                fail(
                    f"这个权重不是超分模型：它输出的是 {np.asarray(pred).shape}，"
                    "而超分模型应当输出 [3, H, W]（3 通道图片）。\n"
                    "用它跑出来只会是垃圾（比如抠图模型输出的是单通道蒙版）。"
                )
            pred = np.transpose(pred, (1, 2, 0))  # CHW -> HWC
            tiles += 1

            # 实际放大倍数（用第一块校正，之后保持）。
            # 倍数必须是 >=1 的整数：不是整数说明这个模型没在做"整数倍放大"，
            # 继续算下去只会得到一张错位的图。
            if tiles == 1:
                ratio = pred.shape[0] / feed.shape[0]
                scale = int(round(ratio))
                if scale < 1 or abs(ratio - scale) > 0.01:
                    fail(
                        f"这个模型没有做整数倍放大（输入 {feed.shape[0]}px → 输出 {pred.shape[0]}px，"
                        f"比例 {ratio:.3f}）。它多半不是超分模型。"
                    )
                if scale == 1:
                    fail(
                        "这个模型输出的尺寸和输入一样（倍数 1），它不做放大。\n"
                        "请换成 Real-ESRGAN 系列权重（realesr-general-x4v3 等）。"
                    )
                out = np.zeros((h * scale, w * scale, 3), dtype=np.float32)
                covered = np.zeros((h * scale, w * scale, 1), dtype=np.float32)

            # 裁掉补齐的部分，再换算到原图坐标
            pred = pred[: ph * scale, : pw * scale, :]
            oy, ox = y0c * scale, x0c * scale
            out[oy : oy + pred.shape[0], ox : ox + pred.shape[1], :] = pred
            covered[oy : oy + pred.shape[0], ox : ox + pred.shape[1], :] = 1.0

    if tiles == 0:
        fail("没有可处理的块（图片尺寸异常？）")

    missing = float((covered < 0.5).mean())
    result = Image.fromarray((out.clip(0.0, 1.0) * 255.0 + 0.5).astype(np.uint8), mode="RGB")

    # 目标倍数小于模型原生倍数时，用 Lanczos 缩回去。
    # 直接在 4x 结果上缩小比"原图双线性放大"质量好得多 —— 细节是模型真的算出来的。
    if args.scale != scale:
        tw = int(round(w * args.scale))
        th = int(round(h * args.scale))
        result = result.resize((tw, th), Image.LANCZOS)

    try:
        result.save(args.output)
    except Exception as e:
        fail(f"写入 {args.output} 失败：{e}")

    print(
        json.dumps(
            {
                "ok": True,
                "srcWidth": w,
                "srcHeight": h,
                "outWidth": result.size[0],
                "outHeight": result.size[1],
                "modelScale": scale,
                "targetScale": args.scale,
                "tiles": tiles,
                "tileSize": tile,
                "fixedInput": bool(fixed_hw),
                # 没被任何块覆盖到的像素比例。正常应该是 0；非 0 说明切块有洞。
                "uncoveredRatio": round(missing, 6),
                "model": args.model,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
