/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { randomUUID } from 'node:crypto';
import { BiliError } from './errors.ts';
import { readWbiKeys } from './wbi.ts';
import type { Transport, TransportOptions, TransportResponse } from './transport.ts';

export interface RequestDiagnostic extends Partial<SubtitleDetails> {
  requestId: string;
  endpoint: string;
  host?: 'api.bilibili.com' | 'passport.bilibili.com';
  path?: string;
  method: 'GET' | 'POST' | 'unknown';
  hasSessionCookie: boolean;
  elapsedMs: number;
  stage: 'http' | 'api' | 'transport' | 'response' | 'parse';
  phase?: 'subtitle_prepare' | 'subtitle_tracks' | 'subtitle_body';
  responseBytes?: number;
  httpStatus?: number;
  apiCode?: number;
  errorCode?: string;
}
export type DiagnosticValueType = 'undefined' | 'null' | 'array' | 'object' | 'string' | 'boolean' | 'number' | 'non_finite_number' | 'unsafe_integer' | 'other';
export interface SubtitleIssue {
  reason: 'invalid_json' | 'invalid_envelope' | 'invalid_data' | 'invalid_track_list' | 'invalid_track'
    | 'invalid_track_url' | 'invalid_track_id' | 'track_rejected' | 'invalid_cue_list' | 'invalid_cue'
    | 'invalid_cue_time' | 'invalid_cue_content' | 'cue_limit' | 'text_limit' | 'invalid_response_url' | 'identity_mismatch' | 'invalid_device_cookie' | 'invalid_wbi_keys';
  field: '$' | 'code' | 'data' | 'data.bvid' | 'data.cid' | 'data.aid' | 'data.buvid' | 'data.wbi_img' | 'data.subtitle' | 'data.subtitle.subtitles' | 'track' | 'track.subtitle_url'
    | 'track.id' | 'track.id_str' | 'body' | 'cue' | 'cue.from' | 'cue.to' | 'cue.content' | 'response.url';
  actualType?: DiagnosticValueType;
  urlProblem?: 'non_string' | 'empty' | 'invalid_url' | 'non_https' | 'credentials' | 'custom_port' | 'fragment' | 'whitespace' | 'too_long' | 'non_public_host';
  itemIndex?: number;
  constraint?: 'finite_number' | 'non_negative' | 'ordered' | 'string' | 'identifier' | 'trusted_url' | 'object' | 'array' | 'max_cues' | 'max_text';
}
export interface SubtitleDetails extends SubtitleIssue {
  itemCount?: number;
  examinedCount?: number;
  acceptedCount?: number;
  rejectedCount?: number;
  limit?: number;
  issues?: SubtitleIssue[];
}
export function diagnosticType(value: unknown): DiagnosticValueType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return !Number.isFinite(value) ? 'non_finite_number'
    : Number.isInteger(value) && !Number.isSafeInteger(value) ? 'unsafe_integer' : 'number';
  return ['undefined', 'object', 'string', 'boolean'].includes(typeof value) ? typeof value as DiagnosticValueType : 'other';
}
// Weak keys retain neither responses nor signed URLs after the caller releases them.
const responseReports = new WeakMap<TransportResponse, (failure: Failure) => void>();
export function reportSubtitleResponse(response: TransportResponse, details: SubtitleDetails, errorCode = 'malformed_response') {
  try { responseReports.get(response)?.({ stage: 'parse', errorCode, ...details }); } catch { /* Observation cannot affect parsing. */ }
}
export type DiagnosticSink = (event: RequestDiagnostic) => void | Promise<void>;

// Only these exact public routes can contribute a host/path to a diagnostic.
const apiPaths: Readonly<Record<string, string>> = Object.freeze({
  '/x/web-interface/wbi/index/top/feed/rcmd': 'recommended',
  '/x/polymer/web-dynamic/v1/feed/all': 'following',
  '/x/web-interface/search/type': 'search',
  '/x/web-interface/wbi/search/type': 'search',
  '/x/web-frontend/getbuvid': 'search_cookie',
  '/x/web-interface/view': 'video',
  '/x/v2/reply': 'comments',
  '/x/v2/reply/detail': 'comment_detail',
  '/x/v2/reply/reply': 'comment_thread',
  '/x/msgfeed/reply': 'reply_notifications',
  '/x/msgfeed/like': 'like_notifications',
  '/x/player/v2': 'subtitle_tracks',
  '/x/player/wbi/v2': 'subtitle_tracks',
  '/x/player/playurl': 'play_url',
  '/x/web-interface/nav': 'account',
  '/x/web-interface/card': 'owner_profile',
  '/x/v3/fav/folder/created/list-all': 'favorite_folders',
  '/x/web-interface/archive/like': 'like',
  '/x/v3/fav/resource/deal': 'favorite',
  '/x/relation/modify': 'follow',
  '/x/v2/reply/add': 'comment_write',
  '/x/web-interface/history/cursor': 'history_read',
  '/x/v2/history/report': 'history_write',
});
const passportPaths: Readonly<Record<string, string>> = Object.freeze({
  '/x/passport-login/web/qrcode/generate': 'login_generate',
  '/x/passport-login/web/qrcode/poll': 'login_poll',
  '/x/passport-login/web/cookie/info': 'refresh_check',
  '/x/passport-login/web/cookie/refresh': 'refresh_write',
  '/x/passport-login/web/confirm/refresh': 'refresh_confirm',
});
const transportCodes = new Set(['invalid_input', 'network_error', 'timeout', 'cancelled', 'stopped', 'access_blocked',
  'login_required', 'platform_error', 'unsupported_media', 'too_large', 'unsafe_url', 'malformed_response', 'uncertain']);
const jsonLimit = 2 * 1024 * 1024;
const ordinaryPollCodes = new Set([0, 86101, 86090, 86038]);
type RequestContext = Pick<RequestDiagnostic, 'endpoint' | 'host' | 'path' | 'method' | 'hasSessionCookie' | 'phase'> & { json: boolean; searchKeys: boolean };
type Failure = Pick<RequestDiagnostic, 'stage' | 'httpStatus' | 'apiCode' | 'errorCode'> & Partial<SubtitleDetails>;

function context(input: string, options: TransportOptions): RequestContext {
  let cookie = '';
  for (const [key, value] of Object.entries(options.headers ?? {})) if (key.toLowerCase() === 'cookie') cookie = value;
  const base: RequestContext = { endpoint: 'unknown', json: false, searchKeys: false,
    method: options.method === undefined || options.method === 'GET' ? 'GET' : options.method === 'POST' ? 'POST' : 'unknown',
    hasSessionCookie: typeof cookie === 'string' && /(?:^|;\s*)SESSDATA=[^;\s]+/.test(cookie) };
  if (options.diagnosticPurpose === 'subtitle_body') return { ...base, endpoint: 'subtitle_body', phase: 'subtitle_body' };
  let url: URL;
  try { url = new URL(input); } catch { return base; }
  const host = url.hostname, path = url.pathname;
  const routes = host === 'api.bilibili.com' ? apiPaths : host === 'passport.bilibili.com' ? passportPaths : undefined;
  if (routes && Object.hasOwn(routes, path)) return { ...base, endpoint: routes[path],
    host: host as RequestDiagnostic['host'], path, json: true,
    ...(host === 'api.bilibili.com' && ['/x/player/v2', '/x/player/wbi/v2'].includes(path) ? { phase: 'subtitle_tracks' as const } : {}),
    ...(host === 'api.bilibili.com' && path === '/x/web-frontend/getbuvid' && options.diagnosticPurpose === 'subtitle_cookie'
      ? { endpoint: 'subtitle_cookie', phase: 'subtitle_prepare' as const } : {}),
    ...(host === 'api.bilibili.com' && path === '/x/web-interface/nav' && options.diagnosticPurpose === 'subtitle_keys'
      ? { endpoint: 'subtitle_keys', phase: 'subtitle_prepare' as const } : {}),
    searchKeys: host === 'api.bilibili.com' && path === '/x/web-interface/nav'
      && ['search_keys', 'subtitle_keys'].includes(options.diagnosticPurpose ?? '') && !base.hasSessionCookie };
  if (host === 'api.bilibili.com' && path === '/x/v2/dm/web/seg.so') return { ...base, endpoint: 'danmaku' };
  if (host === 'www.bilibili.com' && path.startsWith('/correspond/1/')) return { ...base, endpoint: 'refresh_csrf' };
  if (host === 'b23.tv') return { ...base, endpoint: 'short_link' };
  if (['bilivideo.com', 'bilivideo.cn', 'bilivideo.net'].some(domain => host === domain || host.endsWith('.' + domain)))
    return { ...base, endpoint: 'media_cdn' };
  if (host === 'hdslb.com' || host.endsWith('.hdslb.com')) return { ...base, endpoint: 'asset_cdn' };
  return base;
}

function observe(response: TransportResponse, request: RequestContext): Failure | undefined {
  const status = response.status;
  if (!Number.isInteger(status) || status < 100 || status > 599) return { stage: 'response', errorCode: 'malformed_response' };
  if (status < 200 || status >= 300) return { stage: 'http', httpStatus: status };
  if (!request.json && request.phase !== 'subtitle_body') return;
  const issue = (reason: SubtitleIssue['reason'], field: SubtitleIssue['field'], value?: unknown): Partial<SubtitleDetails> =>
    request.phase ? { reason, field, actualType: diagnosticType(value) } : {};
  if (!Buffer.isBuffer(response.body)) return { stage: 'response', httpStatus: status, errorCode: 'malformed_response' };
  if (response.body.length > jsonLimit) return { stage: 'response', httpStatus: status, errorCode: 'too_large', ...(request.phase ? { reason: 'invalid_envelope' as const, field: '$' as const, limit: jsonLimit } : {}) };
  let value: unknown;
  try { value = JSON.parse(response.body.toString('utf8')); }
  catch { return { stage: 'response', httpStatus: status, errorCode: 'malformed_response', ...issue('invalid_json', '$') }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { stage: 'response', httpStatus: status, errorCode: 'malformed_response', ...issue('invalid_envelope', '$', value) };
  if (request.phase === 'subtitle_body') return;
  const code = (value as { code?: unknown }).code;
  if (!Number.isSafeInteger(code)) return { stage: 'response', httpStatus: status, errorCode: 'malformed_response', ...issue('invalid_envelope', 'code', code) };
  if (code !== 0) {
    if (code === -101 && request.searchKeys) {
      try {
        const data = (value as { data?: { isLogin?: unknown; wbi_img?: unknown } }).data;
        if (data?.isLogin === false) { readWbiKeys(data.wbi_img); return; }
      } catch { /* An invalid anonymous envelope remains a failure diagnostic. */ }
    }
    return { stage: 'api', httpStatus: status, apiCode: code as number };
  }
  if (request.endpoint === 'search') {
    const data = (value as { data?: unknown }).data;
    if (data && typeof data === 'object' && !Array.isArray(data) && Object.hasOwn(data, 'v_voucher'))
      return { stage: 'response', httpStatus: status, errorCode: 'access_blocked' };
  }
  if (request.endpoint === 'login_poll') {
    const data = (value as { data?: unknown }).data;
    const pollCode = data && typeof data === 'object' && !Array.isArray(data) ? (data as { code?: unknown }).code : undefined;
    if (!Number.isSafeInteger(pollCode)) return { stage: 'response', httpStatus: status, errorCode: 'malformed_response' };
    if (!ordinaryPollCodes.has(pollCode as number)) return { stage: 'api', httpStatus: status, apiCode: pollCode as number };
  }
}

/** Observe failures without changing requests, response/error identity, or cancellation. */
export function withDiagnostics(transport: Transport, sink?: DiagnosticSink): Transport {
  if (!sink) return transport;
  return {
    async request(input, options) {
      let request: RequestContext | undefined, started = 0;
      try { started = performance.now(); request = context(input, options); } catch { /* Observation is optional. */ }
      let reported = false, httpStatus: number | undefined, responseBytes: number | undefined;
      const report = (failure: Failure) => {
        if (reported || !request) return;
        reported = true;
        try {
          const { json: _json, searchKeys: _searchKeys, ...fields } = request;
          const elapsedMs = Math.max(0, Math.round(performance.now() - started));
          const event: RequestDiagnostic = { requestId: randomUUID(), ...fields, elapsedMs,
            ...(httpStatus !== undefined ? { httpStatus } : {}),
            ...(request.phase && responseBytes !== undefined ? { responseBytes } : {}), ...failure };
          // Do not await logging or let synchronous/asynchronous sink failures enter the business path.
          void Promise.resolve(sink(event)).catch(() => {});
        } catch { /* Diagnostics must not fail or replace the original operation. */ }
      };
      try {
        const response = await transport.request(input, options);
        try {
          if (request) {
            if (Number.isInteger(response.status) && response.status >= 100 && response.status <= 599) httpStatus = response.status;
            if (request.phase && response.status >= 200 && response.status < 300 && Buffer.isBuffer(response.body)) responseBytes = response.body.length;
            responseReports.set(response, report);
          }
        } catch { /* Keep the original response. */ }
        try { if (request) { const failure = observe(response, request); if (failure) report(failure); } } catch { /* Keep the original response. */ }
        return response;
      } catch (error) {
        try { report({ stage: 'transport', errorCode: error instanceof BiliError && transportCodes.has(error.code) ? error.code : 'network_error' }); } catch { /* Keep the original error. */ }
        throw error;
      }
    },
    dispose() { return transport.dispose(); },
  };
}
