// SPDX-License-Identifier: MIT
// ROD P2P mempool is the event carrier; local native ZMQ is the wake-up signal.
// Never trust the notification payload as authoritative: independently read RPC.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {parseRodTx,assembleProjection,gameGenesis,verifyGameGenesis} from './protocol.mjs';
import {sha} from '../ownership.mjs';
import {findRodNameOrigin} from './name-origin.mjs';
import {selectRodZmqEndpoints} from './zmq-preflight.mjs';
const H=/^[a-f0-9]{64}$/;
const path=fileURLToPath(new URL('./native-zmq.py',import.meta.url));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
export class RodGameSync{
 constructor({rpc,world,game,port,clock,assetRoot,graph,materialize=null,startHeight=null,zmqAddress,python='python',pollMs=20000,maxBlocks=10000,maxMempool=1500,onStatus=()=>{},onUnsafe=()=>{}}={}){
  if(typeof rpc!=='function'||!H.test(world??'')||!/^[A-Za-z0-9]{1,40}$/.test(game??'')||!port?.portId||!clock||!H.test(assetRoot??'')||!graph?.putMany||!Number.isSafeInteger(maxBlocks)||maxBlocks<1||maxBlocks>100000)throw Error('ROD_SYNC_CONFIGURATION_INVALID');
  Object.assign(this,{rpc,world,game,port,clock,assetRoot,graph,materialize,startHeight,zmqAddress,python,pollMs,maxBlocks,maxMempool,onStatus,onUnsafe});
  this.blocks=[];this.pending=[];this.txCache=new Map();this.projection=null;this.timer=null;this.child=null;this.inFlight=null;this.dirty=false;this.closed=false;this.zmqReady=false;this.zmqLast=0;this.zmqEvidence=0;this.zmqSequences=new Map();this.lastError=null;this.inconsistent=false;this.requireZmq=false;this.txIndex=new Map();this.cacheRestored=false;
 }
 async start({subscribe=true}={}){
  if(this.closed)throw Error('ROD_SYNC_CLOSED');
  this.requireZmq=subscribe;
  const chain=await this.rpc('getblockchaininfo');this.chain=chain.chain;this.genesis=await this.rpc('getblockhash',[0]);
  const gameName=await this.rpc('name_show',[`g/${this.game}`]);
  if(!Number.isSafeInteger(gameName?.height)||gameName.height<1||gameName.height>chain.blocks)throw Error('ROD_GAME_REGISTRATION_NOT_CONFIRMED');
  verifyGameGenesis(gameName.value,gameGenesis({world:this.world,assetRoot:this.assetRoot,port:this.port,clock:this.clock,rodGenesis:this.genesis}));
  // The last g/ update may be later than the real registration. Onchain
  // ancestry works even if the node did not enable the optional history index.
  if(this.startHeight===null){
   const registration=await findRodNameOrigin({rpc:this.rpc,name:`g/${this.game}`,
    current:gameName,expectedValue:gameName.value,onStatus:this.onStatus});
   this.startHeight=registration.height;
  }
  if(!Number.isSafeInteger(this.startHeight)||this.startHeight<1||this.startHeight>gameName.height||this.startHeight>chain.blocks)throw Error('ROD_GAME_START_HEIGHT_INVALID');
  if(subscribe){
   // A universe is selected at runtime through Nostr. The ROD Core game API
   // supports dynamic subscription: no daemon restart or static -trackgame.
   const games=await this.rpc('trackedgames',[]);
   if(!Array.isArray(games))throw Error('ROD_NATIVE_GAME_TRACKING_UNAVAILABLE');
   if(!games.includes(this.game))await this.rpc('trackedgames',['add',this.game]);
   const verified=await this.rpc('trackedgames',[]);
   if(!Array.isArray(verified)||!verified.includes(this.game))throw Error('ROD_NATIVE_GAME_TRACKING_FAILED');
   const endpoints=selectRodZmqEndpoints(await this.rpc('getzmqnotifications',[]),{requested:this.zmqAddress??null});
   this.zmqAddress=endpoints.join(',');
   await this.startZmq();
  }
  await this.restoreReplayCache();
  await this.reconcile('startup');
  this.timer=setInterval(()=>void this.reconcile('poll').catch(e=>this.error(e)),this.pollMs);this.timer.unref?.();
  return this;
 }
 error(e){
  this.lastError=e?.message??String(e);
  this.inconsistent=true;
  try{this.onUnsafe(this.lastError)}catch{} // A broken diagnostic must not mask the RPC failure.
  this.onStatus('ROD_SYNC_ERROR',{reason:this.lastError});
 }
 async startZmq(){
  if(typeof this.zmqAddress!=='string'||this.zmqAddress.split(',').some(x=>!/^tcp:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{2,5}$/.test(x)))throw Error('ROD_ZMQ_LOCAL_ENDPOINT_REQUIRED');
  const child=this.child=spawn(this.python,[path,this.zmqAddress,this.game],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  // Events of a replaced subscriber (killed after a failed start, or exited late) must not touch the current one.
  const current=()=>this.child===child;
  child.stderr.on('data',b=>{if(current())this.onStatus('ROD_ZMQ_STDERR',{message:String(b).slice(0,300)});});
  child.on('error',e=>{if(!current())return;this.zmqSpawnError=e;this.zmqReady=false;if(!this.closed)this.error(Error('ROD_ZMQ_SUBSCRIBER_SPAWN_FAILED_'+e.message));});
  child.on('exit',(code,signal)=>{if(!current())return;this.zmqReady=false;if(!this.closed){this.error(Error('ROD_ZMQ_SUBSCRIBER_STOPPED_'+code+'_'+signal));this.scheduleZmqRestart();}});
  const reader=createInterface({input:child.stdout,crlfDelay:Infinity});
  reader.on('line',line=>{if(!current())return;try{const obj=JSON.parse(line);
   if(obj.ready===true){this.zmqReady=true;this.onStatus('ROD_ZMQ_READY',{game:this.game,address:this.zmqAddress});return}
   this.onZmq(obj);
  }catch(e){this.error(e)}});
  const deadline=Date.now()+8000;
  while(!this.zmqReady&&!this.zmqSpawnError&&child.exitCode===null&&Date.now()<deadline)await pause(30);
  if(!this.zmqReady){child.kill();throw Error(this.zmqSpawnError?'ROD_NATIVE_ZMQ_SPAWN_FAILED_'+this.zmqSpawnError.message:'ROD_NATIVE_ZMQ_NOT_READY');}
 }
 /** The RPC poll keeps the projection correct, but without the subscriber every mempool move waits for the poll.
  * Restart with backoff and re-add the tracked game (a node restart forgets runtime tracking). */
 scheduleZmqRestart(){
  if(this.closed||!this.requireZmq||this.zmqRestartTimer)return;
  const attempt=this.zmqRestarts=(this.zmqRestarts??0)+1,delay=Math.min(30000,1000*2**Math.min(5,attempt-1));
  this.zmqRestartTimer=setTimeout(async()=>{
   this.zmqRestartTimer=null;if(this.closed)return;
   try{
    const games=await this.rpc('trackedgames',[]);
    if(Array.isArray(games)&&!games.includes(this.game))await this.rpc('trackedgames',['add',this.game]);
    this.zmqSpawnError=null;await this.startZmq();this.zmqRestarts=0;
    this.onStatus('ROD_ZMQ_RESTARTED',{attempt});void this.reconcile('zmq-restart').catch(e=>this.error(e));
   }catch(e){this.onStatus('ROD_ZMQ_RESTART_FAILED',{attempt,reason:String(e.message).slice(0,200)});this.scheduleZmqRestart();}
  },delay);this.zmqRestartTimer.unref?.();
 }
 onZmq(evt){
  const command=evt?.topic;
  if(!['game-pending-move','game-block-attach','game-block-detach'].some(p=>command===p+' json '+this.game)||!Number.isInteger(evt.sequence))return;
  const previous=this.zmqSequences.get(command);if(previous!==undefined && evt.sequence!==((previous+1)>>>0))this.onStatus('ROD_ZMQ_GAP',{command,previous,received:evt.sequence});
  this.zmqSequences.set(command,evt.sequence);this.zmqEvidence++;this.zmqLast=Date.now();
  this.onStatus('ROD_NATIVE_ZMQ_NOTIFICATION',{command,sequence:evt.sequence});
  void this.reconcile('zmq').catch(e=>this.error(e));
 }
 async reconcile(trigger='manual'){
  if(this.closed)throw Error('ROD_SYNC_CLOSED');if(this.inFlight){this.dirty=true;return this.inFlight;}
  const slowStart=Date.now(),slowTimer=setInterval(()=>this.onStatus('ROD_SYNC_SLOW',{trigger,step:this.phase,seconds:Math.round((Date.now()-slowStart)/1000)}),30000);slowTimer.unref?.();
  const operation=(async()=>{let last;
   do{this.dirty=false;last=await this.scan(trigger);}while(this.dirty&&!this.closed);
   return last;
  })();this.inFlight=operation;
  try{return await operation}catch(e){this.error(e);throw e}finally{clearInterval(slowTimer);this.inFlight=null}
 }
 // Local OSG stores the verified ROD block rows, not merely a moving
 // snapshot. A restart replays this content without re-downloading the entire
 // game lifetime. The chain-tip check in scan still detects reorganizations.
 async restoreReplayCache(){
  if(this.cacheRestored)return;this.cacheRestored=true;
  const head=this.graph.get?.('metaverse:rod:replay_cursor');
  if(!head||head.schema!==2||head.world!==this.world||head.game!==this.game||
     head.startHeight!==this.startHeight||head.rodGenesis!==this.genesis||
     !Number.isSafeInteger(head.lastHeight)||head.lastHeight<this.startHeight)return;
  const restored=[];
  for(let from=this.startHeight;from<=head.lastHeight;from+=128){
   const segment=this.graph.get?.(`metaverse:rod:replay_${from}`);
   if(!segment||segment.schema!==2||segment.from!==from||!Array.isArray(segment.blocks)||
      segment.blocks.length<1||segment.blocks.length>128||segment.digest!==sha(segment.blocks))
    throw Error('ROD_OSG_REPLAY_SEGMENT_CORRUPT');
   for(const block of segment.blocks){
    if(block.height!==this.startHeight+restored.length||!H.test(block.hash??'')||!Array.isArray(block.rows))
     throw Error('ROD_OSG_REPLAY_BLOCK_CORRUPT');
    restored.push(block);
   }
  }
  if(restored.length!==head.lastHeight-this.startHeight+1||restored.at(-1).hash!==head.lastHash)
   throw Error('ROD_OSG_REPLAY_CURSOR_CORRUPT');
  this.blocks=restored;this.onStatus('ROD_OSG_HISTORY_RESTORED',{through:head.lastHeight,blocks:restored.length});
 }
 async persistReplayCache(blocks){
  if(!blocks.length)return;
  const changed=[];
  for(let i=0;i<blocks.length;i+=128){
   const from=this.startHeight+i,part=blocks.slice(i,i+128);
   const item={schema:2,from,blocks:part,digest:sha(part)};
   if(this.graph.get?.(`metaverse:rod:replay_${from}`)?.digest!==item.digest)
    changed.push({id:`metaverse:rod:replay_${from}`,value:item});
  }
  // The cursor advances LAST. If a power failure interrupts a multi-batch
  // write, a restart only loads the last completely published prefix.
  for(let i=0;i<changed.length;i+=256)await this.graph.putMany(changed.slice(i,i+256));
  const last=blocks.at(-1);
  const cursor={schema:2,world:this.world,game:this.game,rodGenesis:this.genesis,
   startHeight:this.startHeight,lastHeight:last.height,lastHash:last.hash};
  if(JSON.stringify(this.graph.get?.('metaverse:rod:replay_cursor'))!==JSON.stringify(cursor))
   await this.graph.putMany([{id:'metaverse:rod:replay_cursor',value:cursor}]);
 }
 async scan(trigger){
  this.phase='scan: reading the chain tip';const chain=await this.rpc('getblockchaininfo'),count=chain.blocks;
  if(count<this.startHeight)throw Error('ROD_SYNC_BEFORE_REGISTERED_GAME_GENESIS');
  const tip=await this.rpc('getblockhash',[count]);let keep=0;
  // A matching descendant block hash authenticates its whole ancestor chain.
  // Do not reread ten thousand historical block hashes at every ZMQ event.
  // If the last cached height changed, binary-search the fork point: O(log N).
  const cached=Math.min(this.blocks.length,Math.max(0,count-this.startHeight+1));
  if(cached>0){
   if(this.blocks[cached-1].hash===await this.rpc('getblockhash',[this.startHeight+cached-1]))keep=cached;
   else{let lo=0,hi=cached;
    while(lo<hi){const mid=Math.floor((lo+hi)/2),observed=await this.rpc('getblockhash',[this.startHeight+mid]);
     if(observed===this.blocks[mid].hash)lo=mid+1;else hi=mid;
    }keep=lo;
   }
  }
  const blocks=this.blocks.slice(0,keep);
  // A persistent universe cannot fail merely because it lived for more than
  // maxBlocks blocks. Limit each catch-up batch, then resume from the verified
  // block prefix. Do not expose a partial projection as a complete world.
  this.phase='scan: reading game blocks from height '+(this.startHeight+keep);
  const batchEnd=Math.min(count,this.startHeight+keep+this.maxBlocks-1);
  for(let h=this.startHeight+keep;h<=batchEnd;h++){
   const hash=await this.rpc('getblockhash',[h]);const b=await this.rpc('getblock',[hash,2]);
   if(!Array.isArray(b?.tx))throw Error('ROD_FULL_BLOCK_RPC_REQUIRED');
   blocks.push({height:h,hash,rows:b.tx.flatMap(tx=>parseRodTx(tx,{world:this.world,game:this.game})).map(row=>({...row,height:h,blockTime:Number.isSafeInteger(b.time)?b.time:null}))});
  }
  if(batchEnd<count){
   await this.persistReplayCache(blocks);this.blocks=blocks;this.dirty=true;
   this.onStatus('ROD_HISTORY_CATCHUP',{scannedThrough:batchEnd,targetHeight:count,batchSize:this.maxBlocks});
   return this.projection;
  }
  this.phase='scan: reading the mempool';const raw=await this.rpc('getrawmempool',[]);
  if(!Array.isArray(raw)||raw.some(txid=>!H.test(txid)))throw Error('ROD_SYNC_MEMPOOL_INVALID');
  const pool=[];
  // ZMQ wakeups and local ROD's mempool are the primary provisional path.
  // A busy node's unrelated transactions must never disable the game.
  // Use bounded batches for work, not an all-network hard limit.
  const confirmedTxs=new Set(blocks.flatMap(b=>b.rows.map(r=>r.txid)));
  const live=new Set(raw.filter(txid=>!confirmedTxs.has(txid)));
  for(const txid of this.txIndex.keys())if(!live.has(txid))this.txIndex.delete(txid);
  for(let offset=0;offset<raw.length;offset+=this.maxMempool){
   const window=raw.slice(offset,offset+this.maxMempool);
   const unknown=window.filter(txid=>live.has(txid)&&!this.txIndex.has(txid));
   for(let idx=0;idx<unknown.length;idx+=8){
    await Promise.all(unknown.slice(idx,idx+8).map(async txid=>{
     try{const tx=await this.rpc('getrawtransaction',[txid,true]);
      this.txIndex.set(txid,parseRodTx(tx,{world:this.world,game:this.game}));}
     catch(e){if(e.code!==-5&&e.code!==-8)throw e;
      // May have moved to a block during this scan. Tip re-check follows.
      this.txIndex.set(txid,[]);}
    }));
   }
   if(raw.length>this.maxMempool)this.onStatus('ROD_MEMPOOL_CATCHUP',
    {scanned:Math.min(offset+this.maxMempool,raw.length),total:raw.length});
  }
  for(const txid of raw)if(live.has(txid))pool.push(...(this.txIndex.get(txid)??[]));
  if(await this.rpc('getblockhash',[count])!==tip)throw Error('ROD_SYNC_TIP_CHANGED_DURING_SNAPSHOT');
  // Explicitly deterministic pending ordering. Confirmed chain order remains
  // the transaction order encoded in each canonical ROD block.
  pool.sort((a,b)=>a.player.localeCompare(b.player)||a.move.seq-b.move.seq||a.txid.localeCompare(b.txid));
  // Nothing new since the last verified projection (same tip, same pending moves): skip the O(history) rebuild.
  const snapshotKey=tip+'|'+pool.map(x=>x.txid+':'+x.move?.digest).join(',');
  if(this.projection&&!this.inconsistent&&this.snapshotKey===snapshotKey&&!(this.requireZmq&&!this.zmqReady))return this.projection;
  this.phase='scan: assembling the world projection';const projection=assembleProjection({world:this.world,game:this.game,confirmed:blocks.flatMap(b=>b.rows),pending:pool,port:this.port,clock:this.clock,tipHeight:count});
  this.chainHeight=count;
  const frontier={schema:1,world:this.world,game:this.game,rodGenesis:this.genesis,tip,height:count,confirmedRoot:projection.confirmedRoot,liveRoot:projection.liveRoot,frontier:projection.frontier,roster:projection.order,complete:projection.rejected.length===0,rejected:projection.rejected,zmqEvidence:this.zmqEvidence};
  if(this.requireZmq&&!this.zmqReady)throw Error('ROD_PRIMARY_ZMQ_SUBSCRIBER_UNAVAILABLE');
  // Persist verified canonical and provisional frontiers; never persist a
  // missing-asset/invalid projection as an accepted global root.
  // Materialize to a local OSG store; all simulator devices independently
  // derive this canonical content from ROD P2P. No remote coordinator exists.
  try{this.phase='scan: writing the world into the local OSG store (materialize)';if(this.materialize)await this.materialize(projection);this.phase='scan: saving the OSG frontier';
  const entries=[{id:'metaverse:rod:frontier',value:frontier},{id:'metaverse:rod:participants',value:{schema:1,actors:projection.actors,order:projection.order}}];
  const oldActors=new Set((this.projection?.order??[]).map(player=>this.projection.actors[player]?.ship?.actor));
  for(const player of projection.order){const actor=projection.actors[player].ship.actor;oldActors.delete(actor);entries.push({id:`metaverse:peer:${actor}`,value:{schema:1,world:this.world,player,confirmed:!!projection.confirmed.actors[player],state:projection.actors[player]}});}
  for(const actor of oldActors)if(actor)entries.push({id:`metaverse:peer:${actor}`,value:{schema:1,world:this.world,present:false,reason:'orphaned_or_revoked'}});
  await this.graph.putMany(entries);this.inconsistent=false;this.lastError=null;
  }catch(error){this.inconsistent=true;this.error(error);this.onStatus('ROD_WORLD_QUARANTINED',{reason:error.message,tip});throw error;}
  this.phase='scan: saving the replay cache';await this.persistReplayCache(blocks);this.phase=null;this.blocks=blocks;this.pending=pool;this.projection=projection;this.snapshotKey=snapshotKey;
  this.onStatus('ROD_RECONCILED',{trigger,height:count,canonicalRoot:projection.confirmedRoot,liveRoot:projection.liveRoot,actors:projection.order.length,pending:pool.length,rejected:projection.rejected.length,zmqEvidence:this.zmqEvidence});
  return projection;
 }
 status(){return{ready:!!this.projection&&!this.inconsistent&&(!this.requireZmq||this.zmqReady),zmqReady:this.zmqReady,zmqEvidence:this.zmqEvidence,zmqLast:this.zmqLast,canonicalRoot:this.projection?.confirmedRoot??null,liveRoot:this.projection?.liveRoot??null,actors:this.projection?.order??[],inconsistent:this.inconsistent,error:this.lastError}}
 async close(){this.closed=true;if(this.zmqRestartTimer){clearTimeout(this.zmqRestartTimer);this.zmqRestartTimer=null;}if(this.timer)clearInterval(this.timer);if(this.child){this.child.kill();this.child=null;}if(this.inFlight)await this.inFlight.catch(()=>{});}
}
