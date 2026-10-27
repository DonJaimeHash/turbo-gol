/**
 * Rank badges and labels (CSS-drawn, no image assets): a shield in the tier family's colours with
 * the division pips (I / II / III), plus the unranked badge during placement. Colours live
 * in menu.css (`.mn-badge-<family>`).
 */
import { TIERS, tierOf } from '../net/rating';
import type { Tier } from '../net/rating';
import type { PlaylistRating } from '../net/account';
import { h } from './dom';
import { playlistName, tierName } from './names';
import { t } from '../i18n';

export function tierById(id: string | null): Tier | null {
  if (id === null) return null;
  return TIERS.find((t) => t.id === id) ?? null;
}

/** Division number (1-3) of a tier id, 0 for single-division tiers. */
function division(t: Tier): number {
  const m = /-(\d)$/.exec(t.id);
  return m ? Number(m[1]) : 0;
}

/** The badge: `size` in px (the CSS scales everything from it). */
export function rankBadge(tier: Tier | null, size = 56): HTMLElement {
  const fam = tier ? tier.family : 'unranked';
  const d = tier ? division(tier) : 0;
  const pips = h('div.mn-badge-pips');
  for (let i = 0; i < d; i++) pips.appendChild(h('span'));
  const name = tier ? tierName(tier) : t('badge.unranked');
  const b = h(`div.mn-badge.mn-badge-${fam}`, { title: name, 'aria-label': name }, h('div.mn-badge-gem'), pips);
  b.style.setProperty('--badge', `${size}px`);
  return b;
}

/** Badge + labels of one playlist's standing (ranked screen, profile). */
export function ratingCard(r: PlaylistRating, extra?: Node | null): HTMLElement {
  const tier = tierById(r.tier);
  const placed = r.placementLeft === 0;
  const games = r.wins + r.losses;
  return h(
    'div.mn-rating',
    null,
    rankBadge(tier, 64),
    h(
      'div.mn-rating-text',
      null,
      h('div.mn-rating-playlist', null, playlistName(r.playlist)),
      h('div.mn-rating-tier', null, placed && tier ? tierName(tier) : t('badge.unranked')),
      h('div.mn-rating-sub', null, placed ? t('badge.mmr', { mmr: r.mmr }) : t('badge.placement', { played: r.games, total: r.games + r.placementLeft })),
      h('div.mn-rating-sub', null, games > 0 ? t('badge.record', { wins: r.wins, losses: r.losses }) : t('badge.noGames')),
    ),
    extra ?? null,
  );
}

export { tierOf };
