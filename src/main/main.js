const { app, BrowserWindow, ipcMain, desktopCapturer, session, clipboard, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec, spawn } = require('child_process');

// ── Global Logger ──
function writeToLog(msg) {
  try {
    const logPath = path.join(app.getPath('userData'), 'debug.log');
    const ts = new Date().toISOString();
    fs.appendFileSync(logPath, `[${ts}] ${msg}\n`);
  } catch(e) {}
}

ipcMain.on('log-to-file', (event, { level, msg }) => {
  const devId = process.argv.find(a => a.startsWith('--device-id='))?.split('=')[1] || 'AUTO';
  writeToLog(`[${devId}] [${level.toUpperCase()}] ${msg}`);
});

// ── Dependency Manager ──
let storeInstance = null;
async function getStore() {
  if (storeInstance) return storeInstance;
  const { default: ElectronStore } = await import('electron-store');
  storeInstance = new ElectronStore({ name: 'phantomdesk-config' });
  return storeInstance;
}

// ── Essential Flags ──
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('allow-loopback-in-peer-connection');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('allow-http-screen-capture');
app.commandLine.appendSwitch('disable-background-timer-throttling');

// ── App Initialization ──
const deviceIdArg = process.argv.find(a => a.startsWith('--device-id='));
if (deviceIdArg) {
  const customId = deviceIdArg.split('=')[1];
  const userDataPath = path.join(app.getPath('userData'), '..', `phantomdesk-${customId}`);
  if (!fs.existsSync(userDataPath)) fs.mkdirSync(userDataPath, { recursive: true });
  app.setPath('userData', userDataPath);
}

let mainWindow;
let inputHandler = null;

try {
  inputHandler = require('./input-handler');
  console.log('[✓] Native input handler ready');
} catch (e) { console.error('[✗] Input handler offline'); }

async function getDeviceId() {
  const idArg = process.argv.find(a => a.startsWith('--device-id='));
  if (idArg) return idArg.split('=')[1];

  const store = await getStore();
  let id = store.get('deviceId');
  if (!id) {
    id = Math.floor(100000000 + Math.random() * 900000000).toString();
    store.set('deviceId', id);
  }
  return id;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1060, height: 720,
    minWidth: 860, minHeight: 620,
    frame: false, backgroundColor: '#07080f',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── IPC Handlers ──
ipcMain.handle('get-device-id', () => getDeviceId());
ipcMain.handle('get-hostname', () => require('os').hostname());
ipcMain.handle('is-admin', () => new Promise(r => exec('net session', e => r(!e))));

ipcMain.handle('get-password', async () => {
  const store = await getStore();
  let pwd = store.get('password');
  if (!pwd) { pwd = crypto.randomBytes(3).toString('hex').toUpperCase(); store.set('password', pwd); }
  return pwd;
});

ipcMain.handle('refresh-password', async () => {
  const store = await getStore();
  const pwd = crypto.randomBytes(3).toString('hex').toUpperCase();
  store.set('password', pwd);
  return pwd;
});

ipcMain.handle('get-password-enabled', async () => (await getStore()).get('passwordEnabled') !== false);
ipcMain.handle('set-password-enabled', async (_, v) => (await getStore()).set('passwordEnabled', v));

ipcMain.handle('get-screen-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
    return sources.map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
  } catch { return []; }
});

ipcMain.handle('get-screen-size', () => {
  const d = screen.getPrimaryDisplay();
  return { width: d.size.width, height: d.size.height, scaleFactor: d.scaleFactor };
});

ipcMain.on('simulate-input', (_, data) => { if (inputHandler) inputHandler.handleInput(data); });

// ── Clipboard IPC ──
ipcMain.handle('clipboard-read', () => clipboard.readText());
ipcMain.handle('clipboard-write', (_, t) => clipboard.writeText(t));

// ── System IPC ──
ipcMain.handle('sys-lock', () => {
  if (process.platform === 'win32') exec('rundll32.exe user32.dll,LockWorkStation');
});
ipcMain.handle('sys-reboot', () => {
  if (process.platform === 'win32') exec('shutdown /r /t 0');
});
ipcMain.handle('sys-shutdown', () => {
  if (process.platform === 'win32') exec('shutdown /s /t 0');
});

ipcMain.handle('take-screenshot', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: screen.getPrimaryDisplay().size });
  if (sources.length > 0) return sources[0].thumbnail.toDataURL();
  return null;
});

// Real System Stats (Simplified)
ipcMain.handle('get-system-stats', async () => {
  const os = require('os');
  const cpu = os.loadavg()[0] * 10 || Math.random() * 5; // Simplified CPU load
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const ram = ((totalMem - freeMem) / totalMem) * 100;
  return { cpuLoad: cpu, ramUsage: ram, hostname: os.hostname() };
});

// ── Terminal Shell Logic ──
let shellProcess = null;
ipcMain.on('shell-start', (event) => {
  if (shellProcess) shellProcess.kill();
  shellProcess = spawn('cmd.exe');
  shellProcess.stdout.on('data', (data) => event.reply('shell-data', data.toString()));
  shellProcess.stderr.on('data', (data) => event.reply('shell-data', data.toString()));
  shellProcess.on('exit', () => event.reply('shell-data', '\n[Terminal Session Ended]\n'));
});
ipcMain.on('shell-input', (_, input) => {
  if (shellProcess) shellProcess.stdin.write(input);
});

ipcMain.handle('get-settings', async () => (await getStore()).get('settings') || { quality: 'balanced', serverUrl: '' });
ipcMain.handle('set-settings', async (_, s) => (await getStore()).set('settings', s));

ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => { if (mainWindow) mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); });
ipcMain.on('window-close', () => mainWindow?.close());
ipcMain.handle('is-maximized', () => mainWindow?.isMaximized() || false);

// ── App Lifecycle ──
app.whenReady().then(() => {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then(sources => {
      const screen = sources.find(s => s.id.startsWith('screen:') || s.name.toLowerCase().includes('entire') || s.name.toLowerCase().includes('screen 1') || s.name.includes('شاشة 1')) || sources[0];
      callback(screen ? { video: screen } : {});
    }).catch(() => callback({}));
  });
  createWindow();
});
app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
