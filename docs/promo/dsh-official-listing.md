# dsh 生态内曝光（官方渠道实况）

> ✅ 已核实（2026-09）：dsh 官方仓库**没有**社区插件索引文件，官方 README 给的发现路径是：
> 1. **GitHub topic `dsh-plugin`**（https://github.com/topics/dsh-plugin）—— ✅ 已加，仓库已可被搜到
> 2. **官方 Discord**（https://discord.gg/Ycq5dCaS4）—— 主战场，插件发布后去 showcase/插件频道发
>
> 所以不用提收录 PR。动作 = Discord 发一帖 + 可选 issue。

## Discord 发帖文案（showcase / plugins 频道）

Hey! Sharing a plugin I've been building: **dsh-paper-reader** v1.0 — turns the workspace into a paper reading workbench.

`dsh plugin --profile web add @ggboy123/dsh-paper-reader` · MIT · https://github.com/GGboya/dsh-paper-reader

- **Opt-in**: official UI untouched; a sidebar toggle switches into reading mode (paper library tree)
- **Native chat**: real dsh sessions (streaming / tool cards / usage), bound to papers via session id
- **"Paper Tutor" preset**: reading plan → section coaching → quizzes → graded study profile across sessions
- **Clickable citations**: answers cite page numbers; clicking jumps to the PDF and flashes the exact passage
- Pure-Node PDF transcription (pdf.js, no Python); optional one-click Chinese translation (babeldoc, zero preinstall)

Demo GIF + docs in the repo. Feedback very welcome!
