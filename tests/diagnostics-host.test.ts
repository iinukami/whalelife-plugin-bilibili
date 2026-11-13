/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './temporary-directory.ts';
import { DIAGNOSTICS_HOST, MINIMUM_HOST, PRIVATE_QUERY, ERROR_SECRET, SYNTHETIC_COOKIE, hostFixture, until, diskText } from './host-fixture.ts';

const prefix = '/plugins/surf/bilibili';
for (const baseline of [DIAGNOSTICS_HOST, MINIMUM_HOST]) {
  test(`failure diagnostics reach isolated host logs without private data: ${baseline}`, { timeout: 40000 }, async t => {
    const f = await hostFixture(t, baseline);
    await f.plugin('surf/bilibili', `
import { applyWithDependencies } from ${JSON.stringify(pathToFileURL(join(root, 'src/index.ts')).href)};
export async function apply(ctx) {
  let accountCalls = 0, searchCalls = 0;
  ctx.provide('diagnostic-fixture', { counts: () => ({ accountCalls, searchCalls }) });
  return applyWithDependencies(ctx, { transport: {
    async request(url, options) {
      const path = new URL(url).pathname;
      let status = 200, body;
      if (path === '/x/web-interface/nav') {
        accountCalls++;
        body = accountCalls === 1 ? { code: -352, message: ${JSON.stringify(ERROR_SECRET)} }
          : { code: 0, data: { isLogin: true, mid: 4321, uname: 'SYNTHETIC_PRIVATE_ACCOUNT_NAME' } };
      } else if (path === '/x/web-interface/search/type') {
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
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await f.call('bilibili_search', { query: PRIVATE_QUERY });
        assert.equal(result.ok, true);
        assert.equal(result.result.error.code, 'access_blocked');
      }
      const success = await f.call('bilibili_search', { query: PRIVATE_QUERY });
      assert.equal(success.result.status, 'ok');
      await until(() => diagnostics().length === 3, 'search failures missing from host log');
      const [, http, api] = diagnostics();
      assert.equal(http.stage, 'http'); assert.equal(http.httpStatus, 412); assert.equal(http.apiCode, undefined);
      assert.equal(api.stage, 'api'); assert.equal(api.httpStatus, 200); assert.equal(api.apiCode, -401);
      for (const entry of [http, api]) {
        assert.equal(entry.endpoint, 'search'); assert.equal(entry.path, '/x/web-interface/search/type');
        assert.equal(entry.host, 'api.bilibili.com'); assert.equal(entry.method, 'GET');
        assert.equal(entry.hasSessionCookie, true);
      }
    } else assert.equal(f.names().includes('bilibili_search'), false, 'minimum host capability must remain unchanged');
    assert.deepEqual(await f.service('diagnostic-fixture').counts(), { accountCalls: 2, searchCalls: baseline === DIAGNOSTICS_HOST ? 3 : 0 });
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
