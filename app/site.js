// Which saved login belongs to which page. Small, pure, and tested — this is the rule that
// decides whether a password gets typed into a site, so it must not be clever.
//
//  - Real domains match by registrable domain, the way password managers do:
//    signin.costco.com ↔ costco.com. Common two-part public suffixes (co.uk, com.au, …) are
//    handled so bank.co.uk does not match shop.co.uk.
//  - IP addresses and single-label hosts (localhost, nas, printer) match EXACTLY. There is
//    no "domain" to share: 192.168.1.50 and 192.168.2.50 are different machines.
//  - A port saved with the site must match; a site saved without one matches any port.
//    LAN boxes routinely run unrelated services on different ports.

const TWO_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'org.nz', 'net.nz', 'govt.nz',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'com.br', 'net.br', 'org.br', 'gov.br',
  'co.in', 'net.in', 'org.in', 'gov.in',
  'co.za', 'org.za', 'gov.za',
  'com.mx', 'org.mx', 'gob.mx',
  'com.ar', 'com.sg', 'com.hk', 'com.tw', 'com.tr', 'com.cn', 'com.my', 'co.kr', 'co.id', 'co.il',
]);

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;

/** Parse what the user typed or what a page reports into { host, port }. */
function parseSite(input) {
  const s = String(input || '').trim();
  if (!s) return { host: '', port: '' };
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
    return { host: u.hostname.toLowerCase(), port: u.port || '' };
  } catch {
    return { host: s.toLowerCase().replace(/^\[|\]$/g, ''), port: '' };
  }
}

function isIp(host) {
  return IPV4.test(host) || host.includes(':'); // bracket-stripped IPv6 contains colons
}

/** The registrable domain of a real hostname, or the host itself when there is none. */
function registrable(host) {
  if (isIp(host)) return host;
  const labels = host.split('.').filter(Boolean);
  if (labels.length < 2) return host; // localhost, nas, printer
  const lastTwo = labels.slice(-2).join('.');
  if (TWO_PART_SUFFIXES.has(lastTwo) && labels.length >= 3) return labels.slice(-3).join('.');
  return lastTwo;
}

/** Does a saved login (host, port) apply to a page at (host, port)? */
function siteMatches(saved, page) {
  if (!saved.host || !page.host) return false;
  if (saved.port && saved.port !== (page.port || '')) return false;
  if (isIp(saved.host) || isIp(page.host)) return saved.host === page.host;
  if (!saved.host.includes('.') || !page.host.includes('.')) return saved.host === page.host;
  return registrable(saved.host) === registrable(page.host);
}

/** How a site is shown: host, plus the port when one was saved. */
function siteLabel(saved) {
  return saved.port ? `${saved.host}:${saved.port}` : saved.host;
}

module.exports = { parseSite, isIp, registrable, siteMatches, siteLabel, TWO_PART_SUFFIXES };
