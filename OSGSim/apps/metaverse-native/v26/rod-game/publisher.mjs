// SPDX-License-Identifier: MIT
// Isolated player-name lane, never touching the realm/host-fence raw wallet lane.
// Wallet signs through native ROD name_update RPC. Intent is durable BEFORE RPC.
// destAddress is mandatory: without it ROD sends the name to a fresh wallet address
// (rpcnames.cpp DestinationAddressHelper::getScript), and protocol.mjs rejects every
// later move as a transfer.
import {readFile} from 'node:fs/promises';
import {atomicWriteFile} from '../fs-util.mjs';
import {buildMove,parseRodTx} from './protocol.mjs';
import {isDefiniteRpcRefusal,retryDelayMs} from './rpc-errors.mjs';
const Z='0'.repeat(64),H=/^[a-f0-9]{64}$/;
// Writes to one file run one after another, each with its own temporary name. Two overlapping writes
// shared one temporary file, and the second rename failed with ENOENT.
const chains=new Map();
const atomic=(file,data)=>{
 const run=(chains.get(file)??Promise.resolve()).then(()=>atomicWrite(file,data));
 const tail=run.catch(()=>{});chains.set(file,tail);tail.then(()=>{if(chains.get(file)===tail)chains.delete(file);});
 return run;
};
const atomicWrite=(file,data)=>atomicWriteFile(file,JSON.stringify(data,null,2)+'\n',{sync:true,syncDir:true});
export class RodGamePublisher{
 constructor({rpc,world,game,player,ownerAddress,clockEra,source,filename,limit=15,onStatus=()=>{},lane=null,nostrPubkey=null,checkpointMs=300000,laneHeartbeatMs=30000,resumeAfterMs=60000,discardAfterMs=180000}={}){
  if(!rpc||!world||!game||!/^p\/[a-zA-Z0-9_.-]{1,48}$/.test(player??'')||!filename||!ownerAddress||!Number.isSafeInteger(clockEra)||clockEra<1)throw Error('ROD_PUBLISHER_CONFIG_INVALID');
  Object.assign(this,{rpc,world,game,player,ownerAddress,clockEra,source,filename,limit,onStatus,lane,nostrPubkey,checkpointMs,laneHeartbeatMs,resumeAfterMs,discardAfterMs});this.state={schema:1,world,game,player,ownerAddress,head:Z,seq:0,pending:null,confirmedSeq:0,paused:false,lastFrameAt:0};this.queue=Promise.resolve();this.closed=false;this.lastStagedFramePersistAt=0;
 }
 async init(){try{const saved=JSON.parse(await readFile(this.filename,'utf8'));if(saved.schema!==1||saved.world!==this.world||saved.game!==this.game||saved.player!==this.player||saved.ownerAddress!==this.ownerAddress)throw Error('ROD_PUBLISHER_IDENTITY_CHANGED');this.state=saved;}catch(e){if(e.code!=='ENOENT')throw e;await atomic(this.filename,this.state)}
  const name=await this.rpc('name_show',[this.player]);if(name?.address!==this.ownerAddress)throw Error('ROD_PLAYER_NAME_NOT_OWNED_OR_NOT_REGISTERED');
  const info=await this.rpc('getaddressinfo',[this.ownerAddress]).catch(()=>this.rpc('validateaddress',[this.ownerAddress]));if(info.ismine!==true)throw Error('ROD_SIGNING_ADDRESS_NOT_OWNED');
  try{await this.recover();}
  catch(e){if(!/UNRESOLVED_INTENT/.test(e.message))throw e;
   // Do not stop the peer: tryResume() re-checks the intent and resumes or discards it.
   this.onStatus('ROD_PLAYER_PUBLICATION_PAUSED_UNRESOLVED_INTENT',{seq:this.state.pending?.move?.seq??null});}
  return this;
 }
 async recover(){const j=this.state.pending;if(!j)return;
  // A broadcast can be mined before the journal learns its txid (crash or
  // lost RPC response). The already-verified ROD projection includes both
  // canonical blocks and mempool moves, so recover by the durable move digest.
  // Never infer an accepted tx from an unverified local journal alone.
  const witnessed=this.source?.projection?.accepted?.find(row=>
   row.move?.player===this.player&&row.move?.digest===j.move?.digest&&
   (!j.txid||j.txid===row.txid));
  let found=Boolean(witnessed);
  if(found)j.txid=witnessed.txid;
  const mempool=found?[]:await this.rpc('getrawmempool',[]);
  for(const txid of found?[]:(j.txid?[j.txid]:mempool)){try{const tx=await this.rpc('getrawtransaction',[txid,true]);if(parseRodTx(tx,{world:this.world,game:this.game}).some(x=>x.move.digest===j.move.digest)){j.txid=txid;found=true;break}}catch{}}
  if(!found&&j.txid){try{const tx=await this.rpc('gettransaction',[j.txid]);if(tx?.confirmations>=1)found=true;}catch{}}
  if(!found){this.state.paused=true;await atomic(this.filename,this.state);throw Error('ROD_PLAYER_PUBLISH_UNRESOLVED_INTENT_INSPECT_BEFORE_RETRY');}
  this.state.head=j.move.digest;this.state.seq=j.move.seq;this.state.pending=null;await atomic(this.filename,this.state);
 }
 async rebaseAfterReorg(){
  if(this.state.pending||!this.source?.status?.().ready||!this.source?.projection)return false;
  // A confirmed move of ours that the projection rejected (e.g. port_full, join_conflict) never became part
  // of the game. The player's chain continues from the canonical head; the rejected value stays on the name.
  const rejectedWhy=new Map((this.source.projection.rejected??[]).filter(r=>r.player===this.player).map(r=>[r.txid,r.why]));
  const ownRejected=this.state.lastTxid?rejectedWhy.get(this.state.lastTxid)??null:null;
  const canonical=this.source.projection.frontier?.[this.player];
  const seq=canonical?.seq??0,head=canonical?.digest??Z;
  if(this.state.seq===seq&&this.state.head===head)return false;
  // A pending local name update can be valid even if no confirmed move yet.
  // Never replace it merely because different nodes see different mempools.
  const mempool=await this.rpc('getrawmempool',[]);
  if(!Array.isArray(mempool)||mempool.some(x=>!H.test(x)))throw Error('ROD_REBASE_MEMPOOL_INVALID');
  if(this.state.lastTxid&&mempool.includes(this.state.lastTxid))return false;
  if(this.state.lastTxid){
   try{const record=await this.rpc('gettransaction',[this.state.lastTxid]);
    if(record?.confirmations>=1&&!ownRejected)throw Error('ROD_REBASE_CONFIRMED_TX_NOT_IN_CANONICAL_PROJECTION');
   }catch(e){if(e.message==='ROD_REBASE_CONFIRMED_TX_NOT_IN_CANONICAL_PROJECTION')throw e;}
  }
  const owner=await this.rpc('name_show',[this.player]);
  if(owner?.address!==this.ownerAddress)throw Error('ROD_REBASE_PLAYER_NAME_NOT_OWNED');
  const pending=await this.rpc('name_pending',[this.player]);
  if(!Array.isArray(pending))throw Error('ROD_REBASE_PENDING_NAME_UNAVAILABLE');
  if(pending.length)return false;
  let current;try{current=JSON.parse(owner.value)}catch{throw Error('ROD_REBASE_CURRENT_NAME_VALUE_INVALID')}
  const observed=current?.g?.[this.game];
  if(!ownRejected){
   if(seq){if(!observed||observed.digest!==head||observed.seq!==seq)
     throw Error('ROD_REBASE_CANONICAL_NAME_HEAD_MISMATCH');}
   else if(observed)throw Error('ROD_REBASE_ORPHANED_GAME_HISTORY_STILL_ON_NAME');
  }else if(observed?.digest!==this.state.head)throw Error('ROD_REBASE_REJECTED_MOVE_NOT_ON_NAME');
  this.state={...this.state,seq,head,lastTxid:canonical?.txid??null,pending:null,
   ownerProof:null,sceneProof:null,latestFrame:null,lastPublishedFrame:null,lastFrameAt:0,paused:false,pausedAt:null,
   ...(ownRejected?{lastRejected:{why:ownRejected,txid:this.state.lastTxid,at:Date.now()}}:{})};
  await atomic(this.filename,this.state);
  this.onStatus(ownRejected?'ROD_PLAYER_MOVE_REJECTED_REBASED':'ROD_PLAYER_REBASED_FROM_CANONICAL_CHAIN',{seq,head,player:this.player,...(ownRejected?{why:ownRejected}:{})});
  return true;
 }
 send({kind,payload}){const op=this.queue.then(()=>this._send({kind,payload}));this.queue=op.catch(()=>{});return op;}
 /** Leave an ambiguous-outcome pause without operator action. After a cooldown the intent is looked up by
  * digest in the chain projection and node mempool. If it is found it is adopted; if it is still absent after
  * discardAfterMs (several blocks, long after the RPC could have completed) it never reached this node's
  * mempool, so the identical seq is safe to build again. */
 async tryResume(){
  if(!this.state.paused||this.closed)return;
  const now=Date.now();
  if(!Number.isSafeInteger(this.state.pausedAt)){this.state.pausedAt=now;await atomic(this.filename,this.state);return;}
  if(now-this.state.pausedAt<this.resumeAfterMs)return;
  if(this.state.pending){
   try{await this.recover();}catch(e){
    if(now-this.state.pausedAt<this.discardAfterMs)return;
    this.state.pending=null;this.onStatus('ROD_PLAYER_AMBIGUOUS_INTENT_DISCARDED_AFTER_VERIFICATION',{reason:String(e.message).slice(0,160)});
   }
  }else if(now-this.state.pausedAt<this.discardAfterMs)return;
  this.state.paused=false;this.state.pausedAt=null;await atomic(this.filename,this.state);
  this.onStatus('ROD_PLAYER_PUBLICATION_RESUMED',{seq:this.state.seq});
 }
 async _send({kind,payload}){
  if(this.state.paused)await this.tryResume();
  if(this.closed||this.state.paused)throw Error('ROD_PLAYER_PUBLICATION_PAUSED');
  if(Number.isSafeInteger(this.state.retryAfter)&&Date.now()<this.state.retryAfter)throw Error('ROD_PLAYER_PUBLICATION_BACKOFF');
  const current=this.source?.projection;
  const canonicalSeq=current?.confirmed?.frontier?.[this.player]?.seq??0;
  if(this.state.seq-canonicalSeq>=this.limit)throw Error('ROD_PLAYER_MEMPOOL_CHAIN_BUDGET_EXHAUSTED');
  // If previously published move disappeared from mempool without confirmation,
  // stop. Re-signing can create competing name chains or duplicate gameplay.
  if(this.state.seq>canonicalSeq&&this.state.pending===null&&this.state.lastTxid){
   const pool=await this.rpc('getrawmempool',[]);
   if(!pool.includes(this.state.lastTxid)){
    let confirmed=false;try{const tx=await this.rpc('gettransaction',[this.state.lastTxid]);confirmed=tx?.confirmations>=1;}catch{}
    if(!confirmed){this.state.paused=true;await atomic(this.filename,this.state);throw Error('ROD_PREVIOUS_PLAYER_TX_UNAVAILABLE');}
   }
  }
  const move=buildMove({world:this.world,game:this.game,player:this.player,seq:this.state.seq+1,previous:this.state.head,kind,payload});
  const value=JSON.stringify({g:{[this.game]:move}});
  this.state.pending={move,createdAt:Date.now(),txid:null};await atomic(this.filename,this.state);
  let txid;
  try{txid=await this.rpc('name_update',[this.player,value,{destAddress:this.ownerAddress}]);}
  catch(e){
   if(!isDefiniteRpcRefusal(e)){this.state.paused=true;await atomic(this.filename,this.state);throw Error('ROD_NAME_UPDATE_AMBIGUOUS_VERIFY_INTENT_'+e.message)}
   // The daemon explicitly refused the request (locked wallet, no funds,
   // rejected by mempool). Confirm through name_pending that nothing was
   // accepted, then discard the intent and retry later. If the check itself
   // fails the outcome is unknown and the safe pause applies.
   let pending;try{pending=await this.rpc('name_pending',[this.player]);}
   catch(check){this.state.paused=true;await atomic(this.filename,this.state);throw Error('ROD_NAME_UPDATE_AMBIGUOUS_VERIFY_INTENT_'+check.message)}
   if(!Array.isArray(pending)){this.state.paused=true;await atomic(this.filename,this.state);throw Error('ROD_NAME_UPDATE_AMBIGUOUS_VERIFY_INTENT_pending_unavailable')}
   const seen=pending.find(x=>typeof x?.value==='string'&&x.value.includes(move.digest));
   if(seen&&H.test(seen.txid??''))txid=seen.txid;
   else{
    const failures=(this.state.failures??0)+1,delay=retryDelayMs(failures);
    this.state.pending=null;this.state.failures=failures;this.state.retryAfter=Date.now()+delay;
    await atomic(this.filename,this.state);
    this.onStatus('ROD_PLAYER_SEND_REFUSED_WILL_RETRY',{code:e.code,reason:String(e.message).slice(0,200),retryInMs:delay});
    throw Error('ROD_NAME_UPDATE_REFUSED_'+e.code+'_'+e.message);
   }
  }
  if(!H.test(txid??'')){this.state.paused=true;await atomic(this.filename,this.state);throw Error('ROD_NAME_UPDATE_RETURNED_INVALID_TXID')}
  this.state.pending.txid=txid;await atomic(this.filename,this.state);
  this.state.head=move.digest;this.state.seq=move.seq;this.state.lastTxid=txid;this.state.pending=null;this.state.failures=0;this.state.retryAfter=null;await atomic(this.filename,this.state);
  this.onStatus('ROD_PLAYER_MOVE_SENT',{kind,seq:move.seq,txid,moveDigest:move.digest});return{move,txid};
 }
 // Never queue native physics at simulation-frame cadence. Retain only the
 // latest valid state; event timestamps and the full local OSG recorder remain.
 async capture(event){if(!event||!this.player)return;
  if(event.type==='PHYSICS_FRAME')return this.captureFrame(event.payload?.frame);
  if(event.type==='NATIVE_SPAWN_ACK'&&event.payload?.proof?.kind==='owner'&&event.payload.proof.created===true){
   this.state.ownerProof=event.payload.proof;await atomic(this.filename,this.state);
  }else if(event.type==='NATIVE_SCENE_PROOF'&&event.payload?.proof?.observer===this.source?.projection?.actors?.[this.player]?.ship?.actor){
   this.state.sceneProof=event.payload.proof;await atomic(this.filename,this.state);
  }
 }
 /** Own native frame, committed to OSG or not: keeps the latest for ROD and feeds the live lane. */
 async captureFrame(f){
  {if(f?.owner!==this.ownerAddress||!f.sample)return;
   const s=f.sample;
   const fields=['type','source','entityName','runId','sequence','simMjd','frameId','mode','surface','position','velocity','orientation','capturedAtUnixMs'];
   const sample=Object.fromEntries(fields.filter(k=>s[k]!==undefined).map(k=>[k,s[k]]));
   this.state.latestFrame={actor:f.actor,asset:f.asset,owner:f.owner,eventId:f.eventId,sample};
   // High-rate path: only after the run's owner proof is known to the ROD projection,
   // so receivers can bind this run to the confirmed roster. Never blocks the commit.
   const own=this.source?.projection?.actors?.[this.player];
   if(this.lane&&this.laneBound()&&own?.ownerProof?.runId===sample.runId&&own.ship.actor===f.actor)this.lane.publish({actor:f.actor,eventId:f.eventId,runId:sample.runId,sample});
   // Native updates can be high frequency. OSG already commits the complete
   // recorder; coalesce the wallet outbox's optional latest-frame cache.
   if(Date.now()-this.lastStagedFramePersistAt>700){await atomic(this.filename,this.state);this.lastStagedFramePersistAt=Date.now();}
  }
 }
 /** A join is only sent when it can be accepted: a confirmed pad must be free, and a join the game rejected
  * for any other reason (wrong clock era, conflicting history) is not repeated at the player's expense. */
 joinAllowed(projection){
  const why=this.state.lastRejected?.why;
  if(why&&why!=='port_full'){this.notify('ROD_PLAYER_JOIN_REJECTED_PERMANENTLY',{why,txid:this.state.lastRejected.txid});return false;}
  const slots=this.source?.port?.slots?.length??0,used=projection?.confirmed?.order?.length??0;
  if(slots&&used>=slots){this.notify('ROD_PORT_FULL_WAITING_FOR_FREE_PAD',{slots,used});return false;}
  return true;
 }
 notify(type,info,everyMs=60000){const last=this.notices?.get(type)??0;if(Date.now()-last<everyMs)return;(this.notices??=new Map()).set(type,Date.now());this.onStatus(type,info);}
 // The lane is useful to others only if the CONFIRMED roster binds our Nostr key to our actor.
 laneBound(){return Boolean(this.nostrPubkey)&&this.source?.projection?.confirmed?.actors?.[this.player]?.nostr===this.nostrPubkey;}
 async pump({intervalMs=1200,heartbeatMs=8500,positionErrorMetres=8,velocityErrorMs=1,angleErrorRadians=0.035}={}){
  if(this.state.paused)await this.tryResume();
  if(this.state.pending||!this.source?.projection)return null;
  if(Number.isSafeInteger(this.state.retryAfter)&&Date.now()<this.state.retryAfter)return null;
  await this.rebaseAfterReorg();
  if(this.state.paused)return null;
  const current=this.source.projection;
  const own=current.frontier?.[this.player];
  if(!own){if(this.state.seq>0)return null;
   if(!this.joinAllowed(current))return null;
   return this.send({kind:'join',payload:{owner:this.ownerAddress,asset:this.world,clockEra:this.clockEra,...(this.nostrPubkey?{nostr:this.nostrPubkey}:{})}})}
  if(this.state.lastRejected&&current.confirmed?.frontier?.[this.player]){this.state.lastRejected=null;await atomic(this.filename,this.state);}
  const playerState=current.actors?.[this.player],actor=playerState?.ship.actor;
  if(!actor)return null;
  if(playerState.retired){
   // An actor never returns from RETIRED.  Rejoin under the same ROD name
   // creates a fresh actor and acquires an available confirmed landing pad.
   if(this.state.seq!==own.seq||this.state.head!==own.digest)return null;
   if(!this.joinAllowed(current))return null;
   return this.send({kind:'rejoin',payload:{owner:this.ownerAddress,asset:this.world,clockEra:this.clockEra,...(this.nostrPubkey?{nostr:this.nostrPubkey}:{})}});
  }
  if(this.state.seq>own.seq)return null;
  if(!this.state.seq){this.state.seq=own.seq;this.state.head=own.digest;await atomic(this.filename,this.state)}
  if(this.state.ownerProof&&current.actors[this.player]?.ownerProof?.runId!==this.state.ownerProof.runId){
   const proof=this.state.ownerProof;
   if(proof.actor!==actor||proof.observer!==actor)return null;
   const sent=await this.send({kind:'owner-proof',payload:{proof}});
   this.state.ownerProof=null;await atomic(this.filename,this.state);return sent;
  }
  if(this.state.sceneProof&&current.actors[this.player]?.sceneProof?.sceneSha256!==this.state.sceneProof.sceneSha256){
   const proof=this.state.sceneProof;if(proof.observer!==actor)return null;
   const sent=await this.send({kind:'scene-proof',payload:{proof}});this.state.sceneProof=null;await atomic(this.filename,this.state);return sent;
  }
  if(this.state.latestFrame&&current.actors[this.player]?.ownerProof&&Date.now()-this.state.lastFrameAt>=intervalMs){
   const frame=this.state.latestFrame;
   if(frame.actor!==actor)return null;
   const old=this.state.lastPublishedFrame?.sample,next=frame.sample,gap=Date.now()-this.state.lastFrameAt;
   let skip=false;
   // While the live lane carries motion, ROD frames become a slow baseline
   // (late joiners, restart, and a fallback when relays are unreachable).
   const laneCarries=this.laneBound()&&this.lane?.healthy?.()===true&&this.lane.out.runId===next.runId&&this.lane.out.seq>0;
   if(old&&old.runId===next.runId&&old.mode===next.mode&&laneCarries&&gap<this.laneHeartbeatMs)skip=true;
   else if(old&&old.runId===next.runId&&gap<heartbeatMs){
    const dt=(next.simMjd-old.simMjd)*86400;
    const norm=arr=>Math.hypot(...arr);
    const positionError=norm(next.position.map((v,i)=>v-(old.position[i]+old.velocity[i]*dt)));
    const velocityError=norm(next.velocity.map((v,i)=>v-old.velocity[i]));
    const dot=Math.abs(next.orientation.reduce((s,v,i)=>s+v*old.orientation[i],0));
    const angle=2*Math.acos(Math.max(-1,Math.min(1,dot)));
    if(dt>=0&&positionError<positionErrorMetres&&velocityError<velocityErrorMs&&angle<angleErrorRadians&&next.mode===old.mode)skip=true;
   }
   if(!skip){
    const sent=await this.send({kind:'frame',payload:{frame}});
    this.state.latestFrame=null;this.state.lastPublishedFrame=frame;this.state.lastFrameAt=Date.now();await atomic(this.filename,this.state);return sent;
   }
  }
  // Commit to the head of the live-lane hash chain now and then. A later
  // disagreement between this digest and what peers saw proves equivocation.
  const cp=this.lane?.checkpointCandidate?.();
  if(cp&&cp.actor===actor&&current.actors[this.player]?.ownerProof?.runId===cp.runId&&
     Date.now()-(this.state.lastCheckpointAt??0)>=this.checkpointMs&&cp.seq>(this.state.lastCheckpoint?.runId===cp.runId?this.state.lastCheckpoint.seq:0)){
   const sent=await this.send({kind:'checkpoint',payload:cp});
   this.state.lastCheckpoint={runId:cp.runId,seq:cp.seq};this.state.lastCheckpointAt=Date.now();await atomic(this.filename,this.state);return sent;
  }
  return null;
 }
 async close(){this.closed=true;await this.queue.catch(()=>{});}
}
