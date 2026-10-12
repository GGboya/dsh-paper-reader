// test/fs-probe.mjs —— 平台能力探针（**非测试文件**：不匹配 npm test 的 `test/*.test.mjs` glob）
//
// 为什么要有它：跨平台期望值必须按**实测能力**分支，而不是硬编码 `process.platform`。
//   · macOS 默认 APFS 大小写不敏感，但完全可以格式化成大小写敏感的卷；
//   · Windows 的 NTFS 一般大小写不敏感，但每个目录都能单独开启大小写敏感（WSL 的 Per-directory flag）；
//   · rename 到「已存在的非空目录」的 errno 也随平台/文件系统变化（unix EISDIR/ENOTEMPTY → 我们的
//     契约是 500 trash-move-failed；Windows EPERM → 契约是 409 file-busy 的占用语义）。
// 所以这里全都实测一次，结果按目录缓存。

import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const caseCache = new Map()
let chmodCache
let renameErrnoCache

/**
 * 实测 `dir`（默认 `tmpdir()`）所在的文件系统是否**大小写不敏感**。
 * 做法：建 `<probe>/CaseProbe`，再问 `<probe>/caseprobe` 是否存在。
 *
 * 注意：探针建在 `dir` 的**子目录**里并在 `finally` 里删掉——绝不在被测数据目录里留残留。
 */
export function caseInsensitiveFs(dir = tmpdir()) {
  if (caseCache.has(dir)) return caseCache.get(dir)
  const probe = mkdtempSync(join(dir, 'dpr-fsprobe-'))
  let insensitive
  try {
    writeFileSync(join(probe, 'CaseProbe'), 'probe')
    insensitive = existsSync(join(probe, 'caseprobe'))
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
  caseCache.set(dir, insensitive)
  return insensitive
}

/**
 * 实测「把一个文件 rename 到一个**已存在的非空目录**上」抛出的 errno（成功则返回 `null`）。
 *
 * 这条实测对应「回收站里预置同名非空目录」这种**不依赖 chmod**的失败注入：
 *   · Linux → `EISDIR`/`ENOTEMPTY` … → 契约 500 `trash-move-failed`；
 *   · Windows → `EPERM` → 契约 409 `file-busy`（EBUSY/EPERM 是「占用」语义）。
 * 调用方据此决定期望的状态码，不再猜平台。
 */
export function renameOntoNonEmptyDirErrno() {
  if (renameErrnoCache !== undefined) return renameErrnoCache
  const d = mkdtempSync(join(tmpdir(), 'dpr-renprobe-'))
  try {
    const src = join(d, 'src.txt')
    const dst = join(d, 'dst.txt')
    writeFileSync(src, 'x')
    mkdirSync(dst)
    writeFileSync(join(dst, 'blocker'), 'x')
    try {
      renameSync(src, dst)
      renameErrnoCache = null // 该文件系统允许覆盖 → 视为「注入不生效」
    } catch (e) {
      renameErrnoCache = e?.code ?? 'UNKNOWN'
    }
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
  return renameErrnoCache
}

/** 契约映射（与 `src/library-manage.ts` 一致）：只有 EBUSY/EPERM 走 409 `file-busy`。 */
export const isBusyErrno = (code) => code === 'EBUSY' || code === 'EPERM'

/**
 * 跨平台的「相对回收站路径」判定：形如 `.trash/<stamp>-<hex>`（Windows 上是 `.trash\<stamp>-<hex>`）。
 * 用它替代 `x.startsWith('.trash/')` —— 后者在 Windows 上必然失败（分隔符是反斜杠）。
 */
export function isTrashRelPath(p) {
  if (typeof p !== 'string' || p.length === 0) return false
  if (p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:/.test(p)) return false // 必须是相对路径
  const segs = p.split(/[\\/]/)
  return segs.length >= 2 && segs[0] === '.trash' && segs.every((x) => x.length > 0)
}

/**
 * 实测「把目录设为只读（chmod 0o555）之后，里面的文件还能不能被 rename 走」。
 *   · POSIX（ext4/APFS）：不能 → 可用于「回收站移动失败」的注入；
 *   · Windows：chmod 只映射「只读位」，不阻止 rename → 不能。
 * 调用方据此选注入方式（而不是硬编码平台）。
 */
export function chmodBlocksRename(dir = tmpdir()) {
  if (chmodCache !== undefined) return chmodCache
  const d = mkdtempSync(join(dir, 'dpr-chmodprobe-'))
  try {
    const sub = join(d, 'sub')
    mkdirSync(sub)
    writeFileSync(join(sub, 'f.txt'), 'x')
    chmodSync(sub, 0o555)
    try {
      renameSync(join(sub, 'f.txt'), join(d, 'moved.txt'))
      chmodCache = false
    } catch {
      chmodCache = true
    } finally {
      try { chmodSync(sub, 0o755) } catch { /* 已不可改也无需恢复 */ }
    }
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
  return chmodCache
}

/**
 * 实测「当前文件系统能否把 0x00-0x1F 控制字符放进文件名」。
 *   · Win32 路径层禁止 → false（历史遗留的控制字符名在那类平台根本造不出来）；
 *   · POSIX → true。
 * 探针建在给定目录的**子目录**里并即时清理，不留残留。
 */
export function canStoreControlName(dir = tmpdir()) {
  const probe = mkdtempSync(join(dir, 'dpr-ctrlprobe-'))
  try {
    mkdirSync(join(probe, 'weird\u0001name'))
    return true
  } catch {
    return false
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
}
