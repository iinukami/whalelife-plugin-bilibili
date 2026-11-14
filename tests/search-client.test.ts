/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BiliClient } from '../src/client.ts';
import { BiliRuntime } from '../src/runtime.ts';
import { defaults } from '../src/config.ts';
import { BiliError } from '../src/errors.ts';
import { readWbiKeys, signWbi } from '../src/wbi.ts';
import type { RequestDiagnostic } from '../src/diagnostics.ts';
import type { TransportOptions, TransportResponse } from '../src/transport.ts';

const cookie = 'SESSDATA=synthetic-session; bili_jct=synthetic-csrf; DedeUserID=123';
const device = 'SYNTHETIC_SERVER_ISSUED_DEVICE';
const getbuvid = '/x/web-frontend/getbuvid', nav = '/x/web-interface/nav', search = '/x/web-interface/wbi/search/type';
const images = { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
  sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' };
const keys = readWbiKeys(images);
const failed = (code: string) => (error: unknown) => error instanceof BiliError && error.code === code;
function response(url: string, data: unknown, code = 0, status = 200): TransportResponse {
  return { status, headers: {}, body: Buffer.from(JSON.stringify({ code, data })), url };
}
function normal(url: string): TransportResponse {
  const path = new URL(url).pathname;
  if (path === getbuvid) return response(url, { buvid: device });
  if (path === nav) return response(url, { wbi_img: images });
  assert.equal(path, search, 'only the supported preparation and search endpoints may be requested');
  return response(url, { result: [], numPages: 0 });
}
function fixture(handler: (url: string, options: TransportOptions) => TransportResponse | Promise<TransportResponse> = normal) {
  const calls: { url: URL; options: TransportOptions }[] = [], diagnostics: RequestDiagnostic[] = [];
  let disposals = 0;
  const client = new BiliClient({ onDiagnostic: value => { diagnostics.push(value); }, transport: {
    async request(url, options) { calls.push({ url: new URL(url), options }); return handler(url, options); },
    dispose() { disposals++; },
  } });
  return { client, calls, diagnostics, disposals: () => disposals, paths: () => calls.map(c => c.url.pathname) };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }
async function until(predicate: () => boolean) {
  for (let i = 0; i < 50 && !predicate(); i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(predicate(), 'expected synthetic request was not dispatched');
}

test('WBI matches a published protocol vector and signs exact UTF-8 percent encoding', () => {
  assert.equal(signWbi({ foo: '114', bar: '514', zab: '1919810' }, keys, 1702204169),
    'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4');
  const signed = signWbi({ keyword: "中文 空格 + / !'()*" }, keys, 1702204169);
  const unsigned = 'keyword=%E4%B8%AD%E6%96%87%20%E7%A9%BA%E6%A0%BC%20%2B%20%2F%20&wts=1702204169';
  const expected = createHash('md5').update(unsigned + 'ea1db124af3c7062474693fa704f4ff8').digest('hex');
  assert.equal(signed, unsigned + '&w_rid=' + expected);
  assert.throws(() => signWbi({ keyword: '\ud800' }, keys), failed('invalid_input'));
  for (const value of [null, {}, { ...images, img_url: 'https://private.example/key.png' }, { ...images, sub_url: images.sub_url + '?private=1' }])
    assert.throws(() => readWbiKeys(value), failed('malformed_response'));
});

test('search uses server-issued cookie and signed endpoint while preserving caller login and caching preparation', async t => {
  const f = fixture(); t.after(() => f.client.dispose());
  const options = { cookie, timeoutMs: 1234 };
  await f.client.search('中文 空格 +', 2, options);
  await f.client.search('next', 3, options);
  assert.deepEqual(f.paths(), [getbuvid, nav, search, search]);
  assert.equal(options.cookie, cookie);
  assert.equal(f.calls[0].options.headers?.Cookie, cookie);
  for (const call of f.calls.slice(1)) {
    assert.equal(call.options.headers?.Cookie, cookie + '; buvid3=' + device);
    assert.equal(call.options.timeoutMs, 1234);
    assert.equal(call.url.hostname, 'api.bilibili.com');
  }
  const request = f.calls[2].url;
  assert.equal(request.searchParams.get('keyword'), '中文 空格 +');
  assert.equal(request.searchParams.get('page'), '2');
  assert.equal(request.searchParams.get('page_size'), '12');
  assert.ok(request.search.includes('%20')); assert.ok(!request.search.includes('+'));
  assert.match(request.searchParams.get('w_rid')!, /^[a-f0-9]{32}$/);
  const unsigned = request.search.slice(1).split('&w_rid=')[0];
  assert.equal(request.searchParams.get('w_rid'), createHash('md5').update(unsigned + 'ea1db124af3c7062474693fa704f4ff8').digest('hex'));
  assert.equal(f.diagnostics.length, 0);
});

test('existing site cookie is preferred without requesting or replacing it', async t => {
  const f = fixture(); t.after(() => f.client.dispose());
  const existing = cookie + '; buvid3=SYNTHETIC_EXISTING_DEVICE; b_nut=123';
  await f.client.search('q', 1, { cookie: existing });
  assert.deepEqual(f.paths(), [nav, search]);
  assert.ok(f.calls.every(call => call.options.headers?.Cookie === existing));
});

test('anonymous nav keys support public search while an expired session is not treated as logged in', async t => {
  const f = fixture(url => new URL(url).pathname === nav ? response(url, { isLogin: false, wbi_img: images }, -101) : normal(url));
  t.after(() => f.client.dispose());
  await f.client.search('public', 1, {});
  assert.deepEqual(f.paths(), [getbuvid, nav, search]);
  assert.equal(f.calls[0].options.headers?.Cookie, undefined);
  assert.equal(f.calls[2].options.headers?.Cookie, 'buvid3=' + device);
  assert.equal(f.diagnostics.length, 0, 'successful anonymous key lookup is not a failure');
  const g = fixture(url => new URL(url).pathname === nav ? response(url, { isLogin: false, wbi_img: images }, -101) : normal(url));
  t.after(() => g.client.dispose());
  await assert.rejects(g.client.search('private', 1, { cookie }), failed('login_required'));
  assert.deepEqual(g.paths(), [getbuvid, nav]);
  assert.equal(g.diagnostics[0].apiCode, -101);
  assert.equal(g.diagnostics[0].endpoint, 'account');
});

test('credential changes isolate preparation and cannot reuse another identity site cookie', async t => {
  let issued = 0;
  const f = fixture(url => new URL(url).pathname === getbuvid ? response(url, { buvid: device + ++issued }) : normal(url));
  t.after(() => f.client.dispose());
  await f.client.search('first', 1, { cookie });
  const second = cookie.replace('synthetic-session', 'synthetic-second-session');
  await f.client.search('second', 1, { cookie: second });
  assert.deepEqual(f.paths(), [getbuvid, nav, search, getbuvid, nav, search]);
  assert.equal(f.calls[2].options.headers?.Cookie, cookie + '; buvid3=' + device + '1');
  assert.equal(f.calls[5].options.headers?.Cookie, second + '; buvid3=' + device + '2');
});

test('concurrent searches prepare a single device cookie and key set', async t => {
  const gate = deferred<void>();
  const f = fixture(async url => { if (new URL(url).pathname === getbuvid) await gate.promise; return normal(url); });
  t.after(() => f.client.dispose());
  const first = f.client.search('first', 1, { cookie });
  await until(() => f.calls.length === 1);
  const second = f.client.search('second', 1, { cookie });
  gate.resolve(); await Promise.all([first, second]);
  assert.deepEqual(f.paths(), [getbuvid, nav, search, search]);
});

test('a cancelled preparation waiter leaves the owning search running', async t => {
  const gate = deferred<void>();
  const f = fixture(async url => { if (new URL(url).pathname === getbuvid) await gate.promise; return normal(url); });
  t.after(() => f.client.dispose());
  const first = f.client.search('first', 1, { cookie });
  await until(() => f.calls.length === 1);
  const controller = new AbortController();
  const second = f.client.search('cancelled', 1, { cookie, signal: controller.signal });
  controller.abort(); await assert.rejects(second, failed('cancelled'));
  gate.resolve(); await first;
  assert.deepEqual(f.paths(), [getbuvid, nav, search]);
});

test('a preparation failure is shared by existing waiters without automatic retries', async t => {
  const gate = deferred<void>(); let rejectPreparation = true;
  const f = fixture(async url => {
    if (new URL(url).pathname === getbuvid && rejectPreparation) { await gate.promise; return response(url, {}, 0, 412); }
    return normal(url);
  });
  t.after(() => f.client.dispose());
  const first = f.client.search('first', 1, { cookie });
  await until(() => f.calls.length === 1);
  const second = f.client.search('second', 1, { cookie });
  const failures = Promise.all([assert.rejects(first, failed('access_blocked')), assert.rejects(second, failed('access_blocked'))]);
  gate.resolve(); await failures;
  assert.deepEqual(f.paths(), [getbuvid]);
  rejectPreparation = false;
  await f.client.search('later explicit call', 1, { cookie });
  assert.deepEqual(f.paths(), [getbuvid, getbuvid, nav, search]);
});

test('cancellation and disposal after late preparation responses stop all following requests', async t => {
  for (const stop of [false, true]) for (const stage of [getbuvid, nav]) {
    const gate = deferred<void>();
    const f = fixture(async url => { if (new URL(url).pathname === stage) await gate.promise; return normal(url); });
    t.after(() => f.client.dispose());
    const controller = new AbortController();
    const pending = f.client.search('late', 1, { cookie, signal: controller.signal });
    await until(() => f.paths().includes(stage));
    if (stop) await f.client.dispose(); else controller.abort();
    gate.resolve(); await assert.rejects(pending, failed(stop ? 'stopped' : 'cancelled'));
    assert.deepEqual(f.paths(), stage === getbuvid ? [getbuvid] : [getbuvid, nav]);
  }
});

test('WBI keys expire after five minutes without obtaining another device cookie', async t => {
  let now = 1702204169000; t.mock.method(Date, 'now', () => now);
  const f = fixture(); t.after(() => f.client.dispose());
  await f.client.search('first', 1, { cookie });
  now += 5 * 60 * 1000 - 1;
  await f.client.search('cached', 1, { cookie });
  now++;
  await f.client.search('refreshed', 1, { cookie });
  assert.deepEqual(f.paths(), [getbuvid, nav, search, search, nav, search]);
});

test('HTTP rejection, API rejection and validation vouchers remain explicit with no retry or device rotation', async t => {
  for (const failure of ['http', 'api', 'voucher']) {
    const f = fixture(url => new URL(url).pathname !== search ? normal(url)
      : response(url, failure === 'voucher' ? { v_voucher: 'SYNTHETIC_SECRET_VOUCHER' } : {}, failure === 'api' ? -352 : 0, failure === 'http' ? 412 : 200));
    t.after(() => f.client.dispose());
    await assert.rejects(f.client.search('SYNTHETIC_PRIVATE_QUERY', 1, { cookie }), failed('access_blocked'));
    assert.deepEqual(f.paths(), [getbuvid, nav, search]);
    await assert.rejects(f.client.search('another explicit call', 1, { cookie }), failed('access_blocked'));
    assert.deepEqual(f.paths(), [getbuvid, nav, search, search]);
    assert.equal(f.diagnostics.length, 2);
    assert.ok(f.diagnostics.every(event => event.endpoint === 'search'));
    const serialized = JSON.stringify(f.diagnostics);
    for (const secret of ['SYNTHETIC_', 'synthetic-session', 'w_rid', 'buvid', 'keyword']) assert.equal(serialized.includes(secret), false);
    if (failure === 'voucher') {
      assert.equal(f.diagnostics[0].stage, 'response'); assert.equal(f.diagnostics[0].errorCode, 'access_blocked');
      assert.equal(f.diagnostics[0].httpStatus, 200); assert.equal(f.diagnostics[0].apiCode, undefined);
    }
  }
});

test('malformed preparation stops before search and invalid input never initializes a session', async t => {
  for (const value of ['', 'bad; SESSDATA=injected', null, 'x'.repeat(201)]) {
    const f = fixture(url => response(url, { buvid: value })); t.after(() => f.client.dispose());
    await assert.rejects(f.client.search('q', 1, { cookie }), failed('malformed_response'));
    assert.deepEqual(f.paths(), [getbuvid]);
  }
  const f = fixture(url => new URL(url).pathname === nav ? response(url, { wbi_img: {} }) : normal(url));
  t.after(() => f.client.dispose());
  await assert.rejects(f.client.search('q', 1, { cookie }), failed('malformed_response'));
  assert.deepEqual(f.paths(), [getbuvid, nav]);
  const g = fixture(); t.after(() => g.client.dispose());
  const controller = new AbortController(); controller.abort();
  await assert.rejects(g.client.search('q', 1, { signal: controller.signal }), failed('cancelled'));
  await assert.rejects(g.client.search('\ud800', 1, {}), failed('invalid_input'));
  await assert.rejects(g.client.search('q', 1, { timeoutMs: 0 }), failed('invalid_input'));
  assert.equal(g.calls.length, 0);
});

test('runtime account-generation changes during preparation prevent further requests with the old identity', async t => {
  for (const stage of [getbuvid, nav]) {
    const gate = deferred<void>();
    const f = fixture(async url => { if (new URL(url).pathname === stage) await gate.promise; return normal(url); });
    let account = { cookie, mid: 123, name: 'Synthetic', revision: 'synthetic-revision-1' };
    const runtime = new BiliRuntime(f.client, { status: () => ({}),
      settings: () => ({ timeoutMs: 1000, concurrency: 2, hasProxy: false }), search: async () => ({}) }, {
      signal: new AbortController().signal, transient: true, config: () => structuredClone(defaults), account: () => account,
      readLedger: async () => ({}), saveLedger: async () => { throw Error('Search must not write a ledger'); },
    });
    t.after(() => runtime.dispose()); await runtime.initialize();
    const pending = runtime.read('search', { query: 'synthetic generation check' }, { id: 'synthetic-session', permission: 'full' });
    await until(() => f.paths().includes(stage));
    account = { ...account, cookie: cookie.replace('synthetic-session', 'synthetic-new-session'), revision: 'synthetic-revision-2' };
    gate.resolve();
    const result = await pending as any;
    assert.equal(result.content.status, 'error'); assert.equal(result.content.error.code, 'account_changed');
    assert.deepEqual(f.paths(), stage === getbuvid ? [getbuvid] : [getbuvid, nav]);
  }
});

test('a new account generation with identical cookies is not poisoned by the old generation failure', async t => {
  const gate = deferred<void>(); let deviceRequests = 0;
  const f = fixture(async url => {
    if (new URL(url).pathname === getbuvid && ++deviceRequests === 1) await gate.promise;
    return normal(url);
  });
  let account = { cookie, mid: 123, name: 'Synthetic', revision: 'synthetic-revision-1' };
  const runtime = new BiliRuntime(f.client, { status: () => ({}),
    settings: () => ({ timeoutMs: 1000, concurrency: 2, hasProxy: false }), search: async () => ({}) }, {
    signal: new AbortController().signal, transient: true, config: () => structuredClone(defaults), account: () => account,
    readLedger: async () => ({}), saveLedger: async () => { throw Error('Search must not write a ledger'); },
  });
  t.after(() => runtime.dispose()); await runtime.initialize();
  const session = { id: 'synthetic-session', permission: 'full' as const };
  const oldGeneration = runtime.read('search', { query: 'old generation' }, session);
  await until(() => f.calls.length === 1);
  account = { ...account, revision: 'synthetic-revision-2' };
  const newGeneration = runtime.read('search', { query: 'new generation' }, session);
  await until(() => runtime.status().activeRequests === 2);
  await new Promise(resolve => setImmediate(resolve));
  gate.resolve();
  const [oldResult, newResult] = await Promise.all([oldGeneration, newGeneration]) as any[];
  assert.equal(oldResult.content.status, 'error'); assert.equal(oldResult.content.error.code, 'account_changed');
  assert.equal(newResult.content.status, 'ok');
  assert.deepEqual(f.paths(), [getbuvid, getbuvid, nav, search]);
  assert.equal(f.calls[3].url.searchParams.get('keyword'), 'new generation');
});
