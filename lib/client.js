// dsh-paper-reader — BROWSER half（全部走官方 seam 组合，零自绘聊天）。
//
// 布局组合：
//   [侧栏: 专题→论文→会话 树]  [主区: 原生 dsh 对话(论文会话)]  [rightbar: PDF 页签]
//   - sidebar.workspaces single slot 按 priority -1000 接管（lowest renders）——
//     ⚠️ 官方工作区/会话列表在本 profile 侧栏不可见；本插件面向论文伴读专用 profile，
//     从 cordis.patch.yml 删掉本插件即恢复官方工作区。
//   - 原生对话 = uiWorkspace.openSession(论文会话)，流式/工具卡/审批全是官方 UI。
//   - PDF 页签 = sidebarRightTabs 注册 tab 类型 + sidebar.right.pane.tab 挂内容 +
//     sidebarRight.openTab 打开；内容即宿主路由 /paper-reader/ 的阅读器 iframe。
//   - 选中即问：阅读器内选中 → /api/ask 注入当前会话 → 原生对话区实时流出。
//
// 加载机制：package.json 声明 dsh.client.inject + exports["./client"]；require 解析
// 官方客户端包，不要用裸 import。

window.__ModuleLoader__.load({
  id: 'dsh-paper-reader',
  factory: (require) => {
    const React = require('react')
    const { useState, useEffect, useCallback } = React
    const h = React.createElement

    const NS = 'dsh-paper-reader'
    const zh = {
      nav: '论文伴读', readerTitle: '论文伴读 — PDF 阅读器', library: '文献库',
      empty: '文献库为空', hint: '新建专题或上传 PDF 开始', newTopic: '新建专题',
      upload: '上传 PDF 到此专题', newChat: '新建对话', session: '会话', pdfTab: '论文 PDF',
    }
    const en = {
      nav: 'Paper Reader', readerTitle: 'Paper Reader — PDF viewer', library: 'Library',
      empty: 'Library is empty', hint: 'Create a topic or upload a PDF to start', newTopic: 'New topic',
      upload: 'Upload PDF into this topic', newChat: 'New chat', session: 'Session', pdfTab: 'Paper PDF',
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

    async function api(path, opts) {
      const r = await fetch('/paper-reader/api' + path, opts)
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || ('HTTP ' + r.status))
      return r.json()
    }

    /* ---------- 主面板：沉浸式整页阅读 ---------- */
    function ReaderPanel() {
      const ref = useCallback((el) => {
        window.__dprOpenPaper = el ? (topic, name) => el.contentWindow?.dpr?.openPaper(topic, name) : undefined
      }, [])
      useEffect(() => () => { window.__dprOpenPaper = undefined }, [])
      return h('iframe', {
        ref, src: '/paper-reader/', title: t('readerTitle'),
        'data-dsh-plugin': 'dsh-paper-reader', 'data-dsh-surface': 'main-panel',
        style: { display: 'block', width: '100%', height: '100%', border: 'none', background: 'var(--dsw-alias-bg-layer-1, #f6f7f9)' },
      })
    }

    function ReaderIcon(props) {
      const size = (props && props.size) || 18
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
      },
        h('path', { d: 'M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z' }),
        h('path', { d: 'M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z' }),
      )
    }

    /* ---------- rightbar PDF 页签 ---------- */
    function PdfTab() {
      const read = () => JSON.parse(localStorage.getItem('dpr.last') || 'null')
      const [cur, setCur] = useState(read)
      useEffect(() => {
        const on = (e) => setCur({ topic: e.detail.topic, name: e.detail.name })
        window.addEventListener('dpr:paper', on)
        return () => window.removeEventListener('dpr:paper', on)
      }, [])
      if (!cur) return h('div', { style: { padding: '16px', fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #656d76)' } }, '← 从文献库选择一篇论文')
      const src = `/paper-reader/?topic=${encodeURIComponent(cur.topic)}&name=${encodeURIComponent(cur.name)}`
      return h('iframe', {
        key: src, src, title: t('pdfTab'),
        'data-dsh-plugin': 'dsh-paper-reader', 'data-dsh-surface': 'rightbar-tab',
        style: { display: 'block', width: '100%', height: '100%', border: 'none', background: 'var(--dsw-alias-bg-layer-1, #f6f7f9)' },
      })
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
    }

    function LibraryTree(props) {
      const { layout, uiWorkspace, sidebarRight } = props
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

      // 打开 PDF 页签。openTabIn 对「store 未收养」的会话是静默 no-op（不抛错），
      // 所以轮询重试；revealIfOpened 让重复调用幂等（已开则仅 reveal，不重复开）。
      const openPdfTab = useCallback((sessionId) => {
        let tries = 12
        const tick = () => {
          try { sidebarRight.openTabIn(sessionId, 'dpr-reader', { revealIfOpened: true }) } catch { /* 未绑定则下轮再来 */ }
          if (--tries > 0) setTimeout(tick, 500)
        }
        tick()
      }, [sidebarRight])

      // 进入伴读：激活论文会话（原生对话）+ 开 PDF 页签 + 同步阅读器
      const enter = useCallback(async (topic, name, n) => {
        let list = sessions[`${topic}/${name}`]
        if (!list) {
          try {
            const d = await api(`/sessions?topic=${encodeURIComponent(topic)}&name=${encodeURIComponent(name)}`)
            list = d.sessions
            setSessions((m) => ({ ...m, [`${topic}/${name}`]: d.sessions }))
          } catch { list = [] }
        }
        let target = n ? list.find((s) => s.n === n) : list[list.length - 1]
        if (!target) {
          target = await api('/sessions/new', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ topic, name }),
          })
          setSessions((m) => ({ ...m, [`${topic}/${name}`]: [...(m[`${topic}/${name}`] || []), target] }))
        }
        setCur({ topic, name })
        setCurrentPaper(topic, name, target.n)
        window.__dprOpenPaper?.(topic, name) // 若整页阅读面板开着也同步
        uiWorkspace.openSession(target.sessionId) // 原生对话区切到该会话
        openPdfTab(target.sessionId)
      }, [sessions, uiWorkspace, openPdfTab])

      const newChat = useCallback(async (topic, name) => {
        const created = await api('/sessions/new', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ topic, name }),
        })
        await loadSessions(topic, name)
        enter(topic, name, created.n)
      }, [enter, loadSessions])

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
          headers: { 'x-dpr-topic': uploadTopic.current, 'x-dpr-name': file.name, 'content-type': 'application/pdf' },
          body: file,
        }).then(async (r) => {
          if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || ('HTTP ' + r.status))
        }).catch((err) => window.alert('上传失败: ' + err.message))
        refresh()
      }, [refresh])

      const topics = lib?.topics ?? []
      const papers = lib?.papers ?? []

      return h('div', { style: S.root, 'data-dsh-plugin': 'dsh-paper-reader', 'data-dsh-surface': 'sidebar' },
        h('input', { ref: fileInput, type: 'file', accept: '.pdf', style: { display: 'none' }, onChange: onFile }),
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
                const key = `${p.topic}/${p.name}`
                const isActive = cur && cur.topic === p.topic && cur.name === p.name
                const pSessions = sessions[key] || []
                return h('div', { key: p.name },
                  h('div', {
                    style: { ...S.item, ...(isActive ? S.active : {}) },
                    title: p.name,
                    onClick: () => enter(p.topic, p.name),
                    onMouseEnter: () => loadSessions(p.topic, p.name),
                  }, '📄 ', h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' } }, p.name)),
                  // 展开会话列表（已激活的论文显示其会话）
                  isActive && h('div', { style: { marginLeft: '18px' } },
                    pSessions.map((s) => h('div', {
                      key: s.n,
                      style: { ...S.item, ...S.sessionItem },
                      onClick: () => enter(p.topic, p.name, s.n),
                    },
                      s.running ? h('span', { style: S.running }, '●') : h('span', null, '·'),
                      ` ${t('session')} ${s.n}`,
                    )),
                    h('div', {
                      style: { ...S.item, ...S.sessionItem },
                      onClick: () => newChat(p.topic, p.name),
                    }, '＋ ', t('newChat')),
                  ),
                )
              }),
            ),
          )
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

          // 整页阅读面板（沉浸式看 PDF，不含聊天——聊天看原生对话区）
          ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main', key: 'paper-reader', locale: NS,
          }, ReaderPanel))
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist', id: 'paper-reader', order: 60,
            label: () => bound('nav'), locale: NS,
          }, ReaderIcon))

          // rightbar PDF 页签类型 + 内容
          ctx.effect(() => ctx.sidebarRightTabs.register({
            id: 'dpr-reader', kind: 'dpr-reader', title: () => bound('pdfTab'),
          }), 'dsh-paper-reader: tab type')
          console.log('[dpr] tab type registered')
          ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab', key: 'dpr-reader', locale: NS,
          }, PdfTab))

          // 侧栏中部：专题→论文→会话 树
          ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({
            name: 'sidebar.workspaces', priority: -1000, locale: NS,
          }, function LibrarySection() {
            return h(LibraryTree, {
              layout: ctx.layout, uiWorkspace: ctx.uiWorkspace, sidebarRight: ctx.sidebarRight,
            })
          }))
        } catch (e) {
          console.error('[dsh-paper-reader] client apply failed:', e)
        }
      },
    }
  },
})
