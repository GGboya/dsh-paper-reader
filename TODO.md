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
- [x] ~~问答 Markdown 存档：每轮追加写 `<文献名>-qa/<会话>.md`~~ → **已移除**（2026-09-17 用户决策）：dsh 会话本身持久化，自动存档冗余且有误判/复述噪音；archive_qa 工具、/api/qa 路由、/api/ask 注入指令全部删除，磁盘上已有 -qa/ 笔记保留不删
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
  - ✅ 顶栏「中」按钮两态切换：原文 ↔ 纯中文(-zh.pdf)，无纯中文时退中英对照(-dual.pdf)；切换变体强制重算适宽（页宽不同，不重算会溢出裁切），复用 pdf.js 渲染器
  - ✅ 无译文时点击启动 babeldoc 后台生成（移植 pdfqa runPdf2zh；scratch 目录/HF 镜像/45min 超时），阅读器轮询状态
  - ✅ 生成端点改为 **UI 内填写**（点「中」或 ⚙ → 弹表单填 URL/Key/模型，保存前先测连接）：存 `$DSH_HOME/.dsh-paper-reader/translate.json`（0600，密钥不进文献库）；cordis.patch.yml 的 `translate` 退为部署方默认值。读已有译文不需要配置
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
  - ✅ 会话挂 dsh 工作区（`workspaceController.create({path: 专题目录})` 幂等）：否则新会话 composer 锁死在 "Choose a workspace"
  - ✅ bugfix 三连（已实测）：① 新建对话二次创建（enter 闭包吃旧列表 → 拆 activate + 永远拉新列表 + 指定 n 绝不新建）② openTabIn 静默 no-op → 等 seat 绑定后只调一次 openTab（成功即停，否则用户关页签被轮询重开）③ openSession 需等客户端目录收录 → 轮询 `uiWorkspace.sessions.list` 到 listed 再切；锚点高亮在会话叶子而非论文行；空白会话只留最新一个（自动清理被遗弃的新建）

## 进行中 / 已知问题

- ✅ 放大裁切修复：#pdf-pages 改 `align-items: safe center`（页宽超视口时退回左对齐，右侧可滚；普通 center 会左右同溢且左侧滚不到）
- ✅ **布局换位：中间论文、最右对话**：对话组件绑死 main slot，官方无"对话进 rightbar" seam → 视觉换位：PDF 页签挂载时把 grid rightbar 列钉第 2 轨（宽）、center 列钉第 3 轨（窄），列宽/拖拽/折叠仍是 dsh 原生。坑三连：① auto-placement 按 DOM 序，只钉 rightbar 与 center 重叠 → 两列都钉 ② 只钉列不钉行被挤进隐式行高度塌 0 → 行列都钉 ③ 面板[data-sidebar-right-panel]锚列右缘+内联宽度 → 钉 100% + MutationObserver 防拖拽覆盖。关页签全还原（PdfTab cleanup）。整页阅读 main 面板删除
- ✅ **会话上下文自定位**（2026-09-17）：工具 execute 第二参 exec.agent.id = 会话 id → 反解 `dpr-<base64url(topic/name)>-N` 得绑定论文；topic/name 省略时自动定位。直接在 composer 提问（不提论文名）实测：agent 连发 5 个 search_paper 并引用第 2 页原文作答。persona 加了「会话绑定论文，永远不要问是哪篇」
- ✅ ~~会话页签条~~ → **历史下拉**（用户反馈"页签条太丑/只要一个对话"）：对话列右上浮动 🕐＋ 按钮组，🕐 下拉列该论文全部会话（真实标题+日期，当前高亮），点哪条进哪条；＋ 新建。⚠️ 大坑：`conversation.session.header.actions`（list/session 作用域）对动态包（ModuleLoader）注册的条目不渲染（register 成功但零渲染；effect 里直接 register 则因 slot 未声明抛错连带炸掉树）→ 放弃 slot，portal fixed 浮动组对齐头部原生按钮左缘（class 含 headerCorner/Utilities/Actions 子串定位，hash 前缀跨版本会变但子串稳定）
- ✅ 阅读器健壮性：换位/条带触发 iframe resize 时 pdfDoc 未加载 → getPage null 刷屏；fitToWidth/setZoom 加空值守卫
- ✅ **新建/切换对话时 PDF 不再跟着动**（用户反馈"整页都在动"）：rightbar 页签内容随会话 seat 重绑整体重建（TabSlot 以 tab.id 为 key）→ iframe 重载滚动清零。改为：PdfTab 只剩占位锚点，真正的阅读器 iframe 由常驻 ReaderOverlay 持有（fixed 覆盖锚点矩形，隐藏用 visibility 不用 display:none——后者布局归零清滚动）；布局换位随之迁入 ReaderOverlay 且**锚点消失 1.2s 才撤钉**（seat 间隙不撤钉 → 无 resize → 不触发重渲）；reader 锚点改 scrollTop 比例（DOM rect 法在并发重渲时锚点归零）。实测：新建/切历史会话 iframe 存活、滚动保持、零报错
- ✅ **整屏持续闪烁修复**（用户反馈）：① width 拔河：200ms 钉 width=100% vs dsh 每次 store 提交重写内联 width → 改钉 React 不管的 `max-width` + 全部写入值守卫 ② 切换时"先消失再出现"：seat 重绑空窗期右栏折叠，而我们把对话钉在 0 宽的第 3 轨 → 换钉逻辑按**右栏轨宽**自判断（折叠即撤钉）；切换期间设官方 `data-rightbar-instant` 禁掉开合慢动画；悬浮层隐藏加 900ms 迟滞（间隙里 PDF 原位不动）；openTabIn 预开页签（等目录收录再切）。逐帧实测：全程瞬时、无涨落动画、PDF 冻结
- ✅ 问答存档**整体移除**（用户决策：dsh 会话存储已够）：archive_qa 工具 / /api/qa 路由 / /api/ask 存档指令 / persona 存档策略全删，"已存档到…"复述从根上消失；已有 -qa/ 文件保留
- ✅ 专用 agent preset「论文伴读」(paper-reader)：插件自带 presets/paper-reader/，启动时复制到 $DSH_HOME/.agent-presets/（实时扫描免重启），createPaperSession 传 agentPreset，旧会话 preset 冲突自动回退。session header 实测 agentPreset:"paper-reader"
- ✅ **preset 升级为"老师"**（2026-09-17 用户反馈）：persona 双模式——快速问答（选中即问直接答）+ 引导学习（读档案→制定 3~6 步计划→逐节带读+思考题→点评→出题检验→批改记档→针对性复习建议）。学习档案 = 每篇论文 `<文献>.study.json`（计划步骤状态 + 历次检验分数，结构化状态 dsh 会话存储替代不了）；新增 study_progress/study_update 工具。实测全流程：制定 5 步计划→点评补记→拒绝超范围出题→3 题检验→逐题批改抓出故意答错→7/10 落盘。坑：乱序 complete_step 会出现多个 current，completeStep 已加归一化（current 恒为第一个未完成步骤）
- ✅ **新建会话"整页跟着动"根治**（2026-09-17 用户反馈，CDP 逐帧实测定位）：`rightbar.session` 是 session 作用域 slot，切会话 = seat 整体重挂，旧 seat 卸载 + 新 seat 初挂（surface 未建）各汇报一次 closed → 右栏轨道塌 0 → 对话列消失/PDF 列撑满 → 换位撤钉 → openTab 再撑开 = 整页乱动。**预开路径对新建会话恒失效**：`openTabIn` 对未被 adopt 的 store 静默 no-op（新建会话要等成为当前会话才 adopt，实测创建后等 2.5s 仍 no-op），且非当前会话 surface 无 API 可读、无法验证。改为**切换护栏**（beginSwitchGuard，1.5s 窗口）：① 吞掉共享 `ctx.layout.closeRightbar` 汇报（grid 冻结在当前轨道，openRightbar 照放）② ReaderOverlay 锚点测量/几何冻结（applySwap 照跑——新面板的 maxWidth 钳制必须尽快钉上，否则左溢盖侧栏，实测锚点 x=168）③ 补一条 `[data-rightbar-instant] [data-sidebar-right-panel]{transition:none}` （官方 instant 只管 grid/handle，不管面板 transform 滑动）；窗口结束对账：面板真没开（被收起/开页签失败）才补一次真实 close。openPdfTab 轮询 300→100ms 压短面板空白。headless Chrome 逐帧验证：新建/切历史/连点两次新建，grid 列宽、PDF 列、对话列、overlay 全程零位移，只有对话内容换
- ✅ **AI 会话标题确认可用**（2026-09-17 用户提的"title 记得 ai 自己生成"）：无需自研——web profile 已挂 `dsh-session-title-first-prompt-llm`（deepseek-flash，route 自动跟随会话首问的模型），首问后自动生成并落 `session/title` 事件；历史下拉读 `snap.byId[sid].title` 直接显示实测 OK（"Google 为什么需要 MapReduce"/"reduce 函数的 values 为何是迭代器"…），空白会话无标题（本就不再留存，见下）
- ✅ **空白会话不留存**（2026-09-17 用户反馈）：三层处理 ① `/api/sessions/new` 复用：最新可见会话还是空白草稿就直接复用（连点"新建"不堆积）② 切走即归档：activate() 发现离开的是空白 dpr- 会话 → POST `/api/sessions/archive` → 官方 `workspaceRegistry.archiveSession`（日志保留、全列表隐藏；宿主无删除 API，归档即官方删除语义）③ listPaperSessions 对账：非最新的空白顺手归档（历史遗留一次清光）。⚠️ 大坑：n 分配必须基于**全量扫描**（scanPaperSessions，含归档/空白）——过滤后列表算 maxN+1 会和磁盘上已归档（可能被别的进程 flock）的目录撞号，`SessionAlreadyOwnedError`（实测）；`/api/ask fresh` 同修。headless 实测：基线自动清掉历史空会话、新建→62(blank)、再点复用 62、切走后消失
- ✅ **翻译端点改为 UI 内配置**（2026-09-17 用户反馈"点中报 http 409"）：两个问题 ① 端点没配是设计内拒绝，但前端把服务端的 `reason` 吞了——`api()` 只读 body 的 `.error`，取不到就退化成 `"HTTP 409"`，三处 helper 补 `.reason` 回退 ② 新增 `/api/translate/config` GET/POST/DELETE：GET 只回掩码 key（明文永不离开服务端），POST 先打一发 `max_tokens:1` 的 chat/completions 预检、通过才落盘 0600（babeldoc 单次跑几分钟且**异步失败**，只落进 busy map，key 填错要等很久才知道）。`startTranslation` 未配端点返回 `code:'no-endpoint'`，前端靠它弹表单而非匹配中文文案。⚠️ 宿主的 `credentials` 服务是**只写不可读**（"no read path returns it"），而 babeldoc 要明文 key 传命令行 → 不能复用，故自存文件
- ✅ **侧栏收起成 rail**（2026-09-17 用户反馈"显然不符合预期"）：`sidebar.workspaces` 槽传 `{wide, expandSidebar}`，官方 WorkspaceBrowser 在 `!wide` 时渲染图标入口并调 `expandSidebar()`；本插件注册方把槽 props 整个丢了 → 全宽树被塞进 56px 挤成竖排文字。改为 `wide === false` 时渲染 📚 图标按钮（用 `=== false` 而非 `!wide`：宿主没传该 prop 时按展开态走 = 改动前行为）。ReaderOverlay/SessionActions 始终挂载——阅读器和对话头部浮动按钮不属于侧栏，收起时不能跟着消失
- ✅ **拖会话栏导致阅读器右移变窄**（2026-09-17 用户反馈"pdf 就乱了"，CDP 拖拽实测定位）：dsh 把右栏面板内联宽度写成 `cols.rightbar` 且锚在列右缘；换位后 col 落在 `1fr` 轨（拖动时常比配置宽度**宽**）→ 面板不撑满就缩在列右半边，锚点跟着跑（实测 iframe x=800 w=300，而列是 280..1100）。补 `minWidth:100%`——⚠️ 不碰 `width`：dsh 每次会话提交都重写内联 width，抢同一属性会持续闪烁（值守卫那套同理）。与既有 `maxWidth:100%` 合起来，面板宽度恒等于轨宽（宽则撑满、窄则钳制，两个方向都实测）
- ✅ 阅读器工具栏窄列被压扁（「适宽」变竖排）：`#status` 缺 `min-width:0`，flex 项默认 `min-width:auto` 拒绝收缩 → 浏览器转而压旁边的按钮。改让标题自己截断（它本就有 ellipsis）+ 按钮 `flex:none`
- ✅ **论文伴读模式开关（2026-09-18 用户决策「不要一装就覆盖人家」）**：sidebar.workspaces 从常驻接管改为**按需注册**——默认不注册（官方侧栏原样），sidebar.footer.action（list slot，侧栏底部常驻）放「📚 论文伴读」开关行，点击注册/再点注销，localStorage `dpr.mode` 记忆。两个配套迁移：① ReaderOverlay/SessionActions 从 LibraryTree 挪到 shell.overlay 常驻注册（官方钦定的整页浮层自留地，list slot）——退出模式时已打开的 PDF 页签/伴读会话照常活着 ② LibrarySection 移到模块级 applyPaperMode() 里注册/注销。坑：list slot 注册要 `options.id` 不是 `key`（报 "list slot requires options.id"，shell.overlay / footer.action 都踩了；sidebar.right.pane.tab 用 key 是历史兼容）。CDP 四态实测：默认官方+开关行 → 点开树现 → 开论文 anchor 在 → 再点官方还原且 anchor 仍在
- ✅ README 截图（CDP headless Chrome 实拍）：docs/screenshot-default.png（默认安装=官方侧栏+开关行）、docs/screenshot-reading.png（伴读模式三栏全景）；README 用 GitHub raw 绝对 URL 引用（npm 页面也能显示）。演示 GIF 待做
- Phase 3 待续：（可选）演示 GIF、（可选）投稿 awesome-deepseek-harness 类索引仓库

## Phase 3 — 发布

- [x] `dsh.bundle` / `cordis.patch.yml` 打包配置（`package.json` 的 `dsh.bundle.patch` → 仓库根 `cordis.patch.yml` 的 insert 条目）
- [x] `dsh-plugin` topic 已生效（仓库 topics: dsh-plugin / deepseek-harness / paper-reader / pdf / agent）
- [x] **自测安装（npm 路线，2026-09-18 完成）**：发布为 `@ggboy123/dsh-paper-reader@0.1.0`，一次性 profile 实测 `dsh plugin add @ggboy123/dsh-paper-reader` → dist 在 → 启动 → 工具/路由注册，全绿
  - 为什么走 npm（2026-09-17 实测排除了其他路）：git 安装（`github:...`）拿不到 dist（gitignore）且**整个 profile 起不来**；`prepare` 脚本被 pnpm **硬错误**拦死（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`，allowBuilds 在消费方手里）；免构建（Node 跑 TS）被 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` 拒绝。`npm pack` 的 files 白名单压过 .gitignore → 发布产物天然含 dist
  - ⚠️ 裸名 `dsh-paper-reader` 在 npm 已被占用（rantz 的另一个「精读报告」插件）→ 走 `@ggboy123` 作用域；loader 条目 id 保持 `dsh-paper-reader` 不变（与包名解耦），用户 profile 里的 `- id:` 配置定位不受影响
  - 发布流程备忘：新账号发布被 403 强制要求 2FA → npm 网页开 2FA 后 `npm publish --access public` 走浏览器验证；**PUT 200 后 registry/unpkg/jsDelivr 全 404 约半小时**（新账号首发同步延迟，属正常，别重复发布）；每次发版前 `npm version patch/minor`
  - 本地两个 profile（web/headless）的 link: 依赖与 bundles 已同步改为 `@ggboy123/dsh-paper-reader`
- [x] README 补截图（CDP 实拍两张：默认态 + 伴读模式全景）；演示 GIF 仍可选
- [ ] （可选）投稿到 awesome-deepseek-harness 类索引仓库
- [ ] 阅读器显示插件版本号（2026-09-20 用户反馈定位需求）：从 package.json 注入版本到阅读器页脚或「论文伴读」开关行，用户截图反馈时一眼可见版本，不用远程指挥敲命令

## 备忘

- dsh 处于 Developer Preview，插件 API 可能破坏性变更 → 插件壳保持薄，核心逻辑（转录/检索）写成不依赖 Cordis 的纯函数模块，方便日后迁移
- Node 版本要求：`^22.19.0 || >=24`
- 本机 git 推 GitHub 需代理：`https_proxy=http://127.0.0.1:7897 git push`
- ✅ **babeldoc 可选参数探测（0.2.1，2026-09-18）**：`--skip-figure-text` 只在 fork（funstory-ai/BabelDOC PR#616）里，PyPI 版不认识 → 其他用户翻译必炸（"unrecognized arguments" 启动即退）。`launch()` 前对 bin 跑一次 `--help` 提取支持参数集（`babeldocFlags()` 进程内按 bin 缓存），skip-figure-text / no-auto-extract-glossary / openai-thinking 三个可选参数探测不到就不传：功能降级但核心流程可用。探测失败按最老参数集运行。重叠修复本身在 BabelDOC 侧（fork 分支 fix/merge-vertically-contained-paragraphs，上游 PR#617，本机 pdfqa venv editable 安装实时生效），其他用户要等上游合并发版
- ✅ **babeldoc 零预装自动安装（0.4.0，2026-09-20）**：用户无 Python 环境也能用翻译——`ensureBabeldoc()`（babeldoc-install.ts，单例防并发）：① 找 uv（插件托管位 → PATH → ~/.local/bin → ~/.cargo/bin）② 没有则从 GitHub **API 通道**下载（github.com 页面域在国内/本机直连不可达，api.github.com 可达；asset digest 做 sha256 校验，fetch 下载无 quarantine xattr 不会被 Gatekeeper 拦）③ `uv venv --python 3.12 --python-preference only-managed`（uv 自下载托管 Python，避开系统残缺/externally-managed Python）④ `uv pip install babeldoc`。venv 落 `dirname(dataDir)/.venv-pdf2zh`（与 findBabeldoc 第一候选位严格一致）。安装期间 `zhStatus.phase` 逐阶段上报（1/3 下载 uv → 2/3 Python → 3/3 babeldoc），阅读器状态栏 5s 轮询展示；`/zh/generate` 响应带 `firstRun` 让前端 toast 提示首次安装。沙箱 e2e 实测全程 3.5 分钟。win32 不支持自动安装（报错给手动指引）。⚠️ 装的是 PyPI 版 babeldoc——fork 修复（PR#617/#618 排版、PR#616 skip-figure-text）合并前，新用户译文仍有已知排版问题

## 附:DSH Desktop 兼容性实测(2026-09-23,v2.0.13 / 内置 dsh 0.1.5-rc.2)

- [x] 安装:`desktop` profile 被 Electron 独占,须走 Desktop 托盘终端(等价调用:`ELECTRON_RUN_AS_NODE=1 DSH_DESKTOP_DEFAULT_PROFILE=desktop <App exe> --expose-internals lib/desktop-cli.js plugin add ...`)
- [x] 核心流程全通:侧栏接管 / 文献库树 / openSession 原生会话 / openTabIn PDF 页签 / follow SSE 历史加载 / 页码引用跳转闪烁 / 选中即问弹窗与注入(实测 agent 带页码回答)/ babeldoc 引擎自动安装+翻译全链路
- [x] 端口实测稳定(重启后仍 43120),localStorage 丢失风险比文档口径低,仍建议观察
- [x] 顺手修:翻译完成后状态栏残留「正在安装翻译引擎(3/3)…」(refreshZhState 只在 busy 时写 status,从不恢复)
