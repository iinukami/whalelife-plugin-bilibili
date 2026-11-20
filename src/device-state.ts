/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { BiliError } from './errors.ts';
interface Entry { scope: string; buvid: string }
export function createDeviceStore(options: { read: () => Promise<unknown>; save: (value: unknown) => Promise<void>; signal?: AbortSignal }) {
  let entries: Entry[] | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  const check = () => { if (options.signal?.aborted) throw new BiliError('stopped'); };
  const validScope = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const validBuvid = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{8,200}$/.test(value);
  async function load(): Promise<Entry[]> {
    check(); if (entries) return entries;
    let value: any; try { value = await options.read(); } catch { throw new BiliError('persistence_error'); }
    check();
    if (value === undefined || value === null || typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return entries = [];
    if (typeof value !== 'object' || Array.isArray(value) || value.schema !== 1 || !Array.isArray(value.entries) || value.entries.length > 32) throw new BiliError('config_invalid');
    const scopes = new Set<string>();
    const next: Entry[] = value.entries.map((row: any) => {
      if (!row || !validScope(row.scope) || !validBuvid(row.buvid) || scopes.has(row.scope)) throw new BiliError('config_invalid');
      scopes.add(row.scope); return { scope: row.scope, buvid: row.buvid };
    });
    return entries = next;
  }
  function serial<T>(job: () => Promise<T>): Promise<T> { const next = tail.then(job); tail = next.catch(() => {}); return next; }
  return {
    read(scope: string): Promise<string | undefined> { return serial(async () => {
      if (!validScope(scope)) throw new BiliError('invalid_input');
      return (await load()).find(row => row.scope === scope)?.buvid;
    }); },
    save(scope: string, buvid: string): Promise<void> { return serial(async () => {
      if (!validScope(scope) || !validBuvid(buvid)) throw new BiliError('invalid_input');
      const current = await load(); check();
      const old = current.find(row => row.scope === scope);
      // A prepared account keeps one device; concurrent callers cannot silently replace it.
      if (old) { if (old.buvid !== buvid) throw new BiliError('config_conflict'); return; }
      const next = [...current.slice(-31), { scope, buvid }];
      try { await options.save({ schema: 1, entries: next }); } catch { throw new BiliError('persistence_error'); }
      check(); entries = next;
    }); },
    remove(scope: string): Promise<void> { return serial(async () => {
      if (!validScope(scope)) throw new BiliError('invalid_input');
      const current = await load(); check();
      const next = current.filter(row => row.scope !== scope);
      if (next.length === current.length) return;
      try { await options.save({ schema: 1, entries: next }); } catch { throw new BiliError('persistence_error'); }
      check(); entries = next;
    }); },
  };
}
