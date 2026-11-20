/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { randomUUID } from 'node:crypto';
import { BiliError } from './errors.ts';
import { validateLoginUrl } from './login-url.ts';
import { refreshToken as validateRefreshToken } from './refresh-client.ts';
import { normalizeCookie, removedCookieNames, sameCookieAuthentication } from './cookies.ts';
export { normalizeCookie } from './cookies.ts';
import type { AccountState, BiliClientContract, CallOptions } from './types.ts';

export interface AccountStorage { read(): Promise<unknown>; save(value: unknown): Promise<void> }
export interface AuthDependencies {
  prepareRefreshCookie?: (cookie: string, options: CallOptions) => Promise<string>;
  discardRefreshDevice?: (cookies: readonly string[], options: CallOptions) => Promise<void>;
}
export interface PublicAccount { loggedIn: boolean; revision: string; mid?: number; name?: string; invalidStoredState?: boolean }
export interface LoginState { state: 'waiting' | 'scanned' | 'expired' | 'confirmed'; account?: PublicAccount }
interface PendingLogin {
  id: string; key: string; expiresAt: number; generation: number; revision: string;
  lastPoll: number; lastState: LoginState; controller: AbortController; polling?: Promise<LoginState>;
  expiryTimer?: ReturnType<typeof setTimeout>;
}
function cookieMid(cookie: string): number { return Number(/(?:^|; )DedeUserID=(\d+)(?:;|$)/.exec(cookie)?.[1]); }
function safeName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 240 || /[\x00-\x1f\x7f]/.test(value)) throw new BiliError('malformed_response');
  return value;
}
function validRevision(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(value); }
function waitForRefresh(flight: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new BiliError('cancelled')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    flight.then(() => { cleanup(); resolve(); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}

export class AuthManager {
  readonly ready: Promise<void>;
  private current?: AccountState;
  private revision: string = randomUUID();
  private invalidStoredState = false;
  private unverifiedRefresh = false;
  private generation = 0;
  private pending?: PendingLogin;
  private operation?: AbortController;
  private saving: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private refreshEnabled = false;
  private refreshController?: AbortController;
  private refreshFlight?: Promise<void>;
  private nextRefreshCheck = 0;
  private lastRefreshCheck?: number;
  private refreshStatus = 'waiting';
  private readonly stop: () => void;
  private readonly client: BiliClientContract;
  private readonly storage: AccountStorage;
  private readonly signal: AbortSignal;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly dependencies: AuthDependencies;
  constructor(client: BiliClientContract, storage: AccountStorage,
    signal: AbortSignal, timeoutMs = 15000, now: () => number = Date.now, dependencies: AuthDependencies = {}) {
    this.client = client; this.storage = storage; this.signal = signal; this.timeoutMs = timeoutMs; this.now = now;
    this.dependencies = dependencies;
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
      const token = account.refreshToken === undefined ? undefined : validateRefreshToken(account.refreshToken);
      if (account.refreshState !== undefined && (!token || !['pending', 'confirming', 'uncertain'].includes(String(account.refreshState)))) throw new BiliError('config_invalid');
      this.current = { cookie, mid: account.mid as number, name: safeName(account.name), revision: data.revision,
        ...(token ? { refreshToken: token } : {}), ...(account.refreshState ? { refreshState: 'uncertain' as const } : {}) };
      this.unverifiedRefresh = account.refreshState === 'pending' || account.refreshState === 'uncertain';
      this.revision = data.revision;
    } catch { this.current = undefined; this.invalidStoredState = true; }
  }
  state(): PublicAccount {
    return { loggedIn: !!this.current && !this.unverifiedRefresh, revision: this.revision,
      ...(this.current && !this.unverifiedRefresh ? { mid: this.current.mid, name: this.current.name } : {}),
      ...(this.invalidStoredState ? { invalidStoredState: true } : {}) };
  }
  /** Backend-only snapshot. Never expose to a model, page, receipt or log. */
  snapshot(): AccountState | undefined { return this.current && !this.unverifiedRefresh ? { ...this.current } : undefined; }
  /** Credential rotation preserves this identity; a deliberate login/import/logout changes it. */
  identity(): string { return this.current?.revision ?? this.revision; }
  configureRefresh(enabled: boolean) {
    if (enabled === this.refreshEnabled) return;
    this.refreshEnabled = enabled; this.nextRefreshCheck = 0;
    this.refreshController?.abort();
  }
  renewalState() {
    return { enabled: this.refreshEnabled, available: Boolean(this.current?.refreshToken),
      status: !this.refreshEnabled ? 'disabled' : !this.current?.refreshToken ? 'needs_login'
        : this.current.refreshState ? 'uncertain' : this.refreshStatus,
      ...(this.lastRefreshCheck !== undefined ? { lastCheckedAt: this.lastRefreshCheck } : {}) };
  }
  private check(generation?: number, signal?: AbortSignal) {
    if (this.disposed || this.signal.aborted) throw new BiliError('stopped');
    if (signal?.aborted) throw new BiliError('cancelled');
    if (generation !== undefined && generation !== this.generation) throw new BiliError('config_conflict');
  }
  private invalidate() {
    this.generation++;
    this.refreshController?.abort(); this.nextRefreshCheck = 0; this.refreshStatus = 'waiting';
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
  private releaseOperation(controller: AbortController) { if (this.operation === controller) this.operation = undefined; }
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
      this.unverifiedRefresh = false;
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
    try {
      const result = await this.client.beginLogin(this.options(operation.controller, signal));
      this.check(operation.generation, signal);
      const url = validateLoginUrl(result.url);
      if (typeof result.key !== 'string' || !/^[A-Za-z0-9_-]{8,256}$/.test(result.key)) throw new BiliError('malformed_response');
      const pending: PendingLogin = { ...operation, id: randomUUID(), key: result.key, expiresAt: this.now() + 180000,
        lastPoll: -Infinity, lastState: { state: 'waiting' } };
      this.pending = pending;
      pending.expiryTimer = setTimeout(() => { if (this.pending === pending) this.clearPending(); }, 180000);
      pending.expiryTimer.unref();
      return { id: pending.id, url };
    } finally { this.releaseOperation(operation.controller); }
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
        const withToken = { ...account, ...(result.refreshToken ? { refreshToken: validateRefreshToken(result.refreshToken) } : {}) };
        this.check(pending.generation, signal);
        const saved = await this.commit(withToken, pending.generation, pending.revision, signal);
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
  async importCookie(value: unknown, expectedRevision: unknown, signal?: AbortSignal, refreshToken?: unknown): Promise<PublicAccount> {
    await this.ready; this.check(undefined, signal);
    if (!validRevision(expectedRevision)) throw new BiliError('config_conflict');
    const cookie = normalizeCookie(value);
    const token = refreshToken === undefined || refreshToken === '' ? undefined : validateRefreshToken(refreshToken);
    const operation = this.reserve(expectedRevision);
    try {
      const account = await this.verified(cookie, this.options(operation.controller, signal));
      this.check(operation.generation, signal);
      return await this.commit({ ...account, ...(token ? { refreshToken: token } : {}) }, operation.generation, operation.revision, signal);
    } finally { this.releaseOperation(operation.controller); }
  }
  async logout(expectedRevision: unknown, signal?: AbortSignal): Promise<PublicAccount> {
    await this.ready; this.check(undefined, signal);
    if (!validRevision(expectedRevision)) throw new BiliError('config_conflict');
    const operation = this.reserve(expectedRevision);
    try { return await this.commit(undefined, operation.generation, operation.revision, signal); }
    finally { this.releaseOperation(operation.controller); }
  }
  async folders(signal?: AbortSignal) {
    await this.ready; this.check(undefined, signal);
    await this.ensureFresh(signal);
    const account = this.snapshot();
    if (!account) throw new BiliError('login_required');
    const result = await this.client.folders(account.mid, this.options(undefined, signal, account.cookie));
    this.check(undefined, signal);
    if (account.revision !== this.identity()) throw new BiliError('account_changed');
    return result;
  }
  private saveRefresh(account: AccountState, generation: number, signal: AbortSignal): Promise<void> {
    const revision = this.revision;
    const task = this.saving.then(async () => {
      this.check(generation, signal);
      if (this.revision !== revision || !this.refreshEnabled) throw new BiliError('config_conflict');
      const nextRevision = randomUUID(), { revision: identity, ...saved } = account;
      try { await this.storage.save({ schema: 1, revision: nextRevision, account: saved }); }
      catch { throw new BiliError('persistence_error'); }
      this.current = { ...saved, revision: identity }; this.revision = nextRevision;
      this.unverifiedRefresh = saved.refreshState === 'pending' || saved.refreshState === 'uncertain';
      this.check(generation, signal);
    });
    this.saving = task.catch(() => {}); return task;
  }
  /** At most one on-demand check each day. Failed checks cool down; uncertain writes never replay. */
  async ensureFresh(signal?: AbortSignal): Promise<void> {
    await this.ready; this.check(undefined, signal);
    if (this.refreshFlight) {
      await waitForRefresh(this.refreshFlight, AbortSignal.any([this.signal, ...(signal ? [signal] : [])])); this.check(undefined, signal);
      if (this.unverifiedRefresh) throw new BiliError('login_required');
      return;
    }
    if (this.unverifiedRefresh) throw new BiliError('login_required');
    if (!this.refreshEnabled || !this.current?.refreshToken || this.current.refreshState || this.pending || this.operation) return;
    if (this.now() < this.nextRefreshCheck) return;
    const original = this.snapshot()!, generation = this.generation, controller = new AbortController();
    this.refreshController = controller;
    const options = this.options(controller, signal, original.cookie);
    const check = () => {
      this.check(generation, options.signal);
      if (!this.refreshEnabled || this.current?.revision !== original.revision) throw new BiliError('config_conflict');
    };
    options.assertCurrent = check;
    const task = (async () => {
      this.refreshStatus = 'checking'; this.lastRefreshCheck = this.now(); this.nextRefreshCheck = this.now() + 15 * 60 * 1000;
      try {
        if (this.dependencies.prepareRefreshCookie) {
          const prepared = normalizeCookie(await this.dependencies.prepareRefreshCookie(original.cookie, options)); check();
          if (!sameCookieAuthentication(original.cookie, prepared)) throw new BiliError('account_changed');
          options.cookie = prepared;
        }
        const info = await this.client.checkRefresh(options); check();
        if (!info.refresh) { this.refreshStatus = 'current'; this.nextRefreshCheck = this.now() + 86400000; return; }
        const csrf = await this.client.refreshCsrf(info.timestamp, options); check();
        await this.saveRefresh({ ...original, cookie: options.cookie!, refreshState: 'pending' }, generation, options.signal!); check();
        const fresh = await this.client.renewCookies(original.refreshToken!, csrf, options); check();
        const cookie = normalizeCookie(fresh.cookie), token = validateRefreshToken(fresh.refreshToken);
        if (cookieMid(cookie) !== original.mid) throw new BiliError('account_changed');
        const removed = removedCookieNames(fresh.removedCookieNames);
        // The platform already rotated credentials. Persist the unverified candidate before any fallible follow-up.
        // A pending snapshot is unavailable to business calls, including after restart; it is never a verified login.
        await this.saveRefresh({ ...original, cookie, refreshToken: token, refreshState: 'pending' }, generation, options.signal!); check();
        if (removed.includes('buvid3') && this.dependencies.discardRefreshDevice) {
          await this.dependencies.discardRefreshDevice([...new Set([original.cookie, options.cookie!, cookie])], options); check();
        }
        const verified = await this.verified(cookie, { ...options, cookie }); check();
        const updated: AccountState = { ...verified, revision: original.revision, refreshToken: token, refreshState: 'confirming' };
        await this.saveRefresh(updated, generation, options.signal!); check();
        await this.client.confirmRefresh(original.refreshToken!, { ...options, cookie }); check();
        const { refreshState: _state, ...complete } = updated;
        await this.saveRefresh(complete, generation, options.signal!); check();
        this.refreshStatus = 'refreshed'; this.nextRefreshCheck = this.now() + 86400000;
      } catch {
        // A pending/confirming marker stays durable after any uncertain write, stop or failed save.
        // Only a verified confirming snapshot remains usable. An unverified pending candidate requires a fresh login.
        if (generation === this.generation) this.refreshStatus = this.current?.refreshState ? 'uncertain' : 'failed';
      }
    })();
    this.refreshFlight = task;
    try { await task; this.check(undefined, signal); if (this.unverifiedRefresh) throw new BiliError('login_required'); }
    finally { if (this.refreshFlight === task) this.refreshFlight = undefined; if (this.refreshController === controller) this.refreshController = undefined; }
  }
  async dispose() { this.stop(); this.signal.removeEventListener('abort', this.stop); await this.saving; }
}
