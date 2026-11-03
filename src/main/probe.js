'use strict'

/**
 * 直播间状态探测。
 *
 * 为什么不能直接请求接口：抖音直播页的 HTML 是空壳（1.2MB 里没有状态字段），
 * /webcast/room/web/enter 直连需要 a_bogus 签名，返回空响应。
 * 所以只能真实加载页面、让它的 JS 渲染出状态，我们再读 DOM。
 *
 * 为了把开销压到最低：
 *  - 用一个常驻的隐藏窗口串行处理队列（不并发开 N 个页面）
 *  - 拦掉所有媒体请求（flv/m3u8/ts/mp4），页面照常渲染但不下载视频流
 *  - 独立的 partition，不带登录态，避免探测行为影响账号的“当前直播间”
 */

const { BrowserWindow, session } = require('electron')

const PROBE_PARTITION = 'persist:probe'
const MEDIA_RE = /\.(flv|m3u8|ts|mp4|m4s|m4v|webm)(\?|#|$)/i
// 探测窗口必须用正常 Chrome UA：Electron 默认 UA 里带 Electron/45，很容易被判成机器人
const UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome.split('.')[0]}.0.0.0 Safari/537.36`
// 被安全验证拦截时的特征
const CAPTCHA_RE = /验证码|滑块|安全验证|captcha|verify|人机验证/i
/**
 * 拉流判活的阈值（字节）。
 * 实测：在播房间 6 秒内媒体流量 4.3MB；未开播房间只有页面静态资源（199KB）且增量为 0。
 * 取 300KB 作为"确实在拉流"的下限。
 */
const STREAM_LIVE_BYTES = 300 * 1024
/** 媒体请求的识别规则：直播流是 pull-flv / flv / m3u8 这类 */
const STREAM_URL_RE = /pull-flv|pull-hls|\.flv(\?|#|$)|\.m3u8(\?|#|$)/i

const EXTRACT_SCRIPT = `(() => {
  const text = (document.body && document.body.innerText) || ''
  const v = document.querySelector('video')
  const title = document.title || ''
  const endedHit = (text.match(/直播已结束|主播已下播|已下播|未开播|暂未开播|直播间不存在|直播已关闭/) || [''])[0]
  const onlineM = text.match(/([0-9.]+\\s*万?)\\s*人(?:在线|观看|在看)/)
  const coverEl =
    document.querySelector('meta[property="og:image"]') ||
    document.querySelector('img[src*="douyinpic"], img[src*="pstatp"], img[src*="byteimg"]')
  // 兜底：找页面里面积最大的一张图当封面
  let biggest = ''
  if (!coverEl) {
    let area = 0
    for (const img of document.images) {
      const a = (img.naturalWidth || 0) * (img.naturalHeight || 0)
      if (a > area && a > 20000) {
        area = a
        biggest = img.currentSrc || img.src || ''
      }
    }
  }
  return {
    title,
    vw: v ? v.videoWidth : 0,
    vh: v ? v.videoHeight : 0,
    paused: v ? v.paused : null,
    // 视频的实际地址：直播流走 MSE（currentSrc 是空的 / blob:），已结束页面的广告是 xxx.mp4
    src: v ? v.currentSrc || v.src || '' : '',
    // 抖音：标题里带「抖音直播间」；虎牙：标题形如「冥界官方直播间-DOTA1-虎牙直播」
    liveHint: /抖音直播间|虎牙直播/.test(title),
    endedHit,
    online: onlineM ? onlineM[1].replace(/\\s+/g, '') : '',
    name:
      (title.match(/^(.*?)的抖音直播间/) || [])[1] ||
      (title.match(/^(.*?)\s*-\s*[^-]{0,20}\s*-\s*虎牙直播/) || [])[1] ||
      (title.replace(/\s*-\s*虎牙直播\s*$/, '').match(/^(.*?)直播[间]?$/) || [])[1] ||
      '',
    cover: coverEl ? (coverEl.content || coverEl.src || '') : biggest,
    sample: text.replace(/\\s+/g, ' ').slice(0, 200)
  }
})()`

class ProbeManager {
  /**
   * @param {{ log?: (...a:any[])=>void, timeoutMs?: number }} opts
   */
  constructor(opts = {}) {
    this.log = opts.log || (() => {})
    this.timeoutMs = opts.timeoutMs || 25000
    this.win = null
    this.queue = []
    this.running = false
    this.stats = { probed: 0, failed: 0 }
  }

  ensureWindow() {
    if (this.win && !this.win.isDestroyed()) return this.win

    const ses = session.fromPartition(PROBE_PARTITION)
    try {
      ses.setUserAgent(UA)
    } catch {}
    ses.webRequest.onBeforeRequest((details, callback) => {
      const url = details.url || ''
      if (details.resourceType === 'media' || MEDIA_RE.test(url)) {
        callback({ cancel: true })
        return
      }
      callback({})
    })

    this.win = new BrowserWindow({
      show: false,
      width: 1100,
      height: 800,
      webPreferences: {
        partition: PROBE_PARTITION,
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false
      }
    })
    this.win.webContents.on('console-message', () => {})
    /**
     * ⚠️ 探测窗是隐藏的，但"隐藏"不等于"静音"。
     * 实测（2026-10-31，6 个房间、两轮检测）：探测
     * https://live.douyin.com/612630333230 时，这个隐藏窗口
     *   media-started → audible=true → 10.6 秒后 media-paused
     * 也就是说**它真的在出声**——用户"只开一个房间却听到别的声音"就是这么来的。
     *
     * 为什么拦不住：媒体拦截只能按"扩展名 / resourceType=media"匹配，
     * 而抖音有的房间走的是无扩展名的 pull-hls 分片，拦不到；
     * 而且不能为了静音把拦截加宽 —— 判活要用"6 秒内媒体流量 4.3MB"这个信号，
     * 拦宽了流量就没了，探测会全部误判成未开播。
     * 所以这里直接把整个 webContents 静音：页面照常解码、流量照常计数，只是不出声。
     */
    try {
      this.win.webContents.setAudioMuted(true)
    } catch {}
    try {
      this.win.webContents.setUserAgent(UA)
    } catch {}
    this.win.on('closed', () => {
      this.win = null
    })
    this.log('probe window ready')
    return this.win
  }

  /** 把一条地址加入队列，返回本次探测结果 */
  probe(url) {
    return new Promise((resolve) => {
      this.queue.push({ url, resolve })
      this.drain()
    })
  }

  async drain() {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length) {
        const job = this.queue.shift()
        let result
        try {
          result = await this.probeOne(job.url)
        } catch (err) {
          result = { status: 'error', error: err && err.message }
        }
        this.stats.probed += 1
        if (result.status === 'error') this.stats.failed += 1
        job.resolve(result)
        // 两条之间留点空隙，别把队列打成突发请求
        await new Promise((r) => setTimeout(r, 600))
      }
    } finally {
      this.running = false
    }
  }

  /** 在多份取样里挑证据最强的：有"已结束"文案 → 有在播视频 → 有视频但暂停 → 任意 */
  pickBestSample(samples) {
    const ended = samples.find((s) => s.endedHit)
    if (ended) return ended
    const playing = samples.find((s) => s.vw > 0 && s.paused === false)
    if (playing) return playing
    const paused = samples.find((s) => s.paused === true)
    if (paused) return paused
    const withVideo = samples.find((s) => s.vw > 0)
    if (withVideo) return withVideo
    return samples[samples.length - 1]
  }

  /**
   * 用 CDP 的 Network 域量"媒体流量"——绕开页面 JS 是否卡死的问题。
   * 必须在导航**之前**挂上（长连接建立后再挂就抓不到那条请求了）。
   *
   * 返回 { mediaBytes, mediaReqs }，调用方自己决定阈值。
   */
  async startStreamMeter(win) {
    const dbg = win.webContents.debugger
    const state = { mediaBytes: 0, mediaReqs: 0 }
    const mediaIds = new Set()
    try {
      // 复用的探测窗口可能还挂着上一次的调试会话，先断开再挂，否则事件收不到
      if (dbg.isAttached()) {
        try {
          dbg.detach()
        } catch {}
      }
      dbg.attach('1.3')
    } catch (err) {
      this.log('meter attach failed', err && err.message)
      return null
    }
    const onMsg = (event, method, params) => {
      if (method === 'Network.requestWillBeSent') {
        const url = String((params.request && params.request.url) || '')
        if (STREAM_URL_RE.test(url) || params.type === 'Media') {
          mediaIds.add(params.requestId)
          state.mediaReqs = mediaIds.size
        }
      } else if (method === 'Network.dataReceived') {
        if (mediaIds.has(params.requestId)) state.mediaBytes += params.dataLength || 0
      }
    }
    dbg.on('message', onMsg)
    // 必须等 Network 域真正启用再导航，否则抓不到直播流那条长连接
    try {
      await Promise.race([dbg.sendCommand('Network.enable'), new Promise((r) => setTimeout(r, 5000))])
    } catch (err) {
      this.log('meter Network.enable failed', err && err.message)
    }

    return {
      state,
      stop: () => {
        try {
          dbg.removeListener('message', onMsg)
          dbg.detach()
        } catch {}
      }
    }
  }

  /** 判活：隔 1.5 秒截两张图，比"有多少像素变了" */
  async frameMotion(win) {
    try {
      const a = await win.webContents.capturePage()
      const bufA = a.toBitmap()
      if (!bufA.length) return null
      await new Promise((r) => setTimeout(r, 1500))
      const b = await win.webContents.capturePage()
      const bufB = b.toBitmap()
      if (bufB.length !== bufA.length) return null
      let changed = 0
      let total = 0
      for (let i = 0; i < bufA.length; i += 4) {
        const d =
          Math.abs(bufA[i] - bufB[i]) + Math.abs(bufA[i + 1] - bufB[i + 1]) + Math.abs(bufA[i + 2] - bufB[i + 2])
        if (d > 24) changed += 1
        total += 1
      }
      return Math.round((changed / total) * 1000) / 10
    } catch (err) {
      this.log('frameMotion failed', err && err.message)
      return null
    }
  }

  async probeOne(url) {
    const win = this.ensureWindow()
    const started = Date.now()
    let settled = false
    /** 主框架加载失败（域名不存在、断网、5xx 等）：不能当成"未开播" */
    let loadError = ''
    /** @type {{state:{mediaBytes:number,mediaReqs:number}, stop:()=>void} | null} */
    let meter = null

    // 先挂 CDP 并等 Network 域启用，再导航——否则抓不到直播流那条长连接
    meter = await this.startStreamMeter(win)

    const loaded = new Promise((resolve) => {
      const done = () => {
        if (settled) return
        settled = true
        resolve()
      }
      // 等 dom-ready 就够了：直播间的 did-finish-load / did-stop-loading 常常永远不触发
      // （实测已结束的房间会一直挂着，把每次探测拖到 25 秒超时）
      win.webContents.once('dom-ready', done)
      win.webContents.once('did-finish-load', done)
      win.webContents.once('did-fail-load', (event, code, desc, failedUrl, isMainFrame) => {
        // -3 是被主动中断，不算失败
        if (isMainFrame && code !== -3) loadError = `${code} ${desc || ''}`.trim()
        done()
      })
      // CDP 必须在导航前挂上并等 Network 域启用，否则抓不到已经建立的直播流长连接
      win.loadURL(url).catch((err) => {
        loadError = err && err.message ? err.message : 'loadURL rejected'
        done()
      })
    })

    await Promise.race([loaded, new Promise((r) => setTimeout(r, 12000))])

    // 多次取样：页面的可读性随时序变化（起播前 JS 能读但没画面，起播后画面有了但主线程被占），
    // 单次取样不可靠，所以隔一段时间取 3 次，最后按"最有力的证据"判定。
    const samples = []
    for (const wait of [1000, 3000, 4000]) {
      await new Promise((r) => setTimeout(r, wait))
      try {
        const one = await Promise.race([
          win.webContents.executeJavaScript(EXTRACT_SCRIPT, true),
          new Promise((r) => setTimeout(() => r(null), 7000))
        ])
        if (one) samples.push(one)
      } catch (err) {
        this.log('probe extract attempt failed', url, err && err.message)
      }
      if (samples.some((s) => s.endedHit || (s.vw > 0 && s.paused === false))) break
    }
    const info = samples.length ? this.pickBestSample(samples) : null
    const motionPct = loadError ? null : await this.frameMotion(win)
    // 媒体流量：页面卡死也能量到，这是主判据
    const mediaBytes = meter ? meter.state.mediaBytes : null
    const mediaReqs = meter ? meter.state.mediaReqs : null
    if (meter) meter.stop()

    // 页面根本没加载出来：判为 error，绝不能报成"未开播"
    if (loadError) {
      try {
        win.webContents.stop()
      } catch {}
      this.log('probe load error', url, loadError)
      return {
        status: 'error',
        error: loadError,
        name: '',
        title: '',
        cover: '',
        online: '',
        vw: 0,
        vh: 0,
        sample: `loadError:${loadError}`,
        ms: Date.now() - started
      }
    }

    // 兜底：页面 JS 卡住时（不存在的直播间、异常重的房间常见）用窗口标题判定。
    // 但标题对"直播已结束"是不变的，所以先单独查一次这句文案，避免误报在播。
    if (!info) {
      let endedLite = ''
      try {
        endedLite = await Promise.race([
          win.webContents.executeJavaScript(
            `(() => {
               const t = (document.body && document.body.innerText) || ''
               const m = t.match(/直播已结束|主播已下播|已下播|未开播|暂未开播|直播间不存在/)
               return m ? m[0] : ''
             })()`,
            true
          ),
          new Promise((r) => setTimeout(() => r(''), 5000))
        ])
      } catch {}
      if (endedLite) this.log('probe ended-lite hit', url, endedLite)
      let title = ''
      try {
        title = win.webContents.getTitle() || ''
      } catch {}
      const finalUrl = (() => {
        try {
          return win.webContents.getURL()
        } catch {
          return ''
        }
      })()
      try {
        win.webContents.stop()
      } catch {}
      const fallbackInfo = {
        title,
        endedHit: endedLite || '',
        liveHint: /抖音直播间/.test(title),
        vw: 0
      }
      return {
        status: this.verdict(fallbackInfo, motionPct, mediaBytes),
        motion: motionPct,
        name: (title.match(/^(.*?)的抖音直播间/) || [])[1] || '',
        title,
        cover: '',
        online: '',
        vw: 0,
        vh: 0,
        sample: `fallback:${finalUrl.slice(0, 80)}`,
        ms: Date.now() - started
      }
    }

    const status = this.verdict(info, motionPct, mediaBytes)
    return {
      status,
      motion: motionPct,
      mediaBytes,
      mediaReqs,
      name: info.name || '',
      title: info.title || '',
      cover: info.cover || '',
      online: info.online || '',
      vw: info.vw,
      vh: info.vh,
      sample: info.sample,
      ms: Date.now() - started
    }
  }

  /**
   * 判定顺序：
   *  1. 验证码 → blocked（保留旧状态）
   *  2. 正文有"直播已结束"之类 → offline
   *  3. **媒体流量（CDP 量到的 pull-flv 字节数）→ 主判据**：
   *     有持续流量 = live；有媒体请求但流量为 0 = offline；
   *  4. 页面 JS 读到了且有正在解码的视频 → live / 有视频但暂停 → offline
   *  5. 什么都拿不到 → unknown（保留上次判定，标「未确认」）
   *
   * 为什么以流量为主：已结束的房间会把渲染主线程卡死，读不到文案和视频状态；
   * 而媒体流量走的是主进程 CDP，不受影响。实测在播 6 秒 4.3MB、未开播 0 字节。
   * 帧差（motionPct）只记录不判定——已结束页面的广告/动画会让帧差飙到 40%。
   */
  verdict(info, motionPct, mediaBytes) {
    const title = (info && info.title) || ''
    const sample = (info && info.sample) || ''
    const name = (title.match(/^(.*?)的抖音直播间/) || [])[1] || ''
    if (CAPTCHA_RE.test(title) || CAPTCHA_RE.test(sample.slice(0, 80))) return 'blocked'
    if (info && info.endedHit) return 'offline'
    if (/账号已注销|已注销|用户不存在|该用户不存在|无法查看/.test(name || title)) return 'offline'

    // 主判据：媒体流量。够量就是铁证。
    if (typeof mediaBytes === 'number' && mediaBytes >= STREAM_LIVE_BYTES) return 'live'

    // 流量不够时先看页面里的视频，别急着判停播：
    // 抖音播放器是「拉一大块（实测单块到 89MB）再播一段」，6 秒采样窗口可能整段落在间歇里，
    // 只看流量会把在播房间误判成停播（实测同一房间 0KB/s 与 678KB/s 交替出现）。
    // 但已结束的页面会循环播一个 199KB 的广告 mp4，那不是直播流，必须排除。
    if (info && info.vw > 0 && info.paused === false && !/\.mp4(\?|#|$)/i.test(String(info.src || ''))) {
      return 'live'
    }

    if (typeof mediaBytes === 'number') {
      return 'offline'
    }

    if (info) {
      const playing = info.vw > 0 && info.paused === false
      if (playing) return 'live'
      if (info.vw > 0 || info.paused === true) return 'offline'
    }
    if (process.env.PR_LOG) this.log('verdict unknown', title.slice(0, 30), 'motion=', motionPct)
    return 'unknown'
  }

  /**
   * 轮询「直播广场」拿在播房间集合。
   *
   * ⚠️ 目前未启用：实测对具体主播的覆盖率是 0——精选位 3 轮共 60 个在播房间与用户
   * 的 32 个房间零重合；/categorynew/4_101~4_108 八个分类页也只返回同样的 15 个
   * 推荐房间，同样零重合。也就是说广场推荐的是站点主推内容，不是这些游戏主播。
   * 保留实现备查，等抖音改版或换用关注列表方案时可复用。
   */
  async probeSquare() {
    const win = this.ensureWindow()
    const started = Date.now()

    let ready = false
    win.webContents.once('did-stop-loading', () => {
      ready = true
    })
    try {
      win.loadURL('https://live.douyin.com/').catch(() => {})
    } catch {}
    const deadline = Date.now() + Math.min(this.timeoutMs, 20000)
    while (!ready && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200))
    }
    // 给前端渲染 + 首屏数据留点时间
    await new Promise((r) => setTimeout(r, 1800))

    const script = `(async () => {
      const grab = () => {
        const set = new Set()
        for (const a of document.querySelectorAll('a[href]')) {
          const m = String(a.href).match(/live\\.douyin\\.com\\/(\\d{5,})/)
          if (m) set.add(m[1])
        }
        return set
      }
      const all = grab()
      // 广场是懒加载的，往下滚几屏能多拿到一些房间
      for (let i = 0; i < 8; i++) {
        window.scrollBy(0, Math.max(400, window.innerHeight * 0.9))
        await new Promise((r) => setTimeout(r, 450))
        for (const id of grab()) all.add(id)
      }
      return {
        ids: [...all],
        title: document.title || '',
        text: ((document.body && document.body.innerText) || '').slice(0, 120)
      }
    })()`

    let info = null
    try {
      info = await Promise.race([
        win.webContents.executeJavaScript(script, true),
        new Promise((r) => setTimeout(() => r(null), 20000))
      ])
    } catch (err) {
      this.log('square extract failed', err && err.message)
    }

    if (!info) {
      let title = ''
      try {
        title = win.webContents.getTitle() || ''
      } catch {}
      const blocked = CAPTCHA_RE.test(title)
      this.log('square probe no data', { title, blocked })
      return { ok: false, blocked, ids: [], ms: Date.now() - started }
    }

    const blocked = CAPTCHA_RE.test(info.title) || CAPTCHA_RE.test(info.text)
    this.log('square probe', { ids: info.ids.length, blocked, ms: Date.now() - started })
    return {
      ok: !blocked,
      blocked,
      ids: info.ids || [],
      title: info.title || '',
      ms: Date.now() - started
    }
  }

  dispose() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
  }
}

/**
 * 关注列表探测：用**已登录**的 session 打开 live.douyin.com/follow，
 * 一次加载就能拿到"我关注的主播里谁在播"，不用逐个探房间。
 *
 * 注意：媒体拦截不能在这里自己挂 webRequest（同一 session 只能挂一个监听，
 * 会覆盖掉主进程的流地址嗅探），所以由主进程统一拦截，这里只管告诉它要不要拦。
 */
class FollowProbe {
  constructor(opts = {}) {
    this.log = opts.log || (() => {})
    this.partition = opts.partition || 'persist:douyin'
    this.blockMediaFor = opts.blockMediaFor || (() => {})
    this.timeoutMs = opts.timeoutMs || 30000
    this.win = null
  }

  ensureWindow() {
    if (this.win && !this.win.isDestroyed()) return this.win
    const ses = session.fromPartition(this.partition)
    try {
      ses.setUserAgent(UA)
    } catch {}
    this.win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        partition: this.partition,
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false
      }
    })
    try {
      this.win.webContents.setUserAgent(UA)
      this.blockMediaFor(this.win.webContents.id)
      // 隐藏窗口也会出声：跟 ProbeManager 一样整个静音
      this.win.webContents.setAudioMuted(true)
    } catch {}
    // 关注页会自动跳进关注里的第一个直播间，把页面抢走 → 阻断这次跳转，钉在列表上
    const stopNav = (event) => {
      try {
        event.preventDefault()
        this.log('follow navigation blocked')
      } catch {}
    }
    this.win.webContents.on('will-navigate', stopNav)
    this.win.webContents.on('will-redirect', stopNav)
    this.win.on('closed', () => {
      this.win = null
    })
    this.log('follow window ready')
    return this.win
  }

  /**
   * 抓关注列表接口的响应体拿在播房间号。
   *
   * 为什么不读 DOM：/follow 页会被 SPA 接管成播放器（实测标题变成「某某的抖音直播间」、
   * URL 仍是 /follow），DOM 被替换且主线程被占满，executeJavaScript 会直接超时。
   * 走 CDP 的 Network 域拿接口 JSON 就绕开了渲染。
   */
  async probeViaCdp() {
    const win = this.ensureWindow()
    const started = Date.now()
    const ids = new Set()
    let hits = 0
    let titles = []

    const dbg = win.webContents.debugger
    try {
      if (!dbg.isAttached()) dbg.attach('1.3')
      this.log('cdp attached')
      await Promise.race([
        dbg.sendCommand('Network.enable'),
        new Promise((r) => setTimeout(() => r('timeout'), 5000))
      ])
      this.log('cdp network enabled')
    } catch (err) {
      this.log('cdp attach failed', err && err.message)
      return { ok: false, ids: [], blocked: false, needLogin: false, ms: Date.now() - started }
    }

    const onMessage = async (event, method, params) => {
      if (method !== 'Network.responseReceived') return
      const url = String((params.response && params.response.url) || '')
      if (!/douyin|amemv|snssdk/i.test(url)) return
      // 关注列表/直播列表相关接口
      if (!/(webcast|aweme)[^?]*(follow|feed|room|list|enter)/i.test(url)) return
      hits += 1
      if (hits <= 3) this.log('cdp candidate', url.slice(0, 90))
      try {
        const body = await Promise.race([
          dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId }),
          new Promise((r) => setTimeout(() => r(null), 4000))
        ])
        if (!body) return
        const text = body.base64Encoded
          ? Buffer.from(body.body, 'base64').toString('utf8')
          : String(body.body || '')
        if (titles.length < 3) titles.push(url.slice(0, 60))
        for (const m of text.matchAll(/"web_rid"\s*:\s*"(\d{5,})"/g)) ids.add(m[1])
        for (const m of text.matchAll(/"room_id_str"\s*:\s*"(\d{5,})"/g)) ids.add(m[1])
        for (const m of text.matchAll(/live\.douyin\.com\/(\d{5,})/g)) ids.add(m[1])
        this.log('cdp body parsed', { url: url.slice(0, 60), size: text.length, ids: ids.size })
      } catch {}
    }

    dbg.on('message', onMessage)
    try {
      win.loadURL(`https://live.douyin.com/follow?t=${Date.now()}`).catch(() => {})
      this.log('cdp follow url loading')
    } catch {}
    await new Promise((r) => setTimeout(r, 12000))

    try {
      dbg.removeListener('message', onMessage)
    } catch {}

    let title = ''
    try {
      title = win.webContents.getTitle() || ''
    } catch {}

    const blocked = CAPTCHA_RE.test(title)
    this.log('follow cdp probe', { hits, ids: ids.size, blocked, title: title.slice(0, 30), urls: titles, ms: Date.now() - started })

    return {
      ok: !blocked && ids.size > 0,
      blocked,
      needLogin: ids.size === 0 && /登录/.test(title),
      ids: [...ids],
      title,
      ms: Date.now() - started,
      via: 'cdp'
    }
  }

  async probe() {
    const win = this.ensureWindow()
    const started = Date.now()

    let ready = false
    win.webContents.once('dom-ready', () => {
      ready = true
    })
    try {
      win.loadURL('https://live.douyin.com/follow').catch(() => {})
    } catch {}
    const deadline = Date.now() + Math.min(this.timeoutMs, 20000)
    while (!ready && Date.now() < deadline) await new Promise((r) => setTimeout(r, 150))
    // 列表接口回来后很快就会有卡片，先快速读一次，再滚动补读
    await new Promise((r) => setTimeout(r, 1800))

    const script = `(async () => {
      const grab = () => {
        const s = new Set()
        for (const a of document.querySelectorAll('a[href]')) {
          const m = String(a.href).match(/live\\.douyin\\.com\\/(\\d{5,})/)
          if (m) s.add(m[1])
        }
        return s
      }
      const all = grab()
      for (let i = 0; i < 6; i++) {
        window.scrollBy(0, Math.max(400, window.innerHeight * 0.85))
        await new Promise((r) => setTimeout(r, 420))
        for (const id of grab()) all.add(id)
      }
      const text = ((document.body && document.body.innerText) || '').slice(0, 400)
      const needLogin = /登录后|请先登录|扫码登录|立即登录/.test(text) && all.size === 0
      const empty = /暂无|还没有|去关注/.test(text)
      return { ids: [...all], title: document.title || '', text, needLogin, empty, url: location.href }
    })()`

    let info = null
    try {
      info = await Promise.race([
        win.webContents.executeJavaScript(script, true),
        new Promise((r) => setTimeout(() => r(null), 25000))
      ])
    } catch (err) {
      this.log('follow extract failed', err && err.message)
    }

    if (!info) {
      let title = ''
      let url = ''
      try {
        title = win.webContents.getTitle() || ''
        url = win.webContents.getURL() || ''
      } catch {}
      this.log('follow probe no data', { title, url: url.slice(0, 80) })
      return { ok: false, blocked: CAPTCHA_RE.test(title), needLogin: false, ids: [], title, ms: Date.now() - started }
    }

    const blocked = CAPTCHA_RE.test(info.title) || CAPTCHA_RE.test(info.text)
    this.log('follow probe', {
      ids: info.ids.length,
      blocked,
      needLogin: info.needLogin,
      empty: info.empty,
      url: String(info.url || '').slice(0, 70),
      ms: Date.now() - started
    })
    return {
      ok: !blocked && !info.needLogin,
      blocked,
      needLogin: info.needLogin,
      empty: info.empty,
      ids: info.ids || [],
      title: info.title || '',
      ms: Date.now() - started
    }
  }

  dispose() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
  }
}

module.exports = { ProbeManager, FollowProbe, PROBE_PARTITION }
