/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BiliClient } from '../src/client.ts';
import { createDeviceStore } from '../src/device-state.ts';
import type { BiliClientOptions } from '../src/client.ts';
import type { TransportOptions } from '../src/transport.ts';

const COOKIE = 'SESSDATA=synthetic-device-session; bili_jct=0123456789abcdef0123456789abcdef; DedeUserID=17';
const OTHER = COOKIE.replace('synthetic-device-session', 'synthetic-other-session');
const DEVICE = 'SYNTHETIC_EXISTING_DEVICE', BV = 'BV1xx411c7mD';
const hash = (cookie: string) => createHash('sha256').update(cookie).digest('hex');
const keys = { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(t: { after: (job: () => Promise<void>) => void }, extras: BiliClientOptions = {}) {
  const saved = new Map<string, string>(), calls: { path: string; options: TransportOptions }[] = [];
  let before = async (_path: string, _options: TransportOptions) => {}, issued = 0, anonymousMissing = false;
  let row: any = { rpid: 1234, oid: 111, root: 0, parent: 0, type: 1, state: 0, invisible: false,
    content: { message: 'SYNTHETIC_COMMENT' }, member: { mid: 17, uname: 'Synthetic' }, like: 0, ctime: 100 };
  const client = new BiliClient({ readDevice: scope => saved.get(scope), saveDevice: (scope, value) => { saved.set(scope, value); },
    removeDevice: scope => { saved.delete(scope); }, publicationSleep: async () => {}, ...extras,
    transport: { async request(url, options) {
      const parsed = new URL(url), path = parsed.pathname; calls.push({ path, options });
      await before(path, options); options.beforeDispatch?.();
      let data: unknown, code = 0;
      if (path.endsWith('/getbuvid')) data = { buvid: 'SYNTHETIC_DEVICE_' + ++issued };
      else if (path.endsWith('/nav')) data = { isLogin: true, mid: 17, uname: 'Synthetic', wbi_img: keys };
      else if (path.endsWith('/search/type')) data = { result: [], numPages: 0 };
      else if (path === '/x/player/wbi/v2') data = { bvid: BV, cid: 456, subtitle: { subtitles: [] } };
      else if (path === '/x/v2/reply/add') {
        const form = new URLSearchParams(options.body);
        row = { ...row, root: Number(form.get('root') ?? 0), parent: Number(form.get('parent') ?? 0) };
        data = { rpid_str: '1234' };
      } else if (path === '/x/v2/reply/detail') {
        if (anonymousMissing && !options.headers?.Cookie) { code = 12006; data = {}; } else data = { root: row };
      } else if (path === '/x/v2/reply/reply') data = { root: { ...row, root: 0, parent: 0 }, replies: [], page: { num: 1, size: 20, count: 0 } };
      else throw Error('unexpected synthetic route');
      return { url, status: 200, headers: {}, body: Buffer.from(JSON.stringify({ code, data })) };
    }, dispose() {} } });
  t.after(() => client.dispose());
  return { client, calls, saved, before(fn: typeof before) { before = fn; }, setAnonymousMissing() { anonymousMissing = true; } };
}

test('refresh restoration reads only an exact saved scope, never a same-MID login or anonymous device', async t => {
  const f = fixture(t); f.saved.set(hash(COOKIE), DEVICE);
  assert.equal(await f.client.prepareRefreshCookie(COOKIE, {}), COOKIE + '; buvid3=' + DEVICE);
  assert.equal(await f.client.prepareRefreshCookie(OTHER, {}), OTHER);
  assert.equal(await f.client.prepareRefreshCookie('', {}), '');
  assert.equal(await f.client.prepareRefreshCookie(COOKIE + '; buvid3=SYNTHETIC_IMPORTED', {}), COOKIE + '; buvid3=SYNTHETIC_IMPORTED');
  assert.equal(f.calls.length, 0); assert.equal(f.saved.size, 1);
});

test('anonymous interleaving does not create a second preparation for the same logged-in scope', async t => {
  const f = fixture(t), entered = deferred(), blocked = deferred(); let first = true;
  f.before(async (path, options) => {
    if (path.endsWith('/getbuvid') && options.headers?.Cookie && first) { first = false; entered.resolve(); await blocked.promise; }
  });
  const a = f.client.search('synthetic', 1, { cookie: COOKIE }); await entered.promise;
  await f.client.search('synthetic', 1, {});
  const b = f.client.search('synthetic', 1, { cookie: COOKIE });
  blocked.resolve(); await Promise.all([a, b]);
  assert.equal(f.calls.filter(c => c.path.endsWith('/getbuvid') && c.options.headers?.Cookie).length, 1);
  assert.equal(f.saved.size, 1);
});

test('refresh restoration waits for the current device without a second request and cancelled waiters stay cancelled', async t => {
  const f = fixture(t), entered = deferred(), blocked = deferred(), controller = new AbortController();
  f.before(async path => { if (path.endsWith('/getbuvid')) { entered.resolve(); await blocked.promise; } });
  const search = f.client.search('synthetic', 1, { cookie: COOKIE }); await entered.promise;
  const cancelled = assert.rejects(f.client.prepareRefreshCookie(COOKIE, { signal: controller.signal }), { code: 'cancelled' });
  const restore = f.client.prepareRefreshCookie(COOKIE, {}); controller.abort(); await cancelled;
  blocked.resolve(); await search;
  assert.equal(await restore, COOKIE + '; buvid3=SYNTHETIC_DEVICE_1');
  assert.equal(f.calls.filter(c => c.path.endsWith('/getbuvid')).length, 1);
});

test('comment, reply, search, subtitle metadata and authenticated comment reads share the restored device', async t => {
  const f = fixture(t); f.saved.set(hash(COOKIE), DEVICE); const options = { cookie: COOKIE };
  await f.client.account(options); await f.client.search('synthetic', 1, options);
  await f.client.subtitles(BV, 456, options);
  await f.client.interact({ action: 'comment', aid: 111, mid: 17, bvid: BV, text: 'SYNTHETIC_COMMENT' }, options);
  await f.client.comment(111, '1234', options); await f.client.thread(111, '1234', 1, options);
  await f.client.interact({ action: 'reply', aid: 111, mid: 17, bvid: BV, text: 'SYNTHETIC_REPLY', root: '99', parent: '100' }, options);
  f.setAnonymousMissing();
  await f.client.checkCommentPublication({ action: 'reply', aid: 111, bvid: BV, root: '99', parent: '100' }, '1234', options);
  const authenticated = f.calls.filter(c => c.options.headers?.Cookie);
  assert.ok(authenticated.length >= 9);
  assert.ok(authenticated.every(c => c.options.headers!.Cookie === COOKIE + '; buvid3=' + DEVICE));
  assert.equal(f.calls.some(c => c.path.endsWith('/getbuvid')), false);
  assert.ok(f.calls.some(c => c.path.endsWith('/detail') && !c.options.headers?.Cookie), 'anonymous publication checks remain credential-free');
  assert.equal(options.cookie, COOKIE);
});

test('discard is scope-specific, clears cached and inline devices, and never acquires one during refresh', async t => {
  const f = fixture(t); f.saved.set(hash(COOKIE), DEVICE); f.saved.set(hash(OTHER), 'SYNTHETIC_OTHER_DEVICE');
  await f.client.prepareRefreshCookie(COOKIE, {}); await f.client.discardDevice(COOKIE, {});
  assert.equal(await f.client.prepareRefreshCookie(COOKIE, {}), COOKIE);
  assert.equal(await f.client.prepareRefreshCookie(OTHER, {}), OTHER + '; buvid3=SYNTHETIC_OTHER_DEVICE');
  const inline = COOKIE + '; buvid3=SYNTHETIC_IMPORTED';
  await f.client.discardDevice(inline, {});
  assert.equal(await f.client.prepareRefreshCookie(inline, {}), COOKIE);
  assert.equal(f.calls.length, 0);
  await f.client.search('synthetic', 1, { cookie: inline });
  const issuance = f.calls.find(c => c.path.endsWith('/getbuvid'))!;
  assert.equal(issuance.options.headers?.Cookie, COOKIE, 'deleted inline device is not sent to issuance');
  assert.equal(await f.client.prepareRefreshCookie(inline, {}), COOKIE + '; buvid3=SYNTHETIC_DEVICE_1');
  assert.equal(f.saved.get(hash(OTHER)), 'SYNTHETIC_OTHER_DEVICE');
});

test('discard waits behind in-flight preparation so a late save cannot resurrect the removed device', async t => {
  const f = fixture(t), entered = deferred(), blocked = deferred();
  f.before(async path => { if (path.endsWith('/getbuvid')) { entered.resolve(); await blocked.promise; } });
  const search = f.client.search('synthetic', 1, { cookie: COOKIE }); await entered.promise;
  const discard = f.client.discardDevice(COOKIE, {}); blocked.resolve(); await Promise.all([search, discard]);
  assert.equal(f.saved.has(hash(COOKIE)), false);
  assert.equal(await f.client.prepareRefreshCookie(COOKIE, {}), COOKIE);
});

test('failed removal remains a visible persistence failure and does not reuse the cached device', async t => {
  const f = fixture(t, { removeDevice: async () => { throw Error('SYNTHETIC_PRIVATE_FAILURE'); } }); f.saved.set(hash(COOKIE), DEVICE);
  await f.client.prepareRefreshCookie(COOKIE, {});
  await assert.rejects(f.client.discardDevice(COOKIE, {}), { code: 'persistence_error' });
  await assert.rejects(f.client.prepareRefreshCookie(COOKIE, {}), { code: 'persistence_error' });
  await assert.rejects(f.client.search('synthetic', 1, { cookie: COOKIE }), { code: 'persistence_error' });
  assert.equal(f.calls.length, 0);
});

test('idle removed scopes can be evicted rather than permanently exhausting the preparation limit', async t => {
  const f = fixture(t);
  for (let i = 0; i < 70; i++) await f.client.discardDevice(COOKIE.replace('synthetic-device-session', 'synthetic-session-' + i), {});
  assert.equal(await f.client.prepareRefreshCookie(COOKIE, {}), COOKIE); assert.equal(f.calls.length, 0);
});

test('device removal persists an exact deletion across reload and preserves other scopes', async () => {
  let stored: unknown;
  const create = () => createDeviceStore({ read: async () => stored, save: async value => { stored = structuredClone(value); } });
  const first = create(); await first.save(hash(COOKIE), DEVICE); await first.save(hash(OTHER), 'SYNTHETIC_OTHER_DEVICE');
  await first.remove(hash(COOKIE)); const reloaded = create();
  assert.equal(await reloaded.read(hash(COOKIE)), undefined); assert.equal(await reloaded.read(hash(OTHER)), 'SYNTHETIC_OTHER_DEVICE');
});
