# PR #8 评审 G 次级 —— coverage 误报与台账自洽性（任务 t9 / IMP4）

- 工作树：`/home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes`（`feat/darkmode-subtopic`，HEAD `fdb45f2` + 未提交修复）
- 基线对照：`/home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-baseline`（detached @ `fdb45f2`，已 build）
- 维护者断言：「短正文全覆盖时 `coverage` 误报 `truncated`（`src/scope.ts:253`）」
- 只改了 `src/scope.ts` + 新增 `test/pr8-coverage-honesty.test.mjs` + 本证据；未 commit / push / rebase。

## 一、结论

| 问题 | 判定 | 证据 |
|---|---|---|
| 短正文被完整覆盖却标 `truncated` | **该误报在基线成立；t2 重写后仍存在**（t2 只改了预算与去重，未动这个分支）→ **本轮已修** | §二 探针 + §三 基线红 |
| 无命中分支的 `chars`（基线把说明句也算进去） | 基线 `chars = text.length`（含「以下是开头片段」24 字）⇒ 与块内正文字数不符 → **已修成只算正文** | 基线 `chars=235` vs body=211；修复后 `chars=211` |
| 清单截断被算进论文 `truncated` 台账 | 基线 `manifest 超限 ⇒ truncated++` ⇒ 台账与 `papers[].coverage` 打架 → **已拆成 `manifestTruncated`** | 基线 S8 `truncated=1` 而 `coverage='no-body'`×12；修复后 `truncated=0` |
| 台账一致性断言 | 新增「逐条对账」（`truncated`/`full`/`omitted` ↔ `papers[].coverage`、`chars` ↔ 块内字数、预算上限） | `test/pr8-coverage-honesty.test.mjs` 的 `assertLedger` |

- 新用例：**基线 9/9 红 → 修复后 9/9 绿**。
- 变异验证：**3/3** 被对应用例抓住（§六）。
- 回归：`npm run build` 通过；全量 `node --test "test/*.test.mjs"` → **570 tests / 543 pass / 0 fail / 27 skip**。

## 二、基线触发条件（逐字回到 fdb45f2）

`docs/pr8-maintainer-review.md` 指的 `src/scope.ts:253` 就是这段（基线原文，行号 249-255）：

```ts
      if (hits.length === 0) {
        // 检索无命中：给开头一段作代表（显式标注），否则模型对这篇一无所知
        const limit = Math.max(0, Math.min(MAX_PER_DOC, budget() - 300))
        const slice = body.text.slice(0, limit)
        pushWithLabel(ref, label, `（本问题在该文中无关键词命中，以下是开头片段）\n${slice}`, 'truncated', body.source, null)
        truncated++
        continue
      }
```

**触发条件（精确）**：`scope.kind='topic'`（专题/子树范围）∧ 该篇有正文 ∧ `searchChunks` 命中数 = 0 ∧
`body.text.length ≤ min(MAX_PER_DOC, 预算-300)`（短正文，切片其实就是整篇）。
此时 `pushWithLabel(..., 'truncated', ...)` 与 `truncated++` 是**无条件**的 ⇒
`papers[i].coverage='truncated'`、`truncated=1`，而块里其实是**整篇正文**；且 `rec.chars = text.length`
把说明句（`（本问题在该文中无关键词命中，以下是开头片段）\n`，24 字）也算进了「本篇字数」。

## 三、探针输出（同一个库、同一个问题，基线与修复后对比）

探针脚本（临时库 `mkdtemp`，只调 `buildScopeContext`）：短正文 211 字、问题 `no-such-token-anywhere`。

```
# 基线 pr8-baseline（fdb45f2, dist/scope.js）
{"scope":"topic","bodyChars":211,"coverage":"truncated","recChars":235,"truncated":1,"blockHasWholeBody":true}
{"scope":"paper","bodyChars":211,"coverage":"full","recChars":211,"truncated":0,"blockHasWholeBody":true}

# 修复后 pr8-fixes（同一探针）
{"scope":"topic","bodyChars":211,"coverage":"full","recChars":211,"truncated":0,"blockHasWholeBody":true}
{"scope":"paper","bodyChars":211,"coverage":"full","recChars":211,"truncated":0,"blockHasWholeBody":true}
```

⇒ 基线：整篇正文都进了 block（`blockHasWholeBody=true`）却 `coverage='truncated'`、`truncated=1`、`chars=235`。
修复后：`full` / `truncated=0` / `chars=211`（= 正文实际字数）。**paper 分支在基线就是对的**（同样是短正文 + 无命中，说明误报只在 topic 的无命中分支）。

## 四、修复前（基线）红证据（9/9）

跑法：把新用例复制到基线 `test/` 再执行（`node --test test/pr8-coverage-honesty.test.mjs`）：

```
not ok 1 - S1 【基线误报】短正文无命中但整篇纳入 ⇒ coverage=full、truncated=0、chars=正文长度
    整篇正文都给了，必须标 full（基线误报 truncated）：truncated
# coverage=truncated chars=235 truncated=1 body=211
not ok 2 - S2 【反证】无命中且正文超 MAX_PER_DOC ⇒ 真截断…
    chars 必须是实际纳入的 8000 字：8024          ← 基线把说明句 24 字也算进 chars
# coverage=truncated chars=8024 truncated=1 block=8228
not ok 3 - S3 有命中且该篇正文只有一个 chunk（全部纳入）⇒ full、chars=正文长度
    chars 必须是片段正文实际字数：318              ← 318 = 310 + 「（第 ? 页）\n」8 字
not ok 4 - S4 有命中但 1200 字片段上限生效 ⇒ truncated、chars=1200…
# coverage=full chars=1508 chunk0=1500            ← 基线：正文段 1500 字未按 1200 限，标 full
not ok 5 - S5 单篇范围长正文 ⇒ truncated、chars=8000、truncated=1
    （ledger: ctx.full 缺失 / 台账字段）
not ok 6 - S6 混合台账：full+truncated+no-body…
# full=undefined truncated=3 omitted=0 coverage=["Mix/P1:truncated","Mix/P2:truncated",…]
not ok 7 - S6b 预算耗尽台账…
# full=undefined truncated=5 omitted=2 total=39755 …
not ok 8 - S7 同名论文 skipped…
not ok 9 - S8 清单被 MAX_MANIFEST 截断 ⇒ manifestTruncated=true…
# manifestChars=2012 manifestTruncated=undefined truncated=1 papers=12   ← 清单截断污染 truncated
# tests 9 / pass 0 / fail 9
```

> 说明：S5/S7 在基线的红点是「台账字段缺失」（`ctx.full` 是新台账），S1/S2/S3/S4/S8 是**行为红**。
> 为了让读者不依赖新字段也能看到行为红，每条用例的**行为断言都在 `assertLedger` 之前**（例如 S1 的
> `coverage==='full'`）。

## 五、修复后绿证据（9/9）

```
ok 1 - S1 …    coverage=full chars=211 truncated=0 body=211
ok 2 - S2 …    coverage=truncated chars=8000 truncated=1 block=8228
ok 3 - S3 …    coverage=full chars=310 hitChars=326
ok 4 - S4 …    coverage=truncated chars=1200 chunk0=1500
ok 5 - S5 …    coverage=truncated chars=8000 truncated=1
ok 6 - S6 …    full=1 truncated=2 omitted=0 coverage=["Mix/P1:full","Mix/P2:truncated","Mix/P3:truncated","Mix/P4:no-body"]
ok 7 - S6b …   full=0 truncated=5 omitted=2 total=39355 coverage=["Big/P1:truncated",…,"Big/P6:omitted-no-room","Big/P7:omitted-no-room"]
ok 8 - S7 …    （同名论文 omitted=2 / omitted-duplicate×2 / full=truncated=0）
ok 9 - S8 …    manifestChars=2012 manifestTruncated=true truncated=0 papers=12
# tests 9 / pass 9 / fail 0
```

## 六、变异验证（3/3 被抓住）

在隔离沙箱（`.probe/mut2/`，gitignored，不动主工作树）把修复逐个改回缺陷态：

| 变异 | 改回什么 | 抓住它的用例 |
|---|---|---|
| N01 | 无命中分支退回无条件 `'truncated'`（基线口径） | S1 |
| N02 | 命中分支 `chars` 退回 `docUsed`（含 `--- 路径 第 N 页 ---` 标题） | S3、S4 |
| N03 | 清单截断又 `truncated++`（基线口径） | S8 |

输出：`3/3 个变异被抓住`（每条的 `not ok` 列表见沙箱 `mut-logs/`；沙箱已删除，结论已在本次会话与上表留档）。

## 七、台账语义（本轮新增/收紧，均与逐篇明细同源）

`buildScopeContext` 的 coverage 与计数现在**只有一个写入口** `setCov(rec, cov, source, chars)`
（`src/scope.ts:297`），因此不可能再出现「统计与明细打架」：

- `papers[].coverage ∈ {full, truncated, no-body, omitted-no-room, omitted-duplicate}`；
- `ctx.full`（**新增**）= `papers[].coverage==='full'` 的篇数；
- `ctx.truncated` = `papers[].coverage==='truncated'` 的篇数（**不再包含**清单截断）；
- `ctx.omitted` = `papers[].coverage` 以 `omitted-` 开头的篇数（含同名论文 `omitted-duplicate`）；
- `ctx.manifestTruncated`（**新增**）= 目录清单是否超 `MAX_MANIFEST`；提示块里仍有「清单已截断至上限」；
- `papers[].chars` = 该篇**内容**（正文切片/命中片段文本，**不含**段标题、页码标签与说明句）实际进入
  block 的字数；`full|truncated ⇒ chars>0`，`no-body|omitted-* ⇒ chars===0`；
- `ctx.totalChars === manifestChars + bodyChars + hitChars ≤ MAX_CONTEXT_CHARS(40000)`；`block.length ≤ 40000+800`。

**有意的语义收紧（请评审知悉）**：`host.ts` 的 `scopeInfo.truncated` 现在只表示「论文被截断的篇数」，
不再被清单溢出 +1。这正是维护者要的「统计与明细逐条对得上」；清单截断仍通过 `block` 文案与新的
`manifestTruncated` 如实暴露，未隐藏任何信息。

## 八、落点（file:line）

- `src/scope.ts:90`：`ScopeContext.full`（新台账字段）
- `src/scope.ts:93`：`truncated` 注释收窄（只算论文）
- `src/scope.ts:95`：`manifestTruncated`（新字段）
- `src/scope.ts:247-249`：`full` / `truncated` / `manifestTruncated` 计数器
- `src/scope.ts:280`：清单截断只置 `manifestTruncated`（不再 `truncated++`）
- `src/scope.ts:297-305`：`setCov` —— coverage 与台账的唯一写入口
- `src/scope.ts:353-365`：**误报修复点**：`wholeBody = slice.length >= body.text.length`，
  `setCov(rec, wholeBody ? 'full' : 'truncated', body.source, slice.length)`；文案按
  `wholeBody ? '全文' : '开头片段'` 诚实输出
- `src/scope.ts:371-387`：命中分支 `docChars` 只累计片段正文，`setCov(..., docChars)`
- `src/scope.ts:433`：返回值新增 `full` / `manifestTruncated`
- `test/pr8-coverage-honesty.test.mjs`：9 例（S1 基线误报点 / S2 反证真截断 / S3 命中整篇 full /
  S4 命中断片 truncated / S5 单篇真截断 / S6 混合台账 / S6b 预算耗尽台账 / S7 同名 skipped 台账 /
  S8 清单截断台账分离）+ `assertLedger` 统一对账

## 九、行为契约未变（回归由既有用例守着）

- 预算上限与计费口径不变（`totalChars` 仍 ≤ 40000；S2/S4/S6b 里的 `chars` 与块内字数逐字一致）；
- omitted 提示句仍只出现一次、`omitted` 语义不变（S6b/S7；`node --test test/pr8-session-client-scope.test.mjs` 全绿）；
- 同名论文仍进 `omitted-duplicate` + 原因（S7）；
- 码点安全截断未动（`cutToCodePoint`；`test/pr8-session-client-scope.test.mjs` 的 GC1-GC4 全绿）；
- 清单超限仍有显式文案（S8），只是不再污染论文 `truncated` 台账。

## 十、命令

```bash
cd /home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes
flock /tmp/dpr-pr8-build.lock -c 'npm run build'     # 通过
node --test test/pr8-coverage-honesty.test.mjs        # 9 pass / 0 fail
node --test "test/*.test.mjs"                         # 580 tests / 553 pass / 0 fail / 27 skip（t9 定稿后重跑）
```

（t9 定稿瞬间同树只有 570 条测试；此后 t3 落入了 10 条迁移用例，故最终全量是 580 条，仍 0 fail。）

基线红：把 `test/pr8-coverage-honesty.test.mjs` 复制到 `pr8-baseline/test/` 跑（9 fail / 0 pass），跑完已删除，
基线工作树未留下任何未跟踪文件。

### 关于「同树并发任务的瞬时红」（如实记录）

本任务定稿后（16:00）全量跑出 **570 tests / 543 pass / 0 fail / 27 skip**。
期间同树的 **t3（engineer，正在改 `src/migrate.ts`，D/E 迁移契约）** 有几秒未提交的中间态，让全量里的
**C5 可中断**（`test/darkmode-subtopic-features.test.mjs`，走 `MG.runMigration/planMigration`，**不经过
`src/scope.ts`**）瞬时红（断言 `plan.alreadyDone.length` = 0，期望 2）；t3 收口后（16:07）重跑全量
**580 tests / 553 pass / 0 fail / 27 skip**，C5 恢复绿。本任务 inScope 不含 `src/migrate.ts`，未改它；
上述瞬时红与本任务改动无因果关系（C5 不 import `dist/scope.js` 的任何导出）。
