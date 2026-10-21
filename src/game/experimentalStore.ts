/**
 * Experimental features of a signed-in account (Settings > Experimental): the switch and the
 * physics presets (src/game/physicsRules.ts). Guests have none of it: every read answers "off" /
 * the built-ins only, every write is refused.
 *
 *   account   the server (GET / POST /api/me/experimental, /api/me/presets through `remote`) plus
 *             a local copy per account under experimentalKey(playerId): { enabled, enabledDirty,
 *             presets, dirty, lastUsed }. Reads come from the copy at once (the boot reads it
 *             before the account is restored: `unlockedAtBoot`); sync() pushes what this browser
 *             changed, then pulls the account's state.
 *
 * Writes:
 *   - the switch is saved here at once and sent to the server right away; offline it stays
 *     `enabledDirty` and goes up with the next sync;
 *   - a preset edit (create, duplicate, rename, values) is saved here at once and marked dirty;
 *     the upload is debounced (`flush`: when the settings screen closes, when another preset is
 *     picked, or PUSH_DELAY_MS after the last edit), one preset per request. Offline it stays
 *     dirty (one 'offline' problem: "saved on this device") and goes up with the next push;
 *   - deleting needs the server (offline: the 'delete_offline' problem), so there are no
 *     tombstones to keep.
 * Conflicts: last write wins, by the server's updatedAt. A pull keeps the local version of a dirty
 * preset and takes the server's for everything else (a preset deleted on another device goes).
 *
 * Every storage access is wrapped (private mode, a sandboxed frame, a full quota): the copy then
 * lives in memory for the page. Saved data is parsed leniently, so corrupt storage never reaches
 * the UI. Sign-out keeps the copy (the next sign-in of that account reads it), like training.
 */
import { STORAGE_PREFIX } from '../brand';
import { readAccountHint } from '../net/AccountClient';
import type { ExperimentalAnswer } from '../net/account';
import { sanitizeLobbyName } from '../net/account';
import {
  BUILT_IN_PRESETS,
  MAX_PRESETS,
  canonicalValues,
  isBuiltInId,
  newPresetId,
  parsePresetList,
  sameValues,
  type PhysicsValues,
  type StoredPreset,
} from './physicsRules';
import { defaultTrainingStorage, type StorageLike } from './trainingRecords';

export const EXPERIMENTAL_KEY = STORAGE_PREFIX + 'experimental.v1';
/** A preset edit goes up this long after the last one (unless a flush comes first). */
export const PUSH_DELAY_MS = 5000;
/** After a local switch change, /api/me's value of the switch is ignored this long (it may predate the change). */
export const NOTE_GRACE_MS = 30_000;

/** The local copy of an account's experimental state (the account id is the session `sub`). */
export function experimentalKey(playerId: string): string {
  return EXPERIMENTAL_KEY + '.' + playerId;
}

export interface ExperimentalCache {
  enabled: boolean;
  /** The switch changed here and the account does not know yet. */
  enabledDirty: boolean;
  presets: StoredPreset[];
  /** Ids of presets changed here that the account does not hold in this version yet. */
  dirty: string[];
  /** The preset picked last: a built-in id or one of `presets` (null = none yet: standard). */
  lastUsed: string | null;
}

function emptyCache(): ExperimentalCache {
  return { enabled: false, enabledDirty: false, presets: [], dirty: [], lastUsed: null };
}

/** Decoded JSON to a cache (lenient: anything malformed is dropped, at most 2 x MAX_PRESETS presets). */
export function parseExperimentalCache(raw: unknown): ExperimentalCache {
  const c = emptyCache();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return c;
  const o = raw as Record<string, unknown>;
  c.enabled = o.enabled === true;
  c.enabledDirty = o.enabledDirty === true;
  c.presets = parsePresetList(o.presets, MAX_PRESETS * 2);
  if (Array.isArray(o.dirty)) c.dirty = o.dirty.filter((id, i, all): id is string => typeof id === 'string' && all.indexOf(id) === i && c.presets.some((p) => p.id === id));
  if (typeof o.lastUsed === 'string' && (isBuiltInId(o.lastUsed) || c.presets.some((p) => p.id === o.lastUsed))) c.lastUsed = o.lastUsed;
  return c;
}

/** Something the UI tells the player (a toast). */
export type ExperimentalProblem =
  /** A push failed for the network: the edit is kept here and goes up later (rules.offline). */
  | 'offline'
  /** The account already holds MAX_PRESETS presets (rules.full). */
  | 'too_many'
  /** A local create past MAX_PRESETS (rules.full). */
  | 'full'
  /** A delete without the network (rules.deleteOffline). */
  | 'delete_offline'
  /** Any other server refusal (error.unexpected). */
  | 'failed';

/** The server side, through AccountClient (node tests fake it). Rejections carry `code` ('network', 'too_many'...). */
export interface ExperimentalRemote {
  /** The signed-in account's id (the session `sub`), null for a guest. */
  accountId(): string | null;
  fetch(): Promise<ExperimentalAnswer>;
  setEnabled(on: boolean): Promise<ExperimentalAnswer>;
  upsert(preset: StoredPreset): Promise<ExperimentalAnswer>;
  remove(id: string): Promise<ExperimentalAnswer>;
}

/** A preset as the UI lists it: a built-in (read-only, named by the UI: rules.builtin.<id>) or the player's own. */
export interface ListedPreset {
  readonly id: string;
  readonly builtIn: boolean;
  /** The player's name for it; '' for a built-in. */
  readonly name: string;
  readonly values: Readonly<PhysicsValues>;
  /** On the account in this version (always true for a built-in). */
  readonly synced: boolean;
}

export interface ExperimentalStoreOptions {
  storage?: StorageLike | null;
  pushDelayMs?: number;
  /** Timers for the debounced push (setTimeout / clearTimeout by default; tests drive their own). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** New preset ids (physicsRules.ts newPresetId by default). */
  newId?: () => string;
  now?: () => number;
}

function errorCode(err: unknown): string {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : 'failed';
}

/** What a push compares: a preset's name and canonical values (updatedAt aside). */
function presetSig(p: StoredPreset): string {
  return JSON.stringify([p.name, canonicalValues(p.values)]);
}

export class ExperimentalStore {
  /** The UI's toasts (Game.ts): one call per problem. */
  onProblem: ((p: ExperimentalProblem) => void) | null = null;

  private readonly remote: ExperimentalRemote | null;
  private readonly storage: StorageLike | null;
  private readonly pushDelayMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly newId: () => string;
  private readonly listeners = new Set<() => void>();
  /** The copy per account when storage refuses (private mode, quota): this page only. */
  private readonly mem = new Map<string, ExperimentalCache>();
  private storageOk = true;
  /** Pushes, pulls and deletes run one after another. */
  private chain: Promise<unknown> = Promise.resolve();
  private timer: unknown = null;
  /** The 'offline' problem was reported and no request has succeeded since. */
  private offlineNoted = false;
  private readonly now: () => number;
  /** When the switch was last changed here (noteServerEnabled ignores older answers for a while). */
  private lastSwitchAt = -Infinity;

  constructor(remote: ExperimentalRemote | null, opts: ExperimentalStoreOptions = {}) {
    this.remote = remote;
    this.storage = opts.storage === undefined ? defaultTrainingStorage() : opts.storage;
    this.pushDelayMs = opts.pushDelayMs ?? PUSH_DELAY_MS;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.newId = opts.newId ?? (() => newPresetId());
    this.now = opts.now ?? Date.now;
  }

  /**
   * Whether the boot may treat this browser's player as unlocked, before the account is restored:
   * the account hint names an id (a hint from before the id: locked) whose local copy has the
   * switch on. main.ts gates the saved super low pick with it (bootTier.ts gateTierPrefs).
   */
  static unlockedAtBoot(storage: StorageLike | null = defaultTrainingStorage()): boolean {
    const id = readAccountHint(storage)?.id ?? null;
    if (id === null || storage === null) return false;
    try {
      const raw = storage.getItem(experimentalKey(id));
      return raw !== null && parseExperimentalCache(JSON.parse(raw)).enabled;
    } catch {
      return false;
    }
  }

  /** Call `fn` after every change of the state (a local edit, a server answer); returns the unsubscribe. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch (err) {
        console.error('[experimental] listener failed', err);
      }
    }
  }

  private problem(p: ExperimentalProblem): void {
    if (p === 'offline') {
      if (this.offlineNoted) return;
      this.offlineNoted = true;
    }
    if (this.onProblem !== null) this.onProblem(p);
  }

  accountId(): string | null {
    return this.remote === null ? null : this.remote.accountId();
  }

  private load(id: string): ExperimentalCache {
    if (this.storage === null || !this.storageOk) return this.mem.get(id) ?? emptyCache();
    try {
      const raw = this.storage.getItem(experimentalKey(id));
      return raw === null ? emptyCache() : parseExperimentalCache(JSON.parse(raw));
    } catch {
      return this.mem.get(id) ?? emptyCache();
    }
  }

  private save(id: string, c: ExperimentalCache): void {
    this.mem.set(id, c);
    if (this.storage === null || !this.storageOk) return;
    try {
      this.storage.setItem(experimentalKey(id), JSON.stringify(c));
    } catch {
      this.storageOk = false; // the memory copy holds it from now on
    }
  }

  /** The switch (false for a guest). */
  enabled(): boolean {
    const id = this.accountId();
    return id !== null && this.load(id).enabled;
  }

  /** Turn the switch on or off: saved here at once, sent to the account right after. */
  setEnabled(on: boolean): void {
    const id = this.accountId();
    if (id === null) return;
    const c = this.load(id);
    if (c.enabled === on && !c.enabledDirty) return;
    c.enabled = on;
    c.enabledDirty = true;
    this.lastSwitchAt = this.now();
    this.save(id, c);
    this.emit();
    void this.flush();
  }

  /**
   * MeInfo.experimental: the account's switch as /api/me reports it. A local change not sent yet
   * wins, and so does one made in the last NOTE_GRACE_MS (that answer may predate it: /api/me and
   * the switch's write are separate requests).
   */
  noteServerEnabled(on: boolean): void {
    const id = this.accountId();
    if (id === null || this.now() - this.lastSwitchAt < NOTE_GRACE_MS) return;
    const c = this.load(id);
    if (c.enabledDirty || c.enabled === on) return;
    c.enabled = on;
    this.save(id, c);
    this.emit();
  }

  /** The player's own presets, oldest first ([] for a guest). */
  presets(): StoredPreset[] {
    const id = this.accountId();
    return id === null ? [] : this.load(id).presets;
  }

  /** What the picker lists: the built-ins first, then the player's presets. */
  list(): ListedPreset[] {
    const out: ListedPreset[] = BUILT_IN_PRESETS.map((b) => ({ id: b.id, builtIn: true, name: '', values: b.values, synced: true }));
    const id = this.accountId();
    if (id === null) return out;
    const c = this.load(id);
    for (const p of c.presets) out.push({ id: p.id, builtIn: false, name: p.name, values: p.values, synced: !c.dirty.includes(p.id) });
    return out;
  }

  get(presetId: string): ListedPreset | null {
    return this.list().find((p) => p.id === presetId) ?? null;
  }

  /** A new preset of the player (saved here, uploaded with the next push). */
  create(name: string, values: Readonly<PhysicsValues> = {}): StoredPreset | 'full' | 'bad_name' | 'guest' {
    const id = this.accountId();
    if (id === null) return 'guest';
    const n = sanitizeLobbyName(name);
    if (n === null) return 'bad_name';
    const c = this.load(id);
    if (c.presets.length >= MAX_PRESETS) {
      this.problem('full');
      return 'full';
    }
    let pid = this.newId();
    while (isBuiltInId(pid) || c.presets.some((p) => p.id === pid)) pid = this.newId();
    const p: StoredPreset = { id: pid, name: n, values: canonicalValues(values), updatedAt: 0 };
    c.presets.push(p);
    c.dirty.push(pid);
    this.save(id, c);
    this.emit();
    this.schedulePush();
    return p;
  }

  /** A copy of any preset (a built-in included) under `name`. */
  duplicate(presetId: string, name: string): StoredPreset | 'full' | 'bad_name' | 'guest' | 'unknown' {
    const src = this.get(presetId);
    if (src === null) return 'unknown';
    return this.create(name, src.values);
  }

  private edit(presetId: string, change: (p: StoredPreset) => boolean): boolean {
    const id = this.accountId();
    if (id === null) return false;
    const c = this.load(id);
    const p = c.presets.find((q) => q.id === presetId);
    if (p === undefined || !change(p)) return false;
    if (!c.dirty.includes(presetId)) c.dirty.push(presetId);
    this.save(id, c);
    this.emit();
    this.schedulePush();
    return true;
  }

  /** Rename one of the player's presets (built-ins are read-only). */
  rename(presetId: string, name: string): boolean {
    const n = sanitizeLobbyName(name);
    if (n === null) return false;
    return this.edit(presetId, (p) => {
      if (p.name === n) return false;
      p.name = n;
      return true;
    });
  }

  /** New values for one of the player's presets. */
  update(presetId: string, values: Readonly<PhysicsValues>): boolean {
    return this.edit(presetId, (p) => {
      if (sameValues(p.values, values)) return false;
      p.values = canonicalValues(values);
      return true;
    });
  }

  /** Delete one of the player's presets on the account (needs the network: offline it is refused). */
  remove(presetId: string): Promise<boolean> {
    const run = this.chain.then(() => this.removeOnce(presetId));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async removeOnce(presetId: string): Promise<boolean> {
    const id = this.accountId();
    if (id === null || this.remote === null || isBuiltInId(presetId)) return false;
    if (!this.load(id).presets.some((p) => p.id === presetId)) return false;
    let ans: ExperimentalAnswer;
    try {
      ans = await this.remote.remove(presetId);
    } catch (err) {
      this.problem(errorCode(err) === 'network' ? 'delete_offline' : 'failed');
      return false;
    }
    this.offlineNoted = false;
    if (this.accountId() !== id) return true;
    const c = this.load(id);
    c.presets = c.presets.filter((p) => p.id !== presetId);
    c.dirty = c.dirty.filter((d) => d !== presetId);
    this.adopt(id, c, ans);
    return true;
  }

  /** The preset picked last (a built-in or the player's; 'standard' before any pick). */
  lastUsed(): string {
    const id = this.accountId();
    return (id === null ? null : this.load(id).lastUsed) ?? 'standard';
  }

  /** Remember the pick (and upload pending edits: another preset was picked). */
  setLastUsed(presetId: string): void {
    const id = this.accountId();
    if (id === null) return;
    const c = this.load(id);
    if (!isBuiltInId(presetId) && !c.presets.some((p) => p.id === presetId)) return;
    if (c.lastUsed !== presetId) {
      c.lastUsed = presetId;
      this.save(id, c);
      this.emit();
    }
    if (c.dirty.length > 0) void this.flush();
  }

  private schedulePush(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.flush();
    }, this.pushDelayMs);
  }

  /** Upload what changed here now (the switch, dirty presets). Never rejects. */
  flush(): Promise<void> {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    const run = this.chain.then(() => this.pushOnce());
    this.chain = run.catch(() => undefined);
    return run.then(() => undefined, () => undefined);
  }

  /** Push what changed here, then pull the account's state. Never rejects (offline: the local copy stays). */
  sync(): Promise<void> {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    const run = this.chain.then(async () => {
      if (!(await this.pushOnce())) return;
      await this.pullOnce();
    });
    this.chain = run.catch(() => undefined);
    return run.then(() => undefined, () => undefined);
  }

  /**
   * A failed request: 'stop' the push (offline, a refused session, a rate limit, a server error:
   * the next push tries again), 'skip' that preset (the account is full: it stays dirty here) or
   * 'drop' its dirty mark (the server can never store it).
   */
  private failed(err: unknown): 'stop' | 'skip' | 'drop' {
    const code = errorCode(err);
    if (code === 'network') {
      this.problem('offline');
      return 'stop';
    }
    if (code === 'too_many') {
      this.problem('too_many');
      return 'skip';
    }
    if (code === 'bad_preset') return 'drop'; // the server can never store it: keep it here only
    return 'stop'; // 401 / 429 / 5xx: try again at the next push
  }

  /** One push; false when it stopped early (the pull then waits for the next sync). */
  private async pushOnce(): Promise<boolean> {
    const id = this.accountId();
    const remote = this.remote;
    if (id === null || remote === null) return false;
    let c = this.load(id);
    let last: ExperimentalAnswer | null = null;
    if (c.enabledDirty) {
      const want = c.enabled;
      try {
        last = await remote.setEnabled(want);
      } catch (err) {
        this.failed(err);
        return false;
      }
      this.offlineNoted = false;
      if (this.accountId() !== id) return false;
      c = this.load(id);
      if (c.enabled === want) c.enabledDirty = false;
      this.save(id, c);
    }
    for (const pid of [...c.dirty]) {
      c = this.load(id);
      const p = c.presets.find((q) => q.id === pid);
      if (p === undefined) continue;
      const sig = presetSig(p);
      let ans: ExperimentalAnswer;
      try {
        ans = await remote.upsert(p);
      } catch (err) {
        const what = this.failed(err);
        if (what === 'stop') {
          if (last !== null) this.adopt(id, this.load(id), last);
          return false;
        }
        if (what === 'drop') {
          c = this.load(id);
          c.dirty = c.dirty.filter((d) => d !== pid);
          this.save(id, c);
        }
        continue;
      }
      this.offlineNoted = false;
      if (this.accountId() !== id) return false;
      last = ans;
      c = this.load(id);
      const cur = c.presets.find((q) => q.id === pid);
      // Edited again while the request was out: it stays dirty for the next push.
      if (cur !== undefined && presetSig(cur) === sig) c.dirty = c.dirty.filter((d) => d !== pid);
      this.save(id, c);
    }
    if (last !== null) this.adopt(id, this.load(id), last);
    return true;
  }

  private async pullOnce(): Promise<void> {
    const id = this.accountId();
    if (id === null || this.remote === null) return;
    let ans: ExperimentalAnswer;
    try {
      ans = await this.remote.fetch();
    } catch (err) {
      if (errorCode(err) === 'network') this.problem('offline');
      return;
    }
    this.offlineNoted = false;
    if (this.accountId() !== id) return;
    this.adopt(id, this.load(id), ans);
  }

  /** Take a server answer into `c`: the server's presets, the local version of the dirty ones, the switch unless changed here. */
  private adopt(id: string, c: ExperimentalCache, ans: ExperimentalAnswer): void {
    const dirty = new Set(c.dirty);
    const out: StoredPreset[] = [];
    for (const s of ans.presets) {
      const mine = dirty.has(s.id) ? c.presets.find((p) => p.id === s.id) : undefined;
      out.push(mine ?? s);
    }
    for (const p of c.presets) if (dirty.has(p.id) && !out.some((q) => q.id === p.id)) out.push(p);
    c.presets = out;
    c.dirty = c.dirty.filter((d) => out.some((p) => p.id === d));
    if (!c.enabledDirty) c.enabled = ans.enabled;
    if (c.lastUsed !== null && !isBuiltInId(c.lastUsed) && !out.some((p) => p.id === c.lastUsed)) c.lastUsed = null;
    this.save(id, c);
    this.emit();
  }
}
