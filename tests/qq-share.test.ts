/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { OptionalService, ToolSession } from 'whalelife';
import { BiliRuntime } from '../src/runtime.ts';
import { defaults } from '../src/config.ts';
import type { AccountState, BiliClientContract, QQMiniAppShareInput, QQMiniAppShareKey, QQMiniAppShareReceipt, QQMiniAppShareService, VideoDetails } from '../src/types.ts';

const session: ToolSession = { id: 'synthetic-qq-session', personaId: 'synthetic-persona', permission: 'full' };
const video: VideoDetails = { bvid: 'BV1xx411c7mD', aid: 123, cid: 456, title: 'SYNTHETIC_VIDEO_TITLE', description: 'DO_NOT_SHARE_DESCRIPTION',
  duration: 120, owner: { mid: 789, name: 'SYNTHETIC_UP_NAME' }, cover: 'https://i0.hdslb.com/bfs/archive/synthetic.jpg', url: 'https://www.bilibili.com/video/BV1xx411c7mD/',
  parts: [{ cid: 456, page: 1, title: 'Synthetic part', duration: 120 }] };
const sent: QQMiniAppShareReceipt = { status: 'sent', confirmed: true, retryAutomatically: false, canRetry: false, platformMessageId: '-123', ledgerSaved: true };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t: TestContext, supplied: VideoDetails = video) {
  const stop = new AbortController(), provider = new AbortController(), config = structuredClone(defaults);
  let now = 1000000, account: AccountState | undefined, biliIO = 0, preparations = 0, writes = 0;
  let send = async (_input: QQMiniAppShareInput, _options: { signal?: AbortSignal; permission: 'full' }): Promise<any> => ({ ...sent });
  let delivery = async (_input: QQMiniAppShareKey): Promise<any> => ({ status: 'not_found', confirmed: false, retryAutomatically: false, canRetry: false });
  const sends: { input: QQMiniAppShareInput; options: { signal?: AbortSignal; permission: 'full' } }[] = [], queries: QQMiniAppShareKey[] = [];
  const service: QQMiniAppShareService = { miniAppShareApiVersion: '1.0.0',
    sendMiniAppShare: async (input, options) => { sends.push({ input, options }); return send(input, options); },
    miniAppShareDelivery: async input => { queries.push(input); return delivery(input); } };
  const binding = { service, signal: provider.signal, effect: () => {} } as unknown as OptionalService<QQMiniAppShareService>;
  const client = new Proxy({}, { get(_target, prop) {
    if (prop === 'dispose') return () => {};
    if (prop === 'video') return async () => { biliIO++; return structuredClone(supplied); };
    return async () => { biliIO++; throw Error('Unexpected Bilibili request'); };
  } }) as BiliClientContract;
  const runtime = new BiliRuntime(client, { status: () => ({}), settings: () => ({ timeoutMs: 1000, concurrency: 2, hasProxy: false }), search: async () => ({}) }, {
    signal: stop.signal, transient: true, config: () => config, account: () => account, now: () => now,
    readLedger: async () => ({}), saveLedger: async () => { writes++; }, prepareAccount: async () => { preparations++; },
  });
  t.after(() => runtime.dispose()); await runtime.initialize(); runtime.setQQ(binding);
  const opened: any = await runtime.read('open', { target: supplied.bvid }, session); assert.equal(opened.content.status, 'ok');
  biliIO = 0; preparations = 0;
  const raw = { videoRef: opened.content.data.videoRef, userId: '123456', operationId: 'share-one' };
  return { runtime, config, provider, stop, service, binding, raw, sends, queries,
    setSend(fn: typeof send) { send = fn; }, setDelivery(fn: typeof delivery) { delivery = fn; },
    expire() { now += 601000; }, changeAccount() { account = { cookie: 'SYNTHETIC_COOKIE', mid: 1, name: 'Synthetic', revision: 'new-login' }; },
    io() { return { biliIO, preparations, writes }; } };
}
function noBili(f: Awaited<ReturnType<typeof fixture>>) { assert.deepEqual(f.io(), { biliIO: 0, preparations: 0, writes: 0 }); }
function error(result: any, code: string) { assert.equal(result.content.error.code, code); assert.equal(result.content.data.confirmed, false); }

test('QQ sharing is opt-in, requires full trusted permission and a compatible optional provider', async t => {
  const f = await fixture(t);
  assert.equal(f.runtime.status().qqShareAvailable, true);
  error(await f.runtime.shareToQQ(f.raw, session), 'qq_share_disabled');
  f.config.shareToQQEnabled = true;
  error(await f.runtime.shareToQQ(f.raw, { ...session, permission: 'ask' }), 'permission_required');
  error(await f.runtime.shareToQQ(f.raw, { permission: 'full' }), 'session_required');
  f.runtime.setQQ(undefined); assert.equal(f.runtime.status().qqShareAvailable, false);
  error(await f.runtime.shareToQQ(f.raw, session), 'qq_unavailable');
  f.runtime.setQQ({ ...f.binding, service: { ...f.service, miniAppShareApiVersion: '0.9.0' } });
  error(await f.runtime.shareToQQ(f.raw, session), 'qq_unavailable');
  f.runtime.setQQ({ ...f.binding, service: { ...f.service, miniAppShareDelivery: undefined } as any });
  error(await f.runtime.shareToQQ(f.raw, session), 'qq_unavailable');
  assert.equal(f.sends.length, 0); noBili(f);
});

test('sharing rejects forged inputs and references bound to another session, expiry or account', async t => {
  const f = await fixture(t); f.config.shareToQQEnabled = true;
  for (const field of ['title', 'description', 'previewUrl', 'jumpPath', 'webUrl', 'sessionId', 'permission', 'personaId', 'actionId', 'cookie'])
    error(await f.runtime.shareToQQ({ ...f.raw, [field]: 'UNTRUSTED_OVERRIDE' }, session), 'invalid_input');
  for (const update of [{ userId: 123456 }, { userId: '000000' }, { operationId: 'bad\nvalue' }, { operationId: 'x'.repeat(97) }])
    error(await f.runtime.shareToQQ({ ...f.raw, ...update }, session), 'invalid_input');
  error(await f.runtime.shareToQQ(f.raw, { ...session, id: 'x'.repeat(201) }), 'invalid_input');
  error(await f.runtime.shareToQQ(f.raw, { ...session, personaId: 'x'.repeat(201) }), 'invalid_input');
  error(await f.runtime.shareToQQ(f.raw, { ...session, id: 'another-session' }), 'reference_unavailable');
  f.expire(); error(await f.runtime.shareToQQ(f.raw, session), 'reference_unavailable');
  const g = await fixture(t); g.config.shareToQQEnabled = true; g.changeAccount();
  error(await g.runtime.shareToQQ(g.raw, session), 'reference_unavailable');
  assert.equal(f.sends.length + g.sends.length, 0); noBili(f); noBili(g);
});

test('anonymous video metadata builds bounded bili cards and stable action keys from trusted context', async t => {
  const f = await fixture(t, { ...video, title: '标'.repeat(230), owner: { ...video.owner, name: '作'.repeat(550) },
    cover: '//i0.hdslb.com/bfs/archive/synthetic.jpg', url: 'https://untrusted.invalid/ignored' });
  f.config.shareToQQEnabled = true;
  const result: any = await f.runtime.shareToQQ(f.raw, session);
  assert.equal(result.content.data.status, 'sent'); assert.equal(result.content.data.platformMessageId, '-123');
  assert.deepEqual(f.sends[0].input, { userId: '123456', actionId: 'bilibili:share-one', sessionId: session.id, personaId: session.personaId,
    preset: 'bili', title: '标'.repeat(200), description: 'UP主：' + '作'.repeat(496), previewUrl: video.cover,
    jumpPath: 'pages/video/video?avid=123', webUrl: 'https://www.bilibili.com/video/BV1xx411c7mD/' });
  assert.equal(f.sends[0].options.permission, 'full'); assert.ok(f.sends[0].options.signal);
  await f.runtime.shareToQQ(f.raw, session); assert.equal(f.sends[1].input.actionId, f.sends[0].input.actionId);
  assert.equal(JSON.stringify(result.receipt).includes('标'), false); assert.equal(JSON.stringify(result).includes('DO_NOT_SHARE'), false); noBili(f);
});

test('only validated video ids and hdslb cover URLs can reach the QQ provider', async t => {
  for (const change of [{ bvid: 'evil' }, { bvid: 'BV0xx411c7mD' }, { aid: 0 }, { aid: Number.MAX_SAFE_INTEGER + 1 }, { title: '' },
    ...['https://hdslb.com.evil.invalid/a.jpg', 'https://user:pass@i0.hdslb.com/a.jpg', 'https://i0.hdslb.com:4433/a.jpg', 'https://i0.hdslb.com/a.jpg#secret', 'file:///a.jpg'].map(cover => ({ cover }))]) {
    const f = await fixture(t, { ...video, ...change }); f.config.shareToQQEnabled = true;
    const result: any = await f.runtime.shareToQQ(f.raw, session); assert.equal(result.content.data.status, 'not_sent'); assert.equal(f.sends.length, 0); noBili(f);
  }
  const f = await fixture(t, { ...video, cover: 'http://i0.hdslb.com/synthetic.jpg' }); f.config.shareToQQEnabled = true;
  await f.runtime.shareToQQ(f.raw, session); assert.equal(f.sends[0].input.previewUrl, 'https://i0.hdslb.com/synthetic.jpg'); noBili(f);
  const emoji = await fixture(t, { ...video, title: '😀'.repeat(200) }); emoji.config.shareToQQEnabled = true;
  await emoji.runtime.shareToQQ(emoji.raw, session); assert.equal(emoji.sends[0].input.title, '😀'.repeat(100)); noBili(emoji);
});

test('provider results and failures expose only approved receipt fields and local error text', async t => {
  const f = await fixture(t); f.config.shareToQQEnabled = true;
  f.setSend(async () => ({ ...sent, duplicate: true, title: 'SECRET_BODY', cookie: 'SECRET_COOKIE', ark: { token: 'SECRET_TOKEN' }, error: 'SECRET_ERROR' }));
  let result: any = await f.runtime.shareToQQ(f.raw, session); assert.deepEqual(result.content.data, { ...sent, duplicate: true });
  assert.equal(JSON.stringify(result).includes('SECRET_'), false);
  f.setSend(async () => ({ status: 'not_sent', confirmed: false, retryAutomatically: true, canRetry: true, error: 'SECRET_ERROR', platformMessageId: 'SECRET_ID' }));
  result = await f.runtime.shareToQQ(f.raw, session); assert.equal(result.content.data.retryAutomatically, false); assert.equal(result.content.data.canRetry, false);
  assert.equal(JSON.stringify(result).includes('SECRET_'), false); error(result, 'qq_share_error');
  f.setSend(async () => ({ status: 'sent', confirmed: false })); error(await f.runtime.shareToQQ(f.raw, session), 'uncertain');
  f.setSend(async () => ({ status: ['sent'], confirmed: false })); error(await f.runtime.shareToQQ(f.raw, session), 'uncertain');
  for (const platformMessageId of [undefined, '0', 'INVALID_ID']) {
    f.setSend(async () => ({ ...sent, platformMessageId })); error(await f.runtime.shareToQQ(f.raw, session), 'uncertain');
  }
  f.setSend(async () => { throw Error('SECRET_UPSTREAM_ERROR'); }); result = await f.runtime.shareToQQ(f.raw, session);
  error(result, 'uncertain'); assert.equal(JSON.stringify(result).includes('SECRET_'), false); noBili(f);
});

test('delivery queries remain available with sharing off, use no reference and preserve trusted session binding', async t => {
  const f = await fixture(t); const raw = { userId: f.raw.userId, operationId: f.raw.operationId };
  let result: any = await f.runtime.shareToQQ(raw, { ...session, permission: 'ask' }, true);
  assert.equal(result.content.data.status, 'not_found'); assert.deepEqual(f.queries[0], { userId: '123456', actionId: 'bilibili:share-one', sessionId: session.id });
  f.setDelivery(async () => ({ ...sent, duplicate: true })); result = await f.runtime.shareToQQ(raw, session, true); assert.equal(result.content.data.confirmed, true);
  error(await f.runtime.shareToQQ({ ...raw, videoRef: f.raw.videoRef }, session, true), 'invalid_input');
  assert.equal(f.sends.length, 0); noBili(f);
});

test('synchronous provider failures retain not_sent and use QQ-specific local error messages', async t => {
  const f = await fixture(t); f.config.shareToQQEnabled = true;
  for (const [providerCode, localCode] of Object.entries({ offline: 'qq_unavailable', recipient: 'qq_recipient_unavailable',
    conflict: 'qq_share_conflict', storage: 'qq_share_storage', invalid_card: 'qq_share_invalid_card' })) {
    const fail = () => ({ status: 'not_sent' as const, confirmed: false, retryAutomatically: false as const, canRetry: false as const, error: providerCode });
    f.runtime.setQQ({ ...f.binding, service: { miniAppShareApiVersion: '1.0.0', sendMiniAppShare: fail, miniAppShareDelivery: fail } });
    const result: any = await f.runtime.shareToQQ(f.raw, session);
    assert.equal(result.content.data.status, 'not_sent'); error(result, localCode);
    assert.equal(result.content.error.message.includes('B 站'), false);
  }
  noBili(f);
});

test('inflight sharing is bounded and cancellation, provider replacement or switch-off never imply not_sent', async t => {
  for (const cause of ['session', 'provider', 'replacement', 'switch', 'stop']) {
    const f = await fixture(t); f.config.shareToQQEnabled = true; const controller = new AbortController(), waiting = deferred<QQMiniAppShareReceipt>();
    f.setSend(async () => waiting.promise);
    const one = f.runtime.shareToQQ(f.raw, { ...session, signal: controller.signal });
    const two = f.runtime.shareToQQ({ ...f.raw, operationId: 'second' }, { ...session, signal: controller.signal });
    error(await f.runtime.shareToQQ({ ...f.raw, operationId: 'third' }, session), 'busy'); assert.equal(f.sends.length, 2);
    if (cause === 'session') controller.abort();
    else if (cause === 'provider') f.provider.abort();
    else if (cause === 'replacement') f.runtime.setQQ({ ...f.binding, signal: new AbortController().signal });
    else if (cause === 'switch') { f.config.shareToQQEnabled = false; f.runtime.invalidateQQShares(); }
    else f.stop.abort();
    error(await one, 'uncertain'); error(await two, 'uncertain'); assert.equal(f.sends[0].options.signal?.aborted, true);
    waiting.resolve(sent); noBili(f);
    if (cause === 'switch') {
      f.config.shareToQQEnabled = true; f.setSend(async () => sent);
      assert.equal((await f.runtime.shareToQQ({ ...f.raw, operationId: 'after-enable' }, session) as any).content.data.status, 'sent');
    }
  }
});

test('cancelled sessions never dispatch and reliable confirmation survives a simultaneous abort', async t => {
  const f = await fixture(t); f.config.shareToQQEnabled = true; const controller = new AbortController(); controller.abort();
  error(await f.runtime.shareToQQ(f.raw, { ...session, signal: controller.signal }), 'cancelled'); assert.equal(f.sends.length, 0);
  f.setSend(async () => { f.stop.abort(); return { ...sent }; });
  const result: any = await f.runtime.shareToQQ(f.raw, session); assert.equal(result.content.data.status, 'sent'); assert.equal(result.content.data.confirmed, true); noBili(f);
});

test('a provider that ignores cancellation still yields a bounded uncertain result', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t); f.config.shareToQQEnabled = true; const waiting = deferred<QQMiniAppShareReceipt>();
  f.setSend(async () => waiting.promise);
  const pending = f.runtime.shareToQQ(f.raw, session); t.mock.timers.tick(20000);
  error(await pending, 'uncertain'); assert.equal(f.sends[0].options.signal?.aborted, true); assert.equal(f.sends.length, 1);
  waiting.resolve(sent); noBili(f);
});
