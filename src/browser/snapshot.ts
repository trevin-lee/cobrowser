/**
 * Runs INSIDE the page (via `page.evaluate`). Must be fully self-contained — it may
 * only reference in-page globals (document, getComputedStyle, …), never module scope.
 *
 * Spike approach (deliberately simpler than chrome-devtools-mcp's a11y-tree/backend-node
 * model, per the design critique H5): walk the DOM, tag each visible interactive element
 * with a stable `data-cobrowser-uid`, and return an indented text tree of role/label/uid.
 * `BrowserSession.resolveUid` then finds elements by that attribute. uids are re-minted on
 * every snapshot, so they invalidate on any DOM change — the agent must re-snapshot.
 */
export function snapshotScript(): string {
  let counter = 0;
  const lines: string[] = [];
  const INTERACTIVE = new Set(['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'SUMMARY']);

  function isVisible(el: Element): boolean {
    const rect = (el as HTMLElement).getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  }

  function labelFor(el: Element): string {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim().slice(0, 100);
    const el2 = el as HTMLElement;
    if (el2 instanceof HTMLInputElement) {
      return (el2.placeholder || el2.value || el2.name || el2.type || '').slice(0, 100);
    }
    const text = (el2.innerText || el2.textContent || '').trim().replace(/\s+/g, ' ');
    return text.slice(0, 100);
  }

  function roleFor(el: Element): string {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') return 'input:' + ((el as HTMLInputElement).type || 'text');
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    return tag;
  }

  function isInteractive(el: Element): boolean {
    if (INTERACTIVE.has(el.tagName)) return true;
    if (el.hasAttribute('role')) return true;
    if (el.getAttribute('tabindex') === '0') return true;
    if ((el as HTMLElement).onclick != null) return true;
    return false;
  }

  function walk(el: Element, depth: number): void {
    if (depth > 60) return;
    let tagged = false;
    if (isInteractive(el) && isVisible(el)) {
      const uid = String(++counter);
      el.setAttribute('data-cobrowser-uid', uid);
      const label = labelFor(el);
      const indent = '  '.repeat(Math.min(depth, 12));
      lines.push(indent + '[' + uid + '] ' + roleFor(el) + (label ? ' "' + label + '"' : ''));
      tagged = true;
    }
    const children = el.children;
    for (let i = 0; i < children.length; i++) {
      walk(children[i], tagged ? depth + 1 : depth);
    }
  }

  // Clear stale uids from a previous snapshot.
  const stale = document.querySelectorAll('[data-cobrowser-uid]');
  for (let i = 0; i < stale.length; i++) stale[i].removeAttribute('data-cobrowser-uid');

  if (document.body) walk(document.body, 0);
  const title = document.title ? 'Title: ' + document.title + '\n' : '';
  const url = 'URL: ' + location.href + '\n\n';
  return title + url + (lines.join('\n') || '(no interactive elements found)');
}
