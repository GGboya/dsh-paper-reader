# PR #8 评审回复：A–H 逐条修复说明

致 @GGboya：

感谢这轮把「新布局语义与既有点的交互面」逐条拆开——每条都能在本机复现，修起来也有明确着力点。
下面按你原文的 A–H 逐条回答：**改法（file:line）→ 证据（可复跑）→ 状态**；另附「其它（不阻塞）」6 项的处理、我们已登记的已知限制，以及与你「我这边已修好」三项的重叠说明。

本轮范围 = 你列的 A–F 必修 + G–H 应修；`docs/features.md` / `features_EN.md` 的新功能章节与 `AGENTS.md` 模块清单**没有重复改**（由你并入时带上即可，见 §5）。
所有实验均在 `mkdtemp` 临时库 + 临时 `DSH_HOME` 下进行，未触碰真实文献库；本轮**未 push**，等你再看一轮。

---

## 0. 结论速览

| 项 | 你的判定 | 本轮状态 |
| --- | --- | --- |
| A 会话 id 与嵌套专题 | 必修 | **已修** |
| B 上传无碰撞检查 | 必修 | **已修** |
| C 目录/文件互踩（4 处 + 祖先巡检） | 必修 | **已修** |
| D 清空/删除占用只看一层 | 必修 | **已修** |
| E 迁移工具契约缺口（坏 JSONL / 阶段 1 中断 / 阻塞与 busy） | 必修 + 次级 | **已修** |
| F `boundaryOnly` 长度回归 | 必修 | **已修** |
| G 范围提问预算与诚实性（含码点截断） | 应修 | **已修** |
| H 客户端嵌套结构追踪 | 应修 | **已修** |
| 其它（不阻塞）6 项 | 记录在案 | 1 项部分（平台分支）、5 项未做 + 理由（§3） |

---

## 1. 验证口径（每条缺陷都先红后绿）

- **修前基线**：`fdb45f2` 的独立工作树，缺陷用例在其上必须红（不是读代码猜的）；
- **修后**：同一批用例在修复树上全绿；基线红/修复绿的数字写在各条证据里；
- **变异验证**：把实现改回缺陷态，对应用例必须变红，还原后回绿，`git diff` 必须干净；
- **全量回归**：`node --test "test/*.test.mjs"`（基线 **533 tests / 506 pass / 0 fail / 27 skip**；修复后 **675 tests / 648 pass / 0 fail / 27 skip**，skip 全部是真实 MinerU 样本缺失的既有跳过）。改 `src/` 后一律 `flock /tmp/dpr-pr8-build.lock -c 'npm run build'`（测试 import `dist/`）。

复跑入口（都在 `pr8-fixes` 工作树根目录）：

```bash
BASE=/home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-baseline
flock /tmp/dpr-pr8-build.lock -c 'npm run build'
node --test "test/*.test.mjs"                                   # 全量
node --test test/pr8-layout-collision.test.mjs                  # 实现方用例（B/C/F）
node --test test/pr8-session-client-scope.test.mjs              # 实现方用例（A/G/H）
node --test test/pr8-clear-migrate.test.mjs                     # 实现方用例（D/E）
node --test test/pr8-review-r1.test.mjs                         # 独立评审探针（B/C/F）
node --test test/pr8-review-r2.test.mjs                         # 独立评审探针（A/G/H）
node --test test/pr8-review-r3.test.mjs                         # 独立评审探针（D/E）
node --test test/pr8-verification.test.mjs                      # 独立验证探针（A–H 全覆盖）
VER_REPO=$BASE node --test test/pr8-verification.test.mjs       # 同一探针跑基线（应大面积红）
node test/mutation-probe.mjs --only R1-                         # 变异（R1–R5 共 29 条）
```

基线对照实测（独立评审探针）：`R1_REPO=$BASE` ⇒ 4 pass / 15 fail；`R2_REPO=$BASE` ⇒ 1 pass / 16 fail；
`R3_REPO=$BASE` ⇒ 1 pass / 10 fail；独立验证探针 `VER_REPO=$BASE` ⇒ 1 pass / 22 fail。
即「修前必红」不是自述，而是同一份用例在两棵树上跑出来的。

---

## 2. A–H 逐条

### A. 会话 id 与嵌套专题不兼容（必修）——已修

- **问题**：`paperFromSessionId` 与客户端 `parseDprSession` 都按第一个 `/` 切 `topic/name`；`A/B/P` 被解成
  `topic=A, name=B/P` ⇒ 深专题会话绑定失效、ⓘ 永远常亮。
- **改法**：按**最后一个** `/` 切（论文名不允许 `/`）。
  - 服务端：`src/tools.ts:78`（`const sep = decoded.lastIndexOf('/')`）
  - 客户端：`lib/client.js:82-98`（`parseDprSession`），并新增 `dprSessionStale` 供 ⓘ 判定
- **证据**：`docs/evidence/pr8-session-client-scope.md`；`docs/evidence/pr8-review-r2.md`（独立评审）；
  `docs/evidence/pr8-verification.md` §2-A（基线 `{topic:"VerA",name:"VerSubB/VerPaperC"}` → 修复 `{topic:"VerA/VerSubB",name:"VerPaperC"}`，服务端/客户端两侧）
- **复跑**：`node --test test/pr8-session-client-scope.test.mjs`；`node --test --test-name-pattern="VER-A" test/pr8-verification.test.mjs`
- **状态**：**已修**（单层不回归、非法 id 仍 `null`）

### B. 上传无碰撞检查（必修，会吞数据）——已修

- **问题**：上传直接 `mkdir <topic>/<stem>/`；撞已有子专题 ⇒ 其下论文整体消失；撞旧平铺论文 ⇒ 学习进度被文件夹规则永久遮蔽；撞已有论文目录 ⇒ 覆盖/合并；大小写变体静默吞。
- **改法**：在**消费请求体之前**完成四类预检（`src/host.ts:684-712`）：
  - topic 路径落在论文目录里 ⇒ 409（`paperDirAncestor`，`src/library.ts:169`）
  - 目标 `<topic>/<stem>/` 已存在（子专题 / 论文目录 / 同名文件）⇒ 409，文案按类型区分（`src/host.ts:688-702`）
  - 同层旧平铺产物（`<stem>.pdf/.txt/.study.json/...`）⇒ 409（`flatArtifactNames`，`src/library.ts:184`；`src/host.ts:704`）
  - 仅大小写不同的同名对象 ⇒ 409 并点名磁盘真名（`caseVariantCollisions`，`src/library.ts:197`；`src/host.ts:708`）
- **证据**：`docs/evidence/pr8-layout-collision.md`；`docs/evidence/pr8-review-r1.md` / `pr8-review-r1b.md`；`docs/evidence/pr8-verification.md` §2-B（基线三处 200 + 子专题论文消失/平铺被遮蔽 → 修复 409 + 全库快照逐字节不变）
- **复跑**：`node --test test/pr8-layout-collision.test.mjs`；`node --test --test-name-pattern="VER-B" test/pr8-verification.test.mjs`
- **状态**：**已修**；正常上传（落 `<topic>/<论文名>/<论文名>.pdf`）不回归

### C. 目录/文件互踩（必修）——已修

- **问题**（4 处 + 祖先巡检）：
  1. `renameTopic` 不拒绝论文目录当父；`create-topic` 祖先巡检、上传 topic 解析同漏；
  2. `create-topic` 不查与平铺文件同名；
  3. `renameLegacyPaper` 冲突预检不查同名目录；
  4. 新布局 `renamePaper` 丢掉逐文件冲突预检 ⇒ 目录内同名残留被 `renameSync` 静默覆盖。
- **改法**：
  - `create-topic`：论文目录祖先 ⇒ 409（`src/host.ts:595`）；同层平铺同名 ⇒ 409（`src/host.ts:603`）；大小写变体 ⇒ 409（`src/host.ts:611`）
  - `upload` 的 topic 解析：路径落在论文目录 ⇒ 409（`src/host.ts:684-686`）
  - `renameTopic`：目标父级是论文目录 ⇒ 409（`src/library-manage.ts:1326-1328`，`paperDirAncestor`）；同级大小写变体 ⇒ 409（`src/library-manage.ts:1306-1320`，同父级只豁免「源自身」）
  - `renameLegacyPaper`：撞同名目录 ⇒ 409（`src/library-manage.ts:1233`）
  - `renamePaper`：**逐文件**冲突预检先于任何 rename（`src/library-manage.ts:1140-1160`），同一目录项例外走 `sameFileForRename`（`src/library-manage.ts:1101`，`ino/dev` 为 0 的平台一律按冲突）
- **证据**：`docs/evidence/pr8-layout-collision.md`；`docs/evidence/pr8-review-r1.md` / `r1b.md`；`docs/evidence/pr8-platform-guards.md`（C4 平台守卫 + 大小写变体）；`docs/evidence/pr8-review-r5.md` / `r5b.md`（renameTopic 排除自身）；`docs/evidence/pr8-verification.md` §2-C
- **复跑**：`node --test test/pr8-layout-collision.test.mjs`；`node --test test/pr8-platform-guards.test.mjs`；`node --test --test-name-pattern="VER-C" test/pr8-verification.test.mjs`
- **状态**：**已修**（基线 5 处 200 → 修复 409 + 零改动；含「源目录内同名残留 KEEP-RESIDUAL 不再被覆盖」现场）

### D. 清空/删除的占用检查只看一层（必修）——已修

- **问题**：`/topic/clear` 的会话/译文巡检只遍历根层 `plan.papers`，但删的是整棵子树；确认框同样漏列子专题论文（`papers=['P1']` 而 `papersCount=2`）。
- **改法**：清空单元树统一展开（`src/host.ts:473 flattenClearPapers`）：
  - clear-plan 逐篇列**整棵子树**（`src/host.ts:971`），`papersCount` 与清单严格相等；
  - clear 的会话/译文巡检遍历整棵子树（`src/host.ts:1031`），任一在跑 ⇒ 409 `session-running`，零改动、零回收站写入；
  - 非空专题删除仍返回 `clearEndpoint`（`src/host.ts:890`）供 UI 进入清空中间态。
- **证据**：`docs/evidence/pr8-clear-migrate.md`；`docs/evidence/pr8-review-r3.md` / `r3b.md`；`docs/evidence/pr8-verification.md` §2-D（基线 `cleared:2` 真写 `.trash` → 修复 409 + 快照零改动）
- **复跑**：`node --test test/pr8-clear-migrate.test.mjs`；`node --test --test-name-pattern="VER-D" test/pr8-verification.test.mjs`
- **状态**：**已修**

### E. 迁移工具自身契约缺口（必修 + 次级）——已修

- **问题**：
  1. `readMigrationLog` 整段 try/catch，坏行 ⇒ `[]` + `--rollback`「已回滚 0 个文件」且 exit 0；
  2. 阶段 1 mkdir 后/`.pdf` 复制前被打断，复跑被判 `dir-other` 冲突 ⇒ 该篇永远跳过；
  3. 次级：`/migrate` 在事件循环上同步跑全量，且无 busy 门。
- **改法**：
  1. 逐行解析，坏行显式报错（行号 + 原因）：`src/migrate.ts:515-542`（`migrate-log-corrupt`）；CLI 映射非 0 退出，路由映射 409（`src/migrate.ts` CLI、`src/host.ts:1123+`）
  2. 阶段 1 也写半成品标记 `.migration-v1.inprogress`（`src/migrate.ts:34`），复跑识别「自己上次的半成品目录」并续跑/替换半截产物，完成后清标记；`plan.halfProducts` 显式记账（`src/migrate.ts:245/279/428`）
  3. `/migrate` 走异步执行体（每文件 `setImmediate` 让出事件循环，`src/migrate.ts:728 runMigrationAsync`；`src/host.ts:1082`），并对在飞转录/译文加 busy 门（`src/host.ts:1076-1080`，409 `busy` 点名论文）
- **证据**：`docs/evidence/pr8-clear-migrate.md`；`docs/evidence/pr8-review-r3.md` / `r3b.md`；`docs/evidence/pr8-verification.md` §2-E（基线：坏日志 exit 0 → 修复 exit 1 指第 2 行；空目录现场 `moves=[]`/`copied=0` → `moves=2`/`copied=2`；迁移中并发 GET 基线被堵到结束 → 修复 10.7ms/184ms 返回；在飞译文基线 200 → 修复 409 `busy`）
- **复跑**：`node --test test/pr8-clear-migrate.test.mjs`；`node --test --test-name-pattern="VER-E" test/pr8-verification.test.mjs`
- **状态**：**已修**。如实补充一条：你说的「**每次**复跑都被跳过」在我们的复刻里只在**空目录**现场成立；若中断发生在首个文件已复制之后，基线能凭 `isPaperDir` 恢复该篇（`copied=1`）——缺的是显式半成品标记（基线无 `.migration-v1.inprogress`）。修复后两种现场都收敛，见 `docs/evidence/pr8-verification.md` §2-E「复核事实」。

### F. `boundaryOnly` 长度回归（必修）——已修

- **问题**：`validateTopicPath(boundaryOnly)` 也执行新的 `MAX_TOPIC_SEG=100`，上一版允许 120 ⇒ 已存在的 110 字专题删不掉也改不了名。
- **改法**：长度上限只在**命名规范侧**（创建 / 改名-to）执行；`boundaryOnly`（删除 / 改名-from / 清空）只保留深度与安全边界：`src/library.ts:96/102`（`if (!opts.boundaryOnly && …)`）。**没有**放宽 `..` / 编码变形 / 库外 / 符号链接这些安全边界。
- **证据**：`docs/evidence/pr8-layout-collision.md`；`docs/evidence/pr8-review-r1.md` / `r1b.md`；`docs/evidence/pr8-verification.md` §2-F（基线 110 字空专题删除 400、改名 400 → 修复 200/200；创建侧仍 400；`../`、`%2e%2e%2f` 仍 400）
- **复跑**：`node --test --test-name-pattern="VER-F" test/pr8-verification.test.mjs`；`node --test test/pr8-layout-collision.test.mjs`
- **状态**：**已修**

### G. 范围提问的预算与诚实性（应修）——已修

- **问题**：命中片段不计入 `used` 预算且与正文重复同一段 ⇒ 12 篇×3 命中 `totalChars≈72.5k`；omitted 提示句重复；同名多命中被静默吞；`kind:'topic'` 不校验专题存在 ⇒ 空范围 200；短正文全覆盖时 `coverage` 误报 `truncated`；5 处码元截断切开代理对。
- **改法**：
  - 预算：实际追加多少计多少，命中片段只出现一次（`src/scope.ts:290 budget` / `setCov`，`:297`）；`totalChars = manifestChars + bodyChars + hitChars`
  - omitted 提示句只输出一次（`src/scope.ts:395-401`）
  - 专题存在性：`resolveScopePapers` 先 `validateTopicPath + resolveTopicDir`，不存在 ⇒ `ManageError('not-found',404)`（`src/scope.ts:189-206`）；`/api/ask` 对 `isManageError` 直接 404（`src/host.ts:1773-1785`）
  - 同名多命中：`listPapers` + `paperRefFor` 精确构造，同名进 `skipped` ⇒ `omitted-duplicate` + 原因（`src/scope.ts:189-224`）
  - coverage 诚实：无命中时按「是否真的切掉正文」判 `full`/`truncated`（`src/scope.ts:349-365`）
  - 码点安全：新增 `cutToCodePoint`（`src/scope.ts:42`）替换 5 处截断（正文 limit ×2、命中 1200 ×2、清单/readText 路径）；语义 = 切点落代理对中间就少切 1 码元
  - 次级：`scopeBusy` 的 key 解析成路径后做双向前缀判定（`src/host.ts:446`）；回滚日志路径改 `relative` 目录内判定（`src/host.ts:1113`）
- **证据**：`docs/evidence/pr8-session-client-scope.md`、`docs/evidence/pr8-coverage-honesty.md`、`docs/evidence/pr8-review-r4.md`；`docs/evidence/pr8-review-r2.md` / `r2c.md`；`docs/evidence/pr8-verification.md` §2-G（基线 `totalChars=72845`/omitted 句 2 次/needle 重复 2 次/台账 `full=undefined`/同名只剩 1 篇；修复 `39591`/1 次/1 次/台账自洽/2 篇 `omitted-duplicate`+2 条原因；不存在专题 200+prompted → 404+prompted=0；U+1D400 孤立代理项 1 → 0）
- **复跑**：`node --test test/pr8-session-client-scope.test.mjs`；`node --test test/pr8-coverage-honesty.test.mjs`；`node --test --test-name-pattern="VER-G" test/pr8-verification.test.mjs`
- **状态**：**已修**

### H. 客户端嵌套结构追踪（应修）——已修

- **问题**：祖先专题改名/删除只按精确相等更新 `cur`/`dpr.last`/closed 键；`openDelete` 只数直接论文 ⇒ 论文全在子专题时没有 UI 路径到 `/topic/clear`；`clearEndpoint` 没挂到 `Error` 上 ⇒ 清空重试是死代码。
- **改法**（客户端纯函数层，`lib/client.js`）：
  - `dprReprefixTopic`（`:107`，前缀 + `oldTopic + '/'` 分隔符判定，`A` 改名不误伤 `AB`）
  - `dprRekeyTopicState`（`:120`，整体重写 `cur` / 折叠键 / `last`；调用点 `:1171`、`:1180`）
  - `dprTopicPaperCount`（`:142`，按分隔符数**子树**；调用点 `:1281`）
  - `dprApiError`（`:148`，透传 `code/status/papers/entries/clearEndpoint/clearPlanEndpoint`）+ `dprClearRetryNeeded`（`:162`，重试判据；调用点 `:1379`）
- **证据**：`docs/evidence/pr8-session-client-scope.md`；`docs/evidence/pr8-review-r2.md` / `r2c.md`；`docs/evidence/pr8-verification.md` §2-H（基线无这些纯函数、行为级 H1c 在基线红 → 修复 `cur/last = X/VerA/Sub`、折叠键 `['VerAB','X/VerA/Sub']`、`count(A)=3`、clearEndpoint 透传 + retry=true）
- **复跑**：`node --test test/pr8-session-client-scope.test.mjs`；`node --test --test-name-pattern="VER-H" test/pr8-verification.test.mjs`；基线对照 `R2_REPO=$BASE node --test test/pr8-review-r2.test.mjs`
- **状态**：**已修**

---

## 3. 其它（不阻塞）6 项：本轮做了什么 / 没做什么

| # | 你记的项 | 本轮处理 | 理由 |
| --- | --- | --- | --- |
| 1 | 重复 CSS 块（`reader/index.html:143-147`） | **未做**（实测仍在：`reader/index.html:138-142` 与 `143-147` 重复） | 本轮只修评审 A–H；纯样式重复无行为影响，而 `reader/` 与本轮源码改动不同面，动它只会增加与 main #9 的冲突面。建议合并时一并清，或留一个小提交。 |
| 2 | `DARK_PRESETS` 三处重复声明 | **未做**；当前 HEAD 上档位表只有 `src/theme-config.ts:35` 一处（阅读器 `reader/index.html:418` 仅保留一个默认曲线兜底值，等 host 推送覆盖） | 「三处」在本树未复现；无行为收益的重构不做，避免与你的合并面冲突。若你指的是「默认值与档位表两处」的语义重复，可在合并后统一。 |
| 3 | `theme-config.ts` 是第 5 份手写 0600 配置样板 | **未做**（现有 5 处：`src/embed-config.ts:55`、`mineru-config.ts:219`、`theme-config.ts:121`、`translate-config.ts:68`、`typesafe-config.ts:60`） | 抽公共写入器是跨 5 个模块的重构，收益是代码整洁、风险是 0600/时序语义回归；不属于本轮评审缺陷，留给后续专项。 |
| 4 | 死导出 `normalizeTopicPath` 零调用 | **未做**（仍导出：`src/library.ts:128`；`src/library-manage.ts:28` 仅 import 未调用） | 删除是公开 API 变更（外部可能与 `src/library.ts` 同名函数混用），无行为影响，留给后续清理。 |
| 5 | 回收站 manifest 漏隐藏文件（`library-manage.ts:611`） | **未做**（论文级 `manifest.files` 仍只列产物；隐藏条目**本身会随 `[...hidden, ...plan.files]` 一起进回收站，不丢数据**，只是恢复清单不列） | 纯恢复线索的完整性问题、无数据丢失；属 `src/` 改动，不在本轮评审 A–H 内，集成轮不自行改代码（见 §6 流程约束）。可作后续小修。 |
| 6 | 大小写改名在 macOS/Windows 被拒（`library-manage.ts:1228`） | **部分**：论文级 case-only 改名走 `sameFileForRename` 允许同一目录项（`src/library-manage.ts:1101/1154`）；专题级 self-case 在**大小写敏感盘**恢复 200（`src/library-manage.ts:1306-1320`），在**不敏感盘（APFS/NTFS 默认）**仍是 409（`src/library-manage.ts:1331` 的 `existsSync(target)` 命中别名） | 未做「两步 rename」绕解：它会引入中间临时名与失败回滚路径，风险高于收益；平台分支已用 `fs-probe` 实测断言（不硬编码平台名），见 `docs/evidence/pr8-platform-guards.md` 与 `pr8-review-r5b.md`。 |

---

## 4. 我们已如实登记的已知限制 / 后续项（评审里都写了，不只列你上面的 6 项）

1. `/api/ask` 的 `scope` 响应白名单未透传 `full` / `manifestTruncated`（低危 API 元数据；block 文本与逐篇 `coverage` 仍如实）——`docs/evidence/pr8-review-r4.md` §六。
2. 同名论文策略：两篇都显式 `omitted-duplicate` + 原因、不展开；要两篇都纳入需改 `library.ts:resolvePaper` 契约——`docs/evidence/pr8-review-r2.md` §六。
3. legacy 长名专题暂不能作为提问范围（`validateTopicPath(topic,false)`），与上传同族、非本轮回归——`pr8-review-r2.md` §六。
4. E2 的「空目录」半成品判据可能清掉同名**用户空目录**（无数据；目录里有任何陌生条目一律不动）——`docs/evidence/pr8-review-r3.md` §七。
5. `/migrate-rollback` 的 logDir 内符号链接：词法边界可通过（需本地写权限才能构造；条目仍过 `safeRel`）——`pr8-review-r3.md` §七。
6. `planMigration` 只读规划仍同步（首跑只 stat）；转录 busy 与译文共用同一门控，但未单独造「慢转录」时序夹具——`pr8-review-r3.md` §七。
7. `cutToCodePoint` 是本树的**等价回退**（本分支 `src/search.ts` 是旧版、没有 main 的 #9 导出）；合入 main 后需与 `search.ts` 的导出去重对账——`pr8-review-r2.md` §六。
8. 大小写策略是**刻意保守**：create-topic/upload 在大小写敏感盘上也拒绝仅大小写不同的对象（跨平台一致）；`renameTopic` 仅在同父级豁免「源自身」；不敏感盘 self-case 仍 409——`docs/evidence/pr8-review-r5.md` §四 / `r5b.md`。
9. C4 的 `sameFileForRename` 比你的要求更保守：hardlink（同 inode、不同目录项）也判冲突——`docs/evidence/pr8-review-r1b.md`。
10. E2 的「每次复跑都跳过」只在空目录现场成立（首文件已复制时基线能恢复该篇）；修复同时提供「显式半成品标记 + 识别清理」，两种现场都收敛——`docs/evidence/pr8-verification.md` §2-E。

---

## 5. 与你「我这边已经修好了」的重叠

1. **`scope.ts` 的 5 处码元截断**：本分支 `src/search.ts` 还是旧版（没有 `cutToCodePoint` 导出），因此我们按你的要求做了**等价回退**（`src/scope.ts:42`，语义：切点落代理对中间就少切 1 个码元），并把 5 条可达截断路径都换掉；用例 `test/pr8-review-r2.test.mjs` GC1–GC5 + `test/pr8-review-r4.test.mjs`、`test/pr8-verification.test.mjs` VER-G3/G4。**合入 main 后我们会与 `search.ts` 的导出对账去重**（重复导出会让两条实现漂移）。
2. **`docs/features.md` / `features_EN.md` 新功能章节**：按你的说明由你在合并时带上；我们**没有改**这两个文件（父提交里没有这些章节，重复改只会制造冲突）。
3. **`AGENTS.md` 模块清单**：同样没动，留给你并入。

其它可能与你 main 的交叉点：本分支落后 `origin/main` 12 个提交（见 §7），`search.ts` / `theme-config.ts` / `reader/` 的 main 侧改动我们没在本轮触碰；合并时这部分以 main 为准 + 上述对账。

---

## 6. 变更面、提交与流程约束

- **改动的实现面（8 个文件）**：`src/host.ts`、`src/library.ts`、`src/library-manage.ts`、`src/migrate.ts`、`src/scope.ts`、`src/tools.ts`、`lib/client.js`，以及测试/证据工具 `test/mutation-probe.mjs`。
- **新增测试（全部入库，不靠本地脚本）**：`test/pr8-layout-collision.test.mjs`（15）、`test/pr8-session-client-scope.test.mjs`（13）、`test/pr8-clear-migrate.test.mjs`（10）、`test/pr8-platform-guards.test.mjs`（7）、`test/pr8-coverage-honesty.test.mjs`（9）、独立评审探针 `test/pr8-review-r1/r2/r3/r4/r5.test.mjs`（18/16/10/8/13）、独立验证探针 `test/pr8-verification.test.mjs`（23）。
- **证据**：`docs/evidence/` 下 16 份（实现/覆盖证据 5：layout-collision、session-client-scope、clear-migrate、platform-guards、coverage-honesty；独立评审 10：r1/r1b/r2/r2b/r2c/r3/r3b/r4/r5/r5b；独立验证 1：pr8-verification；见 §2 各条的链接）。
- **变异**：`test/mutation-probe.mjs` 新增 `R1-`…`R5-` 共 **29 条**（R1 8 / R2 6 / R3 5 / R4 6 / R5 4），全部「注入红 → 还原绿 → `git diff` clean」，且不依赖实现方用例作为唯一判据（多数锚在独立评审/验证探针上）。
- **未改**：`package.json` 版本、`README*`、`docs/features*.md`、`AGENTS.md`、`dist/`（构建产物不入库）。
- 本轮**没有 push**，提交只落在本地 `feat/darkmode-subtopic` 分支（单个提交，不改写已有历史）。

---

## 7. 合并风险与建议

- **push 命令（待你/用户确认后再执行）**：

  ```bash
  git -C /home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes push fork feat/darkmode-subtopic
  ```

- **风险 1：分支落后 `origin/main` 12 个提交**（含 v1.5.1 issue #9 修复、v1.6.0、preset 迁移）。
  你在评审时看到 GitHub `mergeable=false` 大概率来自这里。
  我们的建议：**不要自动 rebase**。这批 15 个既有提交 + 本轮修复构成一条完整历史，rebase 会把 15 个提交全部重排，
  冲突面集中在 `src/search.ts`（#9 的码点修复）、`src/theme-config.ts`（sample/0600 样板）与 `reader/`；
  建议**合并时由你按 main 为准处理**，或先单独跑一次 `git merge origin/main` 试冲突面再决定是否 rebase。
- **风险 2：合并时需对账的点**（已在 §4/§5 列出）：`cutToCodePoint` 与 main `search.ts` 导出重复；`scope` 响应白名单；
  `README` 的 docs 引用守卫（新增 `docs/evidence/*` 已 `git add`，README 本身未改）。
- **建议**：你先按 §1 的复跑入口把 `pr8-verification.test.mjs` 在两棵树上跑一遍（修复树 23/23、基线 1/22 红），
  再决定是「squash 成一个提交」还是保留本轮单提交。是否 rebase 由用户决定，我方不擅自改写历史。

再次感谢这轮评审——A–H 每条都在基线复现过才动手，修完也都在同一基线上验证过「红→绿」。
