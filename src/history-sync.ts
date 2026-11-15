/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { createHash, randomUUID } from 'node:crypto';
import { BiliError, object } from './errors.ts';
import type { AccountState, BiliClientContract, CallOptions, Config, PreparedMedia, VideoDetails } from './types.ts';

export interface HistoryOutcome {
  state: 'accepted' | 'verified' | 'already_recorded' | 'rejected' | 'uncertain';
  positionSeconds: number;
  duplicate?: boolean;
  experienceRecorded?: boolean;
}
export interface HistorySyncOptions {
  config: () => Config;
  account: () => AccountState | undefined;
  identity: () => string;
  now?: () => number;
  check: (identity: string, options: CallOptions) => void;
  readLedger: () => Promise<unknown>;
  saveLedger: (value: unknown) => Promise<void>;
  record?: (sessionId: string, eventId: string) => Promise<void>;
}
type Proof = { id: string; session: string; identity: string; aid: number; cid: number; positionSeconds: number; expires: number };
type Entry = {
  key: string; fingerprint: string; targetHash: string; positionSeconds: number;
  state: 'pending' | 'accepted' | 'verified' | 'rejected' | 'uncertain'; submitted: boolean; aliasOf?: string;
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
function text(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) throw new BiliError('invalid_input');
  return value.trim();
}

/** Stores sampling evidence and write receipts only; it never starts playback or a model. */
export class HistorySync {
  private proofs = new Map<string, Proof>();
  private entries: Entry[] = [];
  private initialized = false;
  private stopped = false;
  private now: () => number;
  private client: Pick<BiliClientContract, 'account' | 'historyProgress' | 'reportHistoryPosition'>;
  private options: HistorySyncOptions;
  constructor(client: Pick<BiliClientContract, 'account' | 'historyProgress' | 'reportHistoryPosition'>, options: HistorySyncOptions) {
    this.client = client; this.options = options;
    this.now = options.now ?? Date.now;
  }
  get ready() { return this.initialized && !this.stopped; }
  get status() { this.sweep(); return { ready: this.ready, proofs: this.proofs.size }; }
  async initialize() {
    try {
      const value = await this.options.readLedger();
      const rows = value === undefined || value === null || (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length) ? [] : object(value).entries;
      if (!Array.isArray(rows) || rows.length > 4096) throw new BiliError('config_invalid');
      const keys = new Set<string>();
      this.entries = rows.map(row => {
        const e = object(row);
        for (const field of ['key', 'fingerprint', 'targetHash']) if (typeof e[field] !== 'string' || !/^[a-f0-9]{64}$/.test(e[field] as string)) throw new BiliError('config_invalid');
        if (keys.has(e.key as string) || !Number.isSafeInteger(e.positionSeconds) || Number(e.positionSeconds) < 0
          || !['pending', 'accepted', 'verified', 'rejected', 'uncertain'].includes(String(e.state)) || typeof e.submitted !== 'boolean'
          || (e.aliasOf !== undefined && (e.submitted !== false || typeof e.aliasOf !== 'string' || !/^[a-f0-9]{64}$/.test(e.aliasOf)))
          || (e.submitted === false && e.state !== 'verified' && e.aliasOf === undefined)) throw new BiliError('config_invalid');
        keys.add(e.key as string);
        return { key: e.key as string, fingerprint: e.fingerprint as string, targetHash: e.targetHash as string,
          positionSeconds: Number(e.positionSeconds), state: e.state === 'pending' ? 'uncertain' : e.state as Entry['state'], submitted: e.submitted,
          ...(typeof e.aliasOf === 'string' ? { aliasOf: e.aliasOf } : {}) };
      });
      for (const entry of this.entries) if (entry.aliasOf && !this.entries.some(source => source.submitted && source.fingerprint === entry.aliasOf
        && source.targetHash === entry.targetHash && source.positionSeconds >= entry.positionSeconds)) throw new BiliError('config_invalid');
      this.initialized = !this.stopped;
    } catch { this.initialized = false; }
  }
  clearProofs() { this.proofs.clear(); }
  private sweep() {
    if (this.stopped || !this.options.config().historySyncEnabled || !this.options.account()) { this.proofs.clear(); return; }
    const identity = this.options.identity();
    for (const [id, proof] of this.proofs) if (proof.expires <= this.now() || proof.identity !== identity) this.proofs.delete(id);
  }
  private check(identity: string, options: CallOptions, proof?: Proof) {
    if (this.stopped) throw new BiliError('stopped');
    this.options.check(identity, options);
    if (options.signal?.aborted) throw new BiliError('cancelled');
    if (identity !== this.options.identity()) throw new BiliError('account_changed');
    if (!this.options.config().historySyncEnabled) { this.clearProofs(); throw new BiliError('history_disabled'); }
    if (!this.options.account()) throw new BiliError('login_required');
    if (proof && (this.proofs.get(proof.id) !== proof || proof.expires <= this.now())) throw new BiliError('reference_unavailable');
  }
  prove(session: string, identity: string, video: VideoDetails, part: { cid: number; duration: number }, prepared: PreparedMedia,
    range: { fromSeconds: number; toSeconds: number }): string | undefined {
    this.sweep();
    if (!this.ready || !session || !this.options.config().historySyncEnabled || !this.options.account() || identity !== this.options.identity()
      || !positiveId(video.aid) || !positiveId(part.cid) || !finite(part.duration) || part.duration <= 0
      || !video.parts.some(candidate => candidate.cid === part.cid && candidate.duration === part.duration)
      || !finite(range.fromSeconds) || !finite(range.toSeconds) || range.fromSeconds < 0 || range.toSeconds <= range.fromSeconds
      || range.toSeconds > part.duration || range.toSeconds - range.fromSeconds > 60) return undefined;
    const coverage = prepared?.coverage;
    if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)) return undefined;
    const c = coverage as Record<string, unknown>;
    if (!finite(c.fromSeconds) || !finite(c.toSeconds) || Math.abs(c.fromSeconds - range.fromSeconds) > 0.001
      || Math.abs(c.toSeconds - range.toSeconds) > 0.001 || !Array.isArray(prepared.images) || !prepared.images.length || prepared.images.length > 64) return undefined;
    const times: number[] = [];
    for (const image of prepared.images) {
      if (image.mime !== 'image/jpeg' || typeof image.base64 !== 'string' || !image.base64.length || image.base64.length > 16 * 1024 * 1024
        || !Number.isSafeInteger(image.width) || image.width < 1 || !Number.isSafeInteger(image.height) || image.height < 1
        || !Array.isArray(image.frames) || !image.frames.length || image.frames.length > 256 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.base64)) return undefined;
      const bytes = Buffer.from(image.base64, 'base64');
      if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) return undefined;
      for (const frame of image.frames) {
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return undefined;
        const at = (frame as Record<string, unknown>).atSeconds;
        if (!finite(at) || at < range.fromSeconds || at > range.toSeconds || at >= part.duration) return undefined;
        times.push(at);
      }
    }
    if (!times.length || this.proofs.size >= 128 || [...this.proofs.values()].filter(p => p.session === session).length >= 32) return undefined;
    const ref = 'bili_watch_' + randomUUID();
    this.proofs.set(ref, { id: ref, session, identity, aid: video.aid, cid: part.cid, positionSeconds: Math.floor(Math.max(...times)),
      expires: this.now() + Math.min(3600, Math.max(1, this.options.config().referenceTtlSeconds)) * 1000 });
    return ref;
  }
  /** Stable across prepared references and restarts; only validated sampling evidence defines the position. */
  automaticOperationId(watchRef: string, session: string, identity: string): string {
    this.sweep();
    const proof = this.proofs.get(watchRef), account = this.options.account();
    if (!proof || !account || proof.session !== session || proof.identity !== identity || identity !== this.options.identity())
      throw new BiliError('reference_unavailable');
    return 'auto-watch:' + hash([account.mid, session, proof.aid, proof.cid, proof.positionSeconds]);
  }
  private async save(required: boolean) {
    try { await this.options.saveLedger({ version: 1, entries: this.entries.map(e => ({ ...e })) }); }
    catch { this.initialized = false; if (required) throw new BiliError('persistence_error'); }
  }
  private outcome(entry: Entry, duplicate = false): HistoryOutcome {
    return { state: !entry.submitted ? 'already_recorded' : entry.state === 'pending' ? 'uncertain' : entry.state,
      positionSeconds: entry.positionSeconds, ...(duplicate ? { duplicate: true } : {}) };
  }
  private async record(entry: Entry, session: string, identity: string, options: CallOptions, result: HistoryOutcome) {
    if (entry.state !== 'verified' || !entry.submitted || !this.options.record) return result;
    result.experienceRecorded = false;
    try { this.check(identity, options); await this.options.record(session, 'bilibili-history:' + entry.fingerprint); result.experienceRecorded = true; }
    catch { /* A memory failure cannot erase or repeat the accepted platform write. */ }
    return result;
  }
  private async readback(entry: Entry, proof: Proof, session: string, options: CallOptions, identity: string, duplicate: boolean) {
    try {
      this.check(identity, options, proof);
      const progress = await this.client.historyProgress({ aid: proof.aid, cid: proof.cid }, options); this.check(identity, options, proof);
      if (progress.found && (progress.completed || (progress.progressSeconds !== null && progress.progressSeconds >= entry.positionSeconds))) {
        entry.state = 'verified'; await this.save(false);
      }
    } catch { /* POST acceptance and previous uncertainty survive readback failure or cancellation. */ }
    return this.record(entry, session, identity, options, this.outcome(entry, duplicate));
  }
  async mark(raw: Record<string, unknown>, session: string, options: CallOptions, identity: string): Promise<HistoryOutcome> {
    const args = object(raw);
    if (Object.keys(args).some(key => key !== 'watchRef' && key !== 'operationId')) throw new BiliError('invalid_input');
    const watchRef = text(args.watchRef), operationId = text(args.operationId);
    this.sweep(); this.check(identity, options);
    const proof = this.proofs.get(watchRef);
    if (!proof || proof.session !== session || proof.identity !== identity) throw new BiliError('reference_unavailable');
    if (!this.ready) throw new BiliError('persistence_error');
    const account = this.options.account()!;
    const key = hash([account.mid, session, operationId]), fingerprint = hash([account.mid, 'history', proof.aid, proof.cid, proof.positionSeconds]);
    const targetHash = hash([account.mid, proof.aid, proof.cid]);
    const keyed = this.entries.find(e => e.key === key);
    if (keyed && keyed.fingerprint !== fingerprint) throw new BiliError('invalid_input');
    let prior = keyed ?? this.entries.find(e => e.fingerprint === fingerprint && e.state !== 'rejected');
    if (!keyed && prior) {
      if (this.entries.length >= 4096) throw new BiliError('busy');
      prior = { ...prior, key };
      this.entries.push(prior); await this.save(true); this.check(identity, options, proof);
    }
    if (prior?.aliasOf) prior = this.entries.find(source => source.submitted && source.fingerprint === prior!.aliasOf)!;
    if (prior?.state === 'rejected') return this.outcome(prior, true);
    if (prior?.state === 'verified') return this.record(prior, session, identity, options, this.outcome(prior, true));
    if (!prior && this.entries.length >= 4096) throw new BiliError('busy');
    const verified = await this.client.account(options); this.check(identity, options, proof);
    if (verified.mid !== account.mid) throw new BiliError('account_changed');
    if (prior) return this.readback(prior, proof, session, options, identity, true);
    const progress = await this.client.historyProgress({ aid: proof.aid, cid: proof.cid }, options); this.check(identity, options, proof);
    if (progress.found && (progress.completed || (progress.progressSeconds !== null && progress.progressSeconds >= proof.positionSeconds))) {
      const entry: Entry = { key, fingerprint, targetHash, positionSeconds: proof.positionSeconds, state: 'verified', submitted: false };
      this.entries.push(entry); await this.save(true); this.check(identity, options, proof);
      return this.outcome(entry);
    }
    const higher = this.entries.find(e => e.targetHash === targetHash && e.submitted && e.state !== 'rejected' && e.positionSeconds >= proof.positionSeconds);
    if (higher) {
      this.entries.push({ key, fingerprint, targetHash, positionSeconds: proof.positionSeconds, state: higher.state, submitted: false, aliasOf: higher.fingerprint });
      await this.save(true); this.check(identity, options, proof);
      return this.outcome(higher, true);
    }
    const entry: Entry = { key, fingerprint, targetHash, positionSeconds: proof.positionSeconds, state: 'pending', submitted: true };
    this.entries.push(entry); await this.save(true);
    try { this.check(identity, options, proof); }
    catch (error) { entry.state = 'rejected'; await this.save(false); throw error; }
    try {
      const result = await this.client.reportHistoryPosition({ aid: proof.aid, cid: proof.cid, positionSeconds: proof.positionSeconds }, options);
      entry.state = result.state === 'accepted' ? 'accepted' : 'uncertain';
    } catch (error) {
      entry.state = error instanceof BiliError && ['login_required', 'access_blocked', 'platform_error', 'invalid_input'].includes(error.code) ? 'rejected' : 'uncertain';
    }
    await this.save(false);
    if (entry.state !== 'accepted') return this.outcome(entry);
    return this.readback(entry, proof, session, options, identity, false);
  }
  dispose() { this.stopped = true; this.clearProofs(); }
}
