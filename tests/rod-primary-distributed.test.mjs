// SPDX-License-Identifier: MIT
// Two independent ROD RPC endpoints and OSG databases, no Nostr transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {buildMove,validateMove,parseRodTx,assembleProjection,gameGenesis} from '../OSGSim/apps/metaverse-native/v26/rod-game/protocol.mjs';
import {RodGameSync} from '../OSGSim/apps/metaverse-native/v26/rod-game/sync.mjs';
import {RodGamePublisher} from '../OSGSim/apps/metaverse-native/v26/rod-game/publisher.mjs';
import {DistributedV26World} from '../OSGSim/apps/metaverse-native/v26/rod-game/world-adapter.mjs';
import {worldRoot} from '../OSGSim/apps/metaverse-native/v26/world.mjs';
import {enrollMessage} from '../OSGSim/apps/metaverse-native/v26/hub.mjs';
import {createLocalNativeEndpoint} from '../OSGSim/apps/metaverse-native/v26/rod-game/local-endpoint.mjs';
const W='a'.repeat(64),ASSET='d'.repeat(64),GEN='b'.repeat(64),ADDR1='rFJtzkbeQ3dxWQg9G82LHMsPvrhSLMarJU',ADDR2='rDU1rhqDwG2arMnnGdEobtpGr4aMASKfXw',GAME='osgsimv26';
const clock={schema:1,utcOriginMs:1700000000000,simMjd0:51982.1301160012,rate:1,era:1};
const port={portId:'moon:brighton-beach',base:'Brighton Beach',configSha256:'1'.repeat(64),body:'Moon',allowedClasses:['ShuttlePB'],slots:[{slot:'pad-1',nativePadIndex:0,rotDegrees:90},{slot:'pad-2',nativePadIndex:1,rotDegrees:180}]};
const hash=s=>createHash('sha256').update(s).digest('hex');
const graph=()=>({values:new Map(),head:'c'.repeat(64),get(k){return this.values.get(k)},async put(k,v){return this.putMany([{id:k,value:v}])},async putMany(arr){for(const {id,value} of arr)this.values.set(id,structuredClone(value));this.head='c'+hash(JSON.stringify([...this.values])).slice(0,64);return this.head}});
class TestRod{
 constructor(){this.height=1;this.counter=0;this.chain=[{hash:GEN,tx:[]},{hash:'1'.repeat(64),tx:[]}];this.pool=[];this.txMap=new Map();this.owners={'p/alice':ADDR1,'p/bob':ADDR2}}
 rpc(address){return async(method,args=[])=>{
  switch(method){
   case 'getblockchaininfo':return{chain:'regtest',blocks:this.height,bestblockhash:this.chain[this.height].hash};
   case 'getblockhash':return this.chain[args[0]]?.hash??(()=>{throw Error('unknown_height')})();
   case 'getblock':return{tx:this.chain.find(x=>x.hash===args[0])?.tx??[]};
   case 'getrawmempool':return this.pool.map(x=>x.txid);
   case 'getrawtransaction':{const t=this.txMap.get(args[0]);if(!t)throw Object.assign(Error('unknown tx'),{code:-5});return t}
   case 'gettransaction':{const txid=args[0],at=this.chain.findIndex(b=>b.tx.some(x=>x.txid===txid));return{confirmations:at<0?0:this.height-at,blockhash:at<0?null:this.chain[at].hash};}
   case 'name_show':{const name=args[0];if(name==='g/'+GAME)return{address:ADDR1,height:1,txid:'7'.repeat(64),value:JSON.stringify(gameGenesis({world:W,assetRoot:ASSET,port,clock,rodGenesis:GEN}))};if(this.owners[name]){const last=[...this.chain].reverse().flatMap(b=>b.tx).reverse().find(tx=>tx.vout?.[0]?.scriptPubKey?.nameOp?.name===name);
    return{address:this.owners[name],height:last?this.height:1,txid:last?.txid??'8'.repeat(64),
     value:last?.vout[0].scriptPubKey.nameOp.value??JSON.stringify({schema:'spexgsp/player/1',worldId:W})};}throw Error('name missing')}
   case 'getaddressinfo': case 'validateaddress':return{ismine:args[0]===address};
   case 'name_pending':return this.pool.filter(tx=>tx.vout?.[0]?.scriptPubKey?.nameOp?.name===args[0]).map(tx=>({name:args[0],value:tx.vout[0].scriptPubKey.nameOp.value,txid:tx.txid}));
   case 'name_update':{
    const [player,value]=args;if(this.owners[player]!==address)throw Error('wallet_wrong_owner');const move=JSON.parse(value).g[GAME];validateMove(move,{world:W,game:GAME});
    const txid=hash('TX'+(++this.counter)+value);const previous=[...this.pool].reverse().find(x=>x.vout[0].scriptPubKey.nameOp.name===player);
    const tx={txid,vin:previous?[{txid:previous.txid,vout:0}]:[],vout:[{n:0,scriptPubKey:{nameOp:{op:'name_update',name:player,value},address}}]};this.pool.push(tx);this.txMap.set(txid,tx);return txid;
   }
   case 'signmessage':return Buffer.from(args[1]).toString('base64');
   case 'verifymessage':return args[1]===Buffer.from(args[2]).toString('base64');
   default:throw Error('unknown_mock_rod_rpc_'+method);
  }
 }}
 mine(){this.height++;const b={hash:hash('block'+this.height+JSON.stringify(this.pool)),tx:this.pool};this.chain.push(b);this.pool=[];return b}
 reorg(){if(this.chain.length<3)throw Error('no block to orphan');this.chain.pop();this.height--;this.chain.push({hash:hash('alternative'+this.height),tx:[]});this.height++}
}
const fixture=async()=>{const network=new TestRod(),dir=await mkdtemp(join(tmpdir(),'rod-osg-primary-'));const g0=graph(),g1=graph();const r0=network.rpc(ADDR1),r1=network.rpc(ADDR2);const w0=new DistributedV26World({graph:g0,rpc:r0,worldId:W,clock,port,now:()=>clock.utcOriginMs});const w1=new DistributedV26World({graph:g1,rpc:r1,worldId:W,clock,port,now:()=>clock.utcOriginMs});await w0.init();await w1.init();const s0=new RodGameSync({rpc:r0,world:W,game:GAME,port,clock,assetRoot:ASSET,graph:g0,startHeight:1,materialize:p=>w0.importRodProjection(p,{localPlayer:'p/alice'})});const s1=new RodGameSync({rpc:r1,world:W,game:GAME,port,clock,assetRoot:ASSET,graph:g1,startHeight:1,materialize:p=>w1.importRodProjection(p,{localPlayer:'p/bob'})});await s0.start({subscribe:false});await s1.start({subscribe:false});const p0=await new RodGamePublisher({rpc:r0,world:W,game:GAME,player:'p/alice',ownerAddress:ADDR1,clockEra:1,source:s0,filename:join(dir,'alice.json')}).init();const p1=await new RodGamePublisher({rpc:r1,world:W,game:GAME,player:'p/bob',ownerAddress:ADDR2,clockEra:1,source:s1,filename:join(dir,'bob.json')}).init();w0.onCommit=async(_snap,e)=>p0.capture(e);w1.onCommit=async(_snap,e)=>p1.capture(e);
 return{network,dir,g0,g1,r0,r1,w0,w1,s0,s1,p0,p1,async close(){await s0.close();await s1.close();await p0.close();await p1.close();await rm(dir,{recursive:true,force:true})}};
};
test('ROD game protocol rejects foreign, oversized and fabricated moves',()=>{
 const m=buildMove({world:W,game:GAME,player:'p/alice',seq:1,previous:'0'.repeat(64),kind:'join',payload:{owner:ADDR1,asset:W,clockEra:1}});
 assert.equal(validateMove(m,{world:W,game:GAME}),m);assert.throws(()=>validateMove({...m,digest:'f'.repeat(64)}),/INVALID/);assert.throws(()=>validateMove(m,{world:'0'.repeat(64),game:GAME}),/FOREIGN/);
 const tx={txid:'2'.repeat(64),vout:[{n:0,scriptPubKey:{nameOp:{op:'name_update',name:'p/alice',value:JSON.stringify({g:{[GAME]:m}})},address:ADDR1}}]};assert.equal(parseRodTx(tx,{world:W,game:GAME}).length,1);tx.vout[0].scriptPubKey.address=ADDR2;assert.equal(parseRodTx(tx,{world:W,game:GAME}).length,0);
 const oversized='x'.repeat(2200);assert.throws(()=>buildMove({world:W,game:GAME,player:'p/alice',seq:1,previous:'0'.repeat(64),kind:'join',payload:{owner:ADDR1,asset:W,clockEra:1,extra:oversized}}),/TOO_LARGE/);
});
test('two independent persistent OSG stores converge from ROD game moves',async()=>{
 const f=await fixture();try{
  await f.p0.pump();await f.p1.pump();await f.s0.reconcile('mempool');await f.s1.reconcile('mempool');
  assert.equal(f.s0.projection.order.length,0,'mempool joins do not assign permanent actor IDs');
  f.network.mine();await f.s0.reconcile('block');await f.s1.reconcile('block');
  assert.equal(f.s0.projection.confirmedRoot,f.s1.projection.confirmedRoot);
  assert.deepEqual(f.s0.projection.order,['p/alice','p/bob']);
  const alice=f.s0.projection.actors['p/alice'].ship,bob=f.s1.projection.actors['p/bob'].ship;
  assert.equal(alice.actor,'peer0');assert.equal(bob.actor,'peer1');assert.equal(alice.eventId,f.s1.projection.actors['p/alice'].ship.eventId);
  assert.equal((await f.w0.snapshot()).ships.peer1.nativeName,'Glider-Peer1');assert.equal((await f.w1.snapshot()).ships.peer0.nativeName,'Glider-Peer0');
  const proof={observer:'peer0',actor:'peer0',eventId:alice.eventId,kind:'owner',nativeName:alice.nativeName,runId:'native-100-1',runNonce:'test-run',created:true,simMjd:clock.simMjd0,verifiedPort:true};
  await f.w0.nativeProof(proof);await f.p0.pump();await f.s0.reconcile('pending');await f.s1.reconcile('pending');
  assert.equal((await f.w1.snapshot()).ships.peer0.phase,'ACTIVE');
  f.network.mine();await f.s0.reconcile('confirm-proof');await f.s1.reconcile('confirm-proof');
  const sample={type:'PHYSICS_SAMPLE',source:'native',entityName:alice.nativeName,runId:proof.runId,sequence:1,simMjd:clock.simMjd0,frameId:'metaverse-moon-relative-v26',mode:'FREEFLIGHT',surface:[0,0,0,0],position:[13,14,15],velocity:[1,2,3],orientation:[0,0,0,1],capturedAtUnixMs:clock.utcOriginMs};
  await f.w0.publish({actor:'peer0',runId:proof.runId,sample});await f.p0.pump({intervalMs:1});
  f.s0.onZmq({topic:'game-pending-move json '+GAME,sequence:0,data:{}});
  await f.s0.reconcile('forced');await f.s1.reconcile('peer-network');
  const remote=(await f.w1.snapshot()).frames.peer0;
  assert.deepEqual(remote.sample.position,[13,14,15]);
  f.network.mine();await f.s0.reconcile('confirm-frame');await f.s1.reconcile('confirm-frame');
  assert.equal(f.s0.projection.confirmedRoot,f.s1.projection.confirmedRoot);
  assert.equal(f.g0.get('metaverse:rod:frontier').confirmedRoot,f.g1.get('metaverse:rod:frontier').confirmedRoot);
  assert.equal(f.s0.projection.confirmed.frontier['p/alice'].seq,3);
  assert.notEqual(worldRoot(await f.w0.snapshot()),f.s0.projection.confirmedRoot,'local UI root distinct from canonical graph frontier');
 }finally{await f.close()}
});
test("each peer's local native endpoint reuses ROD-confirmed roster rather than allocating peer0 twice",async()=>{
 const f=await fixture();try{
  await f.p0.pump();await f.p1.pump();f.network.mine();await f.s0.reconcile();await f.s1.reconcile();
  const hub=await createLocalNativeEndpoint({world:f.w1,rpc:f.r1,worldId:W,clock,port,host:'127.0.0.1',now:()=>clock.utcOriginMs,runNonce:'unit-native'});
  try{const base=hub.url,challenge=await(await fetch(`${base}/enroll-challenge?address=${ADDR2}`)).json(),message=enrollMessage({worldId:W,address:ADDR2,nonce:challenge.nonce,portId:challenge.portId,slot:challenge.slot});
   const result=await(await fetch(`${base}/enroll`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({address:ADDR2,challengeId:challenge.id,nonce:challenge.nonce,portId:challenge.portId,slot:challenge.slot,signature:Buffer.from(message).toString('base64')})})).json();
   assert.equal(result.ship.actor,'peer1');assert.equal(result.ship.recovered,true);assert.equal(result.ship.nativeName,'Glider-Peer1');
  }finally{await hub.close()}
 }finally{await f.close()}
});
test('mempool arrival order never changes confirmed OSG root, forged actors rejected',()=>{
 const a=buildMove({world:W,game:GAME,player:'p/alice',seq:1,previous:'0'.repeat(64),kind:'join',payload:{owner:ADDR1,asset:W,clockEra:1}});
 const b=buildMove({world:W,game:GAME,player:'p/bob',seq:1,previous:'0'.repeat(64),kind:'join',payload:{owner:ADDR2,asset:W,clockEra:1}});
 const row=(move,txid)=>({move,txid,player:move.player,address:move.payload.owner});
 const x=assembleProjection({world:W,game:GAME,confirmed:[row(a,'1'.repeat(64))],pending:[row(b,'2'.repeat(64))],port,clock});
 const y=assembleProjection({world:W,game:GAME,confirmed:[row(a,'1'.repeat(64))],pending:[],port,clock});
 assert.equal(x.confirmedRoot,y.confirmedRoot);assert.equal(x.order.length,1,'pending join stays provisional without allocating a different peer number');
});

test('a player-name transfer cannot assume control of an already admitted ship',()=>{
 const join=buildMove({world:W,game:GAME,player:'p/alice',seq:1,previous:'0'.repeat(64),kind:'join',payload:{owner:ADDR1,asset:W,clockEra:1}});
 const forged=buildMove({world:W,game:GAME,player:'p/alice',seq:2,previous:join.digest,kind:'leave',payload:{}});
 const confirmed=[{txid:'1'.repeat(64),player:'p/alice',address:ADDR1,move:join},{txid:'2'.repeat(64),player:'p/alice',address:ADDR2,move:forged}];
 const result=assembleProjection({world:W,game:GAME,confirmed,pending:[],port,clock});
 assert.equal(result.frontier['p/alice'].seq,1);
 assert.equal(result.actors['p/alice'].ship.owner,ADDR1);
 assert.deepEqual(result.rejected.map(r=>r.why),['player_name_transferred_requires_new_authorization']);
});
test('reorganization retracts a removed actor without blocking verified world replay',async()=>{
 const f=await fixture();try{
  await f.p0.pump();await f.p1.pump();f.network.mine();await f.s0.reconcile();await f.s1.reconcile();
  assert.equal(f.w0.authorityHealthy,true);
  f.network.reorg();await f.s0.reconcile('reorg');
  assert.equal(f.w0.authorityHealthy,false);assert.equal(f.s0.status().ready,true);
  assert.deepEqual(Object.keys((await f.w0.snapshot()).ships),[]);
  assert.ok(f.g0.get('metaverse:event:000000000001'),'historical evidence survives');
  await assert.rejects(f.w0.publish({actor:'peer0',runId:'native-any',sample:{}}),/ROD_NATIVE_AUTHORITY_SUSPENDED/);
 }finally{await f.close()}
});
test('a per-device endpoint cannot bind a network interface or serve as a central authority',async()=>{
 const f=await fixture();try{
  await assert.rejects(createLocalNativeEndpoint({world:f.w0,rpc:f.r0,worldId:W,clock,port,host:'0.0.0.0'}),/ENDPOINT_MUST_BE_LOCAL/);
  await assert.rejects(createLocalNativeEndpoint({world:f.w0,rpc:f.r0,worldId:W,clock,port}),/ROD_NATIVE_AUTHORITY_SUSPENDED/);
  await f.p0.pump();f.network.mine();await f.s0.reconcile('admitted');
  const endpoint=await createLocalNativeEndpoint({world:f.w0,rpc:f.r0,worldId:W,clock,port});
  try{assert.match(endpoint.url,/^http:\/\/127\.0\.0\.1:/)}finally{await endpoint.close()}
 }finally{await f.close()}
});
test('independent devices see the same ROD-committed native scene evidence',async()=>{
 const f=await fixture();try{
  await f.p0.pump();await f.p1.pump();f.network.mine();await f.s0.reconcile();await f.s1.reconcile();
  for(const [world,actor] of [[f.w0,'peer0'],[f.w1,'peer1']]){
   const player=actor==='peer0'?'p/alice':'p/bob',ship=f.s0.projection.actors[player].ship;
   await world.nativeProof({observer:actor,actor,eventId:ship.eventId,kind:'owner',nativeName:ship.nativeName,runId:'native-'+actor,runNonce:'native-scene',created:true,simMjd:clock.simMjd0,verifiedPort:true});
  }
  await f.p0.pump();await f.p1.pump();f.network.mine();await f.s0.reconcile();await f.s1.reconcile();
  const proof={observer:'peer0',target:'peer1',runId:'native-peer0',sceneSha256:'a'.repeat(64),cameraSha256:'b'.repeat(64),nativeNames:['Glider-Peer0','Glider-Peer1'],cameraTarget:'Glider-Peer1',simMjd:clock.simMjd0,runNonce:'native-scene'};
  await f.p0.capture({type:'NATIVE_SCENE_PROOF',payload:{proof}});await f.p0.pump();
  await f.s0.reconcile('scene-pending');await f.s1.reconcile('scene-pending');
  assert.equal(f.s0.projection.actors['p/alice'].sceneProof.cameraSha256,proof.cameraSha256);
  assert.equal(f.s1.projection.actors['p/alice'].sceneProof.cameraSha256,proof.cameraSha256);
  f.network.mine();await f.s0.reconcile('scene-block');await f.s1.reconcile('scene-block');
  assert.equal(f.s0.projection.confirmedRoot,f.s1.projection.confirmedRoot);
 }finally{await f.close()}
});
test('restart recovers a journaled, already-mined game move after the RPC response was lost',async()=>{
 const f=await fixture();try{
  await f.p0.pump();f.network.mine();await f.s0.reconcile('recovery-confirmation');
  const observed=f.s0.projection.accepted.find(x=>x.move.player==='p/alice');
  assert.ok(observed?.txid,'confirmed ROD move is visible in independent reconciliation');
  const outbox=join(f.dir,'alice.json'),saved=JSON.parse(await readFile(outbox,'utf8'));
  // Equivalent to a crash AFTER broadcasting but BEFORE learning the txid.
  saved.seq=0;saved.head='0'.repeat(64);saved.lastTxid=null;
  saved.pending={move:observed.move,txid:null,createdAt:Date.now()};
  await writeFile(outbox,JSON.stringify(saved));
  const restarted=await new RodGamePublisher({rpc:f.r0,world:W,game:GAME,player:'p/alice',ownerAddress:ADDR1,clockEra:1,source:f.s0,filename:outbox}).init();
  try{assert.equal(restarted.state.seq,1);assert.equal(restarted.state.head,observed.move.digest);
   assert.equal(restarted.state.pending,null);assert.equal(restarted.state.paused,false);
   assert.equal(restarted.state.lastTxid,null,'recovery does not invent an extra transaction');
  }finally{await restarted.close()}
 }finally{await f.close()}
});
test('a definite wallet refusal (locked wallet) is retried with backoff and never freezes publishing',async()=>{
 const f=await fixture();try{
  const real=f.p0.rpc,statuses=[];f.p0.onStatus=(code,detail)=>statuses.push(code);
  let refuse=true,updates=0;
  f.p0.rpc=async(method,args)=>{if(method==='name_update'){updates++;if(refuse)throw Object.assign(new Error('Error: Please enter the wallet passphrase'),{code:-13});}return real(method,args)};
  await assert.rejects(f.p0.pump(),/ROD_NAME_UPDATE_REFUSED_-13/);
  assert.equal(f.p0.state.paused,false,'a definite refusal must not pause publication');
  assert.equal(f.p0.state.pending,null,'the intent is discarded after name_pending shows nothing accepted');
  assert.equal(f.p0.state.failures,1);assert.ok(statuses.includes('ROD_PLAYER_SEND_REFUSED_WILL_RETRY'));
  assert.equal(await f.p0.pump(),null,'nothing is sent during the backoff window');assert.equal(updates,1,'no RPC during the backoff window');
  refuse=false;f.p0.state.retryAfter=Date.now()-1;
  await f.p0.pump();f.network.mine();await f.s0.reconcile('after-unlock');
  assert.ok(f.s0.projection.actors['p/alice'],'join is confirmed after the wallet is unlocked');
  assert.equal(f.p0.state.failures,0);assert.equal(f.p0.state.retryAfter,null);
 }finally{await f.close()}
});
test('ROD RPC outage revokes local native authorship until a verified recovery',async()=>{
 const f=await fixture();try{
  await f.p0.pump();f.network.mine();await f.s0.reconcile('joined');
  f.s0.onUnsafe=reason=>f.w0.suspendAuthority(reason);
  assert.equal(f.w0.authorityHealthy,true);
  const rpc=f.s0.rpc;
  f.s0.rpc=async(method,params)=>{if(method==='getblockchaininfo')throw Error('rod_rpc_unavailable');return rpc(method,params)};
  await assert.rejects(f.s0.reconcile('outage'),/rod_rpc_unavailable/);
  assert.equal(f.s0.status().ready,false);assert.equal(f.w0.authorityHealthy,false);
  await assert.rejects(f.w0.nativeProof({}),/ROD_NATIVE_AUTHORITY_SUSPENDED/);
  f.s0.rpc=rpc;await f.s0.reconcile('restored');
  assert.equal(f.s0.status().ready,true);assert.equal(f.w0.authorityHealthy,true);
 }finally{await f.close()}
});
test('required native ZMQ subscriber loss never silently degrades to RPC-only game authorship',async()=>{
 const f=await fixture();try{
  await f.p0.pump();f.network.mine();await f.s0.reconcile('joined');
  f.s0.onUnsafe=reason=>f.w0.suspendAuthority(reason);
  f.s0.requireZmq=true;f.s0.zmqReady=false;
  await assert.rejects(f.s0.reconcile('zmq-disconnected'),/ROD_PRIMARY_ZMQ_SUBSCRIBER_UNAVAILABLE/);
  assert.equal(f.s0.status().ready,false);assert.equal(f.w0.authorityHealthy,false);
  f.s0.zmqReady=true;await f.s0.reconcile('zmq-recovered');
  assert.equal(f.s0.status().ready,true);assert.equal(f.w0.authorityHealthy,true);
 }finally{await f.close()}
});
test('long-lived ROD worlds catch up in verified bounded batches instead of failing at a lifetime limit',async()=>{
 const f=await fixture();try{
  await f.p0.pump();for(let i=0;i<7;i++)f.network.mine();
  const g=graph(),progress=[];
  const long=new RodGameSync({rpc:f.r1,world:W,game:GAME,port,clock,assetRoot:ASSET,graph:g,startHeight:1,
   maxBlocks:2,onStatus:(kind,data)=>{if(kind==='ROD_HISTORY_CATCHUP')progress.push(data)}});
  try{await long.start({subscribe:false});assert.ok(progress.length>=3);
   assert.equal(long.projection.confirmedRoot,f.s0.projection?.confirmedRoot===null?null:assembleProjection({world:W,game:GAME,
    confirmed:f.network.chain.flatMap(b=>b.tx.flatMap(tx=>parseRodTx(tx,{world:W,game:GAME}))),port,clock}).confirmedRoot);
   assert.equal(long.blocks.length,f.network.height);assert.equal(g.get('metaverse:rod:frontier').height,f.network.height);
   assert.equal(progress.at(-1).targetHeight,f.network.height);
  }finally{await long.close()}
 }finally{await f.close()}
});

test('three independent ROD participants share six canonical pads; leave frees a pad and never reuses an actor identity',()=>{
 const fullPort={...port,slots:Array.from({length:6},(_,i)=>({slot:`pad-${i+1}`,nativePadIndex:i,rotDegrees:90}))};
 const players=['p/alice','p/bob','p/charlie','p/dave'],owners=[ADDR1,ADDR2,'rHW1bckYhNtwNFXKfzP6FK4U4jxZgZPpko','rEVtNySEJEuCoBxiMhTtr5SsGCXwbeRyVB'];
 const rows=[],heads=new Map();
 const add=(player,owner,kind,payload)=>{
  const prev=heads.get(player),move=buildMove({world:W,game:GAME,player,kind,payload,seq:(prev?.seq??0)+1,previous:prev?.digest??'0'.repeat(64)});
  heads.set(player,{seq:move.seq,digest:move.digest});rows.push({txid:hash(JSON.stringify(move)),player,address:owner,move});
 };
 for(let i=0;i<3;i++)add(players[i],owners[i],'join',{owner:owners[i],asset:W,clockEra:1});
 let state=assembleProjection({world:W,game:GAME,confirmed:rows,port:fullPort,clock});
 assert.equal(state.order.length,3);assert.equal(state.rejected.length,0);
 assert.deepEqual(state.order.map(p=>state.actors[p].ship.actor),['peer0','peer1','peer2']);
 add(players[1],owners[1],'leave',{});
 add(players[3],owners[3],'join',{owner:owners[3],asset:W,clockEra:1});
 state=assembleProjection({world:W,game:GAME,confirmed:rows,port:fullPort,clock});
 assert.equal(state.rejected.length,0);assert.equal(state.actors['p/bob'].retired,true);
 assert.equal(state.actors['p/dave'].ship.actor,'peer3');
 assert.equal(state.actors['p/dave'].ship.slot,'pad-2');
 add(players[1],owners[1],'rejoin',{owner:owners[1],asset:W,clockEra:1});
 const a=assembleProjection({world:W,game:GAME,confirmed:rows,port:fullPort,clock});
 const b=assembleProjection({world:W,game:GAME,confirmed:structuredClone(rows),port:structuredClone(fullPort),clock:structuredClone(clock)});
 assert.equal(a.rejected.length,0);assert.equal(a.confirmedRoot,b.confirmedRoot);
 assert.equal(a.actors['p/bob'].ship.actor,'peer4');
 assert.equal(a.actors['p/bob'].ship.slot,'pad-4');
 assert.equal(new Set(a.order.map(p=>a.actors[p].ship.slot)).size,a.order.length);
 assert.equal(a.retired[0].actor,'peer1');
});

test('busy unrelated mempool cannot disable ROD/ZMQ graph synchronization',async()=>{
 const f=await fixture();try{
  await f.p0.pump();f.network.mine();await f.s0.reconcile('joined');
  const root=f.s0.projection.confirmedRoot;
  for(let i=0;i<1504;i++){
   const txid=hash('unrelated-'+i),tx={txid,vin:[],vout:[]};f.network.pool.push(tx);f.network.txMap.set(txid,tx);
  }
  await f.s0.reconcile('busy-mempool');
  assert.equal(f.s0.status().ready,true);assert.equal(f.s0.projection.confirmedRoot,root);
  assert.equal(f.s0.pending.length,0);
 }finally{await f.close()}
});

test('ROD verified history is persisted as hashed OSG segments and reused across restart',async()=>{
 const f=await fixture();try{
  await f.p0.pump();for(let i=0;i<6;i++)f.network.mine();
  const g=graph(),rpc=f.network.rpc(ADDR1);let fullBlocks=0;
  const checked=async(method,args)=>{if(method==='getblock')fullBlocks++;return rpc(method,args)};
  const opts={rpc:checked,world:W,game:GAME,port,clock,assetRoot:ASSET,graph:g,startHeight:1,maxBlocks:3};
  const first=new RodGameSync(opts);await first.start({subscribe:false});
  const initial=fullBlocks,root=first.projection.confirmedRoot;
  assert.ok(initial>=6);assert.equal(g.get('metaverse:rod:replay_cursor').lastHeight,f.network.height);
  await first.close();
  const second=new RodGameSync(opts);await second.start({subscribe:false});
  assert.equal(fullBlocks,initial,'replay cache avoids repeat full-block fetches');
  assert.equal(second.projection.confirmedRoot,root);await second.close();
  const segment=g.get('metaverse:rod:replay_1');g.values.set('metaverse:rod:replay_1',{...segment,digest:'f'.repeat(64)});
  const third=new RodGameSync(opts);await assert.rejects(third.start({subscribe:false}),/REPLAY_SEGMENT_CORRUPT/);
  await third.close();
 }finally{await f.close()}
});

test('orphaned local owner proof revokes physics and can be reattested with a real new native acknowledgment',async()=>{
 const f=await fixture();try{
  await f.p0.pump();f.network.mine();await f.s0.reconcile('join');
  const ship=f.s0.projection.actors['p/alice'].ship;
  const proof={observer:'peer0',actor:'peer0',eventId:ship.eventId,kind:'owner',nativeName:ship.nativeName,
   runId:'native-old',runNonce:'origin-run',created:true,simMjd:clock.simMjd0,verifiedPort:true};
  await f.w0.nativeProof(proof);await f.p0.pump();f.network.mine();await f.s0.reconcile('owner-proof');
  assert.equal(f.s0.projection.actors['p/alice'].ownerProof.runId,'native-old');
  f.network.reorg();await f.s0.reconcile('owner-orphaned');
  assert.equal(f.w0.authorityHealthy,false);
  await assert.rejects(f.w0.publish({actor:'peer0',runId:'native-old',sample:{}}),/ROD_NATIVE_AUTHORITY_SUSPENDED/);
  await assert.rejects(f.w0.nativeProof({...proof,eventId:'f'.repeat(64)}),/ROD_NATIVE_AUTHORITY_SUSPENDED/);
  await f.p0.rebaseAfterReorg();
  const newProof={...proof,runId:'native-new',runNonce:'reattest-run'};
  await f.w0.nativeProof(newProof);
  await f.p0.pump();f.network.mine();await f.s0.reconcile('owner-reconfirmed');
  assert.equal(f.s0.projection.actors['p/alice'].ownerProof.runId,'native-new');
  assert.equal(f.w0.authorityHealthy,true);
 }finally{await f.close()}
});

test('confirmed departure followed by automatic publisher rejoin assigns a new actor',async()=>{
 const f=await fixture();try{
  await f.p0.pump();f.network.mine();await f.s0.reconcile('joined');
  assert.equal(f.s0.projection.actors['p/alice'].ship.actor,'peer0');
  await f.p0.send({kind:'leave',payload:{}});f.network.mine();await f.s0.reconcile('departed');
  assert.ok(!f.s0.projection.order.includes('p/alice'));
  const sent=await f.p0.pump();assert.equal(sent.move.kind,'rejoin');
  f.network.mine();await f.s0.reconcile('rejoined');
  assert.equal(f.s0.projection.actors['p/alice'].ship.actor,'peer1');
  assert.equal(f.s0.projection.actors['p/alice'].retired,false);
  assert.equal(f.s0.projection.confirmed.retired[0].actor,'peer0');
 }finally{await f.close()}
});
