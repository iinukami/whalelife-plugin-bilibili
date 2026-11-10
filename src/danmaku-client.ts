/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { BiliError } from './errors.ts';
import { normalizeCookie } from './auth.ts';
import { safeUrl } from './transport.ts';
import type { Transport } from './transport.ts';
import type { CallOptions } from './types.ts';
export interface DanmakuInput { aid: number; cid: number; fromSeconds: number; toSeconds: number }
export interface DanmakuItem { id: string; atSeconds: number; text: string; mode: number }
export interface DanmakuResult { items: DanmakuItem[]; truncated: boolean; excludedModes: number; segments: number[] }
const MAX_BYTES = 2 * 1024 * 1024, MAX_ITEMS = 12000;
/** Only decode bounded scalar fields; unknown protobuf fields are skipped, never evaluated. */
class Reader {
  offset = 0;
  readonly bytes: Buffer;
  constructor(bytes: Buffer) { this.bytes = bytes; }
  integer(): bigint {
    let value = 0n;
    for (let index = 0; index < 10; index++) {
      if (this.offset >= this.bytes.length) throw new BiliError('malformed_response');
      const byte = this.bytes[this.offset++]!;
      if (index === 9 && byte > 1) throw new BiliError('malformed_response');
      value |= BigInt(byte & 127) << BigInt(index * 7);
      if (!(byte & 128)) return value;
    }
    throw new BiliError('malformed_response');
  }
  field() {
    const tag = this.integer();
    if (tag > 0xffffffffn || tag < 8n) throw new BiliError('malformed_response');
    return { id: Number(tag >> 3n), wire: Number(tag & 7n) };
  }
  block(): Buffer {
    const length = this.integer();
    if (length > BigInt(this.bytes.length - this.offset)) throw new BiliError('malformed_response');
    const value = this.bytes.subarray(this.offset, this.offset + Number(length)); this.offset += Number(length); return value;
  }
  skip(wire: number) {
    if (wire === 0) { this.integer(); return; }
    if (wire === 2) { this.block(); return; }
    const length = wire === 1 ? 8 : wire === 5 ? 4 : 0;
    if (!length || this.offset + length > this.bytes.length) throw new BiliError('malformed_response');
    this.offset += length;
  }
}
function decodeElement(bytes: Buffer): DanmakuItem {
  const reader = new Reader(bytes), seen = new Set<number>();
  let id = '0', idStr: string | undefined, progress = 0n, mode = 0n, text = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  while (reader.offset < bytes.length) {
    const field = reader.field();
    if ([1, 2, 3, 7, 12].includes(field.id)) {
      if (seen.has(field.id)) throw new BiliError('malformed_response'); seen.add(field.id);
      if ([1, 2, 3].includes(field.id)) {
        if (field.wire !== 0) throw new BiliError('malformed_response');
        const value = reader.integer();
        if (field.id === 1) id = value.toString(); else if (field.id === 2) progress = value; else mode = value;
      } else {
        if (field.wire !== 2) throw new BiliError('malformed_response');
        const value = reader.block(); if (value.length > 16384) throw new BiliError('too_large');
        let decoded: string; try { decoded = decoder.decode(value); } catch { throw new BiliError('malformed_response'); }
        if (field.id === 12) idStr = decoded; else text = decoded;
      }
    } else reader.skip(field.wire);
  }
  if (idStr !== undefined && (!/^[1-9]\d{0,19}$/.test(idStr) || id !== '0' && id !== idStr)) throw new BiliError('malformed_response');
  id = idStr ?? id;
  if (id === '0' || progress > 0x7fffffffn || mode > 100n) throw new BiliError('malformed_response');
  return { id, atSeconds: Number(progress) / 1000, mode: Number(mode), text: text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '') };
}
export function decodeDanmaku(bytes: Buffer): DanmakuItem[] {
  if (bytes.length > MAX_BYTES) throw new BiliError('too_large');
  const reader = new Reader(bytes), items: DanmakuItem[] = [];
  while (reader.offset < bytes.length) {
    const { id, wire } = reader.field();
    if (id === 1) {
      if (wire !== 2) throw new BiliError('malformed_response');
      if (items.length >= MAX_ITEMS) throw new BiliError('too_large');
      items.push(decodeElement(reader.block()));
    } else reader.skip(wire);
  }
  return items;
}
export async function readDanmaku(transport: Transport, input: DanmakuInput, options: CallOptions): Promise<DanmakuResult> {
  const { aid, cid, fromSeconds: from, toSeconds: to } = input;
  if (![aid, cid].every(n => Number.isSafeInteger(n) && n > 0) || !Number.isFinite(from) || !Number.isFinite(to)
    || from < 0 || to <= from || to - from > 60 || to > 2147483) throw new BiliError('invalid_input');
  if (options.signal?.aborted) throw new BiliError('cancelled');
  const first = Math.floor(from / 360) + 1, last = Math.ceil(to / 360), items = new Map<string, DanmakuItem>(), segments: number[] = [];
  let excludedModes = 0, truncated = false;
  for (let segment = first; segment <= last; segment++) {
    if (options.signal?.aborted) throw new BiliError('cancelled');
    const url = new URL('https://api.bilibili.com/x/v2/dm/web/seg.so');
    url.search = new URLSearchParams({ type: '1', oid: String(cid), pid: String(aid), segment_index: String(segment) }).toString();
    const response = await transport.request(url.href, { signal: options.signal, timeoutMs: options.timeoutMs ?? 20000, maxBytes: MAX_BYTES,
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/',
        ...(options.cookie ? { Cookie: normalizeCookie(options.cookie) } : {}) } });
    const final = safeUrl(response.url);
    if (final.origin !== url.origin || final.pathname !== url.pathname || final.search !== url.search) throw new BiliError('unsafe_url');
    if ([401, 403, 412, 429, 503].includes(response.status)) throw new BiliError('access_blocked');
    if (response.status !== 200) throw new BiliError('platform_error');
    if (options.signal?.aborted) throw new BiliError('cancelled');
    if (/json|html/i.test(String(response.headers['content-type'] ?? '')) || /^[\[{<]/.test(response.body.toString('utf8', 0, 32))) {
      let code: unknown; try { code = JSON.parse(response.body.toString('utf8')).code; } catch { /* Fail closed for non-protobuf responses. */ }
      throw new BiliError(code === -101 ? 'login_required' : [-352, -412, -509, -799].includes(Number(code)) ? 'access_blocked' : 'malformed_response');
    }
    for (const item of decodeDanmaku(response.body)) {
      if (item.atSeconds < from || item.atSeconds >= to) continue;
      if (item.mode < 1 || item.mode > 6) { excludedModes++; continue; }
      if (!item.text.trim()) continue;
      if (item.text.length > 500) { item.text = item.text.slice(0, 500); truncated = true; }
      if (items.has(item.id)) continue;
      if (items.size >= MAX_ITEMS) { truncated = true; continue; }
      items.set(item.id, item);
    }
    segments.push(segment);
  }
  return { items: [...items.values()].sort((a, b) => a.atSeconds - b.atSeconds || a.id.localeCompare(b.id)), segments, excludedModes, truncated };
}
