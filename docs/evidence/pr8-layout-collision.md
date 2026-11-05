# PR #8 必修 B / C / F —— 布局写入碰撞与 legacy 长度回归（红 → 绿实测）

对应 `docs/pr8-maintainer-review.md`「必修」的 **B（上传无碰撞检查）**、**C（目录/文件互踩）**、
**F（boundaryOnly 长度回归）**。修前在 `fdb45f2` 基线上先跑红、修后跑绿，逐条留证据。

- 修复工作树：`.worktrees/pr8-fixes`（`feat/darkmode-subtopic`，HEAD `fdb45f2`）
- 基线工作树：`.worktrees/pr8-baseline`（detached @ `fdb45f2`，已 build）
- 新增用例：`test/pr8-layout-collision.test.mjs`（15 条，只动这一个新文件）
- 全部实验用 `mkdtemp` 临时库，绝不碰真实文献库
- 本任务只改：`src/host.ts`、`src/library.ts`、`src/library-manage.ts`、`test/pr8-layout-collision.test.mjs`、本文件

## 0. 复现命令（红/绿的唯一操作口径）

```bash
# 红：把**新用例**复制到基线树跑（基线是 fdb45f2 已 build 的 dist）
cp .worktrees/pr8-fixes/test/pr8-layout-collision.test.mjs .worktrees/pr8-baseline/test/
cd .worktrees/pr8-baseline && node --test test/pr8-layout-collision.test.mjs

# 绿：修复树先加锁 build（测试 import dist/），再跑
cd .worktrees/pr8-fixes && flock /tmp/dpr-pr8-build.lock -c 'npm run build'
cd .worktrees/pr8-fixes && node --test test/pr8-layout-collision.test.mjs
```

**基线（`fdb45f2`）结果：`# tests 15 / pass 1 / fail 14`**（唯一的 pass 是 B5 回归用例，设计上修前修后都应绿）：

```
not ok 1 - B1 …子专题…        ok 5 - B5 回归：正常新上传仍 200…
not ok 2 - B2 …论文目录…
not ok 3 - B3 …旧平铺论文产物…
not ok 4 - B4 …仅大小写不同…
not ok 6 - B6 …消费请求体之前…
not ok 7 - C1a … not ok 12 - C4 … not ok 15 - F3 …   （共 14 条红）
```

**修复后：`# tests 15 / pass 15 / fail 0`。**

逐条对应关系：

| 编号 | 缺陷 | 用例 | 基线 | 修复后 | 落点 |
|---|---|---|---|---|---|
| B1 | 上传把同名子专题变成论文目录，其下论文整体消失 | B1 | 红（200） | 绿（409） | `src/host.ts:659` |
| B2 | 上传覆盖/合并已存在的同名论文目录 | B2 | 红（200，PDF 被覆盖） | 绿（409） | `src/host.ts:657` |
| B3 | 同层旧平铺论文产物被文件夹优先规则永久遮蔽 | B3 | 红（200） | 绿（409） | `src/host.ts:665` + `src/library.ts:184` |
| B4 | 大小写不敏感盘上静默吞掉仅大小写不同的同名目标 | B4 | 红（200） | 绿（409，点名冲突对象） | `src/host.ts:669` + `src/library.ts:197,207` |
| B5 | 回归：正常上传落点不变 | B5 | 绿 | 绿 | `src/host.ts:684` |
| B6 | 碰撞校验必须在消费请求体之前 | B6 | 红（3s 超时，说明在等 body） | 绿（23ms 内 409） | `src/host.ts:633-674` |
| C1a | create-topic 把论文目录当专题父 | C1a | 红（200） | 绿（409） | `src/host.ts:563` + `src/library.ts:169` |
| C1b | upload 的 topic 解析落进论文目录 | C1b | 红（200） | 绿（409） | `src/host.ts:645` |
| C1c | renameTopic 把子专题树搬进论文目录 | C1c | 红（200，树消失） | 绿（409） | `src/library-manage.ts:1264` |
| C2 | create-topic 与同层旧平铺论文同名 | C2 | 红（200；探针实测列表变空 + delete-plan 404） | 绿（409） | `src/host.ts:571` + `src/library.ts:184` |
| C3 | renameLegacyPaper 撞上已存在目录 | C3 | 红（200，改名后不可见不可删） | 绿（409 target-exists） | `src/library-manage.ts:1193` |
| C4 | 新布局 renamePaper 静默覆盖目标名残留文件 | C4 | 红（200，`moved:["New.txt","New.pdf"]`，内容被覆盖） | 绿（409，零改动） | `src/library-manage.ts:1106` |
| F1 | 110 字 legacy 专题删不掉 | F1 | 红（400） | 绿（删除 200 / 创建仍 400） | `src/library-manage.ts:179,188` |
| F2 | 110 字 legacy 专题不能作为 rename-from | F2 | 红（400） | 绿（200） | 同上 |
| F3 | `MAX_TOPIC_PATH(200)` 也误伤已存在 legacy 路径 | F3 | 红（400） | 绿（200） | 同上 |

### 0.1 基线后果实测（独立探针，不只依赖测试断言）

用基线 `dist/host.js` + `mkdtemp` 临时库直接打路由，确认评审描述的「整体消失 / 404」真实发生：

```
# B1：T/Sub/P 存在时 upload('T','Sub.pdf')
B1 upload => {"status":200,"body":{"ok":true,"topic":"T","name":"Sub","bytes":200}}
B1 listPapers => ["T/Sub"]          ← 子专题里的 P 消失，T/Sub 被当成论文
B1 tree children => []              ← 子专题节点也没了

# C2：T/Foo.pdf 存在时 POST topic {name:'T/Foo'}
create-topic T/Foo => {"status":200,"body":{"ok":true,"topic":"T/Foo"}}
listPapers => []                    ← 旧平铺论文 Foo 被文件夹优先规则遮蔽
delete-plan Foo => {"status":404,"body":{"error":"文献不存在：Foo.pdf","code":"not-found"}}

# C1c：A/B 存在时 rename-topic A -> T/P/A（T/P 是论文目录）
C1c rename => {"status":200,"body":{"ok":true,"moved":[],"from":"A","to":"T/P/A",...}}
C1c listPapers => ["T/P"]           ← A/B 整棵子树从列表消失
```

修复后同一组操作全部 409（见下），且全库快照零改动。

## 1. B —— 上传碰撞（`/api/library/upload`）

### B1 同名子专题 → 409（否则其下论文整体消失）

维护者断言（B）：往已有**子专题**同名目录上传会把子专题变成「论文目录」，其下论文从列表/树/范围提问整体消失。

修前基线（红）：

```
not ok 1 - B1 …
  必须 409（否则子专题被变成论文目录、其下论文整体消失）：
  {"ok":true,"topic":"T","name":"Sub","bytes":200}
  200 !== 409
```

修后（绿）：用例断言 `200→409`、`snap()` 全库零改动、`T/Sub/Sub.pdf` 不存在、
`listPapers` 仍是 `['T/Sub/P']`、树的 `children=[T/Sub]` 且 `papers=['P']`。
真实响应：

```json
409 {"error":"已存在同名子专题：Sub（上传会把它变成论文目录，其下文献将整体消失）","code":"target-exists","conflicts":["Sub"]}
```

落点：`src/host.ts:659`（`targetStat.isDirectory()` 且 `!isPaperDir` 分支）。

### B2 同名论文目录 → 409（不覆盖不合并）

修前基线（红）：

```
not ok 2 - B2 …
  必须 409（论文目录已存在，不得覆盖）：{"ok":true,"topic":"T","name":"P","bytes":200}
```

修后（绿）：409、`snap()` 零改动、`P/P.pdf` 内容逐字节原样（`'pdf:T/P'`）：

```json
409 {"error":"已存在同名论文目录：P2（上传会覆盖/合并它）","code":"target-exists","conflicts":["P2"]}
```

落点：`src/host.ts:657`（`isPaperDir(targetPaperDir)` 分支，复用 `library.ts` 的 `isPaperDir`，不另写口径）。

### B3 同层旧平铺论文产物 → 409（`.pdf/.txt/.study.json/.embeddings.json` 逐个验证）

修前基线（红，第一条 `.pdf` 就复现）：

```
not ok 3 - B3 …
  同层已有 Flat.pdf 时必须 409（否则旧平铺论文被文件夹规则永久遮蔽）：
  {"ok":true,"topic":"T","name":"Flat","bytes":200}
```

修后（绿）：四种后缀各自独立临时库、各自 409 + 零改动 + 不建 `T/Flat/` + 平铺产物原地不动；
并且干净名字 `Fresh.pdf` 仍 200 且落在 `T/Fresh/Fresh.pdf`（证明不是「一律拒上传」）：

```json
409 {"error":"同层已有旧布局论文产物：Flat.study.json（新建论文文件夹会把它永久遮蔽，请先迁移）","code":"target-exists","conflicts":["Flat.study.json"]}
200 {"ok":true,"topic":"T","name":"Clean","bytes":200}
```

落点：`src/host.ts:665`；产物清单复用 `library-manage.ts` 的 `PAPER_STEM_SUFFIXES`（`src/library.ts:184` 的
`flatArtifactNames`），与删除/改名的产物口径同源。

### B4 仅大小写不同 → 409 且点名冲突对象（平台事实分支）

用例用 `test/fs-probe.mjs` 的 `caseInsensitiveFs()` **实测**（不硬编码 darwin/win32），两条分支都执行：

- 大小写不敏感盘（APFS/NTFS）：目标路径直接命中现有条目 ⇒ 409，文案用 `existingEntryName()` 取磁盘真名；
- 大小写敏感盘（本机 ext4）：`caseVariantCollisions()` 逐条忽略大小写比对 ⇒ 同样 409，并断言
  **没有创建小写变体**（证明「不静默吞掉」这条风险在两类盘上都被堵住）。

修前基线（红，本机 ext4 分支）：

```
not ok 4 - B4 …
  大小写敏感盘上仅大小写不同的同名论文目录都必须 409：{"ok":true,"topic":"T","name":"paper","bytes":200}
```

修后（绿）：

```json
409 {"error":"同层已有仅大小写不同的同名对象：Paper（大小写不敏感的文件系统上会互相吞掉）","code":"target-exists","conflicts":["Paper"]}
409 {"error":"同层已有仅大小写不同的同名对象：Old.pdf（…）","code":"target-exists","conflicts":["Old.pdf"]}
```

落点：`src/host.ts:669` + `src/library.ts:197`（`caseVariantCollisions`）、`src/library.ts:207`
（`existingEntryName`）。

### B5 回归：正常上传仍 200，落点不变

修前修后都绿（无缺陷可修，防「为堵碰撞把所有上传都拒了」）。断言：

- `POST upload topic=T/NewSub name='Paper One.pdf'` → 200；
- 落点 `<data>/T/NewSub/Paper One/Paper One.pdf`（不是平铺）；
- 列表 `['T/NewSub/Paper One']`，树 `children[0].path='T/NewSub'`、`papers=['Paper One']`。

### B6 校验必须发生在**消费请求体之前**

用 `node:http` 只发 header（`content-length: 400`）**故意不发 body**：

- 基线（红）：服务端在 `for await (const c of req)` 等 body，3s 超时 → `ERR_TEST_FAILURE`
  「服务端没有在消费请求体之前返回」；
- 修后（绿）：23ms 内收到 409（请求体一个字节都没发）。

这把「既有约定（越界/碰撞目标不消费请求体、不碰盘）」变成了可回归的断言，而不是注释承诺。
落点：`src/host.ts:633-674`（预检整体位于 `src/host.ts:675` 的 `for await (const c of req)` 之前）。

## 2. C —— 目录/文件互踩

### C1 论文目录不能当专题父（三处同门）

C1a `create-topic`：`T/P` 是论文目录（`T/P/P.pdf`），`POST /api/library/topic {name:'T/P/New'}`。
修前基线（红）：

```
not ok 7 - C1a …
  祖先段 T/P 是论文目录，必须 409：{"ok":true,"topic":"T/P/New"}
```

修后（绿）：409 + 全库快照零改动 + `T/P` 仍在列表：

```json
409 {"error":"父级是论文目录，不能在其下创建专题：T/P","code":"target-exists","conflicts":["T/P"]}
```

C1b `upload` 的 topic 解析：`upload topic=T/P`。修前基线（红）`{"ok":true,"topic":"T/P","name":"X","bytes":200}`；
修后 409 且 `T/P/X` 不存在、`T/P` 仍可见：

```json
409 {"error":"专题路径落在论文目录里，不能上传：T/P","code":"target-exists","conflicts":["T/P"]}
```

C1c `renameTopic`：`A`（含 `A/B/B.pdf`）→ `T/P/A`。修前基线（红，且子树真的搬走了）：

```
{"ok":true,"moved":[],"from":"A","to":"T/P/A","topic":"T/P/A","detachedSessions":0}
```

修后（绿）：409 + 全库快照零改动 + `A/B/B.pdf` 原地 + `T/P/A` 不存在：

```json
409 {"error":"目标父级是论文目录，不能把专题移进去：T/P","code":"target-exists","conflicts":["T/P"]}
```

实现口径（复用 `isPaperDir`，不另写一套）：

- `src/library.ts:169` `paperDirAncestor(root, segs)`：**从第 2 段起**判「已存在段是论文目录」
  （第 1 段永远按专题解释，与 `listPapers` 的 `isRoot` 口径一致，否则「平铺论文与一级专题同名」的历史布局会被误判）；
- `src/host.ts:563`（create-topic 祖先）、`src/host.ts:645`（upload topic 全程）、
  `src/library-manage.ts:1264-1270`（renameTopic 的目标父级）；
- 移动子树仍禁止进自己子树（原 `bad-request` 409 语义未动）。

附带同门加严：create-topic 的**目标本身**若是嵌套层论文目录也 409（否则会建出一个「在列表里永远被解释成论文」
的假专题）；该行为只在嵌套层生效（第 1 段仍是专题语义）。

### C2 create-topic 与同层旧平铺论文同名 → 409

`T/Foo.pdf` 存在时 `POST topic {name:'T/Foo'}`。修前基线（红：建目录成功 → 论文不可见）：

```
not ok 9 - C2 …
  同层已有旧平铺论文 Foo.pdf，建同名目录必须 409：{"ok":true,"topic":"T/Foo"}
```

修后（绿）：409 + 零改动 + 不建目录 + 列表仍是 `['T/Foo']` + `delete-plan` 仍 200（评审点名的
`planPaperDelete 404` 不再出现）：

```json
409 {"error":"同层已有旧布局论文：Foo.pdf（请先迁移或改名，否则它会被同名专题遮蔽）","code":"target-exists","conflicts":["Foo.pdf"]}
```

落点：`src/host.ts:571`（只查 topic 内部；dataDir 根层平铺文件不是文献，不构成遮蔽）+ `src/library.ts:184`。

### C3 renameLegacyPaper 目标名已是目录 → 409 `target-exists`

`T/old.pdf` + `T/old.txt`（旧布局），同层已有目录 `T/new/`（子专题，含 `T/new/Inner/Inner.pdf`）。
`POST rename-paper {topic:'T', name:'old', to:'new'}`。修前基线（红，且**真的把平铺文件改成了会被遮蔽的名字**）：

```
not ok 10 - C3 …
  目标已存在目录 T/new，平铺改名必须 409：
  {"ok":true,"moved":["new.txt","new.pdf"],"from":"old","to":"new","name":"new","detachedSessions":0}
```

修后（绿）：409 + `code=target-exists` + 零改动 + 无 `T/new.pdf` + `['T/new/Inner','T/old']` 都仍可见：

```json
409 {"error":"已存在同名目录：new（平铺改名会被它遮蔽）","code":"target-exists","conflicts":["new"]}
```

落点：`src/library-manage.ts:1193-1200`（在逐文件预检**之前**、任何 rename 之前）。

### C4 新布局 renamePaper 目标目录内同名残留文件 → 409（不静默覆盖）

`T/Old/` 内是 `Old.pdf`、`Old.txt`，另手放一个目标名残留 `New.txt`（内容 `LEFTOVER-MUST-SURVIVE`）。
`POST rename-paper {topic:'T', name:'Old', to:'New'}`。

修前基线（红：`moved` 里出现 `New.txt`，即 `renameSync(Old.txt → New.txt)` 覆盖了残留）：

```
not ok 11 - C4 …
  目标目录内已有 New.txt，必须 409 而不是静默覆盖：
  {"ok":true,"moved":["New.txt","New.pdf"],"from":"Old","to":"New","name":"New","detachedSessions":0}
```

修后（绿）：409 + 全库快照零改动（目录名/所有文件都原样）+ `New.txt` 内容仍是 `LEFTOVER-MUST-SURVIVE` +
`T/New` 不存在（没有「先改目录再失败」）+`.trash` 不存在（失败路径无回收站记录）；清掉残留后重试 200，
`New/New.pdf`、`New/New.txt` 齐备（两段式与回滚语义保持）：

```json
409 {"error":"目标目录内已存在同名文件：New.txt（改名会覆盖它，已拒绝）","code":"target-exists","conflicts":["New.txt"]}
```

实现要点：预检在**任何 rename 之前**（`src/library-manage.ts:1106-1126`），逐文件查
`<论文目录>/<新名><后缀>`；大小写-only 改名（目标与源是**同一 inode**）放行，所以大小写敏感盘上的
纯大小写改名（既有用例 `reader-ux-verification` 的 `Kept → kept`）语义不变。

## 3. F —— boundaryOnly 长度回归（legacy 怪名字必须保持可删/可改名）

修前基线：

```
not ok 12 - F1 … 400：{"error":"名字过长（每层最多 100 个字符）","code":"bad-name"}
not ok 13 - F2 … 400：{"error":"名字过长（每层最多 100 个字符）","code":"bad-name"}
not ok 14 - F3 … 400：{"error":"名字过长（专题路径最多 200 个字符）","code":"bad-name"}
```

修后（绿）：

```json
// F1：创建侧仍拒 110 字（新上限只作用于创建）
400 {"error":"名字过长（每层最多 100 个字符）","code":"bad-name"}
// F1：删除侧放行 110 字 legacy 专题
200 {"ok":true,"name":"LLLL…(110)","movedHidden":[],"trashDir":null,"trashRel":null,"archivedSessionsNote":true}
// F2：rename-from 放行 110 字 legacy 专题
200 {"ok":true,"moved":[],"from":"RRRR…(110)","to":"short","topic":"short","detachedSessions":0}
// F3：221 字（两段各 110）legacy 路径可删；创建侧仍 400
200 {"ok":true,"name":"AAAA…(110)/BBBB…(110)",…}
```

实现：`src/library-manage.ts:179,188` —— `MAX_TOPIC_PATH(200)` / `MAX_TOPIC_SEG(100)` 只在
`boundaryOnly=false`（创建 / 改名-to）时施加；`boundaryOnly=true`（删除 / 改名-from / 清空，含
`resolveExistingTopicDir` / `resolvePaperDirChecked` / `planPaperDelete` / `planTopicClear`）一律不卡长度。
`src/library.ts:96,102` 的底层 `topicSegments` 同步修正（其文档本来就写着 boundaryOnly 允许历史遗留名，
但代码仍在卡上限——同一处不一致）。

**安全边界没有放松**：`/ \`、`..`、NUL、`.trash` 保留名、`basename(raw)===raw`、深度上限（16）全部仍在；
超长输入走到 fs 时只会得到 404/400（`resolveTopicDirChecked` 把 errno 收敛成 `专题不存在`，不回显绝对路径）。

## 4. 回归与全量

```bash
cd /home/vr/My_Projects/dsh-paper-reader/.worktrees/pr8-fixes
flock /tmp/dpr-pr8-build.lock -c 'npm run build'    # exit 0
node --test test/pr8-layout-collision.test.mjs       # 15 tests / 15 pass / 0 fail
node --test test/darkmode-subtopic-features.test.mjs # 53 tests / 53 pass / 0 fail
node --test "test/*.test.mjs"                        # 561 tests / 534 pass / 0 fail / 27 skip
```

（全量 561 条里包含本轮其他并行任务新增的 `test/pr8-*.test.mjs`；本任务只新增 15 条，基线时为 533 条。）

## 5. 取舍与边界（如实记录）

1. **B4 在大小写敏感盘上也 409**（而不是放行两个大小写变体）：这是有意的跨平台确定性——同一份库在
   macOS/Windows 上会互相吞掉，若 ext4 放行、APFS 拒绝，用户/CI 的期望会随盘漂移。用例仍按实测平台事实
   分支，并在敏感盘分支额外断言「没有创建小写变体」（不静默吞掉这条风险本身）。
2. **C4 的「同一 inode」例外**只服务大小写-only 改名：目标文件与源文件是同一个磁盘实体时不算冲突。
   基线实测的静默覆盖（`moved:["New.txt","New.pdf"]`）由新预检挡住，且预检在任何 rename 之前，
   失败路径无目录改名、无回收站记录。
3. **F 只放宽 boundaryOnly 的长度上限**：深度上限（16）与全部安全字符边界保持；创建侧 100/200 上限不变
   （F1 同时断言「创建 110 字仍 400」「上传到 110 字新专题名仍 400」）。
4. create-topic 额外拒绝「目标本身是嵌套层论文目录」，与 C1/C2 同属「论文目录不能被解释成专题」的同类
   互踩；只在嵌套层生效（一级目录永远按专题解释）。
5. 本任务**未**改 `test/mutation-probe.mjs`（不在 inScope）；可区分性由「基线 14 红 / 修复 15 绿」证明，
   每条红都对应一个具体的 200-versus-409（或 400-versus-200）断言，不是仅靠状态码聚合。
6. 同一工作树里有其他并行任务的改动（`src/scope.ts` / `src/tools.ts` / `lib/client.js` / 其它
   `test/pr8-*.test.mjs`）；本任务没有触碰这些文件，`git diff` 中属本任务的只有上述 3 个 `src/` 文件 +
   新增的测试与本文档。
