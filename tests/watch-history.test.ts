/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolSession } from 'whalelife';
import { BiliRuntime, type RuntimeOptions } from '../src/runtime.ts';
import { defaults } from '../src/config.ts';
import { BiliError } from '../src/errors.ts';
import type { AccountState, BiliClientContract, PreparedMedia, VideoDetails } from '../src/types.ts';

const video: VideoDetails = { bvid: 'BV1xx411c7mD', aid: 123, cid: 456, duration: 120,
  title: 'SYNTHETIC_WATCH_TITLE', description: 'SYNTHETIC_WATCH_DESCRIPTION', owner: { mid: 789, name: 'Synthetic' },
  cover: 'https://i0.hdslb.com/synthetic.jpg', url: 'https://www.bilibili.com/video/BV1xx411c7mD',
  parts: [{ cid: 456, page: 1, title: 'Synthetic part', duration: 120 }] };
function sampled(at = 12.8): PreparedMedia {
  return { images: [{ mime: 'image/jpeg', base64: Buffer.from([255, 216, 255, 217]).toString('base64'), width: 1, height: 1, frames: [{ atSeconds: at }] }],
    coverage: { fromSeconds: 10, toSeconds: 20, timelineComplete: false }, warnings: [] };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(t: TestContext) {
  const config = { ...structuredClone(defaults), historySyncEnabled: true }, controller = new AbortController();
  const session: ToolSession = { id: 'synthetic-session', permission: 'full', signal: controller.signal };
  let account: AccountState | undefined = { mid: 1, name: 'Synthetic', cookie: 'SYNTHETIC_WATCH_COOKIE', revision: 'revision-1' };
  let saved: any = {}, remote: any = { found: false }, prepared = sampled();
  const calls: string[] = [], posts: any[] = [], records: string[] = [];
  let saveHook = async (_value: any) => {}, accountHook = async () => ({ mid: account!.mid, name: 'Synthetic' });
  let progressHook = async () => structuredClone(remote), prepareHook = async () => prepared;
  let postHook = async (input: any) => { remote = { found: true, progressSeconds: input.positionSeconds, completed: false }; return { state: 'accepted' as const }; };
  const client = { dispose() {},
    async video() { return structuredClone(video); },
    async subtitles() { return { tracks: [], loginRequired: false }; },
    async comments() { return { items: [], hasMore: false }; },
    async media() { return { bytes: Buffer.from('SYNTHETIC_MEDIA'), mime: 'video/mp4' }; },
    async account() { calls.push('account'); return accountHook(); },
    async historyProgress() { calls.push('progress'); return progressHook(); },
    async reportHistoryPosition(input: any) { calls.push('post'); posts.push({ ...input });
      assert.equal(saved.entries.at(-1).state, 'pending'); return postHook(input); },
  } as unknown as BiliClientContract;
  const options: RuntimeOptions = { config: () => config, account: () => account, now: () => 1000,
    signal: new AbortController().signal, transient: true, readLedger: async () => ({}), saveLedger: async () => {},
    readHistoryLedger: async () => saved, saveHistoryLedger: async value => { await saveHook(value); saved = structuredClone(value); },
    recordHistory: async (_session, eventId) => { records.push(eventId); } };
  const create = () => {
    const runtime = new BiliRuntime(client, { status: () => ({}), settings: () => ({ timeoutMs: 5000, concurrency: 4, hasProxy: false }), search: async () => ({}) }, options);
    t.after(() => runtime.dispose());
    runtime.setVision({ signal: new AbortController().signal, effect: (create: any) => create(), service: {
      status: () => ({}), offerMedia: async () => ({ mediaRef: 'SYNTHETIC_PRIVATE_MEDIA', expiresAt: new Date(1000000).toISOString(), info: {} }),
      release: async () => ({}), prepare: async () => prepareHook(),
    } } as any);
    return runtime;
  };
  const runtime = create();
  const open = async (which = runtime, current = session) => {
    const result: any = await which.read('open', { target: video.bvid }, current);
    assert.equal(result.content.status, 'ok'); return result.content.data.videoRef as string;
  };
  const watch = (videoRef: string, current = session, which = runtime) => which.watch({ videoRef, fromSeconds: 10, toSeconds: 20 }, current);
  return { runtime, create, options, config, session, controller, calls, posts, records, open, watch,
    get saved() { return saved; }, setSaved(value: unknown) { saved = value; }, setPrepared(value: PreparedMedia) { prepared = value; },
    logout() { account = undefined; }, changeAccount() { account = { ...account!, mid: 2, revision: 'revision-2' }; },
    onSave(fn: typeof saveHook) { saveHook = fn; }, onAccount(fn: typeof accountHook) { accountHook = fn; },
    onProgress(fn: typeof progressHook) { progressHook = fn; }, onPost(fn: typeof postHook) { postHook = fn; },
    onPrepare(fn: typeof prepareHook) { prepareHook = fn; }, remote(value: unknown) { remote = value; } };
}
function inspect(result: any) {
  const data = JSON.parse(result.content[0].text);
  assert.deepEqual(result.receipt.historySync, data.historySync, 'metadata and durable receipt must report the same history result');
  return { data, history: data.historySync, receipt: result.receipt, images: result.content.filter((part: any) => part.type === 'image') };
}

test('one watch prepares frames and completes one verified history submission without a second tool', async t => {
  const f = fixture(t); await f.runtime.initialize(); const result = await f.watch(await f.open()), value = inspect(result);
  assert.equal(value.receipt.status, 'completed'); assert.equal(value.images.length, 1);
  assert.deepEqual(value.history, { state: 'verified', positionSeconds: 12, experienceRecorded: true });
  assert.match(value.data.watchRef, /^bili_watch_/);
  assert.deepEqual(f.posts, [{ aid: 123, cid: 456, positionSeconds: 12 }]);
  assert.deepEqual(f.calls, ['account', 'progress', 'post', 'progress']); assert.equal(f.records.length, 1);
  for (const marker of [video.title, video.description, video.bvid, f.session.id, 'SYNTHETIC_WATCH_COOKIE', value.data.watchRef])
    assert.ok(!JSON.stringify(result.receipt).includes(marker) && !JSON.stringify(f.saved).includes(marker));
});

test('disabled, anonymous, non-full and unproven watches retain frames with explicit skip reasons and no history IO', async t => {
  for (const reason of ['history_disabled', 'login_required', 'permission_required', 'sampling_unavailable']) {
    const f = fixture(t); await f.runtime.initialize();
    if (reason === 'history_disabled') f.config.historySyncEnabled = false;
    if (reason === 'login_required') f.logout();
    if (reason === 'permission_required') f.session.permission = 'ask';
    if (reason === 'sampling_unavailable') f.setPrepared({ ...sampled(), coverage: {} });
    const value = inspect(await f.watch(await f.open()));
    assert.deepEqual(value.history, { state: 'skipped', reason }); assert.equal(value.images.length, 1);
    assert.deepEqual(f.calls, []); assert.deepEqual(f.saved, {});
  }
});

test('opening metadata, reading subtitles and comments do not write history', async t => {
  const f = fixture(t); await f.runtime.initialize(); const videoRef = await f.open();
  for (const action of ['subtitles', 'comments']) assert.equal((await f.runtime.read(action, { videoRef }, f.session) as any).content.status, 'ok');
  assert.deepEqual(f.calls, []); assert.deepEqual(f.saved, {});
});

test('history preparation or submission failure does not discard successful video frames', async t => {
  for (const fault of ['account', 'progress', 'save', 'rejected', 'uncertain', 'readback']) {
    const f = fixture(t); await f.runtime.initialize();
    if (fault === 'account') f.onAccount(async () => { throw new BiliError('network_error'); });
    if (fault === 'progress') f.onProgress(async () => { throw new BiliError('network_error'); });
    if (fault === 'save') f.onSave(async () => { throw Error('SYNTHETIC_SAVE_ERROR'); });
    if (fault === 'rejected') f.onPost(async () => { throw new BiliError('access_blocked'); });
    if (fault === 'uncertain') f.onPost(async () => { throw new BiliError('uncertain'); });
    if (fault === 'readback') { let n = 0; f.onProgress(async () => { if (++n > 1) throw new BiliError('network_error'); return { found: false }; }); }
    const value = inspect(await f.watch(await f.open()));
    assert.equal(value.receipt.status, 'completed', fault); assert.equal(value.images.length, 1, fault);
    assert.equal(value.history.state, ['rejected', 'uncertain'].includes(fault) ? fault : fault === 'readback' ? 'accepted' : 'error');
    assert.equal(f.records.length, 0);
  }
});

test('invalid history ledger reports an error while preserving video frames', async t => {
  const f = fixture(t); f.setSaved({ entries: [{ state: 'invalid' }] }); await f.runtime.initialize();
  const value = inspect(await f.watch(await f.open()));
  assert.deepEqual(value.history, { state: 'error', code: 'persistence_error' }); assert.equal(value.images.length, 1); assert.deepEqual(f.calls, []);
});

test('equal sampling uses one stable operation across concurrent watches, reload and legacy manual follow-up', async t => {
  const f = fixture(t); await f.runtime.initialize(); const ref = await f.open();
  const results = await Promise.all([f.watch(ref), f.watch(ref)]), values = results.map(inspect);
  assert.equal(f.posts.length, 1); assert.equal(values[1].history.duplicate, true); assert.equal(f.saved.entries.length, 1);
  const manual: any = await f.runtime.markHistory({ watchRef: values[0].data.watchRef, operationId: 'SYNTHETIC_LEGACY_OPERATION' }, f.session);
  assert.equal(manual.content.data.duplicate, true); assert.equal(f.posts.length, 1);
  const restarted = f.create(); await restarted.initialize();
  const again = inspect(await f.watch(await f.open(restarted), f.session, restarted));
  assert.equal(again.history.duplicate, true); assert.equal(f.posts.length, 1); assert.equal(f.saved.entries.length, 2);
});

test('automatic repeats never resubmit rejected, uncertain or pending-restored samples', async t => {
  for (const state of ['rejected', 'uncertain', 'pending']) {
    const f = fixture(t); await f.runtime.initialize();
    f.onPost(async () => { throw new BiliError(state === 'rejected' ? 'access_blocked' : 'uncertain'); });
    const ref = await f.open(); await f.watch(ref); await f.watch(ref); assert.equal(f.posts.length, 1, state);
    if (state === 'pending') { const saved = structuredClone(f.saved); saved.entries[0].state = 'pending'; f.setSaved(saved); }
    const restarted = f.create(); await restarted.initialize();
    const value = inspect(await f.watch(await f.open(restarted), f.session, restarted));
    assert.equal(value.history.state, state === 'pending' ? 'uncertain' : state); assert.equal(value.history.duplicate, true);
    assert.equal(f.posts.length, 1, state);
  }
});

test('a later real sample advances position but an already greater remote position is not overwritten', async t => {
  const f = fixture(t); await f.runtime.initialize(); const ref = await f.open(); await f.watch(ref);
  f.setPrepared(sampled(18.4)); assert.equal(inspect(await f.watch(ref)).history.positionSeconds, 18);
  assert.deepEqual(f.posts.map(row => row.positionSeconds), [12, 18]);
  const g = fixture(t); g.remote({ found: true, progressSeconds: 50, completed: false }); await g.runtime.initialize();
  assert.equal(inspect(await g.watch(await g.open())).history.state, 'already_recorded');
  assert.equal(g.posts.length, 0); assert.equal(g.records.length, 0);
});

test('cancellation or account changes before and during preparation prevent history submission', async t => {
  for (const at of ['prepare', 'account', 'progress', 'pending-save']) {
    const f = fixture(t); await f.runtime.initialize();
    if (at === 'prepare') f.onPrepare(async () => { f.controller.abort(); return sampled(); });
    if (at === 'account') f.onAccount(async () => { f.changeAccount(); return { mid: 1, name: 'Synthetic' }; });
    if (at === 'progress') f.onProgress(async () => { f.controller.abort(); return { found: false }; });
    if (at === 'pending-save') f.onSave(async () => { f.controller.abort(); });
    const value = inspect(await f.watch(await f.open()));
    assert.equal(value.receipt.status, 'error', at); assert.equal(value.images.length, 0, at); assert.equal(f.posts.length, 0, at);
    assert.equal(value.receipt.code, at === 'account' ? 'account_changed' : 'cancelled');
  }
});

test('accepted history remains visible when cancellation, account changes or stop occur after POST', async t => {
  for (const boundary of ['cancel', 'account', 'stop']) {
    const f = fixture(t); await f.runtime.initialize();
    f.onPost(async () => { if (boundary === 'cancel') f.controller.abort(); else if (boundary === 'account') f.changeAccount(); else await f.runtime.dispose(); return { state: 'accepted' }; });
    const value = inspect(await f.watch(await f.open()));
    assert.equal(value.receipt.status, 'error'); assert.equal(value.images.length, 0);
    assert.equal(value.history.state, 'accepted'); assert.equal(f.posts.length, 1); assert.equal(f.records.length, 0);
    assert.deepEqual(f.calls, ['account', 'progress', 'post'], 'no readback may start after the invalidation');
  }
});

test('turning synchronization off during preflight or after acceptance stops later history IO', async t => {
  const f = fixture(t); await f.runtime.initialize();
  f.onProgress(async () => { f.config.historySyncEnabled = false; f.runtime.invalidateHistoryProofs(); return { found: false }; });
  const before = inspect(await f.watch(await f.open()));
  assert.equal(before.history.code, 'history_disabled'); assert.equal(before.images.length, 1); assert.equal(f.posts.length, 0);
  const g = fixture(t); await g.runtime.initialize();
  g.onPost(async () => { g.config.historySyncEnabled = false; g.runtime.invalidateHistoryProofs(); return { state: 'accepted' }; });
  const after = inspect(await g.watch(await g.open()));
  assert.equal(after.history.state, 'accepted'); assert.equal(after.images.length, 1); assert.deepEqual(g.calls, ['account', 'progress', 'post']);
});

test('queued automatic synchronization rechecks permission and cancellation before starting IO', async t => {
  for (const boundary of ['permission', 'cancel']) {
    const f = fixture(t); await f.runtime.initialize(); const ref = await f.open(), entered = deferred(), release = deferred();
    f.onAccount(async () => { entered.resolve(); await release.promise; return { mid: 1, name: 'Synthetic' }; });
    const first = f.watch(ref); await entered.promise;
    const secondController = new AbortController(), secondSession = { ...f.session, signal: secondController.signal };
    const second = f.watch(ref, secondSession); await new Promise(resolve => setImmediate(resolve));
    if (boundary === 'permission') secondSession.permission = 'ask'; else secondController.abort();
    release.resolve(); await first; const value = inspect(await second);
    assert.equal(f.posts.length, 1); assert.equal(f.calls.filter(call => call === 'account').length, 1);
    if (boundary === 'permission') { assert.deepEqual(value.history, { state: 'skipped', reason: 'permission_required' }); assert.equal(value.images.length, 1); }
    else { assert.equal(value.receipt.code, 'cancelled'); assert.equal(value.history.code, 'cancelled'); assert.equal(value.images.length, 0); }
  }
});
