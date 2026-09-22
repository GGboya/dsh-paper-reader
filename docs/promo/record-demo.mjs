// dsh-paper-reader demo 录制脚本
// 用法: node record-demo.mjs [--dry]   (--dry 不录视频，只验证流程)
import { chromium } from 'playwright'

const DRY = process.argv.includes('--dry')
const BASE = 'http://127.0.0.1:PORT/?token=启动 dsh 时打印的 token'
const PAPER = 'mapreduce-2004'
const QUESTION = '这段话的核心思想是什么？用一两句话总结'
const PICK = 'programming model' // 摘要里的短语，选中它提问

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  ...(DRY ? {} : { recordVideo: { dir: '/tmp/dsh-demo-rec/video', size: { width: 1440, height: 900 } } }),
})
const page = await ctx.newPage()
page.setDefaultTimeout(30000)

// 假鼠标指针：Playwright 录像不含系统光标,注入一个跟随 mousemove 的圆点
// (init script 执行时 documentElement 可能还没建好,轮询安装)
await page.addInitScript(() => {
  const install = () => {
    if (!document.documentElement || document.getElementById('__cursor')) return
    const c = document.createElement('div')
    c.id = '__cursor'
    c.style.cssText = 'position:fixed;left:-100px;top:-100px;width:18px;height:18px;border-radius:50%;background:rgba(20,20,20,.8);border:2px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.45);z-index:2147483647;pointer-events:none;transition:width .1s,height .1s'
    ;(document.body || document.documentElement).appendChild(c)
    addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px' }, true)
    addEventListener('mousedown', () => { c.style.width = '11px'; c.style.height = '11px'; c.style.background = 'rgba(9,105,218,.9)' }, true)
    addEventListener('mouseup', () => { c.style.width = '18px'; c.style.height = '18px'; c.style.background = 'rgba(20,20,20,.8)' }, true)
  }
  const timer = setInterval(install, 200)
  setTimeout(() => clearInterval(timer), 30000)
})

console.log('1. 打开 dsh web')
await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await sleep(4000)
await page.screenshot({ path: '/tmp/dsh-demo-rec/step1-loaded.png' })

console.log('2. 点开「论文伴读」开关')
const toggle = page.locator('[data-dpr-mode]')
await toggle.waitFor({ state: 'visible', timeout: 20000 })
// 模拟人手：先移过去停一下再点
await toggle.hover()
await sleep(600)
await toggle.click()
await sleep(1200)

console.log('3. 点击论文', PAPER)
const paperItem = page.locator('[data-dsh-surface="sidebar"] >> text=' + PAPER).first()
await paperItem.waitFor({ state: 'visible', timeout: 15000 })
await paperItem.hover(); await sleep(500); await paperItem.click()

console.log('4. 等 PDF 渲染')
await page.screenshot({ path: '/tmp/dsh-demo-rec/step3-clicked.png' })
let frame = null
for (let i = 0; i < 40 && !frame; i++) {
  frame = page.frames().find((f) => f.url().includes('/paper-reader/'))
  if (!frame) await sleep(1000)
}
if (!frame) {
  console.log('frames:', page.frames().map((f) => f.url()))
  throw new Error('阅读器 iframe 未出现')
}
await frame.waitForSelector('.textLayer span', { timeout: 40000 })
await sleep(2500) // 让前几页渲染稳定

console.log('4.5 新建对话(干净的演示会话)')
try {
  const newBtn = page.locator('button[title="New chat"], button[title="新建对话"]').first()
  await newBtn.waitFor({ state: 'visible', timeout: 8000 })
  await newBtn.click()
  await sleep(3500)
} catch { console.log('   (没找到新建按钮,用现有会话)') }
await page.screenshot({ path: '/tmp/dsh-demo-rec/step4-pdf.png' })

console.log('5. 选中摘要里的短语:', PICK)
const span = frame.locator(`.textLayer span:has-text("${PICK}")`).first()
await span.scrollIntoViewIfNeeded()
await sleep(800)
const box = await span.boundingBox()
if (!box) throw new Error('span 不可见')
// 从短语起点拖到终点（一行的跨度）
await page.mouse.move(box.x + 2, box.y + box.height / 2, { steps: 10 })
await sleep(300)
await page.mouse.down()
await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 25 })
await sleep(300)
await page.mouse.up()
await sleep(800)
await page.screenshot({ path: '/tmp/dsh-demo-rec/step5-selected.png' })

console.log('6. 弹窗里输入问题并发送')
await frame.waitForSelector('#ask-pop', { state: 'visible', timeout: 8000 })
await sleep(500)
await frame.locator('#ask-input').click()
await frame.locator('#ask-input').pressSequentially(QUESTION, { delay: 55 })
await sleep(600)
await page.screenshot({ path: '/tmp/dsh-demo-rec/step6-ask.png' })
await frame.locator('#ask-send').click()
await sleep(1200)
// 防御:若弹窗因残留选区被重新打开,点阅读器灰色边距清选区关掉它
try {
  const visible = await frame.locator('#ask-pop').isVisible()
  if (visible) {
    await frame.locator('#pdf-pane').click({ position: { x: 5, y: 400 } })
    await sleep(400)
  }
} catch {}
console.log('   已发送,等待回答流出…')

console.log('7. 等回答里的页码链接')
const links = page.locator('a[href*="/paper-reader/"][href*="page="]')
const before = await links.count()
await page.waitForFunction(
  (n) => document.querySelectorAll('a[href*="/paper-reader/"][href*="page="]').length > n,
  before, { timeout: 120000 },
)
// 等流式结束（DOM 静止 3s）
await page.waitForFunction(
  () => new Promise((resolve) => {
    let timer
    const obs = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(() => { obs.disconnect(); resolve(true) }, 3000) })
    obs.observe(document.body, { childList: true, subtree: true, characterData: true })
    timer = setTimeout(() => { obs.disconnect(); resolve(true) }, 3000)
  }), null, { timeout: 120000, polling: 500 },
)
await sleep(800)
await page.screenshot({ path: '/tmp/dsh-demo-rec/step7-answer.png' })

console.log('8. 点击页码链接 → 跳回 PDF 高亮')
const link = links.last()
await link.scrollIntoViewIfNeeded(); await sleep(600)
await link.hover(); await sleep(900) // 让观众看清鼠标在链接上
await link.click()
await sleep(1200) // 平滑滚动中
await sleep(3000) // 高亮闪烁,停留给观众看
await page.screenshot({ path: '/tmp/dsh-demo-rec/step8-jumped.png' })

console.log('9. 收尾:切中文版')
try {
  const zh = frame.locator('#zh-toggle')
  if (await zh.isVisible({ timeout: 3000 })) {
    await zh.click()
    await sleep(2500)
    await page.screenshot({ path: '/tmp/dsh-demo-rec/step9-zh.png' })
  } else console.log('   (中按钮不可见,跳过)')
} catch { console.log('   (切换失败,跳过)') }

await sleep(800)
await ctx.close() // 触发视频落盘
await browser.close()
console.log(DRY ? 'DRY RUN 完成' : '录制完成,视频在 /tmp/dsh-demo-rec/video/')
