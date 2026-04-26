/**
 * PhantomDesk — Application Core Elite v1.3
 * Fixed Syntax Error (Optional Chaining Assignment) and restored functionality.
 */

const SIGNALING_SERVER = 'https://dsd-1.onrender.com';

(async function initPhantomDesk() {
  console.log('[PHANTOM] Initializing Elite Engine...');

  const ui = new UIManager();
  const signaling = new SignalingClient(SIGNALING_SERVER);
  const $ = (id) => document.getElementById(id);

  const log = (msg, type = 'info') => {
    console.log(`[${type.toUpperCase()}] ${msg}`);
    ui.addLog(msg, type);
    ui.addDiagLog(msg, type === 'error' ? 'error' : type === 'warning' ? 'warn' : 'info');
    window.phantom.logToFile(type, msg);
  };

  // ── State ──
  const state = {
    deviceId: '',
    password: '',
    isHost: false,
    connected: false,
    sessions: new Map(),
    activeSessionId: null,
    lastClipboard: '',
    incomingRequest: null,
    pendingTargetId: null
  };

  // ── Handle Protocol Links ──
  window.phantom.onProtocolLink((link) => {
    const parts = link.split('/');
    const targetId = parts[parts.length - 1];
    if (targetId && /^\d+$/.test(targetId)) {
      log(`رابط اتصال سريع مكتشف للجهاز: ${targetId}`, 'success');
      $('remote-id-input').value = targetId;
      signaling.sendRequest(targetId);
    }
  });

  class Session {
    constructor(id, deviceId, rtc) {
      this.id = id;
      this.deviceId = deviceId;
      this.rtc = rtc;
      this.stream = null;
    }
  }

  const sessionManager = {
    add(socketId, deviceId, rtcInstance) {
      const s = new Session(socketId, deviceId, rtcInstance);
      state.sessions.set(socketId, s);
      addToHistory(deviceId);
      this.renderTabs();
      this.switch(socketId);
      return s;
    },
    remove(socketId) {
      const s = state.sessions.get(socketId);
      if (s) {
        s.rtc.close();
        state.sessions.delete(socketId);
        
        // Hide Session Pulse if no sessions left
        if (state.sessions.size === 0) {
          document.body.classList.remove('has-active-session', 'pip-mode');
          const pulseNav = $('nav-session-pulse');
          if (pulseNav) pulseNav.style.display = 'none';
        }

        if (state.activeSessionId === socketId) {
          state.activeSessionId = null;
          const next = state.sessions.keys().next().value;
          if (next) this.switch(next);
          else ui.switchView('home');
        }
        this.renderTabs();
      }
    },
    switch(socketId) {
      const s = state.sessions.get(socketId);
      if (!s) return;
      state.activeSessionId = socketId;
      
      const video = $('remote-video');
      if (video && s.stream) {
        log(`إعادة ربط دفق الجلسة: ${s.deviceId}...`);
        if (video.srcObject !== s.stream) video.srcObject = s.stream;
        
        video.play().then(() => {
          $('video-overlay').style.display = 'none';
        }).catch(() => {
          log('بانتظار تفاعل المستخدم لبدء الفيديو', 'warning');
          $('video-overlay').style.display = 'flex';
        });
      }
      
      this.renderTabs();
      ui.switchView('session');
    },
    renderTabs() {
      const container = $('session-tabs');
      if (!container) return;
      container.innerHTML = '';
      state.sessions.forEach((s, id) => {
        const tab = document.createElement('div');
        tab.className = `session-tab ${id === state.activeSessionId ? 'active' : ''}`;
        tab.innerHTML = `<span>${s.deviceId}</span><i class="fas fa-times tab-close" data-id="${id}"></i>`;
        tab.onclick = (e) => {
          if (e.target.classList.contains('tab-close')) this.remove(id);
          else this.switch(id);
        };
        container.appendChild(tab);
      });
      const addBtn = document.createElement('button');
      addBtn.className = 'btn-new-session';
      addBtn.innerHTML = '<i class="fas fa-plus"></i>';
      addBtn.onclick = () => ui.switchView('home');
      container.appendChild(addBtn);
    }
  };

  function resetConnectButton() {
    const btn = $('btn-connect');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-bolt"></i> اتصال'; }
  }

  // ── 1. Identity ──
  try {
    state.deviceId = await window.phantom.getDeviceId();
    state.password = await window.phantom.getPassword();
    ui.setDeviceId(state.deviceId);
    ui.setPassword(state.password);
  } catch (e) {}

  // ── 2. Signaling ──
  async function connectToServer() {
    try {
      await signaling.connect(state.deviceId, state.password);
      state.connected = true;
      ui.setConnectionStatus(true);
      log('تم الاتصال بسيرفر الإشارات ✓');
    } catch (e) {
      state.connected = false;
      ui.setConnectionStatus(false);
      log('جاري محاولة الاتصال بالسيرفر...', 'warning');
      setTimeout(connectToServer, 5000);
    }
  }
  connectToServer();

  signaling.on('connection-error', (data) => {
    log(data.message || 'خطأ في الاتصال', 'error');
    resetConnectButton();
    if (data.code === 'NEED_PASSWORD') {
      state.pendingTargetId = $('remote-id-input')?.value.trim();
      ui.showPasswordModal();
    }
  });

  signaling.on('request', (data) => {
    if (data.from === state.deviceId) return;
    state.incomingRequest = data;
    ui.showRequestModal(data.from);
  });

  signaling.on('accepted', async (data) => {
    log(`تم قبول الاتصال من ${data.hostDeviceId} — جاري البدء...`, 'success');
    resetConnectButton();
    try {
      const rtc = new RTCEngine();
      setupRTCHandlers(rtc, data.hostSocketId, data.hostDeviceId);
      sessionManager.add(data.hostSocketId, data.hostDeviceId, rtc);
      
      await rtc.init(true, 'viewer');
      if (data.sessionToken) await rtc.setEncryptionKey(data.sessionToken);
      
      const offer = await rtc.createOffer();
      signaling.sendOffer(data.hostSocketId, offer);
      ui.addHistory(data.hostDeviceId);
    } catch (e) { 
      log('خطأ في تهيئة الاتصال: ' + e.message, 'error');
      console.error('[RTC INIT ERROR]', e);
    }
  });

  signaling.on('offer', async (data) => {
    try {
      let session = state.sessions.get(data.from);
      if (!session) {
        const rtc = new RTCEngine();
        setupRTCHandlers(rtc, data.from, 'Remote');
        session = sessionManager.add(data.from, 'Remote', rtc);
        await rtc.init(false, 'host');
        
        const token = state.incomingRequest?.sessionToken || data.sessionToken;
        if (token) await rtc.setEncryptionKey(token);
      }
      
      // STRICT NEGOTIATION ORDER: 
      // 1. setRemoteDescription
      await session.rtc.pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      
      // 2. Add Track
      if (state.isHost && !session.rtc.localStream) {
        log('جاري بدء مشاركة الشاشة...');
        await session.rtc.startScreenShare();
      }

      // 3. createAnswer
      const answer = await session.rtc.pc.createAnswer();
      await session.rtc.pc.setLocalDescription(answer);
      
      signaling.sendAnswer(data.from, answer);
    } catch (e) { log('خطأ في الرد', 'error'); }
  });

  signaling.on('answer', (data) => {
    const s = state.sessions.get(data.from);
    if (s) s.rtc.handleAnswer(data.answer).catch(() => {});
  });

  signaling.on('ice-candidate', (data) => {
    const s = state.sessions.get(data.from);
    if (s) s.rtc.addIceCandidate(data.candidate).catch(() => {});
  });

  signaling.on('session-ended', () => {
    log('تم إنهاء الجلسة', 'warning');
    if (state.activeSessionId) sessionManager.remove(state.activeSessionId);
  });

  // ── 3. RTC Handlers ──
  function setupRTCHandlers(rtc, socketId, deviceId) {
    // Show Session Pulse Nav
    const pulseNav = $('nav-session-pulse');
    if (pulseNav) pulseNav.style.display = 'flex';

    rtc.on('stream', (stream) => {
      document.body.classList.add('has-active-session');
      if (state.activeSessionId !== socketId) return;
      
      const video = $('remote-video');
      if (!video) return;

      log('تم استلام دفق الفيديو ✓', 'success');
      
      if (video.srcObject !== stream) {
        video.srcObject = stream;
        video.play().catch(() => {
          $('video-overlay').style.display = 'flex';
        });
      }
    });

    // Unified Control Data Handler with PERMISSIONS
    rtc.on('control-data', async (data) => {
      // If we are viewer, handle ghost cursor and system info from host
      if (!state.isHost) {
        if (data.type === 'ghost-cursor') {
          // Ghost cursor removed to eliminate "double cursor" feeling
          return;
        } else if (data.type === 'system-info') {
          ui.updateSystemDetailedStats(data);
          if ($('remote-cpu')) $('remote-cpu').innerText = `CPU: ${Math.round(data.cpuLoad || 0)}%`;
          if ($('remote-ram')) $('remote-ram').innerText = `RAM: ${Math.round(data.ramUsage || 0)}%`;
          if (data.tasks) renderTasksList(data.tasks);
        }
        else if (data.type === 'monitor-list') {
          renderMonitorsList(data.sources);
        } else if (data.type === 'get-files') {
          window.phantom.getFiles(data.path).then(files => {
            rtc.sendControl({ type: 'file-list', files, path: data.path });
          });
        } else if (data.type === 'file-list') {
          renderRemoteFiles(data.files, data.path);
        } else if (data.type === 'file-chunk') {
          window.phantom.saveFileChunk(data);
        } else if (data.type === 'switch-monitor') {
          await rtc.startScreenShare(data.sourceId);
        } else if (data.type === 'shortcut') {
          if (data.action === 'cad') {
            // Note: Ctrl+Alt+Del is special on Windows and cannot be simulated via standard SendInput
            // for security reasons unless the app is signed and running as SYSTEM/Service.
            // We use a fallback: Open Task Manager
            window.phantom.simulateInput({ type: 'keydown', code: 'ControlLeft' });
            window.phantom.simulateInput({ type: 'keydown', code: 'ShiftLeft' });
            window.phantom.simulateInput({ type: 'keydown', code: 'Escape' });
            window.phantom.simulateInput({ type: 'keyup', code: 'Escape' });
            window.phantom.simulateInput({ type: 'keyup', code: 'ShiftLeft' });
            window.phantom.simulateInput({ type: 'keyup', code: 'ControlLeft' });
          } else if (data.action === 'win') {
            window.phantom.simulateInput({ type: 'keydown', code: 'MetaLeft' });
            window.phantom.simulateInput({ type: 'keyup', code: 'MetaLeft' });
          }
        }
        else if (data.type === 'privacy-mode') {
          window.phantom.togglePrivacyMode(data.enabled);
        }
        else if (data.type === 'lock-input') {
          state.remoteInputLocked = data.enabled;
          ui.showToast(data.enabled ? 'تم قفل إدخال المضيف' : 'تم تفعيل إدخال المضيف', 'info');
        }
        return;
      }

      // If we are host, handle control input
      const canMouse = !($('perm-mouse')) || $('perm-mouse').checked;
      const canKeys = !($('perm-keyboard')) || $('perm-keyboard').checked;
      const canClip = !($('perm-clipboard')) || $('perm-clipboard').checked;
      
      // Input Lock Check
      if (state.remoteInputLocked) return;

      if (data.type === 'refresh-stream') {
        log('تلقيت طلباً لتحديث البث...', 'info');
        await rtc.startScreenShare();
      } 
      else if (data.type.startsWith('mouse') || data.type === 'dblclick' || data.type === 'wheel') {
        if (canMouse) {
          window.phantom.simulateInput(data);
          rtc.sendControl({ type: 'ghost-cursor', x: data.x, y: data.y });
        }
      } 
      else if (data.type.startsWith('key')) {
        if (canKeys) window.phantom.simulateInput(data);
      } 
      else if (data.type === 'clipboard-sync' && canClip) {
        window.phantom.writeClipboard(data.text);
      }
    });

    // Host: Send System Info periodically
    if (state.isHost) {
      const infoInterval = setInterval(async () => {
        if (!state.sessions.has(socketId)) return clearInterval(infoInterval);
        const info = await window.phantom.getSystemInfo();
        rtc.sendControl({ type: 'system-info', ...info });
        ui.updatePerformance(info); // Update local dashboard too
      }, 1000);
    }

    rtc.on('stats-update', (stats) => {
      if (state.activeSessionId === socketId) {
        ui.updateHUD(Math.round(stats.latency || 0), Math.round(stats.fps || 0));
        ui.updateDiagStats({
          iceState: stats.iceState || 'Connected',
          latency: Math.round(stats.latency || 0),
          signaling: 'Active',
          bitrate: stats.bitrate || 2500,
          sessionId: deviceId,
          peerType: state.isHost ? 'Host' : 'Viewer'
        });
      }
    });
    
    rtc.on('ice-candidate', (c) => signaling.sendIceCandidate(socketId, c));
    rtc.on('re-offer', (offer) => signaling.sendOffer(socketId, offer));
  }

  // Professional Session Tools
  $('stool-monitors')?.addEventListener('click', async () => {
    log('جاري جلب قائمة الشاشات المتاحة...', 'info');
    const sources = await window.phantom.getScreenSources();
    if (sources && sources.length > 1) {
      const rtc = state.sessions.get(state.activeSessionId)?.rtc;
      if (rtc) {
        log('تبديل الشاشة النشطة...', 'success');
        await rtc.startScreenShare(); 
      }
    } else {
      ui.showToast('لا توجد شاشات إضافية', 'info');
    }
  });

  $('stool-cad')?.addEventListener('click', () => {
    rtc.sendControl({ type: 'shortcut', action: 'cad' });
    ui.showToast('جاري إرسال اختصار لوحة المفاتيح...', 'info');
  });

  $('stool-win')?.addEventListener('click', () => {
    rtc.sendControl({ type: 'shortcut', action: 'win' });
  });

  let mediaRecorder = null;
  let recordedChunks = [];
  $('stool-rec')?.addEventListener('click', () => {
    const btn = $('stool-rec');
    if (state.isRecording) {
      mediaRecorder.stop();
      state.isRecording = false;
      btn.classList.remove('recording');
      btn.style.color = '';
      return;
    }

    const video = $('remote-video');
    if (!video.srcObject) return;

    recordedChunks = [];
    mediaRecorder = new MediaRecorder(video.srcObject, { mimeType: 'video/webm;codecs=vp9' });
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `PhantomSession_${new Date().getTime()}.webm`;
      a.click();
      ui.showToast('تم حفظ تسجيل الجلسة ✓', 'success');
    };
    
    mediaRecorder.start();
    state.isRecording = true;
    btn.classList.add('recording');
    btn.style.color = 'var(--danger)';
    ui.showToast('بدأ تسجيل الجلسة...', 'info');
  });

  $('stool-monitors')?.addEventListener('click', () => {
    const p = $('monitors-panel');
    if (p) p.style.display = p.style.display === 'none' ? 'block' : 'none';
  });

  $('btn-monitors-close')?.addEventListener('click', () => {
    if ($('monitors-panel')) $('monitors-panel').style.display = 'none';
  });

  function renderMonitorsList(sources) {
    const list = $('monitors-list');
    if (!list) return;
    list.innerHTML = '';
    sources.forEach(s => {
      const btn = document.createElement('button');
      btn.className = 'btn-action btn-sm btn-block';
      btn.style.textAlign = 'left';
      btn.innerHTML = `<i class="fas fa-desktop"></i> ${s.name}`;
      btn.onclick = () => {
        rtc.sendControl({ type: 'switch-monitor', sourceId: s.id });
        ui.showToast(`جاري التحويل إلى ${s.name}...`, 'info');
      };
      list.appendChild(btn);
    });
  }

  // ── File Explorer Logic ──
  $('nav-files')?.addEventListener('click', async () => {
    ui.switchView('files');
    loadLocalFiles();
    if (state.activeSessionId) {
      rtc.sendControl({ type: 'get-files', path: null });
    }
  });

  async function loadLocalFiles(dir = null) {
    const files = await window.phantom.getFiles(dir);
    const list = $('local-files');
    if (!list) return;
    list.innerHTML = '';
    files.forEach(f => {
      const item = document.createElement('div');
      item.className = 'file-item';
      item.innerHTML = `
        <i class="fas ${f.isDir ? 'fa-folder' : 'fa-file'}"></i>
        <span class="f-name">${f.name}</span>
        <span class="f-size">${f.isDir ? '' : formatSize(f.size)}</span>
      `;
      if (f.isDir) item.onclick = () => loadLocalFiles(f.path);
      list.appendChild(item);
    });
    if (dir) $('local-path').value = dir;
  }

  function renderRemoteFiles(files, path) {
    const list = $('remote-files');
    if (!list) return;
    list.innerHTML = '';
    files.forEach(f => {
      const item = document.createElement('div');
      item.className = 'file-item';
      item.innerHTML = `
        <i class="fas ${f.isDir ? 'fa-folder' : 'fa-file'}"></i>
        <span class="f-name">${f.name}</span>
        <span class="f-size">${f.isDir ? '' : formatSize(f.size)}</span>
      `;
      if (f.isDir) item.onclick = () => rtc.sendControl({ type: 'get-files', path: f.path });
      list.appendChild(item);
    });
    if (path) $('remote-path').value = path;
  }

  function formatSize(bytes) {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  $('btn-upload-file')?.addEventListener('click', () => {
    const inp = document.getElementById('file-input-hidden');
    inp.onchange = async () => {
      if (!inp.files.length) return;
      const file = inp.files[0];
      uploadFile(file);
    };
    inp.click();
  });

  async function uploadFile(file) {
    if (!state.activeSessionId) return ui.showToast('يجب الاتصال أولاً', 'error');
    
    const CHUNK_SIZE = 16384; // 16KB
    const total = Math.ceil(file.size / CHUNK_SIZE);
    const id = Math.random().toString(36).substr(2, 9);
    
    ui.showToast(`جاري إرسال ${file.name}...`, 'info');
    
    for (let i = 0; i < total; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(file.size, start + CHUNK_SIZE);
      const blob = file.slice(start, end);
      const buffer = await blob.arrayBuffer();
      
      rtc.sendControl({
        type: 'file-chunk',
        id,
        name: file.name,
        chunk: Array.from(new Uint8Array(buffer)), // Base64 alternative: JSON safe
        total,
        index: i
      });
      
      if (i % 10 === 0) await new Promise(r => setTimeout(r, 10)); // Prevent congestion
    }
  }

  $('stool-privacy')?.addEventListener('click', () => {
    state.privacyActive = !state.privacyActive;
    rtc.sendControl({ type: 'privacy-mode', enabled: state.privacyActive });
    $('stool-privacy').classList.toggle('active', state.privacyActive);
    ui.showToast(state.privacyActive ? 'تم تفعيل وضع الخصوصية' : 'تم إيقاف وضع الخصوصية', 'info');
  });

  $('stool-lock')?.addEventListener('click', () => {
    state.inputLocked = !state.inputLocked;
    rtc.sendControl({ type: 'lock-input', enabled: state.inputLocked });
    $('stool-lock').classList.toggle('active', state.inputLocked);
    ui.showToast(state.inputLocked ? 'تم قفل التحكم لدى البعيد' : 'تم إطلاق التحكم لدى البعيد', 'info');
  });

  $('stool-turbo')?.addEventListener('click', () => {
    const btn = $('stool-turbo');
    btn.classList.toggle('active');
    const isTurbo = btn.classList.contains('active');
    log(isTurbo ? 'تم تفعيل وضع التوربو 🚀' : 'تم العودة للوضع العادي', isTurbo ? 'success' : 'info');
  });

  $('stool-screenshot')?.addEventListener('click', async () => {
    log('جاري التقاط لقطة شاشة...', 'info');
    const dataUrl = await window.phantom.takeScreenshot();
    if (dataUrl) {
      const link = document.createElement('a');
      link.href = dataUrl;
      link.download = `Phantom_Shot_${Date.now()}.png`;
      link.click();
      ui.showToast('تم حفظ لقطة الشاشة ✓', 'success');
    }
  });

  // ── 4. UI Events ──
  
  // Quality Switching
  document.querySelectorAll('.q-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.q-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const quality = btn.dataset.quality;
      log(`تم تغيير جودة البث إلى: ${quality}`, 'info');
    });
  });

  // Settings Management
  async function loadSettings() {
    const s = await window.phantom.getSettings();
    if (s.hwAccel !== undefined) $('set-hw-accel').checked = s.hwAccel;
    if (s.staticPassword) $('static-password-input').value = s.staticPassword;
    if (s.quality) {
      document.querySelectorAll('.q-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.quality === s.quality);
      });
    }
    // Set permissions
    if (s.perms) {
      if (s.perms.mouse !== undefined) $('perm-mouse').checked = s.perms.mouse;
      if (s.perms.keyboard !== undefined) $('perm-keyboard').checked = s.perms.keyboard;
      if (s.perms.clipboard !== undefined) $('perm-clipboard').checked = s.perms.clipboard;
    }
  }
  loadSettings();

  $('btn-save-settings')?.addEventListener('click', async () => {
    const settings = {
      hwAccel: $('set-hw-accel').checked,
      staticPassword: $('static-password-input').value.trim(),
      quality: document.querySelector('.q-btn.active')?.dataset.quality || 'high',
      perms: {
        mouse: $('perm-mouse').checked,
        keyboard: $('perm-keyboard').checked,
        clipboard: $('perm-clipboard').checked
      }
    };
    
    await window.phantom.setSettings(settings);
    ui.showToast('تم حفظ الإعدادات بنجاح ✓', 'success');
    
    if (settings.staticPassword) {
      signaling.socket?.emit('update-password', { password: settings.staticPassword });
    }
    
    // Performance: If HW Accel changed, notify user
    const oldS = await window.phantom.getSettings();
    if (oldS.hwAccel !== settings.hwAccel) {
      ui.showToast('تغيير تسريع الأجهزة يتطلب إعادة تشغيل البرنامج', 'warning');
    }
  });

  // Permanent Password (Legacy support for old button)
  $('btn-save-static-pwd')?.addEventListener('click', async () => {
    const pwd = $('static-password-input')?.value.trim();
    if (pwd) {
      const s = await window.phantom.getSettings();
      s.staticPassword = pwd;
      await window.phantom.setSettings(s);
      ui.showToast('تم حفظ كلمة المرور الثابتة ✓', 'success');
      signaling.socket?.emit('update-password', { password: pwd });
    }
  });

  // Connection Link
  $('btn-copy-link')?.addEventListener('click', () => {
    const link = `phantomdesk://connect/${state.deviceId}`;
    navigator.clipboard.writeText(link);
    ui.showToast('تم نسخ رابط الاتصال ✓', 'success');
  });

  // Standard Toolbar
  $('stool-refresh')?.addEventListener('click', () => {
    const s = state.sessions.get(state.activeSessionId);
    if (s) {
      log('جاري طلب تحديث البث من المضيف...', 'info');
      s.rtc.sendControl({ type: 'refresh-stream' });
    }
  });

  $('stool-fullscreen')?.addEventListener('click', () => {
    const v = $('remote-video');
    if (v?.requestFullscreen) v.requestFullscreen();
  });

  $('stool-chat')?.addEventListener('click', () => {
    const overlay = $('chat-overlay');
    if (overlay) overlay.style.display = overlay.style.display === 'none' ? 'flex' : 'none';
  });

  $('btn-chat-close')?.addEventListener('click', () => {
    if ($('chat-overlay')) $('chat-overlay').style.display = 'none';
  });

  $('stool-disconnect')?.addEventListener('click', () => {
    if (state.activeSessionId) sessionManager.remove(state.activeSessionId);
  });

  $('btn-connect')?.addEventListener('click', () => {
    const id = $('remote-id-input')?.value.trim();
    if (!id) return ui.showToast('أدخل معرّف الجهاز', 'warning');
    if (!state.connected) return ui.showToast('انتظر الاتصال بالسيرفر...', 'warning');

    log(`جاري طلب الاتصال بـ ${id}...`);
    const btn = $('btn-connect');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> جاري...'; }
    signaling.sendRequest(id);
  });

  $('btn-accept')?.addEventListener('click', async () => {
    if (!state.incomingRequest) return;
    ui.hideRequestModal();
    state.isHost = true;
    try {
      const rtc = new RTCEngine();
      setupRTCHandlers(rtc, state.incomingRequest.fromSocketId, state.incomingRequest.from);
      sessionManager.add(state.incomingRequest.fromSocketId, state.incomingRequest.from, rtc);
      await rtc.init(false, 'host');
      if (state.incomingRequest.sessionToken) await rtc.setEncryptionKey(state.incomingRequest.sessionToken);
      signaling.acceptRequest(state.incomingRequest.fromSocketId, state.incomingRequest.sessionToken);
    } catch (e) { log('فشل القبول', 'error'); }
  });

  $('btn-reject')?.addEventListener('click', () => {
    ui.hideRequestModal();
    if (state.incomingRequest) signaling.rejectRequest(state.incomingRequest.fromSocketId);
  });

  $('btn-pwd-submit')?.addEventListener('click', () => {
    const pwd = $('password-input')?.value.trim();
    if (pwd && state.pendingTargetId) {
      ui.hidePasswordModal();
      log(`إعادة المحاولة بكلمة مرور...`);
      signaling.sendRequest(state.pendingTargetId, pwd);
    }
  });

  $('btn-pwd-cancel')?.addEventListener('click', () => {
    ui.hidePasswordModal();
    resetConnectButton();
  });

  $('stool-disconnect')?.addEventListener('click', () => {
    if (state.activeSessionId) sessionManager.remove(state.activeSessionId);
  });

  const sendChat = () => {
    const input = $('chat-input');
    const text = input?.value.trim();
    if (text) {
      const s = state.sessions.get(state.activeSessionId);
      if (s) {
        s.rtc.sendControl({ type: 'chat-message', text });
        appendChatMessage('sent', text);
        input.value = '';
      }
    }
  };
  $('btn-chat-send')?.addEventListener('click', sendChat);
  $('chat-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

  function renderTasksList(tasks) {
    const body = $('tasks-list-body');
    if (!body || !tasks) return;
    body.innerHTML = tasks.map(t => `
      <tr>
        <td>${t.name}</td>
        <td>${t.cpu}%</td>
        <td>${t.mem}MB</td>
      </tr>
    `).join('');
  }

  $('stool-tasks')?.addEventListener('click', () => {
    const panel = $('tasks-panel');
    if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  });

  $('btn-tasks-close')?.addEventListener('click', () => {
    if ($('tasks-panel')) $('tasks-panel').style.display = 'none';
  });

  const inputCapture = new InputCapture((data) => {
    const s = state.sessions.get(state.activeSessionId);
    if (s && !state.isHost) s.rtc.sendControl(data);
  });
  inputCapture.activate($('remote-video'));

  // Session History Manager
  function addToHistory(deviceId) {
    let history = JSON.parse(localStorage.getItem('phantom_history') || '[]');
    if (!history.includes(deviceId)) {
      history.unshift(deviceId);
      if (history.length > 10) history.pop();
      localStorage.setItem('phantom_history', JSON.stringify(history));
      renderHistory();
    }
  }

  function renderHistory() {
    const container = $('recent-list');
    if (!container) return;
    const history = JSON.parse(localStorage.getItem('phantom_history') || '[]');
    container.innerHTML = history.length ? '' : '<p class="empty-text">لا يوجد تاريخ اتصالات</p>';
    history.forEach(id => {
      const item = document.createElement('div');
      item.className = 'recent-item';
      item.innerHTML = `<span>${id}</span><button class="btn-sm"><i class="fas fa-bolt"></i></button>`;
      item.onclick = () => { if ($('remote-id-input')) $('remote-id-input').value = id; };
      container.appendChild(item);
    });
  }
  renderHistory();

  // Global Utils
  $('btn-copy-id')?.addEventListener('click', () => {
    navigator.clipboard.writeText(state.deviceId);
    ui.showToast('تم النسخ ✓', 'success');
  });

  $('btn-refresh-pwd')?.addEventListener('click', async () => {
    state.password = await window.phantom.refreshPassword();
    ui.setPassword(state.password);
    signaling.socket?.emit('update-password', { password: state.password });
    ui.showToast('تم التجديد ✓', 'success');
  });

  $('btn-toggle-pwd')?.addEventListener('click', () => ui.togglePasswordVisibility());

  // Navigation
  $('nav-home')?.addEventListener('click', () => ui.switchView('home'));
  $('nav-terminal')?.addEventListener('click', () => { ui.switchView('terminal'); window.phantom.startShell(); });
  $('nav-logs')?.addEventListener('click', () => ui.switchView('logs'));
  $('nav-files')?.addEventListener('click', () => ui.switchView('files'));
  $('nav-sys')?.addEventListener('click', () => ui.switchView('sys'));
  $('nav-settings')?.addEventListener('click', () => ui.switchView('settings'));
  $('nav-diag')?.addEventListener('click', () => ui.switchView('diag'));
  
  // Radical Persistence: Ensure session nav re-attaches video
  $('nav-session')?.addEventListener('click', () => {
    if (state.activeSessionId) {
      sessionManager.switch(state.activeSessionId);
    }
  });

  // Local Screen Capture Test
  $('btn-test-capture')?.addEventListener('click', async () => {
    const btn = $('btn-test-capture');
    const container = $('local-test-container');
    const video = $('local-test-video');
    const status = $('local-test-status');
    
    if (video.srcObject) {
      video.srcObject.getTracks().forEach(t => t.stop());
      video.srcObject = null;
      container.style.display = 'none';
      btn.innerHTML = '<i class="fas fa-camera"></i> بدء الاختبار';
      return;
    }

    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> جاري الالتقاط...';
    container.style.display = 'block';
    status.innerText = 'جاري طلب إذن الشاشة...';
    status.style.background = 'rgba(234,179,8,0.8)';

    try {
      const sources = await window.phantom.getScreenSources();
      if (!sources || sources.length === 0) throw new Error('لا توجد شاشات متاحة');
      
      const screen = sources.find(s => s.id.startsWith('screen:1') || s.name.toLowerCase().includes('entire')) || sources[0];
      status.innerText = `التقاط: ${screen.name}`;
      
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: screen.id,
            minWidth: 1280,
            maxWidth: 1920,
            minHeight: 720,
            maxHeight: 1080
          }
        }
      });
      
      video.srcObject = stream;
      video.onloadedmetadata = () => {
        video.play();
        status.innerText = 'تم الالتقاط بنجاح ✓ (إذا كانت الشاشة سوداء فهناك مشكلة في كارت الشاشة أو الصلاحيات)';
        status.style.background = 'rgba(16,185,129,0.8)';
        btn.innerHTML = '<i class="fas fa-stop"></i> إيقاف';
      };
    } catch (e) {
      status.innerText = `فشل: ${e.message}`;
      status.style.background = 'rgba(239,68,68,0.8)';
      btn.innerHTML = '<i class="fas fa-camera"></i> إعادة المحاولة';
    }
  });

  function appendChatMessage(type, text) {
    const box = $('chat-messages');
    if (!box) return;
    const msg = document.createElement('div');
    msg.className = `chat-msg ${type}`;
    msg.innerHTML = `<span>${text}</span>`;
    box.appendChild(msg);
    box.scrollTop = box.scrollHeight;
  }

  log('PhantomDesk Elite Edition جاهز للعمل 👻', 'success');
})();
