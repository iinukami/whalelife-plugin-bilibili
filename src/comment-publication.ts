/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { BiliError } from './errors.ts';
import type { CommentCheckInput, CommentEvidence, CommentPublication } from './types.ts';
import type { TransportResponse } from './transport.ts';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BiliError('malformed_response');
  return value as Record<string, unknown>;
}
function id(value: unknown, zero = false): string {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== 'string' || !(zero ? /^(?:0|[1-9]\d{0,19})$/ : /^[1-9]\d{0,19}$/).test(text)) throw new BiliError('malformed_response');
  return text;
}
function responseId(row: Record<string, unknown>, field: string, zero = false) {
  const preferred = row[field + '_str'];
  if (preferred !== undefined && typeof preferred !== 'string') throw new BiliError('malformed_response');
  const result = id(preferred ?? row[field], zero), raw = row[field];
  if (preferred !== undefined && raw !== undefined && (typeof raw === 'number'
    ? !Number.isInteger(raw) || Number.isSafeInteger(raw) && String(raw) !== result : typeof raw !== 'string' || raw !== result))
    throw new BiliError('malformed_response');
  return result;
}
export function validateCommentCheck(input: CommentCheckInput, platformId: string) {
  if (!input || !['comment', 'reply'].includes(input.action) || !Number.isSafeInteger(input.aid) || input.aid < 1
    || input.bvid !== undefined && !/^BV[A-Za-z0-9]{10}$/.test(input.bvid)) throw new BiliError('invalid_input');
  try { id(platformId); if (input.action === 'reply') { id(input.root); id(input.parent); } }
  catch { throw new BiliError('invalid_input'); }
}
export function submissionMetadata(input: CommentCheckInput, platformId: string, value: unknown): Pick<CommentPublication, 'postState' | 'postInvisible'> {
  try {
    const row = record(value);
    if (responseId(row, 'rpid') !== platformId || row.type !== undefined && row.type !== 1
      || (row.oid !== undefined || row.oid_str !== undefined) && responseId(row, 'oid') !== String(input.aid)) return {};
    const postState = typeof row.state === 'number' && Number.isSafeInteger(row.state) && row.state >= 0 ? row.state : undefined;
    return { ...(postState !== undefined ? { postState } : {}), ...(typeof row.invisible === 'boolean' ? { postInvisible: row.invisible } : {}) };
  } catch { return {}; }
}
function observe(response: TransportResponse, input: CommentCheckInput, platformId: string, audience: CommentEvidence['audience']): CommentEvidence {
  const base = { audience, ...(Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? { httpStatus: response.status } : {}) };
  if (response.status < 200 || response.status >= 300) return { ...base, outcome: 'http_error' };
  let json: Record<string, unknown>;
  try { json = record(JSON.parse(response.body.toString('utf8'))); }
  catch { return { ...base, outcome: 'invalid_response' }; }
  if (!Number.isSafeInteger(json.code)) return { ...base, outcome: 'invalid_response' };
  const coded = { ...base, apiCode: json.code as number };
  if (json.code === 12006) return { ...coded, outcome: 'not_found' };
  if (json.code !== 0) return { ...coded, outcome: 'api_error' };
  let row: Record<string, unknown>;
  try {
    const data = record(json.data);
    if (data.root === null) return { ...coded, outcome: 'not_found' };
    row = record(data.root);
    if (row.type !== 1 || responseId(row, 'oid') !== String(input.aid) || responseId(row, 'rpid') !== platformId
      || responseId(row, 'root', true) !== (input.action === 'reply' ? input.root : '0')
      || responseId(row, 'parent', true) !== (input.action === 'reply' ? input.parent : '0')) return { ...coded, outcome: 'identity_mismatch' };
    if (typeof row.state !== 'number' || !Number.isSafeInteger(row.state) || row.state < 0 || typeof row.invisible !== 'boolean')
      return { ...coded, outcome: 'invalid_response' };
  } catch { return { ...coded, outcome: 'invalid_response' }; }
  return { ...coded, state: row.state as number, outcome: row.state === 0 && !row.invisible ? audience === 'anonymous' ? 'public' : 'account_visible' : 'hidden' };
}
export function publicationSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); };
    const aborted = () => { cleanup(); reject(new BiliError('cancelled')); };
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) { aborted(); return; }
    timer = setTimeout(() => { cleanup(); resolve(); }, ms);
  });
}
export interface PublicationDependencies {
  signal: AbortSignal;
  guard(): void;
  read(audience: CommentEvidence['audience'], timeoutMs: number, signal: AbortSignal): Promise<TransportResponse>;
  report?(response: TransportResponse, evidence: CommentEvidence): void;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}
/** At most two anonymous reads and one account read. Never writes or retries a submission. */
export async function readCommentPublication(input: CommentCheckInput, platformId: string, dependencies: PublicationDependencies): Promise<CommentPublication> {
  validateCommentCheck(input, platformId);
  const now = dependencies.now ?? Date.now, sleep = dependencies.sleep ?? publicationSleep;
  const deadline = now() + 30000, budget = new AbortController();
  const signal = AbortSignal.any([dependencies.signal, budget.signal]);
  const timer = setTimeout(() => budget.abort(), 30000);
  const evidence: CommentEvidence[] = [];
  const result: CommentPublication = { visibility: 'unknown', checkedAnonymously: false, notification: 'unverified', attempts: 0, evidence };
  const check = () => { dependencies.guard(); if (signal.aborted || now() >= deadline) throw new BiliError(budget.signal.aborted || now() >= deadline ? 'timeout' : 'cancelled'); };
  const one = async (audience: CommentEvidence['audience']): Promise<CommentEvidence> => {
    let response: TransportResponse | undefined, item: CommentEvidence;
    try {
      check();
      response = await dependencies.read(audience, Math.max(1, Math.min(5000, deadline - now())), signal);
      check(); item = observe(response, input, platformId, audience);
    } catch (error) {
      const code = error instanceof BiliError ? error.code : 'network_error';
      const safe = ['timeout', 'network_error', 'access_blocked', 'login_required', 'stopped', 'cancelled', 'account_changed', 'malformed_response', 'traffic_paused', 'traffic_cooldown', 'traffic_budget', 'traffic_verification', 'persistence_error', 'config_invalid', 'config_conflict', 'unsafe_url'].includes(code)
        ? code as CommentEvidence['errorCode'] : 'network_error';
      item = { audience, outcome: code === 'account_changed' ? 'account_changed' : ['stopped', 'cancelled'].includes(code) ? 'cancelled' : 'transport_error', errorCode: safe };
    }
    evidence.push(item);
    if (response) try { dependencies.report?.(response, item); } catch { /* Diagnostics cannot affect acceptance. */ }
    if (audience === 'anonymous' && ['public', 'hidden', 'not_found'].includes(item.outcome)) result.checkedAnonymously = true;
    if (item.state !== undefined) result.state = item.state;
    return item;
  };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) { check(); await sleep(Math.min(7500, Math.max(0, deadline - now())), signal); check(); }
      result.attempts = attempt + 1;
      const item = await one('anonymous');
      if (item.outcome === 'public') { result.visibility = 'public'; return result; }
      if (item.outcome === 'hidden') result.visibility = 'not_public';
      if (!['not_found', 'hidden'].includes(item.outcome)) return result;
      if (attempt === 1 && item.outcome === 'not_found') {
        const own = await one('account');
        if (own.outcome === 'hidden') result.visibility = 'not_public';
      }
    }
  } catch { /* Cancellation or a failed bounded wait never invalidates an accepted submission. */ }
  finally { clearTimeout(timer); result.checkedAt = new Date(now()).toISOString(); }
  return result;
}
