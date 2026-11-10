/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { HistoryTarget, HistoryPositionInput, HistoryProgress } from './history-client.ts';
import type { DanmakuInput, DanmakuResult } from './danmaku-client.ts';
export type Action = 'like' | 'favorite' | 'follow' | 'comment' | 'reply' | 'coin';
export interface Config { audioEnabled: boolean; historySyncEnabled: boolean; danmakuEnabled: boolean; autoRefreshEnabled: boolean; interactions: Record<Action, boolean>; favoriteFolderId: string; maxMediaBytes: number; referenceTtlSeconds: number }
export interface CallOptions { signal?: AbortSignal; cookie?: string; timeoutMs?: number }
export interface VideoItem { bvid: string; aid: number; title: string; owner: { mid: number; name: string }; duration: number; cover: string; url: string }
export interface VideoDetails extends VideoItem { cid: number; description: string; copyright?: 1 | 2 | 3; parts: { cid: number; page: number; title: string; duration: number }[] }
export interface VideoList { items: VideoItem[]; hasMore: boolean; cursor?: string; nextPage?: number }
export interface CommentItem { rpid: string; root: string; text: string; author: { mid: number; name: string }; likes: number }
export interface CommentList { items: CommentItem[]; hasMore: boolean; nextPage?: number }
export interface ThreadComment extends CommentItem { aid: number; parent: string }
export interface CommentThread { root: ThreadComment; items: ThreadComment[]; hasMore: boolean; nextPage?: number }
export interface NotificationTarget { aid: number; rpid: string; root: string; authorMid: number }
export type NotificationSource = 'replies' | 'likes';
export interface NotificationCursor { id: string; time: number }
export interface NotificationActor { mid: number; name: string }
export interface NotificationItem {
  id: string; actors: NotificationActor[]; time: number; type: string; business: string;
  title: string; text: string; originalText: string; uri?: string; videoTarget?: string; likeCount?: number; target?: NotificationTarget;
}
export interface NotificationList { items: NotificationItem[]; hasMore: boolean; cursor?: NotificationCursor }
export interface SubtitleTrack { id: string; language: string; label: string; url: string }
export interface SubtitleCue { from: number; to: number; text: string }
export interface Media { bytes: Buffer; mime: string }
export type LoginPoll = { state: 'waiting' | 'scanned' | 'expired' } | { state: 'confirmed'; cookie: string; refreshToken?: string };
export interface InteractionInput { action: Action; aid: number; mid: number; enabled?: boolean; folderId?: string; text?: string; root?: string; parent?: string; coinCount?: number }
export interface BiliClientContract {
  feed(source: 'recommended' | 'following', page: number, cursor: string | undefined, options: CallOptions): Promise<VideoList>;
  search(query: string, page: number, options: CallOptions): Promise<VideoList>;
  video(target: string, options: CallOptions): Promise<VideoDetails>;
  comments(aid: number, page: number, options: CallOptions): Promise<CommentList>;
  comment(aid: number, rpid: string, options: CallOptions): Promise<ThreadComment>;
  thread(aid: number, root: string, page: number, options: CallOptions): Promise<CommentThread>;
  historyProgress(target: HistoryTarget, options: CallOptions): Promise<HistoryProgress>;
  reportHistoryPosition(input: HistoryPositionInput, options: CallOptions): Promise<{ state: 'accepted' }>;
  danmaku(input: DanmakuInput, options: CallOptions): Promise<DanmakuResult>;
  coins(aid: number, options: CallOptions): Promise<number>;
  checkRefresh(options: CallOptions): Promise<{ refresh: boolean; timestamp: number }>;
  refreshCsrf(timestamp: number, options: CallOptions): Promise<string>;
  renewCookies(token: string, refreshCsrf: string, options: CallOptions): Promise<{ cookie: string; refreshToken: string }>;
  confirmRefresh(token: string, options: CallOptions): Promise<void>;
  notifications(source: NotificationSource, cursor: NotificationCursor | undefined, options: CallOptions): Promise<NotificationList>;
  subtitles(bvid: string, cid: number, options: CallOptions): Promise<{ tracks: SubtitleTrack[]; loginRequired: boolean }>;
  subtitle(url: string, options: CallOptions): Promise<SubtitleCue[]>;
  media(bvid: string, cid: number, maxBytes: number, options: CallOptions): Promise<Media>;
  image(url: string, maxBytes: number, options: CallOptions): Promise<Media>;
  account(options: CallOptions): Promise<{ mid: number; name: string; coins?: number }>;
  beginLogin(options: CallOptions): Promise<{ url: string; key: string }>;
  pollLogin(key: string, options: CallOptions): Promise<LoginPoll>;
  folders(mid: number, options: CallOptions): Promise<{ id: string; title: string }[]>;
  interact(input: InteractionInput, options: CallOptions): Promise<{ state: 'confirmed'; platformId?: string }>;
  dispose(): void | Promise<void>;
}
export interface SurfService { status(): unknown; settings(): { timeoutMs: number; concurrency: number; hasProxy: boolean }; search(input: { sessionId: string; query: string; limit?: number }, options?: { signal?: AbortSignal }): Promise<unknown> }
export interface VisionService {
  readonly audiovisualApiVersion?: string;
  status(): { audiovisualApiVersion?: string };
  offerMedia(input: { sessionId: string; mime: string; base64: string }, options?: { signal?: AbortSignal }): Promise<{ mediaRef: string; expiresAt: string; info: unknown }>;
  release(input: { sessionId: string; mediaRef: string }, options?: { signal?: AbortSignal }): Promise<unknown>;
  prepare(input: { sessionId: string; mediaRef: string; fromSeconds?: number; toSeconds?: number; layout?: 'sheet' | 'frames' }, options?: { signal?: AbortSignal }): Promise<PreparedMedia>;
  understand?(input: { sessionId: string; mediaRef: string; fromSeconds?: number; toSeconds?: number; visual: boolean; audio: ['speech'] }, options?: { signal?: AbortSignal }): Promise<{ status: string; visual?: PreparedMedia; visualError?: unknown; audio: unknown }>;
}
export interface PreparedMedia { images: { mime: 'image/jpeg'; base64: string; width: number; height: number; frames: unknown[] }[]; coverage: unknown; warnings: string[] }
export interface AccountState { cookie: string; mid: number; name: string; revision: string; refreshToken?: string; refreshState?: 'pending' | 'confirming' | 'uncertain' }
export type Result<T> = { status: 'ok'; data: T } | { status: 'error'; error: { code: string; message: string } };
