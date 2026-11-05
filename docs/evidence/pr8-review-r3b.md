# REV3b 门禁重绑：冻结字节上的 IMP3（D/E + G host 次级）结论 + t11/t14 回归专项（t18）

- 不是重做评审：沿用 t6 的自造探针 `test/pr8-review-r3.test.mjs` 与证据 `docs/evidence/pr8-review-r3.md`，
  在**全部实现与修复收口后的冻结字节**上重跑、重新绑定 sha256，并专项复核 t11/t14 对
  `src/library-manage.ts` / `src/host.ts` 的后续改动没有影响 D/E。
- 工作树：`.worktrees/pr8-fixes`；基线：`.worktrees/pr8-baseline`（detached @ `fdb45f2`，已 build）
- 本任务只新增本文件；未改 `src/` / `lib/` / 他人测试；未 rebase / push / commit。

## 一、结论：**verdict=pass**

在下列冻结字节上，t6 的 IMP3 结论（D1/D2/D3 清空占用与清单、E1 坏行日志回滚、E2 半成品中断与复跑、
E3a 迁移期间 GET 及时、E3b busy 门、G3 scopeBusy paper 提示、G4 回滚日志前缀）逐条复现（10/10；
基线 1 pass / 10 fail 与 t6 相同；`R3-` 变异 5/5），t11/t14 的改动未影响 D/E 行为。

## 二、绑定字节（开工 17:10:41 / 收尾 17:11:55，两次采样**完全一致**）

| 文件 | sha256 | 与 t6 时对比 |
|---|---|---|
| `src/host.ts` | `13358a0d7f82f13c933ba8ea9fffb42fcb71899da7665b50c7316c081b3fbb41` | **相同**（t6 后未变） |
| `src/migrate.ts` | `017dac01d24be059c3f838312f1a3b9fc42393ca63220deecba1dcfad672982b` | **相同**（t6 后未变） |
| `src/library-manage.ts` | `5eb1e494526d2e09856c83c8614c6c8c2456360fc5fbfc9c4fcf2016bb443665` | 变化（t6 时 `05e246de…`，t11/t14 改的） |
| `dist/host.js` | `48d8787543b3239e0597f88b0d75d2dd1444cd4080241b6efe3c79e720ffd7d8` | — |
| `dist/migrate.js` | `c9b328a7f5999908df064c4fe4618491b8a5d525012aa9d19cdeb97638acde32` | — |
| `dist/library-manage.js` | `d14fbbf262af7bef346abe781ffd4f403a4873eba5f3dc36438493cc27953925` | — |

`flock … npm run build` 后三个 dist 文件哈希与采样值一致（tsc 输出确定）。`--only R3-` 变异跑完后
`sha256sum -c` 六项全 OK。窗口内 `git status` 只有既有的 7 个实现文件修改 + `test/mutation-probe.mjs`
+ 未跟踪测试/证据，**无新的 src/lib 变更**。

## 三、t11/t14 回归专项：改动只落在 rename / create-topic，未触碰 D/E 入口

- **静态隔离**：t11/t14 的符号落点——
  - `sameFileForRename` 仅被 `renamePaper` 的逐文件预检调用（`src/library-manage.ts:1154`）；
  - `caseVariantCollisions` 仅被 `renameTopic`（`:1310/:1319`）与 `src/host.ts` 的 create-topic/upload
    （`:611/:708`）使用；
  - **不在** D 的入口 `planTopicClear`（`src/library-manage.ts:852`）与 `clearTopic`（`:894`）里，
    也不在 `src/migrate.ts` / `src/host.ts` 的迁移/清空路由里。
- **字节旁证**：`src/host.ts` 与 `src/migrate.ts` 自 t6 以来哈希未变（`13358a0d…` / `017dac01…`）；
  唯一变化的是 `src/library-manage.ts`（t11/t14 的 renamePaper/renameTopic 区域）。
- **行为重跑**（冻结字节）：

| D/E 条目 | 探针 | 修复树结果 |
|---|---|---|
| D1 子专题论文有活跃会话 ⇒ 清空被拒 | `R3-D1` | ✅ 409 `session-running`（sessions 1/1）、零改动、无 `.trash` |
| D2 clear-plan 清单含子树且 `papersCount` 一致 | `R3-D2` | ✅ papers=`["T/P1","T/Sub/P2","T/Sub/Deep/P3"]`、count=3 |
| D3 生成中译文 ⇒ 清空 409 且点名 | `R3-D3/E3b` | ✅ 409 `translation-busy`、papers=`["T/Sub/P2"]` |
| E3b 在飞译文时 `/migrate` | `R3-D3/E3b` | ✅ 409 `busy`、papers=`["T/Sub/P2"]`、零改动 |
| E1 坏 JSONL（首/中/尾行截断）CLI 非 0 + 行号 | `R3-E1` | ✅ exit 1 + 第 1/2/5 行 + `migrate-log-corrupt`；好日志 exit 0「已回滚 4 个文件」 |
| E1b 路由回滚对坏行 409 | `R3-E1b` | ✅ 409 `migrate-log-corrupt` |
| E2 手工半成品现场（空目录 + 标记/半截）复跑 | `R3-E2` | ✅ `copied=4 removed=4`、`half=["T/HalfA","T/HalfB"]`、标记清除、异目录零改动、复跑 `copied=0` |
| E2b 真实中断（failAfterCopies=1）→ 标记 → 复跑收敛 | `R3-E2b` | ✅ `aborted=MigrationAborted`；复跑 `copied=2 removed=2 partial=false` |
| E3a 迁移期间并发 GET 及时返回 | `R3-E3a` | ✅ `GET=200`、`remaining@GETdone=77ms`（900 文件） |
| G3 paper 范围 busy 提示 | `R3-G3` | ✅ prompt 出现「正在被修改…本次只给了 N 篇」 |
| G4 回滚日志前缀 | `R3-G4` | ✅ `<logDir>-evil` → 400 `escape-rejected`；目录内日志 200 `restored:1` |

## 四、重跑：探针与基线对照

```bash
cd /home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes
node --test test/pr8-review-r3.test.mjs                                  # 10 pass / 0 fail
R3_REPO=.worktrees/pr8-baseline node --test test/pr8-review-r3.test.mjs  # 1 pass（自检）/ 10 fail
```

- 修复树 **10/10 绿**，诊断值与 t6 逐项相同（如 `papers=["T/P1","T/Sub/P2","T/Sub/Deep/P3"] count=3`、
  `copied=4 removed=4`、`remaining@GETdone=77`、`evil=400`/`good=200 restored:1`）。
- 基线 **1 pass / 10 fail**，形态与 t6 相同（D1 200 真搬 `.trash`、D2 只列根层、E1 CLI exit 0 假成功、
  E2 半成品永远跳过、E3a GET 被堵到迁移结束、E3b 200、G3 无提示、G4 兄弟目录日志被执行）。

## 五、变异验证（R3- 5/5，跑后字节未变）

```bash
flock /tmp/dpr-pr8-build.lock node test/mutation-probe.mjs --only R3-
# OK R3-log-corrupt-swallowed / R3-halfproduct-off / R3-rollback-prefix-nosep
#    R3-migrate-busy-gate-off / R3-clear-subtree-off
# 变异验证：5/5 通过   （EXIT=0；每条 注入=1 还原=0 diff=clean）
```

跑后六文件 sha256 与 §二 绑定值全部一致（`sha256sum -c` 全 OK）⇒ t11/t14 没有改废任一 R3 锚点。

## 六、回归

```
node --test test/darkmode-subtopic-features.test.mjs  # 53/53
node --test test/pr8-clear-migrate.test.mjs           # 10/10（t3 的 D/E 实现方套件，非空转核验）
```

## 七、与 t6 的差异

**无行为差异**：10 条探针逐条复现、基线形态相同、R3 变异 5/5 且锚点未漂移。新增信息仅是
§二 的冻结字节绑定（`src/library-manage.ts` 从 t6 的 `05e246de…` 变为 `5eb1e494…`，已由 t11/t14 的
rename 路径改动解释；host/migrate 未变）与 §三 的静态/行为双重复核。

## 八、命令清单

```bash
cd /home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes
flock /tmp/dpr-pr8-build.lock -c 'npm run build'                       # exit 0；dist 哈希与采样一致
node --test test/pr8-review-r3.test.mjs                                # 10/10
R3_REPO=.worktrees/pr8-baseline node --test test/pr8-review-r3.test.mjs # 1 pass / 10 fail（预期红）
flock /tmp/dpr-pr8-build.lock node test/mutation-probe.mjs --only R3-  # 5/5
node --test test/darkmode-subtopic-features.test.mjs                   # 53/53
node --test test/pr8-clear-migrate.test.mjs                            # 10/10
```
