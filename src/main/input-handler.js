/**
 * PhantomDesk — Native Input Handler v1.0
 * ────────────────────────────────────────
 * Uses koffi FFI to call Windows SendInput API
 * for precise mouse and keyboard simulation.
 */

let user32 = null;
let SendInput, SetCursorPos, GetSystemMetrics;

// ── Structures for SendInput ──
const INPUT_MOUSE    = 0;
const INPUT_KEYBOARD = 1;

const MOUSEEVENTF_MOVE       = 0x0001;
const MOUSEEVENTF_LEFTDOWN   = 0x0002;
const MOUSEEVENTF_LEFTUP     = 0x0004;
const MOUSEEVENTF_RIGHTDOWN  = 0x0008;
const MOUSEEVENTF_RIGHTUP    = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
const MOUSEEVENTF_MIDDLEUP   = 0x0040;
const MOUSEEVENTF_WHEEL      = 0x0800;
const MOUSEEVENTF_ABSOLUTE   = 0x8000;

const KEYEVENTF_KEYUP        = 0x0002;
const KEYEVENTF_EXTENDEDKEY  = 0x0001;

// ── Load user32.dll ──
try {
  const koffi = require('koffi');
  user32 = koffi.load('user32.dll');

  SetCursorPos    = user32.func('int __stdcall SetCursorPos(int, int)');
  GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int)');

  // Legacy API functions (reliable fallback)
  const mouse_event_fn = user32.func('void __stdcall mouse_event(unsigned int, unsigned int, unsigned int, unsigned int, uintptr_t)');
  const keybd_event_fn = user32.func('void __stdcall keybd_event(unsigned char, unsigned char, unsigned int, uintptr_t)');

  // Store for use in handler
  user32._mouse_event = mouse_event_fn;
  user32._keybd_event = keybd_event_fn;

  // DPI Awareness
  try {
    const SetProcessDPIAware = user32.func('int __stdcall SetProcessDPIAware()');
    SetProcessDPIAware();
  } catch {}

  console.log('[✓] Native input: user32.dll loaded with DPI awareness');
} catch (e) {
  console.error('[✗] koffi/user32 load failed:', e.message);
}

// ── VK Code Map ──
const VK_MAP = {
  'Backspace': 0x08, 'Tab': 0x09, 'Enter': 0x0D,
  'ShiftLeft': 0x10, 'ShiftRight': 0x10,
  'ControlLeft': 0x11, 'ControlRight': 0x11,
  'AltLeft': 0x12, 'AltRight': 0x12,
  'Pause': 0x13, 'CapsLock': 0x14, 'Escape': 0x1B,
  'Space': 0x20, 'PageUp': 0x21, 'PageDown': 0x22,
  'End': 0x23, 'Home': 0x24,
  'ArrowLeft': 0x25, 'ArrowUp': 0x26, 'ArrowRight': 0x27, 'ArrowDown': 0x28,
  'PrintScreen': 0x2C, 'Insert': 0x2D, 'Delete': 0x2E,
  'Digit0': 0x30, 'Digit1': 0x31, 'Digit2': 0x32, 'Digit3': 0x33,
  'Digit4': 0x34, 'Digit5': 0x35, 'Digit6': 0x36, 'Digit7': 0x37,
  'Digit8': 0x38, 'Digit9': 0x39,
  'KeyA': 0x41, 'KeyB': 0x42, 'KeyC': 0x43, 'KeyD': 0x44,
  'KeyE': 0x45, 'KeyF': 0x46, 'KeyG': 0x47, 'KeyH': 0x48,
  'KeyI': 0x49, 'KeyJ': 0x4A, 'KeyK': 0x4B, 'KeyL': 0x4C,
  'KeyM': 0x4D, 'KeyN': 0x4E, 'KeyO': 0x4F, 'KeyP': 0x50,
  'KeyQ': 0x51, 'KeyR': 0x52, 'KeyS': 0x53, 'KeyT': 0x54,
  'KeyU': 0x55, 'KeyV': 0x56, 'KeyW': 0x57, 'KeyX': 0x58,
  'KeyY': 0x59, 'KeyZ': 0x5A,
  'MetaLeft': 0x5B, 'MetaRight': 0x5C,
  'F1': 0x70, 'F2': 0x71, 'F3': 0x72, 'F4': 0x73,
  'F5': 0x74, 'F6': 0x75, 'F7': 0x76, 'F8': 0x77,
  'F9': 0x78, 'F10': 0x79, 'F11': 0x7A, 'F12': 0x7B,
  'NumLock': 0x90, 'ScrollLock': 0x91,
  'Semicolon': 0xBA, 'Equal': 0xBB, 'Comma': 0xBC,
  'Minus': 0xBD, 'Period': 0xBE, 'Slash': 0xBF,
  'Backquote': 0xC0, 'BracketLeft': 0xDB, 'Backslash': 0xDC,
  'BracketRight': 0xDD, 'Quote': 0xDE,
  'Numpad0': 0x60, 'Numpad1': 0x61, 'Numpad2': 0x62, 'Numpad3': 0x63,
  'Numpad4': 0x64, 'Numpad5': 0x65, 'Numpad6': 0x66, 'Numpad7': 0x67,
  'Numpad8': 0x68, 'Numpad9': 0x69,
  'NumpadMultiply': 0x6A, 'NumpadAdd': 0x6B, 'NumpadSubtract': 0x6D,
  'NumpadDecimal': 0x6E, 'NumpadDivide': 0x6F
};

const EXTENDED_KEYS = new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
  'ControlRight', 'AltRight', 'MetaLeft', 'MetaRight',
  'NumpadDivide', 'NumpadEnter'
]);

// ── Screen Metrics Cache ──
let metricsCache = { w: 0, h: 0, ts: 0 };
function getMetrics() {
  const now = Date.now();
  if (now - metricsCache.ts > 3000) {
    metricsCache.w = GetSystemMetrics(0);
    metricsCache.h = GetSystemMetrics(1);
    metricsCache.ts = now;
  }
  return metricsCache;
}

function getVK(code, key) {
  if (VK_MAP[code]) return VK_MAP[code];
  if (key && key.length === 1) return key.toUpperCase().charCodeAt(0);
  return null;
}

// ── Main Input Handler ──
function handleInput(data) {
  if (!user32 || !data) return;

  const x = Number.isFinite(data.x) ? Math.round(data.x) : null;
  const y = Number.isFinite(data.y) ? Math.round(data.y) : null;
  const m = getMetrics();

  switch (data.type) {
    case 'mousemove': {
      if (x === null || y === null) return;
      const ax = Math.floor((x * 65535) / (m.w - 1 || 1));
      const ay = Math.floor((y * 65535) / (m.h - 1 || 1));
      user32._mouse_event(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, ax, ay, 0, 0);
      break;
    }

    case 'mousedown': {
      if (x !== null && y !== null) {
        const ax = Math.floor((x * 65535) / (m.w || 1));
        const ay = Math.floor((y * 65535) / (m.h || 1));
        user32._mouse_event(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, ax, ay, 0, 0);
      }
      const downFlag = data.button === 2 ? MOUSEEVENTF_RIGHTDOWN :
                        data.button === 1 ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_LEFTDOWN;
      user32._mouse_event(downFlag, 0, 0, 0, 0);
      break;
    }

    case 'mouseup': {
      const upFlag = data.button === 2 ? MOUSEEVENTF_RIGHTUP :
                     data.button === 1 ? MOUSEEVENTF_MIDDLEUP : MOUSEEVENTF_LEFTUP;
      user32._mouse_event(upFlag, 0, 0, 0, 0);
      break;
    }

    case 'dblclick': {
      if (x !== null && y !== null) {
        const ax = Math.floor((x * 65535) / (m.w || 1));
        const ay = Math.floor((y * 65535) / (m.h || 1));
        user32._mouse_event(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, ax, ay, 0, 0);
      }
      user32._mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
      user32._mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
      user32._mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
      user32._mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
      break;
    }

    case 'wheel': {
      const delta = data.deltaY > 0 ? -120 : 120;
      user32._mouse_event(MOUSEEVENTF_WHEEL, 0, 0, delta, 0);
      break;
    }

    case 'keydown': {
      const vk = getVK(data.code, data.key);
      if (vk) {
        const flags = EXTENDED_KEYS.has(data.code) ? KEYEVENTF_EXTENDEDKEY : 0;
        user32._keybd_event(vk, 0, flags, 0);
      }
      break;
    }

    case 'keyup': {
      const vk = getVK(data.code, data.key);
      if (vk) {
        const flags = KEYEVENTF_KEYUP | (EXTENDED_KEYS.has(data.code) ? KEYEVENTF_EXTENDEDKEY : 0);
        user32._keybd_event(vk, 0, flags, 0);
      }
      break;
    }
  }
}

module.exports = { handleInput };
