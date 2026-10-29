/**
 * Every mail the Worker sends, in Spanish and English, as a text part and a small html part
 * (docs/online/MAIL.md; the sign-in design, section 4.4). The templates live in the Worker: the
 * client's locale files would put about 100 KB of interface text in its bundle.
 *
 *   renderMail(data, ctx)  one message: subject, text, html, and its link and code for the stub
 *   mailLink(origin, ...)  `${origin}/account#<kind>=<token>`: the token sits in the fragment
 *   mailLang(...)          the language of a mail: the account's, else the request's, else English
 *   formatMailDate(...)    a date in the account's time zone, or the date alone without one
 *
 * Rules the tests hold every template to (server/test/mail.test.mjs):
 *   - every URL is built here from `ctx.origin` (mail.ts linkOrigin) and a token, never taken from
 *     the caller, and a token only ever travels in the fragment;
 *   - every value is cleaned of control characters, and escaped in the html;
 *   - no image, tracking, remote font, style sheet or script, and no external link;
 *   - the Spanish is neutral (tú, never voseo) and the copy rules of tests/i18n-copy.test.mjs hold;
 *   - the security notices (mailCaps.ts isNotice) carry both languages, the account's first.
 */
import { isNotice, type MailKind } from './mailCaps';

export type MailLang = 'es' | 'en';
export type Provider = 'google' | 'discord';
/** A way into an account, as `{methods}` names it. */
export type WayIn = 'email' | 'username' | 'google' | 'discord';
/** The `/account#<kind>=` of a link (the client's sheet for it). `keep` cancels a deletion. */
export type LinkKind = 'verify' | 'email' | 'reset' | 'undo' | 'keep' | 'unsub';

/** What each message needs. `at` is a time in ms; `name` and `other` are public account names. */
export type MailData =
  | { kind: 'verify_signup'; code: string; token: string; hint?: Provider }
  | { kind: 'signup_exists'; name: string; variant: 'reset'; methods: readonly WayIn[]; token: string }
  | { kind: 'signup_exists'; name: string; variant: 'held'; methods?: readonly WayIn[] }
  | { kind: 'reset'; name: string; variant: 'reset'; token: string }
  | { kind: 'reset'; name: string; variant: 'create'; methods: readonly WayIn[]; token: string }
  | { kind: 'password_changed'; name: string; at: number }
  | { kind: 'verify_email'; name: string; code: string; token: string }
  | { kind: 'email_changed'; name: string; masked: string; at: number; token: string; providers: readonly Provider[] }
  | { kind: 'email_in_use'; name: string; other: string; variant: 'move'; code: string; methods: readonly WayIn[] }
  | { kind: 'email_in_use'; name: string; other: string; variant: 'only' | 'held' }
  | { kind: 'provider_linked'; name: string; provider: Provider; at: number; variant: 'linked' | 'unlinked' }
  | { kind: 'deletion_scheduled'; name: string; at: number; token: string }
  | { kind: 'legacy_reminder'; name: string; at: number; token: string }
  | { kind: 'reauth_code'; name: string; code: string }
  | { kind: 'email_moved'; name: string; other: string; at: number; methods: readonly WayIn[] };

export interface MailContext {
  /** LINK_ORIGIN (mail.ts linkOrigin): the only origin any URL of the mail may carry. */
  origin: string;
  /** The mail's language (mailLang); for a notice, the language that goes first. */
  lang: MailLang;
  /** The account's IANA time zone, when it has one: dates then carry the time too. */
  tz?: string;
}

export interface RenderedMail {
  kind: MailKind;
  /** `<html lang>`: the mail's language, or the first one of a notice. */
  lang: MailLang;
  subject: string;
  text: string;
  html: string;
  /** The mail's link and code, for the stub's outbox (the live mailer sends the bodies alone). */
  link?: string;
  code?: string;
}

// ---- Language and dates ---------------------------------------------------------------------------

function langOf(v: string | null | undefined): MailLang | null {
  const base = (v ?? '').trim().toLowerCase().split(/[-_]/)[0];
  return base === 'es' || base === 'en' ? base : null;
}

/** The account's language when it has one, else the request's (an es-AR tag counts as es), else English. */
export function mailLang(accountLang: string | null | undefined, requestLang?: string | null): MailLang {
  return langOf(accountLang) ?? langOf(requestLang) ?? 'en';
}

/** An IANA zone Intl knows, or null. */
function zoneOf(tz: string | undefined): string | null {
  if (!tz || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return null;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

/**
 * A date for a mail. 'moment' (when something happened): with a time zone, the date and the time
 * with the zone's short name; without one, the date alone (UTC), so a player at UTC-3 never reads
 * a time three hours ahead. 'day' (a deletion, the cutoff): always the date alone.
 * (dateStyle cannot be combined with timeZoneName, so the parts are spelled out.)
 */
export function formatMailDate(at: number, lang: MailLang, tz?: string, style: 'moment' | 'day' = 'moment'): string {
  const zone = zoneOf(tz);
  const day: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'long', day: 'numeric' };
  if (zone && style === 'moment') return new Intl.DateTimeFormat(lang, { ...day, hour: 'numeric', minute: '2-digit', timeZone: zone, timeZoneName: 'short' }).format(at);
  return new Intl.DateTimeFormat(lang, { ...day, timeZone: zone ?? 'UTC' }).format(at);
}

// ---- Values ---------------------------------------------------------------------------------------

/** Control characters and bidi overrides become spaces; whitespace runs collapse. Bounded. */
function clean(v: string, max = 64): string {
  return String(v)
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function mustCode(code: string): string {
  if (!/^\d{6}$/.test(code)) throw new Error('mail: a code is 6 digits');
  return code;
}

function mustToken(token: string): string {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) throw new Error('mail: a token is base64url');
  return token;
}

/** `origin` exactly as URL's `origin` reads it: http(s), a host, no path, query or fragment. */
function mustOrigin(origin: string): string {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    throw new Error('mail: the link origin is not a URL');
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.origin !== origin) throw new Error('mail: the link origin is not an origin');
  return origin;
}

/** The link of a mail: `${origin}/account#<kind>=<token>`. The fragment never reaches a server or a Referer. */
export function mailLink(origin: string, kind: LinkKind, token: string): string {
  return `${mustOrigin(origin)}/account#${kind}=${mustToken(token)}`;
}

const PROVIDER_NAME: Record<Provider, string> = { google: 'Google', discord: 'Discord' };

const WAY: Record<MailLang, Record<WayIn, string>> = {
  es: { email: 'tu correo y tu contraseña', username: 'tu usuario y tu contraseña', google: 'Google', discord: 'Discord' },
  en: { email: 'your email and password', username: 'your username and password', google: 'Google', discord: 'Discord' },
};

/** "a, b o c" / "a, b or c". */
function joinOr(lang: MailLang, items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return items.slice(0, -1).join(', ') + (lang === 'es' ? ' o ' : ' or ') + items[items.length - 1];
}

function methodsText(lang: MailLang, ways: readonly WayIn[] | undefined): string {
  const list = [...new Set(ways ?? [])].filter((w) => w in WAY[lang]);
  if (list.length === 0) throw new Error('mail: {methods} needs at least one way in');
  return joinOr(lang, list.map((w) => WAY[lang][w]));
}

/** `{providers}` (the configured ones, Google first): "Discord", "Google o Discord"; '' for none. */
function providersText(lang: MailLang, list: readonly Provider[]): string {
  const order: Provider[] = ['google', 'discord'];
  return joinOr(lang, order.filter((p) => list.includes(p)).map((p) => PROVIDER_NAME[p]));
}

// ---- Blocks ---------------------------------------------------------------------------------------

type Segment = string | { url: string };
type Block = { t: 'p'; s: Segment[] } | { t: 'code'; code: string } | { t: 'link'; url: string; label: string };

const p = (...s: Segment[]): Block => ({ t: 'p', s });
const code = (c: string): Block => ({ t: 'code', code: c });

interface Draft {
  subject: string;
  blocks: Block[];
}

/** What a template gets: its language, the cleaned data, and builders that only make our own URLs. */
interface Tools {
  lang: MailLang;
  origin: string;
  date(at: number, style?: 'moment' | 'day'): string;
  methods(ways: readonly WayIn[] | undefined): string;
  providers(list: readonly Provider[]): string;
  link(kind: LinkKind, token: string, label: string): Block;
}

/** Each kind's es and en draft. The copy is the design's (section 4.4), word for word. */
const TEMPLATES: { [K in MailKind]: (d: Extract<MailData, { kind: K }>, x: Tools) => Draft } = {
  verify_signup(d, x) {
    const pv = d.hint ? PROVIDER_NAME[d.hint] : '';
    if (x.lang === 'es')
      return {
        subject: `${d.code} es tu código de Turbogol`,
        blocks: [
          p('Hola:'),
          p('Para crear tu cuenta de Turbogol, escribe este código en el juego:'),
          code(d.code),
          p('O abre este enlace en el dispositivo donde quieras jugar:'),
          x.link('verify', d.token, 'Crear mi cuenta'),
          p('El código caduca en 15 minutos y el enlace en 24 horas. No compartas el código con nadie: Turbogol nunca te lo va a pedir.'),
          ...(pv ? [p(`Si ya entras a Turbogol con ${pv} y esa cuenta de ${pv} usa este correo, entra con ${pv}: no hace falta crear otra cuenta.`)] : []),
          p('Si no fuiste tú, ignora este correo: sin el código no se crea ninguna cuenta.'),
        ],
      };
    return {
      subject: `${d.code} is your Turbogol code`,
      blocks: [
        p('Hi,'),
        p('To create your Turbogol account, type this code in the game:'),
        code(d.code),
        p('Or open this link on the device you want to play on:'),
        x.link('verify', d.token, 'Create my account'),
        p('The code expires in 15 minutes and the link in 24 hours. Never share the code: Turbogol will never ask you for it.'),
        ...(pv ? [p(`If you already sign in to Turbogol with ${pv} and that ${pv} account uses this email, sign in with ${pv}: there's no need for another account.`)] : []),
        p("If this wasn't you, ignore this email: no account is created without the code."),
      ],
    };
  },

  signup_exists(d, x) {
    // "held": the address is held for an undo (the account's email changed); no link, and
    // {methods} only when the caller still has a fitting list.
    const ways = d.variant === 'reset' || (d.methods && d.methods.length > 0) ? x.methods(d.methods) : '';
    if (x.lang === 'es')
      return {
        subject: 'Ya tienes una cuenta de Turbogol',
        blocks: [
          p(`Hola, ${d.name}:`),
          p('Alguien, tal vez tú, intentó crear una cuenta de Turbogol con este correo, pero ya tienes una.' + (ways ? ` Entras con ${ways}.` : '')),
          ...(d.variant === 'reset'
            ? [p('¿Olvidaste la contraseña? Elige una nueva con este enlace. Caduca en 30 minutos:'), x.link('reset', d.token, 'Elegir una contraseña nueva')]
            : [p(`Este correo queda reservado unos días para la cuenta ${d.name}, porque el cambio de su correo todavía se puede deshacer. Si la cuenta es tuya, usa el enlace del correo «El correo de tu cuenta de Turbogol cambió».`)]),
          p('Si no fuiste tú, ignora este correo: tu cuenta no cambió.'),
        ],
      };
    return {
      subject: 'You already have a Turbogol account',
      blocks: [
        p(`Hi ${d.name},`),
        p('Someone, maybe you, tried to create a Turbogol account with this email, but you already have one.' + (ways ? ` You sign in with ${ways}.` : '')),
        ...(d.variant === 'reset'
          ? [p('Forgot your password? Choose a new one with this link. It expires in 30 minutes:'), x.link('reset', d.token, 'Choose a new password')]
          : [p(`This email stays reserved for a few days for the account ${d.name}, because the change of its email can still be undone. If the account is yours, use the link in the email "Your Turbogol account's email changed".`)]),
        p("If this wasn't you, ignore this email: nothing changed on your account."),
      ],
    };
  },

  reset(d, x) {
    const create = d.variant === 'create';
    if (x.lang === 'es')
      return {
        subject: create ? 'Crea una contraseña para Turbogol' : 'Elige una contraseña nueva para Turbogol',
        blocks: [
          p(`Hola, ${d.name}:`),
          create
            ? p(`Entras a tu cuenta con ${x.methods(d.methods)}. Con este enlace también puedes crear una contraseña para entrar con tu correo. Caduca en 30 minutos y sirve una sola vez:`)
            : p('Recibimos una solicitud para cambiar la contraseña de tu cuenta de Turbogol. Para elegir una nueva, abre este enlace. Caduca en 30 minutos y sirve una sola vez:'),
          x.link('reset', d.token, create ? 'Crear una contraseña' : 'Elegir una contraseña nueva'),
          p('Si no lo pediste, ignora este correo: no cambia nada.'),
        ],
      };
    return {
      subject: create ? 'Create a Turbogol password' : 'Choose a new Turbogol password',
      blocks: [
        p(`Hi ${d.name},`),
        create
          ? p(`You sign in with ${x.methods(d.methods)}. With this link you can also create a password to sign in with your email. It expires in 30 minutes and works once:`)
          : p("We got a request to change your Turbogol account's password. To choose a new one, open this link. It expires in 30 minutes and works once:"),
        x.link('reset', d.token, create ? 'Create a password' : 'Choose a new password'),
        p("If you didn't ask for this, ignore this email: nothing changes."),
      ],
    };
  },

  password_changed(d, x) {
    const forgot = { url: `${x.origin}/account#forgot` };
    if (x.lang === 'es')
      return {
        subject: 'Tu contraseña de Turbogol cambió',
        blocks: [
          p(`Hola, ${d.name}:`),
          p(`La contraseña de tu cuenta cambió el ${x.date(d.at)} y cerramos la sesión en tus otros dispositivos.`),
          p('Si no fuiste tú, pide una contraseña nueva ahora en ', forgot, ' y revisa en PERFIL › Cuenta y seguridad qué cuentas tienes vinculadas.'),
        ],
      };
    return {
      subject: 'Your Turbogol password changed',
      blocks: [
        p(`Hi ${d.name},`),
        p(`Your account's password changed on ${x.date(d.at)}, and we signed out your other devices.`),
        p("If this wasn't you, ask for a new password now at ", forgot, ' and check which accounts are linked in PROFILE › Account and security.'),
      ],
    };
  },

  verify_email(d, x) {
    if (x.lang === 'es')
      return {
        subject: `${d.code} es tu código para confirmar tu correo`,
        blocks: [
          p(`Hola, ${d.name}:`),
          p('Para usar este correo en tu cuenta de Turbogol, escribe este código en el juego:'),
          code(d.code),
          p('O abre este enlace:'),
          x.link('email', d.token, 'Confirmar este correo'),
          p('El código caduca en 15 minutos y el enlace en 24 horas. No compartas el código con nadie.'),
          p('Si no fuiste tú, ignora este correo: no cambia nada.'),
        ],
      };
    return {
      subject: `${d.code} is your code to confirm your email`,
      blocks: [
        p(`Hi ${d.name},`),
        p('To use this email on your Turbogol account, type this code in the game:'),
        code(d.code),
        p('Or open this link:'),
        x.link('email', d.token, 'Confirm this email'),
        p('The code expires in 15 minutes and the link in 24 hours. Never share the code.'),
        p("If this wasn't you, ignore this email: nothing changes."),
      ],
    };
  },

  email_changed(d, x) {
    const pv = x.providers(d.providers);
    if (x.lang === 'es')
      return {
        subject: 'El correo de tu cuenta de Turbogol cambió',
        blocks: [
          p(`Hola, ${d.name}:`),
          p(`El correo de tu cuenta cambió a ${d.masked} el ${x.date(d.at)}, y cerramos la sesión en tus otros dispositivos.`),
          p('Si no fuiste tú, recupera tu cuenta con este enlace. Sirve durante 7 días:'),
          x.link('undo', d.token, 'Recuperar mi cuenta'),
          pv
            ? p(`Al usarlo, tu cuenta vuelve a este correo, eliges una contraseña nueva, se cierra la sesión en todos los dispositivos y se desvincula cualquier cuenta de ${pv} vinculada en los últimos 7 días.`)
            : p('Al usarlo, tu cuenta vuelve a este correo, eliges una contraseña nueva y se cierra la sesión en todos los dispositivos.'),
        ],
      };
    return {
      subject: "Your Turbogol account's email changed",
      blocks: [
        p(`Hi ${d.name},`),
        p(`Your account's email changed to ${d.masked} on ${x.date(d.at)}, and we signed out your other devices.`),
        p("If this wasn't you, recover your account with this link. It works for 7 days:"),
        x.link('undo', d.token, 'Recover my account'),
        pv
          ? p(`Using it puts your account back on this email, lets you choose a new password, signs out every device and unlinks any ${pv} account linked in the last 7 days.`)
          : p('Using it puts your account back on this email, lets you choose a new password and signs out every device.'),
      ],
    };
  },

  email_in_use(d, x) {
    if (x.lang === 'es') {
      const body: Block[] =
        d.variant === 'move'
          ? [p(`Si las dos cuentas son tuyas y quieres usar este correo en ${d.other}, escribe este código en esa cuenta:`), code(d.code), p(`El correo deja la cuenta ${d.name}, que sigue entrando con ${x.methods(d.methods)}. El código caduca en 15 minutos.`)]
          : d.variant === 'only'
            ? [p(`Este correo no puede pasar a otra cuenta: es la única forma de entrar a la cuenta ${d.name}. Si las dos cuentas son tuyas, sigue usando ${d.name}.`)]
            : [p(`Este correo queda reservado unos días para la cuenta ${d.name}, porque el cambio de su correo todavía se puede deshacer.`)];
      return {
        subject: 'Alguien quiere usar tu correo en Turbogol',
        blocks: [p(`Hola, ${d.name}:`), p(`Alguien, tal vez tú, quiere usar este correo en otra cuenta de Turbogol: ${d.other}.`), ...body, p('Si no fuiste tú, ignora este correo: no cambia nada.')],
      };
    }
    const body: Block[] =
      d.variant === 'move'
        ? [p(`If both accounts are yours and you want this email on ${d.other}, type this code there:`), code(d.code), p(`The email then leaves ${d.name}, which keeps signing in with ${x.methods(d.methods)}. The code expires in 15 minutes.`)]
        : d.variant === 'only'
          ? [p(`This email can't move to another account: it's the only way into the account ${d.name}. If both accounts are yours, keep using ${d.name}.`)]
          : [p(`This email stays reserved for a few days for the account ${d.name}, because the change of its email can still be undone.`)];
    return {
      subject: 'Someone wants to use your email on Turbogol',
      blocks: [p(`Hi ${d.name},`), p(`Someone, maybe you, wants to use this email on another Turbogol account: ${d.other}.`), ...body, p("If this wasn't you, ignore this email: nothing changes.")],
    };
  },

  provider_linked(d, x) {
    const pv = PROVIDER_NAME[d.provider];
    const linked = d.variant === 'linked';
    if (x.lang === 'es')
      return {
        subject: linked ? `Vinculaste ${pv} a tu cuenta de Turbogol` : `Desvinculaste ${pv} de tu cuenta de Turbogol`,
        blocks: [
          p(`Hola, ${d.name}:`),
          linked ? p(`${pv} quedó vinculado a tu cuenta el ${x.date(d.at)}: ahora puedes entrar con ${pv}.`) : p(`${pv} se desvinculó de tu cuenta el ${x.date(d.at)}.`),
          p('Si no fuiste tú, cambia tu contraseña y revisa PERFIL › Cuenta y seguridad.'),
        ],
      };
    return {
      subject: linked ? `${pv} was linked to your Turbogol account` : `${pv} was unlinked from your Turbogol account`,
      blocks: [
        p(`Hi ${d.name},`),
        linked ? p(`${pv} was linked to your account on ${x.date(d.at)}: you can now sign in with ${pv}.`) : p(`${pv} was unlinked from your account on ${x.date(d.at)}.`),
        p("If this wasn't you, change your password and check PROFILE › Account and security."),
      ],
    };
  },

  deletion_scheduled(d, x) {
    const day = x.date(d.at, 'day');
    if (x.lang === 'es')
      return {
        subject: `Tu cuenta de Turbogol se borra el ${day}`,
        blocks: [
          p(`Hola, ${d.name}:`),
          p(`Pediste borrar tu cuenta. El ${day} la borramos para siempre, con tu rango, tus autos y tus puntos.`),
          p('Para cancelar, abre este enlace antes de esa fecha:'),
          x.link('keep', d.token, 'Cancelar el borrado'),
          p('Si no fuiste tú, cancela el borrado y cambia tu contraseña.'),
        ],
      };
    return {
      subject: `Your Turbogol account will be deleted on ${day}`,
      blocks: [
        p(`Hi ${d.name},`),
        p(`You asked to delete your account. On ${day} we delete it for good, with your rank, your cars and your points.`),
        p('To cancel, open this link before then:'),
        x.link('keep', d.token, 'Cancel the deletion'),
        p("If this wasn't you, cancel the deletion and change your password."),
      ],
    };
  },

  legacy_reminder(d, x) {
    const day = x.date(d.at, 'day');
    if (x.lang === 'es')
      return {
        subject: `Tu usuario de Turbogol deja de servir para entrar el ${day}`,
        blocks: [
          p(`Hola, ${d.name}:`),
          p(`Desde el ${day} ya no se puede entrar con usuario. Tu cuenta ya tiene este correo: para seguir con tu misma contraseña, entra una vez antes de esa fecha con tu usuario y tu contraseña. También puedes crear una contraseña nueva con este enlace, que caduca en 30 minutos:`),
          x.link('reset', d.token, 'Crear una contraseña nueva'),
        ],
      };
    return {
      subject: `Your Turbogol username stops signing in on ${day}`,
      blocks: [
        p(`Hi ${d.name},`),
        p(`From ${day}, you can't sign in with a username. Your account already has this email: to keep your password, sign in once with your username and password before then. You can also create a new password with this link, which expires in 30 minutes:`),
        x.link('reset', d.token, 'Create a new password'),
      ],
    };
  },

  reauth_code(d, x) {
    if (x.lang === 'es')
      return {
        subject: `${d.code} es tu código para confirmar que eres tú`,
        blocks: [
          p(`Hola, ${d.name}:`),
          p('Para confirmar que eres tú en Turbogol, escribe este código en el juego:'),
          code(d.code),
          p('Caduca en 10 minutos. No compartas el código con nadie: Turbogol nunca te lo va a pedir.'),
          p('Si no fuiste tú, cambia tu contraseña y revisa PERFIL › Cuenta y seguridad.'),
        ],
      };
    return {
      subject: `${d.code} is your code to confirm it's you`,
      blocks: [
        p(`Hi ${d.name},`),
        p("To confirm it's you on Turbogol, type this code in the game:"),
        code(d.code),
        p('It expires in 10 minutes. Never share the code: Turbogol will never ask you for it.'),
        p("If this wasn't you, change your password and check PROFILE › Account and security."),
      ],
    };
  },

  email_moved(d, x) {
    if (x.lang === 'es')
      return {
        subject: `Tu correo pasó a la cuenta ${d.other} de Turbogol`,
        blocks: [
          p('Hola:'),
          p(`Desde el ${x.date(d.at)}, este correo es el de la cuenta ${d.other}. La cuenta ${d.name} ya no lo usa y sigue entrando con ${x.methods(d.methods)}.`),
          p('Si no fuiste tú, revisa PERFIL › Cuenta y seguridad en las dos cuentas.'),
        ],
      };
    return {
      subject: `Your email moved to the Turbogol account ${d.other}`,
      blocks: [
        p('Hi,'),
        p(`From ${x.date(d.at)}, this email belongs to the account ${d.other}. The account ${d.name} no longer uses it and keeps signing in with ${x.methods(d.methods)}.`),
        p("If this wasn't you, check PROFILE › Account and security on both accounts."),
      ],
    };
  },
};

// ---- Rendering ------------------------------------------------------------------------------------

const FOOTER_AUTO: Record<MailLang, string> = {
  es: 'Este correo es automático: no lo respondas.',
  en: "This is an automatic email: please don't reply.",
};
/** The line between the two versions of a notice, naming the second. */
const SECOND_HEADING: Record<MailLang, string> = { es: '— Español —', en: '— English —' };

const STYLE = {
  body: 'margin:0;padding:0;background:#ffffff',
  wrap: 'max-width:560px;margin:0 auto;padding:24px 16px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#1b1b1b',
  p: 'margin:0 0 16px',
  code: 'margin:0 0 16px;font-family:Consolas,Menlo,monospace;font-size:32px;font-weight:bold;letter-spacing:6px',
  a: 'color:#1d4ed8;font-weight:bold',
  url: 'font-size:13px;color:#555555;word-break:break-all',
  sep: 'margin:24px 0 16px;color:#555555',
  foot: 'margin:24px 0 0;font-size:13px;color:#555555',
};

function blocksText(blocks: readonly Block[]): string {
  let out = '';
  for (const b of blocks) {
    if (b.t === 'link') out += '\n' + b.url; // right under the line that introduces it
    else out += (out ? '\n\n' : '') + (b.t === 'code' ? b.code : b.s.map((s) => (typeof s === 'string' ? s : s.url)).join(''));
  }
  return out;
}

function blocksHtml(blocks: readonly Block[]): string {
  return blocks
    .map((b) => {
      if (b.t === 'code') return `<p style="${STYLE.code}">${escapeHtml(b.code)}</p>`;
      if (b.t === 'link') return `<p style="${STYLE.p}"><a href="${escapeHtml(b.url)}" style="${STYLE.a}">${escapeHtml(b.label)}</a><br><span style="${STYLE.url}">${escapeHtml(b.url)}</span></p>`;
      const inner = b.s.map((s) => (typeof s === 'string' ? escapeHtml(s) : `<a href="${escapeHtml(s.url)}" style="${STYLE.a}">${escapeHtml(s.url)}</a>`)).join('');
      return `<p style="${STYLE.p}">${inner}</p>`;
    })
    .join('\n');
}

/** Every value a template may print, cleaned (control characters, length) and checked (codes, tokens). */
function cleaned(d: MailData): MailData {
  const out = { ...d } as Record<string, unknown>;
  for (const k of ['name', 'other']) if (typeof out[k] === 'string') out[k] = clean(out[k] as string);
  if (typeof out.masked === 'string') out.masked = clean(out.masked as string, 254);
  if (typeof out.code === 'string') out.code = mustCode(out.code as string);
  if (typeof out.token === 'string') out.token = mustToken(out.token as string);
  for (const k of ['name', 'other', 'masked']) if (k in out && !out[k]) throw new Error(`mail: {${k}} is empty`);
  if ('at' in out && !Number.isFinite(out.at)) throw new Error('mail: a date is a time in ms');
  return out as MailData;
}

/**
 * One message in `ctx.lang`, or, for a security notice, in both languages with ctx.lang first:
 * the subject reads "first · second", and a line names the second version before it starts.
 */
export function renderMail(data: MailData, ctx: MailContext): RenderedMail {
  const origin = mustOrigin(ctx.origin);
  const d = cleaned(data);
  const host = new URL(origin).host;
  let link: string | undefined;
  const draft = (lang: MailLang): Draft => {
    const tools: Tools = {
      lang,
      origin,
      date: (at, style) => formatMailDate(at, lang, ctx.tz, style),
      methods: (ways) => methodsText(lang, ways),
      providers: (list) => providersText(lang, list),
      link: (kind, token, label) => {
        link = mailLink(origin, kind, token);
        return { t: 'link', url: link, label };
      },
    };
    const make = TEMPLATES[d.kind] as (d: MailData, x: Tools) => Draft;
    return make(d, tools);
  };
  const first = ctx.lang;
  const second: MailLang = first === 'es' ? 'en' : 'es';
  const a = draft(first);
  const b = isNotice(d.kind) ? draft(second) : null;
  const subject = clean(b ? `${a.subject} · ${b.subject}` : a.subject, 200);

  const footText = [`— Turbogol · ${host}`, FOOTER_AUTO[first], ...(b ? [FOOTER_AUTO[second]] : [])].join('\n');
  const text = [blocksText(a.blocks), ...(b ? [SECOND_HEADING[second], blocksText(b.blocks)] : []), footText].join('\n\n') + '\n';

  const footHtml = `<p style="${STYLE.foot}">— Turbogol · ${escapeHtml(host)}<br>${escapeHtml(FOOTER_AUTO[first])}${b ? `<br><span lang="${second}">${escapeHtml(FOOTER_AUTO[second])}</span>` : ''}</p>`;
  const html = [
    '<!doctype html>',
    `<html lang="${first}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>`,
    `<body style="${STYLE.body}"><div style="${STYLE.wrap}">`,
    blocksHtml(a.blocks),
    ...(b ? [`<div lang="${second}">`, `<p style="${STYLE.sep}">${escapeHtml(SECOND_HEADING[second])}</p>`, blocksHtml(b.blocks), '</div>'] : []),
    footHtml,
    '</div></body></html>',
  ].join('\n');

  const c = (d as { code?: string }).code;
  return { kind: d.kind, lang: first, subject, text, html, ...(link ? { link } : {}), ...(c ? { code: c } : {}) };
}
