# dsh-paper-reader

[![npm version](https://img.shields.io/npm/v/@ggboy123/dsh-paper-reader)](https://www.npmjs.com/package/@ggboy123/dsh-paper-reader)
[![npm downloads](https://img.shields.io/npm/dm/@ggboy123/dsh-paper-reader)](https://www.npmjs.com/package/@ggboy123/dsh-paper-reader)
[![license](https://img.shields.io/github/license/GGboya/dsh-paper-reader)](https://github.com/GGboya/dsh-paper-reader/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/GGboya/dsh-paper-reader?style=social)](https://github.com/GGboya/dsh-paper-reader/stargazers)

**English**: [README_EN.md](README_EN.md)

[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 插件：论文伴读工作台 —— PDF 转录 / 检索 + 原生对话伴读 + 内置阅读器。

> **👉 普通用户不用看这一页。** 如果你只是想装一个能用的 App，请直接去 [**PaperReader 论文伴读桌面版**](https://github.com/GGboya/PaperReader) —— 那是把本插件预装好的桌面应用，下载 DMG 拖进「应用程序」就能用，不需要任何环境。本仓库面向的是想自己装插件、或想改代码的用户。

功能迁移自本地独立产品 pdfqa（Go 实现的论文伴读工具）。原则：agent 循环 / 模型层 / 会话持久化全部交给 dsh 框架，插件只做「转录 + 检索 + 阅读器 UI」的薄壳组合。

**安装后不改动官方界面** —— 侧栏底部多一行「📚 论文伴读」开关，点击才进入伴读模式（左侧变为文献库树），再点即还原官方工作区列表：

![演示：选中即问 → 回答带页码 → 点页码跳回 PDF 并高亮原文](docs/demo.gif)

![默认安装：官方侧栏原样，只多一行开关](https://raw.githubusercontent.com/GGboya/dsh-paper-reader/main/docs/screenshot-default.png)

![伴读模式：文献库 + PDF 阅读器 + 原生对话](https://raw.githubusercontent.com/GGboya/dsh-paper-reader/main/docs/screenshot-reading.png)

## 功能

- 📚 **侧栏文献库树**：「论文伴读」模式开启时接管工作区侧栏，专题 → 论文两级；支持新建专题、上传 PDF（默认关闭，不覆盖官方界面）
- 💬 **原生对话伴读**：点击论文即在右侧打开它的 dsh 原生会话（流式 / 工具卡 / 用量条全是官方 UI）；默认只呈现当前对话，对话列头部的 🕐 下拉回看**历史对话**（真实标题+日期，点哪条进哪条），＋ 新建对话
- 🔗 **会话绑定论文**：会话 id 编码文献身份，工具调用自动定位当前论文——直接在输入框提问无需点名论文，回答必带页码
- 🤖 **专用 agent preset「论文伴读」**：paper 会话自动使用专用 preset —— 像老师一样带读：制定分步阅读计划（每步带页码和思考题）→ 逐节指导、点评 → 出题检验、逐题批改 → 成绩与薄弱点记入 `<文献>.study.json` 学习档案，跨会话累积；快速问答（选中即问）则直接回答，不上课
- 📖 **PDF 阅读器居中**：中间是论文（PDF.js 缩放 / Retina 高清 / 文本层选择 / 适宽模式），最右是该论文的原生对话 —— 视觉换位实现，列宽拖拽/折叠仍是 dsh 原生行为，关掉 PDF 页签即还原官方布局
- 💬 **选中即问**：阅读器里选中文字 → 弹出提问框 → 注入当前会话，原生对话区实时回答
- 📍 **引用定位**：回答里的「第 N 页」可点击，平滑跳回 PDF 对应页并闪烁
- 🀄 **中英切换**：顶栏「中」按钮原文 ↔ 纯中文切换；无译文时一键后台生成（babeldoc），生成需配置 `translate` 端点；**无需预装 Python**——首次生成时自动下载 uv + 托管 Python + babeldoc（macOS / Linux / Windows，约几分钟），全程落在用户目录
- 🔍 **PDF 转录 + 检索**：本地提取（pdf.js，纯 Node 无需 Python），页眉页脚剔除 / 连字 / 断词愈合 / 段落重排，产出页码偏移表；可选接入 TypeSafe/Jev 语义重排（设置面板填端点即启用，不配置时退回纯关键词排序）；兼容 pdfqa 的 `data/` 缓存布局（旧缓存读取时自动补建页码索引）
- 🧲 **可选 MinerU 解析后端**：扫描件 / 复杂版式 / 表格公式场景可切到 MinerU（本地 API 或 mineru.net v4 云端），产出仍是同一套带页码索引的缓存；默认关闭，不配置时行为与旧版本完全一致（详见下文「MinerU 解析后端」）
- 🧮 **公式鼠标引用**（v1.5.0）：PDF 文本层里的公式是乱码（`𝑧𝑧1 𝑥𝑥𝑡𝑡` 这类重复字形），选中它毫无意义；现在直接用鼠标**点 PDF 上的公式**，引用的是 MinerU 识别出的 **LaTeX**（如 `$$\pi(\mathbf{s}_t)$$`），经「选中即问」链路进入会话。**前提：该论文必须先用 MinerU 转录过**（见下文「公式引用与文献管理」）
- 🗂️ **文献管理：删除与重命名**（v1.5.0）：侧栏文献库树的专题行/文献行新增 `⋯` 菜单——重命名专题/文献、删除文献/专题。删除是**破坏性操作**：产物会移入文献库内的回收站 `data/.trash/`（可恢复），有二次确认与服务端前置校验（详见下文，务必先读「删除的后果」）

## 公式引用与文献管理（v1.5.0）

### 公式鼠标引用

阅读器顶栏新增 **「∑ 公式」** 按钮，两条入口：

1. **点击 PDF 上的公式** → 弹出提问框，正文自动填入该公式的 LaTeX（气泡里显示「第 N 页 · 公式 k」+ LaTeX 预览），提问框里写你的问题、回车即发送；气泡里另有「复制 LaTeX」按钮（**不会**自动写剪贴板，避免静默覆盖你的剪贴板）。
2. **「∑ 公式」面板**：按页列出该论文的全部公式与 LaTeX，点条目也能引用（热区点不中时的兜底，也方便抄 LaTeX）。

- **前提：这篇论文必须先用 MinerU 转录过**（设置 → 论文伴读 → MinerU 解析后端，或上传后在阅读器里点面板中的「用 MinerU 重新转录」）。公式块（`equation` 的 `bbox` + LaTeX）只存在于 MinerU 产物 `<文献>.mineru.json` 里，pdf.js 文本层给不出可用公式。
- **没有产物时不会报错**：入口置灰并在面板里说明原因，提供「用 MinerU 重新转录」按钮；「选中即问」等原有能力完全不受影响。
- 产物损坏 / 没有公式块时同样只是「没有公式可用」，不会影响阅读与提问。
- **译文视图（中/对照）下不显示公式热区**：bbox 只对原文页面成立，切回原文即可点击。
- 公式引用与划词提问**互不抢**：有选中文字时优先按文字提问；公式热区不拦截鼠标事件（不破坏拖拽划选）。

### 文献管理：删除与重命名

侧栏文献库树里，**专题行**和**文献行**右侧都有 `⋯` 菜单：

| 操作 | 行为 |
| --- | --- |
| 重命名专题 / 重命名文献 | 改名（文献的全部同名产物与译文变体一起改）。**注意**：伴读会话 id 内嵌「专题/文献」名，改名后旧会话不会删除，但不再显示在该文献下面（确认框会写明） |
| 删除文献 | 二次确认框逐条列出将删除的文件与大小 → 确认后**移入回收站** |
| 删除专题 | **只允许空专题**（专题内还有文献时会被拒绝并提示先逐篇删除）；需按提示输入专题名确认 |

**删除的后果（重要）**：

- 会被处理的文件 = 该文献在 `data/` 下的**同名产物**：`<文献>.pdf`、`.txt`、`.pages.json`、`.transcript.json`、`.mineru.md`、`.mineru.json`、`.embeddings.json`，以及译文变体 `<文献>-zh.pdf` / `-dual.pdf` / `-en.pdf` 与中断残留的 `.tmp-*`。
- **可以恢复**：文件被 `rename` 到 `data/.trash/<时间戳>-<随机>/`（同文件系统，不是 unlink），里面有 `manifest.json` 记录清单。把需要的文件从回收站移回专题目录即恢复（本版**不**做自动清理，也不提供一键恢复 UI）。
- **不会被删除**：伴读会话历史（保存在 dsh 会话库里）、共享翻译环境 `data/.venv-pdf2zh/`、翻译草稿 `data/.pdf2zh-tmp/`、其他文献与其他专题、专题目录本身。
- **安全边界**：所有删除/重命名只作用于**文献库目录内**（`DSH_PAPER_READER_DATA` 指定的 `data/`，默认 `~/.dsh-paper-reader/data`）。路径穿越（`..`、绝对路径、符号链接逃逸）一律拒绝；写路径**只接受**「专题名 + 文献名」，不接受任意路径参数；符号链接专题直接拒绝，符号链接文件只移动链接本身、不动其指向的目标。
- **前置校验**：文献有**运行中的伴读会话**或**正在生成译文**时，删除/重命名会被拒绝（避免删掉运行中会话的工作目录、或翻译完成后把文件写回来）。
- 另两种会被拒绝的情况（都是刻意的保守设计）：**会话状态一时查不到**时一律拒绝（提示稍后重试，而不是「当作没有会话」冒险动手）；**同一篇文献已有一个删除/重命名在进行中**时，第二个请求会被拒绝（避免两个操作交错改同一批文件）。

## MinerU 解析后端（可选）

默认用本地 pdf.js 抽文本层（纯 Node，无需 Python，文本型 PDF 毫秒级）。可选接入 **MinerU** 作为解析后端，
用于扫描件 / 复杂版式 / 表格公式场景 —— 产出仍然是同一套带页码索引的缓存（`.txt` + `.pages.json`），
检索、跳页、旧缓存行为都不变。

两种模式，在 **设置 → 论文伴读 → 「MinerU 解析后端」卡片** 里选（也可写配置文件）：

| 模式 | 说明 |
| --- | --- |
| `off`（默认） | 不启用，行为与旧版本完全一致 |
| `local` | 本机 MinerU API（默认 `http://127.0.0.1:8000`），启动方式见下 |
| `cloud` | mineru.net v4 云端，需要一个 token |

**本地 MinerU**（官方 API 服务，本仓库用 3.4.5 实测）：

```bash
pip install -U "mineru[core]"
mineru-api --host 127.0.0.1 --port 8000        # 或 uvicorn mineru.cli.fast_api:app
curl -s http://127.0.0.1:8000/health           # {"status":"healthy","version":"3.4.5",...}
```

默认 backend 取 `pipeline`（通用、不依赖 VLM 模型）；有 GPU 且想更准可切 `hybrid-engine`
（需要 VLM 模型已就绪，实测 2 页合成 PDF 约 5 秒）。扫描件建议把「本地解析方式」设为 `auto`，由 MinerU 自行决定 OCR。

**云端 MinerU**：到 [mineru.net](https://mineru.net) 注册 → API 管理里创建 token → 填进卡片的「云端 token」。
一次解析的序列是：申请批量上传地址 → PUT 上传 → 轮询结果 → 下载并解析 zip。
⚠️ **云端路径在本仓库未做真机实测**（开发机没有 token），只有 mock HTTP 的单测覆盖，请当作实验特性。
token 只落盘到 `~/.dsh/.dsh-paper-reader/mineru.json`（0600）；读取接口只回掩码，日志 / 错误 / 响应都不出现明文。

**配置文件 / 环境变量**（优先级逐字段：文件 > profile YAML `config.mineru` > 环境变量 > 默认值）：

```yaml
- id: dsh-paper-reader
  config:
    mineru:
      mode: local
      local:
        baseUrl: http://127.0.0.1:8000
        backend: pipeline
        parseMethod: auto
      # cloud:
      #   apiKey: ''          # 一般不用写在这里，UI 里填即可
```

| 环境变量 | 覆盖字段 |
| --- | --- |
| `DSH_MINERU_LOCAL_URL` | `local.baseUrl` |
| `MINERU_API_KEY` | `cloud.apiKey` |

**缓存与来源**：MinerU 解析仍然写 `.txt` + `.pages.json`（`page` 从 1 起，检索映射页码用），
另加 `.transcript.json`（来源标记：`pdfjs` / `mineru-local` / `mineru-cloud`）与 MinerU 富产物
`.mineru.md` / `.mineru.json`（Markdown + content_list，供人工核对）。旧缓存没有来源标记时归类为 pdfjs，
**升级后不会触发重新解析**；要换来源就对目标论文显式指定（agent 侧 `transcribe_pdf` 的 `source` 参数，
HTTP 侧 `POST /api/transcribe` 的 `source`，取值 `auto|pdfjs|mineru-local|mineru-cloud`）。
MinerU 解析失败时**不动**已有缓存，错误信息带 HTTP 状态与脱敏后的服务端 message。

**公式可检索（v1.3.4 起）**：MinerU 产出的 LaTeX 在**每个 token 之间**都带空格（`x _ { t - 1 }`），
此前 `search_paper` 只有逐字照抄带空格写法才命中。投影成 `.txt` 时会先把数学区间（`$...$` / `$$...$$`）
内的空白压掉、再把**单 token** 下标/上标的花括号归一化（`Q_{t}` → `Q_t`、`^{2}` → `^2`），
因此 `x_{t-1}`、`\mathbb{R}`、`Q_t`、`q(x_t|x_{t-1})` 这类**正常写法**的公式查询可直接命中
（真实论文实测：改造前 0 命中 → 改造后命中原页）。`\text{...}` 等空格有语义的命令整组原样保留；
多 token 参数（`x_{t-1}`、`x_{ij}`、`^{K \times K}`）保留花括号；`.mineru.md` / `.mineru.json`
仍是 MinerU 原样产出，不受影响。

> **升级须知**：盘上已有的 `.txt` 缓存**不会被自动改写**（仍是旧格式，公式查询依旧搜不到）。
> 要让某篇论文的公式可搜，需对该论文**显式重新转录**：agent 侧 `transcribe_pdf` 传
> `source: mineru-local`（或 `force: true`），HTTP 侧 `POST /api/transcribe` 传同样的 `source`。
>
> **写法约定**：`.txt` 里存的是**紧凑写法**（`Q_t`）。查询侧会用**与投影侧同一套规则**先归一化再用原查询
> 一并匹配，所以 `Q_t` 与 `Q_{t}` **两种写法都能命中同一页**（原查询永远保留，不会丢任何既有命中）；
> 多 token 的 `x_{t-1}`、`x_{ij}` 不被归一化，按原样书写即可。
>
> **两处 low 级待修项（已排入下一轮，见 [docs/embed-plan.md](docs/embed-plan.md) 的「追加项二」）**：
> F-R1 `keepsInnerSpaces` 用前缀匹配把双参数 `\textcolor` 误纳入「空格有语义」保护
> （`$\textcolor{red}{hello world}$` 的第二组空格被压缩）；F-R2 区间界定扫 `$` 时不感知 `\text{}` 组
> （`$\text{costs $5}$` 会被内层 `$` 切断，属已声明边界的子形态）。

**API**（设置面板用的读写口，走 `/paper-reader` 前缀与既有鉴权）：`GET|POST|DELETE /api/mineru/config`
（GET 只回掩码；POST 预检通过才落盘；DELETE 回落 profile/环境变量）、`POST /api/mineru/test`
与 `GET /api/mineru/health`（连通性预检，不落盘）。

**常见错误**：

| 现象 | 原因 / 处理 |
| --- | --- |
| 保存时报「本地 MinerU 连接测试失败：HTTP 404 …」 | 地址指向了别的服务，或 MinerU 版本过老（2.x 没有 `/health`）；`curl {baseUrl}/health` 自查 |
| 保存时报「不是已识别的 MinerU API 服务」 | `/health` 返回里缺 `status`/`version`，不是 MinerU |
| 解析报「本地 MinerU 解析失败（HTTP 409）」 | 服务端任务执行失败，看响应里的 error 字段。MinerU 3.4.5 的 409 是**解析失败**，不是「服务忙」 |
| 解析报「MinerU 未返回可用内容（md_content 与投影文本均为空）」或「MinerU 转录结果过短(N 字符)，疑似失败，请重试」 | 服务端没产出 md/content_list（模型未就绪等）；先用 `curl -F files=@x.pdf http://127.0.0.1:8000/file_parse` 验证服务本身 |
| 解析超时 | 长论文默认总上限 30 分钟（`jobTimeoutMs`），仍不够时在配置文件里调大 |
| 云端报「HTTP 401：云端 token 无效或已过期」 | token 过期，或把 `Bearer` 前缀也填进了输入框（只填 token 本体） |

> **已知限制**：云端（mineru.net v4）链路按官方 API 实现，但**只有 mock 覆盖、未用真实 token 跑过**，视为实验特性；
> 本地链路在 MinerU 3.4.5 上端到端实测通过。其余为若干 low 级记录项（云端多文件写盘非事务、云端轮询间隔不随时间递增、
> zip 解析里的残留死代码等），均不影响默认路径：`mode` 默认 `off`，不配置 MinerU 时行为与接入前完全一致。


## 嵌入模型检索（可选，默认关闭）

除了关键词子串匹配，还可以给 `search_paper` 接一个 **OpenAI 兼容 `/embeddings` 端点**做语义召回：
关键词一个词都没命中的**语义相近**片段也能进候选（融合，不替代关键词）。跨语言提问、换同义词、
问「那段讲扩散过程的公式」这类场景命中率明显更高。

**怎么配**（三选一，与翻译/重排端点同一套优先级：设置面板 > profile YAML > 环境变量）：

| 方式 | 写法 |
| --- | --- |
| 设置面板（推荐） | 设置 → 论文伴读 → **「嵌入模型检索（可选）」** 卡片，填 端点 URL / 模型 / API Key，保存前会**真打一发** `/embeddings` 预检 |
| profile YAML | `config.embed: { baseUrl, apiKey, model }` |
| 环境变量 | `DSH_EMBED_API_KEY`（只补 key；baseUrl/model 仍要另配） |

落盘位置 `$DSH_HOME/.dsh-paper-reader/embed.json`（**0600**，与 `translate.json`/`typesafe.json` 同一约定）；
读取接口只回 `hasApiKey` + 掩码 `apiKeyHint`，明文 key 不回传。

> ⚠️ **隐私提示**：启用后，**两类文本都会发送到你配置的那个端点**——① 论文的**分块文本（正文）**（算分块向量；
> mock 抓包确认发出去的就是分块文本本身）；② **检索时的查询文本**（每次检索先把查询发去算查询向量）。
> 端点必须是你要信任的服务；**不配则一条请求都不发**。缓存文件与错误信息里都不会出现 API Key
> （查询向量只留在进程内备忘，不落盘）。

**行为与降级**：不配（或只配一半）= **默认关闭**，`search_paper` 与改造前**逐字节一致**（纯关键词排序、零新请求）。
配了之后：关键词候选 ∪ 嵌入候选 → RRF 融合 → 若配了 Jev/TypeSafe 重排则继续走既有重排 → top-k。
**融合行为说明**：关键词候选与语义候选按**名次**融合（RRF，k=60）——只看名次、**不看分数大小**，所以两列候选会**交替占用**最终 top-k 名额（语义第 1 名可能排到关键词第 2 名之前）；「关键词优先」只在**精确同分**时生效。嵌入是**召回**步骤、不替代关键词（关键词检索始终在跑并贡献候选），但**语义候选确实可能占用部分 top-k 名额**——这是有意为之的形态（无真实嵌入可调参，故不引入按分数插值/名额保底这类无法验证的策略）。**未配置嵌入端点时完全不受影响**：一条请求都不发，排序与改造前逐字节一致。
端点在这次检索里不可达 / 超时 / 返回错误 / 维度或数值非法时：**照常返回关键词结果**，并在结果末尾如实标注降级原因
（`（嵌入检索不可用，已降级为纯关键词：…）`），不会静默失败、也不会中断检索。

**缓存与失效**：`<专题>/<论文名>.embeddings.json`，键 = `{baseUrl, model, dimensions, 内容哈希}`。
**换端点（baseUrl）/ 换模型 / 改 `.txt`（重新转录）/ 改分块大小 / 返回维度与缓存不一致** → 自动判定失效并重算；
**命中缓存时不再发分块嵌入请求**（查询向量另有进程内备忘，同一查询重复检索零请求）。
按 `batchSize`（默认 32）分批提交；**任一批失败就整体降级且不落盘**——不产生半截缓存。

惰性：**首次检索该论文时才计算**，转录（`transcribe_pdf`）阶段完全不碰嵌入，转录速度与失败面不受影响。

> **非目标（留后续）**：本地 ONNX / transformers.js 嵌入模型、全库预计算、向量数据库 —— 本轮只做 API 端点。

## 安装

### 方式一：PaperReader 桌面版（一键安装，推荐普通用户）

[PaperReader](https://github.com/GGboya/PaperReader) 是把本插件**预装好**的桌面应用（基于社区桌面客户端 [DSH Desktop](https://github.com/anywhere-labs/dsh-desktop) 打包）：

1. 从 [Releases](https://github.com/GGboya/PaperReader/releases/latest) 下载 DMG（macOS Universal,Intel / M 系列芯片都行；Windows 版打包中）
2. 打开 DMG，把 PaperReader 拖进「应用程序」
3. 首次打开用 右键 → 打开（免签名发布，只弹这一次）；首次启动有几分钟一次性初始化

打开就是文献库 + 阅读器 + 伴读对话，不用再执行任何命令。

### 方式二：已有桌面客户端，自己装插件

**DeepSeek 官方桌面端**（[deepseek.com/download](https://www.deepseek.com/download/) 下载，即 DeepSeek Harness 桌面版）：

1. 安装并启动，登录 DeepSeek 账号
2. 侧栏 → **插件** → **添加插件**，输入 `@ggboy123/dsh-paper-reader@1.4.0` 安装
3. 装完默认**停用**：点进插件详情，打开「启用」开关
4. **重启桌面端**（热启用状态下打开论文的链路会静默失效，重启进开机组合才正常，实测）

完整流程演示（添加插件 → 启用 → 重启 → 打开论文直接提问）：

![官方桌面端安装并使用论文伴读插件](https://raw.githubusercontent.com/GGboya/dsh-paper-reader/main/docs/desktop-official-use.gif)

> 已在官方桌面端 V0.2.0-rc.2（内置 dsh 0.2.0-rc.2，macOS arm64）实测通过：侧栏文献库、新建专题、上传 PDF、PDF 阅读器、原生对话伴读、历史/新建对话按钮全部可用。
> 需要 ≥1.2.0：更早版本会被 0.2.x 运行时的 peer 兼容校验拒载（插件列表里显示异常）。

**社区 DSH Desktop**（[anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/dsh-desktop)，社区的 DeepSeek Harness 桌面客户端，macOS / Windows，开箱即用，不需要装 Node.js）：

1. 下载安装 DSH Desktop 并启动
2. 托盘菜单 → **Open DSH Terminal**（终端里自带 `dsh`/`pnpm`，只对那个终端生效）
3. 执行 `dsh plugin add @ggboy123/dsh-paper-reader@1.4.0`
4. 退出并重开 DSH Desktop（插件变更要重启才进 Loader 组合）

> 已在 DSH Desktop 2.0.13（内置 dsh 0.1.5-rc.2）上实测通过：侧栏文献库、PDF 阅读器、选中即问、页码跳转、原生对话伴读、翻译引擎自动安装（uv + Python + babeldoc 全程落在用户目录）全部可用。
> 注意：Desktop 的 `desktop` profile 被 Electron 独占管理，外部 CLI 直接 `dsh plugin --profile desktop add` 会被拒（`managed exclusively by the Electron application`）——必须从 Desktop 自己的终端进。

### 方式三：命令行 dsh（开发者）

```bash
dsh plugin --profile web add @ggboy123/dsh-paper-reader
```

> npm 包名走 `@ggboy123` 作用域：裸名 `dsh-paper-reader` 已被另一个插件占用（那是「输入文献、吐精读报告」的一次性分析工具，与本插件的「阅读器 + 会话伴读」定位不同）。
> 不要用 `github:GGboya/dsh-paper-reader` 安装 —— dist 不入库，git 安装会导致 profile 起不来（构建产物只随 npm 包分发）。

### 升级

**已装过的用户升级必须带显式版本号**——不带版本的 `add` 对已存在的依赖是 no-op（pnpm 按首次安装时记录的版本范围解析，不会追新）：

```bash
dsh plugin --profile web add @ggboy123/dsh-paper-reader@1.4.0
# 重启 dsh web 生效；浏览器 Cmd+Shift+R 强刷，避免旧阅读器页面缓存
```

确认当前装的是哪个版本：

```bash
grep '"version"' ~/.dsh/profiles/web/node_modules/@ggboy123/dsh-paper-reader/package.json
```

> pnpm 若开了供应链策略 `minimumReleaseAge`（发布 N 小时内的新包拒装）：要么等过窗口期，要么在 `~/.dsh/profiles/web/.npmrc` 加一行 `minimum-release-age-exclude[]=@ggboy123/dsh-paper-reader`（只豁免本插件，不动全局策略）。

### 参与开发（本地调试）

欢迎改代码。流程：clone → 构建 → 以本地目录装进 profile，之后改完 `pnpm run build` 重启对应 profile 即可验证：

![参与开发：clone → pnpm install → build → 本地安装](https://raw.githubusercontent.com/GGboya/dsh-paper-reader/main/docs/dev-workflow.gif)

```bash
git clone https://github.com/GGboya/dsh-paper-reader
cd dsh-paper-reader && pnpm install && pnpm run build
dsh plugin --profile web add ./dsh-paper-reader   # 从父目录执行，或用绝对路径
dsh --profile web                                  # 侧栏变为文献库树
```

文献库目录默认 `~/.dsh-paper-reader/data`；在 profile 的 `cordis.patch.yml` 里可改：

```yaml
- id: dsh-paper-reader
  config:
    dataDir: /path/to/pdfqa/data   # 直接指向 pdfqa 文献库即可复用全部缓存
    # translate:                    # 可选：生成中文版（babeldoc）用的 OpenAI 兼容端点。
    #   baseUrl: https://api.deepseek.com/v1   # 一般不用写在这里——阅读器里点「中」
    #   apiKey: sk-...                          # 或右上角 ⚙ 可直接填，存到
    #   model: deepseek-chat                    # ~/.dsh/.dsh-paper-reader/translate.json（0600）
```

> 中文版端点：**优先在阅读器 UI 里填**（点「中」→ 没配会自动弹表单，或点 ⚙）——填完会先测连接再落盘，不用重启。
> 上面的 `translate` 配置退为**部署方默认值**，仅当 UI 未配置时生效。babeldoc 只支持 OpenAI 协议端点，
> Anthropic 协议的端点（如 `api.kimi.com/coding/`）不能直连。
>
> 翻译引擎**零预装**：找不到 babeldoc 时自动走 uv 链路安装——uv 独立二进制（GitHub Releases API 下载 + sha256 校验）→
> uv 托管 Python 3.12 → `uv pip install babeldoc`，落在 `~/.dsh/.dsh-paper-reader/bin/` 与文献库同级 `.venv-pdf2zh/`，
> 不碰系统 Python。已装有 uv / babeldoc（含 pdfqa 的 `.venv-pdf2zh`）则直接复用。macOS / Linux / Windows 均支持自动安装（Windows 走 uv 的 zip 包 + 系统自带 tar 解包）。

> 伴读模式是**按需开启**的：默认不注册 `sidebar.workspaces`（官方工作区/会话列表原样），侧栏底部「📚 论文伴读」开关点击才接管，再点还原；模式选择记在 localStorage。退出模式时已打开的 PDF 页签和伴读会话不受影响。

### 翻译引擎冒烟测试（Windows 依赖完整性）

Windows 用户最常见的翻车点是翻译引擎装不上（杀软拦 uv、网络截断、venv 残缺）。安装逻辑 `src/babeldoc-install.ts` 是纯 Node 模块（不依赖 Cordis/Electron），配了 GitHub Actions 在**全新干净机器**上跑冒烟，无需本地 Windows：

```bash
pnpm build
pnpm smoke:engine clean          # 全新安装全链路
pnpm smoke:engine managed-uv     # 强制走插件托管 uv 下载（sha256 校验路径）
pnpm smoke:engine pip-fallback   # 强制走 pip + 国内镜像备用通道
pnpm smoke:engine repair         # 破坏 venv（删 pymupdf）后验证自检→自动修复
pnpm smoke:engine translate      # 再用免费后端真翻一页小 PDF（依赖外网，波动大）
```

CI（`.github/workflows/engine-smoke.yml`）：`windows-latest` 跑全部四个场景，`macos-latest`/`ubuntu-latest` 跑 clean 防回归；改安装/翻译代码的 push 触发，外加每周一定时（uv/PyPI 在变，代码不动也可能突然坏）。`translate` 单独一个非阻塞 job——红了去看日志，但不算发版阻塞项。两个测试钩子环境变量：`DSH_PR_MANAGED_UV_ONLY=1`（跳过系统 uv 查找）、`DSH_PR_FORCE_PIP_CHANNEL=1`（跳过 uv 装包通道）。

## 架构

```
src/
  index.ts      Cordis 壳：inject tools；webServer 等服务就绪后挂路由
  tools.ts      5 个 agent 工具：list_papers / transcribe_pdf / search_paper / study_progress / study_update
  host.ts       webServer 路由（/paper-reader/*），connection.requestRejection 鉴权；
                sessionController.create/prompt（agentPreset=paper-reader）+ follow SSE 桥
  library.ts    纯函数：文献库目录约定与解析（.txt/.pages.json/.transcript.json/.mineru.* 产物路径）
  transcribe.ts 纯函数：pdf.js 提取 + 页码偏移表 + MinerU 后端选择与缓存来源语义
  mineru.ts     纯函数：MinerU 客户端（本地 legacy /tasks 轮询 + /file_parse；mineru.net v4 云端 + 最小 ZIP 读取器）
  mineru-config.ts 纯函数：MinerU 配置读写（$DSH_HOME 下 0600）+ 掩码 + 连通性预检
  search.ts     纯函数：分段 + 关键词打分 + 页码映射
  study.ts      纯函数：学习档案（计划 + 检验成绩）读写
  translate.ts  纯函数：babeldoc 调用（中文/中英对照 PDF 生成）
  babeldoc-install.ts 纯函数：无 Python 环境时自动安装 babeldoc（uv → 托管 Python → venv）
  translate-config.ts 纯函数：翻译端点配置读写（$DSH_HOME 下 0600）+ 保存前连接预检
  rerank.ts     纯函数：search_paper 语义重排（TypeSafe/Jev，无凭据时退回关键词排序）
  typesafe-config.ts 纯函数：TypeSafe 端点配置读写（与翻译配置同一套约定）
  preset.ts     纯函数：自带 agent preset 安装到 $DSH_HOME/.agent-presets/
presets/paper-reader/  「论文伴读」agent preset（persona 完整提示词 + compaction）
reader/index.html      阅读器页面（pdf.js，独立于 React 宿主，iframe 承载）
lib/client.js          浏览器半边：文献库树(sidebar.workspaces 接管) + PDF 页签 + 主面板
```

## License

MIT
