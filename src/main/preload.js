'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('pr', {
  loadState: () => ipcRenderer.invoke('state:load'),
  saveRooms: (rooms) => ipcRenderer.invoke('state:save-rooms', rooms),
  pickLocalFiles: (kind) => ipcRenderer.invoke('local:pick', kind),
  localStat: (files) => ipcRenderer.invoke('local:stat', files),
  resolveRoom: (raw, opts) => ipcRenderer.invoke('room:resolve', raw, opts),
  reportStreamUrl: (webContentsId, info) => ipcRenderer.invoke('stream:report', webContentsId, info),
  huyaStreams: (url, webContentsId, roomIdHint) => ipcRenderer.invoke('huya:streams', url, webContentsId, roomIdHint),
  douyuStreams: (url, webContentsId) => ipcRenderer.invoke('douyu:streams', url, webContentsId),
  prepareRoomPartition: (name) => ipcRenderer.invoke('room:prepare', name),
  openLogin: (target) => ipcRenderer.invoke('login:open', target || 'douyin'),
  clearSession: () => ipcRenderer.invoke('session:clear'),
  openExternal: (url) => ipcRenderer.invoke('external:open', url),

  // 瓦片 guest 的清理 / 对账（防止关掉房间后还有页面在出声）
  killGuest: (webContentsId) => ipcRenderer.invoke('guest:kill', webContentsId),
  syncTileGuests: (ids) => ipcRenderer.invoke('guest:sync', ids),

  /** 关于窗口：版本 / Electron / Chromium / Node / 随包 ffmpeg / 数据目录 */
  appInfo: () => ipcRenderer.invoke('app:info'),

  /** 当前登录的账号（抖音 / 虎牙各自登没登、昵称、uid）；{ fast: true } 只读 cookie 不请求接口 */
  loginStatus: (opts) => ipcRenderer.invoke('login:status', opts || {}),

  // 调试页：资源快照 / 保存快照 / 手工释放
  debugSnapshot: () => ipcRenderer.invoke('debug:snapshot'),
  debugSave: (payload) => ipcRenderer.invoke('debug:save', payload),
  debugRelease: (webContentsId) => ipcRenderer.invoke('debug:release', webContentsId),

  // 监控列表
  loadWatchers: () => ipcRenderer.invoke('watchers:load'),
  addWatcher: (raw) => ipcRenderer.invoke('watchers:add', raw),
  removeWatcher: (id) => ipcRenderer.invoke('watchers:remove', id),
  toggleSpecial: (id) => ipcRenderer.invoke('watchers:toggle-special', id),
  reportRoomStatus: (payload) => ipcRenderer.invoke('watchers:report-status', payload),
  probeWatchers: (ids) => ipcRenderer.invoke('watchers:probe-now', ids),
  setProbeInterval: (ms) => ipcRenderer.invoke('watchers:set-interval', ms),
  onWatchersChanged: (cb) => {
    const handler = (event, payload) => cb(payload)
    ipcRenderer.on('watchers:changed', handler)
    return () => ipcRenderer.removeListener('watchers:changed', handler)
  },

  // 录制
  startRecording: (params) => ipcRenderer.invoke('rec:start', params),
  stopRecording: (uid) => ipcRenderer.invoke('rec:stop', uid),
  splitRecording: (uid) => ipcRenderer.invoke('rec:split', uid),
  /** 边看边截：把最近 N 秒存成精彩片段（不停止录制） */
  recSnapshot: (payload) => ipcRenderer.invoke('rec:snapshot', payload),
  /** 本地视频：按当前播放进度截一段（不用录制） */
  recClipFile: (payload) => ipcRenderer.invoke('rec:clip-file', payload),
  /** 全屏小窗：列这一场的精彩/精修片段 */
  recListClips: (dir) => ipcRenderer.invoke('rec:list-clips', dir),
  /** 全屏小窗：最近一场有精彩片段的录制目录 */
  recLastClipsDir: () => ipcRenderer.invoke('rec:last-clips-dir'),
  /** 全屏小窗：按任意左右两端另存一个精修片段 */
  recClipRange: (payload) => ipcRenderer.invoke('rec:clip-range', payload),
  /** 量一个文件的时长（精彩片段列表加本地文件时用） */
  recProbeDuration: (file) => ipcRenderer.invoke('rec:probe-duration', file),
  stopAllRecording: () => ipcRenderer.invoke('rec:stop-all'),
  recPing: () => ipcRenderer.invoke('rec:ping'),
  recMode: (webContentsId) => ipcRenderer.invoke('rec:mode', webContentsId),
  recOutDir: () => ipcRenderer.invoke('rec:out-dir'),
  chooseRecDir: () => ipcRenderer.invoke('rec:choose-out-dir'),
  recGetOptions: () => ipcRenderer.invoke('rec:get-options'),
  recSetOptions: (opts) => ipcRenderer.invoke('rec:set-options', opts),
  recList: (dir) => ipcRenderer.invoke('rec:list', dir),
  recMerge: (payload) => ipcRenderer.invoke('rec:merge', payload),
  recApplyWatermark: (payload) => ipcRenderer.invoke('rec:apply-watermark', payload),
  recRenderMosaic: (payload) => ipcRenderer.invoke('rec:render-mosaic', payload),
  recPrependImage: (payload) => ipcRenderer.invoke('rec:prepend-image', payload),
  recAnalyzeHighlights: (payload) => ipcRenderer.invoke('rec:analyze-highlights', payload),
  recExtractHighlights: (payload) => ipcRenderer.invoke('rec:extract-highlights', payload),
  /** 合并导出：片头图（N 秒）+ 各片段（含裁剪）+ 背景音，一次编码出成片 */
  recMergeExport: (payload) => ipcRenderer.invoke('rec:merge-export', payload),
  /** 拼接导出的进度回调：{ stage, pct, outTime, total, speed } */
  onMosaicProgress: (cb) => {
    const handler = (_event, p) => cb(p)
    ipcRenderer.on('rec:mosaic-progress', handler)
    return () => ipcRenderer.removeListener('rec:mosaic-progress', handler)
  },
  recChooseDir: (current) => ipcRenderer.invoke('rec:choose-dir', current),
  recPickImage: () => ipcRenderer.invoke('rec:pick-image'),
  /** 图片文字：把「片头图 + 文字」导出成 PNG（保存对话框） */
  headSavePng: (payload) => ipcRenderer.invoke('head:save-png', payload),
  /** 删掉一个精彩片段文件（只允许录制目录里的视频文件） */
  recDeleteFile: (filePath) => ipcRenderer.invoke('rec:delete-file', filePath),
  recListFonts: () => ipcRenderer.invoke('rec:list-fonts'),
  recPickFont: () => ipcRenderer.invoke('rec:pick-font'),
  recReveal: (filePath) => ipcRenderer.invoke('rec:reveal', filePath),

  // 窗口
  toggleFullscreen: () => ipcRenderer.invoke('win:toggle-fullscreen'),
  isFullscreen: () => ipcRenderer.invoke('win:is-fullscreen'),
  onFullscreen: (cb) => {
    const handler = (event, isFull) => cb(isFull)
    ipcRenderer.on('win:fullscreen', handler)
    return () => ipcRenderer.removeListener('win:fullscreen', handler)
  },
  onRecState: (cb) => {
    const handler = (event, payload) => cb(payload)
    ipcRenderer.on('rec:state', handler)
    return () => ipcRenderer.removeListener('rec:state', handler)
  },
  onRecordingHotkey: (cb) => {
    const handler = (event, payload) => cb(payload)
    ipcRenderer.on('rec:hotkey', handler)
    return () => ipcRenderer.removeListener('rec:hotkey', handler)
  },
  onToggleBar: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('ui:toggle-bar', handler)
    return () => ipcRenderer.removeListener('ui:toggle-bar', handler)
  },
  /** 全屏时 F8 开关「精彩片段小窗」（主进程 before-input-event 截获，焦点在页面里也有效） */
  onToggleClipsWin: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('ui:toggle-clipswin', handler)
    return () => ipcRenderer.removeListener('ui:toggle-clipswin', handler)
  },
  /** 告诉主进程"小窗现在开着"：开着才拦 [ ] 两个键（焦点在瓦片页面里也有效） */
  setClipsWinOpen: (open) => ipcRenderer.send('ui:clips-win-state', !!open),
  /** 主进程转过来的 [ / ]（起点 / 终点） */
  onClipsKey: (cb) => {
    const handler = (_e, key) => cb(key)
    ipcRenderer.on('ui:clips-key', handler)
    return () => ipcRenderer.removeListener('ui:clips-key', handler)
  },
  onOpenHelp: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('ui:open-help', handler)
    return () => ipcRenderer.removeListener('ui:open-help', handler)
  },
  /** 登录窗关掉了（扫码登录完关窗 → 重新读一次账号状态） */
  onLoginClosed: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('ui:login-closed', handler)
    return () => ipcRenderer.removeListener('ui:login-closed', handler)
  }
})
