/**
 * PhantomDesk Signaling Server v1.0
 * ─────────────────────────────────
 * Handles device registration, authentication,
 * WebRTC signaling relay, and session management.
 */

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const app = express();
const httpServer = createServer(app);

// ── Security Middleware ──
app.use(helmet({ contentSecurityPolicy: false })); // Disable CSP to prevent resource blocking during dev
app.use(express.json());

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1000,
  skip: (req) => req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1',
  message: { error: 'Too many requests, slow down.' }
});
app.use(limiter);

const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingInterval: 25000,
  pingTimeout: 60000, // Very high timeout for heavy rendering sessions
  maxHttpBufferSize: 1e7 // Increase buffer size
});

// ── State ──
const devices = new Map();   // deviceId → { socketId, password, passwordEnabled, registeredAt }
const sessions = new Map();  // sessionToken → { hostId, viewerId, createdAt }

// ── Utility ──
function generateSessionToken() {
  return crypto.randomBytes(16).toString('hex');
}

function cleanExpiredSessions() {
  const now = Date.now();
  const TIMEOUT = 30 * 60 * 1000; // 30 minutes
  for (const [token, session] of sessions) {
    if (now - session.createdAt > TIMEOUT) {
      sessions.delete(token);
    }
  }
}
setInterval(cleanExpiredSessions, 60000);

// ── HTTP Endpoints ──
app.get('/', (req, res) => {
  res.json({
    name: 'PhantomDesk Signaling Server',
    version: '1.0.0',
    status: 'operational',
    connectedDevices: devices.size,
    activeSessions: sessions.size,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ── Socket.IO Logic ──
io.on('connection', (socket) => {
  console.log(`[+] Client connected: ${socket.id.substring(0, 8)}`);

  // ── Register Device ──
  socket.on('register', ({ deviceId, password, passwordEnabled }) => {
    if (!deviceId || typeof deviceId !== 'string') {
      socket.emit('error', { message: 'Invalid device ID' });
      return;
    }

    // If device already registered with different socket, update it
    const existing = devices.get(deviceId);
    if (existing && existing.socketId !== socket.id) {
      console.log(`[~] Device ${deviceId} re-registered (new socket)`);
    }

    devices.set(deviceId, {
      socketId: socket.id,
      password: password || null,
      passwordEnabled: passwordEnabled !== false,
      registeredAt: Date.now()
    });

    socket.deviceId = deviceId;
    socket.emit('registered', { deviceId, success: true });
    console.log(`[✓] Device registered: ${deviceId} | Password: ${passwordEnabled !== false ? 'ON' : 'OFF'}`);
  });

  // ── Update Password ──
  socket.on('update-password', ({ password, passwordEnabled }) => {
    if (socket.deviceId && devices.has(socket.deviceId)) {
      const device = devices.get(socket.deviceId);
      if (password !== undefined) device.password = password;
      if (passwordEnabled !== undefined) device.passwordEnabled = passwordEnabled;
      console.log(`[~] Password updated: ${socket.deviceId}`);
    }
  });

  // ── Connection Request (Viewer → Host) ──
  socket.on('connect-to', ({ targetId, password }) => {
    // Self-connection guard
    if (targetId === socket.deviceId) {
      socket.emit('connection-error', {
        message: 'Cannot connect to yourself',
        code: 'SELF_CONNECT'
      });
      return;
    }

    const target = devices.get(targetId);

    if (!target) {
      socket.emit('connection-error', {
        message: 'Device not found or offline',
        code: 'NOT_FOUND'
      });
      return;
    }

    // Password check (Now optional: if incorrect, block; if missing, allow for manual approval)
    if (target.passwordEnabled && password) {
      if (target.password !== password) {
        socket.emit('connection-error', {
          message: 'Incorrect password',
          code: 'WRONG_PASSWORD'
        });
        return;
      }
    }

    // Create session token
    const sessionToken = generateSessionToken();
    sessions.set(sessionToken, {
      hostId: targetId,
      viewerId: socket.deviceId,
      createdAt: Date.now()
    });

    // Notify host with robust delivery
    const hostSocket = io.sockets.sockets.get(target.socketId);
    if (hostSocket) {
      hostSocket.emit('connection-request', {
        from: socket.deviceId,
        fromSocketId: socket.id,
        sessionToken,
        hasPassword: !!password
      });
      console.log(`[→] Request delivered: ${socket.deviceId} → ${targetId}`);
    } else {
      socket.emit('connection-error', { message: 'Target device went offline', code: 'TARGET_OFFLINE' });
      return;
    }
  });

  // ── Host Accepts ──
  socket.on('accept-connection', ({ targetSocketId, sessionToken }) => {
    io.to(targetSocketId).emit('connection-accepted', {
      hostSocketId: socket.id,
      hostDeviceId: socket.deviceId,
      sessionToken
    });
    console.log(`[✓] Connection accepted by: ${socket.deviceId}`);
  });

  // ── Host Rejects ──
  socket.on('reject-connection', ({ targetSocketId }) => {
    io.to(targetSocketId).emit('connection-rejected', {
      message: 'Connection rejected by remote user'
    });
    console.log(`[✗] Connection rejected by: ${socket.deviceId}`);
  });

  // ── WebRTC Signaling ──
  socket.on('offer', ({ target, offer }) => {
    io.to(target).emit('offer', { from: socket.id, offer });
    console.log(`[⇄] Offer: ${socket.id.substring(0, 6)} → ${target.substring(0, 6)}`);
  });

  socket.on('answer', ({ target, answer }) => {
    io.to(target).emit('answer', { from: socket.id, answer });
    console.log(`[⇄] Answer: ${socket.id.substring(0, 6)} → ${target.substring(0, 6)}`);
  });

  socket.on('ice-candidate', ({ target, candidate }) => {
    io.to(target).emit('ice-candidate', { from: socket.id, candidate });
  });

  // ── Chat Relay ──
  socket.on('chat-message', ({ target, message, timestamp }) => {
    io.to(target).emit('chat-message', {
      from: socket.id,
      fromDevice: socket.deviceId,
      message,
      timestamp: timestamp || Date.now()
    });
  });

  // ── File Transfer Signal ──
  socket.on('file-offer', ({ target, fileName, fileSize, fileId }) => {
    io.to(target).emit('file-offer', {
      from: socket.id,
      fileName, fileSize, fileId
    });
  });

  socket.on('file-accept', ({ target, fileId }) => {
    io.to(target).emit('file-accepted', { fileId });
  });

  // ── Session End ──
  socket.on('end-session', ({ target, sessionToken }) => {
    if (sessionToken) sessions.delete(sessionToken);
    io.to(target).emit('session-ended', {
      from: socket.id,
      message: 'Session ended'
    });
    console.log(`[✗] Session ended by: ${socket.deviceId}`);
  });

  // ── Disconnect ──
  socket.on('disconnect', (reason) => {
    if (socket.deviceId) {
      const device = devices.get(socket.deviceId);
      if (device && device.socketId === socket.id) {
        devices.delete(socket.deviceId);
        console.log(`[-] Device unregistered: ${socket.deviceId} (${reason})`);
      }
    }
  });
});

// ── Start ──
const PORT = process.env.PORT || 8080;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('┌─────────────────────────────────────────────┐');
  console.log('│    👻 PhantomDesk Signaling Server v1.0     │');
  console.log('├─────────────────────────────────────────────┤');
  console.log(`│  🌐 Port: ${PORT}                              │`);
  console.log(`│  📡 http://localhost:${PORT}                    │`);
  console.log(`│  🔒 Helmet + Rate Limiting: ACTIVE          │`);
  console.log('└─────────────────────────────────────────────┘');
  console.log('');
});
