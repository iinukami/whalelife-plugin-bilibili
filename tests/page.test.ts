/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { settingsPage } from '../src/page.ts';

const PNG = 'data:image/png;base64,SYNTHETIC_QR_IMAGE';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function response(data: unknown, ok = true) { return { ok, json: async () => data }; }
async function pageFixture(start: () => Promise<ReturnType<typeof response>>, poll?: () => Promise<ReturnType<typeof response>>) {
  const elements = new Map<string, any>();
  for (const [, id] of settingsPage.matchAll(/\bid="([^"]+)"/g)) {
    elements.set(id, { textContent: '', value: '', disabled: false, hidden: id === 'qrBox', checked: false,
      options: [], add(option: any) { this.options.push(option); },
      replaceChildren(...options: any[]) { this.options = options; },
      removeAttribute(name: string) { delete this[name]; } });
  }
  const events = new Map<string, () => void>();
  const timers = new Map<number, () => Promise<void>>();
  let nextTimer = 0;
  let config = { audioEnabled: false, historySyncEnabled: false, interactions: { like: false, favorite: false, follow: false, comment: false, reply: false },
    maxMediaBytes: 67108864, referenceTtlSeconds: 600, favoriteFolderId: '' };
  const saved: any[] = [];
  const script = /<script>([\s\S]*?)<\/script>/.exec(settingsPage)?.[1];
  assert.ok(script);
  await runInNewContext(script, {
    document: { getElementById: (id: string) => { assert.ok(elements.has(id)); return elements.get(id); } },
    window: { addEventListener: (event: string, fn: () => void) => events.set(event, fn) },
    Option: class { text: string; value: string; constructor(text: string, value: string) { this.text = text; this.value = value; } },
    setTimeout: (fn: () => Promise<void>) => { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimeout: (id: number) => timers.delete(id),
    fetch: async (url: string, init?: { method?: string; body?: string }) => {
      if (url.endsWith('/config')) {
        if (init?.method === 'POST') { const payload = JSON.parse(init.body!); saved.push(payload); config = payload.config; }
        return response({ ok: true, revision: 'synthetic-config', config });
      }
      if (url.endsWith('/state')) return response({ ok: true, account: { loggedIn: false, revision: 'synthetic-account' }, status: { ready: true, vision: true } });
      if (url.endsWith('/login/start')) return start();
      if (url.endsWith('/login/poll') && poll) return poll();
      throw Error('Unexpected page request');
    },
  });
  return { get: (id: string) => elements.get(id), events, timers, saved,
    async pollOnce() { const entry = timers.entries().next().value; assert.ok(entry); timers.delete(entry[0]); await entry[1](); } };
}

test('history synchronization starts off and saves independently of audio and interactions', async () => {
  const f = await pageFixture(async () => response({ ok: false }));
  await f.get('refresh').onclick();
  assert.equal(f.get('historySyncEnabled').checked, false);
  f.get('historySyncEnabled').checked = true;
  await f.get('settings').onsubmit({ preventDefault() {} });
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0].config.historySyncEnabled, true);
  assert.equal(f.saved[0].config.audioEnabled, false);
  assert.equal(Object.values(f.saved[0].config.interactions).every(value => value === false), true);
  await f.get('refresh').onclick();
  assert.equal(f.get('historySyncEnabled').checked, true);
  f.get('historySyncEnabled').checked = false;
  await f.get('settings').onsubmit({ preventDefault() {} });
  assert.equal(f.saved[1].config.historySyncEnabled, false);
});

test('QR generation shows progress beside the button and displays the returned image', async () => {
  const pending = deferred<ReturnType<typeof response>>();
  const f = await pageFixture(() => pending.promise);
  const click = f.get('startLogin').onclick();
  assert.equal(f.get('startLogin').disabled, true);
  assert.equal(f.get('startLogin').textContent, '正在生成…');
  assert.match(f.get('loginMessage').textContent, /正在申请/);
  assert.equal(f.get('qrBox').hidden, true);
  pending.resolve(response({ ok: true, id: 'synthetic-qr-id', qrDataUrl: PNG }));
  await click;
  assert.equal(f.get('startLogin').disabled, false);
  assert.equal(f.get('qrBox').hidden, false);
  assert.equal(f.get('qr').src, PNG);
  assert.match(f.get('loginMessage').textContent, /二维码已生成/);
  assert.equal(f.timers.size, 1);
});

test('a failed QR request is visible next to its button and can be retried', async () => {
  let calls = 0;
  const f = await pageFixture(async () => ++calls === 1
    ? response({ ok: false, error: { message: '合成平台错误' } }, false)
    : response({ ok: true, id: 'synthetic-retry-id', qrDataUrl: PNG }));
  await f.get('startLogin').onclick();
  assert.equal(f.get('loginMessage').textContent, '生成失败：合成平台错误');
  assert.equal(f.get('startLogin').disabled, false);
  assert.equal(f.get('startLogin').textContent, '生成登录二维码');
  assert.equal(f.get('qrBox').hidden, true);
  assert.equal(f.timers.size, 0);
  assert.match(settingsPage, /id="startLogin" aria-describedby="loginMessage"[^]*?<p id="loginMessage" role="status" aria-live="polite">/);
  await f.get('refresh').onclick();
  assert.equal(f.get('loginMessage').textContent, '生成失败：合成平台错误', 'configuration refresh must not erase a login failure');
  await f.get('startLogin').onclick();
  assert.equal(f.get('qrBox').hidden, false);
  assert.equal(f.get('loginMessage').textContent.includes('合成平台错误'), false);
});

test('expiry and polling failures remove the stale QR and show a local explanation', async () => {
  for (const failure of [false, true]) {
    const f = await pageFixture(async () => response({ ok: true, id: 'synthetic-expiry-id', qrDataUrl: PNG }),
      async () => failure ? response({ ok: false, error: { message: '合成网络错误' } }, false) : response({ ok: true, state: 'expired' }));
    await f.get('startLogin').onclick();
    await f.pollOnce();
    assert.equal(f.get('qrBox').hidden, true);
    assert.equal(f.get('qr').src, undefined);
    assert.match(f.get('loginMessage').textContent, failure ? /二维码状态读取失败：合成网络错误/ : /二维码已过期/);
    assert.equal(f.timers.size, 0);
  }
});

test('leaving the page while generating a QR does not revive it or start polling', async () => {
  const pending = deferred<ReturnType<typeof response>>();
  const f = await pageFixture(() => pending.promise);
  const click = f.get('startLogin').onclick();
  f.events.get('pagehide')!();
  pending.resolve(response({ ok: true, id: 'synthetic-late-id', qrDataUrl: PNG }));
  await click;
  assert.equal(f.get('qrBox').hidden, true);
  assert.equal(f.get('qr').src, undefined);
  assert.equal(f.get('loginMessage').textContent, '');
  assert.equal(f.timers.size, 0);
});
