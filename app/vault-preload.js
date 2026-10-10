// Preload for the vault window: the only bridge between its page and the app. Lists carry
// hosts, usernames and a card's last four digits; the one call that returns a password is
// reveal, which asks for a fresh confirmation every time.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vault', {
  list: () => ipcRenderer.invoke('vault:list'),
  add: (host, username, password, scope, also, notes, scopeFrom) => ipcRenderer.invoke('vault:add', { host, username, password, scope, also, notes, scopeFrom }),
  // A change of workspaces, from the scope the window showed (before) to the one chosen (after).
  setScope: (host, username, before, after) => ipcRenderer.invoke('vault:setScope', { host, username, before, after }),
  workspaces: () => ipcRenderer.invoke('vault:workspaces'),
  remove: (host, username) => ipcRenderer.invoke('vault:remove', { host, username }),
  reveal: (host, username) => ipcRenderer.invoke('vault:reveal', { host, username }),
  // A password the person revealed, onto the clipboard; the app clears it again after a while.
  copyPassword: (secret) => ipcRenderer.invoke('vault:copyPassword', { secret }),
  // Only for a vault file this Mac's keychain key cannot open: it is kept, renamed.
  startOver: () => ipcRenderer.invoke('vault:startOver'),
  importCsv: (scope) => ipcRenderer.invoke('vault:importCsv', { scope }),
  update: (from, fields) => ipcRenderer.invoke('vault:update', { from, ...fields }),
  exportCsv: () => ipcRenderer.invoke('vault:exportCsv'),
  lock: () => ipcRenderer.invoke('vault:lock'),
  // Cards: the number and code go in, never come back out (lists carry the last four digits).
  cards: () => ipcRenderer.invoke('vault:cards'),
  addCard: (fields) => ipcRenderer.invoke('vault:addCard', fields),
  updateCard: (id, fields) => ipcRenderer.invoke('vault:updateCard', { id, ...fields }),
  removeCard: (id) => ipcRenderer.invoke('vault:removeCard', { id }),
  exportCards: () => ipcRenderer.invoke('vault:exportCards'),
  importCards: () => ipcRenderer.invoke('vault:importCards'),
  // The vault changed somewhere else (an agent's grant, the editor, a Lock from the menu bar).
  onChanged: (cb) => { ipcRenderer.on('vault:changed', (_e, state) => cb(state)); },
});
