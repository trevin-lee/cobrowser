// Preload for the vault window: the only bridge between its page and the app. Nothing here
// returns a password to the page — the list carries hosts and usernames.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vault', {
  list: () => ipcRenderer.invoke('vault:list'),
  add: (host, username, password, scope) => ipcRenderer.invoke('vault:add', { host, username, password, scope }),
  setScope: (host, username, scope) => ipcRenderer.invoke('vault:setScope', { host, username, scope }),
  workspaces: () => ipcRenderer.invoke('vault:workspaces'),
  remove: (host, username) => ipcRenderer.invoke('vault:remove', { host, username }),
  // The one call that returns a password — the app demands a fresh Touch ID for it every time.
  reveal: (host, username) => ipcRenderer.invoke('vault:reveal', { host, username }),
  importCsv: (scope) => ipcRenderer.invoke('vault:importCsv', { scope }),
  lock: () => ipcRenderer.invoke('vault:lock'),
});
