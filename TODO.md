# TODO — dsh-paper-reader 插件开发路线

> 目标：把 pdfqa（Go 独立版）的核心能力重写为 DeepSeek Harness 插件。
> 原则：agent 循环 / 模型层交给 dsh 框架，只做「转录 + 检索 + 存档 + 阅读器 UI」。

## Phase 0 — 环境验证（半天）

- [ ] 安装 dsh：`npx @deepseek-ai/dsh web`，确认 http://127.0.0.1:3080 能打开
  - ⚠️ 若 npm install 卡死，加 `--legacy-peer-deps`（已知坑 [Discussion #4236](https://github.com/deepseek-ai/deepseek-harness/discussions/4236)）
- [ ] 跑通官方最小插件（Cordis `apply(ctx)` + `console.log`），确认 `--patch` 加载机制
- [ ] 用 `create-dsh-plugin` 的 **webui 模板** 生成脚手架，确认当前 DP 版本的 UI 注册 API 可用（这是后续所有 UI 工作的地基，API 可能有破坏性变更，先验证再动工）

## Phase 1 — 工具层闭环（1~2 天）

- [ ] `transcribe_pdf` 工具：shell 调 python3 + PyMuPDF 本地提取（移植 pdfqa 的三级策略，视觉兜底可后置）
- [ ] `search_paper` 工具：长文档分段检索，返回带页码的片段
- [ ] 文献库存储：插件数据目录约定（专题 > 文献 > 转录缓存），兼容 pdfqa 的 `data/` 布局思路
- [ ] 问答 Markdown 存档：每轮追加写 `<文献名>-qa/<会话>.md`
- [ ] 在 dsh 会话里实测：让 agent 读一篇真实论文并回答引用页码

## Phase 2 — 阅读器页面（工作量主体）

- [ ] 通过 `webServer` 服务注册 HTTP 路由：serve 阅读器页面 + PDF 文件 + 转录数据接口
- [ ] 注册侧栏 tab / 页面入口（参考 DSH-better-sidebar 的注册方式）
- [ ] 移植 pdfqa `static/` 的阅读器前端：PDF.js 渲染、缩放、Retina 高清、文本层
- [ ] 「选中即问」：选中文字 → 注入 dsh 会话并提问（需要查 dsh 的会话 API / frontend-tools 桥接）
- [ ] 引用定位：回答里的页码点击跳回 PDF 对应位置

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
