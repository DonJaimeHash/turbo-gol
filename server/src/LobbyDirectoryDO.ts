/**
 * LobbyDirectoryDO: one object ('lobbies-v1') that knows every live custom lobby: join codes ->
 * lobby ids (public and private lobbies alike) and the public list the menus show. Each LobbyDO
 * keeps its row fresh (/upsert on every change plus a heartbeat from its alarm) and removes it when
 * it closes; rows not refreshed for STALE_MS are dropped (a lobby that died without saying so).
 * Reached only with the internal header.
 *
 *   POST /allocate { lobbyId }                   -> { code }      a fresh unique code
 *   POST /upsert   { code, lobbyId, visibility, summary }
 *   POST /remove   { code, lobbyId }
 *   GET  /resolve?code=                          -> { lobbyId } | 404
 *   GET  /list?region=                           -> { lobbies: LobbySummary[] } (public only, region first)
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { error, json, readJson } from './env';
import { checkInternal } from './auth';
import type { LobbySummary, LobbyVisibility } from '../../src/net/account';

/** No I, O, 0, 1: a code read aloud or from a screenshot is unambiguous. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;
const STALE_MS = 15 * 60_000;
const LIST_MAX = 100;
const SWEEP_MS = 10 * 60_000;

export function randomCode(): string {
  const b = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(b);
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return s;
}

/** User input -> canonical code (upper case, separators dropped, O -> 0 never needed: no ambiguous chars in the alphabet). */
export function normalizeCode(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length !== CODE_LENGTH) return null;
  for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return null;
  return s;
}

interface Row {
  lobbyId: string;
  visibility: LobbyVisibility;
  summary: LobbySummary | null;
  updatedAt: number;
}

/** The public list: the caller's region first, open lobbies with room before full / in-game ones, then by players. Pure. */
export function listLobbies(rows: Iterable<Row>, region: string | null, now: number, max: number = LIST_MAX): LobbySummary[] {
  const out: LobbySummary[] = [];
  for (const r of rows) if (r.visibility === 'public' && r.summary && now - r.updatedAt < STALE_MS) out.push(r.summary);
  const rank = (l: LobbySummary): number => (l.inGame ? 2 : l.players >= l.max ? 1 : 0);
  out.sort((a, b) => Number(b.region === region) - Number(a.region === region) || rank(a) - rank(b) || b.players - a.players || a.name.localeCompare(b.name));
  return out.slice(0, max);
}

export class LobbyDirectoryDO extends DurableObject<Env> {
  private readonly rows = new Map<string, Row>();
  private loaded: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.loaded = ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      for (const [k, v] of await ctx.storage.list<Row>({ prefix: 'c:' })) {
        if (now - v.updatedAt < STALE_MS) this.rows.set(k.slice(2), v);
        else void ctx.storage.delete(k);
      }
      if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(now + SWEEP_MS);
    });
  }

  override async alarm(): Promise<void> {
    await this.loaded;
    const now = Date.now();
    for (const [code, r] of this.rows) {
      if (now - r.updatedAt >= STALE_MS) {
        this.rows.delete(code);
        await this.ctx.storage.delete('c:' + code);
      }
    }
    await this.ctx.storage.setAlarm(now + SWEEP_MS);
  }

  override async fetch(request: Request): Promise<Response> {
    await this.loaded;
    if (!this.env.JWT_SECRET || !(await checkInternal(this.env.JWT_SECRET, request))) return error(403, 'forbidden');
    const url = new URL(request.url);
    const now = Date.now();
    if (request.method === 'GET' && url.pathname === '/list') {
      return json({ lobbies: listLobbies(this.rows.values(), url.searchParams.get('region'), now) });
    }
    if (request.method === 'GET' && url.pathname === '/count') {
      const region = url.searchParams.get('region');
      let n = 0;
      for (const r of this.rows.values()) if (r.visibility === 'public' && r.summary && r.summary.region === region && now - r.updatedAt < STALE_MS) n++;
      return json({ count: n });
    }
    if (request.method === 'GET' && url.pathname === '/resolve') {
      const code = normalizeCode(url.searchParams.get('code'));
      const r = code ? this.rows.get(code) : undefined;
      return r && now - r.updatedAt < STALE_MS ? json({ lobbyId: r.lobbyId }) : error(404, 'no_lobby', 'No existe una sala con ese código');
    }
    if (request.method !== 'POST') return error(404, 'not_found');
    const b = await readJson<{ lobbyId?: unknown; code?: unknown; visibility?: unknown; summary?: unknown }>(request);
    if (!b || typeof b.lobbyId !== 'string') return error(400, 'bad_request');
    if (url.pathname === '/allocate') {
      let code = randomCode();
      while (this.rows.has(code)) code = randomCode();
      const row: Row = { lobbyId: b.lobbyId, visibility: 'private', summary: null, updatedAt: now };
      this.rows.set(code, row);
      await this.ctx.storage.put('c:' + code, row);
      return json({ code });
    }
    const code = normalizeCode(b.code);
    if (!code) return error(400, 'bad_code');
    const cur = this.rows.get(code);
    if (cur && cur.lobbyId !== b.lobbyId) return error(409, 'code_owned'); // a stale lobby must not overwrite a newer owner
    if (url.pathname === '/upsert') {
      const row: Row = { lobbyId: b.lobbyId, visibility: b.visibility === 'public' ? 'public' : 'private', summary: (b.summary as LobbySummary) ?? null, updatedAt: now };
      this.rows.set(code, row);
      await this.ctx.storage.put('c:' + code, row);
      return json({ ok: true });
    }
    if (url.pathname === '/remove') {
      this.rows.delete(code);
      await this.ctx.storage.delete('c:' + code);
      return json({ ok: true });
    }
    return error(404, 'not_found');
  }
}
