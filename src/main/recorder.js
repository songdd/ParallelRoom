'use strict'

/**
 * 录制管理（主进程），两种模式：
 *
 *  stream  —— 直接录直播流（推荐）：从页面网络请求里抓到 HTTP-FLV 地址，
 *             ffmpeg `-c copy` 原样转封装，画质=平台原画、60fps、立体声、零重编码、CPU 极低。
 *  screen  —— 屏幕捕获兜底：抓不到流地址时，按瓦片矩形裁剪录制（分辨率受窗口像素限制）。
 *
 * 音频差异：stream 模式录到的是该房间自己的音轨（天然独立）；
 *          screen 模式只能取系统 loopback，所有房间混成一路。
 */

const { BrowserWindow, desktopCapturer, app, session } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const PARTITION = 'persist:recorder'
const STREAM_RE = /\.flv(\?|$)|\.m3u8(\?|$)/i
/** 同时录制的上限：直录流很轻，屏幕捕获重（要解码+重编码）所以单独限 1 路 */
const MAX_STREAM_RECORDINGS = 8
const MAX_SCREEN_RECORDINGS = 1
/** 直播流断了最多自动续录几次，以及退避基数（3s→6s→12s→24s→30s） */
const MAX_STREAM_RETRIES = 5
const RETRY_BASE_MS = 3000
/**
 * 抓到的流地址多久还算数。
 *
 * 抖音的 flv 地址带 `expire=` 签名，实测是抓取后约 7 天（1793951397 - 抓取时刻 ≈ 608326 秒）。
 * 这里原来只认 30 分钟，结果看了一小时再点 ⏺ → 地址被判过期 → 掉到屏幕录制 →
 * 屏幕录制会把这块画面放大，用户看到的就是"点录制按钮变成窗口最大化"。放宽到 6 小时。
 */
const MAX_URL_AGE_MS = 6 * 60 * 60 * 1000
/** ffmpeg 进度行多久不前进就算卡死（秒数×1000） */
const TILE_STALL_IDLE_MS = 60 * 1000
/** 分段文件名编号位数（1 分钟一段、录十几个小时也不会排错序） */
const PART_PAD = 4
/** 「保留分段」模式的标记文件名：有这个文件的目录，启动恢复时不去合并 */
const KEEP_PARTS_MARKER = '.keep-parts.json'
const UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome.split('.')[0]}.0.0.0 Safari/537.36`

function findFfmpeg() {
  if (process.env.PR_FFMPEG && fs.existsSync(process.env.PR_FFMPEG)) return process.env.PR_FFMPEG
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, 'ffmpeg.exe')
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {}
  }
  for (const c of ['D:\\tools\\ffmpeg-8.1.1-essentials_build\\bin\\ffmpeg.exe']) {
    try {
      if (fs.existsSync(c)) return c
    } catch {}
  }
  return null
}

/**
 * 默认录制目录 = 项目目录下的 output。
 * 开发态 app.getAppPath() 就是 D:\code\ParallelRoom，打包后可能指到 asar，
 * 所以再兜一层 exe 所在目录，保证"忘了配也能落到项目旁边"。
 */
function DEFAULT_OUT_DIR() {
  const candidates = []
  try {
    candidates.push(path.join(app.getAppPath(), 'output'))
  } catch {}
  try {
    candidates.push(path.join(path.dirname(process.execPath), 'output'))
  } catch {}
  candidates.push(path.join(__dirname, '..', '..', 'output'))
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.dirname(c))) return path.resolve(c)
    } catch {}
  }
  return path.resolve(candidates[candidates.length - 1])
}

/** ffprobe 一般在 ffmpeg 同一个目录里；用来量视频尺寸（图片水印要按画面宽度算缩放） */function findFfprobe(ffmpegPath) {
  if (process.env.PR_FFPROBE && fs.existsSync(process.env.PR_FFPROBE)) return process.env.PR_FFPROBE
  if (ffmpegPath) {
    const sibling = path.join(path.dirname(ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
    try {
      if (fs.existsSync(sibling)) return sibling
    } catch {}
  }
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {}
  }
  return null
}

/**
 * 按"录制发生的时间顺序"排序：修改时间升序，同一时刻再按文件名。
 * 合并视频必须用这个顺序——勾选顺序 / 列表显示顺序都不可靠（列表是时间倒序渲染的）。
 */
function sortByTime(files) {
  const mt = (p) => {
    try {
      return fs.statSync(p).mtimeMs
    } catch {
      return 0
    }
  }
  return [...files].sort((a, b) => {
    const d = mt(a) - mt(b)
    if (d !== 0) return d
    return path.basename(a).localeCompare(path.basename(b), 'zh-Hans-CN')
  })
}

function sanitize(name) {
  return (
    String(name || 'recording')
      .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || 'recording'
  )
}

/**
 * 水印用的字体。drawtext 需要 libfreetype 能读的字体文件；
 * 中文得用系统里的 CJK 字体（实测 msyh.ttc / simhei.ttf 都能正确渲染，不是豆腐块）。
 */
function findFont() {
  const candidates = [
    process.env.PR_WM_FONT,
    'C:\\Windows\\Fonts\\msyh.ttc',
    'C:\\Windows\\Fonts\\msyhbd.ttc',
    'C:\\Windows\\Fonts\\simhei.ttf',
    'C:\\Windows\\Fonts\\simsun.ttc',
    'C:\\Windows\\Fonts\\arial.ttf'
  ].filter(Boolean)
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch {}
  }
  return ''
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

class RecorderManager {
  constructor(opts = {}) {
    this.log = opts.log || (() => {})
    this.getMainWindow = opts.getMainWindow || (() => null)
    this.onState = opts.onState || (() => {})
    this.streamUrls = opts.streamUrls || new Map()
    this.ffmpeg = findFfmpeg()
    // 默认存到项目下的 output 目录（即 D:\code\ParallelRoom\output），可通过「录制目录」改
    this.outDir = opts.outDir || DEFAULT_OUT_DIR()
    // 遗留中转目录（老版本在这里放过分段；现在分段直接进 <outDir>/<主播>_<时间戳>/）
    this.tmpDir = process.env.PR_REC_TMP
      ? path.resolve(process.env.PR_REC_TMP)
      : path.join(app.getPath('temp'), 'ParallelRoomRec')
    // 单次录制时长上限（默认 60 分钟，0 = 不限）与磁盘保底（默认剩 2GB 就拒绝开录）
    // 这两个都能在「录制选项」菜单里改
    const maxOpt = Number(opts.maxDurationMs)
    this.maxDurationMs =
      Number.isFinite(maxOpt) && maxOpt >= 0
        ? maxOpt
        : Number(process.env.PR_REC_MAX_SEC) * 1000 || 60 * 60 * 1000
    const freeOpt = Number(opts.minFreeMb)
    this.minFreeBytes =
      Number.isFinite(freeOpt) && freeOpt >= 0
        ? Math.round(freeOpt * 1024 * 1024)
        : Number(process.env.PR_REC_MIN_FREE_MB) * 1024 * 1024 || 2 * 1024 * 1024 * 1024
    this.watchdog = null
    this.win = null
    this.pendingSource = null
    /** uid -> 录制中 */
    this.actives = new Map()
    /** uid -> 等待自动续录的定时器（用户点停止要能取消） */
    this.pendingResumes = new Map()
    this.screenAct = null
    /** sid → 屏幕录制 act（分段时新旧两路可能同时在收尾，靠 sid 分流） */
    this.screenActs = new Map()
    /** 屏幕/整窗录制最近一次的启动参数（分段要用同一个裁剪矩形重新起） */
    this.screenParams = null
    /** 录制事件日志（不受 PR_LOG 控制，出问题能回溯） */
    this.recLogPath = opts.logFile || ''
    /** 分段时长：默认 5 分钟一段（0 = 不切段） */
    this.segmentMs = Number(opts.segmentMs) || Number(process.env.PR_SEG_SEC) * 1000 || 5 * 60 * 1000
    /** 保留分段：停止时不合并成 mp4，直接把 part000N.mkv 留着 */
    this.keepParts = opts.keepParts !== undefined ? !!opts.keepParts : process.env.PR_KEEP_PARTS === '1'
    /** 水印（默认关：开着要重编码，CPU 和画质都有代价） */
    this.watermark = {
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
      toSec: 0
    }
    this.fontPath = findFont()
    this.ffprobe = findFfprobe(this.ffmpeg)
    // 用 normWatermark 过一遍，保证配置字段完整合法
    this.watermark = this.normWatermark({ ...this.watermark, ...(opts.watermark || {}) })
  }

  /** 量视频尺寸（图片水印要按画面宽度的比例缩放，得知道画面多宽） */
  probeVideoSize(file) {
    return new Promise((resolve) => {
      if (!this.ffprobe) return resolve(null)
      const child = spawn(this.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], {
        windowsHide: true
      })
      let out = ''
      child.stdout.on('data', (d) => {
        out += d.toString()
      })
      child.on('error', () => resolve(null))
      child.on('close', () => {
        const m = out.trim().match(/^(\d+),(\d+)/)
        resolve(m ? { width: Number(m[1]), height: Number(m[2]) } : null)
      })
    })
  }

  /**
   * 录制专属日志：不依赖 PR_LOG，默认写到 userData/rec.log。
   * 加它的原因：用户的录制在约 15 分钟后静默中断，而当时没开 PR_LOG，事后完全无法回溯。
   */
  rlog(...args) {
    const line = `[${new Date().toISOString()}] ${args
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')}\n`
    try {
      if (this.recLogPath) {
        try {
          const st = fs.statSync(this.recLogPath)
          if (st.size > 2 * 1024 * 1024) fs.renameSync(this.recLogPath, this.recLogPath + '.1')
        } catch {}
        fs.appendFileSync(this.recLogPath, line)
      }
    } catch {}
    this.log('[rec]', ...args)
  }

  /** 输出目录所在磁盘的剩余字节数；拿不到返回 null */
  async checkDisk(dir = this.outDir) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      const st = await fs.promises.statfs(dir)
      return Number(st.bavail) * Number(st.bsize)
    } catch (err) {
      this.log('statfs failed', err && err.message)
      return null
    }
  }

  fmtGB(bytes) {
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
  }

  fmtDuration(ms) {
    const sec = Math.round(ms / 1000)
    if (sec < 60) return `${sec} 秒`
    const min = Math.round(ms / 60000)
    if (min < 60) return `${min} 分钟`
    return `${(min / 60).toFixed(1)} 小时`
  }

  /** 每条录制独立的到点计时器：到时长上限就自动停止（比看门狗精确） */
  armDurationTimer(act) {
    clearTimeout(act.maxTimer)
    // 0 = 不限时长，不挂计时器
    if (!this.maxDurationMs) return
    act.maxTimer = setTimeout(() => {
      if (!this.actives.has(act.key)) return
      // 标记成"用户/上限主动停"，别触发自动续录
      act.durationCapped = true
      act.stopping = true
      this.notice(`「${act.label}」已达单次录制上限 ${this.fmtDuration(this.maxDurationMs)}，自动停止并保存`)
      this.stop(act.uid)
    }, Math.max(1000, this.maxDurationMs))
  }

  /** 手动推送一条提示给界面（自动停止、磁盘告警等） */
  notice(message) {
    this.log('notice', message)
    this.onState({ phase: 'notice', message })
    const mainWin = this.getMainWindow()
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('rec:state', { notice: message })
  }

  startWatchdog() {
    if (this.watchdog) return
    this.watchdog = setInterval(() => {
      this.watchdogTick().catch((err) => this.log('watchdog failed', err && err.message))
    }, 30000)
  }

  stopWatchdog() {
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = null
  }

  async watchdogTick() {
    if (!this.actives.size) {
      this.stopWatchdog()
      return
    }

    // 磁盘保底（时长上限由每条录制自己的计时器负责）
    const free = await this.checkDisk()
    if (free !== null && free < this.minFreeBytes) {
      this.notice(`磁盘剩余 ${this.fmtGB(free)} 低于安全线（${this.fmtGB(this.minFreeBytes)}），已停止全部录制`)
      for (const act of [...this.actives.values()]) this.stop(act.uid)
      return
    }

    // 卡死检测：网络卡了以后 ffmpeg 会一直等，既不退出也不写数据，录制看上去还在、其实已经废了。
    //
    // ⚠️ 不能用文件大小判：ffmpeg 一直开着分段文件，Windows 在这期间不一定更新文件大小
    // （实测 5 分钟里 `part001.mkv` 在资源管理器里一直是 0 字节，实际上一直在写）。
    // 改用 ffmpeg 自己打的 `time=HH:MM:SS` 进度：60 秒不前进才算卡死。
    for (const act of [...this.actives.values()]) {
      if (act.mode !== 'stream' || act.stopping) continue
      const at = act.progress ? act.progress.at : 0
      const idleMs = Date.now() - (at || act.startedAt)
      act.idleMs = idleMs
      if (idleMs < TILE_STALL_IDLE_MS) continue
      this.rlog('stream stalled, killing ffmpeg to reconnect', {
        label: act.label,
        idleSec: Math.round(idleMs / 1000),
        progressSec: act.progress ? Math.round(act.progress.sec) : 0,
        bytes: this.partsBytes(act.dir)
      })
      this.notice(`「${act.label}」直播流卡住了（${Math.round(idleMs / 1000)} 秒没有进度），正在重连…`)
      if (act.progress) act.progress.at = Date.now()
      try {
        act.child.kill('SIGKILL')
      } catch {}
    }
  }

  get ready() {
    return Boolean(this.ffmpeg)
  }

  countByMode(mode) {
    let n = 0
    for (const a of this.actives.values()) if (a.mode === mode) n += 1
    return n
  }

  setOutDir(dir) {
    if (!dir || typeof dir !== 'string') return this.outDir
    this.outDir = dir
    try {
      fs.mkdirSync(this.outDir, { recursive: true })
    } catch (err) {
      this.log('setOutDir failed', err && err.message)
    }
    this.broadcast()
    return this.outDir
  }

  /**
   * 收拾上次残留的录制：程序被强杀 / 断流时 ffmpeg 被 SIGKILL，录到的数据只剩临时目录里的文件，
   * 用户看到的就是"录制没了"。启动时把它们合并成 mp4 放回录制目录。
   *
   * 两种残留都要处理：
   *   - 会话目录 `<label>_<时间戳>/part000.mkv…`（当前格式，多段拼起来）
   *   - 散落的 `<label>_<时间戳>.mkv`（老格式）
   *
   * 实测踩到：一段 5.36GB / 30:46 的 1080p 录制就躺在 %TEMP%\ParallelRoomRec 里没进 output。
   */
  async recoverOrphans() {
    /** 收集一个目录里的残留：会话子目录（有 part）、老格式散装 mkv/webm */
    const scan = (dir, into, { dirsOnly = false } = {}) => {
      let entries = []
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
          const parts = this.listParts(full)
          if (!parts.length) continue
          // 「保留分段」模式的目录：用户要的就是这些 part，别自作主张合并掉
          if (fs.existsSync(path.join(full, KEEP_PARTS_MARKER))) continue
          into.push({ kind: 'session', name: e.name, dir: full, parts, outDir: dir })
        } else if (!dirsOnly && /\.mkv$/i.test(e.name)) {
          into.push({ kind: 'legacy', name: e.name, file: full, outDir: dir })
        } else if (!dirsOnly && /\.webm$/i.test(e.name)) {
          // 屏幕/整窗录制的中转文件（VP9/opus），程序被杀时会留下来
          into.push({ kind: 'webm', name: e.name, file: full, outDir: dir })
        }
      }
    }

    const jobs = []
    // 录制目录（新位置：分段就在 <主播>_<时间戳>/ 里）
    scan(this.outDir, jobs)
    // %TEMP% 里的历史残留（老版本留下的）
    if (path.resolve(this.tmpDir) !== path.resolve(this.outDir)) scan(this.tmpDir, jobs)
    if (!jobs.length) return { ok: true, recovered: 0 }

    let recovered = 0
    const failed = []
    const sizeOf = (p) => {
      try {
        return fs.statSync(p).size
      } catch {
        return 0
      }
    }
    for (const job of jobs) {
      const mtimeOf = (p) => {
        try {
          return fs.statSync(p).mtimeMs
        } catch {
          return 0
        }
      }
      const newest = job.kind === 'session' ? Math.max(...job.parts.map(mtimeOf)) : mtimeOf(job.file)
      // 还在写（30 秒内有变动）就跳过，别抢正在录的
      if (Date.now() - newest < 30 * 1000) continue

      const bytes = job.kind === 'session' ? job.parts.reduce((n, p) => n + sizeOf(p), 0) : sizeOf(job.file)
      if (bytes < 10 * 1024) {
        try {
          job.kind === 'session' ? job.parts.forEach((p) => fs.unlinkSync(p)) : fs.unlinkSync(job.file)
        } catch {}
        continue
      }

      // 会话目录里的成片就放在会话目录里；散落文件放在它所在目录
      const mp4 =
        job.kind === 'session'
          ? path.join(job.dir, `${job.name}.mp4`)
          : path.join(job.outDir, `${job.name.replace(/\.(mkv|webm)$/i, '')}.mp4`)
      this.rlog('recovering orphan recording', { kind: job.kind, name: job.name, bytes, parts: job.parts ? job.parts.length : 1 })
      this.notice(`发现上次没保存完的录制（${this.fmtGB(bytes)}），正在${job.kind === 'webm' ? '转码' : '合并'}…`)
      try {
        if (job.kind === 'session') await this.mergeParts(job.parts, mp4, { hevcTag: true })
        else if (job.kind === 'webm') await this.convertScreen(job.file, mp4)
        else await this.remuxToMp4(job.file, mp4)
        try {
          if (job.kind === 'session') job.parts.forEach((p) => fs.unlinkSync(p))
          else fs.unlinkSync(job.file)
        } catch {}
        recovered += 1
        this.broadcast({ lastFile: mp4 })
        this.notice(`已恢复上次的录制：${path.relative(this.outDir, mp4) || path.basename(mp4)}（${this.fmtGB(bytes)}）`)
        this.rlog('recovered orphan recording', { mp4, bytes })
      } catch (err) {
        failed.push(job.name)
        this.rlog('recover orphan failed', { name: job.name, err: err && err.message })
        this.notice(`上次的录制合并失败，原始文件还在 ${job.dir || job.file}`)
      }
    }
    return { ok: true, recovered, failed }
  }

  /** 该 webContents 最近一次请求到的流地址（超过 MAX_URL_AGE_MS 视为过期） */
  streamUrlFor(webContentsId) {
    return this.streamUrlInfo(webContentsId).url
  }

  /** 地址 + 多久之前抓到的（界面提示要用）。按类型优先级挑：FLV > m3u8 播放列表 > 其它 */
  streamUrlInfo(webContentsId) {
    if (!webContentsId) return { url: '', ageMs: null, kind: '', referer: '' }
    const hit = this.streamUrls.get(String(webContentsId))
    if (!hit) return { url: '', ageMs: null, kind: '', referer: '' }
    const now = Date.now()
    // 兼容两种格式：老的 {url, ts} 和新的 {candidates:[{url,ts,kind}]}
    const list = Array.isArray(hit.candidates)
      ? hit.candidates
      : hit.url
        ? [{ url: hit.url, ts: hit.ts, kind: /\.flv(\?|$)/i.test(hit.url) ? 'flv' : 'hls-other' }]
        : []
    const fresh = list.filter((c) => c && c.url && now - (c.ts || 0) <= MAX_URL_AGE_MS)
    if (!fresh.length) {
      const newest = list.reduce((a, b) => (!a || (b.ts || 0) > (a.ts || 0) ? b : a), null)
      return { url: '', ageMs: newest ? now - (newest.ts || 0) : null, kind: '', referer: hit.referer || '' }
    }
    // ⚠️ 不能拿"最后一条"：抖音有的房间会再请求一个无扩展名的 `pull-hls-.../6764832` 分片，
    // 它把正确的 FLV 顶掉后，录出来只有 4 秒就 EOF。
    const rank = { flv: 0, 'hls-playlist': 1, 'hls-other': 2 }
    fresh.sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || (b.ts || 0) - (a.ts || 0))
    const best = fresh[0]
    return {
      url: best.url,
      ageMs: now - (best.ts || 0),
      kind: best.kind || '',
      alternatives: fresh.length,
      referer: hit.referer || ''
    }
  }

  /** 这个 webContents 抓到的所有候选地址（诊断用） */
  streamUrlCandidates(webContentsId) {
    const hit = this.streamUrls.get(String(webContentsId))
    if (!hit) return []
    const list = Array.isArray(hit.candidates) ? hit.candidates : hit.url ? [{ url: hit.url, ts: hit.ts }] : []
    return list.map((c) => ({ kind: c.kind || '', ageMs: Date.now() - (c.ts || 0), url: String(c.url).slice(0, 90) }))
  }

  /** 地址归类成"线路键"：同一台 CDN 的同一种协议只试一次，避免在两条坏线路之间来回跳 */
  lineKeyOf(url) {
    const s = String(url || '')
    const kind = /\.m3u8(\?|$)/i.test(s) ? 'hls' : /\.flv(\?|$)/i.test(s) ? 'flv' : 'other'
    let host = ''
    try {
      host = new URL(s).hostname
    } catch {
      host = s.slice(0, 40)
    }
    return `${host}:${kind}`
  }

  /** 还没试过的一条候选线路（失败时换线用）。返回完整地址，不做截断。 */
  nextCandidateUrl(act) {
    const hit = this.streamUrls.get(String(act.webContentsId))
    if (!hit) return null
    const triedUrls = new Set([...(act.triedUrls || []), String(act.streamUrl)])
    const triedLines = new Set(act.triedLines || [])
    // 已经换过太多条了就别再折腾（防止一直抖）
    if (triedLines.size >= 8) return null
    const list = Array.isArray(hit.candidates) ? hit.candidates : []
    const rank = { flv: 0, 'hls-playlist': 1, 'hls-other': 2 }
    const fresh = list
      .filter((c) => c && c.url && !triedUrls.has(c.url) && !triedLines.has(this.lineKeyOf(c.url)))
      .sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || (b.ts || 0) - (a.ts || 0))
    if (!fresh.length) return null
    const best = fresh[0]
    return { url: best.url, line: best.line || '', kind: best.kind || '', referer: hit.referer || '', lineKey: this.lineKeyOf(best.url) }
  }

  async start(params) {
    if (!this.ffmpeg) return { ok: false, error: '没找到 ffmpeg（可用 PR_FFMPEG 指定路径）' }

    const key = String(params.uid || params.label || '')
    if (key && this.actives.has(key)) return { ok: false, error: '这个房间已经在录制了' }

    // 磁盘保底：剩余空间不够就不开录
    const free = await this.checkDisk()
    if (free !== null && free < this.minFreeBytes) {
      return {
        ok: false,
        error: `磁盘剩余 ${this.fmtGB(free)}，低于安全线 ${this.fmtGB(this.minFreeBytes)}，请清理空间或换录制目录`
      }
    }

    this.startWatchdog()

    const streamInfo = this.streamUrlInfo(params.webContentsId)
    const streamUrl = streamInfo.url
    // forceScreen：整窗录制（不看单个房间的流，直接录窗口画面）
    if (!params.forceScreen) {
      // 单个房间只走直录流。抓不到流地址就直说，别偷偷退化成屏幕录制——
      // 屏幕录制要放大这块画面、清晰度还受窗口限制，用户会以为"点了录制就全屏了"。
      if (!streamUrl) {
        const err = '没抓到这个房间的直播流地址，先用「⟳ 重载」刷新房间，等画面出来再点开始'
        this.rlog('record refused: no stream url', { label: params.label, uid: params.uid })
        this.notice(`「${params.label || params.uid || '房间'}」${err}`)
        return { ok: false, error: err }
      }
      if (this.countByMode('stream') >= MAX_STREAM_RECORDINGS) {
        return { ok: false, error: `直录流最多同时 ${MAX_STREAM_RECORDINGS} 路` }
      }
      // 虎牙的直录流要带 Referer: https://www.huya.com/，否则 403；地址由渲染层从页面签名里取
      return this.startStream({ ...params, streamUrl, referer: params.referer || streamInfo.referer }, key)
    }

    if (this.screenAct) {
      const who = this.screenAct.label || this.screenAct.uid || '其它房间'
      const err = `「${who}」正在屏幕录制中，屏幕/整窗录制同一时间只能 1 路 —— 先点它的「■ 结束」再录这个`
      this.rlog('screen record rejected', { who, reason: 'screen slot busy', want: params.label })
      this.notice(err)
      return { ok: false, error: err }
    }
    return this.startScreen(params, key)
  }

  /* ------------------------------ stream 模式 ------------------------------ */

  /**
   * 一次"录制会话"= 一个目录 + 若干 part 文件。
   *
   * 为什么要分 part：原来整场录制是一个巨大的 mkv，进程被强杀/断电时尾部就废了，
   * 而且重启后还得从 5GB 的 mkv 全量封装。现在按 segmentMs（默认 5 分钟）切段，
   * 每段都是独立完整的 mkv：崩了最多丢最后这一小段，前面几段随时可封装、可合并。
   *
   * 断流自动续录时沿用同一个会话目录（part 编号继续往后排），
   * 所以整场录制最终还是自动合成一个 mp4。
   */
  /**
   * 每次录制的目录：`<录制目录>/<直播间名>_<开始时间戳>/`，分段和成片都放在这里。
   *
   * 放录制目录而不是 %TEMP%，是为了"录了什么、在哪一段"一眼能看见，
   * 崩溃留下的分段也不会躺在系统临时目录里被清理掉。
   */
  sessionDirFor(label, startedAt) {
    return path.join(this.outDir, `${label}_${stamp(new Date(startedAt))}`)
  }

  /** 会话目录里的 part 文件（按编号排序） */
  listParts(dir) {
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => /^part\d{3,}\.(mkv|mp4)$/i.test(f))
        .sort()
        .map((f) => path.join(dir, f))
    } catch {
      return []
    }
  }

  /** part 编号从几开始（续录时接着上一段往后编号） */
  nextPartIndex(dir) {
    const parts = this.listParts(dir)
    let max = -1
    for (const p of parts) {
      const m = path.basename(p).match(/^part(\d+)/i)
      if (m) max = Math.max(max, Number(m[1]))
    }
    return max + 1
  }

  /** part 总体积（卡死检测用） */
  partsBytes(dir) {
    let n = 0
    for (const p of this.listParts(dir)) {
      try {
        n += fs.statSync(p).size
      } catch {}
    }
    return n
  }

  startStream(params, key, opts = {}) {
    fs.mkdirSync(this.tmpDir, { recursive: true })
    fs.mkdirSync(this.outDir, { recursive: true })
    // 自动续录是绕过 start() 直接调进来的，看门狗（磁盘保底）要自己拉起来
    this.startWatchdog()

    const label = sanitize(params.label || params.uid || 'room')
    const startedAt = Number(opts.sessionStartedAt) || Date.now()
    const dir = opts.dir || this.sessionDirFor(label, startedAt)
    fs.mkdirSync(dir, { recursive: true })
    const partIndex = this.nextPartIndex(dir)
    const pattern = path.join(dir, `part%0${PART_PAD}d.mkv`)

    const args = [
      '-y',
      '-user_agent',
      UA,
      '-headers',
      `Referer: ${params.referer || 'https://live.douyin.com/'}\r\n`,
      '-i',
      params.streamUrl
    ]

    // 录制永远是纯转封装（零转码）：水印放到「剪辑」页签做，
    // 录制阶段重编码会白烧 CPU，而且水印要改一次就得重录一遍。
    args.push('-c', 'copy')

    const segmentSec = Math.round(this.segmentMs / 1000)
    if (segmentSec > 0) {
      args.push(
        '-f',
        'segment',
        '-segment_time',
        String(segmentSec),
        '-segment_format',
        'matroska',
        '-reset_timestamps',
        '1',
        '-segment_start_number',
        String(partIndex),
        pattern
      )
    } else {
      args.push('-f', 'matroska', path.join(dir, `part${String(partIndex).padStart(PART_PAD, '0')}.mkv`))
    }

    const child = spawn(this.ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    /** 最近一次从 ffmpeg 进度行里读到的录制时长（秒）+ 读到的时刻 */
    let lastProgressSec = 0
    const progress = { sec: 0, at: Date.now() }
    child.stderr.on('data', (d) => {
      const chunk = d.toString()
      stderr += chunk
      if (stderr.length > 8000) stderr = stderr.slice(-8000)
      // ffmpeg 每次进度都会打 `time=00:00:11.31`。文件大小在文件被占用时 Windows 不一定更新，
      // 所以卡死检测改用这个进度值——它才是"真的在录"的证据。
      const m = [...chunk.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)].pop()
      if (m) {
        const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
        if (sec > lastProgressSec + 0.05) {
          lastProgressSec = sec
          progress.sec = sec
          progress.at = Date.now()
        }
      }
    })

    const act = {
      mode: 'stream',
      key,
      uid: params.uid || '',
      label,
      startedAt,
      dir,
      /** 这一次 ffmpeg 尝试的启动时刻（判断"只录了几秒就结束"用） */
      attemptStartedAt: Date.now(),
      /** 这次用的地址类型（flv / m3u8 / hls-分片），日志和报错要用 */
      urlKind: (() => {
        const u = String(params.streamUrl || '')
        if (/\.flv(\?|$)/i.test(u)) return 'flv'
        if (/\.m3u8(\?|$)/i.test(u)) return 'm3u8'
        return 'hls-分片'
      })(),
      /** 这次尝试开始时目录里已有的字节数（判断"这次一个字节都没收到"用） */
      startBytes: this.partsBytes(dir),
      mkvPath: path.join(dir, `part${String(partIndex).padStart(PART_PAD, '0')}.mkv`),
      child,
      stderr: () => stderr,
      /** ffmpeg 的录制进度（秒 + 时刻），卡死检测用 */
      progress,
      /** 重连用：原始参数 + 这次用的地址 */
      params: { ...params },
      webContentsId: params.webContentsId || '',
      streamUrl: params.streamUrl,
      /** 本次会话已经试过但连不通的地址 / 线路（换线用，跨尝试保留） */
      triedUrls: Array.isArray(opts.triedUrls) ? opts.triedUrls.slice() : [],
      triedLines: Array.isArray(opts.triedLines) ? opts.triedLines.slice() : [],
      /** 已经自动续录过几次 */
      retries: Number(opts.retries) || 0,
      /** 这一场一共拉了几次流（用于提示"已保存 N 段"） */
      segments: Number(opts.segments) || 1,
      durationCapped: false
    }
    this.actives.set(key, act)
    this.armDurationTimer(act)

    child.on('close', (code) => {
      // 正常停止由 stopStream 触发 finishStream；异常退出在这里兜底
      if (!act.stopping && this.actives.get(act.key) === act) {
        this.rlog('stream ffmpeg exited unexpectedly', { label: act.label, code, url: String(act.streamUrl).slice(0, 90), tail: stderr.slice(-200) })
        this.handleStreamBreak(act, code, stderr).catch((err) => this.rlog('handleStreamBreak failed', err && err.message))
      }
    })

    this.rlog('stream record start', {
      label: act.label,
      retries: act.retries,
      segments: act.segments,
      partIndex,
      segmentSec,
      url: String(params.streamUrl).slice(0, 90),
      concurrent: this.actives.size
    })
    this.broadcast()
    return { ok: true, mode: 'stream', uid: act.uid, dir: act.dir }
  }

  /**
   * 直播流断了（ffmpeg 自己退出，不是用户点停止）。
   *
   * 实测背景：用户连续两段录制分别只录到 15:26 / 16:09 就没了，
   * 而瓦片里的画面一直在播——说明断的是 ffmpeg 这一条长连接，不是房间下播。
   *
   * 现在断流不再立刻合成 mp4：已经封好的 part 就躺在会话目录里（安全），
   * 直接用最新地址往同一个会话目录里续录；只有彻底放弃或用户停止时才合并成 mp4。
   */
  async handleStreamBreak(act, code, stderr) {
    clearTimeout(act.maxTimer)
    this.actives.delete(act.key)
    if (!this.actives.size) this.stopWatchdog()
    if (act.durationCapped || act.stopping) {
      await this.finalizeSession(act, { broke: true })
      return
    }

    const parts = this.listParts(act.dir)
    const bytes = this.partsBytes(act.dir)
    this.rlog('stream broke', { label: act.label, code, parts: parts.length, bytes })

    const retries = act.retries || 0
    const segments = act.segments || 1
    const giveUp = (why) => {
      const saved = parts.length ? `（本次已保存 ${parts.length} 个分段，正在合并…）` : ''
      this.notice(`「${act.label}」${why}，录制已停止${saved}`)
      this.finalizeSession(act, { broke: true }).catch((err) => this.rlog('finalize after break failed', err && err.message))
    }

    if (retries >= MAX_STREAM_RETRIES) {
      this.rlog('stream retries exhausted', { label: act.label, retries, segments })
      giveUp(`流断了，自动续录 ${retries} 次仍失败`)
      return
    }

    /**
     * 换一条候选线路重开（不计入 retries）：虎牙实测三条线路里有的直接 403、
     * 有的能连但只吐半秒就 EOF，得多试几条；抖音也有多 CDN 候选。
     * 试过的地址记在 act.triedUrls 里，全试完 nextCandidateUrl 返回 null。
     */
    const tryNextLine = (reason) => {
      const next = this.nextCandidateUrl(act)
      if (!next) return false
      const triedUrls = [...(act.triedUrls || []), act.streamUrl]
      const triedLines = [...(act.triedLines || []), this.lineKeyOf(act.streamUrl), next.lineKey]
      this.rlog('stream url failed, trying alternate line', {
        label: act.label,
        reason,
        nextLine: next.line,
        kind: next.kind,
        tried: triedLines.length,
        url: next.url.slice(0, 90)
      })
      const timer = setTimeout(() => {
        this.pendingResumes.delete(act.key)
        if (this.actives.has(act.key)) return
        try {
          this.startStream({ ...act.params, streamUrl: next.url, referer: next.referer || act.params.referer }, act.key, {
            retries: act.retries || 0,
            segments: act.segments || 1,
            dir: act.dir,
            sessionStartedAt: act.startedAt,
            triedUrls,
            triedLines
          })
        } catch (err) {
          this.rlog('alternate line start failed', err && err.message)
          giveUp('这个房间的直录流线路都连不上（403 / 只吐半秒就断），可以重载房间后再试')
        }
      }, 1200)
      act.resumeTimer = timer
      this.pendingResumes.set(act.key, timer)
      this.notice(`「${act.label}」这条线路连不通（${reason}），正在换下一条线路重试…`)
      return true
    }

    // 这一次一个字节都没收到 → 这个地址不通（虎牙/抖音都有"某些 CDN 线路直接 403"的情况）。
    // 先试同一房间的其它候选地址（其它 CDN 线路），全都试过了才放弃。
    const wroteNothing = this.partsBytes(act.dir) === (act.startBytes || 0)
    if (wroteNothing) {
      if (tryNextLine('403/无数据')) return
      this.rlog('stream wrote nothing this attempt, give up', { label: act.label, dir: act.dir, tried: (act.triedUrls || []).length })
      giveUp('这个房间的直录流线路都连不上（可能已失效或房间刚下播），可以重载房间后再试')
      return
    }

    // 这次只录到很短一截就"正常结束"（退出码 0）→ 这个地址不是可持续拉的直播流
    // （抖音典型：`pull-hls-.../<数字>` 这种单个分片录 4 秒就 EOF；
    //   虎牙典型：某条线路连上就吐半秒然后服务端主动断）。
    const attemptMs = Date.now() - (act.attemptStartedAt || act.startedAt || Date.now())
    if (code === 0 && attemptMs < 15000) {
      const urlKind = /\.flv(\?|$)/i.test(String(act.streamUrl)) ? 'flv' : /\.m3u8(\?|$)/i.test(String(act.streamUrl)) ? 'm3u8' : 'hls-分片'
      if (tryNextLine(`${Math.round(attemptMs / 1000)} 秒就 EOF`)) return
      this.rlog('stream address not seekable/live, give up', { label: act.label, attemptMs, urlKind, url: String(act.streamUrl).slice(0, 90) })
      giveUp(
        `这个流地址只持续了 ${Math.round(attemptMs / 1000)} 秒就结束了（地址类型：${urlKind}），不是可连续拉的直播流。点这个房间的「⟳」重载后重新录制试试`
      )
      return
    }

    const url = this.streamUrlFor(act.webContentsId) || act.streamUrl
    if (!url) {
      giveUp('流断了，没有可用的流地址（房间可能已下播）')
      return
    }

    const wait = Math.min(RETRY_BASE_MS * Math.pow(2, retries), 30000)
    this.rlog('stream will resume', { label: act.label, inMs: wait, attempt: retries + 1, dir: act.dir })
    this.notice(`「${act.label}」流断了，${Math.round(wait / 1000)} 秒后自动续录（第 ${retries + 1} 次），前 ${parts.length} 个分段已落盘`)

    const timer = setTimeout(() => {
      this.pendingResumes.delete(act.key)
      if (this.actives.has(act.key)) return // 期间用户又手动开录了，别抢
      try {
        this.startStream({ ...act.params, streamUrl: url }, act.key, {
          retries: retries + 1,
          segments: segments + 1,
          dir: act.dir,
          sessionStartedAt: act.startedAt
        })
      } catch (err) {
        this.rlog('resume startStream failed', err && err.message)
        this.notice(`「${act.label}」续录启动失败：${err && err.message}`)
        this.finalizeSession(act, { broke: true }).catch(() => {})
      }
    }, wait)
    act.resumeTimer = timer
    this.pendingResumes.set(act.key, timer)
  }

  /** 让 ffmpeg 正常收尾退出（不合并）—— 分段/停止都先走这里 */
  async haltStreamChild(act, timeoutMs = 5000) {
    if (!act || !act.child) return
    act.stopping = true
    await new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve()
      }
      act.child.once('close', finish)
      try {
        act.child.stdin.write('q')
        act.child.stdin.end()
      } catch {}
      setTimeout(() => {
        try {
          if (!done) act.child.kill('SIGKILL')
        } catch {}
        setTimeout(finish, 800)
      }, timeoutMs)
    })
  }

  async stopStream(act) {
    if (!act || act.mode !== 'stream') return
    await this.haltStreamChild(act)
    await this.finalizeSession(act, {})
  }

  /**
   * 「分段」：结束当前这一大段（立刻出成片），同时用新目录接着录，不中断录制。
   *
   * 顺序很关键——先把新的一段拉起来，再去合并旧的一段：
   *   1) 记下这次用的流地址
   *   2) 让旧 ffmpeg 正常退出（'q'，很快）
   *   3) 立刻用新目录 + 新时间戳起新 ffmpeg（这一步的耗时才是"间隙"）
   *   4) 在后台把旧目录的分段合并成 mp4
   * 这样合并那几秒不会占用录制时间。
   */
  async split(uid) {
    const key = String(uid || '')
    const act = key ? this.actives.get(key) : null
    if (!act) return { ok: false, error: '这个房间没有在录制' }

    if (act.mode === 'stream') {
      const url = this.streamUrlFor(act.webContentsId) || act.streamUrl
      const oldDir = act.dir
      const segments = (act.segments || 1) + 1
      this.rlog('split requested', { label: act.label, dir: oldDir, segments })

      await this.haltStreamChild(act, 4000)

      // 新的一段：新目录、新时间戳，续录计数继续往上加
      let started = null
      try {
        started = this.startStream({ ...act.params, streamUrl: url }, key, { segments })
      } catch (err) {
        this.rlog('split restart failed', { err: err && err.message })
        // 新的一段没起来，至少把旧的存下来
        this.finalizeSession(act, { split: true }).catch(() => {})
        return { ok: false, error: `分段后重新开始录制失败：${err && err.message}（上一段已保存）` }
      }

      // 后台合并上一段
      this.finalizeSession(act, { split: true }).catch((err) => this.rlog('finalize after split failed', err && err.message))
      const newDir = started && started.dir ? started.dir : ''
      this.notice(`「${act.label}」已分段，新的一段开始录（第 ${segments} 段）`)
      return { ok: true, mode: 'stream', oldDir, newDir, segments }
    }

    // 屏幕/整窗录制：也是"停掉当前 MediaRecorder → 立刻开新的"，中间走同一个隐形窗口
    return this.splitScreen(act)
  }

  /**
   * 把会话目录里的所有 part 合并成一个 mp4，mp4 就放在同一个会话目录里，然后删掉分段。
   * 只有一个 part 时直接封装（纯 copy，快），多个时用 concat 解复用器串起来。
   *
   * 目录结构长这样：
   *   <录制目录>/<直播间名>_<开始时间戳>/
   *       part000.mkv part001.mkv …        ← 录制中
   *       <直播间名>_<开始时间戳>.mp4        ← 合成后（分段删掉，目录保留）
   */
  async finalizeSession(act, { broke, split } = {}) {
    if (!act || act.mode !== 'stream') return
    clearTimeout(act.maxTimer)
    // 只摘掉自己：分段时新的一段已经用同一个 key 注册进来了，不能把它顺手删了
    if (this.actives.get(act.key) === act) this.actives.delete(act.key)
    if (!this.actives.size) this.stopWatchdog()

    const parts = this.listParts(act.dir)
    const bytes = this.partsBytes(act.dir)
    if (!parts.length || bytes < 10 * 1024) {
      this.rlog('stream recording too small', { dir: act.dir, parts: parts.length, bytes })
      // 空目录也清掉，别在录制目录里留一堆没用的空文件夹
      try {
        for (const p of parts) fs.unlinkSync(p)
        if (fs.readdirSync(act.dir).length === 0) fs.rmdirSync(act.dir)
      } catch {}
      this.broadcast()
      if (!split) this.onState({ phase: 'failed', uid: act.uid, error: `流录制失败或数据过少（分段在 ${act.dir}）` })
      return
    }

    // 「保留分段」模式：不合并、不删除，直接把 part000N.mkv 留给用户
    if (this.keepParts) {
      try {
        fs.writeFileSync(
          path.join(act.dir, KEEP_PARTS_MARKER),
          JSON.stringify({ label: act.label, startedAt: act.startedAt, parts: parts.length, bytes, keptAt: Date.now() }, null, 2)
        )
      } catch {}
      this.rlog('stream record kept parts', { dir: act.dir, parts: parts.length, bytes })
      this.broadcast({ lastFile: act.dir })
      if (!split) this.onState({ phase: 'done', uid: act.uid, path: act.dir })
      this.notice(
        `「${act.label}」已保留 ${parts.length} 个分段（未合并）：${path.basename(act.dir)}\\part0000.mkv… 共 ${this.fmtGB(bytes)}`
      )
      return
    }

    this.broadcast({ converting: act.uid })
    const base = path.basename(act.dir)
    const mp4Path = path.join(act.dir, `${base}.mp4`)
    try {
      await this.mergeParts(parts, mp4Path, {})
      for (const p of parts) {
        try {
          fs.unlinkSync(p)
        } catch {}
      }
      this.rlog('stream record done', { mp4: mp4Path, bytes, parts: parts.length, brokeEarly: !!broke, split: !!split })
      this.broadcast({ lastFile: mp4Path })
      if (!split) this.onState({ phase: 'done', uid: act.uid, path: mp4Path })
      this.notice(
        `「${act.label}」${split ? '已分段保存' : '录制已保存'}：${base}/${base}.mp4（${this.fmtGB(bytes)}${parts.length > 1 ? `，${parts.length} 个分段合并` : ''}）`
      )
    } catch (err) {
      this.rlog('finalize failed', { err: err && err.message, dir: act.dir, parts: parts.length })
      this.broadcast()
      this.onState({ phase: 'failed', uid: act.uid, error: `封装失败，原始分段在 ${act.dir}` })
      this.notice(`「${act.label}」录制封装失败：${err && err.message}（分段保留在 ${act.dir}）`)
    }
  }

  /**
   * 把多个 mkv 拼成一个 mp4。
   * 一个文件 → 直接封装；多个 → concat 解复用器（要求编码参数一致，同一场录制天然一致）。
   */
  mergeParts(parts, mp4Path, opts = {}) {
    if (!parts.length) return Promise.reject(new Error('没有可合并的文件'))
    if (parts.length === 1) return this.remuxToMp4(parts[0], mp4Path, opts)

    const listPath = path.join(path.dirname(parts[0]), `concat-${Date.now()}.txt`)
    const body = parts.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n')
    fs.writeFileSync(listPath, body + '\n', 'utf8')
    return this.runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', mp4Path])
      .catch((err) => {
        // 多段拼接失败（比如中途质量档变了导致编码参数不同）→ 退一步逐段转成 ts 再拼
        this.rlog('concat failed, fallback to simple merge', { err: err && err.message, parts: parts.length })
        throw err
      })
      .finally(() => {
        try {
          fs.unlinkSync(listPath)
        } catch {}
      })
  }

  /**
   * 用户手动合并任意几个录像文件（输出放在第一个文件所在的目录）。
   * 传了 watermark 就「合并 + 打水印一步做完」——解码、拼接、画水印、重新编码只跑一遍。
   */
  async mergeRecordings({ files, name, watermark } = {}) {
    const picked = (Array.isArray(files) ? files : []).map((f) => path.resolve(String(f))).filter((f) => fs.existsSync(f))
    if (picked.length < 2) return { ok: false, error: '至少选两个文件' }
    const wantWm = !!watermark && watermark.on !== false
    // ⚠️ 不能按"勾选顺序"拼：全选时列表是按时间倒序渲染的，照那个顺序拼会得到一段倒放的视频。
    // 统一按「修改时间升序 + 文件名」排，这才是录制发生的时间顺序。
    const list = sortByTime(picked)
    // 默认文件名 = 这些文件所在目录的名字（<主播>_<时间戳>），这样和普通录制的成片命名一致
    const base = (name || '').trim() || this.defaultMergeName(list)
    const outDir = path.dirname(list[0])
    // 不覆盖已有同名成片：撞名就加 _合并 后缀
    let out = path.join(outDir, `${sanitize(base)}.mp4`)
    if (fs.existsSync(out)) {
      let n = 0
      do {
        n += 1
        out = path.join(outDir, `${sanitize(base)}_合并${n > 1 ? n : ''}.mp4`)
      } while (fs.existsSync(out) && n < 50)
    }
    this.rlog('manual merge start', { out, files: list.length, watermark: wantWm, order: list.map((p) => path.basename(p)) })

    try {
      if (wantWm) {
        await this.concatWithWatermark(list, out, watermark)
      } else {
        await this.concatCopy(list, out)
      }
      const size = (() => {
        try {
          return fs.statSync(out).size
        } catch {
          return 0
        }
      })()
      this.rlog('manual merge done', { out, files: list.length, bytes: size, watermark: wantWm })
      this.broadcast({ lastFile: out })
      this.notice(`已合并 ${list.length} 个文件${wantWm ? '并加水印' : ''} → ${path.basename(out)}（${this.fmtGB(size)}）`)
      return { ok: true, path: out, size }
    } catch (err) {
      try {
        fs.unlinkSync(out)
      } catch {}
      this.rlog('manual merge failed', { err: err && err.message, files: list.length })
      return { ok: false, error: `合并失败：${err && err.message}（选中的文件编码参数要一致）` }
    }
  }

  /** concat 解复用器拼接（纯 copy，不重编码） */
  concatCopy(list, out) {
    const listPath = path.join(path.dirname(out), `.concat-${Date.now()}.txt`)
    const body = list.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n')
    fs.writeFileSync(listPath, body + '\n', 'utf8')
    return this.runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', out]).finally(
      () => {
        try {
          fs.unlinkSync(listPath)
        } catch {}
      }
    )
  }

  /**
   * 合并 + 打水印，一遍做完（重编码）。
   *
   * 用 concat 滤镜把各段接起来（v=1:a=1），再接水印滤镜图，最后编一次：
   *   [0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[cv][ca]; [cv]drawtext=...[t]; [t]null[vout]
   * 这样只有一次解码/编码，比"先合并再加水印"少跑一遍，质量也少损失一次。
   * 代价：音频也得跟着重编码（concat 滤镜输出的是未压缩帧），所以 -c:a aac。
   */
  async concatWithWatermark(list, out, rawWm) {
    const size = await this.probeVideoSize(list[0])
    const wm = { ...this.watermark, ...rawWm, on: true }
    const n = list.length
    // logo 是第 n 路输入（0..n-1 是视频）
    const graph = this.buildWatermarkFilters(wm, { videoWidth: size && size.width, inLabel: 'cv', imageIndex: n })
    if (!graph) throw new Error('水印内容为空（文字和图片都没设置）')

    const args = ['-y']
    for (const f of list) args.push('-i', f)
    if (graph.imageInput) args.push('-i', graph.imageInput)

    const pairs = list.map((_, i) => `[${i}:v][${i}:a]`).join('')
    const concat = `${pairs}concat=n=${n}:v=1:a=1[cv][ca]`
    args.push('-filter_complex', `${concat};${graph.filter}`)
    args.push('-map', '[vout]', '-map', '[ca]')
    args.push(...this.encoderArgs(wm))
    args.push('-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out)
    this.rlog('merge with watermark', { out, files: n, mode: wm.mode, motion: wm.motion, encoder: wm.encoder, filter: `${concat};${graph.filter}` })
    return this.runFfmpeg(args)
  }

  /**
   * 给已有的视频加水印（重编码）。
   * firstN > 0 时只处理排序后的前 N 个文件（"只给前几个片段加水印"）。
   * @param {{files?: string[], name?: string, watermark?: object}} payload
   */
  async applyWatermark({ files, name, watermark } = {}) {
    const all = (Array.isArray(files) ? files : []).map((f) => path.resolve(String(f))).filter((f) => fs.existsSync(f))
    if (!all.length) return { ok: false, error: '先选要加水印的文件' }
    const wm = this.normWatermark({ ...this.watermark, ...(watermark || {}), on: true })

    // "前 N 个"要可预测：按文件名排序（part0000 < part0001 …），不按点击顺序
    const sorted = [...all].sort((a, b) => path.basename(a).localeCompare(path.basename(b), 'zh-Hans-CN'))
    const list = wm.firstN > 0 ? sorted.slice(0, wm.firstN) : sorted
    const skipped = sorted.length - list.length

    let outName = (name || '').trim()
    const outputs = []
    for (const input of list) {
      // 图片水印要按画面宽度的比例缩放，所以先量一下这个视频多宽
      const size = await this.probeVideoSize(input)
      const graph = this.buildWatermarkFilters(wm, { videoWidth: size && size.width })
      if (!graph) return { ok: false, error: '水印内容为空（文字和图片都没设置）' }

      const dir = path.dirname(input)
      const base = outName || `${path.basename(input, path.extname(input))}_水印`
      const out = path.join(dir, `${sanitize(base)}.mp4`)
      this.notice(`正在给 ${path.basename(input)} 加水印（重编码，慢一点）…`)
      const args = ['-y', '-i', input]
      if (graph.imageInput) args.push('-i', graph.imageInput)
      args.push('-filter_complex', graph.filter, '-map', '[vout]', '-map', '0:a?')
      args.push(...this.encoderArgs(wm), '-c:a', 'copy', '-movflags', '+faststart', out)
      this.rlog('watermark apply', {
        input,
        out,
        mode: wm.mode,
        motion: wm.motion,
        encoder: wm.encoder,
        firstN: wm.firstN,
        videoWidth: size && size.width
      })
      try {
        await this.runFfmpeg(args)
        outputs.push(out)
      } catch (err) {
        this.rlog('watermark failed', { input, err: err && err.message })
        return { ok: false, error: `加水印失败：${err && err.message}`, outputs, skipped }
      }
    }
    if (outputs.length) {
      this.notice(
        `水印完成 ${outputs.length} 个${skipped > 0 ? `（按「只加前 ${wm.firstN} 个」跳过了 ${skipped} 个）` : ''}：${outputs.map((p) => path.basename(p)).join('、')}`
      )
      this.broadcast({ lastFile: outputs[outputs.length - 1] })
    }
    return { ok: true, outputs, skipped, total: sorted.length }
  }

  /** 系统里可用的中文字体（给水印字体下拉用） */
  listFonts() {
    const cands = [
      { label: '微软雅黑', path: 'C:\\Windows\\Fonts\\msyh.ttc' },
      { label: '微软雅黑 粗体', path: 'C:\\Windows\\Fonts\\msyhbd.ttc' },
      { label: '微软雅黑 细体', path: 'C:\\Windows\\Fonts\\msyhl.ttc' },
      { label: '黑体', path: 'C:\\Windows\\Fonts\\simhei.ttf' },
      { label: '宋体', path: 'C:\\Windows\\Fonts\\simsun.ttc' },
      { label: '楷体', path: 'C:\\Windows\\Fonts\\simkai.ttf' },
      { label: '仿宋', path: 'C:\\Windows\\Fonts\\simfang.ttf' },
      { label: '等线', path: 'C:\\Windows\\Fonts\\Deng.ttf' },
      { label: '等线 粗体', path: 'C:\\Windows\\Fonts\\Dengb.ttf' },
      { label: 'Consolas', path: 'C:\\Windows\\Fonts\\consola.ttf' },
      { label: 'Arial', path: 'C:\\Windows\\Fonts\\arial.ttf' },
      { label: 'Arial Black', path: 'C:\\Windows\\Fonts\\ariblk.ttf' },
      { label: 'Impact', path: 'C:\\Windows\\Fonts\\impact.ttf' },
      { label: 'Times New Roman', path: 'C:\\Windows\\Fonts\\times.ttf' }
    ]
    const fonts = cands
      .map((c) => ({ ...c, exists: (() => { try { return fs.existsSync(c.path) } catch { return false } })() }))
      .filter((c) => c.exists)
    return { ok: true, fonts, current: this.fontPath }
  }


  /**
   * 录制目录（或指定目录）里的文件清单。
   * 新版目录结构：`<目录>/<主播>_<时间戳>/xxx.mp4`，所以要看一层子目录。
   */
  listRecordings(dir) {
    const root = dir ? path.resolve(String(dir)) : this.outDir
    const files = []
    const push = (full, groupName) => {
      try {
        const st = fs.statSync(full)
        if (!st.isFile()) return
        if (!/\.(mp4|mkv|webm|flv|ts|mov)$/i.test(full)) return
        files.push({
          path: full,
          name: path.basename(full),
          group: groupName || '',
          rel: path.relative(root, full).replace(/\\/g, '/'),
          size: st.size,
          mtime: st.mtimeMs
        })
      } catch {}
    }

    let entries = []
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      return { ok: false, error: `目录不存在：${root}`, files: [], dir: root }
    }
    for (const e of entries) {
      const full = path.join(root, e.name)
      if (e.isDirectory()) {
        let inner = []
        try {
          inner = fs.readdirSync(full, { withFileTypes: true })
        } catch {}
        const parts = this.listParts(full)
        for (const f of inner) if (f.isFile()) push(path.join(full, f.name), e.name)
        if (parts.length) {
          const bytes = parts.reduce((n, p) => {
            try {
              return n + fs.statSync(p).size
            } catch {
              return n
            }
          }, 0)
          // 还在录的 → 不可选；已保留（有标记）的 → 可以把这些 part 选起来合并
          const recordingNow = [...this.actives.values()].some((a) => a.dir === full)
          const kept = fs.existsSync(path.join(full, KEEP_PARTS_MARKER))
          if (recordingNow) {
            files.push({
              path: parts[0],
              name: `（录制中）${parts.length} 个分段`,
              group: e.name,
              rel: path.relative(root, full).replace(/\\/g, '/'),
              size: bytes,
              mtime: Date.now(),
              pending: true,
              parts
            })
          } else if (!kept) {
            // 既没在录、也没有"保留"标记 → 崩溃残留，提示一下（启动恢复会处理）
            files.push({
              path: parts[0],
              name: `（待恢复）${parts.length} 个分段`,
              group: e.name,
              rel: path.relative(root, full).replace(/\\/g, '/'),
              size: bytes,
              mtime: Date.now(),
              pending: true,
              parts
            })
          }
          // kept 的情况：上面的 for 循环已经把每个 part 单独列出来了，可多选后再合并
        }
      } else {
        push(full, '')
      }
    }
    // 先按目录分组、组内再按时间倒序：这样同一个目录里的「合并后的成片」和「合并前的分段」
    // 在列表里一定挨在一起，不会被别的目录的文件插到中间
    files.sort((a, b) => {
      const ga = a.group || '\uffff'
      const gb = b.group || '\uffff'
      if (ga !== gb) return ga.localeCompare(gb, 'zh-Hans-CN')
      return b.mtime - a.mtime
    })
    // 标出"这就是本目录的成片"（<目录名>/<目录名>.mp4）
    for (const f of files) {
      if (!f.group) continue
      if (path.basename(f.path, path.extname(f.path)) === f.group) f.isOutput = true
    }
    return { ok: true, files, dir: root }
  }

  /** 合并输出的默认文件名：同目录名（<主播>_<时间戳>），拿不到就用第一个文件名 */
  defaultMergeName(list) {
    const first = list[0]
    if (!first) return `合并_${stamp()}`
    const dir = path.dirname(first)
    const dirName = path.basename(dir)
    // 文件在录制目录根上（没有自己的子目录）时，退回"第一个文件名_合并"
    if (path.resolve(dir) === path.resolve(this.outDir)) {
      return `${path.basename(first, path.extname(first))}_合并`
    }
    return dirName
  }

  /** 通用的 ffmpeg 执行（合并 / 封装共用） */
  runFfmpeg(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.ffmpeg, args, { windowsHide: true })
      let stderr = ''
      child.stderr.on('data', (d) => {
        stderr += d.toString()
        if (stderr.length > 8000) stderr = stderr.slice(-8000)
      })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve(true)
        else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-300)}`))
      })
    })
  }

  /* ------------------------------ 水印 ------------------------------ */

  /**
   * 水印配置（可定制）：
   *   on        开关
   *   mode      text（文字）| image（图片/logo）| both
   *   text      文字内容
   *   font      字体路径（默认自动找系统 CJK 字体）
   *   size      字号（像素）
   *   color     文字颜色 #RRGGBB
   *   opacity   透明度 0–1
   *   pos       九宫格 tl|tc|tr|ml|mc|mr|bl|bc|br
   *   margin    边距
   *   shadow    是否加阴影
   *   image     图片路径（png/jpg，png 支持透明）
   *   imageScale 图片宽度占画面的比例（0.05–0.5）
   *   fromSec/toSec 只在某段时间显示（留空=全程）
   */
  normWatermark(wm = {}) {
    const base = this.watermark || {}
    const w = { ...base, ...wm }
    return {
      on: !!w.on,
      mode: ['text', 'image', 'both'].includes(w.mode) ? w.mode : 'text',
      text: String(w.text || ''),
      font: w.font || this.fontPath,
      size: Math.max(8, Math.min(200, Number(w.size) || 28)),
      color: /^#[0-9a-f]{6}$/i.test(String(w.color || '')) ? String(w.color) : '#FFFFFF',
      opacity: Math.max(0.05, Math.min(1, Number(w.opacity) || 0.85)),
      pos: ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'].includes(w.pos) ? w.pos : 'br',
      margin: Math.max(0, Math.min(200, Number(w.margin) === 0 ? 0 : Number(w.margin) || 20)),
      shadow: w.shadow !== false,
      image: String(w.image || ''),
      imageScale: Math.max(0.03, Math.min(0.6, Number(w.imageScale) || 0.15)),
      fromSec: Number(w.fromSec) > 0 ? Number(w.fromSec) : 0,
      toSec: Number(w.toSec) > 0 ? Number(w.toSec) : 0,
      /** 漂移方式：static 固定 / scroll-x 横向滚动 / scroll-y 纵向滚动 / diagonal 斜向 / bounce 反弹 */
      motion: ['static', 'scroll-x', 'scroll-y', 'diagonal', 'bounce'].includes(w.motion) ? w.motion : 'static',
      /** 漂移速度（像素/秒，反弹模式当作快慢系数） */
      speed: Math.max(5, Math.min(2000, Number(w.speed) || 120)),
      /** 编码器：x264 软件（质量/体积好）或 nvenc 显卡（快一倍） */
      encoder: w.encoder === 'nvenc' ? 'nvenc' : 'x264',
      /** 只给前 N 个文件加水印（0 = 全部） */
      firstN: Math.max(0, Math.min(999, Number(w.firstN) || 0))
    }
  }

  /** 按 motion 生成 drawtext 的 x/y（tw/th = 文字块宽高，t = 秒） */
  textMotionExpr(wm) {
    const S = wm.speed
    switch (wm.motion) {
      case 'scroll-x':
        return [`w-mod(t*${S}\\,w+tw)`, `(h-th)/2`]
      case 'scroll-y':
        return [`(w-tw)/2`, `h-mod(t*${S}\\,h+th)`]
      case 'diagonal':
        return [`w-mod(t*${S}\\,w+tw)`, `h-mod(t*${S * 0.6}\\,h+th)`]
      case 'bounce':
        return [`(w-tw)*abs(sin(t*${(S / 300).toFixed(3)}))`, `(h-th)*abs(cos(t*${(S / 400).toFixed(3)}))`]
      default:
        return null
    }
  }

  /** 按 motion 生成 overlay 的 x/y（W/H = 主画面，w/h = 水印图片） */
  overlayMotionExpr(wm) {
    const S = wm.speed
    switch (wm.motion) {
      case 'scroll-x':
        return [`W-mod(t*${S}\\,W+w)`, `(H-h)/2`]
      case 'scroll-y':
        return [`(W-w)/2`, `H-mod(t*${S}\\,H+h)`]
      case 'diagonal':
        return [`W-mod(t*${S}\\,W+w)`, `H-mod(t*${S * 0.6}\\,H+h)`]
      case 'bounce':
        return [`(W-w)*abs(sin(t*${(S / 300).toFixed(3)}))`, `(H-h)*abs(cos(t*${(S / 400).toFixed(3)}))`]
      default:
        return null
    }
  }

  /** 编码参数：软件 x264 或 显卡 NVENC（NVENC 快一倍左右，实测 60s/1080p：x264 4.1s → nvenc 2.0s） */
  encoderArgs(wm) {
    if (wm && wm.encoder === 'nvenc') {
      return ['-c:v', 'h264_nvenc', '-preset', 'p1', '-b:v', '8M', '-pix_fmt', 'yuv420p']
    }
    return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p']
  }


  /** ffmpeg filter 里转义：反斜杠、冒号、单引号、百分号 */
  escapeFilterText(s) {
    return String(s)
      .replace(/\\/g, '\\\\')
      .replace(/:/g, '\\:')
      .replace(/'/g, '\u2019')
      .replace(/%/g, '\\%')
      .replace(/,/g, '\\,')
  }

  /** 九宫格 → x/y 表达式 */
  /** 九宫格 → drawtext 的 x/y 表达式（tw/th = 文字块的宽高） */
  positionExpr(pos, margin) {
    const m = margin
    const map = {
      tl: [`${m}`, `${m}`],
      tc: ['(w-tw)/2', `${m}`],
      tr: [`w-tw-${m}`, `${m}`],
      ml: [`${m}`, '(h-th)/2'],
      mc: ['(w-tw)/2', '(h-th)/2'],
      mr: [`w-tw-${m}`, '(h-th)/2'],
      bl: [`${m}`, `h-th-${m}`],
      bc: ['(w-tw)/2', `h-th-${m}`],
      br: [`w-tw-${m}`, `h-th-${m}`]
    }
    return map[pos] || map.br
  }

  /** 九宫格 → overlay 的 x/y 表达式（W/H = 主画面，w/h = 水印图片） */
  positionExprOverlay(pos, margin) {
    const m = margin
    const map = {
      tl: [`${m}`, `${m}`],
      tc: ['(W-w)/2', `${m}`],
      tr: [`W-w-${m}`, `${m}`],
      ml: [`${m}`, '(H-h)/2'],
      mc: ['(W-w)/2', '(H-h)/2'],
      mr: [`W-w-${m}`, '(H-h)/2'],
      bl: [`${m}`, `H-h-${m}`],
      bc: ['(W-w)/2', `H-h-${m}`],
      br: [`W-w-${m}`, `H-h-${m}`]
    }
    return map[pos] || map.br
  }

  /** 只显示某段时间的 enable 表达式（ffmpeg 里逗号要转义，否则会被当成 filter 分隔符） */
  watermarkEnable(wm) {
    if (!wm.fromSec && !wm.toSec) return ''
    const cond = [wm.fromSec ? `gte(t\\,${wm.fromSec})` : '1', wm.toSec ? `lte(t\\,${wm.toSec})` : '1'].join('*')
    return `:enable='${cond}'`
  }

  /**
   * 组装水印滤镜图（-filter_complex 用）。
   * @param {object} rawWm 水印配置
   * @param {{videoWidth?: number}} [opts] 画面宽度（图片水印按比例缩放用）
   * @returns {null | { filter: string, imageInput: string }}
   *   filter 输出标签固定为 [vout]；图片水印需要额外一路输入（imageInput）。
   *
   * ⚠️ 图片缩放不能用 scale2ref：ffmpeg 8.1 里它已废弃，实测叠上去的图**完全不可见**
   *    （对比：`[0:v][1:v]overlay` 直接把红色 logo 叠出来 RGB(200,23,19)，
   *    而 scale2ref 版本区域颜色和原片一模一样 RGB(45,89,57)）。
   *    改成先用 ffprobe 量出画面宽度，再按像素 scale，实测可见。
   */
  buildWatermarkFilters(rawWm, opts = {}) {
    const wm = this.normWatermark(rawWm)
    const wantText = (wm.mode === 'text' || wm.mode === 'both') && wm.text.trim() && wm.font
    const wantImage = (wm.mode === 'image' || wm.mode === 'both') && wm.image && fs.existsSync(wm.image)
    if (!wm.on || (!wantText && !wantImage)) return null

    // 输入/输出标签、logo 输入序号都可调——"合并 + 水印一步做"时视频来自 concat 的输出 [cv]
    const inLabel = opts.inLabel || '0:v'
    const outLabel = opts.outLabel || 'vout'
    const imageIndex = Number.isInteger(opts.imageIndex) ? opts.imageIndex : 1

    const hex = wm.color.replace('#', '')
    const enable = this.watermarkEnable(wm)
    const chains = []
    let last = inLabel
    let imageInput = ''

    if (wantText) {
      // 漂移模式优先（位置由 x/y 的时间表达式决定，九宫格位置就不管了）
      const motion = this.textMotionExpr(wm)
      const [x, y] = motion || this.positionExpr(wm.pos, wm.margin)
      const shadow = wm.shadow ? `:shadowcolor=black@${Math.min(1, wm.opacity)}:shadowx=2:shadowy=2` : ''
      chains.push(
        `[${last}]drawtext=fontfile='${this.escapeFilterText(wm.font)}':text='${this.escapeFilterText(wm.text)}'` +
          `:fontcolor=0x${hex}@${wm.opacity}:fontsize=${wm.size}:x='${x}':y='${y}'${shadow}${enable}[t]`
      )
      last = 't'
    }

    if (wantImage) {
      imageInput = wm.image
      const videoWidth = Number(opts.videoWidth) || 1920
      const logoW = Math.max(16, Math.round(videoWidth * wm.imageScale))
      // 按像素缩放（-2 保证高度是偶数），透明通道原样保留
      chains.push(`[${imageIndex}:v]scale=${logoW}:-2:flags=lanczos,format=rgba[logo]`)
      const motion = this.overlayMotionExpr(wm)
      let ix
      let yFinal
      if (motion) {
        ;[ix, yFinal] = motion
      } else {
        const [px, py] = this.positionExprOverlay(wm.pos, wm.margin)
        // 文字和图片在同一角时，图片让开一个字高，别叠在一起
        const bump = wantText && wm.motion === 'static' ? wm.size + 8 : 0
        const bottom = wm.pos === 'br' || wm.pos === 'bc' || wm.pos === 'bl'
        ix = px
        yFinal = bump ? `${py}${bottom ? '-' : '+'}${bump}` : py
      }
      chains.push(`[${last}][logo]overlay=${ix}:${yFinal}:format=auto${enable}[${outLabel}]`)
      return { filter: chains.join(';'), imageInput }
    }

    chains.push(`[${last}]null[${outLabel}]`)
    return { filter: chains.join(';'), imageInput }
  }

  setOptions(opts = {}) {
    if (opts.segmentMs !== undefined) {
      const ms = Number(opts.segmentMs)
      this.segmentMs = Number.isFinite(ms) && ms >= 0 ? ms : this.segmentMs
    }
    if (opts.keepParts !== undefined) this.keepParts = !!opts.keepParts
    if (opts.maxDurationMs !== undefined) {
      const ms = Number(opts.maxDurationMs)
      if (Number.isFinite(ms) && ms >= 0) {
        this.maxDurationMs = ms
        // 已经开着的录制要按新上限重新计时，否则改了设置要等下次录制才生效
        for (const act of this.actives.values()) this.armDurationTimer(act)
      }
    }
    if (opts.minFreeMb !== undefined) {
      const mb = Number(opts.minFreeMb)
      if (Number.isFinite(mb) && mb >= 0) this.minFreeBytes = Math.round(mb * 1024 * 1024)
    }
    if (opts.watermark && typeof opts.watermark === 'object') {
      this.watermark = this.normWatermark({ ...this.watermark, ...opts.watermark })
    }
    return this.getOptions()
  }

  getOptions() {
    return {
      segmentMs: this.segmentMs,
      /** 分段时长可选项（毫秒）：0 表示不分段 */
      segmentChoices: [60, 120, 180, 300, 600, 1800, 0].map((m) => m * 1000),
      keepParts: this.keepParts,
      /** 单次录制时长上限（毫秒，0 = 不限） */
      maxDurationMs: this.maxDurationMs,
      /** 磁盘余量低于这个 MB 数就拒绝开始新录制 */
      minFreeMb: Math.round(this.minFreeBytes / (1024 * 1024)),
      watermark: this.normWatermark(this.watermark),
      font: this.fontPath,
      ffmpeg: Boolean(this.ffmpeg),
      outDir: this.outDir
    }
  }

  /**
   * mkv → mp4 封装（纯 copy，不重编码）。
   *
   * `-tag:v hvc1` 是给 HEVC 用的封装标签（Windows 自带播放器认它），
   * 但抖音有的房间是 H.264，带着这个标签会直接报
   * `Tag hvc1 incompatible with output codec id '27' (avc1)` 而失败——
   * 实测 DOTA情怀(485185918272) 就是这样，一段 5.36GB 的录制一直封装不出来。
   * 所以失败时去掉标签再试一次。
   */
  remuxToMp4(mkvPath, mp4Path, { hevcTag = true } = {}) {
    const run = (tag) =>
      new Promise((resolve, reject) => {
        const args = ['-y', '-i', mkvPath, '-c', 'copy']
        if (tag) args.push('-tag:v', 'hvc1')
        args.push('-movflags', '+faststart', mp4Path)
        const child = spawn(this.ffmpeg, args, { windowsHide: true })
        let stderr = ''
        child.stderr.on('data', (d) => {
          stderr += d.toString()
          if (stderr.length > 8000) stderr = stderr.slice(-8000)
        })
        child.on('error', reject)
        child.on('close', (code) => {
          if (code === 0) resolve(mp4Path)
          else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-300)}`))
        })
      })

    return run(hevcTag).catch((err) => {
      if (hevcTag && /hvc1|incompatible with output codec/i.test(String(err && err.message))) {
        this.rlog('remux retry without hvc1 tag', { mkv: mkvPath, why: String(err && err.message).slice(-120) })
        return run(false)
      }
      throw err
    })
  }

  /* ------------------------------ screen 模式 ------------------------------ */

  ensureWindow() {
    if (this.win && !this.win.isDestroyed()) return this.win

    const ses = session.fromPartition(PARTITION)
    ses.setDisplayMediaRequestHandler((request, callback) => {
      const source = this.pendingSource
      if (!source) {
        callback({})
        return
      }
      callback({ video: source, audio: 'loopback' })
      this.log('display media granted', source.name || source.id)
    })

    this.win = new BrowserWindow({
      show: false,
      width: 640,
      height: 360,
      webPreferences: {
        partition: PARTITION,
        preload: path.join(__dirname, '..', 'recorder', 'recorder-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    this.win.webContents.on('console-message', (e, level, message) => {
      if (String(message).length < 400) this.log('recorder console', level, message)
    })
    // 屏幕录制窗只负责解码 + 转码：它里面那个 <video> 是 muted 的，这里再兜一层静音
    try {
      this.win.webContents.setAudioMuted(true)
    } catch {}
    this.loaded = new Promise((resolve) => {
      this.win.webContents.once('did-finish-load', () => resolve())
    })
    this.win.loadFile(path.join(__dirname, '..', 'recorder', 'recorder.html'))

    const { ipcMain } = require('electron')
    if (!this.ipcWired) {
      this.ipcWired = true
      // 一律按 sessionId 路由：分段时新旧两段会同时在跑，不能靠"当前那一路"猜
      ipcMain.on('rec:ready', (event, info) => this.handleReady(info))
      ipcMain.on('rec:chunk', (event, buf, sid) => this.handleChunk(buf, sid))
      ipcMain.on('rec:done', (event, info) => this.handleDone(info))
      ipcMain.on('rec:fail', (event, msg, sid) => this.handleFail(msg, sid))
    }
    return this.win
  }

  /** 按 sessionId 找屏幕录制的 act */
  screenActBySid(sid) {
    if (!sid) return this.screenAct
    for (const act of this.actives.values()) {
      if (act.mode === 'screen' && act.sid === sid) return act
    }
    for (const act of this.screenActs.values()) if (act.sid === sid) return act
    return null
  }

  /**
   * 起一路屏幕录制（不动 this.actives 之外的窗口）。
   * 分段就是"停一路、再起一路"，两路的 webm 各自写各自的文件。
   */
  beginScreenRecording(params, key, common) {
    fs.mkdirSync(this.tmpDir, { recursive: true })
    fs.mkdirSync(this.outDir, { recursive: true })

    const label = common.label
    const startedAt = common.startedAt || Date.now()
    const sid = `s${startedAt.toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const webmPath = path.join(this.tmpDir, `${label}_${stamp(new Date(startedAt))}_${sid}.webm`)

    const act = {
      mode: 'screen',
      key,
      uid: common.uid || '',
      label,
      startedAt,
      sid,
      webmPath,
      stream: fs.createWriteStream(webmPath),
      bytes: 0,
      ready: false,
      info: null,
      cmd: common.cmd,
      segments: common.segments || 1
    }
    this.actives.set(key, act)
    this.screenAct = act
    this.screenActs.set(sid, act)
    this.armDurationTimer(act)

    const win = this.ensureWindow()
    return Promise.race([this.loaded, new Promise((r) => setTimeout(r, 5000))]).then(() => {
      win.webContents
        .executeJavaScript(`window.__recStart(${JSON.stringify({ ...common.cmd, sessionId: sid })})`, true)
        .catch((err) => this.log('start invoke failed', err && err.message))
      this.rlog('screen record start', { uid: act.uid, label: act.label, sid, rect: common.cmd.rect, segments: act.segments })
      this.broadcast()
      return { ok: true, mode: 'screen', uid: act.uid, sid }
    })
  }

  /** 让屏幕录制这一路停下（不等待转码；转码在 handleDone 里后台跑） */
  async haltScreenRecording(act) {
    if (!act || act.mode !== 'screen') return
    act.stopping = true
    const win = this.win
    if (win && !win.isDestroyed()) {
      try {
        await win.webContents.executeJavaScript('window.__recStop && window.__recStop()', true)
      } catch {}
    }
    // 等 onstop → rec:done；最多等 2 秒
    const deadline = Date.now() + 2000
    while (this.screenActs.has(act.sid) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  async startScreen(params, key) {
    const mainWin = this.getMainWindow()
    if (!mainWin || mainWin.isDestroyed()) return { ok: false, error: '主窗口不可用' }

    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 0, height: 0 }
    })
    const mediaId = mainWin.getMediaSourceId()
    const source = sources.find((s) => s.id === mediaId)
    if (!source) return { ok: false, error: '没找到本窗口的捕获源' }
    this.pendingSource = source

    const label = sanitize(params.label || params.uid || 'tile')
    const cmd = {
      rect: params.rect,
      rects: params.rects || null,
      contentWidth: params.contentWidth,
      contentHeight: params.contentHeight,
      fps: Math.max(5, Math.min(30, Number(params.fps) || 30)),
      bitrate: Number(params.bitrate) || 8_000_000
    }
    this.screenParams = { params: { ...params }, cmd, label, key }
    return this.beginScreenRecording(params, key, { uid: params.uid, label, startedAt: Date.now(), cmd, segments: 1 })
  }

  /** 屏幕/整窗录制的「分段」：停这一路（后台转码），立刻起新的一路 */
  async splitScreen(act) {
    const saved = this.screenParams
    if (!saved) return { ok: false, error: '屏幕录制的参数丢了，请停掉重新开始' }
    const segments = (act.segments || 1) + 1
    this.rlog('screen split requested', { label: act.label, sid: act.sid, segments })
    await this.haltScreenRecording(act)
    try {
      const res = await this.beginScreenRecording(saved.params, saved.key, {
        uid: act.uid,
        label: act.label,
        startedAt: Date.now(),
        cmd: saved.cmd,
        segments
      })
      this.notice(`「${act.label}」已分段，新的一段开始录（第 ${segments} 段）`)
      return { ok: true, mode: 'screen', segments, sid: res.sid }
    } catch (err) {
      return { ok: false, error: `分段后重新开始录制失败：${err && err.message}` }
    }
  }

  handleReady(info) {
    const act = this.screenActBySid(info && info.sid)
    if (!act) return
    act.ready = true
    act.info = info
    this.log('recorder ready', act.sid, JSON.stringify(info))
    if (info && info.cursorMode) this.rlog('screen capture settings', { sid: act.sid, cursor: info.cursorMode, hasAudio: info.hasAudio })
    this.broadcast()
  }

  handleChunk(buf, sid) {
    const act = this.screenActBySid(sid)
    if (!act || !act.stream) return
    const chunk = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
    act.bytes += chunk.length
    act.stream.write(chunk)
  }

  async handleDone(info) {
    const act = this.screenActBySid(info && info.sid)
    if (!act) return
    clearTimeout(act.maxTimer)
    // 只摘自己：分段时新的一段可能已经用同一个 key 占位了
    this.screenActs.delete(act.sid)
    if (this.screenAct === act) this.screenAct = null
    if (this.actives.get(act.key) === act) this.actives.delete(act.key)
    if (!this.actives.size) this.stopWatchdog()
    const wasSplit = !!act.stopping
    if (!wasSplit) this.pendingSource = null

    try {
      act.stream.end()
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
    this.broadcast({ converting: act.uid })

    const dir = path.join(this.outDir, `${act.label}_${stamp(new Date(act.startedAt))}`)
    const mp4Path = path.join(dir, `${act.label}_${stamp(new Date(act.startedAt))}.mp4`)
    try {
      fs.mkdirSync(dir, { recursive: true })
      await this.convertScreen(act.webmPath, mp4Path)
      try {
        fs.unlinkSync(act.webmPath)
      } catch {}
      this.log('screen record done', mp4Path, `${Math.round(act.bytes / 1024)}KB`, info && info.frames ? `${info.frames}f` : '')
      this.rlog('screen record done', { mp4: mp4Path, bytes: act.bytes, split: wasSplit })
      this.broadcast({ lastFile: mp4Path })
      if (!wasSplit) this.onState({ phase: 'done', uid: act.uid, path: mp4Path })
    } catch (err) {
      this.log('convert failed', err && err.message)
      this.rlog('screen convert failed', { err: err && err.message, webm: act.webmPath })
      this.broadcast()
      if (!wasSplit) this.onState({ phase: 'failed', uid: act.uid, error: '转码失败，原始文件在 ' + act.webmPath })
    }
  }

  handleFail(msg, sid) {
    this.log('recorder fail', msg)
    const act = this.screenActBySid(sid)
    if (act) {
      clearTimeout(act.maxTimer)
      try {
        act.stream.end()
      } catch {}
      this.screenActs.delete(act.sid)
      if (this.screenAct === act) this.screenAct = null
      if (this.actives.get(act.key) === act) this.actives.delete(act.key)
      if (!this.actives.size) this.stopWatchdog()
    }
    this.pendingSource = null
    this.broadcast()
    this.onState({ phase: 'failed', uid: act ? act.uid : '', error: msg })
  }

  convertScreen(webmPath, mp4Path) {
    return new Promise((resolve, reject) => {
      const args = [
        '-y',
        '-i',
        webmPath,
        '-vf',
        'pad=ceil(iw/2)*2:ceil(ih/2)*2',
        '-c:v',
        'libx264',
        '-preset',
        'medium',
        '-crf',
        '18',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '160k',
        '-movflags',
        '+faststart',
        mp4Path
      ]
      const child = spawn(this.ffmpeg, args, { windowsHide: true })
      let stderr = ''
      child.stderr.on('data', (d) => {
        stderr += d.toString()
        if (stderr.length > 20000) stderr = stderr.slice(-20000)
      })
      child.on('error', (err) => reject(err))
      child.on('close', (code) => {
        if (code === 0) resolve(mp4Path)
        else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-400)}`))
      })
    })
  }

  /* -------------------------------- 公共 -------------------------------- */

  stop(uid) {
    const key = String(uid || '')
    // 正在等自动续录的直接取消，别让用户点了停止又自己录起来
    const pending = key ? this.pendingResumes.get(key) : null
    if (pending) {
      clearTimeout(pending)
      this.pendingResumes.delete(key)
      this.rlog('resume cancelled by user stop', { key })
      this.notice('已取消自动续录')
      return { ok: true, cancelled: true }
    }

    const act = key ? this.actives.get(key) : [...this.actives.values()].pop()
    if (!act) return { ok: false, error: '没有在录制' }
    this.broadcast({ stopping: act.uid })

    if (act.mode === 'stream') {
      this.stopStream(act).catch((err) => this.log('stopStream failed', err && err.message))
      return { ok: true }
    }

    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.executeJavaScript('window.__recStop && window.__recStop()', true).catch(() => {})
    }
    return { ok: true }
  }

  stopAll() {
    for (const [key, timer] of [...this.pendingResumes]) {
      clearTimeout(timer)
      this.pendingResumes.delete(key)
    }
    for (const act of [...this.actives.values()]) {
      if (act.mode === 'stream') this.stopStream(act).catch(() => {})
    }
    return { ok: true, count: this.actives.size }
  }

  broadcast(extra = {}) {
    const mainWin = this.getMainWindow()
    if (!mainWin || mainWin.isDestroyed()) return
    const list = [...this.actives.values()].map((a) => ({
      uid: a.uid,
      label: a.label,
      mode: a.mode,
      startedAt: a.startedAt,
      bytes: a.bytes || 0,
      ready: Boolean(a.ready || a.mode === 'stream'),
      info: a.info || null,
      /** 这是本次录制的第几个大段 */
      segments: a.segments || 1,
      dir: a.dir || ''
    }))
    mainWin.webContents.send('rec:state', {
      count: list.length,
      recorders: list,
      outDir: this.outDir,
      ffmpeg: Boolean(this.ffmpeg),
      ...extra
    })
  }

  /**
   * 退出时的收尾。原来是直接 SIGKILL ffmpeg，导致正在录的内容只剩临时目录里的 mkv
   * （不会进 output，用户看到的就是"录制没了"）。现在改成：给 ffmpeg 发 'q' 让它正常收尾，
   * 最多等 2.5 秒；来不及封装的部分会留在临时目录，下次启动由 recoverOrphans() 补上。
   */
  async dispose() {
    const waits = []
    for (const act of [...this.actives.values()]) {
      if (act.mode === 'stream') {
        clearTimeout(act.maxTimer)
        waits.push(
          new Promise((resolve) => {
            let done = false
            const finish = () => {
              if (done) return
              done = true
              resolve()
            }
            act.child.once('close', finish)
            try {
              act.child.stdin.write('q')
              act.child.stdin.end()
            } catch {}
            setTimeout(() => {
              if (!done) {
                try {
                  act.child.kill('SIGKILL')
                } catch {}
              }
              setTimeout(finish, 200)
            }, 2500)
          })
        )
      } else {
        try {
          act.stream.end()
        } catch {}
      }
    }
    if (waits.length) {
      this.rlog('dispose waiting for active recordings', { count: waits.length })
      await Promise.all(waits)
    }
    // 没来得及合并的分段留着，下次启动 recoverOrphans() 会接走
    for (const act of this.actives.values()) {
      if (act.mode === 'stream') {
        const parts = this.listParts(act.dir)
        if (parts.length) this.rlog('left parts for recovery on next start', { dir: act.dir, parts: parts.length })
      }
    }
    this.actives.clear()
    this.screenAct = null
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
  }
}

module.exports = { RecorderManager, findFfmpeg, STREAM_RE }
