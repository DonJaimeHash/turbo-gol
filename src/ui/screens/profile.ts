/**
 * Profile: for a guest, sign in / create an account / recover with a recovery code (plus Google /
 * Discord when the server enables them) and the guest name; for an account, the ranks of the
 * season, abandons, and the account actions (rename, password, recovery codes, link a provider,
 * sign out). Passwords go through AccountClient (hashed in the browser before they leave).
 */
import { h, setChildren, copyText, navButton } from '../dom';
import { AccountError } from '../../net/AccountClient';
import { PASSWORD_MIN, USERNAME_MAX } from '../../net/account';
import type { OAuthProvider } from '../../net/account';
import { ratingCard } from '../badges';
import type { Menu, Screen } from '../Menu';
import { field, primary, screenHead, secondary, section } from './common';

const PROVIDER_NAMES: Readonly<Record<OAuthProvider, string>> = { google: 'Google', discord: 'Discord' };

function errText(e: unknown): string {
  if (e instanceof AccountError) {
    if (e.code === 'throttled' && e.retryAfterMs > 0) return `${e.message} (${Math.ceil(e.retryAfterMs / 1000)} s)`;
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

/** Show recovery codes once, with a copy button; resolves when the player confirms. */
export function showRecoveryCodes(menu: Menu, codes: string[], intro: string): void {
  menu.modal({
    title: 'Códigos de recuperación',
    dismissable: false,
    body: [
      h('p', null, intro),
      h('div.mn-codes', null, ...codes.map((c) => h('code', null, c))),
      h('p.mn-note', null, 'Cada código sirve una vez para cambiar la contraseña si te la olvidás. No hay recuperación por email: guardalos en un lugar seguro.'),
    ],
    actions: [
      { label: 'COPIAR', onClick: async () => (menu.toast((await copyText(codes.join('\n'))) ? 'Códigos copiados' : 'No se pudo copiar', 'ok'), false) },
      { label: 'YA LOS GUARDÉ', primary: true, onClick: () => true },
    ],
  });
}

function onEnter(inputs: HTMLInputElement[], go: () => void): void {
  for (const i of inputs) i.addEventListener('keydown', (e) => e.key === 'Enter' && go());
}

export function profileScreen(menu: Menu): Screen {
  const acc = menu.host.accounts;
  const body = h('div.mn-profile-body');
  let tab: 'login' | 'register' | 'recover' = 'login';

  const oauthButtons = (): HTMLElement | null => {
    const list = (menu.cfg?.oauth ?? []) as OAuthProvider[];
    if (list.length === 0) return null;
    return h('div.mn-oauth', null, h('div.mn-or', null, 'o'), ...list.map((p) => navButton(`mn-btn mn-oauth-${p}`, `Entrar con ${PROVIDER_NAMES[p]}`, () => (window.location.href = acc.oauthUrl(p)))));
  };

  const loginForm = (): HTMLElement => {
    const user = field('Usuario', { autocomplete: 'username', maxLength: 64, value: acc.hintName ?? '' });
    const pass = field('Contraseña', { type: 'password', autocomplete: 'current-password', maxLength: 128 });
    user.input.setAttribute('data-autofocus', '');
    const go = async (): Promise<void> => {
      pass.error(null);
      try {
        await acc.login(user.input.value, pass.input.value);
        menu.toast(`Hola, ${acc.account?.name}`, 'ok');
        void acc.fetchMe();
        render();
      } catch (e) {
        pass.error(errText(e));
      }
    };
    onEnter([user.input, pass.input], () => void go());
    return h('form.mn-form', { onsubmit: (e: Event) => e.preventDefault() }, user.el, pass.el, primary('ENTRAR', () => void go()), oauthButtons());
  };

  const registerForm = (): HTMLElement => {
    const user = field('Usuario', { autocomplete: 'username', maxLength: USERNAME_MAX, placeholder: '3 a 16: letras, números, _ - .' });
    const pass = field('Contraseña', { type: 'password', autocomplete: 'new-password', maxLength: 128, placeholder: `Al menos ${PASSWORD_MIN} caracteres` });
    const pass2 = field('Repetir contraseña', { type: 'password', autocomplete: 'new-password', maxLength: 128 });
    user.input.setAttribute('data-autofocus', '');
    const go = async (): Promise<void> => {
      user.error(null);
      pass.error(null);
      pass2.error(null);
      if (pass.input.value !== pass2.input.value) {
        pass2.error('Las contraseñas no coinciden');
        return;
      }
      try {
        const r = await acc.register(user.input.value.trim(), pass.input.value);
        render();
        showRecoveryCodes(menu, r.recoveryCodes, `¡Listo, ${r.name}! Tu cuenta está creada. Estos son tus códigos de recuperación:`);
        void acc.fetchMe();
      } catch (e) {
        if (e instanceof AccountError && (e.code === 'bad_username' || e.code === 'username_taken')) user.error(errText(e));
        else pass.error(errText(e));
      }
    };
    onEnter([user.input, pass.input, pass2.input], () => void go());
    return h('form.mn-form', { onsubmit: (e: Event) => e.preventDefault() }, user.el, pass.el, pass2.el, primary('CREAR CUENTA', () => void go()), oauthButtons());
  };

  const recoverForm = (): HTMLElement => {
    const user = field('Usuario', { autocomplete: 'username', maxLength: 64, value: acc.hintName ?? '' });
    const code = field('Código de recuperación', { placeholder: 'XXXX-XXXX', maxLength: 16 });
    const pass = field('Nueva contraseña', { type: 'password', autocomplete: 'new-password', maxLength: 128 });
    user.input.setAttribute('data-autofocus', '');
    const go = async (): Promise<void> => {
      pass.error(null);
      try {
        const r = await acc.recover(user.input.value, code.input.value, pass.input.value);
        menu.toast(`Contraseña cambiada. Te quedan ${r.codesLeft} códigos.`, 'ok');
        void acc.fetchMe();
        render();
      } catch (e) {
        pass.error(errText(e));
      }
    };
    onEnter([user.input, code.input, pass.input], () => void go());
    return h('form.mn-form', { onsubmit: (e: Event) => e.preventDefault() }, user.el, code.el, pass.el, primary('CAMBIAR CONTRASEÑA', () => void go()));
  };

  const guestView = (): HTMLElement => {
    const tabs = h(
      'div.mn-tabs',
      null,
      ...(
        [
          ['login', 'INICIAR SESIÓN'],
          ['register', 'CREAR CUENTA'],
          ['recover', 'RECUPERAR'],
        ] as const
      ).map(([id, label]) =>
        navButton(`mn-tab${tab === id ? ' mn-tab-on' : ''}`, label, () => {
          tab = id;
          render();
        }),
      ),
    );
    const form = tab === 'login' ? loginForm() : tab === 'register' ? registerForm() : recoverForm();
    const name = field('Nombre como invitado', { maxLength: 16, value: menu.host.guestName() });
    const saveName = (): void => {
      menu.host.setGuestName(name.input.value);
      name.input.value = menu.host.guestName();
      menu.refreshChrome();
      menu.toast('Nombre de invitado guardado', 'ok');
    };
    onEnter([name.input], saveName);
    return h(
      'div.mn-profile-guest',
      null,
      h('div.mn-auth', null, tabs, form),
      h('aside.mn-auth-side', null, section('JUGAR COMO INVITADO', h('p.mn-note', null, 'Casual, salas y entrenamiento no necesitan cuenta. Competitivo y el ranking, sí.'), name.el, secondary('GUARDAR NOMBRE', saveName))),
    );
  };

  const accountView = (): HTMLElement => {
    const me = acc.me;
    const name = acc.account?.name ?? '';
    const ratings = h('div.mn-profile-ratings', null, ...(me ? me.ratings.map((r) => ratingCard(r)) : [h('div.mn-empty', null, 'Cargando…')]));
    const banLeft = me ? me.rankedBanUntil - Date.now() : 0;
    const providers = (menu.cfg?.oauth ?? []) as OAuthProvider[];
    const linkable = providers.filter((p) => me && !me.providers.includes(p));
    return h(
      'div.mn-profile-account',
      null,
      h(
        'div.mn-profile-id',
        null,
        h('div.mn-avatar', null, name.slice(0, 1).toUpperCase()),
        h(
          'div',
          null,
          h('div.mn-profile-name', null, name),
          h('div.mn-note', null, me ? `Cuenta desde ${new Date(me.createdAt).toLocaleDateString('es-AR')} · ${me.providers.map((p) => (p === 'password' ? 'contraseña' : PROVIDER_NAMES[p])).join(', ')}` : ''),
          me && me.abandons24h > 0 ? h('div.mn-ban', null, `Abandonos en 24 h: ${me.abandons24h}${banLeft > 0 ? ` · Competitivo bloqueado ${Math.ceil(banLeft / 60000)} min` : ''}`) : null,
        ),
      ),
      section(`TEMPORADA ${me?.season ?? 1}`, ratings),
      section(
        'CUENTA',
        h(
          'div.mn-actions.mn-actions-wrap',
          null,
          secondary('CAMBIAR NOMBRE', () => renameDialog()),
          me?.hasPassword !== false ? secondary('CAMBIAR CONTRASEÑA', () => passwordDialog()) : secondary('PONER CONTRASEÑA', () => passwordDialog()),
          secondary('NUEVOS CÓDIGOS DE RECUPERACIÓN', () => codesDialog()),
          ...linkable.map((p) => secondary(`VINCULAR ${PROVIDER_NAMES[p].toUpperCase()}`, () => (window.location.href = acc.oauthUrl(p, true)))),
          secondary('CERRAR SESIÓN', () => {
            void acc.logout().then(() => {
              menu.toast('Sesión cerrada', 'info');
              render();
            });
          }),
        ),
      ),
    );
  };

  const renameDialog = (): void => {
    const hasPw = acc.me?.hasPassword !== false;
    const user = field('Nuevo nombre', { maxLength: USERNAME_MAX, value: acc.account?.name ?? '' });
    const pass = field('Tu contraseña', { type: 'password', autocomplete: 'current-password' });
    menu.modal({
      title: 'Cambiar nombre',
      body: [h('p.mn-note', null, 'Podés cambiarlo una vez cada 30 días.'), user.el, hasPw ? pass.el : null],
      actions: [
        {
          label: 'CAMBIAR',
          primary: true,
          onClick: async () => {
            try {
              await acc.rename(user.input.value.trim(), hasPw ? pass.input.value : null);
              menu.toast('Nombre cambiado', 'ok');
              render();
              return true;
            } catch (e) {
              (hasPw ? pass : user).error(errText(e));
              return false;
            }
          },
        },
        { label: 'CANCELAR', onClick: () => true },
      ],
    });
  };

  const passwordDialog = (): void => {
    const hasPw = acc.me?.hasPassword !== false;
    const old = field('Contraseña actual', { type: 'password', autocomplete: 'current-password' });
    const next = field('Nueva contraseña', { type: 'password', autocomplete: 'new-password' });
    const again = field('Repetir nueva contraseña', { type: 'password', autocomplete: 'new-password' });
    menu.modal({
      title: hasPw ? 'Cambiar contraseña' : 'Poner contraseña',
      body: [hasPw ? old.el : h('p.mn-note', null, 'Con una contraseña también podés entrar con tu usuario.'), next.el, again.el, h('p.mn-note', null, 'Se cierra la sesión en tus otros dispositivos.')],
      actions: [
        {
          label: 'GUARDAR',
          primary: true,
          onClick: async () => {
            if (next.input.value !== again.input.value) {
              again.error('No coinciden');
              return false;
            }
            try {
              await acc.changePassword(hasPw ? old.input.value : null, next.input.value);
              menu.toast('Contraseña actualizada', 'ok');
              void acc.fetchMe().then(() => render());
              return true;
            } catch (e) {
              (e instanceof AccountError && e.code === 'bad_credentials' ? old : next).error(errText(e));
              return false;
            }
          },
        },
        { label: 'CANCELAR', onClick: () => true },
      ],
    });
  };

  const codesDialog = (): void => {
    const hasPw = acc.me?.hasPassword !== false;
    const pass = field('Tu contraseña', { type: 'password', autocomplete: 'current-password' });
    menu.modal({
      title: 'Nuevos códigos de recuperación',
      body: [h('p.mn-note', null, 'Los códigos anteriores dejan de servir.'), hasPw ? pass.el : null],
      actions: [
        {
          label: 'GENERAR',
          primary: true,
          onClick: async () => {
            try {
              const codes = await acc.newRecoveryCodes(hasPw ? pass.input.value : null);
              showRecoveryCodes(menu, codes, 'Tus nuevos códigos:');
              return false; // the codes dialog replaced this one
            } catch (e) {
              pass.error(errText(e));
              return false;
            }
          },
        },
        { label: 'CANCELAR', onClick: () => true },
      ],
    });
  };

  const render = (): void => {
    setChildren(body, acc.signedIn ? accountView() : guestView());
    menu.refocus();
  };

  const el = h('div.mn-profile', null, screenHead('PERFIL'), body);
  return {
    id: 'profile',
    title: 'Perfil',
    el,
    show: () => {
      render();
      if (acc.signedIn) void acc.fetchMe().then(render, () => undefined);
    },
  };
}
