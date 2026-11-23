#!/usr/bin/env python
"""bench-doclayout.py — 版面检测（DocLayout-YOLO ONNX）CPU vs GPU 计时。

与 babeldoc 生产路径完全同一模型、同一前处理（with_target_long_edge → 1024 →
OnnxModel.predict），唯一变量是 InferenceSession 的 provider——即驱动脚本
install_layout_device() 补丁做的事。用于评估 GPU 加速的真实收益。

用法（必须用 babeldoc 同一 venv 的 python，模型资产才在位）：

  <venv>/Scripts/python.exe scripts/bench-doclayout.py --pdf a.pdf \
      [--pages 12] [--repeat 2] [--device cpu,dml]

输出每设备：模型加载耗时、预热后逐页均耗（min of repeat）、总耗时。
预热页不计入——DirectML 首跑要编译 kernel，不代表稳态。
"""
from __future__ import annotations

import argparse
import sys
import time

PROVIDER_BY_DEVICE = {
    "cpu": None,  # babeldoc 原行为：由 OnnxModel 自己挑（只有 CPU）
    "cuda": "CUDAExecutionProvider",
    "dml": "DmlExecutionProvider",
}


def main() -> int:
    parser = argparse.ArgumentParser(description="DocLayout ONNX CPU/GPU benchmark")
    parser.add_argument("--pdf", required=True, help="被测 PDF 路径")
    parser.add_argument("--pages", type=int, default=12, help="取前 N 页（默认 12）")
    parser.add_argument("--repeat", type=int, default=2, help="整批重复次数，取最快一次（默认 2）")
    parser.add_argument("--device", default="cpu,dml", help="逗号分隔的设备列表：cpu/dml/cuda")
    args = parser.parse_args()

    import pymupdf
    from babeldoc.docvision.doclayout import OnnxModel
    from babeldoc.format.pdf.document_il.utils.raster_geometry import with_target_long_edge

    doc = pymupdf.open(args.pdf)
    total_pages = min(args.pages, doc.page_count)
    if total_pages <= 0:
        print(f"[error] {args.pdf} has no pages")
        return 1
    images = []
    for i in range(total_pages):
        geometry = with_target_long_edge(doc[i], 72, 1024, normalize_rotation=True)
        images.append(geometry.image[:, :, ::-1])
    print(f"pdf={args.pdf} pages={total_pages} imgsz=1024")

    import onnxruntime

    available = list(onnxruntime.get_available_providers())
    real_session = onnxruntime.InferenceSession
    summary = {}
    for dev in [d.strip().lower() for d in args.device.split(",") if d.strip()]:
        provider = PROVIDER_BY_DEVICE.get(dev, "?")
        if dev not in PROVIDER_BY_DEVICE:
            print(f"[skip] unknown device: {dev}")
            continue
        if provider and provider not in available:
            print(f"[skip] {dev}: {provider} not in {available}（装了对应 onnxruntime 再测）")
            continue

        def patched(*a, _provider=provider, **kw):
            if _provider:
                kw = {**kw, "providers": [_provider, "CPUExecutionProvider"]}
            return real_session(*a, **kw)

        onnxruntime.InferenceSession = patched
        try:
            t0 = time.perf_counter()
            model = OnnxModel.from_pretrained()
            load_s = time.perf_counter() - t0
            model.predict(images[0])  # 预热：kernel 编译/DNN 初始化不计入稳态
            best = None
            for _ in range(max(1, args.repeat)):
                t0 = time.perf_counter()
                for img in images:
                    model.predict(img)
                elapsed = time.perf_counter() - t0
                best = elapsed if best is None else min(best, elapsed)
        finally:
            onnxruntime.InferenceSession = real_session
        per_page_ms = best / total_pages * 1000
        summary[dev] = (load_s, per_page_ms, best)
        print(f"[{dev:>4}] session_load={load_s:6.1f}s  per_page={per_page_ms:7.1f}ms  batch_total={best:6.1f}s  (pages={total_pages}, repeat={args.repeat})")

    if "cpu" in summary and len(summary) > 1:
        for dev, (_, per_ms, _) in summary.items():
            if dev != "cpu" and summary["cpu"][1] > 0:
                print(f"speedup[{dev}] = {summary['cpu'][1] / per_ms:.2f}x")
    return 0


if __name__ == "__main__":
    sys.exit(main())
