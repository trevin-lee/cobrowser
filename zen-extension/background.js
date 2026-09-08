/**
 * Cobrowser Bridge — background page.
 *
 * Dials OUT to one or more Cobrowser endpoints (an extension can't listen on a port), one
 * per editor workspace. Each endpoint declares which container it is scoped to; every tab
 * this bridge exposes or touches for that endpoint is checked against that container's
 * cookieStoreId first.
 *
 * MV2 with a persistent background page on purpose: an MV3 event page gets torn down and
 * would drop these sockets. Zen still accepts manifest_version 2.
 *
 * The scoping is enforced HERE and only here. The extension holds permission for every
 * container in the profile; what keeps the `school` workspace out of `personal` is
 * assertInScope() below, not anything the browser enforces.
 */

const api = typeof browser !== 'undefined' ? browser : chrome;

const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
const CALL_TIMEOUT_MS = 30000;
const MAX_TEXT = 20000;

/** endpoint url -> connection state */
const conns = new Map();

// ---------------------------------------------------------------- endpoints

const clean = (list) =>
  (Array.isArray(list) ? list : [])
    .map((e) => (typeof e === 'string' ? e.trim() : ''))
    .filter((e) => e.startsWith('ws://') || e.startsWith('wss://'));

/**
 * Endpoints come from two places:
 *   - storage.managed — a JSON manifest Cobrowser writes for you, so a workspace can
 *     register itself without anyone pasting a URL. Read-only from in here.
 *   - storage.local — whatever you typed on the options page.
 * Managed entries win the ordering; duplicates collapse.
 */
async function loadEndpoints() {
  let managed = [];
  try {
    const m = await api.storage.managed.get('endpoints');
    managed = clean(m && m.endpoints);
  } catch {
    // No managed manifest installed — the normal case for a hand-configured bridge.
  }
  const { endpoints } = await api.storage.local.get('endpoints');
  return [...new Set([...managed, ...clean(endpoints)])];
}

async function reconcile() {
  const wanted = new Set(await loadEndpoints());
  for (const [url, conn] of conns) {
    if (!wanted.has(url)) {
      conn.disposed = true;
      clearTimeout(conn.timer);
      try {
        conn.ws?.close();
      } catch {}
      conns.delete(url);
    }
  }
  for (const url of wanted) if (!conns.has(url)) connect(url);
  updateBadge();
}

// -------------------------------------------------------------- connections

function connect(url) {
  let conn = conns.get(url);
  if (!conn) {
    conn = { url, ws: null, scope: null, attempt: 0, timer: null, disposed: false, error: null };
    conns.set(url, conn);
  }
  if (conn.disposed) return;

  let ws;
  try {
    ws = new WebSocket(url);
  } catch (err) {
    conn.error = String(err);
    return scheduleRetry(conn);
  }
  conn.ws = ws;

  ws.onopen = () => {
    conn.attempt = 0;
    conn.error = null;
    updateBadge();
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    void handleMessage(conn, msg);
  };

  ws.onclose = () => {
    conn.ws = null;
    conn.scope = null;
    updateBadge();
    scheduleRetry(conn);
  };

  ws.onerror = () => {
    // onclose always follows; retry is scheduled there.
    conn.error = 'connection failed';
  };
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
      conn.scope = await resolveContainer(msg.container);
      conn.workspace = msg.workspace ?? null;
      send(conn, { type: 'ready', container: conn.scope, browser: 'zen' });
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

async function resolveContainer(name) {
  const wanted = String(name ?? '').trim();
  if (!wanted) throw new Error('no container configured for this workspace');
  if (wanted.toLowerCase() === 'default') {
    return { name: 'Default (no container)', cookieStoreId: 'firefox-default', color: null, icon: null };
  }
  const all = await api.contextualIdentities.query({});
  const hit = all.find((c) => c.name.toLowerCase() === wanted.toLowerCase());
  if (!hit) {
    throw new Error(`no container named "${wanted}" (have: ${all.map((c) => c.name).join(', ') || 'none'})`);
  }
  return { name: hit.name, cookieStoreId: hit.cookieStoreId, color: hit.color, icon: hit.icon };
}

function requireScope(conn) {
  if (!conn.scope) throw new Error('bridge is not bound to a container yet');
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
  if (tab.cookieStoreId !== scope.cookieStoreId) {
    throw new Error(`refused: tab ${tabId} is not in the "${scope.name}" container`);
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
    case 'listContainers': {
      // Deliberately NOT scoped — this is setup metadata (names only, no tab access) so
      // the editor side can tell you what to bind a workspace to.
      const all = await api.contextualIdentities.query({});
      return all.map((c) => ({ name: c.name, cookieStoreId: c.cookieStoreId, color: c.color }));
    }

    case 'listTabs': {
      const scope = requireScope(conn);
      const tabs = await api.tabs.query({ cookieStoreId: scope.cookieStoreId });
      return { container: scope.name, tabs: tabs.map(publicTab) };
    }

    case 'navigate': {
      await assertInScope(conn, params.tabId);
      await api.tabs.update(params.tabId, { url: params.url });
      const settled = await waitForLoad(params.tabId);
      return publicTab(settled);
    }

    case 'newTab': {
      const scope = requireScope(conn);
      const tab = await api.tabs.create({
        cookieStoreId: scope.cookieStoreId,
        url: params.url,
        active: params.active !== false,
      });
      return publicTab(tab);
    }

    case 'activate': {
      const tab = await assertInScope(conn, params.tabId);
      await api.tabs.update(params.tabId, { active: true });
      await api.windows.update(tab.windowId, { focused: true });
      return { ok: true };
    }

    case 'readPage': {
      await assertInScope(conn, params.tabId);
      return runInTab(params.tabId, PAGE_SCRIPTS.readPage, [MAX_TEXT]);
    }

    case 'snapshot': {
      await assertInScope(conn, params.tabId);
      return runInTab(params.tabId, PAGE_SCRIPTS.snapshot, []);
    }

    case 'click': {
      await assertInScope(conn, params.tabId);
      return runInTab(params.tabId, PAGE_SCRIPTS.click, [params.ref ?? null, params.selector ?? null]);
    }

    case 'fill': {
      await assertInScope(conn, params.tabId);
      return runInTab(params.tabId, PAGE_SCRIPTS.fill, [params.fields ?? []]);
    }

    case 'screenshot': {
      const tab = await assertInScope(conn, params.tabId);
      const dataUrl = await api.tabs.captureTab(tab.id, {
        format: params.format === 'png' ? 'png' : 'jpeg',
        quality: 80,
      });
      const comma = dataUrl.indexOf(',');
      return { data: dataUrl.slice(comma + 1), mimeType: dataUrl.slice(5, dataUrl.indexOf(';')) };
    }

    default:
      throw new Error(`unknown method: ${method}`);
  }
}

/** Resolve once the tab reports complete, or after a grace period. */
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
    const listener = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === 'complete') void finish();
    };
    api.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, timeoutMs);
  });
}

// --------------------------------------------------------- injected scripts

/**
 * Run a function in the page's DOM via tabs.executeScript. MV2 lets us inject a code
 * string, which keeps these self-contained (no separate content-script file, no
 * message plumbing).
 */
async function runInTab(tabId, fn, args) {
  const code = `(${fn.toString()}).apply(null, ${JSON.stringify(args)});`;
  let frames;
  try {
    frames = await api.tabs.executeScript(tabId, { code, runAt: 'document_end' });
  } catch (err) {
    throw new Error(`cannot script this tab (privileged or restricted page?): ${err.message ?? err}`);
  }
  return frames && frames.length ? frames[0] : null;
}

// Arrow functions, not method shorthand: runInTab injects `(${fn.toString()})(...)`, and a
// shorthand method stringifies to "name() { … }", which is a syntax error in that position.
const PAGE_SCRIPTS = {
  readPage: (maxText) => {
    const text = (document.body ? document.body.innerText : '') || '';
    return {
      url: location.href,
      title: document.title,
      truncated: text.length > maxText,
      text: text.slice(0, maxText),
    };
  },

  snapshot: () => {
    const SEL = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [contenteditable="true"]';
    const out = [];
    let n = 0;
    for (const el of document.querySelectorAll(SEL)) {
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      const ref = 'cb' + ++n;
      el.setAttribute('data-cobrowser-ref', ref);
      // What a human would call this control, most human-readable source first: the
      // visible <label> beats the form field's `name`, which an agent can't act on.
      const label =
        el.getAttribute('aria-label') ||
        (el.labels && el.labels[0] && el.labels[0].innerText) ||
        el.getAttribute('placeholder') ||
        (el.innerText || '').trim().slice(0, 80) ||
        el.getAttribute('title') ||
        el.getAttribute('name') ||
        '';
      out.push({
        ref,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || undefined,
        label: label.replace(/\s+/g, ' ').trim(),
        value: 'value' in el && typeof el.value === 'string' ? el.value.slice(0, 120) : undefined,
        disabled: !!el.disabled,
      });
    }
    return { url: location.href, title: document.title, elements: out };
  },

  click: (ref, selector) => {
    const el = ref
      ? document.querySelector(`[data-cobrowser-ref="${ref}"]`)
      : document.querySelector(selector);
    if (!el) throw new Error(`no element for ${ref || selector}`);
    el.scrollIntoView({ block: 'center' });
    if (typeof el.focus === 'function') el.focus();
    el.click();
    return { clicked: ref || selector, url: location.href };
  },

  fill: (fields) => {
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

    const filled = [];
    for (const f of fields) {
      const el = f.ref
        ? document.querySelector(`[data-cobrowser-ref="${f.ref}"]`)
        : document.querySelector(f.selector);
      if (!el) throw new Error(`no element for ${f.ref || f.selector}`);
      el.scrollIntoView({ block: 'center' });
      if (typeof el.focus === 'function') el.focus();
      if (el.isContentEditable) {
        el.textContent = f.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        setValue(el, f.value);
      }
      filled.push(f.ref || f.selector);
    }
    return { filled };
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
    api.browserAction.setBadgeText({ text: live ? String(live) : '' });
    api.browserAction.setBadgeBackgroundColor({ color: '#2d7d46' });
  } catch {
    // No toolbar to draw on (headless). The bridge itself is unaffected.
  }
}

api.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'status') return Promise.resolve(statusList());
  if (msg && msg.type === 'reconcile') return reconcile().then(() => statusList());
  if (msg && msg.type === 'containers') return api.contextualIdentities.query({});
  return undefined;
});

api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.endpoints) void reconcile();
});

void reconcile();
