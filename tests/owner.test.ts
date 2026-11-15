/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OwnerManager, validateOwnerProfile, validateOwnerUid } from '../src/owner.ts';
import { BiliError } from '../src/errors.ts';
import type { AccountState, CallOptions, OwnerProfile } from '../src/types.ts';

const OWNER = { uid: '12345', name: 'Synthetic Owner' };
const COOKIE = 'SYNTHETIC_OWNER_LOOKUP_COOKIE';
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const code = (expected: string) => (error: unknown) => error instanceof BiliError && error.code === expected;
function fixture(initial: unknown = {}) {
  let stored = initial, account: AccountState | undefined = { mid: 7, name: 'Synthetic Login', cookie: COOKIE, revision: 'account-1' }, revision = 'account-1';
  let readHook = async () => structuredClone(stored), saveHook = async (_value: unknown) => {};
  let profileHook = async (uid: string, _options: CallOptions): Promise<OwnerProfile> => ({ uid, name: OWNER.name });
  const requests: { uid: string; options: CallOptions }[] = [], writes: unknown[] = [], controller = new AbortController();
  const client = { async ownerProfile(uid: string, options: CallOptions) { requests.push({ uid, options }); return profileHook(uid, options); } };
  const storage = { read: () => readHook(), async save(value: unknown) { await saveHook(value); stored = structuredClone(value); writes.push(structuredClone(value)); } };
  const create = () => new OwnerManager(client, storage, controller.signal, () => account, () => revision);
  const owner = create();
  return { owner, create, client, storage, requests, writes, controller, stored: () => structuredClone(stored),
    read: (fn: typeof readHook) => { readHook = fn; }, save: (fn: typeof saveHook) => { saveHook = fn; }, profile: (fn: typeof profileHook) => { profileHook = fn; },
    changeAccount: () => { revision = 'account-2'; account = { ...account!, mid: 8, revision }; },
    logout: () => { revision = 'logged-out'; account = undefined; },
  };
}

test('owner UID and platform profile validation rejects hostile identities without rewriting names', () => {
  for (const uid of [0, 123, null, undefined, {}, '', '0', '01', '-1', '1.2', '1e3', '+1', '9007199254740992', '１', '123@45', '1\0']) {
    assert.throws(() => validateOwnerUid(uid), code('invalid_input'));
  }
  assert.equal(validateOwnerUid(' 12345 '), '12345');
  assert.equal(validateOwnerUid('9007199254740991'), '9007199254740991');
  const exact = '  Synthetic <b>昵称</b> 😀  ';
  assert.deepEqual(validateOwnerProfile({ uid: '12345', name: exact, sign: 'SYNTHETIC_PRIVATE_BIO' }, '12345'), { uid: '12345', name: exact });
  for (const profile of [null, [], { uid: 12345, name: 'Name' }, { uid: ' 12345 ', name: 'Name' }, { uid: '2', name: 'Name' },
    ...['', ' \t ', 'a\nb', 'a\u007fb', 'a\u0085b', '@owner', 'a\u202eb', '\ud800', '😀'.repeat(81)].map(name => ({ uid: '12345', name }))]) {
    assert.throws(() => validateOwnerProfile(profile, '12345'), code('malformed_response'));
  }
  assert.equal(validateOwnerProfile({ uid: '12345', name: '😀'.repeat(80) }).name.length, 160);
});

test('owner is verified once, stored separately, copied on reads and restored with a new UI revision', async t => {
  const f = fixture(); t.after(() => f.owner.dispose()); await f.owner.ready;
  const previous = f.owner.identity();
  assert.deepEqual(f.owner.state(), { owner: null, revision: previous, invalidStoredState: false });
  const state = await f.owner.set(' 12345 ', previous);
  assert.deepEqual(state.owner, { ...OWNER, url: 'https://space.bilibili.com/12345' });
  assert.notEqual(state.revision, previous); assert.equal(f.owner.identity(), state.revision);
  assert.deepEqual(f.stored(), { owner: OWNER }); assert.deepEqual(f.writes, [{ owner: OWNER }]);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].options.cookie, COOKIE); assert.equal(f.requests[0].options.timeoutMs, 20000);
  f.owner.snapshot()!.name = 'Mutated'; state.owner!.name = 'Also mutated';
  assert.deepEqual(f.owner.snapshot(), OWNER);
  const restored = f.create(); t.after(() => restored.dispose()); await restored.ready;
  assert.deepEqual(restored.snapshot(), OWNER); assert.notEqual(restored.identity(), f.owner.identity());
  assert.equal(f.requests.length, 1, 'startup and status do not refresh or query the platform');
  await assert.rejects(restored.set('67890', f.owner.identity()), code('config_conflict'));
  const cleared = await restored.set(' ', restored.identity());
  assert.equal(cleared.owner, null); assert.deepEqual(f.stored(), { owner: null }); assert.equal(f.requests.length, 1);
  assert.ok(!JSON.stringify(f.stored()).includes(COOKIE));
});

test('anonymous owner lookup is allowed and changing login later does not clear the saved owner', async t => {
  const f = fixture(); t.after(() => f.owner.dispose()); await f.owner.ready;
  f.logout(); await f.owner.set(OWNER.uid, f.owner.identity());
  assert.equal(f.requests[0].options.cookie, undefined);
  f.changeAccount(); assert.deepEqual(f.owner.snapshot(), OWNER);
});

test('bad or unreadable stored owner state fails closed and can be explicitly replaced', async t => {
  for (const stored of [{ owner: { uid: '0', name: 'Name' } }, { owner: { uid: '1', name: '@Name' } }, [], 'bad', { unexpected: true }, { owner: null, cookie: COOKIE }]) {
    const f = fixture(stored); t.after(() => f.owner.dispose()); await f.owner.ready;
    assert.equal(f.owner.snapshot(), undefined); assert.equal(f.owner.state().invalidStoredState, true);
    assert.equal(f.requests.length, 0); await f.owner.set(OWNER.uid, f.owner.identity());
    assert.equal(f.owner.state().invalidStoredState, false); assert.deepEqual(f.stored(), { owner: OWNER });
  }
  const f = fixture(); f.read(async () => { throw Error('SYNTHETIC_READ_SECRET'); }); t.after(() => f.owner.dispose());
  await f.owner.ready; assert.equal(f.owner.state().invalidStoredState, true);
  await f.owner.set('', f.owner.identity()); assert.equal(f.owner.state().invalidStoredState, false);
});

test('bad inputs and mismatched or malicious profiles never reach persistent storage', async t => {
  const f = fixture({ owner: OWNER }); t.after(() => f.owner.dispose()); await f.owner.ready;
  const revision = f.owner.identity();
  for (const uid of [undefined, 3, '01', '-1', '9007199254740992']) await assert.rejects(f.owner.set(uid, revision), code('invalid_input'));
  for (const expected of [undefined, null, '', 'stale']) await assert.rejects(f.owner.set('67890', expected), code('config_conflict'));
  assert.equal(f.requests.length, 0);
  for (const profile of [{ uid: '111', name: 'Name' }, { uid: '67890', name: '@Name' }, { uid: '67890', name: ' ' }]) {
    f.profile(async () => profile); await assert.rejects(f.owner.set('67890', revision), code('malformed_response'));
  }
  f.profile(async () => { throw Error('SYNTHETIC_PRIVATE_ERROR'); });
  await assert.rejects(f.owner.set('67890', revision), code('network_error'));
  assert.deepEqual(f.owner.snapshot(), OWNER); assert.equal(f.owner.identity(), revision); assert.equal(f.writes.length, 0);
});

test('simultaneous updates are serialized and a stale UI revision never sends a second lookup', async t => {
  const f = fixture(); t.after(() => f.owner.dispose()); await f.owner.ready;
  const pending = deferred<OwnerProfile>(), entered = deferred<void>();
  f.profile(async () => { entered.resolve(); return pending.promise; });
  const revision = f.owner.identity(), first = f.owner.set(OWNER.uid, revision);
  const second = assert.rejects(f.owner.set('67890', revision), code('config_conflict'));
  await entered.promise; assert.equal(f.requests.length, 1);
  pending.resolve(OWNER); await first; await second;
  assert.equal(f.requests.length, 1); assert.equal(f.writes.length, 1); assert.deepEqual(f.owner.snapshot(), OWNER);
});

test('account changes and cancellation around lookup block any new persistent write', async t => {
  for (const boundary of ['before', 'during', 'cancel']) {
    const f = fixture({ owner: OWNER }); t.after(() => f.owner.dispose()); await f.owner.ready;
    const pending = deferred<OwnerProfile>(), entered = deferred<void>(), request = new AbortController(), revision = f.owner.identity();
    f.profile(async () => { entered.resolve(); return pending.promise; });
    const update = f.owner.set('67890', revision, request.signal);
    const failure = assert.rejects(update, code(boundary === 'cancel' ? 'cancelled' : 'account_changed'));
    if (boundary !== 'before') await entered.promise;
    if (boundary === 'cancel') request.abort(); else f.changeAccount();
    pending.resolve({ uid: '67890', name: 'New owner' }); await failure;
    assert.equal(f.writes.length, 0); assert.deepEqual(f.owner.snapshot(), OWNER); assert.equal(f.owner.identity(), revision);
    if (boundary === 'before') assert.equal(f.requests.length, 0);
  }
});

test('query timeout is bounded even when a client ignores cancellation and does not retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); t.after(() => f.owner.dispose()); await f.owner.ready;
  const entered = deferred<void>(); f.profile(async () => { entered.resolve(); return new Promise(() => {}); });
  const failure = assert.rejects(f.owner.set(OWNER.uid, f.owner.identity()), code('timeout'));
  await entered.promise; t.mock.timers.tick(20000); await failure;
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].options.signal?.aborted, true); assert.equal(f.writes.length, 0);
});

test('storage failure preserves previous owner and revision; a successful in-flight save is reflected after cancellation', async t => {
  const f = fixture({ owner: OWNER }); t.after(() => f.owner.dispose()); await f.owner.ready;
  const revision = f.owner.identity(); f.save(async () => { throw Error('SYNTHETIC_SAVE_SECRET'); });
  await assert.rejects(f.owner.set('67890', revision), code('persistence_error'));
  assert.deepEqual(f.owner.snapshot(), OWNER); assert.equal(f.owner.identity(), revision);
  const entered = deferred<void>(), pending = deferred<void>(), request = new AbortController();
  f.save(async () => { entered.resolve(); await pending.promise; });
  const failure = assert.rejects(f.owner.set('67890', revision, request.signal), code('cancelled'));
  await entered.promise; request.abort(); await failure;
  pending.resolve(); await tick();
  assert.deepEqual(f.owner.snapshot(), { uid: '67890', name: OWNER.name });
  assert.deepEqual(f.stored(), { owner: { uid: '67890', name: OWNER.name } });
  assert.notEqual(f.owner.identity(), revision);
});

test('dispose cancels uncooperative lookup and a delayed initial read cannot revive the manager', async () => {
  const f = fixture(); await f.owner.ready;
  const entered = deferred<void>(); f.profile(async () => { entered.resolve(); return new Promise(() => {}); });
  const failure = assert.rejects(f.owner.set(OWNER.uid, f.owner.identity()), code('stopped'));
  await entered.promise; await f.owner.dispose(); await failure;
  assert.equal(f.requests[0].options.signal?.aborted, true); assert.equal(f.writes.length, 0);
  await assert.rejects(f.owner.set(OWNER.uid, f.owner.identity()), code('stopped'));
  const g = fixture(), pending = deferred<unknown>(); g.read(() => pending.promise);
  await g.owner.dispose(); pending.resolve({ owner: OWNER }); await g.owner.ready; await tick();
  assert.equal(g.owner.snapshot(), undefined); assert.equal(g.owner.state().invalidStoredState, false);
});

test('dispose is bounded while an already-started storage write is stalled', async () => {
  const f = fixture(); await f.owner.ready;
  const entered = deferred<void>(), pending = deferred<void>(); f.save(async () => { entered.resolve(); await pending.promise; });
  const failure = assert.rejects(f.owner.set(OWNER.uid, f.owner.identity()), code('stopped'));
  await entered.promise; const start = Date.now(); await f.owner.dispose(); await failure;
  assert.ok(Date.now() - start < 1000);
  pending.resolve(); await tick();
  assert.deepEqual(f.owner.snapshot(), OWNER); assert.deepEqual(f.stored(), { owner: OWNER });
});
