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

const stage = document.getElementById('stage') as HTMLDivElement;
const canvas = document.getElementById('screen') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const urlInput = document.getElementById('url') as HTMLInputElement;
const backBtn = document.getElementById('back') as HTMLButtonElement;
const forwardBtn = document.getElementById('forward') as HTMLButtonElement;
const reloadBtn = document.getElementById('reload') as HTMLButtonElement;
const highlightEl = document.getElementById('highlight') as HTMLDivElement;
const zoomInBtn = document.getElementById('zoomin') as HTMLButtonElement;
const zoomOutBtn = document.getElementById('zoomout') as HTMLButtonElement;
const zoomLabel = document.getElementById('zoomlabel') as HTMLSpanElement;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

let lastVp = '';
let lastMeta: FrameMetadata = {};

/** Fire-and-forget command to the host (input events + toolbar actions). */
function fire(type: string, params?: Record<string, unknown>): void {
  vscode.postMessage({ type, params });
}

window.addEventListener('message', (event: MessageEvent) => {
  const m = event.data;
  if (m?.method === 'Page.screencastFrame') {
    drawFrame(m.result as { data: string; metadata: FrameMetadata });
    return;
  }
  if (m?.type === 'extension.url') {
    // Don't clobber what the user is typing.
    if (document.activeElement !== urlInput) urlInput.value = m.url;
    return;
  }
  if (m?.type === 'extension.highlight') {
    flashHighlight(m.box as Box);
    return;
  }
  if (m?.type === 'extension.zoomlabel') {
    zoomLabel.textContent = Math.round((m.zoom ?? 1) * 100) + '%';
    return;
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
  // ⌘/Ctrl +/-/0 → per-site zoom, don't forward to the page.
  if (e.metaKey || e.ctrlKey) {
    if (e.key === '=' || e.key === '+') { e.preventDefault(); fire('extension.zoom', { dir: 'in' }); return; }
    if (e.key === '-' || e.key === '_') { e.preventDefault(); fire('extension.zoom', { dir: 'out' }); return; }
    if (e.key === '0') { e.preventDefault(); fire('extension.zoom', { dir: 'reset' }); return; }
  }
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

// Paste (⌘V/Ctrl+V): the canvas isn't a real input, and a headless browser has no system
// clipboard, so forward the clipboard text and inject it into the page's focused field.
window.addEventListener('paste', (e: ClipboardEvent) => {
  if (document.activeElement !== canvas) return; // let the URL bar paste normally
  const text = e.clipboardData?.getData('text/plain');
  if (text) {
    e.preventDefault();
    fire('Input.insertText', { text });
  }
});

// ----- toolbar -----
function navigate(): void {
  let url = urlInput.value.trim();
  if (!url) return;
  if (!/^[a-z]+:\/\//i.test(url)) url = 'https://' + url;
  // Route through the host (puppeteer goto on this panel's page) rather than a
  // raw CDP Page.navigate, so it works even before the screencast CDP exists.
  fire('extension.navigate', { url });
}
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') navigate();
});
urlInput.addEventListener('focus', () => urlInput.select());
backBtn.addEventListener('click', () => fire('extension.back'));
forwardBtn.addEventListener('click', () => fire('extension.forward'));
reloadBtn.addEventListener('click', () => fire('extension.reload'));
zoomInBtn.addEventListener('click', () => fire('extension.zoom', { dir: 'in' }));
zoomOutBtn.addEventListener('click', () => fire('extension.zoom', { dir: 'out' }));

// ----- agent action highlight -----
// The box arrives in the page's viewport CSS px, which — because the viewport is
// set at deviceScaleFactor 1 — equals the screencast's device px, which equals
// the canvas bitmap coordinate space. So it maps to on-screen px by the same
// canvas-display scale the frames use. Shown briefly, then fades, so the human
// can see where the agent is working without a rendered cursor.
let highlightTimer = 0;
function flashHighlight(box: Box): void {
  const scaleX = canvas.clientWidth / (canvas.width || 1);
  const scaleY = canvas.clientHeight / (canvas.height || 1);
  highlightEl.style.left = `${box.x * scaleX}px`;
  highlightEl.style.top = `${box.y * scaleY}px`;
  highlightEl.style.width = `${box.width * scaleX}px`;
  highlightEl.style.height = `${box.height * scaleY}px`;
  highlightEl.hidden = false;
  // Restart the appear/fade cycle even if a highlight is already showing.
  highlightEl.classList.remove('show');
  void highlightEl.offsetWidth; // reflow so the class re-add re-triggers
  highlightEl.classList.add('show');
  window.clearTimeout(highlightTimer);
  highlightTimer = window.setTimeout(() => highlightEl.classList.remove('show'), 1000);
}

// ----- viewport: match the browser to the panel size, in DEVICE pixels -----
// Page.startScreencast ignores deviceScaleFactor (it captures at CSS-pixel resolution), so
// to fill a retina panel crisply we make the CSS viewport itself cssSize*dpr px at scale 1.
function reportViewport(): void {
  const cssW = Math.round(stage.clientWidth);
  const cssH = Math.round(stage.clientHeight);
  // Don't push a degenerate viewport before the panel is laid out.
  if (cssW < 50 || cssH < 50) return;
  const dpr = window.devicePixelRatio || 1;
  const key = `${cssW}x${cssH}@${dpr}`;
  if (key === lastVp) return;
  lastVp = key;
  // The host multiplies by dpr and divides by the per-site zoom.
  fire('extension.viewport', { cssW, cssH, dpr });
}
// Fires once the stage has a real size, and on every panel resize.
new ResizeObserver(() => {
  reportViewport();
  // A highlight is positioned in px for the size it was drawn at; drop it on
  // resize rather than let a stale box sit misaligned until the next action.
  highlightEl.classList.remove('show');
}).observe(stage);

// Tell the host we're listening so it (re)starts the screencast now that the message
// handler exists — otherwise the initial frame is lost and a static page stays blank.
fire('extension.ready');
