#!/bin/bash
# Bring up the virtual display, Chromium, and the frame server.
set -euo pipefail

WIDTH="${COBROWSER_WIDTH:-1600}"
HEIGHT="${COBROWSER_HEIGHT:-1000}"
DISPLAY_NUM="${COBROWSER_DISPLAY:-99}"
export DISPLAY=":${DISPLAY_NUM}"

Xvfb "$DISPLAY" -screen 0 "${WIDTH}x${HEIGHT}x24" -nolisten tcp &
XVFB_PID=$!

# Wait for the display rather than sleeping a guessed interval.
for _ in $(seq 1 100); do
  xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break
  sleep 0.1
done

# --disable-frame-rate-limit / --disable-gpu-vsync are the difference between 60 and 120
# unique captured fps (measured). Chromium self-limits to the capture rate in practice
# because nothing consumes frames faster.
chromium \
  --no-sandbox \
  --disable-dev-shm-usage \
  --no-first-run --no-default-browser-check \
  --disable-gpu \
  --disable-frame-rate-limit --disable-gpu-vsync \
  --disable-features=CalculateNativeWinOcclusion \
  --user-data-dir=/profile \
  --remote-debugging-address=0.0.0.0 \
  --remote-debugging-port="${COBROWSER_CDP_PORT:-9222}" \
  --window-position=0,0 \
  --window-size="${WIDTH},${HEIGHT}" \
  --kiosk \
  "${COBROWSER_START_URL:-about:blank}" &
CHROME_PID=$!

cleanup() { kill "$CHROME_PID" "$XVFB_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

exec node /app/frameserver.mjs
