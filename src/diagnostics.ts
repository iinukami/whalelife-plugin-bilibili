/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { randomUUID } from 'node:crypto';
import { BiliError } from './errors.ts';
import { readWbiKeys } from './wbi.ts';
import type { Transport, TransportOptions, TransportResponse } from './transport.ts';

export interface RequestDiagnostic {
  requestId: string;
  endpoint: string;
  host?: 'api.bilibili.com' | 'passport.bilibili.com';
  path?: string;
  method: 'GET' | 'POST' | 'unknown';
  hasSessionCookie: boolean;
  elapsedMs: number;
  stage: 'http' | 'api' | 'transport' | 'response';
  httpStatus?: number;
  apiCode?: number;
  errorCode?: string;
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
  '/x/player/playurl': 'play_url',
  '/x/web-interface/nav': 'account',
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
type RequestContext = Pick<RequestDiagnostic, 'endpoint' | 'host' | 'path' | 'method' | 'hasSessionCookie'> & { json: boolean; searchKeys: boolean };
type Failure = Pick<RequestDiagnostic, 'stage' | 'httpStatus' | 'apiCode' | 'errorCode'>;

function context(input: string, options: TransportOptions): RequestContext {
  let cookie = '';
  for (const [key, value] of Object.entries(options.headers ?? {})) if (key.toLowerCase() === 'cookie') cookie = value;
  const base: RequestContext = { endpoint: 'unknown', json: false, searchKeys: false,
    method: options.method === undefined || options.method === 'GET' ? 'GET' : options.method === 'POST' ? 'POST' : 'unknown',
    hasSessionCookie: typeof cookie === 'string' && /(?:^|;\s*)SESSDATA=[^;\s]+/.test(cookie) };
  let url: URL;
  try { url = new URL(input); } catch { return base; }
  const host = url.hostname, path = url.pathname;
  const routes = host === 'api.bilibili.com' ? apiPaths : host === 'passport.bilibili.com' ? passportPaths : undefined;
  if (routes && Object.hasOwn(routes, path)) return { ...base, endpoint: routes[path],
    host: host as RequestDiagnostic['host'], path, json: true,
    searchKeys: host === 'api.bilibili.com' && path === '/x/web-interface/nav'
      && options.diagnosticPurpose === 'search_keys' && !base.hasSessionCookie };
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
  if (!request.json) return;
  if (!Buffer.isBuffer(response.body)) return { stage: 'response', httpStatus: status, errorCode: 'malformed_response' };
  if (response.body.length > jsonLimit) return { stage: 'response', httpStatus: status, errorCode: 'too_large' };
  let value: unknown;
  try { value = JSON.parse(response.body.toString('utf8')); }
  catch { return { stage: 'response', httpStatus: status, errorCode: 'malformed_response' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { stage: 'response', httpStatus: status, errorCode: 'malformed_response' };
  const code = (value as { code?: unknown }).code;
  if (!Number.isSafeInteger(code)) return { stage: 'response', httpStatus: status, errorCode: 'malformed_response' };
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
      let reported = false;
      const report = (failure: Failure) => {
        if (reported || !request) return;
        reported = true;
        try {
          const { json: _json, searchKeys: _searchKeys, ...fields } = request;
          const elapsedMs = Math.max(0, Math.round(performance.now() - started));
          const event: RequestDiagnostic = { requestId: randomUUID(), ...fields, elapsedMs, ...failure };
          // Do not await logging or let synchronous/asynchronous sink failures enter the business path.
          void Promise.resolve(sink(event)).catch(() => {});
        } catch { /* Diagnostics must not fail or replace the original operation. */ }
      };
      try {
        const response = await transport.request(input, options);
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
