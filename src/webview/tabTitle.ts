/**
 * What an editor tab says for a page, the way a browser tab does: the page's title, cut at a
 * fixed length with an ellipsis. VS Code sizes editor tabs to their titles, so an unbounded
 * page title ("Checkout – Review your order and confirm shipping details | Example Store")
 * made a tab as wide as the editor. The full title stays one hover away (the address bar and
 * the sidebar show it), and the agent's tools always see it in full.
 */

/** Roughly what fits in a Chrome tab at its usual width. */
export const DEFAULT_TAB_TITLE_MAX = 30;

/** Titles under this are never cut (a smaller setting would make tabs unreadable). */
const MIN_TAB_TITLE_MAX = 8;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Split into user-perceived characters, so an emoji or accented letter is never cut in half. */
function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

/** The page's title as one line: runs of whitespace and line breaks become one space. */
export function fullTabTitle(title: string, url: string): string {
  const t = title.replace(/\s+/g, ' ').trim();
  if (t) return t;
  if (!url || url === 'about:blank') return 'New Tab';
  // No title: the address without its scheme, as browsers show it ("example.com/path").
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/$/, '') || url;
}

/**
 * The tab label: `fullTabTitle`, cut to at most `max` characters (ellipsis included). A cut
 * never leaves a dangling separator ("Dashboard |…" becomes "Dashboard…"). 0 means no limit.
 */
export function tabLabel(title: string, url: string, max = DEFAULT_TAB_TITLE_MAX): string {
  const full = fullTabTitle(title, url);
  if (!max || max <= 0) return full;
  const limit = Math.max(MIN_TAB_TITLE_MAX, Math.floor(max));
  const chars = graphemes(full);
  if (chars.length <= limit) return full;
  const kept = chars.slice(0, limit - 1).join('').replace(/[\s\-–—|:;,·•/]+$/u, '');
  return `${kept}…`;
}
