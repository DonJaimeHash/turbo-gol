/**
 * Which training records the menus show and where a finished run is saved.
 *
 *   guest     localStorage TRAINING_RECORDS_KEY: this browser only.
 *   account   the server (POST /api/me/training through `remote`) plus a local copy under
 *             accountRecordsKey(playerId). The menus read the copy at once and sync() replaces it
 *             with the server's merge. Every sync uploads the whole copy and the server keeps the
 *             best per pack, so a run finished offline (or while a request failed) goes up with
 *             the next sync.
 *
 * The first time an account syncs in this browser, the guest records move into it (best per pack)
 * and the guest key is cleared: they belong to that player now.
 */
import {
  TRAINING_RECORDS_KEY,
  accountRecordsKey,
  defaultTrainingStorage,
  loadTrainingRecords,
  mergeTrainingRecords,
  saveTrainingResult,
  writeTrainingRecords,
} from './trainingRecords';
import type { RecordUpdate, StorageLike, TrainingRecords } from './trainingRecords';

export interface TrainingRemote {
  /** The signed-in account's id (the session `sub`), null for a guest. */
  accountId(): string | null;
  /** Merge `records` into the account on the server; resolves the account's records after the merge. */
  push(records: TrainingRecords): Promise<TrainingRecords>;
}

/** What the training screen and a training session need (the Game's TrainingStore). */
export interface TrainingRecordsView {
  /** The current player's records, from this browser (no request). */
  records(): TrainingRecords;
  /** Bring the account's records up to date with the server (a guest: resolves at once). */
  sync(): Promise<TrainingRecords>;
  /** A completed run: saved for the current player (and sent to the account's server copy). */
  recordResult(packId: string, passed: number, shots: number, now: number): RecordUpdate;
}

export class TrainingStore implements TrainingRecordsView {
  private readonly remote: TrainingRemote | null;
  private readonly storage: StorageLike | null;
  /** Syncs run one after another (a run saved while one is in flight gets its own). */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(remote: TrainingRemote | null, storage: StorageLike | null = defaultTrainingStorage()) {
    this.remote = remote;
    this.storage = storage;
  }

  private accountId(): string | null {
    return this.remote === null ? null : this.remote.accountId();
  }

  private keyFor(id: string | null): string {
    return id === null ? TRAINING_RECORDS_KEY : accountRecordsKey(id);
  }

  records(): TrainingRecords {
    return loadTrainingRecords(this.storage, this.keyFor(this.accountId()));
  }

  recordResult(packId: string, passed: number, shots: number, now: number): RecordUpdate {
    const id = this.accountId();
    const upd = saveTrainingResult(packId, passed, shots, now, this.storage, this.keyFor(id));
    if (id !== null && upd.newBest) void this.sync().catch(() => undefined);
    return upd;
  }

  sync(): Promise<TrainingRecords> {
    const run = this.chain.then(() => this.syncOnce());
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async syncOnce(): Promise<TrainingRecords> {
    const id = this.accountId();
    if (id === null || this.remote === null) return this.records();
    const key = accountRecordsKey(id);
    let local = loadTrainingRecords(this.storage, key);
    const guest = loadTrainingRecords(this.storage, TRAINING_RECORDS_KEY);
    if (Object.keys(guest).length > 0) {
      local = mergeTrainingRecords(local, guest);
      // Only clear the guest copy once the account's copy holds it.
      if (writeTrainingRecords(local, this.storage, key)) writeTrainingRecords({}, this.storage, TRAINING_RECORDS_KEY);
    }
    const server = await this.remote.push(local);
    if (this.accountId() !== id) return server; // signed out (or switched) meanwhile: leave the copies alone
    // A run may have been saved while the request was out: merge it back in.
    const merged = mergeTrainingRecords(server, loadTrainingRecords(this.storage, key));
    writeTrainingRecords(merged, this.storage, key);
    return merged;
  }
}
