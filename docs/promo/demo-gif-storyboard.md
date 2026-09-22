# Demo GIF 分镜脚本 + 录制指引

> 目标：一个 25–35 秒 GIF，放在 README 顶部第一张图位置 + 所有外发帖子的主物料。
> 只拍一个闭环：**选中即问 → 回答带页码 → 点页码跳回 PDF 闪烁高亮**。
> 不需要旁白、不需要片头。配字幕式 overlay（可选，Kap/Screen Studio 支持）。

## 分镜（总计约 30 秒）

| 时间 | 画面 | 操作 |
|---|---|---|
| 0–3s | dsh 侧栏，鼠标移到「📚 论文伴读」开关 | 点击开关 → 侧栏变文献库树（展示 opt-in 设计） |
| 3–6s | 文献库树 | 点击一篇论文（如 Attention Is All You Need）→ PDF 在中间打开，右侧原生对话出现 |
| 6–10s | PDF 阅读器 | 鼠标选中一段文字 → 弹出提问框，输入「这段的 scaled dot-product 为什么要除以 √dk？」回车 |
| 10–18s | 右侧对话流式回答 | 等待回答完整出现，确保回答里有「第 4 页」之类的页码（提前试好 prompt，保证可复现） |
| 18–25s | **高潮镜头**：鼠标移向回答里的「第 4 页」链接 | 点击 → 平滑滚动回 PDF 第 4 页 → 对应原文段落闪烁高亮 —— 停留 3 秒让观众看清高亮 |
| 25–30s | 收尾 | 点一下顶栏「中」按钮，切换到中文版（一闪而过的彩蛋，展示翻译能力）→ 结束 |

## 录制要点

1. **先排练一遍**：确保选中的那段文字确实能引出带页码的回答（用同一篇论文、同一个问题试跑 1 次，确认回答含「第 N 页」）。
2. 窗口尺寸：1440×900 左右，16:9，别把鼠标录得太小。
3. 浏览器开 Retina/2x，GIF 帧率 15fps 足够（文件控制在 5MB 内，GitHub README 加载快）。

## 录制工具（macOS）

**方案 A（推荐，免费）：QuickTime + gifski**

```bash
# 1. QuickTime Player → 文件 → 新建屏幕录制 → 选区域录制，存 demo.mov
# 2. 转 GIF（装一次：brew install gifski ffmpeg）
ffmpeg -i demo.mov -vf "fps=15,scale=1440:-1:flags=lanczos" -c:v pam -f image2pipe - | \
  gifski --fps 15 --quality 90 -o docs/demo.gif -

# 顺手压一个 mp4（X/Discord 发视频用这个，画质更好）
ffmpeg -i demo.mov -vf "scale=1440:-2" -c:v libx264 -crf 23 -pix_fmt yuv420p docs/demo.mp4
```

**方案 B（更省事，付费）**：Screen Studio —— 自动平滑鼠标、自动 zoom-in 高潮镜头，导出 mp4 后用上面的 gifski 命令转 GIF。

## 录完之后

```bash
# README.md 和 README_EN.md 里，第一张截图之前插入：
# ![Demo: select-to-ask, cited pages jump back to the highlighted passage](docs/demo.gif)
git add docs/demo.gif docs/demo.mp4 README.md README_EN.md
```

注意 GIF 文件名固定用 `docs/demo.gif` —— 所有 promo 文案里引用的都是这个名字。
