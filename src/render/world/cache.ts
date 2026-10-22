/**
 * IndexedDB cache of baked worlds: the six RGBE-encoded cube faces, the parallax proxy lookup, the
 * environment's PMREM atlas (RGBE) and the skyline's lamp light map, keyed by theme + face size +
 * bake parameters + backend + a hash of the theme's data + WORLD_CACHE_VERSION. A later load skips
 * the bake (shader compiles, CPU geometry and GPU work) and only uploads and decodes.
 *
 * Everything here fails silently: no IndexedDB (private windows, some embedded browsers, tests),
 * a blocked or slow open, a quota error or a malformed record all mean "not cached" and the world
 * simply bakes. At most MAX_ENTRIES bakes are kept; the least recently used go first: every read
 * that hits and every write stamps the key in the small `used` store (a bake record itself is never
 * rewritten just to mark it used), and `evictions` picks the oldest stamps.
 */

/**
 * Bump whenever a generator, a bake material or the codec changes what a bake produces (the theme
 * data itself is hashed into the key, see `cacheKey`).
 */
export const WORLD_CACHE_VERSION = 8;
const DB_NAME = 'turbogol-world';
/** Version 2 added the `used` store (version 1 evicted the oldest write first). */
const DB_VERSION = 2;
const STORE = 'bakes';
/** When each key was last read or written: { key, at } (a few bytes per bake). */
const USED = 'used';
/**
 * Bakes kept (about 29 MB each at 1024 faces, 9 MB at 512): every theme of one tier, so browsing
 * the Stadium row or coming back to a favourite reads the cache instead of re-baking.
 */
export const MAX_ENTRIES = 6;
/** An open or read slower than this falls back to baking (ms). */
const TIMEOUT_MS = 1500;

export interface CachedBake {
  readonly key: string;
  readonly savedAt: number;
  readonly face: number;
  /** 6 faces x face x face x 4 bytes (RGBE), face after face, rows as read back. */
  readonly faces: ArrayBuffer;
  /** The proxy lookup: PROXY_WIDTH x 4 half floats. */
  readonly lut: ArrayBuffer;
  /** The environment's PMREM atlas, envW x envH x 4 bytes (RGBE). */
  readonly env: ArrayBuffer;
  readonly envW: number;
  readonly envH: number;
  /** The lamp light map (lightmap.ts: lmRes x 4 lmRes RGBA half floats), or null without lamps. */
  readonly lm: ArrayBuffer | null;
  readonly lmRes: number;
  readonly lmRect: readonly [number, number, number, number];
  readonly lmLayers: readonly [number, number];
}

/** What a valid record must hold for the sizes the caller expects. */
export interface BakeShape {
  readonly face: number;
  readonly lutBytes: number;
  readonly envW: number;
  readonly envH: number;
}

/** 32-bit FNV-1a of a string, base 36 (the theme-data part of the key). */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * The cache key of a bake: the theme, the bake sizes and parameters, the backend and a hash of the
 * theme's data (`data`: anything the bake reads, e.g. JSON of the world preset and the theme's
 * floodlights), so an edited preset never reads a stale bake.
 */
export function cacheKey(theme: string, face: number, envSize: number, ssaa: number, proxySsaa: number, backend: string, data: string): string {
  return `v${WORLD_CACHE_VERSION}/${theme}/${face}/${envSize}/${ssaa}/${proxySsaa}/${backend}/${hashString(data)}`;
}

/** A record read back is only used when its sizes match what the key promises. */
export function validBake(rec: unknown, key: string, shape: BakeShape): rec is CachedBake {
  if (typeof rec !== 'object' || rec === null) return false;
  const r = rec as Partial<CachedBake>;
  if (r.key !== key || r.face !== shape.face || r.envW !== shape.envW || r.envH !== shape.envH) return false;
  if (!(r.faces instanceof ArrayBuffer) || r.faces.byteLength !== 6 * shape.face * shape.face * 4) return false;
  if (!(r.lut instanceof ArrayBuffer) || r.lut.byteLength !== shape.lutBytes) return false;
  if (!(r.env instanceof ArrayBuffer) || r.env.byteLength !== shape.envW * shape.envH * 4) return false;
  if (r.lm === null) return true;
  const res = r.lmRes;
  return (
    r.lm instanceof ArrayBuffer &&
    typeof res === 'number' &&
    res > 0 &&
    r.lm.byteLength === res * res * 4 * 4 * 2 &&
    Array.isArray(r.lmRect) &&
    r.lmRect.length === 4 &&
    Array.isArray(r.lmLayers) &&
    r.lmLayers.length === 2
  );
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/**
 * The keys to delete so that at most `max` bakes stay: the least recently used first (`used` maps a
 * key to its last read or write; a bake without a stamp, e.g. one written before the `used` store
 * existed, counts as the oldest), ties in key order. Pure (tested).
 */
export function evictions(keys: readonly string[], used: ReadonlyMap<string, number>, max: number): string[] {
  const extra = keys.length - max;
  if (extra <= 0) return [];
  const at = (k: string): number => used.get(k) ?? 0;
  return [...keys].sort((a, b) => at(a) - at(b) || (a < b ? -1 : a > b ? 1 : 0)).slice(0, extra);
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise !== null) return dbPromise;
  const opening = new Promise<IDBDatabase | null>((resolve) => {
    try {
      const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
      if (idb === undefined) {
        resolve(null);
        return;
      }
      const req = idb.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' }).createIndex('savedAt', 'savedAt');
        if (!db.objectStoreNames.contains(USED)) db.createObjectStore(USED, { keyPath: 'key' });
      };
      req.onsuccess = () => {
        const db = req.result;
        // a later version opened in another tab: let it upgrade (this tab then stops caching)
        db.onversionchange = () => db.close();
        resolve(db);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  dbPromise = withTimeout(opening, TIMEOUT_MS, null);
  return dbPromise;
}

/** Open the database now (true when it is usable); later reads and writes reuse the connection. */
export function openCache(): Promise<boolean> {
  return openDb().then((db) => db !== null);
}

/** The cached bake under `key`, or null (not cached, unavailable, too slow, malformed). */
export async function readBake(key: string, shape: BakeShape): Promise<CachedBake | null> {
  const db = await openDb();
  if (db === null) return null;
  const read = new Promise<CachedBake | null>((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => {
        const hit = validBake(req.result, key, shape);
        if (hit) touch(db, key);
        resolve(hit ? (req.result as CachedBake) : null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return withTimeout(read, TIMEOUT_MS, null);
}

/** Stamp `key` as used now (best effort, its own small transaction: the read never waits for it). */
function touch(db: IDBDatabase, key: string): void {
  try {
    db.transaction(USED, 'readwrite').objectStore(USED).put({ key, at: Date.now() });
  } catch {
    /* not stamped: the bake only looks older than it is */
  }
}

/** Store a bake (best effort), then drop the least recently used entries beyond MAX_ENTRIES. */
export async function writeBake(rec: CachedBake): Promise<boolean> {
  const db = await openDb();
  if (db === null) return false;
  const write = new Promise<boolean>((resolve) => {
    try {
      const tx = db.transaction([STORE, USED], 'readwrite');
      const store = tx.objectStore(STORE);
      const used = tx.objectStore(USED);
      store.put(rec);
      used.put({ key: rec.key, at: Date.now() });
      // evict beyond MAX_ENTRIES by key and stamp only (no bake data is loaded)
      const keys = store.getAllKeys();
      const stamps = used.getAll();
      stamps.onsuccess = () => {
        const at = new Map<string, number>();
        for (const s of stamps.result as { key: unknown; at: unknown }[]) {
          if (typeof s.key === 'string' && typeof s.at === 'number') at.set(s.key, s.at);
        }
        const all = (keys.result as IDBValidKey[]).filter((k): k is string => typeof k === 'string');
        for (const k of evictions(all, at, MAX_ENTRIES)) {
          store.delete(k);
          used.delete(k);
        }
        // stamps without a bake (a read's stamp that landed after its bake was evicted)
        const live = new Set(all);
        for (const k of at.keys()) if (!live.has(k)) used.delete(k);
      };
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
  return withTimeout(write, 10000, false);
}

/**
 * Copy a readback (rows possibly padded to 256 bytes on WebGPU) into a tight buffer, optionally
 * reversing the row order.
 */
export function copyRows(src: Uint8Array, w: number, h: number, bpp: number, dst: Uint8Array, offset: number, flip = false): void {
  const row = w * bpp;
  const stride = h > 1 ? Math.round((src.length - row) / (h - 1)) : row;
  if (stride === row && !flip) {
    dst.set(src.subarray(0, row * h), offset);
    return;
  }
  for (let y = 0; y < h; y++) dst.set(src.subarray(y * stride, y * stride + row), offset + (flip ? h - 1 - y : y) * row);
}
