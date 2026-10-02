// Preload for the vault window: the only bridge between its page and the app. Nothing here
// returns a password to the page — the list carries hosts and usernames.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vault', {
  list: () => ipcRenderer.invoke('vault:list'),
  add: (host, username, password, scope, also) => ipcRenderer.invoke('vault:add', { host, username, password, scope, also }),
  setScope: (host, username, scope) => ipcRenderer.invoke('vault:setScope', { host, username, scope }),
  workspaces: () => ipcRenderer.invoke('vault:workspaces'),
  remove: (host, username) => ipcRenderer.invoke('vault:remove', { host, username }),
  // The one call that returns a password — the app demands a fresh Touch ID for it every time.
  reveal: (host, username) => ipcRenderer.invoke('vault:reveal', { host, username }),
  importCsv: (scope) => ipcRenderer.invoke('vault:importCsv', { scope }),
  update: (from, fields) => ipcRenderer.invoke('vault:update', { from, ...fields }),
  exportCsv: () => ipcRenderer.invoke('vault:exportCsv'),
  lock: () => ipcRenderer.invoke('vault:lock'),
  // Cards: the number and code go in, never come back out (lists carry the last four digits).
  cards: () => ipcRenderer.invoke('vault:cards'),
  addCard: (fields) => ipcRenderer.invoke('vault:addCard', fields),
  updateCard: (id, fields) => ipcRenderer.invoke('vault:updateCard', { id, ...fields }),
  removeCard: (id) => ipcRenderer.invoke('vault:removeCard', { id }),
});
