// Webview client: renders CDP screencast frames to a <canvas> and forwards input back
// to the extension host (which relays to the shared BrowserSession). This is the HUMAN
// half of the co-drive; the agent drives the same browser over MCP.

interface VsCodeApi {
  postMessage(message: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

interface FrameMetadata {
  offsetTop?: number;
  pageScaleFactor?: number;
  deviceWidth?: number;
  deviceHeight?: number;
  scrollOffsetX?: number;
  scrollOffsetY?: number;
}

const vscode = acquireVsCodeApi();

const canvas = document.getElementById('screen') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const urlInput = document.getElementById('url') as HTMLInputElement;
const goBtn = document.getElementById('go') as HTMLButtonElement;
const nativeBtn = document.getElementById('native') as HTMLButtonElement;

let lastMeta: FrameMetadata = {};
let callbackSeq = 0;
const pending = new Map<number, (value: unknown) => void>();

/** Fire-and-forget command to the host (used for high-frequency Input events). */
function fire(type: string, params?: Record<string, unknown>): void {
  vscode.postMessage({ type, params });
}

/** Request/response command to the host, correlated by callbackId. */
function send(type: string, params?: Record<string, unknown>): Promise<unknown> {
  const callbackId = ++callbackSeq;
  return new Promise((resolve) => {
    pending.set(callbackId, resolve);
    vscode.postMessage({ type, params, callbackId });
  });
}

window.addEventListener('message', (event: MessageEvent) => {
  const m = event.data;
  if (m?.method === 'Page.screencastFrame') {
    drawFrame(m.result as { data: string; metadata: FrameMetadata });
    return;
  }
  if (m?.callbackId != null && pending.has(m.callbackId)) {
    pending.get(m.callbackId)!(m.result);
    pending.delete(m.callbackId);
  }
});

const image = new Image();
let pendingData: string | null = null;
image.onload = () => {
  if (canvas.width !== image.width || canvas.height !== image.height) {
    canvas.width = image.width;
    canvas.height = image.height;
  }
  ctx.drawImage(image, 0, 0);
  // If a newer frame arrived mid-decode, render it next.
  if (pendingData) {
    const next = pendingData;
    pendingData = null;
    image.src = 'data:image/jpeg;base64,' + next;
  }
};

function drawFrame(result: { data: string; metadata: FrameMetadata }): void {
  lastMeta = result.metadata || {};
  if (!image.complete) {
    pendingData = result.data; // coalesce: skip stale frames while one is decoding
    return;
  }
  image.src = 'data:image/jpeg;base64,' + result.data;
}

// ----- coordinate mapping: displayed canvas px -> page CSS px -----
function toPageCoords(e: MouseEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const deviceWidth = lastMeta.deviceWidth || canvas.width;
  const deviceHeight = lastMeta.deviceHeight || canvas.height;
  const x = ((e.clientX - rect.left) / rect.width) * deviceWidth;
  const y = ((e.clientY - rect.top) / rect.height) * deviceHeight + (lastMeta.offsetTop || 0);
  return { x: Math.round(x), y: Math.round(y) };
}

function modifiers(e: MouseEvent | KeyboardEvent): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

function buttonName(button: number): string {
  return button === 2 ? 'right' : button === 1 ? 'middle' : 'left';
}

// ----- mouse -----
let lastMove = 0;
canvas.addEventListener('mousemove', (e) => {
  const now = performance.now();
  if (now - lastMove < 33) return; // ~30fps throttle to avoid flooding CDP
  lastMove = now;
  const { x, y } = toPageCoords(e);
  // `buttons` must be carried on moves or CDP treats a held-button drag as a hover,
  // and drag-select / sliders / drag-and-drop never register.
  fire('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: e.buttons, modifiers: modifiers(e) });
});

canvas.addEventListener('mousedown', (e) => {
  canvas.focus();
  const { x, y } = toPageCoords(e);
  fire('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: buttonName(e.button),
    buttons: e.buttons,
    clickCount: e.detail || 1,
    modifiers: modifiers(e),
  });
});

canvas.addEventListener('mouseup', (e) => {
  const { x, y } = toPageCoords(e);
  fire('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: buttonName(e.button),
    buttons: e.buttons,
    clickCount: e.detail || 1,
    modifiers: modifiers(e),
  });
});

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const { x, y } = toPageCoords(e);
    // CDP mouseWheel shares the DOM sign convention — forward deltas as-is (a DOM
    // WheelEvent already reflects the user's intended direction, incl. natural scroll).
    fire('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      modifiers: modifiers(e),
    });
  },
  { passive: false },
);

// ----- keyboard -----
canvas.addEventListener('keydown', (e) => {
  e.preventDefault();
  const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
  const base = {
    key: e.key,
    code: e.code,
    windowsVirtualKeyCode: e.keyCode,
    modifiers: modifiers(e),
  };
  // A keyDown carrying `text` fires DOM keydown + keypress AND inserts the character
  // (mirrors puppeteer keyboard.press). A bare `char` event skips keydown, so single-key
  // page shortcuts ('/', 'j'/'k', space-to-scroll) would never trigger.
  if (printable) {
    fire('Input.dispatchKeyEvent', { type: 'keyDown', text: e.key, ...base });
  } else {
    fire('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  }
});

canvas.addEventListener('keyup', (e) => {
  fire('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: e.key,
    code: e.code,
    windowsVirtualKeyCode: e.keyCode,
    modifiers: modifiers(e),
  });
});

// ----- toolbar -----
function navigate(): void {
  let url = urlInput.value.trim();
  if (!url) return;
  if (!/^[a-z]+:\/\//i.test(url)) url = 'https://' + url;
  void send('Page.navigate', { url });
}
goBtn.addEventListener('click', navigate);
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') navigate();
});
nativeBtn.addEventListener('click', () => fire('extension.openNativeWindow'));
