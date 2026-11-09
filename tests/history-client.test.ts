/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readHistoryProgress, reportHistoryPosition } from '../src/history-client.ts';
import { BiliError } from '../src/errors.ts';
import { TransportError } from '../src/transport.ts';
import type { Transport, TransportOptions, TransportResponse } from '../src/transport.ts';

const cookie = 'SESSDATA=SYNTHETIC_HISTORY_SESSION; bili_jct=0123456789abcdef0123456789abcdef; DedeUserID=17';
const input = { aid: 111, cid: 222, positionSeconds: 7 };
const errorCode = (code: string) => (error: unknown) => error instanceof BiliError && error.code === code && !error.message.includes('SYNTHETIC');
function fixture() {
  const calls: { url: string; options: TransportOptions }[] = [], queue: (Partial<TransportResponse> | Error)[] = [];
  const transport: Transport = { async request(url, options) {
    calls.push({ url, options }); const next = queue.shift(); assert.ok(next, 'missing synthetic response');
    if (next instanceof Error) throw next;
    return { status: 200, body: Buffer.from('{"code":0}'), headers: {}, url, ...next };
  }, dispose() {} };
  return { calls, queue, transport, json(data: unknown, code: unknown = 0) { queue.push({ body: Buffer.from(JSON.stringify({ code, data })) }); } };
}
const entry = (progress: unknown, extra: Record<string, unknown> = {}) => ({ history: { oid: 111, cid: 222, business: 'archive' },
  progress, view_at: 1234, title: 'SYNTHETIC_PRIVATE_HISTORY_TITLE', author_name: 'SYNTHETIC_PRIVATE_NAME', ...extra });

test('history reads one recent page and exposes only matching video part progress', async () => {
  const f = fixture(); f.json({ list: [entry(80, { history: { oid: 111, cid: 333, business: 'archive' } }), entry(7)] });
  assert.deepEqual(await readHistoryProgress(f.transport, input, { cookie }), { found: true, progressSeconds: 7, completed: false, viewedAt: 1234 });
  const request = f.calls[0]; assert.equal(request.options.method ?? 'GET', 'GET'); assert.equal(request.options.body, undefined);
  assert.equal(new URL(request.url).pathname, '/x/web-interface/history/cursor'); assert.equal(new URL(request.url).searchParams.get('ps'), '30');
  assert.equal(new URL(request.url).searchParams.has('csrf'), false); assert.equal(request.options.headers?.Cookie, cookie);
  f.json({ list: [entry(-1)] });
  assert.deepEqual(await readHistoryProgress(f.transport, input, { cookie }), { found: true, progressSeconds: null, completed: true, viewedAt: 1234 });
  f.json({ list: [entry(8, { history: { oid: '111', cid: '222', business: 'archive' }, view_at: 'invalid' })] });
  assert.deepEqual(await readHistoryProgress(f.transport, input, { cookie }), { found: true, progressSeconds: 8, completed: false });
  f.json({ list: [entry(1, { history: { oid: 111, cid: 222, business: 'live' } })] });
  assert.deepEqual(await readHistoryProgress(f.transport, input, { cookie }), { found: false }); assert.equal(f.calls.length, 4);
});
test('history write contains only target, checked position and CSRF; API acknowledgement does not claim playback', async () => {
  const f = fixture(); f.queue.push({});
  const result = await reportHistoryPosition(f.transport, input, { cookie });
  assert.deepEqual(result, { state: 'accepted' }); assert.equal(f.calls.length, 1);
  const request = f.calls[0], body = new URLSearchParams(request.options.body);
  assert.equal(request.url, 'https://api.bilibili.com/x/v2/history/report'); assert.equal(request.options.method, 'POST');
  assert.deepEqual([...body.keys()].sort(), ['aid', 'cid', 'csrf', 'progress']);
  assert.equal(body.get('progress'), '7'); assert.equal(body.get('aid'), '111'); assert.equal(body.get('cid'), '222');
  assert.equal(body.get('csrf'), '0123456789abcdef0123456789abcdef');
  assert.equal(request.options.headers?.Cookie, cookie); assert.equal(JSON.stringify(result).includes('SYNTHETIC'), false);
});
test('invalid identity, completion sentinel, timing and missing credentials fail before any history request', async () => {
  const f = fixture();
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '7']) {
    await assert.rejects(reportHistoryPosition(f.transport, { ...input, positionSeconds: value } as any, { cookie }), errorCode('invalid_input'));
  }
  await assert.rejects(reportHistoryPosition(f.transport, { ...input, aid: 0 }, { cookie }), errorCode('invalid_input'));
  await assert.rejects(readHistoryProgress(f.transport, { ...input, cid: 0 }, { cookie }), errorCode('invalid_input'));
  await assert.rejects(reportHistoryPosition(f.transport, input, {}), errorCode('login_required'));
  await assert.rejects(readHistoryProgress(f.transport, input, {}), errorCode('login_required'));
  await assert.rejects(reportHistoryPosition(f.transport, input, { cookie: cookie + '\r\nSYNTHETIC_INJECTION' }), errorCode('invalid_input'));
  await assert.rejects(reportHistoryPosition(f.transport, input, { cookie, timeoutMs: 240001 }), errorCode('invalid_input'));
  await assert.rejects(reportHistoryPosition(f.transport, input, { cookie, signal: AbortSignal.abort() }), errorCode('cancelled'));
  assert.equal(f.calls.length, 0);
});
test('history read rejects malformed numeric progress, malformed API codes and unsafe response locations without leaking source data', async () => {
  const f = fixture();
  for (const progress of ['7', -2, 0.2, Number.MAX_SAFE_INTEGER + 1, null]) {
    f.json({ list: [entry(progress)] }); await assert.rejects(readHistoryProgress(f.transport, input, { cookie }), errorCode('malformed_response'));
  }
  f.json({ list: [] }, '0'); await assert.rejects(readHistoryProgress(f.transport, input, { cookie }), errorCode('malformed_response'));
  f.json({}); await assert.rejects(readHistoryProgress(f.transport, input, { cookie }), errorCode('malformed_response'));
  f.queue.push({ url: 'https://other.bilibili.com/x/web-interface/history/cursor' });
  await assert.rejects(readHistoryProgress(f.transport, input, { cookie }), errorCode('unsafe_url'));
});
test('history write is never retried and separates definite rejection from uncertain submission', async () => {
  const f = fixture();
  for (const [code, expected] of [[-101, 'login_required'], [-111, 'login_required'], [-412, 'access_blocked'], [-400, 'platform_error']] as const) {
    f.json({ message: 'SYNTHETIC_PRIVATE_SERVER_MESSAGE' }, code);
    await assert.rejects(reportHistoryPosition(f.transport, input, { cookie }), errorCode(expected));
  }
  for (const result of [new TransportError('network_error', true), new Error('SYNTHETIC_PRIVATE_NETWORK_ERROR'),
    { body: Buffer.from('SYNTHETIC_INVALID_JSON') }, { body: Buffer.from('{"code":"0"}') }, { status: 503 },
    { url: 'https://other.bilibili.com/x/v2/history/report' }]) {
    f.queue.push(result); const before = f.calls.length;
    await assert.rejects(reportHistoryPosition(f.transport, input, { cookie }), errorCode('uncertain'));
    assert.equal(f.calls.length, before + 1);
  }
  f.queue.push(new TransportError('cancelled', false));
  await assert.rejects(reportHistoryPosition(f.transport, input, { cookie }), errorCode('cancelled'));
  assert.equal(f.queue.length, 0);
});
