/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { BiliError } from './errors.ts';

// This is the existing import allowlist, shared by import, QR login and renewal.
// Do not expand it merely because a server response contains additional cookies.
const retainedCookieNames = new Set(['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid',
  'buvid3', 'buvid4', 'buvid_fp', 'buvid_fp_plain', 'b_nut', 'b_lsid', '_uuid', 'bili_ticket', 'bili_ticket_expires']);
const requiredAuthentication = ['SESSDATA', 'bili_jct', 'DedeUserID'] as const;

export function normalizeCookie(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 16384 || /[\x00-\x1f\x7f]/.test(value)) throw new BiliError('invalid_input');
  const input = value.trim().replace(/^Cookie:\s*/i, '');
  const cookies = new Map<string, string>();
  for (const part of input.split(';')) {
    const piece = part.trim();
    if (!piece) continue;
    const match = /^([A-Za-z0-9_-]+)=([^\s;,"\\]*)$/.exec(piece);
    if (!match || match[2]!.length > 8192) throw new BiliError('invalid_input');
    const [, name, content] = match;
    if (!retainedCookieNames.has(name!)) continue;
    if (!content || !/^[\x21-\x7e]+$/.test(content) || cookies.has(name!)) throw new BiliError('invalid_input');
    cookies.set(name!, content);
  }
  if (!cookies.has('SESSDATA') || !/^[A-Fa-f0-9]{32}$/.test(cookies.get('bili_jct') ?? '') ||
      !/^[1-9]\d{0,15}$/.test(cookies.get('DedeUserID') ?? '') || !Number.isSafeInteger(Number(cookies.get('DedeUserID')))) throw new BiliError('invalid_input');
  return [...cookies].map(([key, content]) => `${key}=${content}`).join('; ');
}
function cookieMap(cookie: string): Map<string, string> {
  return new Map(normalizeCookie(cookie).split('; ').map(pair => { const separator = pair.indexOf('='); return [pair.slice(0, separator), pair.slice(separator + 1)]; }));
}
/** Device restoration cannot substitute authentication material or switch accounts. */
export function sameCookieAuthentication(left: string, right: string): boolean {
  const before = cookieMap(left), after = cookieMap(right);
  return requiredAuthentication.every(name => before.get(name) === after.get(name));
}
export function removedCookieNames(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > retainedCookieNames.size || value.some(name => typeof name !== 'string' || !retainedCookieNames.has(name))
    || new Set(value).size !== value.length) throw new BiliError('malformed_response');
  return [...value];
}
/** A selected-cookie response merge, not a general browser cookie jar. New login passes no previous cookie. */
export function mergeResponseCookies(headers: unknown, previousCookie?: string, now = Date.now()): { cookie: string; removedCookieNames: string[] } {
  const lines = Array.isArray(headers) ? headers : typeof headers === 'string' ? [headers] : [];
  if (!lines.length || lines.length > 64 || !Number.isFinite(now)) throw new BiliError('malformed_response');
  const updates = new Map<string, string | undefined>();
  let size = 0;
  for (const line of lines) {
    if (typeof line !== 'string' || (size += line.length) > 65536 || /[\x00-\x1f\x7f]/.test(line)) throw new BiliError('malformed_response');
    const [pair, ...attributes] = line.split(';'), selectedName = /^([A-Za-z0-9_-]+)=/.exec(pair!.trim())?.[1];
    if (!selectedName) throw new BiliError('malformed_response');
    if (!retainedCookieNames.has(selectedName)) continue;
    const match = /^([A-Za-z0-9_-]+)=([^\s;,"\\]*)$/.exec(pair!.trim());
    if (!match || match[2]!.length > 8192) throw new BiliError('malformed_response');
    if (/,\s*[A-Za-z0-9_-]+=/.test(line)) throw new BiliError('malformed_response');
    const [, name, value] = match;
    let maxAge: number | undefined, expires: number | undefined;
    for (const attribute of attributes) {
      const separator = attribute.indexOf('=');
      if (separator < 0) continue;
      const key = attribute.slice(0, separator).trim().toLowerCase(), content = attribute.slice(separator + 1).trim();
      if (key === 'max-age' && /^-?\d+$/.test(content)) {
        const parsed = Number(content); if (Number.isFinite(parsed)) maxAge = parsed;
      } else if (key === 'expires') {
        const parsed = Date.parse(content); if (Number.isFinite(parsed)) expires = parsed;
      }
    }
    // HTTP Max-Age takes precedence over Expires; an explicitly empty value also clears the saved field.
    const deleted = !value || (maxAge !== undefined ? maxAge <= 0 : expires !== undefined && expires <= now);
    updates.set(name!, deleted ? undefined : value!);
  }
  // Never report a refresh as successful by silently retaining missing/deleted old authentication fields.
  if (!requiredAuthentication.every(name => updates.get(name))) throw new BiliError('malformed_response');
  const before = previousCookie === undefined ? new Map<string, string>() : cookieMap(previousCookie);
  if (previousCookie !== undefined && updates.get('DedeUserID') !== before.get('DedeUserID')) throw new BiliError('account_changed');
  const merged = new Map(before), removed: string[] = [];
  for (const [name, value] of updates) {
    if (value === undefined) { merged.delete(name); removed.push(name); }
    else merged.set(name, value);
  }
  try { return { cookie: normalizeCookie([...merged].map(([name, value]) => `${name}=${value}`).join('; ')), removedCookieNames: removed }; }
  catch { throw new BiliError('malformed_response'); }
}
