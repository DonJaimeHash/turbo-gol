/**
 * Experimental physics rules (Settings > Experimental, signed-in players only): which values a
 * player may tune, on which grid, the read-only built-in presets, and the parsers every side
 * shares (the client's local copy, AccountStore on the server, later the lobby / matchmaker /
 * room checks). Pure: no DOM, no i18n, no `const enum`, so node's type-stripping loader, the
 * Worker and the Durable Objects import it as it is (like trainingRecords.ts).
 *
 * Every value is an INTEGER: a percentage of the stock value, a figure in uu/s, one of a few
 * options, or a 0 / 1 toggle. A set of values (`PhysicsValues`) holds only the keys that differ
 * from the default; a missing key IS the default. No range has more than MAX_RANGE_STEPS steps
 * (a pad's left / right has no hold-repeat). The UI groups the rows by `group`; `scope:
 * 'training'` rows (game speed) exist only in experimental free play, never in a match.
 *
 * This file stops at the integers. The physics core (src/sim/mutators.ts, its own pull request)
 * maps them to the wasm's float layout and holds the C++ hard limits, which are wider than every
 * range here (tests/physics-rules.test.mjs checks the ranges against the limits the design
 * gives). `PhysicsRules` is the hand-over: the canonical integers plus PHYSICS_SCHEMA.
 *
 * Validation has two modes (`parsePhysicsValues`):
 *   strict   (a rules snapshot: a lobby, the matchmaker, a room, a room welcome) refuses anything
 *            that is not exactly a grid value of a known key allowed in that context;
 *   lenient  (account storage, the local copy, server answers) drops unknown keys and snaps a
 *            value to the nearest grid value, so old presets stay valid when a later schema adds,
 *            narrows or removes a field.
 * Preset names follow the lobby name rules (src/net/account.ts sanitizeLobbyName: 3-24
 * characters, letters, digits, space and `_ . - ! ? #`).
 */
import { LOBBY_NAME_MAX, sanitizeLobbyName } from '../net/account';

/** Version of the value table (a snapshot's `v`, the hand-over to the physics core). */
export const PHYSICS_SCHEMA = 1;
/** Presets an account keeps (the built-ins do not count). */
export const MAX_PRESETS = 10;
/** No range has more steps than this (a pad's left / right has no hold-repeat). */
export const MAX_RANGE_STEPS = 18;

export type PhysicsKey =
  | 'gravity'
  | 'gameSpeed'
  | 'ballMaxSpeed'
  | 'ballHit'
  | 'ballWeight'
  | 'ballBounce'
  | 'ballDrag'
  | 'carMaxSpeed'
  | 'boostPower'
  | 'boostUse'
  | 'spawnBoost'
  | 'jumpPower'
  | 'unlimitedFlips'
  | 'unlimitedDoubleJumps'
  | 'bumpForce'
  | 'demoMode'
  | 'respawnDelay';

/** The editor's row groups, in order. */
export type PhysicsGroup = 'world' | 'ball' | 'car' | 'contact';
export const PHYSICS_GROUPS: readonly PhysicsGroup[] = ['world', 'ball', 'car', 'contact'];

/** Where a value applies: 'all' (experimental free play and P2P lobbies) or free play only. */
export type PhysicsScope = 'all' | 'training';

/** Where a set of values is used: free play takes every key, a match refuses the 'training' ones. */
export type PhysicsContext = 'training' | 'match';

/**
 * How the UI shows a value: 'percent' of standard, 'speed' (stored in uu/s or as a percentage of
 * a speed, shown in km/h like the HUD), 'count' (a plain number: boost at kickoff), 'seconds',
 * 'toggle' (0 off, 1 on), 'option' (an index into named options: demolitions).
 */
export type PhysicsDisplay = 'percent' | 'speed' | 'count' | 'seconds' | 'toggle' | 'option';

interface FieldBase {
  readonly key: PhysicsKey;
  readonly group: PhysicsGroup;
  readonly scope: PhysicsScope;
  /** The stock value (always on the field's grid): the physics core maps it to the exact stock float. */
  readonly default: number;
  readonly display: PhysicsDisplay;
}

/** min..max by step (integers; `default` is on the grid). */
export interface RangeField extends FieldBase {
  readonly kind: 'range';
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

/** One of a few integers (stored as the integer itself). */
export interface ChoiceField extends FieldBase {
  readonly kind: 'choice';
  readonly options: readonly number[];
}

/** 0 or 1. */
export interface ToggleField extends FieldBase {
  readonly kind: 'toggle';
}

export type PhysicsField = RangeField | ChoiceField | ToggleField;

function range(key: PhysicsKey, group: PhysicsGroup, min: number, max: number, step: number, def: number, display: PhysicsDisplay = 'percent', scope: PhysicsScope = 'all'): RangeField {
  return { key, group, scope, kind: 'range', min, max, step, default: def, display };
}

function choice(key: PhysicsKey, group: PhysicsGroup, options: readonly number[], def: number, display: PhysicsDisplay): ChoiceField {
  return { key, group, scope: 'all', kind: 'choice', options, default: def, display };
}

function toggle(key: PhysicsKey, group: PhysicsGroup): ToggleField {
  return { key, group, scope: 'all', kind: 'toggle', default: 0, display: 'toggle' };
}

/**
 * The table, in editor order (docs: the experimental design, section 3). What each value sets in
 * the physics core, for reference (src/sim/mutators.ts owns the mapping):
 *   gravity        % of -650 uu/s^2              ballMaxSpeed  % of 6000 uu/s
 *   ballHit        hit force scale (% of 1)      ballWeight    % of the ball's 30 mass
 *   ballBounce     % of the 0.6 restitution      ballDrag      % of the 0.03 drag
 *   carMaxSpeed    uu/s (stock 2300; supersonic thresholds scaled)
 *   boostPower     % of both boost accelerations boostUse      % of 33.3 per second (0 = endless)
 *   spawnBoost     boost at kickoff (33 = 100/3) jumpPower     % of the first jump's force and hold
 *   bumpForce      bump force scale (% of 1)     demoMode      0 normal, 1 on contact, 2 off
 *   respawnDelay   seconds
 *   gameSpeed      free play only: the game's clock runs at this % (never above 100)
 */
export const PHYSICS_FIELDS: readonly PhysicsField[] = [
  range('gravity', 'world', 30, 200, 10, 100),
  range('gameSpeed', 'world', 25, 100, 5, 100, 'percent', 'training'),
  range('ballMaxSpeed', 'ball', 50, 130, 5, 100, 'speed'),
  range('ballHit', 'ball', 50, 200, 10, 100),
  range('ballWeight', 'ball', 50, 200, 10, 100),
  range('ballBounce', 'ball', 50, 150, 10, 100),
  range('ballDrag', 'ball', 0, 300, 25, 100),
  range('carMaxSpeed', 'car', 2000, 2600, 50, 2300, 'speed'),
  range('boostPower', 'car', 50, 200, 10, 100),
  range('boostUse', 'car', 0, 200, 25, 100),
  choice('spawnBoost', 'car', [0, 33, 50, 75, 100], 33, 'count'),
  range('jumpPower', 'car', 50, 150, 10, 100),
  toggle('unlimitedFlips', 'car'),
  toggle('unlimitedDoubleJumps', 'car'),
  range('bumpForce', 'contact', 0, 300, 25, 100),
  choice('demoMode', 'contact', [0, 1, 2], 0, 'option'),
  choice('respawnDelay', 'contact', [1, 2, 3, 4, 5], 3, 'seconds'),
];

export const PHYSICS_KEYS: readonly PhysicsKey[] = PHYSICS_FIELDS.map((f) => f.key);

const FIELD_BY_KEY: ReadonlyMap<string, PhysicsField> = new Map(PHYSICS_FIELDS.map((f) => [f.key, f]));

/** The field of `key`, undefined for anything else ('__proto__' included). */
export function physicsField(key: string): PhysicsField | undefined {
  return FIELD_BY_KEY.get(key);
}

/** A set of values: only the non-default keys, all integers on their grid. */
export type PhysicsValues = Partial<Record<PhysicsKey, number>>;

/**
 * The hand-over to the physics core (src/sim/mutators.ts): the table version and the canonical
 * integers. The core turns them into its float layout once, when an arena is created.
 */
export interface PhysicsRules {
  readonly v: number;
  readonly values: Readonly<PhysicsValues>;
}

/** Every value of a field's grid, lowest first. */
export function fieldValues(f: PhysicsField): number[] {
  if (f.kind === 'toggle') return [0, 1];
  if (f.kind === 'choice') return [...f.options];
  const out: number[] = [];
  for (let v = f.min; v <= f.max; v += f.step) out.push(v);
  return out;
}

/** `v` is exactly one of the field's values. */
export function onGrid(f: PhysicsField, v: number): boolean {
  if (!Number.isInteger(v)) return false;
  if (f.kind === 'toggle') return v === 0 || v === 1;
  if (f.kind === 'choice') return f.options.includes(v);
  return v >= f.min && v <= f.max && (v - f.min) % f.step === 0;
}

/** The field's value nearest to `v` (a finite number); a tie takes the lower one. */
export function snapToGrid(f: PhysicsField, v: number): number {
  if (f.kind === 'range') {
    const n = Math.round((Math.min(f.max, Math.max(f.min, v)) - f.min) / f.step);
    return Math.min(f.max, f.min + n * f.step);
  }
  const grid = fieldValues(f);
  let best = grid[0];
  for (const g of grid) if (Math.abs(g - v) < Math.abs(best - v)) best = g;
  return best;
}

/** A set of values: the value of `key` (its default when absent). */
export function valueOf(values: Readonly<PhysicsValues>, key: PhysicsKey): number {
  const v = values[key];
  return v === undefined ? (FIELD_BY_KEY.get(key) as PhysicsField).default : v;
}

/** The most keys a raw object may carry before it is refused (strict) or cut (lenient): bounds the work. */
const MAX_RAW_KEYS = 64;

function plainObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

/**
 * Decoded JSON to canonical values (table order, defaults omitted), for `context`. 'strict': null
 * for anything but a plain object of known keys allowed in the context with integer grid values;
 * 'lenient': never null, unknown and disallowed keys dropped, finite numbers snapped to the grid,
 * anything else dropped.
 */
export function parsePhysicsValues(raw: unknown, mode: 'strict', context?: PhysicsContext): PhysicsValues | null;
export function parsePhysicsValues(raw: unknown, mode: 'lenient', context?: PhysicsContext): PhysicsValues;
export function parsePhysicsValues(raw: unknown, mode: 'strict' | 'lenient', context: PhysicsContext = 'training'): PhysicsValues | null {
  const strict = mode === 'strict';
  if (!plainObject(raw)) return strict ? null : {};
  const keys = Object.keys(raw);
  if (keys.length > MAX_RAW_KEYS && strict) return null;
  const got = new Map<PhysicsKey, number>();
  for (const key of keys.slice(0, MAX_RAW_KEYS)) {
    const f = FIELD_BY_KEY.get(key);
    const v = raw[key];
    if (f === undefined || (f.scope === 'training' && context === 'match')) {
      if (strict) return null;
      continue;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      if (strict) return null;
      continue;
    }
    if (strict && !onGrid(f, v)) return null;
    got.set(f.key, strict ? v : snapToGrid(f, v));
  }
  const out: PhysicsValues = {};
  for (const f of PHYSICS_FIELDS) {
    const v = got.get(f.key);
    if (v !== undefined && v !== f.default) out[f.key] = v;
  }
  return out;
}

/** The canonical form of valid values (table order, defaults omitted; 'match' drops the free-play keys). */
export function canonicalValues(values: Readonly<PhysicsValues>, context: PhysicsContext = 'training'): PhysicsValues {
  return parsePhysicsValues(values, 'lenient', context);
}

/** No value differs from standard (in `context`: a match ignores the free-play keys). */
export function isStock(values: Readonly<PhysicsValues>, context: PhysicsContext = 'training'): boolean {
  return Object.keys(canonicalValues(values, context)).length === 0;
}

/** The same values (after both are made canonical). */
export function sameValues(a: Readonly<PhysicsValues>, b: Readonly<PhysicsValues>): boolean {
  const x = canonicalValues(a);
  const y = canonicalValues(b);
  const kx = Object.keys(x) as PhysicsKey[];
  return kx.length === Object.keys(y).length && kx.every((k) => x[k] === y[k]);
}

/** The rules the physics core gets for `values` (canonical for `context`). */
export function rulesOf(values: Readonly<PhysicsValues>, context: PhysicsContext = 'match'): PhysicsRules {
  return { v: PHYSICS_SCHEMA, values: canonicalValues(values, context) };
}

/** The keys that differ from standard, in table order, at most `n` (the UI's one-line summaries). */
export function summarizeChanges(values: Readonly<PhysicsValues>, n = Infinity, context: PhysicsContext = 'training'): Array<{ key: PhysicsKey; value: number }> {
  const c = canonicalValues(values, context);
  const out: Array<{ key: PhysicsKey; value: number }> = [];
  for (const f of PHYSICS_FIELDS) {
    if (out.length >= n) break;
    const v = c[f.key];
    if (v !== undefined) out.push({ key: f.key, value: v });
  }
  return out;
}

// ---- presets ------------------------------------------------------------------------------------

/** The built-ins: read-only, the same for everybody, named by the UI (`rules.builtin.<id>`). */
export type BuiltInId = 'standard' | 'lowGravity' | 'fastBall' | 'bouncy' | 'arcade';

export interface BuiltInPreset {
  readonly id: BuiltInId;
  readonly values: Readonly<PhysicsValues>;
}

export const BUILT_IN_PRESETS: readonly BuiltInPreset[] = [
  { id: 'standard', values: {} },
  { id: 'lowGravity', values: { gravity: 50, ballDrag: 50 } },
  { id: 'fastBall', values: { ballMaxSpeed: 130, ballHit: 150, ballWeight: 80 } },
  { id: 'bouncy', values: { gravity: 80, ballBounce: 150, ballWeight: 70 } },
  { id: 'arcade', values: { carMaxSpeed: 2600, boostPower: 130, boostUse: 0, spawnBoost: 100, unlimitedFlips: 1, bumpForce: 150 } },
];

export function isBuiltInId(id: unknown): id is BuiltInId {
  return BUILT_IN_PRESETS.some((p) => p.id === id);
}

/** A player's own preset (the account keeps MAX_PRESETS of them). */
export interface StoredPreset {
  /** 12 lowercase hex characters, made by the client (`newPresetId`). */
  id: string;
  /** sanitizeLobbyName's form. */
  name: string;
  /** Canonical, lenient-parsed (free-play keys allowed). */
  values: PhysicsValues;
  /** When the server stored this version (ms); 0 = not on the server yet. */
  updatedAt: number;
}

export const PRESET_ID_RE = /^[0-9a-f]{12}$/;

/** A new preset id from `random(n)`: n random bytes (crypto.getRandomValues by default). */
export function newPresetId(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const b = random(6);
  let s = '';
  for (let i = 0; i < 6; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
  return s;
}

/**
 * Decoded JSON to a stored preset (lenient values, the name sanitized), or null when the id is
 * not a preset id or the name does not survive the sanitizer.
 */
export function parseStoredPreset(raw: unknown): StoredPreset | null {
  if (!plainObject(raw)) return null;
  if (typeof raw.id !== 'string' || !PRESET_ID_RE.test(raw.id)) return null;
  const name = sanitizeLobbyName(raw.name);
  if (name === null) return null;
  const at = raw.updatedAt;
  const updatedAt = typeof at === 'number' && Number.isInteger(at) && at >= 0 ? at : 0;
  return { id: raw.id, name, values: parsePhysicsValues(raw.values, 'lenient'), updatedAt };
}

/** A list of presets (the first copy of each id, at most `max`); garbage gives []. */
export function parsePresetList(raw: unknown, max: number = MAX_PRESETS): StoredPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredPreset[] = [];
  for (const r of raw) {
    if (out.length >= max) break;
    const p = parseStoredPreset(r);
    if (p !== null && !out.some((q) => q.id === p.id)) out.push(p);
  }
  return out;
}

/**
 * The rules a lobby carries (settings, matchmaker, room, welcome): a COPY of the host's preset at
 * the time, never a reference to it.
 */
export interface RulesSnapshot {
  v: number;
  name: string;
  values: PhysicsValues;
}

/** A snapshot of `values` named `name` (the free-play keys dropped), null when the name is not valid. */
export function snapshotOf(name: string, values: Readonly<PhysicsValues>): RulesSnapshot | null {
  const n = sanitizeLobbyName(name);
  return n === null ? null : { v: PHYSICS_SCHEMA, name: n, values: canonicalValues(values, 'match') };
}

/** Strict: a snapshot exactly as snapshotOf makes it, else null (the server answers 400 bad_physics). */
export function parseRulesSnapshot(raw: unknown): RulesSnapshot | null {
  if (!plainObject(raw) || raw.v !== PHYSICS_SCHEMA) return null;
  if (typeof raw.name !== 'string' || sanitizeLobbyName(raw.name) !== raw.name) return null;
  const values = parsePhysicsValues(raw.values, 'strict', 'match');
  return values === null ? null : { v: PHYSICS_SCHEMA, name: raw.name, values };
}

// ---- names --------------------------------------------------------------------------------------

function nameKey(name: string): string {
  return name.toLocaleLowerCase();
}

/**
 * The first free automatic name ("My rules 1", "My rules 2"...): `template(n)` is the locale's
 * text (rules.defaultName). Already sanitized.
 */
export function defaultPresetName(existing: readonly string[], template: (n: number) => string): string {
  const used = new Set(existing.map(nameKey));
  for (let n = 1; ; n++) {
    const name = sanitizeLobbyName(template(n)) ?? `Rules ${n}`;
    if (!used.has(nameKey(name))) return name;
  }
}

/**
 * The name of a copy of `base` ("{name} #{n}" through `template`, rules.copyName): the first free
 * n from 2, a copy of a copy numbered from its original ("Low #2" -> "Low #3"), the base shortened
 * so the result fits LOBBY_NAME_MAX. Already sanitized.
 */
export function copyPresetName(base: string, existing: readonly string[], template: (name: string, n: number) => string): string {
  const used = new Set(existing.map(nameKey));
  const root = base.replace(/\s+#\d+$/, '');
  for (let n = 2; ; n++) {
    const suffix = template('', n);
    const room = Math.max(1, LOBBY_NAME_MAX - suffix.length);
    const name = sanitizeLobbyName(template(root.slice(0, room).trimEnd(), n));
    if (name !== null && !used.has(nameKey(name))) return name;
    if (n > 999) return sanitizeLobbyName(template('Rules', n)) ?? 'Rules';
  }
}
