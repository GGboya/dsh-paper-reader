# REV2b 门禁复审：在 t11 后的稳定字节上重绑 IMP2（A/G/H + 码点截断）结论（t13）

- 不是重做评审：沿用 t5 的自造探针 `test/pr8-review-r2.test.mjs` 与证据 `docs/evidence/pr8-review-r2.md`
  （两者哈希与 t5 时**逐字节相同**，见 §一），本次只做「重跑 + 字节绑定 + 域外变更登记」。
- 工作树：`.worktrees/pr8-fixes`（`feat/darkmode-subtopic`，HEAD `fdb45f2` + 全部未提交修复；t11 已收口）
- 基线：`.worktrees/pr8-baseline`（detached @ `fdb45f2`，已 build）
- 本任务只新增本文件；未改 `src/` / `lib/` / 他人测试；未 commit / push / rebase。

## 一、结论与绑定字节

**verdict: pass** —— 在下列字节上，t5 的 IMP2 结论逐条复现（修复树 16/16，基线 1 pass/16 fail，
`R2-` 变异 6/6，回归 53/53 与 9/9 全绿）。

**本次结论绑定于（采样时刻：2026-10-26T16:46 起，2026-10-26T16:48:29 收尾复核，两次完全一致）**：

| 文件 | sha256 |
|---|---|
| `src/tools.ts` | `4ffadc6f6adb95f25a5b5e251b8ee3409ca280519d17652a0ec5eb696a4f1c97` |
| `src/scope.ts` | `9741cf98218a24999b122b62abe6e08606ed8a64b6cd0afc825511c755bea8e6` |
| `lib/client.js` | `d0c2e794f134e70d03d451dfe8144e4fef81edd37e67cb7ccf818c2987b7bdca` |
| `dist/tools.js`（重建后仍一致） | `dab1d7523bb01761dc99e7c639bf920d1b64c3af0cb415334ba63ab63df37e13` |
| `dist/scope.js`（重建后仍一致） | `05eda043887c71fdd7c396798ba1e314654e1e463c458214db589bb2bc2b6f40` |

证据工件（与 t5 时逐字节相同，证明探针没有被事后改动）：

| 工件 | sha256 |
|---|---|
| `test/pr8-review-r2.test.mjs` | `58fcbc1b3b7291cb13a873eb37e784128b87a6918ac274f49693247891b61a22` |
| `docs/evidence/pr8-review-r2.md`（t5 证据） | `47734774806f4933979887b296611acb3bc4aca1c40abdea052af27f9f98ab99` |

> 这五个 IMP2 域文件的 sha256 与 **t5 评审运行时的采样值完全相同**（t5 会话内 `/tmp/r2-pre.txt`
> 记录：tools `4ffadc6f…` / scope `9741cf98…` / client `d0c2e794…` / dist/tools `dab1d752…` /
> dist/scope `05eda043…`）⇒ 自 t5 结论形成以来，IMP2 域**没有任何字节变化**（含注释）。
> 期间发生变更的只有 t11 的域：`src/host.ts` / `src/library-manage.ts`。

## 二、t11 没有侵入 IMP2 域（三重举证）

1. **字节相同**：上表五文件与 t5 时采样值完全一致。
2. **符号隔离**：在 `src/tools.ts` / `src/scope.ts` / `lib/client.js` 里 `grep` t11 新增/使用的符号
   （`sameFileForRename` / `caseVariantCollisions` / `flatArtifactNames` / `paperDirAncestor`）——**零命中**；
   t11 的落点只在 `src/host.ts`（create-topic 变体检查）与 `src/library-manage.ts`（C4 预检 / renameTopic 变体检查）。
3. **窗口内无改动**：t13 探针开始与收尾（16:46 → 16:48:29）两次采样，五个文件哈希一致；
   期间 `dist/tools.js`、`dist/scope.js` 经 `flock` 重建后仍与采样值一致（tsc 输出确定性，且 IMP2 模块不 import
   host/library-manage）。

**登记（队长要求的并发观测）**：t13 期间 **t14（engineer 修 R5-01）尚未写入**——
`src/library-manage.ts` 在 16:48:29 仍为 `e967c0a4435b1057811104a4a0ec754ae4891a850d6c50839b7b008eaf8ced0f`
（与 t12 结束时的记录相同），`src/host.ts` 仍为 `13358a0d…`。若 t14 随后改动 `library-manage.ts`：
那是 IMP2 域**之外**的文件（见举证 2），不影响本结论；本文件如实记录该观测窗口，供门禁判断。

## 三、逐条重跑结果（与 t5 完全一致）

```bash
cd /home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes
flock /tmp/dpr-pr8-build.lock -c 'npm run build'
node --test test/pr8-review-r2.test.mjs        # 16 pass / 0 fail
R2_REPO=/home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-baseline \
  node --test test/pr8-review-r2.test.mjs      # 1 pass（基线自检）/ 16 fail
```

修复树 16/16 绿，关键诊断值与 t5 证据逐项相同：

```
R2-A1  {"topic":"TopicA/SubB","name":"PaperC"}
R2-A2  {"topic":"TopicA/SubB","name":"PaperC","n":2}（ⓘ stale=false）
R2-G1  totalChars=39513 manifest=538 body=0 hits=38975 omitted=1 block=39670（≤40000；omitted 句 1 次）
R2-G2a papers=["Dup/Nested/Same","Dup/Same"] omitted=2（各带原因）
R2-G2b 模块 404 + 路由 404 {code:"not-found"}；存在专题正对照 200
R2-GC1/2/3  lone=0（U+1D400 跨 8000/8000/1200 各无孤立代理项）；JSON 往返成立
R2-GC4  pad=0/1/2 manifestChars=2011 lone=0     R2-GC5 cutToCodePoint 语义全对
R2-H1a/b/c / H2 / H3 / H4 全部通过（A vs AB 不误伤、子树计数、clearEndpoint 透传、rekey 后请求路径 200）
```

基线对照（同一探针，fdb45f2）：**1 pass / 16 fail**（唯一 pass 是基线模式自检；
A1/A2/G1/G2a/G2b/GC1-5/H1a-H4 全红）——与 t5 的形态相同，说明探针仍然有判别力。

## 四、变异与回归（t11 没有把 R2- 变异改废）

```bash
flock /tmp/dpr-pr8-build.lock node test/mutation-probe.mjs --only R2-
```

```
OK R2-tools-parse-first-slash / R2-client-parse-first-slash / R2-hits-not-counted-in-budget
OK R2-cut-codepoint-off / R2-prefix-without-separator / R2-hidden-paper-skipped（既有迁移域，非 REV2 对象）
# 变异验证：6/6 通过   （EXIT=0；每条 注入=1 还原=0 diff=clean）
```

- 变异前后 `src/tools.ts` / `src/scope.ts` / `lib/client.js` / `dist/tools.js` / `dist/scope.js`
  的 sha256 = §一表值（`sha256sum -c` 全 OK）⇒ 注入/还原干净，跑完仍绑定同一字节。
- **锚点无一失效**（不需要记「锚点漂移」note）。

回归：

```
node --test test/darkmode-subtopic-features.test.mjs   # 53/53
node --test test/pr8-coverage-honesty.test.mjs         # 9/9（同 src/scope.ts 上的 t9 套件）
```

## 五、与 t5 的差异

**无行为差异**：五文件字节相同、探针与证据工件字节相同、14 项断言与诊断值逐项复现、
基线与变异形态相同。唯一新增信息是本节 §二.3 的并发观测（t14 的写入未在 t13 窗口内被观测到；
且即使发生也只动 `library-manage.ts`，不属 IMP2 域）。

## 六、命令清单

```bash
cd /home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes
flock /tmp/dpr-pr8-build.lock -c 'npm run build'                       # exit 0；dist/tools,scope 哈希不变
node --test test/pr8-review-r2.test.mjs                                # 16/16
R2_REPO=.worktrees/pr8-baseline node --test test/pr8-review-r2.test.mjs # 1 pass / 16 fail（预期红）
flock /tmp/dpr-pr8-build.lock node test/mutation-probe.mjs --only R2-  # 6/6
node --test test/darkmode-subtopic-features.test.mjs                   # 53/53
node --test test/pr8-coverage-honesty.test.mjs                         # 9/9
```

## 七、收尾追加观测（16:48:54，队长要求的并发登记）

t13 收尾最后一次采样（2026-10-26T16:48:54+08:00）发现 **t14 已开始写入**：

- `src/library-manage.ts`：`e967c0a4…`（16:48:29 时）→ **`5eb1e494526d2e09856c83c8614c6c8c2456360fc5fbfc9c4fcf2016bb443665`**（16:48:54）。
- `src/host.ts` 未变（`13358a0d…`）。
- **IMP2 域五文件全部未变**：`src/tools.ts` `4ffadc6f…`、`src/scope.ts` `9741cf98…`、
  `lib/client.js` `d0c2e794…`、`dist/tools.js` `dab1d752…`、`dist/scope.js` `05eda043…`
  —— 与 §一 的绑定值逐字节相同。

⇒ t13 的探针、基线对照、`R2-` 变异与回归**全部在 §一 的五文件字节上完成**；期间唯一变化是
t14 对 `src/library-manage.ts` 的修改（IMP2 域之外，见 §二举证 2）。若门禁以「整树是否变更」
作为绑定判据而判定 t13 不绑定，请按队长的预案补一次「只做绑定」的极小复审；本文件已如实登记
该变更的**文件名、前后哈希与采样时刻**，没有把它算进 IMP2 的行为结论。
