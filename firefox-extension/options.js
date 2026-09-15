const api = typeof browser !== 'undefined' ? browser : chrome;

const $ = (id) => document.getElementById(id);

async function loadEndpoints() {
  const { endpoints } = await api.storage.local.get('endpoints');
  $('endpoints').value = Array.isArray(endpoints) ? endpoints.join('\n') : '';
}

async function save() {
  const endpoints = $('endpoints')
    .value.split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  await api.storage.local.set({ endpoints });
  const badge = $('saved');
  badge.hidden = false;
  setTimeout(() => (badge.hidden = true), 1500);
  await refreshStatus();
}

function li(...children) {
  const el = document.createElement('li');
  for (const c of children) el.append(c);
  return el;
}

function span(className, text) {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

async function refreshStatus() {
  const list = await api.runtime.sendMessage({ type: 'reconcile' });
  const ul = $('status');
  ul.replaceChildren();
  if (!list || list.length === 0) {
    ul.append(span('empty', 'No endpoints configured.'));
    return;
  }
  for (const s of list) {
    const dot = span(`dot ${s.connected && s.container ? 'on' : 'off'}`, '');
    const label = s.container
      ? span('', s.container)
      : span('err', s.error || (s.connected ? 'connected, unbound' : 'offline'));
    const url = span('mono grow', s.url.replace(/token=[^&]*/, 'token=…'));
    ul.append(li(dot, label, url));
  }
}

async function refreshContainers() {
  const containers = await api.runtime.sendMessage({ type: 'containers' });
  const ul = $('containers');
  ul.replaceChildren();
  if (!containers || containers.length === 0) {
    ul.append(span('empty', 'No containers in this profile.'));
    return;
  }
  for (const c of containers) {
    ul.append(li(span('', c.name), span('mono grow', c.cookieStoreId)));
  }
}

$('save').addEventListener('click', () => void save());

void loadEndpoints();
void refreshStatus();
void refreshContainers();
setInterval(() => void refreshStatus(), 3000);
