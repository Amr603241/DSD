/**
 * PhantomDesk — Signaling Client v1.0
 * Socket.IO-based signaling for WebRTC negotiation.
 */
class SignalingClient {
  constructor(serverUrl) {
    this.serverUrl = serverUrl || 'http://127.0.0.1:8080';
    this.socket = null;
    this._handlers = {};
    this.isConnected = false;
  }

  connect(deviceId, password) {
    return new Promise((resolve, reject) => {
      if (typeof io === 'undefined') return reject(new Error('Socket.IO not loaded'));

      // Disconnect existing
      if (this.socket) { this.socket.disconnect(); this.socket = null; }

      this.socket = io(this.serverUrl, {
        transports: ['websocket', 'polling'], // Fallback to polling if websocket fails
        timeout: 10000,
        reconnection: true,
        reconnectionAttempts: Infinity, // Keep trying to reconnect
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        randomizationFactor: 0.5
      });

      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
        this.socket?.disconnect();
      }, 10000);

      this.socket.on('connect', () => {
        clearTimeout(timeout);
        this.isConnected = true;
        this.socket.emit('register', { deviceId, password });
        resolve();
      });

      this.socket.on('connect_error', (err) => {
        clearTimeout(timeout);
        this.isConnected = false;
        reject(err);
      });

      this.socket.on('disconnect', () => { this.isConnected = false; this._fire('disconnected'); });
      this.socket.on('reconnect', () => { this.isConnected = true; this._fire('reconnected'); });

      // Relay events
      this.socket.on('connection-request',  d => this._fire('request', d));
      this.socket.on('connection-accepted', d => this._fire('accepted', d));
      this.socket.on('connection-rejected', d => this._fire('rejected', d));
      this.socket.on('connection-error',    d => this._fire('connection-error', d));
      this.socket.on('offer',               d => this._fire('offer', d));
      this.socket.on('answer',              d => this._fire('answer', d));
      this.socket.on('ice-candidate',       d => this._fire('ice-candidate', d));
      this.socket.on('chat-message',        d => this._fire('chat', d));
      this.socket.on('session-ended',       d => this._fire('session-ended', d));
    });
  }

  sendRequest(targetId, password) {
    if (!this.isConnected) throw new Error('Not connected to server');
    this.socket.emit('connect-to', { targetId, password });
  }

  acceptRequest(targetSocketId, sessionToken) {
    this.socket?.emit('accept-connection', { targetSocketId, sessionToken });
  }

  rejectRequest(targetSocketId) {
    this.socket?.emit('reject-connection', { targetSocketId });
  }

  sendOffer(target, offer) {
    this.socket?.emit('offer', { target, offer });
  }

  sendAnswer(target, answer) {
    this.socket?.emit('answer', { target, answer });
  }

  sendIceCandidate(target, candidate) {
    this.socket?.emit('ice-candidate', { target, candidate });
  }

  sendChat(target, message) {
    this.socket?.emit('chat-message', { target, message, timestamp: Date.now() });
  }

  endSession(target, sessionToken) {
    this.socket?.emit('end-session', { target, sessionToken });
  }

  disconnect() {
    this.socket?.disconnect();
    this.isConnected = false;
  }

  on(event, handler) {
    if (!this._handlers[event]) this._handlers[event] = [];
    this._handlers[event].push(handler);
  }

  _fire(event, data) {
    (this._handlers[event] || []).forEach(h => h(data));
  }
}

window.SignalingClient = SignalingClient;
