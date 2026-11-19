'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('wipeout', {
  appInfo: () => ipcRenderer.invoke('app-info'),
  pickFolder: (purpose) => ipcRenderer.invoke('pick-folder', purpose),
  pathForFile: (file) => webUtils.getPathForFile(file),
  inspect: (p) => ipcRenderer.invoke('inspect', p),
  scan: (p) => ipcRenderer.invoke('scan', p),
  findLocks: (p) => ipcRenderer.invoke('find-locks', p),
  findArtifacts: (root) => ipcRenderer.invoke('find-artifacts', root),
  wipeMany: (targets) => ipcRenderer.invoke('wipe-many', targets),
  kill: (pid) => ipcRenderer.invoke('kill', pid),
  wipe: (p) => ipcRenderer.invoke('wipe', p),
  cancel: () => ipcRenderer.invoke('cancel'),
  openVSCode: (p) => ipcRenderer.invoke('open-vscode', p),
  openBrowser: (url) => ipcRenderer.invoke('open-browser', url),
  reveal: (p) => ipcRenderer.invoke('reveal', p),
  contextMenuStatus: () => ipcRenderer.invoke('context-menu-status'),
  setContextMenu: (on) => ipcRenderer.invoke('context-menu-set', on),
  relaunchAsAdmin: (p) => ipcRenderer.invoke('relaunch-admin', p),
  openLogs: () => ipcRenderer.invoke('open-logs'),
  onWindowFocus: (cb) => ipcRenderer.on('window-focus', () => cb()),
  onJob: (cb) => ipcRenderer.on('job', (_e, m) => cb(m)),
  onOpenFolder: (cb) => ipcRenderer.on('open-folder', (_e, p) => cb(p)),
});
