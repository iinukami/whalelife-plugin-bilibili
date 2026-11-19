/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BiliClient } from '../src/client.ts';
import { BiliError } from '../src/errors.ts';
import { TransportError } from '../src/transport.ts';
import type { BiliClientOptions } from '../src/client.ts';
import type { TransportOptions, TransportResponse } from '../src/transport.ts';

const COOKIE = 'SESSDATA=synthetic-session; bili_jct=0123456789abcdef0123456789abcdef';
const DEVICE = 'SYNTHETIC_SHARED_DEVICE';
const BV = 'BV1xx411c7mD';
const INPUT = { action: 'comment' as const, aid: 111, mid: 222, bvid: BV, text: "合成 !(内容)* & % + =", mentionOwner: { uid: '456', name: '合成主人' } };
const KEYS = { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' };
const json = (url: string, data: unknown, code = 0): TransportResponse => ({ url, status: 200, headers: {}, body: Buffer.from(JSON.stringify({ code, data })) });
function fixture(t: { after: (fn: () => Promise<void>) => void }, extras: BiliClientOptions = {}, handler?: (url: string, options: TransportOptions) => TransportResponse | undefined) {
  const calls: { url: URL; options: TransportOptions }[] = [];
  const client = new BiliClient({ ...extras, transport: { async request(raw, options) {
    const url = new URL(raw); calls.push({ url, options });
    const override = handler?.(raw, options); if (override) return override;
    if (url.pathname === '/x/web-frontend/getbuvid') return json(raw, { buvid: DEVICE });
    if (url.pathname === '/x/web-interface/nav') return json(raw, { wbi_img: KEYS });
    if (url.pathname === '/x/web-interface/wbi/search/type') return json(raw, { result: [], numPages: 0 });
    if (url.pathname === '/x/v2/reply/add') return json(raw, { rpid_str: '1234' });
    if (url.pathname === '/x/v2/reply/detail') return json(raw, { root: { rpid: 1234, oid: 111, root: 0, parent: 0, type: 1, state: 0, invisible: false } });
    throw Error('unexpected synthetic route');
  }, dispose() {} } });
  t.after(() => client.dispose()); return { client, calls };
}

test('search and comment reuse one device context and WBI signs the complete posted form including owner mapping', async t => {
  const f = fixture(t);
  await f.client.search('synthetic', 1, { cookie: COOKIE });
  await f.client.interact(INPUT, { cookie: COOKIE });
  assert.deepEqual(f.calls.map(call => call.url.pathname), ['/x/web-frontend/getbuvid', '/x/web-interface/nav', '/x/web-interface/wbi/search/type', '/x/v2/reply/add', '/x/v2/reply/detail']);
  const post = f.calls.find(call => call.options.method === 'POST')!;
  const body = Object.fromEntries(new URLSearchParams(post.options.body)), values = { ...body, wts: post.url.searchParams.get('wts')! };
  const encoded = Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(value.replace(/[!'()*]/g, ''))).join('&');
  assert.equal(post.url.searchParams.get('w_rid'), createHash('md5').update(encoded + 'ea1db124af3c7062474693fa704f4ff8').digest('hex'));
  assert.equal(body.message, '@合成主人 ' + INPUT.text); assert.equal(body.at_name_to_mid, JSON.stringify({ 合成主人: 456 }));
  assert.equal(post.options.headers?.Cookie, COOKIE + '; buvid3=' + DEVICE);
  assert.ok(f.calls.every(call => /Chrome\/131/.test(call.options.headers?.['User-Agent'] ?? '')));
});

test('persisted device uses only a normalized credential digest and survives a fresh client without crossing accounts', async t => {
  const persisted = new Map<string, string>();
  const seen: string[] = [];
  const deps: BiliClientOptions = { readDevice: scope => { seen.push(scope); return persisted.get(scope); }, saveDevice: (scope, value) => { persisted.set(scope, value); } };
  const first = fixture(t, deps); await first.client.interact(INPUT, { cookie: COOKIE });
  assert.equal(persisted.size, 1); assert.deepEqual([...persisted.keys()], [createHash('sha256').update(COOKIE).digest('hex')]);
  const second = fixture(t, deps); await second.client.interact(INPUT, { cookie: '  ' + COOKIE.replace('; ', ';  ') + '  ' });
  assert.equal(second.calls.filter(call => call.url.pathname.endsWith('getbuvid')).length, 0);
  assert.equal(second.calls.find(call => call.options.method === 'POST')!.options.headers?.Cookie, COOKIE + '; buvid3=' + DEVICE);
  const other = fixture(t, deps); await other.client.interact(INPUT, { cookie: COOKIE.replace('synthetic-session', 'synthetic-other') });
  assert.equal(other.calls.filter(call => call.url.pathname.endsWith('getbuvid')).length, 1); assert.equal(persisted.size, 2);
  assert.ok(seen.every(value => /^[a-f0-9]{64}$/.test(value))); assert.equal(JSON.stringify([...persisted]).includes('SESSDATA'), false);
});

test('existing device cookies remain authoritative and anonymous browsing does not persist account context', async t => {
  let read = 0, save = 0;
  const deps = { readDevice: () => { read++; return DEVICE; }, saveDevice: () => { save++; } };
  const own = fixture(t, deps); await own.client.interact(INPUT, { cookie: COOKIE + '; buvid3=SYNTHETIC_IMPORTED_DEVICE' });
  assert.equal(read, 0); assert.equal(save, 0); assert.equal(own.calls.some(call => call.url.pathname.endsWith('getbuvid')), false);
  assert.equal(own.calls.find(call => call.options.method === 'POST')!.options.headers?.Cookie, COOKIE + '; buvid3=SYNTHETIC_IMPORTED_DEVICE');
  const anonymous = fixture(t, deps); await anonymous.client.search('synthetic', 1, {});
  assert.equal(read, 0); assert.equal(save, 0);
});

test('preparation and persistence failures identify an unsubmitted mutation rather than an uncertain submission', async t => {
  for (const deps of [{ readDevice: () => { throw Error('SYNTHETIC_PRIVATE_ERROR'); } }, { readDevice: () => 'bad' }, { saveDevice: () => { throw Error('SYNTHETIC_PRIVATE_ERROR'); } }]) {
    const f = fixture(t, deps);
    await assert.rejects(f.client.interact(INPUT, { cookie: COOKIE }), error => error instanceof TransportError && !error.submitted && error.code === 'persistence_error');
    assert.equal(f.calls.some(call => call.options.method === 'POST'), false);
  }
  const failed = fixture(t, {}, url => new URL(url).pathname.endsWith('getbuvid') ? json(url, {}, -352) : undefined);
  await assert.rejects(failed.client.interact(INPUT, { cookie: COOKIE }), error => error instanceof TransportError && !error.submitted && error.code === 'access_blocked');
  assert.equal(failed.calls.length, 1);
});

test('account changes during preparation cannot persist or submit work for the abandoned account', async t => {
  let changed = false, saved = 0;
  const f = fixture(t, { saveDevice: () => { saved++; } }, url => { if (new URL(url).pathname.endsWith('getbuvid')) changed = true; return undefined; });
  await assert.rejects(f.client.interact(INPUT, { cookie: COOKIE, assertCurrent() { if (changed) throw new BiliError('account_changed'); } }), error => error instanceof TransportError && !error.submitted && error.code === 'account_changed');
  assert.equal(saved, 0); assert.equal(f.calls.some(call => call.options.method === 'POST'), false);
});

test('publication wall-clock budget ends before a second request if the bounded wait exhausts it', async t => {
  let clock = 1700000000000;
  const f = fixture(t, { publicationNow: () => clock, publicationSleep: async () => { clock += 30001; } }, url =>
    new URL(url).pathname === '/x/v2/reply/detail' ? json(url, {}, 12006) : undefined);
  const result = await f.client.interact(INPUT, { cookie: COOKIE });
  assert.equal(result.state, 'confirmed'); assert.equal(result.comment?.visibility, 'unknown'); assert.equal(result.comment?.attempts, 1);
  assert.equal(f.calls.filter(call => call.url.pathname === '/x/v2/reply/detail').length, 1);
});

test('a protected read records the explicit traffic reason and never waits or retries', async t => {
  for (const code of ['traffic_paused', 'traffic_cooldown', 'traffic_budget', 'traffic_verification']) {
    const f = fixture(t, {}, url => { if (new URL(url).pathname === '/x/v2/reply/detail') throw new TransportError(code, false); return undefined; });
    const result = await f.client.interact(INPUT, { cookie: COOKIE });
    assert.equal(result.state, 'confirmed'); assert.equal(result.comment?.evidence?.[0].errorCode, code);
    assert.equal(f.calls.filter(call => call.url.pathname === '/x/v2/reply/detail').length, 1);
  }
});

test('comments carry a final account guard through transport scheduling and remain unsubmitted if it fails', async t => {
  let changed = false, finalGuard = false;
  const f = fixture(t, {}, (url, options) => {
    assert.equal(typeof options.beforeDispatch, 'function');
    if (options.method === 'POST') {
      changed = true; finalGuard = true;
      try { options.beforeDispatch!(); } catch (error) { throw new TransportError(error instanceof BiliError ? error.code : 'network_error', false); }
      assert.fail('stale account reached dispatch');
    }
    return undefined;
  });
  await assert.rejects(f.client.interact(INPUT, { cookie: COOKIE, assertCurrent() { if (changed) throw new BiliError('account_changed'); } }),
    error => error instanceof TransportError && !error.submitted && error.code === 'account_changed');
  assert.equal(finalGuard, true); assert.equal(f.calls.some(call => call.url.pathname === '/x/v2/reply/detail'), false);
});
