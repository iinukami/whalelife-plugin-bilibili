/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProtectedTransport, TRAFFIC_LIMITS } from '../src/traffic.ts';
import { TransportError } from '../src/transport.ts';
import { BiliError } from '../src/errors.ts';
import type { TransportOptions, TransportResponse } from '../src/transport.ts';

const API = 'https://api.bilibili.com';
const GET = { timeoutMs: 20000, maxBytes: 2048, headers: { Cookie: 'SESSDATA=synthetic-session; buvid3=synthetic-device' } };
const POST = { ...GET, method: 'POST' as const, body: 'message=SYNTHETIC_PRIVATE_BODY&csrf=synthetic' };
const response = (url: string, code = 0, status = 200, headers: Record<string, string> = {}): TransportResponse =>
  ({ status, headers, body: Buffer.from(JSON.stringify({ code, data: {} })), url });
const rejects = (code: string, submitted = false) => (cause: unknown) => cause instanceof TransportError && cause.code === code && cause.submitted === submitted;
function fixture(t: { after: (fn: () => unknown) => void }, settings: {
  state?: unknown;
  handle?: (url: string, options: TransportOptions) => Promise<TransportResponse>;
  save?: (state: unknown, count: number) => Promise<void>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
} = {}) {
  let stamp = 100000, stored = structuredClone(settings.state), saves = 0, disposed = 0;
  const calls: { url: string; options: TransportOptions; at: number }[] = [], sleeps: number[] = [];
  const transport = createProtectedTransport({
    async request(url, options) { calls.push({ url, options, at: stamp }); return settings.handle ? settings.handle(url, options) : response(url); },
    dispose() { disposed++; },
  }, { read: () => stored, save: async value => { saves++; await settings.save?.(value, saves); stored = structuredClone(value); },
    now: () => stamp, sleep: settings.sleep ?? (async (ms, signal) => { signal.throwIfAborted(); sleeps.push(ms); stamp += ms; }) });
  t.after(() => transport.dispose());
  return { transport, calls, sleeps, state: () => structuredClone(stored), advance: (ms: number) => { stamp += ms; }, disposed: () => disposed };
}

test('API traffic is serial and spaced across concurrent callers, with stable cookie identity and bounded state', async t => {
  let active = 0, maximum = 0;
  const f = fixture(t, { handle: async url => { active++; maximum = Math.max(active, maximum); await new Promise(resolve => setImmediate(resolve)); active--; return response(url); } });
  await Promise.all([f.transport.request(API + '/x/test?a=secret', GET), f.transport.request(API + '/x/other', { ...GET, headers: { Cookie: 'buvid3=different; SESSDATA=synthetic-session' } })]);
  assert.equal(maximum, 1); assert.equal(f.calls[1].at - f.calls[0].at, 1500); assert.deepEqual(f.sleeps, [1500]);
  const state: any = f.state(); assert.equal(Object.keys(state.accounts).length, 1);
  assert.equal(Object.values<any>(state.accounts)[0].readsHour, 2);
  assert.equal(/synthetic|cookie|secret|\/x\//i.test(JSON.stringify(state)), false);
  assert.ok(f.calls[1].options.timeoutMs <= GET.timeoutMs - 1500);
});

test('media CDN bypasses a busy API queue without losing stop cancellation', async t => {
  let release!: () => void;
  const f = fixture(t, { handle: async url => { if (url.startsWith(API)) await new Promise<void>(resolve => { release = resolve; }); return response(url); } });
  const api = f.transport.request(API + '/x/test', GET); await new Promise(resolve => setImmediate(resolve));
  const cdn = await f.transport.request('https://cdn.example/media', { ...GET, headers: {} });
  assert.equal(cdn.status, 200); assert.equal(f.calls.length, 2);
  release(); await api;
});

test('interactive write cooldown persists across reload while history and renewal remain usable', async t => {
  const f = fixture(t); await f.transport.request(API + '/x/v2/reply/add', POST);
  await assert.rejects(f.transport.request(API + '/x/relation/modify', POST), rejects('traffic_cooldown'));
  await f.transport.request(API + '/x/v2/history/report', POST);
  await f.transport.request('https://passport.bilibili.com/x/passport-login/web/cookie/refresh', POST);
  assert.equal(f.calls.length, 3); const saved: any = f.state();
  assert.equal(Object.values<any>(saved.accounts)[0].writesHour, 1); assert.equal(Object.values<any>(saved.accounts)[0].readsHour, 2);
  const reload = fixture(t, { state: saved });
  await assert.rejects(reload.transport.request(API + '/x/v3/fav/resource/deal', POST), rejects('traffic_cooldown'));
  reload.advance(TRAFFIC_LIMITS.writeGapMs);
  await reload.transport.request(API + '/x/web-interface/archive/like', POST); assert.equal(reload.calls.length, 1);
});

test('write hourly budget is enforced and rejected writes never dispatch or consume another reservation', async t => {
  const f = fixture(t);
  for (let i = 0; i < 12; i++) { f.advance(120000); await f.transport.request(API + '/x/v2/reply/add', { ...POST, body: 'synthetic=' + i }); }
  f.advance(120000); await assert.rejects(f.transport.request(API + '/x/v2/reply/add', POST), rejects('traffic_budget'));
  assert.equal(f.calls.length, 12);
  f.advance(3600000); await f.transport.request(API + '/x/v2/reply/add', POST); assert.equal(f.calls.length, 13);
});

test('daily write and read budgets persist without resetting on reload or cookie device changes', async t => {
  const f = fixture(t); await f.transport.request(API + '/x/test', GET);
  const stored: any = f.state(), bucket = Object.values<any>(stored.accounts)[0];
  bucket.writesDay = 30; bucket.readsDay = 3000;
  const next = fixture(t, { state: stored });
  await assert.rejects(next.transport.request(API + '/x/v2/reply/add', POST), rejects('traffic_budget'));
  await assert.rejects(next.transport.request(API + '/x/test', GET), rejects('traffic_budget')); assert.equal(next.calls.length, 0);
  next.advance(86400000); await next.transport.request(API + '/x/test', GET); assert.equal(next.calls.length, 1);
});

test('platform risk pauses all ordinary API activity, persists, and honors longer Retry-After', async t => {
  const f = fixture(t, { handle: async url => response(url, 0, 429, { 'retry-after': '1200' }) });
  assert.equal((await f.transport.request(API + '/x/test', GET)).status, 429);
  const state: any = f.state(); assert.equal(state.pausedUntil, 1300000); assert.equal(state.strikes, 1);
  await assert.rejects(f.transport.request(API + '/x/test', { ...GET, headers: { Cookie: 'SESSDATA=second-account' } }), rejects('traffic_paused'));
  const reload = fixture(t, { state }); await assert.rejects(reload.transport.request(API + '/x/test', GET), rejects('traffic_paused'));
  await reload.transport.request(API + '/x/web-interface/nav', GET);
  await reload.transport.request('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', GET);
  assert.equal(reload.calls.length, 2);
  await assert.rejects(reload.transport.request(API + '/x/test', GET), rejects('traffic_paused'));
  reload.advance(1200000); await reload.transport.request(API + '/x/test', GET);
});

test('API risk codes increase bounded exponential pauses including duplicate-comment throttling', async t => {
  for (const code of [-412, -352, -799, -509, -10403, 10031, 12051]) {
    const f = fixture(t, { handle: async url => response(url, code) });
    await f.transport.request(API + '/x/test', GET);
    assert.equal((f.state() as any).pausedUntil, 400000);
    f.advance(300000); await f.transport.request(API + '/x/test', GET);
    assert.equal((f.state() as any).pausedUntil, 1000000);
    await assert.rejects(f.transport.request(API + '/x/test', GET), rejects('traffic_paused'));
  }
});

test('date Retry-After is respected and malformed values never create an infinite pause', async t => {
  const f = fixture(t, { handle: async url => response(url, -412, 200, { 'retry-after': new Date(3700000).toUTCString() }) });
  await f.transport.request(API + '/x/test', GET); assert.equal((f.state() as any).pausedUntil, 3700000);
  const bad = fixture(t, { handle: async url => response(url, -412, 200, { 'retry-after': '1'.repeat(500) }) });
  await bad.transport.request(API + '/x/test', GET); assert.equal((bad.state() as any).pausedUntil, 400000);
});

test('captcha protection is session scoped and does not permanently lock a newly scanned account', async t => {
  let first = true;
  const f = fixture(t, { handle: async url => { const out = response(url, first ? 12015 : 0); first = false; return out; } });
  await f.transport.request(API + '/x/test', GET);
  await assert.rejects(f.transport.request(API + '/x/test', GET), rejects('traffic_verification'));
  await f.transport.request(API + '/x/web-interface/nav', GET);
  await assert.rejects(f.transport.request(API + '/x/test', GET), rejects('traffic_verification'));
  await f.transport.request(API + '/x/test', { ...GET, headers: { Cookie: 'SESSDATA=synthetic-new-login' } });
  f.advance(1800000); await f.transport.request(API + '/x/test', GET);
});

test('login failure allows nav validation to recover the same session and does not poison anonymous browsing', async t => {
  let first = true;
  const f = fixture(t, { handle: async url => { const out = response(url, first ? -101 : 0); first = false; return out; } });
  await f.transport.request(API + '/x/test', GET);
  await assert.rejects(f.transport.request(API + '/x/test', GET), rejects('login_required'));
  await f.transport.request(API + '/x/test', { ...GET, headers: {} });
  await f.transport.request(API + '/x/web-interface/nav', GET);
  await f.transport.request(API + '/x/test', GET);
});

test('corrupt protection state and failed pre-dispatch persistence fail closed without writes', async t => {
  for (const state of [{ version: 2 }, { version: 1, lastDispatchAt: -1, pausedUntil: 0, strikes: 0, accounts: {} }]) {
    const f = fixture(t, { state }); await assert.rejects(f.transport.request(API + '/x/v2/reply/add', POST), rejects('config_invalid'));
    assert.equal(f.calls.length, 0); assert.deepEqual(f.state(), state);
  }
  const bad = fixture(t, { save: async () => { throw Error('PRIVATE_STORAGE_MESSAGE'); } });
  await assert.rejects(bad.transport.request(API + '/x/v2/reply/add', POST), rejects('persistence_error'));
  assert.equal(bad.calls.length, 0);
  await assert.rejects(bad.transport.request(API + '/x/test', GET), rejects('persistence_error'));
});

test('post-response persistence failure preserves submitted uncertainty and cannot trigger retransmission', async t => {
  const f = fixture(t, { save: async (_state, count) => { if (count === 2) throw Error('PRIVATE_STORAGE_MESSAGE'); } });
  await assert.rejects(f.transport.request(API + '/x/v2/reply/add', POST), rejects('persistence_error', true));
  await assert.rejects(f.transport.request(API + '/x/v2/reply/add', POST), rejects('persistence_error'));
  assert.equal(f.calls.length, 1);
});

test('known local transport rejection remains not-submitted and network failures are never retried', async t => {
  const rejected = fixture(t, { handle: async () => { throw new TransportError('unsafe_url', false); } });
  await assert.rejects(rejected.transport.request(API + '/x/v2/reply/add', POST), rejects('unsafe_url'));
  assert.equal(rejected.calls.length, 1);
  const network = fixture(t, { handle: async () => { throw new TransportError('network_error', true); } });
  await assert.rejects(network.transport.request(API + '/x/v2/reply/add', POST), rejects('network_error', true));
  assert.equal(network.calls.length, 1);
});

test('queue cancellation and total deadline prevent dispatch after an earlier call finishes', async t => {
  let release!: () => void;
  const f = fixture(t, { handle: async url => { if (url.endsWith('/held')) await new Promise<void>(resolve => { release = resolve; }); return response(url); } });
  const held = f.transport.request(API + '/held', GET); await new Promise(resolve => setImmediate(resolve));
  const controller = new AbortController();
  const queued = f.transport.request(API + '/cancelled', { ...GET, signal: controller.signal }); controller.abort('PRIVATE_REASON');
  await assert.rejects(queued, rejects('cancelled'));
  const keepAlive = setTimeout(() => {}, 500);
  try { await assert.rejects(f.transport.request(API + '/timeout', { ...GET, timeoutMs: 20 }), rejects('timeout')); }
  finally { clearTimeout(keepAlive); }
  release(); await held; await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, 1);
  await f.transport.request(API + '/later', GET); assert.equal(f.calls.length, 2);
});

test('spacing consumes total deadline and cancellation during the wait never dispatches', async t => {
  const f = fixture(t); await f.transport.request(API + '/x/test', GET);
  await assert.rejects(f.transport.request(API + '/x/test', { ...GET, timeoutMs: 1000 }), rejects('timeout')); assert.equal(f.calls.length, 1);
  let sleeping!: () => void;
  const wait = fixture(t, { sleep: async (_ms, signal) => { sleeping(); await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('aborted')), { once: true })); } });
  await wait.transport.request(API + '/x/test', GET);
  const began = new Promise<void>(resolve => { sleeping = resolve; }); const controller = new AbortController();
  const pending = wait.transport.request(API + '/x/next', { ...GET, signal: controller.signal }); await began; controller.abort();
  await assert.rejects(pending, rejects('cancelled')); assert.equal(wait.calls.length, 1);
});

test('dispose cancels queued and active requests and only disposes the underlying transport once', async t => {
  const f = fixture(t, { handle: async (url, options) => { await new Promise<void>((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new TransportError('stopped', false)), { once: true })); return response(url); } });
  const current = f.transport.request(API + '/x/current', GET), queued = f.transport.request(API + '/x/queued', GET);
  const results = Promise.all([assert.rejects(current, rejects('stopped')), assert.rejects(queued, rejects('stopped'))]);
  await new Promise(resolve => setImmediate(resolve)); await f.transport.dispose(); await results;
  await f.transport.dispose(); assert.equal(f.disposed(), 1); assert.equal(f.calls.length, 1);
  await assert.rejects(f.transport.request('https://cdn.example/media', GET), rejects('stopped'));
});


test('cancellation during persistence cannot dispatch late or overwrite a later reservation', async t => {
  let release!: () => void;
  const f = fixture(t, { save: async (_state, count) => { if (count === 1) await new Promise<void>(resolve => { release = resolve; }); } });
  const controller = new AbortController();
  const pending = f.transport.request(API + '/x/v2/reply/add', { ...POST, signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(pending, rejects('cancelled')); assert.equal(f.calls.length, 0);
  const next = f.transport.request(API + '/x/read', GET); release(); await next;
  assert.equal(f.calls.length, 1); assert.ok(f.calls[0].url.endsWith('/x/read'));
  const bucket = Object.values<any>((f.state() as any).accounts)[0];
  assert.equal(bucket.writesHour, 1); assert.equal(bucket.readsHour, 1);
});


test('account and permission revalidation after API queueing prevents stale POST dispatch', async t => {
  for (const code of ['account_changed', 'interaction_disabled']) {
    let release!: () => void, changed = false;
    const f = fixture(t, { handle: async url => { if (url.endsWith('/held')) await new Promise<void>(resolve => { release = resolve; }); return response(url); } });
    const held = f.transport.request(API + '/held', GET); await new Promise(resolve => setImmediate(resolve));
    const post = f.transport.request(API + '/x/v2/reply/add', { ...POST, beforeDispatch() { if (changed) throw new BiliError(code); } });
    const result = assert.rejects(post, rejects(code)); changed = true; release(); await held; await result;
    assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 0);
  }
});

test('account and permission changes during reservation persistence prevent stale POST dispatch', async t => {
  for (const code of ['account_changed', 'interaction_disabled']) {
    let release!: () => void, changed = false;
    const f = fixture(t, { save: async (_state, count) => { if (count === 1) await new Promise<void>(resolve => { release = resolve; }); } });
    const post = f.transport.request(API + '/x/v2/reply/add', { ...POST, beforeDispatch() { if (changed) throw new BiliError(code); } });
    const result = assert.rejects(post, rejects(code)); await new Promise(resolve => setImmediate(resolve)); changed = true; release(); await result;
    assert.equal(f.calls.length, 0); assert.equal(JSON.stringify(f.state()).includes('beforeDispatch'), false);
  }
});

test('account revalidation after minimum-gap sleep blocks dispatch and callback errors never leak text', async t => {
  let changed = false;
  const f = fixture(t, { sleep: async () => { changed = true; } });
  await f.transport.request(API + '/x/read', GET);
  await assert.rejects(f.transport.request(API + '/x/v2/reply/add', { ...POST, beforeDispatch() { if (changed) throw Error('PRIVATE_ACCOUNT_DETAILS'); } }),
    cause => cause instanceof TransportError && cause.code === 'config_conflict' && !cause.submitted && !cause.message.includes('PRIVATE'));
  assert.equal(f.calls.length, 1);
});
