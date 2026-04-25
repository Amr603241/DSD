/**
 * PhantomDesk — Application Core v1.0
 * Orchestrates signaling, WebRTC, UI, and input modules.
 */

const SIGNALING_SERVER = 'https://dsd-1.onrender.com';

(async function initPhantomDesk() {
  console.log('[PHANTOM] Initializing...');

  const ui = new UIManager();
  const signaling = new SignalingClient(SIGNALING_SERVER);

  const $ = (id) => document.getElementById(id);

  const log = (msg, type = 'info') => {
    console.log(`[${type.toUpperCase()}] ${msg}`);
    ui.addLog(msg, type);
    ui.addDiagLog(msg, type === 'error' ? 'error' : type === 'warning' ? 'warn' : 'info');
    window.phantom.logToFile(type, msg);
  };

  // Global Error Catching for "Error Tracking"
  window.onerror = (msg, url, line, col, error) => {
    log(`[FATAL] ${msg} at ${line}:${col}`, 'error');
    return false;
  };
  window.onunhandledrejection = (event) => {
    log(`[PROMISE-ERROR] ${event.reason}`, 'error');
  };

  // ── State ──
  let state = {
    deviceId: '',
    password: '',
    isHost: false,
    remoteSocketId: null,
    incomingRequest: null,
    sessionToken: null,
    connected: false,
    pendingTargetId: null,
    lastClipboard: '',
    sessions: new Map(), // Multi-session support
    activeSessionId: null
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
          else ui.showView('home');
        }
        this.renderTabs();
      }
    },
    switch(socketId) {
      const s = state.sessions.get(socketId);
      if (!s) return;
      state.activeSessionId = socketId;
      state.remoteSocketId = socketId;
      if (s.stream) {
        const video = $('remote-video');
        video.srcObject = s.stream;
        video.play().catch(() => {});
      }
      this.renderTabs();
      log(`انتقلت للجلسة: ${s.deviceId}`);
    },
    renderTabs() {
      const container = $('session-tabs');
      if (!container) return;
      container.innerHTML = '';
      state.sessions.forEach((s, id) => {
        const tab = document.createElement('div');
        tab.className = `session-tab ${id === state.activeSessionId ? 'active' : ''}`;
        tab.innerHTML = `
          <span>${s.deviceId}</span>
          <i class="fas fa-times tab-close" data-id="${id}"></i>
        `;
        tab.onclick = (e) => {
          if (e.target.classList.contains('tab-close')) this.remove(id);
          else this.switch(id);
        };
        container.appendChild(tab);
      });
      const addBtn = document.createElement('button');
      addBtn.className = 'btn-new-session';
      addBtn.innerHTML = '<i class="fas fa-plus"></i>';
      addBtn.onclick = () => ui.showView('home');
      container.appendChild(addBtn);
    }
  };

  // ── 1. Load Device Info ──
  try {
    state.deviceId = await window.phantom.getDeviceId();
    state.password = await window.phantom.getPassword();
    ui.setDeviceId(state.deviceId);
    ui.setPassword(state.password);
    log('تم تحميل بيانات الجهاز بنجاح');
  } catch (e) {
    log('فشل تحميل بيانات الجهاز: ' + e.message, 'error');
  }

  // ── 2. Connect to Signaling Server ──
  let reconnectTimer = null;

  async function connectToServer() {
    try {
      const pwd = await window.phantom.getPassword();
      await signaling.connect(state.deviceId, pwd);
      state.connected = true;
      ui.setConnectionStatus(true);
      log('تم الاتصال بسيرفر الإشارات ✓');
      if (reconnectTimer) { clearInterval(reconnectTimer); reconnectTimer = null; }
    } catch (e) {
      state.connected = false;
      ui.setConnectionStatus(false);
      log('فشل الاتصال بالسيرفر: ' + e.message, 'error');
      startReconnect();
    }
  }

  function startReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setInterval(async () => {
      try {
        const pwd = await window.phantom.getPassword();
        await signaling.connect(state.deviceId, pwd);
        state.connected = true;
        ui.setConnectionStatus(true);
        log('تم إعادة الاتصال تلقائياً ✓');
        clearInterval(reconnectTimer);
        reconnectTimer = null;
      } catch {
        ui.setConnectionStatus(false);
      }
    }, 5000);
  }

  connectToServer();

  // ── 3. Signaling Event Handlers ──

  signaling.on('connection-error', (data) => {
    log(data.message || 'خطأ في الاتصال', 'error');
    ui.showToast(data.message, 'error');
    resetConnectButton();

    if (data.code === 'NEED_PASSWORD') {
      state.pendingTargetId = $('remote-id-input')?.value.trim();
      ui.showPasswordModal();
    }
  });

  signaling.on('request', (data) => {
    // 0. ID Verification
    if (data.from === state.deviceId) {
      log(`[!] تنبيه: محاولة اتصال ذاتي (Self-Connect) من ${data.from} تم رفضها قسرياً لمنع التعليق`, 'error');
      return;
    }

    log(`[!] طلب اتصال وارد من: ${data.from} (أنا: ${state.deviceId}) — بانتظار موافقة المستخدم...`, 'warning');
    
    // 1. Setup State
    state.incomingRequest = data;
    state.isHost = true;
    state.sessionToken = data.sessionToken;
    
    // 2. Show Modal
    ui.showRequestModal(data.from);
  });

  signaling.on('rejected', () => {
    log('تم رفض طلب الاتصال', 'warning');
    resetConnectButton();
  });

  signaling.on('accepted', async (data) => {
    state.isHost = false;
    state.sessionToken = data.sessionToken;
    log(`[TRACE] تم قبول الاتصال من ${data.hostDeviceId} — جاري البدء...`, 'success');

    try {
      const rtcInstance = new RTCEngine();
      setupRTCHandlers(rtcInstance, data.hostSocketId, data.hostDeviceId);
      
      const session = sessionManager.add(data.hostSocketId, data.hostDeviceId, rtcInstance);
      
      await rtcInstance.init(true, 'viewer');
      if (state.sessionToken) await rtcInstance.setEncryptionKey(state.sessionToken);
      
      const offer = await rtcInstance.createOffer();
      signaling.sendOffer(data.hostSocketId, offer);
    } catch (e) {
      log('فشل إعداد الاتصال: ' + e.message, 'error');
    }
  });

  signaling.on('offer', async (data) => {
    log('[TRACE] تم استلام Offer...');
    try {
      let session = state.sessions.get(data.from);
      if (!session) {
        // This should happen if we are the host and just accepted a request
        const rtcInstance = new RTCEngine();
        setupRTCHandlers(rtcInstance, data.from, 'Viewer');
        session = sessionManager.add(data.from, 'Remote Device', rtcInstance);
        await rtcInstance.init(false, 'host');
        if (state.sessionToken) await rtcInstance.setEncryptionKey(state.sessionToken);
      }
      
      const answer = await session.rtc.createAnswer(data.offer);
      signaling.sendAnswer(data.from, answer);
    } catch (e) {
      log('فشل معالجة Offer: ' + e.message, 'error');
    }
  });

  signaling.on('answer', async (data) => {
    const session = state.sessions.get(data.from);
    if (session) {
      try { await session.rtc.handleAnswer(data.answer); } catch (e) { log('Answer error: ' + e.message, 'error'); }
    }
  });

  signaling.on('ice-candidate', (data) => {
    const session = state.sessions.get(data.from);
    if (session) session.rtc.addIceCandidate(data.candidate);
  });

  function setupRTCHandlers(rtcInstance, socketId, deviceId) {
    rtcInstance.on('stream', (stream) => {
      const session = state.sessions.get(socketId);
      if (session) {
        session.stream = stream;
        if (state.activeSessionId === socketId) {
          const video = $('remote-video');
          video.srcObject = stream;
          video.play().catch(() => {});
          $('video-overlay').style.display = 'none';
          ui.showView('view-session');
        }
      }
    });

    rtcInstance.on('datachannel-open', async () => {
      if (state.isHost) {
        const stream = await rtcInstance.startScreenShare();
        const session = state.sessions.get(socketId);
        if (session) {
          session.stream = stream;
          if (state.activeSessionId === socketId) {
            $('remote-video').srcObject = stream;
            $('video-overlay').style.display = 'none';
          }
        }
      }
    });

    rtcInstance.on('control-data', (data) => {
      const session = state.sessions.get(socketId);
      if (!session) return;

      if (state.isHost) {
        if (data.type === 'chat-message') {
          appendChatMessage('received', data.text);
        } else if (data.type === 'clipboard-sync') {
          state.lastClipboard = data.text;
          window.phantom.writeClipboard(data.text);
        } else {
          window.phantom.simulateInput(data);
        }
      } else {
        if (data.type === 'chat-message') {
          appendChatMessage('received', data.text);
        } else if (data.type === 'clipboard-sync') {
          state.lastClipboard = data.text;
          window.phantom.writeClipboard(data.text);
        }
      }
    });

    rtcInstance.on('ice-candidate', (c) => signaling.sendIceCandidate(socketId, c));
    rtcInstance.on('log-debug', (msg) => log(`[RTC-${deviceId}] ${msg}`));

    rtcInstance.on('stats-update', (stats) => {
      if (state.activeSessionId === socketId) {
        ui.updateHUD(stats.latency || 0, Math.round(stats.fps));
      }
    });
  }

  signaling.on('session-ended', () => {
    log('تم إنهاء الجلسة من الطرف الآخر', 'warning');
    endSession();
  });

  signaling.on('disconnected', () => {
    state.connected = false;
    ui.setConnectionStatus(false);
    log('انقطع الاتصال بالسيرفر', 'warning');
    startReconnect();
  });

  signaling.on('reconnected', () => {
    state.connected = true;
    ui.setConnectionStatus(true);
    log('تم إعادة الاتصال بالسيرفر ✓');
  });

  // Diagnostic Updates
  setInterval(() => {
    if (!state.connected) return;
    ui.updateDiagStats({
      iceState: rtc.pc?.iceConnectionState || '—',
      latency: state.currentLatency || 0,
      signaling: signaling.isConnected ? 'Connected' : 'Disconnected',
      bitrate: state.currentBitrate || 2500,
      sessionId: state.sessionToken || '—',
      peerType: state.isHost ? 'Host (Sender)' : state.sessionToken ? 'Viewer (Receiver)' : 'Idle'
    });
  }, 1000);

  // ── 4. RTC Event Handlers ──

  rtc.on('stream', (stream) => {
    const video = $('remote-video');
    if (video) {
      if (video.srcObject && video.srcObject.id === stream.id) return;
      
      log(`تم استلام البث المباشر — القنوات: ${stream.getTracks().length}`, 'success');
      console.log('[RTC] Stream received:', stream.id, stream.getTracks());
      
      video.muted = true;
      video.srcObject = stream;
      
      const attemptPlay = () => {
        // Settle delay to ensure buffer is ready
        setTimeout(() => {
          video.play()
            .then(() => {
              log('تم تشغيل الفيديو بنجاح ✓', 'success');
              const overlay = $('video-overlay');
              if (overlay) overlay.style.display = 'none';
            })
            .catch(e => {
              log('انتظار تفاعل المستخدم لبدء البث...', 'warning');
              const overlay = $('video-overlay');
              if (overlay) overlay.style.display = 'flex';
            });
        }, 1000);
      };

      attemptPlay();
      
      // Global click fallback
      const globalClick = () => {
        attemptPlay();
        document.removeEventListener('click', globalClick);
      };
      document.addEventListener('click', globalClick);
      ui.switchView('session');
      const navSession = $('nav-session');
      if (navSession) navSession.style.display = 'flex';
      
      inputCapture.activate(video);
      log('بدأت الجلسة — البث نشط ✓', 'success');
      ui.addHistory(state.pendingTargetId || 'Host');
      resetConnectButton();
    }
  });

  rtc.on('ice-candidate', (c) => {
    const target = state.remoteSocketId || state.incomingRequest?.fromSocketId;
    if (target) signaling.sendIceCandidate(target, c);
  });

  rtc.on('control-data', (data) => {
    if (state.isHost) {
      if (data.type === 'clipboard-sync' && data.text) {
        state.lastClipboard = data.text;
        window.phantom.writeClipboard(data.text);
      } else if (data.type === 'chat-message') {
        appendChatMessage('received', data.text);
        if ($('chat-overlay')?.style.display === 'none') ui.showToast('رسالة جديدة واردة 💬', 'info');
      } else {
        window.phantom.simulateInput(data);
      }
    } else {
      // Viewer receiving from host
      if (data.type === 'clipboard-sync' && data.text) {
        state.lastClipboard = data.text;
        window.phantom.writeClipboard(data.text);
      } else if (data.type === 'chat-message') {
        appendChatMessage('received', data.text);
        if ($('chat-overlay')?.style.display === 'none') ui.showToast('المضيف أرسل رسالة 💬', 'info');
      }
    }
  });

  function appendChatMessage(type, text) {
    const box = $('chat-messages');
    if (!box) return;
    const msg = document.createElement('div');
    msg.className = `chat-msg ${type}`;
    const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
    msg.innerHTML = `<span>${text}</span><small class="chat-msg-time">${time}</small>`;
    box.appendChild(msg);
    box.scrollTop = box.scrollHeight;
  }

  rtc.on('latency', (ms) => {
    ui.updateHUD(ms, '--');
    state.currentLatency = ms;
    
    // Adaptive Bitrate (Host Only)
    if (state.isHost) {
      let targetKbps = 2500;
      if (ms > 300) targetKbps = 500;
      else if (ms > 150) targetKbps = 1000;
      
      if (state.currentBitrate !== targetKbps) {
        state.currentBitrate = targetKbps;
        rtc.updateBitrate(targetKbps);
      }
    }
  });

  rtc.on('log-debug', (msg) => {
    ui.addDiagLog(`[RTC] ${msg}`, 'info');
  });

  rtc.on('ice-state', (s) => {
    log(`ICE: ${s}`, s === 'connected' ? 'success' : 'info');
  });

  rtc.on('connection-lost', () => {
    log('انقطع اتصال WebRTC — جاري محاولة الاستعادة...', 'error');
    // If it's a transient drop, don't end session yet
    setTimeout(() => {
      if (rtc.pc?.iceConnectionState === 'failed' || rtc.pc?.iceConnectionState === 'disconnected') {
        log('فشلت محاولة استعادة الاتصال', 'error');
        endSession();
      }
    }, 10000);
  });

  rtc.on('ice-restart', async () => {
    const target = state.remoteSocketId || state.incomingRequest?.fromSocketId;
    if (target) {
      log('جاري إعادة التفاوض على الاتصال (ICE Restart)...', 'info');
      try {
        const offer = await rtc.restartIce();
        if (offer) signaling.sendOffer(target, offer);
      } catch (e) {
        log('فشل إعادة التفاوض: ' + e.message, 'error');
      }
    }
  });

  // ── 5. UI Actions ──

  // Connect button
  $('btn-connect')?.addEventListener('click', () => {
    const id = $('remote-id-input')?.value.trim();
    if (!id) return ui.showToast('أدخل معرّف الجهاز', 'warning');

    state.pendingTargetId = id;
    log(`جاري الاتصال بـ ${id}...`);
    const btn = $('btn-connect');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> جاري...'; }

    try {
      signaling.sendRequest(id);
    } catch (e) {
      log(e.message, 'error');
      resetConnectButton();
    }
  });

  // Absolute Input System (Mouse + Keyboard)
  const triggerAccept = async () => {
    if (!state.incomingRequest) return;
    ui.hideRequestModal();
    state.isHost = true;
    log('[TRACE] تم تفعيل القبول (قسري) — جاري البدء...', 'info');
    try {
      await rtc.init(false, 'host');
      state.sessionToken = state.incomingRequest.sessionToken;
      if (state.sessionToken) await rtc.setEncryptionKey(state.sessionToken);
      signaling.acceptRequest(state.incomingRequest.fromSocketId, state.sessionToken);
      log('[TRACE] تم إرسال القبول ✓ جاري بدء البث...', 'success');
      await rtc.startScreenShare(); 
      ui.updateStatus('مُتصل (مُضيف)', 'active');
    } catch (e) { log('فشل إتمام الاتصال: ' + e.message, 'error'); }
  };

  const triggerReject = () => {
    ui.hideRequestModal();
    if (state.incomingRequest) signaling.rejectRequest(state.incomingRequest.fromSocketId);
    log('تم رفض الطلب', 'warning');
  };

  // Keyboard Shortcuts (Ctrl+A = Accept, Ctrl+R = Reject)
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 'a') { e.preventDefault(); triggerAccept(); }
    if (e.ctrlKey && e.key.toLowerCase() === 'r') { e.preventDefault(); triggerReject(); }
  });

  // Mousedown listener (more primitive than click)
  document.addEventListener('mousedown', (e) => {
    const target = e.target.closest('button') || e.target;
    if (target.id === 'btn-accept' || target.classList.contains('btn-accept')) {
      triggerAccept();
    }
    if (target.id === 'btn-reject' || target.classList.contains('btn-reject')) {
      triggerReject();
    }
  });

  // Password modal submit
  $('btn-pwd-submit')?.addEventListener('click', () => {
    const pwd = $('password-input')?.value.trim();
    if (!pwd) return;
    ui.hidePasswordModal();
    if (state.pendingTargetId) {
      signaling.sendRequest(state.pendingTargetId, pwd);
      log(`إعادة المحاولة بكلمة مرور...`);
    }
  });

  $('btn-pwd-cancel')?.addEventListener('click', () => {
    ui.hidePasswordModal();
    resetConnectButton();
  });

  // Disconnect
  $('stool-disconnect')?.addEventListener('click', () => {
    if (state.activeSessionId) sessionManager.remove(state.activeSessionId);
  });

  // Chat Send
  const sendChat = () => {
    const input = $('chat-input');
    const text = input?.value.trim();
    if (!text) return;
    const session = state.sessions.get(state.activeSessionId);
    if (session) {
      session.rtc.sendControl({ type: 'chat-message', text });
      appendChatMessage('sent', text);
      input.value = '';
    }
  };
  $('btn-chat-send')?.addEventListener('click', sendChat);
  $('chat-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

  // Input Capture Setup
  const inputCapture = new InputCapture($('remote-video'), (data) => {
    const session = state.sessions.get(state.activeSessionId);
    if (session && !state.isHost) {
      session.rtc.sendControl(data);
    }
  });

  // Fullscreen
  $('stool-fullscreen')?.addEventListener('click', () => {
    const video = $('remote-video');
    if (video) video.requestFullscreen?.();
  });

  // Copy ID
  $('btn-copy-id')?.addEventListener('click', () => {
    navigator.clipboard.writeText(state.deviceId);
    ui.showToast('تم نسخ المعرّف ✓', 'success');
  });

  // Password visibility
  $('btn-toggle-pwd')?.addEventListener('click', () => ui.togglePasswordVisibility());

  // Refresh password
  $('btn-refresh-pwd')?.addEventListener('click', async () => {
    state.password = await window.phantom.refreshPassword();
    ui.setPassword(state.password);
    if (state.connected) {
      signaling.socket?.emit('update-password', { password: state.password });
    }
    ui.showToast('تم تجديد كلمة المرور ✓', 'success');
  });

  // Quick Actions
  $('act-screenshot')?.addEventListener('click', async () => {
    const data = await window.phantom.takeScreenshot();
    if (data) { log('تم التقاط لقطة شاشة ✓', 'success'); }
  });

  $('act-lock')?.addEventListener('click', () => {
    window.phantom.lock();
    log('تم قفل الجهاز', 'warning');
  });

  $('act-reboot')?.addEventListener('click', () => {
    if (confirm('هل تريد إعادة تشغيل الجهاز؟')) {
      window.phantom.reboot();
    }
  });

  // Terminal
  window.phantom.onShellData((data) => ui.appendTerminal(data));
  $('term-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const input = e.target.value + '\n';
      window.phantom.sendShellInput(input);
      e.target.value = '';
    }
  });

  // Settings
  $('btn-save-settings')?.addEventListener('click', async () => {
    const settings = {
      quality: $('set-quality')?.value || 'balanced',
      passwordEnabled: $('set-password')?.checked ?? true,
      clipboard: $('set-clipboard')?.checked ?? true,
      serverUrl: $('set-server')?.value || SIGNALING_SERVER
    };
    await window.phantom.setSettings(settings);
    await window.phantom.setPasswordEnabled(settings.passwordEnabled);
    ui.showToast('تم حفظ الإعدادات ✓', 'success');
    log('تم تحديث الإعدادات');
  });

  // Chat Toggle
  $('stool-chat')?.addEventListener('click', () => {
    const overlay = $('chat-overlay');
    if (overlay) overlay.style.display = overlay.style.display === 'none' ? 'flex' : 'none';
  });
  $('btn-chat-close')?.addEventListener('click', () => { if ($('chat-overlay')) $('chat-overlay').style.display = 'none'; });

  // Chat Send
  const sendChat = () => {
    const input = $('chat-input');
    const text = input?.value.trim();
    if (!text) return;
    rtc.sendControl({ type: 'chat-message', text });
    appendChatMessage('sent', text);
    input.value = '';
  };
  $('btn-chat-send')?.addEventListener('click', sendChat);
  $('chat-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

  // File Transfer
  $('stool-file')?.addEventListener('click', () => $('file-input-hidden')?.click());
  $('file-input-hidden')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    log(`جاري تحضير إرسال الملف: ${file.name} (${Math.round(file.size / 1024)} KB)...`);
    ui.showToast('ميزة إرسال الملفات قيد التشغيل...', 'info');
  });

  // ── 6. Performance Monitor (Throttled) ──
  let perfInterval = setInterval(async () => {
    if (state.sessionToken) return; // Stop heavy stats during active session to prevent lag
    try {
      const stats = await window.phantom.getSystemStats();
      ui.updatePerformance(stats);
    } catch {}
  }, 10000);

  // ── 7. Clipboard Synchronization (Throttled for Performance) ──
  let clipboardInterval = setInterval(async () => {
    if (!state.sessionToken) return;
    
    try {
      const current = await window.phantom.readClipboard();
      if (current && current !== state.lastClipboard) {
        state.lastClipboard = current;
        rtc.sendControl({ type: 'clipboard-sync', text: current });
        log('تم مزامنة الحافظة 📋');
      }
    } catch {}
  }, 5000); // Increased to 5s to reduce IPC overhead

  // ── Helpers ──
  function resetConnectButton() {
    const btn = $('btn-connect');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-bolt"></i> اتصال'; }
  }

  log('PhantomDesk جاهز للعمل 👻 (نظام تتبع الأخطاء نشط)', 'success');
})();

