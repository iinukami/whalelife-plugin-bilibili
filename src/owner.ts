/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { randomUUID } from 'node:crypto';
import { BiliError } from './errors.ts';
import type { AccountState, BiliClientContract, OwnerProfile } from './types.ts';

export interface OwnerStorage { read(): Promise<unknown>; save(value: unknown): Promise<void> }
export interface OwnerState { owner: (OwnerProfile & { url: string }) | null; revision: string; invalidStoredState: boolean }

export function validateOwnerUid(value: unknown): string {
  if (typeof value !== 'string') throw new BiliError('invalid_input');
  const uid = value.trim();
  if (!/^[1-9]\d{0,15}$/.test(uid) || !Number.isSafeInteger(Number(uid))) throw new BiliError('invalid_input');
  return uid;
}

export function validateOwnerProfile(value: unknown, expectedUid?: string): OwnerProfile {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BiliError('malformed_response');
    const profile = value as Record<string, unknown>, uid = validateOwnerUid(profile.uid), name = profile.name;
    // Platform values are accepted exactly, never rewritten into another identity.
    if (profile.uid !== uid || (expectedUid !== undefined && uid !== expectedUid) || typeof name !== 'string'
      || !name.trim() || [...name].length > 80 || /[\p{Cc}\p{Cf}@]/u.test(name) || /[\uD800-\uDFFF]/u.test(name)) throw new BiliError('malformed_response');
    return { uid, name };
  } catch { throw new BiliError('malformed_response'); }
}

function withAbort<T>(task: Promise<T>, signal: AbortSignal, error: () => BiliError): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(error()); };
    signal.addEventListener('abort', abort, { once: true });
    task.then(value => { cleanup(); resolve(value); }, reason => { cleanup(); reject(reason); });
    if (signal.aborted) abort();
  });
}

/** A local user-owned identity setting, independent of platform login or model tools. */
export class OwnerManager {
  readonly ready: Promise<void>;
  private current?: OwnerProfile;
  private revision = randomUUID();
  private invalidStoredState = false;
  private disposed = false;
  private controller = new AbortController();
  private queue: Promise<unknown> = Promise.resolve();
  private closing?: Promise<void>;
  private readonly stop: () => void;
  private readonly client: Pick<BiliClientContract, 'ownerProfile'>;
  private readonly storage: OwnerStorage;
  private readonly signal: AbortSignal;
  private readonly account: () => AccountState | undefined;
  private readonly accountRevision: () => string;
  constructor(client: Pick<BiliClientContract, 'ownerProfile'>, storage: OwnerStorage, signal: AbortSignal,
    account: () => AccountState | undefined, accountRevision: () => string) {
    this.client = client; this.storage = storage; this.signal = signal; this.account = account; this.accountRevision = accountRevision;
    this.stop = () => { this.disposed = true; this.controller.abort(); };
    signal.addEventListener('abort', this.stop, { once: true });
    if (signal.aborted) this.stop();
    this.ready = this.initialize();
  }
  private async initialize() {
    try {
      if (this.disposed) return;
      const value = await withAbort(Promise.resolve().then(() => this.storage.read()), this.controller.signal, () => new BiliError('stopped'));
      if (this.disposed) return;
      if (value === undefined || value === null || (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length)) return;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BiliError('config_invalid');
      const stored = value as Record<string, unknown>;
      if (Object.keys(stored).length !== 1 || !Object.hasOwn(stored, 'owner')) throw new BiliError('config_invalid');
      this.current = stored.owner === null ? undefined : validateOwnerProfile(stored.owner);
    } catch { if (!this.disposed) { this.current = undefined; this.invalidStoredState = true; } }
  }
  snapshot(): OwnerProfile | undefined { return this.current ? { ...this.current } : undefined; }
  identity(): string { return this.revision; }
  state(): OwnerState {
    return { owner: this.current ? { ...this.current, url: 'https://space.bilibili.com/' + this.current.uid } : null,
      revision: this.revision, invalidStoredState: this.invalidStoredState };
  }
  private check(signal: AbortSignal, accountRevision: string, accountMid: number | undefined, revision?: unknown) {
    if (this.disposed || this.signal.aborted) throw new BiliError('stopped');
    if (signal.aborted) throw new BiliError('cancelled');
    if (accountRevision !== this.accountRevision() || accountMid !== this.account()?.mid) throw new BiliError('account_changed');
    if (revision !== undefined && revision !== this.revision) throw new BiliError('config_conflict');
  }
  async set(value: unknown, revision: unknown, signal?: AbortSignal): Promise<OwnerState> {
    if (typeof value !== 'string') throw new BiliError('invalid_input');
    const uid = value.trim() ? validateOwnerUid(value) : '';
    const requestSignal = AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])]);
    const accountRevision = this.accountRevision(), accountMid = this.account()?.mid;
    const task = this.queue.then(async () => {
      await this.ready;
      this.check(requestSignal, accountRevision, accountMid);
      if (typeof revision !== 'string' || revision !== this.revision) throw new BiliError('config_conflict');
      let profile: OwnerProfile | undefined;
      if (uid) {
        const timeout = new AbortController(), querySignal = AbortSignal.any([requestSignal, timeout.signal]);
        const timer = setTimeout(() => timeout.abort(), 20000);
        const failure = () => new BiliError(this.disposed ? 'stopped' : requestSignal.aborted ? 'cancelled' : 'timeout');
        try {
          const options = { signal: querySignal, timeoutMs: 20000, cookie: this.account()?.cookie };
          const result = await withAbort(Promise.resolve().then(() => {
            this.check(requestSignal, accountRevision, accountMid, revision);
            if (querySignal.aborted) throw failure();
            return this.client.ownerProfile(uid, options);
          }), querySignal, failure);
          this.check(requestSignal, accountRevision, accountMid, revision);
          profile = validateOwnerProfile(result, uid);
        } catch (error) {
          this.check(requestSignal, accountRevision, accountMid, revision);
          if (timeout.signal.aborted) throw new BiliError('timeout');
          throw error instanceof BiliError ? error : new BiliError('network_error');
        } finally { clearTimeout(timer); }
      }
      this.check(requestSignal, accountRevision, accountMid, revision);
      try { await this.storage.save({ owner: profile ? { ...profile } : null }); }
      catch { throw new BiliError('persistence_error'); }
      // A write already started cannot be revoked: mirror its committed data even if the caller cancelled meanwhile.
      this.current = profile; this.revision = randomUUID(); this.invalidStoredState = false;
      this.check(requestSignal, accountRevision, accountMid);
      return this.state();
    });
    this.queue = task.catch(() => {});
    return withAbort(task, requestSignal, () => new BiliError(this.disposed ? 'stopped' : 'cancelled'));
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.stop(); this.signal.removeEventListener('abort', this.stop);
    this.closing = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([Promise.allSettled([this.ready, this.queue]), new Promise<void>(resolve => { timer = setTimeout(resolve, 300); })]); }
      finally { if (timer) clearTimeout(timer); }
    })();
    return this.closing;
  }
}
