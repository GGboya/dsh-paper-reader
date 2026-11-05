# PR #8 必修 D / E + 应修 G（host 次级）—— REV3 独立对抗评审（t6，评审对象 IMP3/t3）

- 评审对象：IMP3（t3）对 `docs/pr8-maintainer-review.md` **必修 D（清空/删除占用只看一层）**、
  **必修 E（迁移日志坏行 / 阶段 1 中断）/ E 次级（`/migrate` 阻塞与 busy 门）**、
  **应修 G 的 host 侧两条次级（`scopeBusy` 分隔符 / 回滚日志前缀）** 的修复。
- 修复工作树：`.worktrees/pr8-fixes`（`feat/darkmode-subtopic`，HEAD `fdb45f2` + 未提交修复）
- 基线工作树：`.worktrees/pr8-baseline`（detached @ `fdb45f2`，已 build）
- 本评审只新增/改动三样，均在 t6 inScope：`test/pr8-review-r3.test.mjs`（新，10 例）、
  `test/mutation-probe.mjs`（+5 条 `R3-` 变异）、本文件。**未改 `src/`、`lib/`、实现方 `test/pr8-*.test.mjs`；
  未 commit / push / rebase。**
- **独立性**：不 import 实现方 `test/pr8-clear-migrate.test.mjs`；**「阶段 1 被打断」的现场由本评审手工构造**
  （空目录 / 标记 + 半截产物），不是跑实现方的构造函数；坏 JSONL、会话 mock、假 babeldoc busy 态、
  900 文件迁移库、兄弟日志目录全部本评审自造。
- **双树对照**：同一份探针可跑基线 —— `R3_REPO=<baseline> node --test test/pr8-review-r3.test.mjs`
  ⇒ 基线 **10 红 / 1 绿**（唯一绿是基线模式自检），修复后 **10/10 绿**。
- 所有库 = `mkdtemp`；`DSH_HOME` = 临时目录（迁移日志落 `<tmp>/.dsh-paper-reader/migration-logs`），
  绝不碰真实文献库/真实 `~/.dsh`；构建全程 `flock /tmp/dpr-pr8-build.lock`。

## 一、结论（verdict: pass，无 blocker/medium）

| 评审条目 | 基线（fdb45f2，实际值） | 修复后（实际值） | 判定 |
|---|---|---|---|
| D1 子专题论文有活跃会话 ⇒ 清空必须被拒、零回收站写入 | `200 cleared:2 movedFiles:4 subtopicsCleared:1`（**真的搬进 `.trash`**） | `409 session-running`（`sessions.total=1/running=1`）、全库快照零改动、`.trash` 不存在 | ✅ |
| D2 clear-plan 清单含子树且与 `papersCount` 一致 | `papers:["T/P1"] count:3`（自相矛盾） | `papers:["T/P1","T/Sub/P2","T/Sub/Deep/P3"] count:3` | ✅ |
| D3 子专题论文生成中译文 ⇒ 清空 409 且点名 | 200（照删） | `409 translation-busy papers:["T/Sub/P2"]`、零改动 | ✅ |
| E1 坏 JSONL（首行/中间行/尾行截断）⇒ CLI 非 0 退出并指出坏行 | `exit 0`、stdout「已回滚 0 个文件」 | `exit 1`、stderr 含 `第 1/2/5 行` + `migrate-log-corrupt`；坏日志不动库 | ✅ |
| E1b `/migrate-rollback` 对坏行日志 | `200 {"ok":true,"restored":0}` | `409 {"code":"migrate-log-corrupt"}` + 行号；零改动 | ✅ |
| E1 完好日志不回归 | `exit 0`「已回滚 4 个文件」 | 同左，平铺源真的搬回 | ✅ |
| E2 **自造**「mkdir 后 / 复制中被杀」现场 ⇒ 复跑迁完、异目录不动、复跑幂等 | `copied:0 removed:0 partial:true halfProducts:undefined`（两篇永远 skipped） | `copied:4 removed:4`、`halfProducts:["T/HalfA","T/HalfB"]`、标记清除、别人 `Other/note.md` 原样、复跑 `copied:0` | ✅ |
| E2b 真实中断（`failAfterCopies:1`）→ 现场有标记 → 复跑收敛 | 中断后**无标记**（只能靠猜） | 标记存在 → 复跑 `copied:2 removed:2 partial:false`、产物完整 | ✅ |
| E3a `/migrate` 期间并发 GET 的响应性 | GET 只能在迁移结束后处理（`migEnd-gStart=6ms`、`remaining@GETdone=0`） | GET 在迁移进行中返回（`remaining@GETdone=77ms`） | ✅ |
| E3b 在飞译文时 `/migrate` | `200`（照跑） | `409 busy papers:["T/Sub/P2"]`、零改动 | ✅ |
| G3 paper 范围 `scopeBusy` 提示 | prompt 无「正在被修改」（死代码） | prompt 出现「正在被修改…本次只给了 N 篇」 | ✅ |
| G4 回滚日志路径前缀 | `<logDir>-evil` ⇒ `200 restored:1`（真的执行兄弟目录日志） | `400 escape-rejected`；目录内日志仍 `200 restored:1` | ✅ |

**无 blocker / medium。** 5 条低危观察见 §六。

## 二、红/绿命令与输出

```bash
cd /home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes
flock /tmp/dpr-pr8-build.lock -c 'npm run build'
node --test test/pr8-review-r3.test.mjs                    # 修复树：10 pass / 0 fail
R3_REPO=/home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-baseline \
  node --test test/pr8-review-r3.test.mjs                  # 基线：11 tests（+自检）/ 1 pass / 10 fail
```

基线关键输出（每条用例第一处失败，值均为实测）：

```
not ok 1  R3-D1  子专题论文有活跃会话时必须拦住整次清空：200 {"ok":true,"cleared":2,"movedFiles":4,
                  "trashDir":"/tmp/.../.trash/20261026T083940Z-...","subtopicsCleared":1,...}  200 !== 409
not ok 2  R3-D2  确认清单必须列出整棵子树的论文：["T/P1"]            # plan=200 papers=["T/P1"] count=3
not ok 3  R3-D3/E3b 在飞译文时 /migrate 必须 409：200 {"ok":true,"copied":0,...,"partial":false}  200 !== 409
not ok 4  R3-E1  首行坏：坏日志回滚必须非 0 退出（基线假成功 exit 0）：stdout=已回滚 0 个文件；删除空目录 0 个。
not ok 5  R3-E1b 坏行日志必须 409，不得 200 假成功：200 {"ok":true,"restored":0,"dirsRemoved":[]}
not ok 6  R3-E2  半成品目录必须被识别并续跑（复制 ≥4 个文件）：实际 0
                  # copied=0 removed=0 partial=true half=undefined
not ok 7  R3-E2b 阶段 1 中断现场必须留下半成品标记（复跑据此识别，而不是靠猜）   false !== true
not ok 8  R3-E3a GET 发出时迁移必须仍在进行（migEnd-gStart>30ms）：6ms
                  # GET=200 gStart=3486 gEnd=3492 migEnd=3492 remaining@GETdone=0 migratedFiles=900
not ok 9  R3-G3  paper 范围的 busy 提示必须真实触发（基线是死代码）：false !== true
not ok 10 R3-G4  日志目录外的文件必须 400：200 {"ok":true,"restored":1,"dirsRemoved":[]}
ok     11 R3-0   （基线模式自检）
# tests 11 / # pass 1 / # fail 10
```

修复后关键诊断值：

```
R3-D1 clear=409 {"code":"session-running","sessions":{"total":1,"running":1}}
R3-D2 papers=["T/P1","T/Sub/P2","T/Sub/Deep/P3"] count=3
R3-D3/E3b migrate=409 {"code":"busy","papers":["T/Sub/P2"]}；clear=409 {"code":"translation-busy","papers":["T/Sub/P2"]}
R3-E1  good: exit=0 stdout=已回滚 4 个文件；删除空目录 2 个。（三个坏日志用例：exit 1 + 第 1/2/5 行 + migrate-log-corrupt）
R3-E1b rollback=409 {"code":"migrate-log-corrupt"} + 第 2 行
R3-E2  copied=4 removed=4 half=["T/HalfA","T/HalfB"]；Other/note.md 原样；复跑 copied=0
R3-E2b aborted=MigrationAborted；marker=true；resume copied=2 removed=2 partial=false
R3-E3a GET=200 gStart=3777 gEnd=3783 migEnd=3861 remaining@GETdone=77ms migratedFiles=900
R3-G3  ask=200 promptHasHint=true；rename=200
R3-G4  evil=400 {"code":"escape-rejected"}；good=200 {"restored":1}
```

## 三、E2 的「中断现场」怎么由本评审自造（不跑实现方构造）

手工落盘两种「阶段 1 被打断」的形态（不调用实现方的注入点）：

1. `T/HalfA/` **空目录** —— 模拟 `mkdir` 之后、写标记/复制之前被 SIGKILL；
2. `T/HalfB/` 内含 `.migration-v1.inprogress` 标记 + 一份**半截** `HalfB.txt`（`B-PARTIAL-HALF`）
   —— 模拟复制第一个产物途中被杀。

同时放一个**别人的非空异目录** `T/Other/`（陌生文件 `note.md` + 同名平铺 `Other.pdf`）。
断言：两篇半成品被识别（`plan.halfProducts=["T/HalfA","T/HalfB"]`）并真的迁完（`copied:4 removed:4`）、
半截产物被源文件替换、标记清除；`Other/note.md` 一字未变、`Other.pdf` 原地不动、该篇仍进 `skippedPapers`；
复跑 `copied:0 removed:0` 且不再报 halfProducts。

另加一个**真实中断**（`failAfterCopies:1`，单篇库）：第一次运行抛 `MigrationAborted` 后，磁盘上必须能看到
半成品标记（复跑据此识别，而不是靠猜），复跑后 `partial:false`、两个产物完整。基线在「标记存在」处红。

## 四、E3a 的测法与阈值（可复跑）

- 夹具：300 篇平铺论文 × 3 个产物（`.pdf/.txt/.study.json`）= **900 个文件**（copy + 双 sha256 + 日志 fsync
  足以产生可观测耗时）。
- 测法：`t0` 发 `POST /paper-reader/api/library/migrate {confirm:'migrate-library'}`；`await sleep(15ms)` 后发
  `GET /paper-reader/api/library`；用 `performance.now()` 记录三个时刻：`gStart`（发 GET 前）、`gEnd`（GET 返回）、
  `migEnd`（迁移响应返回）。
- 阈值：① `migEnd - gStart > 30ms`（GET 发出时迁移仍在进行）；② `gEnd < migEnd - 10ms`（GET 在迁移结束前返回）。
- 实测：修复后 `remaining@GETdone = 77ms`、`migratedFiles=900`；基线 `migEnd - gStart = 6ms`、
  `remaining@GETdone = 0`（timer/GET 都要排在同步迁移之后）。

## 五、变异验证：5/5（注入红 / 还原绿 / diff clean）

```bash
cd /home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes
flock /tmp/dpr-pr8-build.lock node test/mutation-probe.mjs --only R3-
```

| 变异 | 回退的修复 | 抓住它的用例 |
|---|---|---|
| `R3-log-corrupt-swallowed` | `readMigrationLog` 坏行改回静默 `return`（基线口径） | R3-E1、R3-E1b |
| `R3-halfproduct-off` | 半成品识别恒返回 null | R3-E2 |
| `R3-rollback-prefix-nosep` | 回滚日志路径退回裸 `startsWith` | R3-G4 |
| `R3-migrate-busy-gate-off` | /migrate 的 busy 门失效 | R3-D3/E3b |
| `R3-clear-subtree-off` | 清空占用巡检退回只看根层 | R3-D1 |

```
OK   R3-log-corrupt-swallowed     注入=1 还原=0 diff=clean
OK   R3-halfproduct-off           注入=1 还原=0 diff=clean
OK   R3-rollback-prefix-nosep     注入=1 还原=0 diff=clean
OK   R3-migrate-busy-gate-off     注入=1 还原=0 diff=clean
OK   R3-clear-subtree-off         注入=1 还原=0 diff=clean
# 变异验证：5/5 通过   （PROBE_EXIT=0）
```

变异前后 `src/migrate.ts`、`src/host.ts`、`dist/{migrate,host}.js` sha256 全部一致；
`git status` 中没有本评审留下的 `src/`/`lib/` 改动。`R3-` 前缀下没有既有变异（不与他任务撞名）。

## 六、实现方用例是否空转 / 削弱 / 静默跳过？

- 静态扫描：`test/pr8-clear-migrate.test.mjs` 的 `.skip` 只有 **win32 平台限制**两处（假 babeldoc 解释器
  在本机/CI 都没跑过 win32，写明原因后 `t.skip`），不是永真跳过；没有 `assert.ok(true)`/无条件吞异常。
- 基线真的红：把实现方用例原样复制到基线树跑（跑完删除）→ `# tests 10 / pass 0 / fail 10`。
- 修复树绿：`node --test test/pr8-clear-migrate.test.mjs` → `10/10 pass`。
- 与本评审自造的 10 条探针互证（不同的现场构造/断言），未发现空转。

## 七、低危观察（不阻塞）

1. **E2 的「空目录」判据**（`ownHalfProductKind` 返回 `'empty'`）会把「与平铺论文同名、但**用户自己新建的空目录**」
   也当作上次半成品清掉。空目录没有数据，且只要目录里有任何陌生条目就仍按 `dir-other` 冲突不动——
   t3 已在证据 §5.1 如实披露；记录在案即可。
2. **E3b 只验证了「译文 busy」路径**：转录 busy（`activeTranscribes`）与译文共用同一处 `if (busy.length > 0)` 门
   （代码同路径），但本评审也没有可控的「慢转录」夹具，故未单独造慢转录时序用例——t3 证据已如实登记，
   属验证形态限制、不是实现缺口。
3. **`/migrate-rollback` 的 logPath 只做词法（relative）边界**：`logDir` 内的**符号链接**指向目录外时，
   词法检查会通过（`readFileSync` 跟随链接）。影响面有限：日志条目本身还要过 `safeRel`，且能在
   `migration-logs/` 里放文件需要本地写权限；与维护者点名的 `/a/bc` 前缀问题不是同一类。记录为加固建议
   （如需，可在 `realpath(logPath)` 后再做一次 relative 判定）。
4. **`/migrate` 的 `planMigration`（只读规划）仍是同步的**：首跑只 stat，复跑对已存在目标才做 sha256；
   大库复跑的规划阶段仍可能短暂占住事件循环。t3 已在证据 §5.3 披露；这是异步化的下一个自然边界。
5. **`scopeBusy` 对 `migrate` 在途一律返回 true**（整库正在被搬动）——提示语义正确，但会让迁移期间的每次
   范围内提问都带「正在被修改」提示；属产品口径，记录在案。

## 八、命令与完整性

```bash
cd /home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes
flock /tmp/dpr-pr8-build.lock -c 'npm run build'                       # exit 0
node --test test/pr8-review-r3.test.mjs                                # 10 pass / 0 fail
R3_REPO=/home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-baseline \
  node --test test/pr8-review-r3.test.mjs                              # 1 pass / 10 fail（预期红）
flock /tmp/dpr-pr8-build.lock node test/mutation-probe.mjs --only R3-  # 5/5，exit 0
node --test test/pr8-clear-migrate.test.mjs                            # 实现方用例 10/10（非空转核验）
node --test test/darkmode-subtopic-features.test.mjs                   # 53/53
```

- 所有破坏性/迁移实验都在 `mkdtemp` 临时库 + 临时 `DSH_HOME` 中完成（含迁移日志目录）；真实库未被触碰。
- 基线工作树临时复制的用例跑完即删，`git status` 干净。
- 未跑全量：并行任务在飞时全量可能有无因果瞬时红；本评审只对 D/E/G(host) 相关套件负责。
