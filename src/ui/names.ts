/**
 * Display names for ids shared with the server. src/net/account.ts (PLAYLIST_NAMES, REGIONS) and
 * src/net/rating.ts (Tier.name) keep the Spanish names the Worker uses; the menus show these,
 * translated (src/i18n.ts).
 */
import { language, t } from '../i18n';
import type { CarId } from '../game/cosmetics';
import type { Playlist, RegionId } from '../net/account';
import { guestNumber } from '../net/guestName';
import type { Tier } from '../net/rating';
import type { Difficulty } from '../render/Hud';
import type { Quality } from '../render/quality';
import type { ThemeId } from '../render/theme';

/** Server points as the page's language writes them, grouped from the thousands (1,500 / 1.500), whole points only. */
export function formatPoints(n: number): string {
  // 'always': Spanish groups four-digit numbers too (1.500, as the owner drew them).
  const opts = { useGrouping: 'always', maximumFractionDigits: 0 } as unknown as Intl.NumberFormatOptions;
  return new Intl.NumberFormat(language(), opts).format(Math.max(0, Math.floor(n)));
}

/** A playlist by its format alone ('2v2' in every language: the owner's rule, no "pairs"). */
export function playlistName(p: Playlist): string {
  return p;
}

export function regionName(id: RegionId): string {
  return t(`region.${id}`);
}

/**
 * A player's name as the page shows it: a guest's wire name ('Invitado 4821', the server's,
 * src/net/guestName.ts) in this page's language ('Guest 4821'), any other name as it is.
 */
export function playerName(raw: string): string {
  const n = guestNumber(raw);
  return n === null ? raw : t('guest.name', { n });
}

/**
 * A lobby's title as the page shows it. The server's default title is the host's wire name, so a
 * title equal to the host's name, or a guest's, reads as custom.defaultName with the host
 * ('Sala de Invitado 4821', 'Lobby Guest 4821', 'Lobby Ana'); a title a host typed, as it is. No
 * host known (`''`: nobody in the lobby yet) reads the guest's title's own name.
 */
export function lobbyTitle(title: string, host: string): string {
  if (title !== host && guestNumber(title) === null) return title;
  return t('custom.defaultName', { name: playerName(host.length > 0 ? host : title) });
}

export function difficultyName(d: Difficulty): string {
  return t(`difficulty.${d}`);
}

/** A graphics quality tier: 'Performance', 'High', 'Ultra'. */
export function qualityName(q: Quality): string {
  return t(`quality.${q}`);
}

/** A stadium theme: 'Night harbour', 'Red canyon'... */
export function themeName(id: ThemeId): string {
  return t(`theme.${id}`);
}

/** A cosmetic car (src/game/cosmetics.ts): 'Dune', 'Pampero'... */
export function carName(id: CarId): string {
  return t(`car.${id}`);
}

/** A cosmetic car's one line under its name. */
export function carDescription(id: CarId): string {
  return t(`car.${id}Desc`);
}

const ROMAN = ['I', 'II', 'III'];

/** 'Gold II' from a tier ('gold-2'); single-division tiers ('legend') have no numeral. */
export function tierName(tier: Pick<Tier, 'id' | 'family'>): string {
  const family = t(`tier.${tier.family}`);
  const division = /-(\d)$/.exec(tier.id);
  if (division === null) return family;
  return t('tier.division', { tier: family, division: ROMAN[Number(division[1]) - 1] ?? division[1] });
}
