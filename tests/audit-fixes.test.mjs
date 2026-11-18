// SPDX-License-Identifier: MIT
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import http from 'node:http';
import {createWorldServer} from '../apps/world-service/server.mjs';import {makeEnvelope} from '../packages/world-protocol/index.mjs';import {ServiceScheduler} from '../apps/world-service/scheduler.mjs';import {worldFeedFresh} from '../apps/observer/freshness.mjs';import {applyNativeFrame} from '../apps/observer/native-state.mjs';
const source=process.env.OSG_MULTI_SOURCE_DIR;
const sample=(sequence,entityId='vessel-1')=>makeEnvelope('PHYSICS_SAMPLE',{runId:'fix-run',epoch:0,step:sequence,sequence,simTime:sequence*.02,simDt:.02,frameId:'global',entityId,entityName:'My vessel €',wireFormat:2,source:'native',position:[100,0,0],velocity:[0,0,0],contact:false});
async function setup(){const dir=await mkdtemp(join(tmpdir(),'sim-fixes-'));const app=await createWorldServer({httpPort:0,bridgePort:0,dataDir:dir,osgWorldMode:true,osgMultiSourceDir:source,worldBatchMs:5000,worldClients:{peer:'AAAAAAAAAAAAAAAA'}});return{app,dir,base:`http://127.0.0.1:${app.httpPort}`,async close(){await this.app.close();await rm(dir,{recursive:true,force:true});}};}
test('scheduler prioritizes source processing while completing background work and bounding admission',async()=>{
 const scheduler=new ServiceScheduler(),order=[];let release,enter;const gate=new Promise(r=>release=r),entered=new Promise(r=>enter=r);
 const first=scheduler.enqueue(async()=>{enter();await gate;order.push('first');},'background');await entered;
 const background=Array.from({length:32},(_,i)=>scheduler.enqueue(()=>order.push('background'+i),'background'));
 const native=scheduler.enqueue(()=>order.push('sample'));release();await Promise.all([first,native,...background]);await scheduler.idle();
 assert.equal(order[1],'sample');assert.equal(order.length,34);
 const fair=new ServiceScheduler(),turns=[];const continuous=Array.from({length:128},()=>fair.enqueue(()=>turns.push('source')));const peer=fair.enqueue(()=>turns.push('peer'),'background');await Promise.all([...continuous,peer]);assert.equal(turns.indexOf('peer'),64);
 const bounded=new ServiceScheduler();const jobs=Array.from({length:128},()=>bounded.enqueue(async()=>{},'background'));await assert.rejects(bounded.enqueue(()=>{},'background'),{code:'ACTIVITY_BUSY'});await Promise.all(jobs);
});
test('live classification requires fresh frames and an undelayed source queue',()=>{
 const info={nativeConnected:true,osgHealthy:true,runId:'run',freshness:{budgetMs:1000,queues:{telemetry:{oldestAgeMs:0}}}};
 const input={connected:true,live:true,runId:'run',frameAgeMs:10,sourceAgeMs:10};assert.equal(worldFeedFresh(info,input),true);
 assert.equal(worldFeedFresh(info,{...input,sourceAgeMs:6380}),false);assert.equal(worldFeedFresh(info,{...input,sourceAgeMs:undefined}),false);assert.equal(worldFeedFresh(info,{...input,frameAgeMs:6380}),false);assert.equal(worldFeedFresh(info,{...input,runId:'old'}),false);
 assert.equal(worldFeedFresh({...info,freshness:{budgetMs:1000,queues:{telemetry:{oldestAgeMs:2000}}}},input),false);
});
test('chunk-split UTF-8 is stored exactly, invalid UTF-8 is rejected, and retry fingerprints stay stable',{skip:!source},async()=>{
 const x=await setup();try{
  await x.app.handleSample(sample(1));await x.app.flushWorld();
  for(const [i,text]of ['before€after','Български','emoji 🛰️'].entries()){
   const input={sessionId:'s',requestId:'unicode'+i,activityId:'text'+i,action:'start',text,runId:'fix-run',epoch:0,expectedVersion:null};
   const bytes=Buffer.from(JSON.stringify(input));const split=bytes.findIndex(b=>b>=128)+1;
   const status=await new Promise((resolve,reject)=>{const req=http.request(x.base+'/api/world/activities',{method:'POST',headers:{authorization:'Bearer AAAAAAAAAAAAAAAA','content-length':bytes.length}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.write(bytes.subarray(0,split));setTimeout(()=>req.end(bytes.subarray(split)),20);});assert.equal(status,200);
   const retry=await fetch(x.base+'/api/world/activities',{method:'POST',headers:{authorization:'Bearer AAAAAAAAAAAAAAAA'},body:JSON.stringify(input)});assert.equal(retry.status,200);assert.equal((await retry.json()).idempotent,true);
   assert.equal((await x.app.world.activities.list({actor:'peer',activityId:input.activityId})).items[0].text,text);
  }
  const invalid=await fetch(x.base+'/api/world/activities',{method:'POST',headers:{authorization:'Bearer AAAAAAAAAAAAAAAA'},body:Buffer.from([123,34,120,34,58,34,255,34,125])});assert.equal(invalid.status,400);
 }finally{await x.close();}
});
test('removal reaches committed current state, historical state, event pages, cold restart and the browser reducer',{skip:!source},async()=>{
 const x=await setup();try{
  await x.app.handleSample(sample(1));await x.app.flushWorld();const head=x.app.world.revision.head;
  const removed=makeEnvelope('ENTITY_REMOVED',{runId:'fix-run',epoch:0,step:1,sequence:2,simTime:.02,simDt:0,frameId:'global',entityId:'vessel-1',source:'native',wireFormat:2});
  await x.app.handleSample(removed);await x.app.flushWorld();
  assert.equal((await x.app.world.snapshot()).frames.length,0);assert.equal((await x.app.world.snapshot({head,runId:'fix-run',epoch:0})).frames.length,1);
  assert.equal(x.app.world.world.entities().entities[0].deleted,true);
  const events=await(await fetch(x.base+'/api/world/events?runId=fix-run&epoch=0&direction=forward&limit=1')).json();assert.equal(events.events[0].type,'ENTITY_REMOVED');
  const state={requestedEntity:null,events:[]};applyNativeFrame(state,sample(1));assert.equal(applyNativeFrame(state,removed).removed,true);assert.equal(state.lastNative,null);
  const status=await(await fetch(x.base+'/api/status')).json();assert.equal(status.nativeLifecycleSupported,true);
  await assert.rejects(x.app.handleSample({...sample(1),epoch:0,sequence:1}),/duplicate|regressed/);
  await x.app.close();
  x.app=await createWorldServer({httpPort:0,bridgePort:0,dataDir:x.dir,osgWorldMode:true,osgMultiSourceDir:source});
  assert.equal((await x.app.world.snapshot()).frames.length,0);
  assert.equal((await x.app.world.snapshot({head,runId:'fix-run',epoch:0})).frames.length,1);
  assert.equal((await x.app.world.eventPage({runId:'fix-run',epoch:0,direction:'forward'})).events.some(e=>e.type==='ENTITY_REMOVED'),true);
 }finally{await x.close();}
});
test('native deletions work at an epoch boundary and cannot reopen an older epoch after the last entity is removed',{skip:!source},async()=>{
 const x=await setup();try{
  await x.app.handleSample(sample(1));await x.app.handleSample({...sample(2,'vessel-2'),step:1,simTime:.02});await x.app.flushWorld();
  const removed=makeEnvelope('ENTITY_REMOVED',{runId:'fix-run',epoch:1,step:0,sequence:1,simTime:0,simDt:0,frameId:'global',entityId:'vessel-1',source:'native',wireFormat:2});
  await x.app.handleSample(removed);
  await x.app.handleSample({...sample(2,'vessel-2'),epoch:1,step:1,simTime:.02});await x.app.flushWorld();
  assert.deepEqual((await x.app.world.snapshot()).frames.map(f=>f.sample.entityId),['vessel-2']);
  await x.app.handleSample({...removed,entityId:'vessel-2',step:1,sequence:3,simTime:.02});await x.app.flushWorld();
  assert.equal((await x.app.world.snapshot()).frames.length,0);
  await assert.rejects(x.app.handleSample(sample(3)),/regressed native epoch/);
 }finally{await x.close();}
});
