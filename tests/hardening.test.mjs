import test from 'node:test';
import {TestWorld} from './support/test-world.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {canonicalWorldManifest,CRITICAL} from '../OSGSim/apps/metaverse-native/v26/world-manifest.mjs';
import {validateWorld,worldRoot} from '../OSGSim/apps/metaverse-native/v26/world.mjs';
import {parseBrightonBase} from '../OSGSim/apps/metaverse-native/v26/spawn-ports.mjs';
import {verifyNostrEvent,pubkeyFromSecret} from './support/nostr-test-helpers.mjs';
import {NostrMirror} from '../OSGSim/apps/metaverse-native/v26/nostr-mirror.mjs';
const fakeGraph=()=>({rows:new Map(),head:'a'.repeat(64),commits:0,get(k){return this.rows.get(k)},async put(k,v){return this.putMany([{id:k,value:v}])},async putMany(items){for(const {id,value} of items)this.rows.set(id,structuredClone(value));this.head=String(++this.commits).padStart(64,'0')}});
const ownerA='rFJtzkbeQ3dxWQg9G82LHMsPvrhSLMarJU',ownerB='rDU1rhqDwG2arMnnGdEobtpGr4aMASKfXw';
const clock={schema:1,utcOriginMs:1700000000000,simMjd0:51982.1301160012,rate:1,era:1};
const worldId='b'.repeat(64);
const base=await readFile(new URL('../fixtures/Brighton.cfg',import.meta.url),'utf8');
const all={...parseBrightonBase(base),portId:'moon:brighton-beach',allowedClasses:['ShuttlePB']};
const port={...all,slots:all.slots.slice(0,2)};
const fakeRpc=async(method)=>{if(method==='name_register'||method==='name_update')return 'c'.repeat(64);throw Error('unexpected_rpc_'+method)};
async function initialized(){const world=new TestWorld({graph:fakeGraph(),rpc:fakeRpc,worldId,clock,port,now:()=>clock.utcOriginMs});await world.init();return world;}
test('Canonical Metaverse world identity covers the physics/content files, executables and port, not the SpeXGSP plugin',async()=>{
 assert.ok(CRITICAL.length>=84);
 for(const p of ['Config/Moon/Base/Brighton.cfg','Modules/Server/SpaceXpanse.exe','Meshes/ShuttlePB.msh'])assert.ok(CRITICAL.includes(p),p);
 assert.equal(CRITICAL.includes('Modules/Plugin/SpeXGSP.dll'),false,'a plugin build must not change the universe');
 const dir=await mkdtemp(join(tmpdir(),'spex-manifest-'));
 try{for(const p of CRITICAL){const f=join(dir,p);await mkdir(dirname(f),{recursive:true});await writeFile(f,Buffer.from(`sample-${p}`))}
  const a=await canonicalWorldManifest(dir);assert.equal(a.manifest.files.length,CRITICAL.length);
  await writeFile(join(dir,'Config/Moon.cfg'),'tampered');const b=await canonicalWorldManifest(dir);assert.notEqual(a.worldId,b.worldId);
  await rm(join(dir,'Modules/Server/SpaceXpanse.exe'));await assert.rejects(canonicalWorldManifest(dir),/ENOENT/);
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('World state refuses conflicting or invented vessel occupancy',async()=>{
 const w=await initialized();const a=await w.enroll({address:ownerA,portId:port.portId,slot:'pad-1'});
 assert.equal(a.actor,'peer0');const state=await w.snapshot();const bad=structuredClone(state);bad.ships.peer1={...bad.ships.peer0,actor:'peer1'};
 assert.throws(()=>validateWorld(bad),/corrupt_osg_ship_registry/);assert.notEqual(worldRoot(state),worldRoot({...state,clock:{...clock,rate:2}}));
});
test('Failed native spawn stays failed and cannot unlock frame publication',async()=>{
 const w=await initialized();const ship=await w.enroll({address:ownerA,portId:port.portId,slot:'pad-1'});
 const failed=await w.nativeProof({observer:'peer0',actor:'peer0',eventId:ship.eventId,kind:'owner',nativeName:ship.nativeName,runId:'native-1-2',created:false,verifiedPort:false,simMjd:clock.simMjd0});
 assert.equal(failed.created,false);
 await assert.rejects(w.publish({actor:'peer0',runId:'native-1-2',sample:{}}),/native_owner_not_ready|unknown_or_invalid_owner/);
});
test('Valid owner and remote creation proofs are required before a native camera proof',async()=>{
 const w=await initialized();const a=await w.enroll({address:ownerA,portId:port.portId,slot:'pad-1'});const b=await w.enroll({address:ownerB,portId:port.portId,slot:'pad-2'});
 const scene={observer:'peer0',target:'peer1',runId:'native-1-2',sceneSha256:'a'.repeat(64),cameraSha256:'b'.repeat(64),nativeNames:[a.nativeName,b.nativeName],cameraTarget:b.nativeName,simMjd:clock.simMjd0};
 await assert.rejects(w.sceneProof(scene),/missing_native_vessel_acks/);
 await w.nativeProof({observer:'peer0',actor:'peer0',eventId:a.eventId,kind:'owner',nativeName:a.nativeName,runId:scene.runId,created:true,verifiedPort:true,simMjd:clock.simMjd0});
 await assert.rejects(w.sceneProof(scene),/missing_native_vessel_acks/);
 await w.nativeProof({observer:'peer1',actor:'peer1',eventId:b.eventId,kind:'owner',nativeName:b.nativeName,runId:'native-2-3',created:true,verifiedPort:true,simMjd:clock.simMjd0});
 await w.nativeProof({observer:'peer0',actor:'peer1',eventId:b.eventId,kind:'remote',nativeName:b.nativeName,runId:scene.runId,created:true,verifiedPort:true,simMjd:clock.simMjd0});
 await w.sceneProof(scene);assert.equal((await w.snapshot()).proofs['scene:peer0:peer1'].sceneSha256,scene.sceneSha256);
});
test('Native physics rejects stale MJD, invalid vectors and duplicate steps',async()=>{
 const w=await initialized();const ship=await w.enroll({address:ownerA,portId:port.portId,slot:'pad-1'});
 await w.nativeProof({observer:'peer0',actor:'peer0',eventId:ship.eventId,kind:'owner',nativeName:ship.nativeName,runId:'native-1-2',created:true,verifiedPort:true,simMjd:clock.simMjd0});
 const valid={type:'PHYSICS_SAMPLE',source:'native',entityName:ship.nativeName,runId:'native-1-2',sequence:1,simMjd:clock.simMjd0,frameId:'metaverse-moon-relative-v26',position:[1,2,3],velocity:[0,0,0],orientation:[0,0,0,1],mode:'FREEFLIGHT',surface:[0,0,0,0]};
 await assert.rejects(w.publish({actor:'peer0',runId:'native-1-2',sample:{...valid,simMjd:valid.simMjd+1}}),/clock_out_of_bounds/);
 await assert.rejects(w.publish({actor:'peer0',runId:'native-1-2',sample:{...valid,position:[Number.MAX_VALUE,2,3]}}),/invalid_native_physics_vectors/);
 await assert.rejects(w.publish({actor:'peer0',runId:'native-1-2',sample:{...valid,orientation:[1,1,0,0]}}),/invalid_native_orientation/);
 await w.publish({actor:'peer0',runId:'native-1-2',sample:valid});
 assert.equal((await w.publish({actor:'peer0',runId:'native-1-2',sample:valid})).idempotent,true);
 await assert.rejects(w.publish({actor:'peer0',runId:'native-1-2',sample:{...valid,position:[2,2,3]}}),/stale_native_physics/);
});
test('V26 OSG failed graph write cannot expose uncommitted vessel',async()=>{
 const graph=fakeGraph(),world=new TestWorld({graph,rpc:fakeRpc,worldId,clock,port,now:()=>clock.utcOriginMs});await world.init();const before=(await world.snapshot()).root;
 const goodPut=graph.putMany;graph.putMany=async()=>{throw Error('database_unavailable')};
 await assert.rejects(world.enroll({address:ownerA,portId:port.portId,slot:'pad-1'}),/database_unavailable/);
 assert.equal((await world.snapshot()).root,before);assert.equal(Object.keys((await world.snapshot()).ships).length,0);
 graph.putMany=goodPut;await world.enroll({address:ownerA,portId:port.portId,slot:'pad-1'});assert.equal(Object.keys((await world.snapshot()).ships).length,1);
});
test('A delta batch signed by another key is refused by a publisher-bound mirror',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'spex-nostr-'));
 try{const secret='0'.repeat(63)+'3',pub=pubkeyFromSecret(secret);
  const m=await new NostrMirror({worldId,file:join(folder,'mirror.jsonl'),publisher:pub}).init();
  const wrong=await new NostrMirror({worldId,file:join(folder,'other.jsonl'),secret:'0'.repeat(63)+'4'}).init();
  const {eventGenesis,hashWorldDelta}=await import('../OSGSim/apps/metaverse-native/v26/world.mjs');
  const delta={worldId,sequence:1,previous:eventGenesis(worldId),type:'X',payload:{}};delta.hash=hashWorldDelta(delta);
  wrong.queueDelta(delta);const event=wrong.flushDeltas();
  assert.ok(verifyNostrEvent(event));assert.throws(()=>m.accept(event),/untrusted_nostr_event/);await m.close();await wrong.close();
 }finally{await rm(folder,{recursive:true,force:true})}
});
