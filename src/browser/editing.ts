/**
 * The human's edit keys in the panel: copy, cut, undo and redo. An offscreen page has no Edit
 * menu, which is what turns ⌘Z or ⌘X into an editing command in a normal browser window, so a
 * forwarded keystroke reaches the page as a bare key and nothing happens. These send the
 * keystroke WITH the browser's own editing command (Input.dispatchKeyEvent `commands`), which
 * runs unless the page handles the key itself, as it would in Chrome.
 *
 * The clipboard goes through the editor (vscode.env.clipboard), so the caller passes the text
 * to copy or cut on; nothing here touches it.
 */

/** Send one DevTools-protocol command through the human's input route. */
export type Send = (method: string, params?: unknown) => Promise<unknown>;

/**
 * In-page: the text the human has selected and whether it can be cut. window.getSelection()
 * does not see a selection inside an input or a textarea, so the focused field is read
 * first, through open shadow roots. A password field yields nothing, as in any browser.
 */
export const SELECTION_JS = `(() => {
  let a = document.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  if (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) {
    if (a instanceof HTMLInputElement && a.type === 'password') return { text: '', editable: false };
    let s = null, e = null;
    try { s = a.selectionStart; e = a.selectionEnd; } catch (_) { /* types without a selection */ }
    if (s !== null && e !== null && s !== e) return { text: a.value.slice(s, e), editable: !a.readOnly && !a.disabled };
  }
  const text = String(window.getSelection() || '');
  return { text, editable: !!text && !!(a && a.isContentEditable) };
})()`;

export interface Selection {
  text: string;
  /** In a field the human can type in, so cutting removes it. */
  editable: boolean;
}

type EditKey = 'undo' | 'redo' | 'cut';

/** ⌘ on macOS (4), plus Shift (8) for redo, as the page would see the keystroke. */
const KEYS: Record<EditKey, { key: string; code: string; vk: number; modifiers: number; command: string }> = {
  undo: { key: 'z', code: 'KeyZ', vk: 90, modifiers: 4, command: 'undo' },
  redo: { key: 'z', code: 'KeyZ', vk: 90, modifiers: 4 | 8, command: 'redo' },
  // The text is already on the editor's clipboard; the command only removes it from the field.
  cut: { key: 'x', code: 'KeyX', vk: 88, modifiers: 4, command: 'deleteBackward' },
};

/** Press an edit key in the page: the keystroke the page sees, carrying the editing command. */
export async function pressEditKey(send: Send, which: EditKey): Promise<void> {
  const k = KEYS[which];
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, modifiers: k.modifiers };
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, commands: [k.command] });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}
