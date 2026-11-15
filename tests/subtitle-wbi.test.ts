/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BiliClient } from '../src/client.ts';
import { BiliError } from '../src/errors.ts';
import type { RequestDiagnostic } from '../src/diagnostics.ts';
import type { TransportOptions, TransportResponse } from '../src/transport.ts';

const BV = 'BV1Z24J6dEBk', OTHER_BV = 'BV1xx411c7mD', CID = 456;
const COOKIE = 'SESSDATA=synthetic-subtitle-session; bili_jct=synthetic-csrf; DedeUserID=123';
const DEVICE = 'SYNTHETIC_SUBTITLE_DEVICE';
const URL = 'https://aisubtitle.hdslb.com/synthetic.json?auth_key=SYNTHETIC_SIGNATURE%2B%2F&uid=123&empty=';
const REFERER = 'https://www.bilibili.com/video/' + BV + '/';
const BUVID = '/x/web-frontend/getbuvid', NAV = '/x/web-interface/nav', PLAYER = '/x/player/wbi/v2';
const IMAGES = { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
  sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' };
const TRACK = { id_str: '1234567890123456789', subtitle_url: URL, lan: 'ai-zh', lan_doc: '合成字幕' };
const CUES = [{ from: 0, to: 1, content: '合成字幕正文' }];
const fail = (code: string) => (error: unknown) => error instanceof BiliError && error.code === code;
const response = (url: string, data: unknown, code = 0, status = 200): TransportResponse =>
  ({ status, headers: {}, body: Buffer.from(JSON.stringify({ code, data })), url });
function normal(url: string): TransportResponse {
  const parsed = new globalThis.URL(url);
  if (parsed.pathname === BUVID) return response(url, { buvid: DEVICE });
  if (parsed.pathname === NAV) return response(url, { wbi_img: IMAGES });
  if (parsed.pathname === PLAYER) return response(url, { bvid: parsed.searchParams.get('bvid'), cid: Number(parsed.searchParams.get('cid')), subtitle: { subtitles: [TRACK] } });
  if (parsed.pathname === '/x/web-interface/wbi/search/type') return response(url, { result: [], numPages: 0 });
  assert.equal(url, URL, 'no old player fallback or unexpected destination');
  return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ body: CUES })), url };
}
function fixture(t: { after: (fn: () => Promise<void>) => void }, handler: (url: string, options: TransportOptions) => TransportResponse | Promise<TransportResponse> = normal) {
  const calls: { url: globalThis.URL; rawUrl: string; options: TransportOptions }[] = [], events: RequestDiagnostic[] = [];
  const client = new BiliClient({ onDiagnostic: event => { events.push(event); }, transport: {
    async request(url, options) { calls.push({ url: new globalThis.URL(url), rawUrl: url, options }); return handler(url, options); }, dispose() {},
  } });
  t.after(() => client.dispose()); return { client, calls, events, paths: () => calls.map(call => call.url.pathname) };
}
function safeEvents(events: RequestDiagnostic[]) {
  const serialized = JSON.stringify(events);
  for (const secret of [COOKIE, DEVICE, BV, URL, 'SYNTHETIC_SIGNATURE', 'auth_key', 'synthetic-subtitle-session', '合成字幕正文'])
    assert.equal(serialized.includes(secret), false, 'diagnostics retained private data');
}

test('subtitles use genuine WBI signing and bind the complete CDN URL to its video context without forwarding credentials', async t => {
  const f = fixture(t), options = { cookie: COOKIE, timeoutMs: 1234 };
  const found = await f.client.subtitles(BV, CID, options);
  assert.deepEqual(f.paths(), [BUVID, NAV, PLAYER]); assert.equal(found.tracks[0].url, URL); assert.equal(options.cookie, COOKIE);
  const api = f.calls[2], unsigned = api.url.search.slice(1).split('&w_rid=')[0];
  assert.deepEqual([...api.url.searchParams.keys()].sort(), ['bvid', 'cid', 'w_rid', 'wts']);
  assert.equal(api.url.searchParams.get('bvid'), BV); assert.equal(api.url.searchParams.get('cid'), String(CID));
  assert.match(api.url.searchParams.get('wts')!, /^\d+$/);
  assert.equal(api.url.searchParams.get('w_rid'), createHash('md5').update(unsigned + 'ea1db124af3c7062474693fa704f4ff8').digest('hex'));
  assert.equal(f.calls[0].options.diagnosticPurpose, 'subtitle_cookie'); assert.equal(f.calls[1].options.diagnosticPurpose, 'subtitle_keys');
  assert.equal(api.options.headers?.Referer, REFERER); assert.equal(api.options.headers?.Cookie, COOKIE + '; buvid3=' + DEVICE);
  assert.deepEqual(await f.client.subtitle(found.tracks[0].url, options), [{ from: 0, to: 1, text: CUES[0].content }]);
  const cdn = f.calls[3]; assert.equal(cdn.rawUrl, URL); assert.equal(cdn.options.headers?.Referer, REFERER);
  assert.equal(cdn.options.headers?.Cookie, undefined); assert.equal(cdn.options.diagnosticPurpose, 'subtitle_body');
  assert.ok(f.calls.every(call => (call.options.method ?? 'GET') === 'GET' && call.options.timeoutMs === 1234));
  assert.equal(f.events.length, 0);
});

test('subtitle and search preparation share a cache without replacing an existing site cookie', async t => {
  const f = fixture(t), cookie = COOKIE + '; buvid3=SYNTHETIC_EXISTING_DEVICE';
  await f.client.subtitles(BV, CID, { cookie }); await f.client.search('synthetic', 1, { cookie }); await f.client.subtitles(BV, CID, { cookie });
  assert.deepEqual(f.paths(), [NAV, PLAYER, '/x/web-interface/wbi/search/type', PLAYER]);
  assert.ok(f.calls.every(call => call.options.headers?.Cookie === cookie)); assert.equal(f.events.length, 0);
});

test('public anonymous subtitles accept valid anonymous navigation keys but expired sessions do not masquerade as anonymous', async t => {
  const handler = (url: string) => new globalThis.URL(url).pathname === NAV ? response(url, { isLogin: false, wbi_img: IMAGES }, -101) : normal(url);
  const f = fixture(t, handler); const result = await f.client.subtitles(BV, CID, {});
  await f.client.subtitle(result.tracks[0].url, {});
  assert.deepEqual(f.paths(), [BUVID, NAV, PLAYER, '/synthetic.json']);
  assert.equal(f.calls[0].options.headers?.Cookie, undefined); assert.equal(f.calls[2].options.headers?.Cookie, 'buvid3=' + DEVICE);
  assert.equal(f.calls[3].options.headers?.Cookie, undefined); assert.equal(f.events.length, 0);
  const expired = fixture(t, handler);
  await assert.rejects(expired.client.subtitles(BV, CID, { cookie: COOKIE }), fail('login_required'));
  assert.deepEqual(expired.paths(), [BUVID, NAV]); assert.equal(expired.events[0].endpoint, 'subtitle_keys');
  assert.equal(expired.events[0].phase, 'subtitle_prepare'); assert.equal(expired.events[0].apiCode, -101); safeEvents(expired.events);
});

test('preparation and player failures stop at their actual endpoint without falling back or retrying', async t => {
  for (const example of [
    { path: BUVID, data: {}, code: 0, status: 200, error: 'malformed_response', endpoint: 'subtitle_cookie', phase: 'subtitle_prepare', paths: [BUVID] },
    { path: BUVID, data: {}, code: -352, status: 200, error: 'access_blocked', endpoint: 'subtitle_cookie', phase: 'subtitle_prepare', paths: [BUVID] },
    { path: NAV, data: {}, code: 0, status: 200, error: 'malformed_response', endpoint: 'subtitle_keys', phase: 'subtitle_prepare', paths: [BUVID, NAV] },
    { path: NAV, data: {}, code: -101, status: 200, error: 'login_required', endpoint: 'subtitle_keys', phase: 'subtitle_prepare', paths: [BUVID, NAV] },
    { path: PLAYER, data: {}, code: -352, status: 200, error: 'access_blocked', endpoint: 'subtitle_tracks', phase: 'subtitle_tracks', paths: [BUVID, NAV, PLAYER] },
    { path: PLAYER, data: {}, code: 0, status: 412, error: 'access_blocked', endpoint: 'subtitle_tracks', phase: 'subtitle_tracks', paths: [BUVID, NAV, PLAYER] },
  ]) {
    const f = fixture(t, url => new globalThis.URL(url).pathname === example.path ? response(url, example.data, example.code, example.status) : normal(url));
    await assert.rejects(f.client.subtitles(BV, CID, { cookie: COOKIE }), fail(example.error)); assert.deepEqual(f.paths(), example.paths);
    assert.equal(f.events.length, 1); assert.equal(f.events[0].endpoint, example.endpoint); assert.equal(f.events[0].phase, example.phase); safeEvents(f.events);
  }
});

test('nonempty tracks require matching video and part identities and do not authorize a URL on mismatch', async t => {
  for (const identity of [{ bvid: OTHER_BV, cid: CID }, { bvid: BV, cid: CID + 1 }, { cid: CID }, { bvid: BV }]) {
    const f = fixture(t, url => new globalThis.URL(url).pathname === PLAYER ? response(url, { ...identity, subtitle: { subtitles: [TRACK] } }) : normal(url));
    await assert.rejects(f.client.subtitles(BV, CID, { cookie: COOKIE }), fail('malformed_response'));
    await assert.rejects(f.client.subtitle(URL, { cookie: COOKIE }), fail('unsafe_url'));
    assert.deepEqual(f.paths(), [BUVID, NAV, PLAYER]); assert.equal(f.events.length, 1);
    assert.equal(f.events[0].reason, 'identity_mismatch'); assert.ok(['data.bvid', 'data.cid'].includes(f.events[0].field!)); safeEvents(f.events);
  }
});

test('empty subtitles may omit identities while explicit mismatches are still rejected', async t => {
  for (const data of [{}, { subtitle: { subtitles: [] }, need_login_subtitle: true }, { bvid: BV, cid: CID, subtitle: { subtitles: [] } }]) {
    const f = fixture(t, url => new globalThis.URL(url).pathname === PLAYER ? response(url, data) : normal(url));
    assert.equal((await f.client.subtitles(BV, CID, {})).tracks.length, 0); assert.equal(f.events.length, 0);
  }
  for (const identity of [{ bvid: OTHER_BV }, { cid: CID + 1 }]) {
    const f = fixture(t, url => new globalThis.URL(url).pathname === PLAYER ? response(url, { ...identity, subtitle: { subtitles: [] } }) : normal(url));
    await assert.rejects(f.client.subtitles(BV, CID, {}), fail('malformed_response')); assert.equal(f.events[0].reason, 'identity_mismatch');
  }
});

test('credential changes isolate WBI preparation and reject cached subtitle context from another account', async t => {
  let issued = 0;
  const f = fixture(t, url => new globalThis.URL(url).pathname === BUVID ? response(url, { buvid: DEVICE + ++issued }) : normal(url));
  const first = await f.client.subtitles(BV, CID, { cookie: COOKIE });
  const secondCookie = COOKIE.replace('synthetic-subtitle-session', 'synthetic-second-session');
  for (const cookie of [secondCookie, undefined])
    await assert.rejects(f.client.subtitle(first.tracks[0].url, { cookie }), fail('reference_unavailable'));
  assert.equal(f.calls.length, 3);
  const second = await f.client.subtitles(BV, CID, { cookie: secondCookie });
  await f.client.subtitle(second.tracks[0].url, { cookie: secondCookie });
  assert.deepEqual(f.paths(), [BUVID, NAV, PLAYER, BUVID, NAV, PLAYER, '/synthetic.json']);
  assert.equal(f.calls[2].options.headers?.Cookie, COOKIE + '; buvid3=' + DEVICE + '1');
  assert.equal(f.calls[5].options.headers?.Cookie, secondCookie + '; buvid3=' + DEVICE + '2');
  assert.equal(f.calls[6].options.headers?.Cookie, undefined);
});

test('expired signed subtitle contexts stop locally without refreshing or downloading', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 });
  const f = fixture(t); const result = await f.client.subtitles(BV, CID, { cookie: COOKIE });
  t.mock.timers.tick(60001);
  await assert.rejects(f.client.subtitle(result.tracks[0].url, { cookie: COOKIE }), fail('reference_unavailable'));
  assert.deepEqual(f.paths(), [BUVID, NAV, PLAYER]); assert.equal(f.events.length, 0);
});

test('cancellation and identity changes during preparation prevent the signed player request', async t => {
  for (const phase of [BUVID, NAV]) for (const mode of ['cancel', 'identity']) {
    const controller = new AbortController(); let changed = false;
    const f = fixture(t, url => {
      if (new globalThis.URL(url).pathname === phase) { if (mode === 'cancel') controller.abort(); else changed = true; }
      return normal(url);
    });
    await assert.rejects(f.client.subtitles(BV, CID, { cookie: COOKIE, signal: controller.signal,
      assertCurrent() { if (changed) throw new BiliError('account_changed'); } }), fail(mode === 'cancel' ? 'cancelled' : 'account_changed'));
    assert.deepEqual(f.paths(), phase === BUVID ? [BUVID] : [BUVID, NAV]);
  }
});

test('a late player response cannot expose track contexts after account identity changes', async t => {
  let changed = false;
  const f = fixture(t, url => { if (new globalThis.URL(url).pathname === PLAYER) changed = true; return normal(url); });
  await assert.rejects(f.client.subtitles(BV, CID, { cookie: COOKIE, assertCurrent() { if (changed) throw new BiliError('account_changed'); } }), fail('account_changed'));
  await assert.rejects(f.client.subtitle(URL, { cookie: COOKIE }), fail('unsafe_url')); assert.deepEqual(f.paths(), [BUVID, NAV, PLAYER]);
});

test('video lookups reject an identity different from the requested BV or numeric aid', async t => {
  const item = { bvid: BV, aid: 111, cid: CID, title: '合成视频', owner: { mid: 123, name: '合成作者' }, duration: 2,
    pic: 'https://i0.hdslb.com/synthetic.jpg', pages: [{ cid: CID, page: 1, part: '合成分P', duration: 2 }] };
  for (const [target, data] of [[BV, { ...item, bvid: OTHER_BV }], ['av111', { ...item, aid: 222 }], ['av000111', { ...item, aid: 222 }]] as const) {
    const f = fixture(t, url => { assert.equal(new globalThis.URL(url).pathname, '/x/web-interface/view'); return response(url, data); });
    await assert.rejects(f.client.video(target, {}), fail('malformed_response')); assert.equal(f.calls.length, 1);
  }
  const valid = fixture(t, url => response(url, item));
  assert.equal((await valid.client.video('av000111', {})).aid, 111);
  assert.equal(valid.calls[0].url.searchParams.get('aid'), '111'); assert.equal(valid.calls.length, 1);
});


test('canonical numeric-string part identities remain compatible when they match the requested part', async t => {
  const f = fixture(t, url => new globalThis.URL(url).pathname === PLAYER
    ? response(url, { bvid: BV, cid: String(CID), subtitle: { subtitles: [TRACK] } }) : normal(url));
  const result = await f.client.subtitles(BV, CID, { cookie: COOKIE });
  assert.equal(result.tracks.length, 1); assert.equal(f.events.length, 0);
  await f.client.subtitle(result.tracks[0].url, { cookie: COOKIE }); assert.equal(f.calls.length, 4);
});


test('unsafe or cross-host preparation responses stop before the player and report one preparation diagnostic', async t => {
  for (const phase of [BUVID, NAV]) for (const target of ['https://redirect.example/SECRET_REDIRECT_PATH?token=SECRET_REDIRECT_TOKEN', 'https://127.0.0.1/SECRET_REDIRECT_PATH']) {
    const f = fixture(t, url => ({ ...normal(url), ...(new globalThis.URL(url).pathname === phase ? { url: target } : {}) }));
    await assert.rejects(f.client.subtitles(BV, CID, { cookie: COOKIE }), fail('unsafe_url'));
    assert.deepEqual(f.paths(), phase === BUVID ? [BUVID] : [BUVID, NAV]);
    assert.equal(f.events.length, 1); const event = f.events[0];
    assert.equal(event.phase, 'subtitle_prepare'); assert.equal(event.reason, 'invalid_response_url');
    assert.equal(event.endpoint, phase === BUVID ? 'subtitle_cookie' : 'subtitle_keys');
    assert.equal(event.stage, 'parse'); assert.equal(event.errorCode, 'unsafe_url'); assert.equal(event.field, 'response.url');
    safeEvents(f.events);
    for (const privatePart of ['SECRET_REDIRECT', 'redirect.example', '127.0.0.1'])
      assert.equal(JSON.stringify(event).includes(privatePart), false);
  }
});

test('a same-host player response on the legacy path cannot silently downgrade or authorize CDN access', async t => {
  const f = fixture(t, url => {
    const result = normal(url), parsed = new globalThis.URL(url);
    if (parsed.pathname === PLAYER) { parsed.pathname = '/x/player/v2'; result.url = parsed.href; }
    return result;
  });
  await assert.rejects(f.client.subtitles(BV, CID, { cookie: COOKIE }), fail('unsafe_url'));
  await assert.rejects(f.client.subtitle(URL, { cookie: COOKIE }), fail('unsafe_url'));
  assert.deepEqual(f.paths(), [BUVID, NAV, PLAYER]); assert.equal(f.events.length, 1);
  const event = f.events[0]; assert.equal(event.phase, 'subtitle_tracks'); assert.equal(event.endpoint, 'subtitle_tracks');
  assert.equal(event.path, PLAYER); assert.equal(event.reason, 'invalid_response_url'); assert.equal(event.field, 'response.url');
  assert.equal(event.stage, 'parse'); assert.equal(event.errorCode, 'unsafe_url'); safeEvents(f.events);
});
