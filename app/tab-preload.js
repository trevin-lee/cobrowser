'use strict';
/**
 * Runs in every frame of every tab: sandboxed, in the isolated world, before page scripts.
 *
 * Page dialogs (alert, confirm, prompt) are answered by the app. Chromium's own dialog is a
 * sheet on the tab's window, and a tab's window is hidden and offscreen: showing the sheet
 * pulled a blank browser-sized window onto the desktop and froze the tab until it was found.
 * The page keeps the same functions, wrapped in Proxies over the native ones (they still read
 * as native code), and no global is added — the bridge is handed in as an argument.
 */
const { contextBridge, ipcRenderer } = require('electron');

const ask = (type, message, def) =>
  ipcRenderer.sendSync('cobrowser:dialog', {
    type,
    message: message === undefined ? '' : String(message),
    def: def === undefined ? '' : String(def),
  });

try {
  contextBridge.executeInMainWorld({
    func: (answer) => {
      for (const type of ['alert', 'confirm', 'prompt']) {
        const native = window[type];
        if (typeof native !== 'function') continue;
        window[type] = new Proxy(native, { apply: (_target, _self, args) => answer(type, args[0], args[1]) });
      }
    },
    args: [ask],
  });
} catch {
  /* no main world to reach (an unusual frame): the native dialog remains */
}
