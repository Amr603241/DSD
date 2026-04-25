/**
 * PhantomDesk — Remote Input Capture v1.0
 * Captures mouse/keyboard events from the viewer
 * and sends them to the host via DataChannel.
 */
class InputCapture {
  constructor(rtcEngine) {
    this.rtc = rtcEngine;
    this.enabled = false;
    this._bound = {};
    this._hostScreenSize = null;
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
    this._bound.mousemove = (e) => this._sendMouse('mousemove', e);
    this._bound.mousedown = (e) => this._sendMouse('mousedown', e);
    this._bound.mouseup   = (e) => this._sendMouse('mouseup', e);
    this._bound.dblclick  = (e) => this._sendMouse('dblclick', e);
    this._bound.wheel     = (e) => {
      if (!this.enabled) return;
      this.rtc.sendControl({ type: 'wheel', deltaY: e.deltaY, deltaX: e.deltaX });
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

  _sendMouse(type, e) {
    if (!this.enabled || !this.videoEl) return;

    // Throttle mousemove to ~30fps (33ms)
    if (type === 'mousemove') {
      const now = Date.now();
      if (this._lastMove && (now - this._lastMove < 33)) return;
      this._lastMove = now;
    }

    const rect = this.videoEl.getBoundingClientRect();
    const vidW = this.videoEl.videoWidth || 1920;
    const vidH = this.videoEl.videoHeight || 1080;

    // Map viewer coordinates to host screen coordinates
    const scaleX = this._hostScreenSize.width / rect.width;
    const scaleY = this._hostScreenSize.height / rect.height;

    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);

    // Clamp to screen bounds
    const cx = Math.max(0, Math.min(x, this._hostScreenSize.width - 1));
    const cy = Math.max(0, Math.min(y, this._hostScreenSize.height - 1));

    this.rtc.sendControl({ type, x: cx, y: cy, button: e.button });
  }

  _sendKey(type, e) {
    if (!this.enabled) return;

    // Don't capture if user is typing in an input field (except in session view)
    const tag = e.target.tagName.toLowerCase();
    if ((tag === 'input' || tag === 'textarea') && !this.videoEl?.contains(e.target)) return;

    e.preventDefault();
    e.stopPropagation();

    this.rtc.sendControl({
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
