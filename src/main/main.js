const { app, BrowserWindow, ipcMain, desktopCapturer, session, clipboard, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
// ── App Initialization (Must be before Single Instance Lock) ──
const deviceIdArg = process.argv.find(a => a.startsWith('--device-id='));
if (deviceIdArg) {
  const customId = deviceIdArg.split('=')[1];
  const userDataPath = path.join(app.getPath('userData'), '..', `phantomdesk-${customId}`);
  if (!fs.existsSync(userDataPath)) fs.mkdirSync(userDataPath, { recursive: true });
  app.setPath('userData', userDataPath);
}

// ── Fix Black Screen Issues / Performance ──
const userData = app.getPath('userData');
const configPath = path.join(userData, 'phantomdesk-config.json');
let disableHW = false;
try {
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config.settings && config.settings.hwAccel === false) disableHW = true;
  }
} catch(e) {}

if (disableHW) {
  app.disableHardwareAcceleration();
  console.log('[!] Hardware Acceleration: Disabled (Compatibility Mode)');
} else {
  console.log('[✓] Hardware Acceleration: Enabled (Turbo Mode)');
}

// ── Single Instance Lock ──
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ── Global Logger ──
function writeToLog(msg) {
  try {
    const logPath = path.join(app.getPath('userData'), 'debug.log');
    const ts = new Date().toISOString();
    fs.appendFileSync(logPath, `[${ts}] ${msg}\n`);
    console.log(`[LOG] ${msg}`);
  } catch(e) {}
}

// Catch Uncaught Exceptions
process.on('uncaughtException', (error) => {
  writeToLog(`[FATAL ERROR] Uncaught Exception: ${error.message}\n${error.stack}`);
});

ipcMain.on('log-to-file', (event, { level, msg }) => {
  writeToLog(`[${level.toUpperCase()}] ${msg}`);
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

// ── App Configuration Flags ──

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

// ── Protocol Support ──
if (process.defaultApp) {
  if (process.argv.length >= 2) app.setAsDefaultProtocolClient('phantomdesk', process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient('phantomdesk');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1060, height: 720,
    minWidth: 860, minHeight: 620,
    frame: false, backgroundColor: '#07080f',
    show: false,
    icon: path.join(__dirname, '../assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false
    }
  });

  // Handle Protocol Args
  const deepLink = process.argv.find(arg => arg.startsWith('phantomdesk://'));
  if (deepLink) {
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow.webContents.send('protocol-link', deepLink);
    });
  }

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

// Real System Stats (Windows Compatible)
ipcMain.handle('get-system-stats', async () => {
  const os = require('os');
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const ram = ((totalMem - freeMem) / totalMem) * 100;
  
  // CPU usage approximation for Windows
  const cpus = os.cpus();
  let totalIdle = 0, totalTick = 0;
  cpus.forEach(core => {
    for (type in core.times) totalTick += core.times[type];
    totalIdle += core.times.idle;
  });
  const cpu = 100 - (100 * totalIdle / totalTick);

  // Simulated Net/Disk for UI demonstration (requires admin/pdh for real ones)
  const net = Math.random() * 20 + 5;
  const disk = Math.random() * 15 + 2;

  return { 
    cpuLoad: cpu, 
    ramUsage: ram, 
    netLoad: net, 
    diskLoad: disk, 
    hostname: os.hostname() 
  };
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
  createWindow();
});
app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
