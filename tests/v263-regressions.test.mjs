// SPDX-License-Identifier: MIT
import test from 'node:test';
import {TestWorld} from './support/test-world.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hashWorldDelta,eventGenesis,worldRoot} from '../OSGSim/apps/metaverse-native/v26/world.mjs';
import {NostrMirror} from '../OSGSim/apps/metaverse-native/v26/nostr-mirror.mjs';
import {pubkeyFromSecret} from './support/nostr-test-helpers.mjs';
import {parseBrightonBase,stageScenario} from '../OSGSim/apps/metaverse-native/v26/spawn-ports.mjs';
const worldId='a'.repeat(64),clock={schema:1,simMjd0:51982.13,utcOriginMs:1700000000000,rate:1,era:1};
const port={...parseBrightonBase(await readFile(new URL('../fixtures/Brighton.cfg',import.meta.url),'utf8')),portId:'moon:brighton-beach',allowedClasses:['ShuttlePB']};
const wallets=['rFJtzkbeQ3dxWQg9G82LHMsPvrhSLMarJU','rDU1rhqDwG2arMnnGdEobtpGr4aMASKfXw','r3ceCnfVErYW5SfoMQGfG5kjdRDNqnfMBu'];
const graph=()=>({rows:new Map(),head:'a'.repeat(64),counter:0,get(id){return this.rows.get(id)},async put(id,v){return this.putMany([{id,value:v}])},async putMany(items){for(const item of items)this.rows.set(item.id,structuredClone(item.value));this.head=String(++this.counter).padStart(64,'0');}});
const fakeRpc=async(method)=>{if(['name_update','name_register'].includes(method))return 'a'.repeat(64);throw Error('unexpected_rpc');};
const makeEvent=(previous,sequence,payload)=>{const e={worldId,sequence,previous,type:'NATIVE_FRAME',payload};return {...e,hash:hashWorldDelta(e)}};
test('Nostr bounded batching never discards an OSG event when a pair exceeds the relay limit',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'spex-263-batch-')),secret='0'.repeat(63)+'3';
 try{
  const mirror=await new NostrMirror({worldId,file:join(dir,'mirror.jsonl'),secret,publisher:pubkeyFromSecret(secret),deltaBatchSize:2}).init();
  const e1=makeEvent(eventGenesis(worldId),1,{data:'x'.repeat(8500)}),e2=makeEvent(e1.hash,2,{data:'y'.repeat(8500)});
  mirror.queueDelta(e1);mirror.queueDelta(e2);
  assert.equal(mirror.pendingDeltas.length,1);
  mirror.flushDeltas();assert.deepEqual(mirror.contiguous(),{sequence:2,eventHead:e2.hash,missing:0});
  await mirror.close();const loaded=await new NostrMirror({worldId,file:join(dir,'mirror.jsonl'),publisher:pubkeyFromSecret(secret)}).init();
  assert.deepEqual(loaded.contiguous(),{sequence:2,eventHead:e2.hash,missing:0});await loaded.close();
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('Oversized single Nostr event fails without dropping unmirrored authoritative history',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'spex-263-oversize-')),secret='0'.repeat(63)+'3';
 try{
  const mirror=await new NostrMirror({worldId,file:join(dir,'mirror.jsonl'),secret,publisher:pubkeyFromSecret(secret),deltaBatchSize:1}).init();
  const e=makeEvent(eventGenesis(worldId),1,{data:'x'.repeat(17000)});
  assert.throws(()=>mirror.queueDelta(e),/nostr_single_delta_too_large/);
  assert.equal(mirror.pendingDeltas.length,1);
  assert.equal(mirror.contiguous().sequence,0);
  mirror.pendingDeltas.length=0;await mirror.close();
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('Native failures release ports and immutable history accepts nonzero dynamic actor IDs',async()=>{
 const w=new TestWorld({graph:graph(),rpc:fakeRpc,worldId,clock,port,now:()=>clock.utcOriginMs});await w.init();
 const f=await w.enroll({address:wallets[0],portId:port.portId,slot:'pad-1'});
 await w.nativeProof({observer:f.actor,actor:f.actor,eventId:f.eventId,kind:'owner',runId:'native-102-200',nativeName:f.nativeName,created:false,verifiedPort:false,simMjd:clock.simMjd0,runNonce:'new-run'});
 const a=await w.enroll({address:wallets[1],portId:port.portId,slot:'pad-1'}),b=await w.enroll({address:wallets[2],portId:port.portId,slot:'pad-2'});
 assert.equal(a.actor,'peer1');assert.equal(b.actor,'peer2');
 for(const [ship,run] of [[a,'native-103-201'],[b,'native-104-202']]){
  await w.nativeProof({observer:ship.actor,actor:ship.actor,eventId:ship.eventId,kind:'owner',runId:run,nativeName:ship.nativeName,created:true,verifiedPort:true,simMjd:clock.simMjd0,runNonce:'new-run'});
  await w.publish({actor:ship.actor,runId:run,sample:{type:'PHYSICS_SAMPLE',source:'native',entityName:ship.nativeName,runId:run,sequence:1,simMjd:clock.simMjd0,frameId:'metaverse-moon-relative-v26',position:[1,2,3],velocity:[0,0,0],orientation:[0,0,0,1],mode:'LANDED',surface:[0,0,0,2]}});
 }
 await w.nativeProof({observer:a.actor,actor:b.actor,eventId:b.eventId,kind:'remote',runId:'native-103-201',nativeName:b.nativeName,created:true,verifiedPort:true,simMjd:clock.simMjd0,runNonce:'new-run'});
 await w.nativeProof({observer:b.actor,actor:a.actor,eventId:a.eventId,kind:'remote',runId:'native-104-202',nativeName:a.nativeName,created:true,verifiedPort:true,simMjd:clock.simMjd0,runNonce:'new-run'});
 for(const [owner,other,run] of [[a,b,'native-103-201'],[b,a,'native-104-202']]){
  await w.sceneProof({observer:owner.actor,target:other.actor,runId:run,sceneSha256:'a'.repeat(64),cameraSha256:'b'.repeat(64),nativeNames:[a.nativeName,b.nativeName],cameraTarget:other.nativeName,simMjd:clock.simMjd0,runNonce:'new-run'});
 }
 const snapshot=await w.snapshot();assert.deepEqual(Object.keys(snapshot.ships).sort(),['peer1','peer2']);assert.equal(snapshot.root,worldRoot(snapshot));
 const events=await w.history(0,500);assert.equal(events.events.length,events.sequence);assert.equal(events.eventHead,w.state.eventHead);
});
test('Scenario staging is idempotent for identical run and refuses different reuse',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'spex-263-scene-'));
 try{
  const file=join(dir,'native.scn'),template=join(dir,'template.scn');
  const {writeFile}=await import('node:fs/promises');await writeFile(template,'BEGIN_ENVIRONMENT\n Date MJD 51982.1301160012\nEND_ENVIRONMENT\nBEGIN_FOCUS\n Ship Glider\nEND_FOCUS\nBEGIN_CAMERA\n TARGET Glider\nEND_CAMERA\nBEGIN_SHIPS\nGlider:ShuttlePB\n STATUS Orbiting Moon\nEND\nEND_SHIPS\n');
  const ship={actor:'peer1',nativeName:'Glider-Peer1',vesselClass:'ShuttlePB',asset:'ship:peer1',eventId:'c'.repeat(64),portId:port.portId,slot:'pad-2'};
  const opts={templateFile:template,outputFile:file,spawn:ship,port,simMjd:51982.14};
  const a=await stageScenario(opts),b=await stageScenario(opts);assert.equal(a.sha256,b.sha256);
  await assert.rejects(stageScenario({...opts,simMjd:51982.15}),/spawn_scenario_run_nonce_collision/);
 }finally{await rm(dir,{recursive:true,force:true})}
});
