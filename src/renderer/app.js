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
  if (!t || t.local || t.camera || t.studio || t.stage) return
  // 虎牙走自己那一套（页面里有 蓝光8M/蓝光4M/超清/流畅）
  if (platformOf(t.url) === 'huya') {
    const want = String(prefs.huyaQuality || 'auto')
    const items = [
      {
        label: '自动（挑能用的最高档：蓝光8M → 蓝光4M → 超清）',
        checked: want === 'auto',
        action: () => {
          savePrefs({ huyaQuality: 'auto' })
          prefs.huyaQuality = 'auto'
          for (const [id, tt] of tiles) if (platformOf(tt.url) === 'huya') applyHuyaQuality(id, { want: 'auto', verbose: true })
        }
      },
      { sep: true }
    ]
    for (const q of HUYA_Q_ORDER) {
      items.push({
        label: q + (q === '蓝光8M' || q === '蓝光4M' ? '（要登录虎牙）' : ''),
        checked: want === q,
        sub: true,
        action: () => {
          savePrefs({ huyaQuality: q })
          prefs.huyaQuality = q
          for (const [id, tt] of tiles) if (platformOf(tt.url) === 'huya') applyHuyaQuality(id, { want: q, verbose: true })
        }
      })
    }
    showPopup(x, y, items, `虎牙画质 · ${describeTile(t)}`)
    return
  }
  // 斗鱼：没接它的画质菜单（页面里自己选），这里只给个说明，别弹一堆对斗鱼无效的档位
  if (platformOf(t.url) === 'douyu') {
    showPopup(
      x,
      y,
      [
        { head: '斗鱼的画质要在页面里自己选（右下角齿轮）' },
        { sep: true },
        { head: '录制走屏幕录制：清晰度跟着瓦片大小走' }
      ],
      `斗鱼 · ${describeTile(t)}`
    )
    return
  }
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

/**
 * 虎牙画质：虎牙页面自己是"流畅"起步的（实测 800×450），要 1080p 得在页面的
 * 画质菜单里手动点「蓝光8M / 蓝光4M」（这两个档位要登录，未登录会显示"请先登录"）。
 * 这里直接把页面自己的 `.player-videotype-cur` → `.player-videotype-list > li` 点一遍，
 * 效果跟人手点一样（实测点「超清」后视频从 800×450 变成 1280×720）。
 */
const HUYA_Q_ORDER = ['蓝光8M', '蓝光4M', '超清', '流畅']
function huyaQualityScript(want) {
  return `(() => {
    const want = ${JSON.stringify(want)}
    const order = ${JSON.stringify(HUYA_Q_ORDER)}
    const curEl = document.querySelector('.player-videotype-cur')
    if (!curEl) return 'no-ui'
    const lis = () => Array.from(document.querySelectorAll('.player-videotype-list > li'))
    let items = lis()
    if (!items.length) { curEl.click(); items = lis() }
    if (!items.length) return 'no-list'
    const raw = (li) => (li.textContent || '').trim()
    const locked = (li) => /请先登录/.test(raw(li))
    const label = (li) => raw(li).replace(/请先登录/g, '').trim()
    const free = items.filter((li) => !locked(li)).map(label)
    const cur = raw(curEl).replace(/请先登录/g, '').trim()
    const target = want === 'auto' ? order.find((q) => free.indexOf(q) >= 0) : want
    if (!target) return 'none-available:' + free.join('/')
    if (cur === target) return 'already:' + cur
    const hit = items.find((li) => label(li) === target && !locked(li))
    if (!hit) return 'locked:' + target + ';free=' + free.join('/')
    hit.click()
    return 'switched:' + cur + '->' + target
  })()`
}

/** 给某个虎牙瓦片应用画质（auto = 蓝光8M → 蓝光4M → 超清 → 流畅，挑能用的最高档） */
function applyHuyaQuality(uid, opts = {}) {
  const t = tiles.get(uid)
  if (!t || t.removed) return
  if (platformOf(t.url) !== 'huya') return
  const want = String(opts.want || prefs.huyaQuality || 'auto')
  Promise.resolve(t.view.executeJavaScript(huyaQualityScript(want), true))
    .then((r) => {
      if (opts.verbose) {
        statusEl.textContent = `虎牙画质：${r}`
        statusEl.className = /switched|already/.test(String(r)) ? 'ok' : 'warn'
      }
      return r
    })
    .catch(() => {})
}

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
  if (!t || t.removed || t.local || t.camera || t.studio || t.stage) return
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
  // 本地文件：完整地址（含路径）才算同一个，不同文件不能合并
  if (s.startsWith('prmedia:') || s.startsWith('local:')) return s.split('#')[0]
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
 * 顺带把"当前实际画质"读回来（分辨率 + 页面自己的画质名 + 这几秒的平均码率）。
 */
function guestScript(muted, applyQuality, volume, qualityOverride) {
  return `(() => {
    const vids = [...document.querySelectorAll('video')]
    const bodyText = (document.body && document.body.innerText) || ''
    const otherRoom = bodyText.includes('账号已在其他地方进入直播间')

    /** 当前实际画质：分辨率取真视频，画质名读页面控件，码率用 resource timing 估算 */
    const probeQuality = (v) => {
      const out = { w: 0, h: 0, name: '', kbps: 0 }
      try {
        out.w = (v && v.videoWidth) | 0
        out.h = (v && v.videoHeight) | 0
      } catch (e) {}
      try {
        const cur = document.querySelector('.player-videotype-cur')
        if (cur) out.name = (cur.textContent || '').replace(/请先登录/g, '').trim().slice(0, 14)
      } catch (e) {}
      try {
        if (!out.name) {
          const sel = document.querySelector(
            '.xgplayer-quality-definition,.xgplayer-definition,[data-e2e="quality"],[class*="qualityName"],[class*="definition"]'
          )
          if (sel) out.name = (sel.textContent || '').trim().slice(0, 14)
        }
      } catch (e) {}
      // 码率：把这一轮累计的 transferSize 与上一轮做差，除以间隔秒数
      try {
        let bytes = 0
        const res = performance.getEntriesByType('resource') || []
        for (const e of res) bytes += e.transferSize || e.encodedBodySize || 0
        const now = performance.now()
        const prev = window.__prNet
        window.__prNet = { bytes, t: now }
        if (prev && now - prev.t > 200 && bytes >= prev.bytes) {
          out.kbps = Math.round(((bytes - prev.bytes) / 1024 / (now - prev.t)) * 1000)
        }
      } catch (e) {}
      return out
    }

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
    /**
     * ⚠️ 不能无脑用 vids[0]：斗鱼房间页里除了直播画面，还会塞**广告** video
     * （sta-op.douyucdn.cn/nggsys/…）和空的占位 video。实测刷新后 vids[0] 是那个
     * 没有源的空 video（readyState=0 / videoWidth=0），真正的直播画面在 vids[1]。
     * 以前按 vids[0] 铺满 + 静音其余，结果直播那一路被静音、空 video 被拉满整块瓦片
     * → 用户看到的就是"点刷新/点录制就黑屏"。
     * 现在按"谁真在出画面"打分挑一个：有视频尺寸 > 无限时长（直播）> 未暂停 > 面积大，广告减分。
     */
    const isAdVideo = (el) => {
      try {
        const s = String(el.currentSrc || el.src || '')
        return /(sta-op\.douyucdn|\\/nggsys\\/|adss|\\/advert|\\/ads?\\/)/i.test(s)
      } catch (e) {
        return false
      }
    }
    const scoreOf = (el) => {
      let s = 0
      try {
        if (el.videoWidth > 0 && el.videoHeight > 0) s += 100
        if (!isFinite(el.duration) || el.duration === Infinity) s += 40
        if (!el.paused && el.readyState >= 2) s += 20
        const r = el.getBoundingClientRect()
        s += Math.min(19, Math.round((r.width * r.height) / 100000))
        if (isAdVideo(el)) s -= 80
      } catch (e) {}
      return s
    }
    const v = vids.slice().sort((a, b) => scoreOf(b) - scoreOf(a))[0]
    const hasPicture = Boolean(v && v.videoWidth > 0 && v.videoHeight > 0)

    // 页面里的"已结束"文案：标题在下播后不会变，这句才是可靠判据
    const endedHit = (bodyText.match(/直播已结束|主播已下播|已下播|未开播|暂未开播/) || [''])[0]

    // 只看画面：沿 video 的祖先链把每一层的兄弟节点全藏掉
    // （这样右侧弹幕栏、底部礼物栏、飘屏弹幕层、页头一次性都去掉），再让视频铺满
    if (${pure ? 'true' : 'false'} && hasPicture) {
      try {
        let node = v
        for (let depth = 0; depth < 40; depth++) {
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
        // ⚠️ 祖先链到 body 就停了，所以**放在 body 这一层的站点外壳**（斗鱼的
        // header#js-header「首页 / 直播 / 分类 / 下载…」、右侧 aside「我的关注 / 排行榜」、
        // 以及 main 之外的浮动广告）根本轮不到隐藏。
        // 这里补一刀：把 node（这条链的顶端）以外的 body 子节点也清掉。
        try {
          const host = node && node.parentElement
          if (host) {
            const keep = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'NOSCRIPT', 'TEMPLATE'])
            for (const sib of host.children) {
              if (sib === node || sib.dataset.prPure || keep.has(sib.tagName)) continue
              const r = sib.getBoundingClientRect()
              if (r.width < 2 && r.height < 2) continue
              sib.dataset.prPure = 'hidden'
              sib.style.setProperty('display', 'none', 'important')
            }
          }
        } catch (e) {}
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

    // 斗鱼：就算关了「只看画面」，站点外壳也别留着 —— 顶部「首页/直播/分类/下载」和右侧
    // 「我的关注/排行榜」点一下就跳出直播间了，在瓦片里没意义。播放器 + 弹幕区不动。
    if (!${pure ? 'true' : 'false'} && /(^|\\.)douyu\\.com$/i.test(location.hostname)) {
      try {
        const pick = [
          '#js-header',
          '[class*="Header-wrap"]',
          'body > aside',
          '[class*="footer__"]',
          '[id^="liveActivityGiftHall"]',
          '#giftNamingEnter',
          '#actRandomEffectGiftBanner'
        ]
        for (const sel of pick) {
          for (const el of document.querySelectorAll(sel)) {
            if (el.dataset.prDouyuHidden) continue
            el.dataset.prDouyuHidden = '1'
            el.style.setProperty('display', 'none', 'important')
          }
        }
        // 斗鱼房间页在播放器上面还压着一大块封面/推荐区（实测 video 的 y≈980），
        // 关了「只看画面」时把它滚到顶上，省得每次都要自己往下拉。
        if (!window.__prDouyuScrolled) {
          const vr = v.getBoundingClientRect()
          if (vr.top > 8) {
            window.__prDouyuScrolled = true
            try {
              v.scrollIntoView({ block: 'start', behavior: 'auto' })
            } catch (e) {}
          }
        }
      } catch (e) {}
    }

    const want = ${muted ? 'true' : 'false'}
    if (v.muted !== want) v.muted = want
    // 一个页面里可能有多个 video：虎牙实测同时有主画面(横向) + 一个竖屏推荐浮窗，
    // 斗鱼还会有广告 video。这里只留"选中的那一路"出声，其余一律静音。
    try {
      for (const ov of vids) {
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

    // 抓弹幕/礼物。
    // 1) 优先按容器取（抖音的弹幕列表项），比整页 innerText 干净得多，也不会把
    //    "在线观众 / 1000奉献用户 / 需先登录" 这类页面文案混进来；
    // 2) 容器选择器万一改了就退回整页文本。
    // 纯净模式下面是"挪出视口"而不是 display:none，所以文字（含 CSS 生成的冒号）仍然读得到。
    let danmu = []
    if (${showDanmu ? 'true' : 'false'}) {
      try {
        const giftRe = /(送出|赠送|送了|投喂|加入了粉丝团|点亮了)/
        // 系统提示（X 来了 / X 加入了直播间…）：冷清房间只有这些，有真弹幕时让位
        const sysRe = /(来了$|加入了直播间|关注了主播|分享了直播间|为主播点赞|等级提升|进入直播间)/
        const junkRe = /^(在线观众|全部|高等级用户|需先登录|开启读屏标签|读屏标签已关闭|[·\\-–—]+$|\\d+)$/

        const raw = []
        try {
          for (const el of document.querySelectorAll(
            '[class*="chatroom___item"],[class*="chatroom___bottom-message"],[class*="chatroom___list"] div'
          )) {
            let s = ''
            try {
              s = (el.innerText || el.textContent || '').trim()
            } catch (e) {}
            if (s) raw.push(s)
          }
        } catch (e) {}
        // 容器里抓到了行 → 这些行本身就是弹幕，过滤可以放宽
        let containerHit = raw.length > 0
        if (!raw.length) {
          for (const line of bodyText.split('\\n')) {
            const s = line.trim()
            if (s) raw.push(s)
          }
        }

        const seen = new Set()
        const chat = []
        const sys = []
        for (const s0 of raw) {
          const text = s0.replace(/\\s+/g, ' ').trim().slice(0, 120)
          if (text.length < 2) continue
          if (junkRe.test(text)) continue
          const isGift = giftRe.test(text)
          const isChat = /[:：]/.test(text)
          const isSys = !isChat && !isGift && sysRe.test(text)
          // 从弹幕容器里抠出来的行本身就是弹幕，只要不是垃圾行就收；
          // 整页文本兜底时才严格要求"像弹幕"
          if (!isChat && !isGift && !isSys && !containerHit) continue
          if (isGift && !${showGift ? 'true' : 'false'}) continue
          const line = isGift ? '🎁 ' + text : text
          if (seen.has(line)) continue
          seen.add(line)
          if (isSys) sys.push(line)
          else chat.push(line)
        }
        // 有真弹幕就只显示真弹幕；一条都没有时才把"X 来了"这类垫上
        danmu = (chat.length >= 2 ? chat : chat.concat(sys)).slice(-${danmuLines})
      } catch (e) {}
    }

    return { ok: true, paused: v.paused, t: Math.round(v.currentTime * 10) / 10, otherRoom, revealed, danmu, endedHit, pic: hasPicture, q: probeQuality(v) }
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
    t.danmuBuf = []
    return
  }

  const hasNew = Array.isArray(lines) && lines.length > 0
  if (hasNew) {
    t.danmuAt = Date.now()
    /*
     * 抖音的弹幕列表是虚拟列表：容器里同一时刻只有最后 1~2 行。
     * 所以这里做"滚动累积"：每轮把新行接在后面，按行数上限截断，
     * 面板才能看到最近 N 条，而不是一闪一跳只显示一条。
     */
    const buf = Array.isArray(t.danmuBuf) ? t.danmuBuf.slice() : []
    for (const line of lines) {
      const s = String(line || '').trim()
      if (!s) continue
      if (buf.length && buf[buf.length - 1] === s) continue
      // 同一条在很近的位置重复出现时也跳过（防止一屏都是同一句）
      if (buf.slice(-3).includes(s)) continue
      buf.push(s)
    }
    t.danmuBuf = buf.slice(-danmuLines)
    const text = t.danmuBuf.join('\n')
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

/* ------------------------- 卡住 / 卡顿的自检测与自愈 ------------------------- */
/*
 * 用户看到「看着看着卡住」时，其实是两种完全不同的东西：
 *  1) 页面主线程卡住：抖音/虎牙的重房间（或已下播的房间）里，站点自己的 JS 把主线程占满，
 *     这时 executeJavaScript 不返回、画面停住、点刷新/录制都没反应。实测这种页面能 73~110 秒不应答。
 *  2) 画面冻住但页面还活着：播放器在缓冲 / 换 CDN / 流断了，currentTime 不往前走。
 * 两种都在这里盯：
 *  · 主线程卡：上一轮还没回来就不再派新的（越叠越死），持续 15 秒自动 reload 一次
 *  · 画面冻：连续 25 秒 currentTime 不动，先 play()，还不动就 reload 一次
 *  · 同一个瓦片 3 分钟内最多自动重载一次，避免"永远在重载"
 * 每次自动重载都写进 rec.log（调试页第 5 节可见），下次再卡能对得上时间点。
 */
/** 页面主线程多久不答应算卡住 */
const STUCK_JS_MS = 3000
/** 卡这么久就自动重载（≈3 轮 watchdog） */
const STUCK_RELOAD_MS = 15000
/** 画面时间多久不前进算冻住 */
const FROZEN_RELOAD_MS = 25000
/** 同一瓦片两次自动重载的最小间隔 */
const AUTO_RELOAD_GAP_MS = 3 * 60 * 1000

/** 记一笔到 rec.log（失败就算了，不影响播放） */
function uiLog(kind, msg) {
  try {
    Promise.resolve(window.pr.uiLog(kind, msg)).catch(() => {})
  } catch {}
}

/**
 * 自动重载一个瓦片（节流）。
 * @returns {boolean} 这次到底重载了没有
 */
function tileAutoReload(uid, why, overlayText) {
  const t = tiles.get(uid)
  if (!t || t.local || t.camera || t.studio || t.stage) return false
  const now = Date.now()
  if (t.autoReloadAt && now - t.autoReloadAt < AUTO_RELOAD_GAP_MS) return false
  t.autoReloadAt = now
  t.autoReloadCount = (t.autoReloadCount || 0) + 1
  t.pokeAt = 0
  t.stuckSince = 0
  t.stuckShown = false
  t.frozenSince = 0
  t.frozenShown = false
  t.pokes = 0
  uiLog('tile', `${why} → auto reload #${t.autoReloadCount} ${roomLabel(t.url)} ${uid}`)
  if (statusEl) statusEl.textContent = `${why}，正在自动重载这一格…（已第 ${t.autoReloadCount} 次）`
  showOverlay(t, overlayText || '卡住了，正在自动重载…')
  // 主线程卡死时 view.reload() 是排不进队的（渲染进程自己都在死循环里），
  // 只能让主进程把这个渲染进程崩掉、再重载 —— 等于换一个干净进程重开这一格。
  const hard = /卡住|没响应/.test(why)
  let wcId = 0
  try {
    wcId = t.view.getWebContentsId()
  } catch {}
  const softReload = () => {
    try {
      t.view.reload()
    } catch {
      showOverlay(t, '自动重载失败，点这一格上的 ⟳ 手动刷新', true)
    }
  }
  if (hard && wcId > 0) {
    t.crashReload = true
    Promise.resolve(window.pr.tileHardReload(wcId))
      .then((r) => {
        if (!r || !r.ok) {
          t.crashReload = false
          uiLog('tile', `hard reload failed: ${(r && r.error) || 'unknown'} → fallback reload`)
          softReload()
        }
      })
      .catch(() => {
        t.crashReload = false
        softReload()
      })
    return true
  }
  softReload()
  return true
}

/** 这个瓦片是不是正在录（录制中自动重载会断流，所以阈值放宽） */
function tileRecording(uid) {
  try {
    return typeof recMap !== 'undefined' && recMap.has(uid)
  } catch {
    return false
  }
}

/** 每次 watchdog 醒来都检查一次：上一轮是不是还没回来（= 主线程卡住） */
function checkTileStuck(uid) {
  const t = tiles.get(uid)
  if (!t || !t.pokeAt) return
  const now = Date.now()
  const busyMs = now - t.pokeAt
  if (busyMs < STUCK_JS_MS) return
  t.stuckSince = t.stuckSince || now
  const stuckMs = now - t.stuckSince
  if (!t.stuckShown) {
    t.stuckShown = true
    if (statusEl) {
      statusEl.textContent = `「${roomLabel(t.url)}」页面没响应 ${Math.round(busyMs / 1000)} 秒${
        tileRecording(uid) ? '（正在录制，暂不自动重载）' : `（继续卡 ${Math.round(STUCK_RELOAD_MS / 1000)} 秒会自动重载这一格）`
      }`
    }
  }
  if (stuckMs >= STUCK_RELOAD_MS) {
    // 正在录制的房间尽量别自动重载（重载会断流）；除非卡得离谱（45 秒）
    const limit = tileRecording(uid) ? STUCK_RELOAD_MS * 3 : STUCK_RELOAD_MS
    if (stuckMs >= limit) {
      tileAutoReload(uid, `页面主线程卡住 ${Math.round(stuckMs / 1000)}s`, '页面卡住了，正在自动重载…')
    }
  }
}

/** 画面冻住检测：从每轮的 currentTime 看它有没有往前走 */
function checkTileFrozen(uid, r) {
  const t = tiles.get(uid)
  if (!t || !r || typeof r.t !== 'number') return
  const now = Date.now()
  if (r.paused) {
    // 暂停了说明不是"冻住"，是播放器停了：已经 play() 过了，等下一轮
    t.frozenSince = 0
    return
  }
  if (t.lastCt !== undefined && Math.abs(r.t - t.lastCt) < 0.1) {
    t.frozenSince = t.frozenSince || now
    const frozenMs = now - t.frozenSince
    if (!t.frozenShown && frozenMs > 8000) {
      t.frozenShown = true
      if (statusEl) {
        statusEl.textContent = `「${roomLabel(t.url)}」画面停了 ${Math.round(frozenMs / 1000)} 秒（在缓冲 / 换线路），继续停会自动重载`
      }
    }
    if (frozenMs >= FROZEN_RELOAD_MS) {
      const limit = tileRecording(uid) ? FROZEN_RELOAD_MS * 2 : FROZEN_RELOAD_MS
      if (frozenMs >= limit) {
        tileAutoReload(uid, `画面停住 ${Math.round(frozenMs / 1000)}s`, '画面停住了，正在自动重载…')
      }
    }
  } else {
    t.frozenSince = 0
    t.frozenShown = false
  }
  t.lastCt = r.t
}

function pokeGuest(uid) {
  const t = tiles.get(uid)
  if (!t || t.local || t.camera || t.studio || t.stage) return
  // 上一轮还没回来：页面主线程卡着。别再往上叠（叠只会越卡越死），交给 checkTileStuck 判重载
  if (t.pokeAt) {
    checkTileStuck(uid)
    return
  }
  // 前几轮顺带切画质（播放器重初始化后需要再切一次），之后就不再重复点
  const applyQuality = (t.pokes || 0) < 6
  t.pokes = (t.pokes || 0) + 1
  const startedAt = Date.now()
  t.pokeAt = startedAt
  try {
    const p = t.view.executeJavaScript(guestScript(t.muted, applyQuality, t.volume, tileQuality(t)), true)
    if (p && typeof p.then === 'function') {
      p.then((r) => {
        if (t.pokeAt === startedAt) t.pokeAt = 0
        t.stuckSince = 0
        t.stuckShown = false
        if (!r || typeof r !== 'object') return
        setOtherRoom(uid, r.otherRoom === true)
        renderDanmu(uid, r.danmu)
        // 没有画面时别让瓦片一片空白：角标写清「无画面 / 已下播」，让人知道不是卡死了
        if (!r.pic) {
          const why = r.endedHit ? '已下播' : '无画面'
          setTileQualityBadge(uid, { w: 0, h: 0, name: why })
          if (t.qEl) t.qEl.title = r.endedHit ? '这个房间已经下播了（页面里读到"已下播"）' : '这个房间现在没有画面：还在加载、或者已下播'
        } else {
          setTileQualityBadge(uid, r.q)
        }
        checkTileFrozen(uid, r)
        reportTileStatus(uid, r)
      }).catch(() => {
        if (t.pokeAt === startedAt) t.pokeAt = 0
      })
    } else {
      t.pokeAt = 0
    }
  } catch {
    // guest 未就绪
    t.pokeAt = 0
  }
  // 虎牙：顺手把签名好的直录流地址报给主进程（录制用；每次重读，签名过期也能跟上）
  reportHuyaStream(uid, t)
  // 斗鱼：主进程用移动站接口取 HLS 直录地址（5 分钟续一次，token 有小时级有效期）
  reportDouyuStream(uid, t)
}

/** 让主进程续一次斗鱼直录地址（见 main.js douyuStreamCandidates） */
function reportDouyuStream(uid, t) {
  if (!t || platformOf(t.url) !== 'douyu') return
  const now = Date.now()
  if (t.douyuNextAt && now < t.douyuNextAt) return
  t.douyuNextAt = now + 5 * 60 * 1000
  let wcId = 0
  try {
    wcId = t.view.getWebContentsId()
  } catch {
    return
  }
  Promise.resolve(window.pr.douyuStreams(t.url, wcId))
    .then((r) => {
      if (!r || !r.ok || !Array.isArray(r.urls) || !r.urls.length) {
        t.douyuError = (r && r.error) || '取流失败'
        t.douyuStreamOk = false
        return
      }
      t.douyuError = ''
      t.douyuStreamOk = true
    })
    .catch((err) => {
      t.douyuError = String((err && err.message) || err)
      t.douyuStreamOk = false
    })
}

/** 分辨率 → 「1080P / 720P …」这种短标签（中间档不硬凑，直接写实际高度） */
function resLabel(h) {
  const v = Math.round(Number(h) || 0)
  if (v >= 4000) return '8K'
  if (v >= 2100) return '4K'
  if (v >= 1400) return '1440P'
  if (v >= 1060) return '1080P'
  if (v >= 700) return '720P'
  if (v >= 530) return '540P'
  if (v >= 470) return '480P'
  return v ? `${v}P` : ''
}

/**
 * 瓦片顶栏那枚「画质」角标：页面里真的在播什么分辨率 / 页面的画质名 / 这几秒的平均码率。
 * 页面上没有视频（还没加载完 / 已下播）就藏起来。
 */
function setTileQualityBadge(uid, q) {
  const t = tiles.get(uid)
  if (!t || !t.qEl) return
  const w = Number(q && q.w) || 0
  const h = Number(q && q.h) || 0
  const res = resLabel(h)
  const name = String((q && q.name) || '').replace(/\s+/g, '')
  if (!res && !name) {
    t.qEl.classList.add('hidden')
    t.qEl.textContent = ''
    t.qEl.title = ''
    return
  }
  const text = name && res ? `${name} · ${res}` : name || res
  // 页面画质名本身就叫「1080P」时别写成「1080P · 1080P」
  const sameThing = name && res && name.replace(/\s/g, '').toUpperCase().replace('P', '') === res.toUpperCase().replace('P', '')
  const finalText = sameThing ? res : text
  if (t.qEl.textContent !== finalText) t.qEl.textContent = finalText
  const setting = tileQuality(t)
  const parts = []
  if (w && h) parts.push(`实际分辨率 ${w}×${h}`)
  if (name) parts.push(`页面画质名「${name}」`)
  if (q && q.kbps > 0) parts.push(`最近 ≈${q.kbps} KB/s`)
  parts.push(`本房间设置：${setting ? QUALITY_LABELS[setting] || setting : '不干预'}`)
  const title = parts.join(' · ')
  if (t.qEl.title !== title) t.qEl.title = title
  t.qEl.classList.remove('hidden')
}

/* ------------------------------ 平台适配（抖音 / 虎牙） ------------------------------ */

/** 站点判定：决定"直录流地址从哪来"、"哪些页面细节要特殊处理" */
function platformOf(u) {
  const s = String(u || '')
  if (/huya\.com/i.test(s)) return 'huya'
  if (/douyu\.com/i.test(s)) return 'douyu'
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
  if (t.studio || t.stage) return
  if (t.mediaEl) {
    // 本地音视频 / 摄像头：直接改 <video> 自己的属性
    t.mediaEl.muted = Boolean(t.muted)
    t.mediaEl.volume = typeof t.volume === 'number' ? Math.max(0, Math.min(1, t.volume)) : 1
  } else {
    try {
      t.view.setAudioMuted(t.muted)
    } catch {
      // guest 还没 attach，dom-ready 时会再试
    }
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

/** 瓦片顶栏的 HTML（直播间和本地音视频瓦片共用一套） */
const TILE_HEAD_HTML = `
    <div class="tile-head">
      <span class="idx"></span>
      <span class="title">正在进入…</span>
      <span class="badge hidden">非当前房间</span>
      <span class="tile-q hidden"></span>
      <button class="act rec" type="button" title="开始录制这个房间">● 开始</button>
      <button class="act rec-split hidden" type="button" title="分段：把这一段收好（立刻出成片），同时接着录下一段，不停止录制">✂ 分段</button>
      <button class="act rec-replay hidden" type="button" title="精彩片段：把最近一段单独存出来（不停止录制）">⟲ 精彩</button>
      <input class="act vol" type="range" min="0" max="100" step="5" value="100" title="这个房间的音量（每个房间独立）" />
      <button class="act mute" type="button">🔇</button>
      <button class="act solo" type="button" title="放大 / 还原">⤢</button>
      <button class="act reload" type="button" title="重新加载">⟳</button>
      <button class="act close" type="button" title="关闭">✕</button>
    </div>`

/** 本地文件的播放地址（自定义协议，支持 Range，见 main.js） */
function mediaUrl(filePath) {
  return `prmedia://local/?p=${encodeURIComponent(String(filePath || ''))}`
}

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.oga', '.opus'])
/** Chromium 能直接播的容器（mkv / avi / ts / flv 这些要先转码） */
const LOCAL_OK_EXT = new Set([
  '.mp4', '.m4v', '.webm', '.mov', '.ogv',
  '.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.oga', '.opus'
])
function extOf(name) {
  const s = String(name || '')
  const dot = s.lastIndexOf('.')
  return dot >= 0 ? s.slice(dot).toLowerCase() : ''
}
function isAudioFile(name) {
  return AUDIO_EXT.has(extOf(name))
}

/**
 * 两种瓦片共用的按钮接线：静音 / 音量 / 放大 / 重载 / 关闭 / 双击放大 / 拖动排序。
 * 录制相关的按钮只有直播间瓦片才接。
 */
function wireTileBasics(uid, t) {
  const el = t.el
  t.muteBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    toggleMute(uid)
  })
  const volInput = t.volEl
  volInput.addEventListener('input', (e) => {
    e.stopPropagation()
    setVolume(uid, Number(e.currentTarget.value) / 100)
  })
  // 拖滑块不要触发瓦片的其它点击行为
  volInput.addEventListener('click', (e) => e.stopPropagation())
  volInput.addEventListener('mousedown', (e) => e.stopPropagation())
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
}

/**
 * 本地音视频瓦片：网格 / 布局 / 聚焦 / 拖动 / 音量全部和直播间瓦片共用，
 * 只是把 <webview> 换成 <video>，声音走 video 自己的 volume / muted。
 */
function addLocalTile(filePath, opts = {}) {
  if (tiles.size >= MAX_TILES) {
    statusEl.textContent = `最多同时打开 ${MAX_TILES} 个瓦片（当前 ${tiles.size} 个）`
    statusEl.className = 'err'
    return null
  }
  const p = String(filePath || '')
  if (!p) return null
  const dup = [...tiles.entries()].find(([, t]) => t.local && t.path === p)
  if (dup) {
    flashTile(dup[0])
    statusEl.textContent = '这个文件已经打开了'
    statusEl.className = ''
    return dup[0]
  }

  const name = String(opts.name || p.split(/[\\/]/).pop() || '本地文件')
  const uid = `r${++seq}`
  const el = document.createElement('section')
  el.className = 'tile local'
  el.dataset.uid = uid
  el.innerHTML =
    TILE_HEAD_HTML +
    `
    <div class="stage">
      <video class="local-media" controls playsinline preload="metadata"></video>
      <div class="overlay">正在打开本地文件…</div>
      <div class="local-audio-hint hidden">♪ <span></span></div>
      <div class="tile-name"></div>
    </div>
  `

  const media = el.querySelector('.local-media')
  const overlay = el.querySelector('.overlay')
  const titleEl = el.querySelector('.title')
  const idxEl = el.querySelector('.idx')
  const muteBtn = el.querySelector('.mute')
  const volEl = el.querySelector('.vol')
  const badgeEl = el.querySelector('.badge')
  const recBtn = el.querySelector('.rec')
  const recSplitBtn = el.querySelector('.rec-split')
  const recReplayBtn = el.querySelector('.rec-replay')
  const stageEl = el.querySelector('.stage')
  const nameEl = el.querySelector('.tile-name')
  const audioHint = el.querySelector('.local-audio-hint')

  // 本地文件没有"进房 / 录制 / 画质"这些事，相关按钮直接收掉
  //（「⟲ 精彩」例外：视频文件可以按当前播放进度截一段，这里直接放出来，
  // 不依赖 renderRecUi——它只在录制状态变化时才跑，纯播放本地文件时根本不会触发）
  recBtn.classList.add('hidden')
  recSplitBtn.classList.add('hidden')
  if (recReplayBtn) {
    const audioOnly = isAudioFile(name)
    recReplayBtn.classList.toggle('hidden', audioOnly)
    recReplayBtn.disabled = audioOnly
    if (!audioOnly) recReplayBtn.title = '精彩片段：按当前播放进度截最近一段（不用录制）'
  }
  badgeEl.classList.add('hidden')
  el.classList.toggle('audio', isAudioFile(name))
  if (isAudioFile(name)) {
    audioHint.classList.remove('hidden')
    audioHint.querySelector('span').textContent = name
  }

  let savedVol = 1
  try {
    const v = (loadPrefs().volumes || {})[bareUrl(mediaUrl(p))]
    if (typeof v === 'number') savedVol = Math.max(0, Math.min(1, v))
  } catch {}

  const t = {
    el,
    uid,
    view: null,
    mediaEl: media,
    local: true,
    path: p,
    overlay,
    titleEl,
    idxEl,
    muteBtn,
    volEl,
    badgeEl,
    qEl: el.querySelector('.tile-q'),
    danmuEl: null,
    recBtn,
    recSplitBtn,
    recReplayBtn,
    stageEl,
    nameEl,
    url: mediaUrl(p),
    fileName: name,
    muted: opts.muted === true,
    volume: savedVol,
    failed: false,
    other: false,
    otherAt: 0,
    removed: false,
    watch: null,
    pokes: 0
  }
  tiles.set(uid, t)

  titleEl.textContent = name
  titleEl.title = p
  if (nameEl) nameEl.textContent = name

  wireTileBasics(uid, t)

  // 本地视频的「⟲ 精彩」：按当前播放进度截一段（不用录制）
  if (recReplayBtn) {
    recReplayBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      const r = recReplayBtn.getBoundingClientRect()
      openReplayMenu(uid, Math.round(r.left), Math.round(r.bottom + 4))
    })
  }

  media.addEventListener('loadedmetadata', () => {
    hideOverlay(t)
    if (isAudioFile(name)) titleEl.title = `${name}（${fmtClock(media.duration)}）`
  })
  media.addEventListener('error', async () => {
    const code = media.error && media.error.code
    // 先说清楚到底哪出了问题：文件不在 / 容器播不了 / 解码失败
    let exists = true
    try {
      const st = await window.pr.localStat([p])
      exists = !(Array.isArray(st) && st[0] === false)
    } catch {}
    const why = !exists
      ? `文件不在了（可能被删掉或移走了）：${p}`
      : code === 4
        ? '这个容器/编码浏览器播不了（mkv / avi / ts / flv 之类），先用「剪辑」页签转成 H.264 mp4 再打开'
        : code === 3
          ? '解码失败，文件可能已损坏'
          : code === 2
            ? '读取文件出错'
            : '打不开这个文件'
    showOverlay(t, `${name}\n${why}`, true)
  })
  media.addEventListener('play', () => applyMute(uid))

  gridEl.appendChild(el)
  const unsupported = !LOCAL_OK_EXT.has(extOf(name))
  if (unsupported) {
    // 容器根本不支持：不去 load，直接把原因写在画面上
    showOverlay(
      t,
      `${name}\n这个容器浏览器播不了（mkv / avi / ts / flv 之类）\n先用「剪辑」页签转成 H.264 mp4，或自己 ffmpeg 转一下`,
      true
    )
  } else {
    media.src = mediaUrl(p)
    media.load()
    // 声音先按保存的状态（浏览器自动播放策略会挡带声音的自动播放，挡了就等用户点播放）
    media.muted = t.muted
    media.volume = savedVol
    Promise.resolve(media.play()).catch(() => {})
  }

  refreshIndices()
  updateCount()
  layout()
  applyMute(uid)
  scheduleSave()
  if (typeof renderCards === 'function') renderCards()
  return uid
}

/** 秒 → m:ss（本地文件时长提示用） */
function fmtClock(sec) {
  const n = Math.max(0, Math.round(Number(sec) || 0))
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`
}

/* ------------------------------ 摄像头 ------------------------------ */
/*
 * 摄像头和本地文件走同一套瓦片：<video> + srcObject(MediaStream)。
 * 关掉瓦片时一定要把轨道 stop 掉，否则系统摄像头指示灯会一直亮着。
 */

/** 摄像头瓦片默认同时开麦克风吗（默认关：外放会啸叫） */
let camWithMic = prefs.camMic === true
/** 摄像头画面默认左右镜像吗（自拍视角要翻，演示/录制内容一般不要） */
let camMirrorDefault = prefs.camMirror === true

/** 把这块摄像头的左右镜像状态落到 DOM 上 */
function applyCameraMirror(uid) {
  const t = tiles.get(uid)
  if (!t || !t.camera) return
  t.el.classList.toggle('mirror', t.mirror === true)
}

/** 新开的摄像头默认带镜像吗 */
function setCamMirrorDefault(v) {
  camMirrorDefault = Boolean(v)
  savePrefs({ camMirror: camMirrorDefault })
}

/** 现在开着的摄像头全设成镜像 / 不镜像 */
function setAllCameraMirror(v) {
  for (const [uid, t] of tiles) {
    if (!t.camera) continue
    t.mirror = Boolean(v)
    applyCameraMirror(uid)
  }
  setCamMirrorDefault(v)
}

/** 右键摄像头瓦片：这个小菜单 */
function openCameraTileMenu(uid, x, y) {
  const t = tiles.get(uid)
  if (!t || !t.camera) return
  const items = [
    {
      label: `左右镜像：${t.mirror ? '开' : '关'}`,
      checked: t.mirror === true,
      action: () => {
        t.mirror = !t.mirror
        applyCameraMirror(uid)
        statusEl.textContent = `「${t.fileName}」${t.mirror ? '已左右镜像' : '已恢复正像'}`
        statusEl.className = ''
      }
    },
    { sep: true },
    {
      label: `以后开的摄像头默认镜像：${camMirrorDefault ? '开' : '关'}`,
      checked: camMirrorDefault,
      action: () => {
        setCamMirrorDefault(!camMirrorDefault)
        statusEl.textContent = camMirrorDefault
          ? '以后开的摄像头会默认左右镜像'
          : '以后开的摄像头默认不镜像'
        statusEl.className = ''
      }
    },
    {
      label: '所有摄像头都镜像 / 都正像（跟着上面这个默认走）',
      sub: true,
      action: () => setAllCameraMirror(camMirrorDefault)
    },
    { sep: true },
    { label: '重新连接这个摄像头', action: () => reloadRoom(uid) }
  ]
  showPopup(x, y, items, '这个摄像头 · ' + t.fileName.slice(0, 22))
}

async function listCameras() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices()
    return all.filter((d) => d.kind === 'videoinput')
  } catch {
    return []
  }
}

/** 摄像头错误 → 人话 */
function camErrorText(err) {
  const name = (err && err.name) || ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return '系统/浏览器不允许访问摄像头（去 Windows 设置里允许桌面应用使用摄像头）'
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return '找不到这个摄像头（被拔掉或驱动没装）'
  if (name === 'NotReadableError' || name === 'TrackStartError') return '摄像头被别的程序占用了（会议软件 / OBS / 直播软件？先关掉那边）'
  if (name === 'OverconstrainedError') return '这个摄像头不支持要求的参数'
  if (name === 'AbortError') return '系统拒绝了这次摄像头访问'
  return '打不开摄像头：' + ((err && err.message) || name || '未知错误')
}

/** 给这块瓦片要一次摄像头流（失败就把原因写在画面上） */
async function acquireCameraStream(t, uid) {
  if (!t || !t.mediaEl) return
  const dev = t.deviceId
  // 设备列表里没有这个 id：直接说清楚，别报"参数不支持"
  if (dev) {
    const devs = await listCameras()
    if (devs.length && !devs.some((d) => d.deviceId === dev)) {
      showOverlay(t, `${t.fileName}\n找不到这个摄像头（被拔掉或驱动没了）\n点 ⟳ 重新连接，或用「摄像头」按钮重选一个`, true)
      return
    }
  }
  const base = {
    audio: camWithMic ? { echoCancellation: true, noiseSuppression: true } : false
  }
  const tries = dev
    ? [
        // 指定了设备就只试这个设备：绝不偷偷换成别的摄像头
        { ...base, video: { deviceId: { exact: dev }, width: { ideal: 1280 }, height: { ideal: 720 } } },
        { ...base, video: { deviceId: { exact: dev } } }
      ]
    : [
        { ...base, video: { width: { ideal: 1280 }, height: { ideal: 720 } } },
        { ...base, video: true }
      ]
  let lastErr = null
  for (const c of tries) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(c)
      if (t.removed) {
        for (const tr of stream.getTracks()) tr.stop()
        return
      }
      // 换了新流：先把旧的关掉
      if (t.stream) for (const tr of t.stream.getTracks()) tr.stop()
      t.stream = stream
      t.mediaEl.srcObject = stream
      applyMute(uid, true)
      hideOverlay(t)
      const v = stream.getVideoTracks()[0]
      if (v) {
        const s = v.getSettings ? v.getSettings() : {}
        t.titleEl.title = `${t.fileName}${s.width ? ` · ${s.width}×${s.height}@${Math.round(s.frameRate || 0)}` : ''}`
      }
      t.mediaEl.play().catch(() => {})
      // 设备被拔掉时流会 ended，提示一下
      for (const tr of stream.getTracks()) {
        tr.addEventListener('ended', () => {
          if (!t.removed) showOverlay(t, `${t.fileName}\n摄像头断开了（被拔掉或占用？）点 ⟳ 重新连接`, true)
        })
      }
      return
    } catch (err) {
      lastErr = err
      // 只有 OverconstrainedError 才值得降级重试，其它直接报
      if (!err || (err.name !== 'OverconstrainedError' && err.name !== 'TypeError')) break
    }
  }
  showOverlay(t, `${t.fileName}\n${camErrorText(lastErr)}`, true)
}

/** 打开一路摄像头瓦片 */
function addCameraTile(opts = {}) {
  if (tiles.size >= MAX_TILES) {
    statusEl.textContent = `最多同时打开 ${MAX_TILES} 个瓦片（当前 ${tiles.size} 个）`
    statusEl.className = 'err'
    return null
  }
  const deviceId = String(opts.deviceId || '')
  const label = String(opts.label || '摄像头')
  const dup = [...tiles.entries()].find(([, t]) => t.camera && t.deviceId === deviceId)
  if (dup) {
    flashTile(dup[0])
    statusEl.textContent = '这个摄像头已经打开了'
    statusEl.className = ''
    return dup[0]
  }

  const uid = `r${++seq}`
  const el = document.createElement('section')
  el.className = 'tile local cam'
  el.dataset.uid = uid
  el.innerHTML =
    TILE_HEAD_HTML +
    `
    <div class="stage">
      <video class="local-media" autoplay playsinline></video>
      <div class="overlay">正在打开摄像头…</div>
      <div class="tile-name"></div>
    </div>
  `

  const media = el.querySelector('.local-media')
  const overlay = el.querySelector('.overlay')
  const titleEl = el.querySelector('.title')
  const idxEl = el.querySelector('.idx')
  const muteBtn = el.querySelector('.mute')
  const volEl = el.querySelector('.vol')
  const badgeEl = el.querySelector('.badge')
  const recBtn = el.querySelector('.rec')
  const recSplitBtn = el.querySelector('.rec-split')
  const recReplayBtn = el.querySelector('.rec-replay')
  const stageEl = el.querySelector('.stage')
  const nameEl = el.querySelector('.tile-name')

  recBtn.classList.add('hidden')
  recSplitBtn.classList.add('hidden')
  if (recReplayBtn) recReplayBtn.classList.add('hidden')
  badgeEl.classList.add('hidden')

  const t = {
    el,
    uid,
    view: null,
    mediaEl: media,
    camera: true,
    local: false,
    path: '',
    deviceId,
    stream: null,
    overlay,
    titleEl,
    idxEl,
    muteBtn,
    volEl,
    badgeEl,
    qEl: el.querySelector('.tile-q'),
    danmuEl: null,
    recBtn,
    recSplitBtn,
    recReplayBtn,
    stageEl,
    nameEl,
    url: `camera://${deviceId || 'default'}`,
    fileName: label,
    // 默认静音：麦克风/扬声器凑一起会啸叫，要听自己点 🔊
    muted: opts.muted !== false,
    // 左右镜像：默认跟全局设置，也可以单独指定
    mirror: opts.mirror !== undefined ? Boolean(opts.mirror) : camMirrorDefault,
    volume: 1,
    failed: false,
    other: false,
    otherAt: 0,
    removed: false,
    watch: null,
    pokes: 0
  }
  tiles.set(uid, t)

  titleEl.textContent = label
  titleEl.title = label
  if (nameEl) nameEl.textContent = label

  wireTileBasics(uid, t)
  // 右键顶栏：这块摄像头的左右镜像 + 默认值
  el.querySelector('.tile-head').addEventListener('contextmenu', (e) => {
    e.preventDefault()
    e.stopPropagation()
    openCameraTileMenu(uid, e.clientX, e.clientY)
  })
  gridEl.appendChild(el)

  applyCameraMirror(uid)

  refreshIndices()
  updateCount()
  layout()
  applyMute(uid)
  acquireCameraStream(t, uid)
  // 摄像头不进 state.json（重启不该自动开摄像头）
  if (typeof renderCards === 'function') renderCards()
  return uid
}

/** 摄像头菜单：列设备，点一个就开一路 */
async function openCameraMenu(x, y) {
  const devs = await listCameras()
  const opened = new Set([...tiles.values()].filter((t) => t.camera).map((t) => t.deviceId))
  const items = []
  if (!devs.length) {
    items.push({ head: '没找到摄像头' })
    items.push({ label: '刷新设备列表', sub: true, action: () => openCameraMenu(x, y) })
  } else {
    items.push({ head: `找到 ${devs.length} 个摄像头` })
    devs.forEach((d, i) => {
      const name = d.label || `摄像头 ${i + 1}`
      items.push({
        label: name + (opened.has(d.deviceId) ? ' · 已打开' : ''),
        sub: true,
        checked: opened.has(d.deviceId),
        action: () => addCameraTile({ deviceId: d.deviceId, label: name })
      })
    })
    items.push({ sep: true })
    items.push({ label: '刷新设备列表', action: () => openCameraMenu(x, y) })
  }
  items.push({
    label: `同时打开麦克风：${camWithMic ? '开' : '关'}`,
    checked: camWithMic,
    action: () => {
      camWithMic = !camWithMic
      savePrefs({ camMic: camWithMic })
      statusEl.textContent = camWithMic
        ? '下次打开摄像头会连麦克风一起要（外放时容易啸叫，建议戴耳机）'
        : '摄像头只开画面，不碰麦克风'
      statusEl.className = ''
    }
  })
  items.push({
    label: `左右镜像（新开的摄像头）：${camMirrorDefault ? '开' : '关'}`,
    checked: camMirrorDefault,
    action: () => {
      setCamMirrorDefault(!camMirrorDefault)
      // 已经开着的摄像头也跟着切，免得"设了没反应"
      for (const [uid, t] of tiles) {
        if (!t.camera) continue
        t.mirror = camMirrorDefault
        applyCameraMirror(uid)
      }
      statusEl.textContent = camMirrorDefault ? '摄像头画面已左右镜像' : '摄像头画面已恢复正像'
      statusEl.className = ''
    }
  })
  showPopup(x, y, items, '摄像头')
}

/* ------------------------------ 虚拟演播室（绿幕 + 三维场景） ------------------------------ */
/*
 * 渲染全部在 studio.js（ES module，three.js）里做，这边只负责：
 *   要一路摄像头 → 建瓦片 → 把 canvas 交给 StudioRuntime → 面板上的滑块改参数。
 * 输出就是瓦片里那块 <canvas>，所以现有的"录窗口/屏幕录制"能直接录它。
 */

const STUDIO_DEFAULTS = {
  key: '#00b140',
  tol: 0.16,
  soft: 0.1,
  shrink: 0.12,
  spill: 0.75,
  tintMix: 0.32,
  bright: 1.0,
  scale: 1.0,
  offsetX: 0,
  offsetY: 0,
  mirror: true,
  yaw: 0,
  tilt: 0.03,
  zoom: 38,
  dolly: 6.4,
  height: 1.9,
  scene: 'studio',
  // 表演者来源：'camera' = 摄像头实时抠像；'file' = 一段（绿幕拍摄的）本地视频当演员
  performerKind: 'camera',
  performerPath: ''
}

/** 本地文件 → prmedia:// 地址（渲染层是 file:// 页面，直接给路径会被跨源拦） */
function studioMediaUrl(p) {
  return 'prmedia://local/?p=' + encodeURIComponent(String(p || ''))
}

/** 文件路径 → 短名字（面板/标题上显示） */
function fileBaseName(p) {
  return String(p || '').split(/[\\/]/).pop() || ''
}

const STUDIO_SLIDERS = [
  {
    group: '机位（虚拟摄像机）',
    items: [
      { k: 'yaw', label: '水平', min: -60, max: 60, step: 1 },
      { k: 'tilt', label: '俯仰', min: -0.5, max: 0.5, step: 0.02 },
      { k: 'zoom', label: '变焦', min: 18, max: 70, step: 1 },
      { k: 'dolly', label: '推拉', min: 3, max: 14, step: 0.1 },
      { k: 'height', label: '高度', min: 0.8, max: 3.6, step: 0.1 }
    ]
  },
  {
    group: '绿幕抠像',
    items: [
      { k: 'tol', label: '容差', min: 0.02, max: 0.5, step: 0.01 },
      { k: 'soft', label: '羽化', min: 0, max: 0.4, step: 0.01 },
      { k: 'shrink', label: '收缩', min: 0, max: 0.5, step: 0.01 },
      { k: 'spill', label: '去绿边', min: 0, max: 1.5, step: 0.05 }
    ]
  },
  {
    group: '光影 / 人物',
    items: [
      { k: 'tintMix', label: '光影匹配', min: 0, max: 1, step: 0.05 },
      { k: 'bright', label: '亮度', min: 0.6, max: 1.6, step: 0.02 },
      { k: 'scale', label: '人物缩放', min: 0.5, max: 1.6, step: 0.02 },
      { k: 'offsetX', label: '左右', min: -0.5, max: 0.5, step: 0.01 },
      { k: 'offsetY', label: '上下', min: -0.3, max: 0.3, step: 0.01 }
    ]
  }
]

/** 演播室参数是全局默认：改了以后新开的演播室沿用 */
function studioParams() {
  return { ...STUDIO_DEFAULTS, ...(loadPrefs().studio || {}) }
}

/**
 * 切换演播室的"表演者"来源。
 *  - camera：重新要一路摄像头（会先把视频文件停掉）
 *  - file：停掉摄像头轨道，用一段本地视频当人像纹理（循环播放、静音）
 */
async function setStudioPerformer(t, kind, path) {
  if (!t) return
  const want = kind === 'file' ? 'file' : 'camera'
  t.studioParams.performerKind = want
  t.studioParams.performerPath = want === 'file' ? String(path || '') : ''
  saveStudioParams(t.studioParams)
  if (!t.studio) return
  if (want === 'file') {
    if (!t.studioParams.performerPath) {
      showOverlay(t, '还没选视频文件', true)
      return
    }
    // 摄像头轨道留着会一直亮灯 + 占带宽
    try {
      if (t.stream) for (const tr of t.stream.getTracks()) tr.stop()
    } catch {}
    t.stream = null
    const ok = t.studio.setVideoUrl(studioMediaUrl(t.studioParams.performerPath))
    if (!ok) {
      showOverlay(t, t.fileName + '\n视频当表演者加载失败', true)
      return
    }
    // 视频是录好的素材，默认不该镜像（镜像了画面里的字会反）——摄像头才需要镜像自拍效果
    if (t.studioParams.mirror) {
      t.studioParams.mirror = false
      t.studio.setParams(t.studioParams)
      saveStudioParams(t.studioParams)
    }
    hideOverlay(t)
    t.titleEl.title = '虚拟演播室 · 表演者：' + fileBaseName(t.studioParams.performerPath)
    statusEl.textContent = '演播室表演者 → 视频文件：' + fileBaseName(t.studioParams.performerPath)
    statusEl.className = ''
    return
  }
  // 切回摄像头
  showOverlay(t, '正在打开摄像头…')
  try {
    const stream = await openStudioCamera(t.deviceId)
    if (t.removed) {
      for (const tr of stream.getTracks()) tr.stop()
      return
    }
    try {
      if (t.stream) for (const tr of t.stream.getTracks()) tr.stop()
    } catch {}
    t.stream = stream
    t.studio.setStream(stream)
    hideOverlay(t)
    const v = stream.getVideoTracks()[0]
    const s = (v && v.getSettings && v.getSettings()) || {}
    t.titleEl.title = '虚拟演播室 · ' + ((v && v.label) || '') + (s.width ? ' · ' + s.width + '×' + s.height : '')
    statusEl.textContent = '演播室表演者 → 摄像头'
    statusEl.className = ''
  } catch (err) {
    showOverlay(t, t.fileName + '\n' + camErrorText(err), true)
  }
}

let studioSaveTimer = null
function saveStudioParams(params) {
  clearTimeout(studioSaveTimer)
  studioSaveTimer = setTimeout(() => savePrefs({ studio: params }), 400)
}

/** 等 studio.js（ES module）就绪 */
function whenStudioReady() {
  if (window.PRStudio) return Promise.resolve(window.PRStudio)
  return new Promise((resolve, reject) => {
    let done = false
    const ok = () => {
      if (done) return
      done = true
      resolve(window.PRStudio)
    }
    window.addEventListener('pr-studio-ready', ok, { once: true })
    setTimeout(() => {
      if (done) return
      done = true
      reject(new Error('虚拟演播室模块没加载起来（src/renderer/studio.js / vendor/three.module.js 在不在？）'))
    }, 8000)
  })
}

/** 给演播室要一路摄像头（和摄像头瓦片同一套错误提示） */
async function openStudioCamera(deviceId) {
  const dev = String(deviceId || '')
  if (dev) {
    const devs = await listCameras()
    if (devs.length && !devs.some((d) => d.deviceId === dev)) {
      throw Object.assign(new Error('找不到这个摄像头（被拔掉或驱动没了）'), { name: 'NotFoundError' })
    }
  }
  const tries = dev
    ? [
        { video: { deviceId: { exact: dev }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
        { video: { deviceId: { exact: dev } }, audio: false }
      ]
    : [{ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }, { video: true, audio: false }]
  let lastErr = null
  for (const c of tries) {
    try {
      return await navigator.mediaDevices.getUserMedia(c)
    } catch (err) {
      lastErr = err
      if (!err || (err.name !== 'OverconstrainedError' && err.name !== 'TypeError')) break
    }
  }
  throw lastErr || new Error('打不开摄像头')
}

/** 演播室瓦片里的面板：场景切换 + 机位 / 抠像 / 光影 滑块 */
function buildStudioPanel(t) {
  const panel = document.createElement('div')
  panel.className = 'studio-panel hidden'
  const params = t.studioParams

  /*
   * 表演者来源：摄像头（实时）或一段本地视频（绿幕拍摄的素材）。
   * 两者都只是"人像纹理"的来源不同，抠像 / 机位 / 场景那套完全共用。
   */
  const perfRow = document.createElement('div')
  perfRow.className = 'sp-row sp-perf'
  const perfLabel = document.createElement('span')
  perfLabel.className = 'sp-perf-label'
  perfLabel.textContent = '表演者'
  const camBtn = document.createElement('button')
  camBtn.type = 'button'
  camBtn.className = 'sp-perf-btn'
  camBtn.textContent = '摄像头'
  const fileBtn = document.createElement('button')
  fileBtn.type = 'button'
  fileBtn.className = 'sp-perf-btn'
  fileBtn.textContent = '视频文件…'
  const perfInfo = document.createElement('span')
  perfInfo.className = 'sp-perf-info'

  const syncPerf = () => {
    const kind = params.performerKind === 'file' ? 'file' : 'camera'
    camBtn.classList.toggle('on', kind === 'camera')
    fileBtn.classList.toggle('on', kind === 'file')
    perfInfo.textContent = kind === 'file' ? fileBaseName(params.performerPath) || '（没选文件）' : '实时摄像头'
    perfInfo.title =
      kind === 'file'
        ? String(params.performerPath || '')
        : '摄像头实时画面（绿幕前拍）→ 抠像后放进三维场景'
  }
  syncPerf()

  camBtn.addEventListener('click', async (e) => {
    e.stopPropagation()
    await setStudioPerformer(t, 'camera')
    syncPerf()
  })
  fileBtn.addEventListener('click', async (e) => {
    e.stopPropagation()
    let res = null
    try {
      res = await window.pr.pickLocalFiles('video')
    } catch (err) {
      statusEl.textContent = '选视频失败：' + ((err && err.message) || err)
      statusEl.className = 'err'
      return
    }
    const f = res && res.ok && Array.isArray(res.files) ? res.files.find((x) => x && x.path) : null
    if (!f) return
    await setStudioPerformer(t, 'file', f.path)
    syncPerf()
  })

  perfRow.appendChild(perfLabel)
  perfRow.appendChild(camBtn)
  perfRow.appendChild(fileBtn)
  perfRow.appendChild(perfInfo)
  panel.appendChild(perfRow)

  // 场景
  const scenesRow = document.createElement('div')
  scenesRow.className = 'sp-scenes'
  const scenes =
    window.PRStudio && window.PRStudio.scenes
      ? window.PRStudio.scenes()
      : [
          { key: 'studio', label: '演播厅' },
          { key: 'outdoor', label: '户外' },
          { key: 'scifi', label: '科幻' }
        ]
  for (const sc of scenes) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'sp-scene'
    b.dataset.scene = sc.key
    b.textContent = sc.label
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      params.scene = sc.key
      if (t.studio) t.studio.setScene(sc.key)
      saveStudioParams(params)
      for (const x of scenesRow.querySelectorAll('.sp-scene')) x.classList.toggle('on', x === b)
    })
    scenesRow.appendChild(b)
  }
  panel.appendChild(scenesRow)

  // 机位预设
  const presets = document.createElement('div')
  presets.className = 'sp-presets'
  const presetDefs = {
    全景: { yaw: 0, tilt: 0.03, zoom: 32, dolly: 9.5, height: 2.2 },
    中景: { yaw: 0, tilt: 0.03, zoom: 38, dolly: 6.4, height: 1.9 },
    特写: { yaw: 0, tilt: 0.06, zoom: 46, dolly: 4.6, height: 1.75 }
  }
  for (const [name, def] of Object.entries(presetDefs)) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'sp-preset'
    b.textContent = name
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      Object.assign(params, def)
      if (t.studio) t.studio.setParams(params)
      saveStudioParams(params)
      syncSliders()
    })
    presets.appendChild(b)
  }
  panel.appendChild(presets)

  // 键色 + 镜像 + 重置
  const row = document.createElement('div')
  row.className = 'sp-row'
  const keyLabel = document.createElement('label')
  keyLabel.className = 'sp-color'
  keyLabel.appendChild(document.createTextNode('键色'))
  const keyInput = document.createElement('input')
  keyInput.type = 'color'
  keyInput.value = params.key
  keyInput.addEventListener('input', (e) => {
    e.stopPropagation()
    params.key = e.currentTarget.value
    if (t.studio) t.studio.setParams(params)
    saveStudioParams(params)
  })
  keyLabel.appendChild(keyInput)
  row.appendChild(keyLabel)

  const mirLabel = document.createElement('label')
  mirLabel.className = 'sp-check'
  const mirInput = document.createElement('input')
  mirInput.type = 'checkbox'
  mirInput.checked = params.mirror !== false
  mirInput.addEventListener('change', (e) => {
    e.stopPropagation()
    params.mirror = e.currentTarget.checked
    if (t.studio) t.studio.setParams(params)
    saveStudioParams(params)
  })
  mirLabel.appendChild(mirInput)
  mirLabel.appendChild(document.createTextNode('镜像'))
  row.appendChild(mirLabel)

  const resetBtn = document.createElement('button')
  resetBtn.type = 'button'
  resetBtn.className = 'sp-reset'
  resetBtn.textContent = '重置'
  resetBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    for (const k of Object.keys(STUDIO_DEFAULTS)) params[k] = STUDIO_DEFAULTS[k]
    if (t.studio) {
      t.studio.setParams(params)
      t.studio.setScene(params.scene)
    }
    keyInput.value = params.key
    mirInput.checked = params.mirror
    for (const x of scenesRow.querySelectorAll('.sp-scene')) {
      x.classList.toggle('on', x.dataset.scene === params.scene)
    }
    syncSliders()
    saveStudioParams(params)
  })
  row.appendChild(resetBtn)
  panel.appendChild(row)

  // 滑块
  const inputs = []
  function syncSliders() {
    for (const x of inputs) {
      x.input.value = String(params[x.k])
      x.val.textContent = String(params[x.k])
    }
  }
  for (const grp of STUDIO_SLIDERS) {
    const h = document.createElement('div')
    h.className = 'sp-sec'
    h.textContent = grp.group
    panel.appendChild(h)
    for (const it of grp.items) {
      const lab = document.createElement('label')
      lab.className = 'sp-slider'
      const name = document.createElement('span')
      name.textContent = it.label
      const input = document.createElement('input')
      input.type = 'range'
      input.min = String(it.min)
      input.max = String(it.max)
      input.step = String(it.step)
      input.value = String(params[it.k])
      const val = document.createElement('b')
      val.textContent = String(params[it.k])
      input.addEventListener('input', (e) => {
        e.stopPropagation()
        const v = Number(e.currentTarget.value)
        params[it.k] = v
        val.textContent = String(v)
        if (t.studio) t.studio.setParams(params)
        saveStudioParams(params)
      })
      input.addEventListener('pointerdown', (e) => e.stopPropagation())
      input.addEventListener('click', (e) => e.stopPropagation())
      lab.appendChild(name)
      lab.appendChild(input)
      lab.appendChild(val)
      panel.appendChild(lab)
      inputs.push({ k: it.k, input, val })
    }
  }

  return { panel, syncSliders }
}

/** 打开一块虚拟演播室瓦片 */
async function addStudioTile(opts = {}) {
  if (tiles.size >= MAX_TILES) {
    statusEl.textContent = `最多同时打开 ${MAX_TILES} 个瓦片（当前 ${tiles.size} 个）`
    statusEl.className = 'err'
    return null
  }
  let studioApi
  try {
    studioApi = await whenStudioReady()
  } catch (err) {
    statusEl.textContent = '虚拟演播室加载失败：' + ((err && err.message) || err)
    statusEl.className = 'err'
    return null
  }
  if (!studioApi) return null

  const label = String(opts.label || '虚拟演播室')
  const uid = 'r' + ++seq
  const el = document.createElement('section')
  el.className = 'tile local studio'
  el.dataset.uid = uid
  el.innerHTML =
    TILE_HEAD_HTML +
    '<div class="stage">' +
    '<canvas class="studio-canvas"></canvas>' +
    '<div class="overlay">正在打开摄像头…</div>' +
    '<div class="studio-hint">⚙ 场景 / 抠像</div>' +
    '<div class="tile-name"></div>' +
    '</div>'

  const canvas = el.querySelector('.studio-canvas')
  const overlay = el.querySelector('.overlay')
  const titleEl = el.querySelector('.title')
  const idxEl = el.querySelector('.idx')
  const muteBtn = el.querySelector('.mute')
  const volEl = el.querySelector('.vol')
  const badgeEl = el.querySelector('.badge')
  const recBtn = el.querySelector('.rec')
  const recSplitBtn = el.querySelector('.rec-split')
  const recReplayBtn = el.querySelector('.rec-replay')
  const stageEl = el.querySelector('.stage')
  const nameEl = el.querySelector('.tile-name')

  recBtn.classList.add('hidden')
  recSplitBtn.classList.add('hidden')
  if (recReplayBtn) recReplayBtn.classList.add('hidden')
  badgeEl.classList.add('hidden')
  volEl.classList.add('hidden')
  muteBtn.classList.add('hidden')

  const t = {
    el,
    uid,
    view: null,
    mediaEl: null,
    studio: null,
    studioParams: studioParams(),
    deviceId: String(opts.deviceId || ''),
    stream: null,
    overlay,
    titleEl,
    idxEl,
    muteBtn,
    volEl,
    badgeEl,
    qEl: el.querySelector('.tile-q'),
    danmuEl: null,
    recBtn,
    recSplitBtn,
    recReplayBtn,
    stageEl,
    nameEl,
    url: 'studio://' + uid,
    fileName: label,
    muted: true,
    volume: 1,
    failed: false,
    other: false,
    otherAt: 0,
    removed: false,
    watch: null,
    pokes: 0
  }
  tiles.set(uid, t)

  titleEl.textContent = label
  titleEl.title = '虚拟演播室（绿幕 + 三维场景）'
  if (nameEl) nameEl.textContent = label

  wireTileBasics(uid, t)
  gridEl.appendChild(el)

  const built = buildStudioPanel(t)
  stageEl.appendChild(built.panel)
  el.querySelector('.studio-hint').addEventListener('click', (e) => {
    e.stopPropagation()
    built.panel.classList.toggle('hidden')
  })
  for (const x of built.panel.querySelectorAll('.sp-scene')) {
    x.classList.toggle('on', x.dataset.scene === t.studioParams.scene)
  }

  refreshIndices()
  updateCount()
  layout()

  try {
    // 表演者来源：默认摄像头；如果上次选了"视频文件"就先用视频（没摄像头也能开演播室）
    const wantFile = t.studioParams.performerKind === 'file' && t.studioParams.performerPath
    let stream = null
    if (!wantFile) {
      stream = await openStudioCamera(t.deviceId)
      if (t.removed) {
        for (const tr of stream.getTracks()) tr.stop()
        return uid
      }
      t.stream = stream
    }
    const rt = new studioApi.StudioRuntime(canvas, {
      onError: (err) => console.warn('[studio] render error', err)
    })
    t.studio = rt
    if (wantFile) {
      rt.setVideoUrl(studioMediaUrl(t.studioParams.performerPath))
      // 视频素材默认不镜像（录好的画面镜像了字会反）
      if (t.studioParams.mirror) {
        t.studioParams.mirror = false
        rt.setParams(t.studioParams)
        saveStudioParams(t.studioParams)
      }
      hideOverlay(t)
      titleEl.title = '虚拟演播室 · 表演者：' + fileBaseName(t.studioParams.performerPath)
      if (nameEl) nameEl.textContent = label + ' · ' + fileBaseName(t.studioParams.performerPath).slice(0, 18)
    } else {
      rt.setStream(stream)
      hideOverlay(t)
      const v = stream.getVideoTracks()[0]
      if (v) {
        const s = v.getSettings ? v.getSettings() : {}
        titleEl.title = '虚拟演播室 · ' + (v.label || '') + (s.width ? ' · ' + s.width + '×' + s.height : '')
      }
    }
    rt.setScene(t.studioParams.scene)
    rt.setParams(t.studioParams)
  } catch (err) {
    showOverlay(t, label + '\n' + camErrorText(err), true)
  }

  if (typeof renderCards === 'function') renderCards()
  return uid
}

/** 演播室菜单：选摄像头就开一块 */
async function openStudioMenu(x, y) {
  const devs = await listCameras()
  const items = [{ head: devs.length ? '用哪个摄像头做演播室' : '没找到摄像头' }]
  devs.forEach((d, i) => {
    const name = d.label || '摄像头 ' + (i + 1)
    items.push({
      label: name,
      sub: true,
      action: () => addStudioTile({ deviceId: d.deviceId, label: '演播室 · ' + name.slice(0, 16) })
    })
  })
  items.push({ sep: true })
  items.push({ label: '刷新设备列表', action: () => openStudioMenu(x, y) })
  showPopup(x, y, items, '虚拟演播室')
}

const studioBtn = document.getElementById('btn-studio')
if (studioBtn) {
  studioBtn.addEventListener('click', async (e) => {
    e.stopPropagation()
    const r = e.currentTarget.getBoundingClientRect()
    await openStudioMenu(r.left, r.bottom + 4)
  })
}

/* ------------------------------ 虚拟人舞台（全 CG + 多机位） ------------------------------ */
/*
 * 和虚拟演播室（真人绿幕）不同：这里没有摄像头，角色是程序化 3D 人形，
 * "切镜头"就是切场景里的另一台摄像机。渲染都在 stage.js（stage.bundle.js）里。
 */

const STAGE_DEFAULTS = {
  look: 'cinema',
  modelPath: '',
  motionPath: '',
  stage: 'neon',
  camera: 0,
  dance: 'dance1',
  autoCut: true,
  autoBeats: 4,
  shake: true,
  bpm: 118,
  lightHue: 0.58,
  bloom: 0.62,
  vignette: 0.45,
  charBright: 1,
  charScale: 1,
  charX: 0,
  charY: 0
}

const STAGE_SLIDERS = [
  {
    group: '节奏 / 画面',
    items: [
      { k: 'bpm', label: 'BPM', min: 70, max: 170, step: 1 },
      { k: 'bloom', label: '泛光', min: 0, max: 1.6, step: 0.02 },
      { k: 'vignette', label: '暗角', min: 0, max: 1, step: 0.02 },
      { k: 'lightHue', label: '主光色相', min: 0, max: 1, step: 0.01 }
    ]
  },
  {
    group: '角色',
    items: [
      { k: 'charBright', label: '亮度', min: 0.4, max: 2.2, step: 0.05 },
      { k: 'charScale', label: '缩放', min: 0.7, max: 1.5, step: 0.02 },
      { k: 'charX', label: '左右', min: -1.2, max: 1.2, step: 0.02 },
      { k: 'charY', label: '上下', min: -0.2, max: 0.6, step: 0.02 }
    ]
  }
]

function stageParams() {
  return { ...STAGE_DEFAULTS, ...(loadPrefs().stage || {}) }
}

let stageSaveTimer = null
function saveStageParams(params) {
  clearTimeout(stageSaveTimer)
  stageSaveTimer = setTimeout(() => savePrefs({ stage: params }), 400)
}

function whenStageReady() {
  if (window.PRStage) return Promise.resolve(window.PRStage)
  return new Promise((resolve, reject) => {
    let done = false
    const ok = () => {
      if (done) return
      done = true
      resolve(window.PRStage)
    }
    window.addEventListener('pr-stage-ready', ok, { once: true })
    setTimeout(() => {
      if (done) return
      done = true
      reject(new Error('虚拟人舞台模块没加载起来（src/renderer/stage.js → stage.bundle.js）'))
    }, 8000)
  })
}

/** 舞台瓦片的面板：机位 / 场景 / 动作 / 节奏 */
function buildStagePanel(t) {
  const panel = document.createElement('div')
  panel.className = 'studio-panel hidden'
  const params = t.stageParams

  function row(cls) {
    const r = document.createElement('div')
    r.className = cls
    panel.appendChild(r)
    return r
  }
  function head(text) {
    const h = document.createElement('div')
    h.className = 'sp-sec'
    h.textContent = text
    panel.appendChild(h)
  }
  function chips(parent, list, getActive, onPick) {
    const nodes = []
    for (const item of list) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'sp-scene'
      b.textContent = item.label
      b.dataset.key = String(item.key !== undefined ? item.key : item.index)
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        onPick(item)
        for (const n of nodes) n.classList.toggle('on', n === b)
      })
      parent.appendChild(b)
      nodes.push(b)
    }
    const sync = () => {
      const act = String(getActive())
      for (const n of nodes) n.classList.toggle('on', n.dataset.key === act)
    }
    sync()
    return sync
  }

  const api = window.PRStage || {}
  const cameras = api.cameras ? api.cameras() : [{ index: 0, label: '全景' }]
  const stages = api.stages ? api.stages() : [{ key: 'neon', label: '霓虹舞台' }]
  const dances = api.dances ? api.dances() : [{ key: 'dance1', label: '舞蹈 A' }]

  head('画面风格')
  const lookRow = row('sp-presets')
  const lookDefs = [
    { key: 'faithful', label: '像 VRoid（不调色）' },
    { key: 'cinema', label: '电影感（泛光/暗角）' }
  ]
  const lookNodes = []
  for (const it of lookDefs) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'sp-preset'
    b.textContent = it.label
    b.dataset.look = it.key
    b.addEventListener('click', async (e) => {
      e.stopPropagation()
      // 有的模型还没加载完，setLook 是纯设置，随时可切
      if (t.stage) t.stage.setLook(it.key)
      t.stageParams.look = it.key
      saveStageParams(t.stageParams)
      for (const x of lookNodes) x.classList.toggle('on', x === b)
      statusEl.textContent =
        it.key === 'faithful'
          ? '画面风格：像 VRoid（关掉 ACES 调色和泛光，换成中性三点光）'
          : '画面风格：电影感（ACES 色调映射 + 泛光 + 暗角）'
      statusEl.className = ''
    })
    b.classList.toggle('on', t.stageParams.look === it.key)
    lookNodes.push(b)
    lookRow.appendChild(b)
  }

  head('机位（切镜头）')
  const camRow = row('sp-presets')
  const syncCams = chips(
    camRow,
    cameras,
    () => (t.stage ? t.stage.camIndex : params.camera),
    (item) => {
      params.camera = item.index
      if (t.stage) t.stage.setCamera(item.index)
      saveStageParams(params)
      updateBadge()
    }
  )

  const camOpts = row('sp-presets')
  const autoBtn = document.createElement('button')
  autoBtn.type = 'button'
  autoBtn.className = 'sp-preset'
  autoBtn.textContent = '自动导播'
  autoBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    params.autoCut = !params.autoCut
    autoBtn.classList.toggle('on', params.autoCut)
    if (t.stage) t.stage.setAutoCut(params.autoCut, params.autoBeats)
    saveStageParams(params)
  })
  autoBtn.classList.toggle('on', params.autoCut)
  camOpts.appendChild(autoBtn)

  const shakeBtn = document.createElement('button')
  shakeBtn.type = 'button'
  shakeBtn.className = 'sp-preset'
  shakeBtn.textContent = '切换抖动'
  shakeBtn.classList.toggle('on', params.shake)
  shakeBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    params.shake = !params.shake
    shakeBtn.classList.toggle('on', params.shake)
    if (t.stage) t.stage.shake = params.shake
    saveStageParams(params)
  })
  camOpts.appendChild(shakeBtn)

  head('舞台')
  const sceneRow = row('sp-scenes')
  const syncScenes = chips(
    sceneRow,
    stages,
    () => params.stage,
    (item) => {
      params.stage = item.key
      if (t.stage) t.stage.setScene(item.key)
      saveStageParams(params)
    }
  )

  head('动作')
  const danceRow = row('sp-presets')
  const syncDance = chips(
    danceRow,
    dances,
    () => params.dance,
    (item) => {
      params.dance = item.key
      if (t.stage) t.stage.setDance(item.key)
      saveStageParams(params)
    }
  )

  // 角色 / 动作（VRM + Mixamo）
  head('角色 / 动作')
  const assetRow = row('sp-row')
  const modelBtn = document.createElement('button')
  modelBtn.type = 'button'
  modelBtn.className = 'sp-reset'
  modelBtn.textContent = '换角色 (.vrm)'
  const motionBtn = document.createElement('button')
  motionBtn.type = 'button'
  motionBtn.className = 'sp-reset'
  motionBtn.textContent = '载入动作 (.fbx)'
  const assetInfo = document.createElement('span')
  assetInfo.className = 'sp-music'
  assetInfo.textContent = describeAssets(t)
  modelBtn.addEventListener('click', async (e) => {
    e.stopPropagation()
    await pickStageAsset(t, 'model', assetInfo)
  })
  motionBtn.addEventListener('click', async (e) => {
    e.stopPropagation()
    await pickStageAsset(t, 'motion', assetInfo)
  })
  assetRow.appendChild(modelBtn)
  assetRow.appendChild(motionBtn)
  assetRow.appendChild(assetInfo)
  t.syncAssets = () => {
    assetInfo.textContent = describeAssets(t)
  }

  // 配乐
  head('配乐（可选）')
  const musicRow = row('sp-row')
  const musicBtn = document.createElement('button')
  musicBtn.type = 'button'
  musicBtn.className = 'sp-reset'
  musicBtn.textContent = '选音频文件'
  const musicInfo = document.createElement('span')
  musicInfo.className = 'sp-music'
  musicInfo.textContent = '没有配乐：动作/灯光按 BPM 走'
  musicBtn.addEventListener('click', async (e) => {
    e.stopPropagation()
    try {
      const res = await window.pr.pickLocalFiles()
      if (!res || !res.ok || !res.files || !res.files.length) return
      const f = res.files[0]
      const audio = document.createElement('audio')
      audio.src = 'prmedia://local/?p=' + encodeURIComponent(f.path)
      audio.loop = true
      audio.crossOrigin = 'anonymous'
      const Ctx = window.AudioContext || window.webkitAudioContext
      const ctx = new Ctx()
      const src = ctx.createMediaElementSource(audio)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      src.connect(analyser)
      analyser.connect(ctx.destination)
      await audio.play()
      t.music = { audio, ctx, analyser }
      if (t.stage) t.stage.setAnalyser(analyser)
      musicInfo.textContent = '♪ ' + f.name
      t.titleEl.title = t.fileName + ' · 配乐 ' + f.name
    } catch (err) {
      musicInfo.textContent = '配乐加载失败：' + ((err && err.message) || err)
    }
  })
  musicRow.appendChild(musicBtn)
  musicRow.appendChild(musicInfo)

  // 滑块
  const inputs = []
  for (const grp of STAGE_SLIDERS) {
    head(grp.group)
    for (const it of grp.items) {
      const lab = document.createElement('label')
      lab.className = 'sp-slider'
      const name = document.createElement('span')
      name.textContent = it.label
      const input = document.createElement('input')
      input.type = 'range'
      input.min = String(it.min)
      input.max = String(it.max)
      input.step = String(it.step)
      input.value = String(params[it.k])
      const val = document.createElement('b')
      val.textContent = String(params[it.k])
      input.addEventListener('input', (e) => {
        e.stopPropagation()
        const v = Number(e.currentTarget.value)
        params[it.k] = v
        val.textContent = String(v)
        if (t.stage) t.stage.setParams(params)
        saveStageParams(params)
      })
      input.addEventListener('pointerdown', (e) => e.stopPropagation())
      input.addEventListener('click', (e) => e.stopPropagation())
      lab.appendChild(name)
      lab.appendChild(input)
      lab.appendChild(val)
      panel.appendChild(lab)
      inputs.push({ k: it.k, input, val })
    }
  }

  function syncSliders() {
    for (const x of inputs) {
      x.input.value = String(params[x.k])
      x.val.textContent = String(params[x.k])
    }
  }

  /** 画面上那个小角标：现在在哪台机位 */
  function updateBadge() {
    if (!t.camBadge) return
    const cur = cameras[t.stage ? t.stage.camIndex : params.camera] || cameras[0]
    t.camBadge.textContent = '机位 ' + ((t.stage ? t.stage.camIndex : params.camera) + 1) + ' · ' + cur.label
  }

  function syncLook() {
    const cur = t.stage ? t.stage.lookMode : params.look
    for (const x of lookNodes) x.classList.toggle('on', x.dataset.look === cur)
    if (t.stage) params.look = t.stage.lookMode
  }

  t.syncStagePanel = () => {
    syncCams()
    syncScenes()
    syncDance()
    syncLook()
    syncSliders()
    updateBadge()
  }

  return { panel, syncSliders, updateBadge }
}

function describeAssets(t) {
  const p = t.stageParams || {}
  const m = p.modelPath ? p.modelPath.split(/[\\/]/).pop() : '占位人形'
  const a = p.motionPath ? p.motionPath.split(/[\\/]/).pop() : '程序化舞蹈'
  return '角色：' + m + ' · 动作：' + a
}

/** 选模型/动作文件并加载到这块舞台 */
async function pickStageAsset(t, kind, infoEl) {
  if (!t || !t.stage) return
  let res
  try {
    res = await window.pr.pickLocalFiles(kind)
  } catch (err) {
    if (infoEl) infoEl.textContent = '选择文件失败：' + ((err && err.message) || err)
    return
  }
  if (!res || !res.ok || !res.files || !res.files.length) return
  const f = res.files[0]
  const url = 'prmedia://local/?p=' + encodeURIComponent(f.path)
  if (infoEl) infoEl.textContent = '正在加载 ' + f.name + ' …'
  try {
    if (kind === 'model') {
      const r = await t.stage.loadModel(url, f.name)
      t.stageParams.modelPath = f.path
      // VRM 会自动切到"像 VRoid（不调色）"，这里把它记下来、面板也同步
      if (r.look) t.stageParams.look = r.look
      if (t.syncStagePanel) t.syncStagePanel()
      saveStageParams(t.stageParams)
      statusEl.textContent = '角色已换成 ' + f.name + (r.vrm ? '（VRM）' : '（普通 glTF，已按 1.75m 归一化）')
      statusEl.className = 'ok'
    } else {
      const r = await t.stage.loadMotion(url, f.name)
      t.stageParams.motionPath = f.path
      saveStageParams(t.stageParams)
      statusEl.textContent =
        '动作已载入 ' + f.name + '（' + r.tracks + ' 条轨道，' + r.duration + ' 秒，循环播放）'
      statusEl.className = 'ok'
    }
    if (t.syncAssets) t.syncAssets()
  } catch (err) {
    const msg = (err && err.message) || String(err)
    if (infoEl) infoEl.textContent = '加载失败：' + msg.slice(0, 90)
    statusEl.textContent = '加载失败：' + msg
    statusEl.className = 'err'
  }
}

async function addStageTile(opts = {}) {
  if (tiles.size >= MAX_TILES) {
    statusEl.textContent = `最多同时打开 ${MAX_TILES} 个瓦片（当前 ${tiles.size} 个）`
    statusEl.className = 'err'
    return null
  }
  let api
  try {
    api = await whenStageReady()
  } catch (err) {
    statusEl.textContent = '虚拟人舞台加载失败：' + ((err && err.message) || err)
    statusEl.className = 'err'
    return null
  }
  if (!api) return null

  const label = String(opts.label || '虚拟人舞台')
  const uid = 'r' + ++seq
  const el = document.createElement('section')
  el.className = 'tile local studio stage'
  el.dataset.uid = uid
  el.innerHTML =
    TILE_HEAD_HTML +
    '<div class="stage">' +
    '<canvas class="studio-canvas"></canvas>' +
    '<div class="overlay">正在搭建舞台…</div>' +
    '<div class="stage-cam-badge">机位 1</div>' +
    '<div class="studio-hint">⚙ 舞台 / 机位</div>' +
    '<div class="tile-name"></div>' +
    '</div>'

  const canvas = el.querySelector('.studio-canvas')
  const overlay = el.querySelector('.overlay')
  const titleEl = el.querySelector('.title')
  const idxEl = el.querySelector('.idx')
  const muteBtn = el.querySelector('.mute')
  const volEl = el.querySelector('.vol')
  const badgeEl = el.querySelector('.badge')
  const recBtn = el.querySelector('.rec')
  const recSplitBtn = el.querySelector('.rec-split')
  const recReplayBtn = el.querySelector('.rec-replay')
  const stageEl = el.querySelector('.stage')
  const nameEl = el.querySelector('.tile-name')

  recBtn.classList.add('hidden')
  recSplitBtn.classList.add('hidden')
  if (recReplayBtn) recReplayBtn.classList.add('hidden')
  badgeEl.classList.add('hidden')
  volEl.classList.add('hidden')
  muteBtn.classList.add('hidden')

  const t = {
    el,
    uid,
    view: null,
    mediaEl: null,
    studio: null,
    stage: null,
    stageParams: stageParams(),
    music: null,
    camBadge: el.querySelector('.stage-cam-badge'),
    stream: null,
    overlay,
    titleEl,
    idxEl,
    muteBtn,
    volEl,
    badgeEl,
    qEl: el.querySelector('.tile-q'),
    danmuEl: null,
    recBtn,
    recSplitBtn,
    recReplayBtn,
    stageEl,
    nameEl,
    url: 'stage://' + uid,
    fileName: label,
    muted: true,
    volume: 1,
    failed: false,
    other: false,
    otherAt: 0,
    removed: false,
    watch: null,
    pokes: 0
  }
  tiles.set(uid, t)

  titleEl.textContent = label
  titleEl.title = '虚拟人舞台（全 CG + 多机位）'
  if (nameEl) nameEl.textContent = label

  wireTileBasics(uid, t)
  gridEl.appendChild(el)

  const built = buildStagePanel(t)
  stageEl.appendChild(built.panel)
  el.querySelector('.studio-hint').addEventListener('click', (e) => {
    e.stopPropagation()
    built.panel.classList.toggle('hidden')
  })

  refreshIndices()
  updateCount()
  layout()

  try {
    const rt = new api.StageRuntime(canvas, {
      onError: (err) => console.warn('[stage] render error', err),
      onCamera: () => built.updateBadge(),
      onLook: () => {
        if (t.syncStagePanel) t.syncStagePanel()
      }
    })
    t.stage = rt
    rt.setScene(t.stageParams.stage)
    rt.setLook(t.stageParams.look || 'cinema')
    rt.setDance(t.stageParams.dance)
    rt.setAutoCut(t.stageParams.autoCut, t.stageParams.autoBeats)
    rt.shake = t.stageParams.shake
    rt.setCamera(t.stageParams.camera, true)
    rt.setParams(t.stageParams)
    hideOverlay(t)
    built.updateBadge()
    // 上次用过的角色/动作：文件还在就自动加载
    const mp = t.stageParams.modelPath
    const ap = t.stageParams.motionPath
    if (mp || ap) {
      Promise.resolve()
        .then(async () => {
          const st = await window.pr.localStat([mp, ap].filter(Boolean))
          if (mp && st[0]) await rt.loadModel('prmedia://local/?p=' + encodeURIComponent(mp), mp.split(/[\\/]/).pop())
          if (ap) {
            const okMotion = mp ? st[1] : st[0]
            if (okMotion) await rt.loadMotion('prmedia://local/?p=' + encodeURIComponent(ap), ap.split(/[\\/]/).pop())
          }
          if (t.syncAssets) t.syncAssets()
        })
        .catch((err) => console.warn('[stage] restore assets failed', err))
    }
  } catch (err) {
    showOverlay(t, label + '\n启动失败：' + ((err && err.message) || err), true)
  }

  if (typeof renderCards === 'function') renderCards()
  return uid
}

const stageBtn = document.getElementById('btn-stage')
if (stageBtn) {
  stageBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    addStageTile()
  })
}

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
  el.innerHTML =
    TILE_HEAD_HTML +
    `
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
  const recReplayBtn = el.querySelector('.rec-replay')
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
    qEl: el.querySelector('.tile-q'),
    danmuEl,
    recBtn,
    recSplitBtn,
    recReplayBtn,
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
  wireTileBasics(uid, t)
  el.querySelector('.rec').addEventListener('click', (e) => {
    e.stopPropagation()
    toggleRecord(uid)
  })
  el.querySelector('.rec-split').addEventListener('click', (e) => {
    e.stopPropagation()
    splitRecord(uid)
  })
  const replayBtn = el.querySelector('.rec-replay')
  if (replayBtn) {
    replayBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      const r = replayBtn.getBoundingClientRect()
      openReplayMenu(uid, Math.round(r.left), Math.round(r.bottom + 4))
    })
  }
  // 右键顶栏 = 这个房间自己的设置（目前是画质），不用占顶栏宽度
  el.querySelector('.tile-head').addEventListener('contextmenu', (e) => {
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
    // 虎牙页面默认是"流畅"（800×450）：加载完后把画质自动顶到能用的最高档
    if (platformOf(t.url) === 'huya') {
      setTimeout(() => applyHuyaQuality(uid), 2500)
      setTimeout(() => applyHuyaQuality(uid), 7000)
      setTimeout(() => applyHuyaQuality(uid), 15000)
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
    t.crashReload = false
    if (!t.failed) hideOverlay(t)
  })
  view.addEventListener('did-fail-load', (e) => {
    if (!e.isMainFrame) return
    if (e.errorCode === -3) return // 被主动中断，忽略
    t.failed = true
    showOverlay(t, `加载失败（${e.errorCode} ${e.errorDescription || ''}）\n${e.validatedURL || url}`, true)
  })
  view.addEventListener('render-process-gone', (e) => {
    if (t.crashReload) {
      // 我们自己故意崩掉的（页面主线程卡死时只能换一个新渲染进程，reload 是排不进队）
      showOverlay(t, '页面卡死了，正在换一个新进程重开…')
      return
    }
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
  if (t.studio) {
    try { t.studio.dispose() } catch {}
    t.studio = null
  }
  if (t.stage) {
    try { t.stage.dispose() } catch {}
    t.stage = null
  }
  if (t.music) {
    try { t.music.audio.pause() } catch {}
    try { t.music.ctx.close() } catch {}
    t.music = null
  }
  // 本地音视频 / 摄像头瓦片：先停掉播放（摄像头还要把轨道关掉，否则指示灯一直亮）
  if (t.mediaEl) {
    try {
      t.mediaEl.pause()
      if (t.stream) {
        for (const tr of t.stream.getTracks()) tr.stop()
        t.stream = null
      }
      t.mediaEl.srcObject = null
      t.mediaEl.removeAttribute('src')
      t.mediaEl.load()
    } catch {}
  }
  // 先把这个页面的 guest id 记下来：等一下要让主进程点名销毁它
  let guestId = -1
  if (!t.mediaEl) {
    try {
      guestId = t.view.getWebContentsId()
    } catch {}
    // 立刻静音：移除 DOM 到"guest 真的被销毁"之间有几十毫秒，别让人听见尾巴
    try {
      t.view.setAudioMuted(true)
    } catch {}
  }
  tiles.delete(uid)
  if (focusUid === uid) focusUid = null
  if (spotlightUid === uid) spotlightUid = null
  if (!t.mediaEl) {
    try {
      t.view.stop()
    } catch {}
    try {
      t.view.remove()
    } catch {}
  }
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
  if (t.studio) {
    // 视频文件当表演者：重新拉一遍文件；摄像头：重开一路流
    if (t.studioParams.performerKind === 'file' && t.studioParams.performerPath) {
      showOverlay(t, '正在重新加载表演者视频…')
      const ok = t.studio.setVideoUrl(studioMediaUrl(t.studioParams.performerPath))
      if (ok) hideOverlay(t)
      else showOverlay(t, t.fileName + '\n表演者视频加载失败', true)
      return
    }
    showOverlay(t, '正在重开摄像头…')
    openStudioCamera(t.deviceId)
      .then((stream) => {
        if (t.removed) { for (const tr of stream.getTracks()) tr.stop(); return }
        if (t.stream) for (const tr of t.stream.getTracks()) tr.stop()
        t.stream = stream
        if (t.studio) t.studio.setStream(stream)
        hideOverlay(t)
      })
      .catch((err) => showOverlay(t, t.fileName + '\n' + camErrorText(err), true))
    return
  }
  if (t.camera) {
    // 摄像头：重新要一次流（拔了再插、或刚才被别的程序占用）
    showOverlay(t, '正在重新打开摄像头…')
    acquireCameraStream(t, uid)
    return
  }
  if (t.local && t.mediaEl) {
    // 本地文件：重新拉一遍
    showOverlay(t, '正在重新打开本地文件…')
    try {
      t.mediaEl.src = mediaUrl(t.path)
      t.mediaEl.load()
      applyMute(uid)
      Promise.resolve(t.mediaEl.play()).catch(() => {})
    } catch {
      showOverlay(t, '打不开这个文件了（路径还在吗？）', true)
    }
    return
  }
  showOverlay(t, '正在重新加载…')
  // 手动/自动重载都把"卡住计数"清干净，让 watchdog 重新开始判
  t.pokeAt = 0
  t.stuckSince = 0
  t.stuckShown = false
  t.frozenSince = 0
  t.frozenShown = false
  t.pokes = 0
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
      // 开始 / 结束 / 准备中 / 重试：四个明确状态，点下去立刻有反馈（不再"点了像没反应"）
      const starting = !isThis && recStarting.has(uid)
      const failed = !isThis && Boolean(t.recFailMsg)
      t.recBtn.textContent = starting ? '⋯ 准备中' : isThis ? '■ 结束' : failed ? '✕ 重试' : '● 开始'
      t.recBtn.classList.toggle('on', isThis)
      t.recBtn.classList.toggle('busy', starting)
      t.recBtn.classList.toggle('fail', failed)
      t.recBtn.title = isThis
        ? '结束录制（保存）'
        : failed
          ? `${t.recFailMsg}（点一下再试一次）`
          : starting
            ? '正在准备录制：抓流地址 / 等画面出来…'
            : '开始录制这个房间'
    }
    if (t.recSplitBtn) {
      t.recSplitBtn.classList.toggle('hidden', !isThis)
      t.recSplitBtn.disabled = !isThis
    }
    if (t.recReplayBtn) {
      // 直播瓦片：录制中才出现；本地视频瓦片：只要不是纯音频就一直有（按当前播放进度截）
      const localVideo = Boolean(t.local && t.mediaEl && !isAudioFile(t.fileName || t.path || ''))
      const show = isThis || localVideo
      t.recReplayBtn.classList.toggle('hidden', !show)
      t.recReplayBtn.disabled = !show
      t.recReplayBtn.title = localVideo
        ? '精彩片段：按当前播放进度截最近一段（不用录制）'
        : '精彩片段：把最近一段单独存出来（不停止录制）'
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
    // 屏幕/整窗录制的音频是系统混音：把"现在有几个房间在出声"直接写在状态栏上
    let audioTag = ''
    if (hasScreen) {
      let sounding = 0
      for (const t of tiles.values()) {
        if (t.local || t.camera || t.studio || t.stage) continue
        if (!t.muted && (typeof t.volume !== 'number' || t.volume > 0.01)) sounding++
      }
      audioTag = ` · 音频＝系统混音（${sounding} 个房间出声）`
    }
    statusEl.textContent = `● 录制中 ${recMap.size} 路(${tag}) 第${seg}段 ${fmtDuration(longest)}${keepTag}${screenTag}${audioTag}`
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
  } else if (recentRecFail()) {
    // 失败原因要留在状态栏上（以前 renderRecUi 的 else 会立刻把它擦掉，
    // 用户只看到按钮变成「✕ 重试」，完全不知道错在哪）
    const f = recentRecFail()
    statusEl.textContent = f.msg
    statusEl.className = 'err'
  } else {
    statusEl.textContent = ''
    statusEl.className = ''
  }
  // 录制状态变化会改变"全屏时要不要露小窗入口"，顺手同步一下
  if (typeof fscSyncFab === 'function') fscSyncFab()
}

/** 正在启动中的房间（等流地址那段最长 8 秒，防连点） */
const recStarting = new Set()

/**
 * 录制的失败反馈：状态栏写原因 + 瓦片闪一下 + 按钮变成「✕ 重试」。
 * 以前只写状态栏，看着就像"点了没反应"。
 */
/** 最近 60 秒内的录制失败原因（状态栏用它把原因留住） */
function recentRecFail() {
  const now = Date.now()
  let best = null
  for (const [, t] of tiles) {
    if (!t || !t.recFailMsg) continue
    if (t.recFailAt && now - t.recFailAt > 60 * 1000) continue
    if (!best || (t.recFailAt || 0) > (best.at || 0)) best = { msg: t.recFailMsg, at: t.recFailAt || 0 }
  }
  return best
}

function recFail(t, msg) {
  const text = String(msg || '录制启动失败')
  if (t) {
    t.recFailMsg = text
    t.recFailAt = Date.now()
    try {
      t.el.classList.remove('flash')
      // 重启动画：先移除再加回来
      void t.el.offsetWidth
      t.el.classList.add('flash')
      setTimeout(() => t.el.classList.remove('flash'), 1200)
    } catch {}
  }
  statusEl.textContent = text
  statusEl.className = 'err'
  renderRecUi()
}

async function toggleRecord(uid) {
  const t = tiles.get(uid)
  if (!t) return
  if (t.local || t.camera || t.studio || t.stage) {
    statusEl.textContent = (t.studio || t.stage) ? '演播室不单独录制（用「录窗口」录合成画面）' : t.camera ? '摄像头不录制（要录就用「录窗口」）' : '本地文件不用录制（它本身就是文件）'
    statusEl.className = ''
    return
  }
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
  // 再点一次 = 重试：把上次的失败标记清掉（顺便允许再自动重载一次）
  t.recFailMsg = ''
  t.recAutoReloaded = false
  recStarting.add(uid)
  statusEl.textContent = '正在准备录制…'
  statusEl.className = ''
  renderRecUi()
  try {
    await toggleRecordInner(uid, t)
  } catch (err) {
    recFail(t, '录制启动出错：' + ((err && err.message) || err))
  } finally {
    recStarting.delete(uid)
    renderRecUi()
  }
}

/**
 * 抓不到流时，先问一句页面自己怎么说的（已下播 / 未开播 / 账号在别处）。
 * 这一句能直接回答"是哪里出错了"，比只写"再点重试"有用得多。
 */
async function tileOfflineReason(t) {
  try {
    if (!t || !t.view) return ''
    const r = await Promise.race([
      t.view.executeJavaScript(
        `(() => {
           const txt = (document.body && document.body.innerText) || ''
           const m = txt.match(/直播已结束|主播已下播|已下播|未开播|暂未开播|直播间不存在|账号已在其他地方进入直播间/)
           return m ? m[0] : ''
         })()`,
        true
      ),
      new Promise((res) => setTimeout(() => res('__timeout__'), 3000))
    ])
    // 页面主线程卡死（重/已结束的抖音房间很常见）时 executeJavaScript 是不返回的
    if (r === '__timeout__') return '页面卡住/主线程没响应'
    return String(r || '')
  } catch {
    return '页面读不出内容'
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

  /**
   * 斗鱼：页面里那条 flv 跟页面会话绑定（ffmpeg 复用只给 0.2 秒），
   * 所以让主进程走移动站接口取一条独立的 HLS 地址；取到就直录，取不到才退回屏幕录制。
   */
  const isDouyu = platformOf(t.url) === 'douyu'
  let douyuStreamOk = false
  let douyuReferer = ''
  if (isDouyu) {
    statusEl.textContent = '斗鱼：正在取直录地址…'
    statusEl.className = ''
    try {
      const r = await window.pr.douyuStreams(t.url, guestId)
      if (r && r.ok && Array.isArray(r.urls) && r.urls.length) {
        douyuStreamOk = true
        t.douyuNextAt = Date.now() + 5 * 60 * 1000
        // ⚠️ 这里不能直接改上面的 referer：它是在本函数后面才 `let` 声明的，
        // 提前赋值会踩 TDZ（报 "Cannot access 'referer' before initialization"，
        // 之前就因此整个斗鱼取流分支直接抛错、退化成屏幕录制）。
        douyuReferer = r.referer || ''
        const q = (r.settings || []).map((s) => s.name).join(' / ')
        statusEl.textContent = `斗鱼直录流：${r.urls.length} 条 HLS 线路${q ? '（' + q + '）' : ''}`
        statusEl.className = ''
      } else {
        t.douyuError = (r && r.error) || '取流失败'
        statusEl.textContent = '斗鱼取流失败：' + t.douyuError + '，改用屏幕录制'
        statusEl.className = 'warn'
        if (focusUid !== uid) setFocus(uid)
        await new Promise((res) => setTimeout(res, 600))
      }
    } catch (err) {
      t.douyuError = String((err && err.message) || err)
      statusEl.textContent = '斗鱼取流失败：' + t.douyuError + '，改用屏幕录制'
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

  /**
   * 抓到的流地址可能"过期"：抖音的 flv 地址带 wsSecret + keeptime，
   * 页面停止请求（暂停 / 被别处顶掉 / 开了很久）之后我们手里那条就只能拿到 403。
   * 之前只按"有没有地址"判断，于是拿一条 5 分钟前的旧地址去录 → ffmpeg 立刻 403
   * → 放弃 → 按钮回到「✕ 重试」，用户连点几次都是一样的失败（rec.log 里就是这样：
   * `stream url failed … 403/无数据` 然后 `wrote nothing this attempt, give up`）。
   * 现在地址超过 60 秒就直接重载页面，等它重新发一次请求。
   */
  const STALE_URL_MS = 60 * 1000
  if (mode === 'stream' && Number.isFinite(urlAgeMs) && urlAgeMs > STALE_URL_MS) {
    statusEl.textContent = `抓到的流地址已经 ${Math.round(urlAgeMs / 1000)} 秒没更新，重载页面重新抓一次…`
    statusEl.className = 'warn'
    t.recAutoReloaded = true // 这一轮已经手动重载过了，别再触发"自动重载一次"
    try {
      t.view.reload()
    } catch {}
    mode = 'screen'
    urlAgeMs = null
    await new Promise((res) => setTimeout(res, 1500))
  }

  /**
   * 什么时候只能屏幕录制：
   *  - other（优酷这类点播）：播放器自己的 MSE 一片片拉 .ts，页面里没有 .flv/.m3u8；
   *  - douyu 且**没取到移动站 HLS 地址**：页面里那条 flv 跟页面会话绑定（实测 ffmpeg 复用只给
   *    0.216 秒，同一个 token 再拉 403）。正常情况下上面已经拿到不绑会话的 m3u8 了，这里只是兜底。
   */
  const plat = platformOf(t.url)
  // 斗鱼只在"没取到 HLS 直录地址"时才退回屏幕录制
  const screenOnly = plat === 'other' || (plat === 'douyu' && !douyuStreamOk)
  if (screenOnly) {
    mode = 'screen'
    statusEl.textContent =
      plat === 'douyu'
        ? '斗鱼：没取到可直录的 HLS 地址（接口没给 / 房间没播），改用屏幕录制：清晰度受窗口大小限制'
        : '这一站抓不到直录流（播放器自己拉分片），改用屏幕录制：清晰度受窗口大小限制，不是原画'
    statusEl.className = 'warn'
    if (focusUid !== uid) setFocus(uid)
    await new Promise((res) => setTimeout(res, 500))
  } else if (plat === 'douyu' && douyuStreamOk) {
    // 已经有地址了，直接按直录走
    mode = 'stream'
  }

  // 刚打开的房间可能还没请求到 flv：等一会儿（最多 8 秒）再确认一次。
  // 注意：等不到也不会退化成屏幕录制——单个房间只走直录流，抓不到就报错让用户重试。
  if (mode !== 'stream' && !screenOnly) {
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

  if (mode !== 'stream' && !screenOnly) {
    // 抖音这边常见：页面开太久 / 播放器自己重初始化后，抓到的地址没了。
    // 自动重载一次再抓（用户不用自己去点 ⟳），失败才报错。
    if (!t.recAutoReloaded) {
      // 抖音这边常见：页面开太久 / 播放器自己重初始化后，抓到的地址没了。
      // 自动重载一次再抓（用户不用自己去点 ⟳），失败才报错。
      t.recAutoReloaded = true
      statusEl.textContent = '还没抓到这个房间的流地址，自动重载一次再抓…'
      statusEl.className = ''
      renderRecUi()
      try {
        t.view.reload()
      } catch {}
      for (let i = 0; i < 14; i++) {
        await new Promise((res) => setTimeout(res, 1000))
        let m = null
        try {
          m = await window.pr.recMode(guestId)
        } catch {}
        if (m && m.mode === 'stream') {
          mode = 'stream'
          urlAgeMs = Number.isFinite(m.urlAgeMs) ? m.urlAgeMs : urlAgeMs
          break
        }
        if (i === 5) statusEl.textContent = '重载后还在等画面出流…'
      }
      if (mode !== 'stream') {
        const why = urlAgeMs == null ? '重载后仍然抓不到这个房间的直播流地址' : '抓到的流地址已经过期'
        const hint = await tileOfflineReason(t)
        recFail(
          t,
          `${why}${hint ? `（页面显示「${hint}」）` : ''}：这个房间可能刚开播/刚断线，等画面出来后再点「✕ 重试」；具体原因看「调试」页第 5 节日志（红灯行）`
        )
        return
      }
    } else {
      const why = urlAgeMs == null ? '还没抓到这个房间的直播流地址' : '抓到的流地址已经过期'
      const hint = await tileOfflineReason(t)
      recFail(
        t,
        `${why}${hint ? `（页面显示「${hint}」）` : ''}：先点这个瓦片的「⟳」重载房间，等画面出来再点「✕ 重试」（不会退化成屏幕录制）；原因看「调试」页日志面板`
      )
      return
    }
  }
  if (mode === 'screen') {
    statusEl.textContent = '正在屏幕录制这一块画面（优酷等点播站只能这样录）'
  } else {
    statusEl.textContent = isHuya ? '正在直录流（虎牙 1080p）：不放大画面' : '正在直录流：原画 1080p，不放大画面'
    statusEl.className = ''
  }

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
  // 斗鱼直录流是 m 站的地址，Referer 得跟着换成 m 站（否则 CDN 可能挑 referer）
  if (isDouyu && douyuReferer) referer = douyuReferer

  let res = null
  const buildParams = (forceScreen) => ({
    uid,
    webContentsId: guestId,
    // 虎牙的直录地址要带 huya 的 Referer（主进程取流时会写进 streamUrls，这里兜一层）
    referer: isHuya ? 'https://www.huya.com/' : referer,
    // 页面地址：主进程据此去同一个 partition 里取 cookie / Origin。
    // 优酷这类站点的 m3u8 带签名且校验 cookie，不给 cookie 会 403。
    pageUrl: referer,
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
    recFail(t, '录制启动失败：' + (res.error || '未知原因'))
    return
  }
  // 启动成功：清掉失败标记（下次还能再自动重载）
  t.recFailMsg = ''
  t.recAutoReloaded = false

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

/** 边看边截的候选秒数（菜单里的顺序就是用户要的顺序） */
const REPLAY_SECONDS = [30, 20, 15, 10, 5, 3]
/** 秒数 → Ctrl+Shift+数字 的序号（1..6） */
function replayHotkeyIndex(seconds) {
  const i = REPLAY_SECONDS.indexOf(Number(seconds))
  return i >= 0 ? i + 1 : 0
}

/**
 * 精彩片段：把正在录的这条流「最近 N 秒」单独存成一个文件（不停止录制）。
 * 数据来自当前正在写的分段，所以录得越久越能往前取。
 */
async function snapshotHighlight(uid, seconds) {
  const n = Number(seconds) || 10
  if (!uid) {
    statusEl.textContent = `把鼠标移到正在录制的瓦片上，再按 Ctrl+Shift+${replayHotkeyIndex(n) || 1}（或点瓦片上的「⟲ 精彩」）`
    statusEl.className = 'warn'
    return
  }
  const tile = tiles.get(uid)
  // 本地视频瓦片：不用录制，直接按"当前播放进度"从文件里截
  const isLocalVideo = Boolean(tile && tile.local && tile.mediaEl && !isAudioFile(tile.fileName || tile.path || ''))
  if (!isLocalVideo && !recMap.has(uid)) {
    statusEl.textContent = '这个房间没在录制：精彩片段只能从正在录的流里截（先点「● 开始」）'
    statusEl.className = 'warn'
    return
  }
  const btn = tile && tile.recReplayBtn
  const label = (tile && (tile.titleEl ? tile.titleEl.textContent : '')) || uid
  if (btn) {
    btn.disabled = true
    btn.textContent = `⟲ ${n}s…`
  }
  statusEl.textContent = `正在截取「${label}」最近 ${n} 秒…`
  statusEl.className = 'warn'
  // 失败时让按钮自己红一下、写清原因——状态栏在窗口最底下，容易被忽略
  const fail = (reason) => {
    if (!btn) return
    btn.textContent = '⟲ 失败'
    btn.style.color = '#ff8a8a'
    btn.title = reason || '截取失败'
    setTimeout(() => {
      btn.textContent = '⟲ 精彩'
      btn.style.color = ''
      btn.title = '精彩片段：把最近一段单独存出来（不停止录制）'
    }, 2600)
  }
  try {
    // 本地视频：按当前播放进度截 [位置-N, 位置]；直播录制：从正在写的分段里截
    const atSec = isLocalVideo ? Math.max(0, Number(tile.mediaEl.currentTime) || 0) : 0
    const res = isLocalVideo
      ? await window.pr.recClipFile({ file: tile.path, atSec, seconds: n })
      : await window.pr.recSnapshot({ uid, seconds: n })
    if (res && res.ok) {
      const full = String(res.out || '')
      const name = full.split(/[\\/]/).pop()
      const dir = full.replace(/[\\/][^\\/]+$/, '')
      const anchor = isLocalVideo ? `截至 ${fmtDuration(atSec * 1000)}，最近 ${n} 秒` : `最近 ${n} 秒`
      statusEl.textContent = `已存精彩片段：${name}（${anchor} / ${Number(res.seconds || n).toFixed(1)}s）→ ${dir}`
      statusEl.className = 'ok'
      statusEl.title = full
      // 记住这一场的目录：以后进全屏（哪怕已经停录了）小窗还能列出这一场的片段
      if (!isLocalVideo && dir) FSC.lastDir = dir
      // 剪辑页的文件列表跟着刷新（切过去就能看到）
      refreshEditFiles({ silent: true, force: true }).catch(() => {})
      // 小窗：开着就追加这一格；关着而且在观看/监控页就自动弹出来（全屏、普通窗口都算）
      fscOnClipSaved(full, dir)
    } else {
      const msg = (res && res.error) || '未知原因'
      statusEl.textContent = `截取失败：${msg}`
      statusEl.className = 'err'
      statusEl.title = msg
      fail(msg)
    }
  } catch (err) {
    statusEl.textContent = '截取失败：' + ((err && err.message) || err)
    statusEl.className = 'err'
    return fail()
  } finally {
    if (btn) {
      btn.disabled = false
      if (btn.textContent !== '⟲ 失败') btn.textContent = '⟲ 精彩'
    }
  }
}

/** 瓦片上的「⟲ 精彩」按钮：弹一个 30/20/15/10/5/3 秒的菜单 */
function openReplayMenu(uid, x, y) {
  const tile = tiles.get(uid)
  const localVideo = Boolean(tile && tile.local && tile.mediaEl && !isAudioFile(tile.fileName || tile.path || ''))
  if (!localVideo && !recMap.has(uid)) {
    statusEl.textContent = '这个房间没在录制：先点「● 开始」，再截精彩片段'
    statusEl.className = 'warn'
    return
  }
  const pos = localVideo && tile.mediaEl ? `（截至 ${fmtDuration((Number(tile.mediaEl.currentTime) || 0) * 1000)}）` : ''
  const items = REPLAY_SECONDS.map((sec) => ({
    label: `往前 ${sec} 秒（Ctrl+Shift+${replayHotkeyIndex(sec)}）`,
    action: () => snapshotHighlight(uid, sec)
  }))
  showPopup(x, y, items, `截取最近 N 秒做精彩片段${pos}`)
}

/* -------------------- 全屏小窗：精彩片段（播放 + 左右两端精修） -------------------- */

/**
 * 全屏盯着一个房间看的时候，截下来的精彩片段要能**马上看、马上修**，不用退全屏再切「剪辑」。
 * 这块小窗固定在屏幕右侧或底部（可切换，记在 pr.prefs.fscPos）：
 *   - 上面是这一场录制的精彩/精修片段列表（点一下就播）；
 *   - 下面是左右两条滑杆：把两端往里收，点「另存精修」→ 生成 `<名字>_<时间戳>_精修<Ns>.mp4`，
 *     原片段不动（和「精彩片段」一样进这一场的目录，剪辑页也能看到）。
 */
const FSC_GRID_MAX = 16

/* 瓦片墙是"瀑布式"一列排下来的：每格占满小窗宽度，画面够大、把手也够粗 */
const FSC = {
  el: null,
  fab: null,
  listEl: null,
  /** 是否打开 */
  open: false,
  /** 'right' | 'bottom' */
  pos: 'right',
  /** 小窗播放要不要出声（默认开；全播时多路一起响，想只听一个就点单个片段） */
  sound: true,
  /** path -> <video>，用于全播 / 停止 / 释放解码器 */
  tileVideos: new Map(),
  /** 每个片段各自的左右选区：path -> { inSec, outSec, dur } */
  tileStates: new Map(),
  /** 当前选中的那个片段（底部按钮 / 另存 / 覆盖都作用在它上面） */
  selPath: '',
  /** 最后一次知道的那一场目录（停录后还能回看刚截的片段） */
  lastDir: '',
  dir: '',
  clips: [],
  busy: false,
  loaded: false
}

function fscLoadPrefs() {
  try {
    const p = loadPrefs()
    if (p.fscPos === 'bottom' || p.fscPos === 'right') FSC.pos = p.fscPos
    if (typeof p.fscSound === 'boolean') FSC.sound = p.fscSound
    // 重启后也能直接回看上次那一场（目录没了会在 fscRefresh 里自动清掉）
    if (typeof p.fscLastDir === 'string' && p.fscLastDir) FSC.lastDir = p.fscLastDir
  } catch {}
}

/** 当前正在看的这一路录制目录（优先聚焦/放大中的瓦片） */
function fscTargetDir() {
  const uids = []
  if (focusUid && recMap.has(focusUid)) uids.push(focusUid)
  if (spotlightUid && recMap.has(spotlightUid)) uids.push(spotlightUid)
  for (const [uid] of recMap) if (!uids.includes(uid)) uids.push(uid)
  for (const uid of uids) {
    const r = recMap.get(uid)
    if (r && r.dir) return { dir: r.dir, label: (tiles.get(uid) && tiles.get(uid).titleEl && tiles.get(uid).titleEl.textContent) || '' }
  }
  // 没在录制时：优先用"刚保存的那一场的成片目录"（停录后立刻能回看）
  const lastFile = String(recState.lastFile || '')
  if (lastFile) return { dir: lastFile.replace(/[\\/][^\\/]+$/, ''), label: '' }
  // 其余情况交给 fscRefresh 去问 recorder："最近一场有精彩片段的目录"是哪一场
  // （不能直接用"记住的目录"当首选，否则重启后会一直停在旧的那一场）
  return { dir: '', label: '' }
}

function fscSetStatus(text, cls = '') {
  const hint = document.getElementById('fsc-hint')
  if (!hint) return
  hint.textContent = text || ''
  hint.className = 'fsc-hint' + (cls ? ' ' + cls : '')
}

function fscApplyPos() {
  if (!FSC.el) return
  FSC.el.classList.toggle('right', FSC.pos === 'right')
  FSC.el.classList.toggle('bottom', FSC.pos === 'bottom')
  const btn = document.getElementById('fsc-pos')
  if (btn) btn.textContent = FSC.pos === 'right' ? '⇥ 右侧' : '⇩ 底部'
  fscApplyGridSpace()
}

/**
 * 小窗占着屏幕一块地方时，把瓦片区域让开 —— 否则右侧停靠会正好压住瓦片顶栏
 * 那排按钮（开始/结束、⟲ 精彩、⟳、✕）。让开之后 layout() 会重新算格子大小。
 * 全屏 / 普通窗口都适用。
 */
function fscApplyGridSpace() {
  const right = FSC.open && FSC.pos === 'right'
  const bottom = FSC.open && FSC.pos === 'bottom'
  const had = document.body.classList.contains('fsc-dock-right') || document.body.classList.contains('fsc-dock-bottom')
  document.body.classList.toggle('fsc-dock-right', right)
  document.body.classList.toggle('fsc-dock-bottom', bottom)
  // 普通窗口：小窗的上下边对齐瓦片区域（左/右两栏的顶部持平，别压住上面那两行工具栏）
  if (FSC.el) {
    const fs = document.body.classList.contains('fs')
    const gridEl = fs ? null : document.getElementById('grid')
    const gr = gridEl ? gridEl.getBoundingClientRect() : null
    if (gr && gr.height > 0) {
      FSC.el.style.top = `${Math.round(gr.top)}px`
      FSC.el.style.bottom = `${Math.max(0, Math.round(window.innerHeight - gr.bottom))}px`
    } else {
      FSC.el.style.top = ''
      FSC.el.style.bottom = ''
    }
  }
  const now = right || bottom
  if (had !== now || right || bottom) requestAnimationFrame(() => layout())
}

function fscSyncFab() {
  if (!FSC.fab) return
  // 全屏 / 普通窗口都能开（以前只有全屏才露入口）
  const hasSomething = recMap.size > 0 || Boolean(FSC.lastDir) || Boolean(recState.lastFile)
  // 剪辑页里不单独出这个入口：那一页自己就有「要合并的片段」列表，两个地方管同一批文件会乱
  const inEdit = !document.getElementById('view-edit').classList.contains('hidden')
  FSC.fab.classList.toggle('hidden', !hasSomething || FSC.open || inEdit)
  FSC.fab.classList.toggle('on', FSC.open)
}

/** 小窗播放的声音：所有片段（以及列表模式的大播放器）跟着这个开关走 */
function fscApplySound() {
  const muted = !FSC.sound
  for (const v of FSC.tileVideos.values()) {
    try {
      v.muted = muted
    } catch {}
  }
  const btn = document.getElementById('fsc-sound')
  if (btn) {
    btn.textContent = FSC.sound ? '🔊 有声音' : '🔇 静音'
    btn.classList.toggle('on', FSC.sound)
    btn.title = FSC.sound
      ? '小窗播放有声音（全播时多路一起响，想只听一个就点单个片段）'
      : '小窗播放静音（点一下打开声音）'
  }
}

function fscShow(show) {
  if (!FSC.el) return
  const on = Boolean(show)
  FSC.open = on
  FSC.el.classList.toggle('hidden', !on)
  // 告诉主进程小窗的状态：开着才拦 [ ] 两个键（焦点在画面里也能用）
  try {
    if (window.pr.setClipsWinOpen) window.pr.setClipsWinOpen(on)
  } catch {}
  if (on) {
    fscApplyPos()
    if (!FSC.loaded) {
      FSC.loaded = true
      fscRefresh({ autoPick: true }).catch((e) => console.warn('[fsc] refresh failed', e))
    } else {
      fscRefresh({ autoPick: false }).catch((e) => console.warn('[fsc] refresh failed', e))
    }
  } else {
    // 收起时把瓦片的解码也停掉（不然全屏退出了画面还在后台跑）
    for (const v of FSC.tileVideos.values()) {
      try {
        v.pause()
      } catch {}
    }
  }
  fscApplyGridSpace()
  fscSyncFab()
}

function fscTimeText(s) {
  const v = Math.max(0, Number(s) || 0)
  const m = Math.floor(v / 60)
  const rest = v - m * 60
  return `${m}:${rest < 10 ? '0' : ''}${rest.toFixed(1)}`
}

/** 底部那行读数：选中的那个片段的起点 / 中间（预览点）/ 终点 */
function fscRenderTrim() {
  const tin = document.getElementById('fsc-tin')
  const tcur = document.getElementById('fsc-tcur')
  const tout = document.getElementById('fsc-tout')
  const len = document.getElementById('fsc-len')
  const t = fscTarget()
  if (!t) {
    if (tin) tin.textContent = '—'
    if (tcur) tcur.textContent = '—'
    if (tout) tout.textContent = '—'
    if (len) len.textContent = '点一个片段选中它，再调起点/终点'
    return
  }
  const st = t.st
  if (tin) tin.textContent = fscTimeText(st.inSec)
  if (tcur) tcur.textContent = fscTimeText(Number(st.cur) || 0)
  if (tout) tout.textContent = fscTimeText(st.outSec)
  if (len) len.textContent = `选区 ${Math.max(0, st.outSec - st.inSec).toFixed(1)}s / 全长 ${st.dur.toFixed(1)}s`
  if (typeof st.paint === 'function') st.paint()
}

function fscRenderList() {
  const box = FSC.listEl
  if (!box) return
  // 每次重排都先把上一批瓦片的解码器放掉，不然切来切去会攒一堆 <video>
  for (const v of FSC.tileVideos.values()) {
    try {
      v.pause()
      v.removeAttribute('src')
      v.load()
    } catch {}
  }
  FSC.tileVideos.clear()
  box.textContent = ''
  if (!FSC.clips.length) {
    const d = document.createElement('div')
    d.className = 'fsc-empty'
    d.textContent = FSC.dir
      ? '这一场还没有精彩片段：点瓦片上的「⟲ 精彩」（或 Ctrl+Shift+1…6）截一段，这里会自动出现'
      : '当前没有在录制：先点「● 开始」，截了精彩片段后这里会有列表'
    box.appendChild(d)
    return
  }
  fscRenderGrid(box)
}

/**
 * 建一个片段卡（瀑布里的一格）。
 * 状态按 path 复用：截了新片段 / 刷新列表时，不会把已有片段的起点·中间·终点冲掉。
 */
function fscBuildTile(c) {
  {
    const card = document.createElement('div')
    card.className = 'fsc-tile' + (c.path === FSC.selPath ? ' on' : '')
    card.dataset.path = c.path
    card.title = c.path

    const v = document.createElement('video')
    v.muted = !FSC.sound
    v.loop = true
    v.playsInline = true
    v.preload = 'metadata'
    v.src = fscMediaUrl(c.path)

    // 每个片段一套状态，按 path 复用；只有文件真的被覆盖（size/mtime 变了）才重置
    const stamp = `${c.size}:${Math.round(c.mtime || 0)}`
    let st = FSC.tileStates.get(c.path)
    if (!st) {
      st = { inSec: 0, outSec: 0, dur: 0, cur: 0, stamp }
      FSC.tileStates.set(c.path, st)
    } else if (st.stamp !== stamp) {
      st.stamp = stamp
      st.resetOnLoad = true
    }

    const tag = document.createElement('span')
    tag.className = 'fsc-tile-tag'
    tag.textContent = fscClipTag(c, 0)

    // 这条细条就是这个片段自己的三个位置：起点 / 中间（预览点，画面跟着它走）/ 终点
    const bar = document.createElement('div')
    bar.className = 'fsc-tile-bar'
    const band = document.createElement('div')
    band.className = 'fsc-tile-band'
    const hIn = document.createElement('div')
    hIn.className = 'fsc-tile-h l'
    hIn.title = '左端（起点）'
    const hOut = document.createElement('div')
    hOut.className = 'fsc-tile-h r'
    hOut.title = '右端（终点）'
    const hCur = document.createElement('div')
    hCur.className = 'fsc-tile-h c'
    hCur.title = '中间位置：拖它看画面（用来判断起点终点该放哪）'
    bar.appendChild(band)
    bar.appendChild(hCur)
    bar.appendChild(hIn)
    bar.appendChild(hOut)

    const sel = document.createElement('span')
    sel.className = 'fsc-tile-sel'
    sel.textContent = ''

    card.appendChild(v)
    card.appendChild(tag)
    card.appendChild(sel)
    card.appendChild(bar)

    const paint = () => {
      const d = st.dur || 0
      const pa = d > 0 ? (st.inSec / d) * 100 : 0
      const pb = d > 0 ? (st.outSec / d) * 100 : 100
      const pc = d > 0 ? (st.cur / d) * 100 : 0
      band.style.left = `${pa}%`
      band.style.width = `${Math.max(0, pb - pa)}%`
      hIn.style.left = `${pa}%`
      hOut.style.left = `${pb}%`
      hCur.style.left = `${Math.max(0, Math.min(100, pc))}%`
      // 预览点跑到选区外面时变灰：这时它看的是"选区外"的画面（故意允许，方便判断两端该放哪）
      hCur.classList.toggle('out', st.cur < st.inSec - 0.05 || st.cur > st.outSec + 0.05)
      sel.textContent = d > 0 ? `${st.inSec.toFixed(1)}–${st.cur.toFixed(1)}–${st.outSec.toFixed(1)}s` : ''
    }
    st.paint = paint

    v.addEventListener('loadedmetadata', () => {
      st.dur = Number.isFinite(v.duration) ? v.duration : 0
      if (st.resetOnLoad || !(st.outSec > 0) || !(st.dur > 0)) {
        // 新片段 / 文件被覆盖过：默认整段，播放位置停在**起点**（整段从头开始看）
        st.inSec = 0
        st.outSec = st.dur
        st.cur = 0
        st.resetOnLoad = false
      } else {
        // 文件没变：沿用之前的起点·中间·终点，只把越界的夹回时长里
        st.inSec = Math.max(0, Math.min(st.inSec, st.dur))
        st.outSec = Math.max(Math.min(st.inSec + 0.2, st.dur), Math.min(st.outSec, st.dur))
        st.cur = Math.max(0, Math.min(st.cur, st.dur))
      }
      try {
        // 默认停在起点（不再固定 seek 到 0.2 秒之后）
        v.currentTime = Math.max(0, Math.min(st.cur, Math.max(0, st.dur - 0.1)))
      } catch {}
      tag.textContent = fscClipTag(c, st.dur)
      paint()
      if (FSC.selPath === c.path) fscRenderTrim()
    })
    // 播到右端就跳回左端：每个瓦片只在自己那段里循环；播放时"中间"标记跟着播放点走
    v.addEventListener('timeupdate', () => {
      if (!st.dur) return
      if (v.paused) return
      if (v.currentTime >= st.outSec - 0.03) {
        v.currentTime = st.inSec + 0.01
        return
      }
      if (v.currentTime < st.inSec - 0.05) v.currentTime = st.inSec + 0.01
      st.cur = v.currentTime
      paint()
      if (FSC.selPath === c.path) fscRenderTrim()
    })

    // 拖三个位置：起点 / 中间（预览）/ 终点。拖动期间暂停 + 边拖边 seek，画面跟着走
    const drag = (which) => (e) => {
      e.preventDefault()
      e.stopPropagation()
      fscSelect(c.path)
      const wasPlaying = !v.paused && which !== 'cur'
      try {
        v.pause()
      } catch {}
      let raf = 0
      let pendingSeek = -1
      const flushSeek = () => {
        raf = 0
        if (pendingSeek < 0) return
        const t = pendingSeek
        pendingSeek = -1
        try {
          if (Math.abs(Number(v.currentTime) - t) > 0.02) v.currentTime = t
        } catch {}
      }
      const move = (ev) => {
        const r = bar.getBoundingClientRect()
        const ratio = r.width > 0 ? Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) : 0
        const sec = ratio * (st.dur || 0)
        if (which === 'in') st.inSec = Math.max(0, Math.min(sec, st.outSec - 0.2))
        else if (which === 'out') st.outSec = Math.min(st.dur || sec, Math.max(sec, st.inSec + 0.2))
        // 拖中间那个 = 只挪预览点（不改选区），画面跟着这个位置走
        else st.cur = Math.max(0, Math.min(st.dur || sec, sec))
        paint()
        fscRenderTrim()
        pendingSeek =
          which === 'in' ? st.inSec : which === 'out' ? Math.max(st.inSec, st.outSec - 0.05) : st.cur
        if (!raf) raf = requestAnimationFrame(flushSeek)
      }
      move(e)
      const up = () => {
        window.removeEventListener('pointermove', move, true)
        window.removeEventListener('pointerup', up, true)
        if (raf) {
          cancelAnimationFrame(raf)
          raf = 0
        }
        flushSeek()
        // 松手后：原来在放就继续放（从新的左端开始），拖"中间"或原本停着就停在那一帧
        if (wasPlaying) {
          try {
            if (v.currentTime < st.inSec || v.currentTime >= st.outSec) v.currentTime = st.inSec
            const p = v.play()
            if (p && p.catch) p.catch(() => {})
          } catch {}
        }
      }
      window.addEventListener('pointermove', move, true)
      window.addEventListener('pointerup', up, true)
    }
    hIn.addEventListener('pointerdown', drag('in'))
    hOut.addEventListener('pointerdown', drag('out'))
    hCur.addEventListener('pointerdown', drag('cur'))
    bar.addEventListener('pointerdown', (e) => {
      // 点细条空白处 = 把"中间"预览点挪到这里（不改选区）
      if (e.target === hIn || e.target === hOut || e.target === hCur) return
      drag('cur')(e)
    })

    // 每格自己的操作按钮：用这一格的播放点当起点/终点，以及只处理这一格的另存/覆盖
    const acts = document.createElement('div')
    acts.className = 'fsc-tile-acts'
    const mkAct = (label, title, fn, cls = '') => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'fsc-tact' + (cls ? ' ' + cls : '')
      b.textContent = label
      b.title = title
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        fscSelect(c.path)
        fn()
      })
      acts.appendChild(b)
      return b
    }
    mkAct('⟦ 起点', '把这一格的播放点设为起点（快捷键 [ 或 1）', () => fscSetEdge('in', c.path))
    mkAct('终点 ⟧', '把这一格的播放点设为终点（快捷键 ] 或 2）', () => fscSetEdge('out', c.path))
    mkAct('⤓ 覆盖', '按这一格的选区直接替换这个片段（不可撤销）', () => fscSave(true, c.path), 'danger')
    mkAct('✕ 删', '把这个精彩片段文件从磁盘删掉（不可撤销）', () => fscDeleteClip(c.path), 'danger')
    card.appendChild(acts)

    // 点画面：选中它，并在这个瓦片里播放/暂停（不影响别的瓦片）
    v.addEventListener('click', () => {
      fscSelect(c.path)
      for (const [p, el] of FSC.tileVideos) {
        if (p !== c.path) {
          try {
            el.pause()
          } catch {}
        }
      }
      if (v.paused) {
        try {
          if (v.currentTime < st.inSec || v.currentTime >= st.outSec) v.currentTime = st.inSec
        } catch {}
        const p = v.play()
        if (p && p.catch) p.catch(() => {})
      } else {
        v.pause()
      }
    })

    FSC.tileVideos.set(c.path, v)
    return card
  }
}

/** 瀑布：一列排下来（状态复用，刷新不会重置别人） */
function fscRenderGrid(box) {
  // 只保留还在列表里的那几格的状态
  const keep = new Set(FSC.clips.map((x) => x.path))
  for (const k of [...FSC.tileStates.keys()]) if (!keep.has(k)) FSC.tileStates.delete(k)
  // 太老的片段不渲染，免得一口气开出几十个解码器；想找旧的切「☰ 列表」
  const shown = FSC.clips.slice(-FSC_GRID_MAX)
  if (shown.length < FSC.clips.length) {
    const tip = document.createElement('div')
    tip.className = 'fsc-more'
    tip.textContent = `只显示最近 ${FSC_GRID_MAX} 个（共 ${FSC.clips.length} 个），看更早的切「☰ 列表」`
    box.appendChild(tip)
  }
  for (const c of shown) box.appendChild(fscBuildTile(c))
  if (FSC.selPath && !FSC.tileStates.has(FSC.selPath)) FSC.selPath = ''
  fscRenderTrim()
}

/**
 * 只同步/重建某个片段那一格（另存、覆盖之后用）。
 * 不整体刷新：别的片段的起点·中间·终点、正在播的画面都不该跟着抖一下。
 */
async function fscRefreshOne(path) {
  if (!path) return
  let fresh = null
  try {
    fresh = await window.pr.recListClips(FSC.dir)
  } catch {}
  const clips = fresh && fresh.ok && Array.isArray(fresh.clips) ? fresh.clips : null
  if (!clips) return fscRefresh({ autoPick: false })

  // 数据同步：改过的更新 size/mtime，新增的补进来，没了的删掉
  const map = new Map(clips.map((x) => [x.path, x]))
  FSC.clips = FSC.clips.filter((x) => map.has(x.path)).map((x) => map.get(x.path))
  for (const x of clips) if (!FSC.clips.some((y) => y.path === x.path)) FSC.clips.push(x)
  FSC.clips.sort((a, b) => (a.mtime || 0) - (b.mtime || 0))

  const hit = map.get(path)
  if (!hit) {
    // 这一场里已经没有它了（被删/被换名）：退回整体刷新
    return fscRefresh({ autoPick: false })
  }
  const card = FSC.listEl ? FSC.listEl.querySelector(`.fsc-tile[data-path="${CSS.escape(path)}"]`) : null
  if (card) {
    // 同一个文件换了内容（覆盖）：先把旧的解码器放掉，再重建这一格
    const old = FSC.tileVideos.get(path)
    if (old) {
      try {
        old.pause()
        old.removeAttribute('src')
        old.load()
      } catch {}
      FSC.tileVideos.delete(path)
    }
    const st = FSC.tileStates.get(path)
    if (st) st.resetOnLoad = true
    card.replaceWith(fscBuildTile(hit))
    fscSelect(path)
    return
  }
  // 新片段（另存出来的）：只追加这一格，别的都不动
  if (FSC.listEl) FSC.listEl.appendChild(fscBuildTile(hit))
  fscSelect(path)
}

/**
 * 空格：播放 / 暂停"当前选中的那个片段"（每格都有自己的播放器）。
 */
function fscTogglePlaySelected() {
  const t = fscTarget()
  const v = (t && t.video) || (FSC.selPath ? FSC.tileVideos.get(FSC.selPath) : null)
  if (!v) {
    fscSetStatus('先点一个片段选中它，再按空格播放', 'warn')
    return
  }
  if (v.paused) {
    // 从选区起点开始播，别停在选区外面
    if (t && t.st && (v.currentTime < t.st.inSec - 0.02 || v.currentTime >= t.st.outSec - 0.03)) {
      try {
        v.currentTime = t.st.inSec + 0.01
      } catch {}
    }
    const p = v.play()
    if (p && p.catch) p.catch(() => {})
    fscSetStatus('已播放（空格暂停）')
  } else {
    v.pause()
    fscSetStatus('已暂停（空格继续）')
  }
}

/** 选中某个片段（底部按钮 / 另存 / 覆盖都作用在它上面） */
function fscSelect(path) {
  FSC.selPath = String(path || '')
  for (const el of FSC.listEl ? FSC.listEl.querySelectorAll('[data-path]') : []) {
    el.classList.toggle('on', el.dataset.path === FSC.selPath)
  }
  fscRenderTrim()
}

/** 当前编辑的对象：选中的那张瓦片 */
function fscTarget() {
  const st = FSC.selPath ? FSC.tileStates.get(FSC.selPath) : null
  if (!st) return null
  return { path: FSC.selPath, st, video: FSC.tileVideos.get(FSC.selPath) || null }
}

/** 指定某一段作为编辑对象（每格自带按钮、快捷键都用这个） */
function fscTargetByPath(path) {
  const key = String(path || '')
  if (!key) return null
  const st = FSC.tileStates.get(key)
  if (!st) return null
  return { path: key, st, video: FSC.tileVideos.get(key) || null }
}

/**
 * 把某一格的「当前播放点」设为起点或终点。
 * which = 'in' | 'out'；path 省略时作用于当前选中的那一段。
 */
function fscSetEdge(which, path = '') {
  const t = path ? fscTargetByPath(path) : fscTarget()
  if (!t) {
    fscSetStatus('先点一个片段选中它', 'warn')
    return
  }
  const cur = t.video ? Number(t.video.currentTime) || 0 : Number(t.st.cur) || 0
  if (which === 'in') t.st.inSec = Math.max(0, Math.min(cur, t.st.outSec - 0.2))
  else t.st.outSec = Math.min(t.st.dur || cur, Math.max(cur, t.st.inSec + 0.2))
  if (typeof t.st.paint === 'function') t.st.paint()
  fscRenderTrim()
  fscSetStatus(
    `${which === 'in' ? '起点' : '终点'} = 播放点 ${(which === 'in' ? t.st.inSec : t.st.outSec).toFixed(1)}s · 选区 ${Math.max(0, t.st.outSec - t.st.inSec).toFixed(1)}s`
  )
}

/** 带 mtime 的本地播放地址：覆盖原文件之后能强制重新解码（不被缓存骗） */
function fscMediaUrl(file) {
  const base = mediaUrl(file)
  return `${base}&t=${Date.now().toString(36)}`
}

/** 瓦片角标：优先用文件名里的「精彩Ns / 精修Ns」，读不到就等元数据后填时长 */
function fscClipTag(c, dur) {
  const m = String(c.name).match(/(精彩|精修)(\d+)s/)
  if (m) return `${m[1]}${m[2]}s`
  return dur > 0 ? `${dur.toFixed(1)}s` : '··'
}

/** 瓦片模式的「全播 / 停全播」 */

async function fscRefresh({ autoPick = false } = {}) {
  if (!FSC.el) return
  const t = fscTargetDir()
  FSC.dir = t.dir || ''
  // 没在录、也没刚存过：问 recorder 最近一场"有精彩片段"的目录（重启后也能直接回看最新那场）
  if (!FSC.dir) {
    let last = null
    try {
      last = await window.pr.recLastClipsDir()
    } catch {}
    if (last && last.ok && last.dir) {
      FSC.dir = last.dir
      FSC.lastDir = last.dir
      savePrefs({ fscLastDir: last.dir })
    } else if (FSC.lastDir) {
      // 兜底：用记住的那一场（目录要是真没了，下面的 listClips 会报"不存在"再清掉）
      FSC.dir = FSC.lastDir
    }
  }
  if (FSC.dir && FSC.dir !== FSC.lastDir) {
    FSC.lastDir = FSC.dir
    // 记下来：下次启动/停录之后还能直接回看这一场
    savePrefs({ fscLastDir: FSC.dir })
  }
  const dirEl = document.getElementById('fsc-dir')
  if (dirEl) {
    dirEl.textContent = FSC.dir ? FSC.dir.split(/[\\/]/).filter(Boolean).pop() : '未在录制'
    dirEl.title = FSC.dir || ''
  }
  if (!FSC.dir) {
    FSC.clips = []
    fscRenderList()
    fscRenderTrim()
    return
  }
  let res = null
  try {
    res = await window.pr.recListClips(FSC.dir)
  } catch (err) {
    res = { ok: false, error: String((err && err.message) || err), clips: [] }
  }
  FSC.clips = res && res.ok && Array.isArray(res.clips) ? res.clips : []
  if (res && res.ok === false) {
    // 记住的那一场已经被删/移走了：清掉它，再退回"最近一场有片段"的目录
    if (/不存在/.test(String(res.error || ''))) {
      FSC.lastDir = ''
      savePrefs({ fscLastDir: '' })
      let last = null
      try {
        last = await window.pr.recLastClipsDir()
      } catch {}
      if (last && last.ok && last.dir && last.dir !== FSC.dir) {
        FSC.dir = last.dir
        FSC.lastDir = last.dir
        savePrefs({ fscLastDir: last.dir })
        const r2 = await window.pr.recListClips(last.dir).catch(() => null)
        FSC.clips = r2 && r2.ok && Array.isArray(r2.clips) ? r2.clips : []
      } else {
        fscSetStatus(String(res.error || '目录不存在'), 'warn')
      }
    } else {
      fscSetStatus(res.error || '读目录失败', 'warn')
    }
    const d2 = document.getElementById('fsc-dir')
    if (d2) {
      d2.textContent = FSC.dir ? FSC.dir.split(/[\\/]/).filter(Boolean).pop() : '未在录制'
      d2.title = FSC.dir || ''
    }
  }
  fscRenderList()
  const keep = FSC.clips.some((c) => c.path === FSC.selPath)
  if (!keep) {
    // 自动选最新的那个（刚截完就能立刻看/修）
    const newest = FSC.clips[FSC.clips.length - 1]
    if (newest && (autoPick || !FSC.selPath)) fscSelect(newest.path)
  }
}

/**
 * 把"当前选区"写出去：
 *  - overwrite=false → 另存一个新片段（`…_精修<Ns>.mp4`，原片段不动）
 *  - overwrite=true  → 裁完之后**直接替换掉这个片段本身**（覆盖不可撤销，先确认一次）
 */
/**
 * 删掉小窗里的某个精彩片段（真的从磁盘删文件，不可撤销）。
 * 删完把这一格从列表里拿掉、释放它的解码器，并重新扫一遍目录。
 */
function fscDeleteClip(path) {
  const p = String(path || '')
  if (!p) return
  const name = p.split(/[\\/]/).pop()
  const hit = FSC.clips.find((c) => c.path === p)
  const sizeTxt = hit && hit.size ? `（${(hit.size / 1024 / 1024).toFixed(1)} MB）` : ''
  if (!window.confirm(`删掉这个精彩片段？\n\n${name}${sizeTxt}\n\n文件会从磁盘上删除，不可撤销。`)) return
  fscSetStatus(`正在删除 ${name}…`)
  Promise.resolve(window.pr.recDeleteFile(p))
    .then((res) => {
      if (!res || !res.ok) {
        fscSetStatus('删除失败：' + ((res && res.error) || '未知原因'), 'warn')
        return
      }
      // 释放这一格的播放器与状态
      const v = FSC.tileVideos.get(p)
      if (v) {
        try {
          v.pause()
          v.removeAttribute('src')
          v.load()
        } catch {}
      }
      FSC.tileVideos.delete(p)
      FSC.tileStates.delete(p)
      FSC.clips = FSC.clips.filter((c) => c.path !== p)
      if (FSC.selPath === p) FSC.selPath = ''
      if (FSC.file === p) FSC.file = ''
      fscRenderList()
      fscRenderTrim()
      fscSyncFab()
      fscSetStatus(`已删除 ${name}`, 'ok')
      // 目录里可能还有别的片段 / 也可能整个目录空了，重新扫一遍
      fscRefresh({ autoPick: false }).catch(() => {})
    })
    .catch((err) => fscSetStatus('删除失败：' + ((err && err.message) || err), 'warn'))
}

/**
 * 截到一个精彩片段之后，小窗要怎么反应（2026-11-16 修）：
 * 以前只在**全屏**里才刷小窗，普通窗口下截完小窗里啥也不变——看着像"没截出来"。
 * 现在：
 *  - 小窗开着：只在同一场目录下追加这一格（别的片段的选区/画面不动），目录对不上就整体重扫；
 *  - 小窗关着而且人在观看/监控页：自动弹出来并选中这一段；
 *  - 人在剪辑页：不弹小窗（那一页有自己的文件列表和片段列表）。
 */
function fscOnClipSaved(full, dir) {
  const p = String(full || '')
  if (!p) return
  if (typeof fscShow !== 'function') return
  const sameDir = !FSC.dir || String(FSC.dir).toLowerCase() === String(dir || '').toLowerCase()
  if (FSC.open) {
    if (sameDir) fscRefreshOne(p).catch((e) => console.warn('[fsc] refresh failed', e))
    else fscRefresh({ autoPick: true }).catch((e) => console.warn('[fsc] refresh failed', e))
    return
  }
  // 小窗没开：观看/监控页自动弹出来；剪辑页不打扰
  const viewEdit = document.getElementById('view-edit')
  const onEdit = Boolean(viewEdit && !viewEdit.classList.contains('hidden'))
  if (!onEdit) {
    if (dir) FSC.lastDir = dir
    fscShow(true)
  }
}

function fscSave(overwrite = false, path = '') {
  const t = path ? fscTargetByPath(path) : fscTarget()
  if (!t) {
    fscSetStatus('先点一个片段选中它', 'warn')
    return
  }
  if (FSC.busy) return
  const st = t.st
  const span = st.outSec - st.inSec
  if (!(span > 0.2)) {
    fscSetStatus('选区太短了：把左右两端拉开一点', 'warn')
    return
  }
  if (overwrite) {
    const ok = window.confirm(
      `用当前选区（${st.inSec.toFixed(1)}s – ${st.outSec.toFixed(1)}s，共 ${span.toFixed(1)}s）覆盖原文件？\n\n` +
        `${String(t.path).split(/[\\/]/).pop()}\n\n原始画面会被裁掉的这段替换，不可撤销。`
    )
    if (!ok) {
      fscSetStatus('已取消覆盖')
      return
    }
  }
  const btn = document.getElementById(overwrite ? 'fsc-over' : 'fsc-save')
  const oldLabel = btn ? btn.textContent : ''
  FSC.busy = true
  if (btn) {
    btn.disabled = true
    btn.textContent = overwrite ? '覆盖中…' : '另存中…'
  }
  const srcBase = String(t.path).split(/[\\/]/).pop().replace(/\.[^.]+$/, '')
  Promise.resolve(
    window.pr.recClipRange({
      file: t.path,
      startSec: st.inSec,
      endSec: st.outSec,
      name: srcBase,
      overwrite: overwrite === true
    })
  )
    .then((res) => {
      if (!res || !res.ok) {
        fscSetStatus((overwrite ? '覆盖失败：' : '另存失败：') + ((res && res.error) || '未知原因'), 'warn')
        return
      }
      const name = String(res.out || '').split(/[\\/]/).pop()
      const secs = Number(res.seconds || span).toFixed(1)
      if (overwrite) {
        statusEl.textContent = `已覆盖原文件：${name}（现在 ${secs}s）`
        statusEl.className = 'ok'
        statusEl.title = String(res.out || '')
        fscSetStatus(`已覆盖 ${name}（现在 ${secs}s）`, 'ok')
        // 只重建被覆盖的这一格，别的片段的选区/播放都不动
        return fscRefreshOne(res.out).then(() => fscSelect(res.out))
      }
      statusEl.textContent = `已另存精修片段：${name}（${secs}s）`
      statusEl.className = 'ok'
      statusEl.title = String(res.out || '')
      fscSetStatus(`已另存 ${name}（${secs}s）`, 'ok')
      return fscRefreshOne(res.out).then(() => {
        if (res.out) {
          const hit = FSC.clips.find((c) => c.path === res.out)
          if (hit) fscSelect(hit.path)
        }
      })
    })
    .catch((err) => fscSetStatus((overwrite ? '覆盖失败：' : '另存失败：') + ((err && err.message) || err), 'warn'))
    .finally(() => {
      FSC.busy = false
      if (btn) {
        btn.disabled = false
        btn.textContent = oldLabel
      }
    })
}

function fscWire() {
  FSC.el = document.getElementById('fsc')
  FSC.fab = document.getElementById('fsc-fab')
  FSC.listEl = document.getElementById('fsc-list')
  if (!FSC.el || !FSC.listEl) return
  fscLoadPrefs()
  fscApplyPos()
  fscApplySound()
  const setIn = document.getElementById('fsc-setin')
  if (setIn) {
    setIn.addEventListener('click', () => {
      const t = fscTarget()
      if (!t) return fscSetStatus('先点一个瓦片选中它', 'warn')
      const cur = t.video ? Number(t.video.currentTime) || 0 : 0
      t.st.inSec = Math.max(0, Math.min(cur, t.st.outSec - 0.2))
      fscRenderTrim()
      fscSetStatus(`左端 = 播放点 ${t.st.inSec.toFixed(1)}s`)
    })
  }
  const setOut = document.getElementById('fsc-setout')
  if (setOut) {
    setOut.addEventListener('click', () => {
      const t = fscTarget()
      if (!t) return fscSetStatus('先点一个瓦片选中它', 'warn')
      const cur = t.video ? Number(t.video.currentTime) || 0 : 0
      t.st.outSec = Math.min(t.st.dur || cur, Math.max(cur, t.st.inSec + 0.2))
      fscRenderTrim()
      fscSetStatus(`右端 = 播放点 ${t.st.outSec.toFixed(1)}s`)
    })
  }
  const reset = document.getElementById('fsc-reset')
  if (reset) {
    reset.addEventListener('click', () => {
      const t = fscTarget()
      if (!t) return
      t.st.inSec = 0
      t.st.outSec = t.st.dur
      fscRenderTrim()
      fscSetStatus('已恢复整段')
    })
  }
  const save = document.getElementById('fsc-save')
  if (save) save.addEventListener('click', () => fscSave(false))
  const over = document.getElementById('fsc-over')
  if (over) over.addEventListener('click', () => fscSave(true))
  const refresh = document.getElementById('fsc-refresh')
  if (refresh) refresh.addEventListener('click', () => fscRefresh({ autoPick: false }).catch((e) => console.warn('[fsc] refresh failed', e)))
  const posBtn = document.getElementById('fsc-pos')
  if (posBtn) {
    posBtn.addEventListener('click', () => {
      FSC.pos = FSC.pos === 'right' ? 'bottom' : 'right'
      savePrefs({ fscPos: FSC.pos })
      fscApplyPos()
    })
  }
  const soundBtn = document.getElementById('fsc-sound')
  if (soundBtn) {
    soundBtn.addEventListener('click', () => {
      FSC.sound = !FSC.sound
      savePrefs({ fscSound: FSC.sound })
      fscApplySound()
      fscSetStatus(FSC.sound ? '小窗播放：有声音' : '小窗播放：静音')
    })
  }
  const close = document.getElementById('fsc-close')
  if (close) close.addEventListener('click', () => fscShow(false))
  if (FSC.fab) FSC.fab.addEventListener('click', () => fscShow(!FSC.open))

  /**
   * 小窗快捷键（小窗打开时生效，不抢输入框的键）：
   *   [ 或 1 → 用当前播放点当**起点**
   *   ] 或 2 → 用当前播放点当**终点**
   *   空格   → 播放 / 暂停选中的那个片段（列表模式下就是上面那台播放器）
   * 带 Ctrl/Shift/Alt 的组合键不拦（Ctrl+Shift+1…6 是"截精彩片段"的热键）。
   */
  document.addEventListener(
    'keydown',
    (e) => {
      if (!FSC.open) return
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return
      const el = e.target
      const tag = String((el && el.tagName) || '').toUpperCase()
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el && el.isContentEditable)) return
      const k = e.key
      // 空格：播放 / 暂停（哪怕焦点在某个按钮上，也不让它当成"点按钮"）
      if (k === ' ' || k === 'Spacebar' || (e.code === 'Space' && k !== ' ')) {
        e.preventDefault()
        e.stopPropagation()
        fscTogglePlaySelected()
        return
      }
      if (k !== '[' && k !== ']' && k !== '1' && k !== '2') return
      if (!fscTarget()) return
      e.preventDefault()
      e.stopPropagation()
      fscSetEdge(k === '[' || k === '1' ? 'in' : 'out')
    },
    true
  )

  fscSyncFab()
  // 主进程转来的 [ / ]（焦点在瓦片页面里时渲染层收不到 keydown，只能走这条）
  if (window.pr.onClipsKey) {
    window.pr.onClipsKey((key) => {
      if (!FSC.open || !document.body.classList.contains('fs')) return
      if (!fscTarget()) return
      fscSetEdge(key === '[' ? 'in' : 'out')
    })
  }
  // 启动时先问一次"最近一场有精彩片段的目录"：这样他一进全屏就能看到入口，
  // 不用先开一次录制（猜不到目录也没关系，下一次截片段就会补上）
  if (!FSC.lastDir) {
    Promise.resolve(window.pr.recLastClipsDir())
      .then((r) => {
        if (r && r.ok && r.dir && !FSC.lastDir) {
          FSC.lastDir = r.dir
          savePrefs({ fscLastDir: r.dir })
          fscSyncFab()
        }
      })
      .catch(() => {})
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
  window.pr.onRecordingHotkey(({ action, point, seconds }) => {
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

    // Ctrl+Shift+1..6：把正在录的那一路「最近 N 秒」存成精彩片段
    if (action === 'replay') {
      const uid0 = tileAtPoint(point) || focusUid || (tiles.size === 1 ? [...tiles.keys()][0] : null)
      snapshotHighlight(uid0, Number(seconds) || 10)
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
  // 启动时（恢复完房间/本地文件之后）先把顶栏按钮状态按实际情况摆一次：
  // 之前只有录制状态变化才刷新，纯看本地视频时「⟲ 精彩」会一直藏着。
  renderRecUi()
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
    const rooms = [...tiles.values()]
      .filter((t) => !t.camera && !t.studio && !t.stage)
      .map((t) => ({ url: t.url, muted: t.muted, local: t.local ? t.path : undefined, name: t.local ? t.fileName : undefined }))
    Promise.resolve(window.pr.saveRooms(rooms)).catch(() => {})
    syncTileGuests()
  }, 350)
}

/* ------------------------------ 交互 ------------------------------ */

/**
 * 先把输入交给主进程统一解析（跟「监控」页用的是同一个解析器）：
 * 房间号 / live 链接 / 分享短链 / 虎牙房间都认，短链会跟一次跳转拿到真实房间地址；
 * 主页、视频页、随便一个网址在「监控」页会被拒 —— 但**观看页这里带 allowPage**，
 * 认不出直播间就把它当"普通网页瓦片"（优酷/B站视频页这类）收下，录制走屏幕录制。
 */
async function resolveRoomForWatch(raw) {
  try {
    const res = await window.pr.resolveRoom(raw, { allowPage: true })
    if (res && res.ok && res.url) return { ok: true, url: res.url, roomId: res.roomId || '', site: res.site || '' }
    return { ok: false, error: (res && res.error) || '无法识别的地址' }
  } catch (err) {
    return { ok: false, error: '解析失败：' + ((err && err.message) || err) }
  }
}

formEl.addEventListener('submit', async (e) => {  e.preventDefault()
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
    // 别站网页（优酷/B站这类）：没有直录流，录制只能走屏幕录制，先说清楚
    if (res.site === 'other') {
      statusEl.textContent = '已开成网页瓦片：这类站点没有直录流，点「● 录制」会走屏幕录制（瓦片放大一点画质更好）'
      statusEl.className = 'warn'
    }
  }
})

/* ------------------------------ 本地音视频 ------------------------------ */

const openLocalBtn = document.getElementById('btn-open-local')
if (openLocalBtn) {
  openLocalBtn.addEventListener('click', async () => {
    let res
    try {
      res = await window.pr.pickLocalFiles()
    } catch (err) {
      statusEl.textContent = '打开文件失败：' + ((err && err.message) || err)
      statusEl.className = 'err'
      return
    }
    if (!res || !res.ok) {
      if (res && res.error) {
        statusEl.textContent = '打开文件失败：' + res.error
        statusEl.className = 'err'
      }
      return
    }
    let added = 0
    for (const f of res.files || []) {
      if (addLocalTile(f.path, { name: f.name })) added += 1
    }
    if (added) {
      statusEl.textContent = `已打开 ${added} 个本地文件（顶栏 ⤢ 可以放大，右键顶栏有音量/画质入口）`
      statusEl.className = 'ok'
    }
  })
}

/* ------------------------------ 摄像头 ------------------------------ */

const camBtn = document.getElementById('btn-camera')
if (camBtn) {
  camBtn.addEventListener('click', async (e) => {
    e.stopPropagation()
    const r = e.currentTarget.getBoundingClientRect()
    await openCameraMenu(r.left, r.bottom + 4)
  })
}

/* ---------------- 登录帐号（抖音 / 虎牙 / 斗鱼 合在一个菜单里） ---------------- */

/** 支持的平台（顺序就是菜单里的顺序） */
const LOGIN_PLATFORMS = [
  { key: 'douyin', name: '抖音', login: '扫码登录抖音', again: '换号 / 重新登录抖音' },
  { key: 'huya', name: '虎牙', login: '扫码登录虎牙（登录后能到蓝光）', again: '换号 / 重新登录虎牙' },
  { key: 'douyu', name: '斗鱼', login: '扫码登录斗鱼', again: '换号 / 重新登录斗鱼' }
]

/** 开登录窗；各平台都走同一个共享 partition，扫码一次所有瓦片共用 */
function openLoginFor(platform) {
  const p = LOGIN_PLATFORMS.find((x) => x.key === platform) || { name: platform }
  Promise.resolve(window.pr.openLogin(platform))
    .then((res) => {
      if (statusEl) {
        // 主进程还不认识这个平台（典型：程序没完全重启，主进程还是旧版）→ 说清楚，别让人以为串台
        if (res && res.ok === false) {
          statusEl.textContent = `打不开「${p.name}」登录：${res.error || '主进程不认识这个平台'}`
          statusEl.className = 'warn'
          return
        }
        statusEl.textContent =
          platform === 'huya'
            ? '已打开虎牙登录窗口：在窗口里点「登录」扫码，登录完成后关掉它'
            : platform === 'douyu'
              ? '已打开斗鱼登录窗口：在窗口里点登录扫码，登录完成后关掉它'
              : '已打开抖音登录窗口：扫码登录后，所有房间共用这一个登录态'
        statusEl.className = ''
      }
    })
    .catch((err) => {
      if (statusEl) {
        statusEl.textContent = `打开「${p.name}」登录失败：${(err && err.message) || err}`
        statusEl.className = 'warn'
      }
    })
}

/** 当前登录的账号（主进程读共享 partition 的 cookie）；启动时预取一次，菜单里直接用缓存 */
let loginStatusCache = null
let loginStatusAsked = false

async function refreshLoginStatus(force = false) {
  if (loginStatusAsked && !force) return loginStatusCache
  loginStatusAsked = true
  try {
    loginStatusCache = await window.pr.loginStatus()
  } catch (err) {
    loginStatusCache = null
  }
  return loginStatusCache
}

/** 菜单里那一行的文案：登没登 / 登的是谁（uid 只在像数字时才显示，抖音那个 uid_tt 是密文） */
function loginRowLabel(info) {
  if (!info) return '（状态读取失败，点一下打开登录窗）'
  if (!info.loggedIn) return '未登录 · 点击扫码'
  const nick = (info.nickname || '').trim()
  const rawUid = (info.uid || '').trim()
  const uid = /^\d{3,}$/.test(rawUid) ? rawUid : ''
  if (nick && uid) return `已登录：${nick}（UID ${uid}）`
  if (nick) return `已登录：${nick}`
  if (uid) return `已登录（UID ${uid}）`
  return '已登录'
}

/** 打开菜单前先拿一份"快"状态（只读 cookie，几毫秒），避免显示上一个账号 */
async function openLoginMenu(x, y) {
  let st = loginStatusCache
  try {
    st = await window.pr.loginStatus({ fast: true })
    loginStatusCache = st
  } catch {}
  const items = []
  for (const p of LOGIN_PLATFORMS) {
    const info = st && st[p.key]
    items.push({ head: `${p.name} · ${loginRowLabel(info)}` })
    items.push({
      label: info && info.loggedIn ? p.again : p.login,
      action: () => openLoginFor(p.key)
    })
    items.push({ sep: true })
  }
  items.push({
    label: '↻ 刷新登录状态',
    sub: true,
    action: () => {
      refreshLoginStatus(true).then(() => openLoginMenu(x, y))
    }
  })
  showPopup(x, y, items, '登录帐号')
}

const loginMenuBtn = document.getElementById('btn-login-menu')
if (loginMenuBtn) {
  loginMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    const r = e.currentTarget.getBoundingClientRect()
    openLoginMenu(r.left, r.bottom + 4)
    // 后台再问一次完整状态（含昵称接口），下次打开菜单就能显示昵称
    refreshLoginStatus(true).catch(() => {})
  })
}

// 启动后预取一次登录账号（菜单点开就有内容，不用等）
setTimeout(() => {
  refreshLoginStatus(true).catch(() => {})
}, 2500)

// 登录窗关掉后立刻重读一次：扫码登录完关窗，菜单里马上就能看到新账号
if (window.pr && typeof window.pr.onLoginClosed === 'function') {
  window.pr.onLoginClosed(() => {
    refreshLoginStatus(true).catch(() => {})
  })
}

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
  // 「直播视频选项」一个按钮管四件事，状态写进 title，菜单里打勾
  const viewBtn = document.getElementById('btn-view-options')
  if (viewBtn) {
    const on = pure || showDanmu
    viewBtn.classList.toggle('on', on)
    viewBtn.title =
      `直播视频选项\n只看画面：${pure ? '开' : '关'} ｜ 弹幕面板：${showDanmu ? '开' : '关'} ｜ 礼物：${showGift ? '开' : '关'}` +
      `\n弹幕面板：${danmuLines} 行 / ${danmuFont}px / ${(DANMU_POS.find((p) => p.key === danmuPos) || {}).label || '左下'}`
  }
  const qSel = document.getElementById('quality-select')
  // 「不干预」的 value 是空字符串，也要能回填
  if (qSel && typeof quality === 'string') qSel.value = quality
}

/* ---------------- 直播视频选项（只看画面 / 弹幕面板 / 礼物 / 弹幕设置） ---------------- */

function setPure(v) {
  pure = Boolean(v)
  savePrefs({ pure })
  // 关掉时重新加载，把被隐藏的页面恢复原样
  for (const [uid] of tiles) {
    if (pure) pokeGuest(uid)
    else reloadRoom(uid)
  }
  applyViewToggleUi()
}

function setDanmu(v) {
  showDanmu = Boolean(v)
  savePrefs({ danmu: showDanmu })
  for (const [uid] of tiles) {
    if (!showDanmu) renderDanmu(uid, [])
    else pokeGuest(uid)
  }
  applyViewToggleUi()
}

function setGift(v) {
  showGift = Boolean(v)
  savePrefs({ gift: showGift })
  for (const uid of tiles.keys()) pokeGuest(uid)
  applyViewToggleUi()
}

function openViewOptionsMenu(x, y) {
  const items = [
    {
      label: `只看画面（纯净模式）：${pure ? '开' : '关'}`,
      checked: pure,
      action: () => setPure(!pure)
    },
    {
      label: `弹幕面板：${showDanmu ? '开' : '关'}`,
      checked: showDanmu,
      action: () => setDanmu(!showDanmu)
    },
    {
      label: `弹幕里显示礼物：${showGift ? '开' : '关'}`,
      checked: showGift,
      action: () => setGift(!showGift)
    },
    { sep: true },
    {
      label: `弹幕面板设置…（${danmuLines} 行 / ${danmuFont}px / ${(DANMU_POS.find((p) => p.key === danmuPos) || {}).label || '左下'}）`,
      sub: true,
      action: () => openDanmuMenu(x, y)
    }
  ]
  showPopup(x, y, items, '直播视频选项')
}

const viewOptionsBtn = document.getElementById('btn-view-options')
if (viewOptionsBtn) {
  viewOptionsBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    const r = e.currentTarget.getBoundingClientRect()
    openViewOptionsMenu(r.left, r.bottom + 4)
  })
}

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
  applyViewToggleUi()
}

function setDanmuFont(n) {
  danmuFont = n
  savePrefs({ danmuFont })
  applyDanmuStyle()
  applyViewToggleUi()
}

function setDanmuPos(key) {
  danmuPos = key
  savePrefs({ danmuPos })
  applyDanmuStyle()
  applyViewToggleUi()
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

/* ------------------------------ 关于（一个页签，和观看/监控/剪辑/调试同级） ------------------------------ */

const aboutVerEl = document.getElementById('about-ver')
const aboutRuntimeEl = document.getElementById('about-runtime')
/** 运行信息只拉一次（ffmpeg -version 是一次真进程，没必要每次切页都跑） */
let aboutInfo = null

function fmtAboutRuntime(info) {
  if (!info || !info.ok) return `版本 v${info && info.version ? info.version : '—'}（运行信息读取失败）`
  // ffmpeg -version 第一行形如 "ffmpeg version 8.1.1-essentials_build-www.gyan.dev ..."，只取数字部分
  let ff = ''
  if (info.ffmpegVersion) {
    const m = /\d+\.\d+(?:\.\d+)?/.exec(info.ffmpegVersion)
    ff = m ? m[0] : String(info.ffmpegVersion).slice(0, 24)
  }
  const parts = [
    `ParallelRoom v${info.version}`,
    `Electron ${info.electron}`,
    `Chromium ${String(info.chrome || '').split('.')[0]}`,
    `Node ${info.node}`,
    ff ? `ffmpeg ${ff}` : 'ffmpeg 未就绪',
    info.packaged ? '安装版 / 绿色版' : '开发态'
  ]
  const lines = [parts.join(' · ')]
  if (info.ffmpegPath) lines.push(`ffmpeg：<code>${info.ffmpegPath}</code>`)
  if (info.dataDir) lines.push(`数据目录：<code>${info.dataDir}</code>`)
  if (info.outDir) lines.push(`录制目录：<code>${info.outDir}</code>`)
  return lines.join('<br>')
}

/**
 * 刷新关于页的运行信息。
 * force=true 时重新问一次主进程（「↻ 刷新信息」按钮用，比如刚改了录制目录）；
 * 否则只在第一次进来时读，之后切回来直接用缓存。
 */
async function refreshAbout(force = false) {
  if (!aboutInfo || force) {
    try {
      aboutInfo = await window.pr.appInfo()
    } catch (err) {
      aboutInfo = { ok: false }
    }
  }
  if (aboutVerEl) aboutVerEl.textContent = aboutInfo && aboutInfo.version ? `v${aboutInfo.version}` : 'v—'
  if (aboutRuntimeEl) aboutRuntimeEl.innerHTML = fmtAboutRuntime(aboutInfo)
}

{
  const aboutRefreshBtn = document.getElementById('about-refresh')
  if (aboutRefreshBtn) {
    aboutRefreshBtn.addEventListener('click', () => {
      refreshAbout(true).catch(() => {})
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
const editApplyBtn = document.getElementById('edit-apply-wm')
const wmHintEl = document.getElementById('wm-hint')
/** 右栏「水印」页签标题行那行简短的当前水印摘要 */
const wmSummaryEl = document.getElementById('wm-summary')

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
  // 按钮旁边只放最短的一句：类型 · 位置/漂移
  const POS_LABEL = { tl: '左上', tc: '上中', tr: '右上', ml: '左中', mc: '居中', mr: '右中', bl: '左下', bc: '下中', br: '右下' }
  const shortType = w.mode === 'both' ? '文字+图片' : w.mode === 'image' ? '图片' : '文字'
  const shortWhere = w.motion === 'static' ? `${POS_LABEL[w.pos] || w.pos}固定` : `漂移${w.speed}px/s`
  if (wmSummaryEl) wmSummaryEl.textContent = `${shortType} · ${shortWhere}`
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

/* -------------------- 水印设置：现在在右栏「水印」页签里 --------------------
 * 以前它是左栏文件列表下面的一个浮动面板；参数和 id 一个没改，只是把入口从
 * 「💧 水印设置」按钮换成了右栏第三个页签。
 */
function wmPanelIsOpen() {
  const pane = document.getElementById('rpane-wm')
  return Boolean(pane && !pane.classList.contains('hidden'))
}

function openWmPanel() {
  switchRightPane('wm')
}

function closeWmPanel() {
  // 页签形式下没有"关面板"这回事：切到别的页签本来就把右栏内容换掉了。
  // 保留这个空函数，是因为 switchTab 里还在调（以前用来收浮动面板）。
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
  editSelInfoEl.textContent = `已选 ${n}`
  // 「合并选中」已经去掉了（合并统一走右栏「图片片头 · 视频合并」），左边只剩加水印这一个动作
  if (editApplyBtn) {
    editApplyBtn.disabled = n < 1
    editApplyBtn.textContent = n >= 1 ? `给勾选的文件加水印（${n}）` : '给勾选的文件加水印'
  }
  const selectable = editFiles.filter((f) => !f.pending)
  editSelAllEl.checked = selectable.length > 0 && selectable.every((f) => editSelected.has(f.path))
  editSelAllEl.indeterminate = n > 0 && !editSelAllEl.checked
  // 行首的 #1 #2 顺序标记要在勾选瞬间就变（以前只在整表重绘时才更新，勾了看不到顺序）
  const orderMap = new Map()
  editFiles
    .filter((f) => editSelected.has(f.path) && !f.pending)
    .sort((a, b) => a.mtime - b.mtime || String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'))
    .forEach((f, i) => orderMap.set(f.path, i + 1))
  for (const row of editFilesEl.querySelectorAll('.edit-row')) {
    const cb = row.querySelector('input[data-path]')
    if (!cb) continue
    const no = orderMap.get(cb.dataset.path)
    const tagEl = row.querySelector('.er-order')
    if (!no) {
      if (tagEl) tagEl.remove()
      continue
    }
    if (tagEl) {
      tagEl.textContent = `#${no}`
      tagEl.title = `合并后的第 ${no} 段`
    } else {
      const fresh = document.createElement('span')
      fresh.className = 'er-order'
      fresh.textContent = `#${no}`
      fresh.title = `合并后的第 ${no} 段`
      cb.after(fresh)
    }
  }
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
  const wmTaskId = taskBegin(
    'watermark',
    `加水印 · ${files.length} 个文件`,
    files.map((f) => String(f).split(/[\\/]/).pop()).join(' + ')
  )
  try {
    const res = await window.pr.recApplyWatermark({ files, name, watermark: wm })
    if (res && res.ok) {
      editStatusEl.textContent = `水印完成：${(res.outputs || []).map((p) => p.split(/[\\/]/).pop()).join('、')}`
      taskFinish(wmTaskId, {
        ok: true,
        out: (res.outputs || [])[0] || '',
        note: `${(res.outputs || []).length} 个文件`
      })
      editSelected.clear()
      await refreshEditFiles({ force: true })
    } else {
      editStatusEl.textContent = (res && res.error) || '加水印失败'
      taskFinish(wmTaskId, { ok: false, error: (res && res.error) || '加水印失败' })
    }
  } catch (err) {
    editStatusEl.textContent = '加水印失败：' + (err && err.message)
    taskFinish(wmTaskId, { ok: false, error: (err && err.message) || String(err) })
  }
  updateEditSelectionUi()
})

/* -------------------- 任务面板（拼接 / 合并 / 加水印） --------------------
 * 剪辑页的活都是几分钟级别的后台任务，原来只有一行状态文字，切换页面/关掉面板就看不到进度了。
 * 现在每个任务都有：类型、标题、进度、耗时、产物路径，放在一个独立的面板里随时能翻。
 */
const tasksOpenBtn = document.getElementById('tasks-open')
const taskPanelEl = document.getElementById('task-panel')
const taskListEl = document.getElementById('task-list')
const taskHintEl = document.getElementById('task-hint')

/**
 * @type {Map<string, {id:string,kind:'mosaic'|'merge'|'watermark',title:string,
 *   state:'run'|'done'|'fail',pct:number|null,outTime:number,total:number,speed:string,
 *   startAt:number,endAt:number,out:string,error:string,note:string}>}
 */
const tasks = new Map()
let taskSeq = 0
let taskRenderTimer = null

function taskBegin(kind, title, note = '') {
  taskSeq += 1
  const id = `t${taskSeq}`
  tasks.set(id, {
    id,
    kind,
    title,
    state: 'run',
    pct: 0,
    outTime: 0,
    total: 0,
    speed: '',
    startAt: Date.now(),
    endAt: 0,
    out: '',
    error: '',
    note
  })
  taskScheduleRender()
  return id
}

function taskUpdate(id, patch) {
  const t = tasks.get(id)
  if (!t) return
  Object.assign(t, patch)
  taskScheduleRender()
}

function taskFinish(id, { ok, out, error, note } = {}) {
  const t = tasks.get(id)
  if (!t) return
  t.state = ok ? 'done' : 'fail'
  t.endAt = Date.now()
  if (out) t.out = out
  if (error) t.error = String(error)
  if (note) t.note = note
  if (ok) t.pct = 100
  taskScheduleRender()
}

function taskScheduleRender() {
  if (taskRenderTimer) return
  taskRenderTimer = setTimeout(() => {
    taskRenderTimer = null
    renderTasks()
  }, 120)
}

function taskKindLabel(kind) {
  return kind === 'mosaic' ? '拼接' : kind === 'merge' ? '合并' : kind === 'watermark' ? '水印' : kind === 'head' ? '片头' : kind
}

function taskSecText(ms) {
  const s = Math.max(0, ms / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}分${Math.round(s % 60)}秒` : `${s.toFixed(1)}秒`
}

function renderTasks() {
  if (!taskListEl) return
  const list = [...tasks.values()].sort((a, b) => b.startAt - a.startAt)
  const running = list.filter((t) => t.state === 'run').length
  if (tasksOpenBtn) {
    tasksOpenBtn.textContent = running ? `⏳ 任务 ${running}` : '⏳ 任务'
    tasksOpenBtn.classList.toggle('on', running > 0)
  }
  // 顶部工具栏也有个角标，人在别的页签也能看到有活在跑
  const pill = document.getElementById('tasks-pill')
  if (pill) {
    pill.classList.toggle('hidden', running === 0)
    pill.textContent = `⏳ ${running} 个任务`
  }
  if (taskHintEl) {
    taskHintEl.textContent = running
      ? `${running} 个任务在跑；关掉这个面板不影响它们继续执行。`
      : '拼接 / 片头 / 合并 / 加水印都在这里排队执行；关掉这个面板也不影响它们继续跑。'
  }
  taskListEl.innerHTML = ''
  if (!list.length) {
    taskListEl.innerHTML = '<div class="task-empty">还没有任务。去「多窗口拼接」点导出，或者选文件点「合并选中 / 单独加水印」。</div>'
    return
  }
  for (const t of list) {
    const row = document.createElement('div')
    row.className = 'task-row'

    const top = document.createElement('div')
    top.className = 'task-top'
    const kind = document.createElement('span')
    kind.className = 'task-kind ' + t.kind
    kind.textContent = taskKindLabel(t.kind)
    const title = document.createElement('span')
    title.className = 'task-title'
    title.textContent = t.title
    title.title = t.note || t.title
    const state = document.createElement('span')
    const elapsed = (t.endAt || Date.now()) - t.startAt
    if (t.state === 'run') {
      state.className = 'task-state running'
      if (t.total > 0 && t.pct !== null) {
        state.textContent = `${Math.round(t.pct)}% · ${t.outTime.toFixed(1)}s/${t.total.toFixed(1)}s`
      } else {
        state.textContent = `进行中 · ${taskSecText(elapsed)}`
      }
    } else if (t.state === 'done') {
      state.className = 'task-state done'
      state.textContent = `完成 · ${taskSecText(elapsed)}`
    } else {
      state.className = 'task-state fail'
      state.textContent = '失败'
    }
    top.appendChild(kind)
    top.appendChild(title)
    top.appendChild(state)

    const bar = document.createElement('div')
    bar.className = 'task-bar' + (t.state === 'done' ? ' done' : t.state === 'fail' ? ' fail' : '')
    const fill = document.createElement('i')
    const pct = t.pct === null || !Number.isFinite(t.pct) ? 0 : Math.max(0, Math.min(100, t.pct))
    fill.style.width = `${t.state === 'fail' ? 100 : pct}%`
    bar.appendChild(fill)

    const foot = document.createElement('div')
    foot.className = 'task-foot'
    const outEl = document.createElement('span')
    outEl.className = 'task-out'
    outEl.textContent = t.error || t.out || t.note || ''
    outEl.title = t.error || t.out || t.note || ''
    foot.appendChild(outEl)
    if (t.state === 'done' && t.out) {
      const openBtn = document.createElement('button')
      openBtn.type = 'button'
      openBtn.className = 'ghost'
      openBtn.textContent = '打开所在文件夹'
      openBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        Promise.resolve(window.pr.recReveal(t.out)).catch(() => {})
      })
      foot.appendChild(openBtn)
    }
    if (t.state !== 'run' && t.speed) {
      const sp = document.createElement('span')
      sp.textContent = t.speed
      foot.appendChild(sp)
    }

    row.appendChild(top)
    row.appendChild(bar)
    if (outEl.textContent) row.appendChild(foot)
    taskListEl.appendChild(row)
  }
}

/* 面板开关（和「水印设置」同一套路子：贴着按钮弹、点外面/Esc/✕ 关） */
function taskPanelIsOpen() {
  return taskPanelEl && !taskPanelEl.classList.contains('hidden')
}

function onTaskPanelOutside(e) {
  if (!taskPanelIsOpen()) return
  if (taskPanelEl.contains(e.target)) return
  if (tasksOpenBtn && tasksOpenBtn.contains(e.target)) return
  closeTaskPanel()
}

function onTaskPanelKey(e) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    closeTaskPanel()
  }
}

function placeTaskPanel() {
  if (!taskPanelIsOpen() || !tasksOpenBtn) return
  const r = tasksOpenBtn.getBoundingClientRect()
  const w = taskPanelEl.offsetWidth || 560
  const h = taskPanelEl.offsetHeight || 320
  let left = r.right - w
  let top = r.bottom + 8
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8)
  left = Math.max(8, Math.min(window.innerWidth - w - 8, left))
  taskPanelEl.style.left = `${Math.round(left)}px`
  taskPanelEl.style.top = `${Math.round(top)}px`
}

function openTaskPanel() {
  if (!taskPanelEl) return
  renderTasks()
  taskPanelEl.classList.remove('hidden')
  placeTaskPanel()
  setTimeout(() => {
    document.addEventListener('pointerdown', onTaskPanelOutside, true)
    window.addEventListener('keydown', onTaskPanelKey, true)
    window.addEventListener('resize', placeTaskPanel)
  }, 0)
}

function closeTaskPanel() {
  if (!taskPanelIsOpen()) return
  taskPanelEl.classList.add('hidden')
  document.removeEventListener('pointerdown', onTaskPanelOutside, true)
  window.removeEventListener('keydown', onTaskPanelKey, true)
  window.removeEventListener('resize', placeTaskPanel)
}

if (tasksOpenBtn) {
  tasksOpenBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    if (taskPanelIsOpen()) closeTaskPanel()
    else openTaskPanel()
  })
}
{
  const closeBtn = document.getElementById('task-panel-close')
  if (closeBtn) closeBtn.addEventListener('click', () => closeTaskPanel())
  const clearBtn = document.getElementById('task-clear-done')
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      for (const [id, t] of [...tasks]) if (t.state !== 'run') tasks.delete(id)
      renderTasks()
    })
  }
  // 顶部角标：点一下跳到剪辑页并打开任务面板
  const pill = document.getElementById('tasks-pill')
  if (pill) {
    pill.addEventListener('click', () => {
      switchTab('edit')
      setTimeout(() => openTaskPanel(), 60)
    })
  }
}

/* -------------------- 剪辑页左右分栏：可拖动改宽度 -------------------- */
const EDIT_SPLIT_KEY = 'pr.editSplitPx'
const EDIT_LEFT_MIN = 240
const EDIT_RIGHT_MIN = 300
/** 当前左栏宽度（px，夹过边界的实际值）；0 = 用 CSS 默认比例 */
let editSplitPx = 0
/** 用户拖出来的目标宽度（未夹）——窗口变大小时用它重算，别被一次夹小就记住 */
let editSplitWant = 0

function editSplitParts() {
  const body = document.querySelector('.edit-body')
  const files = document.querySelector('.edit-files-pane')
  const splitter = document.getElementById('edit-splitter')
  return { body, files, splitter }
}

function applyEditSplitPx(px, fromUser) {
  const { body, files } = editSplitParts()
  if (!body || !files) return
  if (fromUser) editSplitWant = Math.max(EDIT_LEFT_MIN, Math.round(Number(px) || 0))
  if (!editSplitWant) {
    files.style.flex = ''
    editSplitPx = 0
    return
  }
  // 剪辑页还没显示时 clientWidth 是 0，这时候先不动，等切过去/改窗口大小时再算
  const avail = body.clientWidth - 2 * 10 - 8 - 10
  if (avail < EDIT_LEFT_MIN + EDIT_RIGHT_MIN) return
  const maxW = Math.max(EDIT_LEFT_MIN, avail - EDIT_RIGHT_MIN)
  const w = Math.round(Math.max(EDIT_LEFT_MIN, Math.min(maxW, editSplitWant)))
  editSplitPx = w
  files.style.flex = `0 0 ${w}px`
}

function resetEditSplit() {
  const { files } = editSplitParts()
  if (files) files.style.flex = ''
  editSplitPx = 0
  editSplitWant = 0
  try {
    localStorage.removeItem(EDIT_SPLIT_KEY)
  } catch {}
}

function wireEditSplitter() {
  const { body, files, splitter } = editSplitParts()
  if (!body || !files || !splitter) return
  // 恢复上次的宽度（首次进剪辑页/改窗口大小时再真正生效，见 applyEditSplitPx 里的 avail 判断）
  let saved = 0
  try {
    saved = Number(localStorage.getItem(EDIT_SPLIT_KEY)) || 0
  } catch {}
  if (saved) {
    editSplitWant = saved
    applyEditSplitPx(saved, false)
  }

  let dragging = false
  const onMove = (e) => {
    if (!dragging) return
    const r = body.getBoundingClientRect()
    applyEditSplitPx(e.clientX - r.left - 10, true)
  }
  const onUp = () => {
    if (!dragging) return
    dragging = false
    splitter.classList.remove('dragging')
    document.body.classList.remove('split-dragging')
    document.removeEventListener('pointermove', onMove, true)
    document.removeEventListener('pointerup', onUp, true)
    try {
      if (editSplitWant) localStorage.setItem(EDIT_SPLIT_KEY, String(editSplitWant))
    } catch {}
    // 画布按新宽度重新贴合
    try {
      moLayoutCellBars()
      moDrawFrame(moMaster)
    } catch {}
  }
  splitter.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    dragging = true
    splitter.classList.add('dragging')
    document.body.classList.add('split-dragging')
    document.addEventListener('pointermove', onMove, true)
    document.addEventListener('pointerup', onUp, true)
  })
  splitter.addEventListener('dblclick', () => {
    resetEditSplit()
    try {
      moLayoutCellBars()
      moDrawFrame(moMaster)
    } catch {}
  })
  window.addEventListener('resize', () => {
    // 窗口变大变小后用"目标宽度"重算
    if (editSplitWant) applyEditSplitPx(editSplitWant, false)
  })
}

/* -------------------- 右栏页签：多窗口拼接 / 图片片头 -------------------- */
const RIGHT_PANE_KEY = 'pr.editRightPane'
let editRightPane = 'mosaic'

function switchRightPane(name) {
  editRightPane = name === 'head' ? 'head' : name === 'wm' ? 'wm' : 'mosaic'
  for (const b of document.querySelectorAll('#edit-right-tabs .rtab')) {
    b.classList.toggle('active', b.dataset.rpane === editRightPane)
  }
  const mo = document.getElementById('rpane-mosaic')
  const head = document.getElementById('rpane-head')
  const wm = document.getElementById('rpane-wm')
  if (mo) mo.classList.toggle('hidden', editRightPane !== 'mosaic')
  if (head) head.classList.toggle('hidden', editRightPane !== 'head')
  if (wm) wm.classList.toggle('hidden', editRightPane !== 'wm')
  try {
    localStorage.setItem(RIGHT_PANE_KEY, editRightPane)
  } catch {}
  if (editRightPane === 'mosaic') {
    try {
      hpStop()
      hpCloseFs()
    } catch {}
    try {
      moLayoutCellBars()
      moDrawFrame(moMaster)
    } catch {}
  } else if (editRightPane === 'head') {
    refreshHeadUi()
    try {
      hpSyncCanvasSize()
      hpDraw(hpT)
    } catch {}
  } else {
    // 水印页：刷一下摘要和提示（元素 id 没变，原来的同步逻辑照旧）
    try {
      hpStop()
      hpCloseFs()
    } catch {}
    try {
      syncWmUiFromConfig()
      updateWmHint()
    } catch {}
  }
}

function wireRightTabs() {
  for (const b of document.querySelectorAll('#edit-right-tabs .rtab')) {
    b.addEventListener('click', () => switchRightPane(b.dataset.rpane))
  }
  let saved = 'mosaic'
  try {
    saved = localStorage.getItem(RIGHT_PANE_KEY) || 'mosaic'
  } catch {}
  switchRightPane(saved)
}

/* -------------------- 图片片头 · 视频合并 -------------------- */
let headImagePath = ''
let headBusy = false
let headTaskId = ''
let headBgmPath = ''
/** 片头图上叠的字（多条）：{ text, x, y, sizePct, color, opacity }，x/y 是相对画面的中心点 0..1 */
let headTexts = []
let headTextSel = -1
/** 要合并的片段：{ file, name, dur, start, end, cur, thumb } —— file 就是它自己那个视频 */
let hlSegs = []
let hlSelIdx = -1

function setHeadStatus(text, cls) {
  const el = document.getElementById('head-status')
  if (el) {
    el.textContent = text || ''
    el.className = 'modal-hint' + (cls ? ' ' + cls : '')
  }
  // 同一句话也写到「预览」按钮旁边：这块面板很长，上面的提示容易被忽略，看着像"点了没反应"
  const note = document.getElementById('head-prev-note')
  if (note) {
    note.textContent = text ? `◂ ${text}` : ''
    note.className = 'head-prev-note' + (cls ? ' ' + cls : '')
    note.title = text || ''
  }
}

function setHlStatus(text, cls) {
  const el = document.getElementById('head-hl-status')
  if (!el) return
  el.textContent = text || ''
  el.className = 'modal-hint' + (cls ? ' ' + cls : '')
}

/** 片头图片显示多少秒；0 = 不加片头 */
function headSeconds() {
  const el = document.getElementById('head-sec')
  const v = Number(el && el.value)
  return Number.isFinite(v) ? Math.min(60, Math.max(0, v)) : 2
}

function headBgmVolume() {
  const el = document.getElementById('head-bgm-vol')
  const v = Number(el && el.value)
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v / 100)) : 0.3
}

/* ---------- 片头图 / 背景音 的使用记录 ---------- */
const HEAD_RECENT_MAX = 12

function headRecent(kind) {
  const p = loadPrefs()
  const arr = kind === 'bgm' ? p.headBgmRecent : p.headImgRecent
  return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x) : []
}

/** 把一个文件记到"用过"列表最前面（同一个文件只留一条，最多 12 条） */
function rememberHeadFile(kind, path) {
  const p = String(path || '')
  if (!p) return
  const key = kind === 'bgm' ? 'headBgmRecent' : 'headImgRecent'
  const list = headRecent(kind).filter((x) => x !== p)
  list.unshift(p)
  savePrefs({ [key]: list.slice(0, HEAD_RECENT_MAX) })
}

function forgetHeadFile(kind, path) {
  const key = kind === 'bgm' ? 'headBgmRecent' : 'headImgRecent'
  savePrefs({ [key]: headRecent(kind).filter((x) => x !== path) })
}

/** 把"用过的文件"摆成菜单项；点一下直接换过去 */
function showHeadRecentMenu(kind, anchor) {
  const list = headRecent(kind)
  const isBgm = kind === 'bgm'
  const cur = isBgm ? headBgmPath : headImagePath
  const items = [{ head: isBgm ? '用过的背景音' : '用过的片头图' }]
  if (!list.length) {
    items.push({ label: '（还没有记录：选一次之后就会出现在这里）' })
  } else {
    for (const p of list) {
      const name = String(p).split(/[\\/]/).pop()
      items.push({
        label: (p === cur ? '✓ ' : '') + name,
        checked: p === cur,
        action: () => {
          if (isBgm) {
            headBgmPath = p
            // 从记录里换背景音：预览在播就立刻换成这一首
            hpSyncBgm()
          } else {
            headImagePath = p
            hpLoadImage(headImagePath).then(() => hpDraw(hpvT))
          }
          rememberHeadFile(kind, p)
          refreshHeadUi()
          hpSyncCanvasSize()
          hpDraw(hpvT)
          setHeadStatus(`${isBgm ? '背景音' : '片头图'}：${name}`)
        }
      })
    }
    items.push({ sep: true })
    if (cur) {
      items.push({
        label: '把当前的从记录里去掉',
        action: () => {
          forgetHeadFile(kind, cur)
          setHeadStatus('已从记录里去掉（文件本身没动）')
        }
      })
    }
    items.push({
      label: '清空全部记录',
      action: () => {
        savePrefs(isBgm ? { headBgmRecent: [] } : { headImgRecent: [] })
        setHeadStatus('记录已清空')
      }
    })
  }
  const r = anchor.getBoundingClientRect()
  showPopup(Math.round(r.left), Math.round(r.bottom + 4), items, isBgm ? '背景音记录' : '片头图记录')
}

/* ---------- 拖动进度条不闪：seek 串行化（预览 / 全屏细剪共用） ---------- */
/** 平滑 seek：上一帧还没解完就先记下来，等 seeked 再给下一帧（连续 input 不会堆积） */
function seekMediaLazy(v, t) {
  if (!v) return
  const dur = Number.isFinite(v.duration) ? v.duration : 0
  const lim = dur > 0 ? dur : Math.max(0, Number(t) || 0)
  const target = Math.max(0, Math.min(lim, Number(t) || 0))
  v.__want = target
  if (v.seeking) return
  try {
    v.currentTime = target
  } catch {}
}

/** 给视频挂"seeked 后补最后一次拖动位置"的链 */
function wireSeekChain(v, redraw) {
  if (!v || v.__seekWired) return
  v.__seekWired = true
  v.addEventListener('seeked', () => {
    const want = v.__want
    if (typeof want === 'number' && Math.abs((v.currentTime || 0) - want) > 0.06) {
      try {
        v.currentTime = want
      } catch {}
    } else {
      v.__want = null
    }
    if (typeof redraw === 'function') redraw()
  })
}

/* ---------- 合成预览：片头图 N 秒 → 各片段按列表顺序连着播 ---------- */
let hpvVideo = null
let hpvImg = null
let hpvImgPath = ''
let hpvLoadToken = 0
let hpvPlaying = false
let hpvT = 0
/** 兼容旧调用（switchRightPane 里的 hpDraw(hpT)） */
let hpT = 0
let hpvRaf = 0
let hpvT0 = 0
let hpBgm = null
/** 当前 hpBgm 对应的文件路径（换背景音时用来判断要不要重新建播放器） */
let hpBgmPath = ''

/** 预览画在哪个 canvas 上：全屏预览开着就画全屏那块，否则画面板里那块 */
function hpCanvas() {
  const fs = document.getElementById('hp-fs')
  if (fs && !fs.classList.contains('hidden')) {
    const c = document.getElementById('head-fs-canvas')
    if (c) return c
  }
  return document.getElementById('head-canvas')
}

/** 一个片段的实际区间（夹在原文件时长里） */
function hlSegPeriod(s) {
  const dur = Math.max(0, Number(s && s.dur) || 0)
  const a = Math.max(0, Math.min(dur || 1e9, Number(s && s.start) || 0))
  const bRaw = Number(s && s.end)
  const b = Math.max(a, Math.min(dur || bRaw || 0, Number.isFinite(bRaw) && bRaw > 0 ? bRaw : dur))
  return { start: a, end: b, dur: Math.max(0, b - a) }
}

/** 片头那一段多长（没选图 / 秒数为 0 → 0） */
function headImgDur() {
  return headImagePath && hpvImg && headSeconds() >= 0.2 ? headSeconds() : 0
}

/** 这一段参不参与合成（卡片左上角那个勾；默认都参与） */
function hlSegOn(s) {
  return !(s && s.off)
}

/** 这一段自己的原声音量（0–2，默认 1 = 100%） */
function hlSegVol(s) {
  const v = Number(s && s.vol)
  return Number.isFinite(v) ? Math.max(0, Math.min(2, v)) : 1
}

/** 改完某一格的音量：预览正在放这一格就立刻跟着变（HTML 只能放到 1.0，超出的部分导出时才生效） */
function applySegVolumeToPreview(s) {
  if (!s || !s.file) return
  const v = hpvVideo
  if (v && v.dataset.path === s.file) {
    try {
      v.volume = Math.max(0, Math.min(1, hlSegVol(s)))
    } catch {}
  }
}

/** 参与合成的片段（预览 / 导出都只用这些） */
function hlSegsOn() {
  return hlSegs.filter((s) => hlSegOn(s))
}

/** 预览 / 导出总时长 = 片头 + 参与的片段 */
function hpTotal() {
  let sum = headImgDur()
  for (const s of hlSegsOn()) sum += hlSegPeriod(s).dur
  return Math.round(sum * 1000) / 1000
}

/** 合成时间 t 落在哪个片段的第几秒（跳过不参与合成的段） */
function hpSegAt(t) {
  const imgDur = headImgDur()
  if (t < imgDur) return null
  let acc = imgDur
  for (let i = 0; i < hlSegs.length; i++) {
    const seg = hlSegs[i]
    if (!hlSegOn(seg)) continue
    const p = hlSegPeriod(seg)
    if (!(p.dur > 0)) continue
    if (t < acc + p.dur) return { segIdx: i, local: Math.min(p.end, p.start + (t - acc)) }
    acc += p.dur
  }
  return null
}

/**
 * 预览画布分辨率：跟着显示尺寸 × 像素比走（上限 2560 宽）——固定 720 在全屏里被拉大就是糊的。
 */
function hpSyncCanvasSize() {
  const c = hpCanvas()
  if (!c) return
  const host = c.parentElement
  let ratio = 16 / 9
  if (hpvVideo && hpvVideo.videoWidth && hpvVideo.videoHeight) ratio = hpvVideo.videoWidth / hpvVideo.videoHeight
  else if (hpvImg && hpvImg.naturalWidth && hpvImg.naturalHeight) ratio = hpvImg.naturalWidth / hpvImg.naturalHeight
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const cw = host ? host.clientWidth : 0
  let W = cw > 0 ? Math.round(cw * dpr) : 720
  W = Math.max(640, Math.min(2560, W))
  let H = Math.round(W / ratio)
  H = Math.max(2, Math.round((H / 2) * 2))
  if (c.width !== W || c.height !== H) {
    c.width = W
    c.height = H
  }
}

function hpSetTimeText(t) {
  const el = document.getElementById('head-prev-time')
  if (el) el.textContent = `${moFmt(t)} / ${moFmt(hpTotal())}`
  const seek = document.getElementById('head-prev-seek')
  if (seek && !seek.dataset.dragging) {
    const total = hpTotal()
    seek.value = String(total > 0 ? Math.round((t / total) * 1000) : 0)
  }
  // 全屏预览那条进度条 / 时间
  hpSyncFsTime(t)
  // 进度条上两段底色：片头 / 片段
  const total = hpTotal()
  const imgDur = headImgDur()
  const zh = document.getElementById('head-zone-head')
  const zs = document.getElementById('head-zone-hl')
  if (zh) {
    zh.style.left = '0%'
    zh.style.width = `${total > 0 ? (imgDur / total) * 100 : 0}%`
  }
  if (zs) {
    zs.style.left = `${total > 0 ? (imgDur / total) * 100 : 0}%`
    zs.style.width = `${total > 0 ? 100 - (imgDur / total) * 100 : 0}%`
  }
}

/** 本地图片 → data:URL（file:// 下 <img> 不能直接吃 prmedia:// 或 blob:，这个是最稳的路子） */
function hpLoadImage(path) {
  if (!path) {
    hpvImg = null
    hpvImgPath = ''
    return Promise.resolve(false)
  }
  if (hpvImgPath === path && hpvImg) return Promise.resolve(true)
  const token = ++hpvLoadToken
  hpvImgPath = path
  hpvImg = null
  return (async () => {
    try {
      const res = await fetch('prmedia://local/?p=' + encodeURIComponent(path))
      const buf = await res.arrayBuffer()
      const bytes = new Uint8Array(buf)
      let bin = ''
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
      }
      const ext = (path.split('.').pop() || 'png').toLowerCase()
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png'
      const img = new Image()
      await new Promise((resolve, reject) => {
        img.onload = resolve
        img.onerror = reject
        img.src = `data:${mime};base64,${btoa(bin)}`
      })
      if (token !== hpvLoadToken) return false
      hpvImg = img
      hpDraw(hpvT)
      return true
    } catch (err) {
      if (token === hpvLoadToken) hpvImg = null
      return false
    }
  })()
}

/** 预览用的那一个 <video>：换片段时只换 src，不留一堆解码器 */
function hpSegVideoEl() {
  if (hpvVideo) return hpvVideo
  const v = document.createElement('video')
  v.playsInline = true
  v.preload = 'auto'
  v.crossOrigin = 'anonymous'
  v.style.display = 'none'
  v.addEventListener('loadedmetadata', () => {
    hpSyncCanvasSize()
    hpDraw(hpvT)
  })
  v.addEventListener('seeked', () => {
    if (!hpvPlaying) hpDraw(hpvT)
  })
  wireSeekChain(v, () => {
    if (!hpvPlaying) hpDraw(hpvT)
  })
  document.body.appendChild(v)
  hpvVideo = v
  return v
}

function hpEnsureSegVideo(segIdx) {
  const seg = hlSegs[segIdx]
  if (!seg || !seg.file) return null
  const v = hpSegVideoEl()
  if (v.dataset.path !== seg.file) {
    v.dataset.path = seg.file
    v.src = 'prmedia://local/?p=' + encodeURIComponent(seg.file)
    try {
      v.load()
    } catch {}
  }
  // 这一段自己的原声音量（预览最多放到 1.0；>100% 只有导出时生效）
  try {
    const want = Math.max(0, Math.min(1, hlSegVol(seg)))
    if (Math.abs((Number(v.volume) || 0) - want) > 0.01) v.volume = want
  } catch {}
  return v
}

/** 可选的字体（文件给导出的 drawtext 用，css 给预览画布用） */
const HEAD_FONTS = [
  { label: '微软雅黑', file: 'C:\\Windows\\Fonts\\msyh.ttc', css: '"Microsoft YaHei"' },
  { label: '微软雅黑 粗', file: 'C:\\Windows\\Fonts\\msyhbd.ttc', css: '"Microsoft YaHei"', bold: true },
  { label: '黑体', file: 'C:\\Windows\\Fonts\\simhei.ttf', css: 'SimHei, "Microsoft YaHei"' },
  { label: '宋体', file: 'C:\\Windows\\Fonts\\simsun.ttc', css: 'SimSun, "Microsoft YaHei"' },
  { label: '楷体', file: 'C:\\Windows\\Fonts\\simkai.ttf', css: 'KaiTi, "Microsoft YaHei"' },
  { label: '仿宋', file: 'C:\\Windows\\Fonts\\simfang.ttf', css: 'FangSong, "Microsoft YaHei"' },
  { label: '等线', file: 'C:\\Windows\\Fonts\\Deng.ttf', css: 'DengXian, "Microsoft YaHei"' },
  { label: '等线 粗', file: 'C:\\Windows\\Fonts\\Dengb.ttf', css: 'DengXian, "Microsoft YaHei"', bold: true },
  { label: '华文行楷', file: 'C:\\Windows\\Fonts\\STXINGKA.TTF', css: 'STXingkai, KaiTi, "Microsoft YaHei"' },
  { label: '华文彩云', file: 'C:\\Windows\\Fonts\\STCAIYUN.TTF', css: 'STCaiyun, "Microsoft YaHei"' },
  { label: '华文琥珀', file: 'C:\\Windows\\Fonts\\STHUPO.TTF', css: 'STHupo, "Microsoft YaHei"' },
  { label: '华文隶书', file: 'C:\\Windows\\Fonts\\STLITI.TTF', css: 'STLiti, "Microsoft YaHei"' },
  { label: 'Arial', file: 'C:\\Windows\\Fonts\\arial.ttf', css: 'Arial, "Microsoft YaHei"' },
  { label: 'Impact', file: 'C:\\Windows\\Fonts\\impact.ttf', css: 'Impact, "Microsoft YaHei"' },
  { label: 'Consolas（等宽）', file: 'C:\\Windows\\Fonts\\consola.ttf', css: 'Consolas, "Microsoft YaHei"' }
]

function headFontDef(file) {
  const hit = HEAD_FONTS.find((f) => f.file === file)
  return hit || HEAD_FONTS[0]
}

/** 画布上的 font 简写（和导出的 fontfile 一一对应） */
function hpTextFontCss(t) {
  const def = headFontDef(t && t.font)
  return `${def.bold ? 700 : 600} ${hpTextFontPx(hpCanvas() ? hpCanvas().height : 720, t)}px ${def.css}`
}

function hpTextFontCssAt(H, t) {
  const def = headFontDef(t && t.font)
  return `${def.bold ? 700 : 600} ${hpTextFontPx(H, t)}px ${def.css}`
}

/** 拖动文字时的对位参考线：画面中线（强）+ 三分线（弱），离得够近就吸上去 */
let hpTextGuides = []
const HEAD_GUIDE_POS = [0.5, 1 / 3, 2 / 3]

/** 把归一化坐标往最近的参考线吸；返回吸附后的坐标 + 该画的线 */
function hpSnapGuides(fx, fy, W, H) {
  const thrX = 8 / Math.max(1, W)
  const thrY = 8 / Math.max(1, H)
  const pick = (v, thr) => {
    let best = null
    for (const g of HEAD_GUIDE_POS) {
      const d = Math.abs(v - g)
      if (d <= thr && (!best || d < best.d)) best = { g, d }
    }
    return best
  }
  const out = { x: fx, y: fy, guides: [] }
  const bx = pick(fx, thrX)
  if (bx) {
    out.x = bx.g
    out.guides.push({ axis: 'x', pos: bx.g, strong: bx.g === 0.5 })
  }
  const by = pick(fy, thrY)
  if (by) {
    out.y = by.g
    out.guides.push({ axis: 'y', pos: by.g, strong: by.g === 0.5 })
  }
  return out
}

function hpDrawGuides(ctx, W, H) {
  if (!hpTextGuides.length) return
  ctx.save()
  for (const g of hpTextGuides) {
    ctx.beginPath()
    ctx.setLineDash(g.strong ? [] : [7, 7])
    ctx.lineWidth = g.strong ? 2 : 1
    ctx.strokeStyle = g.strong ? 'rgba(94,224,138,0.95)' : 'rgba(94,224,138,0.45)'
    if (g.axis === 'x') {
      const x = Math.round(g.pos * W) + 0.5
      ctx.moveTo(x, 0)
      ctx.lineTo(x, H)
    } else {
      const y = Math.round(g.pos * H) + 0.5
      ctx.moveTo(0, y)
      ctx.lineTo(W, y)
    }
    ctx.stroke()
  }
  ctx.restore()
}

/** 片头图上叠的字：画在 canvas 上（字号按画面高的百分比，和导出用的 drawtext 一致） */
function hpTextFontPx(H, t) {
  const pct = Math.max(0.5, Math.min(40, Number(t && t.sizePct) || 6))
  return Math.max(8, (pct / 100) * H)
}

function hpDrawTexts(ctx, W, H) {
  if (!headTexts.length) return
  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let i = 0; i < headTexts.length; i++) {
    const t = headTexts[i]
    if (!t.text || !t.text.trim()) continue
    const px = hpTextFontPx(H, t)
    const x = Math.max(0, Math.min(1, Number(t.x) || 0)) * W
    const y = Math.max(0, Math.min(1, Number(t.y) || 0)) * H
    ctx.font = hpTextFontCssAt(H, t)
    ctx.globalAlpha = Math.max(0.05, Math.min(1, Number(t.opacity) || 1))
    // 描一圈黑边，浅色背景上也看得清（导出的 drawtext 用 shadow 做到同样效果）
    ctx.lineWidth = Math.max(2, px * 0.12)
    ctx.strokeStyle = 'rgba(0,0,0,0.75)'
    ctx.strokeText(t.text, x, y)
    ctx.fillStyle = t.color || '#ffffff'
    ctx.fillText(t.text, x, y)
    if (i === headTextSel) {
      const w = ctx.measureText(t.text).width
      ctx.globalAlpha = 1
      ctx.setLineDash([5, 4])
      ctx.lineWidth = 2
      ctx.strokeStyle = '#5ee08a'
      ctx.strokeRect(x - w / 2 - 6, y - px / 2 - 6, w + 12, px + 12)
    }
  }
  ctx.restore()
}

/** 某条字在给定画面尺寸下的外框（左上角 + 宽高） */
function hpTextBox(W, H, t) {
  const cv = hpCanvas()
  const ctx = cv ? cv.getContext('2d') : null
  const px = hpTextFontPx(H, t)
  let w = px * 2
  if (ctx) {
    const save = ctx.font
    ctx.font = hpTextFontCssAt(H, t)
    w = ctx.measureText(String((t && t.text) || '')).width || px * 2
    ctx.font = save
  }
  const cx = Math.max(0, Math.min(1, Number(t.x) || 0)) * W
  const cy = Math.max(0, Math.min(1, Number(t.y) || 0)) * H
  return { cx, cy, w, h: px, x: cx - w / 2, y: cy - px / 2 }
}

/** 预览画布上点到哪条字（用于拖动；没点到返回 -1），命中框留 12px 余量 */
function hpTextHit(x, y) {
  const c = hpCanvas()
  if (!c || !headTexts.length) return -1
  const W = c.width
  const H = c.height
  const PAD = 12
  for (let i = headTexts.length - 1; i >= 0; i--) {
    const t = headTexts[i]
    if (!t.text || !t.text.trim()) continue
    const b = hpTextBox(W, H, t)
    if (Math.abs(x - b.cx) <= b.w / 2 + PAD && Math.abs(y - b.cy) <= b.h / 2 + PAD) return i
  }
  return -1
}

/** 加一条字（默认放画面中间） */
function headAddText(seedText) {
  if (!headImagePath) {
    setHeadStatus('先选一张片头图：字是加在片头图上的', 'warn')
    return false
  }
  // 面板上没有输入框了：不传文字就先用「文字N」占位，加完直接进编辑界面改
  const sel = headTexts[headTextSel]
  const text = String(seedText != null ? seedText : `文字${headTexts.length + 1}`).trim() || `文字${headTexts.length + 1}`
  headTexts.push({
    text,
    x: 0.5,
    y: 0.5,
    sizePct: sel ? sel.sizePct : 6,
    color: sel ? sel.color : '#ffffff',
    font: sel ? sel.font : HEAD_FONTS[0].file,
    opacity: 1
  })
  headTextSel = headTexts.length - 1
  hpSyncTextUi()
  hlTextRender()
  hpDraw(hpvT)
  setHeadStatus(`已加第 ${headTexts.length} 条字：${text}（在编辑界面里改内容 / 字体 / 字号）`)
  return true
}

function hpSyncTextUi() {
  const count = document.getElementById('head-text-count')
  if (count) count.textContent = headTexts.length ? `${headTexts.length} 条` : '0 条'
  const count2 = document.getElementById('hl-text-count2')
  if (count2) count2.textContent = headTexts.length ? `${headTexts.length} 条` : '0 条'
  const openBtn = document.getElementById('head-text-open')
  if (openBtn) openBtn.textContent = headTexts.length ? `🎨 文字编辑…（${headTexts.length} 条）` : '🎨 文字编辑…'
  const del = document.getElementById('head-text-del2')
  if (del) del.disabled = headTextSel < 0 || !headTexts[headTextSel]
  refreshHeadUi()
}

function hpDeleteSelectedText() {
  const i = headTextSel
  if (i < 0 || !headTexts[i]) {
    setHeadStatus('先在文字编辑界面里点一条字选中它', 'warn')
    return
  }
  const t = headTexts[i]
  headTexts.splice(i, 1)
  headTextSel = headTexts.length ? Math.min(i, headTexts.length - 1) : -1
  hpSyncTextUi()
  hlTextRender()
  hpDraw(hpvT)
  setHeadStatus(`已删掉：${t.text}`)
}

function hpDraw(t) {
  const c = hpCanvas()
  if (!c) return
  const total = hpTotal()
  const raw = Number.isFinite(Number(t)) ? Number(t) : hpvT
  const tt = Math.max(0, Math.min(total > 0 ? total : 0, raw))
  hpT = tt
  hpvT = tt
  const ctx = c.getContext('2d')
  const W = c.width
  const H = c.height
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, W, H)
  const drawContain = (src, sw, sh) => {
    if (!sw || !sh) return
    const s = Math.min(W / sw, H / sh)
    const dw = sw * s
    const dh = sh * s
    ctx.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh)
  }
  const imgDur = headImgDur()
  let label = ''
  if (imgDur > 0 && tt < imgDur) {
    label = `片头 ${tt.toFixed(1)}s / ${imgDur.toFixed(1)}s`
    if (hpvImg) drawContain(hpvImg, hpvImg.naturalWidth, hpvImg.naturalHeight)
    // 片头图上叠的字（和导出的 drawtext 一个位置、一个字号）
    hpDrawTexts(ctx, W, H)
  } else {
    const at = hpSegAt(tt)
    if (at) {
      const seg = hlSegs[at.segIdx]
      const p = hlSegPeriod(seg)
      label = `片段 ${at.segIdx + 1}/${hlSegs.length} · ${moFmt(p.start)}–${moFmt(p.end)}`
      const v = hpEnsureSegVideo(at.segIdx)
      if (v) {
        if (!hpvPlaying && Math.abs((Number(v.currentTime) || 0) - at.local) > 0.08) {
          try {
            v.currentTime = at.local
          } catch {}
        }
        if (v.readyState >= 2 && v.videoWidth) drawContain(v, v.videoWidth, v.videoHeight)
      }
    } else if (!hlSegs.length) {
      label = '还没有片段：左边勾几个视频，点「← 加入勾选的视频」'
    }
  }
  if (label) {
    ctx.font = '600 13px "Microsoft YaHei", sans-serif'
    const w = ctx.measureText(label).width + 14
    ctx.fillStyle = 'rgba(0,0,0,.55)'
    ctx.fillRect(8, 8, w, 24)
    ctx.fillStyle = '#ffd0db'
    ctx.fillText(label, 15, 25)
  }
  // 拖文字时贴中线 / 三分线的提示线画在最上面
  hpDrawGuides(ctx, W, H)
  hpSetTimeText(tt)
}

/* ---------------- 图片文字：单独的编辑界面（换字体 / 字号 / 拖动缩放） ---------------- */
function hlTextCanvas() {
  return document.getElementById('hl-text-canvas')
}

function hlTextIsOpen() {
  const el = document.getElementById('hl-text')
  return Boolean(el && !el.classList.contains('hidden'))
}

/** 编辑界面里画：片头图 + 所有字 + 选中框 + 右下角缩放手柄 */
function hlTextDraw() {
  const c = hlTextCanvas()
  if (!c) return
  const ctx = c.getContext('2d')
  const W = c.width
  const H = c.height
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, W, H)
  if (hpvImg) {
    const s = Math.min(W / hpvImg.naturalWidth, H / hpvImg.naturalHeight)
    const dw = hpvImg.naturalWidth * s
    const dh = hpvImg.naturalHeight * s
    ctx.drawImage(hpvImg, (W - dw) / 2, (H - dh) / 2, dw, dh)
  } else {
    ctx.fillStyle = '#8f97a8'
    ctx.font = '600 18px "Microsoft YaHei", sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('还没有片头图：先在面板里选一张图', W / 2, H / 2)
  }
  // 字
  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let i = 0; i < headTexts.length; i++) {
    const t = headTexts[i]
    if (!t.text || !t.text.trim()) continue
    const px = hpTextFontPx(H, t)
    const b = hpTextBox(W, H, t)
    ctx.font = hpTextFontCssAt(H, t)
    ctx.globalAlpha = Math.max(0.05, Math.min(1, Number(t.opacity) || 1))
    ctx.lineWidth = Math.max(2, px * 0.12)
    ctx.strokeStyle = 'rgba(0,0,0,0.75)'
    ctx.strokeText(t.text, b.cx, b.cy)
    ctx.fillStyle = t.color || '#ffffff'
    ctx.fillText(t.text, b.cx, b.cy)
  }
  ctx.restore()
  // 选中框 + 缩放手柄
  const sel = headTexts[headTextSel]
  if (sel && sel.text) {
    const b = hpTextBox(W, H, sel)
    ctx.save()
    ctx.setLineDash([6, 4])
    ctx.lineWidth = 2
    ctx.strokeStyle = '#5ee08a'
    ctx.strokeRect(b.x - 8, b.y - 8, b.w + 16, b.h + 16)
    ctx.setLineDash([])
    const hp = hlTextHandlePos(W, H)
    ctx.fillStyle = '#5ee08a'
    ctx.strokeStyle = '#0b0d12'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(hp.x, hp.y, 10, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.restore()
  }
  // 拖动时的中线 / 三分线提示
  hpDrawGuides(ctx, W, H)
}

/** 缩放手柄的位置：选中框右下角 */
function hlTextHandlePos(W, H) {
  const c = hlTextCanvas()
  const cw = c ? c.width : W
  const ch = c ? c.height : H
  const sel = headTexts[headTextSel]
  if (!sel) return { x: cw - 14, y: ch - 14 }
  const b = hpTextBox(cw, ch, sel)
  return { x: b.x + b.w + 16, y: b.y + b.h + 16 }
}

function hlTextRenderList() {
  const host = document.getElementById('hl-text-list')
  if (!host) return
  host.textContent = ''
  if (!headTexts.length) {
    const d = document.createElement('div')
    d.className = 'modal-hint'
    d.textContent = '还没有文字：点右上角「＋ 加一条」'
    host.appendChild(d)
    return
  }
  headTexts.forEach((t, i) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'hl-text-item' + (i === headTextSel ? ' on' : '')
    const sw = document.createElement('i')
    sw.className = 'hl-text-swatch'
    sw.style.background = t.color || '#ffffff'
    const name = document.createElement('span')
    name.className = 'hl-text-item-name'
    name.textContent = `${i + 1}. ${t.text || '(空)'}`
    const meta = document.createElement('span')
    meta.className = 'hl-text-item-meta'
    meta.textContent = `${headFontDef(t.font).label} · ${(+t.sizePct).toFixed(1)}%`
    b.appendChild(sw)
    b.appendChild(name)
    b.appendChild(meta)
    b.addEventListener('click', () => {
      headTextSel = i
      hlTextRender()
      hpDraw(hpvT)
    })
    host.appendChild(b)
  })
}

/** 把选中那条的属性回填到右侧控件 */
function hlTextSyncProps() {
  const sel = headTexts[headTextSel]
  const content = document.getElementById('hl-text-content')
  const fontSel = document.getElementById('hl-text-font')
  const sizeEl = document.getElementById('hl-text-size2')
  const sizeVal = document.getElementById('hl-text-size2-val')
  const colorEl = document.getElementById('hl-text-color2')
  const del = document.getElementById('hl-text-del2')
  if (content) {
    content.value = sel ? sel.text : ''
    content.disabled = !sel
  }
  if (fontSel) {
    fontSel.value = sel ? headFontDef(sel.font).file : HEAD_FONTS[0].file
    fontSel.disabled = !sel
  }
  if (sizeEl) {
    sizeEl.value = String(sel ? Math.round(Number(sel.sizePct) * 2) / 2 : 6)
    sizeEl.disabled = !sel
  }
  if (sizeVal) sizeVal.textContent = `${(sel ? Number(sel.sizePct) : 6).toFixed(1)}%`
  if (colorEl) {
    colorEl.value = sel ? sel.color || '#ffffff' : '#ffffff'
    colorEl.disabled = !sel
  }
  if (del) del.disabled = !sel
  const count2 = document.getElementById('hl-text-count2')
  if (count2) count2.textContent = `${headTexts.length} 条`
}

/** 编辑界面整体刷新（列表 + 属性 + 画布 + 面板预览） */
function hlTextRender() {
  hlTextRenderList()
  hlTextSyncProps()
  hlTextDraw()
  hpDraw(hpvT)
  hpSyncTextUi()
}

function hlTextOpen() {
  if (!headImagePath) {
    setHeadStatus('先选一张片头图，再加字', 'warn')
    return
  }
  const box = document.getElementById('hl-text')
  if (!box) return
  box.classList.remove('hidden')
  if (headTextSel < 0 && headTexts.length) headTextSel = 0
  hpStop()
  hlTextRender()
}

function hlTextClose() {
  const box = document.getElementById('hl-text')
  if (box) box.classList.add('hidden')
  hpDraw(hpvT)
}

/**
 * 把「片头图 + 所有文字」按图片原始分辨率画成一张新图（导出 PNG 用）。
 * 字体/字号/位置和预览、导出视频时完全同一套参数（字号 = 画面高的百分比）。
 */
function hlTextComposeCanvas() {
  const img = hpvImg
  if (!img || !img.naturalWidth) return null
  const nw = img.naturalWidth
  const nh = img.naturalHeight
  // 别把 4K 图放大到离谱；也保证宽高是偶数
  const W = Math.max(2, Math.min(4096, Math.round(nw)))
  const H = Math.max(2, Math.round((W * nh) / Math.max(1, nw)))
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  const ctx = cv.getContext('2d')
  ctx.drawImage(img, 0, 0, W, H)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const t of headTexts) {
    if (!t || !String(t.text || '').trim()) continue
    const px = hpTextFontPx(H, t)
    const def = headFontDef(t.font)
    ctx.font = `${def.bold ? 700 : 600} ${px}px ${def.css}`
    ctx.globalAlpha = Math.max(0.05, Math.min(1, Number(t.opacity) || 1))
    const x = Math.max(0, Math.min(1, Number(t.x) || 0)) * W
    const y = Math.max(0, Math.min(1, Number(t.y) || 0)) * H
    ctx.lineWidth = Math.max(2, px * 0.12)
    ctx.strokeStyle = 'rgba(0,0,0,0.75)'
    ctx.strokeText(t.text, x, y)
    ctx.fillStyle = t.color || '#ffffff'
    ctx.fillText(t.text, x, y)
  }
  ctx.globalAlpha = 1
  return cv
}

/** 「💾 导出图片」：存成 PNG，并把它直接设成片头图（文字已烧进去，所以清空文字列表，避免叠两层） */
async function hlTextExportImage() {
  if (!headImagePath) {
    setHeadStatus('先选一张片头图，再加字', 'warn')
    return
  }
  const cv = hlTextComposeCanvas()
  if (!cv) {
    setHeadStatus('片头图还没解码好，稍等一下再试', 'warn')
    return
  }
  let dataUrl = ''
  try {
    dataUrl = cv.toDataURL('image/png')
  } catch (err) {
    setHeadStatus('生成图片失败：' + ((err && err.message) || err), 'err')
    return
  }
  const base = String(headImagePath).split(/[\\/]/).pop().replace(/\.[^.]+$/, '')
  const btn = document.getElementById('hl-text-save')
  const old = btn ? btn.textContent : ''
  if (btn) {
    btn.disabled = true
    btn.textContent = '正在保存…'
  }
  try {
    const res = await window.pr.headSavePng({
      dataUrl,
      name: `${base}_文字.png`,
      dir: typeof recOutDir === 'string' && recOutDir ? recOutDir : ''
    })
    if (!res || !res.ok) {
      if (res && res.canceled) setHeadStatus('已取消导出')
      else setHeadStatus('导出图片失败：' + ((res && res.error) || '未知错误'), 'err')
      return
    }
    const saved = String(res.path)
    const kb = Math.max(1, Math.round((Number(res.size) || 0) / 1024))
    // 存好了就把它当片头图用；文字已经画进 PNG 里 → 列表清空，避免同一个字出现两次
    const n = headTexts.length
    headTexts = []
    headTextSel = -1
    headImagePath = saved
    rememberHeadFile('img', saved)
    await hpLoadImage(saved)
    hpSyncCanvasSize()
    refreshHeadUi()
    hpSyncTextUi()
    hlTextRender()
    hpDraw(hpvT)
    hlTextClose()
    setHeadStatus(`已导出 ${saved.split(/[\\/]/).pop()}（${cv.width}×${cv.height} · ${kb} KB，${n} 条文字已烧进图里）并设成当前片头图；下次在「▾ 记录」里能再选它`, 'ok')
  } catch (err) {
    setHeadStatus('导出图片出错：' + ((err && err.message) || err), 'err')
  } finally {
    if (btn) {
      btn.disabled = false
      btn.textContent = old || '💾 导出图片'
    }
  }
}

/* ---------- 文字模板：把这组排版存下来，换张图也能一键套用（只需改文字） ---------- */
const HEAD_TPL_KEY = 'headTextTemplates'
const HEAD_TPL_MAX = 24

function headTemplateList() {
  const p = loadPrefs()
  const arr = p[HEAD_TPL_KEY]
  if (!Array.isArray(arr)) return []
  return arr
    .filter((t) => t && typeof t === 'object' && Array.isArray(t.texts))
    .map((t) => ({
      name: String(t.name || '模板'),
      at: Number(t.at) || 0,
      texts: t.texts
        .filter((x) => x && typeof x === 'object')
        .map((x) => ({
          text: String(x.text || ''),
          x: Math.max(0, Math.min(1, Number(x.x) || 0.5)),
          y: Math.max(0, Math.min(1, Number(x.y) || 0.5)),
          sizePct: Math.max(1, Math.min(30, Number(x.sizePct) || 6)),
          color: String(x.color || '#ffffff'),
          font: String(x.font || HEAD_FONTS[0].file),
          opacity: Number.isFinite(Number(x.opacity)) ? Number(x.opacity) : 1
        }))
    }))
}

function headTemplateSaveAll(list) {
  savePrefs({ [HEAD_TPL_KEY]: list.slice(0, HEAD_TPL_MAX) })
  hlTextSyncTemplateUi()
}

/** 把当前这组文字存成模板 */
function headTemplateSave() {
  if (!headTexts.length) {
    setHeadStatus('现在没有文字可存：先加几条再存模板', 'warn')
    return
  }
  const nameEl = document.getElementById('hl-text-tpl-name')
  const list = headTemplateList()
  const name = String((nameEl && nameEl.value) || '').trim() || `模板${list.length + 1}`
  const entry = {
    name,
    at: Date.now(),
    texts: headTexts.map((t) => ({
      text: String(t.text || ''),
      x: Number(t.x) || 0.5,
      y: Number(t.y) || 0.5,
      sizePct: Number(t.sizePct) || 6,
      color: t.color || '#ffffff',
      font: headFontDef(t.font).file,
      opacity: Number.isFinite(Number(t.opacity)) ? Number(t.opacity) : 1
    }))
  }
  // 同名就覆盖，别攒一堆同名的
  const next = [entry, ...list.filter((t) => t.name !== name)]
  headTemplateSaveAll(next)
  if (nameEl) nameEl.value = ''
  setHeadStatus(`已存成模板「${name}」（${entry.texts.length} 条文字）；以后点「📂 模板」就能套用`, 'ok')
}

/** 套用模板：位置 / 字体 / 字号 / 颜色整套来，文字内容也带过来，之后直接改字 */
function headTemplateApply(name) {
  const tpl = headTemplateList().find((t) => t.name === name)
  if (!tpl) {
    setHeadStatus('这个模板已经不在了', 'warn')
    return
  }
  if (!headImagePath) {
    setHeadStatus('先选一张片头图，再套模板', 'warn')
    return
  }
  headTexts = tpl.texts.map((t) => ({ ...t }))
  headTextSel = headTexts.length ? 0 : -1
  hlTextRender()
  hpDraw(hpvT)
  setHeadStatus(`已套用模板「${name}」（${headTexts.length} 条）—— 在右侧「文字」里改内容就行`, 'ok')
}

function showHeadTemplateMenu(anchor) {
  const list = headTemplateList()
  const items = []
  if (!list.length) {
    items.push({ label: '（还没有模板：先摆好文字，点「💾 存为模板」）' })
  } else {
    items.push({ head: `文字模板（${list.length} 个）` })
    for (const t of list) {
      items.push({
        label: `${t.name}（${t.texts.length} 条）`,
        action: () => headTemplateApply(t.name)
      })
    }
    items.push({ sep: true })
    for (const t of list) {
      items.push({
        label: `🗑 删除「${t.name}」`,
        action: () => {
          headTemplateSaveAll(headTemplateList().filter((x) => x.name !== t.name))
          setHeadStatus(`已删除模板「${t.name}」`)
        }
      })
    }
    items.push({
      label: '清空全部模板',
      action: () => {
        headTemplateSaveAll([])
        setHeadStatus('模板已清空')
      }
    })
  }
  const r = anchor.getBoundingClientRect()
  showPopup(Math.round(r.left), Math.round(r.bottom + 4), items, '📂 文字模板')
}

function hlTextSyncTemplateUi() {
  const n = headTemplateList().length
  const btn = document.getElementById('hl-text-tpl')
  if (btn) btn.textContent = n ? `📂 模板（${n}）` : '📂 模板'
}

function hlTextWire() {
  // 字体下拉
  const fontSel = document.getElementById('hl-text-font')
  if (fontSel) {
    fontSel.textContent = ''
    for (const f of HEAD_FONTS) {
      const o = document.createElement('option')
      o.value = f.file
      o.textContent = f.label
      fontSel.appendChild(o)
    }
    fontSel.addEventListener('change', () => {
      const sel = headTexts[headTextSel]
      if (!sel) return
      sel.font = fontSel.value
      hlTextRender()
    })
  }
  const content = document.getElementById('hl-text-content')
  if (content) {
    content.addEventListener('input', () => {
      const sel = headTexts[headTextSel]
      if (!sel) return
      sel.text = content.value
      hlTextDraw()
      hlTextRenderList()
      hpDraw(hpvT)
    })
  }
  const sizeEl = document.getElementById('hl-text-size2')
  if (sizeEl) {
    sizeEl.addEventListener('input', () => {
      const sel = headTexts[headTextSel]
      const val = document.getElementById('hl-text-size2-val')
      if (val) val.textContent = `${Number(sizeEl.value).toFixed(1)}%`
      if (!sel) return
      sel.sizePct = Math.max(1, Math.min(30, Number(sizeEl.value) || 6))
      hlTextDraw()
      hlTextRenderList()
      hpDraw(hpvT)
    })
  }
  const colorEl = document.getElementById('hl-text-color2')
  if (colorEl) {
    colorEl.addEventListener('input', () => {
      const sel = headTexts[headTextSel]
      if (!sel) return
      sel.color = colorEl.value
      hlTextDraw()
      hlTextRenderList()
      hpDraw(hpvT)
    })
  }
  const del2 = document.getElementById('hl-text-del2')
  if (del2) del2.addEventListener('click', () => hpDeleteSelectedText())
  const copy2 = document.getElementById('hl-text-copy')
  if (copy2) copy2.addEventListener('click', () => hpDuplicateSelectedText())
  const reset2 = document.getElementById('hl-text-reset2')
  if (reset2) {
    reset2.addEventListener('click', () => {
      const sel = headTexts[headTextSel]
      if (!sel) return
      sel.x = 0.5
      sel.y = 0.5
      hlTextRender()
    })
  }
  const add2 = document.getElementById('hl-text-add2')
  if (add2) {
    add2.addEventListener('click', () => {
      const n = headTexts.length + 1
      headAddText(`文字${n}`)
      hlTextRender()
    })
  }
  const done = document.getElementById('hl-text-done')
  if (done) done.addEventListener('click', () => hlTextClose())
  const saveImg = document.getElementById('hl-text-save')
  if (saveImg) saveImg.addEventListener('click', () => hlTextExportImage())
  // 文字模板：存 / 选 / 删
  const tplSave = document.getElementById('hl-text-tpl-save')
  if (tplSave) tplSave.addEventListener('click', () => headTemplateSave())
  const tplName = document.getElementById('hl-text-tpl-name')
  if (tplName) {
    tplName.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault()
        headTemplateSave()
      }
    })
  }
  const tplBtn = document.getElementById('hl-text-tpl')
  if (tplBtn) tplBtn.addEventListener('click', () => showHeadTemplateMenu(tplBtn))
  hlTextSyncTemplateUi()
  const close = document.getElementById('hl-text-close')
  if (close) close.addEventListener('click', () => hlTextClose())

  // 画布：拖动移动 / 拖右下角小方块缩放
  const c = hlTextCanvas()
  if (c) {
    let mode = '' // 'move' | 'resize'
    let startDist = 0
    let startSize = 0
    // 抓取偏移：按下时鼠标相对文字中心差多少，拖动时就一直差多少（不然字会"蹦"到鼠标底下）
    let grabDx = 0
    let grabDy = 0
    const toCv = (ev) => {
      const r = c.getBoundingClientRect()
      return {
        x: ((ev.clientX - r.left) / Math.max(1, r.width)) * c.width,
        y: ((ev.clientY - r.top) / Math.max(1, r.height)) * c.height
      }
    }
    const move = (ev) => {
      const pt = toCv(ev)
      const t = headTexts[headTextSel]
      if (!t) return
      if (mode === 'move') {
        const rawX = Math.max(0, Math.min(1, (pt.x + grabDx) / c.width))
        const rawY = Math.max(0, Math.min(1, (pt.y + grabDy) / c.height))
        // 靠近画面中线 / 三分线就吸上去，并画出提示线
        const snap = hpSnapGuides(rawX, rawY, c.width, c.height)
        t.x = snap.x
        t.y = snap.y
        hpTextGuides = snap.guides
      } else if (mode === 'resize') {
        const b = hpTextBox(c.width, c.height, t)
        const dist = Math.hypot(pt.x - b.cx, pt.y - b.cy)
        const ratio = startDist > 4 ? dist / startDist : 1
        t.sizePct = Math.max(1, Math.min(30, startSize * ratio))
        const val = document.getElementById('hl-text-size2-val')
        if (val) val.textContent = `${t.sizePct.toFixed(1)}%`
        const sizeEl2 = document.getElementById('hl-text-size2')
        if (sizeEl2) sizeEl2.value = String(Math.round(t.sizePct * 2) / 2)
      }
      hlTextDraw()
      hpDraw(hpvT)
    }
    const up = () => {
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', up, true)
      hpTextGuides = []
      if (mode) {
        hlTextRenderList()
        hlTextSyncProps()
        const t = headTexts[headTextSel]
        if (t) setHeadStatus(mode === 'resize' ? `字号 ${Number(t.sizePct).toFixed(1)}%` : `位置：横向 ${(t.x * 100).toFixed(0)}% · 纵向 ${(t.y * 100).toFixed(0)}%`)
        hlTextDraw()
        hpDraw(hpvT)
      }
      mode = ''
      c.style.cursor = 'default'
    }
    c.addEventListener('pointerdown', (ev) => {
      const pt = toCv(ev)
      // 1) 先看是不是点在缩放手柄上（只在选中那条时才显示）
      const sel = headTexts[headTextSel]
      if (sel) {
        const hp = hlTextHandlePos()
        if (Math.hypot(pt.x - hp.x, pt.y - hp.y) <= 16) {
          mode = 'resize'
          const b = hpTextBox(c.width, c.height, sel)
          startDist = Math.max(4, Math.hypot(pt.x - b.cx, pt.y - b.cy))
          startSize = Number(sel.sizePct) || 6
          c.style.cursor = 'nwse-resize'
          window.addEventListener('pointermove', move, true)
          window.addEventListener('pointerup', up, true)
          return
        }
      }
      // 2) 点到某条字 → 选中并准备拖动（记住抓取偏移，字不会跳到鼠标底下）
      const hit = hlTextHitAt(pt.x, pt.y)
      if (hit >= 0) {
        headTextSel = hit
        mode = 'move'
        const tt = headTexts[hit]
        grabDx = Math.max(0, Math.min(1, Number(tt.x) || 0)) * c.width - pt.x
        grabDy = Math.max(0, Math.min(1, Number(tt.y) || 0)) * c.height - pt.y
        hlTextRenderList()
        hlTextSyncProps()
        hlTextDraw()
        c.style.cursor = 'move'
        window.addEventListener('pointermove', move, true)
        window.addEventListener('pointerup', up, true)
        return
      }
      // 3) 空白处：取消选中
      headTextSel = -1
      hlTextRender()
    })
    c.addEventListener('pointermove', (ev) => {
      if (mode) return
      const pt = toCv(ev)
      const sel = headTexts[headTextSel]
      let cur = 'default'
      if (sel) {
        const hp = hlTextHandlePos()
        if (Math.hypot(pt.x - hp.x, pt.y - hp.y) <= 16) cur = 'nwse-resize'
      }
      if (cur === 'default' && hlTextHitAt(pt.x, pt.y) >= 0) cur = 'move'
      c.style.cursor = cur
    })
  }
}

/** 文字编辑界面里点中哪条（命中框留 12px 余量，不用精确点在笔画上） */
function hlTextHitAt(x, y) {
  const c = hlTextCanvas()
  if (!c || !headTexts.length) return -1
  const PAD = 12
  for (let i = headTexts.length - 1; i >= 0; i--) {
    const t = headTexts[i]
    if (!t.text || !t.text.trim()) continue
    const b = hpTextBox(c.width, c.height, t)
    if (Math.abs(x - b.cx) <= b.w / 2 + PAD && Math.abs(y - b.cy) <= b.h / 2 + PAD) return i
  }
  return -1
}

/** 复制当前选中的那条字（文字 / 字体 / 字号 / 颜色都一起复制，位置稍微错开一点） */
function hpDuplicateSelectedText() {
  const src = headTexts[headTextSel]
  if (!src) {
    setHeadStatus('先在文字列表或画面上选中一条字，再复制', 'warn')
    return
  }
  const copy = {
    text: src.text,
    x: Math.max(0, Math.min(1, (Number(src.x) || 0) + 0.03)),
    y: Math.max(0, Math.min(1, (Number(src.y) || 0) + 0.06)),
    sizePct: Number(src.sizePct) || 6,
    color: src.color || '#ffffff',
    font: src.font || HEAD_FONTS[0].file,
    opacity: Number(src.opacity) || 1
  }
  headTexts.push(copy)
  headTextSel = headTexts.length - 1
  hlTextRender()
  setHeadStatus(`已复制「${copy.text}」（文字 / 字体 / 字号 / 颜色都跟着，位置错开了 3% · 6%）`)
}

function hpStop() {
  hpvPlaying = false
  if (hpvRaf) cancelAnimationFrame(hpvRaf)
  hpvRaf = 0
  const btn = document.getElementById('head-prev-play')
  if (btn) btn.textContent = '▶ 预览'
  hpSyncFsBtn()
  try {
    if (hpvVideo) hpvVideo.pause()
  } catch {}
  try {
    if (hpBgm) hpBgm.pause()
  } catch {}
}

function hpEnsureBgm(path) {
  if (hpBgm) {
    try {
      hpBgm.pause()
    } catch {}
    hpBgm = null
  }
  hpBgmPath = String(path || '')
  if (!path) return
  const a = new Audio('prmedia://local/?p=' + encodeURIComponent(path))
  a.loop = true
  a.volume = headBgmVolume()
  a.crossOrigin = 'anonymous'
  // 元数据到了立刻把播放位置对齐到预览的当前位置
  a.addEventListener('loadedmetadata', () => {
    try {
      const dur = Number(a.duration)
      if (dur > 0.2) a.currentTime = Math.max(0, hpvT % dur)
    } catch {}
  })
  hpBgm = a
}

/**
 * 把背景音对齐到"合成预览的当前状态"。
 * 关键：预览正在播的时候选/换背景音，要立刻接上（不然就是"后选的没进预览"）；
 * 清掉背景音要立刻停。
 */
function hpSyncBgm() {
  if (!headBgmPath) {
    if (hpBgm) {
      try {
        hpBgm.pause()
      } catch {}
    }
    hpBgm = null
    hpBgmPath = ''
    return
  }
  if (!hpBgm || hpBgmPath !== headBgmPath) hpEnsureBgm(headBgmPath)
  if (!hpBgm) return
  hpBgm.volume = headBgmVolume()
  const dur = Number(hpBgm.duration)
  if (Number.isFinite(dur) && dur > 0.2) {
    const want = Math.max(0, hpvT % dur)
    if (Math.abs((Number(hpBgm.currentTime) || 0) - want) > 0.35) {
      try {
        hpBgm.currentTime = want
      } catch {}
    }
  }
  if (hpvPlaying) {
    const p = hpBgm.play()
    if (p && p.catch) p.catch(() => {})
  }
}

function hpLoop() {
  hpvRaf = 0
  if (!hpvPlaying) return
  const now = performance.now()
  const dt = (now - hpvT0) / 1000
  hpvT0 = now
  const total = hpTotal()
  if (!(total > 0)) {
    hpStop()
    return
  }
  hpvT = Math.min(total, hpvT + dt)
  const at = hpSegAt(hpvT)
  if (at) {
    const v = hpEnsureSegVideo(at.segIdx)
    if (v) {
      // 画面跟着自己那一路视频走：播到区间外就拉回来
      if (Math.abs((Number(v.currentTime) || 0) - at.local) > 0.35) {
        try {
          v.currentTime = at.local
        } catch {}
      }
      if (v.paused) {
        const p = v.play()
        if (p && p.catch) p.catch(() => {})
      }
    }
  } else if (hpvVideo && !hpvVideo.paused && hpvT < headImgDur()) {
    try {
      hpvVideo.pause()
    } catch {}
  }
  hpDraw(hpvT)
  if (hpvT >= total - 0.02) {
    hpStop()
    return
  }
  hpvRaf = requestAnimationFrame(hpLoop)
}

function hpSeek(t) {
  const total = hpTotal()
  hpvT = Math.max(0, Math.min(total > 0 ? total : 0, Number(t) || 0))
  const at = hpSegAt(hpvT)
  if (at) {
    const v = hpEnsureSegVideo(at.segIdx)
    if (v) {
      if (hpvPlaying) {
        if (v.paused) {
          const p = v.play()
          if (p && p.catch) p.catch(() => {})
        }
      } else if (Math.abs((Number(v.currentTime) || 0) - at.local) > 0.05) {
        seekMediaLazy(v, at.local)
      }
    }
  }
  hpDraw(hpvT)
}

function hpTogglePreview() {
  if (hpvPlaying) {
    hpStop()
    return
  }
  const total = hpTotal()
  if (!(total > 0)) {
    setHeadStatus('还没有片段：左边勾几个视频，点「← 加入勾选的视频」', 'warn')
    return
  }
  if (hpvT >= total - 0.05) hpvT = 0
  hpvPlaying = true
  hpvT0 = performance.now()
  const btn = document.getElementById('head-prev-play')
  if (btn) btn.textContent = '⏸ 暂停'
  hpSyncFsBtn()
  // 背景音：每次开始都按当前选择重新对齐（换过文件也能立刻听到）
  hpSyncBgm()
  hpSeek(hpvT)
  if (!hpvRaf) hpvRaf = requestAnimationFrame(hpLoop)
  setHeadStatus(`正在预览 ${moFmt(hpTotal())} 的成片效果（不生成文件）`)
}

/* ---------- 预览全屏：只放大预览画面 ---------- */
function hpIsFs() {
  const el = document.getElementById('hp-fs')
  return Boolean(el && !el.classList.contains('hidden'))
}

function hpSyncFsBtn() {
  const btn = document.getElementById('head-prev-fs')
  if (btn) {
    btn.textContent = hpIsFs() ? '⛶ 退出全屏' : '⛶ 全屏'
    btn.classList.toggle('on', hpIsFs())
  }
  const play = document.getElementById('hp-fs-play')
  if (play) play.textContent = hpvPlaying ? '⏸ 暂停' : '▶ 播放'
}

/** 全屏预览里的时间/进度也要跟着走 */
function hpSyncFsTime(t) {
  const el = document.getElementById('hp-fs-time')
  if (el) el.textContent = `${moFmt(t)} / ${moFmt(hpTotal())}`
  const seek = document.getElementById('hp-fs-seek')
  if (seek && !seek.dataset.dragging) {
    const total = hpTotal()
    seek.value = String(total > 0 ? Math.round((t / total) * 1000) : 0)
  }
}

async function hpToggleFs() {
  const want = !hpIsFs()
  const box = document.getElementById('hp-fs')
  if (!box) return
  box.classList.toggle('hidden', !want)
  if (want) {
    hpSyncFsBtn()
    hpSyncCanvasSize()
    hpDraw(hpvT)
  }
  // 只把预览铺满窗口：连系统全屏一起进出，这样真是"整屏看这一段"
  try {
    const isFull = await window.pr.isFullscreen()
    if (Boolean(isFull) !== want) await window.pr.toggleFullscreen()
  } catch {}
  hpSyncFsBtn()
  hpSyncCanvasSize()
  hpDraw(hpvT)
  // 画布刚换过尺寸（会清空），等一帧再重画
  setTimeout(() => {
    hpSyncCanvasSize()
    hpDraw(hpvT)
  }, 220)
}

/** 关掉全屏预览（切页签 / 离开剪辑页时用，避免白白占着整屏） */
function hpCloseFs() {
  const box = document.getElementById('hp-fs')
  if (!box || box.classList.contains('hidden')) return
  box.classList.add('hidden')
  hpSyncFsBtn()
  hpSyncCanvasSize()
  hpDraw(hpvT)
  Promise.resolve(window.pr.isFullscreen())
    .then((isFull) => {
      if (isFull) return window.pr.toggleFullscreen()
      return null
    })
    .catch(() => {})
}

function headShowProgress(pct, text) {
  const box = document.getElementById('head-progress')
  const fill = document.getElementById('head-progress-fill')
  const txt = document.getElementById('head-progress-text')
  if (!box) return
  if (pct === null) {
    box.classList.add('hidden')
    return
  }
  box.classList.remove('hidden')
  if (fill) fill.style.width = `${Math.max(0, Math.min(100, Number(pct) || 0))}%`
  if (txt) txt.textContent = text || ''
}

/** 导出按钮的文字跟着内容变：写清楚这一次到底合成什么 */
function refreshHeadUi() {
  const btn = document.getElementById('head-apply')
  const imgEl = document.getElementById('head-image')
  const bgmEl = document.getElementById('head-bgm')
  if (imgEl) imgEl.value = headImagePath
  if (bgmEl) bgmEl.value = headBgmPath
  const countEl = document.getElementById('head-text-count')
  if (countEl) countEl.textContent = headTexts.length ? `${headTexts.length} 条` : '0 条'
  const on = hlSegsOn()
  const n = on.length
  const skip = hlSegs.length - n
  const sum = on.reduce((a, s) => a + hlSegPeriod(s).dur, 0)
  if (!btn) return
  btn.disabled = headBusy || n === 0
  const imgDur = headImagePath && headSeconds() >= 0.2 ? headSeconds() : 0
  const parts = []
  if (imgDur > 0) parts.push(`片头 ${headSeconds()}s`)
  else if (headTexts.length) parts.push(`文字 ${headTexts.length} 条（没片头图，不生效）`)
  parts.push(`${n} 段 / ${sum.toFixed(1)}s`)
  if (skip > 0) parts.push(`跳过 ${skip} 段`)
  // 有片段调过原声音量就提示一句（不然导出后才发现"怎么小/大了"）
  const tweaked = on.filter((s) => Math.abs(hlSegVol(s) - 1) > 0.001)
  if (tweaked.length) parts.push(`原声调整 ${tweaked.length} 段`)
  if (headBgmPath) parts.push('背景音')
  const what = parts.join(' + ')
  if (headBusy) btn.textContent = `正在合并（${what}）…`
  else btn.textContent = `合并导出 · ${what}`
  btn.title = `一次编码出成片：${what}${imgDur > 0 ? '' : '（秒数填 0 或清掉图片就是纯合并）'}${skip > 0 ? '；卡片左上角的勾控制要不要这一段' : ''}`
}

/* ---------- 合并导出 ---------- */
async function headApply() {
  if (headBusy) return
  const segs = hlSegsOn().filter((s) => s.file && hlSegPeriod(s).dur > 0.05)
  if (!segs.length) {
    setHeadStatus(hlSegs.length ? '所有片段都被排除在合成了：把卡片左上角的勾打回参与' : '还没有要合并的视频：左边勾几个，点「← 加入勾选的视频」', 'warn')
    return
  }
  const seconds = headSeconds()
  const wantHead = Boolean(headImagePath) && seconds >= 0.2
  const nvenc = Boolean(document.getElementById('head-nvenc') && document.getElementById('head-nvenc').checked)
  const total = (wantHead ? seconds : 0) + segs.reduce((a, s) => a + hlSegPeriod(s).dur, 0)
  headBusy = true
  refreshHeadUi()
  const taskId = taskBegin('head', `合并导出 · ${segs.length} 段 · ${total.toFixed(1)}s`, `片头 ${wantHead ? seconds + 's' : '无'}`)
  headTaskId = taskId
  headShowProgress(0, '准备中…')
  setHeadStatus(`正在合并 ${segs.length} 段（共 ${total.toFixed(1)}s）…`)
  try {
    const res = await window.pr.recMergeExport({
      image: wantHead ? headImagePath : '',
      seconds: wantHead ? seconds : 0,
      items: segs.map((s) => {
        const p = hlSegPeriod(s)
        return { file: s.file, start: p.start, end: p.end, volume: hlSegVol(s) }
      }),
      bgm: headBgmPath ? { path: headBgmPath, volume: headBgmVolume() } : null,
      // 片头图上的字（只在有片头图时生效）；每条自带字体文件
      texts: wantHead
        ? headTexts
            .filter((t) => t && String(t.text || '').trim())
            .map((t) => ({
              text: String(t.text).slice(0, 80),
              x: t.x,
              y: t.y,
              sizePct: t.sizePct,
              color: t.color,
              font: headFontDef(t.font).file,
              opacity: 1
            }))
        : [],
      font: (wmConfig && wmConfig.font) || '',
      encoder: nvenc ? 'nvenc' : 'x264',
      outDir: typeof recOutDir === 'string' && recOutDir ? recOutDir : '',
      taskId
    })
    if (!res || !res.ok) {
      const msg = (res && res.error) || '合并失败'
      setHeadStatus('合并失败：' + msg, 'err')
      taskFinish(taskId, { ok: false, error: msg })
      return
    }
    const name = String(res.out).split(/[\\/]/).pop()
    // 真用上了：记进「用过的片头图 / 背景音」，下次点「▾ 记录」就能直接选
    if (wantHead) rememberHeadFile('img', headImagePath)
    if (headBgmPath) rememberHeadFile('bgm', headBgmPath)
    setHeadStatus(`已生成 ${name}（${res.duration}s${res.head ? ' · 含片头 ' + res.head + 's' : ''}）`, 'ok')
    taskFinish(taskId, { ok: true, out: res.out, note: `${res.duration}s` })
    headShowProgress(100, '100%')
    await refreshEditFiles({ silent: true, force: true })
  } catch (err) {
    const msg = (err && err.message) || String(err)
    setHeadStatus('合并出错：' + msg, 'err')
    taskFinish(taskId, { ok: false, error: msg })
  } finally {
    headBusy = false
    headTaskId = ''
    headShowProgress(null)
    refreshHeadUi()
  }
}


/* ----- 精彩片段列表 ----- */
/** 片段时长：区间片段按 end-start，本地片段文件按它自己的时长 */
function hlSegDur(s) {
  if (!s) return 0
  // 整段视频现在也能裁：有 start/end 就按裁出来的长度算
  if (s.file) {
    const a = Math.max(0, Number(s.start) || 0)
    const b = Number(s.end) > 0 ? Number(s.end) : Number(s.dur) || 0
    return Math.max(0, b - a)
  }
  return Math.max(0, (Number(s.end) || 0) - (Number(s.start) || 0))
}
/** 参与合成的总时长（不参与的那几段不算） */
function hlTotalDur() {
  return hlSegsOn().reduce((a, s) => a + hlSegDur(s), 0)
}
/** 片段卡片的标题：区间片段给时间范围，本地文件给文件名 */
function hlSegLabel(s) {
  if (!s) return ''
  if (s.file) {
    const name = s.name || String(s.file).split(/[\\/]/).pop()
    const cut = Number(s.start) > 0.05 || (Number(s.end) > 0 && Number(s.end) < (Number(s.dur) || 0) - 0.05)
    return `${name.slice(0, 22)}（${cut ? `${moFmt(s.start)}–${moFmt(s.end)} / ` : ''}${hlSegDur(s).toFixed(1)}s）`
  }
  return `${moFmt(s.start)}–${moFmt(s.end)}（${hlSegDur(s).toFixed(1)}s）`
}

/** 剪辑页片段卡里的预览播放器（index -> <video>），重排/切换时统一释放 */
const hlPreviewVideos = new Map()

/** 📂 加本地片段：选若干视频文件，整段加进精彩片段列表 */
/**
 * 单个视频加进「图片片头」的片段列表（整段先入列，之后可以在卡片上裁）。
 * 用 name 里的时间戳做默认排序键：`xxx_20261115-235712.mp4` / `xxx20261115_235712.mp4` 等。
 */
function hlStampOf(name) {
  const s = String(name || '')
  const m = s.match(/(20\d{6})[-_ ]?(\d{6})/)
  if (!m) return null
  return `${m[1]}${m[2]}`
}

/** 把若干视频文件加进片段列表（已在列表里的跳过），然后按文件名时间戳排序 */
async function hlAddVideos(paths, opts = {}) {
  const list = Array.from(new Set((paths || []).map((p) => String(p || '').trim()).filter(Boolean)))
  if (!list.length) {
    setHlStatus(opts.hint || '先在左边勾选几个视频（或点「📂 加本地片段」直接选文件）', 'warn')
    return 0
  }
  let added = 0
  const failed = []
  const skippedOwn = []
  for (const p of list) {
    if (hlSegs.some((s) => s.file === p)) continue
    const name = String(p).split(/[\\/]/).pop()
    // 「合并_20261116-090406.mp4」是合并导出自己生成的成片：
    // 再加进来会把成片内容（含片头那几秒图片）整条重复一遍，看着像"片头图合成了两次"
    if (!opts.allowMergeOutput && /^合并_\d{8}-\d{6}(_\d+)?\.mp4$/i.test(name)) {
      skippedOwn.push(name)
      continue
    }
    let dur = 0
    try {
      const r = await window.pr.recProbeDuration(p)
      dur = Number(r && r.dur) || 0
    } catch {}
    if (!(dur > 0.2)) {
      failed.push(name)
      continue
    }
    hlSegs.push({
      file: p,
      name,
      dur: Math.round(dur * 100) / 100,
      start: 0,
      end: Math.round(dur * 100) / 100,
      cur: Math.round((dur / 2) * 100) / 100,
      thumb: '',
      kind: 'file',
      // 这一段自己的原声音量（1 = 100%），卡片下面那根小滑杆能改
      vol: 1
    })
    added += 1
  }
  hlSortByTimestamp()
  const ownNote = skippedOwn.length
    ? `；跳过 ${skippedOwn.length} 个「合并_*.mp4」（那是合并导出的成片，再合一次会把片头和内容重复一遍）`
    : ''
  if (added) {
    hlSelIdx = hlSegs.length - 1
    renderHlList()
    hlReveal()
    refreshHeadUi()
    hpDraw(hpvT)
    setHlStatus(
      `已加入 ${added} 个视频（共 ${hlSegs.length} 段 / ${hlTotalDur().toFixed(1)}s，按文件名时间戳排序）` +
        (failed.length ? `；${failed.length} 个读不出时长已跳过` : '') +
        ownNote,
      failed.length || skippedOwn.length ? 'warn' : 'ok'
    )
  } else {
    if (skippedOwn.length) {
      setHlStatus(`这几个是合并导出的成片，没加：${skippedOwn.join('、')}（真要再合一遍就用「📂 加本地片段」手动选）`, 'warn')
    } else {
      setHlStatus(failed.length ? `读不出时长：${failed.join('、')}` : '这些视频已经在列表里了', 'warn')
    }
  }
  return added
}

/** 「要合并的片段」这一块在右栏中间，加入后自动把它滚到视野里（不然新卡片看着像没反应） */
function hlReveal() {
  const el = document.getElementById('head-clips')
  if (!el) return
  const pane = el.closest('.edit-mosaic-pane')
  if (!pane) return
  const r = el.getBoundingClientRect()
  const pr = pane.getBoundingClientRect()
  // 已经整块在视野里就别动（避免无谓的抖动）
  if (r.top >= pr.top - 2 && r.bottom <= pr.bottom + 2) return
  try {
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  } catch {
    try {
      el.scrollIntoView(false)
    } catch {}
  }
}

/** 片段列表按文件名时间戳升序排；没有时间戳的排最后（保持原相对顺序） */
function hlSortByTimestamp() {
  const keyed = hlSegs.map((s, i) => ({ s, i, k: hlStampOf(s.name || (s.file ? String(s.file).split(/[\\/]/).pop() : '')) }))
  keyed.sort((a, b) => {
    if (a.k && b.k) return a.k < b.k ? -1 : a.k > b.k ? 1 : a.i - b.i
    if (a.k) return -1
    if (b.k) return 1
    return a.i - b.i
  })
  hlSegs.length = 0
  for (const x of keyed) hlSegs.push(x.s)
}

/** 把左侧「视频文件」里勾选的视频加进片段列表 */
async function hlAddPickedVideos() {
  const picked = [...editSelected]
  if (!picked.length) {
    setHlStatus('先在左边「视频文件」里勾选几个视频（可以点组标题的「全选本组」）', 'warn')
    return
  }
  await hlAddVideos(picked, { hint: '先在左边勾选几个视频' })
}

async function hlAddLocalFiles() {
  try {
    const res = await window.pr.pickLocalFiles('video')
    const files = res && res.ok && Array.isArray(res.files) ? res.files.filter((f) => f && f.path) : []
    if (!files.length) {
      if (res && res.canceled) return
      setHlStatus('没选到文件（mp4 / m4v / mov / webm 能直接看画面；其他容器也能拼，只是小窗是黑的）', 'warn')
      return
    }
    const before = hlSegs.length
    await hlAddVideos(
      files.map((f) => f.path),
      // 手动从磁盘选的，用户就是要这个文件 → 连「合并_*.mp4」也允许加
      { hint: '没选到文件', allowMergeOutput: true }
    )
    if (hlSegs.length > before) {
      setHlStatus(`已加入 ${hlSegs.length - before} 个视频（共 ${hlSegs.length} 段 / ${hlTotalDur().toFixed(1)}s）；点「合并导出」一次编码出成片`)
    }
  } catch (err) {
    setHlStatus('加本地片段失败：' + ((err && err.message) || err), 'err')
  }
}

/** 片段区那行提示：几段参与 / 跳过几段 / 总长 / 片头多少 */
function hlUpdateHint() {
  const h = document.getElementById('hl-count-hint')
  if (!h) return
  const onN = hlSegsOn().length
  const skip = hlSegs.length - onN
  h.textContent = hlSegs.length
    ? `${hlSegs.length} 段（${onN} 段参与合成${skip ? `，跳过 ${skip} 段` : ''}）共 ${hlTotalDur().toFixed(1)}s` +
      `（片头 ${headImagePath && headSeconds() >= 0.2 ? headSeconds() + 's' : '无'}）；卡片左上角的勾 = 要不要这一段，拖中间那根只看画面、不动选区`
    : '还没有片段：左边勾几个视频，点「← 加入勾选的视频」合并'
}

function renderHlList() {
  const list = document.getElementById('hl-list')
  if (!list) return
  // 先把上一批预览解码器放掉，别越堆越多
  for (const v of hlPreviewVideos.values()) {
    try {
      v.pause()
      v.removeAttribute('src')
      v.load()
    } catch {}
  }
  hlPreviewVideos.clear()
  list.innerHTML = ''
  hlUpdateHint()
  hlSegs.forEach((s, i) => {
    const card = document.createElement('div')
    card.className = 'hl-card' + (i === hlSelIdx ? ' active' : '') + (hlSegOn(s) ? '' : ' off')
    const top = document.createElement('div')
    top.className = 'hl-card-top'
    // 参不参与合成：默认全参与，取消勾选就跳过这一段
    const onBox = document.createElement('input')
    onBox.type = 'checkbox'
    onBox.className = 'hl-card-on'
    onBox.checked = hlSegOn(s)
    onBox.title = '参与合成（取消勾选就跳过这一段）'
    onBox.addEventListener('click', (e) => e.stopPropagation())
    onBox.addEventListener('change', () => {
      s.off = !onBox.checked
      card.classList.toggle('off', !onBox.checked)
      if (s.off) {
        const v = hlPreviewVideos.get(i)
        if (v) {
          try {
            v.pause()
          } catch {}
        }
      }
      refreshHeadUi()
      hlUpdateHint()
      // 预览总长变了，时间轴要回到合法位置
      hpDraw(hpvT)
      setHlStatus(
        `${onBox.checked ? '参与合成' : '不参与合成'}：#${i + 1} ${String(s.name || '').slice(0, 28)}` +
          `（成片现在是 ${hlSegsOn().length} 段 / ${hlTotalDur().toFixed(1)}s）`
      )
    })
    const idx = document.createElement('span')
    idx.className = 'idx'
    idx.textContent = `#${i + 1}`
    const time = document.createElement('span')
    time.className = 'hl-card-time'
    time.textContent = hlSegLabel(s)
    if (s.file) time.title = s.file
    top.appendChild(onBox)
    top.appendChild(idx)
    top.appendChild(time)
    card.appendChild(top)

    if (!(Number(s.dur) > 0.2)) {
      const ph = document.createElement('div')
      ph.className = 'hl-thumb'
      ph.textContent = '读不出时长'
      card.appendChild(ph)
    } else {
      if (!(Number(s.start) >= 0)) s.start = 0
      if (!(Number(s.end) > 0)) s.end = Number(s.dur) || 0
      if (!(Number(s.cur) >= 0)) s.cur = (s.start + s.end) / 2
      const v = document.createElement('video')
      v.className = 'hl-card-vid'
      v.muted = true
      v.loop = true
      v.playsInline = true
      v.preload = 'metadata'
      v.src = 'prmedia://local/?p=' + encodeURIComponent(s.file)
      hlPreviewVideos.set(i, v)
      const d = Number(s.dur) || 0

      const bar = document.createElement('div')
      bar.className = 'hl-card-bar'
      const band = document.createElement('div')
      band.className = 'hl-card-band'
      const hIn = document.createElement('div')
      hIn.className = 'hl-card-h l'
      hIn.title = '起点'
      const hCur = document.createElement('div')
      hCur.className = 'hl-card-h c'
      hCur.title = '中间（只看画面，不改选区）'
      const hOut = document.createElement('div')
      hOut.className = 'hl-card-h r'
      hOut.title = '终点'
      bar.appendChild(band)
      bar.appendChild(hCur)
      bar.appendChild(hIn)
      bar.appendChild(hOut)
      const num = document.createElement('div')
      num.className = 'hl-card-num'

      const paint = () => {
        const dd = d || 1
        const pa = Math.max(0, Math.min(100, (s.start / dd) * 100))
        const pb = Math.max(0, Math.min(100, (s.end / dd) * 100))
        const pc = Math.max(0, Math.min(100, (s.cur / dd) * 100))
        band.style.left = `${pa}%`
        band.style.width = `${Math.max(0, pb - pa)}%`
        hIn.style.left = `${pa}%`
        hOut.style.left = `${pb}%`
        hCur.style.left = `${pc}%`
        hCur.classList.toggle('out', s.cur < s.start - 0.05 || s.cur > s.end + 0.05)
        num.textContent = `${moFmt(s.start)}–${moFmt(s.cur)}–${moFmt(s.end)} · ${hlSegDur(s).toFixed(1)}s`
        time.textContent = hlSegLabel(s)
      }
      // 画面跟着手走：拖哪根就 seek 到哪儿（拖动期间暂停，松手后原来在播就继续播）
      const drag = (which) => (ev0) => {
        ev0.preventDefault()
        ev0.stopPropagation()
        hlSelect(i)
        const wasPlaying = !v.paused && which !== 'cur'
        try {
          v.pause()
        } catch {}
        let raf = 0
        let seekTo = -1
        const flush = () => {
          raf = 0
          if (seekTo < 0) return
          const t = seekTo
          seekTo = -1
          try {
            if (Math.abs(Number(v.currentTime) - t) > 0.02) v.currentTime = t
          } catch {}
        }
        const move = (ev) => {
          const r = bar.getBoundingClientRect()
          const ratio = r.width > 0 ? Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) : 0
          const sec = ratio * d
          if (which === 'in') s.start = Math.max(0, Math.min(sec, s.end - 0.2))
          else if (which === 'out') s.end = Math.min(d, Math.max(sec, s.start + 0.2))
          else s.cur = Math.max(0, Math.min(d, sec))
          paint()
          seekTo = which === 'in' ? s.start : which === 'out' ? Math.max(s.start, s.end - 0.05) : s.cur
          if (!raf) raf = requestAnimationFrame(flush)
        }
        move(ev0)
        const up = () => {
          window.removeEventListener('pointermove', move, true)
          window.removeEventListener('pointerup', up, true)
          if (raf) {
            cancelAnimationFrame(raf)
            raf = 0
          }
          flush()
          // 改完两端：预览点跑出选区就放回中间，并把「合并导出」上的总长重新算一遍
          if (which !== 'cur' && (s.cur < s.start || s.cur >= s.end - 0.03)) {
            s.cur = Math.round(((s.start + s.end) / 2) * 100) / 100
            paint()
          }
          refreshHeadUi()
          hpDraw(hpvT)
          if (wasPlaying) {
            try {
              if (v.currentTime < s.start || v.currentTime >= s.end) v.currentTime = s.start
              const p = v.play()
              if (p && p.catch) p.catch(() => {})
            } catch {}
          }
        }
        window.addEventListener('pointermove', move, true)
        window.addEventListener('pointerup', up, true)
      }
      hIn.addEventListener('pointerdown', drag('in'))
      hOut.addEventListener('pointerdown', drag('out'))
      hCur.addEventListener('pointerdown', drag('cur'))
      bar.addEventListener('pointerdown', (ev) => {
        if (ev.target === hIn || ev.target === hOut || ev.target === hCur) return
        drag('cur')(ev)
      })

      v.addEventListener('loadedmetadata', () => {
        try {
          v.currentTime = Math.max(0, Math.min(s.cur, Math.max(0, d - 0.05)))
        } catch {}
        paint()
      })
      v.addEventListener('timeupdate', () => {
        if (v.paused) return
        if (v.currentTime >= s.end - 0.03) {
          v.currentTime = s.start + 0.01
          return
        }
        if (v.currentTime < s.start - 0.05) v.currentTime = s.start + 0.01
        s.cur = v.currentTime
        paint()
      })
      v.addEventListener('click', (ev) => {
        ev.stopPropagation()
        hlSelect(i)
        if (v.paused) {
          try {
            if (v.currentTime < s.start || v.currentTime >= s.end) v.currentTime = s.start
          } catch {}
          const p = v.play()
          if (p && p.catch) p.catch(() => {})
        } else {
          v.pause()
        }
      })

      card.appendChild(v)
      card.appendChild(bar)
      card.appendChild(num)
      // 这一段自己的原声音量（导出时按它给音频加 volume；预览按它设 <video>.volume）
      const volRow = document.createElement('div')
      volRow.className = 'hl-card-vol-row'
      const volIcon = document.createElement('span')
      volIcon.className = 'hl-card-vol-icon'
      volIcon.textContent = '🔊'
      const volEl = document.createElement('input')
      volEl.type = 'range'
      volEl.min = '0'
      volEl.max = '200'
      volEl.step = '5'
      volEl.className = 'hl-card-vol'
      volEl.value = String(Math.round((Number(s.vol) || 1) * 100))
      volEl.title = '这一段的原声音量（0–200%；预览最多按 100% 放，导出会真的放大/压小）'
      const volVal = document.createElement('b')
      volVal.className = 'hl-card-volval'
      volVal.textContent = `${volEl.value}%`
      volEl.addEventListener('click', (ev) => ev.stopPropagation())
      volEl.addEventListener('pointerdown', (ev) => ev.stopPropagation())
      volEl.addEventListener('input', () => {
        s.vol = Math.max(0, Math.min(2, Number(volEl.value) / 100))
        volVal.textContent = `${volEl.value}%`
        applySegVolumeToPreview(s)
        refreshHeadUi()
      })
      volRow.appendChild(volIcon)
      volRow.appendChild(volEl)
      volRow.appendChild(volVal)
      card.appendChild(volRow)
      paint()
    }

    const ops = document.createElement('div')
    ops.className = 'hl-card-ops'
    const play = document.createElement('button')
    play.type = 'button'
    play.className = 'ghost'
    play.textContent = '▶'
    play.title = '在卡片里播这一段'
    play.addEventListener('click', (e) => {
      e.stopPropagation()
      hlSelect(i)
      const v = hlPreviewVideos.get(i)
      if (!v) return
      if (v.paused) {
        try {
          if (v.currentTime < s.start || v.currentTime >= s.end) v.currentTime = s.start
        } catch {}
        const p = v.play()
        if (p && p.catch) p.catch(() => {})
      } else {
        v.pause()
      }
    })
    const edit = document.createElement('button')
    edit.type = 'button'
    edit.className = 'ghost'
    edit.textContent = '✎'
    edit.title = '全屏细剪：把这个视频放到全屏里放大再调（卡片上的把手就能粗调）'
    edit.addEventListener('click', (e) => {
      e.stopPropagation()
      hlSelect(i)
      trimOpen(i)
    })
    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'ghost'
    del.textContent = '✕'
    del.title = '删掉这一段'
    del.addEventListener('click', (e) => {
      e.stopPropagation()
      hlSegs.splice(i, 1)
      if (hlSelIdx >= hlSegs.length) hlSelIdx = hlSegs.length - 1
      renderHlList()
      refreshHeadUi()
      hpDraw(hpvT)
    })
    ops.appendChild(play)
    ops.appendChild(edit)
    ops.appendChild(del)
    card.appendChild(ops)
    card.addEventListener('click', () => hlSelect(i))
    list.appendChild(card)
  })
}


/* ===== 全屏细剪：把选中的片段放到全屏，拖左右两端 ===== */
let trimVideo = null
let trimIdx = -1
let trimIn = 0
let trimOut = 0
let trimPlaying = false
let trimRaf = 0
let trimT0 = 0
/** 细剪画面当前停在哪一秒（seek 是异步的：键盘要按"刚才要的位置"算，不能直接读 currentTime） */
let trimCur = 0

function trimCanvas() {
  return document.getElementById('hl-trim-canvas')
}

function trimIsOpen() {
  const el = document.getElementById('hl-trim')
  return Boolean(el && !el.classList.contains('hidden'))
}

function trimSyncCanvas() {
  const c = trimCanvas()
  if (!c) return
  const host = c.parentElement
  const ratio = trimVideo && trimVideo.videoWidth && trimVideo.videoHeight ? trimVideo.videoWidth / trimVideo.videoHeight : 16 / 9
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const cw = host ? host.clientWidth : 0
  const ch = host ? host.clientHeight : 0
  // 用能放下整块画面的最大尺寸做后备分辨率（别拉伸糊）
  let H = ch > 0 ? Math.round(ch * dpr) : 720
  let W = Math.round(H * ratio)
  if (cw > 0 && W > cw * dpr) {
    W = Math.round(cw * dpr)
    H = Math.round(W / ratio)
  }
  W = Math.max(320, Math.min(2560, W))
  H = Math.max(2, Math.round(H / 2) * 2)
  if (c.width !== W || c.height !== H) {
    c.width = W
    c.height = H
  }
}

function trimDraw() {
  const c = trimCanvas()
  if (!c) return
  const ctx = c.getContext('2d')
  const W = c.width
  const H = c.height
  const v0 = trimVideo
  // 拖把手时解码器正在 seek，没有可用帧：这时不清屏，保留上一帧（否则一直闪黑）
  if (v0 && v0.seeking) {
    trimUpdateUi(Number(v0.currentTime) || 0, Number.isFinite(v0.duration) ? v0.duration : 0)
    return
  }
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, W, H)
  const v = trimVideo
  if (v && v.readyState >= 2 && v.videoWidth) {
    const s = Math.min(W / v.videoWidth, H / v.videoHeight)
    ctx.drawImage(v, (W - v.videoWidth * s) / 2, (H - v.videoHeight * s) / 2, v.videoWidth * s, v.videoHeight * s)
  }
  const dur = v && Number.isFinite(v.duration) ? v.duration : 0
  const cur = v ? Number(v.currentTime) || 0 : 0
  if (v && !v.seeking) trimCur = cur
  // 画面上一律不叠加任何遮罩 / 边界线：选区只靠下面时间轴的色带、两个把手和左下角文字表达，
  // 视频画面保持原样（以前这里先压 45% 黑，后来改成两条绿/黄细线，用户反馈都多余）
  // 角标
  const fs = Math.max(12, Math.round(W / 44))
  const pad = Math.max(6, Math.round(W / 120))
  ctx.font = `600 ${fs}px system-ui, "Microsoft YaHei", sans-serif`
  ctx.textBaseline = 'top'
  const txt = `段内 ${moFmt(cur - trimIn)} / ${(trimOut - trimIn).toFixed(1)}s　原片 ${moFmt(cur)} / ${moFmt(dur)}`
  const bw = Math.min(W - pad * 2, ctx.measureText(txt).width + pad * 3)
  ctx.fillStyle = 'rgba(8,10,14,0.7)'
  ctx.fillRect(pad, pad, bw, fs + pad * 2)
  ctx.fillStyle = '#ffd18a'
  ctx.fillText(txt, pad * 2, pad * 2)
  trimUpdateUi(cur, dur)
}

/* ----- 全屏细剪进度条：默认只铺开"这一段"，方便细调 ----- */
let trimViewIn = 0
let trimViewOut = 0

/** 细剪进度条当前显示的时间范围（默认 = 这一段左右各留 50% 余量；可滚轮缩放） */
function trimViewRange() {
  const d = trimVideo && Number.isFinite(trimVideo.duration) ? trimVideo.duration : 0
  if (!d) return { a: 0, b: 1, span: 1, zoom: 1 }
  let a = Number.isFinite(trimViewIn) ? trimViewIn : 0
  let b = Number.isFinite(trimViewOut) ? trimViewOut : 0
  if (!(b - a > 0.2)) {
    a = 0
    b = d
  }
  a = Math.max(0, Math.min(Math.max(0, d - 0.2), a))
  b = Math.min(d, Math.max(a + 0.2, b))
  return { a, b, span: b - a, zoom: d / (b - a) }
}

/** 设置细剪进度条的显示范围 */
function setTrimView(a, b) {
  const d = trimVideo && Number.isFinite(trimVideo.duration) ? trimVideo.duration : 0
  if (!d) return
  const want = Math.max(0.2, Math.min(d, (Number(b) || 0) - (Number(a) || 0)))
  let mid = ((Number(a) || 0) + (Number(b) || 0)) / 2
  if (!Number.isFinite(mid)) mid = d / 2
  const x = Math.round(Math.max(0, Math.min(d - want, mid - want / 2)) * 1000) / 1000
  trimViewIn = x
  trimViewOut = Math.round((x + want) * 1000) / 1000
  trimUpdateUi(trimCur, d)
}

/** 默认视图：只铺开这一段 + 左右各 50% 余量（余量最少 2s），这样把手有地方往外拖 */
function trimViewFitClip() {
  const d = trimVideo && Number.isFinite(trimVideo.duration) ? trimVideo.duration : 0
  if (!d) return
  const len = Math.max(0.3, trimOut - trimIn)
  const pad = Math.max(2, len * 0.5)
  setTrimView(Math.max(0, trimIn - pad), Math.min(d, trimOut + pad))
}

/** 以 at 为中心缩放细剪进度条：factor < 1 放大 */
function trimZoom(factor, at) {
  const d = trimVideo && Number.isFinite(trimVideo.duration) ? trimVideo.duration : 0
  if (!d) return
  const { a, b, span } = trimViewRange()
  const center = Number.isFinite(at) ? at : (trimIn + trimOut) / 2
  const nextSpan = Math.max(0.2, Math.min(d, span * factor))
  const frac = span > 0 ? Math.max(0, Math.min(1, (center - a) / span)) : 0.5
  const left = center - frac * nextSpan
  setTrimView(left, left + nextSpan)
  const z = d / nextSpan
  const hint = document.getElementById('hl-trim-hint')
  if (hint) {
    hint.textContent = `进度条 ×${z < 10 ? z.toFixed(1).replace(/\.0$/, '') : Math.round(z)}（${moFmt(trimViewIn)}–${moFmt(trimViewOut)}）· 滚轮缩放，双击进度条回到整条原片，` +
      '拖左右两个把手细调两端；满意点「✓ 保存」。'
  }
}

function trimViewReset() {
  const d = trimVideo && Number.isFinite(trimVideo.duration) ? trimVideo.duration : 0
  trimViewIn = 0
  trimViewOut = d
  trimUpdateUi(trimCur, d)
}

function trimUpdateUi(cur, dur) {
  const d = dur || (trimVideo && Number.isFinite(trimVideo.duration) ? trimVideo.duration : 0) || 1
  // 进度条可能只铺开这一段（缩放）：像素按当前可视范围换算
  const { a, span, zoom } = trimViewRange()
  const pct = (t) => `${Math.max(0, Math.min(100, ((t - a) / span) * 100)).toFixed(2)}%`
  const band = document.getElementById('hl-trim-band')
  const hin = document.getElementById('hl-trim-hin')
  const hout = document.getElementById('hl-trim-hout')
  if (band) {
    const visIn = Math.max(a, trimIn)
    const visOut = Math.min(a + span, trimOut)
    const hide = visOut <= visIn
    band.classList.toggle('hidden', hide)
    if (!hide) {
      band.style.left = pct(visIn)
      band.style.width = `${Math.max(0, ((visOut - visIn) / span) * 100).toFixed(2)}%`
    }
  }
  if (hin) {
    const hide = trimIn < a - 0.001 || trimIn > a + span + 0.001
    hin.classList.toggle('hidden', hide)
    if (!hide) hin.style.left = pct(trimIn)
  }
  if (hout) {
    const hide = trimOut < a - 0.001 || trimOut > a + span + 0.001
    hout.classList.toggle('hidden', hide)
    if (!hide) hout.style.left = pct(trimOut)
  }
  const zEl = document.getElementById('hl-trim-zoom')
  if (zEl) {
    const z = zoom < 10 ? zoom.toFixed(1).replace(/\.0$/, '') : String(Math.round(zoom))
    zEl.textContent = `×${z}`
    zEl.classList.toggle('on', zoom > 1.02)
  }
  const spanEl = document.getElementById('hl-trim-span')
  if (spanEl) spanEl.textContent = `${moFmt(trimIn)}–${moFmt(trimOut)}（${(trimOut - trimIn).toFixed(1)}s）`
  const seek = document.getElementById('hl-trim-seek')
  if (seek && !seek.dataset.dragging && Number.isFinite(cur)) {
    seek.value = String(Math.round(Math.max(0, Math.min(1, (cur - a) / span)) * 1000) || 0)
  }
}

function trimSetRange(a, b) {
  const dur = trimVideo && Number.isFinite(trimVideo.duration) ? trimVideo.duration : 0
  let x = Math.max(0, Math.min(dur || 0, Number(a) || 0))
  let y = Math.max(0, Math.min(dur || 0, Number(b) || 0))
  if (y - x < 0.2) y = Math.min(dur || 0, x + 0.2)
  if (y - x < 0.2) x = Math.max(0, y - 0.2)
  trimIn = x
  trimOut = y
  trimDraw()
}

function trimSeek(t) {
  if (!trimVideo) return
  // 画布只给看选区里的帧：往选区外拖一律夹回边界（时间轴本身仍是整条片，把手照旧能拖）
  const v = trimClampT(t)
  trimCur = v
  try {
  seekMediaLazy(trimVideo, v)
  } catch {}
  if (trimPlaying) trimT0 = performance.now() - v * 1000
  trimDraw()
}

/** 细剪范围内夹取：画布只给看 [trimIn, trimOut] 之间的帧 */
function trimClampT(t) {
  const dur = Number.isFinite(trimVideo && trimVideo.duration) ? trimVideo.duration : 0
  let x = Math.max(0, Math.min(dur, Number(t) || 0))
  const lo = Math.min(trimIn, trimOut)
  const hi = Math.max(trimIn, trimOut)
  if (hi - lo > 0.05) {
    if (x < lo) x = lo
    else if (x > hi) x = hi
  }
  return x
}

/** 细剪播放到 trimOut 就跳回 trimIn（rAF 和 timeupdate 都调，慢帧也不越界） */
function trimEnforceRange() {
  const v = trimVideo
  if (!v || !trimPlaying) return false
  if (v.currentTime < trimOut - 0.03) return false
  try {
    v.currentTime = trimIn
  } catch {}
  return true
}

function trimLoop() {
  trimRaf = 0
  if (!trimPlaying || !trimVideo) return
  // 只播这一段：到终点直接跳回起点接着播（播的是将来导出的那一段，不是整条原片）
  if (trimEnforceRange()) {
    trimDraw()
    trimRaf = requestAnimationFrame(trimLoop)
    return
  }
  trimDraw()
  trimRaf = requestAnimationFrame(trimLoop)
}

function trimTogglePlay() {
  if (!trimVideo) return
  const btn = document.getElementById('hl-trim-play')
  if (trimPlaying) {
    trimPlaying = false
    if (trimRaf) cancelAnimationFrame(trimRaf)
    trimRaf = 0
    try {
      trimVideo.pause()
    } catch {}
    if (btn) btn.textContent = '▶ 播放'
    return
  }
  try {
    if (trimVideo.currentTime < trimIn || trimVideo.currentTime >= trimOut - 0.05) trimVideo.currentTime = trimIn
    trimVideo.play().catch(() => {})
  } catch {}
  trimT0 = performance.now()
  trimPlaying = true
  if (btn) btn.textContent = '⏸ 暂停'
  if (!trimRaf) trimRaf = requestAnimationFrame(trimLoop)
}

function trimWireHandle(id, which) {
  const el = document.getElementById(id)
  if (!el) return
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    e.stopPropagation()
    const track = document.getElementById('hl-trim-track')
    if (!track) return
    try {
      el.setPointerCapture(e.pointerId)
    } catch {}
    if (trimPlaying) trimTogglePlay()
    const move = (ev) => {
      const r = track.getBoundingClientRect()
      if (!r.width) return
      const frac = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width))
      // 进度条默认只铺开这一段（缩放）：像素按当前可视范围换算成秒
      const { a, span } = trimViewRange()
      const t = a + frac * span
      if (which === 'in') trimSetRange(Math.min(t, trimOut - 0.2), trimOut)
      else trimSetRange(trimIn, Math.max(t, trimIn + 0.2))
      trimSeek(which === 'in' ? trimIn : trimOut)
      trimUpdateUi(trimCur, Number.isFinite(trimVideo && trimVideo.duration) ? trimVideo.duration : 0)
    }
    const up = () => {
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', up, true)
    }
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', up, true)
    move(e)
  })
}

/** 打开全屏细剪 */
function trimOpen(idx) {
  const seg = hlSegs[idx]
  const path = seg && seg.file ? seg.file : ''
  if (!seg || !path) {
    setHlStatus('这一格还没有素材文件（读不出时长的会被跳过），先 ✕ 删掉再加一次', 'warn')
    return
  }
  trimIdx = idx
  trimIn = Number(seg.start) >= 0 ? Number(seg.start) : 0
  trimOut = Number(seg.end) > 0 ? Number(seg.end) : Number(seg.dur) || 0
  const box = document.getElementById('hl-trim')
  const title = document.getElementById('hl-trim-title')
  if (title) title.textContent = `细剪 #${idx + 1} · ${String(path).split(/[\\/]/).pop()}`
  if (box) box.classList.remove('hidden')
  // 用独立的播放器（不碰卡片里那些小画面）
  if (!trimVideo) {
    const v = document.createElement('video')
    v.src = 'prmedia://local/?p=' + encodeURIComponent(path)
    v.crossOrigin = 'anonymous'
    v.preload = 'auto'
    v.muted = true
    v.playsInline = true
    v.style.display = 'none'
    v.addEventListener('loadedmetadata', () => {
      trimSyncCanvas()
      trimViewFitClip()
      trimSeek(trimIn)
    })
    v.addEventListener('seeked', () => {
      if (!trimPlaying) trimDraw()
    })
    wireSeekChain(v, () => {
      if (!trimPlaying) trimDraw()
    })
    // rAF 掉帧时也别让画面播过 trimOut（timeupdate 兜底）
    v.addEventListener('timeupdate', () => {
      if (trimPlaying && trimEnforceRange()) trimDraw()
    })
    document.body.appendChild(v)
    trimVideo = v
  } else if (trimVideo.dataset.path !== path) {
    try {
      trimVideo.pause()
      trimVideo.src = 'prmedia://local/?p=' + encodeURIComponent(path)
      trimVideo.dataset.path = path
    } catch {}
  }
  trimVideo.dataset.path = path
  trimCur = trimIn
  trimViewFitClip()
  trimSyncCanvas()
  requestAnimationFrame(() => {
    trimSyncCanvas()
    trimViewFitClip()
    trimSeek(trimIn)
  })
}

function trimClose() {
  if (trimPlaying) trimTogglePlay()
  const box = document.getElementById('hl-trim')
  if (box) box.classList.add('hidden')
  trimIdx = -1
}

function trimSave() {
  if (trimIdx < 0 || !hlSegs[trimIdx]) {
    trimClose()
    return
  }
  const c = trimCanvas()
  let thumb = hlSegs[trimIdx].thumb || ''
  try {
    if (c) thumb = c.toDataURL('image/jpeg', 0.6)
  } catch {}
  // 只改起点/终点/缩略图：本地片段文件的 file/name/dur 必须原样留着
  const a2 = Math.round(trimIn * 100) / 100
  const b2 = Math.round(trimOut * 100) / 100
  const oldCur = Number(hlSegs[trimIdx].cur) || 0
  // 预览点（中间那根白线）要留在新选区里；跑到边上就放回中间
  let cur2 = Math.max(a2, Math.min(b2, oldCur))
  if (cur2 >= b2 - 0.05) cur2 = Math.round(((a2 + b2) / 2) * 100) / 100
  hlSegs[trimIdx] = {
    ...hlSegs[trimIdx],
    start: a2,
    end: b2,
    cur: cur2,
    thumb
  }
  renderHlList()
  refreshHeadUi()
  hpDraw(hpvT)
  setHlStatus(`#${trimIdx + 1} 已改成 ${moFmt(trimIn)}–${moFmt(trimOut)}（${(trimOut - trimIn).toFixed(1)}s）`)
  trimClose()
}

function hlSelect(i) {
  hlSelIdx = Number.isInteger(i) && i >= 0 && i < hlSegs.length ? i : -1
  // ⚠️ 这里不能整表重排：拖卡片上的把手时，重排会把正在拖的那张卡（连同它的 <video>）换掉，
  // 拖动闭包就指到已脱离文档的旧节点，坐标全变 0 → 选区会被写成 0–0.2。
  // 只切换 .active，整表重排留给"增删片段"的时候。
  const list = document.getElementById('hl-list')
  const cards = list ? [...list.querySelectorAll('.hl-card')] : []
  if (cards.length) {
    cards.forEach((el, idx) => el.classList.toggle('active', idx === hlSelIdx))
  } else {
    renderHlList()
  }
}


function wireHeadPane() {
  // 片头图片：选择 / 清除
  const pick = document.getElementById('head-pick')
  if (pick) {
    pick.addEventListener('click', async () => {
      try {
        const res = await window.pr.recPickImage()
        if (res && res.ok) {
          headImagePath = res.path
          rememberHeadFile('img', headImagePath)
          refreshHeadUi()
          setHeadStatus('图片已选：' + String(res.path).split(/[\\/]/).pop())
          await hpLoadImage(headImagePath)
          hpDraw(hpvT)
        }
      } catch {}
    })
  }
  const clearImg = document.getElementById('head-clear-img')
  if (clearImg) {
    clearImg.addEventListener('click', () => {
      headImagePath = ''
      refreshHeadUi()
      setHeadStatus('')
      hpLoadImage('').then(() => hpDraw(hpvT))
    })
  }
  // 秒数 / 硬件编码
  const secEl = document.getElementById('head-sec')
  if (secEl) {
    secEl.addEventListener('change', () => {
      refreshHeadUi()
      hpDraw(hpvT)
    })
    secEl.addEventListener('input', () => refreshHeadUi())
  }
  const nv = document.getElementById('head-nvenc')
  if (nv) nv.addEventListener('change', () => refreshHeadUi())
  // 背景音：选择 / 清除 / 音量
  const bgmPick = document.getElementById('head-bgm-pick')
  if (bgmPick) {
    bgmPick.addEventListener('click', async () => {
      try {
        const res = await window.pr.pickLocalFiles('media')
        const f = res && res.ok && Array.isArray(res.files) ? res.files.find((x) => x && x.path) : null
        if (!f) {
          if (res && res.canceled) return
          setHeadStatus('没选到音频文件（mp3 / m4a / wav）', 'warn')
          return
        }
        headBgmPath = f.path
        rememberHeadFile('bgm', headBgmPath)
        refreshHeadUi()
        // 预览正在播的话立刻把这段背景音接进预览（后选也能听到）
        hpSyncBgm()
        setHeadStatus('背景音：' + String(f.path).split(/[\\/]/).pop() + (hpvPlaying ? '（已接进正在播放的预览）' : ''))
      } catch (err) {
        setHeadStatus('选背景音失败：' + ((err && err.message) || err), 'err')
      }
    })
  }
  const bgmClear = document.getElementById('head-bgm-clear')
  if (bgmClear) {
    bgmClear.addEventListener('click', () => {
      headBgmPath = ''
      // 正在预览的话立刻把背景音停掉
      hpSyncBgm()
      refreshHeadUi()
      setHeadStatus('已清掉背景音')
    })
  }
  const bgmVol = document.getElementById('head-bgm-vol')
  if (bgmVol) {
    const sync = () => {
      const val = document.getElementById('head-bgm-volval')
      if (val) val.textContent = `${bgmVol.value}%`
      if (hpBgm) hpBgm.volume = headBgmVolume()
    }
    bgmVol.addEventListener('input', sync)
    sync()
  }

  // 片段区：加入勾选 / 按时间戳排序 / 加本地片段 / 全屏细剪
  const addPickedBtn = document.getElementById('hl-add-picked')
  if (addPickedBtn) addPickedBtn.addEventListener('click', () => hlAddPickedVideos())
  const sortStampBtn = document.getElementById('hl-sort-stamp')
  if (sortStampBtn) {
    sortStampBtn.addEventListener('click', () => {
      if (hlSegs.length < 2) {
        setHlStatus('至少两段才好排序', 'warn')
        return
      }
      hlSortByTimestamp()
      renderHlList()
      hlReveal()
      setHlStatus(`已按文件名时间戳重排 ${hlSegs.length} 段（时间戳在第一段：${hlSegLabel(hlSegs[0])}）`)
    })
  }
  const pickFilesBtn = document.getElementById('hl-pick-files')
  if (pickFilesBtn) pickFilesBtn.addEventListener('click', () => hlAddLocalFiles())
  const clearBtn = document.getElementById('hl-clear')
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (!hlSegs.length) {
        setHlStatus('列表本来就是空的', 'warn')
        return
      }
      if (!window.confirm(`把「要合并的片段」里的 ${hlSegs.length} 段全部清掉？\n\n只清这个列表，磁盘上的文件不动。`)) return
      const n = hlSegs.length
      hlSegs = []
      hlSelIdx = -1
      // 预览用的播放器 / 状态也一起复位
      try {
        if (hpvVideo) hpvVideo.pause()
      } catch {}
      renderHlList()
      refreshHeadUi()
      hpSyncTextUi()
      hpDraw(hpvT)
      hlReveal()
      setHlStatus(`已清空列表（${n} 段，文件都还在磁盘上）`)
    })
  }
  const allOnBtn = document.getElementById('hl-all-on')
  if (allOnBtn) {
    allOnBtn.addEventListener('click', () => {
      if (!hlSegs.length) {
        setHlStatus('还没有片段', 'warn')
        return
      }
      for (const s of hlSegs) s.off = false
      renderHlList()
      refreshHeadUi()
      hpDraw(hpvT)
      setHlStatus(`已把 ${hlSegs.length} 段全部设成参与合成（共 ${hlTotalDur().toFixed(1)}s）`)
    })
  }
  // 片头图 / 背景音 的使用记录
  const imgRecent = document.getElementById('head-img-recent')
  if (imgRecent) imgRecent.addEventListener('click', () => showHeadRecentMenu('img', imgRecent))
  const bgmRecent = document.getElementById('head-bgm-recent')
  if (bgmRecent) bgmRecent.addEventListener('click', () => showHeadRecentMenu('bgm', bgmRecent))
  const miniFull = document.getElementById('hl-mini-full')
  if (miniFull) {
    miniFull.addEventListener('click', () => {
      if (hlSelIdx < 0) {
        setHlStatus('先在下面点一个片段卡片', 'warn')
        return
      }
      trimOpen(hlSelIdx)
    })
  }

  // 导出
  const applyBtn = document.getElementById('head-apply')
  if (applyBtn) applyBtn.addEventListener('click', () => headApply())

  // 预览：播放 / 暂停 + 进度条 + 全屏
  const prevBtn = document.getElementById('head-prev-play')
  if (prevBtn) prevBtn.addEventListener('click', () => hpTogglePreview())
  const prevSeek = document.getElementById('head-prev-seek')
  if (prevSeek) {
    prevSeek.addEventListener('pointerdown', () => {
      prevSeek.dataset.dragging = '1'
    })
    prevSeek.addEventListener('pointerup', () => {
      delete prevSeek.dataset.dragging
      prevSeek.blur()
    })
    prevSeek.addEventListener('input', () => {
      if (!prevSeek.dataset.dragging) return
      const total = hpTotal()
      hpSeek((Number(prevSeek.value) / 1000) * total)
    })
  }
  const fsBtn = document.getElementById('head-prev-fs')
  if (fsBtn) fsBtn.addEventListener('click', () => hpToggleFs())
  const exitFs = document.getElementById('hp-exit-fs')
  if (exitFs) exitFs.addEventListener('click', () => hpToggleFs())
  // 全屏预览那一条控制栏
  const fsPlay = document.getElementById('hp-fs-play')
  if (fsPlay) fsPlay.addEventListener('click', () => hpTogglePreview())
  const fsClose = document.getElementById('hp-fs-close')
  if (fsClose) fsClose.addEventListener('click', () => hpToggleFs())
  const fsSeek = document.getElementById('hp-fs-seek')
  if (fsSeek) {
    fsSeek.addEventListener('pointerdown', () => {
      fsSeek.dataset.dragging = '1'
    })
    fsSeek.addEventListener('pointerup', () => {
      delete fsSeek.dataset.dragging
      fsSeek.blur()
    })
    fsSeek.addEventListener('input', () => {
      if (!fsSeek.dataset.dragging) return
      hpSeek((Number(fsSeek.value) / 1000) * hpTotal())
    })
  }
  const fsCanvas = document.getElementById('head-fs-canvas')
  if (fsCanvas) {
    fsCanvas.style.cursor = 'pointer'
    fsCanvas.addEventListener('click', () => hpTogglePreview())
    fsCanvas.addEventListener('dblclick', () => hpToggleFs())
  }
  // 点画布 = 播放 / 暂停
  const cv = hpCanvas()
  if (cv) {
    cv.style.cursor = 'pointer'
    // 命中某条字 → 按住拖动改位置（记住抓取偏移，字不会跳到鼠标底下）；空白处 → 播放 / 暂停
    let dragIdx = -1
    let moved = false
    let grabDx = 0
    let grabDy = 0
    const toCanvas = (ev) => {
      const r = cv.getBoundingClientRect()
      return {
        x: ((ev.clientX - r.left) / Math.max(1, r.width)) * cv.width,
        y: ((ev.clientY - r.top) / Math.max(1, r.height)) * cv.height
      }
    }
    const move = (ev) => {
      const pt = toCanvas(ev)
      const t = headTexts[dragIdx]
      if (!t) return
      moved = true
      const rawX = Math.max(0, Math.min(1, (pt.x + grabDx) / Math.max(1, cv.width)))
      const rawY = Math.max(0, Math.min(1, (pt.y + grabDy) / Math.max(1, cv.height)))
      const snap = hpSnapGuides(rawX, rawY, cv.width, cv.height)
      t.x = snap.x
      t.y = snap.y
      hpTextGuides = snap.guides
      hpDraw(hpvT)
    }
    const up = () => {
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', up, true)
      hpTextGuides = []
      const t = headTexts[dragIdx]
      if (moved && t) setHeadStatus(`「${t.text}」位置：横向 ${(t.x * 100).toFixed(0)}% · 纵向 ${(t.y * 100).toFixed(0)}%`)
      dragIdx = -1
      cv.style.cursor = 'grab'
      hpDraw(hpvT)
    }
    cv.addEventListener('pointerdown', (ev) => {
      const pt = toCanvas(ev)
      dragIdx = hpTextHit(pt.x, pt.y)
      moved = false
      if (dragIdx >= 0) {
        ev.preventDefault()
        ev.stopPropagation()
        headTextSel = dragIdx
        const tt = headTexts[dragIdx]
        grabDx = Math.max(0, Math.min(1, Number(tt.x) || 0)) * cv.width - pt.x
        grabDy = Math.max(0, Math.min(1, Number(tt.y) || 0)) * cv.height - pt.y
        hpSyncTextUi()
        hpDraw(hpvT)
        cv.style.cursor = 'grabbing'
        window.addEventListener('pointermove', move, true)
        window.addEventListener('pointerup', up, true)
      }
    })
    cv.addEventListener('pointermove', (ev) => {
      if (dragIdx >= 0) return
      const pt = toCanvas(ev)
      // 悬停在字上给个抓手光标
      cv.style.cursor = hpTextHit(pt.x, pt.y) >= 0 ? 'grab' : 'pointer'
    })
    // 空白处单击 = 播放 / 暂停（真的拖动过字就不算点击）
    cv.addEventListener('click', () => {
      if (moved) {
        moved = false
        return
      }
      hpTogglePreview()
    })
  }

  // 图片文字：「＋ 加字」加一条占位文字后直接进编辑界面，「🎨 文字编辑…」只打开编辑界面
  const textAdd = document.getElementById('head-text-add')
  if (textAdd) {
    textAdd.addEventListener('click', () => {
      if (headAddText()) hlTextOpen()
    })
  }
  const textOpen = document.getElementById('head-text-open')
  if (textOpen) textOpen.addEventListener('click', () => hlTextOpen())
  hlTextWire()
  hpSyncTextUi()

  // 全屏细剪：按钮 + 两个把手 + 进度条
  {
    const tPlay = document.getElementById('hl-trim-play')
    if (tPlay) tPlay.addEventListener('click', () => trimTogglePlay())
    const tIn = document.getElementById('hl-trim-in')
    if (tIn) {
      tIn.addEventListener('click', () => {
        const cur = trimVideo ? Number(trimVideo.currentTime) || 0 : 0
        trimSetRange(Math.min(cur, trimOut - 0.2), trimOut)
      })
    }
    const tOut = document.getElementById('hl-trim-out')
    if (tOut) {
      tOut.addEventListener('click', () => {
        const cur = trimVideo ? Number(trimVideo.currentTime) || 0 : 0
        trimSetRange(trimIn, Math.max(cur, trimIn + 0.2))
      })
    }
    const tSave = document.getElementById('hl-trim-save')
    if (tSave) tSave.addEventListener('click', () => trimSave())
    const tClose = document.getElementById('hl-trim-close')
    if (tClose) tClose.addEventListener('click', () => trimClose())
    const tSeek = document.getElementById('hl-trim-seek')
    if (tSeek) {
      tSeek.addEventListener('pointerdown', () => {
        tSeek.dataset.dragging = '1'
      })
      tSeek.addEventListener('pointerup', () => {
        delete tSeek.dataset.dragging
        tSeek.blur()
      })
      tSeek.addEventListener('input', () => {
        if (!tSeek.dataset.dragging) return
        const { a, span } = trimViewRange()
        trimSeek(a + (Number(tSeek.value) / 1000) * span)
      })
    }
    const tTrack = document.getElementById('hl-trim-track')
    if (tTrack) {
      tTrack.addEventListener(
        'wheel',
        (e) => {
          if (!trimVideo || !Number.isFinite(trimVideo.duration)) return
          e.preventDefault()
          const r = tTrack.getBoundingClientRect()
          const frac = r.width ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) : 0.5
          const { a, span } = trimViewRange()
          trimZoom(e.deltaY < 0 ? 0.5 : 2, a + frac * span)
        },
        { passive: false }
      )
      tTrack.addEventListener('dblclick', () => trimViewReset())
    }
    const tZoom = document.getElementById('hl-trim-zoom')
    if (tZoom) tZoom.addEventListener('click', () => trimViewReset())
    trimWireHandle('hl-trim-hin', 'in')
    trimWireHandle('hl-trim-hout', 'out')
  }

  // 尺寸变化：预览画布跟着重算
  window.addEventListener('resize', () => {
    hpSyncCanvasSize()
    hpDraw(hpvT)
  })
  hpSyncCanvasSize()
  hpSyncFsBtn()
  hpLoadImage(headImagePath).then(() => hpDraw(hpvT))
  refreshHeadUi()
  renderHlList()
  window.addEventListener('keydown', onHeadEditKey)
}

/** 图片片头里的键盘：只在剪辑页、没在输入框里打字时生效（片段在手但没在被拖动） */
function onHeadEditKey(e) {
  const viewEdit = document.getElementById('view-edit')
  const paneHead = document.getElementById('rpane-head')
  if (!viewEdit || !paneHead) return
  if (viewEdit.classList.contains('hidden')) return
  if (paneHead.classList.contains('hidden')) return
  if (document.body.classList.contains('mo-fs')) return
  const t = e.target
  const tag = t && t.tagName ? t.tagName : ''
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (t && t.isContentEditable)) return
  const help = document.getElementById('help-dialog')
  if (help && !help.classList.contains('hidden')) return

  // 图片文字编辑界面：它盖在整屏上，只认 Esc 关闭
  if (hlTextIsOpen()) {
    if (e.key === 'Escape') {
      e.preventDefault()
      hlTextClose()
    }
    return
  }

  // 全屏细剪优先：它盖在整屏上
  if (trimIsOpen()) {
    if (!trimVideo) return
    const step = e.shiftKey ? 1 : e.ctrlKey ? 0.1 : 1
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault()
      trimTogglePlay()
      return
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      const dir = e.key === 'ArrowRight' ? 1 : -1
      trimSeek((trimCur || trimIn) + dir * step)
      return
    }
    if (e.key === '[' || e.key === ']') {
      e.preventDefault()
      const cur = trimCur || trimIn
      if (e.key === '[') trimSetRange(Math.min(cur, trimOut - 0.2), trimOut)
      else trimSetRange(trimIn, Math.max(cur, trimIn + 0.2))
      trimSeek(cur)
      return
    }
    if (e.key === '=' || e.key === '+' || e.key === '-' || e.key === '_' || e.key === '0') {
      e.preventDefault()
      if (e.key === '0') trimViewReset()
      else if (e.key === '=' || e.key === '+') trimZoom(0.5, trimCur || trimIn)
      else trimZoom(2, trimCur || trimIn)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      trimClose()
      return
    }
    return
  }

  // 预览：空格播放 / 暂停，左右键挪 1s（Shift 5s）
  if (e.key === ' ' || e.code === 'Space') {
    if (tag === 'BUTTON') return
    e.preventDefault()
    hpTogglePreview()
    return
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault()
    const step = e.shiftKey ? 5 : 1
    hpSeek(hpvT + (e.key === 'ArrowRight' ? step : -step))
    return
  }
}


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
  wireEditSplitter()
  wireRightTabs()
  wireHeadPane()
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

  // 整窗/全屏录制的音频来自**系统混音**（Electron 的 display-media 只能给 loopback），
  // 所以"录哪几个房间的声音"完全由"哪几个房间在发声"决定。
  // 开录前把每个瓦片的静音状态强推一遍（防止看门狗/页面把音量改回来），并统计。
  const sounding = []
  for (const [uid, t] of tiles) {
    if (t.local || t.camera || t.studio || t.stage) continue
    try {
      applyMute(uid)
    } catch {}
    if (!t.muted && (typeof t.volume !== 'number' || t.volume > 0.01)) {
      sounding.push((t.titleEl && t.titleEl.textContent) || uid)
    }
  }
  console.log(
    '[rec] 整窗/全屏录制的音频＝系统混音，当前出声的房间：',
    sounding.length ? sounding.join('、') : '（一个都没有，这条会是无声音轨）'
  )

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
    // 拼接预览的全屏也一起退（可能是 F11 / 系统方式退掉的）
    if (document.body.classList.contains('mo-fs')) {
      document.body.classList.remove('mo-fs')
      moSyncCanvasSize()
      moSyncFsBtn()
      moDrawFrame(moMaster)
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

  // 「精彩片段小窗」全屏 / 普通窗口都支持：进出全屏只重新摆一下位置，不强行收起
  if (typeof fscSyncFab === 'function') {
    fscSyncFab()
    fscApplyGridSpace()
  }
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

// 主进程转来的 F8：开关「精彩片段小窗」（全屏 / 普通窗口都行，焦点在 guest 里也有效）
if (window.pr.onToggleClipsWin) {
  window.pr.onToggleClipsWin(() => {
    fscShow(!FSC.open)
  })
}

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
  const rooms = [...tiles.values()]
      .filter((t) => !t.camera)
      .map((t) => ({ url: t.url, muted: t.muted, local: t.local ? t.path : undefined, name: t.local ? t.fileName : undefined }))
  // 退出/被强杀时瓦片可能已经被拆掉，这时不要用空列表覆盖已保存的房间
  //（真正"把房间全删掉"走的是 scheduleSave，不受影响）
  if (!rooms.length) return
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
    // 左边的「登录抖音 / 登录虎牙」是操作型页签（没有 data-tab），不参与高亮
    btn.classList.toggle('active', Boolean(btn.dataset.tab) && btn.dataset.tab === name)
  }
  document.getElementById('view-watch').classList.toggle('hidden', name !== 'watch')
  document.getElementById('view-monitor').classList.toggle('hidden', name !== 'monitor')
  document.getElementById('view-edit').classList.toggle('hidden', name !== 'edit')
  const debugView = document.getElementById('view-debug')
  if (debugView) debugView.classList.toggle('hidden', name !== 'debug')
  const aboutView = document.getElementById('view-about')
  if (aboutView) aboutView.classList.toggle('hidden', name !== 'about')
  savePrefs({ tab: name })
  if (name !== 'edit') {
    closeWmPanel()
    closeTaskPanel()
    // 离开剪辑页就把拼接全屏 / 预览全屏退掉，别让黑底预览盖住别的页（连系统全屏一起退）
    if (document.body.classList.contains('mo-fs')) moToggleFullscreen()
    if (typeof hpCloseFs === 'function') hpCloseFs()
    if (typeof hpStop === 'function') hpStop()
  }
  if (name === 'watch') layout()
  // 剪辑页自己就有片段列表：进这一页时把小窗收起来，别再单独浮着一个「精彩小窗」
  if (name === 'edit' && typeof FSC !== 'undefined' && FSC && FSC.open && typeof fscShow === 'function') {
    try {
      fscShow(false)
    } catch {}
  }
  if (typeof fscSyncFab === 'function') fscSyncFab()
  // 切到剪辑页就立刻刷一次（后台轮询在页签隐藏时会暂停）
  if (name === 'edit') {
    refreshEditFiles({ silent: true, force: true }).catch(() => {})
    // 分栏宽度要等这一页真正显示出来才知道可用宽度
    if (typeof applyEditSplitPx === 'function') applyEditSplitPx(editSplitWant, false)
  }
  // 调试页只在显示时刷新，别在后台一直跑
  if (name === 'debug') {
    refreshDebug({ force: true })
    startDebugLoop()
  } else {
    stopDebugLoop()
  }
  // 关于页：进来时读一次版本 / 运行时（不联网、不探测，只是一次 ffmpeg -version，读过就缓存）
  if (name === 'about' && typeof refreshAbout === 'function') {
    refreshAbout().catch(() => {})
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
const dbgLogsEl = document.getElementById('dbg-logs')
const dbgLogErrorsEl = document.getElementById('dbg-log-errors')
/** 日志面板：rec.log / main.log 尾巴 + 级别（error 红 / warn 黄） */
let dbgLogs = null
/** 日志面板自动滚到底（用户自己往上翻时不抢） */
let dbgLogStick = true
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
    if (t.stage) {
      rows.push({
        uid,
        url: (t.fileName || t.url) + (t.stage ? ' · 机位 ' + (t.stage.camIndex + 1) : ''),
        wcId: -1,
        muted: true,
        audible: !!(t.music && !t.music.audio.paused),
        media: {
          count: 1,
          playing: t.stage ? 1 : 0,
          items: [
            {
              tag: 'canvas(stage)',
              paused: !t.stage,
              muted: true,
              volume: 0,
              t: t.music ? Math.round(t.music.audio.currentTime) : 0,
              w: 0,
              h: 0,
              area: 0
            }
          ]
        }
      })
      continue
    }
    if (t.studio) {
      rows.push({
        uid,
        url: t.fileName || t.url,
        wcId: -1,
        muted: true,
        audible: false,
        media: {
          count: 1,
          playing: t.stream ? 1 : 0,
          items: [{ tag: 'canvas(studio)', paused: !t.stream, muted: true, volume: 0, t: 0, w: t.el.querySelector('canvas') ? t.el.querySelector('canvas').width : 0, h: t.el.querySelector('canvas') ? t.el.querySelector('canvas').height : 0, area: t.el.querySelector('canvas') ? Math.round(t.el.querySelector('canvas').getBoundingClientRect().width * t.el.querySelector('canvas').getBoundingClientRect().height) : 0 }]
        }
      })
      continue
    }
    // 本地音视频 / 摄像头瓦片没有 guest，直接读 <video> 自己的状态
    if (t.mediaEl) {
      const m = t.mediaEl
      rows.push({
        uid,
        url: t.fileName || t.url,
        wcId: -1,
        muted: t.muted,
        audible: m ? !m.paused && !m.muted && m.volume > 0 : false,
        media: {
          count: 1,
          playing: m && !m.paused && !m.muted && m.volume > 0 ? 1 : 0,
          items: m
            ? [
                {
                  tag: 'video(local)',
                  paused: !!m.paused,
                  muted: !!m.muted,
                  volume: Math.round((m.volume || 0) * 100) / 100,
                  t: Math.round((m.currentTime || 0) * 10) / 10,
                  w: m.videoWidth || 0,
                  h: m.videoHeight || 0,
                  area: Math.round(m.getBoundingClientRect().width * m.getBoundingClientRect().height)
                }
              ]
            : []
        }
      })
      continue
    }
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

function dbgRenderTiles(rows, bwSnap) {
  if (!dbgTilesEl) return
  /** webContentsId -> 带宽行 */
  const bwMap = new Map()
  for (const r of (bwSnap && bwSnap.rows) || []) bwMap.set(Number(r.webContentsId), r)
  const bwCell = (wcId) => {
    const b = bwMap.get(Number(wcId))
    if (!b) return '—'
    const fmt = (kbps, mbps) => (kbps >= 1024 ? `${(kbps / 1024).toFixed(2)} MB/s` : `${kbps} KB/s`) + ` · ${mbps} Mbps`
    return `<b>${fmt(b.nowKbps, b.nowMbps)}</b><br><span class="dbg-sub">平均 ${b.avgKbps} KB/s · 峰值 ${b.peakKbps} KB/s · 累计 ${b.totalMb} MB</span>`
  }
  if (!rows.length) {
    dbgTilesEl.innerHTML = '<p class="dbg-empty">当前没有打开的观看瓦片。</p>'
    return
  }
  const bwTotal = (bwSnap && bwSnap.total) || null
  dbgTilesEl.innerHTML =
    dbgTable(
      ['直播间', 'guest', '本房间静音', '页面在产生音频', '页面媒体元素数', '同时出声的音源数', '带宽（当前 / 平均 / 累计）', '明细'],
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
            bwCell(r.wcId),
            dbgEsc(detail)
          ]
        }
      })
    ) +
    (bwTotal
      ? `<p class="dbg-note">全部瓦片带宽合计：当前 <b>${bwTotal.nowKbps} KB/s</b>（≈ ${bwTotal.nowMbps} Mbps）· 平均 ${bwTotal.avgKbps} KB/s（≈ ${bwTotal.avgMbps} Mbps）· 统计窗口 ${Math.round(
          ((bwSnap.rows || []).reduce((m, r) => Math.max(m, r.windowSec || 0), 0))
        )} 秒（本地 CDP 字节计数，不含录制进程单独拉流）</p>`
      : '') +
    (() => {
      // 卡顿一眼可见：谁的主线程没应答（页面卡住）、谁的画面停住（缓冲/断流）
      const bad = []
      const now = Date.now()
      for (const [uid, t] of tiles) {
        if (t.local || t.camera || t.studio || t.stage) continue
        const name = roomLabel(t.url)
        if (t.pokeAt && now - t.pokeAt > STUCK_JS_MS) {
          bad.push(`${name} 页面没响应 ${Math.round((now - t.pokeAt) / 1000)} 秒`)
        } else if (t.frozenSince) {
          bad.push(`${name} 画面停住 ${Math.round((now - t.frozenSince) / 1000)} 秒`)
        } else if (t.autoReloadCount) {
          bad.push(`${name} 已自动重载 ${t.autoReloadCount} 次`)
        }
        void uid
      }
      return bad.length ? `<p class="dbg-note"><b class="bad">⚠ 卡顿</b>：${bad.map(dbgEsc).join(' · ')}</p>` : ''
    })()
}

/** 日志行的时间列：本地时间；不是今天的行前面补「月-日」（跨天的老日志一眼能分出来） */
function dbgLogTime(r) {
  const t = String((r && r.t) || '')
  if (!t) return ''
  const day = r.isToday === false && r.day ? `${r.day} ` : ''
  return day + t
}

/** 渲染日志面板：每行按级别上色，error 行加 ERR 标签；「只看错误」时只留 error/warn */
function dbgRenderLogs(payload) {
  if (!dbgLogsEl) return
  const onlyErr = Boolean(dbgLogErrorsEl && dbgLogErrorsEl.checked)
  const files = (payload && payload.files) || []
  const counts = (payload && payload.counts) || { error: 0, warn: 0, info: 0 }
  if (!files.length) {
    dbgLogsEl.innerHTML = '<p class="dbg-empty">没有日志文件</p>'
    return
  }
  const blocks = files.map((f) => {
    const all = f.lines || []
    const rows = onlyErr ? all.filter((r) => r.level === 'error' || r.level === 'warn') : all
    const head =
      `<div class="dbg-log-head">${dbgEsc(f.label)} ` +
      `<span class="dbg-sub">${f.exists ? f.sizeKb + ' KB' : '文件不存在'} · ${dbgEsc(f.path)}</span></div>`
    if (!rows.length) {
      const why = !f.exists ? '（没有这个日志文件）' : onlyErr ? '（没有错误 / 警告）' : '（空）'
      return head + `<p class="dbg-empty">${why}</p>`
    }
    const body = rows
      .map((r) => {
        const tag =
          r.level === 'error'
            ? '<b class="log-err-tag">ERR</b>'
            : r.level === 'warn'
              ? '<b class="log-warn-tag">WARN</b>'
              : '<b class="log-info-tag">·</b>'
        const when = dbgLogTime(r)
        const tip = r.utc ? `日志原文（UTC）：${r.utc}` : ''
        return `<div class="dbg-log-row lv-${r.level}"${tip ? ` title="${dbgEsc(tip)}"` : ''}>${tag}<span class="dbg-log-t">${dbgEsc(when)}</span><span class="dbg-log-x">${dbgEsc(r.text)}</span></div>`
      })
      .join('')
    return head + `<div class="dbg-log-body">${body}</div>`
  })
  const readLines = (files[0] && files[0].lines && files[0].lines.length) || 0
  dbgLogsEl.innerHTML =
    `<p class="dbg-note">合计：<b class="log-err-tag">ERR ${counts.error}</b> · ` +
    `<b class="log-warn-tag">WARN ${counts.warn}</b> · 普通 ${counts.info}（最近 ${readLines} 行 · 时间为本地时间）</p>` +
    blocks.join('')
  if (dbgLogStick) {
    for (const el of dbgLogsEl.querySelectorAll('.dbg-log-body')) el.scrollTop = el.scrollHeight
  }
}

/** webContents 的角色 → 中文标签（决定表格里怎么显示、要不要高亮） */
const DBG_ROLE = {  main: { text: '主窗口', mon: false },
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
    const bwTotal = (snap.bandwidth && snap.bandwidth.total) || null
    const bwText = bwTotal
      ? ` · 带宽 合计 ${bwTotal.nowKbps} KB/s（≈${bwTotal.nowMbps} Mbps）`
      : ''
    dbgSummaryEl.textContent =
      `瓦片 ${tiles.size} · 登记 guest ${(guard.tileGuests || []).length} · 活着的 webview 页面 ${liveWebviews} · ` +
      `在出声的 webContents ${audible} · 进程 ${(snap.processes || []).length} 个 / ${mem.toFixed(1)} MB` +
      bwText +
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
    dbgRenderTiles(media, snap.bandwidth)
    dbgRenderContents(snap.contents, snap.mainWebContentsId)
    dbgRenderLifecycle(snap.lifecycle, snap.mainWebContentsId)
    dbgRenderSide(snap)
    // 日志面板：读一次日志尾巴（错误行标红、警告标黄）
    try {
      dbgLogs = await window.pr.debugLogs({ lines: 120 })
      dbgRenderLogs(dbgLogs)
    } catch (err) {
      if (dbgLogsEl) dbgLogsEl.innerHTML = `<p class="dbg-empty">读日志失败：${dbgEsc(String((err && err.message) || err))}</p>`
    }
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
  // 日志面板：「只看错误」勾了就地重绘（不用等下一轮刷新）
  if (dbgLogErrorsEl) {
    dbgLogErrorsEl.addEventListener('change', () => dbgRenderLogs(dbgLogs))
  }
  // 用户自己往上翻日志时别再自动滚到底
  if (dbgLogsEl) {
    dbgLogsEl.addEventListener('scroll', () => {
      const box = dbgLogsEl.querySelector('.dbg-log-body')
      if (!box) return
      dbgLogStick = box.scrollHeight - box.scrollTop - box.clientHeight < 40
    }, true)
  }
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
  const site = siteOfWatcher(w)
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
      <span class="card-site site-${site.key}" title="这个房间来自 ${site.label}">${site.label}</span>
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

/** 监控卡片上的平台标识：抖音 / 虎牙 / 斗鱼 / 网页 */
const SITE_LABEL = { douyin: '抖音', huya: '虎牙', douyu: '斗鱼', other: '网页' }
function siteOfWatcher(w) {
  const key = platformOf((w && (w.url || w.pageUrl)) || '')
  return { key, label: SITE_LABEL[key] || '网页' }
}

function matchQuery(w, q) {
  if (!q) return true
  // 搜索也认平台名：输入「虎牙」就只剩虎牙的房间
  const hay = [w.name, w.roomId, w.url, w.title, siteOfWatcher(w).label].filter(Boolean).join(' ').toLowerCase()
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
  // 按平台拆一下：一眼看出这一堆里哪几个是抖音、哪几个是虎牙/斗鱼
  if (total) {
    const bySite = new Map()
    for (const w of watchers) {
      const { key, label } = siteOfWatcher(w)
      const cur = bySite.get(key) || { label, all: 0, live: 0 }
      cur.all += 1
      if (w.status === 'live') cur.live += 1
      bySite.set(key, cur)
    }
    const order = ['douyin', 'huya', 'douyu', 'other']
    const bits = []
    for (const key of order) {
      const it = bySite.get(key)
      if (!it) continue
      bits.push(`${it.label} ${it.all}${it.live ? `(在播 ${it.live})` : ''}`)
    }
    if (bits.length > 1) parts.push(bits.join(' / '))
  }
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
 * 两个约定：
 *  1) ★ 特别关注永远排在最前面（不管选哪种排序），剩下的再按所选方式排 —— 关注的那几个
 *     不用每次翻半天。（点 ☆ 变 ★ 会立刻跳到最前面，这是刻意的，只在你点的那一下动）
 *  2) 每种模式最后都用「添加顺序」兜底，这样同一批数据重排多次结果一致，
 *     不会因为 checkedAt 之类的字段每次探测都变而让卡片乱跳。
 */
function sortCards(list) {
  const arr = [...list]
  const byAdded = (a, b) => addedRank(a) - addedRank(b)
  // 第 0 优先级：特别关注 > 其他
  const bySpecial = (a, b) => Number(Boolean(b.special)) - Number(Boolean(a.special))
  if (monitorSort === 'live') {
    arr.sort((a, b) => {
      const sp = bySpecial(a, b)
      if (sp !== 0) return sp
      const s = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
      return s !== 0 ? s : byAdded(a, b)
    })
  } else if (monitorSort === 'name') {
    arr.sort((a, b) => {
      const sp = bySpecial(a, b)
      if (sp !== 0) return sp
      const an = String(a.name || a.title || a.roomId || a.url)
      const bn = String(b.name || b.title || b.roomId || b.url)
      const c = an.localeCompare(bn, 'zh-Hans-CN')
      return c !== 0 ? c : byAdded(a, b)
    })
  } else if (monitorSort === 'recent') {
    arr.sort((a, b) => {
      const sp = bySpecial(a, b)
      if (sp !== 0) return sp
      const c = (b.checkedAt || 0) - (a.checkedAt || 0)
      return c !== 0 ? c : byAdded(a, b)
    })
  } else {
    // added：除了「特别关注在前」，其余完全稳定，状态怎么变都不动位置
    arr.sort((a, b) => {
      const sp = bySpecial(a, b)
      return sp !== 0 ? sp : byAdded(a, b)
    })
  }
  return arr
}

/** 分组标题：「★ 特别关注（3）」「其他（12）」—— 两组都有才显示，免得只有一类时多出一行 */
function makeCardsSep(text) {
  const el = document.createElement('div')
  el.className = 'cards-sep'
  el.textContent = text
  return el
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
  for (const el of [...cardsEl.querySelectorAll('.card, .cards-sep')]) el.remove()

  const sorted = sortCards(visible)
  const specialCount = sorted.filter((w) => w.special).length
  const otherCount = sorted.length - specialCount
  // 两组都有才插分组标题；只有一类时多一行纯属噪音
  const wantSeps = specialCount > 0 && otherCount > 0
  let drewSpecial = false
  let drewOther = false
  for (const w of sorted) {
    if (wantSeps && w.special && !drewSpecial) {
      cardsEl.appendChild(makeCardsSep(`★ 特别关注（${specialCount}）`))
      drewSpecial = true
    } else if (wantSeps && !w.special && !drewOther) {
      cardsEl.appendChild(makeCardsSep(`其他（${otherCount}）`))
      drewOther = true
    }
    cardsEl.appendChild(buildCard(w))
  }

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
  // 只给真正的页签绑切换：登录抖音 / 登录虎牙 没有 data-tab，它们各自有开窗的处理
  for (const btn of document.querySelectorAll('#tabs .tab[data-tab]')) {
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
      // 本地音视频瓦片：按路径恢复
      if (r && typeof r.local === 'string' && r.local) {
        addLocalTile(r.local, { muted: r.muted === true, name: r.name })
        continue
      }
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
  fscWire()
  wireMonitor()
  await initMonitor()
  await initRecOptions()
  await initEditTab()
  // 恢复上次停在哪个页签（观看页是默认值，不用恢复；调试/关于页也不恢复，免得下次一开就停在那）
  if (prefs.tab === 'monitor' || prefs.tab === 'edit') switchTab(prefs.tab)
  inputEl.focus()
}

/* ------------------------------ 多窗口拼接 ------------------------------ */
/*
 * 剪辑页新增：把几路录好的文件拼成"一张多窗口画面"。
 *   预览 = 几个 <video> 各自经 WebAudio 的 GainNode 混音，再画到一个 canvas 上
 *   导出 = 交给主进程 ffmpeg：视频 xstack 摆格子、音频 amix(normalize=0) 按各自音量混
 * 每一路能单独调音量和起始延迟，所以"对齐进度 + 各自控制音量"都成立。
 */

const moCanvas = document.getElementById('mo-canvas')
const moSourcesEl = document.getElementById('mo-sources')
const moStatusEl = document.getElementById('mo-status')
const moAddBtn = document.getElementById('mo-add')
const moClearBtn = document.getElementById('mo-clear')
const moLayoutEl = document.getElementById('mo-layout')
const moSizeEl = document.getElementById('mo-size')
const moNvencEl = document.getElementById('mo-nvenc')
const moPlayBtn = document.getElementById('mo-play')
const moSeekEl = document.getElementById('mo-seek')
const moTimeEl = document.getElementById('mo-time')
const moRenderBtn = document.getElementById('mo-render')
const moFsBtn = document.getElementById('mo-fs')
const moAlignBtn = document.getElementById('mo-align')
const moClearMarksBtn = document.getElementById('mo-clear-marks')
const moCellbarsEl = document.getElementById('mo-cellbars')
const moAlign2Btn = document.getElementById('mo-align2')
const moRangeEl = document.getElementById('mo-range')
const moRangeHintEl = document.getElementById('mo-range-hint')
const moRangeOnlyEl = document.getElementById('mo-range-only')
const moFromMarkEl = document.getElementById('mo-from-mark')
const moProgressEl = document.getElementById('mo-progress')
const moProgressFillEl = document.getElementById('mo-progress-fill')
const moProgressTextEl = document.getElementById('mo-progress-text')

/**
 * @type {Array<{path:string,name:string,gain:number,delay:number,video:HTMLVideoElement,
 *   node?:MediaElementAudioSourceNode,gainNode?:GainNode,
 *   markT?:number|null, ui?:{solo:HTMLButtonElement,own:HTMLInputElement,ownTime:HTMLElement,
 *   mark:HTMLButtonElement,drift:HTMLElement,delay:HTMLInputElement,delayVal:HTMLElement}}>}
 */
let moSources = []
/** 主时钟（所有窗口一起播）的帧循环 */
let moRaf = 0
let moPlaying = false
let moMaster = 0
/** 预览起点（播放时 = performance.now()） */
let moT0 = 0
let moAudioCtx = null
/** 行内文字（定位 / 滞后）刷新节流 */
let moLabelAt = 0
/**
 * 当前"受控"的那一路（空格键控制它播放/暂停）。
 * -1 = 没有选中，此时空格控制"一起播"的主时钟。
 */
let moFocusIdx = -1
/** 对齐区间：所有窗口都有画面的那一段（秒），null = 还没算 / 没有重叠 */
let moRange = null

function moLayoutColsRows() {
  const v = String((moLayoutEl && moLayoutEl.value) || '2x2')
  const m = /^(\d+)x(\d+)$/.exec(v)
  return m ? { cols: Number(m[1]), rows: Number(m[2]) } : { cols: 2, rows: 2 }
}

function moFmt(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** 统一用「几分:几秒」（分不折成小时，超过 60 就往上加，比如 80:15） */
function moFmtLong(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * 标定分析：把"每个窗口在自己文件里的起始时间 / 结束时间"列成表。
 * 内容位置 p 与主时间轴 t 的关系：p = t + seek_i − delay_i
 * 所以成片段 [S, E] 对应这一路的 [S + seek − delay, E + seek − delay]（再夹到 [0, 时长]）。
 */
function moRenderAnalysis() {
  const box = document.getElementById('mo-analysis')
  if (!box) return
  const marked = moSources.filter((s) => typeof s.markT === 'number')
  if (moSources.length < 2 || marked.length < 2) {
    box.classList.add('hidden')
    box.innerHTML = ''
    return
  }
  box.classList.remove('hidden')
  const dur = moDuration()
  const S = moRange ? moRange.start : 0
  const E = moRange ? moRange.end : dur
  box.innerHTML = ''

  const sum = document.createElement('div')
  sum.className = 'mo-an-sum' + (moRange ? '' : ' warn')
  if (moRange) {
    sum.textContent =
      `成片：起始时间 ${moFmtLong(S)} · 结束时间 ${moFmtLong(E)} · 时长 ${moFmtLong(E - S)}` +
      `（下面是每个窗口在它自己文件里的起止时间，单位为 分:秒）`
  } else {
    sum.textContent = '这几路没有共同区间：某一路在别人开始前就播完了，请改小延迟或换更长的录制'
  }
  box.appendChild(sum)

  // 表头
  const head = document.createElement('div')
  head.className = 'mo-an-row mo-an-head'
  for (const [txt, cls] of [
    ['窗口', 'mo-an-idx'],
    ['文件', 'mo-an-name'],
    ['起始时间', 'mo-an-cell'],
    ['结束时间', 'mo-an-cell'],
    ['时长', 'mo-an-cell'],
    ['标定', 'mo-an-cell'],
    ['', 'mo-an-tagcell']
  ]) {
    const c = document.createElement('span')
    c.className = cls
    c.textContent = txt
    head.appendChild(c)
  }
  box.appendChild(head)

  // 谁决定了成片结束（最早播完的那一路）
  let endOwner = -1
  let endAt = Infinity
  moSources.forEach((s, i) => {
    const left = Math.max(0, (Number.isFinite(s.video.duration) ? s.video.duration : 0) - (s.seek || 0))
    const fin = s.delay + left
    if (fin < endAt) {
      endAt = fin
      endOwner = i
    }
  })

  moSources.forEach((s, i) => {
    const row = document.createElement('div')
    row.className = 'mo-an-row'

    const idx = document.createElement('span')
    idx.className = 'mo-an-idx'
    idx.textContent = `#${i + 1}`

    const name = document.createElement('span')
    name.className = 'mo-an-name'
    name.textContent = s.name
    name.title = s.path

    const d = Number.isFinite(s.video.duration) ? s.video.duration : 0
    const seek = s.seek || 0
    const span = moCellSpan(s)
    let startT
    let endT
    if (span) {
      startT = span.start
      endT = span.end
    } else {
      startT = seek
      endT = Math.max(seek, d)
    }

    const start = document.createElement('span')
    start.className = 'mo-an-cell mo-an-start'
    start.textContent = moFmtLong(startT)

    const end = document.createElement('span')
    end.className = 'mo-an-cell mo-an-end'
    end.textContent = moFmtLong(endT)

    const len = document.createElement('span')
    len.className = 'mo-an-cell mo-an-len'
    len.textContent = moFmtLong(Math.max(0, endT - startT))

    const mark = document.createElement('span')
    mark.className = 'mo-an-cell mo-an-mark'
    mark.textContent = typeof s.markT === 'number' ? moFmtLong(s.markT) : `延迟 ${moFmtLong(s.delay)}`

    const tagCell = document.createElement('span')
    tagCell.className = 'mo-an-tagcell'
    if (i === endOwner && moRange) {
      const tag = document.createElement('span')
      tag.className = 'mo-an-tag'
      tag.textContent = '决定成片结尾'
      tag.title = '这一路最先播完，所以成片就到这里结束（只导共同区间时）'
      tagCell.appendChild(tag)
    }

    row.appendChild(idx)
    row.appendChild(name)
    row.appendChild(start)
    row.appendChild(end)
    row.appendChild(len)
    row.appendChild(mark)
    row.appendChild(tagCell)
    box.appendChild(row)
  })
}

/**
 * 某一路在当前配置下"在它自己文件里"的起止时间（秒）。
 * 内容位置 p 与主时间轴 t 的关系：p = t + seek_i − delay_i
 */
function moCellSpan(s) {
  const d = Number.isFinite(s.video.duration) ? s.video.duration : 0
  if (!d) return null
  const seek = s.seek || 0
  if (!moRange) return { start: seek, end: Math.max(seek, d) }
  const inStart = Math.max(0, Math.min(d, moRange.start + seek - s.delay))
  const inEnd = Math.max(0, Math.min(d, moRange.end + seek - s.delay))
  return { start: inStart, end: Math.max(inStart, inEnd) }
}

/** 在格子左下角画「起始 / 结束」（分:秒）—— 提示直接贴在小窗口上，不用去找表格 */
function moDrawCellTimes(ctx2d, x, y, cw, ch, span) {
  if (!span) return
  const fs = Math.max(9, Math.round(cw / 30))
  const pad = Math.max(3, Math.round(cw / 120))
  const lineH = Math.round(fs * 1.25)
  const texts = [
    { label: '起始', value: moFmtLong(span.start), color: '#7ddc9a' },
    { label: '结束', value: moFmtLong(span.end), color: '#ffd18a' }
  ]
  ctx2d.font = `600 ${fs}px system-ui, "Microsoft YaHei", sans-serif`
  ctx2d.textBaseline = 'top'
  const innerPad = Math.round(fs * 0.5)
  let maxW = 0
  for (const t of texts) {
    maxW = Math.max(maxW, ctx2d.measureText(`${t.label} ${t.value}`).width)
  }
  const boxW = Math.min(cw - pad * 2, Math.ceil(maxW) + innerPad * 2)
  const boxH = lineH * texts.length + innerPad
  const bx = x + pad
  const by = y + ch - pad - boxH
  ctx2d.fillStyle = 'rgba(8,10,14,0.66)'
  ctx2d.fillRect(bx, by, boxW, boxH)
  texts.forEach((t, k) => {
    const ty = by + innerPad / 2 + k * lineH
    ctx2d.fillStyle = '#8f97a8'
    ctx2d.fillText(t.label, bx + innerPad, ty)
    const off = ctx2d.measureText(t.label + ' ').width
    ctx2d.fillStyle = t.color
    ctx2d.fillText(t.value, bx + innerPad + off, ty)
  })
}

/** 预览总时长 = 最长的 (延迟 + 自身时长) */
function moDuration() {
  let d = 0
  for (const s of moSources) {
    const own = Number.isFinite(s.video.duration) ? s.video.duration : 0
    d = Math.max(d, s.delay + own)
  }
  return d
}

function moSetStatus(text, cls = '') {
  if (!moStatusEl) return
  moStatusEl.textContent = text || ''
  moStatusEl.className = 'modal-hint' + (cls ? ' ' + cls : '')
}

/* ---------- 导出进度（ffmpeg 的 -progress 从主进程回传） ---------- */
let moExporting = false
let moExportStartAt = 0
let moExportTotal = 0
let moExportHideTimer = null

function moShowProgress(pct, text) {
  if (!moProgressEl) return
  clearTimeout(moExportHideTimer)
  moProgressEl.classList.remove('hidden')
  if (moProgressFillEl) moProgressFillEl.style.width = `${Math.max(0, Math.min(100, Number(pct) || 0))}%`
  if (moProgressTextEl) moProgressTextEl.textContent = text || ''
}

function moHideProgress(delay = 0) {
  clearTimeout(moExportHideTimer)
  const hide = () => {
    if (moProgressEl) moProgressEl.classList.add('hidden')
    if (moProgressFillEl) moProgressFillEl.style.width = '0%'
  }
  if (delay > 0) moExportHideTimer = setTimeout(hide, delay)
  else hide()
}

if (window.pr.onMosaicProgress) {
  window.pr.onMosaicProgress((p) => {
    if (!p) return
    // 任务面板里也更新一份（即使导出面板已经关掉也能看进度）
    if (p.taskId) {
      taskUpdate(p.taskId, {
        pct: Number.isFinite(p.pct) ? p.pct : null,
        outTime: Number(p.outTime) || 0,
        total: Number(p.total) || 0,
        speed: p.speed && p.speed !== 'N/A' ? `${p.speed}` : ''
      })
    }
    // 图片片头 / 精彩片段走的是同一个进度通道
    if (p.kind === 'head' || p.kind === 'highlight') {
      if (headTaskId && p.taskId === headTaskId) {
        headShowProgress(
          Number.isFinite(p.pct) ? p.pct : 0,
          `${Math.round(p.pct || 0)}%${p.kind === 'highlight' ? ' · 抽精彩片段' : p.label ? ' · ' + p.label : ''}`
        )
      }
      return
    }
    if (!moExporting) return
    const out = Number(p.outTime) || 0
    const total = Number(p.total) || moExportTotal || 0
    if (total > 0) moExportTotal = total
    const pct = Number.isFinite(p.pct) ? Math.max(0, Math.min(100, p.pct)) : null
    const elapsed = (Date.now() - moExportStartAt) / 1000
    let eta = ''
    if (pct !== null && pct > 2 && elapsed > 0.4) {
      const left = Math.max(0, (elapsed / pct) * (100 - pct))
      if (left >= 1) eta = ` · 还剩 ${moFmt(left)}`
    }
    const speed = p.speed && p.speed !== 'N/A' ? ` · ${p.speed}` : ''
    if (total <= 0) {
      // 量不到总时长（ffprobe 缺失之类的极端情况）就只报"导出到第几秒"
      moShowProgress(5, `导出中 · ${out.toFixed(1)}s${speed}`)
      return
    }
    const pctTxt = pct === null ? '…' : `${pct.toFixed(0)}%`
    moShowProgress(pct === null ? 5 : pct, `${pctTxt} · ${out.toFixed(1)}s / ${total.toFixed(1)}s${eta}${speed}`)
  })
}

/** 全部停下（主时钟 + 每一路），不改变任何位置 */
function moStopPreview() {
  moPlaying = false
  if (moRaf) cancelAnimationFrame(moRaf)
  moRaf = 0
  if (moPlayBtn) moPlayBtn.textContent = '▶ 预览'
  for (const s of moSources) {
    try {
      s.video.pause()
    } catch {}
    if (s.ui && s.ui.solo) s.ui.solo.textContent = '▶'
  }
}

/** 选进来的文件 → 建 video + 接 WebAudio */
function moAddSources(files) {
  if (!Array.isArray(files) || !files.length) return
  const room = 6 - moSources.length
  if (room <= 0) {
    moSetStatus('最多 6 路（再多画面就没法看了）', 'warn')
    return
  }
  const picked = files.slice(0, room)
  for (const f of picked) {
    if (moSources.some((s) => s.path === f.path)) continue
    const video = document.createElement('video')
    video.src = 'prmedia://local/?p=' + encodeURIComponent(f.path)
    video.crossOrigin = 'anonymous'
    video.preload = 'auto'
    video.muted = false
    video.playsInline = true
    video.style.display = 'none'
    // 时长一到就把「0:00 / 0:00」换成真实时长，并算一次"共同区间"
    const onMeta = () => {
      moUpdateRowLabels(true)
      moComputeRange()
      moDrawFrame(moMaster)
    }
    video.addEventListener('loadedmetadata', onMeta)
    video.addEventListener('durationchange', onMeta)
    video.addEventListener('canplay', onMeta)
    document.body.appendChild(video)
    moSources.push({
      path: f.path,
      name: f.name || f.path.split(/[\\/]/).pop(),
      gain: 1,
      delay: 0,
      seek: 0,
      video,
      markT: null
    })
  }
  moRenderSources()
  moDrawFrame(0)
}

function moRemoveSource(idx) {
  const s = moSources[idx]
  if (!s) return
  try {
    s.video.pause()
    s.video.removeAttribute('src')
    s.video.load()
    s.video.remove()
  } catch {}
  moSources.splice(idx, 1)
  moRenderSources()
  moDrawFrame(0)
}

/**
 * 源列表 UI，每路两行：
 *   第一行：序号 + 文件名 + ▶（单路播放）+ 自身进度条 + 自身时间 + 「标定」+ 滞后/定位读数
 *   第二行：音量 + 延迟 + 移除
 */
function moRenderSources() {
  if (!moSourcesEl) return
  const { cols, rows } = moLayoutColsRows()
  const cap = cols * rows
  moSourcesEl.innerHTML = ''
  if (!moSources.length) {
    moSourcesEl.innerHTML = '<p class="modal-hint">还没有源：在左边「视频文件」里勾几个，然后点「← 加进拼接」</p>'
  } else if (moSources.length > cap) {
    const tip = document.createElement('p')
    tip.className = 'modal-hint warn'
    tip.textContent = `当前 ${moSources.length} 路，但布局 ${cols}×${rows} 只有 ${cap} 个格子——请换更大的布局，或去掉几路`
    moSourcesEl.appendChild(tip)
  }
  moSources.forEach((s, i) => {
    const row = document.createElement('div')
    row.className = 'mo-src'
    const top = document.createElement('div')
    top.className = 'mo-src-top'
    const bot = document.createElement('div')
    bot.className = 'mo-src-bot'

    const idx = document.createElement('span')
    idx.className = 'mo-idx'
    idx.textContent = String(i + 1)

    const name = document.createElement('span')
    name.className = 'mo-name'
    name.textContent = s.name
    name.title = s.path

    // 单路播放：只让这一路自己走，别的停住，方便对着看/对进度
    const solo = document.createElement('button')
    solo.type = 'button'
    solo.className = 'ghost mo-solo'
    solo.textContent = '▶'
    solo.title = '只播这一路（再点暂停）；不影响其它窗口'
    solo.addEventListener('click', (e) => {
      e.stopPropagation()
      moToggleSolo(i)
    })

    // 这一路自己的进度（和「延迟」无关，就是文件里的时间）
    const own = document.createElement('input')
    own.type = 'range'
    own.className = 'mo-own'
    own.min = '0'
    own.max = '1000'
    own.step = '1'
    own.value = '0'
    own.title = '拖动看这一路自己的画面（0 = 文件开头）'
    const ownTime = document.createElement('b')
    ownTime.className = 'mo-own-time'
    ownTime.textContent = '0:00 / 0:00'
    own.addEventListener('pointerdown', () => {
      own.dataset.dragging = '1'
      // 手动拖某一路时先停掉主时钟，否则会被主循环拽回去
      if (moPlaying) moStopMaster()
    })
    own.addEventListener('pointerup', () => { delete own.dataset.dragging; own.blur() })
    own.addEventListener('input', () => {
      const d = Number.isFinite(s.video.duration) ? s.video.duration : 0
      if (!d) return
      const t = (Number(own.value) / 1000) * d
      try {
        s.video.currentTime = t
      } catch {}
      ownTime.textContent = `${moFmt(t)} / ${moFmt(d)}`
      if (!moPlaying) moDrawFrame(moMaster)
    })

    // 标定：把"这一路现在停的画面"记下来，之后统一对齐
    const mark = document.createElement('button')
    mark.type = 'button'
    mark.className = 'ghost mo-mark'
    mark.textContent = '标定'
    mark.title = '把这一路当前的画面记为"同一个时刻"；几路都标定后点「⌖ 按标定对齐」'
    mark.addEventListener('click', (e) => {
      e.stopPropagation()
      moSetMark(i)
    })

    const drift = document.createElement('b')
    drift.className = 'mo-drift'
    drift.textContent = '—'

    top.appendChild(idx)
    top.appendChild(name)
    top.appendChild(solo)
    top.appendChild(own)
    top.appendChild(ownTime)
    top.appendChild(mark)
    top.appendChild(drift)

    const vol = document.createElement('input')
    vol.type = 'range'
    vol.className = 'mo-vol'
    vol.min = '0'
    vol.max = '200'
    vol.step = '5'
    vol.value = String(Math.round(s.gain * 100))
    const volVal = document.createElement('b')
    volVal.className = 'mo-num'
    volVal.textContent = Math.round(s.gain * 100) + '%'
    vol.addEventListener('input', (e) => moApplyGain(s, Number(e.currentTarget.value) / 100))

    const delay = document.createElement('input')
    delay.type = 'range'
    delay.className = 'mo-delay'
    delay.min = '0'
    // 常规只覆盖 0–60s；遇到几十分钟量级的标定差会按实际值撑开
    delay.max = String(Math.max(600, Math.ceil((s.delay || 0) * 10) + 600))
    delay.step = '1'
    delay.value = String(Math.round(s.delay * 10))
    const delayVal = document.createElement('b')
    delayVal.className = 'mo-num'
    delayVal.textContent = s.delay.toFixed(1) + 's'
    delay.addEventListener('input', (e) => {
      s.delay = Math.max(0, Math.min(86400, Number(e.currentTarget.value) / 10))
      delayVal.textContent = s.delay.toFixed(1) + 's'
      moComputeRange()
      if (!moPlaying) moDrawFrame(moMaster)
    })

    const rm = document.createElement('button')
    rm.type = 'button'
    rm.className = 'ghost mo-rm'
    rm.textContent = '移除'
    rm.addEventListener('click', (e) => {
      e.stopPropagation()
      moRemoveSource(i)
    })

    const l1 = document.createElement('span')
    l1.className = 'mo-lab'
    l1.textContent = '音量'
    const l2 = document.createElement('span')
    l2.className = 'mo-lab'
    l2.textContent = '延迟'
    bot.appendChild(l1)
    bot.appendChild(vol)
    bot.appendChild(volVal)
    bot.appendChild(l2)
    bot.appendChild(delay)
    bot.appendChild(delayVal)
    bot.appendChild(rm)

    row.appendChild(top)
    row.appendChild(bot)
    // 点这一行 = 选中它（空格键控制它）；点按钮/滑块不算
    row.addEventListener('pointerdown', (e) => {
      if (e.target && /^(INPUT|BUTTON|SELECT)$/.test(e.target.tagName)) return
      moSetFocus(i)
    })
    if (moFocusIdx === i) row.classList.add('focused')
    moSourcesEl.appendChild(row)

    s.ui = { solo, own, ownTime, mark, drift, delay, delayVal, vol, volVal }
    // 回填已有的进度 / 标定状态（重排列表时不能丢）
    const v = s.video
    if (Number.isFinite(v.duration) && v.duration > 0) {
      own.value = String(Math.round((v.currentTime / v.duration) * 1000))
      ownTime.textContent = `${moFmt(v.currentTime)} / ${moFmt(v.duration)}`
    }
    if (typeof s.markT === 'number') mark.textContent = `标定 ${s.markT.toFixed(2)}s`
  })
  moUpdateRowLabels(true)
  moRenderCellBars()
  moComputeRange()
  // 有的文件元数据来得晚（大文件/网络盘），先显示"加载中…"，这里短轮询到齐
  moPollMetaUntilReady()
  if (moRenderBtn) moRenderBtn.disabled = moSources.length < 2
  if (moSeekEl) moSeekEl.disabled = moSources.length < 2
}

/** 元数据（时长）还没到齐时，每 300ms 刷新一次标签，最多约 6 秒 */
let moMetaPollTimer = 0
function moPollMetaUntilReady() {
  clearInterval(moMetaPollTimer)
  let tries = 0
  moMetaPollTimer = setInterval(() => {
    tries += 1
    const missing = moSources.some((s) => !(Number.isFinite(s.video.duration) && s.video.duration > 0))
    moUpdateRowLabels(true)
    moComputeRange()
    if (!missing || tries > 20 || !moSources.length) {
      clearInterval(moMetaPollTimer)
      moMetaPollTimer = 0
    }
  }, 300)
}

/* ---------- 全屏时贴在每个小窗口顶部的控制条（序号 / 单播 / 自己的进度 / 滞后） ---------- */

/** 把某一路 seek 到它自己文件里的某个位置（进度输入是 0~1000） */
function moSeekOwn(s, msValue, timeEl) {
  const d = Number.isFinite(s.video.duration) ? s.video.duration : 0
  if (!d) return
  const v = Math.max(0, Math.min(1000, Number(msValue) || 0))
  const t = (v / 1000) * d
  try {
    s.video.currentTime = t
  } catch {}
  if (timeEl) timeEl.textContent = `${moFmt(t)} / ${moFmt(d)}`
  if (!moPlaying) moDrawFrame(moMaster)
}

/** 统一设置某一路的音量（列表、全屏格子控制条、音频节点三方同步） */
function moApplyGain(s, gain) {
  if (!s) return
  s.gain = Math.max(0, Math.min(2, Number(gain) || 0))
  if (s.gainNode) s.gainNode.gain.value = s.gain
  const pct = Math.round(s.gain * 100)
  if (s.ui) {
    if (s.ui.vol && document.activeElement !== s.ui.vol) s.ui.vol.value = String(pct)
    if (s.ui.volVal) s.ui.volVal.textContent = pct + '%'
  }
  if (s.bar) {
    if (s.bar.vol && document.activeElement !== s.bar.vol) s.bar.vol.value = String(pct)
    if (s.bar.volVal) s.bar.volVal.textContent = pct + '%'
  }
  if (!moPlaying) moDrawFrame(moMaster)
}

function moRenderCellBars() {
  if (!moCellbarsEl) return
  moCellbarsEl.innerHTML = ''
  moSources.forEach((s, i) => {
    const bar = document.createElement('div')
    bar.className = 'mo-cellbar'

    const idx = document.createElement('span')
    idx.className = 'mcb-idx'
    idx.textContent = `#${i + 1}`

    const nameEl = document.createElement('span')
    nameEl.className = 'mcb-name'
    nameEl.textContent = s.name
    nameEl.title = s.path

    const solo = document.createElement('button')
    solo.type = 'button'
    solo.className = 'ghost mcb-solo'
    solo.textContent = '▶'
    solo.title = '只播这一路（再点暂停）'
    solo.addEventListener('click', (e) => {
      e.stopPropagation()
      moToggleSolo(i)
    })

    const seek = document.createElement('input')
    seek.type = 'range'
    seek.className = 'mcb-seek'
    seek.min = '0'
    seek.max = '1000'
    seek.step = '1'
    seek.value = '0'
    seek.title = '这一路自己的进度（拖到哪看哪）'
    const time = document.createElement('b')
    time.className = 'mcb-time'
    time.textContent = '0:00 / 0:00'
    seek.addEventListener('pointerdown', (e) => {
      e.stopPropagation()
      seek.dataset.dragging = '1'
      // 手动拖某一路时先停掉主时钟，否则会被主循环拽回去
      if (moPlaying) moStopMaster()
    })
    seek.addEventListener('pointerup', () => { delete seek.dataset.dragging; seek.blur() })
    seek.addEventListener('input', () => moSeekOwn(s, seek.value, time))

    const drift = document.createElement('b')
    drift.className = 'mcb-drift'
    drift.textContent = '—'

    // 全屏里也要能标定（标定就是"把各自都对到同一个画面"，全屏看才准）
    const mark = document.createElement('button')
    mark.type = 'button'
    mark.className = 'ghost mcb-mark'
    mark.textContent = '标定'
    mark.title = '把这一路当前画面记为"同一个时刻"；几路都标定后点「⌖ 按标定对齐」'
    mark.addEventListener('click', (e) => {
      e.stopPropagation()
      moSetFocus(i)
      moSetMark(i)
    })
    if (typeof s.markT === 'number') {
      mark.textContent = `标定 ${s.markT.toFixed(2)}s`
      mark.classList.add('on')
    }

    // 全屏里也要能调音量
    const volRow = document.createElement('div')
    volRow.className = 'mcb-row mcb-row2'
    const volLab = document.createElement('span')
    volLab.className = 'mcb-vollab'
    volLab.textContent = '音量'
    const vol = document.createElement('input')
    vol.type = 'range'
    vol.className = 'mcb-vol'
    vol.min = '0'
    vol.max = '200'
    vol.step = '5'
    vol.value = String(Math.round(s.gain * 100))
    vol.title = '这一路的音量（0–200%），导出时按这个混'
    const volVal = document.createElement('b')
    volVal.className = 'mcb-volval'
    volVal.textContent = Math.round(s.gain * 100) + '%'
    vol.addEventListener('pointerdown', (e) => e.stopPropagation())
    vol.addEventListener('input', (e) => moApplyGain(s, Number(e.currentTarget.value) / 100))
    volRow.appendChild(volLab)
    volRow.appendChild(vol)
    volRow.appendChild(volVal)

    const mainRow = document.createElement('div')
    mainRow.className = 'mcb-row'
    mainRow.appendChild(idx)
    mainRow.appendChild(nameEl)
    mainRow.appendChild(solo)
    mainRow.appendChild(seek)
    mainRow.appendChild(time)
    mainRow.appendChild(drift)
    mainRow.appendChild(mark)

    bar.appendChild(mainRow)
    bar.appendChild(volRow)
    // 点这条控制条 = 选中这个窗口（空格键控制它）
    bar.addEventListener('pointerdown', (e) => {
      if (e.target && e.target.tagName === 'INPUT') return
      moSetFocus(i)
    })
    moCellbarsEl.appendChild(bar)
    s.bar = { solo, seek, time, drift, mark, vol, volVal }
    if (moFocusIdx === i) bar.classList.add('focused')
  })
  moLayoutCellBars()
}

/** 按画布实际绘制区域把控制条摆到每个格子的顶部 */
function moLayoutCellBars() {
  if (!moCellbarsEl || !moCanvas) return
  const host = moCellbarsEl.parentElement
  if (!host) return
  const c = moCanvas.getBoundingClientRect()
  const h = host.getBoundingClientRect()
  const { cols, rows } = moLayoutColsRows()
  const cw = c.width / cols
  const ch = c.height / rows
  const bars = [...moCellbarsEl.querySelectorAll('.mo-cellbar')]
  const pad = 4
  bars.forEach((bar, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    if (row >= rows) {
      bar.style.display = 'none'
      return
    }
    bar.style.display = ''
    bar.style.left = `${Math.round(c.left - h.left + col * cw + pad)}px`
    bar.style.top = `${Math.round(c.top - h.top + row * ch + pad)}px`
    bar.style.width = `${Math.max(140, Math.round(cw - pad * 2))}px`
  })
}

/** 记下某一路"当前这一帧"的时刻（对齐分析用） */
function moSetMark(i) {
  const s = moSources[i]
  if (!s) return
  const t = Number(s.video.currentTime) || 0
  s.markT = t
  if (s.ui) {
    s.ui.mark.textContent = `标定 ${t.toFixed(2)}s`
    s.ui.mark.classList.add('on')
  }
  if (s.bar && s.bar.mark) {
    s.bar.mark.textContent = `标定 ${t.toFixed(2)}s`
    s.bar.mark.classList.add('on')
  }
  const marked = moSources.filter((x) => typeof x.markT === 'number').length
  moSetStatus(
    marked >= 2
      ? `已标定 ${marked} 路（#${i + 1} = ${t.toFixed(2)}s），可以点「⌖ 按标定对齐」了`
      : `已标定 #${i + 1} = ${t.toFixed(2)}s；再标定至少一路才能算延迟差`
  )
  // 勾着「从标定点开始」时，标定本身就直接决定这一路的起播点
  if (moFromMarkEl && moFromMarkEl.checked && marked >= 2) moAlignByMarks()
  else moRenderAnalysis()
}

/**
 * 按标定时刻对齐。两种模式：
 *  A) 默认「延迟对齐」：delay_i = max(mark) − mark_i
 *     标定帧在所有窗口的同一个主时刻出现（T* = 最晚那个标定），前面保留完整素材。
 *  B) 勾了「从标定点开始」：seek_i = mark_i，delay 全 0
 *     每路直接从标定处起播，标定帧就是成片的 0 秒（更短、没有"先等一下"的前段）。
 */
function moAlignByMarks() {
  const marked = moSources.map((s, i) => ({ s, i })).filter(({ s }) => typeof s.markT === 'number')
  if (marked.length < 2) {
    moSetStatus('先给至少两路点「标定」（把各自都对到同一个画面上），再来对齐', 'warn')
    return
  }
  const fromMark = Boolean(moFromMarkEl && moFromMarkEl.checked)
  const parts = []
  if (fromMark) {
    // B 模式：砍头对齐
    for (const s of moSources) {
      s.seek = typeof s.markT === 'number' ? Math.max(0, s.markT) : 0
      s.delay = 0
      if (s.ui) {
        s.ui.delay.max = '600'
        s.ui.delay.value = '0'
        s.ui.delayVal.textContent = '0.0s'
      }
    }
    for (const { s, i } of marked) parts.push(`#${i + 1} 从 ${s.seek.toFixed(2)}s 起播`)
  } else {
    // A 模式：延迟对齐
    const maxMark = Math.max(...marked.map(({ s }) => s.markT))
    for (const s of moSources) s.seek = 0
    for (const { s, i } of marked) {
      const d = Math.max(0, Math.min(86400, Math.round((maxMark - s.markT) * 100) / 100))
      s.delay = d
      if (s.ui) {
        // 大偏移（几分钟~几十分钟）时把滑块量程撑开，否则滑块显示不出这个值
        s.ui.delay.max = String(Math.max(600, Math.ceil(d * 10) + 600))
        s.ui.delay.value = String(Math.round(d * 10))
        s.ui.delayVal.textContent = d.toFixed(1) + 's'
      }
      parts.push(`#${i + 1} ${d > 0 ? d.toFixed(2) + 's' : '基准'}`)
    }
  }
  moStopPreview()
  moComputeRange()
  // 预览立刻跳到"共同起点"，并让每路都对到自己的标定/起点
  moMaster = moRange ? moRange.start : 0
  for (const s of moSources) {
    const want = fromMark ? (s.seek || 0) : Math.max(0, moMaster - s.delay + (s.seek || 0))
    try {
      s.video.currentTime = want
    } catch {}
  }
  moDrawFrame(moMaster)
  moUpdateRowLabels(true)
  const rangeTxt = moRange
    ? `共同区间 ${moFmt(moRange.start)} – ${moFmt(moRange.end)}（${(moRange.end - moRange.start).toFixed(1)}s）`
    : '这几路没有重叠区间（延迟/时长不合适）'
  moSetStatus(
    `已按标定对齐（${fromMark ? '从标定点开始：砍掉标定之前的素材' : '最靠后的一路当基准'}）：${parts.join(' · ')} → ${rangeTxt}；下面表格里是每个窗口自己播哪一段`,
    moRange ? 'ok' : 'warn'
  )
}

/** 「从标定点开始」开关：切换时把 seek/delay 重新算一遍 */
function moApplyFromMarkMode() {
  const on = Boolean(moFromMarkEl && moFromMarkEl.checked)
  if (!on) {
    for (const s of moSources) s.seek = 0
    moComputeRange()
    moDrawFrame(moMaster)
    moUpdateRowLabels(true)
    return
  }
  const marked = moSources.filter((s) => typeof s.markT === 'number')
  if (marked.length < 2) {
    if (moFromMarkEl) moFromMarkEl.checked = false
    moSetStatus('「从标定点开始」需要先给至少两路点「标定」', 'warn')
    return
  }
  moAlignByMarks()
}

function moClearMarks() {
  for (const s of moSources) {
    s.markT = null
    if (s.ui) {
      s.ui.mark.textContent = '标定'
      s.ui.mark.classList.remove('on')
    }
    if (s.bar && s.bar.mark) {
      s.bar.mark.textContent = '标定'
      s.bar.mark.classList.remove('on')
    }
  }
  moSetStatus('已清掉所有标定')
  moRenderAnalysis()
}

/* ---------------- 对齐区间：程序自动算出"最早"和"最晚"两个时刻 ---------------- */

/**
 * 共同区间 = [所有窗口都开始之后的最早时刻, 最早结束那一刻]
 *   start = max(delay_i)                 ← 最晚开始的那一路决定了"最开始对齐的时间点"
 *   end   = min(delay_i + 剩余时长_i)     ← 最早结束的那一路决定了"最后对齐的时间点"
 * 剩余时长 = 文件时长 − 裁头（"从标定点开始"模式下 seek = 标定时刻）
 * 这一段之外，至少有某个窗口是黑的，所以预览/导出都按这段来最干净。
 */
function moComputeRange() {
  if (moSources.length < 2) {
    moRange = null
    moApplyRangeUi()
    moRenderAnalysis()
    return
  }
  let start = 0
  let end = Infinity
  for (const s of moSources) {
    const dur = Number.isFinite(s.video.duration) ? s.video.duration : 0
    if (!dur) {
      moRange = null
      moApplyRangeUi()
      moRenderAnalysis()
      return
    }
    const left = Math.max(0, dur - (s.seek || 0))
    start = Math.max(start, s.delay)
    end = Math.min(end, s.delay + left)
  }
  moRange = end - start > 0.2 ? { start, end } : null
  moApplyRangeUi()
  moRenderAnalysis()
}

/** 把对齐区间画到进度条上 + 写一行说明 */
function moApplyRangeUi() {
  const dur = moDuration()
  if (moRangeEl) {
    if (moRange && dur > 0) {
      moRangeEl.classList.remove('hidden')
      moRangeEl.style.left = `${(moRange.start / dur) * 100}%`
      moRangeEl.style.width = `${((moRange.end - moRange.start) / dur) * 100}%`
    } else {
      moRangeEl.classList.add('hidden')
    }
  }
  if (moRangeHintEl) {
    if (moRange) {
      moRangeHintEl.classList.remove('hidden')
      moRangeHintEl.classList.remove('warn')
      moRangeHintEl.textContent =
        `对齐区间 ${moFmt(moRange.start)} – ${moFmt(moRange.end)}` +
        `（共同 ${(moRange.end - moRange.start).toFixed(1)}s；起点 = 最晚开始的那一路，终点 = 最早结束的那一路）`
    } else if (moSources.length >= 2) {
      moRangeHintEl.classList.remove('hidden')
      moRangeHintEl.classList.add('warn')
      moRangeHintEl.textContent = '这几路没有共同区间（有窗口时长不够），请改小延迟或换更长的录制'
    } else {
      moRangeHintEl.classList.add('hidden')
    }
  }
}

/** 勾了「只用对齐区间」时，主时钟只在区间里走 */
function moRangeActive() {
  return Boolean(moRangeOnlyEl && moRangeOnlyEl.checked && moRange)
}

/** 让某一路成为"空格键控制的那一路"（-1 = 取消） */
function moSetFocus(i) {
  moFocusIdx = i
  for (const row of document.querySelectorAll('#mo-sources .mo-src')) row.classList.remove('focused')
  const rows = document.querySelectorAll('#mo-sources .mo-src')
  if (i >= 0 && rows[i]) rows[i].classList.add('focused')
  for (const bar of document.querySelectorAll('.mo-cellbar')) bar.classList.remove('focused')
  const bars = document.querySelectorAll('.mo-cellbar')
  if (i >= 0 && bars[i]) bars[i].classList.add('focused')
  moDrawFrame(moMaster)
}

/**
 * 空格：控制"当前受控的那个小窗"播放/暂停；没选窗口时控制"一起播"。
 * 这是全屏里最需要的操作——鼠标点个格子，空格就播那一路。
 */
function moToggleByFocus() {
  if (!moSources.length) return
  if (moFocusIdx >= 0 && moSources[moFocusIdx]) {
    // 只切换这一路；别的窗口在播就继续播（以前这里会顺手把别人停掉）
    moToggleCell(moFocusIdx)
    return
  }
  moTogglePreview()
}

/** 更新每行的「定位 / 滞后」读数（节流到 ~8Hz，避免每帧写 DOM） */function moUpdateRowLabels(force) {
  const now = performance.now()
  if (!force && now - moLabelAt < 120) return
  moLabelAt = now
  moSources.forEach((s, i) => {
    const ui = s.ui
    if (!ui) return
    const v = s.video
    const ownT = Number(v.currentTime) || 0
    const dur = Number.isFinite(v.duration) ? v.duration : 0
    // 自身进度条（用户正在拖它的时候不要抢）
    if (!ui.own.dataset.dragging) {
      ui.own.value = String(dur > 0 ? Math.round((ownT / dur) * 1000) : 0)
      ui.ownTime.textContent = dur > 0 ? `${moFmt(ownT)} / ${moFmt(dur)}` : '加载中…'
    }
    if (moPlaying) {
      // 主时钟播放时：期望位置 = 主时刻 - 延迟，差值就是这个窗口当前的滞后
      const want = moMaster + (s.seek || 0) - s.delay
      const diff = ownT - want
      const ms = Math.round(diff * 1000)
      ui.drift.textContent = Math.abs(ms) <= 60 ? `同步 ${ms > 0 ? '+' : ''}${ms}ms` : `${ms < 0 ? '落后' : '超前'} ${Math.abs(ms)}ms`
      ui.drift.className = 'mo-drift ' + (Math.abs(ms) <= 60 ? 'ok' : Math.abs(ms) <= 250 ? 'warn' : 'bad')
    } else if (!s.video.paused) {
      ui.drift.textContent = `播放 ${ownT.toFixed(2)}s`
      ui.drift.className = 'mo-drift solo'
    } else if (typeof s.markT === 'number') {
      ui.drift.textContent = `标定 ${s.markT.toFixed(2)}s`
      ui.drift.className = 'mo-drift mark'
    } else {
      ui.drift.textContent = `${ownT.toFixed(2)}s`
      ui.drift.className = 'mo-drift'
    }
    if (ui.solo) ui.solo.textContent = s.video.paused ? '▶' : '⏸'
    // 全屏时每个格子顶部那条也要跟着刷新
    const bar = s.bar
    if (bar) {
      if (!bar.seek.dataset.dragging) {
        bar.seek.value = String(dur > 0 ? Math.round((ownT / dur) * 1000) : 0)
        bar.time.textContent = dur > 0 ? `${moFmt(ownT)} / ${moFmt(dur)}` : '加载中…'
      }
      bar.drift.textContent = ui.drift.textContent
      bar.drift.className = 'mcb-drift ' + (ui.drift.className.split(' ')[1] || '')
      bar.solo.textContent = s.video.paused ? '▶' : '⏸'
    }
  })
}

/** 有没有"单独在播"的窗口（跟"一起播"的主时钟无关） */
function moAnyManualPlaying() {
  return moSources.some((s) => !s.video.paused)
}

/** 停掉"一起播"，但不动各窗口自己的播放/位置 */
function moStopMaster() {
  moPlaying = false
  if (moPlayBtn) moPlayBtn.textContent = '▶ 预览'
}

/**
 * 单路播放 / 暂停：**只动这一路，不碰别的窗口**。
 * 以前的实现是"一播就把别人全停掉"，结果操作 B 窗口会把正在播的 A 窗口也停了——
 * 用户看到的就是"操作其他窗口，原来的窗口也被调整"。
 * 唯一需要妥协的是"一起播"：它会持续把所有窗口拽到主时钟上，所以先把它停掉。
 */
function moToggleCell(i) {
  const s = moSources[i]
  if (!s) return
  moEnsureAudio()
  if (moAudioCtx && moAudioCtx.state === 'suspended') Promise.resolve(moAudioCtx.resume()).catch(() => {})
  if (moPlaying) moStopMaster()
  if (!s.video.paused) {
    s.video.pause()
    moSetStatus(`已暂停 #${i + 1} ${s.name}（其它窗口不受影响）`)
  } else {
    if (s.video.ended || (Number.isFinite(s.video.duration) && s.video.currentTime >= s.video.duration - 0.05)) {
      try {
        s.video.currentTime = 0
      } catch {}
    }
    s.video.play().catch(() => {})
    moSetStatus(`#${i + 1} ${s.name} 单独播放（其它窗口保持原样；再按一次暂停）`)
  }
  moDrawFrame(moMaster)
  moUpdateRowLabels(true)
  if (!moRaf && (moPlaying || moAnyManualPlaying())) moRaf = requestAnimationFrame(moLoop)
}

/** 兼容旧名字 */
const moToggleSolo = moToggleCell

/** 确保 WebAudio 通路（预览时才有声音） */
function moEnsureAudio() {
  if (moAudioCtx) return
  const Ctx = window.AudioContext || window.webkitAudioContext
  if (!Ctx) return
  try {
    moAudioCtx = new Ctx()
  } catch {
    moAudioCtx = null
    return
  }
  for (const s of moSources) {
    if (s.node) continue
    try {
      s.node = moAudioCtx.createMediaElementSource(s.video)
      s.gainNode = moAudioCtx.createGain()
      s.gainNode.gain.value = s.gain
      s.node.connect(s.gainNode)
      s.gainNode.connect(moAudioCtx.destination)
    } catch {}
  }
}

/** 画布分辨率：普通 960×540；全屏时按窗口放大（保持 16:9，和导出成片一致） */
function moSyncCanvasSize() {
  if (!moCanvas) return
  const full = document.body.classList.contains('mo-fs')
  let W = 960
  if (full) {
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    W = Math.max(1280, Math.min(2560, Math.round((window.innerWidth * dpr) / 2) * 2))
  }
  const H = Math.round((W * 9) / 16 / 2) * 2
  if (moCanvas.width !== W || moCanvas.height !== H) {
    moCanvas.width = W
    moCanvas.height = H
  }
}

/** 在格子上画角标：#序号 + 文件名 + 当前滞后（导出不用这些，只是预览辅助） */
function moDrawBadge(ctx2d, x, y, cw, ch, idx, text, cls) {
  const pad = Math.max(3, Math.round(cw / 120))
  const fs = Math.max(10, Math.round(cw / 22))
  ctx2d.font = `600 ${fs}px system-ui, "Microsoft YaHei", sans-serif`
  const label = `#${idx}${text ? ' ' + text : ''}`
  const w = Math.min(cw - pad * 2, ctx2d.measureText(label).width + pad * 3)
  ctx2d.fillStyle = 'rgba(8,10,14,0.62)'
  ctx2d.fillRect(x + pad, y + pad, w, fs + pad * 2)
  ctx2d.fillStyle = cls === 'bad' ? '#ff7b8a' : cls === 'warn' ? '#e6c063' : cls === 'ok' ? '#7ddc9a' : '#c8d0df'
  ctx2d.textBaseline = 'top'
  ctx2d.fillText(label, x + pad * 2, y + pad * 2)
}

/** 把当前时刻画到 canvas 上 */
function moDrawFrame(t) {
  if (!moCanvas) return
  const ctx2d = moCanvas.getContext('2d')
  const { cols, rows } = moLayoutColsRows()
  const W = moCanvas.width
  const H = moCanvas.height
  const cw = Math.floor(W / cols)
  const ch = Math.floor(H / rows)
  // 全屏时每个格子顶部有真的控制条（带进度条），画布上就不再重复画角标
  const badges = !moIsFullscreen()
  // 标定齐了就把「起始 / 结束」贴到每个格子左下角（不用去看表格）
  const showTimes = moSources.filter((s) => typeof s.markT === 'number').length >= 2
  ctx2d.fillStyle = '#000'
  ctx2d.fillRect(0, 0, W, H)
  moSources.forEach((s, i) => {
    const c = i % cols
    const r = Math.floor(i / cols)
    if (r >= rows) return
    const x = c * cw
    const y = r * ch
    const v = s.video
    // 只有"一起播"的时候才用延迟做黑场门禁；单路播放/手动定位时一律显示画面
    const gated = moPlaying && t < s.delay
    if (gated || !v.videoWidth) {
      ctx2d.fillStyle = '#0b0d12'
      ctx2d.fillRect(x, y, cw - 1, ch - 1)
      if (showTimes) moDrawCellTimes(ctx2d, x, y, cw, ch, moCellSpan(s))
      if (!badges) return
      if (!gated) moDrawBadge(ctx2d, x, y, cw, ch, i + 1, v.readyState >= 2 ? '' : '未加载', 'warn')
      else moDrawBadge(ctx2d, x, y, cw, ch, i + 1, `${s.delay.toFixed(1)}s 后出现`, '')
      return
    }
    // 等比铺满格子（contain，不留变形）
    const scale = Math.min(cw / v.videoWidth, ch / v.videoHeight)
    const dw = v.videoWidth * scale
    const dh = v.videoHeight * scale
    ctx2d.drawImage(v, x + (cw - dw) / 2, y + (ch - dh) / 2, dw, dh)
    if (s.gain <= 0.001) {
      ctx2d.fillStyle = 'rgba(0,0,0,0.35)'
      ctx2d.fillRect(x, y, cw - 1, ch - 1)
    }
    if (showTimes) moDrawCellTimes(ctx2d, x, y, cw, ch, moCellSpan(s))
    // 角标：播放时显示这一路相对主时钟的滞后，单路播放时显示它自己的时间
    if (!badges) return
    let txt = ''
    let cls = ''
    if (moPlaying) {
      const ms = Math.round((v.currentTime - (t - s.delay)) * 1000)
      const abs = Math.abs(ms)
      txt = abs <= 60 ? '同步' : `${ms < 0 ? '落后' : '超前'}${abs}ms`
      cls = abs <= 60 ? 'ok' : abs <= 250 ? 'warn' : 'bad'
    } else if (!v.paused) {
      txt = `播放 ${v.currentTime.toFixed(2)}s`
      cls = 'ok'
    } else if (s.gain <= 0.001) {
      txt = '静音'
    }
    moDrawBadge(ctx2d, x, y, cw, ch, i + 1, txt, cls)
  })
  if (moTimeEl) moTimeEl.textContent = `${moFmt(t)} / ${moFmt(moDuration())}`
  if (moSeekEl && !moSeekEl.dataset.dragging) {
    const d = moDuration()
    moSeekEl.value = String(d > 0 ? Math.round((t / d) * 1000) : 0)
  }
  // 当前受控窗口画一圈描边（空格键控制的就是它）
  if (moFocusIdx >= 0 && moFocusIdx < moSources.length) {
    const fcol = moFocusIdx % cols
    const frow = Math.floor(moFocusIdx / cols)
    if (frow < rows) {
      ctx2d.strokeStyle = '#4a7bd0'
      ctx2d.lineWidth = Math.max(2, Math.round(W / 320))
      ctx2d.strokeRect(fcol * cw + 1, frow * ch + 1, cw - 2, ch - 2)
    }
  }
}

/** 唯一的帧循环：主时钟播放 or 单路播放都走这里 */
function moLoop() {
  moRaf = 0
  if (moPlaying) {
    moMaster = (performance.now() - moT0) / 1000
    const dur = moDuration()
    const stopAt = moRangeActive() ? moRange.end : dur
    if ((stopAt > 0 && moMaster >= stopAt) || (dur > 0 && moMaster >= dur)) {
      moStopPreview()
      moMaster = moRangeActive() ? moRange.start : 0
      moDrawFrame(moMaster)
      moUpdateRowLabels(true)
      return
    }
    for (const s of moSources) {
      const want = moMaster + (s.seek || 0) - s.delay
      const v = s.video
      if (want < 0) {
        if (!v.paused) v.pause()
        continue
      }
      if (v.paused) {
        try {
          v.currentTime = want
          v.play().catch(() => {})
        } catch {}
      } else if (Math.abs(v.currentTime - want) > 0.25) {
        // 漂移超过 0.25s 才纠正，避免一直 seek 导致卡顿
        try {
          v.currentTime = want
        } catch {}
      }
    }
  } else if (!moAnyManualPlaying()) {
    // 没有任何窗口在单独播了：画最后一眼就收工
    moUpdateRowLabels(true)
    moDrawFrame(moMaster)
    return
  }
  moDrawFrame(moMaster)
  moUpdateRowLabels()
  moRaf = requestAnimationFrame(moLoop)
}

function moTogglePreview() {
  if (!moSources.length) {
    moSetStatus('先加几路进来再预览', 'warn')
    return
  }
  if (moPlaying) {
    moStopPreview()
    moUpdateRowLabels(true)
    return
  }
  moEnsureAudio()
  if (moAudioCtx && moAudioCtx.state === 'suspended') Promise.resolve(moAudioCtx.resume()).catch(() => {})
  // 「只用对齐区间」时从共同起点开始播，播到共同终点自动停
  if (moRangeActive()) {
    if (moMaster < moRange.start || moMaster >= moRange.end - 0.05) moMaster = moRange.start
  }
  // 从当前进度开始播
  const d = moDuration()
  moMaster = Math.min(moMaster, Math.max(0, d - 0.1))
  moT0 = performance.now() - moMaster * 1000
  moPlaying = true
  if (moPlayBtn) moPlayBtn.textContent = '⏸ 暂停'
  for (const s of moSources) {
    if (s.gainNode) s.gainNode.gain.value = s.gain
  }
  moUpdateRowLabels(true)
  if (!moRaf) moRaf = requestAnimationFrame(moLoop)
}

/* -------------------- 全屏看拼接 -------------------- */
function moIsFullscreen() {
  return document.body.classList.contains('mo-fs')
}

function moSyncFsBtn() {
  const on = moIsFullscreen()
  for (const btn of document.querySelectorAll('#mo-fs, #mo-fs2')) {
    btn.textContent = on ? '⛶ 退出全屏' : '⛶ 全屏'
    btn.classList.toggle('on', on)
  }
}

async function moToggleFullscreen() {
  const want = !moIsFullscreen()
  document.body.classList.toggle('mo-fs', want)
  moSyncCanvasSize()
  moSyncFsBtn()
  moDrawFrame(moMaster)
  try {
    const isFull = await window.pr.isFullscreen()
    if (Boolean(isFull) !== want) await window.pr.toggleFullscreen()
  } catch {}
  if (!want) moSyncCanvasSize()
  moDrawFrame(moMaster)
  // 画布尺寸/位置变了，格子顶部的控制条要重新贴
  requestAnimationFrame(() => moLayoutCellBars())
}

/** 导出：把源列表交给主进程 ffmpeg */
async function moRender() {
  if (moSources.length < 2) return
  const { cols, rows } = moLayoutColsRows()
  if (cols * rows < moSources.length) {
    moSetStatus(`布局 ${cols}×${rows} 放不下 ${moSources.length} 路`, 'warn')
    return
  }
  moStopPreview()
  const useRange = moRangeActive()
  const payload = {
    files: moSources.map((s) => s.path),
    gains: moSources.map((s) => s.gain),
    delays: moSources.map((s) => s.delay),
    seeks: moSources.map((s) => s.seek || 0),
    cols,
    rows,
    width: Number((moSizeEl && moSizeEl.value) || 1920),
    encoder: moNvencEl && moNvencEl.checked ? 'nvenc' : 'x264',
    fps: 30,
    // 拼好的成片放录制根目录（不是某个子目录里），和「合并」的习惯一致
    outDir: typeof recOutDir === 'string' && recOutDir ? recOutDir : ''
  }
  if (useRange) {
    payload.rangeStart = moRange.start
    payload.rangeEnd = moRange.end
  }
  moSetStatus(
    useRange
      ? `正在导出拼接视频…（只出对齐区间 ${moFmt(moRange.start)} – ${moFmt(moRange.end)}，按每路的音量混音）`
      : '正在导出拼接视频…（按每路的音量混音，延迟会补黑场）'
  )
  if (moRenderBtn) moRenderBtn.disabled = true
  const t0 = Date.now()
  moExportStartAt = t0
  moExportTotal = 0
  moExporting = true
  moShowProgress(0, '准备中…')
  // 同时登记成一个任务，任务面板里能一直看到进度
  const taskId = taskBegin(
    'mosaic',
    `${moSources.length} 路 · ${cols}×${rows}` + (useRange ? ` · 只出 ${moFmt(moRange.start)}–${moFmt(moRange.end)}` : ''),
    moSources.map((s) => s.name).join(' + ')
  )
  payload.taskId = taskId
  try {
    const res = await window.pr.recRenderMosaic(payload)
    if (!res || !res.ok) {
      moSetStatus('导出失败：' + ((res && res.error) || '未知错误'), 'err')
      moHideProgress(0)
      taskFinish(taskId, { ok: false, error: (res && res.error) || '未知错误' })
      return
    }
    const mb = res.size ? (res.size / 1024 / 1024).toFixed(1) + ' MB' : ''
    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    moShowProgress(100, `100% · ${res.duration || 0}s 成片 · 用时 ${secs}s`)
    moSetStatus(
      `导出完成：${res.out}  ${res.size2 || ''} ${mb}  时长 ${res.duration || '?'}s  用时 ${secs}s`,
      'ok'
    )
    statusEl.textContent = '拼接完成：' + String(res.out).split(/[\\/]/).pop()
    statusEl.className = 'ok'
    moHideProgress(4000)
    taskFinish(taskId, { ok: true, out: res.out, note: `${res.size2 || ''} ${mb} · ${res.duration || '?'}s`.trim() })
    if (typeof refreshEditFiles === 'function') refreshEditFiles({ silent: true, force: true })
  } catch (err) {
    moSetStatus('导出失败：' + ((err && err.message) || err), 'err')
    moHideProgress(2000)
    taskFinish(taskId, { ok: false, error: (err && err.message) || String(err) })
  } finally {
    moExporting = false
    if (moRenderBtn) moRenderBtn.disabled = moSources.length < 2
  }
}

if (moAddBtn) {
  moAddBtn.addEventListener('click', () => {
    // 勾选状态存在 editSelected 里（列表行是 .edit-row > input[data-path]，没有 .checked 类），
    // 所以这里必须读 editSelected + editFiles，不能再按 DOM class 去找。
    const picked = editFiles
      .filter((f) => editSelected.has(f.path) && !f.pending)
      .map((f) => ({ path: f.path, name: f.name }))
    if (!picked.length) {
      moSetStatus('先在左边「视频文件」里勾选要拼的文件（勾上后行首会显示 #1 #2 的拼接顺序）', 'warn')
      if (moStatusEl) moStatusEl.scrollIntoView({ block: 'nearest' })
      return
    }
    const before = moSources.length
    moAddSources(picked)
    const added = moSources.length - before
    if (!added) {
      moSetStatus(`选中的 ${picked.length} 个已经都在拼接里了`, 'warn')
    } else {
      moSetStatus(`已加入 ${added} 路（共 ${moSources.length} 路）`)
    }
    if (moSourcesEl) moSourcesEl.scrollIntoView({ block: 'nearest' })
  })
}
if (moClearBtn) {
  moClearBtn.addEventListener('click', () => {
    moStopPreview()
    while (moSources.length) moRemoveSource(moSources.length - 1)
    moSetStatus('')
  })
}
if (moLayoutEl) moLayoutEl.addEventListener('change', () => moRenderSources())
if (moPlayBtn) moPlayBtn.addEventListener('click', () => moTogglePreview())
if (moRenderBtn) moRenderBtn.addEventListener('click', () => moRender())
if (moFsBtn) moFsBtn.addEventListener('click', () => moToggleFullscreen())
// 拼接栏标题旁边那个「⛶ 全屏」，和预览右上角的是同一个开关
for (const btn of document.querySelectorAll('#mo-fs2')) btn.addEventListener('click', () => moToggleFullscreen())
// 全屏顶部那排也有「⌖ 按标定对齐」，行为完全一样
if (moAlign2Btn) moAlign2Btn.addEventListener('click', () => moAlignByMarks())
// 回起始 / 到结尾（全屏那排按钮）
{
  const jsBtn = document.getElementById('mo-jump-start')
  const jeBtn = document.getElementById('mo-jump-end')
  if (jsBtn) jsBtn.addEventListener('click', () => moJumpTo('start'))
  if (jeBtn) jeBtn.addEventListener('click', () => moJumpTo('end'))
}
if (moRangeOnlyEl) {
  moRangeOnlyEl.addEventListener('change', () => {
    const on = moRangeActive()
    if (moPlaying) moStopPreview()
    if (on && moRange) {
      moMaster = moRange.start
      moDrawFrame(moMaster)
    }
    moSetStatus(on && moRange ? `只用对齐区间：${moFmt(moRange.start)} – ${moFmt(moRange.end)}` : '整段预览/导出（包含各路起始前的黑格）')
  })
}
if (moFromMarkEl) moFromMarkEl.addEventListener('change', () => moApplyFromMarkMode())
if (moAlignBtn) moAlignBtn.addEventListener('click', () => moAlignByMarks())
if (moClearMarksBtn) moClearMarksBtn.addEventListener('click', () => moClearMarks())
/**
 * 方向键微调进度：
 *   ← / →             ±1 秒
 *   Shift+← / →       ±5 秒（粗调）
 *   Ctrl/⌘+← / →      ±0.1 秒（细调，用来对帧）
 * 有选中小窗就动那一路，没选中就动"一起播"的主时钟。
 * ↑ / ↓ 在几个小窗之间换选中。
 */
function moNudgeByKey(delta) {
  if (!moSources.length || !delta) return
  // 有选中的小窗：只动它
  if (moFocusIdx >= 0 && moSources[moFocusIdx]) {
    const s = moSources[moFocusIdx]
    // 主时钟在跑的话它会一直把这一路拽回去，先停主时钟（别的窗口继续播各自的）
    if (moPlaying) moStopMaster()
    const dur = Number.isFinite(s.video.duration) ? s.video.duration : 0
    if (!dur) return
    const now = Number(s.video.currentTime) || 0
    const next = Math.max(0, Math.min(dur, now + delta))
    try {
      s.video.currentTime = next
    } catch {}
    moDrawFrame(moMaster)
    moUpdateRowLabels(true)
    const moved = next - now
    moSetStatus(
      `#${moFocusIdx + 1} ${moved >= 0 ? '+' : '−'}${Math.abs(moved).toFixed(2)}s → ${next.toFixed(2)}s / ${dur.toFixed(2)}s` +
        (s.video.paused ? '' : '（播放中）')
    )
    if (!moRaf && moAnyManualPlaying()) moRaf = requestAnimationFrame(moLoop)
    return
  }
  // 没选中小窗：动"一起播"的主时钟（所有窗口按各自的延迟跟过来）
  const dur = moDuration()
  if (!dur) return
  const prev = moMaster
  const next = Math.max(0, Math.min(dur, prev + delta))
  moMaster = next
  for (const s of moSources) {
    try {
      s.video.currentTime = Math.max(0, next + (s.seek || 0) - s.delay)
    } catch {}
  }
  if (moPlaying) moT0 = performance.now() - next * 1000
  moDrawFrame(next)
  moUpdateRowLabels(true)
  const moved = next - prev
  moSetStatus(
    `一起播 ${moved >= 0 ? '+' : '−'}${Math.abs(moved).toFixed(2)}s → ${next.toFixed(2)}s / ${dur.toFixed(2)}s`
  )
  if (!moRaf && (moPlaying || moAnyManualPlaying())) moRaf = requestAnimationFrame(moLoop)
}

/** ↑ / ↓：在几个小窗之间换"受控"的那一个 */
function moCycleFocus(dir) {
  const n = moSources.length
  if (!n) return
  let next
  if (moFocusIdx < 0) next = dir > 0 ? 0 : n - 1
  else next = (moFocusIdx + dir + n) % n
  moSetFocus(next)
  moSetStatus(`已选中 #${next + 1} ${moSources[next].name}：←/→ 调进度，空格播放/暂停（Shift=5s，Ctrl=0.1s）`)
}

// 空格 / 方向键 / Esc：都只作用于"当前选中的那个小窗"
window.addEventListener(
  'keydown',
  (e) => {
    const inEdit = !document.getElementById('view-edit').classList.contains('hidden')
    // 只在「多窗口拼接」页签可见时生效：切到「图片片头」后方向键归那块的两个画面
    const moVisible = (() => {
      const p = document.getElementById('rpane-mosaic')
      return Boolean(p && !p.classList.contains('hidden'))
    })()
    const t = e.target
    const tag = t && t.tagName ? t.tagName : ''
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (t && t.isContentEditable)
    const isSpace = e.key === ' ' || e.code === 'Space' || e.key === 'Spacebar'
    if (isSpace) {
      // 不在剪辑页 / 正在输入框里打字时不管
      if (!inEdit || typing || !moVisible) return
      if (!moSources.length) return
      e.preventDefault()
      e.stopPropagation()
      moToggleByFocus()
      return
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      // 输入框/滑块里按方向键是它自己的事（移光标、挪滑块）
      if (!inEdit || typing || !moVisible) return
      if (!moSources.length) return
      const dir = e.key === 'ArrowRight' ? 1 : -1
      const step = e.shiftKey ? 5 : e.ctrlKey || e.metaKey ? 0.1 : 1
      e.preventDefault()
      e.stopPropagation()
      moNudgeByKey(dir * step)
      return
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (!inEdit || typing || !moVisible) return
      if (!moSources.length) return
      e.preventDefault()
      e.stopPropagation()
      moCycleFocus(e.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (e.key === 'Home' || e.key === 'End') {
      if (!inEdit || typing || !moVisible) return
      if (!moSources.length) return
      e.preventDefault()
      e.stopPropagation()
      moJumpTo(e.key === 'Home' ? 'start' : 'end')
      return
    }
    if (e.key !== 'Escape') return
    if (trimIsOpen()) {
      e.stopPropagation()
      trimClose()
      return
    }
    if (hpIsFs()) {
      e.stopPropagation()
      hpToggleFs()
      return
    }
    if (!moIsFullscreen()) return
    e.stopPropagation()
    moToggleFullscreen()
  },
  true
)
// 系统全屏被别的方式退掉了（F11 / 主进程），拼接视图也要跟着退
window.addEventListener('resize', () => {
  if (!moIsFullscreen()) {
    moLayoutCellBars()
    return
  }
  moSyncCanvasSize()
  moDrawFrame(moMaster)
  requestAnimationFrame(() => moLayoutCellBars())
})
/** 把主时钟定位到 t 秒（keepPlaying=true 时定位后继续播） */
function moSeekMaster(t, keepPlaying) {
  const wasPlaying = moPlaying
  const dur = moDuration()
  moStopPreview()
  moMaster = Math.max(0, Math.min(dur, Number(t) || 0))
  for (const s of moSources) {
    try {
      s.video.currentTime = Math.max(0, moMaster + (s.seek || 0) - s.delay)
    } catch {}
  }
  moDrawFrame(moMaster)
  moUpdateRowLabels(true)
  if (keepPlaying && wasPlaying) {
    moT0 = performance.now() - moMaster * 1000
    moPlaying = true
    if (moPlayBtn) moPlayBtn.textContent = '⏸ 暂停'
    if (!moRaf) moRaf = requestAnimationFrame(moLoop)
  }
}

/**
 * 回到起始 / 跳到结束：
 *   起始 = 共同区间起点（没算区间就是 0），继续播
 *   结束 = 共同区间终点（没算区间就是片尾），跳过去就停住
 */
function moJumpTo(where) {
  if (!moSources.length) return
  const dur = moDuration()
  if (!dur) return
  if (where === 'start') {
    const t = moRange ? moRange.start : 0
    const keep = moPlaying
    moSeekMaster(t, keep)
    moSetStatus(`回到起始位置 ${moFmtLong(t)}${keep ? '（继续播放）' : ''}`)
  } else {
    const t = moRange ? moRange.end : dur
    moSeekMaster(t, false)
    moSetStatus(`跳到结束位置 ${moFmtLong(t)}（已暂停）`)
  }
}

if (moSeekEl) {
  const seekTo = () => {
    const d = moDuration()
    const t = (Number(moSeekEl.value) / 1000) * d
    moSeekMaster(t, moPlaying)
  }
  moSeekEl.addEventListener('pointerdown', () => {
    moSeekEl.dataset.dragging = '1'
  })
  moSeekEl.addEventListener('pointerup', () => {
    delete moSeekEl.dataset.dragging
    // 拖完就放开焦点，否则后面的空格键会被这个 range 抢走（只是把滑块挪一格）
    moSeekEl.blur()
  })
  moSeekEl.addEventListener('input', () => {
    if (!moSeekEl.dataset.dragging) return
    const d = moDuration()
    moDrawFrame((Number(moSeekEl.value) / 1000) * d)
  })
  moSeekEl.addEventListener('change', seekTo)
}
window.addEventListener('beforeunload', () => {
  moStopPreview()
  try {
    if (moAudioCtx) moAudioCtx.close()
  } catch {}
})
moSyncCanvasSize()
moSyncFsBtn()

// 全屏时点某个格子 = 选中它（空格键就控制这一路的播放/暂停）；非全屏下不接管点击，免得误触
if (moCanvas) {
  moCanvas.addEventListener('click', (e) => {
    if (!moIsFullscreen()) return
    const r = moCanvas.getBoundingClientRect()
    const { cols, rows } = moLayoutColsRows()
    const cx = Math.floor(((e.clientX - r.left) / r.width) * cols)
    const cy = Math.floor(((e.clientY - r.top) / r.height) * rows)
    if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return
    const idx = cy * cols + cx
    if (idx >= moSources.length) return
    moSetFocus(idx)
    moSetStatus(`已选中 #${idx + 1} ${moSources[idx].name}：空格键播放/暂停这一路（再点空白处可换别的）`)
  })
}


init()
