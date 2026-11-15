/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { BiliError } from './errors.ts';
import { validateOwnerUid, validateOwnerProfile } from './owner.ts';
import { validateLoginUrl } from './login-url.ts';
import { readHistoryProgress, reportHistoryPosition } from './history-client.ts';
import type { HistoryTarget, HistoryPositionInput } from './history-client.ts';
import { readDanmaku } from './danmaku-client.ts';
import type { DanmakuInput } from './danmaku-client.ts';
import { checkRefresh, getRefreshCsrf, renewCookies, confirmRefresh, refreshToken } from './refresh-client.ts';
import { createTransport, safeUrl, TransportError } from './transport.ts';
import { withDiagnostics } from './diagnostics.ts';
import { readWbiKeys, signWbi, type WbiKeys } from './wbi.ts';
import type { DiagnosticSink } from './diagnostics.ts';
import type { Transport, TransportResponse } from './transport.ts';
import type { BiliClientContract, CallOptions, VideoItem, VideoDetails, VideoList, CommentList,
  SubtitleTrack, SubtitleCue, Media, LoginPoll, InteractionInput, InteractionResult, CommentPublication, NotificationSource, NotificationCursor, NotificationItem, NotificationList, ThreadComment, CommentThread } from './types.ts';

const API = 'https://api.bilibili.com';
const PASSPORT = 'https://passport.bilibili.com';
const BV = /^BV[A-Za-z0-9]{10}$/;
const AUTH_COOKIES = new Set(['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5']);
function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BiliError('malformed_response'); return value as Record<string, any>;
}
function integer(value: unknown, minimum = 1): number {
  const num = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof num !== 'number' || !Number.isSafeInteger(num) || num < minimum) throw new BiliError('invalid_input'); return num;
}
function identifier(value: unknown, zero = false): string {
  const str = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof str !== 'string' || !/^\d{1,20}$/.test(str) || !zero && /^0+$/.test(str)) throw new BiliError('invalid_input'); return str;
}
function plain(value: unknown, max = 2000): string {
  if (typeof value !== 'string') return '';
  return value.replace(/<[^>]{0,500}>/g, '').replace(/&(?:amp|lt|gt|quot|apos|#39|#x[\da-f]+|#\d+);/gi, token => {
    const named: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'" };
    if (named[token.toLowerCase()]) return named[token.toLowerCase()];
    const n = parseInt(token.slice(token[2]?.toLowerCase() === 'x' ? 3 : 2, -1), token[2]?.toLowerCase() === 'x' ? 16 : 10);
    return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  }).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, max);
}
function duration(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (typeof value === 'string' && /^\d{1,4}(?::\d{1,2}){1,2}$/.test(value)) return value.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
  return 0;
}
function pageNumber(value: unknown) { const n = integer(value); if (n > 1000) throw new BiliError('invalid_input'); return n; }
function bvid(value: unknown) { if (typeof value !== 'string' || !BV.test(value)) throw new BiliError('invalid_input'); return value; }
function mediaUrl(value: unknown) {
  if (typeof value !== 'string') throw new BiliError('malformed_response');
  return safeUrl(value.startsWith('//') ? `https:${value}` : value.startsWith('http://') ? `https://${value.slice(7)}` : value).href;
}
function playableUrl(part: Record<string, any>): string {
  try { return mediaUrl(part.url); } catch (primaryError) {
    // Select a provider-supplied candidate before downloading; never retry a failed request.
    for (const candidate of Array.isArray(part.backup_url) ? part.backup_url.slice(0, 8) : []) {
      try { return mediaUrl(candidate); } catch { /* Keep the same URL safety rules for backups. */ }
    }
    throw primaryError;
  }
}
function notificationNumber(value: unknown, minimum = 0) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new BiliError('malformed_response');
  return value;
}
function notificationText(value: unknown, max = 4000) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new BiliError('malformed_response');
  return plain(value, max);
}
function notificationItems(value: unknown): unknown[] {
  if (value === null) return [];
  if (!Array.isArray(value)) throw new BiliError('malformed_response');
  if (value.length > 100) throw new BiliError('too_large');
  return value;
}
function notificationLocation(value: unknown, type: string): { uri?: string; videoTarget?: string } {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value !== 'string') throw new BiliError('malformed_response');
  // Links are display data only. Drop tracking/fragment data and never infer an aid from a message or comment id.
  try {
    if (value.length > 4096 || /[\x00-\x20\x7f]/.test(value)) return {};
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443'
      || !(url.hostname === 'bilibili.com' || url.hostname.endsWith('.bilibili.com') || url.hostname === 'b23.tv')) return {};
    url.search = ''; url.hash = ''; safeUrl(url.href);
    const match = ['www.bilibili.com', 'm.bilibili.com', 'bilibili.com'].includes(url.hostname)
      && ['video', 'reply', 'danmu'].includes(type) ? /^\/video\/(BV[A-Za-z0-9]{10}|av[1-9]\d{0,15})\/?$/.exec(url.pathname) : null;
    return match ? { uri: `https://www.bilibili.com/video/${match[1]}/`, videoTarget: match[1] } : { uri: url.href };
  } catch { return {}; }
}
function notificationTarget(item: Record<string, any>, actorMid: number, videoTarget?: string): NotificationItem['target'] {
  if (item.type !== 'reply' || item.business_id !== 1 || !videoTarget) return undefined;
  try {
    const aid = integer(item.subject_id), rpid = identifier(item.source_id), rawRoot = identifier(item.root_id, true);
    if (videoTarget.startsWith('av') && integer(videoTarget.slice(2)) !== aid) return undefined;
    return { aid, rpid, root: /^0+$/.test(rawRoot) ? rpid : rawRoot, authorMid: actorMid };
  } catch { return undefined; }
}
function notification(raw: unknown, source: NotificationSource): NotificationItem {
  const value = record(raw), item = record(value.item);
  if (typeof item.type !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.type)) throw new BiliError('malformed_response');
  const people = source === 'replies' ? [record(value.user)] : notificationItems(value.users);
  if (!people.length || people.length > 50) throw new BiliError('malformed_response');
  const actors = people.map(raw => {
    const person = record(raw), name = notificationText(person.nickname, 200);
    if (!name) throw new BiliError('malformed_response');
    return { mid: integer(person.mid), name };
  });
  if (source === 'replies' && typeof item.source_content !== 'string') throw new BiliError('malformed_response');
  const title = notificationText(item.title) || notificationText(item.desc);
  const location = notificationLocation(item.uri, item.type);
  const target = source === 'replies' ? notificationTarget(item, actors[0]!.mid, location.videoTarget) : undefined;
  return { id: identifier(value.id), actors, time: notificationNumber(source === 'replies' ? value.reply_time : value.like_time),
    type: item.type, business: notificationText(item.business, 100), title,
    text: source === 'replies' ? notificationText(item.source_content) : title,
    originalText: notificationText(item.target_reply_content) || notificationText(item.root_reply_content),
    ...location, ...(target ? { target } : {}),
    ...(source === 'likes' ? { likeCount: notificationNumber(value.counts) } : {}) };
}
function checkedCommentId(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value)) throw new BiliError('invalid_input');
  return value;
}
function responseId(raw: Record<string, any>, field: string, zero = false): string {
  const preferred = raw[field + '_str'];
  if (preferred !== undefined && typeof preferred !== 'string') throw new BiliError('malformed_response');
  const id = identifier(preferred ?? raw[field], zero);
  // A decimal string retains identifiers which exceed JS integer precision. Safe numeric copies must still agree.
  if (preferred !== undefined && raw[field] !== undefined) {
    if (typeof raw[field] === 'number' ? !Number.isInteger(raw[field]) || Number.isSafeInteger(raw[field]) && String(raw[field]) !== id
      : typeof raw[field] !== 'string' || raw[field] !== id) throw new BiliError('malformed_response');
  }
  return id;
}
function threadComment(raw: unknown, aid: number): ThreadComment {
  const value = record(raw), member = record(value.member), content = record(value.content);
  if (value.type !== 1 || integer(responseId(value, 'oid')) !== aid) throw new BiliError('malformed_response');
  if (typeof value.invisible !== 'boolean' || typeof value.state !== 'number' || !Number.isSafeInteger(value.state)) throw new BiliError('malformed_response');
  if (value.invisible || value.state !== 0) throw new BiliError('reference_unavailable');
  const rpid = responseId(value, 'rpid'), root = responseId(value, 'root', true), parent = responseId(value, 'parent', true);
  if (root === '0' ? parent !== '0' : parent === '0' || root === rpid || parent === rpid) throw new BiliError('malformed_response');
  const mid = integer(member.mid);
  if (value.mid !== undefined || value.mid_str !== undefined) {
    if (integer(responseId(value, 'mid')) !== mid) throw new BiliError('malformed_response');
  }
  if (typeof member.uname !== 'string' || !member.uname.trim() || typeof content.message !== 'string') throw new BiliError('malformed_response');
  return { aid, rpid, root, parent, text: plain(content.message, 4000), author: { mid, name: plain(member.uname, 200) }, likes: notificationNumber(value.like) };
}
function threadFailure(error: unknown): never {
  if (error instanceof BiliError && ['reference_unavailable', 'too_large'].includes(error.code)) throw error;
  throw new BiliError('malformed_response');
}
function checkedCookie(value: string | undefined) {
  if (!value) return '';
  if (typeof value !== 'string' || value.length > 16384 || /[\x00-\x1f\x7f]/.test(value)) throw new BiliError('invalid_input');
  const parts = value.split(';').map(part => part.trim()).filter(Boolean);
  if (!parts.length || parts.some(part => !/^[A-Za-z0-9_]+=[^;\s]*$/.test(part))) throw new BiliError('invalid_input');
  return parts.join('; ');
}
function cookieValue(cookie: string, name: string) { return cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? ''; }
function parseJson(response: TransportResponse) {
  if ([401, 403, 412, 429, 503].includes(response.status)) throw new BiliError('access_blocked');
  if (response.status < 200 || response.status > 299) throw new BiliError('platform_error');
  try { return record(JSON.parse(response.body.toString('utf8'))); } catch (error) { if (error instanceof BiliError) throw error; throw new BiliError('malformed_response'); }
}
function apiData(response: TransportResponse): Record<string, any> {
  const json = parseJson(response);
  if (json.code === -101 || json.code === -111 || json.code === -400 && json.message === '账号未登录') throw new BiliError('login_required');
  if ([-352, -401, -412, -509, -799].includes(json.code)) throw new BiliError('access_blocked');
  if (json.code !== 0) throw new BiliError(typeof json.code === 'number' ? 'platform_error' : 'malformed_response');
  return json.data == null ? {} : record(json.data);
}

interface SearchPreparation {
  identity: string;
  buvid?: string;
  keys?: { value: WbiKeys; expires: number };
  pending: Promise<void>;
  failure?: { error: unknown };
}

export class BiliClient implements BiliClientContract {
  private transport: Transport;
  private aborter = new AbortController();
  private signal: AbortSignal;
  private knownImages = new Set<string>();
  private knownSubtitles = new Set<string>();
  private loginKeys = new Map<string, number>();
  private searchPreparation?: SearchPreparation;
  constructor(options: { transport?: Transport; signal?: AbortSignal; onDiagnostic?: DiagnosticSink } = {}) {
    this.transport = withDiagnostics(options.transport ?? createTransport(), options.onDiagnostic);
    this.signal = options.signal ? AbortSignal.any([options.signal, this.aborter.signal]) : this.aborter.signal;
  }
  private options(options: CallOptions) {
    if (this.signal.aborted) throw new BiliError('stopped');
    if (options.signal?.aborted) throw new BiliError('cancelled');
    options.assertCurrent?.();
    const timeoutMs = options.timeoutMs ?? 20000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 240000) throw new BiliError('invalid_input');
    return { signal: AbortSignal.any([this.signal, ...(options.signal ? [options.signal] : [])]), timeoutMs };
  }
  historyProgress(target: HistoryTarget, options: CallOptions) {
    return readHistoryProgress(this.transport, target, { ...options, ...this.options(options) });
  }
  reportHistoryPosition(input: HistoryPositionInput, options: CallOptions) {
    return reportHistoryPosition(this.transport, input, { ...options, ...this.options(options) });
  }
  danmaku(input: DanmakuInput, options: CallOptions) { return readDanmaku(this.transport, input, { ...options, ...this.options(options) }); }
  checkRefresh(options: CallOptions) { return checkRefresh(this.transport, { ...options, ...this.options(options) }); }
  refreshCsrf(timestamp: number, options: CallOptions) { return getRefreshCsrf(this.transport, timestamp, { ...options, ...this.options(options) }); }
  renewCookies(token: string, csrf: string, options: CallOptions) { return renewCookies(this.transport, token, csrf, { ...options, ...this.options(options) }); }
  confirmRefresh(token: string, options: CallOptions) { return confirmRefresh(this.transport, token, { ...options, ...this.options(options) }); }
  private async request(path: string, params: Record<string, string> | string, options: CallOptions, passport = false, diagnosticPurpose?: 'search_keys') {
    const url = new URL(path, passport ? PASSPORT : API);
    url.search = typeof params === 'string' ? params : new URLSearchParams(params).toString();
    const cookie = checkedCookie(options.cookie);
    const response = await this.transport.request(url.href, { ...this.options(options), maxBytes: 2 * 1024 * 1024, ...(diagnosticPurpose ? { diagnosticPurpose } : {}),
      headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate, br', 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/', ...(cookie ? { Cookie: cookie } : {}) } });
    if (safeUrl(response.url).hostname !== url.hostname) throw new BiliError('unsafe_url');
    return response;
  }
  private async waitSearchPreparation(pending: Promise<void>, options: CallOptions): Promise<void> {
    const { signal } = this.options(options);
    await new Promise<void>((resolve, reject) => {
      const cancelled = () => { cleanup(); reject(new BiliError(this.signal.aborted ? 'stopped' : 'cancelled')); };
      const cleanup = () => signal.removeEventListener('abort', cancelled);
      signal.addEventListener('abort', cancelled, { once: true });
      if (signal.aborted) { cancelled(); return; }
      pending.then(() => { cleanup(); resolve(); }, error => { cleanup(); reject(error); });
    });
    this.options(options);
  }
  private async prepareSearch(options: CallOptions): Promise<{ cookie: string; keys: WbiKeys }> {
    this.options(options);
    const identity = checkedCookie(options.cookie);
    let state = this.searchPreparation;
    if (!state || state.identity !== identity) {
      state = { identity, pending: Promise.resolve() };
      this.searchPreparation = state;
    }
    // Serialize preparation only. A cancelled waiter never cancels another caller's work.
    const preceding = state.pending, observedFailure = state.failure;
    let attempting = false;
    let release!: () => void;
    const ticket = new Promise<void>(resolve => { release = resolve; });
    state.pending = preceding.then(() => ticket);
    try {
      await this.waitSearchPreparation(preceding, options);
      if (state.failure && state.failure !== observedFailure) throw state.failure.error;
      attempting = true;
      let cookie = identity;
      if (!cookieValue(cookie, 'buvid3')) {
        if (!state.buvid) {
          const issued = apiData(await this.request('/x/web-frontend/getbuvid', {}, options));
          this.options(options);
          if (typeof issued.buvid !== 'string' || !/^[A-Za-z0-9_-]{8,200}$/.test(issued.buvid)) throw new BiliError('malformed_response');
          state.buvid = issued.buvid;
        }
        cookie += (cookie ? '; ' : '') + 'buvid3=' + state.buvid;
      }
      if (!state.keys || state.keys.expires <= Date.now()) {
        const response = await this.request('/x/web-interface/nav', {}, { ...options, cookie }, false, 'search_keys');
        this.options(options);
        const json = parseJson(response);
        // Public search can use the keys in an anonymous nav response without claiming login.
        const data = json.code === -101 && !cookieValue(cookie, 'SESSDATA') ? record(json.data) : apiData(response);
        const value = readWbiKeys(data.wbi_img);
        state.keys = { value, expires: Date.now() + 5 * 60 * 1000 };
      }
      this.options(options);
      state.failure = undefined;
      return { cookie, keys: state.keys.value };
    } catch (error) {
      if (attempting && !(error instanceof BiliError && ['cancelled', 'stopped', 'account_changed'].includes(error.code))) state.failure = { error };
      throw error;
    } finally { release(); }
  }
  private remember(set: Set<string>, value: string) { if (set.size >= 1024) set.delete(set.values().next().value!); set.add(value); }
  private item(raw: unknown, author?: unknown): VideoItem | undefined {
    try {
      const value = record(raw); const id = bvid(value.bvid);
      const owner = author ? record(author) : value.owner ? record(value.owner) : { mid: value.mid, name: value.author };
      const cover = mediaUrl(value.pic ?? value.cover);
      const item = { bvid: id, aid: integer(value.aid ?? value.id), title: plain(value.title, 500),
        owner: { mid: integer(owner.mid), name: plain(owner.name, 200) }, duration: duration(value.duration ?? value.duration_text), cover,
        url: `https://www.bilibili.com/video/${id}/` };
      if (!item.title) return undefined;
      this.remember(this.knownImages, cover); return item;
    } catch { return undefined; }
  }
  async feed(source: 'recommended' | 'following', page: number, cursor: string | undefined, options: CallOptions): Promise<VideoList> {
    pageNumber(page);
    if (source !== 'recommended' && source !== 'following' || cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 200 || /[\x00-\x1f\x7f]/.test(cursor))) throw new BiliError('invalid_input');
    if (source === 'following' && !checkedCookie(options.cookie)) throw new BiliError('login_required');
    const data = apiData(await this.request(source === 'recommended' ? '/x/web-interface/wbi/index/top/feed/rcmd' : '/x/polymer/web-dynamic/v1/feed/all',
      source === 'recommended' ? { ps: '12', fresh_type: page === 1 ? '3' : '4', fresh_idx: String(page), fresh_idx_1h: String(page) }
        : { type: 'video', ...(cursor ? { offset: cursor } : {}) }, options));
    const raw = source === 'recommended' ? data.item : data.items;
    if (!Array.isArray(raw)) throw new BiliError('malformed_response');
    let candidates = 0;
    const items = raw.slice(0, 100).flatMap(value => {
      if (!value || typeof value !== 'object') { candidates++; return []; }
      if (source === 'recommended' && value.goto && value.goto !== 'av') return [];
      if (source === 'following' && !value.modules?.module_dynamic?.major?.archive && value.type !== 'DYNAMIC_TYPE_AV') return [];
      candidates++;
      const item = source === 'recommended' ? this.item(value) : this.item(value.modules?.module_dynamic?.major?.archive, value.modules?.module_author);
      return item ? [item] : [];
    }).slice(0, 20);
    if (candidates > 0 && !items.length) throw new BiliError('malformed_response');
    if (source === 'following') {
      const next = typeof data.offset === 'string' && data.offset.length <= 200 ? data.offset : undefined;
      return { items, hasMore: Boolean(data.has_more) && Boolean(next), ...(next ? { cursor: next } : {}) };
    }
    return { items, hasMore: raw.length > 0, ...(raw.length ? { nextPage: page + 1 } : {}) };
  }
  async search(query: string, page: number, options: CallOptions): Promise<VideoList> {
    pageNumber(page);
    if (typeof query !== 'string' || !query.trim() || query.length > 300 || /[\x00-\x1f\x7f]/.test(query)) throw new BiliError('invalid_input');
    try { encodeURIComponent(query); } catch { throw new BiliError('invalid_input'); }
    const prepared = await this.prepareSearch(options);
    const params = signWbi({ search_type: 'video', keyword: query.trim(), page: String(page), page_size: '12' }, prepared.keys);
    const data = apiData(await this.request('/x/web-interface/wbi/search/type', params, { ...options, cookie: prepared.cookie }));
    this.options(options);
    if (Object.hasOwn(data, 'v_voucher')) throw new BiliError('access_blocked');
    if (!Array.isArray(data.result)) throw new BiliError('malformed_response');
    let candidates = 0;
    const items = data.result.slice(0, 100).flatMap(raw => {
      if (raw?.type && raw.type !== 'video') return [];
      candidates++; const item = this.item(raw); return item ? [item] : [];
    }).slice(0, 20);
    if (candidates > 0 && !items.length) throw new BiliError('malformed_response');
    const hasMore = typeof data.numPages === 'number' ? page < data.numPages : typeof data.next === 'number' && data.next > page;
    return { items, hasMore, ...(hasMore ? { nextPage: page + 1 } : {}) };
  }
  async video(target: string, options: CallOptions): Promise<VideoDetails> {
    if (typeof target !== 'string' || target.length > 1000) throw new BiliError('invalid_input');
    let id = target.trim();
    if (id.startsWith('https://')) {
      let url = safeUrl(id);
      if (url.hostname === 'b23.tv') {
        if (!/^\/[A-Za-z0-9_-]{1,64}\/?$/.test(url.pathname)) throw new BiliError('invalid_input');
        // Resolve only an explicitly supplied official short link. Its page body is never a data source.
        // The transport validates and pins every public HTTPS redirect; account cookies stay at the API.
        const response = await this.transport.request(url.href, { ...this.options(options), maxBytes: 2 * 1024 * 1024,
          headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/' } });
        url = safeUrl(response.url);
      }
      if (!['www.bilibili.com', 'm.bilibili.com', 'bilibili.com'].includes(url.hostname)) throw new BiliError('invalid_input');
      const match = /^\/video\/((?:BV[A-Za-z0-9]{10})|(?:av\d+))\/?$/.exec(url.pathname);
      if (!match) throw new BiliError('invalid_input'); id = match[1];
    }
    const params: Record<string, string> | undefined = BV.test(id) ? { bvid: id } : /^av\d+$/.test(id) ? { aid: String(integer(id.slice(2))) } : undefined;
    if (!params) throw new BiliError('invalid_input');
    const data = apiData(await this.request('/x/web-interface/view', params, options));
    const item = this.item(data);
    if (!item || !Array.isArray(data.pages) || !data.pages.length) throw new BiliError('malformed_response');
    try {
      const parts = data.pages.slice(0, 1000).map((part: any) => ({ cid: integer(part.cid), page: integer(part.page), title: plain(part.part, 500), duration: duration(part.duration) }));
      return { ...item, cid: integer(data.cid), description: plain(data.desc, 10000), parts,
        ...([1, 2, 3].includes(data.copyright) ? { copyright: data.copyright as 1 | 2 | 3 } : {}) };
    } catch { throw new BiliError('malformed_response'); }
  }
  async comments(aid: number, page: number, options: CallOptions): Promise<CommentList> {
    integer(aid); pageNumber(page);
    const data = apiData(await this.request('/x/v2/reply', { type: '1', oid: String(aid), pn: String(page), ps: '20', sort: '2' }, options));
    if (data.replies != null && !Array.isArray(data.replies)) throw new BiliError('malformed_response');
    const items = (data.replies ?? []).slice(0, 20).flatMap((raw: any) => {
      try { return [{ rpid: identifier(raw.rpid_str ?? raw.rpid), root: identifier(raw.root_str ?? raw.root ?? 0, true),
        text: plain(raw.content?.message, 4000), author: { mid: integer(raw.member?.mid), name: plain(raw.member?.uname, 200) }, likes: integer(raw.like ?? 0, 0) }]; } catch { return []; }
    });
    const info = record(data.page); const total = Number(info.count); const size = Number(info.size ?? 20);
    const hasMore = Number.isFinite(total) && Number.isFinite(size) && size > 0 && page * size < total;
    return { items, hasMore, ...(hasMore ? { nextPage: page + 1 } : {}) };
  }
  async comment(aid: number, rpid: string, options: CallOptions): Promise<ThreadComment> {
    if (typeof aid !== 'number') throw new BiliError('invalid_input'); integer(aid); checkedCommentId(rpid);
    // The official detail response calls the selected row "root", including when the selected rpid is a child reply.
    const data = apiData(await this.request('/x/v2/reply/detail', { type: '1', oid: String(aid), root: rpid }, options));
    try {
      if (data.root === null) throw new BiliError('reference_unavailable');
      const found = threadComment(data.root, aid);
      if (found.rpid !== rpid) throw new BiliError('malformed_response');
      return found;
    } catch (error) { return threadFailure(error); }
  }
  async thread(aid: number, root: string, page: number, options: CallOptions): Promise<CommentThread> {
    if (typeof aid !== 'number' || typeof page !== 'number') throw new BiliError('invalid_input'); integer(aid); checkedCommentId(root); pageNumber(page);
    const data = apiData(await this.request('/x/v2/reply/reply', { type: '1', oid: String(aid), root, pn: String(page), ps: '20' }, options));
    try {
      if (data.root === null) throw new BiliError('reference_unavailable');
      const found = threadComment(data.root, aid);
      if (found.rpid !== root || found.root !== '0' || found.parent !== '0') throw new BiliError('malformed_response');
      const info = record(data.page), num = notificationNumber(info.num, 1), size = notificationNumber(info.size, 1), count = notificationNumber(info.count);
      if (num !== page || size > 100) throw new BiliError('malformed_response');
      const rows = notificationItems(data.replies);
      if (rows.length > 20 || rows.length > size) throw new BiliError('too_large');
      const items = rows.map(row => threadComment(row, aid));
      if (items.some(item => item.root !== root || item.rpid === root) || new Set(items.map(item => item.rpid)).size !== items.length) throw new BiliError('malformed_response');
      const hasMore = page * size < count;
      if (hasMore && !items.length) throw new BiliError('malformed_response');
      return { root: found, items, hasMore, ...(hasMore ? { nextPage: page + 1 } : {}) };
    } catch (error) { return threadFailure(error); }
  }
  async notifications(source: NotificationSource, cursor: NotificationCursor | undefined, options: CallOptions): Promise<NotificationList> {
    if (source !== 'replies' && source !== 'likes') throw new BiliError('invalid_input');
    if (cursor !== undefined && (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)
      || Object.keys(cursor).some(key => key !== 'id' && key !== 'time')
      || typeof cursor.id !== 'string' || !/^[1-9]\d{0,19}$/.test(cursor.id)
      || typeof cursor.time !== 'number' || !Number.isSafeInteger(cursor.time) || cursor.time < 1)) throw new BiliError('invalid_input');
    if (!checkedCookie(options.cookie)) throw new BiliError('login_required');
    const data = apiData(await this.request(source === 'replies' ? '/x/msgfeed/reply' : '/x/msgfeed/like', {
      platform: 'web', build: '0', mobi_app: 'web',
      ...(cursor ? { id: cursor.id, [source === 'replies' ? 'reply_time' : 'like_time']: String(cursor.time) } : {}),
    }, options));
    try {
      const history = source === 'replies' ? data : record(data.total), next = record(history.cursor);
      if (typeof next.is_end !== 'boolean') throw new BiliError('malformed_response');
      const nextId = identifier(next.id, true), nextTime = notificationNumber(next.time);
      const hasMore = !next.is_end;
      if (hasMore && (/^0+$/.test(nextId) || nextTime < 1 || cursor && nextId === cursor.id && nextTime === cursor.time)) throw new BiliError('malformed_response');
      const latest = source === 'likes' && cursor === undefined && data.latest != null ? notificationItems(record(data.latest).items) : [];
      const rows = [...latest, ...notificationItems(history.items)];
      if (rows.length > 100) throw new BiliError('too_large');
      const items: NotificationItem[] = [], ids = new Set<string>();
      for (const row of rows) { const item = notification(row, source); if (!ids.has(item.id)) { ids.add(item.id); items.push(item); } }
      return { items, hasMore, ...(hasMore ? { cursor: { id: nextId, time: nextTime } } : {}) };
    } catch (error) {
      if (error instanceof BiliError && error.code === 'too_large') throw error;
      throw new BiliError('malformed_response');
    }
  }
  async subtitles(id: string, cid: number, options: CallOptions): Promise<{ tracks: SubtitleTrack[]; loginRequired: boolean }> {
    bvid(id); integer(cid);
    const data = apiData(await this.request('/x/player/v2', { bvid: id, cid: String(cid) }, options));
    const source = data.subtitle?.subtitles;
    if (source !== undefined && !Array.isArray(source)) throw new BiliError('malformed_response');
    const tracks = (source ?? []).slice(0, 30).flatMap((raw: any) => {
      try {
        const url = mediaUrl(raw.subtitle_url); const track = { id: identifier(raw.id_str ?? raw.id), language: plain(raw.lan, 40), label: plain(raw.lan_doc, 100), url };
        this.remember(this.knownSubtitles, url); return [track];
      } catch { return []; }
    });
    if (source?.length > 0 && !tracks.length) throw new BiliError('malformed_response');
    return { tracks, loginRequired: data.need_login_subtitle === true };
  }
  async subtitle(url: string, options: CallOptions): Promise<SubtitleCue[]> {
    if (!this.knownSubtitles.has(url)) throw new BiliError('unsafe_url');
    const json = parseJson(await this.transport.request(url, { ...this.options(options), maxBytes: 2 * 1024 * 1024,
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/' } }));
    if (!Array.isArray(json.body)) throw new BiliError('malformed_response');
    const result: SubtitleCue[] = []; let total = 0;
    for (const raw of json.body.slice(0, 10000)) {
      if (!raw || typeof raw.from !== 'number' || typeof raw.to !== 'number' || !Number.isFinite(raw.from) || !Number.isFinite(raw.to) || raw.from < 0 || raw.to < raw.from || typeof raw.content !== 'string') throw new BiliError('malformed_response');
      const text = plain(raw.content, 4000); total += text.length; if (total > 200000) throw new BiliError('too_large');
      result.push({ from: raw.from, to: raw.to, text });
    }
    if (json.body.length > 10000) throw new BiliError('too_large'); return result;
  }
  private async download(url: string, maxBytes: number, options: CallOptions, video = false) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024) throw new BiliError('invalid_input');
    const response = await this.transport.request(url, { ...this.options(options), maxBytes,
      headers: { Accept: '*/*', 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/',
        ...(video ? { Range: 'bytes=0-', 'Accept-Encoding': 'identity' } : {}) } });
    if (video && response.status === 567) throw new BiliError('media_download_rejected');
    if ([401, 403, 412, 429, 503].includes(response.status)) throw new BiliError('access_blocked');
    if (!video) {
      if (response.status === 206 || response.headers['content-range'] !== undefined) throw new BiliError('unsupported_media');
      if (response.status !== 200) throw new BiliError('platform_error');
    } else {
      if (response.status !== 200 && response.status !== 206) throw new BiliError('platform_error');
      const encoding = response.headers['content-encoding'], type = response.headers['content-type'];
      if (encoding !== undefined && (typeof encoding !== 'string' || encoding.trim().toLowerCase() !== 'identity')
        || type !== undefined && (typeof type !== 'string' || /^multipart\//i.test(type.trim()))) throw new BiliError('unsupported_media');
      const range = response.headers['content-range'];
      if (response.status === 200) {
        if (range !== undefined) throw new BiliError('unsupported_media');
      } else {
        const match = typeof range === 'string' ? /^bytes 0-(0|[1-9]\d*)\/([1-9]\d*)$/.exec(range) : null;
        if (!match) throw new BiliError('unsupported_media');
        const end = Number(match[1]), total = Number(match[2]);
        if (!Number.isSafeInteger(end) || !Number.isSafeInteger(total) || end !== total - 1) throw new BiliError('unsupported_media');
        if (total > maxBytes) throw new BiliError('too_large');
        if (response.body.length !== total) throw new BiliError('unsupported_media');
      }
      const length = response.headers['content-length'];
      if (length !== undefined && (typeof length !== 'string' || !/^(0|[1-9]\d*)$/.test(length)
        || !Number.isSafeInteger(Number(length)) || Number(length) !== response.body.length)) throw new BiliError('unsupported_media');
    }
    if (response.body.length > maxBytes) throw new BiliError('too_large'); return response.body;
  }
  async media(id: string, cid: number, maxBytes: number, options: CallOptions): Promise<Media> {
    bvid(id); integer(cid);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024) throw new BiliError('invalid_input');
    const data = apiData(await this.request('/x/player/playurl', { bvid: id, cid: String(cid), qn: '16', fnval: '1', fnver: '0', fourk: '0' }, options));
    if (!Array.isArray(data.durl) || data.durl.length !== 1 || typeof data.format !== 'string' || !data.format.includes('mp4')) throw new BiliError('unsupported_media');
    const part = record(data.durl[0]);
    if (typeof part.size === 'number' && part.size > maxBytes) throw new BiliError('too_large');
    const bytes = await this.download(playableUrl(part), maxBytes, options, true);
    if (bytes.length < 12 || bytes.toString('ascii', 4, 8) !== 'ftyp'
      || Number.isSafeInteger(part.size) && part.size > 0 && bytes.length !== part.size) throw new BiliError('unsupported_media');
    return { bytes, mime: 'video/mp4' };
  }
  async image(url: string, maxBytes: number, options: CallOptions): Promise<Media> {
    if (!this.knownImages.has(url)) throw new BiliError('unsafe_url');
    const bytes = await this.download(url, maxBytes, options);
    const mime = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
      : bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
        : bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp'
          : ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)) ? 'image/gif' : undefined;
    if (!mime) throw new BiliError('unsupported_media'); return { bytes, mime };
  }
  async account(options: CallOptions) {
    if (!checkedCookie(options.cookie)) throw new BiliError('login_required');
    const data = apiData(await this.request('/x/web-interface/nav', {}, options));
    if (data.isLogin !== true) throw new BiliError('login_required');
    try { return { mid: integer(data.mid), name: plain(data.uname, 200) }; } catch { throw new BiliError('malformed_response'); }
  }
  async beginLogin(options: CallOptions) {
    const data = apiData(await this.request('/x/passport-login/web/qrcode/generate', {}, { ...options, cookie: undefined }, true));
    if (typeof data.qrcode_key !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(data.qrcode_key)) throw new BiliError('malformed_response');
    const url = validateLoginUrl(data.url);
    for (const [key, expiry] of this.loginKeys) if (expiry <= Date.now()) this.loginKeys.delete(key);
    if (!this.loginKeys.has(data.qrcode_key) && this.loginKeys.size >= 4) this.loginKeys.delete(this.loginKeys.keys().next().value!);
    this.loginKeys.set(data.qrcode_key, Date.now() + 180000); return { key: data.qrcode_key, url };
  }
  async pollLogin(key: string, options: CallOptions): Promise<LoginPoll> {
    const expiry = this.loginKeys.get(key);
    if (!expiry || expiry <= Date.now()) { this.loginKeys.delete(key); return { state: 'expired' }; }
    const response = await this.request('/x/passport-login/web/qrcode/poll', { qrcode_key: key }, { ...options, cookie: undefined }, true);
    const data = apiData(response);
    if (data.code === 86101) return { state: 'waiting' };
    if (data.code === 86090) return { state: 'scanned' };
    if (data.code === 86038) { this.loginKeys.delete(key); return { state: 'expired' }; }
    if (data.code !== 0) throw new BiliError('platform_error');
    const headers = response.headers['set-cookie'];
    const parts = (Array.isArray(headers) ? headers : typeof headers === 'string' ? [headers] : []).flatMap(header => {
      const pair = header.split(';', 1)[0]; const name = pair.slice(0, pair.indexOf('=')); return AUTH_COOKIES.has(name) ? [pair] : [];
    });
    const cookie = checkedCookie(parts.join('; '));
    if (!cookieValue(cookie, 'SESSDATA') || !cookieValue(cookie, 'bili_jct') || !/^\d+$/.test(cookieValue(cookie, 'DedeUserID'))) throw new BiliError('malformed_response');
    const token = data.refresh_token === undefined || data.refresh_token === '' ? undefined : refreshToken(data.refresh_token);
    this.loginKeys.delete(key); return { state: 'confirmed', cookie, ...(token ? { refreshToken: token } : {}) };
  }
  async folders(mid: number, options: CallOptions) {
    integer(mid); if (!checkedCookie(options.cookie)) throw new BiliError('login_required');
    const data = apiData(await this.request('/x/v3/fav/folder/created/list-all', { up_mid: String(mid), type: '2' }, options));
    if (data.list == null) return [];
    if (!Array.isArray(data.list)) throw new BiliError('malformed_response');
    return data.list.slice(0, 1000).map((item: any) => ({ id: identifier(item.id), title: plain(item.title, 200) }));
  }
  async ownerProfile(uid: string, options: CallOptions) {
    const target = validateOwnerUid(uid);
    options.assertCurrent?.();
    const data = apiData(await this.request('/x/web-interface/card', { mid: target }, options));
    options.assertCurrent?.();
    try {
      const card = record(data.card);
      const result = validateOwnerProfile({ uid: typeof card.mid === 'number' && Number.isSafeInteger(card.mid) ? String(card.mid) : card.mid, name: card.name });
      if (result.uid !== target) throw new BiliError('malformed_response');
      return result;
    } catch { throw new BiliError('malformed_response'); }
  }
  private async commentPublication(input: InteractionInput, platformId: string, reply: unknown, options: CallOptions): Promise<CommentPublication> {
    let result: CommentPublication = { visibility: 'unknown', checkedAnonymously: false, notification: 'unverified' };
    // The POST receipt proves acceptance only. Its non-public flags are useful even if the later read fails.
    try {
      const row = record(reply);
      if (responseId(row, 'rpid') !== platformId || row.type !== undefined && row.type !== 1
        || (row.oid !== undefined || row.oid_str !== undefined) && integer(responseId(row, 'oid')) !== input.aid) throw new BiliError('malformed_response');
      const state = typeof row.state === 'number' && Number.isSafeInteger(row.state) && row.state >= 0 ? row.state : undefined;
      result = { ...result, ...(state !== undefined ? { state } : {}),
        visibility: row.invisible === true || state !== undefined && state !== 0 ? 'not_public' : 'unknown' };
    } catch { /* Missing or mismatched POST metadata cannot establish publication. */ }
    try {
      // One bounded, credential-free check within the original tool call; no polling or resubmission.
      const response = await this.request('/x/v2/reply/detail', { type: '1', oid: String(input.aid), root: platformId },
        { ...options, cookie: undefined, timeoutMs: Math.min(options.timeoutMs ?? 20000, 5000) });
      this.options(options);
      const json = parseJson(response);
      if (json.code === 12006 || json.code === 0 && json.data?.root === null)
        return { ...result, visibility: 'not_public', checkedAnonymously: true };
      if (json.code !== 0) return result;
      const row = record(record(json.data).root);
      if (row.type !== 1 || integer(responseId(row, 'oid')) !== input.aid || responseId(row, 'rpid') !== platformId
        || responseId(row, 'root', true) !== (input.action === 'reply' ? input.root : '0')
        || responseId(row, 'parent', true) !== (input.action === 'reply' ? input.parent : '0')
        || typeof row.state !== 'number' || !Number.isSafeInteger(row.state) || row.state < 0
        || typeof row.invisible !== 'boolean') return result;
      return { visibility: row.state === 0 && !row.invisible ? 'public' : 'not_public', state: row.state,
        checkedAnonymously: true, notification: 'unverified' };
    } catch { return result; } // Accepted comments stay accepted after read failure, cancellation or account change.
  }
  async interact(input: InteractionInput, options: CallOptions): Promise<InteractionResult> {
    if (!input || !['like', 'favorite', 'follow', 'comment', 'reply'].includes(input.action) || 'coinCount' in input) throw new BiliError('invalid_input');
    if (Object.keys(input).some(key => !['action', 'aid', 'bvid', 'mid', 'enabled', 'folderId', 'text', 'root', 'parent', 'mentionOwner'].includes(key))) throw new BiliError('invalid_input');
    if (input.mentionOwner !== undefined && !['comment', 'reply'].includes(input.action)) throw new BiliError('invalid_input');
    integer(input.aid); integer(input.mid);
    if (input.bvid !== undefined) bvid(input.bvid);
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new BiliError('invalid_input');
    const cookie = checkedCookie(options.cookie); const csrf = cookieValue(cookie, 'bili_jct');
    if (!cookie || !/^[A-Za-z0-9]{16,128}$/.test(csrf)) throw new BiliError('login_required');
    let path: string; const body: Record<string, string> = { csrf };
    if (input.action === 'like') { path = '/x/web-interface/archive/like'; Object.assign(body, { aid: String(input.aid), like: input.enabled === false ? '2' : '1' }); }
    else if (input.action === 'favorite') {
      path = '/x/v3/fav/resource/deal'; const folder = identifier(input.folderId);
      Object.assign(body, { rid: String(input.aid), type: '2', add_media_ids: input.enabled === false ? '' : folder, del_media_ids: input.enabled === false ? folder : '' });
    } else if (input.action === 'follow') { path = '/x/relation/modify'; Object.assign(body, { fid: String(input.mid), act: input.enabled === false ? '2' : '1', re_src: '11' }); }
    else {
      path = '/x/v2/reply/add';
      if (typeof input.text !== 'string' || !input.text.trim() || [...input.text].length > 1000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.text)) throw new BiliError('invalid_input');
      if (input.text.includes('@')) throw new BiliError('mention_invalid');
      let message = input.text;
      if (input.mentionOwner !== undefined) {
        const owner = validateOwnerProfile(input.mentionOwner);
        message = '@' + owner.name + ' ' + message;
        if ([...message].length > 1000) throw new BiliError('invalid_input');
        body.at_name_to_mid = JSON.stringify({ [owner.name]: Number(owner.uid) });
      }
      Object.assign(body, { oid: String(input.aid), type: '1', message, plat: '1', gaia_source: 'main_web', statistics: JSON.stringify({ appId: 100, platform: 5 }) });
      if (input.action === 'reply') Object.assign(body, { root: identifier(input.root), parent: identifier(input.parent) });
    }
    const comment = input.action === 'comment' || input.action === 'reply';
    const referer = comment ? `https://www.bilibili.com/video/${input.bvid ?? 'av' + input.aid}/` : 'https://www.bilibili.com/';
    const call = this.options(options);
    let response: TransportResponse;
    try {
      response = await this.transport.request(API + path, { ...call, method: 'POST', body: new URLSearchParams(body).toString(), maxBytes: 1024 * 1024,
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0', Referer: referer, Cookie: cookie, ...(comment ? { Origin: 'https://www.bilibili.com', 'x-csrf-token': csrf } : {}) } });
    } catch (error) {
      if (error instanceof TransportError && !error.submitted) throw error;
      throw new BiliError('uncertain');
    }
    let json: Record<string, any>;
    try { json = parseJson(response); } catch { throw new BiliError('uncertain'); }
    if (typeof json.code !== 'number') throw new BiliError('uncertain');
    if (json.code !== 0) { apiData(response); throw new BiliError('platform_error'); }
    if (input.action === 'comment' || input.action === 'reply') {
      let data: Record<string, any>, platformId: string;
      try { data = record(json.data); platformId = identifier(data.rpid_str ?? data.rpid ?? data.reply?.rpid_str ?? data.reply?.rpid); }
      catch { throw new BiliError('uncertain'); }
      return { state: 'confirmed', platformId, comment: await this.commentPublication(input, platformId, data.reply, options) };
    }
    return { state: 'confirmed' };
  }
  async dispose() { this.aborter.abort(); this.searchPreparation = undefined; this.knownImages.clear(); this.knownSubtitles.clear(); this.loginKeys.clear(); await this.transport.dispose(); }
}
