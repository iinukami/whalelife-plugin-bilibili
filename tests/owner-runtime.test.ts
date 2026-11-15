/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { ToolSession } from 'whalelife';
import { BiliRuntime, type RuntimeOptions } from '../src/runtime.ts';
import { defaults } from '../src/config.ts';
import { BiliError } from '../src/errors.ts';
import type { BiliClientContract, InteractionInput, OwnerProfile, VideoDetails } from '../src/types.ts';

const OWNER: OwnerProfile = { uid: '123456789', name: 'SYNTHETIC_OWNER_NAME' };
const video: VideoDetails = { bvid: 'BV1xx411c7mD', aid: 123, cid: 456, duration: 120,
  title: 'SYNTHETIC_VIDEO_TITLE', description: 'SYNTHETIC_DESCRIPTION', owner: { mid: 789, name: 'Synthetic author' },
  cover: 'https://i0.hdslb.com/synthetic.jpg', url: 'https://www.bilibili.com/video/BV1xx411c7mD',
  parts: [{ cid: 456, page: 1, title: 'Synthetic part', duration: 120 }] };
const TEXT = 'SYNTHETIC_COMMENT_TEXT';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(t: TestContext) {
  const config = structuredClone(defaults), controller = new AbortController();
  config.interactions.like = config.interactions.comment = config.interactions.reply = true;
  const session: ToolSession = { id: 'synthetic-owner-session', permission: 'full', signal: controller.signal };
  const account = { mid: 1, name: 'Synthetic login', cookie: 'SYNTHETIC_COOKIE', revision: 'account-generation' };
  let owner: OwnerProfile | undefined = { ...OWNER }, ownerRevision = 0, saved: any = {};
  const calls: string[] = [], posts: InteractionInput[] = [], records: string[] = [];
  let saveHook = async (_value: unknown) => {}, accountHook = async () => ({ mid: account.mid, name: account.name });
  let prepareHook = async () => {}, settingsHook: () => any = () => ({ timeoutMs: 5000, concurrency: 4, hasProxy: false });
  let postHook = async (_input: InteractionInput) => ({ state: 'confirmed' as const, platformId: '999' });
  const client = {
    async video() { calls.push('video'); return structuredClone(video); },
    async comments() { calls.push('comments'); return { items: [{ rpid: '333', root: '0', text: 'SYNTHETIC_OTHER_COMMENT', author: { mid: 45, name: 'Synthetic reader' }, likes: 0 }], hasMore: false }; },
    async account() { calls.push('account'); return accountHook(); },
    async interact(input: InteractionInput) { calls.push('post'); posts.push(structuredClone(input)); return postHook(input); },
    dispose() {},
  } as unknown as BiliClientContract;
  const options: RuntimeOptions = { config: () => config, account: () => account, now: () => 1000,
    signal: new AbortController().signal, transient: true, readLedger: async () => saved,
    saveLedger: async value => { await saveHook(value); saved = structuredClone(value); },
    owner: () => owner, ownerRevision: () => String(ownerRevision),
    prepareAccount: async () => { calls.push('prepare'); await prepareHook(); },
    recordAction: async (_session, eventId, action) => { records.push(JSON.stringify({ eventId, action })); } };
  const runtime = new BiliRuntime(client, { status: () => ({}), settings: () => { calls.push('settings'); return settingsHook(); }, search: async () => ({}) }, options);
  t.after(() => runtime.dispose());
  const open = async () => {
    const result: any = await runtime.read('open', { target: video.bvid }, session);
    assert.equal(result.content.status, 'ok'); return result.content.data.videoRef as string;
  };
  return { runtime, config, session, controller, calls, posts, records, options, open,
    get saved() { return saved; }, setSaved(value: unknown) { saved = value; },
    setOwner(value: OwnerProfile | undefined) { owner = value ? { ...value } : undefined; ownerRevision++; },
    mutateOwner(value: Partial<OwnerProfile>) { Object.assign(owner!, value); },
    onSave(fn: typeof saveHook) { saveHook = fn; }, onAccount(fn: typeof accountHook) { accountHook = fn; },
    onPrepare(fn: typeof prepareHook) { prepareHook = fn; }, onSettings(fn: typeof settingsHook) { settingsHook = fn; }, onPost(fn: typeof postHook) { postHook = fn; } };
}
function args(videoRef: string, operationId = 'synthetic-mention-operation') {
  return { action: 'comment', videoRef, operationId, text: TEXT, mentionOwner: true };
}
function code(result: any, expected: string) { assert.equal(result.content.status, 'error'); assert.equal(result.content.error.code, expected); assert.equal(result.receipt.code, expected); }
function privateReceipt(result: any, f: ReturnType<typeof fixture>) {
  for (const marker of [OWNER.uid, OWNER.name, TEXT, 'SYNTHETIC_COOKIE', video.title]) {
    assert.ok(!JSON.stringify(result.receipt).includes(marker), marker);
    assert.ok(!JSON.stringify(f.saved).includes(marker), marker);
    assert.ok(!JSON.stringify(f.records).includes(marker), marker);
  }
}

test('owner lookup is local and transient; status discloses only whether one is configured', async t => {
  const f = fixture(t); await f.runtime.initialize();
  const result: any = await f.runtime.read('owner', {}, f.session);
  assert.deepEqual(result.content.data, { owner: { ...OWNER, url: 'https://space.bilibili.com/' + OWNER.uid }, untrusted: true });
  assert.deepEqual(result.receipt, { action: 'bilibili_owner', status: 'ok' });
  assert.equal(f.runtime.status().ownerConfigured, true);
  assert.ok(!JSON.stringify(f.runtime.status()).includes(OWNER.uid)); assert.ok(!JSON.stringify(f.runtime.status()).includes(OWNER.name));
  f.setOwner(undefined); assert.equal(f.runtime.status().ownerConfigured, false);
  assert.equal((await f.runtime.read('owner', {}, f.session) as any).content.data.owner, null);
  code(await f.runtime.read('owner', { uid: OWNER.uid }, f.session), 'invalid_input');
  code(await f.runtime.read('owner', {}, { ...f.session, id: '' }), 'session_required');
  f.controller.abort(); code(await f.runtime.read('owner', {}, f.session), 'cancelled');
  assert.deepEqual(f.calls, []); privateReceipt(result, f);
});

test('comment and reply send only the captured configured owner through the client field', async t => {
  const f = fixture(t); await f.runtime.initialize(); const videoRef = await f.open();
  const comment: any = await f.runtime.interact(args(videoRef), f.session);
  assert.equal(comment.content.data.state, 'confirmed'); assert.deepEqual(f.posts[0].mentionOwner, OWNER);
  assert.equal(f.posts[0].text, TEXT, 'only the client constructs the mention prefix');
  const comments: any = await f.runtime.read('comments', { videoRef }, f.session);
  const reply: any = await f.runtime.interact({ action: 'reply', commentRef: comments.content.data.items[0].commentRef, operationId: 'synthetic-reply', text: TEXT, mentionOwner: true }, f.session);
  assert.equal(reply.content.data.state, 'confirmed'); assert.deepEqual(f.posts[1].mentionOwner, OWNER);
  assert.equal(f.posts[1].root, '333'); assert.equal(f.posts[1].parent, '333');
  privateReceipt(comment, f); privateReceipt(reply, f);
});

test('arbitrary mention fields, nonboolean mention flags and mentions on other actions reject before IO', async t => {
  const f = fixture(t); await f.runtime.initialize(); const videoRef = await f.open(); f.calls.length = 0;
  for (const field of ['uid', 'name', 'owner', 'mention', 'mentions', 'at_uids', 'at_name_to_mid', 'at', 'coinCount'])
    code(await f.runtime.interact({ ...args(videoRef), [field]: field === 'uid' ? '9999' : { uid: '9999', name: 'SYNTHETIC_OTHER' } }, f.session), 'invalid_input');
  for (const value of ['true', 1, null, OWNER]) code(await f.runtime.interact({ ...args(videoRef), mentionOwner: value }, f.session), 'invalid_input');
  for (const action of ['like', 'favorite', 'follow', 'coin']) code(await f.runtime.interact({ ...args(videoRef), action }, f.session), 'invalid_input');
  assert.deepEqual(f.calls, []); assert.equal(f.posts.length, 0); assert.deepEqual(f.saved, {});
});

test('raw ASCII mentions are rejected even without mentionOwner and a missing owner is explicit', async t => {
  const f = fixture(t); await f.runtime.initialize(); const videoRef = await f.open(); f.calls.length = 0;
  for (const mentionOwner of [undefined, false, true]) for (const text of ['@SYNTHETIC_OTHER hi', 'x@y.example', '@' + OWNER.name])
    code(await f.runtime.interact({ ...args(videoRef), mentionOwner, text }, f.session), 'mention_invalid');
  f.setOwner(undefined); code(await f.runtime.interact(args(videoRef), f.session), 'owner_required');
  assert.deepEqual(f.calls, []); assert.equal(f.posts.length, 0);
});

test('interaction switches and full permission remain required before account preparation or POST', async t => {
  const f = fixture(t); await f.runtime.initialize(); const videoRef = await f.open(); f.calls.length = 0;
  f.config.interactions.comment = false; code(await f.runtime.interact(args(videoRef), f.session), 'interaction_disabled');
  f.config.interactions.comment = true;
  for (const permission of ['off', 'ask'] as const) code(await f.runtime.interact(args(videoRef), { ...f.session, permission }), 'permission_required');
  assert.deepEqual(f.calls, []); assert.equal(f.posts.length, 0);
  f.onSave(async () => { f.session.permission = 'ask'; });
  code(await f.runtime.interact(args(videoRef), f.session), 'permission_required'); assert.equal(f.posts.length, 0); assert.equal(f.saved.entries[0].state, 'rejected');
});

test('ordinary comment fingerprints remain byte-compatible and mentionOwner false is absent from the client payload', async t => {
  const f = fixture(t), key = digest([1, f.session.id, 'synthetic-legacy']), fingerprint = digest([1, 'comment', video.aid, video.owner.mid, undefined, undefined, TEXT]);
  f.setSaved({ entries: [{ key, fingerprint, state: 'confirmed', platformId: '111' }] }); await f.runtime.initialize(); const videoRef = await f.open();
  for (const mentionOwner of [undefined, false]) {
    const result: any = await f.runtime.interact({ ...args(videoRef, 'synthetic-legacy'), mentionOwner }, f.session);
    assert.equal(result.content.data.duplicate, true); assert.equal(result.content.data.state, 'confirmed');
  }
  assert.equal(f.posts.length, 0); assert.equal(f.saved.entries[0].fingerprint, fingerprint);
  const plain: any = await f.runtime.interact({ ...args(videoRef, 'synthetic-ordinary-new'), mentionOwner: false, text: TEXT + '_NEW' }, f.session);
  assert.equal(plain.content.data.state, 'confirmed'); assert.equal(Object.hasOwn(f.posts[0], 'mentionOwner'), false);
  assert.equal(f.saved.entries[1].fingerprint, digest([1, 'comment', video.aid, video.owner.mid, undefined, undefined, TEXT + '_NEW']));
});

test('same owner mentions deduplicate and the same operation cannot change mention mode, UID or name', async t => {
  const f = fixture(t); await f.runtime.initialize(); const input = args(await f.open()); await f.runtime.interact(input, f.session);
  for (const operationId of [input.operationId, 'synthetic-equivalent-mention']) {
    const result: any = await f.runtime.interact({ ...input, operationId }, f.session); assert.equal(result.content.data.duplicate, true);
  }
  code(await f.runtime.interact({ ...input, mentionOwner: false }, f.session), 'invalid_input');
  f.setOwner({ ...OWNER, uid: '99887766' }); code(await f.runtime.interact(input, f.session), 'invalid_input');
  f.setOwner({ ...OWNER, name: 'SYNTHETIC_CHANGED_NAME' }); code(await f.runtime.interact(input, f.session), 'invalid_input');
  assert.equal(f.posts.length, 1); privateReceipt(await f.runtime.interact({ ...input, mentionOwner: false }, f.session), f);
});

test('queued mentions keep the original owner snapshot, including change-and-restore revisions and in-place mutation', async t => {
  for (const boundary of ['replace', 'restore', 'mutate']) {
    const f = fixture(t); await f.runtime.initialize(); const videoRef = await f.open(), entered = deferred(), release = deferred();
    f.onPost(async () => { entered.resolve(); await release.promise; return { state: 'confirmed', platformId: '999' }; });
    const first = f.runtime.interact({ action: 'like', videoRef, operationId: 'synthetic-blocker' }, f.session); await entered.promise;
    const pending = f.runtime.interact(args(videoRef), f.session);
    if (boundary === 'mutate') f.mutateOwner({ name: 'SYNTHETIC_MUTATED' });
    else { f.setOwner({ uid: '88776655', name: 'SYNTHETIC_NEW_OWNER' }); if (boundary === 'restore') f.setOwner(OWNER); }
    release.resolve(); await first; code(await pending, 'owner_changed');
    assert.equal(f.posts.length, 1); assert.equal(f.calls.filter(call => call === 'account').length, 1);
  }
});

test('queued caller input is copied and cannot switch off mention checks or replace text later', async t => {
  const f = fixture(t); await f.runtime.initialize(); const videoRef = await f.open(), entered = deferred(), release = deferred();
  f.onPost(async () => { entered.resolve(); await release.promise; return { state: 'confirmed', platformId: '999' }; });
  const first = f.runtime.interact({ action: 'like', videoRef, operationId: 'synthetic-blocker' }, f.session); await entered.promise;
  const input = args(videoRef), pending = f.runtime.interact(input, f.session); input.mentionOwner = false; input.text = '@SYNTHETIC_INJECTED';
  release.resolve(); await first; assert.equal((await pending as any).content.data.state, 'confirmed');
  assert.deepEqual(f.posts[1].mentionOwner, OWNER); assert.equal(f.posts[1].text, TEXT);
});

test('owner changes after settings, preparation, account checks or pending persistence prevent submission', async t => {
  for (const boundary of ['settings', 'prepare', 'account', 'save']) {
    const f = fixture(t); await f.runtime.initialize(); const input = args(await f.open());
    const change = () => f.setOwner({ uid: '11223344', name: 'SYNTHETIC_CHANGED_OWNER' });
    if (boundary === 'settings') f.onSettings(async () => { change(); return { timeoutMs: 5000, concurrency: 4, hasProxy: false }; });
    if (boundary === 'prepare') f.onPrepare(async () => { change(); });
    if (boundary === 'account') f.onAccount(async () => { change(); return { mid: 1, name: 'Synthetic login' }; });
    if (boundary === 'save') f.onSave(async () => { change(); });
    const result = await f.runtime.interact(input, f.session); code(result, 'owner_changed');
    assert.equal(f.posts.length, 0, boundary); if (boundary === 'save') assert.equal(f.saved.entries[0].state, 'rejected'); privateReceipt(result, f);
  }
});

test('confirmed and uncertain submissions retain their real outcomes if the owner changes after dispatch', async t => {
  for (const state of ['confirmed', 'uncertain']) {
    const f = fixture(t); await f.runtime.initialize(); const input = args(await f.open());
    f.onPost(async () => { f.setOwner({ uid: '55443322', name: 'SYNTHETIC_CHANGED_OWNER' }); if (state === 'uncertain') throw new BiliError('uncertain'); return { state: 'confirmed', platformId: '999' }; });
    const result: any = await f.runtime.interact(input, f.session);
    assert.equal(result.receipt.state, state); assert.equal(f.posts.length, 1); assert.deepEqual(f.posts[0].mentionOwner, OWNER);
    code(await f.runtime.interact(input, f.session), 'invalid_input'); assert.equal(f.posts.length, 1); privateReceipt(result, f);
  }
});

test('legacy untrusted sessionId is ignored without weakening owner or trusted-session boundaries', async t => {
  const f = fixture(t); await f.runtime.initialize(); const videoRef = await f.open();
  const input = { ...args(videoRef), sessionId: 'synthetic-untrusted-session' };
  f.config.interactions.comment = false;
  code(await f.runtime.interact({ ...input, text: '@SYNTHETIC' }, f.session), 'interaction_disabled');
  f.config.interactions.comment = true;
  const result: any = await f.runtime.interact(input, f.session);
  assert.equal(result.content.data.state, 'confirmed'); assert.deepEqual(f.posts[0].mentionOwner, OWNER);
  assert.equal(f.saved.entries[0].key, digest([1, f.session.id, input.operationId]));
  const duplicate: any = await f.runtime.interact({ ...input, sessionId: 'synthetic-different-injection' }, f.session);
  assert.equal(duplicate.content.data.duplicate, true); assert.equal(f.posts.length, 1);
  code(await f.runtime.interact({ ...input, sessionId: f.session.id }, { ...f.session, id: 'synthetic-other-trusted-session' }), 'reference_unavailable');
  assert.equal(f.posts.length, 1);
  f.onSave(async () => { f.setOwner({ uid: '66554433', name: 'SYNTHETIC_REPLACEMENT' }); });
  code(await f.runtime.interact({ ...input, operationId: 'synthetic-second-operation', text: TEXT + '_SECOND' }, f.session), 'owner_changed');
  assert.equal(f.posts.length, 1); assert.equal(f.saved.entries[1].state, 'rejected');
  assert.equal(f.saved.entries[1].key, digest([1, f.session.id, 'synthetic-second-operation']));
  privateReceipt(result, f);
});
