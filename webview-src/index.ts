// Webview client: renders CDP screencast frames to a <canvas> and forwards input back
// to the extension host (which relays to the shared BrowserSession). This is the HUMAN
// half of the co-drive; the agent drives the same browser over MCP.

interface VsCodeApi {
  postMessage(message: unknown): void;
  setState(state: unknown): void;
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
const videoEl = document.getElementById('video') as HTMLVideoElement;
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
/** Page CSS viewport while in WebRTC mode (host-supplied); the input coordinate space. */
let rtcPage = { w: 0, h: 0 };

/** Fire-and-forget command to the host (input events + toolbar actions). */
function fire(type: string, params?: Record<string, unknown>): void {
  vscode.postMessage({ type, params });
}

window.addEventListener('message', (event: MessageEvent) => {
  const m = event.data;
  if (m?.method === 'cobrowser.frame') {
    onFrame(m as { bytes: Uint8Array | ArrayBuffer; metadata: FrameMetadata });
    return;
  }
  if (m?.method === 'cobrowser.rtcstart') {
    startRtc(m as { url: string });
    return;
  }
  if (m?.method === 'cobrowser.rtcstop') {
    resetVideo();
    return;
  }
  if (m?.method === 'cobrowser.rtcpagesize') {
    // The page's CSS coordinate space. The video is a 2x recording of it, so its
    // intrinsic size must NOT be used to place input events.
    rtcPage = { w: Number(m.width) || 0, h: Number(m.height) || 0 };
    return;
  }
  if (m?.type === 'extension.url') {
    // Don't clobber what the user is typing.
    if (document.activeElement !== urlInput) urlInput.value = m.url;
    // Persist for VS Code's panel serializer: on reload the restored tab shell hands
    // this state back, letting the host match it to its page (instant tabs).
    vscode.setState({ url: m.url });
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
  if (m?.type === 'extension.remeasure') {
    // Host wants the current panel size re-pushed (e.g. this tab just became the
    // foreground and the page viewport may be stale). Bypass the dedupe key.
    lastVp = '';
    reportViewport();
    return;
  }
  if (m?.type === 'extension.contextmenu') {
    showMenu(
      (m.at ?? { clientX: 0, clientY: 0 }) as { clientX: number; clientY: number },
      !!m.hasSelection,
      (m.link ?? null) as string | null,
    );
    return;
  }
});

// Binary frame path: raw JPEG bytes arrive over postMessage (no base64, no data: URL)
// and decode OFF the main thread via createImageBitmap. Latest-frame-wins: if a new
// frame lands while one is decoding, the queued one is replaced, never backlogged.
interface BinaryFrame {
  bytes: Uint8Array | ArrayBuffer;
  metadata: FrameMetadata;
}
let decoding = false;
let queuedFrame: BinaryFrame | null = null;

function onFrame(frame: BinaryFrame): void {
  if (decoding) {
    queuedFrame = frame;
    return;
  }
  decoding = true;
  void renderFrame(frame).finally(() => {
    decoding = false;
    const next = queuedFrame;
    queuedFrame = null;
    if (next) onFrame(next);
  });
}

async function renderFrame(frame: BinaryFrame): Promise<void> {
  try {
    lastMeta = frame.metadata || {};
    const bmp = await createImageBitmap(new Blob([frame.bytes as BlobPart], { type: 'image/jpeg' }));
    if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
      canvas.width = bmp.width;
      canvas.height = bmp.height;
    }
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
  } catch {
    /* malformed/torn frame — skip it, the next one repaints */
  }
}

// ----- WebRTC path: the page arrives as a live MediaStream in a <video> element -----
// This is the fast path. The editor composites <video> natively — no per-frame
// JavaScript, no canvas blit, no structured-clone IPC — and WebRTC supplies frame
// pacing and a jitter buffer. The canvas above stays as the fallback renderer.
let pc: RTCPeerConnection | null = null;
let sigWs: WebSocket | null = null;

function resetVideo(): void {
  try {
    pc?.close();
  } catch {
    /* already closed */
  }
  try {
    sigWs?.close();
  } catch {
    /* already closed */
  }
  pc = null;
  sigWs = null;
  rtcPage = { w: 0, h: 0 }; // stale dims must not leak into the fallback path
  videoEl.srcObject = null;
  videoEl.hidden = true;
  canvas.hidden = false;
}

function startRtc(cfg: { url: string }): void {
  resetVideo();
  try {
    const ws = new WebSocket(cfg.url);
    sigWs = ws;
    const conn = new RTCPeerConnection({ iceServers: [] }); // loopback: host candidates
    pc = conn;

    conn.ontrack = (e) => {
      videoEl.srcObject = e.streams[0];
      void videoEl.play().catch(() => undefined);
      // Only swap away from the canvas once real frames are flowing, so a failed
      // negotiation never leaves a blank panel.
      videoEl.onloadeddata = () => {
        videoEl.hidden = false;
        canvas.hidden = true;
      };
    };
    conn.onicecandidate = (e) => {
      if (e.candidate && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ kind: 'ice', payload: e.candidate }));
      }
    };
    conn.onconnectionstatechange = () => {
      if (conn.connectionState === 'failed' || conn.connectionState === 'disconnected') {
        resetVideo();
        fire('extension.videoerror'); // host falls back to the JPEG screencast
      }
    };

    ws.onmessage = async (ev: MessageEvent) => {
      let m: { kind: string; payload: unknown };
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      try {
        if (m.kind === 'offer') {
          await conn.setRemoteDescription(m.payload as RTCSessionDescriptionInit);
          const answer = await conn.createAnswer();
          await conn.setLocalDescription(answer);
          ws.send(JSON.stringify({ kind: 'answer', payload: conn.localDescription }));
        } else if (m.kind === 'ice') {
          await conn.addIceCandidate(m.payload as RTCIceCandidateInit).catch(() => undefined);
        }
      } catch {
        resetVideo();
        fire('extension.videoerror');
      }
    };
    ws.onerror = () => {
      resetVideo();
      fire('extension.videoerror');
    };
  } catch {
    resetVideo();
    fire('extension.videoerror');
  }
}

// ----- coordinate mapping: displayed canvas px -> page CSS px -----
function toPageCoords(e: MouseEvent): { x: number; y: number } {
  // Map against whichever surface is live. In WebRTC mode the target space is the page's
  // CSS viewport (supplied by the host) — NOT the video's intrinsic size, which is a 2x
  // recording of it; using the latter sent every event to double its true position.
  const live = !videoEl.hidden && videoEl.videoWidth > 0;
  const rect = (live ? videoEl : canvas).getBoundingClientRect();
  const deviceWidth = live
    ? rtcPage.w || videoEl.videoWidth
    : lastMeta.deviceWidth || canvas.width;
  const deviceHeight = live
    ? rtcPage.h || videoEl.videoHeight
    : lastMeta.deviceHeight || canvas.height;
  // Clamp: drags tracked at window level can leave the canvas — pin them to the
  // page edge (matches how a real browser selects when you drag past the window).
  const fx = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  const fy = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
  const x = fx * deviceWidth;
  // offsetTop is a screencast-metadata concept; the WebRTC stream has no such offset.
  const y = fy * deviceHeight + (live ? 0 : lastMeta.offsetTop || 0);
  return { x: Math.round(x), y: Math.round(y) };
}

function modifiers(e: MouseEvent | KeyboardEvent): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

function buttonName(button: number): string {
  return button === 2 ? 'right' : button === 1 ? 'middle' : 'left';
}

// ----- mouse -----
/** CDP name of the currently-held primary button, for move events. Blink only
 *  treats a move as part of a drag (text selection, sliders, drag-and-drop)
 *  when `button` is set on the move — the `buttons` bitmask alone is not enough
 *  (puppeteer's Mouse does the same). */
function heldButton(buttons: number): string | undefined {
  if (buttons & 1) return 'left';
  if (buttons & 2) return 'right';
  if (buttons & 4) return 'middle';
  return undefined;
}

let lastMove = 0;
let dragging = false;

function sendMove(e: MouseEvent): void {
  const now = performance.now();
  if (now - lastMove < 16) return; // ~60fps — input bypasses the agent queue, so it's cheap
  lastMove = now;
  const { x, y } = toPageCoords(e);
  fire('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
    button: heldButton(e.buttons),
    buttons: e.buttons,
    modifiers: modifiers(e),
  });
}

stage.addEventListener('mousedown', (e) => {
  stage.focus();
  dragging = true;
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

// Moves and releases are tracked on WINDOW, not the canvas: a drag that leaves the
// canvas must keep selecting and must end when the button is released anywhere —
// canvas-scoped listeners froze the drag at the edge (parity gap vs a real browser).
// toPageCoords clamps out-of-bounds positions to the page viewport.
window.addEventListener('mousemove', (e) => {
  if (!dragging && e.target !== canvas) return;
  sendMove(e);
});

window.addEventListener('mouseup', (e) => {
  if (!dragging && e.target !== canvas) return;
  dragging = false;
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

// ----- context menu -----
// Headless Chrome's real context menu is browser chrome — it doesn't exist in the
// screencast — so we render our own, populated from what's under the cursor (the host
// answers 'extension.contextinfo' with selection/link state, then we show the menu).
const ctxMenu = document.createElement('div');
ctxMenu.id = 'ctxmenu';
ctxMenu.hidden = true;
document.body.appendChild(ctxMenu);

stage.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const { x, y } = toPageCoords(e);
  fire('extension.contextinfo', { x, y, clientX: e.clientX, clientY: e.clientY });
});

function hideMenu(): void {
  ctxMenu.hidden = true;
}
window.addEventListener('mousedown', (e) => {
  if (!ctxMenu.contains(e.target as Node)) hideMenu();
}, true);
window.addEventListener('blur', hideMenu);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideMenu();
}, true);

type MenuEntry = { label: string; action: () => void; enabled?: boolean } | 'sep';

function showMenu(at: { clientX: number; clientY: number }, hasSelection: boolean, link: string | null): void {
  const items: MenuEntry[] = [
    { label: 'Back', action: () => fire('extension.back') },
    { label: 'Forward', action: () => fire('extension.forward') },
    { label: 'Reload', action: () => fire('extension.reload') },
    'sep',
    { label: 'Copy', action: () => fire('extension.copy'), enabled: hasSelection },
    { label: 'Paste', action: () => fire('extension.paste') },
    { label: 'Select All', action: () => fire('extension.selectall') },
  ];
  if (link) {
    items.push(
      'sep',
      { label: 'Open Link in New Tab', action: () => fire('extension.openlink', { url: link }) },
      { label: 'Copy Link Address', action: () => fire('extension.copylink', { url: link }) },
    );
  }
  ctxMenu.textContent = '';
  for (const it of items) {
    if (it === 'sep') {
      const s = document.createElement('div');
      s.className = 'sep';
      ctxMenu.appendChild(s);
      continue;
    }
    const d = document.createElement('div');
    d.className = 'item' + (it.enabled === false ? ' disabled' : '');
    d.textContent = it.label;
    d.addEventListener('click', () => {
      if (it.enabled === false) return;
      hideMenu();
      it.action();
    });
    ctxMenu.appendChild(d);
  }
  ctxMenu.hidden = false;
  // Clamp inside the panel so the menu never renders half off-screen.
  ctxMenu.style.left = Math.max(0, Math.min(at.clientX, window.innerWidth - ctxMenu.offsetWidth - 4)) + 'px';
  ctxMenu.style.top = Math.max(0, Math.min(at.clientY, window.innerHeight - ctxMenu.offsetHeight - 4)) + 'px';
}

stage.addEventListener(
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
stage.addEventListener('keydown', (e) => {
  // ⌘/Ctrl +/-/0 → per-site zoom, don't forward to the page.
  if (e.metaKey || e.ctrlKey) {
    if (e.key === '=' || e.key === '+') { e.preventDefault(); fire('extension.zoom', { dir: 'in' }); return; }
    if (e.key === '-' || e.key === '_') { e.preventDefault(); fire('extension.zoom', { dir: 'out' }); return; }
    if (e.key === '0') { e.preventDefault(); fire('extension.zoom', { dir: 'reset' }); return; }
    // Clipboard/selection parity: the headless browser's clipboard is sandboxed away
    // from the OS, so copy must be routed through the host (paste already is, below).
    if (e.key === 'c') { e.preventDefault(); fire('extension.copy'); return; }
    if (e.key === 'a') { e.preventDefault(); fire('extension.selectall'); return; }
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

stage.addEventListener('keyup', (e) => {
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
  if (!stage.contains(document.activeElement)) return; // let the URL bar paste normally
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

// Re-report when the window lands on a monitor with a different devicePixelRatio:
// the CSS size doesn't change (so the ResizeObserver stays silent) but the backing
// resolution must, or the page keeps rendering at the old monitor's density and
// looks soft. A matchMedia for the CURRENT dpr fires exactly when it stops matching;
// re-arm for the new value each time.
function watchDpr(): void {
  const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  const onChange = (): void => {
    mq.removeEventListener('change', onChange);
    lastVp = ''; // force a fresh viewport push at the new density
    reportViewport();
    watchDpr();
  };
  mq.addEventListener('change', onChange);
}
watchDpr();

// Tell the host we're listening so it (re)starts the screencast now that the message
// handler exists — otherwise the initial frame is lost and a static page stays blank.
fire('extension.ready');
