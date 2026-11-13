/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withDiagnostics, type DiagnosticSink, type RequestDiagnostic } from '../src/diagnostics.ts';
import { BiliError } from '../src/errors.ts';
import { TransportError, type Transport, type TransportOptions, type TransportResponse } from '../src/transport.ts';

const search = 'https://api.bilibili.com/x/web-interface/search/type?keyword=SECRET_QUERY&mid=SECRET_ACCOUNT';
const poll = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=SECRET_QR';
const options: TransportOptions = { maxBytes: 2 * 1024 * 1024, timeoutMs: 1000,
  headers: { Cookie: 'SESSDATA=SECRET_COOKIE; DedeUserID=SECRET_ACCOUNT', Referer: 'https://www.bilibili.com/SECRET_VIDEO' } };
function response(value: unknown = { code: 0, data: {} }, status = 200): TransportResponse {
  return { status, headers: { 'set-cookie': 'SECRET_COOKIE', 'x-private': 'SECRET_HEADER' },
    body: Buffer.from(JSON.stringify(value)), url: search };
}
function fixture(result: TransportResponse | Error, sink?: DiagnosticSink) {
  const events: RequestDiagnostic[] = [], calls: { input: string; options: TransportOptions }[] = [];
  let disposals = 0;
  const original: Transport = { async request(input, settings) { calls.push({ input, options: settings });
    if (result instanceof Error) throw result; return result; }, dispose() { disposals++; } };
  const transport = withDiagnostics(original, sink ?? (event => { events.push(event); }));
  return { original, transport, events, calls, disposals: () => disposals };
}
function privateSafe(events: RequestDiagnostic[]) {
  const serialized = JSON.stringify(events);
  for (const secret of ['SECRET_', 'keyword', 'SESSDATA', 'DedeUserID', 'set-cookie', 'stack', 'headers', 'body'])
    assert.equal(serialized.includes(secret), false, secret);
  for (const event of events) {
    assert.match(event.requestId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.ok(Number.isInteger(event.elapsedMs) && event.elapsedMs >= 0);
    assert.deepEqual(Object.keys(event).filter(key => !['requestId', 'endpoint', 'host', 'path', 'method', 'hasSessionCookie', 'elapsedMs',
      'stage', 'httpStatus', 'apiCode', 'errorCode'].includes(key)), []);
  }
}

test('HTTP failures record original status once without touching body, request or response identity', async () => {
  for (const status of [412, 429, 503]) {
    const original = response({ code: -401, message: 'SECRET_MESSAGE' }, status);
    Object.defineProperty(original, 'body', { get() { throw Error('Non-success body must not be read'); } });
    const f = fixture(original);
    assert.strictEqual(await f.transport.request(search, options), original);
    assert.equal(f.calls.length, 1); assert.strictEqual(f.calls[0].options, options); assert.equal(f.calls[0].input, search);
    assert.equal(f.events.length, 1);
    assert.deepEqual({ ...f.events[0], requestId: '', elapsedMs: 0 }, { requestId: '', elapsedMs: 0,
      endpoint: 'search', host: 'api.bilibili.com', path: '/x/web-interface/search/type', method: 'GET', hasSessionCookie: true, stage: 'http', httpStatus: status });
    privateSafe(f.events);
  }
});

test('API failures retain integer business codes and never include external explanations or data', async () => {
  for (const code of [-352, -401, -101, -987654]) {
    const original = response({ code, message: 'SECRET_MESSAGE', data: { cookie: 'SECRET_COOKIE', title: 'SECRET_TITLE', mid: 'SECRET_ACCOUNT' } });
    const f = fixture(original); assert.strictEqual(await f.transport.request(search, options), original);
    assert.equal(f.events.length, 1); assert.equal(f.events[0].stage, 'api');
    assert.equal(f.events[0].httpStatus, 200); assert.equal(f.events[0].apiCode, code); privateSafe(f.events);
  }
});

test('successful requests and normal QR polling states do not generate failure diagnostics', async () => {
  for (const [input, value] of [[search, { code: 0, data: { title: 'SECRET_TITLE' } }],
    ...[0, 86101, 86090, 86038].map(code => [poll, { code: 0, data: { code, message: 'SECRET_MESSAGE' } }])] as [string, unknown][]) {
    const original = response(value), f = fixture(original);
    assert.strictEqual(await f.transport.request(input, options), original); assert.equal(f.events.length, 0); assert.equal(f.calls.length, 1);
  }
  const f = fixture(response({ code: 0, data: { code: 12345, message: 'SECRET_QR_ERROR' } }));
  await f.transport.request(poll, options); assert.equal(f.events.length, 1); assert.equal(f.events[0].apiCode, 12345); privateSafe(f.events);
});

test('JSON is observed only for allowlisted routes and within the existing response cap', async () => {
  for (const input of ['https://api.bilibili.com/SECRET_PATH?csrf=SECRET_CSRF', 'https://private.example/SECRET_PATH',
    'https://i0.hdslb.com/SECRET_VIDEO.json', 'https://upos.bilivideo.com/SECRET_VIDEO.mp4',
    'https://api.bilibili.com/x/v2/dm/web/seg.so?oid=SECRET_VIDEO', 'https://www.bilibili.com/correspond/1/SECRET_TOKEN']) {
    const original = response({ code: -401, message: 'SECRET_MESSAGE' });
    Object.defineProperty(original, 'body', { get() { throw Error('Unknown or non-JSON body must not be read'); } });
    const f = fixture(original); assert.strictEqual(await f.transport.request(input, options), original); assert.equal(f.events.length, 0);
    const failed = fixture(response({}, 403)); await failed.transport.request(input, options);
    assert.equal(failed.events.length, 1); assert.equal(failed.events[0].host, undefined); assert.equal(failed.events[0].path, undefined); privateSafe(failed.events);
  }
  const original = response(); original.body = Buffer.alloc(2 * 1024 * 1024 + 1, 32);
  const f = fixture(original); assert.strictEqual(await f.transport.request(search, options), original);
  assert.equal(f.events.length, 1); assert.equal(f.events[0].stage, 'response'); assert.equal(f.events[0].errorCode, 'too_large');
});

test('invalid JSON envelopes produce only fixed response diagnostics while preserving original responses', async () => {
  for (const value of [[], null, { code: 'SECRET_CODE' }, { code: 1.5 }, { code: Number.MAX_SAFE_INTEGER + 1 }]) {
    const original = response(value), f = fixture(original);
    assert.strictEqual(await f.transport.request(search, options), original); assert.equal(f.events.length, 1);
    assert.equal(f.events[0].stage, 'response'); assert.equal(f.events[0].errorCode, 'malformed_response'); assert.equal(f.events[0].apiCode, undefined); privateSafe(f.events);
  }
  const original = response(); original.body = Buffer.from('SECRET_MALFORMED_JSON');
  const f = fixture(original); assert.strictEqual(await f.transport.request(search, options), original); privateSafe(f.events);
});

test('POST failures retain the original exception, submitted flag and request without retries', async () => {
  for (const submitted of [true, false]) {
    const original = new TransportError('timeout', submitted); original.message = 'SECRET_EXCEPTION';
    const f = fixture(original), signal = new AbortController().signal;
    const settings: TransportOptions = { ...options, method: 'POST', body: 'text=SECRET_COMMENT&csrf=SECRET_CSRF', signal };
    await assert.rejects(f.transport.request('https://api.bilibili.com/x/v2/reply/add', settings), error => error === original);
    assert.equal(original.submitted, submitted); assert.equal(f.calls.length, 1); assert.strictEqual(f.calls[0].options, settings);
    assert.equal(f.events.length, 1); assert.equal(f.events[0].method, 'POST'); assert.equal(f.events[0].errorCode, 'timeout'); privateSafe(f.events);
  }
});

test('cancellation identity is unchanged and unknown or modified error codes are reduced to network_error', async () => {
  const corrupted = new BiliError('timeout'); corrupted.code = 'SECRET_CODE';
  for (const original of [new Error('SECRET_EXCEPTION'), corrupted, new BiliError('cancelled')]) {
    const f = fixture(original), controller = new AbortController(); controller.abort();
    const settings = { ...options, signal: controller.signal };
    await assert.rejects(f.transport.request(search, settings), error => error === original);
    assert.equal(f.events.length, 1); assert.equal(f.events[0].errorCode, original === corrupted || !(original instanceof BiliError) ? 'network_error' : 'cancelled');
    assert.strictEqual(f.calls[0].options.signal, controller.signal); assert.equal(f.calls.length, 1); privateSafe(f.events);
  }
});

test('sink throws and rejections cannot replace either successful transport responses or original exceptions', async () => {
  for (const sink of [() => { throw Error('SECRET_SINK_FAILURE'); }, async () => { throw Error('SECRET_SINK_FAILURE'); }]) {
    const original = response({ code: -401 }), f = fixture(original, sink);
    assert.strictEqual(await f.transport.request(search, options), original); assert.equal(f.calls.length, 1);
    const failure = new TransportError('timeout', true), g = fixture(failure, sink);
    await assert.rejects(g.transport.request(search, options), error => error === failure); assert.equal(g.calls.length, 1);
    await new Promise(resolve => setImmediate(resolve));
  }
  const f = fixture(response({ code: -352 }), () => new Promise(() => {}));
  await f.transport.request(search, options); assert.equal(f.calls.length, 1);
});

test('observation failures do not fail requests and missing sinks preserve the original transport', async () => {
  const original = response(); Object.defineProperty(original, 'status', { get() { throw Error('SECRET_OBSERVER_FAILURE'); } });
  const f = fixture(original); assert.strictEqual(await f.transport.request(search, options), original); assert.equal(f.events.length, 0);
  assert.strictEqual(withDiagnostics(f.original), f.original);
  await f.transport.dispose(); assert.equal(f.disposals(), 1);
});

test('request ids are random per failure and session-cookie reporting is boolean only', async () => {
  const f = fixture(response({ code: -401 }));
  const variants: Record<string, string>[] = [{ cookie: 'SESSDATA=SECRET_COOKIE' }, { Cookie: 'bili_jct=SECRET_CSRF' }, {}, { Cookie: 'SESSDATA=' }];
  for (const headers of variants)
    await f.transport.request(search, { ...options, headers });
  assert.deepEqual(f.events.map(event => event.hasSessionCookie), [true, false, false, false]);
  assert.equal(new Set(f.events.map(event => event.requestId)).size, 4); privateSafe(f.events);
});
