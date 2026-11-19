/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BiliClient } from '../src/client.ts';
import { BiliError } from '../src/errors.ts';
import { TransportError } from '../src/transport.ts';
import type { BiliClientOptions } from '../src/client.ts';
import type { TransportOptions, TransportResponse } from '../src/transport.ts';
import type { RequestDiagnostic } from '../src/diagnostics.ts';

const CSRF = '0123456789abcdef0123456789abcdef';
const COOKIE = 'SESSDATA=synthetic-comment-session; bili_jct=' + CSRF;
const DEVICE = 'SYNTHETIC_COMMENT_DEVICE';
const ID = '9007199254740993123', BV = 'BV1xx411c7mD';
const INPUT = { action: 'comment' as const, aid: 111, mid: 222, bvid: BV, text: '合成测试正文', mentionOwner: { uid: '456', name: '合成主人' } };
const row = (fields: Record<string, unknown> = {}) => ({ type: 1, oid: 111, rpid_str: ID, root: 0, parent: 0, state: 0, invisible: false, ...fields });
const reply = (data: unknown, code = 0): Partial<TransportResponse> => ({ body: Buffer.from(JSON.stringify({ code, data })) });
const IMAGES = { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' };
function fixture(t: { after: (fn: () => Promise<void>) => void }, plan: (Partial<TransportResponse> | Error)[], onRequest?: (index: number) => void, extras: BiliClientOptions = {}) {
  const calls: { url: string; options: TransportOptions }[] = [], preparation: string[] = [], events: RequestDiagnostic[] = [], waits: number[] = [];
  let clock = 1700000000000;
  const client = new BiliClient({ publicationNow: () => clock, publicationSleep: async ms => { waits.push(ms); clock += ms; },
    onDiagnostic: event => { events.push(event); }, ...extras, transport: { async request(url, options) {
      const path = new URL(url).pathname;
      if (path === '/x/web-frontend/getbuvid' || path === '/x/web-interface/nav') {
        preparation.push(path);
        const data = path.endsWith('getbuvid') ? { buvid: DEVICE } : { wbi_img: IMAGES };
        return { status: 200, headers: {}, url, body: reply(data).body! };
      }
      calls.push({ url, options }); onRequest?.(calls.length);
      const next = plan.shift(); assert.ok(next, 'missing synthetic response');
      if (next instanceof Error) throw next;
      return { status: 200, headers: {}, body: Buffer.from('{}'), url, ...next };
    }, dispose() {} } });
  t.after(() => client.dispose()); return { client, calls, preparation, events, waits };
}

test('signed comment preserves owner mapping and verifies strict anonymous visibility in its original call', async t => {
  const f = fixture(t, [reply({ reply: { rpid_str: ID, state: 0, invisible: false } }), reply({ root: row() })]);
  const result = await f.client.interact(INPUT, { cookie: COOKIE });
  assert.equal(result.state, 'confirmed'); assert.equal(result.platformId, ID);
  assert.deepEqual(result.comment, { visibility: 'public', state: 0, postState: 0, postInvisible: false, checkedAnonymously: true, notification: 'unverified',
    attempts: 1, checkedAt: '2023-11-14T22:13:20.000Z', evidence: [{ audience: 'anonymous', outcome: 'public', state: 0, httpStatus: 200, apiCode: 0 }] });
  assert.deepEqual(f.preparation, ['/x/web-frontend/getbuvid', '/x/web-interface/nav']); assert.equal(f.calls.length, 2);
  const post = f.calls[0], get = f.calls[1], form = new URLSearchParams(post.options.body), signed = new URL(post.url);
  assert.equal(post.options.method, 'POST'); assert.equal(post.options.headers?.Referer, 'https://www.bilibili.com/video/' + BV + '/');
  assert.equal(post.options.headers?.Origin, 'https://www.bilibili.com'); assert.equal(post.options.headers?.['x-csrf-token'], CSRF);
  assert.equal(post.options.headers?.Cookie, COOKIE + '; buvid3=' + DEVICE); assert.match(post.options.headers?.['User-Agent'] ?? '', /Chrome\/131/);
  assert.deepEqual([...signed.searchParams.keys()].sort(), ['w_rid', 'wts']); assert.match(signed.searchParams.get('w_rid')!, /^[a-f0-9]{32}$/);
  assert.equal(form.get('csrf'), CSRF); assert.equal(form.get('gaia_source'), 'main_web'); assert.deepEqual(JSON.parse(form.get('statistics')!), { appId: 100, platform: 5 });
  assert.equal(form.get('message'), '@合成主人 ' + INPUT.text); assert.deepEqual(JSON.parse(form.get('at_name_to_mid')!), { 合成主人: 456 });
  const url = new URL(get.url); assert.equal(url.pathname, '/x/v2/reply/detail');
  assert.deepEqual(Object.fromEntries(url.searchParams), { type: '1', oid: '111', root: ID });
  assert.ok(get.options.timeoutMs <= 5000); assert.equal(get.options.body, undefined); assert.equal(get.options.headers?.Cookie, undefined);
  assert.equal(get.options.headers?.['x-csrf-token'], undefined); assert.equal(f.waits.length, 0);
});

test('reply root and parent remain exact and legacy callers use the numeric video page', async t => {
  const f = fixture(t, [reply({ rpid_str: ID }), reply({ root: row({ root_str: '789', parent_str: '790', root: 789, parent: 790 }) })]);
  const { bvid: _bvid, ...input } = INPUT;
  const result = await f.client.interact({ ...input, action: 'reply', root: '789', parent: '790' }, { cookie: COOKIE });
  assert.equal(result.comment?.visibility, 'public'); assert.equal(f.calls[0].options.headers?.Referer, 'https://www.bilibili.com/video/av111/');
  const form = new URLSearchParams(f.calls[0].options.body); assert.equal(form.get('root'), '789'); assert.equal(form.get('parent'), '790');
});

test('an initial absent or hidden comment can become public after one bounded wait without another submission', async t => {
  for (const first of [reply({}, 12006), reply({ root: null }), reply({ root: row({ state: 17 }) }), reply({ root: row({ invisible: true }) })]) {
    const f = fixture(t, [reply({ rpid_str: ID }), first, reply({ root: row() })]);
    const result = await f.client.interact(INPUT, { cookie: COOKIE });
    assert.equal(result.comment?.visibility, 'public'); assert.equal(result.comment?.attempts, 2); assert.equal(result.comment?.state, 0);
    assert.equal(result.comment?.checkedAt, '2023-11-14T22:13:27.500Z'); assert.deepEqual(f.waits, [7500]);
    assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1); assert.equal(f.calls.length, 3);
  }
});

test('two anonymous absences use an account comparison and remain unknown even if only the account can read it', async t => {
  for (const own of [reply({}, 12006), reply({ root: row() })]) {
    const f = fixture(t, [reply({ reply: { rpid_str: ID, state: 0 } }), reply({}, 12006), reply({ root: null }), own]);
    const result = await f.client.interact(INPUT, { cookie: COOKIE });
    assert.equal(result.state, 'confirmed'); assert.equal(result.comment?.visibility, 'unknown'); assert.equal(result.comment?.postState, 0);
    assert.equal(result.comment?.attempts, 2); assert.equal(result.comment?.evidence?.length, 3); assert.equal(result.comment?.checkedAnonymously, true);
    assert.equal(f.calls.at(-1)!.options.headers?.Cookie, COOKIE + '; buvid3=' + DEVICE);
    assert.equal(result.comment?.evidence?.at(-1)?.audience, 'account');
    assert.equal(result.comment?.evidence?.at(-1)?.outcome, own.body!.toString().includes('12006') ? 'not_found' : 'account_visible');
    assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1);
  }
});

test('strict hidden read evidence remains non-public while submission state stays separately labelled', async t => {
  const f = fixture(t, [reply({ reply: { rpid_str: ID, state: 17, invisible: true } }), reply({ root: row({ state: 17 }) }), reply({ root: row({ state: 17 }) })]);
  const result = await f.client.interact(INPUT, { cookie: COOKIE });
  assert.equal(result.comment?.visibility, 'not_public'); assert.equal(result.comment?.postState, 17); assert.equal(result.comment?.postInvisible, true);
  assert.equal(result.comment?.state, 17); assert.equal(result.comment?.attempts, 2); assert.equal(f.calls.length, 3);
  const failed = fixture(t, [reply({ reply: { rpid_str: ID, state: 17, invisible: true } }), new TransportError('timeout', false)]);
  const unknown = await failed.client.interact(INPUT, { cookie: COOKIE });
  assert.equal(unknown.comment?.visibility, 'unknown'); assert.equal(unknown.comment?.state, undefined); assert.equal(unknown.comment?.postState, 17);
});

test('mismatched or incomplete read rows never establish visibility and are not repeatedly polled', async t => {
  for (const root of [row({ rpid_str: '9007199254740993124' }), row({ oid: 112 }), row({ type: 17 }), row({ state: '0' }), row({ invisible: 'false' }),
    row({ root: 789, parent: 790 }), row({ rpid: 1234 }), row({ oid_str: '112' }), row({ state: undefined }), row({ invisible: undefined })]) {
    const f = fixture(t, [reply({ rpid_str: ID }), reply({ root })]);
    const result = await f.client.interact(INPUT, { cookie: COOKIE });
    assert.equal(result.comment?.visibility, 'unknown'); assert.equal(result.comment?.checkedAnonymously, false); assert.equal(f.calls.length, 2);
    assert.ok(['invalid_response', 'identity_mismatch'].includes(result.comment!.evidence![0].outcome)); assert.equal(f.waits.length, 0);
  }
  const f = fixture(t, [reply({ rpid_str: ID }), reply({ root: row({ root: 789, parent: 791 }) })]);
  assert.equal((await f.client.interact({ ...INPUT, action: 'reply', root: '789', parent: '790' }, { cookie: COOKIE })).comment?.visibility, 'unknown');
});

test('network errors, restrictions and invalid envelopes retain acceptance with enum-only evidence and no retries', async t => {
  for (const response of [new TransportError('network_error', false), { status: 403 }, { status: 500 }, reply({}, -101), reply({}, -352), reply({}, -404),
    { body: Buffer.from('<html>synthetic-private-response</html>') }, reply({})]) {
    const f = fixture(t, [reply({ rpid_str: ID }), response]);
    const result = await f.client.interact(INPUT, { cookie: COOKIE });
    assert.equal(result.state, 'confirmed'); assert.equal(result.comment?.visibility, 'unknown'); assert.equal(f.calls.length, 2);
    assert.equal(JSON.stringify(result).includes('synthetic-private-response'), false); assert.equal(f.waits.length, 0);
  }
});

test('cancellation or account changes after acceptance cannot trigger reads or replace the accepted receipt', async t => {
  for (const mode of ['cancel', 'identity'] as const) {
    const controller = new AbortController(); let changed = false;
    const f = fixture(t, [reply({ rpid_str: ID })], () => { if (mode === 'cancel') controller.abort('SYNTHETIC_PRIVATE_REASON'); else changed = true; });
    const result = await f.client.interact(INPUT, { cookie: COOKIE, signal: controller.signal, assertCurrent() { if (changed) throw new BiliError('account_changed'); } });
    assert.equal(result.state, 'confirmed'); assert.equal(result.platformId, ID); assert.equal(result.comment?.visibility, 'unknown');
    assert.equal(result.comment?.attempts, 0); assert.equal(f.calls.length, 1);
  }
});

test('account changes during a read cannot upgrade visibility using a stale response', async t => {
  let changed = false;
  const f = fixture(t, [reply({ rpid_str: ID }), reply({ root: row() })], index => { if (index === 2) changed = true; });
  const result = await f.client.interact(INPUT, { cookie: COOKIE, assertCurrent() { if (changed) throw new BiliError('account_changed'); } });
  assert.equal(result.comment?.visibility, 'unknown'); assert.equal(result.comment?.evidence?.[0].outcome, 'account_changed'); assert.equal(f.calls.length, 2);
});

test('a read-only refresh neither prepares credentials nor submits a comment', async t => {
  const f = fixture(t, [reply({ root: row() })]);
  const result = await f.client.checkCommentPublication({ action: 'comment', aid: 111, bvid: BV }, ID, { cookie: COOKIE });
  assert.equal(result.visibility, 'public'); assert.equal(result.postState, undefined); assert.equal(f.preparation.length, 0);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.method ?? 'GET', 'GET');
});

test('a cancelled bounded wait preserves acceptance and cannot dispatch the second read', async t => {
  const controller = new AbortController();
  const f = fixture(t, [reply({ rpid_str: ID }), reply({}, 12006)], undefined, { publicationSleep: async () => { controller.abort(); } });
  const result = await f.client.interact(INPUT, { cookie: COOKIE, signal: controller.signal });
  assert.equal(result.state, 'confirmed'); assert.equal(result.comment?.attempts, 1); assert.equal(f.calls.length, 2);
});

test('successful submission and checks produce correlatable diagnostics without raw text or credentials', async t => {
  const f = fixture(t, [reply({ reply: { rpid_str: ID, state: 0 }, private: 'SYNTHETIC_RESPONSE_SECRET' }), reply({ root: row() })]);
  await f.client.interact(INPUT, { cookie: COOKIE });
  assert.deepEqual(f.events.map(event => [event.stage, event.commentPhase, event.outcome]), [['comment', 'submission', 'accepted'], ['comment', 'visibility', 'public']]);
  assert.ok(f.events.every(event => event.targetAid === 111 && event.commentId === ID));
  const serialized = JSON.stringify(f.events);
  for (const secret of [COOKIE, CSRF, DEVICE, INPUT.text, INPUT.mentionOwner.name, 'w_rid', 'wts=', 'SYNTHETIC_RESPONSE_SECRET']) assert.equal(serialized.includes(secret), false);
});

test('invalid video inputs never prepare or submit and unrelated writes retain their request shape', async t => {
  const invalid = fixture(t, []);
  for (const bvid of ['', '../other', 'https://other.example', 'BV1xx411c7mD?x=1', 'BV1xx411c7mD\r\nX: y'])
    await assert.rejects(invalid.client.interact({ ...INPUT, bvid }, { cookie: COOKIE }), error => error instanceof BiliError && error.code === 'invalid_input');
  assert.equal(invalid.calls.length + invalid.preparation.length, 0);
  const f = fixture(t, [reply({}), reply({}), reply({})]);
  for (const action of ['like', 'favorite', 'follow'] as const) {
    assert.deepEqual(await f.client.interact({ action, aid: 111, mid: 222, folderId: '333' }, { cookie: COOKIE }), { state: 'confirmed' });
    assert.equal(f.calls.at(-1)!.options.headers?.Origin, undefined); assert.equal(f.calls.at(-1)!.options.headers?.['x-csrf-token'], undefined);
  }
  assert.equal(f.calls.length, 3); assert.equal(f.preparation.length, 0);
});

test('mismatched submission metadata cannot masquerade as read evidence', async t => {
  for (const metadata of [{ rpid_str: '9007199254740993124', state: 17 }, { rpid_str: ID, state: 17, oid: 112 }, { rpid_str: ID, state: 17, type: 17 },
    { rpid_str: ID, state: '17' }, { rpid_str: ID, state: -1 }, { rpid_str: ID, invisible: 'true' }, { rpid_str: ID, state: 17, rpid: 1234 }]) {
    const f = fixture(t, [reply({ rpid_str: ID, reply: metadata }), new TransportError('timeout', false)]);
    const result = await f.client.interact(INPUT, { cookie: COOKIE });
    assert.equal(result.comment?.visibility, 'unknown'); assert.equal(result.comment?.postState, undefined); assert.equal(result.comment?.state, undefined);
  }
});
