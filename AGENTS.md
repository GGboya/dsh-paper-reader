# AGENTS.md — 给 AI 协作者的项目说明

## 项目定位

[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 插件：论文伴读工作台（文献库 + PDF 阅读器 + AI 伴读）。npm 包 `@ggboy123/dsh-paper-reader`（裸名被别的插件占用，必须带 scope）。

- `dist/` 是构建产物，**不入库**；发布只走 npm。**不要建议用户用 `github:` 安装**——profile 会起不来。
- peer 兼容：`@deepseek-ai/dsh-tools >=0.1.5-rc.1 <0.3.0-0`；插件 ≥1.2.0 才能被 dsh 0.2.x 运行时（官方桌面端）接受。
- Node 要求 `^22.19.0 || >=24`。

## 常用命令

```bash
pnpm install && pnpm run build     # tsc，改完 build + 重启 profile 生效
npm test                           # node --test 全量（pretest 自动 build），CI 在 ubuntu/macos/windows 三平台跑
pnpm smoke:engine clean|managed-uv|pip-fallback|repair|translate   # babeldoc 引擎冒烟（Windows 依赖完整性）
```

本地调试：`dsh plugin --profile web add ./dsh-paper-reader`（从父目录或绝对路径）→ `dsh --profile web`；浏览器 Cmd+Shift+R 强刷避免旧阅读器缓存。

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
  translate-selection.ts 纯函数：划词翻译（公式保留——行内公式与 MinerU 块文本对齐还原、提示词契约、逐公式保全校验、内存 LRU）
  rerank.ts     纯函数：search_paper 语义重排（TypeSafe/Jev，无凭据时退回关键词排序）
  preset.ts     纯函数：自带 agent preset 安装到 $DSH_HOME/.agent-presets/
presets/paper-reader/  「论文伴读」agent preset（persona 完整提示词 + compaction）
reader/index.html      阅读器页面（pdf.js，独立于 React 宿主，iframe 承载）
lib/client.js          浏览器半边：文献库树(sidebar.workspaces 接管) + PDF 页签 + 主面板
```

## 硬约定（都有测试守着，改了会红）

- **README 守卫**（`test/merge-readme-parity.test.mjs`）：
  - README.md 与 README_EN.md 必须**各自存在一条 bullet** 完整列出 `PAPER_STEM_SUFFIXES` + `PDF2ZH_VARIANT_SUFFIXES`（定义在 `src/library-manage.ts`）。代码新增产物后缀时，两个 README 的这条 bullet 必须同步加。
  - README 里**每一个 `docs/...` 引用**都必须能解析到 git 已跟踪的文件（含 raw.githubusercontent URL 里的路径）。新增 docs 文件记得 `git add`，否则守卫直接红。
- **文档内容守卫**：用户向细节（MinerU 配置/实测声明、嵌入隐私提示、划词翻译与分屏前提）归口在 `docs/features.md` / `docs/features_EN.md`，由 `library-clear-and-busy.test.mjs` C2、`embed-search.test.mjs` I1、`embed-verification.test.mjs` 4.2/10.2 守住——改这些事实声明时中英两份 docs 一起改。
- **版本号守卫**（`library-clear-and-busy.test.mjs` C3）：README 必须出现 package.json 当前版本号，且不得残留其它 `vX.Y.Z` / `@X.Y.Z`。
- **部署校验器**会核对英文侧功能的正式命名（如 "**Click to cite a formula**"），改功能名时中英 README 一起改。
- 文档漂移是这个仓库历史上唯一的反复缺陷源——改代码行为时，同步检查 README / docs/features.md / 本文件。

## 设计原则（评审时按这个把关）

- `src/` 下模块尽量纯函数；副作用集中在 `index.ts` / `host.ts`。
- 默认不改官方界面（侧栏只多一行开关）；可选能力默认关闭，**未配置端点一条请求都不发**。
- 降级必须**如实提示**（如划词翻译未 MinerU 转录时气泡明说「译文可能不准」），不静默失败、不粉饰限制。
- 端点凭据落盘 `$DSH_HOME/.dsh-paper-reader/`，权限 0600，界面只回掩码。

## 数据与目录约定

- 文献库默认 `~/.dsh-paper-reader/data`，可在 profile 的 `cordis.patch.yml` 改（可直指 pdfqa 的 `data/` 复用缓存）。
- 文献产物命名：`<文献>.pdf/.txt/.pages.json/.transcript.json/.mineru.md/.mineru.json/.embeddings.json/.study.json`，译文变体 `<文献>-en.pdf/-zh.pdf/-dual.pdf`（中断残留 `.tmp-*`）。
- 删除 = 移入 `data/.trash/<时间戳>/`（带 manifest，可手工恢复）；路径穿越（`..`/绝对路径/符号链接逃逸）一律拒绝；中途失败自动回滚。

## 功能细节文档

用户向的前提/代价/已知限制在 [docs/features.md](docs/features.md)（英文 [docs/features_EN.md](docs/features_EN.md)）；阅读器 UX 需求与报错排查在 [docs/reader-ux-requirements.md](docs/reader-ux-requirements.md)。
