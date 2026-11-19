/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceStore } from '../src/device-state.ts';
const A = 'a'.repeat(64), B = 'b'.repeat(64);
test('persisted devices survive reload and stay isolated by account scope', async () => {
  let saved: unknown = {};
  const store = () => createDeviceStore({ read: async () => structuredClone(saved), save: async value => { saved = structuredClone(value); } });
  const first = store(); await Promise.all([first.save(A, 'synthetic-device-A'), first.save(B, 'synthetic-device-B')]);
  const second = store(); assert.equal(await second.read(A), 'synthetic-device-A'); assert.equal(await second.read(B), 'synthetic-device-B');
  await assert.rejects(second.save(A, 'replacement-device'), { code: 'config_conflict' });
  assert.equal(await second.read(A), 'synthetic-device-A');
});
test('device persistence fails closed and never publishes a failed write to readers', async () => {
  const store = createDeviceStore({ read: async () => ({}), save: async () => { throw Error('private storage detail'); } });
  await assert.rejects(store.save(A, 'synthetic-device-A'), { code: 'persistence_error' });
  assert.equal(await store.read(A), undefined);
  const corrupt = createDeviceStore({ read: async () => ({ schema: 1, entries: [{ scope: A, buvid: 'bad;cookie' }] }), save: async () => {} });
  await assert.rejects(corrupt.read(A), { code: 'config_invalid' });
});
test('stopping during a device load prevents a late save', async () => {
  const abort = new AbortController(); let writes = 0;
  const store = createDeviceStore({ read: async () => { abort.abort(); return {}; }, save: async () => { writes++; }, signal: abort.signal });
  await assert.rejects(store.save(A, 'synthetic-device-A'), { code: 'stopped' }); assert.equal(writes, 0);
});
