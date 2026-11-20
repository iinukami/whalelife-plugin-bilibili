/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthManager } from '../src/auth.ts';
import type { AuthDependencies } from '../src/auth.ts';
import { BiliClient } from '../src/client.ts';
import { BiliError } from '../src/errors.ts';
import { renewCookies } from '../src/refresh-client.ts';
import { assertBeforeDispatch } from '../src/transport.ts';
import type { BiliClientContract, CallOptions } from '../src/types.ts';
import type { Transport } from '../src/transport.ts';

const OLD = 'SESSDATA=SYNTHETIC_OLD; bili_jct=11111111111111111111111111111111; DedeUserID=17';
const NEW = 'SESSDATA=SYNTHETIC_NEW; bili_jct=22222222222222222222222222222222; DedeUserID=17';
const TOKEN = 'SYNTHETIC_REFRESH_OLD', NEXT = 'SYNTHETIC_REFRESH_NEXT', REFRESH_CSRF = 'SYNTHETIC_REFRESH_CSRF';
const DEVICE = '; buvid3=SYNTHETIC_SAVED_DEVICE';
const code = (expected: string) => (error: unknown) => error instanceof BiliError && error.code === expected;

test('real QR client and manager retain server device cookies while replacing an existing account', async t => {
  const key = 'SYNTHETIC_QR_CONTEXT_KEY', next = NEW.replace('DedeUserID=17', 'DedeUserID=29') + '; buvid3=SYNTHETIC_QR_DEVICE; bili_ticket=SYNTHETIC_TICKET';
  let stored: any = { schema: 1, revision: 'synthetic-old', account: { cookie: OLD + DEVICE, mid: 17, name: 'Synthetic old' } };
  const client = new BiliClient({ transport: {
    async request(url, options) {
      const path = new URL(url).pathname; let data: unknown; const headers: Record<string, string | string[]> = {};
      if (path.endsWith('/generate')) data = { qrcode_key: key, url: 'https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=' + key };
      else if (path.endsWith('/poll')) { data = { code: 0 }; headers['set-cookie'] = [...next.split('; ').map(pair => pair + '; Path=/'), 'unneeded_tracking=discard']; }
      else { assert.equal(path, '/x/web-interface/nav'); assert.equal(options.headers?.Cookie, next); data = { isLogin: true, mid: 29, uname: 'Synthetic new' }; }
      return { url, status: 200, headers, body: Buffer.from(JSON.stringify({ code: 0, data })) };
    }, dispose() {},
  } });
  const auth = new AuthManager(client, { async read() { return structuredClone(stored); }, async save(value) { stored = structuredClone(value); } }, new AbortController().signal);
  t.after(async () => { await auth.dispose(); await client.dispose(); }); await auth.ready;
  const login = await auth.beginLogin(), result = await auth.pollLogin(login.id);
  assert.equal(result.state, 'confirmed'); assert.equal(auth.snapshot()?.cookie, next); assert.equal(stored.account.mid, 29);
  assert(!JSON.stringify(result).includes('SYNTHETIC_QR_DEVICE')); assert(!JSON.stringify(result).includes('SYNTHETIC_OLD'));
});

test('renewCookies merges the actual request cookie, honors deletion, and never falls back to old authentication', async () => {
  let posts = 0;
  const transport: Transport = { async request(url, options) {
    assertBeforeDispatch(options); posts++; assert.equal(options.headers?.Cookie, OLD + DEVICE + '; buvid4=SYNTHETIC_FOUR');
    return { url, status: 200, headers: { 'set-cookie': [...NEW.split('; ').map(pair => pair + '; Path=/'), 'buvid3=; Max-Age=0', 'buvid4=SYNTHETIC_SERVER_FOUR'] },
      body: Buffer.from(JSON.stringify({ code: 0, data: { refresh_token: NEXT } })) };
  }, dispose() {} };
  const result = await renewCookies(transport, TOKEN, REFRESH_CSRF, { cookie: OLD + DEVICE + '; buvid4=SYNTHETIC_FOUR' });
  assert.equal(result.cookie, NEW + '; buvid4=SYNTHETIC_SERVER_FOUR'); assert.deepEqual(result.removedCookieNames, ['buvid3']); assert.equal(posts, 1);
  const invalid: Transport = { async request(url) { return { url, status: 200, headers: { 'set-cookie': ['buvid3=SYNTHETIC_SERVER_ONLY'] }, body: Buffer.from(JSON.stringify({ code: 0, data: { refresh_token: NEXT } })) }; }, dispose() {} };
  await assert.rejects(renewCookies(invalid, TOKEN, REFRESH_CSRF, { cookie: OLD + DEVICE }), code('uncertain'));
});

test('refresh request carries the current-state guard through a deferred dispatch', async () => {
  let changed = false, dispatched = 0;
  const transport: Transport = { async request() { throw Error('unused'); }, dispose() {} };
  transport.request = async (_url, options) => { changed = true; assertBeforeDispatch(options); dispatched++; throw Error('must not dispatch'); };
  await assert.rejects(renewCookies(transport, TOKEN, REFRESH_CSRF, { cookie: OLD,
    assertCurrent: () => { if (changed) throw new BiliError('account_changed'); } }), code('account_changed'));
  assert.equal(dispatched, 0);
});

function authFixture(dependencies: AuthDependencies, deleting = false, failPending = false, failure?: 'verify' | 'candidate-save' | 'cancel-after-post') {
  let stored: any = { schema: 1, revision: 'synthetic-cookie-session', account: { cookie: OLD, mid: 17, name: 'Synthetic', refreshToken: TOKEN } };
  const calls: string[] = [], writes: any[] = [], controller = new AbortController();
  const fresh = deleting ? NEW : NEW + DEVICE;
  const client = {
    async checkRefresh(options: CallOptions) { options.assertCurrent?.(); assert.equal(options.cookie, OLD + DEVICE); calls.push('check'); return { refresh: true, timestamp: 1234 }; },
    async refreshCsrf(options: unknown) { calls.push('csrf'); return REFRESH_CSRF; },
    async renewCookies(_token: string, _csrf: string, options: CallOptions) {
      options.assertCurrent?.(); calls.push('renew'); assert.equal(options.cookie, OLD + DEVICE); assert.equal(stored.account.cookie, OLD + DEVICE);
      if (failure === 'cancel-after-post') auth.configureRefresh(false);
      return { cookie: fresh, refreshToken: NEXT, ...(deleting ? { removedCookieNames: ['buvid3'] } : {}) };
    },
    async account(options: CallOptions) { calls.push('verify'); assert.equal(options.cookie, fresh); if (failure === 'verify') throw Error('synthetic verification failure'); return { mid: 17, name: 'Synthetic renewed' }; },
    async confirmRefresh(_token: string, options: CallOptions) { calls.push('confirm'); assert.equal(options.cookie, fresh); },
  };
  const auth = new AuthManager(client as unknown as BiliClientContract, { async read() { return stored; }, async save(value: any) {
    if (failPending && value.account?.refreshState === 'pending') throw Error('synthetic persistence failure');
    if (failure === 'candidate-save' && value.account?.cookie === fresh && value.account?.refreshState === 'pending') throw Error('synthetic candidate persistence failure');
    writes.push(structuredClone(value)); stored = structuredClone(value);
  } }, controller.signal, 1000, () => 10000, dependencies);
  return { auth, calls, writes, controller, get stored() { return stored; } };
}

test('renewal restores only the original scope before IO and saves that context with the pending marker', async t => {
  let prepared = 0;
  const f = authFixture({ async prepareRefreshCookie(cookie, options) { prepared++; assert.equal(cookie, OLD); assert.equal(options.cookie, OLD); options.assertCurrent?.(); return OLD + DEVICE; } });
  t.after(() => f.auth.dispose()); await f.auth.ready; f.auth.configureRefresh(true); await f.auth.ensureFresh();
  assert.equal(prepared, 1); assert.equal(f.auth.snapshot()?.cookie, NEW + DEVICE); assert.deepEqual(f.calls, ['check', 'csrf', 'renew', 'verify', 'confirm']);
  assert.equal(f.writes[0].account.refreshState, 'pending'); assert.equal(f.writes[0].account.cookie, OLD + DEVICE);
});

test('server removal discards original and renewed device scopes before verification and save', async t => {
  let discarded = false;
  const f = authFixture({ async prepareRefreshCookie() { return OLD + DEVICE; }, async discardRefreshDevice(cookies, options) {
    options.assertCurrent?.(); assert.deepEqual(cookies, [OLD, OLD + DEVICE, NEW]); assert.equal(options.cookie, OLD + DEVICE); assert(!f.calls.includes('verify')); discarded = true;
    assert.equal(f.stored.account.cookie, NEW); assert.equal(f.stored.account.refreshState, 'pending');
    assert.equal(f.auth.snapshot(), undefined); assert.equal(f.auth.state().loggedIn, false);
  } }, true);
  t.after(() => f.auth.dispose()); await f.auth.ready; f.auth.configureRefresh(true); await f.auth.ensureFresh();
  assert(discarded); assert.equal(f.auth.snapshot()?.cookie, NEW); assert.equal(f.auth.renewalState().status, 'refreshed');
});

test('restoration cannot replace credentials and cancellation or persistence failure prevents renewal POST', async t => {
  for (const mode of ['wrong-auth', 'cancelled', 'save-failed'] as const) {
    let f: ReturnType<typeof authFixture>;
    f = authFixture({ async prepareRefreshCookie() {
      if (mode === 'cancelled') f.auth.configureRefresh(false);
      return mode === 'wrong-auth' ? NEW + DEVICE : OLD + DEVICE;
    } }, false, mode === 'save-failed');
    t.after(() => f.auth.dispose()); await f.auth.ready; f.auth.configureRefresh(true); await f.auth.ensureFresh();
    assert(!f.calls.includes('renew')); assert.equal(f.auth.snapshot()?.cookie, OLD); assert.equal(f.writes.length, 0);
  }
});

test('failed device discard leaves renewal uncertain and cannot replay the write', async t => {
  const f = authFixture({ async prepareRefreshCookie() { return OLD + DEVICE; }, async discardRefreshDevice() { throw Error('synthetic device persistence failure'); } }, true);
  t.after(() => f.auth.dispose()); await f.auth.ready; f.auth.configureRefresh(true); await assert.rejects(f.auth.ensureFresh(), code('login_required'));
  assert.equal(f.auth.renewalState().status, 'uncertain'); assert(!f.calls.includes('verify')); assert(!f.calls.includes('confirm'));
  const count = f.calls.length; await assert.rejects(f.auth.ensureFresh(), code('login_required')); assert.equal(f.calls.length, count); assert.equal(f.calls.filter(call => call === 'renew').length, 1);
  assert.equal(f.auth.snapshot(), undefined); assert.equal(f.auth.state().loggedIn, false);
});

test('unverified refresh candidates never expose deleted devices after failure, cancellation or restart', async t => {
  for (const failure of ['verify', 'candidate-save', 'cancel-after-post'] as const) {
    const discarded: string[][] = [];
    const f = authFixture({ async prepareRefreshCookie() { return OLD + DEVICE; }, async discardRefreshDevice(cookies) { discarded.push([...cookies]); } }, true, false, failure);
    t.after(() => f.auth.dispose()); await f.auth.ready; f.auth.configureRefresh(true);
    await assert.rejects(f.auth.ensureFresh(), code('login_required'));
    assert.equal(f.auth.snapshot(), undefined); assert.equal(f.auth.state().loggedIn, false);
    assert.equal(f.stored.account.refreshState, 'pending');
    assert.equal(f.stored.account.cookie, failure === 'verify' ? NEW : OLD + DEVICE, 'preserve evidence without exposing an unverified credential');
    if (failure === 'verify') assert.deepEqual(discarded, [[OLD, OLD + DEVICE, NEW]]);
    let businessCalls = 0;
    const restart = new AuthManager({ async account() { businessCalls++; throw Error('must not use pending credential'); } } as unknown as BiliClientContract,
      { async read() { return structuredClone(f.stored); }, async save() { throw Error('must not replay'); } }, new AbortController().signal);
    t.after(() => restart.dispose()); await restart.ready;
    assert.equal(restart.snapshot(), undefined); assert.equal(restart.state().loggedIn, false);
    await assert.rejects(restart.ensureFresh(), code('login_required'));
    await assert.rejects(restart.folders(), code('login_required')); assert.equal(businessCalls, 0);
  }
});

test('restored pending and unknown uncertainty need verification, while verified confirming remains usable', async t => {
  for (const refreshState of ['pending', 'uncertain', 'confirming'] as const) {
    let calls = 0;
    const auth = new AuthManager({ async account() { calls++; return { mid: 17, name: 'Synthetic recovered' }; } } as unknown as BiliClientContract,
      { async read() { return { schema: 1, revision: 'synthetic-restart', account: { cookie: NEW, mid: 17, name: 'Synthetic', refreshToken: NEXT, refreshState } }; }, async save() {} }, new AbortController().signal);
    t.after(() => auth.dispose()); await auth.ready;
    if (refreshState === 'confirming') { await auth.ensureFresh(); assert.equal(auth.snapshot()?.cookie, NEW); assert.equal(auth.state().loggedIn, true); }
    else { await assert.rejects(auth.ensureFresh(), code('login_required')); assert.equal(auth.snapshot(), undefined); assert.equal(auth.state().loggedIn, false); }
    assert.equal(calls, 0);
    await auth.importCookie(NEW, auth.state().revision, undefined, NEXT);
    assert.equal(auth.snapshot()?.cookie, NEW); assert.equal(auth.state().loggedIn, true); assert.equal(calls, 1);
  }
});
