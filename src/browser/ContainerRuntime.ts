import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

const exec = promisify(execFile);
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const CONTAINER_IMAGE = 'ghcr.io/trevin-lee/cobrowser:latest';

type Log = (m: string) => void;

/**
 * Runs the browser inside a container instead of as a local child process.
 *
 * The reason is measured, not architectural taste: Chromium's own frame capture
 * (Page.startScreencast AND Page.captureScreenshot — identical ceilings) delivers ~45fps
 * at 3.1Mpx while the page underneath renders at 80. Capturing the X11 framebuffer inside
 * the container sidesteps that path and yields ~248fps of changed frames.
 *
 * Automation is unchanged: the container publishes Chromium's DevTools port and the
 * session simply connects to it, so every existing CDP tool keeps working.
 */
export class ContainerRuntime {
  private id: string | undefined;

  constructor(
    private readonly name: string,
    private readonly profileDir: string,
    private readonly log: Log,
  ) {}

  /** CDP endpoint. Chromium binds DevTools to loopback INSIDE the container (it ignores
   *  --remote-debugging-address), so an in-container proxy republishes it on 0.0.0.0 and
   *  fixes up Host headers and advertised URLs. That is what makes this reachable. */
  cdpUrl(port: number): string {
    return `http://127.0.0.1:${port}`;
  }

  frameUrl(port: number, format: 'png' | 'h264', fps: number): string {
    return `ws://127.0.0.1:${port}/frames?format=${format}&fps=${fps}`;
  }

  static async dockerAvailable(): Promise<boolean> {
    try {
      await exec('docker', ['info'], { timeout: 8000 });
      return true;
    } catch {
      return false;
    }
  }

  private async imagePresent(): Promise<boolean> {
    try {
      const { stdout } = await exec('docker', ['images', '-q', CONTAINER_IMAGE]);
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /** Pull on first use behind a progress notification — the same contract as the
   *  Chrome-for-Testing download, so the VSIX itself stays small. */
  async ensureImage(): Promise<void> {
    if (await this.imagePresent()) return;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Cobrowser: downloading browser container (${CONTAINER_IMAGE})`,
        cancellable: false,
      },
      async () => {
        this.log(`Pulling ${CONTAINER_IMAGE}...`);
        await exec('docker', ['pull', CONTAINER_IMAGE], { timeout: 20 * 60 * 1000 });
      },
    );
  }

  /** Is a container with our name already up AND serving CDP? */
  private async healthy(cdpPort: number): Promise<boolean> {
    try {
      const { stdout } = await exec('docker', [
        'ps', '-q', '--filter', `name=^${this.name}$`, '--filter', 'status=running',
      ]);
      if (!stdout.trim()) return false;
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Start the container, or adopt one that is already running and healthy.
   *
   * Serialized through `starting` and keyed by a fixed container NAME so that concurrent
   * callers (a tool call and a panel opening at the same moment, or a reload racing the
   * previous host's teardown) can never bring up two browsers for one workspace — which
   * would fight over the published ports and silently strand one of them.
   */
  private starting: Promise<void> | undefined;

  async start(opts: {
    cdpPort: number;
    framePort: number;
    width: number;
    height: number;
    startUrl?: string;
  }): Promise<void> {
    this.starting ??= this.doStart(opts).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async doStart(opts: {
    cdpPort: number;
    framePort: number;
    width: number;
    height: number;
    startUrl?: string;
  }): Promise<void> {
    if (await this.healthy(opts.cdpPort)) {
      this.log('Reusing the running cobrowser container.');
      return;
    }
    await this.stop(); // a dead/mismatched one would still hold the ports
    await this.ensureImage();
    const args = [
      'run', '-d', '--rm',
      '--name', this.name,
      '--shm-size=2g',
      // Ports may be remapped freely: the in-container CDP proxy rewrites the Host
      // header inbound and the advertised host:port in /json/* outbound.
      '-p', `127.0.0.1:${opts.cdpPort}:9221`,
      '-p', `127.0.0.1:${opts.framePort}:9223`,
      '-e', `COBROWSER_WIDTH=${opts.width}`,
      '-e', `COBROWSER_HEIGHT=${opts.height}`,
      '-e', `COBROWSER_START_URL=${opts.startUrl ?? 'about:blank'}`,
      // Logins must survive restarts — same intent as the local profile dir.
      '-v', `${this.profileDir}:/profile`,
      CONTAINER_IMAGE,
    ];
    const { stdout } = await exec('docker', args, { timeout: 60_000 });
    this.id = stdout.trim();
    this.log(`Container started (${this.id.slice(0, 12)}) ${opts.width}x${opts.height}`);
    await this.waitForCdp(opts.cdpPort);
  }

  private async waitForCdp(port: number): Promise<void> {
    for (let i = 0; i < 120; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(1500),
        });
        if (res.ok) {
          this.log('Container CDP is up.');
          return;
        }
      } catch {
        /* not ready */
      }
      await delay(500);
    }
    throw new Error('container CDP never became reachable');
  }

  /** The browser-level DevTools WebSocket, for BrowserSession.connect(). */
  async wsEndpoint(port: number): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(5000),
    });
    const info = (await res.json()) as { webSocketDebuggerUrl: string };
    return info.webSocketDebuggerUrl;
  }

  async stop(): Promise<void> {
    try {
      await exec('docker', ['rm', '-f', this.name], { timeout: 30_000 });
    } catch {
      /* not running */
    }
    this.id = undefined;
  }
}
