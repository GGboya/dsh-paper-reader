# dsh-paper-reader

[![npm version](https://img.shields.io/npm/v/@ggboy123/dsh-paper-reader)](https://www.npmjs.com/package/@ggboy123/dsh-paper-reader)
[![npm downloads](https://img.shields.io/npm/dm/@ggboy123/dsh-paper-reader)](https://www.npmjs.com/package/@ggboy123/dsh-paper-reader)
[![license](https://img.shields.io/github/license/GGboya/dsh-paper-reader)](https://github.com/GGboya/dsh-paper-reader/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/GGboya/dsh-paper-reader?style=social)](https://github.com/GGboya/dsh-paper-reader/stargazers)

**English**: [README_EN.md](README_EN.md)

[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 插件：**论文伴读工作台** —— 文献库 + PDF 阅读器 + AI 伴读，回答自带页码、点页码跳回原文。当前版本 **v1.11.0**。

> 💬 **QQ 交流群：1127244508** —— 安装/使用问题、功能建议、bug 反馈都欢迎来聊。

## 为什么用论文伴读

1. **论文一多，文件和阅读进度就容易乱。** 按专题、子专题整理论文，每篇论文的 PDF、译文、笔记和学习记录都放在一起；改名、移动、删除都有管理入口，删错了还能从回收站恢复。
2. **翻译不该打断阅读。** 不用把段落复制到别的软件，直接在原 PDF 版面上生成中文；支持纯中文、中英对照、左右分屏和划词翻译，公式也能保留。
3. **AI 的回答，需要能回到原文核对。** 回答自带页码，点击就跳到对应原文并高亮；可以只问当前论文，也可以把范围扩大到整个专题，减少“答得流畅却找不到出处”。

![演示：选中即问 → 回答带页码 → 点页码跳回 PDF 并高亮原文](docs/demo.gif)

![默认安装：官方侧栏原样，只多一行开关](https://raw.githubusercontent.com/GGboya/dsh-paper-reader/main/docs/screenshot-default.png)

![伴读模式：文献库 + PDF 阅读器 + 原生对话](https://raw.githubusercontent.com/GGboya/dsh-paper-reader/main/docs/screenshot-reading.png)

## 核心能力

- 📚 **三栏工作台**：专题文献库 + PDF 阅读器 + 右侧原生对话；安装后不改动官方界面，侧栏只多一行开关
- 💬 **带页码的伴读**：回答必带页码，点页码跳回原文并高亮；选中文字即问；支持历史对话
- 🌙 **PDF 深色模式**：dsh 切深色时 PDF 一起变深（默认跟随）；设置面板与阅读器「A」按钮同源、四档强度可调。实现是整页反色 + 色相回正，**图片/照片会明显褪色偏色**（实测纯红 `[255,0,0]` → 浅粉 `[229,134,134]`，不是真负片；已知代价，可一键关闭）；下载/导出始终是原文
- 🗂️ **按论文分文件夹**：每篇论文的 PDF/译文/转录/学习档案收进 `<专题>/<论文>/`；旧库有一条**幂等、可中断、可回滚**的迁移（先复制后删，先出干跑报告再执行）
- 🌳 **嵌套子专题**：专题下可建子专题、任意层嵌套；可改名、可移动到另一父专题；删除非空专题仍走「清空计划 + 手输确认」
- 🎯 **按范围提问**：提问时可指定范围（本篇 / 所在专题含子专题），只把该范围的目录内容与检索命中交给模型；范围外内容不出现，截断会明确说明
- 🤖 **可选教练式带读**：专用 preset 制定分步计划；你读原文、作答，AI 点评追问，当前阶段答好才继续，学习进度跨会话累积
- 🀄 **一键中文版**：原文 ↔ 纯中文原地切换，译文 PDF 一键导出（纯中文 / 中英对照），翻译引擎零预装自动安装
- 📏 **长段落不截断 + 实时进度**：翻译由 `babeldoc-driver.py` 驱动 babeldoc —— 按输入估算输出预算（不再吃 babeldoc 写死的 2048），`finish_reason=length` 自动拆段重译；顶栏进度条实时显示「翻译段落 76%（521/798）」这样的阶段进度，端点拒绝关闭推理时自动降推理强度重试
- 🈯 **划词翻译（公式保留）**（v1.11.0）：选中点「译」出纯译文气泡；选区含公式时用 MinerU 识别的 LaTeX 替换文本层乱码、要求模型原样保留
- 🖥️ **中英对照 / 分屏**（v1.11.0）：并排对照页或左右分屏同步滚动，随时切换、按文献记忆
- 📝 **笔记**（v1.11.0）：划词仍直接弹回「选中即问」气泡（与旧版一致），气泡里新增「笔记」「全局搜索」小按钮；记过的文字下方画蓝色波浪线，鼠标停上去看笔记内容、点一下改或删；笔记窗口与查找窗同一套交互（可拖动、拖边框缩放、位置记忆），批量列表按页排序、点条目跳回原文，也可在条目上直接删除（二次确认）。笔记存在 `<文献>.notes.json`（跟文献走，换浏览器不丢）
- ⚡ **长文档也流畅**：滚动模式只画视口附近的页、页离开视口即释放画布（其余保留等高占位，滚动条与页码始终准）；原文 ↔ 中文切换只摘挂缓存好的页节点，不重新解析不重绘；切语言 / 重开论文不重传 PDF（ETag 304）。前提与已知边界见 [docs/features.md](docs/features.md)
- 🗂️ **文献管理**：专题/论文在文件名上原地改名，论文可跨专题移动；删除进回收站可恢复
- 🛰️ **OpenCode Go 端点**（v1.11.0）：翻译端点供应商预设新增「OpenCode Go」（订阅后复制 API Key 即用，模型名以控制台为准）；对 opencode.ai 域的请求自动带稳定 `x-opencode-session` 会话头（同一篇论文的整篇与划词共用同一 ID、跨重启稳定，ID 由本机 0600 secret 派生不含论文名），其它端点不多发任何头
- 🔀 **翻译模型可跟随也可覆盖**：默认直接跟随 Harness 当前模型（含账号授权，不需要复制 Key）；需要专门翻译模型时，可在「设置 → 论文伴读 → 全文翻译模型」选择预设厂商、从官方链接申请 Key、自动获取模型。自定义只作用于翻译，切回跟随时配置仍保留，绝不改写 Harness 设置
- ➕ **可选增强**（默认关）：MinerU 解析——扫描件可读、公式可点引用可检索；嵌入端点——大白话命中术语段落

各功能的前提与配置细节见 [docs/features.md](docs/features.md)。

## 安装

### 普通用户：桌面端装好即用（推荐）

**两步**：装 DeepSeek 官方桌面端 → 里面直接装插件。

1. 下载安装 [DeepSeek 官方桌面端](https://www.deepseek.com/download/)（即 DeepSeek Harness 桌面版），登录 DeepSeek 账号
2. 侧栏 → **插件** → **添加插件**，输入 `@ggboy123/dsh-paper-reader@latest`，装完点进插件详情打开「启用」开关，**重启桌面端**

完成。侧栏底部点「📚 论文伴读」进入文献库，上传 PDF 开始用。

![官方桌面端安装并使用论文伴读插件](https://raw.githubusercontent.com/GGboya/dsh-paper-reader/main/docs/desktop-official-use.gif)

> 需要官方桌面端 V0.2.0-rc.2 或更新版本（内置 dsh ≥0.2.0-rc.2）；dsh 0.1.5 不再支持。
> 想逛插件市场可另装社区插件 [`dshmarket`](https://github.com/dsh-market/dsh-market)，本插件已在其目录中。

**排坑**（都是实测踩过的）：

- **升级后插件开关会回到停用**：重新打开「启用」并重启。症状有迷惑性——文献树还在但点论文没反应
- **添加务必带 `@latest`**：不带版本号对已装过的插件是 no-op，不会追新
- pnpm 供应链策略 `minimumReleaseAge` 拦新包时：等过窗口期，或把本包加进豁免清单（`~/.dsh/profiles/web/.npmrc` 的 `minimum-release-age-exclude[]`；桌面端在 `~/.dsh/profiles/desktop/pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`）

### 开发者：命令行 dsh

```bash
dsh plugin --profile web add @ggboy123/dsh-paper-reader@latest   # 升级也是这条；不带版本号是 no-op
```

> 不要用 `github:GGboya/dsh-paper-reader` 安装 —— dist 不入库，git 安装会导致 profile 起不来。

## 怎么用

1. **进入**：侧栏底部点「📚 论文伴读」（再点还原）
2. **入库**：＋ 新建专题 → ⬆ 上传 PDF
3. **读 + 问**：直接提问（回答自带页码），或选中文字弹框提问；点「第 N 页」跳回原文
4. **中文版**：顶栏「中」一键生成，默认跟随 Harness 当前模型；需要专用翻译模型时在「设置 → 论文伴读 → 全文翻译模型」里单独配置
5. **管理**：行悬停点「⋯」，文件名原地改名（Enter 保存 / Esc 取消），论文可移动到其它专题，也可删除；对话头部 🕐 历史、＋ 新开

## 文献管理（安全说明）

- 删除 = **移入回收站** `data/.trash/`（带 manifest，移回即恢复）；会处理该文献的全部产物：`<文献>.pdf`、`.txt`、`.pages.json`、`.transcript.json`、`.mineru.md`、`.mineru.json`、`.embeddings.json`、`.study.json`、`.notes.json` 与译文变体 `<文献>-en.pdf` / `-zh.pdf` / `-dual.pdf`（含 `.tmp-*` 残留）；伴读会话历史不删。运行中会话/翻译中的文献会被前置拒绝；路径穿越一律拒绝、失败自动回滚——细则见 [docs/features.md](docs/features.md)

## 参与开发

```bash
git clone https://github.com/GGboya/dsh-paper-reader
cd dsh-paper-reader && pnpm install && pnpm run build
dsh plugin --profile web add ./dsh-paper-reader   # 从父目录执行，或用绝对路径
dsh --profile web                                  # 侧栏变为文献库树
```

改完 `pnpm run build` 重启 profile 即生效；`npm test` 跑全量测试（354 用例，CI 三平台）。架构、测试守卫与开发约定见 [AGENTS.md](AGENTS.md)。

## 贡献者

感谢每一位贡献者：

<a href="https://github.com/GGboya/dsh-paper-reader/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=GGboya/dsh-paper-reader" alt="贡献者头像墙" />
</a>

## Star 趋势

[![Star 趋势图](https://api.star-history.com/svg?repos=GGboya/dsh-paper-reader&type=Date)](https://star-history.com/#GGboya/dsh-paper-reader&Date)

## License

MIT
