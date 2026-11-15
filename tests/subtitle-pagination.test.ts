/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BiliRuntime } from '../src/runtime.ts';
import { defaults } from '../src/config.ts';
import { BiliError } from '../src/errors.ts';
import type { AccountState, BiliClientContract, CallOptions, SubtitleCue, SubtitleTrack, VideoDetails } from '../src/types.ts';

const BV = 'BV1xx411c7mD';
const video: VideoDetails = { bvid: BV, aid: 123, cid: 456, title: 'Synthetic title', description: 'Synthetic description', duration: 200,
  owner: { mid: 789, name: 'Synthetic author' }, cover: 'https://i0.hdslb.com/synthetic.jpg', url: 'https://www.bilibili.com/video/' + BV,
  parts: [{ page: 1, cid: 456, title: 'Synthetic part 1', duration: 200 }, { page: 2, cid: 457, title: 'Synthetic part 2', duration: 200 }] };
const session = { id: 'synthetic-subtitle-session', permission: 'full' as const };
const tracks = (languages = ['ai-zh']): SubtitleTrack[] => languages.map((language, i) => ({ id: String(i + 1), language, label: 'Synthetic ' + language,
  url: 'https://aisubtitle.hdslb.com/SECRET_' + language + '.json?auth_key=SECRET_SIGNATURE' }));
const cues = (prefix = 'SYNTHETIC_A', length = 130): SubtitleCue[] => Array.from({ length }, (_, i) => ({ from: i, to: i + 0.8, text: prefix + '_' + i }));
function fixture() {
  let now = 1000, account: AccountState | undefined, preparations = 0, body = cues(), found = tracks();
  const controller = new AbortController(), config = structuredClone(defaults);
  const calls = { video: 0, tracks: [] as { bvid: string; cid: number }[], body: [] as string[], writes: 0 };
  let videoHook: (options: CallOptions) => Promise<VideoDetails> = async () => structuredClone(video);
  let trackHook: (options: CallOptions) => Promise<void> = async () => {};
  let bodyHook: (options: CallOptions) => Promise<void> = async () => {};
  const client = {
    async video(_target: string, options: CallOptions) { calls.video++; return videoHook(options); },
    async feed() { const { parts: _parts, cid: _cid, description: _description, ...item } = structuredClone(video); return { items: [item], hasMore: false }; },
    async subtitles(bvid: string, cid: number, options: CallOptions) { calls.tracks.push({ bvid, cid }); await trackHook(options); return { tracks: found, loginRequired: false }; },
    async subtitle(url: string, options: CallOptions) { calls.body.push(url); await bodyHook(options); return body; }, dispose() {},
  } as unknown as BiliClientContract;
  const runtime = new BiliRuntime(client, { status: () => ({}), settings: () => ({ timeoutMs: 1000, concurrency: 4, hasProxy: false }), search: async () => ({}) }, {
    signal: controller.signal, transient: true, config: () => config, account: () => account, now: () => now,
    prepareAccount: async () => { preparations++; }, readLedger: async () => ({}), saveLedger: async () => { calls.writes++; },
  });
  return { runtime, calls, config, controller, get preparations() { return preparations; }, get body() { return body; },
    setBody: (value: SubtitleCue[]) => { body = value; }, setTracks: (value: SubtitleTrack[]) => { found = value; },
    onVideo: (hook: typeof videoHook) => { videoHook = hook; }, onTracks: (hook: typeof trackHook) => { trackHook = hook; }, onBody: (hook: typeof bodyHook) => { bodyHook = hook; },
    advance: () => { now += 1900000; }, login: (revision: string) => { account = { mid: 123, name: 'Synthetic account', cookie: 'SYNTHETIC_COOKIE', revision }; },
  };
}
async function open(f: ReturnType<typeof fixture>, targetSession = session) {
  const result: any = await f.runtime.read('open', { target: BV }, targetSession); assert.equal(result.content.status, 'ok'); return result.content.data.videoRef as string;
}
async function page(f: ReturnType<typeof fixture>, videoRef: string, args: Record<string, unknown> = {}, targetSession: typeof session & { signal?: AbortSignal } = session) {
  return await f.runtime.read('subtitles', { videoRef, ...args }, targetSession) as any;
}
function data(result: any) { assert.equal(result.content.status, 'ok'); assert.deepEqual(result.receipt, { action: 'bilibili_subtitles', status: 'ok' }); return result.content.data; }
function failure(result: any, code: string) { assert.equal(result.content.status, 'error'); assert.equal(result.content.error.code, code); assert.equal(result.receipt.code, code); }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('default tracks prefer AI Chinese then simplified Chinese then other Chinese; explicit language is strict', async t => {
  for (const [languages, expected] of [
    [['en', 'zh-TW', 'zh-CN', 'ai-zh'], 'ai-zh'], [['en', 'zh-TW', 'zh-CN'], 'zh-CN'], [['en', 'zh-TW'], 'zh-TW'], [['en', 'ja'], 'en'],
  ] as [string[], string][]) {
    const f = fixture(); t.after(() => f.runtime.dispose()); await f.runtime.initialize(); f.setTracks(tracks(languages));
    const ref = await open(f); assert.equal(data(await page(f, ref)).language, expected);
    assert.equal(data(await page(f, ref, { language: 'en' })).language, 'en');
    failure(await page(f, ref, { language: 'missing-language' }), 'invalid_input'); assert.equal(f.calls.body.length, 2);
  }
});

test('all pages including offset zero reuse one independent snapshot; a newly opened reference refreshes it', async t => {
  const f = fixture(); t.after(() => f.runtime.dispose()); await f.runtime.initialize(); const ref = await open(f);
  const first = data(await page(f, ref)); assert.equal(first.cues.length, 60); assert.equal(first.nextOffset, 60);
  first.cues[0].text = 'MUTATED_CALLER_COPY'; first.tracks[0].language = 'MUTATED_CALLER_TRACK'; f.body[60].text = 'MUTATED_PROVIDER_COPY';
  f.setBody(cues('SYNTHETIC_B', 70)); f.setTracks(tracks(['en']));
  const second = data(await page(f, ref, { offset: 60 })); assert.equal(second.cues[0].text, 'SYNTHETIC_A_60'); assert.equal(second.nextOffset, 120);
  const tail = data(await page(f, ref, { offset: 120 })); assert.equal(tail.cues.length, 10); assert.equal(tail.nextOffset, undefined);
  assert.equal(data(await page(f, ref)).cues[0].text, 'SYNTHETIC_A_0'); assert.equal(data(await page(f, ref)).tracks[0].language, 'ai-zh');
  assert.equal(data(await page(f, ref, { offset: 999 })).cues.length, 0);
  assert.equal(f.calls.tracks.length, 1); assert.equal(f.calls.body.length, 1);
  const refreshed = data(await page(f, await open(f))); assert.equal(refreshed.cues[0].text, 'SYNTHETIC_B_0'); assert.equal(refreshed.language, 'en');
  assert.equal(f.calls.body.length, 2); assert.equal(f.calls.writes, 0);
  assert.equal(JSON.stringify(second).includes('auth_key'), false); assert.equal(JSON.stringify(second).includes('SECRET_'), false);
});

test('part, requested language and trusted session separate snapshots without allowing another session to reuse a reference', async t => {
  const f = fixture(); t.after(() => f.runtime.dispose()); await f.runtime.initialize(); f.setTracks(tracks(['ai-zh', 'en'])); const ref = await open(f);
  data(await page(f, ref)); data(await page(f, ref, { part: 2 })); data(await page(f, ref, { language: 'en' }));
  assert.deepEqual(f.calls.tracks.map(call => call.cid), [456, 457, 456]);
  failure(await page(f, ref, {}, { ...session, id: 'other-synthetic-session' }), 'reference_unavailable'); assert.equal(f.calls.body.length, 3);
  const other = await open(f, { ...session, id: 'other-synthetic-session' });
  data(await page(f, other, {}, { ...session, id: 'other-synthetic-session' })); assert.equal(f.calls.body.length, 4);
});

test('invalid paging syntax is rejected before account preparation or any client call', async t => {
  const f = fixture(); t.after(() => f.runtime.dispose()); await f.runtime.initialize(); const ref = await open(f); const baseline = f.preparations;
  for (const args of [{ part: 0 }, { part: 1.5 }, { part: 101 }, { offset: -1 }, { offset: 1.5 }, { offset: 100001 }, { language: '' }, { language: 42 }])
    failure(await page(f, ref, args), 'invalid_input');
  assert.equal(f.preparations, baseline); assert.equal(f.calls.video, 1); assert.equal(f.calls.tracks.length, 0); assert.equal(f.calls.body.length, 0);
  failure(await page(f, ref, { part: 3 }), 'invalid_input'); assert.equal(f.calls.tracks.length, 0);
});

test('list references reject a details response for a different BVID or AID before fetching tracks', async t => {
  for (const patch of [{ bvid: 'BV2xx411c7mD' }, { aid: 999 }]) {
    const f = fixture(); t.after(() => f.runtime.dispose()); await f.runtime.initialize();
    const list: any = await f.runtime.read('browse', { source: 'recommended' }, session); const ref = list.content.data.items[0].videoRef;
    f.onVideo(async options => { options.assertCurrent?.(); return { ...structuredClone(video), ...patch }; });
    failure(await page(f, ref), 'malformed_response'); assert.equal(f.calls.tracks.length, 0); assert.equal(f.calls.body.length, 0);
    f.onVideo(async () => structuredClone(video)); data(await page(f, ref)); assert.equal(f.calls.video, 2);
  }
});

test('empty track results are stable per reference and report the current audio switch without downloading', async t => {
  const f = fixture(); t.after(() => f.runtime.dispose()); await f.runtime.initialize(); f.setTracks([]); const ref = await open(f);
  assert.equal(data(await page(f, ref)).available, false); f.setTracks(tracks()); f.config.audioEnabled = true;
  assert.equal(data(await page(f, ref, { offset: 60 })).audioEnabled, true); assert.equal(f.calls.tracks.length, 1); assert.equal(f.calls.body.length, 0);
  assert.equal(data(await page(f, await open(f))).available, true);
});

test('snapshot bounds preserve live pages, reject a ninth key before IO and release expired entries', async t => {
  const f = fixture(); t.after(() => f.runtime.dispose()); await f.runtime.initialize(); const refs: string[] = [];
  for (let i = 0; i < 8; i++) { const ref = await open(f); refs.push(ref); data(await page(f, ref)); }
  failure(await page(f, await open(f)), 'busy'); assert.equal(f.calls.tracks.length, 8); assert.equal(f.calls.body.length, 8);
  assert.equal(data(await page(f, refs[0], { offset: 60 })).cues[0].text, 'SYNTHETIC_A_60'); assert.equal(f.calls.body.length, 8);
  f.advance(); failure(await page(f, refs[0]), 'reference_unavailable'); data(await page(f, await open(f))); assert.equal(f.calls.body.length, 9);
});

test('cue count and text bounds reject oversized snapshots and permit a fresh retry of the same key', async t => {
  for (const body of [cues('X', 10001), Array.from({ length: 51 }, () => ({ from: 0, to: 1, text: 'X'.repeat(4000) }))]) {
    const f = fixture(); t.after(() => f.runtime.dispose()); await f.runtime.initialize(); const ref = await open(f); f.setBody(body);
    failure(await page(f, ref), 'too_large'); f.setBody(cues()); data(await page(f, ref)); assert.equal(f.calls.body.length, 2);
  }
});

test('in-flight snapshots reserve the eighth slot and cancelling them releases capacity', async t => {
  const f = fixture(); t.after(() => f.runtime.dispose()); await f.runtime.initialize();
  for (let i = 0; i < 7; i++) data(await page(f, await open(f)));
  const eighth = await open(f), ninth = await open(f);
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; }); f.onBody(async () => { await barrier; });
  const controller = new AbortController(), pending = page(f, eighth, {}, { ...session, signal: controller.signal }); await tick();
  failure(await page(f, ninth), 'busy'); assert.equal(f.calls.tracks.length, 8); assert.equal(f.calls.body.length, 8);
  controller.abort(); failure(await pending, 'cancelled'); f.onBody(async () => {}); data(await page(f, ninth));
  release(); await tick(); assert.equal(f.calls.body.length, 9);
});

test('concurrent pages share one request; cancelling a waiter leaves the creator and its snapshot intact', async t => {
  const f = fixture(); t.after(() => f.runtime.dispose()); await f.runtime.initialize(); const ref = await open(f);
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; }); f.onBody(async () => { await barrier; });
  const first = page(f, ref); await tick(); const waiterController = new AbortController();
  const second = page(f, ref, { offset: 60 }, { ...session, signal: waiterController.signal }); await tick(); waiterController.abort();
  failure(await second, 'cancelled'); release(); assert.equal(data(await first).cues[0].text, 'SYNTHETIC_A_0');
  assert.equal(data(await page(f, ref, { offset: 60 })).cues[0].text, 'SYNTHETIC_A_60');
  assert.equal(f.calls.tracks.length, 1); assert.equal(f.calls.body.length, 1);
});

test('creator cancellation cannot publish a late body and a retry downloads a fresh snapshot', async t => {
  const f = fixture(); t.after(() => f.runtime.dispose()); await f.runtime.initialize(); const ref = await open(f);
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; }); f.onBody(async () => { await barrier; });
  const creatorController = new AbortController(), result = page(f, ref, {}, { ...session, signal: creatorController.signal }); await tick();
  const waiter = page(f, ref, { offset: 60 }); await tick(); creatorController.abort();
  failure(await result, 'cancelled'); failure(await waiter, 'cancelled'); f.setBody(cues('SYNTHETIC_NEW')); f.onBody(async () => {});
  assert.equal(data(await page(f, ref)).cues[0].text, 'SYNTHETIC_NEW_0'); release(); await tick();
  assert.equal(data(await page(f, ref, { offset: 60 })).cues[0].text, 'SYNTHETIC_NEW_60'); assert.equal(f.calls.body.length, 2);
});

test('account changes, reference expiry and stopping reject late results without publishing a snapshot', async t => {
  for (const boundary of ['account', 'expiry', 'stop'] as const) {
    const f = fixture(); t.after(() => f.runtime.dispose()); await f.runtime.initialize(); f.login('revision-1'); const ref = await open(f);
    f.onBody(async () => { if (boundary === 'account') f.login('revision-2'); else if (boundary === 'expiry') f.advance(); else f.controller.abort(); });
    failure(await page(f, ref), boundary === 'account' ? 'account_changed' : boundary === 'expiry' ? 'reference_unavailable' : 'cancelled');
    const calls = f.calls.body.length; failure(await page(f, ref), boundary === 'stop' ? 'stopped' : 'reference_unavailable'); assert.equal(f.calls.body.length, calls);
    if (boundary !== 'stop') { f.onBody(async () => {}); data(await page(f, await open(f))); assert.equal(f.calls.body.length, calls + 1); }
  }
});

test('a changed account during track discovery stops the subtitle body request and the client receives current guards', async t => {
  const f = fixture(); t.after(() => f.runtime.dispose()); await f.runtime.initialize(); f.login('revision-1'); const ref = await open(f);
  f.onTracks(async options => { assert.equal(typeof options.assertCurrent, 'function'); options.assertCurrent!(); f.login('revision-2'); });
  failure(await page(f, ref), 'account_changed'); assert.equal(f.calls.body.length, 0);
});
