/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BiliClient } from '../src/client.ts';
import { BiliError } from '../src/errors.ts';
import { TransportError } from '../src/transport.ts';
import type { TransportOptions, TransportResponse } from '../src/transport.ts';

const BV = 'BV1Z24J6dEBk';
const COOKIE = 'SESSDATA=synthetic-session; bili_jct=0123456789abcdef0123456789abcdef; DedeUserID=123';
const item = { bvid: BV, aid: 111, title: '<em>合成</em> &amp; 测试', owner: { mid: 123, name: '测试作者' }, duration: 32, pic: '//i0.hdslb.com/synthetic.jpg', goto: 'av' };
function fixture() {
  const calls: { url: string; options: TransportOptions }[] = [];
  const queue: (Partial<TransportResponse> | Error)[] = [];
  let disposed = false;
  const client = new BiliClient({ transport: {
    async request(url, options) {
      calls.push({ url, options });
      const path = new URL(url).pathname;
      // Preparation has dedicated protocol tests; these cases focus on normalizing result data.
      if (path === '/x/web-frontend/getbuvid') return { status: 200, headers: {}, url,
        body: Buffer.from(JSON.stringify({ code: 0, data: { buvid: 'SYNTHETIC_SEARCH_DEVICE' } })) };
      if (path === '/x/web-interface/nav' && options.diagnosticPurpose === 'search_keys') return { status: 200, headers: {}, url,
        body: Buffer.from(JSON.stringify({ code: 0, data: { wbi_img: {
          img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
          sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } } })) };
      const next = queue.shift(); assert.ok(next, 'missing synthetic response');
      if (next instanceof Error) throw next;
      return { status: 200, headers: {}, body: Buffer.from('{}'), url, ...next };
    }, dispose() { disposed = true; },
  } });
  return { client, calls, queue, disposed: () => disposed,
    json(data: unknown, code = 0, headers: Record<string, string | string[]> = {}) { queue.push({ body: Buffer.from(JSON.stringify({ code, data })), headers }); },
  };
}
const errorCode = (code: string) => (error: unknown) => error instanceof BiliError && error.code === code;
const notificationActor = { mid: 123, nickname: 'Synthetic actor', avatar: 'UNUSED_AVATAR', fans: 99, follow: true };
function replyNotification(id: string | number = '101') {
  return { id, user: { ...notificationActor }, reply_time: 1000, counts: 1, is_multi: 0,
    item: { type: 'reply', business: '评论', business_id: 1, subject_id: 111, root_id: 333, source_id: 334, target_id: 333,
      title: 'Synthetic video', desc: '', source_content: '<em>Synthetic reply</em> &amp; details', target_reply_content: 'Synthetic original comment',
      root_reply_content: 'Synthetic root comment', uri: `https://www.bilibili.com/video/${BV}/?from=synthetic#reply334` } };
}
function likeNotification(id: string | number = '201') {
  return { id, users: [{ ...notificationActor }, { ...notificationActor, mid: 124, nickname: 'Synthetic second actor' }], like_time: 1000, counts: 15,
    item: { type: 'reply', business: '评论', business_id: 1, item_id: 444, pid: 111, title: 'Synthetic liked comment', desc: '',
      uri: `https://www.bilibili.com/video/${BV}/?tracking=synthetic` } };
}

test('recommendation and search normalize ordinary videos without confusing ads or HTML titles', async () => {
  const f = fixture();
  f.json({ item: [item, { ...item, goto: 'ad' }, { title: 'malformed' }] });
  const list = await f.client.feed('recommended', 1, undefined, {});
  assert.equal(list.items.length, 1); assert.equal(list.items[0].title, '合成 & 测试'); assert.equal(list.nextPage, 2);
  assert.equal(f.calls[0].options.headers?.Cookie, undefined);
  assert.equal(new URL(f.calls[0].url).pathname, '/x/web-interface/wbi/index/top/feed/rcmd');
  f.json({ result: [{ ...item, type: 'video', duration: '12:34', mid: 123, author: '测试作者', owner: undefined }, { ...item, type: 'live' }], numPages: 3 });
  const search = await f.client.search('合成问题', 2, {});
  assert.equal(search.items[0].duration, 754); assert.equal(search.items.length, 1); assert.equal(search.nextPage, 3);
  assert.equal(new URL(f.calls.find(call => new URL(call.url).pathname === '/x/web-interface/wbi/search/type')!.url).searchParams.get('keyword'), '合成问题');
});

test('following requires login, reads archive/author modules and preserves opaque pagination', async () => {
  const f = fixture();
  await assert.rejects(f.client.feed('following', 1, undefined, {}), errorCode('login_required'));
  assert.equal(f.calls.length, 0);
  f.json({ items: [{ modules: { module_author: item.owner, module_dynamic: { major: { archive: { bvid: BV, aid: '111', title: '动态视频', cover: item.pic, duration_text: '00:32' } } } } }], has_more: true, offset: 'next_synthetic_cursor' });
  const list = await f.client.feed('following', 2, 'previous', { cookie: COOKIE });
  assert.equal(list.items[0].duration, 32); assert.equal(list.cursor, 'next_synthetic_cursor'); assert.equal(list.hasMore, true);
  assert.equal(new URL(f.calls[0].url).searchParams.get('offset'), 'previous');
});

test('malformed supported video candidates and declared subtitle tracks cannot masquerade as empty results', async () => {
  const f = fixture();
  f.json({ item: [{ goto: 'av', bvid: BV }] }); await assert.rejects(f.client.feed('recommended', 1, undefined, {}), errorCode('malformed_response'));
  f.json({ items: [{ type: 'DYNAMIC_TYPE_AV', modules: {} }] }); await assert.rejects(f.client.feed('following', 1, undefined, { cookie: COOKIE }), errorCode('malformed_response'));
  f.json({ result: [{ type: 'video', bvid: BV }], numPages: 1 }); await assert.rejects(f.client.search('q', 1, {}), errorCode('malformed_response'));
  f.json({ subtitle: { subtitles: [{ id: 1, lan: 'zh', subtitle_url: 'https://127.0.0.1/private' }] } });
  await assert.rejects(f.client.subtitles(BV, 10, {}), errorCode('malformed_response'));
  f.json({ item: [{ goto: 'ad' }] }); assert.deepEqual((await f.client.feed('recommended', 1, undefined, {})).items, []);
  f.json({ result: [], numPages: 0 }); assert.deepEqual((await f.client.search('q', 1, {})).items, []);
  f.json({ subtitle: { subtitles: [] }, need_login_subtitle: true });
  assert.deepEqual(await f.client.subtitles(BV, 10, {}), { tracks: [], loginRequired: true });
});

test('video references allow only canonical Bilibili targets and parse multi-part content', async () => {
  const f = fixture();
  for (const target of ['https://evil.example/video/' + BV, 'https://www.bilibili.com@evil.example/video/' + BV, 'file:///secret', 'BV123', 'https://www.bilibili.com/video/' + BV + '/extra'])
    await assert.rejects(f.client.video(target, {}), errorCode(target.includes('@') ? 'unsafe_url' : 'invalid_input'));
  assert.equal(f.calls.length, 0);
  f.json({ ...item, cid: 10, copyright: 3, desc: '合成简介', pages: [{ cid: 10, page: 1, part: 'P1', duration: 32 }, { cid: 11, page: 2, part: 'P2', duration: 20 }] });
  const video = await f.client.video('https://www.bilibili.com/video/' + BV + '/?p=2', {});
  assert.equal(video.parts.length, 2); assert.equal(video.cid, 10); assert.equal(video.copyright, 3);
  assert.equal(new URL(f.calls[0].url).searchParams.get('bvid'), BV);
});

test('explicit b23 short links resolve anonymously and use only canonical official video destinations', async () => {
  const f = fixture();
  f.queue.push({ url: `https://www.bilibili.com/video/${BV}/?from=synthetic`, body: Buffer.from('UNTRUSTED_SHORTLINK_BODY_WITH_FAKE_VIDEO_DATA') });
  f.json({ ...item, cid: 10, desc: '合成简介', pages: [{ cid: 10, page: 1, part: 'P1', duration: 32 }] });
  const result = await f.client.video('https://b23.tv/synthetic123', { cookie: COOKIE });
  assert.equal(result.bvid, BV); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].url, 'https://b23.tv/synthetic123'); assert.equal(f.calls[0].options.headers?.Cookie, undefined);
  assert.equal(new URL(f.calls[1].url).origin, 'https://api.bilibili.com'); assert.equal(new URL(f.calls[1].url).searchParams.get('bvid'), BV);
  assert.equal(f.calls[1].options.headers?.Cookie, COOKIE);
  for (const destination of [`https://evil.example/video/${BV}/`, 'https://www.bilibili.com/space/123', 'https://b23.tv/another']) {
    f.queue.push({ url: destination });
    await assert.rejects(f.client.video('https://b23.tv/synthetic123', {}), errorCode('invalid_input'));
  }
  const count = f.calls.length;
  for (const target of ['https://b23.tv/', 'https://b23.tv/a/b', 'https://www.b23.tv/abc', 'https://b23.tv.evil.example/abc', 'http://b23.tv/abc'])
    await assert.rejects(f.client.video(target, {}), errorCode('invalid_input'));
  assert.equal(f.calls.length, count);
  f.queue.push(new TransportError('unsafe_url', false)); await assert.rejects(f.client.video('https://b23.tv/synthetic123', {}), errorCode('unsafe_url'));
});

test('comment IDs retain exact decimal strings and server failures are not empty success', async () => {
  const f = fixture();
  f.json({ replies: [{ rpid_str: '9007199254740993123', root_str: '0', content: { message: '合成评论' }, member: { mid: '123', uname: '合成观众' }, like: 2 }], page: { count: 50, size: 20 } });
  const comments = await f.client.comments(111, 1, {});
  assert.equal(comments.items[0].rpid, '9007199254740993123'); assert.equal(comments.nextPage, 2);
  f.json({}, -352); await assert.rejects(f.client.comments(111, 1, {}), errorCode('access_blocked'));
  f.json({}, -101); await assert.rejects(f.client.comments(111, 1, {}), errorCode('login_required'));
  f.json({ result: 'changed' }); await assert.rejects(f.client.search('q', 1, {}), errorCode('malformed_response'));
});

test('notifications require login and validate typed cursors before any request', async t => {
  const f = fixture(); t.after(() => f.client.dispose());
  await assert.rejects(f.client.notifications('replies', undefined, {}), errorCode('login_required'));
  await assert.rejects(f.client.notifications('messages' as any, undefined, { cookie: COOKIE }), errorCode('invalid_input'));
  for (const cursor of [null, [], {}, { id: 1, time: 1000 }, { id: '0', time: 1000 }, { id: '01', time: 1000 }, { id: '1', time: '1000' },
    { id: '1', time: 0 }, { id: '1', time: NaN }, { id: '1', time: Number.MAX_SAFE_INTEGER + 1 }, { id: '1', time: 1000, source: 'likes' },
    { id: '1'.repeat(21), time: 1000 }, { id: '1&ack=1', time: 1000 }])
    await assert.rejects(f.client.notifications('replies', cursor as any, { cookie: COOKIE }), errorCode('invalid_input'));
  assert.equal(f.calls.length, 0);
});

test('reply notifications preserve exact ids and selected public fields without inventing reply targets', async t => {
  const f = fixture(); t.after(() => f.client.dispose());
  const row = replyNotification('9007199254740993123');
  f.json({ cursor: { is_end: false, id: '9007199254740993124', time: 999 }, items: [row], last_view_at: 900 });
  const found = await f.client.notifications('replies', undefined, { cookie: COOKIE });
  assert.deepEqual(found.cursor, { id: '9007199254740993124', time: 999 }); assert.equal(found.hasMore, true);
  assert.deepEqual(found.items, [{ id: '9007199254740993123', actors: [{ mid: 123, name: 'Synthetic actor' }], time: 1000,
    type: 'reply', business: '评论', title: 'Synthetic video', text: 'Synthetic reply & details', originalText: 'Synthetic original comment',
    uri: `https://www.bilibili.com/video/${BV}/`, videoTarget: BV, target: { aid: 111, rpid: '334', root: '333', authorMid: 123 } }]);
  assert.equal(Object.hasOwn(found.items[0], 'commentRef'), false);
  const request = f.calls[0], url = new URL(request.url);
  assert.equal(url.pathname, '/x/msgfeed/reply'); assert.equal(url.searchParams.get('platform'), 'web');
  assert.equal(url.searchParams.get('build'), '0'); assert.equal(url.searchParams.get('mobi_app'), 'web');
  assert.equal(url.searchParams.has('id'), false); assert.equal(request.options.method ?? 'GET', 'GET'); assert.equal(request.options.headers?.Cookie, COOKIE);
  f.json({ cursor: { is_end: true, id: 0, time: 0 }, items: [] });
  assert.deepEqual(await f.client.notifications('replies', found.cursor, { cookie: COOKIE }), { items: [], hasMore: false });
  const next = new URL(f.calls[1].url); assert.equal(next.searchParams.get('id'), found.cursor!.id); assert.equal(next.searchParams.get('reply_time'), '999');
  assert.equal(next.searchParams.has('like_time'), false); assert.equal(f.calls.length, 2);
});

test('like notifications merge latest and history once, deduplicate ids and paginate history only', async t => {
  const f = fixture(); t.after(() => f.client.dispose());
  f.json({ latest: { items: [likeNotification('201')], last_view_at: 900 },
    total: { cursor: { is_end: false, id: 202, time: 998 }, items: [likeNotification('201'), likeNotification('202')] } });
  const first = await f.client.notifications('likes', undefined, { cookie: COOKIE });
  assert.deepEqual(first.items.map(item => item.id), ['201', '202']); assert.equal(first.items[0].actors.length, 2);
  assert.equal(first.items[0].likeCount, 15); assert.equal(first.items[0].text, 'Synthetic liked comment'); assert.deepEqual(first.cursor, { id: '202', time: 998 });
  f.json({ latest: { items: [likeNotification('201')] }, total: { cursor: { is_end: true, id: 0, time: 0 }, items: [likeNotification('203')] } });
  const next = await f.client.notifications('likes', first.cursor, { cookie: COOKIE });
  assert.deepEqual(next.items.map(item => item.id), ['203']); assert.equal(next.hasMore, false);
  const url = new URL(f.calls[1].url); assert.equal(url.pathname, '/x/msgfeed/like'); assert.equal(url.searchParams.get('like_time'), '998');
  assert.equal(url.searchParams.has('reply_time'), false);
  assert.ok(f.calls.every(call => (call.options.method ?? 'GET') === 'GET' && ['/x/msgfeed/reply', '/x/msgfeed/like'].includes(new URL(call.url).pathname)));
});

test('non-video notification business remains display data and unsafe locations never become video targets', async t => {
  const f = fixture(); t.after(() => f.client.dispose());
  const rows = [
    { ...replyNotification('1'), item: { ...replyNotification().item, type: 'article', business: '专栏', uri: `https://www.bilibili.com/video/${BV}/?token=synthetic` } },
    { ...replyNotification('2'), item: { ...replyNotification().item, type: 'dynamic', business: '动态', uri: 'https://t.bilibili.com/123?tracking=synthetic#fragment' } },
    ...['https://www.bilibili.com.evil.example/video/' + BV, 'https://synthetic:secret@www.bilibili.com/video/' + BV,
      'javascript:alert(1)', 'http://www.bilibili.com/video/' + BV, 'https://127.0.0.1/video/' + BV,
      'https://www.bilibili.com:444/video/' + BV].map((uri, i) => ({ ...replyNotification(String(i + 3)), item: { ...replyNotification().item, uri } })),
    { ...replyNotification('9'), item: { ...replyNotification().item, uri: '', subject_id: 111, source_id: 222 } },
  ];
  f.json({ cursor: { is_end: true, id: 0, time: 0 }, items: rows });
  const result = await f.client.notifications('replies', undefined, { cookie: COOKIE });
  assert.equal(result.items.length, rows.length); assert.ok(result.items.every(item => !item.videoTarget));
  assert.equal(result.items[1].uri, 'https://t.bilibili.com/123'); assert.ok(result.items.slice(2).every(item => item.uri === undefined));
  assert.ok(!JSON.stringify(result).includes('synthetic:secret')); assert.ok(!JSON.stringify(result).includes('tracking='));
});

test('malformed notification rows and numeric fields fail explicitly instead of disappearing', async t => {
  const f = fixture(); t.after(() => f.client.dispose());
  for (const row of [null, { ...replyNotification(), item: null }, { ...replyNotification(), id: Number.MAX_SAFE_INTEGER + 1 },
    { ...replyNotification(), user: {} }, { ...replyNotification(), reply_time: '1000' }, { ...replyNotification(), reply_time: -1 },
    { ...replyNotification(), item: { ...replyNotification().item, source_content: 17 } },
    { ...replyNotification(), item: { ...replyNotification().item, type: '<script>' } },
    { ...replyNotification(), item: { ...replyNotification().item, uri: 123 } }]) {
    f.json({ cursor: { is_end: true, id: 0, time: 0 }, items: [row] });
    await assert.rejects(f.client.notifications('replies', undefined, { cookie: COOKIE }), errorCode('malformed_response'));
  }
  for (const row of [{ ...likeNotification(), users: [] }, { ...likeNotification(), users: 'changed' }, { ...likeNotification(), counts: -1 }, { ...likeNotification(), counts: '15' }]) {
    f.json({ total: { cursor: { is_end: true, id: 0, time: 0 }, items: [row] } });
    await assert.rejects(f.client.notifications('likes', undefined, { cookie: COOKIE }), errorCode('malformed_response'));
  }
});

test('notification pagination rejects missing, malformed or stalled cursors while explicit empty endings succeed', async t => {
  const f = fixture(); t.after(() => f.client.dispose()); const cursor = { id: '100', time: 1000 };
  for (const next of [undefined, {}, { is_end: 1, id: 1, time: 1 }, { is_end: false, id: 0, time: 1 },
    { is_end: false, id: 1, time: 0 }, { is_end: false, id: '100', time: 1000 }, { is_end: true, id: Number.MAX_SAFE_INTEGER + 1, time: 1 }]) {
    f.json({ cursor: next, items: [] }); await assert.rejects(f.client.notifications('replies', cursor, { cookie: COOKIE }), errorCode('malformed_response'));
  }
  for (const data of [{}, { cursor: { is_end: true, id: 0, time: 0 } }, { cursor: { is_end: true, id: 0, time: 0 }, items: 'changed' }]) {
    f.json(data); await assert.rejects(f.client.notifications('replies', undefined, { cookie: COOKIE }), errorCode('malformed_response'));
  }
  f.json({ cursor: { is_end: true, id: 0, time: 0 }, items: null });
  assert.deepEqual(await f.client.notifications('replies', undefined, { cookie: COOKIE }), { items: [], hasMore: false });
  f.json({ latest: null, total: { cursor: { is_end: true, id: 0, time: 0 }, items: [] } });
  assert.deepEqual(await f.client.notifications('likes', undefined, { cookie: COOKIE }), { items: [], hasMore: false });
});

test('notification pages are bounded and platform login/restriction errors do not retry', async t => {
  const f = fixture(); t.after(() => f.client.dispose());
  f.json({ cursor: { is_end: true, id: 0, time: 0 }, items: Array.from({ length: 101 }, () => replyNotification()) });
  await assert.rejects(f.client.notifications('replies', undefined, { cookie: COOKIE }), errorCode('too_large'));
  f.json({}, -101); await assert.rejects(f.client.notifications('replies', undefined, { cookie: COOKIE }), errorCode('login_required'));
  f.json({}, -352); await assert.rejects(f.client.notifications('likes', undefined, { cookie: COOKIE }), errorCode('access_blocked'));
  assert.equal(f.calls.length, 3); assert.ok(f.calls.every(call => (call.options.method ?? 'GET') === 'GET'));
});

test('only official-discovered subtitles and images can be downloaded and never receive cookies', async () => {
  const f = fixture(); const subtitle = 'https://aisubtitle.hdslb.com/synthetic.json';
  await assert.rejects(f.client.subtitle(subtitle, { cookie: COOKIE }), errorCode('unsafe_url'));
  await assert.rejects(f.client.image('https://i0.hdslb.com/synthetic.jpg', 1024, { cookie: COOKIE }), errorCode('unsafe_url'));
  assert.equal(f.calls.length, 0);
  f.json({ subtitle: { subtitles: [{ id_str: '9007199254740993123', lan: 'zh-CN', lan_doc: '中文', subtitle_url: subtitle }] }, need_login_subtitle: false });
  const tracks = await f.client.subtitles(BV, 10, { cookie: COOKIE }); assert.equal(tracks.tracks.length, 1);
  f.queue.push({ body: Buffer.from(JSON.stringify({ body: [{ from: 1.5, to: 4, content: '合成字幕' }] })) });
  assert.deepEqual(await f.client.subtitle(subtitle, { cookie: COOKIE }), [{ from: 1.5, to: 4, text: '合成字幕' }]);
  assert.equal(f.calls.at(-1)?.options.headers?.Cookie, undefined);
  f.json({ item: [item] }); await f.client.feed('recommended', 1, undefined, {});
  f.queue.push({ body: Buffer.from([255,216,255,0,0]) });
  assert.equal((await f.client.image('https://i0.hdslb.com/synthetic.jpg', 1024, { cookie: COOKIE })).mime, 'image/jpeg');
  assert.equal(f.calls.at(-1)?.options.headers?.Cookie, undefined);
});

test('official API redirect to a different origin cannot introduce trusted media sources', async () => {
  const f = fixture(); f.queue.push({ url: 'https://evil.example/json', body: Buffer.from(JSON.stringify({ code: 0, data: { item: [item] } })) });
  await assert.rejects(f.client.feed('recommended', 1, undefined, {}), errorCode('unsafe_url'));
});

test('complete MP4 retrieval accepts provider CDN origins without cookies and rejects partial/multi-segment forms', async () => {
  const f = fixture(); const url = 'https://synthetic.edge.mountaintoys.cn/media.mp4?synthetic=1';
  f.json({ format: 'mp4', durl: [{ size: 16, url }] });
  const bytes = Buffer.from([0,0,0,16,102,116,121,112,105,115,111,109,0,0,0,0]); f.queue.push({ body: bytes });
  const media = await f.client.media(BV, 10, 1024, { cookie: COOKIE });
  assert.equal(media.mime, 'video/mp4'); assert.deepEqual(media.bytes, bytes); assert.equal(f.calls[1].options.headers?.Cookie, undefined);
  f.json({ format: 'mp4', durl: [{ size: 2048, url }] }); await assert.rejects(f.client.media(BV, 10, 1024, {}), errorCode('too_large'));
  f.json({ format: 'mp4', durl: [{ url }, { url }] }); await assert.rejects(f.client.media(BV, 10, 1024, {}), errorCode('unsupported_media'));
  f.json({ format: 'dash', dash: {} }); await assert.rejects(f.client.media(BV, 10, 1024, {}), errorCode('unsupported_media'));
  f.json({ format: 'mp4', durl: [{ size: 16, url }] }); f.queue.push({ status: 206, body: bytes });
  await assert.rejects(f.client.media(BV, 10, 1024, {}), errorCode('unsupported_media'));
  f.json({ format: 'mp4', durl: [{ size: 100, url }] }); f.queue.push({ body: bytes });
  await assert.rejects(f.client.media(BV, 10, 1024, {}), errorCode('unsupported_media'));
  assert.equal(f.calls.length, 9);
});

test('MP4 selects a safe provider backup before downloading when the primary URL is rejected', async t => {
  const f = fixture(); t.after(() => f.client.dispose());
  const primary = 'https://synthetic.edge.mountaintoys.cn:4483/media.mp4';
  const backup = 'https://synthetic.bilivideo.com/media.mp4';
  const bytes = Buffer.from([0,0,0,16,102,116,121,112,105,115,111,109,0,0,0,0]);
  f.json({ format: 'mp4', durl: [{ size: 16, url: primary, backup_url: [null, 'https://127.0.0.1/media.mp4', backup] }] });
  f.queue.push({ body: bytes });
  assert.deepEqual((await f.client.media(BV, 10, 1024, { cookie: COOKIE })).bytes, bytes);
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].url, backup);
  assert.equal(f.calls[1].options.headers?.Cookie, undefined);
  f.json({ format: 'mp4', durl: [{ url: primary, backup_url: ['https://localhost/media.mp4', 'https://synthetic:secret@synthetic.bilivideo.com/media.mp4'] }] });
  await assert.rejects(f.client.media(BV, 10, 1024, {}), errorCode('unsafe_url'));
  f.json({ format: 'mp4', durl: [{ url: primary, backup_url: backup }] });
  await assert.rejects(f.client.media(BV, 10, 1024, {}), errorCode('unsafe_url'));
  f.json({ format: 'mp4', durl: [{ url: primary, backup_url: [...Array(8).fill(null), backup] }] });
  await assert.rejects(f.client.media(BV, 10, 1024, {}), errorCode('unsafe_url'));
  assert.equal(f.calls.length, 5);
});

test('MP4 prefers a valid primary and never tries backups after a download failure', async t => {
  const f = fixture(); t.after(() => f.client.dispose());
  const primary = 'https://synthetic-primary.bilivideo.com/media.mp4';
  const backup = 'https://synthetic-backup.bilivideo.com/media.mp4';
  f.json({ format: 'mp4', durl: [{ url: primary, backup_url: [backup] }] });
  f.queue.push({ status: 403 });
  await assert.rejects(f.client.media(BV, 10, 1024, { cookie: COOKIE }), errorCode('access_blocked'));
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].url, primary);
  assert.equal(f.calls[1].options.headers?.Cookie, undefined);
});

test('QR login states only return minimal selected cookies after a locally issued key confirms', async () => {
  const f = fixture(); const key = 'synthetic_qr_key_0123456789';
  assert.deepEqual(await f.client.pollLogin('unissued', {}), { state: 'expired' }); assert.equal(f.calls.length, 0);
  f.json({ qrcode_key: key, url: 'https://passport.bilibili.com/h5-app/passport/login/scan?synthetic=1' });
  assert.equal((await f.client.beginLogin({ cookie: COOKIE })).key, key); assert.equal(f.calls[0].options.headers?.Cookie, undefined);
  for (const [code, state] of [[86101, 'waiting'], [86090, 'scanned']] as const) {
    f.json({ code }); assert.deepEqual(await f.client.pollLogin(key, {}), { state });
  }
  f.json({ code: 0, refresh_token: 'synthetic-refresh-not-retained' }, 0, { 'set-cookie': [
    'SESSDATA=synthetic-confirmed; Path=/; HttpOnly', 'bili_jct=0123456789abcdef0123456789abcdef; Path=/',
    'DedeUserID=123; Path=/', 'unneeded=synthetic-tracking; Path=/',
  ] });
  const confirmed = await f.client.pollLogin(key, {}); assert.equal(confirmed.state, 'confirmed');
  if (confirmed.state === 'confirmed') { assert.ok(confirmed.cookie.includes('SESSDATA=')); assert.equal(confirmed.cookie.includes('unneeded'), false); assert.equal(confirmed.refreshToken, 'synthetic-refresh-not-retained'); }
  assert.deepEqual(await f.client.pollLogin(key, {}), { state: 'expired' });
});

test('QR generation accepts the observed account destination and preserves the passport destination', async t => {
  const f = fixture(); t.after(() => f.client.dispose());
  for (const url of [
    'https://account.bilibili.com/h5/account-h5/auth/scan-web?synthetic=1',
    'https://passport.bilibili.com/h5-app/passport/login/scan?synthetic=1',
  ]) {
    const key = 'synthetic_qr_key_allowed_0123456789';
    f.json({ qrcode_key: key, url });
    assert.deepEqual(await f.client.beginLogin({ cookie: COOKIE }), { key, url });
    const call = f.calls.at(-1)!;
    assert.equal(new URL(call.url).origin, 'https://passport.bilibili.com');
    assert.equal(call.options.headers?.Cookie, undefined);
  }
});

test('QR destination validation rejects alternate origins, credentials, ports and malformed URLs without retaining keys', async t => {
  const f = fixture(); t.after(() => f.client.dispose());
  const key = 'synthetic_qr_key_rejected_0123456789';
  for (const url of [
    'https://account.bilibili.com.evil.example/scan', 'https://evil.example/scan',
    'https://passport.bilibili.tv/scan', 'https://www.bilibili.com/scan',
    'https://account.bilibili.com:444/scan', 'https://synthetic:secret@passport.bilibili.com/scan',
    'https://account.bilibili.com@evil.example/scan', 'http://account.bilibili.com/scan',
    'https://account.bilibili.com/scan#fragment', ' https://account.bilibili.com/scan',
    'https://account.bilibili.com/scan\n', '//account.bilibili.com/scan',
    'https://account.bilibili.com/scan?synthetic=' + 'x'.repeat(4096),
    'https://account.bilibili.com/scan?synthetic=' + '合'.repeat(1000), null, 17,
  ]) {
    f.json({ qrcode_key: key, url });
    await assert.rejects(f.client.beginLogin({}), errorCode('malformed_response'));
    const count = f.calls.length;
    assert.deepEqual(await f.client.pollLogin(key, {}), { state: 'expired' });
    assert.equal(f.calls.length, count, 'an invalid QR destination cannot create a pollable local key');
  }
});

test('account and favorites use explicit login and return normalized metadata', async () => {
  const f = fixture(); await assert.rejects(f.client.account({}), errorCode('login_required'));
  f.json({ isLogin: true, mid: 123, uname: '合成账号' }); assert.deepEqual(await f.client.account({ cookie: COOKIE }), { mid: 123, name: '合成账号' });
  f.json({ list: [{ id: 456, title: '合成收藏夹' }] }); assert.deepEqual(await f.client.folders(123, { cookie: COOKIE }), [{ id: '456', title: '合成收藏夹' }]);
});

test('renewing QR codes evicts old local keys instead of blocking the fifth user request', async () => {
  const f = fixture(); const keys: string[] = [];
  for (let index = 0; index < 5; index++) {
    const key = `synthetic_qr_key_0123456789_${index}`; keys.push(key);
    f.json({ qrcode_key: key, url: `https://passport.bilibili.com/h5-app/passport/login/scan?synthetic=${index}` });
    assert.equal((await f.client.beginLogin({})).key, key);
  }
  assert.deepEqual(await f.client.pollLogin(keys[0], {}), { state: 'expired' });
  assert.equal(f.calls.length, 5);
  f.json({ code: 86101 }); assert.deepEqual(await f.client.pollLogin(keys[4], {}), { state: 'waiting' });
});

test('five interactions encode bounded form data and explicit success while preserving comment IDs', async () => {
  const f = fixture();
  for (const action of ['like', 'favorite', 'follow', 'comment', 'reply'] as const) {
    f.json(action === 'comment' || action === 'reply' ? { rpid_str: '9007199254740993123' } : {});
    const result = await f.client.interact({ action, aid: 111, mid: 123, folderId: '456', text: '合成 & 内容=安全', root: '789', parent: '790' }, { cookie: COOKIE });
    assert.equal(result.state, 'confirmed');
    const call = f.calls.at(-1)!; assert.equal(call.options.method, 'POST');
    const fields = new URLSearchParams(call.options.body); assert.equal(fields.get('csrf'), '0123456789abcdef0123456789abcdef');
    if (action === 'comment' || action === 'reply') { assert.equal(fields.get('message'), '合成 & 内容=安全'); assert.equal(result.platformId, '9007199254740993123'); }
    if (action === 'reply') { assert.equal(fields.get('root'), '789'); assert.equal(fields.get('parent'), '790'); }
  }
  assert.equal(f.calls.length, 5);
});

test('removed coin action and stale coinCount reject before transport dispatch', async t => {
  const f = fixture(); t.after(() => f.client.dispose());
  for (const input of [{ action: 'coin', aid: 111, mid: 456 }, { action: 'coin', aid: 111, mid: 456, coinCount: 1 }, { action: 'like', aid: 111, mid: 456, coinCount: 1 }])
    await assert.rejects(f.client.interact(input as any, { cookie: COOKIE }), errorCode('invalid_input'));
  assert.equal(f.calls.length, 0);
  assert.equal('coins' in f.client, false);
});

test('captcha rejection code -401 reports access_blocked without replaying the request', async t => {
  const f = fixture(); t.after(() => f.client.dispose());
  f.json({}, -401);
  await assert.rejects(f.client.interact({ action: 'like', aid: 111, mid: 456 }, { cookie: COOKIE }), errorCode('access_blocked'));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].options.method, 'POST');
  assert.equal(new URL(f.calls[0].url).pathname, '/x/web-interface/archive/like');
});

test('uncertain mutations never retry; clear preflight failures and platform rejections stay distinct', async () => {
  const f = fixture(); const input = { action: 'like' as const, aid: 111, mid: 123 };
  f.queue.push(new TransportError('timeout', true)); await assert.rejects(f.client.interact(input, { cookie: COOKIE }), errorCode('uncertain')); assert.equal(f.calls.length, 1);
  f.queue.push(new TransportError('unsafe_url', false)); await assert.rejects(f.client.interact(input, { cookie: COOKIE }), errorCode('unsafe_url'));
  f.queue.push({ body: Buffer.from('<html>unknown</html>') }); await assert.rejects(f.client.interact(input, { cookie: COOKIE }), errorCode('uncertain'));
  f.json({}, -101); await assert.rejects(f.client.interact(input, { cookie: COOKIE }), errorCode('login_required'));
  f.json({}); await assert.rejects(f.client.interact({ ...input, action: 'comment', text: '合成' }, { cookie: COOKIE }), errorCode('uncertain'));
  assert.equal(f.calls.length, 5);
});

test('mutation code zero confirms state changes despite absent data but comments still require reliable IDs', async () => {
  const f = fixture();
  for (const data of [null, 1, [], 'synthetic-acknowledgement']) {
    f.json(data); assert.deepEqual(await f.client.interact({ action: 'like', aid: 111, mid: 123 }, { cookie: COOKIE }), { state: 'confirmed' });
    f.json(data); await assert.rejects(f.client.interact({ action: 'comment', aid: 111, mid: 123, text: '合成' }, { cookie: COOKIE }), errorCode('uncertain'));
  }
  assert.equal(f.calls.length, 8);
});

test('validation and cancellation do not dispatch requests, and dispose invalidates media/login state', async () => {
  const f = fixture(); const aborter = new AbortController(); aborter.abort('synthetic-secret-reason');
  await assert.rejects(f.client.search('q', 1, { signal: aborter.signal }), errorCode('cancelled'));
  await assert.rejects(f.client.search('', 1, {}), errorCode('invalid_input'));
  await assert.rejects(f.client.search('q', 1001, {}), errorCode('invalid_input'));
  await assert.rejects(f.client.account({ cookie: 'SESSDATA=secret\r\nHost: evil' }), errorCode('invalid_input'));
  await assert.rejects(f.client.interact({ action: 'reply', aid: 111, mid: 123, text: '合成', root: 'bad', parent: '1' }, { cookie: COOKIE }), errorCode('invalid_input'));
  assert.equal(f.calls.length, 0); await f.client.dispose(); assert.equal(f.disposed(), true);
  await assert.rejects(f.client.search('q', 1, {}), errorCode('stopped'));
});
