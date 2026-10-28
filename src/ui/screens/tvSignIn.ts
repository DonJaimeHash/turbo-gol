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
 * back to / at once (a reload is the game), the code is kept in sessionStorage for 5 minutes, so a
 * sign-in on PERFIL (or Google's round trip) comes back to it. Signed out: "Sign in on this phone
 * first" with INICIAR SESIÓN (PERFIL); signed in: the code cells when the link had no code, then
 * "Sign in on the TV as {name}?" with the code big, CONFIRMAR / CANCELAR: nothing is granted before
 * CONFIRMAR. A refusal says why in words (wrong, expired, used, too many tries) with OTRO CÓDIGO.
 * In development (or a VITE_UI_FIT=1 build) window.__tvSignIn shows each sheet with sample data
 * (screens/tvSignInSamples.ts, scripts/ui-fit.mjs).
 */
import { h } from '../dom';
import { AccountError } from '../../net/AccountClient';
import type { TvStartAnswer } from '../../net/account';
import type { Menu } from '../Menu';
import type { SheetSpec } from '../components/sheet';
import { qrSvg } from '../components/qr';
import { codeCells } from '../components/codecells';
import { CODE_LENGTH, spacedCode } from './lobbyModel';
import { isTvPath, pendingCode, timeLeft, tvHashCode, tvLink, tvShortLink, withoutTvCode } from './tvSignInModel';
import { errText } from './profile';
import { STORAGE_PREFIX } from '../../brand';
import { t } from '../../i18n';

/** A TV sheet's state: asking for a code, showing one (`s`), expired, or a failed start (`error`). */
export type TvSheet = { kind: 'starting' } | { kind: 'code'; s: TvStartAnswer } | { kind: 'expired' } | { kind: 'failed'; error: string };

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
    left = h('span.mn-tvsign-left', null, t('tvsign.expiresIn', { time: timeLeft(state.s.expiresAt, Date.now()) }));
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
        const { left, close } = show({ kind: 'code', s });
        const at = epoch;
        tick = window.setInterval(() => {
          if (Date.now() >= s.expiresAt) show({ kind: 'expired' });
          else if (left !== null) left.textContent = t('tvsign.expiresIn', { time: timeLeft(s.expiresAt, Date.now()) });
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
            if (e instanceof AccountError && (e.code === 'tv_code_expired' || e.code === 'tv_code_used')) {
              show({ kind: 'expired' });
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

function keep(code: string): void {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ code, at: Date.now() }));
  } catch {
    /* private mode: the code lasts this page */
  }
}

function forget(): void {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* nothing kept */
  }
}

function kept(): string | null {
  try {
    return pendingCode(sessionStorage.getItem(PENDING_KEY), Date.now());
  } catch {
    return null;
  }
}

/** Signed out: sign in on this phone first (PERFIL; the code waits). */
export function signInFirstSheet(menu: Menu): void {
  menu.modal({
    title: t('tvlink.title'),
    body: h('p', null, t('tvlink.signInFirst')),
    actions: [
      { label: t('tvlink.signIn'), primary: true, onClick: () => (queueMicrotask(() => menu.open('profile')), true) },
      { label: t('tvlink.cancel'), onClick: () => (forget(), true) },
    ],
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

/** "Sign in on the TV as {name}?": CONFIRMAR grants it (`confirm`: the request, its refusal thrown). */
export function askSheet(menu: Menu, name: string, code: string, confirm: () => Promise<void>, refused: (e: unknown) => void): void {
  menu.modal({
    title: t('tvlink.ask', { name }),
    body: [h('b.mn-sala-qr-code.mn-tvlink-code', null, spacedCode(code)), h('p.mn-note', null, t('tvlink.askNote'))],
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

/** A refused confirm, in words: another code for a wrong / expired / used one, else close (too many tries). */
export function refusedSheet(menu: Menu, e: unknown, again: () => void): void {
  const other = !(e instanceof AccountError) || e.code !== 'throttled';
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
 * The /tv page (and its code kept across a sign-in): the sheets above once the menus are up, after
 * the account's restore. Installed once by the Game.
 */
export function installTvLink(menu: Menu): void {
  const acc = menu.host.accounts;
  let waiting: string | null = null;
  const run = async (code: string): Promise<void> => {
    // The menus up, no other sheet (a join link's): as installJoinLink waits.
    while (!menu.visible || menu.modalOpen) await new Promise((r) => setTimeout(r, 400));
    if (!acc.signedIn) await acc.restore().catch(() => null);
    if (!acc.signedIn) {
      waiting = code;
      signInFirstSheet(menu);
      return;
    }
    const ask = (c: string): void =>
      askSheet(
        menu,
        acc.account?.name ?? '',
        c,
        () => acc.tvConfirm(c),
        (e) => refusedSheet(menu, e, () => codeSheet(menu, '', ask)),
      );
    if (code.length < CODE_LENGTH) codeSheet(menu, code, ask);
    else ask(code);
  };
  // Signed in on PERFIL while the code waited: back to it.
  acc.subscribe(() => {
    if (waiting === null || !acc.signedIn) return;
    const code = waiting;
    waiting = null;
    void run(code);
  });
  let code: string | null;
  if (isTvPath(location.pathname)) {
    code = tvHashCode(location.hash) ?? '';
    history.replaceState(history.state, '', '/' + location.search + withoutTvCode(location.hash));
    keep(code);
  } else code = kept(); // back from Google's or Discord's sign-in
  if (code !== null) void run(code);
}
