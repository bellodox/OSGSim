// SPDX-License-Identifier: MIT
// v26.8.7 end-to-end: two full peers (OSG world + ROD sync + publisher + Nostr live lane)
// over a mock ROD node and a real WebSocket relay. No Windows/native process.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {TestRod,W,ASSET,GAME,ADDR1,ADDR2,port,graph} from './support/rod-fixture.mjs';
import {startNip01LoopbackRelay} from './support/nip01-loopback.mjs';
import {RodGameSync} from '../OSGSim/apps/metaverse-native/v26/rod-game/sync.mjs';
import {RodGamePublisher} from '../OSGSim/apps/metaverse-native/v26/rod-game/publisher.mjs';
import {DistributedV26World} from '../OSGSim/apps/metaverse-native/v26/rod-game/world-adapter.mjs';
import {LiveLane,bindingResolver} from '../OSGSim/apps/metaverse-native/v26/rod-game/live-lane.mjs';
import {RelayPool} from '../OSGSim/apps/metaverse-native/v26/single-address/relay-pool.mjs';
import {generateSecret,publicKey} from '../OSGSim/apps/metaverse-native/v26/single-address/crypto.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn,ms=4000)=>{const t=Date.now();for(;;){const v=await fn();if(v)return v;if(Date.now()-t>ms)throw Error('timeout waiting for condition');await sleep(15)}};

const build=async({network,clock,fake,relayUrl,dir})=>{
 const mkPeer=async({player,address})=>{
  const g=graph(),rpc=network.rpc(address),secret=generateSecret();let lane=null;
  const world=new DistributedV26World({graph:g,rpc,worldId:W,clock,port,now:()=>fake.t});await world.init();
  const sync=new RodGameSync({rpc,world:W,game:GAME,port,clock,assetRoot:ASSET,graph:g,startHeight:1,
   materialize:p=>{lane?.observeProjection(p);return world.importRodProjection(p,{localPlayer:player});}});
  const relay=new RelayPool({urls:[relayUrl],secret});await relay.connect(1500);
  lane=new LiveLane({relay,secret,world:W,clock,now:()=>fake.t,minIntervalMs:0,resolve:bindingResolver(()=>sync.projection)});
  await sync.start({subscribe:false});world.setLiveSource(()=>lane.frames());lane.start();
  const publisher=await new RodGamePublisher({rpc,world:W,game:GAME,player,ownerAddress:address,clockEra:1,source:sync,filename:join(dir,player.slice(2)+'.json'),lane,nostrPubkey:publicKey(secret),checkpointMs:1e9}).init();
  world.onCommit=async(_s,e)=>publisher.capture(e);world.onLiveFrame=frame=>publisher.captureFrame(frame);
  return{player,address,g,rpc,world,sync,relay,lane,publisher,secret,
   async close(){lane.stop();await publisher.close();await sync.close();await relay.close();}};
 };
 return{a:await mkPeer({player:'p/alice',address:ADDR1}),b:await mkPeer({player:'p/bob',address:ADDR2})};
};
const framesInPool=(network,player)=>network.pool.filter(tx=>tx.vout[0].scriptPubKey.nameOp.name===player&&JSON.parse(tx.vout[0].scriptPubKey.nameOp.value).g[GAME].kind==='frame').length;
const movesInPool=(network,player,kind)=>network.pool.filter(tx=>tx.vout[0].scriptPubKey.nameOp.name===player&&JSON.parse(tx.vout[0].scriptPubKey.nameOp.value).g[GAME].kind===kind).length;

test('end to end: discover-less two-peer world joins on ROD, moves over the Nostr lane, checkpoints, survives outage and reorg',async()=>{
 const T0=Date.now(),fake={t:T0},clock={schema:1,utcOriginMs:T0-5000,simMjd0:51982.1301160012,rate:1,era:1};
 const mjd=t=>clock.simMjd0+(t-clock.utcOriginMs)/86400000;
 const network=new TestRod({clock}),relay=await startNip01LoopbackRelay(),dir=await mkdtemp(join(tmpdir(),'v2687-e2e-'));
 let peers=null;
 try{
  peers=await build({network,clock,fake,relayUrl:relay.url,dir});const {a,b}=peers;
  const reconcileAll=async why=>{await a.sync.reconcile(why);await b.sync.reconcile(why)};
  // 1. Joins: wallet-signed moves carry each peer's Nostr key; confirmed order assigns actors and slots.
  await a.publisher.pump();await b.publisher.pump();await reconcileAll('mempool');
  assert.equal(a.sync.projection.order.length,0,'joins are not final in the mempool');
  network.mine();await reconcileAll('block');
  assert.deepEqual(a.sync.projection.order,['p/alice','p/bob']);
  assert.equal(a.sync.projection.confirmedRoot,b.sync.projection.confirmedRoot,'both OSG replicas derive the same ROD root');
  assert.equal(a.sync.projection.confirmed.actors['p/alice'].nostr,publicKey(a.secret));
  assert.equal(a.sync.projection.confirmed.actors['p/alice'].joinHeight,network.height);
  const shipA=a.sync.projection.actors['p/alice'].ship,shipB=a.sync.projection.actors['p/bob'].ship;
  // 2. Native spawn acknowledgements become owner proofs on ROD.
  const run=ship=>'native-'+ship.actor;
  for(const [peer,ship] of [[a,shipA],[b,shipB]])await peer.world.nativeProof({observer:ship.actor,actor:ship.actor,eventId:ship.eventId,kind:'owner',nativeName:ship.nativeName,runId:run(ship),runNonce:'t',created:true,simMjd:mjd(fake.t),verifiedPort:true});
  await a.publisher.pump();await b.publisher.pump();await reconcileAll('pending');network.mine();await reconcileAll('block');
  assert.equal(b.sync.projection.actors['p/alice'].ownerProof.runId,run(shipA));
  const rootBefore=(await b.world.snapshot()).root;
  // 3. Live motion: alice flies; bob's lane shows each sample within the same second, far below one ROD block.
  const sample=(ship,seq,t,pos)=>({type:'PHYSICS_SAMPLE',source:'native',entityName:ship.nativeName,runId:run(ship),sequence:seq,simMjd:mjd(t),frameId:'metaverse-moon-relative-v26',mode:'FREEFLIGHT',surface:[0,0,0,0],position:pos,velocity:[2,0,0],orientation:[0,0,0,1],capturedAtUnixMs:t});
  let latency=0;
  for(let seq=1;seq<=12;seq++){
   fake.t=T0+seq*300;await a.world.publish({actor:shipA.actor,runId:run(shipA),sample:sample(shipA,seq,fake.t,[100+seq*0.6,0,0])});
   const sentAt=Date.now();await until(()=>b.world.liveFramesView()[shipA.actor]?.seq===seq);latency=Math.max(latency,Date.now()-sentAt);
   await a.publisher.pump({intervalMs:0});
  }
  assert.ok(latency<1000,'lane delivery latency '+latency+' ms');
  const live=b.world.liveFramesView()[shipA.actor];assert.equal(live.frame.sample.sequence,12);
  assert.equal((await b.world.snapshot()).root,rootBefore,'live frames do not touch the OSG root');
  // 4. ROD frames are a slow baseline while the lane carries motion (12 samples, 1 baseline frame move).
  assert.equal(framesInPool(network,'p/alice'),1,'ROD carried only the baseline frame');
  // 5. Checkpoint on ROD commits the lane head; the other peer verifies it against what it saw.
  await a.sync.reconcile('pending');a.publisher.checkpointMs=0;await a.publisher.pump({intervalMs:0});assert.equal(movesInPool(network,'p/alice','checkpoint'),1);
  network.mine();await reconcileAll('block');
  const cp=b.sync.projection.confirmed.actors['p/alice'].checkpoint;
  assert.equal(cp.seq,12);assert.equal(cp.digest,a.lane.out.digest);assert.deepEqual(b.lane.status().fraud,[]);
  assert.equal(a.sync.projection.confirmedRoot,b.sync.projection.confirmedRoot);
  // 6. A forged lane event from bob's key claiming alice's actor changes nothing.
  const countBefore=b.lane.counters.accepted;
  const impostor=new LiveLane({relay:b.relay,secret:b.secret,world:W,clock,now:()=>fake.t,minIntervalMs:0,resolve:()=>null});
  fake.t+=300;impostor.publish({actor:shipA.actor,eventId:shipA.eventId,runId:run(shipA),sample:sample(shipA,13,fake.t,[500,0,0])});
  await sleep(150);assert.equal(a.lane.counters.rejected.pubkey_not_bound_to_actor,1,'alice rejects bob signing as alice');
  assert.equal(b.world.liveFramesView()[shipA.actor].seq,12);assert.equal(b.lane.counters.accepted,countBefore,'bob accepted nothing from the impostor');
  // 7. Relay outage: ROD takes over at the normal cadence, motion is still committed, nothing throws.
  await relay.close();
  await until(()=>b.relay.connectedCount===0&&a.relay.connectedCount===0,3000);
  assert.equal(a.lane.healthy(),false);
  const framesBefore=framesInPool(network,'p/alice');
  fake.t+=600;await a.world.publish({actor:shipA.actor,runId:run(shipA),sample:sample(shipA,14,fake.t,[140,0,0])});
  await a.publisher.pump({intervalMs:0});
  assert.equal(framesInPool(network,'p/alice'),framesBefore+1,'fallback: ROD frame sent immediately while the lane is down');
  network.mine();await reconcileAll('block');
  assert.equal(b.sync.projection.actors['p/alice'].frame.sample.sequence,14,'bob still receives alice through ROD alone');
  // 8. Reorg: the block with alice's frame is orphaned; both peers converge again without manual repair.
  network.reorg();await reconcileAll('reorg');
  assert.equal(a.sync.projection.confirmedRoot,b.sync.projection.confirmedRoot);
  assert.deepEqual(a.sync.projection.order,['p/alice','p/bob']);
 }finally{
  await peers?.a.close();await peers?.b.close();await relay.close().catch(()=>{});await rm(dir,{recursive:true,force:true});
 }
});
