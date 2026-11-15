/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BiliClient } from '../src/client.ts';
import { BiliError } from '../src/errors.ts';
import type { TransportOptions, TransportResponse } from '../src/transport.ts';

const BV = 'BV1Z24J6dEBk', CDN = 'https://synthetic.bilivideo.com/media.mp4?synthetic=1';
const bytes = Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
const errorCode = (code: string) => (error: unknown) => error instanceof BiliError && error.code === code;
function fixture(response: Partial<TransportResponse> = {}, size: unknown = bytes.length) {
  const calls: { url: string; options: TransportOptions }[] = [];
  const client = new BiliClient({ transport: {
    async request(url, options) {
      calls.push({ url, options });
      if (new URL(url).pathname === '/x/player/playurl') return { status: 200, headers: {}, url,
        body: Buffer.from(JSON.stringify({ code: 0, data: { format: 'mp4', durl: [{ ...(size === null ? {} : { size }), url: CDN,
          backup_url: ['https://synthetic-backup.bilivideo.com/media.mp4'] }] } })) };
      assert.equal(url, CDN, 'a failed transfer must not try another CDN');
      return { status: 200, headers: {}, body: bytes, url, ...response };
    }, dispose() {},
  } });
  return { client, calls, download: (maxBytes = 1024) => client.media(BV, 10, maxBytes, { cookie: 'SESSDATA=SYNTHETIC_MEDIA_COOKIE' }) };
}

test('video asks for one uncompressed range and accepts complete 200 or full 206 with or without an API size', async t => {
  for (const status of [200, 206]) for (const size of [bytes.length, null]) for (const length of [undefined, String(bytes.length)]) {
    const headers: Record<string, string> = { 'content-type': 'video/mp4', 'content-encoding': 'identity' };
    if (status === 206) headers['content-range'] = 'bytes 0-15/16';
    if (length !== undefined) headers['content-length'] = length;
    const f = fixture({ status, headers }, size); t.after(() => f.client.dispose());
    assert.deepEqual(await f.download(), { mime: 'video/mp4', bytes });
    assert.equal(f.calls.length, 2); assert.equal(f.calls[0].options.headers?.Range, undefined);
    const sent = f.calls[1].options;
    assert.equal(sent.headers?.Range, 'bytes=0-'); assert.equal(sent.headers?.['Accept-Encoding'], 'identity');
    assert.equal(sent.headers?.Cookie, undefined); assert.equal(sent.headers?.Referer, 'https://www.bilibili.com/');
  }
});

test('full-body validation rejects ambiguous, truncated, nonzero and multipart range responses', async t => {
  const cases: Partial<TransportResponse>[] = [
    { status: 200, headers: { 'content-range': 'bytes 0-15/16' } },
    { status: 206 },
    ...['bytes 1-16/17', 'bytes 0-7/16', 'bytes 0-15/*', 'bytes */16', 'bytes 0-15/0', 'bytes -1-15/16',
      'bytes 0-15/16, bytes 0-15/16', 'bytes 0-15/16\r\nSYNTHETIC', 'bytes 0-9007199254740991/9007199254740992',
      'bytes 0-15/16.0', 'bytes 0-15/1e1', 'items 0-15/16'].map(range => ({ status: 206, headers: { 'content-range': range } })),
    { status: 206, headers: { 'content-range': ['bytes 0-15/16'] } },
    { status: 206, headers: { 'content-range': 'bytes 0-15/16' }, body: bytes.subarray(0, 15) },
    { status: 206, headers: { 'content-range': 'bytes 0-15/16' }, body: Buffer.concat([bytes, Buffer.from([0])]) },
    { status: 206, headers: { 'content-range': 'bytes 0-15/16', 'content-type': 'multipart/byteranges; boundary=synthetic' } },
    { status: 206, headers: { 'content-range': 'bytes 0-15/16', 'content-type': ['video/mp4', 'multipart/byteranges'] } },
  ];
  for (const response of cases) {
    const f = fixture(response); t.after(() => f.client.dispose());
    await assert.rejects(f.download(), errorCode('unsupported_media')); assert.equal(f.calls.length, 2);
  }
});

test('declared lengths must be exact decimal safe integers and agree with actual bytes for 200 and 206', async t => {
  for (const status of [200, 206]) for (const length of ['0', '15', '17', '-16', '+16', '16.0', '1.6e1', '16 ', '16,16',
    '9007199254740992', ['16']]) {
    const f = fixture({ status, headers: { ...(status === 206 ? { 'content-range': 'bytes 0-15/16' } : {}), 'content-length': length } });
    t.after(() => f.client.dispose()); await assert.rejects(f.download(), errorCode('unsupported_media')); assert.equal(f.calls.length, 2);
  }
});

test('compressed video responses cannot be treated as a complete byte representation', async t => {
  for (const status of [200, 206]) for (const encoding of ['gzip', 'br', 'deflate', 'unknown', 'identity, gzip', ['identity']]) {
    const f = fixture({ status, headers: { ...(status === 206 ? { 'content-range': 'bytes 0-15/16' } : {}), 'content-encoding': encoding } });
    t.after(() => f.client.dispose()); await assert.rejects(f.download(), errorCode('unsupported_media'));
  }
});

test('known playurl size, configured limit and MP4 signature remain mandatory', async t => {
  for (const status of [200, 206]) {
    const headers: Record<string, string> = status === 206 ? { 'content-range': 'bytes 0-15/16' } : {};
    const mismatch = fixture({ status, headers }, 17); t.after(() => mismatch.client.dispose());
    await assert.rejects(mismatch.download(), errorCode('unsupported_media'));
    const invalid = fixture({ status, headers, body: Buffer.alloc(16) }); t.after(() => invalid.client.dispose());
    await assert.rejects(invalid.download(), errorCode('unsupported_media'));
  }
  const preflight = fixture({}, 1025); t.after(() => preflight.client.dispose());
  await assert.rejects(preflight.download(), errorCode('too_large')); assert.equal(preflight.calls.length, 1);
  const oversized = fixture({ status: 206, headers: { 'content-range': 'bytes 0-1024/1025' } }, null); t.after(() => oversized.client.dispose());
  await assert.rejects(oversized.download(), errorCode('too_large'));
  const bodyLimit = fixture({ body: Buffer.alloc(1025) }, null); t.after(() => bodyLimit.client.dispose());
  await assert.rejects(bodyLimit.download(), errorCode('too_large'));
});

test('HTTP 567 reports only a fixed video-download rejection and does not retry', async t => {
  const f = fixture({ status: 567, body: Buffer.from('SYNTHETIC_SERVER_BODY_COOKIE_TOKEN') }); t.after(() => f.client.dispose());
  await assert.rejects(f.download(), error => error instanceof BiliError && error.code === 'media_download_rejected'
    && error.message.includes('视频下载阶段') && error.message.includes('HTTP 567') && !error.message.includes('SYNTHETIC') && !error.message.includes('账号风控'));
  assert.equal(f.calls.length, 2);
  for (const [status, code] of [[403, 'access_blocked'], [412, 'access_blocked'], [404, 'platform_error'], [500, 'platform_error']] as const) {
    const g = fixture({ status }); t.after(() => g.client.dispose()); await assert.rejects(g.download(), errorCode(code)); assert.equal(g.calls.length, 2);
  }
});
