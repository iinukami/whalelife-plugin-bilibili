/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BiliRuntime } from '../src/runtime.ts';
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
  const options = { signal: controller.signal, transient: true, config: () => config, account: () => account, now: () => now, readLedger: async () => saved, saveLedger: async (value: unknown) => { await saveHook(); saved = structuredClone(value); } };
  const runtime = new BiliRuntime(client, { status: () => ({}), settings: () => ({ timeoutMs: 5000, concurrency: 2, hasProxy: false }), search: async () => ({}) }, options);
  return { runtime, options, client, controller, config, get saved() { return saved; }, get calls() { return calls; },
    login() { account = { cookie: 'SYNTHETIC_COOKIE', mid: 1, name: 'Synthetic', revision: 'revision-1' }; }, changeAccount() { account = { cookie: 'SYNTHETIC_NEW_COOKIE', mid: 2, name: 'Other', revision: 'revision-2' }; },
    advance() { now += 9999999; }, behavior(value: () => Promise<any>) { behavior = value; }, onSave(value: () => Promise<void>) { saveHook = value; } };
}
async function open(f: ReturnType<typeof fixture>) { const result: any = await f.runtime.read('open', { target: video.bvid }, session); assert.equal(result.content.status, 'ok'); return result.content.data.videoRef; }

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
