/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { BiliError } from './errors.ts';

const loginOrigins = new Set(['https://passport.bilibili.com', 'https://account.bilibili.com']);

/** The API may issue either observed official QR destination; never echo an invalid URL. */
export function validateLoginUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096 || /[\x00-\x20\x7f]/.test(value)) throw new BiliError('malformed_response');
  let url: URL;
  try { url = new URL(value); } catch { throw new BiliError('malformed_response'); }
  if (!loginOrigins.has(url.origin) || url.username || url.password || (url.port && url.port !== '443') || url.hash || url.href.length > 4096) throw new BiliError('malformed_response');
  return url.href;
}
