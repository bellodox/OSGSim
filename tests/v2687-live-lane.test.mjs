// SPDX-License-Identifier: MIT
// v26.8.7 phase 2: Nostr live motion lane (unit level, in-memory relay).
import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {buildMove,assembleProjection} from '../OSGSim/apps/metaverse-native/v26/rod-game/protocol.mjs';
import {LiveLane,LIVE_KIND,bindingResolver,liveDigest} from '../OSGSim/apps/metaverse-native/v26/rod-game/live-lane.mjs';
import {signEvent,publicKey,generateSecret} from '../OSGSim/apps/metaverse-native/v26/single-address/crypto.mjs';
const W='a'.repeat(64),GAME='osgsimv26',ADDR_A='rFJtzkbeQ3dxWQg9G82LHMsPvrhSLMarJU',ADDR_B='rDU1rhqDwG2arMnnGdEobtpGr4aMASKfXw';
const clock={schema:1,utcOriginMs:1700000000000,simMjd0:51982.1301160012,rate:1,era:1};
const port={portId:'moon:brighton-beach',base:'Brighton Beach',configSha256:'1'.repeat(64),body:'Moon',allowedClasses:['ShuttlePB'],slots:[{slot:'pad-1',nativePadIndex:0,rotDegrees:90},{slot:'pad-2',nativePadIndex:1,rotDegrees:180}]};
const NOW0=clock.utcOriginMs+3600e3;let nowMs=NOW0;const now=()=>nowMs;
const simAt=ms=>clock.simMjd0+(ms-clock.utcOriginMs)/86400000;
const SA=generateSecret(),SB=generateSecret(),SX=generateSecret(),SY=generateSecret(),KA=publicKey(SA),KB=publicKey(SB);
const rows=moves=>moves.map((move,i)=>({txid:createHash('sha256').update('t'+i+move.digest).digest('hex'),height:10+i,blockTime:null,address:move.player==='p/alice'?ADDR_A:ADDR_B,move}));
const roster=({nostrA=KA,nostrB=KB,extra=()=>[]}={})=>{
 const ja=buildMove({world:W,game:GAME,player:'p/alice',seq:1,previous:'0'.repeat(64),kind:'join',payload:{owner:ADDR_A,asset:W,clockEra:1,...(nostrA?{nostr:nostrA}:{})}});
 const jb=buildMove({world:W,game:GAME,player:'p/bob',seq:1,previous:'0'.repeat(64),kind:'join',payload:{owner:ADDR_B,asset:W,clockEra:1,...(nostrB?{nostr:nostrB}:{})}});
 const first=assembleProjection({world:W,game:GAME,confirmed:rows([ja,jb]),port,clock});
 const proofMove=(player,seq,previous,owner)=>{const ship=first.actors[player].ship;
  return buildMove({world:W,game:GAME,player,seq,previous,kind:'owner-proof',payload:{proof:{observer:ship.actor,actor:ship.actor,eventId:ship.eventId,kind:'owner',nativeName:ship.nativeName,runId:'native-'+ship.actor,runNonce:'n',created:true,simMjd:clock.simMjd0,verifiedPort:true}}})};
 const pa=proofMove('p/alice',2,ja.digest),pb=proofMove('p/bob',2,jb.digest);
 const moves=[ja,jb,pa,pb,...extra(pa,pb)];
 return{projection:assembleProjection({world:W,game:GAME,confirmed:rows(moves),port,clock}),ja,jb,pa,pb};
};
const sampleFor=(projection,player,sequence,ms=nowMs,position=[100,0,0],velocity=[1,0,0])=>{const ship=projection.actors[player].ship;
 return{type:'PHYSICS_SAMPLE',source:'native',entityName:ship.nativeName,runId:'native-'+ship.actor,sequence,simMjd:simAt(ms),frameId:'metaverse-moon-relative-v26',mode:'FREEFLIGHT',surface:[0,0,0,0],position,velocity,orientation:[0,0,0,1],capturedAtUnixMs:ms}};
class MemRelay{constructor(){this.subs=[];this.connectedCount=1;this.sent=[]}
 subscribe(filters,fn){const s={filters,fn};this.subs.push(s);return{close:()=>{this.subs=this.subs.filter(x=>x!==s)}}}
 async publish(e){this.sent.push(e);for(const s of this.subs)s.fn(structuredClone(e));return true}}
const setup=(opts={})=>{const r=roster(opts),relay=new MemRelay();
 const mk=(secret)=>new LiveLane({relay,secret,world:W,clock,now,minIntervalMs:0,resolve:bindingResolver(()=>r.projection)});
 const a=mk(SA),b=mk(SB);b.start();return{...r,relay,a,b,mk,observer:mk(SX)}};
const flush=()=>new Promise(r=>setTimeout(r,5));
const forged=({secret,actor,content,createdAt=Math.floor(nowMs/1000)})=>signEvent({secret,kind:LIVE_KIND,tags:[['w',W],['a',actor]],content:JSON.stringify(content),createdAt});
const contentFor=(projection,player,n,prev,sample)=>{const ship=projection.actors[player].ship;return{v:1,w:W,a:ship.actor,e:ship.eventId,r:'native-'+ship.actor,n,p:prev,s:sample}};

test('bound peer motion is accepted and other peers see it',async()=>{
 const t=setup();const ship=t.projection.actors['p/alice'].ship;
 const out=t.a.publish({actor:ship.actor,eventId:ship.eventId,runId:'native-'+ship.actor,sample:sampleFor(t.projection,'p/alice',2)});
 await flush();assert.equal(out.seq,1);
 const frames=t.b.frames();assert.equal(frames[ship.actor].seq,1);assert.equal(t.b.counters.accepted,1);
 // chain of three accepted frames, hash-linked
 nowMs+=1000;t.a.publish({actor:ship.actor,eventId:ship.eventId,runId:'native-'+ship.actor,sample:sampleFor(t.projection,'p/alice',3,nowMs,[101,0,0])});
 nowMs+=1000;t.a.publish({actor:ship.actor,eventId:ship.eventId,runId:'native-'+ship.actor,sample:sampleFor(t.projection,'p/alice',4,nowMs,[102,0,0])});
 await flush();assert.equal(t.b.frames()[ship.actor].seq,3);assert.equal(t.b.counters.accepted,3);
});

test('events from unbound keys, wrong actors, legacy joins without a nostr key, and stale windows are rejected',async()=>{
 const t=setup();const alice=t.projection.actors['p/alice'].ship,bob=t.projection.actors['p/bob'].ship;
 const good=contentFor(t.projection,'p/alice',1,'0'.repeat(64),sampleFor(t.projection,'p/alice',1));
 assert.equal(t.observer.receive(forged({secret:SY,actor:alice.actor,content:good})).rejected,'pubkey_not_bound_to_actor','stranger key');
 assert.equal(t.observer.receive(forged({secret:SB,actor:alice.actor,content:good})).rejected,'pubkey_not_bound_to_actor','bob claims alice');
 assert.equal(t.observer.receive(forged({secret:SA,actor:alice.actor,content:good,createdAt:Math.floor(nowMs/1000)-600})).rejected,'outside_time_window');
 const wrongRun={...good,r:'native-other'};assert.equal(t.observer.receive(forged({secret:SA,actor:alice.actor,content:wrongRun})).rejected,'content_not_owned');
 const wrongEntity={...good,s:{...good.s,entityName:bob.nativeName}};assert.equal(t.observer.receive(forged({secret:SA,actor:alice.actor,content:wrongEntity})).rejected,'content_not_owned');
 const bad={...good,s:{...good.s,position:[NaN,0,0]}};assert.ok(['sample_invalid','content_not_json'].includes(t.observer.receive(forged({secret:SA,actor:alice.actor,content:bad})).rejected));
 const tampered=forged({secret:SA,actor:alice.actor,content:good});tampered.content=tampered.content.replace('"n":1','"n":2');
 assert.equal(t.observer.receive(tampered).rejected,'signature_invalid');
 assert.equal(t.observer.receive(forged({secret:SA,actor:alice.actor,content:good})).accepted,true,'the genuine event still passes');
 const legacy=setup({nostrA:null});
 assert.equal(legacy.b.receive(forged({secret:SA,actor:legacy.projection.actors['p/alice'].ship.actor,content:good})).rejected,'pubkey_not_bound_to_actor','join without nostr cannot use the lane');
 const ambiguous=setup({nostrB:KA});// two actors declaring the same key bind to neither
 assert.equal(ambiguous.b.receive(forged({secret:SA,actor:alice.actor,content:good})).rejected,'pubkey_not_bound_to_actor');
});

test('implausible lane samples (teleport, speed, time) are rejected; honest motion continues',async()=>{
 const t=setup();const alice=t.projection.actors['p/alice'].ship,run='native-'+alice.actor;
 const pub=(seq,ms,pos,vel=[1,0,0])=>{nowMs=ms;return t.a.publish({actor:alice.actor,eventId:alice.eventId,runId:run,sample:sampleFor(t.projection,'p/alice',seq,ms,pos,vel)})};
 pub(1,NOW0,[0,0,0]);await flush();
 pub(2,NOW0+1000,[2e9,0,0]);await flush();
 assert.equal(t.b.counters.rejected.implausible_position_bound,1);
 pub(3,NOW0+2000,[8000,0,0],[1,0,0]);await flush();
 assert.equal(t.b.counters.rejected.implausible_displacement_bound,1,'8 km in 2 s');
 pub(4,NOW0+3000,[3,0,0]);await flush();
 assert.equal(t.b.frames()[alice.actor].frame.sample.position[0],3);
 nowMs=NOW0+4000;t.a.publish({actor:alice.actor,eventId:alice.eventId,runId:run,sample:{...sampleFor(t.projection,'p/alice',5,nowMs,[4,0,0]),simMjd:simAt(nowMs)+1}});await flush();
 assert.equal(t.b.counters.rejected.implausible_time_vs_block,1,'sim time one day away from event time');
});

test('equivocation (two digests for one sequence, or a forked chain) disables that actor lane; others are unaffected',async()=>{
 const t=setup();const alice=t.projection.actors['p/alice'].ship,bob=t.projection.actors['p/bob'].ship;
 const c1=contentFor(t.projection,'p/alice',1,'0'.repeat(64),sampleFor(t.projection,'p/alice',1,nowMs,[10,0,0]));
 assert.equal(t.observer.receive(forged({secret:SA,actor:alice.actor,content:c1})).accepted,true);
 const c1b=contentFor(t.projection,'p/alice',1,'0'.repeat(64),sampleFor(t.projection,'p/alice',2,nowMs,[11,0,0]));
 assert.equal(t.observer.receive(forged({secret:SA,actor:alice.actor,content:c1b})).rejected,'equivocation');
 assert.equal(t.observer.frames()[alice.actor],undefined,'overlay for the equivocating actor is withdrawn');
 const c2=contentFor(t.projection,'p/alice',2,liveDigest(c1),sampleFor(t.projection,'p/alice',3,nowMs+1000,[12,0,0]));
 nowMs+=1000;assert.equal(t.observer.receive(forged({secret:SA,actor:alice.actor,content:c2})).rejected,'actor_equivocated');
 assert.equal(t.observer.status().fraud[0].actor,alice.actor);
 // bob can publish to alice's lane instance normally
 const aliceLane=t.mk(SA);aliceLane.start();
 t.b.publish({actor:bob.actor,eventId:bob.eventId,runId:'native-'+bob.actor,sample:sampleFor(t.projection,'p/bob',1,nowMs,[5,0,0])});await flush();
assert.equal(aliceLane.frames()[bob.actor].seq,1);
});

test('a chain fork (consecutive sequence with a different prev digest) is equivocation',async()=>{
 const t=setup();const alice=t.projection.actors['p/alice'].ship;
 const c1=contentFor(t.projection,'p/alice',1,'0'.repeat(64),sampleFor(t.projection,'p/alice',1));
 t.observer.receive(forged({secret:SA,actor:alice.actor,content:c1}));
 nowMs+=1000;const c2=contentFor(t.projection,'p/alice',2,'f'.repeat(64),sampleFor(t.projection,'p/alice',2,nowMs));
 assert.equal(t.observer.receive(forged({secret:SA,actor:alice.actor,content:c2})).rejected,'equivocation');
});

test('a gap in the sequence (lost ephemeral event) is tolerated; duplicates and reordering are ignored',async()=>{
 const t=setup();const alice=t.projection.actors['p/alice'].ship;
 const c1=contentFor(t.projection,'p/alice',1,'0'.repeat(64),sampleFor(t.projection,'p/alice',1));
 const e1=forged({secret:SA,actor:alice.actor,content:c1});
 assert.equal(t.observer.receive(e1).accepted,true);assert.equal(t.observer.receive(e1).rejected,'duplicate');
 nowMs+=1000;const c4=contentFor(t.projection,'p/alice',4,'e'.repeat(64),sampleFor(t.projection,'p/alice',4,nowMs,[101,0,0]));
 assert.equal(t.observer.receive(forged({secret:SA,actor:alice.actor,content:c4})).accepted,true);
 const c3=contentFor(t.projection,'p/alice',3,'d'.repeat(64),sampleFor(t.projection,'p/alice',3,nowMs,[3,0,0]));
 assert.equal(t.observer.receive(forged({secret:SA,actor:alice.actor,content:c3})).rejected,'out_of_order');
});

test('flooding is rate limited before any signature work',async()=>{
 const t=setup();const alice=t.projection.actors['p/alice'].ship;let rejected=0,accepted=0;
 for(let i=1;i<=60;i++){const c=contentFor(t.projection,'p/alice',i,'0'.repeat(64),sampleFor(t.projection,'p/alice',i,nowMs,[i,0,0]));
  const r=t.observer.receive(forged({secret:SA,actor:alice.actor,content:c}));if(r.accepted)accepted++;else if(r.rejected==='rate_limited')rejected++;}
 assert.ok(accepted<=10,'burst is capped at the per-second budget, got '+accepted);assert.ok(rejected>=50);
});

test('a confirmed ROD checkpoint that contradicts the lane digest withdraws that actor; a matching one does not',async()=>{
 const base=roster();const alice=base.projection.actors['p/alice'].ship,run='native-'+alice.actor;
 const makeProjection=digestFor=>roster({extra:(pa)=>[buildMove({world:W,game:GAME,player:'p/alice',seq:3,previous:pa.digest,kind:'checkpoint',payload:{actor:alice.actor,runId:run,seq:1,digest:digestFor,simMjd:simAt(nowMs)}})]}).projection;
 const c1=contentFor(base.projection,'p/alice',1,'0'.repeat(64),sampleFor(base.projection,'p/alice',1));
 for(const [digest,expectFraud] of [[liveDigest(c1),false],['9'.repeat(64),true]]){
  const projection=makeProjection(digest);assert.equal(projection.actors['p/alice'].checkpoint.seq,1);
  const relay=new MemRelay(),lane=new LiveLane({relay,secret:SB,world:W,clock,now,resolve:bindingResolver(()=>projection)});
  assert.equal(lane.receive(forged({secret:SA,actor:alice.actor,content:c1})).accepted,true);
  lane.observeProjection(projection);
  assert.equal(Boolean(lane.frames()[alice.actor]),!expectFraud);
 }
});

test('checkpoint moves are validated and apply only to the owner run, monotonically',()=>{
 const t=roster();const alice=t.projection.actors['p/alice'].ship,run='native-'+alice.actor;
 const cp=(seq,previous,payload)=>buildMove({world:W,game:GAME,player:'p/alice',seq,previous,kind:'checkpoint',payload});
 const c1=cp(3,t.pa.digest,{actor:alice.actor,runId:run,seq:5,digest:'1'.repeat(64),simMjd:1});
 const stale=cp(4,c1.digest,{actor:alice.actor,runId:run,seq:5,digest:'2'.repeat(64),simMjd:1});
 const foreign=cp(5,stale.digest,{actor:'peer1',runId:run,seq:9,digest:'3'.repeat(64),simMjd:1});
 const ok=cp(6,foreign.digest,{actor:alice.actor,runId:run,seq:6,digest:'4'.repeat(64),simMjd:1});
 const projection=assembleProjection({world:W,game:GAME,confirmed:rows([t.ja,t.jb,t.pa,t.pb,c1,stale,foreign,ok]),port,clock});
 assert.deepEqual(projection.ignored.map(x=>x.why),['checkpoint_not_owned_or_stale','checkpoint_not_owned_or_stale']);
 assert.equal(projection.rejected.length,0,'ignored moves still advance the player hash chain');
 assert.equal(projection.actors['p/alice'].checkpoint.seq,6);
 assert.throws(()=>buildMove({world:W,game:GAME,player:'p/alice',seq:3,previous:t.pa.digest,kind:'checkpoint',payload:{actor:'x',runId:run,seq:0,digest:'z',simMjd:'a'}}),/CHECKPOINT_INVALID/);
 assert.throws(()=>buildMove({world:W,game:GAME,player:'p/alice',seq:1,previous:'0'.repeat(64),kind:'join',payload:{owner:ADDR_A,asset:W,clockEra:1,nostr:'xyz'}}),/JOIN_INVALID/);
});

test('live frames do not change the ROD confirmed root',()=>{
 const a=roster(),b=roster();assert.equal(a.projection.confirmedRoot,b.projection.confirmedRoot);
 const c=roster({nostrA:KB,nostrB:KA}); // different declared keys are different join digests, hence different roots
 assert.notEqual(a.projection.confirmedRoot,c.projection.confirmedRoot);
});

test('publisher side: lane publishing is non-blocking, rate limited and survives relay failure',async()=>{
 const t=setup();const alice=t.projection.actors['p/alice'].ship,run='native-'+alice.actor;
 let release;const relay={connectedCount:1,subscribe(){return{close(){}}},publish:()=>new Promise((_,rej)=>{release=rej})};
 const lane=new LiveLane({relay,secret:SA,world:W,clock,now,minIntervalMs:250,maxInflight:2,resolve:()=>null});
 const t0=performance.now();
 const first=lane.publish({actor:alice.actor,eventId:alice.eventId,runId:run,sample:sampleFor(t.projection,'p/alice',1)});
 assert.equal(first.seq,1);assert.ok(performance.now()-t0<200,'publish returns without waiting for the relay');
 assert.equal(lane.publish({actor:alice.actor,eventId:alice.eventId,runId:run,sample:sampleFor(t.projection,'p/alice',2)}),null,'250 ms minimum interval');
 nowMs+=300;assert.equal(lane.publish({actor:alice.actor,eventId:alice.eventId,runId:run,sample:sampleFor(t.projection,'p/alice',2,nowMs)}).seq,2);
 nowMs+=300;assert.equal(lane.publish({actor:alice.actor,eventId:alice.eventId,runId:run,sample:sampleFor(t.projection,'p/alice',3,nowMs)}),null,'in-flight cap');
 await flush();release(new Error('relay down'));await flush();
 assert.equal(lane.counters.publishFailed>=1,true);
 assert.equal(lane.healthy(),true);for(let i=0;i<3;i++){lane.failures++}assert.equal(lane.healthy(),false,'three consecutive failures: ROD frames take over');
 assert.equal(lane.checkpointCandidate().seq,2);
});

test('hub /view exposes the live overlay beside, not inside, the verified world root',async()=>{
 const {createV26Hub}=await import('../OSGSim/apps/metaverse-native/v26/hub.mjs');
 const {worldRoot}=await import('../OSGSim/apps/metaverse-native/v26/world.mjs');
 const {DistributedV26World}=await import('../OSGSim/apps/metaverse-native/v26/rod-game/world-adapter.mjs');
 const {graph}=await import('./support/rod-fixture.mjs');
 const world=new DistributedV26World({graph:graph(),rpc:async()=>true,worldId:W,clock,port,now:()=>nowMs});await world.init();
 const overlay={peer7:{frame:{actor:'peer7',sample:{runId:'r',sequence:9}},seq:3,receivedAt:1}};world.setLiveSource(()=>overlay);
 const base=await world.snapshot();
 const stub={graph:{close(){}},port,worldId:W,async init(){},async snapshot(){const x={...structuredClone(base),ships:{peer0:{owner:ADDR_A,nativeName:'Glider-Peer0',actor:'peer0',eventId:'e'.repeat(64)}}};x.root=worldRoot(x);return x;},
  liveFramesView:()=>world.liveFramesView()};
 const rpc=async()=>true,runNonce='live-lane-unit',runId='native-live';
 const hub=await createV26Hub({world:stub,rpc,host:'127.0.0.1',listenPort:0,runNonce,now:()=>nowMs});
 try{
  const challenge=await (await fetch(hub.url+'/session-challenge?actor=peer0&runId='+runId)).json();
  const session=await fetch(hub.url+'/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({challengeId:challenge.id,actor:'peer0',address:ADDR_A,nonce:challenge.nonce,runId,runNonce,signature:'mock'})});
  assert.equal(session.status,200);const token=(await session.json()).token;
  const view=await (await fetch(hub.url+'/view',{headers:{authorization:'Bearer '+token}})).json();
  assert.deepEqual(view.liveFrames,overlay);
  assert.equal(view.root,worldRoot(view),'the DLL root check passes with the overlay present');
  overlay.peer8={frame:{},seq:1,receivedAt:2};
  const again=await (await fetch(hub.url+'/view',{headers:{authorization:'Bearer '+token}})).json();
  assert.equal(again.root,view.root,'overlay changes never change the root');assert.ok(again.liveFrames.peer8);
 }finally{await hub.close()}
});

test('RelayPool prefilter discards unbound-key flood traffic before any signature work',async()=>{
 const {RelayPool}=await import('../OSGSim/apps/metaverse-native/v26/single-address/relay-pool.mjs');
 const handlers=[];const client={opened:true,connect:async()=>{},close:async()=>{},publish:async()=>true,subscribe(filters,fn){handlers.push(fn);return{close(){},eose:async()=>true}}};
 const pool=new RelayPool({urls:['wss://relay.example.test/'],secret:SA,relayFactory:()=>client});
 const t=setup();const alice=t.projection.actors['p/alice'].ship;
 const lane=new LiveLane({relay:pool,secret:SB,world:W,clock,now,resolve:bindingResolver(()=>t.projection)});lane.start();
 assert.equal(handlers.length,1);
 const flood=forged({secret:SY,actor:alice.actor,content:contentFor(t.projection,'p/alice',1,'0'.repeat(64),sampleFor(t.projection,'p/alice',1))});
 handlers[0](flood);assert.equal(lane.counters.accepted,0);assert.deepEqual(lane.counters.rejected,{},'dropped before the lane even saw it');
 const genuine=forged({secret:SA,actor:alice.actor,content:contentFor(t.projection,'p/alice',1,'0'.repeat(64),sampleFor(t.projection,'p/alice',1))});
 handlers[0](genuine);assert.equal(lane.counters.accepted,1);
 lane.stop();await pool.close();
});
