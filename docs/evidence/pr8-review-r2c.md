# REV2c 门禁重绑：冻结字节上的 IMP2（A/G/H + 码点截断）结论（t17）

- 不是重做评审：沿用 t5 的自造探针 `test/pr8-review-r2.test.mjs` 与证据（t5 `pr8-review-r2.md`、
  t13 `pr8-review-r2b.md`），在**全部实现与修复收口后的冻结字节**上重跑、重新绑定 sha256。
- 工作树：`.worktrees/pr8-fixes`；基线：`.worktrees/pr8-baseline`（detached @ `fdb45f2`，已 build）
- 本任务只新增本文件；未改 `src/` / `lib/` / 他人测试；未 rebase / push / commit。

## 一、结论：**verdict=pass**

在下列冻结字节上，t5 的 IMP2（A 会话解析 / G 预算与诚实性 / H 客户端嵌套追踪 / 码点截断）结论
逐条复现（16/16；基线 1 pass / 16 fail 与 t5 相同；`R2-` 变异 6/6），且 IMP2 域自 t5 以来**零字节变化**
（t11/t14 的改动全部在域外）。

## 二、绑定字节（开工 17:09:17 / 收尾 17:09:49，两次采样**完全一致**）

| 文件 | sha256 |
|---|---|
| `src/tools.ts` | `4ffadc6f6adb95f25a5b5e251b8ee3409ca280519d17652a0ec5eb696a4f1c97` |
| `src/scope.ts` | `9741cf98218a24999b122b62abe6e08606ed8a64b6cd0afc825511c755bea8e6` |
| `lib/client.js` | `d0c2e794f134e70d03d451dfe8144e4fef81edd37e67cb7ccf818c2987b7bdca` |
| `dist/tools.js` | `dab1d7523bb01761dc99e7c639bf920d1b64c3af0cb415334ba63ab63df37e13` |
| `dist/scope.js` | `05eda043887c71fdd7c396798ba1e314654e1e463c458214db589bb2bc2b6f40` |

五个值与 **t13 的绑定值逐字节相同**，也与 **t5 评审运行时的采样值相同** ⇒ 自 t5 结论形成以来
IMP2 域没有任何变化（含注释）。`flock … npm run build` 后 `dist/tools.js` / `dist/scope.js` 哈希不变
（tsc 输出确定）。

证据工件（同样与 t5/t13 逐字节相同）：

| 工件 | sha256 |
|---|---|
| `test/pr8-review-r2.test.mjs` | `58fcbc1b3b7291cb13a873eb37e784128b87a6918ac274f49693247891b61a22` |
| `docs/evidence/pr8-review-r2.md`（t5 证据） | `47734774806f4933979887b296611acb3bc4aca1c40abdea052af27f9f98ab99` |
| `docs/evidence/pr8-review-r2b.md`（t13 证据） | `fb166010225c7e672f578a10a809786c0f79ed0163bcc0818b3e3ebce067029e` |

## 三、域隔离（t11/t14 全部在 IMP2 域外）

1. **符号零命中**：`sameFileForRename` / `caseVariantCollisions` / `flatArtifactNames` / `paperDirAncestor`
   在 `src/tools.ts`、`src/scope.ts`、`lib/client.js` 里 grep **零命中**；它们的落点是
   `src/host.ts` / `src/library-manage.ts`（t11/t14 的改动文件）。
2. **字节相同**：五个 IMP2 域文件的 sha256 与 t13 记录值完全一致（t13 运行期间唯一的变化是 t14 对
   `src/library-manage.ts` 的修改，域外）。
3. **冻结观测**：本窗口（17:09:17 → 17:09:49）内 `git status` 只有既有的 7 个实现文件修改 +
   `test/mutation-probe.mjs` + 未跟踪测试/证据；**无新的 src/lib 变更**，t7 只新增未跟踪的
   `test/pr8-verification.test.mjs`。

## 四、重跑结果（与 t5/t13 逐项相同）

```bash
cd /home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes
flock /tmp/dpr-pr8-build.lock -c 'npm run build'
node --test test/pr8-review-r2.test.mjs                                  # 16 pass / 0 fail
R2_REPO=.worktrees/pr8-baseline node --test test/pr8-review-r2.test.mjs  # 1 pass（自检）/ 16 fail
```

修复树 16/16 绿，关键诊断值逐项复现：

```
R2-A1  {"topic":"TopicA/SubB","name":"PaperC"}
R2-A2  {"topic":"TopicA/SubB","name":"PaperC","n":2}（ⓘ stale=false）
R2-G1  totalChars=39513 manifest=538 body=0 hits=38975 omitted=1 block=39670（≤40000；omitted 句 1 次）
R2-G2a papers=["Dup/Nested/Same","Dup/Same"] omitted=2（各带原因）
R2-G2b 模块 404 + 路由 404 {code:"not-found"}；存在专题正对照 200
R2-GC1/2/3 lone=0（U+1D400 跨 8000/8000/1200 无孤立代理项）；JSON 往返成立
R2-GC4 pad=0/1/2 manifestChars=2011 lone=0      R2-GC5 cutToCodePoint 语义全对
R2-H1a/b/c / H2 / H3 / H4 全部通过（A vs AB 不误伤、子树计数、clearEndpoint 透传、rekey 后请求路径 200）
```

基线对照：**1 pass / 16 fail**（唯一绿 = 基线模式自检；A1/A2/G1/G2a/G2b/GC1-5/H1a-H4 全红），
形态与 t5 完全相同 ⇒ 探针仍有判别力。

**变异重跑**：

```bash
flock /tmp/dpr-pr8-build.lock node test/mutation-probe.mjs --only R2-
# 6/6 通过（EXIT=0；每条 注入=1 还原=0 diff=clean）
```

跑后 `src/tools.ts` / `src/scope.ts` / `lib/client.js` / `dist/tools.js` / `dist/scope.js` 的
`sha256sum -c` 全部 OK（仍等于 §二 绑定值）⇒ 注入/还原干净，工作树冻结。

**回归**：`darkmode-subtopic-features` **53/53**；`pr8-coverage-honesty`（同一 `src/scope.ts` 上的 t9 套件）**9/9**。

## 五、与 t5 / t13 的差异

**无**：探针与证据工件逐字节相同、五文件字节相同、16 条断言与诊断值逐项复现、基线与变异形态相同。
本次新增信息仅是冻结窗口（17:09:17–17:09:49）的两次采样与 `git status` 观测。

## 六、命令清单

```bash
cd /home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes
flock /tmp/dpr-pr8-build.lock -c 'npm run build'                       # exit 0；dist 哈希不变
node --test test/pr8-review-r2.test.mjs                                # 16/16
R2_REPO=.worktrees/pr8-baseline node --test test/pr8-review-r2.test.mjs # 1 pass / 16 fail（预期红）
flock /tmp/dpr-pr8-build.lock node test/mutation-probe.mjs --only R2-  # 6/6
node --test test/darkmode-subtopic-features.test.mjs                   # 53/53
node --test test/pr8-coverage-honesty.test.mjs                         # 9/9
```
