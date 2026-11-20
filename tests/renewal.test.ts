/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthManager } from '../src/auth.ts';
import { BiliError } from '../src/errors.ts';
import { checkRefresh, getRefreshCsrf, renewCookies, confirmRefresh } from '../src/refresh-client.ts';
import { TransportError } from '../src/transport.ts';
import type { Transport, TransportResponse, TransportOptions } from '../src/transport.ts';
import type { BiliClientContract, CallOptions } from '../src/types.ts';
// Entirely synthetic credentials, never accepted by a real service.
const OLD = 'SESSDATA=SYNTHETIC_OLD; bili_jct=11111111111111111111111111111111; DedeUserID=17';
const NEW = 'SESSDATA=SYNTHETIC_NEW; bili_jct=22222222222222222222222222222222; DedeUserID=17';
const TOKEN = 'SYNTHETIC_REFRESH_OLD', NEXT = 'SYNTHETIC_REFRESH_NEW', CSRF = 'SYNTHETIC_REFRESH_CSRF';
const storedAccount = () => ({ schema: 1, revision: 'synthetic-revision', account: { cookie: OLD, mid: 17, name: 'Synthetic', refreshToken: TOKEN } });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const code = (value: string) => (error: unknown) => error instanceof BiliError && error.code === value;
function fixture(stored: any = storedAccount()) {
  let now = 1000; const controller = new AbortController(), calls: string[] = [], writes: any[] = [];
  const client = {
    async checkRefresh(options: CallOptions) { assert.equal(options.cookie, OLD); calls.push('check'); return { refresh: true, timestamp: 1234 }; },
    async refreshCsrf() { calls.push('csrf'); return CSRF; },
    async renewCookies(token: string) { assert.equal(stored.account.refreshState, 'pending'); assert.equal(token, TOKEN); calls.push('renew'); return { cookie: NEW, refreshToken: NEXT }; },
    async account(options: CallOptions) { calls.push('account'); return { mid: 17, name: 'Synthetic verified' }; },
    async confirmRefresh(token: string, options: CallOptions) { assert.equal(stored.account.refreshState, 'confirming'); assert.equal(stored.account.cookie, NEW); assert.equal(stored.account.refreshToken, NEXT); assert.equal(token, TOKEN); assert.equal(options.cookie, NEW); calls.push('confirm'); },
    async folders(_mid: number, options: CallOptions) { assert.equal(options.cookie, NEW); return [{ id: '1', title: 'Synthetic' }]; },
  };
  const storage = { async read() { return stored; }, async save(value: any) { writes.push(structuredClone(value)); stored = structuredClone(value); } };
  const auth = new AuthManager(client as unknown as BiliClientContract, storage, controller.signal, 1000, () => now);
  return { auth, client, storage, controller, calls, writes, get stored() { return stored; }, advance(ms: number) { now += ms; } };
}

test('renewal is default off, accepts old account files, and missing tokens never cause IO', async t => {
  for (const stored of [storedAccount(), { ...storedAccount(), account: { ...storedAccount().account, refreshToken: undefined } }]) {
    const f = fixture(stored); t.after(() => f.auth.dispose()); await f.auth.ready;
    await f.auth.ensureFresh(); assert.deepEqual(f.calls, []); assert.equal(f.auth.renewalState().status, 'disabled');
    if (!stored.account.refreshToken) { f.auth.configureRefresh(true); await f.auth.ensureFresh(); assert.deepEqual(f.calls, []); assert.equal(f.auth.renewalState().status, 'needs_login'); }
  }
});

test('renewal saves pending, verifies and saves new credentials before confirming old token; identity stays stable', async t => {
  const f = fixture(); t.after(() => f.auth.dispose()); await f.auth.ready;
  const identity = f.auth.identity(), revision = f.auth.state().revision; f.auth.configureRefresh(true);
  await f.auth.ensureFresh(); assert.deepEqual(f.calls, ['check', 'csrf', 'renew', 'account', 'confirm']);
  assert.deepEqual(f.writes.map(w => w.account.refreshState), ['pending', 'pending', 'confirming', undefined]);
  assert.equal(f.auth.identity(), identity); assert.notEqual(f.auth.state().revision, revision); assert.equal(f.auth.snapshot()!.cookie, NEW);
  assert.equal(f.auth.renewalState().status, 'refreshed'); assert.equal((await f.auth.folders()).length, 1);
  assert.ok(!JSON.stringify({ account: f.auth.state(), renewal: f.auth.renewalState() }).includes('SYNTHETIC_'));
  await f.auth.ensureFresh(); assert.equal(f.calls.length, 5);
});

test('concurrent users wait for one renewal even after the pending marker; fresh checks have a daily cooldown', async t => {
  const f = fixture(); t.after(() => f.auth.dispose()); await f.auth.ready; f.auth.configureRefresh(true);
  const barrier = deferred(), original = f.client.renewCookies; f.client.renewCookies = async token => { await barrier.promise; return original(token); };
  const first = f.auth.ensureFresh(); await tick(); assert.equal(f.stored.account.refreshState, 'pending');
  let completed = false; const second = f.auth.ensureFresh().then(() => { completed = true; }); await tick(); assert.equal(completed, false);
  barrier.resolve(); await Promise.all([first, second]); assert.equal(f.calls.filter(x => x === 'renew').length, 1);
  const current = fixture(); t.after(() => current.auth.dispose()); await current.auth.ready; current.auth.configureRefresh(true);
  let checks = 0; current.client.checkRefresh = async () => { checks++; return { refresh: false, timestamp: 1234 }; };
  await current.auth.ensureFresh(); await current.auth.ensureFresh(); assert.equal(checks, 1); assert.equal(current.writes.length, 0);
  current.advance(86400001); await current.auth.ensureFresh(); assert.equal(checks, 2);
});

test('uncertain refresh or confirmation never replays, including after restart', async t => {
  for (const stage of ['renew', 'confirm', 'save-new'] as const) {
    const f = fixture(); t.after(() => f.auth.dispose()); await f.auth.ready; f.auth.configureRefresh(true);
    if (stage === 'renew') f.client.renewCookies = async () => { f.calls.push('renew'); throw new BiliError('uncertain'); };
    if (stage === 'confirm') f.client.confirmRefresh = async () => { f.calls.push('confirm'); throw new BiliError('uncertain'); };
    if (stage === 'save-new') { const save = f.storage.save; f.storage.save = async value => { if (value.account?.cookie === NEW) throw Error('synthetic disk failure'); await save(value); }; }
    if (stage === 'confirm') await f.auth.ensureFresh(); else await assert.rejects(f.auth.ensureFresh(), code('login_required'));
    assert.equal(f.auth.renewalState().status, 'uncertain'); const count = f.calls.length;
    f.advance(999999999);
    if (stage === 'confirm') await f.auth.ensureFresh(); else await assert.rejects(f.auth.ensureFresh(), code('login_required'));
    assert.equal(f.calls.length, count);
    const restart = fixture(f.stored); t.after(() => restart.auth.dispose()); await restart.auth.ready; restart.auth.configureRefresh(true);
    if (stage === 'confirm') await restart.auth.ensureFresh(); else await assert.rejects(restart.auth.ensureFresh(), code('login_required'));
    assert.equal(restart.calls.length, 0); assert.equal(restart.auth.renewalState().status, 'uncertain');
    if (stage === 'save-new') assert.equal(f.calls.includes('confirm'), false);
  }
});

test('failed persistence stops refresh before POST; read failures cool down and disabling cancels before mutation', async t => {
  const f = fixture(); t.after(() => f.auth.dispose()); await f.auth.ready; f.auth.configureRefresh(true);
  f.storage.save = async () => { throw Error('synthetic disk failure'); };
  await f.auth.ensureFresh(); assert.deepEqual(f.calls, ['check', 'csrf']); assert.equal(f.auth.renewalState().status, 'failed');
  await f.auth.ensureFresh(); assert.equal(f.calls.length, 2);
  const disabled = fixture(); t.after(() => disabled.auth.dispose()); await disabled.auth.ready; disabled.auth.configureRefresh(true);
  const wait = deferred(); disabled.client.refreshCsrf = async () => { await wait.promise; return CSRF; };
  const run = disabled.auth.ensureFresh(); await tick(); disabled.auth.configureRefresh(false); wait.resolve(); await run;
  assert.deepEqual(disabled.calls, ['check']); assert.equal(disabled.writes.length, 0);
});

test('logout supersedes a late renewal response and cannot restore the removed account', async t => {
  const f = fixture(); t.after(() => f.auth.dispose()); await f.auth.ready; f.auth.configureRefresh(true);
  const wait = deferred(); f.client.renewCookies = async () => { await wait.promise; return { cookie: NEW, refreshToken: NEXT }; };
  const run = f.auth.ensureFresh(); await tick();
  await f.auth.logout(f.auth.state().revision); wait.resolve(); await run;
  assert.equal(f.auth.state().loggedIn, false); assert.equal(f.stored.account, null); assert.equal(f.calls.includes('confirm'), false);
});

test('import retains an optional refresh token privately and changing login clears interrupted renewal', async t => {
  const stored = storedAccount() as any; stored.account.refreshState = 'pending';
  const f = fixture(stored); t.after(() => f.auth.dispose()); await f.auth.ready; f.auth.configureRefresh(true);
  assert.equal(f.auth.renewalState().status, 'uncertain'); const identity = f.auth.identity();
  const result = await f.auth.importCookie(NEW, f.auth.state().revision, undefined, NEXT);
  assert.equal(f.auth.snapshot()!.refreshToken, NEXT); assert.equal(f.auth.snapshot()!.refreshState, undefined);
  assert.notEqual(f.auth.identity(), identity); assert.equal(f.auth.renewalState().status, 'waiting'); assert.equal(JSON.stringify(result).includes(NEXT), false);
  await assert.rejects(f.auth.importCookie(NEW, f.auth.state().revision, undefined, 'bad'), code('invalid_input'));
  assert.equal(f.auth.snapshot()!.refreshToken, NEXT);
});

test('a cancelled renewal waiter returns immediately without cancelling the shared renewal', async t => {
  const f = fixture(), wait = deferred(); t.after(() => f.auth.dispose()); t.after(() => wait.resolve());
  await f.auth.ready; f.auth.configureRefresh(true);
  const original = f.client.renewCookies; f.client.renewCookies = async token => { await wait.promise; return original(token); };
  const first = f.auth.ensureFresh(); await tick();
  const controller = new AbortController(); let settled = false;
  const second = f.auth.ensureFresh(controller.signal).then(() => assert.fail('cancelled waiter succeeded'), error => { assert.equal(error.code, 'cancelled'); settled = true; });
  await tick(); controller.abort(); await tick(); assert.equal(settled, true); assert.equal(f.calls.includes('confirm'), false);
  wait.resolve(); await Promise.all([first, second]); assert.equal(f.auth.renewalState().status, 'refreshed');
});

test('manual account import takes priority over new renewal and releases its guard after completion', async t => {
  const f = fixture(), wait = deferred(); t.after(() => f.auth.dispose()); t.after(() => wait.resolve());
  await f.auth.ready; f.auth.configureRefresh(true); const original = f.client.account;
  f.client.account = async options => { await wait.promise; return original(options); };
  const imported = f.auth.importCookie(NEW, f.auth.state().revision, undefined, NEXT); await tick();
  await f.auth.ensureFresh(); assert.deepEqual(f.calls, []); assert.equal(f.writes.length, 0);
  wait.resolve(); await imported; assert.equal(f.auth.snapshot()!.cookie, NEW);
  let checked = false; f.client.checkRefresh = async options => { assert.equal(options.cookie, NEW); checked = true; return { refresh: false, timestamp: 1234 }; };
  await f.auth.ensureFresh(); assert.equal(checked, true); assert.equal(f.auth.renewalState().status, 'current');
});

function network(queue: (Partial<TransportResponse> | Error)[]) {
  const calls: { url: string; options: TransportOptions }[] = [];
  const transport: Transport = { async request(url, options) { calls.push({ url, options }); const next = queue.shift(); assert.ok(next); if (next instanceof Error) throw next; return { url, status: 200, headers: {}, body: Buffer.from('{"code":0}'), ...next }; }, dispose() {} };
  return { transport, calls };
}
test('renewal protocol uses fixed endpoints, old and new CSRF correctly, and retains only required cookies', async () => {
  const f = network([{ body: Buffer.from('{"code":0,"data":{"refresh":true,"timestamp":1234}}') },
    { body: Buffer.from('<html><div id="1-name">' + CSRF + '</div></html>') },
    { body: Buffer.from(JSON.stringify({ code: 0, data: { refresh_token: NEXT } })), headers: { 'set-cookie': [...NEW.split('; ').map(s => s + '; Path=/; HttpOnly'), 'unneeded=tracking; Path=/'] } }, {}]);
  assert.deepEqual(await checkRefresh(f.transport, { cookie: OLD }), { refresh: true, timestamp: 1234 });
  assert.equal(await getRefreshCsrf(f.transport, 1234, { cookie: OLD }), CSRF);
  assert.deepEqual(await renewCookies(f.transport, TOKEN, CSRF, { cookie: OLD }), { cookie: NEW, refreshToken: NEXT });
  await confirmRefresh(f.transport, TOKEN, { cookie: NEW });
  assert.match(f.calls[1].url, /^https:\/\/www\.bilibili\.com\/correspond\/1\/[a-f0-9]{256}$/);
  for (const [index, csrf] of [[2, '1'.repeat(32)], [3, '2'.repeat(32)]] as const) {
    const call = f.calls[index], url = new URL(call.url), form = new URLSearchParams(call.options.body);
    assert.equal(url.origin, 'https://passport.bilibili.com'); assert.equal(call.options.method, 'POST');
    assert.equal(form.get('csrf'), csrf); assert.equal(form.get('refresh_token'), TOKEN);
  }
  assert.equal(new URLSearchParams(f.calls[2].options.body).get('source'), 'main_web');
});

test('refresh writes classify unknown outcomes without retry and reject malformed credentials before IO', async () => {
  for (const response of [new TransportError('timeout', true), { status: 302 }, { body: Buffer.from('bad') }, { body: Buffer.from('{"code":0,"data":{}}') }]) {
    const f = network([response]); await assert.rejects(renewCookies(f.transport, TOKEN, CSRF, { cookie: OLD }), code('uncertain')); assert.equal(f.calls.length, 1);
  }
  const f = network([{ body: Buffer.from('{"code":-101}') }]);
  await assert.rejects(confirmRefresh(f.transport, TOKEN, { cookie: NEW }), code('login_required'));
  await assert.rejects(renewCookies(f.transport, 'invalid', CSRF, { cookie: OLD }), code('invalid_input'));
  await assert.rejects(checkRefresh(f.transport, { cookie: OLD, signal: AbortSignal.abort() }), code('cancelled')); assert.equal(f.calls.length, 1);
});
