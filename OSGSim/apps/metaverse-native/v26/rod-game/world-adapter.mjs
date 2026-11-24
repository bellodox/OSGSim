// SPDX-License-Identifier: MIT
// Derived materialized view over verified ROD game partitions; native v26 is unchanged.
import {V26World} from '../world.mjs';
import {canonical} from '../ownership.mjs';
import {canonicalSpawn} from '../spawn-ports.mjs';
const ACTOR=/^peer(?:0|[1-9]\d{0,4})$/, ADDR=/^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{25,64}$/, DIGEST=/^[a-f0-9]{64}$/;
export class DistributedV26World extends V26World {
 // Local native APIs remain available only while this device has reconciled
 // its own ROD node. No remote machine can authorize our spacecraft.
 authorityHealthy=false;
 authorityError='ROD_WORLD_NOT_SYNCHRONIZED';
 assertAuthority(){if(!this.authorityHealthy)throw Error('ROD_NATIVE_AUTHORITY_SUSPENDED_'+this.authorityError);}
 // Any failed ROD scan, persistent-store write, or lost native ZMQ subscriber
 // revokes this device's permission to author physics until the next verified
 // reconciliation. Existing Metaverse physics remains recorded and unchanged.
 suspendAuthority(reason='ROD_SYNC_UNAVAILABLE'){
  this.authorityHealthy=false;
  this.authorityError=String(reason).slice(0,180);
 }
 // Live (Nostr) overlay: never part of the OSG state or root.
 liveSource=null;
 setLiveSource(fn){this.liveSource=typeof fn==='function'?fn:null;}
 liveFramesView(){try{return this.liveSource?.()??{};}catch{return {};}}
 async nativeProof(proof){
  if(this.authorityHealthy)return super.nativeProof(proof);
  // A ROD reorg may orphan an owner-proof without removing its confirmed
  // player reservation. Permit ONLY a new actual SDK owner acknowledgment
  // for that unchanged actor/event; keep physics publication suspended until
  // the refreshed proof is accepted back into canonical ROD game state.
  const own=this.confirmedLocalActor;
  if(!own||proof?.kind!=='owner'||proof?.created!==true||proof?.verifiedPort!==true||
     proof.actor!==own.actor||proof.observer!==own.actor||proof.eventId!==own.eventId||
     proof.nativeName!==own.nativeName)throw Error('ROD_NATIVE_AUTHORITY_SUSPENDED_'+this.authorityError);
  return super.nativeProof(proof);
 }
 async sceneProof(proof){this.assertAuthority();return super.sceneProof(proof);}
 // Own samples arrive at ~4 Hz. Each OSG commit adds an event and a full state row and is replicated in the
 // Nostr history, so OSG keeps at most one own frame per ownCommitMs (plus every LANDED/FREEFLIGHT change).
 // The samples in between pass the same validation and feed the live lane and the ROD frame selection only.
 ownCommitMs=1000;lastOwnCommitAt=0;lastLive=null;onLiveFrame=null;
 async publish(input){this.assertAuthority();
  const nowUtcMs=input?.nowUtcMs??this.now();
  const decision=await this.queue(async()=>{
   const checked=this.validateSample({...input,nowUtcMs});
   if(checked.idempotent)return{commit:true};
   const s=input.sample,phase=this.state.ships[input.actor].phase;
   if(this.lastLive?.runId===s.runId&&s.sequence<=this.lastLive.sequence)throw Error('stale_native_physics');
   this.lastLive={runId:s.runId,sequence:s.sequence};
   const modeChange=(s.mode==='FREEFLIGHT'&&['ACTIVE','LANDED'].includes(phase))||(s.mode==='LANDED'&&phase==='DEPARTED');
   if(modeChange||nowUtcMs-this.lastOwnCommitAt>=this.ownCommitMs){this.lastOwnCommitAt=nowUtcMs;return{commit:true};}
   return{commit:false,frame:checked.frame};
  });
  if(decision.commit)return super.publish({...input,nowUtcMs});
  if(this.onLiveFrame){try{await this.onLiveFrame(structuredClone(decision.frame));}catch(e){console.error('SPEXGSP_LIVE_FRAME_HANDLER_FAILED '+e.message);}}
  return{frame:decision.frame,committed:false};
 }
 // Native enrollment cannot invent a participant outside the confirmed ROD
 // game roster, even if a local caller can produce a valid wallet signature.
 async enroll({address,portId,slot=null}={}){this.assertAuthority();return this.queue(()=>{
  if(!this.confirmedOwners?.has(address))throw Error('ROD_CONFIRMED_PLAYER_JOIN_REQUIRED');
  const ship=Object.values(this.state.ships).find(s=>s.owner===address);
  if(!ship||ship.portId!==portId||(slot&&ship.slot!==slot))throw Error('ROD_CONFIRMED_SPAWN_SLOT_REQUIRED');
  return {...structuredClone(ship),recovered:true};
 });}
 // ROD-first mode: the local native hub materializes graph-verified participant
 // partitions without becoming a global authority. A device may author only
 // its own vessel; all remote state arrives from canonical ROD game moves.
 // A local raw native proof may precede its ROD mempool transaction. Such a
 // proof stays in the flight recorder but never authorizes a revoked actor.
 async importRodProjection(projection,{localPlayer=null}={}){
  try{
   const result=await this.queue(async()=>{
    if(projection?.world!==this.worldId||!projection.actors||!Array.isArray(projection.order)||
       !projection.confirmed?.actors||!Array.isArray(projection.confirmed.order))throw Error('ROD_PROJECTION_FOREIGN_WORLD');
    const active=projection.order.map(p=>projection.actors[p]);
    if(active.some(a=>!a?.ship||a.retired))throw Error('ROD_PROJECTION_ACTIVE_ROSTER_INVALID');
    const previous=this.graph.get?.('metaverse:rod:participants')?.actors??{};
    this.confirmedOwners=new Set(projection.confirmed.order
     .filter(player=>!projection.confirmed.actors[player]?.retired)
     .map(player=>projection.confirmed.actors[player]?.ship?.owner).filter(Boolean));
    const confirmedOwn=projection.confirmed.order.includes(localPlayer)?projection.confirmed.actors[localPlayer]:null;
    const localEntry=projection.actors[localPlayer];
    const previouslyVerified=previous[localPlayer]?.ownerProof??null;
    const localOwnerWasVerified=Boolean(previouslyVerified||this.lastVerifiedLocalProof);
    const currentOwnerProof=localEntry?.ownerProof??null;
    const revoked=localOwnerWasVerified&&!currentOwnerProof;
    const next=structuredClone(this.state);let changed=false;
    // Reorganization and leave are *state* changes, not corruption. Remove
    // active visibility; immutable OSG commit/event history remains available.
    const removals=[];
    for(const actor of Object.keys(next.ships)){
     const incoming=active.find(a=>a.ship.actor===actor)?.ship;
     const prior=next.ships[actor];
     if(!incoming||prior.owner!==incoming.owner||prior.eventId!==incoming.eventId||prior.slot!==incoming.slot){
      removals.push({actor,eventId:prior.eventId,reason:!incoming?'roster_removed':'actor_reassigned'});
      delete next.ships[actor];delete next.frames[actor];
      for(const key of Object.keys(next.proofs))if(key.startsWith(actor+':')||key.endsWith(':'+actor))delete next.proofs[key];
      changed=true;
     }
    }
    const ownActor=confirmedOwn?.ship?.actor??null;
    for(const player of projection.order){
     const entry=projection.actors[player],ship=entry.ship,actor=ship.actor;
     if(ship.worldId!==this.worldId||!ACTOR.test(actor)||!DIGEST.test(ship.eventId)||!ADDR.test(ship.owner))throw Error('ROD_PARTITION_INVALID');
     canonicalSpawn(ship,this.port);
     const local=actor===ownActor;
     const current=next.ships[actor];
     // Preserve only local physical coordinates that have not yet been
     // committed to the mempool. Identity, slot and ownership are always ROD.
     const materialized=current&&local?{...ship,phase:current.phase,...(current.reservedUntilUtcMs?{reservedUntilUtcMs:current.reservedUntilUtcMs}:{})}:{...ship};
     if(canonical(current)!==canonical(materialized)){next.ships[actor]=materialized;changed=true;}
     const key=actor+':'+actor;
     const stored=next.proofs[key];
     if(entry.ownerProof){
      if(!local||!stored||stored.eventId!==entry.ownerProof.eventId){
       if(canonical(stored)!==canonical(entry.ownerProof)){next.proofs[key]=structuredClone(entry.ownerProof);changed=true;}
      }
     }else if(stored&&(!local||revoked)){
      delete next.proofs[key];changed=true;
     }
     if(entry.frame){
      if(!local&&canonical(next.frames[actor])!==canonical(entry.frame)){
       next.frames[actor]=structuredClone(entry.frame);changed=true;
      }
     }else if(next.frames[actor]&&!local){delete next.frames[actor];changed=true;}
    }
    // The previous owner's proof cannot authorize a new participant or actor
    // after a fork. Its original evidence survives in immutable OSG events.
    if(revoked&&ownActor){delete next.proofs[ownActor+':'+ownActor];changed=true;}
    next.nextActorId=Math.max(next.nextActorId,
      ...Object.values(projection.actors).map(a=>a?.ship?.actor).filter(Boolean)
       .map(actor=>Number(actor.slice(4))+1),0);
    if(changed){next.sequence++;await this.commit(next,'ROD_PARTITION_RECONCILED',
     {root:projection.liveRoot,confirmedRoot:projection.confirmedRoot,actors:projection.order.length,removals,revoked});}
    return{snapshot:this.snapshotUnsafe(),revoked,confirmedOwn,localEntry,currentOwnerProof,removals};
   });
   if(result.currentOwnerProof)this.lastVerifiedLocalProof=structuredClone(result.currentOwnerProof);
   this.authorityHealthy=Boolean(result.confirmedOwn)&&!result.revoked&&
     result.confirmedOwn.ship.owner===result.localEntry?.ship.owner;
   this.authorityError=this.authorityHealthy?null:result.revoked?'ROD_LOCAL_OWNER_PROOF_REVOKED':'ROD_CONFIRMED_LOCAL_PLAYER_REQUIRED';
   this.confirmedLocalActor=result.confirmedOwn?.ship??null;
   this.reconciliation=result.removals;
   return result.snapshot;
  }catch(error){this.authorityHealthy=false;this.authorityError=error.message;throw error;}
 }
}
