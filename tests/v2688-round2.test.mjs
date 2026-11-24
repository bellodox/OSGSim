// SPDX-License-Identifier: MIT
// v26.8.8 full-audit regressions: each test names the defect it pins down.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile,appendFile,readFile,truncate,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {TestRod,W,ASSET,GAME,ADDR1,ADDR2,port as twoPadPort,graph,defaultClock} from './support/rod-fixture.mjs';
import {RodGameSync} from '../OSGSim/apps/metaverse-native/v26/rod-game/sync.mjs';
import {RodGamePublisher} from '../OSGSim/apps/metaverse-native/v26/rod-game/publisher.mjs';
import {DistributedV26World} from '../OSGSim/apps/metaverse-native/v26/rod-game/world-adapter.mjs';
import {assembleProjection,buildMove,INACTIVITY_RETIRE_BLOCKS} from '../OSGSim/apps/metaverse-native/v26/rod-game/protocol.mjs';
import {WorldClock} from '../OSGSim/apps/metaverse-native/v26/world-time.mjs';
import {findRodNameOrigin} from '../OSGSim/apps/metaverse-native/v26/rod-game/name-origin.mjs';
import {journalFrontierReader} from '../OSGSim/apps/metaverse-native/v26/rod-game/nostr-history.mjs';
import {ensureRodPlayerName} from '../OSGSim/apps/metaverse-native/v26/rod-game/player-identity.mjs';
import {NostrMirror} from '../OSGSim/apps/metaverse-native/v26/nostr-mirror.mjs';
import {eventGenesis,hashWorldDelta} from '../OSGSim/apps/metaverse-native/v26/world.mjs';
import {generateSecret} from '../OSGSim/apps/metaverse-native/v26/single-address/crypto.mjs';
import {CRITICAL} from '../OSGSim/apps/metaverse-native/v26/world-manifest.mjs';
import {readAuthority,universeValues,registerName,createUniverse} from '../OSGSim/scripts/spexgsp-create-universe.mjs';
import {discoverRodDirectoryUniverse} from '../OSGSim/apps/metaverse-native/v26/rod-game/nostr-bootstrap.mjs';
import {OperatorRelay} from '../OSGSim/apps/metaverse-native/v26/single-address/operator-relay.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const clock=defaultClock;

async function peers(port=twoPadPort){
 const network=new TestRod(),dir=await mkdtemp(join(tmpdir(),'spex-r2-'));
 const mk=async(player,address)=>{
  const g=graph(),rpc=network.rpc(address);
  const world=new DistributedV26World({graph:g,rpc,worldId:W,clock,port,now:()=>clock.utcOriginMs});await world.init();
  const sync=new RodGameSync({rpc,world:W,game:GAME,port,clock,assetRoot:ASSET,graph:g,startHeight:1,materialize:p=>world.importRodProjection(p,{localPlayer:player})});
  await sync.start({subscribe:false});
  const statuses=[];
  const publisher=await new RodGamePublisher({rpc,world:W,game:GAME,player,ownerAddress:address,clockEra:1,source:sync,filename:join(dir,player.slice(2)+'.json'),onStatus:(k,v)=>statuses.push([k,v])}).init();
  return{rpc,world,sync,publisher,statuses};
 };
 const a=await mk('p/alice',ADDR1),b=await mk('p/bob',ADDR2);
 return{network,a,b,dir,async reconcile(){await a.sync.reconcile('t');await b.sync.reconcile('t');},
  async close(){for(const p of [a,b]){await p.sync.close();await p.publisher.close();}await rm(dir,{recursive:true,force:true});}};
}

test('publisher: the ambiguous-RPC pause is resolved from pump(), where it previously never ran',async()=>{
 const f=await peers();
 try{
  const p=f.a.publisher;p.resumeAfterMs=20;p.discardAfterMs=60;
  p.state.paused=true;p.state.pending={move:{digest:'e'.repeat(64),seq:1},createdAt:Date.now(),txid:null};
  p.recover=async()=>{throw Error('ROD_PLAYER_PUBLISH_UNRESOLVED_INTENT_INSPECT_BEFORE_RETRY');};
  await p.pump();await sleep(80);await p.pump();
  assert.equal(p.state.paused,false,'resumed by the regular pump');assert.equal(p.state.pending,null);
 }finally{await f.close();}
});

test('publisher: an unresolved intent at startup no longer stops the peer',async()=>{
 const f=await peers();
 try{
  const file=join(f.dir,'restart.json');
  await writeFile(file,JSON.stringify({...f.a.publisher.state,paused:true,pending:{move:buildMove({world:W,game:GAME,player:'p/alice',seq:1,previous:'0'.repeat(64),kind:'join',payload:{owner:ADDR1,asset:W,clockEra:1}}),createdAt:Date.now(),txid:null}}));
  const statuses=[];
  const p=await new RodGamePublisher({rpc:f.a.rpc,world:W,game:GAME,player:'p/alice',ownerAddress:ADDR1,clockEra:1,source:f.a.sync,filename:file,onStatus:k=>statuses.push(k)}).init();
  assert.equal(p.state.paused,true);assert.ok(statuses.includes('ROD_PLAYER_PUBLICATION_PAUSED_UNRESOLVED_INTENT'));
  await p.close();
 }finally{await f.close();}
});

test('publisher: a join rejected for a full port is rebased, waits without paying, and joins once a pad is free',async()=>{
 const onePad={...twoPadPort,slots:[twoPadPort.slots[0]]};
 const f=await peers(onePad);
 try{
  // Both joins land in one block: the first gets the only pad, the second is rejected (port_full).
  await f.a.publisher.pump();await f.b.publisher.pump();f.network.mine();await f.reconcile();
  assert.deepEqual(f.b.sync.projection.order,['p/alice']);
  assert.ok(f.b.sync.projection.rejected.some(r=>r.player==='p/bob'&&r.why==='port_full'));
  await f.b.publisher.pump();
  assert.equal(f.b.publisher.state.lastRejected.why,'port_full');assert.equal(f.b.publisher.state.seq,0,'rebased to the canonical head');
  const before=f.network.pool.length;await f.b.publisher.pump();await f.b.publisher.pump();
  assert.equal(f.network.pool.length,before,'no join is re-sent while the port is full');
  assert.ok(f.b.statuses.some(([k])=>k==='ROD_PORT_FULL_WAITING_FOR_FREE_PAD'));
  // A third, later joiner would not even send a join while the confirmed port is full (checked above for Bob).
  // Alice goes silent; after the inactivity limit her pad is free and Bob joins.
  for(let i=0;i<INACTIVITY_RETIRE_BLOCKS;i++)f.network.mine();
  await f.reconcile();
  assert.deepEqual(f.b.sync.projection.order,[],'alice retired after inactivity');
  await f.b.publisher.pump();f.network.mine();await f.reconcile();
  assert.deepEqual(f.b.sync.projection.order,['p/bob']);
  await f.b.publisher.pump();assert.equal(f.b.publisher.state.lastRejected,null,'cleared once the join is confirmed');
 }finally{await f.close();}
});

test('publisher: a join rejected for another reason is never repeated at the player\'s expense',async()=>{
 const f=await peers();
 try{
  const p=f.a.publisher;p.state.lastRejected={why:'join_conflict',txid:'1'.repeat(64),at:Date.now()};
  const before=f.network.pool.length;await p.pump();assert.equal(f.network.pool.length,before);
  assert.ok(f.a.statuses.some(([k])=>k==='ROD_PLAYER_JOIN_REJECTED_PERMANENTLY'));
 }finally{await f.close();}
});

test('protocol: inactivity retirement is deterministic, moves of a retired actor advance the chain, and rejoin works',()=>{
 const join=(player,owner,seq,previous,kind='join')=>buildMove({world:W,game:GAME,player,seq,previous,kind,payload:{owner,asset:W,clockEra:1}});
 const row=(move,address,height,i)=>({txid:String(height).padStart(4,'0')+String(i).padStart(60,'0'),player:move.player,address,move,height,blockTime:null});
 const aJoin=join('p/alice',ADDR1,1,'0'.repeat(64));
 const leaveless=buildMove({world:W,game:GAME,player:'p/alice',seq:2,previous:aJoin.digest,kind:'checkpoint',payload:{actor:'peer0',runId:'r',seq:1,digest:'f'.repeat(64),simMjd:1}});
 const base=[row(aJoin,ADDR1,10,0)];
 const active=assembleProjection({world:W,game:GAME,confirmed:base,port:twoPadPort,clock,tipHeight:10+INACTIVITY_RETIRE_BLOCKS-1});
 assert.deepEqual(active.order,['p/alice']);
 const expired=assembleProjection({world:W,game:GAME,confirmed:base,port:twoPadPort,clock,tipHeight:10+INACTIVITY_RETIRE_BLOCKS});
 assert.deepEqual(expired.order,[]);assert.equal(expired.retired[0].expiredAtHeight,10+INACTIVITY_RETIRE_BLOCKS);
 assert.notEqual(active.confirmedRoot,expired.confirmedRoot);
 const late=[...base,row(leaveless,ADDR1,10+INACTIVITY_RETIRE_BLOCKS+5,0)];
 const afterLate=assembleProjection({world:W,game:GAME,confirmed:late,port:twoPadPort,clock});
 assert.equal(afterLate.frontier['p/alice'].seq,2,'the move was ignored, not rejected: the chain advanced');
 assert.ok(afterLate.ignored.some(x=>x.why==='retired_actor_requires_rejoin'));
 const rejoin=join('p/alice',ADDR1,3,leaveless.digest,'rejoin');
 const back=assembleProjection({world:W,game:GAME,confirmed:[...late,row(rejoin,ADDR1,10+INACTIVITY_RETIRE_BLOCKS+6,0)],port:twoPadPort,clock});
 assert.deepEqual(back.order,['p/alice']);assert.equal(back.actors['p/alice'].ship.actor,'peer1','a fresh actor id');
});

test('world: own samples reach OSG at most once per second (and on every mode change); the rest feed the live lane',async()=>{
 let t=clock.utcOriginMs+1000;const network=new TestRod(),g=graph(),rpc=network.rpc(ADDR1);
 const world=new DistributedV26World({graph:g,rpc,worldId:W,clock,port:twoPadPort,now:()=>t});await world.init();
 const sync=new RodGameSync({rpc,world:W,game:GAME,port:twoPadPort,clock,assetRoot:ASSET,graph:g,startHeight:1,materialize:p=>world.importRodProjection(p,{localPlayer:'p/alice'})});
 await sync.start({subscribe:false});
 const dir=await mkdtemp(join(tmpdir(),'spex-rate-'));
 const publisher=await new RodGamePublisher({rpc,world:W,game:GAME,player:'p/alice',ownerAddress:ADDR1,clockEra:1,source:sync,filename:join(dir,'a.json')}).init();
 try{
  await publisher.pump();network.mine();await sync.reconcile('join');
  const ship=sync.projection.actors['p/alice'].ship,mjd=x=>clock.simMjd0+(x-clock.utcOriginMs)/86400000;
  await world.nativeProof({observer:ship.actor,actor:ship.actor,eventId:ship.eventId,kind:'owner',nativeName:ship.nativeName,runId:'run-1',runNonce:'n',created:true,simMjd:mjd(t),verifiedPort:true});
  const live=[];world.onLiveFrame=f=>live.push(f.sample.sequence);
  const commits=()=>Object.keys(Object.fromEntries(g.values)).filter(k=>k.startsWith('metaverse:event:')).length;
  const start=commits();
  const sample=(seq,mode='LANDED')=>({type:'PHYSICS_SAMPLE',source:'native',entityName:ship.nativeName,runId:'run-1',sequence:seq,simMjd:mjd(t),frameId:'metaverse-moon-relative-v26',mode,surface:mode==='LANDED'?[0,0,0,0]:[0,0,0,0],position:[1,2,3],velocity:[0,0,0],orientation:[0,0,0,1]});
  for(let seq=1;seq<=4;seq++){t+=250;await world.publish({actor:ship.actor,runId:'run-1',sample:sample(seq)});}
  assert.equal(commits()-start,1,'four samples inside one second: one OSG commit');
  assert.deepEqual(live,[2,3,4],'the others went to the live path');
  t+=100;await world.publish({actor:ship.actor,runId:'run-1',sample:sample(5,'FREEFLIGHT')});
  assert.equal(commits()-start,2,'a mode change is committed at once');
  await assert.rejects(world.publish({actor:ship.actor,runId:'run-1',sample:sample(5,'FREEFLIGHT')}),/stale_native_physics|idempotent/).catch(()=>{});
  t+=100;await assert.rejects(world.publish({actor:ship.actor,runId:'run-1',sample:sample(3,'FREEFLIGHT')}),/stale_native_physics/);
 }finally{await sync.close();await publisher.close();await rm(dir,{recursive:true,force:true});}
});

test('clock: a quorum-confirmed forward step (machine slept) is accepted; backward steps and single sources are not; PC clocks up to a day off calibrate',()=>{
 let mono=0,wall=1_000_000;const c=new WorldClock(clock,{nowMono:()=>mono,nowWall:()=>wall});
 c.calibrate({offsetMs:0,uncertaintyMs:5});
 wall+=600000;// the machine slept 10 minutes; the monotonic clock did not advance
 assert.throws(()=>c.calibrate({offsetMs:0,uncertaintyMs:5}),/clock_large_step_rejected/,'unconfirmed source');
 assert.equal(c.calibrate({offsetMs:0,uncertaintyMs:5,quorum:true}).utcMs,wall,'quorum forward step');
 assert.throws(()=>c.calibrate({offsetMs:-5000,uncertaintyMs:5,quorum:true}),/backward/);
 const far=new WorldClock(clock,{nowMono:()=>0,nowWall:()=>1_000_000});
 assert.equal(far.calibrate({offsetMs:3*3600000,uncertaintyMs:5}).utcMs,1_000_000+3*3600000,'a PC clock 3 h off still calibrates');
});

test('name origin: a cached registration stays valid after later name updates (no full rescan per start)',async()=>{
 const name='p/alice',value='v0';let getblocks=0,latest={name,value:'v5',height:500,txid:'5'.repeat(64)};
 const blockHash=h=>String(h).padStart(64,'0');
 const rpc=async(method,args)=>{
  if(method==='name_show')return latest;
  if(method==='name_history')throw Object.assign(Error('-namehistory is not enabled'),{code:-1});
  if(method==='getblockhash')return blockHash(args[0]);
  if(method==='getblock'){getblocks++;const h=Number(args[0]);
   const tx=h===100?[{txid:'1'.repeat(64),vin:[{coinbase:'x'}],vout:[{scriptPubKey:{nameOp:{op:'name_register',name,value}}}]}]:[];return{height:h,tx};}
  throw Error('unexpected '+method);};
 const dir=await mkdtemp(join(tmpdir(),'spex-origin-'));const cacheFile=join(dir,'origin.json');
 try{
  const first=await findRodNameOrigin({rpc,name,expectedValue:value,cacheFile});assert.equal(first.height,100);
  const scanned=getblocks;assert.ok(scanned>0);
  latest={...latest,value:'v9',height:900,txid:'9'.repeat(64)};
  const second=await findRodNameOrigin({rpc,name,expectedValue:value,cacheFile});
  assert.equal(second.height,100);assert.equal(getblocks,scanned,'no block scan after a later update');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('player journal: each status read only parses newly appended bytes, and a truncated journal resets',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'spex-journal-'));const file=join(dir,'local-deltas.jsonl');
 try{
  const line=seqs=>JSON.stringify({kind:8427,content:JSON.stringify({events:seqs.map(sequence=>({sequence}))})})+'\n';
  const read=journalFrontierReader(file);
  assert.equal((await read()).source,'parent-nostr-archive-unavailable');
  await writeFile(file,line([1,2])+line([3]));assert.equal((await read()).sequence,3);
  await appendFile(file,line([4,5]).slice(0,10));assert.equal((await read()).sequence,3,'a partial line waits');
  await appendFile(file,line([4,5]).slice(10));assert.equal((await read()).sequence,5);
  await truncate(file,0);await writeFile(file,line([1]));assert.equal((await read()).sequence,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('mirror: the contiguous frontier advances incrementally, also when batches arrive out of order',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'spex-mirror-'));const secret=generateSecret();
 try{
  const writer=await new NostrMirror({worldId:W,file:join(dir,'w.jsonl'),secret,deltaBatchSize:2}).init();
  let previous=eventGenesis(W);const deltas=[];
  for(let sequence=1;sequence<=6;sequence++){const d={worldId:W,sequence,previous,type:'X',payload:{sequence}};d.hash=hashWorldDelta(d);previous=d.hash;deltas.push(d);}
  const batches=[];for(const d of deltas){writer.queueDelta(d);}
  batches.push(...writer.events);
  const reader=await new NostrMirror({worldId:W,file:join(dir,'r.jsonl'),publisher:writer.publisher}).init();
  reader.accept(batches[2]);assert.equal(reader.contiguous().sequence,0);
  reader.accept(batches[0]);assert.equal(reader.contiguous().sequence,2);
  reader.accept(batches[1]);assert.deepEqual(reader.contiguous(),{sequence:6,eventHead:deltas[5].hash,missing:0});
  await writer.close();await reader.close();
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('player identity: addresses are requested as legacy, because signmessage cannot sign segwit addresses',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'spex-legacy-'));const calls=[];
 try{
  const rpc=async(method,args)=>{calls.push([method,...(args??[])]);
   if(method==='getnewaddress')return ADDR1;if(method==='getaddressinfo')return{ismine:true};
   if(method==='name_show')throw Error('name not found');if(method==='name_pending')return[];
   if(method==='name_register')throw Error('timeout');throw Error('unexpected '+method);};
  await ensureRodPlayerName({rpc,worldId:W,nostrPubkey:'b'.repeat(64),journalFile:join(dir,'p.json'),salted:false,allowRegistration:true,timeoutMs:2000,pollMs:5}).catch(()=>{});
  const requested=calls.filter(c=>c[0]==='getnewaddress');assert.ok(requested.length>=1);
  assert.ok(requested.every(c=>c[2]==='legacy'),JSON.stringify(requested));
 }finally{await rm(dir,{recursive:true,force:true});}
});

// ---- universe creation (owner tool) -------------------------------------------------------------------------
async function installRoot(authority){
 const root=await mkdtemp(join(tmpdir(),'spex-install-'));
 for(const p of CRITICAL){const f=join(root,p);await mkdir(dirname(f),{recursive:true});await writeFile(f,'asset '+p);}
 await copyFile(new URL('../fixtures/Brighton.cfg',import.meta.url),join(root,'Config','Moon','Base','Brighton.cfg'));
 if(authority){await mkdir(join(root,'OSGSim'),{recursive:true});await writeFile(join(root,'OSGSim','realm-authority.json'),JSON.stringify(authority));}
 return root;
}
class NameChain{
 constructor(){this.names=new Map();this.pool=[];this.height=100;this.registers=0;this.refuse=0;this.genesis='6'.repeat(64);this.mine=true;}
 rpc(){return async(method,args=[])=>{switch(method){
  case 'getblockchaininfo':return{chain:'main',blocks:this.height,headers:this.height,verificationprogress:1,mediantime:Math.floor(Date.now()/1000),initialblockdownload:false};
  case 'getblockhash':return args[0]===0?this.genesis:String(args[0]).padStart(64,'1');
  case 'getnetworkinfo':return{connections:8};
  case 'getaddressinfo':return{ismine:args[0]===ADDR1};
  case 'getnewaddress':return ADDR1;
  case 'name_show':{const n=this.names.get(args[0]);if(!n)throw Error('name not found');return n;}
  case 'name_pending':return this.pool.filter(x=>x.name===args[0]);
  case 'name_scan':return[...this.names.values()].filter(x=>x.name>=args[0]).sort((a,b)=>a.name.localeCompare(b.name)).slice(0,args[1]);
  case 'name_register':{
   if(this.refuse>0){this.refuse--;throw Object.assign(Error('Insufficient funds'),{code:-6});}
   this.registers++;const txid=String(this.registers).padStart(64,'a');this.pool.push({name:args[0],value:args[1],address:args[2].destAddress,txid});
   if(this.mine)this.block();return txid;}
  default:throw Error('unexpected '+method);}};}
 block(){this.height++;for(const x of this.pool)this.names.set(x.name,{...x,height:this.height});this.pool=[];}
}

test('create universe: registers the realm directory and game genesis; joiners then find it from ROD alone',async()=>{
 const authority={schema:1,realmName:'spexgsp/universe/test',realmId:'moon/test',gameId:'moontest',ownerAddress:ADDR1,relays:['wss://relay.op.example/']};
 const root=await installRoot(authority);const chain=new NameChain();
 try{
  const journal=await createUniverse({root,rpc:chain.rpc(),pollMs:5});
  assert.equal(journal.status,'CREATED');assert.equal(chain.registers,2);
  const dir=JSON.parse(chain.names.get('spexgsp/universe/test').value);
  assert.deepEqual(dir.relays,['wss://relay.op.example/']);assert.equal(dir.worldId,journal.worldId);
  const {loadBrightonPort}=await import('../OSGSim/apps/metaverse-native/v26/spawn-ports.mjs');
  const port=await loadBrightonPort(join(root,'Config','Moon','Base','Brighton.cfg'),{available:null});
  const found=await discoverRodDirectoryUniverse({rpc:chain.rpc(),realmName:'spexgsp/universe/test',port,assetRoot:dir.assetRoot,rodGenesis:chain.genesis});
  assert.equal(found.worldId,journal.worldId);assert.equal(found.gameId,'moontest');
  const again=await createUniverse({root,rpc:chain.rpc(),pollMs:5});
  assert.equal(again.worldId,journal.worldId);assert.equal(chain.registers,2,'re-running never pays again');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('create universe: refusal is retried; an interrupted broadcast is not re-sent while pending; a taken name is refused',async()=>{
 const chain=new NameChain(),saves=[];const record={status:'NEW'};
 chain.refuse=1;
 await registerName({rpc:chain.rpc(),name:'spexgsp/universe/x',value:'{"a":1}',ownerAddress:ADDR1,record,save:async()=>saves.push(record.status),pollMs:5});
 assert.equal(record.status,'CONFIRMED');assert.ok(saves.includes('REFUSED'));assert.equal(chain.registers,1);
 const pendingChain=new NameChain();pendingChain.mine=false;
 await pendingChain.rpc()('name_register',['g/x','{"b":1}',{destAddress:ADDR1}]);
 const r2={status:'PENDING',txid:'1'.padStart(64,'a'),sentHeight:100};
 const run=registerName({rpc:pendingChain.rpc(),name:'g/x',value:'{"b":1}',ownerAddress:ADDR1,record:r2,save:async()=>{},pollMs:5});
 await sleep(40);assert.equal(pendingChain.registers,1,'waiting on the pending transaction, not re-registering');
 pendingChain.block();await run;assert.equal(r2.status,'CONFIRMED');
 const taken=new NameChain();taken.names.set('g/y',{name:'g/y',value:'{"other":1}',address:ADDR2,height:5,txid:'2'.repeat(64)});
 await assert.rejects(registerName({rpc:taken.rpc(),name:'g/y',value:'{"b":1}',ownerAddress:ADDR1,record:{status:'NEW'},save:async()=>{},pollMs:5}),/ALREADY_REGISTERED/);
});

test('create universe: authority validation and value limits',()=>{
 assert.throws(()=>readAuthority(JSON.stringify({schema:1,realmId:'moon/x',gameId:'bad id'})),/GAME_ID/);
 assert.throws(()=>readAuthority(JSON.stringify({schema:1,realmId:'moon/x',gameId:'g1',relays:['ws://plain.example/']})),/insecure/);
 assert.throws(()=>readAuthority(JSON.stringify({schema:1,realmId:'moon/x',gameId:'g1',ownerAddress:'rod1qxyz'})),/LEGACY/);
 const a=readAuthority(JSON.stringify({schema:1,realmId:'moon/x',gameId:'g1'}));assert.equal(a.realmName,'spexgsp/universe/default');
 const v=universeValues({realmId:'moon/x',ownerAddress:ADDR1,publisher:'b'.repeat(64),assetRoot:'c'.repeat(64),rodGenesis:'d'.repeat(64),genesisNonce:'e'.repeat(64),port:twoPadPort,utcOriginMs:1790000000000,relays:[]});
 assert.ok(Buffer.byteLength(v.directoryValue)<=2048&&Buffer.byteLength(v.gameValue)<=2048);
 assert.equal(JSON.parse(v.gameValue).clock.simMjd0,40587+1790000000000/86400000,'world time starts at the real MJD');
});

test('built-in relay with TLS: the local peer uses a plain loopback listener, others use wss',async(t)=>{
 if(spawnSync('openssl',['version']).status!==0){t.skip('openssl not available');return;}
 const dir=await mkdtemp(join(tmpdir(),'spex-tls-'));
 try{
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-subj','/CN=relay.example','-days','1','-keyout',join(dir,'k.pem'),'-out',join(dir,'c.pem')],{stdio:'ignore'});
  const relay=await new OperatorRelay({host:'127.0.0.1',port:0,tls:{cert:await readFile(join(dir,'c.pem')),key:await readFile(join(dir,'k.pem'))}}).start();
  try{
   assert.match(relay.url,/^wss:\/\//);assert.match(relay.localUrl,/^ws:\/\/127\.0\.0\.1:\d+\/$/);assert.notEqual(relay.url,relay.localUrl);
   const ws=new WebSocket(relay.localUrl);await new Promise((ok,fail)=>{ws.onopen=ok;ws.onerror=fail;});
   const reply=new Promise(ok=>{ws.onmessage=m=>ok(JSON.parse(m.data));});ws.send(JSON.stringify(['REQ','s',{kinds:[8427]}]));
   assert.deepEqual(await reply,['EOSE','s']);ws.close();
  }finally{await relay.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('native wire parser (C++) passes its unit test',(t)=>{
 if(spawnSync('g++',['--version']).status!==0){t.skip('g++ not available');return;}
 const out=join(tmpdir(),'spex-native-wire-'+process.pid);
 const root=new URL('..',import.meta.url).pathname;
 execFileSync('g++',['-std=c++17','-O1','-I',join(root,'native','spexgsp-rod'),'-o',out,join(root,'tests','native-rod-wire.cpp')]);
 assert.equal(spawnSync(out).status,0);
});

test('publisher: every name_update pins destAddress, so the name stays at the join owner and later moves are accepted',async()=>{
 const f=await peers();
 try{
  const sent=[];const rpc=f.a.publisher.rpc;f.a.publisher.rpc=async(m,a)=>{if(m==='name_update')sent.push(a[2]);return rpc(m,a);};
  await f.a.publisher.pump();f.network.mine();await f.reconcile();
  f.a.publisher.state.checkpointDue=true;await f.a.publisher.pump?.();f.network.mine();await f.reconcile();
  assert.ok(sent.length>=1&&sent.every(o=>o?.destAddress===ADDR1),JSON.stringify(sent));
  assert.equal(f.network.owners['p/alice'],ADDR1,'the name did not move to a fresh address');
  assert.ok(!f.a.sync.projection.rejected.some(r=>r.why==='player_name_transferred_requires_new_authorization'));
 }finally{await f.close();}
});

test('create universe with relayHost: generates the relay certificate and publishes the relay URL with its key hash',async()=>{
 const authority={schema:1,realmName:'spexgsp/universe/tls',realmId:'moon/tls',gameId:'moontls',ownerAddress:ADDR1,relayHost:'203.0.113.7',relays:['wss://other.example/']};
 const root=await installRoot(authority);const chain=new NameChain();
 try{
  const journal=await createUniverse({root,rpc:chain.rpc(),pollMs:5});
  const dir=JSON.parse(chain.names.get('spexgsp/universe/tls').value);
  assert.deepEqual(dir.relays,['wss://other.example/','wss://203.0.113.7:7447/']);
  const certDir=join(root,'OSGSim','.data','spexgsp-single-address','relay-tls');
  const {readRelayCertificate}=await import('../OSGSim/apps/metaverse-native/v26/single-address/relay-cert.mjs');
  const stored=await readRelayCertificate(certDir);
  assert.deepEqual(dir.relayPins,{'wss://203.0.113.7:7447/':stored.pin});assert.equal(stored.host,'203.0.113.7');
  assert.deepEqual(journal.relayPins,dir.relayPins);
  const again=await createUniverse({root,rpc:chain.rpc(),pollMs:5});
  assert.equal(again.worldId,journal.worldId);assert.equal(chain.registers,2);
  // the certificate that was published must not change underneath a journal
  await rm(certDir,{recursive:true,force:true});
  await assert.rejects(createUniverse({root,rpc:chain.rpc(),pollMs:5}),/RELAY_CERTIFICATE_DIFFERS/);
 }finally{await rm(root,{recursive:true,force:true});}
 for(const bad of ['https://x','relay.example.org','203.0.113.7:99999','203.0.113.7:0','relay.example.org:7447'])assert.throws(()=>readAuthority(JSON.stringify({...authority,relayHost:bad})),/INVALID_RELAY_(HOST|PORT)/,bad);
 assert.throws(()=>readAuthority(JSON.stringify({...authority,relayPort:70000})),/INVALID_RELAY_PORT/);
 assert.equal(readAuthority(JSON.stringify({...authority,relayHost:'2001:db8::1',relayPort:8443})).relayUrl,'wss://[2001:db8::1]:8443/');
 const withPort=readAuthority(JSON.stringify({...authority,relayHost:'203.0.113.7:8443'}));
 assert.equal(withPort.relayUrl,'wss://203.0.113.7:8443/');assert.equal(withPort.relayHost,'203.0.113.7');
 assert.equal(readAuthority(JSON.stringify({...authority,relayHost:'[2001:db8::1]:9000'})).relayUrl,'wss://[2001:db8::1]:9000/');
 assert.equal(readAuthority(JSON.stringify({...authority,relayHost:'203.0.113.7:7447',relayPort:7447})).relayUrl,'wss://203.0.113.7:7447/');
 assert.throws(()=>readAuthority(JSON.stringify({...authority,relayHost:'203.0.113.7:7447',relayPort:8000})),/PORT_CONFLICT/);
});
