/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { OptionalService, ToolSession, TransientToolOutput } from 'whalelife';
import { BiliError, object, safeError } from './errors.ts';
import type { QQMiniAppShareInput, QQMiniAppShareService, VideoItem } from './types.ts';

type Outcome = { status: 'sent' | 'not_sent' | 'uncertain' | 'not_found'; confirmed: boolean; duplicate?: boolean;
  retryAutomatically: false; canRetry: false; platformMessageId?: string; ledgerSaved?: boolean; error?: ReturnType<typeof safeError> };
interface Options { signal: AbortSignal; guard(): void; enabled(): boolean; video(ref: unknown, sessionId: string): VideoItem }
const providerErrors: Record<string, string> = { invalid_input: 'invalid_input', permission: 'permission_required', recipient: 'qq_recipient_unavailable',
  session: 'session_required', binding: 'qq_unavailable', offline: 'qq_unavailable', busy: 'busy', cancelled: 'cancelled', conflict: 'qq_share_conflict',
  storage: 'qq_share_storage', unsupported: 'qq_unavailable', invalid_card: 'qq_share_invalid_card', uncertain: 'uncertain' };
function text(value: unknown, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new BiliError('invalid_input');
  return value;
}
function label(value: unknown, max: number) {
  if (typeof value !== 'string') throw new BiliError('invalid_input');
  let result = '';
  for (const char of value.replace(/[\x00-\x1f\x7f]/g, ' ').trim()) {
    if (result.length + char.length > max) break; result += char;
  }
  if (!result) throw new BiliError('invalid_input'); return result;
}
function metadata(video: VideoItem): Pick<QQMiniAppShareInput, 'preset' | 'title' | 'description' | 'previewUrl' | 'jumpPath' | 'webUrl'> {
  if (!/^BV[1-9A-HJ-NP-Za-km-z]{10}$/.test(video.bvid) || !Number.isSafeInteger(video.aid) || video.aid < 1) throw new BiliError('invalid_input');
  const cover = text(video.cover, 2048);
  let preview: URL;
  try { preview = new URL(cover.startsWith('//') ? 'https:' + cover : cover); } catch { throw new BiliError('unsafe_url'); }
  if (!['http:', 'https:'].includes(preview.protocol) || preview.username || preview.password || preview.port || preview.hash
    || !(preview.hostname === 'hdslb.com' || preview.hostname.endsWith('.hdslb.com'))) throw new BiliError('unsafe_url');
  preview.protocol = 'https:';
  return { preset: 'bili', title: label(video.title, 200), description: label('UP主：' + label(video.owner?.name, 500), 500),
    previewUrl: preview.href, jumpPath: 'pages/video/video?avid=' + video.aid, webUrl: 'https://www.bilibili.com/video/' + video.bvid + '/' };
}
function project(value: unknown, query: boolean): Outcome {
  const r = object(value);
  if (typeof r.status !== 'string' || !['sent', 'not_sent', 'uncertain', ...(query ? ['not_found'] : [])].includes(r.status)
    || typeof r.confirmed !== 'boolean' || r.confirmed !== (r.status === 'sent')) throw new BiliError('malformed_response');
  const validMessageId = typeof r.platformMessageId === 'string' && /^-?[1-9]\d{0,29}$/.test(r.platformMessageId);
  if (r.confirmed && !validMessageId) throw new BiliError('malformed_response');
  const result: Outcome = { status: r.status as Outcome['status'], confirmed: r.confirmed, retryAutomatically: false, canRetry: false };
  if (typeof r.duplicate === 'boolean') result.duplicate = r.duplicate;
  if (typeof r.ledgerSaved === 'boolean') result.ledgerSaved = r.ledgerSaved;
  if (validMessageId) result.platformMessageId = r.platformMessageId as string;
  if (!r.confirmed && r.error !== undefined) {
    const code = typeof r.error === 'string' ? r.error : r.error && typeof r.error === 'object' ? (r.error as { code?: unknown }).code : undefined;
    result.error = safeError(new BiliError(typeof code === 'string' ? providerErrors[code] ?? 'qq_share_error' : 'qq_share_error'));
  }
  return result;
}
function present(result: Outcome, query: boolean): TransientToolOutput {
  return { content: { status: result.status === 'sent' || result.status === 'not_found' ? 'ok' : 'error', data: result,
    ...(result.error ? { error: result.error } : {}) }, receipt: { action: query ? 'bilibili_qq_share_delivery' : 'bilibili_share_qq',
    status: result.status, confirmed: result.confirmed, duplicate: result.duplicate === true, ...(result.error ? { code: result.error.code } : {}) } };
}

export class QQSharing {
  private binding?: OptionalService<QQMiniAppShareService>;
  private bindingGeneration = new AbortController();
  private sendingGeneration = new AbortController();
  private active = 0;
  private options: Options;
  constructor(options: Options) { this.options = options; }
  get available() {
    const b = this.binding;
    return Boolean(b && !b.signal.aborted && !this.options.signal.aborted && b.service.miniAppShareApiVersion === '1.0.0'
      && typeof b.service.sendMiniAppShare === 'function' && typeof b.service.miniAppShareDelivery === 'function');
  }
  get activeRequests() { return this.active; }
  set(binding?: OptionalService<QQMiniAppShareService>) {
    this.bindingGeneration.abort(); this.bindingGeneration = new AbortController(); this.binding = binding;
  }
  invalidate() { this.sendingGeneration.abort(); this.sendingGeneration = new AbortController(); }
  async share(raw: unknown, session: ToolSession, query = false): Promise<TransientToolOutput> {
    let dispatched = false, counted = false, result: Outcome | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    try {
      this.options.guard();
      if (!session?.id) throw new BiliError('session_required');
      const sessionId = text(session.id, 200);
      if (!query && session.permission !== 'full') throw new BiliError('permission_required');
      if (!query && !this.options.enabled()) throw new BiliError('qq_share_disabled');
      const args = object(raw), allowed = query ? ['userId', 'operationId'] : ['userId', 'operationId', 'videoRef'];
      if (Object.keys(args).some(key => !allowed.includes(key))) throw new BiliError('invalid_input');
      const userId = text(args.userId, 20), operationId = text(args.operationId, 96);
      if (!/^[1-9]\d{4,19}$/.test(userId) || !/^[A-Za-z0-9._:-]{1,96}$/.test(operationId)) throw new BiliError('invalid_input');
      if (!this.available) throw new BiliError('qq_unavailable');
      if (this.active >= 2) throw new BiliError('busy');
      const binding = this.binding!, deadline = new AbortController();
      const signal = AbortSignal.any([this.options.signal, binding.signal, this.bindingGeneration.signal,
        ...(session.signal ? [session.signal] : []), ...(!query ? [this.sendingGeneration.signal] : []), deadline.signal]);
      if (signal.aborted) throw new BiliError('cancelled');
      const key = { userId, actionId: 'bilibili:' + operationId, sessionId };
      const input = query ? undefined : { ...key, ...metadata(this.options.video(args.videoRef, sessionId)),
        ...(session.personaId !== undefined ? { personaId: text(session.personaId, 200) } : {}) };
      this.options.guard();
      if (!query && !this.options.enabled()) throw new BiliError('qq_share_disabled');
      if (signal.aborted) throw new BiliError('cancelled');
      this.active++; counted = true;
      timer = setTimeout(() => deadline.abort(), 20000);
      dispatched = true;
      const pending = Promise.resolve(query ? binding.service.miniAppShareDelivery(key) : binding.service.sendMiniAppShare(input!, { signal, permission: 'full' }))
        .then(value => { result = project(value, query); return result; });
      await bounded(pending, signal);
      return present(result!, query);
    } catch (error) {
      // A reliable provider acknowledgement survives cancellation or provider loss racing the response.
      if (result?.confirmed) return present(result, query);
      const uncertain = dispatched;
      const failure: Outcome = { status: uncertain ? 'uncertain' : 'not_sent', confirmed: false, retryAutomatically: false, canRetry: false,
        error: uncertain ? safeError(new BiliError('uncertain')) : safeError(error) };
      return present(failure, query);
    } finally { if (timer) clearTimeout(timer); if (counted) this.active--; }
  }
}
async function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new BiliError('cancelled')); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}
