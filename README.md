# dsh-paper-reader

[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 插件：论文伴读工作台 —— PDF 转录 / 检索 / 流式问答 + 内置阅读器页面。

> 🚧 Early development. 插件骨架搭建中，功能迁移自本地独立产品 pdfqa（Go 实现的论文伴读工具，自带手写最小 agent，零框架依赖）。

## 规划功能

- 📄 **PDF 转录**：本地提取（PyMuPDF）优先，视觉转录兜底，扫描件也能读
- 🔍 **`search_paper` 工具**：长文档检索模式，agent 按需定位相关段落
- 💬 **选中即问**：在阅读器里选中文字，围绕选中内容向 agent 提问
- 📖 **内置阅读器页面**：注册到 dsh web UI，缩放 / 高清渲染 / 引用定位
- 💾 **问答存档**：每轮问答自动追加为 Markdown，可追溯
- 📚 **专题 × 文献管理**：按研究方向组织论文库

## 安装（待发布）

```bash
dsh plugin --profile web add github:GGboya/dsh-paper-reader
```

## License

MIT
