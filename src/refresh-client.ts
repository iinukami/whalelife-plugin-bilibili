/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { constants, publicEncrypt } from 'node:crypto';
import { mergeResponseCookies, normalizeCookie } from './cookies.ts';
import { BiliError } from './errors.ts';
import { safeUrl, TransportError } from './transport.ts';
import type { Transport, TransportResponse } from './transport.ts';
import type { CallOptions } from './types.ts';
const PASSPORT = 'https://passport.bilibili.com', PREFIX = '/x/passport-login/web/';
// Public protocol key used by the site's correspond endpoint; not a credential.
const CORRESPOND_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDLgd2OAkcGVtoE3ThUREbio0Eg
Uc/prcajMKXvkCKFCWhJYJcLkcM2DKKcSeFpD/j6Boy538YXnR6VhcuUJOhH2x71
nzPjfdTcqMz7djHum0qSZA0AyCBDABUqCrfNgCiJ00Ra7GmRj+YCK1NJEuewlb40
JNrRuoEUXpabUzGB8QIDAQAB
-----END PUBLIC KEY-----`;
export function refreshToken(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,512}$/.test(value)) throw new BiliError('invalid_input'); return value;
}
function call(options: CallOptions) {
  if (options.signal?.aborted) throw new BiliError('cancelled');
  options.assertCurrent?.();
  if (!options.cookie) throw new BiliError('login_required');
  const cookie = normalizeCookie(options.cookie);
  return { signal: options.signal, timeoutMs: options.timeoutMs ?? 20000, maxBytes: 1024 * 1024,
    beforeDispatch: () => { if (options.signal?.aborted) throw new BiliError('cancelled'); options.assertCurrent?.(); },
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/', Cookie: cookie } };
}
const csrf = (cookie: string) => /(?:^|; )bili_jct=([a-fA-F0-9]{32})(?:;|$)/.exec(cookie)![1]!;
function json(response: TransportResponse, url: string) {
  if (safeUrl(response.url).href !== url) throw new BiliError('unsafe_url');
  if ([401, 403, 412, 429, 503].includes(response.status)) throw new BiliError('access_blocked');
  if (response.status !== 200) throw new BiliError('platform_error');
  let value: any; try { value = JSON.parse(response.body.toString('utf8')); } catch { throw new BiliError('malformed_response'); }
  if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.code)) throw new BiliError('malformed_response');
  return value;
}
function success(value: any) {
  if (value.code === 0) return;
  if ([-101, -111].includes(value.code)) throw new BiliError('login_required');
  if ([-352, -412, -509, -799].includes(value.code)) throw new BiliError('access_blocked');
  throw new BiliError('platform_error');
}
export async function checkRefresh(transport: Transport, options: CallOptions): Promise<{ refresh: boolean; timestamp: number }> {
  const request = call(options), url = PASSPORT + PREFIX + 'cookie/info?csrf=' + csrf(request.headers.Cookie);
  const value = json(await transport.request(url, request), url); success(value);
  if (typeof value.data?.refresh !== 'boolean' || !Number.isSafeInteger(value.data.timestamp) || value.data.timestamp <= 0) throw new BiliError('malformed_response');
  return { refresh: value.data.refresh, timestamp: value.data.timestamp };
}
export async function getRefreshCsrf(transport: Transport, timestamp: number, options: CallOptions): Promise<string> {
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new BiliError('invalid_input');
  const request = call(options), encrypted = publicEncrypt({ key: CORRESPOND_KEY, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from('refresh_' + timestamp)).toString('hex');
  const url = 'https://www.bilibili.com/correspond/1/' + encrypted;
  const response = await transport.request(url, { ...request, headers: { ...request.headers, Accept: 'text/html' } });
  if (safeUrl(response.url).href !== url) throw new BiliError('unsafe_url');
  if ([401, 403, 412, 429, 503].includes(response.status)) throw new BiliError('access_blocked');
  if (response.status !== 200) throw new BiliError('platform_error');
  const found = /<div\s+id=["']1-name["']\s*>([A-Za-z0-9_-]{16,512})<\/div>/.exec(response.body.toString('utf8'));
  if (!found) throw new BiliError('malformed_response'); return found[1]!;
}
async function post(transport: Transport, path: 'cookie/refresh' | 'confirm/refresh', fields: Record<string, string>, options: CallOptions) {
  const request = call(options), url = PASSPORT + PREFIX + path;
  let response: TransportResponse;
  try { response = await transport.request(url, { ...request, method: 'POST', body: new URLSearchParams({ csrf: csrf(request.headers.Cookie), ...fields }).toString(),
    headers: { ...request.headers, 'Content-Type': 'application/x-www-form-urlencoded' } }); }
  catch (error) { if (error instanceof TransportError && !error.submitted) throw error; throw new BiliError('uncertain'); }
  let value: any; try { value = json(response, url); } catch { throw new BiliError('uncertain'); }
  success(value); return { response, value, requestCookie: request.headers.Cookie };
}
export async function renewCookies(transport: Transport, token: string, refreshCsrf: string, options: CallOptions): Promise<{ cookie: string; refreshToken: string; removedCookieNames?: string[] }> {
  const { response, value, requestCookie } = await post(transport, 'cookie/refresh', { refresh_token: refreshToken(token), refresh_csrf: refreshToken(refreshCsrf), source: 'main_web' }, options);
  try {
    const merged = mergeResponseCookies(response.headers['set-cookie'], requestCookie);
    return { cookie: merged.cookie, refreshToken: refreshToken(value.data?.refresh_token),
      ...(merged.removedCookieNames.length ? { removedCookieNames: merged.removedCookieNames } : {}) };
  } catch { throw new BiliError('uncertain'); }
}
export async function confirmRefresh(transport: Transport, token: string, options: CallOptions): Promise<void> {
  await post(transport, 'confirm/refresh', { refresh_token: refreshToken(token) }, options);
}
