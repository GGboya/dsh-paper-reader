# PR #8 评审 G 次级 —— REV4 独立对抗评审（t10，评审对象 t9/IMP4）

- 工作树（评审对象）：`/home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes`
  （`feat/darkmode-subtopic`，HEAD `fdb45f2` + 未提交修复；评审对象只有 `src/scope.ts` 的 coverage/台账改动）
- 基线对照：`/home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-baseline`（detached @ `fdb45f2`，已 build）
- 权威清单：`docs/pr8-maintainer-review.md`「G. 范围提问的预算与诚实性 · 次级：短正文全覆盖时 `coverage` 误报 `truncated`」
- 本评审**只新增**三样东西，未改 `src/` / `lib/` / 他人用例：
  `test/pr8-review-r4.test.mjs`（自造对抗探针，8 例）、`test/mutation-probe.mjs` 的 6 条 `R4-` 变异、本文件。
  未 commit / push / rebase；打包库全用 `mkdtemp`，`DSH_HOME` 指向临时目录。
- **独立性**：探针不 import t9 的 `test/pr8-coverage-honesty.test.mjs`，夹具、问题词、断言口径全部重造
  （正文长度 218 / 10016 / 315 / 1500 / 10000，与 t9 的 211 / 10000 / 310 / 3000 不同）。
  同一份探针用 `R4_REPO=<baseline>` 直接跑在基线上 ⇒ 基线误报是**本探针自己跑出来的**，不是引用实现方自述。

## 一、结论（verdict: pass）

| 验收点 | 判定 | 独立证据 |
|---|---|---|
| 基线 `fdb45f2` 确有「短正文整篇纳入却标 truncated」 | **复现**（`coverage=truncated`、`truncated=1`、`chars=242`，而块内是整篇 218 字） | §二 基线跑 8/9 红 |
| 修复后 short-body 完整纳入 ⇒ `full`、`truncated` 不增、`chars`=正文长度 | **成立** | §三 R4-1 |
| 预算/单篇上限造成的真截断 ⇒ `truncated`、`chars` 与块内逐字一致、被切尾部不进块 | **成立** | §三 R4-2/R4-4/R4-6 |
| 无命中给开头片段 ⇒ `truncated` + 显式标注「开头片段/无关键词命中」 | **成立** | §三 R4-2 |
| 台账逐条对账（`full`/`truncated`/`omitted` ↔ `papers[].coverage`、每篇 `chars` ↔ 块内实际内容） | **成立**（8 场景全对账） | §三 + §四 |
| 清单截断不再污染论文 `truncated` 台账 | **成立**（`manifestTruncated=true`、`truncated=0`） | §三 R4-7 |
| t9 用例非空转 | **成立**（回退缺陷后 t9 的 S1 也红） | §五 `R4-audit-impl-suite-not-vacuous` |
| 变异验证 ≥1 条 `R4-`（注入红/还原绿/diff clean） | **6/6 通过** | §五 |

**无 blocker / medium finding。** 另有 5 条低危观察（§六），均不影响「模型上下文与用户可见文案如实」，
不需要在合入前返工，但建议随最终提交一起在字段注释/证据里说清。

## 二、基线对照：同一探针跑 `fdb45f2`（红，且红在行为断言上）

命令（工作树仍在 pr8-fixes，dist 指向基线）：

```bash
cd .worktrees/pr8-fixes
R4_REPO=/home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-baseline \
  node --test test/pr8-review-r4.test.mjs
# tests 9 / pass 1（只有 R4-0 基线模式自检绿）/ fail 8
```

每条用例的**第一处**失败（= 最先暴露的行为差异）：

| 用例 | 基线失败信息 | 基线诊断值 |
|---|---|---|
| R4-1 短正文无命中 | `整篇正文都给完了，必须标 full（维护者指的误报）：实际 truncated` | `coverage=truncated chars=242 truncated=1 body=218` |
| R4-2 真截断 + chars | `chars 必须是实际纳入的 8000 字：实际 8024` | `coverage=truncated chars=8024` |
| R4-3 命中片段完整纳入 | `chars 必须是片段正文长度 315（不得含页码标签）：实际 323` | `coverage=full chars=323 chunk0=315` |
| R4-4 命中片段 1200 截断 | `片段被 1200 上限切过，必须标 truncated：实际 full` | `coverage=full chars=1508 chunk0=1500`（块里只放了 1200） |
| R4-5 混合台账 | `full 应为 9：实际 undefined` | `full=undefined truncated=10 omitted=0`（8 篇短正文被误标 truncated） |
| R4-6 预算耗尽 | `omitted 提示句必须只出现一次：实际 2 次` | `total=39755`（tail 与 block 各输出一遍） |
| R4-7 清单截断 | `清单超 2000 字必须标 manifestTruncated：实际 undefined` | `manifestChars=2012 truncated=1`（清单截断污染论文台账） |
| R4-8 同名论文 | `两处同名论文都必须出现在明细里` | `papers=1 omitted=0 notes=undefined`（另一篇静默消失） |

维护者断言的形态**独立复现**：基线 `src/scope.ts:249-255` 的无命中分支无条件
`pushWithLabel(..., 'truncated', ...) + truncated++`，于是「整篇正文都进了 block」却报 `truncated`，
且 `chars = text.length` 把说明句（24 字）也算进去（218 → 242）。**与实现方描述一致，但这是本探针自己跑出来的。**

此外本探针在基线上还抓到一个**反向误报**（实现方证据未提）：基线命中分支把 1500 字 chunk 按 1200 进块，
`chars` 却是 1508（含页码标签）、`coverage='full'`——**块里其实只有 1200 字却标 full**。t9 的修复顺带把它
改成 `truncated/chars=1200`（R4-4），这是对的方向。

## 三、修复后：8/8 绿（含诊断值）

```bash
cd .worktrees/pr8-fixes && node --test test/pr8-review-r4.test.mjs
# tests 8 / pass 8 / fail 0
```

| 用例 | 场景（全部自造） | 修复后诊断 |
|---|---|---|
| R4-1 | topic 范围、检索无命中、正文 218 字（整篇纳入） | `coverage=full chars=218 truncated=0`，块内 `/以下是全文/`、无「开头片段」，说明句只 1 次 |
| R4-2 | 同分支真截断：正文 10016 字（`A*8000`+尾部标记+B） | `coverage=truncated chars=8000 truncated=1`；块内**无**尾部标记；`/以下是开头片段/`+`/无关键词命中/` |
| R4-3 | 命中片段完整纳入（chunk 315 字） | `coverage=full chars=315`（不含页码标签），块内 315 字 |
| R4-4 | 命中片段被 1200 上限切过（chunk 1500） | `coverage=truncated chars=1200 truncated=1`，块内正好 1200 字（多 1 字都不行） |
| R4-5 | 12 篇混合（8 短无命中 + 2 长无命中 + 1 无正文 + 1 命中整篇） | `full=9 truncated=2 omitted=0 total=18055`；两篇长正文的尾部标记都不在块内 |
| R4-6 | 8 篇 × 10000 字（预算耗尽） | `full=0 truncated=5 omitted=3 total=39355`；逐篇 `chars`=块内字数；`omitted` 提示句**只 1 次** |
| R4-7 | 14 篇长名无正文（清单必超 2000）+ 2 篇超 `MAX_PAPERS_IN_SCOPE` | `manifestChars=2012 manifestTruncated=true truncated=0 omitted=2 papers=14`，块内 `/清单已截断至上限/` |
| R4-8 | 同名论文在 `A/P` 与 `A/B/P` | `papers=2 omitted=2`，`omittedNotes` 2 条带原因，块内点名 `同名论文在多处` |

## 四、台账自洽性怎么独立复核的（不是只跑实现方用例）

探针自带两个独立对账器，**8 个用例全部调用**：

1. `assertLedger(ctx, label, N)`：
   - `papers.length === N`（范围内每一篇都在明细里，含未展开的——不允许静默丢）；
   - `ctx.full === #{coverage='full'}`、`ctx.truncated === #{coverage='truncated'}`、
     `ctx.omitted === #{coverage 以 'omitted-' 开头}`；
   - 四类终态（full/truncated/no-body/omitted-*）**覆盖每一篇**（`sum === papers.length`）；
   - `full|truncated ⇒ chars>0 且 ≤ MAX_PER_DOC`；其余 `chars===0`；
   - `totalChars === manifestChars + bodyChars + hitChars ≤ 40000`，`block.length ≤ 40000+800`。
2. `assertPerPaperBlock(ctx, label)`：从 `block` 里按段头
   （`\n=== <path>（正文来源 …） ===\n` / `\n--- <path>[ 第 N 页] ---\n`）**把该篇实际给出去的字取回来**
   （正文段剥掉「无关键词命中/以下是全文」说明句——那不是内容），要求
   `块内该篇内容长度 === papers[].chars`；标 `no-body`/`omitted-*` 的篇在块里**不得**出现段落。
   —— 5 个单篇场景里，这个长度还对得上夹具里**已知**的正文前缀，因此不是「实现说多少就信多少」。

因此「统计与明细打架」被两个方向同时钉住：**计数→明细**（台账=逐篇 coverage 计数）与
**明细→块内实际字**（chars=块里真实内容长度）；只有一个写入口（`setCov`）也经变异验证（§五）。

## 五、变异验证：6/6（注入红 / 还原绿 / diff clean）

命令（全程持构建锁，避免与并行任务抢 `dist/`）：

```bash
cd .worktrees/pr8-fixes
flock /tmp/dpr-pr8-build.lock node test/mutation-probe.mjs --only R4-
```

| 变异 id | 改回什么缺陷态 | 抓住它的用例 | 结果 |
|---|---|---|---|
| `R4-no-hit-always-truncated` | 无命中分支退回无条件 `truncated`（基线口径） | R4-1 | 注入=1 还原=0 diff=clean |
| `R4-chars-counts-note` | `chars` 改回 `text.length`（含说明句） | R4-1 | 注入=1 还原=0 diff=clean |
| `R4-hit-chars-includes-header` | 命中分支 `chars` 改回 `frag.length`（含页码段头） | R4-3 | 注入=1 还原=0 diff=clean |
| `R4-ledger-double-count` | `full++` 改 `full += 2`（台账与明细不同源） | R4-5 | 注入=1 还原=0 diff=clean |
| `R4-manifest-pollutes-truncated` | 清单截断又 `truncated++`（基线口径） | R4-7 | 注入=1 还原=0 diff=clean |
| `R4-audit-impl-suite-not-vacuous` | 同一缺陷回退，改跑 **t9 自己的** `S1` | t9 `test/pr8-coverage-honesty.test.mjs` | 注入=1 还原=0 diff=clean |

```
OK   R4-no-hit-always-truncated         注入=1 还原=0 diff=clean
OK   R4-chars-counts-note               注入=1 还原=0 diff=clean
OK   R4-hit-chars-includes-header       注入=1 还原=0 diff=clean
OK   R4-ledger-double-count             注入=1 还原=0 diff=clean
OK   R4-manifest-pollutes-truncated     注入=1 还原=0 diff=clean
OK   R4-audit-impl-suite-not-vacuous    注入=1 还原=0 diff=clean
# 变异验证：6/6 通过
```

- 最后一条专门回答「t9 的用例是不是空转」：把修复点改回 defects 后，**t9 自己的 S1 也红**
  ⇒ 它的用例确实在守行为，不是只加固不修实际误报。
- 注入前/后 `src/scope.ts` 的 sha256 均为 `9741cf98218a24999b122b62abe6e08606ed8a64b6cd0afc825511c755bea8e6`；
  `dist/scope.js` sha256 均为 `05eda043887c71fdd7c396798ba1e314654e1e463c458214db589bb2bc2b6f40`
  ⇒ 变异脚本还原干净（`git status` 里 `src/scope.ts` 的 `M` 是 t9 本轮的修复本身，不是残留变异）。

## 六、队长要求核对的三点（独立结论，不采信转述）

### 1) 「有意语义收紧」：`truncated` 只算论文截断篇数，清单截断改 `manifestTruncated`

**自洽，且不影响既有消费者/测试。** 证据：

- 全仓消费 `ctx.truncated` 的只有 `src/host.ts:1776`（`scopeInfo.truncated`）；
  `lib/client.js` 里 **0 处**读 `truncated`/`coverage`/`scope` 响应（`reader/index.html:1752` 只**发送** scope）。
  ⇒ 用户可见文案不经过这个计数；「清单被截断」的如实提示仍在 `block` 文本里（R4-7 断言 `/清单已截断至上限/`）。
- 既有测试**没有**任何一条断言「清单截断 ⇒ `truncated`+1」：全量 `test/*.mjs` 里涉及该字段的只有
  `test/pr8-session-client-scope.test.mjs:360` 与 `test/darkmode-subtopic-features.test.mjs:732`，两者断言的都是
  `papers[0].coverage === 'truncated'`（论文真截断），语义未变。
- 结果：`truncated` 现在**严格等于** `papers[].coverage==='truncated'` 的篇数，满足维护者「统计与明细逐条对上」；
  清单溢出通过 `manifestTruncated` + block 文案双路暴露，未隐藏。

### 2) `chars` 口径（是否把段标题/页码/说明句算进去）

修复后：`chars` = 该篇**内容**（正文切片/命中片段正文），**不含**段标题、页码标签与说明句；本探针 8 个场景逐篇
对账成立（§四）。基线的两种污染都被本探针独立复现（说明句 +24、页码标签 +8）并被变异钉住。

### 3) `full`/`manifestTruncated` 未进 `src/host.ts` 的 `scopeInfo` 白名单（低危元数据缺口）

**如实记录，非阻塞。** `src/host.ts:1771-1779` 的白名单确实只有
`kind/path/papers/omitted/truncated/chars/coverage`：
- 影响面：仅 `/api/ask` 响应元数据；仓内无消费者（client/reader 都不读），模型上下文（`ctx.block`）与
  用户可见文案不受影响；`full` 可由 `coverage` 数组派生，`manifestTruncated` 无法从 `coverage` 派生
  （只能从 block 文本看）。
- 不构成「用户看到静默假成功」：清单截断的说明文案在 block 里逐字存在（R4-7）。
- 建议（非阻塞）：host 白名单补 `full` 与 `manifestTruncated`，或在 `docs/features.md` 记录这两个字段只在内
  部上下文可用。

## 七、低危观察（均非 blocker/medium，供集成时顺手处理）

1. **`ScopeContext.omittedNotes` 的接口注释说「与 `omitted` 对应」，实际只有同名跳过会有 note**；
   预算不足的 `omitted-no-room` 不产生逐条 note（靠 `papers[].coverage` + 汇总句表达）。
   无消费者读该字段，信息未丢失，但注释与行为不完全一致。
2. **`ScopePaper.chars` 字段本身没有 JSDoc**，口径定义在 `setCov` 的实现注释里；
   另外逐篇 `chars` 之和 ≠ `bodyChars+hitChars`（后两者含段标题/说明句）——两套口径都自洽，但对读者不直观。
3. **`chars` 的 `Σ` 与 `totalChars` 不可直接互相校验**（差值为段标题/说明句开销）；本探针因此用
   「块内该篇实际内容长度 === chars」逐篇对账，而不是拿聚合字段相减。
4. **预算临界时的保守省略**：无命中分支 `(!wholeBody && limit < 200) ⇒ omitted-no-room`，
   当 `budget() ∈ (~400, ~500)` 时，一篇短正文（<200 字）本可整篇放下也会被标 omitted。
   属于显式收紧（提示仍说「因上下文上限未展开」），且只在预算几乎耗尽时出现，不影响正确性；若追求精确，
   可先判 `body.text.length <= budget() - 固定开销` 再决定。
5. **t9 证据 table 的一处措辞过宽**：其「台账一致性断言」行把 `chars ↔ 块内字数` 归给 `assertLedger`，
   实际 `assertLedger` 只检查 `chars>0 / ≤MAX_PER_DOC / 聚合恒等式`，块内逐字比对在各用例里单独做。
   行为没问题，属证据精度问题。

## 八、回归与并发（如实记录）

- 与本任务并行的 t3 当时正在改 `src/migrate.ts` / `src/host.ts`；本评审的构建一律走
  `flock /tmp/dpr-pr8-build.lock`，变异只碰 `src/scope.ts`，跑完哈希复原（§五）。
- 评审对象相邻用例（独立复跑，非引用 t9 结论）：
  - `test/pr8-coverage-honesty.test.mjs`：9/9 pass
  - `test/pr8-session-client-scope.test.mjs`：13/13 pass
  - `test/darkmode-subtopic-features.test.mjs`：53/53 pass（含 E1/E2/E3 范围契约；本次跑时无并发瞬时红）
- 未跑全量：本任务只评审 `src/scope.ts` 的 coverage/台账；全量窗口里 t3 有未提交中间态，
  跑全量可能产生与本任务无因果关系的瞬时红（t9 已记录过一次），故只跑与本改动相邻的三套件。

## 九、命令清单

```bash
cd /home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes
flock /tmp/dpr-pr8-build.lock -c 'npm run build'          # 通过
node --test test/pr8-review-r4.test.mjs                    # 8 pass / 0 fail
R4_REPO=/home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-baseline \
  node --test test/pr8-review-r4.test.mjs                  # 基线：1 pass（自检）/ 8 fail（行为红）
flock /tmp/dpr-pr8-build.lock node test/mutation-probe.mjs --only R4-   # 6/6 通过
node --test test/pr8-coverage-honesty.test.mjs             # 9 pass
node --test test/pr8-session-client-scope.test.mjs         # 13 pass
node --test test/darkmode-subtopic-features.test.mjs       # 53 pass
```
