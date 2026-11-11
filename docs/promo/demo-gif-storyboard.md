# Demo GIF 分镜脚本 + 录制指引

> 当前素材于 2026-11-10 按工作区 v1.9.0、DeepSeek Harness 0.2.2-rc.1 真实界面重录。
> 成片 40 秒，只拍一个闭环：**文献管理 → 选中即问 → 页码回答 → 原文高亮 → 中文视图**。
> 选中气泡同时展示新版「译 / 笔记 / 全局搜索」入口；不伪造按钮、回答、页码或高亮。

## 当前成片分镜（40 秒）

| 时间 | 画面 | 操作 |
|---|---|---|
| 0–4s | 默认工作区与「论文伴读」开关 | 点击进入，侧栏变为文献库树 |
| 4–7s | 文献管理 | 论文行「⋯」展开重命名 / 移动 / 删除菜单，不执行破坏性操作 |
| 7–13s | PDF 阅读器 | 打开 MapReduce 公开论文，放大摘要准备划选 |
| 13–17s | 选中即问 | 选中摘要首句，气泡展示「译 / 笔记 / 全局搜索」；输入问题并发送 |
| 17–28s | 真实回答 | 等待模型完成，回答中必须出现真实 `/paper-reader/?...&page=N&q=...` 链接 |
| 28–31s | 完整回答 | 恢复适宽，保留可点击页码与右侧完整回答 |
| 31–34s | **原文核对** | 点击带 `q` 引文的「第 1 页」→ 对应原文段落黄色高亮，停留供观众看清 |
| 34–40s | 中文视图 | 「视图：原文」→「中文（纯译文）」，展示同一阅读位置的中文 PDF |

## 录制与验收

1. 用隔离的录制数据目录，只放公开论文；不要把私人会话、其它文献或凭据带进画面。
2. 正式录制前排练一次：确认回答含可点击页码，点击后 `.textLayer span.dpr-hl` 确实出现。
3. 窗口与 MP4：1600×1000、25fps；GIF：1280×800、12fps、循环播放。
4. 当前文件：`docs/demo.mp4` 约 1.8 MB；`docs/demo.gif` 约 1.75 MB。旧版 6.5 MB GIF 已不再使用。
5. 同步替换 `docs/screenshot-default.png`（干净默认界面）与 `docs/screenshot-reading.png`（完整页码回答）。
6. 必须解码检查最终 GIF，而不只看源视频：重点看选区、页码链接、黄色高亮与中文视图。

## 转码命令

```bash
# Playwright 等真实浏览器录制得到 demo-source.webm 后：
ffmpeg -i demo-source.webm -c:v libx264 -preset slow -crf 21 \
  -pix_fmt yuv420p -movflags +faststart -an docs/demo.mp4

gifski --quality 76 --lossy-quality 72 --fps 12 \
  --width 1280 --height 800 --repeat 0 \
  --output docs/demo.gif demo-source.webm
```

README.md 与 README_EN.md 都固定引用 `docs/demo.gif`；外部帖子需要更好画质时使用同名 `docs/demo.mp4`。
