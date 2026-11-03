'use strict'

/**
 * 监控列表：维护直播间地址池、按周期探测是否在播、开播时弹通知。
 *
 * 探测走 ProbeManager（隐藏窗口 + 屏蔽媒体流），这里只负责调度、缓存和推送。
 */

const { ipcMain, net } = require('electron')
const { ProbeManager, FollowProbe } = require('./probe')

const DEFAULT_INTERVAL_MS = 120 * 1000
const MIN_INTERVAL_MS = 60 * 1000
/** 被验证码拦截后的冷却时长（IP 级限流，短时间反复探测只会越来越严） */
const BLOCK_COOLDOWN_MS = 30 * 60 * 1000
const MAX_COOLDOWN_MS = 4 * 60 * 60 * 1000

/**
 * 把用户输入（房间号 / 链接 / 分享文案）整理成可打开的直播地址。
 *
 * 目前认两类站点：
 *  - 抖音：`live.douyin.com/<数字>`、`v.douyin.com` 短链（跟跳转）、纯数字房间号
 *  - 虎牙：`huya.com/<主播名 或 数字房间号>`（例如 https://www.huya.com/mingjie）
 *
 * ⚠️ 之前这里的分支都在"没有 scheme 的候选串"上做匹配，于是：
 *   `https://v.douyin.com/xxx`  → 谁都匹配不上 → 直接"无法识别的地址"（短链解析分支根本走不到）
 * 现在先剥掉 scheme 再匹配，并且**只认直播相关的形态**。
 */
function parseRoomInput(raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  const explicit = s.match(/https?:\/\/[^\s"'<>，,、]+/i)
  const candidate = (explicit ? explicit[0] : s).replace(/^\/+/, '').replace(/^https?:\/\//i, '')

  // 1) 纯房间号（抖音）
  if (/^\d{5,}$/.test(candidate)) {
    return { roomId: candidate, url: `https://live.douyin.com/${candidate}`, site: 'douyin' }
  }

  // 2) 虎牙：huya.com/<主页名 或 数字房间号>
  const huya = candidate.match(/(?:^|\/\/)(?:www\.)?huya\.com\/([A-Za-z0-9_-]+)/i)
  if (huya) {
    const key = huya[1]
    return { roomId: key, url: `https://www.huya.com/${key}`, site: 'huya' }
  }

  // 3) live.douyin.com/<id>（带不带 query、末尾斜杠都行）
  const live = candidate.match(/live\.douyin\.com\/(\d{5,})/i)
  if (live) return { roomId: live[1], url: `https://live.douyin.com/${live[1]}`, site: 'douyin' }

  // 4) 分享短链：交给上层 resolveShortLink 跟跳转
  const short = candidate.match(/(?:^|\/\/)v\.douyin\.com\/[^\s"'<>，,、]+/i)
  if (short) {
    const hit = short[0].replace(/^\/\//, '')
    return { roomId: '', url: `https://${hit}` }
  }

  // 5) 兜底：文案里只带了一串数字
  const digits = candidate.match(/(?:^|\D)(\d{6,})(?:\D|$)/)
  if (digits) return { roomId: digits[1], url: `https://live.douyin.com/${digits[1]}`, site: 'douyin' }
  return null
}

/** 分享短链（v.douyin.com）需要跟一次跳转才知道真实地址 */
async function resolveShortLink(url) {
  try {
    const res = await net.fetch(url, { redirect: 'manual', method: 'GET' })
    const loc = res.headers.get('location') || ''
    if (!loc) return null
    const abs = new URL(loc, url).toString()
    return abs
  } catch {
    return null
  }
}

/**
 * 解析 + 短链跟跳转。两个"添加"入口（观看页 / 监控页）都走这里，避免两边行为不一样。
 * @returns {Promise<{ok:true, url:string, roomId:string, site:string} | {ok:false, error:string}>}
 */
async function resolveRoomInput(raw) {
  const parsed = parseRoomInput(raw)
  if (!parsed) {
    return { ok: false, error: '无法识别的地址（要抖音直播间号 / live.douyin.com 链接 / 分享短链，或 www.huya.com/<主播名>）' }
  }
  let url = parsed.url
  let roomId = parsed.roomId
  let site = parsed.site || 'douyin'
  if (/^https?:\/\/v\.douyin\.com\//i.test(url)) {
    const resolved = await resolveShortLink(url)
    if (!resolved) return { ok: false, error: '短链解析失败' }
    if (!/live\.douyin\.com/.test(resolved)) {
      return { ok: false, error: '这个短链不是直播间（可能是视频或主页）' }
    }
    url = resolved
    roomId = (resolved.match(/live\.douyin\.com\/(\d{5,})/) || [])[1] || ''
    site = 'douyin'
  }
  return { ok: true, url, roomId, site }
}

class WatcherStore {
  /**
   * @param {{
   *   log?: (...a:any[])=>void,
   *   getWindow?: ()=>any,
   *   initial?: {watchers?: any[], interval?: number},
   *   onPersist?: ()=>{}
   * }} opts
   */
  constructor(opts = {}) {
    this.log = opts.log || (() => {})
    this.getWindow = opts.getWindow || (() => null)
    this.onPersist = opts.onPersist || (() => {})
    this.list = Array.isArray(opts.initial && opts.initial.watchers) ? opts.initial.watchers : []
    this.intervalMs = Math.max(MIN_INTERVAL_MS, Number(opts.initial && opts.initial.interval) || DEFAULT_INTERVAL_MS)
    this.timer = null
    this.cycling = false
    // 验证码冷却：被拦住后停一阵，连续被拦则指数退避（30min → 1h → 2h → 4h 封顶）
    this.blockedUntil = Number(opts.initial && opts.initial.blockedUntil) > 0 ? Number(opts.initial.blockedUntil) : 0
    this.cooldownMs = Math.max(BLOCK_COOLDOWN_MS, Number(opts.initial && opts.initial.cooldownMs) || BLOCK_COOLDOWN_MS)
    this.seq = this.list.reduce((n, w) => Math.max(n, Number(w.id) || 0), 0)
    this.prober = new ProbeManager({ log: this.log })
    // 关注列表探测（走已登录 session，一次加载拿到"关注的人里谁在播"）
    this.followProbe = new FollowProbe({
      log: this.log,
      partition: opts.followPartition || 'persist:douyin',
      blockMediaFor: opts.blockMediaFor
    })
    this.follow = { at: 0, size: 0, ok: false, needLogin: false, empty: false }
    /** 当前正在探测哪个房间 + 本轮进度（推给界面做高亮和进度条） */
    this.probing = { id: '', total: 0, done: 0, startedAt: 0 }
  }

  snapshot() {
    return {
      watchers: this.list,
      interval: this.intervalMs,
      blockedUntil: this.blockedUntil,
      follow: { ...this.follow },
      probing: { ...this.probing }
    }
  }

  broadcast() {
    const win = this.getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('watchers:changed', this.snapshot())
    }
  }

  persist() {
    this.onPersist()
  }

  registerIpc() {
    ipcMain.handle('watchers:load', () => this.snapshot())

    // 两个"添加"入口（观看页 / 监控页）共用同一个解析器：短链跟跳转、非直播链接一律拒
    ipcMain.handle('room:resolve', async (event, raw) => resolveRoomInput(raw))

    ipcMain.handle('watchers:add', async (event, raw) => {
      const parsed = await resolveRoomInput(raw)
      if (!parsed.ok) return { ok: false, error: parsed.error }
      const { url, roomId } = parsed

      // 归一化后去重：忽略末尾斜杠和 query
      const norm = (u) => String(u || '').split('#')[0].split('?')[0].replace(/\/+$/, '').toLowerCase()
      const key = roomId || norm(url)
      const dup = this.list.find((x) => (x.roomId && String(x.roomId) === String(key)) || norm(x.url) === norm(url))
      if (dup) {
        const label = dup.name || dup.roomId || norm(dup.url)
        return {
          ok: false,
          duplicate: true,
          dupId: dup.id,
          error: `已经在监控列表里了：${label}`
        }
      }

      const w = {
        id: String(++this.seq),
        roomId,
        url,
        name: '',
        title: '',
        cover: '',
        online: '',
        status: 'unknown',
        checkedAt: 0,
        liveSince: 0
      }
      this.list.push(w)
      this.persist()
      this.broadcast()
      // 加进来先探一次，卡片不用一直空着——但冷却期间不要撞验证码
      if (!(this.blockedUntil && Date.now() < this.blockedUntil)) {
        this.probeOne(w).catch(() => {})
      }
      return { ok: true, watcher: w }
    })

    ipcMain.handle('watchers:remove', (event, id) => {
      const before = this.list.length
      this.list = this.list.filter((w) => w.id !== id)
      if (this.list.length !== before) {
        this.persist()
        this.broadcast()
      }
      return true
    })

    ipcMain.handle('watchers:toggle-special', (event, id) => {
      const w = this.list.find((x) => x.id === id)
      if (!w) return { ok: false }
      w.special = !w.special
      this.persist()
      this.broadcast()
      this.log('toggle special', w.roomId || w.url, w.special ? 'on' : 'off')
      return { ok: true, special: w.special }
    })

    ipcMain.handle('watchers:report-status', (event, payload) => {
      const { roomId, url, status } = payload || {}
      return this.reportStatus(roomId || url, status)
    })

    ipcMain.handle('watchers:probe-now', async (event, ids) => {
      // ids === null / undefined 表示"全部"；空数组表示用户没勾选
      if (Array.isArray(ids) && ids.length === 0) {
        return { ok: false, error: '先在卡片上勾选要检测的房间' }
      }

      if (Array.isArray(ids)) {
        const targets = this.list.filter((w) => ids.includes(w.id))
        if (!targets.length) return { ok: false, error: '选中的房间不在列表里' }
        if (this.cycling) {
          // 正在探测中：排队，等这一轮结束再跑，别直接丢掉
          this.pendingIds = ids.slice()
          return { ok: true, count: targets.length, queued: true }
        }
        this.cycle(targets).catch((err) => this.log('probe-now failed', err && err.message))
        return { ok: true, count: targets.length }
      }

      // 全部检测：尊重冷却，不再静默清除
      if (this.blockedUntil && Date.now() < this.blockedUntil) {
        const left = Math.ceil((this.blockedUntil - Date.now()) / 60000)
        return { ok: false, error: `验证码冷却中，还需 ${left} 分钟` }
      }
      this.cycle(this.list.slice()).catch((err) => this.log('probe-now failed', err && err.message))
      return { ok: true, count: this.list.length }
    })

    ipcMain.handle('watchers:set-interval', (event, ms) => {
      const next = Math.max(MIN_INTERVAL_MS, Number(ms) || DEFAULT_INTERVAL_MS)
      this.intervalMs = next
      this.persist()
      this.startCycle()
      this.broadcast()
      return next
    })
  }

  /**
   * 由"实际打开的瓦片"反推监控状态（主进程侧的流字节判据也走这里）。
   * @param {string} roomIdOrUrl
   * @param {'live'|'offline'} status
   */
  reportStatus(roomIdOrUrl, status) {
    if (status !== 'live' && status !== 'offline') return { ok: false, error: 'bad status' }
    const rid = String(roomIdOrUrl || '')
    if (!rid) return { ok: false, error: 'no id' }
    const w = this.list.find((x) => String(x.roomId) === rid || x.url === rid)
    if (!w) return { ok: false, error: 'not in list' }

    if (w.status === status) {
      w.checkedAt = Date.now()
      w.unverified = false
      return { ok: true, unchanged: true }
    }
    const wasLive = w.status === 'live'
    w.status = status
    w.checkedAt = Date.now()
    w.source = 'tile'
    w.blocked = false
    w.unverified = false
    w.liveSince = status === 'live' ? (wasLive ? w.liveSince : Date.now()) : 0
    this.log('status corrected by tile', w.roomId || w.url, status)
    this.broadcast()
    this.persist()
    return { ok: true }
  }

  async probeOne(w) {
    this.probing.id = w.id
    this.probing.startedAt = Date.now()
    this.broadcast()

    const wasLive = w.status === 'live'
    let r
    try {
      r = await this.prober.probe(w.url)
    } catch (err) {
      r = { status: 'error', error: err && err.message }
    } finally {
      this.probing.id = ''
      this.probing.done += 1
    }
    this.broadcast()
    if (!r) return w

    // 被验证码挡住时保留上一次的有效状态，只标记"被拦截"，避免整张列表假阴性
    if (r.status === 'blocked') {
      w.blocked = true
      w.blockedAt = Date.now()
      w.checkedAt = Date.now()
      this.blockedUntil = Date.now() + this.cooldownMs
      const mins = Math.round(this.cooldownMs / 60000)
      this.log(`probe blocked by captcha, cooldown ${mins}min (next backoff ${Math.min(this.cooldownMs * 2, MAX_COOLDOWN_MS) / 60000}min)`)
      this.cooldownMs = Math.min(this.cooldownMs * 2, MAX_COOLDOWN_MS)
      this.broadcast()
      this.persist()
      return w
    }
    // 探成功一次就把退避复位
    w.blocked = false
    this.cooldownMs = BLOCK_COOLDOWN_MS

    // 读不到页面状态时：保留上次判定，但标注"未确认"，绝不凭空改成在播
    if (r.status === 'unknown') {
      w.unverified = true
      w.checkedAt = Date.now()
      this.log('probe unknown (kept last status)', w.roomId || w.url, w.status)
      return w
    }
    w.unverified = false

    w.status = r.status
    w.checkedAt = Date.now()
    if (r.name) w.name = r.name
    if (r.title) w.title = r.title
    if (r.cover) w.cover = r.cover
    w.online = r.online || ''
    w.sample = r.sample || w.sample || ''

    if (r.status === 'live') {
      // 只记录开播时间，状态变化由界面在监控页展示，不弹系统通知
      if (!wasLive) w.liveSince = Date.now()
    } else {
      w.liveSince = 0
    }

    this.log('probe result', w.roomId || w.url, r.status, r.name || '', r.ms ? `${r.ms}ms` : '')
    return w
  }

  /**
   * 轮转深探：每次只探 1 个房间（最久没探过的优先）。
   *
   * 为什么不用「广场轮询」批量拿状态：实测广场精选位 3 轮共 60 个在播房间，
   * 与用户这 32 个房间重合 0；8 个分类页也只返回同样的 15 个推荐房间，同样重合 0。
   * 也就是说对这些具体主播，广场覆盖率为 0，只能逐个探。
   *
   * 逐个探就得控量：以前是每轮 32 个（≈192 次/小时），直接把 IP 探进了验证码；
   * 现在改成每 intervalMs 探 1 个（默认 120 秒 ≈ 30 次/小时）。
   */
  /**
   * 挑选本轮要探的房间：
   *  - 优先「特别关注」，按最久没探过的顺序轮转（保证你最关心的最快刷新）
   *  - 每 3 轮抽 1 轮去探一个非特别关注的老房间，避免其余房间状态彻底过期
   */
  pickNext() {
    if (!this.list.length) return null
    this.tickCount = (this.tickCount || 0) + 1

    const specials = this.list.filter((w) => w.special)
    const others = this.list.filter((w) => !w.special)
    const oldest = (arr) =>
      arr.reduce((best, w) => (!best || (w.checkedAt || 0) < (best.checkedAt || 0) ? w : best), null)

    if (specials.length && (this.tickCount % 3 !== 0 || !others.length)) {
      return oldest(specials)
    }
    if (others.length) return oldest(others)
    return oldest(specials)
  }

  /** 用关注列表批量刷新状态：榜上有名 = 在播；连续两轮不在 = 已下播 */
  applyFollow(ids) {
    const set = new Set(ids.map(String))
    this.follow.at = Date.now()
    this.follow.size = set.size
    this.follow.ok = true
    this.follow.needLogin = false

    let liveCount = 0
    for (const w of this.list) {
      if (!w.roomId) continue
      if (set.has(String(w.roomId))) {
        const wasLive = w.status === 'live'
        w.status = 'live'
        w.source = 'follow'
        w.checkedAt = Date.now()
        w.squareMiss = 0
        w.blocked = false
        if (!wasLive) w.liveSince = Date.now()
        liveCount += 1
      } else {
        w.squareMiss = (w.squareMiss || 0) + 1
        if (w.status === 'live' && w.squareMiss >= 2) w.status = 'offline'
      }
    }
    this.log('follow applied', { live: liveCount, followSize: set.size, total: this.list.length })
  }

  async tick() {
    if (this.cycling) return
    if (this.blockedUntil && Date.now() < this.blockedUntil) {
      this.log('tick skipped: captcha cooldown')
      return
    }
    const w = this.pickNext()
    if (!w) return

    this.probing.total = 1
    this.probing.done = 0
    this.cycling = true
    try {
      await this.probeOne(w)
      this.broadcast()
      this.persist()
    } finally {
      this.cycling = false
      this.probing.total = 0
      this.probing.done = 0
      this.broadcast()
      this.runPending()
    }
  }

  /** 探测中点了「检测选中」时排队的那批，等当前这一轮结束再跑 */
  runPending() {
    if (!this.pendingIds || !this.pendingIds.length) return
    const ids = this.pendingIds
    this.pendingIds = null
    const targets = this.list.filter((w) => ids.includes(w.id))
    if (!targets.length) return
    setTimeout(() => {
      this.log('running queued probe', targets.length)
      this.cycle(targets).catch((err) => this.log('queued cycle failed', err && err.message))
    }, 800)
  }

  async cycle(targets) {
    if (this.cycling) return
    if (!targets && this.blockedUntil && Date.now() < this.blockedUntil) {
      this.log('cycle skipped: captcha cooldown')
      return
    }

    if (targets) {
      // 手动触发：只探选中的那些，探完一个歇 1.5 秒，减少突发特征
      this.probing.total = targets.length
      this.probing.done = 0
      this.cycling = true
      try {
        for (const w of targets) {
          if (!this.list.includes(w)) continue
          await this.probeOne(w)
          this.broadcast()
          this.persist()
          if (this.blockedUntil && Date.now() < this.blockedUntil) {
            this.log('manual probe aborted: captcha cooldown')
            break
          }
          await new Promise((r) => setTimeout(r, 1500))
        }
      } finally {
        this.cycling = false
        this.probing.total = 0
        this.probing.done = 0
        this.probing.id = ''
        this.broadcast()
        this.runPending()
      }
      return
    }

    // 自动轮询：首选关注列表（一次加载拿到"关注的人里谁在播"）
    // 自动轮询：默认逐个房间轮转探测。
    // PR_FOLLOW=1 可试「关注列表」模式（实验）：/follow 页会被 SPA 接管成播放器，
    // 已改用 CDP 抓接口，但该接口返回 protobuf，暂时提不出房间号，所以默认关闭。
    if (process.env.PR_FOLLOW !== '1') {
      await this.tick()
      return
    }

    let fallback = false
    this.cycling = true
    try {
      // 首选 CDP 抓关注列表接口；失败再退回读 DOM
      let f = await this.followProbe.probeViaCdp()
      if (!f.ok && !f.blocked) {
        this.log('cdp follow probe failed, trying DOM')
        f = await this.followProbe.probe()
      }

      if (f.blocked) {
        this.blockedUntil = Date.now() + this.cooldownMs
        this.log(`follow probe blocked, cooldown ${Math.round(this.cooldownMs / 60000)}min`)
        this.cooldownMs = Math.min(this.cooldownMs * 2, MAX_COOLDOWN_MS)
        this.broadcast()
        this.persist()
        return
      }

      if (f.needLogin) {
        this.follow.at = Date.now()
        this.follow.ok = false
        this.follow.needLogin = true
        this.log('follow list needs login, falling back to per-room probe')
        this.broadcast()
        this.persist()
        fallback = true
      } else if (f.ok) {
        this.follow.empty = Boolean(f.empty)
        this.follow.needLogin = false
        this.cooldownMs = BLOCK_COOLDOWN_MS
        this.applyFollow(f.ids)
        this.broadcast()
        this.persist()
      } else {
        fallback = true
      }
    } finally {
      this.cycling = false
    }

    // 关注列表拿不到时，退回"每轮探 1 个房间"
    if (fallback) await this.tick()
  }

  startCycle() {
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => {
      if (this.blockedUntil && Date.now() < this.blockedUntil) {
        // 冷却期间不再每轮刷日志，只在进入冷却时记一次
        if (!this.cooldownLogged) {
          this.cooldownLogged = true
          const mins = Math.ceil((this.blockedUntil - Date.now()) / 60000)
          this.log('probe paused by captcha cooldown', `${mins}min left`)
        }
        return
      }
      this.cooldownLogged = false
      this.cycle().catch((err) => this.log('cycle failed', err && err.message))
    }, this.intervalMs)
    this.log('probe poll started', `${Math.round(this.intervalMs / 1000)}s`)
  }

  dispose() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.prober.dispose()
    if (this.followProbe) this.followProbe.dispose()
  }
}

module.exports = { WatcherStore, parseRoomInput, resolveRoomInput }
