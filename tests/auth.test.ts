/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthManager, normalizeCookie } from '../src/auth.ts';
import { BiliClient } from '../src/client.ts';
import { defaults, parseConfig, updateConfig } from '../src/config.ts';
import { BiliError, safeError } from '../src/errors.ts';
import type { BiliClientContract, CallOptions, LoginPoll } from '../src/types.ts';

// All credentials and account values below are synthetic regression fixtures.
const COOKIE = 'SESSDATA=SYNTHETIC_SESSION_17; bili_jct=0123456789abcdef0123456789abcdef; DedeUserID=17';
const COOKIE2 = 'SESSDATA=SYNTHETIC_SESSION_29; bili_jct=fedcba9876543210fedcba9876543210; DedeUserID=29';
const QR_KEY = 'SYNTHETIC_QR_KEY_NOT_REAL';
const QR_URL = 'https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=' + QR_KEY;
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const errorCode = (code: string) => (error: unknown) => error instanceof BiliError && error.code === code;
function fixture(stored: unknown = {}) {
  const controller = new AbortController();
  let now = 10000, calls = 0, polls = 0;
  const writes: unknown[] = [];
  let nextPoll: LoginPoll = { state: 'waiting' };
  const client = {
    async account(options: CallOptions) { calls++; return { mid: options.cookie?.includes('DedeUserID=29') ? 29 : 17, name: 'Synthetic account' }; },
    async beginLogin() { return { key: QR_KEY, url: QR_URL }; },
    async pollLogin(key: string) { assert.equal(key, QR_KEY); polls++; return nextPoll; },
    async folders(mid: number, options: CallOptions) { assert.ok(options.cookie); return [{ id: '301', title: 'Synthetic folder ' + mid }]; },
  };
  const storage = { async read() { return stored; }, async save(value: unknown) { writes.push(structuredClone(value)); stored = structuredClone(value); } };
  const auth = new AuthManager(client as unknown as BiliClientContract, storage, controller.signal, 15000, () => now);
  return { auth, client, storage, controller, writes, setPoll: (value: LoginPoll) => { nextPoll = value; }, advance: (ms: number) => { now += ms; }, calls: () => calls, polls: () => polls };
}

for (const [hostname, path] of [
  ['account.bilibili.com', '/h5/account-h5/auth/scan-web'],
  ['passport.bilibili.com', '/h5-app/passport/login/scan'],
] as const) test(`official ${hostname} QR destination survives the real client and AuthManager confirmation flow`, async t => {
  const controller = new AbortController(); let now = 10000, polls = 0;
  const qrUrl = `https://${hostname}${path}?qrcode_key=${QR_KEY}`;
  const writes: unknown[] = [], paths: string[] = [];
  const client = new BiliClient({ signal: controller.signal, transport: {
    async request(value, options) {
      const url = new URL(value); paths.push(url.pathname);
      let data: unknown; const headers: Record<string, string | string[]> = {};
      if (url.pathname.endsWith('/generate')) {
        assert.equal(url.origin, 'https://passport.bilibili.com');
        assert.equal(options.headers?.Cookie, undefined);
        data = { qrcode_key: QR_KEY, url: qrUrl };
      } else if (url.pathname.endsWith('/poll')) {
        assert.equal(url.origin, 'https://passport.bilibili.com');
        assert.equal(options.headers?.Cookie, undefined);
        assert.equal(url.searchParams.get('qrcode_key'), QR_KEY);
        data = { code: polls++ === 0 ? 86101 : 0 };
        if (polls > 1) headers['set-cookie'] = COOKIE2.split('; ').map(cookie => cookie + '; Path=/; HttpOnly');
      } else {
        assert.equal(url.pathname, '/x/web-interface/nav');
        assert.equal(options.headers?.Cookie, COOKIE2);
        data = { isLogin: true, mid: 29, uname: 'Synthetic verified account' };
      }
      return { url: value, status: 200, headers, body: Buffer.from(JSON.stringify({ code: 0, data })) };
    }, dispose() {},
  } });
  const auth = new AuthManager(client, { async read() { return {}; }, async save(value) { writes.push(structuredClone(value)); } }, controller.signal, 15000, () => now);
  t.after(async () => { await auth.dispose(); await client.dispose(); });
  await auth.ready;
  const login = await auth.beginLogin();
  assert.equal(login.url, qrUrl); assert.equal(Object.hasOwn(login, 'key'), false);
  assert.equal(auth.state().loggedIn, false); assert.equal(writes.length, 0);
  assert.deepEqual(await auth.pollLogin(login.id), { state: 'waiting' });
  now += 2100;
  const result = await auth.pollLogin(login.id);
  assert.equal(result.state, 'confirmed'); assert.equal(result.account?.mid, 29);
  assert.equal(writes.length, 1); assert.equal(auth.snapshot()?.cookie, COOKIE2);
  assert.ok(!JSON.stringify(result).includes(QR_KEY));
  assert.ok(!JSON.stringify(result).includes('SYNTHETIC_SESSION'));
  assert.equal(paths.length, 4);
});

test('AuthManager rejects unapproved QR destinations even when a client adapter returns them', async t => {
  const f = fixture(); t.after(() => f.auth.dispose()); await f.auth.ready;
  for (const url of [
    'https://account.bilibili.com.evil.example/scan', 'https://passport.bilibili.tv/scan',
    'https://account.bilibili.com:444/scan', 'https://synthetic:secret@account.bilibili.com/scan',
    'http://account.bilibili.com/scan', 'https://account.bilibili.com/scan#fragment',
    'https://account.bilibili.com/scan?synthetic=' + 'x'.repeat(4096),
  ]) {
    f.client.beginLogin = async () => ({ key: QR_KEY, url });
    await assert.rejects(f.auth.beginLogin(), errorCode('malformed_response'));
  }
  assert.equal(f.auth.state().loggedIn, false); assert.equal(f.writes.length, 0);
});

test('configuration defaults keep audio and every interaction disabled; partial updates preserve independent settings', () => {
  const config = parseConfig({});
  assert.equal(config.audioEnabled, false);
  assert.ok(Object.values(config.interactions).every(value => value === false));
  const changed = updateConfig({ interactions: { comment: true }, favoriteFolderId: '301' }, config);
  assert.equal(changed.interactions.comment, true);
  assert.equal(changed.interactions.reply, false);
  assert.equal(config.interactions.comment, false);
  assert.equal(defaults.interactions.comment, false);
  assert.equal(changed.favoriteFolderId, '301');
  for (const input of [{ audioEnabled: 'false' }, { interactions: { coin: true } }, { interactions: { like: 1 } },
    { maxMediaBytes: 65 * 1048576 }, { referenceTtlSeconds: 0 }, { favoriteFolderId: '../data' }, { cookie: COOKIE }, [], null]) {
    assert.throws(() => parseConfig(input), errorCode('config_invalid'));
  }
});

test('manual Cookie input retains required authentication only and rejects malformed, duplicate or injected values', () => {
  assert.equal(normalizeCookie('Cookie: ' + COOKIE + '; browser_tracking=discard'), COOKIE);
  for (const value of [COOKIE + '\r\nHost: attacker.invalid', COOKIE.replace('DedeUserID=17', 'DedeUserID=0'),
    COOKIE.replace('bili_jct=0123456789abcdef0123456789abcdef', 'bili_jct=no'), COOKIE + '; SESSDATA=duplicate',
    COOKIE.replace('SYNTHETIC_SESSION_17', 'with space'), 'SESSDATA=only', 'x'.repeat(17000), null]) {
    assert.throws(() => normalizeCookie(value), errorCode('invalid_input'));
  }
});

test('import verifies identity before saving and returns no Cookie or QR credential', async t => {
  const f = fixture(); t.after(() => f.auth.dispose()); await f.auth.ready;
  const revision = f.auth.state().revision;
  const account = await f.auth.importCookie(COOKIE, revision);
  assert.equal(account.loggedIn, true); assert.equal(account.mid, 17); assert.notEqual(account.revision, revision);
  assert.equal(f.calls(), 1); assert.equal(f.writes.length, 1);
  assert.equal(f.auth.snapshot()?.cookie, COOKIE);
  assert.ok(!JSON.stringify(account).includes('SYNTHETIC_SESSION'));
  assert.ok(!JSON.stringify(f.auth.state()).includes(QR_KEY));
  assert.deepEqual(await f.auth.folders(), [{ id: '301', title: 'Synthetic folder 17' }]);
  await assert.rejects(f.auth.importCookie(COOKIE2, revision), errorCode('config_conflict'));
  assert.equal(f.calls(), 1, 'stale configuration cannot trigger validation for another identity');
});

test('account validation mismatch and persistence failure preserve the previous login', async t => {
  const f = fixture(); t.after(() => f.auth.dispose()); await f.auth.ready;
  await f.auth.importCookie(COOKIE, f.auth.state().revision);
  const previous = f.auth.state();
  f.client.account = async () => ({ mid: 17, name: 'Wrong synthetic account' });
  await assert.rejects(f.auth.importCookie(COOKIE2, previous.revision), errorCode('account_changed'));
  assert.deepEqual(f.auth.state(), previous);
  f.client.account = async () => ({ mid: 29, name: 'Second synthetic account' });
  f.storage.save = async () => { throw Error('SYNTHETIC_PRIVATE_STORAGE_ERROR'); };
  await assert.rejects(f.auth.importCookie(COOKIE2, previous.revision), errorCode('persistence_error'));
  assert.deepEqual(f.auth.state(), previous);
  assert.ok(!JSON.stringify(safeError(new Error(COOKIE))).includes('SYNTHETIC_SESSION'));
});

test('saved account loads without remote calls; corrupt data stays disabled until explicitly replaced', async t => {
  const f = fixture({ schema: 1, revision: 'stored-revision', account: { cookie: COOKIE, mid: 17, name: 'Synthetic saved account' } });
  const invalid = fixture({ schema: 1, revision: 'stored-revision', account: { cookie: COOKIE, mid: 29, name: 'Mismatched identity' } });
  t.after(() => f.auth.dispose()); t.after(() => invalid.auth.dispose());
  await Promise.all([f.auth.ready, invalid.auth.ready]);
  assert.equal(f.auth.state().loggedIn, true); assert.equal(f.calls(), 0);
  assert.equal(invalid.auth.state().loggedIn, false); assert.equal(invalid.auth.state().invalidStoredState, true);
  assert.equal(invalid.writes.length, 0, 'invalid private state must not be silently erased');
  await invalid.auth.logout(invalid.auth.state().revision);
  assert.equal(invalid.auth.state().invalidStoredState, undefined);
  assert.equal((invalid.writes[0] as { account: unknown }).account, null);
});

test('QR login keeps old account until verified confirmation, rate-limits polls, and never returns the key', async t => {
  const f = fixture(); t.after(() => f.auth.dispose()); await f.auth.ready;
  await f.auth.importCookie(COOKIE, f.auth.state().revision);
  const prior = f.auth.state();
  const login = await f.auth.beginLogin();
  assert.deepEqual(f.auth.state(), prior);
  assert.deepEqual(Object.keys(login).sort(), ['id', 'url']);
  assert.deepEqual(await f.auth.pollLogin(login.id), { state: 'waiting' });
  assert.deepEqual(await f.auth.pollLogin(login.id), { state: 'waiting' });
  assert.equal(f.polls(), 1);
  f.advance(2100); f.setPoll({ state: 'scanned' });
  assert.deepEqual(await f.auth.pollLogin(login.id), { state: 'scanned' });
  f.advance(2100); f.setPoll({ state: 'confirmed', cookie: COOKIE2 });
  const result = await f.auth.pollLogin(login.id);
  assert.equal(result.state, 'confirmed'); assert.equal(result.account?.mid, 29);
  assert.ok(!JSON.stringify(result).includes('SYNTHETIC_SESSION'));
  assert.ok(!JSON.stringify(result).includes(QR_KEY));
  await assert.rejects(f.auth.pollLogin(login.id), errorCode('reference_unavailable'));
});

test('expired and superseded QR references cannot poll or install an account', async t => {
  const f = fixture(); t.after(() => f.auth.dispose()); await f.auth.ready;
  const first = await f.auth.beginLogin(), second = await f.auth.beginLogin();
  await assert.rejects(f.auth.pollLogin(first.id), errorCode('reference_unavailable'));
  f.advance(180000);
  assert.deepEqual(await f.auth.pollLogin(second.id), { state: 'expired' });
  assert.equal(f.polls(), 0); assert.equal(f.writes.length, 0);
});

test('late import result cannot restore login after a newer logout', async t => {
  const f = fixture(); t.after(() => f.auth.dispose()); await f.auth.ready;
  await f.auth.importCookie(COOKIE, f.auth.state().revision);
  const revision = f.auth.state().revision, blocked = deferred<{ mid: number; name: string }>();
  f.client.account = () => blocked.promise;
  const pending = f.auth.importCookie(COOKIE2, revision);
  const rejected = assert.rejects(pending, errorCode('config_conflict'));
  await tick();
  await f.auth.logout(revision);
  blocked.resolve({ mid: 29, name: 'Late synthetic account' });
  await rejected;
  assert.equal(f.auth.state().loggedIn, false);
  assert.equal((f.writes.at(-1) as { account: unknown }).account, null);
});

test('late QR generation cannot replace a more recent imported identity', async t => {
  const f = fixture(); t.after(() => f.auth.dispose()); await f.auth.ready;
  const blocked = deferred<{ key: string; url: string }>(); f.client.beginLogin = () => blocked.promise;
  const pending = f.auth.beginLogin(); const rejected = assert.rejects(pending, errorCode('config_conflict'));
  await tick();
  await f.auth.importCookie(COOKIE2, f.auth.state().revision);
  blocked.resolve({ key: QR_KEY, url: QR_URL }); await rejected;
  assert.equal(f.auth.state().mid, 29); assert.equal(f.writes.length, 1);
});

test('cancellation prevents late validation from saving and disposal prevents further requests', async t => {
  const f = fixture(); t.after(() => f.auth.dispose()); await f.auth.ready;
  const blocked = deferred<{ mid: number; name: string }>(); f.client.account = () => blocked.promise;
  const request = new AbortController();
  const pending = f.auth.importCookie(COOKIE, f.auth.state().revision, request.signal);
  const rejected = assert.rejects(pending, errorCode('cancelled'));
  await tick(); request.abort(); blocked.resolve({ mid: 17, name: 'Cancelled synthetic account' }); await rejected;
  assert.equal(f.writes.length, 0);
  f.controller.abort();
  await assert.rejects(f.auth.beginLogin(), errorCode('stopped'));
  await assert.rejects(f.auth.folders(), errorCode('stopped'));
});

test('a completed storage commit stays consistent even if another operation supersedes it in flight', async t => {
  const f = fixture(); t.after(() => f.auth.dispose()); await f.auth.ready;
  const revision = f.auth.state().revision, saving = deferred<void>();
  const originalSave = f.storage.save;
  f.storage.save = async value => { await saving.promise; await originalSave(value); };
  const importing = f.auth.importCookie(COOKIE, revision);
  const importRejected = assert.rejects(importing, errorCode('config_conflict'));
  await tick();
  const logout = f.auth.logout(revision); const logoutRejected = assert.rejects(logout, errorCode('config_conflict'));
  saving.resolve(); await Promise.all([importRejected, logoutRejected]);
  const committed = f.writes[0] as { revision: string; account: { cookie: string } };
  assert.equal(f.auth.state().revision, committed.revision);
  assert.equal(f.auth.snapshot()?.cookie, committed.account.cookie);
  await f.auth.logout(f.auth.state().revision);
  assert.equal(f.auth.state().loggedIn, false);
});
