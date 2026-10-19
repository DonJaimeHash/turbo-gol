/**
 * Trade a one-time registration token for a node identity (what `turbogol-node register` does,
 * minus the file writing). The key pair is generated HERE, on the operator's machine; only the
 * public half is sent.
 */
import type { BuildId, NodeCapacity, NodeRole, NodeSpecs, NodeTransport, RegisterAnswer, RegisterRequest } from '../shared/controlProtocol';
import { generateEd25519 } from '../shared/edcrypto';
import type { NodeIdentityFile } from './runtime';

export interface RegisterParams {
  /** http(s) base of the control plane. */
  control: string;
  token: string;
  roles: NodeRole[];
  /** 'wss' needs publicUrl; 'rtc' (home PCs) needs nothing open. */
  transports: NodeTransport[];
  publicUrl: string | null;
  name?: string;
  build: BuildId;
  specs: NodeSpecs;
  capacity: NodeCapacity;
}

export class RegisterError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(`${code}${message ? ': ' + message : ''}`);
    this.code = code;
  }
}

export async function registerNode(p: RegisterParams): Promise<NodeIdentityFile> {
  const control = p.control.replace(/\/$/, '');
  const keys = await generateEd25519();
  const body: RegisterRequest = {
    token: p.token,
    publicKey: keys.publicKey,
    ...(p.name ? { name: p.name } : {}),
    roles: p.roles,
    transports: p.transports,
    publicUrl: p.publicUrl,
    build: p.build,
    specs: p.specs,
    capacity: p.capacity,
  };
  const res = await fetch(`${control}/nodes/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const out = (await res.json()) as RegisterAnswer & { error?: string; message?: string };
  if (!res.ok) throw new RegisterError(out.error ?? String(res.status), out.message);
  return {
    nodeId: out.nodeId,
    operatorId: out.operatorId,
    name: out.name,
    region: out.region,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    controlPublicKey: out.controlPublicKey,
    controlUrl: out.controlUrl,
    httpBase: control,
    roles: p.roles,
    transports: p.transports,
    publicUrl: p.publicUrl ? p.publicUrl.replace(/\/$/, '') : null,
  };
}
