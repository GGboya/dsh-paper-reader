# dsh-paper-reader

[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 插件：论文伴读工作台 —— PDF 转录 / 检索 / 问答 + 内置阅读器页面。

功能迁移自本地独立产品 pdfqa（Go 实现的论文伴读工具），agent 循环 / 模型层交给 dsh 框架，插件只做「转录 + 检索 + 存档 + 阅读器 UI」。

## 功能

- 📄 **PDF 转录**：本地提取（python3 + PyMuPDF）优先，页眉页脚剔除 / 连字 / 断词愈合 / 段落重排，产出页码偏移表；兼容 pdfqa 的 `data/` 缓存布局（旧缓存读取时自动补建页码索引）
- 🔍 **`search_paper` 工具**：长文档分段检索，返回带页码的原文片段
- 📖 **内置阅读器页面**：dsh Web UI 侧栏一键进入；PDF.js 缩放 / Retina 高清 / 文本层选择
- 💬 **选中即问**：选中文字 → 弹出提问框 → 注入该文献的专属伴读会话（每篇文献一个 dsh 会话，重启可续）
- 💾 **问答存档**：每轮问答自动追加为 Markdown（`<文献>-qa/<会话>.md`），阅读器侧栏实时展示
- 📍 **引用定位**：存档回答里的「第 N 页」可点击，平滑跳回 PDF 对应页
- 📚 **专题 × 文献管理**：`<dataDir>/<专题>/<文献>.pdf` 两级布局，兼容 pdfqa 文献库

## 安装（待发布）

```bash
dsh plugin --profile web add github:GGboya/dsh-paper-reader
```

本地开发：

```bash
pnpm install && pnpm run build
dsh plugin --profile web add ./dsh-paper-reader   # 从父目录执行
dsh --profile web                                  # 侧栏出现「Paper Reader」入口
```

文献库目录默认 `~/.dsh-paper-reader/data`；在 profile 的 `cordis.patch.yml` 里可改：

```yaml
- id: dsh-paper-reader
  config:
    dataDir: /path/to/pdfqa/data   # 直接指向 pdfqa 文献库即可复用全部缓存
```

## 架构

```
src/
  index.ts      Cordis 壳：inject tools；webServer 出现时挂路由
  tools.ts      4 个 agent 工具：list_papers / transcribe_pdf / search_paper / archive_qa
  host.ts       webServer 路由（/paper-reader/*），connection.requestRejection 鉴权
  library.ts    纯函数：文献库目录约定与解析
  transcribe.ts 纯函数：PyMuPDF 提取 + 页码偏移表（视觉兜底后置）
  search.ts     纯函数：分段 + 关键词打分 + 页码映射
  archive.ts    纯函数：问答 Markdown 追加存档
reader/index.html  阅读器页面（pdf.js，独立于 React 宿主，iframe 承载）
lib/client.js      浏览器半边：main 面板 + sidebar.panellist 入口
```

## License

MIT
