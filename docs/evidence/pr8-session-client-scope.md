# PR #8 评审修复证据 —— 任务 t2 / IMP2（A + G + H + scope 码点截断）

- 工作树：`/home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes`（分支 `feat/darkmode-subtopic`，HEAD `fdb45f2`）
- 修前基线：`/home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-baseline`（detached @ `fdb45f2`，已 build）
- 评审原文：`docs/pr8-maintainer-review.md`（@GGboya，CHANGES_REQUESTED）
- 新用例：`test/pr8-session-client-scope.test.mjs`（13 例）。**基线 13/13 红 → 修复后 13/13 绿**；另做 10 个变异，10/10 被对应用例抓住。
- 环境：Node 22 / Linux；所有破坏性实验用 `mkdtemp` 临时库 + 临时 `DSH_HOME`，未触碰真实文献库与 `~/.dsh`。
- 未 push、未 commit、未 rebase；只改了 `src/tools.ts`、`src/scope.ts`、`lib/client.js`、新用例文件与本证据文件。

## 一、结论速览

| # | 维护者断言（评审原文） | 独立复现（基线） | 修复后 | 落点 |
|---|---|---|---|---|
| A1 | `paperFromSessionId` 按第一个 `/` 切 ⇒ `A/B/P` 解成 `A` + `B/P` | ✅ 基线实测 `{"topic":"A","name":"B/P"}` | ✅ `A/B` + `P`；扁平 `T/P` 不回归；非法仍 `null` | `src/tools.ts:78` |
| A2 | `parseDprSession` 同病 ⇒ 子专题论文 ⓘ「对话还停在另一篇」永远常亮 | ✅ 函数只存在于 factory 内、无顶层纯函数；`indexOf('/')` | ✅ 顶层纯函数 + `lastIndexOf('/')`；`dprSessionStale` 对同篇返回 false | `lib/client.js:82`、`:91`、`:98`、`:762` |
| G1 | 命中片段不计预算（`pushWithLabel` 恒 `hits=null` 死代码），12 篇×3 命中 `totalChars=72574`；omitted 句两处重复 | ✅ 实测 **72621**（同一场景同一量级，差 47 字来自我造的清单文案长度） | ✅ **39525**；`block=39682 ≤ 40000+800`；omitted 句恰 1 次；命中只在第 ③ 段出现一次 | `src/scope.ts:281`、`:347`、`:353`、`:366`、`:371`、`:373` |
| G2a | 多篇同名论文被 `catch {}` 静默吞掉 | ✅ 基线范围里只剩 `["A/B/P"]`，omitted=0、无任何提示 | ✅ 两篇都进 `papers[]`（`coverage='omitted-duplicate'`）、`omitted=2`、`omittedNotes` 逐篇带原因、提示里点名 | `src/scope.ts:183`（`resolveScopePapers`）、`:208-217`、`:260-266`、`:373` |
| G2b | `kind:'topic'` 不校验专题存在 ⇒ 空范围 + 200 假成功 | ✅ 基线 `assert.throws` 落空；路由返回 200 | ✅ 模块层 `ManageError('not-found',404)`；路由层 404 + `code='not-found'`；存在的专题仍 200（正对照） | `src/scope.ts:195`（`resolveTopicDir`；`host.ts` 的 `isManageError → libFail` 通道给出 404，**未改 host.ts**） |
| GC | scope.ts 5 处码元截断切开代理对（U+1D400） | ✅ 4 条截断用例全红（单篇正文/无命中开头片段/1200 命中片段各留下孤立代理项） | ✅ 全部走 `cutToCodePoint`；U+1D400 跨切点前后均无孤立代理项，JSON 往返不炸 | `src/scope.ts:42`；调用点 `:96`（readText）、`:270`（清单）、`:299`、`:329`、`:349`（命中 1200） |
| H1 | 祖先专题改名只按精确相等更新 `cur`/`dpr.last`/closed | ✅ 顶层无前缀函数；`dpr.last.topic==='A/B'` 在 `A→X/A` 后不变 | ✅ `cur.topic='X/A/B'`、`dpr.last.topic='X/A/B'`、折叠键 `A/B→X/A/B` 且 `AB` 不动；`dpr:paper` 派发新身份给 iframe | `lib/client.js:107`、`:120`、`:477`、`:1171`、`:1180` |
| H2 | `openDelete` 只数直接论文 ⇒ 论文全在子专题的专题没有 UI 路径到 `/topic/clear` | ✅ 顶层无子树计数函数 | ✅ `A` 子树 2 篇（`A/B`、`A/B/C`），`AB` 不算进 `A`；`openDelete` 走 clear-plan 中间态 | `lib/client.js:142`、`:1281` |
| H3 | `doDeleteTopic` 的 `clearEndpoint` 重试是死代码（`api()` 没挂字段） | ✅ 顶层无错误透传函数 | ✅ 选「透传到 Error」：`dprApiError` 挂 `clearEndpoint`/`clearPlanEndpoint`，`dprClearRetryNeeded` 判据可达；用**真实 409 响应体**端到端验证 | `lib/client.js:148`、`:162`、`:442`、`:1379` |
| G6 | N+1 递归子树扫描 | ✅ 基线每篇 `resolvePaper` 内部再 `listPapers(topic)` 一次（12 篇 ⇒ 13 次递归扫描） | ✅ 单次 `listPapers` + `paperRefFor` 精确构造（1 次扫描）；细节与限制见 §四.1 | `src/scope.ts:196-217` |

## 二、复现与红→绿命令

```bash
# ① 修复前（基线）：新用例必须红
cd /home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-baseline
cp ../pr8-fixes/test/pr8-session-client-scope.test.mjs test/
node --test test/pr8-session-client-scope.test.mjs      # → 13 fail / 0 pass（关键输出见 §三）
rm test/pr8-session-client-scope.test.mjs

# ② 修复后：build + 新用例必须绿
cd /home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes
flock /tmp/dpr-pr8-build.lock -c 'npm run build'
node --test test/pr8-session-client-scope.test.mjs      # → 13 pass / 0 fail
node --test test/darkmode-subtopic-features.test.mjs    # → 53 pass / 0 fail（无回归）
node --test "test/*.test.mjs"                           # → 561 tests / 534 pass / 0 fail / 27 skip
```

## 三、修前（基线 fdb45f2）红证据（原文摘录）

```
not ok 1 - A1 … paperFromSessionId：嵌套专题按最后一个 / 切…
    深专题必须解成 topic=A/B / name=P：{"topic":"A","name":"B/P"}

not ok 2 - A2 … parseDprSession 同语义 + ⓘ 不再永远常亮
    lib/client.js 顶层必须有纯函数 parseDprSession（评审修复的落点；缺失说明测试是空转）

not ok 3 - G1 … 12 篇×3 命中… totalChars ≤ 40000…
    totalChars 必须 ≤ 40000（评审实测修复前 72574）：72621
# totalChars=72621 manifest=550 body=39186 hits=32885 omitted=3 block=72827

not ok 4 - G2a … 多篇同名论文不再静默消失…
    两篇同名论文都必须出现在结果里（或被显式点名），绝不能静默少一篇：["A/B/P"]

not ok 5 - G2b … kind:"topic" 指向不存在的专题…
    Missing expected exception: 不存在的专题必须抛 code=not-found / status=404

not ok 6 - GC1 … cutToCodePoint…
    dist/scope.js 必须导出 cutToCodePoint           （基线：actual 'undefined'）
not ok 7 - GC2 … 单篇范围正文截断…
    截断后的正文不得含孤立代理项（切点 8000）
not ok 8 - GC3 … 专题范围「无命中 ⇒ 开头片段」截断…
    开头片段截断不得含孤立代理项
not ok 9 - GC4 … 命中片段截断（slice(0,1200)）…
    命中片段 1200 截断不得切出孤立代理项（block.hitChars=1213）

not ok 10 - H1a … dprReprefixTopic 前缀感知…
    lib/client.js 顶层必须有纯函数 dprReprefixTopic（评审修复的落点；缺失说明测试是空转）
not ok 11 - H1b … 专题改名后状态整体换前缀…
    lib/client.js 顶层必须有纯函数 dprRekeyTopicState（…）
not ok 12 - H2 … openDelete 按子树计数…
    lib/client.js 顶层必须有纯函数 dprTopicPaperCount（…）
not ok 13 - H3 … clearEndpoint 重试真实可达…
    lib/client.js 顶层必须有纯函数 dprApiError（…）
# tests 13 / pass 0 / fail 13
```

> 说明：基线对 A2/H1a/H1b/H2/H3 的红是「纯函数还不存在」——这几条缺陷在基线的实现形态上就是**没有可测的纯函数**（逻辑内联在 React factory / api() 里）。为了让基线的红也具备行为判别力，修复后我把语义上移为顶层纯函数，并用**变异验证**（§五）证明这些用例不是「只测新导出」，而是能抓住真缺陷。

修复后同一条 G1 场景（`node --test test/pr8-session-client-scope.test.mjs`）：

```
# totalChars=39525 manifest=550 body=0 hits=38975 omitted=1 block=39682
# tests 13 / pass 13 / fail 0
```

## 四、关键实现决策（含偏离与未做项，如实记录）

1. **G6（N+1）——做了，且不是「假装做过」**：`resolveScopePapers` 现在只调 **1 次** `listPapers(dataDir, topic)`，再用 `paperRefFor(dataDir, p.topic, p.name)` 按列表给出的**精确** `(topic,name)` 构造引用。基线是 `listPapers` 1 次 + 每篇 `resolvePaper`（其内部又 `listPapers(dataDir, p.topic)` 一次）⇒ 12 篇论文的子树场景从 **13 次递归扫描** 降到 1 次；同时消灭了「同名论文被 `resolvePaper` 判成命中多篇」的静默丢。**限制**：`paperRefFor` 不做存在性校验（文件竞态删除时该篇会以 `coverage='no-body'` 如实出现，而不是消失）；未做跨请求缓存（那需要给纯函数模块引入状态，收益/风险不划算）。
2. **G2 多篇同名论文的策略**：题目要求「进 omitted 并带原因」，因此同名（跨不同深度）的两篇都**不进正文**、带路径与原因进 `omitted-duplicate` + `omittedNotes`，并在提示里点名。**代价（如实说明）**：这两篇在专题范围里都不展开（基线是「随机留下一部分、丢掉另一部分」）。若将来要「两篇都纳入」，正确做法是修 `library.ts:resolvePaper`（按精确 topic 解析，不按名字扫子树）——那在library.ts（本任务 out of scope），且会改变既有 `resolvePaper` 契约，故本轮不做。
3. **G2b 的 404 通道**：`scope.ts` 复用 `library-manage.ts` 已有的 `ManageError`/`resolveTopicDir`。`host.ts` 的 `/api/ask` catch 里已有 `isManageError(err) → libFail(res, err)`（未改 host.ts），所以抛 `ManageError('not-found',404)` 直接落到 **404 + `{code:'not-found'}`**，不会走「装配失败但 200」的 fail-soft 分支。正对照用例确认存在的专题仍 200。
4. **H3 二选一：选择「透传到 Error」而不是删死代码**。理由：服务端**已经**在 409 `topic-not-empty` 里给了 `clearEndpoint`/`clearPlanEndpoint`（`host.ts:778-783`），且 `openDelete('topic', …)` 的「批量清空」中间态本来就实现了；透传 3 行即可把 UI 的竞态恢复路径接通（确认框弹出后专题又有了文献 → 直接进清空确认，用户不用从头再来）。删死代码会让这条既有的恢复路径永久消失，收益更低。证据：`H3` 用例从**真实 409 响应体**构造错误并断言判据为 true。
5. **GC「5 处」与实际落点**：评审列的 5 处里，`pushWithLabel` 内的 `h.chunk.text.slice(0,1200)` 是**恒不执行的死分支**（评审同时指出的 `hits=null` 死代码）——去重后命中片段只剩 1 个切片点；正文 limit 的调用点从 3 个收敛为 2 个（专题「命中拼正文」的重复副本被删）。最终 `scope.ts` 里**所有**截断点（含评审没点名的 `manifest.slice(0, MAX_MANIFEST)`）共 6 处统一走 `cutToCodePoint`；`grep -n "slice(0," src/scope.ts` 只剩 helper 自身与两处 ASCII 路径后缀裁剪。
6. **测试手法**：客户端部分**真执行** `lib/client.js`（只 stub `window.__ModuleLoader__.load`，与 `test/library-clear-and-busy.test.mjs` 同法），测的是生产代码里的顶层纯函数；`migrateLsKeys` 用「抠函数体 + 配对括号」独立执行（沿用 `test/selection-translate.test.mjs` 的手法）。跨 realm 对象比较用 `JSON.parse(JSON.stringify())` / 展开归一，避免 vm 原型差异误报。

## 五、变异验证（10/10 被抓住）

在隔离沙箱（`.probe/mut/`，gitignored，不动主工作树）里把每个修复**逐个改回缺陷态**，跑对应用例，确认变红后还原：

| 变异 | 改回什么 | 抓住它的用例 |
|---|---|---|
| M01 | `parseDprSession` 用 `indexOf('/')` | A2 |
| M02 | 前缀判定丢掉分隔符（`startsWith(oldTopic)`） | H1a（`AB` 被误伤） |
| M03 | `dpr.last` 退回精确相等 | H1b |
| M04 | 子树计数退回 `p.topic === name` | H2 |
| M05 | `dprApiError` 不再透传 `clearEndpoint` | H3 |
| M06 | `cutToCodePoint` 退回 `slice(0, n)` | GC1/GC2/GC3/GC4 四条全红 |
| M07 | 命中片段不计入 `used` | G1（预算/omitted 断言红） |
| M08 | omitted 句又在 tail 输出一遍 | G1（「只出现一次」红） |
| M09 | 关掉同名论文检查（`if (false)`） | G2a |
| M10 | 去掉 `resolveTopicDir` 存在性校验 | G2b |

汇总输出：`10/10 个变异都被对应用例抓住`。

## 六、回归与全量

- `node --test test/darkmode-subtopic-features.test.mjs` → **53 pass / 0 fail**（既有 E1-E4 范围用例不受影响；`scopePath`、`omitted` 句、`MAX_*` 语义都保持）。
- `node --test "test/*.test.mjs"` → **561 tests / 534 pass / 0 fail / 27 skip**（27 skip 为基线既有平台/凭据相关跳过）。
  - ⚠️ 中途有一次全量出现 **1 fail**：`VC1[C1/C2] 回归…` 报「本轮不应改动：`.tmp/`」。`.tmp/` 是**同树另一任务的临时目录**（15:55 创建，内含 `all.log`/`probe.mjs` 等，不是本任务产物；本任务所有临时文件都在 `mkdtemp`/`.probe/`）。该目录被其所有者清掉后，重跑全量 **0 fail**。证据留档按重跑结果。
- `flock /tmp/dpr-pr8-build.lock -c 'npm run build'` → 通过（tsc 无输出/退出 0）。

## 七、改动文件（工作树相对路径）

- `src/tools.ts`：`paperFromSessionId` 改 `lastIndexOf('/')`。
- `src/scope.ts`：新增 `cutToCodePoint`；`resolveScopePapers`（专题存在性校验 / 单次扫描 + `paperRefFor` / 同名论文显式 skipped）；`buildScopeContext` 预算口径重写（命中计费、去重、omitted 句只一次、`omittedNotes`）；6 处截断统一码点安全。
- `lib/client.js`：顶层纯函数 `parseDprSession`（lastIndexOf）、`dprSessionStale`、`dprReprefixTopic`、`dprRekeyTopicState`、`dprTopicPaperCount`、`dprApiError`、`dprClearRetryNeeded`；`migrateLsKeys` 的 `dpr.last` 前缀感知；`doRename` 用 rekey（cur + closed + 派发 `dpr:paper`）；`openDelete` 子树计数；`api()` 经 `dprApiError` 抛错；`doDeleteTopic` 用可达判据重试。
- `test/pr8-session-client-scope.test.mjs`（新增）：13 例（A1/A2、G1、G2a/G2b、GC1-GC4、H1a/H1b、H2、H3）。
- `docs/evidence/pr8-session-client-scope.md`（本文件）。

## 八、未做 / 留给后续

- 未按评审 G「次级」三条处理（`host.ts:432` `scopeBusy` 分隔符 `\u0000` vs `/`、`host.ts:985` 回滚日志前缀、短正文 `coverage` 误报 `truncated`）：它们在 `host.ts` / 不同归属，不在本任务 inScope。其中「短正文全覆盖时误报 truncated」在 `scope.ts:357` 附近仍有同一形态（`coverage` 由「命中是否截断」决定，不是「正文是否全覆盖」的语义），本轮**未改语义**以免超出评审 G 的预算/诚实性范围；如需修，建议单开一条。
- 未 rebase / push / commit（红线）。
