/**
 * Ranked rating: the Weng-Lin Bayesian approximation (Weng & Lin 2011, "A Bayesian Approximation
 * Method for Online Ranking", the Bradley-Terry full-pair update; what OpenSkill implements), a
 * TrueSkill-like model: every player has a skill `mu` and an uncertainty `sigma` per playlist; a team's strength is the sum of its players' mu (variance =
 * sum of sigma^2); a win moves mu by more when the result was a surprise and when the player's
 * sigma is high, and every game shrinks sigma (tau adds a little back so ratings keep moving).
 *
 * Pure TypeScript, shared by the server (AccountsDO applies it to a finished ranked match) and the
 * client (tiers / labels). Displayed numbers ("MMR") are mu scaled by MMR_SCALE (mu 25 = 1000).
 *
 * Tuning (tests/rating.test.mjs): a new player (sigma 25/3) moves ~100 MMR per placement game; a
 * settled one (sigma converges near 1.75 with tau 0.125) ~10 MMR per game against an equal
 * opponent.
 */

export interface Rating {
  mu: number;
  sigma: number;
}

export const RATING = {
  mu: 25,
  sigma: 25 / 3,
  /** Performance noise of one game (half of the initial sigma, as in TrueSkill / OpenSkill). */
  beta: 25 / 6,
  /** Dynamics: added to sigma (in quadrature) before every game so a rating never freezes. */
  tau: 0.125,
  /** Floor of the sigma^2 shrink factor (numerical safety). */
  kappa: 1e-4,
} as const;

/** Displayed MMR = round(mu * MMR_SCALE). */
export const MMR_SCALE = 40;
/** Ranked games before a playlist shows a tier (placement). */
export const PLACEMENT_MATCHES = 5;
/** A leaver's teammates lose this fraction of what the defeat would cost them (abandon protection). */
export const LEAVER_TEAMMATE_LOSS_FACTOR = 0.5;

export function newRating(): Rating {
  return { mu: RATING.mu, sigma: RATING.sigma };
}

export function mmrOf(mu: number): number {
  return Math.round(mu * MMR_SCALE);
}

/**
 * New ratings of every player after one game between two or more teams. `ranks[i]` is team i's
 * finishing place (0 = first; equal ranks = a draw between them). Returns new arrays (inputs are
 * not mutated), same shape as `teams`. `tau` is injectable for the reference vectors (0 = no dynamics).
 */
export function rateTeams(teams: readonly (readonly Rating[])[], ranks: readonly number[], tau: number = RATING.tau): Rating[][] {
  if (teams.length < 2 || ranks.length !== teams.length) throw new Error('rateTeams: need >= 2 teams and one rank per team');
  const { beta, kappa } = RATING;
  const beta2 = beta * beta;
  const tau2 = tau * tau;
  // Dynamics first (OpenSkill does the same): sigma^2 + tau^2 for everyone.
  const pre: Rating[][] = teams.map((t) => {
    if (t.length === 0) throw new Error('rateTeams: empty team');
    return t.map((p) => ({ mu: p.mu, sigma: Math.sqrt(p.sigma * p.sigma + tau2) }));
  });
  const muT = pre.map((t) => t.reduce((s, p) => s + p.mu, 0));
  const s2T = pre.map((t) => t.reduce((s, p) => s + p.sigma * p.sigma, 0));
  const out: Rating[][] = [];
  for (let i = 0; i < pre.length; i++) {
    let omega = 0;
    let delta = 0;
    for (let q = 0; q < pre.length; q++) {
      if (q === i) continue;
      const c = Math.sqrt(s2T[i] + s2T[q] + 2 * beta2);
      // p_iq = e^(mu_i/c) / (e^(mu_i/c) + e^(mu_q/c)), written as a logistic (no overflow).
      const pIq = 1 / (1 + Math.exp((muT[q] - muT[i]) / c));
      const s = ranks[q] > ranks[i] ? 1 : ranks[q] === ranks[i] ? 0.5 : 0;
      omega += (s2T[i] / c) * (s - pIq);
      const gamma = Math.sqrt(s2T[i]) / c;
      delta += ((gamma * s2T[i]) / (c * c)) * pIq * (1 - pIq);
    }
    out.push(
      pre[i].map((p) => {
        const share = (p.sigma * p.sigma) / s2T[i];
        const mu = p.mu + share * omega;
        const sigma2 = p.sigma * p.sigma * Math.max(1 - share * delta, kappa);
        return { mu, sigma: Math.sqrt(sigma2) };
      }),
    );
  }
  return out;
}

/** One player of a finished two-team ranked match, as AccountsDO feeds it to rateRankedMatch. */
export interface RankedParticipant {
  id: string;
  team: 0 | 1;
  rating: Rating;
  /** Quit the match or was disconnected at the end: always rated as a defeat. */
  left: boolean;
}

export interface RatedResult {
  id: string;
  before: Rating;
  after: Rating;
  /** The result this player was rated with (a leaver always 'loss'). */
  outcome: 'win' | 'loss' | 'draw';
}

/**
 * Two-team ranked update with the abandon rules: `winner` 0 / 1, or -1 for a draw (a match the
 * server had to end tied). A leaver is rated as a loss whatever the score said; a teammate of a
 * leaver who lost loses only LEAVER_TEAMMATE_LOSS_FACTOR of the mu the defeat would cost (sigma
 * shrinks as usual); the opponents are rated on the real result.
 */
export function rateRankedMatch(players: readonly RankedParticipant[], winner: 0 | 1 | -1): RatedResult[] {
  const idx: [number[], number[]] = [[], []];
  players.forEach((p, i) => idx[p.team].push(i));
  if (idx[0].length === 0 || idx[1].length === 0) throw new Error('rateRankedMatch: both teams need a player');
  const teams = [idx[0].map((i) => players[i].rating), idx[1].map((i) => players[i].rating)];
  const scenario = (w: 0 | 1 | -1): Rating[][] => rateTeams(teams, w === -1 ? [0, 0] : w === 0 ? [0, 1] : [1, 0]);
  const real = scenario(winner);
  const lossCache: Array<Rating[][] | undefined> = [undefined, undefined];
  const lossOf = (team: 0 | 1): Rating[][] => (lossCache[team] ??= scenario(team === 0 ? 1 : 0));
  const leaverTeams = new Set(players.filter((p) => p.left).map((p) => p.team));
  return players.map((p, i) => {
    const pos = idx[p.team].indexOf(i);
    let after = real[p.team][pos];
    let outcome: RatedResult['outcome'] = winner === -1 ? 'draw' : winner === p.team ? 'win' : 'loss';
    if (p.left && outcome !== 'loss') {
      after = lossOf(p.team)[p.team][pos];
      outcome = 'loss';
    } else if (!p.left && outcome === 'loss' && leaverTeams.has(p.team)) {
      after = { mu: p.rating.mu + (after.mu - p.rating.mu) * LEAVER_TEAMMATE_LOSS_FACTOR, sigma: after.sigma };
    }
    return { id: p.id, before: p.rating, after, outcome };
  });
}

// ---- tiers ------------------------------------------------------------------------------------

export type TierFamily = 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond' | 'elite' | 'master' | 'legend';

export interface Tier {
  /** 'gold-2' */
  id: string;
  /** Tier family for the badge colour ('gold'). */
  family: TierFamily;
  /** 'Oro II' */
  name: string;
  /** Lowest displayed MMR of the tier. */
  min: number;
}

const FAMILIES: ReadonlyArray<{ family: TierFamily; name: string; mins: readonly number[] }> = [
  { family: 'bronze', name: 'Bronce', mins: [-Infinity, 640, 700] },
  { family: 'silver', name: 'Plata', mins: [760, 820, 880] },
  { family: 'gold', name: 'Oro', mins: [940, 1000, 1060] },
  { family: 'platinum', name: 'Platino', mins: [1120, 1180, 1240] },
  { family: 'diamond', name: 'Diamante', mins: [1300, 1370, 1440] },
  { family: 'elite', name: 'Élite', mins: [1510, 1590, 1670] },
  { family: 'master', name: 'Maestro', mins: [1750, 1850, 1950] },
  { family: 'legend', name: 'Leyenda', mins: [2050] },
];
const ROMAN = ['I', 'II', 'III'];

/** Every tier, lowest first. */
export const TIERS: readonly Tier[] = FAMILIES.flatMap((f) =>
  f.mins.map((min, d) => ({
    id: f.mins.length > 1 ? `${f.family}-${d + 1}` : f.family,
    family: f.family,
    name: f.mins.length > 1 ? `${f.name} ${ROMAN[d]}` : f.name,
    min,
  })),
);

export function tierOf(mmr: number): Tier {
  let t = TIERS[0];
  for (const x of TIERS) if (mmr >= x.min) t = x;
  return t;
}

/** Fraction (0..1) of the way from the current tier's floor to the next tier (1 at the top tier). */
export function tierProgress(mmr: number): number {
  const t = tierOf(mmr);
  const i = TIERS.indexOf(t);
  if (i === TIERS.length - 1) return 1;
  const lo = i === 0 ? TIERS[1].min - 60 : t.min;
  const hi = TIERS[i + 1].min;
  return Math.min(1, Math.max(0, (mmr - lo) / (hi - lo)));
}

// ---- abandon penalties ------------------------------------------------------------------------

/** Ranked queue ban after the n-th abandon (quit / no-show) within ABANDON_WINDOW_MS: 5 min, 15 min, 1 h, then 24 h. */
export const ABANDON_BANS_MS: readonly number[] = [5 * 60_000, 15 * 60_000, 60 * 60_000, 24 * 60 * 60_000];
export const ABANDON_WINDOW_MS = 24 * 60 * 60_000;

/** Ban length for an abandon that makes `countInWindow` abandons in the window (1 = the first). */
export function abandonBanMs(countInWindow: number): number {
  if (countInWindow <= 0) return 0;
  return ABANDON_BANS_MS[Math.min(countInWindow, ABANDON_BANS_MS.length) - 1];
}
