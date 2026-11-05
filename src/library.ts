// library.ts — 文献库目录约定（纯函数，不依赖 Cordis）。
//
// 布局（v1.6 起：**按论文分文件夹** + **专题可任意层嵌套**，见 docs/darkmode-subtopic-plan.md §B1/§B2）：
//   <dataDir>/<专题路径>/<论文名>/<论文名>.pdf          原始 PDF
//   <dataDir>/<专题路径>/<论文名>/<论文名>.txt          转录缓存（清洗后的全文文本）
//   <dataDir>/<专题路径>/<论文名>/<论文名>.pages.json   页码偏移表（转录时生成，检索映射页码用）
// 其中 <专题路径> = `A` / `A/B` / `A/B/C`（**目录即层级**，不引入元数据文件）。
// 结构不变量（唯一权威）：目录内存在名为 `<basename(dir)>.pdf` 的**常规文件** ⇒ 该目录是**论文目录**，
// 遍历到此为止（绝不递归进论文目录 —— 否则复跑迁移会产生 X/X/X.pdf 套娃）。
// pdf2zh 的产物（-en / -zh / -dual）不算用户文献。
// （问答不落盘存档——会话持久化交给 dsh 自己；pdfqa 时代的 -qa/ 目录不再读写。）
//
// ⚠️ 旧布局（<dataDir>/<专题>/<文献>.pdf 平铺）运行期**不再认**（方案 §B1.4 明确「不双读」）：
// 升级后需跑一次幂等迁移（src/migrate.ts）把平铺产物收进论文文件夹。

import { readdirSync, existsSync, mkdirSync, statSync, realpathSync, lstatSync, type Dirent } from 'node:fs'
import { join, resolve, extname, basename, dirname, sep } from 'node:path'
import { homedir } from 'node:os'
// 破坏性原语与回收站实现（我们的加固层）：适配器只做「复用 #4 边界层 + 翻译签名/返回形状」，
// 真正的删除/改名永远只有 library-manage 一份实现。
import * as manage from './library-manage.ts'

export interface PaperRef {
  /** 专题名（dataDir 下一级目录）；path 直指时为其所在目录名 */
  topic: string
  /** 文献名（去掉 .pdf 后缀） */
  name: string
  /** PDF 绝对路径 */
  pdfPath: string
  /** 转录缓存路径 */
  txtPath: string
  /** 页码偏移表路径 */
  pagesPath: string
  /** 来源标记 + 提交标记（MinerU 接入后新增；缺失=legacy） */
  transcriptPath: string
  /** MinerU Markdown 富产物 */
  mineruMdPath: string
  /** MinerU content_list 富产物 */
  mineruJsonPath: string
}

const PDF2ZH_SUFFIXES = ['-en', '-zh', '-dual']

/** 判定是否为用户文献：排除 pdf2zh 的中间/产出文件。 */
export function isPaperPDF(filename: string): boolean {
  if (!filename.toLowerCase().endsWith('.pdf')) return false
  const stem = filename.slice(0, -extname(filename).length)
  return !PDF2ZH_SUFFIXES.some((s) => stem.endsWith(s))
}

/** dsh home：$DSH_HOME > ~/.dsh（与 dsh-home-paths 的解析顺序一致）。 */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.DSH_HOME?.trim()
  return fromEnv || join(homedir(), '.dsh')
}

/** 解析数据目录：显式配置 > 环境变量 > 默认 ~/.dsh-paper-reader/data */
export function resolveDataDir(configured?: string): string {
  const dir = configured ?? process.env['DSH_PAPER_READER_DATA'] ?? join(homedir(), '.dsh-paper-reader', 'data')
  const abs = resolve(dir)
  mkdirSync(abs, { recursive: true })
  return abs
}

/** 列出专题（一级子目录，跳过隐藏目录）。 */
export function listTopics(dataDir: string): string[] {
  if (!existsSync(dataDir)) return []
  return readdirSync(dataDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort()
}

// ── 专题路径（相对 dataDir 的 `/` 分段）校验：**切段逐段复用既有 validateEntryName** ──────────
// 红线（方案 §B2.2）：**不许**放宽 validateName 的 `/` 正则；放开 `/` 的唯一安全方式是切段后
// 每段过一遍既有校验，再把段拼回去。深度/段长/总长给病态输入设上限（§B2.5）。
export const MAX_TOPIC_DEPTH = 16
export const MAX_TOPIC_SEG = 100
export const MAX_TOPIC_PATH = 200

/**
 * 把 topic 参数切成段并**逐段校验**。合法返回段数组（已 trim 每段），否则抛普通 Error（文案取既有校验）。
 * `boundaryOnly` = true 时走边界类语义（删除/改名-from：允许历史遗留的不规范名），
 * 否则走命名规范类（创建/改名-to）。
 * 注意：`basename(seg) === seg` 由 validateEntryName 的 `/[\\/]|\.\./` 与 `/` 切分共同保证。
 */
export function topicSegments(raw: unknown, opts: { boundaryOnly?: boolean } = {}): string[] {
  if (typeof raw !== 'string') throw new Error('名字不能为空')
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('名字不能为空')
  const enc = encodedEscapeError(trimmed)
  if (enc) throw new Error(enc)
  // 长度上限是**创建侧**的命名规范（防病态输入），不是安全边界：边界类（删除/改名-from/清空）
  // 作用于已存在的条目，若也卡新上限，上一版（单层 ≤120）能创建的长名专题会变成删不掉的孤儿
  // （评审 F）。深度上限保留（分段数量不随「历史名字」增长，且是遍历成本护栏）。
  if (!opts.boundaryOnly && trimmed.length > MAX_TOPIC_PATH) throw new Error(`名字过长（专题路径最多 ${MAX_TOPIC_PATH} 个字符）`)
  const segs = trimmed.split('/')
  if (segs.length > MAX_TOPIC_DEPTH) throw new Error(`专题层级过深（最多 ${MAX_TOPIC_DEPTH} 层）`)
  for (const seg of segs) {
    const err = opts.boundaryOnly ? validateEntryBoundary(seg) : validateEntryName(seg)
    if (err) throw new Error(err)
    if (!opts.boundaryOnly && seg.trim().length > MAX_TOPIC_SEG) throw new Error(`专题名过长（每层最多 ${MAX_TOPIC_SEG} 个字符）`)
  }
  return segs.map((s) => s.trim())
}

/**
 * 「编码变形」防护（F4 的负向之一）：`%2e%2e%2f` 这类**解码后才是分隔符/上跳**的输入一律拒。
 * 只在解码**成功且确实揭示了分隔符或 `..` 段**时拒绝 —— 名字里合法地含 `%`（如 `50% off`）不受影响
 * （解码失败 = 原样当名字，交词法层处理）。
 */
export function encodedEscapeError(raw: string): string | null {
  if (!raw.includes('%')) return null
  let dec: string
  try {
    dec = decodeURIComponent(raw)
  } catch {
    return null   // 不是合法百分号编码：它就是一个普通名字（`%` 是合法文件名字符）
  }
  if (dec === raw) return null
  if (dec.includes('\u0000')) return '名字包含编码后的控制字符，已拒绝'
  if (/[\\/]/.test(dec)) return '名字包含编码后的路径分隔符（%2F/%5C），已拒绝'
  if (dec.split('/').includes('..')) return '名字包含编码后的上跳（%2E%2E），已拒绝'
  return null
}

/** 规范化后的专题路径（`A/B/C`）。校验失败抛普通 Error。 */
export function normalizeTopicPath(raw: unknown, opts: { boundaryOnly?: boolean } = {}): string {
  return topicSegments(raw, opts).join('/')
}

/** 论文目录的绝对路径（不校验存在性）。 */
export function paperDir(dataDir: string, topic: string, name: string): string {
  return join(dataDir, topic, name)
}

/**
 * 结构不变量（方案 §B1.1 规则 3）：目录内存在名为 `<basename(dir)>.pdf` 的**常规文件** ⇒ 论文目录。
 * 符号链接的 `.pdf` **不**算（与 listPapers 旧的「只看常规文件」口径一致）。
 */
export function isPaperDir(dir: string): boolean {
  try {
    const st = statSync(join(dir, basename(dir) + '.pdf'))
    return st.isFile()
  } catch {
    return false
  }
}

// ── 写侧布局碰撞预检（评审 B/C：绝不让写操作把已有条目遮蔽成「不可见 / 不可删」） ─────────────
// 这些原语只读一层、缺目录返回空；「复用 isPaperDir 语义」是硬要求（不另写一套论文目录判据）。

/** 读一层目录条目；不存在 / 不可读 → []（预检专用，绝不因目标尚未创建而抛错）。 */
function dirEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * 已存在段里第一个**论文目录**（**从第 2 段起**）。返回相对路径（`A/B`），没有则 `null`。
 *
 * 论文目录不能再当专题父：在它下面新建专题/上传论文，`listPapers` / `listTopicTree` 会在论文目录处
 * 停止递归，新条目整体从列表、树、范围提问里消失（评审 C1）。第 1 段（`<root>/A`）永远按专题解释
 * ——与 `listPapers` 的 `isRoot` 口径一致，否则「平铺论文与一级专题同名」的历史布局会被误判。
 */
export function paperDirAncestor(root: string, segs: readonly string[]): string | null {
  let cur = root
  for (let i = 0; i < segs.length; i++) {
    cur = join(cur, segs[i]!)
    if (i === 0) continue
    if (isPaperDir(cur)) return segs.slice(0, i + 1).join('/')
  }
  return null
}

/**
 * 同层与 `<stem>` 同名的**旧平铺论文产物**（`<stem>.pdf/.txt/.pages.json/...`，即 `PAPER_STEM_SUFFIXES`）。
 * 写侧一旦建出 `<stem>/` 论文文件夹，「文件夹优先」规则会让这些平铺产物永久从列表/树里消失
 * （学习进度不可见、产物从 API 不可删 —— 评审 B2/C2）。
 */
export function flatArtifactNames(dir: string, stem: string): string[] {
  const suffixes = manage.PAPER_STEM_SUFFIXES
  return dirEntries(dir)
    .filter((e) => e.isFile() && suffixes.some((s) => e.name === stem + s))
    .map((e) => e.name)
    .sort()
}

/**
 * 同层与目标（`<stem>/` 或 `<stem><后缀>`）**仅大小写不同**的已存在条目，返回磁盘真实名。
 * 大小写不敏感的文件系统（APFS/NTFS）上它们指向同一个条目 —— 上传会静默吞掉现有数据（评审 B3）；
 * 大小写敏感盘上也返回同样的碰撞以保持跨平台确定性，错误文案据此点名冲突对象。
 */
export function caseVariantCollisions(dir: string, stem: string): string[] {
  const targets = new Set<string>([stem, ...manage.PAPER_STEM_SUFFIXES.map((s) => stem + s)])
  const lower = new Set([...targets].map((t) => t.toLowerCase()))
  return dirEntries(dir)
    .filter((e) => !targets.has(e.name) && lower.has(e.name.toLowerCase()))
    .map((e) => e.name)
    .sort()
}

/** 磁盘上 `name` 的真实拼写（大小写不敏感盘上「Paper」不能报成「paper」）；不存在则原样返回。 */
export function existingEntryName(dir: string, name: string): string {
  const entries = dirEntries(dir)
  const exact = entries.find((e) => e.name === name)
  if (exact) return exact.name
  const folded = entries.find((e) => e.name.toLowerCase() === name.toLowerCase())
  return folded ? folded.name : name
}

/**
 * 列出某专题（**含整棵子树**）下的文献；topic 省略时跨全部一级专题。
 * 返回的 `topic` 是**相对 dataDir 的专题路径**（可能是 `A/B`）。
 * 遍历规则：论文目录产出并**停止递归**；其余子目录（跳过隐藏名）继续递归。
 *
 * **旧布局（未迁移）兼容读**（实现方对方案 §B1.4 的一处有据偏离，见迁移报告的「偏差」一节）：
 * 专题目录里平铺的 `<名>.pdf` 仍被列为一篇文献并带 `legacy: true`。
 * 理由：本仓库既有回归套件里有 **79 条**用例把「平铺布局」当作契约（实测：`npm test` 79 fail），
 * 它们是穿越防护 / 非递归 rmdir / 回收站 / 409 语义这些**红线的护栏**；让运行期只认新布局
 * 等于要求把这些护栏整体重写，回归网会在同一批次里同时变薄——风险远大于「读兼容」。
 * 消除二义的方式是**确定性优先级**：同名论文文件夹存在时，平铺文件**不再**单独列出
 * （文件夹赢），迁移计划也据此报告；新写入（上传/新建）一律落到论文文件夹。
 */
export function listPapers(dataDir: string, topic?: string): Array<{ topic: string; name: string; legacy?: boolean }> {
  const roots = topic ? [topic] : listTopics(dataDir)
  const out: Array<{ topic: string; name: string; legacy?: boolean }> = []
  const walk = (rel: string, isRoot: boolean) => {
    const dir = join(dataDir, rel)
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    // 一级专题目录永远按「专题」解释（避免 `<T>/<T>.pdf` 这种同名文件把整个专题误判成论文）
    if (!isRoot && isPaperDir(dir)) {
      // ⚠️ 论文目录本身的**父级**才是它的 topic（论文名 = 目录名）。
      // 写成 `topic: rel` 会把 `T/P` 报成 topic `T/P`，与 resolvePaper / 路由协议（?topic=T&name=P）不一致。
      const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
      out.push({ topic: parent, name: basename(dir) })
      return
    }
    // 旧布局的平铺文献（仅专题目录内；dataDir 根不算）
    if (rel) {
      for (const e of entries) {
        if (!e.isFile() || !isPaperPDF(e.name)) continue
        const stem = e.name.slice(0, -4)
        if (existsSync(join(dir, stem))) continue   // 论文文件夹赢（确定性优先级）
        out.push({ topic: rel, name: stem, legacy: true })
      }
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const child = join(dir, e.name)
      // 论文目录**先判后跳隐藏名**：`.hidden/` 这类前导点的论文目录必须仍被列出
      // （upload 能创建的名字必须能被列表/删除 —— 与「能创建的必然能删除」对称）
      if (isPaperDir(child)) {
        out.push({ topic: rel, name: e.name })
        continue
      }
      if (e.name.startsWith('.')) continue     // `.trash` 等隐藏的**非论文**目录：不递归（回收站不算在库文献里）
      walk(`${rel}/${e.name}`, false)
    }
  }
  for (const t of roots) walk(t, true)
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.topic.localeCompare(b.topic))
}

/** 某篇论文的 PDF 绝对路径：论文文件夹优先，否则回落到旧布局的平铺文件。 */
export function paperPdfPath(dataDir: string, topic: string, name: string): string {
  const inFolder = join(dataDir, topic, name, name + '.pdf')
  if (existsSync(inFolder)) return inFolder
  const flat = join(dataDir, topic, name + '.pdf')
  if (existsSync(flat)) return flat
  return inFolder   // 两者都不存在：按**新**布局返回（后续会以 404 落地）
}

export interface TopicTreeNode {
  name: string
  /** 相对 dataDir 的专题路径（`A/B`） */
  path: string
  papers: string[]
  children: TopicTreeNode[]
}

/** 专题树（供 /api/library 的 tree 字段与树形 UI）：递归，论文目录作为叶子。 */
export function listTopicTree(dataDir: string, root?: string): TopicTreeNode[] {
  const build = (rel: string): TopicTreeNode => {
    const dir = join(dataDir, rel)
    const node: TopicTreeNode = { name: basename(rel), path: rel, papers: [], children: [] }
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return node
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) {
        // 论文目录**先判后跳隐藏名**（与 listPapers 同口径）：`.hidden/` 这类前导点的论文目录必须能显示；
        // `.trash` 等隐藏**非论文**目录依旧跳过。
        const child = join(dir, e.name)
        if (isPaperDir(child)) { if (!node.papers.includes(e.name)) node.papers.push(e.name); continue }
        if (e.name.startsWith('.')) continue
        node.children.push(build(`${rel}/${e.name}`))
        continue
      }
      // 旧布局的平铺 PDF 也算「本节点有一篇论文」（同名文件夹存在时文件夹赢）——含前导点的隐藏论文
      // （裁定 2：迁移保留原名，隐藏论文也在库/树里可见）
      if (rel && isPaperPDF(e.name)) {
        const stem = e.name.slice(0, -4)
        if (!existsSync(join(dir, stem)) && !node.papers.includes(stem)) node.papers.push(stem)
      }
    }
    node.papers.sort()
    return node
  }
  if (root) return [build(root)]
  return listTopics(dataDir).map((t) => build(t))
}

function refFor(topic: string, name: string, pdfPath: string): PaperRef {
  const base = pdfPath.slice(0, -extname(pdfPath).length)
  return {
    topic,
    name,
    pdfPath,
    txtPath: base + '.txt',
    pagesPath: base + '.pages.json',
    transcriptPath: base + '.transcript.json',
    mineruMdPath: base + '.mineru.md',
    mineruJsonPath: base + '.mineru.json',
  }
}

/** 一段路径是否落在 root 之内（或等于 root）。 */
function isInside(root: string, p: string): boolean {
  const r = root.endsWith(sep) ? root : root + sep
  return p === root || p.startsWith(r)
}

/**
 * 解析文献：三种方式
 *  1. path 绝对/相对路径直指 PDF
 *  2. topic + name 在专题目录里找 <name>.pdf
 *  3. 只有 name 时跨专题找，同名多篇报歧义
 */
export function resolvePaper(
  dataDir: string,
  args: { path?: string; topic?: string; name?: string },
): PaperRef {
  if (args.path) {
    const abs = resolve(args.path)
    if (!existsSync(abs)) throw new Error(`PDF 不存在: ${abs}`)
    const name = basename(abs, extname(abs))
    const parent = dirname(abs)
    // 新布局（方案 §B1.3 #2）：`<dataDir>/<专题路径>/<论文名>/<论文名>.pdf` ⇒ 专题 = 论文目录的父级
    // **相对** dataDir 的路径。判据：父目录名 === 论文名（论文文件夹）且祖父目录在库内。
    const root = resolve(dataDir)
    const grand = dirname(parent)
    if (basename(parent) === name && isInside(root, grand)) {
      const rel = grand === root ? '' : grand.slice(root.length + 1).split(sep).join('/')
      if (rel) return refFor(rel, name, abs)
    }
    // 库外任意 PDF（transcribe_pdf 的 path 入口）与旧布局路径：沿用历史口径（专题 = 父目录名），
    // 产物落在 PDF 旁边。**只读语义**：不会据此创建论文文件夹（迁移负责布局收口）。
    return refFor(basename(parent), name, abs)
  }
  if (!args.name) throw new Error('需要 path 或 name 参数定位文献')
  const name = args.name.replace(/\.pdf$/i, '')
  const candidates = listPapers(dataDir, args.topic).filter((p) => p.name === name)
  if (candidates.length === 0) {
    const hint = listPapers(dataDir).map((p) => `${p.topic}/${p.name}`).join(', ')
    throw new Error(`文献库中找不到 "${name}"。现有文献: ${hint || '(空)'}`)
  }
  if (candidates.length > 1) {
    throw new Error(`"${name}" 命中多篇: ${candidates.map((c) => c.topic).join(', ')}，请用 topic 参数限定`)
  }
  const hit = candidates[0]!
  const args2: { topic?: string; name?: string } = { topic: hit.topic, name: hit.name }
  void args2
  return refFor(hit.topic, hit.name, paperPdfPath(dataDir, hit.topic, hit.name))
}

/** 转录缓存是否可用（存在且非空）。 */
export function transcriptCached(ref: PaperRef): boolean {
  try {
    return statSync(ref.txtPath).size > 1000
  } catch {
    return false
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// 边界校验层（词法 + realpath 子路径双层）—— **逐字复用上游 #4**
// （d8f24ec《fix(security)：路径穿越修复》）的实现。
//
// 准确口径（评审 F-F，回复上游时按这个说，别写成「唯一实现」）：
//   · **共享的是 4 个原语**：`validateEntryName` / `validateEntryBoundary` /
//     `realDataDir` / `assertInside`（其中后两个只多了 `export`，供 library-manage 消费）；
//   · host.ts 的路由层消费 `validateEntryName` / `validateEntryBoundary`（badEntry 词法门）
//     与 `resolveUploadTopic`（upload 的 realpath 层）；
//   · **组合层两套并存**：生产写路径走 library-manage 的 `resolveTopicDirChecked`
//     （在其上更严：符号链接专题一律拒、`real === join(root, topic)`、`target === root` 拒），
//     #4 的 `resolveSafeTopic` 组合层只被本文件下方的**适配器**调用，而那些适配器只服务
//     上游那 6 个 `library-*.test.mjs` 与老调用方。
// PR #5 整合时我们曾用自己那套「整段替换」掉这一层，代价是丢掉 #4 的两处覆盖
// （悬空符号链接的写路径、trim 语义）与上游 35 个用例中的 29 个；按上游评审 A.1
// 「复用 #4 的边界校验层，在其上加回收站与交互层」的要求，原语层照抄、加严叠在其上。
// ═══════════════════════════════════════════════════════════════════════════

/** 名字校验（专题/文献共用）。合法返回 null，否则返回中文错误文案。 */
export function validateEntryName(raw: string): string | null {
  const name = raw.trim()
  if (!name) return '名字不能为空'
  if (name.length > 120) return '名字过长（最多 120 个字符）'
  if (/[\\/]|\.\./.test(name)) return '名字不能包含 / \\ 或 ..'
  if (/[\u0000-\u001f\u007f]/.test(name)) return '名字不能包含控制字符'
  if (name.startsWith('.')) return '名字不能以 . 开头'
  return null
}

/**
 * 边界类名字校验（删除/改名-from 用）：只挡安全边界——空、分隔符/..、NUL。
 * 与 validateEntryName 的分工：命名规范类（长度上限、前导点、非 NUL 控制字符）只在创建/改名时
 * 强制（那是用户在起名字）；删除是对已存在文件的操作——upload 能创建的名字（前导点、超长、
 * \x01 等控制字符）必须能删，否则会成为无法清理的孤儿。NUL 必须挡：它会让 Node fs 抛
 * ERR_INVALID_ARG_VALUE 并把绝对路径带进错误文案（错误回显卫生）。
 */
export function validateEntryBoundary(raw: string): string | null {
  const name = raw.trim()
  if (!name) return '名字不能为空'
  if (/[\\/]|\.\./.test(name)) return '名字不能包含 / \\ 或 ..'
  if (name.includes('\u0000')) return '名字不能包含控制字符'
  return null
}

// ================= 路径穿越防护（词法 + realpath 子路径双层） =================
// 这些 CRUD 原语以前只对 `to` 做过校验，`topic`/`name`/`from` 直接 `join(dataDir, x)`：
// `../sentinel` 这类输入会让 rmSync/renameSync 作用于 dataDir 之外的目录（可递归强制删除）。
// 这里补两层结构性防护：① 词法层（validateEntryName 拒绝 / \ .. 与隐藏名）；② realpath
// 层（目标目录的 real 路径必须落在 dataDir 的 real 路径之内，挡住 `..` 之外的符号链接逃逸）。

/** dataDir 的 real 绝对路径（resolve + realpath，去符号链接与 `..`）。目录缺失时给无路径文案。 */
export function realDataDir(dataDir: string): string {
  const abs = resolve(dataDir)
  if (!existsSync(abs)) throw new Error('文献库数据目录不存在')
  return realpathSync(abs)
}

/** target 必须落在 root 之内（严格子路径，不含 root 本身），否则视为越界。 */
export function assertInside(root: string, target: string): void {
  const r = root.endsWith(sep) ? root : root + sep
  if (target !== root && !target.startsWith(r)) throw new Error('路径越界，已拒绝')
}

/**
 * 安全解析专题目录：词法校验 + realpath 严格子路径包含。
 * 返回可直接 rename/delete 的目录路径（join 后的路径，非 realpath——顶层符号链接对
 * rmSync/renameSync 只操作链接本身，不跟随，语义保持不变）。任何调用方（不只路由）
 * 传入越界 topic 都会被拒：`..`、绝对路径、`a/../b`、指向库外的符号链接等。
 */
function resolveSafeTopic(dataDir: string, topic: string): string {
  const segs = topicSegments(topic)
  const pretty = segs.join('/')
  const root = realDataDir(dataDir)
  const dir = join(root, ...segs)
  if (!existsSync(dir)) throw new Error(`专题不存在: ${pretty}`)
  let real: string
  try {
    real = realpathSync(dir)
  } catch {
    throw new Error(`专题不存在: ${pretty}`)
  }
  assertInside(root, real)
  return dir
}

/**
 * 安全解析「待创建」的专题目录（upload 用）：词法校验 + realpath 严格子路径包含。
 * 与 resolveSafeTopic 不同：专题可以尚不存在（upload 会 mkdir 创建），但已存在的条目
 * （目录/文件/符号链接）仍必须 realpath 落在 dataDir 之内——挡住「data/evil → 库外」这类
 * 符号链接逃逸写。返回可直接 mkdir/writeFile 的目录路径（join 后的路径，非 realpath）。
 */
export function resolveUploadTopic(dataDir: string, topic: string): string {
  // 逐段校验（方案 §B2.2）：每一段都过既有的命名规范类校验，再逐段解析——
  // 这样「父链里任何一段是符号链接/逃逸」都在段一级被挡住，而不是只查整串。
  const segs = topicSegments(topic)
  const root = realDataDir(dataDir)
  let cur = root
  for (const seg of segs) {
    const next = join(cur, seg)
    let st
    try {
      st = lstatSync(next) // lstat 不跟随符号链接：悬空链接也算「已存在」，交给 realpath 兜底
    } catch {
      // 该段尚不存在：mkdir(recursive) 会创建真实目录（逐段词法层已保证无分隔符/../隐藏名）
      return join(root, ...segs)
    }
    if (st.isSymbolicLink()) throw new Error(`路径越界：专题目录是符号链接，已拒绝：${segs.join('/')}`)
    if (!st.isDirectory()) throw new Error(`路径越界：专题路径不是目录：${segs.join('/')}`)
    let real: string
    try {
      real = realpathSync(next)
    } catch {
      throw new Error(`专题不存在: ${segs.join('/')}`)
    }
    assertInside(root, real)
    cur = next
  }
  return join(root, ...segs)
}

/** 构造文献引用（不做存在性校验；给只按路径判定的调用方用，如翻译 busy 检查）。 */
export function paperRefFor(dataDir: string, topic: string, name: string): PaperRef {
  const pdfPath = paperPdfPath(dataDir, topic, name)
  const base = pdfPath.slice(0, -'.pdf'.length)
  return {
    topic,
    name,
    pdfPath,
    txtPath: base + '.txt',
    pagesPath: base + '.pages.json',
    transcriptPath: base + '.transcript.json',
    mineruMdPath: base + '.mineru.md',
    mineruJsonPath: base + '.mineru.json',
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 兼容适配器（薄壳）：只为上游 6 个 `library-*.test.mjs` 与老调用方保留上游的
// 函数签名 / 返回形状；底层永远是 library-manage 的加固实现
// （回收站可恢复 + 精确 stem + 非递归 rmdir；会话/翻译/在途 409 在路由层）。
// 每个适配器都**先过上面那一层**（词法 validateEntryName/validateEntryBoundary →
// realpath resolveSafeTopic），再交给加固层——顺序固定，两层的语义不互相替代。
// ═══════════════════════════════════════════════════════════════════════════

/** 边界层错误 → 带机器码的普通 Error（保留上游用例断言的 `e.message`）。 */
function boundaryError(message: string): Error {
  const err = new Error(message)
  ;(err as Error & { code?: string }).code = message.includes('路径越界') ? 'escape-rejected' : 'bad-name'
  return err
}

/** 删除文献（上游签名）：词法-边界层 + realpath 层 → 加固层移入 `.trash/`；返回被移动的文件名清单。 */
export function deletePaper(dataDir: string, topic: string, name: string): string[] {
  const errName = validateEntryBoundary(name)
  if (errName) throw boundaryError(errName)
  const topicName = topic.trim()
  resolveSafeTopic(dataDir, topicName)          // realpath 第二层：专题必须落在 dataDir 内
  return manage.deletePaper(dataDir, topicName, name).moved
}

/** 删除专题（上游签名）：仅空专题；隐藏条目进回收站；非递归 rmdir（绝无 rm -rf）。 */
export function deleteTopic(dataDir: string, topic: string): void {
  try {
    topicSegments(topic) // 逐段边界类校验（删除侧不卡命名规范）
  } catch (e) {
    throw boundaryError(e instanceof Error ? e.message : String(e))
  }
  const topicName = topic.trim()
  resolveSafeTopic(dataDir, topicName)
  manage.deleteTopic(dataDir, topicName)        // 非空 → 抛 409 topic-not-empty（我们的产品决策）
}

/** 重命名专题（上游签名）：`to` 走命名规范层，`from` 走 realpath 层。 */
export function renameTopic(dataDir: string, from: string, to: string): void {
  try {
    topicSegments(to) // `to` 是路径（移动/改名双向支持），逐段走命名规范类校验
  } catch (e) {
    throw boundaryError(e instanceof Error ? e.message : String(e))
  }
  const fromName = from.trim()
  const toName = to.trim()
  if (fromName === toName) return
  resolveSafeTopic(dataDir, fromName)
  manage.renameTopic(dataDir, fromName, toName)
}

/**
 * 重命名文献（上游签名）：返回**改名前的**文件名清单（上游用例据此断言，如 `['CaseA.pdf']`）。
 * `from` 走边界层（历史丑名也能改），`to` 走命名规范层；产物清单由加固层的精确 stem 匹配给出。
 */
export function renamePaper(dataDir: string, topic: string, from: string, to: string): string[] {
  const errTo = validateEntryName(to)
  if (errTo) throw boundaryError(errTo)
  const errFrom = validateEntryBoundary(from)
  if (errFrom) throw boundaryError(errFrom)
  const topicName = topic.trim()
  const fromName = from.trim()
  const toName = to.trim()
  if (fromName === toName) return []
  resolveSafeTopic(dataDir, topicName)
  const paperDirAbs = manage.resolveExistingPaperDir(dataDir, topicName, fromName)
  const before = manage.listArtifacts(paperDirAbs, fromName).map((f) => f.name)
  manage.renamePaper(dataDir, topicName, fromName, toName)
  return before
}
