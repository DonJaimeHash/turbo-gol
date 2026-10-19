/**
 * Match tickets for matches hosted on a community node.
 *
 * Same claims as the existing HS256 tickets (server/src/auth.ts TicketClaims: sub, mid, team, slot,
 * role, name, iat, exp, jti) plus `aud: 'node:<nodeId>'`, signed EdDSA by the control plane. The
 * browser treats the ticket as an opaque string and sends it exactly as today, in the WebSocket
 * subprotocol list [WS_SUBPROTOCOL, 'ticket.<jwt>'], to the absolute wsUrl the matchmaker returned, so the
 * client needs no change to play on a community node.
 *
 * The node checks: signature (control public key pinned at registration), expiry, audience (this
 * node only: a ticket for node A is worthless on node B), match id, role and the claim shapes.
 * Single use (jti) is enforced by the match room, like MatchDO does.
 */
import { randomHexId, signEdJwt, verifyEdJwt } from './edcrypto';

export const NODE_TICKET_TTL_SECONDS = 90;

/** server/src/auth.ts TicketClaims (role 'player') + the node audience. */
export interface NodeTicketClaims {
  sub: string;
  mid: string;
  team: 0 | 1;
  slot: number;
  role: 'player';
  name: string;
  iat: number;
  exp: number;
  jti: string;
  aud: string;
}

export interface NodeTicketInput {
  sub: string;
  mid: string;
  team: 0 | 1;
  slot: number;
  name: string;
  nodeId: string;
}

export function nodeAudience(nodeId: string): string {
  return 'node:' + nodeId;
}

export async function createNodeTicket(controlKey: CryptoKey, t: NodeTicketInput, nowMs: number = Date.now()): Promise<string> {
  const iat = Math.floor(nowMs / 1000);
  const claims: NodeTicketClaims = {
    sub: t.sub,
    mid: t.mid,
    team: t.team,
    slot: t.slot,
    role: 'player',
    name: t.name,
    iat,
    exp: iat + NODE_TICKET_TTL_SECONDS,
    jti: randomHexId(16),
    aud: nodeAudience(t.nodeId),
  };
  return signEdJwt(controlKey, claims);
}

/** The claims when `token` is a valid, unexpired player ticket for `matchId` on `nodeId`; else null. */
export async function verifyNodeTicket(controlPublic: CryptoKey, token: string, matchId: string, nodeId: string, nowMs: number = Date.now()): Promise<NodeTicketClaims | null> {
  const c = await verifyEdJwt<NodeTicketClaims>(controlPublic, token, Math.floor(nowMs / 1000));
  if (!c) return null;
  if (c.aud !== nodeAudience(nodeId) || c.mid !== matchId || c.role !== 'player') return null;
  if (typeof c.sub !== 'string' || c.sub.length === 0 || c.sub.length > 64) return null;
  if (typeof c.jti !== 'string' || !/^[0-9a-f]{32}$/.test(c.jti)) return null;
  if ((c.team !== 0 && c.team !== 1) || !Number.isInteger(c.slot) || c.slot < 0 || c.slot > 7) return null;
  if (typeof c.name !== 'string' || c.name.length > 64) return null;
  return c;
}
