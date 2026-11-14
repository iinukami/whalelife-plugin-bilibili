/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { createHash } from 'node:crypto';
import { BiliError } from './errors.ts';

export interface WbiKeys { img: string; sub: string }
// The first 32 protocol positions form the signing key; these are protocol data.
const positions = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13];

function key(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new BiliError('malformed_response');
  let url: URL;
  try { url = new URL(value); } catch { throw new BiliError('malformed_response'); }
  const match = /\/([a-f0-9]{32})\.png$/.exec(url.pathname);
  if (!match || url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
    || !(url.hostname === 'hdslb.com' || url.hostname.endsWith('.hdslb.com'))) throw new BiliError('malformed_response');
  // These URLs carry key material. They are never fetched as images.
  return match[1];
}

export function readWbiKeys(value: unknown): WbiKeys {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BiliError('malformed_response');
  const data = value as { img_url?: unknown; sub_url?: unknown };
  return { img: key(data.img_url), sub: key(data.sub_url) };
}

export function signWbi(params: Readonly<Record<string, string>>, keys: WbiKeys, timestamp = Math.floor(Date.now() / 1000)): string {
  if (!/^[a-f0-9]{32}$/.test(keys.img) || !/^[a-f0-9]{32}$/.test(keys.sub)
    || !Number.isSafeInteger(timestamp) || timestamp < 0) throw new BiliError('invalid_input');
  const values: Record<string, string> = { ...params, wts: String(timestamp) };
  let encoded: string;
  try {
    encoded = Object.keys(values).sort().map(name => {
      // WBI signs this exact encoding, including %20 rather than form-style '+'.
      const value = values[name].replace(/[!'()*]/g, '');
      return encodeURIComponent(name) + '=' + encodeURIComponent(value);
    }).join('&');
  } catch { throw new BiliError('invalid_input'); }
  const material = keys.img + keys.sub;
  const signingKey = positions.map(index => material[index]).join('');
  return encoded + '&w_rid=' + createHash('md5').update(encoded + signingKey).digest('hex');
}
