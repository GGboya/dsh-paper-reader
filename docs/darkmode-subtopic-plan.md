# 深色模式 + 文献库结构改造 — 冻结方案（v1）

> 本文件是**方案冻结**，不含实现代码。实现方照此开工，验证方照此核。
> 所有结论标注证据等级：**【实测】**= 本机跑出来的（命令 + 输出见 `.probe/darkmode-subtopic/`）；**【源码】**=`file:line`；
> **【一手来源】**= 上游仓库/官方文档并附链接；**【推测】**= 未验证，实现时必须先证伪。

---

## 0. 阅读顺序与冻结摘要

| 编号 | 冻结结论 | 依据位置 |
|---|---|---|
| A1 | 其他阅读器的深色实现分成**四条路线**（CSS 滤镜 / 像素重写 / 重渲染配色 / 主题 token），逐项来源见 §A1 | §A1 |
| A2 | **推荐路线：canvas 上打 CSS 滤镜** `invert(1) hue-rotate(180deg)` + 强度旋钮，`.page` 单独换深色底 | §A2（附实测证明不破坏几何/选区/热区） |
| A3 | 深色开关放**设置面板**（默认 `follow`＝跟随 dsh），并**同时**在阅读器 `⚙` 浮层暴露同一个开关 | §A2.3 |
| A4 | dsh 主题的权威接口是 `body[data-ds-dark-theme]` + `html[data-ds-theme-source]`；iframe **不继承** CSS 变量 | §A2.2（【一手来源】+【实测】） |
| B1 | 新布局 = `<dataDir>/<专题路径>/<论文名>/<论文名>.<后缀>`；旧布局**不双读**，用一次性幂等迁移收口 | §B1 |
| B2 | 嵌套子专题 = **目录即层级**；`topic` 参数升级为**路径**（`A/B/C`），校验改成**切段后逐段复用既有 `validateName`** | §B2 |
| B3 | 按范围提问 = 宿主在 `/api/ask` 里**服务端构造三段式上下文**（目录清单 + 选中论文正文 + 检索命中），默认范围 = 当前论文 | §B3 |
| — | 分支策略与基线核对（已确认任务指定基线正确）；行号地图（基线 vs 工作树） | §0.1 / §0.2 |

> **本方案的两处自我纠正（留给审核方对照）**
> 1.（已改正）基线判断：第一版我读错 git 拓扑，得出"必须从工作树切、ec21969 会丢功能"的**错误结论**；
>    用 `git archive ec21969 | tar -x` 落地检查后确认**基线本来就含全部前置功能**，任务描述是对的。详见 §0.1 末尾的"我踩过的坑"。
> 2.（已改正）**本批范围**：第一版把"删除非空专题的批量清空 + 手输确认"写成了要**新增**，
>    实际基线 `ec21969` **已经有** `planTopicClear`/`clearTopic` + `GET /topic/clear-plan` + `POST /topic/clear` + 前端三步确认。
>    本批在那条链路上**只有一个扩展点**（不递归 → 递归）。详见 §B2.2 的"重要更正"。
> 这两处都是**"我以为"而不是"我验证"**造成的；实现方若发现第三处同类偏差，先按本文件 §0.2 的探查方式证伪，再改方案。

### 0.1 基线核对（开工前必做）

> 第一版我读错了 git 拓扑（见下方「我踩过的坑」），现已改正。**结论：任务指定的基线是对的。**

**冻结基线 = `origin/main` = `ec21969`，`package.json` version = 1.5.0**（与任务描述一致，已实测确认）。

```bash
# 第一轮跑时网络被拦（把这个失败也记下来：它决定后来者该"用旧引用"还是"重 fetch"）：
$ git fetch origin
fatal: unable to access 'https://github.com/GGboya/dsh-paper-reader.git/':
       GnuTLS, handshake failed: The TLS connection was non-properly terminated.
# 第二轮重跑**成功**（本机出网时通时不通；代理 127.0.0.1:7897 在，但 raw.githubusercontent 系仍会超时）：
$ git fetch origin && git log --oneline -1 origin/main && git show origin/main:package.json | grep -m1 version
ec21969 docs: README 瘦身（功能一句话化）+ 新增 AGENTS.md；细节归口 docs/features*.md
  "version": "1.5.0",
# ⇒ origin/main 就是任务描述的 ec21969 / 1.5.0，**已与远端核对**（不再只是本地旧引用）。
```

| 分支 | commit | version | 与 `ec21969` 的关系 |
|---|---|---|---|
| **`origin/main`**（= 冻结基线） | `ec21969` | **1.5.0** | — |
| 本地 `main` | `616678a` | 1.2.0 | **ancestor of `ec21969`**（落后，`git merge-base --is-ancestor main origin/main` → YES） |
| `feat/selection-translate`（**当前工作树**） | `690fb44` | 1.6.0 | **divergent**（`git merge-base --is-ancestor origin/main HEAD` → **NO**；`git merge-base --is-ancestor main HEAD` → YES，即它从 `main` 分出、又领先 33 个提交） |
| 本机安装的插件 `~/.dsh/local/dsh-paper-reader/` | — | 1.5.0 | 与基线**同版本**；`reader/index.html` 125/127 KB，含分屏/公式热区/选择翻译 |

**`ec21969` 已包含本批全部前置能力**（逐个实测存在）：

```bash
$ for f in src/mineru.ts src/translate-selection.ts src/embed.ts src/search.ts; do git cat-file -e ec21969:$f; done   # 全部 EXISTS
$ git show ec21969:reader/index.html | grep -c eqLayer            # 4
$ git show ec21969:reader/index.html | grep -c textLayer          # 17
$ git show ec21969:reader/index.html | grep -c pdf-pages-zh       # 7   （分屏）
$ git show ec21969:reader/index.html | grep -c translate-selection# 2
$ git show ec21969:lib/client.js    | grep -c syncScroll          # 4
```

> **⚠️ 我第一版踩的坑（留给后来者）**：我用 `git rev-list --count ec21969..main` 得到 `0`，
> 就误判成「main 领先 ec21969」。这是**读错了方向**（两个反向计数要一起看：`main..ec21969` = 80，
> 说明是 `ec21969` 领先）；恰好又会错意 `git merge-base --is-ancestor` 的结果，于是得出了
> 「必须从 HEAD 切、否则丢功能」的**错误结论**。用 `git merge-base --is-ancestor` 单向验证
> + `git archive ec21969 | tar -x` 落地检查文件存在性之后才纠正过来。
> **教训写进验收**：基线判断不许只看 commit 计数，必须"落地检查关键文件是否存在于目标 commit"。

**分支策略（冻结）**：

> 从 **`origin/main`（`ec21969`）** 切新分支：

```bash
git switch -c feat/darkmode-subtopic ec21969
```

- **不要**从本地 `main`（`616678a`）切：它是 `ec21969` 的祖先，会丢 80 个提交。
- **不要**从当前工作树 HEAD（`feat/selection-translate`）切：它是 divergent 的另一条线（version 1.6.0），
  与本方案的 `file:line` 基线不符（两套行号对照见 §0.2，实现以基线为准）。
- 本方案所有 `file:line` 均给出**基线 `ec21969`** 与**当前工作树 HEAD** 两套；**实现以基线为准**。

**版本号**：基线 1.5.0 ⇒ 本批发布用 **1.6.0**（`package.json` / README 章节 / 安装说明三处对齐）。
⚠️ 注意当前工作树的 `package.json` 已经是 1.6.0（未发布），若沿用工作树做基线会造成版本号撞车。
### 0.2 本方案的方法学与产物

**方法学三条**：① 任何结论要么给 `file:line`（基线提交内容，用 `git show <rev>:<path>` 读，不读工作树），
要么给命令+原始输出；② 真实文献库 `~/.dsh-paper-reader/data` **只读**，破坏性实验一律在 `/tmp` 副本；
③ 实测与推测分开标注，推测一律写明"未验证 + 谁来验"。

**产物**：本文件 + `.probe/darkmode-subtopic/` 下 **6 个可复跑脚本**（合计 **128** 条断言，全部针对
**冻结基线 `origin/main`** 跑绿）+ `evidence/`（真实论文的 before/after PNG 与 JSON 报告）。

```bash
DPR_REV=origin/main node .probe/darkmode-subtopic/a-darkmode-probe.mjs            # 24 passed
node .probe/darkmode-subtopic/b-library-migration-probe.mjs                       # 20 passed
node .probe/darkmode-subtopic/c-subtopic-scope-probe.mjs                          # 23 passed
node .probe/darkmode-subtopic/d-dsh-theme-probe.mjs                               # 21 passed
node .probe/darkmode-subtopic/e-filter-mechanics-probe.mjs                        # 16 passed
node .probe/darkmode-subtopic/f-real-pdf-darkmode-probe.mjs                       # 24 passed
```

| 脚本 | 证明什么 |
|---|---|
| `a-` | 基线读者**不含**任何 `filter/invert/prefers-color-scheme/dark` 逻辑（6 条）+ 层序不变量 + 用真实读者脚本证明几何/命中与滤镜无关 |
| `b-` | 迁移规划器：干跑幂等 / 精确 stem 不吞前缀 / 子专题分别规划 / 孤儿不动 / **复跑不二次嵌套** / 回滚回原状 / 父专题改名使 `sessionId` 脱钩（字节级） |
| `c-` | 子目录下的非递归 rmdir 不变量 + 18 条穿越矩阵 + localStorage 键前缀歧义 + 上下文体积实测 + **基线「清空专题」只遍历本层**（= 本批唯一扩展点） |
| `d-` | dsh 主题接口（安装目录的 d.ts 与打包 CSS）+ 真实 Chromium 四条读取通道 + `storage` 事件跨文档同步 |
| `e-` | CSS 滤镜不动几何/选区/后备像素；屏幕取色与强度曲线（4 档） |
| `f-` | **真实论文**上 before/after：文字层 186/244 个 span 的文本与定位不变、热区盒不变、截图取色 `[255,255,255]→[6,6,6]` |

> `c-` 里有一段**自识别断言**：优先用本机安装构建 `~/.dsh/local/dsh-paper-reader/dist/library-manage.js`
> 并断言它含 `planTopicClear`/`clearTopic`。因为实测发现**仓库 `dist/` 里残留旧构建**
> （`planTopicClear === undefined`，25071 B），拿它跑会得出"基线没有清空功能"的**假结论**。
> 实现方/验证方都要靠这一条防止"拿错构建"（见风险 R21）。

### 0.3 行号地图（基线 `ec21969` vs 当前工作树 HEAD）

本方案**所有 `file:line` 都按基线 `ec21969` 给出**（§0.1）。当前工作树是 divergent 的另一条线
（`feat/selection-translate`，1.6.0），行号整体下移，对照表如下（改代码时**以基线为准**）：

| 代码点 | 基线 `ec21969` | 工作树 HEAD |
|---|---|---|
| `src/library.ts` `refFor` | `:84-96` | `:81-93` |
| `src/library.ts` `listPapers` / `listTopics` / `resolvePaper` | `:69-82` / `:60-66` / `:104-126` | `:66-79` / `:57-63` / `:101-123` |
| `src/library.ts` 上传专题解析 `resolveUploadTopic` | `:229`（基线**独有**） | — |
| `src/library-manage.ts` `validateName` / `validateEntryBoundary` / `validateNewPaperName` | `:79` / `:98` / `:114` | `:58` / `:82` / `:97` |
| `src/library-manage.ts` `resolveTopicDirChecked` | `:152-168` | `:126-142` |
| `src/library-manage.ts` `matchArtifactName` / `listArtifacts` | `:209-216` / `:231-249` | `:183-190` / `:205-223` |
| `src/library-manage.ts` `moveToTrash` | `:351-405` | `:296-315` |
| `src/library-manage.ts` `deleteTopic` 的 `rmdirSync` | `:560` | `:470` |
| `src/library-manage.ts` `planTopicClear` / `clearTopic` | `:602-628` / `:653-709`（基线**独有**） | — |
| `src/host.ts` `sessionPrefixFor` / `withInflight` / `requireSessionClear` | `:217` / `:383` / `:354` | `:195` / `:342` / `:313` |
| `src/host.ts` `/api/library` / `upload` / `topic` | `:490` / `:518-569` / `:499` | `:442` / `:470-521` / `:451` |
| `src/host.ts` `/api/library/topic/clear-plan` / `clear` | `:769` / `:811`（基线**独有**） | — |
| `src/host.ts` `/api/ask` | `:1368-1418` | `:1215-1265` |
| `reader/index.html` `:root` / `.page` / `.textLayer` / `.eqLayer` / `#eq-panel` | `:17` / `:81` / `:86` / `:116` / `:120` | `:12` / `:69` / `:74` / `:104` / `:108` |
| `reader/index.html` `paintPage` / `paintEqLayer` / `eqGeom` / `hitTestFormula` | `:775` / `:1164` / `:1142` / `:1201` | `:723` / `:1097` / `:1075` / `:1134` |
| `reader/index.html` `bootstrap` | `:2250` | `:1878` |
| `lib/client.js` `SettingsPanel` / `inject` / iframe `src` | `:1490` / `:1615` / `:472` | `:1306` / `:1425` / `:387` |
| 测试文件数 | **33** 个（含 `library-clear-and-busy` / `library-traversal-verification` / `reader-render-guard` / `windows-esm-guard` …） | 20 个 |

> **只改代码不许改行为**：基线还多出一批**工作树没有的测试**
> （`library-clear-and-busy.test.mjs`、`library-topic-symmetry.test.mjs`、`library-traversal-verification.test.mjs`、
> `library-symmetry.test.mjs`、`library-input-validation.test.mjs`、`reader-render-guard.test.mjs` 等）。
> 实现方必须以**基线**的测试套件为准（`npm test` 在基线上跑），否则"工作树绿"不代表基线绿。

# 第 A 部分：深色模式

## A1. 调研：其他开源 PDF 阅读器怎么做深色

> 说明：本机出网只允许搜索通道（`curl`/`web_fetch` 对 GitHub 与 raw 域名均失败，见 §0.1），
> 因此**逐行源码引用受限**；下表把「能引到的一手来源（仓库/官方文档/commit/bug）」全部给出，
> 并对**没能拿到一手源码**的项目明确标注**【二手】**，实现方不得把二手结论当已证实事实。

### A1.1 逐家对照

| # | 项目 | ① 反转 vs 重渲染 | ② 技术手段 | ③ 图片/图表处理 | ④ 模式/强度 | ⑤ 已知副作用与踩坑 | 来源 |
|---|---|---|---|---|---|---|---|
| 1 | **pdf.js 官方 viewer** | **重渲染配色**（不是像素反转）。渲染时传 `pageColors`，由 pdf.js 用「页面主色统计」推出前景/背景色后再绘制 | `pageColors: { background, foreground }` 传给 `getDocument`；渲染路径里按主色替换；`render({ background, intent })` 另有背景/意图项。**官方 viewer 至今没有「整页反转」开关** | 重渲染路线天然避免图片变负片（图片照常绘制）；`pageColors` 对"前景==背景"的页面有专门保护 | 三档来源：高对比模式 / 用户设置 / 程序传入；配 `forcePageColors` 可强制。**没有强度滑杆** | 白闪：`forcePageColors=true` + 深色主题下滚动会闪白（issue #18680）；`pageColors` 前景背景相同时必须忽略（commit 472a1f9） | 【一手来源】[pdf.js commit d7fd510「Improve pdf reading in high contrast mode」](https://github.com/mozilla/pdf.js/commit/d7fd510a755970fe31a86aa84dbeaa228f4c1ee3)、[commit cfac6fa（colors PR 合并）](https://github.com/mozilla/pdf.js/commit/cfac6fa511945ae5b75d3c27a9356527862a7bf6)、[commit 472a1f9「Ignore pageColors when bg/fg identical」](https://github.com/mozilla/pdf.js/commit/472a1f9c91650448e2f3a5bdb235972e505774e6)、[issue #18680 白闪](https://github.com/mozilla/pdf.js/issues/18680) |
| 2 | **Firefox 内置 PDF 阅读器** | 同 pdf.js 内核，但 Firefox 有**独立暗色渲染路径**：由 `pdfjs.*` 偏好 + 主题驱动 | Firefox 侧偏好（`PdfJsDefaultPreferences`）里与配色相关的有 `pdfjs.viewerCssTheme`（**只影响阅读器 UI chrome**）与 `pdfjs.forcePageColors`（**才影响页面内容**）。两者常被用户混淆 | 同 pdf.js：重渲染，图片不当负片 | `viewerCssTheme`：0 跟随系统 / 1 亮 / 2 暗；`forcePageColors` 跟随系统高对比。**无强度** | 用户反复报告「设了 dark 还是白的」——因为设的是 `viewerCssTheme` 而不是 `forcePageColors`；另有「pdfjs.viewerCssTheme option has no effect」（版本内 build 开关） | 【一手来源】[searchfox: PdfJsDefaultPreferences.jsm](https://searchfox.org/mozilla-central/rev/ffb50da3ca89100b6ae5054cfe69c187679515f0/toolkit/components/pdfjs/content/PdfJsDefaultPreferences.jsm#24)（新版本已改 `.sys.mjs`）；【二手】[Mozilla 支持帖：viewerCssTheme 无效](https://support.mozilla.org/bs/questions/1403551/feed)、[Firefox PDF 深色模式失效](https://support.mozilla.org/ml/questions/1434510/feed) |
| 3 | **Zotero**（内置 pdf.js 阅读器） | 目标同样是"阅读内容明暗主题"；社区长期诉求是一个**能按内容而非按 UI** 切换的开关 | 见 ⚠️ 未取证 | 见 ⚠️ 未取证 | 议题标题即「Light and dark themes for **reader content**」（即 UI 主题与内容主题分开） | — | 【一手来源（议题）】[zotero/zotero#4949「Light and dark themes for reader content」](https://github.com/zotero/zotero/issues/4949) |
| 4 | **Calibre**（电子书阅读器，非 PDF 专用） | 反转（自带「invert」概念） | 阅读器配置里有独立的**反转图像**开关（invert images），即"整体反转 + 图片二次反转"这一经典两段式 | **有独立开关**：反转内容的同时可选择不反转图片（避免照片变负片） | 有开关，无强度 | 仅覆盖 EPUB/HTML 类；PDF 走另一套（calibre 的 PDF 查看是外部查看器） | 【一手来源（议题）】[janeczku/calibre-web#2836「dark mode in in-browser pdf reader」](https://github.com/janeczku/calibre-web/issues/2836)（⚠️ calibre-web ≠ calibre 本体，实现方要区分；calibre 本体源码未取得 →**【二手】**） |
| 5 | **Okular** | **可选的"反转"家族**，且**不止一种反转** | 无障碍设置里是 **Render mode 下拉**：Normal / **Invert colors** / **Invert lightness** / **Invert luma** / **Hue shift** / **Change paper color** / **Change dark & light colors**；`Invert Lightness/Luma` 与 `Hue Shift` 是后续 MR 加的。像素级实现（`QImage` 反转系） | 反转族会把图片一起反；`Change paper color` / `Change dark & light colors` 走**颜色替换**而不是整体反转，对图片更温和 | **最丰富**：模式 + 纸张色 + 暗/亮色自定义 | 反转图片是长期抱怨点；`Invert lightness` 与 `Invert colors` 语义不同（前者保色相、只反亮度）——这正是我们 `hue-rotate` 那一步想达到的效果 | 【一手来源】[KDE 官方文档 Okular Accessibility](https://docs.kde.org/stable_kf6/en/okular/okular/configaccessibility.html)、[Okular MR !144「Add some color modes: Invert Lightness/Luma, Hue Shift」](https://invent.kde.org/graphics/okular/-/merge_requests/144/pipelines)；【二手】[KDE bug 428840](https://bugs.kde.org/show_bug.cgi?id=428840)、[KDE bug 431372](https://bugs.kde.org/show_bug.cgi?id=431372) |
| 6 | **SumatraPDF** | **反转**（设置项 `InvertColors` / `-invert-colors` CLI，另有 `FixDocumentColors`） | 应用层对渲染出的位图做反转（像素路径，不是 CSS）。主题（Darker/Light）与文档反转是**两件事**，可分别设置 | 有 `FixDocumentColors`（修正文档配色）用于在反转后把图片/配色拉回；用户反馈"Light 主题会把文档反成全黑，Darker 不会"说明反转与主题是耦合的 | 有（主题 + 反转 + 自定义配色）；无强度滑杆 | 「Invert Color 在 Dark/Darker 主题下不尊重自定义配色」（issue #4073）；「Darker 主题不把文档反成纯黑而 Light 会」（discussion #4668）——说明反转策略与主题绑定时行为难预测 | 【一手来源】[官方文档 Customize theme colors](https://www.sumatrapdfreader.org/docs/Customize-theme-colors)、[官方 settings 索引（3.5.1）](https://www.sumatrapdfreader.org/settings/settings3-5-1)、[官方 FAQ](https://www.sumatrapdfreader.org/docs/FAQ)；【一手来源（issue）】[#4073](https://github.com/sumatrapdfreader/sumatrapdf/issues/4073)、[discussion #4668](https://github.com/sumatrapdfreader/sumatrapdf/discussions/4668) |
| 7 | **Sioyek** | **反转**（基于 PDF 原页位图），并配有"背景色/强制白底"一组设置 | 自绘渲染器 + 位图反转；配置项通过 `prefs.config` 暴露 | ⚠️ **已知未解决**：切深色时**图片颜色也被反转**（issue #171、#620 两次报同一问题）——这是"整页反转不做图片识别"路线的真实代价 | 有背景色/前景色类设置；无强度滑杆 | 图片变负片；深色下图片观感差 | 【一手来源（配置）】[Debian sources: sioyek `pdf_viewer/prefs.config`](https://sources.debian.org/data/main/s/sioyek/2.0.0%2bdfsg-3/pdf_viewer/prefs.config)；【一手来源（议题）】[ahrm/sioyek#171](https://github.com/ahrm/sioyek/issues/171)、[ahrm/sioyek#620](https://github.com/ahrm/sioyek/issues/620)；【一手来源（文档）】[Sioyek Documentation](https://sioyek-documentation.readthedocs.io/en/latest/) |
| 8 | **CSS `filter: invert(1) hue-rotate(180deg)` 这一招本身** | 纯 CSS 滤镜（浏览器合成阶段） | 位图整体反转后 `hue-rotate` 把色相转回来；**对图片必须再来一次反转**才不变负片（常见做法：给 `img` 再套一层 `invert(1) hue-rotate(180deg)`） | 依赖"二次反转"；纯 CSS 方案无法自动识别"这块是不是照片" | 无（靠 CSS 变量自造） | 颜色失真（深色块被提亮成粉彩）、无法区分照片与图表、`filter` 会创建包含块/层叠上下文 | 【二手/经验】本条是通识做法；**本方案给出的数值全部是本机实测**（见 §A2.2），不依赖二手描述 |

### A1.2 从调研里提炼出的四条路线（给我们的选择空间）

| 路线 | 谁在用 | 我们能不能用 | 判定 |
|---|---|---|---|
| **R1 CSS 滤镜**（`invert+hue-rotate`，挂 canvas） | 通用 CSS 技巧；很多阅读器/浏览器扩展 | ✅ 能 | **推荐**（见 §A2） |
| **R2 像素重写**（`getImageData` 改像素后回写） | Okular / SumatraPDF 的 C++ 位图路径 | ⚠️ 能但**不建议** | 成本高：每页 W×H 循环、大页卡顿；且我们**当前完全没有** `getImageData`（a-probe A2 断言），引入像素读取会把渲染变成同步阻塞 |
| **R3 重渲染配色**（pdf.js `pageColors`） | pdf.js 官方 viewer / Firefox 内容路径 | ⚠️ 能但**不建议** | 会与既有渲染管线冲突（见 §A2.1 的取舍分析），且强度不可调 |
| **R4 只换 UI token**（不碰页面内容） | Firefox `pdfjs.viewerCssTheme` | ❌ 不满足需求 | 用户要的是"PDF 也变深色"，只改 chrome 不够 |

## A2. 我们的深色实现（冻结）

### A2.1 路线决策与取舍（为什么是 R1）

**决策：在**每页的 `<canvas>` 元素**上打 CSS 滤镜，`.page` 单独换深色底。**
滤镜表达式冻结为：

```css
/* 阅读器内部（reader/index.html 的 <style> 末尾新增） */
html[data-dpr-pdf="dark"] #pdf-pages .page > canvas,
html[data-dpr-pdf="dark"] #pdf-pages-zh .page > canvas {
  filter: invert(1) hue-rotate(180deg)
          brightness(var(--dpr-dark-b, 0.92)) contrast(var(--dpr-dark-c, 0.95));
}
html[data-dpr-pdf="dark"] .page { background: #1b1b1c; box-shadow: none; }
```

> ⚠️ 必须挂在 `canvas` 上、**不是** `.page` 上：挂 `.page` 会把 `.eqLayer` 的热区描边与
> `::selection` 一起反转（热区框变怪色、选中高亮从蓝变橙）。挂 `canvas` 时文本层/热区层/浮层颜色全部不受影响。

为什么不选 R3（pdf.js `pageColors`）——三条硬理由，逐条给依据：

1. **会与既有渲染管线打架**：我们的位图渲染在 `paintPage()`（`reader/index.html:775-797`），它同时负责
   canvas 位图、`pdf.js TextLayer`、以及**公式热区层**（`paintEqLayer`，唯一铺层点，被
   `test/merge-verify-t3.test.mjs` 的 `checkSolePaintPoint` 钉死）。R3 要求"先统计页面主色 → 再渲染"，
   等于把 `page.render()` 改成两步或两遍，直接踩这条被断言守护的调用签名。
2. **强度不可调**：`pageColors` 只有前景/背景两个色值，用户要的"可在设置中调整"没法只靠它表达。
3. **图省不掉图片问题**：论文里图/表是主要内容，R3 也会把图片按主色重算（pdf.js 只保证"不因前景==背景而消失"），
   实测我们的语料两张图就占 9.5 MiB PDF；R3 反而更难解释"为什么图变了"。

选 R1 的**实测支撑**（`.probe/darkmode-subtopic/e-filter-mechanics-probe.mjs`，16 passed）：

- 滤镜前后 `getBoundingClientRect` 对 `.page` / 文本层 `span` / 选区 `Range` / 热区 `.eq-box` **逐字节相同**；
- canvas 的 **CSS 尺寸不变**、**后备像素不变**（`getImageData` 仍读到原始白 `[255,255,255]`、红 `[221,51,51]`）；
- `elementFromPoint` 命中元素不变（点击/拖选仍落在 textLayer 上）；
- 屏幕呈现确实变了：白底 `[255,255,255] → [6,6,6]`；红色块 `[221,51,51] → [229,121,121]`（**仍是红**）、
  蓝色块 `[0,51,102] → [153,197,229]`（**仍是蓝**）——`hue-rotate(180deg)` 正是为此。

强度旋钮的**实测曲线**（这条反直觉，决定设置项怎么设计）：

| brightness / contrast | 屏幕上的"白底"取值 | 说明 |
|---|---|---|
| 1 / 1 | `[0,0,0]` | 纯黑页面 |
| **0.92 / 0.95**（默认） | `[6,6,6]` | 近黑，不刺眼 |
| 0.85 / 0.9 | `[13,13,13]` | |
| 0.8 / 0.85 | `[19,19,19]` | 偏灰的纸感 |

`contrast<1` 会以 0.5 为轴把纯黑往灰抬（`0 → 19`），所以"页面黑到什么程度"主要由 **brightness 项的实际取值** 决定。
实现**不要**把两个滑杆理解成"越小越暗"——按上表标定，或直接提供 4 个预设档（近黑/柔和/纸感/关），滑杆留给高级用户。

### A2.2 dsh 主题怎么读（这部分是实测事实，不是猜）

**dsh 暴露了什么（【一手来源】，来自本机 dsh 安装目录）：**

- `@deepseek-ai/dsh-client-ui-layout/lib/types/client/theme-presenter.d.ts`：
  `DARK_ATTRIBUTE = "data-ds-dark-theme"`（**body** 上的调色板开关）、
  `THEME_SOURCE_ATTRIBUTE = "data-ds-theme-source"`（**html** 上的来源，取值 `light|dark|system`）、
  `ThemePresenter.apply()` 还把 `color-scheme` 写到 **html**、把 `--dsh-content-font-size` 写到 body。
- `@deepseek-ai/dsh-client-ui-theme/lib/client.js:1148` 同时打包了两套 token 表：
  `body{--dsw-alias-…}` 与 `body[data-ds-dark-theme]{--dsw-alias-…}`（例如深色下
  `--dsw-alias-bg-base: var(--dsw-static-neutral-bluish-950)`）。
- 偏好取值域是 `light | dark | system` 三档，`system` 由 dsh 自己解析成 light/dark
  （`dsh-client-ui-theme/lib/types/theme-settings.d.ts`）。
- **给插件用的官方接口**（`dsh-client-ui-theme/lib/types/client/index.d.ts`）：
  `ctx.theme.getTheme(): ThemeSnapshot`（快照里 `active.colorScheme` 已是解析后的 `'light'|'dark'`）、
  事件 `ctx.on('theme/change', (snap) => …)`。

**阅读器（iframe）能拿到什么（【实测】，真实 Chromium，见 `d-dsh-theme-probe.mjs`）：**

| 通道 | 实测结果 |
|---|---|
| 同源 `parent.document` | ✅ 可读（`iframeParentReadOk: true`）—— ①② 两条路可行 |
| iframe 自己继承 CSS 变量 `--dsw-*` | ❌ **不继承**（跨文档不继承，实测读回空串） |
| iframe 自己继承 `data-ds-dark-theme` 属性 | ❌ 不继承（`innerBodyAttr: false`） |
| iframe 自己的 `matchMedia('(prefers-color-scheme:dark)')` | ⚠️ 只有 **OS/Chromium 级**才跟随；宿主亮/暗**不会**改它 |
| 设置面板改 `localStorage` → 阅读器 iframe 收到 `storage` 事件 | ✅ 可收到（跨文档同步**有**现成机制，不用轮询） |

**冻结的读取优先级（实现必须逐档完成，禁止跳档、禁止"猜"）：**

```
用户设置 pdfTheme（'off' | 'follow' | 'light' | 'dark'，默认 'follow'，落盘持久化）
  ↓ pdfTheme 为 off/light/dark → 直接定论
  ↓ 为 follow 时按序探测：
  ① 同源宿主 document.body.hasAttribute('data-ds-dark-theme')      ← dsh ThemePresenter 写的，最权威
  ② 同源宿主 document.documentElement.getAttribute('data-ds-theme-source') === 'dark' | 'light'
  ③ 阅读器自身 matchMedia('(prefers-color-scheme: dark)').matches
  ④ 以上全失败（跨源/沙箱限制/属性都没写） ⇒ **判亮色**
```

- 跨文档访问抛异常（`SecurityError`）⇒ 视为 ①② 不可用，**不得**冒泡给用户；降级到 ③④。
- **失效回退方向必须朝亮色**：宁可"该黑没黑"，绝不"该白被弄黑"（后者会让用户以为文件坏了）。

**实装方式（两条，建议都做，成本都很低）：**

1. **宿主侧（权威）**：`lib/client.js` 的 `inject` 列表加上 `'theme'`，用 `ctx.theme.getTheme().active.colorScheme`
   与 `ctx.on('theme/change', …)`，把结果通过阅读器 iframe 的 `src` 查询参数 **和**
   `postMessage` 两条路传给阅读器（iframe 元素已由 `ReaderOverlay` 常驻持有，见 `lib/client.js:461-479`）。
   同时在 iframe 元素上写一个 `data-dpr-theme="dark|light"` 属性——**同源 iframe 的 CSS 不能跨文档取父文档属性**，
   但阅读器 JS 读 `parent.document` 时能读到自己的 iframe 元素，等价。推荐用 `postMessage`（无轮询、无竞态）。
2. **阅读器侧（自足，兜底）**：按上面的优先级自己探测，并对 `parent.document` 的 `body`/`html` 挂
   `MutationObserver`（监听 `data-ds-dark-theme` / `data-ds-theme-source` 的变化），外加
   `window.addEventListener('storage', …)` 接设置面板的改动。**首次判定完成前**给 `#pdf-pages` 一个
   `visibility:hidden`，避免"白闪一下再变黑"（Firefox/pdf.js 的 #18680 就是这类闪白的公开案例）。

### A2.2b 真机证据：真实论文上的 before/after（最硬的一层）

脚本：`.probe/darkmode-subtopic/f-real-pdf-darkmode-probe.mjs`（**24 passed / 0 failed**）。

```bash
node .probe/darkmode-subtopic/f-real-pdf-darkmode-probe.mjs     # 期望 24 passed
```

**真实文献库只读**：脚本只 `copyFileSync` 出原文 PDF 到 `evidence/pdf-copy/paper.pdf`
（实测取样：`~/.dsh-paper-reader/data/默认专题/Dong et al. - 2026 - … .pdf`，19 页），
把 `reader/vendor/pdf.min.mjs` 一并复制，再用**临时本地 HTTP 服务**（不是 `file://` —— ES module 在
`file://` 下被 CORS 拦，实测第一次跑就卡在这里）加载一个 200 行 harness，
用**同一份 pdf.js 6.x + 同一套 textLayer CSS 子集**渲染真实论文第 1、4 页（scale 1.6）。
`DPR_PDF=<path>` 可换样本；`DPR_DATA` 可换库根。

| 断言（对应验收项） | 实测值 |
|---|---|
| 页面自身布局盒不变（A8） | `{top:51, height:1274, width:979}` 深色前后**逐字节相同** |
| `#pdf-pane` 滚动高度不变（滤镜不产生回流） | `1306 → 1306` |
| canvas CSS 尺寸不变 | `979.188×1267.19px → 979.188×1267.19px` |
| canvas **后备像素**不变（A11 的前提） | `[255,255,255] → [255,255,255]`（`getImageData` 读到原值） |
| 文字层 span 数 | p1 `186` / p4 `244`，深色前后一致 |
| 全 span「文本+left+top+fontSize」摘要哈希 | p1 `-934783938`、p4 `564790293`，**逐字节相同** |
| 首个 span 的文本/left/top/offsetW-H/`--scale-x` | p4：`"partition the dataset as follows: a training set contain-"`、`51.51%`、`29.41%`、`375×16`、`0.96941543658281` —— 全部不变 |
| 编程式 Range 选区文本（A8 的选区项） | p4：`"partition the dataset as follo…"` 深色前后相同且非空 |
| 3 个公式热区盒 `.eq-box`（A9/A10） | `style.left/top/width/height` 与 `offsetWidth/Height` 全部不变 |
| `elementFromPoint` 命中 | 仍落在 `textLayer` 内的 `SPAN` 上 |

**屏幕取色（sharp 直读 PNG，不是肉眼）**：

| 截图 | 角落 | 中部 | 页外底色 |
|---|---|---|---|
| `real-p1-light.png` | `[255,255,255]` | `[240,240,240]` | `[246,247,249]` |
| `real-p1-dark.png` | **`[6,6,6]`** | `[19,19,19]` | `[21,21,23]` |
| `real-p4-light.png` | `[255,255,255]` | `[212,212,212]` | `[246,247,249]` |
| `real-p4-dark.png` | **`[6,6,6]`** | `[44,44,44]` | `[21,21,23]` |

真实 PDF 上的 `[6,6,6]` 与 §A2.1 用合成夹具测出的默认档（brightness .92 / contrast .95）**完全一致**
⇒ 强度曲线可以照搬，不必重新标定。

**拼图（可直接给用户看）**：`evidence/real-p1-side-by-side.png`、`evidence/real-p4-side-by-side.png`
（左=关深色，右=开深色，同页同缩放）。图像内容核对：

- 正文/标题/脚注/DOI 链接/`1 Introduction`/加粗/等宽代码全部可读，**无发虚、无缺字**；
- 该论文模板**原本就是浅紫底** ⇒ 深色下变深灰（`hue-rotate` 保住了"非纯白"的色相）；
- 紫色标题与链接在深色下仍偏紫（**色相族被保住**），不是 OpenSource 里常见的"红变青"；
- 图片/表格被整体反转为负片（真实代价，见风险 R14）；本语料的论文图偏线稿/示意，观感可接受。

> **实测 vs 推测**：上表全部**实测**。**推测（未验证）**：连续色调**彩色照片**类插图在深色下的观感
> 未被本次取样覆盖（第 1/4 页没有照片）⇒ 必须由实现方部署后由用户实测（§D.1 的 A3）。

### A2.3 设置项（形态、默认值、持久化）

**冻结的设置 schema**（默认值全部标注，持久化位置写清）：

| 键 | 取值 | 默认 | 落盘位置 | 说明 |
|---|---|---|---|---|
| `pdfTheme` | `'follow'` \| `'off'` \| `'light'` \| `'dark'` | **`'follow'`** | 插件配置文件（与 `translate`/`embed`/`mineru` 同一套：`GET/POST/DELETE /paper-reader/api/theme/config`）**+** 阅读器 `localStorage['dpr.pdfTheme']` 镜像 | `follow`=跟随 dsh（用户原话「dsh 为深色时把 PDF 也变深色」⇒ 默认必须是 follow）；`off`=永不变深；`light`/`dark`=强制 |
| `pdfDarkStrength` | `0 \| 1 \| 2 \| 3`（对应 brightness/contrast 预设 `1/1`、`0.92/0.95`、`0.85/0.9`、`0.8/0.85`） | **`1`**（近黑 `[6,6,6]`） | 同上 | 给"可在设置中调整"一个不用理解 CSS 的旋钮 |
| `pdfDarkAdvanced` | `{ brightness: 0.5–1, contrast: 0.5–1 }` | 未设（用档位） | 同上 | 高级滑杆；`--dpr-dark-b/-c` 写入阅读器根元素 |
| `pdfDarkChrome` | `boolean` | **`true`** | 同上 | 深色时是否把阅读器自身 UI（顶栏/面板/气泡）也切深色（覆写 `:root` 调色板 + `color-scheme: dark`） |

**UI 落点（两处，同一个后端配置，禁止各存一份）：**

1. **dsh 设置面板**：新增一张卡片 `ThemeCard`，放在 `SettingsPanel()`（`lib/client.js:1490-1506`）里，
   与 `EndpointCard` / `MineruCard` 同级；用 `select` + 档位单选 + 一个开关，样式复用 `SET.card` / `SET.label` / `SET.input`。
2. **阅读器 `⚙` 浮层**：`#cfg-pop`（`reader/index.html:250` 起，控制器 `openCfgPop` 在 `:633`）已经有一套表单模式，追加同样的控件。
   **理由**：用户正在阅读器里读 PDF，不该为了"太刺眼"跑回设置页；两处读同一个后端配置，用
   `storage`/`postMessage` 同步（实测可同步）。

**i18n**：`zh`/`en` 两份文案都要加（`lib/client.js:24-130` 是两套词典，`NS = 'dsh-paper-reader'`），
键名建议 `setThemeTitle / setThemeDesc / setThemeMode / setThemeModeFollow / setThemeModeOff /
setThemeModeLight / setThemeModeDark / setThemeStrength / setThemeStrength1..4 / setThemeChrome`，
并在 `lib/client.js:1618` 的 `ctx.locale.register(NS, { zh, en })` 之前补全（现有测试会做中英键对齐断言）。

### A2.4 实现路径（逐个改动点 + 顺序）

| 步 | 文件:行（现状锚点） | 改动 | 完成判据 |
|---|---|---|---|
| A-1 | `src/theme-config.ts`（**新建**，仿 `src/embed-config.ts` / `src/mineru-config.ts`） | 配置读写 + 掩码 + 默认值 + schema 校验 | 单测：非法值回落默认 |
| A-2 | `src/host.ts:1057-1153` 附近（配置路由簇） | 新增 `GET/POST/DELETE /api/theme/config` | curl 三连通过 |
| A-3 | `src/tools.ts` 的 `definitions`（约 `:40-120`） | 不动 | — |
| A-4 | `lib/client.js:1490-1506` | 加 `ThemeCard`；`inject` 列表加 `'theme'`；`ctx.on('theme/change')` 推 `postMessage` 到 iframe | 面板可改、可存、可清 |
| A-5 | `lib/client.js:461-479`（iframe 元素） | 传 `data-dpr-theme` + `postMessage({type:'dpr:theme'})` | 阅读器收到 |
| A-6 | `reader/index.html:16-180`（`<style>`） | 新增 `:root` 深色调色板块 + §A2.1 的滤镜规则（挂 `canvas`） | 目视 + 截图取色 |
| A-7 | `reader/index.html:2250-2276`（`bootstrap`） | 首帧前解析主题并 `document.documentElement.dataset.dprPdf = 'dark'\|'light'` | 无白闪 |
| A-8 | `reader/index.html:250` 起（`#cfg-pop` 浮层，控制器在 `openCfgPop`，`:633`） | 追加主题控件（与 `translate/config` 同一浮层，或新开一个） | 阅读器内可调 |
| A-9 | `reader/index.html:186`（`#pdf-path`）与 `:195`（`#dl-btn`）之间 | 顶栏加一个 `A` 按钮（快速切 关/跟随/强制），`title` 说明当前来源 | 一键切 |

**不许动的地方（会被既有断言打）：**

- `paintPage` 的调用签名与 `paintEqLayer(div, viewport, +div.dataset.page)` 三参数形式（`reader/index.html:796`，
  被 `test/merge-verify-t3.test.mjs` 的 `checkSolePaintPoint` 钉住）；
- `.textLayer` / `.textLayer span` 的定位与 `--scale-factor` 计算（`reader/index.html:86-107`）；
- `eqGeom` / `hitTestFormula` 的坐标口径（`reader/index.html:1142-1230`）。

### A2.5 风险与验收（深色部分）

| 风险 | 触发条件 | 后果 | 缓解 |
|---|---|---|---|
| 白闪 | 主题判定晚于首帧渲染 | 打开 PDF 先白后黑 | A-7：判定完成前 `visibility:hidden`；判定本身是同步读属性，无需网络 |
| 照片变负片 | 论文里有照片 | 图看着像 X 光片 | **接受**（与 Sioyek #171/#620 同源限制）；在设置项文案里写明；`pdfTheme=off` 一键绕过 |
| 图表色偏 | 深色块被提亮成粉彩 | 图例颜色辨识度下降 | 实测已量化（§A2.1 曲线）；提供 `pdfDarkStrength=0`（brightness/contrast=1/1）以保真优先 |
| 跨源/沙箱导致读不到宿主属性 | 未来宿主改协议 | 深色不生效 | 降级链 ③④；**朝亮色回退**，绝不误黑 |
| 深色下 UI chrome 对比不足 | `pdfDarkChrome=true` 但 token 映射错 | 顶栏看不清 | 只覆写 `:root` 的**自有变量**（`--bg/--panel/--border/--text/--text-2`），不碰 `--dsw-*`；对每个覆写值做对比度断言 |
| 用户以为导出也被改暗 | — | 投诉 | 导出走服务端字节流（`reader/index.html:405-415` + `src/host.ts:1003-1024`），**本来就与客户端滤镜无关**；在 UI 文案里说明"下载的是原文" |

**验收清单（A 段）**：见 §D 的 A1–A12。

---

# 第 B 部分：文献库结构改造

## B1. ① 按论文分文件夹 + 对现有库的迁移

### B1.1 精确的新布局（冻结）

```
<dataDir>/                                  = ~/.dsh-paper-reader/data（可用 DSH_PAPER_READER_DATA 覆盖，src/library.ts:52-57）
├── .trash/                                 回收站（保留名，src/library-manage.ts:70）
│   └── <UTC时间戳>-<6位hex>/
│       ├── manifest.json
│       └── <按原相对路径嵌套的条目>
├── <专题>/
│   ├── <子专题>/                            ← 任意层（§B2）
│   │   └── <论文名>/                        ← 论文文件夹（新增）
│   │       ├── <论文名>.pdf
│   │       ├── <论文名>-en.pdf / -zh.pdf / -dual.pdf
│   │       ├── <论文名>.txt
│   │       ├── <论文名>.pages.json
│   │       ├── <论文名>.transcript.json
│   │       ├── <论文名>.mineru.md
│   │       ├── <论文名>.mineru.json
│   │       ├── <论文名>.embeddings.json
│   │       └── <论文名>.study.json
│   └── <论文名>/                            ← 同上
└── <孤儿文件>（既不匹配任何论文 stem，也不是目录）→ **原地不动**
```

**命名规则（逐条冻结）**：

1. 论文文件夹名 = **论文名本身**（= `<stem>`，就是今天 `<stem>.pdf` 去掉 `.pdf`），不做任何转义/替换。
   理由：`validateName` 已保证不含 `/ \ .. 空字符`、不以 `.` 开头、`basename(raw)===raw`（`src/library-manage.ts:79-97`），
   所以它可以安全地当目录名。
2. 文件夹内文件名 = **保持今天的文件名原样**（`<论文名><后缀>`）。这样 `src/library.ts` 的
   `refFor()`（`:81-93`）只需要换一个 base 推导规则，**所有下游路径消费者自动跟着走**。
3. 「一个目录要么是专题、要么是论文」是**结构不变量**：论文文件夹内**不再嵌套**论文文件夹。
   判定规则：目录内存在 `<目录名>.pdf` ⇒ 该目录是**论文目录**，遍历到此为止。
4. 变体 `-en/-zh/-dual.pdf` 与所有 sidecar **随论文一起**进同一个文件夹（它们今天就是 `<stem><后缀>`，
   规则 2 自然覆盖）。
5. **不新增任何元数据文件**。层级完全由目录结构表达；`study.json` 保持论文内（这样"改论文名"仍然是
   一个文件夹的 rename）。

### B1.2 迁移方案（冻结；幂等 / 可中断 / 可复跑 / 零丢失 / 可回滚）

> ⚠️ **本节流程是实测过的**：`.probe/darkmode-subtopic/b-library-migration-probe.mjs` 里我第一版规划器
> **在"复跑"这一步就炸了**（见下 P8 那句 `FAIL 复跑安全：第二次规划为空 moves`）：因为它递归进了刚建好的
> `A/P1/`，把 `A/P1/P1.pdf` 当成一篇新论文 `P1`，于是第二次迁移产出 `A/P1/P1/P1.pdf` 并把日志翻倍。
> 修复就是 §B1.1 规则 3 的**论文目录不递归**不变量。**实现方必须把这条写成断言，而不是靠自觉。**

**迁移算法（每篇论文一个原子单元，三个阶段，全部可中断）：**

```
阶段 0  预检（只读，绝不写）
  0.1 遍历全部专题目录；按 §B1.1 规则 3 判定论文目录并**停止递归**
  0.2 为每个平铺论文 <stem> 收集 matchArtifactName(stem, entry) 命中的文件（精确匹配，沿用 src/library-manage.ts:209-216）
  0.3 产出 6 类清单：moves / orphans / conflicts / quarantine / hidden / already-done
  0.4 逐条校验：目标目录名是否被非目录占据（conflict）、源文件是否常规文件（软链接单独处置）、
      剩余磁盘空间 ≥ 需要复制的总字节 × 1.2
  0.5 输出人类可读报告 + 机器可读 JSON（dry-run 的交付物）

阶段 1  执行（只用 copy，绝不先删）
  1.1 对每篇论文：mkdir <stem>/ → 逐个 copyFile → 立即 stat 比对 size（可选 sha256）→
      每条 move 落一条日志（追加写 .migration-log.json，每步 fsync）
  1.2 任一条失败：**停止，不删任何源**，报告 {done[], remaining[]}
  1.3 **可中断**：进程被杀 ⇒ 源文件完好无损（因为阶段 1 只复制），日志里记着已复制项

阶段 2  收尾（全部论文校验通过后才做）
  2.1 删除已被复制且 size/hash 与日志一致的源文件
  2.2 自底向上 rmdir 空目录（**非递归**，空即删，绝不 rm -rf）
  2.3 重写 study.json 的 paper 字段（"<旧topic>/<stem>" → "<新topic>/<stem>"）
  2.4 写一份完成标记 .migration-v1.done（含时间、条目数、日志路径）
```

**为什么"先复制后删"而不是"直接 rename"**：rename 是同一文件系统内的元数据操作、单文件原子，
但**多文件之间不原子**。直接 rename 到一半崩溃 ⇒ 论文的产物分裂在两个位置，
且旧布局的"平铺目录"看起来仍然完整，用户/其余代码无法判断哪边是真的。
先复制后删则保证**任何时刻至少有一份完整可读的产物**（源还在，直到校验通过）。
代价是临时双份磁盘占用——对 14.3 MiB 的真实库微不足道，对 TB 级库要先跑 0.4 的空间预检。

**幂等与复跑的判据（实现必须逐条断言）**：

- 预检是幂等的：同一目录跑两次得到完全相同的规划（实测 PASS）。
- 执行是幂等的：日志里已有的 `from->to` 直接跳过；第二次执行日志条数不变（实测 `9 → 9` PASS）。
- 复跑不会二次嵌套：第二次规划 `moves.length === 0`（实测 PASS）——靠 §B1.1 规则 3。
- **已完成的判定**：目标存在且 `size`（建议加 sha256）与源一致 ⇒ 记为 `already-done`，跳过复制但仍参与阶段 2 的清源。

**回滚**：

- 自动回滚：按 `.migration-log.json` **倒序**把 `to` 搬回 `from`，然后自底向上 rmdir 空目录（实测 PASS，
  回到迁移前形状，孤儿文件原地未动）。**回滚前必须先确认阶段 2.1 还没删掉源**——若已删，`to` 就是唯一副本，
  回滚只是"搬回去"，数据不丢。
- 手工回滚（无脚本）：回收站不参与迁移，所以"撤销迁移"= 把 `<stem>/` 里的文件搬回上一级、删掉空目录。
  日志文件与干跑报告要**放在 dataDir 之外**（建议 `~/.dsh-paper-reader/migration-logs/`），
  否则它们自己会变成需要额外规则处理的"第 17 个文件"。

**6 类预检清单（实现必须逐类给出机器可读 code + 处置）**：

| 类 | 触发条件 | 处置 | 建议 code |
|---|---|---|---|
| `conflict` | 目标目录名 `<stem>` 已被**文件**占据 | 中止该论文，报告，不动任何东西 | `migrate-conflict` |
| `resume` | 目标目录已存在且内有同名文件，size/hash 一致 | 认作已完成，跳过复制 | `already-done` |
| `orphan` | 既不匹配任何论文 stem 也不是目录 | **原地不动** + 报告（真实库实测有 1 个：`默认专题/Dong et al. 2026 - LCVN 方法溯源与相关工作归属表.md`） | `migrate-orphan` |
| `hidden` | 以 `.` 开头 | 不动、不阻塞（与 `listTopics` 跳过隐藏一致，`src/library.ts:63`） | `migrate-hidden` |
| `quarantine` | 论文名以 `.` 开头 / 等于 `.trash` / 超长（能识别成论文但**建不出**同名目录） | 进"需人工"清单，**中止该篇** | `migrate-quarantine` |
| `symlink` | 源是符号链接 | 只搬链接本身（沿用 `listArtifacts` 的既有语义，`src/library-manage.ts:262-273`） | `migrate-symlink` |

### B1.3 受影响的代码点（逐个列出；这一节是按 `refFor` 与 `listPapers` 两条主线整理的）

**好消息（必须写进实现说明）**：**产物路径几乎全部由 `refFor()` 一处派生** ——
`txtPath/pagesPath/transcriptPath/mineruMdPath/mineruJsonPath` 都是
`pdfPath.slice(0, -extname(pdfPath).length) + '<后缀>'`（`src/library.ts:84-96`），
`studyPathFor()` 也是 `ref.pdfPath.slice(0,-4) + '.study.json'`（`src/study.ts:33-35`），
`embeddingsPathFor()` 是 `txtPath.replace(/\.txt$/i,'') + '.embeddings.json'`（`src/embed.ts:59-61`）。
因此**布局变更 = 改 `refFor()` / `resolvePaper()` 的"base 推导"这一处**，其余消费者不用改。

| # | 代码点 | 现状锚点 | 需要的改动 |
|---|---|---|---|
| 1 | `refFor()` base 推导 | `src/library.ts:84-96` | base 从 `<topicDir>/<stem>` 变成 `<topicDir>/<stem>/<stem>`；其它字段不动 |
| 2 | `resolvePaper()` 的 topic+name 分支 | `src/library.ts:104-126` | 命中后拼 `join(dataDir, topic, name, name + '.pdf')`；`path` 分支（`:105-110`）需把 `basename(join(abs,'..'))` 的"专题"改为"论文所在专题路径" |
| 3 | `listPapers()` | `src/library.ts:69-82` | 从"单层读文件"变成**递归遍历**：遇到论文目录（含 `<dir>.pdf`）产出 `{topic: 相对路径, name: 目录名}` 并停止递归；遇到子专题继续递归。返回的 `topic` 变成**相对路径**（`A/B`） |
| 4 | `listTopics()` | `src/library.ts:63-66` | 保留"一级子目录"语义（供 `/api/library` 的 `topics` 字段与"新建专题"），另加 `listTopicTree()` 供树形 UI |
| 5 | `/api/library` 的 pdfPath 拼装 | `src/host.ts:490-492` | `listPapers` 的 `topic` 变成相对路径后，`join(dataDir, p.topic, p.name + '.pdf')` → `join(dataDir, p.topic, p.name, p.name + '.pdf')` |
| 5b | `resolveUploadTopic()` | `src/library.ts:229`（基线**独有**：realpath 层，挡 symlink 逃逸） | 路径化 topic 后要保证"父链每一段都在库内且非符号链接"；上传落点改为 `join(resolveUploadTopic(...), stem)` 后再建论文目录 |
| 5c | 上传路由的词法/边界校验 | `src/host.ts:518-569`（`validateEntryName(topic)`、`validateEntryBoundary(stem)`、`safeName = filename.replaceAll('/','_')`） | 上传的 `topic` 也升级为路径 ⇒ 逐段校验；其余不变 |
| 6 | `listArtifacts()` | `src/library-manage.ts:231-249` | 现在只 `readdirSync(topicDir)` 一层（`:207`）且 `e.isDirectory()` 直接跳过（`:208`）。改为：在**论文目录**内枚举（一层），不再按 `paperName` 前缀过滤（因为目录内全是它的）；`matchArtifactName` 保留用于**旧布局兼容期**与迁移预检 |
| 7 | `planPaperDelete()` / `deletePaper()` | `src/library-manage.ts:419-494` | `topicDir` 改为论文目录；`listArtifacts` 的调用点语义随之变；`planPaperDelete` 里"`.pdf` 必须是常规文件"的检查（`:343`）保留 |
| 8 | `assertArtifactsContained()` | `src/library-manage.ts:252-274` | `dirname(p) !== topicDir` 的断言（`:233`）要改成相对于论文目录 |
| 9 | `moveToTrash()` | `src/library-manage.ts:351-405` | 现在 `renameSync(from, join(bundle.abs, f.name))` 把文件**平铺**进传入的 bundle（`src/library-manage.ts:361`）。**好消息**：`clearTopic` 已按「每篇一个子目录」规避跨篇撞名（`:665-675`，`join(bundle.abs, p.name)`），所以「清空专题/子树」路径**天然正确**。**只有删除单篇**（`deletePaper`，`:462-494`）直接往 bundle 根平铺；迁移后一篇论文的产物仍只属于它自己、不会跨篇撞名，但为回收站可读性与「论文目录整体恢复」，建议单篇删除也改成放进 `<bundle>/<论文名>/` |
| 10 | `writeManifest()` | `src/library-manage.ts:486-492` | manifest 增加 `relativeDir` 与论文目录名，作为回滚线索 |
| 11 | `planTopicDelete()` | `src/library-manage.ts:505-518` | `papers` 的推导（`:421`）现在只看平铺 `*.pdf`；需要按新布局识别论文目录；另加 `subtopics` 字段区分"子目录"与"论文目录" |
| 12 | `deleteTopic()` 的 rmdir 不变量 | `src/library-manage.ts:528-575`，核心 `rmdirSync` 在 `:470` | **保持不变**：非空即 409 `topic-not-empty`。见 §B2.2（实测：含子目录的 topic 今天就被这条挡下，且拒绝后目录完好） |
| 13 | `renamePaper()` | `src/library-manage.ts:799-860` | 从"逐个 rename 产物文件"变成**一次目录 rename**（`<old>/` → `<new>/`）+ 内部文件名同步改名（因为规则 2 让文件名带论文名）。两步之间不原子 ⇒ 需要"先 rename 目录、再 rename 目录内文件"的日志 + 回滚 |
| 14 | `renamedName()` | `src/library-manage.ts:794-796` | 逻辑不变（仍是纯前缀拼接，防 `$&` 注入），继续用于目录内文件改名 |
| 15 | `renameTopic()` | `src/library-manage.ts:862-888` | 目录整体 rename 的语义不变；但**sessionId 会脱钩**（见 §B1.4） |
| 16 | `validateNewPaperName()` | `src/library-manage.ts:114-124` | 不变（`-en/-zh/-dual` 结尾仍要拒） |
| 17 | `studyPathFor()` / `readStudy` / `writeStudy` | `src/study.ts:33-54` | 不改代码（自动跟随 `refFor`）；但迁移要重写 `study.json.paper` 字段 |
| 18 | `embeddingsPathFor()` | `src/embed.ts:59-61` | 不改（跟随 `txtPath`）；`ensureChunkVectors` 的 `cachePath` 由 `ref.txtPath` 派生（`src/tools.ts:358`） |
| 19 | `transcribe.ts` 的落盘点 | `src/transcribe.ts:341-347, 418-422, 505-509` | 不改（全部走 `ref.*Path`）。**但注意** `writeFile(ref.txtPath)` 依赖目录已存在——论文目录由"上传时创建"，所以要先确认**上传路径**建目录 |
| 20 | 上传路由 | `src/host.ts:518-569`（目标 `join(dir, paperName + '.pdf')` 在 `:509`） | 改成先 `mkdir <topicDir>/<paperName>/` 再写 `<paperName>.pdf` |
| 21 | 阅读器 URL 与 `path=` 参数 | `reader/index.html:344-347`（`pdfUrl()`）、`:359`（`openPaper` 里拼 query）；`lib/client.js:472` | `topic` 现在可能是路径，`encodeURIComponent` 已能编码 `/`（→ `%2F`），**但**服务端 `url.searchParams.get('topic')` 会自动解码回 `A/B`，因此**协议不变**（实测语义：`URLSearchParams` 对 `%2F` 解成 `/`）。`/api/pdf` 的 `variant` 参数（`src/host.ts:1003-1024`）不变 |
| 22 | `/api/paper`（元信息 + `pdfPath`） | `src/host.ts:986-1002` | 不变（走 `ref`）；`pdfPath` 是绝对路径，阅读器只用于展示/复制 |
| 23 | `search_paper` 工具 | `src/tools.ts:238-410`（`ref.txtPath` 在 `:226`、`cachePath` 在 `:358`） | 不改（跟随 ref） |
| 24 | `transcribe_pdf` 工具 | `src/tools.ts:164-237` | 不改（跟随 ref）；但"上传/新建文献"的工具分支若有手工拼路径要改 |
| 25 | 公式索引缓存键 | `src/formulas.ts:335-338` | 键是 `ref.mineruJsonPath`，**自动跟随**；但缓存里的旧键会在迁移后失效（无害，重算一次） |
| 26 | 会话工作区与 cwd | `src/host.ts:266-277`（`ensureTopicWorkspace` 的 `join(dataDir, topic)`）| topic 变路径后 `join` 仍然成立（`join(dataDir,'A/B')`）。**但** `workspaceCache` 的键从 `join(dataDir, topic)` 变成新的论文目录路径吗？——**不要**：会话工作区保持"专题目录"，见 §B2.4 的理由 |
| 27 | `sessionPrefixFor()` | `src/host.ts:217-218` | `base64url(topic + '/' + name)` 自动接受路径；但**改名会脱钩**（§B1.4） |
| 28 | 改名搬家（前端 localStorage） | `lib/client.js:250-281` | 保留键格式；把"前缀匹配"改成"按已知 (topic,name) 对精确搬"（§B2.4） |
| 29 | 阅读器内 `variantKey()` | `reader/index.html:336`（定义）、`:372-374`（读/回写）、`:501`（写） | 键格式不变（§B2.4 已证歧义不可达） |
| 30 | 删除计划 UI / 确认流 | `lib/client.js:1076` 附近（`doDelete` 注释）、`docs/reader-ux-requirements.md §2.8-2.9` | 删除单篇论文的**用户可见语义不变**（仍是"计划 → 手输确认 → 批量移入回收站"），只是搬的是目录 |

### B1.4 旧布局是否仍需可读（结论 + 代价）

**结论：不双读。** 迁移是一次性、显式、可回滚的；运行期只认新布局。

理由与代价：

- 双读会把"论文在哪"变成二义（同一篇论文两个位置都"看起来"有效），下面每一处都要写两遍分支：
  `listPapers` / `resolvePaper` / `listArtifacts` / 删除 / 改名 / 检索 / 嵌入缓存 / 公式缓存 / 上传去重。
  粗算 ≥ 12 个分支点，且每个都是"破坏性操作走错分支 ⇒ 删错东西"的高危点。
- 迁移本身是幂等 + 可回滚的（§B1.2 实测），所以"迁移失败"不会让库不可读——**失败时留在旧布局**，
  用户重跑或回滚即可。这已经覆盖了双读想解决的场景。
- **代价**：① 迁移前必须先升级（旧版本插件会看不懂新布局 —— 要用"插件发现新布局就提示升级"或
  `.migration-v1.done` 标记来兜）；② 用户手工放进专题目录的东西（孤儿）保持原样、不参与迁移，
  于是树上会出现"论文在文件夹里、笔记在专题根下"的混合形态——这是**有意**的（不猜测归属），
  文档必须写明；③ 回滚窗口期用户如果同时用旧版本插件，会出现"看到旧布局但新文件在子目录"的混乱。

**必须真机/真数据验证的项**：迁移的**干跑报告**必须在真实库（`~/.dsh-paper-reader/data`）上跑一次，
逐条人工核对后再执行；执行前**必须**先做一次库快照（`cp -a` 或 tar，落到库外）。

---

## B2. ② 嵌套子专题

### B2.1 数据模型：目录即层级（冻结）

**决策：目录即层级，不引入元数据文件。**

- 理由 1：迁移与删除已经建立在"目录就是真相"上（`deleteTopic` 用 `rmdirSync` 非递归、`listTopics` 读目录）。
  引入元数据文件（如 `_topic.json`）会立刻产生"元数据与磁盘不一致"的第二真相源，且这个文件本身要参与
  删除/改名/回收站/迁移的每一处判断。
- 理由 2：论文文件夹（§B1.1）已经把"目录即层级"用在论文粒度上；两层模型一致，代码只有一套规则。
- 理由 3（成本）：元数据方案能给的好处（排序权重、图标、描述）不是本批需求。真需要时再加**可选** sidecar，
  缺省不依赖它。

层级判定规则（唯一权威，实现必须写成函数 + 单测）：

```
isPaperDir(dir) := readdirSync(dir) 中存在名为 `<basename(dir)>.pdf` 的**常规文件**
```
- `isPaperDir` ⇒ 论文目录，**不递归**。
- 否则 ⇒ 专题目录，递归读取子目录。

### B2.2 路由与语义

**参数形态（冻结）**：`topic` 从"单段名"升级为"**相对路径**"（`A`、`A/B`、`A/B/C`）。
不新增 `path` 概念，不改字段名 —— 这样全部既有客户端调用点（`?topic=&name=`）无需改协议。

**校验（冻结；实测 18 条穿越矩阵全过，见 `c-subtopic-scope-probe.mjs` S2）**：

```
validateTopicPath(raw):
  raw 非空字符串；raw.length ≤ 200
  segs = raw.split('/')；segs.length ≤ 16（MAX_DEPTH）
  逐个 seg 走**既有** validateName(seg, 'topic')   ← 复用全部既有保证（空/./../前导点//\/NUL/255 上限）
  单个 seg 长度 ≤ 100（MAX_SEG）
  return segs.join('/')     // 规范化后原样
```
> 基线现状（必须知道，改动时别踩）：`delete-topic` / `rename-topic` / `clear` 三个路由里都有
> 一段 `const rawTopic = ...; typeof rawTopic === 'string' && rawTopic.includes('/') && rawTopic.startsWith(...) ? rawTopic : ...`
> 之类的分流（用**绝对路径**绕过"单段名"校验），`clear-plan` 只用 `validateEntryBoundary`（不认路径）。
> 路径化之后**必须统一**成"先逐段校验、再解析真目录"，**禁止**保留两套并存的入参语义
> ——否则会出现"同一个 topic 字符串在 `clear-plan` 能过、在 `clear` 过不了"的不对称。

**红线**：**不许**改成"放宽 `validateName` 里那条 `/` 正则"（`src/library-manage.ts:85`）。切段逐段校验是
唯一能保证"放开 `/` 不引入任何新逃逸面"的方式；`resolveTopicDirChecked`（`src/library-manage.ts:152-168`）的 realpath +
符号链接（`:162`）+ `assertInside` 三层防护**原样保留**。

**路由清单（新增/改动；现有的规范路径与别名双轨保持不动，见 `src/host.ts:571-584`）**：

| 方法 + 路径 | 基线状态（`ec21969`） | 本批变更 |
|---|---|---|
| `GET /api/library` | `src/host.ts:490-492`（返回 `{dataDir, topics, papers}`） | `topics` 语义保持"一级子目录"；**新增** `tree`（完整嵌套树 `{name, path, children[], papers[]}`） |
| `POST /api/library/topic` | `src/host.ts:499` | `name` 接受路径（`mkdir` 已带 `recursive: true`，天然建多级）；补"父目录必须存在且是库内目录" |
| `POST /api/library/upload` | `src/host.ts:518-569`（落点 `writeFile(join(dir, safeName), buf)`，`:562`） | 落点改为 `join(dir, stem, safeName)`（先建论文目录） |
| `GET /api/library/paper/delete-plan` | `src/host.ts:595` | `listArtifacts` 的目录参数语义变化（见 §B1.3 #6） |
| `POST /api/library/delete-paper`（别名 `…/paper/delete`） | `src/host.ts:625` | 删除单元从"一批平铺文件"变成"论文目录整体" |
| `POST /api/library/rename-paper`（别名 `…/paper/rename`） | `src/host.ts:650` | 论文目录 rename + 目录内文件名改名（§B1.3 #13） |
| `POST /api/library/delete-topic`（别名 `…/topic/delete`） | `src/host.ts:682` | **叶子语义不变**；返回体里的 `clearEndpoint` 指向清空（`:707`） |
| `POST /api/library/rename-topic`（别名 `…/topic/rename`） | `src/host.ts:728` | `to` 接受路径 ⇒ 天然支持"移动到另一父"；**新增**"拒绝移入自身子树"（409 `bad-request`） |
| `GET /api/library/topic/clear-plan?topic=` | **基线已有**：`src/host.ts:769-806` | 计划里**新增** `subtopics` 与逐子树的合并清单（叶子专题行为不变） |
| `POST /api/library/topic/clear` | **基线已有**：`src/host.ts:811-846`（`confirmName` 手输确认 + `planTopicClear` + `clearTopic`，`withInflight('topic\u0000…')`） | 支持**子树**：按后序遍历，先清各子专题（各自独立 bundle）再清本层，最后非递归 rmdir（§B2.2 末） |
| 其余（`/api/pdf`、`/api/ask`、`/api/paper`、`/api/transcribe`、`/api/formulas`、`/api/translate-selection`、`/api/sessions*`） | — | `topic` 是路径后语义自然成立，**不改协议** |

> ⚠️ **重要更正（我第一版把已存在的功能写成了"新增"）**：基线 `ec21969` **已经有**一整套
> 「非空专题删除的中间态」机制 —— `planTopicClear` / `clearTopic`（`src/library-manage.ts:602-628` / `:653-709`）、
> `GET /topic/clear-plan` / `POST /topic/clear`、前端的三步确认（`lib/client.js:1073-1175`，含
> `clearEndpoint` 驱动的"删除被 409 挡下 → 自动转入清空中间态"）。
> **本批对它的改动只有一个**：让它能作用在**子树**上（今天 `planTopicClear` 只遍历本层的
> `listPapers(dataDir, topicName)`，`src/library-manage.ts:606`，不递归）。
> 清空计划/确认/回收站语义/`withInflight`/会话与翻译前置 409 **全部复用，不要重写**。

**`.trash` 回收站语义（冻结）**：

- 保留名 `.trash` 在**每一层**都非法（`validateName`/`validateEntryBoundary` 已挡 `.` 开头与保留名，
  `src/library-manage.ts:109`）——嵌套后要在**每一段**都检查，不能只查整串。
- 回收站条目**必须保留原始相对路径**（`20261014T093000Z-ab12cd/默认专题/子专题/论文/论文.pdf`），
  否则不同论文的同名 sidecar 会撞名（这是 §B1.3 #9 的要害）。
- manifest 里记录 `kind: 'paper' | 'topic-hidden' | 'subtree'`、原相对路径、以及**触发操作的 topic 路径**。
- 回收站**不设过期自动清理**（沿用 `docs/reader-ux-requirements.md` §2.5 的既有决策）。

**非递归 rmdir 不变量如何维持（实测已证）**：
`rmdirSync(topicDir)`（`src/library-manage.ts:560`）非空即失败这条**不需要改**。
`c-subtopic-scope-probe.mjs` S1 实测：给 `T/` 放一个子目录 `subtopic` 后，`planTopicDelete` 把它算进
`entries`（⇒ 非空），`deleteTopic` 报 `topic-not-empty`，且**拒绝后目录与子目录都还在**。
所以"叶子/非叶子"的区别今天就已经被 rmdir 兜住了；嵌套子专题只需要新增"删除非空子树"的**显式**路径。

**删除非空子树怎么走既有的「删除计划 + 批量清空 + 手输确认」（冻结；**在既有实现上扩展，不重写**）**：

基线已有链路（逐行）：`GET /api/library/topic/clear-plan`（`src/host.ts:769-806`）→ 前端三步确认
（`lib/client.js:1073-1175`）→ `POST /api/library/topic/clear`（`src/host.ts:811-846`）→
`planTopicClear`（`src/library-manage.ts:602-628`）→ `clearTopic`（`:653-709`）。
**要改的只有扩展点**：

1. `planTopicClear` 增加递归：把每个子专题当成一个独立的"清空单元"（`{topicPath, papers, subtopics, filesCount, totalBytes}`），
   产出 `subtopics: TopicClearUnit[]` 与合并后的总数。**叶子专题的返回体形状必须逐字不变**（既有测试会断言）。
2. `clearTopic` 增加后序遍历：**自底向上**逐个子专题调用（每个子专题一个独立 `.trash` bundle，与既有的
   "每篇一个子目录"设计一致，天然避免跨篇/跨专题同名撞名，见 `src/library-manage.ts:644-667`），
   再清本层论文，最后非递归 `rmdirSync`（`:699`）。任一节点失败 ⇒ 沿用既有的"失败即回滚"口径
   （`:648-651`：把本次已移动的全部文件 rename 回原位，回滚失败的进 `rollbackFailed` 并在回收站里）。
3. **确认强度不放松**：手输确认仍是 `confirmName === topicPath`（`src/host.ts:815` 附近；失败 400 不是 409）。
   ⚠️ 我第一版设计的 `confirmToken=sha256(...)` **不要引入** —— 基线用的是 `confirmName` 字面比对，
   另造一套 token 会产生两种确认语义。
4. `withInflight` 键仍是 `topic\u0000<topicPath>`（`src/host.ts:811-846` 内），但**必须同时**占用子树内
   每篇论文的键（否则"清空子树"与"删单篇"会并发交错）。
5. 写 manifest：既有 `kind:'topic-clear'` 之外新增 `kind:'subtree-clear'`，并保留每个子专题各自的 bundle 路径。

**前置准入（409 家族，必须与既有语义一致）**：
子树中**任一**论文有运行中会话 ⇒ 409 `session-running`；会话状态查不到 ⇒ 503 `session-unknown`（fail-closed，
`src/host.ts:354-365`）；任一论文正在翻译 ⇒ 409 `translation-busy`（`:583`/`:611` 的同款检查要扩展到整棵子树）；
同名操作在途 ⇒ 409 `busy`（`withInflight`，`:342-352`）——**键要覆盖整棵子树**：
建议 `withInflight(`subtree\u0000${topicPath}`)` **并且** 保留论文级键，避免"清空子树"与"删单篇"并发交错。

### B2.3 UI（树形展示与拖拽/移动）

- **展示**：`lib/client.js` 的文献库树（`PAPER_STEM_SUFFIXES` 之外的那棵，`:1128` 附近注册的 `sidebar` surface）
  改成**递归组件**：专题节点可折叠（已有 `dpr.treeClosed` 持久化，`:701`/`:889`/`:1084`），论文节点是叶子。
  `dpr.treeClosed` 的键从"专题名"改成"专题路径"（含 `/`），并加**兼容读**：读不到新键时回退旧键。
- **展开态默认**：一级专题默认展开（现状），子专题默认折叠（避免深层树一次铺开）。
- **创建**：专题节点上的"＋"菜单给两个动作：「新建子专题」「上传 PDF 到此处」；论文节点无"＋"。
- **移动**：
  - 首选**不引入 HTML5 拖拽**（iframe/portal 与官方侧栏拖拽手柄会打架，`lib/client.js:422` 附近已经在为
    `--dsh-dockkit-dock-layer` 让路）。改为"移动到…"菜单 + 目标选择器（列出合法父节点，排除自身子树），
    复用 `POST rename-topic` 的 `to` 路径语义。**实现成本更低、可断言性更强**。
  - 若后续要拖拽，必须作为一个独立小批次，并先验证与官方拖拽手柄无冲突。
- **重命名**：内联编辑（沿用现有 ✎ 入口，`lib/client.js:1522-1524` 的 `data-dpr-act` 悬停显隐）。
- **删除**：叶子 → 现有删除确认；非空 → 走 §B2.2 的清空计划流程（UI 文案必须点明"包含 N 个子专题、M 篇论文"）。

### B2.4 与既有约束的交互（逐条）

| 约束 | 现状锚点 | 嵌套后的处理 |
|---|---|---|
| 会话/翻译前置 409 | `src/host.ts:354-365`（`session-running`/`session-unknown`）、`:625-648` 与 `:650-680`（逐篇 `translation-busy`）、`:716`/`:754`/`:836`（专题级/清空级 `translation-busy`） | 专题级操作要**递归收集**子树内全部论文后逐篇检查（`requireTopicSessionsClear`（`src/host.ts:368-373`）已按 `listPapers(dataDir, topic)` 遍历——`listPapers` 改成递归后它自动覆盖子树） |
| `withInflight` | `src/host.ts:383-393` | 键扩展：论文级 + 子树级（见 §B2.2 末） |
| 会话工作区 / cwd | `src/host.ts:268`（`ensureTopicWorkspace`）、`:283`（`createPaperSession`） | **保持"专题目录"为工作区/cwd**（`join(dataDir, topic)` 对路径天然成立）。**不要把 cwd 改成论文目录**：dsh 的工作区注册按路径缓存、无删除 API（`docs/reader-ux-requirements.md` 第 282 行的既有结论），树形结构下每篇论文一个工作区会迅速膨胀 |
| 改名搬家的 localStorage 前缀 | `lib/client.js:276-307`（`migrateLsKeys`，调用点 `:974`） | **保留** `dpr.variant.<topic>/<name>` 与 `dpr.sessionN.<topic>/<name>` 格式（§B2.5 已证歧义不可达）。改动：**按已知 (topic,name) 对精确搬**，**禁止**前缀匹配（实测：前缀匹配会误伤兄弟 `A/BC`） |
| 阅读器 `variantKey` | `reader/index.html:336`、`:372-374`、`:501` | 不改（同上） |
| 路径穿越校验 | `src/library-manage.ts:152-168` | 保留三层防护；只是入参从"单段名"变成"逐段校验后的路径"。`assertInside(root, join(root, topicPath))` 对路径同样成立 |
| 工作区缓存失效 | `src/host.ts:718`（删专题后）、`:756`（改名后）、`:839`（清空后） | 改为清理子树下**每个**专题目录的键 |
| 会话 id 与历史 | `src/host.ts:217-218` | ⚠️ 见下 |

**⚠️ 改名/移动专题会让历史会话脱钩（实测，必须写进 UI 确认文案）**：

`sessionPrefixFor` 把 `topic/name` 做 base64url 当成会话 id 前缀（`src/host.ts:217-218`）。
实测：`默认专题/X` 与 `默认专题2/X` 得到**完全不同**的前缀（长度都不同：122 vs 123）。
真实库该专题下已有 **13 个** `dpr-` 会话目录（`~/.dsh/sessions/--home-vr-.dsh-paper-reader-data-…--/`），
而 dsh 的 `SessionController` **只提供 `rename(sessionId, title)`＝改标题**，
`SessionRenameRequest = { sessionId, title }`（`dsh-api-session-controller/lib/types/types.d.ts:299-302`），
**没有**"改 sessionId"的 API。因此：

- 改名**父**专题 ⇒ 其子树内每篇论文的历史会话都会与树脱钩（磁盘上还在，树上/列表里看不到）。
- 这与既有"重命名=文件改名+历史会话脱钩"的决策**一致**（`docs/reader-ux-requirements.md` §2.5 第 315 行），
  但嵌套后影响面从"该专题内论文"扩大到"整棵子树"，**确认框必须给出脱钩会话数**。
- 可选改进（不建议本批做）：把会话 id 改成**与路径无关**的稳定键（例如首次创建时生成 uuid 并存进
  `study.json` 或某个 per-paper sidecar）。那是一次更大的迁移（要重写全部 `dpr-` 会话目录名），
  且 `workspaceCache`/session 存储目录的哈希前缀都会变。**记录为独立议题**。

### B2.5 深度/名称限制与冲突处理（冻结数值）

| 项 | 值 | 理由 |
|---|---|---|
| `MAX_DEPTH` | **16** 段 | 远超真实需要；挡住病态构造；16 层 × 100 char 仍 < 常见 PATH_MAX |
| `MAX_SEG` | **100** 字符 | 段名限制收紧（今天 `validateName` 允许 255，那是**文件名**上限；目录名带上层路径后要留余量） |
| `MAX_TOPIC_PATH` | **200** 字符 | 整条相对路径上限 |
| 名称冲突 | 同级同名 ⇒ 409 `target-exists`（沿用 `src/library-manage.ts:709` 的错误码与文案） | |
| 大小写 | 沿用现状（不做大小写折叠判定）；在 macOS/Windows 上同名不同大小写会真撞车 ⇒ **创建/改名时要额外做大小写不敏感的存在性检查**（现状 `existsSync` 在 macOS 上本身就是不敏感的，Windows 也是；Linux 上会漏，实现里对 `process.platform !== 'linux'` 加显式检查） | |
| 移动到自己子树 | 409 `bad-request`（"不能把专题移动到它自己的子目录下"） | 否则目录会消失成孤儿 |
| 循环/符号链接 | 目录 rename 不做递归复制 ⇒ 天然无循环；`resolveTopicDirChecked` 的符号链接拒绝（`:136`）覆盖每一段 | |

---

## B3. ③ 按范围提问

### B3.1 语义（冻结）

**范围（scope）三态**（用户需求「单篇论文 / 某个专题或子专题」）：

| `scope.kind` | 取值 | 含义 |
|---|---|---|
| `'paper'` | `{ kind: 'paper', topic, name }` | **就是这一篇**（含它的全部产物；不含同专题其它论文） |
| `'topic'` | `{ kind: 'topic', topic }` | **该专题/子专题及其整棵子树**内的全部论文（含所有子专题里的论文） |
| `'subtree-paper'` | 由 `'topic'` + 可选 `papers[]` 收窄 | **进阶（第二批）**：先给整棵子树的目录清单，用户勾选具体论文 |

**上下文只给该范围的内容** —— 精确定义（冻结）：

「范围内容」= **三段的拼接，全部由服务端按范围装配**（客户端不传正文，只传 `scope`）：

- **第 1 段：目录清单（必给，≤ 2000 字符）**
  范围树的结构化清单，每篇论文一行：`相对路径 | 页数 | 各产物是否存在/大小 | 学习档案状态`。
  **只给元信息与路径，不给正文**。这一段的目的是让模型知道"范围内有什么、在哪"，并让"范围外"的东西
  在提示里**看得见地缺席**。
- **第 2 段：选中论文的正文（按需，单文档 ≤ 8000 字符，总计 ≤ 40000 字符）**
  正文来源优先级：`<stem>.mineru.md`（若存在，MinerU 的版面重排质量最好）→ 否则 `<stem>.txt`。
  `scope.kind==='paper'` 时：默认全量（超 8000 截断并标注）。
  `scope.kind==='topic'` 时：**不做"全部正文都塞进去"**（实测：真实库 2 篇论文的正文合计 550 KiB，
  是 40000 上限的 **14 倍**，见 `c-subtopic-scope-probe.mjs` S4）。
  改为：用问题做一次**范围内检索**（复用 `searchChunks`/`searchChunksMulti`，`src/search.ts:73-163`，
  纯函数、无 Cordis 依赖），每篇取 top-k（默认 k=3，chunk≈1500 字符）作为该篇的正文代表。
- **第 3 段：检索命中（必给带页码的片段）**
  命中片段附 `<论文相对路径> 第 N 页`；页码映射复用 `pageForOffset`（`src/search.ts:56-64`，读 `pages.json`）。

**截断规则（必须显式、不许静默）**：
- 每篇论文标注 `full` / `truncated` / `omitted-no-room`（实测断言覆盖，`c-` S5）；
- 任何截断都在提示末尾追加一行"（清单：本次已给 X 篇，另有 Y 篇因上下文上限未展开，可缩小范围或指定论文）"。

**「检索命中」还是「整目录内容」——明确取舍**：用户原话是"只给该范围的目录内容"，
所以**目录清单（第 1 段）是硬要求**（这正是"只给该范围"的体现：范围外一篇都不出现）；
**正文**则必须走"检索命中 + 上限"路线，因为把整目录的 `.txt`/`.mineru.md` 全塞进去在真实数据上必然爆。

### B3.2 与既有 ask 路由 / 会话绑定 / withInflight / 体积上限的关系

- **路由**：`POST /api/ask`（`src/host.ts:1368-1418`）扩展 body：新增可选 `scope`（默认按现有语义＝当前论文）。
  **向后兼容**：不传 `scope` 时行为与今天**逐字一致**（既有测试 `test/reader-ux.test.mjs` 对 ask 文案有断言：
  `[论文伴读] 文献：…（同目录下，search_paper 可直接检索；回答注明页码）`，以及 `用户在阅读器里选中了一段文字…`）。
  所以新逻辑必须是**追加**：范围块插在 `文献：…` 之后、`用户的问题：` 之前。
- **会话绑定**：会话 id 仍由 `sessionPrefixFor(当前论文)` 决定（`src/host.ts:217-218`）——
  **范围提问不改会话归属**（否则"在某个专题范围内提问"会凭空新建一批会话）。
  服务端在提示里同时写明"当前阅读的是 `A/P1`，本次提问范围是 `A`（3 篇论文）"，
  避免模型把二者混为一谈。
- **`withInflight`**：ask **不参与** in-flight 互斥（它不写库；今天也没有加锁）。但范围构造会**读**多个文件，
  要与"删除/迁移在途"协调：`GET`/`ask` 侧遇到 `inflight` 命中时**不阻塞**，而是在提示里降级为
  "该范围内的目录正在被修改，本次只给了 N 篇"（读路径 fail-soft，与既有"读路径不受影响"的取向一致，
  见 `src/host.ts:325-326` 的注释）。
- **体积上限**：`MAX_CONTEXT_CHARS = 40000`、`MAX_PER_DOC = 8000`、`MAX_MANIFEST = 2000`、
  `MAX_PAPERS_IN_SCOPE = 12`、`MAX_HITS_PER_PAPER = 3`。全部写进一个 `src/scope.ts` 的常量并导出，便于断言。
- **与既有"检索工具"的关系**：提示里仍保留 `search_paper 可直接检索`，并新增一句限制：
  "本次提问的范围是 `<scopePath>`；如需范围外的论文请显式说明"（让模型不会"顺手"跨范围检索）。

### B3.3 UI 入口（冻结）

- **入口 1（主要）**：`#ask-pop`（`reader/index.html:232` 起，`#ask-quote` 在 `:233`、`#ask-input` 在 `:234`）里，在 `#ask-quote` 与 `#ask-input` **之间**
  加一行范围选择器：`范围：[本篇 ▾]`（下拉三选：本篇 / 所在专题（含子专题） / 指定论文…）。
  空间紧张时折叠成一行小字 + 点击展开。
- **入口 2**：读者顶栏（`#bar`）加一个"范围"指示（`<span id="scope-chip">`），显示当前默认范围，
  点击可改默认；**默认范围有记忆**（`localStorage['dpr.askScope']`，键里带 `topic/name` 以免跨论文串味）。
- **默认范围（冻结）**：**当前论文**（`scope.kind='paper'`）。
  理由：阅读器里最自然的意图是"就这篇"；且这是今天的行为，默认不变 ⇒ 零回归风险。
- **当前范围显示**：`#ask-pop` 的按钮文案与 `#scope-chip` 都要显示，且**服务端返回的提示里也要写明**
  （用户能从回答里回看"这次范围是什么"）。
- **越界提示**：用户在"本篇"范围里问"这个专题里其它论文怎么说"时，模型无法回答（因为范围外内容没给）——
  提示里要明确交代"范围外未提供"，并给出"→ 改范围为专题"的操作提示。**这必须是可见的**，
  否则用户会以为插件"检索不到"。

---

# 第 C 部分：风险清单（逐条：触发条件 / 后果 / 缓解 / 是否真机验证）

| ID | 风险 | 触发条件 | 后果 | 缓解 | 真机验证 |
|---|---|---|---|---|---|
| R1 | **迁移中途崩溃** | 断电/被杀/磁盘满 | 论文产物分裂在两个位置 | 先复制后删（§B1.2 阶段 1）⇒ 源始终完好；日志可复跑 | ✅ 必须（/tmp 影子库 + 一次真实库干跑） |
| R2 | **迁移删错东西** | 精确 stem 匹配被放宽成前缀 | 删掉 `Attention Is All You Need.pdf` | `matchArtifactName` 保持精确相等（`src/library-manage.ts:209-216`）；单测必须留 `P2stale.txt` 这条反例（实测已覆盖） | ✅ |
| R3 | **孤儿文件被误搬/误删** | 论文名与用户笔记同名前缀 | 用户手写笔记被移走 | 孤儿**原地不动** + 报告；迁移只处理命中清单 | ✅ 真实库有 1 个孤儿 |
| R4 | **重复迁移造成 X/X/X.pdf** | 规划器递归进论文目录 | 嵌套套娃、日志翻倍 | §B1.1 规则 3「论文目录不递归」+ 断言（我的第一版就是栽在这，见 §B1.2 ⚠️） | ✅ 已实测复现并验证修复 |
| R5 | **回收站同名撞车** | 两篇论文有同名 sidecar | 回收站里覆盖、无法恢复 | 回收站条目保留原始相对路径 + manifest | ✅（/tmp） |
| R6 | **改名/移动父专题 → 历史会话脱钩**（含子树全部论文） | 改名/移动专题 | 用户以为会话丢了 | UI 确认框给出脱钩会话数；已实测 13 个会话受影响；§B2.4 记录长期方案 | ✅ 已实测（会话目录 + base64 前缀） |
| R7 | **`workspaceCache` / 工作区悬空** | 删/改专题后复用旧路径 | 同名专题重建后复用陈旧 workspaceId | 沿用既有清理（`src/host.ts:718`/`:685`），扩展到子树每个目录 | ✅ 需要（涉及 dsh 工作区注册，无法单测） |
| R8 | **迁移后旧版本插件看不懂新布局** | 用户回退插件版本 | 库"空了" | `.migration-v1.done` 标记 + 启动检测提示；发行说明写清 | ✅ |
| R9 | **`topic` 变路径导致穿越面扩大** | 校验写成"放宽正则" | 目录逃逸 | 切段逐段 `validateName`（18 条矩阵实测）；realpath + symlink + assertInside 三层不动 | ✅ 已实测矩阵 |
| R10 | **localStorage 前缀误搬兄弟专题** | 用前缀匹配搬 `dpr.variant.A/` | `A/BC` 的键被误搬 | 按已知 (topic,name) 对精确搬；加兼容读 | ✅ 已实测前缀误伤 |
| R11 | **清空子树时并发交错** | "清空子树"与"删单篇"并发 | 中间态 404/500 | `withInflight` 键覆盖子树 + 论文级 | ✅ |
| R12 | **深色滤镜破坏几何/选区/热区** | 滤镜挂错元素（挂 `.page`） | 选中高亮变色、热区框反色 | 只挂 `canvas`；A 段 16 条实测为护栏 | ✅ 已实测 |
| R13 | **深色判定读不到宿主主题** | 跨源/沙箱/宿主换实现 | 深色不生效 | 四级降级链 + 朝亮色回退 | ✅ 已实测四条通道 |
| R14 | **照片变负片 / 图表色偏** | 论文里有照片或深色图表 | 观感下降/图例失真 | 已知代价，量化写入文档（§A2.1）；`off`/`strength=0` 可绕过 | ✅ 已量化 |
| R15 | **首帧白闪** | 主题判定晚于首帧 | 打开闪白 | 判定前 `visibility:hidden` | ⚠️ 必须真机（大 PDF 首屏时序） |
| R16 | **范围提问上下文爆掉/被静默截断** | 专题范围很大 | 模型答得含糊，用户不知为何 | 三段式 + 显式 `omitted/truncated` 标注（实测断言） | ✅ 已量化 |
| R17 | **范围提问泄露范围外内容** | 提示里仍写"search_paper 可直接检索" | 模型跨范围检索，违背"只给该范围" | 提示内显式限范围 + 建议只在该环节允许目录内检索 | ⚠️ 必须真机（模型行为，需实跑会话） |
| R18 | **会话工作区膨胀** | 若把 cwd 改成论文目录 | 每篇论文一个 dsh 工作区，无删除 API | 保持 cwd = 专题目录（§B2.4） | ✅ |
| R19 | **版本号三者不一致** | 发布时忘对齐 | 用户无法判断是否升级成功 | §0.1：显式定版本并三处对齐 | ✅ |
| R20 | **基线切错分支** | 从本地 `main` 或工作树切，而不是 `ec21969` | 丢 80 个提交（含分屏 / 清空专题 / 33 个测试），或行号全错 | §0.1：`git switch -c <new> ec21969` | — |
| R21 | **拿错构建得出假结论** | 用仓库里残留的旧 `dist/` 跑验证 | 误判"基线没有清空功能/结论反了"（实测：仓库 `dist/library-manage.js` 的 `planTopicClear === undefined`） | 在 `/tmp/dpr-base` 用 `git worktree add` 从基线构建后再跑；`c-` 探查自带同代自识别断言 | ✅ |

---

# 第 D 部分：可执行验收清单

> 约定：`A*` = 深色；`B*` = 文献库结构（B1 分文件夹 / B2 子专题 / B3 范围提问）；`C*` = 全局回归。
> 🔬 = 必须真机/真数据（涉及真实文献库的破坏性操作**已加粗标注**）。

## D.1 深色模式

| 编号 | 验收项 | 怎么验 |
|---|---|---|
| A1 | 阅读器源码里**首次**出现深色逻辑，且旧断言全绿 | `node .probe/darkmode-subtopic/a-darkmode-probe.mjs`（现状 6 条 "不含…" 断言会翻面，实现方要把它改成"存在且只有一处"） |
| A2 | dsh 亮色时 PDF 保持亮色 | 🔬 手动：dsh 设亮色 → 打开 PDF → 截图取色，页面底色 ≥ 240 |
| A3 | **dsh 深色时 PDF 变深色**（默认 `follow`） | 🔬 手动：dsh 设深色 → 刷新 → 页面底色 ≤ 40 |
| A4 | 设置里可调且四档都生效 | 🔬 面板切换 `off/light/dark/follow`，各自截图取色符合预期 |
| A5 | 强度档位可调（4 档），白底取值单调 | 🔬 用 `e-filter-mechanics-probe.mjs` 的同款取色流程，4 档白底取值按 §A2.1 表 |
| A6 | 设置持久化（重启 dsh 后仍在） | 🔬 改值 → 重启 → 回读 |
| A7 | 阅读器内 `⚙` 也能改同一个设置（两处不打架） | 🔬 两处各改一次，值一致 |
| A8 | **文字层坐标/选中不受影响** | 自动化：`getBoundingClientRect` of `.page`/`span`/`Range`/`.eq-box` 在开关前后逐字节相同（`e-` 探针 16 条） |
| A9 | **公式热区命中不受影响** | 自动化：`hitTestFormula` 在开关前后返回同一 `eq.id`（`a-` 探针 A3） |
| A10 | 选区高亮与热区描边**不被反色** | 🔬 目视 + 取色：`.textLayer ::selection` 仍是蓝、`.eq-box.hit` 仍是橙 |
| A11 | 导出/下载的 PDF 未被改色 | 自动化：下载字节与开关前一致（走服务端，`src/host.ts:1003-1024`） |
| A12 | 读不到宿主主题时朝亮色回退，不崩 | 自动化：`d-` 探针的四条降级断言 |

## D.2 文献库结构

| 编号 | 验收项 | 怎么验 |
|---|---|---|
| B1 | 干跑报告可在真实库产出，且两次完全一致 | 🔬 **真实库（只读）**：`node .probe/darkmode-subtopic/b-library-migration-probe.mjs`；再跑一次比对 JSON |
| B2 | 迁移幂等：第二次规划 `moves.length === 0` | ✅ `/tmp` 影子库（已实测） |
| B3 | 迁移可中断：中途 kill 后源文件完好 | 🔬 `/tmp`：注入 `throw` 在第 k 条，断言源全在 |
| B4 | 迁移可复跑：日志条数不变、无 `X/X/X.pdf` | ✅ `/tmp`（已实测 `9 → 9`） |
| B5 | 回滚回到迁移前形状，孤儿原地未动 | ✅ `/tmp`（已实测） |
| B6 | 孤儿文件不被搬、被报告 | ✅ 真实库有 1 个（`默认专题/Dong et al. 2026 - LCVN 方法溯源与相关工作归属表.md`） |
| B7 | 迁移后 `listPapers` 无重复/无遗漏 | 🔬 迁移前后对比：论文数一致、`name` 集合一致 |
| B8 | **迁移后逐篇人工抽查**：`.pdf/.txt/.mineru.md/.study.json` 可开、可检索、可提问 | 🔬 **必须**（在真实库上，用户在场） |
| B9 | 上传新论文直接落到 `<topic>/<name>/` | 🔬 真机上传 → 看盘 |
| B10 | 删除单篇：论文目录整体进回收站，且回收站里保留相对路径 | ✅ `/tmp` + 🔬 真机 |
| B11 | 重命名论文：目录 + 内部文件名一起改，不产生脏名 | ✅ `/tmp` |
| B12 | 子专题：可建 ≥3 层、可重命名、可移动（含移动到另一父） | 🔬 真机 |
| B13 | **非递归 rmdir 不变量**：含子目录的专题删除被 409 拒绝，且目录完好 | ✅ 已实测（`c-` S1） |
| B14 | 清空子树：计划 + 手输确认 + 批量回收站；token 不符报 409 | 🔬 真机 |
| B15 | 穿越矩阵 18 条全过；realpath/symlink 三层防护未被绕 | ✅ 已实测 |
| B16 | 子树内任一论文有运行中会话 ⇒ 409；翻译中 ⇒ 409 | 🔬 真机 |
| B17 | 改名/移动专题**必须**提示脱钩会话数 | ✅ 已实测 13 个 + 🔬 真机 |
| B18 | 树形 UI：折叠态持久、子专题默认折叠、一级默认展开 | 🔬 真机 |
| B19 | 深度/长度限制按 §B2.5 生效（16/100/200） | ✅ 单测 |
| B20 | 范围提问：默认=当前论文；可切专题（含子树） | 🔬 真机 |
| B21 | 范围提问：上下文只含范围内内容，且带 `full/truncated/omitted` 标注 | ✅ 已实测上限逻辑（`c-` S5）+ 🔬 真机看实际提示 |
| B22 | 范围提问：范围外论文**不出现在**提示里 | 🔬 真机（抓 `/api/ask` 的提示文本或看会话首条消息） |
| B23 | 范围提问：会话仍绑在当前论文（不新建会话） | 🔬 真机 |
| B24 | 范围提示上限 40000/8000/2000/12/3 硬生效 | ✅ 单测 |

## D.3 全局回归

| 编号 | 验收项 | 怎么验 |
|---|---|---|
| C1 | **基线**工作副本里 `npm run build && npm test` 全绿（基线有 **33** 个测试文件，含 `library-clear-and-busy` / `library-traversal-verification` / `reader-render-guard` / `windows-esm-guard`） | 自动化。建议做法：`git worktree add /tmp/dpr-base ec21969` → 在 `/tmp/dpr-base` 里 build+test（**不要**在工作树里 build：工作树的 `dist/` 是另一条线的旧构建，实测 `planTopicClear === undefined`） |
| C1b | 本方案的 **6** 个探查脚本在基线上全绿 | `DPR_REV=origin/main node .probe/darkmode-subtopic/a-darkmode-probe.mjs` 等 6 条，期望合计 `128 passed, 0 failed`（a24 / b20 / c23 / d21 / e16 / f24） |
| C2 | 既有 ask 文案**逐字不变**（不传 `scope` 时） | 自动化（既有 `test/reader-ux.test.mjs` 断言） |
| C3 | 公式热区唯一铺层点断言仍成立（`checkSolePaintPoint`） | 自动化 |
| C4 | 阅读器 URL 协议不变（`?topic=A/B&name=X` 能直达） | 自动化 + 🔬 |
| C5 | `path=` 与 `topic+name` 双通道仍可用 | 自动化 |
| C6 | 19 条 `.eqLayer`/分屏/选择翻译既有测试全绿 | 自动化 |
| C7 | 版本号三处对齐 | 人工核对 |

---

# 第 E 部分：不做 / 延后（明确范围）

1. **不做**"把 cwd 改成论文目录"（工作区会膨胀，§B2.4/R18）。
2. **不做**会话 id 的稳定化重写（影响全部历史会话，独立议题，§B2.4）。
3. **不做**照片/图表的二次反转（需要像素级图像识别；R1 路线下不可得，§A2.5）。
4. **不做** HTML5 拖拽移动（与官方右侧栏拖拽手柄冲突，§B2.3）；用"移动到…"菜单替代。
5. **不做**旧布局双读（§B1.4 结论）。
6. **不做**回收站自动过期清理（沿用既有决策）。
7. **不做**跨专题的"论文移动"（沿用 `docs/reader-ux-requirements.md` §2.5 的既有否决）；但**专题移动**本批要做（`to` 接受路径）。

---

# 第 F 部分：给实现方的一句话开工顺序

1. 先按 §0.1 确认分支基线（从 `690fb44` 切），并定版本号。
2. **先做 A（深色）**：改动面小、无数据风险、`canvas` 一条 CSS + 设置贯通即可；用 `.probe/darkmode-subtopic/a-` 与 `e-` 做回归。
3. **再做 B3（范围提问）**：只读、无破坏性，可独立上线。
4. **再做 B2（嵌套子专题）**：先只放开路径校验 + 递归 `listPapers` + 树形 UI（只读），最后才接删除。
5. **最后做 B1（迁移 + 分文件夹）**：它是唯一会动用户数据的部分；必须先在真实库出干跑报告、人工核对、用户显式确认后再执行。

---

## 附录 Z：实现阶段的两处更正（t2 实现轮 + t6 补证据轮，队长已裁定）

### Z.1 §B1.4「不双读」被**有据推翻**（队长裁定：保留偏离）

方案冻结时写的是「运行期只认新布局」。实现轮按它严格落地后**实测**：既有回归套件里 **79 条用例转红**——
它们把「平铺布局」当作契约，而这些用例正是**路径穿越防护 / 非递归 rmdir 不变量 / 回收站可恢复 /
409 语义**这些红线的护栏。整体重写这批护栏 = 在同一批次里**让回归网变薄**，风险高于收益。

**裁定（队长）**：保留实现轮的偏离。冻结规则如下（确定性、无二义）：

| 场景 | 行为 |
|---|---|
| 只有平铺 `<topic>/<名>.pdf` | 仍可**列出 / 定位 / 删除 / 改名**，列表项带 `legacy: true`（UI/迁移据此提示） |
| 同名论文文件夹与平铺文件**并存** | **文件夹赢**：只列一次、解析到文件夹的产物；平铺那份不参与（消除二义） |
| 新写入（上传 / 新建） | **一律**落到论文文件夹 `<topic>/<名>/<名>.pdf` |
| 迁移完成后 | `legacy` 标记消失；旧路径不再可见（迁移是唯一收口手段） |

**集中回退点**（若要改回「只认新布局」，只动这几处）：
`src/library.ts` 的 `listPapers`（平铺扫描分支）、`paperPdfPath`、`listTopicTree` 的平铺分支；
`src/library-manage.ts` 的 `isLegacyPaper`、`resolvePaperDirChecked`（平铺回落）、`planClearUnit`
（平铺论文分支）、`renameLegacyPaper`、`deletePaper`/`clearTopic` 里 `layout === 'folder'` 的分支。

### Z.2 补证据轮（t6）修掉的三处实现缺陷

1. **迁移回滚的空目录收口**：回滚只对**源**文件的父目录候选做 rmdir，于是迁移时新建的论文文件夹
   （`T/P1/`）在搬回后**留成空目录**。修正：候选目录同时包含源与副本的父目录
   （`touchedDirs([...from, ...to])`）。回归用例：`test/darkmode-subtopic-features.test.mjs` 的 C4。
2. **范围装配的 `papers[]` 不全 + `{kind:'paper'}` 无 topic/name**：清单阶段只把「被省略」的篇推进
   `papers[]`（coverage/统计因此不覆盖全量），且不传 topic/name 的「本篇」范围会抛
   `需要 path 或 name 参数`。修正：范围内的每一篇都进 `papers[]`；`{kind:'paper'}` 缺省即当前论文。
   回归用例：同文件的 E1/E2/E3。
3. **`clearTopic` 的「失败即回滚」漏了目录**：清空时每篇论文的文件夹会被（非递归）rmdir 收口，而回滚只
   把文件 rename 回去 —— 目标父目录已不存在 ⇒ ENOENT ⇒ 文件只能留在回收站里，**库里看起来「白了」**。
   修正：回滚前 `mkdirSync(dirname(to), {recursive:true})` 把父目录建回来。这是补证据轮新写的 D6
   用例（认不出的条目 ⇒ 非递归 rmdir 必失败 ⇒ 必须回滚）**抓出来的真实缺陷**，不是纸上推演。

### Z.3 本轮的证据落点

| 验收项 | 用例 / 证据 |
|---|---|
| 深色开关/跟随/浅色不生效/持久化/热区选区不受影响 | `test/darkmode-subtopic-features.test.mjs` A1–A10 |
| 深色**真机取色**（真实 Chromium + 真实论文） | `test/darkmode-real-pdf.test.mjs` RD1（亮 `[255,255,255]` → 暗 `[6,6,6]`） |
| 按论文分文件夹 + 旧布局兼容读（含「文件夹赢」） | 同文件 B1–B4 |
| 迁移（干跑=执行 / 幂等 / 复跑 / 无套娃 / 回滚 / 中断不丢源 / 冲突先报告） | 同文件 C1–C6 |
| 嵌套子专题（多层/改名/移动/.trash 保护/非递归 rmdir/子树清空保留相对路径） | 同文件 D1–D5 |
| 按范围提问（单篇/子树/只给该范围/上限/显式截断） | 同文件 E1–E4 |
| t2 自查修掉的 4 个真实缺陷 | 同文件 F1–F4 |
| 变异验证（把实现改回缺陷态 ⇒ 对应用例变红） | `test/mutation-probe.mjs`（输出见 PR 说明） |
