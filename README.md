# dsh-paper-reader

[![npm version](https://img.shields.io/npm/v/@ggboy123/dsh-paper-reader)](https://www.npmjs.com/package/@ggboy123/dsh-paper-reader)
[![npm downloads](https://img.shields.io/npm/dm/@ggboy123/dsh-paper-reader)](https://www.npmjs.com/package/@ggboy123/dsh-paper-reader)
[![license](https://img.shields.io/github/license/GGboya/dsh-paper-reader)](https://github.com/GGboya/dsh-paper-reader/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/GGboya/dsh-paper-reader?style=social)](https://github.com/GGboya/dsh-paper-reader/stargazers)

**English**: [README_EN.md](README_EN.md)

[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 插件：论文伴读工作台 —— PDF 转录 / 检索 + 原生对话伴读 + 内置阅读器。

> **👉 普通用户直接看「安装 → 方式一」**：装 DeepSeek 官方桌面端，添加插件即可，不需要任何开发环境。本仓库面向的是想自己装插件、或想改代码的用户。

功能迁移自本地独立产品 pdfqa（Go 实现的论文伴读工具）。原则：agent 循环 / 模型层 / 会话持久化全部交给 dsh 框架，插件只做「转录 + 检索 + 阅读器 UI」的薄壳组合。

**安装后不改动官方界面** —— 侧栏底部多一行「📚 论文伴读」开关，点击才进入伴读模式（左侧变为文献库树），再点即还原官方工作区列表：

![演示：选中即问 → 回答带页码 → 点页码跳回 PDF 并高亮原文](docs/demo.gif)

![默认安装：官方侧栏原样，只多一行开关](https://raw.githubusercontent.com/GGboya/dsh-paper-reader/main/docs/screenshot-default.png)

![伴读模式：文献库 + PDF 阅读器 + 原生对话](https://raw.githubusercontent.com/GGboya/dsh-paper-reader/main/docs/screenshot-reading.png)

## 功能

- 📚 **侧栏文献库树**：「论文伴读」模式开启时接管工作区侧栏，专题 → 论文两级；支持新建专题、上传 PDF、**专题/论文改名与删除**（行悬停出 ✎ 🗑；删除两击确认；改名连带转录缓存 / 译文 / 学习档案一起搬家）（默认关闭，不覆盖官方界面）
- 💬 **原生对话伴读**：点击论文即在右侧打开它的 dsh 原生会话（流式 / 工具卡 / 用量条全是官方 UI）；默认只呈现当前对话，对话列头部的 🕐 下拉回看**历史对话**（真实标题+日期，点哪条进哪条），＋ 新建对话
- 🔗 **会话绑定论文**：会话 id 编码文献身份，工具调用自动定位当前论文——直接在输入框提问无需点名论文，回答必带页码
- 🤖 **专用 agent preset「论文伴读」**：paper 会话自动使用专用 preset —— 像老师一样带读：制定分步阅读计划（每步带页码和思考题）→ 逐节指导、点评 → 出题检验、逐题批改 → 成绩与薄弱点记入 `<文献>.study.json` 学习档案，跨会话累积；快速问答（选中即问）则直接回答，不上课
- 📖 **PDF 阅读器居中**：中间是论文（PDF.js 缩放 / Retina 高清 / 文本层选择 / 适宽模式 / **滚动 ↔ 单页翻页双模式**——‹ › 翻页、页码输入跳转、← → / PageUp / PageDown / Space / Home / End 键盘翻页），最右是该论文的原生对话 —— 视觉换位实现，列宽拖拽/折叠仍是 dsh 原生行为，关掉 PDF 页签即还原官方布局；状态栏显示 PDF 完整路径，点击复制
- 💬 **选中即问**：阅读器里选中文字 → 弹出提问框 → 注入当前会话，原生对话区实时回答
- 📍 **引用定位**：回答里的「第 N 页」可点击，平滑跳回 PDF 对应页并闪烁
- 🀄 **中英切换 + 导出**：顶栏「中」按钮原文 ↔ 纯中文切换；无译文时一键后台生成（babeldoc），生成需配置 `translate` 端点；**无需预装 Python**——首次生成时自动下载 uv + 托管 Python + babeldoc（macOS / Linux / Windows，约几分钟），全程落在用户目录；顶栏 ⤓ 一键**下载当前版本**（原文 / 纯中文 / 中英对照 PDF）
- 🔍 **PDF 转录 + 检索**：本地提取（pdf.js，纯 Node 无需 Python），页眉页脚剔除 / 连字 / 断词愈合 / 段落重排，产出页码偏移表；可选接入 TypeSafe/Jev 语义重排（设置面板填端点即启用，不配置时退回纯关键词排序）；兼容 pdfqa 的 `data/` 缓存布局（旧缓存读取时自动补建页码索引）

> **库管理须知**：改名/删除直接作用于磁盘文件（论文的转录缓存、译文、学习档案随之改名/删除）；论文/专题改名后，历史伴读会话不再挂在树上（会话本体仍在 dsh 全局会话列表里），学习进度跟着文件走不丢；翻译进行中的论文禁止改名/删除。

## 安装

### 方式一：官方桌面端装插件（推荐）

**DeepSeek 官方桌面端**（[deepseek.com/download](https://www.deepseek.com/download/) 下载，即 DeepSeek Harness 桌面版）：

1. 安装并启动，登录 DeepSeek 账号
2. 侧栏 → **插件** → **添加插件**，输入 `@ggboy123/dsh-paper-reader@1.3.3` 安装
3. 装完默认**停用**：点进插件详情，打开「启用」开关
4. **重启桌面端**（热启用状态下打开论文的链路会静默失效，重启进开机组合才正常，实测）

完整流程演示（添加插件 → 启用 → 重启 → 打开论文直接提问）：

![官方桌面端安装并使用论文伴读插件](https://raw.githubusercontent.com/GGboya/dsh-paper-reader/main/docs/desktop-official-use.gif)

> 已在官方桌面端 V0.2.0-rc.2（内置 dsh 0.2.0-rc.2，macOS arm64）实测通过：侧栏文献库、新建专题、上传 PDF、PDF 阅读器、原生对话伴读、历史/新建对话按钮全部可用。
> 需要 ≥1.2.0：更早版本会被 0.2.x 运行时的 peer 兼容校验拒载（插件列表里显示异常）。

> 曾经的 PaperReader 桌面版（基于社区 DSH Desktop 的预装打包）**已不再维护**——统一收敛到官方桌面端 + 插件的形式，老用户请迁移到本方式。

### 方式二：命令行 dsh（开发者）

```bash
dsh plugin --profile web add @ggboy123/dsh-paper-reader
```

> npm 包名走 `@ggboy123` 作用域：裸名 `dsh-paper-reader` 已被另一个插件占用（那是「输入文献、吐精读报告」的一次性分析工具，与本插件的「阅读器 + 会话伴读」定位不同）。
> 不要用 `github:GGboya/dsh-paper-reader` 安装 —— dist 不入库，git 安装会导致 profile 起不来（构建产物只随 npm 包分发）。

### 升级

**已装过的用户升级必须带显式版本号**——不带版本的 `add` 对已存在的依赖是 no-op（pnpm 按首次安装时记录的版本范围解析，不会追新）：

```bash
dsh plugin --profile web add @ggboy123/dsh-paper-reader@1.3.3
# 重启 dsh web 生效；浏览器 Cmd+Shift+R 强刷，避免旧阅读器页面缓存
```

> **桌面端升级后插件开关会回到停用**（实测）：侧栏 → 插件 → 打开 `@ggboy123/dsh-paper-reader` 的「启用」开关 → 重启桌面端。不打开时的症状很有迷惑性：文献树还在（浏览器侧缓存活着）但点论文没反应（宿主侧已下线），看起来像坏了，其实只是没启用。

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
pnpm smoke:engine translate      # 再起本地 mock OpenAI 端点,真跑一遍 babeldoc 翻译管线
```

CI（`.github/workflows/engine-smoke.yml`）：`windows-latest` 跑全部四个场景 + translate-e2e，`macos-latest`/`ubuntu-latest` 跑 clean 防回归；改安装/翻译代码的 push 触发，外加每周一定时（uv/PyPI 在变，代码不动也可能突然坏）。两个测试钩子环境变量：`DSH_PR_MANAGED_UV_ONLY=1`（跳过系统 uv 查找）、`DSH_PR_FORCE_PIP_CHANNEL=1`（跳过 uv 装包通道）。

## 架构

```
src/
  index.ts      Cordis 壳：inject tools；webServer 等服务就绪后挂路由
  tools.ts      5 个 agent 工具：list_papers / transcribe_pdf / search_paper / study_progress / study_update
  host.ts       webServer 路由（/paper-reader/*），connection.requestRejection 鉴权；
                sessionController.create/prompt（agentPreset=paper-reader）+ follow SSE 桥
  library.ts    纯函数：文献库目录约定与解析
  transcribe.ts 纯函数：pdf.js 提取 + 页码偏移表（视觉兜底后置）
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
