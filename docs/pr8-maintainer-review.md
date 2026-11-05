# PR #8 维护者评审原文（唯一权威验收清单）

- 上游 PR：https://github.com/GGboya/dsh-paper-reader/pull/8 （head `Veryyoung957:feat/darkmode-subtopic`，本轮基线 `fdb45f2`）
- 评审人：@GGboya（上游维护者）｜状态：**CHANGES_REQUESTED**（2026-10-17T04:32:54Z）
- 结论：**A–F 必修**（数据不可见 / 不可删 / 静默丢失），**G–H 应修**。
- 维护者原话：「每条都在本机复现过，不是读代码猜的。」本轮必须**独立复现**后再修，不得只凭本文件照改。

## 维护者评审正文（逐字）

## 评审结论：功能与验证工作都很扎实，但新布局语义与既有面的交互处有一批**已实证复现**的缺陷，需要修一轮再合并

先说结论之外的话：这批的四条能力设计合理（迁移的先复制后删/幂等/回滚机制我本地完整闭环跑通过：干跑→执行→复跑 moves=0→回滚还原，内容零丢失；变异探针 54/54；CI 三平台绿）。但按「每条新行为要可区分用例 + 变异验证」的口径过了一遍**新布局与既有界面的交互面**（上传/改名/删除/清空/会话绑定/迁移工具自身），发现以下问题——每条都在本机复现过，不是读代码猜的。

### 必修（数据不可见/不可删/静默丢失一类）

**A. 会话 id 与嵌套专题不兼容**
- `src/tools.ts:72` `paperFromSessionId` 按**第一个** `/` 切 `topic/name`，但嵌套专题的 topic 本身含 `/` ⇒ 深度 ≥2 的论文（`A/B/P`）会话绑定全部失效：agent 不带 name 调 `search_paper` 等会报「找不到 "B/P"」。`lib/client.js:593` 的 `parseDprSession` 同病，ⓘ「对话还停在另一篇」按钮对子专题论文永远常亮。修法：`lastIndexOf('/')`（论文名不允许 `/`）。

**B. 上传无碰撞检查（会吞数据）**
- `src/host.ts:616` 上传直接 `mkdir <topic>/<stem>/` 写 PDF：往已有**子专题**同名目录上传会把子专题变成「论文目录」，其下论文从列表/树/范围提问里**整体消失**（实测 `listPapers` 只剩 `{T,Sub}`）；往**旧平铺论文**同名上传则文件夹优先规则永久遮蔽旧 `.txt/.study.json/.embeddings.json`（学习进度不可见、平铺产物从 API 不可删）。大小写不敏感盘上还会静默吞掉大小写变体。

**C. 目录/文件互踩一类（造成 API 不可见且不可删的孤儿）**
- `src/library-manage.ts:1226` `renameTopic` 只查 `resolveTopicDir`，不拒绝**论文目录**当父（`host.ts:552` create-topic 祖先巡检、`host.ts:601` 上传 topic 解析同漏）⇒ 子专题树搬进论文目录后消失，且 `clearTopic` 之后永远 409 全回滚（实测，API 层面无解）。
- `src/library.ts:184` + `host.ts:560` create-topic 不查与平铺文件同名 ⇒ 旧平铺论文被文件夹规则遮蔽成不可见 + `planPaperDelete` 404。
- `src/library-manage.ts:1167` `renameLegacyPaper` 冲突预检只查逐文件目标、不查**同名目录**存在 ⇒ 平铺改名撞上子专题名后同样不可见不可删。
- `src/library-manage.ts:1131` 文件夹布局 `renamePaper` 只查目标**目录**、丢掉了旧的逐文件冲突预检 ⇒ 目录内同名残留文件被 `renameSync` **静默覆盖**（实测无 409、无回收站记录）。

**D. 清空/删除的占用检查只看一层**
- `src/host.ts:915` `/topic/clear` 的会话/译文占用巡检只遍历根层 `plan.papers`，但 `clearTopic` 删的是整棵子树 ⇒ 子专题里有活跃会话或生成中译文的论文照样进回收站（实测 plan.papers=['P1'] 而 papersCount=2）；清空确认对话框同样漏列子专题论文。

**E. 迁移工具自身的两个契约缺口**
- `src/migrate.ts:391` `readMigrationLog` 整个 JSONL 一个 try/catch，任何一行损坏（SIGKILL 打断 append 的典型现场）⇒ 返回 `[]`，`--rollback` 打印「已回滚 0 个文件」且 **exit 0**——静默空转的假成功，直接违反「降级必须如实提示」。修法：逐行解析、坏行显式报错。
- `src/migrate.ts:239` 阶段 1 在 mkdir 论文目录后、`.pdf` 复制前被打断，残留目录在复跑时被判 `dir-other` 冲突 ⇒ 该论文**每次复跑都被跳过**（实测 moves=[] 永远），与「可中断可复跑」的文档承诺矛盾。需要阶段 1 也写 partial 标记或对「自己上次的半成品目录」做识别清理。
- 次级：`host.ts:956` `/migrate` 在事件循环上同步跑全量复制+双 sha256（大库冻结所有路由，含 PDF 流与 SSE 桥），且没有像 delete/rename 那样对在飞转录/译文加 busy 门。

**F. 会话/主题路径的一个回归**
- `src/library-manage.ts:182` `validateTopicPath` 在 `boundaryOnly` 模式（删除/改名-from/清空）也执行新上限 `MAX_TOPIC_SEG=100`，而上一版允许 120 ⇒ 已存在的长名专题从 API **删不掉也改不了名**，违反「legacy 怪名字必须保持可删」的自定不变量（实测 110 字名 400）。

### 应修（行为正确性/如实提示）

**G. 范围提问的预算与诚实性**
- `src/scope.ts:263` 专题范围的命中片段 push 进 `hitParts` **不计入 `used` 预算**（`pushWithLabel` 恒以 `hits=null` 调用，计费分支是死代码），且与正文重复同一段文本 ⇒ 实测 12 篇×3 命中时 `totalChars=72574`，超 `MAX_CONTEXT_CHARS=40000` 近一倍；omitted 提示句也在 276/287 两处重复输出。
- `src/scope.ts:146` `scopePapers` 逐篇 `resolvePaper` 的 catch **静默吞掉**「命中多篇」（同名论文在不同深度时直接从范围里消失，无 omitted 标注）；`kind:'topic'` 不校验专题存在 ⇒ 已改名/删除的专题装配出「空的但看起来正常」的范围 + 200 响应（违反如实提示）。顺带：每问一次 N+1 递归子树扫描。
- 次级：`host.ts:432` `scopeBusy` 的分隔符 `\^@` vs `/` 不匹配 ⇒ paper 范围的 busy 提示永远不触发；`host.ts:985` 回滚日志路径前缀判断缺分隔符；短正文全覆盖时 `coverage` 误报 `truncated`（scope.ts:253）。

**H. 客户端嵌套结构追踪**
- `lib/client.js:1079/375/1194` 祖先专题改名/删除只按**精确相等**更新 `cur`/`dpr.last`/closed 键 ⇒ 读 `A/B` 时改名 `A`→`X/A`，阅读器 iframe 还持 `?topic=A/B`，提问/翻译 404、刷新后回落 papers[0]（阅读位置丢）；`openDelete` 的 clear-vs-delete 分流只数**直接**论文（1172）⇒ 论文全在子专题里的专题没有 UI 路径到 `/topic/clear`（`doDeleteTopic` 1268 的 clearEndpoint 重试是死代码——`api()` 没把 clearEndpoint 挂到 Error 上）。

### 我这边已经修好的（合并时会带上，供参考）

1. **scope.ts 的 5 处码元截断全部切开代理对**（`readText`/命中片段 1200×2/正文 limit×2）——与 issue #9 同类（孤立代理项进会话历史 ⇒ 整条会话 400）。已提炼 `cutToCodePoint` 原语（`search.ts` 导出）统一替换，附 S5/S6/E3b 回归用例并变异验证。**你们改完上面的问题后，scope.ts 这 5 处也请走 `cutToCodePoint`（或等价回退），main 上已有该导出。**
2. `docs/features.md` / `features_EN.md` 的新功能章节（深色代价如实写明/迁移三步/退出码/范围上限）与 `AGENTS.md` 模块清单——按仓库「用户向细节归口 features.md」的约定补齐。

### 其它（不阻塞，记录在案）

重复 CSS 块（reader/index.html:143-147）、`DARK_PRESETS` 三处重复声明、`theme-config.ts` 是第 5 份手写 0600 配置样板、死导出（`normalizeTopicPath` 零调用）、回收站 manifest 漏隐藏文件（library-manage.ts:611）、大小写改名在 macOS/Windows 被拒（library-manage.ts:1228）。

---

**结论：request changes。** 上面 A–F 属必修（都有数据不可见/不可删/静默丢失风险），G/H 应修。修完 push 后我再跑一轮集成验证（main 上已有 issue #9 修复，会一起合入）。感谢这批工作——迁移工具的核心机制经得起拆，问题集中在「新语义没铺到既有面的每个角」，这也是为什么这轮评审值得。

---

## 本轮环境事实（队长已核实，2026-10-26）

- 修复工作树：`/home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes`（分支 `feat/darkmode-subtopic`，HEAD `fdb45f2`）。
- `node_modules` 已就绪；`npm run build` 通过；基线全量测试 **533 tests / 506 pass / 0 fail / 27 skip（约 26s）**。
- **本树没有 `cutToCodePoint` 导出**：`src/search.ts` 在本分支上是旧版（main 的 `a7ff7eb` 修复未进本分支）。因此 scope.ts 的码点安全要走**等价回退**（自建同语义 helper），不要 import 一个不存在的导出；合入 main 时再与上游版本对账。
- 分支落后 `origin/main` 12 个提交（含 v1.5.1 issue #9 修复、v1.6.0、preset 迁移）。**本轮不做 rebase**（会造成 15 个提交的历史重排，风险高于收益）；集成任务只报告合并风险。
- 测试只 import `dist/*.js`：改完 `src/` 必须 `npm run build`。多人共用同一工作树，构建要加锁：
  `flock /tmp/dpr-pr8-build.lock -c 'npm run build'`。

## 本轮统一红线

1. **不 rebase、不 push、不 `git commit`/`git add`**（提交由集成任务统一做）。
2. 只改自己任务的 `inScope`；他人负责的测试文件不要动（每任务一个独立 `test/pr8-*.test.mjs`）。
3. 每条缺陷**先写修复前必红的可区分用例**（在 `fdb45f2` 上跑一遍留证据），再改实现；证据写进自己的 `docs/evidence/pr8-*.md`。
4. 破坏性实验一律用 `mkdtemp` 临时库；绝不碰真实文献库 `/home/vr/...` 下的用户数据。
5. 修不了/超出范围就如实上报，不要为了绿灯削弱断言或跳过用例（跳过要写明理由与平台事实）。
