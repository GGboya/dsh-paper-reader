# 阅读器可用性与文献管理 — 需求冻结（v1）

> 任务：`t1`（requirements round 1）· 团队 `dpr-reader-ux`
> 状态：**冻结**，下游实现与验证逐条照做；本文档只写结论与契约，不含实现代码。
> 改动范围：仅 `docs/`。本文档不修改 `src/`、`lib/`、`reader/`、`package.json`。
>
> 证据强度标记（每条结论都带）：
> - 【实测】= 本次在真实数据上跑出来的数值（命令与原始输出见 §7）
> - 【源码证据】= 本仓库或本机依赖包里的可复核代码（带 `file:line`）
> - 【推测】= 尚无实测支撑，已明确写出「如何验证」或「降级到安全路径」
>
> **PR #5 整改（t7 之后）口径更新**：删除/重命名/批量清空相关的**错误语义**以本文 §2 的现行描述为准
> ——`EBUSY`/`EPERM` → **409 `file-busy`**；其余 errno → **500 `trash-move-failed`**；**失败即回滚**（`rollbackFailed` 如实上报）；
> **错误响应只回相对 `trashRel`**（绝对 `trashDir` 只出现在 200 成功响应）。本文件已随该轮**纳入仓库**，
> 使 `src/`、`lib/` 里以「冻结契约（`docs/reader-ux-requirements.md`）」为名的引用可解析（评审 R-5）。
>
> 需求来源（用户原话）：「该插件不是很好用鼠标引用公式，能做一些前端优化吗？」/「能加强文献管理功能吗？目前好像不能删除添加的文件」

---

## 0. 结论摘要（可据此直接开工）

| # | 冻结结论 | 证据强度 |
|---|---|---|
| C1 | MinerU `content_list` 的 `bbox` 是**页面归一化坐标（×1000）**，原点左上、y 向下，**与 pdf.js `viewport` 可直接线性映射**，不需要 DPI/单位换算 | 【实测】+【源码证据】 |
| C2 | 映射公式：`x = bbox[0]/1000*viewport.width`、`y = bbox[1]/1000*viewport.height`（`w/h` 同理）。**不需要 y 翻转**（pdf.js viewport 空间同样是左上原点、y 向下） | 【实测】（叠加图逐块吻合） |
| C3 | 映射误差：MinerU 侧 `int()` 截断 ≤ **0.61pt(x) / 0.79pt(y)**；对 17 个真实公式块实测，**热区外扩 6pt 后 17/17 完全覆盖公式字形** | 【实测】 |
| C4 | **因此采用「点击公式热区」方案**（不是只能降级的公式列表面板）；列表面板作为次级入口保留 | 【实测】 |
| C5 | 同一页相邻公式块竖直间隙最小 **0.8pt**（实测），6pt 外扩必然重叠 → 必须冻结**拾取规则**（§1.4），否则会点错公式 | 【实测】 |
| C6 | 公式引用只在**原文视图**可用；切到 `-zh`/`-dual` 译文视图必须关闭热区（几何变了）。`-zh` 是否可复用需实测 | 【源码证据】+【推测】 |
| C7 | 论文没有 MinerU 产物时：入口**禁用+说明**，接口返回 **200 + 空列表 + `reason`**，绝不 404/500 崩溃；旧的「选中即问」链路原样保留为兜底 | 【源码证据】 |
| C8 | 删除文献 = **7 类同名产物**（`.pdf` + `.txt`/`.pages.json`/`.transcript.json`/`.mineru.md`/`.mineru.json`/`.embeddings.json`）+ 3 个译文变体（`-en/-zh/-dual`）+ `.tmp-*` 残留，**精确 stem 匹配**（不是前缀匹配） | 【源码证据】 |
| C9 | 删除 = **移动到 `<dataDir>/.trash/`**（可恢复），移动失败**绝不回退 unlink**；删除后**不自动删专题目录**（专题目录是 dsh 会话工作区） | 【源码证据】+【实测】 |
| C10 | 删除专题：**仅允许空专题**（非隐藏条目数为 0），含文献一律 409 | 【源码证据】 |
| C11 | 重命名：**在范围内**，但必须承认并告知「历史伴读会话脱钩」——会话 id 内嵌 `topic/name` 的 base64，会话存储又按专题目录路径分组 | 【源码证据】+【实测】 |
| C12 | 运行中会话 / 进行中翻译 → 删除与重命名一律 **409 拒绝**（不警告后放行） | 【源码证据】 |
| C13 | 安全：所有破坏性路径必须 `topic`+`name` 白名单化 + `realpath` 包含性校验；**不接受 `path` 参数**（现有 `resolvePaper` 支持任意绝对路径，是只读路径的既有行为，不得复用到写路径） | 【源码证据】 |
| C14 | 二次确认必须用**页内 portal 弹窗**（`window.prompt` 在 Electron 渲染进程不可用，本项目已有先例），文案逐条列出将删除的文件 | 【源码证据】 |

---

# 第 1 部分：公式鼠标引用

## 1.1 可行性实测（本任务核心问题）

### 问题

MinerU `content_list` 里 `equation` 块的 `bbox:[x0,y0,x1,y1]` 是什么坐标系？能否可靠映射到 pdf.js 的页面 viewport？【必须实测】

### 实测方法

1. 本机 MinerU 3.4.5（`http://127.0.0.1:8000`，legacy `/file_parse`）解析真实论文，取 `content_list` 的 equation 块；
2. 用 pdf.js 6.4.299（本仓库 `node_modules/pdfjs-dist`，与 `reader/vendor/pdf.min.mjs` 同源）取同一页 `getViewport({scale:1})` 与 `getTextContent()`；
3. 把 bbox 按假设映射成矩形，与 pdf.js 的真实字形包围盒（glyph union）做定量比对；
4. 再把矩形**画到真实渲染页面上**做目视复核（叠加图，见 §7 图 1/图 2）。

### 样本

| 样本 | 来源 | 页 | equation 块数 |
|---|---|---|---|
| A | 用户**真实文献库**：`<dataDir>/默认专题/Hansen et al. - 2024 - TD-MPC2 ….pdf` + 其 `.mineru.json` | page_idx 2/3/27/29（= PDF 第 3/4/28/30 页） | 12 |
| B | `/home/vr/zotero-pdf2zh/server/translated/Gu et al. - 2022 - Vector Quantized Diffusion Model ….pdf`（单页解析） | PDF 第 5 页 | 5 |

### 结论：bbox 是「页面归一化坐标 ×1000」

【源码证据】MinerU 3.4.5 本机实现（`/home/vr/.venvs/paper-share/lib/python3.12/site-packages/mineru/`）：

```python
# backend/pipeline/pipeline_middle_json_mkcontent.py:478-490
def _build_bbox(para_bbox, page_size):
    if not para_bbox or not page_size:
        return None
    page_width, page_height = page_size
    x0, y0, x1, y1 = para_bbox
    return [
        int(x0 * 1000 / page_width), int(y0 * 1000 / page_height),
        int(x1 * 1000 / page_width), int(y1 * 1000 / page_height),
    ]
```

- 同一归一化在 **vlm 后端**（`backend/vlm/vlm_middle_json_mkcontent.py:520-529`、`748-757`）里逐字相同 → mineru.net v4 云端（走 vlm 后端）**大概率同构**，但版本不同，仍按 §6 的「必须实测」项验证。
- `page_size` 来自 pdfium `page.get_size()`（`backend/pipeline/model_json_to_middle_json.py:33, 256-262`），单位是 pt（letter = `[612,792]`）。
- **归一化是按页宽/页高各自除的**（不是等比缩放）→ 把页面拉成正方形。所以**绝不能**用同一个比例尺去套 x 和 y，必须分别除以页宽/页高。

实测比值（样本 B 第 5 页，letter 612×792pt）：content_list 空间横向比值 `≈1.6314`、纵向 `≈1.2603`，两者之比 `1.2945 ≈ 792/612`，即横向被额外拉伸了 `页高/页宽` —— 正是「归一化到正方形」的指纹。【实测】

### 结论：内容坐标 ↔ pdf.js viewport 的映射

```js
// viewport 就是 reader/index.html:459 已有的那一个：page.getViewport({ scale: zoomScale })
const x = bbox[0] / 1000 * viewport.width;
const y = bbox[1] / 1000 * viewport.height;
const w = (bbox[2] - bbox[0]) / 1000 * viewport.width;
const h = (bbox[3] - bbox[1]) / 1000 * viewport.height;
```

- **原点**：左上，y 向下（content_list 的 `y0<y1`，且页顶的块 y 小）。【实测】
- **不需要 y 翻转**：pdf.js 的 viewport 空间同样是左上原点 y 向下，两者同向。【实测】（叠加图若需翻转会整体上下镜像，实际逐块吻合）
- **与缩放无关**：`viewport.width/height` 已含 `scale`，所以 0.6x~4.5x（`reader/index.html:495` 的钳制区间）下同一公式自动跟着缩放走，无需重算比例。【源码证据】+【实测（scale=1；线性关系，scale=2 时 width/height 各 ×2）】
- **与旋转**：样本 A/B 全部页 `rotate=0`（【实测】）。含 `/Rotate` 的 PDF **未实测** → 见 §6 风险 R1 与 §5 的必须实测项。

### 定量误差（关键交付）

**误差源 1：MinerU 的 `int()` 截断**（源码见上）。1 个归一化单位 = `页宽/1000 pt = 0.612pt`（x）/ `页高/1000 pt = 0.792pt`（y）。
与 MinerU 自己未量化的 `middle_json.para_blocks[].bbox`（同为 pts）比对（样本 B 第 5 页全部 **19 块**，按中心点最近配对），实测最大残差 **x 0.59pt / y 0.78pt** → 两项都**落在理论界（0.612 / 0.792）之内**，说明残差就来自 `int()` 截断，映射本身没有系统性偏差。【实测】

**误差源 2：MinerU 版面块 bbox vs pdf.js 字形包围盒**（块 bbox 是版面框，可能比字形宽/紧，短公式尤其明显）。逐块对比（矩形 = bbox 映射结果，字形 = pdf.js 实际 glyph 并集）：

| 样本 | 页 | 块 | 预测矩形内字形数 | IoU | 最大「欠覆盖」（字形在矩形外）|
|---|---|---|---|---|---|
| B | p5 | EQ0 | 32 | 0.892 | 0 |
| B | p5 | EQ1 | 128 | 0.944 | 0 |
| B | p5 | EQ2 | 27 | **0.745** | **3.61pt（上边）** |
| B | p5 | EQ3 | 54 | 0.966 | 0.1pt |
| B | p5 | EQ4 | 24 | 0.927 | 0 |
| A | p3 | EQ0/EQ1 | 43/109 | 0.914/0.919 | 0 |
| A | p4 | EQ0..EQ3 | 107/87/47/78 | 0.868/0.946/0.952/0.929 | 0 |
| A | p28 | EQ0/EQ1 | 27/7 | 0.907/0.801 | 0 |
| A | p30 | EQ0..EQ3 | 43/35/27/33 | 0.784/0.800/**0.529**/0.897 | **4.60pt（下边）** |

- 欠覆盖最坏 **4.60pt**（样本 A p30 EQ1 下边）。IoU 最低 0.529（短的居中公式，MinerU 版面框横向明显宽于字形——**过覆盖无害**）。
- **外扩 PAD=6pt（scale=1 时 6px）后：17/17 个公式块的全部字形都落在热区内**（脚本实测 `PAD=6 covers ALL glyph runs: true`）。【实测】
- 目视复核：样本 B 第 5 页与样本 A 第 4 页的叠加图上，5 个 / 4 个红框全部精确扣在公式 (8)(9)(10)(11)(12) / (3)(4)(5)(6) 上（见 §7 图 1、图 2）。【实测】

**判定：bbox 可靠。** 热区方案成立，无需降级；外扩 6pt 即可覆盖实测最坏欠覆盖（4.60pt，余量 1.4pt）。

> 若不外扩，样本 A p30 EQ1 的下边会漏 4.6pt ⇒ 公式下半部分点不中。**PAD 是必需项，不是优化项。**

## 1.2 与产物落盘的对应关系

- `.mineru.json` 结构（【实测】用户真实产物）：`{v, producer, createdAt, serverVersion, backend, pageCount, imagesAvailable:false, contentList:[…]}`。
- equation 块字段：`{type:'equation', img_path, text:'$$\n…$$', text_format:'latex', bbox:[x0,y0,x1,y1], page_idx}`。【实测】
- **`page_size` 不在产物里**（只在 `middle_json.pdf_info[].page_size`，而 `src/transcribe.ts:483-500` 的 `mineruJsonPayload` 不落 `middle_json`）。**但不需要它**——bbox 已是页宽/页高归一化，映射只需 pdf.js 的 `viewport`。【源码证据】+【实测】
- `imagesAvailable:false` ⇒ `img_path` 指向的公式切图**没有落盘**（悬空引用）。若将来要「悬停预览公式图」，需要在 `transcribe.ts` 落盘 `images/`（**本轮不做**，超出范围）。【源码证据】
- 页号映射：`page = page_idx + 1`（`src/mineru.ts:606-622`）。样本 A 实测 page_idx=3 的公式确实在第 4 页（叠加图吻合）。【实测】
- ⚠️ 实现注意：`start_page_id`/`end_page_id` 是 **0-based 且 `page_idx` 相对子集**（实测 `start_page_id=4` 返回的是 PDF 第 5 页，且其 `page_idx=0`）。本插件的 `buildLocalForm`（`src/mineru.ts:683-701`）**不传** start/end page，所以 `page_idx` 是绝对的，`+1` 规则安全。**下游不得给 MinerU 请求加 start_page_id 而不改页号换算。**【实测】
- 块顺序：`contentList` 是「先左栏后右栏」的版面序，**不是**全页 y 排序（样本 B 第 5 页 5 个公式的 `bbox[1]` = 486,688,809,409,511）。面板/列表必须按 `(page_idx, bbox[1], bbox[0])` 重排才是阅读序。【实测】

## 1.3 冻结的交互：点击 PDF 上的公式 → 发生什么

**触发**：在 `.page[data-page]` 上发生「无拖拽的单击」（mousedown 与 mouseup 距离 ≤3px），且 `window.getSelection().toString().trim() === ''`（有选区时**选中即问优先**，不得抢）。

**命中判定**（见 §1.4 拾取规则）→ 命中第 i 个公式：

1. **弹出既有的提问气泡 `#ask-pop`**（`reader/index.html:119-121`），不新增第二个弹层：
   - `#ask-quote` 显示 `第 {page} 页 · 公式 {k}`（k = 该页按 `(bbox[1],bbox[0])` 排序后的序号）+ LaTeX 预览（去换行、去外层 `$$`、超 140 字截断——沿用 `reader/index.html:583` 的截断风格）。
   - **不伪造公式编号**：MinerU 的 `text` 里没有 `(8)` 这种编号（编号在正文文本层里），所以标签只用「页 + 序号」。【实测】
   - `#ask-input` 清空并聚焦（沿用现有行为）。
   - **不自动写剪贴板**（静默覆盖用户剪贴板是意外副作用，且 Electron 渲染进程剪贴板权限不确定）。气泡内提供显式 **「复制 LaTeX」** 按钮，点击后 toast「已复制公式 LaTeX」。【决策】
2. **高亮该公式区域**：给对应热区加 `.eq-hit`（1.5px 虚线 `--accent` 描边），mousedown 在别处时随 `clearHighlights`（`reader/index.html:523-527`）一起清除。
3. **发送时的引用内容**（`/api/ask` 的 `selectedText`）：`$$ <latex> $$`（保留 `$$` 定界，模型对数学最友好），并新增字段 `kind:'equation'`、`page`、`equationIndex`。`selectedText` 里**不要**塞「第 N 页」以外的说明文字（页码已由既有 `page` 字段承载）。
4. **会话里的呈现**：`src/host.ts:741-749` 现在写死「用户在阅读器里选中了一段文字（选中于第 N 页）：""…""」。命中公式时必须换文案（按 `kind==='equation'` 分支）：
   ```
   用户在阅读器里引用了第 N 页的一个公式（LaTeX 源，来自 MinerU 版面解析）：
   $$ … $$
   用户的问题：…
   ```
   对话区是 dsh 原生渲染，`$$…$$` 是否渲染成公式由 dsh 决定；**因此同时保证「即使不渲染也读得懂」**（有中文说明行 + LaTeX 原样可见）。【决策】
5. **事件顺序（必须照做）**：现有代码在 `mousedown` 隐藏气泡（`reader/index.html:595`）、在 `mouseup` 里判断选区（`573-594`）。公式分支必须写在**同一个 mouseup 处理函数**里、在「无选区即隐藏」之前，**不要**新增独立 listener（会出现「hide 与 show 相互打架」的双弹层的竞态）。【源码证据】
6. **命中区域不拦截鼠标事件**：热区**不用** `pointer-events:auto` 的覆盖层实现（会夺走 textLayer 的 mousedown/拖拽选区，破坏既有的划词提问）。改为：
   - 行为：在页面容器上做**坐标命中测试**（JS 计算，见 §1.4）；
   - 视觉：一个 `pointer-events:none` 的 `.eqLayer`（每页一个，`position:absolute; inset:0; z-index:2`）只负责画 hover/命中的描边；
   - hover：`#pdf-pages` 上节流的 `mousemove`（位移 ≥2px 才重算），命中则给该热区加 `.eq-hover` 并把页面 `cursor` 设为 `pointer`，否则还原。
   【决策/源码证据：`reader/index.html:43-66` 说明 textLayer 是绝对定位、必须保住其鼠标交互】

## 1.4 热区几何与拾取规则（必须逐条实现）

对每个 `equation` 块（`page_idx` 有值、`bbox` 是 4 个有限数的数组）：

```
PAD_PT  = 6                                    // 实测最坏欠覆盖 4.60pt；6pt 覆盖全部 17/17
PAD     = PAD_PT * zoomScale                   // 渲染是 CSS px，缩放时同步放大
rect    = { x: bbox[0]/1000*vw, y: bbox[1]/1000*vh,
            w: (bbox[2]-bbox[0])/1000*vw, h: (bbox[3]-bbox[1])/1000*vh }
rect 必须裁剪进 [0,vw]×[0,vh]；w/h ≤ 0 的块丢弃（不生成热区，但仍进列表面板）
```

**拾取规则（重叠时不许随机）**：

1. 优先取**未外扩矩形**包含点击点的热区；
2. 否则取**外扩后矩形**包含该点的热区，选「点到未外扩矩形距离平方」最小者；
3. 仍并列时取**面积小**的；再并列取阅读序靠前的；
4. 都没有 → 不是公式点击，走原有逻辑。

依据：同一页相邻公式块竖直间隙最小实测 **0.8pt**（样本 A p30：三块 y 依次 420.6-441.9 / 442.7-476.8 / 477.6-511.6），6pt 外扩后相邻热区必然互相重叠 11pt 以上。【实测】

## 1.5 公式列表面板（次级入口，同时是缺失时的降级形态）

- 工具栏新增按钮 `#eq-toggle`（`∑ 公式`），放在缩放按钮右侧（`reader/index.html:100-110` 的 `#bar`；注意 `.tbtn` 是 `flex:none`，缩窄列时不被压缩）。
- 右侧滑出面板 `#eq-panel`（`position:absolute`，覆盖 PDF 面板，宽 ≤320px，独立滚动）：
  - 按页分组：`第 N 页` → 公式条目（`公式 k`）→ LaTeX 等宽字体原文（`esc()` 转义，`reader/index.html:169`）；
  - 每条点击 = 与热区点击**同一条链路**（同一个 `insertFormula(eq)` 函数，气泡/引用文案完全一致）；
  - 每条带「复制」按钮；
  - 顶部显示数据来源（`MinerU 本地解析 · 3.4.5` 或 `MinerU 云端`），来自 `.mineru.json` 的 `producer`/`serverVersion`。
- 面板是**必需**的（不只是可选）：它承担 ① 缺失 MinerU 时的说明落点；② 热区点不中（欠覆盖边缘）时的补救；③ 检索/抄写 LaTeX 的入口。
- **代价（诚实记录）**：纯列表面板路径下，用户必须自己把「页面上的公式」和「列表里的条目」对上（无空间对应关系，也没有公式切图可预览，因为 `imagesAvailable:false`）。热区版消除了这个心智负担，所以热区是主路径、面板是补充。

## 1.6 缺失 / 降级路径（不许崩）

**新接口 `/api/formulas` 的错误处理约定：业务性缺失一律 200 + 空列表 + 机器可读 `reason`**（避免前端任何 `catch` 未覆盖的路径把阅读器打崩；`reader/index.html:639-642` 的 bootstrap catch 会把整页变成错误文案）。

| 情形 | `/api/formulas` | 阅读器表现 |
|---|---|---|
| 有 `.mineru.json` 且有 equation | `200 {source:'mineru', equations:[…]}` | 热区 + 面板正常 |
| `.mineru.json` 有但无 equation | `200 {source:'mineru', equations:[], reason:'no-equations'}` | 面板：「本论文未解析出公式」；无热区 |
| 无 `.mineru.json`（纯 pdfjs 缓存 / 未转录） | `200 {source:'none', equations:[], reason:'no-mineru-artifact'}` | `#eq-toggle` 置灰，title/面板说明：「需要 MinerU 解析产物」+ 两个按钮：**「用 MinerU 重新转录」**（`POST /api/transcribe {force:true, source:'mineru-local'}`，`src/host.ts:656-665`；显式 source 不受 `mode:off` 阻挡，`src/transcribe.ts:260-261`；本地默认 `http://127.0.0.1:8000`，`src/mineru-config.ts:72`）与「去设置」 |
| `.mineru.json` 存在但 JSON 损坏 / `contentList` 不是数组 / 字段类型不对 | `200 {source:'mineru', equations:[], reason:'bad-artifact', warning:'…'}`（**不得 500**） | 面板显示 `reason` 对应文案；无热区；旧链路照常 |
| `equations` 有条目但 `bbox` 缺失/非法 | 该条仍返回（面板可用），`bbox:null` | 不生成热区；面板条目标注「无位置信息」 |
| 译文视图（`zhVariant !== null`） | 接口正常返回 | **关闭热区**（面板保留但条目点击仅插入 LaTeX，不画热区），面板顶部提示「译文视图无位置信息，切回原文可点击公式」。理由：`-dual` 是并排双页、`-zh` 是重排页，`.mineru.json` 的 bbox 只对**原文页**成立。【源码证据 `src/translate.ts:3,31-36,225-231`】+【推测：`-zh` 页尺寸是否与原页一致需实测，见 R2】 |

兜底不动：`/api/ask` 的文字选中链路、`askSelection`、`jumpTo`/`highlightSnippet` 全部保持原样。【源码证据】

## 1.7 接口契约：`GET /paper-reader/api/formulas`

| 项 | 值 |
|---|---|
| 方法/路径 | `GET /paper-reader/api/formulas?topic=&name=`（也允许 `path=`，沿用 `locate()`，`src/host.ts:139-148`） |
| 鉴权 | 无需新代码：全部路由都在 `/paper-reader` 前缀注册里，命中 `connection.requestRejection`（`src/host.ts:770-786`）；**新路由必须写在 `dispatch()` 内部**，不得另开注册口 |
| 200 | `{ source:'mineru'\|'none', producer:'mineru-local'\|'mineru-cloud'\|null, backend:string\|null, pageCount:number, pageSize:null, equations:[{ id:string, page:number, pageIdx:number, index:number, bbox:[number,number,number,number]\|null, latex:string, textFormat:'latex'\|null }], reason?:'no-mineru-artifact'\|'no-equations'\|'bad-artifact', warning?:string }` |
| 说明 | `id` = `` `${pageIdx}:${i}` ``（页内稳定序号，供前端去重/定位）；`page = pageIdx+1`；`bbox` 原样透传（**0..1000 归一化**，不要在服务端换算成 pt，前端才有 `viewport`）；`latex` 原样含 `$$` |
| 404 | 文献不存在（`resolvePaper` 抛错）→ 由外层统一 404/500（`src/host.ts:780-785`） |
| 500 | 仅真异常 |
| 缓存 | 服务端按 `(mineruJsonPath, mtimeMs, size)` 记忆化；文件变了自动失效。**不要**每次渲染都读 150KB JSON【性能要求】 |

被引用的既有路由（保持兼容，不动语义）：`GET /api/library`（261）、`POST /api/library/topic`（267）、`POST /api/library/upload`（281）、`GET /api/paper`（352）、`POST /api/ask`（712）。

---

# 第 2 部分：文献管理（删除 / 重命名）

## 2.1 现状（源码证据）

- 路由只有 `list / create-topic / upload`，**没有任何删除接口**（`src/host.ts:261-309`）——用户说的「不能删除」属实。【源码证据】
- 目录约定（`src/library.ts:1-9, 81-92`）：`<dataDir>/<专题>/<文献>.pdf` + 同名派生产物。
- `dataDir` 解析：显式配置 > `DSH_PAPER_READER_DATA` > `~/.dsh-paper-reader/data`（`src/library.ts:48-54`）。
- `listTopics` 跳过隐藏目录（`startsWith('.')`，`src/library.ts:56-63`）→ `.trash` 天然不进文献库。
- `isPaperPDF` 把 `-en/-zh/-dual` 结尾的文件排除在「用户文献」外（`src/library.ts:33-40`）。

## 2.2 删除一篇文献：产物清单（必须逐一处理）

对 `topic/name`，删除集合 = **精确 stem 相等**的下列文件（同目录内）：

| # | 文件 | 生成者 / 依据 |
|---|---|---|
| 1 | `<name>.pdf` | 用户上传（`src/host.ts:281-309`）；`PaperRef.pdfPath`（`src/library.ts:86`） |
| 2 | `<name>.txt` | 转录缓存（`src/library.ts:87`，写于 `src/transcribe.ts:342,421`） |
| 3 | `<name>.pages.json` | 页码索引（`src/library.ts:88`） |
| 4 | `<name>.transcript.json` | 来源/提交标记（`src/library.ts:89`） |
| 5 | `<name>.mineru.md` | MinerU Markdown（`src/library.ts:90`） |
| 6 | `<name>.mineru.json` | MinerU content_list（`src/library.ts:91`） |
| 7 | `<name>.embeddings.json` | 语义检索向量缓存（`src/embed.ts:58-60` 的 `embeddingsPathFor`） |
| 8 | `<name>-zh.pdf` | pdf2zh 纯中文（`src/translate.ts:31-33`） |
| 9 | `<name>-dual.pdf` | pdf2zh 中英对照（`src/translate.ts:34-36`） |
| 10 | `<name>-en.pdf` | pdf2zh 同族变体（`src/library.ts:33` 的 `PDF2ZH_SUFFIXES`；**存在才删**） |
| 11 | `<name>.<上述后缀>.tmp-<pid>-<8hex>` | `atomicWrite` 半成品残留（`src/transcribe.ts:327-336` 的 `atomicTempPath`）——存在才删 |

**匹配规则（关键，防误删）**：枚举专题目录 `readdir`，对每个条目做**精确 stem 判定**（不是 `startsWith(name)`！）：

```
ACCEPT if  entry === name + S              for S in ['.pdf','.txt','.pages.json','.transcript.json',
                                                     '.mineru.md','.mineru.json','.embeddings.json']
ACCEPT if  entry === name + V + '.pdf'     for V in ['-en','-zh','-dual']
ACCEPT if  entry === name + S + '.tmp-' + digits + '-' + 8 hex chars   (同上 S 集合)
REJECT otherwise
```

正例/反例（**验收必须覆盖**）：删 `Attention` 不得删 `Attention Is All You Need.pdf` / `Attention2.pdf` / `Attention-zh.txt`（不存在的后缀不猜）；删 `X-zh` 这种名字要能删掉（虽然 `isPaperPDF` 会让它不出现在库里——**重命名时必须禁止把新名取成 `-en/-zh/-dual` 结尾**，见 §2.5 S12）。

**不该删（白名单外一律不动）**：
- `<dataDir>/.venv-pdf2zh/`（babeldoc 共享 venv，多篇文献共用；`src/translate.ts:55-65` 的候选路径）。**绝不删。**
- `<dataDir>/.pdf2zh-tmp/`（共享翻译草稿目录，`src/translate.ts:187`）。**默认不删**（别的文献可能正在用；且删除中的文献若有进行中翻译本来就会被 409 拦下）。可选优化：仅当**全库无进行中翻译**时清理以 `<name>.` 开头的文件——标记为可选。
- 别的文献的任何文件（含同前缀不同 stem）。
- 专题目录本身（见 C9：不自动删专题目录）。
- `.trash/` 里已有的内容（回收站自身）。

## 2.3 删除专题

- **只允许删空专题**：`readdir(join(dataDir, name), {withFileTypes:true})` 中**非隐藏条目数为 0** 才允许；否则 `409 {code:'topic-not-empty', entries:[…], papers:[…]}`，UI 提示「专题内还有 N 篇文献，请先删除或移出」。
  - 依据：不做递归删除 = 不可能误删；用户要删整个专题时逐篇删（每篇都有独立确认与回收站）。【决策】
  - 隐藏条目（`.DS_Store` 等）不阻塞删除，但**也不删**（目录删除用 `rmdir` 语义：非空则失败，失败即 409/500，**绝不用 `rm -rf`**）。
- 专题名校验与创建一致：非空、不含 `/ \`、不含 `..`、不以 `.` 开头（`src/host.ts:267-279` 的既有正则 + 新增「不以 `.` 开头」）。
- **删空专题后遗留**（必须在确认框写明的副作用）：① dsh 里该专题的工作区注册会变成悬空条目（插件没有注销 API，`src/host.ts:202-213` 只有 `create`）；② `~/.dsh/sessions/<专题路径编码>/` 下的会话历史目录**不删**（不属于本插件的数据，也没有删除 API）→ 历史仍在磁盘、但树上看不到。③ 必须清掉 `workspaceCache` 里对应项（否则同名专题重建后会复用指向已删路径的 workspaceId）。【源码证据：`src/host.ts:201-213`】

## 2.4 删除文献的落盘语义（可恢复）

**冻结为「移入回收站」而不是 unlink**：

1. 目标目录：`<dataDir>/.trash/<UTC 时间戳 `YYYYMMDDTHHMMSSZ`>-<随机 6 位>/`（**与 dataDir 同文件系统**，用 `rename` 保证原子；目录权限 0700）。
2. 把 §2.2 的文件**原文件名**移入该目录，写 `manifest.json`：
   ```json
   { "v":1, "kind":"paper", "topic":"…", "name":"…", "deletedAt":"…",
     "files":[{"name":"…","bytes":123,"kind":"pdf|cache|mineru|embed|variant"}],
     "sessions":2, "note":"…" }
   ```
3. **顺序：`<name>.pdf` 最后移**。不变量：中途失败 ⇒ 文献仍在文献库里可见可用（只是缓存可能已进回收站，重问会自动重转录），错误响应必须说清「已移动哪些、还剩哪些、回收站在哪」。
4. **移动失败绝不回退 `unlink`**，且**errno 分流**（PR #5 上游必修 3 + 评审 F-G 之后的现行语义）：
   - `EBUSY` / `EPERM`（Windows 文件被阅读器/杀软/索引/同步盘占用）→ **`409 {code:'file-busy', busy, moved, remaining, rolledBack, rollbackFailed, trashRel, cause}`**，
     文案「文件被占用（可能正在阅读器或其他程序中打开），关闭后重试」；
   - 其余 errno → **`500 {code:'trash-move-failed', moved, remaining, rolledBack, rollbackFailed, trashRel, cause}`**；
   - **失败即回滚**：先把本次已移动的文件 `rename` 回原位（rename，不是 unlink），`rollbackFailed` 非空时必须如实列出并降级文案；
   - **错误响应只回相对 `trashRel`**（+ 文件名），**不**带绝对路径；绝对 `trashDir` 只出现在 **200 成功响应**（O4 裁定：成功响应里那是刻意的恢复线索）。
5. 本轮**不做自动清理**（回收站不设过期）；`.trash` 不会被 `listTopics`/`listPapers` 看到（隐藏目录）。
6. 恢复：本轮只提供**文档化的人工恢复**（把文件从 `.trash/…/` 移回专题目录即可）。一键恢复 UI = 后续可选项。
   【决策 + 源码证据：`listTopics` 跳过 `.` 开头目录】

## 2.5 重命名 / 移动 —— 范围结论

**结论：重命名「文献」与「专题」都在本轮范围内；「移动文献到另一专题」不在本轮（见 S14）。**

理由与代价（会话脱钩是硬约束，必须如实告知用户）：

- 伴读会话 id = `dpr-` + `base64url(topic + '/' + name)` + `-n`（`src/host.ts:151-152`）；会话存储又按**专题目录路径**分组（实测：`~/.dsh/sessions/--home-vr-.dsh-paper-reader-data-<专题>--/dpr-<b64>-1/`）。
- ⇒ **重命名文献**：新名下 `scanPaperSessions` 找不到旧会话（`src/host.ts:157-175` 前缀匹配）→ 历史会话**不删除但脱钩、树上看不到**。
- ⇒ **重命名专题**：会话分组目录名（按路径编码）随之失效 → 整个专题的历史会话同样脱钩。
- 插件没有「重命名会话」的 API（`sessionController` 只有 list/create/follow/prompt；`workspaceRegistry` 只有 archive）。所以本轮的诚实语义是：**重命名 = 文件改名 + 历史会话脱钩**，UI 确认框必须逐字写明，并把脱钩会话数（`detachedSessions`）回显给用户。
- 重命名文献必须**同步迁移全部 §2.2 的 7 类同名产物 + 3 个译文变体**（否则 `-zh.pdf` 变成孤儿，`isPaperPDF` 又把它当变体排除 → 变成永远看不见也删不掉的垃圾文件）。
- **不提供跨专题移动**：移动 = 目录变更 + `workspaceCache`/工作区注册 + 会话分组目录三者协同，风险与收益不匹配；用户可「删除到回收站 + 重新上传到目标专题」达到同等效果（可恢复、路径简单）。【决策】

## 2.6 安全规则（逐条可核对，破坏性操作专用）

| ID | 规则 | 依据 |
|---|---|---|
| S1 | **写路径只接受 `topic` + `name`**（都不含 `/ \`、不含 NUL、不以 `.` 开头、不等于 `.`/`..`、非空、长度 ≤255）。删除/重命名路由**拒绝 `path` 参数**（400 `escape-rejected`）。 | `resolvePaper` 的 `path` 分支接受任意绝对路径（`src/library.ts:98-107`），只读没问题，写路径会变成任意文件删除 |
| S2 | **`realpath` 包含性校验**（纵深防御）：对 `dataDir` 与目标（目录与每个文件）分别 `realpathSync`，要求 `targetReal === dataDirReal` 的严格子路径（`startsWith(dataDirReal + sep)`），且目标 ≠ dataDir 自身。不满足 → 400 `escape-rejected`。 | 防符号链接专题目录 / 目录内符号链接文件逃逸 |
| S3 | **不跟随符号链接删除**：目标文件 `lstat().isSymbolicLink()` ⇒ 只删除（移入回收站）该链接本身，**绝不**对 `readlink` 目标动手；专题目录是符号链接 ⇒ 直接 400。 | 同上 |
| S4 | 名称校验与创建保持一致（`src/host.ts:271` 的 `/[/\\]\|\.\./`），并加「不以 `.` 开头」「`basename(name)===name`」。 | 一处放行=处处可绕 |
| S5 | **精确 stem 匹配**（§2.2），禁止 `startsWith(name)` 之类的模糊枚举。 | 防「删 A 连带删 A 开头的别的论文」 |
| S6 | 专题删除用**非递归**语义（`rmdir`；非空即失败），禁止 `rm -rf`、禁止 `{recursive:true}`。 | 防越界删除 |
| S7 | **运行中会话 ⇒ 409 拒绝**删除与重命名：目标文献（专题重命名/删除时=该专题内任一篇）存在 `running` 会话即拒（`code:'session-running'`；`running` 来自 `scanPaperSessions`，`src/host.ts:157-175`）。理由：会话工作区/cwd 指向该专题目录（`createPaperSession` 回退 `cwd: join(dataDir, topic)`，`src/host.ts:222-233`），改名或删目录会让运行中的 agent 丢失工作目录与文献。 | 拒绝 > 警告放行（不可恢复） |
| S8 | **进行中翻译 ⇒ 409 拒绝**：目标文献 `zhStatus(ref).busy === true` 时拒绝删除/重命名（`code:'translation-busy'`）。理由：babeldoc 完成后会 `rename(tmpDir/…, dstStem+'-zh.pdf')` 回写文献目录（`src/translate.ts:225-231`），删除后回写会**复活**文件，重命名后回写会写进已废弃的名字。 | 源码证据 |
| S9 | **UI 二次确认**：必须用页内 portal 弹窗（`AskText` 先例，`lib/client.js:530-554`），**禁止** `window.prompt/confirm`（Electron 渲染进程不支持 prompt，见 `lib/client.js:707-708` 的实测注释）。弹窗必须列出**将要处理的文件清单与大小**（来自 dry-run 接口）与**不删的东西**（原文表述：「会移入回收站，可恢复；伴读会话历史不会被删除」）。 | 源码证据 + 决策 |
| S10 | **专题删除要输入专题名确认**（type-to-confirm）；文献删除为「破坏性按钮 + 明确的移入回收站文案」（一篇文献一屏可列全，输入名字反而增加误操作成本）。 | 决策 |
| S11 | 二次确认的**数据必须来自服务端 dry-run**（`delete-plan`），前端不得自行拼文件列表（避免前后端清单漂移）。 | 防「文案说删 3 个，实际删 8 个」 |
| S12 | 重命名 `newName` 不得以 `-en/-zh/-dual` 结尾（否则新名字会被 `isPaperPDF` 判定为非文献 → 文献从库里消失，`src/library.ts:33-40`）。 | 源码证据 |
| S13 | 重命名目标已存在 ⇒ 409 `target-exists`；**大小写-only 改名**（`realpath(源)===realpath(目标)`）放行（macOS/Windows 大小写不敏感文件系统）。 | 兼容性 |
| S14 | 跨专题移动：**本轮不支持**（409/404 不实现即可，文档说明替代路径）。 | 决策（§2.5） |
| S15 | 所有破坏性响应都带**机器可读 `code`**，UI 依据 `code` 分支（不要匹配中文文案）——`reader/index.html:159` 已经是这个约定。 | 源码证据 |
| S16 | 删除/重命名成功后，服务端必须让**客户端缓存失效**：`workspaceCache`（`src/host.ts:201-213`）、any per-paper formula cache（§1.7）；前端 `refresh()` 重新拉 `/api/library`（`lib/client.js:565-567`）。 | 源码证据 |

## 2.7 运行中会话 / 可恢复性：决策汇总

| 问题 | 决策 | 理由 |
|---|---|---|
| 文献有运行中的伴读会话 | **拒绝（409）** | 会话的 cwd/工作区就是专题目录；删除/改名会让运行中的 agent 丢上下文，且无法回滚 |
| 有进行中的 pdf2zh 翻译 | **拒绝（409）** | 完成后会回写产物到文献目录（`src/translate.ts:225-231`），删除后会被复活 |
| 是否可恢复 | **可恢复**：移入 `<dataDir>/.trash/`（同文件系统 rename），保留 `manifest.json`；本轮不自动清理 | 用户核心诉求是「能删」，但误删代价最高；rename 成本几乎为零 |
| 是否保留 PDF、只删派生文件 | **不采用**为默认。派生文件删除只作为**明确的可选项**（`keepPdf:true`）后续再做 | 用户要的是「删掉这篇文献」，只删缓存会造成「删了还在」的困惑；且缓存可重新生成，收益低 |

## 2.8 对外 HTTP 接口契约（全部新增在 `/paper-reader/api/library/*`）

> ### 📌 修订说明（rebase 整合轮追加，2026-10）：**路径名口径有变，语义不变**
>
> 本节（v1.5.0 功能轮冻结）把 5 条路径写成了「我们实现的路径名」。整合到上游 `a574288` 时按队长已定方向
> **「保留上游的路由名与 UI，把我们的加固整合进去」**做了两处口径调整。**下面各条的状态码、错误码、请求体字段名、
> 前置校验与落盘语义全部不变**——变的只是「哪条路径是规范名」，以及把两条路径折叠到同一段 handler：
>
> 1. **规范名换成上游 v1.3.0 的 4 个路径名**，本节 A–E 里我们那 4 个路径名改为**别名**（仍然可用）：
>    `/api/library/paper/delete` ⇄ `/api/library/delete-paper`、`/api/library/paper/rename` ⇄ `/api/library/rename-paper`、
>    `/api/library/topic/delete` ⇄ `/api/library/delete-topic`、`/api/library/topic/rename` ⇄ `/api/library/rename-topic`
>    （映射表 `src/host.ts` 的 `ROUTE_ALIAS`，两族**共用同一段 handler**，实现只有一份）。
>    本节 A 的 `delete-plan` 是我们独有的新增路由，上游没有对应物，**不变**。
> 2. **请求体的键双兼容**：上游 UI 发上游体 —— `rename-topic {topic,to}`、`rename-paper {topic,name,to}`、
>    `delete-topic {topic}`（**仍必须带 `confirmName`**，这是我们的加固语义，比上游「同一按钮点两次」严格更强）、
>    `delete-paper {topic,name}`；我们的别名调用方继续发 `{name,newName}` 一族。handler 内取 `name ?? topic`、`newName ?? to`。
>    `rename-topic` 的响应额外补一个 `topic`（上游读法），其余响应形状以本节为准。
> 3. **UI 落点由 `⋯` 菜单改为行内 `✎`/`🗑`**（见 §2.9 的修订说明），删除确认仍然是「服务端 `delete-plan` 清单 + 页内 portal 弹窗 +
>    专题手输名」——替换掉的是上游的「点两次（3 秒窗口）」arm 交互。
>
> 当前真实状态以 **[docs/mineru-integration.md](mineru-integration.md) §1.6 B / §1.7 / §1.8** 为准（那里是交付面同步）。
> **本节其余内容（含 §2.1–§2.7 的取舍与 §2.8 各条的状态码表）一律保留、不改写。**

> 鉴权/围栏：全部走 `/paper-reader` 前缀注册（`src/host.ts:770-786`），命中 `connection.requestRejection`（401/403），**不得**另开注册口。`Content-Type: application/json`；体积上限沿用现有 `readBody`。

### A. `GET /paper-reader/api/library/paper/delete-plan?topic=&name=`

dry-run，给确认弹窗用。

```json
200 {
  "topic":"…", "name":"…",
  "files":[{"rel":"<name>.pdf","kind":"pdf","bytes":7858004}, …],
  "totalBytes": 7950000, "trashDir": "<dataDir>/.trash",
  "sessions":{"total":2,"running":0},
  "translation":{"busy":false,"hasZh":false,"hasDual":false},
  "notDeleted":["伴读会话历史（dsh 侧保存，不删）","<dataDir>/.venv-pdf2zh（共享翻译环境）","专题目录本身"]
}
404 文献不存在 · 400 名称非法/越界(`escape-rejected`)
```

### B. `POST /paper-reader/api/library/paper/delete`

```jsonc
// 请求
{ "topic":"…", "name":"…" }
```
| 状态 | code | 说明 |
|---|---|---|
| 200 | — | `{ok:true, moved:8, trashDir:"<dataDir>/.trash/<stamp>-<rand>", skipped:[…]}` |
| 400 | `bad-request` / `bad-name` / `escape-rejected` | 缺少参数 / 名称非法 / 路径越界 |
| 404 | `not-found` | 文献不存在（`resolvePaper` 未命中） |
| 409 | `session-running` | 该文献有运行中会话（`sessions:{total,running}` 一并返回） |
| 409 | `translation-busy` | 该文献有进行中的 pdf2zh 翻译 |
| 409 | `file-busy` | 移动/改名被占用（`EBUSY`/`EPERM`）：`{busy, moved, remaining, rolledBack, rollbackFailed, trashRel, cause}`（**已尝试回滚**） |
| 500 | `trash-move-failed` | 其它 errno 的移动失败：`{moved, remaining, rolledBack, rollbackFailed, trashRel, cause}`（**未回退 unlink**，错误响应不含绝对路径） |

### C. `POST /paper-reader/api/library/topic/delete`

```jsonc
{ "name":"…", "confirmName":"…" }   // confirmName 必须严格等于 name，否则 400 confirm-mismatch
```
| 状态 | code | 说明 |
|---|---|---|
| 200 | — | `{ok:true, name, archivedSessionsNote:true}` |
| 400 | `bad-name` / `confirm-mismatch` / `escape-rejected` | |
| 404 | `not-found` | 专题不存在 |
| 409 | `topic-not-empty` | `{entries:[…], papers:[{name}…]}`，**非隐藏条目数为 0 才允许** |
| 409 | `session-running` | 该专题内任一文献有运行中会话 |
| 409 | `translation-busy` | 该专题内任一文献有进行中翻译 |

### D. `POST /paper-reader/api/library/topic/rename`

```jsonc
{ "name":"…", "newName":"…" }
```
200 `{ok:true, name, newName, detachedSessions:n}` ·
400 `bad-name`/`escape-rejected` · 404 `not-found` · 409 `target-exists` · 409 `session-running` · 409 `translation-busy`

### E. `POST /paper-reader/api/library/paper/rename`

```jsonc
{ "topic":"…", "name":"…", "newName":"…" }
```
200 `{ok:true, topic, name, newName, moved:10, detachedSessions:n}` ·
400 `bad-name`（含**以 `-en/-zh/-dual` 结尾**的 `bad-name` 变体）/`escape-rejected` ·
404 `not-found` · 409 `target-exists`（含同名大小写差异的例外处理）· 409 `session-running` · 409 `translation-busy`

### F. `GET /paper-reader/api/formulas` — 见 §1.7

**重命名内部步骤（冻结顺序）**：① 全面校验（S1/S2/S3/S4/S12/S13）→ ② 前置条件检查（S7/S8）→ ③ 逐一 `rename` 目标文件（`.pdf` **最后**）→ ④ 中途失败：把已改名的改回去（best-effort rollback），失败则 `500 {code:'rename-partial', moved:[…], remaining:[…]}` → ⑤ 清 `workspaceCache` + 公式缓存。

## 2.9 UI 落点与 i18n

> ### 📌 修订说明（rebase 整合轮追加，2026-10）：**入口从 `⋯` 菜单改为行内 `✎`/`🗑`**
>
> 整合时按队长已定方向保留**上游 v1.3.0 的 UI 入口**：专题行与文献行各自行内两个按钮 `✎`（重命名）/ `🗑`（删除），
> 悬停出现（`data-dpr-act`），**不再有 `⋯` 下拉菜单**（我们原先的 `menu`/`inlineMenu`/`renDlg` 已删除）。
> `🗑` **一击**即打 `GET /library/paper/delete-plan` 拿服务端清单，然后弹**同一个页内 portal 确认框**
> （`ConfirmDelete`，含 `requireText` 手输专题名）；上游原版的「同一按钮点两次（3 秒 arm）」按裁定 **D2 删除**
> （`armDel`/`clickDelete`/`data-dpr-armed` 零残留，由 `.probe/deploy-check.mjs` 断言）。
> **下面「弹窗内容实例」「i18n 文案」这些设计意图全部保留**（清单仍逐条列出、仍写明「不会删除」项）；
> 变的是触发它的是行内 `🗑` 而不是 `⋯` 菜单项。其余内容**不改写**。

**落点（`lib/client.js`）**：
- 专题行 `S.topicHead`（`790-804`，现在只有一个 `⬆` 上传按钮）→ 增加 `⋯`（`S.iconBtn`）：打开小菜单 `重命名专题` / `删除专题`。
- 文献行（`806-814`，`onClick: () => enter(topic, name)`）→ 行右侧增加 `⋯`：`重命名` / `删除`。**必须 `stopPropagation`**（否则会触发 `enter` 打开会话，`802` 的先例）。
- 菜单/确认弹窗用 `createPortal(…, document.body)`（`825-834` 先例），避免被侧栏 `overflow` 裁剪。
- 确认删除的弹窗内容实例：
  ```
  删除文献「<name>」？
  将移入回收站（可恢复）：共 6 个文件、7.6 MB
    · <name>.pdf  7.5 MB
    · <name>.mineru.json  146 KB
    · <name>.mineru.md  95 KB
    · <name>.txt / .pages.json / .transcript.json
  不会删除：伴读会话历史（2 个）、共享翻译环境
  [取消] [移入回收站]
  ```
  （文件数与字节数**必须来自 `delete-plan` 的响应**，不许前端自己算。）
- 删除专题：额外要求输入专题名；非空专题直接弹「专题内还有 N 篇文献」并禁用删除按钮（来自 409 的 `papers`，或先调 plan）。
- 重命名后：`refresh()`（`565-567`）+ 若被改名的是当前文献，更新 `dpr.last`（`lib/client.js:561,188`）与 `dpr.sessionN.*` 键值前缀（否则会话序号错位）。**【必须实现】**：`lib/client.js:604` 用 `` `dpr.sessionN.${topic}/${name}` `` 读序号。

**i18n 键（`lib/client.js:29-86` 的 `zh`/`en` 两个扁平字典，`t(key)` 取值）**：

| key | zh | en |
|---|---|---|
| `more` | 更多操作 | More actions |
| `rename` | 重命名 | Rename |
| `renamePaper` | 重命名文献 | Rename paper |
| `renameTopic` | 重命名专题 | Rename topic |
| `newName` | 新名称 | New name |
| `delPaper` | 删除文献 | Delete paper |
| `delTopic` | 删除专题 | Delete topic |
| `delConfirmTitle` | 确认删除 | Confirm deletion |
| `delConfirmBody` | 将移入回收站（可恢复）：共 {files} 个文件、{size} | Will be moved to trash (recoverable): {files} files, {size} |
| `delNotDeleted` | 不会删除：伴读会话历史、共享翻译环境 | Not deleted: chat history, shared translation venv |
| `delToTrash` | 移入回收站 | Move to trash |
| `delTopicTypeName` | 请输入专题名「{name}」以确认 | Type the topic name "{name}" to confirm |
| `delDone` | 已移入回收站（{files} 个文件） | Moved to trash ({files} files) |
| `delFail` | 删除失败 | Deletion failed |
| `delBusySession` | 该文献有正在运行的会话，请先结束再删除 | A session is still running — end it first |
| `delBusyTranslate` | 正在生成译文，请等待完成后再删除 | Translation in progress — try again later |
| `delTopicNotEmpty` | 专题内还有 {n} 篇文献，请先逐篇删除 | Topic still has {n} papers — delete them first |
| `renameDone` | 已重命名 | Renamed |
| `renameFail` | 重命名失败 | Rename failed |
| `renameDetached` | 注意：{n} 个历史会话不会删除，但不再显示在列表里 | Note: {n} past chats are kept but no longer listed |
| `renameTargetExists` | 已存在同名文献/专题 | A paper/topic with that name exists |
| `eqTitle` | 公式 | Formulas |
| `eqPanelEmpty` | 本论文未解析出公式 | No formulas parsed for this paper |
| `eqNeedMineru` | 需要 MinerU 解析产物才能点击引用公式 | MinerU output required to click-cite formulas |
| `eqTranscribe` | 用 MinerU 重新转录 | Re-parse with MinerU |
| `eqBadArtifact` | MinerU 产物损坏，已忽略 | MinerU output is corrupt — ignored |
| `eqCopy` | 复制 LaTeX | Copy LaTeX |
| `eqCopied` | 已复制公式 LaTeX | Formula LaTeX copied |
| `eqChip` | 第 {page} 页 · 公式 {k} | p.{page} · formula {k} |
| `eqTranslatedView` | 译文视图没有公式位置信息，切回原文可点击 | No positions in translated view — switch back to the original |
| `eqNoPosition` | 无位置信息 | No position info |

**阅读器侧（`reader/index.html`）的文案目前是中文硬编码**（无 i18n，`#bar` 的按钮 title 等）——新增的公式 UI 沿用中文硬编码，**不要**为此引入 i18n 框架（超范围）。【源码证据：`reader/index.html` 无 i18n 机制】

---

# 第 3 部分：给下游的可执行验收清单

> 标记说明：🔬 = **必须实测**（不接受「看代码觉得对」）；🧪 = 必须有自动化测试（若有测试基建）或手工可复现步骤。

## 3.1 公式引用（实现方 A）

| # | 验收项 | 标记 |
|---|---|---|
| A1 | `GET /api/formulas` 对样本 A（TD-MPC2）返回 12 个 equation，`page` ∈ {3,4,28,30}，`bbox` 每个分量 ∈ [0,1000]，`latex` 含 `$$` | 🔬 |
| A2 | 对样本 B 单页解析产物（若在库中）或任一含公式论文：热区点击命中率 100%（对每个 equation，取其 bbox 中心点做命中测试，必须命中该 equation） | 🔬 |
| A3 | 用渲染叠加（矩形 + 6pt 外扩）在至少 2 个真实页面上目视复核：外扩框**完全包住**公式字形（含上下标、分式、求和上下限） | 🔬 |
| A4 | 相邻公式（样本 A 第 30 页，间隙 0.8pt）点击测试：分别点击三个公式的**各自中心**，三次都拿到正确的 LaTeX（验证 §1.4 拾取规则） | 🔬 |
| A5 | 缩放 0.6x / 1.0x / 2.0x 各测一次 A2：命中率不随缩放变化 | 🔬 |
| A6 | 点击公式 → `#ask-pop` 出现、`#ask-quote` = `第 N 页 · 公式 k`、`#ask-input` 聚焦；发送后 dsh 会话里出现带 `$$…$$` 的用户消息，且文案是「公式」而非「一段文字」 | 🧪 |
| A7 | 拖拽划词仍然可用：在公式热区**内部**起手拖拽选择正文文字 → 弹出的仍是「选中即问」气泡（引用的是选中文字，不是 LaTeX）；热区不得吞掉选区 | 🔬（回归项） |
| A8 | 无 MinerU 产物的文献：`#eq-toggle` 置灰、面板给出「用 MinerU 重新转录」；点该按钮后 `POST /api/transcribe {force:true,source:'mineru-local'}` 成功并刷新出公式 | 🔬 |
| A9 | 把 `.mineru.json` 改成非法 JSON（备份后）→ `/api/formulas` 返回 200 + `reason:'bad-artifact'`，阅读器**不报错不白屏**，文字引用照常 | 🔬 |
| A10 | 切到 `-zh`/`-dual` 视图：热区消失（或明确提示），面板仍可插入 LaTeX；切回原文恢复 | 🔬 |
| A11 | `/api/ask` 的文字链路回归：`kind` 缺省时 prompt 文案与改造前完全一致（逐字对比） | 🧪 |

## 3.2 文献管理（实现方 B）

| # | 验收项 | 标记 |
|---|---|---|
| B1 | `delete-plan` 列出的文件与实际被移动的文件**完全一致**（集合相等） | 🔬 |
| B2 | 同一专题放 `Attention.pdf`、`Attention Is All You Need.pdf`、`Attention2.pdf`：删 `Attention` 后另两个**完好**，且 `Attention.pdf` 的 `.txt/.pages.json/.transcript.json/.mineru.md/.mineru.json/.embeddings.json`（造几个假的）全部进回收站 | 🔬 |
| B3 | 造 `<name>-zh.pdf`、`<name>-dual.pdf`、`<name>.txt.tmp-1234-abcd1234` → 全部被处理 | 🧪 |
| B4 | 删除后 `.venv-pdf2zh/`、`.pdf2zh-tmp/`、其他文献、专题目录**一字未动**（对比 `find` 快照） | 🔬 |
| B5 | 删除中途失败（把回收站目录设为只读或预先占用同名文件）→ 返回 500 + `trash-move-failed`，**`<name>.pdf` 仍在**，缓存文件在回收站可人工恢复，**没有任何文件被 unlink** | 🔬 |
| B6 | 路径穿越：`name='../../etc/passwd'`、`name='/etc/passwd'`、`topic='..'`、`name='a/b'`、`name='\u0000x'`、`topic` 是指向 dataDir 外的符号链接 → 全部 400 `escape-rejected`/`bad-name`，**盘上无任何变化** | 🔬 |
| B7 | 在专题目录里造一个指向 `~/Documents` 的符号链接文件，尝试删除同名文献 → 只删链接（移入回收站），`~/Documents` 内容不变 | 🔬 |
| B8 | 非空专题删除 → 409 `topic-not-empty`，响应里有 `papers`；空专题删除 → 200；`.DS_Store` 存在时仍算空 | 🧪 |
| B9 | 有运行中会话的文献：删除/重命名 → 409 `session-running` | 🔬 |
| B10 | 翻译进行中（可 stub `busy`）→ 409 `translation-busy` | 🧪 |
| B11 | 重命名文献 `X` → `Y`：`X.*` 全部变为 `Y.*`（含译文变体），库里出现 `Y` 不出现 `X`；`detachedSessions` 计数正确 | 🔬 |
| B12 | 重命名 `newName` 以 `-zh` 结尾 → 400 `bad-name`（防止文献从库里消失） | 🧪 |
| B13 | 重命名目标已存在 → 409 `target-exists`；纯大小写改名在大小写不敏感文件系统上放行 | 🧪 |
| B14 | 重命名/删除后：`workspaceCache` 失效、`/api/library` 立即反映新状态（不重启进程） | 🔬 |
| B15 | 二次确认弹窗出现且**列出文件清单**；取消 → 0 个请求发出（或至少服务端无变化）；无 `window.confirm/prompt` 调用 | 🧪 |
| B16 | 鉴权回归：未带合法浏览器会话时，所有新路由返回 401/403（由 `connection.requestRejection` 拦下），**不得**因为「新路由写在注册外」而裸奔 | 🔬 |
| B17 | 删除专题后同名专题可重建，且新建会话挂到新工作区（无陈旧 workspaceId 复用） | 🔬 |

## 3.3 集成/回归

| # | 验收项 |
|---|---|
| C1 | 现有链路零回归：上传、新建专题、新建会话、`/api/pdf`、译文生成与切换、`search_paper`、选中即问 |
| C2 | `docs/` 之外无改动（`git status --porcelain` 只显示 `docs/reader-ux-requirements.md` 及本轮 docs 文件） |
| C3 | 本文档 §1.1 的两张叠加图可复现（脚本与命令见 §7） |

---

# 第 4 部分：范围与不做

**In scope（下游）**：`src/host.ts`（新路由 / delete-plan / rename）、`src/library.ts`（删除清单/精确匹配/路径校验的纯函数）、`src/transcribe.ts`（如需导出 formula 读取）、`lib/client.js`（菜单/确认弹窗/i18n）、`reader/index.html`（热区、命测、面板、引用气泡）。

**Out of scope（本轮明确不做）**：
1. 公式切图预览（`imagesAvailable:false`，需要改转录落盘）。
2. 跨专题移动文献（§2.5）。
3. 回收站一键恢复 UI 与自动过期清理。
4. 会话重命名 / 会话历史迁移（无 API）。
5. `-zh`/`-dual` 视图的 bbox 重投影。
6. 阅读器 i18n 框架化（阅读器侧保持中文硬编码）。
7. 修改 MinerU 管线（不碰 `start_page_id` 语义、不改 `.mineru.json` 结构）。

---

# 第 5 部分：未验证项与风险（必须带进实现）

| ID | 风险 | 现状 | 要求 |
|---|---|---|---|
| R1 | `/Rotate` ≠ 0 的页面 | 样本 A/B 全为 0（实测） | 🔬 实现时找一份旋转页 PDF 实测一次；若不一致，热区方案对旋转页**关闭**（列表面板兜底）。映射公式改用旋转后的 viewport 尺寸本身即自动正确（`viewport.width/height` 已含旋转），只需确认 MinerU 的 `page_size` 也是旋转后的尺寸 |
| R2 | `-zh`（mono）译文版是否可复用热区 | 【推测】页尺寸应当一致、公式未被翻译 ⇒ 可能可复用 | 🔬 实测 `-zh.pdf` 与原文的 `getViewport({scale:1})` 是否相同；相同则可开启热区（额外验证 2~3 个公式），不同则维持 §1.6 的关闭策略 |
| R3 | mineru.net v4 云端的 bbox 归一化 | 本机 3.4.5 的 vlm 后端同构（源码），但云端版本未知 | 🔬 用 1 页 PDF 走 cloud 后端实测：断言所有 bbox 分量 ≤1000 且 min ≥0；若发现不是 ×1000，前端命中逻辑按 `pageSizeRatio` 自适应（**不要把 1000 写死成不可配置常量**——保留一个 `normalize:1000\|'auto'` 判据：若页内最大 bbox 分量 >1000，则判定为 pt 并改走 `bbox*scale` 分支） |
| R4 | 大 PDF 性能 | `.mineru.json` 实测 146KB / 12 公式；31 页 266 块 | 服务端按 mtime 记忆化（§1.7），前端只在 `openPaper` 拉一次 |
| R5 | 并发删除/重命名（多标签页） | 无锁 | 破坏性操作期间对同一 `topic/name` 加进程内互斥（Map<key, Promise>），第二个请求 409 `in-progress` |
| R6 | 回收站增长 | 无清理 | 文档化 + `delete-plan` 返回 `trashDir`；后续可加「清理回收站」入口（不在本轮） |
| R7 | 会话脱钩 | 不可避免（§2.5） | 确认框必须告知；`renameDetached` i18n 文案必须出现 |

---

# 第 6 部分：对上游结论的修正（供队长归档）

1. **任务书里「第 4 页有 5 个 equation 块」的说法需要修正为「按 MinerU 的 0-based 页索引 4（= PDF 第 5 页）有 5 个 equation 块」**：`start_page_id=4` 返回的是 PDF 第 5 页，且该单页解析结果的 `page_idx` 是**相对子集**的 0。用户真实库中的论文（TD-MPC2，31 页）在 page_idx 2/3/27/29 上另有 12 个 equation 块，是更好的验证样本。【实测】
2. **`.mineru.json` 里没有 `page_size`**，但这**不是**阻碍：content_list 的 bbox 已归一化，pdf.js 的 `viewport` 足够完成映射。真正缺的是**公式切图**（`imagesAvailable:false`）——只影响「悬停预览」这一可选体验，不影响热区点击。【源码证据 + 实测】
3. **用户库里的真实论文足以做端到端验收**，不必依赖 `~/zotero-pdf2zh/...` 的外部样本；两者本次都验证过，结论一致。【实测】

---

# 第 7 部分：证据与复现

## 7.1 环境

- MinerU 3.4.5 本地：`curl -s http://127.0.0.1:8000/health` → `{"status":"healthy","version":"3.4.5","protocol_version":2,…}`
- pdf.js：`node_modules/pdfjs-dist@6.4.299`（`legacy/build/pdf.mjs`）；渲染用 `@napi-rs/canvas`（pdfjs 的可选依赖，已安装）
- Node v22.22.1

## 7.2 命令

```bash
# MinerU 单页解析（注意 start_page_id 是 0-based）
curl -s -X POST http://127.0.0.1:8000/file_parse \
  -F "files=@/home/vr/zotero-pdf2zh/server/translated/Gu et al. - 2022 - Vector Quantized Diffusion Model for Text-to-Image Synthesis.pdf" \
  -F backend=pipeline -F parse_method=auto -F lang_list=en \
  -F return_md=true -F return_content_list=true -F return_middle_json=true \
  -F response_format_zip=false -F formula_enable=true -F table_enable=true \
  -F image_analysis=false -F effort=medium \
  -F start_page_id=4 -F end_page_id=4 -o /tmp/mineru_p4_mid.json   # → PDF 第 5 页，耗时 ~3.4s

# 映射精度 + 覆盖性（脚本落在 /tmp/probe/，非仓库文件）
node /tmp/probe/coverage.mjs \
  "$HOME/.dsh-paper-reader/data/默认专题/Hansen et al. - 2024 - TD-MPC2 ….pdf" \
  "$HOME/.dsh-paper-reader/data/默认专题/Hansen et al. - 2024 - TD-MPC2 ….mineru.json" 2,3,27,29
# → min IoU=0.529 mean IoU=0.854 worst under-cover=4.60pt ; PAD=6 covers ALL: true

node /tmp/probe/coverage.mjs "…Gu et al….pdf" /tmp/probe/cl_p5_shift.json 4
# → min IoU=0.745 mean IoU=0.895 worst under-cover=3.61pt ; PAD=6 covers ALL: true

# 叠加图（在真实渲染页上画矩形：红=bbox 映射，蓝虚线=+6pt 外扩）
node /tmp/probe/overlay2.mjs "<TD-MPC2 pdf>" 3 "<…>.mineru.json" /tmp/probe/overlay_real_p4.png
node /tmp/probe/overlay.mjs "<Gu et al. pdf>" 5 /tmp/probe/cl_p5.json /tmp/probe/overlay_p5.png
```

## 7.3 图（已随本文档归档在 `docs/reader-ux-evidence/`）

- 图 1（样本 A = 用户真实文献库，PDF 第 4 页，4 个公式 (3)(4)(5)(6)）：`docs/reader-ux-evidence/bbox-overlay-real-library-p4.png`
- 图 2（样本 B，PDF 第 5 页，5 个公式 (8)(9)(10)(11)(12)）：`docs/reader-ux-evidence/bbox-overlay-vqdiffusion-p5.png`

![样本 A：真实文献库第 4 页，bbox 映射矩形（红）+ 6pt 外扩（蓝虚线）](reader-ux-evidence/bbox-overlay-real-library-p4.png)

![样本 B：PDF 第 5 页，bbox 映射矩形（红）+ 6pt 外扩（蓝虚线）](reader-ux-evidence/bbox-overlay-vqdiffusion-p5.png)

> 这两张图是本次判定的**核心视觉证据**（在真实渲染页面上验证「点击热区落点正确」）：红框全部精确扣在公式上，蓝虚线外扩框完整包住公式（含分式、求和上下限、上下标）。复现命令见 7.2；覆盖性复核脚本副本：`docs/reader-ux-evidence/coverage-check.mjs`。

## 7.4 其它实测数据点

- content_list ↔ middle_json（同页、同为 pt）最大残差：x 0.59pt / y 0.78pt（19 块全部配对，理论界 0.612 / 0.792 → 残差即 `int()` 截断）。
- 相邻公式块最小竖直间隙：**0.8pt**（样本 A p30）。
- `contentList` 顺序为版面序（先左栏后右栏）：样本 B p5 的 5 个公式 `bbox[1]` = 486,688,809,409,511。
- 用户库真实产物：`.mineru.json` 146KB，266 块，类型分布 `text 112 / chart 52 / header 35 / page_number 31 / equation 12 / table 9 / image 6 / list 5 / code 2 / aside_text 1 / page_footnote 1`；equation 全部 `text_format:'latex'`，`bbox` 分量 min 126 / max 928。
- 会话存储分组（实测目录）：`~/.dsh/sessions/--home-vr-.dsh-paper-reader-data-~9ED8~8BA4~4E13~9898--/dpr-<base64url(topic/name)>-1/` → 支撑 C11/§2.5 的脱钩结论。
