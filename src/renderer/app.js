'use strict'

/* ------------------------------------------------------------------------- *
 * ParallelRoom 渲染层
 *
 * 每个房间 = 一个 <webview>，全部挂在同一个 session partition 上，
 * 因此共享一份登录态，但各自是独立的渲染进程和独立的进房/心跳。
 * ------------------------------------------------------------------------- */

const gridEl = document.getElementById('grid')
const emptyEl = document.getElementById('empty')
const countEl = document.getElementById('count')
const inputEl = document.getElementById('add-input')
const formEl = document.getElementById('add-form')

let ua = ''
let partition = 'persist:douyin'
/* ------------------------------ 界面参数持久化 ------------------------------ */

/**
 * 观看/剪辑/监控页上的各种开关都存这里，下次打开和上次一致。
 * 用 localStorage（跟 pr.gridPreset / pr.monSort 同一套），不需要走主进程。
 */
const PREFS_KEY = 'pr.prefs'

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    return raw ? JSON.parse(raw) || {} : {}
  } catch {
    return {}
  }
}

function savePrefs(patch) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...patch }))
  } catch {}
}

const prefs = loadPrefs()

let isolate = false
/** 是否把盖在视频上的静态封面层揭开，让真实画面显示出来（只影响遮挡，不影响平台统计） */
let reveal = prefs.reveal !== false
/** 只看画面：把抖音自己的侧栏/飘屏弹幕/礼物栏/页头全部藏掉，只留视频铺满 */
let pure = prefs.pure !== false
/** 是否显示我们自己渲染的弹幕面板（默认关：只留画面，需要时再开） */
let showDanmu = prefs.danmu === true
/** 弹幕面板里是否也显示礼物信息（默认关：只显示聊天弹幕） */
let showGift = prefs.gift === true
/** 画质档位，加载后自动切换；空字符串=不干预（「不干预」这个选项本身也要记住） */
let quality = typeof prefs.quality === 'string' ? prefs.quality : '原画'
/** 单个房间的画质覆盖：{ [bareUrl]: 档位 }，没覆盖的跟随全局 quality */
let qualityOverrides = prefs.qualities && typeof prefs.qualities === 'object' ? { ...prefs.qualities } : {}
/** 画质可选项（顺序 = 菜单里的顺序） */
const QUALITY_CHOICES = ['原画', '蓝光', '超清', '高清', '标清', '']
const QUALITY_LABELS = { '': '不干预' }

/** 这个瓦片实际用的画质：有覆盖用覆盖，否则跟全局 */
function tileQuality(t) {
  if (!t) return quality
  const q = qualityOverrides[bareUrl(t.url)]
  return typeof q === 'string' ? q : quality
}

/** 弹幕面板的外观：行数 / 字号 / 位置（角） */
const DANMU_LINES = [4, 6, 8, 10, 12]
const DANMU_FONTS = [10, 11, 12, 13, 15, 17]
const DANMU_POS = [
  { key: 'bl', label: '左下' },
  { key: 'br', label: '右下' },
  { key: 'tl', label: '左上' },
  { key: 'tr', label: '右上' }
]
let danmuLines = DANMU_LINES.includes(Number(prefs.danmuLines)) ? Number(prefs.danmuLines) : 8
let danmuFont = DANMU_FONTS.includes(Number(prefs.danmuFont)) ? Number(prefs.danmuFont) : 11
let danmuPos = DANMU_POS.some((p) => p.key === prefs.danmuPos) ? prefs.danmuPos : 'bl'
/** 新打开的房间默认静音（记住上次「全静音」的选择） */
let muteByDefault = prefs.muteDefault === true
let seq = 0
let focusUid = null
let saveTimer = null

/**
 * @type {Map<string, {
 *   el: HTMLElement, view: any, overlay: HTMLElement, titleEl: HTMLElement,
 *   idxEl: HTMLElement, muteBtn: HTMLElement, url: string, muted: boolean, failed: boolean
 * }>}
 */
const tiles = new Map()

/* ------------------------------ 通用小菜单 ------------------------------ */
/*
 * 画质、弹幕设置都用这套：一个绝对定位的小面板，点外面就关。
 * 为什么不用原生 <select>：菜单项要带勾选状态、还要分组，原生 select 做不了。
 */

let popupEl = null

function closePopup() {
  if (!popupEl) return
  popupEl.remove()
  popupEl = null
  document.removeEventListener('pointerdown', onPopupOutside, true)
  window.removeEventListener('keydown', onPopupKey, true)
  window.removeEventListener('blur', closePopup)
  window.removeEventListener('resize', closePopup)
}

function onPopupOutside(e) {
  if (!popupEl) return
  if (popupEl.contains(e.target)) return
  closePopup()
}

function onPopupKey(e) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    closePopup()
  }
}

/**
 * @param {number} x 屏幕坐标
 * @param {number} y
 * @param {Array<{label:string, checked?:boolean, sub?:boolean, action?:Function, sep?:boolean}>} items
 * @param {string} [title]
 */
function showPopup(x, y, items, title) {
  closePopup()
  const box = document.createElement('div')
  box.className = 'pop-menu'
  if (title) {
    const h = document.createElement('div')
    h.className = 'pop-title'
    h.textContent = title
    box.appendChild(h)
  }
  for (const it of items) {
    if (it.sep) {
      const s = document.createElement('div')
      s.className = 'pop-sep'
      box.appendChild(s)
      continue
    }
    if (it.head) {
      const h = document.createElement('div')
      h.className = 'pop-head'
      h.textContent = it.head
      box.appendChild(h)
      continue
    }
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'pop-item' + (it.checked ? ' checked' : '') + (it.sub ? ' sub' : '')
    b.textContent = it.label
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      closePopup()
      if (it.action) it.action()
    })
    box.appendChild(b)
  }
  document.body.appendChild(box)
  // 贴边翻转：别让菜单跑出窗口
  const r = box.getBoundingClientRect()
  const left = Math.max(6, Math.min(window.innerWidth - r.width - 6, x))
  const top = Math.max(6, Math.min(window.innerHeight - r.height - 6, y))
  box.style.left = `${Math.round(left)}px`
  box.style.top = `${Math.round(top)}px`
  popupEl = box
  // 下一帧再挂"点外面关"，否则这次 pointerdown 会立刻把菜单关掉
  setTimeout(() => {
    document.addEventListener('pointerdown', onPopupOutside, true)
    window.addEventListener('keydown', onPopupKey, true)
    window.addEventListener('blur', closePopup)
    window.addEventListener('resize', closePopup)
  }, 0)
}

/** 画质菜单：给某个瓦片单独设，或者一键套到所有房间 */
function openQualityMenu(uid, x, y) {
  const t = tiles.get(uid)
  if (!t) return
  const cur = qualityOverrides[bareUrl(t.url)]
  const hasOverride = typeof cur === 'string'
  const label = (q) => QUALITY_LABELS[q] || q
  const items = [
    { label: `跟随全局（现在是「${label(quality) || '不干预'}」）`, checked: !hasOverride, action: () => setTileQuality(uid, null) },
    { sep: true }
  ]
  for (const q of QUALITY_CHOICES) {
    items.push({
      label: label(q),
      checked: hasOverride && cur === q,
      sub: true,
      action: () => setTileQuality(uid, q)
    })
  }
  items.push({ sep: true })
  items.push({
    label: '所有房间都用「' + (label(hasOverride ? cur : quality) || '不干预') + '」',
    action: () => applyQualityToAll(hasOverride ? cur : quality)
  })
  showPopup(x, y, items, `这个房间的画质 · ${describeTile(t)}`)
}

/** 设置某个瓦片的画质（null = 恢复跟随全局），并立刻生效 */
function setTileQuality(uid, q) {
  const t = tiles.get(uid)
  if (!t) return
  const key = bareUrl(t.url)
  if (q === null || q === undefined) delete qualityOverrides[key]
  else qualityOverrides[key] = q
  savePrefs({ qualities: qualityOverrides })
  applyTileQuality(uid)
}

/** 把所有房间的画质覆盖清掉，统一用 q（q 会同时成为全局默认） */
function applyQualityToAll(q) {
  qualityOverrides = {}
  quality = q
  savePrefs({ qualities: {}, quality })
  const sel = document.getElementById('quality-select')
  if (sel) sel.value = q
  for (const [uid] of tiles) applyTileQuality(uid)
  statusEl.textContent = `所有房间画质已设为「${QUALITY_LABELS[q] || q}」`
  setTimeout(() => {
    if (/^所有房间画质已设为/.test(statusEl.textContent || '')) statusEl.textContent = ''
  }, 2000)
}

/** 立刻把当前画质推给这个页面的 guest（不等看门狗那一拍） */
function applyTileQuality(uid) {
  const t = tiles.get(uid)
  if (!t || t.removed) return
  const q = tileQuality(t)
  if (!q) return
  Promise.resolve(t.view.executeJavaScript(guestScript(t.muted, true, t.volume, q), true)).catch(() => {})
}

/** 菜单标题里用的简短房间名 */
function describeTile(t) {
  const named = t.nameEl && t.nameEl.textContent
  return (named || roomLabel(t.url)).slice(0, 18)
}


function normalizeRoom(raw) {
  const s = String(raw || '').trim()
  if (!s) return null

  let url = null
  const explicit = s.match(/https?:\/\/[^\s"'<>，,、]+/i)
  if (explicit) {
    url = explicit[0]
  } else if (/^\d{5,}$/.test(s)) {
    url = `https://live.douyin.com/${s}`
  } else if (/^(www\.|live\.)?douyin\.com\//i.test(s.replace(/^\/+/, ''))) {
    url = `https://${s.replace(/^\/+/, '')}`
  } else {
    const digits = s.match(/\d{6,}/)
    if (digits) url = `https://live.douyin.com/${digits[0]}`
  }
  if (!url) return null

  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.toString()
  } catch {
    return null
  }
}

/**
 * 判断"是不是同一个房间"用的归一化。
 *
 * ⚠️ 原来只去了末尾斜杠 + 转小写，**没去 query**：
 * `live.douyin.com/123` 和 `live.douyin.com/123?enter_from=share` 会被当成两个房间，
 * 于是同一个直播间能开两个瓦片 → 同一路声音播两遍、延迟不同 → 听着就是回声。
 * 现在优先按房间号比较，认不出房间号才退回"去 query/hash"的 URL。
 */
const bareUrl = (u) => {
  const s = String(u || '').trim().toLowerCase()
  const m = s.match(/live\.douyin\.com\/(\d{5,})/)
  if (m) return `room:${m[1]}`
  // 虎牙用路径名当房间标识：huya.com/mingjie 和 www.huya.com/mingjie/ 是同一个房间
  const h = s.match(/huya\.com\/([a-z0-9_-]+)/)
  if (h) return `huya:${h[1]}`
  return s.split('#')[0].split('?')[0].replace(/\/+$/, '')
}

function roomLabel(url) {
  try {
    const u = new URL(url)
    const m = u.pathname.match(/\d{5,}/)
    if (m) return `房间 ${m[0]}`
    if (/huya\.com$/i.test(u.hostname)) {
      const name = u.pathname.replace(/^\/+|\/+$/g, '')
      return name ? `虎牙 ${name}` : '虎牙直播间'
    }
    return u.hostname
  } catch {
    return '直播间'
  }
}

function showOverlay(t, text, isError = false) {
  t.overlay.textContent = text
  t.overlay.classList.remove('hidden')
  t.overlay.classList.toggle('error', isError)
}

function hideOverlay(t) {
  t.overlay.classList.add('hidden')
  t.overlay.classList.remove('error')
}

function flashTile(uid) {
  const t = tiles.get(uid)
  if (!t) return
  t.el.classList.remove('flash')
  // 强制重排以便重复触发动画
  void t.el.offsetWidth
  t.el.classList.add('flash')
  setTimeout(() => t.el.classList.remove('flash'), 1000)
}

/* ------------------------------ 布局 ------------------------------ */

function bestGrid(n, w, h) {
  const target = 16 / 9
  let best = { cols: 1, rows: n, score: Number.POSITIVE_INFINITY }
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols)
    const cellW = w / cols
    const cellH = h / rows
    if (cellW <= 0 || cellH <= 0) continue
    const aspectScore = Math.abs(Math.log(cellW / cellH / target))
    const emptyPenalty = (cols * rows - n) * 0.25
    // 同等条件下偏向更多列：直播画面本身是竖屏，横向并排更实用
    const score = aspectScore + emptyPenalty - cols * 0.01
    if (score < best.score) best = { cols, rows, score }
  }
  return best
}

/** 观看页最多同时开多少个瓦片 */
const MAX_TILES = 12
/** 全屏自动布局时一屏最多显示几行 */
const FS_ROWS_PER_SCREEN = 2

/** 布局预设：'auto' 或 { cols, rows }（rows = 每屏行数） */
let gridPreset = 'auto'
try {
  const saved = localStorage.getItem('pr.gridPreset')
  // 'focus' = 中间大 · 周围小（聚焦布局）
  if (saved === 'focus' || (saved && saved !== 'auto' && /^\d+x\d+$/.test(saved))) gridPreset = saved
} catch {}

function parsePreset(preset) {
  if (!preset || preset === 'auto') return null
  const m = String(preset).match(/^(\d+)x(\d+)$/)
  if (!m) return null
  return { cols: Math.max(1, Number(m[1])), rows: Math.max(1, Number(m[2])) }
}

function pickCols(n, isFullscreen) {
  if (isFullscreen) {
    if (n <= 1) return 1
    if (n === 2) return 2
    return 3
  }
  if (n <= 1) return 1
  if (n <= 4) return 2
  if (n <= 9) return 3
  return 4
}

/* --------------------- 聚焦布局：中间大窗口 + 周围小窗口 --------------------- */
/*
 * 做法：只改 CSS 网格位置，绝不移动 DOM 节点 —— webview 被父节点重新插入就会重新
 * 加载，正在录制的房间会当场断流。所以「换到中间」= 改 grid-column / grid-row，
 * 同一个 webview 一直是同一个元素，画面不会重新拉流。
 *
 * 6 列网格：
 *   主画面占左边剩下的列，高度固定成"可视高度"，并且 position:sticky 钉在顶部
 *   小窗口**只有右侧一列**，宽度固定、高度固定；装不下就出竖向滚动条（滚动时主画面不跟着滚走）
 * 小窗口上面盖一层透明点击层：点一下就把这块换到中间。
 */

/** 中间大窗口里正在播的那个瓦片 */
let spotlightUid = null
/** 记住"上次放在中间的是哪个房间"（换布局/重开 App 后能找回来） */
let spotlightKey = ''
try {
  spotlightKey = localStorage.getItem('pr.spotlight') || ''
} catch {}

/** 右侧小窗列的宽度占网格宽度的比例（没拖过分隔条时用这个） */
const SPOTLIGHT_RAIL_RATIO = 0.16
/** 小窗高度 / 小窗宽度（0.72 ≈ 4:3 竖一点，能看清画面又不占太多） */
const SPOTLIGHT_THUMB_RATIO = 0.72

/** 用户拖过分隔条之后的宽度（px），0 = 没拖过，用默认比例 */
let railWidthPref = 0
try {
  const saved = Number(localStorage.getItem('pr.railW'))
  if (Number.isFinite(saved) && saved > 0) railWidthPref = saved
} catch {}

function pickSpotlightUid() {
  if (spotlightUid && tiles.has(spotlightUid)) return spotlightUid
  if (spotlightKey) {
    for (const [uid, t] of tiles) {
      if (bareUrl(t.url) === spotlightKey) return uid
    }
  }
  const first = tiles.keys().next()
  return first.done ? null : first.value
}

/** 把某个瓦片换到中间大窗口 */
function setSpotlight(uid) {
  if (!uid || !tiles.has(uid)) return
  spotlightUid = uid
  const t = tiles.get(uid)
  if (t) {
    spotlightKey = bareUrl(t.url)
    try {
      localStorage.setItem('pr.spotlight', spotlightKey)
    } catch {}
  }
  if (gridPreset === 'focus') layout()
}

/** 每个瓦片在舞台上的两个小挂件：点击层（拍一下换中间）、主画面角标 */
function ensureStageBits(t, uid, isMain) {
  if (!t.swapHit) {
    const hit = document.createElement('div')
    hit.className = 'swap-hit'
    hit.title = '点一下：换到中间大窗口'
    hit.addEventListener('click', (e) => {
      e.stopPropagation()
      setSpotlight(hit.dataset.uid)
    })
    t.stageEl.appendChild(hit)
    t.swapHit = hit
  }
  if (!t.mainTag) {
    const tag = document.createElement('div')
    tag.className = 'main-tag hidden'
    tag.textContent = '主画面'
    t.stageEl.appendChild(tag)
    t.mainTag = tag
  }
  t.swapHit.dataset.uid = uid
  t.swapHit.classList.toggle('hidden', isMain)
  t.mainTag.classList.toggle('hidden', !isMain)
}

/** 清掉一块瓦片上所有聚焦布局留下的内联样式（网格位置 + 主画面的 sticky） */
function resetSpotlightTile(t) {
  t.el.style.gridColumn = ''
  t.el.style.gridRow = ''
  t.el.style.position = ''
  t.el.style.top = ''
  t.el.style.height = ''
  t.el.style.alignSelf = ''
}

/** 退出聚焦布局时，把网格位置和挂件都还原 */
function clearSpotlight() {
  if (!gridEl.classList.contains('spotlight')) {
    // 类已经没了，但可能有残留的内联样式（例如中途切走布局）
    let dirty = false
    for (const t of tiles.values()) {
      if (t.el.style.gridColumn || t.el.style.gridRow || t.el.style.height) dirty = true
    }
    if (!dirty) return
  }
  gridEl.classList.remove('spotlight')
  gridEl.scrollTop = 0
  if (railGrip) railGrip.classList.add('hidden')
  for (const t of tiles.values()) {
    t.el.classList.remove('is-main', 'is-small')
    resetSpotlightTile(t)
    if (t.swapHit) t.swapHit.classList.add('hidden')
    if (t.mainTag) t.mainTag.classList.add('hidden')
  }
}

/** 当前实际用的小窗列宽（拖动分隔条时读它） */
let spotlightRailW = 0

function layoutSpotlight() {
  const n = tiles.size
  const mainUid = pickSpotlightUid()
  spotlightUid = mainUid
  gridEl.classList.toggle('spotlight', n > 0)
  if (!mainUid) return

  const entries = [...tiles.entries()]
  const smalls = entries.filter(([uid]) => uid !== mainUid)

  for (const [uid, t] of entries) {
    const isMain = uid === mainUid
    t.el.classList.toggle('is-main', isMain)
    t.el.classList.toggle('is-small', !isMain)
    resetSpotlightTile(t)
    ensureStageBits(t, uid, isMain)
  }

  const mainT = tiles.get(mainUid)
  if (!smalls.length) {
    // 只有一个房间：整屏给它（不需要分隔条）
    if (mainT) {
      mainT.el.style.gridColumn = '1 / -1'
      mainT.el.style.gridRow = '1 / -1'
      stickMain(mainT, 0)
    }
    if (railGrip) railGrip.classList.add('hidden')
    gridEl.style.gridTemplateColumns = '1fr'
    gridEl.style.gridTemplateRows = '1fr'
    gridEl.style.gridAutoRows = ''
    gridEl.style.overflowY = 'hidden'
    return
  }

  /*
   * 右侧只有**一列**小窗（不再分两列/三列），高度固定，装不下就出竖向滚动条。
   * 主画面跨满所有行 + position:sticky，所以右侧滚动时主画面不会跟着滚走。
   * 两边的宽度比例可以用分界线上那条拖拽条拉（记住到 localStorage.pr.railW）。
   */
  const gap = 6
  const padding = 12 // #grid 上下 padding
  const gridW = gridEl.clientWidth || 900
  const availH = Math.max(160, (gridEl.clientHeight || 700) - padding)
  const [minRail, maxRail] = railLimits(gridW)
  const autoRail = Math.round(gridW * SPOTLIGHT_RAIL_RATIO)
  const railW = railWidthPref
    ? Math.max(minRail, Math.min(maxRail, Math.round(railWidthPref)))
    : Math.min(maxRail, Math.max(minRail, autoRail))
  spotlightRailW = railW
  const thumbH = Math.min(280, Math.max(96, Math.round(railW * SPOTLIGHT_THUMB_RATIO)))
  const rowsFit = Math.max(1, Math.floor((availH + gap) / (thumbH + gap)))
  // 行数取"装得下的行数"和"小窗数"的较大值：小窗少时网格也铺满整屏，否则主画面会矮一截
  const rows = Math.max(rowsFit, smalls.length)
  const contentH = rows * thumbH + gap * (rows - 1)

  if (mainT) {
    mainT.el.style.gridColumn = '1'
    mainT.el.style.gridRow = '1 / -1'
    // 高度按"能看见的那一块"给，sticky 才有的可滚
    stickMain(mainT, availH)
  }

  smalls.forEach(([, t], i) => {
    t.el.style.gridColumn = '2'
    t.el.style.gridRow = String(i + 1)
  })

  const grip = ensureRailGrip()
  grip.classList.remove('hidden')
  grip.style.height = `${availH}px`

  gridEl.style.gridTemplateColumns = `minmax(0, 1fr) ${railW}px`
  gridEl.style.gridTemplateRows = `repeat(${rows}, ${thumbH}px)`
  gridEl.style.gridAutoRows = ''
  gridEl.style.overflowY = contentH > availH ? 'auto' : 'hidden'
}

/** 小窗列宽的上下限：太窄顶栏那排按钮会被裁掉，太宽主画面就没意义了 */
function railLimits(gridW) {
  // 212px：小窗顶栏的实测最小内容宽度是 206px（编号 16 + 开始 46 + 音量 40 + 四个 20 + 间距/padding）
  const minRail = Math.max(212, Math.round(gridW * 0.15))
  const maxRail = Math.max(minRail + 60, Math.round(gridW * 0.45))
  return [minRail, maxRail]
}

/* ------------------- 主画面 / 小窗 之间的拖拽分隔条 ------------------- */
/*
 * 只加一个绝对定位的小条，不包任何容器 —— 瓦片（webview）一律不动，
 * 拖动过程中只改 grid-template-columns，所以不会重新拉流。
 * 拖动时盖一层全屏 #rail-shield：指针划到视频区上方时事件本来会被 guest 吃掉。
 */

let railGrip = null
let railShield = null
let railDrag = null

function ensureRailGrip() {
  if (railGrip) return railGrip
  const el = document.createElement('div')
  el.className = 'rail-grip'
  el.title = '拖动调整主画面 / 小窗口的宽度比例（双击恢复默认）'
  el.addEventListener('pointerdown', startRailResize)
  el.addEventListener('dblclick', (e) => {
    e.stopPropagation()
    e.preventDefault()
    railWidthPref = 0
    try {
      localStorage.removeItem('pr.railW')
    } catch {}
    layoutSpotlight()
    statusEl.textContent = '小窗宽度已恢复默认'
    setTimeout(() => {
      if (statusEl.textContent === '小窗宽度已恢复默认') statusEl.textContent = ''
    }, 1800)
  })
  gridEl.appendChild(el)
  railGrip = el
  return el
}

function startRailResize(e) {
  if (gridPreset !== 'focus' || e.button !== 0) return
  e.preventDefault()
  e.stopPropagation()
  railDrag = {
    startX: e.clientX,
    startW: spotlightRailW || 200,
    x: e.clientX,
    moved: false,
    rafId: 0
  }
  if (!railShield) {
    railShield = document.createElement('div')
    railShield.id = 'rail-shield'
    railShield.addEventListener('pointermove', onRailResizeMove)
    railShield.addEventListener('pointerup', endRailResize)
    railShield.addEventListener('pointercancel', endRailResize)
    document.body.appendChild(railShield)
  }
  // 兜底：万一指针事件被别的东西吞了，窗口级的 up 也能收尾
  window.addEventListener('pointerup', endRailResize)
}

function onRailResizeMove(e) {
  const st = railDrag
  if (!st) return
  st.x = e.clientX
  if (!st.moved) {
    if (Math.abs(st.x - st.startX) < 2) return
    st.moved = true
    document.body.classList.add('rail-resizing')
  }
  if (e.cancelable) e.preventDefault()
  if (st.rafId) return
  st.rafId = requestAnimationFrame(() => {
    st.rafId = 0
    const cur = railDrag
    if (!cur) return
    applyRailWidth(cur.startW - (cur.x - cur.startX))
  })
}

function applyRailWidth(w) {
  const gridW = gridEl.clientWidth || 900
  const [minRail, maxRail] = railLimits(gridW)
  const next = Math.max(minRail, Math.min(maxRail, Math.round(w)))
  if (Math.abs(next - spotlightRailW) < 1) return
  railWidthPref = next
  layoutSpotlight()
}

function endRailResize() {
  const st = railDrag
  railDrag = null
  if (st && st.rafId) cancelAnimationFrame(st.rafId)
  document.body.classList.remove('rail-resizing')
  if (railShield) {
    railShield.remove()
    railShield = null
  }
  window.removeEventListener('pointerup', endRailResize)
  if (st && st.moved) {
    try {
      localStorage.setItem('pr.railW', String(Math.round(railWidthPref)))
    } catch {}
  }
}

/** 主画面：钉在滚动区顶部，高度 = 可视高度 */
function stickMain(t, heightPx) {
  if (heightPx > 0) {
    t.el.style.position = 'sticky'
    t.el.style.top = '0px'
    t.el.style.height = `${heightPx}px`
    t.el.style.alignSelf = 'start'
  } else {
    t.el.style.position = ''
    t.el.style.top = ''
    t.el.style.height = ''
    t.el.style.alignSelf = ''
  }
}

function layout() {
  const n = tiles.size
  applyOrder()
  emptyEl.classList.toggle('hidden', n > 0)

  if (n === 0) {
    clearSpotlight()
    gridEl.style.gridTemplateColumns = '1fr'
    gridEl.style.gridTemplateRows = '1fr'
    gridEl.style.gridAutoRows = ''
    gridEl.style.overflowY = 'hidden'
    return
  }

  const focusing = focusUid && tiles.has(focusUid)
  for (const [uid, t] of tiles) {
    t.el.classList.toggle('hidden', Boolean(focusing) && uid !== focusUid)
    t.el.classList.toggle('focused', Boolean(focusing) && uid === focusUid)
  }

  if (focusing) {
    clearSpotlight()
    gridEl.style.gridTemplateColumns = '1fr'
    gridEl.style.gridTemplateRows = '1fr'
    gridEl.style.gridAutoRows = ''
    gridEl.style.overflowY = 'hidden'
    return
  }

  if (gridPreset === 'focus') {
    layoutSpotlight()
    return
  }
  clearSpotlight()

  const isFullscreen = document.body.classList.contains('fs')
  const preset = parsePreset(gridPreset)

  let cols
  let rowsPerScreen
  if (preset) {
    // 用户指定了行列：每屏就按这个铺，多出来的行靠滚动
    cols = preset.cols
    rowsPerScreen = preset.rows
  } else {
    cols = pickCols(n, isFullscreen)
    const rows = Math.ceil(n / cols)
    // 全屏：一屏 2 行（最多 6 个）；非全屏：一屏放完
    rowsPerScreen = isFullscreen ? Math.min(FS_ROWS_PER_SCREEN, rows) : rows
  }

  const rows = Math.ceil(n / cols)
  const gap = 6
  const padding = 12 // #grid 上下 padding
  const availH = Math.max(160, (gridEl.clientHeight || 700) - padding)
  const perScreen = Math.min(rowsPerScreen, rows)
  const cellH = Math.max(120, Math.floor((availH - gap * (perScreen - 1)) / perScreen))

  gridEl.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`
  // 显式定义每一行的高度：只定义一行再用 auto-rows 会让多出来的行塌陷
  gridEl.style.gridTemplateRows = `repeat(${rows}, ${cellH}px)`
  gridEl.style.gridAutoRows = ''
  gridEl.style.overflowY = rows > perScreen ? 'auto' : 'hidden'
}

function refreshIndices() {
  let i = 1
  for (const t of tiles.values()) {
    t.idxEl.textContent = String(i++)
  }
}

function updateCount() {
  countEl.textContent = `${tiles.size} / ${MAX_TILES} 个房间`
}

/* ------------------------------ 静音 / 保活 ------------------------------ */

const WATCHDOG_MS = 4000

/**
 * 在 guest 页面里执行：保持视频处于播放状态，并让页面自身的 muted 与我们的
 * 磁贴静音状态一致（Chromium 层静音负责真正消音，页面 muted 负责别被自动播放策略拦住）。
 */
function guestScript(muted, applyQuality, volume, qualityOverride) {
  return `(() => {
    const vids = [...document.querySelectorAll('video')]
    const bodyText = (document.body && document.body.innerText) || ''
    const otherRoom = bodyText.includes('账号已在其他地方进入直播间')

    // 抖音会在"账号已在别处"时用静态封面盖住仍在播放的视频。
    // 只揭「面积接近视频、文本很短（封面上只有那行提示）」的绝对定位层，
    // 弹幕列表（长文本）和带输入框的容器一律不碰。
    let revealed = 0
    if (${reveal ? 'true' : 'false'} && vids.length) {
      try {
        const v = vids[0]
        const vr = v.getBoundingClientRect()
        const vArea = vr.width * vr.height
        if (vArea > 20000) {
          for (const el of document.querySelectorAll('div,img,section,picture')) {
            const cs = getComputedStyle(el)
            if (cs.position !== 'absolute' && cs.position !== 'fixed') continue
            if (el.contains(v) || v.contains(el)) continue
            const r = el.getBoundingClientRect()
            const area = r.width * r.height
            if (area < vArea * 0.6) continue
            if (el.querySelector('[contenteditable="true"],input,textarea,button')) continue
            const txt = (el.innerText || '').trim()
            if (txt.length > 200) continue
            if (el.dataset.prRevealed === '1') continue
            el.dataset.prRevealed = '1'
            el.style.visibility = 'hidden'
            revealed += 1
          }
        }
      } catch (e) {}
    }

    if (!vids.length) return { ok: false, reason: 'no-video', otherRoom, revealed, endedHit: '' }
    const v = vids[0]

    // 页面里的"已结束"文案：标题在下播后不会变，这句才是可靠判据
    const endedHit = (bodyText.match(/直播已结束|主播已下播|已下播|未开播|暂未开播/) || [''])[0]

    // 只看画面：沿 video 的祖先链把每一层的兄弟节点全藏掉
    // （这样右侧弹幕栏、底部礼物栏、飘屏弹幕层、页头一次性都去掉），再让视频铺满
    if (${pure ? 'true' : 'false'}) {
      try {
        let node = v
        for (let depth = 0; depth < 14; depth++) {
          const parent = node.parentElement
          if (!parent || parent === document.body) break
          for (const sib of parent.children) {
            if (sib === node) continue
            if (sib.dataset.prPure) continue
            let txtLen = 0
            try {
              txtLen = (sib.innerText || '').length
            } catch (e) {}
            if (txtLen > 120) {
              // 弹幕/礼物面板这类文字密集的区域：挪出视口，而不是 display:none。
              // 保持渲染状态，文字（包括 CSS 生成的冒号）才能被读到；但你看不见。
              sib.dataset.prPure = 'offscreen'
              sib.style.setProperty('position', 'fixed', 'important')
              sib.style.setProperty('left', '-30000px', 'important')
              sib.style.setProperty('top', '0', 'important')
              sib.style.setProperty('width', '320px', 'important')
              sib.style.setProperty('z-index', '-1', 'important')
            } else {
              sib.dataset.prPure = 'hidden'
              sib.style.setProperty('display', 'none', 'important')
            }
          }
          node = parent
        }
        const st = v.style
        st.setProperty('position', 'fixed', 'important')
        st.setProperty('inset', '0', 'important')
        st.setProperty('width', '100%', 'important')
        st.setProperty('height', '100%', 'important')
        st.setProperty('object-fit', 'contain', 'important')
        st.setProperty('background', '#000', 'important')
        st.setProperty('z-index', '2147483000', 'important')
        document.documentElement.style.setProperty('overflow', 'hidden', 'important')
        document.body.style.setProperty('background', '#000', 'important')
      } catch (e) {}
    }

    const want = ${muted ? 'true' : 'false'}
    if (v.muted !== want) v.muted = want
    // 一个页面里可能有多个 video：虎牙实测同时有主画面(横向) + 一个竖屏推荐浮窗，
    // 两个都出声就成了"两路声音混着响"。这里只留主画面出声，其余一律静音。
    try {
      for (let i = 1; i < vids.length; i++) {
        const ov = vids[i]
        if (ov && ov !== v && !ov.muted) ov.muted = true
      }
    } catch (e) {}
    // 每个房间独立的音量（抖音自己会把 volume 设成 0.6，所以每轮都要纠正回来）
    const wantVol = ${typeof volume === 'number' ? volume : 'null'}
    if (wantVol !== null) {
      try {
        const vv = Math.max(0, Math.min(1, wantVol))
        if (Math.abs((v.volume || 0) - vv) > 0.01) v.volume = vv
      } catch (e) {}
    }
    if (v.paused) v.play().catch(() => {})

    // 切画质：抖音把清晰度选项渲染在 DOM 里，直接对目标档位派发点击即可
    let qualityHit = 0
    const wantQuality = ${JSON.stringify(qualityOverride === undefined ? quality : qualityOverride)}
    if (${applyQuality ? 'true' : 'false'} && wantQuality) {
      try {
        const items = [...document.querySelectorAll('div,span,button,li,p,a')].filter(
          (e) => (e.textContent || '').trim() === wantQuality && e.children.length <= 2
        )
        for (const el of items) {
          el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
          el.click()
          qualityHit += 1
        }
      } catch (e) {}
    }

    // 抓弹幕/礼物：从页面渲染文本里取"昵称：内容"行。
    // 纯净模式下面板是被挪出视口而不是隐藏，所以它的文字仍然可读。
    let danmu = []
    if (${showDanmu ? 'true' : 'false'}) {
      try {
        const giftRe = /(送出|赠送|送了|投喂|加入了粉丝团|点亮了)/
        const items = bodyText
          .split('\\n')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((t) => ({ text: t, gift: giftRe.test(t) }))

        danmu = items
          .filter((it) => it.text.length > 2 && it.text.length < 120)
          .filter((it) => /^.{1,18}[:：]\\s*\\S/.test(it.text) || it.gift)
          .filter((it) => ${showGift ? 'true' : 'false'} || !it.gift)
          .map((it) => (it.gift ? '🎁 ' + it.text : it.text))
          .slice(-${danmuLines})
      } catch (e) {}
    }

    return { ok: true, paused: v.paused, t: Math.round(v.currentTime * 10) / 10, otherRoom, revealed, danmu, endedHit }
  })()`
}

const OTHER_ROOM_HOLD_MS = 90 * 1000

const DANMU_HOLD_MS = 45 * 1000

function renderDanmu(uid, lines) {
  const t = tiles.get(uid)
  if (!t || !t.danmuEl) return
  if (!showDanmu) {
    t.danmuEl.classList.add('hidden')
    t.danmuEl.textContent = ''
    t.danmuText = ''
    return
  }

  const hasNew = Array.isArray(lines) && lines.length > 0
  if (hasNew) {
    t.danmuAt = Date.now()
    const text = lines.join('\n')
    if (text !== t.danmuText) {
      t.danmuText = text
      t.danmuEl.textContent = text
    }
    t.danmuEl.classList.remove('hidden')
    return
  }

  // 这一轮没抓到（抖音虚拟列表会清空）时保留上次内容一段时间，避免面板闪没
  const fresh = t.danmuAt && Date.now() - t.danmuAt < DANMU_HOLD_MS
  if (fresh && t.danmuText) {
    t.danmuEl.classList.remove('hidden')
    return
  }
  t.danmuEl.classList.add('hidden')
  t.danmuEl.textContent = ''
  t.danmuText = ''
}

/**
 * 用瓦片页面里看到的事实反向修正监控状态。
 *
 * 为什么需要：探测是"加载整页 + 读文案"，但抖音直播间页在探测窗口里会把渲染线程卡死，
 * 读不到「直播已结束」，最后只能靠标题兜底 —— 而标题在下播后完全不变，于是误报"在播/刚开播"。
 * 瓦片里的页面 JS 是通的（弹幕就是每 4 秒读出来的），所以用它来纠偏最可靠。
 */
function reportTileStatus(uid, result) {
  const t = tiles.get(uid)
  if (!t) return
  const roomId = (String(t.url || '').match(/live\.douyin\.com\/(\d{5,})/) || [])[1] || ''
  // 抖音按房间号对账；其它站点（虎牙）没有房间号，就用整条 URL 对账
  const key = roomId || (platformOf(t.url) === 'huya' ? String(t.url).replace(/\/+$/, '') : '')
  if (!key) return

  let status = ''
  if (result.endedHit) status = 'offline'
  else if (result.ok && !result.paused && (result.t || 0) > 0) status = 'live'
  if (!status) return

  if (t.lastReported === status) return
  t.lastReported = status
  try {
    Promise.resolve(window.pr.reportRoomStatus({ roomId: key, url: t.url, status })).catch(() => {})
  } catch {}
}

function setOtherRoom(uid, flag) {
  const t = tiles.get(uid)
  if (!t) return
  const now = Date.now()
  if (flag) {
    t.otherAt = now
  } else if (!(t.otherAt && now - t.otherAt < OTHER_ROOM_HOLD_MS)) {
    t.otherAt = 0
  }
  // 平台这条提示是瞬时 toast，看到过就先记住，避免角标跟着闪
  const show = Boolean(t.otherAt)
  if (t.other === show) return
  t.other = show
  t.el.classList.toggle('other', show)
  t.badgeEl.classList.toggle('hidden', !show)
  t.badgeEl.title = show
    ? `抖音返回过「账号已在其他地方进入直播间」。画面照常播放，但这个账号的“当前直播间”被算在别处（提示是瞬时的，${Math.round(OTHER_ROOM_HOLD_MS / 1000)} 秒内不再提示就自动清掉）。`
    : ''
}

function pokeGuest(uid) {
  const t = tiles.get(uid)
  if (!t) return
  // 前几轮顺带切画质（播放器重初始化后需要再切一次），之后就不再重复点
  const applyQuality = (t.pokes || 0) < 6
  t.pokes = (t.pokes || 0) + 1
  try {
    const p = t.view.executeJavaScript(guestScript(t.muted, applyQuality, t.volume, tileQuality(t)), true)
    if (p && typeof p.then === 'function') {
      p.then((r) => {
        if (!r || typeof r !== 'object') return
        setOtherRoom(uid, r.otherRoom === true)
        renderDanmu(uid, r.danmu)
        reportTileStatus(uid, r)
      }).catch(() => {})
    }
  } catch {
    // guest 未就绪
  }
  // 虎牙：顺手把签名好的直录流地址报给主进程（录制用；每次重读，签名过期也能跟上）
  reportHuyaStream(uid, t)
}

/* ------------------------------ 平台适配（抖音 / 虎牙） ------------------------------ */

/** 站点判定：决定"直录流地址从哪来"、"哪些页面细节要特殊处理" */
function platformOf(u) {
  const s = String(u || '')
  if (/huya\.com/i.test(s)) return 'huya'
  if (/douyin\.com/i.test(s)) return 'douyin'
  return 'other'
}

/**
 * 虎牙的取流完全交给主进程（`huyaStreamCandidates`：mp.huya.com 接口 + 参数改写）。
 * 页面里 `window.hyPlayerConfig` 那份地址看着一样，但在播放器环境之外拉起会被 CDN 很快切断
 * （AL 403、TX/HS 只吐 1~4 秒），所以不再从页面里抠地址。
 */

/** 从虎牙页面里读 profileRoom（= 接口要的 roomid）。很多房间页 HTML 里已经没这个字段了，只能问页面本身 */
const HUYA_ROOMID_PROBE = `(() => {
  try {
    const d = window.TT_ROOM_DATA || {}
    const id = d.profileRoom || d.profileRoomId || ''
    return id ? String(id) : ''
  } catch (e) {
    return ''
  }
})()`

/** 让主进程续一次虎牙直录地址（anti-code 约 2 分钟有效，这里 60 秒一续） */
function reportHuyaStream(uid, t) {
  if (!t || platformOf(t.url) !== 'huya') return
  // 虎牙改走主进程的 mp.huya.com 接口（见 main.js huyaStreamCandidates），
  // anti-code 大约 2 分钟有效，所以每 60 秒续一次；页面里那份地址播放器环境之外拉不动，不再用
  const now = Date.now()
  if (t.huyaNextAt && now < t.huyaNextAt) return
  t.huyaNextAt = now + 60 * 1000
  let wcId = 0
  try {
    wcId = t.view.getWebContentsId()
  } catch {
    return
  }
  // 从页面里拿 profileRoom 一起报上去（HTML 里不一定有，页面里一定有）
  let p = null
  try {
    p = t.view.executeJavaScript(HUYA_ROOMID_PROBE, false)
  } catch {}
  Promise.resolve(p)
    .catch(() => '')
    .then((roomIdHint) => window.pr.huyaStreams(t.url, wcId, roomIdHint || ''))
    .then((r) => {
      if (!r || !r.ok) {
        t.huyaError = (r && r.error) || '取流失败'
        return
      }
      t.huyaError = ''
      t.huyaLive = r.live === true
      if (r.roomId) t.huyaRoomId = r.roomId
      if (r.anchor) t.huyaAnchor = r.anchor
      // 房间名也顺手补一下（接口里的 nick 比标题更准）
      if (r.anchor && t.nameEl) t.nameEl.textContent = r.anchor
    })
    .catch((err) => {
      t.huyaError = String((err && err.message) || err)
    })
}

function startWatchdog(uid) {
  stopWatchdog(uid)
  const t = tiles.get(uid)
  if (!t) return
  pokeGuest(uid)
  t.watch = setInterval(() => pokeGuest(uid), WATCHDOG_MS)
}

function stopWatchdog(uid) {
  const t = tiles.get(uid)
  if (t && t.watch) {
    clearInterval(t.watch)
    t.watch = null
  }
}

function applyMute(uid) {
  const t = tiles.get(uid)
  if (!t) return
  try {
    t.view.setAudioMuted(t.muted)
  } catch {
    // guest 还没 attach，dom-ready 时会再试
  }
  const vol = typeof t.volume === 'number' ? t.volume : 1
  const icon = t.muted || vol <= 0.01 ? '🔇' : vol < 0.5 ? '🔉' : '🔊'
  t.muteBtn.textContent = icon
  t.muteBtn.classList.toggle('unmuted', !t.muted)
  t.muteBtn.classList.toggle('off', t.muted)
  t.muteBtn.title = t.muted ? '当前静音，点击出声' : `当前音量 ${Math.round(vol * 100)}%，点击静音`
  if (t.volEl) {
    t.volEl.value = String(Math.round(vol * 100))
    t.volEl.title = `这个房间的音量 ${Math.round(vol * 100)}%（每个房间独立）`
  }
  pokeGuest(uid)
}

function setMute(uid, muted) {
  const t = tiles.get(uid)
  if (!t) return
  t.muted = Boolean(muted)
  applyMute(uid)
  scheduleSave()
}

function toggleMute(uid) {
  const t = tiles.get(uid)
  if (!t) return
  setMute(uid, !t.muted)
}

/** 设置某个瓦片的音量（0–1），按房间号记住 */
function setVolume(uid, v01) {
  const t = tiles.get(uid)
  if (!t) return
  const v = Math.max(0, Math.min(1, Number(v01)))
  t.volume = v
  // 音量拉到 0 顺带静音图标变 🔇；从 0 拉起来自动取消静音
  if (v > 0.01 && t.muted) t.muted = false
  if (v <= 0.01) t.muted = true
  try {
    const pref = loadPrefs()
    const volumes = { ...(pref.volumes || {}), [bareUrl(t.url)]: v }
    savePrefs({ volumes })
  } catch {}
  applyMute(uid)
  scheduleSave()
}

/* ------------------------------ 房间增删 ------------------------------ */

function addRoom(url, opts = {}) {
  if (tiles.size >= MAX_TILES) {
    statusEl.textContent = `最多同时打开 ${MAX_TILES} 个瓦片（当前 ${tiles.size} 个）`
    statusEl.className = 'err'
    return null
  }
  // 同一个房间只允许一个瓦片：否则同一路声音会被播两遍（延迟不同）= 回声
  const dup = [...tiles.entries()].find(([, t]) => bareUrl(t.url) === bareUrl(url))
  if (dup) {
    flashTile(dup[0])
    statusEl.textContent = '这个直播间已经在看了（同一个房间只开一个瓦片，避免声音重叠）'
    statusEl.className = 'warn'
    return tiles.get(dup[0])
  }
  const hasSound = [...tiles.values()].some((t) => !t.muted)
  const muted = typeof opts.muted === 'boolean' ? opts.muted : muteByDefault ? true : hasSound
  // 每个房间的音量按房间号记住，重开也生效
  let volume = 1
  try {
    const savedVol = (loadPrefs().volumes || {})[bareUrl(url)]
    if (typeof savedVol === 'number') volume = Math.max(0, Math.min(1, savedVol))
  } catch {}
  const uid = `r${++seq}`

  const el = document.createElement('section')
  el.className = 'tile'
  el.dataset.uid = uid
  el.innerHTML = `
    <div class="tile-head">
      <span class="idx">${tiles.size + 1}</span>
      <span class="title">正在进入…</span>
      <span class="badge hidden">非当前房间</span>
      <button class="act rec" type="button" title="开始录制这个房间">● 开始</button>
      <button class="act rec-split hidden" type="button" title="分段：把这一段收好（立刻出成片），同时接着录下一段，不停止录制">✂ 分段</button>
      <input class="act vol" type="range" min="0" max="100" step="5" value="100" title="这个房间的音量（每个房间独立）" />
      <button class="act mute" type="button">🔇</button>
      <button class="act solo" type="button" title="放大 / 还原">⤢</button>
      <button class="act reload" type="button" title="重新加载">⟳</button>
      <button class="act close" type="button" title="关闭">✕</button>
    </div>
    <div class="stage">
      <webview allowpopups></webview>
      <div class="overlay">正在进入直播间…</div>
      <div class="tile-name"></div>
      <div class="danmu-panel hidden"></div>
    </div>
  `

  const view = el.querySelector('webview')
  const overlay = el.querySelector('.overlay')
  const titleEl = el.querySelector('.title')
  const idxEl = el.querySelector('.idx')
  const muteBtn = el.querySelector('.mute')
  const volEl = el.querySelector('.vol')
  const badgeEl = el.querySelector('.badge')
  const danmuEl = el.querySelector('.danmu-panel')
  const recBtn = el.querySelector('.rec')
  const recSplitBtn = el.querySelector('.rec-split')
  const stageEl = el.querySelector('.stage')
  const nameEl = el.querySelector('.tile-name')

  // 这些属性必须在设置 src 之前落位
  const tilePartition = isolate ? `persist:room-${uid}` : partition
  view.setAttribute('partition', tilePartition)
  view.setAttribute(
    'webpreferences',
    'contextIsolation=yes,nodeIntegration=no,backgroundThrottling=no,autoplayPolicy=no-user-gesture-required'
  )
  if (ua) view.setAttribute('useragent', ua)

  const t = {
    el,
    view,
    overlay,
    titleEl,
    idxEl,
    muteBtn,
    volEl,
    badgeEl,
    danmuEl,
    recBtn,
    recSplitBtn,
    stageEl,
    nameEl,
    url,
    muted,
    volume,
    failed: false,
    other: false,
    otherAt: 0,
    removed: false,
    watch: null
  }
  tiles.set(uid, t)

  titleEl.textContent = roomLabel(url)
  if (nameEl) nameEl.textContent = roomLabel(url)
  el.querySelector('.mute').addEventListener('click', (e) => {
    e.stopPropagation()
    toggleMute(uid)
  })
  const volInput = el.querySelector('.vol')
  volInput.addEventListener('input', (e) => {
    e.stopPropagation()
    setVolume(uid, Number(e.currentTarget.value) / 100)
  })
  // 拖滑块不要触发瓦片的其它点击行为
  volInput.addEventListener('click', (e) => e.stopPropagation())
  volInput.addEventListener('mousedown', (e) => e.stopPropagation())
  el.querySelector('.rec').addEventListener('click', (e) => {
    e.stopPropagation()
    toggleRecord(uid)
  })
  el.querySelector('.rec-split').addEventListener('click', (e) => {
    e.stopPropagation()
    splitRecord(uid)
  })
  el.querySelector('.solo').addEventListener('click', (e) => {
    e.stopPropagation()
    setFocus(focusUid === uid ? null : uid)
  })
  el.querySelector('.reload').addEventListener('click', (e) => {
    e.stopPropagation()
    reloadRoom(uid)
  })
  el.querySelector('.close').addEventListener('click', (e) => {
    e.stopPropagation()
    removeRoom(uid)
  })
  const headEl = el.querySelector('.tile-head')
  headEl.addEventListener('dblclick', () => {
    if (Date.now() < suppressClickUntil) return
    setFocus(focusUid === uid ? null : uid)
  })
  // 按住顶栏拖 = 换个位置（不移动 DOM 节点，见"瓦片拖动排序"）
  headEl.addEventListener('pointerdown', (e) => startTileDrag(e, uid))
  // 右键顶栏 = 这个房间自己的设置（目前是画质），不用占顶栏宽度
  headEl.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    e.stopPropagation()
    openQualityMenu(uid, e.clientX, e.clientY)
  })

  gridEl.appendChild(el)

  // 隔离模式下先把 cookie 复制进这个房间自己的 partition，再开始加载
  const startLoad = () => {
    if (t.removed) return
    view.setAttribute('src', url)
  }
  if (isolate) {
    Promise.resolve(window.pr.prepareRoomPartition(tilePartition))
      .then(startLoad)
      .catch(startLoad)
  } else {
    startLoad()
  }

  view.addEventListener('dom-ready', () => {
    if (!t.failed) hideOverlay(t)
    applyMute(uid)
    // guest 挂上来了才有 id，这时报一次，主进程的卫兵才不会把它当遗留页面
    syncTileGuests()
  })
  // 页面加载完成后再挂看门狗，避免对着空白页刷 play()
  view.addEventListener('did-finish-load', () => {
    if (!t.failed) {
      t.pokes = 0
      startWatchdog(uid)
    }
  })
  view.addEventListener('page-title-updated', (e) => {
    const title = String(e.title || '')
      .replace(/\s*[-|]\s*抖音\s*$/, '')
      .trim()
    if (title) {
      // 主播名：抖音是「某某某的抖音直播间 - 抖音直播」，虎牙是「某某的…-DOTA1-虎牙直播」
      const name = title
        .replace(/的抖音直播间.*$/, '')
        .replace(/\s*-\s*[^-]{0,20}\s*-\s*虎牙直播\s*$/, '')
        .replace(/\s*-\s*虎牙直播\s*$/, '')
        .replace(/\s*-\s*抖音直播\s*$/, '')
        .trim()
      const short = name || title
      // 顶栏横幅就显示"干净的主播名"：原来那句「XXX的抖音直播间 - 抖音直播」在窄瓦片里
      // 会被按钮挤成省略号，名字反而看不清。完整标题留在 tooltip 里。
      titleEl.textContent = short
      titleEl.title = title
      if (nameEl) nameEl.textContent = short
    }
  })
  view.addEventListener('did-start-loading', () => {
    if (t.failed) return
    showOverlay(t, '正在进入直播间…')
  })
  view.addEventListener('did-stop-loading', () => {
    if (!t.failed) hideOverlay(t)
  })
  view.addEventListener('did-fail-load', (e) => {
    if (!e.isMainFrame) return
    if (e.errorCode === -3) return // 被主动中断，忽略
    t.failed = true
    showOverlay(t, `加载失败（${e.errorCode} ${e.errorDescription || ''}）\n${e.validatedURL || url}`, true)
  })
  view.addEventListener('render-process-gone', (e) => {
    t.failed = true
    showOverlay(t, `渲染进程退出（${e.reason || 'unknown'}），点 ⟳ 重新加载`, true)
  })

  refreshIndices()
  updateCount()
  layout()
  applyMute(uid)
  scheduleSave()
  if (typeof renderCards === 'function') renderCards()
  return uid
}

function removeRoom(uid, opts = {}) {
  const t = tiles.get(uid)
  if (!t) return
  if (recMap.has(uid)) {
    Promise.resolve(window.pr.stopRecording(uid)).catch(() => {})
  }
  t.removed = true
  stopWatchdog(uid)
  // 先把这个页面的 guest id 记下来：等一下要让主进程点名销毁它
  let guestId = -1
  try {
    guestId = t.view.getWebContentsId()
  } catch {}
  // 立刻静音：移除 DOM 到"guest 真的被销毁"之间有几十毫秒，别让人听见尾巴
  try {
    t.view.setAudioMuted(true)
  } catch {}
  tiles.delete(uid)
  if (focusUid === uid) focusUid = null
  if (spotlightUid === uid) spotlightUid = null
  try {
    t.view.stop()
  } catch {}
  try {
    t.view.remove()
  } catch {}
  t.el.remove()
  if (guestId > 0) Promise.resolve(window.pr.killGuest(guestId)).catch(() => {})
  syncTileGuests()
  refreshIndices()
  updateCount()
  layout()
  if (!opts.batch) scheduleSave()
  if (typeof renderCards === 'function') renderCards()
}

function reloadRoom(uid) {
  const t = tiles.get(uid)
  if (!t) return
  t.failed = false
  showOverlay(t, '正在重新加载…')
  try {
    t.view.reload()
  } catch {
    showOverlay(t, '无法重新加载，请关闭后重新添加', true)
  }
}

function setFocus(uid) {
  focusUid = uid && tiles.has(uid) ? uid : null
  layout()
}

/* ------------------------------ 瓦片拖动排序 ------------------------------ */
/*
 * 拖动只改「Map 顺序 + CSS order」，绝不移动 DOM 节点。
 * webview 一旦被父节点重新插入就会重新加载，正在录制的房间会当场断流。
 *
 * 丝滑的三件事：
 *  1) 被拖的那块只做 transform: translate —— 让它一直"黏"在指针下面（不靠布局跳动）
 *  2) 其它瓦片换位用 FLIP 补间（先量旧位置 → 换完立刻反着平移回去 → 过渡到 0），
 *     因为 CSS `order` 本身不可过渡，直接换会"啪"地跳一下
 *  3) 指针移动走 rAF 合并，且要移动够 10px 才重新判位，避免在两格之间来回抖
 */

let dragState = null
let dragShield = null
let dragScrollRaf = 0
let suppressClickUntil = 0
/** 换位补间时长（ms） */
const FLIP_MS = 170
/** 指针移动超过这么多像素才重新判位，防抖 */
const DRAG_HYST = 10
/** 拖到网格上下边缘 56px 内开始自动滚动，最多 18px/帧 */
const SCROLL_EDGE = 56
const SCROLL_MAX = 18

function applyOrder() {
  let i = 0
  for (const t of tiles.values()) t.el.style.order = String(i++)
}

/** 把 uid 移到第 slot 位（0 = 第一个），成功返回 true */
function moveTileTo(uid, slot, opts = {}) {
  const entries = [...tiles.entries()]
  const from = entries.findIndex(([u]) => u === uid)
  if (from < 0 || !entries.length) return false
  const target = Math.max(0, Math.min(entries.length - 1, slot | 0))
  if (target === from) return false
  const [entry] = entries.splice(from, 1)
  entries.splice(target, 0, entry)
  tiles.clear()
  for (const [u, t] of entries) tiles.set(u, t)
  applyOrder()
  refreshIndices()
  // 拖动过程中不落盘：一拍一次 IPC + 写文件纯属浪费，松手时统一存
  if (!opts.silent) scheduleSave()
  return true
}

/** FLIP：让这张瓦片从 fromRect 的位置滑到它现在该在的位置 */
function flipTile(t, fromRect) {
  const r = t.el.getBoundingClientRect()
  const dx = Math.round(fromRect.left - r.left)
  const dy = Math.round(fromRect.top - r.top)
  if (!dx && !dy) return
  const el = t.el
  clearTimeout(t.flipTimer)
  el.style.transition = 'none'
  el.style.transform = `translate(${dx}px, ${dy}px)`
  // 强制一次重排，否则下面的过渡起始值会被合并掉
  void el.offsetWidth
  el.style.transition = `transform ${FLIP_MS}ms cubic-bezier(.2, .7, .3, 1)`
  el.style.transform = 'translate(0px, 0px)'
  t.flipTimer = setTimeout(() => {
    el.style.transition = ''
    el.style.transform = ''
  }, FLIP_MS + 40)
}

/** 换位 + 给其它瓦片做补间；被拖的那块自己跟着指针走，不参与 */
function reorderWithFlip(uid, slot) {
  const before = new Map()
  for (const [u, t] of tiles) {
    const r = t.el.getBoundingClientRect()
    before.set(u, { left: r.left, top: r.top })
  }
  if (!moveTileTo(uid, slot, { silent: true })) return false
  for (const [u, t] of tiles) {
    if (u === uid) continue
    const prev = before.get(u)
    if (prev) flipTile(t, prev)
  }
  return true
}

/** 指针落在第几格：按扫读顺序，数有几张卡片的中心点在指针之前 */
function dragSlotAt(x, y, uid) {
  let slot = 0
  for (const [u, t] of tiles) {
    if (u === uid) continue
    const r = t.el.getBoundingClientRect()
    if (!r.width || !r.height) continue
    const sameRow = y >= r.top && y <= r.bottom
    const before = sameRow ? r.left + r.width / 2 < x : r.top + r.height / 2 < y
    if (before) slot++
  }
  return slot
}

/** 记下这张瓦片"没有 transform 时的左上角"，之后每帧只算差值，不反复读布局 */
function measureDragBase(st) {
  const r = st.el.getBoundingClientRect()
  st.baseLeft = r.left - st.tx
  st.baseTop = r.top - st.ty
}

function startTileDrag(e, uid) {
  if (e.button !== 0) return
  if (!e.target || !e.target.closest) return
  // 顶栏上的按钮 / 滑块 / 输入框照旧点
  if (e.target.closest('button, input, select, textarea, a, .badge')) return
  const t = tiles.get(uid)
  if (!t || focusUid) return
  const r = t.el.getBoundingClientRect()
  dragState = {
    uid,
    el: t.el,
    pointerId: e.pointerId,
    x0: e.clientX,
    y0: e.clientY,
    x: e.clientX,
    y: e.clientY,
    // 指针落点在瓦片内部的偏移：拖动时保持这个抓取点，不会"手一按就跳"
    offX: e.clientX - r.left,
    offY: e.clientY - r.top,
    tx: 0,
    ty: 0,
    baseLeft: r.left,
    baseTop: r.top,
    active: false,
    rafId: 0,
    lastX: e.clientX,
    lastY: e.clientY,
    // 聚焦布局里的拖动是另一套规则：小窗之间排序 / 拖到大画面就换过去
    spotlight: gridPreset === 'focus',
    overMain: false
  }
  // 抓指针：手指/鼠标移出窗口再松开也能收到 pointerup，不会把盾牌留在屏幕上
  try {
    e.currentTarget.setPointerCapture(e.pointerId)
  } catch {}
  window.addEventListener('pointermove', onTileDragMove, true)
  window.addEventListener('pointerup', onTileDragEnd, true)
  window.addEventListener('pointercancel', onTileDragEnd, true)
  window.addEventListener('blur', onTileDragEnd)
}

function onTileDragMove(e) {
  const st = dragState
  if (!st) return
  st.x = e.clientX
  st.y = e.clientY
  if (!st.active) {
    // 4px 死区：让「双击放大」「单击按钮」不被当成拖动
    if (Math.abs(st.x - st.x0) < 4 && Math.abs(st.y - st.y0) < 4) return
    st.active = true
    document.body.classList.add('tile-dragging')
    st.el.classList.add('dragging')
    clearTimeout(st.el.flipTimer)
    st.el.style.transition = ''
    st.el.style.transform = ''
    measureDragBase(st)
    if (!dragShield) {
      dragShield = document.createElement('div')
      dragShield.id = 'drag-shield'
      document.body.appendChild(dragShield)
    }
    startDragAutoScroll()
  }
  if (e.cancelable) e.preventDefault()
  // 一帧只算一次：多个 pointermove 合并成一个 rAF，避免高回报率鼠标下的抖动
  if (!st.rafId) {
    st.rafId = requestAnimationFrame(() => {
      st.rafId = 0
      paintDrag()
    })
  }
}

function paintDrag() {
  const st = dragState
  if (!st || !st.active) return
  if (st.spotlight) {
    paintSpotlightDrag(st)
    return
  }
  // 1) 被拖那块始终贴着指针（纯 transform，不触发重排）
  st.tx = Math.round(st.x - st.offX - st.baseLeft)
  st.ty = Math.round(st.y - st.offY - st.baseTop)
  st.el.style.transform = `translate(${st.tx}px, ${st.ty}px)`
  // 2) 判位换序：指针没挪够 10px 就别再判，防止在两格之间抽搐
  if (Math.hypot(st.x - st.lastX, st.y - st.lastY) < DRAG_HYST) return
  const slot = dragSlotAt(st.x, st.y, st.uid)
  if (reorderWithFlip(st.uid, slot)) {
    st.lastX = st.x
    st.lastY = st.y
    // 换位后它的落点变了 → 重算基准，保证视觉位置不跳
    measureDragBase(st)
    st.tx = Math.round(st.x - st.offX - st.baseLeft)
    st.ty = Math.round(st.y - st.offY - st.baseTop)
    st.el.style.transform = `translate(${st.tx}px, ${st.ty}px)`
  }
}

/* -------------------- 聚焦布局里的拖动（右侧一列） -------------------- */
/*
 * 和九宫格不一样，这里只有两种落点：
 *   指针在右侧小窗上 → 调顺序（小窗之间互换位置）
 *   指针在大画面上   → 松手就把这块换到中间（大窗口拖到小窗上则是互换）
 * 同样是"只改 Map 顺序 / CSS 位置"，不移动 DOM，webview 不会重载。
 */

function rectHasPoint(el, x, y) {
  if (!el) return false
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
}

/** 指针落在右侧第几个小窗（返回它在"小窗数组"里的目标下标） */
function spotlightRailSlotAt(y, uid) {
  let k = 0
  for (const [u, t] of tiles) {
    if (u === spotlightUid || u === uid) continue
    const r = t.el.getBoundingClientRect()
    if (!r.width || !r.height) continue
    if (y > r.top + r.height / 2) k++
  }
  return k
}

/** 指针下面是哪个小窗 */
function smallTileAt(x, y) {
  for (const [u, t] of tiles) {
    if (u === spotlightUid) continue
    if (rectHasPoint(t.el, x, y)) return u
  }
  return null
}

/** 把 uid 移到小窗列表的第 k 位（主画面在 Map 里的位置保持不变） */
function reorderSpotlight(uid, k) {
  if (!spotlightUid) return false
  const entries = [...tiles.entries()]
  const mainIdx = entries.findIndex(([u]) => u === spotlightUid)
  if (mainIdx < 0) return false
  const smalls = entries.filter(([u]) => u !== spotlightUid)
  const from = smalls.findIndex(([u]) => u === uid)
  if (from < 0) return false
  const target = Math.max(0, Math.min(smalls.length - 1, k | 0))
  if (target === from) return false
  const [moved] = smalls.splice(from, 1)
  smalls.splice(target, 0, moved)
  const out = []
  let si = 0
  for (let i = 0; i < entries.length; i++) {
    if (i === mainIdx) out.push(entries[mainIdx])
    else out.push(smalls[si++])
  }
  tiles.clear()
  for (const [u, t] of out) tiles.set(u, t)
  applyOrder()
  refreshIndices()
  return true
}

/** 换位 + 给其它小窗做 FLIP 补间 */
function reorderSpotlightWithFlip(uid, k) {
  const before = new Map()
  for (const [u, t] of tiles) {
    const r = t.el.getBoundingClientRect()
    before.set(u, { left: r.left, top: r.top })
  }
  if (!reorderSpotlight(uid, k)) return false
  layoutSpotlight()
  for (const [u, t] of tiles) {
    if (u === uid) continue
    const prev = before.get(u)
    if (prev) flipTile(t, prev)
  }
  return true
}

function paintSpotlightDrag(st) {
  st.tx = Math.round(st.x - st.offX - st.baseLeft)
  st.ty = Math.round(st.y - st.offY - st.baseTop)
  st.el.style.transform = `translate(${st.tx}px, ${st.ty}px)`

  const mainT = tiles.get(spotlightUid)
  // 拖到主画面上：高亮，松手就换过去（拖主画面本身时不高亮自己）
  const overMain = Boolean(mainT) && st.uid !== spotlightUid && rectHasPoint(mainT.el, st.x, st.y)
  if (mainT) mainT.el.classList.toggle('drop-target', overMain)
  st.overMain = overMain
  if (st.uid === spotlightUid) return // 拖的是大窗口：只等松手看换给谁
  if (overMain) return
  if (Math.hypot(st.x - st.lastX, st.y - st.lastY) < DRAG_HYST) return
  const k = spotlightRailSlotAt(st.y, st.uid)
  if (reorderSpotlightWithFlip(st.uid, k)) {
    st.lastX = st.x
    st.lastY = st.y
    measureDragBase(st)
    st.tx = Math.round(st.x - st.offX - st.baseLeft)
    st.ty = Math.round(st.y - st.offY - st.baseTop)
    st.el.style.transform = `translate(${st.tx}px, ${st.ty}px)`
  }
}

/** 松手：决定是"换到中间"还是什么都不做 */
function applySpotlightDrop(st) {
  const mainT = tiles.get(spotlightUid)
  if (mainT) mainT.el.classList.remove('drop-target')
  if (st.uid === spotlightUid) {
    // 把大窗口拖到某个小窗上 → 跟它互换
    const target = smallTileAt(st.x, st.y)
    if (target) setSpotlight(target)
    return
  }
  if (mainT && rectHasPoint(mainT.el, st.x, st.y)) setSpotlight(st.uid)
}

/**
 * 拖到网格上/下边缘时自动滚动：瓦片多到要滚的时候，否则拖不到屏幕外的格子。
 * 只在能滚的时候才跑这个 rAF 循环。
 */
function startDragAutoScroll() {
  if (dragScrollRaf) return
  const tick = () => {
    dragScrollRaf = 0
    const st = dragState
    if (!st || !st.active) return
    dragScrollRaf = requestAnimationFrame(tick)
    if (gridEl.scrollHeight <= gridEl.clientHeight + 4) return
    const g = gridEl.getBoundingClientRect()
    let v = 0
    if (st.y < g.top + SCROLL_EDGE) {
      v = -Math.round(SCROLL_MAX * Math.min(1, (g.top + SCROLL_EDGE - st.y) / SCROLL_EDGE))
    } else if (st.y > g.bottom - SCROLL_EDGE) {
      v = Math.round(SCROLL_MAX * Math.min(1, (st.y - (g.bottom - SCROLL_EDGE)) / SCROLL_EDGE))
    }
    if (!v) return
    const before = gridEl.scrollTop
    gridEl.scrollTop = before + v
    if (gridEl.scrollTop === before) return
    // 内容整体移了 → 基准重算，ghost 继续贴着指针
    measureDragBase(st)
    paintDrag()
  }
  dragScrollRaf = requestAnimationFrame(tick)
}

function stopDragAutoScroll() {
  if (!dragScrollRaf) return
  cancelAnimationFrame(dragScrollRaf)
  dragScrollRaf = 0
}

function onTileDragEnd() {
  window.removeEventListener('pointermove', onTileDragMove, true)
  window.removeEventListener('pointerup', onTileDragEnd, true)
  window.removeEventListener('pointercancel', onTileDragEnd, true)
  window.removeEventListener('blur', onTileDragEnd)
  const st = dragState
  dragState = null
  if (!st) return
  if (st.rafId) {
    cancelAnimationFrame(st.rafId)
    st.rafId = 0
  }
  stopDragAutoScroll()
  try {
    const head = st.el.querySelector('.tile-head')
    if (head && head.hasPointerCapture && head.hasPointerCapture(st.pointerId)) {
      head.releasePointerCapture(st.pointerId)
    }
  } catch {}
  if (dragShield) {
    dragShield.remove()
    dragShield = null
  }
  document.body.classList.remove('tile-dragging')
  st.el.classList.remove('dragging')
  if (!st.active) return
  // 松手：从"跟着指针的位置"滑回它现在所在的格子（同 FLIP 的曲线）
  const el = st.el
  el.style.transition = 'none'
  el.style.transform = `translate(${st.tx}px, ${st.ty}px)`
  void el.offsetWidth
  el.style.transition = `transform ${FLIP_MS}ms cubic-bezier(.2, .7, .3, 1)`
  el.style.transform = 'translate(0px, 0px)'
  clearTimeout(el.flipTimer)
  el.flipTimer = setTimeout(() => {
    el.style.transition = ''
    el.style.transform = ''
  }, FLIP_MS + 40)
  suppressClickUntil = Date.now() + 400
  if (st.spotlight) applySpotlightDrop(st)
  refreshIndices()
  layout()
  scheduleSave()
}

/** 拖动结束后紧跟的那次 click / dblclick 丢掉，免得误放大或误触发按钮 */
document.addEventListener(
  'click',
  (e) => {
    if (Date.now() > suppressClickUntil) return
    if (!e.target || !e.target.closest || !e.target.closest('.tile')) return
    e.stopPropagation()
    e.preventDefault()
  },
  true
)

/* ------------------------------ 录制 ------------------------------ */

const statusEl = document.getElementById('status')
/** uid -> { startedAt, mode }，支持多路同时录制 */
const recMap = new Map()
const recState = { phase: 'idle', lastFile: '', error: '' }
let recTimer = null

/** 录制参数：帧率与码率按实际像素自适应 */
const REC_FPS = 30
function bitrateFor(rect) {
  const dpr = window.devicePixelRatio || 1
  const px = Math.max(1, Math.round(rect.width * dpr)) * Math.max(1, Math.round(rect.height * dpr))
  // 约 0.12 bit/像素/帧，夹在 5–24 Mbps
  return Math.min(24_000_000, Math.max(5_000_000, Math.round(px * REC_FPS * 0.12)))
}

function fmtDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function renderRecUi() {
  for (const [uid, t] of tiles) {
    const rec = recMap.get(uid)
    const isThis = Boolean(rec)
    t.el.classList.toggle('recording', isThis)
    if (t.recBtn) {
      // 开始 / 结束 是两个明确的状态，不是同一个按钮换图标
      t.recBtn.textContent = isThis ? '■ 结束' : '● 开始'
      t.recBtn.classList.toggle('on', isThis)
      t.recBtn.title = isThis ? '结束录制（保存）' : '开始录制这个房间'
    }
    if (t.recSplitBtn) {
      t.recSplitBtn.classList.toggle('hidden', !isThis)
      t.recSplitBtn.disabled = !isThis
    }
  }

  if (winRecBtn) {
    const on = recMap.has(WINDOW_REC_UID)
    winRecBtn.classList.toggle('on', on)
    winRecBtn.textContent = on ? '停止录窗口' : '录窗口'
    // 整窗录制时给窗口套一圈红框：不然看不出"整个窗口正在被录"
    const frame = document.getElementById('win-rec-frame')
    if (frame) frame.classList.toggle('hidden', !on)
    if (on) {
      const rec = recMap.get(WINDOW_REC_UID)
      const label = document.getElementById('win-rec-label')
      if (label) {
        label.textContent = `● 正在录制整个窗口 ${fmtDuration(rec ? Date.now() - rec.startedAt : 0)}（点「停止录窗口」结束）`
        if (!label.dataset.placed) placeWinRecLabel(label)
      }
    } else {
      const label = document.getElementById('win-rec-label')
      if (label) delete label.dataset.placed
    }
  }

  if (recMap.size > 0) {
    let longest = 0
    let seg = 1
    for (const rec of recMap.values()) {
      const d = Date.now() - rec.startedAt
      if (d > longest) longest = d
      if (rec.segments > seg) seg = rec.segments
    }
    const modes = [...recMap.values()].map((r) => (r.mode === 'stream' ? '流' : '屏'))
    const tag = [...new Set(modes)].join('/')
    const keepTag = wmConfig.keepParts ? ' · 保留分段' : ''
    // 屏幕录制要等停止后才有 mp4，这点必须写在状态栏上，否则会以为"没录上"
    const hasScreen = [...recMap.values()].some((r) => r.mode === 'screen')
    const screenTag = hasScreen ? ' · 屏幕录制（停止后才生成 mp4）' : ''
    statusEl.textContent = `● 录制中 ${recMap.size} 路(${tag}) 第${seg}段 ${fmtDuration(longest)}${keepTag}${screenTag}`
    statusEl.className = 'rec-on'
  } else if (recState.phase === 'converting') {
    statusEl.textContent = '正在转 mp4…'
    statusEl.className = ''
  } else if (recState.error) {
    statusEl.textContent = '录制失败：' + recState.error
    statusEl.className = 'err'
  } else if (recState.lastFile) {
    statusEl.textContent = '已保存：' + recState.lastFile.split(/[\\/]/).pop()
    statusEl.className = 'ok'
  } else {
    statusEl.textContent = ''
    statusEl.className = ''
  }
}

/** 正在启动中的房间（等流地址那段最长 8 秒，防连点） */
const recStarting = new Set()

async function toggleRecord(uid) {
  const t = tiles.get(uid)
  if (!t) return

  // 已在录 → 停这一路
  if (recMap.has(uid)) {
    try {
      await window.pr.stopRecording(uid)
    } catch {}
    return
  }
  if (recStarting.has(uid)) {
    statusEl.textContent = '这个房间正在启动录制，稍等一下…'
    statusEl.className = ''
    return
  }
  recStarting.add(uid)
  try {
    await toggleRecordInner(uid, t)
  } finally {
    recStarting.delete(uid)
  }
}

async function toggleRecordInner(uid, t) {
  // 先问主进程：这个房间有没有可直录的流地址
  let guestId = 0
  try {
    guestId = t.view.getWebContentsId()
  } catch {}

  /**
   * 虎牙：先让主进程去 mp.huya.com 取一份新鲜的直录地址（anti-code 约 2 分钟有效），
   * 拿到就走直录流；只有确实取不到（房间没播/接口失败）才退回屏幕录制。
   */
  const isHuya = platformOf(t.url) === 'huya'
  if (isHuya) {
    statusEl.textContent = '虎牙：正在取直录地址…'
    statusEl.className = ''
    try {
      const r = await window.pr.huyaStreams(t.url, guestId)
      if (r && r.ok === false) {
        statusEl.textContent = '虎牙取流失败：' + (r.error || '未知原因') + '，改用屏幕录制'
        statusEl.className = 'warn'
        if (focusUid !== uid) setFocus(uid)
        await new Promise((res) => setTimeout(res, 600))
      } else if (r && r.live === false) {
        statusEl.textContent = '这个虎牙房间现在没在播（接口返回未开播）'
        statusEl.className = 'warn'
        return
      } else {
        t.huyaNextAt = Date.now() + 60 * 1000
        statusEl.textContent = `虎牙直录流：${(r && r.anchor) || ''} · ${((r && r.urls) || []).length} 条候选线路`.replace(' · 0 条候选线路', '')
        statusEl.className = ''
      }
    } catch (err) {
      statusEl.textContent = '虎牙取流失败：' + ((err && err.message) || err) + '，改用屏幕录制'
      statusEl.className = 'warn'
      if (focusUid !== uid) setFocus(uid)
      await new Promise((res) => setTimeout(res, 600))
    }
  }

  let mode = 'screen'
  let urlAgeMs = null
  try {
    const m = await window.pr.recMode(guestId)
    if (m && m.mode) mode = m.mode
    if (m && Number.isFinite(m.urlAgeMs)) urlAgeMs = m.urlAgeMs
  } catch {}

  // 刚打开的房间可能还没请求到 flv：等一会儿（最多 8 秒）再确认一次。
  // 注意：等不到也不会退化成屏幕录制——单个房间只走直录流，抓不到就报错让用户重试。
  if (mode !== 'stream') {
    statusEl.textContent = '正在等这个房间的直播流地址（最多 8 秒）…'
    statusEl.className = ''
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      let m = null
      try {
        m = await window.pr.recMode(guestId)
      } catch {}
      if (m && m.mode === 'stream') {
        mode = 'stream'
        urlAgeMs = Number.isFinite(m.urlAgeMs) ? m.urlAgeMs : urlAgeMs
        break
      }
    }
  }

  if (mode !== 'stream') {
    const why = urlAgeMs == null ? '还没抓到这个房间的直播流地址' : '抓到的流地址已经过期'
    statusEl.textContent = `${why}：先点这个瓦片的「⟳」重载房间，等画面出来再点「● 开始」（不会退化成屏幕录制）`
    statusEl.className = 'err'
    return
  }
  statusEl.textContent = isHuya ? '正在直录流（虎牙 1080p）：不放大画面' : '正在直录流：原画 1080p，不放大画面'
  statusEl.className = ''

  const rect = t.stageEl.getBoundingClientRect()
  recState.lastFile = ''
  recState.error = ''
  recState.phase = 'idle'

  let referer = ''
  try {
    referer = t.view.getURL() || t.url
  } catch {
    referer = t.url
  }

  let res = null
  const buildParams = (forceScreen) => ({
    uid,
    webContentsId: guestId,
    // 虎牙的直录地址要带 huya 的 Referer（主进程取流时会写进 streamUrls，这里兜一层）
    referer: isHuya ? 'https://www.huya.com/' : referer,
    forceScreen,
    label:
      (t.titleEl.textContent || '')
        .replace(/的抖音直播间.*$/, '')
        .replace(/\s*-\s*[^-]{0,20}\s*-\s*虎牙直播\s*$/, '')
        .trim() || uid,
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    },
    contentWidth: window.innerWidth,
    contentHeight: window.innerHeight,
    fps: REC_FPS,
    bitrate: bitrateFor(rect)
  })
  try {
    res = await window.pr.startRecording(buildParams(mode !== 'stream'))
  } catch (err) {
    res = { ok: false, error: err && err.message }
  }
  if (res && res.ok === false) {
    recState.error = res.error || '启动失败'
    renderRecUi()
    return
  }

  /**
   * 虎牙有些房间的直录流只吐几秒就被 CDN 切（换任何线路、换任何签名都一样）。
   * 这种情况自动切成屏幕录制（把这块画面放大后录），总比反复断了续、续了断强。
   * 只在这块瓦片上试一次；用轮询而不是固定延时——因为断的时间不固定（实测 1~18 秒都有）。
   */
  if (isHuya && res && res.ok && mode === 'stream' && !t.huyaScreenRetry) {
    const startedAt = Date.now()
    const uidNow = uid
    const timer = setInterval(() => {
      const tt = tiles.get(uidNow)
      if (!tt || tt.removed) {
        clearInterval(timer)
        return
      }
      const elapsed = Date.now() - startedAt
      if (elapsed > 90000) {
        clearInterval(timer)
        return
      }
      // 头 5 秒不看（recMap 还没被状态事件填上）
      if (elapsed < 5000) return
      if (recMap.has(uidNow)) return
      clearInterval(timer)
      tt.huyaScreenRetry = true
      statusEl.textContent = `虎牙这个房间的直录流只维持了 ${Math.round(elapsed / 1000)} 秒就断，已自动改成屏幕录制（画面会放大）`
      statusEl.className = 'warn'
      setFocus(uidNow)
      setTimeout(() => {
        Promise.resolve(window.pr.startRecording(buildParams(true)))
          .then((r2) => {
            if (r2 && r2.ok === false) {
              recState.error = r2.error || '屏幕录制启动失败'
              renderRecUi()
            }
          })
          .catch(() => {})
      }, 700)
    }, 2000)
  }
}

/**
 * 分段：把已经录的收成一段（立刻出成片），同时接着录下一段。
 * 不是停止——录完这段还会继续录。
 */
async function splitRecord(uid) {
  if (!recMap.has(uid)) return
  const btn = tiles.get(uid) && tiles.get(uid).recSplitBtn
  if (btn) {
    btn.disabled = true
    btn.textContent = '✂ 分段中…'
  }
  try {
    const res = await window.pr.splitRecording(uid)
    if (res && res.ok === false) {
      statusEl.textContent = res.error || '分段失败'
      statusEl.className = 'err'
    } else if (res && res.ok) {
      statusEl.textContent = `已分段（第 ${res.segments || '?'} 段开始），上一段正在合并`
      statusEl.className = 'ok'
    }
  } catch (err) {
    statusEl.textContent = '分段失败：' + (err && err.message)
    statusEl.className = 'err'
  } finally {
    if (btn) btn.textContent = '✂ 分段'
    renderRecUi()
  }
}

function wireRecorder() {  window.pr.onRecState((state) => {
    if (state.notice) {
      statusEl.textContent = state.notice
      statusEl.className = 'warn'
    }
    // 只带 notice 的通知包不要覆盖录制状态
    if (!Array.isArray(state.recorders)) {
      renderRecUi()
      return
    }
    const before = recMap.size
    recMap.clear()
    for (const r of state.recorders || []) {
      recMap.set(r.uid, {
        startedAt: r.startedAt || Date.now(),
        mode: r.mode || 'stream',
        segments: Number(r.segments) || 1,
        dir: r.dir || ''
      })
    }

    if (typeof state.converting === 'string' || state.converting) recState.phase = 'converting'
    if (typeof state.lastFile === 'string' && state.lastFile) {
      recState.lastFile = state.lastFile
      recState.error = ''
      recState.phase = 'idle'
    }
    if (!recMap.size && recState.phase === 'converting') recState.phase = 'idle'

    if (recMap.size > 0 && !recTimer) {
      recTimer = setInterval(renderRecUi, 1000)
    } else if (!recMap.size && recTimer) {
      clearInterval(recTimer)
      recTimer = null
    }

    // （自动放大那块逻辑已移除：单个房间不再退化成屏幕录制，屏幕录制只给「录窗口」用）

    renderRecUi()
  })

  // 录制热键（主进程 before-input-event 截获后转过来）：Ctrl+Shift+R 录/停鼠标所在瓦片，Ctrl+Shift+S 全停
  window.pr.onRecordingHotkey(({ action, point }) => {
    if (action === 'stop-all') {
      if (!recMap.size) {
        statusEl.textContent = '当前没有在录制'
        statusEl.className = ''
        return
      }
      Promise.resolve(window.pr.stopAllRecording()).catch(() => {})
      return
    }

    // Ctrl+Shift+W：整窗录制开关（不用管鼠标在哪）
    if (action === 'window') {
      toggleWindowRecord()
      return
    }

    const uid = tileAtPoint(point) || focusUid || (tiles.size === 1 ? [...tiles.keys()][0] : null)
    if (!uid) {
      statusEl.textContent = '把鼠标移到某个瓦片上再按 Ctrl+Shift+R'
      statusEl.className = 'warn'
      return
    }
    toggleRecord(uid)
  })
}

/**
 * 给"正在录制整个窗口"的胶囊挑一个**不会被录进去**的位置。
 * 整窗录制只把各瓦片 .stage 的矩形拼成画面，所以胶囊只要不压在任何一个 .stage 上就安全。
 * 顺序：顶部 → 底部 → 都不行就隐藏（留边框提示；边框贴窗口边缘，在裁剪范围之外）。
 */
function placeWinRecLabel(label) {
  const stages = [...document.querySelectorAll('.stage')].map((el) => el.getBoundingClientRect())
  const hit = (r) => stages.some((s) => r.left < s.right && s.left < r.right && r.top < s.bottom && s.top < r.bottom)
  label.classList.remove('hidden', 'pos-top', 'pos-bottom')
  // 顶部
  label.classList.add('pos-top')
  let r = label.getBoundingClientRect()
  if (!hit(r)) {
    label.dataset.placed = 'top'
    return 'top'
  }
  // 底部
  label.classList.remove('pos-top')
  label.classList.add('pos-bottom')
  r = label.getBoundingClientRect()
  if (!hit(r)) {
    label.dataset.placed = 'bottom'
    return 'bottom'
  }
  // 都不安全 → 只留边框
  label.classList.remove('pos-bottom')
  label.classList.add('hidden')
  label.dataset.placed = 'hidden'
  return 'hidden'
}

/** 找出坐标点落在哪个瓦片的视频区里 */
function tileAtPoint(point) {  if (!point) return null
  for (const [uid, t] of tiles) {
    if (!t.stageEl) continue
    const r = t.stageEl.getBoundingClientRect()
    if (point.x >= r.left && point.x <= r.right && point.y >= r.top && point.y <= r.bottom) return uid
  }
  return null
}

/* ------------------------------ 持久化 ------------------------------ */

/**
 * 把"当前还活着的瓦片 guest id"报给主进程。
 * 主进程有个卫兵：名单外的 webview 页面如果一直活着、还在出声，就直接关掉
 * —— 防止"房间都关了、声音还在"。
 */
function syncTileGuests() {
  const ids = []
  for (const t of tiles.values()) {
    try {
      const id = t.view.getWebContentsId()
      if (Number.isInteger(id) && id > 0) ids.push(id)
    } catch {}
  }
  Promise.resolve(window.pr.syncTileGuests(ids)).catch(() => {})
}

function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const rooms = [...tiles.values()].map((t) => ({ url: t.url, muted: t.muted }))
    Promise.resolve(window.pr.saveRooms(rooms)).catch(() => {})
    syncTileGuests()
  }, 350)
}

/* ------------------------------ 交互 ------------------------------ */

/**
 * 先把输入交给主进程统一解析（跟「监控」页用的是同一个解析器）：
 * 房间号 / live 链接 / 分享短链都认，短链会跟一次跳转拿到真实房间地址；
 * 主页、视频页、随便一个网址会被拒，而且不会因为"短链 vs 房间号"看成两个房间。
 */
async function resolveRoomForWatch(raw) {
  try {
    const res = await window.pr.resolveRoom(raw)
    if (res && res.ok && res.url) return { ok: true, url: res.url, roomId: res.roomId || '' }
    return { ok: false, error: (res && res.error) || '无法识别的地址' }
  } catch (err) {
    return { ok: false, error: '解析失败：' + ((err && err.message) || err) }
  }
}

formEl.addEventListener('submit', async (e) => {
  e.preventDefault()
  const raw = inputEl.value
  if (!String(raw || '').trim()) return

  const bad = () => {
    inputEl.focus()
    inputEl.select()
    inputEl.classList.remove('bad')
    void inputEl.offsetWidth
    inputEl.classList.add('bad')
    setTimeout(() => inputEl.classList.remove('bad'), 900)
  }

  // 交给主进程统一解析（短链要跟跳转，只能异步）
  let res
  try {
    res = await resolveRoomForWatch(raw)
  } catch {
    res = { ok: false, error: '解析失败' }
  }
  if (!res.ok) {
    bad()
    statusEl.textContent = res.error
    statusEl.className = 'err'
    return
  }

  const dup = [...tiles.entries()].find(([, t]) => bareUrl(t.url) === bareUrl(res.url))
  inputEl.value = ''
  if (dup) {
    flashTile(dup[0])
    statusEl.textContent = '这个直播间已经在看了（同一个房间只开一个瓦片，避免声音重叠）'
    statusEl.className = 'warn'
    return
  }
  const uid = addRoom(res.url)
  if (uid) {
    // 成了一次就把状态栏清干净（别留着上一条报错的红字样式）
    statusEl.textContent = ''
    statusEl.className = ''
  }
})

document.getElementById('btn-login').addEventListener('click', () => {
  Promise.resolve(window.pr.openLogin('douyin')).catch(() => {})
})

document.getElementById('btn-login-huya').addEventListener('click', () => {
  Promise.resolve(window.pr.openLogin('huya')).catch(() => {})
  statusEl.textContent = '已打开虎牙登录窗口：在窗口里点「登录」扫码，登录完成后关掉它'
  statusEl.className = ''
})

document.getElementById('btn-mute-all').addEventListener('click', () => {
  for (const uid of tiles.keys()) setMute(uid, true)
  muteByDefault = true
  savePrefs({ muteDefault: true })
})

document.getElementById('btn-unmute-all').addEventListener('click', () => {
  for (const uid of tiles.keys()) setMute(uid, false)
  muteByDefault = false
  savePrefs({ muteDefault: false })
})

document.getElementById('btn-reload-all').addEventListener('click', () => {
  for (const uid of tiles.keys()) reloadRoom(uid)
})

document.getElementById('btn-clear').addEventListener('click', () => {
  if (tiles.size === 0) return
  if (!window.confirm(`关闭全部 ${tiles.size} 个房间？（不会退出登录）`)) return
  focusUid = null
  spotlightUid = null
  for (const uid of [...tiles.keys()]) removeRoom(uid, { batch: true })
  scheduleSave()
})

/** 把「只看画面 / 弹幕面板 / 礼物」三组开关的界面状态同步成变量值 */
function applyViewToggleUi() {
  const pureBtn = document.getElementById('btn-pure')
  if (pureBtn) {
    pureBtn.classList.toggle('on', pure)
    pureBtn.textContent = pure ? '只看画面：开' : '只看画面：关'
  }
  const danmuBtn = document.getElementById('btn-danmu')
  if (danmuBtn) {
    danmuBtn.classList.toggle('on', showDanmu)
    danmuBtn.textContent = showDanmu ? '弹幕面板：开' : '弹幕面板：关'
  }
  const giftBtn = document.getElementById('btn-gift')
  if (giftBtn) {
    giftBtn.classList.toggle('on', showGift)
    giftBtn.textContent = showGift ? '礼物：开' : '礼物：关'
  }
  const qSel = document.getElementById('quality-select')
  // 「不干预」的 value 是空字符串，也要能回填
  if (qSel && typeof quality === 'string') qSel.value = quality
}

document.getElementById('btn-pure').addEventListener('click', (e) => {
  pure = !pure
  e.currentTarget.classList.toggle('on', pure)
  e.currentTarget.textContent = pure ? '只看画面：开' : '只看画面：关'
  savePrefs({ pure })
  // 关掉时重新加载，把被隐藏的页面恢复原样
  for (const [uid, t] of tiles) {
    if (pure) pokeGuest(uid)
    else reloadRoom(uid)
  }
})

document.getElementById('btn-danmu').addEventListener('click', (e) => {
  showDanmu = !showDanmu
  e.currentTarget.classList.toggle('on', showDanmu)
  e.currentTarget.textContent = showDanmu ? '弹幕面板：开' : '弹幕面板：关'
  savePrefs({ danmu: showDanmu })
  for (const [uid, t] of tiles) {
    if (!showDanmu) renderDanmu(uid, [])
    else pokeGuest(uid)
  }
})

document.getElementById('btn-gift').addEventListener('click', (e) => {
  showGift = !showGift
  e.currentTarget.classList.toggle('on', showGift)
  e.currentTarget.textContent = showGift ? '礼物：开' : '礼物：关'
  savePrefs({ gift: showGift })
  for (const uid of tiles.keys()) pokeGuest(uid)
})

document.getElementById('quality-select').addEventListener('change', (e) => {
  quality = e.currentTarget.value
  savePrefs({ quality })
  for (const [uid, t] of tiles) {
    t.pokes = 0
    pokeGuest(uid)
  }
})

/* ------------------------------ 弹幕面板设置 ------------------------------ */

/** 把行数/字号/位置落到 DOM 上（用 body 类 + CSS 变量，改一次全体生效） */
function applyDanmuStyle() {
  const b = document.body
  for (const p of DANMU_POS) b.classList.toggle(`dm-pos-${p.key}`, p.key === danmuPos)
  b.style.setProperty('--dm-font', `${danmuFont}px`)
}

function setDanmuLines(n) {
  danmuLines = n
  savePrefs({ danmuLines })
  for (const [uid] of tiles) pokeGuest(uid)
}

function setDanmuFont(n) {
  danmuFont = n
  savePrefs({ danmuFont })
  applyDanmuStyle()
}

function setDanmuPos(key) {
  danmuPos = key
  savePrefs({ danmuPos })
  applyDanmuStyle()
}

function openDanmuMenu(x, y) {
  const items = [
    { head: '显示几行' },
    ...DANMU_LINES.map((n) => ({
      label: `${n} 行`,
      sub: true,
      checked: n === danmuLines,
      action: () => setDanmuLines(n)
    })),
    { sep: true },
    { head: '字号' },
    ...DANMU_FONTS.map((n) => ({
      label: `${n}px`,
      sub: true,
      checked: n === danmuFont,
      action: () => setDanmuFont(n)
    })),
    { sep: true },
    { head: '贴哪个角' },
    ...DANMU_POS.map((p) => ({
      label: p.label,
      sub: true,
      checked: p.key === danmuPos,
      action: () => setDanmuPos(p.key)
    }))
  ]
  showPopup(x, y, items, showDanmu ? '弹幕面板设置' : '弹幕面板设置（现在是关的）')
}

const danmuSetBtn = document.getElementById('btn-danmu-set')
if (danmuSetBtn) {
  danmuSetBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    const r = e.currentTarget.getBoundingClientRect()
    openDanmuMenu(r.left, r.bottom + 4)
  })
}
applyDanmuStyle()

/* ------------------------------ 快捷键帮助 ------------------------------ */

const helpDialog = document.getElementById('help-dialog')
function openHelp() {
  if (!helpDialog) return
  helpDialog.classList.remove('hidden')
}
function closeHelp() {
  if (!helpDialog) return
  helpDialog.classList.add('hidden')
}
if (helpDialog) {
  helpDialog.addEventListener('click', (e) => {
    if (e.target === helpDialog) closeHelp()
  })
  const hc = document.getElementById('help-close')
  if (hc) hc.addEventListener('click', closeHelp)
  const hb = document.getElementById('btn-help')
  if (hb) {
    hb.addEventListener('click', (e) => {
      e.stopPropagation()
      openHelp()
    })
  }
}

const gridSelectEl = document.getElementById('grid-select')
if (gridSelectEl) {
  gridSelectEl.value = gridPreset
  gridSelectEl.addEventListener('change', (e) => {
    gridPreset = e.currentTarget.value
    try {
      localStorage.setItem('pr.gridPreset', gridPreset)
    } catch {}
    layout()
  })
}

document.getElementById('btn-rec-stop-all').addEventListener('click', () => {
  if (!recMap.size) {
    statusEl.textContent = '当前没有在录制'
    statusEl.className = ''
    return
  }
  Promise.resolve(window.pr.stopAllRecording()).catch(() => {})
})

/* ------------------------------ 录制选项弹窗 ------------------------------ */

const recDialog = document.getElementById('rec-dialog')
const recDialogHintEl = document.getElementById('rec-dialog-hint')
const recSegEl = document.getElementById('rec-seg')
const recMergeAutoEl = document.getElementById('rec-merge-auto')
const recMergeKeepEl = document.getElementById('rec-merge-keep')
const recMaxMinEl = document.getElementById('rec-max-min')
const recMinFreeEl = document.getElementById('rec-min-free')

/** 水印配置（只在「剪辑」页签用；录制阶段不烧水印） */
let wmConfig = {
  on: false,
  mode: 'text',
  text: '',
  font: '',
  size: 28,
  color: '#FFFFFF',
  opacity: 0.85,
  pos: 'br',
  margin: 20,
  shadow: true,
  image: '',
  imageScale: 0.15,
  fromSec: 0,
  toSec: 0,
  outDir: ''
}
/** 分段时长 */
let recSegmentMs = 5 * 60 * 1000
/** 录制目录（分段目录也是它，只有一个参数） */
let recOutDir = ''

function fmtGB(bytes) {
  if (!bytes) return '0 MB'
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function recSegText(ms) {
  const n = Number(ms)
  if (!n) return '不分段'
  const m = n / 60000
  return `${Number.isInteger(m) ? m : m.toFixed(0)} 分钟`
}

function applyRecOptionsToUi() {
  if (Number(wmConfig.segmentMs) >= 0) recSegmentMs = Number(wmConfig.segmentMs) || 0
  recSegEl.value = String(Number(recSegmentMs) || 0)
  const keep = !!wmConfig.keepParts
  if (recMergeAutoEl) recMergeAutoEl.checked = !keep
  if (recMergeKeepEl) recMergeKeepEl.checked = keep
  // 保护参数：0 分钟 = 不限
  const maxMin = Math.round((Number(wmConfig.maxDurationMs) || 0) / 60000)
  if (recMaxMinEl && document.activeElement !== recMaxMinEl) recMaxMinEl.value = String(maxMin)
  if (recMinFreeEl && document.activeElement !== recMinFreeEl) {
    const mb = Number(wmConfig.minFreeMb)
    recMinFreeEl.value = String(Number.isFinite(mb) ? mb : 2048)
  }
  // 工具栏按钮上直接显示当前设置，省得每次都要点开看
  const optBtn = document.getElementById('btn-rec-options')
  if (optBtn) {
    const seg = recSegmentMs ? `${recSegText(recSegmentMs)}/段` : '不分段'
    const merge = keep ? '保留分段' : '自动合并'
    optBtn.textContent = `⚙ 录制选项 · ${seg} · ${merge}`
    optBtn.title =
      `录制选项 —— 目录：${recOutDir || '默认 output'}；${seg}；${merge}；` +
      `最长 ${maxMin || '不限'}${maxMin ? ' 分钟' : ''}；磁盘余量 < ${Number(wmConfig.minFreeMb) || 0} MB 就拒绝开录`
  }
  recOutDir = wmConfig.outDir || recOutDir
  const dirEl = document.getElementById('rec-out-dir')
  if (dirEl) dirEl.textContent = recOutDir || '（读取中…）'
  recDialogHintEl.textContent = keep
    ? `每 ${recSegText(recSegmentMs)} 落一个分段，停止时**不合并**：目录里会留住 part0000.mkv、part0001.mkv…（可在「剪辑」页签多选后合并）`
    : `每 ${recSegText(recSegmentMs)} 落一个分段，停止时**自动合并**成一个 mp4（纯转封装，几秒）；水印在「剪辑」页签加。`
  recDialogHintEl.textContent = recDialogHintEl.textContent.replace(/\*\*/g, '')
  syncWmUiFromConfig()
}

async function saveRecOptions(patch) {
  try {
    const res = await window.pr.recSetOptions(patch)
    if (res && res.ok !== false) {
      wmConfig = {
        ...(res.watermark || wmConfig),
        segmentMs: res.segmentMs,
        keepParts: res.keepParts,
        maxDurationMs: res.maxDurationMs,
        minFreeMb: res.minFreeMb,
        font: res.font || wmConfig.font,
        outDir: res.outDir || wmConfig.outDir
      }
      applyRecOptionsToUi()
    } else if (res && res.error) {
      statusEl.textContent = '保存失败：' + res.error
      statusEl.className = 'err'
    }
  } catch (err) {
    statusEl.textContent = '保存设置失败：' + (err && err.message)
    statusEl.className = 'err'
  }
}

function openRecDialog() {
  recDialog.classList.remove('hidden')
  applyRecOptionsToUi()
}

function closeRecDialog() {
  recDialog.classList.add('hidden')
}

document.getElementById('btn-rec-options').addEventListener('click', openRecDialog)
document.getElementById('rec-dialog-close').addEventListener('click', closeRecDialog)
recDialog.addEventListener('click', (e) => {
  if (e.target === recDialog) closeRecDialog()
})
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Escape' && !recDialog.classList.contains('hidden')) {
      e.stopPropagation()
      closeRecDialog()
    }
  },
  true
)
recSegEl.addEventListener('change', () => saveRecOptions({ segmentMs: Number(recSegEl.value) }))
if (recMergeAutoEl) recMergeAutoEl.addEventListener('change', () => saveRecOptions({ keepParts: false }))
if (recMergeKeepEl) recMergeKeepEl.addEventListener('change', () => saveRecOptions({ keepParts: true }))
// 保护参数：失焦 / 回车时落地（边打字边存会把 "60" 中间的 "6" 存进去）
const commitMaxMin = () => {
  const min = Math.max(0, Math.min(1440, Math.round(Number(recMaxMinEl.value) || 0)))
  recMaxMinEl.value = String(min)
  saveRecOptions({ maxDurationMs: min * 60000 })
}
const commitMinFree = () => {
  const mb = Math.max(0, Math.min(102400, Math.round(Number(recMinFreeEl.value) || 0)))
  recMinFreeEl.value = String(mb)
  saveRecOptions({ minFreeMb: mb })
}
if (recMaxMinEl) {
  recMaxMinEl.addEventListener('blur', commitMaxMin)
  recMaxMinEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      recMaxMinEl.blur()
    }
  })
}
if (recMinFreeEl) {
  recMinFreeEl.addEventListener('blur', commitMinFree)
  recMinFreeEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      recMinFreeEl.blur()
    }
  })
}

// 录制目录：改了以后「剪辑」页签也跟着走（两个页面共用同一个目录参数）
document.getElementById('rec-choose-dir').addEventListener('click', async () => {
  try {
    const res = await window.pr.chooseRecDir()
    if (res && res.ok) {
      recOutDir = res.dir
      wmConfig.outDir = res.dir
      editDir = ''
      applyRecOptionsToUi()
      statusEl.textContent = '录制目录已设为：' + res.dir
      statusEl.className = 'ok'
      if (!document.getElementById('view-edit').classList.contains('hidden')) await refreshEditFiles({ force: true })
    }
  } catch (err) {
    statusEl.textContent = '设置录制目录失败：' + (err && err.message)
    statusEl.className = 'err'
  }
})
document.getElementById('rec-open-out-dir').addEventListener('click', () => {
  Promise.resolve(window.pr.recReveal('')).catch(() => {})
})

async function initRecOptions() {
  try {
    const res = await window.pr.recGetOptions()
    if (res && res.segmentMs !== undefined) {
      wmConfig = {
        ...(res.watermark || wmConfig),
        segmentMs: res.segmentMs,
        keepParts: !!res.keepParts,
        maxDurationMs: Number.isFinite(Number(res.maxDurationMs)) ? Number(res.maxDurationMs) : 60 * 60 * 1000,
        minFreeMb: Number.isFinite(Number(res.minFreeMb)) ? Number(res.minFreeMb) : 2048,
        font: res.font || '',
        outDir: res.outDir || ''
      }
      recSegmentMs = res.segmentMs
      recOutDir = res.outDir || ''
    }
  } catch {}
  applyRecOptionsToUi()
}

/* ------------------------------ 剪辑页签 ------------------------------ */

const editDirEl = document.getElementById('edit-dir')
const editFilesEl = document.getElementById('edit-files')
const editStatusEl = document.getElementById('edit-status')
const editSelInfoEl = document.getElementById('edit-sel-info')
const editSelAllEl = document.getElementById('edit-sel-all')
const editMergeBtn = document.getElementById('edit-merge')
const editApplyBtn = document.getElementById('edit-apply-wm')
const wmHintEl = document.getElementById('wm-hint')

/** 剪辑页签当前浏览的目录 */
let editDir = ''
/** 当前列出的文件 */
let editFiles = []
/** 选中的文件路径 */
const editSelected = new Set()

const wmFields = {
  mode: document.getElementById('wm-mode'),
  text: document.getElementById('wm-text'),
  font: document.getElementById('wm-font'),
  size: document.getElementById('wm-size'),
  color: document.getElementById('wm-color'),
  opacity: document.getElementById('wm-opacity'),
  pos: document.getElementById('wm-pos'),
  motion: document.getElementById('wm-motion'),
  speed: document.getElementById('wm-speed'),
  encoder: document.getElementById('wm-encoder'),
  firstN: document.getElementById('wm-first-n'),
  margin: document.getElementById('wm-margin'),
  shadow: document.getElementById('wm-shadow'),
  image: document.getElementById('wm-image'),
  imageScale: document.getElementById('wm-image-scale'),
  from: document.getElementById('wm-from'),
  to: document.getElementById('wm-to')
}

function syncWmUiFromConfig() {
  wmFields.mode.value = wmConfig.mode || 'text'
  wmFields.text.value = wmConfig.text || ''
  // 字体下拉里没有当前字体（比如自定义选的）就先塞一个自定义项
  const wantFont = wmConfig.font || ''
  if (wantFont && ![...wmFields.font.options].some((o) => o.value === wantFont)) {
    const opt = document.createElement('option')
    opt.value = wantFont
    opt.textContent = '自定义：' + wantFont.split(/[\\/]/).pop()
    wmFields.font.appendChild(opt)
  }
  if (wantFont) wmFields.font.value = wantFont
  wmFields.size.value = String(wmConfig.size || 28)
  wmFields.color.value = /^#[0-9a-f]{6}$/i.test(wmConfig.color || '') ? wmConfig.color : '#FFFFFF'
  wmFields.opacity.value = String(wmConfig.opacity || 0.85)
  wmFields.pos.value = wmConfig.pos || 'br'
  wmFields.motion.value = wmConfig.motion || 'static'
  wmFields.speed.value = String(wmConfig.speed || 120)
  wmFields.encoder.value = wmConfig.encoder === 'nvenc' ? 'nvenc' : 'x264'
  wmFields.firstN.value = String(Number(wmConfig.firstN) || 0)
  wmFields.margin.value = String(Number(wmConfig.margin) || 0)
  wmFields.shadow.checked = wmConfig.shadow !== false
  wmFields.image.value = wmConfig.image || ''
  wmFields.imageScale.value = String(wmConfig.imageScale || 0.15)
  wmFields.from.value = wmConfig.fromSec ? String(wmConfig.fromSec) : ''
  wmFields.to.value = wmConfig.toSec ? String(wmConfig.toSec) : ''
  updateWmHint()
}

function collectWmFromUi() {
  const num = (el, d) => {
    const v = Number(el.value)
    return Number.isFinite(v) && el.value !== '' ? v : d
  }
  return {
    on: true,
    mode: wmFields.mode.value,
    text: wmFields.text.value.trim(),
    font: wmFields.font.value || wmConfig.font,
    size: num(wmFields.size, 28),
    color: wmFields.color.value,
    opacity: num(wmFields.opacity, 0.85),
    pos: wmFields.pos.value,
    motion: wmFields.motion.value,
    speed: num(wmFields.speed, 120),
    encoder: wmFields.encoder.value,
    firstN: num(wmFields.firstN, 0),
    margin: num(wmFields.margin, 20),
    shadow: wmFields.shadow.checked,
    image: wmFields.image.value,
    imageScale: num(wmFields.imageScale, 0.15),
    fromSec: num(wmFields.from, 0),
    toSec: num(wmFields.to, 0)
  }
}

function updateWmHint() {
  const w = collectWmFromUi()
  const parts = []
  const needText = w.mode === 'text' || w.mode === 'both'
  const needImage = w.mode === 'image' || w.mode === 'both'
  if (needText && !w.text) parts.push('文字为空 → 只会打图片水印')
  if (needImage && !w.image) parts.push('没选图片 → 只会打文字水印')
  if (needText && !wmConfig.font) parts.push('没找到可用字体 → 文字水印不会生效')
  const time =
    w.fromSec || w.toSec
      ? `只在 ${w.fromSec || 0}s${w.toSec ? ` – ${w.toSec}s` : ' 之后'} 显示`
      : '全程显示'
  const motionText =
    w.motion === 'static'
      ? '固定位置'
      : `漂移 ${({ 'scroll-x': '横向', 'scroll-y': '纵向', diagonal: '斜向', bounce: '满屏反弹' })[w.motion] || w.motion} ${w.speed}px/s`
  const encText = w.encoder === 'nvenc' ? '显卡 NVENC（快一倍）' : '软件 x264（体积小）'
  const nText = Number(w.firstN) > 0 ? `只加前 ${w.firstN} 个片段` : '全部片段'
  parts.push(
    `${w.mode === 'both' ? '文字+图片' : w.mode === 'image' ? '图片' : '文字'}水印 · ${motionText} · ${time} · ${nText} · ${encText}`
  )
  const fontName = String(w.font || '').split(/[\\/]/).pop()
  if (fontName) parts.push(`字体 ${fontName}`)
  wmHintEl.textContent = parts.join(' · ')
}

for (const el of Object.values(wmFields)) {
  el.addEventListener('change', () => {
    updateWmHint()
    // 剪辑页签里改的水印参数同步到主进程（on 开关沿用「录制时打水印」那个，不在这里抢）
    wmConfig = { ...wmConfig, ...collectWmFromUi(), on: wmConfig.on }
    Promise.resolve(window.pr.recSetOptions({ watermark: { ...collectWmFromUi(), on: wmConfig.on } })).catch(() => {})
  })
  el.addEventListener('input', updateWmHint)
}

document.getElementById('edit-wm-reset').addEventListener('click', () => {
  wmConfig = {
    ...wmConfig,
    mode: 'text',
    text: '',
    size: 28,
    color: '#FFFFFF',
    opacity: 0.85,
    pos: 'br',
    motion: 'static',
    speed: 120,
    encoder: 'x264',
    firstN: 0,
    margin: 20,
    shadow: true,
    image: '',
    imageScale: 0.15,
    fromSec: 0,
    toSec: 0,
    on: false
  }
  syncWmUiFromConfig()
  statusEl.textContent = '水印设置已重置'
  statusEl.className = ''
})

// 字体：列出系统里实际存在的中文字体，也可以自己挑字体文件
document.getElementById('wm-pick-font').addEventListener('click', async () => {
  try {
    const res = await window.pr.recPickFont()
    if (res && res.ok) {
      wmConfig.font = res.path
      syncWmUiFromConfig()
      Promise.resolve(window.pr.recSetOptions({ watermark: { ...collectWmFromUi(), font: res.path, on: wmConfig.on } })).catch(() => {})
      updateWmHint()
    }
  } catch {}
})

async function initFontList() {
  try {
    const res = await window.pr.recListFonts()
    const fonts = (res && res.fonts) || []
    wmFields.font.innerHTML = ''
    for (const f of fonts) {
      const opt = document.createElement('option')
      opt.value = f.path
      opt.textContent = f.label
      wmFields.font.appendChild(opt)
    }
    if (!fonts.length) {
      const opt = document.createElement('option')
      opt.value = ''
      opt.textContent = '（系统里没找到可用字体）'
      wmFields.font.appendChild(opt)
    }
    if (wmConfig.font) wmFields.font.value = wmConfig.font
  } catch {}
}

document.getElementById('wm-pick-image').addEventListener('click', async () => {
  try {
    const res = await window.pr.recPickImage()
    if (res && res.ok) {
      wmFields.image.value = res.path
      wmFields.mode.value = wmFields.mode.value === 'text' ? 'both' : wmFields.mode.value
      updateWmHint()
    }
  } catch {}
})

document.getElementById('wm-clear-image').addEventListener('click', () => {
  wmFields.image.value = ''
  updateWmHint()
})

function renderEditFiles(addedPaths) {
  editFilesEl.innerHTML = ''
  if (!editFiles.length) {
    editFilesEl.innerHTML = '<div class="rec-files-empty">这个目录里没有视频文件。</div>'
    updateEditSelectionUi()
    return
  }
  // 合并顺序 = 修改时间升序（和主进程 mergeRecordings 里 sortByTime 的规则一致）。
  // 列表本身是按时间倒序渲染的，直接照列表顺序拼会得到倒放视频，所以这里显式算一遍并标号。
  const orderMap = new Map()
  editFiles
    .filter((f) => editSelected.has(f.path))
    .sort((a, b) => a.mtime - b.mtime || String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'))
    .forEach((f, i) => orderMap.set(f.path, i + 1))
  // 按分组连续渲染：主进程已按「目录 → 组内时间倒序」排好，
  // 所以同一目录的成片和分段一定挨在一起
  let lastGroup = '\u0000'
  let groupRows = []
  const flushGroup = () => {
    const head = editFilesEl.querySelector('.edit-group:last-of-type')
    if (!head || !groupRows.length) return
    const selectable = groupRows.filter((r) => !r.pending)
    if (!selectable.length) return
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'edit-group-btn'
    btn.textContent = '全选本组'
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const allOn = selectable.every((r) => editSelected.has(r.path))
      for (const r of selectable) {
        if (allOn) editSelected.delete(r.path)
        else editSelected.add(r.path)
      }
      renderEditFiles()
    })
    head.appendChild(btn)
  }
  for (const f of editFiles) {
    const group = f.group || '（目录根）'
    if (group !== lastGroup) {
      flushGroup()
      lastGroup = group
      groupRows = []
      const head = document.createElement('div')
      head.className = 'edit-group'
      const nameSpan = document.createElement('span')
      nameSpan.className = 'eg-name'
      nameSpan.textContent = group
      head.appendChild(nameSpan)
      editFilesEl.appendChild(head)
    }
    groupRows.push(f)
    const row = document.createElement('label')
    const isNew = addedPaths instanceof Set && addedPaths.has(f.path)
    row.className = `edit-row${f.pending ? ' pending' : ''}${isNew ? ' just-added' : ''}`
    const d = new Date(f.mtime)
    const when = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    const tag = f.isOutput ? '<span class="er-tag">成片</span>' : /^part\d+\.mkv$/i.test(f.name) ? '<span class="er-tag part">分段</span>' : ''
    // 合并顺序（按修改时间升序）：选中的行显示 #1 #2 #3，避免"以为按列表顺序拼"
    const orderNo = orderMap.get(f.path)
    const orderTag = orderNo ? `<span class="er-order" title="合并后的第 ${orderNo} 段">#${orderNo}</span>` : ''
    row.innerHTML = `
      <input type="checkbox" data-path="${String(f.path).replace(/"/g, '&quot;')}" ${f.pending ? 'disabled' : ''} />
      ${orderTag}
      <span class="er-name" title="${String(f.path).replace(/"/g, '&quot;')}">${f.name}</span>
      ${tag}
      <span class="er-meta">${fmtGB(f.size)} · ${f.pending ? '录制中' : when}</span>
    `
    const cb = row.querySelector('input')
    cb.checked = editSelected.has(f.path)
    cb.addEventListener('change', () => {
      if (cb.checked) editSelected.add(f.path)
      else editSelected.delete(f.path)
      updateEditSelectionUi()
    })
    editFilesEl.appendChild(row)
  }
  flushGroup()
  updateEditSelectionUi()
}

function updateEditSelectionUi() {
  const n = editSelected.size
  const withWm = document.getElementById('edit-merge-wm').checked
  editSelInfoEl.textContent = `已选 ${n}`
  editMergeBtn.disabled = n < 2
  editApplyBtn.disabled = n < 1
  editMergeBtn.textContent = n >= 2 ? `合并选中（${n}）${withWm ? ' + 水印' : ''}` : withWm ? '合并选中 + 水印' : '合并选中'
  editApplyBtn.textContent = n >= 1 ? `单独加水印（${n}）` : '单独加水印'
  const selectable = editFiles.filter((f) => !f.pending)
  editSelAllEl.checked = selectable.length > 0 && selectable.every((f) => editSelected.has(f.path))
  editSelAllEl.indeterminate = n > 0 && !editSelAllEl.checked
  // 合并的默认文件名跟着选中内容走（提示出来，省得猜）
  const nameEl = document.getElementById('edit-out-name')
  const firstSel = editFiles.find((f) => editSelected.has(f.path))
  const suggest = firstSel && firstSel.group ? firstSel.group : firstSel ? firstSel.name.replace(/\.[^.]+$/, '') + '_合并' : ''
  nameEl.placeholder = suggest ? `留空 = ${suggest}` : '输出文件名（留空自动生成）'
}

editSelAllEl.addEventListener('change', () => {
  editSelected.clear()
  if (editSelAllEl.checked) for (const f of editFiles) if (!f.pending) editSelected.add(f.path)
  renderEditFiles()
})

/**
 * 列表签名：用来判断"目录内容有没有变"，没变就不重绘（避免滚动位置乱跳、闪烁）。
 * 录制中的占位项（pending）大小/时间一直在变，不参与比较。
 */
function editListSignature(files) {
  return files
    .map((f) => (f.pending ? `p|${f.group}|${f.name}` : `f|${f.path}|${f.size}|${Math.round(f.mtime / 1000)}`))
    .join('\n')
}

/** 自动刷新：3 秒一次，只在剪辑页签可见、窗口没最小化时跑 */
const EDIT_POLL_MS = 3000
let editPollTimer = null
let editSignature = ''
let editAutoRefresh = true
try {
  editAutoRefresh = localStorage.getItem('pr.editAuto') !== '0'
} catch {}

function startEditPolling() {
  stopEditPolling()
  editPollTimer = setInterval(() => {
    if (!editAutoRefresh) return
    if (document.getElementById('view-edit').classList.contains('hidden')) return
    if (document.hidden) return
    refreshEditFiles({ silent: true }).catch(() => {})
  }, EDIT_POLL_MS)
}

function stopEditPolling() {
  if (editPollTimer) clearInterval(editPollTimer)
  editPollTimer = null
}

/**
 * 重新读目录。
 * silent = 后台轮询：不显示"正在读取…"，内容没变就完全不重绘；变了也保持滚动位置和选中项。
 */
async function refreshEditFiles({ silent = false, force = false } = {}) {
  if (!silent) editFilesEl.innerHTML = '<div class="rec-files-empty">正在读取…</div>'
  let res
  try {
    res = await window.pr.recList(editDir || undefined)
  } catch (err) {
    if (!silent) editFilesEl.innerHTML = `<div class="rec-files-empty">读取失败：${err && err.message}</div>`
    setEditRefreshStatus('读取失败', true)
    return
  }
  if (res && res.ok === false) {
    editFiles = []
    editSignature = ''
    editFilesEl.innerHTML = `<div class="rec-files-empty">${res.error || '读取失败'}</div>`
    setEditRefreshStatus('目录不存在', true)
    updateEditSelectionUi()
    return
  }
  editDir = (res && res.dir) || editDir
  editDirEl.value = editDir
  const next = (res && res.files) || []
  const sig = editListSignature(next)

  // 内容没变：后台轮询直接跳过（不重绘 → 滚动条、hover 都不会跳）
  if (silent && !force && sig === editSignature) {
    setEditRefreshStatus('')
    return
  }

  // 记下新增的文件，重绘后给它们加个高亮，让"刷新出东西了"看得见
  const beforePaths = new Set(editFiles.map((f) => f.path))
  const addedPaths = new Set(next.filter((f) => !beforePaths.has(f.path)).map((f) => f.path))

  editSignature = sig
  editFiles = next
  // 清掉已经不存在的选中项（文件被删/被移走后不能再拿去合并）
  for (const p of [...editSelected]) if (!editFiles.some((f) => f.path === p)) editSelected.delete(p)

  const scroll = editFilesEl.scrollTop
  renderEditFiles(addedPaths)
  editFilesEl.scrollTop = scroll
  setEditRefreshStatus('')
}

/** 右上角显示一次刷新时间，让人知道列表是活的 */
function setEditRefreshStatus(errText, isErr) {
  const el = document.getElementById('edit-refresh-at')
  if (!el) return
  if (errText) {
    el.textContent = errText
    el.className = 'edit-refresh-at err'
    return
  }
  const d = new Date()
  el.textContent = `刷新于 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
  el.className = 'edit-refresh-at'
}

document.getElementById('edit-choose-dir').addEventListener('click', async () => {
  try {
    const res = await window.pr.recChooseDir(editDir)
    if (res && res.ok) {
      editDir = res.dir
      editSelected.clear()
      editDirEl.value = editDir
      editSignature = ''
      await refreshEditFiles({ force: true })
    }
  } catch (err) {
    editStatusEl.textContent = '选择目录失败：' + (err && err.message)
  }
})
document.getElementById('edit-refresh').addEventListener('click', () => refreshEditFiles({ force: true }))
document.getElementById('edit-open-dir').addEventListener('click', () => {
  Promise.resolve(window.pr.recReveal('')).catch(() => {})
})
// 自动刷新开关（记住选择）
const editAutoEl = document.getElementById('edit-auto-refresh')
if (editAutoEl) {
  editAutoEl.checked = editAutoRefresh
  editAutoEl.addEventListener('change', () => {
    editAutoRefresh = editAutoEl.checked
    try {
      localStorage.setItem('pr.editAuto', editAutoRefresh ? '1' : '0')
    } catch {}
    if (editAutoRefresh) refreshEditFiles({ silent: true, force: true })
    setEditRefreshStatus(editAutoRefresh ? '' : '已关闭自动刷新，用「刷新」按钮')
  })
}
// 切回窗口 / 从后台回来时补一次（轮询在 document.hidden 时会跳过）
window.addEventListener('focus', () => {
  if (document.getElementById('view-edit').classList.contains('hidden')) return
  refreshEditFiles({ silent: true, force: true }).catch(() => {})
})
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return
  if (document.getElementById('view-edit').classList.contains('hidden')) return
  refreshEditFiles({ silent: true, force: true }).catch(() => {})
})
// 回到录制目录：录制目录和分段目录是同一个参数，剪辑页签默认跟随它
document.getElementById('edit-follow-rec').addEventListener('click', async () => {
  editDir = ''
  editSelected.clear()
  editSignature = ''
  await refreshEditFiles({ force: true })
})

/** 「合并时一起加水印」勾上就把当前水印设置随合并一起传下去 */
const editMergeWmEl = document.getElementById('edit-merge-wm')
editMergeWmEl.checked = prefs.mergeWm === true
editMergeWmEl.addEventListener('change', () => {
  savePrefs({ mergeWm: editMergeWmEl.checked })
  updateEditSelectionUi()
  editStatusEl.textContent = editMergeWmEl.checked
    ? '合并会边合并边打水印（重编码一次，比纯封装慢很多）'
    : '合并就是纯封装（不重编码，几秒钟）'
})

editMergeBtn.addEventListener('click', async () => {
  const files = [...editSelected]
  if (files.length < 2) return
  const name = document.getElementById('edit-out-name').value.trim()
  const withWm = editMergeWmEl.checked
  editStatusEl.textContent = withWm
    ? `正在合并 ${files.length} 个文件并打水印（重编码，慢一点）…`
    : `正在合并 ${files.length} 个文件（纯封装，不重编码）…`
  editMergeBtn.disabled = true
  try {
    const payload = { files, name }
    if (withWm) payload.watermark = { ...collectWmFromUi(), on: true }
    const res = await window.pr.recMerge(payload)
    if (res && res.ok) {
      editStatusEl.textContent = `已合并${withWm ? '并加水印' : ''} → ${res.path}（${fmtGB(res.size)}）`
      document.getElementById('edit-out-name').value = ''
      editSelected.clear()
      await refreshEditFiles({ force: true })
    } else {
      editStatusEl.textContent = (res && res.error) || '合并失败'
    }
  } catch (err) {
    editStatusEl.textContent = '合并失败：' + (err && err.message)
  }
  updateEditSelectionUi()
})

editApplyBtn.addEventListener('click', async () => {
  const files = [...editSelected]
  if (!files.length) return
  const wm = collectWmFromUi()
  if ((wm.mode === 'text' || wm.mode === 'both') && !wm.text && !wm.image) {
    editStatusEl.textContent = '水印内容是空的：写点文字或选一张图片'
    return
  }
  const name = document.getElementById('edit-out-name').value.trim()
  editStatusEl.textContent = `正在给 ${files.length} 个文件加水印（重编码，可能比较慢）…`
  editApplyBtn.disabled = true
  try {
    const res = await window.pr.recApplyWatermark({ files, name, watermark: wm })
    if (res && res.ok) {
      editStatusEl.textContent = `水印完成：${(res.outputs || []).map((p) => p.split(/[\\/]/).pop()).join('、')}`
      editSelected.clear()
      await refreshEditFiles({ force: true })
    } else {
      editStatusEl.textContent = (res && res.error) || '加水印失败'
    }
  } catch (err) {
    editStatusEl.textContent = '加水印失败：' + (err && err.message)
  }
  updateEditSelectionUi()
})

async function initEditTab() {
  await initFontList()
  try {
    const res = await window.pr.recGetOptions()
    if (res && res.watermark) {
      wmConfig = { ...wmConfig, ...res.watermark, font: res.font || '', outDir: res.outDir || wmConfig.outDir }
      syncWmUiFromConfig()
      applyRecOptionsToUi()
    }
  } catch {}
  await refreshEditFiles({ force: true })
  startEditPolling()
}

/* ------------------------------ 全屏 ------------------------------ */

const fsBtn = document.getElementById('btn-fullscreen')
const fsHint = document.getElementById('fs-hint')
const winRecBtn = document.getElementById('btn-rec-window')
/** 整窗录制的占位 uid（它不是某个房间） */
const WINDOW_REC_UID = '__window__'

/* 全屏下：鼠标在顶部边缘停留 500ms 才唤出工具栏，移开 500ms 后收起 */
const TOP_SHOW_DELAY = 500
const TOP_HIDE_DELAY = 500
const BAR_AUTO_HIDE = 4000
const HOT_ZONE = 8
let barShowTimer = null
let barHideTimer = null
let barAutoHideTimer = null
/** 焦点在工具栏/输入框里时固定不收起 */
let barFocusHeld = false

const barEl = document.getElementById('bar')

/** 顶部两条（#bar + 视图里的 .row）实际占到的底部位置，用来判断鼠标是否还在工具栏区域 */
function peekBottom() {
  let bottom = 0
  for (const el of [barEl, ...document.querySelectorAll('.view > .row')]) {
    if (!el) continue
    if (getComputedStyle(el).display === 'none') continue
    const r = el.getBoundingClientRect()
    if (r.height > 0) bottom = Math.max(bottom, r.bottom)
  }
  return bottom
}

function clearBarTimers() {
  clearTimeout(barShowTimer)
  clearTimeout(barHideTimer)
  clearTimeout(barAutoHideTimer)
  barShowTimer = null
  barHideTimer = null
  barAutoHideTimer = null
}

function hideBarPeek() {
  // 正在输入就别收
  if (barFocusHeld) return
  document.body.classList.remove('peek')
  clearTimeout(barAutoHideTimer)
  barAutoHideTimer = null
}

function showBarPeek() {
  document.body.classList.add('peek')
  // 兜底：鼠标移进视频区后事件会被 webview 吃掉，给一个自动收起避免卡住
  clearTimeout(barAutoHideTimer)
  barAutoHideTimer = setTimeout(hideBarPeek, BAR_AUTO_HIDE)
}

function scheduleHide(delay) {
  if (barFocusHeld) return
  clearTimeout(barHideTimer)
  barHideTimer = setTimeout(() => {
    barHideTimer = null
    hideBarPeek()
  }, delay)
}

function holdBar() {
  clearTimeout(barHideTimer)
  clearTimeout(barAutoHideTimer)
  barHideTimer = null
  barAutoHideTimer = null
}

function wireBarHover(el) {
  if (!el) return
  el.addEventListener('mouseenter', holdBar)
  el.addEventListener('mouseleave', () => {
    if (!barFocusHeld && document.body.classList.contains('peek')) scheduleHide(TOP_HIDE_DELAY)
  })
  el.addEventListener('focusin', () => {
    barFocusHeld = true
    holdBar()
  })
  el.addEventListener('focusout', (e) => {
    // 焦点移到同一区域里的别的控件上时不算离开
    const next = e.relatedTarget
    if (next && (el.contains(next) || [...document.querySelectorAll('.view > .row')].some((r) => r.contains(next)))) return
    barFocusHeld = false
    if (document.body.classList.contains('peek')) scheduleHide(800)
  })
}

wireBarHover(barEl)
for (const row of document.querySelectorAll('.view > .row')) wireBarHover(row)

document.addEventListener('mousemove', (e) => {
  if (!document.body.classList.contains('fs')) return
  const y = e.clientY
  const peeking = document.body.classList.contains('peek')

  if (y <= HOT_ZONE) {
    if (peeking) {
      holdBar()
      return
    }
    if (!barShowTimer) {
      barShowTimer = setTimeout(() => {
        barShowTimer = null
        showBarPeek()
      }, TOP_SHOW_DELAY)
    }
    return
  }

  // 离开了顶部热区
  if (barShowTimer) {
    clearTimeout(barShowTimer)
    barShowTimer = null
  }

  if (!peeking) return
  // 鼠标还在工具栏区域（两条之和）里就不要收
  if (y <= peekBottom() + 8) {
    holdBar()
    return
  }
  if (!barFocusHeld) scheduleHide(TOP_HIDE_DELAY)
})

async function toggleWindowRecord() {
  if (recMap.has(WINDOW_REC_UID)) {
    try {
      await window.pr.stopRecording(WINDOW_REC_UID)
    } catch {}
    return
  }

  const w = window.innerWidth
  const h = window.innerHeight
  // 只取各瓦片的视频区（.stage），不含工具栏、标题栏和瓦片间隙
  const rects = [...tiles.values()]
    .map((t) => {
      const r = t.stageEl.getBoundingClientRect()
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height)
      }
    })
    .filter((r) => r.width > 8 && r.height > 8 && r.y < h && r.x < w)

  // 一个瓦片都没有就没有"拼成一张干净画面"的意义；而且这时会退化成录整个窗口
  // （连边上的录制红框都会被录进去），所以直接拒绝
  if (!rects.length) {
    statusEl.textContent = '没有打开的直播瓦片，整窗录制没用武之地（它录的是各瓦片的画面）'
    statusEl.className = 'err'
    return
  }

  let res = null
  try {
    res = await window.pr.startRecording({
      uid: WINDOW_REC_UID,
      forceScreen: true,
      label: document.body.classList.contains('fs') ? '全屏录制' : '窗口录制',
      rect: { x: 0, y: 0, width: w, height: h },
      rects: rects.length ? rects : null,
      contentWidth: w,
      contentHeight: h,
      fps: REC_FPS,
      bitrate: bitrateFor({ width: w, height: h })
    })
  } catch (err) {
    res = { ok: false, error: err && err.message }
  }

  if (res && res.ok === false) {
    statusEl.textContent = '整窗录制失败：' + res.error
    statusEl.className = 'err'
  }
}

if (winRecBtn) winRecBtn.addEventListener('click', () => toggleWindowRecord())
let fsHintTimer = null

function applyFullscreenUi(isFull) {
  const changed = document.body.classList.contains('fs') !== Boolean(isFull)
  document.body.classList.toggle('fs', Boolean(isFull))
  if (changed) console.log('[fs] apply', Boolean(isFull), document.body.className)
  if (!isFull) {
    clearBarTimers()
    hideBarPeek()
    // 退出全屏必须把工具栏还回来：否则之前手动收起过的话，看起来就是"工具栏没了"
    if (barHidden) {
      barHidden = false
      applyBarHidden()
    }
  }
  if (fsBtn) {
    fsBtn.classList.toggle('on', Boolean(isFull))
    fsBtn.textContent = isFull ? '退出全屏' : '全屏'
  }

  // 顶部没有任何常驻 UI：提示 3 秒后自己淡出
  clearTimeout(fsHintTimer)
  if (isFull && fsHint) {
    fsHint.classList.remove('gone')
    fsHintTimer = setTimeout(() => fsHint.classList.add('gone'), 3500)
  } else if (fsHint) {
    fsHint.classList.remove('gone')
  }

  // 高度变化后让瓦片重新贴合
  requestAnimationFrame(() => layout())
}

function toggleFullscreen() {
  Promise.resolve(window.pr.toggleFullscreen()).catch(() => {})
}

fsBtn.addEventListener('click', () => toggleFullscreen())

window.pr.onFullscreen((isFull) => applyFullscreenUi(isFull))

// 兜底：事件有可能漏（例如焦点在 webview 里、或全屏由系统触发），每秒对一次真实状态
let fsSyncBusy = false
setInterval(async () => {
  if (fsSyncBusy) return
  fsSyncBusy = true
  try {
    const actual = await window.pr.isFullscreen()
    if (Boolean(actual) !== document.body.classList.contains('fs')) {
      console.log('[fs] resync ->', Boolean(actual))
      applyFullscreenUi(Boolean(actual))
    }
  } catch {
    // 忽略：主进程在重载时可能短暂不可用
  } finally {
    fsSyncBusy = false
  }
}, 1000)

/* ------------------------------ 手动收起工具栏 ------------------------------ */

const hideBarBtn = document.getElementById('btn-hide-bar')
const barHandleEl = document.getElementById('bar-handle')
/** 手动收起状态：只在本次运行内有效，不跨重启记住 */
let barHidden = false

function applyBarHidden() {
  document.body.classList.toggle('bar-hidden', Boolean(barHidden))
  requestAnimationFrame(() => layout())
}

if (hideBarBtn) {
  hideBarBtn.addEventListener('click', () => {
    // 全屏下 ▴ 就是把浮出的工具栏收回去
    if (document.body.classList.contains('fs')) {
      hideBarPeek()
      return
    }
    barHidden = true
    applyBarHidden()
  })
}

if (barHandleEl) {
  barHandleEl.addEventListener('click', () => {
    if (document.body.classList.contains('fs')) {
      showBarPeek()
      return
    }
    barHidden = false
    applyBarHidden()
  })
}

applyBarHidden()

// 主进程转来的工具栏显隐快捷键（Ctrl+Shift+H），任何状态下都能用
window.pr.onToggleBar(() => {
  if (document.body.classList.contains('peek')) {
    hideBarPeek()
    return
  }
  barHidden = !barHidden
  applyBarHidden()
})

// 主进程转来的 F1 / ?（焦点在 guest 里时渲染层收不到 keydown）
if (window.pr.onOpenHelp) {
  window.pr.onOpenHelp(() => {
    openHelp()
  })
}

window.addEventListener('keydown', (e) => {
  // F11 / 全屏态的 Esc 都在主进程拦截（before-input-event），这里只处理页面内的键
  if (e.key === 'Escape') {
    if (!document.body.classList.contains('fs') && focusUid) {
      setFocus(null)
      return
    }
    if (helpDialog && !helpDialog.classList.contains('hidden')) {
      closeHelp()
      return
    }
    closePopup()
    return
  }
  // 输入框里打字不算快捷键
  const tag = (e.target && e.target.tagName) || ''
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable)) return
  if (e.ctrlKey || e.altKey || e.metaKey) return

  if (e.key === 'F1' || e.key === '?' || (e.key === '/' && e.shiftKey)) {
    e.preventDefault()
    openHelp()
    return
  }
  // 聚焦布局：1~9 直接把第 N 号瓦片换到中间（编号就是瓦片左上角那个数字）
  if (gridPreset === 'focus' && /^[1-9]$/.test(e.key) && tiles.size > 1) {
    const want = Number(e.key)
    let i = 0
    for (const [uid] of tiles) {
      i += 1
      if (i === want) {
        e.preventDefault()
        if (uid !== spotlightUid) setSpotlight(uid)
        return
      }
    }
  }
})

window.addEventListener('resize', layout)

window.addEventListener('beforeunload', () => {
  const rooms = [...tiles.values()].map((t) => ({ url: t.url, muted: t.muted }))
  Promise.resolve(window.pr.saveRooms(rooms)).catch(() => {})
})

/* ------------------------------ 监控列表 ------------------------------ */

const cardsEl = document.getElementById('cards')
const cardsEmptyEl = document.getElementById('cards-empty')
const monForm = document.getElementById('mon-form')
const monInput = document.getElementById('mon-input')
const monSelInfo = document.getElementById('mon-sel-info')
const monIntervalEl = document.getElementById('mon-interval')
const monSearchEl = document.getElementById('mon-search')
const monSortEl = document.getElementById('mon-sort')

/** @type {Array<any>} */
let watchers = []
let lastBlockedUntil = 0
let followState = { at: 0, size: 0, ok: false, needLogin: false, empty: false }
let probingState = { id: '', total: 0, done: 0, startedAt: 0 }
let onlySpecial = prefs.onlySpecial === true
/** 卡片排序方式：added=按添加顺序（稳定）｜live=在播优先｜name=按名字｜recent=最近检测 */
let monitorSort = 'added'
try {
  const savedSort = localStorage.getItem('pr.monSort')
  if (savedSort && ['added', 'live', 'name', 'recent'].includes(savedSort)) monitorSort = savedSort
} catch {}
/** 监控列表的搜索关键词（匹配主播名 / 房间号 / 链接） */
let monitorQuery = typeof prefs.monQuery === 'string' ? prefs.monQuery : ''
const selectedIds = new Set()

function switchTab(name) {
  for (const btn of document.querySelectorAll('#tabs .tab')) {
    btn.classList.toggle('active', btn.dataset.tab === name)
  }
  document.getElementById('view-watch').classList.toggle('hidden', name !== 'watch')
  document.getElementById('view-monitor').classList.toggle('hidden', name !== 'monitor')
  document.getElementById('view-edit').classList.toggle('hidden', name !== 'edit')
  const debugView = document.getElementById('view-debug')
  if (debugView) debugView.classList.toggle('hidden', name !== 'debug')
  savePrefs({ tab: name })
  if (name === 'watch') layout()
  // 切到剪辑页就立刻刷一次（后台轮询在页签隐藏时会暂停）
  if (name === 'edit') refreshEditFiles({ silent: true, force: true }).catch(() => {})
  // 调试页只在显示时刷新，别在后台一直跑
  if (name === 'debug') {
    refreshDebug({ force: true })
    startDebugLoop()
  } else {
    stopDebugLoop()
  }
}

function agoText(ts) {
  if (!ts) return '未检测'
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s} 秒前`
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  return `${Math.floor(s / 3600)} 小时前`
}

const STATUS_TEXT = { live: '直播中', offline: '未开播', unknown: '检测中', error: '探测失败', unconfirmed: '待复核' }
const JUST_LIVE_MS = 5 * 60 * 1000

/* ------------------------------ 调试页 ------------------------------ */
/*
 * 回答两个问题：
 *  1) 现在这些房间占用了什么（几个 webview 页面 / 几个进程 / 页面里几个音源在响）
 *  2) 关掉之后这些资源有没有真的释放（生命周期账本：id、创建、销毁、存活时长）
 */

const DBG_POLL_MS = 2000
const dbgTilesEl = document.getElementById('dbg-tiles')
const dbgContentsEl = document.getElementById('dbg-contents')
const dbgLifeEl = document.getElementById('dbg-life')
const dbgProcsEl = document.getElementById('dbg-procs')
const dbgSummaryEl = document.getElementById('dbg-summary')
const dbgAutoEl = document.getElementById('dbg-auto')
let dbgTimer = null
let dbgBusy = false
let dbgLastSnap = null
/** 刚被我们关掉的 guest id（生命周期表里标出来，方便一眼看它有没有被销毁） */
const dbgJustClosed = new Set()

function dbgEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

function dbgClock(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function dbgDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

function dbgTable(head, rows) {
  if (!rows.length) return `<p class="dbg-empty">（空）</p>`
  return `<table class="dbg"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr${r.cls ? ` class="${r.cls}"` : ''}>${r.cells.map((c) => `<td>${c}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`
}

/** 在 guest 页面里数音源：几个 video/audio、几个"在播且未静音" */
const MEDIA_PROBE = `(() => {
  const items = []
  for (const el of document.querySelectorAll('video, audio')) {
    const r = el.getBoundingClientRect()
    items.push({
      tag: el.tagName.toLowerCase(),
      paused: !!el.paused,
      muted: !!el.muted,
      volume: Math.round((el.volume || 0) * 100) / 100,
      t: Math.round((el.currentTime || 0) * 10) / 10,
      w: el.videoWidth || 0,
      h: el.videoHeight || 0,
      area: Math.round(r.width * r.height)
    })
  }
  const playing = items.filter((x) => !x.paused && !x.muted && x.volume > 0)
  return { count: items.length, playing: playing.length, items }
})()`

function dbgWithTimeout(promise, ms, fallback) {
  return Promise.race([
    Promise.resolve(promise).catch((err) => ({ error: String((err && err.message) || err) })),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms))
  ])
}

async function dbgCollectTileMedia() {
  const rows = []
  for (const [uid, t] of tiles) {
    let wcId = -1
    try {
      wcId = t.view.getWebContentsId()
    } catch {}
    let audible = null
    try {
      audible = t.view.isCurrentlyAudible()
    } catch {}
    const media = await dbgWithTimeout(t.view.executeJavaScript(MEDIA_PROBE, false), 2500, {
      error: 'timeout（页面主线程卡住，读不出来）'
    })
    rows.push({ uid, url: t.url, wcId, muted: t.muted, audible, media })
  }
  return rows
}

/** 从 url 里取房间号 */
function dbgRoomId(url) {
  return (String(url || '').match(/live\.douyin\.com\/(\d{5,})/) || [])[1] || ''
}

/** 直播间名字：优先瓦片里读到的页面标题，其次监控列表里存的名字 */
function dbgRoomName(url, tile) {
  const rid = dbgRoomId(url)
  let name = ''
  if (tile) {
    const raw = (tile.nameEl && tile.nameEl.textContent) || (tile.titleEl && tile.titleEl.textContent) || ''
    name = String(raw)
      .replace(/的抖音直播间.*$/, '')
      .replace(/\s*[-|]\s*抖音.*$/, '')
      .replace(/正在进入…?$/, '')
      .trim()
  }
  if (!name && rid) {
    try {
      const w = (typeof watchers !== 'undefined' ? watchers : []).find((x) => String(x.roomId || '') === rid)
      if (w && w.name) name = String(w.name).trim()
      else if (w && w.title) name = String(w.title).replace(/的抖音直播间.*$/, '').trim()
    } catch {}
  }
  return name
}

/** "名字 · 房 6126…" 这种一格显示 */
function dbgRoomCell(url, tile, titleHint) {
  const rid = dbgRoomId(url)
  let name = dbgRoomName(url, tile)
  if (!name && titleHint) {
    name = String(titleHint)
      .replace(/的抖音直播间.*$/, '')
      .replace(/\s*[-|]\s*抖音.*$/, '')
      .trim()
  }
  const label = name || '（名字未知）'
  const idText = rid ? `房 ${rid}` : '—'
  return `<span title="${dbgEsc(url)}"><b>${dbgEsc(label)}</b> <span class="dbg-dim">· ${dbgEsc(idText)}</span></span>`
}

function dbgRenderTiles(rows) {
  if (!dbgTilesEl) return
  if (!rows.length) {
    dbgTilesEl.innerHTML = '<p class="dbg-empty">当前没有打开的观看瓦片。</p>'
    return
  }
  dbgTilesEl.innerHTML = dbgTable(
    ['直播间', 'guest', '本房间静音', '页面在产生音频', '页面媒体元素数', '同时出声的音源数', '明细'],
    rows.map((r) => {
      const m = r.media || {}
      const danger = (m.playing || 0) > 1
      const detail = m.items
        ? m.items
            .map(
              (i) =>
                `${i.tag}${i.paused ? ' ⏸' : ' ▶'}${i.muted ? ' 🔇' : ' 🔊'} vol=${i.volume} t=${i.t}s ${i.w}×${i.h}`
            )
            .join(' ／ ')
        : m.error || '—'
      const tile = tiles.get(r.uid) || null
      return {
        cls: danger ? 'warn' : '',
        cells: [
          dbgRoomCell(r.url, tile),
          r.wcId > 0 ? r.wcId : '—',
          r.muted ? '🔇' : '🔊',
          r.audible === null ? '—' : r.audible ? '是' : '否',
          m.count === undefined ? '—' : m.count,
          m.playing === undefined ? '—' : `<b${danger ? ' class="bad"' : ''}>${m.playing}</b>`,
          dbgEsc(detail)
        ]
      }
    })
  )
}

/** webContents 的角色 → 中文标签（决定表格里怎么显示、要不要高亮） */
const DBG_ROLE = {
  main: { text: '主窗口', mon: false },
  tile: { text: '观看瓦片', mon: false },
  probe: { text: '监控探测窗', mon: true },
  'probe-follow': { text: '关注列表探测窗', mon: true },
  recorder: { text: '录制窗', mon: false },
  aux: { text: '弹窗/登录窗', mon: false },
  other: { text: '其它', mon: false }
}

function dbgRoleOf(c) {
  const r = DBG_ROLE[c.role] || DBG_ROLE.other
  return r
}

/** 类型 + 角色标签；监控（探测）用的资源加醒目色 */
function dbgTypeCell(c, mainId) {
  const role = dbgRoleOf(c)
  const hidden = c.type === 'window' && c.id !== mainId && c.visible === false
  const parts = [`<span class="dbg-type">${dbgEsc(c.type || '?')}</span>`]
  if (role.mon) parts.push(`<span class="dbg-chip mon">${role.text}</span>`)
  else if (role.text && c.role !== 'other') parts.push(`<span class="dbg-chip">${role.text}</span>`)
  if (hidden && !role.mon) parts.push('<span class="dbg-chip dim">隐藏</span>')
  return parts.join(' ')
}

function dbgRenderContents(list, mainId) {
  if (!dbgContentsEl) return
  const rows = (list || []).map((c) => {
    const alive = !c.destroyed
    const canRelease = alive && c.id !== mainId
    const role = dbgRoleOf(c)
    return {
      cls: role.mon ? 'dbg-mon' : alive && c.audible && c.type === 'tile' ? '' : '',
      cells: [
        c.id,
        dbgTypeCell(c, mainId),
        c.destroyed ? '已销毁' : '活着',
        c.audible ? '<b class="bad">是</b>' : '否',
        c.muted ? '🔇' : '—',
        c.loading ? '加载中' : '—',
        c.type === 'webview' || /douyin\.com/.test(c.url || '')
          ? dbgRoomCell(c.url, null, c.title)
          : `<span title="${dbgEsc(c.url)}">${dbgEsc(String(c.url || '').slice(0, 70))}</span>`,
        canRelease
          ? `<button class="dbg-btn" type="button" data-wcid="${c.id}" title="手工关闭这个页面/进程">释放</button>`
          : c.id === mainId
            ? '<span class="dbg-dim">主窗口</span>'
            : ''
      ]
    }
  })
  dbgContentsEl.innerHTML = dbgTable(
    ['id', '类型 / 用途', '状态', '在产生音频', '已被静音', '加载中', '是谁 / url', '操作'],
    rows
  )
}


function dbgRenderLifecycle(list, mainId) {
  if (!dbgLifeEl) return
  const rows = (list || []).slice(0, 24).map((r) => {
    const justClosed = dbgJustClosed.has(r.id)
    const alive = !r.destroyed
    const role = dbgRoleOf(r)
    const cls = justClosed ? (alive ? 'warn' : 'ok') : role.mon ? 'dbg-mon' : ''
    const isMain = r.id === mainId
    return {
      cls,
      cells: [
        r.id,
        dbgTypeCell({ ...r, visible: null }, mainId),
        dbgClock(r.created),
        r.destroyed ? dbgClock(r.destroyed) : '—',
        dbgDur(r.aliveMs),
        r.destroyed ? '✅ 已释放' : '⏳ 仍在',
        dbgRoomCell(r.url, null, r.title),
        alive && !isMain
          ? `<button class="dbg-btn" type="button" data-wcid="${r.id}" title="手工关闭这个页面/进程">释放</button>`
          : isMain
            ? '<span class="dbg-dim">主窗口</span>'
            : ''
      ]
    }
  })
  dbgLifeEl.innerHTML = dbgTable(
    ['id', '类型 / 用途', '创建', '销毁', '存活', '状态', '是谁', '操作'],
    rows
  )
}

function dbgRenderSide(snap) {
  if (!snap) return
  if (dbgProcsEl) {
    const procs = snap.processes || []
    const totalMb = procs.reduce((a, p) => a + (p.memMb || 0), 0)
    const procRows = procs.map((p) => ({
      cls: p.type === 'Tab' && p.cpu > 30 ? 'warn' : '',
      cells: [p.pid, p.type, `${p.cpu}%`, `${p.memMb} MB`]
    }))
    const streams = snap.streams || []
    const streamRows = streams.map((s) => ({
      cells: [
        s.webContentsId,
        s.kind,
        dbgDur(s.ageSec * 1000) + ' 前',
        s.candidates,
        `<span title="${dbgEsc(s.url)}">${dbgEsc(String(s.url).slice(0, 60))}</span>`
      ]
    }))
    dbgProcsEl.innerHTML =
      dbgTable(['pid', '类型', 'CPU', '内存'], procRows) +
      `<p class="dbg-note">进程合计 ${procs.length} 个 / ${totalMb.toFixed(1)} MB</p>` +
      (streamRows.length ? dbgTable(['guest', '类型', '抓到时间', '候选数', '直录流地址'], streamRows) : '')
  }
  if (dbgSummaryEl) {
    const contents = snap.contents || []
    const liveWebviews = contents.filter((c) => c.type === 'webview' && !c.destroyed).length
    const audible = contents.filter((c) => c.audible).length
    const mem = (snap.processes || []).reduce((a, p) => a + (p.memMb || 0), 0)
    const guard = snap.watch || {}
    // 监控（探测）占用的资源单独点名，这是最容易"看不见却在动"的一类
    const monRows = contents.filter((c) => (DBG_ROLE[c.role] || {}).mon)
    const monAlive = monRows.filter((c) => !c.destroyed)
    const monUnmuted = monAlive.filter((c) => !c.muted)
    let monText = ''
    if (monAlive.length) {
      monText = ` · 监控探测资源 ${monAlive.length} 个（${monAlive.map((c) => '#' + c.id).join(' ')}，${
        monUnmuted.length ? `⚠ 有 ${monUnmuted.length} 个没静音` : '已静音'
      }）`
    }
    dbgSummaryEl.textContent =
      `瓦片 ${tiles.size} · 登记 guest ${(guard.tileGuests || []).length} · 活着的 webview 页面 ${liveWebviews} · ` +
      `在出声的 webContents ${audible} · 进程 ${(snap.processes || []).length} 个 / ${mem.toFixed(1)} MB` +
      monText +
      ((guard.orphans || []).length ? ` · ⚠ 孤儿页面 ${guard.orphans.length} 个` : '')
  }
}

async function refreshDebug() {
  if (!dbgTilesEl || dbgBusy) return
  dbgBusy = true
  try {
    const media = await dbgCollectTileMedia()
    let snap = null
    try {
      snap = await window.pr.debugSnapshot()
    } catch (err) {
      snap = null
    }
    if (!snap) return
    dbgLastSnap = { ...snap, tileMedia: media }
    dbgRenderTiles(media)
    dbgRenderContents(snap.contents, snap.mainWebContentsId)
    dbgRenderLifecycle(snap.lifecycle, snap.mainWebContentsId)
    dbgRenderSide(snap)
  } finally {
    dbgBusy = false
  }
}

/** 手工释放：点了「释放」的页面直接关掉（主窗口自己不给关） */
async function dbgRelease(wcid) {
  const id = Number(wcid)
  if (!Number.isInteger(id) || id <= 0) return
  try {
    const res = await window.pr.debugRelease(id)
    if (res && res.ok) {
      statusEl.textContent = `已释放 ${id} 号页面（${res.type || '?'}，${res.how}）`
      statusEl.className = 'ok'
    } else {
      statusEl.textContent = '释放失败：' + ((res && res.error) || '未知原因')
      statusEl.className = 'err'
    }
  } catch (err) {
    statusEl.textContent = '释放失败：' + ((err && err.message) || err)
    statusEl.className = 'err'
  }
  await new Promise((r) => setTimeout(r, 500))
  await refreshDebug()
}

function startDebugLoop() {
  stopDebugLoop()
  if (!dbgAutoEl || !dbgAutoEl.checked) return
  dbgTimer = setInterval(() => refreshDebug(), DBG_POLL_MS)
}

function stopDebugLoop() {
  if (dbgTimer) {
    clearInterval(dbgTimer)
    dbgTimer = null
  }
}

if (dbgTilesEl) {
  document.getElementById('dbg-refresh').addEventListener('click', () => refreshDebug())
  // 「释放」按钮用事件委托：两张表都是整块重绘的，逐个挂监听会漏
  const onReleaseClick = (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('.dbg-btn') : null
    if (!btn) return
    e.preventDefault()
    e.stopPropagation()
    btn.disabled = true
    dbgRelease(btn.dataset.wcid)
  }
  dbgContentsEl.addEventListener('click', onReleaseClick)
  dbgLifeEl.addEventListener('click', onReleaseClick)
  document.getElementById('dbg-save').addEventListener('click', async () => {
    try {
      const payload = dbgLastSnap || (await window.pr.debugSnapshot())
      const res = await window.pr.debugSave(payload)
      if (res && res.ok) {
        statusEl.textContent = '快照已保存：' + res.path
        statusEl.className = 'ok'
      } else {
        statusEl.textContent = '保存失败：' + ((res && res.error) || '未知原因')
        statusEl.className = 'err'
      }
    } catch (err) {
      statusEl.textContent = '保存失败：' + ((err && err.message) || err)
      statusEl.className = 'err'
    }
  })
  document.getElementById('dbg-close-all').addEventListener('click', async () => {
    if (!tiles.size) {
      statusEl.textContent = '当前没有打开的观看瓦片'
      statusEl.className = ''
      await refreshDebug()
      return
    }
    // 记下关之前的 guest id，等资源释放后再复查它们
    dbgJustClosed.clear()
    for (const t of tiles.values()) {
      try {
        const id = t.view.getWebContentsId()
        if (Number.isInteger(id) && id > 0) dbgJustClosed.add(id)
      } catch {}
    }
    const ids = [...dbgJustClosed]
    focusUid = null
    for (const uid of [...tiles.keys()]) removeRoom(uid, { batch: true })
    scheduleSave()
    statusEl.textContent = `已关闭 ${ids.length} 个房间页面，2.5 秒后复查释放情况…`
    statusEl.className = ''
    await new Promise((r) => setTimeout(r, 2500))
    await refreshDebug()
    const snap = dbgLastSnap
    const still = ((snap && snap.lifecycle) || []).filter((r) => dbgJustClosed.has(r.id) && !r.destroyed)
    statusEl.textContent = still.length
      ? `⚠ ${still.length} / ${ids.length} 个页面还没释放：${still.map((r) => r.id).join(', ')}`
      : `✅ ${ids.length} 个页面全部已释放（见「生命周期」里标绿的几行）`
    statusEl.className = still.length ? 'warn' : 'ok'
  })
  dbgAutoEl.addEventListener('change', () => {
    if (dbgAutoEl.checked) startDebugLoop()
    else stopDebugLoop()
  })
}


/** 当前在「观看」页打开着的房间号集合（用于给监控卡片打「观看中」标记） */
function openRoomIdSet() {
  const set = new Set()
  for (const t of tiles.values()) {
    const m = String(t.url || '').match(/live\.douyin\.com\/(\d{5,})/)
    if (m) set.add(m[1])
  }
  return set
}

/** 从输入里取出房间号（房间号 / 链接 / 分享文案都能认） */
function roomIdFromInput(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  const live = s.match(/live\.douyin\.com\/(\d{5,})/)
  if (live) return live[1]
  const bare = s.match(/^(\d{5,})$/)
  if (bare) return bare[1]
  const any = s.match(/\d{6,}/)
  return any ? any[0] : ''
}

/**
 * 在监控列表里找"这个输入已经加过了"的那一条。
 * 同时按房间号和归一化后的 URL 比（同一房间的两种链接形式不会重复加进来）。
 */
function findWatcherByInput(raw) {
  const rid = roomIdFromInput(raw)
  const key = bareUrl(raw)
  for (const w of watchers) {
    if (rid && String(w.roomId || '') === rid) return w
    if (key && bareUrl(w.url) === key) return w
  }
  return null
}

/** 让某张监控卡片闪一下并滚到中间（重复添加时告诉用户"就是这张"） */
function flashCard(id) {
  if (id === undefined || id === null || id === '') return false
  const card = cardsEl.querySelector(`.card[data-id="${String(id).replace(/"/g, '')}"]`)
  if (!card) return false
  try {
    card.scrollIntoView({ block: 'center', behavior: 'smooth' })
  } catch {}
  card.classList.remove('flash')
  void card.offsetWidth
  card.classList.add('flash')
  setTimeout(() => card.classList.remove('flash'), 1500)
  return true
}

function buildCard(w) {
  const card = document.createElement('article')
  card.className = `card status-${w.status || 'unknown'}`
  card.dataset.id = w.id

  const justLive = w.status === 'live' && w.liveSince > 0 && Date.now() - w.liveSince < JUST_LIVE_MS
  if (justLive) card.classList.add('just-live')
  if (w.special) card.classList.add('special')
  if (probingState.id && probingState.id === w.id) card.classList.add('probing')
  const watching = openRoomIdSet().has(String(w.roomId || ''))
  if (watching) card.classList.add('watching')

  const checked = selectedIds.has(w.id) ? 'checked' : ''
  const cover = w.cover
    ? `<div class="card-cover" style="background-image:url('${String(w.cover).replace(/'/g, '%27')}')"></div>`
    : `<div class="card-cover placeholder"><span>${(w.name || w.roomId || '?').slice(0, 1)}</span></div>`

  const metaParts = []
  if (w.blocked) metaParts.push('⚠ 被验证码拦截')
  if (w.unverified) metaParts.push('⚠ 未确认')
  if (w.status === 'live') {
    if (w.online) metaParts.push(`${w.online} 人在看`)
    if (w.liveSince) metaParts.push(`开播 ${agoText(w.liveSince)}`)
  }
  metaParts.push(w.checkedAt ? `最后检测 ${agoText(w.checkedAt)}` : '从未检测')
  // 超过 20 分钟没探过：状态可能是旧的，别让人误信
  const stale = w.checkedAt > 0 && Date.now() - w.checkedAt > 20 * 60 * 1000
  if (stale) metaParts.push('◦ 状态可能过期')
  if (stale) card.classList.add('expired')

  card.innerHTML = `
    <div class="card-top">
      <label class="card-check"><input type="checkbox" ${checked} /></label>
      <button class="star-btn ${w.special ? 'on' : ''}" type="button" title="${w.special ? '取消特别关注' : '标为特别关注（会优先高频探测）'}">${w.special ? '★' : '☆'}</button>
      <div class="card-actions">
        <button class="mini open" type="button">打开</button>
        <button class="mini del" type="button">移除</button>
      </div>
      <span class="status-dot">${justLive ? '刚开播' : STATUS_TEXT[w.status] || '未知'}</span>
    </div>
    ${cover}
    ${watching ? '<span class="watch-chip" title="这个房间正在「观看」页打开">▶ 观看中</span>' : ''}
    <div class="card-body">
      <div class="card-name" title="${(w.title || w.url || '').replace(/"/g, '&quot;')}">${w.name || w.roomId || w.url}</div>
      <div class="card-meta">${metaParts.join(' · ')}</div>
    </div>
  `

  const starBtn = card.querySelector('.star-btn')
  starBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    Promise.resolve(window.pr.toggleSpecial(w.id)).catch(() => {})
  })

  const check = card.querySelector('input[type="checkbox"]')
  check.addEventListener('change', () => {
    if (check.checked) selectedIds.add(w.id)
    else selectedIds.delete(w.id)
    renderSelInfo(lastBlockedUntil)
  })

  card.querySelector('.open').addEventListener('click', (e) => {
    e.stopPropagation()
    openWatchers([w])
  })
  card.querySelector('.del').addEventListener('click', (e) => {
    e.stopPropagation()
    selectedIds.delete(w.id)
    Promise.resolve(window.pr.removeWatcher(w.id)).catch(() => {})
  })

  return card
}

function renderSelInfo(blockedUntil) {
  const parts = [`已选 ${selectedIds.size}`]
  const specialCount = watchers.filter((w) => w.special).length
  if (specialCount) parts.push(`★ ${specialCount}`)
  const q = monitorQuery.trim()
  if (q) {
    const hit = (onlySpecial ? watchers.filter((w) => w.special) : watchers).filter((w) => matchQuery(w, q)).length
    parts.push(`匹配 ${hit}`)
  }

  // 检测进度：正在探第几个 / 一共几个
  if (probingState.id) {
    const name = (watchers.find((w) => w.id === probingState.id) || {}).name || '房间'
    if (probingState.total > 1) {
      parts.push(`检测中 ${Math.min(probingState.done + 1, probingState.total)}/${probingState.total}（${name}）`)
    } else {
      parts.push(`检测中：${name}`)
    }
  }

  const left = Number(blockedUntil) - Date.now()
  if (left > 0) {
    parts.push(`验证码冷却 ${Math.ceil(left / 60000)} 分钟`)
  }
  monSelInfo.textContent = parts.join(' · ')
  monSelInfo.classList.toggle('warn', left > 0)
  monSelInfo.classList.toggle('busy', Boolean(probingState.id))
}

function matchQuery(w, q) {
  if (!q) return true
  const hay = [w.name, w.roomId, w.url, w.title].filter(Boolean).join(' ').toLowerCase()
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => hay.includes(token))
}

function renderStats() {
  const statsEl = document.getElementById('mon-stats')
  if (!statsEl) return
  const total = watchers.length
  const live = watchers.filter((w) => w.status === 'live').length
  const offline = watchers.filter((w) => w.status === 'offline').length
  const unknown = watchers.filter((w) => !w.status || w.status === 'unknown').length
  const err = watchers.filter((w) => w.status === 'error').length
  const unverified = watchers.filter((w) => w.unverified).length
  const blocked = watchers.filter((w) => w.blocked).length
  const special = watchers.filter((w) => w.special).length
  const checked = watchers.filter((w) => w.checkedAt > 0).length
  const lastChecked = watchers.reduce((m, w) => Math.max(m, w.checkedAt || 0), 0)

  const parts = [
    `共 ${total} 个`,
    `在播 ${live}`,
    `未开播 ${offline}`,
    `未检测 ${unknown}`,
    `★ ${special}`
  ]
  if (err) parts.push(`失败 ${err}`)
  if (unverified) parts.push(`⚠ 未确认 ${unverified}`)
  if (blocked) parts.push(`被拦截 ${blocked}`)
  parts.push(`已检测 ${checked}/${total}`)
  parts.push(lastChecked ? `最后检测 ${agoText(lastChecked)}` : '还没检测过')

  statsEl.textContent = parts.join('　·　')
  statsEl.className = blocked ? 'warn' : ''
}

/** 卡片排序用的稳定基准：watcher.id 是自增序号，代表添加顺序 */
function addedRank(w) {
  const n = Number(w.id)
  return Number.isFinite(n) ? n : 0
}

/** 状态优先级（只用于「在播优先」这一种排序） */
const STATUS_ORDER = { live: 0, unknown: 1, error: 2, unconfirmed: 3, offline: 4 }

/**
 * 按 monitorSort 给卡片排序。
 * 关键点：每种模式最后都用「添加顺序」兜底，这样同一批数据重排多次结果一致，
 * 不会因为 checkedAt 之类的字段每次探测都变而让卡片乱跳。
 */
function sortCards(list) {
  const arr = [...list]
  const byAdded = (a, b) => addedRank(a) - addedRank(b)
  if (monitorSort === 'live') {
    arr.sort((a, b) => {
      if (Boolean(a.special) !== Boolean(b.special)) return a.special ? -1 : 1
      const s = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
      return s !== 0 ? s : byAdded(a, b)
    })
  } else if (monitorSort === 'name') {
    arr.sort((a, b) => {
      const an = String(a.name || a.title || a.roomId || a.url)
      const bn = String(b.name || b.title || b.roomId || b.url)
      const c = an.localeCompare(bn, 'zh-Hans-CN')
      return c !== 0 ? c : byAdded(a, b)
    })
  } else if (monitorSort === 'recent') {
    arr.sort((a, b) => {
      const c = (b.checkedAt || 0) - (a.checkedAt || 0)
      return c !== 0 ? c : byAdded(a, b)
    })
  } else {
    // added：完全稳定，只按添加顺序，状态怎么变都不动位置
    arr.sort(byAdded)
  }
  return arr
}

function renderCards() {
  const q = monitorQuery.trim()
  const visible = (onlySpecial ? watchers.filter((w) => w.special) : watchers).filter((w) => matchQuery(w, q))
  const hasAny = visible.length > 0
  cardsEmptyEl.classList.toggle('hidden', hasAny)
  if (!hasAny && watchers.length) {
    cardsEmptyEl.classList.remove('hidden')
    cardsEmptyEl.innerHTML = `<h2>没有匹配“${q.replace(/[<>&]/g, '')}”的房间</h2><p>换个关键词，或清空搜索框。</p>`
  } else if (hasAny) {
    cardsEmptyEl.innerHTML = `<h2>监控列表是空的</h2><p>把常看的主播直播间地址加进来，会自动探测是否在播。</p>`
  }
  for (const el of [...cardsEl.querySelectorAll('.card')]) el.remove()

  for (const w of sortCards(visible)) cardsEl.appendChild(buildCard(w))

  // 清掉已经不存在的选中项
  for (const id of [...selectedIds]) {
    if (!watchers.some((w) => w.id === id)) selectedIds.delete(id)
  }
  renderSelInfo(lastBlockedUntil)
  renderStats()
}

function openWatchers(list) {
  if (!list.length) return
  for (const w of list) {
    const url = w.url
    if ([...tiles.values()].some((t) => bareUrl(t.url) === bareUrl(url))) continue
    addRoom(url)
  }
  switchTab('watch')
}

function wireMonitor() {
  for (const btn of document.querySelectorAll('#tabs .tab')) {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab))
  }

  monForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    const raw = monInput.value.trim()
    if (!raw) return

    // 先在本地判一次重：省掉一次网络往返，也让"已经有了"的提示立刻出来
    const dupLocal = findWatcherByInput(raw)
    if (dupLocal) {
      const label = dupLocal.name || dupLocal.roomId || bareUrl(dupLocal.url)
      monInput.value = ''
      monInput.classList.remove('bad')
      void monInput.offsetWidth
      monInput.classList.add('bad')
      setTimeout(() => monInput.classList.remove('bad'), 900)
      statusEl.textContent = `这个直播间已经在监控列表里了：${label}`
      statusEl.className = 'warn'
      flashCard(dupLocal.id)
      monSelInfo.textContent = '已在列表里'
      setTimeout(() => renderSelInfo(lastBlockedUntil), 2200)
      return
    }

    try {
      const res = await window.pr.addWatcher(raw)
      if (!res || res.ok === false) {
        // 短链解析出来的房间可能也已经在列表里（本地那次判断看不穿 /v/ 短链）
        monInput.value = raw
        monInput.classList.add('bad')
        setTimeout(() => monInput.classList.remove('bad'), 900)
        const msg = res && res.error ? res.error : '添加失败'
        statusEl.textContent = msg
        statusEl.className = res && res.duplicate ? 'warn' : 'err'
        if (res && res.dupId) flashCard(res.dupId)
        monSelInfo.textContent = msg
        setTimeout(() => renderSelInfo(lastBlockedUntil), 2500)
        return
      }
      monInput.value = ''
      statusEl.textContent = '已加入监控列表，稍后会自动探测是否在播'
      statusEl.className = 'ok'
    } catch (err) {
      console.warn('[monitor] add failed', err)
    }
  })

  document.getElementById('mon-probe').addEventListener('click', async () => {
    try {
      // 传 null = 全部检测；空数组 = 用户没勾选（由主进程拒绝）
      const res = await window.pr.probeWatchers(null)
      if (res && res.ok === false) {
        statusEl.textContent = res.error || '无法开始检测'
        statusEl.className = 'warn'
      } else if (res && res.count) {
        statusEl.textContent = `开始检测 ${res.count} 个房间（每个约 6–10 秒，请稍候）`
        statusEl.className = ''
      }
    } catch {}
  })

  document.getElementById('mon-probe-sel').addEventListener('click', async () => {
    const ids = [...selectedIds]
    if (!ids.length) {
      statusEl.textContent = '先在卡片上勾选要检测的房间'
      statusEl.className = 'warn'
      return
    }
    try {
      const res = await window.pr.probeWatchers(ids)
      if (res && res.ok === false) {
        statusEl.textContent = res.error || '无法开始检测'
        statusEl.className = 'warn'
      } else if (res && res.count) {
        statusEl.textContent = res.queued
          ? `已排队 ${res.count} 个房间，等当前这一轮探测结束就开始`
          : `开始检测 ${res.count} 个房间（每个约 6–10 秒）`
        statusEl.className = ''
      }
    } catch {}
  })

  const onlySpecialBtn = document.getElementById('mon-only-special')
  // 恢复上次的筛选状态（只看特别关注 / 搜索词）
  onlySpecialBtn.classList.toggle('on', onlySpecial)
  if (monitorQuery) monSearchEl.value = monitorQuery
  onlySpecialBtn.addEventListener('click', (e) => {
    onlySpecial = !onlySpecial
    e.currentTarget.classList.toggle('on', onlySpecial)
    savePrefs({ onlySpecial })
    renderCards()
  })

  monSearchEl.addEventListener('input', () => {
    monitorQuery = monSearchEl.value
    savePrefs({ monQuery: monitorQuery })
    renderCards()
  })
  monSearchEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      monSearchEl.value = ''
      monitorQuery = ''
      savePrefs({ monQuery: '' })
      renderCards()
    }
  })

  document.getElementById('mon-open').addEventListener('click', () => {
    const list = watchers.filter((w) => selectedIds.has(w.id))
    openWatchers(list)
  })

  monIntervalEl.addEventListener('change', () => {
    const ms = Number(monIntervalEl.value) * 1000
    Promise.resolve(window.pr.setProbeInterval(ms)).catch(() => {})
  })

  if (monSortEl) {
    monSortEl.value = monitorSort
    monSortEl.addEventListener('change', () => {
      const v = monSortEl.value
      if (!['added', 'live', 'name', 'recent'].includes(v)) return
      monitorSort = v
      try {
        localStorage.setItem('pr.monSort', v)
      } catch {}
      renderCards()
    })
  }
}

async function initMonitor() {
  try {
    const snap = await window.pr.loadWatchers()
    watchers = (snap && snap.watchers) || []
    lastBlockedUntil = (snap && snap.blockedUntil) || 0
    if (snap && snap.follow) followState = { ...followState, ...snap.follow }
    if (snap && snap.interval) monIntervalEl.value = String(Math.round(snap.interval / 1000))
  } catch (err) {
    console.warn('[monitor] load failed', err)
  }
  renderCards()
  window.pr.onWatchersChanged((snap) => {
    watchers = (snap && snap.watchers) || []
    lastBlockedUntil = (snap && snap.blockedUntil) || 0
    if (snap && snap.follow) followState = { ...followState, ...snap.follow }
    if (snap && snap.probing) probingState = { ...probingState, ...snap.probing }
    if (snap && snap.interval) monIntervalEl.value = String(Math.round(snap.interval / 1000))
    renderCards()
  })

  // 每 20 秒重绘一次，让"最后检测 N 分钟前"是活的
  setInterval(() => {
    if (document.getElementById('view-monitor').classList.contains('hidden')) return
    renderCards()
  }, 20000)
}

/* ------------------------------ 启动 ------------------------------ */

async function init() {
  let st = null
  try {
    st = await window.pr.loadState()
  } catch (err) {
    console.warn('[init] 读取状态失败', err)
  }

  if (st) {
    ua = st.ua || ''
    partition = st.partition || partition
    isolate = st.isolate === true
    for (const r of Array.isArray(st.rooms) ? st.rooms : []) {
      const url = normalizeRoom(r && r.url)
      if (url) addRoom(url, { muted: r.muted === true })
    }
    // 命令行指定的房间（--rooms / PR_ROOMS），已经在列表里的跳过
    for (const raw of Array.isArray(st.pending) ? st.pending : []) {
      const url = normalizeRoom(raw)
      if (!url) continue
      if ([...tiles.values()].some((t) => bareUrl(t.url) === bareUrl(url))) continue
      addRoom(url)
    }
  }

  layout()
  updateCount()
  // 先把上次保存的开关状态回填到界面（只看画面 / 弹幕面板 / 礼物 / 画质）
  applyViewToggleUi()
  wireRecorder()
  wireMonitor()
  await initMonitor()
  await initRecOptions()
  await initEditTab()
  // 恢复上次停在哪个页签
  if (prefs.tab === 'monitor' || prefs.tab === 'edit') switchTab(prefs.tab)
  inputEl.focus()
}

init()