/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BiliRuntime, type RuntimeOptions } from '../src/runtime.ts';
import { AuthManager } from '../src/auth.ts';
import { BiliError } from '../src/errors.ts';
import { defaults } from '../src/config.ts';
import type { AccountState, BiliClientContract, VideoDetails } from '../src/types.ts';
const session = { id: 'synthetic-session', permission: 'full' as const };
const video: VideoDetails = { bvid: 'BV1xx411c7mD', aid: 123, cid: 456, title: 'SYNTHETIC_EXTERNAL_TITLE', description: 'SYNTHETIC_EXTERNAL_DESCRIPTION', duration: 120, owner: { mid: 789, name: 'Synthetic author' }, cover: 'https://i0.hdslb.com/synthetic.png', url: 'https://www.bilibili.com/video/BV1xx411c7mD', parts: [{ cid: 456, page: 1, title: 'Synthetic part', duration: 120 }] };
function fixture() {
  const controller = new AbortController(); let now = 1000000, config = structuredClone(defaults), account: AccountState | undefined;
  let calls = 0, saved: any = {}, behavior: () => Promise<any> = async () => ({ state: 'confirmed', platformId: '999' });
  const client = { video: async () => structuredClone(video), search: async () => ({ items: [video], hasMore: false }), feed: async () => ({ items: [video], hasMore: false }),
    comments: async () => ({ items: [{ rpid: '333', root: '0', text: 'SYNTHETIC_EXTERNAL_COMMENT', author: { mid: 23, name: 'Synthetic reader' }, likes: 0 }], hasMore: false }),
    subtitles: async () => ({ tracks: [], loginRequired: false }), media: async () => ({ bytes: Buffer.from('synthetic-media'), mime: 'video/mp4' }), account: async () => ({ mid: account?.mid ?? 1, name: 'Synthetic' }),
    interact: async () => { calls++; return behavior(); }, dispose() {} } as unknown as BiliClientContract;
  let saveHook = async () => {};
  const options: RuntimeOptions = { signal: controller.signal, transient: true, config: () => config, account: () => account, now: () => now, readLedger: async () => saved, saveLedger: async (value: unknown) => { await saveHook(); saved = structuredClone(value); } };
  const runtime = new BiliRuntime(client, { status: () => ({}), settings: () => ({ timeoutMs: 5000, concurrency: 2, hasProxy: false }), search: async () => ({}) }, options);
  return { runtime, options, client, controller, config, get saved() { return saved; }, get calls() { return calls; },
    login() { account = { cookie: 'SYNTHETIC_COOKIE', mid: 1, name: 'Synthetic', revision: 'revision-1' }; }, changeAccount() { account = { cookie: 'SYNTHETIC_NEW_COOKIE', mid: 2, name: 'Other', revision: 'revision-2' }; },
    advance() { now += 9999999; }, behavior(value: () => Promise<any>) { behavior = value; }, onSave(value: () => Promise<void>) { saveHook = value; } };
}
async function open(f: ReturnType<typeof fixture>) { const result: any = await f.runtime.read('open', { target: video.bvid }, session); assert.equal(result.content.status, 'ok'); return result.content.data.videoRef; }

test('danmaku is off without IO, bounded, paginated, transient and rechecked after disabling', async t => {
  const f = fixture(); t.after(() => f.runtime.dispose()); await f.runtime.initialize(); let reads = 0;
  f.client.danmaku = async () => { reads++; return { items: Array.from({ length: 101 }, (_, i) => ({ id: String(i + 1), atSeconds: 1, mode: 1, text: 'SYNTHETIC_DANMAKU_TEXT' })), truncated: false, excludedModes: 0, segments: [1] }; };
  assert.equal((await f.runtime.read('danmaku', {}, session) as any).content.error.code, 'danmaku_disabled'); assert.equal(reads, 0);
  const videoRef = await open(f); f.config.danmakuEnabled = true;
  for (const args of [{ toSeconds: 61 }, { fromSeconds: -1 }, { fromSeconds: '1' }, { part: 2 }, { toSeconds: 121 }])
    assert.equal((await f.runtime.read('danmaku', { videoRef, ...args }, session) as any).content.error.code, 'invalid_input');
  assert.equal(reads, 0);
  const result: any = await f.runtime.read('danmaku', { videoRef }, session);
  assert.equal(result.content.data.items.length, 100); assert.equal(result.content.data.nextOffset, 100); assert.equal(result.content.data.untrusted, true);
  assert.equal(JSON.stringify(result.receipt).includes('SYNTHETIC_DANMAKU'), false);
  const second: any = await f.runtime.read('danmaku', { videoRef, offset: 100 }, session); assert.equal(second.content.data.items.length, 1); assert.equal(second.content.data.hasMore, false);
  const original = f.client.danmaku; f.client.danmaku = async (...args) => { f.config.danmakuEnabled = false; return original(...args); };
  assert.equal((await f.runtime.read('danmaku', { videoRef }, session) as any).content.error.code, 'danmaku_disabled'); assert.equal(f.calls, 0);
});

function coinFixture() {
  const f = fixture(); f.login(); f.config.interactions.coin = true;
  f.client.video = async () => ({ ...structuredClone(video), copyright: 3 }); f.client.account = async () => ({ mid: 1, name: 'Synthetic', coins: 5 });
  let given = 0; const posts: number[] = [];
  f.client.coins = async () => given;
  f.client.interact = async input => { posts.push(input.coinCount!); given += input.coinCount!; return { state: 'confirmed' }; };
  return { ...f, posts, setGiven(value: number) { given = value; } };
}
test('coin is cumulative, adds only missing coins, binds duplicate operation ids and survives ledger reload', async t => {
  const f = coinFixture(); t.after(() => f.runtime.dispose()); await f.runtime.initialize(); const videoRef = await open(f);
  const experiences = new Set<string>(); f.options.recordAction = async (_session, eventId) => { experiences.add(eventId); };
  const call = (operationId: string, coinCount: number) => f.runtime.interact({ action: 'coin', videoRef, operationId, coinCount }, session) as Promise<any>;
  assert.equal((await call('first', 1)).content.data.spentCoins, 1);
  assert.equal((await call('second', 1)).content.data.duplicate, true);
  assert.equal((await call('second', 1)).content.data.duplicate, true); assert.equal(experiences.size, 1, 'alias retries cannot create a second experience');
  assert.equal((await call('second', 2)).content.error.code, 'invalid_input');
  assert.equal((await call('third', 2)).content.data.spentCoins, 1); assert.deepEqual(f.posts, [1, 1]);
  assert.equal((await call('third', 2)).content.data.spentCoins, 0);
  assert.equal((await call('third', 1)).content.error.code, 'invalid_input', 'an earlier matching fingerprint must not mask reuse of a bound operation id');
  const restarted = new BiliRuntime(f.client, { status: () => ({}), settings: () => ({ timeoutMs: 5000, concurrency: 2, hasProxy: false }), search: async () => ({}) }, f.options);
  t.after(() => restarted.dispose()); await restarted.initialize();
  const reopened: any = await restarted.read('open', { target: video.bvid }, session);
  const duplicate: any = await restarted.interact({ action: 'coin', videoRef: reopened.content.data.videoRef, coinCount: 2, operationId: 'restart' }, session);
  assert.equal(duplicate.content.data.duplicate, true); assert.deepEqual(f.posts, [1, 1]);
  assert.equal(experiences.size, 2, 'the two distinct actual coin submissions have exactly two event ids');
});

test('coin validates opt-in, self target, copyright limits and balance before spending; satisfied target records no action', async t => {
  for (const scenario of ['off', 'self', 'repost', 'balance', 'satisfied'] as const) {
    const f = coinFixture(); t.after(() => f.runtime.dispose()); await f.runtime.initialize();
    if (scenario === 'off') f.config.interactions.coin = false;
    if (scenario === 'self') f.client.video = async () => ({ ...video, copyright: 1, owner: { mid: 1, name: 'Synthetic' } });
    if (scenario === 'repost') f.client.video = async () => ({ ...video, copyright: 2 });
    if (scenario === 'balance') f.client.account = async () => ({ mid: 1, name: 'Synthetic', coins: 0.5 });
    if (scenario === 'satisfied') f.setGiven(2);
    let records = 0; f.options.recordAction = async () => { records++; };
    const result: any = await f.runtime.interact({ action: 'coin', videoRef: await open(f), coinCount: 2, operationId: 'test' }, session);
    if (scenario === 'satisfied') { assert.equal(result.content.data.alreadySatisfied, true); assert.equal(result.content.data.spentCoins, 0); }
    else assert.equal(result.content.error.code, { off: 'interaction_disabled', self: 'coin_self', repost: 'coin_limit', balance: 'coin_balance' }[scenario]);
    assert.deepEqual(f.posts, []); assert.equal(records, 0);
  }
});

test('uncertain coin submission blocks changed targets and new ids; disabling before dispatch sends nothing', async t => {
  const f = coinFixture(); t.after(() => f.runtime.dispose()); await f.runtime.initialize(); const videoRef = await open(f);
  let posts = 0; f.client.interact = async () => { posts++; throw new BiliError('uncertain'); };
  const run = (operationId: string, coinCount: number) => f.runtime.interact({ action: 'coin', videoRef, operationId, coinCount }, session) as Promise<any>;
  assert.equal((await run('first', 1)).content.state, 'uncertain');
  assert.equal((await run('second', 2)).content.state, 'uncertain');
  assert.equal((await run('third', 1)).content.data.state, 'uncertain'); assert.equal(posts, 1);
  const g = coinFixture(); t.after(() => g.runtime.dispose()); await g.runtime.initialize(); const ref = await open(g);
  g.client.coins = async () => { g.config.interactions.coin = false; return 0; };
  assert.equal((await g.runtime.interact({ action: 'coin', videoRef: ref, operationId: 'disabled' }, session) as any).content.error.code, 'interaction_disabled'); assert.deepEqual(g.posts, []);
});

test('message center requires login and validates source before IO; reading does not enable interactions', async t => {
  const f = fixture(); t.after(() => f.runtime.dispose()); await f.runtime.initialize();
  let reads = 0;
  f.client.notifications = async (source, cursor, options) => {
    reads++; assert.equal(options.cookie, 'SYNTHETIC_COOKIE'); assert.equal(cursor, undefined);
    return { items: [{ id: '101', actors: [{ mid: 23, name: 'SYNTHETIC_NOTIFICATION_ACTOR' }], time: 1234,
      type: 'reply', business: 'comment', title: 'SYNTHETIC_NOTIFICATION_TITLE', text: 'SYNTHETIC_NOTIFICATION_TEXT', originalText: 'SYNTHETIC_ORIGINAL_TEXT',
      ...(source === 'likes' ? { likeCount: 3 } : {}) }], hasMore: false };
  };
  assert.equal((await f.runtime.read('notifications', { source: 'replies' }, session) as any).content.error.code, 'login_required');
  f.login();
  assert.equal((await f.runtime.read('notifications', { source: 'system' }, session) as any).content.error.code, 'invalid_input');
  assert.equal((await f.runtime.read('notifications', { source: 'replies', cursor: { id: '101', time: 1234 } }, session) as any).content.error.code, 'invalid_input');
  assert.equal(reads, 0);
  for (const source of ['replies', 'likes']) {
    const result: any = await f.runtime.read('notifications', { source }, session);
    assert.equal(result.content.status, 'ok'); assert.equal(result.content.data.source, source);
    assert.equal(result.content.data.untrusted, true); assert.equal(result.content.data.items[0].actors[0].mid, 23);
    assert.ok(JSON.stringify(result.content).includes('SYNTHETIC_NOTIFICATION_TEXT'));
    assert.ok(!JSON.stringify(result.receipt).includes('SYNTHETIC')); assert.ok(!JSON.stringify(result).includes('SYNTHETIC_COOKIE'));
    assert.equal(result.content.data.cursor, undefined);
  }
  assert.equal(reads, 2); assert.equal(f.calls, 0); assert.deepEqual(f.config, defaults); assert.deepEqual(f.saved, {});
});

test('notification paging uses opaque references bound to source, session, account and expiry', async t => {
  const f = fixture(); t.after(() => f.runtime.dispose()); f.login(); await f.runtime.initialize();
  let reads = 0;
  f.client.notifications = async (_source, cursor) => {
    reads++;
    if (cursor) { assert.deepEqual(cursor, { id: '101', time: 1234 }); return { items: [], hasMore: false }; }
    return { items: [], hasMore: true, cursor: { id: '101', time: 1234 } };
  };
  const first: any = await f.runtime.read('notifications', { source: 'replies' }, session), cursor = first.content.data.cursor;
  assert.match(cursor, /^bili_page_/); assert.ok(!JSON.stringify(first).includes('1234')); assert.ok(!JSON.stringify(first.receipt).includes(cursor));
  for (const [args, caller] of [
    [{ source: 'likes', cursor }, session],
    [{ source: 'replies', cursor, sessionId: session.id }, { ...session, id: 'other' }],
    [{ source: 'replies', cursor: '101' }, session],
  ] as const) assert.equal((await f.runtime.read('notifications', args, caller) as any).content.error.code, 'reference_unavailable');
  assert.equal(reads, 1);
  const second: any = await f.runtime.read('notifications', { source: 'replies', cursor }, session);
  assert.equal(second.content.status, 'ok'); assert.equal(second.content.data.hasMore, false); assert.equal(second.content.data.cursor, undefined);
  f.changeAccount();
  assert.equal((await f.runtime.read('notifications', { source: 'replies', cursor }, session) as any).content.error.code, 'reference_unavailable');
  const fresh = (await f.runtime.read('notifications', { source: 'replies' }, session) as any).content.data.cursor;
  f.advance();
  assert.equal((await f.runtime.read('notifications', { source: 'replies', cursor: fresh }, session) as any).content.error.code, 'reference_unavailable');
  assert.equal(reads, 3);
});

test('cancelled and account-changed notification results cannot disclose late external content', async t => {
  for (const change of ['cancel', 'account'] as const) {
    const f = fixture(); t.after(() => f.runtime.dispose()); f.login(); await f.runtime.initialize();
    const caller = new AbortController();
    f.client.notifications = async () => {
      if (change === 'cancel') caller.abort(); else f.changeAccount();
      return { items: [{ id: '101', actors: [], time: 1234, type: 'reply', business: 'comment', title: '', text: 'LATE_PRIVATE_NOTIFICATION', originalText: '' }], hasMore: true, cursor: { id: '101', time: 1234 } };
    };
    const result: any = await f.runtime.read('notifications', { source: 'replies' }, { ...session, signal: caller.signal });
    assert.equal(result.content.error.code, change === 'cancel' ? 'cancelled' : 'account_changed');
    assert.ok(!JSON.stringify(result).includes('LATE_PRIVATE_NOTIFICATION'));
  }
});

test('notification cursors share the bounded reference budget and are cleared on dispose', async t => {
  const f = fixture(); t.after(() => f.runtime.dispose()); f.login(); await f.runtime.initialize();
  f.client.notifications = async () => ({ items: [], hasMore: true, cursor: { id: '101', time: 1234 } });
  for (let i = 0; i < 127; i++) await open(f);
  const first: any = await f.runtime.read('notifications', { source: 'likes' }, session);
  assert.equal(first.content.status, 'ok');
  assert.equal((await f.runtime.read('notifications', { source: 'likes' }, session) as any).content.error.code, 'busy');
  assert.equal((await f.runtime.read('open', { target: video.bvid }, session) as any).content.error.code, 'busy');
  f.advance();
  assert.equal((await f.runtime.read('notifications', { source: 'likes' }, session) as any).content.status, 'ok');
  await f.runtime.dispose();
  assert.equal((await f.runtime.read('notifications', { source: 'likes', cursor: first.content.data.cursor }, session) as any).content.error.code, 'stopped');
});

test('references bind to trusted session, expiry and account generation; receipts omit external data', async () => {
  const f = fixture(); await f.runtime.initialize(); const ref = await open(f);
  const cross: any = await f.runtime.read('comments', { videoRef: ref, sessionId: session.id }, { ...session, id: 'other' });
  assert.equal(cross.content.error.code, 'reference_unavailable');
  const comments: any = await f.runtime.read('comments', { videoRef: ref }, session);
  assert.match(JSON.stringify(comments.content), /SYNTHETIC_EXTERNAL_COMMENT/); assert.ok(!JSON.stringify(comments.receipt).includes('SYNTHETIC'));
  f.advance(); assert.equal((await f.runtime.read('comments', { videoRef: ref }, session) as any).content.error.code, 'reference_unavailable');
  const ref2 = await open(f); f.login(); assert.equal((await f.runtime.read('comments', { videoRef: ref2 }, session) as any).content.error.code, 'reference_unavailable');
  await f.runtime.dispose();
});
test('auth account revision prevents anonymous references reviving after an unused login and logout cycle', async t => {
  const f = fixture(); let auth: AuthManager, stored: unknown = {};
  t.after(async () => { await auth?.dispose(); await f.runtime.dispose(); });
  auth = new AuthManager(f.client, { read: async () => stored, save: async value => { stored = structuredClone(value); } }, f.controller.signal);
  f.options.account = () => auth.snapshot(); f.options.accountRevision = () => auth.state().revision;
  await auth.ready; await f.runtime.initialize();
  const initialRevision = auth.state().revision, ref = await open(f);
  assert.equal((await f.runtime.read('comments', { videoRef: ref }, session) as any).content.status, 'ok');
  assert.equal((await f.runtime.read('comments', { videoRef: ref }, session) as any).content.status, 'ok');
  assert.equal(auth.state().revision, initialRevision);

  // Do not invoke the runtime between these transitions: lazy sweeping must not let the old anonymous ref revive.
  await auth.importCookie('SESSDATA=SYNTHETIC_SESSION; bili_jct=0123456789abcdef0123456789abcdef; DedeUserID=1', initialRevision);
  assert.equal(auth.state().loggedIn, true);
  await auth.logout(auth.state().revision);
  assert.equal(auth.state().loggedIn, false); assert.notEqual(auth.state().revision, initialRevision);
  let reads = 0; f.client.comments = async () => { reads++; return { items: [], hasMore: false }; };
  assert.equal((await f.runtime.read('comments', { videoRef: ref }, session) as any).content.error.code, 'reference_unavailable');
  assert.equal(reads, 0);
  const currentRef = await open(f);
  assert.equal((await f.runtime.read('comments', { videoRef: currentRef }, session) as any).content.status, 'ok');
  assert.equal(reads, 1);
});
test('media cache follows auth revisions across anonymous cycles and remains isolated by session', async t => {
  const f = fixture(); let auth: AuthManager, stored: unknown = {};
  t.after(async () => { await auth?.dispose(); await f.runtime.dispose(); });
  auth = new AuthManager(f.client, { read: async () => stored, save: async value => { stored = structuredClone(value); } }, f.controller.signal);
  f.options.account = () => auth.snapshot(); f.options.accountRevision = () => auth.state().revision;
  await auth.ready; await f.runtime.initialize();
  let offers = 0; const released: string[] = [], prepared: string[] = [];
  f.runtime.setVision({ signal: new AbortController().signal, effect: (create: any) => create(), service: {
    audiovisualApiVersion: '1.0.0', status: () => ({}),
    offerMedia: async () => ({ mediaRef: 'SYNTHETIC_PRIVATE_MEDIA_' + ++offers, expiresAt: new Date(2000000).toISOString(), info: {} }),
    release: async (input: any) => { released.push(input.mediaRef); return {}; },
    prepare: async (input: any) => { prepared.push(input.mediaRef); return { images: [], coverage: {}, warnings: [] }; },
  } } as any);
  const ref = await open(f);
  assert.equal((await f.runtime.watch({ videoRef: ref }, session) as any).receipt.status, 'completed');
  assert.equal((await f.runtime.watch({ videoRef: ref }, session) as any).receipt.status, 'completed');
  assert.equal(offers, 1); assert.deepEqual(prepared, ['SYNTHETIC_PRIVATE_MEDIA_1', 'SYNTHETIC_PRIVATE_MEDIA_1']);
  const otherSession = { ...session, id: 'synthetic-other-session' };
  const otherRef = (await f.runtime.read('open', { target: video.bvid }, otherSession) as any).content.data.videoRef;
  assert.equal((await f.runtime.watch({ videoRef: otherRef }, otherSession) as any).receipt.status, 'completed');
  assert.equal(offers, 2);

  await auth.importCookie('SESSDATA=SYNTHETIC_SESSION; bili_jct=0123456789abcdef0123456789abcdef; DedeUserID=1', auth.state().revision);
  await auth.logout(auth.state().revision);
  const currentRef = await open(f);
  assert.equal((await f.runtime.watch({ videoRef: currentRef }, session) as any).receipt.status, 'completed');
  assert.equal(offers, 3); assert.equal(prepared.at(-1), 'SYNTHETIC_PRIVATE_MEDIA_3');
  assert.deepEqual(released.sort(), ['SYNTHETIC_PRIVATE_MEDIA_1', 'SYNTHETIC_PRIVATE_MEDIA_2']);
  assert.equal((await f.runtime.watch({ videoRef: otherRef }, otherSession) as any).receipt.code, 'reference_unavailable');
});
test('audio disabled calls only visual preparation and never exposes private media reference', async () => {
  const f = fixture(); await f.runtime.initialize(); const ref = await open(f), bindingSignal = new AbortController(); let prepares = 0, understands = 0;
  const prepared = { images: [{ mime: 'image/jpeg', base64: Buffer.from('synthetic-jpeg').toString('base64'), width: 10, height: 10, frames: [] }], coverage: { fromSeconds: 0, toSeconds: 30, timelineComplete: false }, warnings: [] };
  f.runtime.setVision({ signal: bindingSignal.signal, effect: (create: any) => create(), service: { audiovisualApiVersion: '1.0.0', status: () => ({}),
    offerMedia: async (input: any) => { assert.equal(input.sessionId, session.id); return { mediaRef: 'PRIVATE_VISION_REFERENCE', expiresAt: new Date(2000000).toISOString(), info: {} }; }, release: async () => ({}),
    prepare: async () => { prepares++; return prepared; }, understand: async (input: any) => { understands++; assert.deepEqual(input.audio, ['speech']); return { status: 'completed', visual: prepared, audio: { status: 'completed' } }; } } } as any);
  const result = await f.runtime.watch({ videoRef: ref }, session); assert.equal(prepares, 1); assert.equal(understands, 0);
  assert.equal(result.content[1].type, 'image'); assert.ok(!JSON.stringify(result).includes('PRIVATE_VISION_REFERENCE'));
  f.config.audioEnabled = true; await f.runtime.watch({ videoRef: ref }, session); assert.equal(understands, 1);
  bindingSignal.abort(); const unavailable = await f.runtime.watch({ videoRef: ref }, session);
  assert.equal(JSON.parse((unavailable.content[0] as any).text).error.code, 'vision_unavailable');
  await f.runtime.dispose();
});
test('disabled interactions never submit; successful operation and content duplicate never submit twice', async () => {
  const f = fixture(); f.login(); await f.runtime.initialize(); const ref = await open(f), args = { action: 'comment', videoRef: ref, operationId: 'test-one', text: 'Synthetic own comment' };
  assert.equal((await f.runtime.interact(args, session) as any).content.error.code, 'interaction_disabled'); assert.equal(f.calls, 0);
  f.config.interactions.comment = true;
  assert.equal((await f.runtime.interact(args, session) as any).content.data.state, 'confirmed');
  assert.equal((await f.runtime.interact(args, session) as any).content.data.duplicate, true);
  assert.equal((await f.runtime.interact({ ...args, operationId: 'new-id' }, session) as any).content.data.duplicate, true); assert.equal(f.calls, 1);
  assert.equal((await f.runtime.interact({ ...args, text: 'Different' }, session) as any).content.error.code, 'invalid_input');
  assert.ok(!JSON.stringify(f.saved).includes('Synthetic own comment')); assert.ok(!JSON.stringify(f.saved).includes('SYNTHETIC_COOKIE'));
  await f.runtime.dispose();
});
test('uncertain submit persists and does not replay after a new runtime starts', async () => {
  const f = fixture(); f.login(); f.config.interactions.like = true; f.behavior(async () => { throw new BiliError('uncertain'); }); await f.runtime.initialize();
  const ref = await open(f), args = { action: 'like', videoRef: ref, operationId: 'stable' };
  assert.equal((await f.runtime.interact(args, session) as any).content.state, 'uncertain'); assert.equal(f.calls, 1);
  const second = new BiliRuntime(f.client, { status: () => ({}), settings: () => ({ timeoutMs: 5000, concurrency: 1, hasProxy: false }), search: async () => ({}) }, f.options); await second.initialize();
  const secondRef = (await second.read('open', { target: video.bvid }, session) as any).content.data.videoRef;
  assert.equal((await second.interact({ ...args, videoRef: secondRef }, session) as any).content.data.state, 'uncertain'); assert.equal(f.calls, 1); await second.dispose(); await f.runtime.dispose();
});
test('switching off interaction while pre-submit persistence waits prevents the external call', async () => {
  const f = fixture(); f.login(); f.config.interactions.follow = true; await f.runtime.initialize(); const ref = await open(f);
  f.onSave(async () => { f.config.interactions.follow = false; });
  const result: any = await f.runtime.interact({ action: 'follow', videoRef: ref, operationId: 'turn-off' }, session);
  assert.equal(result.content.state, 'rejected'); assert.equal(f.calls, 0); await f.runtime.dispose();
});
test('confirmed external action remains confirmed when user cancels as response arrives', async () => {
  const f = fixture(); f.login(); f.config.interactions.like = true; await f.runtime.initialize(); const ref = await open(f);
  f.behavior(async () => { f.controller.abort(); return { state: 'confirmed' }; });
  assert.equal((await f.runtime.interact({ action: 'like', videoRef: ref, operationId: 'cancel-after' }, session) as any).content.data.state, 'confirmed'); assert.equal(f.calls, 1); await f.runtime.dispose();
});
test('browse and comments preserve all records on a platform page', async () => {
  const f = fixture(); await f.runtime.initialize();
  f.client.feed = async () => ({ items: Array.from({ length: 12 }, () => structuredClone(video)), hasMore: true, nextPage: 2 });
  const result: any = await f.runtime.read('browse', { source: 'recommended' }, session);
  assert.equal(result.content.data.items.length, 12); assert.equal(result.content.data.nextPage, 2);
  await f.runtime.dispose();
});
test('concurrent viewing offers one private media copy and reads sound switch after download', async () => {
  const f = fixture(); await f.runtime.initialize(); const ref = await open(f); f.config.audioEnabled = true;
  let resolveMedia!: (value: any) => void, entered!: () => void; const started = new Promise<void>(r => { entered = r; });
  let downloads = 0, offers = 0, prepares = 0, understands = 0;
  f.client.media = async () => { downloads++; entered(); return new Promise(resolve => { resolveMedia = resolve; }); };
  const binding = { signal: new AbortController().signal, effect: (create: any) => create(), service: { audiovisualApiVersion: '1.0.0', status: () => ({}),
    offerMedia: async () => { offers++; return { mediaRef: 'PRIVATE_REF', expiresAt: new Date(2000000).toISOString(), info: {} }; }, release: async () => ({}),
    prepare: async () => { prepares++; return { images: [], coverage: {}, warnings: [] }; },
    understand: async () => { understands++; return { status: 'completed', audio: {}, visual: { images: [], coverage: {}, warnings: [] } }; } } };
  f.runtime.setVision(binding as any);
  const first = f.runtime.watch({ videoRef: ref }, session); await started;
  const second = f.runtime.watch({ videoRef: ref }, session); await new Promise(resolve => setImmediate(resolve));
  f.config.audioEnabled = false; resolveMedia({ bytes: Buffer.from('synthetic'), mime: 'video/mp4' });
  await Promise.all([first, second]); assert.equal(downloads, 1); assert.equal(offers, 1); assert.equal(prepares, 2); assert.equal(understands, 0); await f.runtime.dispose();
});
test('a definitely rejected action permits a new operation after the cause is resolved', async () => {
  const f = fixture(); f.login(); f.config.interactions.like = true; await f.runtime.initialize(); const ref = await open(f);
  f.behavior(async () => { throw new BiliError('platform_error'); });
  assert.equal((await f.runtime.interact({ action: 'like', videoRef: ref, operationId: 'first' }, session) as any).content.state, 'rejected');
  f.behavior(async () => ({ state: 'confirmed' }));
  assert.equal((await f.runtime.interact({ action: 'like', videoRef: ref, operationId: 'second' }, session) as any).content.data.state, 'confirmed'); assert.equal(f.calls, 2); await f.runtime.dispose();
});
test('failed memory recording cannot repeat a confirmed action and duplicate can repair the same event', async () => {
  const f = fixture(); f.login(); f.config.interactions.comment = true;
  const events: string[] = []; let fail = true;
  (f.options as any).recordAction = async (id: string, event: string, action: string) => { assert.equal(id, session.id); assert.equal(action, 'comment'); events.push(event); if (fail) throw Error('Synthetic memory failure'); };
  await f.runtime.initialize(); const ref = await open(f), args = { action: 'comment', videoRef: ref, operationId: 'memory-repair', text: 'Synthetic own comment' };
  const first: any = await f.runtime.interact(args, session); assert.equal(first.content.data.state, 'confirmed'); assert.equal(first.content.data.experienceRecorded, false);
  fail = false; const duplicate: any = await f.runtime.interact(args, session); assert.equal(duplicate.content.data.duplicate, true); assert.equal(f.calls, 1); assert.equal(events.length, 2); assert.equal(events[0], events[1]);
  await f.runtime.dispose();
});
