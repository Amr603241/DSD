/**
 * PhantomDesk — Application Core v1.0
 * Orchestrates signaling, WebRTC, UI, and input modules.
 */

const SIGNALING_SERVER = 'http://127.0.0.1:8080';

(async function initPhantomDesk() {
  console.log('[PHANTOM] Initializing...');

  const ui = new UIManager();
  const rtc = new RTCEngine();
  const inputCapture = new InputCapture(rtc);
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
    lastClipboard: ''
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
    state.remoteSocketId = data.hostSocketId;
    state.sessionToken = data.sessionToken;
    log(`[TRACE] تم قبول الاتصال من ${data.hostDeviceId} — جاري البدء...`, 'success');

    try {
      log('[TRACE] V1. جاري تهيئة محرك RTC للمشاهد...');
      await rtc.init(true, 'viewer');
      if (state.sessionToken) await rtc.setEncryptionKey(state.sessionToken);
      
      log('[TRACE] V2. جاري إنشاء WebRTC Offer...');
      const offer = await rtc.createOffer();
      
      log('[TRACE] V3. إرسال الـ Offer للمضيف...');
      signaling.sendOffer(data.hostSocketId, offer);
      log('[TRACE] V4. تم إرسال الطلب التقني بنجاح ✓ وفي انتظار الرد (Answer)', 'success');
    } catch (e) {
      log('فشل إعداد الاتصال عند المشاهد: ' + e.message, 'error');
      ui.addDiagLog(`[CRITICAL] Viewer Handshake Error: ${e.message}`, 'error');
    }
  });

  signaling.on('offer', async (data) => {
    if (!state.isHost) return;
    log('[TRACE] تم استلام Offer — جاري إنشاء Answer...');
    try {
      const answer = await rtc.createAnswer(data.offer);
      signaling.sendAnswer(data.from, answer);
      state.remoteSocketId = data.from;
      log('[TRACE] تم إرسال WebRTC Answer');
    } catch (e) {
      log('فشل إنشاء Answer: ' + e.message, 'error');
    }
  });

  signaling.on('answer', async (data) => {
    log('تم استلام Answer — جاري تثبيت الاتصال...');
    try {
      await rtc.handleAnswer(data.answer);
    } catch (e) {
      log('فشل معالجة Answer: ' + e.message, 'error');
    }
  });

  signaling.on('ice-candidate', (data) => {
    rtc.addIceCandidate(data.candidate);
  });

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
        state.lastClipboard = data.text; // Update lastClipboard to prevent echo loop
        window.phantom.writeClipboard(data.text);
      } else {
        window.phantom.simulateInput(data);
      }
    } else {
      // Viewer receiving clipboard from host
      if (data.type === 'clipboard-sync' && data.text) {
        state.lastClipboard = data.text; // Update lastClipboard to prevent echo loop
        window.phantom.writeClipboard(data.text);
      }
    }
  });

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
  $('stool-disconnect')?.addEventListener('click', () => endSession());

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
    if (signaling.isConnected) {
      signaling.socket?.emit('update-password', { password: state.password });
    }
    ui.showToast('تم تجديد كلمة المرور ✓', 'success');
  });

  // Quick Actions
  $('act-screenshot')?.addEventListener('click', async () => {
    const data = await window.phantom.takeScreenshot();
    if (data) { log('تم التقاط لقطة شاشة ✓', 'success'); }
  });

  $('act-clipboard')?.addEventListener('click', async () => {
    const text = await window.phantom.readClipboard();
    ui.showToast(`الحافظة: ${text?.substring(0, 50) || '(فارغة)'}`, 'info');
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

  // Clear logs
  $('btn-clear-logs')?.addEventListener('click', () => ui.clearLogs());
  $('btn-copy-diag')?.addEventListener('click', () => {
    const diagBox = document.getElementById('diag-console');
    if (diagBox) {
      const text = diagBox.innerText;
      navigator.clipboard.writeText(text);
      ui.showToast('تم نسخ سجلات التشخيص ✓', 'success');
    }
  });
  $('btn-clear-diag')?.addEventListener('click', () => {
    const diagBox = document.getElementById('diag-console');
    if (diagBox) diagBox.innerHTML = '';
  });

  // Terminal
  window.phantom.startShell();
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

  // History reconnect
  $('history-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.h-reconnect');
    if (btn) {
      const id = btn.dataset.id;
      $('remote-id-input').value = id;
      $('btn-connect')?.click();
    }
  });

  // Fullscreen
  $('stool-fullscreen')?.addEventListener('click', () => {
    const video = $('remote-video');
    if (video) video.requestFullscreen?.();
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

  function endSession() {
    const target = state.remoteSocketId || state.incomingRequest?.fromSocketId;
    if (target) signaling.endSession(target, state.sessionToken);
    rtc.close();
    inputCapture.deactivate();
    ui.switchView('home');
    state.remoteSocketId = null;
    state.incomingRequest = null;
    state.sessionToken = null;
    state.isHost = false;
    log('تم إنهاء الجلسة', 'warning');
    resetConnectButton();
  }

  // ── 8. Global Shortcuts ──
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyD') {
      e.preventDefault();
      ui.switchView('diag');
      log('تم فتح شاشة التشخيص عبر الاختصار');
    }
  });

  // ── 9. Global Error Tracking ──
  window.onerror = (msg, url, line, col, error) => {
    const errorMsg = `[WINDOW ERROR] ${msg} at ${line}:${col}`;
    ui.addDiagLog(errorMsg, 'error');
    console.error(errorMsg, error);
    return false;
  };

  window.onunhandledrejection = (event) => {
    const errorMsg = `[PROMISE REJECTION] ${event.reason}`;
    ui.addDiagLog(errorMsg, 'error');
    console.error(errorMsg);
  };

  rtc.on('stats-update', (stats) => {
    state.currentFPS = stats.fps;
    ui.updateHUD(state.currentLatency || 0, Math.round(stats.fps));
    
    // ROOT FIX 5.0 TRACKING: Check if data is actually flowing
    const currentBytes = stats.bytesReceived || 0;
    if (!state.lastBytes) state.lastBytes = 0;
    const delta = currentBytes - state.lastBytes;
    state.lastBytes = currentBytes;

    if (state.sessionToken && delta === 0 && state.currentFPS === 0) {
      if (!state.noDataCounter) state.noDataCounter = 0;
      state.noDataCounter++;
      if (state.noDataCounter > 5) {
        ui.addDiagLog('[CRITICAL] لا يوجد تدفق بيانات رغم الاتصال! جاري محاولة الإنعاش...', 'error');
        state.noDataCounter = 0;
        // Attempt a small kick to the video element
        const video = $('remote-video');
        if (video && video.srcObject) {
           video.play().catch(() => {});
        }
      }
    } else {
      state.noDataCounter = 0;
    }

    if (stats.packetsLost > 0) {
      ui.addDiagLog(`[NET WARNING] Packet Loss detected: ${stats.packetsLost}`, 'warn');
    }
  });

  log('PhantomDesk جاهز للعمل 👻 (نظام تتبع الأخطاء نشط)', 'success');
})();

