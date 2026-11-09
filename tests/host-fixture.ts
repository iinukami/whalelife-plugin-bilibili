/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdir, writeFile, readFile, readdir, symlink, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { temporaryDirectory, root } from './temporary-directory.ts';

export const CURRENT_HOST = '38af5e72e466dd6da7f390e445cd1e6cc2f02a69';
export const MINIMUM_HOST = 'refs/tags/213b52b';
const MINIMUM_HOST_COMMIT = '7c8e3898b2bc7cb0b892eb0ab2feec0ca9c8aaf0';
export const RAW_TITLE = 'SYNTHETIC_BILI_FOREIGN_TITLE_DO_NOT_PERSIST';
export const RAW_DESCRIPTION = 'SYNTHETIC_BILI_FOREIGN_DESCRIPTION_DO_NOT_PERSIST';
export const RAW_COMMENT = 'SYNTHETIC_BILI_FOREIGN_COMMENT_DO_NOT_PERSIST';
export const RAW_SUBTITLE = 'SYNTHETIC_BILI_FOREIGN_SUBTITLE_DO_NOT_PERSIST';
export const RAW_AUDIO = 'SYNTHETIC_BILI_FOREIGN_AUDIO_DO_NOT_PERSIST';
export const RAW_NOTIFICATION_REPLY = 'SYNTHETIC_BILI_NOTIFICATION_REPLY_DO_NOT_PERSIST';
export const RAW_NOTIFICATION_LIKE = 'SYNTHETIC_BILI_NOTIFICATION_LIKE_DO_NOT_PERSIST';
export const PRIVATE_NOTIFICATION_CURSOR = '90071992547409939';
export const PRIVATE_QUERY = 'SYNTHETIC_BILI_PRIVATE_QUERY_DO_NOT_PERSIST';
export const ERROR_SECRET = 'SYNTHETIC_BILI_ERROR_SECRET_DO_NOT_PERSIST';
export const PRIVATE_MEDIA_REF = 'SYNTHETIC_BILI_PRIVATE_VISION_REFERENCE';
export const SYNTHETIC_COOKIE = 'SESSDATA=SYNTHETIC_BILI_SESSION_SECRET; bili_jct=11111111111111111111111111111111; DedeUserID=4321';
export const VIDEO_ID = 'BV1xx411c7mD';
export const VIDEO_URL = 'https://www.bilibili.com/video/' + VIDEO_ID;
const host = resolve(process.env.WHALELIFE_HOST_SOURCE || resolve(root, '../whalelife'));

export async function until(check: () => boolean | Promise<boolean>, label: string, milliseconds = 6000) {
  const deadline = Date.now() + milliseconds;
  while (!await check()) { assert.ok(Date.now() < deadline, label); await delay(20); }
}
export async function diskText(directory: string): Promise<string> {
  const chunks: string[] = [];
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error: any) { if (error.code === 'ENOENT') return ''; throw error; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    assert.equal(entry.isSymbolicLink(), false, 'persisted fixture trees must not contain links');
    chunks.push(entry.isDirectory() ? await diskText(path) : await readFile(path, 'utf8'));
  }
  return chunks.join('\n');
}

export async function hostFixture(t: TestContext, baseline = CURRENT_HOST) {
  const f = await temporaryDirectory(t);
  const source = join(f.dir, 'host');
  await mkdir(source);
  const archive = join(f.dir, 'host.tar');
  const gitArgs = ['-c', 'safe.directory=' + host.replaceAll('\\', '/'), '-C', host];
  const revision = spawnSync('git', [...gitArgs, 'rev-parse', '--verify', baseline + '^{commit}'],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(revision.status, 0, revision.stderr || revision.error?.message);
  assert.equal(revision.stdout.trim(), baseline === MINIMUM_HOST ? MINIMUM_HOST_COMMIT : CURRENT_HOST,
    'a frozen host baseline must not silently move');
  const archived = spawnSync('git', [...gitArgs, 'archive', '--format=tar', '--output=' + archive, revision.stdout.trim(), 'core', 'package.json'],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(archived.status, 0, archived.stderr || archived.error?.message);
  const tar = spawnSync('tar', ['-xf', archive, '-C', source], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(tar.status, 0, tar.stderr || tar.error?.message);
  await symlink(join(host, 'node_modules'), join(source, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const run = join(f.dir, 'runtime');
  await mkdir(join(run, 'config'), { recursive: true });
  await mkdir(join(run, 'plugins'), { recursive: true });
  await writeFile(join(run, 'config/config.json'), JSON.stringify({
    log: { level: 'info' }, web: { port: 0 },
    plugin_runtime: { startupTimeoutMs: 8000, callTimeoutMs: 4000, heartbeatTimeoutMs: 2000, stopTimeoutMs: 800 },
    providers: [{ id: 'synthetic', name: 'Synthetic', protocol: 'openai-compatible', base_url: 'http://127.0.0.1:1/v1', api_key: 'synthetic-unused-model-key' }],
    models: [{ id: 'synthetic-chat', provider: 'synthetic', name: 'Synthetic', model: 'fixture', type: 'chat', enabled: true, context_window: 32000 }],
    model_bindings: { chat: 'synthetic-chat' },
    personas: { a: { name: 'Synthetic', file: 'personas/a.md', model: 'synthetic-chat', permission: 'full' } },
    channels: { web: { persona: 'a', permission: 'full' } }, memory: { root: 'memory', budget_tokens: 6000 },
  }));
  const { boot } = await import(pathToFileURL(join(source, 'core/index.ts')).href);
  let app: any;
  f.cleanup.push(async () => { await app?.close(); });
  app = await boot(run);
  const requests: any[] = [], events: any[] = [];
  app.llm.chat = async () => { throw Error('Unexpected model call: no synthetic response installed'); };
  app.runtime.events.on('tool/called', (event: any) => events.push(event));
  const model = (reply: (request: any) => any) => {
    app.llm.chat = async (request: any) => {
      requests.push(JSON.parse(JSON.stringify(request)));
      const result = await reply(request);
      if (result.text) request.onChunk?.(result.text);
      return { usage: { prompt_tokens: 20, completion_tokens: 4 }, ...result };
    };
  };
  const plugin = async (id: string, body: string, manifest: Record<string, unknown> = {}) => {
    const dir = join(run, 'plugins', ...id.split('/').flatMap((part, index) => index ? ['sub', part] : [part]));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'plugin.yaml'), JSON.stringify({ id: id.split('/').at(-1), name: id,
      description: 'Synthetic isolated test fixture', version: '1.0.0', apiVersion: '1.0.0', ...manifest }));
    await writeFile(join(dir, 'index.ts'), body);
    return dir;
  };
  await plugin('surf', `export function apply(ctx) {
    ctx.provide('surf', {
      status: () => ({ ready: true, version: '1.0.0' }),
      settings: () => ({ timeoutMs: 12000, concurrency: 2, hasProxy: false }),
      search: () => { throw Error('No platform calls through the generic parent'); }
    });
  }`, { console: { groupChildren: true } });
  const bilibili = join(run, 'plugins/surf/sub/bilibili');
  await mkdir(bilibili, { recursive: true });
  await cp(join(root, 'plugin.yaml'), join(bilibili, 'plugin.yaml'));
  await writeFile(join(bilibili, 'index.ts'), `
import { applyWithDependencies } from ${JSON.stringify(pathToFileURL(join(root, 'src/index.ts')).href)};
import { BiliError } from ${JSON.stringify(pathToFileURL(join(root, 'src/errors.ts')).href)};
export async function apply(ctx) {
  let now = Date.now(), calls = [], waiting = false, cancelled = 0, disposed = false;
  const video = { bvid: ${JSON.stringify(VIDEO_ID)}, aid: 12345, cid: 67890,
    title: ${JSON.stringify(RAW_TITLE)}, description: ${JSON.stringify(RAW_DESCRIPTION)},
    owner: { mid: 9988, name: 'Synthetic creator' }, duration: 120,
    cover: 'https://synthetic.bili.example/cover.jpg', url: ${JSON.stringify(VIDEO_URL)},
    parts: [{ cid: 67890, page: 1, title: 'Synthetic part', duration: 120 }] };
  const record = (name, options) => { options.signal?.throwIfAborted(); calls.push(name); };
  const client = {
    async feed(source, page, cursor, options) { record('feed:' + source, options);
      if (source === 'following' && !options.cookie) throw new BiliError('login_required');
      return { items: [video], hasMore: true, nextPage: page + 1, cursor: 'synthetic-next' }; },
    async search(query, page, options) { record('search', options);
      if (query === 'wait') {
        waiting = true;
        await new Promise((resolve, reject) => {
          const finish = () => { clearTimeout(timer); options.signal.removeEventListener('abort', abort); waiting = false; };
          const abort = () => { cancelled++; finish(); reject(new BiliError('cancelled')); };
          const timer = setTimeout(() => { finish(); reject(new BiliError('timeout')); }, 3000);
          options.signal.addEventListener('abort', abort, {once:true}); if (options.signal.aborted) abort();
        });
      }
      if (query === 'error') throw Error(${JSON.stringify(ERROR_SECRET)});
      return { items: [video], hasMore: false }; },
    async video(target, options) { record('video', options); return video; },
    async comments(aid, page, options) { record('comments', options); return { items: [
      { rpid:'90071992547409930', root:'0', text:${JSON.stringify(RAW_COMMENT)}, author:{mid:1122,name:'Synthetic reader'}, likes:2 }
    ], hasMore:false }; },
    async notifications(source, cursor, options) {
      record('notifications:' + source, options);
      if (!options.cookie) throw new BiliError('login_required');
      if (!['replies','likes'].includes(source)) throw new BiliError('invalid_input');
      if (cursor && (cursor.id !== ${JSON.stringify(PRIVATE_NOTIFICATION_CURSOR)} || cursor.time !== 1234)) throw new BiliError('invalid_input');
      return { items: [{id:cursor?'2002':'2001',actors:[{mid:1122,name:'Synthetic notification actor'}],time:1234,
        type:'reply',business:'comment',title:${JSON.stringify(RAW_TITLE)},
        text:source==='replies'?${JSON.stringify(RAW_NOTIFICATION_REPLY)}:${JSON.stringify(RAW_NOTIFICATION_LIKE)},
        originalText:${JSON.stringify(RAW_COMMENT)},uri:${JSON.stringify(VIDEO_URL)},videoTarget:${JSON.stringify(VIDEO_ID)},
        ...(source==='likes'?{likeCount:2}:{})}],hasMore:!cursor,
        ...(!cursor?{cursor:{id:${JSON.stringify(PRIVATE_NOTIFICATION_CURSOR)},time:1234}}:{}) };
    },
    async subtitles(bvid, cid, options) { record('subtitles', options); return { tracks:[{id:'1',language:'zh-CN',label:'Synthetic Chinese',url:'https://synthetic.bili.example/subtitle.json'}],loginRequired:false }; },
    async subtitle(url, options) { record('subtitle', options); return [{from:1,to:3,text:${JSON.stringify(RAW_SUBTITLE)}}]; },
    async media(bvid, cid, maxBytes, options) { record('media', options); return {bytes:Buffer.from('SYNTHETIC_MP4_NOT_A_REAL_VIDEO'),mime:'video/mp4'}; },
    async image(url, maxBytes, options) { record('image', options); throw Error('Image is not part of this fixture'); },
    async account(options) { record('account', options); if (!options.cookie) throw new BiliError('login_required'); return {mid:4321,name:'Synthetic account'}; },
    async beginLogin(options) { record('beginLogin', options); return {url:'https://passport.bilibili.com/synthetic-login',key:'synthetic-qr-key'}; },
    async pollLogin(key, options) { record('pollLogin', options); return {state:'waiting'}; },
    async folders(mid, options) { record('folders', options); return [{id:'7',title:'Synthetic folder'}]; },
    async interact(input, options) { record('interact', options); return {state:'confirmed',platformId:'123456789'}; },
    dispose() { disposed = true; }
  };
  ctx.provide('bilibili-test-fixture', {stats:()=>({calls,waiting,cancelled,disposed,pid:process.pid}),advance:milliseconds=>{now+=milliseconds;}});
  return applyWithDependencies(ctx, {client, now:()=>now});
}`);
  const load = async (id: string) => {
    const record = await app.runtime.loadPath(id);
    assert.equal(record.status, 'active', record.error);
    assert.notEqual(record.execution.pid, process.pid, 'loadPath must use a real isolated process');
    return record;
  };
  await load('surf');
  assert.equal(app.runtime.records.get('surf/bilibili').status, 'active');
  const baseUrl = `http://127.0.0.1:${app.web.server.address().port}`;
  const login = await fetch(baseUrl + '/api/login', { method: 'POST', body: '{}', signal: AbortSignal.timeout(4000) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const request = (path: string, body?: unknown) => fetch(baseUrl + path, {
    method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(5000),
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const service = (name = 'bilibili') => app.runtime.records.get('surf/bilibili')?.local.get(name) ?? app.runtime.services.get(name)?.value;
  const names = () => app.tools.list().map((tool: any) => tool.function.name) as string[];
  const sessionId = await app.sessions.create('Synthetic Bilibili integration');
  const call = (name: string, args: unknown = {}, id = sessionId, signal?: AbortSignal) =>
    app.tools.call(name, args, { id, permission: 'full', ...(signal ? { signal } : {}) });
  const assertPrivate = async (extra: string[] = []) => {
    await app.runtime.events.drain();
    await app.memory.queue;
    const markers = [RAW_TITLE, RAW_DESCRIPTION, RAW_COMMENT, RAW_SUBTITLE, RAW_AUDIO, RAW_NOTIFICATION_REPLY, RAW_NOTIFICATION_LIKE,
      PRIVATE_NOTIFICATION_CURSOR, PRIVATE_QUERY, ERROR_SECRET, PRIVATE_MEDIA_REF,
      SYNTHETIC_COOKIE, 'SYNTHETIC_BILI_SESSION_SECRET', ...extra];
    for (const directory of ['memory', 'logs']) {
      const saved = await diskText(join(run, directory));
      for (const marker of markers) assert.ok(!saved.includes(marker), `${directory} retained a private fixture marker`);
    }
    for (const marker of markers) assert.ok(!JSON.stringify(events).includes(marker), 'event projection retained temporary content');
  };
  return { ...f, app, run, source, bilibili, baseline, sessionId, baseUrl, request, plugin, load, service,
    names, call, model, requests, events, assertPrivate };
}

export async function installVision(f: Awaited<ReturnType<typeof hostFixture>>) {
  await f.plugin('vision', `export function apply(ctx) {
    let offers=0, prepares=0, understands=0, releases=0, lastSession;
    // A synthetic JPEG signature exercises the host transport; decoding belongs to vision's own tests.
    const prepared=()=>({images:[{mime:'image/jpeg',base64:Buffer.from([255,216,255,224,0,2,255,217]).toString('base64'),width:1,height:1,frames:[{atSeconds:1}]}],
      coverage:{fromSeconds:0,toSeconds:30,timelineComplete:false},warnings:[]});
    ctx.provide('vision', {
      audiovisualApiVersion:'1.0.0', status:()=>({audiovisualApiVersion:'1.0.0'}),
      async offerMedia(input, options) { options?.signal?.throwIfAborted(); offers++;lastSession=input.sessionId;
        if(input.mime!=='video/mp4'||!input.base64) throw Error('Malformed synthetic source media');
        return {mediaRef:${JSON.stringify(PRIVATE_MEDIA_REF)},expiresAt:new Date(Date.now()+600000).toISOString(),info:{kind:'video',hasAudio:true}}; },
      async prepare(input, options) { options?.signal?.throwIfAborted(); prepares++;lastSession=input.sessionId;return prepared(); },
      async understand(input, options) { options?.signal?.throwIfAborted(); understands++;lastSession=input.sessionId;
        return {status:'completed',visual:prepared(),audio:{status:'completed',evidence:${JSON.stringify(RAW_AUDIO)}}}; },
      async release() { releases++;return {released:true}; },
      stats:()=>({offers,prepares,understands,releases,lastSession,pid:process.pid})
    });
  }`);
  await f.load('vision');
}
