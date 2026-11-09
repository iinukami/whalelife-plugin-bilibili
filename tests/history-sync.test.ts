/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HistorySync, type HistorySyncOptions } from '../src/history-sync.ts';
import { BiliError } from '../src/errors.ts';
import { defaults } from '../src/config.ts';
import type { AccountState, BiliClientContract, PreparedMedia, VideoDetails } from '../src/types.ts';

const video: VideoDetails = { bvid: 'BV1xx411c7mD', aid: 123, cid: 456, duration: 120,
  title: 'SYNTHETIC_HISTORY_TITLE', description: 'SYNTHETIC_HISTORY_DESCRIPTION', owner: { mid: 789, name: 'Synthetic' },
  cover: 'https://synthetic.example/cover.jpg', url: 'https://www.bilibili.com/video/BV1xx411c7mD',
  parts: [{ cid: 456, page: 1, title: 'Synthetic part', duration: 120 }] };
function prepared(at = 12.8, from = 10, to = 20): PreparedMedia {
  return { images: [{ mime: 'image/jpeg', base64: Buffer.from([255, 216, 255, 217]).toString('base64'), width: 1, height: 1, frames: [{ atSeconds: at }] }],
    coverage: { fromSeconds: from, toSeconds: to, timelineComplete: false }, warnings: [] };
}
function fixture() {
  const config = { ...structuredClone(defaults), historySyncEnabled: true }, controller = new AbortController();
  let now = 1000, account: AccountState | undefined = { mid: 1, name: 'Synthetic', cookie: 'SYNTHETIC_HISTORY_COOKIE', revision: 'revision-1' };
  let saved: any = {}, remote: any = { found: false }, identity = 'revision-1';
  const calls: string[] = [], posts: any[] = [], records: string[] = [];
  let saveHook = async (_value: any) => {}, accountHook = async () => ({ mid: account!.mid, name: 'Synthetic' }), progressHook = async () => structuredClone(remote);
  let postHook = async (input: any) => { remote = { found: true, progressSeconds: input.positionSeconds, completed: false }; return { state: 'accepted' as const }; };
  const client = {
    async account() { calls.push('account'); return accountHook(); },
    async historyProgress() { calls.push('progress'); return progressHook(); },
    async reportHistoryPosition(input: any) { calls.push('post'); posts.push({ ...input });
      assert.equal(saved.entries.at(-1).state, 'pending', 'a durable pending record must precede the sole POST');
      return postHook(input); },
  } as Pick<BiliClientContract, 'account' | 'historyProgress' | 'reportHistoryPosition'>;
  const options: HistorySyncOptions = { config: () => config, account: () => account, identity: () => identity, now: () => now,
    check: (expected, options) => { if (options.signal?.aborted) throw new BiliError('cancelled'); if (expected !== identity) throw new BiliError('account_changed'); },
    readLedger: async () => saved, saveLedger: async value => { await saveHook(value); saved = structuredClone(value); },
    record: async (_session, eventId) => { records.push(eventId); } };
  const history = new HistorySync(client, options);
  const prove = (at = 12.8, session = 'synthetic-session') => history.prove(session, identity, video, video.parts[0], prepared(at), { fromSeconds: 10, toSeconds: 20 });
  const mark = (watchRef: string, operationId = 'synthetic-operation', session = 'synthetic-session') =>
    history.mark({ watchRef, operationId }, session, { cookie: account?.cookie, signal: controller.signal }, identity);
  return { history, options, client, config, controller, calls, posts, records, prove, mark,
    get saved() { return saved; }, get identity() { return identity; }, setSaved: (value: unknown) => { saved = value; },
    advance: () => { now += 86400000; }, logout: () => { account = undefined; identity = 'logged-out'; },
    changeAccount: () => { account = { ...account!, mid: 2, revision: 'revision-2' }; identity = 'revision-2'; },
    remote: (value: unknown) => { remote = value; }, onSave: (fn: typeof saveHook) => { saveHook = fn; },
    onAccount: (fn: typeof accountHook) => { accountHook = fn; }, onProgress: (fn: typeof progressHook) => { progressHook = fn; },
    onPost: (fn: typeof postHook) => { postHook = fn; } };
}
const code = (expected: string) => (error: any) => error instanceof BiliError && error.code === expected;

test('watch proofs require enabled logged-in actual JPEG frames and matching coverage, with bounded expiry and capacity', async t => {
  const f = fixture(); t.after(() => f.history.dispose()); await f.history.initialize();
  f.config.historySyncEnabled = false; assert.equal(f.prove(), undefined);
  f.config.historySyncEnabled = true;
  const invalid: PreparedMedia[] = [
    { ...prepared(), images: [] }, { ...prepared(), coverage: { fromSeconds: 0, toSeconds: 20 } },
    prepared(21), prepared(NaN), { ...prepared(), images: [{ ...prepared().images[0], frames: [] }] },
    { ...prepared(), images: [{ ...prepared().images[0], base64: Buffer.from('not-an-image').toString('base64') }] },
  ];
  for (const value of invalid) assert.equal(f.history.prove('synthetic-session', f.identity, video, video.parts[0], value, { fromSeconds: 10, toSeconds: 20 }), undefined);
  assert.equal(f.history.prove('synthetic-session', f.identity, video, video.parts[0], prepared(120, 110, 120), { fromSeconds: 110, toSeconds: 120 }), undefined,
    'an end marker cannot claim completion');
  for (let i = 0; i < 32; i++) assert.match(f.prove()!, /^bili_watch_/);
  assert.equal(f.prove(), undefined, 'proof capacity must not make safe watch fail');
  f.advance(); assert.match(f.prove()!, /^bili_watch_/); assert.equal(f.history.status.proofs, 1);
  f.config.historySyncEnabled = false; assert.equal(f.history.status.proofs, 0);
  f.config.historySyncEnabled = true; assert.match(f.prove()!, /^bili_watch_/);
  f.logout(); assert.equal(f.prove(), undefined); assert.equal(f.history.status.proofs, 0);
  assert.deepEqual(f.calls, []);
});

test('history writes use the last actual sample, persist before POST and only record a verified result', async t => {
  const f = fixture(); t.after(() => f.history.dispose()); await f.history.initialize();
  const watchRef = f.prove()!, result = await f.mark(watchRef);
  assert.deepEqual(result, { state: 'verified', positionSeconds: 12, experienceRecorded: true });
  assert.deepEqual(f.posts, [{ aid: 123, cid: 456, positionSeconds: 12 }]);
  assert.deepEqual(f.calls, ['account', 'progress', 'post', 'progress']); assert.equal(f.records.length, 1);
  const serialized = JSON.stringify(f.saved);
  for (const marker of [watchRef, 'synthetic-session', 'synthetic-operation', 'SYNTHETIC', video.bvid, video.title]) assert.ok(!serialized.includes(marker));
  assert.equal(f.saved.entries[0].state, 'verified'); assert.equal(f.saved.entries[0].submitted, true);
});

test('raw progress, forged references, different sessions, changed accounts and expired proof cannot reach account IO', async t => {
  const f = fixture(); t.after(() => f.history.dispose()); await f.history.initialize();
  const ref = f.prove()!;
  await assert.rejects(f.history.mark({ watchRef: ref, operationId: 'op', progress: 119 } as any, 'synthetic-session', {}, f.identity), code('invalid_input'));
  await assert.rejects(f.mark('bili_watch_forged'), code('reference_unavailable'));
  await assert.rejects(f.mark(ref, 'op', 'other-session'), code('reference_unavailable'));
  f.advance(); await assert.rejects(f.mark(ref), code('reference_unavailable'));
  const fresh = f.prove()!; f.changeAccount(); await assert.rejects(f.mark(fresh), code('reference_unavailable'));
  assert.deepEqual(f.calls, []);
});

test('same operation and equivalent sampling receipts deduplicate, and an operation cannot change its position', async t => {
  const f = fixture(); t.after(() => f.history.dispose()); await f.history.initialize();
  const ref = f.prove()!; await f.mark(ref);
  assert.equal((await f.mark(ref)).duplicate, true);
  assert.equal((await f.mark(f.prove()!, 'another-operation')).duplicate, true);
  await assert.rejects(f.mark(f.prove(15.2)!, 'synthetic-operation'), code('invalid_input'));
  await assert.rejects(f.mark(f.prove(15.2)!, 'another-operation'), code('invalid_input'));
  assert.equal(f.posts.length, 1);
  assert.ok(f.records.every(event => event === f.records[0]), 'memory retries must use the same idempotent event identity');
});

test('accepted write survives failed readback or cancellation and a duplicate only rereads history', async t => {
  const f = fixture(); t.after(() => f.history.dispose()); await f.history.initialize();
  let reads = 0;
  f.onProgress(async () => { if (++reads > 1) throw new BiliError('network_error'); return { found: false }; });
  const ref = f.prove()!;
  assert.equal((await f.mark(ref)).state, 'accepted'); assert.equal(f.records.length, 0);
  assert.equal((await f.mark(ref, 'another-operation')).state, 'accepted'); assert.equal(f.posts.length, 1);
  f.onProgress(async () => ({ found: true, progressSeconds: 12, completed: false }));
  assert.equal((await f.mark(ref)).state, 'verified'); assert.equal(f.posts.length, 1);

  const g = fixture(); t.after(() => g.history.dispose()); await g.history.initialize();
  g.onPost(async () => { g.controller.abort(); return { state: 'accepted' }; });
  assert.equal((await g.mark(g.prove()!)).state, 'accepted'); assert.equal(g.posts.length, 1); assert.equal(g.records.length, 0);
});

test('pending restart and uncertain transport are never retried, while a clearly rejected attempt requires a new operation', async t => {
  const f = fixture(); t.after(() => f.history.dispose()); await f.history.initialize();
  f.onPost(async () => { throw new BiliError('uncertain'); });
  assert.equal((await f.mark(f.prove()!)).state, 'uncertain');
  assert.equal((await f.mark(f.prove()!, 'another-operation')).state, 'uncertain'); assert.equal(f.posts.length, 1);
  const restarted = new HistorySync(f.client, f.options); t.after(() => restarted.dispose());
  const saved = structuredClone(f.saved); saved.entries.forEach((e: any) => { e.state = 'pending'; }); f.setSaved(saved);
  await restarted.initialize();
  const ref = restarted.prove('synthetic-session', f.identity, video, video.parts[0], prepared(), { fromSeconds: 10, toSeconds: 20 })!;
  assert.equal((await restarted.mark({ watchRef: ref, operationId: 'third-operation' }, 'synthetic-session', {}, f.identity)).state, 'uncertain');
  assert.equal(f.posts.length, 1);

  const g = fixture(); t.after(() => g.history.dispose()); await g.history.initialize();
  g.onPost(async () => { throw new BiliError('platform_error'); });
  const rejected = g.prove()!;
  assert.equal((await g.mark(rejected)).state, 'rejected'); assert.equal((await g.mark(rejected)).state, 'rejected'); assert.equal(g.posts.length, 1);
  assert.equal((await g.mark(rejected, 'new-operation')).state, 'rejected'); assert.equal(g.posts.length, 2);
});

test('remote progress and submitted higher positions prevent rollback without inventing verified playback', async t => {
  for (const remote of [{ found: true, progressSeconds: 30, completed: false }, { found: true, progressSeconds: null, completed: true }]) {
    const f = fixture(); t.after(() => f.history.dispose()); await f.history.initialize(); f.remote(remote);
    assert.equal((await f.mark(f.prove()!)).state, 'already_recorded'); assert.equal(f.posts.length, 0); assert.equal(f.records.length, 0);
    assert.equal(f.saved.entries[0].submitted, false);
    await assert.rejects(f.mark(f.prove(15.2)!), code('invalid_input'));
  }
  const f = fixture(); t.after(() => f.history.dispose()); await f.history.initialize();
  f.onProgress(async () => ({ found: false }));
  assert.equal((await f.mark(f.prove(18.2)!)).state, 'accepted');
  const lower = await f.mark(f.prove(12.8)!, 'lower-operation');
  assert.equal(lower.state, 'accepted'); assert.equal(lower.duplicate, true); assert.equal(lower.positionSeconds, 18);
  await assert.rejects(f.mark(f.prove(15.2)!, 'lower-operation'), code('invalid_input'));
  assert.equal((await f.mark(f.prove(12.8)!, 'lower-operation')).state, 'accepted');
  assert.equal(f.saved.entries.at(-1).submitted, false); assert.match(f.saved.entries.at(-1).aliasOf, /^[a-f0-9]{64}$/);
  assert.equal(f.posts.length, 1); assert.equal(f.records.length, 0);
});

test('account, cancellation and config checks between preparation awaits stop new POSTs', async t => {
  for (const boundary of ['account', 'progress', 'save', 'disabled', 'toggle-cycle']) {
    const f = fixture(); t.after(() => f.history.dispose()); await f.history.initialize(); const ref = f.prove()!;
    if (boundary === 'account') f.onAccount(async () => { f.changeAccount(); return { mid: 1, name: 'Synthetic' }; });
    if (boundary === 'progress') f.onProgress(async () => { f.controller.abort(); return { found: false }; });
    if (boundary === 'save') f.onSave(async value => { if (value.entries.at(-1).state === 'pending') f.controller.abort(); });
    if (boundary === 'disabled') f.config.historySyncEnabled = false;
    if (boundary === 'toggle-cycle') f.onProgress(async () => { f.config.historySyncEnabled = false; f.history.clearProofs(); f.config.historySyncEnabled = true; return { found: false }; });
    await assert.rejects(f.mark(ref), code(boundary === 'account' ? 'account_changed' : boundary === 'disabled' ? 'history_disabled' : boundary === 'toggle-cycle' ? 'reference_unavailable' : 'cancelled'));
    assert.equal(f.posts.length, 0, boundary);
  }
});

test('corrupt or failed durable state blocks new submissions; post-acceptance persistence failure preserves the outcome', async t => {
  const f = fixture(); t.after(() => f.history.dispose()); f.setSaved({ entries: [{ state: 'verified', cookie: 'SYNTHETIC' }] });
  await f.history.initialize(); assert.equal(f.history.ready, false); assert.equal(f.prove(), undefined); assert.equal(f.posts.length, 0);
  const g = fixture(); t.after(() => g.history.dispose()); await g.history.initialize(); const ref = g.prove()!;
  g.onSave(async () => { throw Error('SYNTHETIC_SAVE_FAILURE'); });
  await assert.rejects(g.mark(ref), code('persistence_error')); assert.equal(g.posts.length, 0); assert.equal(g.history.ready, false);
  const h = fixture(); t.after(() => h.history.dispose()); await h.history.initialize();
  h.onSave(async value => { if (value.entries.at(-1).state !== 'pending') throw Error('SYNTHETIC_SAVE_FAILURE'); });
  h.onProgress(async () => ({ found: false }));
  assert.equal((await h.mark(h.prove()!)).state, 'accepted'); assert.equal(h.history.ready, false); assert.equal(h.posts.length, 1);
});
