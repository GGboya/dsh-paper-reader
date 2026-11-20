# 版面检测 GPU 加速 — 实测报告（perf/gpu-layout-detection 分支）

日期：2026-11-20 · 环境：Windows 11 · NVIDIA GeForce RTX 4060 Laptop（8GB，驱动 566.24）
· babeldoc 0.6.4（`~/.dsh-paper-reader/.venv-pdf2zh`）· 模型 `doclayout_yolo_docstructbench_imgsz1024.onnx`（75MB，输入 1024×1024，逐页推理 batch=1）

## 背景

babeldoc 的 `docvision/doclayout.py` 出于稳定性**只挑 CPU provider**（macOS 除外，CoreML 自动启用），装了 GPU 版 onnxruntime 也不会用。本分支给 `runtime/babeldoc-driver.py` 加了补丁 3：按 `DPR_ONNX_DEVICE`（dml/cuda/auto）替换 ONNX 会话的 provider 列表，默认 `cpu` 零行为变化。插件侧新增「版面检测设备」选项（`translation-options.ts` 的 `layoutDevice`，随驱动环境变量传入）。

## 隔离基准（scripts/bench-doclayout.py，与生产同一模型/同一前处理）

| 样本 | CPU 均耗/页 | DML 均耗/页 | 加速比 |
|---|---|---|---|
| 论文 16 页（Satellite Computing） | 555.0 ms | 75.4 ms | **7.36x** |
| 幻灯片 176 页（cs329z lecture02） | 576.6 ms | 80.4 ms | **7.17x** |

session 加载：CPU 0.9s / DML 1.2~1.3s（一次性）。DML 数据为预热 1 页后的稳态（首跑含 kernel 编译，已排除）。

## 全链路对照（新驱动重跑 lecture02 完整翻译，插件同款参数，段落全走 babeldoc 缓存）

| 阶段 | CPU 运行 | DML 运行 |
|---|---|---|
| 解析 PDF | 8.8s | 9.4s |
| 检测扫描件 | 30.6s | 65.8s（受噪声影响，见下） |
| **分析版面** | **260.1s** | **58.6s（4.4x）** |
| 翻译段落 | 0.5s | 1.6s（缓存命中） |
| 排版 + 字体 + 绘图 + 保存 | ~15s | ~32s |
| **墙钟总计** | **333s** | **218s（-34.5%）** |

结论：

1. **管线内的版面阶段比隔离基准更贵**：CPU 260s vs 隔离 101s——逐页渲染锁 + 与 babeldoc 进程池抢 CPU。GPU 卸载后该阶段降到 58.6s，同时把 CPU 让给其它阶段。
2. **幻灯片/长文档收益大**：176 页的 lecture02 里版面占 CPU 总耗时的 78%，省 115s 墙钟。**16 页论文收益有限**（版面只 ~9s，LLM 才是大头），别对短论文期待整篇快多少。
3. 单次运行的 CPU 阶段有噪声（检测扫描件 30→66s 等），笔记本单样本，趋势可信、个位数别较真。

## 已知限制与坑（照实记录）

- **包共存态**：`onnxruntime-directml` 与 `onnxruntime` 发行版同名模块，pip 装完两者元数据共存（`onnxruntime 1.31.1` + `onnxruntime-directml 1.24.4`），**模块文件以 directml 为准**。日后单独升级 `onnxruntime` 会把文件悄悄盖回 CPU 版——重装/升级后要复查 providers。babeldoc 修复路径（`uv pip install babeldoc`）只看发行版元数据，认为依赖已满足，不会碰它。
- **安装要求 venv 空闲**：有翻译在跑时 DLL 被锁，pip 报 WinError 5（实测遇到过，任务结束后成功）。
- **batch=1 吃不满 GPU**：上游 `predict()` 硬编码逐页推理，7x 是这个模型/分辨率下的实际值，不是 GPU 满载值。
- **上游的顾虑仍在**：babeldoc 注释明说 dml/cuda「特殊情况下可能出问题」，所以本能力是显式开关 + 会话创建失败如实回落 CPU（`falling back to CPU` 写日志），默认关闭。
- **macOS 无需此开关**：上游已自动走 CoreML（静态输入改写）。
- 长期正解是给 babeldoc 上游提 `--device` 参数或用其 `--rpc-doclayout` 独立 GPU 服务，本补丁是插件侧的低风险过渡方案。

## 复现

```powershell
# 前提：venv 空闲（无翻译在跑）
$py = "$env:USERPROFILE\.dsh-paper-reader\.venv-pdf2zh\Scripts\python.exe"
& $py -m pip install onnxruntime-directml          # Windows 通用；N 卡也可用 onnxruntime-gpu（需 CUDA+cuDNN）
& $py scripts\bench-doclayout.py --pdf <论文.pdf> --pages 16 --device cpu,dml
```

启用：阅读器「设置 → 全文翻译模型 → 高级设置 → 版面检测设备」选 GPU · DirectML（或 auto）；回落行为见 `docs/features.md` 同名条目。
