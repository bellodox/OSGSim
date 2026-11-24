// SPDX-License-Identifier: MIT
// Real local TCP/WebSocket relay proof: one signed OSG history survives producer
// shutdown and can be read by another simulator without inventing ROD authority.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RodNostrHistory} from '../OSGSim/apps/metaverse-native/v26/rod-game/nostr-history.mjs';
import {RelayPool} from '../OSGSim/apps/metaverse-native/v26/single-address/relay-pool.mjs';
import {pubkeyFromSecret} from './support/nostr-test-helpers.mjs';
import {eventGenesis,hashWorldDelta} from '../OSGSim/apps/metaverse-native/v26/world.mjs';
import {startNip01LoopbackRelay} from './support/nip01-loopback.mjs';
const W='a'.repeat(64),R='b'.repeat(64),ASSET='c'.repeat(64),A='1'.repeat(64),B='2'.repeat(64);
const graph=()=>({data:new Map(),get(id){return this.data.get(id)},async putMany(entries){for(const row of entries)this.data.set(row.id,structuredClone(row.value))}});
function events(n){let previous=eventGenesis(W);return Array.from({length:n},(_,i)=>{const e={worldId:W,sequence:i+1,previous,type:'ROD_PROJECTION',payload:{confirmedRoot:'f'.repeat(64),step:i+1}};e.hash=hashWorldDelta(e);previous=e.hash;return e})}
const makeWorld=records=>({state:{sequence:records.length},history:async(after)=>({events:records.filter(e=>e.sequence>after)})});
test('two actual NIP-01 relay sockets provide signed OSG catch-up after the original peer goes offline',async()=>{
 const records=events(3),dir=await mkdtemp(join(tmpdir(),'rod-nostr-dual-'));
 const first=await startNip01LoopbackRelay(),second=await startNip01LoopbackRelay();
 let producer=null,consumer=null,a=null,b=null;
 try{
  a=new RelayPool({urls:[first.url,second.url],secret:A});await a.connect(1500);
  producer=await new RodNostrHistory({world:makeWorld(records),graph:graph(),relay:a,rpc:async()=>{},secret:A,
   worldId:W,port:{slots:[]},assetRoot:ASSET,rodGenesis:R,dir:join(dir,'producer')}).init();
  assert.equal(producer.availableFrontier().sequence,0);
  // Commits are batched: three commits travel in one signed event per relay.
  assert.equal((await producer.publishPending()).acknowledged,1);
  assert.equal(producer.availableFrontier().eventHead,records[2].hash);
  assert.equal(first.history.filter(e=>e.kind===8427).length,1);
  assert.equal(second.history.filter(e=>e.kind===8427).length,1);
  await producer.close();producer=null;await a.close();a=null;
  b=new RelayPool({urls:[first.url,second.url],secret:B});await b.connect(1500);
  const target=graph();
  consumer=await new RodNostrHistory({world:makeWorld([]),graph:target,relay:b,rpc:async()=>{},secret:B,
   worldId:W,port:{slots:[]},assetRoot:ASSET,rodGenesis:R,dir:join(dir,'consumer')}).init();
  const author=pubkeyFromSecret(A);
  consumer.trustedAuthors=async()=>new Map([[author,{player:'p/alice',expectedSequence:3,expectedHead:records[2].hash}]]);
  const backfill=await consumer.pull({timeoutMs:2000});
  assert.equal(backfill.complete,true);
  assert.equal(backfill.frontiers[author].sequence,3);
  assert.equal(target.get(`metaverse:nostr:delta_${author}_000000000003`).delta.hash,records[2].hash);
  // A signed backup remains evidence; it must not change the ROD canonical root.
  assert.equal(target.get('metaverse:rod:frontier'),undefined);
 }finally{
  await consumer?.close();await producer?.close();await b?.close();await a?.close();
  await Promise.all([first.close(),second.close()]);await rm(dir,{recursive:true,force:true});
 }
});
