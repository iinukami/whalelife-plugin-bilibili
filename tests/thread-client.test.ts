/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BiliClient } from '../src/client.ts';
import { BiliError } from '../src/errors.ts';
import type { TransportOptions, TransportResponse } from '../src/transport.ts';

const aid = 500, rootId = '100', childId = '101', actorMid = 42;
const cookie = 'SESSDATA=synthetic-thread-session; bili_jct=0123456789abcdef0123456789abcdef; DedeUserID=42';
const bv = 'BV1xx411c7mD';
const code = (expected: string) => (error: unknown) => error instanceof BiliError && error.code === expected;
function row(id = rootId, root = '0', parent = '0') {
  return { rpid: Number(id), rpid_str: id, oid: aid, oid_str: String(aid), type: 1,
    root: Number(root), root_str: root, parent: Number(parent), parent_str: parent,
    mid: actorMid, mid_str: String(actorMid), state: 0, invisible: false, like: 2,
    member: { mid: String(actorMid), uname: 'Synthetic comment author' }, content: { message: '<b>Synthetic</b> comment &amp; reply' } };
}
function fixture() {
  const calls: { url: string; options: TransportOptions }[] = [], queue: Partial<TransportResponse>[] = [];
  const client = new BiliClient({ transport: { async request(url, options) {
    calls.push({ url, options }); const next = queue.shift(); assert.ok(next, 'missing synthetic response');
    return { status: 200, headers: {}, url, body: Buffer.from('{}'), ...next };
  }, dispose() {} } });
  return { client, calls, json(data: unknown, apiCode = 0) { queue.push({ body: Buffer.from(JSON.stringify({ code: apiCode, data })) }); } };
}

test('precise detail resolves the requested root or child without searching a feed', async t => {
  const f = fixture(); t.after(() => f.client.dispose());
  for (const expected of [row(), row(childId, rootId, rootId)]) {
    f.json({ root: expected }); const result = await f.client.comment(aid, expected.rpid_str, { cookie });
    assert.deepEqual(result, { aid, rpid: expected.rpid_str, root: expected.root_str, parent: expected.parent_str,
      text: 'Synthetic comment & reply', author: { mid: actorMid, name: 'Synthetic comment author' }, likes: 2 });
    const call = f.calls.at(-1)!, url = new URL(call.url);
    assert.equal(url.pathname, '/x/v2/reply/detail'); assert.equal(url.searchParams.get('root'), expected.rpid_str);
    assert.equal(url.searchParams.get('oid'), String(aid)); assert.equal(url.searchParams.get('type'), '1');
    assert.equal(call.options.method ?? 'GET', 'GET'); assert.equal(call.options.headers?.Cookie, cookie);
  }
  assert.equal(f.calls.length, 2);
});

test('decimal-string comment ids preserve precision while contradictory numeric identity copies are rejected', async t => {
  const f = fixture(); t.after(() => f.client.dispose()); const large = '9007199254740993123';
  f.json({ root: row(large, rootId, rootId) }); assert.equal((await f.client.comment(aid, large, {})).rpid, large);
  for (const value of [{ ...row(), rpid: 999 }, { ...row(), oid: aid + 1 }, { ...row(), mid: actorMid + 1 },
    { ...row(), rpid_str: 100 }, { ...row(), root_str: null }, { ...row(), parent: {} }, { ...row(), rpid: Number.MAX_SAFE_INTEGER + 1, rpid_str: undefined }]) {
    f.json({ root: value }); await assert.rejects(f.client.comment(aid, rootId, {}), code('malformed_response'));
  }
});

test('detail rejects wrong video, wrong comment, invalid author, unsupported type and malformed parent/root relations', async t => {
  const f = fixture(); t.after(() => f.client.dispose());
  for (const value of [row(childId), { ...row(), oid: 501, oid_str: '501' }, { ...row(), type: 12 },
    { ...row(), member: { mid: '43', uname: 'Synthetic mismatch' } }, { ...row(), member: { mid: '42' } },
    { ...row(), content: { message: 17 } }, { ...row(), state: '0' }, { ...row(), invisible: undefined },
    row(rootId, '0', '102'), row(rootId, '102', '0'), row(rootId, rootId, '102'), row(rootId, '102', rootId)]) {
    f.json({ root: value }); await assert.rejects(f.client.comment(aid, rootId, {}), code('malformed_response'));
  }
});

test('unavailable or restricted comment states cannot become an actionable reference and do not retry', async t => {
  const f = fixture(); t.after(() => f.client.dispose());
  for (const root of [null, { ...row(), invisible: true }, { ...row(), state: -1 }, { ...row(), state: 99 }]) {
    f.json({ root }); await assert.rejects(f.client.comment(aid, rootId, {}), code('reference_unavailable'));
  }
  f.json({}, 12006); await assert.rejects(f.client.comment(aid, rootId, {}), code('platform_error'));
  f.json({}, -352); await assert.rejects(f.client.comment(aid, rootId, {}), code('access_blocked'));
  assert.equal(f.calls.length, 6);
});

test('thread returns a validated root and child page with explicit pagination', async t => {
  const f = fixture(); t.after(() => f.client.dispose());
  f.json({ root: row(), replies: [row(childId, rootId, rootId), row('102', rootId, childId)], page: { num: 1, size: 20, count: 21 } });
  const first = await f.client.thread(aid, rootId, 1, { cookie });
  assert.equal(first.root.rpid, rootId); assert.deepEqual(first.items.map(x => [x.rpid, x.root, x.parent]), [[childId, rootId, rootId], ['102', rootId, childId]]);
  assert.equal(first.hasMore, true); assert.equal(first.nextPage, 2);
  f.json({ root: row(), replies: [row('103', rootId, rootId)], page: { num: 2, size: 20, count: 21 } });
  assert.equal((await f.client.thread(aid, rootId, 2, {})).hasMore, false);
  const url = new URL(f.calls[1].url); assert.equal(url.pathname, '/x/v2/reply/reply'); assert.equal(url.searchParams.get('root'), rootId);
  assert.equal(url.searchParams.get('pn'), '2'); assert.equal(url.searchParams.get('ps'), '20'); assert.equal(url.searchParams.get('oid'), String(aid));
});

test('thread rejects foreign roots, wrong-video children, duplicate rows and a child masquerading as the root', async t => {
  const f = fixture(); t.after(() => f.client.dispose()); const page = { num: 1, size: 20, count: 1 };
  for (const data of [
    { root: row('999'), replies: [], page }, { root: row(rootId, '999', '999'), replies: [], page },
    { root: row(), replies: [row(childId, '999', '999')], page }, { root: row(), replies: [row()], page },
    { root: row(), replies: [{ ...row(childId, rootId, rootId), oid: 501, oid_str: '501' }], page },
    { root: row(), replies: [row(childId, rootId, rootId), row(childId, rootId, rootId)], page },
  ]) { f.json(data); await assert.rejects(f.client.thread(aid, rootId, 1, {}), code('malformed_response')); }
});

test('thread pagination has bounded typed fields and does not hide missing data as an empty thread', async t => {
  const f = fixture(); t.after(() => f.client.dispose());
  for (const page of [undefined, {}, { num: 2, size: 20, count: 1 }, { num: '1', size: 20, count: 1 },
    { num: 1, size: 0, count: 1 }, { num: 1, size: 101, count: 1 }, { num: 1, size: 20, count: -1 },
    { num: 1, size: 20, count: Number.MAX_SAFE_INTEGER + 1 }]) {
    f.json({ root: row(), replies: [], page }); await assert.rejects(f.client.thread(aid, rootId, 1, {}), code('malformed_response'));
  }
  f.json({ root: row(), replies: [], page: { num: 1, size: 20, count: 40 } }); await assert.rejects(f.client.thread(aid, rootId, 1, {}), code('malformed_response'));
  f.json({ root: row(), page: { num: 1, size: 20, count: 0 } }); await assert.rejects(f.client.thread(aid, rootId, 1, {}), code('malformed_response'));
  f.json({ root: row(), replies: null, page: { num: 1, size: 20, count: 0 } });
  const empty = await f.client.thread(aid, rootId, 1, {}); assert.deepEqual(empty.items, []); assert.equal(empty.hasMore, false);
  f.json({ root: row(), replies: Array.from({ length: 21 }, (_, i) => row(String(200 + i), rootId, rootId)), page: { num: 1, size: 20, count: 21 } });
  await assert.rejects(f.client.thread(aid, rootId, 1, {}), code('too_large'));
});

test('comment and thread reject invalid target input locally and issue only the approved GETs', async t => {
  const f = fixture(); t.after(() => f.client.dispose());
  for (const id of [null, 100, '0', '01', '-1', '100&ack=1', '1'.repeat(21)]) {
    await assert.rejects(f.client.comment(aid, id as any, {}), code('invalid_input'));
    await assert.rejects(f.client.thread(aid, id as any, 1, {}), code('invalid_input'));
  }
  for (const id of [0, -1, '500', Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(f.client.comment(id as any, rootId, {}), code('invalid_input'));
  for (const page of [0, -1, 1001, '1', 1.5]) await assert.rejects(f.client.thread(aid, rootId, page as any, {}), code('invalid_input'));
  assert.equal(f.calls.length, 0);
  f.json({ root: row() }); await f.client.comment(aid, rootId, {});
  f.json({ root: row(), replies: [], page: { num: 1, size: 20, count: 0 } }); await f.client.thread(aid, rootId, 1, {});
  assert.ok(f.calls.every(x => (x.options.method ?? 'GET') === 'GET' && ['/x/v2/reply/detail', '/x/v2/reply/reply'].includes(new URL(x.url).pathname)));
});

function notification(overrides: Record<string, unknown> = {}) {
  return { id: '999', reply_time: 1000, user: { mid: actorMid, nickname: 'Synthetic notification actor' },
    item: { type: 'reply', business: '评论', business_id: 1, subject_id: aid, source_id: childId, root_id: rootId, target_id: '777',
      title: 'Synthetic video', source_content: 'Synthetic reply text', target_reply_content: 'Synthetic original text', uri: `https://www.bilibili.com/video/${bv}/`, ...overrides } };
}
test('reply notification target uses source id and verified video business without confusing notification, target or actor ids', async t => {
  const f = fixture(); t.after(() => f.client.dispose());
  f.json({ cursor: { is_end: true, id: 0, time: 0 }, items: [notification(), notification({ source_id: '103', root_id: 0 })] });
  const result = await f.client.notifications('replies', undefined, { cookie });
  assert.deepEqual(result.items[0].target, { aid, rpid: childId, root: rootId, authorMid: actorMid });
  f.json({ cursor: { is_end: true, id: 0, time: 0 }, items: [notification({ source_id: '103', root_id: 0 })] });
  assert.deepEqual((await f.client.notifications('replies', undefined, { cookie })).items[0].target, { aid, rpid: '103', root: '103', authorMid: actorMid });
});

test('non-video or malformed notification locations remain readable without reply targets', async t => {
  const f = fixture(); t.after(() => f.client.dispose());
  const changes = [{ business_id: 12 }, { business_id: '1' }, { type: 'danmu' }, { type: 'article' },
    { subject_id: 0 }, { source_id: 0 }, { root_id: undefined }, { source_id: Number.MAX_SAFE_INTEGER + 1 },
    { uri: 'https://t.bilibili.com/123' }, { uri: `https://www.bilibili.com/video/av${aid + 1}/` }, { uri: 'https://evil.example/video/' + bv }];
  f.json({ cursor: { is_end: true, id: 0, time: 0 }, items: changes.map((change, i) => ({ ...notification(change), id: String(200 + i) })) });
  const result = await f.client.notifications('replies', undefined, { cookie });
  assert.equal(result.items.length, changes.length); assert.ok(result.items.every(x => x.target === undefined));
  const like = notification();
  f.json({ total: { cursor: { is_end: true, id: 0, time: 0 }, items: [{ id: '999', users: [like.user], item: like.item, like_time: 1000, counts: 1 }] } });
  assert.equal((await f.client.notifications('likes', undefined, { cookie })).items[0].target, undefined);
});
