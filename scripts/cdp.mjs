// A headless Chrome or Edge driven over the DevTools protocol with Node's own WebSocket (no
// dependency), shared by the page checks: scripts/ui-fit.mjs (the layout check) and
// scripts/play-timing.mjs (one press to a match). The browser, a free port, a server that answers,
// and one page session.
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The browser to drive: `explicit` (a --browser option), UI_FIT_BROWSER, else Chrome or Edge where they install. */
export function findBrowser(explicit) {
  const env = typeof explicit === 'string' ? explicit : process.env.UI_FIT_BROWSER;
  if (env) return env;
  const candidates =
    process.platform === 'win32'
      ? ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe']
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error('no Chrome / Edge found: pass --browser <path> or set UI_FIT_BROWSER');
  return hit;
}

/** A TCP port nothing listens on (the OS picks it). */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** True once `url` answers 2xx, false after `ms`. */
export async function waitHttp(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  return false;
}

/** One CDP page session. */
export class Page {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    /** Handlers of CDP events by method (on). */
    this.handlers = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id === undefined) {
        for (const fn of this.handlers.get(m.method) ?? []) fn(m.params);
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(JSON.stringify(m.error)));
      else p.resolve(m.result);
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  /** A CDP event (its domain enabled first: Runtime.consoleAPICalled...). */
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  }
  /** The faces the platform used for the text of the first element matching `selector` (CSS.getPlatformFontsForNode). */
  async fonts(selector) {
    try {
      const { root } = await this.send('DOM.getDocument', { depth: 0 });
      const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector });
      if (!nodeId) return '?';
      const { fonts } = await this.send('CSS.getPlatformFontsForNode', { nodeId });
      return fonts.map((f) => f.familyName + (f.isCustomFont ? ' (web font)' : '')).join(', ') || '?';
    } catch {
      return '?';
    }
  }
  /** True once `expression` is truthy (polled every `every` ms), false after `ms`. */
  async until(expression, ms, every = 300) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try {
        if (await this.eval(`!!(${expression})`)) return true;
      } catch {
        /* navigating */
      }
      await sleep(every);
    }
    return false;
  }
}
