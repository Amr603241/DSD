/**
 * PhantomDesk — WebRTC Engine v1.4 (Elite Edition)
 * Stability Core: No-Mangle Handshake + Standard Tracks + Firewall Bypass
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
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        {
          urls: [
            'turn:openrelay.metered.ca:80',
            'turn:openrelay.metered.ca:443',
            'turn:openrelay.metered.ca:443?transport=tcp',
            'turn:openrelay.metered.ca:3478?transport=udp'
          ],
          username: 'openrelayproject',
          credential: 'openrelayproject'
        }
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
      if (e.candidate) this._fire('ice-candidate', e.candidate);
    };

    this.pc.ontrack = (e) => {
      this._fire('log-debug', `[RTC] Track event: ${e.track.kind}`);
      const stream = e.streams[0] || new MediaStream([e.track]);
      this._fire('stream', stream);
    };

    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc?.iceConnectionState;
      this._fire('ice-state', state);
      if (state === 'connected' || state === 'completed') this._startLatencyMonitor();
    };

    if (isOfferer) {
      // Viewer Side: Explicitly request video to ensure SDP has m=video line
      this.pc.addTransceiver('video', { direction: 'recvonly' });
      // Create DataChannel
      this.dataChannel = this.pc.createDataChannel('phantom-control', { ordered: false, maxRetransmits: 0 });
      this._setupDataChannel(this.dataChannel);
    } else {
      this.pc.ondatachannel = (e) => {
        this.dataChannel = e.channel;
        this._setupDataChannel(this.dataChannel);
      };
    }
  }

  async setEncryptionKey(token) {
    // Disabled for stability troubleshooting
    this._encryptionKey = null; 
  }

  _setupDataChannel(ch) {
    ch.onopen = () => this._fire('datachannel-open');
    ch.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
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

  async startScreenShare() {
    try {
      this._fire('log-debug', '[RTC] Requesting screen sources from main process...');
      const sources = await window.phantom.getScreenSources();
      if (!sources || sources.length === 0) throw new Error('No screen sources found');
      
      // Prioritize the primary display or "Entire Screen"
      const screen = sources.find(s => s.id.startsWith('screen:1') || s.name.toLowerCase().includes('entire')) || sources[0];
      this._fire('log-debug', `[RTC] Selecting source: ${screen.name} (${screen.id})`);

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
      return this._handleNewStream(stream);
    } catch (e) {
      this._fire('log-debug', `[RTC] Capture failed: ${e.message}. Using test stream.`);
      return this._handleNewStream(this._createTestStream());
    }
  }

  async _handleNewStream(stream) {
    this.localStream = stream;
    const videoTrack = stream.getVideoTracks()[0];
    
    if (videoTrack) {
      const transceivers = this.pc.getTransceivers();
      const videoTransceiver = transceivers.find(t => t.receiver && t.receiver.track && t.receiver.track.kind === 'video' || t.sender && t.sender.track && t.sender.track.kind === 'video' || t.mid !== null);
      
      if (videoTransceiver && videoTransceiver.sender) {
        this._fire('log-debug', '[RTC] Replacing track on existing transceiver');
        await videoTransceiver.sender.replaceTrack(videoTrack);
        videoTransceiver.direction = 'sendonly';
      } else {
        this._fire('log-debug', '[RTC] Adding new track to PC');
        this.pc.addTrack(videoTrack, stream);
      }
    }
    return stream;
  }

  async createOffer() {
    // No SDP mangling for maximum stability
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  async createAnswer(offer) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await this.pc.createAnswer();
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
      this.dataChannel.send(JSON.stringify(data));
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
            this._fire('stats-update', { fps: Math.round(r.framesPerSecond || 0), latency: 0 });
          }
        });
      }
    }, 2000);
  }

  _createTestStream() {
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 480;
    const ctx = canvas.getContext('2d');
    setInterval(() => {
      ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, 640, 480);
      ctx.fillStyle = '#ef4444'; ctx.font = '20px Arial';
      ctx.fillText('STABILITY FALLBACK MODE', 180, 240);
      ctx.strokeStyle = '#fff'; ctx.strokeRect(10, 10, 620, 460);
    }, 200);
    return canvas.captureStream(15);
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
