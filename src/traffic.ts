/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { safeUrl, TransportError, assertBeforeDispatch } from './transport.ts';
import type { Transport, TransportOptions, TransportResponse } from './transport.ts';

// These are local conservative budgets, not platform-published safe thresholds.
export const TRAFFIC_LIMITS = Object.freeze({ gapMs: 1500, writeGapMs: 120000, readsHour: 600, readsDay: 3000, writesHour: 12, writesDay: 30 });
export interface TrafficDependencies {
  read(): unknown | Promise<unknown>;
  save(state: unknown): void | Promise<void>;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}
interface AccountBudget {
  hourAt: number; day: number; readsHour: number; readsDay: number; writesHour: number; writesDay: number;
  lastWriteAt: number; verificationUntil: number; loginRequired: boolean; seenAt: number;
}
interface TrafficState {
  version: 1; lastDispatchAt: number; pausedUntil: number; strikes: number; accounts: Record<string, AccountBudget>;
}
const HASH = /^[a-f0-9]{64}$/;
const DAY = 86400000;
const INTERACTIONS = new Set(['/x/v2/reply/add', '/x/web-interface/archive/like', '/x/v3/fav/resource/deal', '/x/relation/modify']);
const RISK_CODES = new Set([-412, -352, -799, -509, -10403, 10031, 12051]);
const VERIFICATION_CODES = new Set([12015, -105]);
const NUMBERS = ['hourAt', 'day', 'readsHour', 'readsDay', 'writesHour', 'writesDay', 'lastWriteAt', 'verificationUntil', 'seenAt'] as const;
const nonnegative = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function parseState(value: unknown): TrafficState {
  if (value === undefined || value === null || plain(value) && !Object.keys(value).length)
    return { version: 1, lastDispatchAt: 0, pausedUntil: 0, strikes: 0, accounts: {} };
  if (!plain(value) || value.version !== 1 || !nonnegative(value.lastDispatchAt) || !nonnegative(value.pausedUntil)
    || !nonnegative(value.strikes) || value.strikes > 8 || !plain(value.accounts) || Object.keys(value.accounts).length > 32)
    throw new TransportError('config_invalid', false);
  const accounts: Record<string, AccountBudget> = {};
  for (const [key, entry] of Object.entries(value.accounts)) {
    if (!HASH.test(key) || !plain(entry) || NUMBERS.some(field => !nonnegative(entry[field])) || typeof entry.loginRequired !== 'boolean')
      throw new TransportError('config_invalid', false);
    accounts[key] = Object.fromEntries([...NUMBERS.map(field => [field, entry[field]]), ['loginRequired', entry.loginRequired]]) as unknown as AccountBudget;
  }
  return { version: 1, lastDispatchAt: value.lastDispatchAt, pausedUntil: value.pausedUntil, strikes: value.strikes, accounts };
}
function identity(options: TransportOptions) {
  let cookie = '';
  for (const [key, value] of Object.entries(options.headers ?? {})) if (key.toLowerCase() === 'cookie') cookie = value;
  const session = /(?:^|;)\s*SESSDATA=([^;\s]+)/.exec(cookie)?.[1];
  const authenticated = !!session && !['undefined', 'null'].includes(session);
  return { key: createHash('sha256').update(authenticated ? session : 'anonymous').digest('hex'), authenticated };
}
function recovery(url: URL, method: string) {
  return method === 'GET' && (url.hostname === 'api.bilibili.com' && url.pathname === '/x/web-interface/nav'
    || url.hostname === 'passport.bilibili.com' && ['/x/passport-login/web/qrcode/generate', '/x/passport-login/web/qrcode/poll'].includes(url.pathname));
}
function retryAfter(response: TransportResponse, now: number) {
  const value = response.headers['retry-after'];
  if (typeof value !== 'string' || value.length > 128) return 0;
  const ms = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  // Reject overflow without shortening any finite, representable platform deadline.
  return Number.isFinite(ms) && ms > 0 && Number.isSafeInteger(Math.ceil(now + ms)) ? Math.ceil(ms) : 0;
}
function codeOf(response: TransportResponse): number | undefined {
  if (response.body.length > 2 * 1024 * 1024) return;
  try { const code = JSON.parse(response.body.toString('utf8'))?.code; return Number.isSafeInteger(code) ? code : undefined; } catch { return; }
}
function abortable<T>(pending: Promise<T>, signal: AbortSignal, error: () => TransportError): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => { cleanup(); reject(error()); };
    const cleanup = () => signal.removeEventListener('abort', cancel);
    signal.addEventListener('abort', cancel, { once: true });
    pending.then(value => { cleanup(); resolve(value); }, cause => { cleanup(); reject(cause); });
    if (signal.aborted) cancel();
  });
}

/** One wrapper belongs to one plugin instance; persisted state survives plugin reloads. */
export function createProtectedTransport(transport: Transport, dependencies: TrafficDependencies): Transport {
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
  const lifetime = new AbortController();
  let state: TrafficState | undefined, persistenceFailed = false;
  let tail: Promise<void> = Promise.resolve();
  let disposal: Promise<void> | undefined;
  return {
    async request(input, options) {
      if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 240000)
        throw new TransportError('invalid_input', false);
      const url = safeUrl(input), method = options.method ?? 'GET';
      const protectedHost = ['api.bilibili.com', 'passport.bilibili.com', 'www.bilibili.com'].includes(url.hostname);
      const deadline = now() + options.timeoutMs, timeout = new AbortController();
      const signal = AbortSignal.any([lifetime.signal, timeout.signal, ...(options.signal ? [options.signal] : [])]);
      let dispatched = false;
      const error = () => new TransportError(lifetime.signal.aborted ? 'stopped' : options.signal?.aborted ? 'cancelled' : 'timeout', dispatched && method === 'POST');
      const check = () => { if (signal.aborted || now() >= deadline) throw error(); assertBeforeDispatch(options); };
      const timer = setTimeout(() => timeout.abort(), options.timeoutMs); timer.unref();
      const run = async () => {
        check();
        if (!protectedHost) {
          dispatched = true;
          return transport.request(input, { ...options, signal, timeoutMs: Math.max(1, Math.floor(deadline - now())) });
        }
        if (persistenceFailed) throw new TransportError('persistence_error', false);
        if (!state) {
          try { state = parseState(await dependencies.read()); }
          catch (cause) { if (cause instanceof TransportError) throw cause; throw new TransportError('persistence_error', false); }
          check();
        }
        const { key, authenticated } = identity(options);
        const restoring = recovery(url, method), writing = method === 'POST' && url.hostname === 'api.bilibili.com' && INTERACTIONS.has(url.pathname);
        const stamp = now();
        // Retain protection for recently used sessions; expired old buckets are only housekeeping.
        for (const [id, entry] of Object.entries(state.accounts))
          if (stamp - entry.seenAt > DAY * 2 && entry.verificationUntil <= stamp) delete state.accounts[id];
        let account = state.accounts[key];
        if (!account) {
          if (Object.keys(state.accounts).length >= 32) throw new TransportError('traffic_budget', false);
          account = { hourAt: stamp, day: Math.floor(stamp / DAY), readsHour: 0, readsDay: 0, writesHour: 0, writesDay: 0,
            lastWriteAt: 0, verificationUntil: 0, loginRequired: false, seenAt: stamp };
          state.accounts[key] = account;
        }
        const gates = () => {
          check();
          const current = now();
          if (!restoring && state!.pausedUntil > current) throw new TransportError('traffic_paused', false);
          if (!restoring && account.loginRequired) throw new TransportError('login_required', false);
          if (!restoring && account.verificationUntil > current) throw new TransportError('traffic_verification', false);
          if (current - account.hourAt >= 3600000) { account.hourAt = current; account.readsHour = 0; account.writesHour = 0; }
          if (Math.floor(current / DAY) > account.day) { account.day = Math.floor(current / DAY); account.readsDay = 0; account.writesDay = 0; }
          if (writing) {
            if (account.lastWriteAt && current - account.lastWriteAt < TRAFFIC_LIMITS.writeGapMs) throw new TransportError('traffic_cooldown', false);
            if (account.writesHour >= TRAFFIC_LIMITS.writesHour || account.writesDay >= TRAFFIC_LIMITS.writesDay) throw new TransportError('traffic_budget', false);
          } else if (account.readsHour >= TRAFFIC_LIMITS.readsHour || account.readsDay >= TRAFFIC_LIMITS.readsDay) throw new TransportError('traffic_budget', false);
        };
        gates();
        const wait = state.lastDispatchAt ? Math.max(0, state.lastDispatchAt + TRAFFIC_LIMITS.gapMs - now()) : 0;
        if (wait >= deadline - now()) throw error();
        if (wait) { try { await sleep(wait, signal); } catch { check(); throw new TransportError('cancelled', false); } }
        gates();
        account.seenAt = now();
        if (writing) { account.writesHour++; account.writesDay++; account.lastWriteAt = now(); }
        else { account.readsHour++; account.readsDay++; }
        // Reserve and persist before any network dispatch. A failed/cancelled request keeps its budget.
        state.lastDispatchAt = now();
        const save = async (submitted: boolean) => {
          try { await dependencies.save(structuredClone(state)); }
          catch { persistenceFailed = true; throw new TransportError('persistence_error', submitted); }
        };
        await save(false);
        check();
        state.lastDispatchAt = now();
        if (writing) account.lastWriteAt = state.lastDispatchAt;
        dispatched = true;
        let response: TransportResponse;
        try { response = await transport.request(input, { ...options, signal, timeoutMs: Math.max(1, Math.floor(deadline - now())) }); }
        catch (cause) {
          // Do not reinterpret known pre-dispatch failures or retry any POST.
          if (cause instanceof TransportError) throw cause;
          throw new TransportError(signal.aborted ? error().code : 'network_error', method === 'POST');
        }
        const code = codeOf(response), current = now();
        if ([412, 429].includes(response.status) || code !== undefined && RISK_CODES.has(code)) {
          state.strikes = Math.min(8, state.strikes + 1);
          const pause = Math.max(Math.min(1800000, 300000 * 2 ** (state.strikes - 1)), retryAfter(response, current));
          state.pausedUntil = Math.max(state.pausedUntil, current + pause);
        }
        if (code !== undefined && VERIFICATION_CODES.has(code)) account.verificationUntil = Math.max(account.verificationUntil, current + 1800000);
        if (authenticated && (code === -101 || response.status === 401)) account.loginRequired = true;
        if (authenticated && url.hostname === 'api.bilibili.com' && url.pathname === '/x/web-interface/nav'
          && response.status >= 200 && response.status < 300 && code === 0) account.loginRequired = false;
        // An accepted POST must not be reported as locally rejected if saving its protection fails.
        await save(method === 'POST');
        return response;
      };
      const pending = protectedHost ? tail.then(run) : run();
      if (protectedHost) tail = pending.then(() => {}, () => {});
      try { return await abortable(pending, signal, error); }
      finally { clearTimeout(timer); }
    },
    dispose() {
      lifetime.abort();
      return disposal ??= Promise.resolve().then(() => transport.dispose());
    },
  };
}
