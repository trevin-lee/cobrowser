const api = typeof browser !== 'undefined' ? browser : chrome;

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
};

/** A workspace's folder name and where it is, from its path (or the endpoint URL's). */
function workspaceOf(s) {
  let p = s.workspace;
  if (!p) try { p = new URL(s.url).searchParams.get('workspace'); } catch { /* not a URL */ }
  if (!p) return { name: 'Workspace', where: '' };
  const parts = p.split('/').filter(Boolean);
  return { name: parts.pop() || p, where: ('/' + parts.join('/')).replace(/^\/Users\/[^/]+/, '~') };
}

/** A container's chip, in Firefox's own colour for it. */
function chip(name, colorCode, note) {
  const c = el('span', 'chip');
  if (colorCode) c.style.setProperty('--c', colorCode);
  c.append(el('i'), name);
  if (note) c.append(el('small', null, note));
  return c;
}

let containers = [];

async function refreshContainers() {
  containers = (await api.runtime.sendMessage({ type: 'containers' })) || [];
  const box = $('containers');
  box.replaceChildren();
  for (const c of containers) box.append(chip(c.name, c.colorCode));
  box.append(chip('default', null, 'no container'));
}

async function refreshStatus() {
  const list = (await api.runtime.sendMessage({ type: 'reconcile' })) || [];
  const box = $('status');
  box.replaceChildren();
  if (!list.length) box.append(el('div', 'empty', 'No workspace is connected yet. Bind one in your editor, and it appears here.'));
  for (const s of list) {
    const { name, where } = workspaceOf(s);
    const bound = s.connected && s.container;
    const row = el('div', 'ws ' + (bound ? 'on' : 'off'));
    const who = el('div', 'who');
    who.append(el('div', 'name', name), el('div', 'where mono', where));
    row.title = s.url.replace(/token=[^&]*/, 'token=…');
    const state = el('div', 'state');
    if (bound) {
      const known = containers.find((c) => c.name === s.container);
      state.append(chip(s.container === 'Default (no container)' ? 'default' : s.container, known && known.colorCode));
    } else {
      // A few words here; the whole message on hover.
      state.textContent = stateWords(s.connected, s.error);
      state.title = !s.connected ? 'Not connected. Is its editor window open?' : s.error || 'Not bound to a scope yet.';
      if (s.connected && s.error && state.textContent === 'Error') row.className = 'ws err';
    }
    row.append(el('span', 'mark'), who, state);
    box.append(row);
  }
  const live = list.filter((s) => s.connected && s.container).length;
  $('summary').className = 'pill' + (live ? ' live' : '');
  $('summary').lastElementChild.textContent = live ? `${live} connected` : 'Not connected';
}

async function refreshUsage() {
  const u = await api.runtime.sendMessage({ type: 'usage' });
  if (!u || u.error) return;
  $('count').textContent = String(u.requests);
  $('of').textContent = `of ${u.cap} this browser session`;
  $('fill').style.width = Math.min(100, (u.requests / u.cap) * 100) + '%';
  $('meter').classList.toggle('full', u.requests >= u.cap);
  $('paused').hidden = !u.backoffSeconds;
  $('paused').textContent = u.backoffSeconds ? `Paused for ${u.backoffSeconds} s: a site refused a request.` : '';
}

async function resetCap() {
  const u = await api.runtime.sendMessage({ type: 'resetCap' });
  if (u && u.error) { $('paused').hidden = false; $('paused').textContent = u.error; } else await refreshUsage();
}

async function loadEndpoints() {
  const { endpoints } = await api.storage.local.get('endpoints');
  $('endpoints').value = Array.isArray(endpoints) ? endpoints.join('\n') : '';
  if ($('endpoints').value) $('manual').open = true;
}

async function save() {
  const endpoints = $('endpoints').value.split('\n').map((s) => s.trim()).filter(Boolean);
  await api.storage.local.set({ endpoints });
  $('saved').hidden = false;
  setTimeout(() => ($('saved').hidden = true), 1500);
  await refreshStatus();
}

// The editor's accent (cobrowser.accentColor), as the agent's frame on tabs uses it.
api.runtime.sendMessage({ type: 'accent' }).then((c) => { if (/^#[0-9a-f]{6}$/i.test(c || '')) document.documentElement.style.setProperty('--accent', c); }, () => undefined);

$('save').addEventListener('click', () => void save());
$('reset').addEventListener('click', () => void resetCap());

void loadEndpoints();
void refreshContainers().then(refreshStatus);
void refreshUsage();
setInterval(() => { void refreshStatus(); void refreshUsage(); }, 3000);

/** A workspace's state in a few words. "Not bound" first: the unbound message, "this workspace
 *  is not bound to Chrome", also contains "bound to Chrome". */
function stateWords(connected, error) {
  const e = error || '';
  if (!connected) return 'Not running';
  if (!e || /not bound/i.test(e)) return 'Not bound';
  if (/bound to Firefox/i.test(e)) return 'Bound to Firefox';
  if (/bound to Chrome/i.test(e)) return 'Bound to Chrome';
  return 'Error';
}
