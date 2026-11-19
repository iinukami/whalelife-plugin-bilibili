/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import type { IncomingMessage, ClientRequest } from 'node:http';
import { createTransport, publicAddress, safeUrl, TransportError } from '../src/transport.ts';
import { BiliError } from '../src/errors.ts';

type Plan = { status?: number; headers?: Record<string, string | string[]>; body?: Buffer; hold?: boolean; complete?: boolean; error?: boolean };
const options = { timeoutMs: 1000, maxBytes: 4096 };
const errorCode = (code: string) => (error: unknown) => error instanceof BiliError && error.code === code;
function fixture(plan: Plan[] = []) {
  const calls: { url: URL; options: Record<string, any>; body?: string; destroyed: boolean }[] = [];
  const dns: string[] = []; const responses: PassThrough[] = [];
  const transport = createTransport({
    async lookup(host) { dns.push(host); return [{ address: host === 'private.example' ? '127.0.0.1' : '93.184.216.34', family: 4 }]; },
    request(url, settings, callback) {
      const call = { url: new URL(url.href), options: { ...settings, headers: { ...(settings.headers as object) } }, body: undefined as string | undefined, destroyed: false }; calls.push(call);
      const request = new EventEmitter() as any;
      request.destroy = () => { call.destroyed = true; return request; };
      request.end = (body?: string) => {
        call.body = body; const next = plan.shift(); assert.ok(next, 'missing synthetic network response');
        queueMicrotask(() => {
          if (next.error) { request.emit('error', new Error('synthetic-network-secret')); return; }
          const response = new PassThrough() as PassThrough & { statusCode: number; headers: object; complete: boolean };
          response.statusCode = next.status ?? 200; response.headers = next.headers ?? {}; response.complete = next.complete ?? true;
          responses.push(response); callback(response as unknown as IncomingMessage);
          if (!next.hold) response.end(next.body ?? Buffer.from('synthetic'));
        });
        return request;
      };
      return request as ClientRequest;
    },
  });
  return { transport, calls, dns, responses };
}

test('HTTPS URL and address policy rejects local, mapped, reserved, credential and malformed targets', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '169.254.169.254', '100.64.1.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('93.184.216.34'), true);
  for (const url of ['http://example.com/', 'https://127.1/', 'https://2130706433/', 'https://user:secret@example.com/', 'https://example.com:8443/', 'https://localhost/', 'https://example.com./', 'https://example.com/#x', 'https://example.com/\r\nsecret']) assert.throws(() => safeUrl(url), errorCode('unsafe_url'), url);
});

test('mixed DNS answers reject before dispatch and fixed lookup preserves hostname/TLS identity', async () => {
  let sent = false;
  const bad = createTransport({ lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }], request() { sent = true; throw new Error(); } });
  await assert.rejects(bad.request('https://example.com/', options), errorCode('unsafe_url')); assert.equal(sent, false);
  const f = fixture([{}]); await f.transport.request('https://api.bilibili.com/x/test', options);
  assert.deepEqual(f.dns, ['api.bilibili.com']); assert.equal(f.calls[0].options.servername, 'api.bilibili.com');
  const lookup = f.calls[0].options.lookup;
  lookup('ignored', {}, (error: unknown, address: string, family: number) => { assert.equal(error, null); assert.equal(address, '93.184.216.34'); assert.equal(family, 4); });
  lookup('ignored', { all: true }, (error: unknown, addresses: unknown) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]); });
});

test('redirects revalidate every destination and cannot forward authentication cookies', async () => {
  const f = fixture([{ status: 302, headers: { location: 'https://cdn.example/media' } }, {}]);
  await f.transport.request('https://api.bilibili.com/redirect', { ...options, headers: { Cookie: 'SESSDATA=synthetic' } });
  assert.deepEqual(f.dns, ['api.bilibili.com', 'cdn.example']);
  assert.equal(f.calls[0].options.headers.cookie, 'SESSDATA=synthetic'); assert.equal(f.calls[1].options.headers.cookie, undefined);
  const blocked = fixture([{ status: 302, headers: { location: 'https://private.example/' } }]);
  await assert.rejects(blocked.transport.request('https://api.bilibili.com/redirect', options), errorCode('unsafe_url')); assert.equal(blocked.calls.length, 1);
  const same = fixture([{ status: 302, headers: { location: '/again' } }, {}]); await same.transport.request('https://example.com/', options); assert.equal(same.dns.length, 2);
});

test('cookies, injected headers and POST destinations fail locally outside the fixed origin policy', async () => {
  const f = fixture();
  await assert.rejects(f.transport.request('https://cdn.example/', { ...options, headers: { Cookie: 'SESSDATA=synthetic' } }), errorCode('unsafe_url'));
  for (const headers of [{ Authorization: 'Bearer synthetic' }, { Host: 'evil.example' }, { Cookie: 'value\r\nsecret' }] as Record<string, string>[])
    await assert.rejects(f.transport.request('https://api.bilibili.com/', { ...options, headers }), errorCode('invalid_input'));
  await assert.rejects(f.transport.request('https://www.bilibili.com/', { ...options, method: 'POST', body: 'x=1' }), errorCode('unsafe_url'));
  assert.equal(f.calls.length, 0);
});

test('gzip and brotli decode with independent wire and decoded limits', async () => {
  const raw = Buffer.from('合成文字'.repeat(50));
  for (const [encoding, bytes] of [['gzip', gzipSync(raw)], ['br', brotliCompressSync(raw)]] as const) {
    const f = fixture([{ headers: { 'content-encoding': encoding }, body: bytes }]);
    assert.deepEqual((await f.transport.request('https://example.com/', options)).body, raw);
  }
  const bomb = fixture([{ headers: { 'content-encoding': 'gzip' }, body: gzipSync(Buffer.alloc(10000, 65)) }]);
  await assert.rejects(bomb.transport.request('https://example.com/', { ...options, maxBytes: 100 }), errorCode('too_large'));
  const wire = fixture([{ body: Buffer.alloc(200) }]); await assert.rejects(wire.transport.request('https://example.com/', { ...options, maxBytes: 100 }), errorCode('too_large'));
  const declared = fixture([{ headers: { 'content-length': '200' }, body: Buffer.alloc(1) }]); await assert.rejects(declared.transport.request('https://example.com/', { ...options, maxBytes: 100 }), errorCode('too_large'));
});

test('passport POST is restricted to the two renewal endpoints and never follows redirects', async t => {
  const f = fixture([{}, {}, { status: 302, headers: { location: 'https://passport.bilibili.com/other' } }]);
  t.after(() => f.transport.dispose());
  for (const path of ['/x/passport-login/web/cookie/refresh', '/x/passport-login/web/confirm/refresh'])
    await f.transport.request('https://passport.bilibili.com' + path, { ...options, method: 'POST', body: 'synthetic=1' });
  for (const path of ['/other', '/x/passport-login/web/cookie/refresh?x=1', '/x/passport-login/web/cookie/refresh/'])
    await assert.rejects(f.transport.request('https://passport.bilibili.com' + path, { ...options, method: 'POST', body: 'synthetic=1' }), errorCode('unsafe_url'));
  assert.equal(f.calls.length, 2);
  await assert.rejects(f.transport.request('https://passport.bilibili.com/x/passport-login/web/cookie/refresh', { ...options, method: 'POST', body: 'synthetic=1' }), error => error instanceof TransportError && error.submitted);
  assert.equal(f.calls.length, 3);
});

test('unsupported compression, incomplete bodies and transport errors fail with fixed safe messages', async () => {
  const unknown = fixture([{ headers: { 'content-encoding': 'unknown' } }]); await assert.rejects(unknown.transport.request('https://example.com/', options), errorCode('malformed_response'));
  const incomplete = fixture([{ complete: false }]); await assert.rejects(incomplete.transport.request('https://example.com/', options), errorCode('network_error'));
  const failed = fixture([{ error: true }]);
  await assert.rejects(failed.transport.request('https://example.com/', options), error => error instanceof BiliError && error.code === 'network_error' && !error.message.includes('synthetic-network-secret'));
});

test('DNS total deadline and caller cancellation cannot dispatch late requests or expose reasons', async () => {
  let resolve!: (value: { address: string; family: number }[]) => void; let sent = 0;
  const t = createTransport({ lookup: () => new Promise(accept => { resolve = accept; }), request() { sent++; throw Error('unexpected'); } });
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(t.request('https://example.com/', { ...options, timeoutMs: 20 }), errorCode('timeout')); }
  finally { clearTimeout(keepAlive); }
  resolve([{ address: '93.184.216.34', family: 4 }]); await new Promise(accept => setImmediate(accept)); assert.equal(sent, 0);
  const f = fixture([{ hold: true }]); const abort = new AbortController();
  const pending = f.transport.request('https://example.com/', { ...options, signal: abort.signal });
  await new Promise(accept => setImmediate(accept)); abort.abort('synthetic-secret-reason');
  await assert.rejects(pending, error => error instanceof BiliError && error.code === 'cancelled' && !error.message.includes('synthetic-secret-reason'));
  assert.equal(f.calls[0].destroyed, true); assert.equal(f.responses[0].destroyed, true);
});

test('POST never follows redirects and marks dispatched failures as uncertain evidence', async () => {
  const f = fixture([{ status: 302, headers: { location: 'https://api.bilibili.com/again' } }]);
  await assert.rejects(f.transport.request('https://api.bilibili.com/x/interaction', { ...options, method: 'POST', body: 'synthetic=1' }),
    error => error instanceof TransportError && error.code === 'uncertain' && error.submitted);
  assert.equal(f.calls.length, 1);
  const failed = fixture([{ error: true }]);
  await assert.rejects(failed.transport.request('https://api.bilibili.com/x/interaction', { ...options, method: 'POST', body: 'synthetic=1' }),
    error => error instanceof TransportError && error.submitted && error.code === 'network_error');
});

test('dispose cancels active requests and permanently prevents new work', async () => {
  const f = fixture([{ hold: true }]); const pending = f.transport.request('https://example.com/', options);
  await new Promise(accept => setImmediate(accept)); await f.transport.dispose();
  await assert.rejects(pending, errorCode('stopped')); await assert.rejects(f.transport.request('https://example.com/', options), errorCode('stopped'));
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].destroyed, true);
});

test('only exact full GET ranges are accepted and compression negotiation stays identity', async t => {
  const f = fixture([{ status: 206, headers: { 'content-range': 'bytes 0-8/9' } }]); t.after(() => f.transport.dispose());
  await f.transport.request('https://example.com/media', { ...options, headers: { Range: 'bytes=0-' } });
  assert.equal(f.calls[0].options.headers.range, 'bytes=0-'); assert.equal(f.calls[0].options.headers['accept-encoding'], 'identity');
  const blocked = fixture(); t.after(() => blocked.transport.dispose());
  for (const range of ['bytes=1-', 'bytes=0-15', 'bytes=-16', 'bytes=0-,16-', 'bytes=0- ', 'Bytes=0-', 'bytes=00-'])
    await assert.rejects(blocked.transport.request('https://example.com/media', { ...options, headers: { Range: range } }), errorCode('invalid_input'));
  for (const headers of [{ Range: 'bytes=0-', range: 'bytes=0-' }, { Range: 'bytes=0-', 'Accept-Encoding': 'gzip' }] as Record<string, string>[])
    await assert.rejects(blocked.transport.request('https://example.com/media', { ...options, headers }), errorCode('invalid_input'));
  await assert.rejects(blocked.transport.request('https://api.bilibili.com/x/test', { ...options, method: 'POST', body: 'x=1', headers: { Range: 'bytes=0-' } }), errorCode('invalid_input'));
  assert.deepEqual(blocked.dns, []); assert.equal(blocked.calls.length, 0);
});

test('range redirects preserve the range and revalidate TLS DNS and cookie boundaries', async t => {
  const f = fixture([{ status: 302, headers: { location: 'https://cdn.example/media' } }, { status: 206, headers: { 'content-range': 'bytes 0-8/9' } }]);
  t.after(() => f.transport.dispose());
  await f.transport.request('https://api.bilibili.com/media', { ...options, headers: { Range: 'bytes=0-', Cookie: 'SESSDATA=synthetic' } });
  assert.deepEqual(f.dns, ['api.bilibili.com', 'cdn.example']);
  assert.equal(f.calls[0].options.headers.cookie, 'SESSDATA=synthetic'); assert.equal(f.calls[1].options.headers.cookie, undefined);
  for (const call of f.calls) { assert.equal(call.options.headers.range, 'bytes=0-'); assert.equal(call.options.headers['accept-encoding'], 'identity'); assert.equal(call.options.servername, call.url.hostname); }
  const blocked = fixture([{ status: 302, headers: { location: 'https://private.example/media' } }]); t.after(() => blocked.transport.dispose());
  await assert.rejects(blocked.transport.request('https://example.com/media', { ...options, headers: { Range: 'bytes=0-' } }), errorCode('unsafe_url'));
  assert.equal(blocked.calls.length, 1);
});

test('range responses cannot be decompressed and cancellation destroys an in-flight transfer', async t => {
  for (const status of [200, 206]) for (const encoding of ['gzip', 'deflate', 'br']) {
    const f = fixture([{ status, headers: { 'content-encoding': encoding }, body: gzipSync(Buffer.from('synthetic')) }]); t.after(() => f.transport.dispose());
    await assert.rejects(f.transport.request('https://example.com/media', { ...options, headers: { Range: 'bytes=0-' } }), errorCode('unsupported_media'));
    assert.equal(f.responses[0].destroyed, true); assert.equal(f.calls.length, 1);
  }
  const f = fixture([{ hold: true }]), controller = new AbortController(); t.after(() => f.transport.dispose());
  const pending = f.transport.request('https://example.com/media', { ...options, headers: { Range: 'bytes=0-' }, signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort('SYNTHETIC_PRIVATE_REASON');
  await assert.rejects(pending, error => error instanceof BiliError && error.code === 'cancelled' && !error.message.includes('SYNTHETIC'));
  assert.equal(f.responses[0].destroyed, true); assert.equal(f.calls[0].destroyed, true);
});


test('comment origin and CSRF headers are scoped to the exact POST endpoint and body token', async t => {
  const csrf = '0123456789abcdef0123456789abcdef';
  const f = fixture([{}]); t.after(() => f.transport.dispose());
  await f.transport.request('https://api.bilibili.com/x/v2/reply/add', { ...options, method: 'POST', body: 'csrf=' + csrf,
    headers: { Origin: 'https://www.bilibili.com', 'X-CSRF-Token': csrf } });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.headers.origin, 'https://www.bilibili.com');
  assert.equal(f.calls[0].options.headers['x-csrf-token'], csrf);
  const bad = fixture(); t.after(() => bad.transport.dispose());
  const headers = { Origin: 'https://www.bilibili.com', 'x-csrf-token': csrf };
  for (const url of ['https://cdn.example/x/v2/reply/add', 'https://www.bilibili.com/x/v2/reply/add',
    'https://passport.bilibili.com/x/passport-login/web/cookie/refresh', 'https://api.bilibili.com/x/v2/reply/add/',
    'https://api.bilibili.com/x/v2/reply/add?x=1', 'https://api.bilibili.com/x/web-interface/archive/like']) {
    await assert.rejects(bad.transport.request(url, { ...options, method: 'POST', body: 'csrf=' + csrf, headers }),
      error => error instanceof BiliError && ['invalid_input', 'unsafe_url'].includes(error.code));
  }
  await assert.rejects(bad.transport.request('https://api.bilibili.com/x/v2/reply/add', { ...options, headers }), errorCode('unsafe_url'));
  for (const h of [{ ...headers, Origin: 'https://evil.example' }, { ...headers, Origin: 'https://www.bilibili.com/' },
    { ...headers, origin: headers.Origin }, { ...headers, 'X-CSRF-Token': csrf }, { ...headers, 'x-csrf-token': 'short' },
    { ...headers, 'x-csrf-token': 'x'.repeat(129) }, { ...headers, 'x-csrf-token': 'x'.repeat(15) + '=' }]) {
    await assert.rejects(bad.transport.request('https://api.bilibili.com/x/v2/reply/add', { ...options, method: 'POST', body: 'csrf=' + csrf, headers: h }), errorCode('invalid_input'));
  }
  for (const body of ['csrf=' + 'a'.repeat(32), 'message=synthetic', 'csrf=' + csrf + '&csrf=' + csrf])
    await assert.rejects(bad.transport.request('https://api.bilibili.com/x/v2/reply/add', { ...options, method: 'POST', body, headers }), errorCode('invalid_input'));
  assert.equal(bad.calls.length, 0); assert.deepEqual(bad.dns, []);
});

test('comment credential headers never follow a redirect or cause a second submission', async t => {
  const csrf = '0123456789abcdef0123456789abcdef';
  const f = fixture([{ status: 302, headers: { location: 'https://cdn.example/redirected' } }]); t.after(() => f.transport.dispose());
  await assert.rejects(f.transport.request('https://api.bilibili.com/x/v2/reply/add', { ...options, method: 'POST', body: 'csrf=' + csrf,
    headers: { Cookie: 'SESSDATA=synthetic', Origin: 'https://www.bilibili.com', 'x-csrf-token': csrf } }),
    error => error instanceof TransportError && error.code === 'uncertain' && error.submitted);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.dns, ['api.bilibili.com']);
});


test('signed comment POST accepts exactly one WBI signature and timestamp without weakening credential boundaries', async t => {
  const csrf = '0123456789abcdef0123456789abcdef', signature = 'a'.repeat(32);
  const f = fixture([{ headers: { 'retry-after': '600' } }]); t.after(() => f.transport.dispose());
  const url = 'https://api.bilibili.com/x/v2/reply/add?w_rid=' + signature + '&wts=1795100000';
  const settings = { ...options, method: 'POST' as const, body: 'csrf=' + csrf, headers: { Origin: 'https://www.bilibili.com', 'x-csrf-token': csrf } };
  const result = await f.transport.request(url, settings);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url.href, url); assert.equal(result.headers['retry-after'], '600');
  const bad = fixture(); t.after(() => bad.transport.dispose());
  for (const query of ['w_rid=' + signature, 'wts=1795100000', 'w_rid=x&wts=1795100000', 'w_rid=' + signature + '&wts=0',
    'w_rid=' + signature + '&wts=-1', 'w_rid=' + signature + '&wts=1e9', 'w_rid=' + signature + '&wts=1795100000&extra=1',
    'w_rid=' + signature + '&wts=1795100000&wts=1795100000', 'w_rid=' + signature + '&w_rid=' + signature + '&wts=1795100000'])
    await assert.rejects(bad.transport.request('https://api.bilibili.com/x/v2/reply/add?' + query, settings), errorCode('unsafe_url'));
  assert.equal(bad.calls.length, 0); assert.deepEqual(bad.dns, []);
});

test('signed comment credentials cannot follow redirects and Retry-After survives rejected HTTP responses', async t => {
  const csrf = '0123456789abcdef0123456789abcdef';
  const f = fixture([{ status: 302, headers: { location: 'https://cdn.example/' } }, { status: 429, headers: { 'retry-after': '900' } }]); t.after(() => f.transport.dispose());
  await assert.rejects(f.transport.request('https://api.bilibili.com/x/v2/reply/add?w_rid=' + 'b'.repeat(32) + '&wts=1795100000',
    { ...options, method: 'POST', body: 'csrf=' + csrf, headers: { Cookie: 'SESSDATA=synthetic', Origin: 'https://www.bilibili.com', 'x-csrf-token': csrf } }),
    error => error instanceof TransportError && error.code === 'uncertain' && error.submitted);
  assert.equal(f.calls.length, 1);
  const blocked = await f.transport.request('https://api.bilibili.com/x/test', options);
  assert.equal(blocked.status, 429); assert.equal(blocked.headers['retry-after'], '900');
});


test('account and permission changes while DNS resolves prevent actual POST transmission', async t => {
  for (const code of ['account_changed', 'interaction_disabled']) {
    let resolve!: (value: {address:string;family:number}[]) => void, changed = false, sent = 0;
    const transport = createTransport({ lookup: () => new Promise(accept => { resolve = accept; }), request() { sent++; throw Error('unexpected send'); } });
    t.after(() => transport.dispose());
    const post = transport.request('https://api.bilibili.com/x/v2/reply/add', { ...options, method: 'POST', body: 'synthetic=1',
      beforeDispatch() { if (changed) throw new BiliError(code); } });
    const rejected = assert.rejects(post, cause => cause instanceof TransportError && cause.code === code && !cause.submitted);
    await new Promise(accept => setImmediate(accept)); changed = true; resolve([{ address: '93.184.216.34', family: 4 }]); await rejected;
    assert.equal(sent, 0);
  }
});

test('beforeDispatch stays local and untrusted callback exceptions produce safe fixed errors', async t => {
  const f = fixture([{}]); t.after(() => f.transport.dispose()); let calls = 0;
  await f.transport.request('https://api.bilibili.com/x/test', { ...options, beforeDispatch() { calls++; } });
  assert.equal(calls, 1); assert.equal(f.calls[0].options.beforeDispatch, undefined); assert.equal(f.calls[0].options.headers.beforeDispatch, undefined);
  const blocked = fixture(); t.after(() => blocked.transport.dispose());
  await assert.rejects(blocked.transport.request('https://api.bilibili.com/x/v2/reply/add', { ...options, method: 'POST', body: 'x=1', beforeDispatch() { throw Error('PRIVATE_PERMISSION_REASON'); } }),
    cause => cause instanceof TransportError && cause.code === 'config_conflict' && !cause.submitted && !cause.message.includes('PRIVATE'));
  assert.equal(blocked.calls.length, 0);
});
