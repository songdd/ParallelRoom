'use strict'

/**
 * 录制页面的逻辑：拿到窗口捕获流 → 按瓦片矩形裁剪到 canvas → MediaRecorder 编码 → 分片回传主进程。
 *
 * 音频只有一路「系统混音」（Windows loopback），这是平台限制，见 README。
 */

let videoEl = null
let canvasEl = null
let ctx = null
let mediaStream = null
let rec = null
let timerId = 0
let drawing = false
let cfg = null
let startedAt = 0
/** 本路录制的 sessionId（分段时新旧两路并存，主进程靠它分流） */
let sessionId = ''
let lastFrameAt = 0
let frames = 0

const frameInterval = () => 1000 / (cfg && cfg.fps ? cfg.fps : 20)

function cleanup() {
  stopDrawing()
  if (rec && rec.state !== 'inactive') {
    try {
      rec.stop()
    } catch {}
  }
  rec = null
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) {
      try {
        track.stop()
      } catch {}
    }
  }
  mediaStream = null
  if (videoEl) {
    videoEl.srcObject = null
  }
}

function stopDrawing() {
  drawing = false
  if (timerId) {
    clearTimeout(timerId)
    timerId = 0
  }
}

/**
 * 用定时器而不是 requestAnimationFrame：recorder 是隐藏窗口，
 * rAF 会被节流到 ~1fps（实测 13 秒只画出 14 帧）。定时器在
 * backgroundThrottling:false 下能稳定按目标帧率跑。
 */
function tick() {
  if (!drawing) return
  try {
    drawFrameOnce()
  } catch (err) {
    window.recapi.fail('drawFrame 失败: ' + (err && err.message))
    stopDrawing()
    return
  }
  timerId = setTimeout(tick, Math.max(20, frameInterval()))
}

function drawFrameOnce() {
  if (!ctx || !videoEl || !cfg || !videoEl.videoWidth) return

  const scale = cfg.contentWidth ? videoEl.videoWidth / cfg.contentWidth : 1
  const vw = videoEl.videoWidth
  const vh = videoEl.videoHeight

  // 单一矩形（单瓦片录制）
  if (!cfg.rects || !cfg.rects.length) {
    const r = cfg.rect
    const sx = Math.max(0, Math.round(r.x * scale))
    const sy = Math.max(0, Math.round(r.y * scale))
    let sw = Math.min(Math.round(r.width * scale), Math.max(1, vw - sx))
    let sh = Math.min(Math.round(r.height * scale), Math.max(1, vh - sy))
    sw -= sw % 2
    sh -= sh % 2
    if (sw < 2 || sh < 2) return
    if (canvasEl.width !== sw || canvasEl.height !== sh) {
      canvasEl.width = sw
      canvasEl.height = sh
    }
    ctx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, sw, sh)
    frames += 1
    lastFrameAt = performance.now()
    return
  }

  // 多矩形（整窗录制只取各瓦片的视频区）：按原布局拼成无间隙、无标题栏的网格
  const rects = cfg.rects
  const xs = [...new Set(rects.map((r) => Math.round(r.x)))].sort((a, b) => a - b)
  const ys = [...new Set(rects.map((r) => Math.round(r.y)))].sort((a, b) => a - b)
  const cellW = Math.max(...rects.map((r) => Math.round(r.width)))
  const cellH = Math.max(...rects.map((r) => Math.round(r.height)))

  let canvasW = Math.round(cellW * xs.length * scale)
  let canvasH = Math.round(cellH * ys.length * scale)
  canvasW -= canvasW % 2
  canvasH -= canvasH % 2
  if (canvasW < 2 || canvasH < 2) return

  if (canvasEl.width !== canvasW || canvasEl.height !== canvasH) {
    canvasEl.width = canvasW
    canvasEl.height = canvasH
  }

  const dw = Math.round(cellW * scale)
  const dh = Math.round(cellH * scale)

  for (const r of rects) {
    const col = xs.indexOf(Math.round(r.x))
    const row = ys.indexOf(Math.round(r.y))
    const sx = Math.max(0, Math.round(r.x * scale))
    const sy = Math.max(0, Math.round(r.y * scale))
    const sw = Math.min(Math.round(r.width * scale), Math.max(1, vw - sx))
    const sh = Math.min(Math.round(r.height * scale), Math.max(1, vh - sy))
    if (sw < 2 || sh < 2) continue
    const dx = Math.round(col * cellW * scale)
    const dy = Math.round(row * cellH * scale)
    ctx.drawImage(videoEl, sx, sy, sw, sh, dx, dy, Math.min(dw, canvasW - dx), Math.min(dh, canvasH - dy))
  }

  frames += 1
  lastFrameAt = performance.now()
}

async function start(options) {
  // 上一路（分段前那一路）如果还没彻底收尾，先清干净再开新的
  if (rec || mediaStream) cleanup()
  cfg = options
  sessionId = options.sessionId || ''
  videoEl = document.getElementById('src')
  canvasEl = document.getElementById('cv')
  ctx = canvasEl.getContext('2d', { alpha: false })

  try {
    mediaStream = await navigator.mediaDevices.getDisplayMedia({
      // cursor:'never'：不要把鼠标指针画进画面（整窗录制时鼠标划过会被录进去）
      video: { frameRate: cfg.fps || 20, cursor: 'never' },
      audio: true
    })
    // 有些 Chromium 版本只认 applyConstraints，补一刀再看结果
    try {
      const vt = mediaStream.getVideoTracks()[0]
      if (vt && vt.getSettings && vt.getSettings().cursor !== 'never') {
        await vt.applyConstraints({ cursor: 'never' }).catch(() => {})
      }
      const s = vt && vt.getSettings ? vt.getSettings() : {}
      window.recapi.ready({ cursorMode: s.cursor || '(不支持)' })
    } catch {}
  } catch (err) {
    window.recapi.fail('getDisplayMedia 失败: ' + (err && err.message), sessionId)
    return
  }

  const videoTrack = mediaStream.getVideoTracks()[0]
  if (!videoTrack) {
    window.recapi.fail('没有拿到视频轨道', sessionId)
    return
  }
  // 用户点“停止共享”时也要收尾
  videoTrack.addEventListener('ended', () => {
    if (rec && rec.state !== 'inactive') stop()
  })

  videoEl.srcObject = mediaStream
  try {
    await videoEl.play()
  } catch (err) {
    window.recapi.fail('video.play 失败: ' + (err && err.message))
    return
  }

  // 先画一帧确定裁剪尺寸，再起编码
  lastFrameAt = 0
  drawFrameOnce()
  drawing = true
  timerId = setTimeout(tick, Math.max(20, frameInterval()))

  const canvasStream = canvasEl.captureStream(cfg.fps || 20)
  const tracks = [...canvasStream.getVideoTracks(), ...mediaStream.getAudioTracks()]

  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
    ? 'video/webm;codecs=vp9,opus'
    : 'video/webm;codecs=vp8,opus'

  rec = new MediaRecorder(new MediaStream(tracks), {
    mimeType: mime,
    videoBitsPerSecond: cfg.bitrate || 4_000_000,
    audioBitsPerSecond: 128_000
  })

  // 把这一路的 sid 固定下来：分段时新旧两路并存，收尾晚到也不能算到别人头上
  const mySid = sessionId
  const myStartedAt = Date.now()

  rec.ondataavailable = async (event) => {
    if (!event.data || !event.data.size) return
    const buf = await event.data.arrayBuffer()
    window.recapi.chunk(buf, mySid)
  }

  rec.onstop = () => {
    window.recapi.done({
      sid: mySid,
      ms: Date.now() - myStartedAt,
      frames,
      mime
    })
  }

  rec.start(1000)
  startedAt = myStartedAt

  window.recapi.ready({
    sid: mySid,
    videoWidth: videoEl.videoWidth,
    videoHeight: videoEl.videoHeight,
    canvasWidth: canvasEl.width,
    canvasHeight: canvasEl.height,
    hasAudio: mediaStream.getAudioTracks().length > 0,
    mime
  })
}

function stop() {
  stopDrawing()
  if (rec && rec.state !== 'inactive') {
    try {
      rec.stop()
    } catch (err) {
      window.recapi.fail('stop 失败: ' + (err && err.message))
    }
  }
}

window.recapi.onCommand((cmd) => {
  if (cmd && cmd.type === 'start') {
    start(cmd).catch((err) => window.recapi.fail(err && err.message))
  } else if (cmd && cmd.type === 'stop') {
    stop()
  }
})

// 主进程会用 executeJavaScript(..., userGesture=true) 调用这两个入口，
// 以满足 getDisplayMedia 对“用户手势”的要求。
window.__recStart = (options) => {
  start(options).catch((err) => window.recapi.fail(err && err.message))
}
window.__recStop = () => stop()

window.addEventListener('beforeunload', cleanup)
