/**
 * Cobrowser Bridge — Chrome (Manifest V3) service worker.
 *
 * Dials OUT to one or more Cobrowser endpoints, one per editor workspace, exactly like the
 * Firefox add-on and over the same wire protocol — the editor side cannot tell them apart.
 *
 * What differs is what Chrome has to offer for scoping. Firefox has containers; Chrome has
 * tab GROUPS, so a workspace is bound either to one named tab group or to the whole
 * profile ("profile"). Every tab this bridge exposes or touches is checked against that
 * scope first, here and only here.
 *
 * MV3 service workers are killed after ~30s idle, which would drop the sockets. Chrome
 * 116+ keeps a worker alive while a WebSocket exchanges messages, so each socket pings every
 * 20s, and an alarm re-runs reconcile() so a worker that was torn down anyway reconnects.
 */

const api = chrome;
const BROWSER = 'chrome';

// ---------------------------------------------------------------- pacing and guards

/**
 * Pace repeated work at something a hand could produce.
 *
 * Bulk reads are the point of this bridge — one order history is fifty detail pages — but
 * fifty requests in two seconds from a logged-in session is what gets an account flagged,
 * and it is the user's real account. Every page-touching call passes through here.
 */
const THROTTLE_MIN_MS = 1000;
const THROTTLE_MAX_MS = 3000;
/** Per-session ceiling, so a runaway loop cannot quietly make a thousand requests. */
const SESSION_REQUEST_CAP = 100;
/** How long to wait out a server that has started pushing back. */
const BACKOFF_ON_REFUSAL_MS = 60000;

let requestCount = 0;
let lastRequestAt = 0;
let backoffUntil = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Called before anything that reaches a site. Throws rather than silently proceeding. */
async function pace() {
  if (requestCount >= SESSION_REQUEST_CAP) {
    throw new Error(
      `request cap reached (${SESSION_REQUEST_CAP} this session). This is a safety stop, not a site error — ` +
        'tell the human what you have collected so far and ask before continuing.',
    );
  }
  const now = Date.now();
  if (now < backoffUntil) {
    throw new Error(
      `backing off for ${Math.ceil((backoffUntil - now) / 1000)}s: the site returned a refusal or a challenge. ` +
        'Do not retry in a loop — report this to the human.',
    );
  }
  const jitter = THROTTLE_MIN_MS + Math.random() * (THROTTLE_MAX_MS - THROTTLE_MIN_MS);
  const since = now - lastRequestAt;
  if (since < jitter) await sleep(jitter - since);
  lastRequestAt = Date.now();
  requestCount += 1;
}

/** A refusal or challenge means stop, not retry harder. */
function noteRefusal(status, bodyText) {
  const challenged =
    status === 429 ||
    status === 403 ||
    /captcha|are you a robot|unusual traffic|access denied/i.test(String(bodyText || '').slice(0, 2000));
  if (challenged) backoffUntil = Date.now() + BACKOFF_ON_REFUSAL_MS;
  return challenged;
}

/**
 * Controls whose activation is the user's to make, not the agent's.
 *
 * This is not hypothetical: a broad selector signed the user out of their bank mid-session.
 * Matching is on the accessible label, because that is what the agent selects by.
 */
const DESTRUCTIVE = /\b(sign\s?out|log\s?out|logout|delete\s+account|close\s+account|cancel\s+(account|subscription|membership)|deactivate|remove\s+account)\b/i;
/** Fields the agent must never populate, even when asked. */
const CREDENTIAL = /\b(password|passcode|pin|otp|one[-\s]?time|2fa|mfa|security\s+code|verification\s+code|cvv|cvc|card\s+number|ssn|social\s+security)\b/i;
/** Buttons that move money or place an order. */
const COMMITTING = /\b(pay\s+now|confirm\s+(payment|order|purchase)|place\s+order|submit\s+payment|send\s+money|transfer\s+now|buy\s+now)\b/i;

/** How long an activity marker stays visible after an agent action. */
const ACTIVITY_MS = 2500;
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
const CALL_TIMEOUT_MS = 30000;
const MAX_TEXT = 20000;


/** endpoint url -> connection state */
const conns = new Map();
/** Keeps the service worker alive while connected (Chrome 116+ resets the idle timer on
 *  WebSocket traffic). */
const KEEPALIVE_MS = 20000;

// ---------------------------------------------------------------- endpoints

const clean = (list) =>
  (Array.isArray(list) ? list : [])
    .map((e) => (typeof e === 'string' ? e.trim() : ''))
    .filter((e) => e.startsWith('ws://') || e.startsWith('wss://'));

/** Chrome has no writable managed-storage manifest outside enterprise policy, so endpoints
 *  come from the options page. The managed area is still read in case one is provisioned. */
async function loadEndpoints() {
  let managed = [];
  try {
    const m = await api.storage.managed.get('endpoints');
    managed = clean(m && m.endpoints);
  } catch {
    /* none */
  }
  const { endpoints } = await api.storage.local.get('endpoints');
  return [...new Set([...managed, ...clean(endpoints)])];
}

/** Tell the daemon which browser this is: it keys sockets by (workspace, browser). */
function withBrowser(url) {
  try {
    const u = new URL(url);
    u.searchParams.set('browser', BROWSER);
    return u.toString();
  } catch {
    return url;
  }
}

async function reconcile() {
  const wanted = new Set(await loadEndpoints());
  for (const [url, conn] of conns) {
    if (!wanted.has(url)) {
      conn.disposed = true;
      clearTimeout(conn.timer);
      clearInterval(conn.keepalive);
      try { conn.ws?.close(); } catch {}
      conns.delete(url);
    }
  }
  for (const url of wanted) if (!conns.has(url) || !conns.get(url).ws) connect(url);
  updateBadge();
}

// -------------------------------------------------------------- connections

function connect(url) {
  let conn = conns.get(url);
  if (!conn) {
    conn = { url, ws: null, scope: null, attempt: 0, timer: null, keepalive: null, disposed: false, error: null };
    conns.set(url, conn);
  }
  if (conn.disposed || (conn.ws && conn.ws.readyState <= WebSocket.OPEN)) return;

  let ws;
  try {
    ws = new WebSocket(withBrowser(url));
  } catch (err) {
    conn.error = String(err);
    return scheduleRetry(conn);
  }
  conn.ws = ws;

  ws.onopen = () => {
    conn.attempt = 0;
    conn.error = null;
    clearInterval(conn.keepalive);
    conn.keepalive = setInterval(() => send(conn, { type: 'ping' }), KEEPALIVE_MS);
    updateBadge();
  };
  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    void handleMessage(conn, msg);
  };
  ws.onclose = () => {
    conn.ws = null;
    conn.scope = null;
    clearInterval(conn.keepalive);
    updateBadge();
    scheduleRetry(conn);
  };
  ws.onerror = () => { conn.error = 'connection failed'; };
}

function scheduleRetry(conn) {
  if (conn.disposed) return;
  const delay = BACKOFF_MS[Math.min(conn.attempt, BACKOFF_MS.length - 1)];
  conn.attempt += 1;
  clearTimeout(conn.timer);
  conn.timer = setTimeout(() => connect(conn.url), delay);
}

function send(conn, payload) {
  if (conn.ws && conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(payload));
}

async function handleMessage(conn, msg) {
  if (msg.type === 'hello') {
    try {
      conn.scope = await resolveScope(msg.container);
      conn.workspace = msg.workspace ?? null;
      send(conn, { type: 'ready', container: conn.scope, browser: BROWSER });
    } catch (err) {
      conn.scope = null;
      conn.error = String(err && err.message ? err.message : err);
      send(conn, { type: 'error', message: conn.error });
    }
    updateBadge();
    return;
  }
  if (msg.type === 'req') {
    try {
      const result = await withTimeout(dispatch(conn, msg.method, msg.params ?? {}), CALL_TIMEOUT_MS);
      send(conn, { type: 'res', id: msg.id, ok: true, result });
    } catch (err) {
      send(conn, { type: 'res', id: msg.id, ok: false, error: String(err && err.message ? err.message : err) });
    }
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}

// ------------------------------------------------------------------ scoping

/** The whole profile, or one tab group by title. Chrome's answer to a Firefox container. */
const PROFILE = { name: 'This Chrome profile', groupId: null, cookieStoreId: 'chrome-profile', color: null };

async function listScopes() {
  const groups = await api.tabGroups.query({});
  return [PROFILE, ...groups.map((g) => ({ name: g.title || `(untitled ${g.color} group)`, groupId: g.id, cookieStoreId: `chrome-group-${g.id}`, color: g.color }))];
}

async function resolveScope(name) {
  const wanted = String(name ?? '').trim();
  if (!wanted) throw new Error('no tab group configured for this workspace');
  if (/^(profile|default|\*)$/i.test(wanted)) return PROFILE;
  const groups = await api.tabGroups.query({});
  const hit = groups.find((g) => (g.title || '').toLowerCase() === wanted.toLowerCase());
  if (!hit) {
    throw new Error(`no tab group named "${wanted}" (have: ${groups.map((g) => g.title || '(untitled)').join(', ') || 'none'} — or bind the workspace to "profile")`);
  }
  return { name: hit.title, groupId: hit.id, cookieStoreId: `chrome-group-${hit.id}`, color: hit.color };
}

function requireScope(conn) {
  if (!conn.scope) throw new Error('bridge is not bound to a tab group yet');
  return conn.scope;
}

async function assertInScope(conn, tabId) {
  const scope = requireScope(conn);
  let tab;
  try {
    tab = await api.tabs.get(tabId);
  } catch {
    throw new Error(`no such tab: ${tabId}`);
  }
  if (scope.groupId !== null && tab.groupId !== scope.groupId) {
    throw new Error(`refused: tab ${tabId} is not in the "${scope.name}" tab group`);
  }
  return tab;
}

const publicTab = (t) => ({
  tabId: t.id,
  url: t.url,
  title: t.title,
  active: t.active,
  windowId: t.windowId,
  pinned: t.pinned,
  lastAccessed: t.lastAccessed,
});

// ------------------------------------------------------------------ methods

async function dispatch(conn, method, params) {
  switch (method) {
    case 'listContainers':
      // Setup metadata only (names, no tab access), so the editor can say what to bind to.
      return (await listScopes()).map((s) => ({ name: s.name, cookieStoreId: s.cookieStoreId, color: s.color }));

    case 'listTabs': {
      const scope = requireScope(conn);
      const all = await api.tabs.query({});
      const tabs = scope.groupId === null ? all : all.filter((t) => t.groupId === scope.groupId);
      return { container: scope.name, tabs: tabs.map(publicTab) };
    }

    case 'navigate': {
      await assertInScope(conn, params.tabId);
      await api.tabs.update(params.tabId, { url: params.url });
      const settled = await waitForLoad(params.tabId);
      await markTabActivity(params.tabId, 'navigated');
      return publicTab(settled);
    }

    case 'newTab': {
      const scope = requireScope(conn);
      const tab = await api.tabs.create({ url: params.url, active: params.active !== false });
      if (scope.groupId !== null) await api.tabs.group({ tabIds: [tab.id], groupId: scope.groupId });
      return publicTab(await api.tabs.get(tab.id));
    }

    case 'activate': {
      const tab = await assertInScope(conn, params.tabId);
      await api.tabs.update(params.tabId, { active: true });
      await api.windows.update(tab.windowId, { focused: true });
      return { ok: true };
    }

    case 'readPage': {
      await assertInScope(conn, params.tabId);
      const page = await runInTab(params.tabId, PAGE_SCRIPTS.readPage, [MAX_TEXT]);
      await markTabActivity(params.tabId, 'read this page');
      return page;
    }

    case 'snapshot': {
      await assertInScope(conn, params.tabId);
      const snap = await runInTab(params.tabId, PAGE_SCRIPTS.snapshot, [params.options || null]);
      await markTabActivity(params.tabId, 'inspected this page');
      return snap;
    }

    case 'click': {
      await assertInScope(conn, params.tabId);
      await pace();
      const found = await runInTab(params.tabId, PAGE_SCRIPTS.locate, [
        params.ref ?? null, params.selector ?? null, params.text ?? null, params.exact === true,
      ]);
      if (found && found.__cobrowserError) throw new Error(found.__cobrowserError);
      if (found && found.ambiguous) {
        throw new Error(`"${params.text}" matches ${found.count} elements: ${found.samples.join(' | ')}. Pass exact:true, a more specific text, or use a ref from bridge_snapshot.`);
      }
      if (found && found.destructive && params.allowDestructive !== true) {
        return { refused: 'destructive', label: found.label, needsUserAction: `click "${found.label}" yourself, or re-issue with allowDestructive: true`, why: 'This looks like sign-out / delete / cancel-account. Refusing by default: a broad selector once signed the user out of their bank mid-session.' };
      }
      if (found && found.committing && params.allowDestructive !== true) {
        return { refused: 'committing', label: found.label, needsUserAction: `the human should click "${found.label}" themselves`, why: 'This submits a payment or places an order. The human owns that click.' };
      }
      const clicked = await runInTab(params.tabId, PAGE_SCRIPTS.click, [found ? found.ref : (params.ref ?? null), params.selector ?? null]);
      await markTabActivity(params.tabId, 'clicked');
      return clicked;
    }

    case 'fill': {
      await assertInScope(conn, params.tabId);
      await pace();
      const filled = await runInTab(params.tabId, PAGE_SCRIPTS.fill, [params.fields ?? [], params.allowCredentials === true]);
      if (filled && filled.refused && filled.refused.length) {
        return { ...filled, needsUserAction: `the human should type ${filled.refused.join(', ')} themselves`, why: 'Passwords, one-time codes and card numbers are never filled by the agent.' };
      }
      await markTabActivity(params.tabId, 'filled a form');
      return filled;
    }

    case 'evaluate': {
      await assertInScope(conn, params.tabId);
      await pace();
      const world = params.world === 'page' ? 'page' : 'isolated';
      if (world === 'page') console.log('[cobrowser] evaluate in PAGE world on tab', params.tabId);
      // Chrome injects straight into the page's realm with world:MAIN — no <script> tag, so
      // a page CSP cannot block it the way it can the Firefox add-on's page-world path.
      const value = await runInTab(params.tabId, PAGE_SCRIPTS.evaluate, [String(params.expression || ''), 'isolated'], world === 'page' ? 'MAIN' : 'ISOLATED');
      await markTabActivity(params.tabId, 'ran a script');
      if (value && value.__cobrowserError) throw new Error(value.__cobrowserError);
      return value;
    }

    case 'fetchUrl': {
      const tab = await assertInScope(conn, params.tabId);
      await pace();
      const result = await runInTab(params.tabId, PAGE_SCRIPTS.fetchUrl, [String(params.url || ''), params.method || 'GET', params.headers || null, params.body ?? null, tab.url]);
      if (result && result.__cobrowserError) throw new Error(result.__cobrowserError);
      if (result && noteRefusal(result.status, result.body)) {
        throw new Error(`the site answered ${result.status} (rate limit or challenge). Backing off for a minute — report this rather than retrying.`);
      }
      await markTabActivity(params.tabId, 'fetched data');
      return result;
    }

    case 'waitFor': {
      await assertInScope(conn, params.tabId);
      const deadline = Date.now() + Math.min(Number(params.timeoutMs) || 15000, 60000);
      for (;;) {
        const hit = await runInTab(params.tabId, PAGE_SCRIPTS.probe, [params.text ?? null, params.selector ?? null]).catch(() => null);
        if (hit && hit.found) return hit;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${params.text ? `text ${JSON.stringify(params.text)}` : `selector ${params.selector}`}`);
        await sleep(400);
      }
    }

    case 'screenshot': {
      const tab = await assertInScope(conn, params.tabId);
      // Chrome can only capture the visible tab of a window, so the tab is brought forward
      // first. Firefox captures any tab in place; this is the one visible difference.
      if (!tab.active) await api.tabs.update(tab.id, { active: true });
      const dataUrl = await api.tabs.captureVisibleTab(tab.windowId, { format: params.format === 'png' ? 'png' : 'jpeg', quality: 80 });
      const comma = dataUrl.indexOf(',');
      await markTabActivity(tab.id, 'took a screenshot');
      return { data: dataUrl.slice(comma + 1), mimeType: dataUrl.slice(5, dataUrl.indexOf(';')) };
    }

    default:
      throw new Error(`unknown method: ${method}`);
  }
}

function waitForLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = async () => {
      if (done) return;
      done = true;
      api.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(await api.tabs.get(tabId));
    };
    const listener = (id, changeInfo) => { if (id === tabId && changeInfo.status === 'complete') void finish(); };
    api.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, timeoutMs);
  });
}

// --------------------------------------------------------- injected scripts

/** Run one of PAGE_SCRIPTS in the tab. MV3's scripting API takes the function itself. */
async function runInTab(tabId, fn, args, world = 'ISOLATED') {
  let frames;
  try {
    frames = await api.scripting.executeScript({ target: { tabId }, func: fn, args, world });
  } catch (err) {
    throw new Error(`cannot script this tab (privileged or restricted page?): ${err.message ?? err}`);
  }
  return frames && frames.length ? frames[0].result : null;
}

async function markTabActivity(tabId, label) {
  try {
    await runInTab(tabId, PAGE_SCRIPTS.markActivity, [label, ACTIVITY_MS]);
  } catch {
    /* unscriptable page, or the tab closed mid-action — the action itself still stands */
  }
}

// Arrow functions, not method shorthand: runInTab injects `(${fn.toString()})(...)`, and a
// shorthand method stringifies to "name() { … }", which is a syntax error in that position.
const PAGE_SCRIPTS = {
  /** Draw a non-interactive frame + label, prefix the tab title, then undo both. */
  markActivity: (label, ms) => {
    const ID = '__cobrowser_activity__';
    const PREFIX = '\u25CF '; // ● — shows in the tab strip, where an overlay cannot reach
    const prior = document.getElementById(ID);
    if (prior) prior.remove();

    const box = document.createElement('div');
    box.id = ID;
    // pointer-events:none is load-bearing: the human must still be able to click the page
    // underneath, and the agent's own synthetic clicks must not land on this element.
    box.style.cssText = [
      'position:fixed', 'inset:0', 'pointer-events:none', 'z-index:2147483647',
      'border:3px solid #7c5cff', 'box-sizing:border-box',
      'transition:opacity .4s ease', 'opacity:1',
    ].join(';');
    const tag = document.createElement('div');
    tag.textContent = 'cobrowser: ' + label;
    tag.style.cssText = [
      'position:absolute', 'top:0', 'left:50%', 'transform:translateX(-50%)',
      'background:#7c5cff', 'color:#fff', 'font:600 12px/1.6 system-ui,sans-serif',
      'padding:2px 10px', 'border-radius:0 0 6px 6px', 'white-space:nowrap',
    ].join(';');
    box.appendChild(tag);
    (document.body || document.documentElement).appendChild(box);

    if (!document.title.startsWith(PREFIX)) document.title = PREFIX + document.title;

    clearTimeout(window.__cobrowserActivityTimer);
    window.__cobrowserActivityTimer = setTimeout(() => {
      const el = document.getElementById(ID);
      if (el) {
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 400);
      }
      if (document.title.startsWith(PREFIX)) document.title = document.title.slice(PREFIX.length);
    }, ms);
    return true;
  },

  /**
   * Evaluate an expression and return JSON.
   *
   * Default world is ISOLATED: the content-script realm, which shares the DOM with the page
   * but not its JavaScript. That is the safe default — page code cannot see the expression
   * or tamper with its result. It is NOT a read-only sandbox: the DOM is shared, so a script
   * that wants to mutate the page still can. Read-only is a contract with the agent, not a
   * guarantee the browser enforces.
   *
   * world:"page" injects a <script> into the page's own realm, which is what reaching
   * framework internals (React fibres, app globals) requires.
   */
  evaluate: (expression, world) => {
    const pack = (v) => {
      // Structured-clone what we can; fall back to a description rather than throwing.
      try {
        return JSON.parse(JSON.stringify(v ?? null));
      } catch {
        return String(v);
      }
    };
    if (world !== 'page') {
      try {
        // Indirect eval: evaluates in the isolated realm, no access to page globals.
        const value = (0, eval)(`(${expression})`);
        return pack(value && typeof value.then === 'function' ? undefined : value);
      } catch (e) {
        return { __cobrowserError: `isolated-world evaluate failed: ${e && e.message ? e.message : e}` };
      }
    }
    // Page world: hand the expression to a <script> the page itself runs, and read the
    // result back off a dataset attribute (the only channel the two realms share).
    try {
      const id = '__cb_eval_' + Math.random().toString(36).slice(2);
      const tag = document.createElement('script');
      tag.textContent =
        'try{var r=(' + expression + ');document.documentElement.setAttribute(' +
        JSON.stringify(id) + ', JSON.stringify(r===undefined?null:r));}catch(e){' +
        'document.documentElement.setAttribute(' + JSON.stringify(id + '_err') + ', String(e&&e.message||e));}';
      (document.head || document.documentElement).appendChild(tag);
      tag.remove();
      const err = document.documentElement.getAttribute(id + '_err');
      const raw = document.documentElement.getAttribute(id);
      document.documentElement.removeAttribute(id);
      document.documentElement.removeAttribute(id + '_err');
      if (err) return { __cobrowserError: `page-world evaluate failed: ${err}` };
      return raw === null ? null : JSON.parse(raw);
    } catch (e) {
      return { __cobrowserError: `page-world evaluate failed: ${e && e.message ? e.message : e}` };
    }
  },

  /** Same-origin fetch issued from the page, so it carries that tab's cookies. */
  fetchUrl: async (url, method, headers, body, tabUrl) => {
    try {
      const target = new URL(url, location.href);
      const here = new URL(tabUrl || location.href);
      if (target.origin !== here.origin) {
        return {
          __cobrowserError:
            `refusing a cross-origin fetch: tab is ${here.origin}, requested ${target.origin}. ` +
            'Navigate a tab to that origin first, so the request carries the right session.',
        };
      }
      const res = await fetch(target.href, {
        method: method || 'GET',
        headers: headers || undefined,
        body: body ?? undefined,
        credentials: 'include',
        redirect: 'follow',
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        /* not JSON; text is returned instead */
      }
      const MAX = 400000;
      return {
        status: res.status,
        url: res.url,
        contentType: res.headers.get('content-type') || '',
        json: json ?? undefined,
        body: json ? undefined : text.slice(0, MAX),
        truncated: !json && text.length > MAX,
      };
    } catch (e) {
      return { __cobrowserError: `fetch failed: ${e && e.message ? e.message : e}` };
    }
  },

  /** Cheap existence check, used by waitFor. */
  probe: (text, selector) => {
    if (selector) {
      const el = document.querySelector(selector);
      return { found: !!el, url: location.href };
    }
    const hay = (document.body ? document.body.innerText : '') || '';
    return { found: hay.includes(text), url: location.href };
  },

  readPage: (maxText) => {
    const text = (document.body ? document.body.innerText : '') || '';
    return {
      url: location.href,
      title: document.title,
      truncated: text.length > maxText,
      text: text.slice(0, maxText),
    };
  },

  snapshot: (opts) => {
    const o = opts || {};
    const SEL = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [contenteditable="true"]';

    // Walk open shadow roots. Sites built from web components (Chase's <mds-*> elements, for
    // one) put every control inside a shadow root, so a flat querySelectorAll finds nothing
    // actionable and the page looks empty to the agent.
    const collect = (root, out, depth) => {
      if (depth > 8) return;
      for (const el of root.querySelectorAll('*')) {
        if (el.matches && el.matches(SEL)) out.push(el);
        if (el.shadowRoot) collect(el.shadowRoot, out, depth + 1);
      }
    };
    const scope = o.withinSelector ? document.querySelector(o.withinSelector) : document;
    if (!scope) return { url: location.href, title: document.title, elements: [], note: `withinSelector matched nothing: ${o.withinSelector}` };
    const found = [];
    collect(scope, found, 0);

    const out = [];
    let n = 0;
    let skippedUnlabeled = 0;
    for (const el of found) {
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;

      const label = (
        el.getAttribute('aria-label') ||
        (el.labels && el.labels[0] && el.labels[0].innerText) ||
        el.getAttribute('placeholder') ||
        (el.innerText || '').trim().slice(0, 80) ||
        el.getAttribute('title') ||
        el.getAttribute('name') ||
        ''
      ).replace(/\s+/g, ' ').trim();

      // An unlabeled icon button is noise the agent cannot act on meaningfully; a page of
      // them was 200+ entries of nothing. Droppable, but counted so the agent knows.
      if (o.labeledOnly && !label) { skippedUnlabeled++; continue; }
      if (o.textContains && !label.toLowerCase().includes(String(o.textContains).toLowerCase())) continue;
      if (o.role && (el.getAttribute('role') || el.tagName.toLowerCase()) !== o.role) continue;

      const ref = 'cb' + ++n;
      el.setAttribute('data-cobrowser-ref', ref);
      const item = {
        ref,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || undefined,
        label,
        value: 'value' in el && typeof el.value === 'string' ? el.value.slice(0, 120) : undefined,
        disabled: !!el.disabled,
      };
      // The destination, so twenty identical "View order detail" links can be navigated
      // directly instead of clicked one at a time through pagination that resets.
      if (el.tagName === 'A' && el.href) item.href = el.href;
      if (el.id) item.id = el.id;
      if (el.getAttribute('name')) item.name = el.getAttribute('name');
      // Options, so the agent can choose by visible text rather than guessing a value.
      if (el.tagName === 'SELECT') {
        item.options = Array.from(el.options).slice(0, 60).map((op) => ({ text: (op.text || '').trim(), value: op.value, selected: op.selected }));
      }
      out.push(item);
      if (o.limit && out.length >= o.limit) break;
    }
    return {
      url: location.href,
      title: document.title,
      elements: out,
      truncated: !!(o.limit && found.length > out.length),
      skippedUnlabeled: skippedUnlabeled || undefined,
    };
  },

  /**
   * Find one element by ref, selector, or visible text — and report what it looks like it
   * does, so the caller can refuse before activating it. Text matching is what the agent
   * actually wants ("Load more orders"); CSS-only forced broad fallbacks that hit the wrong
   * element.
   */
  locate: (ref, selector, text, exact) => {
    const DESTRUCTIVE = /\b(sign\s?out|log\s?out|logout|delete\s+account|close\s+account|cancel\s+(account|subscription|membership)|deactivate|remove\s+account)\b/i;
    const COMMITTING = /\b(pay\s+now|confirm\s+(payment|order|purchase)|place\s+order|submit\s+payment|send\s+money|transfer\s+now|buy\s+now)\b/i;
    const labelOf = (el) =>
      ((el.getAttribute && el.getAttribute('aria-label')) ||
        (el.innerText || '') ||
        (el.getAttribute && el.getAttribute('title')) ||
        (el.value || '') ||
        '').replace(/\s+/g, ' ').trim();

    let el = null;
    if (ref) el = document.querySelector(`[data-cobrowser-ref="${ref}"]`);
    else if (selector) el = document.querySelector(selector);
    else if (text) {
      const SEL = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [contenteditable="true"]';
      const all = [];
      const collect = (root, depth) => {
        if (depth > 8) return;
        for (const node of root.querySelectorAll('*')) {
          if (node.matches && node.matches(SEL)) all.push(node);
          if (node.shadowRoot) collect(node.shadowRoot, depth + 1);
        }
      };
      collect(document, 0);
      const want = String(text).toLowerCase();
      const hits = all.filter((n) => {
        const box = n.getBoundingClientRect();
        if (!box.width || !box.height) return false;
        const l = labelOf(n).toLowerCase();
        return exact ? l === want : l.includes(want);
      });
      if (hits.length > 1) {
        return {
          ambiguous: true,
          count: hits.length,
          samples: hits.slice(0, 5).map((n) => labelOf(n).slice(0, 60)),
        };
      }
      el = hits[0] || null;
    }
    if (!el) return { __cobrowserError: `no element for ${ref || selector || JSON.stringify(text)}` };

    const tag = 'cb_target_' + Math.random().toString(36).slice(2, 8);
    el.setAttribute('data-cobrowser-ref', tag);
    const label = labelOf(el);
    return {
      ref: tag,
      label,
      tag: el.tagName.toLowerCase(),
      href: el.tagName === 'A' ? el.href : undefined,
      destructive: DESTRUCTIVE.test(label),
      committing: COMMITTING.test(label),
    };
  },

  click: (ref, selector) => {
    const el = ref
      ? document.querySelector(`[data-cobrowser-ref="${ref}"]`)
      : document.querySelector(selector);
    if (!el) throw new Error(`no element for ${ref || selector}`);
    el.scrollIntoView({ block: 'center' });

    // Approach the element with a real pointer stream rather than jumping straight to
    // el.click(). This is not cosmetic: menus, dropdowns and toolbars that only appear on
    // hover never fire at all for a bare click, so those targets simply did not work.
    // Events stay isTrusted:false — no extension API can change that — but the SEQUENCE is
    // what page code listens for.
    const box = el.getBoundingClientRect();
    const to = {
      x: box.left + box.width * (0.35 + Math.random() * 0.3),
      y: box.top + box.height * (0.35 + Math.random() * 0.3),
    };
    const from = { x: to.x - 180, y: to.y - 120 };
    const at = (x, y, type, extra) =>
      new MouseEvent(type, {
        bubbles: true, cancelable: true, view: window,
        clientX: x, clientY: y, ...extra,
      });

    const STEPS = 10;
    for (let i = 1; i <= STEPS; i++) {
      const t = i / STEPS;
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // ease-in-out
      const x = from.x + (to.x - from.x) * e;
      const y = from.y + (to.y - from.y) * e;
      // Dispatch on whatever is actually under the cursor, so elements passed on the way
      // receive their own mouseover — that is what opens hover menus.
      const over = document.elementFromPoint(x, y) || el;
      over.dispatchEvent(at(x, y, 'mousemove'));
    }
    el.dispatchEvent(at(to.x, to.y, 'mouseover'));
    el.dispatchEvent(at(to.x, to.y, 'mouseenter'));
    if (typeof el.focus === 'function') el.focus();
    el.dispatchEvent(at(to.x, to.y, 'mousedown', { button: 0, buttons: 1 }));
    el.dispatchEvent(at(to.x, to.y, 'mouseup', { button: 0, buttons: 0 }));
    // Still call click(): it is what actually activates links and submits, and a synthetic
    // mouseup alone does not.
    el.click();
    return { clicked: ref || selector, url: location.href };
  },

  fill: (fields, allowCredentials) => {
    const setValue = (el, value) => {
      const proto =
        el.tagName === 'TEXTAREA'
          ? HTMLTextAreaElement.prototype
          : el.tagName === 'SELECT'
            ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value');
      // Go through the native setter so React's value tracker sees the change; assigning
      // el.value directly is swallowed by frameworks that cache the last known value.
      if (setter && setter.set) setter.set.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const CREDENTIAL = /\b(password|passcode|pin|otp|one[-\s]?time|2fa|mfa|security\s+code|verification\s+code|cvv|cvc|card\s+number|ssn|social\s+security)\b/i;
    const describes = (el) =>
      [
        el.getAttribute('aria-label'),
        el.getAttribute('name'),
        el.getAttribute('id'),
        el.getAttribute('placeholder'),
        el.getAttribute('autocomplete'),
        el.labels && el.labels[0] ? el.labels[0].innerText : '',
      ].join(' ');

    const filled = [];
    const refused = [];
    for (const f of fields) {
      const el = f.ref
        ? document.querySelector(`[data-cobrowser-ref="${f.ref}"]`)
        : document.querySelector(f.selector);
      if (!el) throw new Error(`no element for ${f.ref || f.selector}`);

      // The human owns their secrets. type="password" covers most of it; the rest is caught
      // by what the field calls itself, since OTP boxes are usually type="text".
      const isSecret =
        el.type === 'password' || CREDENTIAL.test(describes(el)) || el.autocomplete === 'one-time-code';
      if (isSecret && !allowCredentials) {
        refused.push((el.getAttribute('name') || el.getAttribute('id') || el.type || 'field').slice(0, 40));
        continue;
      }

      el.scrollIntoView({ block: 'center' });
      if (typeof el.focus === 'function') el.focus();

      if (el.tagName === 'SELECT') {
        // Choose by VISIBLE TEXT, then drive it like a user would. Setting .value alone left
        // React lists unrefreshed: the framework listens for the event sequence, not the
        // property write.
        const want = String(f.value).toLowerCase();
        const match =
          Array.from(el.options).find((o) => (o.text || '').trim().toLowerCase() === want) ||
          Array.from(el.options).find((o) => (o.text || '').toLowerCase().includes(want)) ||
          Array.from(el.options).find((o) => o.value === f.value);
        if (!match) {
          throw new Error(
            `no option matching ${JSON.stringify(f.value)}; available: ` +
              Array.from(el.options).slice(0, 20).map((o) => (o.text || '').trim()).join(' | '),
          );
        }
        setValue(el, match.value);
        el.dispatchEvent(new Event('blur', { bubbles: true }));
        filled.push({ target: f.ref || f.selector, chose: (match.text || '').trim() });
        continue;
      }

      if (el.isContentEditable) {
        el.textContent = f.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        setValue(el, f.value);
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      }
      filled.push({ target: f.ref || f.selector });
    }
    return { filled, refused };
  },
};


// ------------------------------------------------------------------- status

function statusList() {
  return [...conns.values()].map((c) => ({
    url: c.url,
    connected: !!c.ws && c.ws.readyState === WebSocket.OPEN,
    container: c.scope ? c.scope.name : null,
    workspace: c.workspace ?? null,
    error: c.error,
  }));
}

function updateBadge() {
  const live = statusList().filter((s) => s.connected && s.container).length;
  try {
    void api.action.setBadgeText({ text: live ? String(live) : '' });
    void api.action.setBadgeBackgroundColor({ color: '#29a891' });
  } catch {
    /* no toolbar to draw on */
  }
}

// Chrome's onMessage does not accept a returned Promise: answer through sendResponse and
// return true to keep the channel open.
api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const reply = (p) => { Promise.resolve(p).then(sendResponse, (e) => sendResponse({ error: String(e) })); return true; };
  if (msg && msg.type === 'status') return reply(statusList());
  if (msg && msg.type === 'reconcile') return reply(reconcile().then(() => statusList()));
  if (msg && msg.type === 'containers') return reply(listScopes());
  return false;
});

api.storage.onChanged.addListener((changes, area) => {
  if ((area === 'local' || area === 'managed') && changes.endpoints) void reconcile();
});

// A torn-down worker loses its sockets; this brings them back within half a minute even if
// nothing else woke us. reconcile() is a no-op while everything is connected.
api.alarms.create('cobrowser-reconcile', { periodInMinutes: 0.5 });
api.alarms.onAlarm.addListener((a) => { if (a.name === 'cobrowser-reconcile') void reconcile(); });
api.runtime.onStartup.addListener(() => void reconcile());
api.runtime.onInstalled.addListener(() => void reconcile());

void reconcile();
