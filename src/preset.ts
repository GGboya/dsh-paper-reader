// preset.ts — 把插件自带的「论文伴读」agent preset 安装到 dsh 用户预设根。
// 纯函数模块，不依赖 Cordis。dsh 的 preset 发现是每次实时扫描
// （$DSH_HOME/.agent-presets/<id>/，includeUserRoot 默认开），拷贝到位即生效，免重启。

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHome } from './library.ts'

export const PAPER_PRESET_ID = 'paper-reader'

/**
 * 把 presets/paper-reader/{preset.yml,agent.cordis.yml} 同步到
 * <dshHome>/.agent-presets/paper-reader/。幂等：内容一致不写盘。
 * 返回安装目录；写失败（权限等）返回 null，调用方回退到默认 preset。
 */
export async function installPaperPreset(packageRoot: URL): Promise<string | null> {
  const src = new URL('presets/paper-reader/', packageRoot)
  const destDir = join(dshHome(), '.agent-presets', PAPER_PRESET_ID)
  try {
    await mkdir(destDir, { recursive: true })
    for (const file of ['preset.yml', 'agent.cordis.yml']) {
      const content = await readFile(new URL(file, src))
      const dest = join(destDir, file)
      const existing = await readFile(dest).catch(() => null)
      if (existing === null || !existing.equals(content)) await writeFile(dest, content)
    }
    return destDir
  } catch (err) {
    console.warn('[dsh-paper-reader] agent preset 安装失败（回退默认 preset）:', err)
    return null
  }
}
