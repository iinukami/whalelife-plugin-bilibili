/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CURRENT_HOST, MINIMUM_HOST, RAW_TITLE, RAW_DESCRIPTION, RAW_COMMENT, RAW_SUBTITLE, RAW_AUDIO,
  RAW_NOTIFICATION_REPLY, RAW_NOTIFICATION_LIKE, PRIVATE_NOTIFICATION_CURSOR,
  PRIVATE_QUERY, ERROR_SECRET, PRIVATE_MEDIA_REF, SYNTHETIC_COOKIE, VIDEO_ID, VIDEO_URL, hostFixture, installVision, until, diskText } from './host-fixture.ts';

const deadline = { timeout: 40000 };
const prefix = '/plugins/surf/bilibili';
const callSpec = (name: string, args: unknown = {}) => ({ id: 'synthetic-' + name, name, arguments: JSON.stringify(args) });
const readTools = ['bilibili_browse', 'bilibili_search', 'bilibili_open', 'bilibili_comments', 'bilibili_subtitles', 'bilibili_notifications'];

for (const baseline of [CURRENT_HOST, MINIMUM_HOST]) {
  test(`isolated host ${baseline}: dependency, settings authentication and explicit compatibility`, deadline, async t => {
    const f = await hostFixture(t, baseline), current = baseline === CURRENT_HOST;
    const parent = f.app.runtime.records.get('surf'), child = f.app.runtime.records.get('surf/bilibili');
    assert.notEqual(parent.execution.pid, child.execution.pid);
    assert.equal(child.manifest.depends.includes('surf'), true);
    assert.ok(f.names().includes('bilibili_status'));
    for (const name of readTools) assert.equal(f.names().includes(name), current, name);
    assert.equal(f.names().includes('bilibili_watch'), false);
    const status = await f.service().status();
    assert.equal(status.ready, current);
    assert.equal(status.audioEnabled, false);
    for (const enabled of Object.values(status.interactions)) assert.equal(enabled, false);
    for (const path of ['/config', '/state', '/settings']) {
      assert.equal((await fetch(f.baseUrl + prefix + path, { signal: AbortSignal.timeout(4000) })).status, 401);
      assert.equal((await f.request(prefix + path)).status, 200);
    }
    assert.equal((await f.service('bilibili-test-fixture').stats()).calls.length, 0, 'loading/settings cannot access Bilibili');
    const state: any = await (await f.request(prefix + '/config')).json();
    const changed = await f.request(prefix + '/config', { revision: state.revision, config: { ...state.config, audioEnabled: true } });
    assert.equal(changed.status, 200, await changed.text());
    const conflict = await f.request(prefix + '/config', { revision: state.revision, config: state.config });
    assert.equal(conflict.status, 409);
    const publicState: any = await (await f.request(prefix + '/state')).json();
    assert.equal(Object.hasOwn(publicState, 'cookie'), false);
    assert.equal(Object.hasOwn(publicState.account ?? {}, 'cookie'), false);
    if (current) for (const name of readTools) assert.equal(f.app.tools.entries.get(name).transientResult, true);
    else {
      await installVision(f);
      assert.equal(f.names().includes('bilibili_watch'), false, 'old host cannot expose media as persistent JSON');
      assert.equal(f.app.runtime.records.get('surf/bilibili').status, 'active');
    }
    assert.equal(f.requests.length, 0, 'startup/status/settings cannot invoke a model');
    await f.assertPrivate();
  });
}

test('four entry points, comments, subtitles and trusted references cross the isolated process boundary', deadline, async t => {
  const f = await hostFixture(t);
  const recommended = await f.call('bilibili_browse', { source: 'recommended' });
  assert.equal(recommended.result.status, 'ok');
  assert.equal(recommended.result.data.items[0].title, RAW_TITLE);
  assert.equal(recommended.result.data.untrusted, true);
  const following = await f.call('bilibili_browse', { source: 'following' });
  assert.equal(following.result.error.code, 'login_required', 'an unauthenticated following feed must not pretend to be empty');
  const search = await f.call('bilibili_search', { query: PRIVATE_QUERY });
  assert.equal(search.result.status, 'ok');
  const opened = await f.call('bilibili_open', { target: VIDEO_URL });
  assert.equal(opened.result.data.description, RAW_DESCRIPTION);
  const videoRef = opened.result.data.videoRef;
  const comments = await f.call('bilibili_comments', { videoRef });
  assert.equal(comments.result.data.items[0].text, RAW_COMMENT);
  assert.equal(comments.result.data.items[0].rpid, '90071992547409930');
  const subtitles = await f.call('bilibili_subtitles', { videoRef });
  assert.equal(subtitles.result.data.cues[0].text, RAW_SUBTITLE);
  const other = await f.app.sessions.create('Synthetic unrelated session');
  const wrong = await f.call('bilibili_comments', { videoRef, sessionId: f.sessionId }, other);
  assert.equal(wrong.result.error.code, 'reference_unavailable', 'a model supplied sessionId cannot override trusted ToolSession');
  const interaction = await f.call('bilibili_interact', { action: 'like', videoRef, operationId: 'synthetic-op' });
  assert.equal(interaction.result.error.code, 'interaction_disabled');
  assert.ok(!(await f.service('bilibili-test-fixture').stats()).calls.includes('interact'));
  await f.service('bilibili-test-fixture').advance(86400000);
  assert.equal((await f.call('bilibili_comments', { videoRef })).result.error.code, 'reference_unavailable');
  const error = await f.call('bilibili_search', { query: 'error' });
  assert.equal(error.result.error.code, 'network_error');
  assert.ok(!JSON.stringify(error).includes(ERROR_SECRET));
  const pluginData = await diskText(join(f.bilibili, 'data'));
  for (const marker of [RAW_TITLE, RAW_DESCRIPTION, RAW_COMMENT, RAW_SUBTITLE, PRIVATE_QUERY, videoRef]) assert.ok(!pluginData.includes(marker));
  assert.equal(f.requests.length, 0);
  await f.assertPrivate([videoRef, comments.result.data.items[0].commentRef]);
});

test('temporary platform content reaches only this model turn; ordinary final conversation survives', deadline, async t => {
  const f = await hostFixture(t);
  const initial: any = await (await f.request(prefix + '/state')).json();
  assert.equal((await f.request(prefix + '/login/import', { revision: initial.account.revision, cookie: SYNTHETIC_COOKIE })).status, 200);
  await f.plugin('conversation-fixture', `export function apply(ctx) {
    ctx.tools.register({name:'bilibili_fixture_echo',description:'Synthetic echo',danger:'safe',schema:{text:{type:'string'}},run:args=>args});
    ctx.provide('conversation-fixture',{run:input=>ctx.sessions.run(input),transient:input=>ctx.sessions.runTransient(input)});
  }`);
  await f.load('conversation-fixture');
  let round = 0;
  const visible = '已经找到视频。你还想继续看吗？SYNTHETIC_BILI_VISIBLE_REPLY';
  f.model(request => {
    round++;
    if (round === 1) return { text: '', toolCalls: [callSpec('bilibili_open', { target: VIDEO_ID }), callSpec('bilibili_notifications', { source: 'replies' })] };
    if (round === 2) {
      assert.ok(JSON.stringify(request.messages).includes(RAW_DESCRIPTION));
      assert.ok(JSON.stringify(request.messages).includes(RAW_NOTIFICATION_REPLY));
      return { text: '', toolCalls: [callSpec('bilibili_fixture_echo', { text: RAW_DESCRIPTION + RAW_NOTIFICATION_REPLY })] };
    }
    return { text: visible, toolCalls: [] };
  });
  assert.equal(await f.service('conversation-fixture').run({ sessionId: f.sessionId, text: '请看这个视频', persona: 'a', permission: 'full' }), visible);
  assert.equal(round, 3);
  assert.equal((await f.app.memory.readSession(f.sessionId)).at(-1).text, visible);
  f.model(request => {
    const serialized = JSON.stringify(request.messages);
    assert.ok(serialized.includes(visible));
    for (const marker of [RAW_TITLE, RAW_DESCRIPTION, RAW_NOTIFICATION_REPLY, RAW_NOTIFICATION_LIKE, PRIVATE_QUERY]) assert.ok(!serialized.includes(marker));
    return { text: '继续看你选的视频。', toolCalls: [] };
  });
  await f.service('conversation-fixture').run({ sessionId: f.sessionId, text: '继续', persona: 'a', permission: 'full' });
  let technical = 0;
  f.model(() => ++technical === 1 ? { text: '', toolCalls: [callSpec('bilibili_search', { query: PRIVATE_QUERY })] }
    : { text: RAW_TITLE, toolCalls: [] });
  assert.equal(await f.service('conversation-fixture').transient({ sessionId: f.sessionId, text: 'Synthetic technical read', persona: 'a', permission: 'full' }), RAW_TITLE);
  await f.assertPrivate();
});

test('notifications are demand-driven logged-in reads with private source-bound cursors and no interaction or model calls', deadline, async t => {
  const f = await hostFixture(t);
  const stats = () => f.service('bilibili-test-fixture').stats();
  const notificationCalls = async () => (await stats()).calls.filter((name: string) => name.startsWith('notifications:')).length;
  const tool = f.app.tools.entries.get('bilibili_notifications');
  assert.equal(tool.danger, 'safe'); assert.equal(tool.transientResult, true);
  assert.equal((await stats()).calls.length, 0, 'loading must not poll notifications');
  for (const source of ['replies', 'likes']) {
    assert.equal((await f.call('bilibili_notifications', { source })).result.error.code, 'login_required');
  }
  assert.equal(await notificationCalls(), 0, 'anonymous reads must fail before invoking the platform adapter');
  const initial: any = await (await f.request(prefix + '/state')).json();
  const imported = await f.request(prefix + '/login/import', { revision: initial.account.revision, cookie: SYNTHETIC_COOKIE });
  assert.equal(imported.status, 200);
  const account: any = (await imported.json()).account;
  assert.equal(await notificationCalls(), 0, 'login must not start notification polling');
  const status = await f.service().status();
  assert.equal(Object.values(status.interactions).every(enabled => enabled === false), true);

  const replies = await f.call('bilibili_notifications', { source: 'replies' });
  assert.equal(replies.result.status, 'ok'); assert.equal(replies.result.data.untrusted, true);
  assert.equal(replies.result.data.items[0].text, RAW_NOTIFICATION_REPLY);
  assert.equal(Object.hasOwn(replies.result.data.items[0], 'commentRef'), false);
  const replyCursor = replies.result.data.cursor;
  assert.equal(typeof replyCursor, 'string'); assert.ok(replyCursor.length > 0);
  assert.ok(!JSON.stringify(replies.result).includes(PRIVATE_NOTIFICATION_CURSOR));
  const beforeInvalid = await notificationCalls();
  const other = await f.app.sessions.create('Synthetic other notifications session');
  assert.equal((await f.call('bilibili_notifications', { source: 'replies', cursor: replyCursor, sessionId: f.sessionId }, other)).result.error.code, 'reference_unavailable');
  assert.equal((await f.call('bilibili_notifications', { source: 'likes', cursor: replyCursor })).result.error.code, 'reference_unavailable');
  assert.equal(await notificationCalls(), beforeInvalid);
  const next = await f.call('bilibili_notifications', { source: 'replies', cursor: replyCursor });
  assert.equal(next.result.status, 'ok'); assert.equal(next.result.data.hasMore, false);
  const likes = await f.call('bilibili_notifications', { source: 'likes' });
  assert.equal(likes.result.status, 'ok'); assert.equal(likes.result.data.items[0].text, RAW_NOTIFICATION_LIKE);
  assert.equal(likes.result.data.items[0].likeCount, 2);
  const likeCursor = likes.result.data.cursor;
  await f.service('bilibili-test-fixture').advance(86400000);
  const beforeExpiry = await notificationCalls();
  assert.equal((await f.call('bilibili_notifications', { source: 'likes', cursor: likeCursor })).result.error.code, 'reference_unavailable');
  assert.equal(await notificationCalls(), beforeExpiry);

  const fresh = await f.call('bilibili_notifications', { source: 'replies' });
  const freshCursor = fresh.result.data.cursor;
  assert.equal((await f.request(prefix + '/login/import', { revision: account.revision, cookie: SYNTHETIC_COOKIE })).status, 200);
  const beforeAccountChange = await notificationCalls();
  assert.equal((await f.call('bilibili_notifications', { source: 'replies', cursor: freshCursor })).result.error.code, 'reference_unavailable');
  assert.equal(await notificationCalls(), beforeAccountChange);
  const calls = (await stats()).calls;
  assert.equal(calls.includes('interact'), false); assert.equal(calls.includes('beginLogin'), false);
  assert.equal(f.requests.length, 0, 'notification reads must not invoke a model');
  const pluginData = await diskText(join(f.bilibili, 'data'));
  for (const marker of [RAW_NOTIFICATION_REPLY, RAW_NOTIFICATION_LIKE, PRIVATE_NOTIFICATION_CURSOR, replyCursor, likeCursor, freshCursor]) assert.ok(!pluginData.includes(marker));
  await f.assertPrivate([replyCursor, likeCursor, freshCursor]);
});

test('synthetic cookie import enables following, redacts credentials and invalidates references on identity changes', deadline, async t => {
  const f = await hostFixture(t);
  const anonymous = await f.call('bilibili_open', { target: VIDEO_ID });
  const initial: any = await (await f.request(prefix + '/state')).json();
  assert.equal(initial.account.loggedIn, false);
  const imported = await f.request(prefix + '/login/import', { revision: initial.account.revision, cookie: SYNTHETIC_COOKIE });
  assert.equal(imported.status, 200);
  const receipt: any = await imported.json();
  assert.equal(receipt.account.loggedIn, true);
  assert.equal(receipt.account.mid, 4321);
  assert.ok(!JSON.stringify(receipt).includes('SYNTHETIC_BILI_SESSION_SECRET'));
  const stale = await f.call('bilibili_comments', { videoRef: anonymous.result.data.videoRef });
  assert.equal(stale.result.error.code, 'reference_unavailable');
  const following = await f.call('bilibili_browse', { source: 'following' });
  assert.equal(following.result.status, 'ok');
  assert.equal(following.result.data.items[0].title, RAW_TITLE);
  const videoRef = following.result.data.items[0].videoRef;
  const state: any = await (await f.request(prefix + '/state')).json();
  assert.equal(state.account.loggedIn, true);
  assert.equal(Object.hasOwn(state.account, 'cookie'), false);
  assert.equal((await f.request(prefix + '/login/logout', { revision: initial.account.revision })).status, 409);
  assert.equal((await f.request(prefix + '/login/logout', { revision: state.account.revision })).status, 200);
  assert.equal((await f.call('bilibili_comments', { videoRef })).result.error.code, 'reference_unavailable');
  assert.equal((await f.call('bilibili_browse', { source: 'following' })).result.error.code, 'login_required');
  const login = await f.request(prefix + '/login/start', {});
  assert.equal(login.status, 200);
  const qr: any = await login.json();
  assert.match(qr.qrDataUrl, /^data:image\/png;base64,/);
  assert.equal(Object.hasOwn(qr, 'key'), false);
  const poll: any = await (await f.request(prefix + '/login/poll', { id: qr.id })).json();
  assert.equal(poll.state, 'waiting');
  assert.ok(!JSON.stringify(poll).includes('synthetic-qr-key'));
  assert.equal(f.requests.length, 0);
  await f.assertPrivate([anonymous.result.data.videoRef, videoRef, 'synthetic-qr-key']);
});

test('enabled interactions require full permission, deduplicate submissions and record one safe experience in the trusted session', deadline, async t => {
  const f = await hostFixture(t);
  const ownComment = 'SYNTHETIC_BILI_OWN_COMMENT_TEXT_DO_NOT_PERSIST';
  const initial: any = await (await f.request(prefix + '/state')).json();
  assert.equal((await f.request(prefix + '/login/import', { revision: initial.account.revision, cookie: SYNTHETIC_COOKIE })).status, 200);
  const opened = await f.call('bilibili_open', { target: VIDEO_ID });
  const videoRef = opened.result.data.videoRef;
  const other = await f.app.sessions.create('Synthetic unrelated interaction session');
  const args = { action: 'comment', videoRef, operationId: 'synthetic-comment-operation', text: ownComment, sessionId: other };
  const tool = f.app.tools.entries.get('bilibili_interact');
  assert.equal(tool.danger, 'full');
  assert.equal(tool.transientResult, true);
  const submitted = async () => (await f.service('bilibili-test-fixture').stats()).calls.filter((name: string) => name === 'interact').length;
  const experiences = async (id = f.sessionId) => (await f.app.memoryEngine.inspect(id)).items
    .filter((record: any) => record.source === 'surf/bilibili' && record.origin?.platform === 'bilibili');

  assert.equal((await f.call('bilibili_interact', args)).result.error.code, 'interaction_disabled');
  let settings: any = await (await f.request(prefix + '/config')).json();
  assert.equal((await f.request(prefix + '/config', { revision: settings.revision,
    config: { ...settings.config, interactions: { ...settings.config.interactions, comment: true, like: true } } })).status, 200);
  const enabled = await f.service().status();
  assert.equal(enabled.interactions.comment, true);
  assert.equal(enabled.interactions.like, true);
  assert.equal(enabled.interactions.follow, false, 'enabling one interaction cannot enable the others');
  const denied = await f.app.tools.call('bilibili_interact', args, { id: f.sessionId, permission: 'ask' });
  assert.equal(denied.ok, false, 'the host permission gate applies even when the plugin switch is enabled');
  assert.equal(await submitted(), 0);
  assert.equal((await experiences()).length, 0);

  settings = await (await f.request(prefix + '/config')).json();
  assert.equal((await f.request(prefix + '/config', { revision: settings.revision,
    config: { ...settings.config, interactions: { ...settings.config.interactions, like: false } } })).status, 200);
  const disabledLike = await f.call('bilibili_interact', { action: 'like', videoRef, operationId: 'synthetic-disabled-like' });
  assert.equal(disabledLike.result.error.code, 'interaction_disabled', 'full permission cannot bypass a disabled per-action switch');
  assert.equal(await submitted(), 0);

  const first = await f.call('bilibili_interact', args);
  assert.equal(first.result.status, 'ok');
  assert.equal(first.result.data.state, 'confirmed');
  assert.equal(first.result.data.experienceRecorded, true);
  assert.equal(await submitted(), 1);
  const saved = await experiences();
  assert.equal(saved.length, 1);
  const experience = saved[0];
  assert.equal(experience.kind, 'episode');
  assert.equal(experience.outcome, 'succeeded');
  assert.equal(experience.origin.plugin, 'surf/bilibili');
  assert.equal(experience.origin.action, 'comment');
  assert.equal(experience.text, '在 B 站完成发表评论，已取得平台确认。');
  assert.equal((await experiences(other)).length, 0, 'model supplied sessionId cannot redirect the experience');

  for (const operationId of [args.operationId, 'synthetic-new-id-same-comment']) {
    const duplicate = await f.call('bilibili_interact', { ...args, operationId });
    assert.equal(duplicate.result.data.state, 'confirmed');
    assert.equal(duplicate.result.data.duplicate, true);
    assert.equal(await submitted(), 1, 'changing operationId must not repeat the same confirmed comment');
    assert.deepEqual((await experiences()).map((record: any) => record.id), [experience.id],
      'repairing the experience with the same event identity must be idempotent');
  }
  const conflict = await f.call('bilibili_interact', { ...args, text: ownComment + '_CHANGED' });
  assert.equal(conflict.result.error.code, 'invalid_input', 'a reused operationId cannot describe a different action');
  assert.equal(await submitted(), 1);

  await f.app.runtime.action('surf/bilibili', 'reload');
  const reopened = await f.call('bilibili_open', { target: VIDEO_ID });
  const afterReload = await f.call('bilibili_interact', { ...args, videoRef: reopened.result.data.videoRef });
  assert.equal(afterReload.result.data.duplicate, true);
  assert.equal(await submitted(), 0, 'a new plugin instance must use the durable receipt without resubmitting');
  assert.deepEqual((await experiences()).map((record: any) => record.id), [experience.id]);
  await f.app.runtime.events.drain();
  const rawHistory = await f.app.memory.readSession(f.sessionId);
  assert.ok(!JSON.stringify(rawHistory).includes(ownComment));
  assert.ok(!JSON.stringify(rawHistory).includes('SYNTHETIC_BILI_SESSION_SECRET'));
  const executionLogs = await diskText(join(f.run, 'logs/executions'));
  assert.ok(!executionLogs.includes(ownComment));
  assert.ok(!executionLogs.includes('SYNTHETIC_BILI_SESSION_SECRET'));
  assert.equal(f.requests.length, 0);
  await f.assertPrivate([ownComment, videoRef, reopened.result.data.videoRef, args.operationId, 'synthetic-new-id-same-comment']);
});

test('optional vision, no-audio default, native image blocks and recovery keep the same trusted session', deadline, async t => {
  const f = await hostFixture(t), childPid = f.app.runtime.records.get('surf/bilibili').execution.pid;
  const opened = await f.call('bilibili_open', { target: VIDEO_ID }), videoRef = opened.result.data.videoRef;
  await installVision(f);
  await until(() => f.names().includes('bilibili_watch'), 'vision binding did not register watch');
  const other = await f.app.sessions.create('Synthetic other viewer');
  const wrong = await f.call('bilibili_watch', { videoRef, sessionId: f.sessionId }, other);
  assert.equal(JSON.parse(wrong.result[0].text).error.code, 'reference_unavailable');
  assert.equal((await f.service('vision').stats()).offers, 0);
  const watched = await f.call('bilibili_watch', { videoRef });
  assert.equal(watched.ok, true);
  assert.equal(watched.result[1].type, 'image');
  assert.equal(watched.result[1].mimeType, 'image/jpeg');
  assert.equal(JSON.parse(watched.result[0].text).audio.status, 'not_requested');
  assert.ok(!JSON.stringify(watched).includes(PRIVATE_MEDIA_REF), 'the private reference cannot bypass the source audio switch');
  let stats = await f.service('vision').stats();
  assert.equal(stats.lastSession, f.sessionId);
  assert.equal(stats.prepares, 1);
  assert.equal(stats.understands, 0);
  assert.equal(f.requests.length, 0, 'media preparation must not start an unrelated conversation');
  const state: any = await (await f.request(prefix + '/config')).json();
  assert.equal((await f.request(prefix + '/config', { revision: state.revision, config: { ...state.config, audioEnabled: true } })).status, 200);
  const heard = await f.call('bilibili_watch', { videoRef, fromSeconds: 30, toSeconds: 60 });
  assert.ok(JSON.stringify(heard.result).includes(RAW_AUDIO));
  stats = await f.service('vision').stats();
  assert.equal(stats.understands, 1);
  assert.equal(stats.offers, 1, 'same media is reused only inside the current binding');
  await f.app.runtime.action('vision', 'stop');
  await until(() => !f.names().includes('bilibili_watch'), 'watch remained registered after vision stop');
  assert.equal(f.app.runtime.records.get('surf/bilibili').status, 'active');
  assert.equal((await f.call('bilibili_search', { query: PRIVATE_QUERY })).result.status, 'ok');
  await f.app.runtime.action('vision', 'start');
  await until(() => f.names().includes('bilibili_watch'), 'watch did not return after provider recovery');
  assert.equal((await f.service('vision').stats()).offers, 0, 'recovery must not replay old media offers');
  await f.call('bilibili_watch', { videoRef });
  assert.equal((await f.service('vision').stats()).offers, 1, 'the recovered binding cannot reuse the old provider reference');
  assert.equal(f.app.runtime.records.get('surf/bilibili').execution.pid, childPid);
  await f.assertPrivate([videoRef]);
});

test('parent stop cancels in-flight work; child independently stops and never replays on recovery', deadline, async t => {
  const f = await hostFixture(t), childPid = f.app.runtime.records.get('surf/bilibili').execution.pid;
  const opened = await f.call('bilibili_open', { target: VIDEO_ID }), videoRef = opened.result.data.videoRef;
  const waiting = f.call('bilibili_search', { query: 'wait' }).then((result: any) => ({ result }), (error: unknown) => ({ error }));
  await until(async () => (await f.service('bilibili-test-fixture').stats()).waiting, 'synthetic request never started');
  const started = Date.now();
  await f.app.runtime.action('surf', 'stop');
  const outcome = await waiting;
  assert.ok(Date.now() - started < 6000);
  assert.notEqual(f.app.runtime.records.get('surf/bilibili').status, 'active');
  assert.equal(f.names().some(name => name.startsWith('bilibili_')), false);
  if ('result' in outcome && outcome.result.ok) assert.notEqual(outcome.result.result.status, 'ok');
  await f.app.runtime.action('surf', 'start');
  assert.equal(f.app.runtime.records.get('surf/bilibili').status, 'active');
  assert.notEqual(f.app.runtime.records.get('surf/bilibili').execution.pid, childPid);
  assert.equal((await f.service('bilibili-test-fixture').stats()).calls.length, 0);
  assert.equal((await f.call('bilibili_comments', { videoRef })).result.error.code, 'reference_unavailable');
  await f.app.runtime.action('surf/bilibili', 'stop');
  assert.equal(f.app.runtime.records.get('surf').status, 'active');
  await f.app.runtime.action('surf', 'reload');
  assert.equal(f.app.runtime.records.get('surf/bilibili').status, 'stopped', 'saved child opt-out survives parent reload');
  await f.assertPrivate([videoRef]);
});
