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
import type { RequestDiagnostic } from '../src/diagnostics.ts';

const COOKIE = 'SESSDATA=synthetic-owner-session; bili_jct=0123456789abcdef0123456789abcdef; DedeUserID=123';
const OWNER = { uid: '456', name: '合成主人' };
const COMMENT = { action: 'comment' as const, aid: 111, mid: 222, text: '合成评论 & 安全=内容' };
const errorCode = (code: string) => (error: unknown) => error instanceof BiliError && error.code === code;
function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const calls: { url: string; options: TransportOptions }[] = [];
  const queue: (Partial<TransportResponse> | Error)[] = [];
  const diagnostics: RequestDiagnostic[] = [], preparation: string[] = [];
  let clock = 1700000000000;
  let onRequest: (() => void) | undefined;
  const client = new BiliClient({ publicationNow: () => clock,
    // These tests isolate mention encoding; exhausting the check budget prevents unrelated extra read fixtures.
    publicationSleep: async () => { clock += 30001; }, onDiagnostic: event => { diagnostics.push(event); }, transport: {
    async request(url, options) {
      const path = new URL(url).pathname;
      if (path === '/x/web-frontend/getbuvid' || path === '/x/web-interface/nav' && options.diagnosticPurpose === 'search_keys') {
        preparation.push(path);
        return { status: 200, headers: {}, url, body: Buffer.from(JSON.stringify({ code: 0, data: path.endsWith('getbuvid') ? { buvid: 'SYNTHETIC_OWNER_DEVICE' } : { wbi_img: {
          img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } } })) };
      }
      calls.push({ url, options }); onRequest?.();
      const next = queue.shift(); assert.ok(next, 'missing synthetic response');
      if (next instanceof Error) throw next;
      return { status: 200, headers: {}, body: Buffer.from('{}'), url, ...next };
    }, dispose() {},
  } });
  t.after(() => client.dispose());
  return { client, calls, queue, diagnostics, preparation, onRequest(value: () => void) { onRequest = value; },
    json(data: unknown, code = 0) { queue.push({ body: Buffer.from(JSON.stringify({ code, data })) }); },
  };
}

test('owner profile queries the exact canonical UID and retains only the public identity', async t => {
  const f = fixture(t);
  f.json({ card: { mid: '456', name: '合成主人', sign: 'SYNTHETIC_UNTRUSTED_BIO', face: 'https://i0.hdslb.com/synthetic.jpg',
    fans: 17, friend: 23, approve: true }, following: true, archive_count: 42 });
  assert.deepEqual(await f.client.ownerProfile(' \t456\n', {}), OWNER);
  assert.equal(f.calls.length, 1);
  const call = f.calls[0], url = new URL(call.url);
  assert.equal(url.origin, 'https://api.bilibili.com'); assert.equal(url.pathname, '/x/web-interface/card');
  assert.deepEqual([...url.searchParams], [['mid', '456']]);
  assert.equal(call.options.method ?? 'GET', 'GET'); assert.equal(call.options.body, undefined);
  assert.equal(call.options.headers?.Cookie, undefined); assert.equal(f.diagnostics.length, 0);
  f.json({ card: { mid: 456, name: OWNER.name } });
  assert.deepEqual(await f.client.ownerProfile(OWNER.uid, { cookie: COOKIE }), OWNER);
  assert.equal(f.calls[1].options.headers?.Cookie, COOKIE);
});

test('owner UID validation preserves the safe integer boundary and rejects malformed inputs before I/O', async t => {
  const f = fixture(t), maximum = String(Number.MAX_SAFE_INTEGER);
  f.json({ card: { mid: maximum, name: '合成最大UID' } });
  assert.deepEqual(await f.client.ownerProfile(maximum, {}), { uid: maximum, name: '合成最大UID' });
  assert.equal(new URL(f.calls[0].url).searchParams.get('mid'), maximum);
  f.json({ card: { mid: Number.MAX_SAFE_INTEGER, name: '合成最大UID' } });
  assert.equal((await f.client.ownerProfile(maximum, {})).uid, maximum);
  for (const value of ['', ' ', '0', '-1', '+1', '0456', '4.56', '4e2', '456&mid=789', '456/789',
    '9007199254740992', '99999999999999999999', 456, null, undefined, {}, []]) {
    await assert.rejects(f.client.ownerProfile(value as any, {}), errorCode('invalid_input'));
  }
  assert.equal(f.calls.length, 2);
});

test('owner profile rejects a mismatched or imprecise identity and malformed platform names', async t => {
  const f = fixture(t);
  const cards: unknown[] = [null, [], {}, { mid: '457', name: OWNER.name }, { mid: '0456', name: OWNER.name },
    { mid: '456 ', name: OWNER.name }, { mid: Number.MAX_SAFE_INTEGER + 1, name: OWNER.name },
    { mid: '9007199254740992', name: OWNER.name }, { mid: true, name: OWNER.name },
    ...[undefined, null, 17, '', ' \t', 'name@other', 'line\nbreak', 'hidden\u200bname', 'bidi\u202ename',
      '\ud800', '字'.repeat(81)].map(name => ({ mid: '456', name }))];
  for (const card of cards) {
    f.json({ card });
    await assert.rejects(f.client.ownerProfile(OWNER.uid, {}), errorCode('malformed_response'));
  }
  f.json({ card: { mid: '456', name: '合成 & 昵称😀' } });
  assert.deepEqual(await f.client.ownerProfile(OWNER.uid, {}), { uid: OWNER.uid, name: '合成 & 昵称😀' });
  assert.equal(f.calls.length, cards.length + 1);
});

test('owner lookup checks cancellation and identity guards without retrying failed profile requests', async t => {
  const f = fixture(t), aborter = new AbortController(); aborter.abort();
  await assert.rejects(f.client.ownerProfile(OWNER.uid, { signal: aborter.signal }), errorCode('cancelled'));
  await assert.rejects(f.client.ownerProfile(OWNER.uid, { assertCurrent() { throw new BiliError('account_changed'); } }), errorCode('account_changed'));
  assert.equal(f.calls.length + f.preparation.length, 0);
  let changed = false;
  f.onRequest(() => { changed = true; }); f.json({ card: { mid: OWNER.uid, name: OWNER.name } });
  await assert.rejects(f.client.ownerProfile(OWNER.uid, { assertCurrent() { if (changed) throw new BiliError('account_changed'); } }), errorCode('account_changed'));
  f.queue.push(new TransportError('timeout', true));
  await assert.rejects(f.client.ownerProfile(OWNER.uid, {}), errorCode('timeout'));
  f.json({}, -404);
  await assert.rejects(f.client.ownerProfile(OWNER.uid, {}), errorCode('platform_error'));
  assert.equal(f.calls.length, 3); assert.ok(f.calls.every(call => (call.options.method ?? 'GET') === 'GET'));
});

test('owner lookup diagnostics identify the public route without including UID, response data or credentials', async t => {
  const f = fixture(t), uid = '8098765432101', biography = 'SYNTHETIC_PRIVATE_RESPONSE_BIO';
  f.json({ card: { mid: uid, name: 'SYNTHETIC_RESPONSE_NAME', sign: biography } }, -352);
  await assert.rejects(f.client.ownerProfile(uid, { cookie: COOKIE }), errorCode('access_blocked'));
  assert.equal(f.diagnostics.length, 1);
  const event = f.diagnostics[0];
  assert.equal(event.endpoint, 'owner_profile'); assert.equal(event.host, 'api.bilibili.com');
  assert.equal(event.path, '/x/web-interface/card'); assert.equal(event.method, 'GET');
  assert.equal(event.stage, 'api'); assert.equal(event.apiCode, -352); assert.equal(event.hasSessionCookie, true);
  const serialized = JSON.stringify(event);
  for (const secret of [uid, biography, 'SYNTHETIC_RESPONSE_NAME', 'synthetic-owner-session', '0123456789abcdef', 'mid='])
    assert.equal(serialized.includes(secret), false);
});

test('comment and reply submit exactly one owner prefix with a numeric at_name_to_mid mapping', async t => {
  const f = fixture(t);
  for (const action of ['comment', 'reply'] as const) {
    f.json({ reply: { rpid_str: '9007199254740993123' } }); f.json({ root: null });
    const result = await f.client.interact({ ...COMMENT, action, mentionOwner: OWNER,
      ...(action === 'reply' ? { root: '9007199254740993121', parent: '9007199254740993122' } : {}) }, { cookie: COOKIE });
    assert.equal(result.state, 'confirmed'); assert.equal(result.platformId, '9007199254740993123');
    assert.equal(result.comment?.visibility, 'unknown'); assert.equal(result.comment?.checkedAnonymously, true);
    assert.equal(result.comment?.notification, 'unverified'); assert.equal(result.comment?.evidence?.[0].outcome, 'not_found');
    const call = f.calls.filter(item => item.options.method === 'POST').at(-1)!, fields = new URLSearchParams(call.options.body);
    assert.equal(new URL(call.url).origin + new URL(call.url).pathname, 'https://api.bilibili.com/x/v2/reply/add');
    assert.deepEqual([...new URL(call.url).searchParams.keys()].sort(), ['w_rid', 'wts']); assert.equal(call.options.method, 'POST');
    assert.equal(call.options.headers?.['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal(call.options.headers?.Cookie, COOKIE + '; buvid3=SYNTHETIC_OWNER_DEVICE');
    assert.equal(fields.get('message'), '@合成主人 ' + COMMENT.text);
    assert.deepEqual(JSON.parse(fields.get('at_name_to_mid')!), { 合成主人: 456 });
    assert.equal(fields.get('oid'), '111'); assert.equal(fields.get('type'), '1'); assert.equal(fields.get('plat'), '1');
    assert.equal(fields.get('csrf'), '0123456789abcdef0123456789abcdef');
    assert.deepEqual([...fields.keys()].sort(), ['at_name_to_mid', 'csrf', 'message', 'oid', 'plat', 'type', 'gaia_source', 'statistics',
      ...(action === 'reply' ? ['root', 'parent'] : [])].sort());
    if (action === 'reply') {
      assert.equal(fields.get('root'), '9007199254740993121'); assert.equal(fields.get('parent'), '9007199254740993122');
    }
  }
  assert.equal(f.calls.length, 4); assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 2);
});

test('ordinary comments preserve their body without adding a mention mapping', async t => {
  const f = fixture(t); f.json({ rpid_str: '1234' }); f.json({ root: null });
  await f.client.interact(COMMENT, { cookie: COOKIE });
  const fields = new URLSearchParams(f.calls[0].options.body);
  assert.equal(fields.get('message'), COMMENT.text); assert.equal(fields.has('at_name_to_mid'), false);
});

test('prototype-like owner names remain a single ordinary JSON key and UID values remain exact', async t => {
  const f = fixture(t);
  for (const name of ['__proto__', 'constructor', 'toString']) {
    f.json({ rpid_str: '1234' }); f.json({ root: null });
    await f.client.interact({ ...COMMENT, mentionOwner: { uid: String(Number.MAX_SAFE_INTEGER), name } }, { cookie: COOKIE });
    const fields = new URLSearchParams(f.calls.filter(call => call.options.method === 'POST').at(-1)!.options.body), mapping = JSON.parse(fields.get('at_name_to_mid')!);
    assert.equal(fields.get('message'), '@' + name + ' ' + COMMENT.text);
    assert.deepEqual(Object.keys(mapping), [name]); assert.equal(Object.hasOwn(mapping, name), true);
    assert.equal(mapping[name], Number.MAX_SAFE_INTEGER); assert.equal(typeof mapping[name], 'number');
    assert.equal(Object.getPrototypeOf(mapping), Object.prototype);
  }
});

test('raw mentions including an apparent owner prefix cannot bypass the single permitted target', async t => {
  const f = fixture(t);
  for (const text of ['@其他人 内容', '@合成主人 内容', '@合成主人Suffix 内容', '@合成主人 内容 @其他人',
    '正文\n@其他人', '正文@其他人', 'mail@example.test', '@', '@@合成主人']) {
    for (const mentionOwner of [undefined, OWNER])
      await assert.rejects(f.client.interact({ ...COMMENT, text, mentionOwner }, { cookie: COOKIE }), errorCode('mention_invalid'));
  }
  assert.equal(f.calls.length + f.preparation.length, 0);
});

test('only comments and replies accept an internally supplied owner and extra at fields are rejected', async t => {
  const f = fixture(t);
  for (const action of ['like', 'favorite', 'follow'] as const)
    await assert.rejects(f.client.interact({ ...COMMENT, action, folderId: '999', mentionOwner: OWNER }, { cookie: COOKIE }), errorCode('invalid_input'));
  for (const field of ['at_name_to_mid', 'atNameToMid', 'at_uid', 'mentionOwners', 'ownerUid', 'ownerName', 'mentionedUsers'])
    await assert.rejects(f.client.interact({ ...COMMENT, mentionOwner: OWNER, [field]: { 其他人: 789 } } as any, { cookie: COOKIE }), errorCode('invalid_input'));
  for (const mentionOwner of [null, {}, { uid: '789', name: '@其他人' }, { uid: '9007199254740992', name: OWNER.name },
    { uid: 456, name: OWNER.name }, { uid: '456 ', name: OWNER.name }])
    await assert.rejects(f.client.interact({ ...COMMENT, mentionOwner } as any, { cookie: COOKIE }), errorCode('malformed_response'));
  assert.equal(f.calls.length + f.preparation.length, 0);
});

test('the 1000-character limit includes the generated prefix and preserves Unicode code points', async t => {
  const f = fixture(t), owner = { uid: OWNER.uid, name: '合成😀' }, prefix = '@' + owner.name + ' ';
  const text = '😀'.repeat(1000 - [...prefix].length);
  f.json({ rpid_str: '1234' }); f.json({ root: null }); await f.client.interact({ ...COMMENT, text, mentionOwner: owner }, { cookie: COOKIE });
  const message = new URLSearchParams(f.calls[0].options.body).get('message')!;
  assert.equal(message, prefix + text); assert.equal([...message].length, 1000);
  await assert.rejects(f.client.interact({ ...COMMENT, text: text + '字', mentionOwner: owner }, { cookie: COOKIE }), errorCode('invalid_input'));
  assert.equal(f.calls.length, 2); assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1);
});

test('ambiguous owner-mention submissions and platform rejections never retry automatically', async t => {
  const f = fixture(t), input = { ...COMMENT, mentionOwner: OWNER };
  const uncertain: (Partial<TransportResponse> | Error)[] = [new TransportError('timeout', true),
    { body: Buffer.from('<html>synthetic unknown response</html>') },
    { body: Buffer.from(JSON.stringify({ code: 0, data: {} })) },
    { body: Buffer.from(JSON.stringify({ code: 0, data: { rpid: Number.MAX_SAFE_INTEGER + 1 } })) }];
  for (const response of uncertain) {
    f.queue.push(response);
    const count = f.calls.length;
    await assert.rejects(f.client.interact(input, { cookie: COOKIE }), errorCode('uncertain'));
    assert.equal(f.calls.length, count + 1);
  }
  f.queue.push(new TransportError('unsafe_url', false));
  await assert.rejects(f.client.interact(input, { cookie: COOKIE }), errorCode('unsafe_url'));
  f.json({}, -352); await assert.rejects(f.client.interact(input, { cookie: COOKIE }), errorCode('access_blocked'));
  assert.equal(f.calls.length, uncertain.length + 2);
  assert.ok(f.calls.every(call => call.options.method === 'POST'));
  assert.deepEqual(f.preparation, ['/x/web-frontend/getbuvid', '/x/web-interface/nav']);
});
