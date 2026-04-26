/**
 * PhantomDesk — Remote Input Capture v1.0
 * Captures mouse/keyboard events from the viewer
 * and sends them to the host via DataChannel.
 */
class InputCapture {
  constructor(onControlData) {
    this.onData = onControlData;
    this.enabled = false;
    this._bound = {};
    this._hostScreenSize = null;
    this._rAF = null;
    this._pendingMove = null;
    this._lastSentTime = 0;
    this._throttleMs = 20; // 50Hz control loop
  }

  async activate(videoElement) {
    this.enabled = true;
    this.videoEl = videoElement;

    // Get host screen dimensions for coordinate mapping
    try {
      this._hostScreenSize = await window.phantom.getScreenSize();
    } catch {
      this._hostScreenSize = { width: 1920, height: 1080, scaleFactor: 1 };
    }

    // Prevent context menu on right-click
    this._bound.contextmenu = (e) => e.preventDefault();
    this.videoEl.addEventListener('contextmenu', this._bound.contextmenu);

    // Mouse events
    this._bound.mousemove = (e) => {
      this._pendingMove = e;
      const now = Date.now();
      if (now - this._lastSentTime >= this._throttleMs) {
        this._processMouseMove();
      }
    };
    this._bound.mousedown = (e) => this._sendMouse('mousedown', e);
    this._bound.mouseup   = (e) => this._sendMouse('mouseup', e);
    this._bound.dblclick  = (e) => this._sendMouse('dblclick', e);
    this._bound.wheel     = (e) => {
      if (!this.enabled) return;
      this.onData({ type: 'wheel', deltaY: e.deltaY, deltaX: e.deltaX });
      e.preventDefault();
    };

    this.videoEl.addEventListener('mousemove', this._bound.mousemove);
    this.videoEl.addEventListener('mousedown', this._bound.mousedown);
    this.videoEl.addEventListener('mouseup',   this._bound.mouseup);
    this.videoEl.addEventListener('dblclick',  this._bound.dblclick);
    this.videoEl.addEventListener('wheel',     this._bound.wheel, { passive: false });

    // Keyboard events (global)
    this._bound.keydown = (e) => this._sendKey('keydown', e);
    this._bound.keyup   = (e) => this._sendKey('keyup', e);
    document.addEventListener('keydown', this._bound.keydown);
    document.addEventListener('keyup',   this._bound.keyup);

    // Focus the video for keyboard capture
    this.videoEl.setAttribute('tabindex', '0');
    this.videoEl.focus();
  }

  deactivate() {
    this.enabled = false;
    if (this.videoEl) {
      this.videoEl.removeEventListener('contextmenu', this._bound.contextmenu);
      this.videoEl.removeEventListener('mousemove',   this._bound.mousemove);
      this.videoEl.removeEventListener('mousedown',   this._bound.mousedown);
      this.videoEl.removeEventListener('mouseup',     this._bound.mouseup);
      this.videoEl.removeEventListener('dblclick',    this._bound.dblclick);
      this.videoEl.removeEventListener('wheel',       this._bound.wheel);
    }
    document.removeEventListener('keydown', this._bound.keydown);
    document.removeEventListener('keyup',   this._bound.keyup);
  }

  _processMouseMove() {
    if (this._pendingMove) {
      this._sendMouse('mousemove', this._pendingMove);
      this._pendingMove = null;
      this._lastSentTime = Date.now();
    }
  }

  _sendMouse(type, e) {
    if (!this.enabled || !this.videoEl) return;

    // MINIMUM DELTA: Only send if moved significantly
    if (type === 'mousemove' && this._lastX !== undefined && this._lastY !== undefined) {
      const dx = Math.abs(e.clientX - this._lastX);
      const dy = Math.abs(e.clientY - this._lastY);
      if (dx < 0.5 && dy < 0.5) return;
      this._lastX = e.clientX;
      this._lastY = e.clientY;
    }

    const rect = this.videoEl.getBoundingClientRect();
    const vidW = this.videoEl.videoWidth || 1920;
    const vidH = this.videoEl.videoHeight || 1080;
    
    // Optimized Mapping Logic
    if (!this._cachedRatios || this._lastRectW !== rect.width || this._lastRectH !== rect.height) {
      const containerRatio = rect.width / rect.height;
      const videoRatio = vidW / vidH;
      let actualW, actualH, offsetX, offsetY;

      if (containerRatio > videoRatio) {
        actualH = rect.height;
        actualW = actualH * videoRatio;
        offsetY = 0; offsetX = (rect.width - actualW) / 2;
      } else {
        actualW = rect.width;
        actualH = actualW / videoRatio;
        offsetX = 0; offsetY = (rect.height - actualH) / 2;
      }

      this._cachedRatios = {
        w: actualW, h: actualH, ox: offsetX, oy: offsetY,
        rw: this._hostScreenSize.width / actualW,
        rh: this._hostScreenSize.height / actualH
      };
      this._lastRectW = rect.width;
      this._lastRectH = rect.height;
    }

    const r = this._cachedRatios;
    const x = Math.round(((e.clientX - rect.left) - r.ox) * r.rw);
    const y = Math.round(((e.clientY - rect.top) - r.oy) * r.rh);

    const cx = Math.max(0, Math.min(x, this._hostScreenSize.width - 1));
    const cy = Math.max(0, Math.min(y, this._hostScreenSize.height - 1));
    this.onData({ type, x: cx, y: cy, button: e.button });
  }

  _sendKey(type, e) {
    if (!this.enabled) return;

    // Don't capture if user is typing in an input field (except in session view)
    const tag = e.target.tagName.toLowerCase();
    if ((tag === 'input' || tag === 'textarea') && !this.videoEl?.contains(e.target)) return;

    e.preventDefault();
    e.stopPropagation();

    this.onData({
      type,
      code: e.code,
      key: e.key,
      altKey: e.altKey,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey
    });
  }
}

window.InputCapture = InputCapture;
