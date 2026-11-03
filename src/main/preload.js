'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('pr', {
  loadState: () => ipcRenderer.invoke('state:load'),
  saveRooms: (rooms) => ipcRenderer.invoke('state:save-rooms', rooms),
  resolveRoom: (raw) => ipcRenderer.invoke('room:resolve', raw),
  reportStreamUrl: (webContentsId, info) => ipcRenderer.invoke('stream:report', webContentsId, info),
  huyaStreams: (url, webContentsId, roomIdHint) => ipcRenderer.invoke('huya:streams', url, webContentsId, roomIdHint),
  prepareRoomPartition: (name) => ipcRenderer.invoke('room:prepare', name),
  openLogin: (target) => ipcRenderer.invoke('login:open', target || 'douyin'),
  clearSession: () => ipcRenderer.invoke('session:clear'),
  openExternal: (url) => ipcRenderer.invoke('external:open', url),

  // 瓦片 guest 的清理 / 对账（防止关掉房间后还有页面在出声）
  killGuest: (webContentsId) => ipcRenderer.invoke('guest:kill', webContentsId),
  syncTileGuests: (ids) => ipcRenderer.invoke('guest:sync', ids),

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
  recChooseDir: (current) => ipcRenderer.invoke('rec:choose-dir', current),
  recPickImage: () => ipcRenderer.invoke('rec:pick-image'),
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
  onOpenHelp: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('ui:open-help', handler)
    return () => ipcRenderer.removeListener('ui:open-help', handler)
  }
})
