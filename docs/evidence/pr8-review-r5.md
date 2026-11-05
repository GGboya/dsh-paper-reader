# IMP5（t11）C4 ino 守卫 + 大小写变体碰撞 —— REV5 独立对抗评审（t12）

- 评审对象：t11 对 `docs/evidence/pr8-review-r1.md` §六两条低危观察的修复
  （① C4 同 inode 例外缺 `ino === 0` 平台守卫；② create-topic / renameTopic 缺大小写变体碰撞）。
- 工作树：`.worktrees/pr8-fixes`（`feat/darkmode-subtopic`，HEAD `fdb45f2` + 全部未提交修复；t11 已完成，当前字节稳定）
- 基线：`.worktrees/pr8-baseline`（detached @ `fdb45f2`，已 build）
- 本评审只新增/改动三样，均在 t12 inScope：`test/pr8-review-r5.test.mjs`（新，9 例）、
  `test/mutation-probe.mjs`（+4 条 `R5-` 变异）、本文件。**未改 `src/`、`lib/`、他人 `test/pr8-*.test.mjs`；
  未 commit / push / rebase。**
- **独立性**：不 import 实现方 `test/pr8-platform-guards.test.mjs`；假 stat 矩阵、真实残留文件、
  hardlink 现场、create/rename 大小写场景、跨父级移动、三处口径对照全部本评审自造。
  同一份探针可跑基线：`R5_REPO=<baseline> node --test test/pr8-review-r5.test.mjs`。
- 当前字节（供绑定）：`src/host.ts` = `13358a0d…`，`src/library-manage.ts` = `e967c0a4…`，
  `src/library.ts` = `8eacad1b…`，`dist/host.js` = `48d87875…`，`dist/library-manage.js` = `aad12794…`
  （变异跑前跑后一致）。

## 一、结论：**needs_revision**（1 条 medium finding，其余全部通过）

| 验收点 | 结果 |
|---|---|
| 假 stat 打纯函数（0/0、0/123、123/123、123/456、dev=0、sameEntry=false） | ✅ 全符合保守方向 |
| 真实场景：目标残留文件存在 ⇒ 409 且内容不被覆盖；清残留后可正常改名 | ✅ |
| hardlink（同 inode 不同目录项）⇒ 仍 409（守卫方向没反） | ✅ |
| 合法的大小写-only **论文**改名仍放行 | ✅ |
| create-topic 大小写变体 ⇒ 409 + 点名磁盘真名；精确同名仍幂等 200 | ✅ |
| renameTopic 与**别的**同级对象仅大小写不同 ⇒ 409 + 点名真名 | ✅ |
| upload / create-topic / renameTopic 对真实大小写变体口径一致（三处都 409 且点名真名） | ✅ |
| 跨父级移动不受影响 | ✅ |
| 基线复现两条缺陷（C4 静默覆盖 200、create-topic 假成功 200） | ✅（见 §三） |
| 新增 `R5-` 变异 ≥2 条实跑通过；既有 `R1-` 聚合仍 8/8 | ✅ 4/4、8/8 |
| 回归 layout-collision 15 / darkmode 53 | ✅ |
| **不引入 blocker/medium** | ❌ **renameTopic 把「源自身」的大小写改名也挡了（能力回退）** |

## 二、Finding（medium）

### R5-01 renameTopic 把「源自身」的大小写-only 改名也判成变体碰撞（Linux 能力回退）

- **severity**: medium
- **file**: `src/library-manage.ts`
- **line**: 1301（`const caseClash = caseVariantCollisions(parentAbs, newSegs[newSegs.length - 1]!)`）
- **problem**：该检查没有排除**源目录自身**。同一父级下把 `Alpha/CaseTopic` 改名成 `Alpha/casetopic`
  （只改大小写、无任何真实同级碰撞）现在返回 **409**，且 `conflicts:["CaseTopic"]`、错误文案
  「已存在仅大小写不同的同名专题：CaseTopic」——点名的就是它自己。实测：
  - 基线（fdb45f2）：`200 {"ok":true,"from":"Alpha/CaseTopic","to":"Alpha/casetopic"}`（真实改名生效）；
  - t11 后：`409 {"code":"target-exists","conflicts":["CaseTopic"],"error":"已存在仅大小写不同的同名专题：CaseTopic…"}`。
  这是**无收益的能力回退**：
  1. ext4 上这是真实生效的改名，不是「假成功」——t11 修复目标（消除假成功 / 与 upload 口径一致）不覆盖这种情形；
  2. 维护者在评审「其它（不阻塞，记录在案）」里把「**大小写改名在 macOS/Windows 被拒**」记为已知债，
     方向应是将来放开，而不是把它扩张到 Linux；
  3. t11 授权只要求「create-topic 与 upload 口径一致 + rename 不得假成功」，未要求禁止自身大小写改名；
  4. 用户修正常见需求（把专题名大小写改对）在 Linux 上从可用变为 409，且没有 UI 变通路径。
  另外，t11 自己的用例把这种 self-case 改名**当作期望 409** 断言
  （`test/pr8-platform-guards.test.mjs:186-190`：`rename-topic {topic:'CaseTopic', to:'casetopic'}`
  期望 409 且 `conflicts:['CaseTopic']`），等于把回退锁进回归网——这也解释了它为什么没被发现。
- **requiredFix**：`renameTopic` 计算 `caseClash` 时排除**源条目自身**（仅当目标父级 == 源目录父级）：
  从 `caseVariantCollisions` 结果里过滤掉与 `basename(dir)` 指向同一目录项的那一条（或先构造集合再
  `delete` 源名）；**保留**「与别的同级对象仅大小写不同」的 409，create-topic / upload 不动
  （它们没有「源」，口径不会分裂）。并补两条用例：① 同父级 self-case-only 改名 200 且目录真的换大小写；
  ② `Other → CaseTopic`（同级已有 `casetopic`）仍 409 且点名 `casetopic`；跨父级移动仍 200。
- **影响面**：仅 renameTopic 的同一父级 self-case 场景；C4、create-topic、upload、跨父级移动都不受影响。

**反方观点（已考虑，未采纳）**：「三平台统一拒绝大小写改名更可预期」。
不采纳的理由：维护者把 mac/win 的拒绝列在「其它（不阻塞）」而不是要求（方向是放开）；
自我改名在 ext4 上是真实操作、无数据风险；统一应朝「允许」收敛（或至少不在 Linux 上扩大拒绝）。
若团队最终选择三平台统一拒绝，需要维护者明确裁决，并应在 features/README 写明该限制与用户变通方式，
而不是以「假成功修复」的名义静默加入。

## 三、基线对照（同一探针跑 fdb45f2）

```bash
R5_REPO=/home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-baseline \
  node --test test/pr8-review-r5.test.mjs
# tests 10（+自检）/ pass 4 / fail 6
```

| 用例 | 基线 | 修复后 |
|---|---|---|
| R5-INO 假 stat | 无 `sameFileForRename` 导出（红） | 8 组矩阵全部符合保守方向 |
| R5-C4-REAL 残留文件 | **200**（`renamePaper` 返回 OK，残留 `New.txt` 被覆盖） | `409 target-exists`、快照零改动、内容原样；清残留后 200 |
| R5-C4-HARDLINK | **200**（无逐文件预检） | 409（sameEntry=false ⇒ 冲突；方向正确） |
| R5-C4-CASEONLY 论文大小写改名 | 200（绿） | 200（绿，未被守卫误伤） |
| R5-CREATE-CASE | **200** 且盘上并存 `CaseTopic` + `casetopic` | 409 `conflicts:['CaseTopic']`，不建第二个变体；精确同名仍 200 |
| R5-RENAME-REAL（别的同级对象） | **200**（静默造出近同名专题） | 409 `conflicts:['casetopic']` |
| R5-CROSS-PARENT | 200 | 200（不受影响） |
| R5-CONSISTENCY 三处口径 | upload 200 / create 200 / rename 409（三处分裂） | upload 409 / create 409 / rename 409，均点名 `CaseTopic` |
| R5-ADJ-RENAME-SELF | **200**（说明 t11 之前 ext4 允许） | **409**（本评审的 finding；见 §二） |

## 四、变异验证：4/4（注入红 / 还原绿 / diff clean）

```bash
cd /home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes
flock /tmp/dpr-pr8-build.lock node test/mutation-probe.mjs --only R5-
# 4/4 通过；EXIT=0
```

| 变异 | 回退的修复 | 抓住它的用例 |
|---|---|---|
| `R5-ino-guard-off` | `ino === 0` 平台守卫失效 | R5-INO（0/1 双侧 ino=0 的用例） |
| `R5-same-entry-off` | 同 inode 不同目录项（hardlink）被放行 | R5-C4-HARDLINK |
| `R5-create-topic-case-off` | create-topic 不再拒大小写变体 | R5-CREATE-CASE |
| `R5-rename-topic-case-off` | renameTopic 不再拒**别的**同级大小写变体 | R5-RENAME-REAL |

- 变异脚本的 `pattern` **故意不选** `R5-ADJ-RENAME-SELF`：那条是 finding，不能靠「把 case 检查整个关掉」让它变绿；
  4 条变异只验证「修复行为本身」。
- `R5-` 前缀无既有变异（不与他任务撞名）；变异前后 `src/host.ts` / `src/library-manage.ts` /
  `dist/{host,library-manage}.js` 哈希一致，`git status` 无本评审留下的 `src/` 改动。
- **t1 的变异没被改废**：`flock … node test/mutation-probe.mjs --only R1-` → **8/8 通过**（EXIT=0）。

## 五、实现方用例是否空转 / 削弱 / 静默跳过？

- 静态扫描无 `.skip` / `.todo` / `assert.ok(true)` / 无条件吞异常。
- 基线真的红：把实现方用例原样复制到基线树跑（跑完删除）→ `# tests 5 / pass 0 / fail 5`。
- 修复树绿：`node --test test/pr8-platform-guards.test.mjs` → `5/5 pass`。
- **但它的 renameTopic 用例把「源自身大小写改名」写成期望 409**（`test/pr8-platform-guards.test.mjs:186-190`），
  即把本评审的 finding 锁进回归网；这不是空转，是**期望值本身错误**（依据了「任务要求跨平台一致拒绝」，
  而队长已澄清授权没有这条）。修复 finding 时该用例的夹具需改成「别的同级对象」的真实碰撞。

## 六、回归

```
node --test test/pr8-layout-collision.test.mjs            # 15/15
node --test test/darkmode-subtopic-features.test.mjs      # 53/53
```

## 七、命令与完整性

```bash
cd /home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes
flock /tmp/dpr-pr8-build.lock -c 'npm run build'                       # exit 0
node --test test/pr8-review-r5.test.mjs                                # 8 pass / 1 fail（fail = finding R5-01）
R5_REPO=/home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-baseline \
  node --test test/pr8-review-r5.test.mjs                              # 4 pass / 6 fail（预期红）
flock /tmp/dpr-pr8-build.lock node test/mutation-probe.mjs --only R5-  # 4/4
flock /tmp/dpr-pr8-build.lock node test/mutation-probe.mjs --only R1-  # 8/8（t1 未被改废）
node --test test/pr8-platform-guards.test.mjs                          # 5/5（基线 0/5）
node --test test/pr8-layout-collision.test.mjs                         # 15/15
node --test test/darkmode-subtopic-features.test.mjs                   # 53/53
```

- 所有实验都在 `mkdtemp` 临时库 + 临时 `DSH_HOME` 中完成；基线树临时复制的用例跑完即删（`git status` 干净）。
- 未跑全量：t11 之后无并行实现改动，但本评审只对 C4/大小写/回归相关套件负责。
