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
      this.renderTabs();
      this.switch(socketId);
      return s;
    },
    remove(socketId) {
      const s = state.sessions.get(socketId);
      if (s) {
        s.rtc.close();
        state.sessions.delete(socketId);
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
      if (s.stream) {
        const video = $('remote-video');
        if (video) {
          video.srcObject = s.stream;
          video.play().catch(() => {});
        }
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
    rtc.on('stream', (stream) => {
      if (state.activeSessionId !== socketId) return;
      
      const video = $('remote-video');
      if (!video) return;

      log('تم استلام دفق الفيديو ✓', 'success');
      
      // Prevent redundant assignment
      if (video.srcObject !== stream) {
        video.srcObject = stream;
        
        const playVideo = () => {
          video.play().then(() => {
            log('بدء عرض الشاشة...', 'success');
            $('video-overlay').style.display = 'none';
            ui.switchView('session');
          }).catch(e => {
            log('بانتظار إذن المتصفح لعرض الفيديو', 'warning');
            $('video-overlay').style.display = 'flex';
          });
        };

        playVideo();
        $('video-overlay').onclick = playVideo;
      }
    });

    // Real-time Visual Monitor
    rtc.on('stats-update', (stats) => {
      if (state.activeSessionId === socketId) {
        const statsEl = $('diag-stats');
        if (statsEl) {
          statsEl.innerHTML = `📡 FPS: ${stats.fps} | 📶 Latency: ${state.latency}ms`;
          statsEl.style.color = stats.fps > 0 ? '#10b981' : '#ef4444';
        }
      }
    });

    // Watchdog to ensure video stays playing
    if (!state.videoWatchdog) {
      state.videoWatchdog = setInterval(() => {
        const video = $('remote-video');
        if (video && video.srcObject && video.paused && !video.ended) {
          video.play().catch(() => {});
        }
      }, 3000);
    }

    rtc.on('datachannel-open', async () => {
      log('قناة البيانات مفتوحة - التحكم نشط', 'success');
    });

    rtc.on('control-data', (data) => {
      if (state.isHost) {
        if (data.type === 'chat-message') appendChatMessage('received', data.text);
        else if (data.type === 'clipboard-sync') window.phantom.writeClipboard(data.text);
        else window.phantom.simulateInput(data);
      } else {
        if (data.type === 'chat-message') appendChatMessage('received', data.text);
        else if (data.type === 'clipboard-sync') window.phantom.writeClipboard(data.text);
      }
    });

    rtc.on('ice-candidate', (c) => signaling.sendIceCandidate(socketId, c));
    rtc.on('stats-update', (stats) => {
      if (state.activeSessionId === socketId) {
        ui.updateHUD(stats.latency || 0, Math.round(stats.fps));
        ui.updateDiagStats({
          iceState: stats.iceState || 'Connected',
          latency: stats.latency || 0,
          signaling: 'Active',
          bitrate: stats.bitrate || 2500,
          sessionId: deviceId,
          peerType: state.isHost ? 'Host' : 'Viewer'
        });
      }
    });
  }

  // ── 4. UI Events ──
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

  new InputCapture($('remote-video'), (data) => {
    const s = state.sessions.get(state.activeSessionId);
    if (s && !state.isHost) s.rtc.sendControl(data);
  });

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
  $('nav-settings')?.addEventListener('click', () => ui.switchView('settings'));
  $('nav-diag')?.addEventListener('click', () => ui.switchView('diag'));

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
