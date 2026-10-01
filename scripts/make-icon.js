// Renders cobrowser's macOS app icon (media/cobrowser.icns) from the mark in media/icon.png:
// redraws its two circles as vector art at 1024 px on the
// macOS icon grid (824 px rounded square, 100 px margin), and builds the .icns with
// sips + iconutil. Also renders the stores' icon (media/store-icon.png, 256 px): the same mark
// on a light tile, since the Marketplace and Open VSX pages are white and the dark tile read as
// a black square there. Run with Electron:  app/node_modules/.bin/electron scripts/make-icon.js
const { app, BrowserWindow, nativeImage } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const ROOT = path.join(__dirname, '..');
app.dock && app.dock.hide();
app.on('window-all-closed', () => { /* two renders, one after the other: closing the first must not quit */ });
const done = (code) => { app.exit(code); setTimeout(() => process.exit(code), 500); };
setTimeout(() => { console.error('timed out'); done(1); }, 20000);

/**
 * The mark, as drawn in media/icon.png (128 px): two equal circles on the vertical centre,
 * blue on the left, green on the right, teal where they overlap — cobrowser's palette, the
 * same colours as the Logins window. Read off the 128 px original: the left circle spans
 * x 2–91 and the right 36–125 on the centre row.
 */
function measure() {
  const W = 128;
  return {
    W,
    colors: { bg: '#16181d', blue: '#388bfd', green: '#29a891', teal: '#2fbdb9' },
    left: { cx: 47 / W, cy: 64 / W, r: 45 / W },
    right: { cx: 81 / W, cy: 64 / W, r: 45 / W },
  };
}

function svg(m) {
  const S = 1024, M = 100, B = 824, R = 185; // macOS icon grid
  // The mark sits inside the rounded square with room around it, as macOS icons do.
  const INNER = B * 0.8;
  const X = (f) => M + (B - INNER) / 2 + f * INNER;
  const L = { cx: X(m.left.cx), cy: X(m.left.cy), r: m.left.r * INNER };
  const Rt = { cx: X(m.right.cx), cy: X(m.right.cy), r: m.right.r * INNER };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <defs>
    <linearGradient id="body" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#23262e"/><stop offset="1" stop-color="${m.colors.bg}"/></linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000" flood-opacity="0.35"/></filter>
    <clipPath id="body-clip"><rect x="${M}" y="${M}" width="${B}" height="${B}" rx="${R}"/></clipPath>
    <clipPath id="left-clip"><circle cx="${L.cx}" cy="${L.cy}" r="${L.r}"/></clipPath>
  </defs>
  <rect x="${M}" y="${M}" width="${B}" height="${B}" rx="${R}" fill="url(#body)" filter="url(#shadow)"/>
  <g clip-path="url(#body-clip)">
    <circle cx="${L.cx}" cy="${L.cy}" r="${L.r}" fill="${m.colors.blue}"/>
    <circle cx="${Rt.cx}" cy="${Rt.cy}" r="${Rt.r}" fill="${m.colors.green}"/>
    <circle cx="${Rt.cx}" cy="${Rt.cy}" r="${Rt.r}" fill="${m.colors.teal}" clip-path="url(#left-clip)"/>
  </g>
  <rect x="${M + 1}" y="${M + 1}" width="${B - 2}" height="${B - 2}" rx="${R - 1}" fill="none" stroke="#ffffff" stroke-opacity="0.08" stroke-width="2"/>
</svg>`;
}

/** The stores' icon: the mark on a light rounded tile that fills the square, as listing icons do. */
function storeSvg(m) {
  const S = 256, R = 56, INNER = S * 0.74;
  const X = (f) => (S - INNER) / 2 + f * INNER;
  const L = { cx: X(m.left.cx), cy: X(m.left.cy), r: m.left.r * INNER };
  const Rt = { cx: X(m.right.cx), cy: X(m.right.cy), r: m.right.r * INNER };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#eef1f5"/></linearGradient>
    <clipPath id="left-clip"><circle cx="${L.cx}" cy="${L.cy}" r="${L.r}"/></clipPath>
  </defs>
  <rect x="1" y="1" width="${S - 2}" height="${S - 2}" rx="${R}" fill="url(#tile)" stroke="#1f2937" stroke-opacity="0.12" stroke-width="2"/>
  <circle cx="${L.cx}" cy="${L.cy}" r="${L.r}" fill="${m.colors.blue}"/>
  <circle cx="${Rt.cx}" cy="${Rt.cy}" r="${Rt.r}" fill="${m.colors.green}"/>
  <circle cx="${Rt.cx}" cy="${Rt.cy}" r="${Rt.r}" fill="${m.colors.teal}" clip-path="url(#left-clip)"/>
</svg>`;
}

async function render(markup, size) {
  const win = new BrowserWindow({ show: false, width: size, height: size, transparent: true, frame: false, backgroundColor: '#00000000', webPreferences: { offscreen: true } });
  win.webContents.setZoomFactor(1);
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<html><body style="margin:0;background:transparent">${markup}</body></html>`));
  await new Promise((r) => setTimeout(r, 400));
  const png = (await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })).resize({ width: size, height: size, quality: 'best' }).toPNG();
  win.destroy();
  return png;
}

app.whenReady().then(async () => {
  const m = measure();
  console.log('measured', JSON.stringify(m));
  const png = await render(svg(m), 1024);
  const out = path.join(ROOT, 'media', 'cobrowser-1024.png');
  fs.writeFileSync(out, png);
  const set = fs.mkdtempSync(path.join(os.tmpdir(), 'cobrowser-icon-')) + '/cobrowser.iconset';
  fs.mkdirSync(set);
  for (const [name, size] of [['16x16', 16], ['16x16@2x', 32], ['32x32', 32], ['32x32@2x', 64], ['128x128', 128], ['128x128@2x', 256], ['256x256', 256], ['256x256@2x', 512], ['512x512', 512], ['512x512@2x', 1024]]) {
    execFileSync('sips', ['-z', String(size), String(size), out, '--out', `${set}/icon_${name}.png`], { stdio: 'ignore' });
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(ROOT, 'media', 'cobrowser.icns')]);
  fs.writeFileSync(path.join(ROOT, 'media', 'store-icon.png'), await render(storeSvg(m), 256));
  console.log('wrote media/cobrowser-1024.png, media/cobrowser.icns and media/store-icon.png');
  done(0);
});
