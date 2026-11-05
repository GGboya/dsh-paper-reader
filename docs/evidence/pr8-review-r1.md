# PR #8 必修 B / C / F —— REV1 独立对抗评审（t4，评审对象 IMP1/t1）

- 评审对象：IMP1（t1）对 `docs/pr8-maintainer-review.md` 必修 **B（上传碰撞）**、**C1–C4（目录/文件互踩）**、
  **F（boundaryOnly 长度回归）** 的修复。
- 修复工作树：`.worktrees/pr8-fixes`（`feat/darkmode-subtopic`，HEAD `fdb45f2` + 未提交修复）
- 基线工作树：`.worktrees/pr8-baseline`（detached @ `fdb45f2`，已 build）
- 本评审只新增/改动三样，均在 t4 inScope：`test/pr8-review-r1.test.mjs`（新，18 例）、
  `test/mutation-probe.mjs`（+5 条 `R1-` 变异；另按队长授权修了 1 条**既有**失锚变异）、本文件。
  **未改 `src/`、`lib/`、实现方 `test/pr8-*.test.mjs`；未 commit / push / rebase。**
- **独立性**（profile 硬规则）：本探针不 import 实现方 `test/pr8-layout-collision.test.mjs`，夹具/库名/断言全部重造；
  同一份探针用 `R1_REPO=<baseline>` 直接跑基线 ⇒ 基线红是本探针自己跑出来的，不是引用 t1 自述。
  全部夹具走 `mkdtemp` + 临时 `DSH_HOME`，绝不碰真实文献库。

## 一、结论（verdict: pass，无 blocker/medium）

| 评审条目 | 独立证据（基线红 → 修复绿） | 判定 |
|---|---|---|
| B 上传撞已存在**子专题** | R1-B1：基线 200（子专题被变成论文目录，其下论文从列表/树消失）→ 修复 409 | ✅ |
| B 上传撞已存在**论文目录** | R1-B2：基线 200 且 PDF 被覆盖 → 修复 409、内容逐字节原样 | ✅ |
| B 上传撞同层**旧平铺产物** | R1-B3：`.pdf/.txt/.study.json` 三种各自独立库，基线 200 → 修复 409、不建文件夹 | ✅ |
| B **仅大小写不同**的目标 | R1-B4：基线 200（敏感盘上建出小写变体）→ 修复 409 且点名磁盘真名；平台事实分支实跑 | ✅ |
| B 碰撞预检**不消费请求体** | R1-B6：基线只发 header 时 1.5s 无响应（在等 body）→ 修复 23ms 内 409 | ✅ |
| C1 **论文目录不能当专题父**（create-topic / upload / rename-topic 三处） | R1-C1a/C1b/C1c：基线 200（子树消失）→ 修复 409、库快照零改动 | ✅ |
| C2 create-topic 与**同层旧平铺论文**同名 | R1-C2：基线 200 后列表空、delete-plan 404 → 修复 409、旧论文仍可见 | ✅ |
| C3 renameLegacyPaper 撞**同名目录** | R1-C3：基线 200 把平铺文件改成会被遮蔽的名字 → 修复 409 target-exists | ✅ |
| C4 新布局 renamePaper **目标内同名残留** | R1-C4：基线 200 且残留内容被覆盖（`moved:["NewName.txt",…]`）→ 修复 409、零改动；清残留后重试 200 | ✅ |
| F 110 字 legacy 专题**可删** | R1-F1：基线 400 → 修复 200 且目录真的消失；创建侧仍 400 | ✅ |
| F 110 字 legacy 专题**可改名** | R1-F2：基线 400 → 修复 200 | ✅ |
| F 221 字（>MAX_TOPIC_PATH）legacy 路径可删 | R1-F3：基线 400 → 修复 200；同名创建仍 400 | ✅ |
| F 安全边界**不得**被 boundaryOnly 放宽 | R1-F4（`..` / 编码变形 / `.trash` 保留名）基线修后均 400（不是红线放松） | ✅ |
| B5 回归：干净名字上传 | 基线/修复都 200、落点 `<topic>/<stem>/<name>.pdf`（防「一律拒上传」） | ✅ |

**无 blocker / medium。** 5 条低危观察见 §八（不阻塞集成，建议随最终提交顺手处理或转后续任务）。

## 二、自造探针与红/绿对照（唯一操作口径）

```bash
cd /home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes
flock /tmp/dpr-pr8-build.lock -c 'npm run build'          # 测试 import dist/
node --test test/pr8-review-r1.test.mjs                    # 修复树：18 tests / 18 pass / 0 fail

# 基线对照（同一份探针，R1_REPO 指到基线 dist）
R1_REPO=/home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-baseline \
  node --test test/pr8-review-r1.test.mjs                  # 基线：19 tests / 4 pass / 15 fail
```

基线 15 条红、4 条绿（`R1-B5` 回归、`R1-F4` 安全边界、`R1-S2` 创建/删除对称、`R1-0` 基线模式自检——
这四条设计上修前就应绿，说明探针不是「全红噪声」）。修复后 18/18 绿。

```
# 基线（fdb45f2）关键输出（每条用例的第一处失败）
not ok 1  R1-B1  上传到同名子专题必须 409…：{"ok":true,"topic":"Alpha","name":"Sub","bytes":200}
not ok 2  R1-B2  上传到已存在论文目录必须 409…：{"ok":true,"topic":"Alpha","name":"Paper","bytes":200}
not ok 3  R1-B3  同层已有 Flat.pdf 时必须 409…：{"ok":true,"topic":"Alpha","name":"Flat","bytes":200}
not ok 4  R1-B4  仅大小写不同的同名论文目录必须 409…：{"ok":true,"topic":"Alpha","name":"caseretained","bytes":200}
ok     5  R1-B5  （回归，基线本就绿）
not ok 6  R1-B6  只发 header 时也必须立刻 409…实际 {"status":null,"elapsedMs":1503}
not ok 7  R1-C1a 祖先段 Alpha/Paper 是论文目录，建专题必须 409：{"ok":true,"topic":"Alpha/Paper/NewTopic"}
not ok 8  R1-C1b topic=Alpha/Paper 是论文目录，上传必须 409：{"ok":true,"topic":"Alpha/Paper","name":"Intruder","bytes":200}
not ok 9  R1-C1c 目标父级 Alpha/Paper 是论文目录，改名必须 409：{"ok":true,"moved":[],"to":"Alpha/Paper/Gamma",…}
not ok 10 R1-C2  同层已有旧平铺论文 Legacy.pdf，建同名目录必须 409：{"ok":true,"topic":"Alpha/Legacy"}
not ok 11 R1-C3  目标已存在目录 Alpha/targetdir，平铺改名必须 409：{"ok":true,"moved":["targetdir.txt","targetdir.pdf"],…}
not ok 12 R1-C4  目标目录内已有 NewName.txt，必须 409…：{"ok":true,"moved":["NewName.txt","NewName.pdf"],…}  200 !== 409
not ok 13 R1-F1  110 字 legacy 专题必须能删…：{"error":"名字过长（每层最多 100 个字符）","code":"bad-name"}  400 !== 200
not ok 14 R1-F2  110 字 legacy 专题必须能改名…：{"error":"名字过长（每层最多 100 个字符）"}  400 !== 200
not ok 15 R1-F3  boundaryOnly 下已存在超长 legacy 路径必须可删…：{"error":"名字过长（专题路径最多 200 个字符）"}  400 !== 200
ok     16 R1-F4  （安全边界：修前修后都必须 400）
not ok 17 R1-S1 目标论文路径是符号链接时必须拒绝：{"ok":true,"topic":"Alpha","name":"SymLink","bytes":200}
ok     18 R1-S2  （前导点论文名 upload 后可按名删：修前修后都必须绿）
ok     19 R1-0   （基线模式自检）
# tests 19 / # pass 4 / # fail 15
```

修复后（`18/18`）：

```
ok 1 R1-B1 … ok 4 R1-B4   ok 5 R1-B5   ok 6 R1-B6
ok 7 R1-C1a  ok 8 R1-C1b  ok 9 R1-C1c  ok 10 R1-C2  ok 11 R1-C3  ok 12 R1-C4
ok 13 R1-F1  ok 14 R1-F2  ok 15 R1-F3  ok 16 R1-F4
ok 17 R1-S1  ok 18 R1-S2
# tests 18 / # pass 18 / # fail 0
```

每条断言都同时核对**状态码 + 机器码 + 全库快照（相对路径→文件内容）+ 列表/树视图**，
不是只看一个状态码：例如 C1c 还断言源子树 `Gamma/Child/Inside/Inside.pdf` 原地未动、`Alpha/Paper/Gamma` 不存在；
C4 还断言 `.trash` 未出现、清掉残留后同名改名能 200（防「一律拒绝」式假修复）。

## 三、变异验证：8/8（注入红 / 还原绿 / diff clean）

```bash
cd /home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes
flock /tmp/dpr-pr8-build.lock node test/mutation-probe.mjs --only R1-
```

```
OK   R1-quarantine-aborts-library       注入=1 还原=0 diff=clean
OK   R1-upload-target-collision-off     注入=1 还原=0 diff=clean
OK   R1-upload-flat-collision-off       注入=1 还原=0 diff=clean
OK   R1-create-topic-flat-off           注入=1 还原=0 diff=clean
OK   R1-rename-inner-clash-off          注入=1 还原=0 diff=clean
OK   R1-boundary-length-off             注入=1 还原=0 diff=clean
OK   R1-silent-skip                     注入=1 还原=0 diff=clean
OK   R1-false-success-marker            注入=1 还原=0 diff=clean
# 变异验证：8/8 通过   （PROBE_EXIT=0）
```

**归属必须写清**：前缀 `R1-` 下混有 **3 条既有的 migrate 域变异**（`R1-quarantine-aborts-library` /
`R1-silent-skip` / `R1-false-success-marker`，来自更早轮次的「裁定 1」，属 IMP3/t6 领域，**不是 REV1 的评审对象**）。
本轮 E2 修复在 `const plan = planMigration(root, home)` 与旧注释之间插入了 `halfProducts` 清理，令第一条的
`from` 锚点失效（实测「锚点命中 0 次」）。**经队长授权**，本评审只把该条 `from`/`to` 的锚点文本更新为当前唯一文本
（语义不变：quarantine 非空 ⇒ 注入 `throw MigrationError('migrate-conflict', …)`），未改 id / pattern / file / why；
另两条未动。本次改动自证：单跑该条 `注入=1 还原=0 diff=clean`，聚合 8/8 全绿。
**t4 的 verdict 只对 IMP1 的 5 条新变异 + 本评审 18 条自造探针负责。**

| 新增变异（全部 `testFile: test/pr8-review-r1.test.mjs`） | 回退的修复 | 抓住它的用例 |
|---|---|---|
| `R1-upload-target-collision-off` | 上传目标存在性预检（`<topic>/<stem>`） | R1-B1（B2 同理） |
| `R1-upload-flat-collision-off` | 上传的同层旧平铺产物预检 | R1-B3 |
| `R1-create-topic-flat-off` | create-topic 的 C2 预检 | R1-C2 |
| `R1-rename-inner-clash-off` | 新布局 renamePaper 的目标内同名残留预检 | R1-C4 |
| `R1-boundary-length-off` | boundaryOnly 不施加每段长度上限（F） | R1-F1（F2 同理） |

**变异前后源文件哈希一致**（注入脚本还原干净，`git status` 里没有本评审留下的 `src/` 改动）：
`src/host.ts`、`src/library-manage.ts`、`src/migrate.ts` 与 `dist/*` 在聚合跑前后 sha256 全部相同。
所有构建都持 `flock /tmp/dpr-pr8-build.lock`（与并行任务串行，避免抢 `dist/`）。

## 四、实现方用例是否空转 / 削弱断言 / 静默跳过？

**结论：未发现空转或削弱。** 三重核对：

1. **静态扫描**：`test/pr8-layout-collision.test.mjs` 里没有 `.skip` / `.todo` / `assert.ok(true)` /
   无条件吞异常；唯一的条件分支是 B4 的平台事实分支（`if (!insensitive) { … }`），
   敏感盘分支**额外**断言「没有创建小写变体」——这是可观测性差异，不是跳过。
2. **基线上真的红**：把实现方用例原样复制到基线树跑（跑完删除，基线工作树无残留）：
   `# tests 15 / # pass 1 / # fail 14`（唯一绿是 B5 回归，设计上修前修后都绿），与 t1 自述一致。
3. **修复树上绿**：`node --test test/pr8-layout-collision.test.mjs` → `15/15 pass`。
   （本评审另用完全自造的 18 条探针独立覆盖同一批行为，见 §二。）

## 五、对抗面：路径穿越 / 符号链接 / 编码变形 / legacy 边界

- `R1-F4`：boundaryOnly 下 `..`、`%2e%2e%2f` 解码变形、`.trash` 保留名一律 400；`Alpha/Sub` 原样保留。
- `R1-S1`（修复树绿）：符号链接**专题**、符号链接**论文目录**、`../`、`/tmp/...` 绝对路径、
  `Alpha/%2e%2e%2fescape` 全部 4xx；上传名 `..pdf` / `...pdf` / `..\..\evil.pdf` 全部被拒；
  库外临时目录保持为空。
- `R1-S2`：前导点论文名（边界类允许 upload）上传后**能按名删除**——「upload 能创建的名字必须能被删」未回归。

### 顺带堵住的既有安全缺口（基线写穿符号链接到库外）——供集成写进维护者回复

`Alpha/SymLink` 是**符号链接到库外目录**时，基线 upload 返回 **200** 并把 `SymLink.pdf` 写进**库外**；
修复后 400 `escape-rejected`、库外零写入。t1 的写侧预检（`src/host.ts:677` 区域）顺带堵住了它。
这不是 t1 的 blocker（已修），但值得单独记录。

复跑脚本（`node /tmp/r1probe/symlink-escape.mjs`）：

```js
// 基线/修复各建一个临时库：data/Alpha 存在，data/Alpha/SymLink -> 库外临时目录
// 然后 POST /api/library/upload topic=Alpha name=SymLink.pdf，观察状态码与库外目录
const r = await fetch(base + '/api/library/upload', { method: 'POST',
  headers: { 'x-dpr-topic': encodeURIComponent('Alpha'), 'x-dpr-name': encodeURIComponent('SymLink.pdf'),
             'content-type': 'application/pdf' }, body: Buffer.alloc(200, 0x41) })
console.log(JSON.stringify({ tree: label, status: r.status, outsideEntries: readdirSync(outside) }))
```

实测输出：

```
{"tree":"baseline","status":200,"body":"{\"ok\":true,\"topic\":\"Alpha\",\"name\":\"SymLink\",\"bytes\":200}","outsideEntries":["SymLink.pdf"]}
{"tree":"fixed",  "status":400,"body":"{\"error\":\"路径越界：目标论文路径是符号链接，已拒绝：SymLink\",\"code\":\"escape-rejected\"}","outsideEntries":[]}
```

## 六、低危观察（不阻塞，按队长裁定记录为 note）

1. **create-topic / rename-topic 没有「仅大小写不同」碰撞检查**（与 upload 的 B4 严格性不一致）。
   实测（ext4）：`Alpha/CaseTopic` 已存在时 `POST topic {name:'Alpha/casetopic'}` → **200**，盘上出现
   `CaseTopic` 与 `casetopic` 两个专题；若只有 `CaseTopic`，`rename-topic CaseTopic→casetopic` → 200（ext4）。
   在 APFS/NTFS 上：mkdir 会命中已存在目录（API 仍返回 200，但「新专题」其实是既有目录＝假成功/别名）；
   rename 会 409。**无数据丢失/不可见**，但跨平台语义不一。
   建议：create-topic/rename-topic 的目标存在性检查复用 `caseVariantCollisions`（`src/library.ts:197`，
   upload 已经用，`src/host.ts:701`），或在 features 文档记录该差异。落点：`src/host.ts:618`（只查精确名）。
2. **上传到「已存在的 110 字 legacy 专题」被 400**（`src/host.ts:640` 用 `validateTopicPath(topic,false)`＝创建语义）。
   实测：110 字专题可删除（F1 绿）、可改名（F2 绿），但向它 upload 新论文得到
   `{"error":"名字过长（每层最多 100 个字符）","code":"bad-name"}`。基线同样 400（**不是本轮回归**），
   影响是「legacy 长名专题要先改名才能加论文」。与维护者 F 的字面要求（可删/可改名）不冲突；
   若希望 legacy 专题保持完全可用，可在 upload 里「目录已存在」时改用边界类长度语义。
3. **C4 的 same-inode 例外未加 `ino === 0` 平台守卫**（`src/library-manage.ts:1120`）。
   仓库在迁移入口判定里已有该约定（`src/migrate.ts:989`：`a.ino !== 0 && b.ino !== 0 && …`，
   注释「`ino === 0` 的文件系统上这条无意义」）。在 FAT/exFAT/部分 SMB 等 `ino` 恒为 0 的文件系统上
   （Windows 外接盘常见），残留文件与源文件会被判「同一 inode」⇒ 冲突被放行 ⇒ C4 的静默覆盖在该平台复现。
   本机 ext4 无法运行时复现，属**按代码路径 + 仓库既有约定**判定的平台缺口。
   低危理由：主流 NTFS/APFS/ext4 均有效；若团队把 exFAT/网络盘 Windows 库列为受支持场景，应升级 medium。
   建议一行守卫（`ino !== 0` 才比 ino，否则退回 `renameLegacyPaper` 已在用的 `realpath` 比较）。
4. **boundaryOnly 仍卡 `MAX_TOPIC_DEPTH(16)`**（`src/library-manage.ts:181`，`src/library.ts` 同步）。
   >16 层的 legacy 路径仍不可删/改名；旧版单层布局不可能产生这种路径，影响≈0，仅作信息记录。
5. **t1 的额外加严**「create-topic 目标本身是嵌套层论文目录 ⇒ 409」超出维护者清单（维护者只点名祖先段），
   方向正确且已在其证据 §5.4 披露；本评审的 C1a 用例不依赖它（用的是祖先段），故不构成隐藏语义变更。
   （若集成说明要给维护者逐条对账，建议把这条列为「同类加严、非清单要求」。）

## 七、命令与完整性

```bash
cd /home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes
flock /tmp/dpr-pr8-build.lock -c 'npm run build'                                  # exit 0
node --test test/pr8-review-r1.test.mjs                                           # 18 pass / 0 fail
R1_REPO=/home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-baseline \
  node --test test/pr8-review-r1.test.mjs                                         # 4 pass / 15 fail（预期红）
flock /tmp/dpr-pr8-build.lock node test/mutation-probe.mjs --only R1-             # 8/8，exit 0
node --test test/pr8-layout-collision.test.mjs                                    # 实现方用例 15/15（非空转核验）
# 基线跑实现方用例：cp 到 pr8-baseline/test → 1 pass / 14 fail → 删除，基线工作树无残留
```

- 所有破坏性/写盘实验都在 `mkdtemp` 临时库 + 临时 `DSH_HOME` 中完成；真实文献库与 `~/.dsh` 未被触碰。
- 变异注入/还原前后：`src/host.ts`、`src/library-manage.ts`、`src/migrate.ts`、`dist/{host,library-manage,migrate}.js`
  sha256 全部一致；`git status` 中只有本评审的两个新文件与 `test/mutation-probe.mjs` 的 `M`。
- 与并行任务的协调：构建全部持 `flock /tmp/dpr-pr8-build.lock`；未跑全量套件（并行任务的中间态会污染结论），
  只跑与本评审对象直接相关的三套（本探针 / 实现方 B-C-F 用例 / 变异）。
