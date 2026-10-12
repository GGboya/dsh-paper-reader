# dsh-paper-reader

[![npm version](https://img.shields.io/npm/v/@ggboy123/dsh-paper-reader)](https://www.npmjs.com/package/@ggboy123/dsh-paper-reader)
[![npm downloads](https://img.shields.io/npm/dm/@ggboy123/dsh-paper-reader)](https://www.npmjs.com/package/@ggboy123/dsh-paper-reader)
[![license](https://img.shields.io/github/license/GGboya/dsh-paper-reader)](https://github.com/GGboya/dsh-paper-reader/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/GGboya/dsh-paper-reader?style=social)](https://github.com/GGboya/dsh-paper-reader/stargazers)

**English**: [README_EN.md](README_EN.md)

[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 插件：**论文伴读工作台** —— 文献库 + PDF 阅读器 + AI 伴读，回答自带页码、点页码跳回原文。当前版本 **v1.5.0**。

> 💬 **QQ 交流群：1127244508** —— 安装/使用问题、功能建议、bug 反馈都欢迎来聊。

![演示：选中即问 → 回答带页码 → 点页码跳回 PDF 并高亮原文](docs/demo.gif)

![默认安装：官方侧栏原样，只多一行开关](https://raw.githubusercontent.com/GGboya/dsh-paper-reader/main/docs/screenshot-default.png)

![伴读模式：文献库 + PDF 阅读器 + 原生对话](https://raw.githubusercontent.com/GGboya/dsh-paper-reader/main/docs/screenshot-reading.png)

## 核心能力

- 📚 **三栏工作台**：专题 → 论文文献库、居中 PDF 阅读器（缩放 / 适宽 / 滚动 ↔ 单页翻页 / 键盘翻页）、右侧原生对话
- 💬 **带页码的伴读**：回答必带页码，点页码平滑跳回 PDF 对应位置并高亮；选中文字即问；🕐 回看历史对话、＋ 新开对话
- 🤖 **教练式带读**：paper 会话自动用专用 preset——定分步阅读计划、逐节指导、出题批改，学习进度跨会话累积
- 🀄 **中文版**：原文 ↔ 纯中文原地切换（babeldoc 零预装，自动安装），译文 PDF 一键导出（纯中文 / 中英对照）
- 🗂️ **文献管理**：专题/论文改名、删除（删除前列文件清单、进回收站**可恢复**、非空专题批量清空一次确认）
- 🈯 **划词翻译（公式保留）**（v1.5.0）：阅读器里选中正文 → 提问气泡上多一个 **「译」** 按钮 → 弹出**只显示译文**的气泡（**没有**「插入会话」「复制」按钮，也从不自动写剪贴板）。**选区含公式时**，用 MinerU 识别出的 LaTeX 替换 PDF 文本层里的乱码公式，并要求模型**原样保留**公式（`$…$` 里的内容不翻译、不改写）。**前提与代价**：① 需先配置翻译端点（与生成中文版用的是同一份配置；未配置时点「译」会直接弹设置表单，保存后自动重试）；② **公式保留要求该论文用 MinerU 转录过**——没有产物时**降级为普通翻译**，公式在文本层里本就不读，气泡会**如实提示「译文可能不准」**（这是设计，不是缺陷）
- 🖥️ **中英分屏对照（两种模式，可切换）**（v1.5.0）：顶栏新增 **「对照」** 与 **「分屏」** 两个按钮，随时切换、再点一次回原文，选择按文献记忆。**模式 A「对照」** 直接看 babeldoc 的 `-dual.pdf`（原文与译文并排画在同一张加宽页面上，自动适宽）；**模式 B「分屏」** 左原文、右中文版，两列**同步滚动**（同页号 + 页内比例）。**前提与代价**：模式 A 需要 `-dual.pdf`、模式 B 需要 `-zh.pdf`，两者都要先用 babeldoc 生成（顶栏「中」一键触发，**首次约几分钟**，且需要翻译端点）；**没有对应产物时按钮置灰并说明**；分屏需要面板宽度 ≥640px，太窄会提示而不切换
- ➕ **两个可选增强**（默认关，见「进阶」）：MinerU 解析——扫描件可读、公式可点引用可检索；语义检索端点——大白话命中术语段落

安装后**不改动官方界面**：侧栏底部多一行「📚 论文伴读」开关，点击才进入伴读模式，再点即还原。

## 安装

### 普通用户：桌面端装好即用（推荐）

**两步**：装 DeepSeek 官方桌面端 → 里面直接装插件。

1. 下载安装 [DeepSeek 官方桌面端](https://www.deepseek.com/download/)（即 DeepSeek Harness 桌面版），登录 DeepSeek 账号
2. 侧栏 → **插件** → **添加插件**，输入 `@ggboy123/dsh-paper-reader@latest`，装完点进插件详情打开「启用」开关，**重启桌面端**

完成。侧栏底部点「📚 论文伴读」进入文献库，上传 PDF 开始用。

完整流程演示（添加插件 → 启用 → 重启 → 打开论文直接提问）：

![官方桌面端安装并使用论文伴读插件](https://raw.githubusercontent.com/GGboya/dsh-paper-reader/main/docs/desktop-official-use.gif)

> 已在官方桌面端 V0.2.0-rc.2（内置 dsh 0.2.0-rc.2，macOS arm64）实测通过。
> 需要 ≥1.2.0：更早版本会被 0.2.x 运行时的 peer 兼容校验拒载（插件列表里显示异常）。

> 想直接在客户端里逛插件市场（4000+ 插件、分类、评论、一键安装），可另装社区插件 [`dshmarket`](https://github.com/dsh-market/dsh-market)，本插件已在其目录中。

**排坑（都是实测踩过的）**：

- **升级后插件开关会回到停用**：侧栏 → 插件 → 打开「启用」→ 重启。症状有迷惑性——文献树还在但点论文没反应，其实是没启用
- **添加时务必带 `@latest`**：不带版本号对已装过的插件是 no-op（dsh 的插件管理器按首次记录的版本处理，不会追新）
- pnpm 若开了供应链策略 `minimumReleaseAge`（发布 N 小时内的新包拒装，桌面端默认开）：等过窗口期，或在 `~/.dsh/profiles/web/.npmrc` 加 `minimum-release-age-exclude[]=@ggboy123/dsh-paper-reader`；桌面端的豁免清单在 `~/.dsh/profiles/desktop/pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`
- 旧版 PaperReader 桌面版（社区 DSH Desktop 预装打包）**已停止维护**，请迁移到本方式

### 开发者：命令行 dsh

```bash
dsh plugin --profile web add @ggboy123/dsh-paper-reader@latest
```

> npm 包名走 `@ggboy123` 作用域：裸名 `dsh-paper-reader` 已被另一个插件占用。
> 不要用 `github:GGboya/dsh-paper-reader` 安装 —— dist 不入库，git 安装会导致 profile 起不来。

**升级**也用 `@latest`（或显式版本号）——不带任何版本的 `add` 对已装依赖是 no-op：

```bash
dsh plugin --profile web add @ggboy123/dsh-paper-reader@latest   # 永远装最新
# dsh plugin --profile web add @ggboy123/dsh-paper-reader@1.5.0  # 或钉住具体版本
grep '"version"' ~/.dsh/profiles/web/node_modules/@ggboy123/dsh-paper-reader/package.json   # 查当前版本
# 重启 dsh web 生效；浏览器 Cmd+Shift+R 强刷，避免旧阅读器页面缓存
```

## 怎么用

1. **进入**：侧栏底部点「📚 论文伴读」——左侧变为文献库树（再点还原官方工作区列表）
2. **入库**：＋ 新建专题 → ⬆ 上传 PDF（空库直接点「上传 PDF」会自动建「默认专题」）
3. **读 + 问**：点论文打开——中间阅读器、右侧对话。直接在输入框提问（无需点名论文，回答自带页码），或**选中论文里的文字**直接弹框提问；点回答里的「第 N 页」跳回原文
4. **中文版**：顶栏「中」——没译文时一键生成（首次自动装翻译引擎，需在弹出的表单里配一次 OpenAI 兼容端点，DeepSeek/GLM/Kimi 的 key 都行）；⤓ 下载当前版本 PDF；▣ 单页翻页 ↔ 滚动
5. **管理**：行悬停出 ✎ 改名 / 🗑 删除。删除会先列出将处理的文件清单，确认后**移入回收站**（`data/.trash/`，可手工恢复）；非空专题删除 = 批量清空清单一次确认
6. **对话**：对话头部 🕐 看该论文的历史对话、＋ 新开一个

## 进阶（可选，默认关闭）

### MinerU 解析：扫描件可读、公式可点引用

默认用本地 pdf.js 提取文本——**普通文本型 PDF 完全够用，什么都不用配**。两类场景需要 MinerU：

- **扫描版 PDF**（老论文、书章、扫描讲义）：没有文本层，pdf.js 读不了，MinerU（OCR）能读
- **公式引用**：PDF 里公式是图形乱码，选不中也搜不到。MinerU 把公式识别成 LaTeX 后，**点 PDF 上的公式会把该公式的 LaTeX 带进提问气泡**（发送即随问题引用进对话）；`QK^T` 这类公式检索也能命中；顶栏「∑ 公式」面板按页浏览全文公式

**需要自己准备（二选一）**，在 **设置 → 论文伴读 → 「MinerU 解析后端」** 里配置：

| 方式 | 准备 | 适合 |
| --- | --- | --- |
| 云端（最简单） | 到 [mineru.net](https://mineru.net) 注册 → 站内「API 管理」创建 token → 设置里模式选「云端」、粘 token、「测试连接」→ 保存。约 1 分钟，免费额度 | 大多数人 |
| 本地自建（免注册） | `pip install -U "mineru[core]"` → `mineru-api --host 127.0.0.1 --port 8000` → 设置里模式选「本地」 | 重度/隐私敏感；免费无限、论文不出本机 |

配置好后：新上传的扫描件自动走 MinerU；已入库的论文在「∑ 公式」面板里点「用 MinerU 重新转录」即可（**旧缓存不会自动重录**，想要公式可搜需对那篇显式重录一次）。

> 说明：云端 `pipeline` 通道已用真实 token 端到端实测（19 页论文，18/18 公式与本地一致）；`vlm` 系列模型未验证。token 落盘 0600，界面只回掩码。常见报错排查见 [docs/reader-ux-requirements.md](docs/reader-ux-requirements.md)。

### 嵌入语义检索

给 `search_paper` 接一个 OpenAI 兼容 `/embeddings` 端点（设置 → 论文伴读 →「嵌入模型检索（可选）」卡片，填 URL/模型/Key，保存前会真打一发预检）：关键词一个没命中的**语义相近**片段也能进候选——大白话提问（「训练时怎么调学习率」）命中术语段落，与关键词结果融合、不替代。不配（或只配一半）= 默认关闭，一条请求都不发，检索行为与原来完全一致。

> ⚠️ **隐私提示**：启用后，两类文本都会发送到你配置的那个端点——① 论文的分块文本（正文片段，算分块向量）；② 检索时的查询文本（每次检索的提问，算查询向量）。端点必须是你要信任的服务；不配则一条请求都不发。

配置三选一（优先级同翻译端点）：设置面板（推荐）> profile YAML `config.embed` > 环境变量 `DSH_EMBED_API_KEY`（只补 key）。向量缓存在 `<专题>/<论文名>.embeddings.json`（只存向量：不含明文 key、不含查询文本），按端点/模型/内容哈希失效——换端点、换模型、重新转录后自动重算；分块按 `batchSize`（默认 32）提交，任一批失败整体降级、不落盘。端点本次不可达时照常返回关键词结果并标注降级原因，不静默失败。

> **非目标**（留后续）：本地 ONNX / transformers.js 嵌入模型、全库预计算、向量数据库——本轮只做 API 端点。

## 文献管理细则

- 删除 = **移入回收站** `data/.trash/<时间戳>/`（带 manifest 清单），把文件移回专题目录即恢复；本版不自动清理、无一键恢复 UI
- 会被移入回收站的文件 = 该文献的全部同名产物：`<文献>.pdf`、`.txt`、`.pages.json`、`.transcript.json`、`.mineru.md`、`.mineru.json`、`.embeddings.json`、`.study.json`，以及译文变体 `<文献>-en.pdf` / `-zh.pdf` / `-dual.pdf`（含中断残留的 `.tmp-*`）；伴读会话历史**不删**（存在 dsh 会话库里）
- **前置拒绝**：该文献有运行中的会话、正在生成译文、或同篇已有删除/改名在进行中时，操作会被拦（防止删掉正在用的东西）
- **安全边界**：删除/改名只作用于文献库目录内；路径穿越（`..`、绝对路径、符号链接逃逸）一律拒绝；中途失败自动回滚已移动的文件
- 改名后：转录缓存/译文/学习档案全部跟随搬家；历史伴读会话**本体保留**但不再挂在新名字下（会话 id 编码旧名）；纯大小写改名在 macOS/Windows 可用
- 手工放进 `data/` 的怪名字文件（如 `.hidden.pdf`）也能正常删除/改名，不会成为孤儿

## 划词翻译与中英分屏对照（v1.5.0）

### 划词翻译（公式保留）

**怎么用**：在阅读器里**选中一段正文** → 弹出「选中即问」气泡（行为与以前完全一致）→ 点气泡里的 **「译」** → 弹出**译文气泡**，里面**只有译文**（外加一行诚实提示）。想重翻就重新选一次；点气泡外或按 Esc 关掉。

译文气泡里**没有**「插入会话」「复制」按钮（按你的要求），也**从不**自动写剪贴板。提问链路一点没动：重新选一次字就回到原来的提问气泡。

**公式是怎么处理的**（这是本功能的核心）：

- PDF 文本层里的公式**不可读**：`$F_{\theta}$` 常常只剩一个 `F`（下标整字丢失）、`\sum` 变成 `X`、分式被拉平成一行、括号对甚至变成控制字符。把这串东西直接发给模型，译文里的公式必然错。
- 所以：**选区里的公式先用 MinerU 的 LaTeX 把那一段乱码替换掉**，再明确要求模型**原样保留** `$…$` 里的内容（不翻译、不改写、不省略、不增删符号）。译文回来后还会**逐个公式核对**是否原样保留，缺了就在气泡里如实告诉你。
- 两类公式都覆盖：**独立成行的公式**（用 MinerU `equation` 块的 bbox 精确定位）与**正文里穿插的行内公式**（如 `π(a|s)`、`Q(s,a)`、`x_t`）。行内公式在 MinerU 产物里**没有自己的 bbox**（它嵌在正文块里），插件靠「选区文本 ↔ MinerU 块文本」的模糊对齐把它还原出来。

**前提与代价（务必先读）**：

| # | 前提 | 没有它会怎样 |
| --- | --- | --- |
| 1 | **需要先配置翻译端点**（设置 → 论文伴读，或阅读器右上角 ⚙；与生成中文版共用同一份配置） | 点「译」会**自动弹出端点设置表单**；填好保存后**自动重试这次翻译**（不会白点一次）。端点三项不齐时服务端直接拒绝，前端据此弹表单 |
| 2 | **公式保留需要该论文用 MinerU 转录过**（存在 `<文献>.mineru.json`） | **降级为普通翻译**：正文照常翻，但公式在文本层里本就不读，气泡会如实提示「该论文未用 MinerU 转录：原文里的公式在文本层不可读，译文可能不准」。**这是设计，不是缺陷** |
| 3 | 有 MinerU 产物、但某一段公式没对上 | 只还原能对上的部分，气泡提示「部分公式未能还原，译文可能不准」 |
| 4 | 选区太短（不足 4 个有效字符，例如只选中孤零零的 `F`） | 不做还原（不足以判别），气泡提示「选区太短，公式未还原」 |

**已知限制（如实声明，不粉饰）**：

- **未对真实 LLM 端点打过任何请求**：开发期验证全程使用假上游（避免花钱、避免用你的 key）。「模型是否真的原样保留公式」目前靠**提示词字节契约**＋**回包逐公式核对**两道可判定断言保证，没有真实服务商 key 的端到端实测。
- MinerU 偶尔会把**一个公式拆成两个 `$…$`**（首个片段以 `=` 结尾）。这种形态下可能只还原出半截公式（如 `action $\hat{a}_t\sim\pi_\theta(\cdot\ |$`），`$` 配对计数拦不住；本机语料里未出现，留待后续。
- 选区里含**字面** `$`（正文里真印了一个美元符号）时，极端形态下可能产生一句「有 N 个公式未原样保留」的**误报提示**（已记录，不影响译文本身）。
- 中文版 / 对照视图下**不做**公式替换（bbox 只对原文页成立），所以「译」按钮只在原文视图出现。

### 中英分屏对照（两种模式）

顶栏新增两个按钮，随时切换、**再点一次回原文**；每篇文献上次用的视图会被记住（跟着文献走，改名也不丢）：

| 按钮 | 模式 | 看的是哪个文件 | 前提 |
| --- | --- | --- | --- |
| **对照** | A：单页内对照 | babeldoc 的 `-dual.pdf`（原文与译文并排画在同一张加宽页上，页宽约 2 倍） | 需要 `-dual.pdf` |
| **分屏** | B：左右并排 | 左：原文 `<文献>.pdf`；右：`<文献>-zh.pdf` | 需要 `-zh.pdf` |

- **两个产物都要先用 babeldoc 生成**：顶栏点「中」一键触发（**首次要装引擎 + 翻译，约几分钟**，需要翻译端点）。没有对应产物时按钮**置灰并写明原因**，不会点了没反应。
- **同步滚动**：滚任意一列，另一列自动跟到「同一页号 + 同一页内比例」；谁在滚谁主导，不会两列互相拉锯。翻页模式（`▣`）下两列同步同页。**中文版与原文页数不一致时按比例映射**，并在状态栏给出一次性提示。
- **分屏宽度**：需要面板宽度 ≥640px；太窄时点「分屏」只提示「请把阅读器拉宽」，**不会**切进去；分屏期间把面板缩到 640px 以下会自动退回原文。
- **与既有能力的关系**：分屏时左列就是普通原文视图——**公式热区照常可点**（右列不参与命中，也不会被画上热区）；公式面板照常可用；「中」按钮在分屏期间置灰（避免与分屏语义打架）。切到中文 / 对照视图时热区仍按既有规则关闭（bbox 只对原文页成立）。

## 参与开发

```bash
git clone https://github.com/GGboya/dsh-paper-reader
cd dsh-paper-reader && pnpm install && pnpm run build
dsh plugin --profile web add ./dsh-paper-reader   # 从父目录执行，或用绝对路径
dsh --profile web                                  # 侧栏变为文献库树
```

![参与开发：clone → pnpm install → build → 本地安装](https://raw.githubusercontent.com/GGboya/dsh-paper-reader/main/docs/dev-workflow.gif)

- 改完 `pnpm run build` 重启 profile 即生效；`npm test` 跑全量测试（354 用例，CI 在 ubuntu/macos/windows 三平台跑）
- 文献库目录默认 `~/.dsh-paper-reader/data`，在 profile 的 `cordis.patch.yml` 里可改（可直指 pdfqa 的 `data/` 复用旧缓存）；翻译/MinerU/嵌入端点优先在设置 UI 里填（存 `$DSH_HOME/.dsh-paper-reader/` 下，0600），YAML 里的 `config.translate` / `config.mineru` / `config.embed` 退为部署方默认值
- 翻译引擎冒烟（Windows 依赖完整性，无需本地 Windows）：`pnpm smoke:engine clean|managed-uv|pip-fallback|repair|translate`，CI 全新干净机器每周一定时跑

## 架构

```
src/
  index.ts      Cordis 壳：inject tools；webServer 等服务就绪后挂路由
  tools.ts      5 个 agent 工具：list_papers / transcribe_pdf / search_paper / study_progress / study_update
  host.ts       webServer 路由（/paper-reader/*），connection.requestRejection 鉴权；
                sessionController.create/prompt（agentPreset=paper-reader）+ follow SSE 桥
  library.ts    纯函数：文献库目录约定与解析（.txt/.pages.json/.transcript.json/.mineru.* 产物路径）
  library-manage.ts 纯函数：删除/重命名（回收站、精确 stem、路径穿越防护、批量清空）
  transcribe.ts 纯函数：pdf.js 提取 + 页码偏移表 + MinerU 后端选择与缓存来源语义
  mineru.ts     纯函数：MinerU 客户端（本地 /tasks 轮询；mineru.net v4 云端 + 最小 ZIP 读取器）
  mineru-config.ts / embed-config.ts / translate-config.ts / typesafe-config.ts 纯函数：各端点配置读写（0600）+ 预检
  search.ts     纯函数：分段 + 关键词打分 + 公式查询归一化 + 嵌入混合召回
  embed.ts      纯函数：/embeddings 客户端 + 分块向量缓存
  formulas.ts   纯函数：MinerU 公式索引（LaTeX + bbox → 阅读器热区/面板）
  study.ts      纯函数：学习档案（计划 + 检验成绩）读写
  translate.ts  纯函数：babeldoc 调用（中文/中英对照 PDF 生成）
  babeldoc-install.ts 纯函数：无 Python 环境时自动安装 babeldoc（uv → 托管 Python → venv）
  translate-selection.ts 纯函数：划词翻译（公式保留 —— 行内公式与 MinerU 块文本对齐还原、请求体与提示词契约、逐公式保全校验、内存 LRU 缓存）
  rerank.ts     纯函数：search_paper 语义重排（TypeSafe/Jev，无凭据时退回关键词排序）
  preset.ts     纯函数：自带 agent preset 安装到 $DSH_HOME/.agent-presets/
presets/paper-reader/  「论文伴读」agent preset（persona 完整提示词 + compaction）
reader/index.html      阅读器页面（pdf.js，独立于 React 宿主，iframe 承载）
lib/client.js          浏览器半边：文献库树(sidebar.workspaces 接管) + PDF 页签 + 主面板
```

## 贡献者

感谢每一位贡献者：

<a href="https://github.com/GGboya/dsh-paper-reader/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=GGboya/dsh-paper-reader" alt="贡献者头像墙" />
</a>

## Star 趋势

[![Star 趋势图](https://api.star-history.com/svg?repos=GGboya/dsh-paper-reader&type=Date)](https://star-history.com/#GGboya/dsh-paper-reader&Date)

## License

MIT
