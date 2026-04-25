/**
 * PhantomDesk — WebRTC Engine v1.1 (Elite Edition)
 * Handles peer connections, screen sharing, and encrypted data channels.
 */
class RTCEngine {
  constructor() {
    this.pc = null;
    this.localStream = null;
    this.dataChannel = null;
    this._handlers = {};
    this._latencyPings = new Map();
    this._encryptionKey = null;

    this.config = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        { urls: 'stun:stun.ekiga.net' },
        { urls: 'stun:stun.ideasip.com' },
        { urls: 'stun:stun.schlund.de' },
        { urls: 'stun:stun.stunprotocol.org:3478' }
      ],
      iceCandidatePoolSize: 10,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    };
  }

  async init(isOfferer, mode) {
    if (this.pc) this.close();
    
    this.pc = new RTCPeerConnection(this.config);

    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        this._fire('log-debug', `[RTC] New ICE Candidate: ${e.candidate.protocol} ${e.candidate.type}`);
        this._fire('ice-candidate', e.candidate);
      }
    };

    this.pc.ontrack = (e) => {
      this._fire('log-debug', `[RTC] ontrack fired: ${e.track.kind}`);
      const stream = e.streams[0] || new MediaStream([e.track]);
      this._fire('stream', stream);
    };

    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc?.iceConnectionState;
      this._fire('log-debug', `[DEEP-TRACE] ICE state: ${state}`);
      this._fire('ice-state', state);
      
      if (state === 'connected' || state === 'completed') {
        this._fire('log-debug', '[DEEP-TRACE] الاتصال الفيزيائي ناجح ✓');
        this._startLatencyMonitor();
      }
      
      if (state === 'failed') {
        this._fire('log-debug', '[DEEP-TRACE] فشل ICE - جاري محاولة إعادة التفاوض...');
        this._handleIceFailure();
      }
    };

    this.pc.onconnectionstatechange = () => {
      this._fire('log-debug', `[DEEP-TRACE] Connection state: ${this.pc.connectionState}`);
    };

    this.pc.onsignalingstatechange = () => {
      this._fire('log-debug', `[DEEP-TRACE] Signaling state: ${this.pc.signalingState}`);
    };

    // Add transceivers with explicit directions and preferences
    if (isOfferer) {
      // Viewer (Offerer) wants to receive
      const transceiver = this.pc.addTransceiver('video', { direction: 'recvonly' });
      
      // CRITICAL FIX: pc.ontrack does NOT fire for locally created transceivers.
      // We must manually construct the MediaStream and fire it so the UI attaches it.
      setTimeout(() => {
        const stream = new MediaStream([transceiver.receiver.track]);
        this._fire('log-debug', `[RTC] Manually firing stream for locally created transceiver`);
        this._fire('stream', stream);
      }, 500);
      
      // DataChannel for remote control input
      this.dataChannel = this.pc.createDataChannel('phantom-control', {
        ordered: false,
        maxRetransmits: 0
      });
      this._setupDataChannel(this.dataChannel);
    } else {
      // Host (Answerer) wants to send
      // Transceiver will be automatically created when startScreenShare calls addTrack
      
      this.pc.ondatachannel = (e) => {
        this.dataChannel = e.channel;
        this._setupDataChannel(this.dataChannel);
      };
    }
    
    // Set video bandwidth and codec preferences (H.264 priority)
    this._fire('log-debug', `RTC Engine initialized as ${isOfferer ? 'offerer' : 'answerer'}`);
  }

  /**
   * Derive a 256-bit AES-GCM key from the session token
   */
  async setEncryptionKey(sessionToken) {
    if (!sessionToken) return;
    const encoder = new TextEncoder();
    const keyData = encoder.encode(sessionToken);
    const hash = await crypto.subtle.digest('SHA-256', keyData);
    this._encryptionKey = await crypto.subtle.importKey(
      'raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']
    );
  }

  _setupDataChannel(ch) {
    ch.onopen = () => this._fire('datachannel-open');
    ch.onclose = () => this._fire('datachannel-close');
    ch.onmessage = async (e) => {
      try {
        let rawData = e.data;
        
        // Decrypt if key exists
        if (this._encryptionKey && rawData instanceof ArrayBuffer) {
          rawData = await this._decrypt(rawData);
        }

        const data = JSON.parse(typeof rawData === 'string' ? rawData : new TextDecoder().decode(rawData));
        
        if (data.type === 'pong') {
          const sent = this._latencyPings.get(data.id);
          if (sent) {
            this._fire('latency', Date.now() - sent);
            this._latencyPings.delete(data.id);
          }
          return;
        }
        if (data.type === 'ping') {
          this.sendControl({ type: 'pong', id: data.id });
          return;
        }
        this._fire('control-data', data);
      } catch (err) {
        console.error('[RTC] DataChannel parse error:', err);
      }
    };
  }



  async _encrypt(text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(text);
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, this._encryptionKey, encoded
    );
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(ciphertext), iv.length);
    return combined.buffer;
  }

  async _decrypt(buffer) {
    const iv = new Uint8Array(buffer, 0, 12);
    const ciphertext = new Uint8Array(buffer, 12);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv }, this._encryptionKey, ciphertext
    );
    return new TextDecoder().decode(decrypted);
  }

  async startScreenShare() {
    this._fire('log-debug', 'جاري بدء التقاط الشاشة عبر النظام الأصلي...');
    
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { max: 1920 },
          height: { max: 1080 },
          frameRate: { max: 20 }
        },
        audio: false
      });
      return this._handleNewStream(stream);
    } catch (e) {
      this._fire('log-debug', `[!] فشل التقاط الشاشة الأصلي: ${e.message} - جاري استخدام شاشة الاختبار الاحتياطية...`);
      const testStream = this._createTestStream();
      return this._handleNewStream(testStream);
    }
  }

  async _handleNewStream(stream) {
    this.screenStream = stream;
    const videoTrack = stream.getVideoTracks()[0];
    videoTrack.enabled = true;

    if (this.pc) {
      const existingSender = this.pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (existingSender) {
        try {
          await existingSender.replaceTrack(videoTrack);
          this._fire('log-debug', `[RTC] Successfully replaced sender track with screen capture`);
        } catch (e) {
          this._fire('log-debug', `[RTC] replaceTrack error: ${e.message}, falling back to addTrack`);
          this.pc.addTrack(videoTrack, stream);
        }
      } else {
        this._fire('log-debug', `[RTC] Adding new video track to PeerConnection`);
        this.pc.addTrack(videoTrack, stream);
      }
    }
    return stream;
  }

  // --- SDP Mangling for Root Fix ---
  _optimizeSDP(sdp) {
    let lines = sdp.split('\r\n');
    const newLines = [];
    
    // ROOT FIX 5.0: Force VP8 for maximum stability across all hardware
    let preferredPayloads = [];
    lines.forEach(l => {
      if (l.startsWith('a=rtpmap:') && l.includes('VP8/90000')) {
        const m = l.match(/a=rtpmap:(\d+)/);
        if (m) preferredPayloads.push(m[1]);
      }
    });

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      
      if (line.startsWith('m=video')) {
        const parts = line.split(' ');
        const media = parts.slice(0, 3);
        const existing = parts.slice(3);
        const sorted = [...preferredPayloads, ...existing.filter(p => !preferredPayloads.includes(p))];
        line = [...media, ...sorted].join(' ');
      }

      newLines.push(line);

      if (line.startsWith('c=IN IP4') && i > 5) {
        newLines.push('b=AS:2000'); // Moderate 2Mbps for stability
        newLines.push('a=x-google-min-bitrate=500');
        newLines.push('a=x-google-start-bitrate=1000');
      }
    }

    return newLines.join('\r\n');
  }

  _createTestStream() {
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 480;
    const ctx = canvas.getContext('2d');
    let x = 0;
    setInterval(() => {
      ctx.fillStyle = '#07080f';
      ctx.fillRect(0, 0, 640, 480);
      ctx.fillStyle = '#6c5ce7';
      ctx.fillRect(x, 100, 100, 100);
      ctx.fillStyle = '#fff';
      ctx.fillText('PHANTOM TEST PATTERN', 200, 250);
      x = (x + 5) % 640;
    }, 30);
    return canvas.captureStream(30);
  }

  async createOffer() {
    let offer = await this.pc.createOffer();
    const optimizedSdp = this._optimizeSDP(offer.sdp);
    offer = new RTCSessionDescription({ type: 'offer', sdp: optimizedSdp });
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  async createAnswer(offer) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    let answer = await this.pc.createAnswer();
    const optimizedSdp = this._optimizeSDP(answer.sdp);
    answer = new RTCSessionDescription({ type: 'answer', sdp: optimizedSdp });
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  async handleAnswer(answer) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
    if (this._queuedCandidates) {
      this._fire('log-debug', `[RTC] Processing ${this._queuedCandidates.length} queued candidates`);
      for (const candidate of this._queuedCandidates) {
        try { await this.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
      }
      this._queuedCandidates = [];
    }
  }

  async addIceCandidate(candidate) {
    try {
      if (this.pc && this.pc.remoteDescription) {
        await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } else if (this.pc) {
        // Queue candidates if remote description not set yet
        if (!this._queuedCandidates) this._queuedCandidates = [];
        this._queuedCandidates.push(candidate);
      }
    } catch (e) {
      this._fire('log-debug', `[RTC] Error adding ICE candidate: ${e.message}`);
    }
  }

  async _handleIceFailure() {
    this._fire('log-debug', '[RTC] ICE Failure detected. Triggering restart...');
    this._fire('ice-restart');
  }

  async restartIce() {
    if (!this.pc) return;
    try {
      this._fire('log-debug', '[RTC] Restarting ICE negotiation...');
      const offer = await this.pc.createOffer({ iceRestart: true });
      await this.pc.setLocalDescription(offer);
      return offer;
    } catch (e) {
      this._fire('log-debug', `[RTC] ICE Restart failed: ${e.message}`);
    }
  }

  async sendControl(data) {
    if (this.dataChannel?.readyState === 'open') {
      const json = JSON.stringify(data);
      if (this._encryptionKey) {
        const encrypted = await this._encrypt(json);
        this.dataChannel.send(encrypted);
      } else {
        this.dataChannel.send(json);
      }
    }
  }

  _startLatencyMonitor() {
    this._latencyInterval = setInterval(async () => {
      // 1. DataChannel Ping/Pong
      if (this.dataChannel?.readyState === 'open') {
        const id = Date.now().toString(36);
        this._latencyPings.set(id, Date.now());
        this.sendControl({ type: 'ping', id });
        for (const [k, v] of this._latencyPings) {
          if (Date.now() - v > 5000) this._latencyPings.delete(k);
        }
      }

      // 2. Advanced WebRTC Stats
      if (this.pc && (this.pc.iceConnectionState === 'connected' || this.pc.iceConnectionState === 'completed')) {
        try {
          const stats = await this.pc.getStats();
          let videoStats = { fps: 0, packetsLost: 0, jitter: 0, bytesReceived: 0 };
          stats.forEach(report => {
            if (report.type === 'inbound-rtp' && report.kind === 'video') {
              videoStats = {
                fps: report.framesPerSecond || 0,
                packetsLost: report.packetsLost || 0,
                jitter: Math.round(report.jitter * 1000) || 0,
                bytesReceived: report.bytesReceived || 0
              };
            }
          });
          this._fire('stats-update', videoStats);
        } catch (e) {
          this._fire('log-debug', `[STATS ERROR] ${e.message}`);
        }
      }
    }, 2000);
  }

  close() {
    if (this._latencyInterval) clearInterval(this._latencyInterval);
    if (this.localStream) this.localStream.getTracks().forEach(t => t.stop());
    if (this.dataChannel) this.dataChannel.close();
    if (this.pc) this.pc.close();
    this.pc = null;
    this.localStream = null;
    this.dataChannel = null;
    this._encryptionKey = null;
    this._queuedCandidates = [];
    this._detectedTracks = new Set();
  }

  /**
   * Dynamically adjust the video bitrate (Kbps)
   */
  async updateBitrate(kbps) {
    if (!this.pc) return;
    const senders = this.pc.getSenders();
    const videoSender = senders.find(s => s.track?.kind === 'video');
    if (videoSender) {
      const params = videoSender.getParameters();
      if (!params.encodings) params.encodings = [{}];
      params.encodings[0].maxBitrate = kbps * 1000;
      await videoSender.setParameters(params);
      console.log(`[RTC] Bitrate adjusted to: ${kbps} Kbps`);
    }
  }

  on(event, handler) {
    if (!this._handlers[event]) this._handlers[event] = [];
    this._handlers[event].push(handler);
  }

  _fire(event, data) {
    (this._handlers[event] || []).forEach(h => h(data));
  }
}

window.RTCEngine = RTCEngine;


