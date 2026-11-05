# PR #8 必修 D / E + 应修 G（host 侧）—— 清空子树占用、迁移日志/中断/阻塞、scopeBusy 与回滚路径

对应 `docs/pr8-maintainer-review.md` 的 **D（清空/删除占用检查只看一层）**、**E（迁移工具两个契约缺口 +
/migrate 阻塞与 busy 门）**、以及 **G 的 host 侧两条次级项（scopeBusy 分隔符 / 回滚日志前缀）**。

- 修复工作树：`.worktrees/pr8-fixes`（`feat/darkmode-subtopic`，HEAD `fdb45f2`，含 IMP1/t1 的 B/C/F 改动）
- 基线工作树：`.worktrees/pr8-baseline`（detached @ `fdb45f2`，已 build）
- 新增用例：`test/pr8-clear-migrate.test.mjs`（10 条）
- 证据：**基线 10 条全红 → 修复后 10/10 绿**；每条都先复现、再改实现
- 本任务只改：`src/host.ts`、`src/migrate.ts`、`test/pr8-clear-migrate.test.mjs`、本文件
  （`src/library-manage.ts` 的 plan 层结构已够用，**未改动**；t1 的改动原样保留）

## 0. 复现命令（红/绿统一口径）

```bash
# 红：把新用例复制到基线树（fdb45f2 已 build 的 dist）跑
cp .worktrees/pr8-fixes/test/pr8-clear-migrate.test.mjs .worktrees/pr8-baseline/test/
cd .worktrees/pr8-baseline && node --test test/pr8-clear-migrate.test.mjs

# 绿：修复树加锁 build（测试 import dist/），再跑
cd .worktrees/pr8-fixes && flock /tmp/dpr-pr8-build.lock -c 'npm run build'
cd .worktrees/pr8-fixes && node --test test/pr8-clear-migrate.test.mjs
```

**基线（`fdb45f2`）：`# tests 10 / pass 0 / fail 10`。修复后：`# tests 10 / pass 10 / fail 0`。**

| 编号 | 缺陷 | 基线（红）关键输出 | 修复后（绿） | 落点 |
|---|---|---|---|---|
| D1 | `/topic/clear` 占用巡检只看根层，子专题论文照删 | 200 `cleared:2`（两篇都进回收站） | 409 `session-running`，零改动/零 `.trash` | `src/host.ts:471,1022` |
| D2 | `/topic/clear-plan` 清单只含根层，`papersCount` 却是子树总数 | `papers:[P1]` + `papersCount:3` | `papers:[P1,Sub/P2,Sub/Deep/P3]`, count=3 | `src/host.ts:961` |
| D3 | 子专题论文生成中译文时照样清空 | 200 `cleared:2` | 409 `translation-busy` 且点名 `T/Sub/P2` | `src/host.ts:1022` |
| E1 | 坏行日志 → `readMigrationLog=[]`，CLI 回滚「0 个文件」exit 0 | 无异常；CLI exit 0 | 抛 `migrate-log-corrupt`（第 3 行）；CLI exit 1 | `src/migrate.ts:515` |
| E1b | `/migrate-rollback` 对坏行日志 200 假成功 | `200 {"restored":0}` | 409 `migrate-log-corrupt`（第 2 行） | `src/migrate.ts:515` + `src/host.ts:1118` |
| E2 | 阶段 1 中断残留目录被判 `dir-other` ⇒ 永远跳过 | `copied:0`，仍 conflict/partial | `copied:2, removed:2, partial:false` | `src/migrate.ts:34,150,194,213,323,342,586,613` |
| E3a | `/migrate` 同步复制+双 sha256 冻住事件循环 | 读请求只能在迁移结束后被处理（剩余 7ms） | 读请求在迁移完成前 83ms 返回 | `src/migrate.ts:580,635,679,716,728` + `src/host.ts:1075` |
| E3b | `/migrate` 不管在飞译文直接开跑 | 200（迁移照跑） | 409 `busy`，文案点名 `T/P` | `src/host.ts:1066-1078` |
| G3 | paper 范围 scopeBusy 用 `\0` key 比对 `/` 路径 ⇒ 提示死代码 | prompt 无「正在被修改」 | prompt 出现提示 | `src/host.ts:434,446` |
| G4 | 回滚日志前缀 `startsWith` 缺分隔符 ⇒ `/a/bc` 冒充 `/a/b` | 200 `restored:1`（跑了兄弟目录日志） | 400 `escape-rejected`；目录内日志仍 200 | `src/host.ts:1104-1108` |

## 1. D —— 清空/删除的占用检查只看一层

### D1 `/topic/clear`：占用巡检遍历整棵子树（活跃会话）

维护者断言：`/topic/clear` 只遍历根层 `plan.papers`，但 `clearTopic` 删整棵子树 ⇒ 子专题里有活跃会话的论文照删。

复现：`T/P1`（根层，无会话）+ `T/Sub/P2`（子专题，mock 一个 `running:true` 的伴读会话），
`POST /api/library/topic/clear {topic:'T',confirmName:'T'}`。

修前基线（红）：

```
not ok 1 - D1 …
  子专题论文有活跃会话时必须拦住整次清空：
  {"ok":true,"topic":"T","cleared":2,"movedFiles":4,...,"subtopicsCleared":1,"detachedSessions":0,...}
  200 !== 409
```

修后（绿）：遍历 `flattenClearPapers(plan)`（递归 `subtopics`），任一篇 `requireSessionClear` 失败即整次拒绝：

```json
409 {"error":"该文献有 1 个正在运行的伴读会话，请先结束后再操作","code":"session-running","sessions":{"total":1,"running":1}}
```

用例断言：`snap()` 全库零改动、`.trash` 不存在、两篇论文都还在。落点：`src/host.ts:1022`；递归展开
`src/host.ts:471`（`flattenClearPapers`，复用 `planTopicClear` 的 `TopicClearUnit.subtopics`）。

### D2 `/topic/clear-plan`：确认清单含子树论文，`papersCount` 与清单一致

复现：`T/P1` + `T/Sub/P2` + `T/Sub/Deep/P3`，`GET /api/library/topic/clear-plan?topic=T`。

修前基线（红）：清单只有根层 `P1`，但 `papersCount:3`（自相矛盾，确认框看不到子专题论文）：

```
papers:[{"name":"P1","topic":"T",...}]   papersCount:3
```

修后（绿）：`papers` 用同一份扁平清单（逐篇带自己的 `topic`），`papersCount = allPapers.length`；
`subtopics` 汇总仍保留：

```
D2 => 200 papers= ["T/P1","T/Sub/P2","T/Sub/Deep/P3"] papersCount= 3 subtopics= [["T/Sub",2]]
```

落点：`src/host.ts:961-978`。清空执行行为（后序、回收站 bundle、回滚、标签口径）未动
（`clearTopic` 与 `planTopicClear` 一行未改）。

### D3 子专题论文「生成中译文」同样拦住整次清空

用假 babeldoc（`--version/--help` 立刻返回；真正拉起时写 pid 后 `sleep 120`）造**真实** `zhStatus().busy`，
不触发真实翻译。`T/Sub/P2` 进入 busy 后 `POST /topic/clear`。

修前基线（红）：200 `cleared:2`（翻译中的论文被搬进回收站）。修后（绿）：

```json
409 {"error":"以下文献正在生成译文，请等待完成后再清空：T/Sub/P2","code":"translation-busy","papers":["T/Sub/P2"]}
```

用例同时对 `T` 子树做逐字节快照断言零改动。落点：`src/host.ts:1022-1034`（译文巡检同样走扁平清单；
payload 的篇名对子专题论文带 `topic/name` 前缀，避免不同层同名论文撞名）。

> 平台边界：D3/E3b 依赖 POSIX `#!/bin/sh` 假 babeldoc；**win32 显式 skip 并写明原因**（与既有
> `VB8`/`B5` 同一平台限制，不做永真断言）。本机（Linux）真实执行，非跳过。

## 2. E —— 迁移工具的契约缺口

### E1 坏行日志不再静默假成功（`readMigrationLog` 逐行解析）

维护者断言：整个 JSONL 一个 try/catch，任何一行损坏（SIGKILL 打断 append）⇒ 返回 `[]` ⇒
`--rollback` 打印「已回滚 0 个文件」且 exit 0。

复现：正常迁移写出日志 → 追加一行**截断** JSON（模拟 append 被打断），然后：
`node dist/migrate.js --rollback <log>`。

修前基线（红）：`readMigrationLog` 不抛错；CLI **exit 0**、stdout 打「已回滚 0 个文件」。
修后（绿）：

```
E1 readMigrationLog => migrate-log-corrupt | 迁移日志第 3 行不是合法 JSON（Unterminated string in JSON at position 35 …）：{"from":"T/P1.txt","to":"T/P1/P1.tx
E1 CLI => exit 1 | stderr: 迁移失败（migrate-log-corrupt）：迁移日志第 3 行不是合法 JSON（…）：{"from":"T/P1.txt","to":"T/P1/P1.tx
```

实现（`src/migrate.ts:515`）：逐行 `JSON.parse`；坏行 → `MigrationError('migrate-log-corrupt',
'迁移日志第 N 行不是合法 JSON（原因）：前 120 字符')`；空行跳过；非对象 / 缺 `from|to` 也算坏行；
**日志不可读**（不存在/权限）→ `migrate-log-unreadable`（不再当作「0 条可回滚」）。
CLI 的既有 `MigrationError → exit 1` 分支直接接住（`src/migrate.ts:939`）；host 的 `/migrate-rollback`
补了 `MigrationError` 分支（否则会落到「系统错误」把行号吞掉，`src/host.ts:1118`）。

用例同时断言**完好日志回滚不回归**：exit 0、`已回滚 4 个文件`、平铺源真的搬回。

### E1b `/migrate-rollback` 对坏行日志 409

修前基线（红）：`200 {"ok":true,"restored":0,"dirsRemoved":[]}`（假成功）。修后（绿）：
`409 {"error":"迁移日志第 2 行不是合法 JSON（…）","code":"migrate-log-corrupt"}`。

### E2 阶段 1 中断残留目录：复跑可续，不再被 `dir-other` 永久跳过

**中断现场构造（不是声称）**：用 `runMigration` 的 `copyImpl` 依赖注入模拟「`mkdir <论文名>/` 后、
第一种产物复制前被 SIGKILL」：

- 场景 A：`copyImpl: () => { throw new Error('SIGKILL 模拟') }` ⇒ 目录 `T/P1/` 已建、`.pdf` 未复制；
- 场景 B：`copyImpl: (_from,to) => { writeFileSync(to,'PARTIAL'); throw new Error('SIGKILL 模拟') }`
  ⇒ 目录里有**写了一半的 partial 文件**。

修前基线（红）：复跑 `copied:0`，该篇仍以 `migrate-conflict / 目标名已被子专题目录占据` 被跳过
（`plan.halfProducts` 字段不存在）——每次复跑都一样，永远迁不完。

修后（绿）：

```
E2 after-kill dir exists= true marker= true plan.halfProducts= ["T/P1"]
E2 resume => copied 2 removed 2 partial false dir= ["P1.pdf","P1.txt"]
```

实现（`src/migrate.ts`）：

1. **半成品标记**：阶段 1 `mkdir` 后立刻在论文目录里写隐藏标记 `.migration-v1.inprogress`
   （`MIGRATING_MARKER`，`flag:'wx'` 幂等，`:34,611`）；阶段 1 全部复制/校验通过后统一删除（`:656`）。
2. **保守识别**（`ownHalfProductKind`，`:194`）：目标目录只允许是
   - `empty`：空目录（mkdir 后、写标记前就被杀的窗口；空目录没有任何用户数据）；
   - `marked`：带标记，且**其余条目全部**是这篇论文的产物名（`matchArtifactName`）。
   其它任何形态（陌生文件/目录/别人的隐藏文件）⇒ 仍按 `dir-other` 冲突，**绝不触碰**。
3. **完整度判别**（`targetMatchesSource`，`:150,323`）：带标记的论文目录也可能其实已复制完整
   （阶段 1 完成、删标记前被杀）⇒ 逐文件按 size+sha256（符号链接按链接目标）确认完整；完整就走
   普通 `dir-paper` 路径（进 `alreadyDone`、只清源），**保持既有 C5「复制到第 k 条被杀可复跑」语义**；
   不完整才进 `halfProducts`。
4. **续跑**：`runMigration` 在规划后先 `cleanupHalfProduct`（只删标记与本论文产物、非递归 rmdir，`:213,586`），
   随后照常复制；`planMigration` 把半成品的残留从 `orphans/hidden` 报告里剔除（否则干跑报告凭空多几条
   `T/P1/.migration-v1.inprogress` / partial `.txt` 孤儿）。

用例同时覆盖**别人的非空异目录**（`T/Other/note.md` + 平铺 `T/Other.pdf`）：不进 `halfProducts`、
仍报 `dir-other` 冲突、`copied:0`、`note.md` 内容与目录条目一字未变、平铺源原地不动。

### E3 `/migrate` 不阻塞事件循环 + 在飞转录/译文 busy 门

**不阻塞**：把 `runMigration` 的同步执行体抽成生成器 `runMigrationSteps`（每个文件复制/删除后
`yield`），同步入口 `runMigration` 一次跑完（行为逐字不变，既有 50+ 条迁移用例全绿）；
新增 `runMigrationAsync`（`src/migrate.ts:728`）在每次 `yield` 后 `setImmediate` 让出事件循环；
`/migrate` 改用它（`src/host.ts:1075`）。原子性/失败/回滚语义仍是**同一份实现**，没有第二套复制逻辑。

**可测量证据**（`E3a`，写清测法）：临时库 360 篇平铺论文 × 3 个产物（1080 个文件，copy+双 sha256+日志 fsync
足以产生可观测耗时）。测试先发 `/migrate`，`sleep(10ms)` 后发 `GET /api/library`，记录三个时刻：

```
E3a => GET 200 | sleep@ 66 ms | GET done@ 73 ms | migration done@ 156 ms | migration remaining at GET = 83 ms | copied 1080
```

断言：`migEnd - gStart > 30ms`（迁移确实仍在进行）、`gEnd < migEnd`、且 `migEnd - gEnd > 10ms`
（读请求返回时迁移尚未完成）。基线（同步实现）红点：timer/GET 都要等整个迁移跑完才轮得到，
实测 `migration 剩余 7ms`（即 GET 在迁移结束后才被处理）。

**busy 门**（`E3b`）：`/migrate` 开跑前检查
1. `activeTranscribes`（`src/host.ts:434`）：`/api/transcribe` 在 `await transcribePaper` 期间登记
   `topic\0name`，`finally` 移除（`:1629-1635`）；
2. 全库在飞译文 `translationBusyPapers()`（`:460`，逐篇 `zhStatus().busy`）。

有任一在飞 → 409（与 delete/rename 同口径的 409 + 可执行文案），且**在动任何文件之前**拒绝：

```json
409 {"error":"有文献正在转录/生成译文，请等待完成后再执行迁移：T/P","code":"busy","papers":["T/P"]}
```

基线 200 直接开跑（红）。平台边界同 D3：busy 门用真实假 babeldoc 译文验证；转录分支与译文共用同一
`if (busy.length > 0)` 门（代码同路径），未单独为「慢转录」造时序用例（没有可控的慢 PDF 夹具），
在此如实登记。

## 3. G 次级（host 侧两条）

### G3 paper 范围的 `scopeBusy` 提示真实触发

维护者断言：`scopeBusy` 用 `\u0000` 命名的 inflight key，却拿 `/` 分隔的 `scopePath` 做 `includes`
⇒ paper 范围的 busy 提示永远不触发（死代码）。

修前基线（红）：rename 在途时 `/api/ask` 注入的提示词没有 busy 提示（实测 prompt 全文无「正在被修改」）。

修后（绿）：把 paper 操作 key 显式改成 `paper\0<topic>\0<name>`（`src/host.ts:802,830`），`scopeBusy`
先把 key 解析成「被操作路径」再做**双向前缀**判定（范围包含在途操作 / 被在途操作包含；`migrate` 在途
也算「正在被修改」），`src/host.ts:446`。用例用「第一次会话查询延迟 400ms」把 rename 卡在
`withInflight` 里，再在窗口内发 `/api/ask`：

```
G3 => ask 200 | busy hint = true | "（提示：该范围内的目录正在被修改，本次只给了 1 篇）"
G3 rename => 200
```

### G4 回滚日志路径前缀补分隔符

维护者断言：`resolve(logPath).startsWith(resolve(logDir))` 没有路径分隔符 ⇒ `/a/bc` 会被 `/a/b`
误判通过。

修前基线（红）：`logPath=<logDir>-evil/x.jsonl` 通过检查 → 200 `{"restored":1}`（真的执行了兄弟目录日志）。
修后（绿）：`relative` + `..`/绝对路径判定（`src/host.ts:1106-1108`）：

```
G4 => evil 400 {"error":"logPath 必须是迁移日志目录内的文件","code":"escape-rejected"} | good 200 {"ok":true,"restored":2,"dirsRemoved":["T/P1"]}
```

正向对照（目录内合法日志）在同一用例里断言仍 200 且真的搬回平铺源。

## 4. 回归与全量

```bash
cd /home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes
flock /tmp/dpr-pr8-build.lock -c 'npm run build'       # exit 0
node --test test/pr8-clear-migrate.test.mjs             # 10 tests / 10 pass / 0 fail
node --test test/darkmode-subtopic-features.test.mjs    # 53 tests / 53 pass / 0 fail
node --test "test/*.test.mjs"                           # 588 tests / 561 pass / 0 fail / 27 skip
```

（全量 588 条包含本轮其他并行任务新增的 `test/pr8-*.test.mjs`；本任务新增 10 条。既有迁移用例
C2/C3/C4/C5/C8/C19/C20/C21/C22 全部保持绿——生成器重构与外层行为逐字一致。）

## 5. 取舍与边界（如实记录）

1. **E2 的「空目录」判据**：目标名与某篇平铺论文同名、且目录为空 ⇒ 视为我们上次的半成品并清理。
   空目录没有任何用户数据；只要目录里有陌生人任何条目，就仍按 `dir-other` 冲突**一个字节不动**
   （用例 B/C 覆盖）。带标记的目录还要「其余条目全是本论文产物」才认。
2. **E2 的完整度判别会为半成品目录多做一次 size+sha256**；这是为了避免把「其实已复制完整、只差清源」
   的目录退化成「删掉重抄」（既有 C5 语义要求 alreadyDone=2 / moves=2）。代价可忽略（只对带标记目录）。
3. **E3 的异步化只切分「每个文件」这一步**：`planMigration`（只读规划）仍是同步的（首跑只 stat；
   复跑对已存在目标才做 sha256）。本次没有把它也改成异步——它不在「全量复制+双 sha256 冻结路由」的
   主要耗时路径上，且改成异步会牵动 `migrate-plan` 只读路由与 CLI 的同步契约。如实登记。
4. **E1 顺带修了「日志不可读」**（不存在/权限）：旧实现同样静默返回 `[]`（0 个文件 exit 0），同属
   「降级必须如实提示」的假成功；现在抛 `migrate-log-unreadable`。
5. **转录 busy 门**有实现（`activeTranscribes`）与共用门控，但没有独立的「慢转录」时序用例（见 E3 段）；
   译文路径用真实 busy 验证。
6. `src/library-manage.ts` **未改**：D 所需的 `TopicClearUnit.subtopics/papers` 已存在，计划层无需改动；
   t1 在该文件的 B/C/F 改动原样保留。工作区里 `src/scope.ts`/`src/tools.ts`/`lib/client.js` 及他人
   `test/pr8-*.test.mjs` 的改动非本任务所为。
