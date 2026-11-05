# PR #8 修复的独立验证（VER / t7）

- 对象：PR #8 `feat/darkmode-subtopic`（基线 `fdb45f2`）针对上游维护者 @GGboya **CHANGES_REQUESTED** 的修复
  （A–F 必修、G–H 应修），清单原文见 [docs/pr8-maintainer-review.md](../pr8-maintainer-review.md)。
- 验证角色：独立验证者（verifier / t7）。**不采信实现方自述，也不采信评审方自述**：本文件的红/绿全部由
  下列命令在本机跑出；对四个外部探针套件（实现方 ×3、评审方 ×3）只把它们当**被测对象**重新执行。
- 两台机器状态：
  - 修复树 `/home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes`（HEAD `fdb45f2` + 未提交修复，`npm run build` 通过）
  - 基线树 `/home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-baseline`（detached `fdb45f2`，已 build，只读使用）
- **总结论：A–H 8 项全部已修（8/8），未修/存疑 0 项；6 条低危观察不阻塞。具备进入集成的前置条件**
  （集成仍需按流程单独执行：提交、与 `origin/main` 的 12 提交落后风险、以及本树新增测试文件 `git add`）。

---

## 0. 方法与独立性

1. **自造对抗探针**：新建 [test/pr8-verification.test.mjs](../../test/pr8-verification.test.mjs)（23 例）。
   不 import 实现方三个用例文件，也不 import 评审方三个探针；夹具（专题 `VerA/VerB/...`、论文名
   `VerPaper`、needle `verneedle-<i>-<k>`、坏日志注入行、110 字专题 `Z×110`、码点样本 U+1D400）
   与断言全部本文件重造。同一份探针用 `VER_REPO=<基线树>` 直接跑基线，红是**本探针自己跑出来的**。
2. **客户端代码真执行**：`lib/client.js` 在 `node:vm` 里执行，取顶层纯函数；基线把 `parseDprSession`
   放在 `load()` 闭包里，本探针从源码抠出函数体**真执行**（不是 grep）。
3. **破坏性实验隔离**：全部 `mkdtemp` 临时库 + 临时 `DSH_HOME`（进程内设定）+ 临时迁移日志目录；
   没有触碰真实文献库。
4. **不采信数字**：A–H 表中每条都给出「基线实测 / 修复后实测」两列原始值（状态码、机器码、库快照、
   时序），而不是「已修复」三个字。
5. 未改 `src/`、`lib/`、`dist/`、他人测试文件、`package.json`、README、`docs/features.md`；
   未 commit / push / rebase / `git add`。变异注入由 `test/mutation-probe.mjs` 自动还原，事后哈希与 `git diff` 双重核对（§5）。

## 1. 环境与字节绑定

- Node `v22.22.1`；构建：`flock /tmp/dpr-pr8-build.lock -c 'npm run build'`（exit 0）。
- 验证开始与结束（构建、全量、变异跑完之后）**逐字节一致**的绑定：

| 文件 | sha256 |
| --- | --- |
| `src/tools.ts` | `4ffadc6f6adb95f25a5b5e251b8ee3409ca280519d17652a0ec5eb696a4f1c97` |
| `src/scope.ts` | `9741cf98218a24999b122b62abe6e08606ed8a64b6cd0afc825511c755bea8e6` |
| `src/host.ts` | `13358a0d7f82f13c933ba8ea9fffb42fcb71899da7665b50c7316c081b3fbb41` |
| `src/library.ts` | `8eacad1bac2879d2a5029f251a4835f292b25aae1d5bfebb66cc7789a6253070` |
| `src/library-manage.ts` | `5eb1e494526d2e09856c83c8614c6c8c2456360fc5fbfc9c4fcf2016bb443665` |
| `src/migrate.ts` | `017dac01d24be059c3f838312f1a3b9fc42393ca63220deecba1dcfad672982b` |
| `lib/client.js` | `d0c2e794f134e70d03d451dfe8144e4fef81edd37e67cb7ccf818c2987b7bdca` |
| `dist/tools.js` | `dab1d7523bb01761dc99e7c639bf920d1b64c3af0cb415334ba63ab63df37e13` |
| `dist/scope.js` | `05eda043887c71fdd7c396798ba1e314654e1e463c458214db589bb2bc2b6f40` |
| `dist/host.js` | `48d8787543b3239e0597f88b0d75d2dd1444cd4080241b6efe3c79e720ffd7d8` |
| `dist/library.js` | `e27f39d0ae4406b0a5e35f8ff4e0492d33d909f64cd3e9940fd93eba107ea5ee` |
| `dist/library-manage.js` | `d14fbbf262af7bef346abe781ffd4f403a4873eba5f3dc36438493cc27953925` |
| `dist/migrate.js` | `c9b328a7f5999908df064c4fe4618491b8a5d525012aa9d19cdeb97638acde32` |

> 与 t13/t15 绑定的 IMP2 五文件一致；`src/migrate.ts` 在本轮验证期间也未变。**验证没有改动实现字节。**

- 工作树改动面（`git status --porcelain`）：`M lib/client.js`、`M src/{host,library,library-manage,migrate,scope,tools}.ts`、
  `M test/mutation-probe.mjs`；未跟踪 = `docs/evidence/`、`docs/pr8-maintainer-review.md`、`test/pr8-*.test.mjs`
  （含本任务新增的 `test/pr8-verification.test.mjs`）。无越界改动。
- 验证过程产物放 `.probe/ver/`（gitignored，仓库既有守卫白名单允许 `.probe/`）：
  原始日志 `full-suite-final3.log`、`baseline-suite.log`、`fixed-final4.log`、`baseline-final4.log`、`mutations.log`、`hashes-*.sha`。

## 2. A–H 逐条事实表

下表每条都给：维护者原文断言 / **修前实测（基线树）** / **修后实测（修复树）** / 可复跑命令 / 结论。
除注明外，命令都在修复树根目录执行；基线对照是给同一命令加 `VER_REPO`：

```bash
cd /home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes
BASE=/home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-baseline
```

### A. 会话 id 与嵌套专题不兼容（必修）

| | 内容 |
| --- | --- |
| 维护者断言 | `paperFromSessionId` 按**第一个** `/` 切 `topic/name`；`lib/client.js` 的 `parseDprSession` 同病 ⇒ 深度 ≥2 的论文会话绑定全失效、ⓘ 按钮对子专题论文常亮。修法 `lastIndexOf('/')`。 |
| 修前实测（基线） | `paperFromSessionId('dpr-<b64(VerA/VerSubB/VerPaperC)>-4')` ⇒ `{topic:"VerA", name:"VerSubB/VerPaperC"}`；客户端 `parseDprSession` 同 ⇒ `{topic:"VerA", name:"VerSubB/VerPaperC", n:4}`（探针真执行基线源码里的函数体）。 |
| 修后实测 | 两侧均为 `{topic:"VerA/VerSubB", name:"VerPaperC"}`（`n:4`）；单层 `SoloOnly/VerPaperD` 与非法输入（无 `/`、结尾 `/`、非 `dpr-`、`undefined`）行为不回归。 |
| 复跑命令 | `node --test --test-name-pattern="VER-A" test/pr8-verification.test.mjs`；基线：`VER_REPO=$BASE node --test --test-name-pattern="VER-A" test/pr8-verification.test.mjs` |
| 结论 | **已修**（修前 1 红 → 修后绿） |

### B. 上传无碰撞检查（必修，会吞数据）

| | 内容 |
| --- | --- |
| 维护者断言 | 上传直接 `mkdir <topic>/<stem>/`；撞**已有子专题**⇒ 其下论文整体消失；撞**旧平铺论文**⇒ 文件夹优先永久遮蔽学习进度；撞**已有论文目录**⇒ 覆盖/合并；大小写变体静默吞。 |
| 修前实测（基线） | ① 上传 `SubExist.pdf` 到 `VerB`（`VerB/SubExist/InnerPaper` 已存在）⇒ **200**，库列表变成 `["VerB/PaperExist","VerB/SubExist"]`（`VerB/SubExist/InnerPaper` 消失）；② 上传 `PaperExist.pdf` 撞同名论文目录 ⇒ **200**；③ 上传 `FlatPaper.pdf` 撞平铺 `.pdf`+`.study.json` ⇒ **200**。 |
| 修后实测 | 三种碰撞全部 **409 `target-exists`**（文案分别点名「已存在同名子专题…其下文献将整体消失」「已存在同名论文目录…上传会覆盖/合并它」「同层已有旧布局论文产物…会把它永久遮蔽」）；每次被拒后**全库快照逐字节相等**；子专题论文仍在列表；平铺论文 `delete-plan` 仍 200。另：碰撞预检发生在**消费请求体之前**（同一请求修复树 409、基线需先吃 body 才走到写盘）。 |
| 复跑命令 | `node --test --test-name-pattern="VER-B" test/pr8-verification.test.mjs`（基线加 `VER_REPO=$BASE`） |
| 结论 | **已修**（基线 2 红 → 修复绿） |

### C. 目录/文件互踩（必修）

| | 内容 |
| --- | --- |
| 维护者断言 | `renameTopic` 不拒绝论文目录当父（`create-topic` 祖先巡检、上传 topic 解析同漏）；`create-topic` 不查平铺同名；`renameLegacyPaper` 不查同名目录；新布局 `renamePaper` 丢掉逐文件冲突预检 ⇒ 静默覆盖。 |
| 修前实测（基线） | ① `POST /topic {name:"VerC/PaperAsParent/NewSub"}`（父是论文目录）⇒ **200**；② `rename-topic {name:"VerC/MoveMe" → "VerC/PaperAsParent/MoveMe"}` ⇒ **200**（子树搬进论文目录）；③ `create-topic VerC2/FlatAsTopic`（同层有平铺 `.pdf/.txt`）⇒ **200**；④ `rename-paper FromPaper→ToPaper`（源目录内已有 `ToPaper.txt`=KEEP-RESIDUAL）⇒ **200**，响应 `moved:["ToPaper.txt","ToPaper.pdf"]`（残留被覆盖）；⑤ 平铺 `LegacyName→ExistingDir`（同名子专题目录）⇒ **200**。 |
| 修后实测 | 五处全部 **409 `target-exists`** 并点名冲突对象（`VerC/PaperAsParent` / `FlatAsTopic.pdf`、`FlatAsTopic.txt` / `ToPaper.txt` / `ExistingDir`）；每次被拒后**全库快照逐字节相等**，`KEEP-RESIDUAL` 原样保留。 |
| 复跑命令 | `node --test --test-name-pattern="VER-C" test/pr8-verification.test.mjs`（基线加 `VER_REPO=$BASE`） |
| 结论 | **已修**（基线 5 红 → 修复绿） |

### D. 清空/删除的占用检查只看一层（必修）

| | 内容 |
| --- | --- |
| 维护者断言 | `/topic/clear` 的会话/译文巡检只遍历根层 `plan.papers`，但清的是整棵子树；清空确认框同样漏列子专题论文（实测 `plan.papers=['P1']` 而 `papersCount=2`）。 |
| 修前实测（基线） | `GET /topic/clear-plan?topic=VerD` ⇒ 200，`papers=["VerD/RootPaper"]` 而 `papersCount=3`（确认框自相矛盾）；子专题论文有 running 会话时 `POST /topic/clear` ⇒ **200 `cleared:2`**，真写回收站（`.trash/…`），子专题会话论文被搬走。 |
| 修后实测 | clear-plan 列出 `["VerD/RootPaper","VerD/VerSubD/Deep/DeepPaper","VerD/VerSubD/SubPaper"]` 且 `papersCount=3` 与清单严格相等、`subtopicsCount≥1`；有 running 会话时 clear ⇒ **409 `session-running`**、全库快照逐字节不变、`.trash` 不存在。 |
| 复跑命令 | `node --test --test-name-pattern="VER-D" test/pr8-verification.test.mjs`（基线加 `VER_REPO=$BASE`） |
| 结论 | **已修**（基线 2 红 → 修复绿） |

### E. 迁移工具自身契约（必修 + 次级）

| | 内容 |
| --- | --- |
| 维护者断言 | ① `readMigrationLog` 整段 try/catch，坏行 ⇒ `[]` + `--rollback` 打印「已回滚 0 个文件」且 exit 0；② 阶段 1 mkdir 后/`.pdf` 复制前被打断，复跑被判 `dir-other` 冲突 ⇒ 永远跳过；③ 次级：`/migrate` 同步跑全量、无 busy 门。 |
| 修前实测（基线） | ① 3 行日志把第 2 行截半 ⇒ CLI `--rollback` **exit 0**，stderr=`已回滚 0 个文件；删除空目录 0 个。`；② 精确现场「`VerE2/ResumeMe/` 空目录 + 平铺 `.pdf/.txt` 仍在」⇒ `plan.moves=[]`、`conflicts=["VerE2/ResumeMe"]`、复跑 `copied=0`（**每次都被跳过**）；③ 900 篇平铺库：迁移**已开始落盘后**发并发 `GET /api/library`，`settleAtGet=true`（GET 只能等迁移 145ms 跑完）；有在飞译文时 `POST /migrate` ⇒ **200**。 |
| 修后实测 | ① 坏日志 `--rollback` ⇒ **exit 1**，stderr=`迁移失败（migrate-log-corrupt）：迁移日志第 2 行不是合法 JSON（…）`（指出行号 + 机器码）；同库完好日志 ⇒ exit 0「已回滚 3 个文件」，平铺 PDF 真恢复；② 同一空目录现场 ⇒ `plan.moves=["VerE2/ResumeMe.pdf","VerE2/ResumeMe.txt"]`、复跑 `copied=2 removed=2 skipped=[]`，产物内容正确、源已删；真实中断（`failAfterCopies=1`）现场留下 `.migration-v1.inprogress`，复跑收敛且清标记；③ 修复树 `settleAtGet=false`，GET 在迁移进行中 **10.7ms** 返回（迁移总 184.2ms、`copied=900`）；在飞译文时 `/migrate` ⇒ **409 `busy`** 点名 `VerE3B/BusyPaper`。 |
| 复核事实（如实记录） | 维护者说的「**每次**复跑都被跳过」只在**空目录**现场成立。若中断发生在**首个文件已复制之后**（`failAfterCopies=1` 的实际落点），基线能凭 `isPaperDir` 把该篇认成半成品并恢复（基线 `resume copied=1`）；缺的是**显式半成品标记**（基线 `marker=false`）。修复树对两种现场都收敛。 |
| 复跑命令 | `node --test --test-name-pattern="VER-E" test/pr8-verification.test.mjs`（基线加 `VER_REPO=$BASE`）；CLI 单跑可用 `DSH_HOME=<临时> node dist/migrate.js --data-dir <临时库> --rollback <日志>` |
| 结论 | **已修**（基线 E1/E2a/E2b/E3a/E3b 全红 → 修复绿） |

### F. boundaryOnly 长度回归（必修）

| | 内容 |
| --- | --- |
| 维护者断言 | `validateTopicPath` 在 `boundaryOnly`（删除/改名-from/清空）也执行 `MAX_TOPIC_SEG=100`，上一版允许 120 ⇒ 已存在的 110 字专题从 API 删不掉也改不了名（实测 400）；创建侧上限不变。 |
| 修前实测（基线） | 110 字**空**专题 `delete-topic` ⇒ **400 `bad-name`「名字过长（每层最多 100 个字符）」**；110 字专题 `rename-topic → VerFShort` ⇒ **400**；创建 110 字 ⇒ 400（应保持）。 |
| 修后实测 | 110 字空专题 `delete-topic` ⇒ **200** 且目录真的消失；110 字专题改名 ⇒ **200**，论文仍在 `VerFShort/LongPaper/LongPaper.pdf`；创建 110 字 ⇒ 仍 **400**；`..` / `VerF/../../VerFEscape` / `%2e%2e%2f` 在 boundary 模式仍 **400**（库外目标零创建）；前导点属历史怪名，boundary 模式放行（不存在 ⇒ 404，非 400）。 |
| 复跑命令 | `node --test --test-name-pattern="VER-F" test/pr8-verification.test.mjs`（基线加 `VER_REPO=$BASE`） |
| 结论 | **已修**（基线 2 红 → 修复绿） |

### G. 范围提问的预算与诚实性（应修）

| | 内容 |
| --- | --- |
| 维护者断言 | 命中片段 `pushWithLabel` 恒 `hits=null` ⇒ 不计预算、与正文重复同一段；12 篇×3 命中 `totalChars=72574`（≈上限 1.8 倍）；omitted 提示句重复输出；`scopePapers` 静默吞掉同名多命中；`kind:'topic'` 不校验专题存在 ⇒ 空范围 + 200；次级：短正文全覆盖时 `coverage` 误报 `truncated`。 |
| 修前实测（基线） | 12 篇×3 命中：`totalChars=72845`、`block.length=73062`、`bodyChars=39097`、`hitChars=33101`，omitted 提示句出现 **2 次**，同一命中片段 `verneedle-0-a` 出现 **2 次**（正文+命中重复，即重复计费）；台账 `truncated=1/omitted=3/full=undefined` 与逐篇明细（full 8/truncated 1/omitted 3）不一致。同名双份：只剩 1 篇 `full`、`omitted=0`、无原因、块内 0 次「同名」。不存在的专题：`POST /api/ask` ⇒ **200**（`scope.path=VerGoneTopic`、`papers:0`、空 coverage）且**真的把提示词发给了 agent**（prompted=1）。U+1D400 切点：`block` 含 **1 个孤立代理项**（位置 8178），`chars=8000`。 |
| 修后实测 | `totalChars=39591 ≤ 40000`、`block.length=39759`、`bodyChars=0`、`hitChars=38944`；omitted 句 **1 次**；`verneedle-0-a` **1 次**；台账 `full=0/truncated=11/omitted=1` 与逐篇 coverage 完全一致（每篇都有终态、三段和自洽）。同名双份 ⇒ 2 篇 `omitted-duplicate`、`omitted=2`、`omittedNotes=2`、块内 3 处点名。不存在专题 ⇒ **404 `not-found`**、prompted=0；正对照 `scope.topic=VerG2` ⇒ 200。U+1D400：**0 个孤立代理项**、`chars=7999`、数学字符整字保留/整字缺席。`dist/scope.js` 导出 `cutToCodePoint`，语义（切点落代理对中间退回 1 码元、不越界）实测通过。 |
| 复跑命令 | `node --test --test-name-pattern="VER-G" test/pr8-verification.test.mjs`（基线加 `VER_REPO=$BASE`） |
| 结论 | **已修**（基线 5 红 → 修复绿） |

### H. 客户端嵌套结构追踪（应修）

| | 内容 |
| --- | --- |
| 维护者断言 | `lib/client.js` 祖先专题改名/删除只按**精确相等**更新 `cur`/`dpr.last`/closed 键 ⇒ 读 `A/B` 时改名 `A`→`X/A`，iframe 仍持 `?topic=A/B`（提问/翻译 404、刷新回落 papers[0]）；`openDelete` 分流只数**直接**论文 ⇒ 论文全在子专题时没有 UI 路径到 `/topic/clear`；`clearEndpoint` 没挂到 Error 上 ⇒ 清空重试是死代码。 |
| 修前实测（基线） | 基线 `lib/client.js` 无这些纯函数（缺陷内联在 `load()` 闭包里，只在闭包内按精确相等更新）；本探针断言 `dprReprefixTopic/dprRekeyTopicState/dprTopicPaperCount/dprApiError/dprClearRetryNeeded` 均**不存在** ⇒ 红。补充「行为级」证据：同一份 `test/pr8-review-r2.test.mjs` 以 `R2_REPO=$BASE` 原样跑基线，H1c（`dpr.last` 停 `A/B`）等 16 例红（见 §4）。 |
| 修后实测 | `dprReprefixTopic('VerA/Sub','VerA','X/VerA')='X/VerA/Sub'`、`('VerAB',…)` 返回 `null`（分隔符判定，不误伤同级近名）；`dprRekeyTopicState` 后 `cur/last={topic:'X/VerA/Sub',name:'VerPaper'}`、折叠键 `['VerAB','X/VerA/Sub']`；`dprTopicPaperCount([VerA/Sub, VerA/Sub/Deep, VerAB, VerA],'VerA')=3`（VerAB 不算）；`dprApiError(409,{code:'topic-not-empty',clearEndpoint:…}).clearEndpoint` 透传、`dprClearRetryNeeded` 为 true，`translation-busy` 为 false。 |
| 复跑命令 | `node --test --test-name-pattern="VER-H" test/pr8-verification.test.mjs`（基线加 `VER_REPO=$BASE`） |
| 结论 | **已修**（缺失 → 语义全绿；行为级基线红见 §4 的 R2 基线跑） |

### A–H 汇总

| 项 | 级别 | 基线实测 | 修复后 | 结论 |
| --- | --- | --- | --- | --- |
| A 会话 id 嵌套 | 必修 | 红 | 绿 | 已修 |
| B 上传碰撞 | 必修 | 红 | 绿 | 已修 |
| C 目录/文件互踩 | 必修 | 红（5 处） | 绿 | 已修 |
| D 清空占用/清单 | 必修 | 红 | 绿 | 已修 |
| E 迁移契约（E1/E2/E3） | 必修+次级 | 红（5 例） | 绿 | 已修 |
| F boundaryOnly 长度 | 必修 | 红 | 绿 | 已修 |
| G 范围预算/诚实性 | 应修 | 红（5 例） | 绿 | 已修 |
| H 客户端嵌套追踪 | 应修 | 红 | 绿 | 已修 |

## 3. 自造探针（test/pr8-verification.test.mjs，23 例）

**不是实现方/评审方用例的复刻**：独立夹具 + 独立断言 + 基线开关。两树结果：

| 树 | tests | pass | fail | 说明 |
| --- | --- | --- | --- | --- |
| 修复树 | 23 | **23** | 0 | 每条 A–H 至少 1 例，E/G 有多例 |
| 基线 `fdb45f2` | 23 | **1** | **22** | 唯一绿的是 `VER-Z` 元信息（断言 dist 存在）；A–H 全红 |

命令：

```bash
cd /home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes
node --test test/pr8-verification.test.mjs
VER_REPO=/home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-baseline node --test test/pr8-verification.test.mjs
```

覆盖清单（23）：`VER-A`；`VER-B1/B2`；`VER-C1/C2/C3/C4`；`VER-D1/D2`；`VER-E1/E2a/E2b/E3a/E3b`；
`VER-F`；`VER-G1/G5/G2/G3/G4`；`VER-H1/H2`；`VER-Z`。
与五个候选攻击面的对应：上传到子专题（B1）、清空子树占用（D2）、坏 JSONL 回滚退出码（E1）、
码点截断（G3/G4）、client 前缀追踪（H1）——**5 项全覆盖**（另有 C/F/E2/E3/G1 等扩展）。

> 探针编写过程中发现并修正了 3 处**我方**夹具错误（记录在案，避免误判实现）：
> ① 最初把「论文目录」建成 `VerC/PaperAsParent/PaperAsParent/…`（多一层），实际是专题目录；
> ② C4 的最初现场把残留放在**目标**目录（基线本就 409），换成维护者描述的**源目录内同名残留**后才复现静默覆盖；
> ③ E2 最初用 `failAfterCopies=1` 代表「空目录现场」，基线实际能恢复该篇；已拆成 E2a（空目录现场）/E2b（真实中断+标记）。
> 这三点使基线红从「探测不到/误红」变成与维护者描述一致的现场，属于验证方法的修正，不是放宽断言。

## 4. 回归与套件（全部本机实跑）

### 4.1 全量

```bash
cd /home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes
flock /tmp/dpr-pr8-build.lock -c 'npm run build'      # exit 0
node --test --test-timeout=60000 --test-concurrency=1 "test/*.test.mjs"
```

| 轮次 | tests | pass | fail | skip | 备注 |
| --- | --- | --- | --- | --- | --- |
| 第 1 次（含本探针 20 例版） | 672 | 645 | 0 | 27 | 通过 |
| 第 2 次（含本探针 23 例版） | **675** | **648** | **0** | **27** | **最终结果，65.2s** |
| 首次踩坑（记录） | 652 | 624 | **1** | 27 | 我在仓库根临时建了 `.ver-tmp/` 存日志，触发既有守卫 `VC1`（`test/reader-ux-verification.test.mjs` 的 allowed 白名单不含该目录）；删除后该守卫 22 pass/10 skip、全量 0 fail。**不是实现缺陷**；后续证据产物改放 gitignored 的 `.probe/`。 |

- **27 skip 全部与真实样本缺失有关**（既有理由，非本轮新增；基线同为 27 skip）：
  `DPR_SAMPLE_PDF` 未设置 / 用户文献库缺少真实 MinerU 产物（`VA1–VA10`、`F4`、`V1–V13`、`R2-F1/F2`、
  `A3-真实样本`、`F1/F2 真实样本`、`12.1 惰性`、`端到端（真实 PDF）`）。没有「为了让绿灯而新加的 skip」。
  同一命令在**基线树**实跑：**533 tests / 506 pass / 0 fail / 27 skip**（51s），skip 集合与修复树相同
  ⇒ 27 skip 是既有环境事实，不是本轮引入。

### 4.2 逐文件（三个实现方 + 三个评审方 + 两轮补偿套件）

| 文件 | 角色 | tests | pass | fail |
| --- | --- | --- | --- | --- |
| `test/pr8-layout-collision.test.mjs` | 实现方（B/C/F） | 15 | 15 | 0 |
| `test/pr8-session-client-scope.test.mjs` | 实现方（A/G/H） | 13 | 13 | 0 |
| `test/pr8-clear-migrate.test.mjs` | 实现方（D/E） | 10 | 10 | 0 |
| `test/pr8-review-r1.test.mjs` | 评审方（B/C/F） | 18 | 18 | 0 |
| `test/pr8-review-r2.test.mjs` | 评审方（A/G/H） | 16 | 16 | 0 |
| `test/pr8-review-r3.test.mjs` | 评审方（D/E） | 10 | 10 | 0 |
| `test/pr8-coverage-honesty.test.mjs` | 补偿（G 台账） | 9 | 9 | 0 |
| `test/pr8-platform-guards.test.mjs` | 补偿（C4 ino/大小写） | 7 | 7 | 0 |
| `test/pr8-review-r4.test.mjs` | 复审（G 台账） | 8 | 8 | 0 |
| `test/pr8-review-r5.test.mjs` | 复审（rename self-case） | 13 | 13 | 0 |
| `test/pr8-verification.test.mjs` | **本次验证** | 23 | 23 | 0 |

命令：

```bash
for f in test/pr8-layout-collision.test.mjs test/pr8-session-client-scope.test.mjs test/pr8-clear-migrate.test.mjs \
         test/pr8-review-r1.test.mjs test/pr8-review-r2.test.mjs test/pr8-review-r3.test.mjs \
         test/pr8-coverage-honesty.test.mjs test/pr8-platform-guards.test.mjs \
         test/pr8-review-r4.test.mjs test/pr8-review-r5.test.mjs test/pr8-verification.test.mjs; do
  echo "== $f"; node --test --test-timeout=120000 "$f" | tail -6
done
```

**外部探针在基线上的复跑**（我执行，不是采信报告）：`R1_REPO=$BASE` ⇒ 4 pass / 15 fail；
`R2_REPO=$BASE` ⇒ 1 pass / 16 fail；`R3_REPO=$BASE` ⇒ 1 pass / 10 fail。
即三份「修前必红」的探针在基线上确实是红的，在修复树上全绿。

## 5. 变异验证（R1-/R2-/R3-）

```bash
cd /home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes
flock /tmp/dpr-pr8-build.lock -c 'node test/mutation-probe.mjs --only R1-'
flock /tmp/dpr-pr8-build.lock -c 'node test/mutation-probe.mjs --only R2-'
flock /tmp/dpr-pr8-build.lock -c 'node test/mutation-probe.mjs --only R3-'
```

| 组 | 条数 | 结果 | 覆盖 |
| --- | --- | --- | --- |
| `R1-` | 8 | **8/8** | 上传目标/平铺碰撞、create-topic 平铺、renamePaper 目标内残留、boundaryOnly 长度 + 3 条既有 migrate 域变异（`R1-quarantine-aborts-library` / `R1-silent-skip` / `R1-false-success-marker`，非本轮 A–H 对象，t4 已披露） |
| `R2-` | 6 | **6/6** | 服务端/客户端 parse 第一个 `/`、命中不计预算、码元截断、前缀丢分隔符 + 1 条既有 migrate 域 `R2-hidden-paper-skipped` |
| `R3-` | 5 | **5/5** | 坏行静默、半成品识别停用、回滚前缀无分隔符、/migrate busy 门失效、清空退回只看根层 |
| **合计** | **19** | **19/19** | 每条都是「注入=1（红）/ 还原=0（绿）/ diff=clean」 |

- 每条输出形如 `OK R2-hits-not-counted-in-budget 注入=1 还原=0 diff=clean`；注入的 testFile 指向自造/评审探针，不是实现方自测。
- 跑完核对：`sha256sum -c` 对 `src/*.ts`+`lib/client.js` 全通过（`SRC_LIB_RESTORED`）；
  `git diff` 仍只有实现轮改过的 7 个源文件 + `test/mutation-probe.mjs`，无变异残留。

## 6. 未修 / 存疑 / 观察

**未修：0 项；存疑：0 项。** A–H 8/8 已修。以下为不影响结论的观察（与 t4/t5/t6/t11/t14 已披露项一致，我独立复核过不构成回归）：

1. `resolvePaper` 对「同名论文多处」直接抛「命中多篇」——这是既有契约（需 `topic` 限定），本轮 G 已把**范围装配**路径改成 `listPapers` + `paperRefFor` 并如实 omitted；单篇定位仍会抛错（t5 已登记，非本轮回归）。
2. `boundaryOnly` 放行前导点等历史怪名（F 要求「legacy 怪名字可删」，这是设计方向）；不存在的怪名给 404 而非 400。安全边界（`..`、编码变形、库外）仍 400。
3. E2「空目录」识别会清理**同名的用户空目录**（无数据可丢；目录里有任何陌生条目就不动）——t6 已登记，属取舍。
4. `/migrate` 的 busy 门覆盖「在飞转录/译文」，本轮只验证了译文侧（假 babeldoc 在位）与并发响应性；慢转录时序未单独构造（与 t6 登记一致）。
5. 变异 `R1-` 前缀下有 3 条既有 migrate 域变异（`R1-quarantine-aborts-library` / `R1-silent-skip` / `R1-false-success-marker`），来自 IM 域而非 A–H；它们在全绿说明未被本轮改动改废。
6. `test/pr8-verification.test.mjs` 目前是**未跟踪文件**：集成提交时必须 `git add`，否则本验证探针不在 CI 覆盖内（实现方/评审方的新测试文件同理）。
7. 仓库既有守卫 `VC1` 的 allowed 白名单限定了可改动面；任何验证产物都必须落在 `.probe/`（gitignored）或 `test/`、`docs/` 内。我已清理误建的 `.ver-tmp/`。

## 7. 是否具备进入集成的前置条件

**满足。** 依据：

| 前置条件 | 结果 |
| --- | --- |
| `npm run build` | exit 0；构建前后 `src/lib/dist` 哈希一致 |
| 全量 `node --test "test/*.test.mjs"` | **675 tests / 648 pass / 0 fail / 27 skip**（skip 全为既有真实样本缺失） |
| 三份实现方用例 | 15/15、13/13、10/10 |
| 三份评审方探针（修复树） | 18/18、16/16、10/10 |
| 三份评审方探针（基线） | 4/15、1/16、1/10 红 ⇒ 修前必红成立 |
| 自造验证探针 | 修复树 23/23；基线 1 pass / 22 fail |
| 变异汇总 | R1 8/8、R2 6/6、R3 5/5（共 19 条，注入红/还原绿/diff clean） |
| A–H | **8/8 已修**，0 未修 / 0 存疑 |
| 越界改动 | 无（未改 `src/`、`lib/`、他人测试、`package.json`、README、`docs/features.md`；未 commit/push/rebase） |

**移交说明（不属本次验证职责，但集成必须处理）**：
① 分支落后 `origin/main` 12 个提交（含 issue #9 修复），本轮未 rebase——集成按团队既定方案报告合并风险；
② 新增/修改的测试与证据文件需随提交 `git add`（含本文件与 `test/pr8-verification.test.mjs`）；
③ 部署/推送仍需用户显式确认。
