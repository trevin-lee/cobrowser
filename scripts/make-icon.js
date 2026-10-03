// Draws every cobrowser icon from one mark, so they never drift apart:
//   media/cobrowser-1024.png + media/cobrowser.icns  the macOS app icon (the macOS icon grid)
//   media/store-icon.png                               the Marketplace and Open VSX tile (light)
//   media/icon.png                                     the editor's icon for a browser tab
//   media/trayTemplate.png, @2x                         the menu-bar icon (a template image)
//   media/sidebar.svg                                  the Activity Bar icon
//   {chrome,firefox}-extension/icons/icon-N.png         the bridge extensions' icons
// Run with Electron:  app/node_modules/.bin/electron scripts/make-icon.js
const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const ROOT = path.join(__dirname, '..');
app.dock && app.dock.hide();
app.on('window-all-closed', () => { /* one render after another: closing one must not quit */ });
const done = (code) => { app.exit(code); setTimeout(() => process.exit(code), 500); };
setTimeout(() => { console.error('timed out'); done(1); }, 30000);

/**
 * The mark: two square panes, one over the other's corner; where they meet, the space you share
 * with the agent, in cobalt. Drawn on a 100-unit square: the panes are 52 wide, offset by 24, so
 * the shared square is 28.
 */
const COBALT = '#2b5bff';
const ON_DARK = { a: '#fafafa', c: '#3a3a44', shared: COBALT };
const ON_LIGHT = { a: '#0a0a0c', c: '#c9c9d1', shared: COBALT };
const mark = (x, y, size, k) => {
  const u = size / 100, X = (v) => x + v * u, Y = (v) => y + v * u, L = (v) => v * u;
  return `<rect x="${X(12)}" y="${Y(12)}" width="${L(52)}" height="${L(52)}" fill="${k.a}"/>
    <rect x="${X(36)}" y="${Y(36)}" width="${L(52)}" height="${L(52)}" fill="${k.c}"/>
    <rect x="${X(36)}" y="${Y(36)}" width="${L(28)}" height="${L(28)}" fill="${k.shared}"/>`;
};
const svgOf = (S, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}" shape-rendering="geometricPrecision">${body}</svg>`;

/** The app icon: the mark on a black rounded square, on the macOS icon grid (824 px, 100 px margin). */
function appIcon() {
  const S = 1024, M = 100, B = 824, R = 185;
  return svgOf(S, `<defs>
      <filter id="shadow" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000" flood-opacity="0.35"/></filter>
    </defs>
    <rect x="${M}" y="${M}" width="${B}" height="${B}" rx="${R}" fill="#0c0c0f" filter="url(#shadow)"/>
    ${mark(222, 222, 580, ON_DARK)}
    <rect x="${M + 1}" y="${M + 1}" width="${B - 2}" height="${B - 2}" rx="${R - 1}" fill="none" stroke="#ffffff" stroke-opacity="0.09" stroke-width="2"/>`);
}

/** The stores' icon: the mark on a light tile that fills the square (their pages are white). */
function storeIcon() {
  const S = 256, R = 56;
  return svgOf(S, `<rect x="1" y="1" width="${S - 2}" height="${S - 2}" rx="${R}" fill="#fafafa" stroke="#0a0a0c" stroke-opacity="0.1" stroke-width="2"/>
    ${mark(38, 38, 180, ON_LIGHT)}`);
}

/**
 * A small icon: the mark on a black tile, legible in light and dark editor themes alike. Up to
 * 48 px it is drawn on a 16-unit grid of whole pixels (panes of 8, offset by 4), so 16, 32 and
 * 48 px stay crisp; larger ones use the mark's own proportions.
 */
function tileIcon(S) {
  const R = S * 0.22;
  const tile = `<rect x="0" y="0" width="${S}" height="${S}" rx="${R}" fill="#0a0a0c"/>`;
  if (S > 48) return svgOf(S, tile + mark(S * 0.06, S * 0.06, S * 0.88, ON_DARK));
  const p = (v) => v * (S / 16);
  return svgOf(S, `${tile}<rect x="${p(2)}" y="${p(2)}" width="${p(8)}" height="${p(8)}" fill="${ON_DARK.a}"/>
    <rect x="${p(6)}" y="${p(6)}" width="${p(8)}" height="${p(8)}" fill="${ON_DARK.c}"/>
    <rect x="${p(6)}" y="${p(6)}" width="${p(4)}" height="${p(4)}" fill="${ON_DARK.shared}"/>`);
}

/**
 * The menu-bar icon, a template image: macOS draws it in the menu bar's own colour, from its
 * alpha. Drawn on whole pixels of an 18 px canvas (36 at @2x), so its edges are crisp: the front
 * pane solid, the one behind it at half strength.
 */
function trayIcon(scale) {
  const S = 18 * scale, p = (v) => v * scale;
  return svgOf(S, `<rect x="${p(2)}" y="${p(2)}" width="${p(10)}" height="${p(10)}" fill="#000"/>
    <rect x="${p(6)}" y="${p(12)}" width="${p(10)}" height="${p(4)}" fill="#000" fill-opacity="0.5"/>
    <rect x="${p(12)}" y="${p(6)}" width="${p(4)}" height="${p(6)}" fill="#000" fill-opacity="0.5"/>`);
}

/** The Activity Bar icon: one colour (VS Code tints it), the pane behind at half strength. */
const SIDEBAR = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
  <rect x="3" y="3" width="12" height="12"/>
  <path d="M15 9h6v12H9v-6h6z" fill-opacity="0.5"/>
</svg>
`;

async function render(markup, size) {
  const win = new BrowserWindow({ show: false, width: size, height: size, transparent: true, frame: false, backgroundColor: '#00000000', webPreferences: { offscreen: true } });
  win.webContents.setZoomFactor(1);
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<html><body style="margin:0;background:transparent">${markup}</body></html>`));
  await new Promise((r) => setTimeout(r, 300));
  const png = (await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })).resize({ width: size, height: size, quality: 'best' }).toPNG();
  win.destroy();
  return png;
}

app.whenReady().then(async () => {
  const media = path.join(ROOT, 'media');
  const out = path.join(media, 'cobrowser-1024.png');
  fs.writeFileSync(out, await render(appIcon(), 1024));
  const set = fs.mkdtempSync(path.join(os.tmpdir(), 'cobrowser-icon-')) + '/cobrowser.iconset';
  fs.mkdirSync(set);
  for (const [name, size] of [['16x16', 16], ['16x16@2x', 32], ['32x32', 32], ['32x32@2x', 64], ['128x128', 128], ['128x128@2x', 256], ['256x256', 256], ['256x256@2x', 512], ['512x512', 512], ['512x512@2x', 1024]]) {
    execFileSync('sips', ['-z', String(size), String(size), out, '--out', `${set}/icon_${name}.png`], { stdio: 'ignore' });
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(media, 'cobrowser.icns')]);
  fs.writeFileSync(path.join(media, 'store-icon.png'), await render(storeIcon(), 256));
  fs.writeFileSync(path.join(media, 'icon.png'), await render(tileIcon(128), 128));
  fs.writeFileSync(path.join(media, 'trayTemplate.png'), await render(trayIcon(1), 18));
  fs.writeFileSync(path.join(media, 'trayTemplate@2x.png'), await render(trayIcon(2), 36));
  fs.writeFileSync(path.join(media, 'sidebar.svg'), SIDEBAR);
  for (const ext of ['chrome-extension', 'firefox-extension']) {
    const dir = path.join(ROOT, ext, 'icons');
    fs.mkdirSync(dir, { recursive: true });
    for (const size of [16, 32, 48, 128]) fs.writeFileSync(path.join(dir, `icon-${size}.png`), await render(tileIcon(size), size));
  }
  console.log('wrote the app, store, editor, menu-bar, sidebar and bridge icons');
  done(0);
});
