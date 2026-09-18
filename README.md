# dsh-paper-reader

[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 插件：论文伴读工作台 —— PDF 转录 / 检索 + 原生对话伴读 + 内置阅读器。

功能迁移自本地独立产品 pdfqa（Go 实现的论文伴读工具）。原则：agent 循环 / 模型层 / 会话持久化全部交给 dsh 框架，插件只做「转录 + 检索 + 阅读器 UI」的薄壳组合。

**安装后不改动官方界面** —— 侧栏底部多一行「📚 论文伴读」开关，点击才进入伴读模式（左侧变为文献库树），再点即还原官方工作区列表：

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
- 🀄 **中英切换**：顶栏「中」按钮原文 ↔ 纯中文切换；无译文时一键后台生成（babeldoc），生成需配置 `translate` 端点
- 🔍 **PDF 转录 + 检索**：本地提取（pdf.js，纯 Node 无需 Python），页眉页脚剔除 / 连字 / 断词愈合 / 段落重排，产出页码偏移表；兼容 pdfqa 的 `data/` 缓存布局（旧缓存读取时自动补建页码索引）

## 安装

```bash
dsh plugin --profile web add @ggboy123/dsh-paper-reader
```

> npm 包名走 `@ggboy123` 作用域：裸名 `dsh-paper-reader` 已被另一个插件占用（那是「输入文献、吐精读报告」的一次性分析工具，与本插件的「阅读器 + 会话伴读」定位不同）。
> 不要用 `github:GGboya/dsh-paper-reader` 安装 —— dist 不入库，git 安装会导致 profile 起不来（构建产物只随 npm 包分发）。

本地开发：

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

> 伴读模式是**按需开启**的：默认不注册 `sidebar.workspaces`（官方工作区/会话列表原样），侧栏底部「📚 论文伴读」开关点击才接管，再点还原；模式选择记在 localStorage。退出模式时已打开的 PDF 页签和伴读会话不受影响。

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
  translate-config.ts 纯函数：翻译端点配置读写（$DSH_HOME 下 0600）+ 保存前连接预检
  preset.ts     纯函数：自带 agent preset 安装到 $DSH_HOME/.agent-presets/
presets/paper-reader/  「论文伴读」agent preset（persona 完整提示词 + compaction）
reader/index.html      阅读器页面（pdf.js，独立于 React 宿主，iframe 承载）
lib/client.js          浏览器半边：文献库树(sidebar.workspaces 接管) + PDF 页签 + 主面板
```

## License

MIT
