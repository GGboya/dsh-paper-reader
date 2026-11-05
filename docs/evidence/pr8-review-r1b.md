# REV1b 门禁重绑：冻结字节上的 IMP1（B/C/F）结论 + t11/t14 回归专项（t16）

- 不是重做评审：沿用 t4 的自造探针 `test/pr8-review-r1.test.mjs` 与证据 `docs/evidence/pr8-review-r1.md`，
  本次在**全部实现与修复收口后的冻结字节**上重跑、重新绑定 sha256，并专项复核 t11/t14 对
  `src/host.ts` / `src/library-manage.ts` 的后续改动没有回归 B/C/F 任一条。
- 工作树：`.worktrees/pr8-fixes`；基线：`.worktrees/pr8-baseline`（detached @ `fdb45f2`，已 build）
- 本任务只新增本文件；未改 `src/` / `lib/` / 他人测试；未 rebase / push / commit。

## 一、结论：**verdict=pass**

在下列冻结字节上，t4 的 IMP1（B 上传碰撞 / C1–C4 目录-文件互踩 / F boundaryOnly 长度回归）结论
逐条复现（探针 18/18；基线 4 pass / 15 fail 与 t4 相同；`R1-` 变异 8/8），且 t11/t14 的后续改动
没有回归 B/C/F 任一条。

## 二、绑定字节（开工 17:07:23 / 收尾 17:08:22，两次采样**完全一致**）

| 文件 | sha256 |
|---|---|
| `src/host.ts` | `13358a0d7f82f13c933ba8ea9fffb42fcb71899da7665b50c7316c081b3fbb41` |
| `src/library.ts` | `8eacad1bac2879d2a5029f251a4835f292b25aae1d5bfebb66cc7789a6253070` |
| `src/library-manage.ts` | `5eb1e494526d2e09856c83c8614c6c8c2456360fc5fbfc9c4fcf2016bb443665` |
| `dist/host.js` | `48d8787543b3239e0597f88b0d75d2dd1444cd4080241b6efe3c79e720ffd7d8` |
| `dist/library.js` | `e27f39d0ae4406b0a5e35f8ff4e0492d33d909f64cd3e9940fd93eba107ea5ee` |
| `dist/library-manage.js` | `d14fbbf262af7bef346abe781ffd4f403a4873eba5f3dc36438493cc27953925` |

- `flock … npm run build` 后 `dist/{host,library,library-manage}.js` 与采样值一致（tsc 输出确定）。
- `--only R1-` 变异跑完后 `sha256sum -c` 六项全 **OK**（注入/还原干净，工作树冻结）。
- 窗口内 `git status` 只看到实现轮既有的 7 个 `src/`/`lib/` 修改 + `test/mutation-probe.mjs` +
  未跟踪测试/证据文件；**无新的 src 变更**（t7 只新增了未跟踪的 `test/pr8-verification.test.mjs`）。

## 三、重跑：探针与基线对照

```bash
cd /home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes
node --test test/pr8-review-r1.test.mjs                                  # 18 pass / 0 fail
R1_REPO=.worktrees/pr8-baseline node --test test/pr8-review-r1.test.mjs  # 4 pass / 15 fail（+自检）
```

- 修复树 **18/18 绿**，逐条与 t4 相同（B1–B6、C1a/b/c、C2/C3/C4、F1–F4、S1/S2）。
- 基线 **4 pass / 15 fail**，与 t4 形态一致：绿的 4 条是设计上修前也应绿的项
  （`R1-B5` 正常上传回归、`R1-F4` boundaryOnly 安全边界、`R1-S2` 创建/删除对称、`R1-0` 基线自检）；
  其余 15 条为 B/C/F 缺陷红。未出现夹具细节差异。

## 四、t11/t14 回归专项（逐条重跑证据）

t11 改了 `src/host.ts`（create-topic 大小写变体检查）与 `src/library-manage.ts`
（`sameFileForRename` + renamePaper 逐文件预检 + renameTopic 变体检查）；t14 又改了 renameTopic
的 `caseClash` 构造（同父级排除源自身）。以下逐条复核这些改动**没有**回归 t4 的 B/C/F：

| B/C/F 条目 | 覆盖它的探针 | 结果 |
|---|---|---|
| B1 上传撞已存在**子专题** | `R1-B1` | ✅ 409、子专题论文仍可见、快照零改动 |
| B2 上传撞已存在**论文目录** | `R1-B2` | ✅ 409、PDF 逐字节不被覆盖 |
| B3 上传撞同层**旧平铺产物**（.pdf/.txt/.study.json） | `R1-B3` | ✅ 三种后缀各自 409、不建文件夹 |
| B4 上传**仅大小写不同**的目标 | `R1-B4` | ✅ 409 点名磁盘真名；平台分支按 fs-probe；敏感盘不建小写变体 |
| B5/B6 回归与「预检先于消费 body」 | `R1-B5` / `R1-B6` | ✅ 200 落点不变 / 只发 header 也 23ms 内 409 |
| C1a create-topic **祖先段是论文目录** | `R1-C1a` | ✅ 409、零改动 |
| C1b upload 的 topic 落在论文目录 | `R1-C1b` | ✅ 409、不在论文目录内建夹 |
| C1c renameTopic 目标父级是论文目录 | `R1-C1c` | ✅ 409、源子树原地（t14 改了 caseClash 构造，祖先检查仍先生效） |
| C2 create-topic 撞同层旧平铺论文 | `R1-C2` | ✅ 409、旧论文仍可见、delete-plan 200（t11 新增的大小写检查**与它并存**：见下行） |
| C2′ t11 新增的 create-topic 大小写变体检查 | `R5-CREATE-CASE`（我的 R5 探针） | ✅ 409 点名真名、精确同名仍幂等 200 |
| C3 renameLegacyPaper 目标名已是目录 | `R1-C3` | ✅ 409 target-exists、平铺源未被改名 |
| C4 renamePaper 目标目录内同名残留文件 | `R1-C4` | ✅ 409、内容未被覆盖、零改动 |
| C4′ t11 的 `sameFileForRename`（替换裸 ino 比较） | `R5-C4-REAL` / `R5-C4-HARDLINK` / `R5-C4-CASEONLY` | ✅ 真实残留 409；hardlink（同 inode 不同目录项）仍 409；合法大小写-only **论文**改名仍 200 |
| C4″ t14 的 renameTopic 排除自身 | `R5-RENAME-REAL` / `R5-ADJ-RENAME-SELF` / `R5-ADV-*` | ✅ 真实同级变体仍 409 点名真名；self-case 200；双变体/跨父级/目标另一项/前缀近名四条边界全绿 |
| F1 110 字 legacy 专题**可删**（创建侧仍 400） | `R1-F1` | ✅ delete 200 且目录消失；create 400 |
| F2 110 字 legacy 作为 **rename-from** | `R1-F2` | ✅ 200、目标目录出现、旧目录消失 |
| F3 221 字 legacy 路径可删（创建仍 400） | `R1-F3` | ✅ 200 / 400 |
| F4 boundaryOnly 安全边界不被放宽 | `R1-F4` | ✅ `..` / 编码变形 / `.trash` 一律 400 |

专项补充运行（只读执行我的 R5 探针中与 t11/t14 改动直接相关的 10 例）：

```
node --test --test-name-pattern="R5-(C4-REAL|C4-HARDLINK|C4-CASEONLY|CREATE-CASE|RENAME-REAL|ADJ-RENAME-SELF|ADV-)" \
  test/pr8-review-r5.test.mjs
# tests 10 / pass 10 / fail 0
```

结论：t11/t14 的改动是**叠加**而非替换——B 的 4 类碰撞、C1 祖先/父级、C2 平铺、C3 目录、C4 逐文件预检
全部保持；t11 新增的 ino 守卫与大小写变体检查、t14 的「排除源自身」都只作用于各自的新边界，
没有回退 B/C/F 的任何既有断言。

## 五、变异验证（R1- 8/8，跑后字节未变）

```bash
flock /tmp/dpr-pr8-build.lock node test/mutation-probe.mjs --only R1-
```

```
OK R1-quarantine-aborts-library / R1-upload-target-collision-off / R1-upload-flat-collision-off
OK R1-create-topic-flat-off / R1-rename-inner-clash-off / R1-boundary-length-off
OK R1-silent-skip / R1-false-success-marker（后三条为既有 migrate 域变异，非 REV1 对象）
# 变异验证：8/8 通过   （EXIT=0；每条 注入=1 还原=0 diff=clean）
```

- 跑后六文件 sha256 与 §二 绑定值全部一致（`sha256sum -c` 全 OK）⇒ t11/t14 没有把任一 R1 变异锚点改废，
  脚本自己的还原也干净。

## 六、回归

```
node --test test/pr8-layout-collision.test.mjs        # 15/15（t1 的 B/C/F 实现方套件）
node --test test/darkmode-subtopic-features.test.mjs  # 53/53
```

## 七、与 t4 的差异

**无行为差异**：18 条探针逐条复现、基线形态相同、R1 变异 8/8 且锚点未漂移。新增信息仅是
§二 的冻结字节绑定与 §四 的 t11/t14 专项复核（t4 时这两个后续改动尚不存在）。

## 八、命令清单

```bash
cd /home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes
flock /tmp/dpr-pr8-build.lock -c 'npm run build'                       # exit 0；dist 哈希与采样一致
node --test test/pr8-review-r1.test.mjs                                # 18/18
R1_REPO=.worktrees/pr8-baseline node --test test/pr8-review-r1.test.mjs # 4 pass / 15 fail（预期红）
flock /tmp/dpr-pr8-build.lock node test/mutation-probe.mjs --only R1-  # 8/8
node --test test/pr8-layout-collision.test.mjs                         # 15/15
node --test test/darkmode-subtopic-features.test.mjs                   # 53/53
```
