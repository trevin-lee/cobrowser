const api = chrome;

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
  if (!Array.isArray(list) || list.length === 0) {
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

async function refreshGroups() {
  const scopes = await api.runtime.sendMessage({ type: 'containers' });
  const ul = $('containers');
  ul.replaceChildren();
  if (!Array.isArray(scopes) || scopes.length === 0) {
    ul.append(span('empty', 'No tab groups open.'));
    return;
  }
  for (const s of scopes) {
    ul.append(li(span('', s.name), span('mono grow', s.groupId == null ? 'profile' : `group ${s.groupId} · ${s.color}`)));
  }
}

$('save').addEventListener('click', () => void save());

void loadEndpoints();
void refreshStatus();
void refreshGroups();
setInterval(() => void refreshStatus(), 3000);
