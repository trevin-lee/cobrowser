/* A Bitwarden server in memory, for the e2e suites: a made-up account whose keys and items are
 * sealed here with Node's own crypto (PBKDF2, HKDF, AES-256-CBC with HMAC-SHA256), so the app's
 * WebAssembly core is checked against an independent implementation. It answers the requests
 * Bitwarden's and Vaultwarden's API answer: prelogin, token (password and refresh), sync, and
 * making and replacing an item. Every value in it is made up. */
import * as crypto from 'node:crypto';
import * as http from 'node:http';

const b64 = (b: Buffer) => b.toString('base64');

/** HKDF's expand step, one 32-byte block: how Bitwarden stretches the master key. */
const expand = (prk: Buffer, info: string) => crypto.createHmac('sha256', prk).update(Buffer.concat([Buffer.from(info), Buffer.from([1])])).digest();

export function seal(key: Buffer, plain: string | Buffer): string {
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv('aes-256-cbc', key.subarray(0, 32), iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  const mac = crypto.createHmac('sha256', key.subarray(32)).update(Buffer.concat([iv, ct])).digest();
  return `2.${b64(iv)}|${b64(ct)}|${b64(mac)}`;
}

export function unseal(key: Buffer, s: string): string {
  const [iv, ct, mac] = s.slice(2).split('|').map((p) => Buffer.from(p, 'base64'));
  const want = crypto.createHmac('sha256', key.subarray(32)).update(Buffer.concat([iv, ct])).digest();
  if (!crypto.timingSafeEqual(want, mac)) throw new Error('does not authenticate');
  const d = crypto.createDecipheriv('aes-256-cbc', key.subarray(0, 32), iv);
  return Buffer.concat([d.update(ct), d.final()]).toString();
}

/** The current RFC 6238 code for a base32 key, and the one before (a check can straddle 30 s). */
export function totp(secret: string, at = Date.now()): string[] {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  return [0, -1].map((step) => {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000) + step));
    const h = crypto.createHmac('sha1', key).update(counter).digest();
    const o = h[h.length - 1] & 15;
    return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');
  });
}

export interface FakeLogin { id: string; name: string; uri: string; username: string; password: string; totp?: string; notes?: string; shareNotes?: boolean }

export async function fakeBitwarden(opts: { email: string; password: string; logins: FakeLogin[] }) {
  const iterations = 5000;
  const master = crypto.pbkdf2Sync(opts.password, opts.email, iterations, 32, 'sha256');
  const hash = b64(crypto.pbkdf2Sync(master, opts.password, 1, 32, 'sha256'));
  const stretched = Buffer.concat([expand(master, 'enc'), expand(master, 'mac')]);
  const userKey = crypto.randomBytes(64);
  const sealedUser = seal(stretched, userKey);
  const field = (name: string, value: string, type: number) => ({ name: seal(userKey, name), value: seal(userKey, value), type });
  const ciphers: Record<string, unknown>[] = opts.logins.map((l) => ({
    id: l.id, type: 1, organizationId: null, folderId: null, deletedDate: null, revisionDate: new Date().toISOString(), edit: true,
    name: seal(userKey, l.name), notes: l.notes ? seal(userKey, l.notes) : null,
    fields: l.shareNotes ? [field('Share notes with agents', 'true', 2)] : [],
    login: { username: seal(userKey, l.username), password: seal(userKey, l.password), totp: l.totp ? seal(userKey, l.totp) : null, uris: [{ uri: seal(userKey, l.uri), match: null }] },
  }));
  const requests: { method: string; path: string; body: string }[] = [];
  let up = true;
  let issued = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const path = (req.url || '').split('?')[0];
      requests.push({ method: req.method || 'GET', path, body });
      const send = (status: number, json: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
      if (!up) { req.socket.destroy(); return; }
      if (path === '/identity/accounts/prelogin') return send(200, { kdf: 0, kdfIterations: iterations, kdfMemory: null, kdfParallelism: null });
      if (path === '/identity/connect/token') {
        const f = new URLSearchParams(body);
        if (f.get('grant_type') === 'refresh_token') return f.get('refresh_token') === 'refresh-1' ? send(200, { access_token: `access-${++issued}`, expires_in: 3600, token_type: 'Bearer' }) : send(400, { error: 'invalid_grant' });
        if (f.get('username') !== opts.email || f.get('password') !== hash) return send(400, { error: 'invalid_grant', error_description: 'invalid_username_or_password', ErrorModel: { Message: 'Username or password is incorrect. Try again' } });
        return send(200, { access_token: `access-${++issued}`, refresh_token: 'refresh-1', expires_in: 3600, token_type: 'Bearer', Key: sealedUser, Kdf: 0, KdfIterations: iterations });
      }
      if (!/^Bearer access-\d+$/.test(String(req.headers.authorization || ''))) return send(401, {});
      if (path === '/api/sync') return send(200, { object: 'sync', profile: { id: 'user-1', email: opts.email, organizations: [], privateKey: null }, folders: [], collections: [], ciphers });
      if (req.method === 'POST' && path === '/api/ciphers') {
        const c = { ...JSON.parse(body), id: `made-${ciphers.length}`, deletedDate: null, revisionDate: new Date().toISOString(), edit: true };
        ciphers.push(c);
        return send(200, c);
      }
      const put = /^\/api\/ciphers\/([^/]+)$/.exec(path);
      if (req.method === 'PUT' && put) {
        const i = ciphers.findIndex((c) => c.id === put[1]);
        if (i < 0) return send(404, {});
        ciphers[i] = { ...JSON.parse(body), id: put[1], deletedDate: null, revisionDate: new Date().toISOString(), edit: true };
        return send(200, ciphers[i]);
      }
      send(404, { message: 'not here' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    ciphers,
    /** What an item the app made holds, opened with the account's key. */
    open: (c: Record<string, unknown>) => { const l = c.login as Record<string, unknown>; return { name: unseal(userKey, String(c.name)), username: l.username ? unseal(userKey, String(l.username)) : '', password: l.password ? unseal(userKey, String(l.password)) : '', uris: ((l.uris as { uri: string }[]) || []).map((u) => unseal(userKey, u.uri)) }; },
    setUp: (v: boolean) => { up = v; },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
