/**
 * The TV's sign-in with the phone (plan PR 14, dir-hub §6.15), both ends.
 *
 * The TV (openTvSignIn, from PERFIL's tile on a TV): a sheet with the code in Display 44, its QR
 * (components/qr.ts: the /tv link with the code in the hash) and "Go to turbo-gol.com/tv with your
 * account signed in and enter this code", the time left; it polls (AccountClient.tvPoll) while it is
 * up and, approved, closes and signs in (signInWith after the close: the return with intent of
 * modes.ts, Ajustes' EXPERIMENTAL, runs on the change). Expired (or used), the sheet says so with
 * NUEVO CÓDIGO; CANCELAR is always there. Each state is a sheet of its own (Menu.modal replaces it,
 * the opener kept).
 *
 * The phone (installTvLink): the /tv page is the game with these sheets over Inicio. The path goes
 * back to / at once (a reload is the game). It waits for its turn (Game.ts urlSheets: an OAuth
 * result and its confirm sheet first). Signed out: "Sign in on this phone first" with ENTRAR CON
 * {provider} and INICIAR SESIÓN (PERFIL); a marker { at } waits in sessionStorage (30 minutes, never
 * the code), so any sign-in (a provider's round trip, the confirm sheet, PERFIL) comes back to the
 * code entry; CANCELAR or Back there forgets it. Signed in: the code
 * cells, always empty: the code the TV in front of you shows is typed, never taken from the link
 * (Security 3: a link, or a QR, can come from anyone, and one tap on it would sign their TV in).
 * Then "Sign in on the TV as {name}?" with the code big, where that TV is (country, city and
 * network at its start: POST /api/auth/tv/info), a warning when it is in another country, and
 * CONFIRMAR / CANCELAR: nothing is granted before CONFIRMAR. A refusal says why in words (wrong,
 * expired, used, too many tries, a suspended account) with OTRO CÓDIGO when another code can help.
 * In development (or a VITE_UI_FIT=1 build) window.__tvSignIn shows each sheet with sample data
 * (screens/tvSignInSamples.ts, scripts/ui-fit.mjs).
 */
import { h } from '../dom';
import { AccountError } from '../../net/AccountClient';
import type { TvInfoAnswer, TvStartAnswer } from '../../net/account';
import type { Menu } from '../Menu';
import type { SheetSpec } from '../components/sheet';
import { qrSvg } from '../components/qr';
import { codeCells } from '../components/codecells';
import { CODE_LENGTH, spacedCode } from './lobbyModel';
import { isTvPath, pendingMarker, timeLeft, tvContinuation, tvDeadline, tvLink, tvPlace, tvShortLink, withoutTvCode } from './tvSignInModel';
import { errText } from './profile';
import { providerName } from './accountLinks';
import type { OAuthProvider } from '../../net/account';
import { STORAGE_PREFIX } from '../../brand';
import { t } from '../../i18n';

/**
 * A TV sheet's state: asking for a code, showing one (`s`, ending at `until` on performance.now()'s
 * clock: tvDeadline), expired, or a failed start (`error`).
 */
export type TvSheet = { kind: 'starting' } | { kind: 'code'; s: TvStartAnswer; until: number } | { kind: 'expired' } | { kind: 'failed'; error: string };

/**
 * The TV's sheet of `state` (`sample`: no server, nothing polled: the layout check). `again`: NUEVO
 * CÓDIGO; `onClose`: the sheet went (CANCELAR, Back, the menus hiding), not replaced by the next state.
 */
export function tvSheet(menu: Menu, state: TvSheet, again: () => void, onClose: () => void): { left: HTMLElement | null; close: () => void } {
  const cancel = { label: t('tvsign.cancel'), onClick: () => true };
  const fresh = { label: t('tvsign.newCode'), primary: true, onClick: () => (queueMicrotask(again), false) };
  let left: HTMLElement | null = null;
  let body: HTMLElement;
  if (state.kind === 'code') {
    const link = tvLink(location.origin, state.s.code);
    left = h('span.mn-tvsign-left', null, t('tvsign.expiresIn', { time: timeLeft(state.until, performance.now()) }));
    body = h(
      'div.mn-sala-qr.mn-tvsign',
      null,
      qrSvg(link, t('tvsign.qr')),
      h('div.mn-sala-qr-text', null, h('b.mn-sala-qr-code', null, spacedCode(state.s.code)), h('span.mn-tvsign-line', null, t('tvsign.line', { link: tvShortLink(location.origin) })), left),
    );
  } else {
    const text = state.kind === 'starting' ? t('tvsign.starting') : state.kind === 'expired' ? t('tvsign.expired') : state.error;
    body = h('p.mn-tvsign-state', null, text);
  }
  const spec: SheetSpec = { title: t('tvsign.title'), body, actions: state.kind === 'expired' || state.kind === 'failed' ? [fresh, cancel] : [cancel], onClose };
  return { left, close: menu.modal(spec) };
}

/** PERFIL's tile on a TV: the sheet, a code from the server, polled until the phone answers. */
export function openTvSignIn(menu: Menu): void {
  const acc = menu.host.accounts;
  /** The sheet in hand (bumped on every new state, and when it closes): older timers and answers stop. */
  let epoch = 0;
  let timer = 0;
  let tick = 0;
  const stop = (): void => {
    window.clearTimeout(timer);
    window.clearInterval(tick);
  };
  const show = (state: TvSheet): { left: HTMLElement | null; close: () => void } => {
    stop();
    const mine = ++epoch;
    return tvSheet(menu, state, start, () => {
      if (epoch !== mine) return; // replaced by the next state
      epoch++;
      stop();
    });
  };
  const start = (): void => {
    show({ kind: 'starting' });
    const mine = epoch;
    acc.tvStart().then(
      (s) => {
        if (epoch !== mine) return;
        const until = tvDeadline(s.ttlMs, performance.now());
        const { left, close } = show({ kind: 'code', s, until });
        const at = epoch;
        tick = window.setInterval(() => {
          const now = performance.now();
          if (now >= until) show({ kind: 'expired' });
          else if (left !== null) left.textContent = t('tvsign.expiresIn', { time: timeLeft(until, now) });
        }, 1000);
        const poll = async (): Promise<void> => {
          if (epoch !== at) return;
          try {
            const r = await acc.tvPoll(s.code, s.secret);
            if (epoch !== at) return;
            if (r.state === 'approved') {
              epoch++;
              stop();
              close(); // the sheet first: the return with intent then pops PERFIL, not the sheet
              const a = acc.signInWith(r);
              menu.toast(t('profile.hello', { name: a.name }), 'ok');
              void acc.fetchMe().catch(() => undefined);
              return;
            }
          } catch (e) {
            if (epoch !== at) return;
            if (e instanceof AccountError && (e.code === 'tv_code_expired' || e.code === 'tv_code_used' || e.code === 'bad_secret')) {
              show({ kind: 'expired' });
              return;
            }
            if (e instanceof AccountError && e.code === 'banned') {
              show({ kind: 'failed', error: errText(e) });
              return;
            }
            // Offline, a refusal of the moment (429): the next poll asks again.
          }
          timer = window.setTimeout(() => void poll(), s.pollMs);
        };
        timer = window.setTimeout(() => void poll(), s.pollMs);
      },
      (e: unknown) => {
        if (epoch === mine) show({ kind: 'failed', error: errText(e) });
      },
    );
  };
  start();
}

// ---- the phone's /tv page ---------------------------------------------------------------------

const PENDING_KEY = STORAGE_PREFIX + 'tvcode';

/** "A TV waits for this phone" (sessionStorage { at }, 30 minutes): never the code, which is typed (A6). */
function keep(): void {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ at: Date.now() }));
  } catch {
    /* private mode: the wait lasts this page */
  }
}

function forget(): void {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* nothing kept */
  }
}

function kept(): boolean {
  try {
    return pendingMarker(sessionStorage.getItem(PENDING_KEY), Date.now());
  } catch {
    return false;
  }
}

/**
 * Signed out: sign in on this phone first, right here (the design's §3.11 step 3): ENTRAR CON
 * {provider} for each configured provider (a round trip, the confirm sheet when the account is
 * new) or INICIAR SESIÓN (PERFIL). The marker waits for whichever comes back. CANCELAR or Back:
 * `drop`.
 */
export function signInFirstSheet(menu: Menu, drop: () => void): void {
  let signIn = false;
  const acc = menu.host.accounts;
  const providers = ((menu.cfg?.oauth ?? []) as OAuthProvider[]).filter((p) => p === 'google' || p === 'discord');
  menu.modal({
    title: t('tvlink.title'),
    body: h('p', null, t('tvlink.signInFirst')),
    actions: [
      ...providers.map((p, i) => ({
        label: t('tvlink.signInWith', { provider: providerName(p).toUpperCase() }),
        primary: i === 0,
        onClick: () => {
          signIn = true;
          keep();
          window.location.href = acc.oauthUrl(p);
          return false;
        },
      })),
      {
        label: t('tvlink.signIn'),
        primary: providers.length === 0,
        onClick: () => {
          signIn = true;
          keep();
          queueMicrotask(() => menu.open('profile'));
          return true;
        },
      },
      { label: t('tvlink.cancel'), onClick: () => true },
    ],
    onClose: () => {
      if (!signIn) drop();
    },
  });
}

/** The TV's code, typed (the link had none, or another one is wanted). */
export function codeSheet(menu: Menu, prefill: string, next: (code: string) => void): void {
  let close = (): void => undefined;
  const cells = codeCells(t('tvlink.codeLabel'), (code) => {
    close();
    queueMicrotask(() => next(code));
  });
  cells.set(prefill);
  close = menu.modal({
    title: t('tvlink.title'),
    body: [h('p', null, t('tvlink.enterCode')), cells.el],
    actions: [
      {
        label: t('tvlink.continue'),
        primary: true,
        onClick: () => {
          const v = cells.value();
          if (v.length < CODE_LENGTH) {
            menu.toast(t('custom.codeInvalid'), 'error');
            return false;
          }
          queueMicrotask(() => next(v));
          return true;
        },
      },
      { label: t('tvlink.cancel'), onClick: () => (forget(), true) },
    ],
  });
}

/**
 * "Sign in on the TV as {name}?" with where that TV is (`info`: POST /api/auth/tv/info) and a
 * warning when it is in another country than the phone: CONFIRMAR grants it (`confirm`: the
 * request, its refusal thrown).
 */
export function askSheet(menu: Menu, name: string, code: string, info: TvInfoAnswer | null, confirm: () => Promise<void>, refused: (e: unknown) => void): void {
  const place = info === null ? null : tvPlace(info.where);
  const where = place !== null ? t('tvlink.where', { place }) : t('tvlink.whereUnknown');
  const near = info?.sameNetwork === true ? t('tvlink.sameNetwork') : info !== null && info.where?.country != null && !info.sameCountry ? t('tvlink.otherCountry') : null;
  menu.modal({
    title: t('tvlink.ask', { name }),
    body: [
      h('b.mn-sala-qr-code.mn-tvlink-code', null, spacedCode(code)),
      h('p', null, where),
      near !== null ? h(info?.sameNetwork === true ? 'p.mn-note' : 'p.mn-ban', null, near) : null,
      h('p.mn-note', null, t('tvlink.askNote')),
    ],
    actions: [
      {
        label: t('tvlink.confirm'),
        primary: true,
        onClick: async () => {
          try {
            await confirm();
            forget();
            menu.toast(t('tvlink.done'), 'ok');
          } catch (e) {
            queueMicrotask(() => refused(e));
          }
          return true;
        },
      },
      { label: t('tvlink.cancel'), onClick: () => (forget(), true) },
    ],
  });
}

/** A refused confirm, in words: another code for a wrong / expired / used one, else close (too many tries, a suspended account). */
export function refusedSheet(menu: Menu, e: unknown, again: () => void): void {
  const other = !(e instanceof AccountError) || (e.code !== 'throttled' && e.code !== 'banned');
  menu.modal({
    title: errText(e),
    body: [],
    actions: other
      ? [
          { label: t('tvlink.otherCode'), primary: true, onClick: () => (queueMicrotask(again), true) },
          { label: t('tvlink.cancel'), onClick: () => (forget(), true) },
        ]
      : [{ label: t('outcome.close'), primary: true, onClick: () => (forget(), true) }],
  });
}

/**
 * The /tv page (and the marker kept across a sign-in): the sheets above once the menus are up, in
 * the arbiter's turn (`turn`, Game.ts urlSheets: an OAuth result and its confirm sheet first), after
 * the account's restore (tvSignInModel.ts tvContinuation). Installed once by the Game.
 */
export function installTvLink(menu: Menu, turn: () => Promise<void> = () => Promise.resolve()): void {
  const acc = menu.host.accounts;
  let start: boolean;
  if (isTvPath(location.pathname)) {
    // The link's code is dropped: it only brought the phone here (A6).
    history.replaceState(history.state, '', '/' + location.search + withoutTvCode(location.hash));
    start = true;
  } else start = kept(); // back from a sign-in: a provider's round trip, the confirm sheet, PERFIL
  if (!start) return;
  const ask = (c: string): void => {
    void acc.tvInfo(c).then(
      (info) => askSheet(menu, acc.account?.name ?? '', c, info, () => acc.tvConfirm(c), again),
      again,
    );
  };
  const again = (e: unknown): void => refusedSheet(menu, e, () => codeSheet(menu, '', ask));
  tvContinuation({
    turn,
    // The menus up, no other sheet (a join link's): as installJoinLink waits.
    ready: async () => {
      while (!menu.visible || menu.modalOpen) await new Promise((r) => setTimeout(r, 400));
    },
    signedIn: () => acc.signedIn,
    restore: () => acc.restore(),
    codeEntry: () => {
      // Signed in: nothing waits for a round trip any more (a reload does not bring the sheet back).
      forget();
      // The code is typed, never the link's: whoever sent the link (or the QR) picked its code, and
      // only the TV in front of the player shows the right one.
      codeSheet(menu, '', ask);
    },
    signInFirst: (dropped) => {
      keep();
      signInFirstSheet(menu, () => {
        dropped();
        forget();
      });
    },
    subscribe: (fn) => void acc.subscribe(fn),
  });
}
