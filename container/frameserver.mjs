// Frame server: X11 capture -> encoder -> WebSocket, one ffmpeg per client.
//
// This exists because Chromium's own capture path (Page.startScreencast /
// captureScreenshot) caps at ~45fps at 3.1Mpx while the page renders at 80. Grabbing the
// X11 framebuffer sidesteps it: measured 120 unique fps of the same scrolling page.
//
// Wire format (server -> client), one WebSocket binary message per frame:
//     [u32le payloadLength][payload]
// preceded by a single TEXT message of JSON metadata: {format,width,height,fps}.
// Framing is done here so the client never parses a container format:
//   png  - ffmpeg image2pipe emits whole PNGs; split on the IEND terminator.
//   h264 - x264 with aud=1 prefixes every access unit with an AUD NAL; split on those,
//          so each message is exactly one decodable frame for WebCodecs.
//
// No npm dependencies: the WebSocket server surface we need is small (handshake plus
// unmasked server->client binary frames), and keeping the image slim matters when it is
// pulled on first run.
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.COBROWSER_FRAME_PORT || 9223);
const DISPLAY = process.env.DISPLAY || ':99';
const WIDTH = Number(process.env.COBROWSER_WIDTH || 1600);
const HEIGHT = Number(process.env.COBROWSER_HEIGHT || 1000);
const TOKEN = process.env.COBROWSER_TOKEN || '';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const log = (m) => process.stdout.write(`[frameserver] ${m}\n`);

/** Encode one server->client WebSocket frame (never masked). */
function wsFrame(payload, opcode) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function ffmpegArgs(format, fps) {
  const input = [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'x11grab', '-framerate', String(fps),
    '-video_size', `${WIDTH}x${HEIGHT}`,
    '-draw_mouse', '0',
    '-i', DISPLAY,
  ];
  if (format === 'h264') {
    // Fragmented MP4 rather than raw Annex-B: the client feeds the bytes straight to a
    // MediaSource SourceBuffer and gets a real <video> element (composited natively, no
    // per-frame JavaScript). It also means NO manual framing — appending arbitrary byte
    // ranges is exactly what MSE expects, which removed a whole class of parsing bugs.
    return [
      ...input,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
      '-x264-params', 'keyint=120:min-keyint=120:scenecut=0',
      '-pix_fmt', 'yuv420p', '-threads', '0',
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
      '-frag_duration', '16000',
      '-f', 'mp4', 'pipe:1',
    ];
  }
  // PNG: lossless, and on text-heavy pages no larger than JPEG q90 (measured).
  // compression_level 1 keeps DEFLATE cheap enough to sustain a high frame rate.
  //
  // mpdecimate is essential here, not an optimisation: x11grab samples the framebuffer on
  // a timer regardless of whether anything changed, so without it we measured ~490
  // frames/s of which only ~120 were distinct — 250MB/s of mostly duplicate PNGs. Sending
  // only changed frames is the whole point of capturing at a high rate.
  return [
    ...input,
    '-vf', 'mpdecimate=hi=64:lo=32:frac=0.001',
    '-c:v', 'png', '-compression_level', '1', '-threads', '0',
    '-f', 'image2pipe', 'pipe:1',
  ];
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_END = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]); // IEND + CRC

/** Split a byte stream into whole frames and hand each to `onFrame`. */
function makeSplitter(format, onFrame) {
  let buf = Buffer.alloc(0);
  if (format === 'png') {
    return (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        const end = buf.indexOf(PNG_END);
        if (end < 0) break;
        const cut = end + PNG_END.length;
        const frame = buf.subarray(0, cut);
        buf = buf.subarray(cut);
        if (frame.subarray(0, 8).equals(PNG_SIG)) onFrame(frame);
      }
    };
  }
  // h264/fMP4: no framing needed — MediaSource accepts arbitrary byte ranges, so pass
  // chunks straight through as ffmpeg produces them.
  return (chunk) => onFrame(chunk);
}

const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/health')) { res.writeHead(200).end('ok'); return; }
  res.writeHead(404).end();
});

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname !== '/frames' || (TOKEN && url.searchParams.get('token') !== TOKEN)) {
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);

  const format = url.searchParams.get('format') === 'h264' ? 'h264' : 'png';
  const fps = Math.min(240, Math.max(1, Number(url.searchParams.get('fps')) || 120));
  log(`client connected: format=${format} fps=${fps} ${WIDTH}x${HEIGHT}`);
  socket.write(wsFrame(Buffer.from(JSON.stringify({ format, width: WIDTH, height: HEIGHT, fps })), 0x1));

  const ff = spawn('ffmpeg', ffmpegArgs(format, fps), { stdio: ['ignore', 'pipe', 'pipe'] });
  let sent = 0;
  const split = makeSplitter(format, (frame) => {
    // Drop rather than queue if the socket is congested: a stale frame is worthless.
    if (socket.writableLength > 8 * 1024 * 1024) return;
    const header = Buffer.alloc(4);
    header.writeUInt32LE(frame.length, 0);
    socket.write(wsFrame(Buffer.concat([header, frame]), 0x2));
    sent++;
  });
  ff.stdout.on('data', split);
  ff.stderr.on('data', (d) => log(`ffmpeg: ${String(d).trim().slice(0, 200)}`));

  const stats = setInterval(() => { log(`sent ${sent} frames`); sent = 0; }, 5000);
  const shutdown = () => { clearInterval(stats); ff.kill('SIGKILL'); socket.destroy(); };
  socket.on('close', shutdown);
  socket.on('error', shutdown);
  ff.on('exit', (code) => { log(`ffmpeg exited ${code}`); shutdown(); });
});

server.listen(PORT, '0.0.0.0', () => log(`listening on :${PORT} (display ${DISPLAY})`));

// ---------------------------------------------------------------------------
// CDP proxy.
//
// Chromium IGNORES --remote-debugging-address and always binds its DevTools port to
// 127.0.0.1 (verified: /proc/net/tcp shows 0100007F). Docker publishes ports to the
// container's eth0, which can never reach a loopback-only listener — so CDP worked
// inside the container and was unreachable from the host. This proxy bridges the two.
//
// It also rewrites the Host header on the way in, and the advertised host:port in
// /json/* responses on the way out. That solves the OTHER Chromium quirk — it validates
// Host on the DevTools endpoint and resets requests whose port does not match the one it
// bound — and means the published port no longer has to equal the internal one.
// ---------------------------------------------------------------------------
const CDP_INTERNAL = Number(process.env.COBROWSER_CDP_INTERNAL || 9222);
const CDP_PROXY_PORT = Number(process.env.COBROWSER_CDP_PORT || 9221);
const INTERNAL_HOST = `127.0.0.1:${CDP_INTERNAL}`;

const cdpProxy = http.createServer((req, res) => {
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: CDP_INTERNAL,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: INTERNAL_HOST },
    },
    (up) => {
      const isJson = (up.headers['content-type'] ?? '').includes('json');
      if (!isJson) {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
        return;
      }
      // Rewrite webSocketDebuggerUrl etc. so the client dials US, not the internal port.
      let body = '';
      up.on('data', (c) => (body += c));
      up.on('end', () => {
        const clientHost = req.headers.host ?? `127.0.0.1:${CDP_PROXY_PORT}`;
        body = body.split(INTERNAL_HOST).join(clientHost).split(`localhost:${CDP_INTERNAL}`).join(clientHost);
        const headers = { ...up.headers };
        delete headers['content-length'];
        res.writeHead(up.statusCode ?? 200, headers);
        res.end(body);
      });
    },
  );
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(upstream);
});

cdpProxy.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(CDP_INTERNAL, '127.0.0.1', () => {
    const lines = [`GET ${req.url} HTTP/1.1`, `Host: ${INTERNAL_HOST}`];
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.toLowerCase() === 'host') continue;
      lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const bail = () => { upstream.destroy(); socket.destroy(); };
  upstream.on('error', bail);
  socket.on('error', bail);
});

cdpProxy.listen(CDP_PROXY_PORT, '0.0.0.0', () =>
  log(`CDP proxy on :${CDP_PROXY_PORT} -> ${INTERNAL_HOST}`),
);
