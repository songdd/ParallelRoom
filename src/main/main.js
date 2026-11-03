'use strict'

/**
 * ParallelRoom —— 同一抖音账号并行进入多个直播间。
 *
 * 核心机制：
 *  1) 所有房间的 webview 共用同一个 session partition（persist:douyin），
 *     所以只需要扫码登录一次，登录态对全部房间同时生效。
 *  2) 每个房间是一个独立的 web content（独立渲染进程），各自维持自己的
 *     进房 + 心跳，互不覆盖，因此可以“都进房间、都不退出”。
 */

const { app, BrowserWindow, ipcMain, Menu, shell, session, dialog, screen, webContents, net } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const PARTITION = 'persist:douyin'

/** PR_ISOLATE=1：每个房间独立 partition（cookie 复制过去），用来隔离 localStorage/IndexedDB */
const ISOLATE = process.env.PR_ISOLATE === '1' || process.env.PR_ISOLATE === 'true'
const roomPartitions = new Set()

/* ---------------------------- 调试日志（可选） ---------------------------- */

const LOG_FILE = process.env.PR_LOG ? path.join(__dirname, '..', '..', '.tmp', 'main.log') : null

function log(...args) {
  if (!LOG_FILE) return
  const line = `[${new Date().toISOString()}] ${args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}\n`
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    fs.appendFileSync(LOG_FILE, line)
  } catch {
    // ignore
  }
  if (process.env.PR_LOG) process.stdout.write(line)
}

process.on('uncaughtException', (err) => log('uncaughtException', err && (err.stack || err.message)))
process.on('unhandledRejection', (err) => log('unhandledRejection', err && (err.stack || err.message)))
log('--- boot ---', { electron: process.versions.electron, chrome: process.versions.chrome, argv: process.argv })

// 便携模式：允许把用户数据（登录态、房间列表）放到指定目录。
if (process.env.PR_DATA_DIR) {
  try {
    app.setPath('userData', path.resolve(process.env.PR_DATA_DIR))
    log('userData ->', app.getPath('userData'))
  } catch (err) {
    log('setPath(userData) failed', err && err.message)
  }
}

/** 命令行预置房间：--rooms "https://a,https://b" 或重复的 --room=xxx */
function collectCliRooms() {
  const out = []
  const argv = process.argv.slice(1)
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--rooms' && argv[i + 1]) {
      out.push(...String(argv[i + 1]).split(','))
    } else if (arg.startsWith('--rooms=')) {
      out.push(...arg.slice('--rooms='.length).split(','))
    } else if (arg.startsWith('--room=')) {
      out.push(arg.slice('--room='.length))
    } else if (arg === '--room' && argv[i + 1]) {
      out.push(String(argv[i + 1]))
    }
  }
  if (process.env.PR_ROOMS) out.push(...process.env.PR_ROOMS.split(','))
  return out.map((s) => String(s).trim()).filter(Boolean)
}

const cliRooms = collectCliRooms()
if (cliRooms.length) log('cli rooms', cliRooms)

// 用一个正常的桌面 Chrome UA，避免站点识别出 Electron 后降级 / 拦截。
const CHROME_MAJOR = process.versions.chrome.split('.')[0]
const UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`

// 窗口失焦 / 被遮挡时也继续解码与心跳，否则后台房间会被降频甚至挂断。
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

/** @type {BrowserWindow | null} */
let win = null
/** @type {BrowserWindow | null} */
let loginWin = null
/** @type {Set<BrowserWindow>} */
const auxWins = new Set()

let statePath = ''
const state = {
  rooms: [],
  bounds: null,
  watchers: [],
  probeInterval: 90 * 1000,
  recOutDir: '',
  editDir: '',
  // 录制选项（「⚙ 录制选项」菜单里改）
  recMaxDurationMs: 60 * 60 * 1000,
  recMinFreeMb: 2048
}
let saveTimer = null
/** @type {import('./watchers').WatcherStore | null} */
let watcherStore = null
/** @type {import('./recorder').RecorderManager | null} */
let recorder = null
/** @type {Electron.WebContents[]} PR_LOG 下记录 guest，便于自检 */
const debugGuests = []

/* --------------------- 调试页：webContents 生命周期账本 --------------------- */

/**
 * 「调试」页要回答的问题：这些页面/进程到底有没有被释放。
 * 所以这里给每个 webContents 记一笔出生/销毁账（最多留 80 条），
 * 页面上就能看到"第 N 号页面几点建的、几点销毁的、现在还在不在"。
 */
const APP_STARTED_AT = Date.now()
const guestLifecycle = []
const guestLifecycleById = new Map()
let lifecycleHooked = false

function hookLifecycle() {
  if (lifecycleHooked) return
  lifecycleHooked = true
  app.on('web-contents-created', (event, wc) => {
    let type = '?'
    let url = ''
    let title = ''
    try {
      type = wc.getType()
    } catch {}
    try {
      url = String(wc.getURL() || '')
    } catch {}
    try {
      title = String(wc.getTitle() || '')
    } catch {}
    const rec = { id: wc.id, type, url, title, role: 'other', created: Date.now(), destroyed: 0 }
    try {
      rec.role = contentRole(wc, -1)
    } catch {}
    guestLifecycle.push(rec)
    guestLifecycleById.set(wc.id, rec)
    if (guestLifecycle.length > 80) {
      const old = guestLifecycle.shift()
      if (old && guestLifecycleById.get(old.id) === old) guestLifecycleById.delete(old.id)
    }
    try {
      wc.on('did-navigate', () => {
        try {
          rec.url = String(wc.getURL() || '')
        } catch {}
      })
    } catch {}
    // 标题就是"某某某的抖音直播间" —— 调试页拿它来显示主播名，比房间号好认
    try {
      wc.on('page-title-updated', (e, t) => {
        rec.title = String(t || '')
      })
    } catch {}
    try {
      wc.on('did-finish-load', () => {
        try {
          rec.title = String(wc.getTitle() || rec.title || '')
          rec.url = String(wc.getURL() || rec.url || '')
        } catch {}
      })
    } catch {}
    wc.on('destroyed', () => {
      rec.destroyed = Date.now()
    })
  })
}

/* ------------------------------ 状态持久化 ------------------------------ */

function loadState() {
  try {
    // 有些编辑器/工具写出的 JSON 带 UTF-8 BOM，JSON.parse 会直接失败
    const raw = fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed.rooms)) {
      state.rooms = parsed.rooms.filter((r) => r && typeof r.url === 'string')
    }
    if (parsed.bounds && typeof parsed.bounds === 'object') state.bounds = parsed.bounds
    if (Array.isArray(parsed.watchers)) state.watchers = parsed.watchers
    if (Number(parsed.probeInterval) > 0) state.probeInterval = Number(parsed.probeInterval)
    if (typeof parsed.recOutDir === 'string' && parsed.recOutDir) state.recOutDir = parsed.recOutDir
    if (typeof parsed.editDir === 'string' && parsed.editDir) state.editDir = parsed.editDir
    if (Number(parsed.recSegmentMs) >= 0) state.recSegmentMs = Number(parsed.recSegmentMs)
    if (typeof parsed.recKeepParts === 'boolean') state.recKeepParts = parsed.recKeepParts
    if (Number(parsed.recMaxDurationMs) >= 0) state.recMaxDurationMs = Number(parsed.recMaxDurationMs)
    if (Number(parsed.recMinFreeMb) >= 0) state.recMinFreeMb = Number(parsed.recMinFreeMb)
    if (parsed.recWatermark && typeof parsed.recWatermark === 'object') state.recWatermark = parsed.recWatermark
    if (Number(parsed.probeBlockedUntil) > 0) state.probeBlockedUntil = Number(parsed.probeBlockedUntil)
  } catch {
    // 首次运行或文件损坏，用默认值即可
  }
}

function persist(immediate = false) {
  const write = () => {
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true })
      if (watcherStore) {
        state.watchers = watcherStore.list
        state.probeInterval = watcherStore.intervalMs
        state.probeBlockedUntil = watcherStore.blockedUntil || 0
        state.probeCooldown = watcherStore.cooldownMs || 0
      }
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2))
    } catch (err) {
      console.warn('[state] 保存失败:', err.message)
    }
  }
  if (immediate) {
    clearTimeout(saveTimer)
    saveTimer = null
    write()
    return
  }
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    write()
  }, 300)
}

function rememberBounds() {
  if (!win || win.isDestroyed()) return
  state.bounds = win.getNormalBounds()
  persist()
}

/* --------------------------- 房间隔离（PR_ISOLATE） --------------------------- */

/** 把主 partition 的全部 cookie 复制给某个房间 partition，保证仍是同一登录账号。 */
async function copyCookiesTo(destPartition) {
  const srcCookies = session.fromPartition(PARTITION).cookies
  const dstCookies = session.fromPartition(destPartition).cookies
  let n = 0
  try {
    const cookies = await srcCookies.get({})
    for (const c of cookies) {
      const host = String(c.domain || '').replace(/^\./, '')
      if (!host) continue
      const details = {
        url: `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`,
        name: c.name,
        value: c.value,
        path: c.path || '/',
        secure: c.secure,
        httpOnly: c.httpOnly
      }
      if (!c.hostOnly && c.domain) details.domain = c.domain
      if (typeof c.expirationDate === 'number') details.expirationDate = c.expirationDate
      if (c.sameSite && c.sameSite !== 'unspecified') details.sameSite = c.sameSite
      try {
        await dstCookies.set(details)
        n += 1
      } catch {
        // 个别 cookie 写不进去不影响整体
      }
    }
  } catch (err) {
    log('cookie copy failed', err && err.message)
  }
  return n
}

function startCookieSync() {
  setInterval(() => {
    for (const p of roomPartitions) copyCookiesTo(p)
  }, 60 * 1000)
}

/* --------------------- 虎牙直录流（移植自 DouyinLiveRecorder 的思路） --------------------- */

/**
 * 虎牙这条链路的坑和解法（实测结论，别自己发明）：
 *
 *  · 网页播放器自己用的地址（`window.hyPlayerConfig` 里那份）在播放器环境之外拉，
 *    AL 线路直接 403，TX/HS 连上只吐 1~4 秒就被 CDN 切断 —— 签名缺了播放器侧的上下文。
 *  · 换成**微信小程序接口**拿流信息就正常了：
 *      https://mp.huya.com/cache.php?m=Live&do=profileRoom&roomid=<数字房间号>&showSecret=1
 *    带上 iOS UA + `xweb_xhr: 1` + 小程序 referer，返回的 `data.stream.baseSteamInfoList`
 *    里 anti-code 是按 App 客户端签的（`ctype=tars_mp&fs=bhct`）。
 *  · 这些地址要按**网页客户端**的身份再改两个参数才给拉：
 *      ctype=tars_mp → ctype=huya_webh5
 *      fs=bhct        → fs=bgct
 *    改完实测连续拉 45 秒不断（43.8 MB / 约 7.8 Mbps，1080p8M），不改就 0.5 秒断。
 *  · CDN 优先级 TX > HW > HS > AL（AL 基本不可用）。anti-code 大约 2 分钟有效，
 *    所以调用方要隔几十秒重新取一次（渲染层每 60 秒刷一次）。
 *
 * 以上思路来自 DouyinLiveRecorder（Python）的 spider.get_huya_app_stream_url，
 * 这里只移植"取地址 + 改写参数"这一段，不引入 Python 依赖。
 */
const HUYA_APP_UA = 'ios/7.830 (ios 17.0; ; iPhone 15 (A2846/A3089/A3090/A3092))'
const HUYA_APP_REFERER = 'https://servicewechat.com/wx74767bf0b684f7d3/301/page-frame.html'
const HUYA_CDN_ORDER = ['TX', 'HW', 'HS', 'AL']

/**
 * 虎牙这两个接口用 Node 自带的 fetch（undici），不用 Electron 的 net.fetch：
 * net.fetch 走默认 session，会被应用里的 webRequest 规则拦成 `net::ERR_BLOCKED_BY_CLIENT`（实测），
 * undici 直连没问题。
 */
async function huyaFetch(url, headers) {
  const res = await fetch(url, { headers: { ...headers } })
  const text = await res.text()
  return { status: res.status, text }
}

/** 主页名（huya.com/mingjie）→ 数字房间号；本来就是数字就直接用 */
async function huyaRoomId(url, hint) {
  // 渲染层能从页面里读到 TT_ROOM_DATA.profileRoom（最准；很多房间页 HTML 里已经没有 ProfileRoom 字段了）
  const h = String(hint || '').trim()
  if (/^\d{4,}$/.test(h)) return { roomId: h, from: 'page' }
  const m = String(url || '').match(/huya\.com\/([A-Za-z0-9_-]+)/i)
  const key = m ? m[1] : ''
  if (!key) return { roomId: '', from: '' }
  if (/^\d{4,}$/.test(key)) return { roomId: key, from: 'url' }
  try {
    const res = await huyaFetch(`https://www.huya.com/${key}`, {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml'
    })
    const id = (res.text.match(/ProfileRoom":(\d+)/) || res.text.match(/"profileRoom":(\d+)/) || [])[1] || ''
    return { roomId: id, from: 'html' }
  } catch {
    return { roomId: '', from: '' }
  }
}

/** 取虎牙的直录候选地址（已按网页客户端身份改好参数） */
async function huyaStreamCandidates(url, roomIdHint) {
  const got = await huyaRoomId(url, roomIdHint)
  const roomId = got.roomId
  if (!roomId) {
    return {
      ok: false,
      error: '认不出这个虎牙房间号（页面里没读到 profileRoom；把 https://www.huya.com/<房间号> 加进来试试）'
    }
  }
  let text = ''
  try {
    const q = new URLSearchParams({ m: 'Live', do: 'profileRoom', roomid: roomId, showSecret: '1' })
    const res = await huyaFetch(`https://mp.huya.com/cache.php?${q.toString()}`, {
      'User-Agent': HUYA_APP_UA,
      xweb_xhr: '1',
      referer: HUYA_APP_REFERER,
      'accept-language': 'zh-CN,zh;q=0.9'
    })
    text = res.text
  } catch (err) {
    return { ok: false, error: '虎牙接口请求失败：' + ((err && err.message) || err) }
  }
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  const d = json && json.data
  if (!d) return { ok: false, error: '虎牙接口没返回可用数据' }
  const anchor = String((d.profileInfo && d.profileInfo.nick) || '')
  if (d.realLiveStatus !== 'ON') return { ok: true, live: false, anchor, roomId, urls: [] }
  const list = (d.stream && d.stream.baseSteamInfoList) || []
  const webify = (u) =>
    String(u)
      .replace(/^http:/, 'https:')
      .replace('&ctype=tars_mp', '&ctype=huya_webh5')
      .replace('&fs=bhct', '&fs=bgct')
  const byCdn = new Map()
  for (const it of list) byCdn.set(String(it.sCdnType || ''), it)
  const urls = []
  const push = (it, cdn) => {
    if (!it) return
    const name = String(it.sStreamName || '')
    if (!name) return
    if (it.sFlvUrl && it.sFlvAntiCode) urls.push({ url: webify(`${it.sFlvUrl}/${name}.flv?${it.sFlvAntiCode}`), kind: 'flv', line: cdn })
    if (it.sHlsUrl && it.sHlsAntiCode) {
      urls.push({ url: webify(`${it.sHlsUrl}/${name}.m3u8?${it.sHlsAntiCode}`), kind: 'hls-playlist', line: cdn + '-hls' })
    }
  }
  for (const cdn of HUYA_CDN_ORDER) push(byCdn.get(cdn), cdn)
  // 不在优先级表里的线路也补在后面，别漏
  for (const [cdn, it] of byCdn) if (!HUYA_CDN_ORDER.includes(cdn)) push(it, cdn)
  return { ok: true, live: true, anchor, roomId, urls }
}

/* --------------------------- 直播流地址嗅探 --------------------------- */

/** webContentsId -> { url, ts }，用于“直接录流”模式 */
const streamUrls = new Map()
/** 需要拦截媒体流的 webContents（关注列表探测窗口） */
const mediaBlockIds = new Set()

/* ----------------------- 声音卫兵：别让关掉的房间还在出声 ----------------------- */

/**
 * 关瓦片时渲染层会 `webview.remove()`，正常情况下 guest 会被销毁、声音随之停止。
 * 但"元素被移除"和"guest 被销毁"不是同一件事（页面卡住 / 移除时机不对时，
 * 元素没了、进程还在播）。所以这里加一层对账：
 *  - 渲染层把当前还活着的瓦片 guest id 报上来（`guest:sync`）
 *  - 每 4 秒扫一遍所有 type=webview 的 webContents
 *      · 不在名单里 → 第一次先静音，第二次（≥4 秒后还在）直接关掉
 *      · 名单为空（一个瓦片都没有）→ 立刻静音所有 guest
 * 这样最坏情况也是"静音"，绝不会出现"房间都关了还有人在说话"。
 */
let tileGuestIds = new Set()
/** webContentsId -> 首次被发现是孤儿的时间 */
const orphanSeenAt = new Map()
let guestSweepTimer = null

function guestLogPath() {
  try {
    return path.join(app.getPath('userData'), 'guest-guard.log')
  } catch {
    return ''
  }
}

function guestLog(line) {
  log('[guard]', line)
  const p = guestLogPath()
  if (!p) return
  try {
    const st = fs.existsSync(p) ? fs.statSync(p) : null
    if (st && st.size > 512 * 1024) fs.renameSync(p, p + '.1')
    fs.appendFileSync(p, `[${new Date().toISOString()}] ${line}\n`)
  } catch {}
}

function webviewContents() {
  try {
    return webContents.getAllWebContents().filter((wc) => {
      try {
        return !wc.isDestroyed() && wc.getType() === 'webview'
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}

function killGuestById(id, why) {
  let wc = null
  try {
    wc = webContents.fromId(id)
  } catch {
    wc = null
  }
  if (!wc) return false
  let alive = true
  try {
    alive = !wc.isDestroyed()
  } catch {
    alive = false
  }
  if (!alive) return false
  let type = ''
  try {
    type = wc.getType()
  } catch {}
  if (type && type !== 'webview') return false
  try {
    wc.setAudioMuted(true)
  } catch {}
  let how = 'close'
  try {
    wc.close()
  } catch {
    try {
      wc.forcefullyCrashRenderer()
      how = 'crash'
    } catch {
      how = 'failed'
    }
  }
  guestLog(`kill ${id} (${why}) via ${how}`)
  return true
}

/** 扫一遍：名单外的 guest 要连续两轮都还在名单外，才认定是遗留并关掉 */
function sweepOrphanGuests(why) {
  const list = webviewContents()
  if (!list.length) {
    orphanSeenAt.clear()
    return { checked: 0, muted: 0, killed: 0 }
  }
  const now = Date.now()
  let killed = 0
  const seen = new Set()
  for (const wc of list) {
    let id = -1
    let url = ''
    let audible = false
    try {
      id = wc.id
      url = String(wc.getURL() || '').slice(0, 60)
      audible = wc.isCurrentlyAudible()
    } catch {}
    if (id <= 0) continue
    if (tileGuestIds.has(id)) {
      orphanSeenAt.delete(id)
      continue
    }
    seen.add(id)
    const first = orphanSeenAt.get(id) || 0
    if (!first) {
      // 第一轮只记账：新瓦片的 guest 在创建后 ~1 秒内就会被报进名单，
      // 这里不动手，免得把"刚打开还没上报"的房间静音。
      orphanSeenAt.set(id, now)
      continue
    }
    // 连续两轮（≥4 秒）都还在名单外 → 认定是真的遗留
    if (now - first >= 3500) {
      orphanSeenAt.delete(id)
      if (killGuestById(id, `orphan ${why}`)) killed += 1
    }
  }
  // 已经消失的 id 清掉，避免 Map 无界增长
  for (const id of [...orphanSeenAt.keys()]) if (!seen.has(id)) orphanSeenAt.delete(id)
  return { checked: list.length, killed }
}

function startGuestGuard() {
  if (guestSweepTimer) return
  guestSweepTimer = setInterval(() => {
    try {
      const r = sweepOrphanGuests('sweep')
      if (r.killed) guestLog(`sweep done ${JSON.stringify(r)}`)
    } catch (err) {
      log('[guard] sweep failed', err && err.message)
    }
  }, 4000)
}

function installStreamSniffer() {
  const ses = session.fromPartition(PARTITION)
  const seen = new Set()
  /** 地址类型：FLV 最可靠；m3u8 是真 HLS 播放列表；剩下 pull-hls 无扩展名的多半是单个分片（只能录几秒） */
  const kindOf = (url) => {
    if (/\.flv(\?|#|$)/i.test(url)) return 'flv'
    if (/\.m3u8(\?|#|$)/i.test(url)) return 'hls-playlist'
    return 'hls-other'
  }
  // 注意：同一 session 的 onBeforeRequest 只能挂一个监听，这里统一处理
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    try {
      const url = details.url || ''
      const isMedia = details.resourceType === 'media' || /\.(flv|m3u8|ts|mp4|m4s)(\?|#|$)/i.test(url)
      if (isMedia && mediaBlockIds.has(details.webContentsId)) {
        callback({ cancel: true })
        return
      }
      if (/\.flv(\?|$)|\.m3u8(\?|$)|pull-flv|pull-hls/i.test(url) && details.webContentsId) {
        // ⚠️ 不能只留"最后一条"：抖音有的房间会再请求一个 `pull-hls-.../6764832` 这种
        // 无扩展名的 HLS 分片，它会把正确的 FLV 地址顶掉，录出来只有 4 秒。
        // 所以按类型留候选，取用的时候再按优先级挑。
        const key = String(details.webContentsId)
        const rec = streamUrls.get(key) || { candidates: [] }
        const kind = kindOf(url)
        const now = Date.now()
        rec.candidates = [
          { url, ts: now, kind },
          ...(rec.candidates || []).filter((c) => c.url !== url)
        ].slice(0, 8)
        streamUrls.set(key, rec)
        if (process.env.PR_SNIFF) {
          const k = url.slice(0, 100)
          if (!seen.has(k)) {
            seen.add(k)
            log('sniff stream', kind, details.resourceType, url.slice(0, 240))
          }
        }
      }
    } catch {}
    callback({})
  })
}

function toggleWindowFullscreen() {
  if (!win || win.isDestroyed()) return false
  const before = win.isFullScreen()
  win.setFullScreen(!before)
  setTimeout(() => {
    if (win && !win.isDestroyed()) {
      log('toggle fullscreen', { before, after: win.isFullScreen(), bounds: win.getBounds() })
    }
  }, 300)
  return win.isFullScreen()
}

/**
 * F11 必须在主进程拦：焦点在 <webview>（抖音页面）里时，
 * 渲染层 window 上的 keydown 根本收不到，按键会被 guest 页面吃掉。
 * 用 before-input-event 在页面拿到之前截获，窗口和每个 guest 都要挂。
 */
function attachFullscreenKeys(webContents, label) {
  if (!webContents) return
  webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return

    // Ctrl+Shift+R：录制/停止鼠标所在瓦片；Ctrl+Shift+S：停止全部录制；
    // Ctrl+Shift+W：整窗录制开关；Ctrl+Shift+H：显隐工具栏
    if (input.control && input.shift && !input.alt && !input.meta) {
      const key = String(input.key || '').toLowerCase()
      if (key === 'r' || key === 's' || key === 'w') {
        event.preventDefault()
        const action = key === 'r' ? 'toggle' : key === 'w' ? 'window' : 'stop-all'
        recordingHotkey(action, label)
        return
      }
      if (key === 'h') {
        event.preventDefault()
        if (win && !win.isDestroyed()) win.webContents.send('ui:toggle-bar')
        log('toggle bar hotkey', label)
        return
      }
    }

    if (input.key === 'F11') {
      event.preventDefault()
      const isFull = toggleWindowFullscreen()
      log('F11 toggle fullscreen ->', isFull, label)
      return
    }
    // F1 / ?：打开快捷键帮助。焦点在 guest 里时渲染层收不到 keydown，所以在这里转过去
    if (input.key === 'F1' || (input.key === '?' && !input.control && !input.alt)) {
      event.preventDefault()
      if (win && !win.isDestroyed()) win.webContents.send('ui:open-help')
      log('open help', label)
      return
    }
    if (input.key === 'Escape' && win && !win.isDestroyed() && win.isFullScreen()) {
      event.preventDefault()
      toggleWindowFullscreen()
      log('Esc exit fullscreen', label)
    }
  })
}

/** 录制热键：把鼠标在窗口里的位置告诉渲染层，由它决定录哪个瓦片 */
function recordingHotkey(action, fromLabel) {
  if (!win || win.isDestroyed()) return
  let point = null
  try {
    const cursor = screen.getCursorScreenPoint()
    const content = win.getContentBounds()
    point = { x: Math.round(cursor.x - content.x), y: Math.round(cursor.y - content.y) }
  } catch (err) {
    log('hotkey cursor failed', err && err.message)
  }
  log('recording hotkey', action, fromLabel, JSON.stringify(point))
  win.webContents.send('rec:hotkey', { action, point })
}


/* ------------------------ 瓦片实际流量 → 反刷监控 ------------------------ */

/**
 * 打开观看的瓦片如果真在拉流，就用这个事实去纠正监控状态。
 *
 * 为什么不在渲染层读页面：已结束的房间页会把渲染主线程卡死，读不到"直播已结束"。
 * 所以主要靠主进程用 CDP 的 Network.dataReceived 量流量。
 *
 * ⚠️ 踩过的坑（用户实测「一直在看却显示未开播」）：抖音播放器不是匀速拉流的，
 * 它一次拉一大块（实测单块到 89MB）然后播一段，这段时间流量就是 0。
 * 早期版本用「6 秒窗口瞬时速率」判活，窗口正好落在间隙里就把在播房间判成停播
 * （实测同一房间：+18~+24s 窗口 0KB/s 判 offline，5 秒后 15 秒窗口 678KB/s 判 live）。
 *
 * 现在的规则：
 *   1. 判「在播」用长窗口平均（最长 90 秒），不再看瞬时值，间歇为 0 不吃亏；
 *   2. 判「停播」必须同时满足：长窗口平均低 + 页面里的 `<video>` 确实没在放
 *      （currentTime 没前进 / paused / videoWidth=0 / 主线程卡死读不到）；
 *   3. 打开后 18 秒那次「快速判定」只允许报 live，绝不报 offline——它是加速修正，
 *      不是证据。
 */

/** 长窗口平均速率阈值（字节/秒）。实测在播：674–3098KB/s；停播：0 */
const TILE_LIVE_BPS = 150 * 1024
/** 采样间隔 */
const TILE_SAMPLE_MS = 15000
/** 连续几次低流量才允许判停播（一次 15 秒） */
const TILE_OFFLINE_STREAK = 2
/** 长窗口上限：覆盖"拉一块、播一段"的间歇，90 秒内平均不会被间隙吃掉 */
const TILE_WINDOW_MS = 90 * 1000
/** 读页面视频状态的超时：已结束房间主线程卡死，等久了会拖住采样 */
const TILE_JS_TIMEOUT_MS = 4000

const tileMeters = new Map()
let tileSamplerTimer = null

/** 从 guest 的 URL 里取房间号 */
function tileRoomId(id) {
  try {
    const g = require('electron').webContents.fromId(id)
    const u = (g && g.getURL && g.getURL()) || ''
    return (u.match(/live\.douyin\.com\/(\d{5,})/) || [])[1] || ''
  } catch {
    return ''
  }
}

/**
 * 页面里的视频到底在不在放。
 * @returns {Promise<null | { paused: boolean, ct: number|null, vw: number, rs: number }>} null = 读不到（超时/页面卡死）
 */
async function tileVideoState(id) {
  let g
  try {
    g = require('electron').webContents.fromId(id)
  } catch {
    return null
  }
  if (!g || g.isDestroyed()) return null
  const js = `(() => {
    const v = document.querySelector('video')
    if (!v) return { paused: true, ct: null, vw: 0, rs: 0, src: '' }
    return {
      paused: !!v.paused,
      ct: Number.isFinite(v.currentTime) ? v.currentTime : null,
      vw: v.videoWidth || 0,
      rs: v.readyState || 0,
      // 直播流走 MSE（currentSrc 空 / blob:）；已结束页面循环播的是 xxx.mp4 广告片，别把它当直播
      src: v.currentSrc || v.src || ''
    }
  })()`
  try {
    const res = await Promise.race([
      g.executeJavaScript(js, true),
      new Promise((r) => setTimeout(() => r('__timeout__'), TILE_JS_TIMEOUT_MS))
    ])
    if (res === '__timeout__' || !res) return null
    return res
  } catch {
    return null
  }
}

function attachTileMeter(guest) {
  const id = guest.id
  if (tileMeters.has(id)) return
  const dbg = guest.debugger
  /** win: 长窗口样本 [{t, bytes}]；prevCt: 上一次读到的 currentTime（判"有没有前进"） */
  const entry = { bytes: 0, win: [], lowStreak: 0, prevCt: null, stopped: false }
  try {
    if (dbg.isAttached()) dbg.detach()
    dbg.attach('1.3')
  } catch (err) {
    log('tile meter attach failed', id, err && err.message)
    return
  }
  const onMsg = (event, method, params) => {
    if (method === 'Network.dataReceived') entry.bytes += params.dataLength || 0
  }
  dbg.on('message', onMsg)
  dbg.sendCommand('Network.enable').catch(() => {})

  entry.stop = () => {
    entry.stopped = true
    try {
      dbg.removeListener('message', onMsg)
      dbg.detach()
    } catch {}
  }
  tileMeters.set(id, entry)
  log('tile meter attached', id)

  // 打开后尽快给一次判定：等过页面加载突发（实测前 10 秒能到 3–8MB/s）再取样。
  // 这一段只用来"尽快报在播"，判停播一律交给长窗口 + 视频状态。
  setTimeout(async () => {
    const current = tileMeters.get(id)
    if (!current) return
    await new Promise((r) => setTimeout(r, 6000))
    if (!tileMeters.has(id)) return
    const before = current.bytes
    await new Promise((r) => setTimeout(r, 6000))
    if (!tileMeters.has(id)) return
    const bps = (current.bytes - before) / 6
    const roomId = tileRoomId(id)
    if (!roomId || !watcherStore) return
    if (bps >= TILE_LIVE_BPS) {
      log('tile meter quick verdict', roomId, `${Math.round(bps / 1024)}KB/s`, 'live')
      watcherStore.reportStatus(roomId, 'live')
    } else {
      log('tile meter quick verdict', roomId, `${Math.round(bps / 1024)}KB/s`, 'inconclusive（这一小段没流量，交给长窗口）')
    }
  }, 12000)
}

async function sampleTileMeters() {
  if (!tileMeters.size || !watcherStore) return
  const now = Date.now()
  /** @type {Array<{id:number, roomId:string, entry:any, avg:number, span:number}>} */
  const candidates = []

  for (const [id, entry] of tileMeters) {
    entry.win.push({ t: now, bytes: entry.bytes })
    while (entry.win.length > 2 && now - entry.win[0].t > TILE_WINDOW_MS) entry.win.shift()

    const first = entry.win[0]
    const span = (now - first.t) / 1000
    const roomId = tileRoomId(id)
    if (!roomId) continue
    // 窗口还没攒够 20 秒不下判断（刚打开时全是加载突发，判什么都不准）
    if (span < 20) continue

    const avg = (entry.bytes - first.bytes) / span
    if (avg >= TILE_LIVE_BPS) {
      entry.lowStreak = 0
      entry.prevCt = null
      watcherStore.reportStatus(roomId, 'live')
      log('tile meter', roomId, `${Math.round(avg / 1024)}KB/s`, `avg${Math.round(span)}s`, 'live')
      continue
    }

    entry.lowStreak += 1
    log('tile meter', roomId, `${Math.round(avg / 1024)}KB/s`, `avg${Math.round(span)}s`, `low#${entry.lowStreak}`)
    candidates.push({ id, roomId, entry, avg, span })
  }

  // 低流量的才去读一次视频状态（在播的房间不需要每次读，省 CPU）
  for (const c of candidates) {
    const st = await tileVideoState(c.id)
    if (!tileMeters.has(c.id)) continue

    let advanced = null
    if (st && st.ct != null && c.entry.prevCt != null) advanced = st.ct - c.entry.prevCt
    if (st && st.ct != null) c.entry.prevCt = st.ct

    // 视频真的在放：currentTime 前进（或刚拿到第一个样本但没暂停且有画面），就算没流量也是在播。
    // 已结束的页面会循环播一个 mp4 广告片，那种不算直播。
    const adMp4 = !!st && /\.mp4(\?|#|$)/i.test(String(st.src || ''))
    const looksPlaying = !!st && !st.paused && st.vw > 0 && !adMp4 && (advanced == null || advanced > 0.5)
    if (looksPlaying) {
      c.entry.lowStreak = 0
      watcherStore.reportStatus(c.roomId, 'live')
      log('tile meter', c.roomId, `${Math.round(c.avg / 1024)}KB/s`, 'video still playing → live')
      continue
    }

    // 读不到页面（已结束的房间主线程会卡死）或明确没在放，才允许判停播
    const conclusive = st === null || st.paused || st.vw === 0 || adMp4 || (advanced != null && advanced <= 0.5)
    if (!conclusive) {
      log('tile meter', c.roomId, 'low traffic but video state unclear, keep last status')
      continue
    }
    if (c.entry.lowStreak < TILE_OFFLINE_STREAK) {
      log('tile meter', c.roomId, `low#${c.entry.lowStreak}`, 'not enough samples to call it offline')
      continue
    }
    const why =
      st === null
        ? 'js-timeout(页面卡死)'
        : adMp4
          ? '只播着广告 mp4'
          : st.paused
            ? 'video paused'
            : st.vw === 0
              ? 'no video frame'
              : 'currentTime stuck'
    const before = watcherStore.list.find((x) => String(x.roomId) === c.roomId)
    const wasOffline = before && before.status === 'offline'
    watcherStore.reportStatus(c.roomId, 'offline')
    c.entry.lowStreak = 0
    if (!wasOffline) log('tile meter verdict', c.roomId, `${Math.round(c.avg / 1024)}KB/s`, 'offline', why)
  }
}

function startTileSampler() {
  if (tileSamplerTimer) return
  tileSamplerTimer = setInterval(sampleTileMeters, TILE_SAMPLE_MS)
}

/* -------------------------------- 窗口 -------------------------------- */

function createMainWindow() {
  const b = state.bounds || {}
  win = new BrowserWindow({
    width: b.width || 1600,
    height: b.height || 950,
    x: b.x,
    y: b.y,
    minWidth: 960,
    minHeight: 560,
    backgroundColor: '#0d0e12',
    title: 'ParallelRoom',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  })

  Menu.setApplicationMenu(null)
  win.setMenuBarVisibility(false)
  attachFullscreenKeys(win.webContents, 'main')
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html')).catch((err) => log('loadFile failed', err && err.message))
  log('window created', win.getBounds())

  win.webContents.on('console-message', (event, level, message, line, sourceId) => {
    log('renderer console', level, message, `${sourceId}:${line}`)
  })
  win.webContents.on('preload-error', (event, preloadPath, error) => {
    log('preload-error', preloadPath, error && (error.stack || error.message))
  })
  win.webContents.on('did-fail-load', (event, code, desc, url, isMainFrame) => {
    log('renderer did-fail-load', code, desc, url, `mainFrame=${isMainFrame}`)
  })
  win.webContents.on('render-process-gone', (event, details) => log('renderer process gone', details))
  win.on('unresponsive', () => log('window unresponsive'))

  /**
   * 关窗口这条路上出过两个坑，都在这里处理：
   *
   * 1) 正在录制时直接销毁窗口，就变成"窗口没了、进程还在合并分段"，
   *    而单实例锁还被这个进程占着 —— 这时再点 start.bat，新进程拿不到锁会立刻退出，
   *    旧进程又没有窗口可显示，于是"用 start.bat 启动却看不到界面"。
   *    → 有录制就先拦住关闭，把状态栏改成"正在保存录制…"，收尾完再真正关。
   *
   * 2) 探测/录制用到的隐藏窗口（BrowserWindow，show:false）会一直活着，
   *    于是 'window-all-closed' 永远不触发，主窗口关掉后进程变成僵尸。
   *    → 主窗口 closed 后直接 app.quit()，不再指望 window-all-closed。
   */
  win.on('close', (event) => {
    if (!recorder || !recorder.actives || recorder.actives.size === 0) return
    if (closingAfterFinalize) return
    closingAfterFinalize = true
    event.preventDefault()
    log('window close: finalize recordings first', recorder.actives.size)
    try {
      win.webContents.executeJavaScript(
        "(() => { const s = document.getElementById('status'); if (s) { s.textContent = '正在保存录制（合并分段）… 完成会自动关闭窗口'; s.className = 'rec-on' } return 1 })()",
        true
      ).catch(() => {})
    } catch {}
    Promise.resolve(recorder.dispose())
      .catch((err) => log('close-time finalize failed', err && err.message))
      .finally(() => {
        closingAfterFinalize = false
        if (win && !win.isDestroyed()) win.close()
        else app.quit()
      })
  })
  win.on('closed', () => {
    log('main window closed -> quit')
    win = null
    // 隐藏的探测窗口还在，window-all-closed 不会来，这里主动退
    app.quit()
  })

  // 强制每个 guest webview 落在同一个 partition 上，并锁掉不安全选项。
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.backgroundThrottling = false
    webPreferences.autoplayPolicy = 'no-user-gesture-required'
    const wantPartition = typeof params.partition === 'string' ? params.partition : ''
    const allowIsolated = ISOLATE && wantPartition.startsWith('persist:room-')
    webPreferences.partition = allowIsolated ? wantPartition : PARTITION
    params.partition = webPreferences.partition
  })

  win.webContents.on('did-attach-webview', (event, guest) => {
    const id = guest.id
    log('guest attached', id)
    if (process.env.PR_LOG) debugGuests.push(guest)
    try {
      // zoom 会被 Chromium 按站点持久化，别让调试期的倍率残留下来
      guest.setZoomFactor(1)
    } catch {}
    try {
      guest.setUserAgent(UA)
    } catch (err) {
      console.warn('[guest] setUserAgent 失败:', err.message)
    }
    guest.on('dom-ready', () => log('guest dom-ready', id, guest.getURL()))
    // 每个房间瓦片都挂一个流量计量器（CDP，不受页面主线程影响）
    attachTileMeter(guest)
    guest.on('destroyed', () => {
      const m = tileMeters.get(id)
      if (m && m.stop) m.stop()
      tileMeters.delete(id)
      orphanSeenAt.delete(id)
    })
    // 抖音页面里的 F11 / Esc 也要能进出全屏
    attachFullscreenKeys(guest, `guest-${id}`)
    if (process.env.PR_DIAG) {
      guest.on('console-message', (e, level, message, line, srcId) => {
        const m = String(message)
        if (m.length > 400) return
        log('guest console', id, level, m, `${srcId}:${line}`)
      })
    }
    guest.on('did-finish-load', () => log('guest did-finish-load', id, guest.getTitle()))
    guest.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
      if (isMainFrame) log('guest did-fail-load', id, code, desc, url)
    })
    guest.on('render-process-gone', (e, details) => log('guest render-process-gone', id, details))
    // 站点里的 window.open（登录、分享面板等）不放进 guest 内部，
    // 而是开一个共享同一 session 的独立窗口，避免影响房间本身。
    guest.setWindowOpenHandler(({ url }) => {
      openAuxWindow(url)
      return { action: 'deny' }
    })
  })

  win.on('resize', rememberBounds)
  win.on('move', rememberBounds)
  win.on('enter-full-screen', () => {
    log('event enter-full-screen', win ? win.getBounds() : null)
    if (!win || win.isDestroyed()) return
    // 主进程直接改 DOM：不依赖渲染层是否收到/处理了事件
    win.webContents
      .executeJavaScript(
        "document.body.classList.add('fs'); document.body.classList.remove('peek'); console.log('[fs] forced by main -> on'); 1",
        true
      )
      .catch((err) => log('force fs on failed', err && err.message))
    win.webContents.send('win:fullscreen', true)
  })
  win.on('leave-full-screen', () => {
    log('event leave-full-screen', win ? win.getBounds() : null)
    if (!win || win.isDestroyed()) return
    win.webContents
      .executeJavaScript(
        "document.body.classList.remove('fs'); document.body.classList.remove('peek'); console.log('[fs] forced by main -> off'); 1",
        true
      )
      .catch((err) => log('force fs off failed', err && err.message))
    win.webContents.send('win:fullscreen', false)
  })
  win.on('close', () => persist(true))
  win.on('closed', () => {
    win = null
  })

  return win
}

/**
 * 站点里的 window.open 是否值得单独开窗。
 *
 * 早先的版本对所有 window.open 一律新开窗口，结果直播间里的引流广告、
 * 搜索跳转被反复弹成独立窗口。现在只放行抖音自家域名，其余一律拦掉，
 * 并对同一路径做 30 秒去重、总窗口数封顶。
 */
const AUX_ALLOWED_HOST = /(^|\.)douyin\.com$/i
const AUX_DEDUPE_MS = 30 * 1000
const AUX_MAX_WINDOWS = 3
const auxRecent = new Map()

function shouldOpenAux(rawUrl) {
  if (typeof rawUrl !== 'string' || !/^https?:\/\//i.test(rawUrl)) {
    return { ok: false, reason: 'not-http' }
  }
  let u
  try {
    u = new URL(rawUrl)
  } catch {
    return { ok: false, reason: 'bad-url' }
  }
  if (!AUX_ALLOWED_HOST.test(u.hostname)) {
    return { ok: false, reason: 'third-party' }
  }
  // 直播间里的“搜索”跳转基本都是引流，不是用户要点的东西
  if (/^\/(search|discover)\b/i.test(u.pathname)) {
    return { ok: false, reason: 'search-page' }
  }
  const key = u.origin + u.pathname
  const now = Date.now()
  for (const [k, ts] of auxRecent) {
    if (now - ts > 2 * AUX_DEDUPE_MS) auxRecent.delete(k)
  }
  const last = auxRecent.get(key)
  if (last && now - last < AUX_DEDUPE_MS) {
    return { ok: false, reason: 'duplicate' }
  }
  if (auxWins.size >= AUX_MAX_WINDOWS) {
    return { ok: false, reason: 'too-many-windows' }
  }
  auxRecent.set(key, now)
  return { ok: true, reason: 'allowed', url: u.toString() }
}

function openAuxWindow(url) {
  const verdict = shouldOpenAux(url)
  if (!verdict.ok) {
    log('aux window blocked', verdict.reason, url)
    return false
  }
  const aux = new BrowserWindow({
    width: 1000,
    height: 800,
    backgroundColor: '#ffffff',
    title: '抖音',
    autoHideMenuBar: true,
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  aux.setMenuBarVisibility(false)
  aux.loadURL(verdict.url).catch(() => {})
  auxWins.add(aux)
  aux.on('closed', () => auxWins.delete(aux))
  log('aux window opened', verdict.url)
  return true
}

/** 登录窗口：扫一次码，登录态写进共享 partition。 */
/** 登录窗口支持的目标站点（登录态都落在同一个 partition，瓦片直接复用） */
const LOGIN_SITES = {
  douyin: { url: 'https://live.douyin.com/', title: '抖音登录（登录态对全部房间共享）' },
  huya: { url: 'https://www.huya.com/', title: '虎牙登录（登录后可看更高画质；扫码完成后关掉这个窗口）' }
}

function openLoginWindow(target) {
  const site = LOGIN_SITES[target] || LOGIN_SITES.douyin
  if (loginWin && !loginWin.isDestroyed()) {
    let cur = ''
    try {
      cur = String(loginWin.webContents.getURL() || '')
    } catch {}
    const wantHuya = target === 'huya'
    const isHuya = /huya\.com/.test(cur)
    loginWin.show()
    loginWin.focus()
    if (wantHuya !== isHuya) {
      try {
        loginWin.setTitle(site.title)
        loginWin.loadURL(site.url).catch(() => {})
      } catch {}
    }
    return
  }
  loginWin = new BrowserWindow({
    width: 1040,
    height: 820,
    title: site.title,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  })
  loginWin.setMenuBarVisibility(false)
  loginWin.webContents.setUserAgent(UA)
  loginWin.loadURL(site.url).catch(() => {})
  loginWin.webContents.setWindowOpenHandler(({ url }) => {
    openAuxWindow(url)
    return { action: 'deny' }
  })
  loginWin.on('closed', () => {
    loginWin = null
  })
  return
}

/* -------------------------------- IPC -------------------------------- */

function registerIpc() {
  ipcMain.handle('state:load', () => ({
    rooms: state.rooms,
    pending: cliRooms,
    isolate: ISOLATE,
    ua: UA,
    partition: PARTITION,
    chrome: process.versions.chrome,
    electron: process.versions.electron
  }))

  ipcMain.handle('room:prepare', async (event, name) => {
    if (typeof name !== 'string' || !name.startsWith('persist:room-')) return 0
    roomPartitions.add(name)
    const n = await copyCookiesTo(name)
    log('room partition prepared', name, 'cookies', n)
    return n
  })

  ipcMain.handle('state:save-rooms', (event, rooms) => {
    if (!Array.isArray(rooms)) return false
    state.rooms = rooms
      .filter((r) => r && typeof r.url === 'string' && r.url.length > 0)
      .map((r) => ({ url: r.url, muted: r.muted === true }))
    persist()
    return true
  })

  ipcMain.handle('login:open', (event, target) => {
    openLoginWindow(typeof target === 'string' ? target : 'douyin')
    return true
  })

  ipcMain.handle('session:clear', async () => {
    try {
      const ses = session.fromPartition(PARTITION)
      await ses.clearStorageData()
      await ses.clearCache()
      return true
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('external:open', (event, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url)
    return true
  })

  // 渲染层把"当前还活着的瓦片 guest"报上来，供卫兵对账
  ipcMain.handle('guest:sync', (event, ids) => {
    if (!Array.isArray(ids)) return false
    const next = new Set()
    for (const id of ids) {
      const n = Number(id)
      if (Number.isInteger(n) && n > 0) next.add(n)
    }
    if (next.size !== tileGuestIds.size || [...next].some((id) => !tileGuestIds.has(id))) {
      log('guest sync', { count: next.size })
    }
    tileGuestIds = next
    // 名单里的 id 一定不是孤儿，立刻把孤儿记录清掉
    for (const id of [...orphanSeenAt.keys()]) if (next.has(id)) orphanSeenAt.delete(id)
    // 最后一个瓦片也关了 → 马上扫一遍，把不在名单里的 guest 收尾
    if (!next.size) sweepOrphanGuests('all-closed')
    return true
  })

  // 关瓦片时点名销毁那一个 guest：不依赖"移除 DOM 就一定销毁"这件事
  ipcMain.handle('guest:kill', (event, webContentsId) => {
    const id = Number(webContentsId)
    if (!Number.isInteger(id) || id <= 0) return false
    return killGuestById(id, 'renderer-request')
  })

  // 调试页：资源快照 / 保存快照 / 手工释放某个页面
  ipcMain.handle('debug:snapshot', () => debugSnapshot())
  ipcMain.handle('debug:save', (event, payload) => saveDebugSnapshot(payload))
  ipcMain.handle('debug:release', (event, webContentsId) => {
    const id = Number(webContentsId)
    if (!Number.isInteger(id) || id <= 0) return { ok: false, error: '无效的 id' }
    let mainId = -1
    try {
      mainId = win && !win.isDestroyed() ? win.webContents.id : -1
    } catch {}
    if (id === mainId) return { ok: false, error: '这是主窗口自己，不能释放' }
    let target = null
    try {
      target = webContents.fromId(id)
    } catch {
      target = null
    }
    if (!target) return { ok: false, error: '这个页面已经不存在了' }
    let type = ''
    let destroyed = true
    try {
      type = target.getType()
    } catch {}
    try {
      destroyed = target.isDestroyed()
    } catch {}
    if (destroyed) return { ok: false, error: '已经释放过了' }
    // 先静音，再关：即使关闭要几百毫秒，也不会先听到一耳朵
    try {
      target.setAudioMuted(true)
    } catch {}
    let how = 'close'
    try {
      target.close()
    } catch {
      try {
        target.forcefullyCrashRenderer()
        how = 'crash'
      } catch {
        how = 'failed'
      }
    }
    guestLog(`manual release ${id} (${type || '?'}) via ${how}`)
    return { ok: true, id, type, how }
  })

  ipcMain.handle('rec:start', async (event, params) => {
    if (!recorder) return { ok: false, error: '录制模块未就绪' }
    return recorder.start(params || {})
  })

  ipcMain.handle('rec:stop', (event, uid) => {
    if (!recorder) return { ok: false, error: '录制模块未就绪' }
    return recorder.stop(uid)
  })

  ipcMain.handle('rec:split', async (event, uid) => {
    if (!recorder) return { ok: false, error: '录制模块未就绪' }
    return recorder.split(uid)
  })

  ipcMain.handle('rec:stop-all', () => {
    if (!recorder) return { ok: false, error: '录制模块未就绪' }
    return recorder.stopAll()
  })

  ipcMain.handle('rec:ping', () => {
    if (!recorder) return { ok: false, error: '录制模块未就绪' }
    return { ok: true, ffmpeg: recorder.ready, outDir: recorder.outDir, recording: recorder.actives.size > 0 }
  })

  ipcMain.handle('rec:mode', (event, webContentsId) => {
    if (!recorder) return { mode: 'screen', urlAgeMs: null }
    const info = recorder.streamUrlInfo(webContentsId)
    return { mode: info.url ? 'stream' : 'screen', urlAgeMs: info.ageMs }
  })

  // 虎牙：渲染层来要一次直录地址（主进程调 mp.huya.com 接口，按网页客户端身份改写参数），
  // 同时塞进 streamUrls 给录制模块用。渲染层每隔 60 秒调一次来续期（anti-code 约 2 分钟有效）
  ipcMain.handle('huya:streams', async (event, url, webContentsId, roomIdHint) => {
    const res = await huyaStreamCandidates(url, roomIdHint)
    const wcId = Number(webContentsId)
    if (res.ok && Array.isArray(res.urls) && res.urls.length && Number.isInteger(wcId) && wcId > 0) {
      const key = String(wcId)
      const rec = streamUrls.get(key) || { candidates: [] }
      const now = Date.now()
      const fresh = res.urls.map((u) => ({ ...u, ts: now }))
      const freshUrls = new Set(fresh.map((u) => u.url))
      rec.candidates = [...fresh, ...(rec.candidates || []).filter((c) => c && c.url && !freshUrls.has(c.url))].slice(0, 14)
      rec.referer = 'https://www.huya.com/'
      streamUrls.set(key, rec)
      log('huya stream urls', { roomId: res.roomId, anchor: res.anchor, lines: fresh.map((u) => u.line).join(',') })
    }
    return res
  })

  // 渲染层报上来的直录流地址（虎牙这类"地址在页面里签名"的站点用；抖音靠 webRequest 嗅探）
  // 支持一次报多条线路：urls=[{url, kind, line}] —— 有的线路会 403，录制时按顺序换线
  ipcMain.handle('stream:report', (event, webContentsId, info) => {
    const id = Number(webContentsId)
    if (!Number.isInteger(id) || id <= 0) return false
    const incoming = Array.isArray(info && info.urls)
      ? info.urls
      : info && typeof info.url === 'string'
        ? [{ url: info.url, kind: info.kind }]
        : []
    const clean = incoming
      .filter((u) => u && typeof u.url === 'string' && /^https?:\/\//i.test(u.url))
      .map((u) => ({
        url: u.url,
        kind: u.kind || (/\.flv(\?|$)/i.test(u.url) ? 'flv' : /\.m3u8(\?|$)/i.test(u.url) ? 'hls-playlist' : 'hls-other'),
        line: u.line || ''
      }))
    if (!clean.length) return false
    const key = String(id)
    const rec = streamUrls.get(key) || { candidates: [] }
    const now = Date.now()
    const urls = new Set(clean.map((u) => u.url))
    rec.candidates = [
      ...clean.map((u) => ({ ...u, ts: now })),
      ...(rec.candidates || []).filter((c) => c && c.url && !urls.has(c.url))
    ].slice(0, 12)
    if (info && typeof info.referer === 'string' && info.referer) rec.referer = info.referer
    streamUrls.set(key, rec)
    return true
  })

  // 录制选项（目录在 rec:choose-out-dir 里改；这里管分段 / 合并 / 保护 / 水印）
  ipcMain.handle('rec:get-options', () => (recorder ? recorder.getOptions() : { ok: false }))
  ipcMain.handle('rec:set-options', (event, opts) => {
    if (!recorder) return { ok: false, error: '录制模块未就绪' }
    const next = recorder.setOptions(opts || {})
    state.recSegmentMs = next.segmentMs
    state.recKeepParts = next.keepParts
    state.recMaxDurationMs = next.maxDurationMs
    state.recMinFreeMb = next.minFreeMb
    state.recWatermark = next.watermark
    persist()
    return { ok: true, ...next }
  })

  // 录制文件：列表 + 手动合并 + 加水印（剪辑页签用）
  ipcMain.handle('rec:list', (event, dir) => {
    if (!recorder) return { ok: false, files: [] }
    return recorder.listRecordings(dir || state.editDir || recorder.outDir)
  })
  ipcMain.handle('rec:merge', async (event, payload) => {
    if (!recorder) return { ok: false, error: '录制模块未就绪' }
    return recorder.mergeRecordings(payload || {})
  })
  ipcMain.handle('rec:apply-watermark', async (event, payload) => {
    if (!recorder) return { ok: false, error: '录制模块未就绪' }
    return recorder.applyWatermark(payload || {})
  })
  ipcMain.handle('rec:choose-dir', async (event, current) => {
    const res = await dialog.showOpenDialog(win, {
      title: '选择要浏览 / 剪辑的目录',
      defaultPath: current || state.editDir || (recorder && recorder.outDir) || '',
      properties: ['openDirectory']
    })
    if (res.canceled || !res.filePaths.length) return { ok: false }
    state.editDir = res.filePaths[0]
    persist()
    return { ok: true, dir: state.editDir }
  })
  ipcMain.handle('rec:list-fonts', () => (recorder ? recorder.listFonts() : { ok: false, fonts: [] }))
  ipcMain.handle('rec:pick-font', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: '选择水印字体文件',
      defaultPath: 'C:\\\\Windows\\\\Fonts',
      properties: ['openFile'],
      filters: [{ name: '字体', extensions: ['ttf', 'ttc', 'otf'] }]
    })
    if (res.canceled || !res.filePaths.length) return { ok: false }
    return { ok: true, path: res.filePaths[0] }
  })

  ipcMain.handle('rec:pick-image', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: '选择水印图片（PNG 支持透明）',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }]
    })
    if (res.canceled || !res.filePaths.length) return { ok: false }
    return { ok: true, path: res.filePaths[0] }
  })
  ipcMain.handle('rec:reveal', async (event, filePath) => {
    try {
      if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath)
      else if (recorder) shell.openPath(state.editDir || recorder.outDir)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err && err.message }
    }
  })

  ipcMain.handle('win:toggle-fullscreen', () => {
    if (!win || win.isDestroyed()) return false
    win.setFullScreen(!win.isFullScreen())
    return win.isFullScreen()
  })

  ipcMain.handle('win:is-fullscreen', () => Boolean(win && !win.isDestroyed() && win.isFullScreen()))

  ipcMain.handle('rec:out-dir', () => (recorder ? recorder.outDir : ''))

  ipcMain.handle('rec:choose-out-dir', async () => {
    if (!recorder) return { ok: false, error: '录制模块未就绪' }
    const res = await dialog.showOpenDialog(win, {
      title: '选择录制保存目录',
      defaultPath: recorder.outDir,
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true }
    const dir = recorder.setOutDir(res.filePaths[0])
    state.recOutDir = dir
    // 录制目录就一个参数：分段、成片、剪辑页签看的都是它，所以这里顺手把剪辑页签的独立目录清掉
    state.editDir = ''
    persist(true)
    return { ok: true, dir }
  })
}

/* --------------------------- 调试自检（PR_LOG 时） --------------------------- */
function selfCheckSource() {
  const grid = document.getElementById('grid')
  const cs = getComputedStyle(grid)
  const tiles = [...document.querySelectorAll('.tile')]
  return {
    tiles: tiles.length,
    count: document.getElementById('count').textContent,
    cols: cs.gridTemplateColumns,
    rows: cs.gridTemplateRows,
    rects: tiles.map((t) => {
      const r = t.getBoundingClientRect()
      return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
    }),
    titles: tiles.map((t) => t.querySelector('.title').textContent),
    muted: [...document.querySelectorAll('webview')].map((w) => {
      try {
        return w.isAudioMuted()
      } catch (err) {
        return `err:${err.message}`
      }
    }),
    overlays: tiles.map((t) => !t.querySelector('.overlay').classList.contains('hidden')),
    otherBadges: [...document.querySelectorAll('.tile.other')].length,
    monitor: {
      view: document.querySelector('#view-monitor').classList.contains('hidden') ? 'watch' : 'monitor',
      cards: [...document.querySelectorAll('.card')].map((c) => ({
        status: (String(c.className).match(/status-(\w+)/) || [])[1] || '?',
        name: (c.querySelector('.card-name') || {}).textContent || ''
      }))
    },
    danmu: [...document.querySelectorAll('.danmu-panel')].map((el) => ({
      hidden: el.classList.contains('hidden'),
      len: (el.textContent || '').length,
      sample: (el.textContent || '').replace(/\s+/g, ' ').slice(0, 50)
    })),
    badges: [...document.querySelectorAll('.tile .badge')].map((b) => !b.classList.contains('hidden'))
  }
}

function scheduleSelfCheck() {
  win.webContents.on('did-finish-load', () => {
    setTimeout(async () => {
      const readShell = async (round) => {
        try {
          const info = await win.webContents.executeJavaScript(`(${selfCheckSource.toString()})()`, true)
          log(`self-check #${round}`, info)
        } catch (err) {
          log(`self-check #${round} failed`, err && err.message)
        }
      }
      await readShell(1)
      setTimeout(() => readShell(2), 20000)
      setTimeout(() => readShell(3), 40000)

      // 连续采样，确认多个房间是「持续在播」而不是启动瞬间在播
      let round = 0
      const sampleGuests = async () => {
        round += 1
        for (const guest of debugGuests) {
          try {
            const probe = await guest.executeJavaScript(
              `(() => {
                const v = document.querySelector('video')
                return {
                  title: document.title,
                  hasVideo: !!v,
                  readyState: v ? v.readyState : -1,
                  paused: v ? v.paused : null,
                  t: v ? Math.round(v.currentTime * 10) / 10 : null,
                  size: v ? v.videoWidth + 'x' + v.videoHeight : null,
                  muted: v ? v.muted : null
                }
              })()`,
              true
            )
            log(`guest sample #${round}`, guest.id, probe)
          } catch (err) {
            log(`guest sample #${round} failed`, guest.id, err && err.message)
          }
        }
        if (round < 3) setTimeout(sampleGuests, 15000)
      }
      sampleGuests()
    }, 3500)
  })
}

/* --------------------- 调试页：快照 + 落盘 --------------------- */

function readGuardLogTail(maxLines = 20) {
  try {
    const p = guestLogPath()
    if (!p || !fs.existsSync(p)) return []
    const raw = fs.readFileSync(p, 'utf8').trim()
    if (!raw) return []
    return raw.split(/\r?\n/).slice(-maxLines)
  } catch {
    return []
  }
}

/** 某个 webContents 是干什么的：主窗口 / 观看瓦片 / 监控探测窗 / 录制窗 / 弹窗 */
function contentRole(wc, mainId) {
  let id = -1
  let type = ''
  let url = ''
  try {
    id = wc.id
  } catch {}
  if (mainId && id === mainId) return 'main'
  try {
    type = wc.getType()
  } catch {}
  if (type === 'webview') return 'tile'
  try {
    url = String(wc.getURL() || '')
  } catch {}
  if (/\/src\/recorder\/recorder\.html/i.test(url)) return 'recorder'
  // 探测窗用的是独立 partition（persist:probe），按 session 身份认最准
  try {
    if (wc.session === session.fromPartition('persist:probe')) return 'probe'
  } catch {}
  if (/live\.douyin\.com\/follow/i.test(url)) return 'probe-follow'
  if (type === 'window') return 'aux'
  return type || 'other'
}

/** 调试页要的一整份快照：页面、进程、流地址、卫兵状态、生命周期 */
function debugSnapshot() {
  let mainId = -1
  try {
    mainId = win && !win.isDestroyed() ? win.webContents.id : -1
  } catch {}
  const contents = []
  try {
    for (const wc of webContents.getAllWebContents()) {
      const row = {
        id: -1,
        type: '?',
        role: 'other',
        url: '',
        title: '',
        destroyed: true,
        audible: false,
        muted: false,
        loading: false,
        visible: null
      }
      try {
        row.id = wc.id
      } catch {}
      try {
        row.type = wc.getType()
      } catch {}
      try {
        row.destroyed = wc.isDestroyed()
      } catch {}
      if (!row.destroyed) {
        try {
          row.role = contentRole(wc, mainId)
        } catch {}
        try {
          row.url = String(wc.getURL() || '').slice(0, 140)
        } catch {}
        try {
          row.title = String(wc.getTitle() || '').slice(0, 60)
        } catch {}
        try {
          row.audible = wc.isCurrentlyAudible()
        } catch {}
        try {
          row.muted = wc.isAudioMuted()
        } catch {}
        try {
          row.loading = wc.isLoading()
        } catch {}
        // 窗口是否可见：探测/录制窗口是 show:false 的，靠这个把它们标出来
        try {
          const bw = BrowserWindow.fromWebContents(wc)
          row.visible = bw ? bw.isVisible() : null
        } catch {
          row.visible = null
        }
      }
      contents.push(row)
    }
  } catch {}

  let processes = []
  try {
    processes = app.getAppMetrics().map((m) => ({
      pid: m.pid,
      type: m.type,
      cpu: Math.round(((m.cpu && m.cpu.percentCPUUsage) || 0) * 10) / 10,
      memMb: Math.round((((m.memory && m.memory.workingSetSize) || 0) / 1024) * 10) / 10
    }))
  } catch {}

  const streams = []
  try {
    for (const [id, rec] of streamUrls) {
      const cands = (rec && rec.candidates) || []
      const best = cands.find((c) => c.kind === 'flv') || cands[0]
      if (!best) continue
      streams.push({
        webContentsId: Number(id),
        kind: best.kind,
        ageSec: Math.round((Date.now() - best.ts) / 1000),
        candidates: cands.length,
        url: String(best.url || '').slice(0, 120)
      })
    }
  } catch {}

  return {
    at: Date.now(),
    main: {
      pid: process.pid,
      startedAt: APP_STARTED_AT,
      userData: (() => {
        try {
          return app.getPath('userData')
        } catch {
          return ''
        }
      })(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      singleInstance: true
    },
    watch: {
      tileGuests: [...tileGuestIds],
      orphans: [...orphanSeenAt.keys()],
      guardLog: readGuardLogTail(20)
    },
    contents,
    lifecycle: guestLifecycle
      .slice()
      .reverse()
      .map((r) => {
        let role = r.role || ''
        if (mainId > 0 && r.id === mainId) role = 'main'
        if (!role) {
          try {
            const wc = webContents.fromId(r.id)
            role = wc && !wc.isDestroyed() ? contentRole(wc, mainId) : r.type === 'webview' ? 'tile' : 'other'
          } catch {
            role = r.type === 'webview' ? 'tile' : 'other'
          }
        }
        return {
          id: r.id,
          type: r.type,
          role,
          title: String(r.title || '').slice(0, 60),
          url: String(r.url || '').slice(0, 120),
          created: r.created,
          destroyed: r.destroyed,
          aliveMs: Math.max(0, (r.destroyed || Date.now()) - r.created)
        }
      }),
    processes,
    streams,
    mainWebContentsId: mainId
  }
}

function saveDebugSnapshot(payload) {
  try {
    const dir = app.getPath('userData')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const target = path.join(dir, `debug-snapshot-${stamp}.json`)
    fs.writeFileSync(target, JSON.stringify(payload || debugSnapshot(), null, 2))
    return { ok: true, path: target }
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) }
  }
}

/* ------------------- 诊断：账号是否被"别处已进入"拦住 ------------------- */

function scheduleDiag() {
  const ses = session.fromPartition(PARTITION)
  let budget = 400

  ses.webRequest.onCompleted({ urls: ['*://*.douyin.com/*'] }, (details) => {
    if (budget <= 0) return
    const url = details.url || ''
    if (!/webcast|live/i.test(url)) return
    // 只关心进房/离房/心跳类接口，以及异常状态码
    const interesting =
      details.statusCode >= 400 ||
      /enter|leave|room|heartbeat|im\/|push/i.test(url)
    if (!interesting) return
    budget -= 1
    log('net', details.statusCode, details.method, details.resourceType, url.slice(0, 240))
  })

  const probe = `(() => {
    const text = (document.body && document.body.innerText) || ''
    const m = text.match(/[^\\n]{0,24}(其他地方|已在其他|其他直播间|其他设备)[^\\n]{0,40}/)
    const vids = [...document.querySelectorAll('video')].map((v, i) => {
      const r = v.getBoundingClientRect()
      const cs = getComputedStyle(v)
      return {
        i,
        paused: v.paused,
        t: Math.round(v.currentTime * 10) / 10,
        rs: v.readyState,
        w: v.videoWidth,
        h: v.videoHeight,
        area: Math.round(r.width * r.height),
        shown: cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05
      }
    })
    const topRaw = (() => {
      const v = document.querySelector('video')
      if (!v) return null
      const r = v.getBoundingClientRect()
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      if (!top) return null
      return {
        tag: top.tagName,
        cls: String(top.className || '').slice(0, 60),
        isVideoOrAncestor: top === v || top.contains(v),
        src: top.tagName === 'IMG' ? String(top.src || '').slice(0, 100) : null
      }
    })()
    return {
      title: document.title,
      hit: m ? m[0].replace(/\\s+/g, ' ').trim() : null,
      videos: vids,
      topEl: topRaw,
      logoutHint: /立即登录|登录抖音|扫码登录/.test(text)
    }
  })()`

  // 画质：当前分辨率 + 清晰度菜单入口
  const qualityProbe = `(() => {
    const v = document.querySelector('video')
    const labels = ['原画', '蓝光', '超清', '高清', '标清', '流畅', '自动']
    const items = []
    for (const el of document.querySelectorAll('div,span,button,li,p,a')) {
      const t = (el.textContent || '').trim()
      if (t.length > 8) continue
      if (!labels.some((l) => t === l || t === l + ' ') ) continue
      if (el.children.length > 2) continue
      const cs = getComputedStyle(el)
      items.push({ text: t, tag: el.tagName, cls: String(el.className || '').slice(0, 40), display: cs.display, vis: cs.visibility, revealed: !!el.dataset.prPure })
    }
    // 当前被选中/高亮的档位
    const active = [...document.querySelectorAll('[class*="active"],[class*="selected"],[class*="cur"]')]
      .map((e) => (e.textContent || '').trim())
      .filter((t) => t && t.length <= 8 && labels.some((l) => t.includes(l)))
    return {
      size: v ? v.videoWidth + 'x' + v.videoHeight : null,
      qualityItems: items.slice(0, 12),
      activeHints: [...new Set(active)].slice(0, 6)
    }
  })()`
  const uiProbe = `(() => {
    const text = (document.body && document.body.innerText) || ''
    const chatInput = document.querySelector(
      '[contenteditable="true"], input[placeholder*="说"], textarea[placeholder*="说"], input[placeholder*="聊"]'
    )
    const giftHints = /礼物|送个|小心心|粉丝团/.test(text)
    // 找最像弹幕列表的容器：绝对定位、子节点多、文本短
    let bestEl = null
    let bestScore = -1
    for (const el of document.querySelectorAll('div,ul,ol')) {
      const n = el.children.length
      if (n < 4 || n > 400) continue
      const cs = getComputedStyle(el)
      if (cs.position !== 'absolute' && cs.position !== 'fixed') continue
      const r = el.getBoundingClientRect()
      if (r.width < 80 || r.height < 80) continue
      const shortKids = [...el.children].filter((c) => (c.innerText || '').length > 0 && (c.innerText || '').length < 160).length
      if (shortKids < 3) continue
      if (shortKids > bestScore) {
        bestScore = shortKids
        bestEl = el
      }
    }
    let chatList = null
    if (bestEl) {
      const cs = getComputedStyle(bestEl)
      const r = bestEl.getBoundingClientRect()
      chatList = {
        rows: bestScore,
        w: Math.round(r.width),
        h: Math.round(r.height),
        left: Math.round(r.left),
        top: Math.round(r.top),
        inView: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1,
        visibility: cs.visibility,
        display: cs.display,
        hiddenByUs: bestEl.dataset.prRevealed === '1',
        sample: (bestEl.innerText || '').replace(/\\s+/g, ' ').slice(0, 60)
      }
    }
    // 不依赖抖音侧栏布局，直接从整页文本里数"昵称：内容"这种弹幕行
    const lines = text.split('\\n').map((s) => s.trim()).filter(Boolean)
    const danmuLines = lines.filter((s) => s.length > 3 && s.length < 140 && /^.{1,18}[:：]\\s*\\S/.test(s))
    const danmuEls = document.querySelectorAll('[class*="danmu"],[class*="comment"],[class*="chat"],[class*="Chat"]').length
    return {
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      bodyTextLen: (text || '').length,
      centerIsVideo: (() => {
        const v = document.querySelector('video')
        if (!v) return false
        const r = v.getBoundingClientRect()
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return !!top && (top === v || top.contains(v) || v.contains(top))
      })(),
      hasChatInput: !!chatInput,
      giftHints,
      chatList,
      danmuCount: danmuLines.length,
      danmuSample: danmuLines.slice(-4),
      danmuEls,
      hasOtherRoom: text.includes('账号已在其他地方进入直播间')
    }
  })()`
  const removeCoverProbe = `(() => {
    const v = document.querySelector('video')
    if (!v) return { ok: false, reason: 'no-video' }
    const r = v.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    const results = []
    for (const dy of [-0.3, 0, 0.3]) {
      const top = document.elementFromPoint(cx, cy + r.height * dy)
      if (!top) continue
      const isVideo = top === v || top.contains(v) || v.contains(top)
      if (!isVideo) {
        results.push({ tag: top.tagName, cls: String(top.className || '').slice(0, 60) })
        try { top.style.display = 'none' } catch (e) {}
      }
    }
    return { ok: true, hidden: results }
  })()`

  // 两帧像素比对：画面到底动没动，不看 paused 字段
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))
  async function frameDiff(guest) {
    try {
      const a = await guest.capturePage()
      const bufA = a.toBitmap()
      const sizeA = a.getSize()
      await sleepMs(900)
      const b = await guest.capturePage()
      const bufB = b.toBitmap()
      const sizeB = b.getSize()
      if (!bufA.length || bufA.length !== bufB.length || sizeA.width !== sizeB.width) {
        return { ok: false, note: 'size-mismatch', lenA: bufA.length, lenB: bufB.length }
      }
      let changed = 0
      let total = 0
      for (let i = 0; i < bufA.length; i += 4) {
        const d =
          Math.abs(bufA[i] - bufB[i]) +
          Math.abs(bufA[i + 1] - bufB[i + 1]) +
          Math.abs(bufA[i + 2] - bufB[i + 2])
        if (d > 24) changed += 1
        total += 1
      }
      return { ok: true, size: `${sizeA.width}x${sizeA.height}`, changedPct: Math.round((changed / total) * 1000) / 10 }
    } catch (err) {
      return { ok: false, note: err && err.message }
    }
  }

  const run = async (round, script = probe, tag = 'diag') => {
    for (const guest of debugGuests) {
      try {
        const r = await guest.executeJavaScript(script, true)
        log(`${tag} #${round}`, guest.id, r)
      } catch (err) {
        log(`${tag} #${round} failed`, guest.id, err && err.message)
      }
      const diff = await frameDiff(guest)
      log(`frames #${round}`, guest.id, diff)
    }
  }

  // 尝试把清晰度切到指定档位：直接点菜单项（React 事件靠冒泡触发）
  const setQualityProbe = (label) => `(() => {
    const v = document.querySelector('video')
    const before = v ? v.videoWidth + 'x' + v.videoHeight : null
    const want = ${JSON.stringify(label)}
    const cands = [...document.querySelectorAll('div,span,button,li,p,a')].filter(
      (e) => (e.textContent || '').trim() === want && e.children.length <= 2
    )
    let clicked = 0
    for (const el of cands) {
      try {
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
        el.click()
        clicked += 1
      } catch (e) {}
    }
    return { want, before, candidates: cands.length, clicked }
  })()`

  const setZoomAll = (z) => {
    for (const g of debugGuests) {
      try {
        g.setZoomFactor(z)
      } catch {}
    }
  }

  setTimeout(() => run(1), 12000)
  setTimeout(() => run(2), 26000)
  setTimeout(() => run(3, qualityProbe, 'quality-before'), 32000)
  setTimeout(() => run(4, setQualityProbe('原画'), 'set-原画'), 44000)
  setTimeout(() => run(5, qualityProbe, 'quality-after'), 58000)
  // 缩到"整页塞进瓦片"的倍率，看弹幕侧栏会不会进入视野
  setTimeout(() => {
    setZoomAll(0.55)
    setTimeout(() => run(4, uiProbe, 'ui@0.55'), 3000)
  }, 52000)
}

/* -------------------------------- 启动 -------------------------------- */

/** 关窗口时"先收尾再关"的闸门（避免重复进来） */
let closingAfterFinalize = false

if (!app.requestSingleInstanceLock()) {
  log('single instance lock failed -> quit')
  app.quit()
} else {
  hookLifecycle()
  app.on('second-instance', () => {
    log('second instance detected')
    // 已有实例没有窗口（比如正在收尾合并分段）时，原地把窗口重建出来，
    // 否则第二次 start.bat 就变成"什么都没发生"。
    if (!win || win.isDestroyed()) {
      log('second instance: no window -> recreate')
      try {
        createMainWindow()
      } catch (err) {
        log('second instance: create window failed', err && err.message)
      }
    }
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    log('app ready')
    statePath = path.join(app.getPath('userData'), 'state.json')
    log('statePath', statePath)
    loadState()
    registerIpc()
    installStreamSniffer()

    if (process.env.PR_LOG) {
      const cases = [
        'https://example.com/ad',
        'https://www.douyin.com/search/bitbrowser',
        'https://www.douyin.com/search/bitbrowser',
        'https://live.douyin.com/123456',
        'javascript:alert(1)',
        'https://s.click.evil.com/go'
      ]
      for (const c of cases) log('aux guard', c, shouldOpenAux(c))
    }

    // IPC 必须在窗口加载页面前注册好，否则渲染层首次 loadWatchers 会拿到“无处理器”
    watcherStore = new (require('./watchers').WatcherStore)({
      log: (...a) => log('[watchers]', ...a),
      getWindow: () => win,
      initial: { watchers: state.watchers, interval: state.probeInterval, blockedUntil: state.probeBlockedUntil, cooldownMs: state.probeCooldown },
      onPersist: () => persist(),
      followPartition: PARTITION,
      blockMediaFor: (id) => mediaBlockIds.add(id)
    })
    watcherStore.registerIpc()

    createMainWindow()
    log('bootstrap done', { isolate: ISOLATE })
    startGuestGuard()

    recorder = new (require('./recorder').RecorderManager)({
      log: (...a) => log('[rec]', ...a),
      getMainWindow: () => win,
      onState: (s) => log('[rec] state', JSON.stringify(s)),
      streamUrls,
      outDir: state.recOutDir || undefined,
      // 分段时长 / 录完是否自动合并 / 保护参数 / 水印（上次的选择要保留）
      segmentMs: state.recSegmentMs,
      keepParts: state.recKeepParts,
      maxDurationMs: state.recMaxDurationMs,
      minFreeMb: state.recMinFreeMb,
      watermark: state.recWatermark,
      // 录制事件日志常开（写在 userData 下），下次断录可以直接回溯原因
      logFile: path.join(app.getPath('userData'), 'rec.log')
    })
    log('recorder ready', { ffmpeg: recorder.ready, outDir: recorder.outDir })
    // 上次没保存完的录制（被强杀 / 断流）在这里补成 mp4，别让它躺在临时目录里
    setTimeout(() => {
      if (!recorder) return
      Promise.resolve(recorder.recoverOrphans())
        .then((r) => {
          if (r && (r.recovered || (r.failed && r.failed.length))) log('recoverOrphans', JSON.stringify(r))
        })
        .catch((err) => log('recoverOrphans failed', err && err.message))
    }, 3000)

    watcherStore.startCycle()
    startTileSampler()
    // 启动后稍等一下再跑第一轮，别和界面初始化抢资源
    setTimeout(() => {
      watcherStore && watcherStore.cycle().catch((e) => log('first cycle failed', e && e.message))
    }, 12000)

    if (ISOLATE) startCookieSync()
    if (process.env.PR_LOG) scheduleSelfCheck()
    if (process.env.PR_DIAG) scheduleDiag()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  }).catch((err) => log('whenReady failed', err && (err.stack || err.message)))

  let quitting = false
  app.on('before-quit', (event) => {
    log('before-quit')
    if (quitting) return
    quitting = true
    persist(true)
    if (watcherStore) watcherStore.dispose()
    if (!recorder) return

    // 收尾要等 ffmpeg 正常关闭（有录制时才等），否则正在录的内容会丢在临时目录里
    if (recorder.actives.size) {
      event.preventDefault()
      log('before-quit: finalize recordings', recorder.actives.size)
      // 兜底：收尾要是卡住（ffmpeg 不响应 / 合并卡死），进程会一直占着单实例锁，
      // 导致下次 start.bat "启动不了"。3 分钟后无条件退出。
      const bail = setTimeout(() => {
        log('before-quit: finalize timed out -> exit')
        app.exit(0)
      }, 3 * 60 * 1000)
      if (bail.unref) bail.unref()
      Promise.resolve(recorder.dispose())
        .catch((err) => log('recorder dispose failed', err && err.message))
        .finally(() => {
          clearTimeout(bail)
          app.quit()
        })
      return
    }
    Promise.resolve(recorder.dispose()).catch(() => {})
  })

  app.on('window-all-closed', () => {
    log('window-all-closed -> quit')
    app.quit()
  })
}
