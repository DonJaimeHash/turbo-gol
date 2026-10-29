// The sign-in work's data model (server/src/accountStore.ts migrateTo2, the design's sections 1.1
// to 1.8) on node:sqlite, the SQL the AccountsDO runs: a database made by main's own migrate() (the
// fixture below copies it statement by statement) and holding a row of every kind is migrated to
// version 2 without a value or a column of before changing; a second run changes nothing; a
// failure midway leaves version 1 whole; the store and the AccountsDO work on the result. Then the
// rules of the new columns (the partial UNIQUE canon, the hints, the tombstones, pw_v, me()), the
// daily prune, and the shared email and name helpers of src/net/account.ts, pinned by vectors.
// Run from server/: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const DO_STUB = 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:workers') return { url: DO_STUB, shortCircuit: true };
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (relative && err && err.code === 'ERR_MODULE_NOT_FOUND') {
        if (!/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + '.ts', context);
        if (specifier.endsWith('.js')) return nextResolve(specifier.slice(0, -3) + '.ts', context);
      }
      throw err;
    }
  },
});

const S = await import('../src/accountStore.ts');
const ACC = await import('../../src/net/account.ts');
const { AccountsDO } = await import('../src/AccountsDO.ts');
const { INTERNAL_HEADER, internalSecret } = await import('../src/auth.ts');

const SECRET = 'accounts-migrate-test-secret';
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60_000;
const H = (c) => c.repeat(64).slice(0, 64);

/** node:sqlite behind ctx.storage.sql (exec(...).toArray()) and transactionSync; `fail` makes one statement throw. */
function makeDb() {
  const db = new DatabaseSync(':memory:');
  const hooks = { fail: null };
  const sql = {
    exec(query, ...bindings) {
      if (hooks.fail && hooks.fail.test(query)) {
        hooks.fail = null;
        throw new Error('injected failure: ' + query.slice(0, 40));
      }
      const stmt = db.prepare(query);
      const rows = /^\s*(SELECT|WITH)/i.test(query) ? stmt.all(...bindings) : (stmt.run(...bindings), []);
      return { toArray: () => rows.map((r) => ({ ...r })) };
    },
  };
  let depth = 0;
  const tx = (fn) => {
    if (depth > 0) return fn();
    depth++;
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    } finally {
      depth--;
    }
  };
  return { db, sql, tx, hooks };
}

/**
 * main's AccountStore.migrate() at 74aaf37 (server/src/accountStore.ts:237-289), statement by
 * statement: the schema production's AccountsDO ('accounts-v1') holds today.
 */
function mainMigrate(sql) {
  const addColumn = (table, def) => {
    try {
      sql.exec(`ALTER TABLE ${table} ADD COLUMN ${def}`);
    } catch (e) {
      if (!/duplicate column/i.test(String(e?.message ?? e))) throw e;
    }
  };
  sql.exec(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL, ukey TEXT NOT NULL UNIQUE,
      pw_hash TEXT, pw_salt TEXT, pw_iter INTEGER,
      recovery TEXT NOT NULL DEFAULT '[]', google_sub TEXT UNIQUE, discord_id TEXT UNIQUE,
      created_at INTEGER NOT NULL, last_login INTEGER NOT NULL DEFAULT 0, renamed_at INTEGER NOT NULL DEFAULT 0,
      banned INTEGER NOT NULL DEFAULT 0)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS refresh (
      hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
  sql.exec('CREATE INDEX IF NOT EXISTS refresh_user ON refresh(user_id)');
  for (const col of ['family TEXT', "kind TEXT NOT NULL DEFAULT 'web'", 'auth_at INTEGER NOT NULL DEFAULT 0', 'family_at INTEGER NOT NULL DEFAULT 0', 'prev_hash TEXT', 'country TEXT', 'city TEXT']) addColumn('refresh', col);
  sql.exec('CREATE INDEX IF NOT EXISTS refresh_family ON refresh(family)');
  for (const col of ['google_linked_at INTEGER', 'discord_linked_at INTEGER']) addColumn('users', col);
  sql.exec(`CREATE TABLE IF NOT EXISTS ratings (
      user_id TEXT NOT NULL, playlist TEXT NOT NULL, season INTEGER NOT NULL,
      mu REAL NOT NULL, sigma REAL NOT NULL, games INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0,
      peak_mmr INTEGER NOT NULL DEFAULT 0, last_played INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, playlist, season))`);
  sql.exec('CREATE INDEX IF NOT EXISTS ratings_board ON ratings(playlist, season, mu)');
  sql.exec(`CREATE TABLE IF NOT EXISTS ranked_matches (
      match_id TEXT PRIMARY KEY, playlist TEXT NOT NULL, region TEXT NOT NULL, status TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '', blue INTEGER NOT NULL DEFAULT 0, red INTEGER NOT NULL DEFAULT 0,
      winner INTEGER NOT NULL DEFAULT -1, ended_at INTEGER NOT NULL)`);
  sql.exec('CREATE INDEX IF NOT EXISTS ranked_matches_ended ON ranked_matches(ended_at)');
  sql.exec(`CREATE TABLE IF NOT EXISTS ranked_players (
      match_id TEXT NOT NULL, user_id TEXT NOT NULL, team INTEGER NOT NULL, left_match INTEGER NOT NULL,
      outcome TEXT NOT NULL, mu_before REAL NOT NULL, sigma_before REAL NOT NULL, mu_after REAL NOT NULL,
      sigma_after REAL NOT NULL, games_after INTEGER NOT NULL, ban_until INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (match_id, user_id))`);
  sql.exec('CREATE TABLE IF NOT EXISTS abandons (user_id TEXT NOT NULL, at INTEGER NOT NULL, match_id TEXT NOT NULL)');
  sql.exec('CREATE INDEX IF NOT EXISTS abandons_user ON abandons(user_id, at)');
  sql.exec('CREATE TABLE IF NOT EXISTS bans (user_id TEXT PRIMARY KEY, until INTEGER NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS ranked_locks (user_id TEXT PRIMARY KEY, match_id TEXT NOT NULL, region TEXT NOT NULL, until INTEGER NOT NULL)');
  sql.exec(`CREATE TABLE IF NOT EXISTS training (
      user_id TEXT NOT NULL, pack_id TEXT NOT NULL, best INTEGER NOT NULL, shots INTEGER NOT NULL,
      completed_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, pack_id))`);
  sql.exec('CREATE TABLE IF NOT EXISTS experimental (user_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)');
  sql.exec(`CREATE TABLE IF NOT EXISTS presets (
      user_id TEXT NOT NULL, preset_id TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, preset_id))`);
  sql.exec(`CREATE TABLE IF NOT EXISTS host_credits (
      match_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, node_id TEXT NOT NULL, points REAL NOT NULL,
      verified INTEGER NOT NULL, at INTEGER NOT NULL)`);
  sql.exec('CREATE INDEX IF NOT EXISTS host_credits_user ON host_credits(user_id)');
  sql.exec(`CREATE TABLE IF NOT EXISTS host_claims (
      user_id TEXT NOT NULL, item_id TEXT NOT NULL, cost REAL NOT NULL, at INTEGER NOT NULL, source TEXT NOT NULL,
      PRIMARY KEY (user_id, item_id))`);
  sql.exec('CREATE TABLE IF NOT EXISTS host_freeze (user_id TEXT PRIMARY KEY, reason TEXT NOT NULL, at INTEGER NOT NULL, cleared_at INTEGER NOT NULL DEFAULT 0)');
  sql.exec('CREATE TABLE IF NOT EXISTS loadout (user_id TEXT PRIMARY KEY, car TEXT NOT NULL, updated_at INTEGER NOT NULL)');
}

/** The accounts of the fixture: every way in production has, a ban, an inactive one. */
const U = {
  ana: 'aaaaaaaaaaaaaaa1', // password only, recovery codes, ratings, host points, an item, a car, training, presets
  beto: 'aaaaaaaaaaaaaaa2', // password + Google
  caro: 'aaaaaaaaaaaaaaa3', // password + Discord (linked before link times were kept)
  dani: 'aaaaaaaaaaaaaaa4', // Google only, a TV signed in
  eli: 'aaaaaaaaaaaaaaa5', // Discord only, suspended
  fede: 'aaaaaaaaaaaaaaa6', // Google + Discord, a frozen wallet
  gabi: 'aaaaaaaaaaaaaaa7', // password only, never seen since 2025
};

/** Rows of every kind main writes, as main's own statements write them. */
function seedV1(sql) {
  const user = (id, name, { pw = false, google = null, discord = null, gAt = null, dAt = null, recovery = '[]', created = NOW - 90 * DAY, last = NOW - 2 * DAY, renamed = 0, banned = 0 } = {}) =>
    sql.exec(
      'INSERT INTO users (id, username, ukey, pw_hash, pw_salt, pw_iter, recovery, google_sub, discord_id, created_at, last_login, renamed_at, banned, google_linked_at, discord_linked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, name, name.toLowerCase(), pw ? H(id[15]) : null, pw ? H('5').slice(0, 32) : null, pw ? 100000 : null, recovery, google, discord, created, last, renamed, banned, gAt, dAt,
    );
  user(U.ana, 'Ana', { pw: true, recovery: JSON.stringify([H('c'), H('d')]), renamed: NOW - 40 * DAY });
  user(U.beto, 'Beto', { pw: true, google: 'google-sub-beto', gAt: NOW - 10 * DAY });
  user(U.caro, 'Caro', { pw: true, discord: 'discord-caro' });
  user(U.dani, 'Dani', { google: 'google-sub-dani', gAt: NOW - 20 * DAY });
  user(U.eli, 'Eli', { discord: 'discord-eli', dAt: NOW - 5 * DAY, banned: 1 });
  user(U.fede, 'Fede', { google: 'google-sub-fede', discord: 'discord-fede', gAt: NOW - 3 * DAY, dAt: NOW - 3 * DAY });
  user(U.gabi, 'Gabi', { pw: true, created: NOW - 400 * DAY, last: 0 });
  // A token from before families (main's oldest shape), a browser's family and a TV's.
  sql.exec('INSERT INTO refresh (hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', H('1'), U.ana, NOW - DAY, NOW + 29 * DAY);
  sql.exec('INSERT INTO refresh (hash, user_id, created_at, expires_at, family, kind, auth_at, family_at, prev_hash, country, city) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', H('2'), U.beto, NOW - DAY, NOW + 29 * DAY, 'f'.repeat(32), 'web', NOW - DAY, NOW - 3 * DAY, H('9'), 'AR', 'Rosario');
  sql.exec('INSERT INTO refresh (hash, user_id, created_at, expires_at, family, kind, auth_at, family_at, prev_hash, country, city) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', H('3'), U.dani, NOW - DAY, NOW + 29 * DAY, 'e'.repeat(32), 'tv', 0, NOW - DAY, null, 'ES', null);
  sql.exec('INSERT INTO ratings (user_id, playlist, season, mu, sigma, games, wins, losses, peak_mmr, last_played) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', U.ana, '1v1', 1, 27.5, 6.1, 7, 4, 3, 812, NOW - 3 * DAY);
  sql.exec('INSERT INTO ratings (user_id, playlist, season, mu, sigma, games, wins, losses, peak_mmr, last_played) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', U.dani, '2v2', 1, 24.0, 7.9, 2, 1, 1, 0, NOW - 3 * DAY);
  sql.exec("INSERT INTO ranked_matches (match_id, playlist, region, status, blue, red, winner, ended_at) VALUES (?, '1v1', 'SA', 'done', 3, 1, 0, ?)", 'm'.repeat(16), NOW - 3 * DAY);
  sql.exec("INSERT INTO ranked_matches (match_id, playlist, region, status, reason, ended_at) VALUES (?, '2v2', 'EU', 'cancelled', 'no_show', ?)", 'n'.repeat(16), NOW - 2 * DAY);
  sql.exec("INSERT INTO ranked_players (match_id, user_id, team, left_match, outcome, mu_before, sigma_before, mu_after, sigma_after, games_after, ban_until) VALUES (?, ?, 0, 0, 'win', 25, 8.3, 27.5, 6.1, 7, 0)", 'm'.repeat(16), U.ana);
  sql.exec('INSERT INTO abandons (user_id, at, match_id) VALUES (?, ?, ?)', U.caro, NOW - 3600_000, 'n'.repeat(16));
  sql.exec('INSERT INTO bans (user_id, until) VALUES (?, ?)', U.caro, NOW + 3600_000);
  sql.exec("INSERT INTO ranked_locks (user_id, match_id, region, until) VALUES (?, ?, 'SA', ?)", U.beto, 'o'.repeat(16), NOW + 600_000);
  sql.exec('INSERT INTO training (user_id, pack_id, best, shots, completed_at) VALUES (?, ?, ?, ?, ?)', U.ana, 'striker-1', 9, 10, NOW - 4 * DAY);
  sql.exec('INSERT INTO experimental (user_id, enabled, updated_at) VALUES (?, 1, ?)', U.ana, NOW - 4 * DAY);
  sql.exec('INSERT INTO presets (user_id, preset_id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', U.ana, 'abcdef012345', 'Luna', '{}', NOW - 4 * DAY, NOW - 4 * DAY);
  sql.exec('INSERT INTO host_credits (match_id, user_id, node_id, points, verified, at) VALUES (?, ?, ?, ?, 1, ?)', H('7'), U.ana, 'b'.repeat(16), 12.5, NOW - 5 * DAY);
  sql.exec('INSERT INTO host_credits (match_id, user_id, node_id, points, verified, at) VALUES (?, ?, ?, ?, 0, ?)', H('8'), U.fede, 'c'.repeat(16), 0, NOW - 5 * DAY);
  sql.exec("INSERT INTO host_claims (user_id, item_id, cost, at, source) VALUES (?, 'badge-host', 0, ?, 'claim')", U.ana, NOW - 4 * DAY);
  sql.exec("INSERT INTO host_freeze (user_id, reason, at, cleared_at) VALUES (?, 'verification failed', ?, 0)", U.fede, NOW - DAY);
  sql.exec("INSERT INTO loadout (user_id, car, updated_at) VALUES (?, 'octane', ?)", U.ana, NOW - 4 * DAY);
}

const TABLES_V1 = ['users', 'refresh', 'ratings', 'ranked_matches', 'ranked_players', 'abandons', 'bans', 'ranked_locks', 'training', 'experimental', 'presets', 'host_credits', 'host_claims', 'host_freeze', 'loadout'];
const TABLES_V2 = ['meta', 'mail_tokens', 'email_holds', 'consents', 'auth_throttle', 'mail_rate', 'mail_day', 'deleted_ids', 'sanction_marks', 'protected_skel'];

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => ({ ...c }));
const rowsOf = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((r) => ({ ...r }));
const schemaOf = (db) => db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all().map((r) => ({ ...r }));
/** Every table's rows, keyed by table: what a second run must leave exactly as it was. */
const dump = (db) => Object.fromEntries(schemaOf(db).filter((o) => o.type === 'table').map((o) => [o.name, rowsOf(db, o.name)]));
/** A row cut down to `cols` (the columns main had). */
const pick = (row, cols) => Object.fromEntries(cols.map((c) => [c, row[c]]));

function v1Fixture() {
  const d = makeDb();
  mainMigrate(d.sql);
  seedV1(d.sql);
  const before = {};
  for (const t of TABLES_V1) before[t] = { columns: columns(d.db, t), rows: rowsOf(d.db, t) };
  const indexes = schemaOf(d.db).filter((o) => o.type === 'index');
  return { ...d, before, indexes };
}

const NEW_USER_DEFAULTS = {
  email: null,
  email_canon: null,
  email_verified_at: 0,
  email_proof: '',
  email_hint: null,
  email_hint_canon: null,
  email_hint_from: '',
  email_locked_until: 0,
  pw_kid: '',
  lang: '',
  tz: '',
  dev_sub: null,
  delete_requested_at: 0,
  delete_purge_at: 0,
  unsub_id: null,
};

// ---- the migration ---------------------------------------------------------------------------------

test('version 1 to 2 on main’s schema: every column and value of before kept, the new columns at their defaults, pw_v 1 exactly for the passwords, meta written', () => {
  const f = v1Fixture();
  const store = new S.AccountStore(f.sql, f.tx);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'meta'").get().n, 0, 'main has no meta table: version 1');
  store.migrate();
  for (const t of TABLES_V1) {
    const after = columns(f.db, t);
    const old = f.before[t].columns;
    assert.deepEqual(after.slice(0, old.length), old, `${t}: every column of before, in place, same type, null rule, default and key`);
    const oldCols = old.map((c) => c.name);
    assert.deepEqual(rowsOf(f.db, t).map((r) => pick(r, oldCols)), f.before[t].rows, `${t}: every row and value of before`);
  }
  for (const ix of f.indexes) assert.ok(schemaOf(f.db).some((o) => o.type === 'index' && o.name === ix.name && o.sql === ix.sql), `index ${ix.name} kept`);
  const users = rowsOf(f.db, 'users');
  for (const u of users) {
    assert.deepEqual(pick(u, Object.keys(NEW_USER_DEFAULTS)), NEW_USER_DEFAULTS, u.username);
    assert.equal(u.pw_v, u.pw_hash === null ? 0 : 1, `${u.username}: pw_v`);
  }
  assert.deepEqual(users.filter((u) => u.pw_v === 1).map((u) => u.username), ['Ana', 'Beto', 'Caro', 'Gabi'], 'password only and password plus a provider');
  for (const r of rowsOf(f.db, 'refresh')) assert.deepEqual([r.auth_lvl, r.method], [0, ''], 'a family from before is level 0');
  for (const t of TABLES_V2) assert.ok(schemaOf(f.db).some((o) => o.type === 'table' && o.name === t), t);
  for (const ix of ['users_email_canon', 'users_email_hint', 'users_dev_sub', 'users_unsub', 'users_purge', 'mail_tokens_user', 'mail_tokens_canon', 'mail_tokens_attempt', 'mail_tokens_exp', 'consents_user']) {
    assert.ok(schemaOf(f.db).some((o) => o.type === 'index' && o.name === ix), ix);
  }
  assert.deepEqual(rowsOf(f.db, 'meta'), [{ k: 'schema_version', v: '2' }]);
  assert.equal(store.schemaVersion(), S.SCHEMA_VERSION);
  for (const t of TABLES_V2.filter((t) => t !== 'meta')) assert.deepEqual(rowsOf(f.db, t), [], `${t} starts empty`);
});

test('running it again changes nothing: the once-only step never runs twice (a re-keyed pw_v stays), while a password a rollback wrote with pw_v 0 is repaired', () => {
  const f = v1Fixture();
  const store = new S.AccountStore(f.sql, f.tx);
  store.migrate();
  const schema = schemaOf(f.db);
  const data = dump(f.db);
  store.migrate();
  new S.AccountStore(f.sql, f.tx).migrate();
  assert.deepEqual(schemaOf(f.db), schema, 'same schema');
  assert.deepEqual(dump(f.db), data, 'same rows');
  // A later PR re-keys Ana to the current key (pw_v 2): a restart must not take her back to 1.
  f.db.prepare('UPDATE users SET pw_v = 2 WHERE id = ?').run(U.ana);
  // A rollback to main's build after the migration: its register writes a password with no pw_v.
  f.db.prepare("INSERT INTO users (id, username, ukey, pw_hash, pw_salt, pw_iter, created_at) VALUES ('aaaaaaaaaaaaaaa8', 'Hugo', 'hugo', ?, ?, 100000, ?)").run(H('8'), H('5').slice(0, 32), NOW);
  store.migrate();
  const pw = Object.fromEntries(rowsOf(f.db, 'users').map((u) => [u.username, u.pw_v]));
  assert.deepEqual(pw, { Ana: 2, Beto: 1, Caro: 1, Dani: 0, Eli: 0, Fede: 0, Gabi: 1, Hugo: 1 });
  assert.deepEqual(rowsOf(f.db, 'meta'), [{ k: 'schema_version', v: '2' }], 'meta written once');
});

test('the fixture is main’s schema, and the change is additive only: a database this build makes from nothing holds every column of it, in order, then the new ones', () => {
  const fresh = makeDb();
  new S.AccountStore(fresh.sql, fresh.tx).migrate();
  const f = v1Fixture();
  for (const t of TABLES_V1) {
    const old = f.before[t].columns;
    const now = columns(fresh.db, t);
    assert.deepEqual(now.slice(0, old.length), old, `${t}: main's columns first, unchanged`);
    for (const c of now.slice(old.length)) assert.ok(c.notnull === 0 || c.dflt_value !== null, `${t}.${c.name}: an added column is NULL-able or has a default`);
    assert.equal(now.slice(old.length).some((c) => c.pk !== 0), false, `${t}: no key changed`);
  }
  // Main's indexes are all still made, with the same definition.
  for (const ix of f.indexes) assert.ok(schemaOf(fresh.db).some((o) => o.name === ix.name && o.sql === ix.sql), ix.name);
});

test('a failure midway leaves version 1 whole (no column, table or pw_v of version 2), and the next start does it all', () => {
  const f = v1Fixture();
  const store = new S.AccountStore(f.sql, f.tx);
  f.hooks.fail = /CREATE TABLE IF NOT EXISTS sanction_marks/;
  assert.throws(() => store.migrate(), /injected failure/);
  assert.equal(store.schemaVersion(), 1);
  assert.deepEqual(columns(f.db, 'users'), f.before.users.columns, 'no column added');
  assert.deepEqual(columns(f.db, 'refresh'), f.before.refresh.columns);
  assert.equal(schemaOf(f.db).some((o) => o.name === 'mail_tokens' || o.name === 'users_email_canon'), false, 'no table or index of version 2');
  assert.deepEqual(rowsOf(f.db, 'users'), f.before.users.rows);
  store.migrate();
  assert.equal(store.schemaVersion(), 2);
  assert.deepEqual(rowsOf(f.db, 'users').map((u) => u.pw_v), [1, 1, 1, 0, 0, 0, 1]);
});

test('the store works on the migrated database: sign-in, a token from before families rotates, the board, the wallet, the ban and the lock', () => {
  const f = v1Fixture();
  const store = new S.AccountStore(f.sql, f.tx);
  store.migrate();
  const c = store.credentials('ana');
  assert.deepEqual([c.userId, c.hash, c.iter, c.banned], [U.ana, H('1'), 100000, false]);
  assert.equal(store.recoveryLeft(U.ana), 2);
  const rot = store.rotate(H('1'), null, { hash: H('a'), family: 'd'.repeat(32), kind: 'web' }, NOW);
  assert.equal(rot.userId, U.ana);
  assert.equal(store.refreshOwner(H('a'), NOW).userId, U.ana);
  assert.equal(store.signedIn(U.eli, H('b'), NOW), null, 'still suspended');
  assert.equal(store.rotate(H('3'), 'e'.repeat(32), { hash: H('c'), family: 'e'.repeat(32), kind: 'tv' }, NOW).tv, true, 'the TV keeps its scope');
  assert.equal(store.leaderboard('1v1', 10, U.ana).entries[0].name, 'Ana');
  assert.equal(store.wallet(U.ana).earned, 12.5);
  assert.deepEqual(store.items(U.ana).items, ['badge-host']);
  assert.equal(store.wallet(U.fede).frozen, 'verification failed');
  assert.equal(store.banUntil(U.caro, NOW), NOW + 3600_000);
  assert.deepEqual(store.rankedCheck(U.beto, ['1v1'], NOW).active, { matchId: 'o'.repeat(16), region: 'SA' });
  assert.equal(store.unlink(U.dani, 'google'), 'last_method');
  const me = store.me(U.caro, NOW);
  assert.deepEqual(me.providers, ['password', 'discord']);
  assert.deepEqual(me.linkedAt, {}, 'linked before link times were kept');
  assert.equal(store.trainingRecords(U.ana)['striker-1'].best, 9);
  assert.equal(store.presets(U.ana).length, 1);
});

test('AccountsDO migrates the database inside blockConcurrencyWhile, before any request, and /me answers the new fields', async () => {
  const f = v1Fixture();
  const order = [];
  const ctx = {
    storage: { sql: f.sql, transactionSync: f.tx, getAlarm: async () => null, setAlarm: async () => undefined },
    blockConcurrencyWhile: (fn) => {
      order.push('block');
      const p = fn();
      order.push(new S.AccountStore(f.sql, f.tx).schemaVersion() === 2 ? 'migrated' : 'not yet');
      return p;
    },
  };
  const obj = new AccountsDO(ctx, { JWT_SECRET: SECRET });
  assert.deepEqual(order, ['block', 'migrated']);
  const res = await obj.fetch(new Request(`https://accounts/me?userId=${U.ana}`, { headers: { [INTERNAL_HEADER]: await internalSecret(SECRET) } }));
  assert.equal(res.status, 200);
  const me = await res.json();
  assert.deepEqual(
    [me.name, me.providers, me.email, me.emailHint, me.emailVerified, me.legacy, me.news, me.deletionAt, me.waysIn],
    ['Ana', ['password'], null, null, false, true, false, 0, 1],
  );
});

// ---- the rules of the new columns ----------------------------------------------------------------------

function migratedStore() {
  const d = makeDb();
  const store = new S.AccountStore(d.sql, d.tx);
  store.migrate();
  return { ...d, store };
}

const PW = { hash: H('a'), salt: H('b').slice(0, 32), iter: 100000 };

test('one canon, one account: the partial UNIQUE index refuses a duplicate and allows any number of NULLs; claimEmail says taken, and an undo’s hold counts as taken', () => {
  const { db, store } = migratedStore();
  const ids = ['Ana', 'Beto', 'Caro', 'Dani'].map((n, i) => store.register(n, PW, [], H(String(i + 1)), NOW).userId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE email_canon IS NULL').get().n, 4, 'many NULLs');
  db.prepare("UPDATE users SET email_canon = 'x@y.com' WHERE id = ?").run(ids[0]);
  assert.throws(() => db.prepare("UPDATE users SET email_canon = 'x@y.com' WHERE id = ?").run(ids[1]), /UNIQUE/);
  db.prepare('UPDATE users SET email_canon = NULL WHERE id = ?').run(ids[0]);
  // The canon is derived from the typed address, never taken from a caller (I9).
  assert.equal(store.claimEmail(ids[0], ' Ana.Perez+tg@GoogleMail.com ', 'mail', NOW), 'ok');
  const a = db.prepare('SELECT email, email_canon, email_verified_at, email_proof FROM users WHERE id = ?').get(ids[0]);
  assert.deepEqual({ ...a }, { email: 'ana.perez+tg@googlemail.com', email_canon: 'anaperez@gmail.com', email_verified_at: NOW, email_proof: 'mail' });
  assert.equal(store.claimEmail(ids[1], 'anaperez@gmail.com', 'google', NOW), 'taken', 'the same canon, another account');
  assert.equal(store.claimEmail(ids[1], 'a.n.a.p.e.r.e.z@gmail.com', 'mail', NOW), 'taken');
  assert.equal(store.claimEmail(ids[0], 'anaperez@gmail.com', 'mail', NOW + 1), 'ok', 'its own canon again');
  assert.equal(store.claimEmail(ids[1], 'not an address', 'mail', NOW), 'bad_email');
  assert.equal(store.claimEmail('ffffffffffffffff', 'z@z.com', 'mail', NOW), 'no_user');
  db.prepare("INSERT INTO email_holds (canon, user_id, email, until) VALUES ('held@x.com', ?, 'held@x.com', ?)").run(ids[2], NOW + 7 * DAY);
  assert.equal(store.claimEmail(ids[3], 'Held+1@x.com', 'mail', NOW), 'taken', 'held for another account’s undo');
  assert.equal(store.claimEmail(ids[2], 'held@x.com', 'mail', NOW), 'ok', 'its own held canon');
});

test('claiming a canon clears every other account’s hint of it, and the account’s own hint; no hint is written for a claimed or held canon', () => {
  const { db, store } = migratedStore();
  const [a, b, c, d] = ['Ana', 'Beto', 'Caro', 'Dani'].map((n, i) => store.register(n, PW, [], H(String(i + 1)), NOW).userId);
  const hintOf = (id) => ({ ...db.prepare('SELECT email_hint, email_hint_canon, email_hint_from FROM users WHERE id = ?').get(id) });
  assert.equal(store.setEmailHint(b, 'Ana@Gmail.com', 'discord'), 'ok');
  assert.equal(store.setEmailHint(c, 'a.na+tg@gmail.com', 'google'), 'ok', 'a hint canon is not unique');
  assert.equal(store.setEmailHint(a, 'ana@outlook.com', 'discord'), 'ok');
  assert.deepEqual(hintOf(c), { email_hint: 'a.na+tg@gmail.com', email_hint_canon: 'ana@gmail.com', email_hint_from: 'google' });
  assert.equal(store.claimEmail(a, 'ana@gmail.com', 'mail', NOW), 'ok');
  const none = { email_hint: null, email_hint_canon: null, email_hint_from: '' };
  assert.deepEqual([hintOf(a), hintOf(b), hintOf(c)], [none, none, none]);
  assert.equal(store.setEmailHint(d, 'ana+x@gmail.com', 'discord'), 'claimed');
  assert.equal(store.setEmailHint(a, 'ana@gmail.com', 'discord'), 'claimed', 'its own claimed canon too');
  db.prepare("INSERT INTO email_holds (canon, user_id, email, until) VALUES ('held@x.com', ?, 'held@x.com', ?)").run(c, NOW + DAY);
  assert.equal(store.setEmailHint(d, 'held@x.com', 'discord'), 'claimed');
  assert.deepEqual(hintOf(d), none);
  assert.equal(store.setEmailHint(d, '@nope', 'discord'), 'bad_email');
});

test('freshId never hands out the id of a purged account (deleted_ids)', () => {
  const { db, store } = migratedStore();
  db.prepare('INSERT INTO deleted_ids (id, at) VALUES (?, ?)').run('a'.repeat(16), NOW);
  const real = crypto.getRandomValues.bind(crypto);
  const fills = [0xaa, 0xbb];
  crypto.getRandomValues = (b) => {
    const v = fills.shift();
    if (v === undefined) return real(b);
    b.fill(v);
    return b;
  };
  try {
    assert.equal(store.register('Ana', PW, [], H('1'), NOW).userId, 'b'.repeat(16));
  } finally {
    crypto.getRandomValues = real;
  }
});

test('a password written now is the legacy key: register, a password change and a recovery write pw_v 1', () => {
  const { db, store } = migratedStore();
  const pwv = (id) => db.prepare('SELECT pw_v FROM users WHERE id = ?').get(id).pw_v;
  const a = store.register('Ana', PW, [H('c')], H('1'), NOW).userId;
  assert.equal(pwv(a), 1);
  const g = store.oauth('google', 'g-sub', 'Gus', null, H('2'), NOW);
  assert.equal(pwv(g.userId), 0, 'no password');
  store.setPassword(g.userId, PW);
  assert.equal(pwv(g.userId), 1);
  db.prepare('UPDATE users SET pw_v = 0 WHERE id = ?').run(a);
  assert.ok(store.recover('Ana', H('c'), PW, H('3'), NOW));
  assert.equal(pwv(a), 1);
});

test('me(): email, hint, verified, legacy, news (the newest consent), deletion and the ways in', () => {
  const { db, store } = migratedStore();
  const a = store.register('Ana', PW, [], H('1'), NOW).userId;
  const fields = (id, closed = false) => {
    const m = store.me(id, NOW, closed);
    return { email: m.email, emailHint: m.emailHint, emailVerified: m.emailVerified, legacy: m.legacy, news: m.news, deletionAt: m.deletionAt, waysIn: m.waysIn };
  };
  assert.deepEqual(fields(a), { email: null, emailHint: null, emailVerified: false, legacy: true, news: false, deletionAt: 0, waysIn: 1 });
  assert.equal(fields(a, true).waysIn, 0, 'after the cutoff a password without a verified email is no way in');
  store.setEmailHint(a, 'Ana@Discord-Mail.com', 'discord');
  assert.equal(fields(a).emailHint, 'ana@discord-mail.com');
  store.claimEmail(a, 'Ana@Gmail.com', 'mail', NOW);
  assert.deepEqual(fields(a, true), { email: 'ana@gmail.com', emailHint: null, emailVerified: true, legacy: true, news: false, deletionAt: 0, waysIn: 1 });
  const consent = (granted, at) => db.prepare("INSERT INTO consents (user_id, kind, version, granted, source, at) VALUES (?, 'news', 'news-v1', ?, 'perfil', ?)").run(a, granted, at);
  consent(1, NOW);
  assert.equal(fields(a).news, true);
  consent(0, NOW + 1);
  assert.equal(fields(a).news, false, 'the newest row counts');
  consent(1, NOW + 2);
  db.prepare("INSERT INTO consents (user_id, kind, version, granted, source, at) VALUES (?, 'terms', 't1', 0, 'signup', ?)").run(a, NOW + 3);
  assert.equal(fields(a).news, true, 'another kind does not count');
  db.prepare('UPDATE users SET delete_requested_at = ?, delete_purge_at = ? WHERE id = ?').run(NOW, NOW + 14 * DAY, a);
  assert.equal(fields(a).deletionAt, NOW + 14 * DAY);
  const f = store.oauth('google', 'g-fede', 'Fede', null, H('2'), NOW).userId;
  store.oauth('discord', 'd-fede', 'x', f, H('3'), NOW);
  assert.deepEqual([fields(f).legacy, fields(f).waysIn, fields(f, true).waysIn], [false, 2, 2]);
  db.prepare('UPDATE users SET pw_v = 2 WHERE id = ?').run(a);
  assert.equal(fields(a).legacy, false, 'a current key is not legacy');
});

// ---- the daily prune ---------------------------------------------------------------------------------

test('the daily prune removes what the design says, at the times it says, and keeps the log, the tombstones and meta', () => {
  const { db, store } = migratedStore();
  const day = (t) => new Date(t).toISOString().slice(0, 10);
  const ins = (q, ...v) => db.prepare(q).run(...v);
  const token = (hash, expires) => ins("INSERT INTO mail_tokens (hash, nonce, purpose, email, email_canon, created_at, expires_at) VALUES (?, 'n', 'signup', 'a@b.com', 'a@b.com', ?, ?)", hash, expires - DAY, expires);
  token('t-gone', NOW - DAY - 1);
  token('t-day', NOW - DAY + 1);
  token('t-live', NOW + 3600_000);
  ins("INSERT INTO email_holds VALUES ('gone@x.com', 'u1', 'gone@x.com', ?)", NOW - 1);
  ins("INSERT INTO email_holds VALUES ('kept@x.com', 'u1', 'kept@x.com', ?)", NOW + 1);
  ins("INSERT INTO auth_throttle VALUES ('old', 3, ?, 0)", NOW - DAY - 1);
  ins("INSERT INTO auth_throttle VALUES ('old-locked', 9, ?, ?)", NOW - DAY - 1, NOW + 60_000);
  ins("INSERT INTO auth_throttle VALUES ('recent', 2, ?, 0)", NOW - DAY + 1);
  ins("INSERT INTO mail_rate VALUES ('both-over', ?, 5, ?, 9)", NOW - DAY - 1, NOW - DAY - 1);
  ins("INSERT INTO mail_rate VALUES ('hour-live', ?, 1, ?, 9)", NOW - 60_000, NOW - DAY - 1);
  ins("INSERT INTO mail_rate VALUES ('day-live', ?, 1, ?, 2)", NOW - DAY - 1, NOW - DAY + 1);
  ins("INSERT INTO mail_day (day, lane, sent) VALUES (?, 'signup', 5)", day(NOW - 31 * DAY));
  ins("INSERT INTO mail_day (day, lane, sent) VALUES (?, 'notice', 1)", day(NOW - 30 * DAY));
  ins("INSERT INTO mail_day (day, lane, sent) VALUES (?, 'account', 2)", day(NOW));
  ins("INSERT INTO sanction_marks (key, until, at) VALUES ('e:gone', ?, ?)", NOW - 1, NOW - DAY);
  ins("INSERT INTO sanction_marks (key, until, at) VALUES ('e:kept', ?, ?)", NOW + 1, NOW - DAY);
  ins("INSERT INTO consents (user_id, kind, version, granted, source, at) VALUES ('u1', 'news', 'news-v1', 1, 'signup', ?)", NOW - 400 * DAY);
  ins('INSERT INTO deleted_ids VALUES (?, ?)', 'd'.repeat(16), NOW - 400 * DAY);
  ins("INSERT INTO protected_skel VALUES ('ana', 'u1', 'trusted')");
  store.prune(NOW);
  const keys = (t, col) => db.prepare(`SELECT ${col} AS k FROM ${t} ORDER BY ${col}`).all().map((r) => r.k);
  assert.deepEqual(keys('mail_tokens', 'hash'), ['t-day', 't-live'], 'a token goes a day after it expires');
  assert.deepEqual(keys('email_holds', 'canon'), ['kept@x.com']);
  assert.deepEqual(keys('auth_throttle', 'key'), ['old-locked', 'recent'], 'a locked row stays');
  assert.deepEqual(keys('mail_rate', 'key'), ['day-live', 'hour-live'], 'a row goes when both its windows are over');
  assert.deepEqual(keys('mail_day', 'day'), [day(NOW - 30 * DAY), day(NOW)]);
  assert.deepEqual(keys('sanction_marks', 'key'), ['e:kept']);
  assert.equal(keys('consents', 'id').length, 1, 'the consent log is never pruned');
  assert.equal(keys('deleted_ids', 'id').length, 1, 'nor the tombstones');
  assert.equal(keys('protected_skel', 'skel').length, 1);
  assert.deepEqual(keys('meta', 'k'), ['schema_version']);
});

// ---- the shared helpers (src/net/account.ts): vectors the Worker and the client must keep -------------

test('normalizeEmail: trimmed and lowercased; one @; an atext local part of 1-64; ASCII labels with a dot; punycode for an IDN; no dead top-level domains; 254 at most', () => {
  const local64 = 'l'.repeat(64);
  const domain189 = 'a'.repeat(63) + '.' + 'b'.repeat(63) + '.' + 'c'.repeat(57) + '.com';
  const ok = [
    [' Ana.Perez+TG@GMail.COM ', 'ana.perez+tg@gmail.com'],
    ['a@b.co', 'a@b.co'],
    ['user@sub.example.com', 'user@sub.example.com'],
    ["O'Brien@x.ie", "o'brien@x.ie"],
    ['\tana@x.com\r\n', 'ana@x.com'],
    ['x@xn--80ak6aa92e.com', 'x@xn--80ak6aa92e.com'],
    ['x@domain.xn--p1ai', 'x@domain.xn--p1ai'],
    ['a-b_c=d?e{f}|~!#$%&*/^`@my-mail.com.ar', 'a-b_c=d?e{f}|~!#$%&*/^`@my-mail.com.ar'],
    [local64 + '@x.com', local64 + '@x.com'],
    [local64 + '@' + domain189, local64 + '@' + domain189],
  ];
  for (const [input, out] of ok) assert.equal(ACC.normalizeEmail(input), out, input);
  assert.equal((local64 + '@' + domain189).length, 254);
  const refused = [
    '', '   ', 'ana', 'ana@', '@gmail.com', 'ana@@gmail.com', 'a@b@c.com', 'ana@gmail', 'ana@gmail.', 'ana@.gmail.com', 'ana@gmail..com',
    'ana perez@gmail.com', '"ana"@gmail.com', 'an\\a@gmail.com', 'ana@gmaíl.com', 'ñandú@gmail.com', 'ana@foo.test', 'ana@foo.invalid',
    'ana@foo.example', 'ana@localhost', 'ana@x.localhost', 'ana@-x.com', 'ana@x-.com', 'ana@1.2.3.4', 'ana@x.c', 'ana@x.c0m',
    '.ana@gmail.com', 'ana.@gmail.com', 'an..a@gmail.com', 'a<b@gmail.com', 'a>b@x.com', 'a,b@gmail.com', 'a(b)@gmail.com', 'a;b@x.com',
    'a:b@x.com', '[a]@x.com', 'ana@x\n.com', 'an\u0000a@x.com', 'ana@x.com\r\nBcc: z@z.com','l'.repeat(65) + '@x.com', local64 + '@' + domain189.replace('c'.repeat(57), 'c'.repeat(58)),
    'ana@' + 'a'.repeat(64) + '.com', 'ana@x_y.com',
  ];
  for (const input of refused) assert.equal(ACC.normalizeEmail(input), null, JSON.stringify(input));
  for (const v of [null, undefined, 5, {}, ['a@b.com']]) assert.equal(ACC.normalizeEmail(v), null, String(v));
});

test('emailCanon: +tag dropped, googlemail.com is gmail.com, a gmail local part without its dots; null for what is not an address', () => {
  const vectors = [
    ['Ana.Perez+tg@GoogleMail.com', 'anaperez@gmail.com'],
    ['a.n.a@gmail.com', 'ana@gmail.com'],
    ['ana+1@gmail.com', 'ana@gmail.com'],
    ['ana+1+2@gmail.com', 'ana@gmail.com'],
    ['a.b@googlemail.com', 'ab@gmail.com'],
    ['ana.perez+x+y@outlook.com', 'ana.perez@outlook.com'],
    ['ANA@Hotmail.com', 'ana@hotmail.com'],
    ['a.b@mail.gmail.com', 'a.b@mail.gmail.com'],
    ['a.b@gmail.com.ar', 'a.b@gmail.com.ar'],
    ['+tag@x.com', '+tag@x.com'],
    [' juan@x.com ', 'juan@x.com'],
  ];
  for (const [input, out] of vectors) assert.equal(ACC.emailCanon(input), out, input);
  for (const v of ['nope', '', 'a@b', null, 7]) assert.equal(ACC.emailCanon(v), null, String(v));
});

test('maskEmail: at most two characters of the local part, never half of it; the domain in full', () => {
  const vectors = [
    ['ana.perez@gmail.com', 'an***@gmail.com'],
    ['Ana@X.com', 'a***@x.com'],
    ['ab@x.com', 'a***@x.com'],
    ['a@x.com', '***@x.com'],
    ['juan+tg@outlook.com', 'ju***@outlook.com'],
    ['nope', ''],
  ];
  for (const [input, out] of vectors) assert.equal(ACC.maskEmail(input), out, input);
});

test('emailTypo: the common domain typos and their fix; null when there is none', () => {
  const vectors = [
    ['ana@gmial.com', 'ana@gmail.com'],
    ['Ana@GMAIL.CON', 'ana@gmail.com'],
    ['x@gmal.com', 'x@gmail.com'],
    ['x@gmail.co', 'x@gmail.com'],
    ['x@hotmial.com', 'x@hotmail.com'],
    ['x@hotmal.com', 'x@hotmail.com'],
    ['x@outlok.com', 'x@outlook.com'],
    ['x@yahoo.con', 'x@yahoo.com'],
    ['ana@gmail.com', null],
    ['x@mygmial.com', null],
    ['nope', null],
  ];
  for (const [input, out] of vectors) assert.equal(ACC.emailTypo(input), out, input);
});

test('nameSkeleton: lowercase, _ . - dropped, the stand-ins, rn→m and vv→w', () => {
  const vectors = [
    ['Adm1n', 'admin'],
    ['B0t', 'bot'],
    ['lnvitado', 'invitado'],
    ['Invitado4821', 'invitadoab2i'],
    ['Soporte_TG', 'soportetg'],
    ['Ana_Admin', 'anaadmin'],
    ['rnoderator', 'moderator'],
    ['vvizard', 'wizard'],
    ['Juan_1', 'juani'],
    ['Juani', 'juani'],
    ['T0rboG0l', 'torbogoi'],
    ['Ana.B-7', 'anabt'],
    ['5teve', 'steve'],
    ['3lla', 'eiia'],
  ];
  for (const [input, out] of vectors) assert.equal(ACC.nameSkeleton(input), out, input);
});
