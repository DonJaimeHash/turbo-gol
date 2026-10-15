/**
 * Translations. English (src/locales/en.ts) is the source of truth and the fallback for every
 * missing text; the other files in src/locales translate it (CONTRIBUTING.md, "Translating").
 *
 *   t(key, params)   the text in the current language, `{name}` placeholders filled from params;
 *                    a plural text picks its form with Intl.PluralRules from params.count
 *   duration(ms)     "5 min", "30 s"... in the current language (Intl.NumberFormat units)
 *   serverText(...)  a server error by its machine code, or the server's own message
 *   setLanguage(c)   save the choice (null = follow the system) and reload the page
 *
 * The language is fixed for the page's lifetime: a saved choice (localStorage), else the first
 * of navigator.languages we ship (exact tag, then its base: es-AR -> es), else English. Menu
 * screens are built once and cached, so a change reloads the page instead of re-rendering.
 *
 * Shared with the Cloudflare Worker: src/net/account.ts, rating.ts, protocol.ts, p2p/protocol.ts,
 * game/Match.ts, ai/* and sim/* must never import this module (no DOM there).
 * The locale files may only `import type`: a runtime import would create a cycle at startup.
 */
import en from './locales/en';
import es from './locales/es';
import { STORAGE_PREFIX } from './brand';

/** A text with plural forms: `other` always, the categories the language uses (Intl.PluralRules) optionally. */
export type Plural = { other: string } & Partial<Record<Intl.LDMLPluralRule, string>>;
export type Messages = Record<string, string | Plural>;
export type Key = keyof typeof en;
/** A locale file: any subset of the English keys (the rest falls back to English), same kind of value. */
export type Translation = { [K in Key]?: (typeof en)[K] extends string ? string : Plural };
export type Params = Record<string, string | number>;

interface Locale {
  /** The language's own name (endonym), shown in the language picker. */
  name: string;
  messages: Translation;
}

/** Every shipped language, one line each (a new locale file is registered here). */
export const LOCALES = {
  en: { name: 'English', messages: en },
  es: { name: 'Español', messages: es },
} satisfies Record<string, Locale>;

export type LanguageCode = keyof typeof LOCALES;

const DEFAULT_LANGUAGE: LanguageCode = 'en';
const LANG_KEY = STORAGE_PREFIX + 'lang';

function isLanguage(code: string): code is LanguageCode {
  return Object.prototype.hasOwnProperty.call(LOCALES, code);
}

/**
 * The language to use: `saved` when it is a shipped one, else the first entry of `wanted` (a
 * navigator.languages list) shipped as is or by its base language, else English. Case-insensitive.
 */
export function pickLanguage(saved: string | null, wanted: readonly string[]): LanguageCode {
  if (saved !== null) {
    const s = saved.toLowerCase();
    if (isLanguage(s)) return s;
  }
  for (const tag of wanted) {
    const t = tag.toLowerCase();
    if (isLanguage(t)) return t;
    const base = t.split('-')[0];
    if (isLanguage(base)) return base;
  }
  return DEFAULT_LANGUAGE;
}

function readSaved(): string | null {
  try {
    return localStorage.getItem(LANG_KEY);
  } catch {
    return null; // storage blocked
  }
}

function systemLanguages(): readonly string[] {
  const nav = window.navigator;
  return nav.languages !== undefined && nav.languages.length > 0 ? nav.languages : [nav.language];
}

/** Outside a browser (node tests, which share the OS locale through navigator) it is always English. */
function detect(): LanguageCode {
  if (typeof window === 'undefined') return DEFAULT_LANGUAGE;
  try {
    return pickLanguage(readSaved(), systemLanguages());
  } catch {
    return DEFAULT_LANGUAGE; // never leave the page blank over a language
  }
}

const current: LanguageCode = detect();
if (typeof document !== 'undefined') {
  try {
    document.documentElement.lang = current;
  } catch {
    /* no root element */
  }
}

/** The language of this page load. */
export function language(): LanguageCode {
  return current;
}

/** The language the system would get with no saved choice (the picker's "Automatic (...)" entry). */
export function systemLanguage(): LanguageCode {
  if (typeof window === 'undefined') return DEFAULT_LANGUAGE;
  try {
    return pickLanguage(null, systemLanguages());
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

/** The saved choice, or null when the language follows the system. */
export function savedLanguage(): LanguageCode | null {
  const s = readSaved();
  return s !== null && isLanguage(s) ? s : null;
}

/** Save the choice (null = follow the system again) and reload: the menus are built once per page. */
export function setLanguage(code: LanguageCode | null): void {
  try {
    if (code === null) localStorage.removeItem(LANG_KEY);
    else localStorage.setItem(LANG_KEY, code);
  } catch {
    /* storage blocked: the reload keeps the detected language */
  }
  location.reload();
}

const pluralRules = new Map<string, Intl.PluralRules>();

/**
 * Fill a message for `locale`: a plural picks the form for params.count (falling back to
 * `other`), then each `{name}` takes String(params.name). An unknown placeholder stays visible.
 */
export function formatMessage(message: string | Plural, params: Params | undefined, locale: string): string {
  let text: string;
  if (typeof message === 'string') text = message;
  else {
    let rules = pluralRules.get(locale);
    if (rules === undefined) {
      rules = new Intl.PluralRules(locale);
      pluralRules.set(locale, rules);
    }
    const form = rules.select(Number(params?.count ?? 0));
    text = message[form] ?? message.other;
  }
  if (params === undefined) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole));
}

/** The text for `key` from `messages` (English when they lack it), formatted for `locale`. */
export function textIn(messages: Translation, locale: string, key: Key, params?: Params): string {
  const message = (messages[key] ?? en[key]) as string | Plural;
  return formatMessage(message, params, locale);
}

/** The text for `key` in the current language (English when this language lacks it). */
export function t(key: Key, params?: Params): string {
  return textIn(LOCALES[current].messages, current, key, params);
}

/** A wait or a ban length, rounded up to whole seconds, minutes or hours: "45 s", "5 min", "24 h". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const unit = s < 60 ? 'second' : s < 3600 ? 'minute' : 'hour';
  const value = unit === 'second' ? s : unit === 'minute' ? Math.ceil(s / 60) : Math.ceil(s / 3600);
  return new Intl.NumberFormat(current, { style: 'unit', unit, unitDisplay: 'short' }).format(value);
}

/** Server error codes whose server message carries details the translations cannot (Spanish servers only). */
const SERVER_DETAIL_CODES: ReadonlySet<string> = new Set(['bad_password', 'busy', 'not_host', 'member_busy', 'rate_limited']);

/**
 * A server error for the player: the `error.<surface>.<code>` text when the client has one, else
 * the server's own message. The server writes its messages in Spanish, so for the few codes it
 * fills with details (SERVER_DETAIL_CODES) Spanish players keep the server's message.
 */
export function serverText(surface: 'account' | 'lobby' | 'queue', code: string, fallback: string, params?: Params): string {
  const key = `error.${surface}.${code}`;
  if (!Object.prototype.hasOwnProperty.call(en, key)) return fallback;
  if (current === 'es' && SERVER_DETAIL_CODES.has(code) && fallback.length > 0) return fallback;
  return t(key as Key, params);
}
