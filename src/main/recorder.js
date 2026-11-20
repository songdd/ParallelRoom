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
  // 安装版：工具随包放在 resources\ffmpeg\ 里（electron-builder 的 extraResources）；
  // 开发态 / 绿色版：项目里的 vendor\ffmpeg\
  const bundled = []
  try {
    if (process.resourcesPath) bundled.push(path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe'))
  } catch {}
  bundled.push(path.join(__dirname, '..', '..', 'vendor', 'ffmpeg', 'ffmpeg.exe'))
  for (const c of bundled) {
    try {
      if (fs.existsSync(c)) return c
    } catch {}
  }
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
 * 默认录制目录。
 * - 开发态（源码跑）：项目目录下的 output；
 * - 安装版：**绝不能落在安装目录里**（升级/卸载会把录制清掉），改用「视频」库下的 ParallelRoom
 *   （`%USERPROFILE%\Videos\ParallelRoom`），取不到就退 userData\recordings。
 */
function DEFAULT_OUT_DIR() {
  const packaged = (() => {
    try {
      return app.isPackaged || String(app.getAppPath()).includes('app.asar')
    } catch {
      return true
    }
  })()
  if (packaged) {
    try {
      return path.join(app.getPath('videos'), 'ParallelRoom')
    } catch {}
    try {
      return path.join(app.getPath('userData'), 'recordings')
    } catch {}
  }
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

  /** 量视频时长（导出拼接时用来算进度百分比） */
  probeDuration(file) {
    return new Promise((resolve) => {
      if (!this.ffprobe) return resolve(null)
      const child = spawn(
        this.ffprobe,
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
        { windowsHide: true }
      )
      let out = ''
      child.stdout.on('data', (d) => {
        out += d.toString()
      })
      child.on('error', () => resolve(null))
      child.on('close', () => {
        const v = Number(String(out).trim())
        resolve(Number.isFinite(v) && v > 0 ? v : null)
      })
    })
  }

  /**
   * 找 `t` 之前（含）最近的关键帧时间。
   *
   * 为什么需要它：`-c copy` 只能从关键帧开始切，切点会往前漂一个 GOP。
   * 对"取最近 N 秒"来说这很致命——片段末尾会少掉漂掉的那几秒，正好是要看的画面。
   * 这里量出漂移量，再用 `-t (N + 漂移)` 把尾巴补回来，保证结束点仍然是"现在"。
   */
  lastKeyframeBefore(file, t) {
    return new Promise((resolve) => {
      if (!this.ffprobe || !(t > 0)) return resolve(null)
      const from = Math.max(0, t - 6)
      const child = spawn(
        this.ffprobe,
        [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-read_intervals',
          `${from.toFixed(3)}%+${(t - from + 0.5).toFixed(3)}`,
          '-show_entries',
          'frame=key_frame,pts_time',
          '-of',
          'csv=p=0',
          file
        ],
        { windowsHide: true }
      )
      let out = ''
      child.stdout.on('data', (d) => {
        out += d.toString()
      })
      child.on('error', () => resolve(null))
      child.on('close', () => {
        let best = null
        for (const line of out.split(/\r?\n/)) {
          const parts = line.trim().split(',')
          if (parts.length < 2) continue
          const ts = Number(parts[parts.length - 1])
          const kf = Number(parts[0])
          if (!Number.isFinite(ts) || kf !== 1) continue
          if (ts <= t + 0.001 && (best === null || ts > best)) best = ts
        }
        resolve(best)
      })
    })
  }

  /**
   * 量时长（宽松版）：给"正在写的分段"用。
   *
   * 坑：ffmpeg 还在往 matroska 里写的时候，文件没有 Duration 元素，ffprobe 的
   * `format=duration` 直接返回 `N/A`（stderr 是 "File ended prematurely"）。
   * 边看边截如果只看那个值，就会一直报"还没写出可读的分段"——实测踩到过。
   * 这里退一步去读**最后一个视频包的 pts**，20 秒的分段只要 60ms 左右。
   */
  probeDurationLoose(file) {
    return this.probeDuration(file).then((d) => {
      if (Number.isFinite(d) && d > 0) return d
      return new Promise((resolve) => {
        if (!this.ffprobe) return resolve(null)
        const child = spawn(
          this.ffprobe,
          ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file],
          { windowsHide: true }
        )
        let buf = ''
        let maxPts = -1
        let secondMax = -1
        const eat = (s) => {
          const lines = s.split(/\r?\n/)
          buf = lines.pop() || ''
          for (const line of lines) {
            const v = Number(line.trim())
            if (!Number.isFinite(v)) continue
            if (v > maxPts) {
              secondMax = maxPts
              maxPts = v
            } else if (v > secondMax) secondMax = v
          }
        }
        child.stdout.on('data', (d) => eat(d.toString()))
        child.on('error', () => resolve(null))
        child.on('close', () => {
          if (buf) eat(buf + '\n')
          if (!(maxPts >= 0)) return resolve(null)
          // 补一帧的余量，别把最后那帧算没了
          const frame = maxPts > secondMax && secondMax >= 0 ? Math.min(0.2, maxPts - secondMax) : 0.04
          resolve(maxPts + frame)
        })
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
    const skipped = []
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
      if (Date.now() - newest < 30 * 1000) {
        skipped.push(job.name)
        this.rlog('recover orphan skipped (still fresh)', { name: job.name, ageMs: Date.now() - newest })
        continue
      }

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
    return { ok: true, recovered, failed, skipped }
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

  /**
   * 这一场录制对应的目录。
   * stream 模式在开录时就有 act.dir；屏幕/整窗录制要到停止转码才建目录，
   * 这里按同一套命名规则先算出来，这样"边看边截"的精彩片段能和这场录制放进同一个文件夹。
   */
  sessionDirOf(act) {
    if (!act) return this.outDir
    if (act.dir) return act.dir
    return this.sessionDirFor(act.label || '录制', act.startedAt || Date.now())
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

    // 优酷这类站点的 m3u8 带签名，光给 UA+Referer 常常 403；把页面 cookie / Origin 一起带上
    let headerLines = [`Referer: ${params.referer || 'https://live.douyin.com/'}`]
    if (params.cookie) headerLines.push(`Cookie: ${params.cookie}`)
    if (params.origin) headerLines.push(`Origin: ${params.origin}`)

    /**
     * ffmpeg 的 `-headers` 是**一整块**字符串，超过上限时它不报"头太长"，而是直接
     * `Error opening input files: Invalid argument`（exit -22）——看起来像"地址无效"，
     * 极难查。实测（ffmpeg 8.1.1，同一路抖音直播）：整块 7000 字能录，7400 字就 EINVAL。
     * 抖音的 cookie 现在能到 7.8 KB，所以这里做个硬保险：太长就把 Cookie 丢掉，
     * 保住录制（Referer / Origin 留着，够用）。
     */
    const MAX_HEADER_CHARS = 6000
    if (headerLines.join('\r\n').length > MAX_HEADER_CHARS) {
      const cookieLen = String(params.cookie || '').length
      headerLines = headerLines.filter((l) => !/^Cookie:\s/i.test(l))
      this.rlog('headers too long, cookie dropped', {
        cookieLen,
        referer: String(params.referer || ''),
        limit: MAX_HEADER_CHARS
      })
    }

    const args = [
      '-y',
      '-user_agent',
      UA,
      '-headers',
      headerLines.join('\r\n') + '\r\n',
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

    // 诊断用：ffmpeg 报 "Invalid argument" 时，先确认喂给它的到底是什么。
    // 走 rlog（写 rec.log，不依赖 PR_LOG），并且**完整**记录 URL（不做截断）——
    // 因为 ffmpeg 对"空 / 带前导空白 / 只有 query"的地址都报同样的 Invalid argument。
    this.rlog('rec ffmpeg args', {
      len: String(params.streamUrl || '').length,
      url: String(params.streamUrl || ''),
      headers: headerLines.map((h) => h.slice(0, 24) + (h.length > 24 ? `…(${h.length})` : '')),
      referer: String(params.referer || '')
    })

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
   * 边看边截：把**最近 N 秒**单独存成一个精彩片段（不停止录制）。
   *
   * 数据来源就是正在写的分段文件（stream 模式是 partNNNN.mkv，screen 模式是临时 webm），
   * 所以取的长度受"当前这一份文件已经写了多久"限制——不够长就自动把前一段也带上。
   * 全程 -c copy，不重编码（copy 不成就退一次 x264）。
   */
  async snapshotRecent(uid, seconds = 10, opts = {}) {
    if (!this.ffmpeg) return { ok: false, error: '没找到 ffmpeg' }
    const key = String(uid || '')
    const act = key ? this.actives.get(key) : null
    // 每次请求都记一笔（包括早期失败），不然用户"点了没反应"时查不出原因
    this.rlog('snapshot request', { uid: key, seconds, hasAct: Boolean(act), mode: act ? act.mode : '', dir: act ? act.dir || act.webmPath || '' : '' })
    if (!act) {
      return { ok: false, error: `这个房间现在没在录制（uid=${key || '空'}）：精彩片段是从正在录的流里截的` }
    }
    const want = Math.max(1, Math.min(120, Number(seconds) || 10))

    // 候选文件：从最后一段往前，凑够 want + 1.5 秒
    let useFiles = []
    if (act.mode === 'screen') {
      if (act.webmPath && fs.existsSync(act.webmPath)) useFiles = [act.webmPath]
    } else {
      const recs = []
      let acc = 0
      const parts = this.listParts(act.dir)
      for (let i = parts.length - 1; i >= 0 && acc < want + 1.5; i--) {
        const d = (await this.probeDurationLoose(parts[i])) || 0
        if (d < 0.2) continue
        recs.unshift(parts[i])
        acc += d
      }
      useFiles = recs
    }
    if (!useFiles.length) {
      const bytes = act.mode === 'screen' ? 0 : this.partsBytes(act.dir)
      this.rlog('snapshot: no readable parts yet', { uid: key, dir: act.dir, bytes })
      return {
        ok: false,
        error: `刚开录，这一段的缓存还没落盘（${Math.round(bytes / 1024)}KB），等 5~10 秒再点`
      }
    }

    let total = 0
    for (const f of useFiles) total += (await this.probeDurationLoose(f)) || 0
    if (total < 0.5) return { ok: false, error: '这一份文件还没写满 1 秒，稍等再截' }
    const startAt = Math.max(0, total - want)

    // -c copy 只能落在关键帧上：量出切点会往前漂多少（drift），把 -t 补上同样多，
    // 才能保证"结束点 = 现在"，而不是整体往前挪一个 GOP。
    const offsets = []
    {
      let acc = 0
      for (const f of useFiles) {
        offsets.push(acc)
        acc += (await this.probeDurationLoose(f)) || 0
      }
    }
    let cutAt = startAt
    let cutFile = useFiles[0]
    let cutOffset = 0
    for (let i = useFiles.length - 1; i >= 0; i--) {
      if (startAt >= offsets[i] - 0.001) {
        cutFile = useFiles[i]
        cutOffset = offsets[i]
        break
      }
    }
    const kf = await this.lastKeyframeBefore(cutFile, Math.max(0.01, startAt - cutOffset))
    if (kf !== null) cutAt = Math.max(0, cutOffset + kf)
    const drift = Math.max(0, startAt - cutAt)
    // 关键帧漂移 <=0.25s 时：从关键帧开始 copy，用 -t 把多出来的 lead-in 一起算进去，
    // 这样"结束点"仍然落在现在；漂移更大就宁可重编码这几秒，换来精确的起止
    // （实测 1080p60 大约 0.2 秒/秒，30 秒的片段约 6 秒，比"切歪一个 GOP"划算）。
    const precise = drift > 0.25
    const seekAt = precise ? startAt : cutAt
    const clipLen = precise ? Math.min(total - seekAt, want) : Math.min(total - cutAt, want + drift)

    // 精彩片段和这一场录制放同一个目录（<房间名>_<时间戳>/），别撒在录制目录根上
    const dir = opts.outDir ? path.resolve(String(opts.outDir)) : this.sessionDirOf(act)
    fs.mkdirSync(dir, { recursive: true })
    // 命名规则：<主播>_<时间戳>_精彩<Ns>.mp4 —— 时间戳在前，和同一场的成片/分段并排时按时间排得整齐
    const base = `${act.label}_${stamp(new Date())}_精彩${want}s`
    let out = path.join(dir, `${base}.mp4`)
    if (fs.existsSync(out)) out = path.join(dir, `${base}_${Math.random().toString(36).slice(2, 6)}.mp4`)

    // 多份文件先拼：concat 列表写临时文件；-ss 放输入侧（快）。
    let inputArgs = []
    let listFile = ''
    if (useFiles.length === 1) {
      inputArgs = ['-ss', seekAt.toFixed(3), '-i', useFiles[0]]
    } else {
      listFile = path.join(this.tmpDir, `replay_${Date.now()}.txt`)
      fs.mkdirSync(this.tmpDir, { recursive: true })
      fs.writeFileSync(listFile, useFiles.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'))
      inputArgs = ['-ss', seekAt.toFixed(3), '-f', 'concat', '-safe', '0', '-i', listFile]
    }

    const runCopy = () =>
      this.runFfmpeg([
        '-y',
        ...inputArgs,
        '-t',
        clipLen.toFixed(2),
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        out
      ])
    const runReencode = () =>
      this.runFfmpeg([
        '-y',
        ...inputArgs,
        '-t',
        clipLen.toFixed(2),
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '20',
        '-c:a',
        'aac',
        '-b:a',
        '160k',
        '-movflags',
        '+faststart',
        out
      ])

    const t0 = Date.now()
    try {
      if (precise) {
        // GOP 太稀：直接重编码这几秒，起止都精确
        await runReencode()
      } else {
        try {
          await runCopy()
        } catch (err) {
          this.rlog('snapshot copy failed, re-encode once', { err: String((err && err.message) || err).slice(-200) })
          await runReencode()
        }
      }
      const size = (() => {
        try {
          return fs.statSync(out).size
        } catch {
          return 0
        }
      })()
      const realDur = (await this.probeDurationLoose(out)) || clipLen
      this.rlog('snapshot done', { label: act.label, want, realDur, drift, precise, ms: Date.now() - t0, out })
      this.notice(`「${act.label}」已截取最近 ${want} 秒精彩片段（${path.basename(out)}）`)
      return { ok: true, out, seconds: Math.round(realDur * 100) / 100, request: want, size, mode: act.mode, precise }
    } catch (err) {
      this.rlog('snapshot failed', { label: act.label, err: String((err && err.message) || err).slice(-300) })
      return { ok: false, error: String((err && err.message) || err).slice(-300) }
    } finally {
      if (listFile) {
        try {
          fs.unlinkSync(listFile)
        } catch {}
      }
    }
  }

  /**
   * 从**本地视频文件**里按"当前播放进度"截一段：覆盖 `[atSec - seconds, atSec]`。
   *
   * 和"边看边截"是同一套算法（关键帧漂移补偿 + copy/重编码二选一），
   * 区别只是来源从"正在写的分段"换成一个现成的文件。
   */
  async clipFromFile({ file, atSec, seconds, outDir, name } = {}) {
    if (!this.ffmpeg) return { ok: false, error: '没找到 ffmpeg' }
    const src = path.resolve(String(file || ''))
    if (!src || !fs.existsSync(src)) return { ok: false, error: '文件不存在：' + (file || '') }
    const dur = (await this.probeDurationLoose(src)) || 0
    if (!(dur > 0.5)) return { ok: false, error: '读不出这个文件的时长（可能还没写完/已损坏）' }
    const wantRaw = Math.max(1, Math.min(120, Number(seconds) || 10))
    const at = Math.max(0, Math.min(dur, Number(atSec) || 0))
    // 片段以"当前播放进度"结尾；播放点还没走满 N 秒时，最多只取到开头，别跨过去往前拽
    const startAt = Math.max(0, at - wantRaw)
    const want = at > 0.3 ? Math.min(wantRaw, at) : Math.min(wantRaw, dur)
    if (!(want > 0.3)) return { ok: false, error: '这段太短了（当前进度太靠前？）' }

    const dir = outDir ? path.resolve(String(outDir)) : path.dirname(src)
    fs.mkdirSync(dir, { recursive: true })
    const base = String(name || path.basename(src).replace(/\.[^.]+$/, '')).replace(/[\\/:*?"<>|]/g, '_')
    // 同样把时间戳放前面：<原文件名>_<时间戳>_精彩<Ns>.mp4
    const tag = Math.max(1, Math.round(want))
    const stampNow = stamp(new Date())
    let out = path.join(dir, `${base}_${stampNow}_精彩${tag}s.mp4`)
    if (fs.existsSync(out)) out = path.join(dir, `${base}_${stampNow}_精彩${tag}s_${Math.random().toString(36).slice(2, 6)}.mp4`)

    const kf = await this.lastKeyframeBefore(src, Math.max(0.01, startAt))
    const cutAt = kf === null ? startAt : Math.max(0, kf)
    const drift = Math.max(0, startAt - cutAt)
    const precise = drift > 0.25
    const seekAt = precise ? startAt : cutAt
    const clipLen = precise ? want : Math.min(dur - cutAt, want + drift)

    const t0 = Date.now()
    this.rlog('clip-from-file request', { src, at, want: wantRaw, dur, drift, precise })
    try {
      const common = ['-y', '-ss', seekAt.toFixed(3), '-i', src, '-t', clipLen.toFixed(2)]
      if (!precise) {
        try {
          await this.runFfmpeg([...common, '-c', 'copy', '-movflags', '+faststart', out])
        } catch (err) {
          this.rlog('clip-from-file copy failed, re-encode', { err: String((err && err.message) || err).slice(-200) })
          await this.runFfmpeg([...common, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out])
        }
      } else {
        await this.runFfmpeg([...common, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out])
      }
      const size = (() => {
        try {
          return fs.statSync(out).size
        } catch {
          return 0
        }
      })()
      const realDur = (await this.probeDurationLoose(out)) || clipLen
      this.rlog('clip-from-file done', { out, realDur, ms: Date.now() - t0, precise })
      return { ok: true, out, seconds: Math.round(realDur * 100) / 100, request: wantRaw, size, precise, at }
    } catch (err) {
      this.rlog('clip-from-file failed', { src, err: String((err && err.message) || err).slice(-300) })
      return { ok: false, error: String((err && err.message) || err).slice(-300) }
    }
  }

  /**
   * 列出某一场目录里的精彩片段 / 精修片段（全屏小窗用）。
   * 只认 `<名字>_精彩<Ns>.mp4` 和 `<名字>_精修<Ns>.mp4` 两种命名，按时间从旧到新排。
   */
  listClips(dir) {
    const d = path.resolve(String(dir || ''))
    if (!d || d === path.resolve('') || !fs.existsSync(d)) {
      return { ok: false, error: '目录不存在：' + (dir || '（空）'), dir: d, clips: [] }
    }
    let names = []
    try {
      names = fs.readdirSync(d)
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err), dir: d, clips: [] }
    }
    const clips = names
      .filter((n) => /_(?:精彩|精修)\d+s(?:_[a-z0-9]{2,6})?\.mp4$/i.test(n))
      .map((n) => {
        const p = path.join(d, n)
        let st = null
        try {
          st = fs.statSync(p)
        } catch {}
        return { path: p, name: n, size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0 }
      })
      .sort((a, b) => a.mtime - b.mtime)
    this.rlog('list-clips', { dir: d, n: clips.length })
    return { ok: true, dir: d, clips }
  }

  /**
   * 最近一场"有精彩片段"的录制目录。
   *
   * 用途：重启程序、或者已经停录之后，全屏小窗照样能直接把刚截的片段列出来
   * （否则它只知道"当前在录的那一场"，停录后就空了）。
   */
  lastClipsDir() {
    const root = this.outDir
    let names = []
    try {
      names = fs.readdirSync(root)
    } catch (err) {
      return { ok: false, error: '录制目录读不到：' + String((err && err.message) || err), dir: '', clips: [] }
    }
    const isClip = (f) => /_(?:精彩|精修)\d+s(?:_[a-z0-9]{2,6})?\.mp4$/i.test(f)
    let best = null
    for (const n of names) {
      const d = path.join(root, n)
      let files = []
      try {
        if (!fs.statSync(d).isDirectory()) continue
        files = fs.readdirSync(d)
      } catch {
        continue
      }
      let newest = 0
      for (const f of files) {
        if (!isClip(f)) continue
        try {
          newest = Math.max(newest, fs.statSync(path.join(d, f)).mtimeMs)
        } catch {}
      }
      if (newest && (!best || newest > best.newest)) best = { dir: d, newest }
    }
    if (!best) return { ok: false, error: '还没有任何精彩片段', dir: '', clips: [] }
    const r = this.listClips(best.dir)
    return { ok: true, dir: best.dir, clips: r.clips || [] }
  }

  /**
   * 按任意区间 [startSec, endSec] 从已有文件里切一段 —— 全屏小窗的「两端精修」。
   *
   * 策略和 clipFromFile 完全一致：切点落在最近的关键帧上，漂移 ≤0.25s 就 copy 并
   * 用 -t 把 lead-in 补回来；漂移更大就重编码这一段，换来精确的左右端点。
   */
  async clipRange({ file, startSec, endSec, outDir, name, overwrite } = {}) {
    if (!this.ffmpeg) return { ok: false, error: '没找到 ffmpeg' }
    const src = path.resolve(String(file || ''))
    if (!src || !fs.existsSync(src)) return { ok: false, error: '文件不存在：' + (file || '') }
    const dur = (await this.probeDurationLoose(src)) || 0
    if (!(dur > 0.5)) return { ok: false, error: '读不出这个文件的时长（可能还没写完/已损坏）' }
    let a = Math.max(0, Math.min(dur, Number(startSec) || 0))
    let b = Math.max(0, Math.min(dur, Number.isFinite(Number(endSec)) ? Number(endSec) : dur))
    if (b < a) [a, b] = [b, a]
    if (!(b - a > 0.2)) return { ok: false, error: `选区太短了（${(b - a).toFixed(2)} 秒）` }

    const isOverwrite = overwrite === true
    const dir = outDir ? path.resolve(String(outDir)) : path.dirname(src)
    fs.mkdirSync(dir, { recursive: true })
    const base = String(name || path.basename(src).replace(/\.[^.]+$/, '')).replace(/[\\/:*?"<>|]/g, '_')
    const tag = Math.max(1, Math.round(b - a))
    const stampNow = stamp(new Date())
    // 覆盖模式：先写同目录的临时文件，成功后再顶掉原文件（避免 ffmpeg 边读边写同一个文件）
    let finalOut = path.join(dir, `${base}_${stampNow}_精修${tag}s.mp4`)
    if (!isOverwrite && fs.existsSync(finalOut)) {
      finalOut = path.join(dir, `${base}_${stampNow}_精修${tag}s_${Math.random().toString(36).slice(2, 6)}.mp4`)
    }
    const writeTo = isOverwrite ? path.join(dir, `.${base}.overwrite-${Date.now().toString(36)}.mp4`) : finalOut

    const kf = await this.lastKeyframeBefore(src, Math.max(0.01, a))
    const cutAt = kf === null ? a : Math.max(0, kf)
    const drift = Math.max(0, a - cutAt)
    const precise = drift > 0.25
    const seekAt = precise ? a : cutAt
    const clipLen = precise ? b - a : Math.min(b - cutAt, b - a + drift)

    const t0 = Date.now()
    this.rlog('clip-range request', { src, a, b, dur, drift, precise, overwrite: isOverwrite })
    try {
      const common = ['-y', '-ss', seekAt.toFixed(3), '-i', src, '-t', clipLen.toFixed(2)]
      if (!precise) {
        try {
          await this.runFfmpeg([...common, '-c', 'copy', '-movflags', '+faststart', writeTo])
        } catch (err) {
          this.rlog('clip-range copy failed, re-encode', { err: String((err && err.message) || err).slice(-200) })
          await this.runFfmpeg([...common, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', writeTo])
        }
      } else {
        await this.runFfmpeg([...common, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', writeTo])
      }
      const size = (() => {
        try {
          return fs.statSync(writeTo).size
        } catch {
          return 0
        }
      })()
      if (!(size > 0)) throw new Error('ffmpeg 没写出内容（选区可能有问题）')

      let out = writeTo
      if (isOverwrite) {
        // 先量一下新文件确实是好的，再顶掉原文件；顶不掉就把临时文件留着当救援
        const newDur = (await this.probeDurationLoose(writeTo)) || 0
        if (!(newDur > 0.1)) throw new Error('新文件读不出时长，已保留临时文件：' + path.basename(writeTo))
        try {
          fs.rmSync(src, { force: true })
          fs.renameSync(writeTo, src)
        } catch (err) {
          throw new Error('替换原文件失败（临时文件还在：' + path.basename(writeTo) + '）：' + String((err && err.message) || err))
        }
        out = src
      }

      const realDur = (await this.probeDurationLoose(out)) || clipLen
      this.rlog('clip-range done', { out, realDur, ms: Date.now() - t0, precise, overwrite: isOverwrite })
      return {
        ok: true,
        out,
        seconds: Math.round(realDur * 100) / 100,
        startSec: Math.round(a * 100) / 100,
        endSec: Math.round(b * 100) / 100,
        size,
        precise,
        overwritten: isOverwrite
      }
    } catch (err) {
      this.rlog('clip-range failed', { src, err: String((err && err.message) || err).slice(-300) })
      return { ok: false, error: String((err && err.message) || err).slice(-300) }
    }
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

  /**
   * 带进度的 ffmpeg 执行：给参数加上 `-progress pipe:1`，把 ffmpeg 打到 stdout 的
   * `out_time_us=/speed=/progress=continue|end` 解析成 { outTime, speed, frame, done }。
   * 只在后台干活（拼接 / 转码）时用，录制时不能加（录制是 -c copy，没有这么多输出）。
   */
  runFfmpegProgress(args, onTick) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.ffmpeg, ['-progress', 'pipe:1', ...args], { windowsHide: true })
      let stderr = ''
      let buf = ''
      const st = { outTime: 0, speed: '', frame: 0 }
      const flush = () => {
        if (typeof onTick !== 'function') return
        try {
          onTick({ ...st })
        } catch {}
      }
      child.stdout.on('data', (d) => {
        buf += d.toString()
        let idx
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim()
          buf = buf.slice(idx + 1)
          const eq = line.indexOf('=')
          if (eq < 0) continue
          const k = line.slice(0, eq)
          const v = line.slice(eq + 1).trim()
          if (k === 'out_time_us' || k === 'out_time_ms') {
            const us = Number(v)
            if (Number.isFinite(us)) st.outTime = us / 1e6
          } else if (k === 'out_time') {
            const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(v)
            if (m) st.outTime = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
          } else if (k === 'speed') {
            st.speed = v
          } else if (k === 'frame') {
            const f = Number(v)
            if (Number.isFinite(f)) st.frame = f
          } else if (k === 'progress') {
            flush()
          }
        }
      })
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

  /** 通用的 ffmpeg 执行（合并 / 封装共用）；opts 可传 cwd 之类 */
  runFfmpeg(args, opts) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.ffmpeg, args, { windowsHide: true, ...(opts || {}) })
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

  /* ------------------------------ 多窗口拼接 ------------------------------ */

  /**
   * 把几路录好的文件拼成"一张多窗口画面"（2×2 之类的视频墙）。
   *
   * 每一路可以单独：
   *   gain    音量倍数（0 = 静音，1 = 原样，>1 放大）
   *   delay   起始延迟秒数（做"进度对齐"时用：让这一路晚一点开始，前面补黑场）
   *   seek    从这一路文件开头砍掉多少秒（"从标定点开始"模式：标定帧就是成片的 0 秒）
   * 视频用 xstack 摆格子，音频用 amix(normalize=0) 按各自音量混——
   * normalize=0 很关键，否则 ffmpeg 会把所有输入都压小，用户设的音量就没意义了。
   *
   * 两种对齐思路的区别（标定时刻记作 mark_i）：
   *   delay_i = max(mark) - mark_i           → 标定帧在所有窗口的同一个主时刻出现（T* = max mark），
   *                                            前面保留完整素材，所以成片前段会有黑格子；
   *                                            配合「只用对齐区间」从 t = max(delay) 开始导出。
   *   seek_i  = mark_i（delay 全 0）          → 直接把标定之前的素材砍掉，标定帧就是成片 0 秒。
   *
   * @param {{files:string[], cols?:number, rows?:number, gains?:number[], delays?:number[],
   *          seeks?:number[], rangeStart?:number, rangeEnd?:number,
   *          outDir?:string, name?:string, fps?:number, width?:number, encoder?:string,
   *          taskId?:string, onProgress?:Function}} p
   */
  async renderMosaic(p = {}) {
    const picked = (Array.isArray(p.files) ? p.files : [])
      .map((f) => path.resolve(String(f)))
      .filter((f) => fs.existsSync(f))
    if (picked.length < 2) return { ok: false, error: '至少选两个文件' }
    const list = picked.slice(0, 9)
    const n = list.length
    const cols = Math.max(1, Math.min(3, Math.floor(Number(p.cols) || Math.ceil(Math.sqrt(n)))))
    const rows = Math.max(1, Math.min(3, Math.floor(Number(p.rows) || Math.ceil(n / cols))))
    if (cols * rows < n) return { ok: false, error: `布局 ${cols}×${rows} 放不下 ${n} 路` }

    const totalW = Math.max(320, Math.min(3840, Math.floor(Number(p.width) || 1920)))
    const totalH = Math.max(180, Math.min(2160, Math.round(((totalW * 9) / 16) / 2) * 2))
    const cw = Math.floor(totalW / cols / 2) * 2
    const ch = Math.floor(totalH / rows / 2) * 2
    const fps = Math.max(10, Math.min(60, Math.floor(Number(p.fps) || 30)))
    const gains = list.map((_, i) => {
      const g = Number((p.gains || [])[i])
      return Number.isFinite(g) ? Math.max(0, Math.min(4, g)) : 1
    })
    const delays = list.map((_, i) => {
      const d = Number((p.delays || [])[i])
      return Number.isFinite(d) && d > 0 ? Math.min(86400, d) : 0
    })
    // seeks[i] = 从这一路文件开头砍掉多少秒（"从标定点开始"模式：标定帧就是成片的 0 秒）
    const seeks = list.map((_, i) => {
      const s = Number((p.seeks || [])[i])
      return Number.isFinite(s) && s > 0 ? Math.min(86400, s) : 0
    })

    const outDir = path.resolve(p.outDir || path.dirname(list[0]))
    try {
      fs.mkdirSync(outDir, { recursive: true })
    } catch {}
    const base = sanitize((p.name || '').trim() || `拼接_${list.length}路_${stamp()}`)
    let out = path.join(outDir, `${base}.mp4`)
    if (fs.existsSync(out)) {
      let k = 0
      do {
        k += 1
        out = path.join(outDir, `${base}_${k}.mp4`)
      } while (fs.existsSync(out) && k < 50)
    }

    const layoutParts = []
    for (let i = 0; i < n; i++) {
      const c = i % cols
      const r = Math.floor(i / cols)
      layoutParts.push(`${c * cw}_${r * ch}`)
    }

    // 只导出「共同区间」：所有窗口都有画面的那一段（起点 = 最晚开始，终点 = 最早结束）
    const rangeStart = Number(p.rangeStart)
    const rangeEnd = Number(p.rangeEnd)
    const trim =
      Number.isFinite(rangeStart) && Number.isFinite(rangeEnd) && rangeStart >= 0 && rangeEnd - rangeStart >= 0.2
        ? { s: Math.round(rangeStart * 1000) / 1000, e: Math.round(rangeEnd * 1000) / 1000 }
        : null

    const buildFilters = (withAudio) => {
      const f = []
      for (let i = 0; i < n; i++) {
        const d = delays[i]
        // 每一路：等比缩放 + 补黑边到格子大小（不裁画面）
        f.push(
          `[${i}:v]scale=${cw}:${ch}:force_original_aspect_ratio=decrease,` +
            `pad=${cw}:${ch}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p,setpts=PTS-STARTPTS` +
            (d > 0 ? `,tpad=start_duration=${d}:start_mode=add:color=black` : '') +
            `[v${i}]`
        )
      }
      f.push(`${Array.from({ length: n }, (_, i) => `[v${i}]`).join('')}xstack=inputs=${n}:layout=${layoutParts.join('|')}:fill=black[vstack]`)
      if (trim) {
        f.push(`[vstack]trim=start=${trim.s}:end=${trim.e},setpts=PTS-STARTPTS[vout]`)
      } else {
        f.push('[vstack]null[vout]')
      }
      if (withAudio) {
        for (let i = 0; i < n; i++) {
          const d = delays[i]
          f.push(
            `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
              `volume=${gains[i]},asetpts=PTS-STARTPTS` +
              (d > 0 ? `,adelay=delays=${Math.round(d * 1000)}:all=1` : '') +
              `[a${i}]`
          )
        }
        f.push(`${Array.from({ length: n }, (_, i) => `[a${i}]`).join('')}amix=inputs=${n}:normalize=0:duration=longest:dropout_transition=0[amix]`)
        if (trim) {
          f.push(`[amix]atrim=start=${trim.s}:end=${trim.e},asetpts=PTS-STARTPTS[aout]`)
        } else {
          f.push('[amix]anull[aout]')
        }
      }
      return f.join(';')
    }

    const inputArgs = []
    for (let i = 0; i < list.length; i++) {
      // 输入级 -ss：先砍掉标定之前的部分（快，不用全解码）
      if (seeks[i] > 0) inputArgs.push('-ss', String(seeks[i]))
      inputArgs.push('-i', list[i])
    }
    const enc = this.encoderArgs({ encoder: p.encoder === 'nvenc' ? 'nvenc' : 'x264' })

    // 估算成片总时长（用来算进度百分比）：只出对齐区间时就是区间长度，
    // 否则是最晚结束的那一路（砍头之后：延迟 + 剩余时长）
    let total = 0
    if (trim) {
      total = Math.max(0.1, trim.e - trim.s)
    } else {
      const durs = await Promise.all(list.map((f) => this.probeDuration(f)))
      for (let i = 0; i < n; i++) total = Math.max(total, delays[i] + Math.max(0, (durs[i] || 0) - seeks[i]))
    }
    const onProgress = typeof p.onProgress === 'function' ? p.onProgress : null
    const runOnce = async (withAudio) => {
      const args = ['-y', ...inputArgs, '-filter_complex', buildFilters(withAudio)]
      args.push('-map', '[vout]')
      if (withAudio) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '192k')
      args.push(...enc, '-movflags', '+faststart', out)
      if (!onProgress) return this.runFfmpeg(args)
      const taskId = p.taskId || ''
      try {
        onProgress({ taskId, stage: 'render', pct: 0, outTime: 0, total, speed: '' })
      } catch {}
      return this.runFfmpegProgress(args, (st) => {
        const pct = total > 0 ? Math.max(0, Math.min(99.9, (st.outTime / total) * 100)) : null
        try {
          onProgress({ taskId, stage: 'render', pct, outTime: st.outTime, total, speed: st.speed, frame: st.frame })
        } catch {}
      })
    }

    const started = Date.now()
    this.rlog('mosaic start', { n, cols, rows, cw, ch, out, gains, delays, seeks, trim })
    try {
      await runOnce(true)
    } catch (err) {
      // 有的文件可能没有音轨 —— 退一步只出画面
      this.rlog('mosaic with audio failed, retry video-only', { err: String((err && err.message) || err).slice(-200) })
      try {
        await runOnce(false)
      } catch (err2) {
        return { ok: false, error: String((err2 && err2.message) || err2) }
      }
    }
    let size = 0
    try {
      size = fs.statSync(out).size
    } catch {}
    const ms = Date.now() - started
    this.rlog('mosaic done', { out, size, ms })
    if (onProgress) {
      try {
        onProgress({ taskId: p.taskId || '', stage: 'done', pct: 100, outTime: total, total, speed: '' })
      } catch {}
    }
    return {
      ok: true,
      out,
      size,
      ms,
      n,
      cols,
      rows,
      cell: { w: cw, h: ch },
      size2: `${totalW}x${totalH}`,
      duration: Math.round(total * 100) / 100,
      delays,
      seeks,
      range: trim ? { start: trim.s, end: trim.e } : null
    }
  }

  /* ------------------------------ 精彩片段 ------------------------------ */

  /**
   * 找"精彩镜头"：用 ffmpeg 的 scene 检测（画面变化剧烈处 = 切镜/爆发动作），
   * 再按最小间隔贪心挑前 count 个。
   * @param {{file:string, count?:number, seconds?:number, minGap?:number, threshold?:number}} p
   */
  async analyzeHighlights(p = {}) {
    const file = path.resolve(String(p.file || ''))
    if (!fs.existsSync(file)) return { ok: false, error: '文件不存在' }
    const count = Math.max(1, Math.min(12, Math.floor(Number(p.count) || 5)))
    const seconds = Math.max(1, Math.min(20, Number(p.seconds) || 6))
    const minGap = Math.max(1, Math.min(300, Number(p.minGap) || 8))
    const threshold = Math.max(0.05, Math.min(0.9, Number(p.threshold) || 0.25))
    const dur = (await this.probeDuration(file)) || 0
    const nullOut = process.platform === 'win32' ? 'NUL' : '/dev/null'
    const started = Date.now()

    // ffmpeg 的 filter 参数里路径带盘符冒号非常容易解析失败，
    // 所以把 metadata 写到"用 cwd 定位的相对文件名"，绕开转义问题
    const workDir = app.getPath('temp')
    const scan = async (thr) => {
      const fname = `pr-scene-${Date.now()}-${Math.round(thr * 100)}.txt`
      const full = path.join(workDir, fname)
      try {
        await this.runFfmpeg(
          [
            '-y',
            '-hide_banner',
            '-loglevel',
            'error',
            '-i',
            file,
            '-vf',
            `select='gt(scene,${thr})',metadata=mode=print:file=${fname}`,
            '-an',
            '-f',
            'null',
            nullOut
          ],
          { cwd: workDir }
        )
      } catch (err) {
        try {
          fs.unlinkSync(full)
        } catch {}
        throw err
      }
      let raw = ''
      try {
        raw = fs.readFileSync(full, 'utf8')
      } catch {}
      try {
        fs.unlinkSync(full)
      } catch {}
      const list = []
      let cur = null
      for (const line of raw.split(/\r?\n/)) {
        const mTime = /pts_time:([\d.]+)/.exec(line)
        if (mTime) {
          cur = { time: Number(mTime[1]), score: 0 }
          continue
        }
        const mScore = /lavfi\.scene_score=([\d.]+)/.exec(line)
        if (mScore && cur) {
          cur.score = Number(mScore[1])
          list.push(cur)
          cur = null
        }
      }
      return list
    }

    // 阈值自适应：0.25 常常太严（画面缓慢变化时一个点都没有）
    let usedThr = threshold
    let candidates = []
    for (const thr of [threshold, 0.15, 0.08, 0.04]) {
      try {
        candidates = await scan(thr)
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) }
      }
      usedThr = thr
      if (candidates.length) break
    }

    // 按分数贪心 + 最小间隔
    candidates.sort((a, b) => b.score - a.score)
    const picked = []
    for (const c of candidates) {
      if (picked.length >= count) break
      if (!Number.isFinite(c.time)) continue
      if (dur && c.time > dur - 0.5) continue
      if (picked.some((x) => Math.abs(x.time - c.time) < minGap)) continue
      picked.push(c)
    }
    picked.sort((a, b) => a.time - b.time)
    let segments = picked.map((c) => {
      let start = Math.max(0, c.time - seconds / 2)
      let end = Math.min(dur || c.time + seconds / 2, start + seconds)
      start = Math.max(0, end - seconds)
      return { start: Math.round(start * 100) / 100, end: Math.round(end * 100) / 100, score: Math.round(c.score * 1000) / 1000 }
    })
    // 一个变化点都没有（比如固定机位的纯画面）：退化成均分取样
    let fallback = false
    if (!segments.length && dur > seconds + 1) {
      fallback = true
      const n = Math.max(1, Math.min(count, Math.floor(dur / (seconds + 1))))
      const span = dur - seconds
      for (let i = 0; i < n; i++) {
        const start = Math.round(((span * (i + 0.5)) / n) * 100) / 100
        segments.push({ start, end: Math.round((start + seconds) * 100) / 100, score: 0 })
      }
    }
    this.rlog('highlights analyzed', { file, threshold: usedThr, cands: candidates.length, picked: segments.length, fallback, ms: Date.now() - started })
    return { ok: true, file, duration: dur, candidates: candidates.length, segments, seconds, threshold: usedThr, fallback }
  }

  /**
   * 把选中的时间段抽出来拼成一个"精彩片段"文件（一次重编码）。
   * @param {{file:string, segments:Array<{start:number,end:number}>, outDir?:string, encoder?:string,
   *          taskId?:string, onProgress?:Function}} p
   */
  async extractHighlights(p = {}) {
    const file = path.resolve(String(p.file || ''))
    // 新写法：items 里每一项可以是"从 file 里切一段"（start/end），也可以是"整个本地文件"（file）
    const rawItems = Array.isArray(p.items) && p.items.length ? p.items : null
    const fromSegs = (Array.isArray(p.segments) ? p.segments : []).map((s) => ({ start: s.start, end: s.end }))
    const items = []
    for (const it of rawItems || fromSegs) {
      const own = it && it.file ? path.resolve(String(it.file)) : ''
      if (own) {
        if (!fs.existsSync(own)) continue
        const dur = (await this.probeDurationLoose(own)) || 0
        if (!(dur > 0.2)) continue
        const a = Math.max(0, Math.min(dur, Number(it.start) || 0))
        const b = Math.max(0, Math.min(dur, Number(it.end) || dur))
        if (b - a <= 0.2) continue
        items.push({ file: own, start: a, end: b, whole: !(Number(it.start) > 0 || Number(it.end) > 0) })
      } else {
        const a = Math.max(0, Number(it && it.start) || 0)
        const b = Math.max(0, Number(it && it.end) || 0)
        if (b - a <= 0.2) continue
        items.push({ file, start: a, end: b, whole: false })
      }
    }
    if (!items.length) return { ok: false, error: '没有可用的片段' }
    // 只用"本地片段文件"时不需要样片；有从样片切的段但样片不在，才报错
    const needsSample = items.some((it) => it.file === file)
    if (needsSample && !fs.existsSync(file)) return { ok: false, error: '样片文件不存在：' + file }
    const segs = items
    const encoder = p.encoder === 'nvenc' ? 'nvenc' : 'x264'
    // 每个不同的源文件一个 -i 输入；片段既可以是"样片里切一段"，也可以是"整个本地片段文件"
    const inputFiles = []
    const idxOf = (f) => {
      let i = inputFiles.indexOf(f)
      if (i < 0) {
        inputFiles.push(f)
        i = inputFiles.length - 1
      }
      return i
    }
    for (const s of segs) s.inIdx = idxOf(s.file)
    const firstExisting = inputFiles.find((f) => fs.existsSync(f)) || ''
    if (!firstExisting) return { ok: false, error: '片段引用的文件都不在了' }
    const probeInfo = (await this.probeVideoInfo(file)) || (await this.probeVideoInfo(firstExisting)) || { width: 1920, height: 1080, fps: 30 }
    const W = Math.max(2, Math.round(probeInfo.width / 2) * 2)
    const H = Math.max(2, Math.round(probeInfo.height / 2) * 2)
    const fps = probeInfo.fps || 30
    // 全部输入都有音轨才能拼出带声音的成片；有一个没有就退化成纯视频（日志里记一笔）
    let hasAudio = true
    for (const f of inputFiles) {
      if (!(await this.probeHasAudio(f))) {
        hasAudio = false
        break
      }
    }
    if (!hasAudio) this.rlog('highlight: some input has no audio -> video only', { inputs: inputFiles.map((f) => path.basename(f)) })
    const onProgress = typeof p.onProgress === 'function' ? p.onProgress : null
    const taskId = p.taskId || ''
    const dir = p.outDir ? path.resolve(String(p.outDir)) : path.dirname(firstExisting)
    const base = path.basename(fs.existsSync(file) ? file : firstExisting).replace(/\.[^.]+$/, '')
    let out = path.join(dir, `${base}_精彩.mp4`)
    if (fs.existsSync(out)) {
      let k = 1
      do {
        out = path.join(dir, `${base}_精彩_${k}.mp4`)
        k += 1
      } while (fs.existsSync(out) && k < 50)
    }
    const total = segs.reduce((a, s) => a + (s.end - s.start), 0)
    const scale = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p`
    const buildFilters = (withAudio) => {
      const f = []
      segs.forEach((s, i) => {
        f.push(`[${s.inIdx}:v]trim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},setpts=PTS-STARTPTS,${scale}[v${i}]`)
      })
      f.push(`${segs.map((_, i) => `[v${i}]`).join('')}concat=n=${segs.length}:v=1:a=0[vout]`)
      if (withAudio) {
        segs.forEach((s, i) => {
          f.push(
            `[${s.inIdx}:a]atrim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},asetpts=PTS-STARTPTS,` +
              `aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`
          )
        })
        f.push(`${segs.map((_, i) => `[a${i}]`).join('')}concat=n=${segs.length}:v=0:a=1[aout]`)
      }
      return f.join(';')
    }
    const runOnce = async (withAudio) => {
      const args = ['-y']
      for (const f of inputFiles) args.push('-i', f)
      args.push('-filter_complex', buildFilters(withAudio), '-map', '[vout]')
      if (withAudio) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '192k')
      args.push(...this.encoderArgs({ encoder }), '-movflags', '+faststart', out)
      if (!onProgress) return this.runFfmpeg(args)
      try {
        onProgress({ taskId, kind: 'highlight', stage: 'render', pct: 0, outTime: 0, total, speed: '' })
      } catch {}
      return this.runFfmpegProgress(args, (st) => {
        const pct = total > 0 ? Math.min(99.9, (st.outTime / total) * 100) : 0
        try {
          onProgress({ taskId, kind: 'highlight', stage: 'render', pct, outTime: st.outTime, total, speed: st.speed })
        } catch {}
      })
    }
    try {
      if (hasAudio) {
        try {
          await runOnce(true)
        } catch (err) {
          this.rlog('highlight audio failed, retry video-only', { err: String((err && err.message) || err).slice(-200) })
          await runOnce(false)
        }
      } else {
        await runOnce(false)
      }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) }
    }
    let size = 0
    try {
      size = fs.statSync(out).size
    } catch {}
    this.rlog('highlight extracted', { file, out, segments: segs.length, size })
    return { ok: true, out, size, segments: segs, duration: Math.round(total * 100) / 100, width: W, height: H, fps }
  }

  /* ------------------------------ 图片片头 ------------------------------ */

  /**
   * 合并导出：片头图（N 秒，可在图上叠字）+ 若干片段（各自裁好的 [start,end]）+ 背景音，一次编码出成片。
   * @param {{image?:string, seconds?:number, items:Array<{file:string,start:number,end:number}>,
   *          texts?:Array<{text:string,x:number,y:number,sizePct:number,color:string,opacity:number}>,
   *          bgm?:{path:string,volume:number}, outDir?:string, encoder?:string, taskId?:string, onProgress?:Function}} p
   */
  async mergeExport(p = {}) {
    const raw = Array.isArray(p.items) ? p.items : []
    const items = []
    for (const it of raw) {
      const f = it && it.file ? path.resolve(String(it.file)) : ''
      if (!f || !fs.existsSync(f)) continue
      const dur = (await this.probeDurationLoose(f)) || 0
      if (!(dur > 0.05)) continue
      const a = Math.max(0, Math.min(dur, Number(it.start) || 0))
      const b = Math.max(0, Math.min(dur, Number(it.end) || dur))
      if (b - a <= 0.05) continue
      items.push({
        file: f,
        start: a,
        end: b,
        dur: b - a,
        // 这一段自己的原声音量（0–2，1 = 原样）；界面上每张卡片一根小滑杆
        volume: Math.max(0, Math.min(2, Number.isFinite(Number(it.volume)) ? Number(it.volume) : 1)),
        hasAudio: await this.probeHasAudio(f)
      })
    }
    if (!items.length) return { ok: false, error: '没有可合并的片段' }

    // 片头图（0 秒 / 没选图 = 不加片头）
    const imgPath = p.image ? path.resolve(String(p.image)) : ''
    const secondsRaw = Number(p.seconds)
    const wantHead = imgPath && fs.existsSync(imgPath) && Number.isFinite(secondsRaw) && secondsRaw >= 0.2
    const seconds = wantHead ? Math.max(0.2, Math.min(60, secondsRaw)) : 0

    const bgmPath = p.bgm && p.bgm.path ? path.resolve(String(p.bgm.path)) : ''
    const bgmVolRaw = p.bgm ? Number(p.bgm.volume) : NaN
    const bgm = bgmPath && fs.existsSync(bgmPath) ? { path: bgmPath, volume: Math.max(0, Math.min(2, Number.isFinite(bgmVolRaw) ? bgmVolRaw : 0.3)) } : null

    const encoder = p.encoder === 'nvenc' ? 'nvenc' : 'x264'
    const onProgress = typeof p.onProgress === 'function' ? p.onProgress : null
    const taskId = p.taskId || ''
    // 片头图上叠的字（多条）：坐标是相对画面的 0..1（文字中心），sizePct = 字号占画面高的百分比
    const texts = (Array.isArray(p.texts) ? p.texts : [])
      .map((t) => ({
        text: String((t && t.text) || ''),
        x: Number(t && t.x),
        y: Number(t && t.y),
        sizePct: Number(t && t.sizePct),
        color: String((t && t.color) || '#ffffff'),
        font: String((t && t.font) || ''),
        opacity: Number.isFinite(Number(t && t.opacity)) ? Number(t.opacity) : 1
      }))
      .filter((t) => t.text && t.text.trim())
    const wantFont = p.font ? path.resolve(String(p.font)) : ''
    const fontPath = (wantFont && fs.existsSync(wantFont) ? wantFont : '') || this.fontPath || findFont()

    // 画面参数按第一个视频来（没有视频就只有图，理论上不会发生）
    const info = (await this.probeVideoInfo(items[0].file)) || { width: 1920, height: 1080, fps: 30 }
    const W = Math.max(2, Math.round(info.width / 2) * 2)
    const H = Math.max(2, Math.round(info.height / 2) * 2)
    const fps = info.fps || 30

    const dir = p.outDir ? path.resolve(String(p.outDir)) : path.dirname(items[0].file)
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {}
    const stamp = (() => {
      const d = new Date()
      const z = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`
    })()
    let out = path.join(dir, `合并_${stamp}.mp4`)
    if (fs.existsSync(out)) {
      let k = 1
      do {
        out = path.join(dir, `合并_${stamp}_${k}.mp4`)
        k += 1
      } while (fs.existsSync(out) && k < 50)
    }

    const total = seconds + items.reduce((a, it) => a + it.dur, 0)
    // 输入顺序：[0] 片头图（可选） → 各视频 → anullsrc → 背景音（可选）
    const videoInputs = []
    const idxOf = (f) => {
      let i = videoInputs.indexOf(f)
      if (i < 0) {
        videoInputs.push(f)
        i = videoInputs.length - 1
      }
      return i
    }
    const srcBase = wantHead ? 1 : 0
    for (const it of items) it.inIdx = srcBase + idxOf(it.file)
    const nullIdx = srcBase + videoInputs.length
    const bgmIdx = bgm ? nullIdx + 1 : -1
    const anyAudio = Boolean(bgm) || items.some((it) => it.hasAudio)

    const scale = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p`
    const buildFilters = (withAudio) => {
      const f = []
      const vlabels = []
      if (wantHead) {
        // 片头图这一路：缩放补边 → 截 N 秒 →（可选）在图上叠若干条文字
        let headLabel = 'vhead0'
        f.push(`[0:v]${scale},trim=duration=${seconds.toFixed(3)},setpts=PTS-STARTPTS[${headLabel}]`)
        if (texts.length) {
          for (let i = 0; i < texts.length; i++) {
            const t = texts[i]
            const next = `vheadtx${i}`
            const sizePct = Math.max(0.5, Math.min(40, Number(t.sizePct) || 6))
            const hex = String(t.color || '#ffffff').replace('#', '')
            const op = Math.max(0.05, Math.min(1, Number.isFinite(Number(t.opacity)) ? Number(t.opacity) : 1))
            const fx = Math.max(0, Math.min(1, Number(t.x)))
            const fy = Math.max(0, Math.min(1, Number(t.y)))
            // 每条字可以有自己的字体文件；没有/不存在就退回全局那个
            const tf = t.font ? path.resolve(t.font) : ''
            const useFont = tf && fs.existsSync(tf) ? tf : fontPath
            f.push(
              `[${headLabel}]drawtext=fontfile='${this.escapeFilterText(useFont)}':text='${this.escapeFilterText(t.text)}'` +
                `:fontcolor=0x${hex}@${op}:fontsize=h*${(sizePct / 100).toFixed(4)}` +
                `:x='w*${fx.toFixed(4)}-text_w/2':y='h*${fy.toFixed(4)}-text_h/2'` +
                `:shadowcolor=black@0.6:shadowx=3:shadowy=3[${next}]`
            )
            headLabel = next
          }
        }
        if (headLabel !== 'vhead') f.push(`[${headLabel}]null[vhead]`)
        vlabels.push('[vhead]')
      }
      items.forEach((it, i) => {
        f.push(`[${it.inIdx}:v]trim=start=${it.start.toFixed(3)}:end=${it.end.toFixed(3)},setpts=PTS-STARTPTS,${scale}[v${i}]`)
        vlabels.push(`[v${i}]`)
      })
      f.push(`${vlabels.join('')}concat=n=${vlabels.length}:v=1:a=0[vout]`)
      if (withAudio) {
        const alabels = []
        if (wantHead) {
          f.push(`[${nullIdx}:a]atrim=duration=${seconds.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[ahead]`)
          alabels.push('[ahead]')
        }
        items.forEach((it, i) => {
          // 每段自己的原声增益（1 = 原样；0.5 = 压一半；1.5 = 放大 1.5 倍）
          const vol = Math.abs((Number(it.volume) || 1) - 1) > 0.001 ? `,volume=${(Number(it.volume) || 1).toFixed(3)}` : ''
          if (it.hasAudio) {
            f.push(
              `[${it.inIdx}:a]atrim=start=${it.start.toFixed(3)}:end=${it.end.toFixed(3)},asetpts=PTS-STARTPTS,` +
                `aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo${vol}[a${i}]`
            )
          } else {
            f.push(
              `[${nullIdx}:a]atrim=duration=${it.dur.toFixed(3)},asetpts=PTS-STARTPTS,` +
                `aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo${vol}[a${i}]`
            )
          }
          alabels.push(`[a${i}]`)
        })
        if (alabels.length > 1) f.push(`${alabels.join('')}concat=n=${alabels.length}:v=0:a=1[voice]`)
        else f.push(`${alabels[0]}anull[voice]`)
        if (bgm) {
          f.push(
            `[${bgmIdx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
              `atrim=duration=${total.toFixed(3)},asetpts=PTS-STARTPTS,volume=${bgm.volume}[bg]`
          )
          f.push('[voice][bg]amix=inputs=2:normalize=0:duration=first[aout]')
        } else {
          f.push('[voice]anull[aout]')
        }
      }
      return f.join(';')
    }

    const runOnce = async (withAudio) => {
      const args = ['-y']
      if (wantHead) args.push('-loop', '1', '-t', String(seconds), '-i', imgPath)
      for (const f of videoInputs) args.push('-i', f)
      // 没音轨的片段 / 片头那段要垫静音，用一条 lavfi 静音源按需 atrim
      args.push('-f', 'lavfi', '-t', total.toFixed(3), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000')
      if (bgm) args.push('-stream_loop', '-1', '-i', bgm.path)
      args.push('-filter_complex', buildFilters(withAudio), '-map', '[vout]')
      if (withAudio) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '192k')
      args.push(...this.encoderArgs({ encoder }), '-movflags', '+faststart', out)
      if (!onProgress) return this.runFfmpeg(args)
      try {
        onProgress({ taskId, kind: 'head', stage: 'render', pct: 0, outTime: 0, total, speed: '' })
      } catch {}
      return this.runFfmpegProgress(args, (st) => {
        const pct = total > 0 ? Math.min(99.9, (st.outTime / total) * 100) : 0
        try {
          onProgress({ taskId, kind: 'head', stage: 'render', pct, outTime: st.outTime, total, speed: st.speed })
        } catch {}
      })
    }

    this.rlog('merge start', {
      out,
      items: items.map((it) => `${path.basename(it.file)}[${it.start.toFixed(2)}-${it.end.toFixed(2)}]`),
      head: wantHead ? { image: path.basename(imgPath), seconds } : null,
      texts: texts.map((t) => `${t.text}@${Number(t.x).toFixed(2)},${Number(t.y).toFixed(2)} x${t.sizePct}% ${t.color}`),
      font: texts.length ? fontPath : '',
      bgm: bgm ? { path: path.basename(bgm.path), volume: bgm.volume } : null,
      audio: anyAudio,
      W,
      H,
      fps,
      total
    })
    try {
      if (anyAudio) {
        try {
          await runOnce(true)
        } catch (err) {
          this.rlog('merge audio failed, retry video-only', { err: String((err && err.message) || err).slice(-300) })
          await runOnce(false)
        }
      } else {
        await runOnce(false)
      }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) }
    }
    let size = 0
    try {
      size = fs.statSync(out).size
    } catch {}
    this.rlog('merge done', { out, size, total })
    return { ok: true, out, size, duration: Math.round(total * 100) / 100, width: W, height: H, fps, pieces: items.length, head: seconds }
  }

  /** 量视频的尺寸和帧率（做片头时要按原片的画面参数生成，否则 concat 会变形/掉帧） */
  probeVideoInfo(file) {
    return new Promise((resolve) => {
      if (!this.ffprobe) return resolve(null)
      const child = spawn(
        this.ffprobe,
        [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=width,height,avg_frame_rate,r_frame_rate',
          '-of',
          'default=nw=1',
          file
        ],
        { windowsHide: true }
      )
      let out = ''
      child.stdout.on('data', (d) => {
        out += d.toString()
      })
      child.on('error', () => resolve(null))
      child.on('close', () => {
        const get = (k) => {
          const m = new RegExp(`^${k}=(.*)$`, 'm').exec(out)
          return m ? m[1].trim() : ''
        }
        const w = Number(get('width'))
        const h = Number(get('height'))
        const parseRate = (v) => {
          const m = /^(\d+)\/(\d+)$/.exec(v)
          if (m && Number(m[2]) > 0) {
            const r = Number(m[1]) / Number(m[2])
            if (Number.isFinite(r) && r > 1 && r < 121) return r
          }
          const n = Number(v)
          return Number.isFinite(n) && n > 1 && n < 121 ? n : 0
        }
        let fps = parseRate(get('avg_frame_rate'))
        if (!fps) fps = parseRate(get('r_frame_rate'))
        if (!Number.isFinite(w) || !Number.isFinite(h) || !w || !h) return resolve(null)
        resolve({ width: w, height: h, fps: fps || 30 })
      })
    })
  }

  /** 视频有没有音轨 */
  probeHasAudio(file) {
    return new Promise((resolve) => {
      if (!this.ffprobe) return resolve(true)
      const child = spawn(this.ffprobe, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file], {
        windowsHide: true
      })
      let out = ''
      child.stdout.on('data', (d) => {
        out += d.toString()
      })
      child.on('error', () => resolve(true))
      child.on('close', () => resolve(out.trim().length > 0))
    })
  }

  /**
   * 给视频前面插 N 秒图片（片头）。
   *
   *   -loop 1 -t N -i 图片  +  -i 原片  +  anullsrc（N 秒静音）
   *   → 图片等比缩放铺满原片分辨率（黑边补齐）→ concat 到原片前面
   *   → 音频：[N 秒静音][原片音轨] concat，保证音画仍然对齐
   *
   * @param {{files:string[], image:string, seconds?:number, encoder?:string,
   *          outDir?:string, taskId?:string, onProgress?:Function}} p
   */
  async prependImage(p = {}) {
    const files = (Array.isArray(p.files) ? p.files : []).map((f) => path.resolve(String(f))).filter((f) => fs.existsSync(f))
    if (!files.length) return { ok: false, error: '没有可处理的视频' }
    const image = path.resolve(String(p.image || ''))
    if (!fs.existsSync(image)) return { ok: false, error: '图片不存在：' + image }
    const seconds = Math.max(0.2, Math.min(60, Number(p.seconds) || 2))
    const encoder = p.encoder === 'nvenc' ? 'nvenc' : 'x264'
    // 可选：中间插一段"精彩片段"、整体再垫一层背景音
    const insPath = p.insert && p.insert.path ? path.resolve(String(p.insert.path)) : ''
    const insert = insPath && fs.existsSync(insPath) ? { path: insPath, dur: (await this.probeDuration(insPath)) || 0 } : null
    const bgmPath = p.bgm && p.bgm.path ? path.resolve(String(p.bgm.path)) : ''
    const bgmVolRaw = p.bgm ? Number(p.bgm.volume) : NaN
    const bgmVol = Math.max(0, Math.min(2, Number.isFinite(bgmVolRaw) ? bgmVolRaw : 0.3))
    const bgm = bgmPath && fs.existsSync(bgmPath) ? { path: bgmPath, volume: bgmVol } : null
    // 可选：正片只保留原片的某一段（粗剪后"只保留选区"）
    const rs = Math.max(0, Number(p.rangeStart) || 0)
    const re = Number(p.rangeEnd) || 0
    const useRange = re - rs > 0.2
    const onProgress = typeof p.onProgress === 'function' ? p.onProgress : null
    const taskId = p.taskId || ''
    const outputs = []
    const failed = []
    const started = Date.now()

    for (let idx = 0; idx < files.length; idx++) {
      const src = files[idx]
      const dir = p.outDir ? path.resolve(String(p.outDir)) : path.dirname(src)
      const base = path.basename(src).replace(/\.[^.]+$/, '')
      let out = path.join(dir, `${base}_片头.mp4`)
      if (fs.existsSync(out)) {
        let k = 1
        do {
          out = path.join(dir, `${base}_片头_${k}.mp4`)
          k += 1
        } while (fs.existsSync(out) && k < 50)
      }
      const info = (await this.probeVideoInfo(src)) || { width: 1920, height: 1080, fps: 30 }
      // 偶数尺寸：编码器要求
      const W = Math.max(2, Math.round(info.width / 2) * 2)
      const H = Math.max(2, Math.round(info.height / 2) * 2)
      const fps = info.fps || 30
      const hasAudio = await this.probeHasAudio(src)
      const srcDur = (await this.probeDuration(src)) || 0
      // 只保留选区：正片长度按选区算（选区超出片长就夹回来）
      const rangeA = useRange ? Math.min(rs, Math.max(0, srcDur - 0.2)) : 0
      const rangeB = useRange ? Math.min(srcDur || re, Math.max(rangeA + 0.2, re)) : srcDur
      const bodyDur = useRange ? Math.max(0.2, rangeB - rangeA) : srcDur || 0
      const insertDur = insert ? insert.dur : 0
      const total = bodyDur + seconds + insertDur
      const grand = total

      const label = `${idx + 1}/${files.length} ${path.basename(src)}`
      this.rlog('prepend start', { src, image, seconds, out, W, H, fps, hasAudio, insert: insert ? insert.path : '', bgm: bgm ? bgm.path : '' })

      const scaleChain = (i) =>
        `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p`
      const bgmIdx = insert ? 4 : 3

      const buildFilters = (withAudio) => {
        const f = []
        f.push(`${scaleChain(0)}[hv]`)
        f.push(`${scaleChain(1)}[bv]`)
        if (insert) f.push(`${scaleChain(3)}[iv]`)
        f.push(insert ? '[hv][iv][bv]concat=n=3:v=1:a=0[vpre]' : '[hv][bv]concat=n=2:v=1:a=0[vpre]')
        if (withAudio) {
          f.push(
            `[2:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${seconds},asetpts=PTS-STARTPTS[ha]`
          )
          f.push(`[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[ba]`)
          if (insert) {
            f.push(`[3:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[ia]`)
            f.push('[ha][ia][ba]concat=n=3:v=0:a=1[voice]')
          } else {
            f.push('[ha][ba]concat=n=2:v=0:a=1[voice]')
          }
          if (bgm) {
            f.push(
              `[${bgmIdx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
                `atrim=duration=${grand.toFixed(3)},asetpts=PTS-STARTPTS,volume=${bgm.volume}[bg]`
            )
            f.push('[voice][bg]amix=inputs=2:normalize=0:duration=first[aout]')
          } else {
            f.push('[voice]anull[aout]')
          }
        }
        f.push('[vpre]null[vout]')
        return f.join(';')
      }

      const runOnce = async (withAudio) => {
        const args = [
          '-y',
          '-loop',
          '1',
          '-t',
          String(seconds),
          '-i',
          image
        ]
        // 只保留选区时，把原片输入裁到 [rangeA, rangeB]（输入侧 -ss/-t，解码到准确位置）
        if (useRange) args.push('-ss', rangeA.toFixed(3), '-t', bodyDur.toFixed(3))
        args.push(
          '-i',
          src,
          '-f',
          'lavfi',
          '-t',
          String(seconds),
          '-i',
          'anullsrc=channel_layout=stereo:sample_rate=48000'
        )
        if (insert) args.push('-i', insert.path)
        // 背景音可能比成片短：循环着喂，再用 atrim 截到成片长度
        if (bgm) args.push('-stream_loop', '-1', '-i', bgm.path)
        args.push('-filter_complex', buildFilters(withAudio), '-map', '[vout]')
        if (withAudio) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '192k')
        args.push(...this.encoderArgs({ encoder }), '-movflags', '+faststart', out)
        if (!onProgress) return this.runFfmpeg(args)
        try {
          onProgress({ taskId, kind: 'head', stage: 'render', pct: 0, outTime: 0, total, speed: '', label })
        } catch {}
        return this.runFfmpegProgress(args, (st) => {
          // 多文件时整体进度 = (已完成 + 当前比例) / 总数
          const one = total > 0 ? Math.max(0, Math.min(1, st.outTime / total)) : 0
          const pct = Math.min(99.9, ((idx + one) / files.length) * 100)
          try {
            onProgress({ taskId, kind: 'head', stage: 'render', pct, outTime: st.outTime, total, speed: st.speed, label })
          } catch {}
        })
      }

      try {
        if (hasAudio) {
          try {
            await runOnce(true)
          } catch (err) {
            this.rlog('prepend audio failed, retry video-only', { err: String((err && err.message) || err).slice(-200) })
            await runOnce(false)
          }
        } else {
          await runOnce(false)
        }
        let size = 0
        try {
          size = fs.statSync(out).size
        } catch {}
        outputs.push({
          src,
          out,
          size,
          seconds,
          width: W,
          height: H,
          fps,
          hasAudio,
          insert: insert ? insert.path : '',
          insertDur: Math.round(insertDur * 100) / 100,
          bgm: bgm ? bgm.path : '',
          keepRange: useRange ? { start: Math.round(rangeA * 100) / 100, end: Math.round(rangeB * 100) / 100 } : null
        })
      } catch (err) {
        failed.push({ src, error: String((err && err.message) || err) })
      }
    }

    const ms = Date.now() - started
    this.rlog('prepend done', { count: outputs.length, failed: failed.length, ms })
    if (onProgress) {
      try {
        onProgress({ taskId, kind: 'head', stage: 'done', pct: failed.length ? Math.round((outputs.length / files.length) * 100) : 100 })
      } catch {}
    }
    if (!outputs.length) return { ok: false, error: failed[0] ? failed[0].error : '全部失败', failed }
    return { ok: true, outputs, failed, ms, seconds }
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
        // 标成"正在停"：不然 ffmpeg 正常退出会被当成"流断了"，还会计划 3 秒后自动续录
        act.stopping = true
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
    // 退出时直接把这一场收尾（合并成 mp4）：不然每次带着录制退出都会留一堆 part，
    // 得等下次启动的 recoverOrphans 才补，用户会以为"录的东西不见了"。
    for (const act of [...this.actives.values()]) {
      if (act.mode !== 'stream') continue
      try {
        this.rlog('dispose finalize session', { dir: act.dir })
        await this.finalizeSession(act, {})
      } catch (err) {
        this.rlog('dispose finalize failed', { dir: act.dir, err: err && err.message })
      }
    }
    // 实在来不及合并的（finalizeSession 失败）分段留着，下次启动 recoverOrphans() 会接走
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
