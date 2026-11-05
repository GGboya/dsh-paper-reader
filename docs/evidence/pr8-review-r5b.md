# IMP5（t14 修 R5-01）—— REV5 第二轮复审（t15）

- 评审对象：t14 对 `R5-01`（renameTopic 把「源自身」的大小写-only 改名误判 409，Linux 能力回退）的修复。
- 工作树：`.worktrees/pr8-fixes`（`feat/darkmode-subtopic`，HEAD `fdb45f2` + 全部未提交修复；t11→t14 已收口）
- 基线：`.worktrees/pr8-baseline`（detached @ `fdb45f2`，已 build）
- 本评审改动：只改我自己的 `test/pr8-review-r5.test.mjs`（+4 条 round-2 对抗用例、self-case 按平台分支）与本文件；
  `test/mutation-probe.mjs` 只做了**一条自有变异的锚点维护**（见 §四，语义不变）。**未改 `src/`、`lib/`、
  他人 `test/pr8-*.test.mjs`；未 commit / push / rebase。**
- 绑定字节（t15 开始与收尾 16:53:23 采样一致）：

| 文件 | sha256 |
|---|---|
| `src/library-manage.ts`（t14 后） | `5eb1e494526d2e09856c83c8614c6c8c2456360fc5fbfc9c4fcf2016bb443665` |
| `src/host.ts`（t11 后未变） | `13358a0d7f82f13c933ba8ea9fffb42fcb71899da7665b50c7316c081b3fbb41` |
| `src/library.ts` | `8eacad1bac2879d2a5029f251a4835f292b25aae1d5bfebb66cc7789a6253070` |
| `dist/library-manage.js` | `d14fbbf262af7bef346abe781ffd4f403a4873eba5f3dc36438493cc27953925` |
| `dist/host.js` | `48d8787543b3239e0597f88b0d75d2dd1444cd4080241b6efe3c79e720ffd7d8` |

## 一、结论：**verdict=pass**

R5-01 已按要求收口：同父级 self case-only 改名恢复 200（ext4），且**没有放松**对「别的同级对象」的
大小写变体 409；create-topic / upload / C4 守卫均未回退。新增 4 条 round-2 对抗用例验证「排除自身」
只排自身（精确名 / 同一 realpath），不按前缀、不跨父级扩大豁免。

## 二、修复实现复核（代码级）

t14 在 `renameTopic`（`src/library-manage.ts`）里：

```ts
const sourceParentRel = topic.includes('/') ? topic.slice(0, topic.lastIndexOf('/')) : ''
const sameParent = parentRel === sourceParentRel
const selfName = basename(dir)                  // dir 是 resolveExistingTopicDir 的真实路径
const caseClash = sameParent
  ? caseVariantCollisions(parentAbs, newSegs[newSegs.length - 1]!).filter((entry) => {
      if (entry === selfName) return false       // 精确名：它就是源目录项
      try { return realpathSync(join(parentAbs, entry)) !== realpathSync(dir) } // 别名形态兜底
      catch { return true }                      // 解析不了 ⇒ 保守保留
    })
  : caseVariantCollisions(parentAbs, newSegs[newSegs.length - 1]!)
```

- **只看同一父级**：`sameParent` 由规范化后的 `topic` 前缀字符串比较得出；跨父级完全不走豁免。
- **只排自身**：先按磁盘真名（`basename(dir)`）精确相等，再用 realpath 指向同一目录项兜底；
  **没有**用 `startsWith`/前缀，也没有按大小写折叠排除整个集合。
- **不改其它路径**：`sameFileForRename` 与 t11 逐字相同（`ino/dev=0` 一律冲突、`sameEntry=false` 冲突）；
  `create-topic` 的变体检查未动（`src/host.ts` 的 sha256 仍是 t11 后的 `13358a0d…`）。
- 不敏感盘：self-case 改名仍 409（既有平台限制，t14 明确不做两步 rename；见 §五）。

## 三、行为重跑（我方自造探针，13 例）

```bash
cd /home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes
flock /tmp/dpr-pr8-build.lock -c 'npm run build'
node --test test/pr8-review-r5.test.mjs            # 13 pass / 0 fail
R5_REPO=.worktrees/pr8-baseline node --test test/pr8-review-r5.test.mjs   # 5 pass / 9 fail（预期红）
```

修复树 13/13 绿，关键结果：

```
R5-ADJ-RENAME-SELF   self case-only rename => 200（Alpha/CaseTopic → Alpha/casetopic，目录真的换大小写）
R5-RENAME-REAL       Other→CaseTopic（同级有 casetopic） => 409 conflicts:["casetopic"]
R5-CREATE-CASE       create casetopic（同级有 CaseTopic） => 409 conflicts:["CaseTopic"]；精确同名仍 200
R5-CROSS-PARENT      Alpha/CaseTopic → Alpha/Sub/casetopic => 200
R5-CONSISTENCY       upload=409 / create=409 / rename=409（三处均点名 CaseTopic）
R5-C4-REAL / HARDLINK / CASEONLY 与 R5-INO 假 stat 矩阵 = 与 t12 相同（全绿）
```

round-2 新增的 4 条对抗用例（专测「排除自身」的边界）：

| 用例 | 构造 | 修复后 | 基线 |
|---|---|---|---|
| `R5-ADV-DOUBLE-VARIANT` | 同父级同时有源 `CaseTopic` 与另一个变体 `CASETOPIC`；改名成第三个拼写 `casetopic` | **409** `conflicts:["CASETOPIC"]`（点名的是别人，不是自己） | 200（红） |
| `R5-ADV-CROSS-PARENT-VARIANT` | 源 `A/CaseTopic`，目标父级 B 里已有 `B/CaseTopic`；移动到 `B/casetopic` | **409** `conflicts:["CaseTopic"]`（跨父级不豁免） | 200（红） |
| `R5-ADV-TARGET-IS-OTHER-ENTRY` | 源 `Alpha/CaseTopic` 与已存在的 `Alpha/casetopic` 是**两个不同目录项**；改名成 `casetopic` | **409**「已存在同名专题」；快照零改动，两个目录都还在（不静默合并） | 409（绿，既有 existsSync 拦住） |
| `R5-ADV-NOT-PREFIX` | 源 `Alpha/Move` + 前缀近名 `Alpha/MoveBar`；改名成 `movebar` | **409** `conflicts:["MoveBar"]`（排除自身只能精确名/同一目录项，不能按前缀） | 200（红） |

基线对照：**5 pass / 9 fail**。5 条绿是「基线本就该绿」的项（C4 的合法大小写论文改名、跨父级移动、
self-case 改名 200、target-is-other-entry 的 existsSync 拦截、基线自检）；9 条红覆盖 C4 静默覆盖、
create-topic 假成功、真实变体 409 缺失、三处口径分裂、双变体/跨父级/前缀边界。

## 四、变异验证（4/4；一条自有变异的锚点维护）

t14 改了 `renameTopic` 里 caseClash 的构造，导致我 t12 建的 `R5-rename-topic-case-off` 原锚点
（`const caseClash = caseVariantCollisions(parentAbs, …)`）不再存在。**该变异是我自己的、语义不变**，
只把锚点移到该检查的**唯一出口** `if (caseClash.length > 0) {`（`&& false` 注入 = 让 renameTopic 不再拒真实变体）；
id / file / pattern / why 均未改。如实记录：这是锚点维护，不是语义调整。

```bash
flock /tmp/dpr-pr8-build.lock node test/mutation-probe.mjs --only R5-
```

```
OK R5-ino-guard-off / R5-same-entry-off / R5-create-topic-case-off / R5-rename-topic-case-off
# 变异验证：4/4 通过 （EXIT=0；每条 注入=1 还原=0 diff=clean）
```

- 跑后 `src/library-manage.ts`、`src/host.ts`、`dist/library-manage.js`、`dist/host.js` 的 sha256 = §绑定表（`sha256sum -c` OK）。
- **t1 的变异没被改废**：`--only R1-` → **8/8 通过**（t14 没有触碰 R1 的锚点；跑后哈希一致）。

## 五、平台边界（如实登记，不阻塞）

- 大小写**不敏感**盘（APFS/NTFS）上 self-case 改名仍 **409**：目标路径 resolve 到同一目录，
  `existsSync(target)` 在改名之前就拒；t14 明确保留该平台限制（不做两步 rename）。
  维护者把「大小写改名在 macOS/Windows 被拒」列在「其它（不阻塞，记录在案）」，属已知债——
  本轮修的是「不要把它扩张到 ext4」，**没有**承诺在 mac/win 放开。
- 我的 `R5-ADJ-RENAME-SELF` 用例据此按 `fs-probe` 实测分支：敏感盘断言 200 + 真改名；
  不敏感盘断言 409（既有平台限制）。本机（ext4）走敏感分支。
- `R5-ADV-DOUBLE-VARIANT` / `R5-ADV-NOT-PREFIX` 在不敏感盘上无法构造「两个并存的近名目录」，
  用例里以平台事实显式 return（写明原因），不是静默跳过。

## 六、回归

```
node --test test/pr8-layout-collision.test.mjs        # 15/15（t1 的 B/C/F 无回退）
node --test test/darkmode-subtopic-features.test.mjs  # 53/53
node --test test/pr8-platform-guards.test.mjs         # 7/7（t14 自己的套件）
```

## 七、命令清单

```bash
cd /home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes
flock /tmp/dpr-pr8-build.lock -c 'npm run build'                       # exit 0
node --test test/pr8-review-r5.test.mjs                                # 13/13
R5_REPO=.worktrees/pr8-baseline node --test test/pr8-review-r5.test.mjs # 5 pass / 9 fail（预期红）
flock /tmp/dpr-pr8-build.lock node test/mutation-probe.mjs --only R5-  # 4/4
flock /tmp/dpr-pr8-build.lock node test/mutation-probe.mjs --only R1-  # 8/8
node --test test/pr8-layout-collision.test.mjs                         # 15/15
node --test test/darkmode-subtopic-features.test.mjs                   # 53/53
node --test test/pr8-platform-guards.test.mjs                          # 7/7
```

所有实验均 `mkdtemp` + 临时 `DSH_HOME`；基线树未留临时文件。
