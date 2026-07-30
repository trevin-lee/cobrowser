# cobrowser browser runtime.
#
# Why a container at all: Chromium's own frame-capture path (Page.startScreencast /
# Page.captureScreenshot) tops out around 45fps at 3.1Mpx — measured, and identical for
# push and pull, while the page itself renders at 80fps. Capturing the X11 framebuffer
# instead bypasses that path entirely and yields 120 unique fps of the same content.
#
# Published as ghcr.io/trevin-lee/cobrowser:<version> and pulled on first use (the VSIX
# stays small — same pattern as the existing Chrome-for-Testing download).
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      xvfb x11-utils xdotool \
      ffmpeg \
      nodejs \
      ca-certificates fonts-liberation fonts-noto-color-emoji \
      procps tini \
    && rm -rf /var/lib/apt/lists/*

# Persisted profile lives here; the host bind-mounts it so logins survive container
# restarts (the shared-session model is the point of cobrowser).
RUN mkdir -p /profile
VOLUME ["/profile"]

WORKDIR /app
COPY frameserver.mjs /app/frameserver.mjs
COPY entrypoint.sh   /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Chromium validates the Host header on its DevTools endpoint, so the CDP port must be
# IDENTICAL inside and outside the container — publish as -p <PORT>:<PORT>, never
# remapped, or Chrome resets every request.
# 9222 = Chromium DevTools (automation, unchanged from today's CDP usage)
# 9223 = frame stream (X11 capture -> encoder -> WebSocket)
EXPOSE 9222 9223

ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
