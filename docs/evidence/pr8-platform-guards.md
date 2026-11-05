# PR #8 REV1 两条低危（L3/L1）升级修复 —— 平台边缘守卫

对应 `docs/evidence/pr8-review-r1.md` §六「低危观察」：

- **③ C4 的 same-inode 例外未加 `ino === 0` 平台守卫**（`src/library-manage.ts`）：exFAT/FAT/部分 SMB
  上 `stat().ino` 恒为 0 ⇒ 任何已存在的目标文件都被判「同一文件」⇒ C4 冲突预检被绕过 ⇒
  `renameSync` 静默覆盖（维护者必修 C4 换块盘就复活）。
- **① create-topic / renameTopic 没有「仅大小写不同」碰撞检查**（`src/host.ts`）：ext4 上并存
  `CaseTopic`+`casetopic`；APFS/NTFS 上返回 **200** 但其实是既有目录别名（假成功），与 upload 的 B4
  严格性不一致。

- 修复工作树：`.worktrees/pr8-fixes`（`feat/darkmode-subtopic`，含 t1/t2/t3/t9 未提交修复）
- 基线对照：`.worktrees/pr8-baseline`（detached @ `fdb45f2`，已 build）
- 新增用例：`test/pr8-platform-guards.test.mjs`（7 条；其中 3 条是修复轮 2 针对 R5-01 的 self-case /
  真实同级变体 / 跨父级用例）
- 本任务只改：`src/host.ts`、`src/library-manage.ts`、新增测试与本文档
  （`src/migrate.ts` / `src/library.ts` / `lib/client.js` / `src/scope.ts` 等 out-of-scope 文件未动；
  t1 的 B/C/F 与 t3 的 D/E 改动原样保留）

## 0. 复现命令（红/绿统一口径）

```bash
# 红：把新用例复制到基线树（fdb45f2 已 build 的 dist）跑
cp .worktrees/pr8-fixes/test/pr8-platform-guards.test.mjs .worktrees/pr8-baseline/test/
cd .worktrees/pr8-baseline && node --test test/pr8-platform-guards.test.mjs

# 绿：修复树加锁 build（测试 import dist/），再跑
cd .worktrees/pr8-fixes && flock /tmp/dpr-pr8-build.lock -c 'npm run build'
cd .worktrees/pr8-fixes && node --test test/pr8-platform-guards.test.mjs
```

**基线：`# tests 5 / pass 0 / fail 5`；修复后：`# tests 5 / pass 5 / fail 0`。**

| 用例 | 基线（红） | 修复后（绿） | 落点 |
|---|---|---|---|
| C4-ino 纯函数（假 stat 矩阵） | `sameFileForRename` 不存在（`undefined`） | 6 组矩阵全部符合预期 | `src/library-manage.ts:1101` |
| C4 接线（结构断言） | 找不到 C4 逐文件预检（fdb45f2 上根本没有这层预检） | 预检调用纯函数 + realpath 同目录项，无裸比 ino | `src/library-manage.ts:1144-1156` |
| C4 行为（hardlink 现场） | rename **200**，`New/` 里留下孤儿 `Old.txt` | 409 `target-exists`，零改动 | `src/library-manage.ts:1153-1154` |
| create-topic 大小写变体 | **200** 并建出 `CaseTopic`+`casetopic` 两个目录 | 409，`conflicts:['CaseTopic']`，盘上只有一个真名 | `src/host.ts:611-615` |
| renameTopic 真实同级变体 | **200**（ext4 静默改大小写；不敏感盘上 409 但文案不是真名） | 409，`conflicts:['casetopic']`，零改动 | `src/library-manage.ts:1302-1322` |
| renameTopic 同父级 self case-only（R5-01） | 基线 200（t11 误判成 409，属能力回退） | **200** 且磁盘目录真的换大小写 | `src/library-manage.ts:1302-1322` |

## 1. C4 平台守卫：`ino === 0`（exFAT/FAT/网络盘）绝不判「同一文件」

### 1.1 纯函数（acceptance 指定的假 stat 矩阵）

`sameFileForRename(src, dst, sameEntry = true)`（`src/library-manage.ts:1101`，导出可单测）：

```ts
if (!sameEntry) return false
if (src.ino === 0 || dst.ino === 0) return false   // ← 平台守卫（exFAT/FAT/部分 SMB ino 恒 0）
if (src.dev === 0 || dst.dev === 0) return false   // ← dev=0 一并守卫
return src.ino === dst.ino && src.dev === dst.dev
```

用假 stat 实测（不依赖真实 exFAT）：

```
sameFileForRename 0/0 = false | 0/123 = false | 123/123 sameEntry=true = true
| 123/123 sameEntry=false = false | 123/456 = false | dev0 = false
```

覆盖 acceptance 四组（0/0、0/123、123/123 同路径、123/456）+ 反向 123/0 + `sameEntry=false`
（同 inode 不同目录项）+ `dev=0`。**语义方向保守**：任一侧 ino/dev 为 0 或不是同一目录项 ⇒ 冲突
（宁可误报让用户手动处理，绝不误放行覆盖）。

### 1.2 接线：预检必须走纯函数，不许再裸比 ino

`renamePaper` 逐文件预检（`src/library-manage.ts:1144-1156`）：

```ts
const srcStat = lstatSync(srcAbs)
let sameEntry = false
try { sameEntry = realpathSync(srcAbs) === realpathSync(dstAbs) } catch { /* 保守判冲突 */ }
sameFile = sameFileForRename(srcStat, targetStat, sameEntry)
if (!sameFile) innerClash.push(toName)
```

结构断言用例直接读源码核对这三点（`sameFileForRename(...)` 调用、`realpathSync` 同目录项、
**不得出现** `targetStat.ino === srcStat.ino` 裸比较）。基线上这层预检根本不存在 ⇒ 结构断言红。

`sameEntry` 这个额外条件不是放宽而是收紧：同 inode 但不同目录项（hardlink / 平台别名）也必须冲突，
否则「同 inode 例外」在别名的掩护下仍会替换用户的目录项。

### 1.3 行为红/绿（ext4 可运行时复现的部分）

REV1 §六.3 已如实记录：**ext4 造不出 `ino === 0`**，该平台缺口是按代码路径 + 仓库既有约定
（`src/migrate.ts` 的 `isDirectRun` 同一写法）判定的。为了不只停留在「读代码」，本任务用
**hardlink 现场**复现同一根因（同 inode 被误当同一文件）：

```
# 夹具：T/Old/Old.txt 与 T/Old/New.txt 是同一 inode 的两个不同目录项
基线：M.renamePaper(data,'T','Old','New')
  => OK {"ok":true,"moved":["New.txt","New.pdf"],"from":"Old","to":"New"}
  盘上：New/ = ['New.pdf','New.txt','Old.txt']   ← 改名成功，但留下旧名的孤儿（POSIX 对同 inode 的
                                                rename 是 no-op，两段式第二步实际没搬走 Old.txt）
修复后：throw ManageError('target-exists', '目标目录内已存在同名文件：New.txt（改名会覆盖它，已拒绝）')
  盘上：T/Old 原封不动（Old.pdf / Old.txt / New.txt 三者都在，New.txt 与 Old.txt 仍同 inode）
```

用例另外断言「清掉别名后正常改名仍成功」（`New/New.pdf`+`New/New.txt`、`Old/` 消失），
证明两段式/回滚语义没有被这次守卫回退。

> 平台结论：exFAT 上 `ino` 恒 0 时，`sameFileForRename` 第一道守卫直接判冲突 ⇒ 预检不可能被绕过；
> 这条由 1.1 的假 stat 矩阵 + 1.2 的接线断言共同证明，不依赖一块真实 exFAT 盘。

## 2. create-topic / renameTopic：仅大小写不同的同级对象 → 409 且点名磁盘真名

复用 `library.ts:197` 的 `caseVariantCollisions`（与 upload B4 同一口径，不另写一套比较逻辑）。

### 2.1 create-topic（`src/host.ts:611-615`）

在 mkdir 之前、C2 平铺冲突检查之后：

```ts
const caseClash = caseVariantCollisions(join(root, ...parentSegs), leaf)
if (caseClash.length > 0) throw new ManageError('target-exists', 409,
  `同层已有仅大小写不同的同名对象：${caseClash.join('、')}（大小写不敏感的文件系统上会互相吞掉）`,
  { conflicts: caseClash })
```

基线（红，ext4）：`Alpha/CaseTopic` 已存在时 `POST topic {name:'Alpha/casetopic'}` →

```
200 {"ok":true,"topic":"Alpha/casetopic"}
盘上 Alpha/ = ['CaseTopic','casetopic']          ← 两个近同名专题并存
```

修复后（绿）：

```json
409 {"error":"同层已有仅大小写不同的同名对象：CaseTopic（大小写不敏感的文件系统上会互相吞掉）","code":"target-exists","conflicts":["CaseTopic"]}
盘上 Alpha/ = ['CaseTopic']                        ← 没有第二个变体
```

- 大小写**不敏感**盘的平台分支：断言 `realpath(Alpha/casetopic) === realpath(Alpha/CaseTopic)`
  （两个拼写本来就是同一目录别名——旧实现的 200 是假成功）；分支由 `test/fs-probe.mjs` 的
  `caseInsensitiveFs()` 实测决定，不硬编码平台名、不 skip。
- 回归断言：**精确同名**（`Alpha/CaseTopic`）仍幂等 200 —— 不能把「重复创建」误判成冲突。

### 2.2 renameTopic（真实同级变体 409；self case-only 豁免 —— R5-01）

**规则**：在目标父级解析之后、`existsSync(target)` 之前检查同级变体；但**仅当目标父级 == 源目录父级**时，
把「与源条目自身指向同一目录项」的那一条从候选清单里剔除（用磁盘真名 `basename(dir)` 精确相等 +
`realpath` 同一目录项兜底；不做前缀匹配）。理由：同父级把 `CaseTopic` 改成 `casetopic` 改的是
**同一个目录项**，没有真实碰撞；把它算成 409 会把维护者记录为已知债的「mac/win 大小写改名被拒」
扩大到 ext4，属无收益的能力回退（t12 评审 R5-01）。

```ts
const sourceParentRel = topic.includes('/') ? topic.slice(0, topic.lastIndexOf('/')) : ''
const sameParent = parentRel === sourceParentRel
const selfName = basename(dir)
const caseClash = sameParent
  ? caseVariantCollisions(parentAbs, newSegs[newSegs.length - 1]!).filter((entry) => {
      if (entry === selfName) return false
      try { return realpathSync(join(parentAbs, entry)) !== realpathSync(dir) } catch { return true }
    })
  : caseVariantCollisions(parentAbs, newSegs[newSegs.length - 1]!)
if (caseClash.length > 0) throw new ManageError('target-exists', 409, ...)   // conflicts: caseClash
```

**修前（t11 实现，红）**——self-case 被误判成 409，且 `conflicts` 点名的就是源目录自己：

```json
409 {"error":"已存在仅大小写不同的同名专题：CaseTopic（…）","code":"target-exists","conflicts":["CaseTopic"]}
盘上仍是 CaseTopic（目录没改名）
```

（基线 `fdb45f2` 对该操作是 200 —— 这正是「能力回退」的判据。）

**修后（绿）**：

```
self-case  CaseTopic → casetopic        => 200 {"ok":true,"from":"CaseTopic","to":"casetopic",...}
盘上：['casetopic']                     ← 目录名真的换了大小写
真实碰撞  Other → CaseTopic（同级有 casetopic） => 409 {"conflicts":["casetopic"],"error":"…：casetopic…"}
盘上：['Other','casetopic']             ← 零改动，点名的是**别的**同级对象
跨父级    A/Move → B/Move               => 200，B/Move 出现、A/Move 消失
```

- **不敏感盘（APFS/NTFS）**：`existsSync(target)` 仍会命中同一目录的别名 ⇒ **保持 409**（维护者记录的
  已知限制；本轮不引入两步 rename 绕解）。用例按 `fs-probe` 实测分支断言该平台事实，不硬编码、
  不 skip。
- 真实同级变体（源是别的目录）在任何平台仍 409 且点名磁盘真名——self 豁免不会吞掉真实碰撞。
- 跨父级移动不做自身豁免：目标父级下若真有变体照旧 409；普通移动 200（有回归断言）。

## 3. 回归与全量

```bash
cd /home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes
flock /tmp/dpr-pr8-build.lock -c 'npm run build'          # exit 0
node --test test/pr8-platform-guards.test.mjs             # 7 tests / 7 pass / 0 fail（R5-01 修复后）
node --test test/pr8-review-r5.test.mjs                   # 9 tests / 9 pass / 0 fail（评审的 R5-01 用例转绿）
node --test test/pr8-layout-collision.test.mjs            # 15 tests / 15 pass / 0 fail（t1 的 B/C/F 无回退）
node --test test/darkmode-subtopic-features.test.mjs      # 53 tests / 53 pass / 0 fail
node --test "test/*.test.mjs"                             # 648 tests / 621 pass / 0 fail / 27 skip
```

（全量 648 条包含本轮其他并行任务新增的 `test/pr8-*.test.mjs`；本任务用例 7 条：t11 的 C4 三件套 +
create-topic 变体 + renameTopic self/真实碰撞/跨父级三组。）

## 4. 取舍与边界（如实记录）

1. **`sameEntry`（realpath 相同）是比 acceptance 字面更紧的条件**：同 inode 但不同路径（hardlink/
   平台别名）也判冲突。这正是 ext4 上可运行时复现的「同 inode 例外过宽」根因；方向保守，符合
   「宁可误报冲突，绝不误放行覆盖」。
2. **exFAT 上 `ino=0` 的端到端复现不可能在 ext4 完成**（REV1 §六.3 已记录同一事实）。本任务用
   「纯函数假 stat 矩阵 + 源码接线断言 + hardlink 同根因行为」三件套证明，不声称在 exFAT 上跑过。
3. **create-topic 的变体检查复用 `caseVariantCollisions` 的完整目标集**（`<name>` 与 `<name><产物后缀>`）：
   因此「同层有仅大小写不同的 `Foo.pdf` 时建 `foo` 主题」也会 409。这比「只比目录名」更保守，
   是与 upload B4 保持同一口径的代价；精确同名/正常不同名的创建不受影响（有回归断言）。
4. **renameTopic 的 self case-only 在敏感盘上放行（200，真的换大小写）；不敏感盘维持 409**
   （维护者记录的已知限制，本轮不做两步 rename 绕解）。真实同级变体（源是别的目录）仍然三平台
   409 且点名磁盘真名；跨父级移动不受自身豁免影响。这样既修掉 t11 引入的 Linux 能力回退，
   也保留「upload / create-topic / renameTopic 对真实变体口径一致」的不变量。
5. 没有回退任何既有行为：`renamePaper` 两段式/回滚、C1 论文目录父级拦截、F 的 boundaryOnly 放宽、
   upload 的 4 类预检均未改动；`src/migrate.ts`、`src/library.ts`、`lib/client.js`、`src/scope.ts` 未触碰。
6. 新增的 `sameFileForRename` 是导出纯函数（无 fs 调用），单测不需要临时库；行为用例仍全部 `mkdtemp`。
