// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RodNostrHistory} from '../OSGSim/apps/metaverse-native/v26/rod-game/nostr-history.mjs';
import {pubkeyFromSecret,signNostrEvent} from './support/nostr-test-helpers.mjs';
import {eventGenesis,hashWorldDelta} from '../OSGSim/apps/metaverse-native/v26/world.mjs';
const W='a'.repeat(64),R='b'.repeat(64),ASSET='c'.repeat(64),secretA='1'.repeat(64),secretB='2'.repeat(64);
const pubB=pubkeyFromSecret(secretB);
const graph=()=>({values:new Map(),get(id){return this.values.get(id)},async putMany(entries){for(const {id,value} of entries)this.values.set(id,structuredClone(value))}});
const makeDeltas=n=>{let previous=eventGenesis(W);return Array.from({length:n},(_,i)=>{const e={worldId:W,sequence:i+1,previous,type:'NATIVE_SAMPLE',payload:{step:i+1}};e.hash=hashWorldDelta(e);previous=e.hash;return e})};
const signedHistory=(deltas,secret=secretB)=>deltas.map((delta,i)=>signNostrEvent({secret,kind:8427,tags:[['w',W],['s',String(delta.sequence)]],
 content:JSON.stringify({schema:1,worldId:W,events:[delta]}),created_at:1800000000+i}));
class ReplayRelay{
 constructor(events=[]){this.events=events;this.sent=[];this.calls=[]}
 subscribe(filters,onEvent){this.calls.push(filters);const f=filters[0];for(const e of this.events.filter(x=>(!f.authors||f.authors.includes(x.pubkey))&&
 (!f.kinds||f.kinds.includes(x.kind))&&(!f.until||x.created_at<=f.until)&&(!f['#w']||x.tags.some(t=>t[0]==='w'&&f['#w'].includes(t[1])))&&(!f['#s']||x.tags.some(t=>t[0]==='s'&&f['#s'].includes(t[1]))))
 .sort((a,b)=>b.created_at-a.created_at).slice(0,f.limit??500))onEvent(e);
 return {eose:async()=>true,close(){}}}
 async publish(e){this.sent.push(e);return true}
}
const context=async({remoteEvents=[],maxImport=10,pageSize=2,deltaBatchSize=1}={})=>{
 const dir=await mkdtemp(join(tmpdir(),'spex-osg-nostr-repair-'));
 const g=graph(),relay=new ReplayRelay(remoteEvents);
 const history=new RodNostrHistory({world:{state:{sequence:0},history:async()=>({events:[]})},graph:g,relay,rpc:async()=>{},
  secret:secretA,worldId:W,port:{slots:[]},assetRoot:ASSET,rodGenesis:R,dir,maxImport,pageSize,deltaBatchSize});
 await history.init();return{dir,g,relay,history,async close(){await history.close();await rm(dir,{recursive:true,force:true})}};
};
test('Nostr slow sync paginates per ROD-bound author, stores signed immutable delta evidence and verifies advertised frontier',async()=>{
 const deltas=makeDeltas(5),events=signedHistory(deltas),c=await context({remoteEvents:events});
 try{
  c.history.trustedAuthors=async()=>new Map([[pubB,{player:'p/bob',expectedSequence:5,expectedHead:deltas[4].hash}]]);
  const result=await c.history.pull();assert.equal(result.complete,true);
  assert.equal(result.frontiers[pubB].sequence,5);
  assert.equal(c.g.get(`metaverse:nostr:delta_${pubB}_000000000005`).eventId,events[4].id);
  assert.ok(c.relay.calls.some(c=>Number.isInteger(c[0].until)),'historical pages requested');
  const again=await c.history.pull();assert.equal(again.complete,true);
 }finally{await c.close()}
});
test('bounded Nostr slow sync reports incomplete history and resumes from a durable OSG cursor across cycles',async()=>{
 const deltas=makeDeltas(5),c=await context({remoteEvents:signedHistory(deltas),maxImport:2,pageSize:2});
 try{
  c.history.trustedAuthors=async()=>new Map([[pubB,{player:'p/bob',expectedSequence:5,expectedHead:deltas[4].hash}]]);
  const a=await c.history.pull();assert.equal(a.complete,false);
  assert.ok(c.g.get(`metaverse:nostr:page_cursor_${pubB}`));
  let d=await c.history.pull();
  for(let round=0;round<6&&!d.complete;round++)d=await c.history.pull();
  assert.equal(d.complete,true);
  assert.equal(d.frontiers[pubB].eventHead,deltas.at(-1).hash);
 }finally{await c.close()}
});
test('Nostr slow sync does not confuse ROD-bound authorship with relay signatures or accept an incorrect head',async()=>{
 const deltas=makeDeltas(2),good=signedHistory(deltas),bad=structuredClone(good[1]);bad.content='{}';
 const c=await context({remoteEvents:[good[0],bad]});
 try{
  c.history.trustedAuthors=async()=>new Map([[pubB,{player:'p/bob',expectedSequence:2,expectedHead:deltas[1].hash}]]);
  const result=await c.history.pull();assert.equal(result.complete,false);
  assert.ok(c.g.get(`metaverse:nostr:delta_${pubB}_000000000001`));
  assert.equal(c.g.get(`metaverse:nostr:delta_${pubB}_000000000002`),undefined);
 }finally{await c.close()}
});

test('Nostr advertisement frontier never advances beyond relay-acknowledged contiguous OSG commits',async()=>{
 const deltas=makeDeltas(3),c=await context();
 try{
  c.history.world={state:{sequence:deltas.length},history:async(after)=>({events:deltas.filter(e=>e.sequence>after)})};
  await c.history.captureMissing();c.history.flushAll();await c.history.local.queue;
  assert.equal(c.history.status().local.sequence,3,'full local flight recorder survives relay loss');
  assert.deepEqual(c.history.availableFrontier(),{sequence:0,eventHead:eventGenesis(W)});
  const publish=c.relay.publish.bind(c.relay);
  c.relay.publish=async()=>{throw Error('relay-offline')};
  const failed=await c.history.publishPending();
  assert.equal(failed.acknowledged,0);
  assert.equal(c.history.availableFrontier().sequence,0,'an offline relay is not an acknowledged backup');
  c.relay.publish=publish;
  const sent=await c.history.publishPending({max:1});
  assert.equal(sent.acknowledged,1);
  assert.equal(c.history.availableFrontier().sequence,1);
  // Crashes must not forget which signed batches were acknowledged, and
  // must never re-sign the same event under a new timestamp.
  await c.history.close();
  const restored=new RodNostrHistory({world:c.history.world,graph:c.g,relay:c.relay,rpc:c.history.rpc,
   secret:secretA,worldId:W,port:{slots:[]},assetRoot:ASSET,rodGenesis:R,dir:c.dir});
  await restored.init();
  assert.equal(restored.availableFrontier().sequence,1);
  await restored.publishPending();
  assert.equal(restored.availableFrontier().sequence,3);
  assert.equal(restored.availableFrontier().eventHead,deltas[2].hash);
  await restored.close();
 }finally{await c.close()}
});

test('Nostr history recovers every signed batch when many commits have the same one-second timestamp',async()=>{
 const deltas=makeDeltas(6);
 const events=signedHistory(deltas).map(event=>signNostrEvent({secret:secretB,kind:8427,
  tags:event.tags,content:event.content,created_at:1800000000}));
 const c=await context({remoteEvents:events,maxImport:10,pageSize:2});
 try{
  c.history.trustedAuthors=async()=>new Map([[pubB,{player:'p/bob',expectedSequence:6,expectedHead:deltas[5].hash}]]);
  let result=await c.history.pull();
  for(let i=0;i<4&&!result.complete;i++)result=await c.history.pull();
  assert.equal(result.complete,true,'same-second timestamp collisions cannot silently skip older batches');
  assert.equal(result.frontiers[pubB].eventHead,deltas[5].hash);
  assert.ok(c.relay.calls.some(filters=>Array.isArray(filters[0]['#s'])),'signed sequence tag queries recover collision gaps');
  for(let i=1;i<=6;i++)assert.ok(c.g.get(`metaverse:nostr:delta_${pubB}_${String(i).padStart(12,'0')}`));
 }finally{await c.close()}
});

test('duplicate re-signatures of identical Nostr evidence never create duplicate OSG writes',async()=>{
 const delta=makeDeltas(1)[0];
 const copies=[1800000000,1800000001].map(created_at=>signNostrEvent({secret:secretB,kind:8427,
  tags:[['w',W],['s','1']],content:JSON.stringify({schema:1,worldId:W,events:[delta]}),created_at}));
 const c=await context({remoteEvents:copies,maxImport:6,pageSize:3});
 try{
  c.history.trustedAuthors=async()=>new Map([[pubB,{player:'p/bob',expectedSequence:1,expectedHead:delta.hash}]]);
  const result=await c.history.pull();
  assert.equal(result.complete,true);
  const key=`metaverse:nostr:delta_${pubB}_000000000001`;
  assert.equal(c.g.get(key).delta.hash,delta.hash);
  assert.equal([...c.g.values.keys()].filter(id=>id===key).length,1);
 }finally{await c.close()}
});
