/**
 * What the human typed in the address bar, as a URL to load: an address when it looks like
 * one, a web search otherwise ("Search or enter address", as every browser does).
 *
 *  - With a scheme (https://…, about:blank, data:…): as typed.
 *  - Local addresses (localhost, *.localhost, *.local, an IP address, or name:port) get
 *    http://. Development servers and devices on the network rarely speak HTTPS, and
 *    https://localhost:3000 fails with a protocol error.
 *  - A domain (it has a dot and no spaces): https://.
 *  - Anything else (words, a single word): a search.
 */
export const SEARCH_URL = 'https://www.google.com/search?q=';

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const BARE_SCHEME = /^(about|data|file|mailto|view-source|chrome):/i;
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;

export function resolveAddress(typed: string): string {
  const text = typed.trim();
  if (!text) return '';
  if (SCHEME.test(text) || BARE_SCHEME.test(text)) return text;
  if (/\s/.test(text)) return SEARCH_URL + encodeURIComponent(text);

  // host[:port], up to the first / ? or #
  const hostPort = text.split(/[/?#]/, 1)[0];
  const bracketed = /^\[[0-9a-f:.]+\](:\d+)?$/i.test(hostPort); // [::1]:8080
  const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(hostPort);
  if (!bracketed && !m) return SEARCH_URL + encodeURIComponent(text);
  const host = bracketed ? '' : m![1].toLowerCase();
  const port = bracketed ? '' : m![2] ?? '';

  const local = bracketed || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || IPV4.test(host);
  if (local) return 'http://' + text;
  if (!/^[a-z0-9.-]+$/i.test(host) || host.startsWith('.') || host.endsWith('.')) return SEARCH_URL + encodeURIComponent(text);
  if (!host.includes('.')) return port ? 'http://' + text : SEARCH_URL + encodeURIComponent(text); // nas:5000, or a word
  return 'https://' + text;
}
