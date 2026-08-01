#!/bin/bash
# Bring up the virtual display, Chromium, and the frame server.
set -euo pipefail

# The screen is a fixed, generous framebuffer; the actual capture size is the panel's
# device-pixel size. The extension sizes the browser WINDOW to that (over CDP: explicit
# bounds at 0,0 then fullscreen, which is chrome-less), and the frame server captures that
# top-left rect — so the page renders 1:1 with no upscaling, no letterbox, and input maps
# directly. MAXW x MAXH only has to exceed the largest real panel.
MAXW="${COBROWSER_MAXW:-5120}"
MAXH="${COBROWSER_MAXH:-2880}"
WIDTH="${COBROWSER_WIDTH:-1600}"
HEIGHT="${COBROWSER_HEIGHT:-1000}"
DISPLAY_NUM="${COBROWSER_DISPLAY:-99}"
export DISPLAY=":${DISPLAY_NUM}"

Xvfb "$DISPLAY" -screen 0 "${MAXW}x${MAXH}x24" -nolisten tcp &
XVFB_PID=$!

# Wait for the display rather than sleeping a guessed interval.
for _ in $(seq 1 100); do
  xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break
  sleep 0.1
done

# --disable-frame-rate-limit / --disable-gpu-vsync are the difference between 60 and 120
# unique captured fps (measured). Chromium self-limits to the capture rate in practice
# because nothing consumes frames faster. --kiosk gives a chrome-less initial window; the
# extension then drives per-panel size via CDP window bounds + fullscreen.
chromium \
  --no-sandbox \
  --disable-dev-shm-usage \
  --no-first-run --no-default-browser-check \
  --disable-gpu \
  --disable-frame-rate-limit --disable-gpu-vsync \
  --disable-features=CalculateNativeWinOcclusion \
  --user-data-dir=/profile \
  --remote-debugging-port="${COBROWSER_CDP_INTERNAL:-9222}" \
  --window-position=0,0 \
  --window-size="${WIDTH},${HEIGHT}" \
  --kiosk \
  "${COBROWSER_START_URL:-about:blank}" &
CHROME_PID=$!

cleanup() { kill "$CHROME_PID" "$XVFB_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

exec node /app/frameserver.mjs
