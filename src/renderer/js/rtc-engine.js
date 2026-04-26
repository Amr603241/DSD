/**
 * PhantomDesk — WebRTC Engine v1.2 (Elite Edition)
 * Optimized for Firewall Bypass (TURN) and Guaranteed Video Playback.
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
        { urls: 'stun:stun.stunprotocol.org:3478' },
        // Free TURN server for firewall bypass
        {
          urls: 'turn:openrelay.metered.ca:80',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
        {
          urls: 'turn:openrelay.metered.ca:443',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        }
      ],
      iceCandidatePoolSize: 10,
      bundlePolicy: 'max-bundle'
    };
  }

  async init(isOfferer, mode) {
    if (this.pc) this.close();
    this.pc = new RTCPeerConnection(this.config);

    this.pc.onicecandidate = (e) => {
      if (e.candidate) this._fire('ice-candidate', e.candidate);
    };

    this.pc.ontrack = (e) => {
      this._fire('log-debug', `[RTC] Track received: ${e.track.kind}`);
      const stream = e.streams[0] || new MediaStream([e.track]);
      this._fire('stream', stream);
    };

    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc?.iceConnectionState;
      this._fire('ice-state', state);
      if (state === 'connected' || state === 'completed') {
        this._startLatencyMonitor();
      }
    };

    if (isOfferer) {
      // Viewer side: Prepare to receive video
      this.pc.addTransceiver('video', { direction: 'recvonly' });
      this.dataChannel = this.pc.createDataChannel('phantom-control', { ordered: false, maxRetransmits: 0 });
      this._setupDataChannel(this.dataChannel);
    } else {
      // Host side: Prepare to send data and video
      this.pc.ondatachannel = (e) => {
        this.dataChannel = e.channel;
        this._setupDataChannel(this.dataChannel);
      };
    }
  }

  async setEncryptionKey(sessionToken) {
    if (!sessionToken) return;
    const encoder = new TextEncoder();
    const keyData = encoder.encode(sessionToken);
    const hash = await crypto.subtle.digest('SHA-256', keyData);
    this._encryptionKey = await crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  _setupDataChannel(ch) {
    ch.onopen = () => this._fire('datachannel-open');
    ch.onmessage = async (e) => {
      try {
        let rawData = e.data;
        if (this._encryptionKey && rawData instanceof ArrayBuffer) rawData = await this._decrypt(rawData);
        const data = JSON.parse(typeof rawData === 'string' ? rawData : new TextDecoder().decode(rawData));
        if (data.type === 'pong') {
          const sent = this._latencyPings.get(data.id);
          if (sent) { this._fire('latency', Date.now() - sent); this._latencyPings.delete(data.id); }
          return;
        }
        if (data.type === 'ping') { this.sendControl({ type: 'pong', id: data.id }); return; }
        this._fire('control-data', data);
      } catch (err) {}
    };
  }

  async _encrypt(text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(text);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this._encryptionKey, encoded);
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(ciphertext), iv.length);
    return combined.buffer;
  }

  async _decrypt(buffer) {
    const iv = new Uint8Array(buffer, 0, 12);
    const ciphertext = new Uint8Array(buffer, 12);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, this._encryptionKey, ciphertext);
    return new TextDecoder().decode(decrypted);
  }

  async startScreenShare() {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always', frameRate: { max: 30 } },
        audio: false
      });
      return this._handleNewStream(stream);
    } catch (e) {
      this._fire('log-debug', 'Fallback to test stream');
      return this._handleNewStream(this._createTestStream());
    }
  }

  async _handleNewStream(stream) {
    this.localStream = stream;
    const track = stream.getVideoTracks()[0];
    if (this.pc) {
      const sender = this.pc.getSenders().find(s => s.track?.kind === 'video');
      if (sender) await sender.replaceTrack(track);
      else this.pc.addTrack(track, stream);
    }
    return stream;
  }

  _optimizeSDP(sdp) {
    // Force VP8 and high bitrate
    return sdp
      .replace(/m=video 9 [^\r\n]*/, 'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98')
      .replace('c=IN IP4 0.0.0.0', 'c=IN IP4 0.0.0.0\r\nb=AS:4000');
  }

  async createOffer() {
    const offer = await this.pc.createOffer();
    offer.sdp = this._optimizeSDP(offer.sdp);
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  async createAnswer(offer) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await this.pc.createAnswer();
    answer.sdp = this._optimizeSDP(answer.sdp);
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  async handleAnswer(answer) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
  }

  async addIceCandidate(candidate) {
    try {
      if (this.pc?.remoteDescription) await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {}
  }

  async sendControl(data) {
    if (this.dataChannel?.readyState === 'open') {
      const json = JSON.stringify(data);
      this.dataChannel.send(this._encryptionKey ? await this._encrypt(json) : json);
    }
  }

  _startLatencyMonitor() {
    setInterval(async () => {
      if (this.dataChannel?.readyState === 'open') {
        const id = Math.random().toString(36).substring(7);
        this._latencyPings.set(id, Date.now());
        this.sendControl({ type: 'ping', id });
      }
      if (this.pc) {
        const stats = await this.pc.getStats();
        stats.forEach(r => {
          if (r.type === 'inbound-rtp' && r.kind === 'video') {
            this._fire('stats-update', { fps: r.framesPerSecond || 0, latency: 0 });
          }
        });
      }
    }, 2000);
  }

  _createTestStream() {
    const canvas = document.createElement('canvas');
    canvas.width = 1280; canvas.height = 720;
    const ctx = canvas.getContext('2d');
    setInterval(() => {
      ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, 1280, 720);
      ctx.fillStyle = '#38bdf8'; ctx.font = '40px Inter';
      ctx.fillText('PHANTOM DESK - STANDBY MODE', 400, 360);
      ctx.strokeStyle = '#38bdf8'; ctx.strokeRect(50, 50, 1180, 620);
    }, 100);
    return canvas.captureStream(30);
  }

  close() {
    if (this.localStream) this.localStream.getTracks().forEach(t => t.stop());
    if (this.pc) this.pc.close();
    this.pc = null; this.localStream = null; this.dataChannel = null;
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
