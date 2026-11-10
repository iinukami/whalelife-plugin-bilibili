/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeDanmaku, readDanmaku } from '../src/danmaku-client.ts';
import { BiliError } from '../src/errors.ts';
import type { Transport, TransportOptions, TransportResponse } from '../src/transport.ts';
const code = (value: string) => (error: unknown) => error instanceof BiliError && error.code === value;
function varint(value: bigint | number): Buffer {
  let n = BigInt(value); const bytes: number[] = [];
  do { bytes.push(Number(n & 127n) | (n > 127n ? 128 : 0)); n >>= 7n; } while (n);
  return Buffer.from(bytes);
}
const int = (field: number, value: bigint | number) => Buffer.concat([varint(field * 8), varint(value)]);
const block = (field: number, value: Buffer | string) => { const bytes = Buffer.from(value); return Buffer.concat([varint(field * 8 + 2), varint(bytes.length), bytes]); };
const item = (id: bigint | number, ms: number, mode = 1, text = 'SYNTHETIC_DANMAKU') => block(1, Buffer.concat([int(1, id), int(2, ms), int(3, mode), block(6, 'SYNTHETIC_IGNORED_USER_HASH'), block(7, text), block(12, String(id))]));
function fixture(queue: Partial<TransportResponse>[]) {
  const calls: { url: string; options: TransportOptions }[] = [];
  const transport: Transport = { async request(url, options) { calls.push({ url, options }); const next = queue.shift(); assert.ok(next); return { url, status: 200, headers: {}, body: Buffer.alloc(0), ...next }; }, dispose() {} };
  return { transport, calls };
}
const input = { aid: 123, cid: 456, fromSeconds: 0, toSeconds: 30 };

test('protobuf preserves large ids and Unicode while omitting author hashes and unknown fields', () => {
  const bytes = Buffer.concat([item(9007199254740993123n, 1250, 5, '合成弹幕\u0000'), int(4, 1)]);
  assert.deepEqual(decodeDanmaku(bytes), [{ id: '9007199254740993123', atSeconds: 1.25, mode: 5, text: '合成弹幕' }]);
  assert.deepEqual(decodeDanmaku(Buffer.alloc(0)), []);
  for (const bytes of [Buffer.from([0]), Buffer.from([10, 128]), Buffer.from([10, 9, 8, 1]), Buffer.from([15]),
    block(1, Buffer.concat([int(1, 1), int(1, 1)])), block(1, Buffer.concat([int(1, 1), block(7, Buffer.from([255]))])),
    block(1, Buffer.concat([int(1, 1), block(12, '2')])), block(1, Buffer.concat([int(1, 1), int(2, 0x80000000)])),
    block(1, Buffer.concat([int(1, 1), Buffer.from([16, ...Array(10).fill(255)])]))]) assert.throws(() => decodeDanmaku(bytes), code('malformed_response'));
  assert.throws(() => decodeDanmaku(Buffer.alloc(2 * 1024 * 1024 + 1)), code('too_large'));
});

test('danmaku windows span only required segments and filter exclusive end, modes and duplicate ids', async () => {
  const f = fixture([{ body: Buffer.concat([item(1, 359000), item(2, 360000), item(3, 359500, 7), item(4, 358999)]) },
    { body: Buffer.concat([item(2, 360000), item(5, 361000), item(6, 360500, 1, 'x'.repeat(501))]) }]);
  const result = await readDanmaku(f.transport, { ...input, fromSeconds: 359, toSeconds: 361 }, {});
  assert.deepEqual(result.segments, [1, 2]); assert.deepEqual(result.items.map(i => i.id), ['1', '2', '6']);
  assert.equal(result.items.at(-1)!.text.length, 500); assert.equal(result.truncated, true); assert.equal(result.excludedModes, 1);
  assert.ok(!JSON.stringify(result).includes('USER_HASH'));
  assert.ok(f.calls.every(c => !c.options.method && !c.options.headers?.Cookie && c.options.maxBytes === 2097152));
  assert.deepEqual(f.calls.map(c => new URL(c.url).searchParams.get('segment_index')), ['1', '2']);
  const exact = fixture([{ body: item(1, 359000) }]);
  await readDanmaku(exact.transport, { ...input, fromSeconds: 359, toSeconds: 360 }, {}); assert.equal(exact.calls.length, 1);
});

test('danmaku validates limits and cancellation locally; blocked, JSON, redirected and malformed replies fail explicitly', async () => {
  const f = fixture([]);
  for (const patch of [{ aid: 0 }, { fromSeconds: -1 }, { toSeconds: 61 }, { toSeconds: NaN }, { toSeconds: 0 }])
    await assert.rejects(readDanmaku(f.transport, { ...input, ...patch }, {}), code('invalid_input'));
  await assert.rejects(readDanmaku(f.transport, input, { signal: AbortSignal.abort() }), code('cancelled')); assert.equal(f.calls.length, 0);
  for (const [response, expected] of [[{ status: 403 }, 'access_blocked'], [{ body: Buffer.from('{"code":-101}') }, 'login_required'],
    [{ body: Buffer.from('<html>') }, 'malformed_response'], [{ body: Buffer.from([10, 100]) }, 'malformed_response'],
    [{ url: 'https://api.bilibili.com/other' }, 'unsafe_url']] as const) {
    const next = fixture([response]); await assert.rejects(readDanmaku(next.transport, input, {}), code(expected)); assert.equal(next.calls.length, 1);
  }
});
