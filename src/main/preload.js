/**
 * PhantomDesk — Context Bridge (Preload)
 * Exposes secure APIs from main process to renderer.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('phantom', {
  // ── Device Identity ──
  getDeviceId:       () => ipcRenderer.invoke('get-device-id'),
  getHostname:       () => ipcRenderer.invoke('get-hostname'),
  isAdmin:           () => ipcRenderer.invoke('is-admin'),

  // ── Password ──
  getPassword:       () => ipcRenderer.invoke('get-password'),
  refreshPassword:   () => ipcRenderer.invoke('refresh-password'),
  getPasswordEnabled:() => ipcRenderer.invoke('get-password-enabled'),
  setPasswordEnabled:(v) => ipcRenderer.invoke('set-password-enabled', v),

  // ── Screen Capture ──
  getScreenSources:  () => ipcRenderer.invoke('get-screen-sources'),
  getScreenSize:     () => ipcRenderer.invoke('get-screen-size'),
  takeScreenshot:    () => ipcRenderer.invoke('take-screenshot'),

  // ── Input Simulation ──
  simulateInput:     (data) => ipcRenderer.send('simulate-input', data),

  // ── Clipboard ──
  readClipboard:     () => ipcRenderer.invoke('clipboard-read'),
  writeClipboard:    (t) => ipcRenderer.invoke('clipboard-write', t),

  // ── System ──
  getSystemStats:    () => ipcRenderer.invoke('get-system-stats'),
  reboot:            () => ipcRenderer.invoke('sys-reboot'),
  shutdown:          () => ipcRenderer.invoke('sys-shutdown'),
  lock:              () => ipcRenderer.invoke('sys-lock'),

  // ── Process Manager ──
  getProcessList:    () => ipcRenderer.invoke('get-process-list'),
  killProcess:       (pid) => ipcRenderer.invoke('kill-process', pid),

  // ── Terminal ──
  startShell:        () => ipcRenderer.send('shell-start'),
  sendShellInput:    (input) => ipcRenderer.send('shell-input', input),
  onShellData:       (cb) => ipcRenderer.on('shell-data', (_, d) => cb(d)),

  // ── Settings ──
  getSettings:       () => ipcRenderer.invoke('get-settings'),
  setSettings:       (s) => ipcRenderer.invoke('set-settings', s),

  // ── Trusted Devices ──
  getTrustedDevices: () => ipcRenderer.invoke('get-trusted-devices'),
  addTrustedDevice:  (id) => ipcRenderer.invoke('add-trusted-device', id),
  removeTrustedDevice: (id) => ipcRenderer.invoke('remove-trusted-device', id),

  // ── Window Controls ──
  minimize:          () => ipcRenderer.send('window-minimize'),
  maximize:          () => ipcRenderer.send('window-maximize'),
  close:             () => ipcRenderer.send('window-close'),
  isMaximized:       () => ipcRenderer.invoke('is-maximized'),
  focusWindow:       () => ipcRenderer.send('focus-window'),
  logToFile:         (level, msg) => ipcRenderer.send('log-to-file', { level, msg }),
});
