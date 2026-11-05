# PR #8 评审 A / G / H + scope 码点截断 —— REV2 独立对抗评审（t5，评审对象 IMP2/t2）

- 评审对象：IMP2（t2）对 `docs/pr8-maintainer-review.md` **必修 A**、**应修 G**、**应修 H**，
  以及维护者「我这边已经修好的」第 1 条点名的 **scope.ts 码点截断** 的修复。
- 修复工作树：`.worktrees/pr8-fixes`（`feat/darkmode-subtopic`，HEAD `fdb45f2` + 未提交修复，其中 `src/scope.ts`
  同时含 t9/IMP4 的 coverage 改动——本评审只对 t2 负责的语义负责）
- 基线工作树：`.worktrees/pr8-baseline`（detached @ `fdb45f2`，已 build）
- 本评审只新增/改动三样，均在 t5 inScope：`test/pr8-review-r2.test.mjs`（新，16 例）、
  `test/mutation-probe.mjs`（+5 条 `R2-` 变异）、本文件。**未改 `src/`、`lib/client.js`、实现方 `test/pr8-*.test.mjs`；
  未 commit / push / rebase。**
- **独立性**：不 import 实现方 `test/pr8-session-client-scope.test.mjs`；夹具（TopicA/SubB/PaperC、Dup/Same、
  `r2needle-<i>-<ch>`、`MATH_A` 偏移、`dpr.variant.A/B/P-en`）与断言全部本评审重造。
  客户端不是 grep：`lib/client.js` 在 `node:vm` 里**真执行**（只 stub `window.__ModuleLoader__.load`），
  基线里内联的函数按「源码抠函数体 + 配对括号」真执行（A2、H1c）。
  同一份探针可跑基线：`R2_REPO=<baseline> node --test test/pr8-review-r2.test.mjs`。
- 所有破坏性实验 = `mkdtemp` 临时库 + 临时 `DSH_HOME`；构建全部持 `flock /tmp/dpr-pr8-build.lock`。

## 一、结论（verdict: pass，无 blocker/medium）

| 评审条目 | 独立证据（fdb45f2 基线红 → 修复后绿） | 判定 |
|---|---|---|
| A1 `paperFromSessionId` 按第一个 `/` 切 | 基线 `TopicA/SubB/PaperC` ⇒ `{topic:"TopicA",name:"SubB/PaperC"}` → 修复 `{topic:"TopicA/SubB",name:"PaperC"}`；扁平/非法/更深路径都断言 | ✅ |
| A2 `parseDprSession` 同病 + ⓘ 永远常亮 | 基线（抠源码真执行）同样切成 `TopicA`+`SubB/PaperC`，据此「同一篇」被判成 stale=true → 修复 topic/name 正确、stale=false；另一篇 true、无当前论文 false | ✅ |
| G1 命中片段不计预算 + omitted 句重复 | 基线 `totalChars=72621`（维护者实测 72574，同量级）、`body=39198`（同一批命中再拼一遍）、`block=72827`、omitted 句 2 次 → 修复 `totalChars=39513 ≤ 40000`、`body=0`、omitted 句恰 1 次、同一片段正文在块里恰 1 份 | ✅ |
| G2a 同名论文被静默吞掉 | 基线范围里只剩 `["Dup/Nested/Same"]`、`omitted=0`、无原因 → 修复两篇都进 `papers[]`（`omitted-duplicate`）、`omitted=2`、`omittedNotes` 2 条带「同名论文在多处」、块内点名 | ✅ |
| G2b `kind:'topic'` 指向不存在专题 | 基线模块层不抛错、路由 200 空范围 → 修复模块层 `code=not-found/status=404`、路由 404 `{code:'not-found'}`；存在的专题正对照 200 且非 degraded | ✅ |
| GC 码点截断（U+1D400 跨切点） | 基线 4 条截断场景各留 **1 个孤立代理项** → 修复全部 0 个；helper 语义/JSON 往返全部成立（见 §三） | ✅ |
| H1 祖先专题改名只按精确相等（cur/dpr.last/closed） | 基线 `dpr.last` 在 `A→X/A` 后仍是 `A/B`（真执行基线 migrateLsKeys）→ 修复 `X/A/B`、`AB` 不动；`dprReprefixTopic`/`dprRekeyTopicState` 语义全断言（A vs AB） | ✅ |
| H2 `openDelete` 只数直接论文 | 基线没有可执行子树计数 → 修复 `count(A)=3`（含 A/B、A/B/C）、`count(AB)=1`；「论文全在子专题」的专题 `clear-plan` 真的 200 且列出该篇 | ✅ |
| H3 `clearEndpoint` 重试是死代码 | 基线 `api()` 不挂字段（无可执行透传）→ 修复用**真实 409 响应体**：`dprApiError` 透传 `clearEndpoint`/`clearPlanEndpoint`、`dprClearRetryNeeded(err)=true`；负向 3 条；重试后的 `clear-plan` 真的可达 | ✅ |
| H4 改名后 iframe/请求路径 | 基线无前缀重写 → 修复 `cur.topic=X/A/B` 拼出的 `delete-plan` 200，旧 `A/B` 404 | ✅ |

**无 blocker / medium。** 6 条低危观察见 §六。

## 二、红/绿命令与输出

```bash
cd /home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes
flock /tmp/dpr-pr8-build.lock -c 'npm run build'
node --test test/pr8-review-r2.test.mjs                    # 修复树：16 tests / 16 pass / 0 fail

R2_REPO=/home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-baseline \
  node --test test/pr8-review-r2.test.mjs                  # 基线：17 tests（+自检）/ 1 pass / 16 fail
```

基线关键输出（每条用例的第一处失败）：

```
not ok 1  R2-A1  嵌套专题必须按最后一个 / 切（A/B/P）：实际 {"topic":"TopicA","name":"SubB/PaperC"}
not ok 2  R2-A2  parseDprSession 必须解出 topic=TopicA/SubB：实际 {"topic":"TopicA","name":"SubB/PaperC","n":2}
not ok 3  R2-G1  totalChars 必须 ≤ 40000（维护者实测修复前 72574）：实际 72621
                 # totalChars=72621 manifest=538 body=39198 hits=32885 omitted=3 block=72827
not ok 4  R2-G2a 两篇同名论文都必须出现在结果里：["Dup/Nested/Same"]    # omitted=0 notes=undefined
not ok 5  R2-G2b Missing expected exception: 不存在的专题必须抛 code=not-found / status=404
not ok 6  R2-GC1 截断后的正文不得含孤立代理项（切点 8000）            # block=8252 lone=1
not ok 7  R2-GC2 无命中开头片段的截断不得切开代理对                  # block=8281 lone=1
not ok 8  R2-GC3 命中片段 1200 截断不得切开代理对                    # hitChars=1220 lone=1
not ok 9  R2-GC4 pad=0: 清单截断不得切出孤立代理项                   # manifestChars=2012 lone=1
not ok 10 R2-GC5 dist/scope.js 必须导出 cutToCodePoint（等价回退原语）
not ok 11 R2-H1a lib/client.js 顶层必须有 dprReprefixTopic（基线缺失）
not ok 12 R2-H1b lib/client.js 顶层必须有 dprRekeyTopicState（基线缺失）
not ok 13 R2-H1c dpr.last.topic 必须跟前缀搬到 X/A/B（基线按精确相等 ⇒ 丢阅读位置）
                 # dpr.last={"topic":"A/B","name":"P","n":2} keys=["dpr.last","dpr.variant.X/A/B/P-en"]
not ok 14 R2-H2  lib/client.js 顶层必须有 dprTopicPaperCount（基线缺失）
not ok 15 R2-H3  lib/client.js 顶层必须有 dprApiError（基线 api() 没挂 clearEndpoint）
not ok 16 R2-H4  lib/client.js 顶层必须有 dprRekeyTopicState
ok     17 R2-0   （基线模式自检）
# tests 17 / # pass 1 / # fail 16
```

修复后关键诊断值：

```
R2-A1 deep={"topic":"TopicA/SubB","name":"PaperC"}
R2-A2 parse={"topic":"TopicA/SubB","name":"PaperC","n":2}
R2-G1 totalChars=39513 manifest=538 body=0 hits=38975 omitted=1 block=39670
R2-G2a papers=["Dup/Nested/Same","Dup/Same"] omitted=2 notes=<2 条含「同名论文在多处」>
R2-G2b route status=404 {"error":"专题不存在：Ghost","code":"not-found"}
R2-GC1 block=8251 lone=0 hasMath=false     R2-GC2 block=8280 lone=0
R2-GC3 hitChars=1219 block=1425 lone=0     R2-GC4 pad=0/1/2 manifestChars=2011 lone=0
R2-H1a A/B→X/A/B  AB→null                  R2-H1b cur/last/closed 全部 X/A 前缀，AB/Z 不动
R2-H1c dpr.last={"topic":"X/A/B",...} keys=["dpr.last","dpr.variant.X/A/B/P-en"]
R2-H2 count(A)=3 count(A/B)=2 count(AB)=1；clear-plan 200 且列出 OnlySub/Branch
R2-H3 delete-topic=409 code=topic-not-empty clearEndpoint=/api/library/topic/clear；retry=true
R2-H4 new-path status=200；旧路径 A/B => 404
```

## 三、码点截断（U+1D400 代理对**恰好**跨切点）

自造方式：把 `𝐀`（U+1D400，UTF-16 两个码元）放在 `cut-1` 位置，使朴素 `slice(0, cut)` 正好切开它
（不是抄实现方用例的断言/偏移）。

| 用例 | 切点 | 基线 | 修复后 |
|---|---|---|---|
| R2-GC1 单篇范围正文 | 8000（`'W'×7999 + 𝐀 + …`） | `lone=1`、块尾留高代理 | `lone=0`、整字丢弃、前 7999 字保留 |
| R2-GC2 专题无命中开头片段 | 8000（`'V'×7999 + 𝐀 + …`） | `lone=1` | `lone=0` |
| R2-GC3 命中片段 1200 | 1200（`'r2hit '+ 'T'×1193 + 𝐀 + …`） | `lone=1` | `lone=0`、块内恰 1199 字（整字边界） |
| R2-GC4 清单 `MAX_MANIFEST` | 2000（名字由 `𝐀`×45 构成；pad 0/1/2 三个偏移） | `pad=0 lone=1` | 三个偏移全部 `lone=0` |
| R2-GC5 `cutToCodePoint` 原语 | 1..5 逐点 | 无此导出 | `n=3`（代理对中间）⇒ `'ab'`；`n=4` ⇒ `'ab𝐀'`；0/超长边界正确 |

每条都额外断言：`JSON.parse(JSON.stringify(block))` 深等于原串（JSON 往返不自炸）、
`block` 中该数学字符**整字出现或整字缺席**（不允许半个代理对）。

## 四、变异验证：6/6（注入红 / 还原绿 / diff clean）

```bash
cd /home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes
flock /tmp/dpr-pr8-build.lock node test/mutation-probe.mjs --only R2-
```

```
OK   R2-tools-parse-first-slash       注入=1 还原=0 diff=clean   (A1：会话 id 退回第一个 /)
OK   R2-client-parse-first-slash      注入=1 还原=0 diff=clean   (A2：客户端 parse 同退)
OK   R2-hits-not-counted-in-budget    注入=1 还原=0 diff=clean   (G1：命中不计预算)
OK   R2-cut-codepoint-off             注入=1 还原=0 diff=clean   (GC：截断退回按码元切)
OK   R2-prefix-without-separator      注入=1 还原=0 diff=clean   (H1a：前缀判定丢分隔符，误伤 AB)
OK   R2-hidden-paper-skipped          注入=1 还原=0 diff=clean   （**既有**变异，migrate 域，非本评审对象）
# 变异验证：6/6 通过   （PROBE_EXIT=0）
```

- 5 条新增变异的 `testFile` 全部指向 `test/pr8-review-r2.test.mjs`；`R2-cut-codepoint-off` 用
  `pattern: 'R2-GC'` 一次覆盖 GC1-GC5。
- 前缀 `R2-` 下另有 1 条**既有** migrate 域变异（`R2-hidden-paper-skipped`，更早轮次的「裁定 2」，
  属 IMP3/t6 领域），锚点有效、本次实跑通过；本评审未改它。
- 变异前后 `src/tools.ts` / `src/scope.ts` / `lib/client.js` 与 `dist/{tools,scope}.js` sha256 全部一致；
  `git status` 里没有本评审留下的 `src/`、`lib/` 改动。

## 五、实现方用例是否空转 / 削弱断言 / 静默跳过？

- **静态扫描**：`test/pr8-session-client-scope.test.mjs` 无 `.skip` / `.todo` / `assert.ok(true)` / 无条件吞异常。
- **基线真的红**：把实现方用例原样复制到基线树跑（跑完删除）：`# tests 13 / pass 0 / fail 13`。
- **修复树绿**：`node --test test/pr8-session-client-scope.test.mjs` → `13/13 pass`。
- 与本评审自造的 16 条探针互证（不同的夹具/断言），未发现「只测新导出」的空转：
  H1a/H2/H3 这类「纯函数」条目另由 §四 的变异回退到缺陷态验证判别力。

## 六、低危观察（不阻塞，供集成/后续任务）

1. **H 组基线的红多为「纯函数不存在」而非行为红**（H1a/H1b/H2/H3/H4）：这几条缺陷在基线里内联在
   React 闭包 / `api()` 内，没有可直接执行的纯函数。本评审的补偿是：H1c 用**基线源码抠函数真执行**得到
   行为红（`dpr.last` 停在 `A/B`）+ §四变异把修复逐个改回缺陷态证明用例有判别力 + H2/H3 额外断言服务端
   路径（clear-plan 200、真实 409 体）。这是证据形态的限制，不是实现缺陷；建议集成说明里如实标注。
2. **同名论文在专题范围里两篇都不展开**（`omitted-duplicate`）：t2 已在证据 §四.2 如实披露——精确
   `(topic,name)` 其实已知，`paperRefFor` 可纳入，但会与 `library.ts:resolvePaper` 的「按名唯一」契约冲突
   （该文件不在 t2 inScope）。维持者要求的是「如实标注」，已满足；若将来要纳入，建议单开 library.ts 契约任务。
3. **legacy 长名专题不能作为提问范围**：`resolveScopePapers` 用 `validateTopicPath(scope.topic, false)`
   （`src/scope.ts:201` 之前），110 字/221 字 legacy 专题会 400 —— 与 t4 里「上传到 legacy 长名专题仍 400」
   同族（基线同样 400，非本轮回归；改名路径可用）。如希望 legacy 专题保持完全可用，可改走边界类长度语义。
4. **`readText` 的码点截断点在本分支不可观测**：`readText` 只有一处调用，limit 恒为
   `Number.MAX_SAFE_INTEGER`（`src/scope.ts:130`）⇒ 该处永远不会真的截断。真正可观测的切点是
   单篇正文 / 无命中开头片段 / 命中 1200 / 清单 2000（本评审各有用例）。维护者说的「5 处」在本分支实际
   收敛为 4 个可达切点 + `readText` 的死 limit；属证据精度问题，不是行为缺口。
5. **`cutToCodePoint` 是本地等价回退实现**（`src/scope.ts:42`），main 的 `search.ts` 已导出同名原语（维护者
   「已修好」第 1 条）。合入 main 时会形成重复定义/易漂移——建议集成任务按维护者要求对账为同一导出。
6. **`dprRekeyTopicState` 的折叠键碰撞**：若 `closed` 里同时存在旧前缀键与新前缀键（例如历史残留的
   `X/A/B` 与本次要搬的 `A/B`），映射后后者覆盖前者；只影响折叠态显示，无数据风险。极端场景，记录在案。

## 七、回归与并发（如实记录）

- 与本任务并行的 t11（engineer，`src/host.ts` / `src/library-manage.ts`）不碰本评审对象的
  `src/tools.ts` / `src/scope.ts` / `lib/client.js`；构建全部 `flock`。本次跑动期间未遇到与 t11 相关的瞬时红。
- 独立复跑的相邻套件：
  - `test/pr8-session-client-scope.test.mjs`（实现方）：修复树 **13/13**；基线 **0/13**（见 §五）
  - `test/darkmode-subtopic-features.test.mjs`：**53/53**
  - `test/pr8-coverage-honesty.test.mjs`（t9，同文件 `src/scope.ts`）：**9/9**
- 未跑全量：并行任务在飞时全量可能出现与本评审对象无因果的瞬时红（t9 证据里已记录过一次）；本评审只对
  A/G/H + 码点相关套件负责。

## 八、命令清单

```bash
cd /home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes
flock /tmp/dpr-pr8-build.lock -c 'npm run build'                      # exit 0
node --test test/pr8-review-r2.test.mjs                               # 16 pass / 0 fail
R2_REPO=/home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-baseline \
  node --test test/pr8-review-r2.test.mjs                             # 1 pass / 16 fail（预期红）
flock /tmp/dpr-pr8-build.lock node test/mutation-probe.mjs --only R2- # 6/6，exit 0
node --test test/pr8-session-client-scope.test.mjs                    # 13/13
node --test test/darkmode-subtopic-features.test.mjs                  # 53/53
node --test test/pr8-coverage-honesty.test.mjs                        # 9/9
```
