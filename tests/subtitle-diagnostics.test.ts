/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BiliClient } from '../src/client.ts';
import { BiliError } from '../src/errors.ts';
import type { DiagnosticSink, RequestDiagnostic } from '../src/diagnostics.ts';
import { TransportError, type TransportOptions, type TransportResponse } from '../src/transport.ts';

const BV = 'BV1xx411c7mD';
const COOKIE = 'SESSDATA=SECRET_COOKIE; bili_jct=SECRET_CSRF; DedeUserID=123';
const subtitleUrl = 'https://aisubtitle.hdslb.com/SECRET_SUBTITLE_PATH.json?auth_key=SECRET_SIGNATURE';
const cue = { from: 0, to: 2, content: 'SECRET_SUBTITLE_TEXT' };
const track = (extra: Record<string, unknown> = {}) => ({ id_str: '1234567890123456789', lan: 'ai-zh', lan_doc: 'SECRET_LANGUAGE_LABEL', subtitle_url: subtitleUrl, ...extra });
const player = (tracks: unknown) => ({ code: 0, data: { subtitle: { subtitles: tracks }, need_login_subtitle: false } });
const json = (value: unknown, status = 200): Partial<TransportResponse> => ({ status, body: Buffer.from(JSON.stringify(value)), headers: { 'content-type': 'application/json', 'set-cookie': 'SECRET_SET_COOKIE' } });
const errorCode = (code: string) => (error: unknown) => error instanceof BiliError && error.code === code;
type ResponseFactory = (url: string, options: TransportOptions) => Promise<Partial<TransportResponse>>;
function fixture(sink?: DiagnosticSink, responder?: ResponseFactory) {
  const events: RequestDiagnostic[] = [], calls: { url: string; options: TransportOptions }[] = [];
  const queue: (Partial<TransportResponse> | Error)[] = [];
  let disposals = 0;
  const client = new BiliClient({ onDiagnostic: sink ?? (event => { events.push(event); }), transport: {
    async request(url, options) {
      calls.push({ url, options });
      const next = responder ? await responder(url, options) : queue.shift();
      assert.ok(next, 'missing synthetic response');
      if (next instanceof Error) throw next;
      return { status: 200, headers: {}, body: Buffer.from('{}'), url, ...next };
    }, dispose() { disposals++; },
  } });
  return { client, events, calls, queue, disposals: () => disposals };
}
const eventKeys = new Set(['requestId', 'endpoint', 'host', 'path', 'method', 'hasSessionCookie', 'elapsedMs', 'stage', 'httpStatus', 'apiCode', 'errorCode',
  'phase', 'reason', 'field', 'actualType', 'itemIndex', 'itemCount', 'examinedCount', 'acceptedCount', 'rejectedCount', 'responseBytes', 'issues', 'constraint', 'limit']);
const fields = new Set(['$', 'code', 'data', 'data.subtitle', 'data.subtitle.subtitles', 'track', 'track.subtitle_url', 'track.id', 'track.id_str', 'body', 'cue', 'cue.from', 'cue.to', 'cue.content', 'response.url']);
const types = new Set(['undefined', 'null', 'array', 'object', 'string', 'boolean', 'number', 'non_finite_number', 'unsafe_integer', 'other']);
const reasons = new Set(['invalid_json', 'invalid_envelope', 'invalid_data', 'invalid_track_list', 'invalid_track', 'invalid_track_url', 'invalid_track_id', 'track_rejected',
  'invalid_cue_list', 'invalid_cue', 'invalid_cue_time', 'invalid_cue_content', 'cue_limit', 'text_limit', 'invalid_response_url']);
const constraints = new Set(['finite_number', 'non_negative', 'ordered', 'string', 'identifier', 'trusted_url', 'object', 'array', 'max_cues', 'max_text']);
function privateSafe(events: RequestDiagnostic[]) {
  const serialized = JSON.stringify(events);
  for (const value of ['SECRET_', BV, 'SESSDATA=', 'bili_jct=', 'DedeUserID=', 'auth_key', 'aisubtitle.hdslb.com', 'set-cookie', 'stack', 'headers'])
    assert.equal(serialized.includes(value), false, value);
  for (const event of events) {
    assert.deepEqual(Object.keys(event).filter(key => !eventKeys.has(key)), []);
    assert.match(event.requestId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.ok(Number.isInteger(event.elapsedMs) && event.elapsedMs >= 0);
    assert.ok(['subtitle_tracks', 'subtitle_body'].includes(event.phase!));
    assert.equal(event.method, 'GET');
    if (event.reason !== undefined) assert.ok(reasons.has(event.reason));
    if (event.field !== undefined) assert.ok(fields.has(event.field));
    if (event.actualType !== undefined) assert.ok(types.has(event.actualType));
    if (event.constraint !== undefined) assert.ok(constraints.has(event.constraint));
    for (const key of ['itemIndex', 'itemCount', 'examinedCount', 'acceptedCount', 'rejectedCount', 'responseBytes', 'limit'] as const)
      if (event[key] !== undefined) assert.ok(Number.isSafeInteger(event[key]) && event[key]! >= 0, key);
    assert.ok((event.issues?.length ?? 0) <= 5);
    for (const issue of event.issues ?? []) {
      assert.deepEqual(Object.keys(issue).filter(key => !['reason', 'field', 'actualType', 'itemIndex', 'constraint'].includes(key)), []);
      assert.ok(reasons.has(issue.reason)); assert.ok(fields.has(issue.field)); if (issue.actualType !== undefined) assert.ok(types.has(issue.actualType));
      assert.ok(Number.isSafeInteger(issue.itemIndex) && issue.itemIndex! >= 0);
      if (issue.constraint !== undefined) assert.ok(constraints.has(issue.constraint));
    }
  }
}
function only(f: ReturnType<typeof fixture>, phase: 'subtitle_tracks' | 'subtitle_body', stage: RequestDiagnostic['stage'], reason?: string) {
  assert.equal(f.events.length, 1); const event = f.events[0];
  assert.equal(event.phase, phase); assert.equal(event.stage, stage);
  if (reason !== undefined) assert.equal(event.reason, reason);
  privateSafe(f.events); return event;
}
async function discover(f: ReturnType<typeof fixture>) {
  f.queue.push(json(player([track()])));
  const result = await f.client.subtitles(BV, 456, { cookie: COOKIE });
  assert.equal(result.tracks.length, 1); assert.equal(f.events.length, 0);
  return result.tracks[0].url;
}

test('subtitle track JSON and envelope failures receive one fixed response diagnostic', async t => {
  const examples = [
    { response: { body: Buffer.from('SECRET_MALFORMED_JSON') }, reason: 'invalid_json' },
    ...[null, [], 'SECRET_TOP_LEVEL', { code: 'SECRET_CODE' }].map(value => ({ response: json(value), reason: 'invalid_envelope' })),
  ];
  for (const example of examples) {
    const f = fixture(); t.after(() => f.client.dispose()); f.queue.push(example.response);
    await assert.rejects(f.client.subtitles(BV, 456, { cookie: COOKIE }), errorCode('malformed_response'));
    const event = only(f, 'subtitle_tracks', 'response', example.reason);
    assert.equal(event.httpStatus, 200); assert.equal(event.hasSessionCookie, true);
    assert.equal(f.calls.length, 1);
  }
});

test('subtitle data and track-list structural errors record their fixed field and type', async t => {
  const examples = [
    { value: { code: 0, data: [] }, reason: 'invalid_data', field: 'data', actualType: 'array' },
    { value: { code: 0, data: 'SECRET_DATA' }, reason: 'invalid_data', field: 'data', actualType: 'string' },
    { value: player(null), reason: 'invalid_track_list', field: 'data.subtitle.subtitles', actualType: 'null' },
    { value: player({ secret: 'SECRET_TRACKS' }), reason: 'invalid_track_list', field: 'data.subtitle.subtitles', actualType: 'object' },
  ];
  for (const example of examples) {
    const f = fixture(); t.after(() => f.client.dispose()); const response = json(example.value); f.queue.push(response);
    await assert.rejects(f.client.subtitles(BV, 456, {}), errorCode('malformed_response'));
    const event = only(f, 'subtitle_tracks', 'parse', example.reason);
    assert.equal(event.field, example.field); assert.equal(event.actualType, example.actualType);
    assert.equal(event.responseBytes, response.body!.length); assert.equal(f.calls.length, 1);
  }
});

test('malformed optional subtitle containers keep legacy empty results while recording their shape', async t => {
  for (const [value, actualType] of [['SECRET_SUBTITLE_CONTAINER', 'string'], [[], 'array'], [42, 'number']] as const) {
    const f = fixture(); t.after(() => f.client.dispose()); f.queue.push(json({ code: 0, data: { subtitle: value } }));
    assert.deepEqual(await f.client.subtitles(BV, 456, {}), { tracks: [], loginRequired: false });
    const event = only(f, 'subtitle_tracks', 'parse', 'invalid_track_list');
    assert.equal(event.field, 'data.subtitle'); assert.equal(event.actualType, actualType); assert.equal(f.calls.length, 1);
  }
});

test('changed or unsafe player response URLs retain unsafe_url without disclosing the returned address', async t => {
  for (const url of ['https://public.example/SECRET_RETURN_PATH?token=SECRET_RETURN_TOKEN', 'https://127.0.0.1/SECRET_RETURN_PATH']) {
    const f = fixture(); t.after(() => f.client.dispose()); f.queue.push({ ...json(player([])), url });
    await assert.rejects(f.client.subtitles(BV, 456, {}), errorCode('unsafe_url'));
    const event = only(f, 'subtitle_tracks', 'parse', 'invalid_response_url');
    assert.equal(event.field, 'response.url'); assert.equal(event.constraint, 'trusted_url'); assert.equal(event.errorCode, 'unsafe_url');
    assert.equal(event.host, 'api.bilibili.com'); assert.equal(event.path, '/x/player/v2'); assert.equal(f.calls.length, 1);
    assert.equal(JSON.stringify(event).includes('public.example'), false); assert.equal(JSON.stringify(event).includes('127.0.0.1'), false);
  }
});

test('rejected tracks aggregate safe structural, URL and ID issue details without hiding failure', async t => {
  const examples = [
    { value: null, reason: 'invalid_track' },
    { value: track({ subtitle_url: 'https://127.0.0.1/SECRET_PATH' }), reason: 'invalid_track_url' },
    { value: track({ subtitle_url: 'SECRET_BAD_URL' }), reason: 'invalid_track_url' },
    { value: track({ subtitle_url: 42 }), reason: 'invalid_track_url' },
    { value: track({ id_str: 'SECRET_TRACK_ID' }), reason: 'invalid_track_id' },
    { value: track({ id_str: '0' }), reason: 'invalid_track_id' },
    { value: track({ id_str: '', id: 123 }), reason: 'invalid_track_id' },
    { value: track({ id_str: undefined, id: Number.MAX_SAFE_INTEGER + 1 }), reason: 'invalid_track_id' },
  ];
  for (const example of examples) {
    const f = fixture(); t.after(() => f.client.dispose()); f.queue.push(json(player([example.value])));
    await assert.rejects(f.client.subtitles(BV, 456, {}), errorCode('malformed_response'));
    const event = only(f, 'subtitle_tracks', 'parse', 'track_rejected');
    assert.equal(event.itemCount, 1); assert.equal(event.examinedCount, 1); assert.equal(event.acceptedCount, 0); assert.equal(event.rejectedCount, 1);
    assert.equal(event.issues?.length, 1); assert.equal(event.issues?.[0].reason, example.reason); assert.equal(event.issues?.[0].itemIndex, 0);
    assert.equal(f.calls.length, 1);
  }
});

test('mixed track results retain valid tracks, cap issue details and count only examined candidates', async t => {
  const f = fixture(); t.after(() => f.client.dispose());
  const rejected = Array.from({ length: 7 }, () => track({ id_str: 'SECRET_BAD_ID' }));
  const valid = Array.from({ length: 28 }, (_, i) => track({ id_str: String(100 + i) }));
  f.queue.push(json(player([...rejected, ...valid])));
  const result = await f.client.subtitles(BV, 456, { cookie: COOKIE });
  assert.equal(result.tracks.length, 23);
  const event = only(f, 'subtitle_tracks', 'parse', 'track_rejected');
  assert.equal(event.itemCount, 35); assert.equal(event.examinedCount, 30); assert.equal(event.acceptedCount, 23); assert.equal(event.rejectedCount, 7);
  assert.equal(event.issues?.length, 5); assert.deepEqual(event.issues?.map(issue => issue.itemIndex), [0, 1, 2, 3, 4]);
  f.queue.push(json({ body: [cue] }));
  assert.equal((await f.client.subtitle(result.tracks[0].url, { cookie: COOKIE })).length, 1);
  assert.equal(f.events.length, 1); assert.equal(f.calls.length, 2); assert.equal(f.calls[1].options.headers?.Cookie, undefined);
});

test('subtitle body invalid JSON, envelope and cue-list errors carry the body phase without a duplicate event', async t => {
  const examples = [
    { response: { body: Buffer.from('SECRET_INVALID_CDN_JSON') }, stage: 'response', reason: 'invalid_json' },
    { response: json(null), stage: 'response', reason: 'invalid_envelope' },
    { response: json([]), stage: 'response', reason: 'invalid_envelope' },
    { response: json({ body: null }), stage: 'parse', reason: 'invalid_cue_list' },
    { response: json({ body: { secret: 'SECRET_CUES' } }), stage: 'parse', reason: 'invalid_cue_list' },
  ] as const;
  for (const example of examples) {
    const f = fixture(); t.after(() => f.client.dispose()); const url = await discover(f); f.queue.push(example.response);
    await assert.rejects(f.client.subtitle(url, { cookie: COOKIE }), errorCode('malformed_response'));
    const event = only(f, 'subtitle_body', example.stage, example.reason);
    assert.equal(event.hasSessionCookie, false); assert.equal(event.host, undefined); assert.equal(event.path, undefined);
    assert.equal(event.responseBytes, example.response.body!.length); assert.equal(f.calls.length, 2);
  }
});

test('malformed cues identify the failing index and a fixed field without exposing text', async t => {
  const examples = [
    { value: null, reason: 'invalid_cue', field: 'cue', actualType: 'null' },
    { value: { ...cue, from: 'SECRET_TIME' }, reason: 'invalid_cue_time', field: 'cue.from', actualType: 'string' },
    { value: { ...cue, from: -1 }, reason: 'invalid_cue_time', field: 'cue.from', actualType: 'number' },
    { value: { ...cue, to: 'SECRET_TIME' }, reason: 'invalid_cue_time', field: 'cue.to', actualType: 'string' },
    { value: { ...cue, from: 3 }, reason: 'invalid_cue_time', field: 'cue.to', actualType: 'number' },
    { value: { ...cue, content: 42 }, reason: 'invalid_cue_content', field: 'cue.content', actualType: 'number' },
  ];
  for (const example of examples) {
    const f = fixture(); t.after(() => f.client.dispose()); const url = await discover(f); f.queue.push(json({ body: [cue, example.value] }));
    await assert.rejects(f.client.subtitle(url, {}), errorCode('malformed_response'));
    const event = only(f, 'subtitle_body', 'parse', example.reason);
    assert.equal(event.field, example.field); assert.equal(event.actualType, example.actualType);
    assert.equal(event.itemIndex, 1); assert.equal(event.itemCount, 2); assert.equal(f.calls.length, 2);
  }
});

test('cue and text limits retain too_large and report only bounded count diagnostics', async t => {
  for (const [body, reason] of [
    [Array.from({ length: 10001 }, () => cue), 'cue_limit'],
    [Array.from({ length: 51 }, () => ({ ...cue, content: 'SECRET_TEXT_'.repeat(400).slice(0, 4000) })), 'text_limit'],
  ] as [unknown[], string][]) {
    const f = fixture(); t.after(() => f.client.dispose()); const url = await discover(f); f.queue.push(json({ body }));
    await assert.rejects(f.client.subtitle(url, {}), errorCode('too_large'));
    const event = only(f, 'subtitle_body', 'parse', reason);
    assert.equal(event.itemCount, body.length); assert.equal(event.errorCode, 'too_large'); assert.equal(f.calls.length, 2);
  }
});

test('HTTP, API and transport failures carry the correct subtitle phase and remain single requests', async t => {
  const failures = [
    { response: json({ code: -352, message: 'SECRET_API_MESSAGE' }), stage: 'api', error: 'access_blocked', apiCode: -352 },
    { response: json({}, 403), stage: 'http', error: 'access_blocked', status: 403 },
    { response: new TransportError('timeout', false), stage: 'transport', error: 'timeout' },
  ] as const;
  for (const failure of failures) {
    const f = fixture(); t.after(() => f.client.dispose()); f.queue.push(failure.response);
    await assert.rejects(f.client.subtitles(BV, 456, { cookie: COOKIE }), errorCode(failure.error));
    const event = only(f, 'subtitle_tracks', failure.stage);
    if ('apiCode' in failure) assert.equal(event.apiCode, failure.apiCode);
    if ('status' in failure) assert.equal(event.httpStatus, failure.status);
    assert.equal(f.calls.length, 1);
  }
  for (const response of [json({}, 503), new TransportError('cancelled', false)]) {
    const f = fixture(); t.after(() => f.client.dispose()); const url = await discover(f); f.queue.push(response);
    await assert.rejects(f.client.subtitle(url, {}), errorCode(response instanceof Error ? 'cancelled' : 'access_blocked'));
    only(f, 'subtitle_body', response instanceof Error ? 'transport' : 'http'); assert.equal(f.calls.length, 2);
  }
});

test('ordinary success, no tracks, login-limited empties and explicit AI Chinese subtitles remain silent', async t => {
  for (const value of [player([]), { code: 0, data: {} }, { code: 0, data: null }, { code: 0, data: { subtitle: { subtitles: [] }, need_login_subtitle: true } }]) {
    const f = fixture(); t.after(() => f.client.dispose()); f.queue.push(json(value));
    const result = await f.client.subtitles(BV, 456, {}); assert.equal(result.tracks.length, 0); assert.equal(f.events.length, 0);
  }
  const f = fixture(); t.after(() => f.client.dispose()); const url = await discover(f); f.queue.push(json({ body: [cue] }));
  assert.deepEqual(await f.client.subtitle(url, { cookie: COOKIE }), [{ from: 0, to: 2, text: cue.content }]);
  assert.equal(f.events.length, 0); assert.equal(f.calls.length, 2); assert.equal(f.calls[1].options.headers?.Cookie, undefined);
});

test('throwing, rejecting and never-settling diagnostic sinks cannot change semantic failure or mixed success', async t => {
  for (const sink of [() => { throw Error('SECRET_SINK_ERROR'); }, async () => { throw Error('SECRET_SINK_ERROR'); }, () => new Promise<void>(() => {})]) {
    const f = fixture(sink); t.after(() => f.client.dispose());
    f.queue.push(json(player(null)));
    await assert.rejects(f.client.subtitles(BV, 456, {}), errorCode('malformed_response'));
    f.queue.push(json(player([track({ id_str: 'SECRET_BAD_ID' }), track()])));
    assert.equal((await f.client.subtitles(BV, 456, {})).tracks.length, 1);
    f.queue.push(json({ body: [{ ...cue, to: -1 }] }));
    await assert.rejects(f.client.subtitle(subtitleUrl, {}), errorCode('malformed_response'));
    assert.equal(f.calls.length, 3); await new Promise(resolve => setImmediate(resolve));
  }
});

test('concurrent subtitle requests keep independent request IDs, phases and diagnostics', async t => {
  let releaseTracks!: () => void, releaseBody!: () => void;
  const tracksWait = new Promise<void>(resolve => { releaseTracks = resolve; });
  const bodyWait = new Promise<void>(resolve => { releaseBody = resolve; });
  let tracks = 0;
  const f = fixture(undefined, async url => {
    if (new URL(url).pathname === '/x/player/v2') {
      if (++tracks === 1) return json(player([track()]));
      await tracksWait; return json(player([track({ id_str: 'SECRET_BAD_ID' })]));
    }
    await bodyWait; return json({ body: [{ ...cue, content: 42 }] });
  });
  t.after(() => f.client.dispose());
  const discovered = await f.client.subtitles(BV, 456, {});
  const pendingTracks = assert.rejects(f.client.subtitles(BV, 456, { cookie: COOKIE }), errorCode('malformed_response'));
  const pendingBody = assert.rejects(f.client.subtitle(discovered.tracks[0].url, {}), errorCode('malformed_response'));
  releaseBody(); await pendingBody; releaseTracks(); await pendingTracks;
  assert.equal(f.events.length, 2); assert.equal(new Set(f.events.map(event => event.requestId)).size, 2);
  assert.deepEqual(f.events.map(event => [event.phase, event.reason, event.hasSessionCookie]), [
    ['subtitle_body', 'invalid_cue_content', false], ['subtitle_tracks', 'track_rejected', true],
  ]);
  privateSafe(f.events); assert.equal(f.calls.length, 3);
});
