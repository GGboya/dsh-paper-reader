# TODO — dsh-paper-reader 插件开发路线

> 目标：把 pdfqa（Go 独立版）的核心能力重写为 DeepSeek Harness 插件。
> 原则：agent 循环 / 模型层交给 dsh 框架，只做「转录 + 检索 + 存档 + 阅读器 UI」。

## Phase 0 — 环境验证（半天）

- [x] 安装 dsh：`npx @deepseek-ai/dsh web`，确认 http://127.0.0.1:3080 能打开
  - ⚠️ 若 npm install 卡死，加 `--legacy-peer-deps`（已知坑 [Discussion #4236](https://github.com/deepseek-ai/deepseek-harness/discussions/4236)）
  - ✅ 0.1.5-rc.1 直接跑通；token 鉴权：URL 带 token → 303 种 cookie → 200
- [x] 跑通官方最小插件（Cordis `apply(ctx)` + `console.log`），确认 `--patch` 加载机制
  - ✅ `dsh --profile web --patch <yml>`（launcher flag，不能放 `web` 子命令后）；本地文件用绝对路径，loader 归一化为 file:// URL
- [x] 用 `create-dsh-plugin` 的 **webui 模板** 生成脚手架，确认当前 DP 版本的 UI 注册 API 可用（这是后续所有 UI 工作的地基，API 可能有破坏性变更，先验证再动工）
  - ✅ webui（工具卡片）+ panel（`ctx.webServer` 路由 + `settings.section` 面板）均 --verify 通过；panel 装进 web profile 实测 `/hello-panel/ping` 200
  - ✅ UI slot 清单已确认：`settings.section` / `sidebar.panellist` / `main` / `rightbar` 等存在
  - 📌 关键坑：@deepseek-ai/dsh-tools 要用 next 线 0.1.5-rc.2（latest 是 stale 0.0.1-rc.1）；cordis 只 import type；纯 ESM

## Phase 1 — 工具层闭环（1~2 天）

- [x] `transcribe_pdf` 工具：shell 调 python3 + PyMuPDF 本地提取（移植 pdfqa 的三级策略，视觉兜底可后置）
  - ✅ 缓存 → 本地提取（页眉页脚剔除/连字/断词/段落重排全移植）；视觉兜底返回明确错误
  - ✅ 增量设计：转录产出 `.pages.json` 页码偏移表；pdfqa 时代旧缓存（有 .txt 无索引）读取时自动补建（长度相近才回写，视觉转录缓存不覆盖）
- [x] `search_paper` 工具：长文档分段检索，返回带页码的片段
  - ✅ chunkText(1500) + 词频×词长打分移植；片段经偏移表映射页码；未转录时自动先转录
- [x] 文献库存储：插件数据目录约定（专题 > 文献 > 转录缓存），兼容 pdfqa 的 `data/` 布局思路
  - ✅ `<dataDir>/<专题>/<文献>.pdf|.txt|.pages.json|<文献>-qa/`；pdf2zh 产物（-en/-zh/-dual）不算文献
  - ✅ dataDir 可配（cordis.patch.yml config / DSH_PAPER_READER_DATA / 默认 ~/.dsh-paper-reader/data）
- [x] 问答 Markdown 存档：每轮追加写 `<文献名>-qa/<会话>.md`
  - ✅ `archive_qa` 工具（问题/回答/引用页码/会话名），工具描述驱动 agent 每次回答后存档
  - ✅ 另有 `list_papers` 工具做库发现
- [x] 在 dsh 会话里实测：让 agent 读一篇真实论文并回答引用页码
  - ✅ headless profile 实测：agent 自主完成 list→transcribe（旧缓存自动升级页码索引）→search→带页码回答（第 4/5/10 页，与原文一致）→archive_qa 落盘到 pdfqa 数据目录

## Phase 2 — 阅读器页面（工作量主体）

- [x] 通过 `webServer` 服务注册 HTTP 路由：serve 阅读器页面 + PDF 文件 + 转录数据接口
  - ✅ `/paper-reader/` 页面 + `/api/library|paper|pdf|transcribe|qa|ask`
  - ✅ 安全：插件路由不在宿主鉴权路径上，已用 `connection.requestRejection` 补齐（401/403，与宿主 /api 同一套 Host 围栏+cookie 校验）
- [x] 注册侧栏 tab / 页面入口（参考 DSH-better-sidebar 的注册方式）
  - ✅ `main` keyed slot（key=paper-reader，iframe 承载阅读器）+ `sidebar.panellist` 图标入口（id=key，点击自动 selectPanel）
- [x] 移植 pdfqa `static/` 的阅读器前端：PDF.js 渲染、缩放、Retina 高清、文本层
  - ✅ dpr 监听重渲/锚点滚动保持/文本层/--scale-factor 均已移植；浏览器实测 13 页 2526 spans
- [x] 「选中即问」：选中文字 → 注入 dsh 会话并提问（需要查 dsh 的会话 API / frontend-tools 桥接）
  - ✅ 走 host 侧官方服务 `sessionController.create+prompt`（确定性 sessionId `dpr-<base64url(topic/name)>`，每篇文献一个伴读会话，重启可续）
  - ✅ **右侧就是真正的 dsh 会话**（用户反馈重做）：`sessionController.follow()` 拿到开场快照+持久事件+assistant-stream 增量帧，host 桥接为 SSE `/api/session/follow`，阅读器打字机渲染（复用官方 chunk 折叠语义：block-start/text-delta/tool-call-delta/block-end）；工具行紧凑展示（🔍 search_paper / 💾 archive_qa），页码链接可点
  - ✅ 与 dsh 主会话区同源：该会话在主界面会话列表里也能打开，内容一致
- [x] 引用定位：回答里的页码点击跳回 PDF 对应位置
  - ✅ 流式回答+历史消息里「第 N 页」均为可点击链接 → jumpToPage 平滑滚动+闪烁
  - 🔜 反向（dsh 主会话聊天里的页码 → 跳阅读器）需要 ConversationNodeDefinition，留后续
- [x] 中英切换（用户反馈补齐，对齐 pdfqa）
  - ✅ 顶栏「中」按钮：原文 ↔ 中英对照(-dual.pdf) ↔ 纯中文(-zh.pdf) 循环切换，复用 pdf.js 渲染器
  - ✅ 无译文时点击启动 babeldoc 后台生成（移植 pdfqa runPdf2zh；scratch 目录/HF 镜像/45min 超时），阅读器轮询状态
  - ⚠️ 生成需在 cordis.patch.yml 配 `translate.{baseUrl,apiKey,model}`（OpenAI 兼容端点，DeepSeek 官方 API 即可）；读已有译文不需要配置
- [x] 侧栏文献导航（用户反馈补齐）：阅读器内左侧 专题→论文 树（折叠组、当前高亮、记忆折叠态/上次打开），替代 dsh 的 项目→任务 视图
  - 📌 dsh 宿主侧栏的 `sidebar.workspaces` 是 single slot、先到先得，插件不该抢占 → 树做在阅读器面板内（pdfqa 原版布局即如此）
- [x] **侧栏工作区接管**（用户反馈 v2）：`sidebar.workspaces` single slot 按 `priority: -1000` 接管（lowest renders；`order` 只对 list slot 生效），侧栏中部变成 专题→论文 树；点击论文 = selectPanel('paper-reader') + 桥接 openPaper（localStorage dpr.last + window.__dprOpenPaper）
  - ⚠️ 代价：官方工作区/会话列表在本 profile 侧栏被遮蔽——本插件按「论文伴读专用 profile」设计；从 cordis.patch.yml 删掉本插件即恢复
  - ✅ 每篇文献多会话：sessionId `dpr-<b64>-N`，聊天头部 会话选择器+＋新建；旧格式（无 -N 后缀）会话自动归并为会话1，历史不丢
  - ✅ archive_qa 描述收紧：寒暄/元问题/与论文无关的内容不存档（修了"你好呀被存档"）；用户气泡只渲染 source.kind=user，skill-catalog/上下文注入不再泄漏进聊天
- [x] **原生对话组合**（用户反馈 v3：「直接用客户端的对话，注入不同上下文就行」——推翻自绘聊天，全官方 seam）：
  - 点论文 → `uiWorkspace.openSession(论文会话)`（主区=原生对话：流式/工具卡/用量条全原生）+ `sidebarRight.openTabIn` 开 PDF 页签（`sidebarRightTabs.register` 注册 tab 类型 + `sidebar.right.pane.tab` 挂内容 iframe）
  - ⚠️ 坑：`openTabIn` 对未收养会话静默 no-op → 轮询重试 + `revealIfOpened` 幂等
  - 阅读器回归纯 PDF（删掉了自写 SSE 聊天面板）：选中即问 → /api/ask 注入当前会话 → 原生对话区实时回答；弹层位置钳制在 iframe 视口内（rightbar 窄列可用）
  - ✅ 树三级：专题→论文→会话N（点会话切原生对话）；头部 ＋新建专题 / ⟳刷新；专题行 ⬆上传 PDF（host 新增 /api/library/topic、/api/library/upload、/api/sessions/new）
  - 彩蛋：会话 cwd=专题目录，rightbar 自带 Files 页签直接列论文文件（-zh.pdf/-qa/ 等）

## Phase 3 — 发布

- [ ] `dsh.bundle` / `cordis.patch.yml` 打包配置
- [ ] `dsh plugin --profile web add github:GGboya/dsh-paper-reader` 自测安装
- [ ] README 补截图 / 演示 GIF
- [ ] 确认 `dsh-plugin` topic 生效，可被 GitHub topic 页检索到
- [ ] （可选）投稿到 awesome-deepseek-harness 类索引仓库

## 备忘

- dsh 处于 Developer Preview，插件 API 可能破坏性变更 → 插件壳保持薄，核心逻辑（转录/检索）写成不依赖 Cordis 的纯函数模块，方便日后迁移
- Node 版本要求：`^22.19.0 || >=24`
- 本机 git 推 GitHub 需代理：`https_proxy=http://127.0.0.1:7897 git push`
