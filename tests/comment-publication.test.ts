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

const CSRF = '0123456789abcdef0123456789abcdef';
const COOKIE = 'SESSDATA=synthetic-comment-session; bili_jct=' + CSRF;
const ID = '9007199254740993123', BV = 'BV1xx411c7mD';
const INPUT = { action: 'comment' as const, aid: 111, mid: 222, bvid: BV, text: '合成测试正文', mentionOwner: { uid: '456', name: '合成主人' } };
const unknown = { visibility: 'unknown', checkedAnonymously: false, notification: 'unverified' };
const row = (fields: Record<string, unknown> = {}) => ({ type: 1, oid: 111, rpid_str: ID, root: 0, parent: 0, state: 0, invisible: false,
  member: { mid: 123, uname: '合成发送者' }, content: { message: '@合成主人 合成测试正文' }, like: 0, ...fields });
const reply = (data: unknown, code = 0): Partial<TransportResponse> => ({ body: Buffer.from(JSON.stringify({ code, data })) });
function fixture(t: { after: (fn: () => Promise<void>) => void }, plan: (Partial<TransportResponse> | Error)[], onRequest?: (index: number) => void) {
  const calls: { url: string; options: TransportOptions }[] = [];
  const client = new BiliClient({ transport: { async request(url, options) {
    calls.push({ url, options }); onRequest?.(calls.length);
    const next = plan.shift(); assert.ok(next, 'missing synthetic response');
    if (next instanceof Error) throw next;
    return { status: 200, headers: {}, body: Buffer.from('{}'), url, ...next };
  }, dispose() {} } });
  t.after(() => client.dispose()); return { client, calls };
}

test('comment submission uses its trusted video page and verifies public visibility anonymously in the same call', async t => {
  const f = fixture(t, [reply({ reply: { rpid_str: ID, state: 0, invisible: false } }), reply({ root: row() })]);
  const result = await f.client.interact(INPUT, { cookie: COOKIE, timeoutMs: 20000 });
  assert.equal(result.state, 'confirmed'); assert.equal(result.platformId, ID);
  assert.deepEqual(result.comment, { visibility: 'public', state: 0, checkedAnonymously: true, notification: 'unverified' });
  assert.equal(f.calls.length, 2);
  const post = f.calls[0], get = f.calls[1], form = new URLSearchParams(post.options.body);
  assert.equal(post.options.method, 'POST'); assert.equal(post.options.headers?.Referer, 'https://www.bilibili.com/video/' + BV + '/');
  assert.equal(post.options.headers?.Origin, 'https://www.bilibili.com');
  const postHeaders = Object.fromEntries(Object.entries(post.options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  assert.equal(postHeaders['x-csrf-token'], CSRF); assert.equal(form.get('csrf'), CSRF);
  assert.equal(form.get('gaia_source'), 'main_web'); assert.deepEqual(JSON.parse(form.get('statistics')!), { appId: 100, platform: 5 });
  assert.equal(form.get('message'), '@合成主人 ' + INPUT.text); assert.deepEqual(JSON.parse(form.get('at_name_to_mid')!), { 合成主人: 456 });
  const url = new URL(get.url);
  assert.equal(get.options.method ?? 'GET', 'GET'); assert.equal(url.origin, 'https://api.bilibili.com'); assert.equal(url.pathname, '/x/v2/reply/detail');
  assert.deepEqual(Object.fromEntries(url.searchParams), { type: '1', oid: '111', root: ID });
  assert.ok(get.options.timeoutMs <= 5000); assert.equal(get.options.body, undefined);
  const getHeaders = Object.fromEntries(Object.entries(get.options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  assert.equal(getHeaders.cookie, undefined); assert.equal(getHeaders['x-csrf-token'], undefined);
});

test('replies retain root and parent targets while legacy direct callers use the numeric video page', async t => {
  const f = fixture(t, [reply({ rpid_str: ID }), reply({ root: row({ root_str: '789', parent_str: '790', root: 789, parent: 790 }) })]);
  const { bvid: _bvid, ...input } = INPUT;
  const result = await f.client.interact({ ...input, action: 'reply', root: '789', parent: '790' }, { cookie: COOKIE });
  assert.equal(result.comment?.visibility, 'public');
  assert.equal(f.calls[0].options.headers?.Referer, 'https://www.bilibili.com/video/av111/');
  const form = new URLSearchParams(f.calls[0].options.body); assert.equal(form.get('root'), '789'); assert.equal(form.get('parent'), '790');
});

test('platform acceptance and a normal sender-side state alone never prove public visibility or notification', async t => {
  for (const data of [{ rpid_str: ID }, { reply: { rpid_str: ID, state: 0, invisible: false } }]) {
    const f = fixture(t, [reply(data), new TransportError('timeout', false)]);
    const result = await f.client.interact(INPUT, { cookie: COOKIE });
    assert.equal(result.state, 'confirmed'); assert.equal(result.platformId, ID);
    assert.equal(result.comment?.visibility, 'unknown'); assert.equal(result.comment?.checkedAnonymously, false);
    assert.equal(result.comment?.notification, 'unverified'); assert.equal(f.calls.length, 2);
    assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1);
  }
});

test('explicit anonymous absence or a hidden response reports current non-public status without resending', async t => {
  for (const response of [reply({}, 12006), reply({ root: null }), reply({ root: row({ state: 17 }) }), reply({ root: row({ invisible: true }) })]) {
    const f = fixture(t, [reply({ rpid_str: ID }), response]);
    const result = await f.client.interact(INPUT, { cookie: COOKIE });
    assert.equal(result.state, 'confirmed'); assert.equal(result.platformId, ID);
    assert.equal(result.comment?.visibility, 'not_public'); assert.equal(result.comment?.checkedAnonymously, true);
    assert.equal(result.comment?.notification, 'unverified'); assert.equal(f.calls.length, 2);
    assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1);
  }
});

test('known hidden submission evidence survives readback errors while public anonymous evidence can supersede it', async t => {
  const hidden = { reply: { rpid_str: ID, state: 17, invisible: false } };
  const failed = fixture(t, [reply(hidden), reply({}, -352)]);
  const result = await failed.client.interact(INPUT, { cookie: COOKIE });
  assert.deepEqual(result.comment, { visibility: 'not_public', state: 17, checkedAnonymously: false, notification: 'unverified' });
  assert.equal(result.state, 'confirmed'); assert.equal(failed.calls.length, 2);
  const published = fixture(t, [reply(hidden), reply({ root: row() })]);
  assert.equal((await published.client.interact(INPUT, { cookie: COOKIE })).comment?.visibility, 'public');
});

test('malformed or mismatched anonymous rows cannot establish visibility for the accepted comment', async t => {
  const rows = [row({ rpid_str: '9007199254740993124' }), row({ oid: 112 }), row({ type: 17 }), row({ state: '0' }), row({ invisible: 'false' }),
    row({ root: 789, parent: 790 }), row({ rpid: 1234 }), row({ oid_str: '112' }), row({ state: undefined }), row({ invisible: undefined })];
  for (const root of rows) {
    const f = fixture(t, [reply({ rpid_str: ID }), reply({ root })]);
    const result = await f.client.interact(INPUT, { cookie: COOKIE });
    assert.equal(result.state, 'confirmed'); assert.equal(result.platformId, ID);
    assert.deepEqual(result.comment, unknown); assert.equal(f.calls.length, 2);
  }
  const f = fixture(t, [reply({ rpid_str: ID }), reply({ root: row({ root: 789, parent: 791 }) })]);
  assert.deepEqual((await f.client.interact({ ...INPUT, action: 'reply', root: '789', parent: '790' }, { cookie: COOKIE })).comment, unknown);
});

test('readback transport errors, access restrictions, and invalid JSON preserve the accepted receipt', async t => {
  for (const response of [new TransportError('network_error', false), { status: 403 }, { status: 500 }, reply({}, -101), reply({}, -352),
    reply({}, -404), { body: Buffer.from('<html>synthetic-private-response</html>') }, reply({})]) {
    const f = fixture(t, [reply({ rpid_str: ID }), response]);
    const result = await f.client.interact(INPUT, { cookie: COOKIE });
    assert.deepEqual(result, { state: 'confirmed', platformId: ID, comment: unknown }); assert.equal(f.calls.length, 2);
    assert.equal(JSON.stringify(result).includes('synthetic-private-response'), false);
  }
});

test('cancellation or account changes after acceptance prevent another request and retain the receipt', async t => {
  for (const mode of ['cancel', 'identity'] as const) {
    const controller = new AbortController(); let changed = false;
    const f = fixture(t, [reply({ rpid_str: ID })], () => { if (mode === 'cancel') controller.abort('SYNTHETIC_PRIVATE_REASON'); else changed = true; });
    const result = await f.client.interact(INPUT, { cookie: COOKIE, signal: controller.signal,
      assertCurrent() { if (changed) throw new BiliError('account_changed'); } });
    assert.deepEqual(result, { state: 'confirmed', platformId: ID, comment: unknown }); assert.equal(f.calls.length, 1);
  }
});

test('a changed account during readback cannot upgrade visibility using a stale response', async t => {
  let changed = false;
  const f = fixture(t, [reply({ rpid_str: ID }), reply({ root: row() })], index => { if (index === 2) changed = true; });
  const result = await f.client.interact(INPUT, { cookie: COOKIE, assertCurrent() { if (changed) throw new BiliError('account_changed'); } });
  assert.deepEqual(result, { state: 'confirmed', platformId: ID, comment: unknown }); assert.equal(f.calls.length, 2);
});

test('invalid trusted video IDs fail before any request and unrelated interactions retain their old request shape', async t => {
  const invalid = fixture(t, []);
  for (const bvid of ['', '../other', 'https://other.example', 'BV1xx411c7mD?x=1', 'BV1xx411c7mD\r\nX: y'])
    await assert.rejects(invalid.client.interact({ ...INPUT, bvid }, { cookie: COOKIE }), error => error instanceof BiliError && error.code === 'invalid_input');
  assert.equal(invalid.calls.length, 0);
  const f = fixture(t, [reply({}), reply({}), reply({})]);
  for (const action of ['like', 'favorite', 'follow'] as const) {
    const result = await f.client.interact({ action, aid: 111, mid: 222, folderId: '333' }, { cookie: COOKIE });
    assert.deepEqual(result, { state: 'confirmed' });
    const headers = Object.fromEntries(Object.entries(f.calls.at(-1)!.options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    assert.equal(headers.origin, undefined); assert.equal(headers['x-csrf-token'], undefined);
  }
  assert.equal(f.calls.length, 3);
});


test('mismatched submission metadata cannot label the accepted comment hidden when anonymous verification fails', async t => {
  for (const metadata of [{ rpid_str: '9007199254740993124', state: 17 }, { rpid_str: ID, state: 17, oid: 112 },
    { rpid_str: ID, state: 17, type: 17 }, { rpid_str: ID, state: '17' }, { rpid_str: ID, state: -1 },
    { rpid_str: ID, invisible: 'true' }, { rpid_str: ID, state: 17, rpid: 1234 }]) {
    const f = fixture(t, [reply({ rpid_str: ID, reply: metadata }), new TransportError('timeout', false)]);
    const result = await f.client.interact(INPUT, { cookie: COOKIE });
    assert.deepEqual(result, { state: 'confirmed', platformId: ID, comment: unknown }); assert.equal(f.calls.length, 2);
  }
  const hidden = fixture(t, [reply({ reply: { rpid_str: ID, invisible: true } }), new TransportError('timeout', false)]);
  assert.deepEqual((await hidden.client.interact(INPUT, { cookie: COOKIE })).comment,
    { visibility: 'not_public', checkedAnonymously: false, notification: 'unverified' });
});
