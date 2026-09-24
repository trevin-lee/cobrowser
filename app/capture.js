'use strict';
/**
 * What DevTools would show for a tab, kept by the app so the agent can ask for it: console
 * messages and the request log. Fed straight from the tab's own debugger events, so it
 * works without a remote debugging port and without a DevTools window (which would take
 * the tab's debugger session away from us).
 *
 * Deliberately narrow: no request or response bodies, no headers. Bodies carry passwords
 * and headers carry cookies and tokens; status codes, URLs, methods and error strings are
 * what "why isn't this site working" needs.
 */

const MAX_TEXT = 2000;

function describeArg(a) {
  if (!a) return '';
  if (a.value !== undefined) return typeof a.value === 'string' ? a.value : safeJson(a.value);
  if (a.unserializableValue !== undefined) return String(a.unserializableValue);
  if (a.description) return a.description;
  return a.type || '';
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

const LOG_LEVEL = { verbose: 'debug', info: 'info', warning: 'warning', error: 'error' };
const CONSOLE_LEVEL = { log: 'log', debug: 'debug', info: 'info', error: 'error', warning: 'warning', dir: 'log', dirxml: 'log', table: 'log', trace: 'log', clear: 'log', startGroup: 'log', startGroupCollapsed: 'log', endGroup: 'log', assert: 'error', profile: 'log', profileEnd: 'log', count: 'log', timeEnd: 'log' };

class TabLog {
  constructor(limit = 500) {
    this.limit = limit;
    this.seq = 0;
    /** @type {Array<{seq:number,time:string,level:string,text:string,url?:string,line?:number,source?:string,pageUrl:string}>} */
    this.console = [];
    /** @type {Array<{seq:number,requestId:string,time:string,method:string,url:string,type?:string,status?:number,statusText?:string,mimeType?:string,error?:string,fromCache?:boolean,durationMs?:number,pageUrl:string,_start:number}>} */
    this.requests = [];
    this.byRequest = new Map();
  }

  /** Feed one debugger event. `pageUrl` is the tab's URL at the time, so a later reader can
   *  tell which document a message belonged to without the log being wiped on navigation. */
  onEvent(method, params, pageUrl) {
    switch (method) {
      case 'Runtime.consoleAPICalled': {
        const frame = params.stackTrace && params.stackTrace.callFrames && params.stackTrace.callFrames[0];
        this.pushConsole({
          level: CONSOLE_LEVEL[params.type] || 'log',
          text: (params.args || []).map(describeArg).join(' '),
          url: frame ? frame.url : undefined,
          line: frame ? frame.lineNumber + 1 : undefined,
          source: 'console',
        }, pageUrl);
        return;
      }
      case 'Runtime.exceptionThrown': {
        const d = params.exceptionDetails || {};
        this.pushConsole({
          level: 'error',
          text: (d.exception && d.exception.description) || d.text || 'Uncaught exception',
          url: d.url,
          line: typeof d.lineNumber === 'number' ? d.lineNumber + 1 : undefined,
          source: 'exception',
        }, pageUrl);
        return;
      }
      case 'Log.entryAdded': {
        const e = params.entry || {};
        this.pushConsole({
          level: LOG_LEVEL[e.level] || 'log',
          text: e.text || '',
          url: e.url,
          line: typeof e.lineNumber === 'number' ? e.lineNumber + 1 : undefined,
          source: e.source || 'log',
        }, pageUrl);
        return;
      }
      case 'Network.requestWillBeSent': {
        const req = params.request || {};
        if (/^(data|blob):/.test(req.url || '')) return;
        // A redirect reuses the request id: the previous hop is complete with the redirect's
        // status; the new hop is its own row.
        if (params.redirectResponse) {
          const prev = this.byRequest.get(params.requestId);
          if (prev) { prev.status = params.redirectResponse.status; prev.statusText = params.redirectResponse.statusText; prev.durationMs = this.ms(prev, params.timestamp); }
        }
        const row = {
          seq: ++this.seq,
          requestId: params.requestId,
          time: new Date().toISOString(),
          method: req.method || 'GET',
          url: req.url || '',
          type: params.type,
          pageUrl,
          _start: params.timestamp,
        };
        this.requests.push(row);
        this.byRequest.set(params.requestId, row);
        this.trim();
        return;
      }
      case 'Network.responseReceived': {
        const row = this.byRequest.get(params.requestId);
        const res = params.response || {};
        if (!row) return;
        row.status = res.status;
        row.statusText = res.statusText;
        row.mimeType = res.mimeType;
        if (res.fromDiskCache || res.fromServiceWorker || res.fromPrefetchCache) row.fromCache = true;
        return;
      }
      case 'Network.loadingFinished': {
        const row = this.byRequest.get(params.requestId);
        if (row) row.durationMs = this.ms(row, params.timestamp);
        return;
      }
      case 'Network.loadingFailed': {
        const row = this.byRequest.get(params.requestId);
        if (!row) return;
        row.error = params.canceled ? 'canceled' : (params.blockedReason ? `blocked: ${params.blockedReason}` : (params.errorText || 'failed'));
        row.durationMs = this.ms(row, params.timestamp);
        return;
      }
      default:
        return;
    }
  }

  ms(row, ts) {
    return typeof ts === 'number' && typeof row._start === 'number' ? Math.round((ts - row._start) * 1000) : undefined;
  }

  pushConsole(entry, pageUrl) {
    const text = entry.text.length > MAX_TEXT ? entry.text.slice(0, MAX_TEXT) + '…' : entry.text;
    this.console.push({ seq: ++this.seq, time: new Date().toISOString(), ...entry, text, pageUrl });
    this.trim();
  }

  trim() {
    if (this.console.length > this.limit) this.console.splice(0, this.console.length - this.limit);
    if (this.requests.length > this.limit) {
      for (const dropped of this.requests.splice(0, this.requests.length - this.limit)) {
        if (this.byRequest.get(dropped.requestId) === dropped) this.byRequest.delete(dropped.requestId);
      }
    }
  }

  /** Console entries after `since`, newest last, at most `limit`; `level` filters ('error' = errors only). */
  consoleSince(since = 0, { limit = 200, level } = {}) {
    let out = this.console.filter((e) => e.seq > since);
    if (level === 'error') out = out.filter((e) => e.level === 'error');
    else if (level === 'warning') out = out.filter((e) => e.level === 'error' || e.level === 'warning');
    return { entries: out.slice(-limit), latest: this.seq };
  }

  /** Requests after `since`, with the private timing field stripped. */
  requestsSince(since = 0, { limit = 200, failedOnly = false, urlContains, minStatus } = {}) {
    let out = this.requests.filter((r) => r.seq > since);
    if (failedOnly) out = out.filter((r) => r.error || (typeof r.status === 'number' && r.status >= 400));
    if (typeof minStatus === 'number') out = out.filter((r) => typeof r.status === 'number' && r.status >= minStatus);
    if (urlContains) out = out.filter((r) => r.url.includes(urlContains));
    return {
      entries: out.slice(-limit).map(({ _start, ...r }) => r),
      latest: this.seq,
      pending: this.requests.filter((r) => r.status === undefined && !r.error).length,
    };
  }
}

module.exports = { TabLog };
