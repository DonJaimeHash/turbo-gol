/**
 * Cloudflare Turnstile on the client (the anti-bot check in front of POST /api/guest when the
 * server has a sitekey, GET /api/config -> turnstileSiteKey; docs/online/PHASE1.md).
 *
 *   loadTurnstile()  appends https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit
 *                    once (a classic script: no `crossorigin` attribute, so it needs neither CORS
 *                    nor COOP / COEP on the page; the deployed site sends no such headers) and
 *                    resolves with window.turnstile once the script defined it
 *   getToken()       renders an invisible widget (appearance 'interaction-only': it only shows up
 *                    when Cloudflare wants an interaction) into a container, resolves with the
 *                    token from the callback, rejects on error-callback / unsupported / timeout
 *                    (60 s) / abort, and always removes the widget again (turnstile.remove);
 *                    `onInteractive` says when Cloudflare wants an interaction (the widget shows)
 *                    and when that is over (before / after-interactive-callback)
 *
 * The loader is injectable (`load` in getToken's options) so the flow runs in node tests with a
 * fake API. Nothing here touches `window` / `document` at module level.
 *
 * Note for dev: the Vite dev server sends Cross-Origin-Embedder-Policy: require-corp; the
 * challenge iframe may be refused under that policy. Local dev never has a sitekey (wrangler dev
 * answers turnstileSiteKey null), so the widget is only rendered on the deployed site.
 */

export const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
/** The script tag is given this long to define window.turnstile. */
export const TURNSTILE_LOAD_TIMEOUT_MS = 20_000;
/** A challenge that produced no token within this time is abandoned. */
export const TURNSTILE_TOKEN_TIMEOUT_MS = 60_000;
/** Name of the global callback api.js invokes once it is ready (?onload=). */
const ONLOAD_CALLBACK = '__turbogolTurnstileOnload';

// ---- Minimal typing of the Turnstile API (https://developers.cloudflare.com/turnstile/) -------

export interface TurnstileRenderOptions {
  sitekey: string;
  theme?: 'light' | 'dark' | 'auto';
  size?: 'normal' | 'compact' | 'flexible';
  appearance?: 'always' | 'execute' | 'interaction-only';
  /** Free-form label (<= 32 chars) echoed in the siteverify result. */
  action?: string;
  callback?: (token: string) => void;
  /** Returning true tells Turnstile the error was handled (no console output). */
  'error-callback'?: (code: string) => boolean | undefined;
  'expired-callback'?: () => void;
  'timeout-callback'?: () => void;
  'unsupported-callback'?: () => void;
  /** The challenge needs the player (the widget shows) / no longer. */
  'before-interactive-callback'?: () => void;
  'after-interactive-callback'?: () => void;
}

export interface TurnstileApi {
  /** Returns the widget id, or undefined when the widget could not be rendered. */
  render(container: HTMLElement | string, options: TurnstileRenderOptions): string | undefined;
  remove(widgetId: string): void;
  reset(widgetId?: string): void;
}

export type TurnstileLoader = () => Promise<TurnstileApi>;

export interface GetTokenOptions {
  /** Script loader (loadTurnstile by default; a fake in tests). */
  load?: TurnstileLoader;
  /** Cancels the challenge (the widget is removed, the promise rejects with 'turnstile cancelled'). */
  signal?: AbortSignal;
  timeoutMs?: number;
  action?: string;
  /** Cloudflare wants an interaction (true) / no longer (false: answered, or the challenge ended). */
  onInteractive?: (on: boolean) => void;
}

interface TurnstileGlobals {
  turnstile?: TurnstileApi;
  [ONLOAD_CALLBACK]?: () => void;
}

function globals(): TurnstileGlobals {
  return globalThis as unknown as TurnstileGlobals;
}

/** window.turnstile when api.js already ran (page-level script tag or an earlier load). */
export function turnstileApi(): TurnstileApi | null {
  const t = globals().turnstile;
  return t !== undefined && typeof t.render === 'function' ? t : null;
}

let loading: Promise<TurnstileApi> | null = null;

/**
 * Append the Turnstile script once and resolve with the API. A failed / timed-out load rejects
 * and forgets the attempt, so the next call tries again.
 */
export function loadTurnstile(): Promise<TurnstileApi> {
  const ready = turnstileApi();
  if (ready !== null) return Promise.resolve(ready);
  if (loading !== null) return loading;
  if (typeof document === 'undefined') return Promise.reject(new Error('turnstile needs a document'));
  const p = new Promise<TurnstileApi>((resolve, reject) => {
    let settled = false;
    const script = document.createElement('script');
    const finish = (api: TurnstileApi | null, message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Left as a function: api.js loads its own versioned script and calls it after this resolved
      // (deleted, Cloudflare warned "Unable to find onload callback" twice on every page).
      globals()[ONLOAD_CALLBACK] = () => undefined;
      if (api !== null) {
        resolve(api);
        return;
      }
      loading = null;
      script.remove();
      reject(new Error(message));
    };
    const tryResolve = (): void => {
      const api = turnstileApi();
      if (api !== null) finish(api, '');
    };
    const timer = setTimeout(() => finish(null, 'turnstile script did not initialise'), TURNSTILE_LOAD_TIMEOUT_MS);
    globals()[ONLOAD_CALLBACK] = tryResolve;
    script.src = `${TURNSTILE_SCRIPT_URL}?render=explicit&onload=${ONLOAD_CALLBACK}`;
    script.async = true;
    script.defer = true;
    // With render=explicit the global exists as soon as the script ran; the onload callback above
    // covers builds that define it later.
    script.onload = tryResolve;
    script.onerror = () => finish(null, 'turnstile script failed to load');
    (document.head ?? document.documentElement).appendChild(script);
  });
  loading = p;
  return p;
}

/**
 * Run one challenge for `siteKey` inside `container` (unhidden while the widget lives, hidden
 * again afterwards) and resolve with the token. The widget is removed on every exit.
 */
export function getToken(siteKey: string, container: HTMLElement, opts: GetTokenOptions = {}): Promise<string> {
  const load = opts.load ?? loadTurnstile;
  const timeoutMs = opts.timeoutMs ?? TURNSTILE_TOKEN_TIMEOUT_MS;
  const signal = opts.signal;
  if (signal !== undefined && signal.aborted) return Promise.reject(new Error('turnstile cancelled'));
  return load().then(
    (api) =>
      new Promise<string>((resolve, reject) => {
        let widgetId: string | undefined;
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let interactive = false;
        const setInteractive = (on: boolean): void => {
          if (on === interactive) return;
          interactive = on;
          opts.onInteractive?.(on);
        };
        const onAbort = (): void => finish('', 'turnstile cancelled');
        const finish = (token: string, message: string): void => {
          if (settled) return;
          settled = true;
          if (timer !== null) clearTimeout(timer);
          if (signal !== undefined) signal.removeEventListener('abort', onAbort);
          setInteractive(false);
          if (widgetId !== undefined) {
            try {
              api.remove(widgetId);
            } catch {
              /* already gone */
            }
          }
          container.hidden = true;
          if (token.length > 0) resolve(token);
          else reject(new Error(message));
        };
        if (signal !== undefined) {
          if (signal.aborted) {
            finish('', 'turnstile cancelled');
            return;
          }
          signal.addEventListener('abort', onAbort);
        }
        timer = setTimeout(() => finish('', 'turnstile timeout'), timeoutMs);
        container.hidden = false;
        try {
          widgetId = api.render(container, {
            sitekey: siteKey,
            theme: 'dark',
            size: 'normal',
            appearance: 'interaction-only',
            action: opts.action ?? 'guest',
            callback: (token) => finish(typeof token === 'string' && token.length > 0 ? token : '', 'turnstile empty token'),
            'error-callback': (code) => {
              finish('', `turnstile error ${code}`);
              return true;
            },
            'expired-callback': () => finish('', 'turnstile token expired'),
            'timeout-callback': () => finish('', 'turnstile timeout'),
            'unsupported-callback': () => finish('', 'turnstile unsupported browser'),
            'before-interactive-callback': () => {
              if (!settled) setInteractive(true);
            },
            'after-interactive-callback': () => setInteractive(false),
          });
        } catch (err) {
          finish('', `turnstile render failed: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        if (widgetId === undefined) {
          finish('', 'turnstile render failed');
          return;
        }
        // A callback that fired synchronously inside render() ran before widgetId was known.
        if (settled) {
          try {
            api.remove(widgetId);
          } catch {
            /* already gone */
          }
        }
      }),
  );
}
