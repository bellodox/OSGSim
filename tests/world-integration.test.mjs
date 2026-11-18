// SPDX-License-Identifier: MIT
// Real OSG/LanceDB, synthetic physical inputs: not a new Windows SDK acceptance claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorldServer} from '../apps/world-service/server.mjs';
import {makeEnvelope} from '../packages/world-protocol/index.mjs';
import {worldFrames} from '../apps/observer/world-state.mjs';
import {applyNativeFrame} from '../apps/observer/native-state.mjs';
const source=process.env.OSG_MULTI_SOURCE_DIR;
const sample=(seq,contact=false,epoch=0)=>makeEnvelope('PHYSICS_SAMPLE',{runId:'world-test-run',epoch,step:seq,sequence:seq,simTime:seq*.02,simDt:.02,frameId:'metaverse-global-ecliptic',entityId:'vessel-A',source:'native',position:[149e9+seq/100,0,0],velocity:[.5,0,0],orientation:[0,0,0,1],angularVelocity:[0,0,0],contact});
async function until(fn){for(let i=0;i<300;i++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('timed out');}
test('browser graph snapshot resets before states and retains historical contacts',()=>{
 const state={requestedEntity:null,events:[]};
 const frames=worldFrames({type:'OSG_WORLD_SNAPSHOT',runId:'world-test-run',epoch:0,frames:[{sample:{...sample(2,true),type:'WORLD_INIT'}}],events:[{type:'SIMULATION_RESET',runId:'world-test-run',epoch:0},{type:'CONTACT_BEGIN',runId:'world-test-run',epoch:0,entityId:'vessel-A'}]});
 for(const f of frames)applyNativeFrame(state,f);
 assert.equal(state.lastNative.step,2);assert.equal(frames.at(-1).type,'CONTACT_BEGIN');
});
test('genuine OSG becomes observer source, supports revision-pinned history, concurrent agents and cold restart',{skip:source?false:'Set OSG_MULTI_SOURCE_DIR to the built experimental OSG checkout'},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'osgsim-world-'));
 let app;const sockets=[];
 const options={httpPort:0,bridgePort:0,dataDir:directory,osgMultiSourceDir:source,osgWorldMode:true,worldBatchMs:5000,worldClients:{'agent-A':'AAAAAAAAAAAAAAAA','browser-B':'BBBBBBBBBBBBBBBB'}};
 try{
  app=await createWorldServer(options);let base=`http://127.0.0.1:${app.httpPort}`;
  const messages=Array.from({length:3},()=>[]);
  for(const list of messages){const ws=new WebSocket(`ws://127.0.0.1:${app.httpPort}/ws`);sockets.push(ws);ws.onmessage=e=>list.push(JSON.parse(e.data));}
  await until(()=>messages.every(m=>m.length));
  await app.handleSample(sample(1));await app.handleSample(sample(2,true));
  assert.equal((await(await fetch(base+'/api/state')).json()).state,null,'ingress must not bypass OSG');
  await app.flushWorld();const first=app.world.revision.head;
  await until(()=>messages.every(m=>m.some(x=>x.type==='OSG_WORLD_UPDATE')));
  for(const m of messages){assert.ok(!m.some(x=>x.type==='PHYSICS_SAMPLE'));assert.ok(m.some(x=>x.head===first));}
  const live=await(await fetch(base+'/api/state')).json();assert.equal(live.source,'osg');assert.equal(live.state.step,2);
  await app.handleSample(sample(3,false));await app.flushWorld();
  const old=await(await fetch(base+`/api/world/state?head=${first}&runId=world-test-run&epoch=0&timeMicros=20000`)).json();
  assert.equal(old.frames[0].sample.step,1);assert.equal(old.events.length,0);
  const head=app.world.revision.head;
  const write=token=>fetch(base+'/api/world/annotations',{method:'POST',headers:{authorization:'Bearer '+token},body:JSON.stringify({id:'note',text:'inspect landing',expectedHead:head,status:'approved'})});
  const replies=await Promise.all([write('AAAAAAAAAAAAAAAA'),write('BBBBBBBBBBBBBBBB')]);assert.deepEqual(replies.map(r=>r.status).sort(),[200,409]);
  const notes=await(await fetch(base+'/api/world/annotations')).json();assert.equal(notes.items.length,1);assert.equal(notes.items[0].status,'hypothesis');
  assert.equal((await write('bad')).status,403);
  assert.equal((await fetch(base+'/api/world/annotations',{method:'POST',headers:{authorization:'Bearer AAAAAAAAAAAAAAAA',origin:'https://other.example'},body:'{}'})).status,403);
  const history=await(await fetch(base+'/api/world/history')).json();assert.equal(history.streams[0].samples,3);
  for(const ws of sockets)ws.close();sockets.length=0;
  await app.close();app=await createWorldServer(options);base=`http://127.0.0.1:${app.httpPort}`;
  const cold=await(await fetch(base+'/api/world/state')).json();assert.equal(cold.frames[0].sample.step,3);assert.equal(cold.events.filter(e=>e.type==='CONTACT_BEGIN').length,1);
  assert.deepEqual(cold.origins['vessel-A'],sample(1).position);
  assert.equal((await(await fetch(base+'/api/status')).json()).samplesAccepted,0,'cold query does not require ingestion memory');
  const partial={...sample(1),runId:'new-run'};delete partial.angularVelocity;delete partial.orientation;
  await app.handleSample(partial);await app.flushWorld();assert.equal(app.world.world.streams().streams.length,2);
  const priorAsset=app.world.world.streams(first).streams[0];assert.equal(priorAsset.runId,'world-test-run');
 }finally{for(const ws of sockets)ws.close();await app?.close();await rm(directory,{recursive:true,force:true});}
});
test('graph asset corruption rejects reconstruction and missing external checkout never falls back',{skip:source?false:'Set OSG_MULTI_SOURCE_DIR to the built experimental OSG checkout'},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'osgsim-world-corrupt-'));let app;
 try{
  await assert.rejects(createWorldServer({httpPort:0,bridgePort:0,dataDir:directory,osgWorldMode:true}),/requires/);
  await assert.rejects(createWorldServer({httpPort:0,bridgePort:0,dataDir:directory,osgWorldMode:true,osgSourceDir:source}),/OSG_MULTI_SOURCE_DIR/);
  app=await createWorldServer({httpPort:0,bridgePort:0,dataDir:directory,osgMultiSourceDir:source,osgWorldMode:true});
  await app.handleSample(sample(1));await app.flushWorld();
  const rows=await app.world.store.rows(),hash=JSON.parse(rows.find(r=>r.kind==='world_segment').props).assetHash;
  await writeFile(join(directory,'assets',hash.slice(0,2),hash),'corruption');
  const response=await fetch(`http://127.0.0.1:${app.httpPort}/api/world/state`);assert.equal(response.status,400);assert.match((await response.json()).error,/hash mismatch/);
 }finally{await app?.close();await rm(directory,{recursive:true,force:true});}
});
test('scheduled batching publishes without manual flush and graph failure never exposes ingress',{skip:source?false:'Set OSG_MULTI_SOURCE_DIR to the built experimental OSG checkout'},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'osgsim-world-schedule-'));let app;
 try{
  app=await createWorldServer({httpPort:0,bridgePort:0,dataDir:directory,osgMultiSourceDir:source,osgWorldMode:true,worldBatchMs:25});
  await app.handleSample(sample(1));await until(()=>app.world.world.streams().streams[0]?.samples===1);await app.flushWorld();
  assert.equal((await app.world.snapshot()).frames[0].sample.step,1);
  const prior=app.world.revision.head;
  app.world.store.publish=async()=>false; // fault injection at the real graph publication boundary
  await app.handleSample(sample(2));await assert.rejects(app.flushWorld(),/Head changed/);
  assert.equal(app.world.revision.head,prior);assert.ok(app.world.fault);
  assert.equal((await app.world.snapshot()).frames[0].sample.step,1);
 }finally{await app?.close();await rm(directory,{recursive:true,force:true});}
});
