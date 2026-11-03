'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('recapi', {
  onCommand: (cb) => ipcRenderer.on('rec:command', (event, cmd) => cb(cmd)),
  ready: (info) => ipcRenderer.send('rec:ready', info),
  // sid：分段时新旧两路同时存在，主进程要靠它把数据分流到各自的文件
  chunk: (buf, sid) => ipcRenderer.send('rec:chunk', buf, sid),
  done: (info) => ipcRenderer.send('rec:done', info),
  fail: (msg, sid) => ipcRenderer.send('rec:fail', String(msg), sid)
})
