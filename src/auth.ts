/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { randomUUID } from 'node:crypto';
import { BiliError } from './errors.ts';
import type { AccountState, BiliClientContract, CallOptions } from './types.ts';

export interface AccountStorage { read(): Promise<unknown>; save(value: unknown): Promise<void> }
export interface PublicAccount { loggedIn: boolean; revision: string; mid?: number; name?: string; invalidStoredState?: boolean }
export interface LoginState { state: 'waiting' | 'scanned' | 'expired' | 'confirmed'; account?: PublicAccount }
interface PendingLogin {
  id: string; key: string; expiresAt: number; generation: number; revision: string;
  lastPoll: number; lastState: LoginState; controller: AbortController; polling?: Promise<LoginState>;
  expiryTimer?: ReturnType<typeof setTimeout>;
}
// Only these browser cookie names are retained; unrelated site/tracking cookies are discarded.
const retainedCookieNames = new Set(['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid',
  'buvid3', 'buvid4', 'buvid_fp', 'buvid_fp_plain', 'b_nut', 'b_lsid', '_uuid', 'bili_ticket', 'bili_ticket_expires']);
export function normalizeCookie(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 16384 || /[\x00-\x1f\x7f]/.test(value)) throw new BiliError('invalid_input');
  const input = value.trim().replace(/^Cookie:\s*/i, '');
  const cookies = new Map<string, string>();
  for (const part of input.split(';')) {
    const piece = part.trim();
    if (!piece) continue;
    const match = /^([A-Za-z0-9_-]+)=([^\s;,"\\]*)$/.exec(piece);
    if (!match || match[2]!.length > 8192) throw new BiliError('invalid_input');
    const [, name, content] = match;
    if (!retainedCookieNames.has(name!)) continue;
    if (!content || !/^[\x21-\x7e]+$/.test(content) || cookies.has(name!)) throw new BiliError('invalid_input');
    cookies.set(name!, content);
  }
  if (!cookies.has('SESSDATA') || !/^[A-Fa-f0-9]{32}$/.test(cookies.get('bili_jct') ?? '') ||
      !/^[1-9]\d{0,15}$/.test(cookies.get('DedeUserID') ?? '') || !Number.isSafeInteger(Number(cookies.get('DedeUserID')))) throw new BiliError('invalid_input');
  return [...cookies].map(([key, content]) => `${key}=${content}`).join('; ');
}
function cookieMid(cookie: string): number { return Number(/(?:^|; )DedeUserID=(\d+)(?:;|$)/.exec(cookie)?.[1]); }
function safeName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 240 || /[\x00-\x1f\x7f]/.test(value)) throw new BiliError('malformed_response');
  return value;
}
function validRevision(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(value); }

export class AuthManager {
  readonly ready: Promise<void>;
  private current?: AccountState;
  private revision: string = randomUUID();
  private invalidStoredState = false;
  private generation = 0;
  private pending?: PendingLogin;
  private operation?: AbortController;
  private saving: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private readonly stop: () => void;
  private readonly client: BiliClientContract;
  private readonly storage: AccountStorage;
  private readonly signal: AbortSignal;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  constructor(client: BiliClientContract, storage: AccountStorage,
    signal: AbortSignal, timeoutMs = 15000, now: () => number = Date.now) {
    this.client = client; this.storage = storage; this.signal = signal; this.timeoutMs = timeoutMs; this.now = now;
    this.stop = () => { this.disposed = true; this.invalidate(); };
    signal.addEventListener('abort', this.stop, { once: true });
    if (signal.aborted) this.stop();
    this.ready = this.initialize();
  }
  private async initialize() {
    let stored: unknown;
    try { stored = await this.storage.read(); } catch { this.invalidStoredState = true; return; }
    if (this.disposed || this.signal.aborted) return;
    if (stored === undefined || stored === null || (typeof stored === 'object' && !Array.isArray(stored) && Object.keys(stored).length === 0)) return;
    try {
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new BiliError('config_invalid');
      const data = stored as Record<string, unknown>;
      if (data.schema !== 1 || !validRevision(data.revision) || !Object.hasOwn(data, 'account')) throw new BiliError('config_invalid');
      if (data.account === null) { this.revision = data.revision; return; }
      if (!data.account || typeof data.account !== 'object' || Array.isArray(data.account)) throw new BiliError('config_invalid');
      const account = data.account as Record<string, unknown>;
      const cookie = normalizeCookie(account.cookie);
      if (!Number.isSafeInteger(account.mid) || account.mid !== cookieMid(cookie)) throw new BiliError('config_invalid');
      this.current = { cookie, mid: account.mid as number, name: safeName(account.name), revision: data.revision };
      this.revision = data.revision;
    } catch { this.current = undefined; this.invalidStoredState = true; }
  }
  state(): PublicAccount {
    return { loggedIn: !!this.current, revision: this.revision,
      ...(this.current ? { mid: this.current.mid, name: this.current.name } : {}),
      ...(this.invalidStoredState ? { invalidStoredState: true } : {}) };
  }
  /** Backend-only snapshot. Never expose to a model, page, receipt or log. */
  snapshot(): AccountState | undefined { return this.current ? { ...this.current } : undefined; }
  private check(generation?: number, signal?: AbortSignal) {
    if (this.disposed || this.signal.aborted) throw new BiliError('stopped');
    if (signal?.aborted) throw new BiliError('cancelled');
    if (generation !== undefined && generation !== this.generation) throw new BiliError('config_conflict');
  }
  private invalidate() {
    this.generation++;
    this.operation?.abort(); this.operation = undefined;
    this.clearPending();
  }
  private clearPending() {
    if (this.pending?.expiryTimer) clearTimeout(this.pending.expiryTimer);
    this.pending?.controller.abort(); this.pending = undefined;
  }
  private reserve(expectedRevision?: string) {
    this.check();
    if (expectedRevision !== undefined && expectedRevision !== this.revision) throw new BiliError('config_conflict');
    this.invalidate();
    const controller = new AbortController(); this.operation = controller;
    return { generation: this.generation, revision: this.revision, controller };
  }
  private options(controller?: AbortController, signal?: AbortSignal, cookie?: string): CallOptions {
    return { signal: AbortSignal.any([this.signal, ...(controller ? [controller.signal] : []), ...(signal ? [signal] : [])]),
      timeoutMs: this.timeoutMs, ...(cookie ? { cookie } : {}) };
  }
  private async verified(cookie: string, options: CallOptions) {
    const account = await this.client.account({ ...options, cookie });
    if (!Number.isSafeInteger(account.mid) || account.mid <= 0 || account.mid !== cookieMid(cookie)) throw new BiliError('account_changed');
    return { cookie, mid: account.mid, name: safeName(account.name) };
  }
  private commit(account: Omit<AccountState, 'revision'> | undefined, generation: number, revision: string, signal?: AbortSignal): Promise<PublicAccount> {
    const change = this.saving.then(async () => {
      this.check(generation, signal);
      if (revision !== this.revision) throw new BiliError('config_conflict');
      const nextRevision = randomUUID();
      try { await this.storage.save({ schema: 1, revision: nextRevision, account: account ?? null }); }
      catch { throw new BiliError('persistence_error'); }
      // A save already in flight cannot be undone; mirror its committed revision before rejecting a superseded request.
      this.revision = nextRevision;
      this.current = account ? { ...account, revision: nextRevision } : undefined;
      this.invalidStoredState = false;
      this.check(generation, signal);
      return this.state();
    });
    this.saving = change.catch(() => {});
    return change;
  }
  async beginLogin(signal?: AbortSignal): Promise<{ id: string; url: string }> {
    await this.ready; this.check(undefined, signal);
    const operation = this.reserve();
    const result = await this.client.beginLogin(this.options(operation.controller, signal));
    this.check(operation.generation, signal);
    let url: URL;
    try { url = new URL(result.url); } catch { throw new BiliError('malformed_response'); }
    if (url.origin !== 'https://passport.bilibili.com' || url.username || url.password || result.url.length > 4096 ||
        typeof result.key !== 'string' || !/^[A-Za-z0-9_-]{8,256}$/.test(result.key)) throw new BiliError('malformed_response');
    const pending: PendingLogin = { ...operation, id: randomUUID(), key: result.key, expiresAt: this.now() + 180000,
      lastPoll: -Infinity, lastState: { state: 'waiting' } };
    this.pending = pending;
    pending.expiryTimer = setTimeout(() => { if (this.pending === pending) this.clearPending(); }, 180000);
    pending.expiryTimer.unref();
    return { id: pending.id, url: result.url };
  }
  async pollLogin(id: unknown, signal?: AbortSignal): Promise<LoginState> {
    await this.ready; this.check(undefined, signal);
    const pending = this.pending;
    if (!pending || typeof id !== 'string' || id !== pending.id) throw new BiliError('reference_unavailable');
    this.check(pending.generation, signal);
    if (pending.expiresAt <= this.now()) { this.clearPending(); return { state: 'expired' }; }
    if (pending.polling) return pending.polling;
    if (this.now() - pending.lastPoll < 2000) return { ...pending.lastState };
    pending.lastPoll = this.now();
    const task = (async (): Promise<LoginState> => {
      const result = await this.client.pollLogin(pending.key, this.options(pending.controller, signal));
      this.check(pending.generation, signal);
      if (this.pending !== pending || pending.expiresAt <= this.now()) throw new BiliError('reference_unavailable');
      if (result.state === 'confirmed') {
        const cookie = normalizeCookie(result.cookie);
        const account = await this.verified(cookie, this.options(pending.controller, signal));
        this.check(pending.generation, signal);
        const saved = await this.commit(account, pending.generation, pending.revision, signal);
        if (this.pending === pending) this.clearPending();
        return { state: 'confirmed', account: saved };
      }
      pending.lastState = { state: result.state };
      if (result.state === 'expired') this.clearPending();
      return { ...pending.lastState };
    })();
    pending.polling = task;
    try { return await task; } finally { if (pending.polling === task) pending.polling = undefined; }
  }
  async importCookie(value: unknown, expectedRevision: unknown, signal?: AbortSignal): Promise<PublicAccount> {
    await this.ready; this.check(undefined, signal);
    if (!validRevision(expectedRevision)) throw new BiliError('config_conflict');
    const cookie = normalizeCookie(value);
    const operation = this.reserve(expectedRevision);
    const account = await this.verified(cookie, this.options(operation.controller, signal));
    this.check(operation.generation, signal);
    return this.commit(account, operation.generation, operation.revision, signal);
  }
  async logout(expectedRevision: unknown, signal?: AbortSignal): Promise<PublicAccount> {
    await this.ready; this.check(undefined, signal);
    if (!validRevision(expectedRevision)) throw new BiliError('config_conflict');
    const operation = this.reserve(expectedRevision);
    return this.commit(undefined, operation.generation, operation.revision, signal);
  }
  async folders(signal?: AbortSignal) {
    await this.ready; this.check(undefined, signal);
    const account = this.snapshot();
    if (!account) throw new BiliError('login_required');
    const result = await this.client.folders(account.mid, this.options(undefined, signal, account.cookie));
    this.check(undefined, signal);
    if (account.revision !== this.revision) throw new BiliError('account_changed');
    return result;
  }
  async dispose() { this.stop(); this.signal.removeEventListener('abort', this.stop); await this.saving; }
}
