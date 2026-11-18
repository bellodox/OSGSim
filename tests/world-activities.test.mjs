// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorldServer} from '../apps/world-service/server.mjs';
import {makeEnvelope} from '../packages/world-protocol/index.mjs';
const source=process.env.OSG_MULTI_SOURCE_DIR;
const sample=(sequence,contact=false,runId='activity-run')=>makeEnvelope('PHYSICS_SAMPLE',{runId,epoch:0,step:sequence,sequence,simTime:sequence*.02,simDt:.02,frameId:'global',entityId:'vessel',source:'native',position:[100,0,0],velocity:[0,0,0],contact});
const start=(activityId,extra={})=>({sessionId:'session',requestId:activityId,activityId,action:'start',text:'Investigating contact',runId:'activity-run',epoch:0,expectedVersion:null,...extra});
test('authenticated peer activities coexist, pin dependencies, remain hypotheses and survive restart', {skip:source?false:'Set OSG_MULTI_SOURCE_DIR'},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'osgsim-activities-'));let app;
 const options={httpPort:0,bridgePort:0,dataDir:dir,osgWorldMode:true,osgMultiSourceDir:source,worldBatchMs:5000,worldClients:{A:'AAAAAAAAAAAAAAAA',B:'BBBBBBBBBBBBBBBB'}};
 try{
  app=await createWorldServer(options);let base=`http://127.0.0.1:${app.httpPort}`;
  const post=(token,input,origin)=>fetch(base+'/api/world/activities',{method:'POST',headers:{authorization:'Bearer '+token,...(origin?{origin}:{})},body:JSON.stringify(input)});
  await app.handleSample(sample(1));await app.flushWorld();
  const entity=app.world.world.entities().entities[0];
  const a=start('a',{actor:'B',status:'approved',requires:[{elementId:entity.elementId,version:entity.version}]});
  const replies=await Promise.all([post(options.worldClients.A,a),post(options.worldClients.B,start('b'))]);
  assert.deepEqual(replies.map(r=>r.status),[200,200]);const result=await replies[0].json();
  let list=await(await fetch(base+'/api/world/activities')).json();
  assert.equal(list.items.find(i=>i.activityId==='a').actor,'A');assert.ok(list.items.every(i=>i.status==='hypothesis'));
  assert.equal(list.items.find(i=>i.actor==='osg-host').state,'active');
  const pinned=list.head;
  await app.handleSample(sample(2,true));await app.flushWorld();
  assert.equal((await post(options.worldClients.A,start('stale',{requires:a.requires}))).status,409);
  assert.equal((await post(options.worldClients.A,a)).status,200,'retry remains idempotent after dependency advances');
  assert.equal((await post(options.worldClients.A,{...a,text:'different'})).status,409);
  assert.equal((await post('bad',start('bad'))).status,403);
  assert.equal((await post(options.worldClients.A,start('cross'),'https://bad.example')).status,403);
  assert.equal((await post(options.worldClients.A,start('unknown',{runId:'unknown'}))).status,400);
  const finished=await post(options.worldClients.A,start('finish',{activityId:'a',action:'finish',expectedVersion:result.version}));assert.equal(finished.status,200);
  const old=await(await fetch(base+'/api/world/activities?head='+pinned)).json();assert.equal(old.items.find(i=>i.activityId==='a').state,'active');
  await app.close();app=await createWorldServer(options);base=`http://127.0.0.1:${app.httpPort}`;
  list=await(await fetch(base+'/api/world/activities')).json();assert.equal(list.items.find(i=>i.activityId==='a').state,'finished');
  assert.equal(list.items.find(i=>i.actor==='osg-host').state,'finished');
  const retry=await(await post(options.worldClients.A,a)).json();assert.equal(retry.idempotent,true);
  const evidence=await(await fetch(base+'/api/observer-evidence?observer=A&time=10')).json();
  assert.equal(evidence.source,'osg');assert.ok(evidence.head);assert.equal(evidence.events.length,1);
  assert.equal((await(await fetch(base+'/api/status')).json()).version,'0.3.1-dev');
 }finally{await app?.close();await rm(dir,{recursive:true,force:true});}
});
test('observer evidence excludes uncommitted contacts and restart rejects run IDs present only in graph', {skip:source?false:'Set OSG_MULTI_SOURCE_DIR'},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'osgsim-evidence-graph-'));let app;
 const options={httpPort:0,bridgePort:0,dataDir:dir,osgWorldMode:true,osgMultiSourceDir:source,worldBatchMs:5000};
 try{
  app=await createWorldServer(options);const base=`http://127.0.0.1:${app.httpPort}`;
  await app.handleSample(sample(1));await app.flushWorld();await app.handleSample(sample(2,true));
  const pinned=app.world.revision.head;
  const before=await(await fetch(base+'/api/observer-evidence?observer=A&time=10')).json();assert.equal(before.events.length,0);
  await app.flushWorld();assert.equal((await(await fetch(base+'/api/observer-evidence?observer=A&time=10')).json()).events.length,1);
  const historical=await(await fetch(base+'/api/observer-evidence?observer=A&time=10&head='+pinned)).json();
  assert.equal(historical.events.length,0);assert.equal(historical.head,pinned);
  // Add a valid stream directly through OSG, absent from the legacy event journal.
  app.world.accept(sample(1,false,'graph-only-run'),[]);await app.world.flush();
  await app.close();app=await createWorldServer(options);
  await assert.rejects(app.handleSample(sample(1,false,'graph-only-run')),/recovered/);
 }finally{await app?.close();await rm(dir,{recursive:true,force:true});}
});
test('graph observer anchor stays on first stream sample when different entities update', {skip:source?false:'Set OSG_MULTI_SOURCE_DIR'},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'osgsim-anchor-'));let app;
 try{
  app=await createWorldServer({httpPort:0,bridgePort:0,dataDir:dir,osgWorldMode:true,osgMultiSourceDir:source,worldBatchMs:5000});
  await app.handleSample(sample(1));
  await app.handleSample({...sample(2),entityId:'other-vessel',position:[1000,0,0]});
  await app.handleSample(sample(3));await app.flushWorld();
  assert.deepEqual((await app.world.snapshot()).observerAnchor,[100,0,0]);
 }finally{await app?.close();await rm(dir,{recursive:true,force:true});}
});
