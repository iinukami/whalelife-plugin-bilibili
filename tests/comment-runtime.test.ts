/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { ToolSession } from 'whalelife';
import { BiliRuntime, type RuntimeOptions } from '../src/runtime.ts';
import { applyWithDependencies } from '../src/index.ts';
import { defaults } from '../src/config.ts';
import type { BiliClientContract, CallOptions, CommentPublication, InteractionInput, InteractionResult, VideoDetails } from '../src/types.ts';

const video: VideoDetails = { bvid: 'BV1xx411c7mD', aid: 123, cid: 456, duration: 120,
  title: 'SYNTHETIC_VIDEO_TITLE', description: 'SYNTHETIC_DESCRIPTION', owner: { mid: 789, name: 'Synthetic author' },
  cover: 'https://i0.hdslb.com/synthetic.jpg', url: 'https://www.bilibili.com/video/BV1xx411c7mD',
  parts: [{ cid: 456, page: 1, title: 'Synthetic part', duration: 120 }] };
const TEXT = 'SYNTHETIC_COMMENT_TEXT', SECRET = 'SYNTHETIC_PRIVATE_EXTRA';
const UNKNOWN: CommentPublication = { visibility: 'unknown', checkedAnonymously: false, notification: 'unverified' };
const PUBLIC: CommentPublication = { visibility: 'public', state: 0, checkedAnonymously: true, notification: 'unverified' };
const HIDDEN: CommentPublication = { visibility: 'not_public', state: 17, checkedAnonymously: true, notification: 'unverified' };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture(t: TestContext) {
  const config = structuredClone(defaults), controller = new AbortController();
  config.interactions.like = config.interactions.comment = config.interactions.reply = true;
  const session: ToolSession = { id: 'synthetic-comment-session', permission: 'full', signal: controller.signal };
  const account = { mid: 1, name: 'Synthetic login', cookie: 'SESSDATA=SYNTHETIC; bili_jct=0123456789abcdef0123456789abcdef; DedeUserID=1', revision: 'synthetic-account' };
  let saved: any = {}, response: unknown = { state: 'confirmed', platformId: '999', comment: HIDDEN };
  let ownerRevision = 0;
  const calls: string[] = [], posts: InteractionInput[] = [], records: string[] = [];
  let saveHook = async (_value: any) => {}, postHook = async (_options: CallOptions) => {}, recordHook = async () => {};
  const client = {
    async video() { calls.push('video'); return structuredClone(video); },
    async comments() { calls.push('comments'); return { items: [{ rpid: '333', root: '0', text: 'SYNTHETIC_OTHER_COMMENT', author: { mid: 45, name: 'Synthetic reader' }, likes: 0 }], hasMore: false }; },
    async account() { calls.push('account'); return { mid: account.mid, name: account.name }; },
    async interact(input: InteractionInput, callOptions: CallOptions) { calls.push('post'); posts.push(structuredClone(input)); await postHook(callOptions); return structuredClone(response) as InteractionResult; },
    dispose() {},
  } as unknown as BiliClientContract;
  const options: RuntimeOptions = { config: () => config, account: () => account, now: () => 1000,
    signal: new AbortController().signal, transient: true, readLedger: async () => saved,
    owner: () => ({ uid: '456', name: 'Synthetic owner' }), ownerRevision: () => 'synthetic-owner-' + ownerRevision,
    saveLedger: async value => { await saveHook(value); saved = structuredClone(value); },
    recordAction: async (_session, event, action) => { records.push(event + ':' + action); await recordHook(); } };
  const create = () => {
    const runtime = new BiliRuntime(client, { status: () => ({}), settings: () => ({ timeoutMs: 5000, concurrency: 4, hasProxy: false }), search: async () => ({}) }, options);
    t.after(() => runtime.dispose()); return runtime;
  };
  const runtime = create();
  const open = async (which = runtime) => {
    const result: any = await which.read('open', { target: video.bvid }, session);
    assert.equal(result.content.status, 'ok'); return result.content.data.videoRef as string;
  };
  return { runtime, create, client, account, config, session, controller, calls, posts, records, options, open,
    get saved() { return saved; }, setSaved(value: unknown) { saved = value; }, result(value: unknown) { response = value; }, changeOwner() { ownerRevision++; },
    onSave(fn: typeof saveHook) { saveHook = fn; }, onPost(fn: typeof postHook) { postHook = fn; }, onRecord(fn: typeof recordHook) { recordHook = fn; } };
}
function args(videoRef: string, operationId = 'synthetic-comment-operation') { return { action: 'comment', videoRef, operationId, text: TEXT }; }
function checked(result: any, expected: CommentPublication) {
  assert.equal(result.content.status, 'ok'); assert.equal(result.content.data.state, 'confirmed');
  assert.deepEqual(result.content.data.comment, expected); assert.deepEqual(result.receipt.comment, expected);
  assert.equal(result.receipt.notice, result.content.data.notice);
  assert.match(result.content.data.notice, /仅表示平台已接收/); assert.match(result.content.data.notice, /不要换 operationId 补发/);
  assert.ok(!JSON.stringify(result.receipt).includes(TEXT)); assert.ok(!JSON.stringify(result).includes(SECRET));
}

test('accepted comments distinguish public, hidden and unknown snapshots in result, receipt and ledger', async t => {
  for (const comment of [PUBLIC, HIDDEN, UNKNOWN]) {
    const f = fixture(t); f.result({ state: 'confirmed', platformId: '999', comment }); await f.runtime.initialize();
    const result = await f.runtime.interact(args(await f.open()), f.session); checked(result, comment);
    assert.deepEqual(f.saved.entries[0].comment, comment); assert.equal(f.saved.entries[0].state, 'confirmed');
    assert.equal(f.posts[0].bvid, video.bvid); assert.equal(f.posts.length, 1);
    assert.ok(!JSON.stringify(f.saved).includes(TEXT)); assert.ok(!JSON.stringify(f.saved).includes(video.bvid));
    if (comment.visibility === 'not_public') assert.match((result as any).content.data.notice, /审核或显示延迟/);
  }
});

test('comment publication is copied through a strict field whitelist and absent old-client metadata is unknown', async t => {
  const f = fixture(t); f.result({ state: 'confirmed', platformId: '999', cookie: SECRET, comment: { ...PUBLIC, message: SECRET, owner: SECRET } });
  await f.runtime.initialize(); checked(await f.runtime.interact(args(await f.open()), f.session), PUBLIC);
  assert.deepEqual(f.saved.entries[0].comment, PUBLIC); assert.ok(!JSON.stringify(f.saved).includes(SECRET));
  const g = fixture(t); g.result({ state: 'confirmed', platformId: '999' }); await g.runtime.initialize();
  checked(await g.runtime.interact(args(await g.open()), g.session), UNKNOWN); assert.deepEqual(g.saved.entries[0].comment, UNKNOWN);
});

test('malformed publication data cannot invent public visibility or notification delivery', async t => {
  for (const comment of [null, {}, [], { ...PUBLIC, visibility: SECRET }, { ...PUBLIC, checkedAnonymously: 'yes' },
    { ...PUBLIC, notification: 'delivered' }, { ...PUBLIC, state: Number.MAX_SAFE_INTEGER + 1 }, { ...PUBLIC, state: -1 },
    { ...PUBLIC, checkedAnonymously: false }, { ...PUBLIC, state: 17 }]) {
    const f = fixture(t); f.result({ state: 'confirmed', platformId: '999', comment }); await f.runtime.initialize();
    const result: any = await f.runtime.interact(args(await f.open()), f.session);
    assert.equal(result.content.data.state, 'confirmed'); assert.equal(result.content.data.comment.visibility, 'unknown');
    assert.equal(result.content.data.comment.notification, 'unverified'); assert.ok(!JSON.stringify(result).includes(SECRET)); assert.equal(f.posts.length, 1);
  }
});

test('confirmed comment and reply ledger rows without publication remain usable and do not repost', async t => {
  for (const action of ['comment', 'reply'] as const) for (const storedComment of [undefined, { visibility: SECRET }]) {
    const f = fixture(t), key = digest([1, f.session.id, 'synthetic-legacy']);
    const fingerprint = digest([1, action, video.aid, video.owner.mid, action === 'reply' ? '333' : undefined, undefined, TEXT]);
    f.setSaved({ entries: [{ key, fingerprint, state: 'confirmed', platformId: '888', ...(storedComment ? { comment: storedComment } : {}) }] });
    await f.runtime.initialize(); assert.equal(f.runtime.status().ledgerReady, true); const videoRef = await f.open();
    const comments: any = action === 'reply' ? await f.runtime.read('comments', { videoRef }, f.session) : undefined;
    const input = { action, ...(action === 'reply' ? { commentRef: comments.content.data.items[0].commentRef } : { videoRef }), operationId: 'synthetic-legacy', text: TEXT };
    const before = f.calls.length, result: any = await f.runtime.interact(input, f.session); checked(result, UNKNOWN);
    assert.equal(result.content.data.duplicate, true); assert.equal(f.posts.length, 0); assert.equal(f.calls.length, before);
    assert.equal(f.saved.entries[0].key, key); assert.equal(f.saved.entries[0].fingerprint, fingerprint);
  }
});

test('accepted visibility survives reload and equivalent content with another operation ID never resubmits', async t => {
  for (const comment of [PUBLIC, HIDDEN, UNKNOWN]) {
    const f = fixture(t); f.result({ state: 'confirmed', platformId: '999', comment }); await f.runtime.initialize();
    const input = args(await f.open()); await f.runtime.interact(input, f.session);
    const count = f.calls.length, duplicate: any = await f.runtime.interact({ ...input, operationId: 'synthetic-new-id' }, f.session);
    checked(duplicate, comment); assert.equal(duplicate.content.data.duplicate, true); assert.equal(f.posts.length, 1); assert.equal(f.calls.length, count);
    const restarted = f.create(); await restarted.initialize();
    const replay: any = await restarted.interact(args(await f.open(restarted)), f.session); checked(replay, comment);
    assert.equal(replay.content.data.duplicate, true); assert.equal(f.posts.length, 1);
  }
});

test('cancellation and post-acceptance persistence failure preserve the accepted publication result', async t => {
  for (const boundary of ['cancel', 'save', 'cancel-and-save', 'cancel-memory-failure']) {
    const f = fixture(t); await f.runtime.initialize();
    if (boundary.includes('cancel')) f.onPost(async () => { f.controller.abort(); });
    if (boundary.includes('save')) f.onSave(async value => { if (value.entries[0]?.state === 'confirmed') throw Error(SECRET); });
    if (boundary.includes('memory')) f.onRecord(async () => { throw Error(SECRET); });
    const result: any = await f.runtime.interact(args(await f.open()), f.session); checked(result, HIDDEN);
    assert.equal(result.content.data.ledgerSaved, !boundary.includes('save'));
    assert.equal(result.content.data.experienceRecorded, !boundary.includes('memory'));
    assert.equal(f.posts.length, 1);
  }
});

test('a duplicate accepted comment retains its snapshot even when cancellation occurs during memory repair', async t => {
  const f = fixture(t); await f.runtime.initialize(); const input = args(await f.open()); await f.runtime.interact(input, f.session);
  f.onRecord(async () => { f.controller.abort(); });
  const result: any = await f.runtime.interact(input, f.session); checked(result, HIDDEN);
  assert.equal(result.content.data.duplicate, true); assert.equal(result.receipt.duplicate, true); assert.equal(f.posts.length, 1);
  assert.equal(Object.hasOwn(result.content.data, 'ledgerSaved'), false, 'duplicate return must not invent a fresh ledger save');
});

test('post-response guards stop further client reads after account or owner changes while preserving acceptance', async t => {
  for (const boundary of ['account', 'owner']) {
    const f = fixture(t); await f.runtime.initialize(); const videoRef = await f.open();
    let laterReads = 0, blocked = '';
    f.onPost(async options => {
      if (boundary === 'account') f.account.revision = 'synthetic-other-account'; else f.changeOwner();
      assert.equal(typeof options.assertCurrent, 'function');
      try { options.assertCurrent!(); laterReads++; }
      catch (error: any) { blocked = error.code; }
      f.result({ state: 'confirmed', platformId: '999', comment: UNKNOWN });
    });
    const result: any = await f.runtime.interact({ ...args(videoRef), mentionOwner: true }, f.session); checked(result, UNKNOWN);
    assert.equal(blocked, boundary === 'account' ? 'account_changed' : 'owner_changed');
    assert.equal(laterReads, 0); assert.equal(f.posts.length, 1); assert.equal(result.content.data.platformId, '999');
  }
});

test('likes preserve their original receipt contract without comment publication fields', async t => {
  const f = fixture(t); await f.runtime.initialize(); const result: any = await f.runtime.interact({ action: 'like', videoRef: await f.open(), operationId: 'synthetic-like' }, f.session);
  assert.equal(result.content.data.state, 'confirmed'); assert.equal(Object.hasOwn(result.content.data, 'comment'), false);
  assert.equal(Object.hasOwn(result.receipt, 'comment'), false); assert.equal(Object.hasOwn(f.saved.entries[0], 'comment'), false);
});

test('registered comment and reply tools record accepted submission without claiming publication or notification', async t => {
  const f = fixture(t), controller = new AbortController(), tools = new Map<string, any>(), memory: any[] = [], cleanups: (() => Promise<void>)[] = [];
  const stored = new Map<string, unknown>([['account.json', { schema: 1, revision: 'synthetic-account', account: f.account }]]);
  t.after(async () => { for (const close of cleanups.reverse()) await close(); controller.abort(); });
  const ctx: any = { signal: controller.signal,
    config: { read: async (key?: string) => key ? stored.get(key) ?? {} : structuredClone(f.config), save: async (key: string, value: unknown) => { stored.set(key, structuredClone(value)); } },
    get: () => ({ status: () => ({}), settings: () => ({ timeoutMs: 5000, concurrency: 2, hasProxy: false }), search: async () => ({}) }),
    effect: (create: () => () => Promise<void>) => { const close = create(); cleanups.push(close); return close; }, provide() {},
    tools: { register: (tool: any) => { tools.set(tool.name, tool); }, registerTransient: (tool: any) => { tools.set(tool.name, tool); } },
    web: { page() {}, api() {} }, memory: { recordExperience: async (_session: string, record: unknown) => { memory.push(record); } } };
  await applyWithDependencies(ctx, { client: f.client, now: () => 1000 });
  const opened = await tools.get('bilibili_open').run({ target: video.bvid }, f.session), videoRef = opened.content.data.videoRef;
  checked(await tools.get('bilibili_interact').run(args(videoRef), f.session), HIDDEN);
  const comments = await tools.get('bilibili_comments').run({ videoRef }, f.session);
  checked(await tools.get('bilibili_interact').run({ action: 'reply', commentRef: comments.content.data.items[0].commentRef, text: TEXT, operationId: 'synthetic-reply' }, f.session), HIDDEN);
  await tools.get('bilibili_interact').run({ action: 'like', videoRef, operationId: 'synthetic-like' }, f.session);
  assert.match(memory[0].text, /提交评论并取得平台回执/); assert.match(memory[1].text, /提交回复并取得平台回执/);
  for (const item of memory.slice(0, 2)) { assert.match(item.text, /不确认公开可见或通知送达/); assert.equal(item.outcome, 'succeeded'); }
  assert.equal(memory[2].text, '在 B 站完成点赞视频，已取得平台确认。');
  assert.match(tools.get('bilibili_interact').description, /confirmed只表示平台接收/);
});
