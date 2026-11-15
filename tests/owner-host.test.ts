/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HISTORY_HOST, MINIMUM_HOST, RAW_OWNER_NAME, SYNTHETIC_COOKIE, VIDEO_ID, hostFixture, until } from './host-fixture.ts';

const prefix = '/plugins/surf/bilibili', UID = '800000000003';
const deadline = { timeout: 40000 };

for (const baseline of [MINIMUM_HOST, HISTORY_HOST]) test('owner settings authenticate, persist and stay independent of login on ' + baseline.slice(0, 7), deadline, async t => {
  const f = await hostFixture(t, baseline), fixture = f.service('bilibili-test-fixture');
  assert.equal((await fetch(f.baseUrl + prefix + '/owner', { signal: AbortSignal.timeout(4000) })).status, 401);
  assert.equal((await fetch(f.baseUrl + prefix + '/owner', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uid: UID, revision: 'forged' }), signal: AbortSignal.timeout(4000) })).status, 401);
  const initial: any = await (await f.request(prefix + '/owner')).json();
  assert.equal(initial.ok, true); assert.equal(initial.owner, null); assert.equal(initial.invalidStoredState, false);
  assert.equal((await fixture.stats()).calls.length, 0, 'loading owner settings must not query the platform');
  assert.equal((await f.request(prefix + '/owner', { uid: UID, revision: initial.revision, name: 'Forged name' })).status, 400);
  assert.equal((await f.request(prefix + '/owner', { uid: '0', revision: initial.revision })).status, 400);
  assert.equal((await f.request(prefix + '/owner', { uid: UID, revision: 'stale' })).status, 409);
  assert.equal((await fixture.stats()).calls.length, 0);
  const updatedResponse = await f.request(prefix + '/owner', { uid: ' ' + UID + ' ', revision: initial.revision });
  assert.equal(updatedResponse.status, 200); const updated: any = await updatedResponse.json();
  assert.deepEqual(updated.owner, { uid: UID, name: RAW_OWNER_NAME, url: 'https://space.bilibili.com/' + UID });
  assert.notEqual(updated.revision, initial.revision);
  assert.deepEqual((await fixture.stats()).calls, ['ownerProfile']);
  assert.equal((await f.service().status()).ownerConfigured, true);
  const config: any = await (await f.request(prefix + '/config')).json();
  assert.equal(Object.hasOwn(config.config, 'owner'), false); assert.equal(Object.hasOwn(config.config, 'ownerUid'), false);
  assert.deepEqual(JSON.parse(await readFile(join(f.bilibili, 'data/owner.json'), 'utf8')), { owner: { uid: UID, name: RAW_OWNER_NAME } });
  assert.equal(f.names().includes('bilibili_owner'), baseline === HISTORY_HOST);
  if (baseline === HISTORY_HOST) {
    const tool = f.app.tools.entries.get('bilibili_owner'); assert.equal(tool.transientResult, true); assert.equal(tool.danger, 'safe');
    const read = await f.call('bilibili_owner'); assert.deepEqual(read.result.data.owner, updated.owner); assert.equal(read.result.data.untrusted, true);
    assert.equal((await f.call('bilibili_owner', { uid: '123' })).result.error.code, 'invalid_input');
    assert.deepEqual((await fixture.stats()).calls, ['ownerProfile'], 'the owner tool must use the saved identity without lookup');
  }
  const account: any = await (await f.request(prefix + '/state')).json();
  assert.equal((await f.request(prefix + '/login/import', { revision: account.account.revision, cookie: SYNTHETIC_COOKIE })).status, 200);
  assert.deepEqual((await (await f.request(prefix + '/owner')).json() as any).owner, updated.owner);
  await f.app.runtime.action('surf/bilibili', 'reload');
  await until(() => f.app.runtime.records.get('surf/bilibili').status === 'active', 'owner reload did not finish');
  const restored: any = await (await f.request(prefix + '/owner')).json();
  assert.deepEqual(restored.owner, updated.owner); assert.notEqual(restored.revision, updated.revision);
  assert.equal((await f.service('bilibili-test-fixture').stats()).calls.length, 0, 'reload restores private storage without platform lookup');
  assert.equal((await f.request(prefix + '/owner', { uid: '', revision: updated.revision })).status, 409);
  const cleared: any = await (await f.request(prefix + '/owner', { uid: '', revision: restored.revision })).json();
  assert.equal(cleared.owner, null); assert.deepEqual(JSON.parse(await readFile(join(f.bilibili, 'data/owner.json'), 'utf8')), { owner: null });
  assert.equal((await f.service('bilibili-test-fixture').stats()).calls.length, 0, 'clearing has no platform request');
  assert.equal(f.requests.length, 0); await f.assertPrivate([UID, RAW_OWNER_NAME]);
});

test('owner mentions cross the host boundary using only the saved identity and leave private data out of receipts', deadline, async t => {
  const f = await hostFixture(t, HISTORY_HOST), fixture = f.service('bilibili-test-fixture');
  const owner: any = await (await f.request(prefix + '/owner')).json();
  assert.equal((await f.request(prefix + '/owner', { uid: UID, revision: owner.revision })).status, 200);
  const account: any = await (await f.request(prefix + '/state')).json();
  assert.equal((await f.request(prefix + '/login/import', { revision: account.account.revision, cookie: SYNTHETIC_COOKIE })).status, 200);
  const config: any = await (await f.request(prefix + '/config')).json();
  assert.equal((await f.request(prefix + '/config', { revision: config.revision, config: { ...config.config,
    interactions: { ...config.config.interactions, comment: true, reply: true } } })).status, 200);
  const videoRef = (await f.call('bilibili_open', { target: VIDEO_ID })).result.data.videoRef;
  const schema = f.app.tools.entries.get('bilibili_interact').schema;
  assert.deepEqual(schema.properties.mentionOwner, { type: 'boolean' }); assert.equal(schema.additionalProperties, false);
  for (const field of ['ownerUid', 'uid', 'name', 'mentions', 'mentionUid', 'mentionName']) assert.equal(Object.hasOwn(schema.properties, field), false);
  const text = 'SYNTHETIC_OWNER_COMMENT_DO_NOT_PERSIST';
  const args = { action: 'comment', videoRef, operationId: 'synthetic-owner-comment', text, mentionOwner: true };
  assert.equal((await f.app.tools.call('bilibili_interact', args, { id: f.sessionId, permission: 'ask' })).ok, false);
  assert.equal((await fixture.stats()).ownerSubmissions.length, 0);
  for (const invalid of [{ ...args, uid: '123' }, { ...args, mentionOwner: { uid: '123', name: 'Forged' } }, { ...args, text: '@Forged ' + text }]) {
    const result = await f.call('bilibili_interact', invalid); assert.equal(result.result.status, 'error');
  }
  assert.equal((await fixture.stats()).ownerSubmissions.length, 0);
  const sent = await f.call('bilibili_interact', args); assert.equal(sent.result.data.state, 'confirmed');
  assert.deepEqual((await fixture.stats()).ownerSubmissions, [{ action: 'comment', text, mentionOwner: { uid: UID, name: RAW_OWNER_NAME } }]);
  assert.equal((await f.call('bilibili_interact', args)).result.data.duplicate, true); assert.equal((await fixture.stats()).ownerSubmissions.length, 1);
  const comments = await f.call('bilibili_comments', { videoRef });
  const replyText = 'SYNTHETIC_OWNER_REPLY_DO_NOT_PERSIST';
  const reply = await f.call('bilibili_interact', { action: 'reply', commentRef: comments.result.data.items[0].commentRef,
    operationId: 'synthetic-owner-reply', text: replyText, mentionOwner: true });
  assert.equal(reply.result.data.state, 'confirmed');
  assert.deepEqual((await fixture.stats()).ownerSubmissions[1], { action: 'reply', text: replyText, mentionOwner: { uid: UID, name: RAW_OWNER_NAME } });
  const current: any = await (await f.request(prefix + '/owner')).json();
  assert.equal((await f.request(prefix + '/owner', { uid: '', revision: current.revision })).status, 200);
  assert.equal((await f.call('bilibili_interact', { ...args, operationId: 'after-clear' })).result.error.code, 'owner_required');
  assert.equal((await fixture.stats()).ownerSubmissions.length, 2);
  assert.equal(f.requests.length, 0);
  const ledger = await readFile(join(f.bilibili, 'data/actions.json'), 'utf8');
  for (const privateValue of [UID, RAW_OWNER_NAME, text, replyText]) assert.ok(!ledger.includes(privateValue));
  await f.assertPrivate([UID, RAW_OWNER_NAME, text, replyText]);
});
