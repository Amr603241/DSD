/**
 * PhantomDesk — UI Manager v1.0
 * Handles view switching, toasts, modals, and dashboard updates.
 */
class UIManager {
  constructor() {
    this.views = {};
    document.querySelectorAll('.view').forEach(v => {
      this.views[v.id.replace('view-', '')] = v;
    });

    this.el = {
      idDisplay:    document.getElementById('id-display'),
      pwdDisplay:   document.getElementById('pwd-display'),
      statusDot:    document.getElementById('status-dot'),
      statusLabel:  document.getElementById('status-label'),
      toasts:       document.getElementById('toast-container'),
      logsBox:      document.getElementById('logs-box'),
      modalRequest: document.getElementById('modal-request'),
      modalPassword:document.getElementById('modal-password'),
      reqFromId:    document.getElementById('req-from-id'),
      cpuVal:       document.getElementById('cpu-val'),
      ramVal:       document.getElementById('ram-val'),
      ringCpu:      document.getElementById('ring-cpu'),
      ringRam:      document.getElementById('ring-ram'),
      hostname:     document.getElementById('hostname-label'),
      historyList:  document.getElementById('history-list'),
      termOutput:   document.getElementById('term-output'),
      hudLatency:   document.getElementById('hud-latency'),
      hudFps:       document.getElementById('hud-fps'),
      diagIce:      document.getElementById('diag-ice'),
      diagLatency:  document.getElementById('diag-latency'),
      diagSig:      document.getElementById('diag-sig'),
      diagBitrate:  document.getElementById('diag-bitrate'),
      diagSession:  document.getElementById('diag-session'),
      diagType:     document.getElementById('diag-type'),
      diagNav:      document.getElementById('nav-diag'),
    };

    this._pwdVisible = false;
    this._rawPassword = '';
    this._setupNav();
    this._setupWindowControls();
    this._setupSidebar();
  }

  _setupNav() {
    document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
      btn.addEventListener('click', () => this.switchView(btn.dataset.view));
    });
  }

  _setupWindowControls() {
    const s = (id, fn) => { const b = document.getElementById(id); if (b) b.addEventListener('click', fn); };
    s('btn-minimize', () => window.phantom.minimize());
    s('btn-maximize', () => window.phantom.maximize());
    s('btn-close',    () => window.phantom.close());
  }

  _setupSidebar() {
    const btn = document.getElementById('btn-sidebar-toggle');
    const sidebar = document.getElementById('sidebar');
    if (btn && sidebar) {
      btn.addEventListener('click', () => sidebar.classList.toggle('collapsed'));
    }
  }

  switchView(name) {
    const isSessionActive = !!document.getElementById('nav-session-pulse')?.style.display === 'flex' || document.body.classList.contains('has-active-session');
    
    Object.keys(this.views).forEach(k => {
      const v = this.views[k];
      if (v) { v.classList.toggle('active', k === name); }
    });
    
    document.querySelectorAll('.nav-item').forEach(b => {
      b.classList.toggle('active', b.dataset.view === name);
    });
    
    // Radical Fix: Floating PiP Mode
    if (isSessionActive && name !== 'session' && name !== 'home') {
      document.body.classList.add('pip-mode');
    } else {
      document.body.classList.remove('pip-mode');
    }
    
    // Performance optimization: disable blur effects during active session
    document.body.classList.toggle('view-active-session', name === 'session');
  }

  setDeviceId(id) {
    if (this.el.idDisplay) {
      this.el.idDisplay.innerHTML = `<span class="device-id">${id}</span>`;
    }
  }

  setPassword(pwd) {
    this._rawPassword = pwd;
    if (this.el.pwdDisplay) {
      this.el.pwdDisplay.textContent = this._pwdVisible ? pwd : '••••••';
    }
  }

  togglePasswordVisibility() {
    this._pwdVisible = !this._pwdVisible;
    this.setPassword(this._rawPassword);
    const icon = document.querySelector('#btn-toggle-pwd i');
    if (icon) icon.className = this._pwdVisible ? 'far fa-eye-slash' : 'far fa-eye';
  }

  setConnectionStatus(online) {
    this.updateStatus(online ? 'متصل بالسيرفر' : 'غير متصل', online ? 'online' : 'offline');
  }

  updateStatus(text, type = 'online') {
    if (this.el.statusLabel) this.el.statusLabel.textContent = text;
    if (this.el.statusDot) {
      this.el.statusDot.className = `status-dot ${type}`;
    }
  }

  updatePerformance(stats) {
    const cpu = stats?.cpuLoad || 0;
    const ram = stats?.ramUsage || 0;
    const circumference = 2 * Math.PI * 42; // r=42

    if (this.el.cpuVal) this.el.cpuVal.textContent = `${Math.round(cpu)}%`;
    if (this.el.ramVal) this.el.ramVal.textContent = `${Math.round(ram)}%`;

    if (this.el.ringCpu) {
      this.el.ringCpu.style.strokeDashoffset = circumference - (circumference * cpu / 100);
    }
    if (this.el.ringRam) {
      this.el.ringRam.style.strokeDashoffset = circumference - (circumference * ram / 100);
    }
    if (this.el.hostname && stats?.hostname) {
      this.el.hostname.textContent = stats.hostname;
    }
  }

  updateHUD(latency, fps) {
    if (this.el.hudLatency) this.el.hudLatency.textContent = `${latency} ms`;
    if (this.el.hudFps) this.el.hudFps.textContent = `${fps} FPS`;
  }

  showToast(msg, type = 'info') {
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    this.el.toasts?.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3500);
  }

  addLog(msg, type = 'info') {
    if (!this.el.logsBox) return;
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    entry.innerHTML = `<span class="log-time">[${time}]</span><span class="log-msg">${msg}</span>`;
    this.el.logsBox.prepend(entry);
    if (this.el.logsBox.children.length > 50) this.el.logsBox.lastChild.remove();
  }

  clearLogs() {
    if (this.el.logsBox) this.el.logsBox.innerHTML = '';
  }

  showRequestModal(fromId) {
    if (this.el.reqFromId) this.el.reqFromId.textContent = fromId;
    if (this.el.modalRequest) this.el.modalRequest.classList.add('active');
  }

  hideRequestModal() {
    if (this.el.modalRequest) this.el.modalRequest.classList.remove('active');
  }

  showPasswordModal() {
    if (this.el.modalPassword) this.el.modalPassword.classList.add('active');
  }

  hidePasswordModal() {
    if (this.el.modalPassword) this.el.modalPassword.classList.remove('active');
    const inp = document.getElementById('password-input');
    if (inp) inp.value = '';
  }

  updateDiagStats(stats) {
    if (this.el.diagIce) this.el.diagIce.textContent = stats.iceState || '—';
    if (this.el.diagLatency) this.el.diagLatency.textContent = `${stats.latency || 0} ms`;
    if (this.el.diagSig) this.el.diagSig.textContent = stats.signaling || 'Disconnected';
    if (this.el.diagBitrate) this.el.diagBitrate.textContent = `${stats.bitrate || 0} Kbps`;
    if (this.el.diagSession) this.el.diagSession.textContent = stats.sessionId || '—';
    if (this.el.diagType) this.el.diagType.textContent = stats.peerType || '—';
  }

  addDiagLog(msg, level = 'info') {
    const consoleEl = document.getElementById('diag-console');
    if (!consoleEl || !this.el.diagNav?.classList.contains('active') && level === 'info') return; // Don't render info logs if not looking at diag
    
    requestAnimationFrame(() => {
      const isAtBottom = consoleEl.scrollHeight - consoleEl.clientHeight <= consoleEl.scrollTop + 20;
      
      const line = document.createElement('div');
      line.className = `diag-line ${level}`;
      const ts = new Date().toLocaleTimeString('en-US', { hour12: false, fractionalSecondDigits: 3 });
      line.innerHTML = `<span>${msg}</span><span class="diag-ts">${ts}</span>`;
      
      consoleEl.appendChild(line);
      if (consoleEl.children.length > 100) consoleEl.firstChild.remove();
      if (isAtBottom) consoleEl.scrollTop = consoleEl.scrollHeight;
    });
  }

  appendTerminal(text) {
    if (this.el.termOutput) {
      this.el.termOutput.textContent += text;
      this.el.termOutput.scrollTop = this.el.termOutput.scrollHeight;
    }
  }

  addHistory(deviceId) {
    if (!this.el.historyList) return;
    // Remove empty placeholder
    const empty = this.el.historyList.querySelector('.history-empty');
    if (empty) empty.remove();

    const item = document.createElement('div');
    item.className = 'history-item';
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    item.innerHTML = `
      <span class="h-id">${deviceId}</span>
      <span class="h-time">${time}</span>
      <button class="h-reconnect" data-id="${deviceId}">اتصال</button>
    `;
    this.el.historyList.prepend(item);
  }
}

window.UIManager = UIManager;

