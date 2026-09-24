/**
 * Scripts that run INSIDE the page (shipped as source through AppPage.evaluate). Each must be
 * fully self-contained: in-page globals only (document, getComputedStyle, …), never module
 * scope.
 *
 * Two reads, for two jobs:
 *   - snapshotScript: what the agent can ACT on — visible interactive elements, each tagged
 *     with a uid click/fill resolve. uids are STABLE: an element keeps its uid for as long as
 *     it exists, so the agent does not need to re-snapshot after every action.
 *   - readPageScript: what the page SAYS — its visible text (and optionally its links), far
 *     cheaper than a snapshot when the agent only needs to read.
 */

export interface SnapshotOptions {
  /** Only elements inside the first match of this CSS selector. */
  withinSelector?: string;
  /** Only elements whose label contains this, case-insensitively. A query containing "/"
   *  matches link destinations instead ("/orders/" finds every order link). */
  textContains?: string;
  /** Only this role, e.g. "button", "link", "input" (any input type) or "input:checkbox". */
  role?: string;
  /** Drop elements with no label (icon-only buttons), counting how many were dropped. */
  labeledOnly?: boolean;
  /** At most this many elements (default 200). */
  limit?: number;
  /** The first uid to mint on a fresh document, so uids never repeat within a tab. */
  seqStart?: number;
}

export interface SnapshotResult {
  text: string;
  /** The highest uid minted, for the next snapshot's seqStart. */
  seq: number;
}

export function snapshotScript(opts: SnapshotOptions): SnapshotResult {
  const o = opts || {};
  const limit = o.limit && o.limit > 0 ? Math.floor(o.limit) : 200;
  const want = o.textContains ? String(o.textContains).toLowerCase() : '';
  const lines: string[] = [];
  let matched = 0;
  let skippedUnlabeled = 0;

  // uids live in the element's own attribute: an element keeps its uid for as long as it
  // exists. A clone of a tagged node copies the attribute, so a uid seen twice in one pass
  // is re-minted for the second element.
  let seq = o.seqStart || 0;
  const existing = document.querySelectorAll('[data-cobrowser-uid]');
  for (let i = 0; i < existing.length; i++) {
    const n = Number(existing[i].getAttribute('data-cobrowser-uid'));
    if (n > seq) seq = n;
  }
  const seen = new Set<string>();

  const INTERACTIVE = new Set(['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'SUMMARY']);
  const ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'switch', 'textbox', 'combobox', 'searchbox', 'slider', 'spinbutton', 'treeitem']);

  const clip = (t: string, n: number): string => (t.length > n ? t.slice(0, n - 1) + '…' : t);
  const clean = (t: string | null | undefined): string => clip(String(t || '').replace(/\s+/g, ' ').trim(), 100);

  function isVisible(el: Element): boolean {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  }

  function isInteractive(el: Element): boolean {
    if (INTERACTIVE.has(el.tagName)) return el.tagName !== 'A' || el.hasAttribute('href') || el.hasAttribute('role');
    const role = el.getAttribute('role');
    if (role && ROLES.has(role)) return true;
    if ((el as HTMLElement).isContentEditable && el.getAttribute('contenteditable') !== null) return true;
    const tab = el.getAttribute('tabindex');
    if (tab !== null && Number(tab) >= 0) return true;
    return (el as HTMLElement).onclick != null;
  }

  function labelFor(el: Element): string {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return clean(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => (document.getElementById(id) as HTMLElement | null)?.innerText || '').join(' ');
      if (t.trim()) return clean(t);
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      const lab = el.labels && el.labels[0] ? el.labels[0].innerText : '';
      if (lab.trim()) return clean(lab);
      const ph = el.getAttribute('placeholder');
      if (ph) return clean(ph);
      // A button-type input's value IS its caption. Never any other input's value: that is
      // what the user (or the vault) typed — a password field's included.
      if (el instanceof HTMLInputElement && /^(submit|button|reset)$/.test(el.type) && el.value) return clean(el.value);
      return clean(el.getAttribute('title') || el.getAttribute('name') || '');
    }
    const text = (el as HTMLElement).innerText || el.textContent || '';
    if (text.trim()) return clean(text);
    const img = el.querySelector('img[alt]');
    return clean(el.getAttribute('title') || (img ? img.getAttribute('alt') : '') || '');
  }

  function roleFor(el: Element): string {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'input') return 'input:' + ((el as HTMLInputElement).type || 'text');
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if ((el as HTMLElement).isContentEditable) return 'textbox';
    return tag;
  }

  const origin = location.origin;
  function extras(el: Element): string {
    const parts: string[] = [];
    if (el instanceof HTMLAnchorElement && el.href) {
      // The destination: twenty identical "View order" links can be opened directly.
      parts.push('→ ' + (el.href.startsWith(origin + '/') ? el.href.slice(origin.length) : clip(el.href, 160)));
    }
    if (el instanceof HTMLInputElement) {
      if (el.type === 'checkbox' || el.type === 'radio') parts.push(el.checked ? '[checked]' : '[unchecked]');
      else if (el.type === 'password') { if (el.value) parts.push('(filled)'); }
      else if (!/^(submit|button|reset|image|file|hidden)$/.test(el.type) && el.value) parts.push('value="' + clip(el.value, 60) + '"');
    }
    if (el instanceof HTMLTextAreaElement && el.value) parts.push('value="' + clip(el.value.replace(/\s+/g, ' '), 60) + '"');
    if (el instanceof HTMLSelectElement) {
      const all = Array.from(el.options);
      const shown = all.slice(0, 25).map((op) => (op.selected ? '*' : '') + clip(op.text.trim(), 40));
      parts.push('options: ' + shown.join(' | ') + (all.length > 25 ? ' | …' + (all.length - 25) + ' more' : ''));
    }
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') parts.push('(disabled)');
    const expanded = el.getAttribute('aria-expanded');
    if (expanded) parts.push(expanded === 'true' ? '(expanded)' : '(collapsed)');
    return parts.length ? ' ' + parts.join(' ') : '';
  }

  function walk(el: Element, depth: number): void {
    if (depth > 60) return;
    let tagged = false;
    if (isInteractive(el) && isVisible(el)) {
      const label = labelFor(el);
      const role = roleFor(el);
      let pass = true;
      if (o.labeledOnly && !label) { skippedUnlabeled++; pass = false; }
      if (pass && want) {
        pass = want.includes('/')
          ? el instanceof HTMLAnchorElement && el.href.toLowerCase().includes(want)
          : label.toLowerCase().includes(want);
      }
      if (pass && o.role) pass = role === o.role || role.split(':')[0] === o.role;
      if (pass) {
        matched++;
        if (matched <= limit) {
          let uid = el.getAttribute('data-cobrowser-uid');
          if (!uid || seen.has(uid)) {
            uid = String(++seq);
            el.setAttribute('data-cobrowser-uid', uid);
          }
          seen.add(uid);
          lines.push('  '.repeat(Math.min(depth, 8)) + '[' + uid + '] ' + role + (label ? ' "' + label + '"' : '') + extras(el));
          tagged = true;
        }
      }
    }
    const next = tagged ? depth + 1 : depth;
    for (let i = 0; i < el.children.length; i++) walk(el.children[i], next);
    // Sites built from web components keep their controls in open shadow roots.
    if (el.shadowRoot) for (let i = 0; i < el.shadowRoot.children.length; i++) walk(el.shadowRoot.children[i], next);
  }

  const root = o.withinSelector ? document.querySelector(o.withinSelector) : document.body;
  const head = (document.title ? 'Title: ' + document.title + '\n' : '') + 'URL: ' + location.href + '\n';
  if (!root) return { text: head + '\nwithinSelector matched nothing: ' + o.withinSelector, seq };
  walk(root, 0);

  const notes: string[] = [];
  if (matched > limit) notes.push('…' + (matched - limit) + ' more elements not shown — narrow with withinSelector / textContains / role, or raise limit.');
  if (skippedUnlabeled) notes.push(skippedUnlabeled + ' unlabeled element(s) left out (labeledOnly).');
  const body = lines.length ? lines.join('\n') : '(no matching interactive elements)';
  return { text: head + '\n' + body + (notes.length ? '\n\n' + notes.join('\n') : ''), seq };
}

export interface ReadPageOptions {
  /** Only the text inside the first match of this CSS selector. */
  withinSelector?: string;
  /** Truncate the text at this many characters (default 12000). */
  maxChars?: number;
  /** Also list the links (text and destination), deduplicated, up to 150. */
  links?: boolean;
}

export interface ReadPageResult {
  title: string;
  url: string;
  text: string;
  truncated?: { shown: number; total: number };
  links?: { text: string; href: string }[];
  error?: string;
}

export function readPageScript(opts: ReadPageOptions): ReadPageResult {
  const o = opts || {};
  const base = { title: document.title, url: location.href };
  const root = (o.withinSelector ? document.querySelector(o.withinSelector) : document.body) as HTMLElement | null;
  if (!root) return { ...base, text: '', error: 'withinSelector matched nothing: ' + o.withinSelector };
  const max = o.maxChars && o.maxChars > 0 ? Math.floor(o.maxChars) : 12000;
  const full = (root.innerText || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const out: ReadPageResult = { ...base, text: full.length > max ? full.slice(0, max) : full };
  if (full.length > max) out.truncated = { shown: max, total: full.length };
  if (o.links) {
    const seen = new Set<string>();
    const links: { text: string; href: string }[] = [];
    const anchors = root.querySelectorAll('a[href]');
    for (let i = 0; i < anchors.length && links.length < 150; i++) {
      const a = anchors[i] as HTMLAnchorElement;
      if (!a.href || seen.has(a.href) || /^javascript:/i.test(a.href)) continue;
      const r = a.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      seen.add(a.href);
      const text = (a.innerText || a.getAttribute('aria-label') || a.title || '').replace(/\s+/g, ' ').trim();
      links.push({ text: text.length > 80 ? text.slice(0, 79) + '…' : text, href: a.href });
    }
    out.links = links;
  }
  return out;
}

/**
 * In-page source for `find(selector)`: every match in the document, or — when there is none
 * at the top level — in open shadow roots. Composed into the scripts that resolve a uid or a
 * selector, so elements a snapshot found inside web components can be acted on too.
 */
export const FIND_JS = `const find = (sel) => {
  const top = Array.from(document.querySelectorAll(sel));
  if (top.length) return top;
  const out = [];
  const visit = (root, depth) => {
    for (const el of root.querySelectorAll('*')) {
      if (!el.shadowRoot) continue;
      out.push(...el.shadowRoot.querySelectorAll(sel));
      if (depth < 8) visit(el.shadowRoot, depth + 1);
    }
  };
  visit(document, 0);
  return out;
};`;
