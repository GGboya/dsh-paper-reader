// dsh-paper-reader — BROWSER half（全部走官方 seam 组合，零自绘聊天）。
//
// 布局组合（用户习惯：中间论文、最右对话）：
//   [侧栏: 专题→论文→会话 树]  [中间: PDF 阅读器]  [最右: 原生 dsh 对话]
//   - 原生对话组件绑定 main（keyed 'conversation'），无法挪进 rightbar；
//     PDF 页签内容挂在 rightbar。于是做**视觉换位**：PDF 页签存在时，把 rightbar
//     列钉到 grid 第 2 轨（宽轨=阅读器），center 列自动流入第 3 轨（窄轨=对话）。
//     纯 CSS grid 放置技巧：JS 只维护 grid-template-columns 的列宽（宽轨给 PDF、
//     窄轨给对话，正是想要的比例），内容换列不影响拖拽手柄/全屏/折叠逻辑。
//   - sidebar.workspaces single slot 按 priority -1000 接管（lowest renders）——但**按需**：
//     「论文伴读模式」默认关闭，侧栏底部 footer.action 开关行点击才注册（再点注销，
//     还原官方工作区列表），localStorage 记忆。安装后官方侧栏原样，只多一行开关。
//   - 选中即问：阅读器内选中 → /api/ask 注入当前会话 → 原生对话区实时流出。
//
// 加载机制：package.json 声明 dsh.client.inject + exports["./client"]；require 解析
// 官方客户端包，不要用裸 import。

window.__ModuleLoader__.load({
  // 必须等于 npm 包名：浏览器端 loader 按包名期待注册（改名时漏改这里 →
  // "loaded without registering" 整页插件加载失败，实测）
  id: '@ggboy123/dsh-paper-reader',
  factory: (require) => {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const { useState, useEffect, useCallback } = React
    const h = React.createElement

    const NS = 'dsh-paper-reader'
    const zh = {
      library: '文献库',
      empty: '文献库为空', hint: '新建专题或上传 PDF 开始', newTopic: '新建专题',
      upload: '上传 PDF 到此专题', newChat: '新建对话', session: '会话', pdfTab: '论文 PDF',
      history: '历史对话',
      sync: '对话还停在另一篇文献的会话里，点击切到当前文献',
      mode: '论文伴读', modeEnterTip: '进入论文伴读：左侧变为文献库树', modeExitTip: '退出论文伴读：恢复官方工作区列表',
      settings: '论文伴读',
      setRerankTitle: '检索重排（Jev）',
      setRerankDesc: 'search_paper 检索的语义重排：关键词先捞候选，Jev 逐个判断「这段能否回答这个问题」再排序——大白话提问也能命中论文里的术语段落。不配则退回纯关键词排序。',
      setTranslateTitle: '翻译端点',
      setTranslateDesc: '「生成中文版」（babeldoc）用的 OpenAI 兼容端点，三项必填。保存前会先测连接。',
      setBaseUrl: '端点 URL', setModel: '模型', setKey: 'API Key',
      setSave: '测试并保存', setSaving: '测试连接中…', setClear: '清除自填配置',
      setSaved: '已保存，立即生效', setCleared: '已清除，回落到部署方默认',
      setKeyKeep: '留空沿用已保存的 ', setOptional: '可选',
      setSourceFile: '当前来源：设置页', setSourceProfile: '当前来源：配置文件（部署方默认）',
      setSourceEnv: '当前来源：环境变量', setSourceNone: '未配置',
    }
    const en = {
      library: 'Library',
      empty: 'Library is empty', hint: 'Create a topic or upload a PDF to start', newTopic: 'New topic',
      upload: 'Upload PDF into this topic', newChat: 'New chat', session: 'Session', pdfTab: 'Paper PDF',
      history: 'Chat history',
      sync: 'Chat is still on another paper — click to switch to the current one',
      mode: 'Paper Reading', modeEnterTip: 'Enter paper-reading mode: sidebar becomes the library tree', modeExitTip: 'Exit paper-reading mode: restore the official workspace list',
      settings: 'Paper Reader',
      setRerankTitle: 'Search rerank (Jev)',
      setRerankDesc: 'Semantic rerank for search_paper: keyword search shortlists candidates, Jev judges "can this passage answer the question" and reorders — plain-language questions hit terminology passages. Without it, plain keyword ranking is used.',
      setTranslateTitle: 'Translate endpoint',
      setTranslateDesc: 'OpenAI-compatible endpoint for "Generate Chinese version" (babeldoc). All three fields required. Connection is tested before saving.',
      setBaseUrl: 'Endpoint URL', setModel: 'Model', setKey: 'API Key',
      setSave: 'Test & save', setSaving: 'Testing…', setClear: 'Clear my config',
      setSaved: 'Saved, effective immediately', setCleared: 'Cleared, falling back to deployment defaults',
      setKeyKeep: 'Leave empty to keep saved ', setOptional: 'optional',
      setSourceFile: 'Source: settings page', setSourceProfile: 'Source: config file (deployment default)',
      setSourceEnv: 'Source: environment variable', setSourceNone: 'Not configured',
    }

    let t = (k) => k
    const setT = (fn) => { t = fn }

    /* ---------- 共享状态桥（树 / PDF 页签 / 阅读器 iframe 三方同步） ---------- */
    const sessionKey = (topic, name) => `dpr.sessionN.${topic}/${name}`
    function setCurrentPaper(topic, name, n) {
      localStorage.setItem('dpr.last', JSON.stringify({ topic, name }))
      localStorage.setItem(sessionKey(topic, name), String(n))
      window.dispatchEvent(new CustomEvent('dpr:paper', { detail: { topic, name, n } }))
    }

    /* ---------- 会话消息里的阅读器跳转链接 ----------
       agent 引用页码时给 [文字](http://<host>/paper-reader/?topic=..&name=..&page=N)
       （dsh 渲染器对 http(s) 链接加 target=_blank，capture 拦截是应用内跳转的唯一窗口）。
       同论文 → 阅读器 iframe 原地跳页：不重载文档，用户正在看中文版就落在中文版该页；
       跨论文/iframe 未就绪 → setCurrentPaper 换论文，页码经 pendingJumpPage 挂上 src，
       阅读器 bootstrap 直达目标页。 */
    let readerIframeEl = null
    let pendingJump = null // { page, q }：跨论文/iframe 未就绪时挂上 src，由阅读器 bootstrap 消费
    function jumpToPaperPage(topic, name, page, q) {
      // 阅读器页签若关着尽量展开（seat 未绑定时静默失败，跳转本身仍生效）
      try { clientApi?.sidebarRight?.openTab('dpr-reader', { revealIfOpened: true }) } catch {}
      const cur = JSON.parse(localStorage.getItem('dpr.last') || 'null')
      const tp = topic || cur?.topic, nm = name || cur?.name
      if (!tp || !nm) return
      const win = readerIframeEl?.contentWindow
      if (cur && tp === cur.topic && nm === cur.name && win?.dpr?.jumpPage) {
        win.dpr.jumpPage(page, q || undefined)
        return
      }
      pendingJump = { page, q }
      setCurrentPaper(tp, nm, cur && tp === cur.topic && nm === cur.name ? cur.n : 0)
    }

    async function api(path, opts) {
      const r = await fetch('/paper-reader/api' + path, opts)
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        throw new Error(body.error || body.reason || ('HTTP ' + r.status))
      }
      return r.json()
    }

    /* ---------- 会话切换护栏：PDF/网格全程冻结，只允许对话区换内容 ----------
       rightbar.session 是 session 作用域 slot，切会话 = seat 整体重挂：
       旧 seat 卸载时汇报 closeRightbar，新 seat 初挂时 surface 尚未建立也汇报
       closed → 右栏轨道塌 0 → 对话列（钉在第 3 轨）消失、PDF 列（第 2 轨）撑满
       → 换位按轨宽撤钉 → openTab 再撑开 = 用户看到的"整个页面跟着动"（逐帧实测）。
       预开路径救不了新建会话：openTabIn 对未被 adopt 的 store 恒静默 no-op
       （新建会话要等成为当前会话才 adopt，实测创建后等 2.5s 仍 no-op），
       而非当前会话的 surface 又没有任何 API 可读 → 无法验证预开是否生效。
       于是反向兜底，切换窗口（1.5s）内三件事：
       ① 吞掉 layout.closeRightbar 汇报 —— grid 冻在当前轨道（openRightbar 照放）；
       ② ReaderOverlay 锚点测量/几何冻结 —— 锚点被重绑带着消失/滑动都是暂态
         （applySwap 照跑：新面板的 maxWidth 钳制要尽快钉上，防左溢盖侧栏）；
       ③ [data-rightbar-instant] 连带杀掉面板 transform 过渡（官方只管 grid/handle）。
       窗口结束对账：若右栏面板确实没开着（护栏期间被收起/开页签失败），
       补一次真实 close，让 grid 回到真状态。 */
    const SWITCH_GUARD_MS = 1500
    let switching = false
    let switchTimer = 0
    let realCloseRightbar = null
    let layoutService = null

    function beginSwitchGuard() {
      switching = true
      document.querySelector('[data-rightbar-col]')?.parentElement?.setAttribute('data-rightbar-instant', '')
      if (layoutService && realCloseRightbar === null && typeof layoutService.closeRightbar === 'function') {
        realCloseRightbar = layoutService.closeRightbar
        layoutService.closeRightbar = () => {}
      }
      clearTimeout(switchTimer)
      switchTimer = setTimeout(() => {
        switching = false
        document.querySelector('[data-rightbar-col]')?.parentElement?.removeAttribute('data-rightbar-instant')
        if (!layoutService || realCloseRightbar === null) return
        layoutService.closeRightbar = realCloseRightbar
        const panelOpen = !!document.querySelector('[data-sidebar-right-panel][data-sidebar-right-open]')
        realCloseRightbar = null
        if (!panelOpen) {
          try { layoutService.closeRightbar() } catch { /* 上下文已销毁 */ }
        }
      }, SWITCH_GUARD_MS)
    }

    /* ---------- 阅读器悬浮层：一个跨会话永不重建的 iframe ----------
       rightbar 页签内容跟随会话 seat 重绑整体重建（TabSlot 以 tab.id 为 key，
       新会话的 rightbar 布局里没有旧 tab）——iframe 每次重载，滚动/缩放全丢
       （"新建对话整页都动"）。改为：PdfTab 只渲染占位锚点；真正的 iframe 由
       ReaderOverlay 常驻渲染（挂在 LibraryTree 下，不随会话变），fixed 覆盖在锚点矩形上，
       200ms 轮询跟随；锚点消失（关页签/收右栏/全屏）时隐藏但 iframe 存活。 */
    function ReaderOverlay() {
      const [cur, setCur] = useState(() => JSON.parse(localStorage.getItem('dpr.last') || 'null'))
      const [geo, setGeo] = useState({ visible: false, left: 0, top: 0, width: 0, height: 0 })
      const lastShownRef = React.useRef(0)
      useEffect(() => {
        const on = (e) => {
          // 跳转链接挂的页码/引文（jumpToPaperPage 的跨论文路径）：随 src 传给阅读器 bootstrap
          const j = pendingJump
          pendingJump = null
          setCur({ topic: e.detail.topic, name: e.detail.name, page: j?.page, q: j?.q })
        }
        window.addEventListener('dpr:paper', on)
        return () => window.removeEventListener('dpr:paper', on)
      }, [])
      useEffect(() => {
        let alive = true
        // 布局换位：rightbar 列(PDF) ↔ center 列(对话) 交换视觉位置。列+行都钉
        // （auto-placement 只钉列会重叠/塌行，实测）；面板锚列右缘且内联宽度=rightbar
        // 配置宽度，列进窄轨会左溢盖侧栏 → 钉 max-width（⚠️ 不抢 width：dsh 在会话 store
        // 每次提交都重写内联 width，互写同属性 = 持续闪烁，实测）。
        // 钉住条件按**右栏轨宽**自判断：右栏折叠（第 3 轨≈0）时撤钉 —— 否则 seat 重绑的
        // 空窗期 PDF 列会吃掉对话列的宽度，双双消失又出现（"整屏闪"，实测）。
        const setStyle = (el, prop, val) => { if (el.style[prop] !== val) el.style[prop] = val }
        const applySwap = () => {
          const col = document.querySelector('[data-rightbar-col]')
          const center = col?.previousElementSibling // DOM 序固定：sidebar | center | rightbar
          const frame = col?.parentElement
          if (!col || !center || !frame) return
          const tracks = getComputedStyle(frame).gridTemplateColumns.split(' ').map(parseFloat)
          const eff = (tracks[2] ?? 0) >= 50 && !frame.hasAttribute('data-rightbar-fullscreen')
          // 所有写入带值守卫：重复写同值也会触发样式重算，200ms 轮询下会闪
          setStyle(col, 'gridColumn', eff ? '2' : '')
          setStyle(col, 'gridRow', eff ? '1' : '')
          setStyle(center, 'gridColumn', eff ? '3' : '')
          setStyle(center, 'gridRow', eff ? '1' : '')
          const panel = col.querySelector('[data-sidebar-right-panel]')
          if (!panel) return
          setStyle(panel, 'maxWidth', eff ? '100%' : '')
          // dsh 把面板内联宽度写成 cols.rightbar 且锚在列右缘。换位后 col 落在 1fr 轨，
          // 拖窄对话列时该轨会比配置宽度**宽**——面板不撑满就缩在列右半边，锚点跟着跑，
          // 阅读器整个右移并变窄（实测 x=800 w=300，而列是 280..1100）。
          // 只补 minWidth，不碰 width：dsh 每次会话提交都重写内联 width，抢同一属性会持续闪烁。
          setStyle(panel, 'minWidth', eff ? '100%' : '')
        }
        const tick = () => {
          if (!alive) return
          // 切换护栏期：锚点测量/overlay 几何冻结 —— 锚点消失、被面板 transform
          // 带着滑动、未钳制时左溢错位，都是 seat 重绑的暂态，追着跑 = overlay 乱跳
          // （实测）。只冻结"正在显示"的场景；首开（从未显示过）不冻结，PDF 照常出现。
          const frozen = switching && lastShownRef.current && Date.now() - lastShownRef.current < 5000
          if (!frozen) {
            const anchor = document.querySelector('[data-dsh-surface="rightbar-tab-anchor"]')
            let next = null
            if (anchor) {
              const r = anchor.getBoundingClientRect()
              if (r.width > 50 && r.height > 50) {
                next = { visible: true, left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
              }
            }
            // 锚点消失只藏不拆，且隐藏带 900ms 迟滞：seat 重绑的百毫秒间隙里
            // PDF 保持原位显示，不闪（iframe 常驻存活，拆了再挂就重载丢滚动）
            setGeo((prev) => {
              if (next) {
                lastShownRef.current = Date.now()
                return (prev.visible && prev.left === next.left && prev.top === next.top && prev.width === next.width && prev.height === next.height) ? prev : next
              }
              if (prev.visible && Date.now() - lastShownRef.current < 900) return prev
              return prev.visible ? { ...prev, visible: false } : prev
            })
          }
          // applySwap 冻结期照跑（值守卫幂等）：新 seat 的面板是全新 DOM，宽度钳制
          // （maxWidth）必须尽快钉上，否则面板按内联宽左溢盖住侧栏（实测锚点 x=168）
          applySwap()
        }
        tick()
        const timer = setInterval(tick, 200)
        return () => { alive = false; clearInterval(timer) }
      }, [])
      if (!cur) return null
      const src = `/paper-reader/?topic=${encodeURIComponent(cur.topic)}&name=${encodeURIComponent(cur.name)}${cur.page ? '&page=' + cur.page : ''}${cur.q ? '&q=' + encodeURIComponent(cur.q) : ''}`
      return createPortal(
        h('iframe', {
          ref: (el) => { readerIframeEl = el },
          src, title: t('pdfTab'),
          'data-dsh-plugin': 'dsh-paper-reader', 'data-dsh-surface': 'reader-overlay',
          style: {
            position: 'fixed', left: geo.left + 'px', top: geo.top + 'px',
            width: geo.width + 'px', height: geo.height + 'px', border: 'none',
            // 不用 display:none（布局归零会把 iframe 内滚动位置清零）；visibility 保留布局
            visibility: geo.visible ? 'visible' : 'hidden',
            pointerEvents: geo.visible ? 'auto' : 'none',
            // z-index 低于 overlayLayer(20) 与按钮组(45)：不挡拖拽手柄和弹层
            zIndex: 10, background: 'var(--dsw-alias-bg-layer-1, #f6f7f9)',
          },
        }),
        document.body,
      )
    }

    /* ---------- rightbar PDF 页签（只剩占位锚点 + 布局换位） ---------- */
    function PdfTab() {
      // 真正的阅读器是 ReaderOverlay 的常驻 iframe；这里只提供定位锚点
      const hasPaper = !!localStorage.getItem('dpr.last')
      return h('div', {
        'data-dsh-surface': 'rightbar-tab-anchor',
        style: { width: '100%', height: '100%' },
      }, hasPaper ? null : h('div', { style: { padding: '16px', fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #656d76)' } }, '← 从文献库选择一篇论文'))
    }

    /* ---------- 对话列头部的 [🕐历史 / ＋新建] 浮动按钮组 ----------
       官方 header.actions 是 session 作用域 slot，动态包（ModuleLoader）注册的条目
       不被渲染（实测：register 成功但零渲染）——退化为 fixed 浮动组，portal 到 body，
       200ms 轮询对齐对话列头部右侧原生按钮的左缘；仅当前会话是伴读会话（dpr-）时显示。
       历史点开下拉：该论文全部会话（真实标题+日期），点哪条进哪条。 */
    function parseDprSession(sid) {
      if (typeof sid !== 'string' || !sid.startsWith('dpr-')) return null
      try {
        const body = sid.slice(4)
        const m = body.match(/-(\d+)$/)
        const n = m ? +m[1] : 1
        const b64 = (m ? body.slice(0, -m[0].length) : body).replaceAll('-', '+').replaceAll('_', '/')
        const bin = atob(b64)
        const decoded = decodeURIComponent([...bin].map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''))
        const sep = decoded.indexOf('/')
        if (sep <= 0 || sep === decoded.length - 1) return null
        return { topic: decoded.slice(0, sep), name: decoded.slice(sep + 1), n }
      } catch { return null }
    }

    function SessionActions(props) {
      const { uiWorkspace } = props
      const [curSid, setCurSid] = useState(null)
      const [anchor, setAnchor] = useState(null) // {top, right} | null
      const [open, setOpen] = useState(false)
      const [list, setList] = useState(null)
      const btnRef = React.useRef(null)
      const popRef = React.useRef(null)
      const [popPos, setPopPos] = useState(null)

      // 轮询：当前会话 + 对话列头部锚点（跟随换位/拖拽/折叠/会话切换）
      useEffect(() => {
        let alive = true
        const tick = () => {
          if (!alive) return
          let next = null
          let docked = null
          try {
            const snap = uiWorkspace.sessions?.list?.getSnapshot?.()
            const cur = snap?.current ?? null
            setCurSid((prev) => (prev === cur ? prev : cur))
            const col = document.querySelector('[data-rightbar-col]')?.previousElementSibling
            const conv = col?.querySelector('[data-phase]')
            if (col && conv && typeof cur === 'string' && cur.startsWith('dpr-')) {
              const r = col.getBoundingClientRect()
              if (r.width > 200) {
                // 贴头部右端：preset 徽标之右、系统控件（utilities/corner，哪个可见用哪个）之左；
                // 给该控件加 margin-left 腾出 80px 空隙（flex 行内原生腾位，不压任何文字）
                const vis = (el) => (el && el.getBoundingClientRect().width > 0 ? el : null)
                const dock = vis(col.querySelector('[class*="headerUtilities"]')) || vis(col.querySelector('[class*="headerCorner"]'))
                const leftEdge = dock ? dock.getBoundingClientRect().left : r.right - 12
                if (dock && dock.style.marginLeft !== '80px') { dock.dataset.dprPad = '1'; dock.style.marginLeft = '80px' }
                docked = dock
                next = { top: Math.round(r.top + 10), right: Math.round(window.innerWidth - leftEdge + 6) }
              }
            }
            if (!next) {
              const padded = document.querySelector('[data-dpr-pad]')
              if (padded) { delete padded.dataset.dprPad; padded.style.marginLeft = '' }
            }
          } catch { /* 目录未就绪 */ }
          setAnchor((prev) => (prev && next && prev.top === next.top && prev.right === next.right) || (!prev && !next) ? prev : next)
        }
        tick()
        const timer = setInterval(tick, 200)
        return () => {
          alive = false
          clearInterval(timer)
          const padded = document.querySelector('[data-dpr-pad]')
          if (padded) { delete padded.dataset.dprPad; padded.style.marginLeft = '' }
        }
      }, [uiWorkspace])

      // 阅读器当前文献（dpr.last 恢复 + 跟随 dpr:paper）。侧栏点论文只保证阅读器切换，
      // 会话列切换是尽力而为（activateSession 轮询 6s 后静默放弃）——两者可能脱钩：
      // 此时「历史/新建」若跟着会话列走，会在用户正看的另一篇论文上建会话（实测踩坑）。
      // 这里以「正在看的文献」为准；脱钩时给 ⚠ 一键对齐入口（把会话列切回当前文献）。
      const [viewed, setViewed] = useState(() => {
        try { return JSON.parse(localStorage.getItem('dpr.last') || 'null') } catch { return null }
      })
      useEffect(() => {
        const on = (e) => setViewed({ topic: e.detail.topic, name: e.detail.name, n: e.detail.n })
        window.addEventListener('dpr:paper', on)
        return () => window.removeEventListener('dpr:paper', on)
      }, [])

      const chatPaper = parseDprSession(curSid)
      const paper = viewed || chatPaper
      const mismatch = !!(chatPaper && viewed && viewed.topic && (chatPaper.topic !== viewed.topic || chatPaper.name !== viewed.name))
      const activeN = chatPaper?.n ?? paper?.n

      // 下拉打开时拉该论文的会话列表；点外面关闭
      useEffect(() => {
        if (!open || !paper) return undefined
        setList(null)
        api(`/sessions?topic=${encodeURIComponent(paper.topic)}&name=${encodeURIComponent(paper.name)}`)
          .then((d) => setList(d.sessions)).catch(() => setList([]))
        const onDown = (e) => {
          if (popRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return
          setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [open, paper?.topic, paper?.name])

      if (!paper || !anchor) return null

      let titles = {}
      try {
        const snap = uiWorkspace.sessions?.list?.getSnapshot?.()
        for (const s of list ?? []) {
          const title = snap?.byId?.[s.sessionId]?.title
          if (title) titles[s.sessionId] = title
        }
      } catch { /* 标题不可读时用 会话N */ }

      const iconBtn = {
        width: '28px', height: '28px', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '14px',
        display: 'grid', placeItems: 'center',
        color: 'var(--dsw-alias-label-tertiary, #656d76)',
        background: 'var(--dsw-alias-bg-base, #fff)',
      }

      return createPortal(
        h('div', {
          'data-dsh-plugin': 'dsh-paper-reader', 'data-dsh-surface': 'session-actions',
          style: { position: 'fixed', top: anchor.top + 'px', right: anchor.right + 'px', display: 'flex', gap: '2px', zIndex: 45 },
        },
          mismatch && h('button', {
            style: { ...iconBtn, color: 'var(--dsw-alias-state-warn, #d29922)' },
            title: t('sync'),
            onClick: () => window.dispatchEvent(new CustomEvent('dpr:enter', { detail: { topic: viewed.topic, name: viewed.name } })),
          }, '⚠'),
          h('button', {
            ref: btnRef, style: iconBtn, title: t('history'),
            onClick: () => {
              if (!open && btnRef.current) {
                const r = btnRef.current.getBoundingClientRect()
                setPopPos({ top: Math.round(r.bottom + 6), right: Math.round(window.innerWidth - r.right) })
              }
              setOpen(!open)
            },
          }, '🕐'),
          h('button', {
            style: iconBtn, title: t('newChat'),
            onClick: () => window.dispatchEvent(new CustomEvent('dpr:newchat', { detail: { topic: paper.topic, name: paper.name } })),
          }, '＋'),
          open && createPortal(
            h('div', {
              ref: popRef,
              'data-dsh-plugin': 'dsh-paper-reader', 'data-dsh-surface': 'session-history',
              style: {
                position: 'fixed', top: (popPos?.top ?? 40) + 'px', right: (popPos?.right ?? 20) + 'px',
                minWidth: '220px', maxWidth: '320px', maxHeight: '50vh', overflowY: 'auto', zIndex: 90,
                background: 'var(--dsw-alias-bg-base, #fff)', border: '.5px solid var(--dsw-alias-border-l3, #e2e5ea)',
                borderRadius: '10px', boxShadow: '0 8px 30px rgba(0,0,0,.14)', padding: '4px',
              },
            },
              list === null
                ? h('div', { style: { padding: '10px 12px', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #656d76)' } }, '…')
                : list.map((s) => {
                    const active = s.n === activeN
                    return h('div', {
                      key: s.sessionId,
                      onClick: () => {
                        setOpen(false)
                        if (!active) window.dispatchEvent(new CustomEvent('dpr:enter', { detail: { topic: paper.topic, name: paper.name, n: s.n } }))
                      },
                      style: {
                        padding: '7px 10px', borderRadius: '7px', cursor: 'pointer', fontSize: '13px',
                        color: active ? 'var(--dsw-alias-state-business-primary, #0969da)' : 'var(--dsw-alias-label-primary, #24292f)',
                        background: active ? 'var(--dsw-alias-bg-active, rgba(9,105,218,.10))' : 'none',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      },
                    },
                      (s.running ? '● ' : '') + (titles[s.sessionId] || `${t('session')} ${s.n}`),
                      h('span', { style: { float: 'right', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #656d76)', marginLeft: '12px' } },
                        s.updatedAt ? new Date(s.updatedAt).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }) : ''),
                    )
                  }),
            ),
            document.body,
          ),
        ),
        document.body,
      )
    }

    /* ---------- 侧栏文献库树（接管 sidebar.workspaces） ---------- */
    const S = {
      root: { padding: '4px 0 12px', fontSize: '13px', color: 'var(--dsw-alias-label-primary, #24292f)' },
      head: { display: 'flex', alignItems: 'center', gap: '4px', padding: '8px 10px 6px', fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary, #656d76)' },
      iconBtn: { cursor: 'pointer', border: 'none', background: 'none', color: 'inherit', padding: '0 4px', fontSize: '13px', opacity: .75 },
      topicHead: { display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 8px', margin: '1px 6px 0', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, userSelect: 'none' },
      caret: { fontSize: '10px', color: 'var(--dsw-alias-label-secondary, #656d76)', transition: 'transform .12s', display: 'inline-block' },
      items: { marginLeft: '14px' },
      item: { display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 8px', margin: '0 6px', borderRadius: '6px', cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      active: { background: 'var(--dsw-alias-bg-active, rgba(9,105,218,.12))', color: 'var(--dsw-alias-label-action-primary, #0969da)', fontWeight: 600 },
      sessionItem: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #656d76)' },
      empty: { padding: '10px 12px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #656d76)', lineHeight: 1.6 },
      running: { color: 'var(--dsw-alias-state-success-primary, #1a7f37)', fontSize: '9px' },
      // 收起态（rail）：官方 rail 的控件是 36×36 圆形按钮、左对齐
      rail: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start' },
      railBtn: { width: '36px', height: '36px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'none', borderRadius: '50%', color: 'var(--dsw-alias-label-primary, #24292f)', cursor: 'pointer', fontSize: '17px', padding: '0' },
    }

    function LibraryTree(props) {
      const { layout, uiWorkspace, sidebarRight, wide, expandSidebar } = props
      const [lib, setLib] = useState(null)
      const [closed, setClosed] = useState(() => JSON.parse(localStorage.getItem('dpr.treeClosed') || '{}'))
      const [sessions, setSessions] = useState({}) // `${topic}/${name}` → [{n, sessionId, running}]
      const [cur, setCur] = useState(() => JSON.parse(localStorage.getItem('dpr.last') || 'null'))
      const fileInput = React.useRef(null)
      const uploadTopic = React.useRef('')

      const refresh = useCallback(() => {
        api('/library').then(setLib).catch(() => {})
      }, [])
      useEffect(() => {
        refresh()
        const timer = setInterval(refresh, 30000)
        return () => clearInterval(timer)
      }, [refresh])

      const loadSessions = useCallback((topic, name) => {
        api(`/sessions?topic=${encodeURIComponent(topic)}&name=${encodeURIComponent(name)}`)
          .then((d) => setSessions((m) => ({ ...m, [`${topic}/${name}`]: d.sessions })))
          .catch(() => {})
      }, [])

      // 打开 PDF 页签：等 rightbar seat 绑定到目标会话后只调一次 openTab（成功即停，
      // 不再轮询——否则用户关页签会被后续 tick 重开，「关很多次才能关掉」）。
      const openPdfTab = useCallback((sessionId) => {
        let tries = 30
        const tick = () => {
          try {
            if (sidebarRight.binding?.sessionId !== sessionId) throw new Error('seat-not-bound')
            sidebarRight.openTab('dpr-reader', { revealIfOpened: true })
          } catch {
            // 快轮询：seat 重绑一完成就开页签，把"面板空白"窗口压到最短
            if (--tries > 0) setTimeout(tick, 100)
          }
        }
        tick()
      }, [sidebarRight])

      // 激活会话：客户端会话目录（catalog）感知到新会话有时延，轮询到「已列出」再
      // openSession，并以 current === sessionId 为成功标准（否则原生对话区不切换）。
      const activateSession = useCallback((sessionId) => {
        let tries = 20
        const tick = () => {
          try {
            const snap = uiWorkspace.sessions?.list?.getSnapshot?.()
            if (snap && snap.current === sessionId) return // 已是当前会话
            const listed = !!(snap && (snap.byId?.[sessionId] || snap.ids?.includes(sessionId)))
            if (listed) uiWorkspace.openSession(sessionId)
            if (--tries > 0) setTimeout(tick, 300)
          } catch {
            if (--tries > 0) setTimeout(tick, 300)
          }
        }
        tick()
      }, [uiWorkspace])

      // 预开 PDF 页签到目标会话的 rightbar（在切换前）：先等客户端目录收录该会话
      // （否则 openTabIn 对未收编 store 静默 no-op），收录后 openTabIn 成功再切会话。
      // 不做这步的话，新会话的 rightbar 初始为空 → 列折叠 → openTab 再撑开
      // = PDF 消失又出现（实测逐帧确认）。
      const preOpenPdfTab = useCallback((sessionId, done) => {
        let tries = 30
        const tick = () => {
          try {
            const snap = uiWorkspace.sessions?.list?.getSnapshot?.()
            const listed = !!(snap && (snap.byId?.[sessionId] || snap.ids?.includes(sessionId)))
            if (listed) {
              // 对目录里早已存在的会话这步能真正预开（store 已 adopt）；
              // 对刚创建的会话恒 no-op —— 靠切换护栏兜底（见 beginSwitchGuard）。
              sidebarRight.openTabIn(sessionId, 'dpr-reader', { revealIfOpened: true })
              done?.()
              return
            }
          } catch { /* 目录未就绪 */ }
          if (--tries > 0) setTimeout(tick, 150)
          else done?.() // 兜底：超时也照常切（护栏 + openPdfTab 兜底路径）
        }
        tick()
      }, [sidebarRight, uiWorkspace])

      // 激活某个具体会话（原生对话区 + PDF 页签 + 阅读器同步）。纯函数式操作，不碰列表状态。
      const activate = useCallback((topic, name, target) => {
        // 离开的若是空白草稿（点了新建又没问任何问题）→ 后台归档，不留在会话列表里
        try {
          const snap = uiWorkspace.sessions?.list?.getSnapshot?.()
          const leaving = snap?.current
          if (leaving && typeof leaving === 'string' && leaving.startsWith('dpr-') && leaving !== target.sessionId
            && snap?.byId?.[leaving]?.blank && !snap.byId[leaving].running) {
            api('/sessions/archive', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId: leaving, topic, name }),
            }).then(() => loadSessions(topic, name)).catch(() => {})
          }
        } catch { /* 目录未就绪就不归档（host 侧对账会兜底） */ }
        setCur({ topic, name, n: target.n })
        setCurrentPaper(topic, name, target.n)
        // 切换护栏：冻结右栏轨道/阅读器几何/面板过渡，只有对话区换内容（见 beginSwitchGuard）
        beginSwitchGuard()
        preOpenPdfTab(target.sessionId, () => activateSession(target.sessionId))
        openPdfTab(target.sessionId)         // 兜底：seat 重绑后立即开页签（幂等 reveal）
      }, [activateSession, loadSessions, openPdfTab, preOpenPdfTab, uiWorkspace])

      // 进入伴读：永远拉最新会话列表（缓存的 sessions 可能过期）。
      // 只在「未指定会话且一个都没有」时才创建会话1；指定了 n 就绝不擅自新建（避免重复创建）。
      const enter = useCallback(async (topic, name, n) => {
        let list = []
        try {
          const d = await api(`/sessions?topic=${encodeURIComponent(topic)}&name=${encodeURIComponent(name)}`)
          list = d.sessions
          setSessions((m) => ({ ...m, [`${topic}/${name}`]: d.sessions }))
        } catch { /* 列表拉取失败按空处理 */ }
        let target = n ? list.find((s) => s.n === n) : list[list.length - 1]
        if (!target) {
          if (n) return // 指定的会话不存在，不做
          target = await api('/sessions/new', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ topic, name }),
          })
          setSessions((m) => ({ ...m, [`${topic}/${name}`]: [...(m[`${topic}/${name}`] || []), target] }))
        }
        activate(topic, name, target)
      }, [activate])

      // 新建对话：host 建好后直接激活它（不进 enter 的查找路径，杜绝二次创建）
      const newChat = useCallback(async (topic, name) => {
        const created = await api('/sessions/new', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ topic, name }),
        })
        const key = `${topic}/${name}`
        setSessions((m) => ({ ...m, [key]: [...(m[key] || []), created] }))
        activate(topic, name, created)
        loadSessions(topic, name) // 后台对账：让 host 的空白过滤把被顶替的旧空白会话收掉
      }, [activate, loadSessions])

      const newTopic = useCallback(async () => {
        const name = window.prompt(t('newTopic') + '：')
        if (!name?.trim()) return
        await api('/library/topic', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: name.trim() }),
        })
        refresh()
      }, [refresh])

      const upload = useCallback((topic) => {
        uploadTopic.current = topic
        fileInput.current?.click()
      }, [])

      const onFile = useCallback(async (e) => {
        const file = e.target.files?.[0]
        e.target.value = ''
        if (!file) return
        await fetch('/paper-reader/api/library/upload', {
          method: 'POST',
          // header 值只允许 ISO-8859-1：中文专题名/文件名必须先编码，否则 fetch 在发请求前就抛错
          headers: { 'x-dpr-topic': encodeURIComponent(uploadTopic.current), 'x-dpr-name': encodeURIComponent(file.name), 'content-type': 'application/pdf' },
          body: file,
        }).then(async (r) => {
          if (!r.ok) {
            const body = await r.json().catch(() => ({}))
            throw new Error(body.error || body.reason || ('HTTP ' + r.status))
          }
        }).catch((err) => window.alert('上传失败: ' + err.message))
        refresh()
      }, [refresh])

      const topics = lib?.topics ?? []
      const papers = lib?.papers ?? []

      // 对话头部按钮 → 树的既有动作（enter/newChat 闭包在这里）
      useEffect(() => {
        const onEnter = (e) => enter(e.detail.topic, e.detail.name, e.detail.n)
        const onNew = (e) => newChat(e.detail.topic, e.detail.name)
        window.addEventListener('dpr:enter', onEnter)
        window.addEventListener('dpr:newchat', onNew)
        return () => {
          window.removeEventListener('dpr:enter', onEnter)
          window.removeEventListener('dpr:newchat', onNew)
        }
      }, [enter, newChat])

      // 收起态（rail）：官方契约 —— sidebar.workspaces 在窄栏里只该给一个图标入口，点击请求
      // 宿主展开。整棵树不渲染：塞进 56px 会被挤成竖排文字（实测）。
      // 用 wide === false 而非 !wide：宿主万一没传这个 prop 时按展开态走，即改动前的行为。
      const tree = wide === false
        ? h('div', { style: S.rail },
            h('button', {
              type: 'button', style: S.railBtn, 'data-dpr-rail': '', title: t('library'),
              'aria-label': t('library'), onClick: () => expandSidebar && expandSidebar(),
            }, '📚'))
        : h(React.Fragment, null,
            h('div', { style: S.head },
              h('span', { style: { flex: 1 } }, t('library')),
              h('button', { style: S.iconBtn, title: t('newTopic'), onClick: newTopic }, '＋'),
              h('button', { style: S.iconBtn, title: 'refresh', onClick: refresh }, '⟳'),
            ),
            lib && topics.length === 0 && h('div', { style: S.empty }, `${t('empty')}: ${t('hint')}`),
            topics.map((topic) => {
              const isClosed = !!closed[topic]
              return h('div', { key: topic },
                h('div', {
                  style: S.topicHead,
                  onClick: () => {
                    const next = { ...closed, [topic]: !isClosed }
                    setClosed(next)
                    localStorage.setItem('dpr.treeClosed', JSON.stringify(next))
                  },
                },
                  h('span', { style: { ...S.caret, transform: isClosed ? 'rotate(-90deg)' : 'none' } }, '▾'),
                  h('span', { style: { flex: 1 } }, topic),
                  h('button', {
                    style: S.iconBtn, title: t('upload'),
                    onClick: (e) => { e.stopPropagation(); upload(topic) },
                  }, '⬆'),
                ),
                !isClosed && h('div', { style: S.items },
                  papers.filter((p) => p.topic === topic).map((p) => {
                    const isCurrentPaper = cur && cur.topic === p.topic && cur.name === p.name
                    return h('div', {
                      key: p.name,
                      style: { ...S.item, ...(isCurrentPaper ? S.active : {}) },
                      title: p.name,
                      onClick: () => enter(p.topic, p.name),
                    }, '📄 ', h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' } }, p.name))
                  }),
                ),
              )
            }),
          )

      return h('div', { style: S.root, 'data-dsh-plugin': 'dsh-paper-reader', 'data-dsh-surface': 'sidebar' },
        h('input', { ref: fileInput, type: 'file', accept: '.pdf', style: { display: 'none' }, onChange: onFile }),
        // 阅读器 iframe 与对话头部按钮组已迁往 shell.overlay 常驻注册（见 applyPaperMode 下方）——
        // 它们不属于侧栏，更不能跟着「退出伴读模式」被卸载（已打开的 PDF 页签要继续活着）
        tree,
      )
    }

    /* ---------- 论文伴读模式：默认不接管侧栏 ----------
       sidebar.workspaces 是 single slot，注册即遮蔽官方工作区列表——「一装就覆盖」
       对用户不礼貌。改为按需注册：默认不注册（官方侧栏原样），sidebar.footer.action
       （list slot，侧栏底部常驻）放一个开关行，点击注册/注销文献库树，localStorage 记忆。
       阅读器悬浮层/会话按钮组走 shell.overlay 常驻注册，与本开关无关——退出模式时
       已打开的 PDF 页签和伴读会话照常工作，随时可切回。 */
    let paperMode = localStorage.getItem('dpr.mode') === 'paper'
    let disposeLibrarySlot = null
    let clientApi = null // apply() 里注入 { slots, layout, uiWorkspace, sidebarRight }

    function applyPaperMode(on) {
      paperMode = on
      try { localStorage.setItem('dpr.mode', on ? 'paper' : '') } catch { /* 隐私模式写不了就算了 */ }
      if (!clientApi) return
      if (on && !disposeLibrarySlot) {
        clientApi.slots.inject('sidebar.workspaces', () => {
          disposeLibrarySlot = clientApi.slots.register({
            name: 'sidebar.workspaces', priority: -1000, locale: NS,
          }, function LibrarySection(slot) {
            return h(LibraryTree, {
              layout: clientApi.layout, uiWorkspace: clientApi.uiWorkspace,
              sidebarRight: clientApi.sidebarRight,
              wide: slot?.wide, expandSidebar: slot?.expandSidebar,
            })
          })
        })
      } else if (!on && disposeLibrarySlot) {
        disposeLibrarySlot()
        disposeLibrarySlot = null
      }
    }

    const MODE = {
      // 展开态：对齐官方 panelRow（36px 高、radius 8、hover 官方交互色）
      wide: { display: 'flex', alignItems: 'center', gap: '8px', width: '100%', minHeight: '36px', padding: '7px 8px', borderRadius: '8px', border: 'none', background: 'none', cursor: 'pointer', font: 'inherit', textAlign: 'left', color: 'var(--dsw-alias-label-secondary, #656d76)' },
      wideOn: { background: 'var(--dsw-alias-interactive-bg-active, rgba(9,105,218,.12))', color: 'var(--dsw-alias-label-primary, #24292f)', fontWeight: 600 },
      // 收起态（rail）：36×36 圆形图标钮，对齐官方 rail 控件
      rail: { width: '36px', height: '36px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%', border: 'none', background: 'none', cursor: 'pointer', font: 'inherit', color: 'var(--dsw-alias-label-primary, #24292f)' },
    }

    function PaperModeToggle(props) {
      const wide = props?.wide !== false
      const [on, setOn] = useState(paperMode)
      return h('button', {
        type: 'button', 'data-dsh-plugin': 'dsh-paper-reader', 'data-dsh-surface': 'paper-mode', 'data-dpr-mode': '',
        title: on ? t('modeExitTip') : t('modeEnterTip'),
        'aria-pressed': on ? 'true' : 'false',
        style: { ...(wide ? MODE.wide : MODE.rail), ...(on && wide ? MODE.wideOn : {}) },
        onClick: () => { applyPaperMode(!paperMode); setOn(paperMode) },
      }, wide ? h(React.Fragment, null, '📚', h('span', null, t('mode'))) : '📚')
    }

    /* ---------- 设置面板：Jev 重排 + 翻译端点统一管理 ----------
       settings.section 面板（与官方 通用设置/模型 同款缝）。两张端点卡片共用一套
       读写口（GET 掩码回显 / POST 预检后落盘 / DELETE 回落默认），key 明文永不回传，
       留空即沿用已保存的那把。保存即生效：宿主每次调用都现读配置文件。 */
    const SET = {
      card: { border: '1px solid var(--dsw-alias-border-l1, #30363d)', borderRadius: '10px', padding: '14px 16px', margin: '0 0 16px', background: 'var(--dsw-alias-bg-layer-1, #0d1117)' },
      title: { fontSize: '14px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #24292f)', margin: '0 0 4px' },
      desc: { fontSize: '12px', lineHeight: '1.6', color: 'var(--dsw-alias-label-secondary, #656d76)', margin: '0 0 12px' },
      label: { display: 'block', fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #656d76)', margin: '10px 0 4px' },
      input: { width: '100%', boxSizing: 'border-box', fontSize: '13px', padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l1, #30363d)', background: 'var(--dsw-alias-bg-layer-2, #161b22)', color: 'var(--dsw-alias-label-primary, #24292f)' },
      row: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '12px' },
      btn: { fontSize: '13px', padding: '6px 14px', borderRadius: '6px', border: 'none', cursor: 'pointer', background: 'var(--dsw-alias-button-primary-fill, #1f6feb)', color: 'var(--dsw-alias-label-primary-foreground, #fff)' },
      btnGhost: { fontSize: '12px', padding: '6px 10px', borderRadius: '6px', cursor: 'pointer', background: 'none', border: '1px solid var(--dsw-alias-border-l1, #30363d)', color: 'var(--dsw-alias-label-secondary, #656d76)' },
      ok: { fontSize: '12px', color: 'var(--dsw-alias-state-success-primary, #3fb950)' },
      err: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary, #f85149)' },
      meta: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #656d76)' },
    }

    function EndpointCard(props) {
      const [cfg, setCfg] = useState(null) // GET 结果（含 apiKeyHint/source）
      const [form, setForm] = useState({ baseUrl: '', model: '', apiKey: '' })
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState(null) // { ok, text }
      const load = useCallback(() => {
        api(props.path).then((d) => {
          setCfg(d)
          setForm({ baseUrl: d.baseUrl || '', model: d.model || '', apiKey: '' })
        }).catch((e) => setMsg({ ok: false, text: String(e.message || e) }))
      }, [props.path])
      useEffect(load, [load])
      const sourceText = !cfg ? '' : { file: t('setSourceFile'), profile: t('setSourceProfile'), env: t('setSourceEnv'), none: t('setSourceNone') }[cfg.source] || ''
      const save = async () => {
        setBusy(true); setMsg(null)
        try {
          await api(props.path, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(form),
          })
          setMsg({ ok: true, text: t('setSaved') })
          load()
        } catch (e) { setMsg({ ok: false, text: String(e.message || e) }) } finally { setBusy(false) }
      }
      const clear = async () => {
        setBusy(true); setMsg(null)
        try {
          await api(props.path, { method: 'DELETE' })
          setMsg({ ok: true, text: t('setCleared') })
          load()
        } catch (e) { setMsg({ ok: false, text: String(e.message || e) }) } finally { setBusy(false) }
      }
      const field = (key, label, placeholder, type) => h('div', null,
        h('label', { style: SET.label }, label, props.optional && key !== 'apiKey' ? `（${t('setOptional')}）` : ''),
        h('input', {
          style: SET.input, type: type || 'text', value: form[key], placeholder, disabled: busy,
          onChange: (e) => setForm({ ...form, [key]: e.target.value }),
        }),
      )
      return h('div', { style: SET.card, 'data-dsh-plugin': 'dsh-paper-reader', 'data-dsh-part': 'settings-card' },
        h('h3', { style: SET.title }, props.title),
        h('p', { style: SET.desc }, props.desc),
        field('baseUrl', t('setBaseUrl'), props.baseUrlPlaceholder),
        field('model', t('setModel'), props.modelPlaceholder),
        field('apiKey', t('setKey'), cfg?.hasApiKey ? t('setKeyKeep') + cfg.apiKeyHint : props.keyPlaceholder, 'password'),
        h('div', { style: SET.row },
          h('button', { type: 'button', style: SET.btn, disabled: busy, onClick: save }, busy ? t('setSaving') : t('setSave')),
          cfg?.source === 'file' ? h('button', { type: 'button', style: SET.btnGhost, disabled: busy, onClick: clear }, t('setClear')) : null,
          msg ? h('span', { style: msg.ok ? SET.ok : SET.err }, msg.text) : h('span', { style: SET.meta }, sourceText),
        ),
      )
    }

    function SettingsPanel() {
      return h('div', { style: { maxWidth: '560px' }, 'data-dsh-plugin': 'dsh-paper-reader', 'data-dsh-surface': 'settings-modal' },
        h(EndpointCard, {
          path: '/typesafe/config', title: t('setRerankTitle'), desc: t('setRerankDesc'), optional: true,
          baseUrlPlaceholder: 'https://api.typesafe.ai', modelPlaceholder: 'jev-latest', keyPlaceholder: 'ts-...',
        }),
        h(EndpointCard, {
          path: '/translate/config', title: t('setTranslateTitle'), desc: t('setTranslateDesc'),
          baseUrlPlaceholder: 'https://api.deepseek.com/v1', modelPlaceholder: 'deepseek-chat', keyPlaceholder: 'sk-...',
        }),
      )
    }

    return {
      inject: ['slots', 'locale', 'layout', 'uiWorkspace', 'sidebarRight', 'sidebarRightTabs'],
      apply(ctx) {
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-paper-reader: dicts')
          const bound = ctx.locale.bind(NS)
          setT(bound)

          // 切换护栏要挂到共享的 LayoutController 上（所有插件拿到的是同一实例）
          layoutService = ctx.layout
          // 官方 data-rightbar-instant 只瞬时化 grid 轨道和拖拽手柄；
          // 右栏面板自身是 transform 滑动过渡，补一条规则让它在切换窗口内也瞬时
          if (!document.getElementById('dpr-switch-instant')) {
            const styleEl = document.createElement('style')
            styleEl.id = 'dpr-switch-instant'
            styleEl.textContent = '[data-rightbar-instant] [data-sidebar-right-panel]{transition:none!important}'
            document.head.appendChild(styleEl)
          }
          // 自绘元素里 :hover 这类伪类内联 style 表达不了。内联仍写死态（注入失败时有个安全默认），
          // 这里用 !important 盖过内联给出 hover。
          if (!document.getElementById('dpr-surface-css')) {
            const styleEl = document.createElement('style')
            styleEl.id = 'dpr-surface-css'
            styleEl.textContent = '[data-dpr-rail]:hover,[data-dpr-mode]:hover{background:var(--dsw-alias-interactive-bg-hover)!important}'
            document.head.appendChild(styleEl)
          }

          // rightbar PDF 页签类型 + 内容
          ctx.effect(() => ctx.sidebarRightTabs.register({
            id: 'dpr-reader', kind: 'dpr-reader', title: () => bound('pdfTab'),
          }), 'dsh-paper-reader: tab type')
          ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab', key: 'dpr-reader', locale: NS,
          }, PdfTab))

          // 设置面板（设置 → 论文伴读）：Jev 重排 + 翻译端点统一管理
          ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section', id: 'dsh-paper-reader', order: 70,
            label: () => bound('settings'), locale: NS,
          }, SettingsPanel))

          clientApi = { slots: ctx.slots, layout: ctx.layout, uiWorkspace: ctx.uiWorkspace, sidebarRight: ctx.sidebarRight }

          // 阅读器跳转链接拦截（capture 阶段，一次绑定）：渲染器给 http(s) 链接加了
          // target=_blank，不拦会新开浏览器标签页 —— 拦下后交给应用内跳转
          if (!window.__dprJumpLinkBound) {
            window.__dprJumpLinkBound = true
            document.addEventListener('click', (e) => {
              const a = e.target?.closest?.('a[href*="/paper-reader/"]')
              if (!a) return
              let url
              try { url = new URL(a.href) } catch { return }
              const page = +(url.searchParams.get('page') || 0)
              if (!page) return
              e.preventDefault()
              e.stopImmediatePropagation()
              jumpToPaperPage(url.searchParams.get('topic'), url.searchParams.get('name'), page, url.searchParams.get('q') || '')
            }, true)
          }

          // 常驻浮层（与模式开关无关）：阅读器 iframe + 对话头部历史/新建按钮组。
          // shell.overlay 是官方钦定的整页浮层自留地（list slot，additive，不遮蔽任何人）。
          // （对话头部按钮不走 slot —— session 作用域 slot 不渲染动态包条目，只能自渲染。）
          ctx.slots.inject('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay', id: 'dpr-paper-overlays', locale: NS,
          }, function PaperOverlays() {
            return h(React.Fragment, null,
              h(ReaderOverlay, null),
              h(SessionActions, { uiWorkspace: clientApi?.uiWorkspace }),
            )
          }))

          // 侧栏底部常驻的模式开关行（list slot）——安装后官方侧栏原样，只是底部多一行
          // 「论文伴读」；点它才接管 workspaces 区，再点还原。
          ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
            name: 'sidebar.footer.action', id: 'dpr-paper-mode', locale: NS,
          }, PaperModeToggle))

          // 上次会话开过伴读模式的话恢复（默认/首次安装 = 关 = 官方侧栏）
          if (paperMode) applyPaperMode(true)
        } catch (e) {
          console.error('[dsh-paper-reader] client apply failed:', e)
        }
      },
    }
  },
})
