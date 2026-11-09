/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { BiliError } from './errors.ts';
import { validateLoginUrl } from './login-url.ts';
import { createTransport, safeUrl, TransportError } from './transport.ts';
import type { Transport, TransportResponse } from './transport.ts';
import type { BiliClientContract, CallOptions, VideoItem, VideoDetails, VideoList, CommentList,
  SubtitleTrack, SubtitleCue, Media, LoginPoll, InteractionInput } from './types.ts';

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
  if ([-352, -412, -509, -799].includes(json.code)) throw new BiliError('access_blocked');
  if (json.code !== 0) throw new BiliError(typeof json.code === 'number' ? 'platform_error' : 'malformed_response');
  return json.data == null ? {} : record(json.data);
}

export class BiliClient implements BiliClientContract {
  private transport: Transport;
  private aborter = new AbortController();
  private signal: AbortSignal;
  private knownImages = new Set<string>();
  private knownSubtitles = new Set<string>();
  private loginKeys = new Map<string, number>();
  constructor(options: { transport?: Transport; signal?: AbortSignal } = {}) {
    this.transport = options.transport ?? createTransport();
    this.signal = options.signal ? AbortSignal.any([options.signal, this.aborter.signal]) : this.aborter.signal;
  }
  private options(options: CallOptions) {
    if (this.signal.aborted) throw new BiliError('stopped');
    if (options.signal?.aborted) throw new BiliError('cancelled');
    const timeoutMs = options.timeoutMs ?? 20000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 240000) throw new BiliError('invalid_input');
    return { signal: AbortSignal.any([this.signal, ...(options.signal ? [options.signal] : [])]), timeoutMs };
  }
  private async request(path: string, params: Record<string, string>, options: CallOptions, passport = false) {
    const url = new URL(path, passport ? PASSPORT : API); url.search = new URLSearchParams(params).toString();
    const cookie = checkedCookie(options.cookie);
    const response = await this.transport.request(url.href, { ...this.options(options), maxBytes: 2 * 1024 * 1024,
      headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate, br', 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/', ...(cookie ? { Cookie: cookie } : {}) } });
    if (safeUrl(response.url).hostname !== url.hostname) throw new BiliError('unsafe_url');
    return response;
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
    const data = apiData(await this.request('/x/web-interface/search/type', { search_type: 'video', keyword: query.trim(), page: String(page), page_size: '12' }, options));
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
      return { ...item, cid: integer(data.cid), description: plain(data.desc, 10000), parts };
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
  private async download(url: string, maxBytes: number, options: CallOptions) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024) throw new BiliError('invalid_input');
    const response = await this.transport.request(url, { ...this.options(options), maxBytes,
      headers: { Accept: '*/*', 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/' } });
    if ([401, 403, 412, 429, 503].includes(response.status)) throw new BiliError('access_blocked');
    if (response.status === 206 || response.headers['content-range'] !== undefined) throw new BiliError('unsupported_media');
    if (response.status !== 200) throw new BiliError('platform_error');
    if (response.body.length > maxBytes) throw new BiliError('too_large'); return response.body;
  }
  async media(id: string, cid: number, maxBytes: number, options: CallOptions): Promise<Media> {
    bvid(id); integer(cid);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024) throw new BiliError('invalid_input');
    const data = apiData(await this.request('/x/player/playurl', { bvid: id, cid: String(cid), qn: '16', fnval: '1', fnver: '0', fourk: '0' }, options));
    if (!Array.isArray(data.durl) || data.durl.length !== 1 || typeof data.format !== 'string' || !data.format.includes('mp4')) throw new BiliError('unsupported_media');
    const part = record(data.durl[0]);
    if (typeof part.size === 'number' && part.size > maxBytes) throw new BiliError('too_large');
    const bytes = await this.download(playableUrl(part), maxBytes, options);
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
    this.loginKeys.delete(key); return { state: 'confirmed', cookie };
  }
  async folders(mid: number, options: CallOptions) {
    integer(mid); if (!checkedCookie(options.cookie)) throw new BiliError('login_required');
    const data = apiData(await this.request('/x/v3/fav/folder/created/list-all', { up_mid: String(mid), type: '2' }, options));
    if (data.list == null) return [];
    if (!Array.isArray(data.list)) throw new BiliError('malformed_response');
    return data.list.slice(0, 1000).map((item: any) => ({ id: identifier(item.id), title: plain(item.title, 200) }));
  }
  async interact(input: InteractionInput, options: CallOptions): Promise<{ state: 'confirmed'; platformId?: string }> {
    if (!input || !['like', 'favorite', 'follow', 'comment', 'reply'].includes(input.action)) throw new BiliError('invalid_input');
    integer(input.aid); integer(input.mid);
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
      Object.assign(body, { oid: String(input.aid), type: '1', message: input.text, plat: '1' });
      if (input.action === 'reply') Object.assign(body, { root: identifier(input.root), parent: identifier(input.parent) });
    }
    const call = this.options(options);
    let response: TransportResponse;
    try {
      response = await this.transport.request(API + path, { ...call, method: 'POST', body: new URLSearchParams(body).toString(), maxBytes: 1024 * 1024,
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/', Cookie: cookie } });
    } catch (error) {
      if (error instanceof TransportError && !error.submitted) throw error;
      throw new BiliError('uncertain');
    }
    let json: Record<string, any>;
    try { json = parseJson(response); } catch { throw new BiliError('uncertain'); }
    if (typeof json.code !== 'number') throw new BiliError('uncertain');
    if (json.code !== 0) { apiData(response); throw new BiliError('platform_error'); }
    if (input.action === 'comment' || input.action === 'reply') {
      try { const data = record(json.data); return { state: 'confirmed', platformId: identifier(data.rpid_str ?? data.rpid ?? data.reply?.rpid_str ?? data.reply?.rpid) }; }
      catch { throw new BiliError('uncertain'); }
    }
    return { state: 'confirmed' };
  }
  async dispose() { this.aborter.abort(); this.knownImages.clear(); this.knownSubtitles.clear(); this.loginKeys.clear(); await this.transport.dispose(); }
}
