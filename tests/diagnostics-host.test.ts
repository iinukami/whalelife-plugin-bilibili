/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './temporary-directory.ts';
import { DIAGNOSTICS_HOST, HISTORY_HOST, MINIMUM_HOST, PRIVATE_QUERY, ERROR_SECRET, SYNTHETIC_COOKIE, hostFixture, until, diskText } from './host-fixture.ts';

const prefix = '/plugins/surf/bilibili';
for (const baseline of [DIAGNOSTICS_HOST, MINIMUM_HOST]) {
  test(`failure diagnostics reach isolated host logs without private data: ${baseline}`, { timeout: 40000 }, async t => {
    const f = await hostFixture(t, baseline);
    await f.plugin('surf/bilibili', `
import { applyWithDependencies } from ${JSON.stringify(pathToFileURL(join(root, 'src/index.ts')).href)};
export async function apply(ctx) {
  let accountCalls = 0, searchCalls = 0, searchKeyCalls = 0, searchCookieCalls = 0, trafficNow = 1000000;
  ctx.provide('diagnostic-fixture', { advance: ms => { trafficNow += ms; }, counts: () => ({ accountCalls, searchCalls, searchKeyCalls, searchCookieCalls }) });
  return applyWithDependencies(ctx, { trafficTiming: { now: () => trafficNow, sleep: async ms => { trafficNow += ms; } }, transport: {
    async request(url, options) {
      const path = new URL(url).pathname;
      let status = 200, body;
      if (path === '/x/web-frontend/getbuvid') {
        searchCookieCalls++; body = { code: 0, data: { buvid: 'SYNTHETIC_SEARCH_DEVICE' } };
      } else if (path === '/x/web-interface/nav' && options.diagnosticPurpose === 'search_keys') {
        searchKeyCalls++; body = { code: 0, data: { wbi_img: {
          img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
          sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } } };
      } else if (path === '/x/web-interface/nav') {
        accountCalls++;
        body = accountCalls === 1 ? { code: -352, message: ${JSON.stringify(ERROR_SECRET)} }
          : { code: 0, data: { isLogin: true, mid: 4321, uname: 'SYNTHETIC_PRIVATE_ACCOUNT_NAME' } };
      } else if (path === '/x/web-interface/wbi/search/type') {
        searchCalls++;
        status = searchCalls === 1 ? 412 : 200;
        body = searchCalls === 2 ? { code: -401, message: ${JSON.stringify(ERROR_SECRET)} }
          : { code: 0, data: { result: [], numResults: 0 } };
      } else throw Error('Unexpected synthetic endpoint');
      return { status, headers: {}, body: Buffer.from(JSON.stringify(body)), url };
    }, dispose() {},
  } });
}`, { depends: ['surf'], optionalDepends: ['vision', 'qq'] });
    await f.app.runtime.action('surf/bilibili', 'reload');
    const diagnostics = () => f.app.logger.lines.filter((line: string) => line.includes('B 站请求失败'))
      .map((line: string) => JSON.parse(line.slice(line.indexOf('{'))));
    const state: any = await (await f.request(prefix + '/state')).json();
    const args = { revision: state.account.revision, cookie: SYNTHETIC_COOKIE };
    const failed: any = await (await f.request(prefix + '/login/import', args)).json();
    assert.equal(failed.error.code, 'access_blocked');
    await until(() => diagnostics().length === 1, 'API failure diagnostic missing from host');
    assert.equal(diagnostics()[0].apiCode, -352);
    assert.equal(diagnostics()[0].httpStatus, 200);
    assert.equal(diagnostics()[0].endpoint, 'account');
    assert.equal(diagnostics()[0].hasSessionCookie, true);
    assert.equal((await f.request(prefix + '/login/import', args)).status, 200);
    if (baseline === DIAGNOSTICS_HOST) {
      await f.service('diagnostic-fixture').advance(300001);
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await f.call('bilibili_search', { query: PRIVATE_QUERY });
        assert.equal(result.ok, true);
        assert.equal(result.result.error.code, 'access_blocked');
        if (attempt === 0) await f.service('diagnostic-fixture').advance(600001);
      }
      const success = await f.call('bilibili_search', { query: PRIVATE_QUERY });
      assert.equal(success.result.status, 'ok');
      await until(() => diagnostics().length === 3, 'search failures missing from host log');
      const [, http, api] = diagnostics();
      assert.equal(http.stage, 'http'); assert.equal(http.httpStatus, 412); assert.equal(http.apiCode, undefined);
      assert.equal(api.stage, 'api'); assert.equal(api.httpStatus, 200); assert.equal(api.apiCode, -401);
      for (const entry of [http, api]) {
        assert.equal(entry.endpoint, 'search'); assert.equal(entry.path, '/x/web-interface/wbi/search/type');
        assert.equal(entry.host, 'api.bilibili.com'); assert.equal(entry.method, 'GET');
        assert.equal(entry.hasSessionCookie, true);
      }
    } else assert.equal(f.names().includes('bilibili_search'), false, 'minimum host capability must remain unchanged');
    assert.deepEqual(await f.service('diagnostic-fixture').counts(), { accountCalls: 2, searchCalls: baseline === DIAGNOSTICS_HOST ? 3 : 0,
      searchKeyCalls: baseline === DIAGNOSTICS_HOST ? 1 : 0, searchCookieCalls: baseline === DIAGNOSTICS_HOST ? 1 : 0 });
    await f.assertPrivate(['SYNTHETIC_PRIVATE_ACCOUNT_NAME']);
    const persisted = await diskText(join(f.run, 'logs'));
    for (const entry of diagnostics()) {
      assert.match(entry.requestId, /^[0-9a-f-]{36}$/);
      assert.ok(entry.elapsedMs >= 0);
      assert.ok(persisted.includes(entry.requestId), 'diagnostic must reach disk, not just console');
    }
    assert.equal(diagnostics().length, baseline === DIAGNOSTICS_HOST ? 3 : 1, 'successes must not produce diagnostics');
    assert.equal(f.requests.length, 0, 'diagnostics must not call the model');
  });
}


for (const baseline of [HISTORY_HOST, MINIMUM_HOST]) {
  test(`subtitle semantic diagnostics persist safely through isolated host logging: ${baseline}`, { timeout: 40000 }, async t => {
    const f = await hostFixture(t, baseline);
    const signedUrl = 'https://aisubtitle.hdslb.com/SYNTHETIC_SUBTITLE_PATH.json?auth_key=SYNTHETIC_SUBTITLE_SIGNATURE&uid=846726391055582';
    const privateId = 'SYNTHETIC_INVALID_TRACK_ID';
    const privateText = 'SYNTHETIC_SUBTITLE_CONTENT_DO_NOT_LOG';
    await f.plugin('surf/bilibili', `
import { BiliClient } from ${JSON.stringify(pathToFileURL(join(root, 'src/client.ts')).href)};
export function apply(ctx) {
  let scenario = 'success', trackRequests = 0, bodyRequests = 0, preparationRequests = 0;
  const client = new BiliClient({ signal: ctx.signal, onDiagnostic: event => ctx.logger.warn('B 站请求失败', event), transport: {
    async request(url, options) {
      if ((options.method ?? 'GET') !== 'GET') throw Error('Synthetic subtitle fixture permits reads only');
      let body;
      if (new URL(url).pathname === '/x/web-frontend/getbuvid') {
        preparationRequests++; body = { code: 0, data: { buvid: 'SYNTHETIC_SUBTITLE_DEVICE' } };
      } else if (new URL(url).pathname === '/x/web-interface/nav' && options.diagnosticPurpose === 'subtitle_keys') {
        preparationRequests++; body = { code: 0, data: { wbi_img: {
          img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
          sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } } };
      } else if (new URL(url).pathname === '/x/player/wbi/v2') {
        trackRequests++;
        if (options.headers?.Cookie !== ${JSON.stringify(SYNTHETIC_COOKIE + '; buvid3=SYNTHETIC_SUBTITLE_DEVICE')}) throw Error('Expected synthetic track cookie');
        body = { code: 0, data: { bvid: 'BV1xx411c7mD', cid: 98765, subtitle: { subtitles: [{
          id_str: scenario === 'invalid_track' ? ${JSON.stringify(privateId)} : '12345',
          subtitle_url: ${JSON.stringify(signedUrl)}, lan: 'zh-CN', lan_doc: 'SYNTHETIC_PRIVATE_TRACK_LABEL', uid: 846726391055582
        }] } } };
      } else if (url === ${JSON.stringify(signedUrl)}) {
        bodyRequests++;
        if (Object.keys(options.headers ?? {}).some(key => key.toLowerCase() === 'cookie')) throw Error('Subtitle CDN received a cookie');
        body = { body: [
          { from: 0, to: 1, content: ${JSON.stringify(privateText)} },
          { from: 1, to: 2, content: scenario === 'invalid_cue' ? { privateText: ${JSON.stringify(privateText)}, uid: 846726391055582 } : '合成成功字幕' }
        ] };
      } else throw Error('Unexpected synthetic subtitle endpoint');
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(body)), url };
    }, dispose() {},
  } });
  ctx.effect(() => () => client.dispose());
  ctx.provide('subtitle-diagnostic-fixture', {
    async run(value) {
      if (!['invalid_track', 'invalid_cue', 'success'].includes(value)) throw Error('Invalid synthetic scenario');
      scenario = value;
      try {
        const result = await client.subtitles('BV1xx411c7mD', 98765, { cookie: ${JSON.stringify(SYNTHETIC_COOKIE)}, signal: ctx.signal });
        if (value === 'invalid_track') return { ok: true, tracks: result.tracks.length };
        const cues = await client.subtitle(result.tracks[0].url, { cookie: ${JSON.stringify(SYNTHETIC_COOKIE)}, signal: ctx.signal });
        return { ok: true, tracks: result.tracks.length, cues: cues.length };
      } catch (error) { return { ok: false, code: error.code ?? 'unexpected' }; }
    }, counts: () => ({ trackRequests, bodyRequests, preparationRequests }),
  });
}`, { depends: ['surf'] });
    await f.app.runtime.action('surf/bilibili', 'reload');
    const service = f.service('subtitle-diagnostic-fixture');
    const diagnostics = () => f.app.logger.lines.filter((line: string) => line.includes('B 站请求失败'))
      .map((line: string) => JSON.parse(line.slice(line.indexOf('{'))));
    assert.deepEqual(await service.run('invalid_track'), { ok: false, code: 'malformed_response' });
    await until(() => diagnostics().length === 1, 'subtitle track parse failure did not reach host log');
    const tracks = diagnostics()[0];
    assert.equal(tracks.endpoint, 'subtitle_tracks'); assert.equal(tracks.phase, 'subtitle_tracks'); assert.equal(tracks.stage, 'parse');
    assert.equal(tracks.path, '/x/player/wbi/v2'); assert.equal(tracks.host, 'api.bilibili.com'); assert.equal(tracks.hasSessionCookie, true);
    assert.equal(tracks.reason, 'track_rejected'); assert.equal(tracks.field, 'data.subtitle.subtitles');
    assert.equal(tracks.itemCount, 1); assert.equal(tracks.examinedCount, 1); assert.equal(tracks.acceptedCount, 0); assert.equal(tracks.rejectedCount, 1);
    assert.deepEqual(tracks.issues, [{ reason: 'invalid_track_id', field: 'track.id_str', actualType: 'string', itemIndex: 0, constraint: 'identifier' }]);
    assert.deepEqual(await service.run('invalid_cue'), { ok: false, code: 'malformed_response' });
    await until(() => diagnostics().length === 2, 'subtitle body parse failure did not reach host log');
    const body = diagnostics()[1];
    assert.equal(body.endpoint, 'subtitle_body'); assert.equal(body.phase, 'subtitle_body'); assert.equal(body.stage, 'parse');
    assert.equal(body.host, undefined); assert.equal(body.path, undefined); assert.equal(body.hasSessionCookie, false);
    assert.equal(body.reason, 'invalid_cue_content'); assert.equal(body.field, 'cue.content'); assert.equal(body.actualType, 'object');
    assert.equal(body.itemIndex, 1); assert.equal(body.itemCount, 2); assert.equal(body.acceptedCount, 1); assert.equal(body.constraint, 'string');
    assert.deepEqual(await service.run('success'), { ok: true, tracks: 1, cues: 2 });
    assert.deepEqual(await service.counts(), { trackRequests: 3, bodyRequests: 2, preparationRequests: 2 });
    const ids = diagnostics().map((entry: any) => entry.requestId);
    assert.equal(new Set(ids).size, 2);
    await until(async () => {
      const persisted = await diskText(join(f.run, 'logs'));
      return ids.every((id: string) => persisted.includes(id));
    }, 'subtitle semantic diagnostics must reach disk');
    for (const entry of diagnostics()) {
      assert.match(entry.requestId, /^[0-9a-f-]{36}$/); assert.equal(entry.method, 'GET'); assert.equal(entry.httpStatus, 200);
      assert.equal(entry.errorCode, 'malformed_response'); assert.ok(entry.elapsedMs >= 0); assert.ok(entry.responseBytes > 0);
    }
    await f.assertPrivate([signedUrl, 'SYNTHETIC_SUBTITLE_SIGNATURE', '846726391055582', privateId, privateText, 'SYNTHETIC_PRIVATE_TRACK_LABEL', 'SYNTHETIC_SUBTITLE_DEVICE']);
    assert.equal(diagnostics().length, 2, 'successful track/body reads must not log diagnostics');
    assert.equal(f.requests.length, 0, 'subtitle diagnostics must not call a model');
  });
}
