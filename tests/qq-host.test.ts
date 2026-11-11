/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_HOST, MINIMUM_HOST, RAW_TITLE, VIDEO_ID, hostFixture, until } from './host-fixture.ts';

const prefix = '/plugins/surf/bilibili';
const provider = (version: string, legacy = false) => `export function apply(ctx) {
  let inputs=[],queries=[],format='card',mode='normal',waiting=false,cancelled=0,legacyCalls=0;
  const receipts=new Map();
  const old=()=>{legacyCalls++;throw Error('Legacy sharing must not be used');};
  ctx.provide('qq', {${legacy ? 'miniAppShareApiVersion' : 'videoShareApiVersion'}:${JSON.stringify(version)},
    sendMiniAppShare:old,miniAppShareDelivery:old,
    ${legacy ? '' : `async sendVideoShare(input,options) {
      options.signal?.throwIfAborted();inputs.push({input,permission:options.permission});
      if(mode==='wait') { waiting=true;await new Promise((_,reject)=>{
        const abort=()=>{waiting=false;cancelled++;reject(Error('SYNTHETIC_QQ_PRIVATE_ERROR'));};
        options.signal.addEventListener('abort',abort,{once:true});if(options.signal.aborted)abort();
      }); }
      const receipt={status:'sent',confirmed:true,duplicate:false,retryAutomatically:false,canRetry:false,platformMessageId:'12345',
        format,...(format==='card'?{coverIncluded:true}:{}),extra:'SYNTHETIC_QQ_PRIVATE_ARK'};
      receipts.set(input.actionId,receipt);return receipt;
    },
    async videoShareDelivery(input) { queries.push(input);return {...receipts.get(input.actionId),duplicate:true}; },`}
    configure:input=>{format=input.format||format;mode=input.mode||mode;},
    stats:()=>({inputs,queries,waiting,cancelled,legacyCalls})});
}`;

for (const baseline of [CURRENT_HOST, MINIMUM_HOST]) {
  test(`isolated host ${baseline}: optional QQ share contract, permissions and lifecycle`, {timeout:40000}, async t => {
    const f = await hostFixture(t, baseline), current = baseline === CURRENT_HOST;
    assert.equal(f.names().includes('bilibili_share_qq'), false);
    assert.equal((await f.service().status()).qqShareAvailable, false);
    await f.plugin('qq', provider('1.0.0',true)); await f.load('qq');
    assert.equal(f.names().includes('bilibili_share_qq'), false, 'legacy mini-app API is not the new format-aware API');
    await f.plugin('qq', provider('0.0.0')); await f.app.runtime.action('qq','reload');
    assert.equal(f.names().includes('bilibili_share_qq'), false, 'old QQ does not provide a usable sharing tool');
    await f.plugin('qq', provider('1.0.0')); await f.app.runtime.action('qq','reload');
    if (!current) {
      assert.equal(f.names().includes('bilibili_share_qq'), false, 'old host never persists external sharing material');
      assert.equal(f.app.runtime.records.get('surf/bilibili').status, 'active');
      assert.equal(f.requests.length, 0); await f.assertPrivate(); return;
    }
    await until(() => f.names().includes('bilibili_share_qq'), 'QQ share was not registered');
    assert.equal((await f.service().status()).qqShareAvailable, true);
    for (const name of ['bilibili_share_qq', 'bilibili_share_qq_delivery']) assert.equal(f.app.tools.entries.get(name).transientResult, true);
    const entry = f.app.tools.entries.get('bilibili_share_qq'); assert.equal(entry.danger, 'full');
    assert.deepEqual(Object.keys(entry.schema.properties).sort(), ['operationId','userId','videoRef']);
    const videoRef = (await f.call('bilibili_open',{target:VIDEO_ID})).result.data.videoRef;
    const args={videoRef,userId:'12345678',operationId:'synthetic-share'};
    assert.equal((await f.call('bilibili_share_qq',args)).result.error.code,'qq_share_disabled');
    const config:any=await(await f.request(prefix+'/config')).json();
    assert.equal((await f.request(prefix+'/config',{revision:config.revision,config:{shareToQQEnabled:true}})).status,200);
    assert.equal((await f.app.tools.call('bilibili_share_qq',args,{id:f.sessionId,permission:'ask'})).ok,false);
    assert.equal((await f.call('bilibili_share_qq',{...args,sessionId:'forged'})).result.error.code,'invalid_input');
    const before=(await f.service('bilibili-test-fixture').stats()).calls.length;
    const sent=await f.call('bilibili_share_qq',args);
    assert.equal(sent.result.data.status,'sent'); assert.equal(sent.result.data.confirmed,true);
    assert.equal(sent.result.data.format,'card'); assert.equal(sent.result.data.coverIncluded,true);
    assert.equal(JSON.stringify(sent).includes('SYNTHETIC_QQ_PRIVATE_ARK'),false);
    const stats=await f.service('qq').stats();assert.equal(stats.inputs.length,1);
    assert.deepEqual(stats.inputs[0],{permission:'full',input:{userId:args.userId,actionId:'bilibili:'+args.operationId,sessionId:f.sessionId,
      preset:'bili',title:RAW_TITLE,description:'UP主：Synthetic creator',previewUrl:'https://i0.hdslb.com/bfs/archive/synthetic-cover.jpg',
      jumpPath:'pages/video/video?avid=12345',webUrl:'https://www.bilibili.com/video/'+VIDEO_ID+'/'}});
    await f.service('qq').configure({format:'miniapp'});
    const miniapp = await f.call('bilibili_share_qq',{...args,operationId:'synthetic-miniapp'});
    assert.equal(miniapp.result.data.format,'miniapp'); assert.equal(miniapp.result.data.coverIncluded,undefined);
    assert.equal((await f.service('qq').stats()).inputs.every((v:any)=>!Object.hasOwn(v.input,'format')),true);
    assert.equal((await f.call('bilibili_share_qq',{...args,format:'card'})).result.error.code,'invalid_input');
    const enabled:any=await(await f.request(prefix+'/config')).json();
    assert.equal((await f.request(prefix+'/config',{revision:enabled.revision,config:{shareToQQEnabled:false}})).status,200);
    const delivery=await f.call('bilibili_share_qq_delivery',{userId:args.userId,operationId:args.operationId});
    assert.equal(delivery.result.data.confirmed,true);
    assert.equal(delivery.result.data.format,'card','query preserves original format after QQ setting changes');
    assert.deepEqual((await f.service('qq').stats()).queries,[{userId:args.userId,actionId:'bilibili:'+args.operationId,sessionId:f.sessionId}]);
    assert.equal((await f.service('bilibili-test-fixture').stats()).calls.length,before,'sharing and querying use no Bili requests');
    assert.equal((await f.service('qq').stats()).legacyCalls,0);
    await f.app.runtime.action('qq','stop');
    await until(()=>!f.names().includes('bilibili_share_qq'),'QQ stop did not withdraw share tool');
    assert.equal(f.names().includes('bilibili_share_qq_delivery'),false);
    assert.equal((await f.service().status()).qqShareAvailable,false);
    assert.equal((await f.call('bilibili_open',{target:VIDEO_ID})).result.status,'ok','QQ stop does not stop browsing');
    await f.app.runtime.action('qq','start');
    await until(()=>f.names().includes('bilibili_share_qq'),'QQ restart did not recover share tool');
    assert.equal((await f.service('qq').stats()).inputs.length,0,'restart never replays shares');
    assert.equal(f.requests.length,0);await f.assertPrivate([videoRef,args.operationId,'SYNTHETIC_QQ_PRIVATE_ARK']);
  });
}

test('isolated host cancels in-flight QQ share when its switch is disabled without replay', {timeout:40000}, async t => {
  const f = await hostFixture(t);
  await f.plugin('qq',provider('1.0.0')); await f.load('qq');
  await until(()=>f.names().includes('bilibili_share_qq'),'QQ share was not registered');
  const config:any=await(await f.request(prefix+'/config')).json();
  const enabled:any=await(await f.request(prefix+'/config',{revision:config.revision,config:{shareToQQEnabled:true}})).json();
  const videoRef=(await f.call('bilibili_open',{target:VIDEO_ID})).result.data.videoRef;
  await f.service('qq').configure({mode:'wait'});
  const sending=f.call('bilibili_share_qq',{videoRef,userId:'12345678',operationId:'synthetic-cancel'});
  await until(async()=>(await f.service('qq').stats()).waiting,'provider did not receive the call');
  assert.equal((await f.request(prefix+'/config',{revision:enabled.revision,config:{shareToQQEnabled:false}})).status,200);
  const result=await sending;
  assert.equal(result.result.data.status,'uncertain'); assert.equal(result.result.data.retryAutomatically,false);
  await until(async()=>(await f.service('qq').stats()).cancelled===1,'provider did not receive cancellation');
  const stats=await f.service('qq').stats(); assert.equal(stats.inputs.length,1); assert.equal(stats.legacyCalls,0);
  assert.equal((await f.call('bilibili_open',{target:VIDEO_ID})).result.status,'ok');
  assert.equal(f.requests.length,0); await f.assertPrivate(['SYNTHETIC_QQ_PRIVATE_ERROR',videoRef,'synthetic-cancel']);
});
