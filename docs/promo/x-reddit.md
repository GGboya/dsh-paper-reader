# X / Twitter + Reddit 英文发布文案

## X / Twitter（主推文 + 视频）

> 附 30s demo 视频（MP4 直接上传，不要用外链）。发布时 @deepseek_ai，tag 放在推文内。
> 如果视频没准备好，先用 GIF。

**主推文：**

Tired of AI paper summaries you can't verify?

I built a plugin where every answer cites a page — and clicking the page jumps back to the PDF and flashes the exact passage.

It doesn't just answer questions. It teaches: reading plan → section-by-section coaching → quizzes → graded, tracked across sessions.

Open source (MIT) 👇
https://github.com/GGboya/dsh-paper-reader

@deepseek_ai #DeepSeek #PhDChat #AcademicTwitter

**后续推文（拆条，隔 2-3 天发一条，形成 thread 效应）：**

2/ The anti-hallucination rule I now enforce on every tool: if an AI claim can't be checked against the source in 3 seconds, the tool fails. So every citation in this plugin is clickable — page link → PDF → highlighted passage. Verification cost ≈ 0.

3/ The "strict tutor" mode is my favorite: it makes YOU answer questions after each section, grades them, and if you slack off it sends you back to re-read — with a clickable link to the exact pages. Scores persist across sessions in a study profile.

4/ Zero-install niceties: PDF transcription is pure Node (pdf.js, no Python). Chinese translation auto-installs babeldoc via uv + managed Python on first use — never touches your system Python.

## Reddit

> 各 subreddit 对自推容忍度不同，正文已按「自用故事 + 开源」的口吻写。
> r/PhD 一般允许工具分享；r/MachineLearning 查其自推规则，建议发在每周的 "D" discussion thread。

**r/PhD 标题：** I built an open-source AI paper-reading companion where every citation jumps back to the highlighted passage in the PDF

**正文：**

Like many of you, I use AI to help read papers — and like many of you, I've been burned by confident hallucinations. My rule now: every AI claim must be verifiable against the source in under 3 seconds, or the tool doesn't count.

None of the tools I tried did this well, so I built my own: an open-source plugin (MIT) for DeepSeek Harness that turns the agent workspace into a paper reading workbench.

What it does differently:

- **Clickable citations**: every answer cites page numbers; clicking one smooth-scrolls the PDF and flashes the exact passage. Not the page — the sentence.
- **Select-to-ask**: highlight any text in the reader, ask, get the answer inline in the chat.
- **A "strict tutor" mode**: instead of just answering, it builds a reading plan (with page numbers and reflection questions), coaches you section by section, quizzes you, grades each answer, and tracks weak points in a study profile across sessions. If your answer is lazy it sends you back to re-read — with a link to the exact pages.
- **Local-first**: PDF transcription and search happen locally (pure Node, no Python needed); documents never leave your machine. Optional one-click Chinese translation.

Repo: https://github.com/GGboya/dsh-paper-reader (30s demo GIF at the top)

Happy to answer questions, and brutally honest feedback welcome — it's a self-use tool I polished to 1.0.

## Hacker News（Show HN，可选，需要英文 demo GIF 就位再发）

**标题：** Show HN: Paper-reading plugin where AI answers cite clickable pages that flash the source passage

**正文：** （同 Reddit 正文压缩到 3-4 段，HN 偏好简洁技术向，去掉 emoji）

## Product Hunt（可选，建议放在有 star 基础后）

留到 GitHub star 过百、demo 视频打磨好之后。需要：icon、5 张截图、英文 tagline：
"AI paper companion — every citation clicks back to the highlighted source passage"
