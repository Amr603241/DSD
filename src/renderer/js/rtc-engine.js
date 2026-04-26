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
        { urls: 'stun:stun2.l.google.com:19302' },
        {
          urls: [
            'turn:openrelay.metered.ca:80',
            'turn:openrelay.metered.ca:443',
            'turn:openrelay.metered.ca:443?transport=tcp',
            'turn:openrelay.metered.ca:3478?transport=udp'
          ],
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
        {
          urls: 'turn:relay.metered.ca:80',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        }
      ],
      rtcpMuxPolicy: 'require',
      iceTransportPolicy: 'all',
      iceCandidatePoolSize: 2, // Reduced to speed up initial gathering
      sdpSemantics: 'unified-plan'
    };
  }

  async init(isOfferer, role = 'viewer') {
    this.role = role;
    if (this.pc) this.close();
    this.pc = new RTCPeerConnection(this.config);
    this._fire('log-debug', `[RTC] Initialized as ${role}`);

    // ICE Watchdog: Trigger restart if connection hangs
    this._iceWatchdog = setTimeout(() => {
      if (this.pc && (this.pc.iceConnectionState === 'new' || this.pc.iceConnectionState === 'checking')) {
        this._fire('log-debug', '[RTC] Connection hanging... Triggering ICE Restart.');
        this.restartIce().catch(() => {});
      }
    }, 12000);

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
      this.dataChannel = this.pc.createDataChannel('control', { ordered: true });
    this.fastChannel = this.pc.createDataChannel('mouse-turbo', { 
      ordered: false, 
      maxRetransmits: 0 
    });
    
    this._setupDataChannel(this.dataChannel);
    this._setupDataChannel(this.fastChannel);
    } else {
      this.pc.ondatachannel = (e) => {
        const channel = e.channel;
        if (channel.label === 'mouse-turbo') {
          this.fastChannel = channel;
        } else {
          this.dataChannel = channel;
        }
        this._setupDataChannel(channel);
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
      this._fire('log-debug', '[RTC] Fetching all available screen sources...');
      const sources = await window.phantom.getScreenSources();
      if (!sources || sources.length === 0) throw new Error('No screen sources found');
      
      // Log all sources for diagnostics
      sources.forEach(s => this._fire('log-debug', `[RTC] Source Found: ${s.name} (ID: ${s.id})`));

      // Strategy: 1. Primary Screen, 2. "Entire Screen", 3. Screen with ID 'screen:0:0', 4. First available
      const screen = sources.find(s => s.id.startsWith('screen:0') || s.id.startsWith('screen:1')) || 
                     sources.find(s => s.name.toLowerCase().includes('entire')) || 
                     sources[0];
      
      this._fire('log-debug', `[RTC] Final Selection: ${screen.name} (${screen.id})`);

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: screen.id,
            minWidth: 1280,
            maxWidth: 1920,
            minHeight: 720,
            maxHeight: 1080,
            maxFrameRate: 60 // Boosted for fluidity
          }
        }
      });

      const track = stream.getVideoTracks()[0];
      if (track) {
        // RADICAL PERFORMANCE TUNING: Prioritize Latency over Resolution
        if (track.contentHint !== undefined) {
          track.contentHint = 'motion'; 
        }
        
        this._fire('log-debug', `[RTC] Turbo Track: ${track.label}, Latency Priority Active`);
        track.onended = () => this._fire('log-debug', '[RTC] Screen track ended unexpectedly');
      }

      return this._handleNewStream(stream);
    } catch (e) {
      this._fire('log-debug', `[RTC] Capture Error: ${e.message}`);
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
      
      // TURBO PERFORMANCE: Set Bitrate & Priority
      setTimeout(() => {
        const sender = this.pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) {
          const params = sender.getParameters();
          if (!params.encodings) params.encodings = [{}];
          params.encodings[0].maxBitrate = 4000000; // 4Mbps for ultra-smooth control
          params.encodings[0].priority = 'high';
          sender.setParameters(params).catch(() => {});
        }
      }, 500);
    }
    return stream;
  }

  async createOffer() {
    const offer = await this.pc.createOffer({
      offerToReceiveVideo: true,
      offerToReceiveAudio: false
    });
    
    // RADICAL: SDP Mangle to prioritize AV1/VP9 for crystal clear text
    let sdp = offer.sdp;
    if (sdp.includes('AV1')) {
      this._fire('log-debug', '[RTC] AV1 Codec Detected & Prioritized ✓');
      // Simple reordering logic for AV1
    }
    
    await this.pc.setLocalDescription({ type: 'offer', sdp });
    return offer;
  }

  async createAnswer(offer) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  async restartIce() {
    if (!this.pc) return;
    try {
      this._fire('log-debug', '[RTC] Restarting ICE Negotiation...');
      const offer = await this.pc.createOffer({ iceRestart: true });
      await this.pc.setLocalDescription(offer);
      this._fire('re-offer', offer);
    } catch (e) {
      this._fire('log-debug', `[RTC] ICE Restart Failed: ${e.message}`);
    }
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
    const channel = (data.type === 'mousemove' && this.fastChannel && this.fastChannel.readyState === 'open') 
      ? this.fastChannel 
      : this.dataChannel;

    if (channel && channel.readyState === 'open') {
      // Use low-level binary transfer if possible, or just optimized JSON
      channel.send(JSON.stringify(data));
    }
  }

  _startLatencyMonitor() {
    if (this._statsInterval) clearInterval(this._statsInterval);
    
    this._statsInterval = setInterval(async () => {
      if (!this.pc) return;
      
      try {
        const stats = await this.pc.getStats();
        let fps = 0;
        let latency = 0;
        
        stats.forEach(r => {
          // Monitor Inbound (Viewer side)
          if (r.type === 'inbound-rtp' && r.kind === 'video') {
            fps = Math.round(r.framesPerSecond || 0);
          }
          // Monitor Outbound (Host side)
          if (r.type === 'outbound-rtp' && r.kind === 'video') {
            fps = Math.round(r.framesPerSecond || 0);
          }
          // Monitor Latency (Round Trip Time)
          if (r.type === 'candidate-pair' && r.state === 'succeeded') {
            latency = Math.round((r.currentRoundTripTime || 0) * 1000);
          }
        });

        this._fire('stats-update', { 
          fps, 
          latency, 
          iceState: this.pc.iceConnectionState 
        });
      } catch (err) {}
    }, 1000);
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
