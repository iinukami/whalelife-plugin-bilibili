/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { Action, Config } from './types.ts';
import { BiliError } from './errors.ts';

export const actions: readonly Action[] = ['like', 'favorite', 'follow', 'comment', 'reply'];
export const defaults: Config = {
  audioEnabled: false,
  historySyncEnabled: false,
  danmakuEnabled: false, autoRefreshEnabled: false,
  interactions: { like: false, favorite: false, follow: false, comment: false, reply: false },
  favoriteFolderId: '', maxMediaBytes: 64 * 1024 * 1024, referenceTtlSeconds: 600,
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BiliError('config_invalid');
  return value as Record<string, unknown>;
}
function bounded(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new BiliError('config_invalid');
  return value;
}
export function updateConfig(value: unknown, current: Config): Config {
  const input = record(value);
  const allowed = new Set(['audioEnabled', 'historySyncEnabled', 'danmakuEnabled', 'autoRefreshEnabled', 'interactions', 'favoriteFolderId', 'maxMediaBytes', 'referenceTtlSeconds']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new BiliError('config_invalid');
  const next: Config = { ...current, interactions: { ...current.interactions } };
  for (const key of ['danmakuEnabled', 'autoRefreshEnabled'] as const) if (Object.hasOwn(input, key)) {
    if (typeof input[key] !== 'boolean') throw new BiliError('config_invalid'); next[key] = input[key];
  }
  if (Object.hasOwn(input, 'audioEnabled')) {
    if (typeof input.audioEnabled !== 'boolean') throw new BiliError('config_invalid');
    next.audioEnabled = input.audioEnabled;
  }
  if (Object.hasOwn(input, 'historySyncEnabled')) {
    if (typeof input.historySyncEnabled !== 'boolean') throw new BiliError('config_invalid');
    next.historySyncEnabled = input.historySyncEnabled;
  }
  if (Object.hasOwn(input, 'interactions')) {
    const switches = record(input.interactions);
    for (const key of Object.keys(switches)) {
      if (!actions.includes(key as Action) || typeof switches[key] !== 'boolean') throw new BiliError('config_invalid');
      next.interactions[key as Action] = switches[key] as boolean;
    }
  }
  if (Object.hasOwn(input, 'favoriteFolderId')) {
    if (typeof input.favoriteFolderId !== 'string' || (input.favoriteFolderId !== '' && !/^[1-9]\d{0,18}$/.test(input.favoriteFolderId))) throw new BiliError('config_invalid');
    next.favoriteFolderId = input.favoriteFolderId;
  }
  if (Object.hasOwn(input, 'maxMediaBytes')) next.maxMediaBytes = bounded(input.maxMediaBytes, 1024 * 1024, 64 * 1024 * 1024);
  if (Object.hasOwn(input, 'referenceTtlSeconds')) next.referenceTtlSeconds = bounded(input.referenceTtlSeconds, 30, 1800);
  return next;
}
export function parseConfig(value: unknown): Config {
  const input = record(value === undefined ? {} : value);
  if (!Object.hasOwn(input, 'interactions')) return updateConfig(input, defaults);
  // Ignore the removed option when loading old settings; new updates still reject it.
  const interactions = { ...record(input.interactions) };
  delete interactions.coin;
  return updateConfig({ ...input, interactions }, defaults);
}
