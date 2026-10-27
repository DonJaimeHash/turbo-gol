/**
 * Display names for ids shared with the server. src/net/account.ts (PLAYLIST_NAMES, REGIONS) and
 * src/net/rating.ts (Tier.name) keep the Spanish names the Worker uses; the menus show these,
 * translated (src/i18n.ts).
 */
import { t } from '../i18n';
import type { Playlist, RegionId } from '../net/account';
import type { Tier } from '../net/rating';
import type { Difficulty } from '../render/Hud';
import type { Quality } from '../render/quality';
import type { ThemeId } from '../render/theme';

/** A playlist by its format alone ('2v2' in every language: the owner's rule, no "pairs"). */
export function playlistName(p: Playlist): string {
  return p;
}

export function regionName(id: RegionId): string {
  return t(`region.${id}`);
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

const ROMAN = ['I', 'II', 'III'];

/** 'Gold II' from a tier ('gold-2'); single-division tiers ('legend') have no numeral. */
export function tierName(tier: Pick<Tier, 'id' | 'family'>): string {
  const family = t(`tier.${tier.family}`);
  const division = /-(\d)$/.exec(tier.id);
  if (division === null) return family;
  return t('tier.division', { tier: family, division: ROMAN[Number(division[1]) - 1] ?? division[1] });
}
