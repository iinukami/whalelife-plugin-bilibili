/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { normalizeCookie } from './auth.ts';
import { BiliError } from './errors.ts';
import { safeUrl, TransportError } from './transport.ts';
import type { Transport, TransportResponse } from './transport.ts';
import type { CallOptions } from './types.ts';

export interface HistoryTarget { aid: number; cid: number }
export interface HistoryPositionInput extends HistoryTarget { positionSeconds: number }
export type HistoryProgress = { found: false } | { found: true; progressSeconds: number | null; completed: boolean; viewedAt?: number };
const API = 'https://api.bilibili.com';
const READ_PATH = '/x/web-interface/history/cursor';
const REPORT_PATH = '/x/v2/history/report';

function inputInteger(value: unknown, minimum: number) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new BiliError('invalid_input');
  return value;
}
function target(input: HistoryTarget) {
  if (!input || typeof input !== 'object') throw new BiliError('invalid_input');
  inputInteger(input.aid, 1); inputInteger(input.cid, 1);
}
function options(input: CallOptions) {
  if (input.signal?.aborted) throw new BiliError('cancelled');
  const timeoutMs = inputInteger(input.timeoutMs ?? 20000, 1);
  if (timeoutMs > 240000) throw new BiliError('invalid_input');
  if (!input.cookie) throw new BiliError('login_required');
  const cookie = normalizeCookie(input.cookie);
  return { signal: input.signal, timeoutMs, maxBytes: 1024 * 1024, headers: {
    Accept: 'application/json', 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/', Cookie: cookie,
  } };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BiliError('malformed_response');
  return value as Record<string, unknown>;
}
function responseJson(response: TransportResponse, path: string) {
  const url = safeUrl(response.url);
  if (url.origin !== API || url.pathname !== path) throw new BiliError('unsafe_url');
  if ([401, 403, 412, 429, 503].includes(response.status)) throw new BiliError('access_blocked');
  if (response.status < 200 || response.status > 299) throw new BiliError('platform_error');
  let json: Record<string, unknown>;
  try { json = record(JSON.parse(response.body.toString('utf8'))); }
  catch { throw new BiliError('malformed_response'); }
  if (typeof json.code !== 'number' || !Number.isSafeInteger(json.code)) throw new BiliError('malformed_response');
  return json;
}
function checkCode(json: Record<string, unknown>) {
  if (json.code === 0) return;
  if ([-101, -111].includes(json.code as number)) throw new BiliError('login_required');
  if ([-352, -412, -509, -799].includes(json.code as number)) throw new BiliError('access_blocked');
  throw new BiliError('platform_error');
}
function responseId(value: unknown) {
  const parsed = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Reads one recent page. A missing target is not proof that no older history exists. */
export async function readHistoryProgress(transport: Transport, input: HistoryTarget, call: CallOptions): Promise<HistoryProgress> {
  target(input); const request = options(call);
  let response: TransportResponse;
  try { response = await transport.request(API + READ_PATH + '?max=0&view_at=0&business=archive&ps=30', request); }
  catch (error) { if (error instanceof BiliError) throw error; throw new BiliError('network_error'); }
  const json = responseJson(response, READ_PATH); checkCode(json);
  const data = record(json.data);
  if (!Array.isArray(data.list) || data.list.length > 100) throw new BiliError('malformed_response');
  for (const raw of data.list) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>, history = item.history;
    if (!history || typeof history !== 'object' || Array.isArray(history)) continue;
    const entry = history as Record<string, unknown>;
    if (entry.business !== 'archive' || responseId(entry.oid) !== input.aid || responseId(entry.cid) !== input.cid) continue;
    if (typeof item.progress !== 'number' || !Number.isSafeInteger(item.progress) || item.progress < -1) throw new BiliError('malformed_response');
    const viewedAt = typeof item.view_at === 'number' && Number.isSafeInteger(item.view_at) && item.view_at >= 0 ? item.view_at : undefined;
    return { found: true, progressSeconds: item.progress === -1 ? null : item.progress, completed: item.progress === -1,
      ...(viewedAt !== undefined ? { viewedAt } : {}) };
  }
  return { found: false };
}

/** Reports a checked position, never elapsed watching time or completion. The caller verifies actual coverage and duration. */
export async function reportHistoryPosition(transport: Transport, input: HistoryPositionInput, call: CallOptions): Promise<{ state: 'accepted' }> {
  target(input); inputInteger(input.positionSeconds, 0); const request = options(call);
  const csrf = /(?:^|; )bili_jct=([a-fA-F0-9]{32})(?:;|$)/.exec(request.headers.Cookie)?.[1];
  if (!csrf) throw new BiliError('login_required');
  const body = new URLSearchParams({ aid: String(input.aid), cid: String(input.cid), progress: String(input.positionSeconds), csrf }).toString();
  let response: TransportResponse;
  try { response = await transport.request(API + REPORT_PATH, { ...request, method: 'POST', body,
    headers: { ...request.headers, 'Content-Type': 'application/x-www-form-urlencoded' } }); }
  catch (error) {
    if (error instanceof TransportError && !error.submitted) throw error;
    throw new BiliError('uncertain');
  }
  let json: Record<string, unknown>;
  try { json = responseJson(response, REPORT_PATH); } catch { throw new BiliError('uncertain'); }
  checkCode(json);
  return { state: 'accepted' };
}
